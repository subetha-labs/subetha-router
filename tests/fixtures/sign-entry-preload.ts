/**
 * `tools/sign-payment.ts` を子 process で動かす試験の preload（`node --import`）。**試験基盤。製品コードではない。**
 *
 * - `R6_TEMPO_RPC_URL`: Tempo の既定の RPC（`rpc.moderato.tempo.xyz`）への fetch を、試験の fake の RPC（loopback）に向け直す。
 *   入口（`tools/sign-payment.ts`）は RPC の URL を受け取らないので、製品に env を足さずにここで差し替える。
 * - loopback（`127.0.0.1`）以外への fetch は全部拒む（実の network に出ない）。
 * - `R6_FROZEN_NOW_MS`: `Date.now` を固定する（Tempo の `validBefore` が固定され、raw tx・stderr が実行ごとに同じになる）。
 */
const target = process.env["R6_TEMPO_RPC_URL"];
const frozen = process.env["R6_FROZEN_NOW_MS"];
if (frozen !== undefined && frozen !== "") {
  const value = Number(frozen);
  Date.now = () => value;
}

/** http の loopback（`127.0.0.1`）の URL だけを受ける（向け直しの先も同じ規則。Codex R-6 #1）。 */
function isLoopbackHttp(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
const original = globalThis.fetch;
const blocked = (): Promise<Response> => Promise.reject(new TypeError("network blocked by the test preload"));
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return blocked();
  }
  // 自動の redirect は辿らない（loopback から外への redirect で外に出ない）。
  // `signal` は展開では引き継がれない場合があるので明示して渡す（viem の期限はこの signal で切れる）。
  const noRedirect: RequestInit = init === undefined ? { redirect: "manual" } : { ...init, redirect: "manual", ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }) };
  if (url.hostname === "rpc.moderato.tempo.xyz") {
    if (target === undefined || target === "" || !isLoopbackHttp(target)) return blocked();
    return original(target, noRedirect);
  }
  if (isLoopbackHttp(url.href)) return original(input, noRedirect);
  return blocked();
}) as typeof fetch;
