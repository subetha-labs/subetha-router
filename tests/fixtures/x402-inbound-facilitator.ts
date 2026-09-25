/**
 * 受信レグ用の**合成 facilitator**（x402 `/verify` `/settle`）。
 * **テスト基盤であり製品の facilitator ではない。** 鍵・署名・実決済は無い。
 *
 * 実 facilitator の観測された挙動を再現する:
 * - 拒否でも **HTTP 200** で `{isValid:false, invalidReason}` を返す
 * - 想定外の形には **500 + 内部例外文字列**（`--leak` で再現。Router が転送しないことの確認用）
 *
 * usage: x402-inbound-facilitator.ts [--verify ok|invalid] [--settle ok|reject|unknown] [--leak]
 */

import http from "node:http";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const verifyMode = arg("verify", "ok");
const settleMode = arg("settle", "ok");
const leak = process.argv.includes("--leak");

let verifyCalls = 0;
let settleCalls = 0;
/** 最後に受け取った requirements（Router が何を送ったかの検証用）。 */
let lastRequirements: unknown;
let lastPayload: unknown;

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/calls") {
    send(response, 200, { verifyCalls, settleCalls, lastRequirements, lastPayload });
    return;
  }

  void (async () => {
    const body = await readJson(request);
    lastRequirements = body["paymentRequirements"];
    lastPayload = body["paymentPayload"];

    if (url.pathname === "/verify") {
      verifyCalls += 1;
      if (leak) {
        // 実 facilitator が内部例外を漏らす挙動（Router が転送しないことの確認用）。
        send(response, 500, {
          isValid: false,
          invalidReason: "unexpected_error",
          invalidMessage: "Cannot read properties of undefined (reading 'scheme')",
          error: "SECRET_INTERNAL_DETAIL",
        });
        return;
      }
      // 拒否でも 200 を返す（実 facilitator と同じ）。
      send(response, 200, { isValid: verifyMode === "ok", invalidReason: "invalid_exact_evm_signature" });
      return;
    }

    if (url.pathname === "/settle") {
      settleCalls += 1;
      if (settleMode === "unknown") {
        send(response, 500, { error: "SECRET_INTERNAL_DETAIL" });
        return;
      }
      if (settleMode === "reject") {
        send(response, 200, { success: false });
        return;
      }
      const requirements = lastRequirements as Record<string, unknown> | undefined;
      send(response, 200, {
        success: true,
        network: requirements?.["network"],
        transaction: `synthetic-inbound-${settleCalls}`,
        payer: "0x0000000000000000000000000000000000000501",
      });
      return;
    }

    send(response, 404, { error: "not_found" });
  })();
});

server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(
    `${JSON.stringify({ event: "listening", port, role: "x402-inbound-facilitator" })}\n`,
  );
});
