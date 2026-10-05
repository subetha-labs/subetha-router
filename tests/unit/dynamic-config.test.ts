/**
 * 動的上流 URL の設定（設計 `docs/dynamic-upstream-design.md` §1、タスク T1）。
 * **挙動は何も変えない**: 型・起動時の検証・プロファイルの解決・指紋だけ。
 */

import { expect, test } from "vitest";

import {
  authoritativeTermsOf,
  ConfigError,
  DEFAULT_DYNAMIC_LIMITS,
  dynamicAuthoritativeTermsOf,
  parseRouterConfig,
  resolveProfile,
  resolveRoute,
  type RouterConfig,
} from "../../src/config.js";
import { fingerprintOf } from "../../src/core/intent.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const PAY_TO = "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2";

function staticPart(): Record<string, unknown> {
  return {
    approvalTtlMs: 600_000,
    routes: {
      "md-static": {
        routeId: "md-static",
        canonicalPath: "/v1/routes/md-static/resource",
        rail: "mpp",
        sourceRail: "x402",
        source: { amount: "10000", asset: USDC, decimals: 6, network: "eip155:84532", payTo: PAY_TO },
        destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, payTo: PAY_TO },
      },
    },
    budget: {
      maxPurchases: 10,
      buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }],
    },
  };
}

function x402ToMpp(): Record<string, unknown> {
  return {
    profileId: "dyn-x402-to-mpp",
    sourceRail: "x402",
    source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: PAY_TO },
    rail: "mpp",
    destination: {
      scheme: "tempo/charge",
      network: "eip155:42431",
      asset: PATHUSD,
      decimals: 6,
      feeAsset: PATHUSD,
      maxFee: "50000",
    },
    par: true,
    maxUpstreamAmount: "100000",
    fee: { flat: "1000", bps: 100, min: "1000" },
  };
}

function mppToX402(): Record<string, unknown> {
  return {
    profileId: "dyn-mpp-to-x402",
    sourceRail: "mpp",
    source: { network: "eip155:42431", asset: PATHUSD, decimals: 6, payTo: PAY_TO },
    rail: "x402",
    destination: {
      scheme: "exact",
      network: "eip155:84532",
      asset: USDC,
      decimals: 6,
      tokenDomain: { name: "USDC", version: "2" },
    },
    par: true,
    maxUpstreamAmount: "100000",
    fee: { flat: "0", bps: 0, min: "0" },
  };
}

function withDynamic(dynamic: unknown): Record<string, unknown> {
  return { ...staticPart(), dynamic };
}

function dynamicOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    profiles: { "dyn-x402-to-mpp": x402ToMpp(), "dyn-mpp-to-x402": mppToX402() },
    budget: {
      maxPurchases: 5,
      buckets: [
        { network: "eip155:84532", asset: USDC, maxTotal: "1000000", maxPerPurchase: "200000" },
        { network: "eip155:42431", asset: PATHUSD, maxTotal: "1000000", maxPerPurchase: "200000" },
      ],
    },
    denyHosts: ["router.example.com"],
    ...overrides,
  };
}

/** プロファイルの 1 欄だけを差し替えた設定を作る。 */
function withProfilePatch(patch: (profile: Record<string, unknown>) => void): unknown {
  const profile = x402ToMpp();
  patch(profile);
  return withDynamic(dynamicOf({ profiles: { "dyn-x402-to-mpp": profile } }));
}

test("dynamic を書かなければ無効で、静的 route の設定は従来と同じ", () => {
  const config = parseRouterConfig(staticPart());
  expect(config.dynamic).toBeUndefined();
  expect(resolveProfile(config, "md-static")).toBeUndefined();
  expect(resolveProfile(config, "dyn-x402-to-mpp")).toBeUndefined();
  expect(resolveRoute(config, "md-static")?.routeId).toBe("md-static");
});

test("プロファイルは enabled に関わらず解決でき、route とは別に引ける", () => {
  for (const enabled of [true, false]) {
    const config = parseRouterConfig(withDynamic(dynamicOf({ enabled })));
    expect(config.dynamic?.enabled).toBe(enabled);
    expect(resolveProfile(config, "dyn-x402-to-mpp")?.rail).toBe("mpp");
    expect(resolveProfile(config, "dyn-mpp-to-x402")?.destination.tokenDomain).toEqual({ name: "USDC", version: "2" });
    // プロファイルは route ではない（静的の経路から見えない）。
    expect(resolveRoute(config, "dyn-x402-to-mpp")).toBeUndefined();
    expect(resolveProfile(config, "md-static")).toBeUndefined();
    // 継承したプロパティ名を ID として解決しない。
    expect(resolveProfile(config, "toString")).toBeUndefined();
  }
});

test("limits を省略すると既定値、書いた欄だけが上書きされる", () => {
  expect(parseRouterConfig(withDynamic(dynamicOf())).dynamic?.limits).toEqual(DEFAULT_DYNAMIC_LIMITS);
  const config = parseRouterConfig(withDynamic(dynamicOf({ limits: { maxOutstandingQuotes: 7 } })));
  expect(config.dynamic?.limits).toEqual({ ...DEFAULT_DYNAMIC_LIMITS, maxOutstandingQuotes: 7 });
});

test.each<[string, unknown]>([
  ["enabled が真偽値でない", withDynamic(dynamicOf({ enabled: "true" }))],
  ["profiles が空", withDynamic(dynamicOf({ profiles: {} }))],
  ["profileId がキーと違う", withDynamic(dynamicOf({ profiles: { other: x402ToMpp() } }))],
  ["profileId が route と同名", withDynamic(dynamicOf({ profiles: { "md-static": { ...x402ToMpp(), profileId: "md-static" } } }))],
  ["profileId にパスの文字", withDynamic(dynamicOf({ profiles: { "a/b": { ...x402ToMpp(), profileId: "a/b" } } }))],
  ["par が true でない", withProfilePatch((p) => { p["par"] = false; })],
  ["par が無い", withProfilePatch((p) => { delete p["par"]; })],
  ["sourceRail が subetha", withProfilePatch((p) => { p["sourceRail"] = "subetha"; })],
  ["rail が未知", withProfilePatch((p) => { p["rail"] = "lightning"; })],
  ["source.payTo がアドレスでない", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), payTo: "0x1234" }; })],
  ["mpp 送信で feeAsset が無い", withProfilePatch((p) => { const { feeAsset: _f, ...rest } = p["destination"] as Record<string, unknown>; p["destination"] = rest; })],
  ["mpp 送信で maxFee が無い", withProfilePatch((p) => { const { maxFee: _m, ...rest } = p["destination"] as Record<string, unknown>; p["destination"] = rest; })],
  ["maxUpstreamAmount が 0", withProfilePatch((p) => { p["maxUpstreamAmount"] = "0"; })],
  ["maxUpstreamAmount が指数表記", withProfilePatch((p) => { p["maxUpstreamAmount"] = "1e5"; })],
  ["fee.flat が負", withProfilePatch((p) => { p["fee"] = { flat: "-1", bps: 0, min: "0" }; })],
  ["fee.bps が小数", withProfilePatch((p) => { p["fee"] = { flat: "0", bps: 1.5, min: "0" }; })],
  ["fee.bps が 10000 超", withProfilePatch((p) => { p["fee"] = { flat: "0", bps: 10001, min: "0" }; })],
  ["decimals が負", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), decimals: -1 }; })],
  ["decimals が大きすぎる", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), decimals: 37 }; })],
  ["x402 送信で tokenDomain が無い", withDynamic(dynamicOf({ profiles: { "dyn-mpp-to-x402": (() => { const p = mppToX402(); const { tokenDomain: _t, ...rest } = p["destination"] as Record<string, unknown>; return { ...p, destination: rest }; })() } }))],
  ["budget が無い", withDynamic((() => { const { budget: _b, ...rest } = dynamicOf(); return rest; })())],
  ["denyHosts が配列でない", withDynamic(dynamicOf({ denyHosts: "router.example.com" }))],
  ["denyHosts に URL", withDynamic(dynamicOf({ denyHosts: ["https://router.example.com/"] }))],
  ["limits に未知の欄", withDynamic(dynamicOf({ limits: { quotesPerMinuteGlobl: 1 } }))],
  ["limits が 0", withDynamic(dynamicOf({ limits: { maxOutstandingQuotes: 0 } }))],
])("起動しない設定: %s", (_name, raw) => {
  expect(() => parseRouterConfig(raw)).toThrow(ConfigError);
});

test("指紋はプロファイルのどの欄を変えても、enabled を変えても変わる", () => {
  const base = parseRouterConfig(withDynamic(dynamicOf()));
  const baseline = fingerprintOf(dynamicAuthoritativeTermsOf(base.dynamic!, base.dynamic!.profiles["dyn-x402-to-mpp"]!));
  expect(baseline).toMatch(/^sha256:/);

  const variants: [string, unknown][] = [
    ["enabled", withDynamic(dynamicOf({ enabled: false }))],
    ["sourceRail", withProfilePatch((p) => { p["sourceRail"] = "mpp"; })],
    ["source.network", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), network: "eip155:1" }; })],
    ["source.asset", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), asset: PATHUSD }; })],
    ["source.decimals", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), decimals: 18 }; })],
    ["source.payTo", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), payTo: "0x000000000000000000000000000000000000dEaD" }; })],
    ["destination.network", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), network: "eip155:4217" }; })],
    ["destination.asset", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), asset: USDC }; })],
    ["destination.decimals", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), decimals: 8 }; })],
    ["destination.scheme", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), scheme: "tempo/session" }; })],
    ["destination.feeAsset", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), feeAsset: USDC }; })],
    ["destination.maxFee", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), maxFee: "50001" }; })],
    ["maxUpstreamAmount", withProfilePatch((p) => { p["maxUpstreamAmount"] = "100001"; })],
    ["fee.flat", withProfilePatch((p) => { p["fee"] = { flat: "1001", bps: 100, min: "1000" }; })],
    ["fee.bps", withProfilePatch((p) => { p["fee"] = { flat: "1000", bps: 101, min: "1000" }; })],
    ["fee.min", withProfilePatch((p) => { p["fee"] = { flat: "1000", bps: 100, min: "1001" }; })],
  ];
  for (const [name, raw] of variants) {
    const config = parseRouterConfig(raw);
    const changed = fingerprintOf(dynamicAuthoritativeTermsOf(config.dynamic!, config.dynamic!.profiles["dyn-x402-to-mpp"]!));
    expect(changed, name).not.toBe(baseline);
  }

  // x402 送信の tokenDomain も指紋に入る。
  const other = parseRouterConfig(withDynamic(dynamicOf()));
  const x402Base = fingerprintOf(dynamicAuthoritativeTermsOf(other.dynamic!, other.dynamic!.profiles["dyn-mpp-to-x402"]!));
  const domainChanged = parseRouterConfig(
    withDynamic(dynamicOf({ profiles: { "dyn-mpp-to-x402": { ...mppToX402(), destination: { ...(mppToX402()["destination"] as object), tokenDomain: { name: "USDC", version: "3" } } } } })),
  );
  expect(fingerprintOf(dynamicAuthoritativeTermsOf(domainChanged.dynamic!, domainChanged.dynamic!.profiles["dyn-mpp-to-x402"]!))).not.toBe(x402Base);
});

test("頻度の上限・拒否ホスト・動的予算は指紋に入らない（支払いの条件ではない）", () => {
  const base = parseRouterConfig(withDynamic(dynamicOf()));
  const changed = parseRouterConfig(
    withDynamic(dynamicOf({ limits: { maxOutstandingQuotes: 7 }, denyHosts: ["other.example.com"] })),
  );
  const fp = (config: RouterConfig): string =>
    fingerprintOf(dynamicAuthoritativeTermsOf(config.dynamic!, config.dynamic!.profiles["dyn-x402-to-mpp"]!));
  expect(fp(changed)).toBe(fp(base));
});

test("dynamic を足しても静的 route の指紋は変わらない", () => {
  const plain = parseRouterConfig(staticPart());
  const withDyn = parseRouterConfig(withDynamic(dynamicOf()));
  expect(fingerprintOf(authoritativeTermsOf(withDyn.routes["md-static"]!))).toBe(
    fingerprintOf(authoritativeTermsOf(plain.routes["md-static"]!)),
  );
});
