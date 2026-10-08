/**
 * Circle の売り手証明（`Facilitator-Seller-Proof`）。Router の `src/adapters/inbound/seller-proof.ts` の純粋な部分の写し
 * （`docs/provider-x402-workers.md` §3.2。Router と同じ型・domain・寿命・封筒）。Workers 向けに nonce は `crypto.getRandomValues`、
 * 署名は呼び出し側が closure で渡す（鍵はこの module に入らない）。
 */
import { keccak256, toBytes, type Hex, type TypedDataDomain } from "viem";

export const SELLER_PROOF_DOMAIN_NAME = "Circle Facilitator Seller Request";
export const SELLER_PROOF_DOMAIN_VERSION = "1";
export const SELLER_PROOF_ENVELOPE_VERSION = 1;
export const SELLER_PROOF_LIFETIME_SECONDS = 60;

export const SELLER_REQUEST_TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export type SellerProofPurpose = "verify" | "settle";

export interface SellerRequestTypedData {
  readonly domain: TypedDataDomain & { readonly chainId: number };
  readonly types: typeof SELLER_REQUEST_TYPES;
  readonly primaryType: "SellerRequest";
  readonly message: {
    readonly purpose: SellerProofPurpose;
    readonly method: "POST";
    readonly bodyHash: Hex;
    readonly network: string;
    readonly payTo: Hex;
    readonly nonce: Hex;
    readonly issuedAt: bigint;
    readonly expiresAt: bigint;
  };
}

export function bodyHashOf(bodyText: string): Hex {
  return keccak256(toBytes(bodyText));
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export interface SellerProofSigner {
  readonly network: string;
  readonly chainId: number;
  readonly address: Hex;
  readonly signTypedData: (typedData: SellerRequestTypedData) => Promise<Hex>;
  readonly now?: () => number;
  readonly randomNonce?: () => Uint8Array;
}

/** `Facilitator-Seller-Proof` の値（base64url の封筒）。`bodyHash` は送る本文そのものの keccak256。 */
export async function sellerProofFor(signer: SellerProofSigner, purpose: SellerProofPurpose, bodyText: string): Promise<string> {
  const now = signer.now ?? Date.now;
  const nonceBytes = signer.randomNonce === undefined ? crypto.getRandomValues(new Uint8Array(32)) : signer.randomNonce();
  if (nonceBytes.length !== 32) throw new Error("seller proof: nonce must be 32 bytes");
  const issuedAt = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("seller proof: clock is not usable");
  const expiresAt = issuedAt + SELLER_PROOF_LIFETIME_SECONDS;
  const nonce = hex(nonceBytes);
  const typedData: SellerRequestTypedData = {
    domain: { name: SELLER_PROOF_DOMAIN_NAME, version: SELLER_PROOF_DOMAIN_VERSION, chainId: signer.chainId },
    types: SELLER_REQUEST_TYPES,
    primaryType: "SellerRequest",
    message: { purpose, method: "POST", bodyHash: bodyHashOf(bodyText), network: signer.network, payTo: signer.address, nonce, issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt) },
  };
  const signature = await signer.signTypedData(typedData);
  return toBase64Url(JSON.stringify({ version: SELLER_PROOF_ENVELOPE_VERSION, signature, network: signer.network, payTo: signer.address, nonce, issuedAt, expiresAt }));
}
