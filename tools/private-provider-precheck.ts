/**
 * 第三者 Provider（公開 GET）の**事前互換検査**（`docs/zktls-router-thirdparty.md` §4.1）。**製品コードではない。何も払わない・署名しない。**
 *
 * 未払いの要求を 1 回だけ送り、秘匿購入の経路が固定している条件のうち**未払いで確かめられるもの**を当てる:
 *   B1 TLS 1.2 で `ECDHE-{ECDSA,RSA}-AES128-GCM-SHA256`（MPC-TLS の対応 suite）だけを提示して handshake が成立する
 *   B2 lab の固定骨格（`GET <path> HTTP/1.1\r\nHost: <host>\r\nConnection: close\r\n\r\n`。支払いヘッダ無し）に応答がある、要求長が送信予算に収まる
 *   R1 402 + `PAYMENT-REQUIRED`（x402 v2）、`resource.url` が要求した URL と完全一致、offer の数の上限
 *   R2 Router の offer 規則（`checkDynamicX402Offer` をそのまま）を通る Base Sepolia USDC の offer が 1 つある
 *   R4 host/path の規則（`checkTarget` = `parseIntent` と同じ）と `parseUpstreamUrl`（I/O の前）
 * 払うまで分からないもの（`notVerified` として出力に書く）: 有料応答が `HTTP/1.1 200 OK` + `Content-Length` 1 つ + 本文 ≤ 704 B であること（B3）、
 * 領収 `PAYMENT-RESPONSE` に `payer` があること（B4）。402 の framing は**観測**として記録するだけで合否にしない。ただし 402 が `Content-Length` でなければ
 * `warnings` に不適合の兆候として書く（lab は `Transfer-Encoding` を設計として受け付けない: `docs/zktls-router-open-items.md` §A-4。有料応答も chunked なら
 * 両レグ決済の後に B3 で落ち、返金は無い）。
 *
 * 接続先の安全（Router の動的 transport と同じ方針）: 名前解決は期限つき（`dns.lookup`、全アドレス）、解決した**すべて**のアドレスを `classifyAddress`
 * （loopback・自アドレス・特殊用途を拒否）に通し、通った先頭のアドレスへ接続する（SNI と証明書の検査は host 名のまま）。`--connect` は試験専用の loopback の差し替え
 * で、`--ca` と組でだけ使え、その結果は **synthetic**（`observed.synthetic: true`。公開 PKI の観測ではない。`tools/private-payer.ts` は `--trust mozilla` で拒む）。
 *
 * 出力（stdout と `<out>/provider.json`、0600）は Payer の封筒に要る値と観測値だけ。**402 の本文・状態行の reason phrase・ヘッダの値・例外の文字列は出さない・保存しない。**
 * 意図した例外: 支払い条件（`payTo`・額・`maxTimeoutSeconds`）は `PAYMENT-REQUIRED` の値そのもので、`checkDynamicX402Offer` の形の検査を通ったものだけを出す。
 * 運用者アドレス（Router 自身の受取先・署名者）への支払い拒否は Router の quote が行う（この道具は知らない）。
 *
 * usage: npx tsx tools/private-provider-precheck.ts --url https://<host><path> [--max-amount 10000] [--out <dir>] [--ca <pem> --connect 127.0.0.1:<port>]
 *   `--ca`/`--connect` は試験専用（fixture CA だけを信頼し、TCP の行き先を差し替える。必ず組で）。終了コード: 0 = 通過、1 = 不通過、2 = 引数。
 */
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

import { decodePaymentRequiredHeader } from "@x402/core/http";

import { checkDynamicX402Offer } from "../src/adapters/outbound/x402-dynamic.js";
import type { DynamicProfile } from "../src/config.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../src/net/bounded-body.js";
import { classifyAddress, interfaceAddresses } from "../src/net/destination-policy.js";
import { parseUpstreamUrl } from "../src/net/upstream-url.js";
import { expectedPrefixOf, MAX_PAYMENT_VALUE_GET, MAX_SENT_BYTES, parseRecvHeaders } from "../src/private/attest.js";
import { checkTarget, FRAMING_GET_PUBLIC } from "../src/private/intent.js";

export const PROVIDER_FILE_VERSION = "private-provider-v1";
/** 本増分の送信レール: x402 の Base Sepolia USDC だけ（`docs/zktls-router-thirdparty.md` §1 R3）。 */
export const PRECHECK_NETWORK = "eip155:84532";
export const PRECHECK_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PRECHECK_TOKEN_DOMAIN = { name: "USDC", version: "2" } as const;
/** lab の MPC-TLS が提示する 2 suite（OpenSSL の名前）。 */
export const PRECHECK_CIPHERS = "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256";
/** lab `tls.rs` `MAX_RECV_DATA`（受信の予算）。これを超える 402 は読まない。 */
export const MAX_RECV_BYTES = 1 << 14;
const DEFAULT_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_AMOUNT = "10000";
const AMOUNT = /^(0|[1-9][0-9]{0,29})$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type PrecheckReason =
  | "url_invalid"
  | "connect_invalid"
  | "dns_failed"
  | "address_denied"
  | "tls_handshake"
  | "timeout"
  | "recv_too_large"
  | "recv_headers"
  | "not_402"
  | "no_payment_required_header"
  | "undecodable"
  | "version"
  | "no_offers"
  | "too_many_offers"
  | "resource_mismatch"
  | "no_acceptable_offer"
  | "request_too_long";

export interface ProviderFile {
  readonly version: typeof PROVIDER_FILE_VERSION;
  readonly method: "GET";
  readonly host: string;
  readonly path: string;
  readonly url: string;
  readonly outbound: { readonly protocol: "x402"; readonly network: string; readonly asset: string; readonly payTo: string; readonly maxAmount: string };
  readonly observed: {
    /** `--ca`/`--connect` で得た観測は synthetic（公開 PKI・実アドレスの観測ではない）。 */
    readonly synthetic: boolean;
    readonly trust: "mozilla" | "test-ca";
    readonly tlsVersion: string;
    readonly cipher: string;
    /** 状態の数字だけ（reason phrase はサーバの文字列なので出さない）。 */
    readonly status: number;
    readonly httpVersion: "HTTP/1.1";
    readonly framing402: "content-length" | "chunked" | "other";
    readonly headBytes402: number;
    readonly acceptsCount: number;
    readonly maxTimeoutSeconds: number;
    /** `GET` の骨格（ヘッダ値を除く）のバイト数。ヘッダ値の上限 3072 B を足して 4096 B 以下であること（B2）。 */
    readonly skeletonBytes: number;
  };
  readonly notVerified: readonly string[];
  /** 不適合の兆候（固定文。合否ではない）。無ければ欄ごと無い。 */
  readonly warnings?: readonly string[];
  readonly checkedAt: string;
}

export interface PrecheckCheck {
  readonly name: string;
  readonly ok: boolean;
  /** 固定語だけ（上流の文字列は入れない）。 */
  readonly detail?: string;
}

export type PrecheckResult = { readonly ok: true; readonly provider: ProviderFile; readonly checks: readonly PrecheckCheck[]; readonly file?: string } | { readonly ok: false; readonly reason: PrecheckReason; readonly checks: readonly PrecheckCheck[]; readonly detail?: string };

export interface PrecheckOptions {
  readonly url: string;
  readonly maxAmount?: string;
  readonly outDir?: string;
  /** 試験専用: この CA **だけ**を信頼する（公開 PKI は使わない）。`connect` と組。 */
  readonly ca?: string;
  /** 試験専用: TCP の行き先 `host:port`（SNI・Host・URL は `url` のまま）。`ca` と組。 */
  readonly connect?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /**
   * **試験専用**: 名前解決・自アドレス・期限・接続先の差し替え（接続先の方針 `resolveVetted` を外部ネットワーク無しで試す）。
   * `dial` は検査を通ったアドレスを受け取り、実際に接続する loopback の fixture を返す（どのアドレスに接続しようとしたかを試験が記録する）。
   * 使うと観測は synthetic。`ca` と組でだけ使える。
   */
  readonly hooksForTest?: {
    readonly resolve?: (host: string) => Promise<string[]>;
    readonly interfaces?: () => readonly string[];
    readonly dnsTimeoutMs?: number;
    readonly dial?: (address: string, port: number) => { readonly host: string; readonly port: number };
  };
}

export const NOT_VERIFIED = [
  "B3: the paid 200 response must be exactly 'HTTP/1.1 200 OK' with one Content-Length, no Transfer-Encoding/Content-Encoding and a body of 1..=704 bytes; this cannot be checked without paying",
  "B4: the paid response must carry exactly one PAYMENT-RESPONSE with success, a bytes32 transaction, the network and payer = the Router's outbound signer; this cannot be checked without paying",
] as const;

/** 402 が `Content-Length` 1 つで返らなかったときの固定文（lab の回答 §A-4: chunked は設計として受け付けない）。 */
export const FRAMING_WARNING = "402 was not framed with a single Content-Length and identity encoding (chunked, or Content-Encoding/other): the lab's delivery binary accepts only content-length-identity-single-response and refuses Transfer-Encoding and non-identity Content-Encoding by design (open-items §A-4), so the paid response is likely to fail B3 after both legs are paid, with no refund; prefer a provider whose 402 carries a single Content-Length with identity encoding";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `checkDynamicX402Offer` に渡す最小のプロファイル（検査が読むのは `destination` と `maxUpstreamAmount` だけ）。 */
export function precheckProfileOf(maxAmount: string): DynamicProfile {
  return {
    profileId: "precheck",
    sourceRail: "x402",
    source: { network: PRECHECK_NETWORK, asset: PRECHECK_ASSET, decimals: 6, payTo: "0x0000000000000000000000000000000000000000" },
    rail: "x402",
    destination: { scheme: "exact", network: PRECHECK_NETWORK, asset: PRECHECK_ASSET, decimals: 6, tokenDomain: { ...PRECHECK_TOKEN_DOMAIN } },
    par: true,
    maxUpstreamAmount: maxAmount,
    fee: { flat: "0", bps: 0, min: "0" },
  };
}

interface RawResponse {
  readonly tlsVersion: string;
  readonly cipher: string;
  readonly bytes: Buffer;
  readonly truncated: boolean;
}

/** 期限つきの名前解決（全アドレス）→ 方針の検査（loopback・自アドレス・特殊用途は拒否。**1 つでも**拒否されれば接続しない）→ 通った先頭のアドレス。 */
export async function resolveVetted(host: string, hooks: PrecheckOptions["hooksForTest"] = undefined): Promise<{ ok: true; address: string } | { ok: false; reason: "dns_failed" | "address_denied" }> {
  let addresses: string[];
  const lookup = hooks?.resolve ?? ((name: string) =>
    new Promise<string[]>((resolve, reject) => {
      dns.lookup(name, { all: true, verbatim: true }, (error, entries) => {
        if (error !== null) reject(error);
        else resolve(entries.map((entry) => entry.address));
      });
    }));
  let timer: NodeJS.Timeout | undefined;
  try {
    addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), hooks?.dnsTimeoutMs ?? DNS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { ok: false, reason: "dns_failed" };
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, reason: "dns_failed" };
  const policy = { allowLoopback: false, interfaces: hooks?.interfaces ?? interfaceAddresses };
  const vetted: string[] = [];
  for (const text of addresses) {
    const classified = classifyAddress(text, policy);
    if (!classified.allowed) return { ok: false, reason: "address_denied" };
    vetted.push(classified.address.text);
  }
  return { ok: true, address: vetted[0]! };
}

/** TLS 1.2（2 suite）で 1 回だけ接続し、骨格を送って応答を上限つきで読む。失敗は固定語。 */
function fetchRaw(host: string, requestPath: string, connectHost: string, connectPort: number, options: PrecheckOptions): Promise<{ ok: true; response: RawResponse } | { ok: false; reason: "tls_handshake" | "timeout" }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    let settled = false;
    const finish = (result: { ok: true; response: RawResponse } | { ok: false; reason: "tls_handshake" | "timeout" }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect({
      host: connectHost,
      port: connectPort,
      servername: host,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers: PRECHECK_CIPHERS,
      rejectUnauthorized: true,
      ...(options.ca === undefined ? {} : { ca: [options.ca] }),
    });
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    socket.on("secureConnect", () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_RECV_BYTES) {
        // lab の受信予算を超えた: それ以上は受け取らず、すぐに切って `recv_too_large`（開いたままの応答で timeout を待たない）。
        truncated = true;
        finish({ ok: true, response: { tlsVersion: socket.getProtocol() ?? "", cipher: socket.getCipher()?.name ?? "", bytes: Buffer.alloc(0), truncated } });
        return;
      }
      chunks.push(chunk);
    });
    socket.on("error", () => finish({ ok: false, reason: "tls_handshake" }));
    socket.on("end", () => {
      const cipher = socket.getCipher();
      finish({ ok: true, response: { tlsVersion: socket.getProtocol() ?? "", cipher: cipher?.name ?? "", bytes: Buffer.concat(chunks), truncated } });
    });
    socket.on("close", () => {
      if (!settled) {
        const cipher = socket.getCipher();
        finish(chunks.length === 0 ? { ok: false, reason: "tls_handshake" } : { ok: true, response: { tlsVersion: socket.getProtocol() ?? "", cipher: cipher?.name ?? "", bytes: Buffer.concat(chunks), truncated } });
      }
    });
  });
}

function framingOf(headers: readonly { readonly name: string; readonly value: string }[]): "content-length" | "chunked" | "other" {
  const lengths = headers.filter((h) => h.name === "content-length");
  if (headers.some((h) => h.name === "transfer-encoding")) return "chunked";
  const encodings = headers.filter((h) => h.name === "content-encoding" && h.value.toLowerCase() !== "identity");
  if (lengths.length === 1 && /^[0-9]+$/.test(lengths[0]!.value) && encodings.length === 0) return "content-length";
  return "other";
}

export async function precheckProvider(options: PrecheckOptions): Promise<PrecheckResult> {
  const checks: PrecheckCheck[] = [];
  const no = (reason: PrecheckReason, detail?: string): PrecheckResult => {
    checks.push({ name: reason, ok: false, ...(detail === undefined ? {} : { detail }) });
    return { ok: false, reason, checks, ...(detail === undefined ? {} : { detail }) };
  };
  const maxAmount = options.maxAmount ?? DEFAULT_MAX_AMOUNT;
  if (!AMOUNT.test(maxAmount) || maxAmount === "0") return no("url_invalid", "max_amount");
  const synthetic = options.connect !== undefined || options.hooksForTest !== undefined;
  // 試験の差し替え（`--connect`・hooks）は fixture CA と組でだけ。`--ca` だけ・差し替えだけは拒む。
  if ((options.ca === undefined) !== !synthetic) return no("connect_invalid", "ca_and_connect_are_a_pair");
  if (options.connect !== undefined && !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(options.connect)) return no("connect_invalid", "loopback_only");

  // R4（I/O の前）: URL → host/path の規則（`parseIntent` と同じ）→ `parseUpstreamUrl`。
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    return no("url_invalid", "not_a_url");
  }
  if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.search !== "" || options.url.includes("#") || options.url.includes("?")) return no("url_invalid", "scheme_port_query_fragment");
  const target = checkTarget(parsed.hostname, parsed.pathname);
  if (!target.ok) return no("url_invalid", target.reason);
  const url = `https://${target.host}${target.path}`;
  if (url !== options.url) return no("url_invalid", "not_canonical");
  const upstream = parseUpstreamUrl(url, { denyHosts: [] });
  if (!upstream.ok) return no("url_invalid", upstream.reason);
  checks.push({ name: "R4 host/path rules (parseIntent, parseUpstreamUrl)", ok: true });

  // B2（I/O の前）: 骨格 + ヘッダ値の上限（3072 B）が送信予算（4096 B）に収まる。
  const spec = { framing: FRAMING_GET_PUBLIC, method: "GET" as const, content_type: "", body_len: 0, body_commitment_hex: "", executor_header: "", max_executor_value_len: 0 };
  const skeletonBytes = Buffer.byteLength(expectedPrefixOf({ host: target.host, port: 443, path: target.path }, spec, { name: "PAYMENT-SIGNATURE", value: "" }), "utf8");
  if (skeletonBytes + MAX_PAYMENT_VALUE_GET > MAX_SENT_BYTES) return no("request_too_long");
  checks.push({ name: "B2 request skeleton + 3072 B header value <= 4096 B", ok: true, detail: `skeleton=${skeletonBytes}` });

  // 接続先（Router の動的 transport と同じ方針）: 試験の差し替えが無ければ、期限つきの名前解決と方針の検査を通った実アドレスへ。
  let connectHost: string;
  let connectPort = 443;
  if (options.connect !== undefined) {
    const [h, p] = options.connect.split(":");
    connectHost = h!;
    connectPort = Number(p);
  } else {
    const resolved = await resolveVetted(target.host, options.hooksForTest);
    if (!resolved.ok) return no(resolved.reason);
    connectHost = resolved.address;
    if (options.hooksForTest?.dial !== undefined) {
      const dialed = options.hooksForTest.dial(connectHost, connectPort);
      connectHost = dialed.host;
      connectPort = dialed.port;
    }
  }
  checks.push({ name: "destination address vetted (bounded DNS, no loopback/own/special-purpose) or test override", ok: true, detail: options.connect === undefined ? "resolved" : "test_override" });

  // B1 + B2: 1 回の未払い要求。
  const fetched = await fetchRaw(target.host, target.path, connectHost, connectPort, options);
  if (!fetched.ok) return no(fetched.reason);
  const { response } = fetched;
  checks.push({ name: "B1 TLS 1.2 with an MPC-TLS cipher suite", ok: true, detail: `${response.tlsVersion} ${response.cipher}` });
  if (response.truncated) return no("recv_too_large");
  const headEnd = response.bytes.indexOf("\r\n\r\n");
  if (headEnd < 0) return no("recv_headers", "no_header_terminator");
  const head = response.bytes.subarray(0, headEnd).toString("latin1");
  const recv = parseRecvHeaders(`${head}\r\n\r\n`);
  if (recv === undefined) return no("recv_headers");
  const status = Number(recv.statusLine.slice("HTTP/1.1 ".length, "HTTP/1.1 ".length + 3));
  if (status !== 402) return no("not_402", String(status));
  checks.push({ name: "R1 unpaid GET answers 402", ok: true });
  const framing402 = framingOf(recv.headers);
  checks.push({ name: "observation: 402 framing (not a pass/fail; the paid response's framing is B3)", ok: true, detail: framing402 === "content-length" ? framing402 : `${framing402} (incompatibility sign: the lab accepts only content-length-identity framing, open-items §A-4; see provider.warnings)` });
  const warnings = framing402 === "content-length" ? [] : [FRAMING_WARNING];
  const prHeaders = recv.headers.filter((h) => h.name === "payment-required");
  if (prHeaders.length !== 1 || prHeaders[0]!.value === "") return no("no_payment_required_header");
  let raw: unknown;
  try {
    raw = decodePaymentRequiredHeader(prHeaders[0]!.value);
  } catch {
    return no("undecodable");
  }
  if (!isRecord(raw)) return no("undecodable");
  if (raw["x402Version"] !== 2) return no("version");
  const accepts = raw["accepts"];
  if (!Array.isArray(accepts) || accepts.length === 0) return no("no_offers");
  if (accepts.length > DYNAMIC_RESPONSE_LIMITS.maxOffers) return no("too_many_offers");
  const resource = raw["resource"];
  if (!isRecord(resource) || resource["url"] !== url) return no("resource_mismatch");
  checks.push({ name: "R1 PAYMENT-REQUIRED v2, resource.url === url, accepts <= 16", ok: true, detail: `accepts=${accepts.length}` });

  // R2: Router の規則そのもの（運用者アドレスの除外は Router の quote が行う）。
  const profile = precheckProfileOf(maxAmount);
  let selected: Record<string, unknown> | undefined;
  let firstRejection: string | undefined;
  for (const entry of accepts) {
    const rejection = checkDynamicX402Offer(entry, profile, []);
    if (rejection === undefined) {
      selected = entry as Record<string, unknown>;
      break;
    }
    firstRejection ??= rejection;
  }
  if (selected === undefined) return no("no_acceptable_offer", firstRejection);
  checks.push({ name: "R2 an offer passes checkDynamicX402Offer (Base Sepolia USDC, amount <= max)", ok: true });

  const provider: ProviderFile = {
    version: PROVIDER_FILE_VERSION,
    method: "GET",
    host: target.host,
    path: target.path,
    url,
    outbound: { protocol: "x402", network: PRECHECK_NETWORK, asset: PRECHECK_ASSET, payTo: selected["payTo"] as string, maxAmount: selected["amount"] as string },
    observed: {
      synthetic,
      trust: options.ca === undefined ? "mozilla" : "test-ca",
      tlsVersion: response.tlsVersion,
      cipher: response.cipher,
      status,
      httpVersion: "HTTP/1.1",
      framing402,
      headBytes402: headEnd + 4,
      acceptsCount: accepts.length,
      maxTimeoutSeconds: selected["maxTimeoutSeconds"] as number,
      skeletonBytes,
    },
    notVerified: [...NOT_VERIFIED],
    ...(warnings.length === 0 ? {} : { warnings }),
    checkedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
  };
  if (options.outDir === undefined) return { ok: true, provider, checks };
  mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  const file = path.join(options.outDir, "provider.json");
  // 既存のファイル・一時ファイル・symlink があっても 0600 の**新規**ファイルにだけ書く: 予測できない名前を `wx`（排他作成）+ 0600 で開き、
  // 書けたら rename（既存の `provider.json` は置き換わる。symlink を辿って別のファイルを切り詰めることは無い）。失敗したら一時ファイルを消す。
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(provider, null, 2)}\n`);
    closeSync(fd);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // 既に閉じている。
    }
    try {
      unlinkSync(tmp);
    } catch {
      // 残骸が無い。
    }
    throw error;
  }
  return { ok: true, provider, checks, file };
}

/** `provider.json` を読む（`tools/private-payer.ts --provider-file`）。形が違えば `undefined`。 */
export function readProviderFile(file: string): ProviderFile | undefined {
  try {
    return parseProviderFile(readFileSync(file));
  } catch {
    return undefined;
  }
}

/** `provider.json` のバイト列を検査する（読んだバイト列の sha256 と同じものを検査するため、ファイルではなくバイト列を受ける）。 */
export function parseProviderFile(bytes: Buffer): ProviderFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["version"] !== PROVIDER_FILE_VERSION || parsed["method"] !== "GET") return undefined;
  const outbound = parsed["outbound"];
  if (typeof parsed["host"] !== "string" || typeof parsed["path"] !== "string" || !isRecord(outbound)) return undefined;
  const target = checkTarget(parsed["host"], parsed["path"]);
  if (!target.ok) return undefined;
  // 送信条件は本増分の表（Base Sepolia USDC）と EVM アドレス・10 進の額に限る。
  if (outbound["protocol"] !== "x402" || outbound["network"] !== PRECHECK_NETWORK || outbound["asset"] !== PRECHECK_ASSET) return undefined;
  if (typeof outbound["payTo"] !== "string" || !EVM_ADDRESS.test(outbound["payTo"])) return undefined;
  if (typeof outbound["maxAmount"] !== "string" || !AMOUNT.test(outbound["maxAmount"]) || outbound["maxAmount"] === "0") return undefined;
  if (parsed["url"] !== `https://${target.host}${target.path}`) return undefined;
  const observed = parsed["observed"];
  if (!isRecord(observed) || typeof observed["synthetic"] !== "boolean") return undefined;
  const warnings = parsed["warnings"];
  if (warnings !== undefined && (!Array.isArray(warnings) || !warnings.every((w) => typeof w === "string"))) return undefined;
  return parsed as unknown as ProviderFile;
}

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const url = argOf("url");
  if (url === undefined || url === "") {
    process.stderr.write("--url https://<host><path> is required\n");
    process.exit(2);
  }
  const caFile = argOf("ca");
  const result = await precheckProvider({
    url,
    ...(argOf("max-amount") === undefined ? {} : { maxAmount: argOf("max-amount")! }),
    ...(argOf("out") === undefined ? {} : { outDir: argOf("out")! }),
    ...(caFile === undefined ? {} : { ca: readFileSync(caFile, "utf8") }),
    ...(argOf("connect") === undefined ? {} : { connect: argOf("connect")! }),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // 例外の文字列は上流の値を含み得るので固定文だけ。
    process.stderr.write(`private-provider-precheck: failed (${error instanceof Error ? error.name : "error"})\n`);
    process.exit(1);
  });
}
