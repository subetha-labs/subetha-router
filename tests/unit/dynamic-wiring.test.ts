/**
 * 動的上流 URL の配線と本番の入口（設計 §1.1・§3.1、タスク T13）。
 *
 * - `composeRails`: プロファイルが送信・受信の adapter まで届き、動的経路の transport が loopback 不可・DNS の期限・門つきであること
 * - `tools/remote-mcp.ts` の `routerConfigOf`: どの env を与えても `dynamic.enabled === false` で、その設定で動的 quote が外部接続 0 で拒否されること
 * 鍵は乱数、接続は fixture の差し替えで閉じる（外へは出ない）。
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createClient, custom, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import { DynamicChallengeError } from "../../src/adapters/outbound/x402-dynamic.js";
import { loadRuntimeConfig, parseRouterConfig, type RouterConfig } from "../../src/config.js";
import { createRouterCore } from "../../src/core/orchestrator.js";
import { composeRails, dynamicCoreOptionsOf, type RouterCapabilities } from "../../src/main.js";
import { createGuardedTransport, type GuardedTransportOptions, type TransportEvent } from "../../src/net/guarded-fetch.js";
import { DynamicTargetUnsupportedError, type EvmSigningCapability, type MppTempoCapability } from "../../src/ports/outbound.js";
import { routerConfigOf } from "../../tools/remote-mcp-config.js";
import { dialTo, publicLookup, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
import { createPayerSpy } from "../fixtures/mpp-payer-spy.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const RECEIVER = "0x00000000000000000000000000000000000000b0";
const FACILITATOR = "https://facilitator.test/";
const UPSTREAM_A = "https://provider-a.test/v1/eth/snapshot";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profiles(mppToX402 = true): Record<string, unknown> {
  return {
    "dyn-x402-to-mpp": {
      profileId: "dyn-x402-to-mpp",
      sourceRail: "x402",
      source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER },
      rail: "mpp",
      destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "5000" },
      par: true,
      maxUpstreamAmount: "10000",
      fee: { flat: "1000", bps: 0, min: "1000" },
    },
    ...(mppToX402
      ? {
          "dyn-mpp-to-x402": {
            profileId: "dyn-mpp-to-x402",
            sourceRail: "mpp",
            source: { network: "eip155:42431", asset: PATHUSD, decimals: 6, payTo: RECEIVER },
            rail: "x402",
            destination: { scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
            par: true,
            maxUpstreamAmount: "10000",
            fee: { flat: "1000", bps: 0, min: "1000" },
          },
        }
      : {}),
  };
}

function envFor(options: { dynamic?: boolean; enabled?: boolean; mode?: "real" | "synthetic"; mppSecret?: boolean } = {}): Record<string, string> {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "t13-wiring-"));
  dirs.push(dir);
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: {
        "r-mpp": {
          routeId: "r-mpp",
          canonicalPath: "/v1/routes/r-mpp/resource",
          rail: "mpp",
          sourceRail: "x402",
          source: { amount: "10000", asset: USDC, decimals: 6, network: "eip155:84532", payTo: RECEIVER },
          destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, payTo: "0x00000000000000000000000000000000000000b1" },
        },
      },
      budget: { maxPurchases: 8, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }, { network: "eip155:42431", asset: PATHUSD, maxTotal: "100000", maxPerPurchase: "20000" }] },
      ...(options.dynamic === false
        ? {}
        : {
            dynamic: {
              enabled: options.enabled ?? true,
              profiles: profiles(),
              budget: { maxPurchases: 8, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }, { network: "eip155:42431", asset: PATHUSD, maxTotal: "100000", maxPerPurchase: "20000" }] },
              denyHosts: ["denied.test"],
            },
          }),
    },
    ...(options.mode === "synthetic"
      ? { synthetic: { facilitatorUrl: "http://127.0.0.1:1", upstreams: { "r-mpp": "http://127.0.0.1:1/x" } } }
      : { x402: { upstreams: { "r-mpp": UPSTREAM_A } } }),
  };
  const file = path.join(dir, "router.config.json");
  writeFileSync(file, JSON.stringify(document));
  return {
    ROUTER_CONFIG_PATH: file,
    ROUTER_PRINCIPAL_TOKENS: "a:b",
    ROUTER_ADAPTER_MODE: options.mode ?? "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha-facilitator.test",
    ROUTER_X402_INBOUND_FACILITATOR_URL: FACILITATOR,
    ...(options.mppSecret === false ? {} : { ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-secret" }),
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
  };
}

function realMpp(transport: "http" | "custom" = "http"): MppTempoCapability {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    chainId: 42431,
    account,
    getClient: () => createClient({ transport: transport === "http" ? http("https://rpc.test", { retryCount: 0 }) : custom({ request: async () => null }) }),
    mode: "push",
    kind: "real-key",
  };
}

const REAL_EVM: EvmSigningCapability = createSignerSpy().capability("eip155:84532");

/** 試験用の動的 transport: 本番と同じ選択肢に、宛先の差し替え（表に無いホストは接続しない）を足す。 */
function transportForTest(seen: GuardedTransportOptions[]): NonNullable<RouterCapabilities["dynamicTransportForTest"]> {
  return (base) => {
    seen.push(base);
    return createGuardedTransport({ ...base, interfaces: () => [], lookup: publicLookup(), dialForTest: dialTo({}) });
  };
}

function compose(env: Record<string, string>, capabilities: RouterCapabilities) {
  const events: TransportEvent[] = [];
  const config = loadRuntimeConfig(env, (file) => readFileSync(file, "utf8"));
  return { rails: composeRails(config, capabilities, (event) => events.push(event)), events, config };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("composeRails（動的の配線）", () => {
  test("プロファイルが送信 adapter の動的経路まで届く（target が転送され、接続は判定のあと差し替え先で止まる）", async () => {
    const seen: GuardedTransportOptions[] = [];
    const { rails } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportForTest: transportForTest(seen) });
    // 動的経路に届いた証拠: DynamicTargetUnsupportedError ではなく、接続の段階（差し替え先が無い）で失敗する。
    for (const profileId of ["dyn-x402-to-mpp", "dyn-mpp-to-x402"]) {
      const error = await errorOf(rails.outbound.readChallenge(profileId, { url: "https://provider.test/v1/price" }));
      expect(error).not.toBeInstanceOf(DynamicTargetUnsupportedError);
      expect(String((error as { cause?: { cause?: unknown } }).cause ?? error)).not.toBe("");
    }
    // 静的 route の id に target を渡しても、プロファイルではないので動的経路は使えない（静的の URL に落ちない）。
    expect(String(await errorOf(rails.outbound.readChallenge("r-mpp", { url: "https://provider.test/" })))).toContain("no dynamic mpp profile");
    // 動的用 transport は本番の選択肢で組まれている。
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ allowLoopback: false, maxHeaderSize: 32 * 1024, dns: { timeoutMs: 3_000, maxInFlight: 16 } });
    expect(typeof seen[0]!.admit).toBe("function");
    expect(rails.dynamic).toBeDefined();
  });

  test("拒否ホスト: 設定の値に加えて、facilitator・上流・自分の canonical のホストには向けない（接続 0）", async () => {
    const seen: GuardedTransportOptions[] = [];
    const { rails } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportForTest: transportForTest(seen) });
    for (const url of ["https://denied.test/x", "https://api.denied.test/x", "https://facilitator.test/verify", "https://subetha-facilitator.test/x", "https://provider-a.test/v1/eth/snapshot", "https://router.test/v1/routes"]) {
      const error = await errorOf(rails.outbound.readChallenge("dyn-mpp-to-x402", { url }));
      expect(error).toBeInstanceOf(DynamicChallengeError);
      expect((error as DynamicChallengeError).reason).toBe("url");
    }
  });

  test("受信: プロファイルの offer が作れ、束縛（dynamic|…）から受信 adapter が引ける。x402 受信は署名を quote に束縛する", async () => {
    const seen: GuardedTransportOptions[] = [];
    const { rails } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportForTest: transportForTest(seen) });
    const binding = `dynamic|dyn-x402-to-mpp|GET|${encodeURIComponent("https://provider.test/v1/price")}`;
    const offer = await rails.inbound.createOffer({ routeId: "dyn-x402-to-mpp", amount: "11000", asset: USDC, network: "eip155:84532", routeBinding: binding, nowMs: Date.now() });
    expect(offer).toMatchObject({ amount: "11000", payTo: RECEIVER, extra: { routeBinding: binding } });
    // 束縛つき adapter: authorization の無い credential は preflight で credential_mismatch（静的の x402 受信なら通る形）。
    const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0x00" } };
    expect(rails.inbound.preflight(offer, credential, Date.now())).toEqual({ ok: false, reason: "credential_mismatch" });
    // 知らないプロファイルの束縛は引けない。
    const foreign = { ...offer, extra: { ...offer.extra, routeBinding: `dynamic|nope|GET|${encodeURIComponent("https://provider.test/")}` } };
    expect(() => rails.inbound.preflight(foreign, { ...credential, accepted: foreign }, Date.now())).toThrow("no inbound rail");
    // MPP 受信のプロファイルも offer を作れる（HMAC の challenge）。
    const mppOffer = await rails.inbound.createOffer({ routeId: "dyn-mpp-to-x402", amount: "11000", asset: PATHUSD, network: "eip155:42431", routeBinding: binding.replace("dyn-x402-to-mpp", "dyn-mpp-to-x402"), nowMs: Date.now() });
    expect(mppOffer.payTo.toLowerCase()).toBe(RECEIVER);
  });

  test.each([
    ["loopback を許す transport を返す fixture", (base: GuardedTransportOptions) => createGuardedTransport({ ...base, allowLoopback: true }), "loopback"],
    ["DNS の期限を落とした transport を返す fixture", (base: GuardedTransportOptions) => { const { dns: _d, ...rest } = base; return createGuardedTransport(rest); }, "bound DNS"],
  ])("動的用 transport の条件: %s → 起動失敗", (_name, make, message) => {
    expect(() => compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportForTest: make })).toThrow(message);
  });

  test("MPP 能力の条件: pull・JSON-RPC account・fixture 能力は起動失敗、custom transport の client は起動時の確認で失敗", async () => {
    const seen: GuardedTransportOptions[] = [];
    const base = { evmSigning: REAL_EVM, dynamicTransportForTest: transportForTest(seen) };
    expect(() => compose(envFor(), { ...base, mppTempo: { ...realMpp(), mode: "pull" } })).toThrow("push");
    expect(() => compose(envFor(), { ...base, mppTempo: createPayerSpy().capability() })).toThrow(/local account|non-signing fixture|push/);
    const { rails } = compose(envFor(), { ...base, mppTempo: realMpp("custom") });
    await expect(rails.dynamic!.verify()).rejects.toThrow("plain http transport");
    const ok = compose(envFor(), { ...base, mppTempo: realMpp("http") });
    await expect(ok.rails.dynamic!.verify()).resolves.toBeUndefined();
  });

  test("合成レールに動的の設定は組めない。設定に dynamic が無ければ配線は従来どおり（動的の transport を作らない）", () => {
    expect(() => compose(envFor({ mode: "synthetic" }), {})).toThrow("synthetic");
    const seen: GuardedTransportOptions[] = [];
    const { rails } = compose(envFor({ dynamic: false }), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportForTest: transportForTest(seen) });
    expect(seen).toHaveLength(0);
    expect(rails.dynamic).toBeUndefined();
  });

  test("残高の検査は、全プロファイルの能力が balanceOf を持つときだけ core に渡す", () => {
    const seen: GuardedTransportOptions[] = [];
    const withBalance = { ...realMpp(), balanceOf: async () => 1n };
    const { rails, config } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: withBalance, dynamicTransportForTest: transportForTest(seen) });
    // x402 の能力は balanceOf を持たないので渡さない。
    expect(dynamicCoreOptionsOf(rails.dynamic!, { evmSigning: REAL_EVM, mppTempo: withBalance }, config).balanceOf).toBeUndefined();
    const evmWithBalance = { ...REAL_EVM, balanceOf: async () => 2n };
    expect(dynamicCoreOptionsOf(rails.dynamic!, { evmSigning: evmWithBalance, mppTempo: withBalance }, config).balanceOf).toBeDefined();
  });
});

test("静的検査: 本番の入口と tools は宛先の差し替え（dialForTest）を参照しない（設計 §3.1）", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const files = [path.join(root, "src/main.ts"), ...readdirSync(path.join(root, "tools")).filter((name) => name.endsWith(".ts")).map((name) => path.join(root, "tools", name))];
  for (const file of files) {
    expect(readFileSync(file, "utf8"), file).not.toContain("dialForTest");
  }
});

describe("本番の入口（tools/remote-mcp.ts の routerConfigOf）", () => {
  const envs: Record<string, string | undefined>[] = [
    {},
    { SUBETHA_DYNAMIC_ENABLED: "true", DYNAMIC_ENABLED: "1", ROUTER_DYNAMIC: "yes" },
    { SUBETHA_DYNAMIC_MAX_PURCHASES: "5", SUBETHA_DYNAMIC_MAX_TOTAL: "123456", SUBETHA_MAX_PURCHASES: "7", SUBETHA_APPROVAL_TTL_SECONDS: "30" },
    { enabled: "true", "dynamic.enabled": "true" },
  ];

  test.each(envs.map((env, index) => [index, env] as const))("どの env（%i）でも dynamic.enabled === false で、設定は検証を通る", (_index, env) => {
    for (const mppInbound of [true, false]) {
      const raw = routerConfigOf(env, RECEIVER, mppInbound) as { router: unknown };
      const parsed = parseRouterConfig(raw.router);
      expect(parsed.dynamic?.enabled).toBe(false);
      expect(Object.keys(parsed.dynamic!.profiles).sort()).toEqual(mppInbound ? ["dyn-mpp-to-x402", "dyn-x402-to-mpp"] : ["dyn-x402-to-mpp"]);
      expect(parsed.dynamic!.profiles["dyn-x402-to-mpp"]).toMatchObject({ destination: { maxFee: "5000", feeAsset: PATHUSD }, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } });
    }
  });

  test("その設定で動的 quote は外部接続 0 で拒否される（dynamic_disabled）。静的 route はそのまま", async () => {
    const raw = routerConfigOf({}, RECEIVER, true) as { router: unknown };
    const config: RouterConfig = parseRouterConfig(raw.router);
    mkdirSync(runtimeRoot, { recursive: true });
    const dir = mkdtempSync(path.join(runtimeRoot, "t13-entry-"));
    dirs.push(dir);
    let connections = 0;
    const core = await createRouterCore({
      journalPath: path.join(dir, "journal.ndjson"),
      config,
      inbound: { createOffer: async () => { connections += 1; throw new Error("x"); }, preflight: () => ({ ok: true }), verify: async () => { connections += 1; return { isValid: true }; }, settle: async () => { connections += 1; return { outcome: "unknown", reason: "x" }; } },
      outbound: { readChallenge: async () => { connections += 1; return []; }, pay: async () => { connections += 1; return { outcome: "unknown", reason: "x" }; } },
      dynamic: { ledgerDir: path.join(dir, "dynamic-quotes") },
    });
    try {
      for (const profileId of ["dyn-x402-to-mpp", "dyn-mpp-to-x402"]) {
        expect(await core.quote({ principalId: "judge", requestId: `r-${profileId}`, routeId: profileId, upstream: { url: "https://provider.test/v1/price" }, source: "s" })).toEqual({ ok: false, code: "dynamic_disabled" });
      }
      expect(connections).toBe(0);
    } finally {
      await core.close();
    }
  });
});
