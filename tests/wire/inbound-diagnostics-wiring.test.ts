/**
 * 受信の adapter の診断の配線（設計 `docs/rejection-reasons-design.md` §2.3・§4.2、タスク R-3）: `composeRails` が
 * `RouterCapabilities.diagnostics` を x402 の kind `x402`（Base Sepolia）・`circle`（Arc）・SVM（Solana devnet）の受信の adapter に渡す。
 * 本番と同じ設定の読み方（real モード）と transport の方針（loopback 不可・名前解決の fixture・`dialForTest`）で、相手は loopback の
 * TLS の fake facilitator（プロセス内）。**無課金**。鍵は乱数、署名は売り手証明（試験の能力）だけ。
 */
import { createServer, type Server } from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { loadRuntimeConfig, routeBindingOf, type RuntimeConfig } from "../../src/config.js";
import { composeRails, type RouterCapabilities } from "../../src/main.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { diagCorrelationIdOf, withDiagnosticScope } from "../../src/shared/diagnostics.js";
import { REASON_TABLE_VERSION } from "../../src/shared/payment-reasons.js";
import { railsCapabilitiesOf, railsOptionsOf, SOLANA_RECEIVER_ENV } from "../../tools/rails-entry.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { ARC_RECEIVER_KEY_ENV } from "../../tools/real-seller-proof-capability.js";
import { ROUTE_ARC, ROUTE_SOL, routerConfigOf, type RailsActivation } from "../../tools/remote-mcp-config.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { recordingDiagnostics } from "../fixtures/diagnostics.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const ROUTE_BASE = "md-mpp-eth-snapshot";
const BOTH: RailsActivation = { arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
const FROM = "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1";
const NONCE = `0x${"aB".repeat(32)}`;
const CANARY = "R3WIRECANARY51c";
const HOSTS = { base: "facilitator.provider.test", arc: "arc.provider.test", sol: "sol.provider.test" } as const;

let TLS: TlsMaterial;
let server: Server;
let port = 0;
const seen: string[] = [];
beforeAll(async () => {
  TLS = generateTestTls();
  server = createServer({ cert: TLS.provider.cert, key: TLS.provider.key }, (req, res) => {
    seen.push(`${req.headers.host} ${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      const svm = req.headers.host === HOSTS.sol;
      res.end(JSON.stringify({ isValid: false, invalidReason: svm ? "invalid_exact_svm_payload_missing_fee_payer" : "invalid_exact_evm_insufficient_balance", invalidMessage: CANARY }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  TLS.cleanup();
});
const dirs: string[] = [];
afterEach(() => {
  seen.length = 0;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function loadAsProduction(document: Record<string, unknown>): RuntimeConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "r3-wiring-"));
  dirs.push(dir);
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const config = loadRuntimeConfig(
    {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${HOSTS.base}`,
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-r3w",
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    },
    (file) => readFileSync(file, "utf8"),
  );
  // Arc・Solana の受信の facilitator を fixture のホストに向ける（kind はそのまま）。
  const real = config.real as unknown as { x402InboundFacilitators: Record<string, { url: string; kind: string }> };
  const facilitators = { ...real.x402InboundFacilitators };
  for (const [network, entry] of Object.entries(facilitators)) {
    facilitators[network] = { ...entry, url: `https://${network.startsWith("solana:") ? HOSTS.sol : HOSTS.arc}` };
  }
  real.x402InboundFacilitators = facilitators;
  return config;
}

function capabilitiesOf(env: Record<string, string>, withDiagnostics: ReturnType<typeof recordingDiagnostics> | undefined): RouterCapabilities {
  const rails = railsCapabilitiesOf(BOTH, env);
  const hooks = { interfaces: () => [], lookup: publicLookup(), tls: { ca: [TLS.ca] }, dialForTest: dialTo({ [HOSTS.base]: port, [HOSTS.arc]: port, [HOSTS.sol]: port }) };
  return {
    evmSigning: createRealEvmCapability(generatePrivateKey()).capability("eip155:84532"),
    mppTempo: createRealMppCapability(generatePrivateKey()).capability(),
    dependencyUrls: ["https://rpc.moderato.tempo.xyz/", ...(rails.dependencyUrls ?? [])],
    ...(rails.sellerProofs === undefined ? {} : { sellerProofs: rails.sellerProofs }),
    transportHooksForTest: hooks,
    dynamicTransportHooksForTest: hooks,
    ...(withDiagnostics === undefined ? {} : { diagnostics: Object.assign(withDiagnostics, { close: async () => {} }) }),
  };
}

describe("composeRails: 受信の adapter に診断の sink が届く（x402・circle・SVM）", () => {
  test("verify の往復で adapter の 1 行（facilitator・network・response・reason、EVM は cid）。結果と要求は sink 無しと同じ", async () => {
    const env = { [ARC_RECEIVER_KEY_ENV]: generatePrivateKey(), [SOLANA_RECEIVER_ENV]: SOL_OWNER };
    const document = routerConfigOf({}, RECEIVER, true, railsOptionsOf(BOTH, env));
    const run = async (sink: ReturnType<typeof recordingDiagnostics> | undefined) => {
      seen.length = 0;
      const config = loadAsProduction(document);
      const composed = composeRails(config, capabilitiesOf(env, sink), () => {}, () => {});
      const results: unknown[] = [];
      for (const routeId of [ROUTE_BASE, ROUTE_ARC, ROUTE_SOL]) {
        const route = config.router.routes[routeId]!;
        const svm = route.source.network.startsWith("solana:");
        const binding = routeBindingOf(route);
        const offer: InboundOffer = svm
          ? { scheme: "exact", network: route.source.network, asset: route.source.asset, amount: route.source.amount, payTo: SOL_OWNER, maxTimeoutSeconds: 40, extra: { challengeNonce: NONCE.toLowerCase(), expiresAt: 1_900_000_000, routeBinding: binding } }
          : await composed.inbound.createOffer({ routeId, amount: route.source.amount, asset: route.source.asset, network: route.source.network, routeBinding: binding, nowMs: Date.now() });
        const credential: PaymentCredential = svm
          ? { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, transaction: "AQ==" } }
          : { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, authorization: { from: FROM, nonce: NONCE }, signature: "0x00" } };
        results.push(await withDiagnosticScope({ paymentId: "00000000-0000-4000-8000-000000000033" }, () => composed.inbound.verify(offer, credential, { routeId })));
      }
      return { results, seen: [...seen], config };
    };
    const plain = await run(undefined);
    const sink = recordingDiagnostics("router");
    const recorded = await run(sink);
    expect(recorded.results).toEqual(plain.results);
    expect(recorded.seen).toEqual(plain.seen);
    expect(plain.results).toEqual([{ isValid: false }, { isValid: false }, { isValid: false }]);
    expect(plain.seen.map((line) => line.replace(/:\d+ /, " "))).toEqual([`${HOSTS.base} POST /verify`, `${HOSTS.arc} POST /verify`, `${HOSTS.sol} POST /verify`]);
    expect(sink.rejected()).toBe(0);
    const records = sink.records();
    expect(JSON.stringify(records)).not.toContain(CANARY);
    const routes = recorded.config.router.routes;
    const expected = [
      { network: routes[ROUTE_BASE]!.source.network, facilitator: "x402", reason: "invalid_exact_evm_insufficient_balance", cid: diagCorrelationIdOf(routes[ROUTE_BASE]!.source.network, routes[ROUTE_BASE]!.source.asset, FROM, NONCE) },
      { network: routes[ROUTE_ARC]!.source.network, facilitator: "circle", reason: "invalid_exact_evm_insufficient_balance", cid: diagCorrelationIdOf(routes[ROUTE_ARC]!.source.network, routes[ROUTE_ARC]!.source.asset, FROM, NONCE) },
      { network: routes[ROUTE_SOL]!.source.network, facilitator: "x402", reason: "invalid_exact_svm_payload_missing_fee_payer" },
    ];
    expect(records.map((r) => ({ stage: r.stage, network: r.network, facilitator: r.facilitator, reason: r.reason, cid: r.cid, httpStatus: r.httpStatus, response: r.response, table: r.table }))).toEqual(
      expected.map((e) => ({ stage: "source_verify", cid: undefined, ...e, httpStatus: 200, response: "invalid", table: REASON_TABLE_VERSION })),
    );
  });
});
