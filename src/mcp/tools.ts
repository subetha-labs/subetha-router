/**
 * R1–R4 を MCP tool に変換する層。**製品コードの支払い経路を作らない。**
 *
 * 既存の型付きクライアント（`src/client/*`、T4 実装・T5 で chat 実装と相互検証済み）の上に
 * 薄い変換だけを置く。承認束縛・canonical 比較・`unknown` 保持・ID 照合はすべてクライアント側の
 * 既存実装に委ねる（ここで判定し直さない）。
 *
 * 重要な前提:
 * - `execute()` は**その client インスタンスが発行した quote だけ**実行できる
 *   （`src/client/index.ts` の `issued` Map）。したがって `quoteId → QuoteView` を
 *   **このプロセス内で保持**する。MCP サーバを再起動すると `purchase` は失敗し、
 *   `status` だけが参照できる（この非対称性は tool 説明と README に書く）。
 * - `credential` は**合成モードでのみ**組む。実レールでは組まず、実決済が未解除である旨の
 *   固定エラーを返す（推測で署名しない）。
 */

import type { QuoteView, RouterClient } from "../client/types.js";

/** 合成レールかどうか。実レールでは credential を組まない。 */
export type AdapterMode = "synthetic" | "real";

/**
 * 実行証拠。**裸のラベルにしない**: 値の出所と検証済みかどうかを構造として必ず載せる
 * （運用者の自己申告を「Router が名乗った」と誤読させないため）。
 */
export interface Evidence {
  readonly label: string;
  readonly source: "router_listening_line" | "operator_asserted";
  readonly verified: boolean;
}

export interface ToolDeps {
  readonly client: RouterClient;
  readonly mode: AdapterMode;
  readonly evidence: Evidence;
}

/** tool 名は prefix 固定（審査員の環境では他の MCP サーバと同居する）。 */
export const TOOL_NAMES = {
  listRoutes: "subetha_router_list_routes",
  quote: "subetha_router_quote",
  purchase: "subetha_router_purchase",
  status: "subetha_router_status",
} as const;

/** 応答に必ず添える。合成であることを隠さない。 */
function withEvidence(deps: ToolDeps, body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, evidence: deps.evidence, adapterMode: deps.mode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 合成レール向けの資格情報。**テスト fixture が作っているものと同一形式**で、
 * 鍵も署名もない。`synthetic: true` を必ず残して合成であることを隠さない。
 * 実レールの署名経路はここには無い（作らない）。
 */
function syntheticCredential(offer: unknown): string {
  const extra = isRecord(offer) ? offer["extra"] : undefined;
  const challengeNonce = isRecord(extra) ? extra["challengeNonce"] : undefined;
  const credential = {
    x402Version: 2,
    accepted: offer,
    payload: { challengeNonce, synthetic: true },
  };
  return Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
}

/**
 * 人間が承認判断をするために必要な項目だけを取り出す。
 * **`decimals` は必須**: `amount` は base units なので、これが無いと
 * `10000` が 0.01 なのか 10000 なのか判断できない。
 */
function approvalSubject(quote: QuoteView): Record<string, unknown> {
  const source = quote.source as Record<string, unknown>;
  const destination = quote.destination as Record<string, unknown>;
  return {
    quoteId: quote.quoteId,
    paymentId: quote.paymentId,
    routeId: quote.routeId,
    resource: quote.resource,
    source: {
      amount: source["amount"],
      decimals: source["decimals"],
      asset: source["asset"],
      network: source["network"],
      expiresAt: source["expiresAt"],
    },
    destination: {
      quoted: destination["quoted"],
      asset: destination["asset"],
      network: destination["network"],
    },
    approval: quote.approval,
  };
}

export interface ToolHandlers {
  listRoutes(): Promise<Record<string, unknown>>;
  quote(input: { routeId: string; requestId: string }): Promise<Record<string, unknown>>;
  purchase(input: {
    quoteId: string;
    requestId: string;
    approval?: string | undefined;
  }): Promise<Record<string, unknown>>;
  status(input: { paymentId: string }): Promise<Record<string, unknown>>;
  /** テスト用: 発行済み quote の数（プロセス内保持の確認）。 */
  issuedCount(): number;
}

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  /** `quoteId → QuoteView`。`execute()` が QuoteView 全体を要求するため保持する。 */
  const issued = new Map<string, QuoteView>();

  return {
    async listRoutes(): Promise<Record<string, unknown>> {
      const result = await deps.client.listRoutes();
      return withEvidence(deps, { ok: result.ok, routes: result.routes });
    },

    async quote(input): Promise<Record<string, unknown>> {
      const result = await deps.client.quote({
        routeId: input.routeId,
        requestId: input.requestId,
      });
      if (!result.ok) {
        return withEvidence(deps, { ok: false, error: result.error });
      }
      issued.set(result.quote.quoteId, result.quote);
      return withEvidence(deps, {
        ok: true,
        approvalRequired: true,
        // エージェントが勝手に purchase へ進まないよう、次の手順を文面で明示する。
        nextStep:
          `人間の明示承認が必要です。承認する場合は ${TOOL_NAMES.purchase} を ` +
          `approval に この quoteId を渡して呼んでください。承認しない場合は呼ばないでください。`,
        subject: approvalSubject(result.quote),
      });
    },

    async purchase(input): Promise<Record<string, unknown>> {
      const quote = issued.get(input.quoteId);
      if (quote === undefined) {
        // MCP サーバを再起動すると発行元 client が消えるため必ずここに来る。
        return withEvidence(deps, {
          ok: false,
          error: "quote_not_issued_by_this_server",
          detail: `先に ${TOOL_NAMES.quote} を呼んでください（サーバ再起動後は再取得が必要です）。`,
        });
      }
      if (deps.mode !== "synthetic") {
        // 実レールでは資格情報を組まない。推測で署名しない。
        return withEvidence(deps, {
          ok: false,
          error: "real_settlement_not_authorized",
          detail:
            "実署名能力が未実装のため実決済は未解除です。合成レール（synthetic）でのみ実行できます。",
        });
      }
      const result = await deps.client.execute({
        quote,
        requestId: input.requestId,
        // 承認は MCP 層で判定し直さない。呼び出し側が渡した値をそのまま束縛に使い、
        // 未指定・不一致はクライアントと Router の既存拒否面に委ねる
        // （不一致なら Router が `approval_required` を返す）。
        approval: { approved: true, quoteId: input.approval ?? "" },
        credential: syntheticCredential((quote.source as Record<string, unknown>)["offer"]),
      });
      return withEvidence(deps, { ok: result.outcome === "delivered", ...result });
    },

    async status(input): Promise<Record<string, unknown>> {
      const result = await deps.client.status(input.paymentId);
      return withEvidence(deps, { ...result });
    },

    issuedCount(): number {
      return issued.size;
    },
  };
}
