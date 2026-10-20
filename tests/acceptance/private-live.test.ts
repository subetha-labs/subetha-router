/**
 * 秘匿購入の受入（要件 TR-3、設計 §11、タスク T-Z8）: **owner が実行する**実送金の雛形。lab の testnet Provider（C: x402 POST、F: Tempo pull POST、A: x402 GET、B: Tempo pull GET）に対し、
 * 実合成の Router（`tools/remote-router-process.ts` → `src/main.ts`、`ROUTER_ADAPTER_MODE=real`、`router.private` 設定）を相手に、Payer 側の手順 `tools/private-payer.ts` を通す。
 *
 * **gate**: `PRIVATE_LIVE_AC=1` のときだけ走る。無ければ skip（skip は「未検証」。合格ではない）。1 回の起動で 1 つの操作（`PRIVATE_LIVE_MODE=quote|approve|recover`）:
 * quote が承認対象と再開点を書き、owner が読んでから、**同じ** `PRIVATE_LIVE_EVIDENCE_DIR` を指して approve する（新しい quote も本文も作らない）。
 * 実行前に **支払い範囲の記録**（`PRIVATE_LIVE_SCOPE_FILE`、AGENTS.md）が無ければ何も払わずに失敗する。鍵は env だけ（`SUBETHA_PAYER_PRIVATE_KEY`）。
 * 証跡は `PRIVATE_LIVE_EVIDENCE_DIR`（既定 `runtime/private-live/<provider>-<時刻>`）に、**5 つのゲートを別々に**書く:
 * 受信決済（Base Sepolia USDC の tx）・送信決済（Provider の領収の tx / reference）・秘匿配送（Router の `delivered_private` と proof）・Payer 受領（手元の bundle 検証つき復号）・finality（本 v1 は未確認と明記）。
 * 手順と Router の設定例: `docs/zktls-router-acceptance.md`。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import { recoverPrivatePayer, runPrivatePayer, type PrivatePayerRecovery, type PrivatePayerRun } from "../../tools/private-payer.js";

const ENABLED = process.env["PRIVATE_LIVE_AC"] === "1";

/** lab の公開プロファイル（`phase5/profiles/*.json`、2026-10-18/20 時点）に固定した Provider の表。URL・受取先は完全一致で使う。 */
export const LIVE_PROVIDERS = {
  C: { method: "POST", host: "provider-x402-post.subethalabs.com", path: "/select", outbound: { protocol: "x402", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", maxAmount: "10000" }, result: { providerId: "select-post-c", schema: "lab.select.v1" } },
  F: { method: "POST", host: "provider-mpp-post.subethalabs.com", path: "/select", outbound: { protocol: "mpp", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", maxAmount: "10000" }, result: { providerId: "select-post-f", schema: "lab.select.v1" } },
  A: { method: "GET", host: "provider-x402.subethalabs.com", path: "/v1/eth/snapshot", outbound: { protocol: "x402", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", maxAmount: "10000" }, result: { providerId: "market-data-a" } },
  B: { method: "GET", host: "provider-mpp.subethalabs.com", path: "/v1/eth/snapshot", outbound: { protocol: "mpp", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", maxAmount: "10000" }, result: { providerId: "market-data-b" } },
} as const;
export type LiveProvider = keyof typeof LIVE_PROVIDERS;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required for PRIVATE_LIVE_AC=1`);
  return value;
}

describe.skipIf(!ENABLED)("秘匿購入の受入（owner 実行・実送金・testnet）", () => {
  const providerKey = (process.env["PRIVATE_LIVE_PROVIDER"] ?? "C") as LiveProvider;
  const provider = LIVE_PROVIDERS[providerKey];
  /** 1 回の起動で 1 つの操作だけ: quote（承認対象と再開点を書いて止まる）→ owner が読む → approve（**同じ** PRIVATE_LIVE_EVIDENCE_DIR の再開点を買う）→ 必要なら recover。 */
  const mode = (process.env["PRIVATE_LIVE_MODE"] ?? "quote") as "quote" | "approve" | "recover";
  let run: PrivatePayerRun | undefined;
  let recovery: PrivatePayerRecovery | undefined;
  let evidenceDir: string;
  let checkpoint: { quote: { paymentId: string; quoteId: string }; intentSha256: string; quoteFileSha256: string } | undefined;

  beforeAll(async () => {
    if (provider === undefined) throw new Error("PRIVATE_LIVE_PROVIDER must be one of C, F, A, B");
    if (mode !== "quote" && mode !== "approve" && mode !== "recover") throw new Error("PRIVATE_LIVE_MODE must be quote, approve or recover");
    // 支払い範囲の記録（AGENTS.md）: 実行前に存在し、内容の sha256 を証跡に残す。無ければ何も払わない。
    const scopeFile = env("PRIVATE_LIVE_SCOPE_FILE");
    expect(existsSync(scopeFile), "payment scope record must exist before any live payment").toBe(true);
    const scope = JSON.parse(readFileSync(scopeFile, "utf8")) as Record<string, unknown>;
    for (const key of ["approvedBy", "approvedAt", "networks", "maxPurchases", "maxTotalInbound", "maxTotalOutbound", "providers"]) expect(scope, `scope record field ${key}`).toHaveProperty(key);
    if (mode === "quote") {
      evidenceDir = process.env["PRIVATE_LIVE_EVIDENCE_DIR"] ?? path.resolve("runtime", "private-live", `${providerKey}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    } else {
      // approve / recover は、owner が quote で読んだディレクトリを**明示**する（新しいディレクトリ・新しい quote を作らない）。
      evidenceDir = env("PRIVATE_LIVE_EVIDENCE_DIR");
      expect(existsSync(path.join(evidenceDir, "checkpoint.json")), "PRIVATE_LIVE_EVIDENCE_DIR must hold the reviewed quote's checkpoint.json").toBe(true);
    }
    writeFileSync(path.join(evidenceDir, "scope.sha256"), `${createHash("sha256").update(readFileSync(scopeFile)).digest("hex")}\n`, { mode: 0o600 });
    const bodyFile = provider.method === "POST" ? path.join(evidenceDir, "approved_body.json") : undefined;
    // 本文は quote のときにだけ作る（承認で作り直さない: 承認対象の commitment と同じ本文を送る）。
    if (bodyFile !== undefined && mode === "quote") writeFileSync(bodyFile, process.env["PRIVATE_LIVE_BODY"] ?? JSON.stringify({ schema: "lab.select.v1", model: "lab-echo", prompt: `acceptance-${providerKey}-${Date.now()}` }), { mode: 0o600 });
    const base = {
      routerBaseUrl: env("PRIVATE_LIVE_ROUTER_URL"),
      principalId: env("PRIVATE_LIVE_PRINCIPAL"),
      token: env("PRIVATE_LIVE_TOKEN"),
      profileId: env("PRIVATE_LIVE_PROFILE"),
      method: provider.method,
      host: provider.host,
      path: provider.path,
      ...(bodyFile === undefined ? {} : { bodyFile }),
      outbound: provider.outbound,
      ...(process.env["PRIVATE_LIVE_INBOUND_MAX_TOTAL"] === undefined ? {} : { inbound: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", maxTotal: process.env["PRIVATE_LIVE_INBOUND_MAX_TOTAL"] } }),
      trust: "mozilla" as const,
      outDir: evidenceDir,
      payerPrivateKey: env("SUBETHA_PAYER_PRIVATE_KEY"),
      scopeFile,
    };
    if (mode === "recover") {
      recovery = await recoverPrivatePayer({ routerBaseUrl: base.routerBaseUrl, principalId: base.principalId, token: base.token, outDir: evidenceDir });
    } else {
      run = await runPrivatePayer({ ...base, approve: mode === "approve" });
    }
    if (existsSync(path.join(evidenceDir, "checkpoint.json"))) checkpoint = JSON.parse(readFileSync(path.join(evidenceDir, "checkpoint.json"), "utf8")) as typeof checkpoint;
    writeFileSync(path.join(evidenceDir, `run-${mode}.json`), `${JSON.stringify(run !== undefined ? (run.ok ? { ok: true, stage: run.stage, evidence: run.evidence } : { ok: false, stage: run.stage, reason: run.reason, evidence: run.evidence }) : recovery, null, 2)}\n`, { mode: 0o600 });
  }, 1_800_000);

  describe.skipIf(mode !== "quote")("quote（1 回目の起動）: 承認対象と再開点を書いて止まり、何も払わない", () => {
    test("quote.json（ownerKey 無し）と checkpoint.json（0600）が書かれ、支払いの証跡は無い", () => {
      expect(run).toMatchObject({ ok: true, stage: "quoted" });
      expect(run?.evidence.gates.inbound_settlement.settled).toBe(false);
      expect(readFileSync(path.join(evidenceDir, "quote.json"), "utf8")).not.toContain("ownerKey");
      expect(checkpoint?.quote.paymentId).toBe(run?.evidence.paymentId);
    });
  });

  describe.skipIf(mode !== "approve")("approve（2 回目の起動、同じ PRIVATE_LIVE_EVIDENCE_DIR）: 読んだ quote そのものを買う。ゲートは別々に記録", () => {
    test("再開点の quote（paymentId・intentSha256）が買われた（新しい quote・新しい本文を作っていない）", () => {
      expect(run?.ok, run === undefined ? "no run" : JSON.stringify(run)).toBe(true);
      expect(run?.evidence.paymentId).toBe(checkpoint?.quote.paymentId);
      expect(run?.evidence.intentSha256).toBe(checkpoint?.intentSha256);
      expect(createHash("sha256").update(readFileSync(path.join(evidenceDir, "quote.json"))).digest("hex")).toBe(checkpoint?.quoteFileSha256);
    });
    test("ゲート 1: 受信決済（Base Sepolia USDC、実 facilitator）の tx が journal/射影にある", () => {
      expect(run?.evidence.gates.inbound_settlement.settled, JSON.stringify(run?.evidence.gates)).toBe(true);
      expect(run?.evidence.gates.inbound_settlement.txRef).toMatch(/^0x[0-9a-f]{64}$/i);
    });
    test("ゲート 2: 送信決済（Provider の領収: x402 は PAYMENT-RESPONSE の tx、Tempo は Payment-Receipt の reference）が射影にある", () => {
      expect(run?.evidence.gates.outbound_settlement.issued).toBe(true);
      expect(run?.evidence.gates.outbound_settlement.receipt).toBe(true);
      expect(run?.evidence.gates.outbound_settlement.txRef).toMatch(/^0x[0-9a-f]{64}$/i);
    });
    test("ゲート 3: 秘匿配送（Router の attest = delivered_private、proof の delivery と POST の requestBinding、record は繰り返し取得で同一）", () => {
      expect(run?.evidence.gates.private_delivery.status).toBe("delivered_private");
      expect(run?.evidence.gates.private_delivery.proof).toMatchObject({ delivery: true, requestBinding: provider.method === "POST", onChainFinality: "not_checked" });
      expect(run?.evidence.gates.private_delivery.recordRepeatable).toBe(true);
    });
    test("ゲート 4: Payer 受領（手元で bundle を検証してから復号。平文は Provider の応答契約に合う）", () => {
      expect(run?.evidence.gates.payer_receipt).toMatchObject({ ok: true, verifiedBundleBeforeDecrypt: true });
      if (run === undefined || !run.ok || run.stage !== "delivered") throw new Error(`run did not deliver: ${JSON.stringify(run)}`);
      expect(createHash("sha256").update(run.plaintext).digest("hex")).toBe(run.evidence.gates.payer_receipt.decryptedSha256);
      const body = JSON.parse(run.plaintext.toString("utf8")) as Record<string, unknown>;
      expect(body["providerId"]).toBe(provider.result.providerId);
      if ("schema" in provider.result) expect(body["schema"]).toBe(provider.result.schema);
    });
    test("ゲート 5: finality は本 v1 では未確認（別のゲートとして明記。両チェーンの読み取りは owner が別途行う）", () => {
      expect(run?.evidence.gates.finality).toEqual({ checked: false, note: expect.stringContaining("not checked") });
    });
    test("証跡に bearer・本文・鍵・ownerKey が無い", () => {
      const text = readFileSync(path.join(evidenceDir, "run-approve.json"), "utf8");
      expect(text).not.toContain(env("SUBETHA_PAYER_PRIVATE_KEY"));
      expect(text).not.toContain("\"value\"");
      expect(text).not.toContain("ownerKey");
      if (provider.method === "POST") expect(text).not.toContain("lab-echo");
    });
  });

  describe.skipIf(mode !== "recover")("recover: 再開点の ownerKey で status と record を読み直す（何も払わない）", () => {
    test("status が読め、record があれば手元で復号される", () => {
      expect(recovery?.ok, JSON.stringify(recovery)).toBe(true);
      if (recovery === undefined || !recovery.ok) return;
      expect(recovery.paymentId).toBe(checkpoint?.quote.paymentId);
      expect(recovery.status).toBeDefined();
    });
  });
});

describe.skipIf(ENABLED)("秘匿購入の受入（PRIVATE_LIVE_AC 無し）", () => {
  test.skip("未検証: owner が PRIVATE_LIVE_AC=1 と鍵・Router の env で実行する（docs/zktls-router-acceptance.md）。skip は合格ではない", () => {});
});
