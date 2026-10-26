/**
 * 秘匿購入の proxy 型 TLS（増分 v1.5、`docs/zktls-router-proxy-design.md`）の定数と、lab の `delivery` との固定形の契約。
 */

/**
 * Verifier（lab の `verifier-serve --tls-mode proxy`）が課す、方向ごとの中継バイト数の上限（設計 §5）。設定ではなく定数で、値は承認の指紋に入る
 * （変えると発行済みの proxy 型の quote は `quote_changed` で止まる）。
 * - Payer→Provider: 要求の上限 4,096 B + TLS 1.2 の ClientHello・ClientKeyExchange・ChangeCipherSpec・Finished と記録の付加（AES-GCM で 1 記録 29 B）。
 * - Provider→Payer: lab の受信 transcript の上限 16 KiB + 証明書の連鎖 + ServerHello 等。どちらも 2 倍以上の余裕。
 */
export const PROXY_RELAY_LIMITS = Object.freeze({ maxSentBytes: 16_384, maxRecvBytes: 65_536 });

/** `verifier-serve` が proxy 型の失敗のときに作業ディレクトリに書く固定形の通知（要件 LX-7、設計 §6）。record とは排他。 */
export const FAILURE_FILE = "failure.json";
export const FAILURE_MAX_BYTES = 256;

/** lab の固定語 → Router の理由コード（要件 FR-X08・FR-X13）。 */
const FAILURE_REASONS: Readonly<Record<string, "private_proxy_dial_failed" | "private_proxy_server_name_mismatch" | "private_proxy_limit">> = Object.freeze({
  proxy_dial_failed: "private_proxy_dial_failed",
  proxy_server_name_mismatch: "private_proxy_server_name_mismatch",
  proxy_limit: "private_proxy_limit",
});

/**
 * 失敗通知の厳密な解析（設計 §6）: JSON で**ちょうど** `{"reason": <3 語のどれか>}`（他のキー無し）のときだけ Router の理由コードを返す。
 * それ以外（JSON でない・キーが違う・未知の語・大きすぎ）は `undefined`（呼び出し側は `private_session_timeout` にする）。
 */
export function parseFailureNotice(bytes: Uint8Array): "private_proxy_dial_failed" | "private_proxy_server_name_mismatch" | "private_proxy_limit" | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > FAILURE_MAX_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "reason") return undefined;
  const reason = (value as { reason: unknown }).reason;
  if (typeof reason !== "string" || !Object.hasOwn(FAILURE_REASONS, reason)) return undefined;
  return FAILURE_REASONS[reason];
}

/** 新しい理由コード（要件 FR-X13）。`SAFE_REASONS` と診断の表に足す。 */
export const PROXY_REASONS = Object.freeze(["private_proxy_dial_refused", "private_proxy_dial_failed", "private_proxy_server_name_mismatch", "private_proxy_limit"] as const);
