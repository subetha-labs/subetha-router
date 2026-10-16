/**
 * Solana の Provider の fixture（送信の設計 §7.1、タスク U7）: 402 で SVM の accepts を返し、`PAYMENT-SIGNATURE` を受けたら
 * fixture の SVM facilitator（本物の `@x402/svm` の verify の論理。simulate／send／confirm は差し替え）に `/verify` → `/settle` し、
 * 200 と `PAYMENT-RESPONSE { success, transaction, network, payer }` を返す。
 *
 * `state` で: 固定 Memo／乱数 Memo（V-12 の再現）／Memo 無し、`recentBlockhash` 入り、`feePayer` を Router の公開鍵に、`payTo` を運用者に、
 * 500、`dropAfterSettle`（facilitator の settle が返った**後**に socket を切る）、`verifyOnly`（settle を呼ばず 402 を返す）。
 * `seen.paid` に受けた payload（transaction の bytes）と回数。
 */
import https from "node:https";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";

import type { TlsMaterial } from "./tls/generate.js";

export const SVM_FIXTURE_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SVM_FIXTURE_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface SvmUpstreamState {
  /** offer の `payTo`（owner）。 */
  payTo: string;
  /** offer の `extra.feePayer`（既定は facilitator の fee payer）。 */
  feePayer: string;
  amount: string;
  /** Memo: `none`（`extra.memo` 無し）、`fixed`（`memo` の値）、`random`（402 ごとに乱数。V-12）。 */
  memoMode: "none" | "fixed" | "random";
  memo: string;
  /** `extra` に足す欄（`recentBlockhash` 等。未知の鍵として候補外になる試験用）。 */
  extraFields: Record<string, unknown>;
  /** トップレベルに足す欄。 */
  topLevel: Record<string, unknown>;
  /** accepts を丸ごと差し替える（`undefined` なら state から組む）。 */
  accepts: Record<string, unknown>[] | undefined;
  /** 402 の代わりに返す状態コード。 */
  challengeStatus: number;
  /** 402 を返すまでの待ち（ミリ秒。settle の後の読み直しの最中に process を落とす試験用）。 */
  challengeDelayMs: number;
  /** この回数までの 402 は待たない（例: 2 なら quote と purchase の受信前の読取は即答し、deliver の読み直し（3 回目）だけ待つ）。 */
  challengeDelayAfter: number;
  /** 支払いつきの要求の扱い。 */
  payMode: "settle" | "verify-only" | "status-500" | "status-404" | "no-receipt-200" | "receipt-then-502" | "drop-after-settle" | "payer-mismatch" | "receipt-only" | "receipt-then-reset";
  /** 200 の本文。 */
  body: unknown;
  /** 支払いつきの要求に答えるまでの待ち（ミリ秒）。 */
  payDelayMs: number;
  /** 領収の `transaction` を差し替える（`undefined` なら facilitator の settle の値）。 */
  receiptTransaction: string | undefined;
}

export interface SvmUpstreamSeen {
  challenges: number;
  /** 支払いつきの要求（decode した payload）。 */
  paid: { payload: unknown; transactionBase64: string | undefined }[];
  verifyResults: unknown[];
  settleResults: unknown[];
  urls: string[];
  connections: number;
}

export interface SvmUpstream {
  readonly port: number;
  readonly host: string;
  readonly state: SvmUpstreamState;
  readonly seen: SvmUpstreamSeen;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 本物の facilitator fixture（`startSvmFacilitator`）へ `/verify`・`/settle` を POST する（fixture 同士なので素の https）。 */
async function postFacilitator(facilitator: { port: number; host: string; ca: string }, path: "/verify" | "/settle", body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = https.request(
      { host: "127.0.0.1", port: facilitator.port, servername: facilitator.host, path, method: "POST", ca: facilitator.ca, headers: { host: facilitator.host, "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(data);
  });
}

export async function startSvmUpstream(tls: TlsMaterial, facilitator: { port: number; host: string; feePayer: string }, initial: { payTo: string }, host = "provider.test"): Promise<SvmUpstream> {
  const state: SvmUpstreamState = {
    payTo: initial.payTo,
    feePayer: facilitator.feePayer,
    amount: "10000",
    memoMode: "none",
    memo: "invoice 42",
    extraFields: {},
    topLevel: {},
    accepts: undefined,
    challengeStatus: 402,
    challengeDelayMs: 0,
    challengeDelayAfter: 0,
    payMode: "settle",
    body: { ok: true, source: "svm-provider" },
    payDelayMs: 0,
    receiptTransaction: undefined,
  };
  const seen: SvmUpstreamSeen = { challenges: 0, paid: [], verifyResults: [], settleResults: [], urls: [], connections: 0 };

  function acceptsOf(): Record<string, unknown>[] {
    if (state.accepts !== undefined) return state.accepts;
    const memo = state.memoMode === "none" ? {} : { memo: state.memoMode === "fixed" ? state.memo : `nonce-${randomBytes(8).toString("hex")}` };
    return [{ scheme: "exact", network: SVM_FIXTURE_NETWORK, asset: SVM_FIXTURE_MINT, amount: state.amount, payTo: state.payTo, maxTimeoutSeconds: 120, extra: { feePayer: state.feePayer, ...memo, ...state.extraFields } }];
  }

  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    const requestedUrl = `https://${request.headers.host ?? host}${request.url ?? "/"}`;
    seen.urls.push(requestedUrl);
    const signature = request.headers["payment-signature"];
    if (typeof signature !== "string") {
      seen.challenges += 1;
      const required = { x402Version: 2, error: "payment_required", resource: { url: requestedUrl }, accepts: acceptsOf(), ...state.topLevel };
      const sendChallenge = (): void => {
        response.writeHead(state.challengeStatus, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) });
        response.end(JSON.stringify({ x402Version: 2 }));
      };
      if (state.challengeDelayMs === 0 || seen.challenges <= state.challengeDelayAfter) sendChallenge();
      else setTimeout(sendChallenge, state.challengeDelayMs);
      return;
    }
    let payload: unknown;
    try {
      payload = decodePaymentSignatureHeader(signature);
    } catch {
      payload = undefined;
    }
    const inner = isRecord(payload) ? payload["payload"] : undefined;
    const transactionBase64 = isRecord(inner) && typeof inner["transaction"] === "string" ? inner["transaction"] : undefined;
    seen.paid.push({ payload, transactionBase64 });
    const accepted = isRecord(payload) ? payload["accepted"] : undefined;
    const network = isRecord(accepted) && typeof accepted["network"] === "string" ? accepted["network"] : SVM_FIXTURE_NETWORK;

    const reply = (status: number, receipt: Record<string, unknown> | undefined, body: string): void => {
      const send = (): void => {
        response.writeHead(status, { "content-type": "application/json", ...(receipt === undefined ? {} : { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt as never) }) });
        response.end(body);
      };
      if (state.payDelayMs === 0) send();
      else setTimeout(send, state.payDelayMs);
    };

    void (async () => {
      if (state.payMode === "status-500") return reply(500, undefined, JSON.stringify({ error: "upstream failure" }));
      if (state.payMode === "status-404") return reply(404, undefined, JSON.stringify({ error: "not found" }));
      if (state.payMode === "no-receipt-200") return reply(200, undefined, JSON.stringify(state.body));
      const requirements = accepted;
      let verify: { status: number; json: unknown };
      try {
        verify = await postFacilitator({ port: facilitator.port, host: facilitator.host, ca: tls.ca }, "/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
      } catch {
        return reply(500, undefined, JSON.stringify({ error: "facilitator unreachable" }));
      }
      seen.verifyResults.push(verify.json);
      const verified = isRecord(verify.json) && verify.json["isValid"] === true;
      if (!verified) return reply(402, undefined, JSON.stringify({ x402Version: 2, error: "invalid_payment", detail: verify.json }));
      if (state.payMode === "verify-only") return reply(402, undefined, JSON.stringify({ x402Version: 2, error: "verify_only" }));
      let settle: { status: number; json: unknown };
      try {
        settle = await postFacilitator({ port: facilitator.port, host: facilitator.host, ca: tls.ca }, "/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
      } catch {
        return reply(500, undefined, JSON.stringify({ error: "facilitator unreachable" }));
      }
      seen.settleResults.push(settle.json);
      if (state.payMode === "drop-after-settle") {
        request.socket.destroy();
        return;
      }
      const settled = isRecord(settle.json) ? settle.json : {};
      const success = settled["success"] === true;
      if (!success) return reply(402, undefined, JSON.stringify({ x402Version: 2, error: "settle_failed" }));
      const transaction = state.receiptTransaction ?? (typeof settled["transaction"] === "string" ? settled["transaction"] : "");
      const payer = state.payMode === "payer-mismatch" ? "So11111111111111111111111111111111111111112" : (typeof settled["payer"] === "string" ? settled["payer"] : undefined);
      const receipt: Record<string, unknown> = { success: true, transaction, network, ...(payer === undefined ? {} : { payer }) };
      if (state.payMode === "receipt-then-502") return reply(502, receipt, JSON.stringify({ error: "no data" }));
      if (state.payMode === "receipt-only") return reply(200, receipt, "");
      if (state.payMode === "receipt-then-reset") {
        // 整合した領収の 200 の headers と本文の一部を送り、接続を切る（本文の読み取りの失敗。タスク R-4）。
        response.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt as never) });
        response.write('{"ok":true,"pad":"');
        setTimeout(() => request.socket.destroy(), 20);
        return;
      }
      return reply(200, receipt, JSON.stringify(state.body));
    })();
  });
  server.on("secureConnection", () => {
    seen.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    host,
    state,
    seen,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
