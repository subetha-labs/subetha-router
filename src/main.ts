/**
 * Router の実 CLI エントリポイント（設計 §10 M2/M3、タスク T1b）。
 * config 読み込み → adapter 合成 → journal ロック取得 → HTTP listen を行う。
 *
 * **合成実装を本番既定にしない**: 既定の `ROUTER_ADAPTER_MODE=real` では実 adapter（公式 x402 SDK
 * 配線）を組むが、署名能力が注入されていなければ `signer_not_authorized` で起動を中止する
 * （synthetic へは落とさず、偽の署名者も作らない）。合成レールは
 * `ROUTER_ADAPTER_MODE=synthetic` を明示したときだけ、リポジトリ内の既知の fixture 構成として
 * 組み立てる（任意のプラグイン読み込みは行わない）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSubethaInbound } from "./adapters/inbound/subetha.js";
import { createMppInbound } from "./adapters/inbound/mpp.js";
import { createX402Inbound, type X402FacilitatorKind } from "./adapters/inbound/x402.js";
import { createX402SvmInbound, type SvmInboundPolicy } from "./adapters/inbound/x402-svm.js";
import { resolveSvmInboundPolicy } from "./adapters/inbound/x402-svm-startup.js";
import { createMppOutbound } from "./adapters/outbound/mpp.js";
import { assertDynamicMppCapability } from "./adapters/outbound/mpp-dynamic.js";
import { createSyntheticX402Outbound, createX402Outbound } from "./adapters/outbound/x402.js";
import { createX402SvmOutbound } from "./adapters/outbound/x402-svm.js";
import { DYNAMIC_RESPONSE_LIMITS } from "./net/bounded-body.js";
import { createGuardedTransport, formatTransportEvent, type GuardedTransport, type GuardedTransportOptions, type TransportEvent } from "./net/guarded-fetch.js";
import { denyHostsOf } from "./net/upstream-url.js";
import {
  ConfigError,
  KNOWN_NETWORKS,
  LEGACY_X402_INBOUND_NETWORK,
  knownAssetOf,
  knownNetworkOf,
  loadRuntimeConfig,
  networkFamilyOf,
  routeBindingOf,
  type DynamicProfile,
  type KnownNetwork,
  type RouteConfig,
  type RouterConfig,
  type RuntimeConfig,
} from "./config.js";
import { getBase58Encoder } from "@solana/kit";
import { tempo as tempoMainnet, tempoModerato } from "viem/tempo/chains";

import { DynamicGate } from "./core/dynamic-gate.js";
import { createRouterCore } from "./core/orchestrator.js";
import { startHttpServer } from "./http/app.js";
import type { InboundOffer, InboundRail, SellerProofCapability } from "./ports/inbound.js";
import type {
  EvmSigningCapability,
  MppTempoCapability,
  OutboundRail,
  SvmSigningCapability,
} from "./ports/outbound.js";

/**
 * 経路が必要とする送信レールの支払い能力が無い（`real` モード）。**合成には落とさず** fail closed。
 * 実鍵の権限は本タスクで解除されていないため、CLI 既定はここで止まるのが正しい状態。
 */
class SignerNotAuthorizedError extends Error {
  readonly code = "signer_not_authorized";

  constructor() {
    super(
      "signer_not_authorized: the outbound rails are wired to the official SDKs, but no payment " +
        "capability was injected for a configured route. Real payments need a separate credential " +
        "gate; set ROUTER_ADAPTER_MODE=synthetic for the in-repo no-money loopback fixtures.",
    );
    this.name = "SignerNotAuthorizedError";
  }
}

/**
 * 起動時に**コードから**注入される能力。構成ファイル・env からは読み込まない
 * （任意のプラグイン読み込みを許さないため）。
 */
export interface RouterCapabilities {
  /** 送信レール A（x402 / EVM）の署名能力（Base。既存）。 */
  readonly evmSigning?: EvmSigningCapability;
  /**
   * network ごとの x402（EVM）の署名能力（送信の設計 §2.1、FR-27）。key = network。`evmSigning` の network と重複すれば起動しない。
   * Arc は Base と同じ鍵を別の札で（D-11）。
   */
  readonly evmSigningByNetwork?: Readonly<Record<string, EvmSigningCapability>>;
  /** network ごとの SVM の署名能力（`solana:…`）。adapter は U8 で合成する。 */
  readonly svmSigning?: Readonly<Record<string, SvmSigningCapability>>;
  /** 送信レール B（MPP / Tempo charge）の支払い能力。 */
  readonly mppTempo?: MppTempoCapability;
  /**
   * 受信 facilitator が loopback の fixture であることを**明示**する能力（SSRF 防御 A §3.4）。
   * `tests/fixtures/router-*-process.ts` のような fixture 起動だけが渡す。本番の入口は渡さない。
   */
  readonly fixtureFacilitators?: true;
  /**
   * **試験専用。** 動的上流 URL の経路の transport を、本番と同じ選択肢（loopback 不可・DNS の期限・ヘッダの上限・門の `admit`）
   * から fixture 側が組む（宛先の差し替えを足すため）。本番の入口は渡さない。返った transport が loopback を許す・DNS に期限が
   * 無いものなら起動を止める。
   */
  readonly dynamicTransportHooksForTest?: DynamicTransportHooks;
  /**
   * **試験専用。** 静的 route の transport（上流・facilitator・RPC）に足す差し替え（同じ制限: 名前解決・接続先・CA・
   * インタフェース一覧だけ。`allowLoopback` と `report` は配線が決める）。統合試験が静的と動的を同じ fixture の網に閉じ込めるため。
   */
  readonly transportHooksForTest?: DynamicTransportHooks;
  /**
   * 能力が接続する依存先（送信 MPP の RPC など）の URL。動的上流 URL の**拒否ホスト**に入れる（設計 §7.4）。
   * 起動時の確認で、MPP 能力の client の RPC ホストがここに含まれていなければ起動を止める。
   */
  readonly dependencyUrls?: readonly string[];
  /**
   * **試験専用。** network の表（multirail 設計 §1）を差し替える。real モードの fixture 起動（`tests/fixtures/router-*-process.ts`）が
   * 表の外の network・資産で起動するために渡す。本番の入口は渡さない（既定は `KNOWN_NETWORKS`）。
   */
  readonly knownNetworksForTest?: readonly KnownNetwork[];
  /**
   * Circle の facilitator（kind `circle`）を使う network ごとの売り手証明の能力（multirail 設計 §3）。起動側が
   * `tools/real-seller-proof-capability.ts` で作る。route／プロファイルの `source.payTo` と一致しなければ起動しない。
   */
  readonly sellerProofs?: Readonly<Record<string, SellerProofCapability>>;
}

/** Solana の公開 devnet RPC（`ROUTER_SOLANA_RPC_URL` が無いときの既定）。 */
export const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";

/** SVM 受信の起動時の検査で固定する値の置き場。`startup()` が埋めるまで adapter は offer を出さない（fail closed）。 */
class SvmPolicyHolder {
  #policy: SvmInboundPolicy | undefined;
  get(): SvmInboundPolicy {
    if (this.#policy === undefined) throw new ConfigError("svm inbound: startup checks have not run");
    return this.#policy;
  }
  set(policy: SvmInboundPolicy): void {
    this.#policy = policy;
  }
}

/**
 * **試験専用。** 動的用 transport に fixture が足せるのは、名前解決・接続先の差し替え・試験用 CA・インタフェース一覧だけ。
 * 方針の欄（loopback 不可・DNS の期限・ヘッダの上限・門の `admit`）は配線が後から重ねるので、fixture は変えられない。
 */
export type DynamicTransportHooks = Omit<GuardedTransportOptions, "allowLoopback" | "report" | "maxHeaderSize" | "dns" | "admit">;

/** 動的上流 URL の配線が core に渡すもの。 */
export interface DynamicWiring {
  readonly gate: DynamicGate;
  /** 残高（送信の設計 §2.6）: rail の `balanceOf` → 能力の `balanceOf` → 無ければ `undefined`（検査なし）。 */
  readonly balanceOf?: (id: string, asset: string) => Promise<bigint | undefined>;
  /** 起動時の非同期の確認（MPP 能力の client）。 */
  readonly verify: () => Promise<void>;
}

/** 受信 offer の束縛から動的プロファイルの ID を読む（`dynamicBindingOf` の逆）。動的でなければ `undefined`。 */
function profileIdOfBinding(binding: string): string | undefined {
  const parts = binding.split("|");
  if (parts.length !== 4 || parts[0] !== "dynamic" || parts[2] !== "GET") return undefined;
  try {
    return decodeURIComponent(parts[1]!);
  } catch {
    return undefined;
  }
}

/**
 * `routeId` から送信レールを引く（core は rail 名で分岐しない）。allowlist は
 * 構成の `routes[].rail` だけで、未登録の routeId はどのレールにも届かない。
 */
/** 送信の組の鍵 `(rail, network)`（送信の設計 §2.2、FR-27）。 */
export function outboundPairKeyOf(rail: string, network: string): string {
  return `${rail}:${network}`;
}

const BASE_SEPOLIA_NETWORK = "eip155:84532";
const SVM_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** base58 で 32 バイトに復号できる公開鍵か（文字数では足りない: 33 個の `1` は 33 バイトのゼロ）。 */
function isSvmPublicKey(value: string): boolean {
  if (!SVM_ADDRESS_PATTERN.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * SVM の使い方（送信の設計 §2.2）: 受信（`sourceRail: "x402"` の Solana）と送信（Solana 宛の route／プロファイル）のどちらかがあれば
 * Solana RPC は依存先・拒否ホストに入る。純粋関数（試験で確かめる）。
 */
export function svmUsageOf(
  routes: Readonly<Record<string, { readonly sourceRail?: string; readonly source: { readonly network: string }; readonly destination: { readonly network: string } }>>,
  profiles: Readonly<Record<string, { readonly sourceRail: string; readonly source: { readonly network: string }; readonly destination: { readonly network: string } }>>,
): { readonly inbound: boolean; readonly outbound: boolean } {
  const all = [...Object.values(routes), ...Object.values(profiles)];
  return {
    inbound: all.some((entry) => entry.sourceRail === "x402" && networkFamilyOf(entry.source.network) === "svm"),
    outbound: all.some((entry) => networkFamilyOf(entry.destination.network) === "svm"),
  };
}

/** Solana RPC の transport（受信の起動時の検査・追跡と、送信で共有。送信の設計 §2.2）: fixture の差し替えの上に、loopback の方針と DNS の期限。 */
function svmRpcTransportOf(hooks: DynamicTransportHooks, allowLoopback: boolean, report: (event: TransportEvent) => void): GuardedTransport {
  return createGuardedTransport({ ...hooks, allowLoopback, report, dns: { timeoutMs: 3_000, maxInFlight: 4 } });
}

/**
 * 注入された送信能力を network で引ける形に（送信の設計 §2.2、FR-27）。起動時の検査（fail closed）:
 * `evmSigningByNetwork`／`svmSigning` の key と能力の `network` の完全一致、`evmSigning` との重複、family（EVM は `eip155:`、SVM は `solana:`）、
 * SVM の `address` の形（base58 32 バイト相当）。純粋関数（試験で確かめる）。
 */
export function outboundCapabilitiesOf(capabilities: Pick<RouterCapabilities, "evmSigning" | "evmSigningByNetwork" | "svmSigning">): {
  readonly evmByNetwork: ReadonlyMap<string, EvmSigningCapability>;
  readonly svmByNetwork: ReadonlyMap<string, SvmSigningCapability>;
} {
  const evmByNetwork = new Map<string, EvmSigningCapability>();
  if (capabilities.evmSigning !== undefined) {
    if (networkFamilyOf(capabilities.evmSigning.network) !== "evm") throw new SignerNotAuthorizedError();
    evmByNetwork.set(capabilities.evmSigning.network, capabilities.evmSigning);
  }
  for (const [key, capability] of Object.entries(capabilities.evmSigningByNetwork ?? {})) {
    if (key !== capability.network || networkFamilyOf(key) !== "evm" || evmByNetwork.has(key)) throw new SignerNotAuthorizedError();
    evmByNetwork.set(key, capability);
  }
  const svmByNetwork = new Map<string, SvmSigningCapability>();
  for (const [key, capability] of Object.entries(capabilities.svmSigning ?? {})) {
    if (key !== capability.network || networkFamilyOf(key) !== "svm" || svmByNetwork.has(key) || !isSvmPublicKey(capability.address)) throw new SignerNotAuthorizedError();
    svmByNetwork.set(key, capability);
  }
  return { evmByNetwork, svmByNetwork };
}

/**
 * 運用者の集合（送信の設計 §2.3、FR-38）: (a) `sourceRail` が x402／mpp の route・プロファイルの受信の受取先、(b) 注入された送信能力の公開アドレス。
 * **Provider の宛先（静的 route の `destination.payTo`）は入れない**。(c) の ATA は SVM の adapter の startup で足す。純粋関数。
 */
export function operatorAddressesOf(
  router: Pick<RouterConfig, "routes">,
  profiles: Readonly<Record<string, DynamicProfile>>,
  capabilities: { readonly evmByNetwork: ReadonlyMap<string, EvmSigningCapability>; readonly svmByNetwork: ReadonlyMap<string, SvmSigningCapability>; readonly mppTempo?: MppTempoCapability },
): readonly string[] {
  const addresses = new Set<string>();
  for (const route of Object.values(router.routes)) {
    if ((route.sourceRail === "x402" || route.sourceRail === "mpp") && route.source.payTo !== undefined) addresses.add(route.source.payTo);
  }
  for (const profile of Object.values(profiles)) addresses.add(profile.source.payTo);
  for (const capability of capabilities.evmByNetwork.values()) addresses.add(capability.signer.address);
  for (const capability of capabilities.svmByNetwork.values()) addresses.add(capability.address);
  if (capabilities.mppTempo !== undefined) addresses.add(capabilities.mppTempo.account.address);
  return [...addresses];
}

function railByRoute(
  routes: Readonly<Record<string, { readonly rail?: string; readonly destination: { readonly network: string } }>>,
  rails: Readonly<Record<string, OutboundRail>>,
  profiles: Readonly<Record<string, DynamicProfile>> = {},
): OutboundRail {
  const byRoute = new Map<string, OutboundRail>();
  for (const [routeId, route] of Object.entries(routes)) {
    const rail = rails[outboundPairKeyOf(route.rail ?? "x402", route.destination.network)];
    if (rail === undefined) {
      throw new SignerNotAuthorizedError();
    }
    byRoute.set(routeId, rail);
  }
  // 動的プロファイルも同じ Map で引く（ID の名前空間は route と共通）。
  for (const [profileId, profile] of Object.entries(profiles)) {
    const rail = rails[outboundPairKeyOf(profile.rail, profile.destination.network)];
    if (rail === undefined) {
      throw new SignerNotAuthorizedError();
    }
    byRoute.set(profileId, rail);
  }
  const railFor = (routeId: string): OutboundRail => {
    const rail = byRoute.get(routeId);
    if (rail === undefined) {
      throw new Error("no outbound rail configured for route");
    }
    return rail;
  };
  return {
    // 上流の URL（動的購入）はそのまま渡す。動的経路を持たない adapter は受け取ると例外にする（fail closed）。
    readChallenge: (routeId, target) => railFor(routeId).readChallenge(routeId, target),
    pay: (request) => railFor(request.routeId).pay(request),
    // 見積りを持たないレール（x402）には転送しない（core は `estimateFee` の有無で分岐しない。無ければ quote を不成立にする）。
    estimateFee: (routeId, offer, target) => {
      const rail = railFor(routeId);
      if (typeof rail.estimateFee !== "function") {
        return Promise.reject(new Error("outbound rail has no fee estimate"));
      }
      return rail.estimateFee(routeId, offer, target);
    },
  };
}

/**
 * route ごとに受信レールを振り分けるラッパ（送信側 `railByRoute` と同形）。
 * **core の契約は変えない**（core は単一の `InboundRail` しか知らない）。
 *
 * `createOffer` は `routeId` を直接持つが、残り 3 つは `offer.extra.routeBinding` しか持たない。
 * `routeBindingOf(route)` の逆引き Map で解決し、**未知 binding は fail closed**。
 *
 * `preflight` は**同期**（core は await しない）。ここを async にすると全購入が落ちる。
 */
function inboundByRoute(
  routes: Readonly<Record<string, RouteConfig>>,
  rails: Readonly<Record<string, InboundRail>>,
  profiles: Readonly<Record<string, DynamicProfile>> = {},
): InboundRail {
  const byRoute = new Map<string, InboundRail>();
  const byBinding = new Map<string, InboundRail>();
  for (const profile of Object.values(profiles)) {
    const rail = rails[`${profile.sourceRail}:${profile.profileId}`];
    if (rail === undefined) {
      throw new ConfigError(`dynamic.profiles.${profile.profileId}.sourceRail has no configured inbound rail`);
    }
    // 動的の束縛は URL ごとに違うので、束縛からプロファイル ID を読んで引く（`forOffer`）。
    byRoute.set(profile.profileId, rail);
  }
  for (const route of Object.values(routes)) {
    const sourceRail = route.sourceRail ?? "subetha";
    // x402 / mpp 受信は受取先が route ごとなので `<rail>:<routeId>` で引く。
    const rail =
      rails[
        sourceRail === "x402" || sourceRail === "mpp"
          ? `${sourceRail}:${route.routeId}`
          : sourceRail
      ];
    if (rail === undefined) {
      throw new ConfigError(
        `routes.${route.routeId}.sourceRail has no configured inbound rail`,
      );
    }
    byRoute.set(route.routeId, rail);
    byBinding.set(routeBindingOf(route), rail);
  }
  const forRoute = (routeId: string): InboundRail => {
    const rail = byRoute.get(routeId);
    if (rail === undefined) {
      throw new Error("no inbound rail configured for route");
    }
    return rail;
  };
  const forOffer = (offer: InboundOffer): InboundRail => {
    const profileId = profileIdOfBinding(offer.extra.routeBinding);
    const rail = profileId === undefined ? byBinding.get(offer.extra.routeBinding) : profiles[profileId] === undefined ? undefined : byRoute.get(profileId);
    if (rail === undefined) {
      // 発行していない束縛の offer は扱わない。
      throw new Error("no inbound rail for offer route binding");
    }
    return rail;
  };
  return {
    createOffer: (request) => forRoute(request.routeId).createOffer(request),
    preflight: (offer, credential, nowMs) => forOffer(offer).preflight(offer, credential, nowMs),
    // 呼び出しの文脈（route）を落とさない（運用者向け診断の route はここを通る。設計 A §3.5）。
    verify: (offer, credential, context) => forOffer(offer).verify(offer, credential, context),
    settle: (offer, credential, context) => forOffer(offer).settle(offer, credential, context),
  };
}

/** 運用者向けの transport 診断の出口（core の `note` と同じ stderr）。 */
export function reportTransportToStderr(write: (message: string) => void): (event: TransportEvent) => void {
  return (event) => write(`${formatTransportEvent(event)}\n`);
}

/**
 * adapter ごとの transport（SSRF 防御 A §3.4）。`allowLoopback` は**その adapter の能力**だけで決める:
 * 実能力は常に false、fixture の能力（`non-signing-fixture`、synthetic、`fixtureFacilitators`）だけ true。
 * env / 設定からは変えられない。
 */
export function transportFor(allowLoopback: boolean, report: (event: TransportEvent) => void, hooks: DynamicTransportHooks = {}): GuardedTransport {
  // 差し替え（試験）の上に方針の欄を重ねる。
  return createGuardedTransport({ ...hooks, allowLoopback, report });
}

export function composeRails(
  config: RuntimeConfig,
  capabilities: RouterCapabilities,
  report: (event: TransportEvent) => void = reportTransportToStderr((m) => process.stderr.write(m)),
  note: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): { inbound: InboundRail; outbound: OutboundRail; balanceOf?: (id: string, asset: string) => Promise<bigint | undefined>; dynamic?: DynamicWiring; startup?: () => Promise<void> } {
  // 合成レールは `synthetic` を明示したときだけ（既定では選ばれない）。
  if (config.adapterMode === "synthetic") {
    if (config.synthetic === undefined) {
      throw new SignerNotAuthorizedError();
    }
    if (config.router.dynamic !== undefined) {
      // 合成レールには動的経路が無い（上流の URL を受け取ると例外になる）。設定があっても組まない。
      throw new ConfigError("dynamic upstream URLs are not available with the synthetic rails");
    }
    return {
      inbound: createSubethaInbound({ facilitatorUrl: config.synthetic.facilitatorUrl, transport: transportFor(true, report) }),
      outbound: createSyntheticX402Outbound({ upstreams: config.synthetic.upstreams, transport: transportFor(true, report) }),
    };
  }

  const real = config.real;
  if (real === undefined) {
    throw new SignerNotAuthorizedError();
  }
  const staticHooks = capabilities.transportHooksForTest ?? {};

  /**
   * 動的上流 URL（設計 §3.1・§7.3）。transport は route 用とは別のインスタンスで、**loopback を許さず**、名前解決に期限、
   * 応答ヘッダに上限、接続の前に宛先アドレスの枠（門）。上流・facilitator・RPC のすべてがこれを通る。
   */
  const dynamicConfig = config.router.dynamic;
  const profiles = dynamicConfig?.profiles ?? {};
  const gate = dynamicConfig === undefined ? undefined : new DynamicGate({ limits: dynamicConfig.limits });
  const dynamicTransport = ((): GuardedTransport | undefined => {
    if (dynamicConfig === undefined || gate === undefined) return undefined;
    const base: GuardedTransportOptions = {
      allowLoopback: false,
      report,
      maxHeaderSize: DYNAMIC_RESPONSE_LIMITS.maxHeaderBytes,
      dns: { timeoutMs: 3_000, maxInFlight: 16 },
      admit: (addresses) => {
        const admitted = gate.admitAddresses(addresses);
        return admitted.ok ? admitted.lease : undefined;
      },
    };
    // fixture の差し替え（あれば）の**上に**方針の欄を重ねる。方針は fixture から変えられない。
    const transport = createGuardedTransport({ ...(capabilities.dynamicTransportHooksForTest ?? {}), ...base });
    if (transport.allowLoopback || !transport.boundsDns) {
      throw new ConfigError("the dynamic transport must not allow loopback and must bound DNS");
    }
    return transport;
  })();
  /** MPP 受信の RPC（設定が無ければ chain の既知の公開 RPC）。拒否ホストにも入れる。 */
  const mppInboundRpcUrlFor = (chainId: number): string | undefined => real.mppInboundRpcUrl ?? [tempoMainnet, tempoModerato].find((chain) => chain.id === chainId)?.rpcUrls.default.http[0];
  const mppInboundChains = [
    ...Object.values(config.router.routes).filter((route) => route.sourceRail === "mpp").map((route) => Number(route.source.network.replace(/^eip155:/, ""))),
    ...Object.values(profiles).filter((profile) => profile.sourceRail === "mpp").map((profile) => Number(profile.source.network.replace(/^eip155:/, ""))),
  ];
  /**
   * 自分自身と依存先には向けない（設計 §7.4）: facilitator・自分の canonical・受信 MPP の RPC・能力の依存先の各ホスト名。
   * **静的 route の上流は入れない**（owner の決定 2026-10-06）: 上流は運営の内側ではなく、静的 route で誰でも買える公開サービスで、
   * 動的に向けても内側への経路は開かない。増えるのは接続の頻度だけで、宛先ホストの枠（§7.3）で抑える。
   */
  const networks = capabilities.knownNetworksForTest ?? KNOWN_NETWORKS;
  const x402InboundNetworks = new Set<string>([
    ...Object.values(config.router.routes).filter((route) => route.sourceRail === "x402").map((route) => route.source.network),
    ...Object.values(profiles).filter((profile) => profile.sourceRail === "x402").map((profile) => profile.source.network),
  ]);
  const usesSvmInbound = [...x402InboundNetworks].some((network) => networkFamilyOf(network) === "svm");
  // SVM の送信（送信の設計 §2.2）: 受信が無くても、Solana 宛の route／プロファイルがあれば RPC は依存先・拒否ホストに入る。
  const usesSvmOutbound = svmUsageOf(config.router.routes, profiles).outbound;
  const solanaRpcUrl = usesSvmInbound || usesSvmOutbound ? (real.solanaRpcUrl ?? DEFAULT_SOLANA_RPC_URL) : undefined;
  const denyHosts =
    dynamicConfig === undefined
      ? []
      : denyHostsOf(dynamicConfig.denyHosts, [
          real.subethaFacilitatorUrl,
          real.x402InboundFacilitatorUrl,
          ...Object.values(real.x402InboundFacilitators ?? {}).map((facilitator) => facilitator.url),
          solanaRpcUrl,
          config.http.canonicalBaseUrl,
          ...mppInboundChains.map((chainId) => mppInboundRpcUrlFor(chainId)),
          ...(capabilities.dependencyUrls ?? []),
        ]);
  // 送信の能力を network で引く（送信の設計 §2.1〜§2.2、FR-27）。起動時の検査: key と能力の network の完全一致、重複、family。
  const { evmByNetwork, svmByNetwork } = outboundCapabilitiesOf(capabilities);
  // 運用者の集合（送信の設計 §2.3、FR-38）: (a) 受信の受取先、(b) 注入された送信能力の公開アドレス。(c) の ATA は SVM の adapter の startup で足す（U8）。
  const operatorAddresses = operatorAddressesOf(config.router, profiles, { evmByNetwork, svmByNetwork, ...(capabilities.mppTempo === undefined ? {} : { mppTempo: capabilities.mppTempo }) });
  /** SVM の adapter が共有する可変の集合（`startup()` が (c) の ATA を足す。EVM・MPP の adapter は配列の写しで足りる: ATA は SVM の offer にしか現れない）。 */
  const operatorSet = new Set<string>(operatorAddresses);

  const dynamicOptionsFor = (rail: "x402" | "mpp", network: string) => {
    if (dynamicTransport === undefined) return {};
    const own = Object.fromEntries(Object.entries(profiles).filter(([, profile]) => profile.rail === rail && profile.destination.network === network));
    return Object.keys(own).length === 0 ? {} : { dynamic: { profiles: own, transport: dynamicTransport, denyHosts, operatorAddresses } };
  };

  // 経路ごとに必要な能力だけを要求する（レール B だけの構成でも A の鍵を要求しない）。組は (rail, network)。プロファイルも数える。
  const pairsInUse = new Map<string, { readonly rail: string; readonly network: string }>();
  for (const route of Object.values(config.router.routes)) {
    const rail = route.rail ?? "x402";
    pairsInUse.set(outboundPairKeyOf(rail, route.destination.network), { rail, network: route.destination.network });
  }
  for (const profile of Object.values(profiles)) {
    pairsInUse.set(outboundPairKeyOf(profile.rail, profile.destination.network), { rail: profile.rail, network: profile.destination.network });
  }
  /** その組が担当する経路の上流だけを渡す（A の検査を B の URL に掛けない）。 */
  const upstreamsFor = (rail: string, network: string): Record<string, string> =>
    Object.fromEntries(
      Object.entries(config.router.routes)
        .filter(([, route]) => (route.rail ?? "x402") === rail && route.destination.network === network)
        .map(([routeId]) => [routeId, real.upstreams[routeId] as string]),
    );
  /** 組み直しに使う EIP-712 domain（表）。静的 route は `tokenDomain` を持たないので、その network の資産の domain を全部渡す。 */
  const tokenDomainsFor = (network: string): Record<string, { name: string; version: string }> => {
    const entry = knownNetworkOf(networks, network);
    return Object.fromEntries((entry?.assets ?? []).filter((asset) => asset.domain !== undefined).map((asset) => [asset.id.toLowerCase(), asset.domain!]));
  };

  const rails: Record<string, OutboundRail> = {};
  /** SVM の送信 adapter の `startup()`（後で `startupChecks` に入れる。受信の検査の後に走る）。 */
  const svmStartups: Array<() => Promise<void>> = [];
  for (const [key, pair] of pairsInUse) {
    if (pair.rail === "x402" && networkFamilyOf(pair.network) === "evm") {
      const capability = evmByNetwork.get(pair.network);
      if (capability === undefined) {
        // 実 SDK 配線はできているが、この network の署名能力が無い。偽の署名者で代替しない。
        throw new SignerNotAuthorizedError();
      }
      const rebuild = pair.network !== BASE_SEPOLIA_NETWORK;
      rails[key] = createX402Outbound({
        upstreams: upstreamsFor(pair.rail, pair.network),
        capability,
        transport: transportFor(capability.kind === "non-signing-fixture", report, staticHooks),
        operatorAddresses,
        // Base 以外の EVM（Arc）は組み直しの署名器で（送信の設計 §3.2）。Base は従来の経路。
        rebuildSignatures: rebuild,
        ...(rebuild ? { tokenDomains: tokenDomainsFor(pair.network) } : {}),
        ...dynamicOptionsFor("x402", pair.network),
      });
      continue;
    }
    if (pair.rail === "x402" && networkFamilyOf(pair.network) === "svm") {
      const capability = svmByNetwork.get(pair.network);
      if (capability === undefined || solanaRpcUrl === undefined) {
        // この network の署名能力が無い（U8-a。偽の署名者で代替しない）。
        throw new SignerNotAuthorizedError();
      }
      // 表の資産（この network の資産は 1 つ）: mint・桁・token program。送信の宛先が別の資産なら設定の照合で既に落ちている。
      const entry = knownNetworkOf(networks, pair.network);
      const known = entry?.assets[0];
      if (entry === undefined || known === undefined || known.tokenProgram === undefined || entry.assets.length !== 1) {
        throw new ConfigError(`outbound ${pair.network}: the table must list exactly one asset with a token program`);
      }
      const ownRoutes = Object.entries(config.router.routes).filter(([, route]) => (route.rail ?? "x402") === "x402" && route.destination.network === pair.network);
      for (const [routeId, route] of ownRoutes) {
        if (route.destination.asset !== known.id) throw new ConfigError(`routes.${routeId}: the destination asset is not the table's mint for ${pair.network}`);
      }
      const ownProfiles = Object.fromEntries(Object.entries(profiles).filter(([, profile]) => profile.rail === "x402" && profile.destination.network === pair.network));
      // RPC は受信の起動時の検査と同じ作り（fixture の差し替えの上に loopback の方針と DNS の期限。送信の設計 §2.2）。
      const rpcTransport = svmRpcTransportOf(staticHooks, capabilities.fixtureFacilitators === true, report);
      const svmRail = createX402SvmOutbound({
        network: pair.network,
        upstreams: upstreamsFor(pair.rail, pair.network),
        destinations: Object.fromEntries(ownRoutes.map(([routeId, route]) => [routeId, { payTo: route.destination.payTo, asset: route.destination.asset, scheme: route.destination.scheme }])),
        capability,
        transport: transportFor(false, report, staticHooks),
        rpc: { url: solanaRpcUrl, transport: rpcTransport },
        operatorAddresses: operatorSet,
        mint: known.id,
        decimals: known.decimals,
        tokenProgram: known.tokenProgram,
        ...(dynamicTransport === undefined || Object.keys(ownProfiles).length === 0 ? {} : { dynamic: { profiles: ownProfiles, transport: dynamicTransport, denyHosts } }),
      });
      rails[key] = svmRail;
      // 起動時の非同期の準備（Router の ATA・運用者の ATA・静的の宛先 ATA の検査）。`startRouter` が core を作る前に待つ。
      svmStartups.push(() => svmRail.startup());
      continue;
    }
    if (pair.rail === "mpp") {
      const capability = capabilities.mppTempo;
      if (capability === undefined) {
        throw new SignerNotAuthorizedError();
      }
      rails[key] = createMppOutbound({
        upstreams: upstreamsFor(pair.rail, pair.network),
        capability,
        transport: transportFor(capability.kind === "non-signing-fixture", report, staticHooks),
        operatorAddresses,
        ...dynamicOptionsFor("mpp", pair.network),
      });
      continue;
    }
    // 知らないレール名は合成にも落とさず起動を止める。
    throw new SignerNotAuthorizedError();
  }

  // 受信レールも route ごとに選ぶ（既定は subetha＝既存構成をそのまま維持）。
  const inboundLoopback = capabilities.fixtureFacilitators === true;
  const inboundRails: Record<string, InboundRail> = {
    subetha: createSubethaInbound({
      facilitatorUrl: real.subethaFacilitatorUrl,
      transport: transportFor(inboundLoopback, report, staticHooks),
    }),
  };
  const usesX402Inbound = x402InboundNetworks.size > 0;
  /** 起動時の非同期の検査（SVM の `/supported`・ATA）。`startRouter` が core を作る前に待つ。 */
  const startupChecks: Array<() => Promise<void>> = [];
  if (usesX402Inbound) {
    /**
     * network ごとの facilitator（multirail 設計 §2）: `eip155:84532` は env、それ以外は設定ファイルの `x402.inboundFacilitators`。
     * kind は表（`x402Facilitator`）と設定で一致している（`loadRuntimeConfig` が照合する）。
     */
    const facilitatorFor = (network: string, at: string): { url: string; kind: X402FacilitatorKind } => {
      if (network === LEGACY_X402_INBOUND_NETWORK) {
        if (real.x402InboundFacilitatorUrl === undefined) {
          throw new ConfigError("ROUTER_X402_INBOUND_FACILITATOR_URL is required when a route uses sourceRail \"x402\"");
        }
        return { url: real.x402InboundFacilitatorUrl, kind: "x402" };
      }
      const configured = real.x402InboundFacilitators?.[network];
      if (configured === undefined) {
        throw new ConfigError(`${at}: x402.inboundFacilitators has no facilitator for the route's network`);
      }
      return configured;
    };
    /** 表の資産（domain・mint・桁・token program）。表に無い組は設定の照合で既に落ちている。 */
    const knownAssetFor = (network: string, asset: string, at: string) => {
      const entry = knownNetworkOf(networks, network);
      const known = entry === undefined ? undefined : knownAssetOf(entry, asset);
      if (entry === undefined || known === undefined) {
        throw new ConfigError(`${at}: the inbound network or asset is not in the table of known networks`);
      }
      return { entry, known };
    };
    /** kind `circle` の売り手証明の能力: network ごとに注入され、`payTo` と一致していること（設計 §3）。 */
    const sellerProofFor = (network: string, payTo: string, at: string): SellerProofCapability => {
      const capability = capabilities.sellerProofs?.[network];
      if (capability === undefined) {
        throw new ConfigError(`${at}: a seller proof capability is required for the Circle facilitator (RouterCapabilities.sellerProofs)`);
      }
      if (capability.network !== network || capability.address.toLowerCase() !== payTo.toLowerCase()) {
        throw new ConfigError(`${at}: the seller proof capability is bound to a different network or address than source.payTo`);
      }
      return capability;
    };
    /**
     * SVM 受信: adapter は policy の置き場を持ち、起動時の検査が埋める。同じ (network, payTo, mint, facilitator) を使う route と
     * プロファイルは置き場を共有する（`/supported` と RPC の読取は起動時に **1 回ずつ**。設計 §5.1）。
     */
    const svmHolders = new Map<string, { holder: SvmPolicyHolder; transport: GuardedTransport }>();
    const svmRail = (network: string, asset: string, payTo: string, at: string, transport: GuardedTransport, facilitatorUrl: string, offerSeconds: number | undefined): InboundRail => {
      const { known } = knownAssetFor(network, asset, at);
      if (known.tokenProgram === undefined) {
        throw new ConfigError(`${at}: the table has no token program for the inbound mint`);
      }
      const key = `${network}|${payTo}|${known.id}|${facilitatorUrl}`;
      let shared = svmHolders.get(key);
      if (shared === undefined) {
        const created = new SvmPolicyHolder();
        // 起動時の検査と settle の後の追跡（設計 §5.8）の transport: 同じ方針（fixture の差し替えの上に、loopback の方針と DNS の期限）。
        const rpcTransport = svmRpcTransportOf(staticHooks, inboundLoopback, report);
        shared = { holder: created, transport: rpcTransport };
        svmHolders.set(key, shared);
        startupChecks.push(async () => {
          created.set(await resolveSvmInboundPolicy({ network, facilitatorUrl, rpcUrl: solanaRpcUrl!, payTo, mint: known.id, decimals: known.decimals, tokenProgram: known.tokenProgram!, transport: rpcTransport, routeId: at }));
        });
      }
      const resolved = shared.holder;
      return createX402SvmInbound({
        facilitatorUrl,
        transport,
        policy: () => resolved.get(),
        // settle の応答の後の期限つきの追跡（設計 §5.8、D-9）: 設定の RPC と起動時の検査と同じ transport。
        rpc: { url: solanaRpcUrl!, transport: shared.transport },
        onDiagnostic: (code) => note(`router: facilitator diagnostic ${code} (${at})`),
        ...(offerSeconds === undefined ? {} : { offerSeconds }),
      });
    };
    const evmRail = (network: string, asset: string, payTo: string, at: string, transport: GuardedTransport, facilitator: { url: string; kind: X402FacilitatorKind }, offerSeconds: number | undefined, bindAuthorizationNonce: boolean): InboundRail => {
      const { known } = knownAssetFor(network, asset, at);
      if (facilitator.kind === "circle") {
        return createX402Inbound({
          kind: "circle",
          sellerProof: sellerProofFor(network, payTo, at),
          facilitatorUrl: facilitator.url,
          payTo,
          transport,
          ...(known.domain === undefined ? {} : { assetDomain: known.domain }),
          ...(offerSeconds === undefined ? {} : { offerSeconds }),
          ...(bindAuthorizationNonce ? { bindAuthorizationNonce: true } : {}),
          onDiagnostic: (code) => note(`router: facilitator diagnostic ${code} (${at})`),
        });
      }
      // kind `x402`（Base Sepolia、既存）: 今までどおり（`maxTimeoutSeconds` が有効期間を兼ねる）。
      return createX402Inbound({
        facilitatorUrl: facilitator.url,
        payTo,
        transport,
        ...(bindAuthorizationNonce ? { bindAuthorizationNonce: true } : {}),
        ...(offerSeconds === undefined ? {} : { maxTimeoutSeconds: offerSeconds }),
      });
    };
    // 受取先は route ごとに違い得るので、route 単位で adapter を作る。
    for (const route of Object.values(config.router.routes)) {
      if (route.sourceRail !== "x402") continue;
      const at = `routes.${route.routeId}`;
      const payTo = route.source.payTo;
      if (payTo === undefined) {
        throw new ConfigError(`${at}.source.payTo is required for x402 inbound`);
      }
      const facilitator = facilitatorFor(route.source.network, at);
      const isLegacy = route.source.network === LEGACY_X402_INBOUND_NETWORK;
      // 既存の Base Sepolia は今までの transport。新しい静的 rail（Circle・SVM）は名前解決にも期限を置く（SR-2。止まった DNS が HTTP の期限を越えて待たない）。
      const transport = isLegacy ? transportFor(inboundLoopback, report, staticHooks) : createGuardedTransport({ ...staticHooks, allowLoopback: inboundLoopback, report, dns: { timeoutMs: 3_000, maxInFlight: 16 } });
      // 受信 offer の有効期間。承認期限は `min(approvalTtlMs, offerExpiry)` で切られるので
      // ここが短いと **approvalTtlMs を伸ばしても効かない**（人間が承認する運用だと詰まる）。
      inboundRails[`x402:${route.routeId}`] =
        networkFamilyOf(route.source.network) === "svm"
          ? svmRail(route.source.network, route.source.asset, payTo, at, transport, facilitator.url, real.x402InboundOfferSeconds)
          : evmRail(route.source.network, route.source.asset, payTo, at, transport, facilitator, real.x402InboundOfferSeconds, false);
    }
    // 動的プロファイルの受信（x402）: 署名を quote に束縛し、transport は動的用（loopback 不可）。
    for (const profile of Object.values(profiles)) {
      if (profile.sourceRail !== "x402" || dynamicTransport === undefined) continue;
      const at = `dynamic.profiles.${profile.profileId}`;
      const facilitator = facilitatorFor(profile.source.network, at);
      inboundRails[`x402:${profile.profileId}`] =
        networkFamilyOf(profile.source.network) === "svm"
          ? svmRail(profile.source.network, profile.source.asset, profile.source.payTo, at, dynamicTransport, facilitator.url, real.x402InboundOfferSeconds)
          : evmRail(profile.source.network, profile.source.asset, profile.source.payTo, at, dynamicTransport, facilitator, real.x402InboundOfferSeconds, true);
    }
  }

  const usesMppInbound =
    Object.values(config.router.routes).some((route) => route.sourceRail === "mpp") ||
    Object.values(profiles).some((profile) => profile.sourceRail === "mpp");
  if (usesMppInbound) {
    const secretKey = real.mppInboundSecret;
    if (secretKey === undefined) {
      throw new ConfigError(
        'ROUTER_MPP_INBOUND_SECRET is required when a route uses sourceRail "mpp"',
      );
    }
    for (const route of Object.values(config.router.routes)) {
      if (route.sourceRail !== "mpp") continue;
      const payTo = route.source.payTo;
      if (payTo === undefined) {
        throw new ConfigError(`routes.${route.routeId}.source.payTo is required for mpp inbound`);
      }
      // CAIP-2 の `eip155:<id>` から数値 chainId を取り出す（adapter は数値で受ける）。
      const chainId = Number(route.source.network.replace(/^eip155:/, ""));
      if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new ConfigError(
          `routes.${route.routeId}.source.network must be eip155:<chainId> for mpp inbound`,
        );
      }
      inboundRails[`mpp:${route.routeId}`] = createMppInbound({
        secretKey,
        recipient: payTo,
        currency: route.source.asset,
        chainId,
        ...(real.mppInboundRpcUrl === undefined ? {} : { rpcUrl: real.mppInboundRpcUrl }),
        // SDK の JSON-RPC も guarded transport を通る（設計 A §3.5 経路 11）。fixture 例外は他の受信と同じ能力で決まる。
        transport: transportFor(inboundLoopback, report, staticHooks),
        // 承認期限は `min(approvalTtlMs, offerExpiry)` で切られる。既定は x402 受信と揃える。
        maxTimeoutSeconds: real.mppInboundOfferSeconds ?? 600,
      });
    }
    // 動的プロファイルの受信（MPP）: transport は動的用（loopback 不可）。
    for (const profile of Object.values(profiles)) {
      if (profile.sourceRail !== "mpp" || dynamicTransport === undefined) continue;
      const chainId = Number(profile.source.network.replace(/^eip155:/, ""));
      if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new ConfigError(`dynamic.profiles.${profile.profileId}.source.network must be eip155:<chainId> for mpp inbound`);
      }
      inboundRails[`mpp:${profile.profileId}`] = createMppInbound({
        secretKey,
        recipient: profile.source.payTo,
        currency: profile.source.asset,
        chainId,
        ...(real.mppInboundRpcUrl === undefined ? {} : { rpcUrl: real.mppInboundRpcUrl }),
        transport: dynamicTransport,
        maxTimeoutSeconds: real.mppInboundOfferSeconds ?? 600,
      });
    }
  }

  /**
   * 残高の配線（送信の設計 §2.6、D-15）: その経路（routeId／profileId）の rail が `balanceOf` を持てばそれ、無ければ能力の任意の `balanceOf`
   * （既存の互換）、どちらも無ければ `undefined`（core は検査しない）。組ごとの rail の選択は U4 で `railByRoute` に揃える。
   */
  const balanceOfFor = async (id: string, asset: string): Promise<bigint | undefined> => {
    const route = config.router.routes[id];
    const profile = profiles[id];
    const pair = route !== undefined ? { rail: route.rail ?? "x402", network: route.destination.network } : profile !== undefined ? { rail: profile.rail, network: profile.destination.network } : undefined;
    if (pair === undefined) return undefined;
    const rail = rails[outboundPairKeyOf(pair.rail, pair.network)];
    if (rail?.balanceOf !== undefined) return rail.balanceOf(id, asset);
    const capability = pair.rail === "x402" ? evmByNetwork.get(pair.network) : pair.rail === "mpp" ? capabilities.mppTempo : undefined;
    if (capability?.balanceOf !== undefined) return capability.balanceOf(asset);
    return undefined;
  };

  const dynamic: DynamicWiring | undefined =
    gate === undefined
      ? undefined
      : {
          gate,
          balanceOf: async (id, asset) => balanceOfFor(id, asset),
          verify: async () => {
            const mppProfiles = Object.values(profiles).filter((profile) => profile.rail === "mpp");
            if (mppProfiles.length > 0 && capabilities.mppTempo !== undefined) {
              await assertDynamicMppCapability(capabilities.mppTempo, profiles);
              // 能力の RPC ホストは拒否ホストに入っていること（`dependencyUrls` で申告する）。
              for (const profile of mppProfiles) {
                const client = await capabilities.mppTempo.getClient({ chainId: Number(profile.destination.network.replace(/^eip155:/, "")) });
                const url = (client.transport as { url?: unknown }).url;
                const host = typeof url === "string" ? new URL(url).hostname.toLowerCase().replace(/\.$/, "") : undefined;
                if (host === undefined || !denyHosts.includes(host)) {
                  throw new ConfigError("the MPP capability's RPC host must be declared in RouterCapabilities.dependencyUrls (dynamic deny hosts)");
                }
              }
              // RPC ノードは `eth_fillTransaction` に対応していること（見積りが 1 回の RPC で済む。非対応ノードは quote・purchase の RPC が
              // 宛先アドレスの枠に収まらない。`docs/dynamic-gas-fee-design.md` §4）。読取だけ（署名も送金もしない。自分宛て 1 base unit の見積り）。
              for (const profile of mppProfiles) {
                const probe = { scheme: profile.destination.scheme, network: profile.destination.network, asset: profile.destination.asset, amount: "1", payTo: capabilities.mppTempo.account.address };
                let estimate;
                try {
                  estimate = await rails[outboundPairKeyOf("mpp", profile.destination.network)]!.estimateFee!(profile.profileId, probe, { url: "https://startup.invalid/" });
                } catch {
                  throw new ConfigError(`dynamic profile ${profile.profileId}: the Tempo RPC did not answer a read-only fee estimate at startup`);
                }
                if (estimate.viaFillTransaction !== true) {
                  throw new ConfigError(`dynamic profile ${profile.profileId}: the Tempo RPC must support eth_fillTransaction (dynamic-gas-fee-design §4)`);
                }
              }
            }
          },
        };

  // 送信（SVM）の startup は受信の検査の後（送信の設計 §2.2・§4.4）。
  startupChecks.push(...svmStartups);

  return {
    ...(startupChecks.length === 0 ? {} : { startup: async () => { for (const check of startupChecks) await check(); } }),
    inbound: inboundByRoute(config.router.routes, inboundRails, profiles),
    outbound: railByRoute(config.router.routes, rails, profiles),
    // 残高の hook は動的の設定の有無と独立に渡す（静的だけの構成でも静的 route の残高を見る。送信の設計 §2.6）。
    balanceOf: balanceOfFor,
    ...(dynamic === undefined ? {} : { dynamic }),
  };
}

/**
 * 起動ログの証拠ラベル。**署名しない fixture 能力で走っているレールを隠さない**
 * （B だけを fixture 能力で動かしている構成を `real` と表示しない）。
 */
function evidenceLabelOf(config: RuntimeConfig, capabilities: RouterCapabilities): string {
  if (config.adapterMode === "synthetic") {
    return "T1-synthetic-nopay";
  }
  const labels: string[] = [];
  if (capabilities.evmSigning?.kind === "non-signing-fixture") {
    labels.push("T2-fixture-nopay");
  }
  if (capabilities.mppTempo?.kind === "non-signing-fixture") {
    labels.push("T3-fixture-nopay");
  }
  return labels.length === 0 ? "real" : labels.join("+");
}

/**
 * 内部アドレスを指す上流を**警告する**（起動は止めない。設計 §3.2）。
 *
 * **止めない理由**: 合成 fixture は loopback を要するし、
 * ローカルで実 facilitator を立てる構成も正当。ここで塞ぐと試験と実験が動かない。
 *
 * **これは SSRF 対策ではない**: 上流 URL は設定値で、攻撃者が注入する経路は無い。
 * 守っているのは**運用者の設定ミス**であり、検出と可視化で足りる。
 * 攻撃者が URL を選べる構成に進むときは、DNS 解決後・接続時の強制を別途設計する。
 *
 * **アドレスの prefix 判定は IP リテラルにだけ当てる。** ホスト名に当てると
 * `10.example.com` や `fcm.googleapis.com` のような**正当な公開ホストを誤検知**する
 * （レビューと自己検証の両方で発見）。DNS 名は suffix 規則で別に見る。
 *
 * 判定はホスト名の文字列のみ。**DNS は引かない**ので、
 * 公開名が内部アドレスに解決する場合は検出できない（既知の限界）。
 */
/**
 * 起動時の**文字列**検査（警告のみ）。強制は SSRF 防御 A の transport（`src/net/guarded-fetch.ts`）が
 * 接続前に行う。ここは運用者が設定ミスに早く気付くための補助で、無くても守りは変わらない。
 */
export function warnIfInternalUpstream(
  upstreams: Readonly<Record<string, string>>,
  write: (message: string) => void,
): void {
  for (const [routeId, raw] of Object.entries(upstreams)) {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue; // 形が壊れた URL は設定検証が別途弾く。
    }
    // `new URL()` は IPv6 を角括弧付きで返す。中身だけを見る。
    const bracketed = host.startsWith("[") && host.endsWith("]");
    const bare = bracketed ? host.slice(1, -1) : host;

    // IPv4 リテラル（4 オクテット）だけを prefix 判定の対象にする。
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
    const privateV4 =
      v4 !== null &&
      ((): boolean => {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return (
          a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31)
        );
      })();

    // IPv6 リテラルは**コロンを含む形**だけで判定する。
    const privateV6 =
      bare.includes(":") &&
      (bare === "::1" ||
        bare.startsWith("fe80:") ||
        // ULA は fc00::/7。**ヘクステットは 4 桁**なので、先頭 2 桁が `fc`/`fd` でも
        // `fc::1`（= 00fc:…）や `fc0::1` は範囲外。桁数を 2 に固定して誤検知を避ける。
        /^f[cd][0-9a-f]{2}:/.test(bare));

    // DNS 名は suffix 規則で別に見る（prefix は使わない）。
    const internalName =
      bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".internal");

    if (privateV4 || privateV6 || internalName) {
      // **URL もホスト名も出さない**（`docs/DEPLOY.md` の方針）。route だけ示す。
      write(`warning: upstream for route ${routeId} points at an internal address\n`);
    }
  }
}

export async function startRouter(capabilities: RouterCapabilities = {}): Promise<void> {
  const config = loadRuntimeConfig(process.env, (file) => readFileSync(file, "utf8"), { networks: capabilities.knownNetworksForTest ?? KNOWN_NETWORKS });
  const rails = composeRails(config, capabilities);
  // 起動時の検査（SVM 受信の `/supported`・ATA。multirail 設計 §5.1）。失敗すれば起動しない。
  await rails.startup?.();
  // 動的プロファイルの MPP 能力の起動時の確認（client が素の http transport で、プロファイルの chain のものか）。
  await rails.dynamic?.verify();

  mkdirSync(path.dirname(path.resolve(config.journalPath)), { recursive: true });
  if (config.adapterMode === "real" && config.real !== undefined) {
    warnIfInternalUpstream(config.real.upstreams, (m) => process.stderr.write(m));
  }

  const core = await createRouterCore({
    journalPath: config.journalPath,
    config: config.router,
    inbound: rails.inbound,
    outbound: rails.outbound,
    // 拒否の理由を運用者に伝える（固定文のみ。値は渡さない）。
    note: (message) => process.stderr.write(`${message}\n`),
    ...(rails.balanceOf === undefined ? {} : { balanceOf: rails.balanceOf }),
    ...(rails.dynamic === undefined ? {} : { dynamic: dynamicCoreOptionsOf(rails.dynamic, capabilities, config) }),
  });

  // 合成構成が `crashBarrierPath` を指定したときだけ、応答直前で停止するシームを渡す。
  // 到達を書き出したあとは自分からは進まない（応答バイトを出さない）。
  const barrierPath = config.synthetic?.crashBarrierPath;
  const beforeDeliveredResponse =
    barrierPath === undefined
      ? undefined
      : async (paymentId: string): Promise<void> => {
          writeFileSync(barrierPath, JSON.stringify({ event: "before_response", paymentId }));
          await new Promise<never>(() => {});
        };

  let server;
  try {
    server = await startHttpServer({
      core,
      config: config.router,
      canonicalBaseUrl: config.http.canonicalBaseUrl,
      principals: config.principals,
      host: config.http.host,
      port: config.http.port,
      ...(beforeDeliveredResponse === undefined ? {} : { beforeDeliveredResponse }),
    });
  } catch (error) {
    // listen できなければ journal ロックも解放してから落ちる。
    await core.close();
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "listening",
      port: server.port,
      host: config.http.host,
      mode: config.adapterMode,
      // どの証拠ラベルで走っているかを起動ログに残す（実決済を主張しない）。
      label: evidenceLabelOf(config, capabilities),
    })}\n`,
  );

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void (async () => {
      await server.close();
      await core.close();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * core に渡す動的の配線。残高の検査は経路ごと（送信の設計 §2.6）: 配線の `balanceOf` が `undefined` を返す経路は検査しないので、
 * **常に渡す**（以前は「全プロファイルの能力が持つときだけ」だった。持たない経路が常に不足になる問題は `undefined` で解けた）。
 */
export function dynamicCoreOptionsOf(wiring: DynamicWiring, _capabilities: RouterCapabilities, _config: RuntimeConfig): { gate: DynamicGate; balanceOf?: (id: string, asset: string) => Promise<bigint | undefined> } {
  return { gate: wiring.gate, ...(wiring.balanceOf === undefined ? {} : { balanceOf: wiring.balanceOf }) };
}

/** 起動失敗は固定コードとメッセージだけを出す（秘密もスタックも載せない）。 */
export function reportStartupFailure(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : "unknown startup failure";
  process.stderr.write(
    `router startup failed: ${typeof code === "string" ? code : "startup_failed"}: ${message}\n`,
  );
  process.exit(1);
}

// CLI として実行されたときだけ起動する（能力の注入が必要な構成は import 側が呼ぶ）。
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  startRouter().catch(reportStartupFailure);
}
