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

const original = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname === "rpc.moderato.tempo.xyz" && target !== undefined && target !== "") return original(target, init);
  if (url.hostname === "127.0.0.1") return original(input, init);
  return Promise.reject(new TypeError("network blocked by the test preload"));
}) as typeof fetch;
