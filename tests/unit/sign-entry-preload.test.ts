/**
 * 試験の preload（`tests/fixtures/sign-entry-preload.ts`）が網の外に出さないこと（Codex R-6 #1）:
 * 外部の宛先・loopback でない向け直し先は拒み、loopback からの redirect は辿らない。
 */
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PRELOAD = path.resolve("tests/fixtures/sign-entry-preload.ts");
let server: http.Server;
let base = "";
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://example.com/escaped" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** preload を読み込んだ子で `fetch(url)` を 1 回して、結果の要約（status か拒否）を返す。 */
/** 非同期の子（同期の spawn は親の event loop を止め、この process の中の loopback のサーバが答えられない）。 */
function fetchInChild(url: string, env: Record<string, string> = {}): Promise<string> {
  const script = `fetch(${JSON.stringify(url)}).then((r) => console.log("status " + r.status), (e) => console.log("rejected " + e.message));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", script], { env: { PATH: process.env["PATH"] ?? "", ...env } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", () => {
      clearTimeout(guard);
      resolve(out.trim());
    });
  });
}

describe("sign-entry-preload: 網の外に出ない", () => {
  test("外部の宛先は拒む", async () => {
    expect(await fetchInChild("https://example.com/")).toContain("rejected network blocked by the test preload");
  });

  test("Tempo の RPC の向け直し先が loopback の http でなければ拒む", async () => {
    expect(await fetchInChild("https://rpc.moderato.tempo.xyz/", { R6_TEMPO_RPC_URL: "https://example.com/" })).toContain("rejected network blocked by the test preload");
    expect(await fetchInChild("https://rpc.moderato.tempo.xyz/", {})).toContain("rejected network blocked by the test preload");
  });

  test("loopback への要求は通り、Tempo の RPC は loopback の向け直し先に届く", async () => {
    hits = [];
    expect(await fetchInChild(`${base}/ok`)).toContain("status 200");
    expect(await fetchInChild("https://rpc.moderato.tempo.xyz/", { R6_TEMPO_RPC_URL: `${base}/rpc` })).toContain("status 200");
    expect(hits).toEqual(["/ok", "/rpc"]);
  });

  test("loopback から外部への redirect は辿らない（302 のまま返る）", async () => {
    expect(await fetchInChild(`${base}/redirect`)).toContain("status 302");
  });
});
