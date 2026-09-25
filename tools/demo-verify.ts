/**
 * 審査員の手順をそのまま再現して検証する。**製品コードではない。**
 * `claude mcp add ... -- npm run --silent demo:mcp` と同じ起動を MCP クライアントから行う。
 *
 * usage: SUBETHA_PAYER_PRIVATE_KEY=0x... tsx tools/demo-verify.ts [--pay]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function env(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...extra };
}

async function main(): Promise<void> {
  const pay = process.argv.includes("--pay");
  const key = process.env["SUBETHA_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    process.stderr.write("SUBETHA_PAYER_PRIVATE_KEY is not set\n");
    process.exit(2);
  }

  // 審査員が打つコマンドと同じもの。
  const transport = new StdioClientTransport({
    command: "npm",
    args: ["run", "--silent", "demo:mcp"],
    env: env({ SUBETHA_PAYER_PRIVATE_KEY: key }),
    stderr: "pipe",
  });
  const client = new Client({ name: "judge", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  process.stdout.write(`tools: ${tools.tools.map((t) => t.name).join(", ")}\n`);

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      structuredContent?: Record<string, unknown>;
    };
    return r.structuredContent ?? {};
  };

  const routes = await call("subetha_router_list_routes", {});
  process.stdout.write(`routes ok=${String(routes["ok"])} evidence=${JSON.stringify(routes["evidence"])}\n`);

  // requestId は quote と purchase で**同じ値**を使う（変えると別の購入になる）。
  const requestId = `judge-${Date.now()}`;
  const quoted = await call("subetha_router_quote", {
    routeId: "md-mpp-eth-snapshot",
    requestId,
  });
  const subject = quoted["subject"] as Record<string, unknown> | undefined;
  if (subject === undefined) {
    process.stdout.write(`quote failed: ${JSON.stringify(quoted).slice(0, 300)}\n`);
    await client.close();
    process.exit(1);
  }
  const source = subject["source"] as Record<string, unknown>;
  process.stdout.write(
    `quote: ${String(source["amount"])} base units (decimals ${String(source["decimals"])}) ` +
      `on ${String(source["network"])}\n`,
  );

  if (!pay) {
    process.stdout.write("(no --pay: stopping before payment)\n");
    await client.close();
    return;
  }

  const bought = await call("subetha_router_purchase", {
    quoteId: subject["quoteId"],
    requestId,
    approval: subject["quoteId"],
  });
  process.stdout.write(`purchase outcome=${String(bought["outcome"])}\n`);
  const status = await call("subetha_router_status", {
    paymentId: String(bought["paymentId"] ?? subject["paymentId"]),
  });
  const projection = status["projection"] as Record<string, unknown> | undefined;
  if (projection !== undefined) {
    const src = projection["source"] as Record<string, unknown>;
    const dst = projection["destination"] as Record<string, unknown>;
    process.stdout.write(`inbound  tx=${String(src["txRef"])}\n`);
    process.stdout.write(`outbound tx=${String(dst["txRef"])}\n`);
  }
  await client.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`demo-verify failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
