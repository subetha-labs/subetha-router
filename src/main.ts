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
import { createSyntheticX402Outbound, createX402Outbound } from "./adapters/outbound/x402.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { createRouterCore } from "./core/orchestrator.js";
import { startHttpServer } from "./http/app.js";
import type { InboundRail } from "./ports/inbound.js";
import type { EvmSigningCapability, OutboundRail } from "./ports/outbound.js";

/**
 * 送信レール A の署名能力が無い（`real` モード）。**合成には落とさず** fail closed。
 * 実鍵の権限は本タスクで解除されていないため、CLI 既定はここで止まるのが正しい状態。
 */
class SignerNotAuthorizedError extends Error {
  readonly code = "signer_not_authorized";

  constructor() {
    super(
      "signer_not_authorized: the x402 outbound rail is wired to the official SDK, but no EVM " +
        "signing capability was injected. Real payments need a separate credential gate; " +
        "set ROUTER_ADAPTER_MODE=synthetic for the in-repo no-money loopback fixtures.",
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
  const capability = capabilities.evmSigning;
  if (capability === undefined) {
    // 実 SDK 配線はできているが、署名能力が無い。偽の署名者で代替しない。
    throw new SignerNotAuthorizedError();
  }
  return {
    inbound: createSubethaInbound({ facilitatorUrl: real.subethaFacilitatorUrl }),
    outbound: createX402Outbound({ upstreams: real.upstreams, capability }),
  };
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
      label:
        config.adapterMode === "synthetic"
          ? "T1-synthetic-nopay"
          : capabilities.evmSigning?.kind === "non-signing-fixture"
            ? "T2-fixture-nopay"
            : "real",
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
