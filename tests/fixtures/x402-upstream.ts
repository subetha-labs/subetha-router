/**
 * x402 v2 の**実 wire**を話す合成上流（Provider A 形）。
 * **テスト基盤であり製品の Provider ではない。** 鍵・署名検証・実決済・実資産は一切なく、
 * 返す `transaction` は `synthetic-` 接頭辞付きの無課金ラベルで実決済の証拠にならない。
 *
 * 402 では `PAYMENT-REQUIRED`（公式 encoder）を返し、支払い要求は `PAYMENT-SIGNATURE`
 * ヘッダで受ける。成功時は `PAYMENT-RESPONSE`（公式 encoder）を載せる。
 *
 * usage: x402-upstream.ts [--pay ok|paid-no-data|error|reject|abort|no-receipt|settle-failed|html]
 *        [--settle-network <caip2>] [--change-after N]
 *        [--change-field amount|maxTimeoutSeconds|extra-unknown] [--amount 900]
 *        [--atm eip3009|permit2] [--payer ok|other|malformed|absent]
 */

import http from "node:http";

import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/** 設計 A の T-A17: `--after-headers stall|reset`。headers の後で body を止める / 切る（`/calls` は除く）。 */
const afterHeaders = arg("after-headers", "none");
/** どの応答に効かせるか: `all`（既定）、`challenge`（402 だけ）、`pay`（402 以外だけ）。 */
const afterHeadersOn = arg("after-headers-on", "all");
function stallThis(status: number): boolean {
  if (afterHeaders === "none") return false;
  if (afterHeadersOn === "challenge") return status === 402;
  if (afterHeadersOn === "pay") return status !== 402;
  return true;
}
/** TCP 接続数（設計 A の囮・到達の試験が読む）。 */
let connections = 0;

const payMode = arg("pay", "ok");
const baseAmount = arg("amount", "900");
const changeAfter = Number(arg("change-after", "0"));
const changeField = arg("change-field", "amount");
const assetTransferMethod = arg("atm", "eip3009");
const settleNetworkOverride = arg("settle-network", "");

const NETWORK = "eip155:84532";
const ASSET = "0x000000000000000000000000000000000000de57";
const PAY_TO = "0x0000000000000000000000000000000000000a11";
const SNAPSHOT_PATH = "/v1/eth/snapshot";

let challengeCalls = 0;
let payCalls = 0;
/** 受け取った `PAYMENT-SIGNATURE` の要約（署名検証はしない）。 */
const seenPayments: unknown[] = [];
const seenQueries: string[] = [];

function changed(): boolean {
  return changeAfter > 0 && challengeCalls > changeAfter;
}

function currentAmount(): string {
  return changed() && changeField === "amount" ? `${Number(baseAmount) + 1}` : baseAmount;
}

function currentMaxTimeoutSeconds(): number {
  return changed() && changeField === "maxTimeoutSeconds" ? 300 : 120;
}

/**
 * `extra` には EIP-712 ドメイン（`name` / `version`）と、Router が落としてはいけない
 * **未知フィールド**を載せる。`extra-unknown` 変更では未知フィールドだけを変える。
 */
function currentExtra(): Record<string, unknown> {
  return {
    name: "synthetic-usd",
    version: "2",
    assetTransferMethod,
    providerNote: changed() && changeField === "extra-unknown" ? "rotated" : "original",
  };
}

function accepts(): Record<string, unknown>[] {
  return [
    {
      scheme: "exact",
      network: NETWORK,
      asset: ASSET,
      amount: currentAmount(),
      payTo: PAY_TO,
      maxTimeoutSeconds: currentMaxTimeoutSeconds(),
      extra: currentExtra(),
    },
  ];
}

function paymentRequiredHeader(canonicalUrl: string, error: string): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    error,
    resource: { url: canonicalUrl },
    accepts: accepts(),
  } as Parameters<typeof encodePaymentRequiredHeader>[0]);
}

function send(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
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

/** 既定は署名 spy の公開アドレス（`tests/fixtures/x402-signer-spy.ts` の既定値）。 */
const SPY_PAYER = "0x0000000000000000000000000000000000000501";
const payerMode = arg("payer", "ok");

function currentPayer(): string | undefined {
  switch (payerMode) {
    case "absent":
      return undefined;
    case "other":
      // 同じ network の**別の**購入者（承認した支払い元ではない）。
      return "0x0000000000000000000000000000000000000777";
    case "malformed":
      return "not-an-address";
    default:
      return SPY_PAYER;
  }
}

function receiptHeader(): Record<string, string> {
  const payer = currentPayer();
  const settleResponse = {
    success: payMode !== "settle-failed",
    transaction: `synthetic-dst-${payCalls}`,
    network: settleNetworkOverride === "" ? NETWORK : settleNetworkOverride,
    ...(payer === undefined ? {} : { payer }),
  };
  let encoded: string;
  try {
    encoded = encodePaymentResponseHeader(
      settleResponse as Parameters<typeof encodePaymentResponseHeader>[0],
    );
  } catch {
    // 公式 encoder が受け付けない値（型違反 payer 等）もそのまま wire に出せるようにする。
    encoded = Buffer.from(JSON.stringify(settleResponse), "utf8").toString("base64");
  }
  return { "PAYMENT-RESPONSE": encoded };
}

const port = Number(arg("port", "0"));

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const canonicalUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${SNAPSHOT_PATH}`;

  if (request.method === "GET" && url.pathname === "/calls") {
    send(response, 200, { connections, challengeCalls, payCalls, seenQueries, seenPayments });
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

  const signature = request.headers["payment-signature"];
  if (signature === undefined) {
    challengeCalls += 1;
    send(
      response,
      402,
      { error: "payment_required" },
      { "PAYMENT-REQUIRED": paymentRequiredHeader(canonicalUrl, "payment_required") },
    );
    return;
  }

  payCalls += 1;
  try {
    const payload = decodePaymentSignatureHeader(
      Array.isArray(signature) ? (signature[0] ?? "") : signature,
    );
    seenPayments.push(payload);
  } catch (error) {
    seenPayments.push({ decodeError: (error as Error).message });
  }

  if (payMode === "abort") {
    request.socket.destroy();
    return;
  }
  if (payMode === "error") {
    send(response, 500, { error: "synthetic_upstream_error" });
    return;
  }
  if (payMode === "reject") {
    send(
      response,
      402,
      { error: "payment_invalid" },
      { "PAYMENT-REQUIRED": paymentRequiredHeader(canonicalUrl, "payment_invalid") },
    );
    return;
  }
  if (payMode === "no-receipt") {
    // 支払いヘッダは受けたのに決済レシートを返さない（HTTP 200 だけの応答）。
    send(response, 200, { providerId: "synthetic-provider-a", data: { symbol: "ETH" } });
    return;
  }
  if (payMode === "html") {
    // 決済レシートは正しいのに、本文が JSON ではない（配信データを取得できていない）。
    const html = "<html><body>maintenance</body></html>";
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      ...receiptHeader(),
    });
    response.end(html);
    return;
  }
  if (payMode === "paid-no-data") {
    send(response, 502, { error: "paid_data_unavailable" }, receiptHeader());
    return;
  }
  send(
    response,
    200,
    {
      providerId: "synthetic-provider-a",
      market: "ETH",
      dataSource: "synthetic-fixture",
      payment: { network: NETWORK, amount: currentAmount() },
      fetchedAt: "2026-09-25T00:00:00.000Z",
      data: { symbol: "ETH", price: "3000.12" },
    },
    receiptHeader(),
  );
});

server.on("connection", () => {
  connections += 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(
    `${JSON.stringify({ event: "listening", port: actual, role: "x402-upstream" })}\n`,
  );
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
