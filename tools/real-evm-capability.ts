/**
 * 実鍵による EVM 署名能力（`kind: "real-key"`）。**製品コードではない。**
 *
 * 設計 §4.2 / `docs/design.md:183` のとおり、署名能力は**起動時にコードから注入**するものだけを使い、
 * 製品コード（`src/**`）はこれを持たない。ここは実行者が明示的に起動するツール側に閉じている。
 *
 * この能力は **EIP-3009 の typed data に署名するだけ**で、チェーンへは接続しない
 * （ブロードキャストと gas 負担は x402 facilitator 側）。RPC も送金も行わない。
 *
 * 秘密鍵は**引数で受け取り、ログ・エラー・戻り値に出さない**。
 */

import { privateKeyToAccount } from "viem/accounts";

import type { EvmSigningCapability } from "../src/ports/outbound.js";

export interface RealCapability {
  readonly address: `0x${string}`;
  /** 署名が呼ばれた回数（承認 1 件につき 1 回であることの確認用）。 */
  readonly signCount: () => number;
  capability(network: string): EvmSigningCapability;
}

/**
 * `T7_PAYER_PRIVATE_KEY` 形式の 0x 秘密鍵から能力を作る。
 * **鍵そのものは保持しない**（`privateKeyToAccount` に渡した account だけを持つ）。
 */
export function createRealEvmCapability(privateKey: string): RealCapability {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    // 鍵の内容をメッセージに出さない。
    throw new Error("payer private key must be a 0x-prefixed 32-byte hex string");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  let signs = 0;

  const signer = {
    address: account.address,
    async signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      signs += 1;
      // guarded signer（`src/adapters/outbound/x402.ts`）が承認値と照合したあとにだけ到達する。
      // ここではチェーンに触れず、typed data に署名するだけ。
      return await account.signTypedData(message as never);
    },
  };

  return {
    address: account.address,
    signCount: () => signs,
    capability(network: string): EvmSigningCapability {
      return { network, signer, kind: "real-key" };
    },
  };
}
