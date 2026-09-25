/**
 * T7: Provider A への**実決済**を 1 回だけ行う運用ツール。**製品コードではない。**
 * 既定の `npm run test` からは呼ばれない（不用意な送金を避けるため明示起動のみ）。
 *
 * 決済スコープ（`docs/t7-requirements.md` §2）をコードで強制する:
 *   Base Sepolia のみ / USDC のみ / Provider A の payTo のみ / 1 回 10000 base units。
 * どれかが外れたら**送信前に停止**する。
 *
 * 受信レグ（SubEtha）は合成 facilitator のまま（無課金）。送信レグ A だけが実決済。
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x... tsx tools/t7-settle-provider-a.ts [--dry-run]
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { createX402Outbound } from "../src/adapters/outbound/x402.js";
import { startListening } from "../tests/fixtures/loopback.js";
import { createRealEvmCapability } from "./real-evm-capability.js";

const ROUTE_ID = "md-a-eth-snapshot";
const UPSTREAM = "https://provider-x402.subethalabs.com/v1/eth/snapshot";

/** 承認してよい条件。これ以外には絶対に署名させない。 */
const SCOPE = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
  maxAmount: 10_000n,
} as const;

function fail(reason: string): never {
  process.stderr.write(`t7-settle: STOPPED: ${reason}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env["T7_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    fail("T7_PAYER_PRIVATE_KEY is not set");
  }
  const payer = createRealEvmCapability(key);
  process.stdout.write(`payer address: ${payer.address}\n`);

  const rail = createX402Outbound({
    upstreams: { [ROUTE_ID]: UPSTREAM },
    capability: payer.capability(SCOPE.network),
  });

  // 1) 402 を読む（無課金）。
  const offers = await rail.readChallenge(ROUTE_ID);
  if (offers.length !== 1) {
    fail(`expected exactly one offer, got ${offers.length}`);
  }
  const offer = offers[0]!;
  process.stdout.write(`offer: ${JSON.stringify(offer)}\n`);

  // 2) スコープをコードで強制する（ドキュメントだけに頼らない）。
  if (offer.network !== SCOPE.network) fail(`network out of scope: ${offer.network}`);
  if (offer.asset.toLowerCase() !== SCOPE.asset.toLowerCase()) {
    fail(`asset out of scope: ${offer.asset}`);
  }
  if (offer.payTo.toLowerCase() !== SCOPE.payTo.toLowerCase()) {
    fail(`payTo out of scope: ${offer.payTo}`);
  }
  if (BigInt(offer.amount) > SCOPE.maxAmount) {
    fail(`amount exceeds cap: ${offer.amount} > ${SCOPE.maxAmount}`);
  }
  process.stdout.write("scope check: OK (network/asset/payTo/amount all within the recorded scope)\n");

  if (dryRun) {
    process.stdout.write("dry-run: stopping before any signature or payment.\n");
    return;
  }

  // 3) 実決済を 1 回だけ。guarded signer が承認値と照合してから署名する。
  const started = Date.now();
  const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "t7-real-1", attempt: 1 });
  const elapsed = Date.now() - started;

  process.stdout.write(`outcome: ${result.outcome} (${elapsed}ms, signs=${payer.signCount()})\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  // 鍵が混ざり得るのでスタックは出さない。
  process.stderr.write(
    `t7-settle: failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
