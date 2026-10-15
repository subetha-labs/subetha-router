/**
 * 診断の記録の「結果と外への要求が変わらない」の比較（設計 `docs/rejection-reasons-design.md` §8.2、タスク R-2）。**製品コードではない。**
 *
 * 同じ場面を sink を変えて動かし（(a) 無し、(b) 記録する sink、(c) 投げる sink、ほか任意の sink）、次を返す:
 * - core の返り値（quote・purchase・status。`updatedAt` は journal の時刻なので正規化）
 * - fake の rail が受けた要求の記録（method・引数の `stableJson`・順序・回数）
 * - journal の bytes（行の `at` は壁時計なので `-` に正規化。それ以外は注入した時計と `nextPaymentId` で決まる）・動的の控えの bytes
 * - 運用者の出口（transport の `report` → stderr の行。`diagnosticReportOf` で包んだもの）
 * 鍵・署名・送金・外への接続は無い。
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_DYNAMIC_LIMITS, type DynamicProfile, type RouterConfig } from "../../src/config.js";
import { stableJson } from "../../src/core/intent.js";
import { createRouterCore, type PurchaseOutcome, type QuoteOutcome, type RouterCore, type RouterCoreOptions } from "../../src/core/orchestrator.js";
import { diagnosticReportOf } from "../../src/main.js";
import { formatTransportEvent, TransportError, type TransportEvent } from "../../src/net/guarded-fetch.js";
import type { CreateOfferRequest, InboundCallContext, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayRequest, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";
import type { DiagnosticsSink } from "../../src/shared/diagnostics.js";

export const STATIC_ROUTE = "md-diag-static";
export const PROFILE_ID = "dyn-diag-mpp-to-x402";
export const PRINCIPAL = "alice";
export const SRC_NETWORK = "eip155:42431";
export const SRC_ASSET = "0x20c0000000000000000000000000000000000000";
export const DST_NETWORK = "eip155:84532";
export const DST_ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
export const DST_PAY_TO = "0x0000000000000000000000000000000000000a11";
export const UPSTREAM_URL = "https://provider.test/v1/price?symbol=ETH";
export const START_CLOCK = 1_800_000_000_000;

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

/** 決まった uuid（診断の `paymentId` の形 `^[0-9a-f-]{36}$`）。 */
export function uuidOf(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "mpp",
  source: { network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "x402",
  destination: { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 100, min: "1000" },
};

export function diagConfig(): RouterConfig {
  return {
    approvalTtlMs: 60_000,
    routes: {
      [STATIC_ROUTE]: {
        routeId: STATIC_ROUTE,
        canonicalPath: `/v1/routes/${STATIC_ROUTE}/resource`,
        source: { amount: "1500", asset: SRC_ASSET, decimals: 6, network: SRC_NETWORK },
        destination: { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, payTo: DST_PAY_TO },
      },
    },
    budget: {
      maxPurchases: 8,
      buckets: [
        { network: SRC_NETWORK, asset: SRC_ASSET, maxTotal: "100000", maxPerPurchase: "5000" },
        { network: DST_NETWORK, asset: DST_ASSET, maxTotal: "100000", maxPerPurchase: "5000" },
      ],
    },
    dynamic: {
      enabled: true,
      profiles: { [PROFILE_ID]: PROFILE },
      budget: {
        maxPurchases: 8,
        buckets: [
          { network: SRC_NETWORK, asset: SRC_ASSET, maxTotal: "1000000", maxPerPurchase: "200000" },
          { network: DST_NETWORK, asset: DST_ASSET, maxTotal: "1000000", maxPerPurchase: "200000" },
        ],
      },
      limits: { ...DEFAULT_DYNAMIC_LIMITS },
      denyHosts: [],
    },
  };
}

/** fake の rail が transport の出来事を報告する口（`composeRails` と同じ包み: `diagnosticReportOf(stderr, sink)`）。 */
export type Report = (event: TransportEvent) => void;

/** 受けた要求の記録の 1 件。 */
export interface CallRecord {
  readonly method: string;
  readonly args: string;
}

export type VerifyImpl = (ctx: { readonly report: Report; readonly context: InboundCallContext | undefined }) => Promise<{ isValid: boolean }>;
export type SettleImpl = (ctx: { readonly report: Report; readonly context: InboundCallContext | undefined }) => Promise<SettleResult>;
export type PayImpl = (ctx: { readonly report: Report; readonly request: PayRequest }) => Promise<PayResult>;

export class FakeInbound implements InboundRail {
  readonly calls: CallRecord[];
  verifyImpl: VerifyImpl = async () => ({ isValid: true });
  settleImpl: SettleImpl = async () => ({ outcome: "settled", txRef: "src-tx-1" });
  report: Report = () => {};
  #issued = 0;

  constructor(calls: CallRecord[]) {
    this.calls = calls;
  }

  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.calls.push({ method: "createOffer", args: stableJson(request) });
    this.#issued += 1;
    return {
      scheme: "tempo/charge",
      network: request.network,
      asset: request.asset,
      amount: request.amount,
      payTo: "0x00000000000000000000000000000000000000b0",
      maxTimeoutSeconds: 120,
      extra: { challengeNonce: `0x${this.#issued.toString(16).padStart(64, "0")}`, expiresAt: Math.floor(request.nowMs / 1000) + 60, routeBinding: request.routeBinding },
    };
  }

  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
    if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
    if (stableJson(credential.accepted) !== stableJson(offer)) return { ok: false, reason: "offer_mismatch" };
    return { ok: true };
  }

  async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean }> {
    this.calls.push({ method: "verify", args: stableJson({ offer, credential, context }) });
    return this.verifyImpl({ report: this.report, context });
  }

  async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
    this.calls.push({ method: "settle", args: stableJson({ offer, credential, context }) });
    return this.settleImpl({ report: this.report, context });
  }

  credentialFor(offer: InboundOffer): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, tag: "sig" } };
  }
}

export class FakeOutbound implements OutboundRail {
  readonly calls: CallRecord[];
  report: Report = () => {};
  offers: DestinationOffer[] = [{ scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, amount: "900", payTo: DST_PAY_TO, extra: { name: "USDC", version: "2" } }];
  readChallengeImpl: ((n: number) => Promise<readonly DestinationOffer[]>) | undefined;
  payImpl: PayImpl = async () => ({ outcome: "paid", body: { price: "3000" }, contentType: "application/json", txRef: "dst-tx-1" });
  #reads = 0;

  constructor(calls: CallRecord[]) {
    this.calls = calls;
  }

  async readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
    this.calls.push({ method: "readChallenge", args: stableJson({ routeId, target: target ?? null }) });
    this.#reads += 1;
    if (this.readChallengeImpl !== undefined) return this.readChallengeImpl(this.#reads);
    return this.offers;
  }

  async pay(request: PayRequest): Promise<PayResult> {
    this.calls.push({ method: "pay", args: stableJson(request) });
    return this.payImpl({ report: this.report, request });
  }
}

export interface ScenarioRails {
  readonly inbound: FakeInbound;
  readonly outbound: FakeOutbound;
  /** 注入した時計（試験が進められる）。 */
  readonly clock: { now: number };
}

export interface Scenario {
  readonly name: string;
  readonly kind: "static" | "dynamic";
  readonly arrange?: (rails: ScenarioRails) => void;
  /** 購入の後に core を閉じて同じ journal で開き直し、status を読む（AC-R2）。 */
  readonly restart?: boolean;
}

export interface ScenarioRun {
  readonly quote: unknown;
  readonly purchase: PurchaseOutcome;
  readonly status: unknown;
  readonly statusAfterRestart?: unknown;
  readonly calls: readonly CallRecord[];
  readonly journal: string;
  readonly ledger: string;
  readonly stderr: readonly string[];
  readonly paymentId: string | undefined;
  readonly quoteId: string | undefined;
}

/** journal の行の壁時計（`at`）・そこから写した `updatedAt`・動的の持ち主の証明の hash（乱数）を正規化する。 */
export function normalizeTimes(text: string): string {
  return text
    .replace(/"at":"[^"]*"/g, '"at":"-"')
    .replace(/"updatedAt":"[^"]*"/g, '"updatedAt":"-"')
    // 動的の持ち主の証明は quote ごとの乱数（その hash も）。sink に依らない値ではないので比べない。
    .replace(/"ownerKeyHash":"[^"]*"/g, '"ownerKeyHash":"-"');
}

async function dirText(dir: string): Promise<string> {
  const files = (await readdir(dir).catch(() => [] as string[])).sort();
  let out = "";
  for (const file of files) out += `${file}\n${await readFile(path.join(dir, file), "utf8").catch(() => "")}`;
  return normalizeTimes(out);
}

export interface RunOptions {
  /** 時計を sink から進める試験（§12.3）などのために、rail と時計を sink の作り手に渡す。 */
  readonly sinkOf?: (rails: ScenarioRails) => DiagnosticsSink | undefined;
  readonly sink?: DiagnosticsSink;
  /** 購入の応答の後・status の読み取りの前に呼ぶ（時計を進める sink の試験が、status の読み取りの時刻を戻す）。 */
  readonly afterPurchase?: (rails: ScenarioRails) => void;
  /** core に渡す追加の option（`diagnostics` 以外）。 */
  readonly coreOptions?: Partial<RouterCoreOptions>;
}

/** 1 つの場面を新しい作業領域で動かす（core の journal・控えも新しい）。 */
export async function runScenario(scenario: Scenario, options: RunOptions = {}): Promise<ScenarioRun> {
  await mkdir(runtimeRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(runtimeRoot, "diag-compare-"));
  try {
    const calls: CallRecord[] = [];
    const stderr: string[] = [];
    const rails: ScenarioRails = { inbound: new FakeInbound(calls), outbound: new FakeOutbound(calls), clock: { now: START_CLOCK } };
    const sink = options.sinkOf !== undefined ? options.sinkOf(rails) : options.sink;
    const report = diagnosticReportOf((event) => stderr.push(`${formatTransportEvent(event)}\n`), sink);
    rails.inbound.report = report;
    rails.outbound.report = report;
    scenario.arrange?.(rails);
    let ids = 0;
    const journalPath = path.join(workDir, "journal.ndjson");
    const ledgerDir = path.join(workDir, "dynamic-quotes");
    const open = (): Promise<RouterCore> =>
      createRouterCore({
        journalPath,
        config: diagConfig(),
        inbound: rails.inbound,
        outbound: rails.outbound,
        now: () => rails.clock.now,
        nextPaymentId: () => uuidOf((ids += 1)),
        dynamic: { ledgerDir },
        ...options.coreOptions,
        ...(sink === undefined ? {} : { diagnostics: sink }),
      });
    let core = await open();
    try {
      const requestId = `req-${scenario.name}`;
      const quote: QuoteOutcome =
        scenario.kind === "static"
          ? await core.quote({ principalId: PRINCIPAL, requestId, routeId: STATIC_ROUTE })
          : await core.quote({ principalId: PRINCIPAL, requestId, routeId: PROFILE_ID, upstream: { url: UPSTREAM_URL }, source: "src-1" });
      if (!quote.ok) throw new Error(`quote failed in scenario ${scenario.name}: ${quote.code}`);
      const credential = rails.inbound.credentialFor(quote.source.offer);
      const purchase = await core.purchase({
        principalId: PRINCIPAL,
        requestId,
        quoteId: quote.quoteId,
        approval: quote.quoteId,
        credential,
        ...(quote.ownerKey === undefined ? {} : { ownerKey: quote.ownerKey }),
        source: "src-1",
      });
      options.afterPurchase?.(rails);
      const status = core.status(quote.paymentId, PRINCIPAL, quote.ownerKey);
      let statusAfterRestart: unknown;
      if (scenario.restart === true) {
        await core.close();
        core = await open();
        statusAfterRestart = core.status(quote.paymentId, PRINCIPAL, quote.ownerKey);
      }
      // ownerKey は乱数（quote ごと）。比べる値からは除く（status の読み取りに使った値は同じ quote の値）。
      const { ownerKey: _ownerKey, ...quoteForCompare } = quote as unknown as Record<string, unknown>;
      return {
        quote: JSON.parse(normalizeTimes(JSON.stringify(quoteForCompare))),
        purchase,
        status: status === undefined ? undefined : JSON.parse(normalizeTimes(JSON.stringify(status))),
        ...(scenario.restart === true ? { statusAfterRestart: statusAfterRestart === undefined ? undefined : JSON.parse(normalizeTimes(JSON.stringify(statusAfterRestart))) } : {}),
        calls: [...calls],
        journal: normalizeTimes(await readFile(journalPath, "utf8").catch(() => "")),
        ledger: (await dirText(ledgerDir)).replace(/"ownerKeyHash":"[^"]*"/g, '"ownerKeyHash":"-"').replace(/"credentialDigest":"[^"]*"/g, '"credentialDigest":"-"'),
        stderr: [...stderr],
        paymentId: quote.paymentId,
        quoteId: quote.quoteId,
      };
    } finally {
      await core.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** fake の rail が投げる transport の失敗（固定の code。`report` も先に呼ぶ: 本物の transport と同じ順）。 */
export function transportFailure(report: Report, code: TransportEvent["code"], operation: string, routeId?: string): TransportError {
  report({ code, operation, policy: "test-policy", ...(routeId === undefined ? {} : { routeId }) });
  return new TransportError(code, { operation, ...(routeId === undefined ? {} : { routeId }) });
}

/** 場面（§8.2: 静的・動的の成功、verify の拒否・throw、settle の拒否・不明・throw、宛先の拒否・不明・未送出・throw、昇格の前の verify の失敗）。 */
export const SCENARIOS: readonly Scenario[] = [
  { name: "static-delivered", kind: "static" },
  { name: "static-verify-invalid", kind: "static", arrange: (r) => void (r.inbound.verifyImpl = async () => ({ isValid: false })) },
  {
    name: "static-verify-throws",
    kind: "static",
    arrange: (r) =>
      void (r.inbound.verifyImpl = async ({ report, context }) => {
        throw transportFailure(report, "upstream_timeout", "facilitator_verify", context?.routeId);
      }),
  },
  { name: "static-settle-rejected", kind: "static", arrange: (r) => void (r.inbound.settleImpl = async () => ({ outcome: "rejected", reason: "source_rejected" })) },
  { name: "static-settle-unknown", kind: "static", arrange: (r) => void (r.inbound.settleImpl = async () => ({ outcome: "unknown", reason: "source_settle_unknown" })) },
  {
    name: "static-settle-throws",
    kind: "static",
    arrange: (r) =>
      void (r.inbound.settleImpl = async ({ report, context }) => {
        throw transportFailure(report, "connect_failed", "facilitator_settle", context?.routeId);
      }),
  },
  { name: "static-dest-rejected", kind: "static", arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "rejected", reason: "destination_rejected" })) },
  { name: "static-dest-unknown", kind: "static", arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "unknown", reason: "destination_pay_unknown" })) },
  { name: "static-dest-not-sent", kind: "static", arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "not_sent", reason: "destination_deadline" })) },
  { name: "static-dest-paid-no-data", kind: "static", arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "paid_no_data", reason: "paid_data_unavailable" })) },
  {
    name: "static-dest-throws",
    kind: "static",
    arrange: (r) =>
      void (r.outbound.payImpl = async ({ report, request }) => {
        throw transportFailure(report, "upstream_timeout", "pay", request.routeId);
      }),
  },
  {
    name: "static-dest-offer-changed",
    kind: "static",
    // quote の読み・settle の前の読みは同じ、送金の前の読みだけ変わる（受信は成立済み → paid_undelivered）。
    arrange: (r) =>
      void (r.outbound.readChallengeImpl = async (n) => (n >= 3 ? [{ ...r.outbound.offers[0]!, amount: "901" }] : r.outbound.offers)),
  },
  { name: "dynamic-delivered", kind: "dynamic" },
  { name: "dynamic-verify-invalid", kind: "dynamic", arrange: (r) => void (r.inbound.verifyImpl = async () => ({ isValid: false })) },
  {
    name: "dynamic-verify-throws",
    kind: "dynamic",
    arrange: (r) =>
      void (r.inbound.verifyImpl = async ({ report, context }) => {
        throw transportFailure(report, "dns_failed", "facilitator_verify", context?.routeId);
      }),
  },
  { name: "dynamic-offer-changed", kind: "dynamic", arrange: (r) => void (r.outbound.readChallengeImpl = async (n) => (n >= 2 ? [{ ...r.outbound.offers[0]!, amount: "901" }] : r.outbound.offers)) },
  { name: "dynamic-settle-rejected", kind: "dynamic", arrange: (r) => void (r.inbound.settleImpl = async () => ({ outcome: "rejected", reason: "source_rejected" })) },
  {
    name: "dynamic-settle-throws",
    kind: "dynamic",
    arrange: (r) =>
      void (r.inbound.settleImpl = async ({ report, context }) => {
        throw transportFailure(report, "aborted", "facilitator_settle", context?.routeId);
      }),
  },
  { name: "dynamic-dest-rejected", kind: "dynamic", arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "rejected", reason: "destination_rejected" })) },
  { name: "dynamic-dest-unknown", kind: "dynamic", arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "unknown", reason: "destination_pay_unknown" })) },
  { name: "dynamic-dest-not-sent", kind: "dynamic", arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "not_sent", reason: "destination_offer_changed" })) },
  {
    name: "dynamic-dest-throws",
    kind: "dynamic",
    arrange: (r) =>
      void (r.outbound.payImpl = async ({ report, request }) => {
        throw transportFailure(report, "transport_failed", "pay", request.routeId);
      }),
  },
];
