/**
 * **署名しない**試験用 signer spy（`ClientEvmSigner` 形）。
 * 秘密鍵も暗号署名も持たず、返すのは `0x` + 固定の合成バイト列で、実署名ではない。
 * 公開 fixture のアドレス以外は使わず、実ウォレット・実資産・実決済には一切触れない。
 *
 * 目的は「実 SDK（`@x402/evm` の `ExactEvmScheme`）を本物として通しつつ、署名境界だけを
 * 観測可能な非署名 spy に置き換える」こと。製品コードには置かない（tests 専用）。
 */

import type { EvmSigningCapability } from "../../src/ports/outbound.js";

export interface SignerSpy {
  readonly address: `0x${string}`;
  /** 実 SDK から渡された typed data（承認値との一致を検証するために保持する）。 */
  readonly calls: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }[];
  capability(network: string): EvmSigningCapability;
}

/** 既定の固定アドレスは公開 fixture 値（実在ウォレットではない）。 */
export function createSignerSpy(
  address: `0x${string}` = "0x0000000000000000000000000000000000000501",
): SignerSpy {
  const calls: SignerSpy["calls"] = [];
  const signer = {
    address,
    async signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      calls.push(message);
      // 暗号署名ではない固定の合成値。実決済の証拠にならないことが値から読み取れる形にする。
      return `0x${"5e".repeat(65)}` as `0x${string}`;
    },
  };
  return {
    address,
    calls,
    capability(network: string): EvmSigningCapability {
      return { network, signer, kind: "non-signing-fixture" };
    },
  };
}

/** 署名側に一切到達してはいけない場合に使う spy（呼ばれたら失敗させる）。 */
export function createForbiddenSignerSpy(
  address: `0x${string}` = "0x0000000000000000000000000000000000000502",
): SignerSpy {
  const spy = createSignerSpy(address);
  const signer = {
    address,
    async signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      spy.calls.push(message);
      throw new Error("signer must not be reached");
    },
  };
  return {
    address,
    calls: spy.calls,
    capability(network: string): EvmSigningCapability {
      return { network, signer, kind: "non-signing-fixture" };
    },
  };
}
