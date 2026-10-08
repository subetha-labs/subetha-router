/**
 * AC-P2（`docs/provider-x402-workers.md` §5）: **本物の Worker**（`providers/x402-workers` を `wrangler dev` = workerd で起動）を Router の fixture の
 * facilitator（`circle-facilitator`・`svm-facilitator`）に向け、Router 自身の送信 adapter（Arc: `createX402Outbound` の組み直しの署名器、
 * Solana: `createX402SvmOutbound`）で買う。成功が `paid`、settle の結果の表の各行が Router の `unknown`、facilitator の settle が **1 回**。
 *
 * **gate**: `PROVIDER_WORKER_AC=1` のときだけ走る（`providers/x402-workers/node_modules` の wrangler が要る。Linux の suite では skip）。
 * 外には出ない: fixture は全部 127.0.0.1。Worker（平文 http）と TLS の fixture の間は、この試験が立てる proxy が結ぶ:
 *   Router ──TLS(arc.provider.test)──▶ front ──http──▶ wrangler dev ──http──▶ proxy ──TLS(circle.test)──▶ Circle fixture
 * 鍵: Arc の売り手鍵は試験が乱数で作り、0600 の一時ファイル（`--env-file`）で渡して終わりに消す。何も出力しない。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createX402Outbound } from "../../src/adapters/outbound/x402.js";
import { createX402SvmOutbound, type X402SvmOutbound } from "../../src/adapters/outbound/x402-svm.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, EvmSigningCapability, OutboundRail, PayRequest, PayResult } from "../../src/ports/outbound.js";
import { startCircleFacilitator, type CircleFacilitator } from "../fixtures/circle-facilitator.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator, type SvmFacilitator } from "../fixtures/svm-facilitator.js";
import { createSvmSignerFixture } from "../fixtures/svm-signer-fixture.js";
import { SVM_FIXTURE_MINT, SVM_FIXTURE_NETWORK } from "../fixtures/svm-upstream.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const ENABLED = process.env["PROVIDER_WORKER_AC"] === "1";
const PACKAGE_DIR = path.resolve(import.meta.dirname, "../../providers/x402-workers");
const WRANGLER = path.join(PACKAGE_DIR, "node_modules/.bin/wrangler");

const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SOL = SVM_FIXTURE_NETWORK;
const MINT = SVM_FIXTURE_MINT;
const ARC_HOST = "arc.provider.test";
const SOL_HOST = "sol.provider.test";
/** fixture の証明書（`provider.test` の SAN）にある名前を SNI に使う（`circle.test` は SAN に無い）。 */
const CIRCLE_HOST = "facilitator.provider.test";
const SVM_FAC_HOST = "facilitator.provider.test";
const ROUTE_ARC = "md-arc-eth-snapshot";
const ROUTE_SOL = "md-sol-eth-snapshot-mpp";
const HYPERLIQUID = [{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, { markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00" }]];
const CONTRACT_KEYS = ["data", "dataSource", "fetchedAt", "market", "payment", "providerId"];

interface Listener {
  readonly port: number;
  close(): Promise<void>;
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

/** Worker（平文 http）→ TLS の fixture。`host`/SNI は fixture の名前。Arc は fixture に無い `/supported` をここで答える。 */
async function startHttpToTlsProxy(target: { port: number; host: string; ca: string }, supportedKind?: Record<string, unknown>): Promise<Listener & { readonly seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (supportedKind !== undefined && request.method === "GET" && request.url === "/supported") {
      const text = JSON.stringify({ kinds: [supportedKind] });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
      return;
    }
    void readAll(request).then((body) => {
      const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.host };
      const upstream = https.request({ host: "127.0.0.1", port: target.port, servername: target.host, ca: [target.ca], method: request.method, path: request.url, headers }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      upstream.end(body);
    });
  });
  const listener = await listen(server);
  return { ...listener, seen };
}

/** Router（TLS、`arc.provider.test` 等）→ wrangler dev（平文 http）。応答のヘッダを記録する（`content-length` の確認に）。 */
async function startTlsFront(tls: TlsMaterial, workerPort: number): Promise<Listener & { readonly responses: http.IncomingHttpHeaders[] }> {
  const responses: http.IncomingHttpHeaders[] = [];
  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    void readAll(request).then((body) => {
      const upstream = http.request({ host: "127.0.0.1", port: workerPort, method: request.method, path: request.url, headers: request.headers }, (reply) => {
        responses.push(reply.headers);
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      upstream.end(body);
    });
  });
  return { ...(await listen(server)), responses };
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

interface Worker {
  readonly port: number;
  readonly log: () => string;
  stop(): Promise<void>;
}

/** `wrangler dev --env <env>` を自分の process group で起動し、`Ready on` を待つ。鍵は `--env-file` だけ（引数にも log にも出さない）。 */
async function startWorker(env: "arc" | "sol", publicHost: string, vars: Record<string, string>, envFile: string | undefined, redact: string[]): Promise<Worker> {
  const port = await freePort();
  const inspectorPort = await freePort();
  // `--local-upstream` + `--upstream-protocol https`: Worker が見る `request.url` の origin を本番と同じ形（https://<host>）にする。
  // Router は 402 の `resource.url` を canonical URL と完全一致で束縛するので、ここが違えば候補にならない。
  const args = ["dev", "--env", env, "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspectorPort), "--local-upstream", publicHost, "--upstream-protocol", "https", "--show-interactive-dev-session=false", "--log-level", "log"];
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);
  if (envFile !== undefined) args.push("--env-file", envFile);
  const child: ChildProcess = spawn(WRANGLER, args, { cwd: PACKAGE_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" } });
  let log = "";
  const append = (chunk: Buffer): void => {
    let text = chunk.toString("utf8");
    for (const secret of redact) text = text.replaceAll(secret, "<redacted>");
    log += text;
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const started = Date.now();
  while (!log.includes("Ready on")) {
    if (child.exitCode !== null) throw new Error(`wrangler dev --env ${env} exited before ready:\n${log}`);
    if (Date.now() - started > 90_000) throw new Error(`wrangler dev --env ${env} not ready in 90 s:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const stop = async (): Promise<void> => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* 既に終わっている */ }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* 既に終わっている */ }
  };
  return { port, log: () => log, stop };
}

const describeAc = ENABLED ? describe : describe.skip;

describeAc("AC-P2: wrangler dev の Worker を Router の送信 adapter で買う（fixture の facilitator）", () => {
  let TLS: TlsMaterial;
  const closers: Array<() => Promise<void>> = [];
  let tmpDir: string;
  // Arc
  let circle: CircleFacilitator;
  let arcWorker: Worker;
  let arcFront: Awaited<ReturnType<typeof startTlsFront>>;
  let arcRail: OutboundRail;
  let arcPayer: `0x${string}`;
  let arcPayTo: `0x${string}`;
  // Solana
  let svmFac: SvmFacilitator;
  let rpc: SolanaRpcFixture;
  let solWorker: Worker;
  let solFront: Awaited<ReturnType<typeof startTlsFront>>;
  let solRail: X402SvmOutbound;
  let solProviderOwner: string;
  let hyperliquid: Awaited<ReturnType<typeof startHyperliquidStub>>;
  let arcProxy: Awaited<ReturnType<typeof startHttpToTlsProxy>>;
  let solProxy: Awaited<ReturnType<typeof startHttpToTlsProxy>>;

  beforeAll(async () => {
    if (!existsSync(WRANGLER)) throw new Error("providers/x402-workers/node_modules/.bin/wrangler is missing: run `npm install --legacy-peer-deps` in providers/x402-workers");
    TLS = generateTestTls();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "provider-ac-p2-"));
    hyperliquid = await startHyperliquidStub();
    closers.push(hyperliquid.close);

    // ---- Arc: Circle fixture ← proxy ← Worker ← front ← Router
    circle = await startCircleFacilitator(TLS, CIRCLE_HOST);
    closers.push(circle.close);
    arcProxy = await startHttpToTlsProxy({ port: circle.port, host: CIRCLE_HOST, ca: TLS.ca }, { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } });
    closers.push(arcProxy.close);
    const sellerKey = generatePrivateKey();
    arcPayTo = privateKeyToAccount(sellerKey).address;
    const envFile = path.join(tmpDir, "arc.env");
    writeFileSync(envFile, `SELLER_PROOF_KEY=${sellerKey}\n`, { mode: 0o600 });
    arcWorker = await startWorker("arc", ARC_HOST, { FACILITATOR_URL: `http://127.0.0.1:${arcProxy.port}`, PAY_TO: arcPayTo, DATA_URL: `http://127.0.0.1:${hyperliquid.port}/info` }, envFile, [sellerKey, sellerKey.slice(2)]);
    closers.push(arcWorker.stop);
    arcFront = await startTlsFront(TLS, arcWorker.port);
    closers.push(arcFront.close);
    const account = privateKeyToAccount(generatePrivateKey());
    arcPayer = account.address;
    const arcDial = dialTo({ [ARC_HOST]: arcFront.port });
    const arcTransport = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: arcDial });
    const capability: EvmSigningCapability = { network: ARC, kind: "real-key", signer: { address: account.address, signTypedData: async (message) => account.signTypedData(message as never) } };
    arcRail = createX402Outbound({ upstreams: { [ROUTE_ARC]: `https://${ARC_HOST}/v1/eth/snapshot` }, transport: arcTransport, capability, rebuildSignatures: true, tokenDomains: { [ARC_USDC]: { name: "USDC", version: "2" } } });

    // ---- Solana: SVM facilitator fixture ← proxy ← Worker ← front ← Router（RPC の fixture は Router だけが使う）
    svmFac = await startSvmFacilitator(TLS, SOL, undefined, SVM_FAC_HOST);
    closers.push(svmFac.close);
    solProxy = await startHttpToTlsProxy({ port: svmFac.port, host: SVM_FAC_HOST, ca: TLS.ca });
    closers.push(solProxy.close);
    const routerSigner = createSvmSignerFixture(SOL);
    const providerSigner = createSvmSignerFixture(SOL);
    solProviderOwner = providerSigner.address;
    const ataOf = async (owner: string): Promise<string> => String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
    const routerAta = await ataOf(routerSigner.address);
    const providerAta = await ataOf(solProviderOwner);
    rpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, atas: [{ address: routerAta, owner: routerSigner.address, amount: "1000000" }, { address: providerAta, owner: solProviderOwner }] });
    closers.push(rpc.close);
    solWorker = await startWorker("sol", SOL_HOST, { FACILITATOR_URL: `http://127.0.0.1:${solProxy.port}`, PAY_TO: solProviderOwner, DATA_URL: `http://127.0.0.1:${hyperliquid.port}/info` }, undefined, []);
    closers.push(solWorker.stop);
    solFront = await startTlsFront(TLS, solWorker.port);
    closers.push(solFront.close);
    const solDial = dialTo({ [SOL_HOST]: solFront.port, "rpc.provider.test": rpc.port });
    const base = { allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: solDial };
    solRail = createX402SvmOutbound({
      network: SOL,
      upstreams: { [ROUTE_SOL]: `https://${SOL_HOST}/v1/eth/snapshot` },
      destinations: { [ROUTE_SOL]: { payTo: solProviderOwner, asset: MINT, scheme: "exact" } },
      capability: routerSigner.capability,
      transport: createGuardedTransport(base),
      rpc: { url: "https://rpc.provider.test", transport: createGuardedTransport({ ...base, dns: { timeoutMs: 3_000, maxInFlight: 4 } }) },
      operatorAddresses: new Set<string>([routerSigner.address]),
      mint: MINT,
      decimals: 6,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    await solRail.startup();
  }, 240_000);

  afterAll(async () => {
    while (closers.length > 0) await closers.pop()!();
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    TLS?.cleanup();
  }, 60_000);

  let seq = 0;
  const reservations = new Set<string>();
  function requestOf(routeId: string, offer: DestinationOffer): PayRequest {
    seq += 1;
    return {
      routeId,
      offer,
      paymentId: `11111111-2222-4333-8444-${String(seq).padStart(12, "0")}`,
      attempt: 1,
      deadlineMs: Date.now() + 600_000,
      reserveMessage: async (hash: string) => {
        if (reservations.has(hash)) return "collision";
        reservations.add(hash);
        return "reserved";
      },
    };
  }

  async function buyArc(): Promise<PayResult> {
    const offers = await arcRail.readChallenge(ROUTE_ARC);
    expect(offers).toHaveLength(1);
    return arcRail.pay(requestOf(ROUTE_ARC, offers[0]!));
  }

  async function buySol(): Promise<PayResult> {
    const offers = await solRail.readChallenge(ROUTE_SOL);
    expect(offers).toHaveLength(1);
    return solRail.pay(requestOf(ROUTE_SOL, offers[0]!));
  }

  describe("Arc（Circle の fixture。売り手証明を fixture が検証する）", () => {
    test("402 は Router の候補を通り、購入は paid: 契約の本文、facilitator の verify 1・settle 1、売り手証明の失敗 0、Router は Provider のホストだけに出る", async () => {
      const offers = await arcRail.readChallenge(ROUTE_ARC);
      expect(offers[0]).toMatchObject({ scheme: "exact", network: ARC, asset: ARC_USDC, amount: "10000", payTo: arcPayTo, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } });
      const before = { verify: circle.seen.verifyCalls, settle: circle.seen.settleCalls };
      const result = await buyArc();
      const diag = () => JSON.stringify({ result, verifyCalls: circle.seen.verifyCalls, settleCalls: circle.seen.settleCalls, proofFailures: circle.seen.proofFailures, proxySeen: arcProxy.seen, workerLog: arcWorker.log().split("\n").slice(-12) });
      if (result.outcome !== "paid") process.stdout.write(`AC-P2 arc diag ${diag()}\n`);
      expect(result).toMatchObject({ outcome: "paid", contentType: "application/json" });
      const body = (result as { body: Record<string, unknown> }).body;
      expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
      expect(body).toMatchObject({ providerId: "market-data-a", payment: { protocol: "x402", network: ARC }, data: { markPx: "2572.5", change24h: { absolute: "-121.1", percent: "-4.49" }, assetIndex: 1 } });
      expect((result as { txRef?: string }).txRef).toMatch(/^0x[0-9a-f]{64}$/);
      expect(circle.seen.verifyCalls - before.verify).toBe(1);
      expect(circle.seen.settleCalls - before.settle).toBe(1);
      expect(circle.seen.proofFailures).toEqual([]);
      expect(circle.seen.lastPayload).toMatchObject({ payload: { authorization: { from: arcPayer } } });
      // Worker の 200 の wire（front が見た応答ヘッダ）: content-type は固定。長さの表し方（content-length か chunked）は
      // wrangler dev の proxy が決めるので記録だけ（本番の edge の挙動は AC-P3 で見る。Router は本文を上限つきで読むので依存しない）。
      const paid = arcFront.responses.at(-1)!;
      expect(paid["content-type"]).toBe("application/json");
      expect(paid["cache-control"]).toBe("no-store");
      expect(paid["payment-response"]).toBeDefined();
      process.stdout.write(`AC-P2 arc 200 wire: content-length=${String(paid["content-length"])} transfer-encoding=${String(paid["transfer-encoding"])}\n`);
    }, 60_000);

    test("settle の結果の表の各行 → Router は unknown、settle は各 1 回（pending・失敗・403・500・形違い・切断・network 違い・64 KiB 超）", async () => {
      const rows = [
        ["pending", "settlement_pending"],
        ["reject", "settle_failed"],
        ["registration-required", "facilitator_registration_required"],
        ["unknown", "facilitator_unavailable"],
        ["malformed", "facilitator_unavailable"],
        ["drop", "facilitator_unavailable"],
        ["bad-network", "receipt_malformed"],
        ["huge-chunked", "facilitator_unavailable"],
      ] as const;
      for (const [mode] of rows) {
        circle.state.settle = mode;
        const settles = circle.seen.settleCalls;
        const result = await buyArc();
        expect(result.outcome, mode).toBe("unknown");
        expect(circle.seen.settleCalls - settles, mode).toBe(1);
      }
      circle.state.settle = "ok";
      expect(circle.seen.proofFailures).toEqual([]);
    }, 120_000);

    test("verify が不正 → Worker は 402 → Router は rejected（settle 0）", async () => {
      circle.state.verify = "invalid";
      const settles = circle.seen.settleCalls;
      const result = await buyArc();
      circle.state.verify = "ok";
      expect(result.outcome).toBe("rejected");
      expect(circle.seen.settleCalls - settles).toBe(0);
    }, 60_000);
  });

  describe("Solana（x402.org 相当の fixture: 本物の @x402/svm の verify、feePayer は fixture）", () => {
    test("402 の feePayer は fixture の /supported から。購入は paid: 契約の本文、settle 1、領収の payer は Router の署名者", async () => {
      const offers = await solRail.readChallenge(ROUTE_SOL);
      expect(offers[0]).toMatchObject({ scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: solProviderOwner, extra: { feePayer: svmFac.feePayer } });
      const before = svmFac.seen.settleCalls;
      const result = await buySol();
      expect(result).toMatchObject({ outcome: "paid", contentType: "application/json" });
      const body = (result as { body: Record<string, unknown> }).body;
      expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
      expect(body).toMatchObject({ providerId: "market-data-a", payment: { protocol: "x402", network: SOL }, data: { markPx: "2572.5" } });
      expect(svmFac.seen.settleCalls - before).toBe(1);
      expect(solProxy.seen.filter((s) => s === "GET /supported")).toHaveLength(1);
    }, 60_000);

    test("settle の行: confirm の timeout（pending）・切断・4xx → Router は unknown、settle は各 1 回", async () => {
      const cases: Array<[string, () => void, () => void]> = [
        ["pending", () => { svmFac.state.confirm = "timeout"; }, () => { svmFac.state.confirm = "ok"; }],
        ["drop", () => { svmFac.state.dropSettle = true; }, () => { svmFac.state.dropSettle = false; }],
        ["4xx", () => { svmFac.state.settleOverride = () => ({ status: 409, body: { error: "conflict" } }); }, () => { svmFac.state.settleOverride = undefined; }],
      ];
      for (const [label, arm, disarm] of cases) {
        arm();
        const before = svmFac.seen.settleCalls;
        let result: PayResult;
        try {
          result = await buySol();
        } finally {
          disarm();
        }
        expect(result.outcome, label).toBe("unknown");
        expect(svmFac.seen.settleCalls - before, label).toBe(1);
      }
    }, 120_000);
  });

  test("記録: Worker の log に鍵・facilitator の URL が無い", () => {
    for (const worker of [arcWorker, solWorker]) {
      const log = worker.log();
      expect(log).not.toMatch(/0x[0-9a-fA-F]{64}/);
      expect(log).not.toContain("SECRET_INTERNAL_DETAIL");
    }
  });
});
