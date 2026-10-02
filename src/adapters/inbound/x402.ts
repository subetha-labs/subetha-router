/**
 * 受信レール: **x402（`exact` / EIP-3009）**。Router が **payee** として自分で requirements を発行し、
 * payer の credential を実 facilitator で verify → settle する（設計 §3）。
 *
 * SubEtha 受信との違い:
 * - SubEtha は facilitator から challenge を取得して `payTo` を得るが、
 *   **x402 では Router が payee なので自分で発行する**（`payTo` は構成値）。
 * - 標準の x402 クライアントは `accepted` に `resource` / `extensions` を付けるため、
 *   **トップレベルの未知キーは束縛対象外**にする。ただし **`extra` の未知キーは拒否**する
 *   （`exact` では `extra.name` / `extra.version` が EIP-712 domain を決めるため、
 *   ここを緩めると payer が署名ドメインを差し込める）。
 *
 * **facilitator へ送る `paymentRequirements` は必ず Router 発行の offer から組む。**
 * `credential.accepted` は絶対に送らない（送ると payer が requirements を差し替えられる）。
 *
 * facilitator は想定外の形に対して 500 と内部例外文字列を返すことがあるため、
 * **`isValid` 以外のフィールド（`invalidMessage` / `error`）は読まない・転送しない。**
 */

import { randomBytes } from "node:crypto";

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

/** x402 の EIP-3009 経路。ほかの scheme は扱わない（fail closed）。 */
export const X402_INBOUND_SCHEME = "exact";

const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Router が発行する `extra` のキー。**これ以外が `accepted.extra` にあれば拒否する。**
 *
 * `name` / `version` は **EIP-712 domain**（`exact` では facilitator がこれを見て
 * 署名ドメインを再構成する。欠けると `invalid_exact_evm_missing_eip712_domain` になる。親が実測）。
 * **Router が発行する**ので payer が差し込む余地は無く、ここに含めても攻撃面は増えない
 * （payer 側の値は完全一致検査で Router 発行値と一致しなければ拒否される）。
 */
const ISSUED_EXTRA_KEYS = [
  "name",
  "version",
  "challengeNonce",
  "expiresAt",
  "routeBinding",
  // 資金移動タイミングの申告。**allowlist に入れないと**、正直な payer が
  // 発行 offer をそのまま写しただけで `offer_mismatch` になる（`:183-186` の未知キー検査）。
  "fundsMoveOnCredential",
] as const;

export interface X402InboundOptions {
  /** 受信 facilitator の base URL（`ROUTER_X402_INBOUND_FACILITATOR_URL`）。 */
  readonly facilitatorUrl: string;
  /** facilitator へ出る全要求が通る transport（SSRF 防御 A。必須）。 */
  readonly transport: GuardedTransport;
  /** Router 自身の受取先。構成の `source.payTo`。 */
  readonly payTo: string;
  /** offer の有効期間（秒）。デモの操作時間を賄える値にする。 */
  readonly maxTimeoutSeconds?: number;
  /**
   * 受信資産の EIP-712 domain（`exact` の署名に必要）。
   * facilitator はこれを `requirements.extra` から読む。既定は USDC の値。
   */
  readonly assetDomain?: { readonly name: string; readonly version: string };
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createX402Inbound(options: X402InboundOptions): InboundRail {
  const base = options.facilitatorUrl.replace(/\/$/, "");
  const transport = options.transport;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 120;
  const assetDomain = options.assetDomain ?? { name: "USDC", version: "2" };
  const timeoutMs = options.timeoutMs ?? 10_000;

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

  /**
   * facilitator へ送る requirements。**Router 発行の offer からのみ組む。**
   * `credential.accepted` は使わない。
   */
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

  /**
   * 実 facilitator は `paymentPayload` のトップレベルに `scheme` / `network` が無いと
   * 内部例外で 500 を返す（親が実測）。`PaymentCredential` 型は変えずにここで補う。
   */
  function payloadOf(offer: InboundOffer, credential: PaymentCredential): unknown {
    return {
      x402Version: credential.x402Version,
      scheme: offer.scheme,
      network: offer.network,
      accepted: credential.accepted,
      payload: credential.payload,
    };
  }

  return {
    async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
      // nonce は CSPRNG。一意性・発行済み性の担保は core 側（quoteId = challengeNonce）。
      const challengeNonce = `0x${randomBytes(32).toString("hex")}`;
      if (!NONCE_PATTERN.test(challengeNonce)) {
        throw new Error("generated challengeNonce is malformed");
      }
      return {
        scheme: X402_INBOUND_SCHEME,
        network: request.network,
        asset: request.asset,
        amount: request.amount,
        payTo: options.payTo,
        maxTimeoutSeconds,
        extra: {
          // EIP-712 domain。facilitator が署名ドメインの再構成に使う。
          name: assetDomain.name,
          version: assetDomain.version,
          challengeNonce,
          expiresAt: Math.floor(request.nowMs / 1000) + maxTimeoutSeconds,
          routeBinding: request.routeBinding,
          /**
           * **署名だけでは資金が動かない**（EIP-3009）。送金は後段で facilitator が
           * settle するときに起きるので、承認は purchase の前で間に合う。
           */
          fundsMoveOnCredential: false,
        },
      };
    },

    /** **同期**（core は await しない）。journal 生成前の strict preflight。 */
    preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
      if (credential.payload.challengeNonce !== offer.extra.challengeNonce) {
        return { ok: false, reason: "nonce_mismatch" };
      }
      if (offer.extra.expiresAt * 1000 <= nowMs) {
        return { ok: false, reason: "offer_expired" };
      }
      const accepted = credential.accepted as Partial<InboundOffer> | undefined;
      if (accepted === undefined || accepted.scheme !== X402_INBOUND_SCHEME) {
        // scheme は core が照合しないので、ここで固定値として必ず見る。
        return { ok: false, reason: "credential_mismatch" };
      }
      if (accepted.extra?.routeBinding !== offer.extra.routeBinding) {
        return { ok: false, reason: "route_binding_mismatch" };
      }
      // Router 発行分はすべて一致していなければ通さない。
      if (
        accepted.network !== offer.network ||
        accepted.asset !== offer.asset ||
        accepted.amount !== offer.amount ||
        accepted.payTo !== offer.payTo ||
        accepted.maxTimeoutSeconds !== offer.maxTimeoutSeconds
      ) {
        return { ok: false, reason: "offer_mismatch" };
      }
      const acceptedExtra = accepted.extra;
      if (!isRecord(acceptedExtra)) {
        return { ok: false, reason: "offer_mismatch" };
      }
      // `extra` は Router 発行キーのみ。未知キーがあれば拒否する
      // （`exact` では extra が署名ドメインを決めるため、ここを緩めない）。
      for (const key of Object.keys(acceptedExtra)) {
        if (!(ISSUED_EXTRA_KEYS as readonly string[]).includes(key)) {
          return { ok: false, reason: "offer_mismatch" };
        }
      }
      for (const key of ISSUED_EXTRA_KEYS) {
        if (acceptedExtra[key] !== offer.extra[key]) {
          return { ok: false, reason: "offer_mismatch" };
        }
      }
      // `accepted` トップレベルの未知キー（`resource` / `extensions` 等）は束縛対象外。
      return { ok: true };
    },

    async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean }> {
      const { status, json } = await post("/verify", {
        x402Version: 2,
        paymentPayload: payloadOf(offer, credential),
        paymentRequirements: requirementsOf(offer),
      }, { routeId: context?.routeId ?? "-", operation: "facilitator_verify" });
      // 検証できないまま settle へ進まない（この時点では課金が起きていない）。
      // `invalidMessage` / `error` は読まない（facilitator の内部実装を転送しない）。
      if (status !== 200 || !isRecord(json)) {
        return { isValid: false };
      }
      return { isValid: json["isValid"] === true };
    },

    async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
      // 例外・タイムアウトは呼び出し側（core）が `unknown` として確定する。自動再 settle はしない。
      const { status, json } = await post("/settle", {
        x402Version: 2,
        paymentPayload: payloadOf(offer, credential),
        paymentRequirements: requirementsOf(offer),
      }, { routeId: context?.routeId ?? "-", operation: "facilitator_settle" });
      if (status >= 500) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      if (status >= 400) {
        return { outcome: "rejected", reason: "source_rejected" };
      }
      if (!isRecord(json)) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      if (json["success"] !== true) {
        return { outcome: "rejected", reason: "source_rejected" };
      }
      // 発行 offer と違う network の応答は不正。課金有無を断定できないので `unknown`。
      if (json["network"] !== offer.network) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      const txRef = json["transaction"];
      if (typeof txRef !== "string" || txRef === "") {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      return { outcome: "settled", txRef };
    },
  };
}
