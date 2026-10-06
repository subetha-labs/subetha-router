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
import { composeRails, dynamicCoreOptionsOf, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
import { TransportError, type TransportEvent } from "../../src/net/guarded-fetch.js";
import { DynamicTargetUnsupportedError, type EvmSigningCapability, type MppTempoCapability } from "../../src/ports/outbound.js";
import { routerConfigOf } from "../../tools/remote-mcp-config.js";
import { publicLookup, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
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

function envFor(options: { dynamic?: boolean; enabled?: boolean; mode?: "real" | "synthetic"; mppSecret?: boolean; perAddressPerMinute?: number } = {}): Record<string, string> {
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
              ...(options.perAddressPerMinute === undefined ? {} : { limits: { perAddressPerMinute: options.perAddressPerMinute } }),
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

function realMpp(transport: "http" | "custom" = "http", rpcUrl = "https://rpc.test"): MppTempoCapability {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    chainId: 42431,
    account,
    getClient: () => createClient({ transport: transport === "http" ? http(rpcUrl, { retryCount: 0 }) : custom({ request: async () => null }) }),
    mode: "push",
    kind: "real-key",
  };
}

const REAL_EVM: EvmSigningCapability = createSignerSpy().capability("eip155:84532");

/**
 * 試験用の差し替え: 名前解決は公開アドレスを返し、接続先は**記録してから接続を断る**（表に無いホストと同じ失敗）。
 * 方針の欄（loopback 不可・DNS 期限・ヘッダ上限・門）は配線が重ねるので、ここからは変えられない。
 */
function hooks(dialed: string[]): DynamicTransportHooks {
  return {
    interfaces: () => [],
    lookup: publicLookup(),
    dialForTest: (target) => {
      dialed.push(target.hostname);
      throw new UnmappedFixtureHostError();
    },
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

const DEPENDENCIES = { dependencyUrls: ["https://rpc.test/"] };

describe("composeRails（動的の配線）", () => {
  test("プロファイルが送信 adapter の動的経路まで届き、target の URL のホストに接続しようとする（判定のあと、差し替え先で止まる）", async () => {
    const dialed: string[] = [];
    const { rails } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportHooksForTest: hooks(dialed), ...DEPENDENCIES });
    for (const profileId of ["dyn-x402-to-mpp", "dyn-mpp-to-x402"]) {
      const error = await errorOf(rails.outbound.readChallenge(profileId, { url: "https://provider.test/v1/price" }));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DynamicTargetUnsupportedError);
    }
    // 両レールとも、渡した URL のホストへ接続しようとした（差し替え先が無いので接続は断られた）。
    expect(dialed).toEqual(["provider.test", "provider.test"]);
    // 静的 route の id に target を渡しても、プロファイルではないので動的経路は使えない（静的の URL に落ちない）。
    expect(String(await errorOf(rails.outbound.readChallenge("r-mpp", { url: "https://provider.test/" })))).toContain("no dynamic mpp profile");
    expect(dialed).toHaveLength(2);
    expect(rails.dynamic).toBeDefined();
  });

  test("動的用 transport の方針は fixture から変えられない: 門の admit・ヘッダ上限・DNS 期限・loopback 不可は配線が重ねる", async () => {
    const dialed: string[] = [];
    // fixture が方針の欄を渡しても（型の外から）、配線の値が勝つ。
    const weakening = { ...hooks(dialed), allowLoopback: true, dns: undefined, admit: undefined, maxHeaderSize: 1 } as unknown as DynamicTransportHooks;
    const { rails } = compose(envFor({ perAddressPerMinute: 1 }), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportHooksForTest: weakening, ...DEPENDENCIES });
    // 1 回目は門を通って接続まで進む（差し替え先が無いので断られる）。2 回目は同じアドレスの枠が無く、接続の前に拒否される。
    await errorOf(rails.outbound.readChallenge("dyn-mpp-to-x402", { url: "https://provider.test/v1/price" }));
    const second = await errorOf(rails.outbound.readChallenge("dyn-mpp-to-x402", { url: "https://provider.test/v1/other" }));
    expect(dialed).toEqual(["provider.test"]);
    expect(second).toBeInstanceOf(TransportError);
    expect((second as TransportError).code).toBe("admission_refused");
  });

  test("拒否ホスト: 設定の値・facilitator・上流・自分の canonical・受信 MPP の RPC・能力の依存先には向けない（接続 0）", async () => {
    const dialed: string[] = [];
    const { rails } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportHooksForTest: hooks(dialed), ...DEPENDENCIES });
    for (const url of [
      "https://denied.test/x",
      "https://api.denied.test/x",
      "https://facilitator.test/verify",
      "https://subetha-facilitator.test/x",
      "https://provider-a.test/v1/eth/snapshot",
      "https://router.test/v1/routes",
      "https://rpc.moderato.tempo.xyz/",
      "https://sub.rpc.moderato.tempo.xyz/",
      "https://rpc.test/",
      "https://x.rpc.test/",
    ]) {
      const error = await errorOf(rails.outbound.readChallenge("dyn-mpp-to-x402", { url }));
      expect(error, url).toBeInstanceOf(DynamicChallengeError);
      expect((error as DynamicChallengeError).reason, url).toBe("url");
    }
    expect(dialed).toEqual([]);
  });

  test("受信 MPP の RPC を設定したときは、そのホストが拒否される（既知の公開 RPC の代わりに）", async () => {
    const dialed: string[] = [];
    const { rails } = compose({ ...envFor(), ROUTER_MPP_INBOUND_RPC_URL: "https://inbound-rpc.test/" }, { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportHooksForTest: hooks(dialed), ...DEPENDENCIES });
    expect((await errorOf(rails.outbound.readChallenge("dyn-mpp-to-x402", { url: "https://inbound-rpc.test/x" })) as DynamicChallengeError).reason).toBe("url");
  });

  test("起動時の確認: 能力の RPC ホストが拒否ホストに無ければ起動しない", async () => {
    const dialed: string[] = [];
    const { rails } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportHooksForTest: hooks(dialed) });
    await expect(rails.dynamic!.verify()).rejects.toThrow("dependencyUrls");
    const declared = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportHooksForTest: hooks(dialed), ...DEPENDENCIES });
    await expect(declared.rails.dynamic!.verify()).resolves.toBeUndefined();
  });

  test("受信: プロファイルの offer が作れ、束縛（dynamic|…）から受信 adapter が引け、facilitator・RPC への接続は動的用 transport を通る", async () => {
    const dialed: string[] = [];
    const { rails } = compose(envFor(), { evmSigning: REAL_EVM, mppTempo: realMpp(), dynamicTransportHooksForTest: hooks(dialed), ...DEPENDENCIES });
    const binding = `dynamic|dyn-x402-to-mpp|GET|${encodeURIComponent("https://provider.test/v1/price")}`;
    const offer = await rails.inbound.createOffer({ routeId: "dyn-x402-to-mpp", amount: "11000", asset: USDC, network: "eip155:84532", routeBinding: binding, nowMs: Date.now() });
    expect(offer).toMatchObject({ amount: "11000", payTo: RECEIVER, extra: { routeBinding: binding } });
    // 束縛つき adapter: authorization の無い credential は preflight で credential_mismatch（静的の x402 受信なら通る形）。
    const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0x00" } };
    expect(rails.inbound.preflight(offer, credential, Date.now())).toEqual({ ok: false, reason: "credential_mismatch" });
    // verify は facilitator（facilitator.test）へ、動的用 transport（差し替えつき）で出る。
    await errorOf(rails.inbound.verify(offer, credential, { routeId: "dyn-x402-to-mpp" }));
    expect(dialed).toEqual(["facilitator.test"]);
    // 知らないプロファイルの束縛は引けない。
    const foreign = { ...offer, extra: { ...offer.extra, routeBinding: `dynamic|nope|GET|${encodeURIComponent("https://provider.test/")}` } };
    expect(() => rails.inbound.preflight(foreign, { ...credential, accepted: foreign }, Date.now())).toThrow("no inbound rail");
    // MPP 受信のプロファイル: offer（HMAC の challenge）が作れ、verify の RPC は受信 RPC（既知の公開 RPC のホスト名）へ動的用 transport で出る。
    const mppBinding = binding.replace("dyn-x402-to-mpp", "dyn-mpp-to-x402");
    const mppOffer = await rails.inbound.createOffer({ routeId: "dyn-mpp-to-x402", amount: "11000", asset: PATHUSD, network: "eip155:42431", routeBinding: mppBinding, nowMs: Date.now() });
    expect(mppOffer.payTo.toLowerCase()).toBe(RECEIVER);
    // （MPP 受信の RPC が動的用 transport を通ることは、実 SDK の credential が要るので T14 で確かめる）
  });

  test("MPP 能力の条件: pull・JSON-RPC account・fixture 能力は起動失敗、custom transport の client は起動時の確認で失敗", async () => {
    const dialed: string[] = [];
    const base = { evmSigning: REAL_EVM, dynamicTransportHooksForTest: hooks(dialed), ...DEPENDENCIES };
    expect(() => compose(envFor(), { ...base, mppTempo: { ...realMpp(), mode: "pull" } })).toThrow("push");
    expect(() => compose(envFor(), { ...base, mppTempo: createPayerSpy().capability() })).toThrow(/local account|non-signing fixture|push/);
    const { rails } = compose(envFor(), { ...base, mppTempo: realMpp("custom") });
    await expect(rails.dynamic!.verify()).rejects.toThrow("plain http transport");
    const ok = compose(envFor(), { ...base, mppTempo: realMpp("http") });
    await expect(ok.rails.dynamic!.verify()).resolves.toBeUndefined();
  });

  test("合成レールに動的の設定は組めない。設定に dynamic が無ければ配線は従来どおり（動的の transport を作らない）", () => {
    expect(() => compose(envFor({ mode: "synthetic" }), {})).toThrow("synthetic");
    const { rails } = compose(envFor({ dynamic: false }), { evmSigning: REAL_EVM, mppTempo: realMpp() });
    expect(rails.dynamic).toBeUndefined();
  });

  test("残高の検査は、全プロファイルの能力が balanceOf を持つときだけ core に渡し、渡したものは能力の値を返す", async () => {
    const dialed: string[] = [];
    const mppWithBalance = { ...realMpp(), balanceOf: async () => 1n };
    const partial = { evmSigning: REAL_EVM, mppTempo: mppWithBalance, dynamicTransportHooksForTest: hooks(dialed), ...DEPENDENCIES };
    const one = compose(envFor(), partial);
    // x402 の能力は balanceOf を持たないので渡さない。
    expect(dynamicCoreOptionsOf(one.rails.dynamic!, partial, one.config).balanceOf).toBeUndefined();
    const evmWithBalance = { ...REAL_EVM, balanceOf: async () => 2n };
    const full = { ...partial, evmSigning: evmWithBalance };
    const two = compose(envFor(), full);
    const balanceOf = dynamicCoreOptionsOf(two.rails.dynamic!, full, two.config).balanceOf;
    expect(balanceOf).toBeDefined();
    expect(await balanceOf!("dyn-mpp-to-x402", USDC)).toBe(2n);
    expect(await balanceOf!("dyn-x402-to-mpp", PATHUSD)).toBe(1n);
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
    { enabled: "true", "dynamic.enabled": "true", SUBETHA_DENY_HOSTS: "evil.test, Other.Test" },
  ];

  test.each(envs.map((env, index) => [index, env] as const))("どの env（%i）でも dynamic.enabled === false で、設定は検証を通る", (_index, env) => {
    for (const mppInbound of [true, false]) {
      const raw = routerConfigOf(env, RECEIVER, mppInbound) as { router: unknown };
      const parsed = parseRouterConfig(raw.router);
      expect(parsed.dynamic?.enabled).toBe(false);
      expect(Object.keys(parsed.dynamic!.profiles).sort()).toEqual(mppInbound ? ["dyn-mpp-to-x402", "dyn-x402-to-mpp"] : ["dyn-x402-to-mpp"]);
      // G-1（2026-10-06 の owner の決定）: MPP 送信は定額 2,000、x402 送信は定額 1,000。
      expect(parsed.dynamic!.profiles["dyn-x402-to-mpp"]).toMatchObject({ destination: { maxFee: "5000", feeAsset: PATHUSD }, maxUpstreamAmount: "10000", fee: { flat: "2000", bps: 0, min: "2000" } });
      if (mppInbound) expect(parsed.dynamic!.profiles["dyn-mpp-to-x402"]).toMatchObject({ maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } });
      // 自分の公開ホスト名は拒否ホストに入る（canonical は内部の URL なので配線では分からない）。
      expect(parsed.dynamic!.denyHosts).toContain("router.subethalabs.com");
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
