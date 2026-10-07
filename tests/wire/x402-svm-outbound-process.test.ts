/**
 * SVM 送信の **process の中断**（送信の設計 §7.2「中断」、AC-10。タスク U8-b）。
 *
 * Router を**子 process**で起動し（`tests/fixtures/router-rails-process.ts`）、SVM の送信の停止点 `afterReserve`／`afterSign`／`beforeSend` で
 * 子が自分に SIGKILL する（core の catch も終端の追記も通らない）。親が fixture（Base の facilitator・SVM の facilitator・Solana RPC・Provider）を持ち、
 * journal・署名の記録 file・Provider の `seen.paid` で観測する:
 * - 停止前: journal に `destination_message_reserved`、intent は終端でない。署名の回数は停止点で決まる（afterReserve 0、afterSign・beforeSend 1）。支払い要求 0
 * - 同じ journal で再起動 → `unknown`（`interrupted_at_restart`）。再起動後の署名 0・支払い要求 0
 * - 別の paymentId で同じ message（固定 Memo・固定 blockhash）→ `collision`（署名 0）
 * - `dropAfterSettle` → `unknown`。再起動後の再提出でも再送信 0
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { getBase58Decoder } from "@solana/kit";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import type { QuoteView } from "../../src/client/types.js";
import { createRealSvmCapability } from "../../tools/real-svm-capability.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator, type SvmFacilitator } from "../fixtures/svm-facilitator.js";
import { ataOf, MINT, SOL } from "../fixtures/svm-outbound-harness.js";
import { startSvmUpstream, type SvmUpstream } from "../fixtures/svm-upstream.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

vi.setConfig({ testTimeout: 90_000 });

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const BASE = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const HOSTS = { legacy: "facilitator.other.test", svm: "static.provider.test", solRpc: "rpc.provider.test", provider: "sol.provider.test" } as const;
const ROUTE = "sol";

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

interface World {
  readonly dir: string;
  readonly journalPath: string;
  readonly signLog: string;
  readonly env: Record<string, string>;
  readonly legacy: VerifyingFacilitator;
  readonly svm: SvmFacilitator;
  readonly rpc: SolanaRpcFixture;
  readonly provider: SvmUpstream;
  readonly routerAddress: string;
  child: Listening | undefined;
}

async function world(): Promise<World> {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "u8b-process-"));
  closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const seed = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const routerAddress = createRealSvmCapability(seed).address;
  const provider = createRealSvmCapability(getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)))).address;
  const legacy = await startVerifyingFacilitator({ tls: TLS });
  closers.push(legacy.close);
  const svm = await startSvmFacilitator(TLS, SOL, undefined, HOSTS.svm);
  closers.push(svm.close);
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, atas: [{ address: await ataOf(routerAddress), owner: routerAddress, amount: "1000000" }, { address: await ataOf(provider), owner: provider }] });
  closers.push(rpc.close);
  const providerUpstream = await startSvmUpstream(TLS, { port: svm.port, host: HOSTS.svm, feePayer: svm.feePayer }, { payTo: provider }, HOSTS.provider);
  closers.push(providerUpstream.close);
  // 固定 Memo: 同じ blockhash（fixture）と同じ額なので、別の購入でも**同じ message**になる（衝突の試験）。
  providerUpstream.state.memoMode = "fixed";
  providerUpstream.state.memo = "invoice-u8b";

  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: {
        [ROUTE]: {
          routeId: ROUTE,
          canonicalPath: `/v1/routes/${ROUTE}/resource`,
          rail: "x402",
          sourceRail: "x402",
          source: { amount: "10000", asset: USDC, decimals: 6, network: BASE, payTo: BASE_RECEIVER },
          destination: { scheme: "exact", network: SOL, asset: MINT, payTo: provider },
        },
      },
      budget: { maxPurchases: 50, buckets: [{ network: BASE, asset: USDC, maxTotal: "1000000", maxPerPurchase: "20000" }, { network: SOL, asset: MINT, maxTotal: "1000000", maxPerPurchase: "20000" }] },
    },
    x402: { upstreams: { [ROUTE]: `https://${HOSTS.provider}/v1/static` } },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const journalPath = path.join(dir, "journal.ndjson");
  const signLog = path.join(dir, "signs.ndjson");
  writeFileSync(signLog, "");
  const caPath = path.join(TLS.dir, "ca.pem");
  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "https://other.test",
    ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${HOSTS.legacy}`,
    ROUTER_SOLANA_RPC_URL: `https://${HOSTS.solRpc}`,
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: journalPath,
    ROUTER_HTTP_HOST: "127.0.0.1",
    ROUTER_HTTP_PORT: "0",
    SUBETHA_TEST_DIAL_MAP: JSON.stringify({ [HOSTS.legacy]: legacy.port, [HOSTS.svm]: svm.port, [HOSTS.solRpc]: rpc.port, [HOSTS.provider]: providerUpstream.port }),
    SUBETHA_TEST_CA_PATH: caPath,
    SUBETHA_TEST_SVM_SEED: seed,
    SUBETHA_TEST_SIGN_LOG: signLog,
  };
  return { dir, journalPath, signLog, env, legacy, svm, rpc, provider: providerUpstream, routerAddress, child: undefined };
}

async function boot(w: World, stopAt?: string): Promise<Listening> {
  const child = await startListening("tests/fixtures/router-rails-process.ts", [], { ...w.env, ...(stopAt === undefined ? {} : { SUBETHA_TEST_SVM_STOP_AT: stopAt }) }, { listenTimeoutMs: 40_000 });
  w.child = child;
  closers.push(async () => {
    await child.stop();
  });
  return child;
}

function client(child: Listening) {
  return createRouterClient({ baseUrl: child.baseUrl, principalId: "judge", token: "public", allowUnissuedQuotes: true, source: "judge" });
}

async function quoteOf(child: Listening, requestId: string): Promise<QuoteView> {
  const result = await client(child).quote({ routeId: ROUTE, requestId });
  if (!result.ok) throw new Error(`quote failed: ${result.error}`);
  return result.quote;
}

async function credentialOf(quote: QuoteView): Promise<string> {
  return createX402Payer(generatePrivateKey()).credentialFor(quote.source.offer as never, 84532);
}

function signLines(w: World): { signs: number; stops: string[] } {
  const rows = readFileSync(w.signLog, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { bytes?: number; stop?: string });
  return { signs: rows.filter((r) => r.bytes !== undefined).length, stops: rows.flatMap((r) => (r.stop === undefined ? [] : [r.stop])) };
}

function journalEvents(w: World, paymentId: string): string[] {
  return readFileSync(w.journalPath, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { event: string; paymentId?: string })
    .filter((r) => r.paymentId === paymentId)
    .map((r) => r.event);
}

async function waitFor(condition: () => boolean, label: string, ms = 30_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("停止点で SIGKILL → 予約の行は残り、再起動で unknown（interrupted_at_restart）。署名 0・支払い 0。同じ message は collision", () => {
  for (const [stopAt, signsBeforeKill] of [["afterReserve", 0], ["afterSign", 1], ["beforeSend", 1]] as const) {
    test(`${stopAt}: 停止前の署名 ${signsBeforeKill} 回、再起動後 0 回`, async () => {
      const w = await world();
      const first = await boot(w, stopAt);
      const quote = await quoteOf(first, "k1");
      const credential = await credentialOf(quote);
      // 購入を投げる。子は停止点で自分を SIGKILL するので、応答は来ない（client は transport_uncertain）。
      const inflight = client(first).execute({ quote, requestId: "k1", approval: { approved: true, quoteId: quote.quoteId }, credential });
      await waitFor(() => signLines(w).stops.includes(stopAt), "the stop point");
      await first.kill("SIGKILL"); // 既に死んでいれば何もしない（close を待つだけ）
      const result = await inflight;
      expect(result.outcome).toBe("unknown");
      // 停止前の観測: 予約の行、終端でない intent、署名の回数、支払い要求 0。
      const before = journalEvents(w, quote.paymentId);
      expect(before).toContain("destination_message_reserved");
      expect(before.some((e) => ["delivered", "dest_failed", "unknown", "paid_undelivered"].includes(e))).toBe(false);
      expect(signLines(w).signs).toBe(signsBeforeKill);
      expect(w.provider.seen.paid).toHaveLength(0);
      expect(w.svm.seen.verifyCalls).toBe(0);
      // 受信は settle 済み（Base の facilitator）。
      expect(w.legacy.calls).toMatchObject({ verify: 1, settle: 1 });

      // 同じ journal で再起動（停止点なし）。
      const second = await boot(w);
      const status = await client(second).status(quote.paymentId);
      expect(status).toMatchObject({ found: true, projection: { status: "unknown", terminalReason: "interrupted_at_restart" } });
      expect(journalEvents(w, quote.paymentId).at(-1)).toBe("unknown");
      expect(signLines(w).signs).toBe(signsBeforeKill);
      expect(w.provider.seen.paid).toHaveLength(0);
      // 再提出しても送信は起きない。
      const again = await client(second).execute({ quote, requestId: "k1", approval: { approved: true, quoteId: quote.quoteId }, credential });
      expect(again).toMatchObject({ outcome: "unknown", reason: "interrupted_at_restart" });
      expect(signLines(w).signs).toBe(signsBeforeKill);
      expect(w.provider.seen.paid).toHaveLength(0);
      expect(w.legacy.calls).toMatchObject({ settle: 1 });

      // 別の paymentId で同じ message（固定 Memo・fixture の固定 blockhash・同じ額）→ 予約の衝突。署名は増えない。
      const next = await quoteOf(second, "k2");
      const nextResult = await client(second).execute({ quote: next, requestId: "k2", approval: { approved: true, quoteId: next.quoteId }, credential: await credentialOf(next) });
      expect(nextResult.outcome).toBe("paid_data_unavailable");
      expect(readFileSync(w.journalPath, "utf8")).toContain("destination_message_collision");
      expect(signLines(w).signs).toBe(signsBeforeKill);
      expect(w.provider.seen.paid).toHaveLength(0);
      // 衝突しない message（別の Memo）は届く: 予約の仕組みが購入を止めているのであって、adapter が壊れているのではない。
      w.provider.state.memo = "invoice-u8b-2";
      const fresh = await quoteOf(second, "k3");
      const freshResult = await client(second).execute({ quote: fresh, requestId: "k3", approval: { approved: true, quoteId: fresh.quoteId }, credential: await credentialOf(fresh) });
      expect(freshResult.outcome).toBe("delivered");
      expect(signLines(w).signs).toBe(signsBeforeKill + 1);
      expect(w.provider.seen.paid).toHaveLength(1);
    });
  }

  test("dropAfterSettle: facilitator の settle の後に Provider が切る → unknown。再起動後の再提出でも再送信 0", async () => {
    const w = await world();
    w.provider.state.payMode = "drop-after-settle";
    const first = await boot(w);
    const quote = await quoteOf(first, "d1");
    const credential = await credentialOf(quote);
    const result = await client(first).execute({ quote, requestId: "d1", approval: { approved: true, quoteId: quote.quoteId }, credential });
    expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(w.provider.seen.paid).toHaveLength(1);
    expect(w.svm.seen.settleCalls).toBe(1);
    expect(signLines(w).signs).toBe(1);
    await first.stop();
    closers.splice(closers.length - 1, 1);
    const second = await boot(w);
    expect(await client(second).status(quote.paymentId)).toMatchObject({ found: true, projection: { status: "unknown" } });
    const again = await client(second).execute({ quote, requestId: "d1", approval: { approved: true, quoteId: quote.quoteId }, credential });
    expect(again.outcome).toBe("unknown");
    expect(w.provider.seen.paid).toHaveLength(1);
    expect(signLines(w).signs).toBe(1);
    expect(w.svm.seen.settleCalls).toBe(1);
  });
});
