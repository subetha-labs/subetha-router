/**
 * 承認者に「**いつ資金が動き得るか**」が伝わるかを固定する。**無課金**。
 *
 * なぜ必要か: レールによって「credential を作る」操作の意味が違う。
 * MPP / SubEtha では payer が先に送金してからでないと credential を作れない
 * （credential が送金済み tx の hash を内包する）ので、**purchase を呼ぶ前に
 * 支出が済んでいて取り消せない**。x402（EIP-3009）は署名するだけで、
 * 送金は後段で facilitator が行う。
 *
 * この違いを伝えないと、承認者は署名を「準備の工程」と読んで承認し、
 * **実際には支払いを承認していた**ことになる。文面は読み飛ばされ得るので、
 * 構造化フィールド（`subject.fundsMoveOnCredential`）でも返す。
 *
 * **判定はレール名ではなく offer の申告で行う**（`extra.fundsMoveOnCredential`）。
 * レール名で分岐すると、レールを足した人が編集を忘れたときに
 * **警告が静かに壊れる**。したがって本テストは「未知のスキーム名でも
 * 申告どおりになる」ことと「申告が無い・壊れている場合は危険側に倒れる」ことを固定する。
 */

import { describe, expect, it } from "vitest";

import { createToolHandlers, type Evidence } from "../../src/mcp/tools.js";
import type { QuoteView, RouterClient } from "../../src/client/types.js";

const EVIDENCE: Evidence = { label: "test", source: "operator_asserted", verified: false };

/** 受信 offer の scheme と `extra` を差し替えた quote を作る。他の欄は共通。 */
function quoteWith(scheme: string, extra: Record<string, unknown>): QuoteView {
  return {
    quoteId: "q1",
    paymentId: "p1",
    routeId: "r1",
    resource: { url: "http://127.0.0.1:8500/v1/routes/r1/resource", method: "GET" },
    source: {
      amount: "10000",
      decimals: 6,
      asset: "0xasset",
      network: "eip155:42431",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      offer: { scheme, extra: { challengeNonce: "n1", ...extra } },
    },
    destination: { quoted: "10000", asset: "0xdest", network: "eip155:84532" },
    approval: { required: true, boundTo: "q1", deadlineMs: Date.now() + 60_000 },
  } as unknown as QuoteView;
}

function handlersFor(scheme: string, extra: Record<string, unknown>) {
  const client = {
    async quote() {
      return { ok: true as const, quote: quoteWith(scheme, extra) };
    },
  } as unknown as RouterClient;
  return createToolHandlers({ client, mode: "synthetic", evidence: EVIDENCE });
}

async function bodyFor(scheme: string, extra: Record<string, unknown>) {
  return handlersFor(scheme, extra).quote({ routeId: "r1", requestId: "x" });
}

/** 申告どおりに読まれ、危険側では取り消し不可の警告が出るか。 */
async function expectFlag(
  scheme: string,
  extra: Record<string, unknown>,
  expected: boolean,
): Promise<void> {
  const body = await bodyFor(scheme, extra);
  const subject = body["subject"] as Record<string, unknown>;
  expect(subject["fundsMoveOnCredential"], `${scheme} ${JSON.stringify(extra)}`).toBe(expected);
  if (expected) {
    expect(String(body["nextStep"])).toMatch(/cannot be undone/);
    expect(String(body["nextStep"])).toMatch(/before/);
  } else {
    // 申告が `false` のときだけ警告を出さない（出すと狼少年になる）。
    expect(String(body["nextStep"])).not.toMatch(/cannot be undone/);
  }
}

describe("approval must say when funds move", () => {
  it("flags a rail whose credential itself sends the money", async () => {
    await expectFlag("tempo/charge", { fundsMoveOnCredential: true }, true);
  });

  it("does not flag a rail that only signs", async () => {
    await expectFlag("exact", { fundsMoveOnCredential: false }, false);
  });

  it("flags SubEtha, with or without the permit helper advertised", async () => {
    // `helper` は能力の広告で、payer が選ぶ経路ではない。どちらでも危険側。
    await expectFlag("subetha-zerc20", { fundsMoveOnCredential: true }, true);
    await expectFlag(
      "subetha-zerc20",
      { fundsMoveOnCredential: true, helper: "0xhelper", deadline: 123 },
      true,
    );
  });

  /** ここが本題: レール名ではなく申告で決まる。 */
  it("honours the declaration for a scheme it has never seen", async () => {
    await expectFlag("some-future-rail/v9", { fundsMoveOnCredential: true }, true);
    await expectFlag("some-future-rail/v9", { fundsMoveOnCredential: false }, false);
  });

  it("does not let the scheme name override the declaration", async () => {
    // かつて真偽を決めていた名前でも、申告が `false` なら `false`。
    await expectFlag("tempo/charge", { fundsMoveOnCredential: false }, false);
    // 逆も同じ。
    await expectFlag("exact", { fundsMoveOnCredential: true }, true);
  });

  /** 申告が無い・壊れている場合は**危険側**に倒す（fail safe）。 */
  it("treats a missing or malformed declaration as dangerous", async () => {
    await expectFlag("exact", {}, true); // 申告なし
    for (const bad of [null, 0, "", "false", "true", undefined, {}, []]) {
      await expectFlag("exact", { fundsMoveOnCredential: bad }, true);
    }
  });

  it("treats a missing or malformed extra/offer as dangerous", async () => {
    const client = {
      async quote() {
        const q = quoteWith("exact", {});
        // `extra` 自体が無い offer。
        (q.source as unknown as Record<string, unknown>)["offer"] = { scheme: "exact" };
        return { ok: true as const, quote: q };
      },
    } as unknown as RouterClient;
    const body = await createToolHandlers({ client, mode: "synthetic", evidence: EVIDENCE }).quote({
      routeId: "r1",
      requestId: "x",
    });
    expect((body["subject"] as Record<string, unknown>)["fundsMoveOnCredential"]).toBe(true);
  });

  it("still requires human approval on every rail", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["tempo/charge", { fundsMoveOnCredential: true }],
      ["exact", { fundsMoveOnCredential: false }],
      ["subetha-zerc20", { fundsMoveOnCredential: true }],
      ["some-future-rail/v9", {}],
    ];
    for (const [scheme, extra] of cases) {
      const body = await bodyFor(scheme, extra);
      expect(body["approvalRequired"], scheme).toBe(true);
      expect(String(body["nextStep"]), scheme).toMatch(/Explicit human approval is required/);
    }
  });

  /** 断定してはいけない: 申告が無いだけの offer にも `true` が付く。 */
  it("does not claim a payment completed", async () => {
    const body = await bodyFor("exact", {});
    expect(String(body["nextStep"])).toMatch(/may already spend/);
    expect(String(body["nextStep"])).not.toMatch(/the transfer happens/);
  });
});
