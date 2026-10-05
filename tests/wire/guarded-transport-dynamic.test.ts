/**
 * 動的上流 URL のための transport の拡張（設計 `docs/dynamic-upstream-design.md` §3.1・§3.4・§7.3、タスク T3）。
 * 実 TCP / TLS（loopback）。**オプションを渡さない transport の挙動は変えない**ことも確かめる。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import type { AddressInfo } from "node:net";

import { afterEach, beforeAll, expect, test } from "vitest";

import { DEFAULT_DYNAMIC_LIMITS } from "../../src/config.js";
import { DynamicGate } from "../../src/core/dynamic-gate.js";
import {
  createGuardedTransport,
  TransportError,
  type GuardedTransportOptions,
  type LookupFn,
  type TransportEvent,
} from "../../src/net/guarded-fetch.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

/** 判定を通る公開アドレス（example.com のもの。**実際には接続しない**: `dialForTest` が loopback に向け直す）。 */
const PUBLIC_A = "93.184.216.34";
const PUBLIC_B = "93.184.216.35";
const CTX = { operation: "challenge", routeId: "dyn-test" };

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});

interface Upstream {
  readonly port: number;
  readonly seen: { connections: number; sni: string[]; hosts: string[]; requests: number };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

type Mode = "ok" | "big-headers" | "stream" | "stall-body" | "misdirected" | "no-content" | "reset-body" | "never-respond";

/** TLS の上流 fixture（`provider.test` の証明書）。 */
async function upstream(mode: Mode = "ok", hold?: { release?: () => void }): Promise<Upstream> {
  const seen = { connections: 0, sni: [] as string[], hosts: [] as string[], requests: 0 };
  const server = https.createServer({ key: TLS.provider.key, cert: TLS.provider.cert }, (request, response) => {
    seen.requests += 1;
    seen.hosts.push(request.headers.host ?? "");
    if (mode === "big-headers") {
      response.writeHead(402, { "content-type": "application/json", "payment-required": "x".repeat(20_000) });
      response.end("{}");
      return;
    }
    if (mode === "misdirected") {
      response.writeHead(421, { "content-type": "application/json", connection: "close" });
      response.end("{}");
      return;
    }
    if (mode === "no-content") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (mode === "reset-body") {
      response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      response.write('{"part":1,');
      setTimeout(() => response.socket?.destroy(), 50);
      return;
    }
    if (mode === "never-respond") {
      return; // headers も返さない
    }
    if (mode === "stream" || mode === "stall-body") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"part":1,');
      if (mode === "stream" && hold !== undefined) {
        hold.release = () => response.end('"part":2}');
      }
      return; // stall-body は最後まで送らない
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  server.on("secureConnection", (socket) => {
    seen.connections += 1;
    seen.sni.push((socket as unknown as { servername?: string }).servername ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closers.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, seen };
}

function lookupTo(...addresses: string[]): LookupFn {
  return (_hostname, _options, callback) => callback(null, addresses.map((address) => ({ address, family: 4 })) as LookupAddress[]);
}

function transportWith(extra: Partial<GuardedTransportOptions>, events: TransportEvent[] = []) {
  return createGuardedTransport({
    allowLoopback: false,
    report: (event) => events.push(event),
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    ...extra,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TransportError) return error.code;
    throw error;
  }
  return "no error";
}

/* ---------------------------------------------------------------- dialForTest */

test("dialForTest: 判定を通った接続だけを fixture に向け直す。SNI・証明書の検証・Host は元のホスト名のまま", async () => {
  const fixture = await upstream();
  const dialled: { hostname: string; port: number }[] = [];
  const transport = transportWith({
    lookup: lookupTo(PUBLIC_A),
    dialForTest: (target) => {
      dialled.push(target);
      return { host: "127.0.0.1", port: fixture.port };
    },
  });
  const response = await transport.fetch("https://provider.test/v1/price?symbol=ETH", { method: "GET" }, CTX);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(fixture.seen.sni).toEqual(["provider.test"]);
  expect(fixture.seen.hosts).toEqual(["provider.test"]);
  // 差し替えの前に渡る行き先は、URL のホスト名と既定のポート。
  expect(dialled).toEqual([{ hostname: "provider.test", port: 443 }]);
});

test("dialForTest があっても宛先の判定は本番と同じ: loopback・内部に解決する名前・IP リテラルは接続せずに拒否", async () => {
  const fixture = await upstream();
  let dials = 0;
  const dial = (): { host: string; port: number } => {
    dials += 1;
    return { host: "127.0.0.1", port: fixture.port };
  };
  for (const addresses of [["127.0.0.1"], ["10.0.0.5"], ["169.254.169.254"], [PUBLIC_A, "192.168.1.1"], ["::1"]]) {
    const events: TransportEvent[] = [];
    const transport = transportWith({ lookup: lookupTo(...addresses), dialForTest: dial }, events);
    expect(await codeOf(transport.fetch("https://provider.test/", { method: "GET" }, CTX)), addresses.join(",")).toBe("destination_blocked");
    expect(events.map((event) => event.code)).toEqual(["destination_blocked"]);
  }
  const literal = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: dial });
  expect(await codeOf(literal.fetch("https://127.0.0.1/", { method: "GET" }, CTX))).toBe("destination_blocked");
  expect(dials).toBe(0);
  expect(fixture.seen.connections).toBe(0);
});

test("dialForTest: 証明書がホスト名と合わなければ接続は失敗する（検証を迂回しない）", async () => {
  const fixture = await upstream();
  const transport = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }) });
  // fixture の証明書は provider.test のもの。other.test として接続すると検証で落ちる。
  expect(await codeOf(transport.fetch("https://other.test/", { method: "GET" }, CTX))).toBe("connect_failed");
  expect(fixture.seen.requests).toBe(0);
});

test("本番の入口は dialForTest を参照しない（静的検査: src/main.ts と tools/ の全ファイル）", () => {
  const files = ["src/main.ts"];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|mts|js|mjs)$/.test(name)) files.push(full);
    }
  };
  walk("tools");
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) {
    expect(readFileSync(file, "utf8"), file).not.toContain("dialForTest");
  }
});

/* ---------------------------------------------------------------- maxHeaderSize */

test("maxHeaderSize: 上限を超える応答ヘッダは失敗になる。上限を上げれば通る", async () => {
  const fixture = await upstream("big-headers");
  const dial = { lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }) };
  const small = transportWith({ ...dial, maxHeaderSize: 8 * 1024 });
  expect(await codeOf(small.fetch("https://provider.test/", { method: "GET" }, CTX))).toBe("transport_failed");
  const large = transportWith({ ...dial, maxHeaderSize: 32 * 1024 });
  const response = await large.fetch("https://provider.test/", { method: "GET" }, CTX);
  expect(response.status).toBe(402);
  expect(response.headers.get("payment-required")).toHaveLength(20_000);
  await response.text();
});

/* ---------------------------------------------------------------- DNS */

/** 呼ばれた回数と、解決を終える手段を持つ lookup。 */
function manualLookup(): { lookup: LookupFn; calls: number; finish: Array<(addresses?: string[]) => void> } {
  const state = { calls: 0, finish: [] as Array<(addresses?: string[]) => void> };
  const lookup: LookupFn = (_hostname, _options, callback) => {
    state.calls += 1;
    state.finish.push((addresses = [PUBLIC_A]) => callback(null, addresses.map((address) => ({ address, family: 4 })) as LookupAddress[]));
  };
  return Object.assign(state, { lookup });
}

test("DNS: 期限で待つのをやめる（dns_failed）。解決が終わるまで枠は埋まったまま、終わると空く", async () => {
  const dns = manualLookup();
  const events: TransportEvent[] = [];
  const transport = transportWith({ lookup: dns.lookup, dns: { timeoutMs: 200, maxInFlight: 1 } }, events);
  const started = Date.now();
  expect(await codeOf(transport.fetch("https://slow.test/", { method: "GET" }, CTX))).toBe("dns_failed");
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(180);
  expect(elapsed).toBeLessThan(1_500);
  // 待つのはやめたが、解決自体はまだ終わっていない。枠は 1 つなので次は解決を始めずに拒否する。
  expect(await codeOf(transport.fetch("https://other.test/", { method: "GET" }, CTX))).toBe("admission_refused");
  expect(dns.calls).toBe(1);
  // 解決が終わると枠が空く。
  dns.finish[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  const next = transport.fetch("https://third.test/", { method: "GET" }, CTX).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  expect(dns.calls).toBe(2);
  dns.finish[1]!(["127.0.0.1"]); // 判定で拒否させて終わらせる（接続はしない）
  await next;
  expect(events.map((event) => event.code)).toEqual(["dns_failed", "admission_refused", "destination_blocked"]);
});

test("DNS: 要求の中断でも待つのをやめる（aborted）", async () => {
  const dns = manualLookup();
  const transport = transportWith({ lookup: dns.lookup, dns: { timeoutMs: 5_000, maxInFlight: 2 } });
  const controller = new AbortController();
  const started = Date.now();
  const pending = codeOf(transport.fetch("https://slow.test/", { method: "GET", signal: controller.signal }, CTX));
  setTimeout(() => controller.abort(), 100);
  expect(await pending).toBe("aborted");
  expect(Date.now() - started).toBeLessThan(1_500);
  // 既に中断済みの signal では、解決を始めない。
  expect(await codeOf(transport.fetch("https://slow.test/", { method: "GET", signal: controller.signal }, CTX))).toBe("aborted");
  expect(dns.calls).toBe(1);
  dns.finish[0]!();
});

test("DNS: 同時実行の上限まで並行に解決でき、超えた分は解決を始めない", async () => {
  const dns = manualLookup();
  const transport = transportWith({ lookup: dns.lookup, dns: { timeoutMs: 5_000, maxInFlight: 2 } });
  const first = codeOf(transport.fetch("https://a.test/", { method: "GET" }, CTX));
  const second = codeOf(transport.fetch("https://b.test/", { method: "GET" }, CTX));
  await new Promise((resolve) => setImmediate(resolve));
  expect(dns.calls).toBe(2);
  expect(await codeOf(transport.fetch("https://c.test/", { method: "GET" }, CTX))).toBe("admission_refused");
  expect(dns.calls).toBe(2);
  dns.finish[0]!(["127.0.0.1"]);
  dns.finish[1]!(["127.0.0.1"]);
  expect(await first).toBe("destination_blocked");
  expect(await second).toBe("destination_blocked");
});

/* ---------------------------------------------------------------- admit / release */

interface Admission {
  admitted: string[][];
  releases: number;
  refuse: boolean;
  connectionsAtAdmit: number[];
}

function admission(fixture?: Upstream): Admission & { admit: NonNullable<GuardedTransportOptions["admit"]> } {
  const state: Admission = { admitted: [], releases: 0, refuse: false, connectionsAtAdmit: [] };
  return Object.assign(state, {
    admit: (addresses: readonly string[]) => {
      state.admitted.push([...addresses]);
      state.connectionsAtAdmit.push(fixture?.seen.connections ?? 0);
      if (state.refuse) return undefined;
      return {
        release: () => {
          state.releases += 1;
        },
      };
    },
  });
}

test("admit: 重複を除いた全アドレスを渡し、接続の前に呼ぶ。本文を読み終えたら 1 回だけ返す", async () => {
  const fixture = await upstream();
  const gate = admission(fixture);
  const transport = transportWith({
    lookup: lookupTo(PUBLIC_A, PUBLIC_B, PUBLIC_A),
    dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }),
    admit: gate.admit,
  });
  const response = await transport.fetch("https://provider.test/", { method: "GET" }, CTX);
  expect(gate.admitted).toEqual([[PUBLIC_A, PUBLIC_B]]);
  expect(gate.connectionsAtAdmit).toEqual([0]);
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(gate.releases).toBe(1);
});

test("admit: 枠が出なければ接続しない（admission_refused）。返すものは無い", async () => {
  const fixture = await upstream();
  const gate = admission(fixture);
  gate.refuse = true;
  const events: TransportEvent[] = [];
  const transport = transportWith(
    { lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit: gate.admit },
    events,
  );
  expect(await codeOf(transport.fetch("https://provider.test/", { method: "GET" }, CTX))).toBe("admission_refused");
  expect(fixture.seen.connections).toBe(0);
  expect(gate.releases).toBe(0);
  expect(events.map((event) => event.code)).toEqual(["admission_refused"]);
});

test("admit: 宛先の判定で拒否された要求は admit まで来ない", async () => {
  const gate = admission();
  const transport = transportWith({ lookup: lookupTo("10.0.0.5"), admit: gate.admit });
  expect(await codeOf(transport.fetch("https://provider.test/", { method: "GET" }, CTX))).toBe("destination_blocked");
  expect(gate.admitted).toEqual([]);
});

test("release: headers が返っただけでは返さない。本文が終わったときに返す", async () => {
  const hold: { release?: () => void } = {};
  const fixture = await upstream("stream", hold);
  const gate = admission(fixture);
  const transport = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit: gate.admit });
  const response = await transport.fetch("https://provider.test/", { method: "GET" }, CTX);
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // headers は返ったが本文は途中。枠はまだ使われている。
  expect(gate.releases).toBe(0);
  hold.release?.();
  expect(await response.text()).toBe('{"part":1,"part":2}');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(gate.releases).toBe(1);
});

test("release: 本文を読まずに捨てても（cancel）、要求を中断しても、1 回だけ返す", async () => {
  const fixture = await upstream("stall-body");
  const gate = admission(fixture);
  const transport = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit: gate.admit });

  const cancelled = await transport.fetch("https://provider.test/", { method: "GET" }, CTX);
  await cancelled.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(gate.releases).toBe(1);

  const controller = new AbortController();
  const aborted = await transport.fetch("https://provider.test/", { method: "GET", signal: controller.signal }, CTX);
  controller.abort();
  await aborted.text().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(gate.releases).toBe(2);
});

test("release: headers の前に失敗した要求（接続できない・期限）でも 1 回だけ返す", async () => {
  const gate = admission();
  // 誰も聞いていないポートへ向ける。
  const refused = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: 1 }), admit: gate.admit });
  expect(await codeOf(refused.fetch("https://provider.test/", { method: "GET" }, CTX))).toBe("connect_failed");
  expect(gate.releases).toBe(1);

  const fixture = await upstream();
  const mismatch = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit: gate.admit });
  expect(await codeOf(mismatch.fetch("https://other.test/", { method: "GET" }, CTX))).toBe("connect_failed");
  expect(gate.releases).toBe(2);

  // 要求が送出される前に失敗する場合（既に中断済みの signal）。接続は作られないが、取った枠は返る。
  const controller = new AbortController();
  controller.abort();
  const before = fixture.seen.connections;
  const preAborted = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit: gate.admit });
  expect(await codeOf(preAborted.fetch("https://provider.test/", { method: "GET", signal: controller.signal }, CTX))).toBe("aborted");
  expect(gate.admitted).toHaveLength(3);
  expect(gate.releases).toBe(3);
  expect(fixture.seen.connections).toBe(before);
});

/* ---------------------------------------------------------------- 静的の不変 */

test("オプションを渡さない transport は、期限つきの解決・枠・ヘッダ上限・行き先の差し替えのどれも持たない", async () => {
  // 解決が遅くても待ち続ける（期限を持たない）: 400 ms 後に答える lookup で、失敗せずに判定まで進む。
  const slow: LookupFn = (_hostname, _options, callback) => {
    setTimeout(() => callback(null, [{ address: "10.0.0.5", family: 4 }] as LookupAddress[]), 400);
  };
  const plain = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], lookup: slow });
  const started = Date.now();
  expect(await codeOf(plain.fetch("https://slow.test/", { method: "GET" }, CTX))).toBe("destination_blocked");
  expect(Date.now() - started).toBeGreaterThanOrEqual(380);

  // 並行する解決に上限が無い: 20 件を同時に出して、全部が解決まで進む。
  let calls = 0;
  const counting: LookupFn = (_hostname, _options, callback) => {
    calls += 1;
    setTimeout(() => callback(null, [{ address: "10.0.0.5", family: 4 }] as LookupAddress[]), 50);
  };
  const many = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], lookup: counting });
  const codes = await Promise.all(Array.from({ length: 20 }, () => codeOf(many.fetch("https://n.test/", { method: "GET" }, CTX))));
  expect(calls).toBe(20);
  expect(new Set(codes)).toEqual(new Set(["destination_blocked"]));

  // 中断済みの signal でも、従来どおり解決は行われる（中断の扱いは fetch に任せている）。
  let abortedCalls = 0;
  const immediate: LookupFn = (_hostname, _options, callback) => {
    abortedCalls += 1;
    callback(null, [{ address: "10.0.0.5", family: 4 }] as LookupAddress[]);
  };
  const controller = new AbortController();
  controller.abort();
  const unbounded = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], lookup: immediate });
  expect(await codeOf(unbounded.fetch("https://n.test/", { method: "GET", signal: controller.signal }, CTX))).toBe("destination_blocked");
  expect(abortedCalls).toBe(1);
});

test("オプションを渡さない transport は、20 KB の応答ヘッダを従来どおり扱う（明示の上限を持たない）", async () => {
  const fixture = await upstream("big-headers");
  // loopback を許す従来の fixture 用 transport（静的経路の試験と同じ作り）。
  const legacy = createGuardedTransport({
    allowLoopback: true,
    report: () => {},
    interfaces: () => [],
    lookup: lookupTo("127.0.0.1"),
    tls: { ca: [TLS.ca] },
  });
  // undici の既定の上限（Node の既定 16 KiB）は transport が決めたものではない。ここで固定するのは
  // 「動的用の 32 KiB が静的に漏れていない」こと: 32 KiB なら通る 20 KB のヘッダが、未指定では通らない。
  expect(await codeOf(legacy.fetch(`https://provider.test:${fixture.port}/`, { method: "GET" }, CTX))).toBe("transport_failed");
});

/* ---------------------------------------------------------------- レビュー後に足した場合分け */

test("admit: 同じアドレスの別の綴り（IPv6 の省略形・IPv4-mapped）は正規化して 1 つに畳む", async () => {
  const fixture = await upstream();
  const gate = admission(fixture);
  const lookup: LookupFn = (_hostname, _options, callback) =>
    callback(null, [
      { address: "2606:2800:220:1:0:0:0:1", family: 6 },
      { address: "2606:2800:220:1::1", family: 6 },
      { address: PUBLIC_A, family: 4 },
      { address: `::ffff:${PUBLIC_A}`, family: 6 },
    ] as LookupAddress[]);
  const transport = transportWith({ lookup, dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit: gate.admit });
  const response = await transport.fetch("https://provider.test/", { method: "GET" }, CTX);
  await response.text();
  expect(gate.admitted).toHaveLength(1);
  // 4 つの綴りが、IPv6 1 つと IPv4 1 つの 2 つになる（`ParsedAddress.text` の正規形）。
  expect(gate.admitted[0]).toEqual(["2606:2800:220:1:0:0:0:1", PUBLIC_A]);
});

test("admit を実際の門につなぐ: 1 つでも枠の無いアドレスがあれば何も取らずに拒否し、接続しない", async () => {
  const fixture = await upstream("stream", {});
  const gate = new DynamicGate({ limits: { ...DEFAULT_DYNAMIC_LIMITS, perAddressConcurrent: 1 } });
  const admit: NonNullable<GuardedTransportOptions["admit"]> = (addresses) => {
    const result = gate.admitAddresses(addresses);
    return result.ok ? result.lease : undefined;
  };
  const dial = { dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit };
  // A だけを使う要求が、本文の途中で枠を持っている。
  const holder = transportWith({ lookup: lookupTo(PUBLIC_A), ...dial });
  const held = await holder.fetch("https://provider.test/", { method: "GET" }, CTX);
  expect(gate.activeOfAddress(PUBLIC_A)).toBe(1);
  const before = fixture.seen.connections;
  // B と A に解決する名前。B は空いているが A が埋まっている。
  const both = transportWith({ lookup: lookupTo(PUBLIC_B, PUBLIC_A), ...dial });
  expect(await codeOf(both.fetch("https://provider.test/", { method: "GET" }, CTX))).toBe("admission_refused");
  expect(gate.activeOfAddress(PUBLIC_B)).toBe(0);
  expect(fixture.seen.connections).toBe(before);
  // 持っていた応答を捨てると A が空く。
  await held.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(gate.activeOfAddress(PUBLIC_A)).toBe(0);
});

test("release: 421（再送の拒否）・本文の無い応答・headers の後の切断・headers が来ないままの期限でも 1 回だけ返す", async () => {
  const cases: Array<{ mode: Mode; run: (transport: ReturnType<typeof transportWith>) => Promise<string> }> = [
    { mode: "misdirected", run: (transport) => codeOf(transport.fetch("https://provider.test/", { method: "GET" }, CTX)) },
    {
      mode: "no-content",
      run: async (transport) => {
        const response = await transport.fetch("https://provider.test/", { method: "GET" }, CTX);
        await response.text();
        return String(response.status);
      },
    },
    {
      mode: "reset-body",
      run: async (transport) => {
        const response = await transport.fetch("https://provider.test/", { method: "GET" }, CTX);
        return response.text().then(
          () => "read",
          () => "body failed",
        );
      },
    },
    { mode: "never-respond", run: (transport) => codeOf(transport.fetch("https://provider.test/", { method: "GET", signal: AbortSignal.timeout(300) }, CTX)) },
  ];
  const outcomes: string[] = [];
  for (const entry of cases) {
    const fixture = await upstream(entry.mode);
    const gate = admission(fixture);
    const transport = transportWith({ lookup: lookupTo(PUBLIC_A), dialForTest: () => ({ host: "127.0.0.1", port: fixture.port }), admit: gate.admit });
    outcomes.push(await entry.run(transport));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gate.admitted, entry.mode).toHaveLength(1);
    expect(gate.releases, entry.mode).toBe(1);
  }
  expect(outcomes).toEqual(["transport_failed", "204", "body failed", "upstream_timeout"]);
});

test("DNS: 待つのをやめた後に解決が失敗しても、未処理の例外にならず枠が空く。中断でも枠は解決が終わるまで埋まる", async () => {
  const failures: Array<(error: Error) => void> = [];
  let calls = 0;
  const lookup: LookupFn = (_hostname, _options, callback) => {
    calls += 1;
    failures.push((error) => callback(error as NodeJS.ErrnoException, []));
  };
  const events: TransportEvent[] = [];
  const transport = transportWith({ lookup, dns: { timeoutMs: 5_000, maxInFlight: 1 } }, events);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const controller = new AbortController();
    const pending = codeOf(transport.fetch("https://slow.test/", { method: "GET", signal: controller.signal }, CTX));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await pending).toBe("aborted");
    // 中断で待つのはやめたが、解決は終わっていないので枠は埋まったまま。
    expect(await codeOf(transport.fetch("https://next.test/", { method: "GET" }, CTX))).toBe("admission_refused");
    expect(calls).toBe(1);
    // 後から失敗が届く。
    failures[0]!(new Error("ENOTFOUND late"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
    // 枠が空いたので次は解決を始める。
    const next = codeOf(transport.fetch("https://next.test/", { method: "GET" }, CTX));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);
    failures[1]!(new Error("ENOTFOUND"));
    expect(await next).toBe("dns_failed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  // 失敗 1 件につき報告は 1 回。
  expect(events.map((event) => event.code)).toEqual(["aborted", "admission_refused", "dns_failed"]);
});
