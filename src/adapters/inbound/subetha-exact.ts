/**
 * 受信レール `subetha-exact`: Router が SubEtha v2 multi-tenant facilitator の **Provider**（tenant）として、注文ごとの burn address への標準の x402 `exact`
 * （EIP-3009）の支払いを受ける（`docs/subetha-exact-inbound-design.md` §3、要件 FR-2〜FR-9）。
 *
 * - 鍵・署名の能力は持たない（受信側）。手元の署名の検査は viem の `recoverTypedDataAddress`（純粋、RPC 無し）。
 * - facilitator への呼び出しは `createOffer`（作成）・`verify`（公開）・`settle`（bind と reconcile）・`release`・`complete` と、読み取りの GET（復元・requester の照会）だけ。
 * - `settle` は SubEtha に送信を頼まない（`docs/subetha-exact-provider-settle-design.md`）: 注文を bind し、`bound` のときだけ Router の選んだ x402 facilitator に
 *   authorization を**最大 1 回**送り（Provider token は付けない）、結果は SubEtha の reconcile だけで決める。
 * - 例外の契約（§3.9）: `createOffer` は `InboundOfferError` だけを投げる。`verify`・`settle`・`release`・`complete` は投げない。
 * - token は閉包の中だけ。ledger・note・診断・例外の message に token・URL・credential・facilitator の自由な文を写さない。
 */
import { randomBytes } from "node:crypto";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";

import { readBoundedBody } from "../../net/bounded-body.js";
import type { GuardedTransport, TransportContext } from "../../net/guarded-fetch.js";
import {
  InboundOfferError,
  type CompleteResult,
  type CreateOfferRequest,
  type InboundCallContext,
  type InboundOffer,
  type InboundRail,
  type InboundVerifyResult,
  type PaymentCredential,
  type PreflightResult,
  type ReleaseResult,
  type SettleResult,
} from "../../ports/inbound.js";
import type { DiagnosticsSink } from "../../shared/diagnostics.js";
import type { SubethaExactLimits } from "../../shared/subetha-exact.js";
import { emitInboundRoundTrip, inboundDiagnosticsOn, verifyResponseClassOf, withInboundDiagScope } from "./inbound-diagnostics.js";
import {
  classifyComplete,
  classifyCreate,
  classifyReconstruct,
  classifyBind,
  classifyReconcile,
  classifyReleasePost,
  classifySubmit,
  classifySubethaSettle,
  isRecord,
  parseOrderView,
  requesterDigestOf,
  resourceDigestOf,
  retryAfterMsOf,
  sigSha256Of,
  SUBETHA_EXACT_RESPONSE_MAX_BYTES,
  tryDeadlineOf,
  viewMismatchOf,
  waitFits,
  type CallOutcome,
  type LocalIdentity,
  type ParsedOrderView,
  type ReconcileClassification,
  type ReconcileReading,
  type ReleaseContext,
} from "./subetha-exact-classify.js";
import { openSubethaExactLedger, type AttemptView, type SubethaExactLedger } from "./subetha-exact-ledger.js";

export interface SubethaExactTimeouts {
  readonly createMs: number;
  readonly verifyMs: number;
  /** `settle` 全体の予算（bind + 外部への送信 + reconcile。本文の読み取りと待ちを含む）。 */
  readonly settleMs: number;
  /** その中の 1 回ずつの上限（`docs/subetha-exact-provider-settle-design.md` §3.5）。 */
  readonly bindMs: number;
  readonly submitMs: number;
  readonly reconcileMs: number;
  /** reconcile が `pending` の間の待ち。 */
  readonly reconcileRetryWaitMs: number;
  readonly statusMs: number;
  readonly releaseMs: number;
  readonly completeMs: number;
  readonly offerSeconds: number;
  readonly minLeadSeconds: number;
  /** 操作全体の予算（§3.7）: release の上限、complete、照会 1 件。 */
  readonly releaseBudgetMs: number;
  readonly completeBudgetMs: number;
  readonly lookupBudgetMs: number;
  /** `Retry-After` が無いときの待ち。 */
  readonly releaseRetryWaitMs: number;
  readonly completeRetryWaitMs: number;
}
export const SUBETHA_EXACT_DEFAULT_TIMEOUTS: SubethaExactTimeouts = Object.freeze({
  createMs: 40_000,
  verifyMs: 15_000,
  settleMs: 60_000,
  bindMs: 10_000,
  submitMs: 30_000,
  reconcileMs: 10_000,
  reconcileRetryWaitMs: 2_000,
  statusMs: 15_000,
  releaseMs: 20_000,
  completeMs: 15_000,
  offerSeconds: 120,
  minLeadSeconds: 30,
  releaseBudgetMs: 60_000,
  completeBudgetMs: 35_000,
  lookupBudgetMs: 20_000,
  releaseRetryWaitMs: 2_000,
  completeRetryWaitMs: 1_000,
});

export interface SubethaExactInboundOptions {
  /** `https://…/p/<id>`（末尾 / 無し）。 */
  readonly facilitatorUrl: string;
  /** token は閉包の中だけ（options に文字列で持たせない = 誤って JSON 化しない）。 */
  readonly token: () => string;
  readonly transport: GuardedTransport;
  /**
   * Router が買い手の authorization を送る先の x402 facilitator の base URL（末尾 / 無し。`…/settle` に POST する）。
   * この要求に Provider token は付けない。transport は `transport` と同じ（SSRF 防御 A）。
   */
  readonly settleFacilitatorUrl: string;
  /**
   * settle 先の token（`docs/exact-settle-facilitator-design.md` §1）。**あれば送り先は SubEtha の settle facilitator**: `POST …/settle` にだけ `Authorization` を付け、
   * 答えを `classifySubethaSettle` で読む。無ければ今までどおり（header なし、`classifySubmit`）。host との組み合わせは合成が検査する。
   */
  readonly settleToken?: () => string;
  /** 表の行（`subetha-exact` の受信を許す資産）。 */
  readonly asset: { readonly network: string; readonly id: string; readonly decimals: number; readonly domain: { readonly name: string; readonly version: string } };
  /** `<dirname(journalPath)>/subetha-exact`。 */
  readonly ledgerDir: string;
  readonly limits: SubethaExactLimits;
  /** 答えの得られなかった verify を、offer の種類に関わらず例外にする（core が unknown と記録する。設計 §3.1）。無ければ標準入口の offer だけ。 */
  readonly unansweredVerifyIsUnknown?: boolean;
  readonly offerSeconds?: number;
  readonly timeouts?: Partial<SubethaExactTimeouts>;
  /** 試験の時計（ms）。 */
  readonly now?: () => number;
  /** 固定文だけ。 */
  readonly note?: (message: string) => void;
  readonly diagnostics?: DiagnosticsSink;
  /** 試験だけ。`stop("after_release_remote", orderId)` は release の遠隔の記録の後・返す前に待つ。 */
  readonly hooksForTest?: { readonly stop?: (point: "after_release_remote", orderId: string) => Promise<void> };
}

export interface SubethaExactInbound extends InboundRail {
  /** ledger を開き、索引を組み、未解決の照会を 1 巡する。合成が listen の前に呼ぶ。 */
  startup(): Promise<void>;
  close(): Promise<void>;
  /** 読取だけ（試験と運用者の確認）。`startup()` の後。 */
  readonly ledger: SubethaExactLedger | undefined;
}

export const SUBETHA_EXACT_SCHEME = "exact";
/** 標準の x402 クライアント用の入口の offer の印（`docs/x402-standard-entry-design.md` §3）。 */
const STANDARD_ENTRY = "x402" as const;
const isStandardOffer = (offer: InboundOffer): boolean => offer.extra["entry"] === STANDARD_ENTRY;
/** tag を渡さない呼び出しを 1 つの送信元として数えるための固定の tag（送信元ごとの上限が設定にあるときだけ使う）。 */
const NO_SOURCE_TAG = "0000000000000000";
const ISSUED_EXTRA_KEYS = ["name", "version", "challengeNonce", "expiresAt", "routeBinding", "fundsMoveOnCredential"] as const;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const DIGITS = /^[0-9]{1,30}$/;
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const lower = (value: string): string => value.toLowerCase();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createSubethaExactInbound(options: SubethaExactInboundOptions): SubethaExactInbound {
  const base = options.facilitatorUrl.replace(/\/$/, "");
  const settleBase = options.settleFacilitatorUrl.replace(/\/+$/, "");
  const tenant = new URL(base).pathname;
  const transport = options.transport;
  const asset = options.asset;
  const chainId = Number(asset.network.slice("eip155:".length));
  const timeouts: SubethaExactTimeouts = { ...SUBETHA_EXACT_DEFAULT_TIMEOUTS, ...options.timeouts, ...(options.offerSeconds === undefined ? {} : { offerSeconds: options.offerSeconds }) };
  const now = options.now ?? (() => Date.now());
  const nowSec = (): number => Math.floor(now() / 1000);
  const note = options.note ?? (() => undefined);
  const diagnostics = options.diagnostics;
  const diagOn = inboundDiagnosticsOn(diagnostics);
  let ledger: SubethaExactLedger | undefined;
  let inflight = false;
  /** 外部の facilitator へ送っている最中の注文（小文字の id）。同じ process の 2 つ目の `settle` は送らない（設計 §3.3）。 */
  const submitting = new Set<string>();

  // ---- HTTP の共通（§3.9）。例外を投げない。 ----
  function call(method: "GET" | "POST", path: string, body: unknown, options2: { readonly op: string; readonly deadlineMs: number; readonly auth: boolean; readonly routeId: string }): Promise<CallOutcome & { readonly elapsedMs: number }> {
    return exchange(method, `${base}${path}`, { "content-type": "application/json", ...(options2.auth ? { authorization: `Bearer ${options.token()}` } : {}) }, body, options2);
  }
  const settleToken = options.settleToken;
  /** 外部の x402 facilitator への 1 回の送信。**Provider token を付けない**（header はここで固定。`call` を通さない）。settle 先の token を読むのはここだけ。 */
  function submitExternal(body: unknown, options2: { readonly deadlineMs: number; readonly routeId: string }): Promise<CallOutcome & { readonly elapsedMs: number }> {
    return exchange("POST", `${settleBase}/settle`, { "content-type": "application/json", ...(settleToken === undefined ? {} : { authorization: `Bearer ${settleToken()}` }) }, body, { op: "settle_facilitator_settle", deadlineMs: options2.deadlineMs, routeId: options2.routeId });
  }
  async function exchange(method: "GET" | "POST", url: string, headers: Record<string, string>, body: unknown, options2: { readonly op: string; readonly deadlineMs: number; readonly routeId: string }): Promise<CallOutcome & { readonly elapsedMs: number }> {
    const context: TransportContext = { routeId: options2.routeId, operation: options2.op };
    const startedAt = performance.now();
    const signal = AbortSignal.timeout(options2.deadlineMs);
    let response: Response;
    try {
      response = await transport.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      }, context);
    } catch {
      return { kind: "threw", elapsedMs: Math.max(0, performance.now() - startedAt) };
    }
    const retryAfter = response.headers.get("retry-after");
    // 本文の読み取りも同じ期限の中で（期限を越えたら中断して `unreadable`）。
    const aborted = new Promise<"timeout">((resolve) => {
      if (signal.aborted) resolve("timeout");
      else signal.addEventListener("abort", () => resolve("timeout"), { once: true });
    });
    let json: unknown;
    let unreadable = false;
    try {
      const read = await Promise.race([readBoundedBody(response, SUBETHA_EXACT_RESPONSE_MAX_BYTES), aborted]);
      if (read === "timeout") {
        unreadable = true;
        await response.body?.cancel().catch(() => undefined);
      } else if (!read.ok) {
        unreadable = true;
      } else {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);
        try {
          json = text === "" ? undefined : JSON.parse(text);
        } catch {
          json = undefined;
          unreadable = text !== "";
        }
      }
    } catch (error) {
      transport.report(error, context);
      unreadable = true;
    }
    return { kind: "response", status: response.status, json, retryAfter, unreadable, elapsedMs: Math.max(0, performance.now() - startedAt) };
  }

  const httpStatusOf = (call0: CallOutcome): { httpStatus?: number } => (call0.kind === "response" ? { httpStatus: call0.status } : {});
  const routeIdOf = (context: InboundCallContext | undefined): string => context?.routeId ?? "-";

  /** 遠隔の操作の後の行: 書けなくても結果は返す（note だけ）。 */
  async function record(key: string, event: Parameters<SubethaExactLedger["append"]>[1], patch: Record<string, unknown>): Promise<void> {
    if (ledger === undefined) return;
    try {
      await ledger.append(key, event, patch);
    } catch {
      note(`subetha-exact: ledger row could not be written (event=${event})`);
    }
  }
  /** 操作の行の持ち主: その orderId を `created` に持つ最新の attempt（耐久の index）。無ければ note。 */
  function attemptForOrder(orderId: string): AttemptView | undefined {
    const list = ledger?.attemptsForOrder(orderId) ?? [];
    const latest = list.at(-1);
    if (latest === undefined) note("subetha-exact: no ledger attempt for this order (ledger lost?); result kept, row skipped");
    return latest;
  }

  // ---- requester の照会（§3.6）。attempt の状態は変えない。 ----
  async function lookupSweep(routeId: string): Promise<void> {
    if (ledger === undefined) return;
    const seen = new Set<string>();
    const pending = ledger.unresolvedAttempts(nowSec()).filter((attempt) => attempt.created === undefined).sort((a, b) => a.atMs - b.atMs);
    for (const attempt of pending) {
      const pair = `${lower(attempt.requesterDigest)}|${lower(attempt.resourceDigest)}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const budgetEnd = now() + timeouts.lookupBudgetMs;
      let outcome: "found" | "empty" | "failed" = "failed";
      let last: (CallOutcome & { elapsedMs: number }) | undefined;
      for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
        const deadline = tryDeadlineOf(timeouts.statusMs, budgetEnd, now());
        if (deadline === undefined) break;
        last = await call("GET", `/exact/requesters/${attempt.requesterDigest}/orders?resourceDigest=${attempt.resourceDigest}`, undefined, { op: "facilitator_requester_orders", deadlineMs: deadline, auth: true, routeId });
        if (last.kind === "response" && last.status === 200 && isRecord(last.json) && Array.isArray(last.json["orders"])) {
          outcome = "empty";
          for (const raw of last.json["orders"]) {
            const view = parseOrderView(raw);
            if (view === undefined || ledger.hasOrder(view.orderId)) continue;
            // FR-3 と同じ検査（期限は見ない）。`existing` は照会の view には無い。
            const mismatch = viewMismatchOf({ ...view, existing: false }, { network: asset.network, asset: asset.id, amount: attempt.amount, requesterDigest: attempt.requesterDigest, resourceDigest: attempt.resourceDigest, domain: asset.domain, nowSec: nowSec(), minLeadSeconds: timeouts.minLeadSeconds }, false);
            if (mismatch !== undefined) continue;
            outcome = "found";
            await record(pair, "discovered", { pair: { requesterDigest: attempt.requesterDigest, resourceDigest: attempt.resourceDigest }, orderId: view.orderId, payTo: getAddress(view.requirements.payTo), expiresAt: view.status.expiresAt, tenant, requirements: view.requirements, binding: view.binding });
          }
          break;
        }
        const retryable = last.kind === "threw" || last.status === 429 || last.status >= 500;
        if (!retryable) break;
        const wait = last.kind === "response" ? retryAfterMsOf(last.retryAfter, 1000) : 1000;
        if (attemptNo < 2 && waitFits(wait, budgetEnd, now())) await sleep(wait);
        else break;
      }
      await record(attempt.attemptId, "lookup", { outcome, ...(last === undefined ? {} : httpStatusOf(last)), elapsedMs: Math.round(last?.elapsedMs ?? 0) });
    }
  }

  // ---- createOffer（§3.4） ----
  async function createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    if (request.network !== asset.network || lower(request.asset) !== lower(asset.id)) {
      // 設定の不整合（起動時に表で落ちるので到達しない）。§3.9 の契約どおり `InboundOfferError` だけを投げる。
      note("subetha-exact: route asset does not match the adapter's asset");
      throw new InboundOfferError("source_offer_refused", "requirements_mismatch");
    }
    const requester = request.requester;
    if (requester === undefined) throw new InboundOfferError("source_offer_refused", "requester_missing");
    if (ledger === undefined || ledger.broken) throw new InboundOfferError("source_offer_unavailable", "ledger_unavailable");
    if (inflight) throw new InboundOfferError("source_offer_unavailable", "limit_concurrency");
    inflight = true;
    try {
      return await createOfferLocked(request, requester, ledger);
    } finally {
      inflight = false;
    }
  }

  async function createOfferLocked(request: CreateOfferRequest, requester: NonNullable<CreateOfferRequest["requester"]>, ledger0: SubethaExactLedger): Promise<InboundOffer> {
    const nowMs = now();
    /*
     * 送信元ごとの上限（`docs/hosted-exact-enable-design.md` §3。設定に欄があるときだけ）。全体の枠より前に見る。facilitator は呼ばない。
     * 結果の分からない作成を持つ送信元は、それが片付くまで作れない（後から注文が見つかると attempt 1 + 注文 1 を占めるため）。
     */
    const rawTag = requester.sourceTag;
    const sourceTag = typeof rawTag === "string" && /^[0-9a-f]{16}$/.test(rawTag) ? rawTag : NO_SOURCE_TAG;
    const perSourceUnresolved = options.limits.maxUnresolvedPerSource;
    const perSourceRate = options.limits.requestsPerMinutePerSource;
    const perSourceOn = perSourceUnresolved !== undefined || perSourceRate !== undefined;
    /**
     * 1 つの作成は、応答を失って後から注文が見つかると **attempt 1 + 注文 1 の 2 つ**を占め得る。だから作成の前に 2 つ分の余裕を求める
     * （`今の占有 + 2 ≤ 上限`）。こうすると、応答を失った後に注文が見つかっても、その送信元の占有は上限を超えない。
     */
    const checkSource = (): void => {
      if (!perSourceOn) return;
      const usage = ledger0.sourceUsage(sourceTag, nowSec(), nowMs - 60_000);
      if (perSourceUnresolved !== undefined && (usage.unknownCreation || usage.unresolved + 2 > perSourceUnresolved)) throw new InboundOfferError("source_offer_unavailable", "limit_source_unresolved", 300_000);
      if (perSourceRate !== undefined && usage.recent >= perSourceRate) throw new InboundOfferError("source_offer_unavailable", "limit_source_rate", 60_000);
    };
    checkSource();
    if (ledger0.totalRequests() >= options.limits.maxRequestsTotal) {
      note("subetha-exact: total request limit reached; raise subethaExact.limits.maxRequestsTotal only as an operator decision");
      throw new InboundOfferError("source_offer_unavailable", "limit_total");
    }
    if (ledger0.requestsSince(nowMs - 60_000) >= options.limits.requestsPerMinute) throw new InboundOfferError("source_offer_unavailable", "limit_rate", 60_000);
    if (ledger0.unresolvedCount(nowSec()) >= options.limits.maxUnresolved) {
      await lookupSweep(request.routeId);
      if (ledger0.unresolvedCount(nowSec()) >= options.limits.maxUnresolved) {
        note("subetha-exact: unresolved requests at the limit; inspect with the operator tool");
        throw new InboundOfferError("source_offer_unavailable", "limit_unresolved");
      }
      // 照会で見つかった注文は、この送信元の占有を増やし得る: 見つけた後の数でもう一度確かめる。
      checkSource();
    }
    const resourceDigest = resourceDigestOf(request.routeBinding);
    const requesterDigest = requesterDigestOf(ledger0.salt, requester.principalId, requester.requestId);
    const attemptId = randomBytes(16).toString("hex");
    try {
      await ledger0.append(attemptId, "requested", { requesterDigest, resourceDigest, routeId: request.routeId, amount: request.amount, atMs: nowMs, ...(perSourceOn || sourceTag !== NO_SOURCE_TAG ? { sourceTag } : {}) });
    } catch {
      note("subetha-exact: ledger unavailable; refusing new offers until restart");
      throw new InboundOfferError("source_offer_unavailable", "ledger_unavailable");
    }
    const result = await call("POST", "/exact/orders", { amount: request.amount, resourceDigest, requesterDigest }, { op: "facilitator_order_create", deadlineMs: timeouts.createMs, auth: true, routeId: request.routeId });
    const latest = ledger0.latestCreatedForPair(requesterDigest, resourceDigest);
    const classified = classifyCreate(result, { network: asset.network, asset: asset.id, amount: request.amount, requesterDigest, resourceDigest, domain: asset.domain, nowSec: nowSec(), minLeadSeconds: timeouts.minLeadSeconds, ...(latest?.created === undefined ? {} : { latestCreatedOrderId: latest.created.orderId }) });
    const elapsedMs = Math.round(result.elapsedMs);
    if (classified.kind === "unavailable") {
      await record(attemptId, "create_failed", { kind: "transient", detail: classified.detail, ...httpStatusOf(result), elapsedMs });
      throw new InboundOfferError("source_offer_unavailable", classified.detail, classified.retryAfterMs);
    }
    if (classified.kind === "refused") {
      if (classified.detail === "unauthorized") note("subetha-exact: facilitator refused the provider token (401)");
      if (classified.detail === "unknown_tenant") note("subetha-exact: facilitator does not know this tenant (404)");
      await record(attemptId, "refused", { detail: classified.detail, ...httpStatusOf(result), elapsedMs });
      throw new InboundOfferError("source_offer_refused", classified.detail);
    }
    const view = classified.view;
    try {
      await ledger0.append(attemptId, "created", { orderId: view.orderId, payTo: getAddress(view.requirements.payTo), expiresAt: view.status.expiresAt, existing: view.existing === true, tenant, requirements: view.requirements, binding: view.binding, ...httpStatusOf(result), elapsedMs, atMs: now() });
    } catch {
      // 注文に quote を結び付けられない: offer を返さない（注文は facilitator に残り、同じ requestId の再 quote（existing）か FR-11 で見える）。
      note("subetha-exact: ledger unavailable after order creation; offer withheld");
      throw new InboundOfferError("source_offer_unavailable", "ledger_unavailable");
    }
    if (request.entry === STANDARD_ENTRY) {
      // 標準入口（`docs/x402-standard-entry-design.md` §3）: 既にある注文を 2 度見せない。標準クライアントが今すぐ署名しても注文の期限を超えるなら出さない。
      // 注文と attempt の行は残る（期限まで未解決の枠を使う。黙って消さない）。
      if (view.existing === true) throw new InboundOfferError("source_offer_unavailable", "order_exists");
      if (view.requirements.maxTimeoutSeconds + timeouts.minLeadSeconds > view.status.expiresAt - nowSec()) throw new InboundOfferError("source_offer_unavailable", "order_window_short");
    }
    return offerOf(request, view);
  }

  function offerOf(request: CreateOfferRequest, view: ParsedOrderView): InboundOffer {
    return {
      scheme: SUBETHA_EXACT_SCHEME,
      network: request.network,
      asset: request.asset,
      amount: request.amount,
      payTo: getAddress(view.requirements.payTo),
      maxTimeoutSeconds: view.requirements.maxTimeoutSeconds,
      extra: {
        name: asset.domain.name,
        version: asset.domain.version,
        challengeNonce: view.orderId,
        // 標準入口の offer は「発行 + offerSeconds」で切らない: 標準クライアントの `validBefore` は `now + maxTimeoutSeconds` で、開示の上限は注文の期限（設計 §3）。
        expiresAt: request.entry === STANDARD_ENTRY ? view.status.expiresAt : Math.min(view.status.expiresAt, nowSec() + timeouts.offerSeconds),
        routeBinding: request.routeBinding,
        fundsMoveOnCredential: false,
        ...(request.entry === STANDARD_ENTRY ? { entry: STANDARD_ENTRY } : {}),
      },
    };
  }

  // ---- facilitator へ送る形（x402 adapter と同じ: Router 発行の offer からだけ組む） ----
  function ledgerRequirementsOf(offer: InboundOffer): Record<string, unknown> {
    return { scheme: offer.scheme, network: offer.network, asset: offer.asset, amount: offer.amount, payTo: offer.payTo, maxTimeoutSeconds: offer.maxTimeoutSeconds, extra: { name: offer.extra["name"], version: offer.extra["version"] } };
  }
  function payloadOf(offer: InboundOffer, credential: PaymentCredential): Record<string, unknown> {
    return { x402Version: credential.x402Version, scheme: offer.scheme, network: offer.network, accepted: credential.accepted, payload: isRecord(credential.payload) ? { ...credential.payload } : credential.payload };
  }
  function authorizationOf(sentPayload: Record<string, unknown>): { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string; signature: string } | undefined {
    const payload = sentPayload["payload"];
    const authorization = isRecord(payload) ? payload["authorization"] : undefined;
    const signature = isRecord(payload) ? payload["signature"] : undefined;
    if (!isRecord(authorization) || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return undefined;
    const fields = ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const;
    const out: Record<string, string> = {};
    for (const field of fields) {
      const value = authorization[field];
      if (typeof value !== "string") return undefined;
      out[field] = value;
    }
    if (!HEX32.test(out["nonce"]!) || !DIGITS.test(out["value"]!) || !DIGITS.test(out["validAfter"]!) || !DIGITS.test(out["validBefore"]!)) return undefined;
    return { from: out["from"]!, to: out["to"]!, value: out["value"]!, validAfter: out["validAfter"]!, validBefore: out["validBefore"]!, nonce: out["nonce"]!, signature };
  }
  /** 手元の署名の検査（純粋）。復元した address が `from` と一致するか。 */
  async function locallySigned(authorization: NonNullable<ReturnType<typeof authorizationOf>>): Promise<boolean> {
    try {
      const recovered = await recoverTypedDataAddress({
        domain: { name: asset.domain.name, version: asset.domain.version, chainId, verifyingContract: getAddress(asset.id) },
        types: AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: { from: getAddress(authorization.from), to: getAddress(authorization.to), value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce as Hex },
        signature: authorization.signature as Hex,
      });
      return lower(recovered) === lower(getAddress(authorization.from));
    } catch {
      return false;
    }
  }

  const rail: SubethaExactInbound = {
    get ledger() {
      return ledger;
    },
    async startup(): Promise<void> {
      ledger = await openSubethaExactLedger({ dir: options.ledgerDir });
      try {
        await lookupSweep("-");
        if (ledger.unresolvedCount(nowSec()) >= options.limits.maxUnresolved) note("subetha-exact: unresolved requests at the limit; inspect with the operator tool");
      } catch (error) {
        await ledger.close().catch(() => undefined);
        ledger = undefined;
        throw error;
      }
    },
    async close(): Promise<void> {
      await ledger?.close();
      ledger = undefined;
    },
    createOffer,
    preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
      // 標準入口の offer（設計 §4.4 (b)）: `extra` の key に `entry` を許し、authorization の nonce を買い手のものとして受ける。印の無い offer の検査は変えない。
      const standard = isStandardOffer(offer);
      const issuedKeys: readonly string[] = standard ? [...ISSUED_EXTRA_KEYS, "entry"] : ISSUED_EXTRA_KEYS;
      if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
      if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
      const accepted = credential.accepted as Partial<InboundOffer> | undefined;
      if (accepted === undefined || accepted.scheme !== SUBETHA_EXACT_SCHEME) return { ok: false, reason: "credential_mismatch" };
      if (accepted.extra?.routeBinding !== offer.extra.routeBinding) return { ok: false, reason: "route_binding_mismatch" };
      if (accepted.network !== offer.network || accepted.asset !== offer.asset || accepted.amount !== offer.amount || accepted.payTo !== offer.payTo || accepted.maxTimeoutSeconds !== offer.maxTimeoutSeconds) return { ok: false, reason: "offer_mismatch" };
      const acceptedExtra = accepted.extra;
      if (!isRecord(acceptedExtra)) return { ok: false, reason: "offer_mismatch" };
      for (const key of Object.keys(acceptedExtra)) if (!issuedKeys.includes(key)) return { ok: false, reason: "offer_mismatch" };
      for (const key of issuedKeys) if (acceptedExtra[key] !== offer.extra[key]) return { ok: false, reason: "offer_mismatch" };
      const authorization = authorizationOf({ payload: credential.payload });
      if (authorization === undefined) return { ok: false, reason: "credential_mismatch" };
      if (!standard && lower(authorization.nonce) !== lower(offer.extra.challengeNonce)) return { ok: false, reason: "nonce_mismatch" };
      if (lower(authorization.to) !== lower(offer.payTo) || authorization.value !== offer.amount || Number(authorization.validBefore) > offer.extra.expiresAt || Number(authorization.validAfter) > Math.floor(nowMs / 1000)) return { ok: false, reason: "credential_mismatch" };
      return { ok: true };
    },
    async checkSignature(offer: InboundOffer, credential: PaymentCredential): Promise<boolean> {
      // この rail の offer で、形の整った authorization の署名が `from` のものであるときだけ true（facilitator を呼ばない）。
      if (!(offer.scheme === SUBETHA_EXACT_SCHEME && offer.network === asset.network && lower(offer.asset) === lower(asset.id))) return false;
      const authorization = authorizationOf({ payload: credential.payload });
      return authorization !== undefined && (await locallySigned(authorization));
    },
    settleWindowOf(offer: InboundOffer): number | undefined {
      return Number.isSafeInteger(offer.extra.expiresAt) && offer.extra.expiresAt > 0 ? offer.extra.expiresAt : undefined;
    },
    ownsOffer(offer: InboundOffer): boolean {
      return offer.scheme === SUBETHA_EXACT_SCHEME && offer.network === asset.network && lower(offer.asset) === lower(asset.id);
    },

    async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<InboundVerifyResult> {
      const sent = payloadOf(offer, credential);
      const authorization = authorizationOf(sent);
      const orderId = lower(offer.extra.challengeNonce);
      const owner = attemptForOrder(orderId);
      const startedAt = performance.now();
      if (authorization === undefined || !(await locallySigned(authorization))) {
        if (owner !== undefined) await record(owner.attemptId, "verify", { orderId, local: "invalid", elapsedMs: Math.round(performance.now() - startedAt) });
        return { isValid: false };
      }
      const mayStillSettleUntil = Number(authorization.validBefore);
      const requestText = JSON.stringify({ x402Version: 2, paymentPayload: sent, paymentRequirements: ledgerRequirementsOf(offer) });
      return withInboundDiagScope(diagnostics, diagOn ? requestText : undefined, async () => {
        const result = await call("POST", "/exact/verify", JSON.parse(requestText), { op: "facilitator_verify", deadlineMs: timeouts.verifyMs, auth: false, routeId: routeIdOf(context) });
        const remote = result.kind === "threw" ? "threw" : result.status !== 200 ? "http_error" : !isRecord(result.json) ? "not_json" : result.json["isValid"] === true ? "valid" : "invalid";
        if (owner !== undefined) await record(owner.attemptId, "verify", { orderId, local: "ok", remote, ...httpStatusOf(result), elapsedMs: Math.round(result.elapsedMs) });
        if (diagOn && result.kind === "response") emitInboundRoundTrip(diagnostics, { stage: "source_verify", facilitator: "x402", network: offer.network, response: verifyResponseClassOf(result.status, result.json), httpStatus: result.status, json: result.json, elapsedMs: result.elapsedMs });
        // 標準入口（設計 §5、要件 FR-2.5 (e)）: 答えの得られなかった verify（時間切れ・切断・200 以外・壊れた応答）を「拒否」にしない。例外にして core が unknown と記録する。
        // facilitator が 200 で拒んだ場合だけ `isValid: false`。印の無い offer は今までどおり全て `isValid: false`。
        // 「答えた」と読むのは 200 で `isValid` が boolean のときだけ（`{}`・`null`・文字列の `isValid` は答えではない）。
        const answered = result.kind === "response" && result.status === 200 && isRecord(result.json) && typeof result.json["isValid"] === "boolean";
        // hosted（`unansweredVerifyIsUnknown: true`）では quote の入口の offer にも同じ規則（`docs/hosted-exact-enable-design.md` §3.1）。欄が無くても標準入口の offer は今までどおり。
        if ((isStandardOffer(offer) || options.unansweredVerifyIsUnknown === true) && !answered) throw new Error("subetha-exact: verify unanswered");
        return { isValid: remote === "valid", mayStillSettleUntil };
      });
    },

    async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
      const sent = payloadOf(offer, credential);
      const authorization = authorizationOf(sent);
      const orderId = lower(offer.extra.challengeNonce);
      const owner = attemptForOrder(orderId);
      if (owner === undefined) {
        // 要求を**出す前**: 注文の requester の digest が分からない（ledger に attempt が無い）。資金は動いていない。
        return { outcome: "rejected", reason: "source_rejected" };
      }
      const routeId = routeIdOf(context);
      const mayStillSettleUntil = authorization === undefined ? undefined : Number(authorization.validBefore);
      const unknown: SettleResult = { outcome: "unknown", reason: "source_settle_unknown", ...(mayStillSettleUntil === undefined ? {} : { mayStillSettleUntil }) };
      // 予算は単調な時計で（bind・送信・reconcile の要求・本文の読み取り・待ちは `settleMs` の中。設計 §3.5）。ledger の書き込み（fsync）そのものには期限を付けない:
      // 書き込みの後に残りを測り直し、尽きていれば次の要求を出さない。
      const startedAt = performance.now();
      const left = (): number => timeouts.settleMs - (performance.now() - startedAt);
      const deadlineOf = (perTryMs: number): number | undefined => {
        const remaining = Math.floor(left());
        return remaining < 1 ? undefined : Math.min(perTryMs, remaining);
      };
      let last: (CallOutcome & { readonly elapsedMs: number }) | undefined;
      let classified: ReconcileClassification | undefined;
      let reconcileAttempts = 0;
      const finish = async (result: SettleResult, reading: ReconcileReading | "none"): Promise<SettleResult> => {
        const settled = result.outcome === "settled" ? result : undefined;
        await record(owner.attemptId, "settle", {
          orderId,
          outcome: settled === undefined ? "unknown" : "settled",
          ...(settled === undefined ? {} : { txRef: settled.txRef }),
          path: "provider",
          reconcile: reading,
          reconcileAttempts,
          ...(last === undefined ? {} : httpStatusOf(last)),
          elapsedMs: Math.round(performance.now() - startedAt),
          ...(mayStillSettleUntil === undefined ? {} : { mayStillSettleUntil }),
        });
        if (diagOn && last !== undefined && last.kind === "response" && classified !== undefined) emitInboundRoundTrip(diagnostics, { stage: "source_settle", facilitator: "x402", network: offer.network, response: classified.response, httpStatus: last.status, json: last.json, elapsedMs: last.elapsedMs });
        return result;
      };
      // 形の崩れた authorization は bind に出さない（preflight が先に落とす。ここは念のため）。何も送らない。
      if (authorization === undefined) return finish(unknown, "none");
      const local: LocalIdentity = { from: authorization.from, nonce: authorization.nonce, sigSha256: sigSha256Of(authorization.signature) };
      const requestText = JSON.stringify({ paymentPayload: sent, requesterDigest: owner.requesterDigest, resourceDigest: owner.resourceDigest });
      return withInboundDiagScope(diagnostics, diagOn ? requestText : undefined, async () => {
        // 1. bind（送信なし）。`bound` で identity が一致したときだけ、先へ送ってよい。
        const bindDeadline = deadlineOf(timeouts.bindMs);
        if (bindDeadline === undefined) return finish(unknown, "none");
        const bound = await call("POST", `/exact/orders/${orderId}/bind`, JSON.parse(requestText), { op: "facilitator_bind", deadlineMs: bindDeadline, auth: true, routeId });
        const bind = classifyBind(bound, local);
        await record(owner.attemptId, "bind", {
          orderId,
          ack: bind.action === "submit" ? "bound" : bind.ack,
          ...(bind.action === "submit" ? { identity: "match" } : bind.action === "stop" && bind.ack === "bound" ? { identity: "mismatch" } : {}),
          ...(bind.action === "reconcile" && bind.code !== undefined ? { code: bind.code } : {}),
          ...httpStatusOf(bound),
          elapsedMs: Math.round(bound.elapsedMs),
        });
        if (bind.action === "stop") return finish(unknown, "none");
        // 2. 外部の facilitator へ最大 1 回。順番: in-flight（await を挟まない）→ 耐久の印の有無 → 印を書く → 送る。印は消さない。
        let wait = false;
        if (bind.action === "submit" && ledger !== undefined && !submitting.has(orderId) && !ledger.submitStarted(orderId)) {
          submitting.add(orderId);
          try {
            if (deadlineOf(timeouts.submitMs) === undefined) return finish(unknown, "none");
            try {
              // この行だけは握りつぶさない: 書けなければ送らない。
              await ledger.append(owner.attemptId, "submit", { orderId, phase: "started" });
            } catch {
              note("subetha-exact: the submission mark could not be written; nothing was sent");
              return finish(unknown, "none");
            }
            // 印の書き込み（fsync）が長引いたら、残りの予算で測り直す。尽きていれば送らない（印は残す: この注文はもう送らない）。
            const submitDeadline = deadlineOf(timeouts.submitMs);
            if (submitDeadline === undefined) return finish(unknown, "none");
            const answer = await submitExternal({ x402Version: 2, paymentPayload: sent, paymentRequirements: ledgerRequirementsOf(offer) }, { deadlineMs: submitDeadline, routeId });
            const submitted = settleToken === undefined ? classifySubmit(answer) : classifySubethaSettle(answer);
            // 外部の答えは結果を決めない。reconcile を待つ長さだけ。
            wait = submitted.wait;
            await record(owner.attemptId, "submit", { orderId, phase: "answered", ...httpStatusOf(answer), ...(submitted.success === undefined ? {} : { success: submitted.success }), ...(submitted.transaction === undefined ? {} : { transaction: submitted.transaction }), ...(submitted.reason === undefined ? {} : { reason: submitted.reason }), elapsedMs: Math.round(answer.elapsedMs) });
          } finally {
            submitting.delete(orderId);
          }
        }
        // 3. 結果は SubEtha の reconcile（chain の照合）だけ。
        for (;;) {
          const reconcileDeadline = deadlineOf(timeouts.reconcileMs);
          if (reconcileDeadline === undefined) break;
          reconcileAttempts += 1;
          last = await call("POST", `/exact/orders/${orderId}/reconcile`, {}, { op: "facilitator_reconcile", deadlineMs: reconcileDeadline, auth: true, routeId });
          classified = classifyReconcile(last, local, mayStillSettleUntil);
          if (!wait || (classified.reading !== "pending" && classified.reading !== "unanswered")) break;
          if (left() <= timeouts.reconcileRetryWaitMs) break;
          await sleep(timeouts.reconcileRetryWaitMs);
        }
        return classified === undefined ? finish(unknown, "none") : finish(classified.result, classified.reading);
      });
    },

    async release(offer: InboundOffer, context: InboundCallContext): Promise<ReleaseResult> {
      const orderId = lower(offer.extra.challengeNonce);
      const owner = attemptForOrder(orderId);
      const sourceTxRef = context.sourceTxRef;
      if (owner === undefined || sourceTxRef === undefined) return { outcome: "unknown", reason: "source_release_unknown" };
      const releaseContext: ReleaseContext = { orderId, sourceTxRef: lower(sourceTxRef), chainId, requesterDigest: owner.requesterDigest, resourceDigest: owner.resourceDigest };
      const startMs = now();
      const budgetEnd = Math.min(context.deadlineMs === undefined ? Number.POSITIVE_INFINITY : context.deadlineMs - 5_000, startMs + timeouts.releaseBudgetMs);
      let attempts = 0;
      let lastStatus: { httpStatus?: number } = {};
      let totalElapsed = 0;
      const finish = async (outcome: ReleaseResult, reconstructed = false): Promise<ReleaseResult> => {
        await record(owner.attemptId, "release", { orderId, outcome: outcome.outcome, attempts, ...lastStatus, elapsedMs: Math.round(totalElapsed), ...(reconstructed ? { reconstructed: true } : {}) });
        if (outcome.outcome === "released") await options.hooksForTest?.stop?.("after_release_remote", orderId);
        return outcome;
      };
      const unknown: ReleaseResult = { outcome: "unknown", reason: "source_release_unknown" };
      const refused: ReleaseResult = { outcome: "refused", reason: "source_release_refused" };
      /** GET（復元・状態の確認）: 1 回の機会につき最大 2 試行、同じ予算の内。表 D（`claimed`）／D′（`transport`）。 */
      type Probe = { readonly kind: "released"; readonly result: ReleaseResult } | { readonly kind: "refused" | "retry" | "unknown" };
      const probe = async (after: "claimed" | "transport"): Promise<Probe> => {
        for (let tryNo = 1; tryNo <= 2; tryNo += 1) {
          const deadline = tryDeadlineOf(timeouts.statusMs, budgetEnd, now());
          if (deadline === undefined) return { kind: "unknown" };
          const got = await call("GET", `/exact/orders/${orderId}`, undefined, { op: "facilitator_order_status", deadlineMs: deadline, auth: true, routeId: context.routeId });
          totalElapsed += got.elapsedMs;
          lastStatus = httpStatusOf(got);
          const classified = classifyReconstruct(got, releaseContext, after);
          if (classified.action === "released") return { kind: "released", result: { outcome: "released", ...classified.ticket } };
          if (classified.action === "refused") return { kind: "refused" };
          if (classified.action === "retry") return { kind: "retry" };
          const retryable = got.kind === "threw" || got.status === 429 || got.status >= 500;
          if (!retryable || tryNo === 2) return { kind: "unknown" };
          const wait = got.kind === "response" ? retryAfterMsOf(got.retryAfter, 1000) : 1000;
          if (!waitFits(wait, budgetEnd, now())) return { kind: "unknown" };
          await sleep(wait);
        }
        return { kind: "unknown" };
      };
      for (;;) {
        if (attempts >= 3) return finish(unknown);
        const deadline = tryDeadlineOf(timeouts.releaseMs, budgetEnd, now());
        if (deadline === undefined) return finish(unknown);
        attempts += 1;
        const posted = await call("POST", `/exact/orders/${orderId}/release`, { requesterDigest: owner.requesterDigest }, { op: "facilitator_release", deadlineMs: deadline, auth: true, routeId: context.routeId });
        totalElapsed += posted.elapsedMs;
        lastStatus = httpStatusOf(posted);
        const classified = classifyReleasePost(posted, releaseContext);
        if (classified.action === "released") return finish({ outcome: "released", ...classified.ticket });
        if (classified.action === "refused") return finish(refused);
        if (classified.action === "unknown") {
          if (classified.note === "unauthorized") note("subetha-exact: facilitator refused the provider token at release (401)");
          return finish(unknown);
        }
        if (classified.action === "reconstruct") {
          const probed = await probe("claimed");
          if (probed.kind === "released") return finish(probed.result, true);
          return finish(probed.kind === "refused" ? refused : unknown);
        }
        if (classified.action === "probe") {
          const probed = await probe("transport");
          if (probed.kind === "released") return finish(probed.result, true);
          if (probed.kind !== "retry") return finish(unknown);
        }
        // 425 または「記録されていない」: 予算の内で待って再試行。
        const wait = posted.kind === "response" ? retryAfterMsOf(posted.retryAfter, timeouts.releaseRetryWaitMs) : timeouts.releaseRetryWaitMs;
        if (!waitFits(wait, budgetEnd, now())) return finish(unknown);
        await sleep(wait);
      }
    },

    async complete(offer: InboundOffer, deliveryKey: string, outcome: "delivered" | "failed", context: InboundCallContext): Promise<CompleteResult> {
      const orderId = lower(offer.extra.challengeNonce);
      const owner = attemptForOrder(orderId);
      if (owner?.created !== undefined && owner.created.tenant !== tenant) {
        // 別の tenant の注文（facilitator の URL が変わった後）: 呼ばない。恒久。
        note("subetha-exact: complete not reported: the order belongs to another tenant (facilitator URL changed)");
        await record(owner.attemptId, "complete", { orderId, outcome: "unreported", reported: outcome, attempts: 0, elapsedMs: 0, reason: "unknown_tenant" });
        return { outcome: "unreported", reason: "unknown_tenant" };
      }
      const budgetEnd = now() + timeouts.completeBudgetMs;
      let attempts = 0;
      let last: (CallOutcome & { elapsedMs: number }) | undefined;
      let totalElapsed = 0;
      const finish = async (result: CompleteResult): Promise<CompleteResult> => {
        if (owner !== undefined) await record(owner.attemptId, "complete", { orderId, outcome: result.outcome, reported: outcome, attempts, ...(last === undefined ? {} : httpStatusOf(last)), elapsedMs: Math.round(totalElapsed), ...(result.outcome === "unreported" ? { reason: result.reason } : {}) });
        return result;
      };
      for (;;) {
        if (attempts >= 2) return finish({ outcome: "unreported", reason: "unavailable" });
        const deadline = tryDeadlineOf(timeouts.completeMs, budgetEnd, now());
        if (deadline === undefined) return finish({ outcome: "unreported", reason: "unavailable" });
        attempts += 1;
        last = await call("POST", `/exact/orders/${orderId}/complete`, { deliveryKey, outcome }, { op: "facilitator_complete", deadlineMs: deadline, auth: true, routeId: context.routeId });
        totalElapsed += last.elapsedMs;
        const classified = classifyComplete(last, outcome);
        if (classified.action === "completed") return finish({ outcome: "completed" });
        if (classified.action === "unreported") {
          if (classified.reason === "unauthorized") note("subetha-exact: facilitator refused the provider token at complete (401)");
          return finish({ outcome: "unreported", reason: classified.reason });
        }
        const wait = last.kind === "response" ? retryAfterMsOf(last.retryAfter, timeouts.completeRetryWaitMs) : timeouts.completeRetryWaitMs;
        if (!waitFits(wait, budgetEnd, now())) return finish({ outcome: "unreported", reason: "unavailable" });
        await sleep(wait);
      }
    },
  };
  return rail;
}
