/**
 * SubEtha 受信レール adapter（設計 §4.1 の素の JSON over HTTP）。
 * Router は受信側（検証者）で**署名しない**ため scheme クライアント SDK を必要としない。
 *
 * **本スライスでの実行範囲**: 相手はリポジトリ内の合成 facilitator fixture（loopback）だけで、
 * `synthetic`（無課金・無署名・鍵なし）。実 facilitator の URL・資産・チェーン・settle 再呼び出しの
 * 安全条件は未解決（設計 §12 U-01r）であり、実決済の証拠にはならない。
 */

import { stableJson } from "../../core/intent.js";
import type {
  CreateOfferRequest,
  InboundOffer,
  InboundRail,
  PaymentCredential,
  PreflightResult,
  SettleResult,
} from "../../ports/inbound.js";

export const SUBETHA_SCHEME = "subetha-zerc20";

export interface SubethaInboundOptions {
  /** facilitator の base URL（設定 1 本だけ）。 */
  readonly facilitatorUrl: string;
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

export function createSubethaInbound(options: SubethaInboundOptions): InboundRail {
  const base = options.facilitatorUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 120;

  /** 自動リトライをしない 1 回きりの POST。リダイレクトは追わない。 */
  async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
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
      const { status, json } = await post("/challenge", { amount: request.amount });
      if (status !== 200 || !isRecord(json)) {
        throw new Error(`facilitator challenge failed with status ${status}`);
      }
      const challengeNonce = requireString(json, "challengeNonce");
      const expiresAt = requireNumber(json, "expiresAt");
      const chainId = requireNumber(json, "chainId");
      const helper = json["helper"];
      const deadline = json["deadline"];
      // `helper` と `deadline` は両方あるか両方ないか。不整合なら offer を発行しない。
      if ((helper === undefined) !== (deadline === undefined)) {
        throw new Error("facilitator challenge has only one of helper/deadline");
      }
      const fee = json["fee"];
      if (fee !== undefined && !isRecord(fee)) {
        throw new Error("facilitator challenge has a malformed fee");
      }
      return {
        scheme: SUBETHA_SCHEME,
        network: `eip155:${chainId}`,
        asset: requireString(json, "token"),
        amount: requireString(json, "amount"),
        payTo: requireString(json, "payTo"),
        maxTimeoutSeconds,
        extra: {
          challengeNonce,
          expiresAt,
          routeBinding: request.routeBinding,
          ...(helper === undefined ? {} : { helper, deadline }),
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

    async verify(offer: InboundOffer, credential: PaymentCredential): Promise<{ isValid: boolean }> {
      const { status, json } = await post("/verify", {
        x402Version: 2,
        paymentPayload: credential,
        paymentRequirements: requirementsOf(offer),
      });
      // 検証できないまま settle へ進まない（この時点では課金が起きていない）。
      if (status !== 200 || !isRecord(json)) {
        return { isValid: false };
      }
      return { isValid: json["isValid"] === true };
    },

    async settle(offer: InboundOffer, credential: PaymentCredential): Promise<SettleResult> {
      // 例外・タイムアウトは呼び出し側（core）が `unknown` として確定する。自動再 settle はしない。
      const { status, json } = await post("/settle", {
        x402Version: 2,
        paymentPayload: credential,
        paymentRequirements: requirementsOf(offer),
      });
      if (status >= 500) {
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
      if (json["success"] === false) {
        return { outcome: "rejected", reason: "source_rejected" };
      }
      return { outcome: "unknown", reason: "source_settle_unknown" };
    },
  };
}
