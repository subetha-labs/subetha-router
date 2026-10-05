/**
 * MPP（Tempo charge）用の**非署名**支払い spy。tests 専用で製品コードには置かない。
 *
 * - account は viem の `json-rpc` 種別（鍵を持たず、署名はウォレット＝ここでは stub RPC 側）。
 *   秘密鍵・実署名・実 broadcast・実 RPC は一切使わない。
 * - client は loopback の代替 RPC（`custom` transport）で、返すのは `synthetic-` と分かる合成値。
 *   実チェーンには接続しない。未知の RPC メソッドは記録して明示的に失敗させる（黙って成功させない）。
 */

import { createClient, custom, type Chain } from "viem";

import type { MppTempoCapability } from "../../src/ports/outbound.js";

/** Tempo testnet の公開 chain id（mainnet 4217 とは別物）。 */
export const TEMPO_TESTNET_CHAIN_ID = 42_431;

/** 公開 fixture のアドレス（実在ウォレットではない）。 */
export const SPY_PAYER_ADDRESS = "0x0000000000000000000000000000000000000B0b" as const;

export interface PayerSpy {
  readonly address: `0x${string}`;
  /** stub RPC が受けた `{method, params}`（何が呼ばれたかを実物で確認する）。 */
  readonly rpcCalls: { method: string; params: unknown }[];
  /** 送金系 RPC の到達回数（1 支払い 1 回であることを確認する）。 */
  sendAttempts(): number;
  /** 合成トランザクションハッシュ（実 broadcast の結果ではない）。 */
  readonly txHash: `0x${string}`;
  capability(overrides?: Partial<MppTempoCapability>): MppTempoCapability;
}

export interface PayerSpyOptions {
  /** 支払い能力に到達したら失敗させる（署名側へ届かせないテスト用）。 */
  readonly refuse?: boolean;
  /**
   * 最初の送金要求を**曖昧に**失敗させる（成否不明）。viem の内部 fallback が
   * 2 度目の送金へ進まないことを確認するために使う。
   */
  readonly ambiguousSend?: boolean;
  /**
   * 能力が**decorated な client**（walletClient のように `sendCalls` などの action closure を
   * 持つもの）を返す。closure は元の client を捕捉しているので、adapter が client を
   * そのまま渡すと `getAction` がそれを優先して送金 guard を迂回し得る。
   */
  readonly decorated?: boolean;
  readonly chainId?: number;
}

/** 送金を発生させ得る RPC（spy 側でも数える）。 */
const SEND_METHODS = new Set([
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_signTransaction",
  "wallet_sendCalls",
  "wallet_sendCallsSync",
  "wallet_sendTransaction",
]);

/** 試験用の Tempo チェーン定義（実 RPC URL を持たない）。HTTP の RPC fixture（`rpc-server.ts`）を使う能力も同じ chain を使う。 */
export const tempoTestnet = (chainId: number): Chain => ({
  id: chainId,
  name: "tempo-testnet-fixture",
  nativeCurrency: { name: "Fixture", symbol: "FIX", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1/synthetic-rpc"] } },
  testnet: true,
});

export function createPayerSpy(options: PayerSpyOptions = {}): PayerSpy {
  const chainId = options.chainId ?? TEMPO_TESTNET_CHAIN_ID;
  const rpcCalls: { method: string; params: unknown }[] = [];
  const txHash = `0x${"b0".repeat(32)}` as `0x${string}`;

  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    rpcCalls.push({ method, params });
    if (options.refuse === true) {
      throw new Error("payer spy refuses to authorize this payment");
    }
    if (options.ambiguousSend === true && SEND_METHODS.has(method)) {
      // 成否を断定できない失敗（viem はこの種のエラーで fallback 送金へ進み得る）。
      throw new Error("synthetic ambiguous rpc failure: outcome unknown");
    }
    switch (method) {
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "eth_accounts":
        return [SPY_PAYER_ADDRESS];
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
          receipts: [
            {
              status: "0x1",
              blockHash: `0x${"11".repeat(32)}`,
              blockNumber: "0x1",
              gasUsed: "0x1",
              logs: [],
              transactionHash: txHash,
            },
          ],
        };
      default:
        // 何が足りないのかテストで分かるように、メソッド名を出して明示的に失敗する。
        throw new Error(`synthetic rpc has no stub for ${method}`);
    }
  };

  const client = createClient({ chain: tempoTestnet(chainId), transport: custom({ request }) });

  /**
   * decorated な client。`sendCalls` は**元の（guard されていない）client**を捕捉している。
   * 実 wallet client と同じ形で、guard の迂回経路があるかを確認するために使う。
   */
  const decoratedClient = client.extend((base) => ({
    async sendCalls(parameters: { calls?: unknown }) {
      return base.request({
        method: "wallet_sendCalls",
        params: [{ calls: parameters.calls }],
      } as never);
    },
    async sendTransaction(parameters: unknown) {
      return base.request({ method: "eth_sendTransaction", params: [parameters] } as never);
    },
  }));

  return {
    address: SPY_PAYER_ADDRESS,
    rpcCalls,
    sendAttempts: () => rpcCalls.filter((call) => SEND_METHODS.has(call.method)).length,
    txHash,
    capability(overrides: Partial<MppTempoCapability> = {}): MppTempoCapability {
      return {
        chainId,
        // 鍵を持たない json-rpc account（署名はウォレット＝ここでは stub RPC が受ける）。
        account: { address: SPY_PAYER_ADDRESS, type: "json-rpc" },
        getClient: () => (options.decorated === true ? decoratedClient : client),
        mode: "push",
        kind: "non-signing-fixture",
        ...overrides,
      };
    },
  };
}
