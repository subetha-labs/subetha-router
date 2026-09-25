/**
 * T5 の足場。**テスト基盤であり製品コードではない。**
 *
 * 既存 `router-harness.ts` との違いは 2 点だけで、そのどちらも chat 実装を実 TCP で
 * 駆動するために必要になったもの:
 *
 * 1. **canonical origin と実際の待ち受け origin を一致させる。** 既存 harness は
 *    `ROUTER_HTTP_PORT=0`（エフェメラル）と canonical `:8500` を意図的に別値にしている
 *    （T4 client は自分の `baseUrl` に固定するので無害）。しかし chat 側は
 *    `binding.quote.resource.url` へ**実際に fetch する**ため、不一致だと R3 が実 Router に
 *    届かない（`:8500` の無関係なプロセスへ飛ぶ事故もあり得る）。
 * 2. **Router の手前に計数プロキシを置く。** Router には HTTP アクセスログが無いので、
 *    「要求が Router に届いていない」ことを chat の journal 以外から確かめる口が必要。
 *
 * 上流は chat 側 `market-data.mjs` の snapshot プロファイルに適合する fixture を使う。
 * 鍵・署名・送金・有料 API はなく、すべて 127.0.0.1 の使い捨てポート。
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { startListening, type Listening } from "./loopback.js";
import {
  ALICE,
  BOB,
  DEST_ASSET,
  DEST_NETWORK,
  DEST_PAY_TO,
  ROUTE_A,
  ROUTE_B,
  SOURCE_NETWORK,
  SOURCE_TOKEN,
} from "./router-harness.js";

export { ALICE, BOB, ROUTE_A, ROUTE_B };

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

/**
 * chat 実装の所在。**読み取り専用**で参照するだけで、一切変更しない。
 *
 * chat 実装は**別リポジトリ**にあるため、場所は `T5_CHAT_APP_DIR` で渡す。
 * 未設定・不在なら T5 は **skip** する（`chatAppAvailable`）。
 * 「chat 側の契約が変わって落ちた」のと「パスが無くて落ちた」のを混同しないため、
 * 不在は失敗ではなく skip として扱う。
 */
export const CHAT_APP_DIR = process.env["T5_CHAT_APP_DIR"] ?? "";

/** chat 実装が読める場所にあるか（無い環境ではテストを skip する）。 */
export function chatAppAvailable(): boolean {
  if (CHAT_APP_DIR === "") return false;
  return (
    existsSync(path.join(CHAT_APP_DIR, "router-execution.mts")) &&
    existsSync(path.join(CHAT_APP_DIR, "router-contract.mjs")) &&
    existsSync(path.join(CHAT_APP_DIR, "market-data.mjs"))
  );
}

function routeConfig(routeId: string, rail: string): unknown {
  return {
    routeId,
    canonicalPath: `/v1/routes/${routeId}/resource`,
    rail,
    source: { amount: "1500", asset: SOURCE_TOKEN, decimals: 6, network: SOURCE_NETWORK },
    destination: {
      scheme: "exact",
      network: DEST_NETWORK,
      asset: DEST_ASSET,
      payTo: DEST_PAY_TO,
    },
  };
}

/**
 * 空きポートを 1 つ確保する。確保と listen の間の競合（TOCTOU）は残るため、
 * **取り直しや再試行はしない**（偽陽性のある緑を作らないため、失敗はそのまま失敗させる）。
 */
async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) {
          reject(new Error("could not reserve a port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

export interface CrossImplHarness {
  readonly workDir: string;
  readonly journalPath: string;
  readonly configPath: string;
  readonly barrierPath: string;
  readonly facilitator: Listening;
  readonly upstreamA: Listening;
  readonly upstreamB: Listening;
  readonly proxy: Listening;
  /** chat から見た Router の origin（= proxy）。canonical URL もこの origin で揃えてある。 */
  readonly routerOrigin: string;
  router: Listening;
  restartRouter(): Promise<void>;
  /** proxy が数えた R1/R2/R3/R4 の到達回数。 */
  proxyCalls(): Promise<ProxyCalls>;
  stop(): Promise<void>;
}

export interface ProxyCalls {
  readonly R1: number;
  readonly R2: number;
  readonly R3: number;
  readonly R4: number;
  readonly order: readonly string[];
}

export interface CrossImplOptions {
  /** 承認 TTL。期限切れの検証では極小値を渡す。 */
  readonly approvalTtlMs?: number;
  /** canonical base URL を実 origin と**別**にする（canonical 改変の検証用）。 */
  readonly canonicalBaseUrlOverride?: string;
  /** 上流 A の応答モード。 */
  readonly pay?: string;
  /** R3 の応答バイト送出前にクラッシュさせるバリアを仕込む。 */
  readonly crashBarrier?: boolean;
}

export async function startCrossImplHarness(
  options: CrossImplOptions = {},
): Promise<CrossImplHarness> {
  await mkdir(runtimeRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(runtimeRoot, "t5-"));
  const journalPath = path.join(workDir, "journal.ndjson");
  const configPath = path.join(workDir, "router.config.json");
  const barrierPath = path.join(workDir, "crash-barrier.json");
  const barrierConfigPath = path.join(workDir, "router.barrier.config.json");

  const facilitator = await startListening("tests/fixtures/facilitator-server.ts", [
    "--token",
    SOURCE_TOKEN,
    "--chain-id",
    "11155111",
    "--settle",
    "ok",
    "--verify",
    "ok",
  ]);
  const started: Listening[] = [facilitator];
  const stopStarted = async (): Promise<void> => {
    await Promise.all(started.map((listening) => listening.stop()));
  };

  try {
    const upstreamA = await startListening("tests/fixtures/market-snapshot-server.ts", [
      "--provider",
      "a",
      "--pay",
      options.pay ?? "ok",
    ]);
    started.push(upstreamA);
    const upstreamB = await startListening("tests/fixtures/market-snapshot-server.ts", [
      "--provider",
      "b",
      "--pay",
      "ok",
    ]);
    started.push(upstreamB);

    // Router の待ち受けポートを先に決め、canonical と proxy の転送先を同じ値に揃える。
    const routerPort = await reservePort();
    const routerOrigin = `http://127.0.0.1:${routerPort}`;

    const proxy = await startListening("tests/fixtures/router-calls-proxy.ts", [
      "--target",
      routerOrigin,
    ]);
    started.push(proxy);

    // chat が実際に叩く origin は proxy。canonical URL もその origin で発行させる
    // （既定では別 origin になり R3 が Router に届かない）。
    const canonicalBaseUrl = options.canonicalBaseUrlOverride ?? proxy.baseUrl;

    const document = {
      router: {
        approvalTtlMs: options.approvalTtlMs ?? 60_000,
        routes: {
          [ROUTE_A]: routeConfig(ROUTE_A, "x402"),
          [ROUTE_B]: routeConfig(ROUTE_B, "x402"),
        },
        budget: {
          maxPurchases: 8,
          buckets: [
            {
              network: SOURCE_NETWORK,
              asset: SOURCE_TOKEN,
              maxTotal: "100000",
              maxPerPurchase: "5000",
            },
            {
              network: DEST_NETWORK,
              asset: DEST_ASSET,
              maxTotal: "100000",
              maxPerPurchase: "5000",
            },
          ],
        },
      },
      synthetic: {
        facilitatorUrl: facilitator.baseUrl,
        upstreams: {
          [ROUTE_A]: `${upstreamA.baseUrl}/v1/eth/snapshot`,
          [ROUTE_B]: `${upstreamB.baseUrl}/v1/eth/snapshot`,
        },
      },
    };
    await writeFile(configPath, JSON.stringify(document, null, 2), "utf8");
    if (options.crashBarrier === true) {
      await writeFile(
        barrierConfigPath,
        JSON.stringify(
          { ...document, synthetic: { ...document.synthetic, crashBarrierPath: barrierPath } },
          null,
          2,
        ),
        "utf8",
      );
    }

    const routerEnv = {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_JOURNAL_PATH: journalPath,
      ROUTER_HTTP_PORT: `${routerPort}`,
      ROUTER_CANONICAL_BASE_URL: canonicalBaseUrl,
      ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token},${BOB.id}:${BOB.token}`,
      // 合成レールは**明示指定でのみ**選択される。署名能力は注入しない。
      ROUTER_ADAPTER_MODE: "synthetic",
    };

    const router = await startListening(
      "src/main.ts",
      [],
      options.crashBarrier === true
        ? { ...routerEnv, ROUTER_CONFIG_PATH: barrierConfigPath }
        : routerEnv,
    );
    started.push(router);

    const harness: CrossImplHarness = {
      workDir,
      journalPath,
      configPath,
      barrierPath,
      facilitator,
      upstreamA,
      upstreamB,
      proxy,
      routerOrigin: proxy.baseUrl,
      router,
      async restartRouter(): Promise<void> {
        await harness.router.stop();
        harness.router = await startListening("src/main.ts", [], routerEnv);
      },
      async proxyCalls(): Promise<ProxyCalls> {
        const response = await fetch(`${proxy.baseUrl}/__calls`);
        return (await response.json()) as ProxyCalls;
      },
      async stop(): Promise<void> {
        await Promise.all([
          harness.router.stop(),
          proxy.stop(),
          upstreamA.stop(),
          upstreamB.stop(),
          facilitator.stop(),
        ]);
      },
    };
    return harness;
  } catch (error) {
    await stopStarted();
    throw error;
  }
}

/** 上流 fixture の `/calls`（課金呼び出しが本当に 0 かを独立に確かめる）。 */
export async function upstreamCalls(fixture: Listening): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.baseUrl}/calls`);
  return (await response.json()) as Record<string, unknown>;
}
