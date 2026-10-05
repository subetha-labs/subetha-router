/**
 * 動的上流 URL の経路が上流から受け取るものの上限（設計 `docs/dynamic-upstream-design.md` §3.4）と、
 * 本文を**上限つきで**読む関数。上限を超えたら読み切らずに中断する。
 */

export const DYNAMIC_RESPONSE_LIMITS = {
  /** 応答ヘッダ全体。動的用の transport を作る側が `maxHeaderSize` に渡す。 */
  maxHeaderBytes: 32 * 1024,
  /** 1 つの応答に並ぶ offer／challenge の個数。 */
  maxOffers: 16,
  /** 有料応答の本文。 */
  maxPaidBodyBytes: 256 * 1024,
} as const;

export type BoundedBody =
  | { readonly ok: true; readonly bytes: Uint8Array }
  /** 上限を超えた。残りは読まずに中断した。 */
  | { readonly ok: false };

/**
 * 本文を `maxBytes` まで読む。超えた時点で**残りを読まずに**中断する（接続も切れる）。
 * `content-length` が上限を超えていれば 1 バイトも読まない。読み取りの失敗は例外。
 */
export async function readBoundedBody(
  response: { readonly body: ReadableStream<Uint8Array> | null; readonly headers: { get(name: string): string | null } },
  maxBytes: number,
): Promise<BoundedBody> {
  const body = response.body;
  if (body === null) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    await body.cancel().catch(() => {});
    return { ok: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
