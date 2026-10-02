/**
 * SSRF 防御 A（設計 T-A15）: `composeRails` は adapter ごとに transport を作り、fixture 例外は
 * **その adapter の能力**だけで決まる。env や設定からは変えられない。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { beforeAll, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../../src/config.js";
import { composeRails, type RouterCapabilities } from "../../src/main.js";
import { TransportError, type TransportEvent } from "../../src/net/guarded-fetch.js";
import type { EvmSigningCapability, MppTempoCapability } from "../../src/ports/outbound.js";
import { createPayerSpy } from "../fixtures/mpp-payer-spy.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

/** 誰も聞いていない loopback の URL（allowed なら connect_failed、禁止なら destination_blocked）。port は実行時に取る（undici は 9 等の "bad port" を接続前に拒むので固定しない）。 */
let LOOPBACK_CLOSED = "";
beforeAll(async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  LOOPBACK_CLOSED = `http://127.0.0.1:${port}/`;
});

function configFor(mode: "real" | "synthetic"): Record<string, string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "compose-rails-"));
  const routes = {
    "r-x402": {
      routeId: "r-x402",
      canonicalPath: "/v1/routes/r-x402/resource",
      rail: "x402",
      source: { amount: "1500", asset: "0x0000000000000000000000000000000000005ce7", decimals: 6, network: "eip155:11155111" },
      destination: { scheme: "exact", network: "eip155:84532", asset: "0x000000000000000000000000000000000000de57", payTo: "0x0000000000000000000000000000000000000a11" },
    },
    "r-mpp": {
      routeId: "r-mpp",
      canonicalPath: "/v1/routes/r-mpp/resource",
      rail: "mpp",
      source: { amount: "1500", asset: "0x0000000000000000000000000000000000005ce7", decimals: 6, network: "eip155:11155111" },
      destination: { scheme: "tempo/charge", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", payTo: "0x00000000000000000000000000000000000000b1" },
    },
  };
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes,
      budget: {
        maxPurchases: 8,
        buckets: [
          { network: "eip155:11155111", asset: "0x0000000000000000000000000000000000005ce7", maxTotal: "100000", maxPerPurchase: "5000" },
          { network: "eip155:84532", asset: "0x000000000000000000000000000000000000de57", maxTotal: "100000", maxPerPurchase: "5000" },
          { network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", maxTotal: "100000", maxPerPurchase: "5000" },
        ],
      },
    },
    ...(mode === "real"
      ? { x402: { upstreams: { "r-x402": `${LOOPBACK_CLOSED}v1/eth/snapshot`, "r-mpp": `${LOOPBACK_CLOSED}v1/eth/snapshot` } } }
      : { synthetic: { facilitatorUrl: LOOPBACK_CLOSED.replace(/\/$/, ""), upstreams: { "r-x402": `${LOOPBACK_CLOSED}v1/eth/snapshot`, "r-mpp": `${LOOPBACK_CLOSED}v1/eth/snapshot` } } }),
  };
  const file = path.join(dir, "router.config.json");
  writeFileSync(file, JSON.stringify(document));
  return {
    ROUTER_CONFIG_PATH: file,
    ROUTER_PRINCIPAL_TOKENS: "a:b",
    ROUTER_ADAPTER_MODE: mode,
    ROUTER_SUBETHA_FACILITATOR_URL: LOOPBACK_CLOSED.replace(/\/$/, ""),
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
  };
}

/** 実鍵の能力のつもりの object。要求は接続前に拒否されるので署名には触れない。 */
const REAL_EVM: EvmSigningCapability = {
  network: "eip155:84532",
  signer: { address: "0x0000000000000000000000000000000000000501", signTypedData: async () => "0x" } as unknown as EvmSigningCapability["signer"],
  kind: "real-key",
};
const REAL_MPP: MppTempoCapability = {
  chainId: 42431,
  account: { address: "0x0000000000000000000000000000000000000502" } as unknown as MppTempoCapability["account"],
  getClient: () => {
    throw new Error("must not be reached");
  },
  kind: "real-key",
};

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TransportError) return error.code;
    return `other:${(error as Error).message}`;
  }
}

function compose(mode: "real" | "synthetic", capabilities: RouterCapabilities, env: Record<string, string> = {}) {
  const events: TransportEvent[] = [];
  const config = loadRuntimeConfig({ ...configFor(mode), ...env }, (file) => readFileSync(file, "utf8"));
  const rails = composeRails(config, capabilities, (event) => events.push(event));
  return { rails, events };
}

describe("composeRails transport allowances (T-A15)", () => {
  it("x402 が実鍵で MPP が fixture: x402 だけ loopback を拒否し、MPP は接続まで進む", async () => {
    const { rails, events } = compose("real", { evmSigning: REAL_EVM, mppTempo: createPayerSpy().capability() });
    expect(await outcomeOf(rails.outbound.readChallenge("r-x402"))).toBe("destination_blocked");
    expect(await outcomeOf(rails.outbound.readChallenge("r-mpp"))).toBe("connect_failed");
    expect(events.map((e) => [e.code, e.routeId])).toEqual([["destination_blocked", "r-x402"], ["connect_failed", "r-mpp"]]);
  });

  it("逆: MPP が実鍵で x402 が fixture", async () => {
    const { rails, events } = compose("real", { evmSigning: createSignerSpy().capability("eip155:84532"), mppTempo: REAL_MPP });
    expect(await outcomeOf(rails.outbound.readChallenge("r-mpp"))).toBe("destination_blocked");
    expect(await outcomeOf(rails.outbound.readChallenge("r-x402"))).toBe("connect_failed");
    expect(events.map((e) => [e.code, e.routeId])).toEqual([["destination_blocked", "r-mpp"], ["connect_failed", "r-x402"]]);
  });

  it("受信 facilitator: fixtureFacilitators 無しの real は loopback を拒否、有りなら接続まで進む", async () => {
    const offerRequest = { routeId: "r-x402", amount: "1500", asset: "0x0000000000000000000000000000000000005ce7", network: "eip155:11155111", routeBinding: "b", nowMs: Date.now() };
    const strict = compose("real", { evmSigning: createSignerSpy().capability("eip155:84532"), mppTempo: createPayerSpy().capability() });
    expect(await outcomeOf(strict.rails.inbound.createOffer(offerRequest))).toBe("destination_blocked");
    const fixture = compose("real", { evmSigning: createSignerSpy().capability("eip155:84532"), mppTempo: createPayerSpy().capability(), fixtureFacilitators: true });
    expect(await outcomeOf(fixture.rails.inbound.createOffer(offerRequest))).toBe("connect_failed");
  });

  it("synthetic は全部 fixture 扱い（loopback まで接続する）", async () => {
    const { rails } = compose("synthetic", {});
    expect(await outcomeOf(rails.outbound.readChallenge("r-x402"))).toBe("connect_failed");
    expect(await outcomeOf(rails.inbound.createOffer({ routeId: "r-x402", amount: "1500", asset: "0x0000000000000000000000000000000000005ce7", network: "eip155:11155111", routeBinding: "b", nowMs: Date.now() }))).toBe("connect_failed");
  });

  it("env では変えられない（見覚えのない変数を足しても実鍵の adapter は拒否のまま）", async () => {
    const { rails } = compose("real", { evmSigning: REAL_EVM, mppTempo: REAL_MPP }, { ROUTER_ALLOW_LOOPBACK: "1", ALLOW_LOOPBACK: "true" });
    expect(await outcomeOf(rails.outbound.readChallenge("r-x402"))).toBe("destination_blocked");
    expect(await outcomeOf(rails.outbound.readChallenge("r-mpp"))).toBe("destination_blocked");
  });
});
