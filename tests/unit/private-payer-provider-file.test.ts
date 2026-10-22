/**
 * `tools/private-payer.ts --provider-file` の入力の境界（`docs/zktls-router-thirdparty.md` §4.2・§5 T-3P2）。**lab 不要・ネットワーク不要・何も払わない。**
 * 壊れた provider.json、手入力との併用、承認時に provider.json が変わっていること、synthetic な事前検査の `mozilla` での拒否、証跡の出所の保持。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { runPrivatePayer, withProviderFile } from "../../tools/private-payer.js";
import { PROVIDER_FILE_VERSION } from "../../tools/private-provider-precheck.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "payer-pf-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function providerDoc(overrides: Record<string, unknown> = {}, observed: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: PROVIDER_FILE_VERSION,
    method: "GET",
    host: "provider.test",
    path: "/paid",
    url: "https://provider.test/paid",
    outbound: { protocol: "x402", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B", maxAmount: "1000" },
    observed: { synthetic: false, trust: "mozilla", tlsVersion: "TLSv1.2", cipher: "ECDHE-ECDSA-AES128-GCM-SHA256", status: 402, httpVersion: "HTTP/1.1", framing402: "content-length", headBytes402: 100, acceptsCount: 1, maxTimeoutSeconds: 300, skeletonBytes: 80, ...observed },
    notVerified: [],
    checkedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}
function writeDoc(name: string, doc: Record<string, unknown>): string {
  const file = path.join(tmp, name);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}
/** 存在だけを見られる偽の lab（approve は keygen を走らせないので、前提の検査を通すためのダミー）。 */
function fakeLab(): { labDir: string; srsPath: string } {
  const labDir = path.join(tmp, "lab");
  mkdirSync(path.join(labDir, "phase5/runner/target/release"), { recursive: true });
  writeFileSync(path.join(labDir, "phase5/runner/target/release/delivery"), "");
  const srsPath = path.join(tmp, "srs.dat");
  writeFileSync(srsPath, "");
  return { labDir, srsPath };
}
const KEY = `0x${"11".repeat(32)}`;
const BASE = { routerBaseUrl: "http://127.0.0.1:9", principalId: "owner", token: "t", profileId: "priv-3p", trust: "lab-fixture-ca" as const, payerPrivateKey: KEY, log: () => {} };

describe("--provider-file: 入力の境界（lab 不要）", () => {
  test("withProviderFile: 正しいファイルは値をそのまま写し、sha256 と synthetic を添える。壊れたファイルは undefined", () => {
    const ok = writeDoc("ok.json", providerDoc());
    const resolved = withProviderFile(ok, { a: 1 });
    expect(resolved).toMatchObject({ a: 1, method: "GET", host: "provider.test", path: "/paid", outbound: { protocol: "x402", payTo: "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B", maxAmount: "1000" }, providerSynthetic: false, providerFileSha256: createHash("sha256").update(readFileSync(ok)).digest("hex") });
    const bad: [string, Record<string, unknown>][] = [
      ["version", providerDoc({ version: "x" })],
      ["method", providerDoc({ method: "POST" })],
      ["query", providerDoc({ path: "/paid?x=1", url: "https://provider.test/paid?x=1" })],
      ["url-mismatch", providerDoc({ url: "https://provider.test/other" })],
      ["host-ip", providerDoc({ host: "127.0.0.1", url: "https://127.0.0.1/paid" })],
      ["protocol", providerDoc({ outbound: { ...(providerDoc()["outbound"] as object), protocol: "mpp" } })],
      ["network", providerDoc({ outbound: { ...(providerDoc()["outbound"] as object), network: "eip155:8453" } })],
      ["payTo", providerDoc({ outbound: { ...(providerDoc()["outbound"] as object), payTo: "0x1" } })],
      ["amount", providerDoc({ outbound: { ...(providerDoc()["outbound"] as object), maxAmount: "0" } })],
      ["observed", providerDoc({ observed: {} })],
    ];
    for (const [name, doc] of bad) expect(withProviderFile(writeDoc(`bad-${name}.json`, doc), {}), name).toBeUndefined();
    writeFileSync(path.join(tmp, "not-json.json"), "{");
    expect(withProviderFile(path.join(tmp, "not-json.json"), {})).toBeUndefined();
    expect(withProviderFile(path.join(tmp, "missing.json"), {})).toBeUndefined();
  });

  test("CLI: --provider-file と手入力（8 つのどれか）の併用は exit 2、読めない provider.json も exit 2。何にも接続しない", async () => {
    const ok = writeDoc("cli-ok.json", providerDoc());
    const cli = (args: string[]): Promise<{ status: number; stderr: string }> =>
      new Promise((resolve) => {
        execFile(process.execPath, ["--import", "tsx", "tools/private-payer.ts", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PRIVATE_PAYER_TOKEN: "t", SUBETHA_PAYER_PRIVATE_KEY: KEY } }, (error, _stdout, stderr) => {
          resolve({ status: error === null ? 0 : ((error as { code?: number }).code ?? 1), stderr: String(stderr) });
        });
      });
    const common = ["--router", "http://127.0.0.1:9", "--principal", "owner", "--profile", "priv-3p", "--out", path.join(tmp, "cli-out")];
    const manual: [string, string][] = [
      ["--method", "GET"],
      ["--host", "provider.test"],
      ["--path", "/paid"],
      ["--outbound-protocol", "x402"],
      ["--outbound-network", "eip155:84532"],
      ["--outbound-asset", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
      ["--outbound-pay-to", "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B"],
      ["--outbound-max-amount", "1000"],
    ];
    for (const [flag, value] of manual) {
      const result = await cli([...common, "--provider-file", ok, flag, value]);
      expect(result.status, flag).toBe(2);
      expect(result.stderr).toContain("--provider-file replaces");
    }
    const unreadable = await cli([...common, "--provider-file", writeDoc("cli-bad.json", providerDoc({ method: "POST" }))]);
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toContain("not a readable provider.json");
    expect(existsSync(path.join(tmp, "cli-out"))).toBe(false);
  }, 120_000);

  test("synthetic な事前検査（test CA / loopback の差し替え）は --trust mozilla で前提の段で拒む（何も書かない・払わない）", async () => {
    const lab = fakeLab();
    const synthetic = withProviderFile(writeDoc("syn.json", providerDoc({}, { synthetic: true, trust: "test-ca" })), { ...BASE, ...lab, trust: "mozilla" as const, scopeFile: writeDoc("scope.json", { approvedBy: "x" }), outDir: path.join(tmp, "syn-out"), approve: false });
    expect(synthetic).toBeDefined();
    const run = await runPrivatePayer(synthetic!);
    expect(run).toMatchObject({ ok: false, stage: "prerequisites" });
    if (!run.ok) expect(run.reason).toContain("synthetic");
    expect(existsSync(path.join(tmp, "syn-out", "checkpoint.json"))).toBe(false);
    // 同じファイルでも lab-fixture-ca（試験）なら前提は通る（次の段 = review/keygen に進む。偽の lab の keygen は失敗するが、前提の拒否ではない）。
    const lab2 = await runPrivatePayer({ ...synthetic!, trust: "lab-fixture-ca", scopeFile: undefined as never, connect: "127.0.0.1:9", outDir: path.join(tmp, "syn-out-2") });
    expect(lab2.ok).toBe(false);
    if (!lab2.ok) expect(lab2.stage).toBe("keygen");
  });

  test("承認時に provider.json が変わっている（sha256 が再開点の args と違う）→ approve で拒み、署名も購入要求も起きず、証跡の出所は quote のまま", async () => {
    const lab = fakeLab();
    const out = path.join(tmp, "approve-out");
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const file = writeDoc("approve.json", providerDoc());
    const quoted = withProviderFile(file, { ...BASE, ...lab, outDir: out, approve: false, connect: "127.0.0.1:9" })!;
    const inbound = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", maxTotal: "2000" };
    // quote 済みの再開点を模す（Router 無し）: args は quote のときの展開後の値 + providerFileSha256。
    const quoteText = `${JSON.stringify({ paymentId: "p1", quoteId: "q1", approval: { deadlineMs: Date.now() + 600_000 } }, null, 2)}\n`;
    writeFileSync(path.join(out, "quote.json"), quoteText, { mode: 0o600 });
    const checkpoint = {
      version: "private-payer-checkpoint-v1",
      createdAt: new Date().toISOString(),
      requestId: "r1",
      // offer は受信 credential を**手元で**署名できる形（Router には届かない: 127.0.0.1:9 は閉じている）。
      quote: { paymentId: "p1", quoteId: "q1", ownerKey: "k", approval: { deadlineMs: Date.now() + 600_000 }, source: { offer: { scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0xcD8eCC44D54d1E7a35b6625f681267ABa4ad47F5", amount: "2000", extra: { name: "USDC", version: "2", expiresAt: String(Math.floor(Date.now() / 1000) + 600), challengeNonce: `0x${"ab".repeat(32)}` } } }, pricing: {} },
      quoteFileSha256: createHash("sha256").update(quoteText).digest("hex"),
      intentSha256: "a".repeat(64),
      orderId: "0".repeat(64),
      args: { routerBaseUrl: BASE.routerBaseUrl, principalId: BASE.principalId, profileId: BASE.profileId, method: "GET", host: "provider.test", path: "/paid", outbound: quoted.outbound, inbound, trust: "lab-fixture-ca", providerFileSha256: quoted.providerFileSha256 },
      progress: { paymentId: "p1" },
    };
    writeFileSync(path.join(out, "checkpoint.json"), JSON.stringify(checkpoint), { mode: 0o600 });
    writeFileSync(path.join(out, "evidence.json"), JSON.stringify({ runId: "r", startedAt: "s", trust: "lab-fixture-ca", synthetic: true, provider: { method: "GET", host: "provider.test", path: "/paid" }, providerFileSha256: quoted.providerFileSha256, gates: { inbound_settlement: { settled: false }, outbound_settlement: { issued: false, receipt: false }, private_delivery: {}, payer_receipt: { ok: false }, finality: { checked: false, note: "n" } } }), { mode: 0o600 });
    // 同じ値・別のバイト列（整形だけ変えた）= 別の sha256。
    writeFileSync(file, JSON.stringify(providerDoc(), null, 2));
    const changed = withProviderFile(file, { ...BASE, ...lab, outDir: out, approve: true, inbound, connect: "127.0.0.1:9" })!;
    expect(changed.providerFileSha256).not.toBe(quoted.providerFileSha256);
    const run = await runPrivatePayer(changed);
    expect(run).toMatchObject({ ok: false, stage: "approve" });
    if (!run.ok) expect(run.reason).toContain("arguments differ");
    // 返された証跡も、保存された証跡も、出所は quote のときの digest のまま（拒否された digest を載せない）。
    expect(run.evidence.providerFileSha256).toBe(quoted.providerFileSha256);
    const evidence = JSON.parse(readFileSync(path.join(out, "evidence.json"), "utf8")) as Record<string, unknown>;
    expect(evidence["providerFileSha256"]).toBe(quoted.providerFileSha256);
    expect(JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8"))).toMatchObject({ progress: { paymentId: "p1" } });
    expect((JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { progress: Record<string, unknown> }).progress["purchaseAttempted"]).toBeUndefined();
    expect(existsSync(path.join(out, "refusals.json"))).toBe(true);
    // 元のバイト列に戻せば args は一致し、次の段（latch）に進む = 引数の拒否ではない。署名もネットワークも無しで確かめるため、
    // 試験専用の `afterLatch`（latch の後・署名の前）で止める: latch が書かれ、署名・purchase は起きない。
    writeFileSync(file, JSON.stringify(providerDoc()));
    const same = withProviderFile(file, { ...BASE, ...lab, outDir: out, approve: true, inbound, connect: "127.0.0.1:9", hooksForTest: { afterLatch: () => { throw new Error("stop-before-signing"); } } })!;
    expect(same.providerFileSha256).toBe(quoted.providerFileSha256);
    await expect(runPrivatePayer(same)).rejects.toThrow("stop-before-signing");
    expect((JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { progress: Record<string, unknown> }).progress["purchaseAttempted"]).toBe(true);
    expect(existsSync(path.join(out, "payment_header.json"))).toBe(false);
    // 以後の承認は latch で拒む（--recover へ）。
    const after = await runPrivatePayer(withProviderFile(file, { ...BASE, ...lab, outDir: out, approve: true, inbound, connect: "127.0.0.1:9" })!);
    expect(after).toMatchObject({ ok: false, stage: "approve" });
    if (!after.ok) expect(after.reason).toContain("already attempted");
  });
});
