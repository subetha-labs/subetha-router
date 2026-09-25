/**
 * principal 認証（設計 §3 の必須入力 1）。支払い SDK を知らない層。
 * トークンは比較にだけ使い、応答・ログ・journal に出さない。
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type AuthResult =
  | { readonly ok: true; readonly principalId: string }
  | { readonly ok: false; readonly code: "unauthenticated" };

/** 同名ヘッダが複数来た要求は曖昧なので受け付けない。 */
export function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

/** 長さの違いだけを漏らさないよう、同長のバッファに正規化してから比較する。 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  const width = Math.max(a.length, b.length, 1);
  const padded = (source: Buffer): Buffer => {
    const target = Buffer.alloc(width);
    source.copy(target);
    return target;
  };
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length;
}

/**
 * `X-Router-Principal` と `Authorization: Bearer <token>` の 2 本を要求する。
 * 片方だけ・スキーム違い・未登録 principal・トークン不一致はいずれも同じ結果にする
 * （どの条件で落ちたかを外に出さない）。
 */
export function authenticate(
  headers: IncomingHttpHeaders,
  principals: ReadonlyMap<string, string>,
): AuthResult {
  const principalId = singleHeader(headers, "x-router-principal");
  const authorization = singleHeader(headers, "authorization");
  if (principalId === undefined || authorization === undefined) {
    return { ok: false, code: "unauthenticated" };
  }
  const [scheme, ...rest] = authorization.split(" ");
  const presented = rest.join(" ").trim();
  if (scheme?.toLowerCase() !== "bearer" || presented === "") {
    return { ok: false, code: "unauthenticated" };
  }
  const expected = principals.get(principalId);
  if (expected === undefined) {
    // 未登録でも比較コストを揃える（存在の有無を計測で区別させない）。
    constantTimeEquals(presented, presented);
    return { ok: false, code: "unauthenticated" };
  }
  return constantTimeEquals(presented, expected)
    ? { ok: true, principalId }
    : { ok: false, code: "unauthenticated" };
}
