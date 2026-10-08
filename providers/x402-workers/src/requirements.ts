/**
 * §2.1 の requirements と 402 の封筒（`docs/provider-x402-workers.md`）。SDK の `x402ResourceServer` を requirements の作成と
 * `createPaymentRequiredResponse` にだけ使う（`processHTTPRequest`・`settlePayment` は使わない: §3.1）。
 * isolate ごとに 1 度 `initialize()`（facilitator の `/supported`）。失敗したら次の要求でやり直す。
 */
import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";

import { DESCRIPTION, MAX_TIMEOUT_SECONDS, type ProviderConfig } from "./config.js";

export interface RequirementsBuilder {
  /** 未初期化なら `/supported` を読む（上限は呼び出し側の期限）。 */
  ready(): Promise<void>;
  requirements(): Promise<PaymentRequirements[]>;
  paymentRequired(url: string, error?: string): Promise<PaymentRequired>;
  /** 支払いの `accepted` が自分の requirements と一致する 1 件（無ければ `undefined`）。 */
  match(payload: PaymentPayload): Promise<PaymentRequirements | undefined>;
}

/** 決定的な直列化（鍵を昇順に）。`accepted` の完全一致に使う。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createRequirementsBuilder(config: ProviderConfig, facilitator: FacilitatorClient): RequirementsBuilder {
  const server = new x402ResourceServer(facilitator);
  const network = config.table.network as never;
  if (config.network === "arc") registerExactEvmScheme(server, { networks: [network] });
  else registerExactSvmScheme(server, { networks: [network] }); // rpcUrl 無し: `recentBlockhash` を足させない
  let initialized = false;

  async function ready(): Promise<void> {
    if (initialized) return;
    await server.initialize();
    initialized = true;
  }

  async function requirements(): Promise<PaymentRequirements[]> {
    await ready();
    return server.buildPaymentRequirementsFromOptions(
      [
        {
          scheme: "exact",
          network,
          payTo: config.payTo,
          price: { amount: config.table.amount, asset: config.table.asset, extra: { ...config.table.extra } },
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        },
      ],
      undefined,
    );
  }

  return {
    ready,
    requirements,
    async paymentRequired(url: string, error?: string): Promise<PaymentRequired> {
      const accepts = await requirements();
      return server.createPaymentRequiredResponse(accepts, { url, description: DESCRIPTION, mimeType: "application/json" }, error ?? "Payment required");
    },
    async match(payload: PaymentPayload): Promise<PaymentRequirements | undefined> {
      const accepts = await requirements();
      const accepted = stableJson((payload as { accepted?: unknown }).accepted);
      return accepts.find((entry) => stableJson(entry) === accepted);
    },
  };
}
