import path from "node:path";
import { z } from "zod";
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

function forbiddenEnv(key: string): boolean {
  return ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "LD_LIBRARY_PATH"].includes(key) || key.startsWith("DYLD_") || /^SUBETHA_PAYER_.*(PASS|KEY|SECRET|PHRASE|APPROV)/i.test(key);
}
export function preflight(argv: readonly string[], env: NodeJS.ProcessEnv): void {
  const badEnv = Object.keys(env).filter(forbiddenEnv);
  for (const key of badEnv) delete env[key];
  // Node treats underscores as hyphens in long option names. Leave values and caller argv intact.
  const flags = argv.map((arg) => arg.replace(/^--[^=]*/, (name) => name.replaceAll("_", "-")));
  if (!flags.includes("--disable-sigusr1") || flags.some((arg) => /^--no-disable-sigusr1(?:=|$)/.test(arg))) throw new StoreError("sigusr1_enabled");
  if (badEnv.length) throw new StoreError("forbidden_env");
  if (flags.some((arg) => /^(-r($|[^-])|--(require|import)(=|$)|--inspect|--report-|--heapsnapshot-|--cpu-prof|--heap-prof|--diagnostic-dir|--experimental-|--expose-(?!gc(?:$|=)))/.test(arg))) throw new StoreError("forbidden_flag");
}

const Config = z.object({
  version: z.literal(1),
  router: z.object({ url: z.string().url() }).strict(),
  session: z.object({ ttlMs: z.number().int().min(1).max(MAX_TTL_MS) }).strict().optional(),
}).strict();

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
    const configPath = path.join(dir, "config.json");
    let rawConfig: unknown = { version: 1, router: { url: "https://router.subethalabs.com/mcp" } };
    if (fs.existsSync(configPath)) {
      try { rawConfig = JSON.parse(fs.readFileSync(configPath).toString("utf8")); }
      catch { throw new StoreError("store_corrupt"); }
    }
    if (typeof rawConfig === "object" && rawConfig !== null && "version" in rawConfig && rawConfig.version !== 1) throw new StoreError("store_unsupported_version");
    const parsed = Config.safeParse(rawConfig);
    if (!parsed.success) throw new StoreError("config_invalid");
    const router = new RouterClient(new URL(parsed.data.router.url));
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
    session = new Session(key, parsed.data.session?.ttlMs ?? MAX_TTL_MS, startedAt);
    assertHeld();
    ledger = openLedger(path.join(dir, "ledger.ndjson"), keys.lek, fs);
    const context: DaemonContext = { session, ledger, router, address: doc.wallets["eip155"]!.address, get phrase() { return phrase; }, assertHeld };
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
    await options.hooks.recover(context);
    assertHeld();
    ready = true;
    watchdog = setInterval(() => { try { assertHeld(); } catch { void close(); } }, 250);
    watchdog.unref();
    return { context, close, closed };
  } catch (error) { await close(); throw error; }
}
