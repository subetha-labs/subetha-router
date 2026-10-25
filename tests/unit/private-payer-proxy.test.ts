/**
 * 増分 v1.5（proxy 型）T-X7: `tools/private-payer.ts` が quote の TLS の型に従う（`docs/zktls-router-proxy-design.md` §11、要件 FR-X12）。
 * **lab 不要・ネットワーク不要・何も払わない**（Router は 127.0.0.1:9 = 閉じている）。拒否はすべて latch・受信 credential の前。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { runPrivatePayer, tlsModeLineOf, tlsModeOfQuote } from "../../tools/private-payer.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "payer-proxy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEY = `0x${"11".repeat(32)}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const X402_INBOUND = { network: "eip155:84532", asset: USDC, maxTotal: "2000" };
const OUTBOUND = { protocol: "x402" as const, network: "eip155:84532", asset: USDC, payTo: "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B", maxAmount: "1000" };
const BASE = { routerBaseUrl: "http://127.0.0.1:9", principalId: "owner", token: "t", profileId: "priv-3p", method: "GET" as const, host: "provider.test", path: "/paid", outbound: OUTBOUND, trust: "lab-fixture-ca" as const };

function fakeLab(): { labDir: string; srsPath: string } {
  const labDir = path.join(tmp, "lab");
  mkdirSync(path.join(labDir, "phase5/runner/target/release"), { recursive: true });
  writeFileSync(path.join(labDir, "phase5/runner/target/release/delivery"), "");
  const srsPath = path.join(tmp, "srs.dat");
  writeFileSync(srsPath, "");
  return { labDir, srsPath };
}
function x402Offer(): Record<string, unknown> {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "2000", payTo: "0xcD8eCC44D54d1E7a35b6625f681267ABa4ad47F5", extra: { name: "USDC", version: "2", expiresAt: Math.floor(Date.now() / 1000) + 600, challengeNonce: `0x${"ab".repeat(32)}` } };
}
/** quote 済みの再開点を模す。`tls` は quote の `private.tls`（undefined なら欄を置かない）。 */
function seedCheckpoint(out: string, tls: unknown): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const priv: Record<string, unknown> = { inbound: { rail: "x402", fundsMoveAt: "router_purchase_settle_before_issuance" } };
  if (tls !== undefined) priv["tls"] = tls;
  const quote = { paymentId: "p1", quoteId: "q1", ownerKey: "k", approval: { deadlineMs: Date.now() + 600_000, boundTo: "q1" }, resource: { url: "http://127.0.0.1:9/v1/private/purchases", method: "POST" }, source: { offer: x402Offer() }, pricing: { total: "2000" }, private: priv };
  const { ownerKey: _o, ...subject } = quote;
  const quoteText = `${JSON.stringify(subject, null, 2)}\n`;
  writeFileSync(path.join(out, "quote.json"), quoteText, { mode: 0o600 });
  const checkpoint = { version: "private-payer-checkpoint-v1", createdAt: new Date().toISOString(), requestId: "r1", quote, quoteFileSha256: createHash("sha256").update(quoteText).digest("hex"), intentSha256: "a".repeat(64), orderId: "0".repeat(64), args: { routerBaseUrl: BASE.routerBaseUrl, principalId: BASE.principalId, profileId: BASE.profileId, method: "GET", host: "provider.test", path: "/paid", outbound: OUTBOUND, inbound: X402_INBOUND, trust: "lab-fixture-ca" }, progress: { paymentId: "p1" } };
  writeFileSync(path.join(out, "checkpoint.json"), JSON.stringify(checkpoint), { mode: 0o600 });
  writeFileSync(path.join(out, "evidence.json"), JSON.stringify({ runId: "r", startedAt: "s", trust: "lab-fixture-ca", synthetic: true, provider: { method: "GET", host: "provider.test", path: "/paid" }, gates: { inbound_settlement: { settled: false }, outbound_settlement: { issued: false, receipt: false }, private_delivery: {}, payer_receipt: { ok: false }, finality: { checked: false, note: "n" } } }), { mode: 0o600 });
}
const progressOf = (out: string): Record<string, unknown> => (JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { progress: Record<string, unknown> }).progress;

describe("tlsModeOfQuote・tlsModeLineOf", () => {
  test("欄が無ければ MPC 型、{mode: proxy} なら proxy 型、それ以外は invalid", () => {
    expect(tlsModeOfQuote({})).toBe("mpc");
    expect(tlsModeOfQuote({ inbound: {} })).toBe("mpc");
    expect(tlsModeOfQuote(undefined)).toBe("mpc");
    expect(tlsModeOfQuote({ tls: { mode: "proxy", relay: { maxSentBytes: 1, maxRecvBytes: 2 } } })).toBe("proxy");
    for (const bad of [null, "proxy", { mode: "mpc" }, { mode: "PROXY" }, {}, []]) expect(tlsModeOfQuote({ tls: bad }), JSON.stringify(bad)).toBe("invalid");
  });
  test("proxy 型の表示は開示 3 つを平文で言う", () => {
    const line = tlsModeLineOf("proxy");
    expect(line).toContain("the Router connects to the Provider");
    expect(line).toContain("the Provider sees the Router's IP address");
    expect(line).toContain("trusts the network path between the Router and the Provider");
    expect(tlsModeLineOf("mpc")).toBe("private-payer: tls mode: mpc");
  });
});

describe("承認の段（latch・受信 credential の前に決める）", () => {
  test("proxy 型の quote に --connect: prerequisites で拒否し、latch を書かない", async () => {
    const out = path.join(tmp, "proxy-connect");
    seedCheckpoint(out, { mode: "proxy" });
    const run = await runPrivatePayer({ ...BASE, ...fakeLab(), inbound: X402_INBOUND, payerPrivateKey: KEY, connect: "127.0.0.1:9", outDir: out, approve: true, log: () => {} });
    expect(run).toMatchObject({ ok: false, stage: "prerequisites" });
    if (!run.ok) expect(run.reason).toContain("--connect is not used in proxy mode");
    expect(progressOf(out)).toEqual({ paymentId: "p1" });
  });
  test("知らない TLS の型の quote: approve で拒否し、latch を書かない", async () => {
    const out = path.join(tmp, "unknown-mode");
    seedCheckpoint(out, { mode: "quic" });
    const run = await runPrivatePayer({ ...BASE, ...fakeLab(), inbound: X402_INBOUND, payerPrivateKey: KEY, outDir: out, approve: true, log: () => {} });
    expect(run).toMatchObject({ ok: false, stage: "approve" });
    if (!run.ok) expect(run.reason).toContain("unknown tls mode");
    expect(progressOf(out)).toEqual({ paymentId: "p1" });
  });
  test("proxy 型で --connect 無し: 型の表示を出して latch に進む（Router は閉じているので purchase の応答喪失 = 払ったかもしれない）", async () => {
    const out = path.join(tmp, "proxy-ok");
    seedCheckpoint(out, { mode: "proxy" });
    const lines: string[] = [];
    const run = await runPrivatePayer({ ...BASE, ...fakeLab(), inbound: X402_INBOUND, payerPrivateKey: KEY, outDir: out, approve: true, log: (line: string) => lines.push(line) });
    expect(run).toMatchObject({ ok: false, stage: "purchase" });
    expect(progressOf(out)).toMatchObject({ purchaseAttempted: true });
    expect(lines.some((line) => line.startsWith("private-payer: tls mode: proxy"))).toBe(true);
  });
  test("MPC 型（tls 欄なし）の quote は今と同じ（--connect を使える）", async () => {
    const out = path.join(tmp, "mpc-connect");
    seedCheckpoint(out, undefined);
    const lines: string[] = [];
    const run = await runPrivatePayer({ ...BASE, ...fakeLab(), inbound: X402_INBOUND, payerPrivateKey: KEY, connect: "127.0.0.1:9", outDir: out, approve: true, log: (line: string) => lines.push(line) });
    expect(run).toMatchObject({ ok: false, stage: "purchase" });
    expect(lines).toContain("private-payer: tls mode: mpc");
  });
});
