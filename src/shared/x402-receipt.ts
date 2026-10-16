/**
 * x402 の送信の領収（`PAYMENT-RESPONSE`）の形と、診断の分類（設計 `docs/rejection-reasons-design.md` §4.3、§12.2・§13.1・§15.1 が優先。タスク R-4）。
 *
 * - `ReceiptForm`・`EVM_RECEIPT_FORM`・`SVM_RECEIPT_FORM` は送信の設計 §5 の領収の形（`src/adapters/outbound/x402-dynamic.ts` が再び export し、
 *   判断の `receiptOf` が使う。ここに置くのは、診断の後回しの処理（`buildDiagRecord`）が adapter を import せずに同じ形で分類できるようにするため）。
 * - `receiptClassOfHeader` は `receiptOf` と **同じ decoder（`decodePaymentResponseHeader`）・同じ順** で 7 つの分類にする。
 *   不変条件（試験で固定）: `ok` ⇔ `receiptOf` が `settled`、`payer_mismatch` ⇔ `payer_mismatch`、それ以外の 5 つ ⇔ `none`。
 * - **判断の経路では呼ばない**: hook はヘッダの文字列を写すだけで、decode・分類は後回しの処理でする（§13.1）。
 *
 * 純粋（I/O なし）。
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { getBase58Encoder } from "@solana/kit";

/** 領収の形（送信の設計 §5）。EVM は bytes32 の tx hash と `0x` のアドレス、SVM は base58 の 64 バイトの署名と base58 のアドレス。 */
export interface ReceiptForm {
  readonly transactionPattern: RegExp;
  /** SVM: `transaction` を base58 で復号したときのバイト数（署名は 64）。EVM は無し（bytes32 は pattern で決まる）。 */
  readonly transactionBytes?: number;
  readonly payerForm: "evm" | "svm";
  readonly signerAddress: string;
}

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SVM_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SVM_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** EVM の領収の形（bytes32 の tx hash）。 */
export const EVM_RECEIPT_FORM = (signerAddress: string): ReceiptForm => ({ transactionPattern: BYTES32_PATTERN, payerForm: "evm", signerAddress });
/** SVM の領収の形（base58 で 64 バイトに復号できる署名。`payer` は base58 32 バイトの公開鍵）。 */
export const SVM_RECEIPT_FORM = (signerAddress: string): ReceiptForm => ({ transactionPattern: SVM_SIGNATURE_PATTERN, transactionBytes: 64, payerForm: "svm", signerAddress });

/** 診断の後回しの処理が、写した `payerForm` と署名者から形を作り直す（上の 2 つと同じ値）。 */
export function receiptFormOf(payerForm: unknown, signerAddress: unknown): ReceiptForm | undefined {
  if (typeof signerAddress !== "string") return undefined;
  if (payerForm === "evm") return EVM_RECEIPT_FORM(signerAddress);
  if (payerForm === "svm") return SVM_RECEIPT_FORM(signerAddress);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** base58 を復号したバイト数（復号できなければ `undefined`）。 */
export function base58ByteLength(text: string): number | undefined {
  try {
    return getBase58Encoder().encode(text).length;
  } catch {
    return undefined;
  }
}

/** 領収の 7 分類（§3 の `receipt`）。 */
export type ReceiptClass = "absent" | "malformed" | "failed" | "network_mismatch" | "tx_malformed" | "payer_mismatch" | "ok";

export interface ReceiptClassResult {
  readonly receipt: ReceiptClass;
  /** `failed` のときだけ: 領収の `errorReason` の生の値（欄が無ければ `undefined`）。分類は理由の表で（`classifyReason`）。 */
  readonly errorReason?: unknown;
}

/**
 * 領収のヘッダの文字列（`PAYMENT-RESPONSE` → `X-PAYMENT-RESPONSE` の順に選んだもの。無ければ `null`）を 7 つに分ける。
 * 順と decoder は `receiptOf` と同じ: 無し・空 → `absent`、decode できない・object でない → `malformed`、`success !== true` → `failed`、
 * network 違い → `network_mismatch`、`transaction` の形違い → `tx_malformed`、`payer` 違い → `payer_mismatch`、それ以外 → `ok`。
 */
export function receiptClassOfHeader(header: string | null, network: string, form: ReceiptForm): ReceiptClassResult {
  if (header === null || header === "") return { receipt: "absent" };
  let decoded: unknown;
  try {
    decoded = decodePaymentResponseHeader(header);
  } catch {
    return { receipt: "malformed" };
  }
  if (!isRecord(decoded)) return { receipt: "malformed" };
  if (decoded["success"] !== true) return { receipt: "failed", errorReason: decoded["errorReason"] };
  if (decoded["network"] !== network) return { receipt: "network_mismatch" };
  const transaction = decoded["transaction"];
  if (typeof transaction !== "string" || !form.transactionPattern.test(transaction)) return { receipt: "tx_malformed" };
  if (form.transactionBytes !== undefined && base58ByteLength(transaction) !== form.transactionBytes) return { receipt: "tx_malformed" };
  const payer = decoded["payer"];
  if (payer !== undefined) {
    const matches =
      typeof payer === "string" &&
      (form.payerForm === "evm"
        ? ADDRESS_PATTERN.test(payer) && payer.toLowerCase() === form.signerAddress.toLowerCase()
        : SVM_ADDRESS_PATTERN.test(payer) && base58ByteLength(payer) === 32 && payer === form.signerAddress);
    if (!matches) return { receipt: "payer_mismatch" };
  }
  return { receipt: "ok" };
}

/** `PAYMENT-REQUIRED` の `error`（§12.2: 402 以外の状態でも見る）。decode は SDK の decoder（動的の challenge の読み取りと同じ）。 */
export type PaymentRequiredError = { readonly kind: "malformed" } | { readonly kind: "decoded"; readonly present: boolean; readonly value: unknown };

export function paymentRequiredErrorOf(header: string): PaymentRequiredError {
  let raw: unknown;
  try {
    raw = decodePaymentRequiredHeader(header);
  } catch {
    return { kind: "malformed" };
  }
  if (!isRecord(raw)) return { kind: "malformed" };
  return Object.prototype.hasOwnProperty.call(raw, "error") ? { kind: "decoded", present: true, value: raw["error"] } : { kind: "decoded", present: false, value: undefined };
}
