/** Dialog v2 (docs/payer-dialog-v2-design.md): plain words rendered from the frozen record only; every v1 fact still present. */
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { buildRecord, render as renderRecord, recordHash } from "../../src/daemon/record.js";
import { HOSTED_ROUTER_URL } from "../../src/router/identity.js";
import { assetName, formatAmount, money, networkName, railName } from "../../src/ui/labels.js";
import { fundsSentence, renderConfirmation } from "../../src/ui/render.js";
import { railQuote } from "../harness/router.js";
import { uiRecord } from "../harness/ui-record.js";

const EVM = `0x${"33".repeat(20)}`;
const SOLANA = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const identity = () => ({ routerUrl: HOSTED_ROUTER_URL, address: EVM, wallets: { eip155: EVM, solana: SOLANA }, ref: "p_aaaaaaaaaaaaa", requestId: randomUUID() });

test("phrase first and labelled; deterministic; static record keeps every v1 fact (full addresses, base units, decimals, deadline, Router URL, resource path)", () => {
  const r = uiRecord(), hash = recordHash(r);
  const text = renderConfirmation(r, 'my\\"phrase');
  const lines = text.split("\n");
  expect(lines[0]).toBe('Security phrase: my\\"phrase');
  expect(lines[1]).toBe("If this line is missing or not your phrase, click Cancel.");
  expect(text).toBe(renderConfirmation(r, 'my\\"phrase'));
  for (const value of [r.source.amount, r.source.asset, r.source.network, r.source.payTo, r.destination.quoted, r.destination.asset, r.destination.network, r.destination.payTo, r.wallet.address, r.routerUrl, r.ref, new Date(r.approvalDeadlineMs).toISOString()]) expect(text, value).toContain(value);
  const line = (prefix: string) => lines.find(l => l.startsWith(prefix)) ?? `(no line ${prefix})`;
  expect(line("Provider receives:")).toBe(`Provider receives: 0.01 pathUSD (${r.destination.quoted} base units, decimals 6) on Tempo testnet, MPP, to ${r.destination.payTo}`); // static md-mpp-eth-snapshot: Base USDC → Tempo pathUSD
  expect(line("Offer expires:")).toBe(`Offer expires: ${new Date(r.approvalDeadlineMs).toISOString()} (UTC)`);
  expect(line("From your wallet:")).toBe(`From your wallet: ${r.wallet.address}`);
  expect(line("To the Router:")).toBe(`To the Router: ${r.source.payTo}`);
  expect(text).toContain("Route: md-mpp-eth-snapshot (operator fixed; no fee breakdown supplied)");
  expect(text).toContain("Price: 0.01 USDC (10000 base units, 6 decimals)");
  expect(text).toContain("Pay with: USDC on Base Sepolia (testnet), x402 (exact)");
  expect(text).toContain("Funds move when the Router settles the purchase, not at approval.");
  expect(text).toContain("To approve, enter the passphrase of the wallet this payer manages and click Approve. Pressing Enter cancels.");
  expect(text).toContain("resource GET /v1/routes/md-mpp-eth-snapshot/resource (Router-internal, fixed by this payer)");
  expect(text).not.toContain("127.0.0.1");
  expect(text).not.toContain("The operator has not verified"); // static: operator-fixed destination
  expect(recordHash(r)).toBe(hash); expect(Object.isFrozen(r)).toBe(true);
  // the inspection renderer is untouched
  expect(renderRecord(r)).toContain("Destination amount: 10000 base units (decimals 6)");
});

test("sanitize phrase/values; ignore upstream bodies, labels and free text; missing decimals honest", () => {
  const r = uiRecord(); const { decimals: _, ...destination } = r.destination;
  const hostile = { ...r, destination, body: "UPSTREAM_BODY", instructions: "AGENT_TEXT", label: "URL_LABEL", routerUrl: "https://fixture.invalid/‮\u001b\t" };
  const text = renderConfirmation(hostile, "ph\t\u001b​‮  rase");
  expect(text.split("\n")[0]).toBe("Security phrase: phrase");
  expect(text).toContain("base units, decimals not supplied)");
  expect(text).not.toMatch(/UPSTREAM_BODY|AGENT_TEXT|URL_LABEL|[‮\u001b\t​]/);
});

test("dynamic record: provider URL, price breakdown in asset units, profile, no-refund line, both legs named; Tempo MPP and Solana MPP funds sentences", () => {
  const dyn = renderConfirmation(buildRecord(railQuote("dyn-x402-to-mpp"), identity()), "phrase");
  expect(dyn).toContain("Provider URL: GET https://provider-mpp.subethalabs.com/v1/eth/snapshot");
  // the provider's amount is in the destination's units (pathUSD, 6), the equation in the source's (USDC); every term also in base units
  expect(dyn).toContain("Price: provider 0.01 pathUSD (10000 base units, 6 decimals) = 0.01 USDC (10000 base units) + Router fee 0.001 USDC (1000 base units) = 0.011 USDC (11000 base units, 6 decimals); chain-fee cap 158 base units (estimated ");
  expect(dyn).toContain("Only an application/json object of 256 KiB or less is delivered.");
  expect(dyn).toContain("Pay with: USDC on Base Sepolia (testnet), x402 (exact)");
  expect(dyn).toContain("Profile: dyn-x402-to-mpp");
  expect(dyn).toContain("- This payer signs a payment of 0.011 USDC on Base Sepolia (testnet) to the Router, from your wallet.");
  expect(dyn).toContain("- The Router pays the provider 0.01 pathUSD on Tempo testnet from its own balance and passes the provider's response to the agent.");
  expect(dyn).toContain("The operator has not verified this provider. No refund");
  expect(dyn).toContain("Provider receives: 0.01 pathUSD (10000 base units, decimals 6) on Tempo testnet, MPP, to 0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1");
  // distinct legs: the source total (11000) and the destination amount (10000) each sit on their own labelled line
  expect(dyn.split("\n").find(l => l.startsWith("Price:"))).toContain("11000 base units");
  expect(dyn.split("\n").find(l => l.startsWith("Provider receives:"))).not.toContain("11000");
  expect(dyn).not.toContain("Route: ");
  const tempo = renderConfirmation(buildRecord(railQuote("tempo"), identity()), "phrase");
  expect(tempo).toContain("Approving SENDS 0.01 pathUSD now, from your wallet. It cannot be undone");
  expect(tempo).toContain("Pay with: pathUSD on Tempo testnet, MPP (tempo/charge)");
  const solmpp = renderConfirmation(buildRecord(railQuote("solmpp"), identity()), "phrase");
  expect(solmpp).toContain("Signing only: the Router broadcasts your transaction at purchase. Your Solana key pays the network fee (devnet SOL).");
  expect(solmpp).toContain("Pay with: USDC on Solana devnet, MPP (solana/charge)");
  expect(solmpp).toContain("Offer expires: 20"); expect(solmpp).toMatch(/Offer expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \(UTC\)/);
  expect(solmpp).toContain(`From your wallet: ${SOLANA}`);
  const arc = renderConfirmation(buildRecord(railQuote("dyn-arc-to-x402"), identity()), "phrase");
  expect(arc).toContain("Pay with: USDC on Arc testnet, x402 (exact)");
});

test("labels: known networks/assets named, unknown shown raw (never guessed); amounts exact; rails", () => {
  expect(networkName("eip155:84532")).toBe("Base Sepolia (testnet)");
  expect(networkName("eip155:42431")).toBe("Tempo testnet");
  expect(networkName("eip155:5042002")).toBe("Arc testnet");
  expect(networkName("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe("Solana devnet");
  expect(networkName("eip155:8453")).toBe("eip155:8453");
  expect(networkName("constructor")).toBe("constructor"); expect(networkName("__proto__")).toBe("__proto__");
  expect(assetName("eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe("USDC");
  expect(assetName("eip155:84532", "0x036cbd53842c5426634e7929541ec2318f3dcf7e")).toBe("USDC");
  expect(assetName("eip155:42431", "0x20c0000000000000000000000000000000000000")).toBe("pathUSD");
  expect(assetName("eip155:42431", "0x20C0000000000000000000000000000000000000")).toBe("pathUSD");
  expect(assetName("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "4zmmc9srt5ri5x14gagxhaHii3GnPAEERYPJgZJDncDU")).toBe("4zmmc9srt5ri5x14gagxhaHii3GnPAEERYPJgZJDncDU");
  expect(assetName("eip155:84532", "constructor")).toBe("constructor");
  expect(assetName("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")).toBe("USDC");
  expect(assetName("eip155:84532", "0x" + "ab".repeat(20))).toBe("0x" + "ab".repeat(20));
  expect(assetName("eip155:1", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  for (const [base, dec, out] of [["11000", 6, "0.011"], ["10000", 6, "0.01"], ["1", 6, "0.000001"], ["0", 6, "0"], ["1000000", 6, "1"], ["123456789", 6, "123.456789"], ["5", 0, "5"], ["12", 18, "0.000000000000000012"]] as const) expect(formatAmount(base, dec), `${base}/${dec}`).toBe(out);
  expect(formatAmount("-5", 6)).toBe("-5"); expect(formatAmount("1e3", 6)).toBe("1e3"); expect(formatAmount("12", undefined)).toBe("12");
  expect(money("11000", 6, "eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe("0.011 USDC");
  expect(money("11000", undefined, "eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe("11000 base units of USDC");
  expect(railName("x402")).toBe("x402"); expect(railName("x402", "exact")).toBe("x402 (exact)"); expect(railName("mpp")).toBe("MPP"); expect(railName("mpp", "tempo/charge")).toBe("MPP (tempo/charge)"); expect(railName("odd\u0007")).toBe("odd");
  expect(fundsSentence("exact", "0.011 USDC")).toContain("not at approval");
});

// FR-F3 / AC-F3: the inspection renderer keeps the fixed resource path, never the Router-internal host.
test("hosted Resource line shows the route path and the Router-internal note, not the loopback host", () => {
  const r = { ...uiRecord(), routerUrl: "https://router.subethalabs.com/mcp", resource: { url: "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" as const } };
  const lines = renderRecord(r).split("\n");
  const resource = lines.find(line => line.startsWith("Resource:"))!;
  expect(resource).toBe("Resource: GET /v1/routes/md-mpp-eth-snapshot/resource (Router-internal, fixed by this payer)");
  expect(resource).not.toContain("127.0.0.1");
  expect(lines.find(line => line.startsWith("Router:"))).toBe("Router: https://router.subethalabs.com/mcp");
  expect(renderConfirmation(r, "p")).toContain("Technical: Router https://router.subethalabs.com/mcp; resource GET /v1/routes/md-mpp-eth-snapshot/resource");
});
test("a configured local Router is still shown on the Router line", () => {
  const r = { ...uiRecord(), routerUrl: "http://127.0.0.1:8787/mcp", resource: { url: "http://127.0.0.1:8787/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" as const } };
  const lines = renderRecord(r).split("\n");
  expect(lines.find(line => line.startsWith("Router:"))).toBe("Router: http://127.0.0.1:8787/mcp");
  expect(lines.find(line => line.startsWith("Resource:"))).not.toContain("127.0.0.1");
});
