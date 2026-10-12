/**
 * The approval dialog text (docs/payer-dialog-v2-design.md §2): plain words, rendered deterministically from the frozen approval
 * record and the security phrase only. No agent prose, no upstream body, no labels taken from the URL. The security phrase is the
 * first line (the anti-spoofing signal); every field v1 showed is still present (full addresses, base units, deadline, the
 * Router URL and the Router-internal resource path on the last line), so the dialog and `inspect` agree on the facts.
 */
import { kindOf, sanitize, type ApprovalRecord } from "../daemon/record.js";
import { assetName, money, networkName, railName } from "./labels.js";

function resourcePathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return "(resource path unavailable)"; }
}

/** What approving does with the funds, by the source scheme (the same facts as `fundsLineOf`, in the dialog's words). */
export function fundsSentence(scheme: ApprovalRecord["source"]["scheme"], total: string): string {
  switch (scheme) {
    case "tempo/charge": return `Approving SENDS ${total} now, from your wallet. It cannot be undone, and nothing is refunded if the Router later refuses.`;
    case "solana/charge": return "Signing only: the Router broadcasts your transaction at purchase. Your Solana key pays the network fee (devnet SOL).";
    default: return "Funds move when the Router settles the purchase, not at approval. The facilitator broadcasts and pays gas.";
  }
}

export function renderConfirmation(record: ApprovalRecord, phrase: string): string {
  const r = record; const s = r.source; const d = r.destination; const kind = kindOf(r);
  const total = money(s.amount, s.decimals, s.network, s.asset);
  const toProvider = money(d.quoted, d.decimals, d.network, d.asset);
  const lines: string[] = [
    `Security phrase: ${sanitize(phrase)}`,
    "If this line is missing or not your phrase, click Cancel.",
    "",
    "An AI agent on this Mac asks to buy data through SubEtha Router.",
    "",
    "What happens if you approve",
    `- This payer signs a payment of ${total} on ${networkName(s.network)} to the Router, from your wallet.`,
    `- The Router pays the provider ${toProvider} on ${networkName(d.network)} from its own balance and passes the provider's response to the agent.`,
    `- ${fundsSentence(s.scheme, total)}`,
  ];
  if (kind === "dynamic") lines.push("- The operator has not verified this provider. No refund if it takes the payment and returns no usable data, or if the Router refuses after your funds moved. Only an application/json object of 256 KiB or less is delivered.");
  lines.push("", "Details");
  if (kind === "dynamic" && r.upstream) lines.push(`Provider URL: ${sanitize(r.upstream.method)} ${sanitize(r.upstream.url)}`);
  else lines.push(`Route: ${sanitize(r.routeId)} (operator fixed; no fee breakdown supplied)`);
  if (kind === "dynamic" && r.pricing) {
    const p = r.pricing;
    // The provider's amount is in the destination's units; `converted` is its source-currency equivalent (Codex dialog review #1).
    // Conversion and sum on separate clauses so the line never reads "provider amount = fee-inclusive total" (Codex dialog review #2).
    const src = (v: string) => money(v, s.decimals, s.network, s.asset);
    let price = `Price: provider ${money(p.upstreamAmount, p.destinationDecimals, d.network, d.asset)} (${sanitize(p.upstreamAmount)} base units, ${p.destinationDecimals} decimals), equivalent to ${src(p.converted)} (${sanitize(p.converted)} base units); total ${src(p.converted)} + Router fee ${src(p.fee)} (${sanitize(p.fee)} base units) = ${src(p.total)} (${sanitize(p.total)} base units, ${s.decimals} decimals)`;
    if (p.maxFee !== undefined) price += `; chain-fee cap ${sanitize(p.maxFee)} base units${p.estimate ? ` (estimated ${new Date(p.estimate.atMs).toISOString()})` : ""}`;
    lines.push(price);
  } else {
    lines.push(`Price: ${total} (${sanitize(s.amount)} base units, ${s.decimals} decimals)`);
  }
  if (kind === "dynamic") lines.push(`Profile: ${sanitize(r.routeId)}`);
  lines.push(
    `Pay with: ${assetName(s.network, s.asset)} on ${networkName(s.network)}, ${railName(s.rail, s.scheme)}`,
    `From your wallet: ${sanitize(r.wallet.address)}`,
    `To the Router: ${sanitize(s.payTo)}`,
    `Provider receives: ${toProvider} (${sanitize(d.quoted)} base units, decimals ${d.decimals ?? "not supplied"}) on ${networkName(d.network)}, ${railName(d.rail, d.scheme)}, to ${sanitize(d.payTo)}`,
    `Offer expires: ${new Date(r.approvalDeadlineMs).toISOString()} (UTC)`,
    "",
    "To approve, enter the passphrase of the wallet this payer manages and click Approve. Pressing Enter cancels.",
    "",
    `Technical: Router ${sanitize(r.routerUrl)}; resource ${sanitize(r.resource.method)} ${sanitize(resourcePathOf(r.resource.url))} (Router-internal, fixed by this payer); ref ${sanitize(r.ref)}; asset ids ${sanitize(s.asset)} / ${sanitize(d.asset)}; networks ${sanitize(s.network)} / ${sanitize(d.network)}.`,
  );
  return lines.join("\n");
}
