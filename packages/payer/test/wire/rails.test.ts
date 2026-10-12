/**
 * AC-R4 (docs/payer-rails-design.md): every inbound rail, static and dynamic, through the real daemon process, Unix socket and the
 * local TCP MCP fixture: quote → purchase (fixture signer and native-UI stand-in) → saved status. The listing projects every rail.
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { fixtureStore } from "../harness/store.js";
import { ownedChild, tsxLoader } from "../harness/children.js";
import { socketClient } from "../harness/daemon.js";
import { fakeRouter, railListing, UPSTREAM_OF, type RailFixture } from "../harness/router.js";

const entry = fileURLToPath(new URL("../harness/daemon-test-entry.ts", import.meta.url));
async function setup() {
  const fake = await fakeRouter(); const store = fixtureStore(fake.url.href);
  const child = ownedChild(["--disable-sigusr1", "--import", tsxLoader, entry], store.home);
  child.child.send({ home: store.home, installRoot: store.installRoot, passphrase: store.passphrase, phrase: store.phrase, purchase: true });
  try { await child.waitFor("listening"); }
  catch (error) { await child.close(); store.cleanup(); await fake.close(); throw error; }
  const socket = socketClient(store.dir);
  return { fake, store, child, socket, async close() { socket.close(); await child.close(); store.cleanup(); await fake.close(); } };
}

const RAILS: RailFixture[] = ["tempo", "arc", "sol", "solmpp", "dyn-x402-to-mpp", "dyn-mpp-to-x402", "dyn-sol-to-x402", "dyn-solmpp-to-x402", "dyn-arc-to-x402"];

test("daemon process → every rail fixture: quote (static or by URL) → one purchase → saved status with the delivered body", async () => {
  const f = await setup();
  try {
    for (const rail of RAILS) {
      const fixture = f.fake.useFixture(rail);
      const upstream = UPSTREAM_OF(rail);
      const params = upstream ? { profileId: fixture.quote.routeId, url: upstream } : { routeId: fixture.quote.routeId };
      const q = await f.socket.send("quote", params);
      expect(q.ok, `${rail}: ${JSON.stringify(q)}`).toBe(true);
      const mpp = fixture.quote.source.rail === "mpp";
      expect(q.result.subject).toMatchObject({ routeId: fixture.quote.routeId, kind: upstream ? "dynamic" : "static", scheme: fixture.quote.source.offer.scheme, fundsMoveOnCredential: mpp, amount: fixture.quote.source.amount, network: fixture.quote.source.network });
      expect(q.result.nextStep).toBe(mpp ? "approve_before_sign_mpp" : "approve_then_purchase");
      if (upstream) expect(q.result.subject).toMatchObject({ upstreamUrl: upstream, pricing: { upstreamAmount: "10000", fee: "1000", total: "11000" } });
      const ref = q.result.ref;
      const p = await f.socket.send("purchase", { ref });
      expect(p.result, `${rail}: ${JSON.stringify(p)}`).toMatchObject({ state: "result", outcome: "delivered", fundsMoved: "yes", proof: { upstreamReceipt: upstream ? "claimed" : "none" } });
      if (fixture.quote.source.offer.scheme === "tempo/charge") expect(p.result.txRef).toBe(`0x${"ab".repeat(32)}`); else expect(p.result.txRef).toBeUndefined();
      expect((await f.socket.send("status", { ref, includeBody: true })).result.result.body).toEqual({ value: "x".repeat(2048) });
      // The whole document (ownerKey included) reached the Router; nothing secret reached the ledger plaintext or the child's output.
      const sent = f.fake.state.purchases.at(-1)!;
      expect((sent.quote as { ownerKey?: string }).ownerKey).toBe((fixture.quote as { ownerKey?: string }).ownerKey);
      const rows = readFileSync(path.join(f.store.dir, "ledger.ndjson"), "utf8");
      const exposed = rows + f.child.stdout + f.child.stderr + JSON.stringify(p);
      for (const secret of [f.store.passphrase, f.store.phrase, "fixture-credential", (fixture.quote as { ownerKey?: string }).ownerKey ?? "\u0000", (fixture.quote.source.offer.extra as { challenge?: string }).challenge ?? "\u0000"]) expect(exposed, rail).not.toContain(secret);
    }
    expect(f.fake.state.calls.purchase).toBe(RAILS.length);
    expect(f.fake.state.calls.quoteUrl).toBe(RAILS.filter(r => UPSTREAM_OF(r)).length);
    expect(f.child.messages.filter((m: any) => m.event === "confirm")).toHaveLength(RAILS.length);
    expect(f.child.messages.filter((m: any) => m.event === "sign")).toHaveLength(RAILS.length);
  } finally { await f.close(); }
});

test("quote by URL: a profile the Router does not know, a URL the Router cannot quote, and a non-https URL fail before any ledger row", async () => {
  const f = await setup();
  try {
    f.fake.useFixture("dyn-x402-to-mpp");
    expect((await f.socket.send("quote", { profileId: "dyn-nope-to-x", url: "https://x402.vercel.app/protected" })).error.code).toBe("unknown_route");
    expect((await f.socket.send("quote", { profileId: "dyn-x402-to-mpp", url: "https://other.example/" })).error.code).toBe("quote_failed");
    expect((await f.socket.send("quote", { profileId: "dyn-x402-to-mpp", url: "http://provider-mpp.subethalabs.com/v1/eth/snapshot" })).error.code).toBe("invalid_request");
    expect((await f.socket.send("quote", { routeId: "md-mpp-eth-snapshot", url: "https://x402.vercel.app/protected" })).error.code).toBe("invalid_request");
    expect(readFileSync(path.join(f.store.dir, "ledger.ndjson"), "utf8").trim()).toBe("");
  } finally { await f.close(); }
});

test("find_routes projects every static route and dynamic profile with its rail (listing with and without source.rail); wallet lists both keys", async () => {
  const f = await setup();
  try {
    for (const withRail of [false, true]) {
      f.fake.state.listing = railListing(withRail);
      const routes = (await f.socket.send("find_routes", {})).result.routes as any[];
      const byId = Object.fromEntries(routes.map(r => [r.routeId, r]));
      expect(Object.keys(byId).sort()).toEqual(["dyn-arc-to-x402", "dyn-mpp-to-x402", "dyn-sol-to-x402", "dyn-solmpp-to-x402", "dyn-x402-to-mpp", "md-mpp-eth-snapshot", "md-mpp-eth-snapshot-arc", "md-mpp-eth-snapshot-solmpp", "md-x402-eth-snapshot", "md-x402-eth-snapshot-sol"]);
      expect(byId["md-x402-eth-snapshot"]).toMatchObject({ kind: "static", pays: { rail: "mpp", network: "eip155:42431" }, fundsMoveOnCredential: true, needsSol: false });
      expect(byId["md-x402-eth-snapshot-sol"]).toMatchObject({ pays: { rail: "x402", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, fundsMoveOnCredential: false, needsSol: false });
      expect(byId["md-mpp-eth-snapshot-solmpp"]).toMatchObject({ pays: { rail: "mpp" }, fundsMoveOnCredential: true, needsSol: true });
      expect(byId["dyn-solmpp-to-x402"]).toMatchObject({ kind: "dynamic", pays: { rail: "mpp" }, reaches: { rail: "x402", network: "eip155:84532" }, needsSol: true });
      expect(byId["dyn-x402-to-mpp"].pays.amount).toBeUndefined();
      const held = (await f.socket.send("find_routes", { hold: [{ network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000" }] })).result.routes as any[];
      expect(held.map(r => r.routeId).sort()).toEqual(["dyn-mpp-to-x402", "md-x402-eth-snapshot"]);
    }
    const wallet = (await f.socket.send("wallet", {})).result.wallets as any[];
    expect(wallet.map(w => `${w.rail}:${w.network}`).sort()).toEqual(["mpp:eip155:42431", "mpp:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "x402:eip155:5042002", "x402:eip155:84532", "x402:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
  } finally { await f.close(); }
});
