/**
 * chat 実行レイヤ（別オーナーの worktree にある実実装）と本 Router を、
 * **両方とも実プロセス**にして実 TCP で突き合わせる相互実装テスト。ラベル `T5-crossimpl-nopay`。
 *
 * これまで両者は「同じ契約のつもり」の独立実装で、chat 側のテストは自前スタブ Router に、
 * こちらのテストは自前 client に対して緑だった。噛み合うことは誰も確かめていなかった。
 *
 * 支払いは発生しない: 合成 facilitator と合成上流、資格情報は**署名しない spy**
 * （offer の `challengeNonce` を写すだけで鍵も送金もない）。実決済・実 API 到達・
 * 実 UI・finality・AC-7 はいずれも未達のままで、本テストはそれらを主張しない。
 *
 * chat 側のファイルは**読むだけで一切変更しない**。
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runToExit } from "../fixtures/loopback.js";
import {
  ALICE,
  BOB,
  chatAppAvailable,
  CHAT_APP_DIR,
  ROUTE_A,
  ROUTE_B,
  startCrossImplHarness,
  upstreamCalls,
  type CrossImplHarness,
  type CrossImplOptions,
} from "../fixtures/chat-crossimpl-harness.js";

/** 多段の子プロセス起動（facilitator/上流2本/proxy/Router/driver）を含むので既定 5s では足りない。 */
const TIMEOUT = 60_000;

interface Line {
  readonly step: string;
  readonly [key: string]: unknown;
}

/** driver が journal に使う private ディレクトリ（chat 側は 0o700・realpath 一致を要求する）。 */
async function privateDir(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "t5-journal-"));
  const canonical = await realpath(base);
  await chmod(canonical, 0o700);
  return canonical;
}

interface DriveOptions {
  readonly scenario: string;
  readonly harness: CrossImplHarness;
  readonly directory: string;
  readonly principal?: { id: string; token: string };
  readonly routeId?: string;
  readonly payer?: "on" | "off";
  readonly providerId?: string;
  readonly upstreamUrl?: string;
}

interface DriveResult {
  readonly code: number | null;
  readonly lines: readonly Line[];
  readonly stdout: string;
  readonly stderr: string;
  step(name: string): Line | undefined;
}

/** chat 実装を別プロセスで one-shot 実行し、stdout の JSON 行を観測として取り出す。 */
async function drive(options: DriveOptions): Promise<DriveResult> {
  const principal = options.principal ?? ALICE;
  const harness = options.harness;
  const result = await runToExit("tests/fixtures/chat-router-driver.ts", [
    "--chat-dir",
    CHAT_APP_DIR,
    "--scenario",
    options.scenario,
    "--router-origin",
    harness.routerOrigin,
    "--directory",
    options.directory,
    "--route-id",
    options.routeId ?? ROUTE_A,
    "--principal",
    principal.id,
    "--bearer",
    principal.token,
    "--payer",
    options.payer ?? "on",
    "--provider-id",
    options.providerId ?? "market-data-a",
    "--upstream-url",
    options.upstreamUrl ?? `${harness.upstreamA.baseUrl}/v1/eth/snapshot`,
    // env は loopback 側の ENV_ALLOWLIST に絞られる（親の秘密を子に渡さない）。
  ], {});
  const lines: Line[] = [];
  for (const raw of result.stdout.split("\n")) {
    const text = raw.trim();
    if (text === "") continue;
    lines.push(JSON.parse(text) as Line);
  }
  return {
    code: result.code,
    lines,
    stdout: result.stdout,
    stderr: result.stderr,
    step(name: string): Line | undefined {
      return lines.find((line) => line.step === name);
    },
  };
}

/**
 * driver 自身が壊れて（chat worktree 不在・動的 import 失敗・chat 側 API 変更など）
 * 何も観測できなかった場合に、否定系が「何も起きていない」と読めて**偽陽性で緑になる**のを防ぐ。
 * 観測を根拠にする前に必ず通す。
 */
function expectDriverRan(result: DriveResult, firstStep: string): void {
  expect(result.step("driver-error")).toBeUndefined();
  expect(result.code).toBe(0);
  // 少なくとも最初の観測が出ていること（stdout が空のまま緑にならない）。
  expect(result.step(firstStep)).toBeDefined();
}

/** 否定系の共通判定: どのレグも動いていないこと（chat の journal だけを根拠にしない）。 */
async function expectNoLegMoved(harness: CrossImplHarness): Promise<void> {
  const proxy = await harness.proxyCalls();
  expect(proxy.R3).toBe(0);
  const upstream = await upstreamCalls(harness.upstreamA);
  expect(upstream["payCalls"]).toBe(0);
  const facilitator = (await (await fetch(`${harness.facilitator.baseUrl}/calls`)).json()) as Record<
    string,
    unknown
  >;
  expect(facilitator["verifyCalls"]).toBe(0);
  expect(facilitator["settleCalls"]).toBe(0);
}

async function withHarness(
  options: CrossImplOptions,
  body: (harness: CrossImplHarness) => Promise<void>,
): Promise<void> {
  const harness = await startCrossImplHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.stop();
  }
}

// chat 実装が読める場所に無い環境では skip する（契約変更による失敗と混同しないため）。
describe.skipIf(!chatAppAvailable())("T5-crossimpl-nopay: chat 実装 × 実 Router", () => {
  it(
    "T5-02: Router の実 R2 応答が chat の decodeQuote を無改変で通る",
    async () => {
      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "quote-only",
          harness,
          directory: await privateDir(),
        });
        expectDriverRan(result, "quote");
        const quote = result.step("quote");
        expect(quote?.["ok"]).toBe(true);
        // chat 側が受理した = exact key set 検証を通った。
        expect(result.step("prepared")?.["executionAvailability"]).toBe("configured");
        expect(result.step("prepared")?.["preparedBinding"]).toBe(true);
        // R2 だけが到達し、支払いレグは動いていない。
        const proxy = await harness.proxyCalls();
        expect(proxy.R2).toBe(1);
        await expectNoLegMoved(harness);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-04: 承認 → 実行 → 別プロセスで再オープンしても同一 paymentId の同一結果",
    async () => {
      await withHarness({}, async (harness) => {
        const directory = await privateDir();
        const first = await drive({ scenario: "purchase", harness, directory });
        expectDriverRan(first, "quote");
        expect(first.step("approve")?.["ok"]).toBe(true);
        const after = first.step("after-approve");
        expect(after?.["payment"]).toBe("delivered");
        expect(after?.["error"]).toBeNull();
        const purchase = after?.["purchase"] as Record<string, unknown>;
        const paymentId = purchase["paymentId"];
        expect(typeof paymentId).toBe("string");
        // 上流 snapshot が chat の厳格な market プロファイル検証を通って result に入っている。
        const snapshot = purchase["result"] as Record<string, unknown>;
        expect(snapshot["providerId"]).toBe("market-data-a");

        // 別プロセスで同じ journal を開き直す（保存 → 再オープン相当）。
        const reopened = await drive({ scenario: "reopen", harness, directory });
        expectDriverRan(reopened, "reopened");
        const view = reopened.step("reopened");
        expect(view?.["reopened"]).toBe(true);
        expect(view?.["payment"]).toBe("delivered");
        const again = view?.["purchase"] as Record<string, unknown>;
        expect(again["paymentId"]).toBe(paymentId);
        expect(again["result"]).toEqual(snapshot);

        // 再オープンは読み取りのみ。R3 は最初の 1 回だけ。
        const proxy = await harness.proxyCalls();
        expect(proxy.R3).toBe(1);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-03a: 承認しなければ Router へ R3 が出ない",
    async () => {
      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "unapproved",
          harness,
          directory: await privateDir(),
        });
        expectDriverRan(result, "quote");
        expect(result.step("skipped-approval")).toBeDefined();
        await expectNoLegMoved(harness);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-03b: 別 quote の束縛で承認しても credential も R3 も呼ばれない",
    async () => {
      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "wrong-quote-approval",
          harness,
          directory: await privateDir(),
        });
        expectDriverRan(result, "quote");
        // 束縛不一致は承認検証の段で落ち、payer にも到達しない。
        expect(result.step("validate-approval")?.["ok"]).toBe(false);
        expect(result.step("approve")).toBeUndefined();
        await expectNoLegMoved(harness);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-03c: canonical origin が実 origin と違えば chat は支払いを始めない",
    async () => {
      // canonical を別 origin にすると、chat が受け取る resource.url は実 Router を指さない。
      await withHarness(
        { canonicalBaseUrlOverride: "http://127.0.0.1:8500" },
        async (harness) => {
          const result = await drive({
            scenario: "purchase",
            harness,
            directory: await privateDir(),
          });
          expectDriverRan(result, "quote");
          // 落ちる段を固定する: canonical origin が自分の routerOrigin と違うので、
          // chat 側 `decodeQuote` が quote の受理そのものを拒む（承認段には進まない）。
          expect(result.step("quote")?.["ok"]).toBe(false);
          expect(result.step("quote")?.["error"]).toBe("quote_unavailable");
          // 承認も実行も起きていない（行自体が出ない）。
          expect(result.step("validate-approval")).toBeUndefined();
          expect(result.step("after-approve")).toBeUndefined();
          // R2 は到達しているが（要求は出した）、R3 は実 Router に届いていない。
          const proxy = await harness.proxyCalls();
          expect(proxy.R2).toBe(1);
          expect(proxy.R3).toBe(0);
          await expectNoLegMoved(harness);
        },
      );
    },
    TIMEOUT,
  );

  it(
    "T5-03d: 承認期限が切れた quote では支払いが始まらない",
    async () => {
      // deadlineMs は offer の expiresAt*1000 以下でなければ chat の decodeQuote が落ちるため、
      // 極小の TTL を使って「発行直後に期限切れ」を作る。
      await withHarness({ approvalTtlMs: 1 }, async (harness) => {
        const result = await drive({
          scenario: "purchase",
          harness,
          directory: await privateDir(),
        });
        expectDriverRan(result, "quote");
        // quote 自体は受理される（deadlineMs <= expiresAt*1000 は満たす）。
        expect(result.step("quote")?.["ok"]).toBe(true);
        // 落ちる段を固定する: 承認検証の時点で既に期限切れ＝dispatch 不可。
        expect(result.step("validate-approval")?.["ok"]).toBe(false);
        expect(result.step("validate-approval")?.["error"]).toBe("dispatch_unavailable");
        // 承認も実行も起きていない（行自体が出ない）。
        expect(result.step("approve")).toBeUndefined();
        expect(result.step("after-approve")).toBeUndefined();
        await expectNoLegMoved(harness);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-03e: 承認成功後に 2 回目の承認をしても R3 は再送されない",
    async () => {
      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "double-approve",
          harness,
          directory: await privateDir(),
        });
        expectDriverRan(result, "quote");
        expect(result.step("approve")?.["ok"]).toBe(true);
        expect(result.step("second-approve")?.["ok"]).toBe(false);
        // 2 回目で payer が再度呼ばれていない。
        expect(result.step("after-second")?.["payerCalls"]).toBe(1);
        // R3 到達は 1 回のまま（at-most-once）。
        const proxy = await harness.proxyCalls();
        expect(proxy.R3).toBe(1);
        const upstream = await upstreamCalls(harness.upstreamA);
        expect(upstream["payCalls"]).toBe(1);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-05a: 実鍵・実署名の能力を注入せず、起動ラベルが合成であることを隠さない",
    async () => {
      await withHarness({}, async (harness) => {
        // 起動行のラベルは合成レールのもの。real や fixture 能力のラベルを主張しない。
        const startup = harness.router.stdout();
        expect(startup).toContain('"label":"T1-synthetic-nopay"');
        expect(startup).not.toContain("T2-fixture-nopay");
      });
    },
    TIMEOUT,
  );

  it(
    "T5-05b: payer 未注入なら実行できる状態にならない",
    async () => {
      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "payer-unconfigured",
          harness,
          directory: await privateDir(),
          payer: "off",
        });
        expectDriverRan(result, "status");
        expect(result.step("status")?.["executionAvailability"]).toBe("source_payer_unconfigured");
        await expectNoLegMoved(harness);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-07: 他 principal からは参照できず、chat 側は安全に失敗する",
    async () => {
      await withHarness({}, async (harness) => {
        const directory = await privateDir();
        const owned = await drive({ scenario: "purchase", harness, directory });
        const purchase = owned.step("after-approve")?.["purchase"] as Record<string, unknown>;
        const paymentId = String(purchase["paymentId"]);

        // BOB の資格で ALICE の paymentId を引くと Router は存在すら明かさない。
        const response = await fetch(
          `${harness.routerOrigin}/v1/purchases/${encodeURIComponent(paymentId)}`,
          {
            headers: {
              "x-router-principal": BOB.id,
              authorization: `Bearer ${BOB.token}`,
            },
          },
        );
        expect(response.status).toBe(404);

        // ALICE の journal を BOB の資格で開き直そうとすると、chat 側は journal に
        // 保存された束縛の `principalId` と開こうとしている principal が違うことを見て
        // **開く前に** fail closed する（`router_storage_unavailable`）。
        // 他人の購入は「見えない」どころか状態を開けない。
        const foreign = await drive({
          scenario: "foreign-status",
          harness,
          directory,
          principal: BOB,
        });
        expect(foreign.step("driver-error")?.["error"]).toBe("router_storage_unavailable");
        // 他人の購入内容は 1 バイトも出てこない。
        expect(foreign.stdout).not.toContain(paymentId);
        expect(foreign.stdout).not.toContain("delivered");

        // ALICE 自身は同じ journal を開き直せる（分離であって破壊ではない）。
        const owner = await drive({ scenario: "reopen", harness, directory });
        expectDriverRan(owner, "reopened");
        expect(owner.step("reopened")?.["payment"]).toBe("delivered");
      });
    },
    TIMEOUT,
  );

  it(
    "T5-08: 応答送出前に Router が落ちても unknown が残り、自動再送しない",
    async () => {
      await withHarness({ crashBarrier: true }, async (harness) => {
        const directory = await privateDir();
        const result = await drive({ scenario: "purchase", harness, directory });
        expectDriverRan(result, "quote");
        // R3 は到達したが応答バイトは返っていない。
        const proxy = await harness.proxyCalls();
        expect(proxy.R3).toBe(1);
        expect(result.step("after-approve")?.["payment"]).toBe("unknown");
        expect(result.step("after-approve")?.["error"]).toBe("execution_unknown");

        // バリアは**応答直前**（両レグ確定後）なので、上流課金は 1 回起きている。
        // これは `unknown` の定義そのもので、0 を期待するのは誤り。
        const beforeRestart = await upstreamCalls(harness.upstreamA);
        expect(beforeRestart["payCalls"]).toBe(1);

        // Router を通常構成で復帰させ、同じ journal を再オープンする。
        await harness.restartRouter();
        const reopened = await drive({ scenario: "reopen", harness, directory });
        expectDriverRan(reopened, "reopened");
        // unknown は保持され、勝手に確定・再送されない。
        expect(reopened.step("reopened")?.["error"]).toBe("execution_unknown");
        // 再オープンで R3 も上流課金も**増えない**（自動再送しない）。
        const after = await harness.proxyCalls();
        expect(after.R3).toBe(1);
        const afterUpstream = await upstreamCalls(harness.upstreamA);
        expect(afterUpstream["payCalls"]).toBe(1);
      });
    },
    TIMEOUT,
  );

  it(
    "T5-10: chat 側の契約ファイルをピン留めし、変わったら明示的に失敗する",
    async () => {
      // 契約が動いたことを沈黙で見逃さないためのアンカー。
      // 適合先は router-contract.mjs と market-data.mjs の両方。
      const digest = async (file: string): Promise<string> =>
        createHash("sha256")
          .update(await readFile(path.join(CHAT_APP_DIR, file)))
          .digest("hex");
      expect(await digest("router-contract.mjs")).toBe(CONTRACT_SHA256);
      expect(await digest("market-data.mjs")).toBe(MARKET_DATA_SHA256);

      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "contract-anchor",
          harness,
          directory: await privateDir(),
        });
        expectDriverRan(result, "anchor");
        expect(result.step("anchor")?.["profile"]).toBe("chat-demo/router-market/v1");
        expect(result.step("anchor")?.["protocol"]).toBe("router-http/subetha");
      });
    },
    TIMEOUT,
  );

  it(
    "T5-11: journal のロックを保持している間は同じ操作を二重に開けない",
    async () => {
      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "lock-conflict",
          harness,
          directory: await privateDir(),
        });
        expectDriverRan(result, "quote");
        // 2 個目の open は fail closed（stale lock を再生扱いにしない）。
        // 実際に先に効くのは lock 取得より手前のディレクトリ内容照合（`storage_conflict`）で、
        // 「ロックが効いた」ではなく「同じ操作を二重に開けない」ことが確認できている。
        expect(result.step("second-open")?.["ok"]).toBe(false);
        expect(result.step("second-open")?.["error"]).toBe("storage_conflict");
      });
    },
    TIMEOUT,
  );

  it(
    "T5-06: Provider B 形の snapshot も chat の検証を通る",
    async () => {
      await withHarness({}, async (harness) => {
        const result = await drive({
          scenario: "purchase",
          harness,
          directory: await privateDir(),
          routeId: ROUTE_B,
          providerId: "market-data-b",
          upstreamUrl: `${harness.upstreamB.baseUrl}/v1/eth/snapshot`,
        });
        expectDriverRan(result, "quote");
        expect(result.step("approve")?.["ok"]).toBe(true);
        const purchase = result.step("after-approve")?.["purchase"] as Record<string, unknown>;
        const snapshot = purchase["result"] as Record<string, unknown>;
        expect(snapshot["providerId"]).toBe("market-data-b");
        expect((snapshot["dataSource"] as Record<string, unknown>)["name"]).toBe("uniswap-v3");
      });
    },
    TIMEOUT,
  );
});

/**
 * chat 側契約ファイルの内容ハッシュ。**chat 側が契約を変えたらここで落ちる**のが目的で、
 * 落ちたときは差分を読んで要件 §3 の 3 分岐（fixture 修正 / 製品コードはゲート戻し / 据え置き）
 * で判断する。値を黙って更新して緑に戻してはいけない。
 */
const CONTRACT_SHA256 = "19ee3e431357f5832f9817f1d7bedfce83563367f8505188c28a7c6bc8d1b0c2";
const MARKET_DATA_SHA256 = "448e2939b9b26fa0d02db61900e66b79d0b21ab53345c91efb0647307093db3a";
