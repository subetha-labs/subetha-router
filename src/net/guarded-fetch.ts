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
import { Agent, fetch as undiciFetch } from "undici";

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
}

export type GuardedFetch = (
  url: string | URL,
  init: RequestInit | undefined,
  context: TransportContext,
) => Promise<Response>;

export interface GuardedTransport {
  readonly fetch: GuardedFetch;
  /** headers 後の失敗（body の読み取り等）を adapter が報告する。`TransportError` は再報告しない。 */
  readonly report: (error: unknown, context: TransportContext) => void;
  readonly allowLoopback: boolean;
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

  /** ホスト名を解決し、全アドレスを分類する。1 つでも禁止なら拒否（FR-A2）。 */
  async function vet(host: string, context: TransportContext): Promise<readonly ParsedAddress[]> {
    const bare = stripBrackets(host);
    let candidates: string[];
    if (isIP(bare) !== 0) {
      candidates = [bare];
    } else {
      try {
        candidates = await new Promise<string[]>((resolve, reject) => {
          lookup(bare, { all: true, verbatim: true }, (error, addresses) => {
            if (error) reject(error);
            else resolve(addresses.map((entry) => entry.address));
          });
        });
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

  const guardedFetch: GuardedFetch = async (input, init, context) => {
    let url: URL;
    try {
      url = input instanceof URL ? input : new URL(input);
    } catch (error) {
      return fail("destination_blocked", context, error);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
      return fail("destination_blocked", context);
    }
    const vetted = await vet(url.hostname, context);

    // 検査済みアドレスだけを返す lookup。Node の `all: true` 形式と単一形式の両方に対応する。
    const vettedLookup = (
      _hostname: string,
      opts: unknown,
      callback: (...args: unknown[]) => void,
    ): void => {
      const all = typeof opts === "object" && opts !== null && (opts as { all?: unknown }).all === true;
      if (all) {
        callback(null, vetted.map((entry) => ({ address: entry.text, family: entry.family })));
      } else {
        const first = vetted[0]!;
        callback(null, first.text, first.family);
      }
    };
    const agent = new Agent({
      connect: {
        lookup: vettedLookup as unknown as typeof dnsLookup,
        ...(options.tls?.ca === undefined ? {} : { ca: [...options.tls.ca] }),
      },
    });

    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        redirect: "error",
        dispatcher: agent,
      });
    } catch (error) {
      agent.destroy().catch(() => {});
      return fail(classifyTransportError(error), context, error);
    }
    // headers は返った。body は呼び出し側が後から読むので、close は待たない（進行中の要求を終えてから閉じる）。
    agent.close().catch(() => {});
    return response as unknown as Response;
  };

  return {
    fetch: guardedFetch,
    report(error, context) {
      if (error instanceof TransportError) return; // 既に報告済み
      emit(classifyTransportError(error), context);
    },
    allowLoopback: options.allowLoopback,
  };
}
