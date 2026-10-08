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
 *
 * 事実（同日、pay-kit 0.13.1 の server を実測。`tests/unit/mpp-solana-fixtures.test.ts` の U-10 の送信の向き）: pay-kit の server の challenge には
 * `opaque`（server metadata）が**無い** = mppx の route scope `_mppx_scope` を持たない（pay-kit は mppx に scope を渡さない）。よって §4.2 の 1 行目の
 * scope は **あれば一致を要求し、無ければ通す**（Tempo の `viewOf` は scope 必須。ここが違う）。URL への束縛は、Router が guarded transport で
 * 取りに行った URL の 402 だけを読む（`terms` には meta を入れるので、scope のある Provider では承認値に含まれる）ことによる。
 */
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { Method } from "mppx";

import { stableJson } from "../../core/intent.js";
import type { DestinationOffer } from "../../ports/outbound.js";
import { isSvmPublicKeyString, isSvmSignatureString, MPP_SOLANA_INTENT, MPP_SOLANA_METHOD, MPP_SOLANA_NETWORK_LABELS, mppSolanaChargeMethod } from "../inbound/mpp-solana.js";
import { MEMO_PROGRAM_ADDRESS } from "../inbound/x402-svm.js";
import { challengeMetaOf, SCOPE_META_KEY } from "./mpp.js";
import { isValidSvmMemo, SYSTEM_PROGRAM_ADDRESS } from "./x402-svm.js";

import { MPP_SOLANA_SCHEME } from "../../config.js";
export { MPP_SOLANA_SCHEME };

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
  /** server metadata の `_mppx_scope`（`"GET <canonical url>"`）。pay-kit の server は持たない → `undefined`。 */
  readonly scope: string | undefined;
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
  // server metadata: **無いのは通す**（pay-kit の形）が、**あって読めない**（`opaque` が文字列でない・復号できない・`_mppx_scope` が文字列でない）のは読めない challenge。
  const opaque = challenge["opaque"];
  const meta = challengeMetaOf(challenge);
  if (opaque !== undefined && opaque !== "" && (typeof opaque !== "string" || meta === undefined)) return undefined;
  const rawScope = meta?.[SCOPE_META_KEY];
  if (rawScope !== undefined && typeof rawScope !== "string") return undefined;
  const scope = rawScope;
  const { amount, currency, recipient } = request;
  if (typeof amount !== "string" || typeof currency !== "string" || typeof recipient !== "string") return undefined;
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
  if (view.scope !== undefined && view.scope !== expectedScope) return "scope";
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
      ...(view.scope === undefined ? {} : { scope: view.scope }),
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

/* ──────────────────────────────────────────────────────────────────────────────
 * adapter（`docs/mpp-solana-design.md` §4.1・§4.3〜§4.6、要件 FR-51〜FR-54、SR-M3・SR-M4。タスク M4-b）
 *
 * pull だけ（D-23）: Router は payer として [1] に署名し、fee payer（[0] = challenge の `feePayerKey`）は空のまま credential に載せる。
 * 相手（pay-kit の server）が共同署名して送出する。Router に SOL は要らない。SDK（mppx client）には署名器も鍵も渡さない（SR-M3）:
 * `createCredential` の hook は **既に組んで検査した wire を返すだけ**。
 * ────────────────────────────────────────────────────────────────────────────── */

import { getBase58Decoder, getTransactionDecoder } from "@solana/kit";
import { Constants, Credential, Receipt } from "mppx";
import { Mppx as ClientMppx } from "mppx/client";

import type { DynamicProfile } from "../../config.js";
import { discardBody, type GuardedTransport, type TransportContext } from "../../net/guarded-fetch.js";
import { parseUpstreamUrl } from "../../net/upstream-url.js";
import type { OutboundRail, PayRequest, PayResult, SvmSigningCapability, UpstreamTarget } from "../../ports/outbound.js";
import { DynamicTargetUnsupportedError } from "../../ports/outbound.js";
import { SVM_TRANSACTION_MAX_BYTES } from "../inbound/x402-svm.js";
import { createSvmOutboundCommon, type SvmStaticDestination } from "./svm-outbound-common.js";
import { deliveredBodyOf, DynamicChallengeError } from "./x402-dynamic.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../net/bounded-body.js";
import {
  assembleSvmWire,
  checkSvmOutboundMessage,
  compileSvmMessage,
  messageHashOf,
  recheckSvmWire,
  SVM_OUTBOUND_FETCH_TO_SIGN_MS,
  SVM_OUTBOUND_RPC_TIMEOUT_MS,
  verifySvmSignature,
  type SvmExpected,
} from "./x402-svm.js";
import { SVM_DEFAULT_COMPUTE_UNITS, SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT } from "../inbound/x402-svm.js";

export interface MppSolanaOutboundOptions {
  readonly network: string;
  /** 静的 route → 上流 URL（起動時に固定。クエリ無しの GET 1 本）。 */
  readonly upstreams: Readonly<Record<string, string>>;
  /** 静的 route → 宛先（`payTo`・`asset`・`scheme = "solana/charge"`）。 */
  readonly destinations: Readonly<Record<string, SvmStaticDestination>>;
  readonly capability: SvmSigningCapability;
  /** 上流（静的）の transport。 */
  readonly transport: GuardedTransport;
  readonly rpc: { readonly url: string; readonly transport: GuardedTransport };
  /** 運用者の集合（可変。`startup()` が Router の ATA を足す）。 */
  readonly operatorAddresses: Set<string>;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  readonly dynamic?: {
    readonly profiles: Readonly<Record<string, DynamicProfile>>;
    readonly transport: GuardedTransport;
    readonly denyHosts: readonly string[];
  };
  readonly now?: () => number;
  /** 402 の読取の期限（既定 10 秒）。 */
  readonly unpaidTimeoutMs?: number;
  /** 有料要求の期限（既定 45 秒 = D-30。pay-kit の server の確定待ちを含む運用上の予算）。 */
  readonly paidTimeoutMs?: number;
  /** blockhash を取ってから署名するまでの上限（既定 5 秒）。 */
  readonly fetchToSignMs?: number;
  /** blockhash を取ってから送出するまでの上限（既定 10 秒。FR-52）。 */
  readonly sendWithinMs?: number;
  readonly rpcTimeoutMs?: number;
  /** 試験だけ（§4.6 の停止点・改変）。 */
  readonly hooksForTest?: {
    afterReserve?(): void;
    afterSign?(): void;
    beforeSend?(): void;
    wire?(bytes: Uint8Array): Uint8Array;
    /** hook が返す credential の改変（§4.6 (a): 返った credential の再検査が捕まえる）。 */
    credential?(wire: string): string;
  };
}

export type MppSolanaOutbound = OutboundRail & {
  startup(): Promise<void>;
  balanceOf(routeId: string, asset: string): Promise<bigint>;
};

export const MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS = 10_000;
export const MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS = 45_000;
export const MPP_SOLANA_OUTBOUND_SEND_WITHIN_MS = 10_000;
/** 動的の quote で確かめた宛先 ATA の存在を覚える時間（SR-M1: purchase の中の 402 の読み直しで存在を読み直さない。送る直前の再確認は別途、必ず読む）。 */
export const MPP_SOLANA_ATA_EXISTENCE_TTL_MS = 60_000;

class MppSolanaChallengeError extends Error {
  constructor(readonly reason: "url" | "status" | "unreadable") {
    super(`mpp solana outbound challenge rejected: ${reason}`);
    this.name = "MppSolanaChallengeError";
  }
}

interface PreparedChallenge {
  readonly challenge: unknown;
  readonly challenges: readonly unknown[];
  createCredential(): Promise<string>;
  setCredential(init: RequestInit, credential: string): RequestInit;
}

/** 領収の照合に要る、送出した取引の材料。 */
interface SentTransaction {
  readonly snapshot: Uint8Array;
  readonly signature: Uint8Array;
}

function base58Of(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes);
}

/** `pay` の中で hook に渡す状態: 選んだ challenge の id と、検査済みの wire。`used` で 1 回だけ。 */
export interface ChosenCredential {
  id?: string;
  wire?: Uint8Array;
  used: boolean;
}

/**
 * `createCredential` の hook（§4.6）: **検査済みの wire を返すだけ**。渡された challenge が選んだもの（`chosen.id`）でなければ throw、wire がまだ無ければ throw、
 * 2 回目は throw。SDK には署名器も鍵も渡さない（SR-M3）。純粋（試験は直接呼ぶ）。
 */
export function createCredentialHookOf(chosen: ChosenCredential): (args: { readonly challenge: unknown }) => Promise<string> {
  return async ({ challenge }) => {
    const id = isRecord(challenge) ? challenge["id"] : undefined;
    if (chosen.used || chosen.wire === undefined || chosen.id === undefined || id !== chosen.id) {
      throw new Error("mpp solana outbound: createCredential called for a different challenge, before the wire exists, or twice");
    }
    chosen.used = true;
    return Credential.serialize({ challenge, payload: { type: "transaction", transaction: Buffer.from(chosen.wire).toString("base64") } } as never);
  };
}

export function createMppSolanaOutbound(options: MppSolanaOutboundOptions): MppSolanaOutbound {
  const now = options.now ?? Date.now;
  const unpaidTimeoutMs = options.unpaidTimeoutMs ?? MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS;
  const paidTimeoutMs = options.paidTimeoutMs ?? MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS;
  const fetchToSignMs = options.fetchToSignMs ?? SVM_OUTBOUND_FETCH_TO_SIGN_MS;
  const sendWithinMs = options.sendWithinMs ?? MPP_SOLANA_OUTBOUND_SEND_WITHIN_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? SVM_OUTBOUND_RPC_TIMEOUT_MS;
  const hooks = options.hooksForTest ?? {};
  const capability = options.capability;
  const operators = options.operatorAddresses;
  if (capability.network !== options.network) throw new Error("mpp solana outbound: the signing capability is for a different network");
  if (!isSvmPublicKeyString(capability.address)) throw new Error("mpp solana outbound: the signing capability address is not a 32-byte base58 key");
  if (MPP_SOLANA_NETWORK_LABELS[options.network] === undefined) throw new Error("mpp solana outbound: the network is not in the table of MPP Solana networks");
  for (const [routeId, raw] of Object.entries(options.upstreams)) {
    const destination = options.destinations[routeId];
    if (destination === undefined) throw new Error("mpp solana outbound: every static route needs a destination");
    if (destination.scheme !== MPP_SOLANA_SCHEME || destination.asset !== options.mint) throw new Error(`routes.${routeId}: the destination must be solana/charge on this adapter's mint`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`x402.upstreams.${routeId} must be an absolute URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`x402.upstreams.${routeId} must use http(s)`);
    if (url.search !== "") throw new Error(`x402.upstreams.${routeId} must not carry a query`);
  }
  const dynamic = options.dynamic;
  if (dynamic !== undefined) {
    if (dynamic.transport.allowLoopback) throw new Error("the dynamic mpp solana path must not use a transport that allows loopback");
    if (!dynamic.transport.boundsDns) throw new Error("the dynamic mpp solana path requires a transport with a DNS deadline");
  }
  const profiles = new Map<string, DynamicProfile>();
  for (const [profileId, profile] of Object.entries(dynamic?.profiles ?? {})) {
    if (profile.rail !== "mpp" || profile.destination.network !== options.network) continue;
    if (profile.destination.scheme !== MPP_SOLANA_SCHEME || profile.destination.asset !== options.mint || profile.destination.decimals !== options.decimals) {
      throw new Error(`dynamic profile ${profileId} is not a solana/charge profile for this adapter's mint`);
    }
    if (profile.destination.tokenProgram !== undefined && profile.destination.tokenProgram !== options.tokenProgram) {
      throw new Error(`dynamic profile ${profileId} names a different token program`);
    }
    profiles.set(profileId, profile);
  }

  const common = createSvmOutboundCommon({
    label: "mpp solana outbound",
    rpc: options.rpc,
    rpcTimeoutMs,
    mint: options.mint,
    decimals: options.decimals,
    tokenProgram: options.tokenProgram,
    routerAddress: capability.address,
    operatorAddresses: operators,
    destinations: options.destinations,
    staticScheme: MPP_SOLANA_SCHEME,
  });
  const { ready, ataOf, rpcResult, ataExists, blockhashOf } = common;
  /** quote で読んだ宛先 ATA の存在（ATA → 期限）。`readChallenge` だけが使う（`pay` の 3 は常に読む）。 */
  const knownAtas = new Map<string, number>();
  async function ataExistsForQuote(ata: string, owner: string, operation: string, routeId: string): Promise<boolean> {
    const until = knownAtas.get(ata);
    if (until !== undefined && until > now()) return true;
    const exists = await ataExists(ata, owner, operation, routeId);
    if (exists) knownAtas.set(ata, now() + MPP_SOLANA_ATA_EXISTENCE_TTL_MS);
    return exists;
  }

  function policyOf(routeId: string): MppSolanaOutboundPolicy {
    const routerAta = ready();
    const profile = profiles.get(routeId);
    return {
      network: options.network,
      mint: options.mint,
      decimals: options.decimals,
      tokenProgram: options.tokenProgram,
      routerAddress: capability.address,
      routerAta,
      ...(profile === undefined ? {} : { maxUpstreamAmount: profile.maxUpstreamAmount }),
    };
  }

  function urlOf(routeId: string, target: UpstreamTarget | undefined): { url: string; transport: GuardedTransport } {
    if (target !== undefined) {
      if (dynamic === undefined) throw new DynamicTargetUnsupportedError();
      if (!profiles.has(routeId)) throw new Error("no dynamic mpp solana profile for route");
      if (!parseUpstreamUrl(target.url, { denyHosts: dynamic.denyHosts }).ok) throw new DynamicChallengeError("url");
      return { url: target.url, transport: dynamic.transport };
    }
    const url = options.upstreams[routeId];
    if (url === undefined) throw new Error("no mpp solana upstream for route");
    return { url, transport: options.transport };
  }

  /** mppx の client（要求ごと）。全要求（`rawFetch`）が guarded transport を通る。credential は hook が返す（§4.6）。 */
  function clientOf(transport: GuardedTransport, ctx: { routeId: string; operation: string }, createCredential: (args: { readonly challenge: unknown }) => Promise<string>) {
    return ClientMppx.create({
      methods: [mppSolanaClientMethodOf(createCredential)],
      fetch: ((url: string | URL | Request, init?: RequestInit) => transport.fetch(url instanceof Request ? url.url : url, init, ctx as TransportContext)) as typeof globalThis.fetch,
      polyfill: false,
      maxPaymentRetries: 0,
    } as never) as unknown as { rawFetch: typeof globalThis.fetch; preparePayment(response: Response, options: { request: RequestInit }): Promise<PreparedChallenge> };
  }

  const baseInit = (): RequestInit => ({ method: "GET", redirect: "error", signal: AbortSignal.timeout(unpaidTimeoutMs) });

  /** 402 を読んで SDK に解析させる（本文は捨てる）。 */
  async function prepare(client: ReturnType<typeof clientOf>, url: string): Promise<PreparedChallenge> {
    const init = baseInit();
    let response: Response;
    try {
      response = await client.rawFetch(url, init);
    } catch {
      throw new MppSolanaChallengeError("unreadable");
    }
    const discard = (): void => discardBody(response);
    if (response.status !== 402) {
      discard();
      throw new MppSolanaChallengeError("status");
    }
    try {
      return await client.preparePayment(response, { request: init });
    } catch {
      throw new MppSolanaChallengeError("unreadable");
    } finally {
      discard();
    }
  }

  /** 静的の destination との照合（payTo・asset・scheme の完全一致）。 */
  function matchesStatic(routeId: string, offer: DestinationOffer): boolean {
    const destination = options.destinations[routeId];
    return destination !== undefined && offer.payTo === destination.payTo && offer.asset === destination.asset && offer.scheme === destination.scheme;
  }

  /**
   * 候補の検査（§4.2 の 9 行 → 静的の照合 → ATA の不等式 → `checkExistence` なら動的は ATA の存在）。通れば宛先 ATA。
   */
  async function candidateAtaOf(routeId: string, view: MppSolanaChallengeView, expectedScope: string, operation: string, checkExistence: boolean): Promise<string | undefined> {
    const policy = policyOf(routeId);
    if (checkMppSolanaChallenge(view, expectedScope, policy, operators, now()) !== undefined) return undefined;
    const offer = mppSolanaOfferOf(view, policy);
    const isStatic = options.upstreams[routeId] !== undefined;
    if (isStatic) {
      if (!matchesStatic(routeId, offer)) return undefined;
      const ata = common.staticAtaOf(routeId);
      if (ata === undefined) return undefined;
      return checkMppSolanaChallengeAtas(view, policy, ata) === undefined ? ata : undefined;
    }
    let ata: string;
    try {
      ata = await ataOf(offer.payTo);
    } catch {
      return undefined;
    }
    if (checkMppSolanaChallengeAtas(view, policy, ata) !== undefined) return undefined;
    if (checkExistence && !(await ataExistsForQuote(ata, offer.payTo, operation, routeId))) return undefined;
    return ata;
  }

  /** 保存した offer（承認値）の再検査（§4.3 の 1）: 同じ 9 行を offer の欄に掛ける（challenge から復元した view で）。 */
  function viewOfApproved(approved: DestinationOffer): MppSolanaChallengeView | undefined {
    const extra = approved.extra ?? {};
    const terms = extra["terms"];
    const realm = extra["realm"];
    const feePayerKey = extra["feePayerKey"];
    const externalId = extra["externalId"];
    const scope = extra["scope"];
    if (typeof terms !== "string" || typeof realm !== "string" || typeof feePayerKey !== "string") return undefined;
    if (approved.scheme !== MPP_SOLANA_SCHEME || approved.network !== options.network) return undefined;
    if (scope !== undefined && typeof scope !== "string") return undefined;
    const request: Record<string, unknown> = {
      amount: approved.amount,
      currency: approved.asset,
      recipient: approved.payTo,
      ...(externalId === undefined ? {} : { externalId }),
      methodDetails: { network: MPP_SOLANA_NETWORK_LABELS[options.network], decimals: extra["decimals"], tokenProgram: extra["tokenProgram"], feePayer: true, feePayerKey },
    };
    return { id: "-", realm, method: MPP_SOLANA_METHOD, intent: MPP_SOLANA_INTENT, scope: scope as string | undefined, request, amount: approved.amount, currency: approved.asset, recipient: approved.payTo, expiresAt: undefined, terms };
  }

  /** 領収の照合（§4.4）: `Payment-Receipt` を公式 decoder で読み、challenge と取引に束縛する。RPC は `getTransaction` 1 回。 */
  async function receiptOk(header: string | null, viewId: string, approved: DestinationOffer, sent: SentTransaction, routeId: string): Promise<{ readonly ok: true; readonly reference: string } | { readonly ok: false }> {
    if (header === null || header === "") return { ok: false };
    let receipt: Record<string, unknown>;
    try {
      receipt = Receipt.deserialize(header) as unknown as Record<string, unknown>;
    } catch {
      return { ok: false };
    }
    if (!isRecord(receipt) || receipt["status"] !== "success" || receipt["method"] !== MPP_SOLANA_METHOD) return { ok: false };
    const reference = receipt["reference"];
    if (typeof reference !== "string" || !isSvmSignatureString(reference)) return { ok: false };
    // **今回の支払い**への束縛（FR-53）: challengeId は必須で選んだ challenge の id と一致。externalId・payer 相当の欄があれば一致。
    if (receipt["challengeId"] !== viewId) return { ok: false };
    const approvedExternalId = approved.extra?.["externalId"];
    if (Object.hasOwn(receipt, "externalId") && receipt["externalId"] !== approvedExternalId) return { ok: false };
    for (const key of ["payer", "signer", "from"]) {
      if (Object.hasOwn(receipt, key) && receipt[key] !== capability.address) return { ok: false };
    }
    // pull の対応づけ: chain 上の取引が、予約した message と Router の署名を持ち、[0] が reference で、成功していること。
    let reply: Record<string, unknown> | undefined;
    try {
      reply = await rpcResult("getTransaction", [reference, { commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0 }], "mpp_solana_receipt", routeId);
    } catch {
      return { ok: false };
    }
    const result = reply?.["result"];
    if (!isRecord(result)) return { ok: false };
    const transaction = result["transaction"];
    const meta = result["meta"];
    const slot = result["slot"];
    if (!Array.isArray(transaction) || typeof transaction[0] !== "string" || transaction[1] !== "base64") return { ok: false };
    if (!isRecord(meta) || meta["err"] !== null) return { ok: false };
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) return { ok: false };
    const bytes = Buffer.from(transaction[0], "base64");
    if (bytes.length === 0 || bytes.length > SVM_TRANSACTION_MAX_BYTES) return { ok: false };
    let decoded;
    try {
      decoded = getTransactionDecoder().decode(new Uint8Array(bytes));
    } catch {
      return { ok: false };
    }
    const message = new Uint8Array(decoded.messageBytes);
    if (message.length !== sent.snapshot.length || Buffer.compare(Buffer.from(message), Buffer.from(sent.snapshot)) !== 0) return { ok: false };
    if (bytes[0] !== 2 || bytes.length < 1 + 128) return { ok: false };
    const sig0 = bytes.subarray(1, 65);
    const sig1 = bytes.subarray(65, 129);
    if (sig0.every((byte) => byte === 0) || base58Of(new Uint8Array(sig0)) !== reference) return { ok: false };
    if (Buffer.compare(Buffer.from(sig1), Buffer.from(sent.signature)) !== 0) return { ok: false };
    return { ok: true, reference };
  }

  return {
    startup: () => common.startup(),
    balanceOf: (routeId, asset) => common.balanceOf(routeId, asset),

    /** 上流の現在の challenge を読む（純粋読取・無課金・credential を作らない）。SDK が返す候補のうち §4.2 を通るものを offer に。 */
    async readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
      ready();
      const { url, transport } = urlOf(routeId, target);
      const ctx = { routeId, operation: "read_challenge" };
      const client = clientOf(transport, ctx, async () => {
        throw new Error("mpp solana outbound: readChallenge never creates a credential");
      });
      const prepared = await prepare(client, url);
      const offers: DestinationOffer[] = [];
      for (const raw of prepared.challenges) {
        const view = mppSolanaViewOf(raw);
        if (view === undefined) continue;
        // 動的の quote は宛先 ATA の存在も見る（静的は起動時に検査済み）。
        const ata = await candidateAtaOf(routeId, view, `GET ${url}`, "mpp_solana_ata", target !== undefined).catch(() => undefined);
        if (ata === undefined) continue;
        offers.push(mppSolanaOfferOf(view, policyOf(routeId)));
      }
      return offers;
    },

    async pay(request: PayRequest): Promise<PayResult> {
      const routerAtaNow = ready();
      const routeId = request.routeId;
      const approved = request.offer;
      const approvedJson = stableJson(approved);
      const notSent = (reason: string): PayResult => ({ outcome: "not_sent", reason });

      // 1. 能力の network、保存した offer の再検査、期限、予約の口。
      if (capability.network !== approved.network || approved.network !== options.network) return notSent("destination_signer_network_mismatch");
      const approvedView = viewOfApproved(approved);
      if (approvedView === undefined) return notSent("destination_offer_not_allowed");
      let endpoint: { url: string; transport: GuardedTransport };
      try {
        endpoint = urlOf(routeId, request.target);
      } catch (error) {
        if (error instanceof DynamicTargetUnsupportedError) throw error;
        return notSent("destination_offer_not_allowed");
      }
      const expectedScope = `GET ${endpoint.url}`;
      const destinationAta = await candidateAtaOf(routeId, approvedView, expectedScope, "mpp_solana_ata", false).catch(() => undefined);
      if (destinationAta === undefined) return notSent("destination_offer_not_allowed");
      if (!(now() < request.deadlineMs)) return notSent("destination_deadline");
      if (request.reserveMessage === undefined) return notSent("destination_reservation_unsupported");

      // 2. 読み直し: SDK が選んだ challenge の view が、terms と offer で承認値と完全一致すること。
      const ctx = { routeId, operation: "pay_challenge" };
      const chosen: ChosenCredential = { used: false };
      const client = clientOf(endpoint.transport, ctx, createCredentialHookOf(chosen));
      let prepared: PreparedChallenge;
      try {
        prepared = await prepare(client, endpoint.url);
      } catch {
        return notSent("destination_challenge_unreadable");
      }
      const view = mppSolanaViewOf(prepared.challenge);
      if (view === undefined) return notSent("destination_challenge_unreadable");
      if (view.expiresAt !== undefined && !(view.expiresAt > now())) return notSent("destination_offer_expired");
      if (checkMppSolanaChallenge(view, expectedScope, policyOf(routeId), operators, now()) !== undefined) return notSent("destination_offer_changed");
      if (view.terms !== approvedView.terms || stableJson(mppSolanaOfferOf(view, policyOf(routeId))) !== approvedJson) return notSent("destination_offer_changed");
      chosen.id = view.id;

      // 3. 宛先 ATA の再確認（送る直前にもう一度）。
      if (!(await ataExists(destinationAta, approved.payTo, "mpp_solana_ata", routeId))) return notSent("destination_ata_missing");

      // 4. blockhash（challenge の recentBlockhash は使わない。D-24）。
      const lifetime = blockhashOf(await rpcResult("getLatestBlockhash", [{ commitment: "confirmed" }], "mpp_solana_blockhash", routeId));
      if (lifetime === undefined) return notSent("destination_blockhash_unavailable");
      const fetchedAt = now();

      // 5. 期待値（原始値だけ）。Memo は challenge の externalId があるときだけ。
      const feePayerKey = approved.extra?.["feePayerKey"];
      const externalId = approved.extra?.["externalId"];
      if (typeof feePayerKey !== "string" || !isSvmPublicKeyString(feePayerKey)) return notSent("destination_offer_not_allowed");
      if (externalId !== undefined && !isValidSvmMemo(externalId)) return notSent("destination_memo_invalid");
      const expected: SvmExpected = Object.freeze({
        feePayer: feePayerKey,
        source: routerAtaNow,
        authority: capability.address,
        destination: destinationAta,
        mint: options.mint,
        amount: BigInt(approved.amount),
        decimals: options.decimals,
        memo: externalId as string | undefined,
        units: SVM_DEFAULT_COMPUTE_UNITS,
        microLamports: SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT,
        blockhash: lifetime.blockhash,
        lastValidBlockHeight: lifetime.lastValidBlockHeight,
        tokenProgram: options.tokenProgram,
      });

      // 6. 組み立て（snapshot）。7. 署名前の検査（builder と独立）。
      let snapshot: Uint8Array;
      try {
        snapshot = compileSvmMessage(expected);
      } catch {
        return notSent("destination_message_mismatch");
      }
      if (!checkSvmOutboundMessage(snapshot, expected).ok) return notSent("destination_message_mismatch");

      // 8. hash の予約（署名の前。同じ message には二度と署名しない）。
      const reservation = await request.reserveMessage(messageHashOf(snapshot)).catch(() => "unavailable" as const);
      if (reservation === "collision") return notSent("destination_message_collision");
      if (reservation !== "reserved") return notSent("destination_message_record_unavailable");
      hooks.afterReserve?.();

      // 9. 期限（承認の期限と **challenge の期限**。FR-53）と blockhash の鮮度（署名の直前）。
      if (!(now() < request.deadlineMs)) return notSent("destination_deadline");
      if (view.expiresAt !== undefined && !(view.expiresAt > now())) return notSent("destination_offer_expired");
      if (now() - fetchedAt > fetchToSignMs) return notSent("destination_blockhash_stale");

      // 10. 署名（写しを渡し、写しを保つ）と検証。
      let signature: Uint8Array;
      try {
        signature = Uint8Array.from(capability.sign(Uint8Array.from(snapshot)));
      } catch {
        return notSent("destination_not_signed");
      }
      if (!verifySvmSignature(signature, snapshot, capability.address)) return notSent("destination_not_signed");
      hooks.afterSign?.();

      // 11. wire（[0] 空 = fee payer、[1] Router）と再検査（snapshot との一致 + 受信の検査）。
      let wire = assembleSvmWire(snapshot, expected, signature);
      if (hooks.wire !== undefined) wire = hooks.wire(wire);
      if (!recheckSvmWire(wire, snapshot, signature, expected, approved.payTo).ok) return notSent("destination_payload_mismatch");
      chosen.wire = wire;

      // 12. credential（hook は検査済みの wire を返すだけ）→ 返った文字列の再検査 → 送出の直前の期限と blockhash の経過時間。
      let credential: string;
      try {
        credential = await prepared.createCredential();
      } catch {
        return notSent("destination_payload_mismatch");
      }
      if (hooks.credential !== undefined) credential = hooks.credential(credential);
      try {
        const decoded = Credential.deserialize(credential) as unknown as { challenge?: { id?: unknown }; payload?: { type?: unknown; transaction?: unknown } };
        const transaction = decoded.payload?.transaction;
        if (decoded.challenge?.id !== view.id || decoded.payload?.type !== "transaction" || typeof transaction !== "string") return notSent("destination_payload_mismatch");
        const bytes = Buffer.from(transaction, "base64");
        if (bytes.toString("base64") !== transaction || Buffer.compare(bytes, Buffer.from(wire)) !== 0) return notSent("destination_payload_mismatch");
      } catch {
        return notSent("destination_payload_mismatch");
      }
      if (!(now() < request.deadlineMs)) return notSent("destination_deadline");
      if (view.expiresAt !== undefined && !(view.expiresAt > now())) return notSent("destination_offer_expired");
      if (now() - fetchedAt > sendWithinMs) return notSent("destination_blockhash_stale");
      hooks.beforeSend?.();

      // 13. 送出（1 回だけ。45 秒）。署名だけでは資金は動かない: ここから先の失敗は `unknown`。
      const payCtx = { routeId, operation: "pay" };
      ctx.operation = "pay";
      let response: Response;
      try {
        const paidInit = prepared.setCredential({ method: "GET" }, credential);
        response = await endpoint.transport.fetch(endpoint.url, { ...paidInit, method: "GET", redirect: "error", signal: AbortSignal.timeout(paidTimeoutMs) }, payCtx as TransportContext);
      } catch {
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      // 14. 領収（§4.4）。
      const header = response.headers.get(Constants.Headers.paymentReceipt);
      const receipt = await receiptOk(header, view.id, approved, { snapshot, signature }, routeId);
      if (response.status === 200) {
        if (!receipt.ok) {
          discardBody(response);
          return { outcome: "unknown", reason: "destination_receipt_unverified" };
        }
        return deliveredBodyOf(response, { header: header!, transaction: receipt.reference }, { maxBodyBytes: DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes, report: (error, c) => endpoint.transport.report(error, c), ctx: payCtx });
      }
      discardBody(response);
      if (receipt.ok) return { outcome: "paid_no_data", reason: "paid_data_unavailable", receiptRef: header! };
      // 領収の無い 4xx／5xx: 相手が共同署名して送出したかもしれない。
      return { outcome: "unknown", reason: "destination_pay_unknown" };
    },
  };
}
