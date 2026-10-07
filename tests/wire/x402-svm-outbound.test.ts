/**
 * Solana の Provider に払う（送信の設計 §4、FR-24・FR-32〜FR-37、AC-9・AC-10。タスク U7）。
 *
 * 実 TCP / TLS（loopback の fixture。TCP の行き先だけを fixture に向ける）。署名は**毎回の乱数の seed**で本当に行う。資金は動かない。
 * - 静的 route・動的プロファイルが `delivered`: 署名 1 回・支払い要求 1 件、fixture の facilitator の `/verify`（本物の `@x402/svm` の verify の論理）が
 *   Router の transaction を受ける（V-8a）、領収の `transaction` は base58 64 バイト
 * - §4.5 の各段の失敗（AC-10）、改変（AC-9 (a)〜(d2)）。観測は signer の回数・bytes と `seen.paid`
 * - RPC は 3 つの method だけ・回数の上限・すべて guarded transport
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { getBase58Encoder, getTransactionDecoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, PayResult } from "../../src/ports/outbound.js";
import { startSolanaRpc } from "../fixtures/solana-rpc.js";
import { ataOf, FAC_HOST, harness as harnessIn, MINT, OPERATOR_SOL_OWNER, paidTransactionOk, PROFILE_ID, PROVIDER_HOST, ROUTE, RPC_HOST, rpcMethods, requestOf, SOL, UPSTREAM, URL_A, type Harness } from "../fixtures/svm-outbound-harness.js";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm";

import { createSvmTestPayer } from "../fixtures/svm-payer.js";
import { createSvmSignerFixture } from "../fixtures/svm-signer-fixture.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

const harness: (options?: Parameters<typeof harnessIn>[1]) => Promise<Harness> = (options) => harnessIn({ TLS, closers }, options);

describe("startup", () => {
  test("startup の前は pay・readChallenge・balanceOf が throw。startup で Router の ATA が運用者の集合に入り、静的の宛先 ATA を RPC で検査する", async () => {
    const h = await harness({ startup: false });
    await expect(h.rail.readChallenge(ROUTE)).rejects.toThrow(/startup\(\) has not completed/);
    await expect(h.rail.pay(requestOf(h, { scheme: "exact", network: SOL, asset: MINT, amount: "1", payTo: h.provider }))).rejects.toThrow(/startup\(\) has not completed/);
    await expect(h.rail.balanceOf(ROUTE, MINT)).rejects.toThrow(/startup\(\) has not completed/);
    expect(h.rpc.calls).toHaveLength(0);
    await h.rail.startup();
    expect(h.operators.has(h.routerAta)).toBe(true);
    expect(h.operators.has(await ataOf(OPERATOR_SOL_OWNER))).toBe(true);
    expect(rpcMethods(h)).toEqual(["getAccountInfo"]);
    expect((h.rpc.calls[0]!.params as unknown[])[0]).toBe(h.providerAta);
    // RPC は guarded transport（dial の記録に RPC のホストがある）。
    expect(h.dialed).toContain(RPC_HOST);
  });

  test("静的 route の宛先 ATA が無ければ startup が throw", async () => {
    const h = await harness({ startup: false, providerAtaExists: false });
    await expect(h.rail.startup()).rejects.toThrow(/does not exist/);
    await expect(h.rail.readChallenge(ROUTE)).rejects.toThrow(/startup\(\) has not completed/);
  });

  test("balanceOf: Router の ATA の残高（getTokenAccountBalance 1 回）。別の資産は throw", async () => {
    const h = await harness({ routerBalance: "123456789012345678" });
    expect(await h.rail.balanceOf(ROUTE, MINT)).toBe(123456789012345678n);
    expect(rpcMethods(h).filter((m) => m === "getTokenAccountBalance")).toHaveLength(1);
    await expect(h.rail.balanceOf(ROUTE, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).rejects.toThrow(/different asset/);
    h.rpc.state.reply = "rpc-error";
    await expect(h.rail.balanceOf(ROUTE, MINT)).rejects.toThrow(/did not return a token balance/);
  });
});

describe("成功: 静的と動的が delivered", () => {
  test("静的: 署名 1 回・支払い要求 1 件・facilitator の verify と settle が Router の transaction を受ける・領収の transaction は base58 64 バイト。quote では RPC を呼ばない", async () => {
    const h = await harness();
    const callsAfterStartup = h.rpc.calls.length;
    const offers = await h.rail.readChallenge(ROUTE);
    expect(offers).toHaveLength(1);
    expect(h.rpc.calls).toHaveLength(callsAfterStartup); // 静的の quote は RPC を呼ばない
    const request = requestOf(h, offers[0]!);
    const result = await h.rail.pay(request);
    expect(result).toMatchObject({ outcome: "paid", body: { ok: true, source: "svm-provider" }, contentType: "application/json" });
    expect((result as { txRef?: string }).txRef).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(getBase58Encoder().encode((result as { txRef: string }).txRef).length).toBe(64);
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.paid).toHaveLength(1);
    expect(h.fac.seen.verifyCalls).toBe(1);
    expect(h.fac.seen.settleCalls).toBe(1);
    expect(h.fac.seen.lastVerify).toMatchObject({ isValid: true });
    expect(paidTransactionOk(h, 0, "10000", `subetha:${request.paymentId}`)).toBe(true);
    // 署名器に渡った bytes は、送った transaction の message と一致。
    const wire = Buffer.from(h.upstream.seen.paid[0]!.transactionBase64!, "base64");
    const decoded = getTransactionDecoder().decode(new Uint8Array(wire));
    expect(Buffer.from(h.signer.signed[0]!)).toEqual(Buffer.from(new Uint8Array(decoded.messageBytes)));
    // purchase の RPC: readChallenge（静的: 0）＋ pay の getAccountInfo 1・getLatestBlockhash 1。
    expect(rpcMethods(h).slice(callsAfterStartup)).toEqual(["getAccountInfo", "getLatestBlockhash"]);
    // 3 つの method 以外は呼ばない。
    expect(new Set(rpcMethods(h))).toEqual(new Set(["getAccountInfo", "getLatestBlockhash"]));
    // すべて fixture のホストへ（Provider・RPC・facilitator は fixture 同士）。
    expect(h.dialed.every((host) => [PROVIDER_HOST, RPC_HOST].includes(host))).toBe(true);
  });

  test("動的: プロファイル経由で delivered。quote は候補ごとに getAccountInfo 1 回。offer の Memo があればそれを使う", async () => {
    const h = await harness();
    h.upstream.state.memoMode = "fixed";
    h.upstream.state.memo = "invoice 42";
    const callsAfterStartup = h.rpc.calls.length;
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(offers).toHaveLength(1);
    expect(rpcMethods(h).slice(callsAfterStartup)).toEqual(["getAccountInfo"]);
    const request = requestOf(h, offers[0]!, { routeId: PROFILE_ID, target: { url: URL_A } });
    const result = await h.rail.pay(request);
    expect(result).toMatchObject({ outcome: "paid" });
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.paid).toHaveLength(1);
    expect(paidTransactionOk(h, 0, "10000", "invoice 42")).toBe(true);
    expect(h.upstream.seen.urls.filter((u) => u === URL_A)).toHaveLength(3); // quote の 402、pay の読み直し、支払い
    // pay: 読み直しの候補検査は存在を見ない（0）、3 の getAccountInfo 1、blockhash 1。
    expect(rpcMethods(h).slice(callsAfterStartup + 1)).toEqual(["getAccountInfo", "getLatestBlockhash"]);
  });

  test("乱数 Memo の offer（V-12）: quote と pay で Memo が違えば destination_offer_changed（署名 0・支払い 0）", async () => {
    const h = await harness();
    h.upstream.state.memoMode = "random";
    const offers = await h.rail.readChallenge(ROUTE);
    expect(offers).toHaveLength(1);
    expect(await h.rail.pay(requestOf(h, offers[0]!))).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(h.signer.signCount()).toBe(0);
    expect(h.upstream.seen.paid).toHaveLength(0);
  });
});

describe("候補の段階（AC-9 (a)）: 違反は候補外。signer 0・支払い 0", () => {
  const cases: [string, (h: Harness) => void][] = [
    ["payTo が運用者（受信の受取 owner）", (h) => { h.upstream.state.payTo = OPERATOR_SOL_OWNER; }],
    ["payTo が Router の公開鍵", (h) => { h.upstream.state.payTo = h.router; }],
    ["feePayer が Router の公開鍵", (h) => { h.upstream.state.feePayer = h.router; }],
    ["feePayer が payTo", (h) => { h.upstream.state.feePayer = h.provider; }],
    ["extra に recentBlockhash", (h) => { h.upstream.state.extraFields = { recentBlockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD" }; }],
    ["extra に assetTransferMethod", (h) => { h.upstream.state.extraFields = { assetTransferMethod: "transfer" }; }],
    ["Memo が 257 バイト", (h) => { h.upstream.state.memoMode = "fixed"; h.upstream.state.memo = "a".repeat(257); }],
    ["別の mint", (h) => { h.upstream.state.accepts = [{ scheme: "exact", network: SOL, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1", payTo: h.provider, maxTimeoutSeconds: 60, extra: { feePayer: h.fac.feePayer } }]; }],
    ["別の network", (h) => { h.upstream.state.accepts = [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: MINT, amount: "1", payTo: h.provider, maxTimeoutSeconds: 60, extra: { feePayer: h.fac.feePayer } }]; }],
  ];
  for (const [label, arrange] of cases) {
    test(`${label} → 静的・動的とも候補 0`, async () => {
      const h = await harness();
      arrange(h);
      expect(await h.rail.readChallenge(ROUTE)).toEqual([]);
      expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
      expect(h.signer.signCount()).toBe(0);
      expect(h.upstream.seen.paid).toHaveLength(0);
    });
  }

  test("静的: destination と違う payTo（別の正しい owner）は候補外。動的: 上限超えの額は候補外、宛先 ATA が無ければ候補外（RPC で見る）", async () => {
    const h = await harness();
    const other = createSvmSignerFixture(SOL).address;
    h.upstream.state.payTo = other;
    expect(await h.rail.readChallenge(ROUTE)).toEqual([]);
    // 動的: 別の owner でも ATA が無い → 候補外（getAccountInfo が null）。
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
    h.rpc.state.atas.push({ address: await ataOf(other), owner: other });
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toHaveLength(1);
    h.upstream.state.amount = "100001";
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
  });

  test("pay の 1: 保存した offer が今の運用者の集合に当たれば destination_offer_not_allowed。能力と違う network は destination_signer_network_mismatch", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(ROUTE);
    h.operators.add(h.provider);
    expect(await h.rail.pay(requestOf(h, offers[0]!))).toEqual({ outcome: "not_sent", reason: "destination_offer_not_allowed" });
    h.operators.delete(h.provider);
    expect(await h.rail.pay(requestOf(h, { ...offers[0]!, network: "eip155:84532" }))).toEqual({ outcome: "not_sent", reason: "destination_signer_network_mismatch" });
    expect(h.signer.signCount()).toBe(0);
    expect(h.upstream.seen.paid).toHaveLength(0);
  });
});

describe("§4.5 の各段の失敗（AC-10）。signer と支払い要求の回数で観測", () => {
  async function approved(h: Harness): Promise<DestinationOffer> {
    const offers = await h.rail.readChallenge(ROUTE);
    expect(offers).toHaveLength(1);
    return offers[0]!;
  }

  test("1: 期限切れ → destination_deadline（RPC も読み直しも無し）。reserveMessage 無し → destination_reservation_unsupported", async () => {
    const h = await harness();
    const offer = await approved(h);
    const calls = h.rpc.calls.length;
    const challenges = h.upstream.seen.challenges;
    expect(await h.rail.pay(requestOf(h, offer, { deadlineMs: h.clock.now }))).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(h.rpc.calls).toHaveLength(calls);
    expect(h.upstream.seen.challenges).toBe(challenges);
    expect(await h.rail.pay(requestOf(h, offer, { noReserve: true }))).toEqual({ outcome: "not_sent", reason: "destination_reservation_unsupported" });
    expect(h.signer.signCount()).toBe(0);
    expect(h.upstream.seen.paid).toHaveLength(0);
  });

  test("2: 上流が offer を変えた（額）→ destination_offer_changed。読めない（500）→ destination_challenge_unreadable", async () => {
    const h = await harness();
    const offer = await approved(h);
    h.upstream.state.amount = "10001";
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    h.upstream.state.challengeStatus = 500;
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    expect(h.signer.signCount()).toBe(0);
  });

  test("3: 宛先 ATA が quote の後に消えた → destination_ata_missing（静的は起動時の値で候補に残り、送る直前の確認で止まる）", async () => {
    const h = await harness();
    const offer = await approved(h);
    h.rpc.state.atas = h.rpc.state.atas.filter((a) => a.address !== h.providerAta);
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_ata_missing" });
    expect(h.signer.signCount()).toBe(0);
    expect(rpcMethods(h).includes("getLatestBlockhash")).toBe(false);
  });

  test("4: blockhash の RPC が失敗・形違い → destination_blockhash_unavailable", async () => {
    const mode = { blockhash: "ok" as "ok" | "throw" | "malformed" };
    const h = await harness({
      rpcTransport: (real) => ({
        ...real,
        fetch: async (url, init, ctx) => {
          if (typeof init?.body === "string" && init.body.includes("getLatestBlockhash")) {
            if (mode.blockhash === "throw") throw new Error("rpc down");
            if (mode.blockhash === "malformed") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { blockhash: "short", lastValidBlockHeight: 10 } } }), { status: 200, headers: { "content-type": "application/json" } });
          }
          return real.fetch(url, init, ctx);
        },
      }),
    });
    const offer = await approved(h);
    mode.blockhash = "throw";
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_blockhash_unavailable" });
    mode.blockhash = "malformed";
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_blockhash_unavailable" });
    expect(h.signer.signCount()).toBe(0);
  });

  test("8: 固定 Memo の並行 2 件 → 1 件 delivered、1 件 destination_message_collision。signer は 1 回", async () => {
    const h = await harness();
    h.upstream.state.memoMode = "fixed";
    const offer = await approved(h);
    const [a, b] = await Promise.all([h.rail.pay(requestOf(h, offer)), h.rail.pay(requestOf(h, offer))]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["not_sent", "paid"]);
    expect([a, b].find((r) => r.outcome === "not_sent")).toEqual({ outcome: "not_sent", reason: "destination_message_collision" });
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.paid).toHaveLength(1);
    expect(h.reservations.size).toBe(1);
  });

  test("8: 予約が unavailable → destination_message_record_unavailable（signer 0）。予約の後に同じ message を別の購入が組めば collision（journal の再読込と同じ契約）", async () => {
    const h = await harness();
    h.upstream.state.memoMode = "fixed";
    const offer = await approved(h);
    expect(await h.rail.pay(requestOf(h, offer, { reserveMessage: async () => "unavailable" }))).toEqual({ outcome: "not_sent", reason: "destination_message_record_unavailable" });
    expect(await h.rail.pay(requestOf(h, offer, { reserveMessage: async () => { throw new Error("journal closed"); } }))).toEqual({ outcome: "not_sent", reason: "destination_message_record_unavailable" });
    expect(h.signer.signCount()).toBe(0);
    expect(await h.rail.pay(requestOf(h, offer))).toMatchObject({ outcome: "paid" });
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_message_collision" });
    expect(h.signer.signCount()).toBe(1);
  });

  test("9: 予約の後に期限が切れる → destination_deadline（signer 0）。blockhash が古い（fetchToSignMs 超過）→ destination_blockhash_stale", async () => {
    const h = await harness();
    const offer = await approved(h);
    h.hooks.afterReserve = () => { h.clock.now += 600_001; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    h.hooks.afterReserve = () => { h.clock.now += 5_001; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_blockhash_stale" });
    expect(h.signer.signCount()).toBe(0);
    expect(h.upstream.seen.paid).toHaveLength(0);
    // 予約は残る（同じ message には二度と署名しない。2 件は paymentId が違うので別の message）。
    expect(h.reservations.size).toBe(2);
  });

  test("10 (d1): 署名器が壊れた署名・短い署名・例外 → destination_not_signed（支払い 0）", async () => {
    const h = await harness();
    const offer = await approved(h);
    for (const mode of ["broken", "short", "throw"] as const) {
      h.signer.mode = mode;
      h.upstream.state.memoMode = "fixed";
      h.upstream.state.memo = `memo-${mode}`;
      const fresh = await approved(h);
      expect(await h.rail.pay(requestOf(h, fresh)), mode).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    }
    h.signer.mode = "ok";
    expect(h.upstream.seen.paid).toHaveLength(0);
    void offer;
  });

  test("11 (d2): wire の改変（message の 1 バイト・署名の 1 バイト・末尾の 1 バイト）→ destination_payload_mismatch（支払い 0）", async () => {
    const h = await harness();
    const offer = await approved(h);
    const tampers: [string, (b: Uint8Array) => Uint8Array][] = [
      ["message", (b) => { const out = Uint8Array.from(b); out[out.length - 1] = (out[out.length - 1] ?? 0) ^ 1; return out; }],
      ["signature", (b) => { const out = Uint8Array.from(b); out[70] = (out[70] ?? 0) ^ 1; return out; }],
      ["trailing", (b) => new Uint8Array([...b, 0])],
      ["fee payer slot", (b) => { const out = Uint8Array.from(b); out[5] = 1; return out; }],
    ];
    for (const [label, tamper] of tampers) {
      h.hooks.wire = tamper;
      h.upstream.state.memoMode = "fixed";
      h.upstream.state.memo = `memo-${label}`;
      const fresh = await approved(h);
      expect(await h.rail.pay(requestOf(h, fresh)), label).toEqual({ outcome: "not_sent", reason: "destination_payload_mismatch" });
    }
    expect(h.upstream.seen.paid).toHaveLength(0);
    expect(h.signer.signCount()).toBe(4);
    void offer;
  });

  test("12: 署名の後・送出の直前に期限が切れる → destination_deadline（signer 1・支払い 0）。beforeSend は検査の後の停止点（そこで進めても送る）", async () => {
    const h = await harness();
    const offer = await approved(h);
    h.hooks.afterSign = () => { h.clock.now += 600_001; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.paid).toHaveLength(0);
    delete h.hooks.afterSign;
    h.hooks.beforeSend = () => { h.clock.now += 600_001; };
    h.upstream.state.memoMode = "fixed";
    const fresh = await approved(h);
    expect(await h.rail.pay(requestOf(h, fresh))).toMatchObject({ outcome: "paid" });
    expect(h.upstream.seen.paid).toHaveLength(1);
  });

  test("13: 送出の例外（settle の後に切断、期限）→ unknown destination_pay_unknown（支払い 1）", async () => {
    const h = await harness();
    const offer = await approved(h);
    h.upstream.state.payMode = "drop-after-settle";
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(h.upstream.seen.paid).toHaveLength(1);
    expect(h.fac.seen.settleCalls).toBe(1);
  });

  test("14: 領収の表（SVM の form が共有の関数に繋がっている）", async () => {
    const h = await harness();
    const rows: [string, (h: Harness) => void, PayResult][] = [
      ["領収なしの 500", (h) => { h.upstream.state.payMode = "status-500"; }, { outcome: "unknown", reason: "destination_pay_unknown" }],
      ["領収なしの 404", (h) => { h.upstream.state.payMode = "status-404"; }, { outcome: "rejected", reason: "destination_rejected" }],
      ["領収なしの 200", (h) => { h.upstream.state.payMode = "no-receipt-200"; }, { outcome: "unknown", reason: "destination_receipt_unverified" }],
      ["整合した領収の 502", (h) => { h.upstream.state.payMode = "receipt-then-502"; }, { outcome: "paid_no_data", reason: "paid_data_unavailable", receiptRef: expect.any(String) } as never],
      ["payer 不一致", (h) => { h.upstream.state.payMode = "payer-mismatch"; }, { outcome: "unknown", reason: "destination_receipt_payer_mismatch" }],
      ["領収の transaction が 64 バイトでない（領収なし扱い・200）", (h) => { h.upstream.state.payMode = "settle"; h.upstream.state.receiptTransaction = "abc"; }, { outcome: "unknown", reason: "destination_receipt_unverified" }],
      ["整合した領収の 200・本文が空（形が違う）", (h) => { h.upstream.state.receiptTransaction = undefined; h.upstream.state.payMode = "receipt-only"; }, { outcome: "paid_no_data", reason: expect.stringMatching(/^(paid_data_unavailable|unsupported_response)$/), receiptRef: expect.any(String) } as never],
    ];
    let index = 0;
    for (const [label, arrange, expected] of rows) {
      arrange(h);
      h.upstream.state.memoMode = "fixed";
      h.upstream.state.memo = `memo-${index}`;
      index += 1;
      const offers = await h.rail.readChallenge(ROUTE);
      expect(await h.rail.pay(requestOf(h, offers[0]!)), label).toEqual(expected);
    }
    expect(h.upstream.seen.paid).toHaveLength(rows.length);
  });
});

describe("SR-4: RPC は guarded transport だけ", () => {
  test("hooks の無い transport で loopback の fixture を直接指すと接続 0 で startup が止まる（guard が loopback を拒む）", async () => {
    const events: string[] = [];
    const h = await harness({
      startup: false,
      rpcUrl: (rpc) => `https://127.0.0.1:${rpc.port}`,
      rpcTransport: () => createGuardedTransport({ allowLoopback: false, report: (event) => events.push(event.code), interfaces: () => [], dns: { timeoutMs: 1_000, maxInFlight: 2 } }),
    });
    const connections = h.rpc.connections();
    await expect(h.rail.startup()).rejects.toThrow(/does not exist/);
    expect(h.rpc.connections()).toBe(connections);
    expect(h.rpc.calls).toHaveLength(0);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("V-8a: SDK の client（@x402/svm。試験だけ）が同じ offer から組む封筒と、Router の封筒の鍵の集合が一致する", () => {
  test("payload は { transaction } だけ、accepted は offer の鍵、トップレベルは x402Version・resource・accepted・payload", async () => {
    const h = await harness();
    h.upstream.state.memoMode = "fixed";
    const offers = await h.rail.readChallenge(ROUTE);
    expect(await h.rail.pay(requestOf(h, offers[0]!))).toMatchObject({ outcome: "paid" });
    const ours = h.upstream.seen.paid[0]!.payload as Record<string, unknown>;

    // SDK の client は RPC から mint と blockhash を読む: TLS 無しの loopback fixture を直接使い、他の origin への fetch は止める。
    const plainRpc = await startSolanaRpc({ mint: MINT, decimals: 6 });
    closers.push(plainRpc.close);
    const payer = await createSvmTestPayer(MINT);
    const client = new x402Client();
    client.register(SOL as never, new ExactSvmScheme(payer.signer as never, { rpcUrl: plainRpc.url }));
    const httpClient = new x402HTTPClient(client);
    const realFetch = globalThis.fetch;
    const outside: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(plainRpc.url)) {
        outside.push(url);
        throw new Error("blocked: not the fixture RPC");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    let theirs: Record<string, unknown>;
    try {
      theirs = (await httpClient.createPaymentPayload({ x402Version: 2, resource: { url: UPSTREAM }, accepts: [offers[0]] } as never)) as unknown as Record<string, unknown>;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(outside).toEqual([]);
    // 比べるのは**wire に載る形**（ヘッダに符号化して復号したもの。SDK の object は `extensions: undefined` を持つが JSON には出ない）。
    expect(Object.keys(theirs)).toContain("extensions");
    expect(theirs["extensions"]).toBeUndefined();
    const encoded = httpClient.encodePaymentSignatureHeader(theirs as never);
    theirs = decodePaymentSignatureHeader(encoded["PAYMENT-SIGNATURE"]!) as unknown as Record<string, unknown>;
    // 同じ鍵の集合（トップレベル・accepted・payload・resource）。
    expect(Object.keys(theirs).sort()).toEqual(Object.keys(ours).sort());
    expect(Object.keys(ours).sort()).toEqual(["accepted", "payload", "resource", "x402Version"]);
    expect(Object.keys(theirs["payload"] as object).sort()).toEqual(Object.keys(ours["payload"] as object).sort());
    expect(Object.keys(ours["payload"] as object)).toEqual(["transaction"]);
    expect(Object.keys(theirs["accepted"] as object).sort()).toEqual(Object.keys(ours["accepted"] as object).sort());
    expect(Object.keys(theirs["resource"] as object).sort()).toEqual(Object.keys(ours["resource"] as object).sort());
    expect(theirs["accepted"]).toEqual(ours["accepted"]);
    expect(ours["x402Version"]).toBe(2);
    expect(theirs["x402Version"]).toBe(2);
    // 値は違う（blockhash・署名者）が、どちらも受信の検査の形（base64 の 2 署名の transaction）。
    expect(typeof (theirs["payload"] as { transaction: unknown }).transaction).toBe("string");
  });
});
