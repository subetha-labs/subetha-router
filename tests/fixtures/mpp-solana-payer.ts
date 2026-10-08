/**
 * MPP Solana の試験用 payer（`docs/mpp-solana-design.md` §8.1、タスク M3-a）: **本物の `@solana/pay-kit` の client**（参照実装）で credential を作る。
 * Router が発行した offer（`extra.challenge` = mppx 0.11.0 が serialize した challenge）を 402 で返す loopback の http server を立て、
 * pay-kit の client に払わせて `Authorization: Payment …` を捕まえる。
 *
 * - `transaction` 型（pay-kit の client の既定）: client は署名だけで送出しない
 * - `signature` 型: pay-kit の公開の client に `broadcast` の口は無いので、同じ transaction を**この fixture が** RPC の fixture に送出し、mppx 0.11.0 の
 *   `Credential.serialize` で `type: "signature"` に包み直す（wire の形は 0.11.0。pay-kit の server がこれを受けることは `mpp-solana-fixtures.test.ts` が確かめる）
 *
 * 鍵は毎回の乱数（pay-kit の `Signer.generate()`）。chain には出ない（RPC は fixture）。**テスト基盤であり製品の道具ではない。**
 */
import http from "node:http";

import { Signer } from "@solana/pay-kit";
import { createPayKitClient } from "@solana/pay-kit/client";
import { Credential } from "mppx";

import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";

export interface MppSolanaTestPayer {
  readonly address: string;
  /** offer に対する Router の封筒。`mode` の既定は pay-kit の client の既定（`transaction`）。 */
  credentialFor(offer: InboundOffer, mode?: "transaction" | "signature"): Promise<PaymentCredential>;
  /** 直近の pay-kit の wire（`Authorization` の値）。 */
  readonly lastWire: () => string | undefined;
  close(): Promise<void>;
}

/** pay-kit の credential（wire）から transaction の base64 を取り出す。 */
export function transactionOfWire(wire: string): string {
  const payload = Credential.deserialize(wire).payload as { type?: unknown; transaction?: unknown };
  if (payload.type !== "transaction" || typeof payload.transaction !== "string") throw new Error("the wire is not a transaction-type credential");
  return payload.transaction;
}

export async function createMppSolanaTestPayer(options: { readonly rpcUrl: string }): Promise<MppSolanaTestPayer> {
  const payKitSigner = await Signer.generate();
  const signer = payKitSigner.signer as unknown as Parameters<typeof createPayKitClient>[0]["signer"];
  const client = await createPayKitClient({ signer, rpcUrl: options.rpcUrl, network: "devnet", accept: ["mpp"] });
  let lastWire: string | undefined;
  let challengeHeader = "";
  const server = http.createServer((request, response) => {
    const authorization = request.headers["authorization"];
    if (typeof authorization === "string" && authorization !== "") {
      lastWire = authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(402, { "content-type": "application/json", "www-authenticate": challengeHeader });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;

  async function broadcast(base64: string): Promise<string> {
    const response = await fetch(options.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [base64, { encoding: "base64", skipPreflight: false }] }) });
    const json = (await response.json()) as { result?: unknown; error?: unknown };
    if (typeof json.result !== "string") throw new Error("fixture RPC did not return a signature");
    return json.result;
  }

  return {
    address: String(signer.address),
    lastWire: () => lastWire,
    async credentialFor(offer, mode = "transaction") {
      const serialized = offer.extra["challenge"];
      if (typeof serialized !== "string" || serialized === "") throw new Error("the offer carries no serialized challenge");
      challengeHeader = serialized;
      lastWire = undefined;
      const response = await client.fetch(`${base}/paid`, { method: "GET" }, "mpp");
      // `lastWire` は server の callback が書く（TS の代入の絞り込みを外して読む）。
      const captured = (lastWire as string | undefined) ?? undefined;
      if (response.status !== 200 || captured === undefined) throw new Error(`pay-kit client did not pay (status ${response.status})`);
      let wire: string = captured;
      if (mode === "signature") {
        const decoded = Credential.deserialize(wire);
        const signature = await broadcast(transactionOfWire(wire));
        wire = Credential.serialize({ ...decoded, payload: { type: "signature", signature } } as never);
      }
      return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, credential: wire } };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
