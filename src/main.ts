/**
 * Router の実 CLI エントリポイント（設計 §10 M2/M3、タスク T1b）。
 * config 読み込み → adapter 合成 → journal ロック取得 → HTTP listen を行う。
 *
 * **合成実装を本番既定にしない**: 既定の `ROUTER_ADAPTER_MODE=real` では実 adapter を
 * 解決できず `adapter_not_wired` で起動を中止する（synthetic へは落とさない）。合成レールは
 * `ROUTER_ADAPTER_MODE=synthetic` を明示したときだけ、リポジトリ内の既知の fixture 構成として
 * 組み立てる（任意のプラグイン読み込みは行わない）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createSubethaInbound } from "./adapters/inbound/subetha.js";
import { createSyntheticX402Outbound } from "./adapters/outbound/x402.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { createRouterCore } from "./core/orchestrator.js";
import { startHttpServer } from "./http/app.js";
import type { InboundRail } from "./ports/inbound.js";
import type { OutboundRail } from "./ports/outbound.js";

/** 実 adapter はまだ配線されていない（T2 / T3 のゲート）。合成に落とさず起動を中止する。 */
class AdapterNotWiredError extends Error {
  readonly code = "adapter_not_wired";

  constructor() {
    super(
      "adapter_not_wired: real rails are not wired yet (T2/T3). " +
        "Set ROUTER_ADAPTER_MODE=synthetic to run the in-repo no-money loopback fixtures.",
    );
    this.name = "AdapterNotWiredError";
  }
}

function composeRails(config: RuntimeConfig): { inbound: InboundRail; outbound: OutboundRail } {
  if (config.adapterMode !== "synthetic" || config.synthetic === undefined) {
    throw new AdapterNotWiredError();
  }
  return {
    inbound: createSubethaInbound({ facilitatorUrl: config.synthetic.facilitatorUrl }),
    outbound: createSyntheticX402Outbound({ upstreams: config.synthetic.upstreams }),
  };
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.env, (file) => readFileSync(file, "utf8"));
  const rails = composeRails(config);

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
      // 合成レールでの実行であることを起動ログにも残す。
      label: config.adapterMode === "synthetic" ? "T1-synthetic-nopay" : "real",
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

main().catch((error: unknown) => {
  // 秘密を出さないよう、固定コードとメッセージだけを出す（スタックも載せない）。
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : "unknown startup failure";
  process.stderr.write(
    `router startup failed: ${typeof code === "string" ? code : "startup_failed"}: ${message}\n`,
  );
  process.exit(1);
});
