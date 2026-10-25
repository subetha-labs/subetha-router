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
