/**
 * facilitator への自前の client（`docs/provider-x402-workers.md` §3.2）。SDK の `HTTPFacilitatorClient` は本文を見ずに認証ヘッダを作り、
 * 既定 90 秒で redirect を追うので使わない。ここでは本文を **1 度だけ**直列化し（Circle ならその文字列に売り手証明を束縛し）、
 * **呼び出しごとに受けた段**（signal と時計）で署名・送出・本文の読取を止め、本文は **byte で**上限まで読む。settle は **要求ごとに 1 回**（2 度目は throw）。
 */
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { getBase58Encoder } from "@solana/kit";

import { DeadlineError, withSignal, type Stage } from "./deadline.js";
import { sellerProofFor, type SellerProofSigner } from "./seller-proof.js";

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
  /** 呼び出しごとの段を返す（signal は段の予算と要求全体の abort。`expired` は時計で見た経過。終わりに `dispose`）。 */
  readonly stageFor: (stage: "verify" | "settle" | "supported") => Stage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 本文を **byte 単位の上限**まで読む（超えれば `undefined`）。signal が切れれば reject。 */
export async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DeadlineError();
      const { done, value } = await withSignal(signal, reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    // cancel は待たない（相手が応じなくても戻る）。
    void reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function isBase58Of(value: unknown, length: number): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === length;
  } catch {
    return false;
  }
}

/** `/supported` の応答から、この network・scheme の kind を取り出す（無い・形違いなら `undefined`）。SVM は `feePayer` が base58 32 バイト。 */
export function supportedKindOf(json: unknown, network: string): Record<string, unknown> | undefined {
  if (!isRecord(json) || !Array.isArray(json["kinds"])) return undefined;
  const kind = (json["kinds"] as unknown[]).find((k) => isRecord(k) && k["x402Version"] === 2 && k["scheme"] === "exact" && k["network"] === network);
  if (!isRecord(kind)) return undefined;
  if (network.startsWith("solana:")) {
    const extra = kind["extra"];
    if (!isRecord(extra) || !isBase58Of(extra["feePayer"], 32)) return undefined;
  }
  return kind;
}

/** 1 要求分の client。`settle` は 1 回だけ。 */
export class BoundedFacilitatorClient implements FacilitatorClient {
  readonly #url: string;
  readonly #signer: SellerProofSigner | undefined;
  readonly #fetch: typeof fetch;
  readonly #stageFor: FacilitatorClientOptions["stageFor"];
  #settleCalls = 0;

  constructor(options: FacilitatorClientOptions) {
    this.#url = options.url.replace(/\/$/, "");
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
    this.#stageFor = options.stageFor;
  }

  get settleCalls(): number {
    return this.#settleCalls;
  }

  async #post(purpose: "verify" | "settle", paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<{ status: number; json: unknown }> {
    const stage = this.#stageFor(purpose);
    try {
      const { signal } = stage;
      if (stage.expired()) throw new DeadlineError();
      // 1 度だけ直列化し、証明も送信もこの文字列に束縛する。署名も signal の内側（遅い署名の後に送らない）。
      const requestText = JSON.stringify({ x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.#signer !== undefined) headers["facilitator-seller-proof"] = await withSignal(signal, sellerProofFor(this.#signer, purpose, requestText));
      // 送出の直前: signal だけでなく時計でも見る（timer の配達が遅れていても、過ぎていれば送らない）。
      if (stage.expired()) throw new DeadlineError();
      let response: Response;
      try {
        response = await this.#fetch(`${this.#url}/${purpose}`, { method: "POST", headers, body: requestText, redirect: "error", signal });
      } catch {
        if (signal.aborted) throw new DeadlineError();
        throw new FacilitatorUnavailableError("facilitator_unavailable", undefined);
      }
      let json: unknown;
      try {
        json = await readBoundedJson(response, MAX_RESPONSE_BYTES, signal);
      } catch (error) {
        if (error instanceof DeadlineError) throw error;
        json = undefined;
      }
      return { status: response.status, json };
    } finally {
      stage.dispose();
    }
  }

  /** `isValid` の boolean を返す。HTTP の不達・期限・形違いは例外（`FacilitatorUnavailableError`／`DeadlineError`）。 */
  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    const { status, json } = await this.#post("verify", paymentPayload, paymentRequirements);
    if (status === 403 && isRecord(json) && json["errorReason"] === "registration_required") throw new FacilitatorUnavailableError("facilitator_registration_required", status);
    if (status !== 200 || !isRecord(json) || typeof json["isValid"] !== "boolean") throw new FacilitatorUnavailableError("facilitator_unavailable", status);
    // 返すのは判定だけ（facilitator の文言は外に出さない）。
    return (json["isValid"] ? { isValid: true } : { isValid: false, invalidReason: "payment_invalid" }) as VerifyResponse;
  }

  /** 1 回だけ。応答はそのまま返す（検査は `receipt.ts`）。HTTP の不達・期限・形違い・403 は例外。 */
  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    this.#settleCalls += 1;
    if (this.#settleCalls > 1) throw new SettleCalledTwiceError();
    const { status, json } = await this.#post("settle", paymentPayload, paymentRequirements);
    if (status === 403 && isRecord(json) && json["errorReason"] === "registration_required") throw new FacilitatorUnavailableError("facilitator_registration_required", status);
    if (status !== 200 || !isRecord(json) || typeof json["success"] !== "boolean") throw new FacilitatorUnavailableError("facilitator_unavailable", status);
    return json as unknown as SettleResponse;
  }

  async getSupported(): Promise<SupportedResponse> {
    const stage = this.#stageFor("supported");
    try {
      const { signal } = stage;
      if (stage.expired()) throw new DeadlineError();
      let response: Response;
      try {
        response = await this.#fetch(`${this.#url}/supported`, { method: "GET", redirect: "error", signal });
      } catch {
        if (signal.aborted) throw new DeadlineError();
        throw new FacilitatorUnavailableError("facilitator_unavailable", undefined);
      }
      const json = await readBoundedJson(response, MAX_RESPONSE_BYTES, signal);
      if (response.status !== 200 || !isRecord(json) || !Array.isArray(json["kinds"])) throw new FacilitatorUnavailableError("facilitator_unavailable", response.status);
      return json as unknown as SupportedResponse;
    } finally {
      stage.dispose();
    }
  }
}
