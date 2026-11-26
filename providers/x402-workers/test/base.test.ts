/**
 * Base Sepolia 版の Provider（`docs/base-sepolia-facilitator-design.md` §5、AC-B5）: 402 が今の Provider A と同じ値、
 * 準備の確認（未払いの要求だけ・明示の true だけ・控え 2 秒・期限 2 秒）、ほかの network は要求の数が変わらないこと。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { KNOWN_NETWORKS } from "../../../src/shared/networks.js";
import { configOf, READY_CACHE_MS, READY_TIMEOUT_MS, TABLE, type ProviderEnv, type ProviderNetwork } from "../src/config.js";
import { handle, runtimeOf } from "../src/index.js";

const PAY_TO = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const FACILITATOR = `http://127.0.0.1:8611/${"t".repeat(40)}`;
const DATA = "http://127.0.0.1:8699/info";
const RESOURCE = "https://provider-x402-base.subethalabs.com/v1/eth/snapshot";
const BASE = "eip155:84532";
const HL = [{ universe: [{ name: "ETH" }] }, [{ markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00" }]];
/** 今の Provider A の `PAYMENT-REQUIRED`（2026-11-25 19:29Z に未払いの GET で読んだ値そのもの）。 */
const PROVIDER_A =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9wcm92aWRlci14NDAyLnN1YmV0aGFsYWJzLmNvbS92MS9ldGgvc25hcHNob3QiLCJkZXNjcmlwdGlvbiI6IkVUSCBwZXJwZXR1YWwgc25hcHNob3QgKEh5cGVybGlxdWlkIG1hcmsgcHJpY2UsIDI0aCBjaGFuZ2UpIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4OTAxNDA0Q0NmOEE0ZTYxMDUwZmMzQ0FlNEEyNmIwNWZEYzEzNmZFMSIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const READY = { networks: { [BASE]: { ready: true } } };

function fixture(network: string, ready: (init: RequestInit | undefined) => Promise<Response> | Response, verify: Record<string, unknown> = { isValid: true }) {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const op = url.startsWith(FACILITATOR) ? url.slice(FACILITATOR.length) : url === DATA ? "data" : url;
    calls.push(op);
    if (op === "/ready") {
      inits.push(init ?? {});
      return ready(init);
    }
    if (op === "data") return json(200, HL);
    if (op === "/supported") return json(200, { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} });
    if (op === "/verify") return json(200, verify);
    if (op === "/settle") return json(200, { success: true, transaction: `0x${"cd".repeat(32)}`, network });
    return json(404, {});
  }) as typeof fetch;
  return { calls, inits, fetch: impl, count: (op: string) => calls.filter((c) => c === op).length };
}
const envOf = (network: ProviderNetwork = "base"): ProviderEnv => ({ PROVIDER_NETWORK: network, PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_URL: DATA });
async function header(accepted: PaymentRequirements): Promise<string> {
  const created = await new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())).createPaymentPayload(2, accepted);
  return encodePaymentSignatureHeader({ x402Version: 2, resource: { url: RESOURCE }, accepted, payload: created.payload } as never);
}
const required = (r: Response): PaymentRequired => decodePaymentRequiredHeader(r.headers.get("payment-required") ?? "");

afterEach(() => vi.useRealTimers());

describe("402 は今の Provider A と同じ（FR-B7）", () => {
  test("accepts・description・mimeType・error が同じ。資源の URL だけが新しい名前", async () => {
    const fake = fixture(BASE, () => json(200, READY));
    const runtime = runtimeOf(envOf(), { fetch: fake.fetch });
    const now = required(await handle(new Request(RESOURCE), runtime, { fetch: fake.fetch }));
    const a = decodePaymentRequiredHeader(PROVIDER_A);
    expect(now).toEqual({ ...a, resource: { ...a.resource, url: RESOURCE } });
    expect(JSON.stringify(now.accepts)).toBe(JSON.stringify(a.accepts));
  });

  test("表の行は Router の表の USDC と一致し、facilitator の既定は無い", () => {
    const known = KNOWN_NETWORKS.find((n) => n.network === BASE)!;
    const asset = known.assets.find((x) => x.id === TABLE.base.asset)!;
    expect(asset.rails).toBeUndefined();
    expect({ decimals: asset.decimals, domain: asset.domain }).toEqual({ decimals: 6, domain: { name: "USDC", version: "2" } });
    expect(TABLE.base).toMatchObject({ amount: "10000", maxTimeoutSeconds: 60, facilitatorUrl: "", facilitatorKind: "x402", readiness: true, deadlines: TABLE.rh.deadlines });
    expect(() => configOf({ PROVIDER_NETWORK: "base", PAY_TO })).toThrow("FACILITATOR_URL is required for base");
    expect(() => configOf({ ...envOf(), SELLER_PROOF_KEY: generatePrivateKey() })).toThrow("SELLER_PROOF_KEY must not be set for base");
    expect(Object.values(TABLE).filter((row) => row.readiness === true)).toEqual([TABLE.base]);
  });

  test("支払いつき: verify・settle 各 1 回で 200。本文の network は Base。/ready は見ない", async () => {
    const fake = fixture(BASE, () => json(200, READY));
    const runtime = runtimeOf(envOf(), { fetch: fake.fetch });
    const accepted = required(await handle(new Request(RESOURCE), runtime, { fetch: fake.fetch })).accepts[0]!;
    const before = fake.count("/ready");
    const paid = await handle(new Request(RESOURCE, { headers: { "payment-signature": await header(accepted) } }), runtime, { fetch: fake.fetch });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ providerId: "market-data-a", payment: { protocol: "x402", network: BASE } });
    expect([fake.count("/verify"), fake.count("/settle"), fake.count("/ready")]).toEqual([1, 1, before]);
  });

  test("支払いつきで facilitator_not_ready（verify の isValid false）→ 402、settle 0 回", async () => {
    const fake = fixture(BASE, () => json(200, READY), { isValid: false, invalidReason: "facilitator_not_ready" });
    const runtime = runtimeOf(envOf(), { fetch: fake.fetch });
    const accepted = required(await handle(new Request(RESOURCE), runtime, { fetch: fake.fetch })).accepts[0]!;
    const r = await handle(new Request(RESOURCE, { headers: { "payment-signature": await header(accepted) } }), runtime, { fetch: fake.fetch });
    expect(r.status).toBe(402);
    expect(fake.count("/settle")).toBe(0);
    expect(await r.text()).not.toContain("not_ready");
  });
});

describe("準備の確認（FR-B5）: 明示の true だけ 402、ほかは 503", () => {
  const rows: Array<[string, () => Promise<Response> | Response]> = [
    ["ready false", () => json(200, { networks: { [BASE]: { ready: false } } })],
    ["Base が無い", () => json(200, { networks: {} })],
    ["別の network だけ true", () => json(200, { networks: { "eip155:46630": { ready: true } } })],
    ["true でない真値", () => json(200, { networks: { [BASE]: { ready: "true" } } })],
    ["欄の形違い", () => json(200, { networks: { [BASE]: true } })],
    ["networks が配列", () => json(200, { networks: [{ ready: true }] })],
    ["404（古い facilitator）", () => json(404, { error: "not_found" })],
    ["503（drain）", () => json(503, { error: "draining", ...READY })],
    ["302", () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/ready" } })],
    ["JSON でない", () => new Response("ok", { status: 200 })],
    ["大きすぎる", () => json(200, { ...READY, pad: "x".repeat(70_000) })],
    ["接続の失敗", () => Promise.reject(new Error("down"))],
  ];
  test.each(rows)("%s → 503 固定文、402 のヘッダなし", async (_n, ready) => {
    const fake = fixture(BASE, ready);
    const r = await handle(new Request(RESOURCE), runtimeOf(envOf(), { fetch: fake.fetch }), { fetch: fake.fetch });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "facilitator_unavailable" });
    expect(r.headers.get("payment-required")).toBeNull();
    expect(fake.count("/ready")).toBe(1);
    expect(fake.inits[0]!.redirect).toBe("manual");
  });

  test("返らない → 2 秒で 503", async () => {
    vi.useFakeTimers();
    const fake = fixture(BASE, (init) => new Promise((_r, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = handle(new Request(RESOURCE), runtimeOf(envOf(), { fetch: fake.fetch }), { fetch: fake.fetch });
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect((await pending).status).toBe(503);
    expect(READY_TIMEOUT_MS).toBe(2_000);
  });

  test("控えは 2 秒（true も false も）。過ぎれば読み直す", async () => {
    let now = 1_000_000;
    let ready = true;
    const fake = fixture(BASE, () => json(200, { networks: { [BASE]: { ready } } }));
    const runtime = runtimeOf(envOf(), { fetch: fake.fetch, now: () => now });
    const get = async () => (await handle(new Request(RESOURCE), runtime, { fetch: fake.fetch, now: () => now })).status;
    expect(await get()).toBe(402);
    ready = false;
    now += READY_CACHE_MS - 1;
    expect(await get()).toBe(402);
    expect(fake.count("/ready")).toBe(1);
    now += 1;
    expect(await get()).toBe(503);
    ready = true;
    expect(await get()).toBe(503);
    now += READY_CACHE_MS;
    expect(await get()).toBe(402);
    expect(fake.count("/ready")).toBe(3);
  });

  test("ほかの network は /ready を呼ばない（要求の数は今と同じ）", async () => {
    for (const name of ["rh", "arbsep", "hyperevm", "sepolia"] as const) {
      const fake = fixture(TABLE[name].network, () => json(200, {}));
      const r = await handle(new Request("https://p.local/v1/eth/snapshot"), runtimeOf(envOf(name), { fetch: fake.fetch }), { fetch: fake.fetch });
      expect(r.status).toBe(402);
      expect(fake.calls).toEqual(["/supported"]);
    }
  });
});
