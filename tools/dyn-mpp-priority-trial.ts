/**
 * T18 の testnet の試行（`docs/dynamic-gas-fee-design.md` §8.3。owner の承認 2026-10-06「1 を進めていただきたいです」）。**製品コードではない**（実鍵を扱う起動側）。
 *
 * 確かめること: Router が決めた単価（priority 1 wei、`maxFeePerGas = ceil(2.4 × baseFee) + 1`）で署名した MPP の送金が Tempo testnet に取り込まれ、
 * 請求額が cap 以下であること。経路は本番と同じ Router（`startRouter` の実レール構成）の**動的 MPP 送信**（`dyn-x402-to-mpp`）:
 * 呼び出し側（使い捨て口座）が Base Sepolia USDC を x402 で Router に払い、Router が Tempo pathUSD を MPP で Provider B に払う。
 *
 * 範囲はコードで強制する: プロファイルは本番の値（手数料 1,000・`feeMargin` 20,000・天井 50,000・上流の上限 10,000）、上流は Provider B だけ、
 * 支払いは 1 件、`--dry-run` なら quote（読取だけ。見積りも署名しない）で止まる。鍵は env から読み、出力に出さない。
 *
 * usage: SUBETHA_OUTBOUND_MPP_KEY=0x… T7_PAYER_PRIVATE_KEY=0x… npx tsx tools/dyn-mpp-priority-trial.ts [--pay]
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import { createRouterClient } from "../src/client/index.js";
import type { QuoteView } from "../src/client/types.js";
import { startListening } from "../tests/fixtures/loopback.js";
import { createX402Payer } from "./x402-payer.js";

const PROFILE_ID = "dyn-x402-to-mpp";
const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";
const INBOUND = { chainId: 84532, network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", facilitator: "https://www.x402.org/facilitator" } as const;
const OUTBOUND = { network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000" } as const;
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz";
const ALICE = { id: "alice", token: "tok-alice-t18" };

function fail(reason: string): never {
  process.stderr.write(`dyn-mpp-priority-trial: STOPPED: ${reason}\n`);
  process.exit(2);
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(TEMPO_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const json = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (json.error !== undefined) throw new Error(json.error.message);
  return json.result;
}

async function main(): Promise<void> {
  const pay = process.argv.includes("--pay");
  const mppKey = process.env["SUBETHA_OUTBOUND_MPP_KEY"];
  const payerKey = process.env["T7_PAYER_PRIVATE_KEY"];
  if (mppKey === undefined || payerKey === undefined) fail("SUBETHA_OUTBOUND_MPP_KEY and T7_PAYER_PRIVATE_KEY are required");
  const routerAddress = privateKeyToAccount(mppKey as `0x${string}`).address;
  const payer = createX402Payer(payerKey);
  const out: Record<string, unknown> = { at: new Date().toISOString(), pay, routerOutbound: routerAddress, payer: payer.address, receiver: RECEIVER, upstream: UPSTREAM };

  const work = await mkdtemp(path.join(path.resolve("runtime"), "t18-"));
  // 本番の MPP 送信プロファイルと同じ値（`tools/remote-mcp-config.ts`）。登録は本番では無効なので、ここで同じ内容を組む。
  const config = {
    router: {
      approvalTtlMs: 600_000,
      // 静的 route は 1 つ要る（設定の検証）。この試行では使わない（予算 1 件・上流は同じ Provider B）。
      routes: {
        "md-mpp-eth-snapshot": {
          routeId: "md-mpp-eth-snapshot",
          canonicalPath: "/v1/routes/md-mpp-eth-snapshot/resource",
          rail: "mpp",
          sourceRail: "x402",
          source: { amount: "10000", asset: INBOUND.asset, decimals: 6, network: INBOUND.network, payTo: RECEIVER },
          destination: { scheme: "tempo/charge", network: OUTBOUND.network, asset: OUTBOUND.asset, payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1" },
        },
      },
      budget: {
        maxPurchases: 1,
        buckets: [
          { network: INBOUND.network, asset: INBOUND.asset, maxTotal: "10000", maxPerPurchase: "10000" },
          { network: OUTBOUND.network, asset: OUTBOUND.asset, maxTotal: "10000", maxPerPurchase: "10000" },
        ],
      },
      dynamic: {
        enabled: true,
        profiles: {
          [PROFILE_ID]: {
            profileId: PROFILE_ID,
            sourceRail: "x402",
            source: { network: INBOUND.network, asset: INBOUND.asset, decimals: 6, payTo: RECEIVER },
            rail: "mpp",
            destination: { scheme: "tempo/charge", network: OUTBOUND.network, asset: OUTBOUND.asset, decimals: 6, feeAsset: OUTBOUND.asset, maxFee: "50000", feeMargin: 20_000 },
            par: true,
            maxUpstreamAmount: "10000",
            fee: { flat: "1000", bps: 0, min: "1000" },
          },
        },
        budget: {
          maxPurchases: 1,
          buckets: [
            { network: INBOUND.network, asset: INBOUND.asset, maxTotal: "20000", maxPerPurchase: "20000" },
            { network: OUTBOUND.network, asset: OUTBOUND.asset, maxTotal: "20000", maxPerPurchase: "20000" },
          ],
        },
        denyHosts: ["router.subethalabs.com"],
      },
    },
    x402: { upstreams: { "md-mpp-eth-snapshot": UPSTREAM } },
  };
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const router = await startListening("tools/remote-router-process.ts", [], {
    SUBETHA_OUTBOUND_MPP_KEY: mppKey,
    SUBETHA_TEMPO_RPC_URL: TEMPO_RPC,
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
    ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
  });
  out["startup"] = router.stdout().trim().split("\n").slice(-2);
  try {
    const client = createRouterClient({ baseUrl: router.baseUrl, principalId: ALICE.id, token: ALICE.token });
    const requestId = `t18-priority-trial-${Date.now()}`;
    const quoted = await client.quoteUrl({ profileId: PROFILE_ID, url: UPSTREAM, requestId });
    if (!quoted.ok) fail(`quote failed: ${JSON.stringify(quoted)}`);
    const quote: QuoteView = quoted.quote;
    const pricing = quote.pricing as Record<string, unknown>;
    out["quote"] = { quoteId: quote.quoteId, paymentId: quote.paymentId, pricing, destinationPayTo: (quote.destination as Record<string, unknown>)["payTo"], deadlineMs: quote.approval.deadlineMs };
    // 範囲の検査。
    const source = quote.source as { amount: string; asset: string; network: string; payTo: string };
    if (source.network !== INBOUND.network || source.asset.toLowerCase() !== INBOUND.asset.toLowerCase() || source.payTo.toLowerCase() !== RECEIVER.toLowerCase()) fail("inbound offer out of scope");
    if (BigInt(source.amount) > 20_000n) fail(`inbound amount exceeds 20,000: ${source.amount}`);
    if (BigInt(String(pricing["upstreamAmount"])) > 10_000n) fail("upstream amount exceeds 10,000");
    if (typeof pricing["maxFee"] !== "string" || BigInt(pricing["maxFee"]) > 50_000n) fail("cap missing or over the ceiling");
    const estimate = pricing["estimate"] as { gas: string; maxFeePerGas: string; bound: string; atMs: number };
    out["estimate"] = estimate;
    // Router の単価の確認（priority を含まない形）: maxFeePerGas = ceil(2.4 × baseFee) + 1 になっているか、今の baseFee で検算（ブロックが進むので近似）。
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas: string; number: string };
    const baseFee = BigInt(latest.baseFeePerGas);
    out["baseFeeNow"] = baseFee.toString();
    out["feePerGasOfBaseFeeNow"] = ((baseFee * 24n + 9n) / 10n + 1n).toString();
    if (!pay) {
      out["dryRun"] = "stopped before any credential; nothing moved";
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    const credential = await payer.credentialFor(quote.source.offer as never, INBOUND.chainId);
    const started = Date.now();
    const result = await client.execute({ quote, requestId, approval: { approved: true, quoteId: quote.quoteId }, credential });
    out["purchase"] = { outcome: result.outcome, ms: Date.now() - started, ...(result.outcome === "delivered" ? { keys: Object.keys((result as { snapshot: Record<string, unknown> }).snapshot ?? {}) } : { detail: result }) };
    const status = await client.status(quote.paymentId, quote.ownerKey);
    const projection = (status as { projection?: Record<string, unknown> }).projection ?? status;
    out["projection"] = projection;
    const destination = (projection as { destination?: { txRef?: string } }).destination;
    const txRef = destination?.txRef;
    if (typeof txRef === "string" && /^0x[0-9a-f]{64}$/i.test(txRef)) {
      const [tx, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [txRef]), rpc("eth_getTransactionReceipt", [txRef])]);
      const t = tx as Record<string, string>;
      const r = receipt as Record<string, unknown> | null;
      const block = r === null ? undefined : ((await rpc("eth_getBlockByNumber", [r["blockNumber"], false])) as { baseFeePerGas: string });
      const gasUsed = r === null ? 0n : BigInt(r["gasUsed"] as string);
      const effective = r === null ? 0n : BigInt(r["effectiveGasPrice"] as string);
      out["onChain"] = {
        txRef,
        included: r !== null,
        status: r?.["status"],
        gas: BigInt(t["gas"]!).toString(),
        maxFeePerGas: BigInt(t["maxFeePerGas"]!).toString(),
        maxPriorityFeePerGas: BigInt(t["maxPriorityFeePerGas"]!).toString(),
        blockBaseFee: block === undefined ? undefined : BigInt(block.baseFeePerGas).toString(),
        gasUsed: gasUsed.toString(),
        effectiveGasPrice: effective.toString(),
        chargedFee: ((gasUsed * effective + 10n ** 12n - 1n) / 10n ** 12n).toString(),
        signedBound: ((BigInt(t["gas"]!) * BigInt(t["maxFeePerGas"]!) + 10n ** 12n - 1n) / 10n ** 12n).toString(),
        cap: pricing["maxFee"],
      };
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    await router.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`dyn-mpp-priority-trial: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
