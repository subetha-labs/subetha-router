/**
 * EVM testnet 4 つ（`docs/evm-testnets-x402-design.md` E-1。AC-E1・AC-E2）:
 * - 表の値（§1.1。2026-10-13 に公式の一覧と読み取り専用 RPC で確認した値）
 * - 受信 offer の EIP-712 domain は表の値（kind `x402` の受信。§3.2）。ほかの network（Base Sepolia）の offer は今までどおり `USDC`/`2`
 * - `npm run sign` の分類（`classifyExactEvm`）が 4 つの offer を受け、domain を 1 字変えると拒む
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadRuntimeConfig, routeBindingOf } from "../../src/config.js";
import { composeRails } from "../../src/main.js";
import { EVM_TESTNET_NETWORKS, KNOWN_NETWORKS, evmTestnetDeadlinesOf, knownAssetOf, knownNetworkOf } from "../../src/shared/networks.js";
import { classifyEvmOffer } from "../../tools/sign-classify-evm.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

const ROWS = [
  { short: "rh", network: "eip155:46630", chainId: 46630, asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F", domain: { name: "Global Dollar", version: "1" } },
  { short: "arbsep", network: "eip155:421614", chainId: 421614, asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", domain: { name: "USD Coin", version: "2" } },
  { short: "hyperevm", network: "eip155:998", chainId: 998, asset: "0x2B3370eE501B4a559b57D449569354196457D8Ab", domain: { name: "USDC", version: "2" } },
  { short: "sepolia", network: "eip155:11155111", chainId: 11155111, asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", domain: { name: "USDC", version: "2" } },
] as const;
const BASE = "eip155:84532";
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER_A = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";

describe("表の 4 行（AC-E1）", () => {
  test("値が §1.1 と一致し、x402 の受信・送信、facilitator kind x402、資産 1 つ（decimals 6）", () => {
    for (const row of ROWS) {
      const entry = knownNetworkOf(KNOWN_NETWORKS, row.network);
      expect(entry, row.short).toEqual({ network: row.network, family: "evm", inbound: ["x402"], outbound: ["x402"], x402Facilitator: "x402", assets: [{ id: row.asset, decimals: 6, domain: row.domain }] });
    }
    expect([...EVM_TESTNET_NETWORKS].sort()).toEqual(ROWS.map((row) => row.network).sort());
  });

  test("資産は network + アドレスで引く（大文字小文字によらない）。名前や別の network では引けない", () => {
    for (const row of ROWS) {
      const entry = knownNetworkOf(KNOWN_NETWORKS, row.network)!;
      expect(knownAssetOf(entry, row.asset.toLowerCase())?.id, row.short).toBe(row.asset);
      expect(knownAssetOf(entry, row.asset.toUpperCase().replace("0X", "0x"))?.id, row.short).toBe(row.asset);
      expect(knownAssetOf(entry, row.domain.name), row.short).toBeUndefined();
    }
    // Arbitrum Sepolia の USDC を Ethereum Sepolia の行で引いても無い（network と資産の組で厳密）
    expect(knownAssetOf(knownNetworkOf(KNOWN_NETWORKS, "eip155:11155111")!, ROWS[1].asset)).toBeUndefined();
  });

  test("期限（§3.6）は 4 つだけに効き、Ethereum Sepolia だけ長い。ほかの network は undefined", () => {
    expect(evmTestnetDeadlinesOf("eip155:11155111")).toEqual({ inboundFacilitatorMs: 50_000, outboundPaidMs: 75_000 });
    for (const network of ["eip155:46630", "eip155:421614", "eip155:998"]) expect(evmTestnetDeadlinesOf(network)).toEqual({ inboundFacilitatorMs: 20_000, outboundPaidMs: 30_000 });
    for (const network of [BASE, "eip155:8453", "eip155:5042002", "eip155:42431", "eip155:1"]) expect(evmTestnetDeadlinesOf(network)).toBeUndefined();
  });
});

describe("npm run sign の分類（AC-E2）", () => {
  const NOW = 1_800_000_000_000;
  const offer = (row: (typeof ROWS)[number], domain: { name: string; version: string } = row.domain) => ({
    scheme: "exact",
    network: row.network,
    asset: row.asset,
    amount: "10000",
    payTo: RECEIVER,
    maxTimeoutSeconds: 600,
    extra: { ...domain, challengeNonce: `0x${"ab".repeat(32)}`, expiresAt: 1_800_000_600, routeBinding: "b", fundsMoveOnCredential: false },
  });
  test("4 つとも chainId と表の domain で受ける。domain を 1 字変えると拒む", () => {
    for (const row of ROWS) {
      expect(classifyEvmOffer(offer(row), NOW), row.short).toEqual({ kind: "x402-evm", chainId: row.chainId, domain: row.domain, asset: row.asset, payTo: RECEIVER, amount: "10000" });
      const name = `${row.domain.name.slice(0, -1)}${row.domain.name.endsWith("C") ? "c" : "C"}`;
      expect(classifyEvmOffer(offer(row, { name, version: row.domain.version }), NOW), row.short).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/EIP-712 domain does not match/) });
      expect(classifyEvmOffer(offer(row, { name: row.domain.name, version: row.domain.version === "1" ? "2" : "1" }), NOW), row.short).toMatchObject({ kind: "refuse" });
    }
  });
});

describe("受信 offer の domain（kind x402。AC-E2・§3.2）", () => {
  function compose() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evm-testnets-"));
    const routes: Record<string, unknown> = {
      "r-base": {
        routeId: "r-base",
        canonicalPath: "/v1/routes/r-base/resource",
        rail: "x402",
        sourceRail: "x402",
        source: { amount: "10000", asset: BASE_USDC, decimals: 6, network: BASE, payTo: RECEIVER },
        destination: { scheme: "exact", network: BASE, asset: BASE_USDC, payTo: PROVIDER_A },
      },
    };
    for (const row of ROWS) {
      routes[`r-${row.short}`] = {
        routeId: `r-${row.short}`,
        canonicalPath: `/v1/routes/r-${row.short}/resource`,
        rail: "x402",
        sourceRail: "x402",
        source: { amount: "10000", asset: row.asset, decimals: 6, network: row.network, payTo: RECEIVER },
        destination: { scheme: "exact", network: BASE, asset: BASE_USDC, payTo: PROVIDER_A },
      };
    }
    const document = {
      router: {
        approvalTtlMs: 60_000,
        routes,
        budget: { maxPurchases: 8, buckets: [{ network: BASE, asset: BASE_USDC, maxTotal: "100000", maxPerPurchase: "10000" }, ...ROWS.map((row) => ({ network: row.network, asset: row.asset, maxTotal: "100000", maxPerPurchase: "10000" }))] },
      },
      x402: {
        upstreams: Object.fromEntries(Object.keys(routes).map((id) => [id, "http://127.0.0.1:9/v1/eth/snapshot"])),
        inboundFacilitators: Object.fromEntries(ROWS.map((row) => [row.network, { kind: "x402", url: "https://facilitator.example" }])),
      },
    };
    const file = path.join(dir, "router.config.json");
    writeFileSync(file, JSON.stringify(document));
    const env = {
      ROUTER_CONFIG_PATH: file,
      ROUTER_PRINCIPAL_TOKENS: "a:b",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha-facilitator.example",
      ROUTER_X402_INBOUND_FACILITATOR_URL: "https://x402.example/facilitator",
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    };
    const config = loadRuntimeConfig(env, (f) => readFileSync(f, "utf8"), { networks: TEST_NETWORKS });
    return { config, rails: composeRails(config, { evmSigning: createSignerSpy().capability(BASE) }, () => undefined, () => undefined) };
  }

  test("4 つの受信 offer は表の domain、Base Sepolia の offer は今までどおり USDC/2（offer は乱数と時刻を含むので欄で比べる）", async () => {
    const { config, rails } = compose();
    const offerOf = async (routeId: string) => {
      const route = config.router.routes[routeId]!;
      return (await rails.inbound.createOffer({ routeId, amount: route.source.amount, asset: route.source.asset, network: route.source.network, routeBinding: routeBindingOf(route), nowMs: Date.now() })) as { extra: Record<string, unknown> };
    };
    for (const row of ROWS) {
      const offer = await offerOf(`r-${row.short}`);
      expect({ name: offer.extra["name"], version: offer.extra["version"] }, row.short).toEqual(row.domain);
      // （fixture の署名能力なので上流は loopback。上流には触れない）kind x402 の発行鍵のまま（Circle の assetTransferMethod は出さない）
      expect(offer.extra["assetTransferMethod"], row.short).toBeUndefined();
    }
    const base = await offerOf("r-base");
    expect({ name: base.extra["name"], version: base.extra["version"] }).toEqual({ name: "USDC", version: "2" });
  });
});
