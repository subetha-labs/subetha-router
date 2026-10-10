/**
 * 実鍵による MPP / Tempo 支払い能力（`kind: "real-key"`）。**製品コードではない。**
 *
 * レール A（x402）との決定的な違い: **payer 自身がチェーンへ broadcast する**。
 * A では facilitator が送信し gas も負担するので payer は署名するだけだが、
 * B では `getClient` が返す client に**実 RPC と送金権限**が要る。
 * したがって payer には pathUSD（支払い額 + チェーン手数料。手数料も pathUSD 建て）が必要。
 *
 * **送金が有料 GET より前に起きる**ため「送金済み・データ未取得」が現実に起こりうる。
 * その場合は adapter 側が `unknown` として保持し、**勝手に settled と言わない／再送しない**。
 *
 * RPC は差し替え可能にしてある（既定は公開 RPC）。Cloudflare のような共有 egress IP から
 * 公開 Tempo RPC を叩くとレート制限されることが報告されているため、
 * 認証付き RPC を使う場合は `rpcUrl` を渡す。
 *
 * 秘密鍵は引数で受け取り、ログ・エラー・戻り値に出さない。
 */

import { tempo as tempoMainnet } from "viem/tempo/chains";
import { createWalletClient, http, publicActions, type Client } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { MppTempoCapability } from "../src/ports/outbound.js";

export const TEMPO_MODERATO_CHAIN_ID = 42431;
export const TEMPO_MODERATO_RPC = "https://rpc.moderato.tempo.xyz";

export interface RealMppCapability {
  readonly address: `0x${string}`;
  /** `getClient` が呼ばれた回数（能力への到達確認用）。 */
  readonly clientCount: () => number;
  capability(): MppTempoCapability;
}

/** chain ごとの公開 RPC の既定（mainnet は viem の `tempo` の定義から。`docs/mainnet-first-route.md` FR-M3）。 */
export function defaultTempoRpcUrl(chainId: number): string {
  if (chainId === tempoMainnet.id) return tempoMainnet.rpcUrls.default.http[0]!;
  return TEMPO_MODERATO_RPC;
}

export function createRealMppCapability(
  privateKey: string,
  options: { readonly rpcUrl?: string; readonly chainId?: number } = {},
): RealMppCapability {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    // 鍵の内容をメッセージに出さない。
    throw new Error("payer private key must be a 0x-prefixed 32-byte hex string");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const chainId = options.chainId ?? TEMPO_MODERATO_CHAIN_ID;
  const rpcUrl = options.rpcUrl ?? defaultTempoRpcUrl(chainId);
  let clients = 0;

  return {
    address: account.address,
    clientCount: () => clients,
    capability(): MppTempoCapability {
      return {
        chainId,
        account,
        getClient: (parameters: { chainId?: number | undefined }): Client => {
          clients += 1;
          // 想定外のチェーンには接続しない（testnet / mainnet の取り違えを防ぐ）。
          if (parameters.chainId !== undefined && parameters.chainId !== chainId) {
            throw new Error(`refusing to build a client for chain ${parameters.chainId}`);
          }
          // 送金系 RPC の 1 支払い 1 回制限は adapter 側の wrapper が掛ける。
          return createWalletClient({
            account,
            transport: http(rpcUrl, { retryCount: 0 }),
          }).extend(publicActions) as unknown as Client;
        },
        // 明示 push（省略すると SDK 側の選択に委ねられ pull が選ばれ得る。未検証経路を踏まない）。
        mode: "push",
        kind: "real-key",
      };
    },
  };
}
