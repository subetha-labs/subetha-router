/**
 * 公開の生成は byte 単位で不変（`docs/mainnet-first-route.md` SR-M3・R-1 #6）。
 * `tests/fixtures/config-golden/*.json` は origin/main（a89a979 相当、mainnet の変更の前）のコードで、ここと同じ入力から生成した。
 * 秘密は固定の合成値（鍵 0x11…、RPC の token）で、そのまま保存して値まで完全一致を見る。
 *
 * EVM testnet 3 つの G-4（`docs/evm-testnets-hosted-design.md` §8.2、2026-10-14 に `RAILS_ACTIVATION.evm` を全部 true）の後:
 * - `public-pre-evm.json` は G-4 の前の `public.json` そのもの（byte 一致。evm が全部 false の公開の生成 = AC-H1 の基準）。
 * - `public.json` は G-4 の定数から、ここと同じ入力（`base` + facilitator の env `evmFacilitatorEnv`）で `hostPlanOf` を呼び、
 *   `JSON.stringify({ config, childEnvKeys: Object.keys(childEnv).sort(), childEnv }, null, 1)`（末尾の改行なし）で書き直した。
 *   同じ書き方で evm を `EVM_NONE` にすると `public-pre-evm.json` と byte 一致することを確かめてから書いた。
 *   G-4 の前との差分が追加だけ（36 本・3 区分・3 facilitator、子の env は 6 語と facilitator の URL）であることは `tests/unit/evm-hosted-config.test.ts`（SR-H2）が見る。
 * facilitator の env の値も試験用の固定値（gas 鍵 0x44…。Router の子の env にも golden にも出ない）。
 *
 * SubEtha（zUSDC）の受信のタスク T1（`docs/subetha-hosted-inbound-tasks.md`）: 3 つの golden を同じ入力・同じ書き方で書き直した。差分は 3 つとも
 * `router.dynamic.denyHosts` に `zerc20-facilitator.subethalabs.com` が 1 語増えただけ（有効化に関係なく拒否する。要件 FR-3.4）。`subetha` は公開の定数で `false` なので、
 * route・区分・子の env は変わらない。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { hostPlanOf } from "../../tools/remote-mcp.js";
import { EVM_NONE, RAILS_ACTIVATION, RAILS_NONE, type RailsActivation } from "../../tools/remote-mcp-config.js";

const key = "0x" + "11".repeat(32);
const base = { SUBETHA_OUTBOUND_PRIVATE_KEY: key, SUBETHA_ROUTER_RECEIVER: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405", SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-golden", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/v1/TOKEN", SUBETHA_ARC_RECEIVER_KEY: "0x" + "22".repeat(32), SUBETHA_SOLANA_RECEIVER: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5", SUBETHA_OUTBOUND_SOLANA_KEY: "2Lo8Y9kVf2iN4z3e5ZQ9k3nQJc7wq6yQx8k2mF9sP4tHc5uW1bX7aN3dR6gT9jK2", SUBETHA_ARC_PROVIDER_PAYTO: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", SUBETHA_SOLANA_PROVIDER_PAYTO: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc" };
/** G-4 の後の公開の計画は自前の EVM facilitator の子を計画する。その env（試験用の固定値）。URL は計画が token と既定の port 8611 から作る。 */
const evmFacilitatorEnv = { SUBETHA_EVM_FACILITATOR_KEY: "0x" + "44".repeat(32), SUBETHA_EVM_FACILITATOR_TOKEN: "config-golden-token_0123456789abcdefABCDEF", SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000", SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "1000000000000000", SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "1000000000000000", SUBETHA_EVM_PROVIDER_PAYTO: "0xf8243d93F339807CA9846Aa31155A2B2262D08db" };
const golden = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/config-golden", `${name}.json`), "utf8"));
const planOf = (activation: RailsActivation, env: Record<string, string | undefined>) => hostPlanOf({ activation, bind: "127.0.0.1", port: 0, journalPath: "/tmp/golden.ndjson" }, env);

test.each([
  // G-4 の後の公開の定数（EVM testnet 3 つが全部 true）。
  ["public", RAILS_ACTIVATION, { ...base, ...evmFacilitatorEnv }],
  // G-4 の前の形（evm が全部 false）: 前の golden と byte 一致のまま。facilitator の env があっても読まない。
  ["public-pre-evm", { ...RAILS_ACTIVATION, evm: EVM_NONE }, base],
  ["public-pre-evm", { ...RAILS_ACTIVATION, evm: EVM_NONE }, { ...base, ...evmFacilitatorEnv }],
  ["none", RAILS_NONE, base],
] as const)("公開の生成（%s）は golden と完全に一致する", (name, activation, env) => {
  const plan = planOf(activation, env);
  const expected = golden(name);
  expect(plan.config).toEqual(expected.config);
  expect(Object.keys(plan.childEnv).sort()).toEqual(expected.childEnvKeys);
  // 値も完全一致（鍵・RPC の token は固定の合成値なので、入れ替わりや URL の変化も見える。R-3 #3）。
  expect(plan.childEnv).toEqual(expected.childEnv);
  // facilitator の子は EVM testnet が有効なときだけ。gas 鍵は Router の子の env・設定に出ない。
  if (name === "public") {
    expect(plan.facilitator?.networks).toEqual(["eip155:46630", "eip155:421614", "eip155:998"]);
    expect(plan.facilitator?.url).toBe(`http://127.0.0.1:8611/${evmFacilitatorEnv.SUBETHA_EVM_FACILITATOR_TOKEN}`);
  } else {
    expect(plan.facilitator).toBeUndefined();
  }
  expect(JSON.stringify(plan.config) + JSON.stringify(plan.childEnv)).not.toContain("44".repeat(32));
});

test("mainnet 用の env（chain id・mainnet RPC・CID）を与えても、公開の生成は変わらない", () => {
  const plan = planOf(RAILS_ACTIVATION, { ...base, ...evmFacilitatorEnv, SUBETHA_TEMPO_MAINNET_RPC_URL: "https://rpc.tempo.xyz", SUBETHA_MAINNET_FIRST_ROUTE: "1", SUBETHA_X402_OUTBOUND_NETWORK: "eip155:8453" });
  const expected = golden("public");
  expect(plan.config).toEqual(expected.config);
  expect(plan.childEnv).toEqual(expected.childEnv);
  expect(plan.childEnv["SUBETHA_X402_OUTBOUND_NETWORK"]).toBeUndefined();
  expect(JSON.stringify(plan.config)).not.toMatch(/eip155:8453"|eip155:4217"|coingecko/);
});

/**
 * 診断の記録（`docs/rejection-reasons-design.md` §2.1、タスク R-2）: golden の 3 つは R-2 で子の env に `SUBETHA_DIAGNOSTICS_PATH` の 1 語だけを足した
 * （設定は不変。`git diff` の差分は 1 つの鍵の追加と、前の最後の行の末尾の `,` だけ）。ここでは追加だけであることを値で確かめる:
 * `SUBETHA_DIAGNOSTICS=off` の計画は golden からその鍵を除いたものと一致し、`off` でない計画との差はその鍵 1 つ（値は journal の隣）。
 */
test.each([
  ["public", RAILS_ACTIVATION, { ...base, ...evmFacilitatorEnv }],
  ["public-pre-evm", { ...RAILS_ACTIVATION, evm: EVM_NONE }, base],
  ["none", RAILS_NONE, base],
] as const)("診断の記録の env（%s）: 足したのは SUBETHA_DIAGNOSTICS_PATH の 1 語だけ。off なら R-2 の前と同じ", (name, activation, env) => {
  const expected = golden(name);
  const { SUBETHA_DIAGNOSTICS_PATH: added, ...before } = expected.childEnv as Record<string, string>;
  expect(added).toBe("/tmp/diagnostics/router.ndjson");
  const off = planOf(activation, { ...env, SUBETHA_DIAGNOSTICS: "off" });
  expect(off.config).toEqual(expected.config);
  expect(off.childEnv).toEqual(before);
  expect(Object.keys(off.childEnv).sort()).toEqual((expected.childEnvKeys as string[]).filter((key) => key !== "SUBETHA_DIAGNOSTICS_PATH"));
  const on = planOf(activation, env);
  expect(Object.keys(on.childEnv).filter((key) => !(key in off.childEnv))).toEqual(["SUBETHA_DIAGNOSTICS_PATH"]);
  for (const [key, value] of Object.entries(off.childEnv)) expect(on.childEnv[key]).toBe(value);
  // `off` 以外の値では止めない（新しい env は必須にしない、止めるのは `off` だけ）。
  expect(planOf(activation, { ...env, SUBETHA_DIAGNOSTICS: "on" }).childEnv).toEqual(expected.childEnv);
});

test("診断の記録の env: mainnet の 1 経路の計画には足さない", () => {
  const mainnet = hostPlanOf({ activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/golden-mainnet.ndjson", mainnetFirstRoute: true }, { ...base });
  expect(mainnet.childEnv["SUBETHA_DIAGNOSTICS_PATH"]).toBeUndefined();
});
