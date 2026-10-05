/**
 * 動的上流 URL の試験で使う「宛先の差し替え」（設計 `docs/dynamic-upstream-design.md` §3.1）。**試験専用。**
 *
 * 宛先の判定は本番と同じコードが走る: 名前解決の fixture が**公開アドレス**を返し、transport がそれを検査して通す。
 * そのうえで `dialForTest` が TCP の行き先だけを loopback の fixture に向ける。loopback・内部アドレスに解決する名前は、
 * この差し替えがあっても判定で拒否される。
 */
import type { LookupAddress } from "node:dns";

import type { GuardedTransportOptions, LookupFn } from "../../../src/net/guarded-fetch.js";

/** 判定を通る公開アドレス（example.com のもの）。**実際には接続しない。** */
export const FIXTURE_PUBLIC_ADDRESS = "93.184.216.34";

/** どの名前も同じ公開アドレスに解決する lookup。`overrides` で名前ごとのアドレスを変えられる。 */
export function publicLookup(overrides: Readonly<Record<string, readonly string[]>> = {}): LookupFn {
  return (hostname, _options, callback) => {
    const addresses = overrides[hostname] ?? [FIXTURE_PUBLIC_ADDRESS];
    callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) as LookupAddress[]);
  };
}

/**
 * ホスト名 → loopback のポート。表に無いホスト名は差し替えない（＝公開アドレスへ実際に接続しようとして失敗する。
 * 試験が意図しない宛先に出たことに気付ける）。
 */
export function dialTo(routes: Readonly<Record<string, number>>): NonNullable<GuardedTransportOptions["dialForTest"]> {
  return (target) => {
    const port = Object.hasOwn(routes, target.hostname) ? routes[target.hostname] : undefined;
    return port === undefined ? undefined : { host: "127.0.0.1", port };
  };
}
