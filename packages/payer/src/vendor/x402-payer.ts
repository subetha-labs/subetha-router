/**
 * **payer 側**の x402 資格情報の組み立て（EIP-3009 `TransferWithAuthorization`）。
 * **製品コードではない。** Router は payee なので、これは「Router に払う側」の実装。
 *
 * EIP-712 domain は **Router が発行した `offer.extra` から読む**（勝手に決めない）。
 * facilitator は `requirements.extra` の `name` / `version` から domain を再構成するため、
 * ここがずれると `invalid_exact_evm_missing_eip712_domain` で拒否される（親が実測）。
 *
 * 秘密鍵は引数で受け取り、戻り値・ログには出さない。
 */

import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Router が発行した受信 offer のうち、payer が使う部分。 */
export interface InboundOfferView {
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly extra: {
    readonly challengeNonce: string;
    readonly expiresAt: number;
    readonly name?: unknown;
    readonly version?: unknown;
  } & Record<string, unknown>;
}

export interface X402Payer {
  readonly address: `0x${string}`;
  /** 承認済み offer に対する `X-Payment` 値（base64）を作る。 */
  credentialFor(offer: InboundOfferView, chainId: number): Promise<string>;
}

export function createX402Payer(privateKey: string): X402Payer {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("payer private key must be a 0x-prefixed 32-byte hex string");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  return {
    address: account.address,
    async credentialFor(offer: InboundOfferView, chainId: number): Promise<string> {
      const name = offer.extra.name;
      const version = offer.extra.version;
      if (typeof name !== "string" || typeof version !== "string") {
        // domain が無い offer には署名しない（facilitator が再構成できない）。
        throw new Error("issued offer is missing the EIP-712 domain (extra.name / extra.version)");
      }
      const validBefore = offer.extra.expiresAt;
      const authorization = {
        from: getAddress(account.address),
        to: getAddress(offer.payTo),
        value: BigInt(offer.amount),
        validAfter: 0n,
        validBefore: BigInt(validBefore),
        // 1 offer = 1 authorization。Router の challengeNonce をそのまま bytes32 nonce に使う。
        nonce: offer.extra.challengeNonce as `0x${string}`,
      };
      const signature = await account.signTypedData({
        domain: {
          name,
          version,
          chainId,
          verifyingContract: getAddress(offer.asset),
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: authorization,
      });
      const credential = {
        x402Version: 2,
        accepted: offer,
        payload: {
          challengeNonce: offer.extra.challengeNonce,
          signature,
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: "0",
            validBefore: String(validBefore),
            nonce: authorization.nonce,
          },
        },
      };
      return Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
    },
  };
}
