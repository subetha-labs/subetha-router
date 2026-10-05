/**
 * 合成上流（Provider A 形の 402 リソース）。**テスト基盤であり製品の Provider ではない。**
 * canonical は `GET /v1/eth/snapshot`（クエリ不可）。鍵・署名・実決済はなく、受け取る
 * `x-payment` は `synthetic` ラベル付きの無課金トークンで、実 x402 SDK の支払いではない。
 *
 * usage: upstream-server.ts [--pay ok|paid-no-data|error|reject|abort]
 *        [--change-after N] [--change-field amount|maxTimeoutSeconds] [--amount 900]
 */

import http from "node:http";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/** 設計 A の T-A17: `--after-headers stall|reset`、`--after-headers-on all|challenge|pay`。 */
const afterHeaders = arg("after-headers", "none");
const afterHeadersOn = arg("after-headers-on", "all");
/** 種類別の閉じた接続数（`challenge` = 402 / `other` = それ以外 / `calls` = 観測用）。 */
const closedByKind: Record<string, number> = { challenge: 0, other: 0, calls: 0, none: 0 };
function stallThis(status: number): boolean {
  if (afterHeaders === "none") return false;
  if (afterHeadersOn === "challenge") return status === 402;
  if (afterHeadersOn === "pay") return status !== 402;
  return true;
}
/** TCP 接続数（設計 A の試験が読む）。 */
let connections = 0;

const payMode = arg("pay", "ok");
const baseAmount = arg("amount", "900");
/** この回数だけ challenge を返したあとは提示内容を変える（quote 変更のレース再現）。 */
const changeAfter = Number(arg("change-after", "0"));
/** 変える対象のトップレベルフィールド。`amount` 以外の変更も検知されねばならない。 */
const changeField = arg("change-field", "amount");

const SNAPSHOT_PATH = "/v1/eth/snapshot";

let challengeCalls = 0;
let payCalls = 0;
const seenQueries: string[] = [];

function changed(): boolean {
  return changeAfter > 0 && challengeCalls > changeAfter;
}

function currentAmount(): string {
  return changed() && changeField === "amount" ? `${Number(baseAmount) + 1}` : baseAmount;
}

/** 金額以外のトップレベルフィールドを変える経路（束縛が全フィールドを見ているかの確認用）。 */
function currentMaxTimeoutSeconds(): number {
  return changed() && changeField === "maxTimeoutSeconds" ? 300 : 120;
}

function accepts(): unknown[] {
  return [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x000000000000000000000000000000000000de57",
      amount: currentAmount(),
      payTo: "0x0000000000000000000000000000000000000a11",
      maxTimeoutSeconds: currentMaxTimeoutSeconds(),
      extra: { name: "synthetic-usd", version: "2" },
    },
  ];
}

function send(response: http.ServerResponse, status: number, body: unknown, headers = {}): void {
  const text = JSON.stringify(body);
  const kind = (response.req.url ?? "").startsWith("/calls") ? "calls" : status === 402 ? "challenge" : "other";
  const tagged = response.socket as unknown as { subethaKind?: string } | null;
  if (tagged !== null) tagged.subethaKind = kind;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  if (stallThis(status) && !(response.req.url ?? "").startsWith("/calls")) {
    // 設計 A の T-A17: headers（と content-length）は正しく返し、body を止める / 切る。
    response.write(text.slice(0, 1));
    // reset は headers がクライアントに届いてから切る（同じ tick で切ると fetch 自体が失敗し、headers 後の事象にならない）。
    if (afterHeaders === "reset") setTimeout(() => response.socket?.destroy(), 50);
    return;
  }
  response.end(text);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/calls") {
    send(response, 200, { connections, closedByKind, challengeCalls, payCalls, seenQueries });
    return;
  }
  if (url.pathname !== SNAPSHOT_PATH) {
    send(response, 404, { error: "not_found" });
    return;
  }
  if (request.method !== "GET") {
    send(response, 405, { error: "method_not_allowed" });
    return;
  }
  // canonical はクエリ無し。Router が付けていないことを実際に確かめる。
  if (url.search !== "") {
    seenQueries.push(url.search);
    send(response, 400, { error: "query_not_allowed" });
    return;
  }

  const payment = request.headers["x-payment"];
  if (payment === undefined) {
    challengeCalls += 1;
    send(response, 402, { x402Version: 2, accepts: accepts(), error: "payment_required" });
    return;
  }

  payCalls += 1;
  const receipt = `synthetic-dst-${payCalls}`;
  if (payMode === "abort") {
    request.socket.destroy();
    return;
  }
  if (payMode === "error") {
    send(response, 500, { error: "synthetic_upstream_error" });
    return;
  }
  if (payMode === "reject") {
    send(response, 402, { x402Version: 2, accepts: accepts(), error: "payment_invalid" });
    return;
  }
  if (payMode === "paid-no-data") {
    send(
      response,
      502,
      { error: "paid_data_unavailable" },
      { "x-payment-response": receipt },
    );
    return;
  }
  send(
    response,
    200,
    {
      providerId: "synthetic-provider-a",
      market: "ETH",
      dataSource: "synthetic-fixture",
      payment: { network: "eip155:84532", amount: currentAmount() },
      fetchedAt: "2026-09-25T00:00:00.000Z",
      data: { symbol: "ETH", price: "3000.12" },
    },
    { "x-payment-response": receipt },
  );
});

server.on("connection", (socket) => {
  connections += 1;
  socket.on("close", () => {
    const kind = (socket as unknown as { subethaKind?: string }).subethaKind ?? "none";
    closedByKind[kind] = (closedByKind[kind] ?? 0) + 1;
  });
});
server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ event: "listening", port, role: "upstream" })}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
