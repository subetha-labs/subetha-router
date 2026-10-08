/**
 * MPP Solana の **process の中断**（`docs/mpp-solana-tasks.md` M5、要件 AC-20・AC-21、設計 §8.2 の「中断」）。**無課金・Linux で受け入れ**。
 *
 * Router を**子 process**で起動し（`tests/fixtures/router-svm-process.ts`）、停止点で子が自分に SIGKILL する（core の catch も終端の追記も通らない）:
 * - 受信（MPP Solana、`transaction` 型）: `inboundBeforeSend`（送出の前）→ 再起動で `unknown`（送出 0）、`inboundAfterSend`（送出の後・行の前）→ `unknown`（送出 1。
 *   chain 上の署名はそのまま）、`inboundBeforeSettled`（settled を返す直前 = 行の前）→ `unknown`、行の後（`source_settled` の後、送信の前）→ `paid_undelivered`
 * - 受信（`signature` 型）: `inboundBeforeSettled`（行の前）→ `unknown`、行の後 → `paid_undelivered`
 * - 送信（MPP Solana、pull）: `afterReserve`／`afterSign`／`beforeSend` → `unknown`（signer 0／1／1、支払い要求 0）。同じ message を別の paymentId で → `collision`
 * - すべての停止点で: 再起動の後に signer の回数・`sendTransaction`／有料要求の回数が増えない、同じ intent の再提示は現在の終端を返す
 *
 * 親が fixture（Base の facilitator、x402 Solana の facilitator と Provider、Provider D = pay-kit の server、Solana RPC = Router の口と pay-kit の口）を持つ。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { address, generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import type { QuoteView } from "../../src/client/types.js";
import type { InboundOffer } from "../../src/ports/inbound.js";
import { createRealSvmCapability } from "../../tools/real-svm-capability.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { createMppSolanaTestPayer, type MppSolanaTestPayer } from "../fixtures/mpp-solana-payer.js";
import { startMppSolanaUpstream, type MppSolanaUpstream } from "../fixtures/mpp-solana-upstream.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator, type SvmFacilitator } from "../fixtures/svm-facilitator.js";
import { startSvmUpstream, type SvmUpstream } from "../fixtures/svm-upstream.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

vi.setConfig({ testTimeout: 120_000 });

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const BASE = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const HOSTS = { legacy: "facilitator.other.test", svm: "static.provider.test", solRpc: "rpc.provider.test", solProvider: "sol.provider.test", solMppProvider: "solmpp.provider.test" } as const;
/** 受信 MPP Solana → 送信 x402 Solana（動的 I-4）と、受信 x402 Base → 送信 MPP Solana（静的 O-7）。 */
const PROFILE_IN = "dyn-solmpp-to-sol";
const ROUTE_OUT = "base-solmpp";
const SOL_URL = `https://${HOSTS.solProvider}/v1/price?symbol=ETH`;

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function ataOf(owner: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

interface World {
  readonly dir: string;
  readonly journalPath: string;
  readonly signLog: string;
  readonly env: Record<string, string>;
  readonly legacy: VerifyingFacilitator;
  readonly svm: SvmFacilitator;
  readonly rpc: SolanaRpcFixture;
  readonly payKitRpc: SolanaRpcFixture;
  readonly solProvider: SvmUpstream;
  readonly providerD: MppSolanaUpstream;
  readonly payer: MppSolanaTestPayer;
  readonly receiver: string;
  readonly routerAddress: string;
  child: Listening | undefined;
}

async function world(): Promise<World> {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "m5-process-"));
  closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const seed = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const routerAddress = createRealSvmCapability(seed).address;
  const receiver = String((await generateKeyPairSigner()).address);
  const solProviderOwner = createRealSvmCapability(getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)))).address;
  const providerDOwner = String((await generateKeyPairSigner()).address);
  const legacy = await startVerifyingFacilitator({ tls: TLS });
  closers.push(legacy.close);
  const svm = await startSvmFacilitator(TLS, SOL, undefined, HOSTS.svm);
  closers.push(svm.close);
  const rpc = await startSolanaRpc({
    mint: MINT,
    decimals: 6,
    tls: TLS,
    atas: [
      { address: await ataOf(routerAddress), owner: routerAddress, amount: "1000000" },
      { address: await ataOf(receiver), owner: receiver },
      { address: await ataOf(solProviderOwner), owner: solProviderOwner },
      { address: await ataOf(providerDOwner), owner: providerDOwner },
    ],
  });
  closers.push(rpc.close);
  rpc.state.signatureStatuses = ["confirmed"];
  const payKitRpc = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: rpc });
  closers.push(payKitRpc.close);
  const solProvider = await startSvmUpstream(TLS, { port: svm.port, host: HOSTS.svm, feePayer: svm.feePayer }, { payTo: solProviderOwner }, HOSTS.solProvider);
  closers.push(solProvider.close);
  solProvider.state.memoMode = "fixed";
  solProvider.state.memo = "invoice-m5";
  const providerD = await startMppSolanaUpstream({ rpcUrl: payKitRpc.url, feePayer: true, recipient: providerDOwner, tls: TLS, externalId: "order-m5" });
  closers.push(providerD.close);
  const payer = await createMppSolanaTestPayer({ rpcUrl: payKitRpc.url });
  closers.push(payer.close);

  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: {
        [ROUTE_OUT]: {
          routeId: ROUTE_OUT,
          canonicalPath: `/v1/routes/${ROUTE_OUT}/resource`,
          rail: "mpp",
          sourceRail: "x402",
          source: { amount: "10000", asset: USDC, decimals: 6, network: BASE, payTo: BASE_RECEIVER },
          destination: { scheme: "solana/charge", network: SOL, asset: MINT, payTo: providerDOwner },
        },
      },
      budget: { maxPurchases: 50, buckets: [{ network: BASE, asset: USDC, maxTotal: "1000000", maxPerPurchase: "20000" }, { network: SOL, asset: MINT, maxTotal: "1000000", maxPerPurchase: "20000" }] },
      dynamic: {
        enabled: true,
        profiles: {
          [PROFILE_IN]: { profileId: PROFILE_IN, sourceRail: "mpp", source: { network: SOL, asset: MINT, decimals: 6, payTo: receiver }, rail: "x402", destination: { scheme: "exact", network: SOL, asset: MINT, decimals: 6, tokenProgram: String(TOKEN_PROGRAM_ADDRESS) }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } },
        },
        budget: { maxPurchases: 50, buckets: [{ network: BASE, asset: USDC, maxTotal: "1000000", maxPerPurchase: "40000" }, { network: SOL, asset: MINT, maxTotal: "1000000", maxPerPurchase: "40000" }] },
        denyHosts: [],
      },
    },
    x402: { upstreams: { [ROUTE_OUT]: `https://${HOSTS.solMppProvider}/v1/static` }, inboundFacilitators: { [SOL]: { kind: "x402", url: `https://${HOSTS.svm}` } } },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const journalPath = path.join(dir, "journal.ndjson");
  const signLog = path.join(dir, "signs.ndjson");
  writeFileSync(signLog, "");
  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "https://other.test",
    ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${HOSTS.legacy}`,
    ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-m5-process",
    ROUTER_SOLANA_RPC_URL: `https://${HOSTS.solRpc}`,
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: journalPath,
    ROUTER_HTTP_HOST: "127.0.0.1",
    ROUTER_HTTP_PORT: "0",
    SUBETHA_TEST_DIAL_MAP: JSON.stringify({ [HOSTS.legacy]: legacy.port, [HOSTS.svm]: svm.port, [HOSTS.solRpc]: rpc.port, [HOSTS.solProvider]: solProvider.port, [HOSTS.solMppProvider]: providerD.port }),
    SUBETHA_TEST_CA_PATH: path.join(TLS.dir, "ca.pem"),
    SUBETHA_TEST_SVM_SEED: seed,
    SUBETHA_TEST_SIGN_LOG: signLog,
  };
  return { dir, journalPath, signLog, env, legacy, svm, rpc, payKitRpc, solProvider, providerD, payer, receiver, routerAddress, child: undefined };
}

/** 子の closer（識別子で外せるように持つ。`stop` した子の closer だけを外し、他の fixture の closer は残す）。 */
const childClosers = new Map<Listening, () => Promise<void>>();
async function boot(w: World, stopAt?: string): Promise<Listening> {
  const child = await startListening("tests/fixtures/router-svm-process.ts", [], { ...w.env, ...(stopAt === undefined ? {} : { SUBETHA_TEST_SVM_STOP_AT: stopAt }) }, { listenTimeoutMs: 40_000 });
  w.child = child;
  const closer = async (): Promise<void> => {
    await child.stop();
  };
  childClosers.set(child, closer);
  closers.push(closer);
  return child;
}

/** 子を止め、その closer だけを外す（他の closer には触れない）。 */
async function stopChild(child: Listening): Promise<void> {
  await child.stop();
  const closer = childClosers.get(child);
  const at = closer === undefined ? -1 : closers.indexOf(closer);
  if (at !== -1) closers.splice(at, 1);
}

function client(child: Listening) {
  return createRouterClient({ baseUrl: child.baseUrl, principalId: "judge", token: "public", allowUnissuedQuotes: true, source: "judge" });
}

async function inboundQuote(child: Listening, requestId: string): Promise<QuoteView> {
  const result = await client(child).quoteUrl({ profileId: PROFILE_IN, url: SOL_URL, requestId });
  if (!result.ok) throw new Error(`quote failed: ${result.error}`);
  return result.quote;
}

async function outboundQuote(child: Listening, requestId: string): Promise<QuoteView> {
  const result = await client(child).quote({ routeId: ROUTE_OUT, requestId });
  if (!result.ok) throw new Error(`quote failed: ${result.error}`);
  return result.quote;
}

function encode(envelope: unknown): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** 受信 MPP Solana の credential（pay-kit の client。`transaction` 型 = Router が送出 / `signature` 型 = payer が送出済み）。 */
async function solMppCredential(w: World, quote: QuoteView, mode: "transaction" | "signature"): Promise<string> {
  const credential = await w.payer.credentialFor(quote.source.offer as unknown as InboundOffer, mode);
  return encode(credential);
}

async function baseCredential(quote: QuoteView): Promise<string> {
  return createX402Payer(generatePrivateKey()).credentialFor(quote.source.offer as never, 84532);
}

function execute(child: Listening, quote: QuoteView, requestId: string, credential: string) {
  return client(child).execute({ quote, requestId, approval: { approved: true, quoteId: quote.quoteId }, credential });
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

/** Router の送出（pay-kit の client の fixture の送出は `signature` 型のときだけ、quote の後・purchase の前に 1 回）。 */
function routerSends(w: World, payerSends: number): number {
  return w.rpc.state.sent.length - payerSends;
}

describe("受信（MPP Solana）の停止点で SIGKILL → 再起動で unknown（interrupted_at_restart）。送出は増えない。再提示は終端を返す", () => {
  for (const [stopAt, mode, sendsBeforeKill] of [["inboundBeforeSend", "transaction", 0], ["inboundAfterSend", "transaction", 1], ["inboundBeforeSettled", "transaction", 1], ["inboundBeforeSettled", "signature", 0]] as const) {
    test(`${stopAt}（${mode} 型）: 停止前の Router の送出 ${sendsBeforeKill}、再起動後も同じ、署名 0・支払い要求 0`, async () => {
      const w = await world();
      const first = await boot(w, stopAt);
      const quote = await inboundQuote(first, "k1");
      const credential = await solMppCredential(w, quote, mode);
      const payerSends = mode === "signature" ? 1 : 0;
      expect(w.rpc.state.sent).toHaveLength(payerSends);
      const inflight = execute(first, quote, "k1", credential);
      await waitFor(() => signLines(w).stops.includes(stopAt), "the stop point");
      await first.kill("SIGKILL");
      expect((await inflight).outcome).toBe("unknown");
      // 停止前: 受信の行は `source_pending`（と動的の `created`）まで。終端は無い。
      const before = journalEvents(w, quote.paymentId);
      expect(before).toContain("source_pending");
      expect(before).not.toContain("source_settled");
      expect(before.some((e) => ["delivered", "dest_failed", "unknown", "paid_undelivered"].includes(e))).toBe(false);
      expect(routerSends(w, payerSends)).toBe(sendsBeforeKill);
      expect(signLines(w).signs).toBe(0);
      expect(w.solProvider.seen.paid).toHaveLength(0);
      expect(w.svm.seen.verifyCalls).toBe(0);

      const second = await boot(w);
      const status = await client(second).status(quote.paymentId, quote.ownerKey);
      expect(status).toMatchObject({ found: true, projection: { status: "unknown", terminalReason: "interrupted_at_restart" } });
      expect(journalEvents(w, quote.paymentId).at(-1)).toBe("unknown");
      // 再提示: 現在の終端を返し、送出も署名も増えない。
      const again = await execute(second, quote, "k1", credential);
      expect(again).toMatchObject({ outcome: "unknown", reason: "interrupted_at_restart" });
      expect(routerSends(w, payerSends)).toBe(sendsBeforeKill);
      expect(signLines(w).signs).toBe(0);
      expect(w.solProvider.seen.paid).toHaveLength(0);
      // 送出の後に止まった取引は chain（fixture）に残っている（Router は再送しない）。
      if (sendsBeforeKill === 1) expect(w.rpc.state.transactions.size).toBe(1);
    });
  }

  for (const mode of ["transaction", "signature"] as const) {
    test(`行の後（source_settled の後、送信の 402 の読み直しの最中）に親から SIGKILL（${mode} 型）→ 再起動で paid_undelivered。送信は始まらない（署名 0・支払い要求 0）`, async () => {
      const w = await world();
      const first = await boot(w);
      const quote = await inboundQuote(first, "s1");
      const credential = await solMppCredential(w, quote, mode);
      const payerSends = mode === "signature" ? 1 : 0;
      // 402 の読取は quote（1）・purchase の受信前（2）・deliver の読み直し（3）。3 回目だけ Provider で止める。
      w.solProvider.state.challengeDelayMs = 20_000;
      w.solProvider.state.challengeDelayAfter = 2;
      const inflight = execute(first, quote, "s1", credential);
      await waitFor(() => journalEvents(w, quote.paymentId).includes("source_settled") && w.solProvider.seen.challenges >= 3, "source_settled and the post-settlement challenge read");
      expect(journalEvents(w, quote.paymentId)).not.toContain("destination_pending");
      await first.kill("SIGKILL");
      expect((await inflight).outcome).toBe("unknown");
      w.solProvider.state.challengeDelayMs = 0;
      expect(routerSends(w, payerSends)).toBe(mode === "transaction" ? 1 : 0);
      expect(signLines(w).signs).toBe(0);
      expect(w.solProvider.seen.paid).toHaveLength(0);

      const second = await boot(w);
      expect(await client(second).status(quote.paymentId, quote.ownerKey)).toMatchObject({ found: true, projection: { status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" } });
      const events = journalEvents(w, quote.paymentId);
      expect(events).toContain("source_settled");
      expect(events.at(-1)).toBe("paid_undelivered");
      const again = await execute(second, quote, "s1", credential);
      expect(again).toMatchObject({ outcome: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
      expect(routerSends(w, payerSends)).toBe(mode === "transaction" ? 1 : 0);
      expect(signLines(w).signs).toBe(0);
      expect(w.solProvider.seen.paid).toHaveLength(0);
      // 消費済みの署名: 同じ credential を別の quote に付けると preflight で止まる（動的の core は payment_required = 昇格しない）。settle を直接呼ぶ unit は `mpp-solana-inbound.test.ts`。
      const next = await inboundQuote(second, "s2");
      const reused = await execute(second, next, "s2", credential);
      expect(reused.outcome).toBe("payment_required");
      expect(routerSends(w, payerSends)).toBe(mode === "transaction" ? 1 : 0);
    });
  }
});

describe("送信（MPP Solana、pull）の停止点で SIGKILL → 予約の行は残り、再起動で unknown。署名 0／1、支払い要求 0。同じ message は collision", () => {
  for (const [stopAt, signsBeforeKill] of [["afterReserve", 0], ["afterSign", 1], ["beforeSend", 1]] as const) {
    test(`${stopAt}: 停止前の署名 ${signsBeforeKill} 回、再起動後も同じ`, async () => {
      const w = await world();
      const first = await boot(w, stopAt);
      const quote = await outboundQuote(first, "o1");
      const credential = await baseCredential(quote);
      const inflight = execute(first, quote, "o1", credential);
      await waitFor(() => signLines(w).stops.includes(stopAt), "the stop point");
      await first.kill("SIGKILL");
      expect((await inflight).outcome).toBe("unknown");
      const before = journalEvents(w, quote.paymentId);
      expect(before).toContain("destination_message_reserved");
      expect(before.some((e) => ["delivered", "dest_failed", "unknown", "paid_undelivered"].includes(e))).toBe(false);
      expect(signLines(w).signs).toBe(signsBeforeKill);
      expect(w.providerD.seen.payCalls).toBe(0);
      expect(w.rpc.state.sent).toHaveLength(0);
      expect(w.legacy.calls).toMatchObject({ verify: 1, settle: 1 });

      const second = await boot(w);
      expect(await client(second).status(quote.paymentId)).toMatchObject({ found: true, projection: { status: "unknown", terminalReason: "interrupted_at_restart" } });
      expect(journalEvents(w, quote.paymentId).at(-1)).toBe("unknown");
      const again = await execute(second, quote, "o1", credential);
      expect(again).toMatchObject({ outcome: "unknown", reason: "interrupted_at_restart" });
      expect(signLines(w).signs).toBe(signsBeforeKill);
      expect(w.providerD.seen.payCalls).toBe(0);
      expect(w.legacy.calls).toMatchObject({ settle: 1 });

      // 別の paymentId で同じ message（Provider D の externalId は固定、額は固定、fixture の blockhash は固定）→ 予約の衝突。署名は増えない。
      const next = await outboundQuote(second, "o2");
      const nextResult = await execute(second, next, "o2", await baseCredential(next));
      expect(nextResult.outcome).toBe("paid_data_unavailable");
      expect(readFileSync(w.journalPath, "utf8")).toContain("destination_message_collision");
      expect(signLines(w).signs).toBe(signsBeforeKill);
      expect(w.providerD.seen.payCalls).toBe(0);
      // 衝突しない message（Provider D が別の externalId を出す）は届く: 予約が止めているのであって、adapter が壊れているのではない。
      const other = await startMppSolanaUpstream({ rpcUrl: w.payKitRpc.url, feePayer: true, recipient: w.providerD.recipient, tls: TLS, externalId: "order-m5-2" });
      closers.push(other.close);
      await stopChild(second);
      w.env["SUBETHA_TEST_DIAL_MAP"] = JSON.stringify({ ...(JSON.parse(w.env["SUBETHA_TEST_DIAL_MAP"]!) as Record<string, number>), [HOSTS.solMppProvider]: other.port });
      const third = await boot(w);
      const fresh = await outboundQuote(third, "o3");
      const freshResult = await execute(third, fresh, "o3", await baseCredential(fresh));
      expect(freshResult.outcome, JSON.stringify(freshResult)).toBe("delivered");
      expect(signLines(w).signs).toBe(signsBeforeKill + 1);
      expect(other.seen.payCalls).toBe(1);
      expect(w.rpc.state.sent).toHaveLength(1); // pay-kit の server の送出（共同署名）だけ
    });
  }

  test("起動の順序（fixture の起動側）: listen の前に受信・送信の startup の検査（ATA の読み）が走り、最初の要求の前に RPC に届いている", async () => {
    const w = await world();
    const child = await boot(w);
    // listen までに読まれている ATA: 受信（dyn-solmpp-to-sol）の受取 ATA 1 回、送信（base-solmpp）の静的の宛先 ATA 1 回（Router の ATA は導出だけで読まない）。
    const startupReads = w.rpc.calls.filter((c) => c.method === "getAccountInfo");
    expect(startupReads).toHaveLength(2);
    expect(new Set(startupReads.map((c) => (c.params as unknown[])[0]))).toEqual(new Set([await ataOf(w.receiver), await ataOf(w.providerD.recipient)]));
    const quote = await outboundQuote(child, "q1");
    expect(quote.destination).toMatchObject({ network: SOL, asset: MINT });
  });
});
