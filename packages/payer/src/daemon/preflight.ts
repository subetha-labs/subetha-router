import { StoreError } from "../store/fs.js";

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
