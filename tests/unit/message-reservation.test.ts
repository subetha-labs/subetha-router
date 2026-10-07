/**
 * message の hash の予約（送信の設計 §2.4・§2.5、FR-36・FR-37。タスク U2）と、静的の残高の hook（§2.6、D-15）。
 *
 * 合成レール（鍵も送金も無い）で core を起動し、送信 adapter が受け取る `PayRequest` の中から `reserveMessage` を呼んで契約を確かめる:
 * - 形（小文字 hex 64）・状態（`destination_pending` 以外）→ `unavailable`
 * - 同じ hash（別の購入からも同じ購入からも）→ `collision`。queue の中で直列（並行 2 件で 1 件だけ `reserved`）
 * - journal に書けなければ `unavailable`（Set にも入らない）
 * - replay で復元して衝突。壊れた行で起動しない
 * - `deliver` が `deadlineMs`（承認の期限）と `reserveMessage` を渡す
 * - 静的の残高の hook: `undefined` → 通る、不足・throw・bigint でない → `source_failed`、journal に `source_pending` が無い、verify 0 回
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { RouterConfig } from "../../src/config.js";
import { createRouterCore, type QuoteOutcome, type RouterCore } from "../../src/core/orchestrator.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayRequest, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";
import { stableJson } from "../../src/core/intent.js";

const ROUTE = "md-static";
const SRC_NETWORK = "eip155:42431";
const SRC_ASSET = "0x20c0000000000000000000000000000000000000";
const DST_NETWORK = "eip155:84532";
const DST_ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const OFFER: DestinationOffer = { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, amount: "900", payTo: "0x0000000000000000000000000000000000000a11" };
const BODY = { price: "3000" };
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

const CONFIG: RouterConfig = {
  approvalTtlMs: 60_000,
  routes: {
    [ROUTE]: {
      routeId: ROUTE,
      canonicalPath: `/v1/routes/${ROUTE}/resource`,
      source: { amount: "1500", asset: SRC_ASSET, decimals: 6, network: SRC_NETWORK },
      destination: { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, payTo: OFFER.payTo },
    },
  },
  budget: {
    maxPurchases: 10,
    buckets: [
      { network: SRC_NETWORK, asset: SRC_ASSET, maxTotal: "100000", maxPerPurchase: "5000" },
      { network: DST_NETWORK, asset: DST_ASSET, maxTotal: "100000", maxPerPurchase: "5000" },
    ],
  },
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

class SyntheticInbound implements InboundRail {
  verifyCalls = 0;
  settleCalls = 0;
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.#issued += 1;
    return {
      scheme: "tempo/charge",
      network: request.network,
      asset: request.asset,
      amount: request.amount,
      payTo: "0xrouter",
      maxTimeoutSeconds: 120,
      extra: { challengeNonce: `0xnonce${this.#issued}`, expiresAt: Math.floor(request.nowMs / 1000) + 60, routeBinding: request.routeBinding },
    };
  }
  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
    if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
    if (stableJson(credential.accepted) !== stableJson(offer)) return { ok: false, reason: "offer_mismatch" };
    return { ok: true };
  }
  async verify(): Promise<{ isValid: boolean }> {
    this.verifyCalls += 1;
    return { isValid: true };
  }
  async settle(): Promise<SettleResult> {
    this.settleCalls += 1;
    return { outcome: "settled", txRef: "src-tx-1" };
  }
  credentialFor(offer: InboundOffer): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, tag: "sig" } };
  }
}

class SyntheticOutbound implements OutboundRail {
  readonly requests: PayRequest[] = [];
  payImpl: (request: PayRequest) => Promise<PayResult> = async () => ({ outcome: "paid", body: BODY, contentType: "application/json", txRef: "dst-tx-1" });
  async readChallenge(_routeId: string, _target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
    return [OFFER];
  }
  async pay(request: PayRequest): Promise<PayResult> {
    this.requests.push(request);
    return this.payImpl(request);
  }
}

let workDir: string;
let journalPath: string;
let inbound: SyntheticInbound;
let outbound: SyntheticOutbound;
let ids = 0;
const clock = 1_800_000_000_000;
const opened: RouterCore[] = [];

async function boot(options: { balanceOf?: (id: string, asset: string) => Promise<bigint | undefined> } = {}): Promise<RouterCore> {
  const core = await createRouterCore({ journalPath, config: CONFIG, inbound, outbound, now: () => clock, nextPaymentId: () => `pay-${(ids += 1)}`, ...options });
  opened.push(core);
  return core;
}

type OkQuote = Extract<QuoteOutcome, { ok: true }>;

async function quoteOk(core: RouterCore, requestId: string): Promise<OkQuote> {
  const outcome = await core.quote({ principalId: "alice", requestId, routeId: ROUTE, source: "alice" });
  expect(outcome.ok).toBe(true);
  return outcome as OkQuote;
}

function purchaseArgs(quote: OkQuote, requestId: string) {
  return { principalId: "alice", requestId, quoteId: quote.quoteId, approval: quote.quoteId, credential: inbound.credentialFor(quote.source.offer), source: "alice" };
}

async function journalLines(): Promise<{ seq: number; event: string; patch: Record<string, unknown> }[]> {
  const text = await readFile(journalPath, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { seq: number; event: string; patch: Record<string, unknown> });
}

const reservedRows = async (): Promise<string[]> => (await journalLines()).filter((line) => line.event === "destination_message_reserved").map((line) => line.patch["messageHash"] as string);

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "u2-reservation-"));
  journalPath = path.join(workDir, "journal.ndjson");
  inbound = new SyntheticInbound();
  outbound = new SyntheticOutbound();
  ids = 0;
});

afterEach(async () => {
  for (const core of opened.splice(0)) await core.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

describe("deliver が渡す PayRequest（FR-36・FR-37）", () => {
  test("deadlineMs は承認の期限、reserveMessage は関数。既存の欄はそのまま", async () => {
    const core = await boot();
    const quote = await quoteOk(core, "r1");
    expect((await core.purchase(purchaseArgs(quote, "r1"))).status).toBe("delivered");
    const request = outbound.requests[0]!;
    expect(request.deadlineMs).toBe(quote.approval.deadlineMs);
    expect(request.deadlineMs).toBeGreaterThan(clock);
    expect(typeof request.reserveMessage).toBe("function");
    expect(request).toMatchObject({ routeId: ROUTE, paymentId: quote.paymentId, attempt: 1, offer: OFFER });
  });
});

describe("message の hash の予約（FR-37）", () => {
  const H1 = sha256("message-1");
  const H2 = sha256("message-2");

  test("pay の中で: 予約 → 同じ hash は衝突（同じ購入からも）→ 形違いは unavailable → 並行 2 件は 1 件だけ → 終わった後は unavailable", async () => {
    const core = await boot();
    let captured: PayRequest["reserveMessage"];
    const seen: string[] = [];
    outbound.payImpl = async (request) => {
      captured = request.reserveMessage;
      seen.push(await request.reserveMessage!(H1));
      seen.push(await request.reserveMessage!(H1));
      seen.push(await request.reserveMessage!("not-a-hash"));
      seen.push(await request.reserveMessage!(H1.toUpperCase()));
      const both = await Promise.all([request.reserveMessage!(H2), request.reserveMessage!(H2)]);
      seen.push(...both.sort());
      return { outcome: "paid", body: BODY, contentType: "application/json", txRef: "dst-tx-1" };
    };
    const quote = await quoteOk(core, "r1");
    expect((await core.purchase(purchaseArgs(quote, "r1"))).status).toBe("delivered");
    expect(seen).toEqual(["reserved", "collision", "unavailable", "unavailable", "collision", "reserved"]);
    expect(await reservedRows()).toEqual([H1, H2]);
    // 購入が終わった（`delivered`）後は、その purchase の閉包からでも予約できない。
    expect(await captured!(sha256("message-3"))).toBe("unavailable");
    expect(await reservedRows()).toEqual([H1, H2]);
  });

  test("再起動後も予約は残る: 別の購入が同じ message を組めば衝突、新しい hash は予約できる", async () => {
    const first = await boot();
    outbound.payImpl = async (request) => {
      expect(await request.reserveMessage!(H1)).toBe("reserved");
      return { outcome: "paid", body: BODY, contentType: "application/json", txRef: "dst-tx-1" };
    };
    const q1 = await quoteOk(first, "r1");
    expect((await first.purchase(purchaseArgs(q1, "r1"))).status).toBe("delivered");
    await first.close();

    const second = await boot();
    const seen: string[] = [];
    outbound.payImpl = async (request) => {
      seen.push(await request.reserveMessage!(H1), await request.reserveMessage!(H2));
      return { outcome: "paid", body: BODY, contentType: "application/json", txRef: "dst-tx-2" };
    };
    const q2 = await quoteOk(second, "r2");
    expect(q2.paymentId).not.toBe(q1.paymentId);
    expect((await second.purchase(purchaseArgs(q2, "r2"))).status).toBe("delivered");
    expect(seen).toEqual(["collision", "reserved"]);
    expect(await reservedRows()).toEqual([H1, H2]);
  });

  test("journal に書けなければ unavailable（Set にも行にも残らない）", async () => {
    const core = await boot();
    const results: string[] = [];
    outbound.payImpl = async (request) => {
      await core.close();
      results.push(await request.reserveMessage!(H1));
      // 書けなかった hash は Set にも入っていない: intent はまだ destination_pending なので、もう一度予約しても
      // 「衝突」ではなく、また書けずに unavailable になる。
      results.push(await request.reserveMessage!(H1));
      return { outcome: "paid", body: BODY, contentType: "application/json", txRef: "dst-tx-1" };
    };
    const quote = await quoteOk(core, "r1");
    await expect(core.purchase(purchaseArgs(quote, "r1"))).rejects.toThrow();
    expect(results).toEqual(["unavailable", "unavailable"]);
    expect(await reservedRows()).toEqual([]);
  });

  test("壊れた予約の行（hex 64 でない）があれば起動しない", async () => {
    const core = await boot();
    const quote = await quoteOk(core, "r1");
    expect((await core.purchase(purchaseArgs(quote, "r1"))).status).toBe("delivered");
    await core.close();
    const lines = await journalLines();
    const seq = lines.length + 1;
    await appendFile(journalPath, `${JSON.stringify({ seq, at: new Date(clock).toISOString(), paymentId: quote.paymentId, event: "destination_message_reserved", patch: { messageHash: "bad" } })}\n`, "utf8");
    await expect(boot()).rejects.toThrow(/malformed destination_message_reserved/);
  });
});

describe("静的の残高の hook（D-15）", () => {
  test("undefined なら検査しない（verify 1 回で delivered）", async () => {
    const asked: [string, string][] = [];
    const core = await boot({ balanceOf: async (id, asset) => { asked.push([id, asset]); return undefined; } });
    const quote = await quoteOk(core, "r1");
    expect((await core.purchase(purchaseArgs(quote, "r1"))).status).toBe("delivered");
    expect(asked).toEqual([[ROUTE, DST_ASSET]]);
    expect(inbound.verifyCalls).toBe(1);
  });

  test.each([
    ["不足", async () => 899n],
    ["throw", async () => { throw new Error("rpc down https://secret.internal/"); }],
    ["bigint でない", async () => "900" as unknown as bigint],
  ])("%s → source_failed（operator_funds_unavailable）。source_pending を書かず、verify も settle も 0 回", async (_label, balanceOf) => {
    const core = await boot({ balanceOf });
    const quote = await quoteOk(core, "r1");
    expect(await core.purchase(purchaseArgs(quote, "r1"))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "operator_funds_unavailable" });
    expect(inbound.verifyCalls).toBe(0);
    expect(inbound.settleCalls).toBe(0);
    const events = (await journalLines()).map((line) => line.event);
    expect(events).not.toContain("source_pending");
    expect(events).toContain("source_failed");
    const failed = (await journalLines()).find((line) => line.event === "source_failed")!;
    expect(failed.patch).toEqual({ outcome: "not_sent", reason: "operator_funds_unavailable" });
    expect(JSON.stringify(await journalLines())).not.toContain("secret.internal");
  });

  test("足りれば通る（承認した額と同じ残高で delivered）", async () => {
    const core = await boot({ balanceOf: async () => 900n });
    const quote = await quoteOk(core, "r1");
    expect((await core.purchase(purchaseArgs(quote, "r1"))).status).toBe("delivered");
  });
});
