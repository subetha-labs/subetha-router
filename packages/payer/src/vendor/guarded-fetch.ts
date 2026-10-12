/**
 * SSRF 防御 A の transport（`docs/ssrf-app-guard-design.md` §3.2〜§3.6）。
 *
 * 要求ごとに: URL を解析 → ホスト名を解決して**全アドレス**を分類（1 つでも禁止なら接続しない）→ 検査済み
 * アドレスだけを返す lookup を持つ undici `Agent` を作り、その dispatcher で fetch する。`Host` と TLS の
 * servername は URL のホスト名のまま、証明書検証は既定のまま、`redirect` は常に `"error"`。
 *
 * 失敗は `TransportError`（固定の `code`）。headers が返る前の失敗はここで分類して `report()` してから投げる。
 * headers の後に body を読んで失敗したときは adapter が `report(error, ctx)` を呼ぶ（`TransportError` は二重に
 * 報告しない）。アドレス・ホスト名・URL・例外文字列はログに出さない。
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from "undici";

import {
  classifyAddress,
  interfaceAddresses,
  POLICY_VERSION,
  type ParsedAddress,
} from "./destination-policy.js";

export type TransportCode =
  | "destination_blocked"
  | "dns_failed"
  | "connect_failed"
  | "upstream_timeout"
  | "aborted"
  /** 動的経路の門が枠を出さなかった（`admit`）、または名前解決の同時実行の上限。接続は作っていない。 */
  | "admission_refused"
  | "transport_failed";

export interface TransportContext {
  readonly routeId?: string;
  readonly operation: string;
}

export interface TransportEvent {
  readonly code: TransportCode;
  readonly operation: string;
  readonly routeId?: string;
  readonly policy: string;
}

export class TransportError extends Error {
  readonly code: TransportCode;
  readonly operation: string;
  readonly routeId: string | undefined;

  constructor(code: TransportCode, context: TransportContext, cause?: unknown) {
    // 例外文字列に宛先を含めない（ログ・応答に漏れる経路を作らない）。
    super(`outbound transport ${code}`, cause === undefined ? undefined : { cause });
    this.name = "TransportError";
    this.code = code;
    this.operation = context.operation;
    this.routeId = context.routeId;
  }
}

/** Node の `dns.lookup(hostname, { all: true }, cb)` と同じ形（試験で注入する）。 */
export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface GuardedTransportOptions {
  /** fixture 例外（§3.4）。loopback だけを許す。組み立て側だけが true にできる。 */
  readonly allowLoopback: boolean;
  /** 運用者向けの 1 行（§3.6）。 */
  readonly report: (event: TransportEvent) => void;
  readonly lookup?: LookupFn;
  readonly interfaces?: () => readonly string[];
  /** 試験用の CA だけを足す。`rejectUnauthorized` は触らない。本番は未指定。 */
  readonly tls?: { readonly ca?: readonly string[] };

  /*
   * 以下は動的上流 URL の経路だけが指定する（設計 `docs/dynamic-upstream-design.md` §3.1・§3.4・§7.3）。
   * **未指定なら、この transport の挙動は従来と 1 つも変わらない。**
   */

  /** 応答ヘッダ全体の上限（バイト）。未指定は undici の既定。 */
  readonly maxHeaderSize?: number;
  /**
   * 名前解決の期限と同時実行の上限。期限か要求の中断で**待つのをやめる**。`dns.lookup` 自体は取り消せないので、
   * 待つのをやめた解決も終わるまで枠を使い続ける。枠が埋まっていれば解決を始めずに拒否する。
   */
  readonly dns?: { readonly timeoutMs: number; readonly maxInFlight: number };
  /**
   * 宛先の判定を通った後・接続の前に呼ぶ。`addresses` は重複を除いた検査済みアドレスの正規化済み表記
   * （`ParsedAddress.text`）の全部。`undefined` を返したら接続せずに拒否する。返った `release` は、
   * 応答の本文を読み終えた・中断した・失敗したときに 1 回だけ呼ぶ。
   */
  readonly admit?: (addresses: readonly string[], context: TransportContext) => { release(): void } | undefined;
  /**
   * **試験専用。** 宛先の判定（解決・分類・拒否）は本番と同じコードがそのまま走り、判定を通った接続の
   * **TCP の行き先だけ**を差し替える（loopback の fixture の任意のポートへ）。SNI・証明書の検証・`Host` は
   * 元のホスト名のまま。本番の入口はこれを渡さない（静的検査で固定する）。
   */
  readonly dialForTest?: (target: { readonly hostname: string; readonly port: number }) => { readonly host: string; readonly port: number } | undefined;
}

export type GuardedFetch = (
  url: string | URL,
  init: RequestInit | undefined,
  context: TransportContext,
) => Promise<Response>;

/** 検査済みアドレスだけを返す lookup（undici の `connect.lookup`）。Node の `all: true` 形式と単一形式の両方に対応する。 */
export type VettedLookup = (hostname: string, options: unknown, callback: (...args: unknown[]) => void) => void;

export function createVettedLookup(vetted: readonly ParsedAddress[]): VettedLookup {
  if (vetted.length === 0) throw new Error("vetted address list must not be empty");
  return (_hostname, opts, callback) => {
    const all = typeof opts === "object" && opts !== null && (opts as { all?: unknown }).all === true;
    if (all) {
      callback(null, vetted.map((entry) => ({ address: entry.text, family: entry.family })));
    } else {
      const first = vetted[0]!;
      callback(null, first.text, first.family);
    }
  };
}

/**
 * 読まない body を捨てる（設計 §3.3-7）。null 安全。既にエラーになった stream の `cancel()` は reject するので
 * ここで消費し、locked な stream の同期例外も無視する（捨てられない body は要求の timeout で閉じる）。
 */
export function discardBody(response: { readonly body?: ReadableStream<Uint8Array> | null } | null | undefined): void {
  try {
    const cancelled = response?.body?.cancel();
    if (cancelled !== undefined) cancelled.catch(() => {});
  } catch {
    // locked 等。要求の timeout に任せる。
  }
}

/**
 * 1 回の fetch につき dispatch は 1 回だけ（設計 §3.3-10）。undici の fetch は **421** を受けると接続を捨て、**同じ要求を新しい接続で
 * 自動再送**する（Fetch 標準の 421 再試行。body が無いか再生可能な要求が対象で、credential 付き GET も JSON 文字列の POST も該当する）。
 * credential 付き要求を transport が 2 度送らないよう、2 回目の dispatch を拒んで fetch を失敗させる（→ `transport_failed`）。
 */
export class RedispatchRefusedError extends Error {
  override readonly name = "RedispatchRefusedError";
  constructor() {
    super("guarded transport refused a second dispatch within one fetch (HTTP 421 retry)");
  }
}

function oneDispatch(): Dispatcher.DispatcherComposeInterceptor {
  let used = false;
  return (dispatch) => (opts, handler) => {
    if (used) {
      const error = new RedispatchRefusedError();
      if (typeof handler.onResponseError === "function") {
        handler.onResponseError(null as unknown as Dispatcher.DispatchController, error);
      } else {
        (handler as { onError?: (error: Error) => void }).onError?.(error);
      }
      return false;
    }
    used = true;
    return dispatch(opts, handler);
  };
}

/**
 * 応答が終わった（本文を読み終えた・中断した・失敗した）ときに 1 回だけ `done` を呼ぶ。
 * `fetch` は headers で戻るので、枠の返却を `finally` に置くと本文を読んでいる間の同時実行を数えられない。
 */
function onSettled(done: () => void): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (opts, handler) =>
    dispatch(
      opts,
      new Proxy(handler, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if ((property === "onResponseEnd" || property === "onResponseError") && typeof value === "function") {
            return (...args: unknown[]): unknown => {
              done();
              return (value as (...inner: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        },
      }),
    );
}

export interface GuardedTransport {
  readonly fetch: GuardedFetch;
  /** headers 後の失敗（body の読み取り等）を adapter が報告する。`TransportError` は再報告しない。 */
  readonly report: (error: unknown, context: TransportContext) => void;
  readonly allowLoopback: boolean;
  /**
   * 名前解決に期限があるか（`dns` を指定して作ったか）。無い transport では、止まった名前解決が要求の期限
   * （abort signal）を越えて待ち続ける。動的上流 URL の経路はこれが真の transport しか受け取らない。
   */
  readonly boundsDns: boolean;
}

const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  // TLS の検証失敗（接続は確立していない）。
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** error と、その `cause` の連鎖、`AggregateError.errors` を順に辿って最初に当たる分類を返す。 */
function* causes(error: unknown, depth = 0): Generator<unknown> {
  if (depth > 5 || typeof error !== "object" || error === null) return;
  yield error;
  const aggregate = (error as { errors?: unknown }).errors;
  if (Array.isArray(aggregate)) {
    for (const inner of aggregate) yield* causes(inner, depth + 1);
  }
  yield* causes((error as { cause?: unknown }).cause, depth + 1);
}

/** 失敗を固定の分類に写す（§3.6 の根拠表）。経過時間からは推定しない。 */
export function classifyTransportError(error: unknown): TransportCode {
  if (error instanceof TransportError) return error.code;
  for (const candidate of causes(error)) {
    const name = (candidate as { name?: unknown }).name;
    if (name === "TimeoutError") return "upstream_timeout";
    if (name === "AbortError") return "aborted";
    const code = codeOf(candidate);
    if (code !== undefined && CONNECT_CODES.has(code)) return "connect_failed";
  }
  return "transport_failed";
}

export function formatTransportEvent(event: TransportEvent): string {
  return `outbound transport ${event.code} operation=${event.operation} route=${event.routeId ?? "-"} policy=${event.policy}`;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function createGuardedTransport(options: GuardedTransportOptions): GuardedTransport {
  const lookup: LookupFn = options.lookup ?? ((hostname, opts, cb) => dnsLookup(hostname, opts, cb));
  const interfaces = options.interfaces ?? interfaceAddresses;
  const policy = { allowLoopback: options.allowLoopback, interfaces };

  function emit(code: TransportCode, context: TransportContext): void {
    options.report({
      code,
      operation: context.operation,
      policy: POLICY_VERSION,
      ...(context.routeId === undefined ? {} : { routeId: context.routeId }),
    });
  }

  function fail(code: TransportCode, context: TransportContext, cause?: unknown): never {
    emit(code, context);
    throw new TransportError(code, context, cause);
  }

  /** 進行中の名前解決の数（`options.dns` があるときだけ数える）。 */
  let resolving = 0;

  function resolveAll(bare: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      lookup(bare, { all: true, verbatim: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses.map((entry) => entry.address));
      });
    });
  }

  /**
   * 期限・同時実行の上限つきの名前解決（動的経路）。`dns.lookup` は取り消せないので、期限や中断で**待つのをやめても**
   * 解決自体は続く。その間は枠（`resolving`）を持ち続け、終わったときに返す。
   */
  async function resolveBounded(
    bare: string,
    limits: { readonly timeoutMs: number; readonly maxInFlight: number },
    signal: AbortSignal | undefined,
    context: TransportContext,
  ): Promise<string[]> {
    if (signal?.aborted === true) return fail("aborted", context);
    if (resolving >= limits.maxInFlight) return fail("admission_refused", context);
    resolving += 1;
    const pending = resolveAll(bare).finally(() => {
      resolving -= 1;
    });
    // 待つのをやめた後で失敗しても、未処理の拒否にしない。
    pending.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TransportError("dns_failed", context)), limits.timeoutMs);
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new TransportError("aborted", context));
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      if (error instanceof TransportError) {
        emit(error.code, context);
        throw error;
      }
      return fail("dns_failed", context, error);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** ホスト名を解決し、全アドレスを分類する。1 つでも禁止なら拒否（FR-A2）。 */
  async function vet(host: string, context: TransportContext, signal?: AbortSignal): Promise<readonly ParsedAddress[]> {
    const bare = stripBrackets(host);
    let candidates: string[];
    if (isIP(bare) !== 0) {
      candidates = [bare];
    } else if (options.dns !== undefined) {
      candidates = await resolveBounded(bare, options.dns, signal, context);
      if (candidates.length === 0) return fail("dns_failed", context);
    } else {
      try {
        candidates = await resolveAll(bare);
      } catch (error) {
        return fail("dns_failed", context, error);
      }
      if (candidates.length === 0) return fail("dns_failed", context);
    }
    const vetted: ParsedAddress[] = [];
    for (const candidate of candidates) {
      const verdict = classifyAddress(candidate, policy);
      if (!verdict.allowed) return fail("destination_blocked", context);
      vetted.push(verdict.address);
    }
    return vetted;
  }

  async function run(input: string | URL, init: RequestInit | undefined, context: TransportContext): Promise<Response> {
    let url: URL;
    try {
      url = input instanceof URL ? input : new URL(input);
    } catch (error) {
      return fail("destination_blocked", context, error);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
      return fail("destination_blocked", context);
    }
    const vetted = await vet(url.hostname, context, options.dns === undefined ? undefined : (init?.signal ?? undefined));

    /**
     * 宛先の枠（動的経路の門）。重複を除いた**全アドレス**に対して取る（どれに接続するかは undici が決める）。
     * 取れなければ接続しない。返すのは応答が終わったとき（下の `onSettled`）か、headers の前に失敗したとき。
     */
    let release = (): void => {};
    if (options.admit !== undefined) {
      const lease = options.admit([...new Set(vetted.map((entry) => entry.text))], context);
      if (lease === undefined) return fail("admission_refused", context);
      let released = false;
      release = (): void => {
        if (released) return;
        released = true;
        lease.release();
      };
    }

    const connectOptions = {
      lookup: createVettedLookup(vetted) as unknown as typeof dnsLookup,
      ...(options.tls?.ca === undefined ? {} : { ca: [...options.tls.ca] }),
    };
    const dial = options.dialForTest;
    const agent = new Agent({
      // HTTP/1.1 だけ（設計 §3.3-8）。undici 8 は既定で h2 を許し、REFUSED_STREAM / GOAWAY で要求を自動で再送し得る。
      // 有料要求の「1 回だけ送る」契約を transport で守るため、ALPN で h2 を提示しない。
      allowH2: false,
      ...(options.maxHeaderSize === undefined ? {} : { maxHeaderSize: options.maxHeaderSize }),
      connect:
        dial === undefined
          ? connectOptions
          : (() => {
              // 試験専用: 判定は済んでいる。TCP の行き先だけを差し替え、SNI と証明書の検証は元のホスト名のまま。
              const base = buildConnector({ ...connectOptions, allowH2: false });
              return ((connect, callback) => {
                // undici は既定のポートのとき `port` を空で渡す。
                const port = connect.port === "" || connect.port == null ? (connect.protocol === "https:" ? 443 : 80) : Number(connect.port);
                let target: ReturnType<typeof dial>;
                try {
                  target = dial({ hostname: connect.hostname, port });
                } catch (error) {
                  // 差し替え側が拒否した。接続を作らずに失敗させる。
                  callback(error as Error, null);
                  return;
                }
                base(
                  target === undefined
                    ? connect
                    : { ...connect, hostname: target.host, port: String(target.port), servername: connect.servername ?? connect.hostname },
                  callback,
                );
              }) as buildConnector.connector;
            })(),
    });

    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        redirect: "error",
        // 2 回目の dispatch（421 再試行）を拒む（§3.3-10）。
        dispatcher: options.admit === undefined ? agent.compose(oneDispatch()) : agent.compose(oneDispatch(), onSettled(release)),
      });
    } catch (error) {
      release();
      agent.destroy().catch(() => {});
      return fail(classifyTransportError(error), context, error);
    }
    // headers は返った。body は呼び出し側が後から読むので、close は待たない（進行中の要求を終えてから閉じる）。
    agent.close().catch(() => {});
    return response as unknown as Response;
  }

  const guardedFetch: GuardedFetch = async (input, init, context) => {
    try {
      return await run(input, init, context);
    } catch (error) {
      if (error instanceof TransportError) throw error;
      // ポリシー判定・Agent 生成の予期しない失敗（自アドレスが読めない等）。接続は作っていない。fail closed（設計 §5）。
      return fail("transport_failed", context, error);
    }
  };

  return {
    fetch: guardedFetch,
    report(error, context) {
      if (error instanceof TransportError) return; // 既に報告済み
      emit(classifyTransportError(error), context);
    },
    allowLoopback: options.allowLoopback,
    boundsDns: options.dns !== undefined,
  };
}
