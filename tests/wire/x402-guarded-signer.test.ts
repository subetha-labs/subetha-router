/**
 * guarded signer の**拒否面**（設計 §4.2 受け皿 B / 要件 T7-02）。
 *
 * `src/adapters/outbound/x402.ts` の guarded signer は、承認値と外れた typed data では
 * **注入された署名能力を呼ばない**。これは「誤った宛先・誤った額へ署名してしまう」ことを
 * 防ぐ最後の砦だが、これまでテストが 1 件も無かった。
 *
 * ここでは**実鍵も送金も使わない**。署名境界に `createForbiddenSignerSpy`
 * （呼ばれたら throw する spy）を置き、**呼ばれないこと自体**を検証する。
 * 相手は別プロセスの loopback fixture で、実 Provider には一切接続しない。
 */

import { afterEach, describe, expect, it } from "vitest";

import { createX402Outbound } from "../../src/adapters/outbound/x402.js";
import type { DestinationOffer } from "../../src/ports/outbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { createForbiddenSignerSpy, createSignerSpy } from "../fixtures/x402-signer-spy.js";

const ROUTE_ID = "eth-snapshot";
const NETWORK = "eip155:84532";

const running: Listening[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
});

async function startUpstream(args: readonly string[] = []): Promise<Listening> {
  const fixture = await startListening("tests/fixtures/x402-upstream.ts", ["--port", "0", ...args]);
  running.push(fixture);
  return fixture;
}

function railOf(fixture: Listening, spy: ReturnType<typeof createSignerSpy>) {
  return createX402Outbound({
    upstreams: { [ROUTE_ID]: `${fixture.baseUrl}/v1/eth/snapshot` },
    capability: spy.capability(NETWORK),
  });
}

async function payCallsOf(fixture: Listening): Promise<number> {
  const response = await fetch(`${fixture.baseUrl}/calls`);
  const body = (await response.json()) as { payCalls: number };
  return body.payCalls;
}

describe("guarded signer は承認と外れた typed data で署名能力を呼ばない", () => {
  it("EIP-3009 以外の資産移転方式は fail closed（署名器に到達しない）", async () => {
    // `--atm permit2` で上流が別方式を要求する。T2 で確認済みなのは EIP-3009 だけ。
    const fixture = await startUpstream(["--atm", "permit2"]);
    const spy = createForbiddenSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "g1", attempt: 1 });

    expect(result.outcome).toBe("not_sent");
    // guarded signer 本体に到達して EIP-3009 以外を弾いた経路。
    if (result.outcome === "not_sent") {
      expect(result.reason).toBe("destination_not_signed");
    }
    // 署名器は throw する spy。呼ばれていれば別の失敗になるので、呼ばれていないことが分かる。
    expect(spy.calls).toHaveLength(0);
    // 上流への支払い要求も出ていない。
    expect(await payCallsOf(fixture)).toBe(0);
  });

  it("承認額を書き換えた offer は accepts 再照合で止まり、署名器に到達しない", async () => {
    const fixture = await startUpstream();
    const spy = createForbiddenSignerSpy();
    const rail = railOf(fixture, spy);
    const real = (await rail.readChallenge(ROUTE_ID))[0]!;

    // 上流が提示した accepts と一致しない額を「承認済み」として渡す。
    const tampered: DestinationOffer = { ...real, amount: "999999" };
    const result = await rail.pay({
      routeId: ROUTE_ID,
      offer: tampered,
      paymentId: "g2",
      attempt: 1,
    });

    expect(result.outcome).toBe("not_sent");
    // **止まる層を固定する**: guarded signer より手前の accepts 完全一致照合で弾かれる
    // （上流が提示していない条件は、署名の前に検出される）。多層防御であって
    // 「guarded signer が捕まえた」ではない。
    if (result.outcome === "not_sent") {
      expect(result.reason).toBe("destination_offer_changed");
    }
    expect(spy.calls).toHaveLength(0);
    expect(await payCallsOf(fixture)).toBe(0);
  });

  it("承認した受取先を書き換えた offer は accepts 再照合で止まる", async () => {
    const fixture = await startUpstream();
    const spy = createForbiddenSignerSpy();
    const rail = railOf(fixture, spy);
    const real = (await rail.readChallenge(ROUTE_ID))[0]!;

    const tampered: DestinationOffer = {
      ...real,
      payTo: "0x000000000000000000000000000000000000dead",
    };
    const result = await rail.pay({
      routeId: ROUTE_ID,
      offer: tampered,
      paymentId: "g3",
      attempt: 1,
    });

    expect(result.outcome).toBe("not_sent");
    // **止まる層を固定する**: guarded signer より手前の accepts 完全一致照合で弾かれる
    // （上流が提示していない条件は、署名の前に検出される）。多層防御であって
    // 「guarded signer が捕まえた」ではない。
    if (result.outcome === "not_sent") {
      expect(result.reason).toBe("destination_offer_changed");
    }
    expect(spy.calls).toHaveLength(0);
    expect(await payCallsOf(fixture)).toBe(0);
  });

  it("承認した資産を書き換えた offer は accepts 再照合で止まる", async () => {
    const fixture = await startUpstream();
    const spy = createForbiddenSignerSpy();
    const rail = railOf(fixture, spy);
    const real = (await rail.readChallenge(ROUTE_ID))[0]!;

    const tampered: DestinationOffer = {
      ...real,
      asset: "0x000000000000000000000000000000000000beef",
    };
    const result = await rail.pay({
      routeId: ROUTE_ID,
      offer: tampered,
      paymentId: "g4",
      attempt: 1,
    });

    expect(result.outcome).toBe("not_sent");
    // **止まる層を固定する**: guarded signer より手前の accepts 完全一致照合で弾かれる
    // （上流が提示していない条件は、署名の前に検出される）。多層防御であって
    // 「guarded signer が捕まえた」ではない。
    if (result.outcome === "not_sent") {
      expect(result.reason).toBe("destination_offer_changed");
    }
    expect(spy.calls).toHaveLength(0);
    expect(await payCallsOf(fixture)).toBe(0);
  });

  it("正しい承認値なら署名器がちょうど 1 回だけ呼ばれる（拒否面が過剰でない）", async () => {
    // 拒否面が「常に拒否」では意味がないので、通るべき経路が通ることも固定する。
    const fixture = await startUpstream();
    const spy = createSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "g5", attempt: 1 });

    expect(result.outcome).toBe("paid");
    // 1 要求につき署名は 1 回だけ（arming は 1 回で解除される）。
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.primaryType).toBe("TransferWithAuthorization");
    expect(await payCallsOf(fixture)).toBe(1);
  });
});
