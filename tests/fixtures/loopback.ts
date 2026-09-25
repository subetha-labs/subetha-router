/**
 * 別プロセスの合成 fixture / Router CLI を起動する最小ヘルパ。
 * **テスト基盤であり製品コードではない**（新規 Provider でもない）。
 *
 * - 子プロセスは自分が spawn したものだけを kill し、`close` を待ってから戻る。
 * - 子の env は明示した allowlist だけを渡す（既存の鍵・秘密を読まない）。
 * - すべて 127.0.0.1 の使い捨てポート（`--port 0`）で、無課金・無署名。
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tsxCli = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");

/** 子に渡してよい親 env のキー（これ以外は読まない・渡さない）。 */
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

function childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 子プロセスを最後まで走らせて終了コードと出力を返す（起動失敗の確認に使う）。 */
export async function runToExit(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<RunResult> {
  const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

/** 起動して `{"event":"listening","port":n}` を 1 行出すまで待つ子プロセス。 */
export interface Listening {
  readonly port: number;
  readonly baseUrl: string;
  stdout(): string;
  stderr(): string;
  /** 自分が起動した子だけを終了させ、close を待つ。 */
  stop(): Promise<void>;
}

export async function startListening(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Listening> {
  const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  let closed = false;
  const closing = once(child, "close").then(() => {
    closed = true;
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for listen: ${script}\n${stdout}\n${stderr}`));
    }, 20_000);
    const check = (): void => {
      for (const line of stdout.split("\n")) {
        if (line === "") {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { event?: string; port?: number };
          if (parsed.event === "listening" && typeof parsed.port === "number") {
            clearTimeout(timer);
            child.stdout.off("data", check);
            resolve(parsed.port);
            return;
          }
        } catch {
          // 完全な 1 行が届くまでは無視する。
        }
      }
    };
    child.stdout.on("data", check);
    void closing.then(() => {
      clearTimeout(timer);
      reject(new Error(`exited before listening: ${script}\n${stdout}\n${stderr}`));
    });
    check();
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop(): Promise<void> {
      if (!closed) {
        child.kill("SIGTERM");
        // 終了しない子は残さない（所有している子のみ）。
        const guard = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await closing;
        clearTimeout(guard);
      }
    },
  };
}
