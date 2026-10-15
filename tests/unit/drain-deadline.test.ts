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
 * 確かめた部分（import した期限 × 計測・source の回数）と推定の部分（外の SDK の中の RPC の回数）を分けて足し、分けて検査する（下の `Leg`）。
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
import { DRAIN_MODEL } from "../fixtures/drain-model.js";

/** 余裕（設計 §14.3）。 */
const MARGIN_MS = 30_000;
/**
 * 回数の 2 種類（Codex R-0 #3）:
 * - **確かめた回数**: core の中の回数は `tests/unit/dynamic-core.test.ts` が実際の core で数えて固定する（`DRAIN_MODEL`）。adapter の中の回数
 *   （ATA の存在 1・blockhash 1・受領 1 など）は adapter の source の順の呼び出し（繰り返しは候補の数 `offers` だけ）で、期限は import した定数。
 * - **推定の回数（`_ESTIMATE`）**: 外の SDK（mppx）の中の RPC の回数。全体の予算が無く、こちらで数を強制も計測もしていない。値は SDK の source を読んだ見積り。
 */
const { rereadsPerPurchase: REREADS, estimatesPerPurchase: ESTIMATES } = DRAIN_MODEL;
/** 推定: Tempo の受信（push）の verify（`validateCredential`）と settle（`broadcastCredential` → receipt）の RPC の回数。各 2 回まで（SDK の source では receipt の 1 回）。 */
const TEMPO_INBOUND_RPC_CALLS_PER_STEP_ESTIMATE = 2;
/** 推定: Tempo の静的 MPP 送信の mppx の credential 作成（fee token の解決・nonce・fee・gas・送出）の RPC の回数。 */
const TEMPO_PUSH_RPC_CALLS_ESTIMATE = 8;
/** 本番の Tempo の能力（`tools/real-mpp-capability.ts`）は viem の `http(rpcUrl, { retryCount: 0 })`: 1 要求の期限は viem の既定（source から読む。確かめた値）。 */
const VIEM_HTTP_TIMEOUT_MS = http("http://127.0.0.1:1", { retryCount: 0 })({}).config.timeout as number;

const testnetDeadlines = [...EVM_TESTNET_NETWORKS].map((network) => evmTestnetDeadlinesOf(network)!);
const svm = svmDeadlinesOf({});

/** 1 つのレグの最長: 確かめた部分（`proven`）と推定の部分（`estimated`）を分けて持つ。 */
interface Leg {
  readonly proven: number;
  readonly estimated: number;
}
const proven = (ms: number): Leg => ({ proven: ms, estimated: 0 });

/** 受信のレグ（verify ＋ settle ＋ 追跡）の最長。 */
const INBOUND: Readonly<Record<string, Leg>> = {
  // kind `x402`（Base Sepolia ほか）: verify・settle とも `timeoutMs`。
  "x402 (kind x402)": proven(2 * X402_INBOUND_DEFAULT_TIMEOUT_MS),
  // EVM testnet 4 つ: facilitator の期限はチェーン別（遅いチェーンを含む）。
  "x402 (EVM testnets)": proven(Math.max(...testnetDeadlines.map((d) => 2 * d.inboundFacilitatorMs))),
  // kind `circle`: verify は `timeoutMs`、settle は wire の `maxTimeoutSeconds` ＋ 10 秒。
  "x402 (circle)": proven(X402_INBOUND_DEFAULT_TIMEOUT_MS + (CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS + 10) * 1000),
  // Solana の x402: verify、settle（wire ＋ 10 秒）、settle の後の追跡。
  "x402 (SVM)": proven(svm.verifyMs + svm.settleMs + SVM_SETTLE_FOLLOW_UP_DEFAULTS.totalMs),
  // Tempo の MPP: RPC の 1 要求の期限（guarded transport の既定。確かめた値）× 推定の回数、verify と settle。
  "mpp (Tempo)": { proven: 0, estimated: 2 * TEMPO_INBOUND_RPC_CALLS_PER_STEP_ESTIMATE * GUARDED_RPC_DEFAULT_TIMEOUT_MS },
  // Solana の MPP: verify（`signature` 型の getTransaction 1 回）、settle（送出・追跡・回復を含む全体の期限）。
  "mpp (Solana)": proven(MPP_SOLANA_RPC_TIMEOUT_MS + MPP_SOLANA_SETTLE_DEADLINE_MS),
  // SubEtha の受信: verify・settle とも `timeoutMs`。
  subetha: proven(2 * SUBETHA_INBOUND_DEFAULT_TIMEOUT_MS),
};

/**
 * 送信のレグ（読み直し ＋ 残高・見積り ＋ `pay`）の最長。`offers` は上流の challenge の候補の数
 * （Solana の送信の読み直しは候補ごとに ATA の RPC を 1 回読む。静的は 0 回だが、ここでは 1 件分を数える = 保守的な側）。
 */
function outbound(offers: number): Readonly<Record<string, Leg>> {
  return {
    // EVM の x402、静的: 有料要求は testnet ではチェーン別（遅いチェーンを含む）。
    "x402 EVM (static)": proven(REREADS * X402_STATIC_CHALLENGE_TIMEOUT_MS + X402_STATIC_CHALLENGE_TIMEOUT_MS + Math.max(X402_STATIC_PAID_TIMEOUT_MS, ...testnetDeadlines.map((d) => d.outboundPaidMs))),
    "x402 EVM (dynamic)": proven(REREADS * X402_DYNAMIC_UNPAID_TIMEOUT_MS + X402_DYNAMIC_UNPAID_TIMEOUT_MS + X402_DYNAMIC_PAID_TIMEOUT_MS),
    // Solana の x402: 残高 1、読み直し（未払い ＋ 候補ごとの ATA）、pay（未払い ＋ ATA の存在 1 ＋ blockhash 1 ＋ 有料）。
    "x402 SVM": proven(SVM_OUTBOUND_RPC_TIMEOUT_MS + REREADS * (SVM_OUTBOUND_UNPAID_TIMEOUT_MS + offers * SVM_OUTBOUND_RPC_TIMEOUT_MS) + SVM_OUTBOUND_UNPAID_TIMEOUT_MS + 2 * SVM_OUTBOUND_RPC_TIMEOUT_MS + SVM_OUTBOUND_PAID_TIMEOUT_MS),
    // Solana の MPP: 残高 1、読み直し、pay（未払い ＋ ATA の存在 1 ＋ blockhash 1 ＋ 有料 ＋ 受領の getTransaction 1）。
    "mpp Solana": proven(SVM_OUTBOUND_RPC_TIMEOUT_MS + REREADS * (MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS + offers * SVM_OUTBOUND_RPC_TIMEOUT_MS) + MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS + 3 * SVM_OUTBOUND_RPC_TIMEOUT_MS + MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS),
    // Tempo の MPP、静的: 読み直し、pay（challenge ＋ 有料）は確かめた値。credential 作成の RPC は推定の回数。
    "mpp Tempo (static)": { proven: REREADS * MPP_OUTBOUND_TIMEOUT_MS + MPP_OUTBOUND_TIMEOUT_MS + MPP_OUTBOUND_TIMEOUT_MS, estimated: TEMPO_PUSH_RPC_CALLS_ESTIMATE * VIEM_HTTP_TIMEOUT_MS },
    // Tempo の MPP、動的: 読み直し、見積り（予算 ＋ 最後の 1 要求 ＋ 猶予 1 秒）、pay（未払い ＋ client の取得 ＋ RPC の予算 ＋ 最後の 1 要求 ＋ 有料）。全部 adapter の予算（確かめた値）。
    "mpp Tempo (dynamic)": proven(
      REREADS * MPP_DYNAMIC_DEFAULTS.unpaidTimeoutMs +
        ESTIMATES * (MPP_DYNAMIC_DEFAULTS.estimateRpcBudgetMs + MPP_DYNAMIC_DEFAULTS.estimateRpcTimeoutMs + 1_000) +
        MPP_DYNAMIC_DEFAULTS.unpaidTimeoutMs + MPP_DYNAMIC_DEFAULTS.rpcTimeoutMs + MPP_DYNAMIC_DEFAULTS.rpcBudgetMs + MPP_DYNAMIC_DEFAULTS.rpcTimeoutMs + 1_000 + MPP_DYNAMIC_DEFAULTS.paidTimeoutMs,
    ),
  };
}

interface Path {
  readonly path: string;
  /** 確かめた部分 ＋ 余裕。 */
  readonly proven: number;
  readonly estimated: number;
  /** 合計（確かめた ＋ 推定 ＋ 余裕）。 */
  readonly ms: number;
}

/** すべての (受信, 送信) の組の和 ＋ 余裕（実在しない組も足す = 保守的な側）。 */
function paths(offers: number): Path[] {
  const out = outbound(offers);
  return Object.entries(INBOUND).flatMap(([inName, i]) =>
    Object.entries(out).map(([outName, o]) => {
      const p = i.proven + o.proven + MARGIN_MS;
      const e = i.estimated + o.estimated;
      return { path: `${inName} → ${outName}`, proven: p, estimated: e, ms: p + e };
    }),
  );
}

function longest(offers: number): Path {
  return paths(offers).reduce((a, b) => (b.ms > a.ms ? b : a));
}

describe("DRAIN_TIMEOUT_MS は期限の定数から導いた 1 件の購入の最長より長い（設計 §15.2）", () => {
  test("確かめた部分だけで: どの経路（上流の候補 1 件）の最長 ＋ 余裕 30 秒よりも長い。最長の経路は推定を含まない", () => {
    // 診断: 最長の経路と値（増えたときに何が増えたかが分かる）。
    console.info(`drain-deadline: longest path ${JSON.stringify(longest(1))}, DRAIN_TIMEOUT_MS ${DRAIN_TIMEOUT_MS}`);
    for (const { path, proven: p } of paths(1)) expect(DRAIN_TIMEOUT_MS, path).toBeGreaterThanOrEqual(p);
    expect(longest(1).estimated).toBe(0);
  });

  test("推定を含めても（推定の回数が正しいとして）: どの経路の合計よりも長い。推定を含む経路は Tempo の 2 つのレグだけ", () => {
    for (const { path, ms } of paths(1)) expect(DRAIN_TIMEOUT_MS, path).toBeGreaterThanOrEqual(ms);
    const legs = { ...INBOUND, ...outbound(1) };
    expect(Object.entries(legs).filter(([, leg]) => leg.estimated > 0).map(([name]) => name).sort()).toEqual(["mpp (Tempo)", "mpp Tempo (static)"]);
    for (const p of paths(1)) if (p.estimated > 0) expect(p.path).toMatch(/mpp \(Tempo\)|mpp Tempo \(static\)/);
    // 推定が外れたときの余地（診断）: Tempo の静的送信の RPC が何回までなら上限に収まるか。
    const tempoStatic = paths(1).filter((p) => p.path.endsWith("→ mpp Tempo (static)")).reduce((a, b) => (b.ms > a.ms ? b : a));
    const tolerated = Math.floor((DRAIN_TIMEOUT_MS - tempoStatic.proven - (tempoStatic.estimated - TEMPO_PUSH_RPC_CALLS_ESTIMATE * VIEM_HTTP_TIMEOUT_MS)) / VIEM_HTTP_TIMEOUT_MS);
    console.info(`drain-deadline: Tempo static outbound tolerates up to ${tolerated} SDK RPC calls (estimate ${TEMPO_PUSH_RPC_CALLS_ESTIMATE})`);
    expect(tolerated).toBeGreaterThanOrEqual(TEMPO_PUSH_RPC_CALLS_ESTIMATE);
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
   * **受け入れた限界（R-0、coordinator の判断。Codex R-0 #3 で言い直し）**: 動的の Solana 送信は、上流が challenge に同じ network・asset の候補を
   * 上限（`DYNAMIC_RESPONSE_LIMITS.maxOffers`）まで並べると、読み直しのたびに候補ごとに ATA の RPC（各 10 秒）を順に読む。そのときの最長（約 565 秒）は
   * `DRAIN_TIMEOUT_MS`（300 秒）を超える。上限は 300 秒のまま、時間切れは失敗: 入口は `drain: timeout <id>` を出し、`deploy/swap-image.sh` は入れ替えをやめて
   * 古いコンテナを戻す。ただし期限の時点で Router の子は殺される（または進行中の仕事を残して終わる）ので、**その購入の settle・宛先への支払いは途中で切られ得る**。
   * 戻した古いコンテナもその購入を続けられない: 再起動の後、core はその購入を journal の `unknown`（`interrupted_at_restart`）／`paid_undelivered` に確定し、
   * **再送・再 settle はしない**（`tests/wire/router-drain.test.ts` の時間切れの試験が確かめる）。したがって結果は「deploy が断られ、その購入は durable な不明」で、
   * 二重の支払いにはならない。この試験は超過を固定する（読み直しの RPC に全体の予算を置くなどで超過が無くなれば落ちるので、そのとき消す）。
   */
  test("受け入れた限界: 上流の候補が上限の数のとき、動的の Solana 送信の経路は上限を超える（deploy は断られ、進行中の購入は切られ得るが durable な不明で終わる）", () => {
    const worst = longest(DYNAMIC_RESPONSE_LIMITS.maxOffers);
    expect(worst.path).toMatch(/→ mpp Solana$/);
    expect(worst.ms).toBeGreaterThan(DRAIN_TIMEOUT_MS);
  });
});
