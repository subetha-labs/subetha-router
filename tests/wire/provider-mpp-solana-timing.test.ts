/**
 * Provider D の実時間の行（`docs/provider-mpp-solana-workers.md` §4）: pay-kit の確定待ち（30 秒）が尽きると Provider は 402（領収なし）で、
 * Router は 45 秒の内側で `unknown`（`destination_pay_unknown`）。送出は 1 回。**約 35 秒かかる**ので変異の表からは外す。
 * 配線は `provider-mpp-solana-handler.test.ts` と同じ（pay-kit は本物、RPC は fixture、Hyperliquid は差し替え、鍵は乱数）。
 */
import http from "node:http";
import https from "node:https";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { address, getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { createMppSolanaOutbound } from "../../src/adapters/outbound/mpp-solana.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { MessageReservation } from "../../src/ports/outbound.js";
import { handle, runtimeOf, type Runtime } from "../../providers/mpp-solana-workers/src/index.js";
import { uninstallLogRedaction } from "../../providers/mpp-solana-workers/src/log.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startSolanaRpc } from "../fixtures/solana-rpc.js";
import { createSvmSignerFixture } from "../fixtures/svm-signer-fixture.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RPC_HOST = "rpc.provider.test";
const PROVIDER_HOST = "provider.test";
const ROUTE = "md-solmpp-eth-snapshot";
const HYPERLIQUID = [{ universe: [{ name: "ETH" }] }, [{ markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "1" }]];

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  uninstallLogRedaction();
  while (closers.length > 0) await closers.pop()!();
});

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

describe("Provider D: 確定待ちの timeout（実時間）", () => {
  test("getSignatureStatuses が null のまま → pay-kit は 30 秒で諦めて 402（領収なし）→ Router は unknown。送出は 1 回、Router の 45 秒の内側", async () => {
    const signer = createSvmSignerFixture(SOL);
    const routerAta = String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(signer.address), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
    const seedBytes = crypto.getRandomValues(new Uint8Array(32));
    const feePayer = { seed: getBase58Decoder().decode(seedBytes), publicKey: getAddressDecoder().decode(ed25519.getPublicKey(seedBytes)) };
    const recipient = getAddressDecoder().decode(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))));
    const recipientAta = String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(recipient), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
    const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, atas: [{ address: routerAta, owner: signer.address, amount: "1000000" }, { address: recipientAta, owner: recipient }] });
    closers.push(rpc.close);
    const payKitRpc = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: rpc });
    closers.push(payKitRpc.close);
    rpc.state.signatureStatuses = ["null"];
    const dataPort = await listen(http.createServer((_request, response) => { const text = JSON.stringify(HYPERLIQUID); response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }); response.end(text); }));
    const runtime: Runtime = await runtimeOf({ PAY_TO: recipient, FEE_PAYER_PUBKEY: feePayer.publicKey, FEE_PAYER_KEY: feePayer.seed, MPP_SECRET: "provider-d-timing-secret-0123456789abcdef", SOLANA_RPC_URL: payKitRpc.url, DATA_URL: `http://127.0.0.1:${dataPort}/info` });
    const statuses: number[] = [];
    const providerPort = await listen(https.createServer({ key: TLS.provider.key, cert: TLS.provider.cert }, (request, response) => {
      void (async () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
        const out = await handle(new Request(`https://${PROVIDER_HOST}${request.url ?? "/"}`, { method: request.method ?? "GET", headers }), runtime);
        statuses.push(out.status);
        const body = Buffer.from(await out.arrayBuffer());
        const outHeaders = Object.fromEntries(out.headers.entries());
        delete outHeaders["content-length"];
        response.writeHead(out.status, { ...outHeaders, "content-length": String(body.length) });
        response.end(body);
      })();
    }));
    const base = { allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo({ [PROVIDER_HOST]: providerPort, [RPC_HOST]: rpc.port }) };
    const rail = createMppSolanaOutbound({
      network: SOL,
      upstreams: { [ROUTE]: `https://${PROVIDER_HOST}/v1/eth/snapshot` },
      destinations: { [ROUTE]: { payTo: recipient, asset: MINT, scheme: "solana/charge" } },
      capability: signer.capability,
      transport: createGuardedTransport(base),
      rpc: { url: `http://${RPC_HOST}`, transport: createGuardedTransport({ ...base, dns: { timeoutMs: 3_000, maxInFlight: 4 } }) },
      operatorAddresses: new Set([signer.address]),
      mint: MINT,
      decimals: 6,
      tokenProgram: String(TOKEN_PROGRAM_ADDRESS),
    });
    await rail.startup();
    const offers = await rail.readChallenge(ROUTE);
    const reservations = new Set<string>();
    const reserveMessage = async (hash: string): Promise<MessageReservation> => (reservations.has(hash) ? "collision" : (reservations.add(hash), "reserved"));
    const started = Date.now();
    const result = await rail.pay({ routeId: ROUTE, offer: offers[0]!, paymentId: "11111111-2222-4333-8444-000000000099", attempt: 1, deadlineMs: Date.now() + 600_000, reserveMessage });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(statuses).toEqual([402, 402, 402]);
    expect(rpc.state.sent).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(29_000);
    expect(elapsed).toBeLessThan(45_000);
  }, 90_000);
});
