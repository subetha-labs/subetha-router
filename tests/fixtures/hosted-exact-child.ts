/**
 * 試験用の Router の子（`tests/fixtures/hosted-exact-host.ts` が起動する）。**製品コードではない。**
 * 入口が書いた hosted の設定（`ROUTER_CONFIG_PATH`）から、**実証の route・予算・`subethaExact` の節はそのまま**残し、外へ出るものだけを落とす・差し替える:
 * - ほかの静的 route と動的の節（起動時に外の RPC・facilitator を読む）
 * - 上流の URL（`HX_TEST_UPSTREAM` の fixture へ）
 * - `HX_MAX_COMMITTED` があれば offer の上限（受付停止 = 0 の試験）
 * その後、実 `startRouter` を fixture の能力（署名しない spy、loopback の facilitator を許す）で起動する（`router-subetha-exact-process.ts`）。
 */
import { readFileSync, writeFileSync } from "node:fs";

import { HOSTED_EXACT } from "../../tools/remote-mcp-config.js";

const configPath = process.env["ROUTER_CONFIG_PATH"] ?? "";
const document = JSON.parse(readFileSync(configPath, "utf8")) as { router: { routes: Record<string, Record<string, unknown>>; dynamic?: unknown; budget: unknown }; x402: Record<string, unknown>; subethaExact?: unknown };
const route = document.router.routes[HOSTED_EXACT.routeId];
if (route === undefined || document.subethaExact === undefined) throw new Error("the hosted config has no subetha-exact demonstration route");
const cap = process.env["HX_MAX_COMMITTED"];
const kept = cap === undefined ? route : { ...route, offerCap: { maxCommitted: Number(cap) } };
const { dynamic: _dynamic, ...router } = document.router;
writeFileSync(configPath, JSON.stringify({ ...document, router: { ...router, routes: { [HOSTED_EXACT.routeId]: kept } }, x402: { upstreams: { [HOSTED_EXACT.routeId]: process.env["HX_TEST_UPSTREAM"] ?? "" } } }));
await import("./router-subetha-exact-process.js");
