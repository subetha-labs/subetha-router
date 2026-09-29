/**
 * S2: the Router's own SubEtha inbound adapter against the LIVE Sepolia facilitator.
 * Unpaid: only createOffer (a challenge) and preflight checks. Never calls settle.
 */
import { createSubethaInbound, SUBETHA_SCHEME } from "../src/adapters/inbound/subetha.js";

const url = process.env.FAC_URL ?? "http://127.0.0.1:4042";
const inbound = createSubethaInbound({ facilitatorUrl: url });
const routeBinding = "u01r-live|GET|%2Fv1%2Froutes%2Fu01r-live%2Fresource";

const offer = await inbound.createOffer({
  routeId: "u01r-live",
  amount: "1234",
  asset: "0xADAb5CaB352fb1eBF24CD951de224f9e952C82Ed",
  network: "eip155:11155111",
  routeBinding,
  nowMs: Date.now(),
});

console.log("=== offer built by the Router's adapter from a REAL facilitator ===");
console.log(JSON.stringify(offer, null, 2));

const ok = [
  ["scheme is subetha-zerc20", offer.scheme === SUBETHA_SCHEME],
  ["network is Sepolia", offer.network === "eip155:11155111"],
  ["asset is Sepolia zETH", offer.asset.toLowerCase() === "0xadab5cab352fb1ebf24cd951de224f9e952c82ed"],
  ["payTo is a fresh burn address (not the treasury)", offer.payTo.toLowerCase() !== "0xed5f079f5332879b9f1e35ba36fe487360db06c4"],
  ["nonce is 32 bytes", /^0x[0-9a-f]{64}$/i.test(offer.extra.challengeNonce)],
  ["expiry is in the future", offer.extra.expiresAt * 1000 > Date.now()],
  ["routeBinding preserved", offer.extra.routeBinding === routeBinding],
  ["self-transfer path (no helper)", offer.extra["helper"] === undefined],
];
console.log("\n=== assertions ===");
let bad = 0;
for (const [label, pass] of ok) { if (!pass) bad++; console.log(`${pass ? "OK  " : "FAIL"} ${label}`); }

// preflight must REJECT a credential whose nonce does not match the issued offer.
const wrong = { x402Version: 2, accepted: structuredClone(offer), payload: { challengeNonce: "0x" + "11".repeat(32) } };
const r1 = inbound.preflight(offer, wrong as never, Date.now());
console.log(`${r1.ok === false ? "OK  " : "FAIL"} preflight rejects a mismatched nonce (${r1.ok === false ? r1.reason : "accepted!"})`);
if (r1.ok !== false) bad++;

// preflight must ACCEPT a credential that matches exactly.
const right = { x402Version: 2, accepted: structuredClone(offer), payload: { challengeNonce: offer.extra.challengeNonce } };
const r2 = inbound.preflight(offer, right as never, Date.now());
console.log(`${r2.ok === true ? "OK  " : "FAIL"} preflight accepts the exact issued offer${r2.ok === false ? " -> " + r2.reason : ""}`);
if (r2.ok !== true) bad++;

console.log(bad === 0 ? "\n*** S2 PASS (unpaid) ***" : `\n*** S2: ${bad} failure(s) ***`);
process.exit(bad === 0 ? 0 : 1);
