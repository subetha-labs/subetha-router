/**
 * 送信レール（x402 形）の **synthetic**（合成・無課金）adapter。
 *
 * **これは実 x402 SDK 配線ではない。** 鍵・ウォレット・署名・ブロードキャストは一切なく、
 * 送るのは `synthetic` と明示したラベル付きトークンで、受け取れるのはリポジトリ内の
 * loopback fixture だけ。公式 `@x402/fetch` / `@x402/evm` の実 API 確認と送金前ガードの
 * 実装は T2（設計 §4.2 / §10 M4）のゲートで、本 adapter はその主張をしない。
 *
 * 実装している不変条件: 上流 canonical は**クエリ無しの GET** 1 本、リダイレクトを追わない、
 * 自動支払いリトライをしない（1 要求 1 回）、承認済み `selectedOffer` だけを渡す。
 */

import { assertLoopbackUrl } from "../../config.js";
import type {
  DestinationOffer,
  OutboundRail,
  PayRequest,
  PayResult,
} from "../../ports/outbound.js";

export interface SyntheticX402Options {
  /** `routeId` → 上流 canonical URL（loopback の fixture に限る）。 */
  readonly upstreams: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 上流 offer を**丸ごと**保持する（必須フィールドの型だけを検査し、それ以外の
 * トップレベルフィールドを落とさない）。落とすと指紋と再照合の入力から消えてしまい、
 * `maxTimeoutSeconds` のような欄が変わっても検知できなくなる。
 */
function offerOf(value: unknown): DestinationOffer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { scheme, network, asset, amount, payTo } = value;
  if (
    typeof scheme !== "string" ||
    typeof network !== "string" ||
    typeof asset !== "string" ||
    typeof amount !== "string" ||
    typeof payTo !== "string"
  ) {
    return undefined;
  }
  // 検証済みの必須フィールドで上書きしつつ、未知のフィールドもそのまま残す。
  return { ...value, scheme, network, asset, amount, payTo };
}

export function createSyntheticX402Outbound(options: SyntheticX402Options): OutboundRail {
  const timeoutMs = options.timeoutMs ?? 5_000;
  // 接続先は起動時に固定する（要求ごとに URL を組み立てない）。
  const upstreams = new Map<string, string>();
  for (const [routeId, raw] of Object.entries(options.upstreams)) {
    const url = new URL(assertLoopbackUrl(raw, `synthetic.upstreams.${routeId}`));
    if (url.search !== "") {
      throw new Error(`synthetic.upstreams.${routeId} must not carry a query`);
    }
    upstreams.set(routeId, url.toString());
  }

  function urlFor(routeId: string): string {
    const url = upstreams.get(routeId);
    if (url === undefined) {
      throw new Error("no upstream configured for route");
    }
    return url;
  }

  return {
    /** 上流の現在の 402 challenge を読む（純粋読取・無課金）。 */
    async readChallenge(routeId: string): Promise<readonly DestinationOffer[]> {
      const response = await fetch(urlFor(routeId), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 402) {
        throw new Error(`upstream challenge returned status ${response.status}`);
      }
      const json: unknown = await response.json();
      if (!isRecord(json) || !Array.isArray(json["accepts"])) {
        throw new Error("upstream challenge has no accepts[]");
      }
      const offers: DestinationOffer[] = [];
      for (const entry of json["accepts"]) {
        const offer = offerOf(entry);
        if (offer !== undefined) {
          offers.push(offer);
        }
      }
      return offers;
    },

    async pay(request: PayRequest): Promise<PayResult> {
      // 合成の支払いトークン。**署名ではない**ことがそのまま読み取れる形にする。
      const credential = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          synthetic: true,
          label: "T1-synthetic-nopay",
          scheme: request.offer.scheme,
          network: request.offer.network,
          payload: {
            paymentId: request.paymentId,
            attempt: request.attempt,
            offer: request.offer,
          },
        }),
        "utf8",
      ).toString("base64");

      // 1 要求 1 回だけ。402 を受けても再送しない（自動支払いリトライ無効）。
      const response = await fetch(urlFor(request.routeId), {
        method: "GET",
        headers: { "x-payment": credential },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const receipt = response.headers.get("x-payment-response");

      if (response.status === 200) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return { outcome: "unknown", reason: "destination_pay_unknown" };
        }
        return {
          outcome: "paid",
          body,
          contentType: response.headers.get("content-type") ?? "application/json",
          ...(receipt === null ? {} : { txRef: receipt, receiptRef: receipt }),
        };
      }
      // 課金は成立したがデータがない（設計 §10 M6 と同じ終端）。
      if (response.status === 502) {
        return {
          outcome: "paid_no_data",
          reason: "paid_data_unavailable",
          // レシートは上流が実際に返したときだけ記録する。
          ...(receipt === null ? {} : { receiptRef: receipt }),
        };
      }
      if (response.status >= 500) {
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }
      return { outcome: "rejected", reason: "destination_rejected" };
    },
  };
}
