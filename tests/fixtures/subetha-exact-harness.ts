/**
 * 受信レール `subetha-exact` の wire の harness（タスク T-5）: 合成 facilitator（child）+ x402 の上流（child）+ 実 `startRouter` の child
 * （`router-subetha-exact-process.ts`）。買い手の署名は使い捨ての鍵で `createX402Payer`（= `npm run sign` と同じ封筒）。
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";

import { createX402Payer } from "../../tools/x402-payer.js";
import { startListening, type Listening } from "./loopback.js";

export const ROUTE_ID = "md-zusdc-exact";
export const PROVIDER = "router-test";
export const BEARER = "fixture-provider-token-0123";
export const CHAIN_ID = 84532;
export const NETWORK = `eip155:${CHAIN_ID}`;
export const ZUSDC = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const DEST_PAY_TO = "0x0000000000000000000000000000000000000a11";
export const CANONICAL_BASE_URL = "http://127.0.0.1:8500";
export const ALICE = { id: "alice", token: "tok-alice-synthetic" };
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

export interface ExactHarness {
  readonly workDir: string;
  readonly journalPath: string;
  readonly ledgerPath: string;
  readonly signalPath: string;
  readonly facilitator: Listening;
  readonly upstream: Listening;
  router: Listening;
  readonly env: Record<string, string>;
  readonly payer: ReturnType<typeof createX402Payer>;
  restartRouter(options?: { stopAt?: string; env?: Record<string, string>; config?: Record<string, unknown> }): Promise<void>;
  killRouter(): Promise<void>;
  stopAll(): Promise<void>;
  journal(): Promise<{ paymentId: string; event: string; patch: Record<string, unknown> }[]>;
  ledger(): Promise<{ paymentId: string; event: string; patch: Record<string, unknown> }[]>;
  calls(): Promise<{ byRoute: Record<string, number>; byOrder: Record<string, Record<string, number>> }>;
  setMode(route: string, mode: string, raw?: { status: number; headers?: Record<string, string>; body?: unknown }): Promise<void>;
  order(orderId: string): Promise<Record<string, unknown>>;
}

export interface ExactHarnessOptions {
  readonly facilitatorArgs?: readonly string[];
  readonly upstreamArgs?: readonly string[];
  readonly stopAt?: string;
  readonly env?: Record<string, string>;
  /** `router.routes` を差し替える（route を消す試験）。 */
  readonly routes?: Record<string, unknown>;
  readonly skipRouter?: boolean;
  /** 設定の `subethaExact` の節（無ければ節を持たない）。 */
  readonly section?: Record<string, unknown>;
}

export function configDocument(upstreamBaseUrl: string, routes?: Record<string, unknown>): Record<string, unknown> {
  return {
    router: {
      approvalTtlMs: 60_000,
      routes: routes ?? {
        [ROUTE_ID]: {
          routeId: ROUTE_ID,
          canonicalPath: `/v1/routes/${ROUTE_ID}/resource`,
          rail: "x402",
          sourceRail: "subetha-exact",
          source: { amount: "2000", asset: ZUSDC, decimals: 6, network: NETWORK },
          destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: DEST_PAY_TO },
        },
      },
      budget: {
        maxPurchases: 16,
        buckets: [
          { network: NETWORK, asset: ZUSDC, maxTotal: "100000", maxPerPurchase: "20000" },
          { network: NETWORK, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" },
        ],
      },
    },
    x402: { upstreams: Object.fromEntries(Object.keys(routes ?? { [ROUTE_ID]: 1 }).map((id) => [id, `${upstreamBaseUrl}/v1/eth/snapshot`])) },
  };
}

export async function startExactHarness(options: ExactHarnessOptions = {}): Promise<ExactHarness> {
  await mkdir(runtimeRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(runtimeRoot, "t5-exact-"));
  const journalPath = path.join(workDir, "journal.ndjson");
  const ledgerPath = path.join(workDir, "subetha-exact", "orders.ndjson");
  const tokenFile = path.join(workDir, "provider.token");
  const signalPath = path.join(workDir, "stop.signal");
  const configPath = path.join(workDir, "router.config.json");
  await writeFile(tokenFile, `${BEARER}\n`, { mode: 0o600 });
  const facilitator = await startListening("tests/fixtures/subetha-exact-facilitator.ts", [...(options.facilitatorArgs ?? []), "--provider-id", PROVIDER, "--bearer", BEARER, "--chain-id", String(CHAIN_ID), "--asset", ZUSDC, "--ttl-seconds", "300"]);
  const upstream = await startListening("tests/fixtures/x402-upstream.ts", [...(options.upstreamArgs ?? []), "--pay", "ok", "--asset", USDC]);
  await writeFile(configPath, JSON.stringify({ ...configDocument(upstream.baseUrl, options.routes), ...(options.section === undefined ? {} : { subethaExact: options.section }) }, null, 2));
  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_JOURNAL_PATH: journalPath,
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: CANONICAL_BASE_URL,
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "http://127.0.0.1:1",
    ROUTER_SUBETHA_EXACT_FACILITATOR_URL: `${facilitator.baseUrl}/p/${PROVIDER}`,
    ROUTER_SUBETHA_EXACT_SETTLE_FACILITATOR_URL: `${facilitator.baseUrl}/xfac`,
    ROUTER_SUBETHA_EXACT_TOKEN_FILE: tokenFile,
    SUBETHA_EXACT_STOP_SIGNAL: signalPath,
    ...options.env,
  };
  const startRouter = (stopAt: string | undefined, extra: Record<string, string> = {}) =>
    startListening("tests/fixtures/router-subetha-exact-process.ts", [], { ...env, ...extra, ...(stopAt === undefined ? {} : { SUBETHA_EXACT_STOP_AT: stopAt }) }, { listenTimeoutMs: 30_000 });
  let router: Listening;
  if (options.skipRouter === true) {
    router = undefined as unknown as Listening;
  } else {
    try {
      router = await startRouter(options.stopAt);
    } catch (error) {
      await Promise.all([facilitator.stop(), upstream.stop()]);
      throw error;
    }
  }
  const rows = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { paymentId: string; event: string; patch: Record<string, unknown> });
  const harness: ExactHarness = {
    workDir,
    journalPath,
    ledgerPath,
    signalPath,
    facilitator,
    upstream,
    router,
    env,
    payer: createX402Payer(generatePrivateKey()),
    async restartRouter(restart = {}) {
      if (harness.router !== undefined) await harness.router.stop().catch(() => undefined);
      if (restart.config !== undefined) await writeFile(configPath, JSON.stringify(restart.config, null, 2));
      harness.router = await startRouter(restart.stopAt, restart.env);
    },
    async killRouter() {
      await harness.router.kill("SIGKILL");
    },
    async stopAll() {
      await harness.router?.stop().catch(() => undefined);
      await Promise.all([facilitator.stop(), upstream.stop()]);
    },
    journal: () => rows(journalPath),
    ledger: () => rows(ledgerPath),
    calls: async () => (await (await fetch(`${facilitator.baseUrl}/_fixture/calls`)).json()) as { byRoute: Record<string, number>; byOrder: Record<string, Record<string, number>> },
    async setMode(route, mode, raw) {
      const response = await fetch(`${facilitator.baseUrl}/_fixture/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route, mode, ...(raw ?? {}) }) });
      if (response.status !== 200) throw new Error(`setMode failed: ${response.status}`);
    },
    order: async (orderId) => (await (await fetch(`${facilitator.baseUrl}/_fixture/orders/${orderId}`)).json()) as Record<string, unknown>,
  };
  return harness;
}

export function principalHeaders(): Record<string, string> {
  return { "x-router-principal": ALICE.id, authorization: `Bearer ${ALICE.token}` };
}

export interface QuoteBody {
  quoteId: string;
  paymentId: string;
  source: { rail: string; offer: { extra: { challengeNonce: string; expiresAt: number; routeBinding: string } } & Record<string, unknown>; payTo: string; expiresAt: number } & Record<string, unknown>;
  destination: Record<string, unknown>;
  approval: { deadlineMs: number };
}

export async function quoteOf(harness: ExactHarness, requestId: string): Promise<{ status: number; body: QuoteBody & Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${harness.router.baseUrl}/v1/quotes`, { method: "POST", headers: { ...principalHeaders(), "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId }) });
  return { status: response.status, body: (await response.json()) as QuoteBody & Record<string, unknown>, headers: response.headers };
}

/** `npm run sign` と同じ封筒（`createX402Payer`）。 */
export async function credentialOf(harness: ExactHarness, offer: QuoteBody["source"]["offer"]): Promise<string> {
  return harness.payer.credentialFor(offer as never, CHAIN_ID);
}

export async function purchaseOf(harness: ExactHarness, quote: QuoteBody, requestId: string, credential?: string): Promise<{ status: number; body: Record<string, unknown>; raw: Response }> {
  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_ID}/resource`, {
    headers: { ...principalHeaders(), "x-router-request-id": requestId, "x-router-quote-id": quote.quoteId, "x-router-approval": quote.quoteId, ...(credential === undefined ? {} : { "x-payment": credential }) },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, raw: response };
}

export async function statusOf(harness: ExactHarness, paymentId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.router.baseUrl}/v1/purchases/${paymentId}`, { headers: principalHeaders() });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
