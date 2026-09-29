/**
 * S3 (both legs): drive the Router end to end over HTTP.
 * Inbound: burn real Sepolia zETH to the quote's one-time address.
 * Outbound: the Router pays Provider A in Base Sepolia USDC (x402).
 * Spends real testnet funds on BOTH chains.
 */
import { createWalletClient, createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const base = process.env.ROUTER_URL ?? "http://127.0.0.1:8510";
const H = {
  "x-router-principal": "demo",
  authorization: `Bearer ${process.env.ROUTER_TOKEN}`,
  "content-type": "application/json",
};
const rpc = process.env.RPC_URL!;
const pk = process.env.SEPOLIA_DISPOSABLE_PK! as `0x${string}`;
const requestId = process.env.REQUEST_ID!;
const token = "0xADAb5CaB352fb1eBF24CD951de224f9e952C82Ed" as const;

const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });

const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) });

// 1. quote
const q = await j(await fetch(`${base}/v1/quotes`, { method: "POST", headers: H, body: JSON.stringify({ routeId: "u01r-live", requestId }) }));
if (q.status !== 200) { console.log("quote failed", q); process.exit(1); }
const quote = q.body as Record<string, any>;
console.log(`quote ${quote.quoteId}`);
console.log(`  inbound : pay ${quote.source.amount} zETH -> ${quote.source.payTo}`);
console.log(`  outbound: Router pays ${quote.destination.quoted} USDC to Provider A`);

// 2. burn (inbound leg, REAL funds on Sepolia)
console.log("\n--- burning zETH ---");
const burnTx = await wallet.writeContract({
  address: token, abi: erc20Abi, functionName: "transfer",
  args: [quote.source.payTo as `0x${string}`, BigInt(quote.source.amount)],
});
const rc = await pub.waitForTransactionReceipt({ hash: burnTx });
console.log(`burn ${burnTx} -> ${rc.status} block ${rc.blockNumber}`);
if (rc.status !== "success") process.exit(1);

// 3. purchase: GET the resource with the credential (x402 pattern), approval bound to the quoteId
const credential = {
  x402Version: 2,
  accepted: quote.source.offer,
  payload: { challengeNonce: quote.source.offer.extra.challengeNonce, burnTxHash: burnTx },
};
console.log("\n--- purchase (Router settles inbound, then pays Provider A) ---");
const p = await j(await fetch(`${base}/v1/routes/u01r-live/resource`, {
  method: "GET",
  headers: {
    ...H,
    "x-router-quote-id": quote.quoteId,
    "x-router-request-id": requestId,
    "x-router-approval": quote.quoteId,
    "x-payment": Buffer.from(JSON.stringify(credential), "utf8").toString("base64"),
  },
}));
console.log(`http ${p.status}`);
console.log(JSON.stringify(p.body, null, 2).slice(0, 1800));

// 4. status
const st = await j(await fetch(`${base}/v1/purchases/${quote.paymentId}`, { headers: H }));
console.log(`\n--- status (${st.status}) ---`);
console.log(JSON.stringify(st.body, null, 2).slice(0, 900));
