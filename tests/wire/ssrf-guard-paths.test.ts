/**
 * SSRF 防御 A: 10 経路への到達（T-A13）、headers 後の診断（T-A17）、文脈の帰属（T-A18）。
 *
 * 到達の証明: 対象の経路の要求だけを **本物のポリシー**（`allowLoopback: false` の transport）に通して拒否させ、
 * 前提の要求は fixture 向けの transport で通す。確認は `report` の `operation` と fixture の TCP 接続数。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createSubethaInbound } from "../../src/adapters/inbound/subetha.js";
import { createX402Inbound } from "../../src/adapters/inbound/x402.js";
import { createMppOutbound } from "../../src/adapters/outbound/mpp.js";
import { createSyntheticX402Outbound, createX402Outbound } from "../../src/adapters/outbound/x402.js";
import { createGuardedTransport, TransportError, type GuardedTransport, type TransportEvent } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { createPayerSpy } from "../fixtures/mpp-payer-spy.js";
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
    const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: "p-2", attempt: 1 });
    expect(result).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
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
    const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: "p-3", attempt: 1 });
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
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
    const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-5", attempt: 1 });
    expect(result.outcome).toBe("not_sent");
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
    const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-6", attempt: 1 });
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
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
    await expect(rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-8", attempt: 1 })).rejects.toBeInstanceOf(TransportError);
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

  it("(b) 消費する body の切断: 受信 subetha の verify → transport_failed を 1 回", async () => {
    const fixture = await start("tests/fixtures/facilitator-server.ts", ["--token", "0x0000000000000000000000000000000000005ce7", "--pay-to", "0x0000000000000000000000000000000000000a0e", "--chain-id", "11155111", "--after-headers", "reset"]);
    const events: TransportEvent[] = [];
    const inbound = createSubethaInbound({ transport: denyAt(undefined, events), facilitatorUrl: fixture.baseUrl, timeoutMs: SHORT });
    // createOffer（/challenge）も切断されるので、ここで 1 回報告される。
    await expect(inbound.createOffer({ routeId: "eth-snapshot", amount: "1000", asset: "0x0000000000000000000000000000000000005ce7", network: "eip155:11155111", routeBinding: "b", nowMs: Date.now() })).rejects.toBeDefined();
    expect(events.map((e) => [e.code, e.operation])).toEqual([["transport_failed", "facilitator_challenge"]]);
  });

  it("(c)(d) 消費しない body（MPP の 402 challenge）の停滞・切断: challenge 再読は成功し、事象 0", async () => {
    for (const mode of ["stall", "reset"]) {
      const fixture = await start("tests/fixtures/mpp-upstream.ts", ["--after-headers", mode, "--after-headers-on", "challenge"]);
      const events: TransportEvent[] = [];
      const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: createPayerSpy().capability(), timeoutMs: SHORT });
      const t0 = Date.now();
      const offers = await rail.readChallenge(MPP.route);
      expect(offers, mode).toHaveLength(1);
      expect(Date.now() - t0, mode).toBeLessThan(SHORT); // 停滞した body を待っていない
      expect(events, mode).toEqual([]);
    }
  });

  it("(e)(f) 有料応答の body: MPP pay の receipt body の停滞 → upstream_timeout 1 回、切断 → transport_failed 1 回。公開結果は paid_no_data", async () => {
    for (const [mode, code] of [["stall", "upstream_timeout"], ["reset", "transport_failed"]] as const) {
      const fixture = await start("tests/fixtures/mpp-upstream.ts", ["--after-headers", mode, "--after-headers-on", "pay"]);
      const events: TransportEvent[] = [];
      const spy = createPayerSpy();
      const rail = createMppOutbound({ transport: denyAt(undefined, events), upstreams: { [MPP.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(), timeoutMs: SHORT });
      const [offer] = await rail.readChallenge(MPP.route);
      const result = await rail.pay({ routeId: MPP.route, offer: offer!, paymentId: `p-${mode}`, attempt: 1 });
      expect(result.outcome, mode).toBe("paid_no_data");
      expect(events, mode).toEqual([{ code, operation: "pay", routeId: MPP.route, policy: expect.any(String) }]);
    }
  });

  it("(e)(f) 有料応答の body: 実 x402 pay の停滞 → upstream_timeout 1 回、公開結果は unknown / destination_pay_unknown", async () => {
    const fixture = await start("tests/fixtures/x402-upstream.ts", ["--after-headers", "stall", "--after-headers-on", "pay"]);
    const events: TransportEvent[] = [];
    const spy = createSignerSpy();
    const rail = createX402Outbound({ transport: denyAt(undefined, events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, capability: spy.capability(X402.network), timeoutMs: SHORT });
    const [offer] = await rail.readChallenge(X402.route);
    const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-x", attempt: 1 });
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(events).toEqual([{ code: "upstream_timeout", operation: "pay", routeId: X402.route, policy: expect.any(String) }]);
  });

  it("(e) 合成 x402 pay の停滞 → upstream_timeout 1 回、unknown / destination_pay_unknown", async () => {
    const fixture = await start("tests/fixtures/upstream-server.ts", ["--pay", "ok", "--after-headers", "stall", "--after-headers-on", "pay"]);
    const events: TransportEvent[] = [];
    const rail = createSyntheticX402Outbound({ transport: denyAt(undefined, events), upstreams: { [X402.route]: `${fixture.baseUrl}/v1/eth/snapshot` }, timeoutMs: SHORT });
    const [offer] = await rail.readChallenge(X402.route);
    const result = await rail.pay({ routeId: X402.route, offer: offer!, paymentId: "p-s", attempt: 1 });
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(events).toEqual([{ code: "upstream_timeout", operation: "pay", routeId: X402.route, policy: expect.any(String) }]);
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
      rail.pay({ routeId: "route-a", offer: offerA!, paymentId: "pa", attempt: 1 }),
      rail.pay({ routeId: "route-b", offer: offerB!, paymentId: "pb", attempt: 1 }),
    ]);
    expect([a.outcome, b.outcome]).toEqual(["paid_no_data", "paid_no_data"]);
    expect(events.map((e) => `${e.routeId}:${e.operation}:${e.code}`).sort()).toEqual(["route-a:pay:upstream_timeout", "route-b:pay:upstream_timeout"]);
  });
});
