/**
 * EVM testnet の受け入れの driver（`tools/evm-testnets-e2e.ts`。設計 §3.8・§3.9、FR-E7・FR-E8、タスク E-4b）。fake の MCP・chain で（network なし）:
 * plan の hash の安定と改ざんの拒否、subject と plan の不一致で署名の前に止まる、受信が delivered でない chain の送信は始めない、delivered でない結果で
 * 再試行せずに止まる、Transfer の不一致で止まる、秘密が証跡・stdout に出ない、`--only` が 1 件だけ選ぶ。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import {
  attemptMarkerPathOf,
  createAttemptMarker,
  isUnsealedBlockHash,
  setDirSyncForTest,
  BASE_SEPOLIA,
  buildPlan,
  loadApprovedPlan,
  planSha256,
  PlanRefusal,
  runFinality,
  runPurchases,
  runReopen,
  runSignSigner,
  Secrets,
  subjectMismatches,
  TRANSFER_TOPIC,
  writeSummary,
  type ChainReader,
  type McpCaller,
  type Plan,
  type PlanPurchase,
  type PurchaseEvidence,
  type ReceiptInfo,
  type Signer,
} from "../../tools/evm-testnets-e2e.js";
import { EVM_TESTNETS, INBOUND } from "../../tools/remote-mcp-config.js";

const PAYER_KEY = generatePrivateKey();
const PAYER = privateKeyToAccount(PAYER_KEY).address;
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const FACILITATOR = "0x54633d372d7316435891EEBBaAB90861F8c1Dadc";
const PROVIDER = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const PROVIDER_A = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const FACILITATOR_TOKEN = "fac-token-0123456789abcdefghijklmnopqrstuv";
const BEARER = "mcp-bearer-secret-0123456789";
const OUTBOUND_KEY = generatePrivateKey();
const FIXED_NOW = new Date("2026-10-13T12:00:00.000Z");

const addressEnv = {
  SUBETHA_PAYER_ADDRESS: PAYER,
  SUBETHA_ROUTER_RECEIVER: RECEIVER,
  EVM_FACILITATOR_ADDRESS: FACILITATOR,
  SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER,
};
const secretEnv = {
  ...addressEnv,
  SUBETHA_PAYER_ADDRESS: undefined,
  SUBETHA_PAYER_PRIVATE_KEY: PAYER_KEY,
  SUBETHA_OUTBOUND_PRIVATE_KEY: OUTBOUND_KEY,
  SUBETHA_ROUTER_OUTBOUND_ADDRESS: RECEIVER,
  EVM_FACILITATOR_TOKEN: FACILITATOR_TOKEN,
  SUBETHA_EVM_FACILITATOR_URL: `http://127.0.0.1:8611/${FACILITATOR_TOKEN}`,
  E2E_TOKEN: BEARER,
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "evm-e2e-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ fake chain */

const pad = (address: string): string => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const hex64 = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

class FakeChain implements ChainReader {
  readonly receipts = new Map<string, ReceiptInfo>();
  finalized = 1_000_000n;
  tokenReads = 0;
  async tokenBalance(_network: string, _asset: string, _owner: string): Promise<bigint> {
    this.tokenReads += 1;
    return 1_000_000n;
  }
  async nativeBalance(): Promise<bigint> {
    return 1_000_000_000_000_000_000n;
  }
  async feeEstimate(): Promise<bigint> {
    return 100_000_000n;
  }
  async receipt(_network: string, hash: string): Promise<ReceiptInfo | undefined> {
    return this.receipts.get(hash.toLowerCase());
  }
  async finalizedBlock(): Promise<bigint | undefined> {
    return this.finalized;
  }
  addTransfer(hash: string, asset: string, from: string, to: string, value: bigint, block = 100n): void {
    this.receipts.set(hash.toLowerCase(), {
      status: "success",
      blockNumber: block,
      blockHash: hex64(Number(block) + 7),
      logs: [{ address: asset, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: `0x${value.toString(16).padStart(64, "0")}` }],
    });
  }
}

/* ------------------------------------------------------------------ fake Router MCP */

interface FakeBehaviour {
  /** routeId → 変える欄（quote の応答）。 */
  quoteTamper?: (routeId: string, response: Record<string, unknown>) => void;
  /** routeId → purchase の outcome（既定 delivered）。 */
  outcomeOf?: (routeId: string) => string;
  /** routeId → 送信レグの Transfer の値（既定は計画どおり）。 */
  destinationValueOf?: (routeId: string) => bigint;
  /** purchase の応答に混ぜる文字列（秘密が漏れても証跡に出ないこと）。 */
  echo?: (credential: string) => Record<string, unknown>;
}

class FakeMcp implements McpCaller {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly statuses = new Map<string, Record<string, unknown>>();
  #n = 0;
  constructor(
    private readonly plan: Plan,
    private readonly chain: FakeChain,
    private readonly behaviour: FakeBehaviour = {},
  ) {}
  async close(): Promise<void> {}
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ name, args });
    if (name === "subetha_router_quote") return this.quote(String(args["routeId"]));
    if (name === "subetha_router_purchase") return this.purchase(args);
    if (name === "subetha_router_status") return this.statuses.get(String(args["paymentId"])) ?? { found: false };
    throw new Error(`unexpected tool ${name}`);
  }
  private planned(routeId: string): PlanPurchase {
    const p = this.plan.purchases.find((x) => x.routeId === routeId);
    if (p === undefined) throw new Error(`no planned ${routeId}`);
    return p;
  }
  private quote(routeId: string): Record<string, unknown> {
    this.#n += 1;
    const p = this.planned(routeId);
    const quoteId = hex64(0xabc000 + this.#n);
    const paymentId = `pay-${String(this.#n)}`;
    const domain = p.source.network === BASE_SEPOLIA ? { name: "USDC", version: "2" } : EVM_TESTNETS[p.chain].domain;
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const offer = { scheme: "exact", network: p.source.network, asset: p.source.asset, amount: p.source.amount, payTo: p.source.to, maxTimeoutSeconds: 60, extra: { name: domain.name, version: domain.version, challengeNonce: quoteId, expiresAt, routeBinding: `rb-${routeId}`, fundsMoveOnCredential: false } };
    const approval = { required: true, boundTo: quoteId, deadlineMs: Date.now() + 600_000 };
    const quote = {
      quoteId,
      paymentId,
      routeId,
      resource: { url: `http://127.0.0.1/v1/routes/${routeId}/resource`, method: "GET" },
      source: { amount: p.source.amount, asset: p.source.asset, network: p.source.network, offer },
      destination: { quoted: p.destination.amount, asset: p.destination.asset, network: p.destination.network, payTo: p.destination.to, quoteFingerprint: "sha256:00" },
      approval,
    };
    const subject = {
      quoteId,
      paymentId,
      routeId,
      resource: quote.resource,
      source: { amount: p.source.amount, decimals: 6, asset: p.source.asset, network: p.source.network, expiresAt, offer },
      destination: { quoted: p.destination.amount, asset: p.destination.asset, network: p.destination.network },
      approval,
      fundsMoveOnCredential: false,
    };
    const response: Record<string, unknown> = { ok: true, approvalRequired: true, quote, subject, nextStep: "approve" };
    this.behaviour.quoteTamper?.(routeId, response);
    return response;
  }
  private purchase(args: Record<string, unknown>): Record<string, unknown> {
    const quote = args["quote"] as { routeId: string; paymentId: string; quoteId: string };
    if (args["approval"] !== quote.quoteId) return { ok: false, error: "approval_required" };
    const p = this.planned(quote.routeId);
    const outcome = this.behaviour.outcomeOf?.(quote.routeId) ?? "delivered";
    const n = Number(quote.paymentId.slice(4));
    const srcHash = hex64(0x5000 + n);
    const dstHash = hex64(0xd000 + n);
    const body = { providerId: "p", market: "ETH/USDC", fetchedAt: "2026-10-13T12:00:00Z", data: { priceUsdcPerWeth: "1" }, note: `facilitator ${FACILITATOR_TOKEN}` };
    this.chain.addTransfer(srcHash, p.source.asset, p.source.from, p.source.to, BigInt(p.source.amount));
    this.chain.addTransfer(dstHash, p.destination.asset, p.destination.from, p.destination.to, this.behaviour.destinationValueOf?.(quote.routeId) ?? BigInt(p.destination.amount));
    const status = outcome === "delivered" ? "delivered" : outcome === "paid_data_unavailable" ? "paid_data_unavailable" : "unknown";
    this.statuses.set(quote.paymentId, {
      found: true,
      projection: {
        paymentId: quote.paymentId,
        routeId: quote.routeId,
        status,
        source: { amount: p.source.amount, asset: p.source.asset, network: p.source.network, txRef: srcHash },
        destination: { quoted: p.destination.amount, asset: p.destination.asset, network: p.destination.network, attempt: 1, outcome: "paid", ...(outcome === "delivered" ? { txRef: dstHash } : {}) },
        quoteFingerprint: "sha256:00",
        updatedAt: "2026-10-13T12:00:01.000Z",
        ...(outcome === "delivered" ? { result: body } : {}),
      },
    });
    const echo = this.behaviour.echo?.(String(args["credential"])) ?? {};
    return outcome === "delivered" ? { ok: true, outcome, paymentId: quote.paymentId, snapshot: body, contentType: "application/json", ...echo } : { ok: false, outcome, paymentId: quote.paymentId, reason: "destination_pay_unknown", ...echo };
  }
  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }
}

async function planOf(env: Record<string, string | undefined> = addressEnv): Promise<Plan> {
  return buildPlan(["rh", "arbsep", "hyperevm", "sepolia"], env, new FakeChain(), () => FIXED_NOW);
}

function countingSigner(): Signer & { calls: number } {
  const signer = (async (quote: unknown) => {
    signer.calls += 1;
    const network = (quote as { source: { network: string } }).source.network;
    return { ok: true as const, credential: "c3ludGhldGljLWNyZWRlbnRpYWwtZm9yLXRlc3Rz", chainId: Number(network.split(":")[1]) };
  }) as unknown as Signer & { calls: number };
  signer.calls = 0;
  return signer;
}

function realSigner(): Signer {
  return runSignSigner(secretEnv);
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

interface Harness {
  readonly plan: Plan;
  readonly sha: string;
  readonly chain: FakeChain;
  readonly mcp: FakeMcp;
  readonly evidenceDir: string;
  readonly lines: string[];
  readonly secrets: Secrets;
}
async function harness(behaviour: FakeBehaviour = {}, env: Record<string, string | undefined> = addressEnv): Promise<Harness> {
  const plan = await planOf(env);
  const chain = new FakeChain();
  return { plan, sha: planSha256(plan), chain, mcp: new FakeMcp(plan, chain, behaviour), evidenceDir: tempDir(), lines: [], secrets: Secrets.fromEnv(env, ["E2E_TOKEN"]) };
}
let tick = 0;
const START = Date.now();
function deps(h: Harness, sign: Signer): Parameters<typeof runPurchases>[1] {
  return {
    mcp: h.mcp,
    chain: h.chain,
    sign,
    secrets: h.secrets,
    out: (line) => h.lines.push(line),
    // 1 秒ずつ進む時計（run の id が呼び出しごとに別になる）。
    // quote の期限（実時刻 + 600 秒）の内に収まる幅で進む。
    now: () => new Date(START + 100 * ++tick),
    sleep: async () => {},
    receiptWaitMs: 0,
  };
}

/* ------------------------------------------------------------------ plan */

describe("plan", () => {
  test("8 purchases in order (inbound then outbound per chain) with the generated route terms", async () => {
    const plan = await planOf();
    expect(plan.purchases.map((p) => p.routeId)).toEqual([
      "md-x402-eth-snapshot-rh",
      "md-rh-eth-snapshot",
      "md-x402-eth-snapshot-arbsep",
      "md-arbsep-eth-snapshot",
      "md-x402-eth-snapshot-hyperevm",
      "md-hyperevm-eth-snapshot",
      "md-x402-eth-snapshot-sepolia",
      "md-sepolia-eth-snapshot",
    ]);
    const rhIn = plan.purchases[0] as PlanPurchase;
    expect(rhIn.source).toMatchObject({ network: "eip155:46630", asset: EVM_TESTNETS.rh.asset, amount: "10000", decimals: 6, from: PAYER, to: RECEIVER, facilitator: "self-hosted", gasPayer: FACILITATOR, gasLimitPerSettle: "200000" });
    expect(rhIn.destination).toMatchObject({ network: BASE_SEPOLIA, asset: INBOUND.asset, from: RECEIVER, to: PROVIDER_A, facilitator: "x402.org", gasPayer: null });
    const rhOut = plan.purchases[1] as PlanPurchase;
    expect(rhOut.source).toMatchObject({ network: BASE_SEPOLIA, from: PAYER, to: RECEIVER, facilitator: "x402.org" });
    expect(rhOut.destination).toMatchObject({ network: "eip155:46630", from: RECEIVER, to: PROVIDER, facilitator: "self-hosted", gasPayer: FACILITATOR });
    expect(plan.allSufficient).toBe(true);
  });

  test("the hash is stable across key order and refuses a tampered plan or a different hash", async () => {
    const a = await planOf();
    const b = await planOf();
    expect(planSha256(a)).toBe(planSha256(b));
    // 鍵の順を逆にしても同じ hash（canonical）。
    const reversed = JSON.parse(JSON.stringify(a, (_k, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))) as unknown;
    expect(planSha256(reversed)).toBe(planSha256(a));
    const dir = tempDir();
    const file = path.join(dir, "plan.json");
    writeFileSync(file, JSON.stringify(a, null, 2));
    const sha = planSha256(a);
    expect(loadApprovedPlan(file, sha).purchases).toHaveLength(8);
    expect(() => loadApprovedPlan(file, "0".repeat(64))).toThrow(PlanRefusal);
    // 1 か所の改ざん（送信の受取先）で拒む。
    const tampered = JSON.parse(readFileSync(file, "utf8")) as { purchases: { destination: { to: string } }[] };
    (tampered.purchases[1] as { destination: { to: string } }).destination.to = "0x000000000000000000000000000000000000dEaD";
    writeFileSync(file, JSON.stringify(tampered));
    expect(() => loadApprovedPlan(file, sha)).toThrow(/not the approved/);
  });

  test("a payer short of funds is reported at the purchase where it runs out", async () => {
    const chain = new FakeChain();
    chain.tokenBalance = async (network: string, _asset: string, owner: string) => (owner.toLowerCase() === PAYER.toLowerCase() && network === BASE_SEPOLIA ? 25_000n : 1_000_000n);
    const plan = await buildPlan(["rh", "arbsep", "hyperevm", "sepolia"], addressEnv, chain, () => FIXED_NOW);
    expect(plan.allSufficient).toBe(false);
    const short = plan.checks.find((c) => !c.ok);
    expect(short).toMatchObject({ role: "payer", network: BASE_SEPOLIA });
    expect(short?.note).toContain("md-hyperevm-eth-snapshot");
  });
});

/* ------------------------------------------------------------------ run */

describe("run", () => {
  test("subject/plan mismatch stops before signing (no credential, no purchase)", async () => {
    const h = await harness({
      quoteTamper: (_routeId, response) => {
        const quote = response["quote"] as { destination: { payTo: string } };
        quote.destination.payTo = "0x000000000000000000000000000000000000dEaD";
      },
    });
    const signer = countingSigner();
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, signer));
    expect(report.stopped).toMatchObject({ routeId: "md-x402-eth-snapshot-rh", stage: "stopped_before_signing" });
    expect(signer.calls).toBe(0);
    expect(h.mcp.count("subetha_router_purchase")).toBe(0);
    expect(h.mcp.count("subetha_router_quote")).toBe(1);
    const evidence = JSON.parse(readFileSync(path.join(report.runDir, "purchases", "md-x402-eth-snapshot-rh.json"), "utf8")) as { mismatches: string[] };
    expect(evidence.mismatches.join(" ")).toContain("quote.destination.payTo");
  });

  for (const [label, change] of [
    ["recipient", (offer: { payTo: string; amount: string }) => (offer.payTo = PROVIDER)],
    ["amount", (offer: { payTo: string; amount: string }) => (offer.amount = "19999")],
  ] as const) {
    test(`the offer that would be signed (quote.source.offer) differing from the approved subject offer in ${label} stops before signing`, async () => {
      const h = await harness({
        quoteTamper: (_routeId, response) => {
          // subject は計画どおりのまま、署名に渡る quote 文書の offer だけを変える（subject と quote は別の object にする）。
          const quote = JSON.parse(JSON.stringify(response["quote"])) as { source: { offer: { payTo: string; amount: string } } };
          change(quote.source.offer);
          response["quote"] = quote;
        },
      });
      const signer = countingSigner();
      const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, signer));
      expect(report.stopped).toMatchObject({ routeId: "md-x402-eth-snapshot-rh", stage: "stopped_before_signing" });
      expect(report.stopped?.reason).toContain("differs from subject.source.offer");
      expect(report.stopped?.reason).toContain(`signed offer.${label === "recipient" ? "payTo" : "amount"}`);
      expect(signer.calls).toBe(0);
      expect(h.mcp.count("subetha_router_purchase")).toBe(0);
    });
  }

  test("the signer and the purchase receive exactly the validated (frozen) quote document", async () => {
    const h = await harness();
    const seen: unknown[] = [];
    const signer: Signer = async (quote) => {
      seen.push(quote);
      expect(Object.isFrozen(quote)).toBe(true);
      const network = (quote as { source: { network: string } }).source.network;
      return { ok: true, credential: "c3ludGhldGljLWNyZWRlbnRpYWwtZm9yLXRlc3Rz", chainId: Number(network.split(":")[1]) };
    };
    await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-x402-eth-snapshot-rh" }, deps(h, signer));
    const purchase = h.mcp.calls.find((c) => c.name === "subetha_router_purchase");
    expect(seen).toHaveLength(1);
    expect(purchase?.args["quote"]).toBe(seen[0]);
  });

  test("subjectMismatches catches the amount, network, recipient and a funds-moving offer", async () => {
    const plan = await planOf();
    const h = new FakeMcp(plan, new FakeChain());
    const base = await h.call("subetha_router_quote", { routeId: "md-rh-eth-snapshot", requestId: "r" });
    const planned = plan.purchases[1] as PlanPurchase;
    expect(subjectMismatches(base, planned, Date.now())).toEqual([]);
    const variants: ((r: Record<string, unknown>) => void)[] = [
      (r) => ((r["subject"] as { source: { amount: string } }).source.amount = "10001"),
      (r) => ((r["subject"] as { destination: { network: string } }).destination.network = "eip155:421614"),
      (r) => (((r["subject"] as { source: { offer: { payTo: string } } }).source.offer.payTo = PROVIDER)),
      (r) => ((r["subject"] as { fundsMoveOnCredential: boolean }).fundsMoveOnCredential = true),
    ];
    for (const change of variants) {
      const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      change(copy);
      expect(subjectMismatches(copy, planned, Date.now()).length).toBeGreaterThan(0);
    }
  });

  test("outbound is refused when the inbound on that chain was not delivered (no quote)", async () => {
    const h = await harness();
    const signer = countingSigner();
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-rh-eth-snapshot" }, deps(h, signer));
    expect(report.stopped).toMatchObject({ routeId: "md-rh-eth-snapshot", stage: "not_started" });
    expect(report.stopped?.reason).toContain("no delivered and verified inbound");
    expect(h.mcp.calls).toHaveLength(0);
  });

  test("outbound waits for the inbound source tx to be final and refuses when it is not final in time", async () => {
    const h = await harness();
    const signer = countingSigner();
    const inbound = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-x402-eth-snapshot-rh", inboundConfirmation: "receipt" }, deps(h, signer));
    expect(inbound.stopped).toBeUndefined();
    h.chain.finalized = 50n; // tx は block 100
    const outbound = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-rh-eth-snapshot", waitFinalizedSeconds: 0 }, deps(h, signer));
    expect(outbound.stopped).toMatchObject({ stage: "not_started" });
    expect(outbound.stopped?.reason).toContain("not final");
    expect(h.mcp.count("subetha_router_quote")).toBe(1);
    h.chain.finalized = 200n;
    const later = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-rh-eth-snapshot", waitFinalizedSeconds: 0 }, deps(h, signer));
    expect(later.stopped).toBeUndefined();
    // 1 つの受信の入金は 1 回の送信にだけ数える。
    const again = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-rh-eth-snapshot", waitFinalizedSeconds: 0 }, deps(h, signer));
    expect(again.stopped?.stage).toBe("not_started");
  });

  test("a non-delivered outcome stops the whole run without retry, and a re-run of the same plan does not start it again", async () => {
    const h = await harness({ outcomeOf: (routeId) => (routeId === "md-x402-eth-snapshot-rh" ? "unknown" : "delivered") });
    const signer = countingSigner();
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, signer));
    expect(report.stopped).toMatchObject({ routeId: "md-x402-eth-snapshot-rh", paymentId: "pay-1" });
    expect(h.mcp.count("subetha_router_quote")).toBe(1);
    expect(h.mcp.count("subetha_router_purchase")).toBe(1);
    expect(signer.calls).toBe(1);
    expect(h.lines.join("\n")).toMatch(/STOP md-x402-eth-snapshot-rh: .*paymentId pay-1, status "unknown"/);
    const rerun = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, signer));
    expect(rerun.stopped?.reason).toContain("already attempted under this plan");
    expect(h.mcp.count("subetha_router_quote")).toBe(1);
    expect(h.mcp.count("subetha_router_purchase")).toBe(1);
  });

  test("an attempt marker without evidence (evidence lost) refuses that route with no MCP call", async () => {
    const h = await harness({ outcomeOf: () => "unknown" });
    const first = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-x402-eth-snapshot-rh" }, deps(h, countingSigner()));
    expect(first.stopped?.paymentId).toBe("pay-1");
    expect(existsSync(attemptMarkerPathOf(h.evidenceDir, h.sha, "md-x402-eth-snapshot-rh"))).toBe(true);
    // 落ちて証跡が消えた状態（印だけ残る）。
    rmSync(first.runDir, { recursive: true, force: true });
    const calls = h.mcp.calls.length;
    const rerun = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-x402-eth-snapshot-rh" }, deps(h, countingSigner()));
    expect(rerun.stopped).toMatchObject({ stage: "not_started", reason: "already attempted under this plan" });
    expect(h.mcp.calls.length).toBe(calls);
  });

  test("a corrupt attempt marker or a corrupt evidence file holds the run with no MCP call", async () => {
    const h = await harness();
    const marker = attemptMarkerPathOf(h.evidenceDir, h.sha, "md-x402-eth-snapshot-rh");
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, "{not json");
    const held = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, countingSigner()));
    expect(held.stopped).toMatchObject({ stage: "not_started", reason: "held: unreadable attempt marker" });
    expect(h.mcp.calls).toHaveLength(0);

    const h2 = await harness();
    const bad = path.join(h2.evidenceDir, "run-old", "purchases", "md-x402-eth-snapshot-arbsep.json");
    mkdirSync(path.dirname(bad), { recursive: true });
    writeFileSync(bad, ""); // 切り詰められた証跡
    const held2 = await runPurchases({ plan: h2.plan, planSha256: h2.sha, evidenceDir: h2.evidenceDir, only: "md-x402-eth-snapshot-rh" }, deps(h2, countingSigner()));
    expect(held2.stopped).toMatchObject({ stage: "not_started", reason: "held: unreadable evidence" });
    expect(h2.lines.join("\n")).toContain("HELD md-x402-eth-snapshot-rh: unreadable evidence");
    expect(h2.mcp.calls).toHaveLength(0);
  });

  test("a crash between purchase and the evidence save does not buy again on rerun", async () => {
    // purchase は Router で成立したが、driver はその結果を受け取れず（呼び出しが落ちる）、その後の証跡も残らなかった状態を作る:
    // purchase の呼び出しを例外にし、run の後で run の証跡を丸ごと消す（印だけが残る）。
    const h = await harness();
    const crashing: McpCaller = {
      close: async () => {},
      call: async (name, args) => {
        const result = await h.mcp.call(name, args);
        if (name === "subetha_router_purchase") throw new Error("process died after the Router accepted the purchase");
        return result;
      },
    };
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-x402-eth-snapshot-rh" }, { ...deps(h, countingSigner()), mcp: crashing });
    expect(h.mcp.count("subetha_router_purchase")).toBe(1);
    rmSync(report.runDir, { recursive: true, force: true });
    const rerun = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, countingSigner()));
    expect(rerun.stopped).toMatchObject({ routeId: "md-x402-eth-snapshot-rh", stage: "not_started", reason: "already attempted under this plan" });
    expect(h.mcp.count("subetha_router_purchase")).toBe(1);
    expect(h.mcp.count("subetha_router_quote")).toBe(1);
  });

  test("evidence writes are atomic (no temp files left, the file is always complete JSON)", async () => {
    const h = await harness();
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-x402-eth-snapshot-rh" }, deps(h, countingSigner()));
    const files = allFiles(h.evidenceDir);
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    for (const f of files) expect(() => JSON.parse(readFileSync(f, "utf8"))).not.toThrow();
    expect(report.completed).toEqual(["md-x402-eth-snapshot-rh"]);
  });

  test("a Transfer that differs from the quote stops the run", async () => {
    const h = await harness({ destinationValueOf: (routeId) => (routeId === "md-x402-eth-snapshot-rh" ? 9_999n : 10_000n) });
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, countingSigner()));
    expect(report.stopped).toMatchObject({ routeId: "md-x402-eth-snapshot-rh", stage: "verification_failed" });
    expect(report.stopped?.reason).toContain("destination: Transfer differs from the quote");
    expect(h.mcp.count("subetha_router_quote")).toBe(1);
  });

  test("--only selects exactly one purchase, and an unknown route is refused", async () => {
    const h = await harness();
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-x402-eth-snapshot-sepolia" }, deps(h, countingSigner()));
    expect(report.completed).toEqual(["md-x402-eth-snapshot-sepolia"]);
    expect(h.mcp.calls.filter((c) => c.name === "subetha_router_quote").map((c) => c.args["routeId"])).toEqual(["md-x402-eth-snapshot-sepolia"]);
    await expect(runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, only: "md-nope" }, deps(h, countingSigner()))).rejects.toThrow(PlanRefusal);
  });

  test("all 8 delivered with the real runSign path; secrets never appear in evidence, stdout or the summary; finality and reopen append", async () => {
    const h = await harness({ echo: (credential) => ({ detail: `echo ${credential} ${BEARER} ${PAYER_KEY}` }) }, secretEnv);
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir, inboundConfirmation: "finalized", waitFinalizedSeconds: 0 }, deps(h, realSigner()));
    expect(report.stopped).toBeUndefined();
    expect(report.completed).toHaveLength(8);
    // purchase に渡した credential は本物の runSign の封筒（EIP-3009 の署名）。
    const credentials = h.mcp.calls.filter((c) => c.name === "subetha_router_purchase").map((c) => String(c.args["credential"]));
    const envelope = JSON.parse(Buffer.from(credentials[0] as string, "base64").toString("utf8")) as { payload: { authorization: { from: string; to: string; value: string } } };
    expect(envelope.payload.authorization).toMatchObject({ from: PAYER, value: "10000" });
    expect(envelope.payload.authorization.to.toLowerCase()).toBe(RECEIVER.toLowerCase());
    for (const c of h.mcp.calls.filter((x) => x.name === "subetha_router_purchase")) expect(c.args["approval"]).toBe((c.args["quote"] as { quoteId: string }).quoteId);

    const lines: string[] = [];
    await runFinality(h.evidenceDir, h.chain, h.secrets, (l) => lines.push(l), { sleep: async () => {} });
    expect(lines.at(-1)).toBe("finality: 16 final, 0 pending");
    await runReopen(h.evidenceDir, h.mcp, h.secrets, (l) => lines.push(l));
    expect(lines.at(-1)).toBe("reopen: 8 same, 0 different");
    const summaryFile = path.join(tempDir(), "e2e.json");
    const summary = writeSummary(h.evidenceDir, summaryFile, h.secrets) as { purchases: { legs: { finality: { final: boolean } }[]; reopen: { same: boolean } }[] };
    expect(summary.purchases).toHaveLength(8);
    expect(summary.purchases.every((p) => p.reopen.same && p.legs.every((l) => l.finality.final))).toBe(true);

    const secretValues = [PAYER_KEY, PAYER_KEY.slice(2), OUTBOUND_KEY, OUTBOUND_KEY.slice(2), FACILITATOR_TOKEN, BEARER, ...credentials];
    const texts = [...allFiles(h.evidenceDir).map((f) => readFileSync(f, "utf8")), readFileSync(summaryFile, "utf8"), h.lines.join("\n"), lines.join("\n")];
    for (const text of texts) for (const secret of secretValues) expect(text.includes(secret)).toBe(false);
    // body は公開の要約に入らない（digest だけ）。私的な証跡には先頭 200 字と sha256。
    expect(readFileSync(summaryFile, "utf8")).not.toContain("priceUsdcPerWeth");
    const one = JSON.parse(readFileSync(path.join(report.runDir, "purchases", "md-x402-eth-snapshot-rh.json"), "utf8")) as { body: { sha256: string; head: string; matches: boolean }; legs: { ok: boolean }[] };
    expect(one.body.matches).toBe(true);
    expect(one.body.head.length).toBeLessThanOrEqual(200);
    expect(one.legs.every((l) => l.ok)).toBe(true);
    // R-6: 署名の最後の段（診断。観測だけ）が証跡に残る。
    expect((one as { signDiagnostic?: unknown }).signDiagnostic).toEqual({ signerStage: "done" });
  });

  test("the real signer refuses a key that does not belong to the plan's payer (before purchase)", async () => {
    const h = await harness({}, { ...addressEnv, SUBETHA_PAYER_ADDRESS: "0x000000000000000000000000000000000000bEEF" });
    const report = await runPurchases({ plan: h.plan, planSha256: h.sha, evidenceDir: h.evidenceDir }, deps(h, realSigner()));
    expect(report.stopped).toMatchObject({ stage: "sign_refused" });
    expect(h.mcp.count("subetha_router_purchase")).toBe(0);
    // R-6: 拒否は payer を作った段（鍵の持ち主の照合）で起きた。
    const evidence = JSON.parse(readFileSync(path.join(report.runDir, "purchases", `${report.stopped!.routeId}.json`), "utf8")) as PurchaseEvidence;
    expect(evidence.signDiagnostic).toEqual({ signerStage: "payer_create" });
  });
});

describe("I-2 #3: 印を作るとき、新しく作った祖先（attempts など）を含め root までのディレクトリを fsync する", () => {
  afterEach(() => setDirSyncForTest(undefined));
  test("createAttemptMarker は印の親から root までの全ディレクトリを fsync してから true を返す。fsync が失敗すれば例外（購入を始めない）", () => {
    const evidenceDir = mkdtempSync(path.join(tmpdir(), "e2e-marker-"));
    const synced: string[] = [];
    setDirSyncForTest((dir) => void synced.push(dir));
    expect(createAttemptMarker(evidenceDir, "a".repeat(64), "md-rh-eth-snapshot", { at: 1 })).toBe(true);
    const markerDir = path.dirname(attemptMarkerPathOf(evidenceDir, "a".repeat(64), "md-rh-eth-snapshot"));
    // 新しく作った `attempts` を持つ evidenceDir、さらにその上も含む
    for (const d of [markerDir, path.dirname(markerDir), path.resolve(evidenceDir), path.dirname(path.resolve(evidenceDir)), path.parse(path.resolve(evidenceDir)).root]) {
      expect(synced, d).toContain(d);
    }
    setDirSyncForTest(() => {
      throw new Error("EIO");
    });
    expect(() => createAttemptMarker(evidenceDir, "b".repeat(64), "md-rh-eth-snapshot", { at: 2 })).toThrow();
    rmSync(evidenceDir, { recursive: true, force: true });
  });
});

describe("E-7: 封をされる前の receipt の block hash（ゼロ）を reorg と誤らない", () => {
  test("isUnsealedBlockHash はゼロの 32 バイトだけを真にする", () => {
    expect(isUnsealedBlockHash(`0x${"0".repeat(64)}`)).toBe(true);
    expect(isUnsealedBlockHash(`0x${"0".repeat(63)}1`)).toBe(false);
    expect(isUnsealedBlockHash("0x92938eab2067409085c46d954831f109373ac4ae61e2cf94208e8ddd111fa839")).toBe(false);
  });
});
