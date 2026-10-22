/**
 * zkTLS lab（別リポジトリ・読み取り専用）の所在と、`delivery` バイナリの実行（試験基盤）。
 *
 * - `SUBETHA_ZKTLS_LAB_DIR`（既定 `~/.worktrees/subetha-zktls-router/private-payment-binding-20261017`）: バイナリ `phase5/runner/target/release/delivery`、
 *   fixture CA `phase5/.local/upstream-tlsn/crates/tls-server-fixture/src/{root_ca.crt,test_server.crt,test_server.key}`。
 * - `SUBETHA_ZKTLS_SRS_DAT`（既定 `~/.hermes/research/subetha-zktls-delivery-spike/tools/srs/bn254_g1.dat`）。
 * 無ければ wire は skip（skip は合格ではなく「未検証」）。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LabPaths {
  readonly available: boolean;
  readonly reason?: string;
  readonly labDir: string;
  readonly bin: string;
  readonly srs: string;
  readonly caDir: string;
  readonly rootCa: string;
  readonly serverCert: string;
  readonly serverKey: string;
}

export function labPaths(): LabPaths {
  const labDir = process.env["SUBETHA_ZKTLS_LAB_DIR"] ?? path.join(os.homedir(), ".worktrees/subetha-zktls-router/private-payment-binding-20261017");
  const bin = path.join(labDir, "phase5/runner/target/release/delivery");
  const srs = process.env["SUBETHA_ZKTLS_SRS_DAT"] ?? path.join(os.homedir(), ".hermes/research/subetha-zktls-delivery-spike/tools/srs/bn254_g1.dat");
  const caDir = path.join(labDir, "phase5/.local/upstream-tlsn/crates/tls-server-fixture/src");
  const rootCa = path.join(caDir, "root_ca.crt");
  const serverCert = path.join(caDir, "test_server.crt");
  const serverKey = path.join(caDir, "test_server.key");
  const missing = [bin, srs, rootCa, serverCert, serverKey].filter((file) => !existsSync(file));
  return { available: missing.length === 0, ...(missing.length === 0 ? {} : { reason: `missing: ${missing.join(", ")}` }), labDir, bin, srs, caDir, rootCa, serverCert, serverKey };
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `delivery <sub> <args…>` を別プロセスで（Payer・executor の役: Router とは別の工程）。 */
export function runDelivery(lab: LabPaths, args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      lab.bin,
      [...args],
      { cwd: options.cwd ?? lab.labDir, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DELIVERY_SRS_DAT: lab.srs, RUST_LOG: "info" }, timeout: options.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}
