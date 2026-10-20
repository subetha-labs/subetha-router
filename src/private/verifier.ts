/**
 * Verifier ランナー（`docs/zktls-router-design.md` §4、要件 FR-Z07・FR-Z12・SR-Z2）: lab の `delivery` バイナリを購入ごとに別プロセスで動かす。
 *
 * **起動手順（launch protocol）**: Router が死ぬ時点がどこでも、前世代の起動を再構成が取り消せること。
 *   1. Router が起動門 `D/launch.<kind>` を書く（「起動が保留中かもしれない」印）。
 *   2. `/bin/sh -c WRAPPER <deliveryBin> <args…>`。WRAPPER は固定文字列で、**pid の公開 → 門の確認 → exec** の順（`&&`。どこかで失敗すれば exec しない）。
 *      引数は位置パラメータ、パスは env（文字列へ補間しない）。`exec` の後も pid はシェルのものと同じ。umask 077 で、バイナリが 0644 で作るファイルは生成時から 0600。
 *   3. `serve` は pid ファイル（内容 = spawn の pid）と**今回新しく公開された** addr-file を期限の内側で待つ。`verify` は pid を確かめ、完了を待つ。
 * **再構成**（`inventory`）: 起動門を `*.cancelled` に rename してから pid ファイルを棚卸しし、生存と OS 由来の同一性（`ps -ww -o command=` の命令行が
 *   `deliveryBin` とその購入の作業ディレクトリを含む）を確かめて終了させ、終了を待つ。確認できない pid が 1 つでもあれば「確認できない」を返し、呼び出し側は秘匿購入の受付を閉じたままにする。
 * **監督**: 子は登録表に入れ、`kill()` は SIGTERM → 猶予 → SIGKILL のうえ `exit` を待つ。子の stdout/stderr は上限つきでファイルへ。
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

export type LaunchKind = "serve" | "verify";

/** 試験専用: wrapper の 3 つの段（pid の公開の前・公開の後で門の確認の前・門の確認の後で exec の前）に「到着を書いて解放ファイルを待つ」1 行を挟む。本番は渡さない。 */
export interface LaunchHooksForTest {
  readonly stages: Partial<Record<"beforePid" | "afterPid" | "afterGate", { readonly arrive: string; readonly release: string }>>;
}

export interface VerifierRunnerOptions {
  readonly deliveryBin: string;
  readonly srsPath: string;
  readonly trust: "mozilla" | "lab-fixture-ca";
  /** 子の stdout/stderr をファイルに書く上限（バイト）。超過分は捨てる。 */
  readonly maxChildOutputBytes: number;
  readonly now?: () => number;
  readonly launchHooksForTest?: LaunchHooksForTest;
  /** 試験専用: `ps` の代わり（pid → 命令行）。 */
  readonly commandLineOfForTest?: (pid: number) => Promise<string | undefined>;
  /** 固定文の運用者向け note。 */
  readonly note?: (message: string) => void;
}

export interface ServeArgs {
  readonly dir: string;
  readonly orderPath: string;
  readonly intentPath: string;
  readonly releasePath: string;
  readonly host: string;
  readonly path: string;
  /** バイナリに渡す相対 timeout（秒・正）。Router の期限の強制ではない。 */
  readonly timeoutSecs: number;
  /** pid・addr を待つ絶対期限（ミリ秒）。 */
  readonly readyByMs: number;
}

export interface VerifyArgs {
  readonly dir: string;
  readonly orderPath: string;
  readonly bundlePath: string;
  readonly intentPath: string;
  readonly releasePath: string;
  readonly host: string;
  readonly path: string;
  readonly timeoutMs: number;
  readonly requireExternalGate: boolean;
}

export interface Child {
  readonly pid: number;
  readonly kind: LaunchKind;
  /** 終了（code・signal）。 */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  /** SIGTERM → 猶予 → SIGKILL のうえ終了を待つ。何度呼んでもよい。 */
  kill(graceMs?: number): Promise<void>;
}

export type ServeOutcome = { readonly ok: true; readonly child: Child; readonly address: string } | { readonly ok: false; readonly reason: "launch_failed" | "not_ready" | "expired" };
export type VerifyOutcome =
  | { readonly ok: true; readonly result: unknown; readonly exitCode: number | null }
  | { readonly ok: false; readonly reason: "launch_failed" | "timeout" | "result_unreadable" | "result_too_large" | "exit_nonzero"; readonly exitCode?: number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type InventoryOutcome = { readonly ok: true; readonly terminated: number } | { readonly ok: false; readonly reason: "enumeration_failed" | "cancel_failed" | "unverifiable_pid" | "termination_unconfirmed" };

export interface VerifierRunner {
  serve(args: ServeArgs): Promise<ServeOutcome>;
  verify(args: VerifyArgs): Promise<VerifyOutcome>;
  /** 再構成・drain の前: 起動門を取り消し、前世代の子を終了させる。`workDir` 配下の `<paymentId>/` を全部見る。 */
  inventory(workDir: string): Promise<InventoryOutcome>;
  /** 登録表の子を全部終わらせる（drain）。 */
  closeAll(): Promise<void>;
  /** 期待する `--timeout-secs`（起動前の検査で使う）。 */
  readonly deliveryBinSha256: string;
}

export const PID_FILE: Readonly<Record<LaunchKind, string>> = { serve: "serve.pid", verify: "verify.pid" };
export const GATE_FILE: Readonly<Record<LaunchKind, string>> = { serve: "launch.serve", verify: "launch.verify" };
export const ADDR_FILE = "verifier.addr";
export const MAX_ADDR_BYTES = 64;
export const MAX_VERIFY_RESULT_BYTES = 64 * 1024;
const DEFAULT_GRACE_MS = 2_000;
const POLL_MS = 25;

/** 固定の wrapper（設計 §4）。試験の hook があるときだけ、各段の前に到着と待ちの 1 行を挟む。 */
export function wrapperOf(hooks?: LaunchHooksForTest): string {
  const hook = (stage: "beforePid" | "afterPid" | "afterGate"): string => {
    const spec = hooks?.stages[stage];
    if (spec === undefined) return "";
    const upper = stage.toUpperCase();
    return `{ printf 1 > "$ARRIVE_${upper}"; while [ ! -e "$RELEASE_${upper}" ]; do sleep 0.05; done; } && `;
  };
  return `umask 077 && ${hook("beforePid")}printf %s "$$" > "$PIDFILE.tmp" && mv -f "$PIDFILE.tmp" "$PIDFILE" && ${hook("afterPid")}[ -e "$GATE" ] && ${hook("afterGate")}exec "$0" "$@"`;
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 上限つきの読み（`maxBytes + 1` まで読んで超過を検出する）。 */
export function readBounded(file: string, maxBytes: number): { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly reason: "missing" | "too_large" } {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (size > maxBytes) return { ok: false, reason: "too_large" };
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const read = readSyncAll(fd, buffer, total);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return { ok: false, reason: "too_large" };
    }
    return { ok: true, bytes: buffer.subarray(0, total) };
  } finally {
    closeSync(fd);
  }
}

function readSyncAll(fd: number, buffer: Buffer, offset: number): number {
  return readSync(fd, buffer, offset, buffer.length - offset, null);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function commandLineOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-ww", "-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const line = stdout.trim();
      resolve(line === "" ? undefined : line);
    });
  });
}

/** 子の stdout/stderr を上限までファイルへ（0600）。超過分は捨てる。`close` は何度呼んでもよい（fd を漏らさない）。 */
function boundedSink(file: string, maxBytes: number): { write(chunk: Buffer): void; close(): void } {
  let fd: number | undefined;
  try {
    fd = openSync(file, "w", 0o600);
  } catch {
    fd = undefined;
  }
  let written = 0;
  const close = (): void => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // 既に閉じている。
    }
    fd = undefined;
  };
  return {
    write(chunk: Buffer): void {
      if (fd === undefined) return;
      const room = maxBytes - written;
      if (room <= 0) return;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      try {
        writeSync(fd, slice);
        written += slice.length;
      } catch {
        close();
      }
    },
    close,
  };
}

export function createVerifierRunner(options: VerifierRunnerOptions): VerifierRunner {
  const now = options.now ?? Date.now;
  const children = new Set<Child>();
  const commandLine = options.commandLineOfForTest ?? commandLineOf;
  const deliveryBinSha256 = sha256File(options.deliveryBin);

  function envOf(dir: string, kind: LaunchKind): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      DELIVERY_SRS_DAT: options.srsPath,
      RUST_LOG: "info",
      PIDFILE: path.join(dir, PID_FILE[kind]),
      GATE: path.join(dir, GATE_FILE[kind]),
    };
    for (const [stage, spec] of Object.entries(options.launchHooksForTest?.stages ?? {})) {
      if (spec === undefined) continue;
      env[`ARRIVE_${stage.toUpperCase()}`] = spec.arrive;
      env[`RELEASE_${stage.toUpperCase()}`] = spec.release;
    }
    return env;
  }

  function launch(dir: string, kind: LaunchKind, args: readonly string[]): Child | undefined {
    // 1. 起動門（保留中の印）。既にあれば同じ購入で 2 度起動しようとしている = 拒否。
    const gate = path.join(dir, GATE_FILE[kind]);
    if (existsSync(gate)) return undefined;
    writeFileSync(gate, JSON.stringify({ at: now() }), { mode: 0o600 });
    const stdout = boundedSink(path.join(dir, `${kind}.stdout.log`), options.maxChildOutputBytes);
    const stderr = boundedSink(path.join(dir, `${kind}.stderr.log`), options.maxChildOutputBytes);
    let proc: ChildProcess;
    try {
      proc = spawn("/bin/sh", ["-c", wrapperOf(options.launchHooksForTest), options.deliveryBin, ...args], { stdio: ["ignore", "pipe", "pipe"], env: envOf(dir, kind), cwd: dir });
    } catch {
      stdout.close();
      stderr.close();
      return undefined;
    }
    if (proc.pid === undefined) {
      stdout.close();
      stderr.close();
      return undefined;
    }
    proc.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
    proc.stdout?.once("close", () => stdout.close());
    proc.stderr?.once("close", () => stderr.close());
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }));
      proc.once("error", () => resolve({ code: null, signal: null }));
    });
    let done = false;
    /** 準備の握手（pid の確認）が済んだか。済む前に子が終わっても、pid ファイルは握手が読むまで残す（終了と準備の観測の競合を避ける）。 */
    let handshakeDone = false;
    const deleteOwnership = (): void => {
      for (const file of [path.join(dir, PID_FILE[kind]), path.join(dir, `${PID_FILE[kind]}.tmp`), gate]) {
        try {
          unlinkSync(file);
        } catch {
          // 無ければよい。
        }
      }
    };
    void exited.then(() => {
      done = true;
      children.delete(child);
      stdout.close();
      stderr.close();
      // 終了の後に pid ファイルと起動門を片付ける（棚卸しの対象から外す）。握手の前なら握手の側が片付ける。
      if (handshakeDone) deleteOwnership();
    });
    const child: Child & { markHandshake(): void } = {
      pid: proc.pid,
      kind,
      exited,
      markHandshake(): void {
        handshakeDone = true;
        if (done) deleteOwnership();
      },
      async kill(graceMs = DEFAULT_GRACE_MS): Promise<void> {
        if (done) {
          deleteOwnership();
          return;
        }
        try {
          proc.kill("SIGTERM");
        } catch {
          // 既に終わっている。
        }
        const killed = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
        if (!killed) {
          try {
            proc.kill("SIGKILL");
          } catch {
            // 既に終わっている。
          }
          await exited;
        }
        deleteOwnership();
      },
    };
    children.add(child);
    return child;
  }

  /** pid ファイルの内容が spawn の pid と一致するまで待つ（期限の内側）。子が先に終わっていても、公開済みの pid は読める（握手まで残す）。 */
  async function waitPid(dir: string, kind: LaunchKind, child: Child & { markHandshake(): void }, byMs: number): Promise<boolean> {
    const file = path.join(dir, PID_FILE[kind]);
    let exitedFlag = false;
    void child.exited.then(() => {
      exitedFlag = true;
    });
    for (;;) {
      try {
        if (readFileSync(file, "utf8").trim() === String(child.pid)) {
          child.markHandshake();
          return true;
        }
      } catch {
        // まだ。
      }
      if (exitedFlag) {
        // 終了の後に 1 度だけ読み直す（公開と終了の間で読み漏らさない）。
        try {
          if (readFileSync(file, "utf8").trim() === String(child.pid)) {
            child.markHandshake();
            return true;
          }
        } catch {
          // 公開されなかった。
        }
        child.markHandshake();
        return false;
      }
      if (!(now() < byMs)) {
        child.markHandshake();
        return false;
      }
      await sleep(POLL_MS);
    }
  }

  return {
    deliveryBinSha256,

    async serve(args: ServeArgs): Promise<ServeOutcome> {
      const addrFile = path.join(args.dir, ADDR_FILE);
      // 今回新しく公開されるアドレスだけを待つ（古い addr-file があれば起動しない）。
      if (existsSync(addrFile) || existsSync(path.join(args.dir, "record.json"))) return { ok: false, reason: "launch_failed" };
      if (!(now() < args.readyByMs) || !(args.timeoutSecs >= 1)) return { ok: false, reason: "expired" };
      const child = launch(args.dir, "serve", [
        "verifier-serve",
        "--verifier-dir", args.dir,
        "--order", args.orderPath,
        "--listen", "127.0.0.1:0",
        "--addr-file", addrFile,
        "--expect-host", args.host,
        "--expect-port", "443",
        "--expect-path", args.path,
        "--trust", options.trust,
        "--timeout-secs", String(Math.floor(args.timeoutSecs)),
        "--intent", args.intentPath,
        "--release", args.releasePath,
      ]);
      if (child === undefined) return { ok: false, reason: "launch_failed" };
      if (!(await waitPid(args.dir, "serve", child as Child & { markHandshake(): void }, args.readyByMs))) {
        await child.kill();
        return { ok: false, reason: "not_ready" };
      }
      while (now() < args.readyByMs) {
        const read = readBounded(addrFile, MAX_ADDR_BYTES);
        if (read.ok) {
          const address = read.bytes.toString("utf8").trim();
          if (/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(address)) return { ok: true, child, address };
          await child.kill();
          return { ok: false, reason: "not_ready" };
        }
        if (read.reason === "too_large") {
          await child.kill();
          return { ok: false, reason: "not_ready" };
        }
        const exitedEarly = await Promise.race([child.exited.then(() => true), sleep(POLL_MS).then(() => false)]);
        if (exitedEarly) return { ok: false, reason: "launch_failed" };
      }
      await child.kill();
      return { ok: false, reason: "not_ready" };
    },

    async verify(args: VerifyArgs): Promise<VerifyOutcome> {
      const resultFile = path.join(args.dir, "verify_result.json");
      try {
        unlinkSync(resultFile);
      } catch {
        // 無ければよい（バイナリは create-new）。
      }
      const startedAt = now();
      const child = launch(args.dir, "verify", [
        "verifier-verify",
        "--verifier-dir", args.dir,
        "--order", args.orderPath,
        "--bundle", args.bundlePath,
        "--expect-host", args.host,
        "--expect-port", "443",
        "--expect-path", args.path,
        "--intent", args.intentPath,
        "--release", args.releasePath,
        ...(args.requireExternalGate ? ["--require-external-gate"] : []),
      ]);
      if (child === undefined) return { ok: false, reason: "launch_failed" };
      if (!(await waitPid(args.dir, "verify", child as Child & { markHandshake(): void }, startedAt + Math.min(args.timeoutMs, 5_000)))) {
        await child.kill();
        return { ok: false, reason: "launch_failed" };
      }
      const finished = await Promise.race([child.exited.then((exit) => exit), sleep(Math.max(0, startedAt + args.timeoutMs - now())).then(() => undefined)]);
      if (finished === undefined) {
        await child.kill();
        return { ok: false, reason: "timeout" };
      }
      const read = readBounded(resultFile, MAX_VERIFY_RESULT_BYTES);
      if (!read.ok) return { ok: false, reason: read.reason === "too_large" ? "result_too_large" : "result_unreadable", exitCode: finished.code };
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.bytes.toString("utf8"));
      } catch {
        return { ok: false, reason: "result_unreadable", exitCode: finished.code };
      }
      // 成功は「結果が ok かつ終了コード 0」のときだけ（`ok:true` を書いて非 0 で終わるものは信じない）。
      if (isRecord(parsed) && parsed["ok"] === true && (finished.code !== 0 || finished.signal !== null)) {
        return { ok: false, reason: "exit_nonzero", exitCode: finished.code };
      }
      return { ok: true, result: parsed, exitCode: finished.code };
    },

    async inventory(workDir: string): Promise<InventoryOutcome> {
      let dirs: string[];
      try {
        mkdirSync(workDir, { recursive: true, mode: 0o700 });
        dirs = readdirSync(workDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(workDir, entry.name));
      } catch {
        return { ok: false, reason: "enumeration_failed" };
      }
      // 1. 起動門を全部外す（保留中の wrapper は exec しない）。
      for (const dir of dirs) {
        for (const kind of ["serve", "verify"] as const) {
          const gate = path.join(dir, GATE_FILE[kind]);
          if (!existsSync(gate)) continue;
          try {
            renameSync(gate, `${gate}.cancelled`);
          } catch {
            return { ok: false, reason: "cancel_failed" };
          }
        }
      }
      // 2. pid の棚卸し: 生きていれば OS 由来の同一性を確かめて終了させ、終了を待つ。
      let terminated = 0;
      for (const dir of dirs) {
        for (const kind of ["serve", "verify"] as const) {
          const file = path.join(dir, PID_FILE[kind]);
          if (existsSync(`${file}.tmp`)) return { ok: false, reason: "unverifiable_pid" };
          if (!existsSync(file)) continue;
          const text = readFileSync(file, "utf8").trim();
          if (!/^[1-9][0-9]{0,9}$/.test(text)) return { ok: false, reason: "unverifiable_pid" };
          const pid = Number(text);
          if (pid === process.pid) return { ok: false, reason: "unverifiable_pid" };
          if (!isAlive(pid)) {
            unlinkSync(file);
            continue;
          }
          const line = await commandLine(pid);
          if (line === undefined) return { ok: false, reason: "unverifiable_pid" };
          if (!line.includes(options.deliveryBin) || !line.includes(dir)) {
            // pid の再利用（別のプロセス）。自分の子ではないので触らないが、ファイルは古い。
            unlinkSync(file);
            continue;
          }
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // 競合で既に終わった。
          }
          const deadline = now() + 5_000;
          while (isAlive(pid) && now() < deadline) await sleep(POLL_MS);
          if (isAlive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // 競合で既に終わった。
            }
            const hard = now() + 5_000;
            while (isAlive(pid) && now() < hard) await sleep(POLL_MS);
            if (isAlive(pid)) return { ok: false, reason: "termination_unconfirmed" };
          }
          terminated += 1;
          try {
            unlinkSync(file);
          } catch {
            // 無ければよい。
          }
        }
      }
      return { ok: true, terminated };
    },

    async closeAll(): Promise<void> {
      await Promise.all([...children].map((child) => child.kill()));
    },
  };
}
