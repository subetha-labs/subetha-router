/**
 * 入口の drain の上限 `DRAIN_TIMEOUT_MS`（`tools/remote-mcp.ts`）を、期限の定数から導いた 1 件の購入の最長で固定する
 * （`docs/rejection-reasons-design.md` §14.3・§15.2、タスク R-0）。**手で合計を書かない**: 定数は source から import し、試験が経路ごとに足す。
 * 定数が増えて最長が上限を超えたら、この試験が落ちる。
 *
 * 1 件の購入の段（`src/core/orchestrator.ts`・`src/core/dynamic.ts`）:
 * - 宛先の challenge の読み直し（`readChallenge`）は 2 回: settle の前（静的 :601 / 動的 `readOffers`）と送信の前（`deliver`）。
 *   ほかに送信の adapter の `pay` の中で 1 回読む（未払いの読取）
 * - 残高の事前確認（Solana の送信だけが `balanceOf` を持つ: RPC 1 回）
 * - 動的の手数料の見積り（`estimateFee` を持つのは Tempo の MPP の動的経路だけ）
 * - 受信の verify と settle（＋ SVM の追跡）
 * - 送信の `pay`（署名のための RPC、有料要求、受領の確認）
 *
 * 数（読み直しの回数・RPC の回数）は構造の事実で、期限の値ではない。Tempo の静的 MPP 送信の credential 作成だけは SDK（mppx）の中の RPC の回数に
 * 全体の予算が無いので、回数を仮定する（`TEMPO_PUSH_RPC_CALLS_ASSUMED`）。
 */
import { http } from "viem";
import { describe, expect, test } from "vitest";

import { MPP_SOLANA_RPC_TIMEOUT_MS, MPP_SOLANA_SETTLE_DEADLINE_MS } from "../../src/adapters/inbound/mpp-solana.js";
import { SUBETHA_INBOUND_DEFAULT_TIMEOUT_MS } from "../../src/adapters/inbound/subetha.js";
import { CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS, X402_INBOUND_DEFAULT_TIMEOUT_MS } from "../../src/adapters/inbound/x402.js";
import { SVM_SETTLE_FOLLOW_UP_DEFAULTS, svmDeadlinesOf } from "../../src/adapters/inbound/x402-svm.js";
import { MPP_DYNAMIC_DEFAULTS } from "../../src/adapters/outbound/mpp-dynamic.js";
import { MPP_OUTBOUND_TIMEOUT_MS } from "../../src/adapters/outbound/mpp.js";
import { MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS, MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS } from "../../src/adapters/outbound/mpp-solana.js";
import { X402_STATIC_CHALLENGE_TIMEOUT_MS, X402_STATIC_PAID_TIMEOUT_MS } from "../../src/adapters/outbound/x402.js";
import { X402_DYNAMIC_PAID_TIMEOUT_MS, X402_DYNAMIC_UNPAID_TIMEOUT_MS } from "../../src/adapters/outbound/x402-dynamic.js";
import { SVM_OUTBOUND_PAID_TIMEOUT_MS, SVM_OUTBOUND_RPC_TIMEOUT_MS, SVM_OUTBOUND_UNPAID_TIMEOUT_MS } from "../../src/adapters/outbound/x402-svm.js";
import { DEFAULT_EXECUTE_TIMEOUT_MS } from "../../src/client/index.js";
import { DEFAULT_MCP_INGRESS_LIMITS } from "../../src/mcp/ingress.js";
import { DEFAULT_TIMEOUT_MS as GUARDED_RPC_DEFAULT_TIMEOUT_MS } from "../../src/net/guarded-rpc.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import { EVM_TESTNET_NETWORKS, evmTestnetDeadlinesOf } from "../../src/shared/networks.js";
import { DRAIN_TIMEOUT_MS as SHARED_DRAIN_TIMEOUT_MS } from "../../src/shared/drain.js";
import { DRAIN_TIMEOUT_MS } from "../../tools/remote-mcp.js";

/** 余裕（設計 §14.3）。 */
const MARGIN_MS = 30_000;
/** 読み直し（`readChallenge`）の回数: settle の前と送信の前。 */
const REREADS = 2;
/** Tempo の受信（push）: verify（`validateCredential`）と settle（`broadcastCredential` → receipt）の RPC。各 2 回までと仮定（実際は receipt の 1 回）。 */
const TEMPO_INBOUND_RPC_CALLS_PER_STEP = 2;
/** Tempo の静的 MPP 送信: mppx の credential 作成（fee token の解決・nonce・fee・gas・送出）の RPC の回数の仮定。SDK に全体の予算が無い。 */
const TEMPO_PUSH_RPC_CALLS_ASSUMED = 8;
/** 本番の Tempo の能力（`tools/real-mpp-capability.ts`）は viem の `http(rpcUrl, { retryCount: 0 })`: 1 要求の期限は viem の既定（source から読む）。 */
const VIEM_HTTP_TIMEOUT_MS = http("http://127.0.0.1:1", { retryCount: 0 })({}).config.timeout as number;

const testnetDeadlines = [...EVM_TESTNET_NETWORKS].map((network) => evmTestnetDeadlinesOf(network)!);
const svm = svmDeadlinesOf({});

/** 受信のレグ（verify ＋ settle ＋ 追跡）の最長。 */
const INBOUND: Readonly<Record<string, number>> = {
  // kind `x402`（Base Sepolia ほか）: verify・settle とも `timeoutMs`。
  "x402 (kind x402)": 2 * X402_INBOUND_DEFAULT_TIMEOUT_MS,
  // EVM testnet 4 つ: facilitator の期限はチェーン別（遅いチェーンを含む）。
  "x402 (EVM testnets)": Math.max(...testnetDeadlines.map((d) => 2 * d.inboundFacilitatorMs)),
  // kind `circle`: verify は `timeoutMs`、settle は wire の `maxTimeoutSeconds` ＋ 10 秒。
  "x402 (circle)": X402_INBOUND_DEFAULT_TIMEOUT_MS + (CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS + 10) * 1000,
  // Solana の x402: verify、settle（wire ＋ 10 秒）、settle の後の追跡。
  "x402 (SVM)": svm.verifyMs + svm.settleMs + SVM_SETTLE_FOLLOW_UP_DEFAULTS.totalMs,
  // Tempo の MPP: RPC の 1 要求の期限（guarded transport の既定。合成は `rpcTimeoutMs` を渡さない）× 回数、verify と settle。
  "mpp (Tempo)": 2 * TEMPO_INBOUND_RPC_CALLS_PER_STEP * GUARDED_RPC_DEFAULT_TIMEOUT_MS,
  // Solana の MPP: verify（`signature` 型の getTransaction 1 回）、settle（送出・追跡・回復を含む全体の期限）。
  "mpp (Solana)": MPP_SOLANA_RPC_TIMEOUT_MS + MPP_SOLANA_SETTLE_DEADLINE_MS,
  // SubEtha の受信: verify・settle とも `timeoutMs`。
  subetha: 2 * SUBETHA_INBOUND_DEFAULT_TIMEOUT_MS,
};

/**
 * 送信のレグ（読み直し 2 回 ＋ 残高・見積り ＋ `pay`）の最長。`offers` は上流の challenge の候補の数
 * （Solana の送信の読み直しは候補ごとに ATA の RPC を 1 回読む。静的は 0 回だが、ここでは 1 件分を数える = 保守的な側）。
 */
function outbound(offers: number): Readonly<Record<string, number>> {
  return {
    // EVM の x402、静的: 有料要求は testnet ではチェーン別（遅いチェーンを含む）。
    "x402 EVM (static)": REREADS * X402_STATIC_CHALLENGE_TIMEOUT_MS + X402_STATIC_CHALLENGE_TIMEOUT_MS + Math.max(X402_STATIC_PAID_TIMEOUT_MS, ...testnetDeadlines.map((d) => d.outboundPaidMs)),
    "x402 EVM (dynamic)": REREADS * X402_DYNAMIC_UNPAID_TIMEOUT_MS + X402_DYNAMIC_UNPAID_TIMEOUT_MS + X402_DYNAMIC_PAID_TIMEOUT_MS,
    // Solana の x402: 残高 1、読み直し（未払い ＋ 候補ごとの ATA）、pay（未払い ＋ ATA の存在 1 ＋ blockhash 1 ＋ 有料）。
    "x402 SVM": SVM_OUTBOUND_RPC_TIMEOUT_MS + REREADS * (SVM_OUTBOUND_UNPAID_TIMEOUT_MS + offers * SVM_OUTBOUND_RPC_TIMEOUT_MS) + SVM_OUTBOUND_UNPAID_TIMEOUT_MS + 2 * SVM_OUTBOUND_RPC_TIMEOUT_MS + SVM_OUTBOUND_PAID_TIMEOUT_MS,
    // Solana の MPP: 残高 1、読み直し、pay（未払い ＋ ATA の存在 1 ＋ blockhash 1 ＋ 有料 ＋ 受領の getTransaction 1）。
    "mpp Solana": SVM_OUTBOUND_RPC_TIMEOUT_MS + REREADS * (MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS + offers * SVM_OUTBOUND_RPC_TIMEOUT_MS) + MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS + 3 * SVM_OUTBOUND_RPC_TIMEOUT_MS + MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS,
    // Tempo の MPP、静的: 読み直し、pay（challenge ＋ credential 作成の RPC ＋ 有料）。
    "mpp Tempo (static)": REREADS * MPP_OUTBOUND_TIMEOUT_MS + MPP_OUTBOUND_TIMEOUT_MS + TEMPO_PUSH_RPC_CALLS_ASSUMED * VIEM_HTTP_TIMEOUT_MS + MPP_OUTBOUND_TIMEOUT_MS,
    // Tempo の MPP、動的: 読み直し、見積り（予算 ＋ 最後の 1 要求の猶予 1 秒）、pay（未払い ＋ client の取得 ＋ RPC の予算 ＋ 最後の 1 要求 ＋ 有料）。
    "mpp Tempo (dynamic)":
      REREADS * MPP_DYNAMIC_DEFAULTS.unpaidTimeoutMs +
      MPP_DYNAMIC_DEFAULTS.estimateRpcBudgetMs + MPP_DYNAMIC_DEFAULTS.estimateRpcTimeoutMs + 1_000 +
      MPP_DYNAMIC_DEFAULTS.unpaidTimeoutMs + MPP_DYNAMIC_DEFAULTS.rpcTimeoutMs + MPP_DYNAMIC_DEFAULTS.rpcBudgetMs + MPP_DYNAMIC_DEFAULTS.rpcTimeoutMs + 1_000 + MPP_DYNAMIC_DEFAULTS.paidTimeoutMs,
  };
}

/** すべての (受信, 送信) の組の和 ＋ 余裕（実在しない組も足す = 保守的な側）。 */
function paths(offers: number): Array<{ path: string; ms: number }> {
  const out = outbound(offers);
  return Object.entries(INBOUND).flatMap(([inName, inMs]) => Object.entries(out).map(([outName, outMs]) => ({ path: `${inName} → ${outName}`, ms: inMs + outMs + MARGIN_MS })));
}

function longest(offers: number): { path: string; ms: number } {
  return paths(offers).reduce((a, b) => (b.ms > a.ms ? b : a));
}

describe("DRAIN_TIMEOUT_MS は期限の定数から導いた 1 件の購入の最長より長い（設計 §15.2）", () => {
  test("どの経路の最長（上流の候補 1 件）＋ 余裕 30 秒よりも長い", () => {
    // 診断: 最長の経路と値（増えたときに何が増えたかが分かる）。
    console.info(`drain-deadline: longest path ${JSON.stringify(longest(1))}, DRAIN_TIMEOUT_MS ${DRAIN_TIMEOUT_MS}`);
    for (const { path, ms } of paths(1)) expect(DRAIN_TIMEOUT_MS, path).toBeGreaterThanOrEqual(ms);
  });

  test("入口が数える MCP の要求の寿命（ingress の上限・client の期限）＋ 余裕よりも長い", () => {
    expect(DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_MCP_INGRESS_LIMITS.maxRequestMs + MARGIN_MS);
    expect(DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_EXECUTE_TIMEOUT_MS + MARGIN_MS);
  });

  test("入口と Router の子は同じ上限（`src/shared/drain.ts`）。Router の子は本番で上書きしない", async () => {
    expect(DRAIN_TIMEOUT_MS).toBe(SHARED_DRAIN_TIMEOUT_MS);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/main.ts", "utf8")).toContain("capabilities.drainTimeoutMsForTest ?? DRAIN_TIMEOUT_MS");
  });

  test("値は 300 秒から（設計 §15.2）。swap-image.sh の docker stop -t 315・外側の上限 345 秒・STOP_SETTLE_S 345 と揃っている", async () => {
    expect(DRAIN_TIMEOUT_MS).toBe(300_000);
    const { readFileSync } = await import("node:fs");
    const script = readFileSync("deploy/swap-image.sh", "utf8");
    const grace = DRAIN_TIMEOUT_MS / 1000 + 15;
    expect(script).toMatch(new RegExp(`^STOP_GRACE_S=${grace}\\b`, "m"));
    expect(script).toMatch(new RegExp(`^STOP_BOUND_S=${grace + 30}\\b`, "m"));
    expect(script).toMatch(new RegExp(`^STOP_SETTLE_S=${grace + 30}\\b`, "m"));
  });

  /**
   * **受け入れた可用性の限界（安全の問題ではない。R-0、coordinator の判断）**: 動的の Solana 送信は、上流が challenge に同じ network・asset の候補を
   * 上限（`DYNAMIC_RESPONSE_LIMITS.maxOffers`）まで並べると、読み直しのたびに候補ごとに ATA の RPC（各 10 秒）を順に読む。そのときの最長（約 565 秒）は
   * `DRAIN_TIMEOUT_MS`（300 秒）を超える。上限は 300 秒のまま、時間切れは失敗: 入口は `drain: timeout` を出し、`deploy/swap-image.sh` は入れ替えをやめて
   * 古いコンテナを戻す。したがって、そのような遅い購入が進行中の間は入れ替え（deploy）が断られ得る（可用性）が、進行中の購入を途中で切って入れ替えることは無い（安全）。
   * この試験は超過を固定する（読み直しの RPC に全体の予算を置くなどで超過が無くなれば落ちるので、そのとき消す）。
   */
  test("受け入れた可用性の限界: 上流の候補が上限の数のとき、動的の Solana 送信の経路は上限を超える（deploy が断られ得る。安全側）", () => {
    const worst = longest(DYNAMIC_RESPONSE_LIMITS.maxOffers);
    expect(worst.path).toMatch(/→ mpp Solana$/);
    expect(worst.ms).toBeGreaterThan(DRAIN_TIMEOUT_MS);
  });
});
