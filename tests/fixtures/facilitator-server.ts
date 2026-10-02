/**
 * 合成 SubEtha facilitator（設計 §4.1 の素の JSON over HTTP）。
 * **テスト基盤であり製品の Provider ではない。** 鍵・署名・送金・実資産は一切なく、
 * 返す `transaction` は `synthetic-` 接頭辞付きの無課金ラベルで実決済の証拠にならない。
 *
 * usage: facilitator-server.ts --token 0x… --chain-id 11155111 --pay-to 0x…
 *        [--settle ok|pending|pending-burn|accepted-replay|rejected|rejected-200|rate-limited|error]
 *        [--verify ok|invalid]
 *        [--challenge ok|helper-only|deadline-only|helper-bad-type|deadline-bad-type|fee-bad-type]
 *        [--settle-network <caip2>]
 */

import { randomBytes } from "node:crypto";
import http from "node:http";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/** 設計 A の T-A17: `--after-headers stall|reset`。headers の後で body を止める / 切る（`/calls` は除く）。 */
const afterHeaders = arg("after-headers", "none");
/** `--after-headers-on all|challenge|verify|settle`: どの path の応答で止める / 切るか（既定は全部）。 */
const afterHeadersOn = arg("after-headers-on", "all");
const stallThis = (url: string): boolean => !url.startsWith("/calls") && (afterHeadersOn === "all" || url.startsWith(`/${afterHeadersOn}`));
/** TCP 接続数（設計 A の囮・到達の試験が読む）。 */
let connections = 0;

const token = arg("token", "0x0000000000000000000000000000000000005ce7");
const chainId = Number(arg("chain-id", "11155111"));
const payTo = arg("pay-to", "0x00000000000000000000000000000000000r0ute");
const settleMode = arg("settle", "ok");
const verifyMode = arg("verify", "ok");
/** challenge 応答の形（`helper`/`deadline` の片側欠落・型違反の再現）。 */
const challengeMode = arg("challenge", "ok");
/** settle 応答の `network`（発行 offer と異なる値を返す不正応答の再現）。 */
const settleNetwork = arg("settle-network", "");

/** `helper`/`deadline`（両方あるか両方ないか）と、その型違反を作る。 */
function challengeExtras(): Record<string, unknown> {
  const helper = "0x0000000000000000000000000000000000001e19";
  const deadline = Math.floor(Date.now() / 1000) + 300;
  switch (challengeMode) {
    case "helper-only":
      return { helper };
    case "deadline-only":
      return { deadline };
    case "helper-bad-type":
      // 両方あるが `helper` がアドレス文字列でない（型違反）。
      return { helper: 42, deadline };
    case "deadline-bad-type":
      return { helper, deadline: `${deadline}` };
    case "fee-bad-type":
      return { fee: { amount: 10, bps: "30" } };
    case "both":
      return { helper, deadline };
    default:
      return {};
  }
}

/** 発行済み challenge。nonce → 発行内容。 */
const issued = new Map<string, { amount: string; expiresAt: number }>();
let settleCalls = 0;
let verifyCalls = 0;

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  if (afterHeaders !== "none" && stallThis(response.req.url ?? "")) {
    // 設計 A の T-A17: headers（と content-length）は正しく返し、body を止める / 切る。
    response.write(text.slice(0, 1));
    // reset は headers がクライアントに届いてから切る（同じ tick で切ると fetch 自体が失敗し、headers 後の事象にならない）。
    if (afterHeaders === "reset") setTimeout(() => response.socket?.destroy(), 50);
    return;
  }
  response.end(text);
}

const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/calls") {
      send(response, 200, { connections, verifyCalls, settleCalls });
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, { error: "method_not_allowed" });
      return;
    }
    const body = await readJson(request);

    if (url.pathname === "/challenge") {
      const amount = typeof body["amount"] === "string" ? body["amount"] : "";
      if (amount === "") {
        send(response, 400, { error: "amount_required" });
        return;
      }
      const challengeNonce = `0x${randomBytes(32).toString("hex")}`;
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      issued.set(challengeNonce, { amount, expiresAt });
      send(response, 200, {
        payTo,
        amount,
        token,
        chainId,
        challengeNonce,
        expiresAt,
        ...challengeExtras(),
      });
      return;
    }

    if (url.pathname === "/verify") {
      verifyCalls += 1;
      const payload = (body["paymentPayload"] ?? {}) as Record<string, unknown>;
      const inner = (payload["payload"] ?? {}) as Record<string, unknown>;
      const nonce = typeof inner["challengeNonce"] === "string" ? inner["challengeNonce"] : "";
      send(response, 200, { isValid: verifyMode === "ok" && issued.has(nonce) });
      return;
    }

    if (url.pathname === "/settle") {
      settleCalls += 1;
      const requirements = (body["paymentRequirements"] ?? {}) as Record<string, unknown>;
      const requested = typeof requirements["network"] === "string" ? requirements["network"] : "";
      // 発行 offer と異なる `network` を返す不正応答も再現できるようにする。
      const network = settleNetwork === "" ? requested : settleNetwork;
      if (settleMode === "error") {
        send(response, 500, { error: "synthetic_facilitator_error" });
        return;
      }
      if (settleMode === "rejected") {
        send(response, 400, { success: false, transaction: "", network });
        return;
      }
      /**
       * **実 facilitator の pending 応答**（`apps/facilitator/src/server.ts:121`）。
       * HTTP 200 + `success:false` + `errorReason:"pending_burn"` で、
       * adapter が `unknown` の目印にしている `extra.phase` を**持たない**。
       * 課金の有無が未確定な応答であり、`rejected` に丸めてはならない。
       */
      if (settleMode === "pending-burn") {
        send(response, 200, {
          success: false,
          errorReason: "pending_burn",
          transaction: "",
          network,
        });
        return;
      }
      /** 実 facilitator の rate limit（`apps/facilitator/src/http.ts:41-44`）。 */
      if (settleMode === "rate-limited") {
        send(response, 429, { error: "rate limited — retry shortly" });
        return;
      }
      /**
       * **受領済み challenge への再 settle**（`packages/zerc20-backend/src/index.ts:1311-1313`）。
       * `rec.state === "accepted"` は**支払いが成立している**ことを意味するが、
       * 応答は `success:false` で返る。ここを `rejected` にすると課金済みが未払いとして提示される。
       */
      if (settleMode === "accepted-replay") {
        send(response, 200, {
          success: false,
          errorReason: "challenge not open (state=accepted)",
          transaction: "",
          network,
        });
        return;
      }
      /**
       * 実 facilitator の**本物の拒否**（HTTP 200 + `success:false` + 確定的な理由）。
       * `pending_burn` などの未確定応答と同じ 200 番台・同じ `success:false` で返るため、
       * 「200 の `success:false` を一律 `unknown` にする」実装を**落とすための対照**。
       */
      if (settleMode === "rejected-200") {
        send(response, 200, {
          success: false,
          errorReason: "burn tx reverted",
          transaction: "",
          network,
        });
        return;
      }
      if (settleMode === "pending") {
        send(response, 200, {
          success: true,
          transaction: `synthetic-src-${settleCalls}`,
          network,
          extra: { phase: "pending" },
        });
        return;
      }
      send(response, 200, {
        success: true,
        transaction: `synthetic-src-${settleCalls}`,
        network,
      });
      return;
    }

    send(response, 404, { error: "not_found" });
  })().catch(() => {
    send(response, 500, { error: "fixture_failure" });
  });
});

server.on("connection", () => {
  connections += 1;
});
server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ event: "listening", port, role: "facilitator" })}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
