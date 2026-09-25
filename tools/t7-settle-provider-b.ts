/**
 * T7: Provider B（MPP / Tempo）への**実決済**を 1 回だけ行う運用ツール。**製品コードではない。**
 * 既定の `npm run test` からは呼ばれない。
 *
 * **レール A より危険**: payer 自身が送金してから有料 GET を投げるため、
 * 「送金済み・データ未取得」が現実に起こりうる（資金は動く）。
 * その場合も**再送しない**。結果は `unknown` として扱い、オンチェーン照合は読み取りのみ。
 *
 * 決済スコープ（`docs/t7-requirements.md` §2 に準じる B 版）をコードで強制する。
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x... [T7_TEMPO_RPC_URL=...] tsx tools/t7-settle-provider-b.ts [--dry-run]
 */

import { createMppOutbound } from "../src/adapters/outbound/mpp.js";
import { createRealMppCapability, TEMPO_MODERATO_CHAIN_ID } from "./real-mpp-capability.js";

const ROUTE_ID = "md-b-eth-snapshot";
const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";

/** 承認してよい条件。これ以外には絶対に送金させない。 */
const SCOPE = {
  network: `eip155:${TEMPO_MODERATO_CHAIN_ID}`,
  chainId: TEMPO_MODERATO_CHAIN_ID,
  asset: "0x20c0000000000000000000000000000000000000",
  recipient: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
  maxAmount: 10_000n,
} as const;

function fail(reason: string): never {
  process.stderr.write(`t7-settle-b: STOPPED: ${reason}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env["T7_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    fail("T7_PAYER_PRIVATE_KEY is not set");
  }
  const payer = createRealMppCapability(key, {
    ...(process.env["T7_TEMPO_RPC_URL"] ? { rpcUrl: process.env["T7_TEMPO_RPC_URL"] } : {}),
  });
  process.stdout.write(`payer address: ${payer.address}\n`);

  const rail = createMppOutbound({
    upstreams: { [ROUTE_ID]: UPSTREAM },
    capability: payer.capability(),
  });

  // 1) 402 を読む（無課金）。
  const offers = await rail.readChallenge(ROUTE_ID);
  if (offers.length !== 1) {
    fail(`expected exactly one offer, got ${offers.length}`);
  }
  const offer = offers[0]!;
  process.stdout.write(`offer: ${JSON.stringify(offer)}\n`);

  // 2) スコープをコードで強制する（送金は payer 自身が行うので、ここが最後の砦）。
  if (offer.network !== SCOPE.network) fail(`network out of scope: ${offer.network}`);
  if (offer.asset.toLowerCase() !== SCOPE.asset.toLowerCase()) {
    fail(`asset out of scope: ${offer.asset}`);
  }
  if (offer.payTo.toLowerCase() !== SCOPE.recipient.toLowerCase()) {
    fail(`recipient out of scope: ${offer.payTo}`);
  }
  if (BigInt(offer.amount) > SCOPE.maxAmount) {
    fail(`amount exceeds cap: ${offer.amount} > ${SCOPE.maxAmount}`);
  }
  process.stdout.write("scope check: OK (network/asset/recipient/amount within the recorded scope)\n");

  if (dryRun) {
    process.stdout.write("dry-run: stopping before any transfer.\n");
    return;
  }

  // 3) 実決済を 1 回だけ。**再試行しない**（送金済み・データ未取得でも再送しない）。
  const started = Date.now();
  const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "t7-real-b-1", attempt: 1 });
  const elapsed = Date.now() - started;

  process.stdout.write(`outcome: ${result.outcome} (${elapsed}ms, clients=${payer.clientCount()})\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome === "unknown") {
    process.stdout.write(
      "NOTE: unknown means the transfer may have happened. Do NOT retry; reconcile read-only on chain.\n",
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `t7-settle-b: failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
