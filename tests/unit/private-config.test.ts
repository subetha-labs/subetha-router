/**
 * `router.private` の設定と合成（設計 §9、T-Z5、要件 FR-Z12・FR-Z13・FR-Z24・FR-Z28）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import { BURN_SALE_APPROVAL_TTL_MAX_MS, ConfigError, DEFAULT_PRIVATE_CONFIG, loadRuntimeConfig, parseRouterConfig, privateAuthoritativeTermsOf, tlsModeOf, validateRouterConfigAgainstTable, type PrivateConfig, type RuntimeConfig } from "../../src/config.js";
import { PROXY_RELAY_LIMITS } from "../../src/private/proxy.js";
import { MAX_QUOTE_LIFETIME_MS } from "../../src/core/quote-ledger.js";
import { KNOWN_NETWORKS } from "../../src/shared/networks.js";
import { composeRails, profileIdOfBinding, startRouter, type RouterCapabilities } from "../../src/main.js";
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
    // 増分 v1.5 の有効化の後は既定が proxy 型: 既存の試験は MPC 型のまま（`mpcProfiles` = 有効な profiles）。proxy 型の試験は `mpcProfiles` を明示する。
    ...(privatePatch === null ? {} : { private: { deliveryBin: FAKE, deliveryBinSha256: sha256File(FAKE), srsPath: FAKE, srsSha256: sha256File(FAKE), profiles: ["priv-x402", "priv-tempo"], ...privatePatch, ...(Object.hasOwn(privatePatch, "mpcProfiles") ? {} : { mpcProfiles: Array.isArray(privatePatch["profiles"]) ? (privatePatch["profiles"] as unknown[]).filter((id, index, all) => typeof id === "string" && id !== "" && all.indexOf(id) === index) : ["priv-x402", "priv-tempo"] }) } }),
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
    // V2 testnet-v2 の zUSDC（別 deployment、`docs/zktls-router-v2-inbound.md` §10）も表にあるので通る。decimals 違いは拒む。
    const v2 = parseRouterConfig(router({ profiles: ["priv-x402", "priv-subetha"] }, subethaProfile("0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f")));
    expect(v2.dynamic?.profiles["priv-subetha"]?.source.asset).toBe("0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f");
    const v2Profile = subethaProfile("0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f")["priv-subetha"] as { source: Record<string, unknown> };
    // decimals の照合は表の検査（validateRouterConfigAgainstTable）で起動時に拒む。
    expect(() => validateRouterConfigAgainstTable(parseRouterConfig(router({ profiles: ["priv-x402", "priv-subetha"] }, { "priv-subetha": { ...v2Profile, source: { ...v2Profile.source, decimals: 18 } } })), KNOWN_NETWORKS)).toThrow(/decimals does not match the zERC20 table/);
    expect(() => validateRouterConfigAgainstTable(v2, KNOWN_NETWORKS)).not.toThrow();
    expect(() => parseRouterConfig(router({ profiles: ["priv-x402"] }, subethaProfile()))).toThrow(/only allowed for profiles listed in private.profiles/);
    expect(() => parseRouterConfig(router(null, subethaProfile()))).toThrow(/only allowed for profiles listed in private.profiles/);
  });
  test("v1.4 FR-H1: burnSaleApprovalTtlMs の検査の表（既定・上限・subetha の有無・retentionMs）", () => {
    const withSub = (patch: Record<string, unknown>) => parseRouterConfig(router({ profiles: ["priv-x402", "priv-subetha"], ...patch }, subethaProfile())).private!;
    const x402Only = (patch: Record<string, unknown>) => parseRouterConfig(router({ profiles: ["priv-x402"], ...patch })).private!;
    // 省略: subetha 無しは既定（使われない）、ありは min(1,200,000, cap)。
    expect(x402Only({}).burnSaleApprovalTtlMs).toBe(1_200_000);
    expect(withSub({}).burnSaleApprovalTtlMs).toBe(1_200_000);
    expect(withSub({ retentionMs: 900_000, attestTimeoutMs: 600_000, verifyTimeoutMs: 60_000 }).burnSaleApprovalTtlMs).toBe(900_000);
    // 既存の x402 だけの設定は retentionMs が短くても起動する（欄を持たない）。
    expect(x402Only({ retentionMs: 30_000, attestTimeoutMs: 20_000, verifyTimeoutMs: 5_000 }).retentionMs).toBe(30_000);
    // subetha ありで cap < 60,000 は省略でも拒否。
    expect(() => withSub({ retentionMs: 30_000, attestTimeoutMs: 20_000, verifyTimeoutMs: 5_000 })).toThrow(/retentionMs is too short for a burn-sale approval window/);
    // 明示: 常に [60,000, 86,400,000] の整数。subetha ありは retentionMs 以下も。
    for (const bad of [59_999, 86_400_001, 1.5, "1200000", -1]) {
      expect(() => x402Only({ burnSaleApprovalTtlMs: bad }), String(bad)).toThrow(/burnSaleApprovalTtlMs must be an integer between 60000 and 86400000/);
      expect(() => withSub({ burnSaleApprovalTtlMs: bad }), String(bad)).toThrow(/burnSaleApprovalTtlMs must be an integer between/);
    }
    expect(x402Only({ burnSaleApprovalTtlMs: 86_400_000 }).burnSaleApprovalTtlMs).toBe(86_400_000);
    expect(() => withSub({ burnSaleApprovalTtlMs: 3_600_001 })).toThrow(/must be at most retentionMs \(3600000 ms\)/);
    expect(withSub({ burnSaleApprovalTtlMs: 3_600_000 }).burnSaleApprovalTtlMs).toBe(3_600_000);
    expect(withSub({ burnSaleApprovalTtlMs: 60_000 }).burnSaleApprovalTtlMs).toBe(60_000);
    // retentionMs が 1 日を超えても上限は 1 日（quote ledger の上限）。
    expect(withSub({ retentionMs: 2 * 86_400_000, burnSaleApprovalTtlMs: 86_400_000 }).burnSaleApprovalTtlMs).toBe(86_400_000);
    expect(() => withSub({ retentionMs: 2 * 86_400_000, burnSaleApprovalTtlMs: 86_400_001 })).toThrow(/must be an integer between/);
    expect(withSub({ retentionMs: 2 * 86_400_000 }).burnSaleApprovalTtlMs).toBe(1_200_000);
  });
  test("v1.4: 上限の定数は quote ledger の上限と同じ", () => {
    expect(BURN_SALE_APPROVAL_TTL_MAX_MS).toBe(MAX_QUOTE_LIFETIME_MS);
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
  /** 増分 v1.5 T-X2: 能力の門（設計 §3）。合成は同期のまま、門は起動の検査の列に入る。 */
  /** proxy 型の設定（既定 = `mpcProfiles` に載せない）。 */
  function activated(patch: Record<string, unknown> = {}): RuntimeConfig {
    return runtime(router({ mpcProfiles: [], ...patch }));
  }
  test("能力の門: proxy 型のプロファイルがあれば起動の検査で 1 回読み、proxy を宣言しなければ起動の検査が ConfigError で失敗する", async () => {
    const calls: string[] = [];
    const noProxy = composeRails(activated(), capabilities({ readCapabilitiesForTest: async (bin) => { calls.push(bin); return { tlsModes: ["mpc"] }; } }), quiet, quiet);
    expect(calls).toEqual([]); // 合成の時点では読まない（同期の合成は変えない）。
    await expect(noProxy.startup!()).rejects.toThrow(/does not support proxy mode; list every private profile in private.mpcProfiles/);
    await expect(noProxy.startup!()).rejects.toThrow(ConfigError);
    expect(calls).toEqual([FAKE, FAKE]);
    const unreadable = composeRails(activated(), capabilities({ readCapabilitiesForTest: async () => undefined }), quiet, quiet);
    await expect(unreadable.startup!()).rejects.toThrow(/does not support proxy mode/);
    const ok = composeRails(activated(), capabilities({ readCapabilitiesForTest: async () => ({ tlsModes: ["mpc", "proxy"] }) }), quiet, quiet);
    await expect(ok.startup!()).resolves.toBeUndefined();
    // 本物の読み取り（偽の delivery は両方を宣言する）。
    await expect(composeRails(activated(), capabilities(), quiet, quiet).startup!()).resolves.toBeUndefined();
  });
  test("宛先の固定の配線（T-X6）: 実合成の private に pinDestination があり、動的と同じ試験の名前解決で公開アドレスを固定する。loopback は拒否", async () => {
    const rails = composeRails(activated(), capabilities(), quiet, quiet);
    expect(rails.private!.pinDestination).toBeTypeOf("function");
    const pinned = await rails.private!.pinDestination!("test-server.io", { operation: "private_proxy_pin", routeId: "priv-x402" });
    expect(pinned.dialAddr).toBe("93.184.216.34:443");
    pinned.release();
    const loopback = composeRails(activated(), capabilities({ dynamicTransportHooksForTest: { lookup: publicLookup({ "test-server.io": ["127.0.0.1"] }), interfaces: () => [] } }), quiet, quiet);
    await expect(loopback.private!.pinDestination!("test-server.io", { operation: "private_proxy_pin" })).rejects.toMatchObject({ code: "destination_blocked" });
  });
  test("能力の門: 全プロファイルが MPC 型（mpcProfiles に全部）なら読まない", async () => {
    const calls: string[] = [];
    const counting = capabilities({ readCapabilitiesForTest: async (bin) => { calls.push(bin); return undefined; } });
    for (const config of [runtime(router()), activated({ mpcProfiles: ["priv-x402", "priv-tempo"] })]) {
      const rails = composeRails(config, counting, quiet, quiet);
      if (rails.startup !== undefined) await rails.startup();
    }
    expect(calls).toEqual([]);
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

/** 増分 v1.5（proxy 型）T-X1: `mpcProfiles`・`tlsModeOf`・指紋の proxy 欄（`docs/zktls-router-proxy-design.md` §2、要件 FR-X00・FR-X01・FR-X03）。 */
describe("proxy 型の設定（T-X1）", () => {
  /** 本増分の前の `privateAuthoritativeTermsOf` の形（MPC 型はこれと完全に同じであること）。 */
  function legacyTerms(config: PrivateConfig, profileId: string, rail: "x402" | "mpp", trust: "mozilla" | "lab-fixture-ca"): unknown {
    return {
      private: true,
      allowlisted: config.profiles.includes(profileId),
      trust,
      deliveryBinSha256: config.deliveryBinSha256,
      srsSha256: config.srsSha256,
      policy: { minCredentialLifetimeMs: config.minCredentialLifetimeMs[rail], sessionTimeoutMs: config.sessionTimeoutMs, attestTimeoutMs: config.attestTimeoutMs, retentionMs: config.retentionMs },
      limits: { maxIntentBytes: config.maxIntentBytes, maxBundleBytes: config.maxBundleBytes, maxRecordBytes: config.maxRecordBytes },
    };
  }

  test("mpcProfiles を省略すると解析結果に欄が無い（省略の正規化は tlsModeOf がする）", () => {
    const parsed = parseRouterConfig(router({ mpcProfiles: undefined })).private!;
    expect(Object.hasOwn(parsed, "mpcProfiles")).toBe(false);
  });
  test("mpcProfiles を書けば写す", () => {
    expect(parseRouterConfig(router({ mpcProfiles: ["priv-x402"] })).private!.mpcProfiles).toEqual(["priv-x402"]);
    expect(parseRouterConfig(router({ mpcProfiles: [] })).private!.mpcProfiles).toEqual([]);
  });
  test.each<[string, unknown]>([
    ["配列でない", "priv-x402"],
    ["profiles に無い", ["dyn-mpp-in"]],
    ["重複", ["priv-x402", "priv-x402"]],
    ["空文字", [""]],
    ["文字列でない", [1]],
  ])("拒否: mpcProfiles が%s", (_name, value) => {
    expect(() => parseRouterConfig(router({ mpcProfiles: value }))).toThrow(/mpcProfiles must be a subset of private.profiles without repeats/);
  });
  test("既定は proxy 型（owner の判断 2026-10-26）: mpcProfiles に載るものが MPC 型、それ以外（省略を含む）が proxy 型", () => {
    const partial = parseRouterConfig(router({ mpcProfiles: ["priv-x402"] })).private!;
    expect(tlsModeOf(partial, "priv-x402")).toBe("mpc");
    expect(tlsModeOf(partial, "priv-tempo")).toBe("proxy");
    const omitted = parseRouterConfig(router({ mpcProfiles: undefined })).private!;
    expect(tlsModeOf(omitted, "priv-x402")).toBe("proxy");
    expect(tlsModeOf(omitted, "priv-tempo")).toBe("proxy");
    const empty = parseRouterConfig(router({ mpcProfiles: [] })).private!;
    expect(tlsModeOf(empty, "priv-x402")).toBe("proxy");
    const all = parseRouterConfig(router()).private!;
    expect([tlsModeOf(all, "priv-x402"), tlsModeOf(all, "priv-tempo")]).toEqual(["mpc", "mpc"]);
  });
  test("MPC 型の指紋は本増分の前と完全に同じ（mpcProfiles の欄は入らない）", () => {
    for (const patch of [{}, { mpcProfiles: ["priv-x402", "priv-tempo"] }, { mpcProfiles: ["priv-tempo", "priv-x402"] }]) {
      const parsed = parseRouterConfig(router(patch)).private!;
      for (const trust of ["mozilla", "lab-fixture-ca"] as const) {
        expect(privateAuthoritativeTermsOf(parsed, "priv-x402", "x402", trust)).toStrictEqual(legacyTerms(parsed, "priv-x402", "x402", trust));
        expect(privateAuthoritativeTermsOf(parsed, "priv-tempo", "mpp", trust)).toStrictEqual(legacyTerms(parsed, "priv-tempo", "mpp", trust));
      }
      expect(JSON.stringify(privateAuthoritativeTermsOf(parsed, "priv-x402", "x402", "mozilla"))).toBe(JSON.stringify(legacyTerms(parsed, "priv-x402", "x402", "mozilla")));
    }
    // 一部だけ MPC 型の設定でも、mpcProfiles に載るプロファイルは今と同じ。
    const partial = parseRouterConfig(router({ mpcProfiles: ["priv-x402"] })).private!;
    expect(privateAuthoritativeTermsOf(partial, "priv-x402", "x402", "mozilla")).toStrictEqual(legacyTerms(partial, "priv-x402", "x402", "mozilla"));
  });
  test("proxy 型の指紋は末尾に tlsMode と proxyRelay を足し、型の変更は両方向で指紋を変える", () => {
    const parsed = parseRouterConfig(router()).private!;
    const proxy: PrivateConfig = { ...parsed, mpcProfiles: [] };
    const terms = privateAuthoritativeTermsOf(proxy, "priv-x402", "x402", "mozilla");
    expect(terms).toStrictEqual({ ...(legacyTerms(proxy, "priv-x402", "x402", "mozilla") as object), tlsMode: "proxy", proxyRelay: { maxSentBytes: PROXY_RELAY_LIMITS.maxSentBytes, maxRecvBytes: PROXY_RELAY_LIMITS.maxRecvBytes } });
    expect(JSON.stringify(terms)).not.toBe(JSON.stringify(privateAuthoritativeTermsOf(parsed, "priv-x402", "x402", "mozilla")));
    const backToMpc: PrivateConfig = { ...proxy, mpcProfiles: ["priv-x402"] };
    expect(JSON.stringify(privateAuthoritativeTermsOf(backToMpc, "priv-x402", "x402", "mozilla"))).toBe(JSON.stringify(privateAuthoritativeTermsOf(parsed, "priv-x402", "x402", "mozilla")));
  });
});

/**
 * 増分 v1.5 T-X8: 起動の境界（T-X2 の残り）。`startRouter` を**同じプロセスの中で**呼ぶ（別プロセスの起動ではない）。proxy を宣言しないバイナリでは起動の検査で終わり、
 * journal のディレクトリを作らない（`startRouter` は journal のディレクトリ → core → HTTP の順に作るので、その前で止まったことを示す）。
 */
describe("起動の境界（T-X8）", () => {
  test("proxy 既定の設定 + proxy を宣言しないバイナリ: startRouter は ConfigError で終わり、journal のディレクトリを作らない（core・HTTP の前）", async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    const dir = mkdtempSync(path.join(runtimeRoot, "private-boundary-"));
    dirs.push(dir);
    const bin = path.join(dir, "delivery-mpc-only");
    writeFileSync(bin, `#!/bin/sh\nprintf '{"tls_modes":["mpc"]}'\n`);
    chmodSync(bin, 0o755);
    const doc = router({ deliveryBin: bin, deliveryBinSha256: sha256File(bin), mpcProfiles: [] });
    const configPath = path.join(dir, "router.config.json");
    writeFileSync(configPath, JSON.stringify({ router: doc, x402: { upstreams: { r1: "https://static.provider.test/v1/x" } }, synthetic: { facilitatorUrl: "http://127.0.0.1:1", upstreams: { r1: "http://127.0.0.1:2/x" } } }));
    const journalDir = path.join(dir, "journal-dir");
    const env = {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
      ROUTER_X402_INBOUND_FACILITATOR_URL: "https://facilitator.other.test",
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-integration",
      ROUTER_MPP_INBOUND_RPC_URL: "https://rpc.other.test",
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: path.join(journalDir, "journal.ndjson"),
    };
    const saved = { ...process.env };
    try {
      Object.assign(process.env, env);
      const evm = createRealEvmCapability(generatePrivateKey());
      const mpp = createRealMppCapability(generatePrivateKey(), { rpcUrl: "https://rpc.other.test" });
      await expect(startRouter({ evmSigning: evm.capability("eip155:84532"), mppTempo: mpp.capability(), dependencyUrls: ["https://rpc.other.test/"], dynamicTransportHooksForTest: { lookup: publicLookup(), interfaces: () => [] }, knownNetworksForTest: TEST_NETWORKS })).rejects.toThrow(/does not support proxy mode/);
      expect(existsSync(journalDir)).toBe(false);
    } finally {
      for (const key of Object.keys(env)) {
        if (Object.hasOwn(saved, key)) process.env[key] = saved[key];
        else delete process.env[key];
      }
    }
  });
});
