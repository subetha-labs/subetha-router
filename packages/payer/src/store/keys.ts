/**
 * 鍵の store（設計 §3.3、要件 FR-A10・SR-A1）。
 *
 * - `keys.json`: `{ version: 1, kdf: { name: "scrypt", N: 131072, r: 8, p: 1, salt }, verifier, wallets: { eip155: { address, cipher: "aes-256-gcm", iv, tag, ciphertext } } }`
 * - `master = scrypt(passphrase, salt, 32)`。用途別の鍵は HKDF-SHA256: `kek`（秘密鍵の封）、`lek`（台帳の封印・install の seal）、`verifier`（照合の 16 バイト）。
 * - passphrase は**どこにも保存しない**。改行は含められない（確認 UI の 3 行の形のため）。`Buffer` は使い終えたら `fill(0)`。
 * - 外部パッケージに依存しない（`node:crypto` だけ）。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { StoreError } from "./fs.js";

export const KEYS_VERSION = 1;
export interface ScryptParams {
  readonly name: string;
  readonly N: number;
  readonly r: number;
  readonly p: number;
}
/** N=2^17, r=8, p=1: この Mac で約 200 ms（設計 §1 U-A6）。store に記録するので将来上げられる。 */
export const SCRYPT_PARAMS: ScryptParams = Object.freeze({ name: "scrypt", N: 131_072, r: 8, p: 1 });
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const HKDF_INFO = { kek: "subetha-payer/kek/v1", lek: "subetha-payer/ledger/v1", verify: "subetha-payer/verify/v1" } as const;

export interface SealedBox {
  readonly cipher: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface WalletEntry extends SealedBox {
  /** 公開のアドレス（秘密ではない。CLI と UI が表示する）。 */
  readonly address: string;
}

export interface KeysDocument {
  readonly version: number;
  readonly kdf: { readonly name: string; readonly N: number; readonly r: number; readonly p: number; readonly salt: string };
  readonly verifier: string;
  readonly wallets: Readonly<Record<string, WalletEntry>>;
}

export interface Subkeys {
  readonly kek: Buffer;
  readonly lek: Buffer;
  readonly verifier: Buffer;
}

export function isValidPassphrase(passphrase: string): boolean {
  return passphrase.length >= 8 && passphrase.length <= 256 && !/[\r\n]/.test(passphrase);
}

/** `master = scrypt(passphrase, salt, 32)`。passphrase の Buffer は呼び出し側が zero fill する。 */
export function deriveMaster(passphrase: Buffer, salt: Buffer, params: ScryptParams = SCRYPT_PARAMS): Buffer {
  return scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
}

export function subkeysOf(master: Buffer): Subkeys {
  const kek = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), HKDF_INFO.kek, 32));
  const lek = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), HKDF_INFO.lek, 32));
  const verifier = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), HKDF_INFO.verify, 32)).subarray(0, 16);
  return { kek, lek, verifier: Buffer.from(verifier) };
}

const RAIL_PATTERN = /^[a-z0-9]{1,16}$/;
const ADDRESS_PATTERN = /^[0-9A-Za-z]{1,64}$/;
const B64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function seal(key: Buffer, plaintext: Buffer, aad: string): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { cipher: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

/** 復号。tag が合わなければ `StoreError("seal_mismatch")`（中身は返さない）。 */
export function open(key: Buffer, box: SealedBox, aad: string): Buffer {
  if (box.cipher !== "aes-256-gcm") throw new StoreError("seal_unsupported");
  const iv = Buffer.from(box.iv, "base64");
  const tag = Buffer.from(box.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16 || !B64_PATTERN.test(box.iv) || !B64_PATTERN.test(box.tag) || !B64_PATTERN.test(box.ciphertext)) throw new StoreError("seal_mismatch");
  let partial: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    partial = decipher.update(Buffer.from(box.ciphertext, "base64"));
    const rest = decipher.final();
    const out = Buffer.concat([partial, rest]);
    zero(partial, rest);
    return out;
  } catch {
    // 認証に失敗した中間の平文も残さない。
    if (partial !== undefined) zero(partial);
    throw new StoreError("seal_mismatch");
  }
}

export function zero(...buffers: Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

/**
 * 新しい store を作る（`wallet new`）。`wallets` は rail の名前 → `{ address, secret }`。secret は呼び出し側が zero fill する。
 * 返す文書に秘密は無い（封印済み）。passphrase から導いた鍵は返さず、この中で zero fill する。
 */
export function createKeysDocument(passphrase: string, wallets: Readonly<Record<string, { readonly address: string; readonly secret: Buffer }>>): KeysDocument {
  if (!isValidPassphrase(passphrase)) throw new StoreError("passphrase_invalid");
  for (const [rail, wallet] of Object.entries(wallets)) {
    // AAD の区切り（`:`）と曖昧にならない文法だけ。
    if (!RAIL_PATTERN.test(rail) || !ADDRESS_PATTERN.test(wallet.address) || wallet.secret.length === 0 || wallet.secret.length > 128) throw new StoreError("wallet_invalid");
  }
  const salt = randomBytes(16);
  const pass = Buffer.from(passphrase, "utf8");
  let master: Buffer | undefined;
  let keys: Subkeys | undefined;
  try {
    master = deriveMaster(pass, salt);
    keys = subkeysOf(master);
    const sealed: Record<string, WalletEntry> = {};
    for (const [rail, wallet] of Object.entries(wallets)) {
      sealed[rail] = { address: wallet.address, ...seal(keys.kek, wallet.secret, `wallet:${rail}:${wallet.address}`) };
    }
    return { version: KEYS_VERSION, kdf: { ...SCRYPT_PARAMS, salt: salt.toString("base64") }, verifier: keys.verifier.toString("base64"), wallets: sealed };
  } finally {
    zero(pass);
    if (master !== undefined) zero(master);
    if (keys !== undefined) zero(keys.kek, keys.lek, keys.verifier);
  }
}

const KDF_BOUNDS = { N: [1 << 14, 1 << 22] as const, r: [1, 32] as const, p: [1, 16] as const };

function isPowerOfTwo(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function parseKeysDocument(text: string): KeysDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new StoreError("store_corrupt");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new StoreError("store_corrupt");
  const d = doc as Record<string, unknown>;
  if (d["version"] !== KEYS_VERSION) throw new StoreError("store_unsupported_version");
  const kdf = d["kdf"];
  if (typeof kdf !== "object" || kdf === null) throw new StoreError("store_corrupt");
  const k = kdf as Record<string, unknown>;
  const N = k["N"];
  const r = k["r"];
  const p = k["p"];
  if (k["name"] !== "scrypt" || typeof N !== "number" || !isPowerOfTwo(N) || N < KDF_BOUNDS.N[0] || N > KDF_BOUNDS.N[1]) throw new StoreError("store_corrupt");
  if (typeof r !== "number" || !Number.isSafeInteger(r) || r < KDF_BOUNDS.r[0] || r > KDF_BOUNDS.r[1]) throw new StoreError("store_corrupt");
  if (typeof p !== "number" || !Number.isSafeInteger(p) || p < KDF_BOUNDS.p[0] || p > KDF_BOUNDS.p[1]) throw new StoreError("store_corrupt");
  const salt = typeof k["salt"] === "string" && B64_PATTERN.test(k["salt"]) ? Buffer.from(k["salt"], "base64") : undefined;
  if (salt === undefined || salt.length < 16 || salt.length > 64) throw new StoreError("store_corrupt");
  const verifier = typeof d["verifier"] === "string" && B64_PATTERN.test(d["verifier"]) ? Buffer.from(d["verifier"], "base64") : undefined;
  if (verifier === undefined || verifier.length !== 16) throw new StoreError("store_corrupt");
  const wallets = d["wallets"];
  if (typeof wallets !== "object" || wallets === null || Array.isArray(wallets)) throw new StoreError("store_corrupt");
  for (const [rail, entry] of Object.entries(wallets as Record<string, unknown>)) {
    if (!RAIL_PATTERN.test(rail) || typeof entry !== "object" || entry === null) throw new StoreError("store_corrupt");
    const e = entry as Record<string, unknown>;
    if (typeof e["address"] !== "string" || !ADDRESS_PATTERN.test(e["address"]) || e["cipher"] !== "aes-256-gcm") throw new StoreError("store_corrupt");
    for (const field of ["iv", "tag", "ciphertext"]) if (typeof e[field] !== "string" || !B64_PATTERN.test(e[field] as string)) throw new StoreError("store_corrupt");
    if (Buffer.from(e["iv"] as string, "base64").length !== 12 || Buffer.from(e["tag"] as string, "base64").length !== 16 || Buffer.from(e["ciphertext"] as string, "base64").length === 0) throw new StoreError("store_corrupt");
  }
  return d as unknown as KeysDocument;
}

/**
 * passphrase で store を開く: `verifier` を定数時間で照合し、合えば `kek`・`lek` を返す（呼び出し側が zero fill する）。
 * 違えば `StoreError("bad_passphrase")`（鍵は導かない = 返さない）。
 */
export function unlockKeys(doc: KeysDocument, passphrase: string): { readonly kek: Buffer; readonly lek: Buffer } {
  if (!isValidPassphrase(passphrase)) throw new StoreError("bad_passphrase");
  const pass = Buffer.from(passphrase, "utf8");
  let master: Buffer | undefined;
  let keys: Subkeys;
  try {
    master = deriveMaster(pass, Buffer.from(doc.kdf.salt, "base64"), { name: "scrypt", N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p });
    keys = subkeysOf(master);
  } finally {
    zero(pass);
    if (master !== undefined) zero(master);
  }
  const stored = Buffer.from(doc.verifier, "base64");
  const ok = stored.length === keys.verifier.length && timingSafeEqual(stored, keys.verifier);
  zero(keys.verifier);
  if (!ok) {
    zero(keys.kek, keys.lek);
    throw new StoreError("bad_passphrase");
  }
  return { kek: keys.kek, lek: keys.lek };
}

/**
 * 既存の store に鍵を 1 本足す（`wallet add solana`。設計 `docs/payer-rails-design.md` §2.2）。passphrase で開けて（verifier の照合）、
 * 同じ `kek` で新しい秘密を封印し、**既存の欄はそのまま**（byte-identical）の新しい文書を返す。rail が既にあれば `wallet_exists`
 * （passphrase を確かめる前に拒む）。secret は呼び出し側が zero fill する。導いた鍵はこの中で zero fill する。
 */
export function addWallet(doc: KeysDocument, passphrase: string, rail: string, wallet: { readonly address: string; readonly secret: Buffer }): KeysDocument {
  if (!RAIL_PATTERN.test(rail) || !ADDRESS_PATTERN.test(wallet.address) || wallet.secret.length === 0 || wallet.secret.length > 128) throw new StoreError("wallet_invalid");
  if (doc.wallets[rail] !== undefined) throw new StoreError("wallet_exists");
  const keys = unlockKeys(doc, passphrase);
  try {
    const entry: WalletEntry = { address: wallet.address, ...seal(keys.kek, wallet.secret, `wallet:${rail}:${wallet.address}`) };
    return { ...doc, wallets: { ...doc.wallets, [rail]: entry } };
  } finally {
    zero(keys.kek, keys.lek);
  }
}

/** 封印された秘密鍵を復号する（呼び出し側が zero fill する）。 */
export function openWallet(doc: KeysDocument, rail: string, kek: Buffer): Buffer {
  const entry = doc.wallets[rail];
  if (entry === undefined) throw new StoreError("wallet_missing");
  return open(kek, entry, `wallet:${rail}:${entry.address}`);
}
