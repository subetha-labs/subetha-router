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
import { createX402Inbound } from "./adapters/inbound/x402.js";
import { createMppOutbound } from "./adapters/outbound/mpp.js";
import { createSyntheticX402Outbound, createX402Outbound } from "./adapters/outbound/x402.js";
import {
  ConfigError,
  loadRuntimeConfig,
  routeBindingOf,
  type RouteConfig,
  type RuntimeConfig,
} from "./config.js";
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
}

/**
 * `routeId` から送信レールを引く（core は rail 名で分岐しない）。allowlist は
 * 構成の `routes[].rail` だけで、未登録の routeId はどのレールにも届かない。
 */
function railByRoute(
  routes: Readonly<Record<string, { readonly rail?: string }>>,
  rails: Readonly<Record<string, OutboundRail>>,
): OutboundRail {
  const byRoute = new Map<string, OutboundRail>();
  for (const [routeId, route] of Object.entries(routes)) {
    const rail = rails[route.rail ?? "x402"];
    if (rail === undefined) {
      throw new SignerNotAuthorizedError();
    }
    byRoute.set(routeId, rail);
  }
  const railFor = (routeId: string): OutboundRail => {
    const rail = byRoute.get(routeId);
    if (rail === undefined) {
      throw new Error("no outbound rail configured for route");
    }
    return rail;
  };
  return {
    readChallenge: (routeId) => railFor(routeId).readChallenge(routeId),
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
): InboundRail {
  const byRoute = new Map<string, InboundRail>();
  const byBinding = new Map<string, InboundRail>();
  for (const route of Object.values(routes)) {
    const sourceRail = route.sourceRail ?? "subetha";
    // x402 受信は受取先が route ごとなので `x402:<routeId>` で引く。
    const rail = rails[sourceRail === "x402" ? `x402:${route.routeId}` : sourceRail];
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
    const rail = byBinding.get(offer.extra.routeBinding);
    if (rail === undefined) {
      // 発行していない束縛の offer は扱わない。
      throw new Error("no inbound rail for offer route binding");
    }
    return rail;
  };
  return {
    createOffer: (request) => forRoute(request.routeId).createOffer(request),
    preflight: (offer, credential, nowMs) => forOffer(offer).preflight(offer, credential, nowMs),
    verify: (offer, credential) => forOffer(offer).verify(offer, credential),
    settle: (offer, credential) => forOffer(offer).settle(offer, credential),
  };
}

export function composeRails(
  config: RuntimeConfig,
  capabilities: RouterCapabilities,
): { inbound: InboundRail; outbound: OutboundRail } {
  // 合成レールは `synthetic` を明示したときだけ（既定では選ばれない）。
  if (config.adapterMode === "synthetic") {
    if (config.synthetic === undefined) {
      throw new SignerNotAuthorizedError();
    }
    return {
      inbound: createSubethaInbound({ facilitatorUrl: config.synthetic.facilitatorUrl }),
      outbound: createSyntheticX402Outbound({ upstreams: config.synthetic.upstreams }),
    };
  }

  const real = config.real;
  if (real === undefined) {
    throw new SignerNotAuthorizedError();
  }

  // 経路ごとに必要な能力だけを要求する（レール B だけの構成でも A の鍵を要求しない）。
  const railsInUse = new Set(
    Object.values(config.router.routes).map((route) => route.rail ?? "x402"),
  );
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
      rails[rail] = createX402Outbound({ upstreams: upstreamsFor(rail), capability });
      continue;
    }
    if (rail === "mpp") {
      const capability = capabilities.mppTempo;
      if (capability === undefined) {
        throw new SignerNotAuthorizedError();
      }
      rails[rail] = createMppOutbound({ upstreams: upstreamsFor(rail), capability });
      continue;
    }
    // 知らないレール名は合成にも落とさず起動を止める。
    throw new SignerNotAuthorizedError();
  }

  // 受信レールも route ごとに選ぶ（既定は subetha＝既存構成をそのまま維持）。
  const inboundRails: Record<string, InboundRail> = {
    subetha: createSubethaInbound({ facilitatorUrl: real.subethaFacilitatorUrl }),
  };
  const usesX402Inbound = Object.values(config.router.routes).some(
    (route) => route.sourceRail === "x402",
  );
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
        // 受信 offer の有効期間。承認期限は `min(approvalTtlMs, offerExpiry)` で切られるので
        // ここが短いと **approvalTtlMs を伸ばしても効かない**（人間が承認する運用だと詰まる）。
        ...(real.x402InboundOfferSeconds === undefined
          ? {}
          : { maxTimeoutSeconds: real.x402InboundOfferSeconds }),
      });
    }
  }

  return {
    inbound: inboundByRoute(config.router.routes, inboundRails),
    outbound: railByRoute(config.router.routes, rails),
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

export async function startRouter(capabilities: RouterCapabilities = {}): Promise<void> {
  const config = loadRuntimeConfig(process.env, (file) => readFileSync(file, "utf8"));
  const rails = composeRails(config, capabilities);

  mkdirSync(path.dirname(path.resolve(config.journalPath)), { recursive: true });
  const core = await createRouterCore({
    journalPath: config.journalPath,
    config: config.router,
    inbound: rails.inbound,
    outbound: rails.outbound,
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
