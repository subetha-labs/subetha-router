/**
 * 送信レール **MPP の Solana charge**（S-6。`docs/mpp-solana-design.md` §4、要件 FR-50〜FR-54、SR-M3・SR-M4）。
 *
 * このファイルの**純粋な部分**（タスク M4-a）: 402 の challenge の view、候補の検査（§4.2 の 9 行）、`terms`・offer の形、
 * client 側の method（`Method.toClient`）。adapter 本体（`createMppSolanaOutbound`）はタスク M4-b で同じファイルに足す。
 *
 * 事実（2026-10-08、`mppx` 0.11.0 の client を実測）: `preparePayment` は challenge の `request` を schema で parse **しない**
 * （未知の鍵も `prepared.challenge.request` にそのまま残る。`client/Mppx.js:71-130`）。よって view は SDK が選んだ challenge から
 * 取ってよく、§4.2 の 2 行目（未知の鍵は候補外）は view の生の `request` を見て判定できる。schema は受信と同じ `mppSolanaChargeMethod`
 * （`externalId` 必須の形）だが、client 側では parse されないので `externalId` の無い Provider の challenge も読める。
 */
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { Method } from "mppx";

import { stableJson } from "../../core/intent.js";
import type { DestinationOffer } from "../../ports/outbound.js";
import { isSvmPublicKeyString, MPP_SOLANA_INTENT, MPP_SOLANA_METHOD, MPP_SOLANA_NETWORK_LABELS, mppSolanaChargeMethod } from "../inbound/mpp-solana.js";
import { MEMO_PROGRAM_ADDRESS } from "../inbound/x402-svm.js";
import { challengeMetaOf, SCOPE_META_KEY } from "./mpp.js";
import { isValidSvmMemo, SYSTEM_PROGRAM_ADDRESS } from "./x402-svm.js";

export { MPP_SOLANA_SCHEME } from "../../config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/;
/** `request` に許す鍵（§4.2 の 2）。`splits`・`confidential`・その他は候補外。 */
const REQUEST_KEYS = new Set<string>(["amount", "currency", "recipient", "methodDetails", "externalId", "description"]);
/** `methodDetails` に許す鍵（§4.2 の 2）。 */
const DETAIL_KEYS = new Set<string>(["network", "decimals", "tokenProgram", "feePayer", "feePayerKey", "recentBlockhash"]);

/** 402 の challenge の view（Tempo の `viewOf` と同じ考え: `id`・`expires` は view に持ち、`terms` と offer には入れない）。 */
export interface MppSolanaChallengeView {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  /** server metadata の `_mppx_scope`（`"GET <canonical url>"`）。 */
  readonly scope: string;
  /** 生の `request`（鍵の検査に使う。値の検査は `checkMppSolanaChallenge`）。 */
  readonly request: Readonly<Record<string, unknown>>;
  readonly amount: string;
  readonly currency: string;
  readonly recipient: string;
  readonly expiresAt: number | undefined;
  /** `stableJson({ realm, method, intent, request, meta })`。発行ごとに変わる `id`・`expires`・`digest`・`opaque` は含まない。 */
  readonly terms: string;
}

/** challenge（SDK が選んだもの、または wire から復号したもの）を view に。形が読めなければ `undefined`。 */
export function mppSolanaViewOf(challenge: unknown): MppSolanaChallengeView | undefined {
  if (!isRecord(challenge)) return undefined;
  const { id, realm, method, intent, request, expires } = challenge;
  if (typeof id !== "string" || id === "" || typeof realm !== "string" || typeof method !== "string" || typeof intent !== "string" || !isRecord(request)) return undefined;
  const meta = challengeMetaOf(challenge);
  const scope = meta?.[SCOPE_META_KEY];
  const { amount, currency, recipient } = request;
  if (typeof scope !== "string" || typeof amount !== "string" || typeof currency !== "string" || typeof recipient !== "string") return undefined;
  let expiresAt: number | undefined;
  if (expires !== undefined) {
    // `expires` があるのに読めない → 期限不明として `expired` に倒す（検査の 9 行目）。NaN で表す。
    expiresAt = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
  }
  return { id, realm, method, intent, scope, request, amount, currency, recipient, expiresAt, terms: stableJson({ realm, method, intent, request, meta: meta ?? null }) };
}

/** この adapter（1 つの network・1 つの mint）の固定値。`routerAta` は startup で導く。 */
export interface MppSolanaOutboundPolicy {
  /** CAIP-2（表の network。challenge の `methodDetails.network` はその label = "devnet"）。 */
  readonly network: string;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  readonly routerAddress: string;
  readonly routerAta: string;
  /** 動的のときだけ（静的は承認済み offer の額をそのまま）。 */
  readonly maxUpstreamAmount?: string;
}

export type MppSolanaChallengeRejection =
  | "method"
  | "scope"
  | "unknown_field"
  | "field_type"
  | "asset"
  | "network"
  | "decimals"
  | "token_program"
  | "amount"
  | "amount_over_limit"
  | "pay_to"
  | "mode"
  | "fee_payer"
  | "memo"
  | "blockhash"
  | "expired";

/** `feePayerKey` が決して取ってはいけない固定の口座（SR-M4 = FR-35 の除外をすべて）。`recipient`・宛先 ATA は呼び出し側で足す。 */
export function mppSolanaReservedAddressesOf(policy: Pick<MppSolanaOutboundPolicy, "routerAddress" | "routerAta" | "mint" | "tokenProgram">): readonly string[] {
  return [policy.routerAddress, policy.routerAta, policy.mint, policy.tokenProgram, SYSTEM_PROGRAM_ADDRESS, String(COMPUTE_BUDGET_PROGRAM_ADDRESS), String(MEMO_PROGRAM_ADDRESS), String(ASSOCIATED_TOKEN_PROGRAM_ADDRESS)];
}

/**
 * 候補の検査（設計 §4.2 の 9 行、FR-50・SR-M4）。純粋・同期。通れば `undefined`。
 * ATA を要する不等式（`recipient` の ATA ≠ Router の ATA、`feePayerKey` ≠ 宛先 ATA）は `checkMppSolanaChallengeAtas`。
 * `expectedScope` は `"GET <canonical url>"`、`operatorAddresses` は運用者の集合（FR-38。SVM の文字列はそのまま比較）。
 */
export function checkMppSolanaChallenge(view: MppSolanaChallengeView, expectedScope: string, policy: MppSolanaOutboundPolicy, operatorAddresses: ReadonlySet<string> | readonly string[], nowMs: number): MppSolanaChallengeRejection | undefined {
  const operators = operatorAddresses instanceof Set ? operatorAddresses : new Set(operatorAddresses);
  // 1
  if (view.method !== MPP_SOLANA_METHOD || view.intent !== MPP_SOLANA_INTENT) return "method";
  if (view.scope !== expectedScope) return "scope";
  // 2
  for (const key of Object.keys(view.request)) if (!REQUEST_KEYS.has(key)) return "unknown_field";
  const details = view.request["methodDetails"];
  if (!isRecord(details)) return "unknown_field";
  for (const key of Object.keys(details)) if (!DETAIL_KEYS.has(key)) return "unknown_field";
  // 3
  if (view.currency !== policy.mint) return "asset";
  if (details["network"] !== MPP_SOLANA_NETWORK_LABELS[policy.network]) return "network";
  if (details["decimals"] !== policy.decimals) return "decimals";
  if (Object.hasOwn(details, "tokenProgram") && details["tokenProgram"] !== policy.tokenProgram) return "token_program";
  // 4
  if (!AMOUNT_PATTERN.test(view.amount) || view.amount === "0") return "amount";
  if (policy.maxUpstreamAmount !== undefined && BigInt(view.amount) > BigInt(policy.maxUpstreamAmount)) return "amount_over_limit";
  // 5（宛先 ATA ≠ Router の ATA は ATA の検査で）
  const recipient = view.recipient;
  if (!isSvmPublicKeyString(recipient) || operators.has(recipient) || mppSolanaReservedAddressesOf(policy).includes(recipient)) return "pay_to";
  // 6（pull だけ。D-23）
  const feePayer = details["feePayer"];
  const feePayerKey = details["feePayerKey"];
  if (feePayer !== true) return "mode";
  if (!isSvmPublicKeyString(feePayerKey) || operators.has(feePayerKey) || feePayerKey === recipient || mppSolanaReservedAddressesOf(policy).includes(feePayerKey)) return "fee_payer";
  // 7
  if (Object.hasOwn(view.request, "externalId") && !isValidSvmMemo(view.request["externalId"])) return "memo";
  if (Object.hasOwn(view.request, "description") && typeof view.request["description"] !== "string") return "field_type";
  // 8（読むが使わない。D-24）
  if (Object.hasOwn(details, "recentBlockhash") && !isSvmPublicKeyString(details["recentBlockhash"])) return "blockhash";
  // 9
  if (view.expiresAt !== undefined && !(view.expiresAt > nowMs)) return "expired";
  return undefined;
}

/** ATA を要する不等式（§4.2 の 5・6、SR-M4）: 宛先 ATA ≠ Router の ATA、`feePayerKey` ≠ 宛先 ATA。 */
export function checkMppSolanaChallengeAtas(view: MppSolanaChallengeView, policy: Pick<MppSolanaOutboundPolicy, "routerAta">, destinationAta: string): MppSolanaChallengeRejection | undefined {
  if (destinationAta === policy.routerAta) return "pay_to";
  const details = view.request["methodDetails"];
  if (isRecord(details) && details["feePayerKey"] === destinationAta) return "fee_payer";
  return undefined;
}

/**
 * core の allowlist 照合に渡す形（§4.2）。`terms` に条件全文を畳み込む。`id`・`expires` を含まないので、Provider が要求ごとに
 * 新しい challenge を出しても承認値は変わらない。検査（`checkMppSolanaChallenge`）を通った view にだけ使う。
 */
export function mppSolanaOfferOf(view: MppSolanaChallengeView, policy: Pick<MppSolanaOutboundPolicy, "network" | "decimals" | "tokenProgram">): DestinationOffer {
  const details = view.request["methodDetails"];
  const feePayerKey = isRecord(details) ? details["feePayerKey"] : undefined;
  const externalId = view.request["externalId"];
  return {
    scheme: `${view.method}/${view.intent}`,
    network: policy.network,
    asset: view.currency,
    amount: view.amount,
    payTo: view.recipient,
    extra: {
      realm: view.realm,
      scope: view.scope,
      terms: view.terms,
      feePayerKey: typeof feePayerKey === "string" ? feePayerKey : "",
      decimals: policy.decimals,
      tokenProgram: policy.tokenProgram,
      ...(typeof externalId === "string" ? { externalId } : {}),
    },
  };
}

export function mppSolanaOfferTermsOf(offer: DestinationOffer): string | undefined {
  const terms = offer.extra?.["terms"];
  return typeof terms === "string" ? terms : undefined;
}

/** client 側の method（`Method.toClient`）。credential は hook が返す（§4.3 の 12: hook は challenge の id を確かめ、wire を serialize して返す）。 */
export function mppSolanaClientMethodOf(createCredential: (args: { readonly challenge: unknown }) => Promise<string>): ReturnType<typeof Method.toClient<typeof mppSolanaChargeMethod, undefined>> {
  return Method.toClient(mppSolanaChargeMethod, { createCredential: createCredential as never });
}
