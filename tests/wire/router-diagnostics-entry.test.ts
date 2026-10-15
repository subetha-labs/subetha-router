/**
 * AC-R4（wire、`docs/rejection-reasons-design.md` §2.1・§8.3、タスク R-2）: 本番と同じ入口の計画（受け入れの形: `acceptanceOptionsOf` → `startHost` → `hostPlanOf`）で、
 * Router の子の env に入口が足した `SUBETHA_DIAGNOSTICS_PATH`（`<受け入れの journal のディレクトリ>/diagnostics/router.ndjson`）に、失敗した購入の行が 0600 で出る。
 * MCP の `status` と、入口を止めて同じ journal で起動し直した後の `status`（reopen）の応答は、sink の有無（`SUBETHA_DIAGNOSTICS=off`）で byte 一致し、
 * 診断の鍵・表の版の文字列を含まない。`off` の起動はファイルに 1 行も足さない。
 *
 * 入口は `tests/fixtures/diag-host.ts`（受け入れ用の起動と同じ関数）。Router の子は `tests/fixtures/router-diag-child.ts`（本番の子と同じ sink の作り方、rail だけ合成:
 * 本番の子は起動時に外の RPC を読むので接続の無い試験では listen しない）。facilitator・上流は loopback の合成 fixture（無課金・無署名）。鍵は乱数、外へは接続しない。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { DIAG_RECORD_KEYS, quoteHashOf, validateDiagRecord } from "../../src/shared/diagnostics.js";
import { REASON_TABLE_VERSION } from "../../src/shared/payment-reasons.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { DEST_ASSET, DEST_NETWORK, DEST_PAY_TO, paymentHeader, SOURCE_CHAIN_ID, SOURCE_NETWORK, SOURCE_TOKEN } from "../fixtures/router-harness.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const ROUTE = "md-diag-wire";
const HOST = "tests/fixtures/diag-host.ts";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
let createdBefore: Set<string>;
const markers: string[] = [];
beforeAll(() => {
  mkdirSync(runtimeRoot, { recursive: true });
  createdBefore = new Set(readdirSync(runtimeRoot).filter((name) => name.startsWith("remote-")));
});
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});
afterAll(() => {
  // 入口の作業領域（`runtime/remote-*`）のうち、この試験の受取先（乱数）を設定に持つものだけを消す。
  for (const name of readdirSync(runtimeRoot).filter((entry) => entry.startsWith("remote-") && !createdBefore.has(entry))) {
    let ours = false;
    try {
      const text = readFileSync(path.join(runtimeRoot, name, "router.config.json"), "utf8").toLowerCase();
      ours = markers.some((marker) => text.includes(marker.toLowerCase()));
    } catch {
      ours = false;
    }
    if (ours) rmSync(path.join(runtimeRoot, name), { recursive: true, force: true });
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function callTool(port: number, name: string, args: Record<string, unknown>): Promise<{ structured: Record<string, any>; text: string }> {
  const client = new Client({ name: "router-diagnostics-wire", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) as never);
  try {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as { structuredContent: Record<string, any>; content: Array<{ text: string }> };
    return { structured: result.structuredContent, text: result.content[0]!.text };
  } finally {
    await client.close();
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

function linesOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
}

test("受け入れの形の入口: 失敗した購入の行が journal の隣のファイル（0600）に出て、MCP の status・reopen は sink の有無で byte 一致し診断を含まない", async () => {
  const dir = mkdtempSync(path.join(runtimeRoot, "r2-diag-wire-"));
  dirs.push(dir);
  // 合成の facilitator（verify は常に isValid:false）と上流。
  const facilitator = await startListening("tests/fixtures/facilitator-server.ts", ["--token", SOURCE_TOKEN, "--chain-id", SOURCE_CHAIN_ID, "--settle", "ok", "--verify", "invalid"]);
  closers.push(() => facilitator.stop());
  const upstream = await startListening("tests/fixtures/upstream-server.ts", ["--pay", "ok"]);
  closers.push(() => upstream.stop());
  const syntheticConfig = path.join(dir, "synthetic.config.json");
  writeFileSync(
    syntheticConfig,
    JSON.stringify({
      router: {
        approvalTtlMs: 600_000,
        routes: {
          [ROUTE]: {
            routeId: ROUTE,
            canonicalPath: `/v1/routes/${ROUTE}/resource`,
            rail: "x402",
            source: { amount: "1500", asset: SOURCE_TOKEN, decimals: 6, network: SOURCE_NETWORK },
            destination: { scheme: "exact", network: DEST_NETWORK, asset: DEST_ASSET, payTo: DEST_PAY_TO },
          },
        },
        budget: { maxPurchases: 8, buckets: [{ network: SOURCE_NETWORK, asset: SOURCE_TOKEN, maxTotal: "100000", maxPerPurchase: "5000" }, { network: DEST_NETWORK, asset: DEST_ASSET, maxTotal: "100000", maxPerPurchase: "5000" }] },
      },
      synthetic: { facilitatorUrl: facilitator.baseUrl, upstreams: { [ROUTE]: `${upstream.baseUrl}/v1/eth/snapshot` } },
    }),
  );
  const receiver = privateKeyToAccount(generatePrivateKey()).address;
  markers.push(receiver);
  const acceptanceJournal = path.join(dir, "acceptance", "journal.ndjson");
  const diagnosticsFile = path.join(dir, "acceptance", "diagnostics", "router.ndjson");
  const baseEnv: Record<string, string> = {
    SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(),
    SUBETHA_ROUTER_RECEIVER: receiver,
    SUBETHA_ARC_RECEIVER_KEY: generatePrivateKey(),
    SUBETHA_JOURNAL_PATH: path.join(dir, "public", "journal.ndjson"),
    SUBETHA_ACCEPTANCE_JOURNAL_PATH: acceptanceJournal,
    SUBETHA_ACCEPTANCE_PORT: "0",
    SUBETHA_TEST_SYNTHETIC_CONFIG: syntheticConfig,
  };
  const startEntry = async (extra: Record<string, string> = {}): Promise<Listening> => {
    const host = await startListening(HOST, ["--rails", "arc-in"], { ...baseEnv, ...extra }, { listenTimeoutMs: 60_000 });
    closers.push(() => host.stop());
    return host;
  };

  // 1. sink あり（既定）: quote → 失敗する purchase → status。
  const first = await startEntry();
  const requestId = `r2-wire-${Date.now()}`;
  const quoted = await callTool(first.port, "subetha_router_quote", { routeId: ROUTE, requestId });
  const quote = quoted.structured["quote"] as Record<string, any>;
  expect(typeof quote["quoteId"]).toBe("string");
  const credential = paymentHeader(quote["source"]["offer"]);
  const purchased = await callTool(first.port, "subetha_router_purchase", { quoteId: quote["quoteId"], requestId, approval: quote["quoteId"], quote, credential });
  expect(purchased.structured).toMatchObject({ paymentId: quote["paymentId"] });
  expect(purchased.text).toMatch(/verify_failed/);
  const paymentId = quote["paymentId"] as string;
  const statusWith = await callTool(first.port, "subetha_router_status", { paymentId });
  expect(statusWith.structured["found"]).toBe(true);

  // 診断のファイル: 受け入れの journal の隣、0600（ディレクトリ 0700）、検査を通る行、この購入の source_verify の行。
  expect(await waitFor(() => linesOf(diagnosticsFile).some((line) => line.includes('"source_verify"')), 10_000)).toBe(true);
  expect(statSync(diagnosticsFile).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(diagnosticsFile)).mode & 0o777).toBe(0o700);
  const records = linesOf(diagnosticsFile).map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const record of records) expect(validateDiagRecord(record)).toBeDefined();
  const verify = records.find((record) => record["stage"] === "source_verify");
  expect(verify).toMatchObject({ component: "router", outcome: "invalid", code: "verify_failed", paymentId, quoteHash: quoteHashOf(quote["quoteId"] as string), routeId: ROUTE, promoted: true });
  // 生の quoteId・requestId・credential はファイルに無い。
  const fileText = readFileSync(diagnosticsFile, "utf8");
  expect(fileText).not.toContain((quote["quoteId"] as string).slice(2));
  expect(fileText).not.toContain(requestId);
  expect(fileText).not.toContain(credential);
  // 公開の journal には触れない（受け入れの起動）。
  expect(existsSync(path.join(dir, "public", "diagnostics"))).toBe(false);

  // 2. 止めて、同じ journal で `SUBETHA_DIAGNOSTICS=off` の入口（Router の子に path が渡らない）: reopen の status は byte 一致。ファイルは増えない。
  await first.stop();
  const linesBefore = linesOf(diagnosticsFile);
  const off = await startEntry({ SUBETHA_DIAGNOSTICS: "off" });
  const statusOff = await callTool(off.port, "subetha_router_status", { paymentId });
  // 診断の無い起動で同じ購入をもう一度 purchase（既存のライフサイクルの現在の状態を返すだけ）しても、ファイルは増えない。
  await callTool(off.port, "subetha_router_purchase", { quoteId: quote["quoteId"], requestId, approval: quote["quoteId"], quote, credential });
  await off.stop();
  expect(linesOf(diagnosticsFile)).toEqual(linesBefore);
  // 3. もう一度 sink ありで起動し直した reopen も同じ。
  const again = await startEntry();
  const statusAgain = await callTool(again.port, "subetha_router_status", { paymentId });
  await again.stop();

  expect(statusOff.text).toBe(statusWith.text);
  expect(statusAgain.text).toBe(statusWith.text);
  expect(statusOff.structured).toEqual(statusWith.structured);
  // status・purchase の応答に診断の鍵・表の版は出ない（公開の MCP からは読めない。SR-R5）。
  for (const text of [statusWith.text, purchased.text, statusOff.text]) {
    expect(text).not.toContain(REASON_TABLE_VERSION);
    for (const key of DIAG_RECORD_KEYS.filter((k) => !["paymentId", "attempt", "routeId", "network", "outcome", "code", "reason", "v", "at", "seq", "stage", "receipt"].includes(k))) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(text).not.toContain("source_verify");
    expect(text).not.toContain("router.ndjson");
  }
}, 180_000);
