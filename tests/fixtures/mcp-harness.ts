/**
 * T6 の足場。**テスト基盤であり製品コードではない。**
 *
 * 既存 `router-harness.ts`（合成 facilitator・上流・実 Router）を**読むだけで再利用**し、
 * そこへ MCP サーバプロセスと SDK クライアントを足す。
 *
 * 既存 `loopback.ts` の `spawnApp` は **stdin が `ignore`** なので stdio の MCP には使えない。
 * SDK の `StdioClientTransport` に自分で spawn させる（既存 fixture は変更しない）。
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ALICE, startHarness, type Harness } from "./router-harness.js";

export { ALICE, ROUTE_A, ROUTE_B } from "./router-harness.js";

/** 子プロセスへ渡す env は最小限に絞る（親の秘密を渡さない）。 */
function childEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra, CI: "1" };
}

export interface McpHarnessOptions {
  readonly mode?: "synthetic" | "real";
  /** 証拠ラベルの出所を Router 自身の起動行にする（既定は env 自己申告）。 */
  readonly evidenceFile?: string;
  readonly evidenceLabel?: string;
  readonly principal?: { id: string; token: string };
}

export interface McpHarness {
  readonly router: Harness;
  readonly client: Client;
  stop(): Promise<void>;
}

export async function startMcpHarness(options: McpHarnessOptions = {}): Promise<McpHarness> {
  const router = await startHarness();
  const principal = options.principal ?? ALICE;
  const env: Record<string, string> = {
    ROUTER_MCP_BASE_URL: router.router.baseUrl,
    ROUTER_MCP_PRINCIPAL_ID: principal.id,
    ROUTER_MCP_TOKEN: principal.token,
    ROUTER_MCP_ADAPTER_MODE: options.mode ?? "synthetic",
  };
  if (options.evidenceFile !== undefined) env["ROUTER_MCP_EVIDENCE_FILE"] = options.evidenceFile;
  else env["ROUTER_MCP_EVIDENCE_LABEL"] = options.evidenceLabel ?? "T1-synthetic-nopay";

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "tsx", "src/mcp/server.ts"],
    env: childEnv(env),
    stderr: "pipe",
  });
  const client = new Client({ name: "t6-test", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await router.stopAll();
    throw error;
  }
  return {
    router,
    client,
    async stop(): Promise<void> {
      await client.close();
      await router.stopAll();
    },
  };
}

/** tool を呼んで構造化された本体だけを返す。 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    structuredContent?: Record<string, unknown>;
    content?: { type: string; text?: string }[];
  };
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

export interface RawRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/**
 * MCP サーバを **raw で spawn** して stdout を全バイト収集する。
 * SDK クライアント経由だと SDK がパースしてしまい「JSON-RPC 以外の行」を検知できないため、
 * stdout 非汚染の検証にはこちらを使う。
 */
export async function runServerRaw(
  env: Readonly<Record<string, string>>,
  input: string,
  waitMs = 3_000,
): Promise<RawRun> {
  const child = spawn("npx", ["--no-install", "tsx", "src/mcp/server.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(env),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.stdin.write(input);
  const exited = once(child, "close") as Promise<[number | null]>;
  const timer = setTimeout(() => child.kill("SIGTERM"), waitMs);
  const [code] = await exited;
  clearTimeout(timer);
  return { stdout, stderr, code };
}
