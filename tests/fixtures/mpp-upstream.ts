/**
 * MPP（Provider B 形）の合成上流。**テスト基盤であり製品の Provider ではない。**
 * 鍵・署名検証・実決済・実 RPC は一切なく、返す `reference` は `synthetic-` ラベル付きの
 * 無課金値で実決済の証拠にならない。Provider B 本体は読み取り専用参照で、起動も接続もしない。
 *
 * wire は公式 `mppx` の helper で組む: 402 は `WWW-Authenticate` に challenge、支払い要求は
 * `Authorization`（`Payment` scheme）、成功応答は `Payment-Receipt`。
 *
 * usage: mpp-upstream.ts [--pay ok|paid-no-data|error|reject|abort|no-receipt|html]
 *        [--amount 1200] [--change-after N] [--change-field amount|unknown|recipient]
 *        [--receipt-method tempo] [--payer <did>] [--realm router-b-fixture]
 */

import http from "node:http";

import { Challenge, Constants, Credential, Receipt } from "mppx";

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
/** 閉じた TCP 接続数（捨てた body の接続が timeout を待たずに解放されることの観測。設計 A の T-A17 (c)(d)）。 */
let closed = 0;
/** 種類別の閉じた接続数。応答を書くときに socket へ種類を付ける（`challenge` = 402 / `paid` = それ以外 / `calls` = 観測用）。 */
const closedByKind: Record<string, number> = { challenge: 0, paid: 0, calls: 0, none: 0 };

const payMode = arg("pay", "ok");
const baseAmount = arg("amount", "1200");
const changeAfter = Number(arg("change-after", "0"));
const changeField = arg("change-field", "amount");
const receiptMethod = arg("receipt-method", "tempo");
const payerOverride = arg("payer", "");
/** `ok` は credential の取引ハッシュを返す。`wrong` は別取引の reference を返す。 */
const referenceMode = arg("reference", "ok");
const realm = arg("realm", "router-b-fixture");

/** Tempo **testnet** の公開値（mainnet 4217 / USDC.e とは混同しない）。 */
const CHAIN_ID = 42_431;
const CURRENCY = "0x20c0000000000000000000000000000000000000";
const RECIPIENT = "0x00000000000000000000000000000000000000b1";
const SNAPSHOT_PATH = "/v1/eth/snapshot";

let challengeCalls = 0;
let payCalls = 0;
const seenCredentials: unknown[] = [];
const seenQueries: string[] = [];

function changed(): boolean {
  return changeAfter > 0 && challengeCalls > changeAfter;
}

function currentAmount(): string {
  return changed() && changeField === "amount" ? `${Number(baseAmount) + 1}` : baseAmount;
}

function currentRecipient(): string {
  return changed() && changeField === "recipient"
    ? "0x00000000000000000000000000000000000000b2"
    : RECIPIENT;
}

/** Router が落としてはいけない未知フィールドも `request` に載せる。 */
function currentRequest(): Record<string, unknown> {
  return {
    amount: currentAmount(),
    currency: CURRENCY,
    recipient: currentRecipient(),
    methodDetails: { chainId: CHAIN_ID, supportedModes: ["push", "pull"] },
    providerNote: changed() && changeField === "unknown" ? "rotated" : "original",
  };
}

function canonicalUrl(port: number): string {
  return `http://127.0.0.1:${port}${SNAPSHOT_PATH}`;
}

/** 発行ごとに `id` / `expires` は変わるが、支払い条件は同一（現実の再発行と同じ形）。 */
function challengeHeader(port: number): string {
  const challenge = Challenge.from({
    // fixture 専用の非秘密キー（実 provider の secretKey ではない）。challenge ID を
    // 実サーバと同じく HMAC 束縛にするために渡す。
    secretKey: "synthetic-fixture-challenge-key",
    realm,
    method: Constants.Methods.tempo,
    intent: Constants.Intents.charge,
    request: currentRequest(),
    meta: { _mppx_scope: `GET ${canonicalUrl(port)}` },
    expires: new Date(Date.now() + 120_000).toISOString(),
  });
  return Challenge.serialize(challenge as Parameters<typeof Challenge.serialize>[0]);
}

/**
 * receipt は**受け取った credential の取引**に対応させる（実 provider も `reference` に
 * transactionHash を返す）。`reference` の値は spy が返した**合成**ハッシュで、実 broadcast の
 * 結果ではない。合成であることは `syntheticLabel` に明示する（unknown 欄は保持される）。
 */
function receiptHeader(credentialHash: string | undefined): Record<string, string> {
  const reference =
    referenceMode === "wrong"
      ? `0x${"ff".repeat(32)}`
      : (credentialHash ?? `synthetic-mpp-${payCalls}`);
  const receipt = Receipt.from({
    method: receiptMethod,
    reference,
    status: "success",
    timestamp: new Date().toISOString(),
    syntheticLabel: "T3-fixture-nopay",
    ...(payerOverride === "" ? {} : { payer: payerOverride }),
  } as Parameters<typeof Receipt.from>[0]);
  return { [Constants.Headers.paymentReceipt]: Receipt.serialize(receipt) };
}

/** credential（公式 decoder）から push payload の取引ハッシュを読む。 */
function hashOf(credential: unknown): string | undefined {
  const payload = (credential as { payload?: unknown } | undefined)?.payload;
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record["type"] === "hash" && typeof record["hash"] === "string") {
      return record["hash"];
    }
  }
  return undefined;
}

function send(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  const kind = (response.req.url ?? "").startsWith("/calls") ? "calls" : status === 402 ? "challenge" : "paid";
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
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/calls") {
    send(response, 200, { connections, closed, closedByKind, challengeCalls, payCalls, seenQueries, seenCredentials });
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
  if (url.search !== "") {
    seenQueries.push(url.search);
    send(response, 400, { error: "query_not_allowed" });
    return;
  }

  const authorization = request.headers["authorization"];
  if (authorization === undefined) {
    challengeCalls += 1;
    send(
      response,
      402,
      { error: "payment_required" },
      { [Constants.Headers.wwwAuthenticate]: challengeHeader(port) },
    );
    return;
  }

  payCalls += 1;
  let credentialHash: string | undefined;
  try {
    const credential = Credential.deserialize(authorization);
    seenCredentials.push(credential);
    credentialHash = hashOf(credential);
  } catch (error) {
    seenCredentials.push({ decodeError: (error as Error).message });
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
      { [Constants.Headers.wwwAuthenticate]: challengeHeader(port) },
    );
    return;
  }
  if (payMode === "no-receipt") {
    send(response, 200, { providerId: "synthetic-provider-b", data: { symbol: "ETH" } });
    return;
  }
  if (payMode === "html") {
    const html = "<html><body>maintenance</body></html>";
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      ...receiptHeader(credentialHash),
    });
    response.end(html);
    return;
  }
  if (payMode === "paid-no-data") {
    send(response, 502, { error: "paid_data_unavailable" }, receiptHeader(credentialHash));
    return;
  }
  // Provider B の envelope 形（providerId / market / dataSource / payment / fetchedAt / data）。
  send(
    response,
    200,
    {
      providerId: "synthetic-provider-b",
      market: "ETH",
      dataSource: "synthetic-fixture-uniswap-v3-reference",
      payment: { network: `eip155:${CHAIN_ID}`, amount: currentAmount(), currency: CURRENCY },
      fetchedAt: "2026-09-25T00:00:00.000Z",
      data: { symbol: "ETH", price: "3001.45" },
    },
    receiptHeader(credentialHash),
  );
});

server.on("connection", (socket) => {
  connections += 1;
  socket.on("close", () => {
    closed += 1;
    const kind = (socket as unknown as { subethaKind?: string }).subethaKind ?? "none";
    closedByKind[kind] = (closedByKind[kind] ?? 0) + 1;
  });
});
server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ event: "listening", port, role: "mpp-upstream" })}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
