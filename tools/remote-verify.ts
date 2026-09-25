/**
 * リモート MCP を**審査員の立場**で叩いて検証する。**製品コードではない。**
 * 鍵はこちら（呼び出し側）にあり、**署名も手元で作って** `credential` として渡す。
 *
 * usage: SUBETHA_PAYER_PRIVATE_KEY=0x... tsx tools/remote-verify.ts <url> [--pay]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createX402Payer } from "./x402-payer.js";

async function main(): Promise<void> {
  const url = process.argv[2] ?? "http://127.0.0.1:8791/mcp";
  const pay = process.argv.includes("--pay");
  const key = process.env["SUBETHA_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    process.stderr.write("SUBETHA_PAYER_PRIVATE_KEY is not set\n");
    process.exit(2);
  }
  const payer = createX402Payer(key);
  process.stdout.write(`payer (mine, never sent to the server): ${payer.address}\n`);

  const client = new Client({ name: "judge-remote", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  const tools = await client.listTools();
  process.stdout.write(`tools: ${tools.tools.map((t) => t.name).join(", ")}\n`);

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      structuredContent?: Record<string, unknown>;
    };
    return r.structuredContent ?? {};
  };

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
    `quote: ${String(source["amount"])} base units (decimals ${String(source["decimals"])})\n`,
  );
  process.stdout.write(`evidence: ${JSON.stringify(quoted["evidence"])}\n`);

  if (!pay) {
    process.stdout.write("(no --pay: stopping before payment)\n");
    await client.close();
    return;
  }

  // **署名は手元で作る。** 鍵はサーバへ送らない。
  const offer = (subject["source"] as Record<string, unknown>)["offer"];
  if (offer === undefined) {
    process.stdout.write("quote did not expose the issued offer; cannot sign locally\n");
    await client.close();
    process.exit(1);
  }
  const credential = await payer.credentialFor(offer as never, 84532);

  const bought = await call("subetha_router_purchase", {
    quoteId: subject["quoteId"],
    requestId,
    approval: subject["quoteId"],
    credential,
  });
  process.stdout.write(`purchase outcome=${String(bought["outcome"])}\n`);
  process.stdout.write(`purchase body=${JSON.stringify(bought).slice(0, 400)}\n`);
  const status = await call("subetha_router_status", {
    paymentId: String(bought["paymentId"] ?? subject["paymentId"]),
  });
  const projection = status["projection"] as Record<string, unknown> | undefined;
  if (projection !== undefined) {
    process.stdout.write(
      `inbound  tx=${String((projection["source"] as Record<string, unknown>)["txRef"])}\n`,
    );
    process.stdout.write(
      `outbound tx=${String((projection["destination"] as Record<string, unknown>)["txRef"])}\n`,
    );
  }
  await client.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`remote-verify failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
