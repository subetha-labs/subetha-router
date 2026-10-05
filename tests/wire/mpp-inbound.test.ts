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

import { Challenge, Credential } from "mppx";

import { createMppInbound, MPP_INBOUND_SCHEME } from "../../src/adapters/inbound/mpp.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";

/** fixture は loopback なので許す（SSRF 防御 A の transport は必須）。 */
const LOOPBACK_TRANSPORT = createGuardedTransport({ allowLoopback: true, report: () => {} });

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const RECIPIENT = "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2";
const CURRENCY = "0x20c0000000000000000000000000000000000000";
const CHAIN_ID = 42_431;
const ROUTE_ID = "md-mpp-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`]
  .map(encodeURIComponent)
  .join("|");

function railOf(
  overrides: {
    readonly maxTimeoutSeconds?: number;
    readonly broadcastForTest?: (credential: string, options: unknown) => Promise<unknown>;
  } = {},
) {
  return createMppInbound({
    transport: LOOPBACK_TRANSPORT,
    ...(overrides.broadcastForTest === undefined
      ? {}
      : { broadcastForTest: overrides.broadcastForTest }),
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

/**
 * 発行 offer の challenge を**中に持つ** wire credential（公式の直列化。送金はしていないので hash は偽）。
 * 封筒だけでなく wire の中身がどの quote のものかを adapter が見るので、試験も本物の形で作る。
 */
function wireFor(offer: InboundOffer, hash = `0x${"ab".repeat(32)}`): string {
  const challenge = Challenge.deserialize(offer.extra["challenge"] as string);
  return Credential.serialize({ challenge, payload: { hash, type: "hash" } } as Parameters<typeof Credential.serialize>[0]);
}

/** 発行 offer に対応する「正しい形」の credential（署名内容までは作らない）。 */
function credentialFor(offer: InboundOffer, wire = wireFor(offer)): PaymentCredential {
  return {
    x402Version: 2,
    accepted: offer,
    payload: { challengeNonce: offer.extra.challengeNonce, credential: wire },
  };
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

  /**
   * **申告値そのものを固定する。** MPP の credential は送金済み tx の hash なので、
   * payer は先に broadcast しないと credential を作れない。`false` にすると
   * 「まだ払っていない」と人間に伝わり、承認前の不可逆支出を招く。
   */
  it("declares that funds move when the credential is built", async () => {
    const offer = await issue(railOf({ maxTimeoutSeconds: 600 }));
    expect(offer.extra["fundsMoveOnCredential"]).toBe(true);
  });

  it("offers exactly the amount it was asked for (no decimal rescaling)", async () => {
    // SDK は `parseUnits(amount, decimals)` を掛け、`decimals` 既定は 6。
    // 放置すると payer に 10000 と見せて HMAC には 10000000000 を焼き付ける。
    const offer = await issue(railOf());
    expect(offer.amount).toBe("10000");
  });

  it("binds the configured chain, not the SDK default", async () => {
    // `tempo.charge()` の factory に chainId を渡すと**黙って無視され** mainnet 4217 になる。
    // offer が名乗る network と束縛が食い違うと別チェーンの支払いになる。
    const offer = await issue(railOf());
    expect(offer.network).toBe(`eip155:${CHAIN_ID}`);
  });

  it("rejects a chain the SDK cannot resolve rather than guessing one", async () => {
    // 設定ミスを黙って既定チェーンに落とさない。
    const rail = createMppInbound({
    transport: LOOPBACK_TRANSPORT,
      secretKey: SECRET,
      recipient: RECIPIENT,
      currency: CURRENCY,
      chainId: 999_999,
      maxTimeoutSeconds: 600,
      realm: "router-test",
    });
    await expect(issue(rail)).rejects.toThrow(/No client configured with chainId/);
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

    it("rejects another quote's payment wrapped in this quote's envelope", async () => {
      // 同じ route の quote A・B。A の支払い（wire）を、B の封筒（nonce・accepted）に入れて出す。
      // 封筒だけを見る検査はすべて通る。止めるのは wire の中の challenge id の照合だけ。
      const rail = railOf();
      const [a, b] = await Promise.all([issue(rail), issue(rail)]);
      const wrapped = credentialFor(b, wireFor(a));
      expect(wrapped.payload.challengeNonce).toBe(b.extra.challengeNonce);
      expect(rail.preflight(b, wrapped, Date.now())).toEqual({ ok: false, reason: "nonce_mismatch" });
      // 正しい組み合わせは通る（検査が全拒否になっていないこと）。
      expect(rail.preflight(a, credentialFor(a), Date.now())).toEqual({ ok: true });
    });

    it("rejects a wire credential that cannot be read", async () => {
      const rail = railOf();
      const offer = await issue(rail);
      expect(rail.preflight(offer, credentialFor(offer, "not-a-real-credential"), Date.now())).toEqual({
        ok: false,
        reason: "nonce_mismatch",
      });
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

    it("maps every non-provable broadcast outcome to unknown via the real adapter", async () => {
      // **adapter を実際に呼ぶ。** 以前ここは adapter のロジックを写した
      // ローカル関数を比較するだけで、post-broadcast の分岐を全部 `rejected` に
      // 反転しても 14/14 緑のままだった（レビューで sabotage により指摘）。
      // SDK に任意のレシートを返させられないので、`broadcastCredential` を差し替える。
      const receipts: unknown[] = [
        { status: "failed", reference: "0xabc" },
        { status: "success" }, // 成功を名乗るが証跡が無い
        { status: "success", reference: "" },
        undefined,
        "not-an-object",
      ];
      for (const receipt of receipts) {
        const patched = railOf({ broadcastForTest: async () => receipt });
        const patchedOffer = await issue(patched);
        const result = await patched.settle(patchedOffer, credentialFor(patchedOffer));
        expect(result.outcome, `receipt=${JSON.stringify(receipt)}`).toBe("unknown");
      }
    });

    it("returns settled only with a real reference", async () => {
      const patched = railOf({
        broadcastForTest: async () => ({ status: "success", reference: "0xdeadbeef" }),
      });
      const offer = await issue(patched);
      expect(await patched.settle(offer, credentialFor(offer))).toEqual({
        outcome: "settled",
        txRef: "0xdeadbeef",
      });
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

  it("verify and settle refuse another quote's payment even when called directly", async () => {
    // core は必ず preflight を先に呼ぶが、adapter 単体でも同じ束縛を保つ。
    let broadcasts = 0;
    const rail = railOf({
      broadcastForTest: async () => {
        broadcasts += 1;
        return { status: "success", reference: "0xdeadbeef" };
      },
    });
    const [a, b] = await Promise.all([issue(rail), issue(rail)]);
    const wrapped = credentialFor(b, wireFor(a));
    expect(await rail.verify(b, wrapped)).toEqual({ isValid: false });
    expect(await rail.settle(b, wrapped)).toEqual({ outcome: "rejected", reason: "source_rejected" });
    // 受領処理（SDK の claim）に進んでいない。
    expect(broadcasts).toBe(0);
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
    transport: LOOPBACK_TRANSPORT,
        secretKey: "too-short",
        recipient: RECIPIENT,
        currency: CURRENCY,
        chainId: CHAIN_ID,
        maxTimeoutSeconds: 600,
      }),
    ).toThrow(/at least 32 bytes/);
  });
});
