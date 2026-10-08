/**
 * facilitator への自前の client（`docs/provider-x402-workers.md` §3.2）。SDK の `HTTPFacilitatorClient` は本文を見ずに認証ヘッダを作り、
 * 既定 90 秒で redirect を追うので使わない。ここでは本文を **1 度だけ**直列化し（Circle ならその文字列に売り手証明を束縛し）、
 * 期限・redirect・本文の上限・失敗の分類を自分で持つ。settle は **要求ごとに 1 回**（2 度目は throw）。
 */
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";

import { sellerProofFor, type SellerProofSigner } from "./seller-proof.js";

export const VERIFY_TIMEOUT_MS = 4_000;
export const SETTLE_TIMEOUT_MS = 20_000;
export const SUPPORTED_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** 失敗の分類（固定。facilitator の文言は入れない）。 */
export type FacilitatorFailure = "facilitator_unavailable" | "facilitator_registration_required";

export class FacilitatorUnavailableError extends Error {
  constructor(readonly kind: FacilitatorFailure, readonly status: number | undefined) {
    super(kind);
    this.name = "FacilitatorUnavailableError";
  }
}

export class SettleCalledTwiceError extends Error {
  constructor() {
    super("settle must be called at most once per request");
    this.name = "SettleCalledTwiceError";
  }
}

export interface FacilitatorClientOptions {
  readonly url: string;
  /** Circle のときだけ（売り手証明）。 */
  readonly signer?: SellerProofSigner;
  readonly fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 本文を上限つきで読んで JSON にする。形が違えば `undefined`。 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 1 要求分の client。`settle` は 1 回だけ。 */
export class BoundedFacilitatorClient implements FacilitatorClient {
  readonly #url: string;
  readonly #signer: SellerProofSigner | undefined;
  readonly #fetch: typeof fetch;
  #settleCalls = 0;

  constructor(options: FacilitatorClientOptions) {
    this.#url = options.url.replace(/\/$/, "");
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
  }

  get settleCalls(): number {
    return this.#settleCalls;
  }

  async #post(purpose: "verify" | "settle", paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    // 1 度だけ直列化し、証明も送信もこの文字列に束縛する。
    const requestText = JSON.stringify({ x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#signer !== undefined) headers["facilitator-seller-proof"] = await sellerProofFor(this.#signer, purpose, requestText);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/${purpose}`, { method: "POST", headers, body: requestText, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new FacilitatorUnavailableError("facilitator_unavailable", undefined);
    }
    let json: unknown;
    try {
      json = await readJson(response);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }

  /** `isValid` の boolean を返す。HTTP の不達・期限・形違いは例外（`FacilitatorUnavailableError`）。 */
  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    const { status, json } = await this.#post("verify", paymentPayload, paymentRequirements, VERIFY_TIMEOUT_MS);
    if (status === 403 && isRecord(json) && json["errorReason"] === "registration_required") throw new FacilitatorUnavailableError("facilitator_registration_required", status);
    if (status !== 200 || !isRecord(json) || typeof json["isValid"] !== "boolean") throw new FacilitatorUnavailableError("facilitator_unavailable", status);
    // 返すのは判定だけ（facilitator の文言は外に出さない）。
    return { isValid: json["isValid"], ...(json["isValid"] ? { payer: typeof json["payer"] === "string" ? json["payer"] : undefined } : { invalidReason: "payment_invalid" }) } as VerifyResponse;
  }

  /** 1 回だけ。応答はそのまま返す（検査は `receipt.ts`）。HTTP の不達・期限・形違い・403 は例外。 */
  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    this.#settleCalls += 1;
    if (this.#settleCalls > 1) throw new SettleCalledTwiceError();
    const { status, json } = await this.#post("settle", paymentPayload, paymentRequirements, SETTLE_TIMEOUT_MS);
    if (status === 403 && isRecord(json) && json["errorReason"] === "registration_required") throw new FacilitatorUnavailableError("facilitator_registration_required", status);
    if (status !== 200 || !isRecord(json) || typeof json["success"] !== "boolean") throw new FacilitatorUnavailableError("facilitator_unavailable", status);
    return json as unknown as SettleResponse;
  }

  async getSupported(): Promise<SupportedResponse> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/supported`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(SUPPORTED_TIMEOUT_MS) });
    } catch {
      throw new FacilitatorUnavailableError("facilitator_unavailable", undefined);
    }
    const json = await readJson(response).catch(() => undefined);
    if (response.status !== 200 || !isRecord(json) || !Array.isArray(json["kinds"])) throw new FacilitatorUnavailableError("facilitator_unavailable", response.status);
    return json as unknown as SupportedResponse;
  }
}
