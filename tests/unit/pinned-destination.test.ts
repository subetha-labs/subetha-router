/**
 * 増分 v1.5（proxy 型）T-X3: 宛先の固定（`src/net/pinned-destination.ts`、`docs/zktls-router-proxy-design.md` §4.1、要件 FR-X05・FR-X06）。
 * `guarded-fetch.ts` は payer の vendor の写しと同じに保つため変えない。名前の deny list（`parseUpstreamUrl`）は pin の前に購入の段で済む。
 */
import { createServer, type Server } from "node:http";
import { inspect } from "node:util";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { TransportError, type GuardedTransportOptions, type LookupFn } from "../../src/net/guarded-fetch.js";
import { createDestinationPinner, type DestinationPinnerOptions } from "../../src/net/pinned-destination.js";
import { FIXTURE_PUBLIC_ADDRESS, publicLookup } from "../fixtures/dynamic/dial.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function countingLookup(answers: () => readonly string[]): { lookup: LookupFn; calls: () => number } {
  let calls = 0;
  return {
    lookup: (_hostname, _options, callback) => {
      calls += 1;
      callback(null, answers().map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
    },
    calls: () => calls,
  };
}

function gate(limit = 1): { admit: NonNullable<GuardedTransportOptions["admit"]>; inUse: () => number; admitted: string[][]; releases: () => number } {
  let inUse = 0;
  let releases = 0;
  const admitted: string[][] = [];
  return {
    admit: (addresses) => {
      if (inUse >= limit) return undefined;
      inUse += 1;
      admitted.push([...addresses]);
      return { release: () => { inUse -= 1; releases += 1; } };
    },
    inUse: () => inUse,
    admitted,
    releases: () => releases,
  };
}

function pinner(extra: Partial<DestinationPinnerOptions> = {}) {
  return createDestinationPinner({ report: () => {}, lookup: publicLookup(), interfaces: () => [], dns: { timeoutMs: 1_000, maxInFlight: 4 }, ...extra });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    return error instanceof TransportError ? error.code : `other:${String(error)}`;
  }
}

async function server(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const s = createServer((_req, res) => {
    hits += 1;
    res.writeHead(402, { "content-type": "application/json", "content-length": "2" });
    res.end("{}");
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  return { port: (s.address() as AddressInfo).port, hits: () => hits };
}

const CTX = { operation: "private_proxy_pin", routeId: "p" };

describe("分類", () => {
  test.each<[string, readonly string[], string]>([
    ["loopback", ["127.0.0.1"], "destination_blocked"],
    ["private (DENY4)", ["10.0.0.5"], "destination_blocked"],
    ["link-local", ["169.254.169.254"], "destination_blocked"],
    ["IPv6 loopback", ["::1"], "destination_blocked"],
    ["IPv6 ULA (DENY6)", ["fd00::1"], "destination_blocked"],
    ["IPv4-mapped IPv6 の loopback", ["::ffff:127.0.0.1"], "destination_blocked"],
    ["1 つだけ禁止（他は公開）", [FIXTURE_PUBLIC_ADDRESS, "10.1.2.3"], "destination_blocked"],
    ["回答 0 件", [], "dns_failed"],
  ])("拒否: %s（枠は取らない）", async (_name, answers, code) => {
    const g = gate();
    expect(await codeOf(pinner({ lookup: publicLookup({ "provider.test": answers }), admit: g.admit }).pinDestination("provider.test", CTX))).toBe(code);
    expect(g.admitted).toEqual([]);
  });
  test("Router 自身のアドレス（own_address）は拒否", async () => {
    expect(await codeOf(pinner({ lookup: publicLookup({ "provider.test": ["203.0.113.7"] }), interfaces: () => ["203.0.113.7"] }).pinDestination("provider.test", CTX))).toBe("destination_blocked");
  });
  test("拒否は report に固定の code で出る（宛先は出さない）", async () => {
    const events: unknown[] = [];
    await codeOf(pinner({ lookup: publicLookup({ "provider.test": ["10.0.0.5"] }), report: (event) => events.push(event) }).pinDestination("provider.test", CTX));
    expect(events).toEqual([{ code: "destination_blocked", operation: "private_proxy_pin", routeId: "p", policy: expect.any(String) }]);
    expect(JSON.stringify(events)).not.toContain("10.0.0.5");
  });
  test("解決の失敗・期限・同時数の上限", async () => {
    const failing: LookupFn = (_h, _o, cb) => cb(Object.assign(new Error("nx"), { code: "ENOTFOUND" }), []);
    expect(await codeOf(pinner({ lookup: failing }).pinDestination("provider.test", CTX))).toBe("dns_failed");
    const hanging: LookupFn = () => {};
    const slow = pinner({ lookup: hanging, dns: { timeoutMs: 50, maxInFlight: 1 } });
    expect(await codeOf(slow.pinDestination("provider.test", CTX))).toBe("dns_failed");
    // 待つのをやめた解決は終わるまで枠を持つ → 次は同時数の上限。
    expect(await codeOf(slow.pinDestination("provider.test", CTX))).toBe("admission_refused");
  });
});

describe("選び方・枠・差し替え", () => {
  test("最初の IPv4 を選ぶ（IPv6 が先でも）。IPv4 が無ければ最初の IPv6", async () => {
    const pinned = await pinner({ lookup: publicLookup({ "provider.test": ["2606:2800:220:1:248:1893:25c8:1946", FIXTURE_PUBLIC_ADDRESS, "93.184.216.35"] }) }).pinDestination("provider.test", CTX);
    expect(pinned.vettedAddress).toBe(FIXTURE_PUBLIC_ADDRESS);
    expect(pinned.dialAddr).toBe(`${FIXTURE_PUBLIC_ADDRESS}:443`);
    expect(pinned.pin).toMatchObject({ host: "provider.test", address: { text: FIXTURE_PUBLIC_ADDRESS, family: 4 } });
    expect(Object.hasOwn(pinned.pin, "dial")).toBe(false);
    const pinned6 = await pinner({ lookup: publicLookup({ "provider.test": ["2606:2800:220:1:248:1893:25c8:1946"] }) }).pinDestination("provider.test", CTX);
    expect(pinned6.dialAddr).toBe("[2606:2800:220:1:248:1893:25c8:1946]:443");
  });
  test("枠は選んだ 1 アドレスにだけ取り、release は冪等", async () => {
    const g = gate();
    const pinned = await pinner({ admit: g.admit }).pinDestination("provider.test", CTX);
    expect(g.admitted).toEqual([[FIXTURE_PUBLIC_ADDRESS]]);
    expect(g.inUse()).toBe(1);
    pinned.release();
    pinned.release();
    expect(g.inUse()).toBe(0);
    expect(g.releases()).toBe(1);
  });
  test("枠が取れなければ admission_refused", async () => {
    expect(await codeOf(pinner({ admit: gate(0).admit }).pinDestination("provider.test", CTX))).toBe("admission_refused");
  });
  test("dialForTest: 値ならその host:port、undefined なら選んだアドレス:443、例外なら枠を返して connect_failed", async () => {
    const mapped = await pinner({ dialForTest: () => ({ host: "127.0.0.1", port: 4567 }) }).pinDestination("provider.test", CTX);
    expect(mapped.dialAddr).toBe("127.0.0.1:4567");
    expect(mapped.pin.dial).toEqual({ host: "127.0.0.1", port: 4567 });
    expect(mapped.vettedAddress).toBe(FIXTURE_PUBLIC_ADDRESS);
    const passthrough = await pinner({ dialForTest: () => undefined }).pinDestination("provider.test", CTX);
    expect(passthrough.dialAddr).toBe(`${FIXTURE_PUBLIC_ADDRESS}:443`);
    const g = gate();
    expect(await codeOf(pinner({ admit: g.admit, dialForTest: () => { throw new Error("no route"); } }).pinDestination("provider.test", CTX))).toBe("connect_failed");
    expect(g.inUse()).toBe(0);
    expect(g.releases()).toBe(1);
  });
});

describe("固定した宛先の transport", () => {
  test("名前解決 0 回・枠 0 回・dialForTest 0 回で pin の接続先へ。答えが変わる dialForTest でも接続先は同じ", async () => {
    const a = await server();
    const b = await server();
    const lookup = countingLookup(() => [FIXTURE_PUBLIC_ADDRESS]);
    const g = gate(1);
    let dialCalls = 0;
    const dialForTest: NonNullable<GuardedTransportOptions["dialForTest"]> = () => {
      dialCalls += 1;
      return { host: "127.0.0.1", port: dialCalls === 1 ? a.port : b.port };
    };
    const pinned = await pinner({ lookup: lookup.lookup, admit: g.admit, dialForTest }).pinDestination("provider.test", CTX);
    expect([lookup.calls(), dialCalls, g.inUse()]).toEqual([1, 1, 1]);
    for (let i = 0; i < 2; i += 1) {
      const response = await pinned.transport.fetch("http://provider.test/select", { method: "GET" }, { operation: "private_probe", routeId: "p" });
      expect(response.status).toBe(402);
      await response.text();
    }
    expect(lookup.calls()).toBe(1); // 引き直さない。
    expect(dialCalls).toBe(1); // 差し替えも呼び直さない。
    expect(g.inUse()).toBe(1); // 枠は pin の 1 つだけ（同時 1 でも探りが通る）。
    expect(g.admitted.length).toBe(1);
    expect([a.hits(), b.hits()]).toEqual([2, 0]);
    pinned.release();
    expect(g.inUse()).toBe(0);
  });
  test("別のホスト名には接続しない（入口で拒否。元の名前解決も呼ばない）", async () => {
    const c = await server();
    const lookup = countingLookup(() => [FIXTURE_PUBLIC_ADDRESS]);
    const pinned = await pinner({ lookup: lookup.lookup, dialForTest: () => ({ host: "127.0.0.1", port: c.port }) }).pinDestination("provider.test", CTX);
    expect(await codeOf(pinned.transport.fetch("http://other.test/", { method: "GET" }, { operation: "private_probe" }))).toBe("destination_blocked");
    expect(lookup.calls()).toBe(1);
    expect(c.hits()).toBe(0);
  });
  test.each<[string, string]>([
    ["IP を直接書いた URL", "http://198.51.100.9/select"],
    ["別のポート", "http://provider.test:8443/select"],
    ["別の scheme", "ftp://provider.test/select"],
    ["userinfo", "http://user:pw@provider.test/select"],
  ])("入口で拒否: %s（接続しない）", async (_name, url) => {
    const c = await server();
    const lookup = countingLookup(() => [FIXTURE_PUBLIC_ADDRESS]);
    const pinned = await pinner({ lookup: lookup.lookup, dialForTest: () => ({ host: "127.0.0.1", port: c.port }) }).pinDestination("provider.test", CTX);
    expect(await codeOf(pinned.transport.fetch(url, { method: "GET" }, { operation: "private_probe" }))).toBe("destination_blocked");
    expect(c.hits()).toBe(0);
    expect(lookup.calls()).toBe(1);
  });
  test("試験の差し替えが無い構成（本番の形）では http を拒否し https だけ", async () => {
    const pinned = await pinner().pinDestination("provider.test", CTX);
    expect(await codeOf(pinned.transport.fetch("http://provider.test/select", { method: "GET" }, { operation: "private_probe" }))).toBe("destination_blocked");
  });
});

describe("例外にアドレスを残さない（cause を落とす）", () => {
  const CANARY = "10.9.8.7";
  test("解決の失敗の例外（アドレスを含む）は cause に残らない", async () => {
    const leaky: LookupFn = (_h, _o, cb) => cb(Object.assign(new Error(`lookup failed near ${CANARY}`), { code: "ENOTFOUND" }), []);
    let caught: unknown;
    try {
      await pinner({ lookup: leaky }).pinDestination("provider.test", CTX);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransportError);
    expect((caught as Error).cause).toBeUndefined();
    expect(inspect(caught, { depth: 10 })).not.toContain(CANARY);
  });
  test("固定の宛先の transport の接続失敗も cause に残らない", async () => {
    // 閉じたポートへ差し替えて接続を失敗させる（例外の中身に 127.0.0.1:port が入る経路）。
    const closed = await server();
    const port = closed.port;
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    const pinned = await pinner({ dialForTest: () => ({ host: "127.0.0.1", port }) }).pinDestination("provider.test", CTX);
    let caught: unknown;
    try {
      await pinned.transport.fetch("http://provider.test/select", { method: "GET" }, { operation: "private_probe" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransportError);
    expect((caught as Error).cause).toBeUndefined();
    expect(inspect(caught, { depth: 10 })).not.toContain(String(port));
    expect(inspect(caught, { depth: 10 })).not.toContain("127.0.0.1");
  });
});
