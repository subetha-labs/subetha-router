/**
 * SSRF 防御 A の transport（設計 T-A3〜T-A12、T-A16）。実 TCP / TLS。
 *
 * 囮（decoy）: システム解決 `S = dns.lookup("localhost", {all:true})` が返す**別の**アドレスで同じ port を聞き、
 * transport が自前の解決に落ちたらそこに届くようにする。検査済み側に誰もいない失敗経路（T-A5）では、
 * Happy Eyeballs の順序に関わらず囮に届く。
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { fetch as undiciFetch } from "undici";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createGuardedTransport,
  TransportError,
  type LookupFn,
  type TransportEvent,
} from "../../src/net/guarded-fetch.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

interface Observed {
  connections: number;
  hosts: string[];
  sni: string[];
}

interface Listener {
  readonly address: string;
  readonly port: number;
  readonly observed: Observed;
  close(): Promise<void>;
}

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function track<T extends { close(cb?: () => void): unknown }>(server: T): T {
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return server;
}

/** 接続数と Host を記録する HTTP サーバ。`mode` で body の振る舞いを変える。 */
async function listenHttp(
  address: string,
  port: number,
  mode: "ok" | "redirect" | "stall" | "reset" | "large" = "ok",
): Promise<Listener> {
  const observed: Observed = { connections: 0, hosts: [], sni: [] };
  const server = track(
    http.createServer((request, response) => {
      observed.hosts.push(request.headers.host ?? "");
      if (mode === "redirect") {
        response.writeHead(302, { location: "/elsewhere" });
        response.end();
        return;
      }
      if (mode === "stall") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
        response.write("{"); // 残りを送らない
        return;
      }
      if (mode === "reset") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
        response.write("{");
        request.socket.destroy();
        return;
      }
      if (mode === "large") {
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(chunk.length * 80) });
        let sent = 0;
        const pump = (): void => {
          while (sent < 80) {
            sent += 1;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          response.end();
        };
        pump();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }),
  );
  server.on("connection", () => {
    observed.connections += 1;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => resolve());
  });
  const bound = server.address() as net.AddressInfo;
  return {
    address,
    port: bound.port,
    observed,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 試験用の TLS 素材は実行時に openssl で作る（repo に鍵を置かない）。 */
let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});

async function listenHttps(address: string, material: { cert: Buffer; key: Buffer }): Promise<Listener> {
  const observed: Observed = { connections: 0, hosts: [], sni: [] };
  const server = track(
    https.createServer(
      {
        ...material,
        SNICallback: (servername, callback) => {
          observed.sni.push(servername);
          callback(null, tls.createSecureContext(material));
        },
      },
      (request, response) => {
        observed.hosts.push(request.headers.host ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
    ),
  );
  server.on("connection", () => {
    observed.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, address, () => resolve()));
  const bound = server.address() as net.AddressInfo;
  return { address, port: bound.port, observed, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** 注入する lookup: 呼び出しを記録し、決めた集合を返す。 */
function fixedLookup(sets: Array<Array<{ address: string; family: 4 | 6 }>>): { lookup: LookupFn; calls: Array<{ hostname: string; all: boolean }> } {
  const calls: Array<{ hostname: string; all: boolean }> = [];
  let index = 0;
  const lookup: LookupFn = (hostname, options, callback) => {
    calls.push({ hostname, all: options.all });
    const set = sets[Math.min(index, sets.length - 1)]!;
    index += 1;
    callback(null, set as LookupAddress[]);
  };
  return { lookup, calls };
}

function reporter(): { events: TransportEvent[]; report: (event: TransportEvent) => void } {
  const events: TransportEvent[] = [];
  return { events, report: (event) => events.push(event) };
}

async function expectTransportError(promise: Promise<unknown>, code: string): Promise<TransportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe(code);
    return error as TransportError;
  }
  throw new Error(`expected TransportError ${code}`);
}

/** システム解決の `localhost`。試験ごとに実行時に読む（順序も構成も仮定しない）。 */
let systemLocalhost: LookupAddress[] = [];
beforeAll(async () => {
  systemLocalhost = await new Promise<LookupAddress[]>((resolve, reject) =>
    dnsLookup("localhost", { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))),
  );
  expect(systemLocalhost.length).toBeGreaterThan(0);
});

/** `S` に含まれない loopback アドレス `V`（Linux は 127.0.0.2）。前提を検査し、満たさなければ**失敗**させる。 */
async function unusedLoopback(): Promise<string> {
  const inS = new Set(systemLocalhost.map((entry) => entry.address));
  const candidate = ["127.0.0.2", "127.0.0.3", "127.1.1.1"].find((address) => !inS.has(address));
  expect(candidate, "a loopback address outside the system resolution of localhost").toBeDefined();
  // (ii) 経路がある: 一時サーバを bind して自分で接続できる。
  const probe = http.createServer((_request, response) => response.end("x"));
  await new Promise<void>((resolve, reject) => {
    probe.once("error", (error) => reject(new Error(`cannot bind ${candidate}: ${(error as NodeJS.ErrnoException).code} (on macOS: sudo ifconfig lo0 alias ${candidate} up; acceptance runs on Linux)`)));
    probe.listen(0, candidate, () => resolve());
  });
  const probePort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: candidate!, port: probePort }, () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  // (iii) 閉じた後の接続は 1 秒以内に refused。
  const t0 = Date.now();
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: candidate!, port: probePort });
    socket.on("connect", () => reject(new Error("unexpected connect")));
    socket.on("error", (error) => {
      expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
      expect(Date.now() - t0).toBeLessThan(1000);
      resolve();
    });
  });
  return candidate!;
}

/** `S` の全アドレスで同じ port を聞く囮（除外アドレスを除く）。 */
async function decoysOn(port: number, except: string[] = []): Promise<Listener[]> {
  const decoys: Listener[] = [];
  for (const entry of systemLocalhost) {
    if (except.includes(entry.address)) continue;
    decoys.push(await listenHttp(entry.address, port, "ok"));
  }
  expect(decoys.length, "at least one decoy on the system resolution of localhost").toBeGreaterThan(0);
  return decoys;
}

describe("guarded transport: pinning (T-A3〜T-A8)", () => {
  it("T-A3: IPv4 で固定。Host は URL のホスト名、注入 lookup は 1 回、囮の接続 0", async () => {
    const fixture = await listenHttp("127.0.0.1", 0);
    const decoys = await decoysOn(fixture.port, ["127.0.0.1"]);
    const { lookup, calls } = fixedLookup([[{ address: "127.0.0.1", family: 4 }]]);
    const { events, report } = reporter();
    const transport = createGuardedTransport({ allowLoopback: true, report, lookup, interfaces: () => [] });
    const response = await transport.fetch(`http://localhost:${fixture.port}/x`, { method: "GET" }, { operation: "test" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fixture.observed.hosts).toEqual([`localhost:${fixture.port}`]);
    expect(fixture.observed.connections).toBe(1);
    expect(calls).toEqual([{ hostname: "localhost", all: true }]);
    expect(decoys.map((d) => d.observed.connections)).toEqual(decoys.map(() => 0));
    expect(events).toEqual([]);
  });

  it("T-A4: IPv6 で固定。囮は 127.0.0.1", async () => {
    const fixture = await listenHttp("::1", 0);
    const decoys = await decoysOn(fixture.port, ["::1"]);
    const { lookup } = fixedLookup([[{ address: "::1", family: 6 }]]);
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup, interfaces: () => [] });
    const response = await transport.fetch(`http://localhost:${fixture.port}/x`, undefined, { operation: "test" });
    expect(response.status).toBe(200);
    expect(fixture.observed.connections).toBe(1);
    expect(decoys.map((d) => d.observed.connections)).toEqual(decoys.map(() => 0));
  });

  it("T-A5: 検査済みに誰もいなければ失敗し、システム解決に落ちない（囮 0）。陽性対照と変異は囮に届く", async () => {
    const V = await unusedLoopback();
    // 囮を S の全アドレスの同じ port で聞く。port は囮の 1 つ目で決める。
    const first = await listenHttp(systemLocalhost[0]!.address, 0);
    const port = first.port;
    const rest = await decoysOn(port, [systemLocalhost[0]!.address]).catch(() => [] as Listener[]);
    const decoys = [first, ...rest];
    const { lookup, calls } = fixedLookup([[{ address: V, family: 4 }]]);
    const { events, report } = reporter();
    const transport = createGuardedTransport({ allowLoopback: true, report, lookup, interfaces: () => [] });
    await expectTransportError(
      transport.fetch(`http://localhost:${port}/x`, { signal: AbortSignal.timeout(3000) }, { operation: "test" }),
      "connect_failed",
    );
    expect(calls).toHaveLength(1);
    expect(decoys.map((d) => d.observed.connections)).toEqual(decoys.map(() => 0));
    expect(events.map((e) => e.code)).toEqual(["connect_failed"]);

    // 陽性対照: 固定しない素の fetch は囮に届く。port で聞いているのは囮だけなので 200 は囮が返したもの。
    // 素の fetch（undici の既定 dispatcher）は keep-alive の接続を再利用するので、ここからは接続数ではなく
    // 囮が見た要求数（Host の記録）で数える（Linux での受け入れ実行で接続数の判定が誤って落ちた。設計 §11）。
    const requestsSeen = (): number => decoys.reduce((sum, d) => sum + d.observed.hosts.length, 0);
    const control = await undiciFetch(`http://localhost:${port}/x`);
    expect(control.status).toBe(200);
    expect(requestsSeen()).toBe(1);
    expect(decoys.reduce((sum, d) => sum + d.observed.connections, 0)).toBeGreaterThanOrEqual(1);

    // 変異: 失敗したらシステム解決で再試行する transport は囮に届く（この試験が落ちる）。
    const before = requestsSeen();
    const mutant = async (url: string): Promise<Response> => {
      try {
        return await transport.fetch(url, undefined, { operation: "mutant" });
      } catch {
        return (await undiciFetch(url)) as unknown as Response;
      }
    };
    expect((await mutant(`http://localhost:${port}/x`)).status).toBe(200);
    expect(requestsSeen()).toBe(before + 1);
  });

  it("T-A6: fallback は検査済みの中だけ", async () => {
    const V = await unusedLoopback();
    const fixture = await listenHttp("127.0.0.1", 0);
    const decoys = await decoysOn(fixture.port, ["127.0.0.1"]);
    const { lookup } = fixedLookup([[{ address: V, family: 4 }, { address: "127.0.0.1", family: 4 }]]);
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup, interfaces: () => [] });
    const response = await transport.fetch(`http://localhost:${fixture.port}/x`, { signal: AbortSignal.timeout(5000) }, { operation: "test" });
    expect(response.status).toBe(200);
    expect(fixture.observed.connections).toBe(1);
    expect(decoys.map((d) => d.observed.connections)).toEqual(decoys.map(() => 0));
  });

  it("T-A7: 注入した lookup の単一形式と配列形式（undici 経由は all: true）", async () => {
    const fixture = await listenHttp("127.0.0.1", 0);
    const seen: unknown[] = [];
    const lookup: LookupFn = (hostname, options, callback) => {
      seen.push(options.all);
      callback(null, [{ address: "127.0.0.1", family: 4 }] as LookupAddress[]);
    };
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup, interfaces: () => [] });
    await transport.fetch(`http://localhost:${fixture.port}/x`, undefined, { operation: "test" });
    expect(seen).toEqual([true]);
  });

  it("T-A8: rebinding は要求単位で閉じる", async () => {
    const V = await unusedLoopback();
    const fixture = await listenHttp("127.0.0.1", 0);
    const decoys = await decoysOn(fixture.port, ["127.0.0.1"]);
    const { lookup } = fixedLookup([[{ address: "127.0.0.1", family: 4 }], [{ address: V, family: 4 }]]);
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup, interfaces: () => [] });
    const url = `http://localhost:${fixture.port}/x`;
    expect((await transport.fetch(url, undefined, { operation: "first" })).status).toBe(200);
    await expectTransportError(transport.fetch(url, { signal: AbortSignal.timeout(3000) }, { operation: "second" }), "connect_failed");
    expect(fixture.observed.connections).toBe(1);
    expect(decoys.map((d) => d.observed.connections)).toEqual(decoys.map(() => 0));
  });
});

/** undici の fetch は `TypeError: fetch failed` の `cause` に TLS / socket のエラーを入れる。 */
function innerCode(error: TransportError): string | undefined {
  const outer = error.cause as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = outer?.cause?.code ?? outer?.code;
  return typeof code === "string" ? code : undefined;
}

describe("guarded transport: policy before connecting (T-A9〜T-A11)", () => {
  it("T-A9: 解決結果が混在すれば拒否し、接続しない", async () => {
    const fixture = await listenHttp("127.0.0.1", 0);
    const { lookup, calls } = fixedLookup([[{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]]);
    const { events, report } = reporter();
    const transport = createGuardedTransport({ allowLoopback: false, report, lookup, interfaces: () => [] });
    await expectTransportError(transport.fetch(`http://provider.test:${fixture.port}/x`, undefined, { routeId: "r1", operation: "challenge" }), "destination_blocked");
    expect(calls).toHaveLength(1);
    expect(fixture.observed.connections).toBe(0);
    expect(events).toEqual([{ code: "destination_blocked", operation: "challenge", routeId: "r1", policy: expect.any(String) }]);
  });

  it("T-A10: リテラル loopback / 自アドレス / 禁止範囲 / userinfo / 非 http は接続前に拒否", async () => {
    const fixture = await listenHttp("127.0.0.1", 0);
    const { events, report } = reporter();
    const transport = createGuardedTransport({
      allowLoopback: false,
      report,
      lookup: () => {
        throw new Error("lookup must not be called for literals");
      },
      interfaces: () => ["93.184.216.34"],
    });
    for (const url of [
      `http://127.0.0.1:${fixture.port}/x`,
      `http://[::1]:${fixture.port}/x`,
      `http://[::ffff:127.0.0.1]:${fixture.port}/x`,
      `http://93.184.216.34:${fixture.port}/x`,
      `http://10.0.0.1:${fixture.port}/x`,
      `http://169.254.169.254/latest/api/token`,
      `http://user:pw@8.8.8.8:${fixture.port}/x`,
      `ftp://8.8.8.8/x`,
    ]) {
      await expectTransportError(transport.fetch(url, undefined, { operation: "test" }), "destination_blocked");
    }
    expect(fixture.observed.connections).toBe(0);
    expect(events).toHaveLength(8);
  });

  it("T-A11: redirect は呼び出し側が follow を渡しても拒否され、2 本目は出ない", async () => {
    const fixture = await listenHttp("127.0.0.1", 0, "redirect");
    const { lookup } = fixedLookup([[{ address: "127.0.0.1", family: 4 }]]);
    const { events, report } = reporter();
    const transport = createGuardedTransport({ allowLoopback: true, report, lookup, interfaces: () => [] });
    await expectTransportError(
      transport.fetch(`http://localhost:${fixture.port}/redir`, { redirect: "follow" } as RequestInit, { operation: "test" }),
      "transport_failed",
    );
    expect(fixture.observed.connections).toBe(1);
    expect(fixture.observed.hosts).toHaveLength(1);
    expect(events.map((e) => e.code)).toEqual(["transport_failed"]);
  });
});

describe("guarded transport: TLS verification stays on (T-A12)", () => {
  const vetted = fixedLookup([[{ address: "127.0.0.1", family: 4 }]]).lookup;

  it("(a) 試験用 CA が署名した provider.test の証明書: 成功、SNI と Host は別々に provider.test", async () => {
    const server = await listenHttps("127.0.0.1", TLS.provider);
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup: vetted, interfaces: () => [], tls: { ca: [TLS.ca] } });
    const response = await transport.fetch(`https://provider.test:${server.port}/x`, undefined, { operation: "test" });
    expect(response.status).toBe(200);
    expect(server.observed.sni).toEqual(["provider.test"]);
    expect(server.observed.hosts).toEqual([`provider.test:${server.port}`]);
  });

  it("(b) SAN が other.test の証明書: ホスト名不一致で失敗、HTTP 要求 0", async () => {
    const server = await listenHttps("127.0.0.1", TLS.other);
    const { events, report } = reporter();
    const transport = createGuardedTransport({ allowLoopback: true, report, lookup: vetted, interfaces: () => [], tls: { ca: [TLS.ca] } });
    const error = await expectTransportError(transport.fetch(`https://provider.test:${server.port}/x`, undefined, { operation: "test" }), "connect_failed");
    expect(innerCode(error)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(server.observed.hosts).toEqual([]);
    expect(events.map((e) => e.code)).toEqual(["connect_failed"]);
  });

  it("(c) 試験用 CA に無い証明書: 失敗、HTTP 要求 0", async () => {
    const server = await listenHttps("127.0.0.1", TLS.untrusted);
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup: vetted, interfaces: () => [], tls: { ca: [TLS.ca] } });
    const error = await expectTransportError(transport.fetch(`https://provider.test:${server.port}/x`, undefined, { operation: "test" }), "connect_failed");
    expect(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]).toContain(innerCode(error));
    expect(server.observed.hosts).toEqual([]);
  });

  it("(d) 試験用 CA を渡さなければ、CA 署名の証明書でも既定の検証で失敗する（rejectUnauthorized を触っていない）", async () => {
    const server = await listenHttps("127.0.0.1", TLS.provider);
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup: vetted, interfaces: () => [] });
    await expectTransportError(transport.fetch(`https://provider.test:${server.port}/x`, undefined, { operation: "test" }), "connect_failed");
    expect(server.observed.hosts).toEqual([]);
  });
});

describe("guarded transport: lifetime (T-A16)", () => {
  it("5 MB の body を headers の後にゆっくり読み切れる（close を待たない契約）", async () => {
    const fixture = await listenHttp("127.0.0.1", 0, "large");
    const { lookup } = fixedLookup([[{ address: "127.0.0.1", family: 4 }]]);
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {}, lookup, interfaces: () => [] });
    const response = await transport.fetch(`http://localhost:${fixture.port}/big`, { signal: AbortSignal.timeout(20_000) }, { operation: "test" });
    await new Promise((resolve) => setTimeout(resolve, 200)); // headers 後に少し待ってから読む
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(64 * 1024 * 80);
  });

  it("読まずに捨てた body は要求の timeout で閉じ、headers 後の停滞は adapter 側の報告対象（transport は 1 回も報告しない）", async () => {
    const fixture = await listenHttp("127.0.0.1", 0, "stall");
    const { lookup } = fixedLookup([[{ address: "127.0.0.1", family: 4 }]]);
    const { events, report } = reporter();
    const transport = createGuardedTransport({ allowLoopback: true, report, lookup, interfaces: () => [] });
    const response = await transport.fetch(`http://localhost:${fixture.port}/stall`, { signal: AbortSignal.timeout(500) }, { operation: "test" });
    expect(response.status).toBe(200);
    expect(events).toEqual([]);
    // 読もうとすると timeout で失敗する。adapter はこれを report(error, ctx) で 1 回報告する。
    const ctx = { operation: "test", routeId: "r1" };
    try {
      await response.text();
      throw new Error("expected the stalled body to fail");
    } catch (error) {
      transport.report(error, ctx);
    }
    expect(events).toEqual([{ code: "upstream_timeout", operation: "test", routeId: "r1", policy: expect.any(String) }]);
    // 既に報告済みの TransportError は再報告しない。
    transport.report(new TransportError("connect_failed", ctx), ctx);
    expect(events).toHaveLength(1);
  });
});
