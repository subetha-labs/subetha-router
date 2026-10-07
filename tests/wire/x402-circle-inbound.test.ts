/**
 * x402 受信 kind `circle`（Arc、Circle の Facilitator Service。multirail 設計 §4・§6。タスク T3）。**無課金**。
 * 相手は loopback の合成 facilitator（売り手証明を本物と同じ規則で検証する）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS, createX402Inbound } from "../../src/adapters/inbound/x402.js";
import { decodeSellerProofHeader, encodeSellerProofHeader, type SellerProofEnvelope } from "../../src/adapters/inbound/seller-proof.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential, SellerProofCapability } from "../../src/ports/inbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { createTestSellerProof } from "../fixtures/seller-proof-capability.js";

const ROUTE_ID = "md-arc-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`].map(encodeURIComponent).join("|");
const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";

const running: Listening[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

async function startFacilitator(args: readonly string[] = []): Promise<Listening> {
  const fixture = await startListening("tests/fixtures/circle-facilitator.ts", ["--port", "0", ...args]);
  running.push(fixture);
  return fixture;
}

function railOf(fixture: Listening, proof: SellerProofCapability, extra: Partial<Parameters<typeof createX402Inbound>[0]> = {}) {
  return createX402Inbound({
    kind: "circle",
    sellerProof: proof,
    transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
    facilitatorUrl: fixture.baseUrl,
    payTo: proof.address,
    assetDomain: { name: "USDC", version: "2" },
    ...extra,
  });
}

async function issue(rail: ReturnType<typeof createX402Inbound>): Promise<InboundOffer> {
  return rail.createOffer({ routeId: ROUTE_ID, amount: "10000", asset: ARC_USDC, network: ARC, routeBinding: ROUTE_BINDING, nowMs: Date.now() });
}

function credentialFor(offer: InboundOffer, accepted: Record<string, unknown> = {}): PaymentCredential {
  return { x402Version: 2, accepted: { ...offer, ...accepted } as InboundOffer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0xdeadbeef", authorization: {} } };
}

async function callsOf(fixture: Listening): Promise<Record<string, unknown>> {
  return (await (await fetch(`${fixture.baseUrl}/calls`)).json()) as Record<string, unknown>;
}

describe("x402 受信 kind circle: offer と時間", () => {
  it("offer に assetTransferMethod、wire の maxTimeoutSeconds 30、有効期間 120 秒（既定）。offerSeconds で有効期間だけ変わる", async () => {
    const fixture = await startFacilitator();
    const proof = createTestSellerProof({ network: ARC });
    const now = Date.now();
    const offer = await railOf(fixture, proof.capability).createOffer({ routeId: ROUTE_ID, amount: "10000", asset: ARC_USDC, network: ARC, routeBinding: ROUTE_BINDING, nowMs: now });
    expect(offer.extra["assetTransferMethod"]).toBe("eip3009");
    expect(offer.maxTimeoutSeconds).toBe(CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS);
    expect(offer.extra.expiresAt).toBe(Math.floor(now / 1000) + 120);
    expect(offer.extra["fundsMoveOnCredential"]).toBe(false);
    const longer = await railOf(fixture, proof.capability, { offerSeconds: 600 }).createOffer({ routeId: ROUTE_ID, amount: "10000", asset: ARC_USDC, network: ARC, routeBinding: ROUTE_BINDING, nowMs: now });
    expect(longer.extra.expiresAt).toBe(Math.floor(now / 1000) + 600);
    expect(longer.maxTimeoutSeconds).toBe(CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS);
  });

  it("kind を省いた既存の adapter は今までどおり（assetTransferMethod 無し、有効期間 = wire = maxTimeoutSeconds）", async () => {
    const fixture = await startFacilitator();
    const rail = createX402Inbound({ transport: createGuardedTransport({ allowLoopback: true, report: () => {} }), facilitatorUrl: fixture.baseUrl, payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405", maxTimeoutSeconds: 600 });
    const now = Date.now();
    const offer = await rail.createOffer({ routeId: ROUTE_ID, amount: "10000", asset: ARC_USDC, network: "eip155:84532", routeBinding: ROUTE_BINDING, nowMs: now });
    expect(offer.extra["assetTransferMethod"]).toBeUndefined();
    expect(offer.maxTimeoutSeconds).toBe(600);
    expect(offer.extra.expiresAt).toBe(Math.floor(now / 1000) + 600);
  });

  it("kind circle は sellerProof 無しでは作れない", async () => {
    const fixture = await startFacilitator();
    expect(() => createX402Inbound({ kind: "circle", transport: createGuardedTransport({ allowLoopback: true, report: () => {} }), facilitatorUrl: fixture.baseUrl, payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405" })).toThrow(/seller proof/);
  });

  it("preflight: assetTransferMethod を落とした・変えた accepted は offer_mismatch", async () => {
    const fixture = await startFacilitator();
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fixture, proof.capability);
    const offer = await issue(rail);
    expect(rail.preflight(offer, credentialFor(offer), Date.now())).toEqual({ ok: true });
    const { assetTransferMethod: _dropped, ...withoutMethod } = offer.extra as Record<string, unknown>;
    expect(rail.preflight(offer, credentialFor(offer, { extra: withoutMethod }), Date.now())).toEqual({ ok: false, reason: "offer_mismatch" });
    expect(rail.preflight(offer, credentialFor(offer, { extra: { ...offer.extra, assetTransferMethod: "permit2" } }), Date.now())).toEqual({ ok: false, reason: "offer_mismatch" });
  });
});

describe("x402 受信 kind circle: 売り手証明", () => {
  it("verify と settle に証明が付き、fixture が検証して通る。purpose は endpoint と同じ、nonce は要求ごとに違う", async () => {
    const fixture = await startFacilitator();
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fixture, proof.capability);
    const offer = await issue(rail);
    const credential = credentialFor(offer);
    expect(await rail.verify(offer, credential)).toEqual({ isValid: true });
    const afterVerify = (await callsOf(fixture))["lastProof"] as SellerProofEnvelope;
    const settled = await rail.settle(offer, credential);
    expect(settled.outcome).toBe("settled");
    expect((settled as { txRef: string }).txRef).toMatch(/^0x[0-9a-f]{64}$/);
    const calls = await callsOf(fixture);
    expect(calls["proofFailures"]).toEqual([]);
    expect(calls["verifyCalls"]).toBe(1);
    expect(calls["settleCalls"]).toBe(1);
    const afterSettle = calls["lastProof"] as SellerProofEnvelope;
    expect(afterVerify.nonce).not.toBe(afterSettle.nonce);
    expect(afterSettle.payTo).toBe(proof.address);
    expect(afterSettle.network).toBe(ARC);
    // requirements は Router 発行の offer から（assetTransferMethod を含む）。
    const requirements = calls["lastRequirements"] as Record<string, unknown>;
    expect((requirements["extra"] as Record<string, unknown>)["assetTransferMethod"]).toBe("eip3009");
    expect(requirements["maxTimeoutSeconds"]).toBe(CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS);
    // payload に challengeNonce は残るが、facilitator の文字列は結果に出ない。
    expect(JSON.stringify(settled)).not.toContain("SECRET");
  });

  it("fixture は壊れた証明を 401 で拒む（header 無し・別の鍵・bodyHash 違い・purpose 入れ替え・未来の issuedAt・失効・寿命 301 秒・nonce 再使用・network／payTo 改変）", async () => {
    const fixture = await startFacilitator();
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fixture, proof.capability);
    const offer = await issue(rail);
    const body = JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, scheme: "exact", network: ARC, accepted: offer, payload: { signature: "0x" } }, paymentRequirements: { ...offer } });
    const post = async (path: string, header: string | undefined, text = body): Promise<{ status: number; reason: string | undefined }> => {
      const response = await fetch(`${fixture.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(header === undefined ? {} : { "facilitator-seller-proof": header }) }, body: text });
      const json = (await response.json()) as Record<string, unknown>;
      return { status: response.status, reason: json["reason"] as string | undefined };
    };
    const hash = (await import("../../src/adapters/inbound/seller-proof.js")).bodyHashOf(body);
    const good = await proof.capability.proofFor("verify", hash);
    expect((await post("/verify", good)).status).toBe(200);
    expect(await post("/verify", undefined)).toEqual({ status: 401, reason: "proof_missing" });
    const other = createTestSellerProof({ network: ARC });
    expect(await post("/verify", await other.capability.proofFor("verify", hash))).toEqual({ status: 401, reason: "payto_mismatch" });
    expect(await post("/verify", await proof.capability.proofFor("verify", hash), body + " ")).toEqual({ status: 401, reason: "signer_mismatch" });
    expect(await post("/settle", await proof.capability.proofFor("verify", hash))).toEqual({ status: 401, reason: "signer_mismatch" });
    const future = createTestSellerProof({ network: ARC, now: () => Date.now() + 120_000 });
    const futureEnvelope = decodeSellerProofHeader(await future.capability.proofFor("verify", hash))!;
    expect((await post("/verify", encodeSellerProofHeader({ ...futureEnvelope, payTo: proof.address }))).status).toBe(401);
    const stale = createTestSellerProof({ network: ARC, now: () => Date.now() - 600_000 });
    expect((await post("/verify", await stale.capability.proofFor("verify", hash))).reason).toBe("payto_mismatch");
    // 同じ鍵で寿命 301 秒は能力が作れない（上限 300）。fixture 側の規則は封筒を手で作って見る。
    const envelope = decodeSellerProofHeader(good)!;
    expect((await post("/verify", encodeSellerProofHeader({ ...envelope, expiresAt: envelope.issuedAt + 301 }))).reason).toBe("lifetime_too_long");
    expect((await post("/verify", good)).reason).toBe("nonce_reused");
    expect((await post("/verify", encodeSellerProofHeader({ ...envelope, nonce: `0x${"11".repeat(32)}`, network: "eip155:84532" }))).reason).toBe("network_mismatch");
  });

  it("能力が拒むと要求を出さない: verify は isValid false、settle は rejected（接続 0）", async () => {
    const fixture = await startFacilitator();
    const refusing: SellerProofCapability = { network: ARC, address: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405", proofFor: async () => { throw new Error("no"); } };
    const rail = railOf(fixture, refusing);
    const offer = await issue(rail);
    expect(await rail.verify(offer, credentialFor(offer))).toEqual({ isValid: false });
    expect(await rail.settle(offer, credentialFor(offer))).toEqual({ outcome: "rejected", reason: "source_rejected" });
    const calls = await callsOf(fixture);
    expect(calls["verifyCalls"]).toBe(0);
    expect(calls["settleCalls"]).toBe(0);
    // 接続は `/calls` を読んだこの 1 本だけ（facilitator への要求は 0）。
    expect(calls["connections"]).toBe(1);
  });

  it("verify が false なら理由の文字列を転送しない（FR-10）", async () => {
    const fixture = await startFacilitator(["--verify", "invalid"]);
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fixture, proof.capability);
    const offer = await issue(rail);
    const verified = await rail.verify(offer, credentialFor(offer));
    expect(verified).toEqual({ isValid: false });
    expect(JSON.stringify(verified)).not.toContain("SECRET");
  });
});

describe("x402 受信 kind circle: 決済の結果の表（設計 §6）", () => {
  const unknownModes = ["unknown", "reject", "pending", "registration-required", "conflict", "bad-tx", "bad-network"] as const;
  for (const mode of unknownModes) {
    it(`settle ${mode} → unknown（要求 1 回、文字列を転送しない）`, async () => {
      const fixture = await startFacilitator(["--settle", mode]);
      const proof = createTestSellerProof({ network: ARC });
      const diagnostics: string[] = [];
      const rail = railOf(fixture, proof.capability, { onDiagnostic: (code) => diagnostics.push(code) });
      const offer = await issue(rail);
      const settled = await rail.settle(offer, credentialFor(offer));
      expect(settled).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
      expect(JSON.stringify(settled)).not.toContain("SECRET");
      expect((await callsOf(fixture))["settleCalls"]).toBe(1);
      expect(diagnostics).toEqual(mode === "registration-required" ? ["facilitator_trial_exhausted"] : []);
    });
  }

  it("settle の期限は wire + 10 秒: 0 秒の wire なら 11 秒の遅れで unknown、1 秒の遅れなら settled", async () => {
    const slow = await startFacilitator(["--settle-delay-ms", "11000"]);
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(slow, proof.capability, { maxTimeoutSeconds: 0 });
    const offer = await issue(rail);
    await expect(rail.settle(offer, credentialFor(offer))).rejects.toThrow();
    const quick = await startFacilitator(["--settle-delay-ms", "1000"]);
    const rail2 = railOf(quick, proof.capability, { maxTimeoutSeconds: 0 });
    const offer2 = await issue(rail2);
    expect((await rail2.settle(offer2, credentialFor(offer2))).outcome).toBe("settled");
  }, 30_000);

  it("transport: redirect を追わない（Location へ 0 接続）。verify・settle とも要求は失敗として扱う", async () => {
    const fixture = await startFacilitator(["--redirect"]);
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fixture, proof.capability);
    const offer = await issue(rail);
    await expect(rail.verify(offer, credentialFor(offer))).rejects.toThrow();
    await expect(rail.settle(offer, credentialFor(offer))).rejects.toThrow();
    const calls = await callsOf(fixture);
    expect(calls["elsewhereCalls"]).toBe(0);
    expect(calls["verifyCalls"]).toBe(1);
    expect(calls["settleCalls"]).toBe(1);
  });
});
