/**
 * wire テスト用の足場。**テスト基盤であり製品コードではない。**
 * 合成 fixture 2 本（facilitator / 上流）と実 CLI（`src/main.ts`）を別プロセスで起動し、
 * テストプロセス自身は HTTP クライアントとして実 TCP 越しに Router を叩く。
 * 鍵・署名・送金・有料 API はなく、すべて 127.0.0.1 の使い捨てポート。
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

import { startListening, type Listening } from "./loopback.js";

export const ROUTE_A = "md-a-eth-snapshot";
export const ROUTE_B = "md-b-eth-snapshot";

export const SOURCE_TOKEN = "0x0000000000000000000000000000000000005ce7";
export const SOURCE_CHAIN_ID = "11155111";
export const SOURCE_NETWORK = `eip155:${SOURCE_CHAIN_ID}`;
export const DEST_NETWORK = "eip155:84532";
export const DEST_ASSET = "0x000000000000000000000000000000000000de57";
export const DEST_PAY_TO = "0x0000000000000000000000000000000000000a11";

export const ALICE = { id: "alice", token: "tok-alice-synthetic" };
export const BOB = { id: "bob", token: "tok-bob-synthetic" };

export const CANONICAL_BASE_URL = "http://127.0.0.1:8500";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

function routeConfig(routeId: string): unknown {
  return {
    routeId,
    canonicalPath: `/v1/routes/${routeId}/resource`,
    rail: "x402",
    source: { amount: "1500", asset: SOURCE_TOKEN, decimals: 6, network: SOURCE_NETWORK },
    destination: {
      scheme: "exact",
      network: DEST_NETWORK,
      asset: DEST_ASSET,
      payTo: DEST_PAY_TO,
    },
  };
}

export interface Harness {
  readonly workDir: string;
  readonly journalPath: string;
  readonly configPath: string;
  readonly facilitator: Listening;
  readonly upstreamA: Listening;
  readonly upstreamB: Listening;
  router: Listening;
  /**
   * 応答前バリアの合図ファイル（`crashBarrier` 指定時のみ Router が書く）。
   * 自分の workDir 配下にあり、他プロセスと共有しない。
   */
  readonly barrierPath: string;
  /** Router の子に渡した env（同じ構成で別の入口の script を起動する試験が使う）。 */
  readonly routerEnv: Readonly<Record<string, string>>;
  /** Router だけを止めて、同じ journal で起動し直す（再起動後の耐久性確認）。 */
  restartRouter(): Promise<void>;
  /**
   * 所有している Router の子プロセス**だけ**を SIGKILL する（graceful shutdown ではない）。
   * 再起動は `restartRouter()` が担い、常にバリア無しの構成で起動する。
   */
  killRouter(): Promise<void>;
  stopAll(): Promise<void>;
}

export interface HarnessOptions {
  /** 上流 A の支払い応答モード。 */
  readonly pay?: string;
  /** 上流 A が提示を変えるまでの challenge 回数。 */
  readonly changeAfter?: string;
  /** 上流 A が変えるトップレベルフィールド。 */
  readonly changeField?: string;
  /** facilitator の settle 応答モード。 */
  readonly settle?: string;
  /** facilitator の verify 応答モード。 */
  readonly verify?: string;
  /** Router に渡す追加 env（既定の上書き確認に使う）。 */
  readonly env?: Readonly<Record<string, string>>;
  /** facilitator の settle の応答の遅れ（ms。タスク R-0 の drain の試験）。 */
  readonly settleDelayMs?: number;
  /**
   * 最初の Router だけを、R3 の応答バイトを出す直前で止まる構成で起動する
   * （`synthetic` セクションにのみ書ける合成専用の試験用シーム）。
   */
  readonly crashBarrier?: boolean;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  await mkdir(runtimeRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(runtimeRoot, "t1b-wire-"));
  const journalPath = path.join(workDir, "journal.ndjson");
  const configPath = path.join(workDir, "router.config.json");

  const facilitator = await startListening("tests/fixtures/facilitator-server.ts", [
    "--token",
    SOURCE_TOKEN,
    "--chain-id",
    SOURCE_CHAIN_ID,
    "--settle",
    options.settle ?? "ok",
    "--verify",
    options.verify ?? "ok",
    "--settle-delay-ms",
    String(options.settleDelayMs ?? 0),
  ]);
  const upstreamA = await startListening("tests/fixtures/upstream-server.ts", [
    "--pay",
    options.pay ?? "ok",
    "--change-after",
    options.changeAfter ?? "0",
    "--change-field",
    options.changeField ?? "amount",
  ]);
  const upstreamB = await startListening("tests/fixtures/upstream-server.ts", ["--pay", "ok"]);

  const barrierPath = path.join(workDir, "crash-barrier.json");
  const barrierConfigPath = path.join(workDir, "router.barrier.config.json");
  const document = {
        router: {
          approvalTtlMs: 60_000,
          routes: { [ROUTE_A]: routeConfig(ROUTE_A), [ROUTE_B]: routeConfig(ROUTE_B) },
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
  // 再起動時に使う通常構成（バリア無し）。
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
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: CANONICAL_BASE_URL,
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token},${BOB.id}:${BOB.token}`,
    // 合成レールは**明示指定でのみ**選択される（既定では選ばれない）。
    ROUTER_ADAPTER_MODE: "synthetic",
    ...options.env,
  };

  // 最初の 1 本だけバリア構成で起動し、再起動は常に通常構成に戻す。
  // Router が起動できなかった場合、先に起動した fixture を残さない。
  let router: Listening;
  try {
    router = await startListening(
      "src/main.ts",
      [],
      options.crashBarrier === true
        ? { ...routerEnv, ROUTER_CONFIG_PATH: barrierConfigPath }
        : routerEnv,
    );
  } catch (error) {
    await Promise.all([facilitator.stop(), upstreamA.stop(), upstreamB.stop()]);
    throw error;
  }

  const harness: Harness = {
    workDir,
    journalPath,
    configPath,
    barrierPath,
    routerEnv,
    facilitator,
    upstreamA,
    upstreamB,
    router,
    async restartRouter(): Promise<void> {
      await harness.router.stop();
      harness.router = await startListening("src/main.ts", [], routerEnv);
    },
    async killRouter(): Promise<void> {
      await harness.router.kill("SIGKILL");
    },
    async stopAll(): Promise<void> {
      await harness.router.stop();
      await Promise.all([facilitator.stop(), upstreamA.stop(), upstreamB.stop()]);
    },
  };
  return harness;
}

export function principalHeaders(principal: { id: string; token: string }): Record<string, string> {
  return { "x-router-principal": principal.id, authorization: `Bearer ${principal.token}` };
}

/** payer → Router の支払い資格情報（設計 §4.1）を wire ヘッダに載せる形にする。 */
export function paymentHeader(offer: unknown, overrides: Record<string, unknown> = {}): string {
  const credential = {
    x402Version: 2,
    accepted: offer,
    payload: {
      challengeNonce: (offer as { extra: { challengeNonce: string } }).extra.challengeNonce,
      synthetic: true,
    },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
}

export interface QuoteResponse {
  readonly quoteId: string;
  readonly paymentId: string;
  readonly routeId: string;
  readonly resource: { readonly url: string; readonly method: string };
  readonly source: { readonly offer: unknown; readonly amount: string; readonly asset: string };
  readonly destination: Record<string, unknown>;
  readonly approval: { readonly boundTo: string; readonly deadlineMs: number };
}

export async function requestQuote(
  harness: Harness,
  principal: { id: string; token: string },
  body: { routeId: string; requestId: string },
): Promise<{ status: number; body: QuoteResponse & Record<string, unknown> }> {
  const response = await fetch(`${harness.router.baseUrl}/v1/quotes`, {
    method: "POST",
    headers: { ...principalHeaders(principal), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as QuoteResponse & Record<string, unknown> };
}

/**
 * リクエストラインをそのまま送る GET（`fetch` は dot segment などを正規化してしまうため）。
 * canonical path の別名で購入口が選べないことを確かめるのに使う。
 */
export function rawGet(
  harness: Harness,
  rawPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: harness.router.port, method: "GET", path: rawPath, headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export async function callsOf(fixture: Listening): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.baseUrl}/calls`);
  return (await response.json()) as Record<string, unknown>;
}
