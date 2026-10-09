import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect } from "vitest";
import { reclaimLock } from "../../src/store/lock.js";
import { parseKeysDocument, unlockKeys, open as openSealed, zero } from "../../src/store/keys.js";
import { realFs } from "../../src/store/fs.js";
import { fixtureStore } from "./store.js";
import { fakeRouter } from "./router.js";
import { ownedChild, tsxLoader, within } from "./children.js";
import { socketClient } from "./daemon.js";
import { durableEvent, events } from "./durable.js";
import { plaintextRows } from "./secrecy.js";

const entry = fileURLToPath(new URL("./daemon-test-entry.ts", import.meta.url));
/** Actual separate daemon, real encrypted store, real Unix socket and local TCP MCP. Parent executes only. */
export async function recoveryFixture(point?: string, observeKey?: (key: Buffer) => void, failFs?: "EROFS" | "EIO", phrase?: string) {
  let observedFile = "";
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  let hold = point === "transport:before-response";
  const router = await fakeRouter({ observed: input => { durableEvent(observedFile, { event: "purchase", credentialHash: createHash("sha256").update(String(input["credential"])).digest("hex") }); writeFileSync(observedFile + ".ready", "observed", { mode: 0o600 }); }, beforeResponse: async () => { if (hold) await responseGate; } });
  const store = fixtureStore(router.url.href, 3_600_000, observeKey);
  observedFile = path.join(store.home, "router-counter.ndjson");
  let child: ReturnType<typeof ownedChild> | undefined;
  let socket: ReturnType<typeof socketClient> | undefined;
  const boot = async (barrier?: string) => {
    child = ownedChild(["--disable-sigusr1", "--import", tsxLoader, entry], store.home);
    child.child.send({ home: store.home, installRoot: store.installRoot, passphrase: store.passphrase, phrase: phrase ?? store.phrase, purchase: true, point: barrier, observedFile: observedFile + ".ready", failFs });
    await child.waitFor("listening"); socket = socketClient(store.dir);
  };
  try { await boot(point); } catch (error) { await child?.close(); store.cleanup(); await router.close(); throw error; }
  return {
    store, router, get child() { return child!; }, get socket() { return socket!; },
    counts() { return { sign: events(path.join(store.home, "events.ndjson")).filter(e => e.event === "sign").length, purchase: events(observedFile).length, ui: events(path.join(store.home, "events.ndjson")).filter(e => e.event === "confirm").length }; },
    rows() { return events(path.join(store.dir, "ledger.ndjson")); },
    plainRows() {
      // Only this newly created synthetic store; validate ciphertext before exempting it from AC-A9.
      const keys = unlockKeys(parseKeysDocument(readFileSync(path.join(store.dir, "keys.json"), "utf8")), store.passphrase);
      try { return plaintextRows(events(path.join(store.dir, "ledger.ndjson")), keys.lek); }
      finally { zero(keys.kek, keys.lek); }
    },
    savedCredentialHash() {
      const keys = unlockKeys(parseKeysDocument(readFileSync(path.join(store.dir, "keys.json"), "utf8")), store.passphrase);
      let bytes: Buffer | undefined;
      try {
        const row = events(path.join(store.dir, "ledger.ndjson")).find(row => row.state === "signed");
        if (!row?.sealed) throw new Error("fixture_missing_signed");
        bytes = openSealed(keys.lek, row.sealed, `${row.ref}:signed`);
        const credential: unknown = JSON.parse(bytes.toString("utf8")).credential;
        if (typeof credential !== "string") throw new Error("fixture_missing_credential");
        return createHash("sha256").update(credential).digest("hex");
      } finally { bytes?.fill(0); zero(keys.kek, keys.lek); }
    },
    async crash() {
      const lock = JSON.parse(readFileSync(path.join(store.dir, "daemon.lock"), "utf8"));
      expect(lock.pid).toBe(child!.child.pid); expect(lock.startedAt.length).toBeGreaterThan(0);
      child!.signal("SIGKILL"); expect(await within(child!.exited)).toEqual({ code: null, signal: "SIGKILL" });
      socket!.close();
      // Only after this exact owned child has positively exited; never another store/workflow lock.
      const reclaimed = reclaimLock(store.dir, { fs: realFs });
      expect(reclaimed.removed).toBe(true); expect(reclaimed.content?.pid).toBe(lock.pid);
      hold = false; releaseResponse();
    },
    async restart() { await boot(); },
    async close() {
      hold = false; releaseResponse(); socket?.close();
      await child?.close();
      // A concurrent boot may have delivered listening while child.close() waited for actual exit/close.
      socket?.close();
      await router.close(); store.cleanup();
    },
  };
}
/** Independent hosted contract fixture: fingerprint top-level, result is body, txRef learned later. */
export function statusProjection(quote: any, status = "delivered") {
  return { found: true, projection: { paymentId: quote.paymentId, routeId: quote.routeId, quoteFingerprint: quote.destination.quoteFingerprint,
    source: { amount: quote.source.amount, asset: quote.source.asset, network: quote.source.network, txRef: `0x${"12".repeat(32)}` },
    destination: { quoted: quote.destination.quoted, asset: quote.destination.asset, network: quote.destination.network, attempt: 1, outcome: "paid", txRef: `0x${"34".repeat(32)}` },
    status, updatedAt: new Date().toISOString(), ...(status === "delivered" ? { result: { value: "x".repeat(2048) } } : {}) } };
}
