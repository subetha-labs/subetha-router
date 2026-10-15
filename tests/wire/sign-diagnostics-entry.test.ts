/**
 * 署名の道具の診断（`docs/rejection-reasons-design.md` §6・§12.3・§12.4・§12.7・§13.2、要件 FR-R7・AC-R5・AC-R6 の Tempo の行。タスク R-6）。
 *
 * **実際の入口** `tools/sign-payment.ts` を子 process で動かす（`npm run sign` と同じ）。Tempo の RPC は fake（`startTempoRpc` の前に
 * 場面ごとの proxy）。preload が Tempo の既定の RPC への fetch を proxy に向け、それ以外の network を拒み、`Date.now` を固定する。
 * 鍵は乱数、cwd は空の一時ディレクトリ（`.env.local` を読まない）。実の chain・送金は無い。
 *
 * 確かめること:
 * - 送出の後の失敗（receipt の待ちが JSON-RPC の失敗・429・時間切れ）: 終了コード・stdout・stderr が記録の有無で同じ。ファイルに
 *   `signerStage:"pay_and_credential"`・`broadcast`（`accepted`・`http_error`・`timeout`）・送った raw tx から手元で計算した `txRef` が残る
 * - 送る前の失敗 → `broadcast:"not_observed"`、`txRef` なし
 * - 成功: RPC の結果の tx hash（canary）は記録に入らず、計算した hash だけ（§12.4）。`outcome:"signed"`
 * - 拒否・鍵なしの `process.exit(2)` の前にも flush される
 * - raw tx・鍵・RPC の応答の値（canary）が記録に出ない
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Challenge } from "mppx";
import { keccak256, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { quoteHashOf, validateDiagRecord, type DiagRecord } from "../../src/shared/diagnostics.js";
import { startTempoRpc, type TempoRpc } from "../fixtures/dynamic/tempo-rpc.js";

const repo = path.resolve(import.meta.dirname, "../..");
const ENTRY = path.join(repo, "tools/sign-payment.ts");
const PRELOAD = path.join(repo, "tests/fixtures/sign-entry-preload.ts");
const TSX = import.meta.resolve("tsx");

const FROZEN_NOW_MS = 1_800_000_000_000;
const EXPIRES = Math.floor(FROZEN_NOW_MS / 1000) + 600;
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const QUOTE_ID = `0x${"ab".repeat(32)}`;
const PAYMENT_ID = "00000000-0000-4000-8000-000000000006";
const KEY = generatePrivateKey();
/** RPC の応答の値の canary（記録に出てはいけない）。 */
const CANARY_HASH = `0x${"ca".repeat(32)}`;
const CANARY_BODY = "CANARY-RPC-BODY-7f3e";

type Mode = "ok_canary" | "receipt_error" | "receipt_429" | "receipt_stall" | "before_send_503";

function tempoOffer(): Record<string, unknown> {
  const challenge = Challenge.serialize(
    Challenge.from({ id: QUOTE_ID, realm: "r", method: "tempo", intent: "charge", expires: new Date((EXPIRES - 1) * 1000).toISOString(), request: { amount: "10000", currency: PATHUSD, recipient: RECEIVER, methodDetails: { chainId: 42431 } } } as never) as never,
  );
  return { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { challengeNonce: QUOTE_ID, challenge, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true } };
}
const QUOTE = JSON.stringify({ quoteId: QUOTE_ID, paymentId: PAYMENT_ID, routeId: "md-x402-eth-snapshot", source: { offer: tempoOffer() } });

/** 場面ごとに振る舞いを変える proxy（送金の method だけを差し替え、ほかは fixture に渡す）。 */
interface Proxy {
  readonly url: string;
  mode: Mode;
  readonly stalled: http.ServerResponse[];
  close(): Promise<void>;
}
async function startProxy(rpc: TempoRpc): Promise<Proxy> {
  const state: { mode: Mode } = { mode: "receipt_error" };
  const stalled: http.ServerResponse[] = [];
  const forward = async (body: string): Promise<string> => {
    const response = await fetch(rpc.plainUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
    return await response.text();
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const call = JSON.parse(body) as { id?: unknown; method?: string };
        const sending = call.method === "eth_sendRawTransaction" || call.method === "eth_sendRawTransactionSync";
        const json = (status: number, value: unknown): void => {
          const text = JSON.stringify(value);
          response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
          response.end(text);
        };
        if (!sending) {
          if (state.mode === "before_send_503") {
            response.writeHead(503, { "content-type": "text/plain" });
            response.end(CANARY_BODY);
            return;
          }
          json(200, JSON.parse(await forward(body)));
          return;
        }
        // 送金: fixture に送る（raw を受けた = 送出が起きた）。応答は場面ごと。
        const answered = JSON.parse(await forward(body)) as { result?: Record<string, unknown> };
        switch (state.mode) {
          case "ok_canary":
            json(200, { ...answered, result: { ...answered.result, transactionHash: CANARY_HASH } });
            return;
          case "receipt_error":
            json(200, { jsonrpc: "2.0", id: call.id ?? null, error: { code: 4, message: `timed out waiting for the receipt ${CANARY_BODY}` } });
            return;
          case "receipt_429":
            response.writeHead(429, { "content-type": "text/plain", "retry-after": "30" });
            response.end(CANARY_BODY);
            return;
          case "receipt_stall":
            stalled.push(response);
            return;
          default:
            json(500, {});
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get mode() {
      return state.mode;
    },
    set mode(value: Mode) {
      state.mode = value;
    },
    stalled,
    close: async () => {
      for (const r of stalled.splice(0)) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let rpc: TempoRpc;
let proxy: Proxy;
const temps: string[] = [];
beforeAll(async () => {
  rpc = await startTempoRpc();
  proxy = await startProxy(rpc);
});
afterAll(async () => {
  await proxy.close();
  await rpc.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly records: DiagRecord[];
  readonly fileText: string;
  readonly filePath: string;
}

/** 実際の入口を動かす。`diagnostics` が true なら `SUBETHA_SIGN_DIAGNOSTICS` に一時のパスを渡す。 */
async function runEntry(argument: string, options: { diagnostics: boolean; key?: string | undefined }): Promise<Ran> {
  const dir = mkdtempSync(path.join(tmpdir(), "r6-sign-"));
  temps.push(dir);
  const filePath = path.join(dir, "diag", "signer.ndjson");
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: dir,
    R6_TEMPO_RPC_URL: proxy.url,
    R6_FROZEN_NOW_MS: String(FROZEN_NOW_MS),
    ...(options.key === undefined ? {} : { SUBETHA_PAYER_PRIVATE_KEY: options.key }),
    ...(options.diagnostics ? { SUBETHA_SIGN_DIAGNOSTICS: filePath } : {}),
  };
  const child = spawn(process.execPath, ["--import", TSX, "--import", PRELOAD, ENTRY, argument], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  const fileText = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const records = fileText
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const record = validateDiagRecord(JSON.parse(line));
      expect(record, line).toBeDefined();
      return record!;
    });
  return { code, stdout, stderr, records, fileText, filePath };
}

/** 記録の有無で、終了コード・stdout・stderr が同じ（tsx の一時ディレクトリの名前は除く）。 */
function expectSameOutputs(withSink: Ran, without: Ran): void {
  expect(withSink.code).toBe(without.code);
  expect(withSink.stdout).toBe(without.stdout);
  expect(withSink.stderr).toBe(without.stderr);
  expect(without.fileText).toBe("");
}

/** 鍵・raw tx・RPC の応答の canary が記録に出ない。 */
function expectNoCanaries(ran: Ran, raw: Hex | undefined): void {
  expect(ran.fileText).not.toContain(KEY.slice(2));
  expect(ran.fileText).not.toContain(CANARY_HASH.slice(2));
  expect(ran.fileText).not.toContain(CANARY_BODY);
  expect(ran.fileText).not.toContain(QUOTE_ID.slice(2));
  if (raw !== undefined) expect(ran.fileText).not.toContain(raw.slice(2, 200));
}

const sends = (): Hex[] => rpc.sentRaw.slice();

describe("npm run sign の診断（実際の入口、fake の Tempo の RPC）", () => {
  test("送出の後に receipt の待ちが失敗（HTTP 200 の JSON-RPC の失敗）: 出力は記録の有無で同じ、記録に pay_and_credential・accepted・計算した txRef", async () => {
    proxy.mode = "receipt_error";
    const before = sends().length;
    const without = await runEntry(QUOTE, { diagnostics: false, key: KEY });
    const withSink = await runEntry(QUOTE, { diagnostics: true, key: KEY });
    const sent = sends().slice(before);
    // 両方の実行で同じ raw tx が 1 回ずつ送られた（`Date.now` の固定で同じ tx）。
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(without.code).toBe(1);
    expect(without.stdout).toBe("");
    expect(without.stderr).toContain("MPP: about to send 10000");
    expectSameOutputs(withSink, without);
    // ファイルは 0600。
    expect(statSync(withSink.filePath).mode & 0o777).toBe(0o600);
    const last = withSink.records.at(-1)!;
    expect(last).toMatchObject({ component: "signer", stage: "sign", signerStage: "pay_and_credential", broadcast: "accepted", rpcHttpStatus: 200, outcome: "threw", txRef: keccak256(sent[1]!).toLowerCase(), quoteHash: quoteHashOf(QUOTE_ID), paymentId: PAYMENT_ID });
    expect(withSink.records.map((r) => r.signerStage)).toEqual(expect.arrayContaining(["dispatch", "key_read", "payer_create", "disclosure_written", "pay_and_credential"]));
    expect(withSink.records.some((r) => r.broadcast === "attempted" && r.txRef === keccak256(sent[1]!).toLowerCase())).toBe(true);
    expect(withSink.records.every((r) => r.txRefCheck === undefined)).toBe(true);
    expectNoCanaries(withSink, sent[1]);
  }, 60_000);

  test("AC-R6 Tempo の行: 送出の応答が 429 → broadcast http_error・rpc rate_limited・rpcHttpStatus 429・txRef", async () => {
    proxy.mode = "receipt_429";
    const before = sends().length;
    const without = await runEntry(QUOTE, { diagnostics: false, key: KEY });
    const withSink = await runEntry(QUOTE, { diagnostics: true, key: KEY });
    const sent = sends().slice(before);
    expect(sent).toHaveLength(2);
    expectSameOutputs(withSink, without);
    expect(withSink.code).toBe(1);
    expect(withSink.records.at(-1)).toMatchObject({ signerStage: "pay_and_credential", broadcast: "http_error", rpc: "rate_limited", rpcHttpStatus: 429, outcome: "threw", txRef: keccak256(sent[1]!).toLowerCase() });
    expectNoCanaries(withSink, sent[1]);
  }, 60_000);

  test("送出の後に応答が止まる（viem の期限）→ broadcast timeout・rpc timeout・txRef", async () => {
    proxy.mode = "receipt_stall";
    const before = sends().length;
    const without = await runEntry(QUOTE, { diagnostics: false, key: KEY });
    const withSink = await runEntry(QUOTE, { diagnostics: true, key: KEY });
    const sent = sends().slice(before);
    expect(sent).toHaveLength(2);
    expectSameOutputs(withSink, without);
    expect(withSink.code).toBe(1);
    expect(withSink.records.at(-1)).toMatchObject({ signerStage: "pay_and_credential", broadcast: "timeout", rpc: "timeout", outcome: "threw", txRef: keccak256(sent[1]!).toLowerCase() });
    expectNoCanaries(withSink, sent[1]);
  }, 90_000);

  test("送る前の失敗（RPC が 503）→ broadcast not_observed、txRef なし、送出なし", async () => {
    proxy.mode = "before_send_503";
    const before = sends().length;
    const without = await runEntry(QUOTE, { diagnostics: false, key: KEY });
    const withSink = await runEntry(QUOTE, { diagnostics: true, key: KEY });
    expect(sends().length).toBe(before);
    expectSameOutputs(withSink, without);
    expect(withSink.code).toBe(1);
    const last = withSink.records.at(-1)!;
    expect(last).toMatchObject({ signerStage: "pay_and_credential", broadcast: "not_observed", outcome: "threw" });
    expect(withSink.records.every((r) => r.txRef === undefined)).toBe(true);
    expectNoCanaries(withSink, undefined);
  }, 60_000);

  test("成功: stdout・stderr は記録の有無で同じ、記録は outcome signed・done・accepted と計算した txRef だけ（RPC の結果の hash は残らない）", async () => {
    proxy.mode = "ok_canary";
    const before = sends().length;
    const without = await runEntry(QUOTE, { diagnostics: false, key: KEY });
    const withSink = await runEntry(QUOTE, { diagnostics: true, key: KEY });
    const sent = sends().slice(before);
    expect(sent).toHaveLength(2);
    expectSameOutputs(withSink, without);
    expect(without.code).toBe(0);
    expect(without.stdout).toMatch(/^[A-Za-z0-9+/=]+\n$/);
    // 通常の経路（payer）は RPC の結果の hash を stderr に出す（今と同じ）。記録には出ない。
    expect(without.stderr).toContain(`/ tx ${CANARY_HASH}`);
    expect(withSink.records.at(-1)).toMatchObject({ signerStage: "done", outcome: "signed", broadcast: "accepted", txRef: keccak256(sent[1]!).toLowerCase() });
    expectNoCanaries(withSink, sent[1]);
  }, 60_000);

  test("拒否（失効した offer）と鍵なしの exit 2 の前にも flush される（stderr は記録の有無で同じ）", async () => {
    const expired = JSON.stringify({ quoteId: QUOTE_ID, source: { offer: { ...tempoOffer(), extra: { ...(tempoOffer()["extra"] as object), expiresAt: Math.floor(FROZEN_NOW_MS / 1000) - 1 } } } });
    const refusedWithout = await runEntry(expired, { diagnostics: false, key: KEY });
    const refused = await runEntry(expired, { diagnostics: true, key: KEY });
    expectSameOutputs(refused, refusedWithout);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/^Refusing to sign: /);
    expect(refused.records.at(-1)).toMatchObject({ signerStage: "refused", broadcast: "not_observed" });
    expect(refused.records.at(-1)?.outcome).toBeUndefined();

    const before = sends().length;
    const noKeyWithout = await runEntry(QUOTE, { diagnostics: false });
    const noKey = await runEntry(QUOTE, { diagnostics: true });
    expect(sends().length).toBe(before);
    expectSameOutputs(noKey, noKeyWithout);
    expect(noKey.code).toBe(2);
    expect(noKey.stderr).toBe("SUBETHA_PAYER_PRIVATE_KEY is not set. Run `npm run wallet:new` to create one.\n");
    expect(noKey.records.at(-1)).toMatchObject({ signerStage: "key_read", broadcast: "not_observed" });
  }, 60_000);
});
