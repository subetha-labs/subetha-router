/**
 * 受信レール x402（P4 / T8）の adapter 単体テスト。**無課金**。
 * 相手は別プロセスの合成 facilitator（loopback）で、実鍵・実署名・実決済は無い。
 *
 * 重点は**拒否面**: Router 発行分と違う credential で有料ライフサイクルを開始しないこと。
 */

import { afterEach, describe, expect, it } from "vitest";

import { createX402Inbound, X402_INBOUND_SCHEME } from "../../src/adapters/inbound/x402.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";

const ROUTE_ID = "md-x402-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`]
  .map(encodeURIComponent)
  .join("|");
const PAY_TO = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";

const running: Listening[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
});

async function startFacilitator(args: readonly string[] = []): Promise<Listening> {
  const fixture = await startListening("tests/fixtures/x402-inbound-facilitator.ts", [
    "--port",
    "0",
    ...args,
  ]);
  running.push(fixture);
  return fixture;
}

function railOf(fixture: Listening) {
  return createX402Inbound({ transport: createGuardedTransport({ allowLoopback: true, report: () => {} }), facilitatorUrl: fixture.baseUrl, payTo: PAY_TO });
}

async function issue(fixture: Listening): Promise<InboundOffer> {
  return await railOf(fixture).createOffer({
    routeId: ROUTE_ID,
    amount: "10000",
    asset: ASSET,
    network: NETWORK,
    routeBinding: ROUTE_BINDING,
    nowMs: Date.now(),
  });
}

/** payer が返す credential。`accepted` は既定で Router 発行 offer と同一。 */
function credentialFor(
  offer: InboundOffer,
  accepted: Record<string, unknown> = {},
): PaymentCredential {
  return {
    x402Version: 2,
    accepted: { ...offer, ...accepted } as InboundOffer,
    payload: { challengeNonce: offer.extra.challengeNonce, signature: "0xdeadbeef" },
  };
}

async function callsOf(fixture: Listening): Promise<Record<string, unknown>> {
  return (await (await fetch(`${fixture.baseUrl}/calls`)).json()) as Record<string, unknown>;
}

describe("x402 受信レール", () => {
  it("Router が payee として自分で offer を発行する", async () => {
    const fixture = await startFacilitator();
    const offer = await issue(fixture);

    expect(offer.scheme).toBe(X402_INBOUND_SCHEME);
    expect(offer.payTo).toBe(PAY_TO);
    expect(offer.network).toBe(NETWORK);
    expect(offer.asset).toBe(ASSET);
    expect(offer.amount).toBe("10000");
    // nonce は CSPRNG 由来の 32 バイト。
    expect(offer.extra.challengeNonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(offer.extra.routeBinding).toBe(ROUTE_BINDING);
    expect(offer.extra.expiresAt * 1000).toBeGreaterThan(Date.now());
  });

  it("発行するたびに nonce が変わる（再利用しない）", async () => {
    const fixture = await startFacilitator();
    const a = await issue(fixture);
    const b = await issue(fixture);
    expect(a.extra.challengeNonce).not.toBe(b.extra.challengeNonce);
  });

  it("正常系: preflight を通り verify → settle で txRef が返る", async () => {
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    const credential = credentialFor(offer);

    expect(rail.preflight(offer, credential, Date.now())).toEqual({ ok: true });
    await expect(rail.verify(offer, credential)).resolves.toEqual({ isValid: true });
    const settled = await rail.settle(offer, credential);
    expect(settled.outcome).toBe("settled");
    if (settled.outcome === "settled") {
      expect(settled.txRef).toMatch(/^synthetic-inbound-/);
    }
  });

  it("【T8-07】accepted のトップレベル未知キー（resource / extensions）は許容する", async () => {
    // 標準の x402 クライアントはこれらを付ける。弾くとデモが動かない。
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    const credential = credentialFor(offer, {
      resource: { url: "https://example.test/v1/eth/snapshot" },
      extensions: { anything: true },
    });

    expect(rail.preflight(offer, credential, Date.now())).toEqual({ ok: true });
  });

  it("【security】accepted.extra の未知キーは拒否する（署名ドメインを差し込ませない）", async () => {
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    // `exact` では extra.name / extra.version が EIP-712 domain を決める。
    const credential = credentialFor(offer, {
      extra: { ...offer.extra, name: "EvilUSD", version: "9" },
    });

    expect(rail.preflight(offer, credential, Date.now())).toEqual({
      ok: false,
      reason: "offer_mismatch",
    });
  });

  /**
   * 資金移動タイミングの申告は **Router が発行する**。payer がこれを裏返せると
   * 「まだ払っていない」と人間に誤って伝わり、承認前の不可逆支出を招く。
   * 完全一致検査で弾かれることを固定する（型を変える改竄も含む）。
   */
  it.each([
    ["flipped to true", true],
    ["stringified", "false"],
    ["nulled", null],
    ["removed", undefined],
  ])(
    "【security】accepted.extra.fundsMoveOnCredential の改竄（%s）は拒否する",
    async (_label, value) => {
      const fixture = await startFacilitator();
      const rail = railOf(fixture);
      const offer = await issue(fixture);
      const extra: Record<string, unknown> = { ...offer.extra };
      if (value === undefined) {
        delete extra["fundsMoveOnCredential"];
      } else {
        extra["fundsMoveOnCredential"] = value;
      }

      expect(rail.preflight(offer, credentialFor(offer, { extra }), Date.now())).toEqual({
        ok: false,
        reason: "offer_mismatch",
      });
    },
  );

  /** 正直な payer（発行 offer をそのまま写す）は通る＝ allowlist に入っている。 */
  it("発行 offer をそのまま写した accepted は通る（申告キーが allowlist にある）", async () => {
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);

    expect(offer.extra["fundsMoveOnCredential"]).toBe(false);
    expect(rail.preflight(offer, credentialFor(offer), Date.now())).toEqual({ ok: true });
  });

  it.each([
    ["amount", { amount: "999999" }],
    ["payTo", { payTo: "0x000000000000000000000000000000000000dead" }],
    ["asset", { asset: "0x000000000000000000000000000000000000beef" }],
    ["network", { network: "eip155:1" }],
    ["scheme", { scheme: "not-exact" }],
    ["maxTimeoutSeconds", { maxTimeoutSeconds: 99999 }],
  ])("Router 発行分の改竄（%s）は preflight で拒否する", async (_label, tamper) => {
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    const result = rail.preflight(offer, credentialFor(offer, tamper), Date.now());

    expect(result.ok).toBe(false);
  });

  it("nonce 不一致は nonce_mismatch", async () => {
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    const credential: PaymentCredential = {
      ...credentialFor(offer),
      payload: { challengeNonce: `0x${"11".repeat(32)}` },
    };

    expect(rail.preflight(offer, credential, Date.now())).toEqual({
      ok: false,
      reason: "nonce_mismatch",
    });
  });

  it("期限切れは offer_expired", async () => {
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    const afterExpiry = (offer.extra.expiresAt + 1) * 1000;

    expect(rail.preflight(offer, credentialFor(offer), afterExpiry)).toEqual({
      ok: false,
      reason: "offer_expired",
    });
  });

  it("束縛不一致は route_binding_mismatch", async () => {
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    const credential = credentialFor(offer, {
      extra: { ...offer.extra, routeBinding: "other|GET|%2Fx" },
    });

    expect(rail.preflight(offer, credential, Date.now())).toEqual({
      ok: false,
      reason: "route_binding_mismatch",
    });
  });

  it("【security】facilitator へ送る requirements は Router 発行の offer から組む", async () => {
    // payer が accepted を差し替えても、facilitator に届くのは Router の条件。
    const fixture = await startFacilitator();
    const rail = railOf(fixture);
    const offer = await issue(fixture);
    const credential = credentialFor(offer, { amount: "1", payTo: "0x00000000000000000000000000000000000000ff" });

    await rail.verify(offer, credential);
    const calls = await callsOf(fixture);
    const requirements = calls["lastRequirements"] as Record<string, unknown>;
    expect(requirements["amount"]).toBe("10000");
    expect(requirements["payTo"]).toBe(PAY_TO);
    // payloadPayload 側には scheme / network が補われている（実 facilitator が要求する）。
    const payload = calls["lastPayload"] as Record<string, unknown>;
    expect(payload["scheme"]).toBe(X402_INBOUND_SCHEME);
    expect(payload["network"]).toBe(NETWORK);
  });

  it("【security】facilitator の内部例外を応答に出さない", async () => {
    const fixture = await startFacilitator(["--leak"]);
    const rail = railOf(fixture);
    const offer = await issue(fixture);

    const verified = await rail.verify(offer, credentialFor(offer));
    // 500 + 内部例外でも、返るのは boolean だけ。
    expect(verified).toEqual({ isValid: false });
    expect(JSON.stringify(verified)).not.toContain("SECRET_INTERNAL_DETAIL");
  });

  it("settle が 5xx なら unknown（課金有無を断定しない）", async () => {
    const fixture = await startFacilitator(["--settle", "unknown"]);
    const rail = railOf(fixture);
    const offer = await issue(fixture);

    const settled = await rail.settle(offer, credentialFor(offer));
    expect(settled.outcome).toBe("unknown");
    expect(JSON.stringify(settled)).not.toContain("SECRET_INTERNAL_DETAIL");
  });

  it("settle が success:false なら rejected", async () => {
    const fixture = await startFacilitator(["--settle", "reject"]);
    const rail = railOf(fixture);
    const offer = await issue(fixture);

    expect((await rail.settle(offer, credentialFor(offer))).outcome).toBe("rejected");
  });

  it("verify が false なら settle しない判断材料になる", async () => {
    const fixture = await startFacilitator(["--verify", "invalid"]);
    const rail = railOf(fixture);
    const offer = await issue(fixture);

    expect(await rail.verify(offer, credentialFor(offer))).toEqual({ isValid: false });
    const calls = await callsOf(fixture);
    expect(calls["settleCalls"]).toBe(0);
  });
});
