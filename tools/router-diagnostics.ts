/**
 * Router の子の診断の記録の配線（`docs/rejection-reasons-design.md` §2.1、タスク R-2）。**製品コードではない**（起動側）。
 *
 * - 入口（`tools/remote-mcp.ts` の `hostPlanOf`、公開と受け入れの計画だけ）が、Router の子の env に `SUBETHA_DIAGNOSTICS_PATH` を 1 つ足す:
 *   `<journal のディレクトリ>/diagnostics/router.ndjson`（公開 `/app/runtime/diagnostics/router.ndjson`、受け入れ `/app/runtime/acceptance/diagnostics/router.ndjson`）。
 *   ホストの env に `SUBETHA_DIAGNOSTICS=off` があれば足さない（no-op の sink）。mainnet の 1 経路・EVM testnet の専用の計画は足さない。
 * - Router の子（`tools/remote-router-process.ts`）は、その env があるときだけファイルの sink（component `router`、32 MiB）を作って注入する。
 *   作るだけでは開かない（最初の書き込みで 0700 のディレクトリ・0600 のファイルを作る）。
 * 純粋（import しても何もしない）。
 */
import path from "node:path";

import { createFileDiagnosticsSink, DIAG_FILE_BYTES, type FileDiagnosticsSink } from "../src/shared/diagnostics-file.js";

/** 入口 → Router の子の env（ファイルの path）。 */
export const DIAGNOSTICS_PATH_ENV = "SUBETHA_DIAGNOSTICS_PATH";
/** 本番の env の止める switch（値 `off` のときだけ止める）。 */
export const DIAGNOSTICS_SWITCH_ENV = "SUBETHA_DIAGNOSTICS";

/** journal の隣の診断のファイル（同じボリューム）。 */
export function routerDiagnosticsPathOf(journalPath: string): string {
  return path.join(path.dirname(journalPath), "diagnostics", "router.ndjson");
}

/** Router の子の env に足す分（止めていれば空）。 */
export function diagnosticsChildEnvOf(journalPath: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return env[DIAGNOSTICS_SWITCH_ENV] === "off" ? {} : { [DIAGNOSTICS_PATH_ENV]: routerDiagnosticsPathOf(journalPath) };
}

/** Router の子のファイルの sink（env が無い・空なら `undefined` = no-op）。 */
export function routerDiagnosticsSinkOf(env: Readonly<Record<string, string | undefined>>): FileDiagnosticsSink | undefined {
  const file = env[DIAGNOSTICS_PATH_ENV];
  if (file === undefined || file === "") return undefined;
  return createFileDiagnosticsSink({ path: file, component: "router", limits: { maxFileBytes: DIAG_FILE_BYTES.router } });
}
