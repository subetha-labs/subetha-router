import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { RouterConfig } from "../../src/config.js";
import { stableJson } from "../../src/core/intent.js";
import { createRouterCore, type RouterCore } from "../../src/core/orchestrator.js";
import type {
  CreateOfferRequest,
  InboundOffer,
  InboundRail,
  PaymentCredential,
  PreflightResult,
  SettleResult,
} from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayRequest, PayResult } from "../../src/ports/outbound.js";

const ROUTE_ID = "md-a-eth-snapshot";
const SOURCE_NETWORK = "eip155:11155111";
const SOURCE_ASSET = "0x5o0rce";
const DEST_NETWORK = "eip155:84532";
const DEST_ASSET = "0xde57";
const UPSTREAM_BODY = { providerId: "provider-a", market: "ETH", data: { price: "3000" } };

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

function baseConfig(): RouterConfig {
  return {
    approvalTtlMs: 60_000,
    routes: {
      [ROUTE_ID]: {
        routeId: ROUTE_ID,
        canonicalPath: `/v1/routes/${ROUTE_ID}/resource`,
        source: { amount: "1500", asset: SOURCE_ASSET, decimals: 6, network: SOURCE_NETWORK },
        destination: {
          scheme: "exact",
          network: DEST_NETWORK,
          asset: DEST_ASSET,
          payTo: "0xprovidera",
        },
      },
    },
    budget: {
      maxPurchases: 4,
      buckets: [
        {
          network: SOURCE_NETWORK,
          asset: SOURCE_ASSET,
          maxTotal: "10000",
          maxPerPurchase: "5000",
        },
        { network: DEST_NETWORK, asset: DEST_ASSET, maxTotal: "10000", maxPerPurchase: "5000" },
      ],
    },
  };
}

/** 鍵も署名も送金もない、同一プロセス内の合成受信レール（synthetic・無課金）。 */
class SyntheticInbound implements InboundRail {
  verifyCalls = 0;
  settleCalls = 0;
  settleResult: SettleResult = { outcome: "settled", txRef: "src-tx-1" };
  #issued = 0;

  /** 並行 quote が同じ nonce を受け取る状況を作るための固定値。 */
  fixedNonce?: string;
  /** offer の `extra` に足す欄（例: `fundsMoveOnCredential: true` = credential の時点で資金が動く push 形の受信）。 */
  extraPatch: Record<string, unknown> = {};
  /** 設定と食い違う offer を発行する adapter を再現する。 */
  offerOverride?: Partial<{
    amount: string;
    asset: string;
    network: string;
    routeBinding: string;
  }>;

  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.#issued += 1;
    if (this.fixedNonce !== undefined) {
      return {
        scheme: "subetha-zerc20",
        network: request.network,
        asset: request.asset,
        amount: request.amount,
        payTo: "0xrouter",
        maxTimeoutSeconds: 120,
        extra: {
          challengeNonce: this.fixedNonce,
          expiresAt: Math.floor(request.nowMs / 1000) + 60,
          routeBinding: request.routeBinding,
        },
      };
    }
    return {
      scheme: "subetha-zerc20",
      network: this.offerOverride?.network ?? request.network,
      asset: this.offerOverride?.asset ?? request.asset,
      amount: this.offerOverride?.amount ?? request.amount,
      payTo: "0xrouter",
      maxTimeoutSeconds: 120,
      extra: {
        challengeNonce: `0xnonce${this.#issued}`,
        expiresAt: Math.floor(request.nowMs / 1000) + 60,
        routeBinding: this.offerOverride?.routeBinding ?? request.routeBinding,
        ...this.extraPatch,
      },
    };
  }

  /** preflight を必ず失敗させ、その理由文字列を差し替える。 */
  preflightReason?: string;
  /** settle に実際に渡された資格情報。 */
  settledWith?: PaymentCredential;

  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (this.preflightReason !== undefined) {
      return { ok: false, reason: this.preflightReason };
    }
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) {
      return { ok: false, reason: "nonce_mismatch" };
    }
    if (offer.extra.expiresAt * 1000 <= nowMs) {
      return { ok: false, reason: "offer_expired" };
    }
    if (stableJson(credential.accepted) !== stableJson(offer)) {
      return { ok: false, reason: "offer_mismatch" };
    }
    return { ok: true };
  }

  /** 実レール側の障害（例外）を再現するためのフック。 */
  verifyImpl?: () => Promise<{ isValid: boolean }>;
  settleImpl?: () => Promise<SettleResult>;

  async verify(): Promise<{ isValid: boolean }> {
    this.verifyCalls += 1;
    if (this.verifyImpl !== undefined) {
      return this.verifyImpl();
    }
    return { isValid: true };
  }

  async settle(_offer: InboundOffer, credential: PaymentCredential): Promise<SettleResult> {
    this.settleCalls += 1;
    this.settledWith = credential;
    if (this.settleImpl !== undefined) {
      return this.settleImpl();
    }
    return this.settleResult;
  }

  credentialFor(offer: InboundOffer): PaymentCredential {
    return {
      x402Version: 2,
      accepted: offer,
      payload: { challengeNonce: offer.extra.challengeNonce },
    };
  }
}

/** 同一プロセス内の合成送信レール（synthetic・無課金）。 */
class SyntheticOutbound implements OutboundRail {
  payCalls = 0;
  readChallengeCalls = 0;
  paidFor: PayRequest[] = [];
  offer: DestinationOffer = {
    scheme: "exact",
    network: DEST_NETWORK,
    asset: DEST_ASSET,
    amount: "900",
    payTo: "0xprovidera",
  };
  payResult: PayResult = {
    outcome: "paid",
    body: UPSTREAM_BODY,
    contentType: "application/json",
    txRef: "dst-tx-1",
  };

  /** 読み直しのたびに提示が変わる状況を作るためのフック。 */
  readChallengeImpl?: (call: number) => readonly DestinationOffer[];

  async readChallenge(): Promise<readonly DestinationOffer[]> {
    this.readChallengeCalls += 1;
    if (this.readChallengeImpl !== undefined) {
      return this.readChallengeImpl(this.readChallengeCalls);
    }
    return [this.offer];
  }

  /** 特定テストだけが差し替える送出の振る舞い（クラッシュ再現など）。 */
  payImpl?: (request: PayRequest) => Promise<PayResult>;

  async pay(request: PayRequest): Promise<PayResult> {
    this.payCalls += 1;
    this.paidFor.push(request);
    if (this.payImpl !== undefined) {
      return this.payImpl(request);
    }
    return this.payResult;
  }
}

let workDir: string;
let journalPath: string;
let issuedIds = 0;
let inbound: SyntheticInbound;
let outbound: SyntheticOutbound;
const opened: RouterCore[] = [];

async function boot(config: RouterConfig = baseConfig()): Promise<RouterCore> {
  // 決定的だが再起動をまたいでも重複しない id（テスト内で通番）。
  return bootWithIds(() => `pay-${(issuedIds += 1)}`, config);
}

async function bootWithIds(
  nextPaymentId: () => string,
  config: RouterConfig = baseConfig(),
): Promise<RouterCore> {
  const core = await createRouterCore({ journalPath, config, inbound, outbound, nextPaymentId });
  opened.push(core);
  return core;
}

/** id を注入しない（本番既定の生成器を使う）起動。 */
async function bootDefaultIds(config: RouterConfig = baseConfig()): Promise<RouterCore> {
  const core = await createRouterCore({ journalPath, config, inbound, outbound });
  opened.push(core);
  return core;
}

/** 公開射影から送信レグの分類だけを取り出す。 */
function outcomeOfDestination(core: RouterCore, paymentId: string): string | undefined {
  return core.status(paymentId, "alice")?.destination.outcome;
}

/** journal に残った行のうち、指定 event の数を数える。 */
async function countEvents(event: string): Promise<number> {
  const text = await readFile(journalPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { event: string })
    .filter((record) => record.event === event).length;
}

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "t1a-lifecycle-"));
  journalPath = path.join(workDir, "journal.ndjson");
  issuedIds = 0;
  inbound = new SyntheticInbound();
  outbound = new SyntheticOutbound();
});

afterEach(async () => {
  for (const core of opened.splice(0)) {
    await core.close().catch(() => undefined);
  }
  await rm(workDir, { recursive: true, force: true });
});

/** 合成レールに対する承認済みの正常な購入引数。 */
function purchaseArgs(
  quote: { quoteId: string; source: { offer: InboundOffer } },
  requestId = "req-1",
) {
  return {
    principalId: "alice",
    requestId,
    quoteId: quote.quoteId,
    approval: quote.quoteId,
    credential: inbound.credentialFor(quote.source.offer),
  };
}

test("同一 (principal, requestId) の並行 quote は 1 つの quoteId に収束する", async () => {
  const core = await boot();
  const request = { principalId: "alice", requestId: "req-1", routeId: ROUTE_ID };

  const [first, second] = await Promise.all([core.quote(request), core.quote(request)]);
  expect(first?.ok).toBe(true);
  expect(second?.ok).toBe(true);
  if (first?.ok !== true || second?.ok !== true) {
    return;
  }

  expect(second.quoteId).toBe(first.quoteId);
  expect(second.paymentId).toBe(first.paymentId);
  // 課金対象レコードを 2 本作らない。
  expect(await countEvents("created")).toBe(1);
});

test("同一 quoteId の並行 purchase でも受信 settle と送信 pay は 1 回だけ", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const [first, second] = await Promise.all([
    core.purchase(purchaseArgs(quote)),
    core.purchase(purchaseArgs(quote)),
  ]);

  expect(inbound.settleCalls).toBe(1);
  expect(outbound.payCalls).toBe(1);
  expect([first?.status, second?.status]).toContain("delivered");
  expect(await countEvents("source_settled")).toBe(1);
  expect(await countEvents("destination_pending")).toBe(1);
});

test("再起動後の新しい quote は既存 payment を別名で上書きしない", async () => {
  // 再起動で id 生成器がリセットされた（= 同じ id を再び返す）状況を作る。
  const core = await bootWithIds(() => "pay-1");
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }
  expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
  await core.close();

  // 既存 paymentId を再利用しようとしたら fail closed にする。
  const restarted = await bootWithIds(() => "pay-1");
  const collided = await restarted.quote({
    principalId: "mallory",
    requestId: "req-9",
    routeId: ROUTE_ID,
  });
  expect(collided.ok).toBe(false);
  if (!collided.ok) {
    expect(collided.code).toBe("payment_id_collision");
  }

  // 既存の結果と所有 principal は動かない。
  expect(restarted.status(quote.paymentId, "alice")?.status).toBe("delivered");
  expect(restarted.status(quote.paymentId, "mallory")).toBeUndefined();
});

test("既定の paymentId 生成は再起動をまたいで衝突しない", async () => {
  const core = await bootDefaultIds();
  const first = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(first.ok).toBe(true);
  if (!first.ok) {
    return;
  }
  await core.close();

  const restarted = await bootDefaultIds();
  const second = await restarted.quote({
    principalId: "bob",
    requestId: "req-2",
    routeId: ROUTE_ID,
  });
  expect(second.ok).toBe(true);
  if (!second.ok) {
    return;
  }
  expect(second.paymentId).not.toBe(first.paymentId);
  expect(restarted.status(first.paymentId, "alice")?.status).toBe("awaiting_payment");
});

test("送信応答が null でも durable な unknown になり、再送しない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  outbound.payImpl = async () => null as unknown as PayResult;
  const result = await core.purchase(purchaseArgs(quote));

  expect(result.status).toBe("unknown");
  expect(result.terminalReason).toBe("destination_pay_unknown");
  expect(await countEvents("unknown")).toBe(1);

  await core.close();
  const restarted = await boot();
  expect(restarted.status(quote.paymentId, "alice")?.status).toBe("unknown");
  expect((await restarted.purchase(purchaseArgs(quote))).status).toBe("unknown");
  expect(outbound.payCalls).toBe(1);
});

test("preflight の理由は固定コードに正規化され、秘密を出さない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  inbound.preflightReason = `nonce_mismatch ${SECRET_IN_ERROR}`;
  const result = await core.purchase(purchaseArgs(quote));

  expect(result.code).toBe("preflight_failed");
  expect(JSON.stringify(result)).not.toContain("s3cret");
  expect(await readFile(journalPath, "utf8")).not.toContain("s3cret");
  expect(inbound.verifyCalls).toBe(0);
  expect(inbound.settleCalls).toBe(0);
});

test("verify 中に承認期限を過ぎ、offer が fundsMoveOnCredential: true（push 形。adapter は fundsMoved を返さない）なら、not_sent ではなく耐久的な unknown（source_paid_unsettled）。settle は呼ばない", async () => {
  let clock = 1_700_000_000_000;
  const config: RouterConfig = { ...baseConfig(), approvalTtlMs: 30_000 };
  const core = await createRouterCore({ journalPath, config, inbound, outbound, now: () => clock, nextPaymentId: () => "pay-1" });
  opened.push(core);
  inbound.extraPatch = { fundsMoveOnCredential: true };
  try {
    const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect(quote.source.offer.extra["fundsMoveOnCredential"]).toBe(true);
    inbound.verifyImpl = async () => {
      clock = quote.approval.deadlineMs;
      return { isValid: true };
    };
    const result = await core.purchase(purchaseArgs(quote));
    expect(result).toMatchObject({ status: "unknown", terminalReason: "source_paid_unsettled" });
    expect(inbound.settleCalls).toBe(0);
    expect(outbound.payCalls).toBe(0);
    expect(core.status(quote.paymentId, "alice")).toMatchObject({ status: "unknown", terminalReason: "source_paid_unsettled" });
    // 再提示も同じ終端（settle は呼ばれない）。
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "unknown", terminalReason: "source_paid_unsettled" });
    expect(inbound.settleCalls).toBe(0);
  } finally {
    inbound.extraPatch = {};
  }
});

test("verify 中に承認期限を過ぎたら settle せず、未送信の終端として保存する", async () => {
  let clock = 1_700_000_000_000;
  const config: RouterConfig = { ...baseConfig(), approvalTtlMs: 30_000 };
  const core = await createRouterCore({
    journalPath,
    config,
    inbound,
    outbound,
    now: () => clock,
    nextPaymentId: () => "pay-1",
  });
  opened.push(core);

  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  // verify の最中に時計だけを進める（タイマーは使わない）。期限と等しい時刻は期限切れ。
  inbound.verifyImpl = async () => {
    clock = quote.approval.deadlineMs;
    return { isValid: true };
  };

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.code).toBe("approval_expired");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);

  const projection = core.status(quote.paymentId, "alice");
  expect(projection?.status).toBe("awaiting_payment");
  expect(projection?.destination.outcome).toBe("none");
  expect(await countEvents("source_failed")).toBe(1);
});

test("verify 待機中に呼び出し側が資格情報を差し替えても、検証した値で settle する", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const args = purchaseArgs(quote);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  inbound.verifyImpl = async () => {
    await gate;
    return { isValid: true };
  };

  const pending = core.purchase(args);
  // preflight 通過後・settle 前に、呼び出し側が自分の可変オブジェクトを書き換える。
  (args.credential.payload as { challengeNonce: string }).challengeNonce = "0xtampered";
  (args as { principalId: string }).principalId = "mallory";
  release();

  const result = await pending;
  expect(result.status).toBe("delivered");
  expect(inbound.settledWith?.payload.challengeNonce).toBe(quote.quoteId);
  expect(core.status(quote.paymentId, "alice")?.status).toBe("delivered");
});

test("delivered の応答は永続化済みの結果を読み戻した値になる", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const adapterBody = { providerId: "provider-a", data: { price: "3000" } };
  outbound.payImpl = async () => ({
    outcome: "paid",
    body: adapterBody,
    contentType: "application/json",
    txRef: "dst-tx-1",
  });

  const result = await core.purchase(purchaseArgs(quote));
  // fsync 後に adapter 所有のオブジェクトが変わっても、返した結果は動かない。
  adapterBody.data.price = "999999";

  expect(result.body).toEqual({ providerId: "provider-a", data: { price: "3000" } });
  expect(core.status(quote.paymentId, "alice")?.result).toEqual(result.body);
});

test("承認期限は絶対時刻で offer 失効に丸められ、超過後は支払いを開始しない", async () => {
  let clock = 1_700_000_000_000;
  // TTL（10 分）は offer の失効（60 秒）より長い。上限は offer 側で切られる。
  const config: RouterConfig = { ...baseConfig(), approvalTtlMs: 600_000 };
  const core = await createRouterCore({
    journalPath,
    config,
    inbound,
    outbound,
    now: () => clock,
    nextPaymentId: () => "pay-1",
  });
  opened.push(core);

  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }
  const offerExpiryMs = quote.source.offer.extra.expiresAt * 1000;
  expect(quote.approval.deadlineMs).toBe(offerExpiryMs);
  expect(quote.approval.deadlineMs).toBeLessThan(clock + config.approvalTtlMs);

  clock = offerExpiryMs + 1;
  const expired = await core.purchase(purchaseArgs(quote));
  expect(expired.code).toBe("approval_expired");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);

  // 期限は journal に載っており、再起動後も同じ値で判断される。
  await core.close();
  const restarted = await createRouterCore({
    journalPath,
    config,
    inbound,
    outbound,
    now: () => clock,
    nextPaymentId: () => "pay-2",
  });
  opened.push(restarted);
  const reQuoted = await restarted.quote({
    principalId: "alice",
    requestId: "req-1",
    routeId: ROUTE_ID,
  });
  expect(reQuoted.ok).toBe(true);
  if (reQuoted.ok) {
    expect(reQuoted.approval.deadlineMs).toBe(offerExpiryMs);
  }
  expect((await restarted.purchase(purchaseArgs(quote))).code).toBe("approval_expired");
  expect(inbound.settleCalls).toBe(0);
});

test("quoteFingerprint は canonical offer の sha256 であって生の JSON ではない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const digest = createHash("sha256").update(stableJson(outbound.offer), "utf8").digest("hex");
  expect(quote.destination.quoteFingerprint).toBe(`sha256:${digest}`);
  // 生の offer 内容（payTo など）をそのまま持ち回らない。
  expect(quote.destination.quoteFingerprint).not.toContain("payTo");
});

test("設定と食い違う受信 offer を発行した場合は quote を成立させない", async () => {
  const core = await boot();

  inbound.offerOverride = { amount: "999" };
  const wrongAmount = await core.quote({
    principalId: "alice",
    requestId: "req-1",
    routeId: ROUTE_ID,
  });
  expect(wrongAmount.ok).toBe(false);
  if (!wrongAmount.ok) {
    expect(wrongAmount.code).toBe("source_terms_mismatch");
  }

  inbound.offerOverride = { routeBinding: "other-route|GET|%2Fv1%2Fother" };
  const wrongBinding = await core.quote({
    principalId: "alice",
    requestId: "req-2",
    routeId: ROUTE_ID,
  });
  expect(wrongBinding.ok).toBe(false);
  if (!wrongBinding.ok) {
    expect(wrongBinding.code).toBe("source_terms_mismatch");
  }

  expect(await countEvents("created")).toBe(0);
});

test("解釈できない settle 応答を成立扱いにせず、送信レグを開始しない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  // 契約にない outcome。型の上では通っても成立とは読まない。
  inbound.settleImpl = async () =>
    ({ outcome: "accepted-ish", transaction: "0xabc" }) as unknown as SettleResult;
  const malformed = await core.purchase(purchaseArgs(quote));
  expect(malformed.status).toBe("unknown");
  expect(malformed.terminalReason).toBe("source_settle_unknown");
  expect(outcomeOfDestination(core, quote.paymentId)).toBe("none");
  expect(outbound.payCalls).toBe(0);

  // txRef を欠いた `settled` も証跡がないので成立扱いにしない。
  const second = await core.quote({ principalId: "alice", requestId: "req-2", routeId: ROUTE_ID });
  expect(second.ok).toBe(true);
  if (!second.ok) {
    return;
  }
  inbound.settleImpl = async () => ({ outcome: "settled" }) as unknown as SettleResult;
  const noEvidence = await core.purchase(purchaseArgs(second, "req-2"));
  expect(noEvidence.status).toBe("unknown");
  expect(outbound.payCalls).toBe(0);
});

test("verify が false を返したら settle せず、送信レグにも進まない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  inbound.verifyImpl = async () => ({ isValid: false });
  const result = await core.purchase(purchaseArgs(quote));

  expect(result.status).toBe("awaiting_payment");
  expect(result.code).toBe("verify_failed");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
  // 受信が成立していない以上、送信レグは手つかずのまま。
  expect(outcomeOfDestination(core, quote.paymentId)).toBe("none");
});

test("verify が成立しない credential を繰り返しても通算予算は減らない（再起動後も）", async () => {
  // 予約は回復しないので、verify より前に取ると「署名の無効な credential」だけで枠が尽きる。
  const config = baseConfig();
  const limited = { ...config, budget: { ...config.budget, maxPurchases: 1 } };
  const core = await boot(limited);

  inbound.verifyImpl = async () => ({ isValid: false });
  for (const requestId of ["bad-1", "bad-2", "bad-3"]) {
    const quote = await core.quote({ principalId: "alice", requestId, routeId: ROUTE_ID });
    expect(quote.ok).toBe(true);
    if (!quote.ok) {
      return;
    }
    expect((await core.purchase(purchaseArgs(quote, requestId))).code).toBe("verify_failed");
  }
  expect(inbound.verifyCalls).toBe(3);
  expect(await countEvents("budget_reserved")).toBe(0);
  await core.close();

  // 件数上限は 1。無効な 3 件が枠を使っていれば、正当な 1 件は `purchase_count_limit` で止まる。
  const restarted = await boot(limited);
  delete inbound.verifyImpl;
  const paid = await restarted.quote({ principalId: "alice", requestId: "good", routeId: ROUTE_ID });
  expect(paid.ok).toBe(true);
  if (!paid.ok) {
    return;
  }
  expect((await restarted.purchase(purchaseArgs(paid, "good"))).status).toBe("delivered");
  expect(await countEvents("budget_reserved")).toBe(1);
});

test("verify の応答が取れない試行は settle を呼ばず、予約も取らない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  inbound.verifyImpl = async () => {
    throw new Error("facilitator unavailable");
  };
  const result = await core.purchase(purchaseArgs(quote));

  expect(result.status).toBe("unknown");
  expect(result.terminalReason).toBe("source_verify_unavailable");
  expect(inbound.settleCalls).toBe(0);
  expect(await countEvents("budget_reserved")).toBe(0);
});

test("verify の間に期限が切れた試行は settle を呼ばず、予約も取らない", async () => {
  let clock = 1_700_000_000_000;
  const core = await createRouterCore({
    journalPath,
    config: baseConfig(),
    inbound,
    outbound,
    now: () => clock,
    nextPaymentId: () => "pay-1",
  });
  opened.push(core);
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  inbound.verifyImpl = async () => {
    clock = quote.approval.deadlineMs;
    return { isValid: true };
  };
  const result = await core.purchase(purchaseArgs(quote));

  expect(result.code).toBe("approval_expired");
  expect(inbound.settleCalls).toBe(0);
  expect(await countEvents("budget_reserved")).toBe(0);
});

test("settle を呼ぶ時点では予約行が journal に書かれている", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  let reservedAtSettle = -1;
  inbound.settleImpl = async () => {
    reservedAtSettle = await countEvents("budget_reserved");
    return { outcome: "unknown", reason: "timeout" } as unknown as SettleResult;
  };
  const result = await core.purchase(purchaseArgs(quote));

  expect(result.status).toBe("unknown");
  expect(reservedAtSettle).toBe(1);
});

test("同じ id を返す並行 quote は 1 件しか成立せず、journal も壊れない", async () => {
  const core = await bootWithIds(() => "pay-1");
  inbound.fixedNonce = "0xnoncefixed";

  const [first, second] = await Promise.all([
    core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID }),
    core.quote({ principalId: "alice", requestId: "req-2", routeId: ROUTE_ID }),
  ]);

  expect([first?.ok, second?.ok].filter((ok) => ok === true)).toHaveLength(1);
  expect(await countEvents("created")).toBe(1);

  // 壊れた journal を残さない（再起動が replay できる）。
  await core.close();
  const restarted = await bootWithIds(() => "pay-2");
  expect(restarted.status("pay-1", "alice")?.status).toBe("awaiting_payment");
});

test("中断された pending は再起動時に unknown として journal に追記される", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  outbound.payImpl = async () => {
    await core.close();
    throw new Error("process died");
  };
  await expect(core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();

  const restarted = await boot();
  expect(restarted.status(quote.paymentId, "alice")?.status).toBe("unknown");
  // メモリ上だけの確定にしない。
  expect(await countEvents("unknown")).toBe(1);

  await restarted.close();
  const again = await boot();
  expect(again.status(quote.paymentId, "alice")?.status).toBe("unknown");
  // 再起動のたびに同じ行を積まない。
  expect(await countEvents("unknown")).toBe(1);
});

test("承認済み selectedOffer は adapter 側のオブジェクト変更で書き換わらない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  // quote 時に adapter が返したオブジェクトを、同じ参照のまま後から書き換える。
  (outbound.offer as { amount: string }).amount = "1";

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.code).toBe("offer_changed");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
});

test("予算の残枠検査と予約は不可分で、超過した側は受信 settle を開始しない", async () => {
  const config = baseConfig();
  const core = await boot({ ...config, budget: { ...config.budget, maxPurchases: 1 } });

  const first = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  const second = await core.quote({ principalId: "alice", requestId: "req-2", routeId: ROUTE_ID });
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) {
    return;
  }

  const [a, b] = await Promise.all([
    core.purchase(purchaseArgs(first, "req-1")),
    core.purchase(purchaseArgs(second, "req-2")),
  ]);

  expect([a?.status, b?.status].sort()).toEqual(["awaiting_payment", "delivered"]);
  expect([a, b].find((result) => result?.status === "awaiting_payment")?.code).toBe(
    "purchase_count_limit",
  );
  // 枠を取れなかった側は受信決済に入らない（支払い後に枠不足が判明する順序にしない）。
  expect(inbound.settleCalls).toBe(1);
  expect(outbound.payCalls).toBe(1);
});

test("1 件あたりの上限を超える購入は受信 settle を開始しない", async () => {
  const config = baseConfig();
  const core = await boot({
    ...config,
    budget: {
      ...config.budget,
      buckets: config.budget.buckets.map((bucket) =>
        bucket.asset === SOURCE_ASSET ? { ...bucket, maxPerPurchase: "1000" } : bucket,
      ),
    },
  });

  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.status).toBe("awaiting_payment");
  expect(result.code).toBe("per_purchase_limit");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
  expect(await countEvents("budget_reserved")).toBe(0);
});

test("受信と送信が同一バケットなら合算して残枠を検査する", async () => {
  // source 1500 と destination 900 は単独では通るが、合算 2400 は 2000 を超える。
  outbound.offer = { ...outbound.offer, network: SOURCE_NETWORK, asset: SOURCE_ASSET };
  const config = baseConfig();
  const core = await boot({
    ...config,
    routes: {
      [ROUTE_ID]: {
        ...config.routes[ROUTE_ID]!,
        destination: {
          ...config.routes[ROUTE_ID]!.destination,
          network: SOURCE_NETWORK,
          asset: SOURCE_ASSET,
        },
      },
    },
    budget: {
      ...config.budget,
      buckets: [
        {
          network: SOURCE_NETWORK,
          asset: SOURCE_ASSET,
          maxTotal: "2000",
          maxPerPurchase: "5000",
        },
      ],
    },
  });

  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.code).toBe("bucket_limit");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
});

test("負値や非数値の金額は予約せず、課金レグを開始しない", async () => {
  const core = await boot();

  outbound.offer = { ...outbound.offer, amount: "-500" };
  const negative = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(negative.ok).toBe(true);
  if (!negative.ok) {
    return;
  }
  expect((await core.purchase(purchaseArgs(negative))).code).toBe("invalid_amount");

  outbound.offer = { ...outbound.offer, amount: "1e3" };
  const malformed = await core.quote({
    principalId: "alice",
    requestId: "req-2",
    routeId: ROUTE_ID,
  });
  expect(malformed.ok).toBe(true);
  if (!malformed.ok) {
    return;
  }
  expect((await core.purchase(purchaseArgs(malformed, "req-2"))).code).toBe("invalid_amount");

  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
  expect(await countEvents("budget_reserved")).toBe(0);
});

test("unknown で終わった購入の予約は再起動後も枠を保持する", async () => {
  const config = baseConfig();
  // source 1500 × 2 = 3000 > 2500。1 件目が unknown でも枠は解放しない。
  const core = await boot({
    ...config,
    budget: {
      ...config.budget,
      buckets: config.budget.buckets.map((bucket) =>
        bucket.asset === SOURCE_ASSET ? { ...bucket, maxTotal: "2500" } : bucket,
      ),
    },
  });

  const first = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(first.ok).toBe(true);
  if (!first.ok) {
    return;
  }
  outbound.payResult = { outcome: "unknown", reason: "upstream_timeout" };
  expect((await core.purchase(purchaseArgs(first))).status).toBe("unknown");
  await core.close();

  const restarted = await boot({
    ...config,
    budget: {
      ...config.budget,
      buckets: config.budget.buckets.map((bucket) =>
        bucket.asset === SOURCE_ASSET ? { ...bucket, maxTotal: "2500" } : bucket,
      ),
    },
  });
  const second = await restarted.quote({
    principalId: "alice",
    requestId: "req-2",
    routeId: ROUTE_ID,
  });
  expect(second.ok).toBe(true);
  if (!second.ok) {
    return;
  }
  const blocked = await restarted.purchase(purchaseArgs(second, "req-2"));
  expect(blocked.code).toBe("bucket_limit");
  // 自動解放も自動再送もしない。
  expect(inbound.settleCalls).toBe(1);
  expect(outbound.payCalls).toBe(1);
});

test("承認・所有・requestId・資格情報・offer の不一致では課金レグを開始しない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  const { approval: _approval, ...withoutApproval } = purchaseArgs(quote);
  expect((await core.purchase(withoutApproval)).code).toBe("approval_required");
  expect((await core.purchase({ ...purchaseArgs(quote), approval: "0xnotthisquote" })).code).toBe(
    "approval_required",
  );

  const byOther = await core.purchase({ ...purchaseArgs(quote), principalId: "mallory" });
  expect(byOther.code).toBe("not_owner");
  expect(core.status(quote.paymentId, "mallory")).toBeUndefined();

  // 別 requestId から同じ quote を買い直させない。
  expect((await core.purchase(purchaseArgs(quote, "req-2"))).code).toBe("request_id_conflict");

  const { credential: _credential, ...withoutCredential } = purchaseArgs(quote);
  expect((await core.purchase(withoutCredential)).code).toBe("payment_required");

  const tampered = {
    ...purchaseArgs(quote),
    credential: {
      ...inbound.credentialFor(quote.source.offer),
      accepted: { ...quote.source.offer, amount: "1" },
    },
  };
  expect((await core.purchase(tampered)).code).toBe("offer_mismatch");

  expect(inbound.verifyCalls).toBe(0);
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
  expect(core.status(quote.paymentId, "alice")?.status).toBe("awaiting_payment");

  // 正しい承認と資格情報なら同じ quote がそのまま使える。
  expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
});

const SECRET_IN_ERROR = "https://facilitator.internal/verify?token=s3cret";

test("verify の例外は durable な unknown で終わり、settle も pay もしない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  inbound.verifyImpl = () => {
    throw new Error(`connect ECONNREFUSED ${SECRET_IN_ERROR}`);
  };

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.status).toBe("unknown");
  expect(result.terminalReason).toBe("source_verify_unavailable");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);

  // 例外文字列（上流 URL・トークン）を journal にも公開射影にも出さない。
  expect(await readFile(journalPath, "utf8")).not.toContain("s3cret");
  expect(JSON.stringify(core.status(quote.paymentId, "alice"))).not.toContain("s3cret");

  await core.close();
  const restarted = await boot();
  expect(restarted.status(quote.paymentId, "alice")?.status).toBe("unknown");
  expect((await restarted.purchase(purchaseArgs(quote))).status).toBe("unknown");
  expect(inbound.settleCalls).toBe(0);
});

test("settle の例外は unknown を durable に記録し、自動再 settle しない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  inbound.settleImpl = () => {
    throw new Error("socket hang up");
  };

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.status).toBe("unknown");
  expect(result.terminalReason).toBe("source_settle_unknown");
  expect(outbound.payCalls).toBe(0);

  await core.close();
  const restarted = await boot();
  expect(restarted.status(quote.paymentId, "alice")?.status).toBe("unknown");
  expect((await restarted.purchase(purchaseArgs(quote))).status).toBe("unknown");
  // 送金有無が不明な受信レグを勝手に叩き直さない。
  expect(inbound.settleCalls).toBe(1);
});

test("受信 settle 前の challenge 読み取り失敗では、どちらのレグも開始しない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  outbound.readChallengeImpl = (call) => {
    if (call === 2) {
      throw new Error("upstream unreachable");
    }
    return [outbound.offer];
  };

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.status).toBe("awaiting_payment");
  expect(result.code).toBe("offer_unavailable");
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);

  // この quote では以後も支払いを始めない（新しい quote と再承認が要る）。
  delete outbound.readChallengeImpl;
  expect((await core.purchase(purchaseArgs(quote))).status).toBe("awaiting_payment");
  expect(inbound.settleCalls).toBe(0);
});

test("受信成立後の challenge 読み取り失敗は、送金せず非再送の終端で終わる", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  outbound.readChallengeImpl = (call) => {
    if (call >= 3) {
      throw new Error("upstream unreachable");
    }
    return [outbound.offer];
  };

  const result = await core.purchase(purchaseArgs(quote));
  expect(result.status).toBe("paid_data_unavailable");
  expect(result.terminalReason).toBe("offer_unavailable");
  expect(inbound.settleCalls).toBe(1);
  expect(outbound.payCalls).toBe(0);

  const projection = core.status(quote.paymentId, "alice");
  expect(projection?.destination.outcome).toBe("not_sent");
  expect(projection?.destination.receiptRef).toBeUndefined();

  await core.close();
  const restarted = await boot();
  expect(restarted.status(quote.paymentId, "alice")?.status).toBe("paid_data_unavailable");
  expect((await restarted.purchase(purchaseArgs(quote))).status).toBe("paid_data_unavailable");
  expect(outbound.payCalls).toBe(0);
});

test("受信成立後に上流の提示が変わったら送金せず、paid_data_unavailable で終わる", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  // 1 回目 = quote、2 回目 = source settle 前の照合、3 回目 = 送金直前の再照合。
  const changed: DestinationOffer = { ...outbound.offer, amount: "1200" };
  outbound.readChallengeImpl = (call) => (call >= 3 ? [changed] : [outbound.offer]);

  const result = await core.purchase(purchaseArgs(quote));

  expect(result.status).toBe("paid_data_unavailable");
  expect(result.terminalReason).toBe("quote_changed");
  expect(inbound.settleCalls).toBe(1);
  // 署名も送信もしない。
  expect(outbound.payCalls).toBe(0);

  const projection = core.status(quote.paymentId, "alice");
  expect(projection?.status).toBe("paid_data_unavailable");
  expect(projection?.destination.outcome).toBe("not_sent");
  // 課金していないのでレシート参照は作らない。
  expect(projection?.destination.receiptRef).toBeUndefined();
  expect(projection?.source.txRef).toBe("src-tx-1");
});

test("destination_pending のまま中断した購入は再起動で unknown に確定し、どちらのレグも再送しない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  // 送出中にプロセスが落ちた状況: destination_pending の fsync 後、以後の追記はできない。
  outbound.payImpl = async () => {
    await core.close();
    throw new Error("crash during pay");
  };
  await expect(core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();

  const restarted = await boot();
  const projection = restarted.status(quote.paymentId, "alice");
  expect(projection?.status).toBe("unknown");
  expect(projection?.destination.outcome).toBe("unknown");
  expect(projection?.destination.attempt).toBe(1);

  // 同じ quote を再提示しても自動再送・自動再 settle をしない。
  const retried = await restarted.purchase(purchaseArgs(quote));
  expect(retried.status).toBe("unknown");
  expect(inbound.settleCalls).toBe(1);
  expect(outbound.payCalls).toBe(1);
});

test("source_settled 直後に中断すると、再起動で paid_undelivered（interrupted_at_restart）に確定し、受信 settle をやり直さず送信も始めない", async () => {
  const core = await boot();
  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }

  // 受信 settle の追記直後にプロセスが落ちた状況（以後どの行も書けない）。
  // 上流の通信エラーではなく、journal を閉じることでクラッシュを再現する。
  outbound.readChallengeImpl = (call) => {
    if (call >= 3) {
      void core.close();
    }
    return [outbound.offer];
  };
  await expect(core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();
  await core.close();
  expect(inbound.settleCalls).toBe(1);

  delete outbound.readChallengeImpl;
  const restarted = await boot();
  // 受信は確定・送信は未実行の終端（2026-10-08、SR-3 SVM レビュー #2: 以前は `paid` のまま終端にならなかった）。
  expect(restarted.status(quote.paymentId, "alice")).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });

  const retried = await restarted.purchase(purchaseArgs(quote));
  expect(retried).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
  // 受信レグの重複 settle も、送信レグの自動送出もしない。
  expect(inbound.settleCalls).toBe(1);
  expect(outbound.payCalls).toBe(0);
});

test("quote→承認→受信 settle→送信 pay→結果の durable 保存が 1 本通る", async () => {
  const core = await boot();

  const quote = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }
  expect(quote.source.amount).toBe("1500");
  expect(quote.destination.quoted).toBe("900");
  expect(quote.approval.boundTo).toBe(quote.quoteId);

  const purchase = await core.purchase({
    principalId: "alice",
    requestId: "req-1",
    quoteId: quote.quoteId,
    approval: quote.quoteId,
    credential: inbound.credentialFor(quote.source.offer),
  });

  expect(purchase.status).toBe("delivered");
  expect(purchase.body).toEqual(UPSTREAM_BODY);
  expect(purchase.contentType).toBe("application/json");
  expect(inbound.verifyCalls).toBe(1);
  expect(inbound.settleCalls).toBe(1);
  expect(outbound.payCalls).toBe(1);

  const projection = core.status(quote.paymentId, "alice");
  expect(projection?.status).toBe("delivered");
  expect(projection?.destination.outcome).toBe("paid");
  expect(projection?.source.txRef).toBe("src-tx-1");
  expect(projection?.result).toEqual(UPSTREAM_BODY);

  // 再起動しても同一 status と同一結果が読める。
  await core.close();
  const restarted = await boot();
  const afterRestart = restarted.status(quote.paymentId, "alice");
  expect(afterRestart?.status).toBe("delivered");
  expect(afterRestart?.result).toEqual(UPSTREAM_BODY);
  expect(outbound.payCalls).toBe(1);
});

/* ---------------------------------------------------------------------------- *
 * FR-17: 設定変更時に未処理 quote を無効化する（設計 docs/routeconfig-fingerprint-design.md）
 *
 * なぜ必要か: 送金直前の照合（`readAndMatchDestination`）は **journal 保存済みの offer**
 * を基準にするので、運用者が設定の `payTo` を変えても**旧受取先に払えてしまう**。
 * journal された quote は**再起動も越える**。
 * ---------------------------------------------------------------------------- */

/** 指定した欄だけを差し替えた設定を作る。 */
function configWith(mutate: (c: RouterConfig) => void): RouterConfig {
  const c = baseConfig();
  mutate(c as RouterConfig);
  return c;
}

test("FR-17: 宛先 payTo を変えると、変更前の quote では払わない（再起動を越えて）", async () => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  // 運用者が受取先を差し替えて再起動。上流はまだ旧 offer を出している。
  const after = await boot(
    configWith((c) => {
      (c.routes[ROUTE_ID]!.destination as { payTo: string }).payTo = "0xattacker";
    }),
  );
  const result = await after.purchase(purchaseArgs(quote));

  expect(result.status).toBe("awaiting_payment");
  expect(result.code).toBe("quote_changed");
  // 受信も送信も**一切触らない**。
  expect(inbound.settleCalls).toBe(0);
  expect(inbound.verifyCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
  expect(outbound.readChallengeCalls).toBe(1); // quote 時の 1 回だけ
});

test("FR-17: 設定が変わっていなければ、再起動後も従来どおり成立する", async () => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  const after = await boot(); // 同じ設定
  const result = await after.purchase(purchaseArgs(quote));

  // 指紋が**再構築を生き残る**ことの証明（store.ts の復元が効いている）。
  expect(result.status).toBe("delivered");
});

test("FR-17: 受信額の変更でも払わない（指紋の対象範囲）", async () => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  const after = await boot(
    configWith((c) => {
      (c.routes[ROUTE_ID]!.source as { amount: string }).amount = "9999";
    }),
  );
  expect((await after.purchase(purchaseArgs(quote))).code).toBe("quote_changed");
});

test("FR-17: decimals の変更では拒否しない（対象外の欄）", async () => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  // `decimals` は表示用。決済は base unit の `amount` で行うので指紋に含めない。
  const after = await boot(
    configWith((c) => {
      (c.routes[ROUTE_ID]!.source as { decimals: number }).decimals = 18;
    }),
  );
  expect((await after.purchase(purchaseArgs(quote))).status).toBe("delivered");
});

test("FR-17: route が設定から消えていたら払わない", async () => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  const after = await boot(
    configWith((c) => {
      delete (c.routes as Record<string, unknown>)[ROUTE_ID];
    }),
  );
  const result = await after.purchase(purchaseArgs(quote));

  expect(result.code).toBe("quote_changed");
  expect(outbound.payCalls).toBe(0);
});

/**
 * legacy（この機能より前に発行された quote）は**一律で拒否**する（設計 §11.1）。
 *
 * なぜ部分照合しないか: `rail` / `sourceRail` は **journal に保存されていない**ので、
 * legacy intent では復元できない。一部の欄だけ照合すると
 * 「守れていない欄がある」ことを隠して運用者に誤った安心を与える。
 * 拒否のコストは再 quote であり、資金の損失ではない。
 */
test("FR-17: 指紋を持たない legacy quote は、設定が同じでも拒否する", async () => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  // journal から指紋欄だけを取り除き、この機能より前のレコードを再現する。
  const lines = (await readFile(journalPath, "utf8")).split("\n").filter((l) => l !== "");
  const stripped = lines.map((line) => {
    const row = JSON.parse(line) as { event?: string; patch?: Record<string, unknown> };
    if (row.event === "created" && row.patch !== undefined) {
      delete row.patch["routeFingerprint"];
    }
    return JSON.stringify(row);
  });
  await writeFile(journalPath, `${stripped.join("\n")}\n`, "utf8");

  const after = await boot(); // 設定は**変えていない**
  const result = await after.purchase(purchaseArgs(quote));

  expect(result.status).toBe("awaiting_payment");
  expect(result.code).toBe("quote_changed");
  expect(outbound.payCalls).toBe(0);
});

test("FR-17: 指紋が壊れた値なら legacy に落とさず拒否する", async () => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  // 数値・null・空文字・接頭辞違いはいずれも「読めない値」。
  const lines = (await readFile(journalPath, "utf8")).split("\n").filter((l) => l !== "");
  const broken = lines.map((line) => {
    const row = JSON.parse(line) as { event?: string; patch?: Record<string, unknown> };
    if (row.event === "created" && row.patch !== undefined) {
      row.patch["routeFingerprint"] = 42;
    }
    return JSON.stringify(row);
  });
  await writeFile(journalPath, `${broken.join("\n")}\n`, "utf8");

  const after = await boot();
  expect((await after.purchase(purchaseArgs(quote))).code).toBe("quote_changed");
});

/**
 * 拒否の判定は 1 本の不等号だが、**運用者向けの診断は理由を区別する**。
 * 公開応答は常に `quote_changed` のままで、設定の内容は漏らさない。
 */
test("FR-17: 拒否理由が診断ログで区別される（公開応答は変えない）", async () => {
  const notes: string[] = [];
  const bootNoting = async (config: RouterConfig = baseConfig()): Promise<RouterCore> => {
    const core = await createRouterCore({
      journalPath,
      config,
      inbound,
      outbound,
      note: (m) => notes.push(m),
    });
    opened.push(core);
    return core;
  };

  const before = await bootNoting();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  const after = await bootNoting(
    configWith((c) => {
      (c.routes[ROUTE_ID]!.destination as { payTo: string }).payTo = "0xattacker";
    }),
  );
  const result = await after.purchase(purchaseArgs(quote));

  // 公開応答は区別しない。
  expect(result.code).toBe("quote_changed");
  // ログは理由を示すが、**値は出さない**。
  const mismatch = notes.find((m) => m.includes("route configuration mismatch"));
  expect(mismatch).toContain("why=route configuration changed");
  expect(mismatch).not.toContain("0xattacker");
  expect(mismatch).not.toContain("0xprovidera");

  // 別の原因は**別の理由**として出る（区別が潰れていないこと）。
  // 2 本目は**元の設定**で取る（`0xattacker` 設定では上流が一致せず quote できない）。
  await after.close();
  const original = await bootNoting();
  const quote2 = await original.quote({
    principalId: "alice",
    requestId: "req-2",
    routeId: ROUTE_ID,
  });
  expect(quote2.ok).toBe(true);
  if (!quote2.ok) return;
  await original.close();

  notes.length = 0;
  const removed = await bootNoting(
    configWith((c) => {
      delete (c.routes as Record<string, unknown>)[ROUTE_ID];
    }),
  );
  expect((await removed.purchase(purchaseArgs(quote2, "req-2"))).code).toBe("quote_changed");
  expect(notes.find((m) => m.includes("route configuration mismatch"))).toContain(
    "why=route removed",
  );
});

/**
 * 指紋の**各欄**を個別に変えて拒否されることを固定する（レビュー指摘1）。
 *
 * なぜ必要か: `destination.payTo` と `source.amount` だけを試験していると、
 * **他の欄を `authoritativeTermsOf` から外しても気づけない**。
 * 支払いの宛先・額・レールを決める欄はすべて守られていなければならない。
 */
test.each([
  [
    "destination.scheme",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID]!.destination as { scheme: string }).scheme = "other";
    },
  ],
  [
    "destination.network",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID]!.destination as { network: string }).network = "eip155:1";
    },
  ],
  [
    "destination.asset",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID]!.destination as { asset: string }).asset = "0xother";
    },
  ],
  [
    "source.asset",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID]!.source as { asset: string }).asset = "0xother";
    },
  ],
  [
    "source.network",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID]!.source as { network: string }).network = "eip155:1";
    },
  ],
  [
    "source.payTo (x402/MPP 受信の受取先)",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID]!.source as { payTo?: string }).payTo = "0xelsewhere";
    },
  ],
  [
    "rail",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID] as { rail?: string }).rail = "mpp";
    },
  ],
  [
    "sourceRail",
    (c: RouterConfig) => {
      (c.routes[ROUTE_ID] as { sourceRail?: string }).sourceRail = "x402";
    },
  ],
])("FR-17: %s の変更で拒否する", async (_label, mutate) => {
  const before = await boot();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  const after = await boot(configWith(mutate));
  const result = await after.purchase(purchaseArgs(quote));

  expect(result.code).toBe("quote_changed");
  // 上流にも受信にも触らない。
  expect(inbound.settleCalls).toBe(0);
  expect(outbound.payCalls).toBe(0);
});

/**
 * 壊れた指紋は**legacy と区別して**診断する（レビュー指摘3）。
 * 公開応答は同じ `quote_changed` のまま。
 */
test.each([
  ["数値", 42],
  ["null", null],
  ["空文字", ""],
  ["接頭辞違い", "md5:abc"],
  ["接頭辞のみ", "sha256:"],
])("FR-17: 壊れた指紋（%s）は legacy と区別して拒否する", async (_label, bad) => {
  const notes: string[] = [];
  const bootNoting = async (): Promise<RouterCore> => {
    const core = await createRouterCore({
      journalPath,
      config: baseConfig(),
      inbound,
      outbound,
      note: (m) => notes.push(m),
    });
    opened.push(core);
    return core;
  };

  const before = await bootNoting();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  const lines = (await readFile(journalPath, "utf8")).split("\n").filter((l) => l !== "");
  const broken = lines.map((line) => {
    const row = JSON.parse(line) as { event?: string; patch?: Record<string, unknown> };
    if (row.event === "created" && row.patch !== undefined) {
      row.patch["routeFingerprint"] = bad;
    }
    return JSON.stringify(row);
  });
  await writeFile(journalPath, `${broken.join("\n")}\n`, "utf8");

  notes.length = 0;
  const after = await bootNoting();
  expect((await after.purchase(purchaseArgs(quote))).code).toBe("quote_changed");

  // `sha256:` 始まりは「読めた」扱いなので digest 不一致、それ以外は「読めない」。
  const mismatch = notes.find((m) => m.includes("route configuration mismatch"));
  const expected =
    typeof bad === "string" && bad.startsWith("sha256:")
      ? "why=route configuration changed"
      : "why=unreadable quote fingerprint";
  expect(mismatch).toContain(expected);
});

/** legacy（欄なし）は**壊れた値とは別の**診断になる。 */
test("FR-17: legacy は malformed と区別して診断される", async () => {
  const notes: string[] = [];
  const bootNoting = async (): Promise<RouterCore> => {
    const core = await createRouterCore({
      journalPath,
      config: baseConfig(),
      inbound,
      outbound,
      note: (m) => notes.push(m),
    });
    opened.push(core);
    return core;
  };

  const before = await bootNoting();
  const quote = await before.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  expect(quote.ok).toBe(true);
  if (!quote.ok) return;
  await before.close();

  const lines = (await readFile(journalPath, "utf8")).split("\n").filter((l) => l !== "");
  const stripped = lines.map((line) => {
    const row = JSON.parse(line) as { event?: string; patch?: Record<string, unknown> };
    if (row.event === "created" && row.patch !== undefined) {
      delete row.patch["routeFingerprint"];
    }
    return JSON.stringify(row);
  });
  await writeFile(journalPath, `${stripped.join("\n")}\n`, "utf8");

  notes.length = 0;
  const after = await bootNoting();
  expect((await after.purchase(purchaseArgs(quote))).code).toBe("quote_changed");
  expect(notes.find((m) => m.includes("route configuration mismatch"))).toContain(
    "why=quote predates this check",
  );
});
