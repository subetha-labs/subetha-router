import path from "node:path";
import { createPurchaseCore } from "./purchase.js";
import { routerIdentity } from "../router/identity.js";
import { generateRef } from "./ref.js";
import { sign } from "../sign/index.js";
import { readConfig } from "../config.js";
import { realFs, StoreError, type StoreFs } from "../store/fs.js";
import { acquireLock, type LockDeps } from "../store/lock.js";
import { ensureStoreDir, storeDirOf } from "../store/paths.js";
import { openWallet, parseKeysDocument, unlockKeys, zero } from "../store/keys.js";
import { openLedger, type Ledger } from "../store/ledger.js";
import { RouterClient } from "../router/client.js";
import { failure } from "../protocol/summary.js";
import { Session, MAX_TTL_MS } from "./session.js";
import { checkInstallSeal, installHashes } from "./seal.js";
import type { DaemonContext, DaemonHooks } from "./interfaces.js";
import type { Listener } from "./server.js";

import { preflight } from "./preflight.js";
export { preflight } from "./preflight.js";

export interface StartupOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly execArgv: readonly string[];
  readonly installRoot: string;
  readonly hooks: DaemonHooks;
  readonly fs?: StoreFs;
  readonly lockDeps?: Omit<LockDeps, "fs">;
  readonly checkOnly?: boolean;
}
export interface RunningDaemon { readonly context: DaemonContext; readonly closed: Promise<void>; close(): Promise<void> }

/** Common production/test entry. All pre-secret checks precede the first TTY read. */
export async function startDaemon(options: StartupOptions): Promise<RunningDaemon | undefined> {
  const startedAt = Date.now();
  preflight(options.execArgv, options.env);
  const fs = options.fs ?? realFs;
  const dir = storeDirOf({ HOME: options.env.HOME, XDG_CONFIG_HOME: options.env.XDG_CONFIG_HOME });
  if (ensureStoreDir(dir, options.env.HOME!, process.getuid!(), fs).length) throw new StoreError("path_invalid");
  if (!await options.hooks.ui.available()) throw new StoreError("no_confirmation_ui");
  if (options.checkOnly) return undefined;
  try { fs.lstatSync(path.join(dir, "daemon.lock.reclaim")); throw new StoreError("reclaim_busy"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = acquireLock(dir, { fs, ...options.lockDeps });
  let session: Session | undefined;
  let keys: ReturnType<typeof unlockKeys> | undefined;
  let ledger: Ledger | undefined;
  let listener: Listener | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let phrase = "";
  let stopped = false;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const assertHeld = (): void => {
    if (stopped || !lock.stillHeld()) { stopped = true; session?.close(); throw new StoreError("lock_lost"); }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    clearInterval(watchdog);
    session?.close();
    phrase = "";
    closing = (async () => {
      try { await listener?.close(); }
      finally {
        try { ledger?.close(); }
        finally { if (keys) zero(keys.kek, keys.lek); lock.release(); resolveClosed(); }
      }
    })();
    return closing;
  };
  try {
    await options.hooks.faults?.hit("after:lock");
    assertHeld();
    if (!options.hooks.tty.available) throw new StoreError("no_tty");
    const config = readConfig(dir, fs);
    const identity = routerIdentity(config.router.url, config.router.canonicalResource);
    const router = new RouterClient(new URL(identity.routerUrl));
    const doc = parseKeysDocument(fs.readFileSync(path.join(dir, "keys.json")).toString("utf8"));
    for (let attempt = 0; attempt < 3; attempt++) {
      assertHeld();
      let pass = await options.hooks.tty.read("Passphrase");
      try { assertHeld(); keys = unlockKeys(doc, pass); break; }
      catch (error) { if (!(error instanceof StoreError) || error.code !== "bad_passphrase" || attempt === 2) throw error; }
      finally { pass = ""; }
    }
    if (!keys) throw new StoreError("bad_passphrase");
    phrase = await options.hooks.tty.read("Security phrase");
    if (!phrase.trim() || phrase.length > 256 || /[\x00-\x1f\x7f]/.test(phrase)) throw new StoreError("phrase_invalid");
    assertHeld();
    await options.hooks.faults?.hit("before:seal");
    assertHeld();
    checkInstallSeal(path.join(dir, "install.seal"), installHashes(options.installRoot, fs), keys.lek, fs, assertHeld);
    await options.hooks.faults?.hit("after:seal");
    assertHeld();
    await options.hooks.faults?.hit("before:key-decrypt");
    assertHeld();
    const key = openWallet(doc, "eip155", keys.kek);
    zero(keys.kek);
    if (key.length !== 32) { zero(key); throw new StoreError("wallet_invalid"); }
    session = new Session(key, config.session?.ttlMs ?? MAX_TTL_MS, startedAt);
    assertHeld();
    ledger = openLedger(path.join(dir, "ledger.ndjson"), keys.lek, fs);
    const ui = options.hooks.createConfirmUi?.((passphrase) => {
      // Re-derive only for this validated document. Never retain the startup input,
      // reopen a wallet, or use any credential supplied by a socket/CLI/environment.
      assertHeld();
      if (session!.locked) return false;
      try {
        const checked = unlockKeys(doc, passphrase);
        zero(checked.kek, checked.lek);
        return true;
      } catch { return false; }
    }) ?? options.hooks.ui;
    const context: DaemonContext = {
      session, ledger, router, address: doc.wallets["eip155"]!.address,
      get phrase() { return phrase; }, assertHeld,
      purchase: (options.hooks.configurePurchase ?? (value => value))({
        routerUrl: identity.routerUrl, canonicalResource: identity.resource, generateRef, ui,
        signer: { sign: (offer) => {
          assertHeld();
          if (session!.locked) throw new StoreError("locked");
          return sign(offer, key);
        } },
        ...(options.hooks.faults ? { faults: options.hooks.faults } : {}),
      }),
    };
    const handler = options.hooks.handler(context);
    let ready = false;
    // Restricts the socket from creation, not only after chmod. Never restore a permissive mask in this daemon.
    process.umask(0o077);
    assertHeld();
    listener = await options.hooks.listen(path.join(dir, "daemon.sock"), async (request) => {
      try {
        assertHeld();
        if (!ready) return failure("daemon_unavailable");
        const result = await handler(request);
        assertHeld();
        return result;
      } catch (error) {
        if (error instanceof StoreError && error.code === "lock_lost") { void close(); return failure("lock_lost"); }
        throw error;
      }
    });
    assertHeld();
    await createPurchaseCore(context).recover();
    await options.hooks.recover(context);
    assertHeld();
    ready = true;
    watchdog = setInterval(() => { try { assertHeld(); } catch { void close(); } }, 250);
    watchdog.unref();
    return { context, close, closed };
  } catch (error) { await close(); throw error; }
}
