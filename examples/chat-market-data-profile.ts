/**
 * 既存 chat 向けの**呼び出し可能なプロファイル統合例**（T4）。
 *
 * 想定する consumer は既存 chat の `ChatExecutionFactory` 実装者（別オーナー）で、その内部型に
 * ここでは依存しない。本ファイルは「quote → **人間の明示承認** → 実行 → status / 再オープン」の
 * 一連を、型付き薄いクライアント越しに呼べる形で見せるだけのもので、**UI を作らない**。
 *
 * 守っていること:
 * - 承認は人間の判断（注入された `requestApproval`）だけが与える。**自動承認をしない。**
 * - credential は**承認後に**注入された `provideCredential` が返す既存値だけを使う。署名も生成もしない。
 * - `unknown` は `unknown` のまま返し、自動再実行・自動再 quote・`requestId` の作り直しをしない。
 * - Router の snapshot エンベロープ（`providerId/market/dataSource/payment/fetchedAt/data`）を
 *   そのまま渡す。**article 型へ cast せず、擬似 article も合成しない。**
 *
 * 未検証: 実 chat UI 上での因果（B-03 / U-07）、実決済・実 Provider API・finality。本例の実行証拠は
 * リポジトリ内の合成 fixture（`T4-fixture-nopay`）に限られる。
 */

import { createRouterClient } from "../src/client/index.js";
import type {
  ApprovalDecision,
  ExecutionResult,
  QuoteView,
  RouterClient,
  RouterClientOptions,
  StatusResult,
} from "../src/client/types.js";

/** 人間に承認を求める（chat 側の実装が UI や承認フローを持つ）。 */
export type RequestApproval = (context: {
  readonly quote: QuoteView;
  /** 表示用に安全な要約（秘密・上流 URL を含まない）。 */
  readonly summary: ApprovalSummary;
}) => Promise<ApprovalDecision>;

/** 承認後に既存の支払い資格情報を渡す（この例は作らない・署名しない）。 */
export type ProvideCredential = (context: {
  readonly quote: QuoteView;
  readonly approval: { readonly approved: true; readonly quoteId: string };
}) => Promise<string>;

/** 承認画面に出して安全な値だけ（トークン・上流 URL は含めない）。 */
export interface ApprovalSummary {
  readonly routeId: string;
  readonly quoteId: string;
  readonly paymentId: string;
  readonly resourceUrl: string;
  readonly source: { readonly amount: string; readonly asset: string; readonly network: string };
  readonly destination: {
    readonly quoted: string;
    readonly asset: string;
    readonly network: string;
  };
  readonly approvalDeadlineMs: number;
}

/**
 * 複製してから凍結する。注入された `RouterClient` が凍結を保証するとは限らないので、
 * **この例の側でも**防御する（`readonly` は型だけの保護で実行時には効かない）。
 */
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value) as unknown;
  const freeze = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Object.isFrozen(node)) {
      return;
    }
    Object.freeze(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      freeze(child);
    }
  };
  freeze(copy);
  return copy as T;
}

export function summaryOf(quote: QuoteView): ApprovalSummary {
  return {
    routeId: quote.routeId,
    quoteId: quote.quoteId,
    paymentId: quote.paymentId,
    resourceUrl: quote.resource.url,
    source: {
      amount: quote.source.amount,
      asset: quote.source.asset,
      network: quote.source.network,
    },
    destination: {
      quoted: quote.destination.quoted,
      asset: quote.destination.asset,
      network: quote.destination.network,
    },
    approvalDeadlineMs: quote.approval.deadlineMs,
  };
}

export interface MarketDataProfileOptions {
  readonly client?: RouterClient;
  readonly router?: RouterClientOptions;
  readonly requestApproval: RequestApproval;
  readonly provideCredential: ProvideCredential;
}

/** 1 回の購入試行の結果。chat 側はこの形のまま保存・再表示できる。 */
export type ProfileRun =
  | { readonly step: "quote_failed"; readonly error: string; readonly status: number }
  | {
      readonly step: "declined";
      readonly quote: QuoteView;
      readonly reason: string;
    }
  | {
      readonly step: "executed";
      readonly quote: QuoteView;
      readonly result: ExecutionResult;
    };

/** 承認前の quote 取得だけが終わった状態。 */
export interface ProfileQuoted {
  readonly step: "quoted";
  readonly quote: QuoteView;
}

export interface MarketDataProfile {
  /** quote だけを取る（承認前。まだ何も支払わない）。 */
  quote(input: { routeId: string; requestId: string }): Promise<ProfileRun | ProfileQuoted>;
  /** quote → 人間の承認 → （承認されたときだけ）実行。 */
  run(input: { routeId: string; requestId: string }): Promise<ProfileRun>;
  /** 保存した `paymentId` から状態と結果を読み直す（再オープン）。 */
  reopen(paymentId: string): Promise<StatusResult>;
}

export function createMarketDataProfile(options: MarketDataProfileOptions): MarketDataProfile {
  const client =
    options.client ??
    createRouterClient(
      options.router ??
        (() => {
          throw new Error("market data profile needs either `client` or `router` options");
        })(),
    );

  return {
    async quote(input) {
      const quoted = await client.quote(input);
      if (!quoted.ok) {
        return { step: "quote_failed", error: quoted.error, status: quoted.status };
      }
      return { step: "quoted", quote: quoted.quote };
    },

    async run(input): Promise<ProfileRun> {
      // **最初の await より前に**入力を固定する（呼び出し側が後から書き換えても影響しない）。
      const routeId = input.routeId;
      const requestId = input.requestId;

      const quoted = await client.quote({ routeId, requestId });
      if (!quoted.ok) {
        return { step: "quote_failed", error: quoted.error, status: quoted.status };
      }
      // 取得した quote が唯一の承認対象。注入 client が凍結していなくても壊れないよう、
      // **この例の側で複製して凍結**し、以降はこの値だけを使う（callback の戻り値で置き換えない）。
      const quote = frozenCopy(quoted.quote);
      const boundQuoteId = quote.quoteId;

      // 人間の判断を待つ。ここで自動承認しない。callback へ渡すのも凍結した複製。
      const decision = await options.requestApproval({
        quote,
        summary: frozenCopy(summaryOf(quote)),
      });
      // 承認判断は**この時点の値**を控える（callback が後から object を書き換えても動かない）。
      const approved = decision.approved === true;
      const approvedQuoteId = decision.approved === true ? decision.quoteId : undefined;
      const declinedReason = decision.approved === true ? undefined : decision.reason;
      if (!approved) {
        return { step: "declined", quote, reason: declinedReason ?? "human_declined" };
      }
      // **credential を取りに行く前に**承認対象の一致を確かめる。`quoteId` だけでなく
      // quote 自身の `approval.boundTo` も見る。不一致なら credential callback も R3 も呼ばない。
      if (approvedQuoteId !== boundQuoteId || quote.approval.boundTo !== boundQuoteId) {
        return {
          step: "executed",
          quote,
          result: {
            outcome: "approval_mismatch",
            reason: "approval_bound_to_other_quote",
            paymentId: quote.paymentId,
          },
        };
      }

      // 承認後にだけ、既存の資格情報を受け取る（この例は生成も署名もしない）。
      const credential = await options.provideCredential({
        quote,
        approval: { approved: true, quoteId: boundQuoteId },
      });

      // 1 回だけ実行する。`unknown` でも再実行・再 quote・requestId 再生成をしない。
      // 承認値も控えた `quoteId` から組み直す（callback が返した object をそのまま渡さない）。
      const result = await client.execute({
        quote,
        requestId,
        approval: { approved: true, quoteId: boundQuoteId },
        credential,
      });
      return { step: "executed", quote, result };
    },

    reopen(paymentId) {
      return client.status(paymentId);
    },
  };
}

/**
 * chat 側が保存すべき最小の対応関係。`unknown`（送金有無不明）でも `paymentId` を保持し、
 * 後から `reopen()` で突き合わせられるようにする。**自動解決はしない。**
 */
export function reconciliationRecordOf(run: ProfileRun): {
  readonly routeId?: string;
  readonly paymentId?: string;
  readonly outcome: string;
} {
  if (run.step === "executed") {
    return {
      routeId: run.quote.routeId,
      ...(run.result.paymentId === undefined ? {} : { paymentId: run.result.paymentId }),
      outcome: run.result.outcome,
    };
  }
  if (run.step === "declined") {
    return { routeId: run.quote.routeId, paymentId: run.quote.paymentId, outcome: "declined" };
  }
  return { outcome: run.step };
}
