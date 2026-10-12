/**
 * The Tempo RPC transport of the daemon (docs/payer-rails-design.md SR-R5, §2.3): the Router's own guarded transport
 * (vendored byte-identical: DNS pinning, private/loopback/own-address refusal, no redirects, HTTP/1.1 only, one dispatch)
 * wrapped into the `typeof fetch` shape viem's `http()` accepts, plus a 64 KiB bound on the response body. The guarded
 * transport returns headers and leaves the body to the caller, so the bound lives here: a body over the limit fails the
 * RPC call (never silently truncated). Production builds the transport here with `allowLoopback: false`; a test may pass
 * its own transport (loopback fixture). Solana reads its blockhash through the vendored `svm-rpc.ts`, which builds the
 * same transport itself.
 */
import { readBoundedBody } from "../vendor/bounded-body.js";
import { createGuardedTransport, type GuardedTransport } from "../vendor/guarded-fetch.js";

export const RPC_RESPONSE_MAX_BYTES = 64 * 1024;
const CONTEXT = { routeId: "tempo", operation: "rpc" } as const;
/** HTTP statuses whose `Response` must carry no body. */
const BODYLESS = new Set([101, 103, 204, 205, 304]);

export function productionTransport(): Pick<GuardedTransport, "fetch"> {
  return createGuardedTransport({ allowLoopback: false, report: () => {}, dns: { timeoutMs: 3_000, maxInFlight: 2 } });
}

/**
 * `fetchFn` for `createMppPayer` (and anything else viem dials). Each call: guarded dispatch, body read up to 64 KiB, and a
 * fresh `Response` with the bounded bytes and the original status/headers. Transport failures and oversize bodies throw;
 * the signer maps every throw to `sign_failed` and the purchase core to `unknown` (funds may have moved on Tempo).
 */
export function createGuardedFetch(transport: Pick<GuardedTransport, "fetch"> = productionTransport()): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input : input.url;
    const response = await transport.fetch(url, init, CONTEXT);
    const read = await readBoundedBody(response, RPC_RESPONSE_MAX_BYTES);
    if (!read.ok) throw new Error("rpc_response_too_large");
    const bodyless = BODYLESS.has(response.status);
    if (bodyless && read.bytes.byteLength !== 0) throw new Error("rpc_response_malformed");
    return new Response(bodyless ? null : read.bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
