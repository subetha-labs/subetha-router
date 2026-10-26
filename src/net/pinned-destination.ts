/**
 * 秘匿購入の proxy 型の宛先の固定（`docs/zktls-router-proxy-design.md` §4.1、要件 FR-X05・FR-X06）。
 *
 * `guarded-fetch.ts` は `@subetha/payer` が byte 単位で同じ写しを持つ（`packages/payer/test/unit/vendor.test.ts`）ので**変えない**。ここは
 * その公開の部品（`createGuardedTransport`・`classifyAddress`）だけを使う:
 * 1. ホスト名を期限・同時数の上限つきで解決し、**全回答**を `classifyAddress`（loopback 不可、Router 自身のアドレスも不可）で分類、1 つでも禁止なら拒否。
 * 2. 通った回答の**最初の IPv4**（無ければ最初の IPv6）を選び、そのアドレスの宛先の枠（`admit`）を 1 つ取る。これが購入の枠の全部。
 * 3. 固定した 1 アドレスだけを返す lookup を持つ transport（**枠を取らない**）を作る。探りはこれで送るので、名前を引き直さず、枠を二重に使わない。
 *    試験の差し替え（`dialForTest`）は pin を作ったときに 1 回だけ呼び、その答えに固定する（pin・探り・Verifier の接続先を同じにする）。
 * 失敗は `TransportError`（固定の `code`）だけ。宛先・ホスト名・例外文字列はログに出さない。
 */

import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

import { classifyAddress, interfaceAddresses, POLICY_VERSION, type ParsedAddress } from "./destination-policy.js";
import { createGuardedTransport, TransportError, type GuardedTransport, type GuardedTransportOptions, type LookupFn, type TransportCode, type TransportContext } from "./guarded-fetch.js";

/** 固定した宛先（内部の値。要求・journal・復元した JSON から組まない）。 */
export interface TransportPin {
  readonly host: string;
  readonly address: ParsedAddress;
  /** pin を作ったときの `dialForTest` の答え（試験だけ。本番は無い）。 */
  readonly dial?: { readonly host: string; readonly port: number };
}

export interface PinnedDestination {
  readonly pin: TransportPin;
  /** 検査を通った、接続に使うアドレス（正規化済み）。 */
  readonly vettedAddress: string;
  /** Verifier に渡す接続先 `host:port`（IPv6 は `[x::y]:port`）。試験では差し替え先。 */
  readonly dialAddr: string;
  /** 固定した宛先にだけ接続する transport（名前解決は固定の答え、枠は取らない）。別のホスト名は解決できずに失敗する。 */
  readonly transport: GuardedTransport;
  /** 宛先の枠を返す（冪等）。 */
  release(): void;
}

export interface DestinationPinnerOptions {
  readonly report: GuardedTransportOptions["report"];
  readonly dns: { readonly timeoutMs: number; readonly maxInFlight: number };
  readonly admit?: GuardedTransportOptions["admit"];
  readonly maxHeaderSize?: number;
  readonly lookup?: LookupFn;
  readonly interfaces?: () => readonly string[];
  readonly tls?: GuardedTransportOptions["tls"];
  /** **試験専用。** `guarded-fetch.ts` の同名の欄と同じ意味（TCP の行き先だけを差し替える）。pin の時に 1 回だけ呼ぶ。 */
  readonly dialForTest?: GuardedTransportOptions["dialForTest"];
}

export interface DestinationPinner {
  pinDestination(host: string, context: TransportContext): Promise<PinnedDestination>;
}

export function createDestinationPinner(options: DestinationPinnerOptions): DestinationPinner {
  const lookup: LookupFn = options.lookup ?? ((hostname, opts, cb) => dnsLookup(hostname, opts, cb));
  const interfaces = options.interfaces ?? interfaceAddresses;
  let resolving = 0;

  /**
   * 固定の code で報告して投げる。**`cause` は付けない**（DNS・接続の例外はアドレスを含み得る。`util.inspect` で漏れないよう、この境界で落とす）。
   */
  function fail(code: TransportCode, context: TransportContext): never {
    options.report({ code, operation: context.operation, policy: POLICY_VERSION, ...(context.routeId === undefined ? {} : { routeId: context.routeId }) });
    throw new TransportError(code, context);
  }

  /** 期限・同時数の上限つきの解決（`guarded-fetch.ts` の `resolveBounded` と同じ規則。待つのをやめた解決も終わるまで枠を持つ）。 */
  async function resolveBounded(host: string, context: TransportContext): Promise<string[]> {
    if (resolving >= options.dns.maxInFlight) return fail("admission_refused", context);
    resolving += 1;
    const pending = new Promise<string[]>((resolve, reject) => {
      lookup(host, { all: true, verbatim: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses.map((entry) => entry.address));
      });
    }).finally(() => {
      resolving -= 1;
    });
    pending.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TransportError("dns_failed", context)), options.dns.timeoutMs);
        }),
      ]);
    } catch {
      return fail("dns_failed", context);
    } finally {
      clearTimeout(timer);
    }
  }

  async function pinDestination(host: string, context: TransportContext): Promise<PinnedDestination> {
    const candidates = isIP(host) !== 0 ? [host] : await resolveBounded(host, context);
    if (candidates.length === 0) return fail("dns_failed", context);
    const vetted: ParsedAddress[] = [];
    for (const candidate of candidates) {
      let verdict: ReturnType<typeof classifyAddress>;
      try {
        verdict = classifyAddress(candidate, { allowLoopback: false, interfaces });
      } catch {
        return fail("transport_failed", context);
      }
      if (!verdict.allowed) return fail("destination_blocked", context);
      vetted.push(verdict.address);
    }
    const chosen = vetted.find((entry) => entry.family === 4) ?? vetted[0]!;
    let lease: { release(): void } | undefined;
    if (options.admit !== undefined) {
      lease = options.admit([chosen.text], context);
      if (lease === undefined) return fail("admission_refused", context);
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      lease?.release();
    };
    try {
      let dial: { readonly host: string; readonly port: number } | undefined;
      if (options.dialForTest !== undefined) {
        let target: ReturnType<NonNullable<GuardedTransportOptions["dialForTest"]>>;
        try {
          target = options.dialForTest({ hostname: host, port: 443 });
        } catch {
          release();
          return fail("connect_failed", context);
        }
        dial = target === undefined ? undefined : { host: target.host, port: target.port };
      }
      const pin: TransportPin = { host, address: chosen, ...(dial === undefined ? {} : { dial }) };
      const fixedLookup: LookupFn = (hostname, _opts, callback) => {
        if (hostname !== host) {
          callback(Object.assign(new Error("not the pinned host"), { code: "ENOTFOUND" }), []);
          return;
        }
        callback(null, [{ address: chosen.text, family: chosen.family }]);
      };
      const fixedDial = dial;
      const inner = createGuardedTransport({
        allowLoopback: false,
        report: options.report,
        lookup: fixedLookup,
        interfaces,
        dns: { timeoutMs: options.dns.timeoutMs, maxInFlight: 4 },
        ...(options.maxHeaderSize === undefined ? {} : { maxHeaderSize: options.maxHeaderSize }),
        ...(options.tls === undefined ? {} : { tls: options.tls }),
        // 枠は pin が持つので `admit` は渡さない。差し替えは pin の時の答えに固定する（呼び直さない）。
        ...(fixedDial === undefined ? {} : { dialForTest: (target: { readonly hostname: string; readonly port: number }) => (target.hostname === host ? fixedDial : undefined) }),
      });
      /**
       * 入口で固定の宛先だけに絞る（IP を直接書いた URL・別のポート・別の scheme は、固定の lookup を通らずに出られるので、ここで拒否する）。
       * scheme は https だけ（試験の差し替えがある構成だけ、loopback の fixture の http も許す）。ポートは既定（443 / 試験の http は 80 の表記なし）だけ。
       * 失敗は `cause` の無い `TransportError` に包み直す（中の transport が報告済みなので二重に報告しない）。
       */
      const allowHttp = options.dialForTest !== undefined;
      const transport: GuardedTransport = {
        allowLoopback: inner.allowLoopback,
        boundsDns: inner.boundsDns,
        report: inner.report,
        fetch: async (input, init, fetchContext) => {
          let url: URL;
          try {
            url = input instanceof URL ? input : new URL(String(input));
          } catch {
            return fail("destination_blocked", fetchContext);
          }
          const schemeOk = url.protocol === "https:" || (allowHttp && url.protocol === "http:");
          if (!schemeOk || url.hostname !== host || url.port !== "" || url.username !== "" || url.password !== "") {
            return fail("destination_blocked", fetchContext);
          }
          try {
            return await inner.fetch(url, init, fetchContext);
          } catch (error) {
            if (error instanceof TransportError) throw new TransportError(error.code, fetchContext);
            throw new TransportError("transport_failed", fetchContext);
          }
        },
      };
      const dialHost = dial?.host ?? chosen.text;
      const dialPort = dial?.port ?? 443;
      const dialAddr = `${isIP(dialHost) === 6 ? `[${dialHost}]` : dialHost}:${String(dialPort)}`;
      return { pin, vettedAddress: chosen.text, dialAddr, transport, release };
    } catch (error) {
      release();
      if (error instanceof TransportError) throw new TransportError(error.code, context);
      return fail("transport_failed", context);
    }
  }

  return { pinDestination };
}
