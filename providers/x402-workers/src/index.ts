/**
 * Provider（x402 v2 `exact` の資源サーバ。Cloudflare Workers）の fetch handler（`docs/provider-x402-workers.md` §2.2・§3.1）。
 * 順序: 402（未払い）／ `accepted` の一致 → データ → verify → settle（1 回）→ 領収の検査 → 200。
 * 応答の本文とヘッダは固定文だけ（facilitator の文言・鍵・URL を含めない）。
 */
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";

import { configOf, RESOURCE_PATH, type ProviderConfig, type ProviderEnv } from "./config.js";
import { DATA_TIMEOUT_MS, INIT_TIMEOUT_MS, RequestDeadline, SETTLE_TIMEOUT_MS, VERIFY_TIMEOUT_MS, within } from "./deadline.js";
import { BoundedFacilitatorClient, FacilitatorUnavailableError, SettleCalledTwiceError } from "./facilitator-client.js";
import { checkReceipt } from "./receipt.js";
import { createRequirementsBuilder, type RequirementsBuilder } from "./requirements.js";
import type { SellerProofSigner } from "./seller-proof.js";
import { DataUnavailableError, fetchSnapshot, type Snapshot } from "./snapshot.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** isolate ごとの状態（config の検査・署名の closure・requirements の builder）。鍵は closure の中だけ。 */
interface Runtime {
  readonly config: ProviderConfig;
  readonly signer: SellerProofSigner | undefined;
  readonly builder: RequirementsBuilder;
  readonly facilitatorFor: (fetchImpl: typeof fetch) => BoundedFacilitatorClient;
}

export interface Hooks {
  /** 試験の差し替え（facilitator・データ源への fetch）。 */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function runtimeOf(env: ProviderEnv, hooks: Hooks = {}): Runtime {
  const config = configOf(env);
  let signer: SellerProofSigner | undefined;
  if (config.network === "arc") {
    const account = privateKeyToAccount(config.sellerProofKey as `0x${string}`);
    if (account.address.toLowerCase() !== config.payTo.toLowerCase()) throw new Error("PAY_TO does not match the address of SELLER_PROOF_KEY");
    signer = {
      network: config.table.network,
      chainId: 5042002,
      address: account.address,
      signTypedData: (typedData) => account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message }),
      ...(hooks.now === undefined ? {} : { now: hooks.now }),
    };
  }
  const fetchImpl = hooks.fetch ?? fetch;
  const facilitatorFor = (f: typeof fetch): BoundedFacilitatorClient => new BoundedFacilitatorClient({ url: config.facilitatorUrl, ...(signer === undefined ? {} : { signer }), fetch: f });
  const builder = createRequirementsBuilder(config, facilitatorFor(fetchImpl));
  return { config, signer, builder, facilitatorFor };
}

export async function handle(request: Request, runtime: Runtime, hooks: Hooks = {}): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== RESOURCE_PATH) return json(404, { error: "not_found" });
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (url.search !== "") return json(404, { error: "not_found" });
  const deadline = new RequestDeadline(hooks.now ?? Date.now);
  const canonical = `${url.origin}${RESOURCE_PATH}`;
  const fetchImpl = hooks.fetch ?? fetch;

  // isolate の最初の要求: facilitator の `/supported`（上限 5 秒、要求の期限の内側）。
  try {
    await within(deadline.budgetFor(INIT_TIMEOUT_MS), runtime.builder.ready());
  } catch {
    return json(503, { error: "facilitator_unavailable" });
  }

  const header = request.headers.get("payment-signature");
  if (header === null || header === "") {
    const required = await runtime.builder.paymentRequired(canonical);
    return json(402, {}, { "payment-required": encodePaymentRequiredHeader(required) });
  }

  // 0. decode と `accepted` の完全一致。
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return json(402, { error: "payment_invalid" }, { "payment-required": encodePaymentRequiredHeader(await runtime.builder.paymentRequired(canonical, "payment_invalid")) });
  }
  const requirements = await runtime.builder.match(payload);
  if (requirements === undefined || payload.x402Version !== 2) {
    return json(402, { error: "payment_invalid" }, { "payment-required": encodePaymentRequiredHeader(await runtime.builder.paymentRequired(canonical, "no_matching_requirements")) });
  }

  // 1. データ（支払いの前。取れなければ facilitator を呼ばない）。
  let snapshot: Snapshot;
  try {
    snapshot = await fetchSnapshot(runtime.config.dataUrl, runtime.config.table.network, deadline.budgetFor(DATA_TIMEOUT_MS), fetchImpl, hooks.now);
  } catch (error) {
    return json(502, { error: error instanceof DataUnavailableError ? "data_unavailable" : "data_unavailable" });
  }

  // 2. verify。
  const facilitator = runtime.facilitatorFor(fetchImpl);
  let verified: { isValid: boolean };
  try {
    verified = await within(deadline.budgetFor(VERIFY_TIMEOUT_MS), facilitator.verify(payload, requirements));
  } catch (error) {
    const kind = error instanceof FacilitatorUnavailableError ? error.kind : "facilitator_unavailable";
    if (kind === "facilitator_registration_required") console.error("provider: facilitator registration required");
    return json(502, { error: kind });
  }
  if (!verified.isValid) {
    return json(402, { error: "payment_invalid" }, { "payment-required": encodePaymentRequiredHeader(await runtime.builder.paymentRequired(canonical, "payment_invalid")) });
  }

  // 3. settle（1 回だけ。残りが足りなければ呼ばない: 送出前なので資金は動かない）。
  if (!deadline.canSettle()) return json(503, { error: "provider_busy" });
  let settled: unknown;
  try {
    settled = await within(deadline.budgetFor(SETTLE_TIMEOUT_MS), facilitator.settle(payload, requirements));
  } catch (error) {
    if (error instanceof SettleCalledTwiceError) return json(500, { error: "internal" });
    const kind = error instanceof FacilitatorUnavailableError ? error.kind : "facilitator_unavailable";
    if (kind === "facilitator_registration_required") console.error("provider: facilitator registration required");
    return json(502, { error: kind });
  }
  const receipt = checkReceipt(runtime.config.network, runtime.config.table.network, payload, settled);
  if (!receipt.ok) return json(502, { error: receipt.reason });

  // 4. 200 + PAYMENT-RESPONSE + 本文（1 で取った値）。
  return json(200, snapshot, { "payment-response": receipt.header });
}

/** Workers の入口。config の失敗は isolate の全要求で 500 固定文。 */
let cached: Runtime | undefined;
let cachedError: string | undefined;
export default {
  async fetch(request: Request, env: ProviderEnv): Promise<Response> {
    if (cached === undefined && cachedError === undefined) {
      try {
        cached = runtimeOf(env);
      } catch {
        cachedError = "misconfigured";
      }
    }
    if (cached === undefined) return json(500, { error: cachedError ?? "misconfigured" });
    return handle(request, cached);
  },
};
