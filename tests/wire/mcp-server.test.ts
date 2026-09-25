/**
 * Router の MCP ラッパを、**実 MCP サーバプロセス × 実 Router プロセス**で検証する。
 * ラベル `T6-mcp-nopay`。
 *
 * 支払いは発生しない: 合成 facilitator・合成上流で、資格情報は合成レール専用の
 * 無課金トークン（`synthetic: true` を隠さない）。実鍵・実署名・実送金・実 API 到達はない。
 * **AC-7 は達成しない**（実決済の支払いレグがないため）。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALICE,
  ROUTE_A,
  callTool,
  runServerRaw,
  startMcpHarness,
  type McpHarness,
} from "../fixtures/mcp-harness.js";
import { callsOf } from "../fixtures/router-harness.js";

/** MCP サーバ + Router + facilitator + 上流の多段起動を含むので既定 5s では足りない。 */
const TIMEOUT = 90_000;

const TOOLS = [
  "subetha_router_list_routes",
  "subetha_router_quote",
  "subetha_router_purchase",
  "subetha_router_status",
];

async function withHarness(
  options: Parameters<typeof startMcpHarness>[0],
  body: (h: McpHarness) => Promise<void>,
): Promise<void> {
  const harness = await startMcpHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.stop();
  }
}

/** 合成上流が課金呼び出しを受けていないこと（否定系の独立確認）。 */
async function expectNoUpstreamPay(h: McpHarness): Promise<void> {
  const calls = await callsOf(h.router.upstreamA);
  expect(calls["payCalls"]).toBe(0);
}

describe("T6-mcp-nopay: Router の MCP ラッパ", () => {
  it(
    "T6-01: tools/list に 4 つの tool が出る",
    async () => {
      await withHarness({}, async (h) => {
        const listed = await h.client.listTools();
        expect(listed.tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
      });
    },
    TIMEOUT,
  );

  it(
    "T6-02: src/mcp は src/core を import しない（境界）",
    async () => {
      const dir = path.resolve(import.meta.dirname, "../../src/mcp");
      const files = await readdir(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = await readFile(path.join(dir, file), "utf8");
        // 公開契約（HTTP）経由でのみ Router に触る。core を直呼びしない。
        expect(text).not.toMatch(/from\s+"\.\.\/core\//);
        expect(text).not.toMatch(/from\s+"\.\.\/http\//);
      }
    },
    TIMEOUT,
  );

  it(
    "T6-03: 承認しなければ支払いが始まらない",
    async () => {
      await withHarness({}, async (h) => {
        const quoted = await callTool(h.client, "subetha_router_quote", {
          routeId: ROUTE_A,
          requestId: "t6-unapproved",
        });
        expect(quoted["ok"]).toBe(true);
        const subject = quoted["subject"] as Record<string, unknown>;
        const result = await callTool(h.client, "subetha_router_purchase", {
          quoteId: subject["quoteId"],
          requestId: "t6-unapproved",
        });
        // **どの層で止まったかを固定する。** MCP 層は承認を判定し直さず、
        // 束縛検査は T4 クライアント層が行い、**Router へ要求を出さずに**止まる
        // （`src/client/types.ts` の `approval_mismatch` は「Router へ要求を出していない」）。
        expect(result["ok"]).toBe(false);
        expect(result["outcome"]).toBe("approval_mismatch");
        await expectNoUpstreamPay(h);
      });
    },
    TIMEOUT,
  );

  it(
    "T6-03b: 別 quoteId で承認しても支払いが始まらない",
    async () => {
      await withHarness({}, async (h) => {
        const quoted = await callTool(h.client, "subetha_router_quote", {
          routeId: ROUTE_A,
          requestId: "t6-mismatch",
        });
        const subject = quoted["subject"] as Record<string, unknown>;
        const result = await callTool(h.client, "subetha_router_purchase", {
          quoteId: subject["quoteId"],
          requestId: "t6-mismatch",
          approval: "some-other-quote-id",
        });
        expect(result["ok"]).toBe(false);
        expect(result["outcome"]).toBe("approval_mismatch");
        await expectNoUpstreamPay(h);
      });
    },
    TIMEOUT,
  );

  it(
    "T6-03c: Router 自身も承認なしを拒否する（クライアント層に依存しない権限境界）",
    async () => {
      // 上の 2 件はクライアント層で止まるため、Router の拒否面は通っていない。
      // 権限境界が Router 側にも実在することを、公開契約を直接叩いて確かめる。
      await withHarness({}, async (h) => {
        const base = h.router.router.baseUrl;
        const headers = {
          "x-router-principal": ALICE.id,
          authorization: `Bearer ${ALICE.token}`,
        };
        const quoted = (await (
          await fetch(`${base}/v1/quotes`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ routeId: ROUTE_A, requestId: "t6-router-appr" }),
          })
        ).json()) as Record<string, unknown>;
        const source = quoted["source"] as Record<string, unknown>;
        const offer = source["offer"] as { extra: { challengeNonce: string } };
        const credential = Buffer.from(
          JSON.stringify({
            x402Version: 2,
            accepted: offer,
            payload: { challengeNonce: offer.extra.challengeNonce, synthetic: true },
          }),
          "utf8",
        ).toString("base64");
        const resource = quoted["resource"] as { url: string };
        // R2 が返す canonical origin は設定値（:8500）で、実際の待ち受けは使い捨てポート
        // （既存 harness の意図的な不一致。`tests/wire/client.test.ts` の注記と同じ）。
        // ここでは実 origin に差し替えて公開契約を直接叩く。
        const target = resource.url.replace(/^https?:\/\/[^/]+/, base);
        // 承認ヘッダを付けず、資格情報だけ付けて R3 を叩く。
        const response = await fetch(target, {
          headers: {
            ...headers,
            "x-router-quote-id": String(quoted["quoteId"]),
            "x-router-request-id": "t6-router-appr",
            "x-payment": credential,
          },
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body["error"]).toBe("approval_required");
        // Router が自分で弾いているので上流課金も起きていない。
        await expectNoUpstreamPay(h);
      });
    },
    TIMEOUT,
  );

  it(
    "T6-05b/05c: 同一引数で 3 回反復しても paymentId は同一で両レグは 1 回",
    async () => {
      await withHarness({}, async (h) => {
        const quoted = await callTool(h.client, "subetha_router_quote", {
          routeId: ROUTE_A,
          requestId: "t6-repeat",
        });
        const subject = quoted["subject"] as Record<string, unknown>;
        const args = {
          quoteId: subject["quoteId"],
          requestId: "t6-repeat",
          approval: subject["quoteId"],
        };
        const first = await callTool(h.client, "subetha_router_purchase", args);
        expect(first["outcome"]).toBe("delivered");
        const paymentId = first["paymentId"];
        expect(typeof paymentId).toBe("string");

        // 反復（クライアント側の自動再試行に相当）しても増えない。
        const second = await callTool(h.client, "subetha_router_purchase", args);
        const third = await callTool(h.client, "subetha_router_purchase", args);
        expect(second["paymentId"]).toBe(paymentId);
        expect(third["paymentId"]).toBe(paymentId);

        const calls = await callsOf(h.router.upstreamA);
        expect(calls["payCalls"]).toBe(1);
      });
    },
    TIMEOUT,
  );

  it(
    "T6-04: 応答にトークンが出ず、承認対象に decimals が含まれる",
    async () => {
      await withHarness({}, async (h) => {
        const quoted = await callTool(h.client, "subetha_router_quote", {
          routeId: ROUTE_A,
          requestId: "t6-secrets",
        });
        const serialized = JSON.stringify(quoted);
        expect(serialized).not.toContain(ALICE.token);
        // base units なので decimals が無いと人間が額を判断できない。
        const subject = quoted["subject"] as Record<string, unknown>;
        const source = subject["source"] as Record<string, unknown>;
        expect(source["decimals"]).toBe(6);
        expect(source["amount"]).toBeTypeOf("string");
      });
    },
    TIMEOUT,
  );

  it(
    "T6-04: stdout は JSON-RPC 専用（全行が parse できる）",
    async () => {
      // SDK クライアント経由だと SDK がパースしてしまうので raw で spawn して全バイト見る。
      const harness = await startMcpHarness({});
      const baseUrl = harness.router.router.baseUrl;
      await harness.stop();

      const initialize =
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        })}\n`;
      const run = await runServerRaw(
        {
          ROUTER_MCP_BASE_URL: baseUrl,
          ROUTER_MCP_PRINCIPAL_ID: ALICE.id,
          ROUTER_MCP_TOKEN: ALICE.token,
          ROUTER_MCP_ADAPTER_MODE: "synthetic",
          ROUTER_MCP_EVIDENCE_LABEL: "T1-synthetic-nopay",
        },
        initialize,
      );
      const lines = run.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      // 診断は stderr 側に出ている（stdout を汚していない）。
      expect(run.stderr).toContain("subetha-router MCP server ready");
      expect(run.stdout).not.toContain("subetha-router MCP server ready");
    },
    TIMEOUT,
  );

  it(
    "T6-07: evidence は label/source/verified を持ち、自己申告は verified=false",
    async () => {
      await withHarness({ evidenceLabel: "T1-synthetic-nopay" }, async (h) => {
        const listed = await callTool(h.client, "subetha_router_list_routes");
        const evidence = listed["evidence"] as Record<string, unknown>;
        expect(evidence["label"]).toBe("T1-synthetic-nopay");
        expect(evidence["source"]).toBe("operator_asserted");
        expect(evidence["verified"]).toBe(false);
        expect(listed["adapterMode"]).toBe("synthetic");
      });
    },
    TIMEOUT,
  );

  it(
    "T6-07: Router 自身の起動行から読めたときは verified=true",
    async () => {
      // Router が実際に stdout へ書いた listening 行をそのまま使う（自己申告ではない）。
      const harness = await startMcpHarness({});
      const listeningLine = harness.router.router.stdout();
      await harness.stop();
      const file = path.join(
        process.env["TMPDIR"] ?? "/tmp",
        `t6-evidence-${process.pid}-${Date.now()}.log`,
      );
      const { writeFile, rm } = await import("node:fs/promises");
      await writeFile(file, listeningLine, "utf8");
      try {
        await withHarness({ evidenceFile: file }, async (h) => {
          const listed = await callTool(h.client, "subetha_router_list_routes");
          const evidence = listed["evidence"] as Record<string, unknown>;
          expect(evidence["source"]).toBe("router_listening_line");
          expect(evidence["verified"]).toBe(true);
          expect(evidence["label"]).toBe("T1-synthetic-nopay");
        });
      } finally {
        await rm(file, { force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "T6-07: 証拠ラベルが無ければ起動を拒否する",
    async () => {
      const run = await runServerRaw(
        {
          ROUTER_MCP_BASE_URL: "http://127.0.0.1:1",
          ROUTER_MCP_PRINCIPAL_ID: ALICE.id,
          ROUTER_MCP_TOKEN: ALICE.token,
        },
        "",
      );
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("ROUTER_MCP_EVIDENCE_FILE");
      expect(run.stdout.trim()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "設計 §3b: real モードで payer が注入されていなければ支払いを始めない",
    async () => {
      await withHarness({ mode: "real" }, async (h) => {
        const quoted = await callTool(h.client, "subetha_router_quote", {
          routeId: ROUTE_A,
          requestId: "t6-real",
        });
        const subject = quoted["subject"] as Record<string, unknown>;
        const result = await callTool(h.client, "subetha_router_purchase", {
          quoteId: subject["quoteId"],
          requestId: "t6-real",
          approval: subject["quoteId"],
        });
        expect(result["ok"]).toBe(false);
        // 能力が無いときは偽の資格情報で代替せず fail closed（コード名は能力の不在を指す）。
        expect(result["error"]).toBe("inbound_payer_not_configured");
        await expectNoUpstreamPay(h);
      });
    },
    TIMEOUT,
  );

  it(
    "T6-05: status は保存 → 再オープン相当で同一 paymentId を返す",
    async () => {
      await withHarness({}, async (h) => {
        const quoted = await callTool(h.client, "subetha_router_quote", {
          routeId: ROUTE_A,
          requestId: "t6-status",
        });
        const subject = quoted["subject"] as Record<string, unknown>;
        const bought = await callTool(h.client, "subetha_router_purchase", {
          quoteId: subject["quoteId"],
          requestId: "t6-status",
          approval: subject["quoteId"],
        });
        expect(bought["outcome"]).toBe("delivered");
        const status = await callTool(h.client, "subetha_router_status", {
          paymentId: bought["paymentId"],
        });
        expect(status["found"]).toBe(true);
        const projection = status["projection"] as Record<string, unknown>;
        expect(projection["paymentId"]).toBe(bought["paymentId"]);
      });
    },
    TIMEOUT,
  );
});
