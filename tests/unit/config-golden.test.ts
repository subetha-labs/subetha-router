/**
 * 公開の生成は byte 単位で不変（`docs/mainnet-first-route.md` SR-M3・R-1 #6）。
 * `tests/fixtures/config-golden/*.json` は origin/main（a89a979 相当、mainnet の変更の前）のコードで、ここと同じ入力から生成した。
 * 秘密は固定の合成値（鍵 0x11…、RPC の token）で、そのまま保存して値まで完全一致を見る。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { hostPlanOf } from "../../tools/remote-mcp.js";
import { RAILS_ACTIVATION, RAILS_NONE } from "../../tools/remote-mcp-config.js";

const key = "0x" + "11".repeat(32);
const base = { SUBETHA_OUTBOUND_PRIVATE_KEY: key, SUBETHA_ROUTER_RECEIVER: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405", SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-golden", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/v1/TOKEN", SUBETHA_ARC_RECEIVER_KEY: "0x" + "22".repeat(32), SUBETHA_SOLANA_RECEIVER: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5", SUBETHA_OUTBOUND_SOLANA_KEY: "2Lo8Y9kVf2iN4z3e5ZQ9k3nQJc7wq6yQx8k2mF9sP4tHc5uW1bX7aN3dR6gT9jK2", SUBETHA_ARC_PROVIDER_PAYTO: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", SUBETHA_SOLANA_PROVIDER_PAYTO: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc" };
const golden = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/config-golden", `${name}.json`), "utf8"));
const planOf = (activation: typeof RAILS_ACTIVATION, env: Record<string, string | undefined>) => hostPlanOf({ activation, bind: "127.0.0.1", port: 0, journalPath: "/tmp/golden.ndjson" }, env);

test.each([["public", RAILS_ACTIVATION], ["none", RAILS_NONE]] as const)("公開の生成（%s）は golden と完全に一致する", (name, activation) => {
  const plan = planOf(activation, base);
  const expected = golden(name);
  expect(plan.config).toEqual(expected.config);
  expect(Object.keys(plan.childEnv).sort()).toEqual(expected.childEnvKeys);
  // 値も完全一致（鍵・RPC の token は固定の合成値なので、入れ替わりや URL の変化も見える。R-3 #3）。
  expect(plan.childEnv).toEqual(expected.childEnv);
});

test("mainnet 用の env（chain id・mainnet RPC・CID）を与えても、公開の生成は変わらない", () => {
  const plan = planOf(RAILS_ACTIVATION, { ...base, SUBETHA_TEMPO_MAINNET_RPC_URL: "https://rpc.tempo.xyz", SUBETHA_MAINNET_FIRST_ROUTE: "1", SUBETHA_X402_OUTBOUND_NETWORK: "eip155:8453" });
  const expected = golden("public");
  expect(plan.config).toEqual(expected.config);
  expect(plan.childEnv).toEqual(expected.childEnv);
  expect(plan.childEnv["SUBETHA_X402_OUTBOUND_NETWORK"]).toBeUndefined();
  expect(JSON.stringify(plan.config)).not.toMatch(/eip155:8453"|eip155:4217"|coingecko/);
});
