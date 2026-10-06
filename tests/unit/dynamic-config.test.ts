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
    // mpp 送信の手数料は quote ごとの cap（ガス代の見積り × feeMargin）で被覆する（`docs/dynamic-gas-fee-design.md` §2）。`fee.min >= maxFee` は要らない。
    fee: { flat: "50000", bps: 100, min: "50000" },
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
  ["mpp 送信で feeMargin が 1 倍未満（署名で必ず止まる quote を出す）", withProfilePatch((profile) => { (profile["destination"] as Record<string, unknown>)["feeMargin"] = 9_999; })],
  ["mpp 送信で feeMargin が 100 倍超", withProfilePatch((profile) => { (profile["destination"] as Record<string, unknown>)["feeMargin"] = 1_000_001; })],
  ["mpp 送信で feeMargin が小数", withProfilePatch((profile) => { (profile["destination"] as Record<string, unknown>)["feeMargin"] = 20_000.5; })],
  ["mpp 送信で feeMargin が文字列", withProfilePatch((profile) => { (profile["destination"] as Record<string, unknown>)["feeMargin"] = "20000"; })],
  ["mpp 送信で feeMargin が null", withProfilePatch((profile) => { (profile["destination"] as Record<string, unknown>)["feeMargin"] = null; })],
  ["mpp 送信で feeAsset が送信資産と違う（手数料の上限を同じ価値で比べられない）", withProfilePatch((profile) => { (profile["destination"] as Record<string, unknown>)["feeAsset"] = USDC; })],
  ["mpp 送信で受信と送信の桁が違う（base units で比べられない）", withProfilePatch((profile) => { (profile["source"] as Record<string, unknown>)["decimals"] = 18; })],
  ["budget が無い", withDynamic((() => { const { budget: _b, ...rest } = dynamicOf(); return rest; })())],
  ["denyHosts が配列でない", withDynamic(dynamicOf({ denyHosts: "router.example.com" }))],
  ["denyHosts に URL", withDynamic(dynamicOf({ denyHosts: ["https://router.example.com/"] }))],
  ["limits に未知の欄", withDynamic(dynamicOf({ limits: { quotesPerMinuteGlobl: 1 } }))],
  ["limits が 0", withDynamic(dynamicOf({ limits: { maxOutstandingQuotes: 0 } }))],
  ["limits が安全な整数の範囲外", withDynamic(dynamicOf({ limits: { maxOutstandingQuotes: 1e100 } }))],
  ["limits が null", withDynamic(dynamicOf({ limits: null }))],
  ["denyHosts が null", withDynamic(dynamicOf({ denyHosts: null }))],
  ["動的予算の maxTotal が負", withDynamic(dynamicOf({ budget: { maxPurchases: 5, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "-1", maxPerPurchase: "1" }] } }))],
  ["動的予算の maxPerPurchase が 0", withDynamic(dynamicOf({ budget: { maxPurchases: 5, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "10", maxPerPurchase: "0" }] } }))],
  ["動的予算の maxPurchases が小数", withDynamic(dynamicOf({ budget: { maxPurchases: 1.5, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "10", maxPerPurchase: "1" }] } }))],
  ["maxUpstreamAmount が 31 桁", withProfilePatch((p) => { p["maxUpstreamAmount"] = "1".repeat(31); })],
  ["maxUpstreamAmount に先頭ゼロ", withProfilePatch((p) => { p["maxUpstreamAmount"] = "0100"; })],
  ["decimals が小数", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), decimals: 6.5 }; })],
  ["maxFee が不正", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), maxFee: "1.5" }; })],
  ["fee.min が不正", withProfilePatch((p) => { p["fee"] = { flat: "0", bps: 0, min: "abc" }; })],
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
    // mpp 送信は受信と送信の桁が同じでなければならないので、両方を一緒に変える。
    ["source.decimals と destination.decimals", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), decimals: 18 }; p["destination"] = { ...(p["destination"] as object), decimals: 18 }; })],
    ["source.payTo", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), payTo: "0x000000000000000000000000000000000000dEaD" }; })],
    ["destination.network", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), network: "eip155:4217" }; })],
    // mpp 送信は feeAsset が送信資産そのものでなければならないので、両方を一緒に変える。
    ["destination.asset と feeAsset", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), asset: USDC, feeAsset: USDC }; })],
    ["destination.decimals（受信と同時に）", withProfilePatch((p) => { p["source"] = { ...(p["source"] as object), decimals: 8 }; p["destination"] = { ...(p["destination"] as object), decimals: 8 }; })],
    ["destination.scheme", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), scheme: "tempo/session" }; })],
    ["destination.maxFee", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), maxFee: "49999" }; })],
    ["maxUpstreamAmount", withProfilePatch((p) => { p["maxUpstreamAmount"] = "100001"; })],
    ["fee.flat", withProfilePatch((p) => { p["fee"] = { flat: "50001", bps: 100, min: "50000" }; })],
    ["fee.bps", withProfilePatch((p) => { p["fee"] = { flat: "50000", bps: 101, min: "50000" }; })],
    ["fee.min", withProfilePatch((p) => { p["fee"] = { flat: "50000", bps: 100, min: "50001" }; })],
    // 手数料の決め方（cap の係数）も支払いの条件（FR-16。`docs/dynamic-gas-fee-design.md` §2）。
    ["destination.feeMargin", withProfilePatch((p) => { p["destination"] = { ...(p["destination"] as object), feeMargin: 30_000 }; })],
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

test("mpp 送信: feeMargin の既定は 20,000（2 倍）、fee.min は maxFee より小さくてよい（被覆は quote ごとの cap）。権威の欄に feeMargin と pricingPolicy", () => {
  const config = parseRouterConfig(withProfilePatch((p) => { (p["fee"] as Record<string, unknown>)["min"] = "0"; (p["fee"] as Record<string, unknown>)["flat"] = "1000"; }));
  const profile = config.dynamic!.profiles["dyn-x402-to-mpp"]!;
  expect(profile.destination.feeMargin).toBe(20_000);
  expect(profile.fee.min).toBe("0");
  const terms = dynamicAuthoritativeTermsOf(config.dynamic!, profile) as { destination: { feeMargin?: number }; pricingPolicy?: string };
  expect(terms.destination.feeMargin).toBe(20_000);
  // v2（2026-10-06）: priority 1 固定・2.4 倍の係数・capPerGas への clamp（`docs/dynamic-gas-fee-design.md` §8）。v1 の quote は指紋が変わって `quote_changed`。
  expect(terms.pricingPolicy).toBe("gas-indexed-v2");
  expect(DEFAULT_DYNAMIC_LIMITS.perAddressPerMinute).toBe(100);
  expect(parseRouterConfig(withProfilePatch((p) => { (p["destination"] as Record<string, unknown>)["feeMargin"] = 1_000_000; })).dynamic!.profiles["dyn-x402-to-mpp"]!.destination.feeMargin).toBe(1_000_000);
});

test("x402 送信の権威の欄は変えない（配備の前の quote を quote_changed にしない）。feeMargin・pricingPolicy は持たない", () => {
  const config = parseRouterConfig(withDynamic(dynamicOf()));
  const profile = config.dynamic!.profiles["dyn-mpp-to-x402"]!;
  // 変更前の直列化（T10 から固定）。
  expect(dynamicAuthoritativeTermsOf(config.dynamic!, profile)).toEqual({
    dynamic: true,
    enabled: true,
    profileId: "dyn-mpp-to-x402",
    sourceRail: "mpp",
    source: { network: "eip155:42431", asset: PATHUSD, decimals: 6, payTo: PAY_TO },
    rail: "x402",
    destination: { scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" }, feeAsset: undefined, maxFee: undefined },
    par: true,
    maxUpstreamAmount: "100000",
    fee: { flat: "0", bps: 0, min: "0" },
  });
  expect(Object.keys(dynamicAuthoritativeTermsOf(config.dynamic!, profile) as object)).not.toContain("pricingPolicy");
});

test("プロファイルの ID・送信レール・tokenDomain の名前も指紋を変える。キーの順序と省略／undefined は変えない", () => {
  const base = parseRouterConfig(withDynamic(dynamicOf()));
  const fpOf = (config: RouterConfig, id: string): string =>
    fingerprintOf(dynamicAuthoritativeTermsOf(config.dynamic!, config.dynamic!.profiles[id]!));
  const x402Base = fpOf(base, "dyn-mpp-to-x402");

  // 同じ中身で ID だけ違うプロファイル。
  const renamed = parseRouterConfig(withDynamic(dynamicOf({ profiles: { renamed: { ...mppToX402(), profileId: "renamed" } } })));
  expect(fpOf(renamed, "renamed")).not.toBe(x402Base);
  // tokenDomain の名前。
  const named = parseRouterConfig(
    withDynamic(dynamicOf({ profiles: { "dyn-mpp-to-x402": { ...mppToX402(), destination: { ...(mppToX402()["destination"] as object), tokenDomain: { name: "USD Coin", version: "2" } } } } })),
  );
  expect(fpOf(named, "dyn-mpp-to-x402")).not.toBe(x402Base);
  // 送信レール（x402 → mpp。mpp に必要な欄も足す）。
  const railChanged = parseRouterConfig(
    withDynamic(dynamicOf({ profiles: { "dyn-mpp-to-x402": { ...mppToX402(), rail: "mpp", destination: { ...(mppToX402()["destination"] as object), feeAsset: USDC, maxFee: "0" } } } })),
  );
  expect(fpOf(railChanged, "dyn-mpp-to-x402")).not.toBe(x402Base);

  // キーの順序を逆にしても同じ。
  const reversed = (value: unknown): unknown =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
      : value;
  const reordered = parseRouterConfig(withDynamic(dynamicOf({ profiles: { "dyn-mpp-to-x402": reversed(mppToX402()) } })));
  expect(fpOf(reordered, "dyn-mpp-to-x402")).toBe(x402Base);
  // そのレールで使わない欄は解析で落ちるので、書いても書かなくても同じ。
  const extra = parseRouterConfig(
    withDynamic(dynamicOf({ profiles: { "dyn-mpp-to-x402": { ...mppToX402(), destination: { ...(mppToX402()["destination"] as object), feeAsset: undefined } } } })),
  );
  expect(fpOf(extra, "dyn-mpp-to-x402")).toBe(x402Base);
});

test("自分のプロパティとしての `constructor` は ID として引ける（継承したものは引けない）", () => {
  const config = parseRouterConfig(
    withDynamic(dynamicOf({ profiles: { constructor: { ...x402ToMpp(), profileId: "constructor" } } })),
  );
  expect(resolveProfile(config, "constructor")?.profileId).toBe("constructor");
  expect(resolveProfile(config, "hasOwnProperty")).toBeUndefined();
});

test("頻度の上限・拒否ホスト・動的予算は指紋に入らない（支払いの条件ではない）", () => {
  const base = parseRouterConfig(withDynamic(dynamicOf()));
  const changed = parseRouterConfig(
    withDynamic(
      dynamicOf({
        limits: { maxOutstandingQuotes: 7 },
        denyHosts: ["other.example.com"],
        budget: { maxPurchases: 99, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "5", maxPerPurchase: "5" }] },
      }),
    ),
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
