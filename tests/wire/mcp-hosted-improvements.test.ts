/**
 * H-1（`docs/agent-payer-tasks.md`、要件 FR-A24〜A27、AC-A7）: 実 MCP サーバ × 実 Router で、
 * initialize の `instructions`、`tools/list` の `outputSchema` と `purchase` の `_meta`、`structuredContent` が schema を通ること
 * （成功・失敗・`found: false` の `reason`）を見る。既存の tool 名・引数・出力の形は `mcp-server.test.ts` が変わらず通ることで担保する。
 */
import { describe, expect, it } from "vitest";

import { ALICE, ROUTE_A, callTool, startMcpHarness, type McpHarness } from "../fixtures/mcp-harness.js";

const TIMEOUT = 90_000;

async function withHarness(body: (h: McpHarness) => Promise<void>): Promise<void> {
  const harness = await startMcpHarness({});
  try {
    await body(harness);
  } finally {
    await harness.stop();
  }
}

describe("H-1: hosted MCP improvements", () => {
  it(
    "initialize returns instructions with the steps, the never-list and the recovery rule",
    async () => {
      await withHarness(async (h) => {
        const instructions = h.client.getInstructions();
        expect(instructions).toBeDefined();
        expect(instructions).toMatch(/subetha_router_quote/);
        expect(instructions).toMatch(/Never/);
        expect(instructions).toMatch(/NOT proof that nothing was paid/);
        expect(instructions).toMatch(/new quote and a new human approval/);
      });
    },
    TIMEOUT,
  );

  it(
    "tools/list: every tool has an outputSchema; purchase carries _meta anthropic/requiresUserInteraction = true",
    async () => {
      await withHarness(async (h) => {
        const listed = await h.client.listTools();
        for (const tool of listed.tools) {
          expect(tool.outputSchema, tool.name).toBeDefined();
        }
        const purchase = listed.tools.find((t) => t.name === "subetha_router_purchase");
        expect(purchase?._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
        const quote = listed.tools.find((t) => t.name === "subetha_router_quote");
        expect(quote?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
      });
    },
    TIMEOUT,
  );

  it(
    "structuredContent passes the outputSchema for a success, a failure with a reason and a not-found status (the SDK would mark a mismatch as an error)",
    async () => {
      await withHarness(async (h) => {
        const list = (await h.client.callTool({ name: "subetha_router_list_routes", arguments: {} })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
        expect(list.isError).not.toBe(true);
        expect(list.structuredContent?.["ok"]).toBe(true);

        const unknown = (await h.client.callTool({ name: "subetha_router_quote", arguments: { routeId: "no-such-route", requestId: `h1-${Date.now()}` } })) as {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
        };
        expect(unknown.isError).not.toBe(true);
        expect(unknown.structuredContent?.["ok"]).toBe(false);
        expect(typeof unknown.structuredContent?.["error"]).toBe("string");
        expect(unknown.structuredContent?.["httpStatus"]).toBe(404);

        const status = await callTool(h.client, "subetha_router_status", { paymentId: "00000000-0000-4000-8000-000000000000" });
        expect(status["found"]).toBe(false);
        expect(status["reason"]).toBe("not_found");

        // 正常系の quote も schema を通る（既存の欄 + 静的の宛先の payTo）。
        const quoted = (await h.client.callTool({ name: "subetha_router_quote", arguments: { routeId: ROUTE_A, requestId: `h1-ok-${Date.now()}` } })) as {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
        };
        expect(quoted.isError).not.toBe(true);
        expect(quoted.structuredContent?.["ok"]).toBe(true);
        const destination = (quoted.structuredContent?.["quote"] as Record<string, unknown>)["destination"] as Record<string, unknown>;
        expect(typeof destination["payTo"]).toBe("string");
        void ALICE;
      });
    },
    TIMEOUT,
  );
});
