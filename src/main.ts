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
import { createX402Inbound } from "./adapters/inbound/x402.js";
import { createMppOutbound } from "./adapters/outbound/mpp.js";
import { assertDynamicMppCapability } from "./adapters/outbound/mpp-dynamic.js";
import { createSyntheticX402Outbound, createX402Outbound } from "./adapters/outbound/x402.js";
import { DYNAMIC_RESPONSE_LIMITS } from "./net/bounded-body.js";
import { createGuardedTransport, formatTransportEvent, type GuardedTransport, type GuardedTransportOptions, type TransportEvent } from "./net/guarded-fetch.js";
import { denyHostsOf } from "./net/upstream-url.js";
import {
  ConfigError,
  loadRuntimeConfig,
  routeBindingOf,
  type DynamicProfile,
  type RouteConfig,
  type RuntimeConfig,
} from "./config.js";
import { tempo as tempoMainnet, tempoModerato } from "viem/tempo/chains";

import { DynamicGate } from "./core/dynamic-gate.js";
import { createRouterCore } from "./core/orchestrator.js";
import { startHttpServer } from "./http/app.js";
import type { InboundOffer, InboundRail } from "./ports/inbound.js";
import type {
  EvmSigningCapability,
  MppTempoCapability,
  OutboundRail,
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
  /** 送信レール A（x402 / EVM）の署名能力。 */
  readonly evmSigning?: EvmSigningCapability;
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
   * 能力が接続する依存先（送信 MPP の RPC など）の URL。動的上流 URL の**拒否ホスト**に入れる（設計 §7.4）。
   * 起動時の確認で、MPP 能力の client の RPC ホストがここに含まれていなければ起動を止める。
   */
  readonly dependencyUrls?: readonly string[];
}

/**
 * **試験専用。** 動的用 transport に fixture が足せるのは、名前解決・接続先の差し替え・試験用 CA・インタフェース一覧だけ。
 * 方針の欄（loopback 不可・DNS の期限・ヘッダの上限・門の `admit`）は配線が後から重ねるので、fixture は変えられない。
 */
export type DynamicTransportHooks = Omit<GuardedTransportOptions, "allowLoopback" | "report" | "maxHeaderSize" | "dns" | "admit">;

/** 動的上流 URL の配線が core に渡すもの。 */
export interface DynamicWiring {
  readonly gate: DynamicGate;
  readonly balanceOf?: (profileId: string, asset: string) => Promise<bigint>;
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
function railByRoute(
  routes: Readonly<Record<string, { readonly rail?: string }>>,
  rails: Readonly<Record<string, OutboundRail>>,
  profiles: Readonly<Record<string, DynamicProfile>> = {},
): OutboundRail {
  const byRoute = new Map<string, OutboundRail>();
  for (const [routeId, route] of Object.entries(routes)) {
    const rail = rails[route.rail ?? "x402"];
    if (rail === undefined) {
      throw new SignerNotAuthorizedError();
    }
    byRoute.set(routeId, rail);
  }
  // 動的プロファイルも同じ Map で引く（ID の名前空間は route と共通）。
  for (const [profileId, profile] of Object.entries(profiles)) {
    const rail = rails[profile.rail];
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
export function transportFor(allowLoopback: boolean, report: (event: TransportEvent) => void): GuardedTransport {
  return createGuardedTransport({ allowLoopback, report });
}

export function composeRails(
  config: RuntimeConfig,
  capabilities: RouterCapabilities,
  report: (event: TransportEvent) => void = reportTransportToStderr((m) => process.stderr.write(m)),
): { inbound: InboundRail; outbound: OutboundRail; dynamic?: DynamicWiring } {
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
  // 自分自身と依存先には向けない（設計 §7.4）: facilitator・上流・自分の canonical・受信 MPP の RPC・能力の依存先の各ホスト名。
  const denyHosts =
    dynamicConfig === undefined
      ? []
      : denyHostsOf(dynamicConfig.denyHosts, [
          real.subethaFacilitatorUrl,
          real.x402InboundFacilitatorUrl,
          config.http.canonicalBaseUrl,
          ...Object.values(real.upstreams),
          ...mppInboundChains.map((chainId) => mppInboundRpcUrlFor(chainId)),
          ...(capabilities.dependencyUrls ?? []),
        ]);
  const dynamicOptionsFor = (rail: "x402" | "mpp") => {
    if (dynamicTransport === undefined) return {};
    const own = Object.fromEntries(Object.entries(profiles).filter(([, profile]) => profile.rail === rail));
    return Object.keys(own).length === 0 ? {} : { dynamic: { profiles: own, transport: dynamicTransport, denyHosts } };
  };

  // 経路ごとに必要な能力だけを要求する（レール B だけの構成でも A の鍵を要求しない）。プロファイルのレールも数える。
  const railsInUse = new Set([
    ...Object.values(config.router.routes).map((route) => route.rail ?? "x402"),
    ...Object.values(profiles).map((profile) => profile.rail),
  ]);
  /** そのレールが担当する経路の上流だけを渡す（A の検査を B の URL に掛けない）。 */
  const upstreamsFor = (rail: string): Record<string, string> =>
    Object.fromEntries(
      Object.entries(config.router.routes)
        .filter(([, route]) => (route.rail ?? "x402") === rail)
        .map(([routeId]) => [routeId, real.upstreams[routeId] as string]),
    );

  const rails: Record<string, OutboundRail> = {};
  for (const rail of railsInUse) {
    if (rail === "x402") {
      const capability = capabilities.evmSigning;
      if (capability === undefined) {
        // 実 SDK 配線はできているが、署名能力が無い。偽の署名者で代替しない。
        throw new SignerNotAuthorizedError();
      }
      rails[rail] = createX402Outbound({
        upstreams: upstreamsFor(rail),
        capability,
        transport: transportFor(capability.kind === "non-signing-fixture", report),
        ...dynamicOptionsFor("x402"),
      });
      continue;
    }
    if (rail === "mpp") {
      const capability = capabilities.mppTempo;
      if (capability === undefined) {
        throw new SignerNotAuthorizedError();
      }
      rails[rail] = createMppOutbound({
        upstreams: upstreamsFor(rail),
        capability,
        transport: transportFor(capability.kind === "non-signing-fixture", report),
        ...dynamicOptionsFor("mpp"),
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
      transport: transportFor(inboundLoopback, report),
    }),
  };
  const usesX402Inbound =
    Object.values(config.router.routes).some((route) => route.sourceRail === "x402") ||
    Object.values(profiles).some((profile) => profile.sourceRail === "x402");
  if (usesX402Inbound) {
    if (real.x402InboundFacilitatorUrl === undefined) {
      throw new ConfigError(
        "ROUTER_X402_INBOUND_FACILITATOR_URL is required when a route uses sourceRail \"x402\"",
      );
    }
    // 受取先は route ごとに違い得るので、route 単位で adapter を作る。
    for (const route of Object.values(config.router.routes)) {
      if (route.sourceRail !== "x402") continue;
      const payTo = route.source.payTo;
      if (payTo === undefined) {
        throw new ConfigError(`routes.${route.routeId}.source.payTo is required for x402 inbound`);
      }
      inboundRails[`x402:${route.routeId}`] = createX402Inbound({
        facilitatorUrl: real.x402InboundFacilitatorUrl,
        payTo,
        transport: transportFor(inboundLoopback, report),
        // 受信 offer の有効期間。承認期限は `min(approvalTtlMs, offerExpiry)` で切られるので
        // ここが短いと **approvalTtlMs を伸ばしても効かない**（人間が承認する運用だと詰まる）。
        ...(real.x402InboundOfferSeconds === undefined
          ? {}
          : { maxTimeoutSeconds: real.x402InboundOfferSeconds }),
      });
    }
    // 動的プロファイルの受信（x402）: 署名を quote に束縛し、transport は動的用（loopback 不可）。
    for (const profile of Object.values(profiles)) {
      if (profile.sourceRail !== "x402" || dynamicTransport === undefined) continue;
      inboundRails[`x402:${profile.profileId}`] = createX402Inbound({
        facilitatorUrl: real.x402InboundFacilitatorUrl,
        payTo: profile.source.payTo,
        transport: dynamicTransport,
        bindAuthorizationNonce: true,
        ...(real.x402InboundOfferSeconds === undefined ? {} : { maxTimeoutSeconds: real.x402InboundOfferSeconds }),
      });
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
        transport: transportFor(inboundLoopback, report),
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

  const dynamic: DynamicWiring | undefined =
    gate === undefined
      ? undefined
      : {
          gate,
          balanceOf: async (profileId, asset) => {
            const profile = profiles[profileId];
            const capability = profile?.rail === "x402" ? capabilities.evmSigning : profile?.rail === "mpp" ? capabilities.mppTempo : undefined;
            if (capability?.balanceOf === undefined) {
              // `dynamicCoreOptionsOf` が全プロファイルに能力があるときだけ渡すので、ここには来ない。来たら不足として扱う。
              throw new Error("balance unavailable");
            }
            return capability.balanceOf(asset);
          },
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
            }
          },
        };

  return {
    inbound: inboundByRoute(config.router.routes, inboundRails, profiles),
    outbound: railByRoute(config.router.routes, rails, profiles),
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
  const config = loadRuntimeConfig(process.env, (file) => readFileSync(file, "utf8"));
  const rails = composeRails(config, capabilities);
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
 * core に渡す動的の配線。残高の検査（設計 §6.6）は core では「`balanceOf` があれば検査、無ければしない」の 1 本なので、
 * **全プロファイルの能力が `balanceOf` を持つときだけ**渡す（一部だけだと、持たない方の購入が常に残高不足になる）。
 */
export function dynamicCoreOptionsOf(wiring: DynamicWiring, capabilities: RouterCapabilities, config: RuntimeConfig): { gate: DynamicGate; balanceOf?: (profileId: string, asset: string) => Promise<bigint> } {
  const profiles = Object.values(config.router.dynamic?.profiles ?? {});
  const allBalance =
    profiles.length > 0 &&
    profiles.every((profile) => (profile.rail === "x402" ? capabilities.evmSigning?.balanceOf !== undefined : capabilities.mppTempo?.balanceOf !== undefined));
  return { gate: wiring.gate, ...(allBalance && wiring.balanceOf !== undefined ? { balanceOf: wiring.balanceOf } : {}) };
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
