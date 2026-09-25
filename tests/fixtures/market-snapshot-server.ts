/**
 * 合成上流（chat 側 `market-data.mjs` の snapshot プロファイルに適合する形）。
 * **テスト基盤であり製品の Provider ではない。** canonical は `GET /v1/eth/snapshot`（クエリ不可）。
 * 鍵・署名・実決済はなく、受け取る `x-payment` は無課金トークン。
 *
 * 返す body は chat 側 `decodeMarketSnapshot` の要求形に合わせた**固定の合成値**で、
 * mainnet の実アドレス・実データの「形」ではあるが**チェーンにも実 API にも到達しない**
 * （U-06 は未解決のまま。実 API 到達を主張しない）。
 *
 * `market-data.mjs` は各オブジェクトを exact key set で検査するため、
 * **診断用の余剰フィールドを 1 つでも足すと落ちる**。
 *
 * usage: market-snapshot-server.ts [--provider a|b] [--pay ok|paid-no-data|error]
 */

import http from "node:http";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const provider = arg("provider", "a") === "b" ? "b" : "a";
const payMode = arg("pay", "ok");

const SNAPSHOT_PATH = "/v1/eth/snapshot";

let challengeCalls = 0;
let payCalls = 0;

function accepts(): unknown[] {
  return [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x000000000000000000000000000000000000de57",
      amount: "900",
      payTo: "0x0000000000000000000000000000000000000a11",
      maxTimeoutSeconds: 120,
      extra: { name: "synthetic-usd", version: "2" },
    },
  ];
}

/**
 * Provider A 形。数値は `decimal()` が要求する**文字列**
 * （`/^-?\d+(?:\.\d+)?$/`。指数表記・`+`・`.5`・`5.` は不可）。
 * `markPx` / `prevDayPx` は `positive`（`"0"` 不可）、`dayNtlVlm` は非負。
 * `assetIndex` だけは JSON number（安全整数・非負）。
 */
function snapshotA(): unknown {
  return {
    providerId: "market-data-a",
    market: { kind: "perpetual", symbol: "ETH", quote: "USD" },
    dataSource: { name: "hyperliquid", network: "hyperliquid-mainnet" },
    payment: { protocol: "x402", network: "eip155:84532" },
    fetchedAt: "2026-09-26T00:00:00.000Z",
    data: {
      markPx: "3000.12",
      prevDayPx: "2950.40",
      dayNtlVlm: "123456789.00",
      change24h: { absolute: "49.72", percent: "1.68" },
      assetIndex: 4,
    },
  };
}

/**
 * Provider B 形（Uniswap v3 参照）。`pool` / `token0.address` / `token1.address` は
 * `market-data.mjs` が固定値で照合する（大小無視）。`feeBps` と `decimals` は JSON number、
 * `blockNumber` は `/^(0|[1-9]\d*)$/`、`sqrtPriceX96` は `/^[1-9]\d*$/`（`"0"`・先頭 0 不可）。
 */
function snapshotB(): unknown {
  return {
    providerId: "market-data-b",
    market: { kind: "spot-reference", symbol: "ETH", quote: "USDC" },
    dataSource: { name: "uniswap-v3", network: "eip155:1" },
    payment: { protocol: "mpp", network: "tempo-moderato-42431" },
    fetchedAt: "2026-09-26T00:00:00.000Z",
    data: {
      pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
      feeBps: 5,
      feeLabel: "0.05%",
      blockNumber: "20000000",
      sqrtPriceX96: "1234567890123456789012345",
      priceUsdcPerWeth: "3000.12",
      token0: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
      token1: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
      disclaimer: "pool spot reference, not an executable quote",
    },
  };
}

function snapshot(): unknown {
  return provider === "b" ? snapshotB() : snapshotA();
}

function send(response: http.ServerResponse, status: number, body: unknown, headers = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/calls") {
    send(response, 200, { challengeCalls, payCalls });
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
  // canonical はクエリ無し（chat 側 `validateMarketResource` も query/hash を拒否する）。
  if (url.search !== "") {
    send(response, 400, { error: "query_not_allowed" });
    return;
  }

  if (request.headers["x-payment"] === undefined) {
    challengeCalls += 1;
    send(response, 402, { x402Version: 2, accepts: accepts(), error: "payment_required" });
    return;
  }

  payCalls += 1;
  const receipt = `synthetic-dst-${payCalls}`;
  if (payMode === "paid-no-data") {
    send(response, 502, { error: "upstream_unavailable" }, { "x-payment-response": receipt });
    return;
  }
  if (payMode === "error") {
    send(response, 500, { error: "upstream_error" });
    return;
  }
  send(response, 200, snapshot(), { "x-payment-response": receipt });
});

server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(
    `${JSON.stringify({ event: "listening", port, role: "market-snapshot", provider })}\n`,
  );
});
