/**
 * 第三者 Provider の事前互換検査（`tools/private-provider-precheck.ts`、`docs/zktls-router-thirdparty.md` §4.1・§5 T-3P1）の wire。
 * lab は不要: 実行時に作る試験用 CA（`tests/fixtures/tls/generate.ts`、openssl）で TLS 1.2 固定・`ECDHE-ECDSA-AES128-GCM-SHA256` の HTTPS fixture を立て、
 * `--ca` + `--connect` で当てる。何も払わない・署名しない。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { encodePaymentRequiredHeader } from "@x402/core/http";

import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";
import { FRAMING_WARNING, MAX_RECV_BYTES, NOT_VERIFIED, parseProviderFile, precheckProvider, readProviderFile, resolveVetted, type PrecheckResult } from "../../tools/private-provider-precheck.js";

const HOST = "provider.test";
const PATH = "/paid";
const URL_OK = `https://${HOST}${PATH}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B";
const BODY_MARKER = "fixture-body-must-not-appear-in-output";
const REASON_MARKER = "Reason-Phrase-Must-Not-Appear";

type Handler = (request: { method: string; url: string; headers: Record<string, string | string[] | undefined> }, response: import("node:http").ServerResponse) => void;

function offer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "1000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" }, ...overrides };
}

function paymentRequired(accepts: readonly Record<string, unknown>[], options: { url?: string; version?: number } = {}): string {
  return encodePaymentRequiredHeader({ x402Version: options.version ?? 2, error: "payment_required", resource: { url: options.url ?? URL_OK, description: "precheck fixture", mimeType: "application/json" }, accepts } as never);
}

describe("第三者 Provider の事前互換検査（未払い・TLS 1.2 fixture。lab 不要）", () => {
  let TLS: TlsMaterial;
  let server: https.Server;
  let tls13: https.Server;
  let otherName: https.Server;
  let raw: tls.Server;
  let port = 0;
  let port13 = 0;
  let portOther = 0;
  let portRaw = 0;
  /** raw TLS fixture: 応答のバイト列そのもの（`undefined` なら何も返さず開いたままにする = timeout）。`rawHold` なら書いた後も閉じない。 */
  let rawResponse: string | undefined;
  let rawHold = false;
  let handler: Handler = () => {};
  let requests = 0;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "precheck-"));

  beforeAll(async () => {
    TLS = generateTestTls();
    const serve = (options: https.ServerOptions): Promise<[https.Server, number]> =>
      new Promise((resolve) => {
        const s = https.createServer(options, (request, response) => {
          requests += 1;
          handler({ method: request.method ?? "", url: request.url ?? "", headers: request.headers }, response);
        });
        s.listen(0, "127.0.0.1", () => resolve([s, (s.address() as { port: number }).port]));
      });
    [server, port] = await serve({ cert: TLS.provider.cert, key: TLS.provider.key, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256" });
    [tls13, port13] = await serve({ cert: TLS.provider.cert, key: TLS.provider.key, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    [otherName, portOther] = await serve({ cert: TLS.other.cert, key: TLS.other.key, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256" });
    raw = tls.createServer({ cert: TLS.provider.cert, key: TLS.provider.key, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256" }, (socket) => {
      requests += 1;
      socket.on("data", () => {
        if (rawResponse === undefined) return;
        if (rawHold) socket.write(rawResponse);
        else socket.end(rawResponse);
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", () => resolve()));
    portRaw = (raw.address() as { port: number }).port;
  }, 60_000);
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => tls13.close(resolve));
    await new Promise((resolve) => otherName.close(resolve));
    await new Promise((resolve) => raw.close(resolve));
    TLS.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    requests = 0;
  });

  const run = (overrides: Partial<Parameters<typeof precheckProvider>[0]> = {}): Promise<PrecheckResult> => precheckProvider({ url: URL_OK, ca: TLS.ca, connect: `127.0.0.1:${port}`, timeoutMs: 5000, ...overrides });
  const send402 = (response: import("node:http").ServerResponse, header: string, options: { chunked?: boolean; contentEncoding?: string } = {}): void => {
    const body = JSON.stringify({ x402Version: 2, error: BODY_MARKER });
    response.shouldKeepAlive = false;
    if (options.contentEncoding !== undefined) {
      // Content-Length 1 つでも非 identity の Content-Encoding は framing "other"（本文はそのまま: 検査は 402 のヘッダだけを見る）。
      response.writeHead(402, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "content-encoding": options.contentEncoding, "payment-required": header, connection: "close" });
      response.end(body);
      return;
    }
    if (options.chunked === true) {
      response.writeHead(402, { "content-type": "application/json", "payment-required": header, connection: "close" });
      response.write(body);
      response.end();
      return;
    }
    response.writeHead(402, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "payment-required": header, connection: "close" });
    response.end(body);
  };

  test("正: 402 + v2 + 一致 → provider.json（0600）に封筒の値、notVerified は B3/B4、出力に本文・ヘッダ値が無い。要求は lab の骨格（支払いヘッダ無し）", async () => {
    let seen: { method: string; url: string; headers: Record<string, string | string[] | undefined> } | undefined;
    const header = paymentRequired([offer({ amount: "999" })]);
    handler = (request, response) => {
      seen = request;
      send402(response, header);
    };
    const out = path.join(tmp, "ok");
    const result = await run({ outDir: out, maxAmount: "1000" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toMatchObject({ version: "private-provider-v1", method: "GET", host: HOST, path: PATH, url: URL_OK, outbound: { protocol: "x402", network: "eip155:84532", asset: USDC, payTo: PAY_TO, maxAmount: "999" }, observed: { synthetic: true, trust: "test-ca", tlsVersion: "TLSv1.2", cipher: "ECDHE-ECDSA-AES128-GCM-SHA256", status: 402, httpVersion: "HTTP/1.1", framing402: "content-length", acceptsCount: 1, maxTimeoutSeconds: 300 }, notVerified: [...NOT_VERIFIED] });
    expect(result.provider.observed).not.toHaveProperty("statusLine");
    expect(statSync(result.file!).mode & 0o777).toBe(0o600);
    expect(readProviderFile(result.file!)).toEqual(result.provider);
    const text = JSON.stringify(result);
    expect(text).not.toContain(BODY_MARKER);
    expect(text).not.toContain(header);
    // lab の骨格: GET、Host、Connection: close だけ。支払いヘッダ・Accept・User-Agent は無い。
    expect(seen).toMatchObject({ method: "GET", url: PATH });
    expect(seen?.headers["host"]).toBe(HOST);
    expect(seen?.headers["connection"]).toBe("close");
    for (const name of ["payment-signature", "accept", "user-agent", "accept-encoding"]) expect(seen?.headers[name]).toBeUndefined();
    expect(requests).toBe(1);
  });

  test("CLI: 同じ結果を stdout に JSON で出し、通過は exit 0・不通過は exit 1", async () => {
    const header = paymentRequired([offer()]);
    handler = (_request, response) => send402(response, header);
    const caFile = path.join(tmp, "ca.pem");
    writeFileSync(caFile, TLS.ca);
    // fixture は同じプロセスにあるので、CLI は非同期に起動する（同期の spawn はイベントループを止めて fixture が応答できない）。
    const cli = (args: string[]): Promise<{ status: number; json: Record<string, unknown> }> =>
      new Promise((resolve, reject) => {
        execFile(process.execPath, ["--import", "tsx", "tools/private-provider-precheck.ts", ...args], { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" }, (error, stdout) => {
          try {
            resolve({ status: error === null ? 0 : ((error as { code?: number }).code ?? 1), json: JSON.parse(stdout) as Record<string, unknown> });
          } catch (parseError) {
            reject(parseError);
          }
        });
      });
    const ok = await cli(["--url", URL_OK, "--ca", caFile, "--connect", `127.0.0.1:${port}`]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(0);
    expect(ok.json["ok"]).toBe(true);
    const bad = await cli(["--url", URL_OK, "--ca", caFile, "--connect", `127.0.0.1:${port}`, "--max-amount", "10"]);
    expect(bad.status).toBe(1);
    expect(bad.json).toMatchObject({ ok: false, reason: "no_acceptable_offer", detail: "amount_over_limit" });
  }, 60_000);

  test("負: 200 を返す → not_402（状態の数字だけ。reason phrase は成功・失敗のどちらの出力にも無い）", async () => {
    handler = (_request, response) => {
      response.statusMessage = REASON_MARKER;
      response.writeHead(200, { "content-type": "application/json", "content-length": "2", connection: "close" });
      response.end("{}");
    };
    const failed = await run();
    expect(failed).toMatchObject({ ok: false, reason: "not_402", detail: "200" });
    expect(JSON.stringify(failed)).not.toContain(REASON_MARKER);
    handler = (_request, response) => {
      response.statusMessage = REASON_MARKER;
      send402(response, paymentRequired([offer()]));
    };
    const passed = await run();
    expect(passed.ok).toBe(true);
    expect(JSON.stringify(passed)).not.toContain(REASON_MARKER);
  });

  test("負: 証明書の名前が別（other.test の証明書）→ tls_handshake（SNI・検証は host 名のまま）", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()]));
    expect(await run({ connect: `127.0.0.1:${portOther}` })).toMatchObject({ ok: false, reason: "tls_handshake" });
  });

  test("負: PAYMENT-REQUIRED が 2 つ → no_payment_required_header（ちょうど 1 つだけ）", async () => {
    handler = (_request, response) => {
      response.shouldKeepAlive = false;
      response.writeHead(402, { "content-type": "application/json", "content-length": "2", "payment-required": [paymentRequired([offer()]), paymentRequired([offer()])], connection: "close" });
      response.end("{}");
    };
    expect(await run()).toMatchObject({ ok: false, reason: "no_payment_required_header" });
  });

  test("負（raw）: obs-fold のヘッダ → recv_headers、何も返さないサーバ → timeout", async () => {
    rawResponse = `HTTP/1.1 402 Payment Required\r\nContent-Length: 2\r\nPayment-Required: ${paymentRequired([offer()])}\r\n folded\r\nConnection: close\r\n\r\n{}`;
    expect(await run({ connect: `127.0.0.1:${portRaw}` })).toMatchObject({ ok: false, reason: "recv_headers" });
    rawResponse = undefined;
    expect(await run({ connect: `127.0.0.1:${portRaw}`, timeoutMs: 1500 })).toMatchObject({ ok: false, reason: "timeout" });
    expect(requests).toBe(2);
  });

  test("負: resource.url が別 → resource_mismatch", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()], { url: `https://${HOST}/other` }));
    expect(await run()).toMatchObject({ ok: false, reason: "resource_mismatch" });
  });

  test("負: v2 ヘッダ無し（v1 の本文だけ）→ no_payment_required_header", async () => {
    handler = (_request, response) => {
      const body = JSON.stringify({ x402Version: 1, accepts: [offer()] });
      response.writeHead(402, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), connection: "close" });
      response.end(body);
    };
    expect(await run()).toMatchObject({ ok: false, reason: "no_payment_required_header" });
  });

  test("負: x402Version 1 のヘッダ → version", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()], { version: 1 }));
    expect(await run()).toMatchObject({ ok: false, reason: "version" });
  });

  test("負: Base mainnet の offer だけ → no_acceptable_offer（network）", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })]));
    expect(await run()).toMatchObject({ ok: false, reason: "no_acceptable_offer", detail: "network" });
  });

  test("負: 額が --max-amount 超 → no_acceptable_offer（amount_over_limit）。後ろの offer が通れば選ぶ", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer({ amount: "20000" })]));
    expect(await run({ maxAmount: "10000" })).toMatchObject({ ok: false, reason: "no_acceptable_offer", detail: "amount_over_limit" });
    handler = (_request, response) => send402(response, paymentRequired([offer({ amount: "20000" }), offer({ amount: "500", payTo: "0x1111111111111111111111111111111111111111" })]));
    const result = await run({ maxAmount: "10000" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider.outbound).toMatchObject({ maxAmount: "500", payTo: "0x1111111111111111111111111111111111111111" });
  });

  test("負: offer が 17 個 → too_many_offers", async () => {
    handler = (_request, response) => send402(response, paymentRequired(Array.from({ length: 17 }, () => offer())));
    expect(await run()).toMatchObject({ ok: false, reason: "too_many_offers" });
  });

  test("負: TLS 1.3 だけのサーバ → tls_handshake", async () => {
    expect(await run({ connect: `127.0.0.1:${port13}` })).toMatchObject({ ok: false, reason: "tls_handshake" });
  });

  test("負: 信頼されない証明書（--ca が別の CA）→ tls_handshake", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()]));
    const other = generateTestTls();
    try {
      expect(await run({ ca: other.ca })).toMatchObject({ ok: false, reason: "tls_handshake" });
    } finally {
      other.cleanup();
    }
  }, 30_000);

  test("負（I/O 無し）: クエリ付き・大文字・IP・port・フラグメント・非 https の URL → url_invalid。fixture に要求は届かない", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()]));
    for (const url of [`${URL_OK}?x=1`, `https://${HOST}/Paid?`, `https://PROVIDER.test${PATH}`, "https://127.0.0.1/paid", `https://${HOST}:443${PATH}`, `${URL_OK}#f`, `http://${HOST}${PATH}`, `https://${HOST}/a/../paid`, `https://${HOST}/${"a".repeat(300)}`]) {
      expect(await run({ url }), url).toMatchObject({ ok: false, reason: "url_invalid" });
    }
    expect(await run({ maxAmount: "0" })).toMatchObject({ ok: false, reason: "url_invalid", detail: "max_amount" });
    expect(requests).toBe(0);
  });

  test("負（I/O 無し）: --connect だけ・--ca だけ・loopback 以外の --connect → connect_invalid", async () => {
    expect(await run({ ca: undefined as never })).toMatchObject({ ok: false, reason: "connect_invalid" });
    expect(await run({ connect: undefined as never })).toMatchObject({ ok: false, reason: "connect_invalid" });
    expect(await run({ connect: "10.0.0.1:443" })).toMatchObject({ ok: false, reason: "connect_invalid", detail: "loopback_only" });
    expect(requests).toBe(0);
  });

  test("観測: 402 が chunked でも通過し、framing402 = chunked と warnings（不適合の兆候、固定文）を記録する（B3 は払うまで分からない）。Content-Length の 402 には warnings が無い", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()]), { chunked: true });
    const result = await run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.provider.observed.framing402).toBe("chunked");
      expect(result.provider.warnings).toEqual([FRAMING_WARNING]);
      expect(result.checks.find((c) => c.name.startsWith("observation: 402 framing"))?.detail).toContain("incompatibility sign");
      // 書き出した形（provider.json と同じ JSON）を読み戻しても warnings は残る。
      expect(parseProviderFile(Buffer.from(JSON.stringify(result.provider)))?.warnings).toEqual([FRAMING_WARNING]);
    }
    // Content-Length 1 つ + 非 identity の Content-Encoding = "other" も同じ warning。
    handler = (_request, response) => send402(response, paymentRequired([offer()]), { contentEncoding: "gzip" });
    const other = await run();
    expect(other.ok, JSON.stringify(other)).toBe(true);
    if (other.ok) {
      expect(other.provider.observed.framing402).toBe("other");
      expect(other.provider.warnings).toEqual([FRAMING_WARNING]);
    }
    handler = (_request, response) => send402(response, paymentRequired([offer()]));
    const plain = await run();
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect("warnings" in plain.provider).toBe(false);
      expect(plain.checks.find((c) => c.name.startsWith("observation: 402 framing"))?.detail).toBe("content-length");
    }
  });

  test("負: 受信が 16 KiB を超える 402 → recv_too_large（lab の受信予算）。閉じずに送り続ける応答でも、上限で切って timeout を待たない", async () => {
    handler = (_request, response) => {
      const body = "x".repeat(MAX_RECV_BYTES);
      response.writeHead(402, { "content-type": "text/plain", "content-length": String(body.length), "payment-required": paymentRequired([offer()]), connection: "close" });
      response.end(body);
    };
    expect(await run()).toMatchObject({ ok: false, reason: "recv_too_large" });
    // raw: Content-Length を大きく宣言して 20 KiB を送った後、閉じない。
    rawResponse = `HTTP/1.1 402 Payment Required\r\nContent-Length: 1000000\r\nConnection: keep-alive\r\n\r\n${"y".repeat(20 * 1024)}`;
    rawHold = true;
    const started = Date.now();
    expect(await run({ connect: `127.0.0.1:${portRaw}`, timeoutMs: 8000 })).toMatchObject({ ok: false, reason: "recv_too_large" });
    expect(Date.now() - started).toBeLessThan(4000);
    rawHold = false;
    rawResponse = undefined;
  });

  test("接続先の方針（hooks で名前解決を差し替え。外部ネットワーク無し）: loopback・特殊用途・自アドレスが 1 つでもあれば address_denied、解決失敗・期限は dns_failed、通れば検査済みアドレスへ 1 回だけ接続", async () => {
    const policy = (interfaces: readonly string[] = []) => ({ interfaces: () => interfaces });
    expect(await resolveVetted("x.test", { resolve: async () => ["127.0.0.1"], ...policy() })).toEqual({ ok: false, reason: "address_denied" });
    expect(await resolveVetted("x.test", { resolve: async () => ["93.184.216.34", "10.0.0.1"], ...policy() })).toEqual({ ok: false, reason: "address_denied" });
    expect(await resolveVetted("x.test", { resolve: async () => ["93.184.216.34", "::1"], ...policy() })).toEqual({ ok: false, reason: "address_denied" });
    expect(await resolveVetted("x.test", { resolve: async () => ["203.0.113.5"], ...policy() })).toEqual({ ok: false, reason: "address_denied" });
    expect(await resolveVetted("x.test", { resolve: async () => ["93.184.216.34"], ...policy(["93.184.216.34"]) })).toEqual({ ok: false, reason: "address_denied" });
    expect(await resolveVetted("x.test", { resolve: async () => [], ...policy() })).toEqual({ ok: false, reason: "dns_failed" });
    expect(await resolveVetted("x.test", { resolve: async () => { throw new Error("nx"); }, ...policy() })).toEqual({ ok: false, reason: "dns_failed" });
    expect(await resolveVetted("x.test", { resolve: () => new Promise(() => {}), dnsTimeoutMs: 200, ...policy() })).toEqual({ ok: false, reason: "dns_failed" });
    expect(await resolveVetted("x.test", { resolve: async () => ["93.184.216.34", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"], ...policy() })).toEqual({ ok: true, address: "93.184.216.34" });
    // 全経路: 解決は 1 回、接続は検査を通った先頭のアドレス（dial が記録）で、fixture へ向け直す。観測は synthetic。
    handler = (_request, response) => send402(response, paymentRequired([offer()]));
    let lookups = 0;
    const dialed: string[] = [];
    const result = await precheckProvider({ url: URL_OK, ca: TLS.ca, timeoutMs: 5000, hooksForTest: { resolve: async () => { lookups += 1; return ["93.184.216.34"]; }, interfaces: () => [], dial: (address, dialPort) => { dialed.push(`${address}:${dialPort}`); return { host: "127.0.0.1", port }; } } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(lookups).toBe(1);
    expect(dialed).toEqual(["93.184.216.34:443"]);
    if (result.ok) expect(result.provider.observed.synthetic).toBe(true);
    // 拒否されたアドレスには接続しない（dial は呼ばれない）。
    dialed.length = 0;
    expect(await precheckProvider({ url: URL_OK, ca: TLS.ca, hooksForTest: { resolve: async () => ["10.0.0.1"], interfaces: () => [], dial: (address) => { dialed.push(address); return { host: "127.0.0.1", port }; } } })).toMatchObject({ ok: false, reason: "address_denied" });
    expect(dialed).toEqual([]);
    // hooks だけ（--ca 無し）は拒否。
    expect(await precheckProvider({ url: URL_OK, hooksForTest: { resolve: async () => ["93.184.216.34"] } })).toMatchObject({ ok: false, reason: "connect_invalid" });
  });

  test("provider.json が既に 0644 であっても書き直しは 0600", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()]));
    const out = path.join(tmp, "perm");
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "provider.json"), "{}", { mode: 0o644 });
    chmodSync(path.join(out, "provider.json"), 0o644);
    expect((statSync(path.join(out, "provider.json")).mode & 0o777)).toBe(0o644);
    const result = await run({ outDir: out });
    expect(result.ok).toBe(true);
    expect(statSync(path.join(out, "provider.json")).mode & 0o777).toBe(0o600);
    expect(readProviderFile(path.join(out, "provider.json"))).toBeDefined();
    // 予測できる名前の一時ファイルや symlink が先にあっても、それを書き直さない（排他作成の一時名 → rename）。既存の `provider.json.tmp` は無傷、symlink の先も切り詰められない。
    const { symlinkSync, readdirSync, lstatSync } = await import("node:fs");
    const planted = path.join(out, "provider.json.tmp");
    writeFileSync(planted, "planted", { mode: 0o644 });
    const victim = path.join(out, "victim.txt");
    writeFileSync(victim, "victim-content", { mode: 0o600 });
    const link = path.join(out, "provider.json");
    rmSync(link);
    symlinkSync(victim, link);
    const again = await run({ outDir: out });
    expect(again.ok).toBe(true);
    expect(readFileSync(planted, "utf8")).toBe("planted");
    expect(readFileSync(victim, "utf8")).toBe("victim-content");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(statSync(link).mode & 0o777).toBe(0o600);
    expect(readProviderFile(link)).toBeDefined();
    expect(readdirSync(out).filter((name) => /\.[0-9a-f]{16}\.tmp$/.test(name))).toEqual([]);
  });

  test("readProviderFile: 改変した provider.json（クエリ付き path・url の不一致・版違い）は読まない", async () => {
    handler = (_request, response) => send402(response, paymentRequired([offer()]));
    const out = path.join(tmp, "rp");
    const result = await run({ outDir: out });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const original = JSON.parse(readFileSync(result.file!, "utf8")) as Record<string, unknown>;
    const outbound = original["outbound"] as Record<string, unknown>;
    const variants: Record<string, unknown>[] = [
      { ...original, path: "/paid?x=1" },
      { ...original, url: `https://${HOST}/elsewhere` },
      { ...original, version: "private-provider-v0" },
      { ...original, method: "POST" },
      { ...original, outbound: { ...outbound, protocol: "mpp" } },
      { ...original, outbound: { ...outbound, network: "eip155:8453" } },
      { ...original, outbound: { ...outbound, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
      { ...original, outbound: { ...outbound, payTo: "not-an-address" } },
      { ...original, outbound: { ...outbound, maxAmount: "0" } },
      { ...original, outbound: { ...outbound, maxAmount: "1e3" } },
      { ...original, observed: { ...(original["observed"] as Record<string, unknown>), synthetic: "no" } },
      { ...original, host: "PROVIDER.test" },
    ];
    for (const [index, variant] of variants.entries()) {
      const file = path.join(out, `tampered-${index}.json`);
      writeFileSync(file, JSON.stringify(variant));
      expect(readProviderFile(file), JSON.stringify(variant)).toBeUndefined();
    }
  });
});
