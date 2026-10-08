/**
 * AC-PD2（`docs/provider-mpp-solana-workers.md` §2.5・§5）: **本物の Worker**（`providers/mpp-solana-workers` を `wrangler dev` = workerd で起動）を
 * Router の送信 adapter（`createMppSolanaOutbound`）で買う。pay-kit は Worker の中の本物、RPC は Router の fixture（平文 http。Worker は 127.0.0.1 に直接届く）、
 * Hyperliquid は stub。成功が `paid`、送出の失敗は Worker の 402（領収なし）と Router の `unknown`、送出の後に Router が去っても Worker は続行して資金が動く。
 *
 * **gate**: `PROVIDER_WORKER_AC=1` のときだけ走る（`providers/mpp-solana-workers/node_modules` の wrangler が要る。Linux の suite では skip）。
 * 外には出ない: fixture は全部 127.0.0.1。Router（TLS、`provider.test`）→ front → wrangler dev（平文 http）→（pay-kit の RPC は）試験の proxy → RPC の fixture。
 * wrangler 自身の外向きの通信は env で止め（telemetry・error report・banner、Miniflare の `cf.json` の取得 = `CLOUDFLARE_CF_FETCH_ENABLED=false`）、npm の registry を
 * 閉じた loopback に向け、子の env は親の env を継がない（Cloudflare の資格情報・設定を渡さない）。鍵・秘密は 0600 の一時ファイル（`--env-file`）で渡して終わりに消す。
 * 生の log に鍵・秘密が出ないことを見る。実時間の行（確定待ちの 30 秒、RPC が 45 秒超黙る）を含むので全体で 2〜3 分かかる。
 *
 *   PROVIDER_WORKER_AC=1 npx vitest run tests/acceptance/provider-mpp-solana-workers.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { address, getAddressDecoder, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createMppSolanaOutbound, type MppSolanaOutbound } from "../../src/adapters/outbound/mpp-solana.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, MessageReservation, PayRequest, PayResult } from "../../src/ports/outbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { createSvmSignerFixture, type SvmSignerFixture } from "../fixtures/svm-signer-fixture.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const ENABLED = process.env["PROVIDER_WORKER_AC"] === "1";
const PACKAGE_DIR = path.resolve(import.meta.dirname, "../../providers/mpp-solana-workers");
const WRANGLER = path.join(PACKAGE_DIR, "node_modules/.bin/wrangler");

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const PROVIDER_HOST = "provider.test";
const RPC_HOST = "rpc.provider.test";
const ROUTE = "md-solmpp-eth-snapshot";
const UPSTREAM = `https://${PROVIDER_HOST}/v1/eth/snapshot`;
const HYPERLIQUID = [{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, { markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00" }]];
const CONTRACT_KEYS = ["data", "dataSource", "fetchedAt", "market", "payment", "providerId"];
const SECRET = "provider-d-ac-pd2-secret-0123456789abcdef0123456789";
/** fixture の blockhash（Router の取引ごとに別の値にする: 同じ blockhash だと同じ取引になり、予約と replay で 2 件目が進まない）。 */
const BLOCKHASHES = Array.from({ length: 8 }, () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))));

interface Listener {
  readonly port: number;
  close(): Promise<void>;
}
interface WireResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function listen(server: http.Server | https.Server): Promise<Listener> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) });
    });
  });
}

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Router（TLS、`provider.test`）→ wrangler dev（平文 http）。支払いつきの要求（`Authorization: Payment …`）への Worker の応答を最後まで記録する（Router が先に去っても）。 */
async function startTlsFront(tls: TlsMaterial, workerPort: number): Promise<Listener & { readonly paid: WireResponse[]; readonly unpaid: () => number }> {
  const paid: WireResponse[] = [];
  let unpaid = 0;
  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    const authorization = request.headers["authorization"];
    const isPaid = typeof authorization === "string" && authorization.toLowerCase().startsWith("payment ");
    if (!isPaid) unpaid += 1;
    const { "accept-encoding": _acceptEncoding, ...forwarded } = request.headers;
    void readAll(request).then((body) => {
      const upstream = http.request({ host: "127.0.0.1", port: workerPort, method: request.method, path: request.url, headers: forwarded }, (reply) => {
        if (!response.destroyed) response.writeHead(reply.statusCode ?? 502, reply.headers);
        if (!isPaid) {
          reply.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        reply.on("data", (c: Buffer) => { chunks.push(c); if (!response.destroyed) response.write(c); });
        reply.on("end", () => { paid.push({ status: reply.statusCode ?? 0, headers: reply.headers, body: Buffer.concat(chunks).toString("utf8") }); if (!response.destroyed) response.end(); });
      });
      upstream.on("error", () => { if (!response.destroyed) response.destroy(); });
      upstream.end(body);
    });
  });
  return { ...(await listen(server)), paid, unpaid: () => unpaid };
}

async function startHyperliquidStub(): Promise<Listener & { readonly calls: () => number }> {
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    const text = JSON.stringify(HYPERLIQUID);
    response.writeHead(request.method === "POST" ? 200 : 405, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
  });
  return { ...(await listen(server)), calls: () => calls };
}

/** Worker の pay-kit → RPC の fixture の間の proxy。`stall` のとき `sendTransaction` を**答えずに**抱える（RPC が黙る行）。`release()` で抱えた接続を切る。 */
async function startRpcProxy(targetPort: number): Promise<Listener & { readonly state: { stall: boolean }; readonly stalled: () => number; release(): void }> {
  const state = { stall: false };
  let stalled = 0;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((request, response) => {
    void readAll(request).then((body) => {
      let method = "";
      try { method = String((JSON.parse(body.toString("utf8")) as { method?: unknown }).method ?? ""); } catch { /* 形は fixture が見る */ }
      if (state.stall && method === "sendTransaction") {
        stalled += 1;
        held.push(response);
        return;
      }
      const upstream = http.request({ host: "127.0.0.1", port: targetPort, method: request.method, path: request.url, headers: { ...request.headers, host: `127.0.0.1:${targetPort}` } }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      upstream.end(body);
    });
  });
  const listener = await listen(server);
  return { ...listener, state, stalled: () => stalled, release: () => { while (held.length > 0) held.pop()!.destroy(); } };
}

interface Worker {
  readonly port: number;
  readonly log: () => string;
  readonly rawIncludesSecret: () => boolean;
  stop(): Promise<void>;
}

/** `wrangler dev` を自分の process group で起動し、`Ready on` を待つ。秘密は `--env-file` だけ（引数にも log にも出さない）。 */
async function startWorker(publicHost: string, vars: Record<string, string>, envFile: string, secrets: string[], closers: Array<() => Promise<void>>): Promise<Worker> {
  const port = await freePort();
  const inspectorPort = await freePort();
  const deadPort = await freePort();
  const args = ["dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspectorPort), "--local-upstream", publicHost, "--upstream-protocol", "https", "--show-interactive-dev-session=false", "--env-file", envFile];
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);
  // 親の env は継がない（Cloudflare の資格情報・設定を子に渡さない）。wrangler が要るのは PATH・HOME・TMPDIR だけ。
  const inherited: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  const childEnv = { ...inherited, WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false", WRANGLER_HIDE_BANNER: "true", CI: "true", CLOUDFLARE_CF_FETCH_ENABLED: "false", npm_registry: `http://127.0.0.1:${deadPort}/` };
  const child: ChildProcess = spawn(WRANGLER, args, { cwd: PACKAGE_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  let raw = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  child.stdout?.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
  const stop = async (): Promise<void> => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* group が既に無い */ }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* 既に終わっている */ }
  };
  closers.push(stop);
  const redacted = (): string => secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), raw);
  const started = Date.now();
  while (!raw.includes("Ready on")) {
    if (spawnError !== undefined) throw new Error(`wrangler dev could not be spawned: ${spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`wrangler dev exited before ready:\n${redacted()}`);
    if (Date.now() - started > 120_000) throw new Error(`wrangler dev not ready in 120 s:\n${redacted()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { port, log: redacted, rawIncludesSecret: () => secrets.some((secret) => raw.includes(secret)), stop };
}

const describeAc = ENABLED ? describe : describe.skip;

describeAc("AC-PD2: wrangler dev の Provider D を Router の MPP Solana 送信 adapter で買う（fixture の RPC）", () => {
  let TLS: TlsMaterial;
  const closers: Array<() => Promise<void>> = [];
  let tmpDir: string | undefined;
  let rpcs: SolanaRpcFixture[];
  let payKitRpc: SolanaRpcFixture;
  let rpcProxy: Awaited<ReturnType<typeof startRpcProxy>>;
  let worker: Worker;
  let front: Awaited<ReturnType<typeof startTlsFront>>;
  let hyperliquid: Awaited<ReturnType<typeof startHyperliquidStub>>;
  let routerSigner: SvmSignerFixture;
  let recipient: string;
  let feePayerPubkey: string;
  let routes: Record<string, number>;
  let rail: MppSolanaOutbound;
  const reservations = new Set<string>();
  let paymentSeq = 0;

  function railWith(dial: Record<string, number>): MppSolanaOutbound {
    const base = { allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo(dial) };
    return createMppSolanaOutbound({
      network: SOL,
      upstreams: { [ROUTE]: UPSTREAM },
      destinations: { [ROUTE]: { payTo: recipient, asset: MINT, scheme: "solana/charge" } },
      capability: routerSigner.capability,
      transport: createGuardedTransport(base),
      rpc: { url: `http://${RPC_HOST}`, transport: createGuardedTransport({ ...base, dns: { timeoutMs: 3_000, maxInFlight: 4 } }) },
      operatorAddresses: new Set<string>([routerSigner.address]),
      mint: MINT,
      decimals: 6,
      tokenProgram: TOKEN_PROGRAM,
    });
  }
  function requestOf(offer: DestinationOffer, overrides: Partial<PayRequest> = {}): PayRequest {
    paymentSeq += 1;
    const reserveMessage = async (hash: string): Promise<MessageReservation> => (reservations.has(hash) ? "collision" : (reservations.add(hash), "reserved"));
    return { routeId: ROUTE, offer, paymentId: `11111111-2222-4333-8444-${String(paymentSeq).padStart(12, "0")}`, attempt: 1, deadlineMs: Date.now() + 600_000, reserveMessage, ...overrides };
  }
  async function buy(r: MppSolanaOutbound, overrides: Partial<PayRequest> = {}): Promise<PayResult> {
    const offers = await r.readChallenge(ROUTE);
    expect(offers).toHaveLength(1);
    return r.pay(requestOf(offers[0]!, overrides));
  }

  beforeAll(async () => {
    if (!existsSync(WRANGLER)) throw new Error("providers/mpp-solana-workers/node_modules/.bin/wrangler is missing: run `npm install` in providers/mpp-solana-workers");
    TLS = generateTestTls();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "provider-ac-pd2-"));
    hyperliquid = await startHyperliquidStub();
    closers.push(hyperliquid.close);
    routerSigner = createSvmSignerFixture(SOL);
    const feeSeed = crypto.getRandomValues(new Uint8Array(32));
    const feeSeedText = getBase58Decoder().decode(feeSeed);
    feePayerPubkey = getAddressDecoder().decode(ed25519.getPublicKey(feeSeed));
    recipient = getAddressDecoder().decode(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))));
    const ataOf = async (owner: string): Promise<string> => String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
    // Router の RPC は blockhash ごとに別の口（chain の state は共有）。Worker の pay-kit の口は 1 つ。
    rpcs = [];
    const first = await startSolanaRpc({ mint: MINT, decimals: 6, blockhash: BLOCKHASHES[0]!, atas: [{ address: await ataOf(routerSigner.address), owner: routerSigner.address, amount: "1000000" }, { address: await ataOf(recipient), owner: recipient }] });
    rpcs.push(first);
    closers.push(first.close);
    for (const blockhash of BLOCKHASHES.slice(1)) {
      const next = await startSolanaRpc({ mint: MINT, decimals: 6, blockhash, shareStateWith: first });
      rpcs.push(next);
      closers.push(next.close);
    }
    payKitRpc = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: first });
    closers.push(payKitRpc.close);
    rpcProxy = await startRpcProxy(payKitRpc.port);
    closers.push(rpcProxy.close);
    first.state.signatureStatuses = ["confirmed"];
    const envFile = path.join(tmpDir, "provider-d.env");
    writeFileSync(envFile, `FEE_PAYER_KEY=${feeSeedText}\nMPP_SECRET=${SECRET}\n`, { mode: 0o600 });
    worker = await startWorker(PROVIDER_HOST, { PAY_TO: recipient, FEE_PAYER_PUBKEY: feePayerPubkey, SOLANA_RPC_URL: `http://127.0.0.1:${rpcProxy.port}`, DATA_URL: `http://127.0.0.1:${hyperliquid.port}/info` }, envFile, [feeSeedText, SECRET], closers);
    front = await startTlsFront(TLS, worker.port);
    closers.push(front.close);
    routes = { [PROVIDER_HOST]: front.port, [RPC_HOST]: rpcs[0]!.port };
    rail = railWith(routes);
    await rail.startup();
  }, 240_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    while (closers.length > 0) {
      try { await closers.pop()!(); } catch (error) { failures.push(error); }
    }
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    TLS?.cleanup();
    if (failures.length > 0) throw failures[0];
  });

  test("cold start: 402 が Router の候補を通り、購入は paid（本文は契約、領収あり、Worker の 200 の wire は content-type・no-store・Payment-Receipt つき）。送出 1 回、Hyperliquid 1 回", async () => {
    const offers = await rail.readChallenge(ROUTE);
    expect(offers[0]).toMatchObject({ scheme: "solana/charge", amount: "10000", payTo: recipient });
    expect(offers[0]!.extra).toMatchObject({ feePayerKey: feePayerPubkey, decimals: 6, tokenProgram: TOKEN_PROGRAM });
    const started = Date.now();
    const result = await rail.pay(requestOf(offers[0]!));
    const elapsed = Date.now() - started;
    expect(result.outcome, JSON.stringify(result)).toBe("paid");
    const paid = result as { body: Record<string, unknown>; txRef: string };
    expect(Object.keys(paid.body).sort()).toEqual(CONTRACT_KEYS);
    expect(paid.body).toMatchObject({ providerId: "market-data-a", payment: { protocol: "mpp", network: SOL }, data: { markPx: "2572.5", assetIndex: 1 } });
    expect(getBase58Encoder().encode(paid.txRef).length).toBe(64);
    expect(elapsed).toBeLessThan(45_000);
    expect(front.paid).toHaveLength(1);
    expect(front.paid[0]!.status).toBe(200);
    expect(front.paid[0]!.headers["content-type"]).toBe("application/json");
    expect(front.paid[0]!.headers["cache-control"]).toBe("no-store");
    expect(typeof front.paid[0]!.headers["payment-receipt"]).toBe("string");
    expect(JSON.parse(front.paid[0]!.body)).toEqual(paid.body);
    expect(rpcs[0]!.state.sent).toHaveLength(1);
    expect(hyperliquid.calls()).toBe(1);
  }, 120_000);

  test("warm: 別の blockhash で 2 件目も paid（同じ isolate）", async () => {
    routes[RPC_HOST] = rpcs[1]!.port;
    const result = await buy(rail);
    expect(result.outcome, JSON.stringify(result)).toBe("paid");
    expect(rpcs[0]!.state.sent).toHaveLength(2);
    expect(front.paid).toHaveLength(2);
  }, 120_000);

  test("同時 2 件（別の blockhash・別の adapter）: 両方 paid、送出は 2 回", async () => {
    const railA = railWith({ [PROVIDER_HOST]: front.port, [RPC_HOST]: rpcs[2]!.port });
    const railB = railWith({ [PROVIDER_HOST]: front.port, [RPC_HOST]: rpcs[3]!.port });
    await Promise.all([railA.startup(), railB.startup()]);
    const [a, b] = await Promise.all([buy(railA), buy(railB)]);
    expect(a.outcome, JSON.stringify(a)).toBe("paid");
    expect(b.outcome, JSON.stringify(b)).toBe("paid");
    expect(rpcs[0]!.state.sent).toHaveLength(4);
    expect(front.paid).toHaveLength(4);
  }, 120_000);

  test("送出が RPC の error → Worker 402（領収なし）→ Router unknown。送出の試みは 1 回", async () => {
    payKitRpc.localFailMethods.push("sendTransaction");
    try {
      // 新しい blockhash（同じ blockhash だと同じ取引になり、pay-kit の replay store が送出の前に拒む）。
      routes[RPC_HOST] = rpcs[4]!.port;
      const before = payKitRpc.calls.filter((c) => c.method === "sendTransaction").length;
      const result = await buy(rail);
      expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
      expect(payKitRpc.calls.filter((c) => c.method === "sendTransaction").length).toBe(before + 1);
      const last = front.paid[front.paid.length - 1]!;
      expect(last.status).toBe(402);
      expect(last.body).toBe("{}");
      expect(last.headers["payment-receipt"]).toBeUndefined();
      expect(last.headers["cache-control"]).toBe("no-store");
    } finally {
      payKitRpc.localFailMethods.length = 0;
    }
  }, 120_000);

  test("送出の後に Router が去る（有料要求の期限 2 秒、確定は約 5 秒後）: Router は unknown、Worker は続行して 200 + 領収を返し、資金は動く（送出 1 回）", async () => {
    routes[RPC_HOST] = rpcs[5]!.port;
    rpcs[0]!.state.signatureStatuses = ["null", "null", "null", "null", "null", "confirmed"];
    const sentBefore = rpcs[0]!.state.sent.length;
    const paidBefore = front.paid.length;
    try {
      const short = createMppSolanaOutbound({
        network: SOL,
        upstreams: { [ROUTE]: UPSTREAM },
        destinations: { [ROUTE]: { payTo: recipient, asset: MINT, scheme: "solana/charge" } },
        capability: routerSigner.capability,
        transport: createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo(routes) }),
        rpc: { url: `http://${RPC_HOST}`, transport: createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo(routes), dns: { timeoutMs: 3_000, maxInFlight: 4 } }) },
        operatorAddresses: new Set<string>([routerSigner.address]),
        mint: MINT,
        decimals: 6,
        tokenProgram: TOKEN_PROGRAM,
        paidTimeoutMs: 2_000,
      });
      await short.startup();
      const result = await buy(short);
      expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
      // Worker は続行する: front が最後まで記録した応答は 200 + 領収。
      const started = Date.now();
      while (front.paid.length === paidBefore && Date.now() - started < 40_000) await new Promise((resolve) => setTimeout(resolve, 250));
      const last = front.paid[front.paid.length - 1]!;
      expect(front.paid.length).toBe(paidBefore + 1);
      expect(last.status).toBe(200);
      expect(typeof last.headers["payment-receipt"]).toBe("string");
      expect(rpcs[0]!.state.sent).toHaveLength(sentBefore + 1);
    } finally {
      rpcs[0]!.state.signatureStatuses = ["confirmed"];
    }
  }, 120_000);

  test("確定待ちの timeout（workerd の中の pay-kit、実時間 30 秒）: getSignatureStatuses が null のまま → Worker 402（領収なし）→ Router unknown（45 秒の内側）。送出 1 回", async () => {
    routes[RPC_HOST] = rpcs[6]!.port;
    rpcs[0]!.state.signatureStatuses = ["null"];
    const sentBefore = rpcs[0]!.state.sent.length;
    const paidBefore = front.paid.length;
    try {
      const started = Date.now();
      const result = await buy(rail);
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
      expect(elapsed).toBeGreaterThanOrEqual(29_000);
      expect(elapsed).toBeLessThan(45_000);
      expect(rpcs[0]!.state.sent).toHaveLength(sentBefore + 1);
      expect(front.paid).toHaveLength(paidBefore + 1);
      const last = front.paid[front.paid.length - 1]!;
      expect(last.status).toBe(402);
      expect(last.body).toBe("{}");
      expect(last.headers["payment-receipt"]).toBeUndefined();
    } finally {
      rpcs[0]!.state.signatureStatuses = ["confirmed"];
    }
  }, 120_000);

  test("RPC が 45 秒を超えて黙る（sendTransaction を proxy が抱える）: Router は 45 秒で unknown、chain への送出は 0、Worker の送出の試みは 1 回", async () => {
    routes[RPC_HOST] = rpcs[7]!.port;
    rpcProxy.state.stall = true;
    const sentBefore = rpcs[0]!.state.sent.length;
    const paidBefore = front.paid.length;
    try {
      const started = Date.now();
      const result = await buy(rail);
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
      expect(elapsed).toBeGreaterThanOrEqual(44_000);
      expect(elapsed).toBeLessThan(60_000);
      expect(rpcs[0]!.state.sent).toHaveLength(sentBefore);
      expect(rpcProxy.stalled()).toBe(1);
      // front はまだ Worker の応答を見ていない（Worker は RPC を待っている）。
      expect(front.paid).toHaveLength(paidBefore);
    } finally {
      rpcProxy.state.stall = false;
      rpcProxy.release();
    }
    // 抱えた接続を切ると pay-kit の fetch が失敗し、Worker は 402（領収なし）で終わる。送出は増えない。
    const started = Date.now();
    while (front.paid.length === paidBefore && Date.now() - started < 30_000) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(front.paid).toHaveLength(paidBefore + 1);
    expect(front.paid[front.paid.length - 1]!.status).toBe(402);
    expect(rpcs[0]!.state.sent).toHaveLength(sentBefore);
  }, 150_000);

  test("生の log に fee payer の seed と MPP_SECRET は出ない", () => {
    expect(worker.rawIncludesSecret()).toBe(false);
    expect(worker.log()).not.toContain("<redacted>");
  });
});
