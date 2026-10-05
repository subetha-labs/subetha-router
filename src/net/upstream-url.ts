/**
 * 呼び出し側が指定する上流 URL の検査（設計 `docs/dynamic-upstream-design.md` §2.2・§7.4）。
 *
 * **純粋関数**: 名前解決も接続もしない。接続先のアドレスの判定は SSRF 防御 A の transport が担う。
 * ここで決めるのは「どの文字列を URL として受け付けるか」だけ。
 *
 * **独自の正規化をしない。** `new URL()` が書き換える入力（大文字のホスト、既定ポートの明示、dot segment、
 * 空白、Unicode のホストなど）は拒否し、呼び出し側に直させる。保証するのは「**受け付けた綴りが、解析しても
 * 変わらない**」ことで、以後の表示・保存・fetch・上流の申告との比較はその文字列をそのまま使う。
 * 「同じ資源に綴りが 1 つしか無い」ことは保証しない（`/a` と `/%61` はどちらも通り、別の URL として扱う）。
 */

export const MAX_UPSTREAM_URL_LENGTH = 2048;

export type UpstreamUrlRejection =
  | "not_a_string"
  | "too_long"
  | "not_absolute"
  | "scheme"
  | "userinfo"
  | "fragment"
  | "port"
  | "ip_literal"
  | "trailing_dot"
  | "not_canonical"
  | "denied_host";

export type UpstreamUrlResult =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly reason: UpstreamUrlRejection };

export interface UpstreamUrlOptions {
  /** 宛先にできないホスト名（小文字）。そのホストとサブドメインを拒否する。 */
  readonly denyHosts: readonly string[];
}

const IPV4_PATTERN = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

function reject(reason: UpstreamUrlRejection): UpstreamUrlResult {
  return { ok: false, reason };
}

export function parseUpstreamUrl(raw: unknown, options: UpstreamUrlOptions): UpstreamUrlResult {
  if (typeof raw !== "string") {
    return reject("not_a_string");
  }
  if (raw.length > MAX_UPSTREAM_URL_LENGTH) {
    return reject("too_long");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("not_absolute");
  }
  if (url.protocol !== "https:") {
    return reject("scheme");
  }
  if (url.username !== "" || url.password !== "") {
    return reject("userinfo");
  }
  // `url.hash` は空の fragment（末尾の `#`）で空文字になるので、元の文字列を見る。
  if (raw.includes("#")) {
    return reject("fragment");
  }
  if (url.port !== "") {
    return reject("port");
  }
  const host = url.hostname;
  // WHATWG の解析は 10 進・16 進表記も IPv4 に直すので、解析後のホスト名で判定する。
  if (host.startsWith("[") || IPV4_PATTERN.test(host)) {
    return reject("ip_literal");
  }
  if (host.endsWith(".")) {
    return reject("trailing_dot");
  }
  if (url.href !== raw) {
    return reject("not_canonical");
  }
  if (options.denyHosts.some((denied) => host === denied || host.endsWith(`.${denied}`))) {
    return reject("denied_host");
  }
  return { ok: true, url: raw, host };
}

/**
 * 拒否ホストの一覧を作る: 設定の `denyHosts` に、Router 自身と依存先（canonical・facilitator・RPC）の
 * URL のホスト名を足す。**名前による拒否**であり、同じサーバを指す別名は止められない（設計 §7.4）。
 */
export function denyHostsOf(configured: readonly string[], urls: readonly (string | undefined)[]): string[] {
  const hosts = new Set<string>(configured);
  for (const raw of urls) {
    if (raw === undefined) continue;
    try {
      // 末尾のルートドットは同じ DNS 名の別の綴りなので落とす（`host.` で設定されていても `host` を拒否する）。
      hosts.add(new URL(raw).hostname.toLowerCase().replace(/\.$/, ""));
    } catch {
      // URL でない値は拒否ホストにしない（設定の検証は別の場所の仕事）。
    }
  }
  return [...hosts];
}
