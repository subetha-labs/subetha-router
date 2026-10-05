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
 * tool の処理が例外を投げたときの固定の結果。**例外の文字列は返さない**
 * （SDK に任せると `error.message` がそのまま tool の結果に載る。上流 URL・トークン・内部ホスト名が混ざり得る）。
 */
export async function guarded(run: () => Promise<Record<string, unknown>>): Promise<ReturnType<typeof asResult> & { isError?: true }> {
  try {
    return asResult(await run());
  } catch {
    note("subetha-router MCP tool failed");
    return { ...asResult({ ok: false, error: "internal_error" }), isError: true };
  }
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
  /**
   * 送信元の識別（動的 quote の門の鍵）。リモートの入口が**要求ごとに自分で導いた値**を渡す
   * （外から来た `x-router-source` ヘッダは使わない）。省略時は付けない（Router 側は principal で数える）。
   */
  readonly source?: string;
}

/**
 * 入口が受けた要求から送信元を導く（設計 §7.2）: Caddy が付ける `X-Forwarded-For` の**最後の値**。
 * 無ければ接続元のアドレス。どちらも無ければ固定値（1 つの送信元として数える）。
 */
export function sourceOfRequest(headers: Readonly<Record<string, string | string[] | undefined>>, remoteAddress: string | undefined): string {
  const forwarded = headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  const last = raw?.split(",").at(-1)?.trim();
  if (last !== undefined && last !== "" && last.length <= 64) {
    return `fwd:${last}`;
  }
  if (remoteAddress !== undefined && remoteAddress !== "") {
    return `addr:${remoteAddress}`;
  }
  return "unknown";
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
    ...(options.source === undefined ? {} : { source: options.source }),
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
        "List the routes this Router exposes (routeId, canonical URL, and the asset " +
        "metadata for both legs). Upstream provider URLs are never returned.",
      inputSchema: {},
    },
    async () => guarded(() => handlers.listRoutes()),
  );

  server.registerTool(
    TOOL_NAMES.quote,
    {
      description:
        "Quote a route. The returned `subject` is exactly what a human approves " +
        "(amounts are base units and carry `decimals`). **This tool starts no payment.** " +
        `A human approves; call ${TOOL_NAMES.purchase} only if they do. ` +
        "An agent must never approve on the human's behalf. " +
        "**When funds move depends on the route.** If `subject.fundsMoveOnCredential` is true, " +
        "building the credential may already spend the funds and that cannot be undone — get " +
        "approval BEFORE building the credential, not before purchase. The flag is conservative: " +
        "it is also true when the timing is not declared, so treat it as \"may spend\", not as " +
        "proof that a payment completed.",
      inputSchema: {
        routeId: z.string().min(1),
        requestId: z
          .string()
          .min(1)
          .describe("Keep the same value across retries; changing it can become a different purchase"),
      },
    },
    async (args) => guarded(() => handlers.quote(args)),
  );

  server.registerTool(
    TOOL_NAMES.quoteUrl,
    {
      description:
        "Quote a purchase from an upstream URL the caller chooses (a third-party provider the operator has NOT " +
        "verified). `profileId` selects which rail you pay with and which rail the upstream is paid on. " +
        "**This tool starts no payment.** The returned `subject` shows the upstream URL, the recipient, and the " +
        "price breakdown (upstream amount + Router fee = total). The quote document carries an `ownerKey`: pass " +
        `the whole document to ${TOOL_NAMES.purchase} and to ${TOOL_NAMES.status}; without it the purchase cannot be ` +
        "read or executed. Nothing is refunded if the upstream takes the payment and returns no usable data " +
        "(only an application/json object up to 256 KiB is delivered). If `subject.fundsMoveOnCredential` is true, " +
        "building the credential already spends the funds and the Router may still refuse afterwards — get approval " +
        "BEFORE building the credential. Use a fresh `requestId` per quote.",
      inputSchema: {
        profileId: z.string().min(1).describe("Dynamic profile id (shares the routeId namespace)"),
        url: z.string().min(1).describe("The upstream https URL exactly as it should be fetched (query allowed)"),
        requestId: z.string().min(1),
      },
    },
    async (args) => guarded(() => handlers.quoteUrl(args)),
  );

  server.registerTool(
    TOOL_NAMES.purchase,
    {
      description:
        "Execute a human-approved quote exactly once. Pass the approved quoteId as " +
        "`approval`; the Router rejects a missing or mismatched value (this layer does not " +
        "judge approval itself). **If the quote said `fundsMoveOnCredential`, the money may " +
        "already have left before this call** — a failure here does not return it, so do not " +
        "retry on your own: report that payment may already have been sent and stop. " +
        "Use the same `requestId` as the quote. " +
        "After a server restart the quote must be taken again.",
      inputSchema: {
        quoteId: z.string().min(1),
        requestId: z.string().min(1),
        approval: z
          .string()
          .optional()
          .describe("The quoteId the human approved. Without it the Router returns approval_required"),
        quote: z
          .unknown()
          .optional()
          .describe("The quote document returned by quote. Required for remote (stateless) use"),
        credential: z
          .string()
          .optional()
          .describe(
            "The X-Payment value (base64) signed with your own key. Pass this for remote use; " +
              "the Router never holds the caller's key.",
          ),
      },
    },
    async (args) => guarded(() => handlers.purchase(args)),
  );

  server.registerTool(
    TOOL_NAMES.status,
    {
      description:
        "Fetch the public projection for a paymentId (equivalent to saving and reopening). " +
        "Readable after a server restart, and reading it costs nothing.",
      inputSchema: {
        paymentId: z.string().min(1),
        ownerKey: z.string().optional().describe("For purchases quoted with subetha_router_quote_url: the quote document's ownerKey"),
      },
    },
    async (args) => guarded(() => handlers.status(args)),
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
    // 起動時の設定の誤り（env の不足など）だけを伝える。ローカルの stdio 用で、匿名の相手には届かない。
    note(`subetha-router MCP server failed: ${error instanceof Error ? error.message : "unknown"}`);
    process.exit(1);
  });
}
