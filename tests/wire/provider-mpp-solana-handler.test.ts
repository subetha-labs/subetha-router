/**
 * Provider D の handler（`providers/mpp-solana-workers/src/index.ts`）を Node で動かし、**Router の実 adapter**（`createMppSolanaOutbound`）で買う
 * （`docs/provider-mpp-solana-workers.md` §2.5 の AC-PD1、§4 の handler の行）。pay-kit は本物、RPC は Router の fixture、Hyperliquid は差し替え。
 * 鍵は乱数。資金は動かない（chain は fixture）。確定待ちの timeout（実時間 30 秒）は `provider-mpp-solana-timing.test.ts`。
 */
import http from "node:http";
import https from "node:https";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { address, getAddressDecoder, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { checkMppSolanaChallenge, createMppSolanaOutbound, mppSolanaViewOf, type MppSolanaOutbound } from "../../src/adapters/outbound/mpp-solana.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, MessageReservation, PayRequest } from "../../src/ports/outbound.js";
import { configOf, seedFromKey } from "../../providers/mpp-solana-workers/src/config.js";
import workerEntry, { handle, isPaymentAuthorization, runtimeOf, withoutAuthorization, type Runtime } from "../../providers/mpp-solana-workers/src/index.js";
import { installLogRedaction, redact, uninstallLogRedaction } from "../../providers/mpp-solana-workers/src/log.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { createSvmSignerFixture } from "../fixtures/svm-signer-fixture.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const RPC_HOST = "rpc.provider.test";
const PROVIDER_HOST = "provider.test";
const ROUTE = "md-solmpp-eth-snapshot";
const UPSTREAM = `https://${PROVIDER_HOST}/v1/eth/snapshot`;
const OPERATOR_BASE = "0x00000000000000000000000000000000000000b0";
const HYPERLIQUID = [{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, { markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00" }]];
const CONTRACT_KEYS = ["data", "dataSource", "fetchedAt", "market", "payment", "providerId"];
const SECRET = "provider-d-handler-test-secret-0123456789abcdef";

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  uninstallLogRedaction();
  while (closers.length > 0) await closers.pop()!();
});

async function ataOf(owner: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

function newSeed(): { seed: string; publicKey: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { seed: getBase58Decoder().decode(bytes), publicKey: getAddressDecoder().decode(ed25519.getPublicKey(bytes)) };
}

interface Listener {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** Hyperliquid の差し替え（`state.mode` で応答を変える）。 */
interface DataServer extends Listener {
  state: { mode: "ok" | "error" | "bad-shape" | "stall" };
  calls: number;
}

async function startData(): Promise<DataServer> {
  const state: DataServer["state"] = { mode: "ok" };
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    if (state.mode === "stall") return; // 応答しない（段 1 の期限で切れる）
    if (state.mode === "error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const body = JSON.stringify(state.mode === "bad-shape" ? { nope: true } : HYPERLIQUID);
    response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    response.end(body);
    void request;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, url: `http://127.0.0.1:${port}/info`, state, get calls() { return calls; }, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

interface Seen {
  paths: string[];
  authorizations: string[];
  statuses: number[];
}

/** Provider D の handler を TLS の loopback で公開する（`provider.test` の証明書。Router の transport は dial の表で届く）。 */
async function serveProvider(runtime: Runtime, seen: Seen): Promise<Listener> {
  const server = https.createServer({ key: TLS.provider.key, cert: TLS.provider.cert }, (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const authorization = request.headers["authorization"];
      if (typeof authorization === "string") seen.authorizations.push(authorization);
      seen.paths.push(request.url ?? "");
      const url = `https://${PROVIDER_HOST}${request.url ?? "/"}`;
      const out = await handle(new Request(url, { method: request.method ?? "GET", headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) }), runtime);
      seen.statuses.push(out.status);
      const body = Buffer.from(await out.arrayBuffer());
      const outHeaders = Object.fromEntries(out.headers.entries());
      delete outHeaders["content-length"];
      response.writeHead(out.status, { ...outHeaders, "content-length": String(body.length) });
      response.end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, url: `https://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

interface Harness {
  runtime: Runtime;
  env: Record<string, string>;
  rail: MppSolanaOutbound;
  router: string;
  recipient: string;
  recipientAta: string;
  rpc: SolanaRpcFixture;
  payKitRpc: SolanaRpcFixture;
  data: DataServer;
  provider: Listener;
  seen: Seen;
  operators: Set<string>;
  reservations: Set<string>;
  clock: { now: number };
  mark: () => number;
  since: (mark: number) => string[];
}

async function harness(options: { operatorsIncludeFeePayer?: boolean } = {}): Promise<Harness> {
  const signer = createSvmSignerFixture(SOL);
  const router = signer.address;
  const routerAta = await ataOf(router);
  const feePayer = newSeed();
  const recipient = newSeed().publicKey;
  const recipientAta = await ataOf(recipient);
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, atas: [{ address: routerAta, owner: router, amount: "1000000" }, { address: recipientAta, owner: recipient, amount: "0" }] });
  closers.push(rpc.close);
  const payKitRpc = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: rpc });
  closers.push(payKitRpc.close);
  rpc.state.signatureStatuses = ["confirmed"];
  const data = await startData();
  closers.push(data.close);
  const env: Record<string, string> = { PAY_TO: recipient, FEE_PAYER_PUBKEY: feePayer.publicKey, FEE_PAYER_KEY: feePayer.seed, MPP_SECRET: SECRET, SOLANA_RPC_URL: payKitRpc.url, DATA_URL: data.url };
  const runtime = await runtimeOf(env);
  const seen: Seen = { paths: [], authorizations: [], statuses: [] };
  const provider = await serveProvider(runtime, seen);
  closers.push(provider.close);
  const routes: Record<string, number> = { [PROVIDER_HOST]: provider.port, [RPC_HOST]: rpc.port };
  const base = { allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo(routes) };
  const transport = createGuardedTransport(base);
  const rpcTransport = createGuardedTransport({ ...base, dns: { timeoutMs: 3_000, maxInFlight: 4 } });
  const clock = { now: Date.now() };
  const operators = new Set<string>([OPERATOR_BASE, router, ...(options.operatorsIncludeFeePayer === true ? [feePayer.publicKey] : [])]);
  const rail = createMppSolanaOutbound({
    network: SOL,
    upstreams: { [ROUTE]: UPSTREAM },
    destinations: { [ROUTE]: { payTo: recipient, asset: MINT, scheme: "solana/charge" } },
    capability: signer.capability,
    transport,
    rpc: { url: `http://${RPC_HOST}`, transport: rpcTransport },
    operatorAddresses: operators,
    mint: MINT,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM,
    now: () => clock.now,
  });
  await rail.startup();
  const reservations = new Set<string>();
  return { runtime, env, rail, router, recipient, recipientAta, rpc, payKitRpc, data, provider, seen, operators, reservations, clock, mark: () => rpc.calls.length, since: (mark) => rpc.calls.slice(mark).map((c) => c.method) };
}

let paymentSeq = 0;
function requestOf(h: Harness, offer: DestinationOffer): PayRequest {
  paymentSeq += 1;
  const reserveMessage = async (hash: string): Promise<MessageReservation> => {
    if (h.reservations.has(hash)) return "collision";
    h.reservations.add(hash);
    return "reserved";
  };
  return { routeId: ROUTE, offer, paymentId: `11111111-2222-4333-8444-${String(paymentSeq).padStart(12, "0")}`, attempt: 1, deadlineMs: h.clock.now + 600_000, reserveMessage };
}

/** Provider に直接（TLS の loopback）。 */
async function direct(h: Harness, path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await new Promise<{ status: number; headers: Headers; text: string }>((resolve, reject) => {
    const request = https.request({ host: "127.0.0.1", port: h.provider.port, path, method: init.method ?? "GET", headers: { host: PROVIDER_HOST, ...(init.headers ?? {}) }, servername: PROVIDER_HOST, ca: TLS.ca }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (typeof value === "string") headers.set(key, value);
        resolve({ status: res.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end();
  });
  return response;
}

describe("Provider D: 402（§2.1）と Router の候補の検査", () => {
  test("Router の readChallenge が候補 1 件を読む: solana/charge・10,000・payTo = 受取 owner・feePayerKey = Worker の fee payer・decimals 6・token program。externalId も scope も無い。直接の GET は 402 + no-store + www-authenticate + pay-kit の accepts の本文", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(ROUTE);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ scheme: "solana/charge", network: SOL, asset: MINT, amount: "10000", payTo: h.recipient });
    expect(offers[0]!.extra).toMatchObject({ feePayerKey: h.runtime.paykit.feePayer, decimals: 6, tokenProgram: TOKEN_PROGRAM, realm: "subetha-provider-mpp-sol" });
    expect(offers[0]!.extra).not.toHaveProperty("externalId");
    expect(offers[0]!.extra).not.toHaveProperty("scope");
    expect(h.runtime.paykit.feePayer).toBe(h.env["FEE_PAYER_PUBKEY"]);
    // 直接の GET。
    const got = await direct(h, "/v1/eth/snapshot");
    expect(got.status).toBe(402);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("content-type")).toBe("application/json");
    const www = got.headers.get("www-authenticate")!;
    expect(www.startsWith("Payment ")).toBe(true);
    expect(www).toContain('method="solana"');
    expect(www).toContain('intent="charge"');
    expect(www).toContain('realm="subetha-provider-mpp-sol"');
    const body = JSON.parse(got.text) as { accepts: unknown[] };
    expect(Array.isArray(body.accepts)).toBe(true);
    // challenge の期限は 300 秒（pay-kit の既定 120 ではなく、明示した値）。
    const expires = Date.parse(/expires="([^"]+)"/.exec(www)![1]!);
    expect(expires - Date.now()).toBeGreaterThan(290_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(300_000);
    // 2 回の 402 で変わるのは id と expires だけ（request は同じ）。
    const again = await direct(h, "/v1/eth/snapshot");
    const requestOfHeader = (header: string): string => /request="([^"]+)"/.exec(header)![1]!;
    expect(requestOfHeader(again.headers.get("www-authenticate")!)).toBe(requestOfHeader(www));
    expect(h.since(0).filter((m) => m !== "getAccountInfo")).toEqual([]); // 402 は RPC を使わない（startup の ATA の検査だけ）
  });

  test("fee payer が Router の運用者の集合に入っていれば候補外（SR-M4。Router は同じ Provider から買えない）", async () => {
    const h = await harness({ operatorsIncludeFeePayer: true });
    expect(await h.rail.readChallenge(ROUTE)).toEqual([]);
  });

  test("404: 別のパス・クエリつき・POST・HEAD（固定文。pay-kit もデータ源も呼ばない）", async () => {
    const h = await harness();
    for (const [path, method] of [["/v1/eth/other", "GET"], ["/v1/eth/snapshot?x=1", "GET"], ["/v1/eth/snapshot", "POST"], ["/", "GET"]] as const) {
      const got = await direct(h, path, { method });
      expect(got.status, `${method} ${path}`).toBe(404);
      expect(got.text, `${method} ${path}`).toBe('{"error":"not_found"}');
      expect(got.headers.get("cache-control")).toBe("no-store");
    }
    expect(h.data.calls).toBe(0);
  });
});

describe("Provider D: 支払いつきの経路（§2.2）", () => {
  test("Router の pay → paid: 本文は契約（payment.protocol mpp）、領収は pay-kit の値そのまま、送出 1 回、Provider の 200 は no-store。Router は領収の reference を chain で照合する", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(ROUTE);
    const result = await h.rail.pay(requestOf(h, offers[0]!));
    expect(result.outcome, JSON.stringify(result)).toBe("paid");
    const paid = result as { body: Record<string, unknown>; contentType: string; txRef: string; receiptRef?: string };
    expect(paid.contentType).toBe("application/json");
    expect(Object.keys(paid.body).sort()).toEqual(CONTRACT_KEYS);
    expect(paid.body).toMatchObject({ providerId: "market-data-a", payment: { protocol: "mpp", network: SOL }, data: { markPx: "2572.5", prevDayPx: "2693.6", change24h: { absolute: "-121.1", percent: "-4.49" }, assetIndex: 1 } });
    expect(getBase58Encoder().encode(paid.txRef).length).toBe(64);
    expect(h.rpc.state.sent).toHaveLength(1);
    // quote の 402、purchase 時の読み直しの 402（設計 §4.3 の 1）、支払いの 200。
    expect(h.seen.statuses).toEqual([402, 402, 200]);
    expect(h.seen.authorizations).toHaveLength(1);
    expect(h.seen.authorizations[0]!.startsWith("Payment ")).toBe(true);
    expect(h.data.calls).toBe(1);
    // Router 側: 領収の reference を getTransaction で読み直した。
    expect(h.since(0)).toContain("getTransaction");
  });

  test("Authorization の判定は大文字小文字を区別しない（payment／PAYMENT／Payment は支払いつきの枝 = データ源が呼ばれ、pay-kit が 402 `{}` で拒む）。Bearer は未払いの枝（accepts の本文）で、pay-kit に Authorization は渡らない", async () => {
    const h = await harness();
    for (const scheme of ["payment garbage", "PAYMENT garbage", "Payment garbage"]) {
      const before = h.data.calls;
      const got = await direct(h, "/v1/eth/snapshot", { headers: { authorization: scheme } });
      expect(got.status, scheme).toBe(402);
      expect(got.text, scheme).toBe("{}");
      expect(got.headers.get("cache-control"), scheme).toBe("no-store");
      expect(got.headers.get("content-length"), scheme).toBe("2");
      expect(got.headers.get("www-authenticate")!.startsWith("Payment "), scheme).toBe(true);
      expect(got.headers.get("payment-receipt"), scheme).toBeNull();
      expect(h.data.calls, scheme).toBe(before + 1);
    }
    const bearer = await direct(h, "/v1/eth/snapshot", { headers: { authorization: "Bearer x" } });
    expect(bearer.status).toBe(402);
    expect((JSON.parse(bearer.text) as { accepts: unknown[] }).accepts.length).toBeGreaterThan(0);
    expect(h.rpc.state.sent).toEqual([]);
    // 純粋関数の形。
    expect(isPaymentAuthorization("payment x")).toBe(true);
    expect(isPaymentAuthorization("PAYMENT x")).toBe(true);
    expect(isPaymentAuthorization("Bearer x")).toBe(false);
    expect(isPaymentAuthorization("payment")).toBe(false);
    expect(isPaymentAuthorization(null)).toBe(false);
    const stripped = withoutAuthorization(new Request("https://provider.test/v1/eth/snapshot", { headers: { authorization: "Payment x", accept: "application/json" } }));
    expect(stripped.headers.get("authorization")).toBeNull();
    expect(stripped.headers.get("accept")).toBe("application/json");
  });

  test("段 1 の失敗（データ源が 500・形違い・応答しない）→ 502 data_unavailable、pay-kit は呼ばれない（RPC に要求 0、送出 0）", async () => {
    const h = await harness();
    const mark = h.payKitRpc.calls.length;
    for (const mode of ["error", "bad-shape", "stall"] as const) {
      h.data.state.mode = mode;
      const got = await direct(h, "/v1/eth/snapshot", { headers: { authorization: "Payment not-a-credential" } });
      expect(got.status, mode).toBe(502);
      expect(got.text, mode).toBe('{"error":"data_unavailable"}');
      expect(got.headers.get("cache-control"), mode).toBe("no-store");
    }
    expect(h.payKitRpc.calls.length).toBe(mark);
    expect(h.rpc.state.sent).toEqual([]);
  }, 20_000);

  test("送出が RPC の error → pay-kit の 402（本文 `{}`、領収なし）→ Router は unknown（destination_pay_unknown）。送出の試みは 1 回", async () => {
    const h = await harness();
    h.payKitRpc.localFailMethods.push("sendTransaction");
    const offers = await h.rail.readChallenge(ROUTE);
    const result = await h.rail.pay(requestOf(h, offers[0]!));
    expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(h.seen.statuses).toEqual([402, 402, 402]);
    expect(h.payKitRpc.calls.filter((c) => c.method === "sendTransaction")).toHaveLength(1);
  });

  test("replay（逐次）: 同じ credential の 2 回目は 402（pay-kit の replay の予約）、送出は増えない。同時に 2 つの instance（isolate の模擬）に出すと資金は 1 回、本文は高々 2 回（§2.2 の限界の記録）", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(ROUTE);
    const result = await h.rail.pay(requestOf(h, offers[0]!));
    expect(result.outcome).toBe("paid");
    const credential = h.seen.authorizations[0]!;
    const sentBefore = h.rpc.state.sent.length;
    const again = await direct(h, "/v1/eth/snapshot", { headers: { authorization: credential } });
    expect(again.status).toBe(402);
    expect(again.text).toBe("{}");
    expect(h.rpc.state.sent).toHaveLength(sentBefore);
    // 2 instance（isolate の模擬）: 同じ env から runtime をもう 1 つ（別の pay-kit = 別の replay store）。**同じ credential**を両方に同時に出す
    // （Router は本来 1 回しか出さない。fixture の blockhash は固定なので新しい購入は同じ取引になり、本物の chain と同じく「同じ取引は 1 回」の性質で観測する）。
    const second = await runtimeOf(h.env);
    const seen2: Seen = { paths: [], authorizations: [], statuses: [] };
    const provider2 = await serveProvider(second, seen2);
    closers.push(provider2.close);
    const chainBefore = Object.keys(h.rpc.state.transactions).length;
    const [a, b] = await Promise.all([
      direct(h, "/v1/eth/snapshot", { headers: { authorization: credential } }),
      direct({ ...h, provider: provider2 }, "/v1/eth/snapshot", { headers: { authorization: credential } }),
    ]);
    // 1 つ目の instance は replay の予約で 402。2 つ目（別の store）は同じ取引を送出し直し、chain が同じ成功した取引を見せるので **200 で本文をもう一度出す**（限界）。
    expect(a.status).toBe(402);
    expect(b.status).toBe(200);
    expect(b.headers.get("payment-receipt")).not.toBeNull();
    // 資金は 1 回: 2 つ目は同じ取引を送出し直すが（送出の要求は +1）、chain の取引は増えない（同じ署名）。
    expect(Object.keys(h.rpc.state.transactions).length).toBe(chainBefore);
    expect(h.rpc.state.sent).toHaveLength(sentBefore + 1);
  });

  test("Workers の入口: env の失敗は 500 misconfigured（値は出ない）、正しい env なら 402 を返す", async () => {
    const h = await harness();
    const bad = await workerEntry.fetch(new Request(UPSTREAM), { ...h.env, FEE_PAYER_PUBKEY: h.recipient });
    expect(bad.status).toBe(500);
    expect(await bad.text()).toBe('{"error":"misconfigured"}');
    // キャッシュは失敗を残さない: 次の要求で正しい env なら起動する（isolate の最初の要求の失敗が永続しない）。
    const ok = await workerEntry.fetch(new Request(UPSTREAM), h.env);
    expect(ok.status).toBe(402);
    expect(ok.headers.get("www-authenticate")!.startsWith("Payment ")).toBe(true);
  });
});

describe("Provider D: config・鍵・log（§2.4）", () => {
  test("config: PAY_TO・FEE_PAYER_PUBKEY の形、両者の一致の拒否、RPC・データ源の URL（userinfo 無し）。秘密は読まない", () => {
    const owner = newSeed().publicKey;
    const fee = newSeed().publicKey;
    expect(configOf({ PAY_TO: owner, FEE_PAYER_PUBKEY: fee })).toEqual({ payTo: owner, feePayerPubkey: fee, rpcUrl: "https://api.devnet.solana.com", dataUrl: "https://api.hyperliquid.xyz/info" });
    expect(() => configOf({ PAY_TO: "x", FEE_PAYER_PUBKEY: fee })).toThrow(/PAY_TO must be/);
    expect(() => configOf({ PAY_TO: owner, FEE_PAYER_PUBKEY: "1".repeat(33) })).toThrow(/FEE_PAYER_PUBKEY must be/);
    expect(() => configOf({ PAY_TO: owner, FEE_PAYER_PUBKEY: owner })).toThrow(/must differ/);
    expect(() => configOf({ PAY_TO: owner, FEE_PAYER_PUBKEY: fee, SOLANA_RPC_URL: "https://user:pw@rpc.test" })).toThrow(/SOLANA_RPC_URL/);
    expect(() => configOf({ PAY_TO: owner, FEE_PAYER_PUBKEY: fee, SOLANA_RPC_URL: "ftp://rpc.test" })).toThrow(/SOLANA_RPC_URL/);
    expect(configOf({ PAY_TO: owner, FEE_PAYER_PUBKEY: fee, SOLANA_RPC_URL: "http://127.0.0.1:1" }).rpcUrl).toBe("http://127.0.0.1:1");
    // 鍵の形。
    const { seed } = newSeed();
    expect(seedFromKey(seed)).toHaveLength(32);
    for (const bad of ["abc", "0x" + "11".repeat(32), seed + seed]) {
      let message = "";
      try { seedFromKey(bad); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/base58 32-byte seed/);
      expect(message).not.toContain(bad.slice(0, 8));
    }
  });

  test("runtime: FEE_PAYER_KEY が無い・形が違う・公開鍵と一致しない・MPP_SECRET が短い → 固定文で起動しない（値は出ない）", async () => {
    const owner = newSeed().publicKey;
    const fee = newSeed();
    const base = { PAY_TO: owner, FEE_PAYER_PUBKEY: fee.publicKey, FEE_PAYER_KEY: fee.seed, MPP_SECRET: SECRET, SOLANA_RPC_URL: "http://127.0.0.1:1" };
    await expect(runtimeOf({ ...base, FEE_PAYER_KEY: "" })).rejects.toThrow(/FEE_PAYER_KEY is required/);
    await expect(runtimeOf({ ...base, FEE_PAYER_KEY: "nope" })).rejects.toThrow(/base58 32-byte seed/);
    await expect(runtimeOf({ ...base, FEE_PAYER_PUBKEY: newSeed().publicKey })).rejects.toThrow(/does not match/);
    await expect(runtimeOf({ ...base, MPP_SECRET: "short" })).rejects.toThrow(/at least 32 bytes/);
    // runtime は起動時に log の伏せ字を入れる（RPC の URL が console.error に出ない）。上の呼び出しで入った包みを外してから spy を置く（包みは置いた時点の console を捕まえる）。
    uninstallLogRedaction();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = await runtimeOf({ ...base, SOLANA_RPC_URL: "http://127.0.0.1:1/v1/SECRETTOKEN" });
    console.error(`mppx: internal verification error at http://127.0.0.1:1/v1/SECRETTOKEN`);
    expect(spy.mock.calls.map((args) => String(args[0]))).toEqual(["mppx: internal verification error at <rpc>"]);
    uninstallLogRedaction();
    spy.mockRestore();
    expect(runtime.paykit.feePayer).toBe(fee.publicKey);
    expect(JSON.stringify(runtime.config)).not.toContain(fee.seed);
  });

  test("log の伏せ字: console.error に RPC の URL が含まれても `<rpc>` になる（文字列と Error）。外せば元に戻る", () => {
    const rpcUrl = "https://rpc.example/v1/SECRETTOKEN";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    installLogRedaction(rpcUrl);
    console.error(`failed: ${rpcUrl} unreachable`);
    console.error(new Error(`RPC error at ${rpcUrl}`));
    // 包んだ後の呼び出しは spy（元の関数）に伏せ字で届く。
    const calls = spy.mock.calls.map((args) => args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    expect(calls).toEqual(["failed: <rpc> unreachable", "RPC error at <rpc>"]);
    expect(calls.join(" ")).not.toContain("SECRETTOKEN");
    expect(redact("a https://rpc.example/v1/SECRETTOKEN b", rpcUrl)).toBe("a <rpc> b");
    expect(redact(42, rpcUrl)).toBe(42);
    uninstallLogRedaction();
    spy.mockRestore();
  });
});
