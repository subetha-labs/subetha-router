/**
 * `InboundPayer` の**非支出契約**を固定する。**無課金・実鍵なし**。
 *
 * なぜ必要か: `src/mcp/tools.ts` は `credentialFor()` を**承認の検査より前に**呼ぶ
 * （承認と quote 束縛の検査は `client.execute()` の中で後から走る）。
 * したがって**支出する payer を注入すると、人間の承認前に資金が出る**。
 * 失敗時の `"No payment was started."` が真であることも、この契約が前提。
 *
 * ここでは注入される実装（`tools/x402-payer.ts`）が
 * **署名しかしない**ことを、ネットワークを一切与えずに固定する。
 * broadcast する実装なら RPC を要求して失敗するはずなので、
 * 「RPC 無しで credential が作れる」こと自体が非支出性の証拠になる。
 */

import { describe, expect, it } from "vitest";

import { createX402Payer } from "../../tools/x402-payer.js";

/**
 * **Anvil / Hardhat の公知の開発鍵（account #1）**。世界中の README に載っている値で、
 * 秘密ではない。ここでは「署名だけなら RPC も資金も不要」を示すためだけに使う。
 * 実資金を入れてはならない。
 */
const THROWAWAY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const offer = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
  maxTimeoutSeconds: 60,
  extra: {
    name: "USDC",
    version: "2",
    challengeNonce: `0x${"11".repeat(32)}`,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    routeBinding: "r1|GET|%2Fv1%2Froutes%2Fr1%2Fresource",
    fundsMoveOnCredential: false,
  },
} as const;

describe("InboundPayer must only sign, never spend", () => {
  it("builds a credential with no RPC and no chain access", async () => {
    const payer = createX402Payer(THROWAWAY);
    // RPC も provider も渡していない。broadcast する実装ならここで失敗する。
    const credential = await payer.credentialFor(offer as never, 84532);

    expect(typeof credential).toBe("string");
    expect(credential.length).toBeGreaterThan(0);
    // base64 の JSON で、署名だけを運ぶ（送金の痕跡＝tx hash を含まない）。
    const decoded = JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    const payload = decoded["payload"] as Record<string, unknown>;
    expect(payload["signature"]).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(payload).not.toHaveProperty("burnTxHash");
    expect(payload).not.toHaveProperty("txHash");
  });

  it("refuses to sign an offer without the EIP-712 domain rather than guessing one", async () => {
    const payer = createX402Payer(THROWAWAY);
    const noDomain = { ...offer, extra: { ...offer.extra, name: undefined } };

    await expect(payer.credentialFor(noDomain as never, 84532)).rejects.toThrow();
  });
});
