/**
 * x402 受信 kind `circle`（Arc、Circle の Facilitator Service。multirail 設計 §4・§6。タスク T3）。**無課金**。
 * 相手は loopback の合成 facilitator（TLS、プロセス内。売り手証明を仕様どおり独立に検証する）。
 * transport は**本番と同じ方針**（loopback 不可・名前解決の fixture・`dialForTest` の差し替え）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS, CIRCLE_RESPONSE_MAX_BYTES, createX402Inbound } from "../../src/adapters/inbound/x402.js";
import { bodyHashOf, createSellerProofCapability, decodeSellerProofHeader, encodeSellerProofHeader } from "../../src/adapters/inbound/seller-proof.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential, SellerProofCapability } from "../../src/ports/inbound.js";
import { startCircleFacilitator, startSink, type CircleFacilitator } from "../fixtures/circle-facilitator.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { createTestSellerProof } from "../fixtures/seller-proof-capability.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const ROUTE_ID = "md-arc-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`].map(encodeURIComponent).join("|");
const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const HOST = "facilitator.provider.test";
const SINK_HOST = "other.test";

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function facilitator(): Promise<CircleFacilitator> {
  const started = await startCircleFacilitator(TLS, HOST);
  closers.push(started.close);
  return started;
}

/** 本番と同じ宛先の判定（loopback を許さない）＋ fixture への差し替え。 */
function transportTo(routes: Record<string, number>): GuardedTransport {
  return createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo(routes) });
}

function railOf(fx: CircleFacilitator, proof: SellerProofCapability, extra: Partial<Parameters<typeof createX402Inbound>[0]> = {}, routes: Record<string, number> = { [HOST]: fx.port }) {
  return createX402Inbound({
    kind: "circle",
    sellerProof: proof,
    transport: transportTo(routes),
    facilitatorUrl: `https://${HOST}`,
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

describe("x402 受信 kind circle: offer と時間", () => {
  it("offer に assetTransferMethod、wire の maxTimeoutSeconds 30、有効期間 120 秒（既定）。offerSeconds で有効期間だけ変わる", async () => {
    const fx = await facilitator();
    const proof = createTestSellerProof({ network: ARC });
    const now = Date.now();
    const offer = await railOf(fx, proof.capability).createOffer({ routeId: ROUTE_ID, amount: "10000", asset: ARC_USDC, network: ARC, routeBinding: ROUTE_BINDING, nowMs: now });
    expect(offer.extra["assetTransferMethod"]).toBe("eip3009");
    expect(offer.maxTimeoutSeconds).toBe(CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS);
    expect(offer.extra.expiresAt).toBe(Math.floor(now / 1000) + 120);
    expect(offer.extra["fundsMoveOnCredential"]).toBe(false);
    const longer = await railOf(fx, proof.capability, { offerSeconds: 600 }).createOffer({ routeId: ROUTE_ID, amount: "10000", asset: ARC_USDC, network: ARC, routeBinding: ROUTE_BINDING, nowMs: now });
    expect(longer.extra.expiresAt).toBe(Math.floor(now / 1000) + 600);
    expect(longer.maxTimeoutSeconds).toBe(CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS);
  });

  it("kind を省いた既存の adapter は今までどおり（assetTransferMethod 無し、有効期間 = wire = maxTimeoutSeconds）", async () => {
    const fx = await facilitator();
    const rail = createX402Inbound({ transport: transportTo({ [HOST]: fx.port }), facilitatorUrl: `https://${HOST}`, payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405", maxTimeoutSeconds: 600 });
    const now = Date.now();
    const offer = await rail.createOffer({ routeId: ROUTE_ID, amount: "10000", asset: ARC_USDC, network: "eip155:84532", routeBinding: ROUTE_BINDING, nowMs: now });
    expect(offer.extra["assetTransferMethod"]).toBeUndefined();
    expect(offer.maxTimeoutSeconds).toBe(600);
    expect(offer.extra.expiresAt).toBe(Math.floor(now / 1000) + 600);
  });

  it("kind circle は sellerProof 無しでは作れない", async () => {
    const fx = await facilitator();
    expect(() => createX402Inbound({ kind: "circle", transport: transportTo({ [HOST]: fx.port }), facilitatorUrl: `https://${HOST}`, payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405" })).toThrow(/seller proof/);
  });

  it("preflight: assetTransferMethod を落とした・変えた accepted は offer_mismatch", async () => {
    const fx = await facilitator();
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fx, proof.capability);
    const offer = await issue(rail);
    expect(rail.preflight(offer, credentialFor(offer), Date.now())).toEqual({ ok: true });
    const { assetTransferMethod: _dropped, ...withoutMethod } = offer.extra as Record<string, unknown>;
    expect(rail.preflight(offer, credentialFor(offer, { extra: withoutMethod }), Date.now())).toEqual({ ok: false, reason: "offer_mismatch" });
    expect(rail.preflight(offer, credentialFor(offer, { extra: { ...offer.extra, assetTransferMethod: "permit2" } }), Date.now())).toEqual({ ok: false, reason: "offer_mismatch" });
  });
});

describe("x402 受信 kind circle: 売り手証明", () => {
  it("verify と settle に証明が付き、fixture が仕様どおりに検証して通る。purpose は endpoint と同じ、nonce は要求ごとに違う", async () => {
    const fx = await facilitator();
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fx, proof.capability);
    const offer = await issue(rail);
    const credential = credentialFor(offer);
    expect(await rail.verify(offer, credential)).toEqual({ isValid: true });
    const afterVerify = fx.seen.lastProof!;
    const settled = await rail.settle(offer, credential);
    expect(settled.outcome).toBe("settled");
    expect((settled as { txRef: string }).txRef).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fx.seen.proofFailures).toEqual([]);
    expect(fx.seen.verifyCalls).toBe(1);
    expect(fx.seen.settleCalls).toBe(1);
    const afterSettle = fx.seen.lastProof!;
    expect(afterVerify["nonce"]).not.toBe(afterSettle["nonce"]);
    expect(afterSettle["payTo"]).toBe(proof.address);
    expect(afterSettle["network"]).toBe(ARC);
    expect(afterSettle["version"]).toBe(1);
    const requirements = fx.seen.lastRequirements as Record<string, unknown>;
    expect((requirements["extra"] as Record<string, unknown>)["assetTransferMethod"]).toBe("eip3009");
    expect(requirements["maxTimeoutSeconds"]).toBe(CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS);
    expect(JSON.stringify(settled)).not.toContain("SECRET");
  });

  it("証明は送った bytes そのものに束縛される: 署名の間に offer の中身が変えられても、hash した文字列が送られる", async () => {
    const fx = await facilitator();
    const account = privateKeyToAccount(generatePrivateKey());
    let hashed: string | undefined;
    const sneaky = createSellerProofCapability({
      network: ARC,
      address: account.address,
      signSellerRequest: async (typedData) => {
        hashed = typedData.message.bodyHash;
        return account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message });
      },
    });
    const rail = railOf(fx, sneaky);
    const offer = await issue(rail);
    const credential = credentialFor(offer);
    // payload を後から変える細工（toJSON が呼ばれるたびに違う値を返す）。1 度だけ直列化されるなら、hash と送信は同じ文字列。
    let calls = 0;
    (credential.payload as Record<string, unknown>)["marker"] = { toJSON: () => `m${(calls += 1)}` };
    expect(await rail.verify(offer, credential)).toEqual({ isValid: true });
    expect(fx.seen.proofFailures).toEqual([]);
    expect(bodyHashOf(fx.seen.lastRawBody!)).toBe(hashed);
    expect(calls).toBe(1);
  });

  it("fixture は壊れた証明を 401 で拒む: 無し・別の鍵（payTo は正しい）・bodyHash 違い・purpose 入れ替え・未来の issuedAt・失効・寿命 301 秒・nonce 再使用・network 改変・version 違い・base64url でない", async () => {
    const fx = await facilitator();
    const key = generatePrivateKey();
    const proof = createTestSellerProof({ network: ARC, privateKey: key });
    const rail = railOf(fx, proof.capability);
    const offer = await issue(rail);
    const body = JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, scheme: "exact", network: ARC, accepted: offer, payload: { signature: "0x" } }, paymentRequirements: { ...offer } });
    const hash = bodyHashOf(body);
    const transport = transportTo({ [HOST]: fx.port });
    const post = async (path: string, header: string | undefined, text = body): Promise<{ status: number; reason: string | undefined }> => {
      const response = await transport.fetch(`https://${HOST}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(header === undefined ? {} : { "facilitator-seller-proof": header }) }, body: text }, { operation: "test" });
      const json = (await response.json()) as Record<string, unknown>;
      return { status: response.status, reason: json["reason"] as string | undefined };
    };
    const good = await proof.capability.proofFor("verify", hash);
    expect((await post("/verify", good)).status).toBe(200);
    expect(await post("/verify", undefined)).toEqual({ status: 401, reason: "proof_missing" });
    // 別の鍵で署名し、封筒の payTo だけ正しい値に差し替える → 署名者が違う。
    const other = createTestSellerProof({ network: ARC });
    const forged = decodeSellerProofHeader(await other.capability.proofFor("verify", hash))!;
    expect(await post("/verify", encodeSellerProofHeader({ ...forged, payTo: proof.address }))).toEqual({ status: 401, reason: "signer_mismatch" });
    expect(await post("/verify", await proof.capability.proofFor("verify", hash), body + " ")).toEqual({ status: 401, reason: "signer_mismatch" });
    expect(await post("/settle", await proof.capability.proofFor("verify", hash))).toEqual({ status: 401, reason: "signer_mismatch" });
    // 同じ鍵で時計だけずらす（署名は有効）。
    const future = createTestSellerProof({ network: ARC, privateKey: key, now: () => Date.now() + 120_000 });
    expect(await post("/verify", await future.capability.proofFor("verify", hash))).toEqual({ status: 401, reason: "issued_in_future" });
    const stale = createTestSellerProof({ network: ARC, privateKey: key, now: () => Date.now() - 600_000 });
    expect(await post("/verify", await stale.capability.proofFor("verify", hash))).toEqual({ status: 401, reason: "expired" });
    const envelope = decodeSellerProofHeader(good)!;
    expect((await post("/verify", encodeSellerProofHeader({ ...envelope, expiresAt: envelope.issuedAt + 301 }))).reason).toBe("lifetime_too_long");
    expect((await post("/verify", good)).reason).toBe("nonce_reused");
    expect((await post("/verify", encodeSellerProofHeader({ ...envelope, nonce: `0x${"11".repeat(32)}`, network: "eip155:84532" }))).reason).toBe("network_mismatch");
    expect((await post("/verify", encodeSellerProofHeader({ ...envelope, nonce: `0x${"22".repeat(32)}`, version: 2 }))).reason).toBe("proof_version");
    expect((await post("/verify", `${good}==`)).reason).toBe("proof_not_base64url");
  });

  it("fixture が証明を拒む（401）と、adapter は verify を false、settle を unknown にする（文字列は転送しない）", async () => {
    const fx = await facilitator();
    fx.state.rejectProofs = true;
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fx, proof.capability);
    const offer = await issue(rail);
    expect(await rail.verify(offer, credentialFor(offer))).toEqual({ isValid: false });
    const settled = await rail.settle(offer, credentialFor(offer));
    expect(settled).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(JSON.stringify(settled)).not.toContain("rejected_by_fixture");
  });

  it("能力が拒むと要求を出さない: verify は isValid false、settle は rejected（接続 0）", async () => {
    const fx = await facilitator();
    const refusing: SellerProofCapability = { network: ARC, address: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405", proofFor: async () => { throw new Error("no"); } };
    const rail = railOf(fx, refusing);
    const offer = await issue(rail);
    expect(await rail.verify(offer, credentialFor(offer))).toEqual({ isValid: false });
    expect(await rail.settle(offer, credentialFor(offer))).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(fx.seen.connections).toBe(0);
    expect(fx.seen.verifyCalls).toBe(0);
    expect(fx.seen.settleCalls).toBe(0);
  });

  it("verify が false なら理由の文字列を転送しない（FR-10）", async () => {
    const fx = await facilitator();
    fx.state.verify = "invalid";
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fx, proof.capability);
    const offer = await issue(rail);
    const verified = await rail.verify(offer, credentialFor(offer));
    expect(verified).toEqual({ isValid: false });
    expect(JSON.stringify(verified)).not.toContain("SECRET");
  });
});

describe("x402 受信 kind circle: 決済の結果の表（設計 §6）", () => {
  const unknownModes = ["unknown", "reject", "pending", "registration-required", "conflict", "bad-tx", "no-tx", "bad-network", "malformed", "huge", "huge-chunked"] as const;
  for (const mode of unknownModes) {
    it(`settle ${mode} → unknown（要求 1 回、文字列を転送しない）`, async () => {
      const fx = await facilitator();
      fx.state.settle = mode;
      const proof = createTestSellerProof({ network: ARC });
      const diagnostics: string[] = [];
      const rail = railOf(fx, proof.capability, { onDiagnostic: (code) => diagnostics.push(code) });
      const offer = await issue(rail);
      const settled = await rail.settle(offer, credentialFor(offer));
      expect(settled).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
      expect(JSON.stringify(settled)).not.toContain("SECRET");
      expect(fx.seen.settleCalls).toBe(1);
      expect(diagnostics).toEqual(mode === "registration-required" ? ["facilitator_trial_exhausted"] : []);
    });
  }

  it("settle の応答が失われる（接続が切れる）と例外（core が unknown にする）。要求は 1 回", async () => {
    const fx = await facilitator();
    fx.state.settle = "drop";
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fx, proof.capability);
    const offer = await issue(rail);
    await expect(rail.settle(offer, credentialFor(offer))).rejects.toThrow();
    expect(fx.seen.settleCalls).toBe(1);
  });

  it("成功の判定は success・network・transaction の形だけ: payer／amount／extensions が無くても settled、応答の上限は 64 KiB", async () => {
    const fx = await facilitator();
    fx.state.settle = "minimal";
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fx, proof.capability);
    const offer = await issue(rail);
    expect((await rail.settle(offer, credentialFor(offer))).outcome).toBe("settled");
    expect(CIRCLE_RESPONSE_MAX_BYTES).toBe(64 * 1024);
    // ちょうど 64 KiB は通る（上限は「超えたら」）。
    const exact = await facilitator();
    exact.state.settle = "exact-64k";
    const rail2 = railOf(exact, proof.capability);
    const offer2 = await issue(rail2);
    expect((await rail2.settle(offer2, credentialFor(offer2))).outcome).toBe("settled");
    expect(Buffer.byteLength(exact.seen.lastRawBody ?? "")).toBeGreaterThan(0);
  });

  it("settle の期限は wire + 10 秒: wire 5 なら 11 秒の遅れでも settled、wire 0 なら 11 秒で期限切れ（1 秒は settled）", async () => {
    const proof = createTestSellerProof({ network: ARC });
    const slow = await facilitator();
    slow.state.settleDelayMs = 11_000;
    const wide = railOf(slow, proof.capability, { maxTimeoutSeconds: 5 });
    const offer = await issue(wide);
    expect(offer.maxTimeoutSeconds).toBe(5);
    expect((await wide.settle(offer, credentialFor(offer))).outcome).toBe("settled");
    const tight = railOf(slow, proof.capability, { maxTimeoutSeconds: 0 });
    const offer2 = await issue(tight);
    await expect(tight.settle(offer2, credentialFor(offer2))).rejects.toThrow();
    const quick = await facilitator();
    quick.state.settleDelayMs = 1_000;
    const rail3 = railOf(quick, proof.capability, { maxTimeoutSeconds: 0 });
    const offer3 = await issue(rail3);
    expect((await rail3.settle(offer3, credentialFor(offer3))).outcome).toBe("settled");
  }, 60_000);

  it("transport（本番の方針）: redirect を追わない（別の listener へ 0 接続）、loopback の名前には届かない", async () => {
    const fx = await facilitator();
    const sink = await startSink(TLS);
    closers.push(sink.close);
    fx.state.redirectTo = `https://${SINK_HOST}/elsewhere`;
    const proof = createTestSellerProof({ network: ARC });
    const rail = railOf(fx, proof.capability, {}, { [HOST]: fx.port, [SINK_HOST]: sink.port });
    const offer = await issue(rail);
    await expect(rail.verify(offer, credentialFor(offer))).rejects.toThrow();
    await expect(rail.settle(offer, credentialFor(offer))).rejects.toThrow();
    expect(sink.connections()).toBe(0);
    expect(fx.seen.verifyCalls).toBe(1);
    expect(fx.seen.settleCalls).toBe(1);
    // 名前が loopback に解決する facilitator には接続しない（宛先の判定は本番と同じ）。
    const internal = createX402Inbound({
      kind: "circle",
      sellerProof: proof.capability,
      transport: createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup({ [HOST]: ["127.0.0.1"] }), dialForTest: dialTo({ [HOST]: fx.port }) }),
      facilitatorUrl: `https://${HOST}`,
      payTo: proof.address,
    });
    const before = fx.seen.connections;
    await expect(internal.verify(offer, credentialFor(offer))).rejects.toMatchObject({ code: "destination_blocked" });
    expect(fx.seen.connections).toBe(before);
  });
});
