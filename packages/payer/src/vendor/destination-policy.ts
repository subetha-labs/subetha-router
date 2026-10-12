/**
 * SSRF 防御 A の宛先ポリシー（`docs/ssrf-app-guard-design.md` §3.1）。transport に依存しない純関数。
 *
 * 判定の順序は固定: 構文 → IPv4-mapped の正規化（埋め込み IPv4 を分類する） → unspecified → loopback →
 * 自アドレス（loopback 以外） → IANA special-purpose 表 → allowed。表は B（`deploy/egress/subetha-egress` の
 * `DENY4` / `DENY6`）と同じ範囲を持つ。`::ffff:0:0/96` だけは意味が違う（B は一括 DROP、A は埋め込みを分類）。
 */

import os from "node:os";

/** 表の出所と版。運用者向けログに出す。 */
export const POLICY_VERSION = "a1/iana-2025-10-09";

/** B の `DENY4` と同じ（IANA IPv4 Special-Purpose Address Registry 2025-10-09 + multicast + 240/4）。 */
export const DENY4: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

/** B の `DENY6` と同じ（IANA IPv6 Special-Purpose Address Registry 2025-10-09、Globally Reachable = False、+ multicast）。 */
export const DENY6: readonly string[] = [
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "100:0:0:1::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

export type DenyReason = "invalid" | "unspecified" | "loopback" | "own_address" | "special_purpose";

export type Classification =
  | { readonly allowed: true; readonly address: ParsedAddress }
  | { readonly allowed: false; readonly reason: DenyReason };

export interface ParsedAddress {
  readonly family: 4 | 6;
  /** 4 または 16 バイト。IPv4-mapped IPv6 は 4 バイトに正規化済み。 */
  readonly bytes: Uint8Array;
  /** 正規化後の文字列（接続に使う）。 */
  readonly text: string;
}

export interface PolicyOptions {
  /** fixture 例外（§3.4）。loopback だけを許す。組み立て側だけが true にできる。 */
  readonly allowLoopback: boolean;
  /** 自アドレスの供給元（既定は `os.networkInterfaces()`）。 */
  readonly interfaces: () => readonly string[];
}

function parseIPv4(text: string): Uint8Array | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return undefined;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = m[i + 1]!;
    if (part.length > 1 && part.startsWith("0")) return undefined; // 8 進や前ゼロの別表記を受けない
    const value = Number(part);
    if (value > 255) return undefined;
    bytes[i] = value;
  }
  return bytes;
}

function parseIPv6(input: string): Uint8Array | undefined {
  let text = input;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone); // scope id は落とす
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text === "" || !/^[0-9a-fA-F:.]+$/.test(text)) return undefined;

  // 末尾に埋め込み IPv4（例 ::ffff:1.2.3.4）があれば 2 つの 16 ビット片に変換する。
  let groupsText = text;
  let tailBytes: Uint8Array | undefined;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tailBytes = v4;
    groupsText = text.slice(0, lastColon + 1) + "0:0"; // 仮の 2 片。後で置き換える
  }

  const doubleColon = groupsText.indexOf("::");
  if (doubleColon !== -1 && groupsText.indexOf("::", doubleColon + 1) !== -1) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  let groups: number[];
  if (doubleColon === -1) {
    const g = parseGroups(groupsText);
    if (g === undefined || g.length !== 8) return undefined;
    groups = g;
  } else {
    const head = parseGroups(groupsText.slice(0, doubleColon));
    const tail = parseGroups(groupsText.slice(doubleColon + 2));
    if (head === undefined || tail === undefined || head.length + tail.length > 7) return undefined;
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  if (tailBytes !== undefined) bytes.set(tailBytes, 12);
  return bytes;
}

function formatIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return groups.join(":");
}

/** 文字列をアドレスに解析する。IPv4-mapped IPv6 は埋め込みの IPv4 に正規化する（FR-A1）。 */
export function parseAddress(text: string): ParsedAddress | undefined {
  const v4 = parseIPv4(text);
  if (v4 !== undefined) return { family: 4, bytes: v4, text: Array.from(v4).join(".") };
  const v6 = parseIPv6(text);
  if (v6 === undefined) return undefined;
  const mappedPrefix = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (mappedPrefix) {
    const embedded = v6.slice(12);
    return { family: 4, bytes: embedded, text: Array.from(embedded).join(".") };
  }
  return { family: 6, bytes: v6, text: formatIPv6(v6) };
}

function inCidr(bytes: Uint8Array, cidr: string): boolean {
  const [base, lenText] = cidr.split("/") as [string, string];
  const parsed = base.includes(":") ? parseIPv6(base) : parseIPv4(base);
  if (parsed === undefined || parsed.length !== bytes.length) return false;
  const len = Number(lenText);
  for (let bit = 0; bit < len; bit += 1) {
    const mask = 0x80 >> (bit % 8);
    if (((bytes[bit >> 3]! ^ parsed[bit >> 3]!) & mask) !== 0) return false;
  }
  return true;
}

function isLoopback(address: ParsedAddress): boolean {
  return address.family === 4 ? address.bytes[0] === 127 : inCidr(address.bytes, "::1/128");
}

function isUnspecified(address: ParsedAddress): boolean {
  return address.bytes.every((b) => b === 0);
}

/** 既定の自アドレス供給元。 */
export function interfaceAddresses(): readonly string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .map((entry) => entry.address);
}

/** 1 アドレスを分類する（§3.1 の順序）。 */
export function classifyAddress(text: string, options: PolicyOptions): Classification {
  const address = parseAddress(text);
  if (address === undefined) return { allowed: false, reason: "invalid" };
  if (isUnspecified(address)) return { allowed: false, reason: "unspecified" };
  if (isLoopback(address)) {
    return options.allowLoopback ? { allowed: true, address } : { allowed: false, reason: "loopback" };
  }
  for (const own of options.interfaces()) {
    const parsedOwn = parseAddress(own);
    if (parsedOwn === undefined || isLoopback(parsedOwn)) continue;
    if (parsedOwn.family === address.family && parsedOwn.text === address.text) {
      return { allowed: false, reason: "own_address" };
    }
  }
  const table = address.family === 4 ? DENY4 : DENY6;
  for (const cidr of table) {
    if (inCidr(address.bytes, cidr)) return { allowed: false, reason: "special_purpose" };
  }
  return { allowed: true, address };
}
