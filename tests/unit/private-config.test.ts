/**
 * `router.private` の設定と合成（設計 §9、T-Z5、要件 FR-Z12・FR-Z13・FR-Z24・FR-Z28）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import { ConfigError, DEFAULT_PRIVATE_CONFIG, loadRuntimeConfig, parseRouterConfig, privateAuthoritativeTermsOf, type RuntimeConfig } from "../../src/config.js";
import { composeRails, profileIdOfBinding, type RouterCapabilities } from "../../src/main.js";
import { privateBindingOf } from "../../src/core/store.js";
import { sha256File } from "../../src/private/verifier.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { publicLookup } from "../fixtures/dynamic/dial.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const FAKE = path.resolve(import.meta.dirname, "../fixtures/private/fake-delivery.mjs");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function router(privatePatch: Record<string, unknown> | null = {}, profilesPatch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalTtlMs: 60_000,
    routes: { r1: { routeId: "r1", canonicalPath: "/v1/routes/r1/resource", rail: "x402", sourceRail: "x402", source: { amount: "10000", asset: USDC, decimals: 6, network: "eip155:84532", payTo: RECEIVER }, destination: { scheme: "exact", network: "eip155:84532", asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" } } },
    budget: { maxPurchases: 8, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "1000000", maxPerPurchase: "20000" }] },
    dynamic: {
      enabled: true,
      profiles: {
        "priv-x402": { profileId: "priv-x402", sourceRail: "x402", source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER }, rail: "x402", destination: { scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } },
        "priv-tempo": { profileId: "priv-tempo", sourceRail: "x402", source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER }, rail: "mpp", destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "5000" }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } },
        "dyn-mpp-in": { profileId: "dyn-mpp-in", sourceRail: "mpp", source: { network: "eip155:42431", asset: PATHUSD, decimals: 6, payTo: RECEIVER }, rail: "x402", destination: { scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } },
        ...profilesPatch,
      },
      budget: { maxPurchases: 50, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "10000000", maxPerPurchase: "20000" }, { network: "eip155:42431", asset: PATHUSD, maxTotal: "10000000", maxPerPurchase: "20000" }] },
      denyHosts: [],
    },
    ...(privatePatch === null ? {} : { private: { deliveryBin: FAKE, deliveryBinSha256: sha256File(FAKE), srsPath: FAKE, srsSha256: sha256File(FAKE), profiles: ["priv-x402", "priv-tempo"], ...privatePatch } }),
  };
}

describe("parse", () => {
  test("既定値で通り、方針の権威を組める", () => {
    const parsed = parseRouterConfig(router());
    expect(parsed.private).toMatchObject({ ...DEFAULT_PRIVATE_CONFIG, deliveryBin: FAKE, profiles: ["priv-x402", "priv-tempo"] });
    const terms = privateAuthoritativeTermsOf(parsed.private!, "priv-x402", "x402", "mozilla") as Record<string, unknown>;
    expect(terms).toMatchObject({ private: true, allowlisted: true, trust: "mozilla", policy: { minCredentialLifetimeMs: 40_000, sessionTimeoutMs: 180_000 } });
    expect((privateAuthoritativeTermsOf(parsed.private!, "other", "x402", "mozilla") as Record<string, unknown>)["allowlisted"]).toBe(false);
    // 無指定なら機能そのものが無い（既存の出力は不変）。
    expect(parseRouterConfig(router(null)).private).toBeUndefined();
  });
  test.each<[string, Record<string, unknown>, RegExp]>([
    ["trust は設定できない", { trust: "lab-fixture-ca" }, /trust is not a field/],
    ["sha256 の形", { deliveryBinSha256: "abc" }, /sha256 hex/],
    ["相対パス", { deliveryBin: "relative/delivery" }, /absolute paths/],
    ["profiles が空", { profiles: [] }, /non-empty array/],
    ["profiles の重複", { profiles: ["priv-x402", "priv-x402"] }, /not repeat/],
    ["存在しないプロファイル", { profiles: ["nope"] }, /not a dynamic profile/],
    ["受信が MPP のプロファイル", { profiles: ["dyn-mpp-in"] }, /must receive x402 on eip155:84532/],
    ["verifierListen が loopback 以外", { verifierListen: "0.0.0.0:0" }, /loopback only/],
    ["verifierListen が固定ポート", { verifierListen: "127.0.0.1:8443" }, /loopback only/],
    ["sessionTimeoutMs が 0", { sessionTimeoutMs: 0 }, /positive integer/],
    ["minCredentialLifetimeMs の形", { minCredentialLifetimeMs: { x402: "40000" } }, /positive integer/],
    ["workDir が空", { workDir: "" }, /non-empty string/],
    ["保持期限が attest + 検証の上限より短い（record が検証の途中で消え得る）", { retentionMs: 600_000, attestTimeoutMs: 600_000, verifyTimeoutMs: 60_000 }, /retentionMs must be at least attestTimeoutMs \+ verifyTimeoutMs/],
    ["timer の上限を越える保持期限（30 日）", { retentionMs: 30 * 24 * 3_600_000 }, /retentionMs must be at most 2147483647 ms/],
    ["timer の上限を越える attest の期限", { attestTimeoutMs: 2_147_483_648, verifyTimeoutMs: 1, retentionMs: 2_147_483_649 }, /attestTimeoutMs must be at most 2147483647 ms/],
  ])("拒否: %s", (_name, patch, message) => {
    expect(() => parseRouterConfig(router(patch))).toThrow(message);
    expect(() => parseRouterConfig(router(patch))).toThrow(ConfigError);
  });
  const ZUSDC = "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF";
  const subethaProfile = (asset = ZUSDC) => ({ "priv-subetha": { profileId: "priv-subetha", sourceRail: "subetha", source: { network: "eip155:11155111", asset, decimals: 6, payTo: RECEIVER }, rail: "x402", destination: { scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } } });
  test("v1.3: subetha 受信（V2 burn-sale、Sepolia の zERC20）のプロファイルは private.profiles に挙げれば通る。別の資産・allowlist 外は起動しない", () => {
    const parsed = parseRouterConfig(router({ profiles: ["priv-x402", "priv-subetha"] }, subethaProfile()));
    expect(parsed.dynamic?.profiles["priv-subetha"]?.sourceRail).toBe("subetha");
    expect(parsed.private?.profiles).toEqual(["priv-x402", "priv-subetha"]);
    expect(() => parseRouterConfig(router({ profiles: ["priv-x402", "priv-subetha"] }, subethaProfile("0x0000000000000000000000000000000000005ce7")))).toThrow(/known zERC20 asset/);
    expect(() => parseRouterConfig(router({ profiles: ["priv-x402"] }, subethaProfile()))).toThrow(/only allowed for profiles listed in private.profiles/);
    expect(() => parseRouterConfig(router(null, subethaProfile()))).toThrow(/only allowed for profiles listed in private.profiles/);
  });
  test("拒否: dynamic 無し、送信が SVM、Tempo で feeAsset 無し", () => {
    const withoutDynamic = router();
    delete withoutDynamic["dynamic"];
    expect(() => parseRouterConfig(withoutDynamic)).toThrow(/requires router.dynamic/);
    expect(() => parseRouterConfig(router({ profiles: ["priv-svm"] }, { "priv-svm": { profileId: "priv-svm", sourceRail: "x402", source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER }, rail: "x402", destination: { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } } }))).toThrow(/EVM network with a tokenDomain/);
  });
});

describe("合成（composeRails）", () => {
  function runtime(doc: Record<string, unknown>, mode: "real" | "synthetic" = "real"): RuntimeConfig {
    mkdirSync(runtimeRoot, { recursive: true });
    const dir = mkdtempSync(path.join(runtimeRoot, "private-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "router.config.json");
    writeFileSync(configPath, JSON.stringify({ router: doc, x402: { upstreams: { r1: "https://static.provider.test/v1/x" } }, synthetic: { facilitatorUrl: "http://127.0.0.1:1", upstreams: { r1: "http://127.0.0.1:2/x" } } }));
    return loadRuntimeConfig(
      {
        ROUTER_CONFIG_PATH: configPath,
        ROUTER_PRINCIPAL_TOKENS: "judge:public",
        ROUTER_ADAPTER_MODE: mode,
        ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
        ROUTER_X402_INBOUND_FACILITATOR_URL: "https://facilitator.other.test",
        ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-integration",
        ROUTER_MPP_INBOUND_RPC_URL: "https://rpc.other.test",
        ROUTER_CANONICAL_BASE_URL: "https://router.test",
        ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
      },
      (file) => readFileSync(file, "utf8"),
      { networks: TEST_NETWORKS },
    );
  }
  function capabilities(extra: Partial<RouterCapabilities> = {}): RouterCapabilities {
    const evm = createRealEvmCapability(generatePrivateKey());
    const mpp = createRealMppCapability(generatePrivateKey(), { rpcUrl: "https://rpc.other.test" });
    return { evmSigning: evm.capability("eip155:84532"), mppTempo: mpp.capability(), dependencyUrls: ["https://rpc.other.test/"], dynamicTransportHooksForTest: { lookup: publicLookup(), interfaces: () => [] }, ...extra };
  }
  const quiet = (): void => {};
  test("private があれば両レールの私的 rail とランナーが組まれ、trust は mozilla。試験能力でだけ lab-fixture-ca", () => {
    const rails = composeRails(runtime(router()), capabilities(), quiet, quiet);
    expect(rails.private).toBeDefined();
    expect(Object.keys(rails.private!.rails).sort()).toEqual(["priv-tempo", "priv-x402"]);
    expect(rails.private!.rails["priv-x402"]!.rail).toBe("x402");
    expect(rails.private!.rails["priv-tempo"]!.rail).toBe("mpp");
    expect(rails.private!.trust).toBe("mozilla");
    expect(rails.private!.runner.deliveryBinSha256).toBe(sha256File(FAKE));
    const synthetic = composeRails(runtime(router()), capabilities({ privateTrustForTest: "lab-fixture-ca" }), quiet, quiet);
    expect(synthetic.private!.trust).toBe("lab-fixture-ca");
    // private が無ければ配線も無い。
    expect(composeRails(runtime(router(null)), capabilities(), quiet, quiet).private).toBeUndefined();
  });
  test("バイナリ・SRS の sha256 不一致、合成レール、能力の欠落では起動しない", () => {
    expect(() => composeRails(runtime(router({ deliveryBinSha256: "0".repeat(64) })), capabilities(), quiet, quiet)).toThrow(/does not match private.deliveryBinSha256/);
    expect(() => composeRails(runtime(router({ srsSha256: "0".repeat(64) })), capabilities(), quiet, quiet)).toThrow(/does not match private.srsSha256/);
    expect(() => composeRails(runtime(router({ deliveryBin: "/nonexistent/delivery", deliveryBinSha256: "0".repeat(64) })), capabilities(), quiet, quiet)).toThrow(/could not be read/);
    expect(() => composeRails(runtime(router(), "synthetic"), {}, quiet, quiet)).toThrow(/not available with the synthetic rails/);
    const { mppTempo: _m, ...withoutTempo } = capabilities();
    expect(() => composeRails(runtime(router()), withoutTempo, quiet, quiet)).toThrow(/signer_not_authorized/);
  });
});

describe("受信 offer の束縛 → プロファイル（`profileIdOfBinding`）", () => {
  test("秘匿の束縛（private|profile|METHOD|url|intentSha256）から受信 rail のプロファイルを引ける。動的の形は従来どおり、他は undefined", () => {
    expect(profileIdOfBinding(privateBindingOf("priv-x402", "POST", "https://test-server.io/select", "a".repeat(64)))).toBe("priv-x402");
    expect(profileIdOfBinding(privateBindingOf("priv tempo", "GET", "https://test-server.io/v1/paid-snapshot", "b".repeat(64)))).toBe("priv tempo");
    expect(profileIdOfBinding(["dynamic", "dyn", "GET", encodeURIComponent("https://p.test/x")].join("|"))).toBe("dyn");
    expect(profileIdOfBinding(["dynamic", "dyn", "POST", encodeURIComponent("https://p.test/x"), "sha256:00"].join("|"))).toBe("dyn");
    expect(profileIdOfBinding("private|p|PUT|u|s")).toBeUndefined();
    expect(profileIdOfBinding("private|p|POST|u")).toBeUndefined();
    expect(profileIdOfBinding("x402|r1|https://p.test/x")).toBeUndefined();
    expect(profileIdOfBinding("")).toBeUndefined();
  });
});
