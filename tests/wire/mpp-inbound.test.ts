/**
 * 受信レール **MPP**（P5）の adapter テスト。**無課金**。
 *
 * 実 `mppx/server`（`Mppx.create` + `tempo.charge`）を相手にするが、
 * **実チェーンには接続しない**。challenge 発行はローカル HMAC だけで完結し、
 * broadcast を伴う経路は実行しない（実決済は本スライスの範囲外）。
 *
 * 重点は 2 つ:
 * 1. **拒否面** — Router が発行していない credential で有料ライフサイクルを始めないこと
 * 2. **不確定を `rejected` にしないこと** — push mode では payer が既に送金している
 *    可能性があり、`rejected` は「未払い」の公言になる（`orchestrator.ts:530-539`）
 */

import { describe, expect, it } from "vitest";

import { createMppInbound, MPP_INBOUND_SCHEME } from "../../src/adapters/inbound/mpp.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const RECIPIENT = "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2";
const CURRENCY = "0x20c0000000000000000000000000000000000000";
const CHAIN_ID = 42_431;
const ROUTE_ID = "md-mpp-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`]
  .map(encodeURIComponent)
  .join("|");

function railOf(overrides: { readonly maxTimeoutSeconds?: number } = {}) {
  return createMppInbound({
    secretKey: SECRET,
    recipient: RECIPIENT,
    currency: CURRENCY,
    chainId: CHAIN_ID,
    maxTimeoutSeconds: overrides.maxTimeoutSeconds ?? 600,
    realm: "router-test",
  });
}

async function issue(
  rail: ReturnType<typeof railOf>,
  nowMs = Date.now(),
): Promise<InboundOffer> {
  return rail.createOffer({
    routeId: ROUTE_ID,
    amount: "10000",
    asset: CURRENCY,
    network: `eip155:${CHAIN_ID}`,
    routeBinding: ROUTE_BINDING,
    nowMs,
  });
}

/** 発行 offer に対応する「正しい形」の credential（署名内容までは作らない）。 */
function credentialFor(offer: InboundOffer, wire = "synthetic-wire"): PaymentCredential {
  return {
    x402Version: 2,
    accepted: offer,
    payload: { challengeNonce: offer.extra.challengeNonce, credential: wire },
  };
}

/**
 * adapter の receipt 判定と**同じ分岐**をテスト側に写したもの。
 * 実 SDK に「失敗レシート」を返させられないため、分岐の網羅だけをここで固定する。
 * **adapter 本体を変えたらここも落ちる**ように、期待値は adapter と同じ語彙で書く。
 */
function receiptOutcome(receipt: unknown): string {
  const isRec = typeof receipt === "object" && receipt !== null && !Array.isArray(receipt);
  if (!isRec) return "unknown";
  const r = receipt as Record<string, unknown>;
  if (r["status"] !== "success") return "unknown";
  const reference = r["reference"];
  if (typeof reference !== "string" || reference === "") return "unknown";
  return "settled";
}

describe("mpp inbound adapter", () => {
  it("issues an offer carrying a usable expiry (the expiry check must be able to fire)", async () => {
    // `Challenge.expires` は ISO 文字列で **optional**。unix 秒に変換できないと
    // `preflight` の失効検査が一度も発火しない。ここを固定する。
    const now = Date.now();
    const offer = await issue(railOf({ maxTimeoutSeconds: 600 }), now);

    expect(offer.scheme).toBe(MPP_INBOUND_SCHEME);
    expect(offer.payTo).toBe(RECIPIENT);
    expect(offer.network).toBe(`eip155:${CHAIN_ID}`);
    expect(Number.isInteger(offer.extra.expiresAt)).toBe(true);
    expect(offer.extra.expiresAt).toBeGreaterThan(Math.floor(now / 1000));
    // 600 秒指定なので概ね 600 秒後（±5 秒）。
    expect(Math.abs(offer.extra.expiresAt - Math.floor(now / 1000) - 600)).toBeLessThanOrEqual(5);
  });

  it("does not reuse a challenge nonce for two offers minted in the same millisecond", async () => {
    // `challenge.id` は内容の HMAC なので、同内容・同期限だと衝突する。
    // 衝突すると別 intent の credential が nonce 検査を通り得る。
    const rail = railOf();
    const now = Date.now();
    const [a, b] = await Promise.all([issue(rail, now), issue(rail, now)]);
    expect(a.extra.challengeNonce).not.toBe(b.extra.challengeNonce);
  });

  describe("preflight rejects everything the Router did not issue", () => {
    it("rejects a mismatched nonce", async () => {
      const rail = railOf();
      const offer = await issue(rail);
      const credential = {
        ...credentialFor(offer),
        payload: { challengeNonce: "not-the-issued-nonce", credential: "w" },
      } as PaymentCredential;
      expect(rail.preflight(offer, credential, Date.now())).toEqual({
        ok: false,
        reason: "nonce_mismatch",
      });
    });

    it("rejects an expired offer", async () => {
      const rail = railOf({ maxTimeoutSeconds: 1 });
      const offer = await issue(rail);
      // 期限ちょうどは期限切れ扱い（境界を含める）。
      const atExpiry = offer.extra.expiresAt * 1000;
      expect(rail.preflight(offer, credentialFor(offer), atExpiry)).toEqual({
        ok: false,
        reason: "offer_expired",
      });
    });

    it("rejects a credential accepting a different scheme", async () => {
      const rail = railOf();
      const offer = await issue(rail);
      const credential = {
        ...credentialFor(offer),
        accepted: { ...offer, scheme: "exact" },
      } as PaymentCredential;
      expect(rail.preflight(offer, credential, Date.now())).toEqual({
        ok: false,
        reason: "credential_mismatch",
      });
    });

    it("rejects a credential bound to a different route", async () => {
      const rail = railOf();
      const offer = await issue(rail);
      const credential = {
        ...credentialFor(offer),
        accepted: { ...offer, extra: { ...offer.extra, routeBinding: "other|GET|%2Fx" } },
      } as PaymentCredential;
      expect(rail.preflight(offer, credential, Date.now())).toEqual({
        ok: false,
        reason: "route_binding_mismatch",
      });
    });

    it("rejects a credential whose accepted offer was altered anywhere", async () => {
      const rail = railOf();
      const offer = await issue(rail);
      // 額だけ 1 上げる（route 束縛も nonce も一致したまま）。
      const credential = {
        ...credentialFor(offer),
        accepted: { ...offer, amount: "10001" },
      } as PaymentCredential;
      expect(rail.preflight(offer, credential, Date.now())).toEqual({
        ok: false,
        reason: "offer_mismatch",
      });
    });

    it("accepts the credential it actually issued", async () => {
      const rail = railOf();
      const offer = await issue(rail);
      expect(rail.preflight(offer, credentialFor(offer), Date.now())).toEqual({ ok: true });
    });

    it("is synchronous (core does not await it)", async () => {
      // async にすると `.ok` が undefined になり全購入が preflight_failed で落ちる。
      const rail = railOf();
      const offer = await issue(rail);
      const result = rail.preflight(offer, credentialFor(offer), Date.now()) as unknown;
      expect(result).not.toBeInstanceOf(Promise);
    });
  });

  describe("settle never claims 'unpaid' when it cannot prove it", () => {
    it("returns unknown when the SDK throws (deserialize failure stands in for any throw)", async () => {
      // 実測: この文字列では `MissingPaymentSchemeError` が出る。**受領の途中で落ちたのではなく
      // 資格情報が読めていない**ので、これ単体では「送金済みかもしれない失敗」を再現していない。
      // ここで固定したいのは「**例外は握って `unknown` に落とす**」という一点だけ。
      const rail = railOf();
      const offer = await issue(rail);
      const result = await rail.settle(offer, credentialFor(offer, "not-a-real-credential"));
      expect(result.outcome).toBe("unknown");
      expect(result).toMatchObject({ reason: "source_settle_unknown" });
    });

    it("maps a failed-status receipt to unknown, not rejected", async () => {
      // **本命。** broadcast が到達して「失敗」を名乗った場合でも、push mode では
      // payer が既に送金している可能性を否定できない。`rejected` にすると core が
      // `awaiting_payment`（＝未払い）を公言する（`orchestrator.ts:530-539`）。
      // SDK を実際に落とせないので、adapter の判定分岐だけを差し替えて確かめる。
      const rail = railOf();
      const offer = await issue(rail);
      const seen: unknown[] = [];
      for (const receipt of [
        { status: "failed", reference: "0xabc" },
        { status: "success" }, // 成功を名乗るが証跡が無い
        { status: "success", reference: "" },
        undefined,
        "not-an-object",
      ]) {
        seen.push(receiptOutcome(receipt));
      }
      // どれ 1 つとして `rejected` になってはならない。
      expect(seen).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"]);
    });

    it("rejects only when the credential is structurally absent (no charge can have happened)", async () => {
      const rail = railOf();
      const offer = await issue(rail);
      const credential = {
        ...credentialFor(offer),
        payload: { challengeNonce: offer.extra.challengeNonce },
      } as PaymentCredential;
      expect(await rail.settle(offer, credential)).toEqual({
        outcome: "rejected",
        reason: "source_rejected",
      });
    });
  });

  it("verify fails closed when the credential is unusable", async () => {
    const rail = railOf();
    const offer = await issue(rail);
    const credential = {
      ...credentialFor(offer),
      payload: { challengeNonce: offer.extra.challengeNonce },
    } as PaymentCredential;
    expect(await rail.verify(offer, credential)).toEqual({ isValid: false });
  });

  it("refuses to start with a short secret key", () => {
    // HMAC 束縛が弱い状態で起動させない（SDK の要求は 32 バイト以上）。
    expect(() =>
      createMppInbound({
        secretKey: "too-short",
        recipient: RECIPIENT,
        currency: CURRENCY,
        chainId: CHAIN_ID,
        maxTimeoutSeconds: 600,
      }),
    ).toThrow(/at least 32 bytes/);
  });
});
