/**
 * 起動の途中の失敗の片付け（`docs/subetha-exact-inbound-design.md` §5.4、タスク T-5）: 同じ process で `startRouter` を呼び、adapter の `startup()` の後
 * （listen）で失敗させる。journal と ledger の lock が解放されていること（同じ process で開き直せる: flock は open file description ごと）。
 * wire の試験では process の終了で OS が lock を解くので区別できない。ここが片付けの順の試験。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { openSubethaExactLedger } from "../../src/adapters/inbound/subetha-exact-ledger.js";
import { openJournal } from "../../src/core/journal.js";
import { startRouter } from "../../src/main.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

const BASE = "eip155:84532";
const ZUSDC = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const saved: Record<string, string | undefined> = {};
const KEYS = ["ROUTER_CONFIG_PATH", "ROUTER_PRINCIPAL_TOKENS", "ROUTER_ADAPTER_MODE", "ROUTER_SUBETHA_FACILITATOR_URL", "ROUTER_JOURNAL_PATH", "ROUTER_HTTP_PORT", "ROUTER_HTTP_HOST", "ROUTER_CANONICAL_BASE_URL", "ROUTER_SUBETHA_EXACT_FACILITATOR_URL", "ROUTER_SUBETHA_EXACT_TOKEN_FILE"];
let dir = "";

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("listen の失敗の後、journal と ledger の lock が解放されている（core.close → rails.shutdown の片付け）", async () => {
  for (const key of KEYS) saved[key] = process.env[key];
  dir = mkdtempSync(path.join(os.tmpdir(), "subetha-exact-startup-"));
  const configPath = path.join(dir, "router.config.json");
  const tokenFile = path.join(dir, "provider.token");
  writeFileSync(tokenFile, "fixture-provider-token-0123\n", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    router: {
      approvalTtlMs: 60_000,
      routes: { z: { routeId: "z", canonicalPath: "/v1/routes/z/resource", rail: "x402", sourceRail: "subetha-exact", source: { amount: "2000", asset: ZUSDC, decimals: 6, network: BASE }, destination: { scheme: "exact", network: BASE, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" } } },
      budget: { maxPurchases: 4, buckets: [{ network: BASE, asset: ZUSDC, maxTotal: "100000", maxPerPurchase: "20000" }, { network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }] },
    },
    x402: { upstreams: { z: "http://127.0.0.1:1/v1/eth/snapshot" } },
  }));
  // 使用中の port を用意する（listen の失敗）。
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const port = (blocker.address() as net.AddressInfo).port;
  const journalPath = path.join(dir, "journal.ndjson");
  Object.assign(process.env, {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_PRINCIPAL_TOKENS: "a:b",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "http://127.0.0.1:1",
    ROUTER_JOURNAL_PATH: journalPath,
    ROUTER_HTTP_PORT: String(port),
    ROUTER_HTTP_HOST: "127.0.0.1",
    ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
    ROUTER_SUBETHA_EXACT_FACILITATOR_URL: "http://127.0.0.1:1/p/router-test",
    ROUTER_SUBETHA_EXACT_TOKEN_FILE: tokenFile,
  });
  try {
    await expect(startRouter({ evmSigning: createSignerSpy().capability(BASE), fixtureFacilitators: true, knownNetworksForTest: TEST_NETWORKS })).rejects.toBeTruthy();
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
  // 両方の lock が解けている（残っていれば `journal_locked` で開けない）。
  const ledger = await openSubethaExactLedger({ dir: path.join(dir, "subetha-exact") });
  await ledger.close();
  const journal = await openJournal({ journalPath });
  await journal.close();
});
