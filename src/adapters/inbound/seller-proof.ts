/**
 * Circle の facilitator の売り手証明（`Facilitator-Seller-Proof`。multirail 設計 §3・§4.2、要件 FR-12・FR-13）。
 *
 * 仕様（Circle の "Seller Proof Specification"、2026-10-06 に読んだもの）:
 * - EIP-712 domain `{ name: "Circle Facilitator Seller Request", version: "1", chainId }`（verifyingContract 無し）
 * - 型 `SellerRequest { purpose: string, method: string, bodyHash: bytes32, network: string, payTo: address, nonce: bytes32, issuedAt: uint64, expiresAt: uint64 }`
 * - `bodyHash = keccak256(body)`、`issuedAt` は現在＋30 秒以内、`expiresAt` は現在より後かつ `issuedAt`＋5 分以内、nonce は `(network, payTo, purpose)` で一意
 * - header は base64url の JSON 封筒 `{ version, signature, network, payTo, nonce, issuedAt, expiresAt }`
 *
 * この module は**鍵を持たない**。署名は注入された closure（`signSellerRequest`）が行い、能力はその closure に
 * **自分で組んだ `SellerRequest` だけ**を渡す。別の typed data を渡す口は無い。
 */

import { randomBytes } from "node:crypto";

import { keccak256, toBytes, type Hex, type TypedDataDomain } from "viem";

import { evmChainIdOf } from "../../config.js";
import type { SellerProofCapability, SellerProofPurpose } from "../../ports/inbound.js";

export const SELLER_PROOF_DOMAIN_NAME = "Circle Facilitator Seller Request";
export const SELLER_PROOF_DOMAIN_VERSION = "1";
/** 封筒の `version`。仕様の例に合わせる（実機の確認は T6）。 */
export const SELLER_PROOF_ENVELOPE_VERSION = 1;
/** Router が発行する証明の寿命（設計 §3）。Circle の上限 300 秒の内側に固定し、設定では変えない。 */
export const SELLER_PROOF_LIFETIME_SECONDS = 60;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** 署名の型。**深く凍結**して closure に渡す（`as const` は実行時には何も守らない）。 */
export const SELLER_REQUEST_TYPES = deepFreeze({
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
} as const);

export interface SellerRequestMessage {
  readonly purpose: SellerProofPurpose;
  readonly method: "POST";
  readonly bodyHash: Hex;
  readonly network: string;
  readonly payTo: Hex;
  readonly nonce: Hex;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

/** 署名する typed data（能力が組む。closure はこれ以外を受け取らない）。 */
export interface SellerRequestTypedData {
  readonly domain: TypedDataDomain & { readonly chainId: number };
  readonly types: typeof SELLER_REQUEST_TYPES;
  readonly primaryType: "SellerRequest";
  readonly message: SellerRequestMessage;
}

export function sellerProofDomainOf(chainId: number): TypedDataDomain & { readonly chainId: number } {
  return Object.freeze({ name: SELLER_PROOF_DOMAIN_NAME, version: SELLER_PROOF_DOMAIN_VERSION, chainId });
}

/** 要求本体の hash。**送る bytes そのもの**から計算する（直列化は 1 度だけ）。 */
export function bodyHashOf(bodyText: string): Hex {
  return keccak256(toBytes(bodyText));
}

export interface SellerProofEnvelope {
  readonly version: number;
  readonly signature: Hex;
  readonly network: string;
  readonly payTo: Hex;
  readonly nonce: Hex;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export function encodeSellerProofHeader(envelope: SellerProofEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

/** header を読む（試験の fixture 用。形が違えば `undefined`）。 */
export function decodeSellerProofHeader(header: string): SellerProofEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const { version, signature, network, payTo, nonce, issuedAt, expiresAt } = record;
  if (
    typeof version !== "number" ||
    typeof signature !== "string" ||
    typeof network !== "string" ||
    typeof payTo !== "string" ||
    typeof nonce !== "string" ||
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number"
  ) {
    return undefined;
  }
  return { version, signature: signature as Hex, network, payTo: payTo as Hex, nonce: nonce as Hex, issuedAt, expiresAt };
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PURPOSES: readonly SellerProofPurpose[] = ["verify", "settle"];

export interface SellerProofCapabilityOptions {
  /** 束縛する network（`eip155:<id>`。chainId は内部で引く）。 */
  readonly network: string;
  /** 受取先 = 署名する鍵のアドレス。 */
  readonly address: string;
  /**
   * 署名の closure。**この能力が組んだ `SellerRequest` の typed data だけ**を受け取る。
   * 起動側は `privateKeyToAccount(key).signTypedData` を包んで渡す（鍵は `src/` に渡らない）。
   */
  readonly signSellerRequest: (typedData: SellerRequestTypedData) => Promise<Hex>;
  /** 時計（作るときに注入。adapter からは渡せない）。 */
  readonly now?: () => number;
  /** nonce の乱数（試験の差し替え用。既定は CSPRNG）。 */
  readonly randomNonce?: () => Uint8Array;
}

/**
 * 売り手証明の能力を組む。purpose は列挙、method は `POST`、network・payTo は固定、時刻と nonce は内部で決める。
 */
export function createSellerProofCapability(options: SellerProofCapabilityOptions): SellerProofCapability {
  // 設定は**作るときに写す**（呼び出し側が options を後から変えても署名の内容は変わらない）。
  const network = String(options.network);
  const chainId = evmChainIdOf(network);
  if (chainId === undefined) {
    throw new Error("seller proof capability requires an eip155 network");
  }
  if (typeof options.address !== "string" || !ADDRESS_PATTERN.test(options.address)) {
    throw new Error("seller proof capability requires a 0x address");
  }
  const address = options.address as Hex;
  const signSellerRequest = options.signSellerRequest;
  const now = options.now ?? Date.now;
  const randomNonce = options.randomNonce ?? ((): Uint8Array => new Uint8Array(randomBytes(32)));
  const domain = sellerProofDomainOf(chainId);
  const lifetime = SELLER_PROOF_LIFETIME_SECONDS;

  const capability: SellerProofCapability = {
    network,
    address,
    async proofFor(purpose: SellerProofPurpose, bodyHash: string): Promise<string> {
      if (!PURPOSES.includes(purpose)) {
        throw new Error("seller proof: unknown purpose");
      }
      if (typeof bodyHash !== "string" || !HASH_PATTERN.test(bodyHash)) {
        throw new Error("seller proof: bodyHash must be a 32-byte hex");
      }
      const nonceBytes = randomNonce();
      if (nonceBytes.length !== 32) {
        throw new Error("seller proof: nonce must be 32 bytes");
      }
      const nonce = `0x${Buffer.from(nonceBytes).toString("hex")}` as Hex;
      const issuedAt = Math.floor(now() / 1000);
      const expiresAt = issuedAt + lifetime;
      if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
        throw new Error("seller proof: clock is not usable");
      }
      const message: SellerRequestMessage = Object.freeze({
        purpose,
        method: "POST",
        bodyHash: bodyHash as Hex,
        network,
        payTo: address,
        nonce,
        issuedAt: BigInt(issuedAt),
        expiresAt: BigInt(expiresAt),
      });
      const signature = await signSellerRequest(Object.freeze({ domain, types: SELLER_REQUEST_TYPES, primaryType: "SellerRequest", message }));
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error("seller proof: signer returned a malformed signature");
      }
      return encodeSellerProofHeader({
        version: SELLER_PROOF_ENVELOPE_VERSION,
        signature,
        network,
        payTo: address,
        nonce,
        issuedAt,
        expiresAt,
      });
    },
  };
  return Object.freeze(capability);
}
