/**
 * Router の MCP ラッパ（stdio）。**Router を内蔵起動せず**、稼働中の Router の
 * R1–R4 公開契約にだけ接続する。
 *
 * なぜ内蔵起動しないか: 購入の直列化はプロセス内の Map（`src/core/orchestrator.ts`）なので
 * Router が複数プロセスに増えると直列化が効かない。journal 側は `flock` で fail closed するため
 * 二重購入にはならないが、MCP 起動のたびに Router を立てる設計は起動失敗を招く。
 *
 * **stdout は JSON-RPC 専用。** ログ・診断は必ず stderr に出す。ここから stdout へは
 * SDK の transport 以外何も書かない。
 *
 * 資格情報は env でのみ受け取り、tool の引数にも応答にも出さない。
 *
 * usage: ROUTER_MCP_BASE_URL=... ROUTER_MCP_PRINCIPAL_ID=... ROUTER_MCP_TOKEN=... \
 *        [ROUTER_MCP_ADAPTER_MODE=synthetic|real] \
 *        [ROUTER_MCP_EVIDENCE_FILE=... | ROUTER_MCP_EVIDENCE_LABEL=...] tsx src/mcp/server.ts
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRouterClient } from "../client/index.js";
import {
  createToolHandlers,
  TOOL_NAMES,
  type AdapterMode,
  type Evidence,
  type InboundPayer,
} from "./tools.js";

/** 診断は stderr のみ（stdout を汚すとプロトコルが壊れる）。 */
function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is required. The MCP server connects to an already running Router; ` +
        `it never starts one itself.`,
    );
  }
  return value;
}

/**
 * 実行証拠の出所を決める。**裸のラベルを信じない。**
 * Router 自身の起動行（`{"event":"listening",...,"label":...}`）を読めたときだけ
 * `verified: true` にし、env の自己申告に落ちた場合は `verified: false` を明示する。
 */
function resolveEvidence(): Evidence {
  const file = process.env["ROUTER_MCP_EVIDENCE_FILE"];
  if (file !== undefined && file !== "") {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as Record<string, unknown>)["event"] === "listening"
        ) {
          const label = (parsed as Record<string, unknown>)["label"];
          if (typeof label === "string" && label !== "") {
            return { label, source: "router_listening_line", verified: true };
          }
        }
      } catch {
        // JSON-RPC ではない行は無視する（起動出力に他の行が混ざり得る）。
      }
    }
    throw new Error(
      `ROUTER_MCP_EVIDENCE_FILE did not contain a Router listening line with a label: ${file}`,
    );
  }
  const asserted = process.env["ROUTER_MCP_EVIDENCE_LABEL"];
  if (asserted === undefined || asserted === "") {
    throw new Error(
      "Set ROUTER_MCP_EVIDENCE_FILE (preferred: read the Router's own listening line) " +
        "or ROUTER_MCP_EVIDENCE_LABEL. The server refuses to start without stating " +
        "which rails it is talking to.",
    );
  }
  // 運用者の自己申告。Router が名乗ったものではないことを構造で示す。
  return { label: asserted, source: "operator_asserted", verified: false };
}

/** tool の戻りを MCP の CallToolResult に詰める（構造化データはそのまま返す）。 */
function asResult(body: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

/**
 * 受信レグの支払い能力は**起動側から渡す**（`src/**` は鍵を持たない／env からも読まない）。
 * 省略すると `real` モードの purchase は fail closed になる。
 */
export interface McpServerOptions {
  readonly payer?: InboundPayer;
  readonly inboundChainId?: number;
  /**
   * **ステートレス（リモート HTTP）運用の opt-in**。
   * 呼び出し側が quote を持ち回る前提にする。stdio（ローカル）では渡さない。
   */
  readonly stateless?: boolean;
}

/**
 * tool を登録した MCP サーバを組み立てて返す（トランスポートは呼び出し側が選ぶ）。
 * stdio（ローカル）と Streamable HTTP（リモート）で**同じ tool 配線**を使うための分離。
 */
export async function buildServer(options: McpServerOptions = {}): Promise<McpServer> {
  const baseUrl = requiredEnv("ROUTER_MCP_BASE_URL");
  const principalId = requiredEnv("ROUTER_MCP_PRINCIPAL_ID");
  const token = requiredEnv("ROUTER_MCP_TOKEN");
  const mode: AdapterMode =
    process.env["ROUTER_MCP_ADAPTER_MODE"] === "real" ? "real" : "synthetic";
  const evidence = resolveEvidence();

  const client = createRouterClient({
    baseUrl,
    principalId,
    token,
    ...(options.stateless === true ? { allowUnissuedQuotes: true } : {}),
  });
  const handlers = createToolHandlers({
    client,
    mode,
    evidence,
    ...(options.payer === undefined ? {} : { payer: options.payer }),
    ...(options.inboundChainId === undefined ? {} : { inboundChainId: options.inboundChainId }),
  });

  const server = new McpServer({ name: "subetha-router", version: "0.1.0" });

  server.registerTool(
    TOOL_NAMES.listRoutes,
    {
      description:
        "Router が公開している経路（routeId・canonical URL・両レグの資産メタ）を一覧する。" +
        "上流 Provider の URL は返らない。",
      inputSchema: {},
    },
    async () => asResult(await handlers.listRoutes()),
  );

  server.registerTool(
    TOOL_NAMES.quote,
    {
      description:
        "経路の見積りを取る。返る subject が人間の承認対象そのもの（額は base units、" +
        "decimals つき）。**この tool は支払いを開始しない。** 承認は人間が行い、" +
        `承認する場合だけ ${TOOL_NAMES.purchase} を呼ぶこと。エージェントが自分で承認してはならない。` +
        " **資金がいつ動くかはレールで違う。** 応答の `subject.fundsMoveOnCredential` が true の" +
        " 経路（MPP）では、credential を作った時点で送金が完了し、取り消せない。" +
        " その場合は**credential を作る前に**承認を得ること（purchase の前では遅い）。",
      inputSchema: {
        routeId: z.string().min(1),
        requestId: z
          .string()
          .min(1)
          .describe("再試行しても同じ値を使うこと（変えると別の購入になり得る）"),
      },
    },
    async (args) => asResult(await handlers.quote(args)),
  );

  server.registerTool(
    TOOL_NAMES.purchase,
    {
      description:
        "人間が明示承認した quote を 1 回だけ実行する。approval には承認した quoteId を渡す。" +
        "未指定・不一致なら Router が拒否する（この層では承認を判定しない）。" +
        "**MPP 経路ではこの呼び出しの前に既に送金が済んでいる。** 失敗しても資金は戻らないので、" +
        "勝手に再試行せず、送金済みである旨を報告して止まること。" +
        "requestId は quote と同じ値を使うこと。サーバ再起動後は quote を取り直す必要がある。",
      inputSchema: {
        quoteId: z.string().min(1),
        requestId: z.string().min(1),
        approval: z
          .string()
          .optional()
          .describe("人間が承認した quoteId。未指定なら Router が approval_required を返す"),
        quote: z
          .unknown()
          .optional()
          .describe("quote が返した quote 文書。リモート（ステートレス）利用では必須"),
        credential: z
          .string()
          .optional()
          .describe(
            "自分の鍵で署名した X-Payment 値（base64）。リモート利用ではこれを渡す。" +
              "Router は呼び出し側の鍵を保持しない。",
          ),
      },
    },
    async (args) => asResult(await handlers.purchase(args)),
  );

  server.registerTool(
    TOOL_NAMES.status,
    {
      description:
        "paymentId の公開射影を取得する（保存 → 再オープン相当）。" +
        "サーバを再起動しても参照できる。",
      inputSchema: { paymentId: z.string().min(1) },
    },
    async (args) => asResult(await handlers.status(args)),
  );

  note(
    `subetha-router MCP server ready (mode=${mode}, evidence=${evidence.label}, ` +
      `verified=${String(evidence.verified)}, router=${baseUrl}, ` +
      `inboundPayer=${options.payer === undefined ? "none" : options.payer.address})`,
  );
  return server;
}

/** stdio で待ち受ける（ローカル利用）。 */
export async function main(options: McpServerOptions = {}): Promise<void> {
  const server = await buildServer(options);
  await server.connect(new StdioServerTransport());
}

/**
 * **このファイルが直接の起動エントリのときだけ**自動起動する。
 * import されたとき（`tools/` が payer を注入して `main()` を呼ぶ場合）に走ってしまうと、
 * **能力の無いサーバが先に stdio を掴んで実決済できなくなる**。
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main({}).catch((error: unknown) => {
    note(`subetha-router MCP server failed: ${error instanceof Error ? error.message : "unknown"}`);
    process.exit(1);
  });
}
