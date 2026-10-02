/**
 * S3 (leg 1): a REAL Sepolia zETH payment through the Router's SubEtha inbound adapter.
 * Spends testnet funds: burns zETH to the offer's one-time address, then settles.
 * Does NOT touch the outbound leg.
 */
import { createWalletClient, createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSubethaInbound } from "../src/adapters/inbound/subetha.js";
import { createGuardedTransport, formatTransportEvent } from "../src/net/guarded-fetch.js";

const facUrl = process.env.FAC_URL ?? "http://127.0.0.1:4042";
const rpc = process.env.RPC_URL!;
const pk = process.env.SEPOLIA_DISPOSABLE_PK! as `0x${string}`;
const amount = process.env.AMOUNT ?? "1234";
const token = "0xADAb5CaB352fb1eBF24CD951de224f9e952C82Ed" as const;

const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
const transport = createGuardedTransport({ allowLoopback: false, report: (event) => process.stderr.write(`${formatTransportEvent(event)}\n`) });
const inbound = createSubethaInbound({ transport, facilitatorUrl: facUrl });

const before = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`payer ${account.address}  zETH before: ${before}`);

const offer = await inbound.createOffer({
  routeId: "u01r-live",
  amount,
  asset: token,
  network: "eip155:11155111",
  routeBinding: "u01r-live|GET|%2Fv1%2Froutes%2Fu01r-live%2Fresource",
  nowMs: Date.now(),
});
console.log(`\noffer: pay ${offer.amount} to ${offer.payTo}`);
console.log(`nonce: ${offer.extra.challengeNonce}  expires: ${new Date(offer.extra.expiresAt * 1000).toISOString()}`);

// The payer broadcasts its own burn (self-transfer path; no helper in the offer).
console.log("\n--- broadcasting the burn transfer (REAL funds) ---");
const burnTx = await wallet.writeContract({
  address: token, abi: erc20Abi, functionName: "transfer",
  args: [offer.payTo as `0x${string}`, BigInt(offer.amount)],
});
console.log(`burn tx: ${burnTx}`);
const rc = await pub.waitForTransactionReceipt({ hash: burnTx });
console.log(`burn status: ${rc.status}  block: ${rc.blockNumber}`);
if (rc.status !== "success") { console.log("burn failed; not settling"); process.exit(1); }

const credential = {
  x402Version: 2,
  accepted: structuredClone(offer),
  payload: { challengeNonce: offer.extra.challengeNonce, burnTxHash: burnTx },
} as never;

const pre = inbound.preflight(offer, credential, Date.now());
console.log(`\npreflight: ${pre.ok ? "ok" : "REJECTED " + pre.reason}`);
if (!pre.ok) process.exit(1);

const verified = await inbound.verify(offer, credential);
console.log(`verify: isValid=${verified.isValid}`);
if (!verified.isValid) { console.log("verify said no; NOT settling"); process.exit(1); }

console.log("\n--- settle ---");
const settled = await inbound.settle(offer, credential);
console.log(JSON.stringify(settled, null, 2));

const after = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`\nzETH after: ${after}  (delta ${before - after})`);
console.log(settled.outcome === "settled" ? "\n*** S3 leg 1 SETTLED ***" : `\n*** outcome: ${settled.outcome} ***`);
