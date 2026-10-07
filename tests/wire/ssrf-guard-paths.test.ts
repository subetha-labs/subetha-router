/**
 * SSRF 防御 A: 10 経路への到達（T-A13）、headers 後の診断（T-A17）、文脈の帰属（T-A18）。
 *
 * 到達の証明: 対象の経路の要求だけを **本物のポリシー**（`allowLoopback: false` の transport）に通して拒否させ、
 * 前提の要求は fixture 向けの transport で通す。確認は `report` の `operation` と fixture の TCP 接続数。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { Challenge, Credential } from "mppx";
import { createClient as createViemClient, http as viemHttp } from "viem";
import { createMppInbound } from "../../src/adapters/inbound/mpp.js";
import { createSubethaInbound } from "../../src/adapters/inbound/subetha.js";
import { createX402Inbound } from "../../src/adapters/inbound/x402.js";
import { createMppOutbound } from "../../src/adapters/outbound/mpp.js";
import { createSyntheticX402Outbound, createX402Outbound } from "../../src/adapters/outbound/x402.js";
import { createGuardedTransport, TransportError, type GuardedTransport, type TransportEvent } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { createPayerSpy, SPY_PAYER_ADDRESS, tempoTestnet } from "../fixtures/mpp-payer-spy.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

const running: Listening[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

async function start(script: string, args: readonly string[] = []): Promise<Listening> {
  const fixture = await startListening(script, ["--port", "0", ...args]);
  running.push(fixture);
  return fixture;
}

/**
 * fixture が受けた TCP 接続数のうち、adapter によるもの。`/calls` の読み出しは keep-alive 無しの新しい接続で行い
 * （1 読み出し = 1 接続、決定的）、その分を差し引く。
 */
function connectionCounter(fixture: Listening): { adapter: () => Promise<number> } {
  let reads = 0;
  return {
    adapter: () =>
      new Promise<number>((resolve, reject) => {
        reads += 1;
        http.get(`${fixture.baseUrl}/calls`, { agent: false }, (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.on("end", () => resolve((JSON.parse(text) as { connections: number }).connections - reads));
        }).on("error", reject);
      }),
  };
}

/** fixture の `/calls`（keep-alive 無し）。 */
async function stats<T>(fixture: Listening): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    http.get(`${fixture.baseUrl}/calls`, { agent: false }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve(JSON.parse(text) as T));
    }).on("error", reject);
  });
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

/** 公開結果に transport の語彙・アドレス・URL が漏れていない（設計 §3.6: 公開応答は現状のまま）。 */
function expectSilent(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(/outbound transport|policy=|iana-|127\.0\.0\.|localhost|undici|TransportError|http:\/\//);
}

/** `report` を記録し、対象の operation だけ厳格な（loopback を拒む）本物のポリシーに通す transport。 */
function denyAt(target: string | undefined, events: TransportEvent[], timeoutMs?: number): GuardedTransport {
  const report = (event: TransportEvent): void => {
    events.push(event);
  };
  const fixture = createGuardedTransport({ allowLoopback: true, report });
  const strict = createGuardedTransport({ allowLoopback: false, report });
  void timeoutMs;
  return {
    allowLoopback: true,
    boundsDns: false,
    fetch: (url, init, ctx) => (ctx.operation === target ? strict : fixture).fetch(url, init, ctx),
    report: (error, ctx) => fixture.report(error, ctx),
  };
}

const X402 = { route: "eth-snapshot", network: "eip155:84532" };
const MPP = { route: "md-b-eth-snapshot" };

describe("reach of every outbound path (T-A13)", () => {
  it("MPP 1: readChallenge の要求 (operation=challenge)", async () => {
    const fixture = await start("tests/fixtures/mpp-upstream.ts");
    const events: TransportEvent[] = [];
    const rail = createMppOutbound({ transport: denyAt("challenge", events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: createPayerSpy().capability() });
    await expect(rail.readChallenge(MPP.route)).rejects.toBeInstanceOf(TransportError);
    expect(events).toEqual([{ code: "destination_blocked", operation: "challenge", routeId: MPP.route, policy: expect.any(String) }]);
    expect(await connectionCounter(fixture).adapter()).toBe(0); // 対象の要求は接続していない
  });

  it("MPP 2: pay の challenge 再読 (pay_challenge) → not_sent / destination_challenge_unreadable", async () => {
    const fixture = await start("tests/fixtures/mpp-upstream.ts");
    const events: TransportEvent[] = [];
    const spy = createPayerSpy();
    const probe = createMppOutbound({ transport: denyAt(undefined, []), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability() });
    const [offer] = await probe.readChallenge(MPP.route);
    const counter = connectionCounter(fixture);
    const before = await counter.adapter();
    const rail = createMppOutbound({ transport: denyAt("pay_challenge", events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability() });
    const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: "p-2", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(result).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    expectSilent(result);
    expect(events).toEqual([{ code: "destination_blocked", operation: "pay_challenge", routeId: MPP.route, policy: expect.any(String) }]);
    expect(await counter.adapter()).toBe(before); // 対象の要求は接続していない
  });

  it("MPP 3: pay の有料要求 (pay) → unknown / destination_pay_unknown。challenge 再読は接続している", async () => {
    const fixture = await start("tests/fixtures/mpp-upstream.ts");
    const events: TransportEvent[] = [];
    const spy = createPayerSpy();
    const probe = createMppOutbound({ transport: denyAt(undefined, []), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability() });
    const [offer] = await probe.readChallenge(MPP.route);
    const counter = connectionCounter(fixture);
    const before = await counter.adapter();
    const rail = createMppOutbound({ transport: denyAt("pay", events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability() });
    const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: "p-3", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expectSilent(result);
    expect(events).toEqual([{ code: "destination_blocked", operation: "pay", routeId: MPP.route, policy: expect.any(String) }]);
    expect(await counter.adapter()).toBe(before + 1); // challenge 再読の 1 本だけ。有料要求は接続していない
  });

  it("実 x402 4: readChallenge (challenge)", async () => {
    const fixture = await start("tests/fixtures/x402-upstream.ts");
    const events: TransportEvent[] = [];
    const rail = createX402Outbound({ transport: denyAt("challenge", events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: createSignerSpy().capability(X402.network) });
    await expect(rail.readChallenge(X402.route)).rejects.toBeInstanceOf(TransportError);
    expect(events.map((e) => [e.code, e.operation, e.routeId])).toEqual([["destination_blocked", "challenge", X402.route]]);
    expect(await connectionCounter(fixture).adapter()).toBe(0);
  });

  it("実 x402 5: pay の challenge 再読 (pay_challenge) → not_sent", async () => {
    const fixture = await start("tests/fixtures/x402-upstream.ts");
    const events: TransportEvent[] = [];
    const spy = createSignerSpy();
    const probe = createX402Outbound({ transport: denyAt(undefined, []), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(X402.network) });
    const [offer] = await probe.readChallenge(X402.route);
    const counter = connectionCounter(fixture);
    const before = await counter.adapter();
    const rail = createX402Outbound({ transport: denyAt("pay_challenge", events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(X402.network) });
    const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-5", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(result.outcome).toBe("not_sent");
    expectSilent(result);
    expect(events.map((e) => [e.code, e.operation])).toEqual([["destination_blocked", "pay_challenge"]]);
    expect(await counter.adapter()).toBe(before);
  });

  it("実 x402 6: pay の有料要求 (pay) → unknown / destination_pay_unknown", async () => {
    const fixture = await start("tests/fixtures/x402-upstream.ts");
    const events: TransportEvent[] = [];
    const spy = createSignerSpy();
    const probe = createX402Outbound({ transport: denyAt(undefined, []), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(X402.network) });
    const [offer] = await probe.readChallenge(X402.route);
    const counter = connectionCounter(fixture);
    const before = await counter.adapter();
    const rail = createX402Outbound({ transport: denyAt("pay", events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(X402.network) });
    const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-6", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expectSilent(result);
    expect(events.map((e) => [e.code, e.operation])).toEqual([["destination_blocked", "pay"]]);
    expect(await counter.adapter()).toBe(before + 1);
  });

  it("合成 x402 7: readChallenge (challenge)", async () => {
    const fixture = await start("tests/fixtures/upstream-server.ts", ["--pay", "ok"]);
    const events: TransportEvent[] = [];
    const rail = createSyntheticX402Outbound({ transport: denyAt("challenge", events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` } });
    await expect(rail.readChallenge(X402.route)).rejects.toBeInstanceOf(TransportError);
    expect(events.map((e) => [e.code, e.operation, e.routeId])).toEqual([["destination_blocked", "challenge", X402.route]]);
  });

  it("合成 x402 8: pay (pay) → transport の例外がそのまま上がる（core が destination_pay_unknown に写す）", async () => {
    const fixture = await start("tests/fixtures/upstream-server.ts", ["--pay", "ok"]);
    const events: TransportEvent[] = [];
    const probe = createSyntheticX402Outbound({ transport: denyAt(undefined, []), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` } });
    const [offer] = await probe.readChallenge(X402.route);
    const rail = createSyntheticX402Outbound({ transport: denyAt("pay", events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` } });
    await expect(rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-8", attempt: 1, deadlineMs: Date.now() + 600_000 })).rejects.toBeInstanceOf(TransportError);
    expect(events.map((e) => [e.code, e.operation])).toEqual([["destination_blocked", "pay"]]);
  });

  const SUBETHA = {
    chainId: 11_155_111,
    token: "0x0000000000000000000000000000000000005ce7",
    payTo: "0x0000000000000000000000000000000000000a0e",
    binding: "eth-snapshot|GET|%2Fv1%2Froutes%2Feth-snapshot%2Fresource",
  };
  async function subethaFacilitator(args: readonly string[] = []): Promise<Listening> {
    return start("tests/fixtures/facilitator-server.ts", ["--token", SUBETHA.token, "--pay-to", SUBETHA.payTo, "--chain-id", `${SUBETHA.chainId}`, ...args]);
  }
  function subethaCredential(offer: InboundOffer): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, synthetic: true } } as unknown as PaymentCredential;
  }

  it("受信 subetha 9: challenge / verify / settle の 3 操作", async () => {
    const fixture = await subethaFacilitator();
    const request = { routeId: "eth-snapshot", amount: "1000", asset: SUBETHA.token, network: `eip155:${SUBETHA.chainId}`, routeBinding: SUBETHA.binding, nowMs: Date.now() };
    const events: TransportEvent[] = [];
    const denyChallenge = createSubethaInbound({ transport: denyAt("facilitator_challenge", events), facilitatorUrl: fixture.baseUrl });
    await expect(denyChallenge.createOffer(request)).rejects.toBeInstanceOf(TransportError);
    const offer = await createSubethaInbound({ transport: denyAt(undefined, []), facilitatorUrl: fixture.baseUrl }).createOffer(request);
    const counter = connectionCounter(fixture);
    const before = await counter.adapter();
    const denyVerify = createSubethaInbound({ transport: denyAt("facilitator_verify", events), facilitatorUrl: fixture.baseUrl });
    await expect(denyVerify.verify(offer, subethaCredential(offer), { routeId: "eth-snapshot" })).rejects.toBeInstanceOf(TransportError);
    const denySettle = createSubethaInbound({ transport: denyAt("facilitator_settle", events), facilitatorUrl: fixture.baseUrl });
    await expect(denySettle.settle(offer, subethaCredential(offer), { routeId: "eth-snapshot" })).rejects.toBeInstanceOf(TransportError);
    expect(events.map((e) => [e.code, e.operation, e.routeId])).toEqual([
      ["destination_blocked", "facilitator_challenge", "eth-snapshot"],
      ["destination_blocked", "facilitator_verify", "eth-snapshot"],
      ["destination_blocked", "facilitator_settle", "eth-snapshot"],
    ]);
    expect(await counter.adapter()).toBe(before);
  });

  it("受信 x402 10: verify / settle の 2 操作（route は core の呼び出し文脈から）", async () => {
    const fixture = await start("tests/fixtures/x402-inbound-facilitator.ts");
    const routeId = "md-x402-inbound";
    const binding = [routeId, "GET", `/v1/routes/${routeId}/resource`].map(encodeURIComponent).join("|");
    const payTo = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
    const events: TransportEvent[] = [];
    const rail = (target: string) => createX402Inbound({ transport: denyAt(target, events), facilitatorUrl: fixture.baseUrl, payTo });
    const offer = await rail("none").createOffer({ routeId, amount: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", network: "eip155:84532", routeBinding: binding, nowMs: Date.now() });
    const credential = { x402Version: 2, accepted: offer, payload: { signature: "0x", authorization: {} } } as unknown as PaymentCredential;
    const counter = connectionCounter(fixture);
    const before = await counter.adapter();
    await expect(rail("facilitator_verify").verify(offer, credential, { routeId })).rejects.toBeInstanceOf(TransportError);
    await expect(rail("facilitator_settle").settle(offer, credential, { routeId })).rejects.toBeInstanceOf(TransportError);
    expect(events.map((e) => [e.code, e.operation, e.routeId])).toEqual([
      ["destination_blocked", "facilitator_verify", routeId],
      ["destination_blocked", "facilitator_settle", routeId],
    ]);
    expect(await counter.adapter()).toBe(before);
  });

  const MPP_INBOUND = {
    secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
    recipient: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2",
    currency: "0x20c0000000000000000000000000000000000000",
    chainId: 42_431,
    routeId: "md-mpp-inbound",
  };

  it("受信 MPP 11: SDK の JSON-RPC（receipt の照合）が transport を通る（operation=rpc、route は呼び出し文脈）", async () => {
    const rpc = await start("tests/fixtures/rpc-server.ts", ["--chain-id", `${MPP_INBOUND.chainId}`]);
    const events: TransportEvent[] = [];
    const { routeId } = MPP_INBOUND;
    const binding = [routeId, "GET", `/v1/routes/${routeId}/resource`].map(encodeURIComponent).join("|");
    const railWith = (target: string | undefined) =>
      createMppInbound({
        transport: denyAt(target, events),
        rpcUrl: rpc.baseUrl,
        secretKey: MPP_INBOUND.secret,
        recipient: MPP_INBOUND.recipient,
        currency: MPP_INBOUND.currency,
        chainId: MPP_INBOUND.chainId,
        maxTimeoutSeconds: 600,
        realm: "router-test",
      });
    const offer = await railWith(undefined).createOffer({ routeId, amount: "10000", asset: MPP_INBOUND.currency, network: `eip155:${MPP_INBOUND.chainId}`, routeBinding: binding, nowMs: Date.now() });
    // push 形式（tx hash）の credential。署名は要らず、SDK は hash の receipt を **RPC で**照合しに行く（経路 11）。
    const wire = Credential.serialize(
      Credential.from({ challenge: Challenge.deserialize(offer.extra["challenge"] as string), payload: { type: "hash", hash: `0x${"11".repeat(32)}` } }),
    );
    const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, credential: wire } } as unknown as PaymentCredential;
    const counter = connectionCounter(rpc);
    const before = await counter.adapter();
    const verified = await railWith("rpc").verify(offer, credential, { routeId });
    expect(verified).toEqual({ isValid: false });
    const settled = await railWith("rpc").settle(offer, credential, { routeId });
    expect(settled).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expectSilent([verified, settled]);
    expect(events.map((e) => [e.code, e.operation, e.routeId])).toEqual([
      ["destination_blocked", "rpc", routeId],
      ["destination_blocked", "rpc", routeId],
    ]);
    expect(await counter.adapter()).toBe(before);
    // 許可側（fixture の transport）: 同じ credential で RPC fixture に eth_getTransactionReceipt が届く（receipt 無し → 既存の fail-closed 結果のまま）。
    expect(await railWith(undefined).verify(offer, credential, { routeId })).toEqual({ isValid: false });
    expect(await counter.adapter()).toBe(before + 1);
    expect((await stats<{ methods: string[] }>(rpc)).methods).toContain("eth_getTransactionReceipt");
    expect(events).toHaveLength(2);
  });

  it("送信 MPP 12: 能力の client の JSON-RPC が transport を通る（viem http transport を作り直す。operation=rpc、route は pay の文脈）", async () => {
    const rpc = await start("tests/fixtures/rpc-server.ts", ["--chain-id", `${MPP_INBOUND.chainId}`]);
    const upstream = await start("tests/fixtures/mpp-upstream.ts");
    const events: TransportEvent[] = [];
    // 能力: 鍵を持たない json-rpc account と、**HTTP の RPC**（viem `http`）を持つ client。spy と同じ stub を HTTP 越しに受ける。
    const capability = {
      chainId: MPP_INBOUND.chainId,
      account: { address: SPY_PAYER_ADDRESS, type: "json-rpc" as const },
      getClient: () => createViemClient({ chain: tempoTestnet(MPP_INBOUND.chainId), transport: viemHttp(rpc.baseUrl, { retryCount: 0 }) }),
      mode: "push" as const,
      kind: "non-signing-fixture" as const,
    };
    const railWith = (target: string | undefined) =>
      createMppOutbound({ transport: denyAt(target, events), upstreams: { [MPP.route]: `${upstream.baseUrl}/v1/eth/snapshot` }, capability, timeoutMs: 5000 });
    const [offer] = await railWith(undefined).readChallenge(MPP.route);
    const rpcCounter = connectionCounter(rpc);
    // upstream の `/calls` は 1 つの読み出し口で読み、読み出し自身の接続を差し引く（`stats` と counter を混ぜない）。
    let upstreamReads = 0;
    const readUpstream = async (): Promise<{ connections: number; payCalls: number }> => {
      upstreamReads += 1;
      const s = await stats<{ connections: number; payCalls: number }>(upstream);
      return { connections: s.connections - upstreamReads, payCalls: s.payCalls };
    };
    const rpcBefore = await rpcCounter.adapter();
    const upstreamBefore = (await readUpstream()).connections;
    // 拒否: 最初の RPC で destination_blocked。有料要求は送られない（upstream の接続は challenge 再読の 1 本だけ増える）。
    // 公開結果は既存の写像のまま: 能力に触れた後の createCredential の失敗は保守的に unknown（adapter は送金 RPC の成否を推定しない）。
    const blocked = await railWith("rpc").pay({ routeId: MPP.route, offer: offer!, paymentId: "p-12", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(blocked).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expectSilent(blocked);
    expect(events.map((e) => [e.code, e.operation, e.routeId])).toEqual([["destination_blocked", "rpc", MPP.route]]);
    expect(await rpcCounter.adapter()).toBe(rpcBefore);
    const afterBlocked = await readUpstream();
    expect(afterBlocked.payCalls).toBe(0);
    expect(afterBlocked.connections).toBe(upstreamBefore + 1);
    // 許可側: 同じ能力で RPC fixture に届き（接続 ≥ 1、method が記録される）、spy と同じ stub で支払いが完走する。
    const paid = await railWith(undefined).pay({ routeId: MPP.route, offer: offer!, paymentId: "p-12b", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(paid.outcome).toBe("paid");
    expect(await rpcCounter.adapter()).toBeGreaterThanOrEqual(rpcBefore + 1);
    expect((await stats<{ methods: string[] }>(rpc)).methods.length).toBeGreaterThan(0);
    expect((await readUpstream()).payCalls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("送信 MPP 12: 実鍵の能力が http 以外の transport の client を返したら fail closed（どこへ出るか保証できない）", async () => {
    const upstream = await start("tests/fixtures/mpp-upstream.ts");
    const events: TransportEvent[] = [];
    const spy = createPayerSpy();
    const capability = { ...spy.capability(), kind: "real-key" as const };
    const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams: { [MPP.route]: `${upstream.baseUrl}/v1/eth/snapshot` }, capability, timeoutMs: 5000 });
    const [offer] = await rail.readChallenge(MPP.route);
    const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: "p-12c", attempt: 1, deadlineMs: Date.now() + 600_000 });
    // 既存の写像（能力に触れた後の失敗は unknown）。RPC は 1 回も出ていない。
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(spy.sendAttempts()).toBe(0);
    expect(spy.rpcCalls).toEqual([]);
    expect((await stats<{ payCalls: number }>(upstream)).payCalls).toBe(0);
  });
});

describe("diagnostics after headers (T-A17)", () => {
  const SHORT = 400; // ms。停滞を早く timeout させる

  it("(a) 消費する body の停滞: 実 x402 の challenge → upstream_timeout を adapter が 1 回", async () => {
    const fixture = await start("tests/fixtures/x402-upstream.ts", ["--after-headers", "stall"]);
    const events: TransportEvent[] = [];
    const rail = createX402Outbound({ transport: denyAt(undefined, events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: createSignerSpy().capability(X402.network), timeoutMs: SHORT });
    await expect(rail.readChallenge(X402.route)).rejects.toBeDefined();
    expect(events).toEqual([{ code: "upstream_timeout", operation: "challenge", routeId: X402.route, policy: expect.any(String) }]);
  });

  it("(b) 消費する body の切断: 受信 subetha の createOffer（challenge）→ transport_failed を 1 回", async () => {
    const fixture = await start("tests/fixtures/facilitator-server.ts", ["--token", "0x0000000000000000000000000000000000005ce7", "--pay-to", "0x0000000000000000000000000000000000000a0e", "--chain-id", "11155111", "--after-headers", "reset"]);
    const events: TransportEvent[] = [];
    const inbound = createSubethaInbound({ transport: denyAt(undefined, events), facilitatorUrl: fixture.baseUrl, timeoutMs: SHORT });
    // createOffer（/challenge）も切断されるので、ここで 1 回報告される。
    await expect(inbound.createOffer({ routeId: "eth-snapshot", amount: "1000", asset: "0x0000000000000000000000000000000000005ce7", network: "eip155:11155111", routeBinding: "b", nowMs: Date.now() })).rejects.toBeDefined();
    expect(events.map((e) => [e.code, e.operation])).toEqual([["transport_failed", "facilitator_challenge"]]);
  });

  it("(c)(d) 消費しない body（MPP の 402 challenge）の停滞・切断: pay の challenge 再読（pay_challenge）は遅れず成功し、捨てた body の接続は timeout を待たずに閉じ、事象 0", async () => {
    for (const mode of ["stall", "reset"]) {
      const fixture = await start("tests/fixtures/mpp-upstream.ts", ["--after-headers", mode, "--after-headers-on", "challenge"]);
      const events: TransportEvent[] = [];
      const LONG = 5000; // 要求の timeout。cancel が無ければ停滞した接続はこれまで開いたまま
      const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: createPayerSpy().capability(), timeoutMs: LONG });
      const [offer] = await rail.readChallenge(MPP.route); // challenge（body 停滞 → 捨てる）
      const t0 = Date.now();
      const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: `p-${mode}`, attempt: 1, deadlineMs: Date.now() + 600_000 }); // pay_challenge（同じ）→ pay
      expect(result.outcome, mode).toBe("paid");
      expectSilent(result);
      expect(Date.now() - t0, mode).toBeLessThan(LONG / 2); // 停滞した challenge body を待っていない
      expect(events, mode).toEqual([]);
      // 捨てた 2 本（challenge / pay_challenge の 402 応答を書いた socket）が timeout（5 s）を待たずに閉じる = cancel が接続を解放している。
      // 観測用（/calls）と有料応答の socket は数えない（種類別に数える。M-A8 で cancel を外すとこの判定が落ちる）。
      type Closed = { closedByKind: Record<string, number>; payCalls: number };
      expect(await waitFor(async () => ((await stats<Closed>(fixture)).closedByKind["challenge"] ?? 0) >= 2, 1500), mode).toBe(true);
      const after = await stats<Closed>(fixture);
      expect(after.closedByKind["challenge"], mode).toBe(2);
      expect(after.payCalls, mode).toBe(1);
    }
  });

  it("(a)(b) 受信 subetha の verify の body 停滞・切断 → upstream_timeout / transport_failed を facilitator_verify で 1 回。verify は例外（既存: core が source_verify_unavailable に写す）", async () => {
    for (const [mode, code] of [["stall", "upstream_timeout"], ["reset", "transport_failed"]] as const) {
      const fixture = await start("tests/fixtures/facilitator-server.ts", ["--token", "0x0000000000000000000000000000000000005ce7", "--pay-to", "0x0000000000000000000000000000000000000a0e", "--chain-id", "11155111", "--after-headers", mode, "--after-headers-on", "verify"]);
      const events: TransportEvent[] = [];
      const inbound = createSubethaInbound({ transport: denyAt(undefined, events), facilitatorUrl: fixture.baseUrl, timeoutMs: SHORT });
      const offer = await inbound.createOffer({ routeId: "eth-snapshot", amount: "1000", asset: "0x0000000000000000000000000000000000005ce7", network: "eip155:11155111", routeBinding: "b", nowMs: Date.now() });
      const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, synthetic: true } } as unknown as PaymentCredential;
      await expect(inbound.verify(offer, credential, { routeId: "eth-snapshot" }), mode).rejects.toBeDefined();
      expect(events.map((e) => [e.code, e.operation, e.routeId]), mode).toEqual([[code, "facilitator_verify", "eth-snapshot"]]);
    }
  });

  it("(e)(f) 有料応答の body: MPP pay の receipt body の停滞 → upstream_timeout 1 回、切断 → transport_failed 1 回。公開結果は paid_no_data", async () => {
    for (const [mode, code] of [["stall", "upstream_timeout"], ["reset", "transport_failed"]] as const) {
      const fixture = await start("tests/fixtures/mpp-upstream.ts", ["--after-headers", mode, "--after-headers-on", "pay"]);
      const events: TransportEvent[] = [];
      const spy = createPayerSpy();
      const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(), timeoutMs: SHORT });
      const [offer] = await rail.readChallenge(MPP.route);
      const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: `p-${mode}`, attempt: 1, deadlineMs: Date.now() + 600_000 });
      expect(result.outcome, mode).toBe("paid_no_data");
      expectSilent(result);
      expect(events, mode).toEqual([{ code, operation: "pay", routeId: MPP.route, policy: expect.any(String) }]);
    }
  });

  it("(e)(f) 有料応答の body: 実 x402 pay の停滞 → upstream_timeout、切断 → transport_failed（各 1 回）。公開結果は unknown / destination_pay_unknown", async () => {
    for (const [mode, code] of [["stall", "upstream_timeout"], ["reset", "transport_failed"]] as const) {
      const fixture = await start("tests/fixtures/x402-upstream.ts", ["--after-headers", mode, "--after-headers-on", "pay"]);
      const events: TransportEvent[] = [];
      const spy = createSignerSpy();
      const rail = createX402Outbound({ transport: denyAt(undefined, events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(X402.network), timeoutMs: SHORT });
      const [offer] = await rail.readChallenge(X402.route);
      const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: `p-x-${mode}`, attempt: 1, deadlineMs: Date.now() + 600_000 });
      expect(result, mode).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
      expectSilent(result);
      expect(events, mode).toEqual([{ code, operation: "pay", routeId: X402.route, policy: expect.any(String) }]);
    }
  });

  it("(e)(f) 合成 x402 pay の停滞 → upstream_timeout、切断 → transport_failed（各 1 回）。unknown / destination_pay_unknown", async () => {
    for (const [mode, code] of [["stall", "upstream_timeout"], ["reset", "transport_failed"]] as const) {
      const fixture = await start("tests/fixtures/upstream-server.ts", ["--pay", "ok", "--after-headers", mode, "--after-headers-on", "pay"]);
      const events: TransportEvent[] = [];
      const rail = createSyntheticX402Outbound({ transport: denyAt(undefined, events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, timeoutMs: SHORT });
      const [offer] = await rail.readChallenge(X402.route);
      const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: `p-s-${mode}`, attempt: 1, deadlineMs: Date.now() + 600_000 });
      expect(result, mode).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
      expectSilent(result);
      expect(events, mode).toEqual([{ code, operation: "pay", routeId: X402.route, policy: expect.any(String) }]);
    }
  });

  it("(g) RPC の body の停滞・切断（経路 11 受信）: upstream_timeout / transport_failed を rpc で 1 回。verify は isValid false のまま、期限内に終わる", async () => {
    for (const [mode, code] of [["stall", "upstream_timeout"], ["reset", "transport_failed"]] as const) {
      const rpc = await start("tests/fixtures/rpc-server.ts", ["--chain-id", "42431", "--after-headers", mode]);
      const events: TransportEvent[] = [];
      const routeId = "md-mpp-inbound";
      const binding = [routeId, "GET", `/v1/routes/${routeId}/resource`].map(encodeURIComponent).join("|");
      const rail = createMppInbound({
        transport: denyAt(undefined, events),
        rpcUrl: rpc.baseUrl,
        rpcTimeoutMs: SHORT,
        secretKey: "0123456789abcdef0123456789abcdef0123456789abcdef",
        recipient: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2",
        currency: "0x20c0000000000000000000000000000000000000",
        chainId: 42_431,
        maxTimeoutSeconds: 600,
        realm: "router-test",
      });
      const offer = await rail.createOffer({ routeId, amount: "10000", asset: "0x20c0000000000000000000000000000000000000", network: "eip155:42431", routeBinding: binding, nowMs: Date.now() });
      const wire = Credential.serialize(Credential.from({ challenge: Challenge.deserialize(offer.extra["challenge"] as string), payload: { type: "hash", hash: `0x${"22".repeat(32)}` } }));
      const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, credential: wire } } as unknown as PaymentCredential;
      const t0 = Date.now();
      const verified = await rail.verify(offer, credential, { routeId });
      expect(verified, mode).toEqual({ isValid: false });
      expect(Date.now() - t0, mode).toBeLessThan(SHORT * 5); // viem の timeout（headers で解除）ではなく transport の期限で終わる
      expectSilent(verified);
      expect(events.map((e) => [e.code, e.operation, e.routeId]), mode).toEqual([[code, "rpc", routeId]]);
    }
  });

  it("(g) RPC の body の停滞・切断（経路 12 送信）: upstream_timeout / transport_failed を rpc で 1 回。公開結果は既存の unknown / destination_pay_unknown", async () => {
    for (const [mode, code] of [["stall", "upstream_timeout"], ["reset", "transport_failed"]] as const) {
      const rpc = await start("tests/fixtures/rpc-server.ts", ["--chain-id", "42431", "--after-headers", mode]);
      const upstream = await start("tests/fixtures/mpp-upstream.ts");
      const events: TransportEvent[] = [];
      const capability = {
        chainId: 42_431,
        account: { address: SPY_PAYER_ADDRESS, type: "json-rpc" as const },
        // 能力の timeout（400 ms）を transport が応答全体の期限として引き継ぐ。
        getClient: () => createViemClient({ chain: tempoTestnet(42_431), transport: viemHttp(rpc.baseUrl, { retryCount: 0, timeout: SHORT }) }),
        mode: "push" as const,
        kind: "non-signing-fixture" as const,
      };
      const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams: { [MPP.route]: `${upstream.baseUrl}/v1/eth/snapshot` }, capability, timeoutMs: 5000 });
      const [offer] = await rail.readChallenge(MPP.route);
      const t0 = Date.now();
      const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: `p-g-${mode}`, attempt: 1, deadlineMs: Date.now() + 600_000 });
      expect(result, mode).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
      expect(Date.now() - t0, mode).toBeLessThan(SHORT * 5);
      expectSilent(result);
      expect(events.map((e) => [e.code, e.operation, e.routeId]), mode).toEqual([[code, "rpc", MPP.route]]);
      expect((await stats<{ payCalls: number }>(upstream)).payCalls, mode).toBe(0);
    }
  });

  it("(h) 読まずに終わる応答（早期 return）も body を捨てて接続を即時に解放する。公開結果は既存のまま、事象 0", async () => {
    type Closed = { closedByKind: Record<string, number> };
    const closedOther = async (fixture: Listening): Promise<number> => (await stats<Closed>(fixture)).closedByKind["other"] ?? 0;
    const LONG = 5000; // 要求の timeout。discard が無ければ停滞した接続はこれまで開いたまま
    // MPP: 200 だが reference が合わない receipt + body 停滞 → unknown / destination_receipt_unverified。有料応答の socket が閉じる。
    {
      const fixture = await start("tests/fixtures/mpp-upstream.ts", ["--reference", "wrong", "--after-headers", "stall", "--after-headers-on", "pay"]);
      const events: TransportEvent[] = [];
      const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: createPayerSpy().capability(), timeoutMs: LONG });
      const [offer] = await rail.readChallenge(MPP.route);
      const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: "p-h1", attempt: 1, deadlineMs: Date.now() + 600_000 });
      expect(result).toEqual({ outcome: "unknown", reason: "destination_receipt_unverified" });
      expectSilent(result);
      expect(await waitFor(async () => (await closedOther(fixture)) >= 1, 1500), "mpp receipt_unverified socket closes").toBe(true);
      expect(events).toEqual([]);
    }
    // 合成 x402: pay が 500 + body 停滞 → unknown / destination_pay_unknown。socket が閉じる。
    {
      const fixture = await start("tests/fixtures/upstream-server.ts", ["--pay", "error", "--after-headers", "stall", "--after-headers-on", "pay"]);
      const events: TransportEvent[] = [];
      const rail = createSyntheticX402Outbound({ transport: denyAt(undefined, events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, timeoutMs: LONG });
      const [offer] = await rail.readChallenge(X402.route);
      const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-h2", attempt: 1, deadlineMs: Date.now() + 600_000 });
      expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
      expectSilent(result);
      expect(await waitFor(async () => (await closedOther(fixture)) >= 1, 1500), "synthetic 500 socket closes").toBe(true);
      expect(events).toEqual([]);
    }
    // 実 x402: challenge が 402 以外（200）+ body 停滞 → readChallenge は例外（既存）。socket が閉じる。
    {
      const fixture = await start("tests/fixtures/x402-upstream.ts", ["--challenge-status", "200", "--after-headers", "stall"]);
      const events: TransportEvent[] = [];
      const rail = createX402Outbound({ transport: denyAt(undefined, events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: createSignerSpy().capability(X402.network), timeoutMs: LONG });
      await expect(rail.readChallenge(X402.route)).rejects.toThrow(/upstream challenge returned status 200/);
      expect(await waitFor(async () => (await closedOther(fixture)) >= 1, 1500), "x402 non-402 challenge socket closes").toBe(true);
      expect(events).toEqual([]);
    }
  });

  it("秘匿: report の行にアドレス・ホスト名・URL・例外文字列が無い", async () => {
    const { formatTransportEvent } = await import("../../src/net/guarded-fetch.js");
    const line = formatTransportEvent({ code: "destination_blocked", operation: "pay", routeId: "r", policy: "a1/iana-2025-10-09" });
    expect(line).toBe("outbound transport destination_blocked operation=pay route=r policy=a1/iana-2025-10-09");
    expect(line).not.toMatch(/127\.|localhost|http|Error/);
  });
});

describe("context attribution under concurrency (T-A18)", () => {
  it("2 本の pay を同時に走らせても、各 report 行の route と operation が自分の呼び出しに付く", async () => {
    const fixture = await start("tests/fixtures/mpp-upstream.ts", ["--after-headers", "stall", "--after-headers-on", "pay"]);
    const events: TransportEvent[] = [];
    const spy = createPayerSpy();
    const upstreams = { "route-a": `${fixture.baseUrl}/v1/eth/snapshot`, "route-b": `${fixture.baseUrl}/v1/eth/snapshot` };
    const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams, capability: spy.capability(), timeoutMs: 400 });
    const [offerA] = await rail.readChallenge("route-a");
    const [offerB] = await rail.readChallenge("route-b");
    const [a, b] = await Promise.all([
      rail.pay({ routeId: "route-a", offer: offerA!, paymentId: "pa", attempt: 1, deadlineMs: Date.now() + 600_000 }),
      rail.pay({ routeId: "route-b", offer: offerB!, paymentId: "pb", attempt: 1, deadlineMs: Date.now() + 600_000 }),
    ]);
    expect([a.outcome, b.outcome]).toEqual(["paid_no_data", "paid_no_data"]);
    expectSilent([a, b]);
    expect(events.map((e) => `${e.routeId}:${e.operation}:${e.code}`).sort()).toEqual(["route-a:pay:upstream_timeout", "route-b:pay:upstream_timeout"]);
  });

  it("受信 MPP の RPC（AsyncLocalStorage）: 異なる route の verify を同じ rail で同時に走らせても、各 report 行の route が自分の呼び出しに付く", async () => {
    const rpc = await start("tests/fixtures/rpc-server.ts", ["--chain-id", "42431"]);
    const events: TransportEvent[] = [];
    const rail = createMppInbound({
      transport: denyAt("rpc", events),
      rpcUrl: rpc.baseUrl,
      secretKey: "0123456789abcdef0123456789abcdef0123456789abcdef",
      recipient: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2",
      currency: "0x20c0000000000000000000000000000000000000",
      chainId: 42_431,
      maxTimeoutSeconds: 600,
      realm: "router-test",
    });
    const credentialFor = async (routeId: string) => {
      const binding = [routeId, "GET", `/v1/routes/${routeId}/resource`].map(encodeURIComponent).join("|");
      const offer = await rail.createOffer({ routeId, amount: "10000", asset: "0x20c0000000000000000000000000000000000000", network: "eip155:42431", routeBinding: binding, nowMs: Date.now() });
      const wire = Credential.serialize(Credential.from({ challenge: Challenge.deserialize(offer.extra["challenge"] as string), payload: { type: "hash", hash: `0x${"33".repeat(32)}` } }));
      return { offer, credential: { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, credential: wire } } as unknown as PaymentCredential };
    };
    const a = await credentialFor("route-a");
    const b = await credentialFor("route-b");
    const [va, vb] = await Promise.all([rail.verify(a.offer, a.credential, { routeId: "route-a" }), rail.verify(b.offer, b.credential, { routeId: "route-b" })]);
    expect([va, vb]).toEqual([{ isValid: false }, { isValid: false }]);
    expect(events.map((e) => `${e.routeId}:${e.operation}:${e.code}`).sort()).toEqual(["route-a:rpc:destination_blocked", "route-b:rpc:destination_blocked"]);
  });
});
