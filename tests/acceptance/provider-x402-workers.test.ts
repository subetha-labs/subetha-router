/**
 * AC-P2（`docs/provider-x402-workers.md` §5）: **本物の Worker**（`providers/x402-workers` を `wrangler dev` = workerd で起動）を Router の fixture の
 * facilitator（`circle-facilitator`・`svm-facilitator`）に向け、Router 自身の送信 adapter（Arc: `createX402Outbound` の組み直しの署名器、
 * Solana: `createX402SvmOutbound`）で買う。成功が `paid`、settle の結果の表の各行が **Worker の 502（固定の本文、領収なし）** と Router の `unknown`、
 * facilitator の settle が **1 回**。
 *
 * **gate**: `PROVIDER_WORKER_AC=1` のときだけ走る（`providers/x402-workers/node_modules` の wrangler が要る。Linux の suite では skip）。
 * 外には出ない: fixture は全部 127.0.0.1。Worker（平文 http）と TLS の fixture の間は、この試験が立てる proxy が結ぶ:
 *   Router ──TLS(arc.provider.test)──▶ front ──http──▶ wrangler dev ──http──▶ proxy ──TLS──▶ Circle fixture
 * wrangler 自身の外向きの通信（telemetry・error report・banner の npm の更新確認）は env で止め、残る更新確認の経路のために npm の registry を閉じた loopback に向ける。
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
import { startCircleFacilitator, type CircleFacilitator, type CircleSettleMode } from "../fixtures/circle-facilitator.js";
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
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

interface Listener {
  readonly port: number;
  close(): Promise<void>;
}

/** front が見た Worker の応答（支払いつきの要求だけ）。 */
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

/** Router（TLS、`arc.provider.test` 等）→ wrangler dev（平文 http）。支払いつきの要求への Worker の応答（状態・ヘッダ・本文）を記録する。 */
async function startTlsFront(tls: TlsMaterial, workerPort: number): Promise<Listener & { readonly paid: WireResponse[] }> {
  const paid: WireResponse[] = [];
  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    const isPaid = request.headers["payment-signature"] !== undefined;
    // `accept-encoding` は渡さない: wrangler dev の proxy が本文を圧縮して返すと、記録した本文がそのままでは読めない（Worker 自身は圧縮しない）。
    const { "accept-encoding": _acceptEncoding, ...forwarded } = request.headers;
    void readAll(request).then((body) => {
      const upstream = http.request({ host: "127.0.0.1", port: workerPort, method: request.method, path: request.url, headers: forwarded }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        if (!isPaid) {
          reply.pipe(response);
          return;
        }
        // Router が先に去っていても（期限で切った）Worker の応答は最後まで読んで記録する。
        const chunks: Buffer[] = [];
        reply.on("data", (c: Buffer) => { chunks.push(c); if (!response.destroyed) response.write(c); });
        reply.on("end", () => { paid.push({ status: reply.statusCode ?? 0, headers: reply.headers, body: Buffer.concat(chunks).toString("utf8") }); if (!response.destroyed) response.end(); });
      });
      upstream.on("error", () => response.destroy());
      response.on("close", () => { /* client が去っても upstream は続ける（Worker の応答を記録するため） */ });
      upstream.end(body);
    });
  });
  return { ...(await listen(server)), paid };
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
  /** 秘密を伏せた log（診断用）。 */
  readonly log: () => string;
  /** **生の** log に文字列が含まれるか（生の log 自体は返さない）。 */
  readonly rawIncludes: (needle: string) => boolean;
  /** 生の log に、渡した秘密のどれかが含まれるか。 */
  readonly rawIncludesSecret: () => boolean;
  stop(): Promise<void>;
}

/**
 * `wrangler dev --env <env>` を自分の process group で起動し、`Ready on` を待つ。鍵は `--env-file` だけ（引数にも log にも出さない）。
 * `stop` は spawn の直後に `closers` へ登録する（起動に失敗しても process group を残さない）。
 */
async function startWorker(env: "arc" | "sol", publicHost: string, vars: Record<string, string>, envFile: string | undefined, secrets: string[], closers: Array<() => Promise<void>>): Promise<Worker> {
  const port = await freePort();
  const inspectorPort = await freePort();
  const deadPort = await freePort(); // 誰も listen していない（接続は拒否される）
  // `--local-upstream` + `--upstream-protocol https`: Worker が見る `request.url` の origin を本番と同じ形（https://<host>）にする。
  // Router は 402 の `resource.url` を canonical URL と完全一致で束縛するので、ここが違えば候補にならない。
  const args = ["dev", "--env", env, "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspectorPort), "--local-upstream", publicHost, "--upstream-protocol", "https", "--show-interactive-dev-session=false", "--log-level", "log"];
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);
  if (envFile !== undefined) args.push("--env-file", envFile);
  // wrangler 自身の外向きの通信を止める: telemetry、error report、banner（通常の経路の npm の更新確認はここから出る）。
  // 警告・エラーの経路に残る更新確認（設定の未知の欄、compatibility date の fallback、起動の失敗）も外に出ないように、
  // npm の registry を**閉じた loopback のポート**に向ける。wrangler の update-check は `registry-url` → `rc("npm")` で registry を引き、
  // `rc` は接頭辞 `npm_` を外した名前を鍵にする（`npm_registry` → `registry`。`npm_config_registry` は `config_registry` になって効かない）。
  // env は `.npmrc` より優先される。
  const childEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false", WRANGLER_HIDE_BANNER: "true", CI: "true", npm_registry: `http://127.0.0.1:${deadPort}/` };
  const child: ChildProcess = spawn(WRANGLER, args, { cwd: PACKAGE_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  let raw = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  child.stdout?.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
  const stop = async (): Promise<void> => {
    // leader が終わっていても process group（workerd 等の子孫）が残りうるので、pid があれば必ず group ごと止める。
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* group が既に無い */ }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* 既に終わっている */ }
  };
  closers.push(stop);
  // 伏せるのは**連結した**文字列に対して（chunk の境目で鍵が割れても伏せ漏れない）。
  const redacted = (): string => secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), raw);
  const started = Date.now();
  while (!raw.includes("Ready on")) {
    if (spawnError !== undefined) throw new Error(`wrangler dev --env ${env} could not be spawned: ${spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`wrangler dev --env ${env} exited before ready:\n${redacted()}`);
    if (Date.now() - started > 90_000) throw new Error(`wrangler dev --env ${env} not ready in 90 s:\n${redacted()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { port, log: redacted, rawIncludes: (needle) => raw.includes(needle), rawIncludesSecret: () => secrets.some((secret) => raw.includes(secret)), stop };
}

const describeAc = ENABLED ? describe : describe.skip;

describeAc("AC-P2: wrangler dev の Worker を Router の送信 adapter で買う（fixture の facilitator）", () => {
  let TLS: TlsMaterial;
  const closers: Array<() => Promise<void>> = [];
  let tmpDir: string | undefined;
  // Arc
  let circle: CircleFacilitator;
  let arcWorker: Worker;
  let arcFront: Awaited<ReturnType<typeof startTlsFront>>;
  let arcRail: OutboundRail;
  let arcPayer: `0x${string}`;
  let arcPayTo: `0x${string}`;
  let arcProxy: Awaited<ReturnType<typeof startHttpToTlsProxy>>;
  // Solana
  let svmFac: SvmFacilitator;
  let rpc: SolanaRpcFixture;
  let solWorker: Worker;
  let solFront: Awaited<ReturnType<typeof startTlsFront>>;
  let solRail: X402SvmOutbound;
  let solProviderOwner: string;
  let solProxy: Awaited<ReturnType<typeof startHttpToTlsProxy>>;
  let hyperliquid: Awaited<ReturnType<typeof startHyperliquidStub>>;

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
    arcWorker = await startWorker("arc", ARC_HOST, { FACILITATOR_URL: `http://127.0.0.1:${arcProxy.port}`, PAY_TO: arcPayTo, DATA_URL: `http://127.0.0.1:${hyperliquid.port}/info` }, envFile, [sellerKey, sellerKey.slice(2)], closers);
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
    solWorker = await startWorker("sol", SOL_HOST, { FACILITATOR_URL: `http://127.0.0.1:${solProxy.port}`, PAY_TO: solProviderOwner, DATA_URL: `http://127.0.0.1:${hyperliquid.port}/info` }, undefined, [], closers);
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
    // 1 つの closer が失敗しても残りを閉じ、鍵の一時ファイルは必ず消す。
    const failures: unknown[] = [];
    try {
      while (closers.length > 0) {
        try {
          await closers.pop()!();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
      TLS?.cleanup();
    }
    if (failures.length > 0) throw new Error(`teardown: ${failures.length} closer(s) failed`);
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

  /** 契約の本文（`docs/t5-design.md` §1.5 + `payment.network` の拡張）を入れ子まで検査する。 */
  function expectContractBody(body: Record<string, unknown>, network: string): void {
    expect(Object.keys(body).sort()).toEqual(CONTRACT_KEYS);
    expect(body["providerId"]).toBe("market-data-a");
    expect(body["market"]).toEqual({ kind: "perpetual", symbol: "ETH", quote: "USD" });
    expect(body["dataSource"]).toEqual({ name: "hyperliquid", network: "hyperliquid-mainnet" });
    expect(body["payment"]).toEqual({ protocol: "x402", network });
    expect(body["fetchedAt"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const data = body["data"] as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["assetIndex", "change24h", "dayNtlVlm", "markPx", "prevDayPx"]);
    expect(data).toMatchObject({ markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00", assetIndex: 1 });
    expect(data["change24h"]).toEqual({ absolute: "-121.1", percent: "-4.49" });
    for (const v of [data["markPx"], data["prevDayPx"], data["dayNtlVlm"]]) expect(v).toMatch(DECIMAL);
  }

  /** Worker の失敗の応答（front の記録）: 502、固定の本文、領収なし、facilitator の文言なし。 */
  function expectWorker502(wire: WireResponse, error: string, label: string): void {
    expect(wire.status, label).toBe(502);
    expect(JSON.parse(wire.body), label).toEqual({ error });
    expect(wire.headers["payment-response"], label).toBeUndefined();
    expect(wire.headers["content-type"], label).toBe("application/json");
    expect(wire.body, label).not.toContain("SECRET_INTERNAL_DETAIL");
  }

  describe("Arc（Circle の fixture。売り手証明を fixture が検証する）", () => {
    test("402 は Router の候補を通り、購入は paid: 契約の本文、facilitator の verify 1・settle 1、売り手証明の失敗 0、領収の payer は Router の署名者", async () => {
      const offers = await arcRail.readChallenge(ROUTE_ARC);
      expect(offers[0]).toMatchObject({ scheme: "exact", network: ARC, asset: ARC_USDC, amount: "10000", payTo: arcPayTo, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } });
      const before = { verify: circle.seen.verifyCalls, settle: circle.seen.settleCalls, paid: arcFront.paid.length };
      const result = await buyArc();
      if (result.outcome !== "paid") process.stdout.write(`AC-P2 arc diag ${JSON.stringify({ result, verifyCalls: circle.seen.verifyCalls, settleCalls: circle.seen.settleCalls, proofFailures: circle.seen.proofFailures, proxySeen: arcProxy.seen, workerLog: arcWorker.log().split("\n").slice(-12) })}\n`);
      expect(result).toMatchObject({ outcome: "paid", contentType: "application/json" });
      expectContractBody((result as { body: Record<string, unknown> }).body, ARC);
      expect((result as { txRef?: string }).txRef).toMatch(/^0x[0-9a-f]{64}$/);
      expect(circle.seen.verifyCalls - before.verify).toBe(1);
      expect(circle.seen.settleCalls - before.settle).toBe(1);
      expect(circle.seen.proofFailures).toEqual([]);
      expect(circle.seen.lastPayload).toMatchObject({ payload: { authorization: { from: arcPayer } } });
      // Worker の 200 の wire（front が見た応答）: 200、content-type、no-store、PAYMENT-RESPONSE、本文は契約そのもの。
      // 長さの表し方（content-length か chunked）は wrangler dev の proxy が決めるので記録だけ（本番の edge は AC-P3/AC-P4。Router は本文を上限つきで読む）。
      expect(arcFront.paid.length - before.paid).toBe(1);
      const wire = arcFront.paid.at(-1)!;
      expect(wire.status).toBe(200);
      expect(wire.headers["content-type"]).toBe("application/json");
      expect(wire.headers["cache-control"]).toBe("no-store");
      expect(wire.headers["payment-response"]).toBeDefined();
      expectContractBody(JSON.parse(wire.body) as Record<string, unknown>, ARC);
      process.stdout.write(`AC-P2 arc 200 wire: content-length=${String(wire.headers["content-length"])} transfer-encoding=${String(wire.headers["transfer-encoding"])}\n`);
    }, 60_000);

    test("settle の結果の表の各行 → Worker は 502（固定の本文、領収なし）、Router は unknown、settle は各 1 回（pending・失敗・403・500・形違い・切断・network 違い・別 payer・64 KiB 超）", async () => {
      const rows: ReadonlyArray<readonly [CircleSettleMode, string]> = [
        ["pending", "settlement_pending"],
        ["reject", "settle_failed"],
        ["registration-required", "facilitator_registration_required"],
        ["unknown", "facilitator_unavailable"],
        ["malformed", "facilitator_unavailable"],
        ["drop", "facilitator_unavailable"],
        ["bad-network", "receipt_malformed"],
        ["wrong-payer", "receipt_malformed"],
        ["huge-chunked", "facilitator_unavailable"],
      ];
      try {
        for (const [mode, error] of rows) {
          circle.state.settle = mode;
          const settles = circle.seen.settleCalls;
          const paid = arcFront.paid.length;
          const result = await buyArc();
          expect(result.outcome, mode).toBe("unknown");
          expect(circle.seen.settleCalls - settles, mode).toBe(1);
          expect(arcFront.paid.length - paid, mode).toBe(1);
          expectWorker502(arcFront.paid.at(-1)!, error, mode);
        }
      } finally {
        circle.state.settle = "ok";
      }
      expect(circle.seen.proofFailures).toEqual([]);
    }, 120_000);

    test("settle の HTTP の期限（facilitator が 25 秒黙る）: Worker は段の上限（20 秒）で 502 facilitator_unavailable、settle 1 回。Router の静的 EVM 経路は 5 秒で unknown（§9 の 6: 本番の不整合、Router 側の follow-up）", async () => {
      circle.state.settleDelayMs = 25_000;
      const settles = circle.seen.settleCalls;
      const paid = arcFront.paid.length;
      const started = Date.now();
      let result: PayResult;
      try {
        result = await buyArc();
        const routerElapsed = Date.now() - started;
        // Router の静的 EVM の x402 送信は有料要求に 5 秒の期限（`createX402Outbound` の `timeoutMs` の既定）: Worker の settle が続いていても unknown。
        expect(result.outcome).toBe("unknown");
        expect(routerElapsed).toBeGreaterThanOrEqual(4_500);
        expect(routerElapsed).toBeLessThan(19_000);
        // Worker 側: Router が去った後も要求は段の上限まで続き、20 秒で 502（front が記録する）。facilitator の settle は 1 回のまま。
        while (arcFront.paid.length === paid && Date.now() - started < 30_000) await new Promise((resolve) => setTimeout(resolve, 250));
      } finally {
        circle.state.settleDelayMs = 0;
      }
      const workerElapsed = Date.now() - started;
      expect(arcFront.paid.length - paid).toBe(1);
      expect(workerElapsed).toBeGreaterThanOrEqual(19_000);
      expect(workerElapsed).toBeLessThan(26_000);
      expect(circle.seen.settleCalls - settles).toBe(1);
      expectWorker502(arcFront.paid.at(-1)!, "facilitator_unavailable", "deadline");
    }, 60_000);

    test("verify が不正 → Worker は 402（固定の本文）→ Router は rejected（settle 0）", async () => {
      circle.state.verify = "invalid";
      const settles = circle.seen.settleCalls;
      const paid = arcFront.paid.length;
      let result: PayResult;
      try {
        result = await buyArc();
      } finally {
        circle.state.verify = "ok";
      }
      expect(result.outcome).toBe("rejected");
      expect(circle.seen.settleCalls - settles).toBe(0);
      expect(arcFront.paid.length - paid).toBe(1);
      const wire = arcFront.paid.at(-1)!;
      expect(wire.status).toBe(402);
      expect(JSON.parse(wire.body)).toEqual({ error: "payment_invalid" });
      expect(wire.headers["payment-required"]).toBeDefined();
      expect(wire.headers["payment-response"]).toBeUndefined();
      expect(wire.body).not.toContain("SECRET_INTERNAL_DETAIL");
    }, 60_000);
  });

  describe("Solana（x402.org 相当の fixture: 本物の @x402/svm の verify、feePayer は fixture）", () => {
    test("402 の feePayer は fixture の /supported から（1 回）。購入は paid: 契約の本文、settle 1、領収の payer は Router の署名者", async () => {
      const offers = await solRail.readChallenge(ROUTE_SOL);
      expect(offers[0]).toMatchObject({ scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: solProviderOwner, extra: { feePayer: svmFac.feePayer } });
      const before = { settle: svmFac.seen.settleCalls, paid: solFront.paid.length };
      const result = await buySol();
      expect(result).toMatchObject({ outcome: "paid", contentType: "application/json" });
      expectContractBody((result as { body: Record<string, unknown> }).body, SOL);
      expect(svmFac.seen.settleCalls - before.settle).toBe(1);
      expect(solProxy.seen.filter((s) => s === "GET /supported")).toHaveLength(1);
      expect(solFront.paid.length - before.paid).toBe(1);
      const wire = solFront.paid.at(-1)!;
      expect(wire.status).toBe(200);
      expect(wire.headers["payment-response"]).toBeDefined();
      expectContractBody(JSON.parse(wire.body) as Record<string, unknown>, SOL);
    }, 60_000);

    test("settle の行: confirm の timeout（pending）・切断・409 → Worker は 502（固定の本文、領収なし）、Router は unknown、settle は各 1 回", async () => {
      const cases: ReadonlyArray<readonly [string, string, () => void, () => void]> = [
        ["pending", "settlement_pending", () => { svmFac.state.confirm = "timeout"; }, () => { svmFac.state.confirm = "ok"; }],
        ["drop", "facilitator_unavailable", () => { svmFac.state.dropSettle = true; }, () => { svmFac.state.dropSettle = false; }],
        ["4xx", "facilitator_unavailable", () => { svmFac.state.settleOverride = () => ({ status: 409, body: { error: "conflict", detail: "SECRET_INTERNAL_DETAIL" } }); }, () => { svmFac.state.settleOverride = undefined; }],
      ];
      for (const [label, error, arm, disarm] of cases) {
        arm();
        const settles = svmFac.seen.settleCalls;
        const paid = solFront.paid.length;
        let result: PayResult;
        try {
          result = await buySol();
        } finally {
          disarm();
        }
        expect(result.outcome, label).toBe("unknown");
        expect(svmFac.seen.settleCalls - settles, label).toBe(1);
        expect(solFront.paid.length - paid, label).toBe(1);
        expectWorker502(solFront.paid.at(-1)!, error, label);
      }
    }, 120_000);
  });

  test("記録: Worker の生の log に鍵・facilitator の文言・更新確認の案内が無い（生の文字列で見る。伏せた後ではない）", () => {
    for (const worker of [arcWorker, solWorker]) {
      expect(worker.rawIncludesSecret()).toBe(false);
      expect(worker.rawIncludes("SECRET_INTERNAL_DETAIL")).toBe(false);
      expect(worker.rawIncludes("newer version")).toBe(false);
      expect(worker.rawIncludes("update available")).toBe(false);
      expect(worker.rawIncludes("wrangler ")).toBe(false); // banner（更新確認を含む）が出ていない
    }
  });
});
