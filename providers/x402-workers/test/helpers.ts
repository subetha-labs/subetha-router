/**
 * 試験の共通部品（Node の `Buffer` を使わない: 隔離した Linux の tsc には @types/node が無い）。
 * 売り手証明の期待値は**実装から import せず**ここに独立に書く（実装と試験が同じ誤りを共有しない）。
 */
import { address, appendTransactionMessageInstruction, compileTransactionMessage, createNoopSigner, createTransactionMessage, getBase58Decoder, getBase64Decoder, getCompiledTransactionMessageEncoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak256, recoverTypedDataAddress, toBytes } from "viem";

/** Router の `src/adapters/inbound/seller-proof.ts` と Circle の仕様から独立に写した期待値。 */
export const EXPECTED_PROOF = {
  domainName: "Circle Facilitator Seller Request",
  domainVersion: "1",
  chainId: 5042002,
  lifetimeSeconds: 60,
  envelopeVersion: 1,
  types: {
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
  },
} as const;

export function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function fromBase64(text: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
}

export interface ProofEnvelope {
  readonly version: number;
  readonly signature: `0x${string}`;
  readonly network: string;
  readonly payTo: `0x${string}`;
  readonly nonce: `0x${string}`;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export function decodeProof(header: string): ProofEnvelope {
  return JSON.parse(fromBase64Url(header)) as ProofEnvelope;
}

/** 封筒を Circle の検証と同じ手順で recover する（本文は**送られた文字列そのもの**）。 */
export async function recoverProof(envelope: ProofEnvelope, purpose: "verify" | "settle", bodyText: string): Promise<string> {
  const recovered = await recoverTypedDataAddress({
    domain: { name: EXPECTED_PROOF.domainName, version: EXPECTED_PROOF.domainVersion, chainId: EXPECTED_PROOF.chainId },
    types: EXPECTED_PROOF.types,
    primaryType: "SellerRequest",
    message: { purpose, method: "POST", bodyHash: keccak256(toBytes(bodyText)), network: envelope.network, payTo: envelope.payTo, nonce: envelope.nonce, issuedAt: BigInt(envelope.issuedAt), expiresAt: BigInt(envelope.expiresAt) },
    signature: envelope.signature,
  });
  return recovered.toLowerCase();
}

export const SOL_FEE_PAYER = "HTazrCcGEzWPKSKLFtbzszPJYTrFdD6xFHN4rLbwQng5";

/** authority（2 番目の static account）を持つ Solana の transaction（base64）。署名は空。 */
export function solanaTransaction(): { readonly transaction: string; readonly authority: string } {
  const authoritySeed = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
  const authority = getBase58Decoder().decode(ed25519.getPublicKey(authoritySeed));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(SOL_FEE_PAYER), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD" as never, lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstruction({ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: address(authority), role: 2, signer: createNoopSigner(address(authority)) } as never], data: new Uint8Array([1]) }, m),
  );
  const compiled = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
  const wire = getTransactionEncoder().encode({ messageBytes: compiled as never, signatures: { [SOL_FEE_PAYER]: null, [authority]: new Uint8Array(64) } as never });
  return { transaction: getBase64Decoder().decode(wire), authority };
}

export const SOL_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
