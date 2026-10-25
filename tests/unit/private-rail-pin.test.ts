/**
 * 増分 v1.5（proxy 型）T-X4: 私的 rail の探りが、渡された固定の宛先の transport で送る（`docs/zktls-router-proxy-design.md` §4.2）。
 * 渡されなければ rail を作ったときの transport で今と同じに送る。transport は spy（実 TCP なし）。
 */
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, test } from "vitest";

import { createPrivateMppRail } from "../../src/adapters/outbound/private-mpp.js";
import { createPrivateX402Rail } from "../../src/adapters/outbound/private-x402.js";
import type { DynamicProfile } from "../../src/config.js";
import type { GuardedTransport, TransportContext } from "../../src/net/guarded-fetch.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { FIXTURE_ASSET, FIXTURE_NETWORK, standardAccept } from "../fixtures/dynamic/x402-upstream.js";
import { MPP_FIXTURE_CHAIN_ID, MPP_FIXTURE_CURRENCY } from "../fixtures/dynamic/mpp-upstream.js";

const X402_PROFILE: DynamicProfile = {
  profileId: "priv-x402",
  sourceRail: "x402",
  source: { network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "x402",
  destination: { scheme: "exact", network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};
const MPP_PROFILE: DynamicProfile = {
  profileId: "priv-tempo",
  sourceRail: "x402",
  source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "mpp",
  destination: { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, decimals: 6, feeAsset: MPP_FIXTURE_CURRENCY, maxFee: "5000" },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 0, min: "1000" },
};
const URL_POST = "https://test-server.io/select";

function spy(respond: (url: string) => Response): { transport: GuardedTransport; contexts: TransportContext[] } {
  const contexts: TransportContext[] = [];
  return {
    contexts,
    transport: { allowLoopback: false, boundsDns: true, report: () => {}, fetch: async (url, _init, context) => { contexts.push(context); return respond(String(url)); } },
  };
}

const x402Respond = (url: string): Response =>
  new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, error: "payment_required", resource: { url }, accepts: [standardAccept()] } as never) } });

describe("x402 の探り", () => {
  test("transport を渡せばそれで送り、rail の transport は使わない（文脈は今と同じ）", async () => {
    const base = spy(x402Respond);
    const pinned = spy(x402Respond);
    const rail = createPrivateX402Rail(createRealEvmCapability(generatePrivateKey()).capability(FIXTURE_NETWORK), { profiles: { "priv-x402": X402_PROFILE }, transport: base.transport });
    const found = await rail.discover("priv-x402", { url: URL_POST, method: "POST", body: "{}" }, { transport: pinned.transport });
    expect(found.offers).toEqual([standardAccept()]);
    expect(base.contexts).toHaveLength(0);
    expect(pinned.contexts).toEqual([{ routeId: "priv-x402", operation: "private_probe" }]);
  });
  test("渡さなければ rail の transport で今と同じ", async () => {
    for (const options of [undefined, {}]) {
      const base = spy(x402Respond);
      const rail = createPrivateX402Rail(createRealEvmCapability(generatePrivateKey()).capability(FIXTURE_NETWORK), { profiles: { "priv-x402": X402_PROFILE }, transport: base.transport });
      await rail.discover("priv-x402", { url: URL_POST, method: "POST", body: "{}" }, options);
      expect(base.contexts).toEqual([{ routeId: "priv-x402", operation: "private_probe" }]);
    }
  });
});

describe("MPP の探り", () => {
  // challenge の中身は問わない（文脈が transport に渡るかだけを見る。読めない challenge は fetch の後に拒否される）。
  const mppRespond = (): Response => new Response("{}", { status: 402, headers: { "www-authenticate": "not-a-challenge" } });
  function mppRail(transport: GuardedTransport) {
    const capability = createRealMppCapability(generatePrivateKey(), { rpcUrl: "https://rpc.other.test", chainId: MPP_FIXTURE_CHAIN_ID }).capability();
    return createPrivateMppRail(capability, { profiles: { "priv-tempo": MPP_PROFILE }, transport });
  }
  test("transport を渡せばそれで送り、rail の transport は使わない", async () => {
    const base = spy(mppRespond);
    const pinned = spy(mppRespond);
    await expect(mppRail(base.transport).discover("priv-tempo", { url: URL_POST, method: "POST", body: "{}" }, { transport: pinned.transport })).rejects.toThrow();
    expect(base.contexts).toHaveLength(0);
    expect(pinned.contexts).toEqual([{ routeId: "priv-tempo", operation: "private_probe" }]);
  });
  test("渡さなければ rail の transport で今と同じ", async () => {
    const base = spy(mppRespond);
    await expect(mppRail(base.transport).discover("priv-tempo", { url: URL_POST, method: "POST", body: "{}" })).rejects.toThrow();
    expect(base.contexts).toEqual([{ routeId: "priv-tempo", operation: "private_probe" }]);
  });
});
