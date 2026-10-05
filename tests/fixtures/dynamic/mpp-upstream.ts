/**
 * 動的上流 URL の試験用の MPP 上流（TLS、プロセス内）。**試験基盤であり製品の Provider ではない。**
 *
 * **実 `mppx/server`** が challenge を発行し、提出された credential を**実際に検証する**
 * （送金の receipt は `tempo-rpc.ts` の fixture から読む）。だから「正しい支払いは通り、別の支払いは通らない」を
 * チェーンなしで確かめられる。既存の `mpp-upstream.ts`（HTTP・1 本の URL・scope つき）は静的経路用。
 *
 * 任意のパスとクエリを受ける。scope（`_mppx_scope`）は既定で**付けない**（第三者の Provider の形）。
 */
import https from "node:https";
import type { AddressInfo } from "node:net";

import { Challenge, Constants, Credential, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { createClient, http as viemHttp } from "viem";
import { tempoModerato } from "viem/tempo/chains";

import type { TlsMaterial } from "../tls/generate.js";

export const MPP_FIXTURE_RECIPIENT = "0x0000000000000000000000000000000000000b22";
export const MPP_FIXTURE_CURRENCY = "0x20c0000000000000000000000000000000000000";
export const MPP_FIXTURE_CHAIN_ID = 42_431;

export interface MppUpstreamState {
  amount: string;
  /** challenge の `request` に足す・上書きする欄（範囲外の challenge を作る試験用）。発行後の challenge に手を入れる。 */
  mutateChallenge: ((challenge: Record<string, unknown>, requestedUrl: string) => Record<string, unknown>) | undefined;
  /** 本物の challenge の**前に**並べる challenge（1 つのヘッダに複数の challenge を返す上流の形）。 */
  prependChallenges: ((requestedUrl: string) => Record<string, unknown>[]) | undefined;
  /** scope を付けるか。`"match"` は要求された URL、文字列ならその値。 */
  scope: "none" | "match" | string;
  /** 成功時の本文と content type。 */
  body: string;
  contentType: string;
  /** 検証を通った後の応答を差し替える（receipt を付けない・別の receipt を付ける等）。 */
  afterVerify: ((receipt: unknown) => { status: number; headers: Record<string, string>; body: string }) | undefined;
  /** 支払いつきの要求への応答を返すまでの待ち（ミリ秒）。 */
  delayMs: number;
}

export interface MppUpstream {
  readonly port: number;
  readonly host: string;
  readonly realm: string;
  readonly state: MppUpstreamState;
  readonly seen: { challenges: number; credentials: number; verified: number; rejected: number; urls: string[] };
  close(): Promise<void>;
}

export async function startMppUpstream(tls: TlsMaterial, rpcUrl: string, host = "provider.test"): Promise<MppUpstream> {
  const realm = "dynamic-mpp-fixture";
  const seen = { challenges: 0, credentials: 0, verified: 0, rejected: 0, urls: [] as string[] };
  const state: MppUpstreamState = { amount: "1000", mutateChallenge: undefined, prependChallenges: undefined, scope: "none", body: JSON.stringify({ ok: true }), contentType: "application/json", afterVerify: undefined, delayMs: 0 };
  const client = createClient({ chain: { ...tempoModerato, id: MPP_FIXTURE_CHAIN_ID } as never, transport: viemHttp(rpcUrl, { retryCount: 0 }) });
  const mppx = Mppx.create({
    secretKey: "fixture-secret-0123456789abcdef0123456789abcdef",
    realm,
    methods: [tempo.charge({ recipient: MPP_FIXTURE_RECIPIENT, currency: MPP_FIXTURE_CURRENCY, decimals: 0, getClient: () => client as never } as never)],
  });
  const api = mppx as unknown as {
    challenge: { tempo: { charge(parameters: Record<string, unknown>): Promise<Record<string, unknown>> } };
    broadcastCredential(wire: string, options?: Record<string, unknown>): Promise<unknown>;
  };

  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    void (async () => {
      const requestedUrl = `https://${request.headers.host ?? host}${request.url ?? "/"}`;
      seen.urls.push(requestedUrl);
      const authorization = request.headers["authorization"];
      const send = (status: number, headers: Record<string, string>, body: string): void => {
        response.writeHead(status, headers);
        response.end(body);
      };
      if (typeof authorization !== "string") {
        seen.challenges += 1;
        const scope = state.scope === "none" ? undefined : state.scope === "match" ? `GET ${requestedUrl}` : state.scope;
        let challenge = await api.challenge.tempo.charge({
          amount: state.amount,
          chainId: MPP_FIXTURE_CHAIN_ID,
          expires: new Date(Date.now() + 600_000).toISOString(),
          ...(scope === undefined ? {} : { scope, meta: { _mppx_scope: scope } }),
        });
        if (state.mutateChallenge !== undefined) challenge = state.mutateChallenge(challenge, requestedUrl);
        const all = [...(state.prependChallenges?.(requestedUrl) ?? []), challenge];
        send(402, { "content-type": "application/problem+json", "www-authenticate": all.map((each) => Challenge.serialize(each as never)).join(", ") }, JSON.stringify({ title: "Payment Required", status: 402 }));
        return;
      }
      seen.credentials += 1;
      let receipt: unknown;
      try {
        /**
         * `broadcastCredential` は、提出された credential の中の challenge だけを検証し、**今の要求と合うか**は見ない
         * （実物の middleware は現在の route の条件と突き合わせる）。ここで同じことをする: 額がこの上流の現在の額と同じこと、
         * scope を付けているなら、この要求の URL のものであること。
         */
        const submitted = Credential.deserialize(authorization).challenge as unknown as { request?: { amount?: unknown }; opaque?: unknown };
        if (submitted.request?.amount !== state.amount) throw new Error("amount is not the current price");
        if (state.scope !== "none") {
          const expected = state.scope === "match" ? `GET ${requestedUrl}` : state.scope;
          const meta = typeof submitted.opaque === "string" ? (JSON.parse(Buffer.from(submitted.opaque, "base64url").toString("utf8")) as Record<string, unknown>) : (submitted.opaque as Record<string, unknown> | undefined);
          if (meta?.["_mppx_scope"] !== expected) throw new Error("scope is not this resource");
        }
        // 実 SDK の検証（challenge の HMAC、receipt のログ、memo の束縛、hash の使い回し）。
        receipt = await api.broadcastCredential(authorization);
      } catch {
        seen.rejected += 1;
        send(402, { "content-type": "application/problem+json" }, JSON.stringify({ title: "Verification Failed", status: 402 }));
        return;
      }
      seen.verified += 1;
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.afterVerify !== undefined) {
        const reply = state.afterVerify(receipt);
        send(reply.status, reply.headers, reply.body);
        return;
      }
      send(200, { "content-type": state.contentType, [Constants.Headers.paymentReceipt]: Receipt.serialize(receipt as never) }, state.body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    host,
    realm,
    state,
    seen,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
