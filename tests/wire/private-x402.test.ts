/**
 * 秘匿購入の wire（設計 `docs/zktls-router-design.md` §11、タスク T-Z7）: lab の**実 `delivery` バイナリ**（TLSNotary MPC-TLS + UltraHonk）、lab の fixture CA、
 * **実 `startRouter`** の Router 子プロセス（`router-private-process.ts`）、EIP-3009 の署名を検証する x402 Provider fixture（`zktls-provider.ts`）、同じく署名を検証する
 * 受信 facilitator fixture。Payer 側（keygen → finalize → session → prove → decrypt）はこのテストプロセスが別プロセスで `delivery` を走らせる。MCP は**実 stdio の子**（`src/mcp/server.ts`）。
 *
 * 資金は動かない。trust は `lab-fixture-ca` → ここで得る証跡は **synthetic**（公開 PKI の受入の代わりにならない）。lab が無ければ skip（= **未検証**。合格ではない）。
 * この Mac では MPC-TLS のセッション 1 本が 10 秒前後、証明の生成・検証も数秒。各テストの上限は余裕をもって長い。
 */
import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DYNAMIC_LIMITS } from "../../src/config.js";
import type { StopPoint } from "../../src/core/private.js";
import { TOOL_NAMES } from "../../src/mcp/tools.js";
import { sha256File, type LaunchHooksForTest } from "../../src/private/verifier.js";
import { payFirstOf, recoverPrivatePayer, runPrivatePayer } from "../../tools/private-payer.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { labPaths, readJson, runDelivery } from "../fixtures/private/lab.js";
import { startZktlsProvider, type ZktlsProvider } from "../fixtures/private/zktls-provider.js";
import { precheckProvider } from "../../tools/private-provider-precheck.js";
import { withProviderFile } from "../../tools/private-payer.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const lab = labPaths();
const repoRoot = path.resolve(import.meta.dirname, "../..");
const runtimeRoot = path.join(repoRoot, "runtime");
const ROUTER_SCRIPT = "tests/fixtures/private/router-private-process.ts";
const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PROVIDER_PAY_TO = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const OPERATOR_PAY_TO = "0x00000000000000000000000000000000000000b0";
const PROFILE_ID = "priv-x402";
const STATIC_ROUTE = "static-x402";
const HOST = "test-server.io";
const POST_PATH = "/select";
const GET_PATH = "/v1/paid-snapshot";
const FACILITATOR_HOST = "facilitator.other.test";
/** v1.3: SubEtha V2（burn-sale）受信の fixture facilitator（`tests/fixtures/facilitator-server.ts --v2 on`）。plain HTTP、dial で loopback へ。 */
const SUBETHA_HOST = "subetha.other.test";
const SUBETHA_PROFILE_ID = "priv-subetha";
const ZUSDC = "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF";
const SEPOLIA = "eip155:11155111";
const PRICE = "10000";
const ALICE = { id: "alice", token: "tok-alice" };
const BOB = { id: "bob", token: "tok-bob" };
/** セッション 1 本 + 証明の生成・検証を含むテストの上限（ms）。 */
const LONG = 1_800_000;

let TLS: TlsMaterial;
let facilitator: VerifyingFacilitator;
let subethaFacilitator: Listening;
let subethaFacilitatorNoEvent: Listening;
let provider: ZktlsProvider;

interface WorldOptions {
  /** v1.3: この world の subetha facilitator（既定は V2 の正常な fixture）。 */
  readonly subethaPort?: number;
  readonly sessionTimeoutMs?: number;
  readonly attestTimeoutMs?: number;
  readonly verifyTimeoutMs?: number;
}
interface World {
  readonly subethaPort: number;
  readonly dir: string;
  readonly privateDir: string;
  readonly control: string;
  readonly journalPath: string;
  readonly configPath: string;
  readonly ledgerDir: string;
  readonly diagnosticsPath: string;
  router: Listening | undefined;
  /** Router 子の各世代の stdout/stderr（kill した世代も含めて canary の走査に使う）。 */
  readonly outputs: string[];
  operatorAddress: string | undefined;
}
const worlds: World[] = [];

/** tool を呼んで構造化された本体を返す。失敗（isError）は本文の文字列ごと投げる（原因を見るため）。 */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`tool ${name} returned non-JSON content (isError=${String(result.isError)}): ${text.slice(0, 2000)}`);
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error(`timeout: ${what}`);
    await sleep(50);
  }
}
function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** 命令行に `fragment` を含むプロセスの pid（無ければ空）。 */
function pidsMatching(fragment: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", fragment], { encoding: "utf8" }).split("\n").filter((line) => line !== "").map(Number);
  } catch {
    return [];
  }
}
function readDirFiles(dir: string, into = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return into;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) readDirFiles(file, into);
    else into.set(file, readFileSync(file, "latin1"));
  }
  return into;
}

function configDocument(world: World, options: WorldOptions): unknown {
  const attestTimeoutMs = options.attestTimeoutMs ?? 1_800_000;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 600_000;
  return {
    router: {
      approvalTtlMs: 120_000,
      routes: {
        [STATIC_ROUTE]: {
          routeId: STATIC_ROUTE,
          canonicalPath: `/v1/routes/${STATIC_ROUTE}/resource`,
          rail: "x402",
          sourceRail: "x402",
          source: { amount: PRICE, asset: USDC, decimals: 6, network: NETWORK, payTo: OPERATOR_PAY_TO },
          destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" },
        },
      },
      budget: { maxPurchases: 50, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "100000000", maxPerPurchase: "200000" }] },
      dynamic: {
        enabled: true,
        profiles: {
          [PROFILE_ID]: {
            profileId: PROFILE_ID,
            sourceRail: "x402",
            source: { network: NETWORK, asset: USDC, decimals: 6, payTo: OPERATOR_PAY_TO },
            rail: "x402",
            destination: { scheme: "exact", network: NETWORK, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
            par: true,
            maxUpstreamAmount: "100000",
            fee: { flat: "1000", bps: 0, min: "1000" },
          },
          // v1.3: 受信 SubEtha V2（burn-sale、Sepolia zUSDC）→ 送信 x402 Base Sepolia USDC。秘匿購入だけ（private.profiles）。
          [SUBETHA_PROFILE_ID]: {
            profileId: SUBETHA_PROFILE_ID,
            sourceRail: "subetha",
            source: { network: SEPOLIA, asset: ZUSDC, decimals: 6, payTo: OPERATOR_PAY_TO },
            rail: "x402",
            destination: { scheme: "exact", network: NETWORK, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
            par: true,
            maxUpstreamAmount: "100000",
            fee: { flat: "1000", bps: 0, min: "1000" },
          },
        },
        budget: { maxPurchases: 50, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "100000000", maxPerPurchase: "200000" }, { network: SEPOLIA, asset: ZUSDC, maxTotal: "100000000", maxPerPurchase: "200000" }] },
        limits: { ...DEFAULT_DYNAMIC_LIMITS, quotesPerMinuteGlobal: 1000, quotesPerMinutePerSource: 1000, purchasesPerMinuteGlobal: 1000, purchasesPerMinutePerSource: 1000, perHostPerMinute: 1000, perAddressPerMinute: 1000 },
        denyHosts: [],
      },
      private: {
        deliveryBin: lab.bin,
        deliveryBinSha256: lab.available ? sha256File(lab.bin) : "0".repeat(64),
        srsPath: lab.srs,
        srsSha256: lab.available ? sha256File(lab.srs) : "0".repeat(64),
        profiles: [PROFILE_ID, SUBETHA_PROFILE_ID],
        workDir: world.privateDir,
        sessionTimeoutMs: options.sessionTimeoutMs ?? 600_000,
        attestTimeoutMs,
        verifyTimeoutMs,
        retentionMs: Math.max(3_600_000, attestTimeoutMs + verifyTimeoutMs),
      },
    },
    x402: { upstreams: { [STATIC_ROUTE]: "https://static.provider.test/v1/small" } },
  };
}

function newWorld(options: WorldOptions = {}): World {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "private-x402-"));
  const world: World = { dir, privateDir: path.join(dir, "private"), control: path.join(dir, "control"), journalPath: path.join(dir, "journal.ndjson"), configPath: path.join(dir, "router.config.json"), ledgerDir: path.join(dir, "dynamic-quotes"), diagnosticsPath: path.join(dir, "diagnostics.ndjson"), router: undefined, outputs: [], operatorAddress: undefined, subethaPort: options.subethaPort ?? subethaFacilitator.port };
  mkdirSync(world.control, { recursive: true });
  writeFileSync(world.configPath, JSON.stringify(configDocument(world, options)));
  worlds.push(world);
  return world;
}

interface StartOptions {
  readonly stops?: readonly StopPoint[];
  readonly launch?: LaunchHooksForTest;
}
function routerArgs(world: World): string[] {
  return ["--control", world.control, "--dial", `${HOST}=${provider.port},${FACILITATOR_HOST}=${facilitator.port},${SUBETHA_HOST}=${world.subethaPort}`, "--ca", lab.rootCa, "--ca", path.join(TLS.dir, "ca.pem"), "--diagnostics", world.diagnosticsPath];
}
function routerEnv(world: World): Record<string, string> {
  return {
    ROUTER_CONFIG_PATH: world.configPath,
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token},${BOB.id}:${BOB.token}`,
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: `http://${SUBETHA_HOST}`,
    ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${FACILITATOR_HOST}`,
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: world.journalPath,
    ROUTER_HTTP_HOST: "127.0.0.1",
    ROUTER_HTTP_PORT: "0",
  };
}
function writeControl(world: World, options: StartOptions): void {
  for (const name of readdirSync(world.control)) {
    if (name.startsWith("arrive.") || name.startsWith("release.") || name === "stops.json" || name === "launch.json") unlinkSync(path.join(world.control, name));
  }
  if (options.stops !== undefined) writeFileSync(path.join(world.control, "stops.json"), JSON.stringify({ points: options.stops }));
  if (options.launch !== undefined) writeFileSync(path.join(world.control, "launch.json"), JSON.stringify(options.launch));
}
/** 制御ファイルを書き替えてから Router 子を起動し、listening を待つ（`stops`/`launch` が無ければ既定の動き）。 */
async function startRouter(world: World, options: StartOptions = {}): Promise<Listening> {
  writeControl(world, options);
  const router = await startListening(ROUTER_SCRIPT, routerArgs(world), routerEnv(world), { listenTimeoutMs: 120_000 });
  world.router = router;
  const operator = router.stdout().split("\n").map((line) => {
    try {
      return JSON.parse(line) as { event?: string; address?: string };
    } catch {
      return {};
    }
  }).find((line) => line.event === "operator");
  world.operatorAddress = operator?.address;
  return router;
}
/** listening を待たずに起動する（再構成の途中で止めて殺す試験用）。終了時に出力を world に残す。 */
function spawnRouterRaw(world: World, options: StartOptions): ChildProcessByStdio<null, Readable, Readable> {
  writeControl(world, options);
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  const child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, ROUTER_SCRIPT), ...routerArgs(world)], { cwd: repoRoot, env: { ...base, ...routerEnv(world) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (out += chunk));
  child.stderr.on("data", (chunk: string) => (out += chunk));
  child.once("close", () => world.outputs.push(out));
  return child;
}
async function stopRouter(world: World): Promise<void> {
  const router = world.router;
  if (router === undefined) return;
  await router.stop();
  world.outputs.push(router.stdout(), router.stderr());
  world.router = undefined;
}
async function killRouter(world: World): Promise<void> {
  const router = world.router;
  if (router === undefined) return;
  await router.kill("SIGKILL");
  world.outputs.push(router.stdout(), router.stderr());
  world.router = undefined;
}

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}
async function http(world: World, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, principal = ALICE): Promise<HttpResult> {
  const response = await fetch(`${world.router!.baseUrl}${pathname}`, { method, headers: { "x-router-principal": principal.id, authorization: `Bearer ${principal.token}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>), text };
}
function ownerHeaders(ownerKey: unknown): Record<string, string> {
  return { "x-router-owner-key": String(ownerKey) };
}
async function statusOf(world: World, paymentId: string, ownerKey: unknown): Promise<HttpResult> {
  return http(world, "GET", `/v1/purchases/${paymentId}`, undefined, ownerHeaders(ownerKey));
}

// ---------------------------------------------------------------- Payer 側（別プロセスの `delivery`）
interface PayerDirs {
  readonly root: string;
  readonly keys: string;
  readonly exec: string;
  readonly privateInbox: string;
}
interface Keygen {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly orderId: string;
  readonly order: Record<string, unknown>;
  /** POST の承認済み本文（GET は空文字）。 */
  readonly bodyText: string;
  readonly canary: string;
  readonly saltHex: string;
  readonly secretSk: string;
}
function payerDirs(world: World, tag: string): PayerDirs {
  const root = path.join(world.dir, `payer-${tag}`);
  const dirs = { root, keys: path.join(root, "keys"), exec: path.join(root, "executor"), privateInbox: path.join(root, "executor", "private_inbox") };
  mkdirSync(dirs.privateInbox, { recursive: true, mode: 0o700 });
  return dirs;
}
async function keygen(dirs: PayerDirs, method: "GET" | "POST" = "POST"): Promise<Keygen> {
  const orderId = `${"0".repeat(32)}${randomBytes(16).toString("hex")}`;
  const canary = `canary-${randomBytes(12).toString("hex")}`;
  const pathname = method === "POST" ? POST_PATH : GET_PATH;
  const args = ["payer-keygen", "--payer-dir", dirs.keys, "--order-id", orderId, "--host", HOST, "--port", "443", "--path", pathname];
  let bodyText = "";
  if (method === "POST") {
    bodyText = JSON.stringify({ schema: "lab.select.v1", model: "lab-echo", prompt: canary });
    const bodyFile = path.join(dirs.root, "approved_body.json");
    writeFileSync(bodyFile, bodyText, { mode: 0o600 });
    args.push("--post-profile", "canonical", "--body-file", bodyFile);
  } else {
    args.push("--method", "GET");
  }
  const run = await runDelivery(lab, args);
  if (run.code !== 0) throw new Error(`payer-keygen failed: ${run.stderr}`);
  const order = readJson(path.join(dirs.keys, "order.json")) as Record<string, unknown>;
  const saltHex = method === "POST" ? (readJson(path.join(dirs.keys, "request_private.json")) as { salt_hex: string }).salt_hex : `no-salt-${canary}`;
  const secret = readJson(path.join(dirs.keys, "secret.json")) as { sk: string };
  return { method, path: pathname, orderId, order, bodyText, canary, saltHex, secretSk: secret.sk };
}
function envelopeOf(order: Record<string, unknown>, overrides: { outbound?: Record<string, unknown>; inbound?: Record<string, unknown> } = {}): { bytes: Buffer; b64: string; sha: string } {
  const doc = { version: "phase5-intent-v1", order, outbound: { protocol: "x402", network: NETWORK, asset: USDC, payTo: PROVIDER_PAY_TO, maxAmount: PRICE, ...overrides.outbound }, inbound: { network: NETWORK, asset: USDC, maxTotal: "11000", ...overrides.inbound } };
  const bytes = Buffer.from(JSON.stringify(doc), "utf8");
  return { bytes, b64: bytes.toString("base64"), sha: sha256Hex(bytes) };
}
async function credentialFor(offer: Record<string, unknown>): Promise<{ credential: string; signature: string }> {
  const credential = await createX402Payer(generatePrivateKey()).credentialFor(offer as never, 84532);
  const decoded = JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as { payload: { signature: string } };
  return { credential, signature: decoded.payload.signature };
}
interface Handover {
  paymentId: string;
  status: string;
  verifier: { address: string };
  releasedHeader: { name: string; value: string };
  headerFile: Record<string, unknown>;
  releaseB64: string;
  deadlines: { credentialExpiresAt: number; sessionBy: number };
}
interface PayerFiles {
  readonly orderFinal: string;
  readonly intent: string;
  readonly release: string;
}
/** finalize（Payer）: 封筒 + Router の headerFile → order_final.json。intent/release も Payer の手元に置く。 */
async function finalize(dirs: PayerDirs, handover: Handover, intentBytes: Buffer): Promise<PayerFiles> {
  const intent = path.join(dirs.root, "intent.json");
  const release = path.join(dirs.root, "release.json");
  const headerFile = path.join(dirs.root, "payment_header.json");
  const orderFinal = path.join(dirs.root, "order_final.json");
  writeFileSync(intent, intentBytes, { mode: 0o600 });
  writeFileSync(release, Buffer.from(handover.releaseB64, "base64"), { mode: 0o600 });
  writeFileSync(headerFile, JSON.stringify(handover.headerFile), { mode: 0o600 });
  const run = await runDelivery(lab, ["payer-finalize-order", "--intent", intent, "--payment-header-file", headerFile, "--out", orderFinal]);
  if (run.code !== 0) throw new Error(`payer-finalize-order failed: ${run.stderr}`);
  return { orderFinal, intent, release };
}
/** executor（Payer 側）: 実 MPC-TLS セッション（Router が起動した Verifier へ loopback、Provider fixture へ `--connect`）。 */
async function session(dirs: PayerDirs, kg: Keygen, orderFinal: string, verifierAddress: string): Promise<{ code: number | null; stderr: string }> {
  const args = ["executor-session", "--executor-dir", dirs.exec, "--order", orderFinal, "--verifier-addr", verifierAddress, "--host", HOST, "--port", "443", "--path", kg.path, "--trust", "lab-fixture-ca", "--timeout-secs", "600", "--connect", `127.0.0.1:${provider.port}`];
  if (kg.method === "POST") {
    const requestPrivate = path.join(dirs.privateInbox, "request_private.json");
    copyFileSync(path.join(dirs.keys, "request_private.json"), requestPrivate);
    args.push("--request-private", requestPrivate);
  }
  return runDelivery(lab, args, { timeoutMs: 700_000 });
}
async function prove(dirs: PayerDirs, kg: Keygen, orderFinal: string): Promise<Buffer> {
  const args = ["executor-prove", "--executor-dir", dirs.exec, "--order", orderFinal];
  if (kg.method === "POST") args.push("--request-private", path.join(dirs.privateInbox, "request_private.json"));
  const run = await runDelivery(lab, args, { timeoutMs: 900_000 });
  if (run.code !== 0) throw new Error(`executor-prove failed: ${run.stderr.slice(-2000)}`);
  return readFileSync(path.join(dirs.exec, "bundle.json"));
}
async function decrypt(dirs: PayerDirs, kg: Keygen, files: PayerFiles, recordB64: string, bundle: Buffer, resultName = "decrypt"): Promise<{ code: number | null; result: Record<string, unknown> | undefined; plaintext: Buffer | undefined }> {
  const record = path.join(dirs.root, `record-${resultName}.json`);
  const bundleFile = path.join(dirs.root, `bundle-${resultName}.json`);
  writeFileSync(record, Buffer.from(recordB64, "base64"), { mode: 0o600 });
  writeFileSync(bundleFile, bundle, { mode: 0o600 });
  const run = await runDelivery(lab, ["payer-decrypt", "--payer-dir", dirs.keys, "--order", files.orderFinal, "--record", record, "--bundle", bundleFile, "--expect-host", HOST, "--expect-port", "443", "--expect-path", kg.path, "--intent", files.intent, "--release", files.release, "--result-name", resultName], { timeoutMs: 600_000 });
  const resultFile = path.join(dirs.keys, `${resultName}_result.json`);
  const plaintextFile = path.join(dirs.keys, `${resultName}.bin`);
  return { code: run.code, result: existsSync(resultFile) ? (readJson(resultFile) as Record<string, unknown>) : undefined, plaintext: existsSync(plaintextFile) ? readFileSync(plaintextFile) : undefined };
}
/** Payer の executor が持つ秘密（鍵・salt・blinder・eph 鍵）の 64 hex。公開の注文・bundle に現れる値は除く（canary の対象）。 */
function executorSecrets(dirs: PayerDirs, kg: Keygen, bundle?: Buffer): string[] {
  const publicText = `${JSON.stringify(kg.order)}\n${bundle?.toString("utf8") ?? ""}`;
  const publicTokens = new Set(publicText.match(/[0-9a-f]{64}/g) ?? []);
  const secrets = new Set<string>([kg.secretSk]);
  const files = readDirFiles(path.join(dirs.exec, "private"));
  readDirFiles(dirs.keys, files);
  for (const [file, text] of files) {
    if (path.basename(file) === "order.json" || path.basename(file).startsWith("decrypt")) continue;
    for (const token of text.match(/[0-9a-f]{64}/g) ?? []) if (!publicTokens.has(token)) secrets.add(token);
  }
  if (kg.method === "POST") secrets.add(kg.saltHex);
  return [...secrets];
}

/** quote → purchase（HTTP）。 */
async function quoteAndPurchase(world: World, env: { b64: string }, requestId: string): Promise<{ quote: Record<string, unknown>; purchase: HttpResult; credential: string; inboundSignature: string }> {
  const quoted = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId, intentB64: env.b64 });
  if (quoted.status !== 200) throw new Error(`quote failed: ${quoted.text}`);
  const offer = (quoted.body["source"] as { offer: Record<string, unknown> }).offer;
  const { credential, signature } = await credentialFor(offer);
  const purchase = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId, approval: quoted.body["quoteId"], credential, ownerKey: quoted.body["ownerKey"] });
  return { quote: quoted.body, purchase, credential, inboundSignature: signature };
}
/** purchase の後、Payer 側の工程を最後まで（finalize → session → prove）。Router は `attesting` になる。 */
async function completeSession(world: World, dirs: PayerDirs, kg: Keygen, handover: Handover, intentBytes: Buffer, ownerKey: unknown): Promise<{ files: PayerFiles; bundle: Buffer }> {
  const files = await finalize(dirs, handover, intentBytes);
  const ran = await session(dirs, kg, files.orderFinal, handover.verifier.address);
  if (ran.code !== 0) throw new Error(`executor-session failed: ${ran.stderr.slice(-2000)}`);
  await waitFor(async () => (await statusOf(world, handover.paymentId, ownerKey)).body["status"] === "attesting", 120_000, "attesting after the session");
  const bundle = await prove(dirs, kg, files.orderFinal);
  return { files, bundle };
}
function tamperedProof(bundle: Buffer): Buffer {
  const parsed = JSON.parse(bundle.toString("utf8")) as { proof_hex: string };
  const hex = parsed.proof_hex;
  const index = Math.floor(hex.length / 2);
  parsed.proof_hex = `${hex.slice(0, index)}${hex[index] === "0" ? "1" : "0"}${hex.slice(index + 1)}`;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}
function foreignBundleFor(kg: Keygen): Buffer {
  const request = kg.order["request"] as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ public: { order_id: `${"0".repeat(32)}${"f".repeat(32)}`, payer_pk: kg.order["payer_pk"], committed_hash_hex: "b".repeat(64), payload_len: 196 }, proof_hex: "00", request: { public: { tls_body_hash_hex: "d".repeat(64), tls_cred_hash_hex: "c".repeat(64), payer_commitment_hex: request["body_commitment_hex"], body_len: request["body_len"], cred_len: 39 }, proof_hex: "00" } }));
}

// ---------------------------------------------------------------- canary（tasks §canary の行列）
/** 符号化（base64 / base64url）の容れ物を解いた見え方を足す。 */
function decodedView(text: string): string {
  const out: string[] = [];
  for (const token of text.match(/[A-Za-z0-9+/=_-]{40,}/g) ?? []) {
    try {
      out.push(Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1"));
    } catch {
      // 符号化でない。
    }
  }
  return out.join("\n");
}
function withDecoded(text: string): string {
  return `${text}\n${decodedView(text)}`;
}
/** Router の成果物の文字列: journal・quote の控え・子の出力（全世代）・診断・作業ディレクトリの全ファイル。 */
function routerTexts(world: World): { journal: string; ledger: string; outputs: string; diagnostics: string; work: Map<string, string> } {
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, "latin1") : "");
  const live = world.router === undefined ? "" : `${world.router.stdout()}\n${world.router.stderr()}`;
  return { journal: read(world.journalPath), ledger: [...readDirFiles(world.ledgerDir).values()].join("\n"), outputs: `${world.outputs.join("\n")}\n${live}`, diagnostics: read(world.diagnosticsPath), work: readDirFiles(world.privateDir) };
}
interface Surfaces {
  /** 公開の射影・応答（quote・status・attest・MCP の出力）。bearer・平文のどちらも無い。 */
  readonly public: string;
  /** 認証済みの引き渡し・record の応答。bearer は許されるが平文・秘密は無い。 */
  readonly authenticated?: string;
  /** 掃除の前に写した作業ディレクトリ（子の出力を含む）。 */
  readonly snapshot?: Map<string, string>;
}
const BEARER_ALLOWED = new Set(["order_final.json", "record.json"]);
/**
 * `everywhere`（平文・salt・鍵・隠し穴・復号結果）はどこにも無い（符号化を解いても）。`bearer`（送信 credential）は journal・控え・出力・診断・公開の応答に無く、
 * 作業ディレクトリでは `order_final.json`・`record.json` にだけ。`intentB64`（封筒）は公開の応答・診断・出力に無い（権威の保管 = journal・控え・intent.json は許す）。
 */
function expectCanaries(world: World, surfaces: Surfaces, everywhere: readonly string[], bearer: readonly string[], intentB64?: string): void {
  const texts = routerTexts(world);
  const routerSide = withDecoded(`${texts.journal}\n${texts.ledger}\n${texts.outputs}\n${texts.diagnostics}\n${surfaces.public}\n${surfaces.authenticated ?? ""}`);
  const files = new Map<string, string>([...texts.work, ...(surfaces.snapshot ?? new Map())]);
  for (const value of everywhere) {
    expect(routerSide, `plaintext/secret canary in Router artifacts: ${value.slice(0, 16)}…`).not.toContain(value);
    for (const [file, text] of files) expect(withDecoded(text), `plaintext/secret canary in ${file}`).not.toContain(value);
  }
  const bearerForbidden = withDecoded(`${texts.journal}\n${texts.ledger}\n${texts.outputs}\n${texts.diagnostics}\n${surfaces.public}`);
  for (const value of bearer) {
    expect(bearerForbidden, "bearer in journal/ledger/child output/diagnostics/public responses").not.toContain(value);
    for (const [file, text] of files) {
      if (BEARER_ALLOWED.has(path.basename(file))) continue;
      expect(withDecoded(text), `bearer in ${file}`).not.toContain(value);
    }
  }
  if (intentB64 !== undefined) {
    expect(`${texts.outputs}\n${texts.diagnostics}\n${surfaces.public}`).not.toContain(intentB64);
    for (const [file, text] of files) if (path.basename(file) !== "intent.json") expect(text, `intent bytes in ${file}`).not.toContain(intentB64);
  }
}

describe.skipIf(!lab.available)(`秘匿購入 wire: lab 実バイナリ × x402 Provider fixture（synthetic; ${lab.reason ?? "lab present"}）`, () => {
  beforeAll(async () => {
    TLS = generateTestTls();
    facilitator = await startVerifyingFacilitator({ tls: TLS });
    subethaFacilitator = await startListening("tests/fixtures/facilitator-server.ts", ["--port", "0", "--token", ZUSDC, "--pay-to", OPERATOR_PAY_TO, "--chain-id", "11155111", "--v2", "on"]);
    subethaFacilitatorNoEvent = await startListening("tests/fixtures/facilitator-server.ts", ["--port", "0", "--token", ZUSDC, "--pay-to", OPERATOR_PAY_TO, "--chain-id", "11155111", "--v2", "on", "--v2-event", "none"]);
    provider = await startZktlsProvider({ certPath: lab.serverCert, keyPath: lab.serverKey, host: HOST, network: NETWORK, asset: USDC, payTo: PROVIDER_PAY_TO, amount: PRICE, tokenDomain: { name: "USDC", version: "2" } });
  }, 120_000);
  afterAll(async () => {
    await provider?.close();
    await facilitator?.close();
    await subethaFacilitator?.stop();
    await subethaFacilitatorNoEvent?.stop();
    TLS?.cleanup();
  });
  afterEach(async () => {
    while (worlds.length > 0) {
      const world = worlds.pop()!;
      await stopRouter(world);
      // 鍵・平文・record を runtime に残さない。
      rmSync(world.dir, { recursive: true, force: true });
    }
    provider.seen.probes.length = 0;
    provider.seen.paid.length = 0;
    provider.seen.rejected.length = 0;
    provider.seen.responses.length = 0;
    provider.receiptExtra = undefined;
  });

  test("HTTP 全経路（POST）: quote → purchase → finalize → session → prove → attest → record ×2 → decrypt → 平文 → status。掃除前の成果物まで canary、mode、領収の反射値は digest だけ", async () => {
    const world = newWorld();
    // 掃除の前（結果の永続化の直前）で止めて作業ディレクトリを写す。
    await startRouter(world, { stops: ["beforeResultPersist"] });
    const dirs = payerDirs(world, "http");
    const kg = await keygen(dirs);
    const env = envelopeOf(kg.order);
    const reflected = `reflected-${randomBytes(8).toString("hex")}`;
    provider.receiptExtra = { note: reflected };
    const probesBefore = provider.seen.probes.length;
    const { quote, purchase, inboundSignature } = await quoteAndPurchase(world, env, "r-http");
    // 探り: quote と、決済前・発行前の再照合の 3 回。Router は本文 `{}` で 402 を読んだだけ（Payer の本文は Router に渡っていない）。
    expect(provider.seen.probes.slice(probesBefore).map((probe) => probe.body)).toEqual(["{}", "{}", "{}"]);
    expect(quote["private"]).toMatchObject({ intentSha256: env.sha, method: "POST", framing: "phase5-post-json-canonical-v1", target: { host: HOST, port: 443, path: POST_PATH }, body: { len: Buffer.byteLength(kg.bodyText), commitmentHex: (kg.order["request"] as Record<string, unknown>)["body_commitment_hex"] } });
    expect(purchase.status, `${purchase.text}\n${world.router!.stderr().slice(-3000)}`).toBe(200);
    const handover = purchase.body as unknown as Handover;
    expect(handover).toMatchObject({ paymentId: quote["paymentId"], status: "awaiting_session", releasedHeader: { name: "PAYMENT-SIGNATURE" }, headerFile: { order_id: kg.orderId, intent_sha256: env.sha, name: "PAYMENT-SIGNATURE" } });
    expect(handover.verifier.address).toMatch(/^127\.0\.0\.1:[0-9]+$/);
    expect(handover.releasedHeader.value).toBe(handover.headerFile["value"]);
    const paymentId = handover.paymentId;
    const ownerKey = quote["ownerKey"];
    const purchaseDir = path.join(world.privateDir, paymentId);
    expect(statSync(purchaseDir).mode & 0o777).toBe(0o700);
    for (const name of ["intent.json", "release.json", "order_final.json"]) expect(statSync(path.join(purchaseDir, name)).mode & 0o777, name).toBe(0o600);
    // 進行中の再提出（同じ credential）は 409 in_progress。
    expect(await http(world, "POST", "/v1/private/purchases", { quoteId: quote["quoteId"], requestId: "r-http", approval: quote["quoteId"], credential: (await credentialFor((quote["source"] as { offer: Record<string, unknown> }).offer)).credential, ownerKey })).toMatchObject({ status: 409, body: { error: "in_progress" } });
    expect(provider.seen.paid).toHaveLength(0);
    const { files, bundle } = await completeSession(world, dirs, kg, handover, env.bytes, ownerKey);
    expect(provider.seen.paid).toHaveLength(1);
    expect(provider.seen.paid[0]).toMatchObject({ method: "POST", path: POST_PATH, body: kg.bodyText, payer: world.operatorAddress });
    const beforeAttest = await statusOf(world, paymentId, ownerKey);
    expect(beforeAttest.body).toMatchObject({ status: "attesting", private: { intentSha256: env.sha, outbound: { issued: true }, artifacts: { record: "available" } } });
    // attest: Router が verifier-verify（実 UltraHonk 検証）を走らせる。結果の永続化の直前で止まるので、その間に掃除前の成果物を写す。
    const attestPending = http(world, "POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey });
    await waitFor(() => existsSync(path.join(world.control, `arrive.beforeResultPersist.${paymentId}`)), 600_000, "verify finished (before persist)");
    const snapshot = readDirFiles(purchaseDir);
    expect([...snapshot.keys()].map((file) => path.basename(file)).sort()).toEqual(expect.arrayContaining(["bundle.json", "intent.json", "order_final.json", "record.json", "release.json", "serve.stderr.log", "serve.stdout.log", "verify.stderr.log", "verify.stdout.log", "verify_result.json"]));
    writeFileSync(path.join(world.control, "release.beforeResultPersist"), "1");
    const attested = await attestPending;
    expect(attested.body, attested.text).toMatchObject({ paymentId, status: "delivered_private", private: { proof: { delivery: true, requestBinding: true }, outbound: { receiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } } });
    expect(attested.status).toBe(200);
    // 失われた応答の再取得: 同じ bundle の再提出は耐久結果（検証はもう走らない）。
    const again = await http(world, "POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey });
    expect(again.body).toMatchObject({ status: "delivered_private" });
    expect(await http(world, "POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: tamperedProof(bundle).toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_closed" } });
    // record は何度でも同じ。所有者違い・鍵無しは 404。
    const record1 = await http(world, "GET", `/v1/private/purchases/${paymentId}/record`, undefined, ownerHeaders(ownerKey));
    const record2 = await http(world, "GET", `/v1/private/purchases/${paymentId}/record`, undefined, ownerHeaders(ownerKey));
    expect(record1.status).toBe(200);
    expect(record1.body["recordB64"]).toBe(record2.body["recordB64"]);
    expect(record1.body["releaseB64"]).toBe(handover.releaseB64);
    expect((await http(world, "GET", `/v1/private/purchases/${paymentId}/record`)).status).toBe(404);
    expect((await http(world, "GET", `/v1/private/purchases/${paymentId}/record`, undefined, ownerHeaders(ownerKey), BOB)).status).toBe(404);
    const recordText = Buffer.from(String(record1.body["recordB64"]), "base64").toString("utf8");
    const record = JSON.parse(recordText) as Record<string, unknown>;
    expect(record).toMatchObject({ trust: "lab-fixture-ca", intent_binding: { intent_sha256: env.sha, release_sha256: sha256Hex(Buffer.from(handover.releaseB64, "base64")) } });
    // 領収の原本（反射された値を含む）は record にだけ。Router 側は digest。
    expect(withDecoded(recordText)).toContain(reflected);
    const receiptHeaderValue = /payment-response: ([^\r\n]+)/i.exec(String(record["revealed_recv_headers"]))?.[1];
    expect(receiptHeaderValue).toBeDefined();
    expect((attested.body["private"] as { outbound: { receiptSha256: string } }).outbound.receiptSha256).toBe(sha256Hex(receiptHeaderValue!));
    // Payer の復号（手元で bundle を検証してから復号）: 平文 = Provider が返した本文。Provider は承認済みの本文そのものを受け取っている。
    const decrypted = await decrypt(dirs, kg, files, String(record1.body["recordB64"]), bundle);
    expect(decrypted.code, JSON.stringify(decrypted.result)).toBe(0);
    expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
    const expectedBody = provider.respond({ method: "POST", path: POST_PATH, body: kg.bodyText });
    expect(decrypted.plaintext?.toString("utf8")).toBe(expectedBody);
    expect(JSON.parse(expectedBody)).toMatchObject({ received_sha256: sha256Hex(kg.bodyText), selection: { route: "cpu-deterministic" } });
    // status（既存の口）に private 欄。
    const status = await statusOf(world, paymentId, ownerKey);
    expect(status.body).toMatchObject({ status: "delivered_private", private: { proof: { delivery: true, requestBinding: true, onChainFinality: "not_checked" }, artifacts: { record: "available" } }, destination: { outcome: "paid", txRef: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
    expect(status.body["destination"]).not.toHaveProperty("receiptRef");
    // 作業ディレクトリ: attest 完了で record.json だけ（0600）。
    expect(readdirSync(purchaseDir)).toEqual(["record.json"]);
    expect(statSync(path.join(purchaseDir, "record.json")).mode & 0o777).toBe(0o600);
    // canary の行列。掃除前の写し（子の出力・verify の結果を含む）も対象。
    const publicResponses = [quote, attested.body, again.body, status.body, beforeAttest.body].map((body) => JSON.stringify(body)).join("\n");
    const authenticated = `${purchase.text}\n${record1.text}`;
    const everywhere = [kg.canary, kg.bodyText, expectedBody, ...executorSecrets(dirs, kg, bundle), decrypted.plaintext!.toString("latin1")];
    expectCanaries(world, { public: publicResponses, authenticated, snapshot }, everywhere, [handover.releasedHeader.value], env.b64);
    // 反射された領収の値は公開面・journal・診断に無い（record の応答にだけ）。受信の署名は journal・射影に無い。
    expect(withDecoded(`${routerTexts(world).journal}\n${routerTexts(world).diagnostics}\n${publicResponses}`)).not.toContain(reflected);
    expect(withDecoded(`${routerTexts(world).journal}\n${publicResponses}`)).not.toContain(inboundSignature);
    for (const [file, text] of snapshot) if (!BEARER_ALLOWED.has(path.basename(file))) expect(text, `bearer in pre-cleanup ${file}`).not.toContain(handover.releasedHeader.value);
    // 既存の経路は不変: 動的の購入口は秘匿 quote を知らない。
    expect((await http(world, "GET", `/v1/routes/${PROFILE_ID}/resource`, undefined, { "x-router-quote-id": String(quote["quoteId"]), ...ownerHeaders(ownerKey) })).status).toBe(402);
  }, LONG);

  test("第三者 Provider の入力経路（docs/zktls-router-thirdparty.md §4.2）: 事前互換検査（fixture CA・loopback の差し替え = synthetic）→ provider.json → --provider-file で quote → approve → delivered。provider.json を変えた承認は拒否", async () => {
    const world = newWorld();
    await startRouter(world);
    const preDir = path.join(world.dir, "precheck");
    // 事前検査: Provider fixture（lab の fixture CA、test-server.io）に未払いの GET を 1 回。
    const pre = await precheckProvider({ url: `https://${HOST}${GET_PATH}`, maxAmount: PRICE, outDir: preDir, ca: readFileSync(lab.rootCa, "utf8"), connect: `127.0.0.1:${provider.port}` });
    expect(pre.ok, JSON.stringify(pre)).toBe(true);
    if (!pre.ok) return;
    expect(pre.provider).toMatchObject({ method: "GET", host: HOST, path: GET_PATH, outbound: { protocol: "x402", network: NETWORK, asset: USDC, payTo: PROVIDER_PAY_TO, maxAmount: PRICE }, observed: { synthetic: true, trust: "test-ca", framing402: "content-length" } });
    expect(provider.seen.probes.at(-1)).toMatchObject({ method: "GET", path: GET_PATH });
    const providerFile = pre.file!;
    const fileSha = createHash("sha256").update(readFileSync(providerFile)).digest("hex");
    // Payer: 値は provider.json から（手入力しない）。lab-fixture-ca なので synthetic でも通る。
    const common = { routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, profileId: PROFILE_ID, labDir: lab.labDir, srsPath: lab.srs, trust: "lab-fixture-ca" as const, connect: `127.0.0.1:${provider.port}`, payerPrivateKey: generatePrivateKey(), log: () => {} };
    const out = path.join(world.dir, "payer-3p");
    const quoted = await runPrivatePayer({ ...withProviderFile(providerFile, common)!, outDir: out, approve: false });
    expect(quoted).toMatchObject({ ok: true, stage: "quoted" });
    expect((JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { args: Record<string, unknown> }).args).toMatchObject({ method: "GET", host: HOST, path: GET_PATH, providerFileSha256: fileSha });
    // provider.json を書き換えた承認（値は同じでも別のバイト列）→ 拒否。署名も purchase も起きない。
    const settleBefore = facilitator.calls.settle;
    writeFileSync(providerFile, JSON.stringify(JSON.parse(readFileSync(providerFile, "utf8")), null, 1));
    expect(await runPrivatePayer({ ...withProviderFile(providerFile, common)!, outDir: out, approve: true })).toMatchObject({ ok: false, stage: "approve" });
    expect(facilitator.calls.settle).toBe(settleBefore);
    writeFileSync(providerFile, JSON.stringify(JSON.parse(readFileSync(providerFile, "utf8")), null, 2) + "\n");
    expect(createHash("sha256").update(readFileSync(providerFile)).digest("hex")).toBe(fileSha);
    const delivered = await runPrivatePayer({ ...withProviderFile(providerFile, common)!, outDir: out, approve: true });
    // 診断には平文を含めない（失敗時の出力に canary を出さない）。
    expect(delivered, JSON.stringify({ ok: delivered.ok, stage: delivered.stage, ...(delivered.ok ? {} : { reason: delivered.reason }), gates: delivered.evidence.gates })).toMatchObject({ ok: true, stage: "delivered" });
    if (!delivered.ok || delivered.stage !== "delivered") return;
    expect(delivered.evidence.providerFileSha256).toBe(fileSha);
    expect(delivered.evidence.gates.private_delivery).toMatchObject({ status: "delivered_private", proof: { delivery: true, requestBinding: false } });
    expect(delivered.evidence.gates.payer_receipt).toMatchObject({ ok: true, verifiedBundleBeforeDecrypt: true });
    expect(facilitator.calls.settle).toBe(settleBefore + 1);
    const plaintext = delivered.plaintext.toString("utf8");
    expect(plaintext).toBe(provider.respond({ method: "GET", path: GET_PATH, body: "" }));
    const evidenceText = readFileSync(path.join(out, "evidence.json"), "utf8");
    expect(evidenceText).not.toContain(plaintext);
    expect(evidenceText).toContain(fileSha);
    // 証跡を失った回復: 出所の記録は再開点の args から復元される。
    unlinkSync(path.join(out, "evidence.json"));
    const recovered = await recoverPrivatePayer({ routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, outDir: out, labDir: lab.labDir, srsPath: lab.srs });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.evidence.providerFileSha256).toBe(fileSha);
    expect(readFileSync(path.join(out, "evidence.json"), "utf8")).toContain(fileSha);
    // --recover --chain（thirdparty §10.1）: 偽の ChainReader が「使用 + 直後の Transfer」を返す → chain: settled。txRef は status 由来のまま（chainTxRef は付かない）。
    const checkpointDoc = JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { progress: { payerAddress?: string }; quote: { source: { offer: { amount: string; payTo: string; extra: { challengeNonce: string } } } } };
    expect(checkpointDoc.progress.payerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const inboundNonce = checkpointDoc.quote.source.offer.extra.challengeNonce;
    const topicAddr = (a: string): string => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
    const fakeTx = `0x${"44".repeat(32)}`;
    const head = { number: 1000, hash: `0x${"ab".repeat(32)}`, timestamp: Math.floor(Date.now() / 1000) };
    const reader = {
      chainId: async () => 84532,
      latestBlock: async () => head,
      blockByNumber: async () => head,
      authorizationState: async () => true,
      findAuthorization: async () => [{ kind: "used" as const, txHash: fakeTx, block: 900, blockHash: `0x${"cd".repeat(32)}` }],
      receiptLogsOf: async () => ({ blockHash: `0x${"cd".repeat(32)}`, logs: [
        { address: USDC, topics: ["0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5", topicAddr(checkpointDoc.progress.payerAddress!), inboundNonce], data: "0x" },
        { address: USDC, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topicAddr(checkpointDoc.progress.payerAddress!), topicAddr(checkpointDoc.quote.source.offer.payTo)], data: `0x${BigInt(checkpointDoc.quote.source.offer.amount).toString(16).padStart(64, "0")}` },
      ] }),
    };
    const chained = await recoverPrivatePayer({ routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, outDir: out, labDir: lab.labDir, srsPath: lab.srs, chain: { readerForTest: reader } });
    expect(chained.ok).toBe(true);
    if (chained.ok) {
      expect(chained.evidence.chain?.inbound).toMatchObject({ verdict: "settled", authorizerSource: "checkpoint", txRef: fakeTx });
      expect(chained.evidence.gates.inbound_settlement).toMatchObject({ settled: true, chain: "settled", txRef: delivered.evidence.gates.inbound_settlement.txRef });
      expect(chained.evidence.gates.inbound_settlement.chainTxRef).toBeUndefined();
      expect(chained.evidence.gates.private_delivery.status).toBe("delivered_private");
    }
    await stopRouter(world);
  }, 300_000);

  test("v1.3 受信 SubEtha V2（burn-sale）: 承認対象は注文ごとの burn address と payer_burn_before_credential、credential は {challengeNonce, burnTxHash}、settle の eventId が発行予約の identity、GET の全経路が成立。eventId 無しは未発行、通常の動的 quote は private_only_profile", async () => {
    const world = newWorld();
    await startRouter(world);
    const dirs = payerDirs(world, "subetha");
    const kg = await keygen(dirs, "GET");
    const envDoc = JSON.parse(envelopeOf(kg.order).bytes.toString("utf8")) as { inbound: Record<string, unknown> };
    envDoc.inbound = { network: SEPOLIA, asset: ZUSDC, maxTotal: "11000" };
    const envBytes = Buffer.from(JSON.stringify(envDoc), "utf8");
    const env = { bytes: envBytes, b64: envBytes.toString("base64"), sha: createHash("sha256").update(envBytes).digest("hex") };
    // 通常の動的 quote はこのプロファイルを使えない（I/O 無しで拒否）。
    const ordinary = await http(world, "POST", "/v1/quotes", { routeId: SUBETHA_PROFILE_ID, requestId: "r-ord", upstream: { url: `https://${HOST}${GET_PATH}` } });
    expect(ordinary.status, ordinary.text).toBe(404);
    expect(ordinary.body["error"]).toBe("private_only_profile");
    const quoted = await http(world, "POST", "/v1/private/quotes", { profileId: SUBETHA_PROFILE_ID, requestId: "r-sub", intentB64: env.b64 });
    expect(quoted.status, quoted.text).toBe(200);
    const offer = (quoted.body["source"] as { offer: Record<string, unknown> }).offer;
    expect(offer).toMatchObject({ scheme: "subetha-zerc20", network: SEPOLIA, asset: ZUSDC, amount: "11000", extra: { settlementKind: "zerc20-v2-burn-sale", fundsMoveOnCredential: true } });
    expect(String(offer["payTo"])).not.toBe(OPERATOR_PAY_TO);
    expect(quoted.body["private"]).toMatchObject({ inbound: { rail: "subetha", network: SEPOLIA, asset: ZUSDC, payTo: offer["payTo"], total: "11000", fundsMoveAt: "payer_burn_before_credential" }, outbound: { rail: "x402", payTo: PROVIDER_PAY_TO } });
    expect(quoted.body["disclosures"]).toMatchObject({ fundsMoveOnCredential: true });
    const ownerKey = quoted.body["ownerKey"];
    // Payer の credential: 承認した offer そのもの + {challengeNonce, burnTxHash}（burn は fixture では模擬: 64 hex）。
    const burnTxHash = `0x${randomBytes(32).toString("hex")}`;
    const credential = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offer, payload: { challengeNonce: offer["extra"] && (offer["extra"] as Record<string, unknown>)["challengeNonce"], burnTxHash } })).toString("base64");
    const purchase = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId: "r-sub", approval: quoted.body["quoteId"], credential, ownerKey });
    expect(purchase.status, purchase.text).toBe(200);
    const handover = purchase.body as unknown as Handover;
    const settledLine = readFileSync(world.journalPath, "utf8").split("\n").map((l) => (l === "" ? undefined : (JSON.parse(l) as { event?: string; paymentId?: string; patch?: Record<string, unknown> }))).find((e) => e?.event === "source_settled" && e.paymentId === handover.paymentId);
    expect(settledLine?.patch).toEqual({ txRef: burnTxHash.toLowerCase(), eventId: `11155111:${burnTxHash.toLowerCase()}:121` });
    const reserved = readFileSync(world.journalPath, "utf8").split("\n").map((l) => (l === "" ? undefined : (JSON.parse(l) as { event?: string; paymentId?: string; patch?: Record<string, unknown> }))).find((e) => e?.event === "private_issuance_reserved" && e.paymentId === handover.paymentId);
    expect(reserved?.patch?.["inboundIdentity"]).toBe(`subetha|${SEPOLIA}|${burnTxHash.toLowerCase()}|11155111:${burnTxHash.toLowerCase()}:121`);
    const { files, bundle } = await completeSession(world, dirs, kg, handover, env.bytes, ownerKey);
    const attested = await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey });
    expect(attested.body, attested.text).toMatchObject({ status: "delivered_private", private: { proof: { delivery: true, requestBinding: false } } });
    const record = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
    const decrypted = await decrypt(dirs, kg, files, String(record.body["recordB64"]), bundle);
    expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
    expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "GET", path: GET_PATH, body: "" }));
    const status = await statusOf(world, handover.paymentId, ownerKey);
    expect(status.body).toMatchObject({ status: "delivered_private", dynamic: { fundsMoveOnCredential: true } });
    expectCanaries(world, { public: `${quoted.text}\n${attested.text}\n${status.text}`, authenticated: `${purchase.text}\n${record.text}` }, [...executorSecrets(dirs, kg, bundle), decrypted.plaintext!.toString("latin1")], [handover.releasedHeader.value], env.b64);
    // 同じ burn tx を別の intent の credential に載せても、二重一意性（受信 identity）で発行しない。
    const kg2 = await keygen(payerDirs(world, "subetha-dup"), "GET");
    const envDoc2 = JSON.parse(envelopeOf(kg2.order).bytes.toString("utf8")) as { inbound: Record<string, unknown> };
    envDoc2.inbound = { network: SEPOLIA, asset: ZUSDC, maxTotal: "11000" };
    const quoted2 = await http(world, "POST", "/v1/private/quotes", { profileId: SUBETHA_PROFILE_ID, requestId: "r-sub2", intentB64: Buffer.from(JSON.stringify(envDoc2)).toString("base64") });
    const offer2 = (quoted2.body["source"] as { offer: Record<string, unknown> }).offer;
    // 別の intent が同じ burn を**大文字 hex** で申告しても、adapter の正準化で同じ受信 identity になる（表記で二重発行を抜けない）。
    const credential2 = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offer2, payload: { challengeNonce: (offer2["extra"] as Record<string, unknown>)["challengeNonce"], burnTxHash: `0x${burnTxHash.slice(2).toUpperCase()}` } })).toString("base64");
    const purchase2 = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted2.body["quoteId"], requestId: "r-sub2", approval: quoted2.body["quoteId"], credential: credential2, ownerKey: quoted2.body["ownerKey"] });
    expect(purchase2.body, purchase2.text).toMatchObject({ status: "unknown", terminalReason: "private_issuance_duplicate" });
    expect(purchase2.text).not.toContain("releasedHeader");
    await stopRouter(world);
    // eventId を返さない facilitator: 受信は settle するが発行しない（paid_undelivered / private_inbound_identity_missing）。
    const world2 = newWorld({ subethaPort: subethaFacilitatorNoEvent.port });
    await startRouter(world2);
    const kg3 = await keygen(payerDirs(world2, "subetha-noevent"), "GET");
    const envDoc3 = JSON.parse(envelopeOf(kg3.order).bytes.toString("utf8")) as { inbound: Record<string, unknown> };
    envDoc3.inbound = { network: SEPOLIA, asset: ZUSDC, maxTotal: "11000" };
    const quoted3 = await http(world2, "POST", "/v1/private/quotes", { profileId: SUBETHA_PROFILE_ID, requestId: "r-sub3", intentB64: Buffer.from(JSON.stringify(envDoc3)).toString("base64") });
    expect(quoted3.status, quoted3.text).toBe(200);
    const offer3 = (quoted3.body["source"] as { offer: Record<string, unknown> }).offer;
    const credential3 = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offer3, payload: { challengeNonce: (offer3["extra"] as Record<string, unknown>)["challengeNonce"], burnTxHash: `0x${randomBytes(32).toString("hex")}` } })).toString("base64");
    const purchase3 = await http(world2, "POST", "/v1/private/purchases", { quoteId: quoted3.body["quoteId"], requestId: "r-sub3", approval: quoted3.body["quoteId"], credential: credential3, ownerKey: quoted3.body["ownerKey"] });
    expect(purchase3.body, purchase3.text).toMatchObject({ status: "paid_data_unavailable", terminalReason: "private_inbound_identity_missing" });
    expect(purchase3.text).not.toContain("releasedHeader");
    expect(existsSync(path.join(world2.privateDir, String(purchase3.body["paymentId"])))).toBe(false);
    await stopRouter(world2);
  }, LONG);

  test("v1.3 payer 道具 --burn-tx-hash（docs/zktls-router-v2-inbound.md §4）: subetha 受信の quote は鍵無し、payFirst に注文別 burn address、burn 無しの承認は latch の前で拒否、--burn-tx-hash で delivered。証跡の受信 txRef は facilitator の確定値（eventId は journal）、--recover --chain は受信を protocol で読まず送信だけ読む", async () => {
    const world = newWorld();
    await startRouter(world);
    const common = { routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, profileId: SUBETHA_PROFILE_ID, labDir: lab.labDir, srsPath: lab.srs, method: "GET" as const, host: HOST, path: GET_PATH, outbound: { protocol: "x402" as const, network: NETWORK, asset: USDC, payTo: PROVIDER_PAY_TO, maxAmount: PRICE }, inbound: { network: SEPOLIA, asset: ZUSDC, maxTotal: "11000" }, trust: "lab-fixture-ca" as const, connect: `127.0.0.1:${provider.port}`, log: () => {} };
    const out = path.join(world.dir, "payer-burn");
    const quoted = await runPrivatePayer({ ...common, outDir: out, approve: false });
    expect(quoted, JSON.stringify(quoted)).toMatchObject({ ok: true, stage: "quoted" });
    if (!quoted.ok || quoted.stage !== "quoted") return;
    const payFirst = payFirstOf(quoted.quote);
    const offer = quoted.quote.source.offer as Record<string, unknown>;
    expect(payFirst).toEqual({ payTo: offer["payTo"], amount: "11000", network: SEPOLIA, asset: ZUSDC });
    expect(String(payFirst!.payTo)).not.toBe(OPERATOR_PAY_TO);
    const settledLines = (): number => readFileSync(world.journalPath, "utf8").split("\n").filter((l) => l !== "" && (JSON.parse(l) as { event?: string }).event === "source_settled").length;
    const before = settledLines();
    // burn 無しの承認: latch の前で拒否（purchase も settle も起きない）。
    const missing = await runPrivatePayer({ ...common, outDir: out, approve: true });
    expect(missing).toMatchObject({ ok: false, stage: "approve" });
    expect((JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { progress: Record<string, unknown> }).progress["purchaseAttempted"]).toBeUndefined();
    expect(settledLines()).toBe(before);
    // 人が burn address に払った（fixture では模擬: 64 hex、大文字混じりで渡す → credential と再開点は小文字）。
    const burnTxHash = `0x${randomBytes(32).toString("hex").toUpperCase()}`;
    const delivered = await runPrivatePayer({ ...common, outDir: out, approve: true, burnTxHash });
    expect(delivered, JSON.stringify({ ok: delivered.ok, stage: delivered.stage, ...(delivered.ok ? {} : { reason: delivered.reason }), gates: delivered.evidence.gates })).toMatchObject({ ok: true, stage: "delivered" });
    if (!delivered.ok || delivered.stage !== "delivered") return;
    expect(settledLines()).toBe(before + 1);
    // status の射影は eventId を出さない（journal にだけ）。証跡の受信 txRef は facilitator の確定値（小文字）= 申告した burn。
    expect(delivered.evidence.gates.inbound_settlement).toMatchObject({ settled: true, claimedTxRef: burnTxHash.toLowerCase(), txRef: burnTxHash.toLowerCase() });
    const settledLine = readFileSync(world.journalPath, "utf8").split("\n").map((l) => (l === "" ? undefined : (JSON.parse(l) as { event?: string; paymentId?: string; patch?: Record<string, unknown> }))).find((e) => e?.event === "source_settled" && e.paymentId === delivered.paymentId);
    expect(settledLine?.patch).toEqual({ txRef: burnTxHash.toLowerCase(), eventId: `11155111:${burnTxHash.toLowerCase()}:121` });
    expect(delivered.evidence.gates.private_delivery).toMatchObject({ status: "delivered_private", proof: { delivery: true, requestBinding: false } });
    expect(delivered.evidence.gates.payer_receipt).toMatchObject({ ok: true, verifiedBundleBeforeDecrypt: true });
    expect(delivered.plaintext.toString("utf8")).toBe(provider.respond({ method: "GET", path: GET_PATH, body: "" }));
    const checkpointDoc = JSON.parse(readFileSync(path.join(out, "checkpoint.json"), "utf8")) as { progress: Record<string, unknown> };
    expect(checkpointDoc.progress).toMatchObject({ burnTxHash: burnTxHash.toLowerCase(), handedOver: true });
    expect(checkpointDoc.progress["payerAddress"]).toBeUndefined();
    // --recover --chain: 受信は protocol で読まない。送信（x402 Base Sepolia）は手元の header から読む（偽の reader: 未使用）。
    const head = { number: 1000, hash: `0x${"ab".repeat(32)}`, timestamp: Math.floor(Date.now() / 1000) };
    const reader = { chainId: async () => 84532, latestBlock: async () => head, blockByNumber: async () => head, authorizationState: async () => false, findAuthorization: async () => [], receiptLogsOf: async () => undefined };
    const chained = await recoverPrivatePayer({ routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, outDir: out, labDir: lab.labDir, srsPath: lab.srs, chain: { readerForTest: reader } });
    expect(chained.ok).toBe(true);
    if (chained.ok) {
      expect(chained.evidence.chain?.skipped).toEqual({ inbound: "protocol" });
      expect(chained.evidence.chain?.inbound).toBeUndefined();
      expect(chained.evidence.chain?.outbound).toMatchObject({ verdict: "unused", authorizerSource: "header" });
      expect(chained.evidence.gates.inbound_settlement).toMatchObject({ settled: true, claimedTxRef: burnTxHash.toLowerCase(), txRef: burnTxHash.toLowerCase() });
      expect(chained.evidence.gates.private_delivery.status).toBe("delivered_private");
    }
    await stopRouter(world);
  }, 300_000);

  test("GET 全経路（公開 GET の秘匿配送）+ 同時二重 purchase + 完成した record への別注文 bundle（attest_foreign、状態不変）", async () => {
    const world = newWorld();
    await startRouter(world);
    const dirs = payerDirs(world, "get");
    const kg = await keygen(dirs, "GET");
    const env = envelopeOf(kg.order);
    const quoted = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r-get", intentB64: env.b64 });
    expect(quoted.status, quoted.text).toBe(200);
    expect(quoted.body["private"]).toMatchObject({ method: "GET", framing: "phase5-get-public-v1", target: { host: HOST, port: 443, path: GET_PATH } });
    expect(provider.seen.probes.at(-1)).toMatchObject({ method: "GET", path: GET_PATH });
    const offer = (quoted.body["source"] as { offer: Record<string, unknown> }).offer;
    const { credential } = await credentialFor(offer);
    const ownerKey = quoted.body["ownerKey"];
    // 同時二重 purchase（同じ quote・同じ credential）: 片方だけが引き渡し、もう片方は 409 in_progress。発行は 1 回（Provider の支払いも後で 1 回）。
    const body = { quoteId: quoted.body["quoteId"], requestId: "r-get", approval: quoted.body["quoteId"], credential, ownerKey };
    const [first, second] = await Promise.all([http(world, "POST", "/v1/private/purchases", body), http(world, "POST", "/v1/private/purchases", body)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, `${first.text}\n${second.text}`).toEqual([200, 409]);
    const purchase = first.status === 200 ? first : second;
    const rejected = first.status === 200 ? second : first;
    expect(rejected.body["error"]).toBe("in_progress");
    expect(rejected.text).not.toContain("releasedHeader");
    const handover = purchase.body as unknown as Handover;
    const { files, bundle } = await completeSession(world, dirs, kg, handover, env.bytes, ownerKey);
    expect(provider.seen.paid).toHaveLength(1);
    expect(provider.seen.paid[0]).toMatchObject({ method: "GET", path: GET_PATH, body: "" });
    // 完成した record に対する別注文の bundle は 409 attest_foreign で、状態は attesting のまま（検証は走らない）。
    expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: foreignBundleFor(kg).toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_foreign" } });
    expect((await statusOf(world, handover.paymentId, ownerKey)).body["status"]).toBe("attesting");
    expect(existsSync(path.join(world.privateDir, handover.paymentId, "verify_result.json"))).toBe(false);
    const attested = await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey });
    expect(attested.body, attested.text).toMatchObject({ status: "delivered_private", private: { proof: { delivery: true, requestBinding: false } } });
    const record = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
    const decrypted = await decrypt(dirs, kg, files, String(record.body["recordB64"]), bundle);
    expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
    expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "GET", path: GET_PATH, body: "" }));
    const status = await statusOf(world, handover.paymentId, ownerKey);
    expect(status.body).toMatchObject({ status: "delivered_private", private: { proof: { requestBinding: false } } });
    expectCanaries(world, { public: `${quoted.text}\n${attested.text}\n${status.text}`, authenticated: `${purchase.text}\n${record.text}` }, [...executorSecrets(dirs, kg, bundle), decrypted.plaintext!.toString("latin1")], [handover.releasedHeader.value], env.b64);
  }, LONG);

  test("MCP 全経路（実 stdio の子 `src/mcp/server.ts` + SDK client）: purchase の引き渡しだけが bearer を返し、quote/attest/record/status の出力には無い", async () => {
    const world = newWorld();
    await startRouter(world);
    const base: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
      const value = process.env[key];
      if (value !== undefined) base[key] = value;
    }
    const transport = new StdioClientTransport({ command: "npx", args: ["--no-install", "tsx", "src/mcp/server.ts"], env: { ...base, CI: "1", ROUTER_MCP_BASE_URL: world.router!.baseUrl, ROUTER_MCP_PRINCIPAL_ID: ALICE.id, ROUTER_MCP_TOKEN: ALICE.token, ROUTER_MCP_ADAPTER_MODE: "real", ROUTER_MCP_EVIDENCE_LABEL: "T-Z7-synthetic-lab-fixture-ca" }, stderr: "pipe" });
    const client = new Client({ name: "zktls-wire", version: "0.1.0" });
    await client.connect(transport);
    try {
      const dirs = payerDirs(world, "mcp");
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const quoted = await callTool(client, TOOL_NAMES.privateQuote, { profileId: PROFILE_ID, requestId: "r-mcp", intentB64: env.b64 });
      expect(quoted).toMatchObject({ ok: true, approvalRequired: true, subject: { privatePurchase: true, private: { intentSha256: env.sha, target: { host: HOST } } } });
      const quote = quoted["quote"] as Record<string, unknown>;
      const offer = (quote["source"] as { offer: Record<string, unknown> }).offer;
      const { credential } = await credentialFor(offer);
      const purchased = await callTool(client, TOOL_NAMES.privatePurchase, { quoteId: String(quote["quoteId"]), requestId: "r-mcp", approval: String(quote["quoteId"]), credential, quote });
      expect(purchased, JSON.stringify(purchased)).toMatchObject({ ok: true, outcome: "awaiting_session" });
      const handover = purchased["handover"] as Handover;
      expect(String(purchased["nextStep"])).toContain(handover.verifier.address);
      const ownerKey = String(quote["ownerKey"]);
      const { files, bundle } = await completeSession(world, dirs, kg, handover, env.bytes, ownerKey);
      const attested = await callTool(client, TOOL_NAMES.privateAttest, { paymentId: handover.paymentId, ownerKey, bundleB64: bundle.toString("base64") });
      expect(attested, JSON.stringify(attested)).toMatchObject({ ok: true, status: "delivered_private" });
      const record1 = await callTool(client, TOOL_NAMES.privateRecord, { paymentId: handover.paymentId, ownerKey });
      const record2 = await callTool(client, TOOL_NAMES.privateRecord, { paymentId: handover.paymentId, ownerKey });
      expect(record1).toMatchObject({ ok: true });
      expect(record1["recordB64"]).toBe(record2["recordB64"]);
      const status = await callTool(client, TOOL_NAMES.status, { paymentId: handover.paymentId, ownerKey });
      expect(JSON.stringify(status)).toContain("delivered_private");
      const decrypted = await decrypt(dirs, kg, files, String(record1["recordB64"]), bundle);
      expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
      expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "POST", path: POST_PATH, body: kg.bodyText }));
      const publicOutputs = [quoted, attested, status].map((out) => JSON.stringify(out)).join("\n");
      expect(withDecoded(publicOutputs)).not.toContain(handover.releasedHeader.value);
      expectCanaries(world, { public: publicOutputs, authenticated: `${JSON.stringify(purchased)}\n${JSON.stringify(record1)}` }, [kg.canary, kg.bodyText, ...executorSecrets(dirs, kg, bundle), decrypted.plaintext!.toString("latin1")], [handover.releasedHeader.value], env.b64);
    } finally {
      await client.close();
    }
  }, LONG);

  test("tools/private-payer.ts（受入で owner が使う Payer 側の道具）: quote（再開点）→ 同じ out で承認 → delivered。別 out・改変・引数違いの承認は拒否。引き渡し後の失敗でも受信決済は証跡に残り、--recover で読み直せる", async () => {
    const world = newWorld();
    await startRouter(world);
    const outDir = path.join(world.dir, "payer-tool");
    const bodyFile = path.join(world.dir, "tool-body.json");
    const canary = `canary-tool-${randomBytes(8).toString("hex")}`;
    writeFileSync(bodyFile, JSON.stringify({ schema: "lab.select.v1", model: "lab-echo", prompt: canary }), { mode: 0o600 });
    const base = { routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, profileId: PROFILE_ID, labDir: lab.labDir, srsPath: lab.srs, method: "POST" as const, host: HOST, path: POST_PATH, bodyFile, outbound: { protocol: "x402" as const, network: NETWORK, asset: USDC, payTo: PROVIDER_PAY_TO, maxAmount: PRICE }, trust: "lab-fixture-ca" as const, connect: `127.0.0.1:${provider.port}`, payerPrivateKey: generatePrivateKey(), log: () => {} };
    // 1 回目（承認なし）: quote で止まり、承認対象と再開点を書く。支払いも署名も無い（facilitator の settle は増えない。計数は fixture 全体で累積）。
    const settleBefore = facilitator.calls.settle;
    const d = path.join(outDir, "d");
    const quoted = await runPrivatePayer({ ...base, outDir: d, approve: false });
    expect(quoted).toMatchObject({ ok: true, stage: "quoted" });
    if (!quoted.ok || quoted.stage !== "quoted") return;
    expect(provider.seen.paid).toHaveLength(0);
    expect(facilitator.calls.settle).toBe(settleBefore);
    const quoteText = readFileSync(path.join(d, "quote.json"), "utf8");
    expect(quoteText).not.toContain("ownerKey");
    expect(statSync(path.join(d, "checkpoint.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(d, "checkpoint.json"), "utf8")).toContain(quoted.quote.ownerKey);
    // 再 quote の拒否（同じ out）、別 out での承認の拒否、引数違いの拒否、改変の拒否、mozilla で範囲の記録が無い拒否。
    expect(await runPrivatePayer({ ...base, outDir: d, approve: false })).toMatchObject({ ok: false, stage: "review" });
    expect(await runPrivatePayer({ ...base, outDir: path.join(outDir, "fresh"), approve: true })).toMatchObject({ ok: false, stage: "approve" });
    expect(await runPrivatePayer({ ...base, outDir: d, approve: true, outbound: { ...base.outbound, maxAmount: "20000" } })).toMatchObject({ ok: false, stage: "approve" });
    writeFileSync(path.join(d, "quote.json"), quoteText.replace(/"total": "\d+"/, '"total": "1"'));
    expect(await runPrivatePayer({ ...base, outDir: d, approve: true })).toMatchObject({ ok: false, stage: "approve" });
    writeFileSync(path.join(d, "quote.json"), quoteText);
    expect(await runPrivatePayer({ ...base, trust: "mozilla", connect: undefined as never, outDir: path.join(outDir, "m"), approve: true })).toMatchObject({ ok: false, stage: "prerequisites" });
    expect(provider.seen.paid).toHaveLength(0);
    expect(facilitator.calls.settle).toBe(settleBefore);
    // 2 回目（同じ out に承認）: 読んだ quote そのものを購入し、最後まで。
    const run = await runPrivatePayer({ ...base, outDir: d, approve: true });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok || run.stage !== "delivered") return;
    expect(run.paymentId).toBe(quoted.quote.paymentId);
    expect(run.evidence).toMatchObject({ synthetic: true, stage: "delivered", gates: { inbound_settlement: { settled: true }, outbound_settlement: { issued: true, receipt: true }, private_delivery: { status: "delivered_private", recordRepeatable: true, proof: { delivery: true, requestBinding: true } }, payer_receipt: { ok: true, verifiedBundleBeforeDecrypt: true }, finality: { checked: false } } });
    expect(run.evidence.gates.inbound_settlement.txRef).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(run.evidence.gates.outbound_settlement.txRef).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(run.plaintext.toString("utf8")).toBe(provider.respond({ method: "POST", path: POST_PATH, body: readFileSync(bodyFile, "utf8") }));
    const evidenceText = readFileSync(path.join(d, "evidence.json"), "utf8");
    const headerValue = (JSON.parse(readFileSync(path.join(d, "payment_header.json"), "utf8")) as { value: string }).value;
    expect(evidenceText).not.toContain(headerValue);
    expect(evidenceText).not.toContain(canary);
    expect(evidenceText).not.toContain(quoted.quote.ownerKey);
    expect(statSync(path.join(d, "payment_header.json")).mode & 0o777).toBe(0o600);
    // 引き渡し済みの再承認は拒否（二重の支払いを作らない）。拒否は証跡を上書きせず `refusals.json` に残る。--recover は読むだけ。
    expect(await runPrivatePayer({ ...base, outDir: d, approve: true })).toMatchObject({ ok: false, stage: "approve" });
    expect(readFileSync(path.join(d, "evidence.json"), "utf8")).toBe(evidenceText);
    // 拒否の記録: 再 quote 1 + 引数違い 1 + 改変 1 + 引き渡し済み 1。
    const refusals = JSON.parse(readFileSync(path.join(d, "refusals.json"), "utf8")) as { stage: string }[];
    expect(refusals.map((r) => r.stage)).toEqual(["review", "approve", "approve", "approve"]);
    const recovered = await recoverPrivatePayer({ routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, outDir: d, labDir: lab.labDir, srsPath: lab.srs, log: () => {} });
    expect(recovered).toMatchObject({ ok: true, paymentId: run.paymentId, recordAvailable: true, decrypted: true, evidence: { gates: { inbound_settlement: { settled: true }, private_delivery: { status: "delivered_private" }, payer_receipt: { ok: true } } } });
    // 別プロセスの CLI からの --recover（checkpoint の ownerKey だけで status・record を読み、復号する）。
    const cli = execFileSync(process.execPath, ["--import", "tsx", path.join(repoRoot, "tools/private-payer.ts"), "--recover", "--router", world.router!.baseUrl, "--principal", ALICE.id, "--out", d, "--lab-dir", lab.labDir], { cwd: repoRoot, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", PRIVATE_PAYER_TOKEN: ALICE.token, SUBETHA_ZKTLS_SRS_DAT: lab.srs }, stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(cli.trim().split("\n").at(-1)!)).toMatchObject({ ok: true, paymentId: run.paymentId, status: "delivered_private", recordAvailable: true, decrypted: true });
    expectCanaries(world, { public: evidenceText }, [canary], [headerValue]);
    // 再開点の検査: quote の期限切れ・quote.json の削除・提出済みの latch はどれも承認を拒み、署名も購入要求も起きない。
    for (const [name, mutate] of [
      ["expired", (c: Record<string, unknown>) => ({ ...c, quote: { ...(c["quote"] as Record<string, unknown>), approval: { ...((c["quote"] as Record<string, unknown>)["approval"] as Record<string, unknown>), deadlineMs: Date.now() - 1 } } })],
      ["attempted", (c: Record<string, unknown>) => ({ ...c, progress: { ...(c["progress"] as Record<string, unknown>), purchaseAttempted: true } })],
    ] as const) {
      const g = path.join(outDir, `g-${name}`);
      expect(await runPrivatePayer({ ...base, outDir: g, approve: false })).toMatchObject({ ok: true, stage: "quoted" });
      const file = path.join(g, "checkpoint.json");
      writeFileSync(file, JSON.stringify(mutate(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)));
      const verifyBefore = facilitator.calls.verify;
      expect(await runPrivatePayer({ ...base, outDir: g, approve: true }), name).toMatchObject({ ok: false, stage: "approve" });
      expect(facilitator.calls.verify, name).toBe(verifyBefore);
      // recover は提出済み（結果不明）の購入を uncertain とし、Router の status（awaiting_payment）を読む。
      if (name === "attempted") {
        const r = await recoverPrivatePayer({ routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, outDir: g, labDir: lab.labDir, srsPath: lab.srs, log: () => {} });
        expect(r).toMatchObject({ ok: true, recordAvailable: false, status: { status: "awaiting_payment" }, evidence: { gates: { inbound_settlement: { settled: false, uncertain: true }, outbound_settlement: { uncertain: true } } } });
      }
    }
    const removed = path.join(outDir, "g-removed");
    expect(await runPrivatePayer({ ...base, outDir: removed, approve: false })).toMatchObject({ ok: true, stage: "quoted" });
    unlinkSync(path.join(removed, "quote.json"));
    expect(await runPrivatePayer({ ...base, outDir: removed, approve: true })).toMatchObject({ ok: false, stage: "approve" });
    // 引き渡しの後で失敗（executor が Provider に届かない）: 受信決済と発行は証跡に残り、stage は session。別プロセスからの --recover は checkpoint の ownerKey で status を読める。
    const f = path.join(outDir, "f");
    const quotedF = await runPrivatePayer({ ...base, outDir: f, approve: false });
    expect(quotedF).toMatchObject({ ok: true, stage: "quoted" });
    const failed = await runPrivatePayer({ ...base, outDir: f, approve: true, connect: "127.0.0.1:9", sessionTimeoutSecs: 30 });
    expect(failed).toMatchObject({ ok: false, stage: "session", evidence: { stage: "session", gates: { inbound_settlement: { settled: true }, outbound_settlement: { issued: true, receipt: false } } } });
    if (failed.ok) return;
    // Router 側は、Verifier の子がセッション失敗で終われば終端の unknown、まだなら awaiting_session（どちらも「払ったかもしれない」側の扱い）。
    expect(["awaiting_session", "unknown"]).toContain(failed.evidence.routerStatus?.status);
    expect(failed.evidence.gates.inbound_settlement.txRef).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(failed.reason).toContain("do not re-pay");
    const recoveredF = await recoverPrivatePayer({ routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, outDir: f, labDir: lab.labDir, srsPath: lab.srs, log: () => {} });
    expect(recoveredF).toMatchObject({ ok: true, recordAvailable: false, decrypted: false, evidence: { gates: { inbound_settlement: { settled: true }, outbound_settlement: { issued: true } } } });
    if (!recoveredF.ok) return;
    expect(["awaiting_session", "unknown"]).toContain(recoveredF.status?.["status"]);
    expect(recoveredF.evidence.gates.inbound_settlement.txRef).toBe(failed.evidence.gates.inbound_settlement.txRef);
    expect(await runPrivatePayer({ ...base, outDir: f, approve: true })).toMatchObject({ ok: false, stage: "approve" });
    // 別の Router URL は再開点と違うので拒否（identity の検査。証跡は触らない）。
    expect(await recoverPrivatePayer({ routerBaseUrl: "http://127.0.0.1:9", principalId: ALICE.id, token: ALICE.token, outDir: f, labDir: lab.labDir, srsPath: lab.srs, log: () => {} })).toMatchObject({ ok: false });
    expect(existsSync(path.join(f, "evidence-recover.json"))).toBe(false);
    // 成功した復号の後、bundle を壊して再び回復しても payer_receipt は ok のまま（失敗は recovery-log.json へ）。
    const bundleFileD = path.join(d, "bundle.json");
    const goodBundle = readFileSync(bundleFileD);
    writeFileSync(bundleFileD, tamperedProof(goodBundle));
    const repeat = await recoverPrivatePayer({ routerBaseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token, outDir: d, labDir: lab.labDir, srsPath: lab.srs, log: () => {} });
    expect(repeat).toMatchObject({ ok: true, decrypted: false, evidence: { gates: { payer_receipt: { ok: true }, private_delivery: { status: "delivered_private" } } } });
    expect(JSON.parse(readFileSync(path.join(d, "recovery-log.json"), "utf8"))).toEqual([expect.objectContaining({ stage: "decrypt" })]);
    writeFileSync(bundleFileD, goodBundle);
    // 再開点・証跡は一時ファイル経由の原子的な書き込み（残骸が無く、常に読める JSON）。
    for (const dir of [d, f]) {
      expect(existsSync(path.join(dir, "checkpoint.json.tmp"))).toBe(false);
      expect(() => JSON.parse(readFileSync(path.join(dir, "checkpoint.json"), "utf8"))).not.toThrow();
      expect(() => JSON.parse(readFileSync(path.join(dir, "evidence.json"), "utf8"))).not.toThrow();
    }
    // 耐久書き込みの故障注入: latch が fsync/rename/ディレクトリ fsync のどこで失敗しても、署名も購入要求も起きず、前の再開点（latch 無し）がそのまま読める。
    for (const stage of ["write", "fsync", "rename", "dirfsync"] as const) {
      const h = path.join(outDir, `h-${stage}`);
      expect(await runPrivatePayer({ ...base, outDir: h, approve: false })).toMatchObject({ ok: true, stage: "quoted" });
      const before = readFileSync(path.join(h, "checkpoint.json"), "utf8");
      const verifyBefore = facilitator.calls.verify;
      const probesBefore = provider.seen.probes.length;
      const refused = await runPrivatePayer({ ...base, outDir: h, approve: true, hooksForTest: { durableFail: (s, file) => s === stage && path.basename(file) === "checkpoint.json" } });
      expect(refused, stage).toMatchObject({ ok: false, stage: "approve" });
      expect(facilitator.calls.verify, stage).toBe(verifyBefore);
      expect(provider.seen.probes.length, stage).toBe(probesBefore);
      expect(existsSync(path.join(h, "checkpoint.json.tmp")), stage).toBe(false);
      const after = readFileSync(path.join(h, "checkpoint.json"), "utf8");
      if (stage === "dirfsync") {
        // rename の後の失敗: 新しい再開点（latch つき）が既に置かれている。保守的に、以後の承認は拒否（--recover へ）。署名は起きていない。
        expect((JSON.parse(after) as { progress: { purchaseAttempted?: boolean } }).progress.purchaseAttempted, stage).toBe(true);
        expect(await runPrivatePayer({ ...base, outDir: h, approve: true })).toMatchObject({ ok: false, stage: "approve" });
        expect(facilitator.calls.verify, stage).toBe(verifyBefore);
      } else {
        // rename の前の失敗: 前の再開点が無傷。故障が無ければ同じ再開点から承認できる。
        expect(after, stage).toBe(before);
        if (stage === "rename") {
          const ok = await runPrivatePayer({ ...base, outDir: h, approve: true });
          expect(ok.ok, JSON.stringify(ok)).toBe(true);
        }
      }
    }
    // latch の直後の割り込み（プロセスが止まった）: 新しい起動は署名も提出もせず拒否し、--recover に回す。
    const i = path.join(outDir, "i-interrupt");
    expect(await runPrivatePayer({ ...base, outDir: i, approve: false })).toMatchObject({ ok: true, stage: "quoted" });
    const verifyBeforeI = facilitator.calls.verify;
    await expect(runPrivatePayer({ ...base, outDir: i, approve: true, hooksForTest: { afterLatch: () => { throw new Error("interrupted after the latch"); } } })).rejects.toThrow(/interrupted/);
    expect((JSON.parse(readFileSync(path.join(i, "checkpoint.json"), "utf8")) as { progress: { purchaseAttempted?: boolean } }).progress.purchaseAttempted).toBe(true);
    expect(await runPrivatePayer({ ...base, outDir: i, approve: true })).toMatchObject({ ok: false, stage: "approve" });
    expect(facilitator.calls.verify).toBe(verifyBeforeI);
    // Router が止まっている間の --recover（再開点と同じ URL）: 通常の経路で返り、確立したゲートは残り、status/record の失敗は recovery-log.json に残る。
    const beforeDown = JSON.parse(readFileSync(path.join(f, "evidence.json"), "utf8")) as { gates: { inbound_settlement: { settled: boolean; txRef?: string } } };
    const routerUrl = world.router!.baseUrl;
    await stopRouter(world);
    const down = await recoverPrivatePayer({ routerBaseUrl: routerUrl, principalId: ALICE.id, token: ALICE.token, outDir: f, labDir: lab.labDir, srsPath: lab.srs, log: () => {} });
    expect(down).toMatchObject({ ok: true, recordAvailable: false, decrypted: false, evidence: { gates: { inbound_settlement: { settled: true, txRef: beforeDown.gates.inbound_settlement.txRef }, outbound_settlement: { issued: true } } } });
    if (down.ok) expect(down.status).toBeUndefined();
    const logF = JSON.parse(readFileSync(path.join(f, "recovery-log.json"), "utf8")) as { stage: string }[];
    expect(logF.map((e) => e.stage)).toEqual(expect.arrayContaining(["status", "record"]));
    expect((JSON.parse(readFileSync(path.join(f, "evidence.json"), "utf8")) as typeof beforeDown).gates.inbound_settlement).toEqual(beforeDown.gates.inbound_settlement);
    expect(existsSync(path.join(f, "evidence-recover.json"))).toBe(false);
  }, LONG);

  test("否定ケース（セッション無し）: port≠443、payTo 不一致、record/attest 未完成、所有者違い、サイズ超過、別の offer の credential、注文のすり替え → TLS 前に拒否 → セッション無しの期限で unknown", async () => {
    const world = newWorld({ sessionTimeoutMs: 20_000 });
    await startRouter(world);
    const dirs = payerDirs(world, "neg");
    const kg = await keygen(dirs);
    // port ≠ 443 は invalid_intent。
    const badPort = envelopeOf({ ...kg.order, target: { ...(kg.order["target"] as Record<string, unknown>), port: 8443 } });
    expect(await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "n1", intentB64: badPort.b64 })).toMatchObject({ status: 400, body: { error: "invalid_intent" } });
    // 封筒の payTo が Provider の提示と違えば quote で止まる（Router は提示を本文なしで読み、封筒と照合する）。
    const badPayTo = envelopeOf(kg.order, { outbound: { payTo: "0x0000000000000000000000000000000000000a11" } });
    expect(await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "n2", intentB64: badPayTo.b64 })).toMatchObject({ status: 409, body: { error: "intent_mismatch", reason: "outbound_offer" } });
    expect(provider.seen.paid).toHaveLength(0);
    // 正常な quote → purchase。record/attest はまだ。
    const env = envelopeOf(kg.order);
    const { quote, purchase, credential } = await quoteAndPurchase(world, env, "n3");
    expect(purchase.status, purchase.text).toBe(200);
    const handover = purchase.body as unknown as Handover;
    const ownerKey = quote["ownerKey"];
    expect(await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey))).toMatchObject({ status: 409, body: { error: "record_not_available" } });
    expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: Buffer.from("{}").toString("base64"), ownerKey })).toMatchObject({ status: 400, body: { error: "invalid_bundle" } });
    expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: foreignBundleFor(kg).toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_not_ready" } });
    expect((await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: foreignBundleFor(kg).toString("base64"), ownerKey: "wrong" })).status).toBe(404);
    expect((await statusOf(world, handover.paymentId, ownerKey)).status).toBe(200);
    expect((await http(world, "GET", `/v1/purchases/${handover.paymentId}`, undefined, ownerHeaders(ownerKey), BOB)).status).toBe(404);
    expect((await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: "A".repeat(400_000), ownerKey })).status).toBe(413);
    // 実際に提出した受信 credential を別の秘匿購入（別の offer）に出しても通らない（受信 adapter の事前検査。発行も決済も無い）。
    const dirs2 = payerDirs(world, "neg2");
    const kg2 = await keygen(dirs2);
    const env2 = envelopeOf(kg2.order);
    const quoted2 = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "n4", intentB64: env2.b64 });
    expect(quoted2.status).toBe(200);
    const verifyCallsBefore = facilitator.calls.verify;
    const replay = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted2.body["quoteId"], requestId: "n4", approval: quoted2.body["quoteId"], credential, ownerKey: quoted2.body["ownerKey"] });
    expect(replay.status, replay.text).toBe(402);
    expect(replay.body, replay.text).toMatchObject({ error: "nonce_mismatch", status: "rejected" });
    expect(facilitator.calls.verify).toBe(verifyCallsBefore);
    expect((await statusOf(world, String(quoted2.body["paymentId"]), quoted2.body["ownerKey"])).body["status"]).toBe("awaiting_payment");
    // 注文のすり替え: executor に渡す最終注文を変える（発行ヘッダの値を 1 文字変える）→ Verifier が TLS の前に拒否（Provider は要求を受けない）→ record は無く、期限で unknown/private_session_timeout。
    const files = await finalize(dirs, handover, env.bytes);
    const tampered = JSON.parse(readFileSync(files.orderFinal, "utf8")) as { request: { payment_header: { value: string } } };
    tampered.request.payment_header.value = `${tampered.request.payment_header.value.slice(0, -1)}${tampered.request.payment_header.value.endsWith("A") ? "B" : "A"}`;
    const tamperedFile = path.join(dirs.root, "order_tampered.json");
    writeFileSync(tamperedFile, JSON.stringify(tampered), { mode: 0o600 });
    const paidBefore = provider.seen.paid.length;
    const ran = await session(dirs, kg, tamperedFile, handover.verifier.address);
    expect(ran.code, ran.stderr.slice(-800)).not.toBe(0);
    expect(provider.seen.paid).toHaveLength(paidBefore);
    const statusAfter = await statusOf(world, handover.paymentId, ownerKey);
    expect(statusAfter.body["status"]).toBe("awaiting_session");
    await waitFor(async () => (await statusOf(world, handover.paymentId, ownerKey)).body["status"] === "unknown", 60_000, "session deadline");
    const timedOut = await statusOf(world, handover.paymentId, ownerKey);
    expect(timedOut.body).toMatchObject({ status: "unknown", terminalReason: "private_session_timeout", private: { artifacts: { record: "none" } } });
    expect(existsSync(path.join(world.privateDir, handover.paymentId))).toBe(false);
    expect(pidsMatching(path.join(world.privateDir, handover.paymentId))).toEqual([]);
    expect(timedOut.text).not.toContain(handover.releasedHeader.value);
  }, 300_000);

  test("改変した証明は attest で拒否（unknown/private_attest_invalid、record は取得可、Payer は元の bundle で復号可）。期限後の attest は attest_expired", async () => {
    // 改変した証明。
    {
      const world = newWorld();
      await startRouter(world);
      const dirs = payerDirs(world, "tamper");
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const { quote, purchase } = await quoteAndPurchase(world, env, "r-tamper");
      const handover = purchase.body as unknown as Handover;
      const ownerKey = quote["ownerKey"];
      const { files, bundle } = await completeSession(world, dirs, kg, handover, env.bytes, ownerKey);
      const attested = await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: tamperedProof(bundle).toString("base64"), ownerKey });
      expect(attested.body, attested.text).toMatchObject({ status: "unknown", terminalReason: "private_attest_invalid", private: { attest: { result: "unknown" } } });
      expect((await statusOf(world, handover.paymentId, ownerKey)).body).toMatchObject({ status: "unknown", terminalReason: "private_attest_invalid" });
      // 一度きり: 正しい bundle をあとから出しても閉じている。record は取得できる。
      expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_closed" } });
      const record = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
      expect(record.status).toBe(200);
      expect(readdirSync(path.join(world.privateDir, handover.paymentId))).toEqual(["record.json"]);
      const decrypted = await decrypt(dirs, kg, files, String(record.body["recordB64"]), bundle);
      expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
      expect((await decrypt(dirs, kg, files, String(record.body["recordB64"]), tamperedProof(bundle), "tampered")).result).toMatchObject({ ok: false, failed_stage: "verify" });
      await stopRouter(world);
      rmSync(world.dir, { recursive: true, force: true });
      worlds.pop();
    }
    // 期限後の attest。
    {
      const world = newWorld({ attestTimeoutMs: 15_000, verifyTimeoutMs: 60_000 });
      await startRouter(world);
      const dirs = payerDirs(world, "expired");
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const { quote, purchase } = await quoteAndPurchase(world, env, "r-expired");
      const handover = purchase.body as unknown as Handover;
      const ownerKey = quote["ownerKey"];
      const { files, bundle } = await completeSession(world, dirs, kg, handover, env.bytes, ownerKey);
      const attestBy = ((await statusOf(world, handover.paymentId, ownerKey)).body["private"] as { deadlines: { attestBy: number } }).deadlines.attestBy;
      await sleep(Math.max(0, attestBy - Date.now()) + 1_000);
      const late = await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey });
      expect(late.status, late.text).toBe(409);
      expect(["attest_expired", "attest_closed"]).toContain(late.body["error"]);
      await waitFor(async () => (await statusOf(world, handover.paymentId, ownerKey)).body["status"] === "unknown", 20_000, "attest timeout terminal");
      expect((await statusOf(world, handover.paymentId, ownerKey)).body).toMatchObject({ status: "unknown", terminalReason: "private_attest_timeout", private: { artifacts: { record: "available" } } });
      const record = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
      expect(record.status).toBe(200);
      expect((await decrypt(dirs, kg, files, String(record.body["recordB64"]), bundle)).result).toMatchObject({ ok: true });
    }
  }, 2 * LONG);

  test("セッション前の停止点で Router を SIGKILL → 再起動で終端・生き残った Verifier の終了・成果物の掃除。棚卸しの途中（門を外した後・pid の前）で殺しても同じ終端", async () => {
    const expected: Record<string, string> = { afterReserve: "interrupted_before_release", afterRelease: "interrupted_before_handover", afterLaunchGate: "interrupted_before_handover", afterSpawn: "interrupted_before_handover", afterHandoverJournal: "interrupted_after_release" };
    const world = newWorld();
    for (const point of Object.keys(expected) as StopPoint[]) {
      await startRouter(world, { stops: [point] });
      const dirs = payerDirs(world, `crash-${point}`);
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const quoted = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: `c-${point}`, intentB64: env.b64 });
      expect(quoted.status).toBe(200);
      const offer = (quoted.body["source"] as { offer: Record<string, unknown> }).offer;
      const { credential } = await credentialFor(offer);
      const pending = http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId: `c-${point}`, approval: quoted.body["quoteId"], credential, ownerKey: quoted.body["ownerKey"] }).catch(() => undefined);
      const paymentId = String(quoted.body["paymentId"]);
      await waitFor(() => existsSync(path.join(world.control, `arrive.${point}.${paymentId}`)), 120_000, `arrive at ${point}`);
      const purchaseDir = path.join(world.privateDir, paymentId);
      let childPid: number | undefined;
      if (point === "afterSpawn" || point === "afterHandoverJournal") {
        childPid = Number(readFileSync(path.join(purchaseDir, "serve.pid"), "utf8"));
        expect(alive(childPid), point).toBe(true);
      }
      await killRouter(world);
      await pending;
      if (childPid !== undefined) expect(alive(childPid), `${point}: the Verifier survives the Router`).toBe(true);
      if (point === "afterHandoverJournal") {
        // 棚卸しの途中で殺す: 門を外した後・pid の棚卸しの前に止まる世代を listening を待たずに起動し、到着で殺す。門は `.cancelled`、生き残りはまだ生きている。
        const raw = spawnRouterRaw(world, { stops: ["duringRecoveryInventory"] });
        await waitFor(() => existsSync(path.join(world.control, "arrive.duringRecoveryInventory.-")), 60_000, "arrive during inventory");
        expect(existsSync(path.join(purchaseDir, "launch.serve.cancelled")) || !existsSync(path.join(purchaseDir, "launch.serve"))).toBe(true);
        expect(alive(childPid!), "pid inventory has not run yet").toBe(true);
        raw.kill("SIGKILL");
        await once(raw, "close");
      }
      // 再起動（停止点なし）: 門の取り消し → 棚卸し（生き残りを終了）→ 終端 → 掃除。
      await startRouter(world);
      if (childPid !== undefined) await waitFor(() => !alive(childPid!), 20_000, `${point}: surviving Verifier terminated at restart`);
      const status = await statusOf(world, paymentId, quoted.body["ownerKey"]);
      expect(status.body, `${point}: ${status.text}`).toMatchObject({ status: "unknown", terminalReason: expected[point] });
      expect(existsSync(purchaseDir), `${point}: work dir removed`).toBe(false);
      expect(status.text).not.toContain("releasedHeader");
      // 再起動後に credential を再発行しない: 同じ quote の purchase の再提出は進行しない。
      const again = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId: `c-${point}`, approval: quoted.body["quoteId"], credential, ownerKey: quoted.body["ownerKey"] });
      expect(again.body["status"] ?? again.body["error"], point).not.toBe("awaiting_session");
      expect(again.text).not.toContain("releasedHeader");
      expectCanaries(world, { public: `${status.text}\n${again.text}` }, [kg.canary, kg.bodyText, ...executorSecrets(dirs, kg)], [], env.b64);
      await stopRouter(world);
    }
  }, 900_000);

  test("wrapper の 3 段（serve）: 到着を確認して Router を kill → 再起動が門を外し棚卸しを終えた後に解放しても exec されず、遅れた record も無い。公開と exec の間で wrapper を殺せば unknown", async () => {
    const world = newWorld();
    for (const stage of ["beforePid", "afterPid", "afterGate"] as const) {
      const arrive = path.join(world.control, `w-${stage}.arrive`);
      const release = path.join(world.control, `w-${stage}.release`);
      await startRouter(world, { launch: { stages: { [stage]: { arrive, release } } } });
      const dirs = payerDirs(world, `wrap-${stage}`);
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const quoted = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: `w-${stage}`, intentB64: env.b64 });
      const offer = (quoted.body["source"] as { offer: Record<string, unknown> }).offer;
      const { credential } = await credentialFor(offer);
      const pending = http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId: `w-${stage}`, approval: quoted.body["quoteId"], credential, ownerKey: quoted.body["ownerKey"] }).catch(() => undefined);
      const paymentId = String(quoted.body["paymentId"]);
      await waitFor(() => existsSync(arrive), 120_000, `wrapper arrives at ${stage}`);
      const purchaseDir = path.join(world.privateDir, paymentId);
      const wrapperPids = pidsMatching(purchaseDir);
      expect(wrapperPids.length, `${stage}: wrapper process present`).toBeGreaterThan(0);
      await killRouter(world);
      await pending;
      expect(wrapperPids.some(alive), `${stage}: wrapper survives the Router`).toBe(true);
      await startRouter(world);
      // 再起動は門を `.cancelled` にし、pid が公開済みの wrapper は棚卸しで終了させる。解放しても `exec` は起きない。
      writeFileSync(release, "1");
      await waitFor(() => pidsMatching(purchaseDir).length === 0, 20_000, `${stage}: no wrapper/binary for the purchase after release`);
      await sleep(1_500);
      expect(pidsMatching(`verifier-serve.*${paymentId}`), `${stage}: no late delivery process`).toEqual([]);
      // 遅れた公開が無い: 作業ディレクトリは消えたまま（record・addr が後から現れない）。
      expect(existsSync(purchaseDir), `${stage}: work dir stays removed`).toBe(false);
      const status = await statusOf(world, paymentId, quoted.body["ownerKey"]);
      expect(status.body).toMatchObject({ status: "unknown", terminalReason: "interrupted_before_handover", private: { artifacts: { record: "none" } } });
      await stopRouter(world);
    }
    // 公開と exec の間で wrapper 自身を殺す（Router は生きている）: 起動失敗として unknown、成果物は消える。
    {
      const arrive = path.join(world.control, "w-self.arrive");
      const release = path.join(world.control, "w-self.release");
      await startRouter(world, { launch: { stages: { afterGate: { arrive, release } } } });
      const dirs = payerDirs(world, "wrap-self");
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const quoted = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "w-self", intentB64: env.b64 });
      const offer = (quoted.body["source"] as { offer: Record<string, unknown> }).offer;
      const { credential } = await credentialFor(offer);
      const pending = http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId: "w-self", approval: quoted.body["quoteId"], credential, ownerKey: quoted.body["ownerKey"] });
      const paymentId = String(quoted.body["paymentId"]);
      await waitFor(() => existsSync(arrive), 120_000, "wrapper arrives after the gate");
      const pid = Number(readFileSync(path.join(world.privateDir, paymentId, "serve.pid"), "utf8"));
      process.kill(pid, "SIGKILL");
      const outcome = await pending;
      expect(outcome.body).toMatchObject({ status: "unknown", terminalReason: "private_verifier_unavailable" });
      expect(outcome.text).not.toContain("releasedHeader");
      expect(existsSync(path.join(world.privateDir, paymentId))).toBe(false);
      await stopRouter(world);
    }
  }, 900_000);

  test("record 公開後（journal の前）に kill → 再起動は取得専用で回復（record 取得可・attest は閉じる）。Payer は手元の bundle と record で復号できる", async () => {
    const world = newWorld();
    await startRouter(world, { stops: ["afterRecordPublish"] });
    const dirs = payerDirs(world, "rec");
    const kg = await keygen(dirs);
    const env = envelopeOf(kg.order);
    const { quote, purchase } = await quoteAndPurchase(world, env, "r-rec");
    const handover = purchase.body as unknown as Handover;
    const ownerKey = quote["ownerKey"];
    const files = await finalize(dirs, handover, env.bytes);
    const ran = await session(dirs, kg, files.orderFinal, handover.verifier.address);
    expect(ran.code, ran.stderr.slice(-800)).toBe(0);
    await waitFor(() => existsSync(path.join(world.control, `arrive.afterRecordPublish.${handover.paymentId}`)), 120_000, "record published");
    expect(existsSync(path.join(world.privateDir, handover.paymentId, "record.json"))).toBe(true);
    await killRouter(world);
    await startRouter(world);
    const status = await statusOf(world, handover.paymentId, ownerKey);
    expect(status.body).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
    const bundle = await prove(dirs, kg, files.orderFinal);
    expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_closed" } });
    const record1 = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
    const record2 = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
    expect(record1.status).toBe(200);
    expect(record1.body["recordB64"]).toBe(record2.body["recordB64"]);
    expect(readdirSync(path.join(world.privateDir, handover.paymentId))).toEqual(["record.json"]);
    const decrypted = await decrypt(dirs, kg, files, String(record1.body["recordB64"]), bundle);
    expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
    expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "POST", path: POST_PATH, body: kg.bodyText }));
    expectCanaries(world, { public: status.text, authenticated: record1.text }, [kg.canary, kg.bodyText, ...executorSecrets(dirs, kg, bundle), decrypted.plaintext!.toString("latin1")], [handover.releasedHeader.value], env.b64);
  }, LONG);

  test("attest の途中で kill（受理後・結果永続化前・verify の wrapper の 3 段）→ 再起動は attest を閉じ、遅れた verify の結果は無く、record は残り、Payer は手元で復号できる。verify の wrapper を公開と exec の間で殺せば unknown/private_verifier_unavailable", async () => {
    type Case = { readonly name: string; readonly stops?: readonly StopPoint[]; readonly stage?: "beforePid" | "afterPid" | "afterGate"; readonly selfKill?: boolean };
    const cases: readonly Case[] = [
      { name: "afterAttestAdmission", stops: ["afterAttestAdmission"] },
      { name: "beforeResultPersist", stops: ["beforeResultPersist"] },
      { name: "verify-wrapper-beforePid", stage: "beforePid" },
      { name: "verify-wrapper-afterPid", stage: "afterPid" },
      { name: "verify-wrapper-afterGate", stage: "afterGate" },
      { name: "verify-wrapper-self-kill", stage: "afterGate", selfKill: true },
    ];
    for (const c of cases) {
      const world = newWorld();
      const arrive = path.join(world.control, "v.arrive");
      const release = path.join(world.control, "v.release");
      // wrapper の段は serve にも効く: serve の到着は即座に解放し、attest の前に解放を外す。
      await startRouter(world, { ...(c.stops === undefined ? {} : { stops: c.stops }), ...(c.stage === undefined ? {} : { launch: { stages: { [c.stage]: { arrive, release } } } }) });
      const dirs = payerDirs(world, `attest-${c.name}`);
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const purchasePromise = quoteAndPurchase(world, env, `a-${c.name}`);
      if (c.stage !== undefined) {
        await waitFor(() => existsSync(arrive), 120_000, "serve wrapper arrives");
        writeFileSync(release, "1");
      }
      const { quote, purchase } = await purchasePromise;
      expect(purchase.status, `${c.name}: ${purchase.text}`).toBe(200);
      const handover = purchase.body as unknown as Handover;
      const ownerKey = quote["ownerKey"];
      const { files, bundle } = await completeSession(world, dirs, kg, handover, env.bytes, ownerKey);
      if (c.stage !== undefined) {
        unlinkSync(release);
        unlinkSync(arrive);
      }
      const purchaseDir = path.join(world.privateDir, handover.paymentId);
      const pendingAttest = http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey }).catch(() => undefined);
      if (c.selfKill === true) {
        await waitFor(() => existsSync(arrive), 120_000, "verify wrapper arrives after the gate");
        const pid = Number(readFileSync(path.join(purchaseDir, "verify.pid"), "utf8"));
        process.kill(pid, "SIGKILL");
        const outcome = await pendingAttest;
        expect(outcome?.body, outcome?.text).toMatchObject({ status: "unknown", terminalReason: "private_verifier_unavailable" });
      } else if (c.stage !== undefined) {
        await waitFor(() => existsSync(arrive), 120_000, "verify wrapper arrives");
        const wrappers = pidsMatching(purchaseDir);
        expect(wrappers.length, c.name).toBeGreaterThan(0);
        await killRouter(world);
        await pendingAttest;
        expect(wrappers.some(alive), `${c.name}: wrapper survives the Router`).toBe(true);
        await startRouter(world);
        writeFileSync(release, "1");
        await waitFor(() => pidsMatching(purchaseDir).length === 0, 20_000, `${c.name}: verify wrapper terminated, no exec`);
        await sleep(1_500);
        expect(pidsMatching(`verifier-verify.*${handover.paymentId}`)).toEqual([]);
        // 遅れた verify の結果は無い。pid の公開前で止めた wrapper だけは、解放後に（門が無いので exec せずに）pid ファイルを残し得る。
        const leftover = readdirSync(purchaseDir).filter((name) => name !== "record.json");
        expect(leftover, `${c.name}: leftovers`).toEqual(c.stage === "beforePid" ? expect.arrayContaining([]) : []);
        expect(leftover.every((name) => name === "verify.pid")).toBe(true);
        expect(existsSync(path.join(purchaseDir, "verify_result.json"))).toBe(false);
      } else {
        await waitFor(() => existsSync(path.join(world.control, `arrive.${c.stops![0]}.${handover.paymentId}`)), 700_000, `arrive at ${c.name}`);
        await killRouter(world);
        await pendingAttest;
        await startRouter(world);
      }
      const status = await statusOf(world, handover.paymentId, ownerKey);
      if (c.selfKill === true) {
        expect(status.body, `${c.name}: ${status.text}`).toMatchObject({ status: "unknown", terminalReason: "private_verifier_unavailable", private: { artifacts: { record: "available" } } });
      } else {
        expect(status.body, `${c.name}: ${status.text}`).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
      }
      if (c.selfKill === true) {
        // 受理した digest の結果は耐久（同じ bundle は同じ結果、別の digest は閉じている）。
        expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey })).toMatchObject({ status: 200, body: { status: "unknown", terminalReason: "private_verifier_unavailable" } });
        expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: tamperedProof(bundle).toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_closed" } });
      } else {
        expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_closed" } });
      }
      const record = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
      expect(record.status).toBe(200);
      expect(existsSync(path.join(purchaseDir, "record.json"))).toBe(true);
      const decrypted = await decrypt(dirs, kg, files, String(record.body["recordB64"]), bundle);
      expect(decrypted.result, c.name).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
      expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "POST", path: POST_PATH, body: kg.bodyText }));
      expectCanaries(world, { public: status.text, authenticated: record.text }, [kg.canary, kg.bodyText, ...executorSecrets(dirs, kg, bundle), decrypted.plaintext!.toString("latin1")], [handover.releasedHeader.value], env.b64);
      await stopRouter(world);
      rmSync(world.dir, { recursive: true, force: true });
      worlds.pop();
    }
  }, 4 * LONG);
});

describe.skipIf(lab.available)("秘匿購入 wire（lab 無し）", () => {
  test.skip(`未検証: lab のバイナリ・SRS・fixture CA が無いので skip（${lab.reason ?? ""}）。合格ではない`, () => {});
});
