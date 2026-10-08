/**
 * settle の応答の検査（`docs/provider-x402-workers.md` §2.2 の表）。成功を**確かめられたとき**だけ `PAYMENT-RESPONSE` を作る。
 * `payer` があれば**支払い側の署名者と同一**であること（Arc: authorization の `from`、Solana: transaction の authority = 2 番目の static account）。
 * それ以外は固定の分類（Provider は 502 で返し、Router は `unknown` にする）。
 */
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { getBase58Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";

import type { ProviderNetwork } from "./config.js";

export type ReceiptFailure = "settlement_pending" | "settle_failed" | "receipt_malformed";

export type ReceiptCheck =
  | { readonly ok: true; readonly header: string; readonly transaction: string }
  | { readonly ok: false; readonly reason: ReceiptFailure };

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function isBase58Bytes(value: string, length: number): boolean {
  if (!BASE58.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === length;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 支払い側の署名者（payload から）。読めなければ `undefined`（領収の `payer` があれば不一致として扱う）。 */
export function payerOfPayload(network: ProviderNetwork, payload: PaymentPayload): string | undefined {
  const inner = (payload as { payload?: unknown }).payload;
  if (!isRecord(inner)) return undefined;
  if (network === "arc") {
    const authorization = inner["authorization"];
    const from = isRecord(authorization) ? authorization["from"] : undefined;
    return typeof from === "string" && EVM_ADDRESS.test(from) ? from.toLowerCase() : undefined;
  }
  const transaction = inner["transaction"];
  if (typeof transaction !== "string") return undefined;
  try {
    const bytes = Uint8Array.from(atob(transaction), (c) => c.charCodeAt(0));
    const decoded = getTransactionDecoder().decode(bytes);
    const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    const authority = compiled.staticAccounts[1];
    return authority === undefined ? undefined : String(authority);
  } catch {
    return undefined;
  }
}

export function checkReceipt(network: ProviderNetwork, expectedNetwork: string, payload: PaymentPayload, response: unknown): ReceiptCheck {
  if (!isRecord(response)) return { ok: false, reason: "receipt_malformed" };
  if (response["success"] !== true) {
    return { ok: false, reason: response["errorReason"] === "settlement_pending" ? "settlement_pending" : "settle_failed" };
  }
  const transaction = response["transaction"];
  const net = response["network"];
  const payer = response["payer"];
  if (net !== expectedNetwork || typeof transaction !== "string") return { ok: false, reason: "receipt_malformed" };
  const transactionOk = network === "arc" ? BYTES32.test(transaction) : isBase58Bytes(transaction, 64);
  if (!transactionOk) return { ok: false, reason: "receipt_malformed" };
  if (payer !== undefined) {
    if (typeof payer !== "string") return { ok: false, reason: "receipt_malformed" };
    const signer = payerOfPayload(network, payload);
    const same = signer !== undefined && (network === "arc" ? EVM_ADDRESS.test(payer) && payer.toLowerCase() === signer : isBase58Bytes(payer, 32) && payer === signer);
    if (!same) return { ok: false, reason: "receipt_malformed" };
  }
  // 封筒は確かめた欄だけで作り直す（facilitator の余分な欄を透過しない）。
  const receipt = { success: true, transaction, network: expectedNetwork, ...(payer === undefined ? {} : { payer }) } as SettleResponse;
  return { ok: true, header: encodePaymentResponseHeader(receipt), transaction };
}
