/**
 * 試験用の JSON-RPC（HTTP、loopback）。SSRF 防御 A の T-A13 経路 11・12: SDK / 能力の JSON-RPC が guarded transport を
 * 通ることを、**実 TCP の接続数**と受けた method で観測する。応答は `mpp-payer-spy.ts` と同じ最小の stub
 * （鍵も実チェーンも無い。`eth_getTransactionReceipt` は null = 未知の tx）。
 * 引数: `--chain-id`、`--port`。`GET /calls` → `{ connections, methods }`。
 */
import http from "node:http";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : fallback;
}

const chainId = Number(arg("chain-id", "42431"));
const txHash = `0x${"b0".repeat(32)}`;
let connections = 0;
const methods: string[] = [];

function stub(method: string): unknown {
  switch (method) {
    case "eth_chainId":
      return `0x${chainId.toString(16)}`;
    case "eth_accounts":
      return ["0x0000000000000000000000000000000000000B0b"];
    case "wallet_getCapabilities":
      return {};
    case "wallet_sendCalls":
      return { id: `0x${"c0".repeat(16)}` };
    case "wallet_sendCallsSync":
    case "wallet_getCallsStatus":
      return {
        version: "2.0.0",
        id: `0x${"c0".repeat(16)}`,
        chainId: `0x${chainId.toString(16)}`,
        status: 200,
        atomic: true,
        receipts: [{ status: "0x1", blockHash: `0x${"11".repeat(32)}`, blockNumber: "0x1", gasUsed: "0x1", logs: [], transactionHash: txHash }],
      };
    case "eth_getTransactionReceipt":
      return null;
    default:
      throw new Error(`rpc fixture has no stub for ${method}`);
  }
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/calls") {
    send(response, 200, { connections, methods });
    return;
  }
  if (request.method !== "POST") {
    send(response, 405, { error: "method_not_allowed" });
    return;
  }
  let text = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => (text += chunk));
  request.on("end", () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const answer = (call: unknown): unknown => {
      const record = (typeof call === "object" && call !== null ? call : {}) as { id?: unknown; method?: unknown };
      const method = String(record.method ?? "");
      methods.push(method);
      try {
        return { jsonrpc: "2.0", id: record.id ?? null, result: stub(method) };
      } catch (error) {
        return { jsonrpc: "2.0", id: record.id ?? null, error: { code: -32601, message: (error as Error).message } };
      }
    };
    send(response, 200, Array.isArray(parsed) ? parsed.map(answer) : answer(parsed));
  });
});

server.on("connection", () => {
  connections += 1;
});
server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ event: "listening", port, role: "rpc" })}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
