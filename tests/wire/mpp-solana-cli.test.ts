/**
 * `npm run sign` の往復（`docs/mpp-solana-design.md` §7・§8.2、要件 FR-49、AC-19。タスク M6）: **道具（別プロセス）→ Router の受信（実 composition）→ `settled`**。
 *
 * - 道具は `tools/sign-payment.ts` を子プロセスで起動する（鍵は env の乱数。stdout の封筒を Router の purchase に渡す）
 * - 道具の RPC は **`getLatestBlockhash` の 1 回だけ**で、**`sendTransaction` は呼ばない**（道具の口と Router の口を別の fixture にして数える。state は共有）
 * - 拒否の各行は鍵を読まず・RPC を呼ばず・stderr に固定文
 * - 鍵は stdout・stderr・封筒に出ない
 */
import { mkdtemp } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { address, generateKeyPairSigner, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { generatePrivateKey } from "viem/accounts";
import { Credential } from "mppx";

import { MPP_SOLANA_SCHEME, mppSolanaPayloadOf } from "../../src/adapters/inbound/mpp-solana.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config.js";
import { createRouterCore, type QuoteOutcome, type RouterCore } from "../../src/core/orchestrator.js";
import { composeRails, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
import type { PaymentCredential } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayRequest, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { svmSignerFromKey } from "../../tools/svm-payer.js";
import { FIXTURE_PUBLIC_ADDRESS, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { runToExit } from "../fixtures/loopback.js";
import { signatureOfBase64, startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const BASE = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC_HOST = "rpc.provider.test";
const SECRET = "mpp-solana-cli-secret-0123456789abcdef0123456789abcdef";
const ROUTE_ID = "md-x402-eth-snapshot-solmpp";
const PROFILE_ID = "dyn-solmpp-to-x402";
const SEND_OPTIONS = { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 };
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

class StubOutbound implements OutboundRail {
  payCalls = 0;
  async readChallenge(_routeId: string, _target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
    return [{ scheme: "exact", network: BASE, asset: USDC, amount: "10000", payTo: "0x0000000000000000000000000000000000000a11", extra: { name: "USDC", version: "2" } }];
  }
  async pay(_request: PayRequest): Promise<PayResult> {
    this.payCalls += 1;
    return { outcome: "paid", body: { ok: true }, contentType: "application/json", txRef: `dst-tx-${this.payCalls}` };
  }
}

interface Booted {
  core: RouterCore;
  config: RuntimeConfig;
  /** Router の口（guarded transport 越し。起動時の ATA の検査・送出・追跡）。 */
  rpc: SolanaRpcFixture;
  /** 道具の口（state は Router の口と共有。道具の要求だけを数える）。 */
  toolRpc: SolanaRpcFixture;
  outbound: StubOutbound;
  owner: string;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function boot(): Promise<Booted> {
  const keypair = await generateKeyPairSigner();
  const owner = String(keypair.address);
  const ownerAta = String((await findAssociatedTokenPda({ mint: address(MINT), owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, ata: { address: ownerAta, owner } });
  closers.push(rpc.close);
  const toolRpc = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: rpc });
  closers.push(toolRpc.close);
  const dir = await mkdtemp(path.join(tmpdir(), "mpp-solana-cli-"));
  const dest = { scheme: "exact", network: BASE, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" };
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: {
        [ROUTE_ID]: { routeId: ROUTE_ID, canonicalPath: `/v1/routes/${ROUTE_ID}/resource`, rail: "x402", sourceRail: "mpp", source: { amount: "10000", asset: MINT, decimals: 6, network: SOL, payTo: owner }, destination: dest },
      },
      budget: { maxPurchases: 10, buckets: [{ network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }, { network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "10000" }] },
      dynamic: {
        enabled: true,
        profiles: {
          [PROFILE_ID]: { profileId: PROFILE_ID, sourceRail: "mpp", source: { network: SOL, asset: MINT, decimals: 6, payTo: owner }, rail: "x402", destination: { scheme: "exact", network: BASE, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } },
        },
        budget: { maxPurchases: 10, buckets: [{ network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }, { network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "20000" }] },
        denyHosts: [],
      },
    },
    x402: { upstreams: { [ROUTE_ID]: "https://upstream.test/v1/x" } },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
    ROUTER_X402_INBOUND_FACILITATOR_URL: "https://legacy.facilitator.test",
    ROUTER_MPP_INBOUND_SECRET: SECRET,
    ROUTER_SOLANA_RPC_URL: `http://${RPC_HOST}`,
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
  };
  const config = loadRuntimeConfig(env, (file) => readFileSync(file, "utf8"), { networks: TEST_NETWORKS });
  const hooks: DynamicTransportHooks = {
    interfaces: () => [],
    lookup: (_hostname, _options, callback) => callback(null, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]),
    dialForTest: (target) => {
      if (target.hostname !== RPC_HOST) throw new UnmappedFixtureHostError();
      return { host: "127.0.0.1", port: rpc.port };
    },
  };
  const capabilities: RouterCapabilities = { evmSigning: createRealEvmCapability(generatePrivateKey()).capability(BASE), knownNetworksForTest: TEST_NETWORKS, transportHooksForTest: hooks, dynamicTransportHooksForTest: hooks };
  const rails = composeRails(config, capabilities, () => {}, () => {});
  await rails.startup!();
  const outbound = new StubOutbound();
  const core = await createRouterCore({ journalPath: config.journalPath, config: config.router, inbound: rails.inbound, outbound, note: () => {}, dynamic: { ledgerDir: path.join(dir, "dynamic-quotes") }, onStoreLoaded: rails.bindConsumed });
  closers.push(() => core.close());
  return { core, config, rpc, toolRpc, outbound, owner };
}

type OkQuote = Extract<QuoteOutcome, { ok: true }>;

async function quoteOf(b: Booted, requestId: string, dynamic = false): Promise<OkQuote> {
  const outcome = dynamic
    ? await b.core.quote({ principalId: "judge", requestId, routeId: PROFILE_ID, upstream: { url: "https://provider.test/v1/price" }, source: "judge" })
    : await b.core.quote({ principalId: "judge", requestId, routeId: ROUTE_ID });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return outcome as OkQuote;
}

/** `subetha_router_quote` が返す `quote` の形（道具が読む欄だけ）。 */
function quoteDocumentOf(quote: OkQuote): Record<string, unknown> {
  return { quoteId: quote.quoteId, source: { offer: quote.source.offer } };
}

function newSeed(): string {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
}

async function sign(b: Booted, quote: Record<string, unknown>, seed: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // fixture は loopback: 道具の既定（拒む）を env で明示的に外す。
  const result = await runToExit("tools/sign-payment.ts", [JSON.stringify(quote)], { SOLANA_PAYER_PRIVATE_KEY: seed, SOLANA_RPC_URL: b.toolRpc.url, SOLANA_RPC_ALLOW_LOOPBACK: "1" });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

function envelopeOf(stdout: string): PaymentCredential {
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(Buffer.from(lines[0]!, "base64").toString("utf8")) as PaymentCredential;
}

function transactionOf(credential: PaymentCredential): { base64: string; bytes: Uint8Array } {
  const payload = mppSolanaPayloadOf(credential.payload["credential"] as string);
  if (payload === undefined || payload.type !== "transaction") throw new Error("not a transaction-type credential");
  const base64 = Buffer.from(payload.bytes).toString("base64");
  return { base64, bytes: payload.bytes };
}

describe("npm run sign → Router の MPP Solana 受信 → settled（AC-19）", () => {
  it("静的: 道具は getLatestBlockhash を 1 回だけ呼び、sendTransaction を呼ばず、全署名（fee payer = 自分）の transaction 型の wire を Router の封筒に入れて返す。Router の purchase で送出 1 回 → settled → delivered。stderr は開示だけで鍵は出ない", async () => {
    const b = await boot();
    const seed = newSeed();
    const payerAddress = String((await svmSignerFromKey(seed)).address);
    const quote = await quoteOf(b, "req-static");
    expect(quote.source.offer.scheme).toBe(MPP_SOLANA_SCHEME);
    const mark = b.rpc.calls.length;
    const signed = await sign(b, quoteDocumentOf(quote), seed);
    expect(signed.code, signed.stderr).toBe(0);
    // 道具の RPC: blockhash の 1 回だけ。送出していない。
    expect(b.toolRpc.calls).toEqual([{ method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }]);
    expect(b.rpc.calls.slice(mark)).toEqual([]);
    expect(b.rpc.state.sent).toEqual([]);
    // stderr: 開示の固定文と署名者。鍵は出ない。
    expect(signed.stderr).toContain("MPP Solana: signed only, nothing was sent. Funds move when the Router broadcasts at purchase. Call purchase right away (the blockhash expires in about a minute). You need devnet SOL for the fee.");
    expect(signed.stderr).toContain(`signed by ${payerAddress} on Solana (your key is never sent; the Router broadcasts)`);
    expect(signed.stderr).not.toContain("cannot be undone");
    expect(signed.stdout + signed.stderr).not.toContain(seed);
    // 封筒: x402Version・accepted = offer・payload.challengeNonce・credential = mppx の wire（transaction 型、challenge は offer のもの）。
    const credential = envelopeOf(signed.stdout);
    expect(credential).toMatchObject({ x402Version: 2, accepted: quote.source.offer, payload: { challengeNonce: quote.source.offer.extra.challengeNonce } });
    expect(JSON.stringify(credential)).not.toContain(seed);
    const wire = credential.payload["credential"] as string;
    expect(wire.startsWith("Payment ")).toBe(true);
    const decoded = Credential.deserialize(wire) as unknown as { challenge: { id: string; request: Record<string, unknown> } };
    expect(decoded.challenge.id).toBe(quote.source.offer.extra.challengeNonce);
    expect(decoded.challenge.request["externalId"]).toBe(quote.source.offer.extra["externalId"]);
    // transaction: 署名 1 つ、fee payer = 署名者 = payer、Memo = externalId。
    const { base64, bytes } = transactionOf(credential);
    const tx = getTransactionDecoder().decode(bytes);
    expect(Object.keys(tx.signatures)).toEqual([payerAddress]);
    expect(tx.signatures[payerAddress as never]).not.toBeNull();
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as { staticAccounts: readonly string[]; instructions: readonly { programAddressIndex: number; data?: Uint8Array }[] };
    expect(String(message.staticAccounts[0])).toBe(payerAddress);
    const memoIx = message.instructions.find((ix) => String(message.staticAccounts[ix.programAddressIndex]) === MEMO_PROGRAM);
    expect(memoIx).toBeDefined();
    expect(new TextDecoder().decode(memoIx!.data)).toBe(quote.source.offer.extra["externalId"]);
    // Router の purchase: verify（RPC 無し）→ settle（sendTransaction 1 回 + 追跡）→ 送信（stub）→ delivered。
    b.rpc.state.signatureStatuses = ["confirmed"];
    const purchase = await b.core.purchase({ principalId: "judge", requestId: "req-static", quoteId: quote.quoteId, approval: quote.quoteId, credential });
    expect(purchase.status, JSON.stringify(purchase)).toBe("delivered");
    expect(b.outbound.payCalls).toBe(1);
    const signature = signatureOfBase64(base64)!;
    expect(b.rpc.calls.slice(mark)).toEqual([
      { method: "sendTransaction", params: [base64, SEND_OPTIONS] },
      { method: "getSignatureStatuses", params: [[signature], { searchTransactionHistory: true }] },
    ]);
    expect(b.rpc.state.sent).toEqual([base64]);
    expect(b.core.status(quote.paymentId, "judge")?.source.txRef).toBe(signature);
    // 道具の口は purchase の後も blockhash の 1 回のまま。
    expect(b.toolRpc.calls).toHaveLength(1);
  }, 60_000);

  it("動的（dyn-solmpp-to-x402、上流 10,000 + 手数料 1,000 = 11,000）: 同じ道具で署名 → purchase → delivered。txRef は道具が組んだ transaction の署名", async () => {
    const b = await boot();
    const seed = newSeed();
    const quote = await quoteOf(b, "req-dynamic", true);
    expect(quote.source.offer.amount).toBe("11000");
    const signed = await sign(b, { ...quoteDocumentOf(quote), ownerKey: quote.ownerKey }, seed);
    expect(signed.code, signed.stderr).toBe(0);
    expect(b.toolRpc.calls.map((c) => c.method)).toEqual(["getLatestBlockhash"]);
    const credential = envelopeOf(signed.stdout);
    const { base64 } = transactionOf(credential);
    b.rpc.state.signatureStatuses = ["confirmed"];
    const purchase = await b.core.purchase({ principalId: "judge", requestId: "req-dynamic", quoteId: quote.quoteId, approval: quote.quoteId, credential, ownerKey: quote.ownerKey!, source: "judge" });
    expect(purchase.status, JSON.stringify(purchase)).toBe("delivered");
    expect(b.rpc.state.sent).toEqual([base64]);
    expect(b.core.status(quote.paymentId, "judge", quote.ownerKey)?.source.txRef).toBe(signatureOfBase64(base64));
    expect(b.toolRpc.calls).toHaveLength(1);
  }, 60_000);

  it("拒否の各行（道具の stderr の固定文。鍵を読まず RPC を呼ばない）: challenge の中身を変えた quote、失効した quote、scheme の書き換え、challenge の無い offer、上限超", async () => {
    const b = await boot();
    const quote = await quoteOf(b, "req-refuse");
    const offer = quote.source.offer;
    const rows: [string, Record<string, unknown>, RegExp][] = [
      ["offer の額と challenge の額が違う", { ...offer, amount: "9999" }, /Refusing to sign: the challenge amount differs from the offer/],
      ["offer の payTo と challenge の recipient が違う", { ...offer, payTo: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d" }, /Refusing to sign: the challenge recipient differs from the offer's payTo/],
      ["externalId が違う", { ...offer, extra: { ...offer.extra, externalId: "other" } }, /Refusing to sign: the challenge externalId differs from the offer/],
      ["失効", { ...offer, extra: { ...offer.extra, expiresAt: 1 } }, /Refusing to sign: the offer has expired/],
      ["challenge 無し", { ...offer, extra: { ...offer.extra, challenge: undefined } }, /Refusing to sign: the MPP Solana offer does not carry the mppx challenge/],
      ["上限超", { ...offer, amount: "20001" }, /Refusing to sign: the offer amount exceeds the cap/],
      ["scheme を exact に書き換えた（nonce の形が x402 の形でない）", { ...offer, scheme: "exact", extra: { ...offer.extra, feePayer: b.owner, memo: offer.extra.challengeNonce } }, /Refusing to sign: the offer has no well-formed challengeNonce/],
    ];
    for (const [name, patched, pattern] of rows) {
      // 壊れた鍵を渡す: 拒否は鍵を読む前なので、鍵の形の文ではなく拒否の文で止まる。
      const result = await runToExit("tools/sign-payment.ts", [JSON.stringify({ quoteId: quote.quoteId, source: { offer: patched } })], { SOLANA_PAYER_PRIVATE_KEY: "not-a-key", SOLANA_RPC_URL: b.toolRpc.url, SOLANA_RPC_ALLOW_LOOPBACK: "1" });
      expect(result.code, name).toBe(2);
      expect(result.stdout, name).toBe("");
      expect(result.stderr, name).toMatch(pattern);
      expect(result.stderr, name).not.toMatch(/must be base58/);
    }
    expect(b.toolRpc.calls).toEqual([]);
    expect(b.rpc.state.sent).toEqual([]);
  }, 60_000);

  it("道具の RPC の口（SR-M1）: loopback の RPC は env の明示が無ければ拒み（RPC に届かない、署名しない）、64 KiB 超の応答は読まず署名しない、HTTP の error も署名しない。鍵は出ない", async () => {
    const b = await boot();
    const seed = newSeed();
    const quote = await quoteOf(b, "req-rpc");
    // loopback の既定: 拒む（fixture に要求が届かない）。
    const refused = await runToExit("tools/sign-payment.ts", [JSON.stringify(quoteDocumentOf(quote))], { SOLANA_PAYER_PRIVATE_KEY: seed, SOLANA_RPC_URL: b.toolRpc.url });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(b.toolRpc.calls).toEqual([]);
    expect(refused.stdout + refused.stderr).not.toContain(seed);
    // 64 KiB 超（正しい結果に padding）: 読まずに失敗。署名しない。
    b.rpc.state.reply = "huge";
    const huge = await sign(b, quoteDocumentOf(quote), seed);
    expect(huge.code).not.toBe(0);
    expect(huge.stdout).toBe("");
    expect(b.toolRpc.calls.map((c) => c.method)).toEqual(["getLatestBlockhash"]);
    expect(huge.stdout + huge.stderr).not.toContain(seed);
    // HTTP 500（本文は正しい結果）: 失敗。署名しない。
    b.rpc.state.reply = "error";
    const error = await sign(b, quoteDocumentOf(quote), seed);
    expect(error.code).not.toBe(0);
    expect(error.stdout).toBe("");
    expect(b.toolRpc.calls.map((c) => c.method)).toEqual(["getLatestBlockhash", "getLatestBlockhash"]);
    // 正常に戻せば署名できる（同じ quote）。
    b.rpc.state.reply = "ok";
    const ok = await sign(b, quoteDocumentOf(quote), seed);
    expect(ok.code, ok.stderr).toBe(0);
    expect(b.rpc.state.sent).toEqual([]);
  }, 60_000);

  it("別の quote の封筒を purchase に渡しても Router は受けない（nonce が違う → payment_required）。道具が組んだ transaction は送出されない", async () => {
    const b = await boot();
    const seed = newSeed();
    const first = await quoteOf(b, "req-a");
    const second = await quoteOf(b, "req-b");
    const signed = await sign(b, quoteDocumentOf(first), seed);
    expect(signed.code, signed.stderr).toBe(0);
    const credential = envelopeOf(signed.stdout);
    const purchase = await b.core.purchase({ principalId: "judge", requestId: "req-b", quoteId: second.quoteId, approval: second.quoteId, credential });
    expect(purchase.status).not.toBe("delivered");
    expect(b.rpc.state.sent).toEqual([]);
    expect(b.outbound.payCalls).toBe(0);
  }, 60_000);
});
