/**
 * 別プロセスの合成 fixture / Router CLI を起動する最小ヘルパ。
 * **テスト基盤であり製品コードではない**（新規 Provider でもない）。
 *
 * - 子プロセスは自分が spawn したものだけを kill し、`close` を待ってから戻る。
 * - 子の env は明示した allowlist だけを渡す（既存の鍵・秘密を読まない）。
 * - すべて 127.0.0.1 の使い捨てポート（`--port 0`）で、無課金・無署名。
 *
 * **1 プロセスだけを所有する**: tsx の CLI ラッパを起動すると、実際のアプリはその**子**に
 * なり、ラッパを kill しても実プロセスが孤児として残る（journal ロックと stdout を掴んだまま
 * `close` が返らない）。そのためインストール済み tsx を Node の `--import` ローダとして
 * 直接読み込み、アプリ自身を唯一の子プロセスとして起動する。
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/** `node --import tsx <script>`。ラッパを挟まないので子は 1 つだけになる。 */
function spawnApp(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(
    process.execPath,
    ["--import", "tsx", path.join(repoRoot, script), ...args],
    {
      // tsx はこの repoRoot の node_modules から解決する（追加ダウンロードはしない）。
      cwd: repoRoot,
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * 子の終了を待つ（`close`）。spawn そのものの失敗（ENOENT・EAGAIN など）は 'error' だけが来て `close` が来ないことがあるので、
 * pid の無い子の 'error' でも終わったものとして解く（`events.once` は 'error' で reject し、待つ側が未処理の reject になる）。
 * 'error' は記録だけして投げない（起動待ちは「listening の前に終わった」として reject する）。
 */
function closedOf(child: ChildProcessByStdio<null, Readable, Readable>): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => {
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve([code, signal]));
    child.on("error", () => {
      if (child.pid === undefined) resolve([null, null]);
    });
  });
}

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
  const child = spawnApp(script, args, env);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const [code, signal] = await closedOf(child);
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
  /**
   * 自分が起動した子**だけ**を指定シグナルで落とし、close を待つ。
   * 応答前クラッシュの再現に使う（graceful shutdown ではない）。
   */
  kill(signal: NodeJS.Signals): Promise<void>;
  /** 子が終わったら解ける（理由を問わない。入口が「どちらかの子が落ちたら両方を止める」ために見る）。 */
  readonly exited: Promise<void>;
}

export async function startListening(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  /** `listening` の行を待つ上限（既定 20 秒。本番の入口は起動時の外部検査を含むので長く渡す）。 */
  options: {
    readonly listenTimeoutMs?: number;
    /**
     * 起動待ちの取り消し（入口が signal・もう片方の子の終了で止まるとき）。listening の前に abort されたら、子を SIGTERM で止め（5 秒で SIGKILL）、
     * 終了を待ってから reject する。listening の後の abort は何もしない（呼び出し側が `stop` する）。
     */
    readonly signal?: AbortSignal;
  } = {},
): Promise<Listening> {
  const listenTimeoutMs = options.listenTimeoutMs ?? 20_000;
  const child = spawnApp(script, args, env);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  let closed = false;
  const closing = closedOf(child).then(() => {
    closed = true;
  });
  let settleListening!: () => void;
  const listeningDone = new Promise<void>((resolve) => (settleListening = resolve));

  let aborted = false;
  const listening = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for listen: ${script}\n${stdout}\n${stderr}`));
    }, listenTimeoutMs);
    const onAbort = (): void => {
      aborted = true;
      clearTimeout(timer);
      reject(new Error(`aborted before listening: ${script}`));
    };
    if (options.signal?.aborted === true) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void listeningDone.then(() => options.signal?.removeEventListener("abort", onAbort));
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

  let port: number;
  try {
    port = await listening;
  } catch (error) {
    // 起動できなかった子を残さない（タイムアウト時も含め、所有している子だけを落とす）。取り消しは SIGTERM（5 秒で SIGKILL）、それ以外は SIGKILL。
    if (!closed) {
      if (aborted) {
        child.kill("SIGTERM");
        const guard = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await closing;
        clearTimeout(guard);
      } else {
        child.kill("SIGKILL");
        await closing;
      }
    }
    throw error;
  } finally {
    settleListening();
  }

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: closing,
    async stop(): Promise<void> {
      if (!closed) {
        child.kill("SIGTERM");
        // 終了しない子は残さない（所有している子のみ）。
        const guard = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await closing;
        clearTimeout(guard);
      }
    },
    async kill(signal: NodeJS.Signals): Promise<void> {
      if (!closed) {
        child.kill(signal);
        await closing;
      }
    },
  };
}
