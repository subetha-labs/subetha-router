/**
 * 秘匿購入の wire（設計 `docs/zktls-router-design.md` §11、タスク T-Z7）: lab の**実 `delivery` バイナリ**（TLSNotary MPC-TLS + UltraHonk）、lab の fixture CA、
 * **実 `startRouter`** の Router 子プロセス（`router-private-process.ts`）、EIP-3009 の署名を検証する x402 Provider fixture（`zktls-provider.ts`）、同じく署名を検証する
 * 受信 facilitator fixture。Payer 側（keygen → finalize → session → prove → decrypt）はこのテストプロセスが別プロセスで `delivery` を走らせる。
 *
 * 資金は動かない。trust は `lab-fixture-ca` → ここで得る証跡は **synthetic**（公開 PKI の受入の代わりにならない）。lab が無ければ skip（= **未検証**。合格ではない）。
 * MPC-TLS のセッションは 1 本 2 分前後、証明の生成・検証も分単位なので、各テストの上限は長い。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import { DEFAULT_DYNAMIC_LIMITS } from "../../src/config.js";
import type { StopPoint } from "../../src/core/private.js";
import { createToolHandlers, type Evidence } from "../../src/mcp/tools.js";
import { sha256File, type LaunchHooksForTest } from "../../src/private/verifier.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { labPaths, readJson, runDelivery } from "../fixtures/private/lab.js";
import { startZktlsProvider, type ZktlsProvider } from "../fixtures/private/zktls-provider.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const lab = labPaths();
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PROVIDER_PAY_TO = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const OPERATOR_PAY_TO = "0x00000000000000000000000000000000000000b0";
const PROFILE_ID = "priv-x402";
const STATIC_ROUTE = "static-x402";
const HOST = "test-server.io";
const PATHNAME = "/select";
const FACILITATOR_HOST = "facilitator.other.test";
const PRICE = "10000";
const ALICE = { id: "alice", token: "tok-alice" };
const BOB = { id: "bob", token: "tok-bob" };
const EVIDENCE: Evidence = { label: "T-Z7-synthetic-lab-fixture-ca", source: "operator_asserted", verified: false };
/** セッション 1 本 + 証明の生成・検証を含むテストの上限（ms）。 */
const LONG = 1_800_000;

let TLS: TlsMaterial;
let facilitator: VerifyingFacilitator;
let provider: ZktlsProvider;

interface World {
  readonly dir: string;
  readonly privateDir: string;
  readonly control: string;
  readonly journalPath: string;
  readonly configPath: string;
  readonly ledgerDir: string;
  router: Listening | undefined;
  /** Router 子の各世代の stdout/stderr（kill した世代も含めて canary の走査に使う）。 */
  readonly outputs: string[];
  operatorAddress: string | undefined;
}
const worlds: World[] = [];

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

function configDocument(world: World): unknown {
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
        },
        budget: { maxPurchases: 50, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "100000000", maxPerPurchase: "200000" }] },
        limits: { ...DEFAULT_DYNAMIC_LIMITS, quotesPerMinuteGlobal: 1000, quotesPerMinutePerSource: 1000, purchasesPerMinuteGlobal: 1000, purchasesPerMinutePerSource: 1000, perHostPerMinute: 1000, perAddressPerMinute: 1000 },
        denyHosts: [],
      },
      private: {
        deliveryBin: lab.bin,
        deliveryBinSha256: lab.available ? sha256File(lab.bin) : "0".repeat(64),
        srsPath: lab.srs,
        srsSha256: lab.available ? sha256File(lab.srs) : "0".repeat(64),
        profiles: [PROFILE_ID],
        workDir: world.privateDir,
        sessionTimeoutMs: 600_000,
        attestTimeoutMs: 1_800_000,
        verifyTimeoutMs: 600_000,
        retentionMs: 3_600_000,
      },
    },
    x402: { upstreams: { [STATIC_ROUTE]: "https://static.provider.test/v1/small" } },
  };
}

function newWorld(): World {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "private-x402-"));
  const world: World = { dir, privateDir: path.join(dir, "private"), control: path.join(dir, "control"), journalPath: path.join(dir, "journal.ndjson"), configPath: path.join(dir, "router.config.json"), ledgerDir: path.join(dir, "dynamic-quotes"), router: undefined, outputs: [], operatorAddress: undefined };
  mkdirSync(world.control, { recursive: true });
  writeFileSync(world.configPath, JSON.stringify(configDocument(world)));
  worlds.push(world);
  return world;
}

interface StartOptions {
  readonly stops?: readonly StopPoint[];
  readonly launch?: LaunchHooksForTest;
}
/** 制御ファイルを書き替えてから Router 子を起動する（`stops`/`launch` が無ければ既定の動き）。 */
async function startRouter(world: World, options: StartOptions = {}): Promise<Listening> {
  for (const name of readdirSync(world.control)) {
    if (name.startsWith("arrive.") || name.startsWith("release.") || name === "stops.json" || name === "launch.json") unlinkSync(path.join(world.control, name));
  }
  if (options.stops !== undefined) writeFileSync(path.join(world.control, "stops.json"), JSON.stringify({ points: options.stops }));
  if (options.launch !== undefined) writeFileSync(path.join(world.control, "launch.json"), JSON.stringify(options.launch));
  const router = await startListening(
    "tests/fixtures/private/router-private-process.ts",
    ["--control", world.control, "--dial", `${HOST}=${provider.port},${FACILITATOR_HOST}=${facilitator.port}`, "--ca", lab.rootCa, "--ca", path.join(TLS.dir, "ca.pem")],
    {
      ROUTER_CONFIG_PATH: world.configPath,
      ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token},${BOB.id}:${BOB.token}`,
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
      ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${FACILITATOR_HOST}`,
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: world.journalPath,
      ROUTER_HTTP_HOST: "127.0.0.1",
      ROUTER_HTTP_PORT: "0",
    },
    { listenTimeoutMs: 120_000 },
  );
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

async function http(world: World, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, principal = ALICE): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(`${world.router!.baseUrl}${pathname}`, { method, headers: { "x-router-principal": principal.id, authorization: `Bearer ${principal.token}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>), text };
}
function ownerHeaders(ownerKey: unknown): Record<string, string> {
  return { "x-router-owner-key": String(ownerKey) };
}

// ---------------------------------------------------------------- Payer 側（別プロセスの `delivery`）
interface PayerDirs {
  readonly root: string;
  readonly keys: string;
  readonly exec: string;
  readonly privateInbox: string;
}
interface Keygen {
  readonly orderId: string;
  readonly order: Record<string, unknown>;
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
async function keygen(dirs: PayerDirs): Promise<Keygen> {
  const orderId = `${"0".repeat(32)}${randomBytes(16).toString("hex")}`;
  const canary = `canary-${randomBytes(12).toString("hex")}`;
  const bodyText = JSON.stringify({ schema: "lab.select.v1", model: "lab-echo", prompt: canary });
  const bodyFile = path.join(dirs.root, "approved_body.json");
  writeFileSync(bodyFile, bodyText, { mode: 0o600 });
  const run = await runDelivery(lab, ["payer-keygen", "--post-profile", "canonical", "--payer-dir", dirs.keys, "--order-id", orderId, "--host", HOST, "--port", "443", "--path", PATHNAME, "--body-file", bodyFile]);
  if (run.code !== 0) throw new Error(`payer-keygen failed: ${run.stderr}`);
  const order = readJson(path.join(dirs.keys, "order.json")) as Record<string, unknown>;
  const requestPrivate = readJson(path.join(dirs.keys, "request_private.json")) as { salt_hex: string };
  const secret = readJson(path.join(dirs.keys, "secret.json")) as { sk: string };
  return { orderId, order, bodyText, canary, saltHex: requestPrivate.salt_hex, secretSk: secret.sk };
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
/** finalize（Payer）: 封筒 + Router の headerFile → order_final.json。intent/release も Payer の手元に置く。 */
async function finalize(dirs: PayerDirs, handover: Handover, intentBytes: Buffer): Promise<{ orderFinal: string; intent: string; release: string }> {
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
async function session(dirs: PayerDirs, orderFinal: string, verifierAddress: string): Promise<void> {
  const requestPrivate = path.join(dirs.privateInbox, "request_private.json");
  copyFileSync(path.join(dirs.keys, "request_private.json"), requestPrivate);
  const run = await runDelivery(lab, ["executor-session", "--executor-dir", dirs.exec, "--order", orderFinal, "--request-private", requestPrivate, "--verifier-addr", verifierAddress, "--host", HOST, "--port", "443", "--path", PATHNAME, "--trust", "lab-fixture-ca", "--timeout-secs", "600", "--connect", `127.0.0.1:${provider.port}`], { timeoutMs: 700_000 });
  if (run.code !== 0) throw new Error(`executor-session failed: ${run.stderr.slice(-2000)}`);
}
async function prove(dirs: PayerDirs, orderFinal: string): Promise<Buffer> {
  const run = await runDelivery(lab, ["executor-prove", "--executor-dir", dirs.exec, "--order", orderFinal, "--request-private", path.join(dirs.privateInbox, "request_private.json")], { timeoutMs: 900_000 });
  if (run.code !== 0) throw new Error(`executor-prove failed: ${run.stderr.slice(-2000)}`);
  return readFileSync(path.join(dirs.exec, "bundle.json"));
}
async function decrypt(dirs: PayerDirs, files: { orderFinal: string; intent: string; release: string }, recordB64: string, bundle: Buffer, resultName = "decrypt"): Promise<{ code: number | null; result: Record<string, unknown> | undefined; plaintext: Buffer | undefined }> {
  const record = path.join(dirs.root, `record-${resultName}.json`);
  const bundleFile = path.join(dirs.root, `bundle-${resultName}.json`);
  writeFileSync(record, Buffer.from(recordB64, "base64"), { mode: 0o600 });
  writeFileSync(bundleFile, bundle, { mode: 0o600 });
  const run = await runDelivery(lab, ["payer-decrypt", "--payer-dir", dirs.keys, "--order", files.orderFinal, "--record", record, "--bundle", bundleFile, "--expect-host", HOST, "--expect-port", "443", "--expect-path", PATHNAME, "--intent", files.intent, "--release", files.release, "--result-name", resultName], { timeoutMs: 600_000 });
  const resultFile = path.join(dirs.keys, `${resultName}_result.json`);
  const plaintextFile = path.join(dirs.keys, `${resultName}.bin`);
  return { code: run.code, result: existsSync(resultFile) ? (readJson(resultFile) as Record<string, unknown>) : undefined, plaintext: existsSync(plaintextFile) ? readFileSync(plaintextFile) : undefined };
}

/** quote → purchase（HTTP）。 */
async function quoteAndPurchase(world: World, env: { b64: string }, requestId: string): Promise<{ quote: Record<string, unknown>; purchase: { status: number; body: Record<string, unknown>; text: string }; inboundSignature: string }> {
  const quoted = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId, intentB64: env.b64 });
  if (quoted.status !== 200) throw new Error(`quote failed: ${quoted.text}`);
  const offer = (quoted.body["source"] as { offer: Record<string, unknown> }).offer;
  const { credential, signature } = await credentialFor(offer);
  const purchase = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId, approval: quoted.body["quoteId"], credential, ownerKey: quoted.body["ownerKey"] });
  return { quote: quoted.body, purchase, inboundSignature: signature };
}
/** purchase の後、Payer 側の工程を最後まで（finalize → session → prove）。Router は `attesting` になる。 */
async function completeSession(world: World, dirs: PayerDirs, handover: Handover, intentBytes: Buffer, ownerKey: unknown): Promise<{ files: { orderFinal: string; intent: string; release: string }; bundle: Buffer }> {
  const files = await finalize(dirs, handover, intentBytes);
  await session(dirs, files.orderFinal, handover.verifier.address);
  await waitFor(async () => (await http(world, "GET", `/v1/purchases/${handover.paymentId}`, undefined, ownerHeaders(ownerKey))).body["status"] === "attesting", 120_000, "attesting after the session");
  const bundle = await prove(dirs, files.orderFinal);
  return { files, bundle };
}

/** Router の成果物の文字列（canary の走査用）: journal・quote の控え・子の出力（全世代）・作業ディレクトリの全ファイル。 */
function routerTexts(world: World): { journal: string; ledger: string; outputs: string; work: Map<string, string> } {
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, "latin1") : "");
  const walk = (dir: string, into: Map<string, string>): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, into);
      else into.set(file, read(file));
    }
  };
  const ledger = new Map<string, string>();
  walk(world.ledgerDir, ledger);
  const work = new Map<string, string>();
  walk(world.privateDir, work);
  const live = world.router === undefined ? "" : `${world.router.stdout()}\n${world.router.stderr()}`;
  return { journal: read(world.journalPath), ledger: [...ledger.values()].join("\n"), outputs: `${world.outputs.join("\n")}\n${live}`, work };
}
/** canary の行列（tasks §canary）: `everywhere` はどこにも無い、`bearer` は作業ディレクトリの order_final/record 以外に無い。 */
function expectCanaries(world: World, responses: string, everywhere: readonly string[], bearer: readonly string[]): void {
  const texts = routerTexts(world);
  const routerSide = `${texts.journal}\n${texts.ledger}\n${texts.outputs}\n${responses}`;
  for (const value of everywhere) {
    expect(routerSide, `plaintext/secret canary in Router artifacts: ${value.slice(0, 12)}…`).not.toContain(value);
    for (const [file, text] of texts.work) expect(text, `plaintext/secret canary in ${file}`).not.toContain(value);
  }
  for (const value of bearer) {
    expect(`${texts.journal}\n${texts.ledger}\n${texts.outputs}`, "bearer in journal/ledger/child output").not.toContain(value);
    for (const [file, text] of texts.work) {
      const base = path.basename(file);
      if (base === "order_final.json" || base === "record.json") continue;
      expect(text, `bearer in ${file}`).not.toContain(value);
    }
  }
}

describe.skipIf(!lab.available)(`秘匿購入 wire: lab 実バイナリ × x402 Provider fixture（synthetic; ${lab.reason ?? "lab present"}）`, () => {
  beforeAll(async () => {
    TLS = generateTestTls();
    facilitator = await startVerifyingFacilitator({ tls: TLS });
    provider = await startZktlsProvider({ certPath: lab.serverCert, keyPath: lab.serverKey, host: HOST, network: NETWORK, asset: USDC, payTo: PROVIDER_PAY_TO, amount: PRICE, tokenDomain: { name: "USDC", version: "2" } });
  }, 120_000);
  afterAll(async () => {
    await provider?.close();
    await facilitator?.close();
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
  });

  test("HTTP 全経路: quote → purchase → finalize → session → prove → attest → record ×2 → decrypt → 平文の検証 → status。canary と mode", async () => {
    const world = newWorld();
    await startRouter(world);
    const dirs = payerDirs(world, "http");
    const kg = await keygen(dirs);
    const env = envelopeOf(kg.order);
    const probesBefore = provider.seen.probes.length;
    const { quote, purchase, inboundSignature } = await quoteAndPurchase(world, env, "r-http");
    // 探り: quote と、決済前・発行前の再照合の 3 回。Router は本文 `{}` で 402 を読んだだけ（Payer の本文は Router に渡っていない）。
    expect(provider.seen.probes.slice(probesBefore).map((probe) => probe.body)).toEqual(["{}", "{}", "{}"]);
    expect(quote["private"]).toMatchObject({ intentSha256: env.sha, method: "POST", framing: "phase5-post-json-canonical-v1", target: { host: HOST, port: 443, path: PATHNAME }, body: { len: Buffer.byteLength(kg.bodyText), commitmentHex: (kg.order["request"] as Record<string, unknown>)["body_commitment_hex"] } });
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
    // 本物の実行は Payer の executor が行う。Router は purchase の応答の後、record を待つだけ。
    expect(provider.seen.paid).toHaveLength(0);
    const { files, bundle } = await completeSession(world, dirs, handover, env.bytes, ownerKey);
    expect(provider.seen.paid).toHaveLength(1);
    expect(provider.seen.paid[0]).toMatchObject({ method: "POST", path: PATHNAME, body: kg.bodyText, payer: world.operatorAddress });
    const beforeAttest = await http(world, "GET", `/v1/purchases/${paymentId}`, undefined, ownerHeaders(ownerKey));
    expect(beforeAttest.body).toMatchObject({ status: "attesting", private: { intentSha256: env.sha, outbound: { issued: true }, artifacts: { record: "available" } } });
    // attest: Router が verifier-verify（実 UltraHonk 検証）を走らせる。
    const attested = await http(world, "POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey });
    expect(attested.body, attested.text).toMatchObject({ paymentId, status: "delivered_private", private: { proof: { delivery: true, requestBinding: true } } });
    expect(attested.status).toBe(200);
    // record は何度でも同じ。所有者違い・鍵無しは 404。
    const record1 = await http(world, "GET", `/v1/private/purchases/${paymentId}/record`, undefined, ownerHeaders(ownerKey));
    const record2 = await http(world, "GET", `/v1/private/purchases/${paymentId}/record`, undefined, ownerHeaders(ownerKey));
    expect(record1.status).toBe(200);
    expect(record1.body["recordB64"]).toBe(record2.body["recordB64"]);
    expect(record1.body["releaseB64"]).toBe(handover.releaseB64);
    expect((await http(world, "GET", `/v1/private/purchases/${paymentId}/record`, undefined, ownerHeaders(ownerKey), BOB)).status).toBe(404);
    const record = JSON.parse(Buffer.from(String(record1.body["recordB64"]), "base64").toString("utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ trust: "lab-fixture-ca", intent_binding: { intent_sha256: env.sha, release_sha256: sha256Hex(Buffer.from(handover.releaseB64, "base64")) } });
    // Payer の復号（手元で bundle を検証してから復号）: 平文 = Provider が返した本文。Provider は承認済みの本文そのものを受け取っている。
    const decrypted = await decrypt(dirs, files, String(record1.body["recordB64"]), bundle);
    expect(decrypted.code, JSON.stringify(decrypted.result)).toBe(0);
    expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
    const expectedBody = provider.respond({ method: "POST", path: PATHNAME, body: kg.bodyText });
    expect(decrypted.plaintext?.toString("utf8")).toBe(expectedBody);
    expect(JSON.parse(expectedBody)).toMatchObject({ received_sha256: sha256Hex(kg.bodyText), selection: { route: "cpu-deterministic" } });
    // status（既存の口）に private 欄。
    const status = await http(world, "GET", `/v1/purchases/${paymentId}`, undefined, ownerHeaders(ownerKey));
    expect(status.body).toMatchObject({ status: "delivered_private", private: { proof: { delivery: true, requestBinding: true }, artifacts: { record: "available" } } });
    expect(typeof (status.body["private"] as Record<string, unknown>)["outbound"]).toBe("object");
    // 作業ディレクトリ: attest 完了で record.json だけ（0600）。
    expect(readdirSync(purchaseDir)).toEqual(["record.json"]);
    expect(statSync(path.join(purchaseDir, "record.json")).mode & 0o777).toBe(0o600);
    // canary: 平文・salt・鍵・復号結果はどこにも無い。bearer（送信 credential）は journal/射影/出力に無い。受信の署名は journal/射影に無い。
    const responses = [quote, attested.body, record1.body, status.body, beforeAttest.body].map((body) => JSON.stringify(body)).join("\n");
    expectCanaries(world, responses, [kg.canary, kg.bodyText, kg.saltHex, kg.secretSk, expectedBody], [handover.releasedHeader.value]);
    expect(`${routerTexts(world).journal}\n${responses}`).not.toContain(inboundSignature);
    expect(responses).not.toContain(handover.releasedHeader.value);
    // 既存の経路は不変: 動的の購入口は秘匿 quote を知らない。
    expect((await http(world, "GET", `/v1/routes/${PROFILE_ID}/resource`, undefined, { "x-router-quote-id": String(quote["quoteId"]), ...ownerHeaders(ownerKey) })).status).toBe(402);
  }, LONG);

  test("MCP 全経路（製品の tool handler + typed client）: purchase の引き渡しだけが bearer を返し、quote/attest/record の出力には無い", async () => {
    const world = newWorld();
    await startRouter(world);
    const client = createRouterClient({ baseUrl: world.router!.baseUrl, principalId: ALICE.id, token: ALICE.token });
    const h = createToolHandlers({ client, mode: "real", evidence: EVIDENCE });
    const dirs = payerDirs(world, "mcp");
    const kg = await keygen(dirs);
    const env = envelopeOf(kg.order);
    const quoted = await h.privateQuote({ profileId: PROFILE_ID, requestId: "r-mcp", intentB64: env.b64 });
    expect(quoted).toMatchObject({ ok: true, approvalRequired: true, subject: { privatePurchase: true, private: { intentSha256: env.sha, target: { host: HOST } } } });
    const quote = quoted["quote"] as Record<string, unknown>;
    const offer = (quote["source"] as { offer: Record<string, unknown> }).offer;
    const { credential } = await credentialFor(offer);
    const purchased = await h.privatePurchase({ quoteId: String(quote["quoteId"]), requestId: "r-mcp", approval: String(quote["quoteId"]), credential, quote });
    expect(purchased).toMatchObject({ ok: true, outcome: "awaiting_session" });
    const handover = purchased["handover"] as Handover;
    expect(String(purchased["nextStep"])).toContain(handover.verifier.address);
    const ownerKey = quote["ownerKey"];
    const { files, bundle } = await completeSession(world, dirs, handover, env.bytes, ownerKey);
    const attested = await h.privateAttest({ paymentId: handover.paymentId, ownerKey: String(ownerKey), bundleB64: bundle.toString("base64") });
    expect(attested).toMatchObject({ ok: true, status: "delivered_private" });
    const record1 = await h.privateRecord({ paymentId: handover.paymentId, ownerKey: String(ownerKey) });
    const record2 = await h.privateRecord({ paymentId: handover.paymentId, ownerKey: String(ownerKey) });
    expect(record1).toMatchObject({ ok: true });
    expect(record1["recordB64"]).toBe(record2["recordB64"]);
    const decrypted = await decrypt(dirs, files, String(record1["recordB64"]), bundle);
    expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
    expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "POST", path: PATHNAME, body: kg.bodyText }));
    const outputs = [quoted, attested, record1].map((out) => JSON.stringify(out)).join("\n");
    expect(outputs).not.toContain(handover.releasedHeader.value);
    expectCanaries(world, outputs, [kg.canary, kg.bodyText, kg.saltHex, kg.secretSk], [handover.releasedHeader.value]);
  }, LONG);

  test("否定ケース（セッション無し）: port≠443、payTo 不一致、record 未完成、attest 未完成、所有者違い、サイズ超過、受信 credential の再使用", async () => {
    const world = newWorld();
    await startRouter(world);
    const dirs = payerDirs(world, "neg");
    const kg = await keygen(dirs);
    // port ≠ 443 は invalid_intent。
    const badPort = envelopeOf({ ...kg.order, target: { ...(kg.order["target"] as Record<string, unknown>), port: 8443 } });
    expect(await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "n1", intentB64: badPort.b64 })).toMatchObject({ status: 400, body: { error: "invalid_intent" } });
    // 封筒の payTo が Provider の提示と違えば quote で止まる（Router は提示を本文なしで読み、封筒と照合する）。
    const badPayTo = envelopeOf(kg.order, { outbound: { payTo: "0x0000000000000000000000000000000000000a11" } });
    const mismatch = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "n2", intentB64: badPayTo.b64 });
    expect(mismatch.status, mismatch.text).toBeGreaterThanOrEqual(400);
    expect(provider.seen.paid).toHaveLength(0);
    // 正常な quote → purchase。record/attest はまだ。
    const env = envelopeOf(kg.order);
    const { quote, purchase } = await quoteAndPurchase(world, env, "n3");
    expect(purchase.status).toBe(200);
    const handover = purchase.body as unknown as Handover;
    const ownerKey = quote["ownerKey"];
    expect((await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey))).status).toBe(409);
    // 形の壊れた bundle は 400、形は正しいが別注文の bundle（golden）はセッション前なので 409（attest_not_ready / attest_foreign。どちらも状態を変えない）。
    expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: Buffer.from("{}").toString("base64"), ownerKey })).toMatchObject({ status: 400, body: { error: "invalid_bundle" } });
    const goldenBundle = Buffer.from(JSON.stringify({ public: { order_id: kg.orderId, payer_pk: kg.order["payer_pk"], committed_hash_hex: "b".repeat(64), payload_len: 196 }, proof_hex: "00", request: { public: { tls_body_hash_hex: "d".repeat(64), tls_cred_hash_hex: "c".repeat(64), payer_commitment_hex: (kg.order["request"] as Record<string, unknown>)["body_commitment_hex"], body_len: Buffer.byteLength(kg.bodyText), cred_len: 39 }, proof_hex: "00" } }));
    const early = await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: goldenBundle.toString("base64"), ownerKey });
    expect(early.status, early.text).toBe(409);
    expect(["attest_not_ready", "attest_foreign"]).toContain(early.body["error"]);
    expect((await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: goldenBundle.toString("base64"), ownerKey: "wrong" })).status).toBe(404);
    expect((await http(world, "GET", `/v1/purchases/${handover.paymentId}`, undefined, ownerHeaders(ownerKey), BOB)).status).toBe(404);
    expect((await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: "A".repeat(400_000), ownerKey })).status).toBe(413);
    // 同じ受信 credential（同じ nonce）で別の秘匿購入は通らない（facilitator が nonce を見る・Router が inbound の一意性を見る）。
    const dirs2 = payerDirs(world, "neg2");
    const kg2 = await keygen(dirs2);
    const env2 = envelopeOf(kg2.order);
    const quoted2 = await http(world, "POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "n4", intentB64: env2.b64 });
    expect(quoted2.status).toBe(200);
    const offer1 = (quote["source"] as { offer: Record<string, unknown> }).offer;
    const { credential: reused } = await credentialFor(offer1);
    const replay = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted2.body["quoteId"], requestId: "n4", approval: quoted2.body["quoteId"], credential: reused, ownerKey: quoted2.body["ownerKey"] });
    expect(replay.status, replay.text).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(replay.body)).not.toContain("PAYMENT-SIGNATURE\":{\"value");
    // 生きている Verifier を片付ける（purchase n3 のセッションは始めない）。
    const pid = Number(readFileSync(path.join(world.privateDir, handover.paymentId, "serve.pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    await stopRouter(world);
    await waitFor(() => !alive(pid), 15_000, "verifier child stops with the Router");
  }, 300_000);

  test("セッション前の停止点で Router を SIGKILL → 再起動で終端・生き残った Verifier の終了・成果物の掃除（+ 棚卸し中の kill）", async () => {
    const expected: Record<string, readonly string[]> = {
      afterReserve: ["interrupted_before_release"],
      afterRelease: ["interrupted_before_handover"],
      afterLaunchGate: ["interrupted_before_handover"],
      afterSpawn: ["interrupted_before_handover"],
      afterHandoverJournal: ["interrupted_after_release"],
    };
    const world = newWorld();
    const seen: Record<string, unknown> = {};
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
      // 再起動（停止点なし）: 門の取り消し → 棚卸し（生き残りを終了）→ 終端 → 掃除。
      await startRouter(world);
      if (childPid !== undefined) await waitFor(() => !alive(childPid!), 20_000, `${point}: surviving Verifier terminated at restart`);
      const status = await http(world, "GET", `/v1/purchases/${paymentId}`, undefined, ownerHeaders(quoted.body["ownerKey"]));
      seen[point] = { status: status.body["status"], terminalReason: status.body["terminalReason"] };
      expect(status.body["status"], point).toBe("unknown");
      expect(expected[point], `${point}: ${status.text}`).toContain(status.body["terminalReason"]);
      expect(existsSync(purchaseDir), `${point}: work dir removed`).toBe(false);
      expect(status.text).not.toContain("PAYMENT-SIGNATURE\":{\"value");
      // 再起動後に credential を再発行しない: 同じ quote の purchase の再提出は進行しない。
      const again = await http(world, "POST", "/v1/private/purchases", { quoteId: quoted.body["quoteId"], requestId: `c-${point}`, approval: quoted.body["quoteId"], credential, ownerKey: quoted.body["ownerKey"] });
      expect(again.body["status"] ?? again.body["error"], point).not.toBe("awaiting_session");
      expectCanaries(world, status.text, [kg.canary, kg.bodyText, kg.saltHex, kg.secretSk], []);
      if (point === "afterHandoverJournal") {
        // 棚卸し中の kill: もう一度止めて殺し、再起動しても同じ終端。
        await stopRouter(world);
        await startRouter(world, { stops: ["duringRecoveryInventory"] }).catch(() => undefined);
        // 棚卸し中は listening しないので、起動待ちではなく arrive を待つ。
        await waitFor(() => readdirSync(world.control).some((name) => name.startsWith("arrive.duringRecoveryInventory.")), 60_000, "arrive during inventory");
        for (const pid of pidsMatching(world.control)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 既に終わっている。
          }
        }
        world.router = undefined;
        await startRouter(world);
        const after = await http(world, "GET", `/v1/purchases/${paymentId}`, undefined, ownerHeaders(quoted.body["ownerKey"]));
        expect(after.body).toMatchObject({ status: "unknown", terminalReason: status.body["terminalReason"] });
      }
      await stopRouter(world);
    }
    expect(Object.keys(seen)).toHaveLength(5);
  }, 900_000);

  test("wrapper の 3 段（serve）: 到着を確認して Router を kill → 再起動が門を外し棚卸しを終えた後に解放しても exec されない。公開と exec の間で wrapper を殺せば unknown", async () => {
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
      await sleep(500);
      expect(pidsMatching(`verifier-serve.*${paymentId}`), `${stage}: no late delivery process`).toEqual([]);
      const status = await http(world, "GET", `/v1/purchases/${paymentId}`, undefined, ownerHeaders(quoted.body["ownerKey"]));
      expect(status.body).toMatchObject({ status: "unknown", terminalReason: "interrupted_before_handover" });
      expect(existsSync(purchaseDir), `${stage}: work dir removed`).toBe(false);
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
    await session(dirs, files.orderFinal, handover.verifier.address);
    await waitFor(() => existsSync(path.join(world.control, `arrive.afterRecordPublish.${handover.paymentId}`)), 120_000, "record published");
    expect(existsSync(path.join(world.privateDir, handover.paymentId, "record.json"))).toBe(true);
    await killRouter(world);
    await startRouter(world);
    const status = await http(world, "GET", `/v1/purchases/${handover.paymentId}`, undefined, ownerHeaders(ownerKey));
    expect(status.body).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
    const bundle = await prove(dirs, files.orderFinal);
    expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_closed" } });
    const record1 = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
    const record2 = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
    expect(record1.status).toBe(200);
    expect(record1.body["recordB64"]).toBe(record2.body["recordB64"]);
    expect(readdirSync(path.join(world.privateDir, handover.paymentId))).toEqual(["record.json"]);
    const decrypted = await decrypt(dirs, files, String(record1.body["recordB64"]), bundle);
    expect(decrypted.result).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
    expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "POST", path: PATHNAME, body: kg.bodyText }));
    expectCanaries(world, `${status.text}\n${record1.text}`, [kg.canary, kg.bodyText, kg.saltHex, kg.secretSk], [handover.releasedHeader.value]);
  }, LONG);

  test("attest の途中で kill（受理後・結果永続化前・verify の wrapper の段）→ 再起動は attest を閉じ、record は残り、Payer は手元で復号できる", async () => {
    const cases: readonly { readonly name: string; readonly stops?: readonly StopPoint[]; readonly launch?: boolean }[] = [
      { name: "afterAttestAdmission", stops: ["afterAttestAdmission"] },
      { name: "beforeResultPersist", stops: ["beforeResultPersist"] },
      { name: "verify-wrapper-afterPid", launch: true },
    ];
    for (const c of cases) {
      const world = newWorld();
      const arrive = path.join(world.control, "v.arrive");
      const release = path.join(world.control, "v.release");
      // wrapper の段は serve にも効く: serve の到着は即座に解放し、attest の前に解放を外す。
      await startRouter(world, { ...(c.stops === undefined ? {} : { stops: c.stops }), ...(c.launch === true ? { launch: { stages: { afterPid: { arrive, release } } } } : {}) });
      const dirs = payerDirs(world, `attest-${c.name}`);
      const kg = await keygen(dirs);
      const env = envelopeOf(kg.order);
      const purchasePromise = quoteAndPurchase(world, env, `a-${c.name}`);
      if (c.launch === true) {
        await waitFor(() => existsSync(arrive), 120_000, "serve wrapper arrives");
        writeFileSync(release, "1");
      }
      const { quote, purchase } = await purchasePromise;
      const handover = purchase.body as unknown as Handover;
      const ownerKey = quote["ownerKey"];
      const { files, bundle } = await completeSession(world, dirs, handover, env.bytes, ownerKey);
      if (c.launch === true) {
        unlinkSync(release);
        unlinkSync(arrive);
      }
      const pendingAttest = http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey }).catch(() => undefined);
      if (c.launch === true) {
        await waitFor(() => existsSync(arrive), 120_000, "verify wrapper arrives");
        const wrappers = pidsMatching(path.join(world.privateDir, handover.paymentId));
        expect(wrappers.length).toBeGreaterThan(0);
        await killRouter(world);
        await pendingAttest;
        await startRouter(world);
        writeFileSync(release, "1");
        await waitFor(() => pidsMatching(path.join(world.privateDir, handover.paymentId)).length === 0, 20_000, "verify wrapper terminated, no exec");
        expect(pidsMatching(`verifier-verify.*${handover.paymentId}`)).toEqual([]);
      } else {
        await waitFor(() => existsSync(path.join(world.control, `arrive.${c.stops![0]}.${handover.paymentId}`)), 700_000, `arrive at ${c.name}`);
        await killRouter(world);
        await pendingAttest;
        await startRouter(world);
      }
      const status = await http(world, "GET", `/v1/purchases/${handover.paymentId}`, undefined, ownerHeaders(ownerKey));
      expect(status.body, `${c.name}: ${status.text}`).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
      expect(await http(world, "POST", `/v1/private/purchases/${handover.paymentId}/attest`, { bundleB64: bundle.toString("base64"), ownerKey })).toMatchObject({ status: 409, body: { error: "attest_closed" } });
      const record = await http(world, "GET", `/v1/private/purchases/${handover.paymentId}/record`, undefined, ownerHeaders(ownerKey));
      expect(record.status).toBe(200);
      expect(readdirSync(path.join(world.privateDir, handover.paymentId))).toEqual(["record.json"]);
      const decrypted = await decrypt(dirs, files, String(record.body["recordB64"]), bundle);
      expect(decrypted.result, c.name).toMatchObject({ ok: true, verified_bundle_before_decrypt: true });
      expect(decrypted.plaintext?.toString("utf8")).toBe(provider.respond({ method: "POST", path: PATHNAME, body: kg.bodyText }));
      expectCanaries(world, `${status.text}\n${record.text}`, [kg.canary, kg.bodyText, kg.saltHex, kg.secretSk], [handover.releasedHeader.value]);
      await stopRouter(world);
      rmSync(world.dir, { recursive: true, force: true });
      worlds.pop();
    }
  }, 3 * LONG);
});

describe.skipIf(lab.available)("秘匿購入 wire（lab 無し）", () => {
  test.skip(`未検証: lab のバイナリ・SRS・fixture CA が無いので skip（${lab.reason ?? ""}）。合格ではない`, () => {});
});
