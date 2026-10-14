/**
 * 受信レール **SubEtha** の end-to-end（P5）。**無課金**。
 *
 * 既存 `subetha-inbound.test.ts` は adapter を直接組み立てる単体テストで、
 * **`src/main.ts` の adapter 選択（`sourceRail`）を通らない**。
 * ここは実 composition（`composeRails`）を経由させ、
 * **`sourceRail: "subetha"` の route が SubEtha 受信 adapter に解決されること**を
 * R1〜R4 の公開契約越しに確かめる。
 *
 * なぜ必要か: `sourceRail` を実際に解決する経路は、これまで**実決済ツール
 * （`tools/t8-crossrail-e2e.ts` など）でしか踏まれていなかった**。
 * 無課金のテストが 1 本も無いと、受信レールを増やしたときに
 * 「お金を動かさないと壊れたことが分からない」状態になる。
 *
 * 相手はすべて loopback の合成 fixture。鍵・実署名・実 broadcast・実 RPC は無い。
 * 送信レグは**署名しない** spy 能力（`non-signing-fixture`）で、実決済の証拠にはならない。
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startListening, type Listening } from "../fixtures/loopback.js";

const ROUTE = "md-subetha-inbound";

/** 受信レグ（SubEtha 合成 facilitator が名乗る値に合わせる）。 */
const CHAIN_ID = 11_155_111;
const SOURCE_NETWORK = `eip155:${CHAIN_ID}`;
const SOURCE_TOKEN = "0x0000000000000000000000000000000000005ce7";
const SOURCE_PAY_TO = "0x0000000000000000000000000000000000000a0e";
/**
 * MPP 受信の拒否の試験の受信 network。Ethereum Sepolia（`eip155:11155111`）は本番の表で x402 の受信だけ（`docs/evm-testnets-x402-design.md`）になったので、
 * MPP の向きを許す合成の network（`tests/fixtures/known-networks.ts` の `eip155:1`）を使う。
 */
const SYNTHETIC_MPP_NETWORK = "eip155:1";

/** 送信レグ（Tempo 形。spy が受ける）。 */
const DEST_NETWORK = "eip155:42431";
const DEST_ASSET = "0x20c0000000000000000000000000000000000000";
/** `tests/fixtures/mpp-upstream.ts` が名乗る recipient と一致させる必要がある。 */
const DEST_PAY_TO = "0x00000000000000000000000000000000000000b1";

const ALICE = { id: "alice", token: "tok-alice-p5" };

const running: Listening[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
});

async function track(listening: Listening): Promise<Listening> {
  running.push(listening);
  return listening;
}

interface Started {
  readonly router: Listening;
  readonly facilitator: Listening;
}

/**
 * `sourceRail: "subetha"` を**明示**した route で実 composition を起動する。
 * `ROUTER_ADAPTER_MODE=real` でなければ `sourceRail` は評価されない
 * （`synthetic` は adapter を固定してしまう）ので、real で起動して能力だけ spy にする。
 */
async function start(
  options: {
    readonly sourceRail?: string;
    readonly sourcePayTo?: string;
    readonly sourceNetwork?: string;
    readonly sourceAsset?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<Started> {
  const facilitator = await track(
    await startListening("tests/fixtures/facilitator-server.ts", [
      "--port",
      "0",
      "--token",
      SOURCE_TOKEN,
      "--pay-to",
      SOURCE_PAY_TO,
      "--chain-id",
      `${CHAIN_ID}`,
    ]),
  );
  const upstream = await track(await startListening("tests/fixtures/mpp-upstream.ts", ["--pay", "ok"]));

  const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const work = await mkdtemp(path.join(runtimeRoot, "p5-"));
  const configPath = path.join(work, "router.config.json");

  const route: Record<string, unknown> = {
    routeId: ROUTE,
    canonicalPath: `/v1/routes/${ROUTE}/resource`,
    rail: "mpp",
    source: {
      amount: "1000",
      asset: SOURCE_TOKEN,
      decimals: 6,
      network: SOURCE_NETWORK,
    },
    destination: {
      scheme: "tempo/charge",
      network: DEST_NETWORK,
      asset: DEST_ASSET,
      payTo: DEST_PAY_TO,
    },
  };
  // 省略時の既定（subetha）も同じ経路に解決されることを確かめたいので、明示は任意にする。
  if (options.sourceRail !== undefined) {
    route["sourceRail"] = options.sourceRail;
  }
  if (options.sourcePayTo !== undefined) {
    (route["source"] as Record<string, unknown>)["payTo"] = options.sourcePayTo;
  }
  if (options.sourceNetwork !== undefined) {
    (route["source"] as Record<string, unknown>)["network"] = options.sourceNetwork;
  }
  if (options.sourceAsset !== undefined) {
    (route["source"] as Record<string, unknown>)["asset"] = options.sourceAsset;
  }

  await writeFile(
    configPath,
    JSON.stringify(
      {
        router: {
          approvalTtlMs: 60_000,
          routes: { [ROUTE]: route },
          budget: {
            maxPurchases: 4,
            buckets: [
              { network: SOURCE_NETWORK, asset: SOURCE_TOKEN, maxTotal: "10000", maxPerPurchase: "5000" },
              // MPP 受信の route は別チェーンを使うので、そのバケットも要る。
              {
                network: options.sourceNetwork ?? SOURCE_NETWORK,
                asset: options.sourceAsset ?? SOURCE_TOKEN,
                maxTotal: "10000",
                maxPerPurchase: "5000",
              },
              { network: DEST_NETWORK, asset: DEST_ASSET, maxTotal: "10000", maxPerPurchase: "5000" },
            ],
          },
        },
        // 上流の節は rail に関係なく `x402` という名前（`src/config.ts:398`）。
        x402: { upstreams: { [ROUTE]: `${upstream.baseUrl}/v1/eth/snapshot` } },
      },
      null,
      2,
    ),
    "utf8",
  );

  const router = await track(
    await startListening("tests/fixtures/router-rails-process.ts", ["--rails", "b"], {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
      // real でないと `sourceRail` は評価されない（合成は adapter を固定する）。
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: facilitator.baseUrl,
      ...(options.env ?? {}),
    }),
  );
  return { router, facilitator };
}

const headers = {
  "x-router-principal": ALICE.id,
  authorization: `Bearer ${ALICE.token}`,
  "content-type": "application/json",
};

async function quote(router: Listening, requestId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${router.baseUrl}/v1/quotes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ routeId: ROUTE, requestId }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** facilitator が数えた `/verify` `/settle` の到達回数。 */
async function facilitatorCalls(facilitator: Listening): Promise<Record<string, number>> {
  const response = await fetch(`${facilitator.baseUrl}/calls`);
  return (await response.json()) as Record<string, number>;
}

describe("subetha inbound end-to-end (real composition, unpaid)", () => {
  it("resolves sourceRail \"subetha\" to the SubEtha inbound rail and issues its offer", async () => {
    const { router, facilitator } = await start({ sourceRail: "subetha" });
    const body = await quote(router, "p5-explicit-1");

    // offer が SubEtha レールのものであることを、scheme と facilitator 由来の値で確かめる。
    const offer = (body["source"] as Record<string, unknown> | undefined)?.["offer"] as
      | Record<string, unknown>
      | undefined;
    expect(offer, JSON.stringify(body).slice(0, 400)).toBeDefined();
    expect(offer?.["scheme"]).toBe("subetha-zerc20");
    // payTo は構成ではなく **facilitator の challenge 応答**から来る（SubEtha 受信の性質）。
    expect(offer?.["payTo"]).toBe(SOURCE_PAY_TO);
    expect(offer?.["network"]).toBe(SOURCE_NETWORK);

    // この時点では決済は始まっていない（verify/settle は 0 回）。
    expect(await facilitatorCalls(facilitator)).toMatchObject({ verifyCalls: 0, settleCalls: 0 });
  });

  it("defaults to the SubEtha inbound rail when sourceRail is omitted", async () => {
    // 既定 `subetha` は既存 chat 互換のために外せない。省略時も同じ解決になることを固定する。
    const { router } = await start();
    const body = await quote(router, "p5-default-1");
    const offer = (body["source"] as Record<string, unknown> | undefined)?.["offer"] as
      | Record<string, unknown>
      | undefined;
    expect(offer?.["scheme"]).toBe("subetha-zerc20");
  });

  it("projects source.rail as subetha on the quote (existing chat contract)", async () => {
    // `src/http/projection.ts:48` の既定。chat 側 `router-contract.mjs:82` が
    // `check(s.rail === 'subetha')` を要求するので、**quote の source.rail** に出る。
    // R1（/v1/routes）ではなく R2 の射影であることに注意。
    const { router } = await start({ sourceRail: "subetha" });
    const body = await quote(router, "p5-rail-1");
    expect((body["source"] as Record<string, unknown>)["rail"]).toBe("subetha");
  });

  it("keeps source.rail as subetha when sourceRail is omitted", async () => {
    // 既定を外すと `rail: undefined` になり T5 の chat 相互運用が壊れる。
    const { router } = await start();
    const body = await quote(router, "p5-rail-default-1");
    expect((body["source"] as Record<string, unknown>)["rail"]).toBe("subetha");
  });

  it("refuses to start when an unknown sourceRail is configured", async () => {
    // 知らない受信レール名は合成に落とさず起動を止める（fail closed）。
    const facilitator = await track(
      await startListening("tests/fixtures/facilitator-server.ts", ["--port", "0"]),
    );
    const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
    await mkdir(runtimeRoot, { recursive: true });
    const work = await mkdtemp(path.join(runtimeRoot, "p5-bad-"));
    const configPath = path.join(work, "router.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        router: {
          approvalTtlMs: 60_000,
          routes: {
            [ROUTE]: {
              routeId: ROUTE,
              canonicalPath: `/v1/routes/${ROUTE}/resource`,
              rail: "mpp",
              sourceRail: "no-such-rail",
              source: { amount: "1000", asset: SOURCE_TOKEN, decimals: 6, network: SOURCE_NETWORK },
              destination: {
                scheme: "tempo/charge",
                network: DEST_NETWORK,
                asset: DEST_ASSET,
                payTo: DEST_PAY_TO,
              },
            },
          },
          budget: { maxPurchases: 1, buckets: [] },
        },
        x402: { upstreams: { [ROUTE]: "http://127.0.0.1:1/v1/eth/snapshot" } },
      }),
      "utf8",
    );

    await expect(
      startListening("tests/fixtures/router-rails-process.ts", ["--rails", "b"], {
        ROUTER_CONFIG_PATH: configPath,
        ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
        ROUTER_HTTP_PORT: "0",
        ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
        ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
        ROUTER_ADAPTER_MODE: "real",
        ROUTER_SUBETHA_FACILITATOR_URL: facilitator.baseUrl,
      }),
    ).rejects.toThrow(/sourceRail must be/);
  });
});

describe("mpp inbound wiring (real composition, unpaid)", () => {
  const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const MPP_PAY_TO = "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2";

  it("resolves sourceRail \"mpp\" and issues an MPP offer with a real expiry", async () => {
    // 受信を MPP にする route は、mppx が解決できるチェーンでなければならない
    // （既定の Sepolia では `No client configured with chainId` で起動後に失敗する）。
    const { router } = await start({
      sourceRail: "mpp",
      sourcePayTo: MPP_PAY_TO,
      sourceNetwork: DEST_NETWORK,
      sourceAsset: DEST_ASSET,
      env: { ROUTER_MPP_INBOUND_SECRET: SECRET, ROUTER_MPP_INBOUND_OFFER_SECONDS: "600" },
    });
    const body = await quote(router, "p5-mpp-1");
    const source = body["source"] as Record<string, unknown> | undefined;
    const offer = source?.["offer"] as Record<string, unknown> | undefined;

    expect(offer, JSON.stringify(body).slice(0, 400)).toBeDefined();
    expect(offer?.["scheme"]).toBe("tempo/charge");
    expect(offer?.["payTo"]).toBe(MPP_PAY_TO);
    // rail 名がそのまま射影に出る（既定 subetha に潰れない）。
    expect(source?.["rail"]).toBe("mpp");

    // **額とチェーンを必ず見る。** ここを見ていなかったために、SDK が 10^6 倍した額と
    // mainnet に束縛していたのを取り逃がした（レビュー指摘）。
    expect(offer?.["amount"]).toBe("1000");
    expect(offer?.["network"]).toBe(DEST_NETWORK);
    expect(source?.["amount"]).toBe("1000");

    // 失効検査が発火できる値であること（ここが 0/NaN だと期限が効かない）。
    const extra = offer?.["extra"] as Record<string, unknown>;
    const expiresAt = extra["expiresAt"] as number;
    expect(Number.isInteger(expiresAt)).toBe(true);
    expect(expiresAt * 1000).toBeGreaterThan(Date.now());
  });

  it("refuses to start when sourceRail is mpp but no secret is configured", async () => {
    // 鍵が無いまま合成や弱い HMAC に落とさない（fail closed）。
    // 理由まで固定する。理由を見ないと、無関係な構成エラーでも緑になってしまう
    // （実際、budget が空のまま書いていて別の理由で落ちていたのを実測で見つけた）。
    await expect(
      start({ sourceRail: "mpp", sourcePayTo: MPP_PAY_TO, sourceNetwork: SYNTHETIC_MPP_NETWORK }),
    ).rejects.toThrow(/ROUTER_MPP_INBOUND_SECRET is required/);
  });

  it("refuses to start when sourceRail is mpp but source.payTo is missing", async () => {
    await expect(
      start({
        sourceRail: "mpp",
        sourceNetwork: SYNTHETIC_MPP_NETWORK,
        env: { ROUTER_MPP_INBOUND_SECRET: SECRET },
      }),
    ).rejects.toThrow(/source\.payTo is required when sourceRail is "mpp"/);
  });

  it("refuses to start when the MPP secret is too short", async () => {
    await expect(
      start({
        sourceRail: "mpp",
        sourcePayTo: MPP_PAY_TO,
        sourceNetwork: SYNTHETIC_MPP_NETWORK,
        env: { ROUTER_MPP_INBOUND_SECRET: "too-short" },
      }),
    ).rejects.toThrow(/at least 32 bytes/);
  });
});
