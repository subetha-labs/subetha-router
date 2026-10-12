/** AC-R2 (docs/payer-rails-design.md): every inbound rail, static and dynamic, through the v2 record builder; mutations fail closed. */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { assertApproval, buildRecord, buildRecordV1, offerDigest, recordHash, recordVersionOf, render, subjectOf } from "../../src/daemon/record.js";
import { HOSTED_ROUTER_URL } from "../../src/router/identity.js";
import { h1Quote, railQuote, UPSTREAM_OF, type RailFixture } from "../harness/router.js";

const EVM = `0x${"33".repeat(20)}`;
const SOLANA = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const identity = (wallets: Record<string, string> = { eip155: EVM, solana: SOLANA }) => ({ routerUrl: HOSTED_ROUTER_URL, address: EVM, wallets, ref: "p_aaaaaaaaaaaaa", requestId: randomUUID() });
const FIXTURES: RailFixture[] = ["base", "tempo", "arc", "sol", "solmpp", "dyn-x402-to-mpp", "dyn-mpp-to-x402", "dyn-sol-to-x402", "dyn-solmpp-to-x402", "dyn-arc-to-x402"];

describe("v2 record: every rail fixture builds and binds", () => {
  for (const fixture of FIXTURES) test(`${fixture}: builds, records the rail, picks the key by network, never copies ownerKey`, () => {
    const response = railQuote(fixture);
    const r = buildRecord(response, identity());
    expect(recordVersionOf(r)).toBe(2);
    expect(r.kind).toBe(fixture.startsWith("dyn-") ? "dynamic" : "static");
    expect(r.routeId).toBe(response.quote.routeId);
    expect(r.source.scheme).toBe(response.quote.source.offer.scheme);
    expect(r.source.rail).toBe(response.quote.source.rail);
    expect(r.wallet.address).toBe(response.quote.source.network.startsWith("solana:") ? SOLANA : EVM);
    expect(r.source.offerSha256).toBe(offerDigest(response.quote.source.offer));
    expect(JSON.stringify(r)).not.toContain("ownerKey");
    if (r.kind === "dynamic") {
      expect(r.upstream?.url).toBe(UPSTREAM_OF(fixture));
      expect(r.pricing?.total).toBe(r.source.amount);
      expect(r.disclosures?.fundsMoveOnCredential).toBe(r.source.fundsMoveOnCredential);
      expect(JSON.stringify(r)).not.toContain((response.quote as { ownerKey?: string }).ownerKey!);
    }
    // The resource is derived from the routeId, not trusted from the document.
    expect(r.resource.url).toBe(`http://127.0.0.1:8500/v1/routes/${response.quote.routeId}/resource`);
    // Approval over the same offer passes; the rendered dialog is deterministic.
    expect(() => assertApproval(r, response.quote.source.offer, recordHash(r), false)).not.toThrow();
    expect(render(r)).toBe(render(r));
  });

  test("subject summary carries routeId, kind, scheme, upstream and pricing; MPP on Solana flags needsSol", () => {
    const dyn = subjectOf(buildRecord(railQuote("dyn-x402-to-mpp"), identity()));
    expect(dyn).toMatchObject({ routeId: "dyn-x402-to-mpp", kind: "dynamic", scheme: "exact", upstreamUrl: "https://provider-mpp.subethalabs.com/v1/eth/snapshot", pricing: { upstreamAmount: "10000", fee: "1000", total: "11000", maxFee: "158" }, fundsMoveOnCredential: false, needsSol: false });
    expect(dyn.disclosures).toMatchObject({ destinationVerifiedByOperator: false, refundOnFailure: false });
    const solmpp = subjectOf(buildRecord(railQuote("solmpp"), identity()));
    expect(solmpp).toMatchObject({ kind: "static", scheme: "solana/charge", fundsMoveOnCredential: true, needsSol: true });
    expect(solmpp.upstreamUrl).toBeUndefined();
  });

  test("dialog text: rail and funds lines per rail; dynamic shows upstream URL, recipient, price breakdown and disclosures", () => {
    const tempo = render(buildRecord(railQuote("tempo"), identity()));
    expect(tempo).toContain("Rail: mpp (tempo/charge) on eip155:42431");
    expect(tempo).toContain("Funds: the daemon SENDS this transfer right after you approve");
    expect(tempo).toContain("Approving sends the transfer.");
    const solmpp = render(buildRecord(railQuote("solmpp"), identity()));
    expect(solmpp).toContain("Funds: signing only; the Router broadcasts at purchase. Your Solana key pays the network fee (devnet SOL).");
    const dyn = render(buildRecord(railQuote("dyn-x402-to-mpp"), identity()));
    expect(dyn).toContain("Profile: dyn-x402-to-mpp");
    expect(dyn).toContain("Upstream (NOT verified by the operator): GET https://provider-mpp.subethalabs.com/v1/eth/snapshot");
    expect(dyn).toContain("Upstream recipient: 0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1");
    expect(dyn).toContain("Price: upstream 10000 + Router fee 1000 = total 11000 base units (decimals 6); chain-fee cap 158");
    expect(dyn).toContain("Disclosures: no refund if the upstream takes the payment");
    expect(dyn).not.toContain("Fee breakdown: not supplied");
    const base = render(buildRecord(railQuote("base"), identity()));
    expect(base).toContain("Funds: signing only; the facilitator broadcasts and pays gas at purchase.");
    expect(base).toContain("Fee breakdown: not supplied for this static route.");
    // The dialog never prints the MPP challenge, an ownerKey or the raw nextStep prose.
    const tempoQuote = railQuote("tempo");
    expect(render(buildRecord(tempoQuote, identity()))).not.toContain((tempoQuote.quote.source.offer.extra as { challenge: string }).challenge);
  });
});

describe("v2 record: fails closed", () => {
  test("a Solana offer without a Solana key, and any mainnet offer, are rail_not_enabled (never quote_inconsistent)", () => {
    expect(() => buildRecord(railQuote("sol"), identity({ eip155: EVM }))).toThrow("rail_not_enabled");
    expect(() => buildRecord(railQuote("solmpp"), identity({ eip155: EVM }))).toThrow("rail_not_enabled");
    const mainnet = railQuote("base") as any;
    mainnet.quote.source.network = "eip155:8453"; mainnet.quote.source.offer.network = "eip155:8453"; mainnet.subject.source.network = "eip155:8453"; mainnet.subject.source.offer.network = "eip155:8453";
    mainnet.quote.source.asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; mainnet.quote.source.offer.asset = mainnet.quote.source.asset; mainnet.subject.source.asset = mainnet.quote.source.asset; mainnet.subject.source.offer.asset = mainnet.quote.source.asset;
    mainnet.quote.source.offer.extra.name = "USD Coin"; mainnet.subject.source.offer.extra.name = "USD Coin";
    expect(() => buildRecord(mainnet, identity())).toThrow("rail_not_enabled");
  });

  const mutations: [string, RailFixture, (v: any) => void][] = [
    ["dynamic: upstream URL changed in the document only", "dyn-x402-to-mpp", v => { v.quote.upstream.url = "https://evil.invalid/x"; }],
    ["dynamic: upstream URL changed consistently but routeBinding still names the old one", "dyn-x402-to-mpp", v => { v.quote.upstream.url = "https://evil.invalid/x"; v.subject.upstream.url = "https://evil.invalid/x"; }],
    ["dynamic: total != source amount", "dyn-x402-to-mpp", v => { v.quote.pricing.total = "12000"; v.subject.pricing.total = "12000"; }],
    ["dynamic: destination recipient changed in the document only", "dyn-x402-to-mpp", v => { v.quote.destination.payTo = "0x" + "44".repeat(20); }],
    ["dynamic: disclosures fundsMoveOnCredential contradicts the offer", "dyn-x402-to-mpp", v => { v.quote.disclosures.fundsMoveOnCredential = true; v.subject.disclosures.fundsMoveOnCredential = true; }],
    ["dynamic: ownerKey missing", "dyn-x402-to-mpp", v => { delete v.quote.ownerKey; }],
    ["dynamic: pricing missing", "dyn-x402-to-mpp", v => { delete v.quote.pricing; delete v.subject.pricing; }],
    ["static: carries a pricing document", "base", v => { v.quote.pricing = { upstreamAmount: "10000", converted: "10000", fee: "0", total: "10000", sourceDecimals: 6, destinationDecimals: 6 }; }],
    ["static: routeBinding of another route", "tempo", v => { v.quote.source.offer.extra.routeBinding = ["md-mpp-eth-snapshot", "GET", "/v1/routes/md-mpp-eth-snapshot/resource"].map(encodeURIComponent).join("|"); v.subject.source.offer.extra.routeBinding = v.quote.source.offer.extra.routeBinding; }],
    ["static: resource of another route", "tempo", v => { v.quote.resource.url = "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource"; v.subject.resource.url = v.quote.resource.url; }],
    ["mpp: challenge missing", "tempo", v => { delete v.quote.source.offer.extra.challenge; delete v.subject.source.offer.extra.challenge; }],
    ["mpp: source rail says x402", "tempo", v => { v.quote.source.rail = "x402"; }],
    ["x402: fundsMoveOnCredential true", "base", v => { v.quote.source.offer.extra.fundsMoveOnCredential = true; v.subject.source.offer.extra.fundsMoveOnCredential = true; v.subject.fundsMoveOnCredential = true; }],
    ["svm: memo != nonce", "sol", v => { v.quote.source.offer.extra.memo = `0x${"cd".repeat(32)}`; v.subject.source.offer.extra.memo = v.quote.source.offer.extra.memo; }],
    ["svm: unknown extra key", "sol", v => { v.quote.source.offer.extra.mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; v.subject.source.offer.extra.mint = v.quote.source.offer.extra.mint; }],
    ["solmpp: externalId differs from the challenge", "solmpp", v => { v.quote.source.offer.extra.externalId = "other"; v.subject.source.offer.extra.externalId = "other"; }],
    ["any: source decimals disagree with the table", "arc", v => { v.quote.source.decimals = 18; v.subject.source.decimals = 18; }],
    ["arc: assetTransferMethod other than eip3009", "arc", v => { v.quote.source.offer.extra.assetTransferMethod = "permit2"; v.subject.source.offer.extra.assetTransferMethod = "permit2"; }],
    ["base: assetTransferMethod on a non-Circle network is accepted only as eip3009 (unknown extra keys stay refused)", "base", v => { v.quote.source.offer.extra.facilitator = "x"; v.subject.source.offer.extra.facilitator = "x"; }],
    ["any: deadline after the offer's expiry", "arc", v => { v.quote.approval.deadlineMs += 1000; v.subject.approval.deadlineMs += 1000; }],
    ["any: amount above the signing cap", "base", v => { for (const o of [v.quote.source, v.quote.source.offer, v.subject.source, v.subject.source.offer]) o.amount = "20001"; }],
  ];
  for (const [name, fixture, change] of mutations) test(`reject ${name}`, () => {
    const v = structuredClone(railQuote(fixture)); change(v);
    expect(() => buildRecord(v, identity())).toThrow(/quote_inconsistent|rail_not_enabled/);
  });

  test("approval digest: changing a transaction-affecting field that no individual check covers is approval_mismatch", () => {
    const sol = railQuote("sol"); const r = buildRecord(sol, identity()); const hash = recordHash(r);
    const feePayer = structuredClone(sol.quote.source.offer) as any; feePayer.extra.feePayer = "FEEpayer2222222222222222222222222222222222222";
    expect(() => assertApproval(r, feePayer, hash, false)).toThrow("approval_mismatch");
    const base = railQuote("base"); const rb = buildRecord(base, identity());
    const domain = structuredClone(base.quote.source.offer) as any; domain.extra.version = "3";
    expect(() => assertApproval(rb, domain, recordHash(rb), false)).toThrow("approval_mismatch");
    const tempo = railQuote("tempo"); const rt = buildRecord(tempo, identity());
    const challenge = structuredClone(tempo.quote.source.offer) as any; challenge.extra.challenge = challenge.extra.challenge.replace("MPP Payment", "MPP Payment2");
    expect(() => assertApproval(rt, challenge, recordHash(rt), false)).toThrow("approval_mismatch");
    const solmpp = railQuote("solmpp"); const rs = buildRecord(solmpp, identity());
    const external = structuredClone(solmpp.quote.source.offer) as any; external.extra.externalId = "x";
    expect(() => assertApproval(rs, external, recordHash(rs), false)).toThrow("approval_mismatch");
    // The unchanged offers still pass.
    for (const [rec, resp] of [[r, sol], [rb, base], [rt, tempo], [rs, solmpp]] as const) expect(() => assertApproval(rec, resp.quote.source.offer, recordHash(rec), false)).not.toThrow();
  });

  test("0.1.x builder stays frozen: same record and hash for the static fixture, no kind/offerSha256; v2 of the same quote differs only by the additions", () => {
    const input = h1Quote(); const id = identity();
    const v1 = buildRecordV1(input, id);
    expect(recordVersionOf(v1)).toBe(1);
    expect(v1.kind).toBeUndefined(); expect(v1.source.offerSha256).toBeUndefined();
    const v2 = buildRecord(input, id);
    const { kind: _k, ...restV2 } = v2; const { offerSha256: _d, ...sourceV2 } = restV2.source;
    expect({ ...restV2, source: sourceV2 }).toEqual(v1);
    expect(recordHash(v1)).not.toBe(recordHash(v2));
    // v1 approval checks are the 0.1.x ones; v2 adds the digest.
    expect(() => assertApproval(v1, input.quote.source.offer, recordHash(v1), false)).not.toThrow();
    const changed = structuredClone(input.quote.source.offer) as any; changed.extra.version = "3";
    expect(() => assertApproval(v2, changed, recordHash(v2), false)).toThrow("approval_mismatch");
  });
});
