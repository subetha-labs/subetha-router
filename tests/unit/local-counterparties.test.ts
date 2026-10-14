/**
 * 能力 `localCounterparties`（`docs/evm-testnets-x402-design.md` §3.5、SR-E2、AC-E5、タスク E-4）:
 * origin の形の検査、起動時の拒否（allowlist に無い loopback・一部だけの送信の組）、要求ごとの origin の完全一致（送出の前に拒否）、
 * redirect の拒否、EVM testnet 以外・動的上流・能力の無い構成には効かないこと。
 */
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { ConfigError, loadRuntimeConfig, routeBindingOf, type RuntimeConfig } from "../../src/config.js";
import { composeRails, isLoopbackUrl, localCounterpartyOriginsOf, localCounterpartyPlanOf, originPinnedTransport, transportFor, type RouterCapabilities } from "../../src/main.js";
import { TransportError, type TransportEvent } from "../../src/net/guarded-fetch.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { EVM_TESTNETS, evmTestnetsConfigOf, INBOUND, type EvmTestnetChain } from "../../tools/remote-mcp-config.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const BASE = "eip155:84532";
const RH = EVM_TESTNETS.rh;

/** 接続と要求を数える loopback の HTTP の相手。`redirectTo` があれば 302 でそこへ向ける。 */
interface Counterparty {
  readonly origin: string;
  readonly port: number;
  connections: number;
  requests: string[];
  redirectTo?: string | undefined;
  close(): Promise<void>;
}
async function startCounterparty(): Promise<Counterparty> {
  const state = { connections: 0, requests: [] as string[], redirectTo: undefined as string | undefined };
  const server = http.createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => {
      if (state.redirectTo !== undefined) {
        response.writeHead(302, { location: state.redirectTo });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ isValid: true }));
    });
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  }) as Counterparty;
}

let a: Counterparty;
let b: Counterparty;
beforeAll(async () => {
  a = await startCounterparty();
  b = await startCounterparty();
});
afterAll(async () => {
  await a.close();
  await b.close();
});
afterEach(() => {
  a.redirectTo = undefined;
  b.redirectTo = undefined;
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("origin の形（localCounterpartyOriginsOf）", () => {
  test("http://127.0.0.1:<port> の literal だけ。能力が無ければ undefined", () => {
    expect(localCounterpartyOriginsOf(undefined)).toBeUndefined();
    expect([...localCounterpartyOriginsOf({ origins: ["http://127.0.0.1:8611", "http://127.0.0.1:65535", "http://127.0.0.1:1"] })!]).toEqual(["http://127.0.0.1:8611", "http://127.0.0.1:65535", "http://127.0.0.1:1"]);
    expect(localCounterpartyOriginsOf({ origins: [] })!.size).toBe(0);
  });

  test.each([
    "http://localhost:8611",
    "http://127.0.0.1",
    "http://127.0.0.1:80",
    "http://127.0.0.1:8611/",
    "http://127.0.0.1:8611/tok",
    "https://127.0.0.1:8611",
    "http://127.0.0.2:8611",
    "http://127.1:8611",
    "http://[::1]:8611",
    "http://127.0.0.1:0",
    "http://127.0.0.1:08611",
    "http://127.0.0.1:65536",
    "http://user@127.0.0.1:8611",
    "http://127.0.0.1:8611?x=1",
    " http://127.0.0.1:8611",
    "HTTP://127.0.0.1:8611",
  ])("%s は起動しない（ConfigError、値はメッセージに出さない）", (origin) => {
    let caught: unknown;
    try {
      localCounterpartyOriginsOf({ origins: ["http://127.0.0.1:8611", origin] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toMatch(/localCounterparties\.origins\[#2\] must be exactly http:\/\/127\.0\.0\.1:<port>/);
    // 値は写さない（固定文の `http://127.0.0.1:<port>` に含まれる文字列そのものは除く）。
    if (!"http://127.0.0.1:<port>".includes(origin.trim())) expect((caught as Error).message).not.toContain(origin.trim());
  });

  test("型の誤り（配列でない・文字列でない）も起動しない", () => {
    expect(() => localCounterpartyOriginsOf({ origins: "http://127.0.0.1:8611" as never })).toThrow(ConfigError);
    expect(() => localCounterpartyOriginsOf({ origins: [8611 as never] })).toThrow(ConfigError);
  });

  test("loopback の literal の判定（127.0.0.0/8・::1・IPv4-mapped・localhost）。名前は解決しない", () => {
    for (const url of ["http://127.0.0.1:1/", "http://127.9.9.9/", "http://[::1]:8/", "http://[::ffff:127.0.0.1]/", "http://localhost/", "http://LOCALHOST./x", "http://api.localhost/"]) expect(isLoopbackUrl(url), url).toBe(true);
    for (const url of ["https://www.x402.org/facilitator", "http://10.0.0.1/", "http://[::2]/", "http://localhost.example/", "not a url"]) expect(isLoopbackUrl(url), url).toBe(false);
  });
});

/** EVM testnet の設定（facilitator・Provider は与えた URL）を本番と同じ読み込みで。 */
function runtimeConfigOf(options: { facilitator: string; providers: Partial<Record<EvmTestnetChain, string>>; chains?: EvmTestnetChain[]; baseFacilitator?: string; mutate?: (document: any) => void }): RuntimeConfig {
  const chains = options.chains ?? ["rh"];
  const env = {
    SUBETHA_EVM_FACILITATOR_URL: options.facilitator,
    SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER,
    ...Object.fromEntries(chains.map((chain) => [`SUBETHA_EVM_PROVIDER_URL_${chain.toUpperCase()}`, options.providers[chain] ?? "https://provider.example/v1/eth/snapshot"])),
  };
  const document = evmTestnetsConfigOf(env, RECEIVER, chains) as any;
  options.mutate?.(document);
  const dir = mkdtempSync(path.join(tmpdir(), "local-counterparties-"));
  dirs.push(dir);
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  return loadRuntimeConfig(
    {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
      ROUTER_X402_INBOUND_FACILITATOR_URL: options.baseFacilitator ?? INBOUND.facilitator,
    },
    (file) => readFileSync(file, "utf8"),
  );
}

function capabilitiesOf(chains: EvmTestnetChain[], origins?: string[]): RouterCapabilities {
  const evm = createRealEvmCapability(generatePrivateKey());
  return {
    evmSigning: evm.capability(BASE),
    evmSigningByNetwork: Object.fromEntries(chains.map((chain) => [EVM_TESTNETS[chain].network, evm.capability(EVM_TESTNETS[chain].network)])),
    ...(origins === undefined ? {} : { localCounterparties: { origins } }),
  };
}

const compose = (config: RuntimeConfig, capabilities: RouterCapabilities, events: TransportEvent[] = []) => composeRails(config, capabilities, (event) => events.push(event), () => {});

describe("起動時の拒否（composeRails。fetch 時の拒否に任せない）", () => {
  test("allowlist に無い loopback の受信 facilitator → 起動しない（接続は 0）", () => {
    const before = a.connections;
    const config = runtimeConfigOf({ facilitator: `${a.origin}/tok`, providers: {} });
    expect(() => compose(config, capabilitiesOf(["rh"], [b.origin]))).toThrow(/routes\.md-x402-eth-snapshot-rh: the inbound facilitator is a loopback address that RouterCapabilities\.localCounterparties does not list/);
    // 名前の loopback（`localhost`）も literal でなければ allowlist に入れられないので起動しない。
    const named = runtimeConfigOf({ facilitator: `http://localhost:${a.port}/tok`, providers: {} });
    expect(() => compose(named, capabilitiesOf(["rh"], [a.origin]))).toThrow(ConfigError);
    // 別の loopback のアドレス（127.0.0.2）も同じ。
    const other = runtimeConfigOf({ facilitator: `http://127.0.0.2:${a.port}/tok`, providers: {} });
    expect(() => compose(other, capabilitiesOf(["rh"], [a.origin]))).toThrow(ConfigError);
    expect(a.connections).toBe(before);
  });

  test("allowlist に無い loopback の上流（送信）→ 起動しない", () => {
    const config = runtimeConfigOf({ facilitator: `${a.origin}/tok`, providers: { rh: `${b.origin}/v1/eth/snapshot` } });
    expect(() => compose(config, capabilitiesOf(["rh"], [a.origin]))).toThrow(/routes\.md-rh-eth-snapshot: the upstream is a loopback address that RouterCapabilities\.localCounterparties does not list/);
  });

  test("一部だけの送信の組（同じ network の上流の 1 つが allowlist の loopback、もう 1 つが公開の URL）→ 起動しない", () => {
    const config = runtimeConfigOf({
      facilitator: `${a.origin}/tok`,
      providers: { rh: `${b.origin}/v1/eth/snapshot` },
      mutate: (document) => {
        const extra = { ...document.router.routes["md-rh-eth-snapshot"], routeId: "md-rh-eth-snapshot-2", canonicalPath: "/v1/routes/md-rh-eth-snapshot-2/resource" };
        document.router.routes["md-rh-eth-snapshot-2"] = extra;
        document.x402.upstreams["md-rh-eth-snapshot-2"] = "https://provider.example/v1/eth/snapshot";
      },
    });
    expect(() => compose(config, capabilitiesOf(["rh"], [a.origin, b.origin]))).toThrow(/outbound x402 eip155:46630: either every upstream of the group is a listed local counterparty or none is/);
    // 計画（純粋関数）でも同じ。
    expect(() => localCounterpartyPlanOf(config.router.routes, config.real!.upstreams, () => `${a.origin}/tok`, new Set([a.origin, b.origin]))).toThrow(ConfigError);
  });

  test("allowlist の形の誤りは構成によらず起動しない", () => {
    const config = runtimeConfigOf({ facilitator: "https://facilitator.example/tok", providers: {} });
    expect(() => compose(config, capabilitiesOf(["rh"], ["http://localhost:1"]))).toThrow(/localCounterparties\.origins/);
  });

  test("計画: allowlist の相手だけが載る。EVM testnet 以外の loopback（Base Sepolia の facilitator・上流）は載らず、拒否もしない。能力が無ければ空", () => {
    const config = runtimeConfigOf({
      facilitator: `${a.origin}/tok`,
      providers: { rh: `${b.origin}/v1/eth/snapshot` },
      baseFacilitator: `${a.origin}`,
      mutate: (document) => {
        // Base Sepolia 宛の上流を loopback に（Provider A の route）。allowlist に無いが EVM testnet ではないので計画には関係しない。
        document.x402.upstreams["md-x402-eth-snapshot-rh"] = "http://127.0.0.1:1/v1/eth/snapshot";
      },
    });
    const facilitatorOf = (network: string) => (network === BASE ? config.real!.x402InboundFacilitatorUrl : config.real!.x402InboundFacilitators?.[network]?.url);
    const plan = localCounterpartyPlanOf(config.router.routes, config.real!.upstreams, facilitatorOf, new Set([a.origin, b.origin]));
    expect([...plan.inbound]).toEqual([["md-x402-eth-snapshot-rh", a.origin]]);
    expect([...plan.outbound].map(([network, origins]) => [network, [...origins]])).toEqual([["eip155:46630", [b.origin]]]);
    const none = localCounterpartyPlanOf(config.router.routes, config.real!.upstreams, facilitatorOf, undefined);
    expect(none.inbound.size + none.outbound.size).toBe(0);
    // 能力が無ければ、loopback の URL があっても起動は今までどおり（拒否は fetch 時の transport）。
    expect(() => compose(config, capabilitiesOf(["rh"]))).not.toThrow();
  });
});

/** 受信 adapter の verify を 1 回（offer は adapter が作る。credential は形だけ。facilitator の相手が答えを決める）。 */
async function verifyVia(rails: ReturnType<typeof composeRails>, config: RuntimeConfig, routeId: string): Promise<{ isValid: boolean } | TransportError> {
  const route = config.router.routes[routeId]!;
  const offer = await rails.inbound.createOffer({ routeId, amount: route.source.amount, asset: route.source.asset, network: route.source.network, routeBinding: routeBindingOf(route), nowMs: Date.now() });
  const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0x00", authorization: {} } };
  try {
    return await rails.inbound.verify(offer, credential, { routeId });
  } catch (error) {
    if (error instanceof TransportError) return error;
    throw error;
  }
}

describe("配線（composeRails）: 許すのは EVM testnet の静的の相手だけ", () => {
  test("allowlist の facilitator（token は path の接頭辞）に受信の verify が届く。能力が無ければ loopback は fetch 時に拒まれる（今までどおり）", async () => {
    const config = runtimeConfigOf({ facilitator: `${a.origin}/tok`, providers: {} });
    const before = a.requests.length;
    const result = await verifyVia(compose(config, capabilitiesOf(["rh"], [a.origin])), config, "md-x402-eth-snapshot-rh");
    expect(result).toEqual({ isValid: true });
    expect(a.requests.slice(before)).toEqual(["POST /tok/verify"]);
    const events: TransportEvent[] = [];
    const connections = a.connections;
    const refused = await verifyVia(compose(config, capabilitiesOf(["rh"]), events), config, "md-x402-eth-snapshot-rh");
    expect(refused).toBeInstanceOf(TransportError);
    expect((refused as TransportError).code).toBe("destination_blocked");
    expect(a.connections).toBe(connections);
  });

  test("Base Sepolia（EVM testnet ではない）の facilitator は、その origin が allowlist にあっても loopback に届かない", async () => {
    const config = runtimeConfigOf({ facilitator: `${a.origin}/tok`, providers: { rh: `${b.origin}/v1/eth/snapshot` }, baseFacilitator: a.origin });
    const rails = compose(config, capabilitiesOf(["rh"], [a.origin, b.origin]));
    const connections = a.connections;
    const refused = await verifyVia(rails, config, "md-rh-eth-snapshot");
    expect(refused).toBeInstanceOf(TransportError);
    expect((refused as TransportError).code).toBe("destination_blocked");
    expect(a.connections).toBe(connections);
    // 同じ構成の rh の受信は届く（対照）。
    expect(await verifyVia(rails, config, "md-x402-eth-snapshot-rh")).toEqual({ isValid: true });
  });

  test("動的プロファイルの受信（EVM testnet の source）: facilitator の origin が allowlist にあればその origin だけに届く（hosted 設計 §3）。能力が無ければ動的の transport（loopback 不可）のまま", async () => {
    const config = dynamicConfigOf();
    const rails = compose(config, capabilitiesOf(["rh"], [a.origin]));
    const before = a.requests.length;
    expect(await dynamicVerifyVia(rails)).toEqual({ isValid: true });
    expect(a.requests.slice(before)).toEqual(["POST /tok/verify"]);
    // 能力が無い構成（今までの hosted と同じ）: 送出の前に拒む（接続 0）。
    const connections = a.connections;
    await expect(dynamicVerifyVia(compose(config, capabilitiesOf(["rh"])))).rejects.toMatchObject({ code: "destination_blocked" });
    expect(a.connections).toBe(connections);
  });

  test("動的プロファイルの受信: allowlist に無い loopback の facilitator → 起動しない。計画は受信の facilitator だけを載せ、動的の送信（上流）は載せない", () => {
    const config = dynamicConfigOf();
    const facilitatorOf = (network: string) => (network === BASE ? config.real!.x402InboundFacilitatorUrl : config.real!.x402InboundFacilitators?.[network]?.url);
    const profiles = config.router.dynamic!.profiles;
    // 静的 route の無い入力（hosted は動的だけ）: 動的プロファイルの受信の facilitator で起動しない。
    expect(() => localCounterpartyPlanOf({}, {}, facilitatorOf, new Set([b.origin]), profiles)).toThrow(/dynamic\.profiles\.dyn-rh-to-x402: the inbound facilitator is a loopback address that RouterCapabilities\.localCounterparties does not list/);
    // composeRails でも起動しない（この構成は静的の rh の受信も持つので、どちらかの固定文で止まる）。
    expect(() => compose(config, capabilitiesOf(["rh"], [b.origin]))).toThrow(/the inbound facilitator is a loopback address that RouterCapabilities\.localCounterparties does not list/);
    const plan = localCounterpartyPlanOf(config.router.routes, config.real!.upstreams, facilitatorOf, new Set([a.origin, b.origin]), profiles);
    expect([...plan.inboundDynamic]).toEqual([["dyn-rh-to-x402", a.origin]]);
    // 新 3 を宛先とするプロファイル（`dyn-x402-to-rh`）は送信の計画に載らない（動的上流は呼び出し側の URL で、loopback 不可の transport のまま）。
    expect([...plan.outbound.keys()]).toEqual([]);
    expect(plan.inboundDynamic.has("dyn-x402-to-rh")).toBe(false);
  });
});

/** 動的プロファイル 2 つ（新 3 から Base へ・Base から新 3 へ）を持つ構成（facilitator は a の loopback）。 */
function dynamicConfigOf(): RuntimeConfig {
  return runtimeConfigOf({
    facilitator: `${a.origin}/tok`,
    providers: {},
    mutate: (document) => {
      document.router.dynamic = {
        enabled: true,
        profiles: {
          "dyn-rh-to-x402": {
            profileId: "dyn-rh-to-x402",
            sourceRail: "x402",
            source: { network: RH.network, asset: RH.asset, decimals: 6, payTo: RECEIVER },
            rail: "x402",
            destination: { scheme: "exact", network: BASE, asset: INBOUND.asset, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
            par: true,
            fee: { flat: "1000", bps: 0, min: "1000" },
            maxUpstreamAmount: "10000",
          },
          "dyn-x402-to-rh": {
            profileId: "dyn-x402-to-rh",
            sourceRail: "x402",
            source: { network: BASE, asset: INBOUND.asset, decimals: 6, payTo: RECEIVER },
            rail: "x402",
            destination: { scheme: "exact", network: RH.network, asset: RH.asset, decimals: 6, tokenDomain: { ...RH.domain } },
            par: true,
            fee: { flat: "1000", bps: 0, min: "1000" },
            maxUpstreamAmount: "10000",
          },
        },
        budget: { maxPurchases: 4, buckets: [{ network: BASE, asset: INBOUND.asset, maxTotal: "100000", maxPerPurchase: "20000" }, { network: RH.network, asset: RH.asset, maxTotal: "100000", maxPerPurchase: "20000" }] },
        denyHosts: [],
      };
    },
  });
}

/** `dyn-rh-to-x402` の受信 adapter の verify を 1 回。 */
async function dynamicVerifyVia(rails: ReturnType<typeof composeRails>): Promise<unknown> {
  const binding = `dynamic|dyn-rh-to-x402|GET|${encodeURIComponent("https://provider.example/v1/x")}`;
  const offer = await rails.inbound.createOffer({ routeId: "dyn-rh-to-x402", amount: "11000", asset: RH.asset, network: RH.network, routeBinding: binding, nowMs: Date.now() });
  const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0x00", authorization: {} } };
  return rails.inbound.verify(offer, credential, { routeId: "dyn-rh-to-x402" });
}

describe("要求ごとの origin の完全一致（originPinnedTransport）", () => {
  const pinnedTo = (origins: string[], events: TransportEvent[]) => {
    const report = (event: TransportEvent) => events.push(event);
    return originPinnedTransport(transportFor(true, report), new Set(origins), report);
  };

  test("許した origin へは届く。別の loopback の port・別の scheme・別のアドレス・userinfo つき・壊れた URL は送出の前に拒む（接続 0）", async () => {
    const events: TransportEvent[] = [];
    const transport = pinnedTo([a.origin], events);
    expect(transport.allowLoopback).toBe(true);
    const ok = await transport.fetch(`${a.origin}/tok/verify`, { method: "POST", body: "{}" }, { operation: "facilitator_verify", routeId: "r" });
    expect(ok.status).toBe(200);
    await ok.text();
    const bBefore = b.connections;
    const aBefore = a.connections;
    for (const url of [`${b.origin}/tok/verify`, `https://127.0.0.1:${a.port}/x`, `http://127.0.0.2:${a.port}/x`, `http://localhost:${a.port}/x`, `http://user:pw@127.0.0.1:${a.port}/x`, "::not a url::"]) {
      await expect(transport.fetch(url, { method: "POST", body: "{}" }, { operation: "facilitator_verify", routeId: "r" }), url).rejects.toMatchObject({ code: "destination_blocked", operation: "facilitator_verify" });
    }
    expect(b.connections).toBe(bBefore);
    expect(a.connections).toBe(aBefore);
    // 拒否は運用者向けの 1 行（値なし）として報告される。
    expect(events.filter((event) => event.code === "destination_blocked")).toHaveLength(6);
    expect(JSON.stringify(events)).not.toContain(String(b.port));
  });

  test("redirect は拒む（許した origin が別の loopback の origin へ 302 を返しても、そこへは接続しない）", async () => {
    const transport = pinnedTo([a.origin], []);
    a.redirectTo = `${b.origin}/elsewhere`;
    const bBefore = b.connections;
    await expect(transport.fetch(`${a.origin}/tok/settle`, { method: "POST", body: "{}" }, { operation: "facilitator_settle" })).rejects.toBeInstanceOf(TransportError);
    expect(b.connections).toBe(bBefore);
    // 両方を許していても redirect は辿らない（内側の transport の `redirect: "error"`）。
    const both = pinnedTo([a.origin, b.origin], []);
    await expect(both.fetch(`${a.origin}/tok/settle`, { method: "POST", body: "{}" }, { operation: "facilitator_settle" })).rejects.toBeInstanceOf(TransportError);
    expect(b.connections).toBe(bBefore);
  });
});

describe("静的検査: loopback を許す transport の作り方", () => {
  test("合成レール（synthetic）以外で loopback を固定で許す transport は、必ず要求ごとの origin の包みの中で作る", () => {
    const source = readFileSync("src/main.ts", "utf8");
    const real = source.slice(source.indexOf("const real = config.real;"));
    const lines = real.split("\n").filter((line) => /allowLoopback: true|transportFor\(true\b/.test(line));
    expect(lines.length).toBe(3); // 送信の組（x402・EVM testnet）と静的の受信（EVM testnet）と動的プロファイルの受信（EVM testnet。hosted 設計 §3）
    for (const line of lines) expect(line).toMatch(/originPinnedTransport\((transportFor\(true|createGuardedTransport\(\{ \.\.\.staticHooks, allowLoopback: true)/);
    // 包む集合は配線の計画（localCounterpartyPlanOf）から来る。
    expect(real).toMatch(/originPinnedTransport\(transportFor\(true, report, staticHooks\), localOutbound, report\)/);
    expect(real).toMatch(/new Set\(\[localOrigin\]\), report\)/);
    expect(real).toMatch(/const localOutbound = localPlan\.outbound\.get\(pair\.network\);/);
    expect(real).toMatch(/const localOrigin = localPlan\.inbound\.get\(route\.routeId\);/);
    expect(real).toMatch(/const localOrigin = localPlan\.inboundDynamic\.get\(profile\.profileId\);/);
  });
});
