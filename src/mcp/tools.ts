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

/**
 * 実レールで受信レグを払うための資格情報を作る能力。**製品コードは実装を持たない**
 * （鍵を扱うのは `tools/` 側で、起動時にコードから注入する）。
 * 注入されていない `real` モードでは purchase は fail closed になる。
 */
export interface InboundPayer {
  readonly address: string;
  credentialFor(offer: unknown, chainId: number): Promise<string>;
}

export interface ToolDeps {
  readonly client: RouterClient;
  readonly mode: AdapterMode;
  readonly evidence: Evidence;
  /** `real` モードで受信レグを払う能力（省略時は実決済しない）。 */
  readonly payer?: InboundPayer;
  /** 受信レグのチェーン ID（EIP-712 署名に必要）。`payer` と対で渡す。 */
  readonly inboundChainId?: number;
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
/**
 * この経路は **credential を作る時点で**資金が動くか。
 * MPP（`tempo/charge`）は payer 自身が broadcast するので真。
 * x402（`exact`）は署名するだけで、送金は facilitator が後段で行う。
 */
function fundsMoveBeforePurchase(quote: QuoteView): boolean {
  const source = quote.source as Record<string, unknown>;
  const offer = source["offer"];
  return isRecord(offer) && offer["scheme"] === "tempo/charge";
}

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
      /**
       * Router が**この呼び出し側に向けて発行した** offer。
       * リモート利用では呼び出し側がこれに**自分の鍵で署名**して `credential` を作る。
       * 秘密ではない（発行相手に返しているだけ）。EIP-712 domain もここに入る。
       */
      offer: source["offer"],
    },
    destination: {
      quoted: destination["quoted"],
      asset: destination["asset"],
      network: destination["network"],
    },
    approval: quote.approval,
    /**
     * **承認者に効く一行。** 文面だけだと読み飛ばされるので構造化して返す。
     * true なら「承認＝支払い」で、取り消せない。
     */
    fundsMoveOnCredential: fundsMoveBeforePurchase(quote),
  };
}

export interface ToolHandlers {
  listRoutes(): Promise<Record<string, unknown>>;
  quote(input: { routeId: string; requestId: string }): Promise<Record<string, unknown>>;
  purchase(input: {
    quoteId: string;
    requestId: string;
    approval?: string | undefined;
    /**
     * 呼び出し側が**自分の鍵で署名した** `X-Payment` 値（base64）。
     * リモート運用ではこちらを使う（Router は呼び出し側の鍵を持たない）。
     */
    credential?: string | undefined;
    /**
     * `quote` が返した quote 文書そのもの。**ステートレス運用で使う**。
     * 慣行どおり「支払いはセッションではなく呼び出しに紐づく」ので、
     * 呼び出し側が証拠を持ち回る。**束縛は緩まない**:
     * 発行していない `challengeNonce` は Router の strict preflight が拒否し、
     * `approval !== quoteId` は core が `approval_required` で拒否する。
     */
    quote?: unknown;
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
        /**
         * quote 文書そのもの。**ステートレス運用ではこれをそのまま `purchase` の
         * `quote` 引数に渡す**（支払いはセッションではなく呼び出しに紐づく）。
         */
        quote: result.quote,
        // エージェントが勝手に purchase へ進まないよう、次の手順を文面で明示する。
        /**
         * **レールで「いつ金が動くか」が違う**ので、それを文面に載せる。
         * x402 は署名しても資金は動かず、Router が決済する段で動く。
         * MPP は**呼び出し側が自分で broadcast する**ので、credential を作った時点で
         * 送金が完了していて、purchase が失敗しても戻らない。
         * これを言わないと「準備の工程」として承認され得る。
         */
        nextStep: fundsMoveBeforePurchase(result.quote)
          ? "Explicit human approval is required. **On this route (MPP) the transfer happens " +
            "when the credential is built, and it cannot be undone.** Funds leave before " +
            `${TOOL_NAMES.purchase} is called. Get approval first, then build the credential. ` +
            "If the human does not approve, do not build it."
          : "Explicit human approval is required. If the human approves, call " +
            `${TOOL_NAMES.purchase} with this quoteId as \`approval\`. If not, do not call it.`,
        subject: approvalSubject(result.quote),
      });
    },

    async purchase(input): Promise<Record<string, unknown>> {
      // ステートレス運用では呼び出し側が quote を持ち回る。
      // プロセス内の `issued` はローカル（stdio）運用の補助でしかない。
      const quote = (input.quote as QuoteView | undefined) ?? issued.get(input.quoteId);
      if (quote === undefined) {
        // MCP サーバを再起動すると発行元 client が消えるため必ずここに来る。
        return withEvidence(deps, {
          ok: false,
          error: "quote_required",
          detail:
            `Call ${TOOL_NAMES.quote} first and pass the quote it returns as the \`quote\` argument.`,
        });
      }
      const offer = (quote.source as Record<string, unknown>)["offer"];
      let credential: string;
      if (input.credential !== undefined && input.credential !== "") {
        // 呼び出し側が署名した資格情報。**この層は鍵を持たない**ので中身を作らない。
        // 不正なら Router の strict preflight と facilitator が拒否する。
        credential = input.credential;
      } else if (deps.mode === "synthetic") {
        credential = syntheticCredential(offer);
      } else if (deps.payer !== undefined && deps.inboundChainId !== undefined) {
        // 実レール: 注入された能力だけを使う。この層は鍵を持たない。
        try {
          credential = await deps.payer.credentialFor(offer, deps.inboundChainId);
        } catch {
          // 署名できない offer には推測で署名しない（固定の安全な失敗）。
          return withEvidence(deps, {
            ok: false,
            error: "inbound_credential_unavailable",
            detail: "Could not build the inbound credential. No payment was started.",
          });
        }
      } else {
        // 実レールで能力が注入されていない。偽の資格情報で代替しない。
        return withEvidence(deps, {
          ok: false,
          error: "inbound_payer_not_configured",
          detail:
            "No inbound payment capability is configured for a real rail. Use the synthetic " +
            "rail, or inject a payer.",
        });
      }
      const result = await deps.client.execute({
        quote,
        requestId: input.requestId,
        // 承認は MCP 層で判定し直さない。呼び出し側が渡した値をそのまま束縛に使い、
        // 未指定・不一致はクライアントと Router の既存拒否面に委ねる
        // （不一致なら Router が `approval_required` を返す）。
        approval: { approved: true, quoteId: input.approval ?? "" },
        credential,
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
