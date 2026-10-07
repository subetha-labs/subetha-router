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
  SellerProofCapability,
  SellerProofPurpose,
  SettleResult,
  InboundCallContext,
} from "../../ports/inbound.js";
import { bodyHashOf } from "./seller-proof.js";

/** facilitator の種類（multirail 設計 §2・§4）。`x402` は既存の挙動そのまま、`circle` は Circle の Facilitator Service。 */
export type X402FacilitatorKind = "x402" | "circle";
/** Circle の settle の wire の `maxTimeoutSeconds`（facilitator が settle を待つ窓）の既定。設計 §4.1。 */
export const CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS = 30;
/** kind `circle` の offer の有効期間の既定（秒）。承認の時間を賄う。 */
export const CIRCLE_DEFAULT_OFFER_SECONDS = 120;
/** EVM の tx hash。Circle の settle の `transaction` はこの形でなければ `settled` にしない（設計 §6）。 */
const EVM_TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

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

/** kind `circle` の発行 extra（Circle の要求 `assetTransferMethod: "eip3009"` を足す。設計 §4.1）。 */
const CIRCLE_ISSUED_EXTRA_KEYS = [...ISSUED_EXTRA_KEYS, "assetTransferMethod"] as const;

export interface X402InboundOptions {
  /** facilitator の種類。既定 `x402`（既存の挙動）。`circle` は `sellerProof` が必須。 */
  readonly kind?: X402FacilitatorKind;
  /** kind `circle` の売り手証明の能力（設計 §3）。 */
  readonly sellerProof?: SellerProofCapability;
  /**
   * offer の有効期間（秒。`extra.expiresAt`、承認期限）。kind `x402` の既定は `maxTimeoutSeconds` と同じ（今までどおり）、
   * kind `circle` の既定は 120。
   */
  readonly offerSeconds?: number;
  /**
   * 運用者向けの診断（固定の code だけ。値は渡さない）。kind `circle` で facilitator が `403 registration_required`
   * （鍵なし trial の枠切れ）を返したときに `facilitator_trial_exhausted`。自動では何もしない。
   */
  readonly onDiagnostic?: (code: "facilitator_trial_exhausted") => void;
  /** 受信 facilitator の base URL（`ROUTER_X402_INBOUND_FACILITATOR_URL`）。 */
  readonly facilitatorUrl: string;
  /** facilitator へ出る全要求が通る transport（SSRF 防御 A。必須）。 */
  readonly transport: GuardedTransport;
  /** Router 自身の受取先。構成の `source.payTo`。 */
  readonly payTo: string;
  /**
   * wire の `maxTimeoutSeconds`（requirements に載る、facilitator が settle を待つ窓）。kind `x402` では offer の有効期間も兼ねる（既存の挙動）。
   * kind `circle` の既定は 30（Circle が待つ窓。settle の HTTP 期限はこれ＋10 秒）。
   */
  readonly maxTimeoutSeconds?: number;
  /**
   * 受信資産の EIP-712 domain（`exact` の署名に必要）。
   * facilitator はこれを `requirements.extra` から読む。既定は USDC の値。
   */
  readonly assetDomain?: { readonly name: string; readonly version: string };
  readonly timeoutMs?: number;
  /**
   * **署名を quote に束縛する**（動的購入のプロファイル用。設計 `docs/dynamic-upstream-design.md` §4）。
   * 有効にすると、preflight が EIP-3009 の `authorization` について次を要求する:
   * `nonce === offer.extra.challengeNonce`、`to === offer.payTo`、`value === offer.amount`、`validBefore <= offer.extra.expiresAt`。
   *
   * 署名は `nonce` を含むので、ある quote のために作った署名は、`challengeNonce` の違う別の quote では通らない:
   * そのまま持ち込めば preflight が落とし、`nonce` 欄だけ書き換えれば facilitator の署名検証が落とす。
   * **既定は無効**（静的 route は、乱数の nonce を使う標準のクライアントを従来どおり受け付ける）。
   */
  readonly bindAuthorizationNonce?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createX402Inbound(options: X402InboundOptions): InboundRail {
  const base = options.facilitatorUrl.replace(/\/$/, "");
  const transport = options.transport;
  const kind: X402FacilitatorKind = options.kind ?? "x402";
  const sellerProof = options.sellerProof;
  if (kind === "circle" && sellerProof === undefined) {
    throw new Error("x402 inbound: kind \"circle\" requires a seller proof capability");
  }
  // 時間の 3 つ（設計 §4.1・§4.4）: offer の有効期間、wire の maxTimeoutSeconds、HTTP の期限。
  // kind `x402` は 3 つとも今までどおり（有効期間 = wire、HTTP は verify・settle とも timeoutMs）。
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? (kind === "circle" ? CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS : 120);
  const offerSeconds = options.offerSeconds ?? (kind === "circle" ? CIRCLE_DEFAULT_OFFER_SECONDS : maxTimeoutSeconds);
  const assetDomain = options.assetDomain ?? { name: "USDC", version: "2" };
  const timeoutMs = options.timeoutMs ?? 10_000;
  const settleTimeoutMs = kind === "circle" ? (maxTimeoutSeconds + 10) * 1000 : timeoutMs;
  const issuedExtraKeys: readonly string[] = kind === "circle" ? CIRCLE_ISSUED_EXTRA_KEYS : ISSUED_EXTRA_KEYS;

  /**
   * 自動リトライをしない 1 回きりの POST。リダイレクトは追わない。
   * body は**ここで 1 度だけ直列化**し、売り手証明はその bytes の hash に束縛する（設計 §4.2）。
   */
  async function post(
    path: string,
    body: unknown,
    context: TransportContext,
    deadlineMs: number,
    proof: string | undefined,
  ): Promise<{ status: number; json: unknown }> {
    const requestText = JSON.stringify(body);
    const response = await transport.fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(proof === undefined ? {} : { "facilitator-seller-proof": proof }) },
      body: requestText,
      redirect: "error",
      signal: AbortSignal.timeout(deadlineMs),
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
   * kind `circle` の売り手証明。要求本体の bytes の hash を能力に渡す。能力が拒めば `undefined` を返し、呼び出し側は**要求を出さない**。
   * kind `x402` では常に `undefined`（header 無し）。
   */
  async function proofFor(purpose: SellerProofPurpose, body: unknown): Promise<{ ok: true; proof: string | undefined } | { ok: false }> {
    if (kind !== "circle" || sellerProof === undefined) return { ok: true, proof: undefined };
    try {
      return { ok: true, proof: await sellerProof.proofFor(purpose, bodyHashOf(JSON.stringify(body))) };
    } catch {
      return { ok: false };
    }
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
          expiresAt: Math.floor(request.nowMs / 1000) + offerSeconds,
          routeBinding: request.routeBinding,
          // Circle は EIP-3009 の経路を requirements で名指しすることを要求する（設計 §4.1）。
          ...(kind === "circle" ? { assetTransferMethod: "eip3009" } : {}),
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
        if (!issuedExtraKeys.includes(key)) {
          return { ok: false, reason: "offer_mismatch" };
        }
      }
      for (const key of issuedExtraKeys) {
        if (acceptedExtra[key] !== offer.extra[key]) {
          return { ok: false, reason: "offer_mismatch" };
        }
      }
      // `accepted` トップレベルの未知キー（`resource` / `extensions` 等）は束縛対象外。
      if (options.bindAuthorizationNonce === true) {
        const authorization = credential.payload["authorization"];
        if (!isRecord(authorization)) {
          return { ok: false, reason: "credential_mismatch" };
        }
        // 署名に入る `nonce` が、この quote の `challengeNonce` であること（大文字小文字は hex として同一視する）。
        const nonce = authorization["nonce"];
        if (typeof nonce !== "string" || nonce.toLowerCase() !== offer.extra.challengeNonce.toLowerCase()) {
          return { ok: false, reason: "nonce_mismatch" };
        }
        const to = authorization["to"];
        const value = authorization["value"];
        const validBefore = authorization["validBefore"];
        if (
          typeof to !== "string" ||
          to.toLowerCase() !== offer.payTo.toLowerCase() ||
          typeof value !== "string" ||
          value !== offer.amount ||
          typeof validBefore !== "string" ||
          !/^[0-9]{1,15}$/.test(validBefore) ||
          Number(validBefore) > offer.extra.expiresAt
        ) {
          return { ok: false, reason: "credential_mismatch" };
        }
      }
      return { ok: true };
    },

    async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean }> {
      const body = {
        x402Version: 2,
        paymentPayload: payloadOf(offer, credential),
        paymentRequirements: requirementsOf(offer),
      };
      const proof = await proofFor("verify", body);
      if (!proof.ok) {
        // 証明が作れない: 要求を出さない（接続 0）。
        return { isValid: false };
      }
      const { status, json } = await post("/verify", body, { routeId: context?.routeId ?? "-", operation: "facilitator_verify" }, timeoutMs, proof.proof);
      // 検証できないまま settle へ進まない（この時点では課金が起きていない）。
      // `invalidMessage` / `error` は読まない（facilitator の内部実装を転送しない）。
      if (status !== 200 || !isRecord(json)) {
        return { isValid: false };
      }
      return { isValid: json["isValid"] === true };
    },

    async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
      // 例外・タイムアウトは呼び出し側（core）が `unknown` として確定する。自動再 settle はしない。
      const body = {
        x402Version: 2,
        paymentPayload: payloadOf(offer, credential),
        paymentRequirements: requirementsOf(offer),
      };
      const proof = await proofFor("settle", body);
      if (!proof.ok) {
        // 要求を**出す前**の失敗だけが `rejected`（設計 §6）。
        return { outcome: "rejected", reason: "source_rejected" };
      }
      const { status, json } = await post("/settle", body, { routeId: context?.routeId ?? "-", operation: "facilitator_settle" }, settleTimeoutMs, proof.proof);
      if (kind === "circle") {
        return settleOutcomeCircle(offer, status, json);
      }
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

  /**
   * kind `circle` の決済の結果の表（設計 §6、FR-19・FR-20）: 要求を出した後の失敗は**すべて `unknown`**
   * （4xx・5xx・`success: false`・`settlement_pending`・network 違い・`transaction` の形違い）。
   * `success: true`、network 一致、`transaction` が 0x＋64 hex のときだけ `settled`。
   * `payer`・`amount`・`extensions`・`errorReason` の文字列は読まない（診断の code だけ）。
   */
  function settleOutcomeCircle(offer: InboundOffer, status: number, json: unknown): SettleResult {
    if (status === 403 && isRecord(json) && json["errorReason"] === "registration_required") {
      options.onDiagnostic?.("facilitator_trial_exhausted");
    }
    if (status !== 200 || !isRecord(json) || json["success"] !== true || json["network"] !== offer.network) {
      return { outcome: "unknown", reason: "source_settle_unknown" };
    }
    const txRef = json["transaction"];
    if (typeof txRef !== "string" || !EVM_TX_HASH_PATTERN.test(txRef)) {
      return { outcome: "unknown", reason: "source_settle_unknown" };
    }
    return { outcome: "settled", txRef };
  }
}
