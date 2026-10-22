/**
 * `tools/private-payer.ts --burn-tx-hash`（SubEtha V2 burn-sale の受信、`docs/zktls-router-v2-inbound.md` §4）の入力の境界。**lab 不要・ネットワーク不要・何も払わない。**
 * x402 受信との取り違え（鍵の有無・`--burn-tx-hash` の有無）は latch の前で拒む。subetha の承認は鍵無しで latch まで進み、再開点に burn の tx hash（小文字）を残す。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { chainLegInputsOf, consoleProjectionOf, payFirstOf, runPrivatePayer, subethaCredentialOf, type PrivatePayerEvidence } from "../../tools/private-payer.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "payer-burn-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEY = `0x${"11".repeat(32)}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ZUSDC = "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF";
const X402_INBOUND = { network: "eip155:84532", asset: USDC, maxTotal: "2000" };
const SUBETHA_INBOUND = { network: "eip155:11155111", asset: ZUSDC, maxTotal: "2000" };
const OUTBOUND = { protocol: "x402" as const, network: "eip155:84532", asset: USDC, payTo: "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B", maxAmount: "1000" };
const BURN = `0x${"Ab".repeat(32)}`;
const BASE = { routerBaseUrl: "http://127.0.0.1:9", principalId: "owner", token: "t", profileId: "priv-subetha", method: "GET" as const, host: "provider.test", path: "/paid", outbound: OUTBOUND, trust: "lab-fixture-ca" as const, connect: "127.0.0.1:9", log: () => {} };

function fakeLab(): { labDir: string; srsPath: string } {
  const labDir = path.join(tmp, "lab");
  mkdirSync(path.join(labDir, "phase5/runner/target/release"), { recursive: true });
  writeFileSync(path.join(labDir, "phase5/runner/target/release/delivery"), "");
  const srsPath = path.join(tmp, "srs.dat");
  writeFileSync(srsPath, "");
  return { labDir, srsPath };
}
function subethaOffer(): Record<string, unknown> {
  return { scheme: "subetha-zerc20", network: "eip155:11155111", asset: ZUSDC, amount: "2000", payTo: "0x9cd753550bfa2129d532a0d5fc11fb179006de80", maxTimeoutSeconds: 300, extra: { challengeNonce: `0x${"cd".repeat(32)}`, expiresAt: Math.floor(Date.now() / 1000) + 600, routeBinding: "b", fundsMoveOnCredential: true, settlementKind: "zerc20-v2-burn-sale" } };
}
function x402Offer(): Record<string, unknown> {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "2000", payTo: "0xcD8eCC44D54d1E7a35b6625f681267ABa4ad47F5", extra: { name: "USDC", version: "2", expiresAt: Math.floor(Date.now() / 1000) + 600, challengeNonce: `0x${"ab".repeat(32)}` } };
}
/** quote 済みの再開点を模す（Router 無し: 127.0.0.1:9 は閉じている）。 */
function seedCheckpoint(out: string, offer: Record<string, unknown>, inbound: typeof X402_INBOUND, profileId: string, deadlineMs?: number): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const priv = offer["scheme"] === "subetha-zerc20" ? { inbound: { rail: "subetha", network: offer["network"], asset: offer["asset"], payTo: offer["payTo"], total: offer["amount"], fundsMoveAt: "payer_burn_before_credential" } } : { inbound: { rail: "x402", fundsMoveAt: "router_settle_after_credential" } };
  const quote = { paymentId: "p1", quoteId: "q1", ownerKey: "k", approval: { deadlineMs: deadlineMs ?? Date.now() + 600_000, boundTo: "q1" }, resource: { url: "http://127.0.0.1:9/v1/private/purchases", method: "POST" }, source: { offer }, pricing: { total: offer["amount"] }, private: priv };
  const { ownerKey: _o, ...subject } = quote;
  const quoteText = `${JSON.stringify(subject, null, 2)}\n`;
  writeFileSync(path.join(out, "quote.json"), quoteText, { mode: 0o600 });
  const checkpoint = { version: "private-payer-checkpoint-v1", createdAt: new Date().toISOString(), requestId: "r1", quote, quoteFileSha256: createHash("sha256").update(quoteText).digest("hex"), intentSha256: "a".repeat(64), orderId: "0".repeat(64), args: { routerBaseUrl: BASE.routerBaseUrl, principalId: BASE.principalId, profileId, method: "GET", host: "provider.test", path: "/paid", outbound: OUTBOUND, inbound, trust: "lab-fixture-ca" }, progress: { paymentId: "p1" } };
  writeFileSync(path.join(out, "checkpoint.json"), JSON.stringify(checkpoint), { mode: 0o600 });
  writeFileSync(path.join(out, "evidence.json"), JSON.stringify({ runId: "r", startedAt: "s", trust: "lab-fixture-ca", synthetic: true, provider: { method: "GET", host: "provider.test", path: "/paid" }, gates: { inbound_settlement: { settled: false }, outbound_settlement: { issued: false, receipt: false }, private_delivery: {}, payer_receipt: { ok: false }, finality: { checked: false, note: "n" } } }), { mode: 0o600 });
}
const progressOf = (out: string): Record<string, unknown> => (JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { progress: Record<string, unknown> }).progress;

describe("--burn-tx-hash: subetha burn-sale の受信（lab 不要）", () => {
  test("subethaCredentialOf は {x402Version, accepted: offer そのもの, payload: {challengeNonce, burnTxHash}}。payFirstOf は burn-sale の quote だけ払う先と額を返す", () => {
    const offer = subethaOffer();
    const decoded = JSON.parse(Buffer.from(subethaCredentialOf(offer, BURN.toLowerCase()), "base64").toString("utf8")) as Record<string, unknown>;
    expect(decoded).toEqual({ x402Version: 2, accepted: offer, payload: { challengeNonce: (offer["extra"] as Record<string, unknown>)["challengeNonce"], burnTxHash: BURN.toLowerCase() } });
    const subethaQuote = { private: { inbound: { rail: "subetha", network: "eip155:11155111", asset: ZUSDC, payTo: offer["payTo"], total: "2000", fundsMoveAt: "payer_burn_before_credential" } } };
    expect(payFirstOf(subethaQuote as never)).toEqual({ payTo: offer["payTo"], amount: "2000", network: "eip155:11155111", asset: ZUSDC });
    expect(payFirstOf({ private: { inbound: { rail: "x402", fundsMoveAt: "router_settle_after_credential", payTo: "0x1", total: "1", network: "n", asset: "a" } } } as never)).toBeUndefined();
    expect(payFirstOf({} as never)).toBeUndefined();
  });

  test("前提の段: x402 受信は鍵が要り --burn-tx-hash を拒む。壊れた tx hash も拒む。何も書かない", async () => {
    const lab = fakeLab();
    const out = path.join(tmp, "pre-out");
    const noKey = await runPrivatePayer({ ...BASE, ...lab, profileId: "priv-3p", inbound: X402_INBOUND, outDir: out, approve: false });
    expect(noKey).toMatchObject({ ok: false, stage: "prerequisites" });
    if (!noKey.ok) expect(noKey.reason).toContain("SUBETHA_PAYER_PRIVATE_KEY is required");
    const burnOnX402 = await runPrivatePayer({ ...BASE, ...lab, profileId: "priv-3p", inbound: X402_INBOUND, payerPrivateKey: KEY, burnTxHash: BURN, outDir: out, approve: true });
    expect(burnOnX402).toMatchObject({ ok: false, stage: "prerequisites" });
    if (!burnOnX402.ok) expect(burnOnX402.reason).toContain("applies only to a SubEtha burn-sale");
    const malformed = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: "0x1234", outDir: out, approve: true });
    expect(malformed).toMatchObject({ ok: false, stage: "prerequisites" });
    if (!malformed.ok) expect(malformed.reason).toContain("32-byte transaction hash");
    expect(existsSync(path.join(out, "checkpoint.json"))).toBe(false);
    // subetha 受信は鍵無しで前提を通る（次の段 = review/keygen。偽の lab の keygen は失敗するが前提の拒否ではない）。
    const subethaNoKey = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, outDir: path.join(tmp, "pre-out-2"), approve: false });
    expect(subethaNoKey.ok).toBe(false);
    if (!subethaNoKey.ok) expect(subethaNoKey.stage).toBe("keygen");
  });

  test("承認の段（latch の前）: subetha の quote に --burn-tx-hash が無い → 拒否、x402 の quote に --burn-tx-hash → 拒否、x402 の quote に鍵無し → 拒否。いずれも latch は書かれない", async () => {
    const lab = fakeLab();
    const sub = path.join(tmp, "approve-sub");
    seedCheckpoint(sub, subethaOffer(), SUBETHA_INBOUND, "priv-subetha");
    const missing = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, outDir: sub, approve: true });
    expect(missing).toMatchObject({ ok: false, stage: "approve" });
    if (!missing.ok) expect(missing.reason).toContain("--approve --burn-tx-hash");
    expect(progressOf(sub)["purchaseAttempted"]).toBeUndefined();
    const x = path.join(tmp, "approve-x402");
    seedCheckpoint(x, x402Offer(), SUBETHA_INBOUND, "priv-subetha");
    // 再開点の offer は x402（facilitator が V1 の形で返した・設定が変わった等）: 入力の inbound は subetha でも、quote の受信レールが権威。
    const burnOnX402 = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: x, approve: true });
    expect(burnOnX402).toMatchObject({ ok: false, stage: "approve" });
    if (!burnOnX402.ok) expect(burnOnX402.reason).toContain("this quote's inbound is x402");
    const noKey = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, outDir: x, approve: true });
    expect(noKey).toMatchObject({ ok: false, stage: "approve" });
    if (!noKey.ok) expect(noKey.reason).toContain("SUBETHA_PAYER_PRIVATE_KEY is required");
    expect(progressOf(x)["purchaseAttempted"]).toBeUndefined();
    // 知らない scheme・extra 無しの再開点は署名にも latch にも進まない（鍵と burn の両方があっても）。
    const unknown = path.join(tmp, "approve-unknown");
    seedCheckpoint(unknown, { ...x402Offer(), scheme: "permit-v9" }, X402_INBOUND, "priv-3p");
    const unsupported = await runPrivatePayer({ ...BASE, ...lab, profileId: "priv-3p", inbound: X402_INBOUND, payerPrivateKey: KEY, outDir: unknown, approve: true });
    expect(unsupported).toMatchObject({ ok: false, stage: "approve" });
    if (!unsupported.ok) expect(unsupported.reason).toContain("not supported by this tool");
    expect(progressOf(unknown)).toEqual({ paymentId: "p1" });
    const noExtra = path.join(tmp, "approve-noextra");
    const { extra: _e, ...bare } = subethaOffer();
    seedCheckpoint(noExtra, bare, SUBETHA_INBOUND, "priv-subetha");
    const malformed = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: noExtra, approve: true });
    expect(malformed).toMatchObject({ ok: false, stage: "approve" });
    if (!malformed.ok) expect(malformed.reason).toContain("malformed");
    expect(progressOf(noExtra)).toEqual({ paymentId: "p1" });
    expect(existsSync(path.join(noExtra, "payment_header.json"))).toBe(false);
    // burn を渡した承認が期限切れ: 「新しい --out で quote し直せ」とは言わない（transfer は戻らない。照合を促す）。latch 無し。
    const expired = path.join(tmp, "approve-expired");
    seedCheckpoint(expired, subethaOffer(), SUBETHA_INBOUND, "priv-subetha", Date.now() - 1);
    const late = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: expired, approve: true });
    expect(late).toMatchObject({ ok: false, stage: "approve" });
    if (!late.ok) {
      expect(late.reason).toContain("expired");
      expect(late.reason).toContain("does not reverse");
      expect(late.reason).not.toContain("quote again in a new --out");
    }
    expect(progressOf(expired)).toEqual({ paymentId: "p1" });
    // 同じ期限切れでも burn 無し（x402 の流儀）は従来の案内のまま。
    const lateNoBurn = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, outDir: expired, approve: true });
    if (!lateNoBurn.ok) expect(lateNoBurn.reason).toContain("quote again in a new --out");
    // 引数違い・quote.json の改変・quote.json の削除の拒否も、burn 付きなら「quote し直せ」と言わず照合を促す（再開点・証跡は不変）。
    const beforeCheckpoint = readFileSync(path.join(sub, "checkpoint.json"), "utf8");
    const beforeEvidence = readFileSync(path.join(sub, "evidence.json"), "utf8");
    const differ = await runPrivatePayer({ ...BASE, ...lab, inbound: { ...SUBETHA_INBOUND, maxTotal: "3000" }, burnTxHash: BURN, outDir: sub, approve: true });
    expect(differ).toMatchObject({ ok: false, stage: "approve" });
    if (!differ.ok) {
      expect(differ.reason).toContain("arguments differ");
      expect(differ.reason).toContain("reconcile");
      expect(differ.reason).not.toContain("quote again");
    }
    const quoteText = readFileSync(path.join(sub, "quote.json"), "utf8");
    writeFileSync(path.join(sub, "quote.json"), `${quoteText} `, { mode: 0o600 });
    const modified = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: sub, approve: true });
    expect(modified).toMatchObject({ ok: false, stage: "approve" });
    if (!modified.ok) {
      expect(modified.reason).toContain("quote.json was modified or removed");
      expect(modified.reason).toContain("reconcile");
      expect(modified.reason).not.toContain("quote again");
    }
    rmSync(path.join(sub, "quote.json"));
    const removed = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: sub, approve: true });
    expect(removed).toMatchObject({ ok: false, stage: "approve" });
    if (!removed.ok) {
      expect(removed.reason).toContain("reconcile");
      expect(removed.reason).not.toContain("quote again");
    }
    expect(readFileSync(path.join(sub, "checkpoint.json"), "utf8")).toBe(beforeCheckpoint);
    expect(readFileSync(path.join(sub, "evidence.json"), "utf8")).toBe(beforeEvidence);
    // burn 無しの同じ拒否は従来どおり「quote し直せ」。
    writeFileSync(path.join(sub, "quote.json"), `${quoteText} `, { mode: 0o600 });
    const modifiedNoBurn = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, outDir: sub, approve: true });
    if (!modifiedNoBurn.ok) expect(modifiedNoBurn.reason).toContain("quote again in a new --out");
    expect(progressOf(sub)["purchaseAttempted"]).toBeUndefined();
  });

  test("subetha の承認は鍵無しで latch まで進み、再開点に burnTxHash（小文字）、証跡に claimedTxRef を残す（署名無し・payment_header 無し）。以後の承認は latch で拒む", async () => {
    const lab = fakeLab();
    const out = path.join(tmp, "approve-latch");
    seedCheckpoint(out, subethaOffer(), SUBETHA_INBOUND, "priv-subetha");
    // 試験専用 `afterLatch` は latch の後・credential の前。burn の hash は latch の直後に書くので、ここで止めると latch だけが残る。
    await expect(runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: out, approve: true, hooksForTest: { afterLatch: () => { throw new Error("stop-before-credential"); } } })).rejects.toThrow("stop-before-credential");
    expect(progressOf(out)).toMatchObject({ purchaseAttempted: true });
    expect(progressOf(out)["payerAddress"]).toBeUndefined();
    expect(existsSync(path.join(out, "payment_header.json"))).toBe(false);
    const again = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: out, approve: true });
    expect(again).toMatchObject({ ok: false, stage: "approve" });
    if (!again.ok) expect(again.reason).toContain("already attempted");
    // latch の後、credential まで組む（鍵無し）→ purchase の応答喪失（127.0.0.1:9 は閉じている。client は `unknown: transport_uncertain` にする）: 「払ったかもしれない」。
    // 両決済は uncertain、申告した burn（claimedTxRef）は消えない。
    const out2 = path.join(tmp, "approve-lost");
    seedCheckpoint(out2, subethaOffer(), SUBETHA_INBOUND, "priv-subetha");
    const lost = await runPrivatePayer({ ...BASE, ...lab, inbound: SUBETHA_INBOUND, burnTxHash: BURN, outDir: out2, approve: true });
    expect(lost).toMatchObject({ ok: false, stage: "purchase" });
    if (!lost.ok) expect(lost.reason).toContain("unknown");
    expect(progressOf(out2)).toMatchObject({ purchaseAttempted: true, burnTxHash: BURN.toLowerCase() });
    expect(progressOf(out2)["payerAddress"]).toBeUndefined();
    const evidence = JSON.parse(readFileSync(path.join(out2, "evidence.json"), "utf8")) as PrivatePayerEvidence;
    expect(evidence.gates.inbound_settlement).toEqual({ settled: false, uncertain: true, claimedTxRef: BURN.toLowerCase() });
    expect(evidence.gates.outbound_settlement).toEqual({ issued: false, receipt: false, uncertain: true });
    // コンソールの射影は claimedTxRef も出さない（tx 参照は証跡ファイルにだけ）。
    expect((consoleProjectionOf(evidence)["gates"] as { inbound_settlement: Record<string, unknown> }).inbound_settlement["claimedTxRef"]).toBeUndefined();
    expect(JSON.stringify(consoleProjectionOf(evidence))).not.toContain(BURN.toLowerCase());
  });

  test("chainLegInputsOf: subetha の受信は protocol で読まない（payer address 無しでも理由は protocol）", () => {
    const out = path.join(tmp, "chain-sub");
    seedCheckpoint(out, subethaOffer(), SUBETHA_INBOUND, "priv-subetha");
    const checkpoint = JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as Record<string, unknown>;
    expect(chainLegInputsOf(checkpoint as never, out, undefined)).toEqual({ ok: true, skipped: { inbound: "protocol" } });
    expect(chainLegInputsOf({ ...checkpoint, progress: { paymentId: "p1", burnTxHash: BURN.toLowerCase() } } as never, out, "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B")).toEqual({ ok: true, skipped: { inbound: "protocol" } });
  });

  test("CLI: --burn-tx-hash は --approve と、--inbound-network は --inbound-asset と --inbound-max-total と組で。x402 受信だけ鍵が必須。違反は exit 2 で何にも接続しない", async () => {
    const cli = (args: string[], env: Record<string, string> = {}): Promise<{ status: number; stderr: string }> =>
      new Promise((resolve) => {
        execFile(process.execPath, ["--import", "tsx", "tools/private-payer.ts", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SUBETHA_PAYER_PRIVATE_KEY: "", PRIVATE_PAYER_TOKEN: "t", ...env } }, (error, _stdout, stderr) => {
          resolve({ status: error === null ? 0 : ((error as { code?: number }).code ?? 1), stderr: String(stderr) });
        });
      });
    const cliFull = (args: string[], env: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> =>
      new Promise((resolve) => {
        execFile(process.execPath, ["--import", "tsx", "tools/private-payer.ts", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SUBETHA_PAYER_PRIVATE_KEY: "", PRIVATE_PAYER_TOKEN: "t", ...env } }, (error, stdout, stderr) => {
          resolve({ status: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout: String(stdout), stderr: String(stderr) });
        });
      });
    const out = path.join(tmp, "cli-out");
    const common = ["--router", "http://127.0.0.1:9", "--principal", "owner", "--profile", "priv-subetha", "--method", "GET", "--host", "provider.test", "--path", "/paid", "--outbound-protocol", "x402", "--outbound-network", OUTBOUND.network, "--outbound-asset", OUTBOUND.asset, "--outbound-pay-to", OUTBOUND.payTo, "--outbound-max-amount", "1000", "--trust", "lab-fixture-ca", "--out", out];
    const subetha = ["--inbound-network", SUBETHA_INBOUND.network, "--inbound-asset", ZUSDC, "--inbound-max-total", "2000"];
    const cases: [string, string[], Record<string, string>, string][] = [
      ["burn without approve", [...common, ...subetha, "--burn-tx-hash", BURN], {}, "--burn-tx-hash goes with --approve"],
      ["network without asset", [...common, "--inbound-network", SUBETHA_INBOUND.network, "--inbound-max-total", "2000"], {}, "go together"],
      ["network without max-total", [...common, "--inbound-network", SUBETHA_INBOUND.network, "--inbound-asset", ZUSDC], {}, "--inbound-max-total is required"],
      ["x402 without key", [...common], {}, "SUBETHA_PAYER_PRIVATE_KEY is required"],
    ];
    for (const [name, args, env, expected] of cases) {
      const result = await cli(args, env);
      expect(result.status, name).toBe(2);
      expect(result.stderr, name).toContain(expected);
    }
    expect(existsSync(out)).toBe(false);
    // subetha 受信は鍵無しでも引数の段を通る（この先は lab の前提で止まる = exit 1、exit 2 ではない）。
    const noKey = await cli([...common, ...subetha, "--lab-dir", path.join(tmp, "no-lab")]);
    expect(noKey.status).toBe(1);
    expect(noKey.stderr).toContain("prerequisites");
    // 承認の stdout は tx 参照を出さない射影（claimedTxRef・txRef は evidence.json にだけ）。
    const lab = fakeLab();
    const seeded = path.join(tmp, "cli-seeded");
    seedCheckpoint(seeded, subethaOffer(), SUBETHA_INBOUND, "priv-subetha");
    const approved = await cliFull([...common.slice(0, -1), seeded, ...subetha, "--lab-dir", lab.labDir, "--approve", "--burn-tx-hash", BURN], { SUBETHA_ZKTLS_SRS_DAT: lab.srsPath });
    expect(approved.status).toBe(1);
    expect(approved.stdout).toContain('"stage":"purchase"');
    expect(approved.stdout).not.toContain(BURN.toLowerCase());
    expect(approved.stdout).not.toContain(BURN);
    expect(readFileSync(path.join(seeded, "evidence.json"), "utf8")).toContain(BURN.toLowerCase());
  }, 120_000);
});
