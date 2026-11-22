/**
 * 受信レール `subetha-exact` の再起動の表（`docs/subetha-exact-inbound-design.md` §6、AC-2 (g)、タスク T-5）。
 * 停止点（`SUBETHA_EXACT_STOP_AT`）・upstream の stall・fixture の `lose-response` で §6 の各行を決定的に作り、SIGKILL → 再起動（停止点なし。fixture と
 * 上流は生かしたまま）→ 状態・complete の呼び出し数・上流の呼び出し数。最後の route を消した再起動（env あり／無し）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";

// 実 process を何度も起動し直す（全体の試験の負荷の下では 5 秒を越える）。
vi.setConfig({ testTimeout: 90_000 });

import { configDocument, credentialOf, DEST_PAY_TO, NETWORK, purchaseOf, quoteOf, startExactHarness, statusOf, USDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

/** `subetha-exact` の route を消した設定（`router.routes` は空にできないので、既定の `subetha` 受信の route だけを残す）。 */
const WITHOUT_EXACT_ROUTE = {
  "md-plain": { routeId: "md-plain", canonicalPath: "/v1/routes/md-plain/resource", rail: "x402", source: { amount: "2000", asset: USDC, decimals: 6, network: NETWORK }, destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: DEST_PAY_TO } },
};

const started: ExactHarness[] = [];
afterEach(async () => {
  for (const h of started.splice(0)) await h.stopAll();
});
async function boot(options: Parameters<typeof startExactHarness>[0] = {}): Promise<ExactHarness> {
  const h = await startExactHarness(options);
  started.push(h);
  return h;
}
async function waitFor(condition: () => Promise<boolean> | boolean, label: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
/** 停止点で止まった購入: 合図を待って SIGKILL し、停止点なしで再起動する。purchase の fetch は切れる。 */
async function crashAt(h: ExactHarness, stopAt: string, requestId: string): Promise<{ paymentId: string; orderId: string; quote: Awaited<ReturnType<typeof quoteOf>>["body"]; credential: string }> {
  await h.restartRouter({ stopAt });
  const quote = await quoteOf(h, requestId);
  const credential = await credentialOf(h, quote.body.source.offer);
  const purchase = purchaseOf(h, quote.body, requestId, credential).catch(() => undefined);
  await waitFor(() => existsSync(h.signalPath), `stop point ${stopAt}`);
  const signal = JSON.parse(await readFile(h.signalPath, "utf8")) as { point: string };
  expect(signal.point).toBe(stopAt);
  await h.killRouter();
  await purchase;
  await h.restartRouter();
  return { paymentId: quote.body.paymentId, orderId: quote.body.source.offer.extra.challengeNonce, quote: quote.body, credential };
}
const upstreamPays = async (h: ExactHarness) => ((await (await fetch(`${h.upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls;

test("§6: before_source_settle → unknown、settle 0・release 0・complete 0・上流 0。再提出でも何も呼ばない", async () => {
  const h = await boot({ skipRouter: true });
  const { paymentId, orderId, quote: original, credential } = await crashAt(h, "before_source_settle", "req-1");
  expect((await statusOf(h, paymentId)).body).toMatchObject({ status: "unknown", terminalReason: "interrupted_at_restart", source: { mayStillSettleUntil: expect.any(Number), awaitingPaymentDoesNotMeanUnpaid: true } });
  expect((await h.calls()).byOrder[orderId]).toEqual({ create: 1, verify: 1 });
  expect(await upstreamPays(h)).toBe(0);
  // 同じ requestId の再 quote は閉じた文書（FR-4.5: 署名の対象を再提示しない）。元の文書と credential の再提出は現在の状態を返す。
  const requoted = await quoteOf(h, "req-1");
  expect(requoted.body).toMatchObject({ closed: true, status: "unknown" });
  expect(requoted.body.source).not.toHaveProperty("offer");
  const resent = await purchaseOf(h, original, "req-1", credential);
  expect(resent.body).toMatchObject({ status: "unknown" });
  // 同じ requestId の再 quote は journal の intent を返す（createOffer を呼ばない）: 作成の POST は増えない（設計 §3.2 の試験）。
  expect((await h.calls()).byOrder[orderId]).toEqual({ create: 1, verify: 1 });
});

test("§6: after_source_settled → paid_undelivered（interrupted_at_restart）、release 0・complete 0・上流 0", async () => {
  const h = await boot({ skipRouter: true });
  const { paymentId, orderId } = await crashAt(h, "after_source_settled", "req-2");
  expect((await statusOf(h, paymentId)).body).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
  expect((await h.calls()).byOrder[orderId]).toEqual({ create: 1, verify: 1, bind: 1, submit: 1, reconcile: 1 });
  expect(await upstreamPays(h)).toBe(0);
  expect((await h.order(orderId))["release"]).toBeUndefined();
});

test("§6: after_release_remote（facilitator に authorized が残り journal に行なし）→ paid_undelivered、complete 0、FR-11 で見える", async () => {
  const h = await boot({ skipRouter: true });
  const { paymentId, orderId } = await crashAt(h, "after_release_remote", "req-3");
  expect((await statusOf(h, paymentId)).body).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
  expect((await h.journal()).filter((r) => r.paymentId === paymentId).map((r) => r.event)).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "paid_undelivered"]);
  expect((await h.calls()).byOrder[orderId]).toEqual({ create: 1, verify: 1, bind: 1, submit: 1, reconcile: 1, release: 1 });
  expect((await h.order(orderId))["release"]).toMatchObject({ deliveryKey: orderId });
  expect((await h.order(orderId))["release"]).not.toHaveProperty("completed");
  expect(await upstreamPays(h)).toBe(0);
});

test("§6: after_source_released → paid_undelivered、起動時に complete(failed) が 1 回、上流 0。2 回目の起動では呼ばない", async () => {
  const h = await boot({ skipRouter: true });
  const { paymentId, orderId } = await crashAt(h, "after_source_released", "req-4");
  await waitFor(async () => (await h.calls()).byOrder[orderId]?.["complete"] === 1, "the startup complete");
  expect((await statusOf(h, paymentId)).body).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
  expect((await h.journal()).filter((r) => r.paymentId === paymentId).map((r) => r.event)).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "source_released", "paid_undelivered", "source_completed"]);
  expect((await h.order(orderId))["release"]).toMatchObject({ completed: { outcome: "failed" } });
  expect(await upstreamPays(h)).toBe(0);
  await h.restartRouter();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await h.calls()).byOrder[orderId]?.["complete"]).toBe(1);
});

test("§6: 送出の途中（upstream の stall）で落ちる → unknown、complete 0、上流は 1 回（再送しない）", async () => {
  const h = await boot({ upstreamArgs: ["--after-headers", "stall", "--after-headers-on", "pay"] });
  const quote = await quoteOf(h, "req-5");
  const purchase = purchaseOf(h, quote.body, "req-5", await credentialOf(h, quote.body.source.offer)).catch(() => undefined);
  await waitFor(async () => (await h.journal()).some((r) => r.paymentId === quote.body.paymentId && r.event === "destination_pending"), "destination_pending");
  await h.killRouter();
  await purchase;
  await h.restartRouter();
  expect((await statusOf(h, quote.body.paymentId)).body).toMatchObject({ status: "unknown", terminalReason: "interrupted_at_restart" });
  expect((await h.calls()).byOrder[quote.body.source.offer.extra.challengeNonce]).toEqual({ create: 1, verify: 1, bind: 1, submit: 1, reconcile: 1, release: 1 });
  expect(await upstreamPays(h)).toBe(1);
  expect((await h.order(quote.body.source.offer.extra.challengeNonce))["release"]).not.toHaveProperty("completed");
});

test("§6: after_terminal（complete の前）→ delivered のまま、起動時に同じ outcome で complete。complete の応答の喪失（全部）→ unreported、起動時に冪等で 200", async () => {
  const h = await boot({ skipRouter: true });
  const { paymentId, orderId } = await crashAt(h, "after_terminal", "req-6");
  await waitFor(async () => (await h.calls()).byOrder[orderId]?.["complete"] === 1, "the startup complete");
  expect((await statusOf(h, paymentId)).body).toMatchObject({ status: "delivered" });
  expect((await h.journal()).filter((r) => r.paymentId === paymentId).map((r) => r.event).slice(-2)).toEqual(["delivered", "source_completed"]);
  expect((await h.order(orderId))["release"]).toMatchObject({ completed: { outcome: "delivered" } });
  expect(await upstreamPays(h)).toBe(1);
  // complete の応答の喪失: 2 試行とも切れる → source_complete_unreported unavailable。再起動で冪等の 200 → source_completed。
  await h.setMode("complete", "lose-response");
  const q2 = await quoteOf(h, "req-7");
  const delivered = await purchaseOf(h, q2.body, "req-7", await credentialOf(h, q2.body.source.offer));
  expect(delivered.status).toBe(200);
  expect((await h.journal()).filter((r) => r.paymentId === q2.body.paymentId).map((r) => r.event).slice(-2)).toEqual(["delivered", "source_complete_unreported"]);
  await h.setMode("complete", "ok");
  await h.restartRouter();
  await waitFor(async () => (await h.journal()).some((r) => r.paymentId === q2.body.paymentId && r.event === "source_completed"), "the retried complete");
  expect((await h.order(q2.body.source.offer.extra.challengeNonce))["release"]).toMatchObject({ completed: { outcome: "delivered" } });
});

test("最後の route を消して再起動（env あり）: 掃き出しは ownsOffer の fallback で complete を報告する。env も消すと報告されず note", async () => {
  const h = await boot();
  await h.setMode("complete", "lose-response");
  const quote = await quoteOf(h, "req-8");
  expect((await purchaseOf(h, quote.body, "req-8", await credentialOf(h, quote.body.source.offer))).status).toBe(200);
  const orderId = quote.body.source.offer.extra.challengeNonce;
  await h.setMode("complete", "ok");
  // route を消す（env は残す）: ledger があるので adapter は作られ、起動時の掃き出しが complete を報告する。
  await h.restartRouter({ config: configDocument(h.upstream.baseUrl, WITHOUT_EXACT_ROUTE) });
  await waitFor(async () => (await h.journal()).some((r) => r.paymentId === quote.body.paymentId && r.event === "source_completed"), "the fallback complete");
  expect((await h.order(orderId))["release"]).toMatchObject({ completed: { outcome: "delivered" } });
  // status の開示: route が無くても journal から（settle 済みなので欄なし）。
  expect((await statusOf(h, quote.body.paymentId)).body["status"]).toBe("delivered");
  // 未報告の complete を残したまま（lose-response）、route も env も消す: adapter 無し → 報告されず、起動ログに固定文の note、inspect --remote で authorized のまま見える。
  await h.restartRouter({ config: configDocument(h.upstream.baseUrl) });
  await h.setMode("complete", "lose-response");
  const pending = await quoteOf(h, "req-9");
  expect((await purchaseOf(h, pending.body, "req-9", await credentialOf(h, pending.body.source.offer))).status).toBe(200);
  expect((await h.journal()).filter((r) => r.paymentId === pending.body.paymentId).map((r) => r.event).at(-1)).toBe("source_complete_unreported");
  await h.setMode("complete", "ok");
  const before = (await h.calls()).byRoute["complete"] ?? 0;
  await h.restartRouter({ config: configDocument(h.upstream.baseUrl, WITHOUT_EXACT_ROUTE), env: { ROUTER_SUBETHA_EXACT_FACILITATOR_URL: "", ROUTER_SUBETHA_EXACT_TOKEN_FILE: "" } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await h.calls()).byRoute["complete"] ?? 0).toBe(before);
  expect(h.router.stderr()).toContain("subetha-exact: a ledger exists but the facilitator env is not set; pending complete reports are not sent");
  expect((await h.journal()).filter((r) => r.paymentId === pending.body.paymentId).map((r) => r.event).at(-1)).toBe("source_complete_unreported");
  const { inspect } = await import("../../tools/subetha-exact-inspect.js");
  const lines = await inspect({ journalPath: h.journalPath, remote: { facilitatorUrl: h.env["ROUTER_SUBETHA_EXACT_FACILITATOR_URL"]!, token: () => "fixture-provider-token-0123", allowLoopback: true } });
  // fixture の lose-response は記録してから切るので remote は delivered（Router 側は unreported のまま = 冪等の報告が残る）。
  expect(lines.find((l) => l.kind === "attempt" && l["orderId"] === pending.body.source.offer.extra.challengeNonce)).toMatchObject({ terminal: "delivered", remote: { release: { state: "delivered" } }, mismatch: false });
});

test("quote → 再起動 → 最初の purchase: 作成の POST は増えず、ledger の操作の行は同じ attempt に付き、delivered に至る（§3.2 の index の試験）", async () => {
  const h = await boot();
  const quote = await quoteOf(h, "req-10");
  const attemptBefore = (await h.ledger()).filter((r) => r.event === "requested");
  expect(attemptBefore).toHaveLength(1);
  await h.restartRouter();
  const delivered = await purchaseOf(h, quote.body, "req-10", await credentialOf(h, quote.body.source.offer));
  expect(delivered.status).toBe(200);
  expect((await h.calls()).byOrder[quote.body.source.offer.extra.challengeNonce]).toEqual({ create: 1, verify: 1, bind: 1, submit: 1, reconcile: 1, release: 1, complete: 1 });
  const rows = await h.ledger();
  expect(rows.filter((r) => r.event === "requested")).toHaveLength(1);
  for (const event of ["verify", "bind", "submit", "settle", "release", "complete"]) expect(rows.find((r) => r.event === event)?.paymentId, event).toBe(attemptBefore[0]!.paymentId);
});

test("起動の途中の失敗の片付け: adapter の startup の後で listen に失敗しても ledger の lock が解放され、次の起動が通る（起動ログに token は無い）", async () => {
  const h = await boot();
  const { createServer } = await import("node:net");
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const port = (blocker.address() as { port: number }).port;
  try {
    await h.router.stop();
    await expect(h.restartRouter({ env: { ROUTER_HTTP_PORT: String(port) } })).rejects.toThrow(/exited before listening/);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
  // lock が残っていればここで `journal_locked` で落ちる。
  await h.restartRouter();
  expect(h.router.stdout()).toContain('"mode":"real"');
  expect(h.router.stderr()).not.toContain("fixture-provider-token");
  const quote = await quoteOf(h, "req-after");
  expect(quote.status).toBe(200);
});
