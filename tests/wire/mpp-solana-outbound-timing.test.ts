/**
 * MPP Solana 送信の**実時間**の予算（要件 FR-53・D-30、タスク M4-b の `slow`）: pay-kit の server の確定待ち（`getSignatureStatuses` を 2 秒ごと、最大 30 秒）を
 * fixture の status の列で再現し、Router の既定の有料要求の期限 45 秒の内側なら `paid`、相手が 45 秒を超えて答えなければ `unknown`。
 * 実時間で約 80 秒かかるので、変異の表の suite からは外す（`tests/wire/mpp-solana-outbound.test.ts` と同じ harness）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { createMppSolanaOutbound, type MppSolanaOutbound } from "../../src/adapters/outbound/mpp-solana.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, MessageReservation, PayRequest } from "../../src/ports/outbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startMppSolanaUpstream, type MppSolanaUpstream } from "../fixtures/mpp-solana-upstream.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { createSvmSignerFixture, type SvmSignerFixture } from "../fixtures/svm-signer-fixture.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RPC_HOST = "rpc.provider.test";
const PROVIDER_HOST = "provider.test";
const ROUTE = "md-sol-mpp";
const UPSTREAM = `https://${PROVIDER_HOST}/v1/eth/snapshot`;

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function ataOf(owner: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

async function harness(): Promise<{ rail: MppSolanaOutbound; signer: SvmSignerFixture; rpc: SolanaRpcFixture; upstream: MppSolanaUpstream }> {
  const signer = createSvmSignerFixture(SOL);
  const router = signer.address;
  const recipient = createSvmSignerFixture(SOL).address;
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, atas: [{ address: await ataOf(router), owner: router, amount: "1000000" }, { address: await ataOf(recipient), owner: recipient }] });
  closers.push(rpc.close);
  const payKitRpc = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: rpc });
  closers.push(payKitRpc.close);
  // 既定は 1 回目で confirmed（hold の試験は pay-kit の確定待ちを含めない: 測るのは Router の期限だけ）。
  rpc.state.signatureStatuses = ["confirmed"];
  const upstream = await startMppSolanaUpstream({ rpcUrl: payKitRpc.url, feePayer: true, recipient, tls: TLS });
  closers.push(upstream.close);
  const dial = dialTo({ [PROVIDER_HOST]: upstream.port, [RPC_HOST]: rpc.port });
  const base = { allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dial };
  const rail = createMppSolanaOutbound({
    network: SOL,
    upstreams: { [ROUTE]: UPSTREAM },
    destinations: { [ROUTE]: { payTo: recipient, asset: MINT, scheme: "solana/charge" } },
    capability: signer.capability,
    transport: createGuardedTransport(base),
    rpc: { url: `http://${RPC_HOST}`, transport: createGuardedTransport({ ...base, dns: { timeoutMs: 3_000, maxInFlight: 4 } }) },
    operatorAddresses: new Set([router]),
    mint: MINT,
    decimals: 6,
    tokenProgram: String(TOKEN_PROGRAM_ADDRESS),
  });
  await rail.startup();
  return { rail, signer, rpc, upstream };
}

function requestOf(offer: DestinationOffer): PayRequest {
  const reservations = new Set<string>();
  const reserveMessage = async (hash: string): Promise<MessageReservation> => { if (reservations.has(hash)) return "collision"; reservations.add(hash); return "reserved"; };
  return { routeId: ROUTE, offer, paymentId: "11111111-2222-4333-8444-000000000001", attempt: 1, deadlineMs: Date.now() + 600_000, reserveMessage };
}

describe("実時間の予算（既定の 45 秒）", () => {
  test("pay-kit の確定待ちが約 30 秒（status が 14 回 null の後に confirmed）でも、既定の有料要求の期限（45 秒）の内側なので paid", async () => {
    const h = await harness();
    h.rpc.state.signatureStatuses = [...Array<"null">(14).fill("null"), "confirmed"];
    const started = Date.now();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    const result = await h.rail.pay(requestOf(offer));
    const elapsed = Date.now() - started;
    expect(result.outcome, JSON.stringify(result)).toBe("paid");
    expect(elapsed).toBeGreaterThan(25_000);
    expect(elapsed).toBeLessThan(45_000);
    expect(h.signer.signCount()).toBe(1);
  }, 70_000);

  test("相手が 45 秒を超えて答えない（headers も出さない）→ 既定の期限で unknown destination_pay_unknown。署名は 1 回、再送しない", async () => {
    const h = await harness();
    h.upstream.state.pay = "hold";
    h.upstream.state.holdMs = 50_000;
    const started = Date.now();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    const result = await h.rail.pay(requestOf(offer));
    const elapsed = Date.now() - started;
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(elapsed).toBeGreaterThan(44_000);
    expect(elapsed).toBeLessThan(50_000);
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.payCalls).toBe(1);
  }, 70_000);
});
