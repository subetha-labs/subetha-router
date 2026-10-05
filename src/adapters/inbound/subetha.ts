/**
 * SubEtha 受信レール adapter（設計 §4.1 の素の JSON over HTTP）。
 * Router は受信側（検証者）で**署名しない**ため scheme クライアント SDK を必要としない。
 *
 * **本スライスでの実行範囲**: 相手はリポジトリ内の合成 facilitator fixture（loopback）だけで、
 * `synthetic`（無課金・無署名・鍵なし）。実 facilitator の URL・資産・チェーン・settle 再呼び出しの
 * 安全条件は未解決（設計 §12 U-01r）であり、実決済の証拠にはならない。
 */

import { stableJson } from "../../core/intent.js";
import type { GuardedTransport, TransportContext } from "../../net/guarded-fetch.js";
import type {
  CreateOfferRequest,
  InboundOffer,
  InboundRail,
  PaymentCredential,
  PreflightResult,
  SettleResult,
  InboundCallContext,
} from "../../ports/inbound.js";

export const SUBETHA_SCHEME = "subetha-zerc20";

export interface SubethaInboundOptions {
  /** facilitator の base URL（設定 1 本だけ）。 */
  readonly facilitatorUrl: string;
  /** facilitator へ出る全要求が通る transport（SSRF 防御 A。必須）。 */
  readonly transport: GuardedTransport;
  /** 発行 offer の `maxTimeoutSeconds`。 */
  readonly maxTimeoutSeconds?: number;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 相手の応答は型ではなく実際の値として検査する。 */
function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`facilitator response missing ${key}`);
  }
  return value;
}

function requireNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`facilitator response missing ${key}`);
  }
  return value;
}

/** unix 秒・chainId のような整数欄。小数や負値は受け付けない。 */
function requireInteger(source: Record<string, unknown>, key: string): number {
  const value = requireNumber(source, key);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`facilitator response has a malformed ${key}`);
  }
  return value;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * settle の `errorReason` のうち、**「課金されていない」ことを意味しない**もの。
 * これらは `rejected`（＝ `awaiting_payment` として再提示）ではなく `unknown` に落とす。
 *
 * - `pending_burn`: burn 未確定。facilitator 側の定義が "retryable"（終端でない）
 * - `state=accepted`: **支払いは成立している**。challenge が受領済みなので再 settle が弾かれた形
 * - `state=accepting`: 別の collect が進行中で、結果が未確定
 * - challenge の不在（`unknown challenge` / `already-used` / `burn address already used`）:
 *   facilitator は受領済み challenge を猶予期間後に削除するため、
 *   **記録が無いことは未払いの証拠にならない**（再照会は "unknown" を返すのが正しいと
 *   facilitator 側のコメントも明言している）
 *
 * 判定は**部分一致**にする。`challenge not open (state=accepted)` のように
 * 状態名が文中に埋め込まれて返るため。
 */
const UNDETERMINED_SETTLE_REASONS = [
  "pending_burn",
  "state=accepted",
  "state=accepting",
  "unknown challenge",
  "already-used challenge",
  "burn address already used",
] as const;

/** `errorReason` が未課金を意味しないなら true（型でなく実際の値として検査する）。 */
function undetermined(reason: unknown): boolean {
  if (typeof reason !== "string") {
    return false;
  }
  const lowered = reason.toLowerCase();
  return UNDETERMINED_SETTLE_REASONS.some((marker) => lowered.includes(marker));
}

/**
 * `helper` / `deadline` は**両方あるか両方ないか**で、かつ**型も満たす**（設計 §4.1）。
 * 片側欠落・型違反のどちらでも offer を発行しない（不整合な challenge を承認対象にしない）。
 */
function requireHelperPair(json: Record<string, unknown>): { helper: string; deadline: number } | undefined {
  const helper = json["helper"];
  const deadline = json["deadline"];
  if (helper === undefined && deadline === undefined) {
    return undefined;
  }
  if (helper === undefined || deadline === undefined) {
    throw new Error("facilitator challenge has only one of helper/deadline");
  }
  if (typeof helper !== "string" || !ADDRESS_PATTERN.test(helper)) {
    throw new Error("facilitator challenge has a malformed helper");
  }
  if (typeof deadline !== "number" || !Number.isInteger(deadline) || deadline <= 0) {
    throw new Error("facilitator challenge has a malformed deadline");
  }
  return { helper, deadline };
}

/** `fee` は `{amount:10進文字列, bps:整数}`。型違反は offer を発行しない。 */
function requireFee(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const fee = json["fee"];
  if (fee === undefined) {
    return undefined;
  }
  if (!isRecord(fee)) {
    throw new Error("facilitator challenge has a malformed fee");
  }
  const amount = fee["amount"];
  const bps = fee["bps"];
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    throw new Error("facilitator challenge has a malformed fee.amount");
  }
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0) {
    throw new Error("facilitator challenge has a malformed fee.bps");
  }
  return fee;
}

export function createSubethaInbound(options: SubethaInboundOptions): InboundRail {
  const base = options.facilitatorUrl.replace(/\/$/, "");
  const transport = options.transport;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 120;

  /** 自動リトライをしない 1 回きりの POST。リダイレクトは追わない。 */
  async function post(
    path: string,
    body: unknown,
    context: TransportContext,
  ): Promise<{ status: number; json: unknown }> {
    const response = await transport.fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }, context);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // body の読み取り（headers 後）の失敗は adapter が報告する（設計 A §3.3-7）。
      transport.report(error, context);
      throw error;
    }
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }

  function requirementsOf(offer: InboundOffer): unknown {
    return {
      scheme: offer.scheme,
      network: offer.network,
      asset: offer.asset,
      amount: offer.amount,
      payTo: offer.payTo,
      maxTimeoutSeconds: offer.maxTimeoutSeconds,
      extra: offer.extra,
    };
  }

  return {
    async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
      const { status, json } = await post("/challenge", { amount: request.amount }, { routeId: request.routeId, operation: "facilitator_challenge" });
      if (status !== 200 || !isRecord(json)) {
        throw new Error(`facilitator challenge failed with status ${status}`);
      }
      const challengeNonce = requireString(json, "challengeNonce");
      if (!NONCE_PATTERN.test(challengeNonce)) {
        throw new Error("facilitator challenge has a malformed challengeNonce");
      }
      const expiresAt = requireInteger(json, "expiresAt");
      const chainId = requireInteger(json, "chainId");
      const token = requireString(json, "token");
      if (!ADDRESS_PATTERN.test(token)) {
        throw new Error("facilitator challenge has a malformed token");
      }
      const pair = requireHelperPair(json);
      const fee = requireFee(json);
      return {
        scheme: SUBETHA_SCHEME,
        network: `eip155:${chainId}`,
        asset: token,
        amount: requireString(json, "amount"),
        payTo: requireString(json, "payTo"),
        maxTimeoutSeconds,
        extra: {
          challengeNonce,
          expiresAt,
          routeBinding: request.routeBinding,
          /**
           * **常に `true`。** self-transfer 経路では payer 自身が burn を broadcast し、
           * credential はその `burnTxHash` を内包するので、**払わないと credential を作れない**。
           *
           * permit 経路（facilitator が broadcast）では署名のみのこともあるが、
           * **`helper` は能力の広告であって payer が選ぶ経路ではない**——helper 付き offer でも
           * payer は self-transfer を選べる。`createOffer` の時点でどちらになるか知り得ないため、
           * **保守的に `true` を申告する**（署名が支出すると主張しているのではない）。
           */
          fundsMoveOnCredential: true,
          ...(pair === undefined ? {} : { helper: pair.helper, deadline: pair.deadline }),
          ...(fee === undefined ? {} : { fee }),
        },
      };
    },

    /** journal 生成**前**の strict preflight（設計 §4 手順 3）。 */
    preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
      if (credential.payload.challengeNonce !== offer.extra.challengeNonce) {
        return { ok: false, reason: "nonce_mismatch" };
      }
      if (offer.extra.expiresAt * 1000 <= nowMs) {
        return { ok: false, reason: "offer_expired" };
      }
      const accepted = credential.accepted as InboundOffer | undefined;
      if (accepted === undefined || accepted.scheme !== SUBETHA_SCHEME) {
        return { ok: false, reason: "credential_mismatch" };
      }
      if (accepted.extra?.routeBinding !== offer.extra.routeBinding) {
        return { ok: false, reason: "route_binding_mismatch" };
      }
      // 拡張フィールド込みの完全一致（キー順非依存の安定 JSON 比較）。
      if (stableJson(accepted) !== stableJson(offer)) {
        return { ok: false, reason: "offer_mismatch" };
      }
      return { ok: true };
    },

    async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean }> {
      const { status, json } = await post("/verify", {
        x402Version: 2,
        paymentPayload: credential,
        paymentRequirements: requirementsOf(offer),
      }, { routeId: context?.routeId ?? "-", operation: "facilitator_verify" });
      // 検証できないまま settle へ進まない（この時点では課金が起きていない）。
      if (status !== 200 || !isRecord(json)) {
        return { isValid: false };
      }
      return { isValid: json["isValid"] === true };
    },

    async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
      // 例外・タイムアウトは呼び出し側（core）が `unknown` として確定する。自動再 settle はしない。
      const { status, json } = await post("/settle", {
        x402Version: 2,
        paymentPayload: credential,
        paymentRequirements: requirementsOf(offer),
      }, { routeId: context?.routeId ?? "-", operation: "facilitator_settle" });
      if (status >= 500) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      /**
       * **429 は `rejected` ではない。** 実 facilitator は `/settle` の**手前**に limiter を置く
       * （`apps/facilitator/src/http.ts:41-44`）。429 は「この呼び出しが決済処理に到達しなかった」
       * ことしか意味せず、**先行する呼び出しや payer 自身の burn について何も否定しない**。
       * `rejected` に丸めると、課金済みが `awaiting_payment` として再提示される。
       */
      if (status === 429) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      if (status >= 400) {
        return { outcome: "rejected", reason: "source_rejected" };
      }
      if (!isRecord(json)) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      // 発行 offer と違う network の応答は不正。課金有無を断定できないので `unknown`。
      if (json["network"] !== offer.network) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      const extra = json["extra"];
      if (isRecord(extra) && extra["phase"] === "pending") {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      const transaction = json["transaction"];
      if (json["success"] === true && typeof transaction === "string" && transaction !== "") {
        return { outcome: "settled", txRef: transaction };
      }
      /**
       * **`success:false` は一律 `rejected` ではない。** 未課金を意味しない応答を
       * `rejected` に丸めると、**課金済みの購入が `awaiting_payment` として提示される**
       * （`src/core/orchestrator.ts` の `rejected` 分岐）。それは二重支払いの誘導になる。
       */
      if (undetermined(json["errorReason"])) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      if (json["success"] === false) {
        return { outcome: "rejected", reason: "source_rejected" };
      }
      return { outcome: "unknown", reason: "source_settle_unknown" };
    },
  };
}
