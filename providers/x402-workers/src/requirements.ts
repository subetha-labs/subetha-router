/**
 * §2.1 の requirements と 402 の封筒（`docs/provider-x402-workers.md`）。SDK の `x402ResourceServer` を requirements の作成と
 * `createPaymentRequiredResponse` にだけ使う（`processHTTPRequest`・`settlePayment` は使わない: §3.1）。
 * isolate ごとに 1 度 `initialize()`（**single-flight**: 並行する要求は同じ promise を待つ。失敗したら次の要求でやり直す）。
 * 準備ができたと言うのは、facilitator の `/supported` に**この network の `exact` v2 の kind**（SVM は 32 バイトの `feePayer` 付き）があるときだけ。
 */
import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";

import type { ProviderConfig } from "./config.js";
import { DeadlineError, withSignal, type Stage } from "./deadline.js";
import { supportedKindOf } from "./facilitator-client.js";

export interface RequirementsBuilder {
  /** 未初期化なら `/supported` を読む（**呼び出し側の段** の内側。並行は 1 本に束ね、後続は自分の signal で待つ）。 */
  ready(signal: AbortSignal, stageFor: () => Stage): Promise<void>;
  requirements(): Promise<PaymentRequirements[]>;
  /** `url` は要求された資源の canonical URL、`description` はその資源の説明（§11: 資源ごとに違う）。 */
  paymentRequired(url: string, description: string, error?: string): Promise<PaymentRequired>;
  /** 支払いの `accepted` が自分の requirements と一致する 1 件（無い・深すぎる → `undefined`。throw しない）。 */
  match(payload: PaymentPayload): Promise<PaymentRequirements | undefined>;
}

/** `accepted` の入れ子の上限（requirements は `extra` の 1 段まで。深いものは一致しないと決める）。 */
export const MAX_ACCEPTED_DEPTH = 4;

export class TooDeepError extends Error {
  constructor() {
    super("too deep");
    this.name = "TooDeepError";
  }
}

/** 決定的な直列化（鍵を昇順に）。`accepted` の完全一致に使う。深さは上限まで（超えれば `TooDeepError`: 再帰で落ちない）。 */
export function stableJson(value: unknown, depth: number = 0): string {
  if (depth > MAX_ACCEPTED_DEPTH) throw new TooDeepError();
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, depth + 1)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `/supported` を読む client は、初期化を始めた要求の段を使う（`stageFor("supported")`）。 */
export function createRequirementsBuilder(config: ProviderConfig, clientFor: (stageFor: () => Stage) => FacilitatorClient): RequirementsBuilder {
  let initStage: (() => Stage) | undefined;
  const facilitator = clientFor(() => (initStage === undefined ? { signal: AbortSignal.abort(new DeadlineError()), expired: () => true, dispose: () => {} } : initStage()));
  // SDK の server には「読んで確かめた `/supported`」だけを渡す（`/supported` は isolate で 1 回。verify/settle は SDK から呼ばせない）。
  let supportedChecked: SupportedResponse | undefined;
  const sdkFacilitator: FacilitatorClient = {
    verify: () => Promise.reject(new Error("verify is not called through the SDK")),
    settle: () => Promise.reject(new Error("settle is not called through the SDK")),
    getSupported: () => (supportedChecked === undefined ? Promise.reject(new Error("not initialized")) : Promise.resolve(supportedChecked)),
  };
  const server = new x402ResourceServer(sdkFacilitator);
  const network = config.table.network as never;
  if (config.table.family === "evm") registerExactEvmScheme(server, { networks: [network] });
  else registerExactSvmScheme(server, { networks: [network] }); // rpcUrl 無し: `recentBlockhash` を足させない
  let initialized = false;
  let inflight: Promise<void> | undefined;

  async function initialize(): Promise<void> {
    // `/supported` を自分でも読んで kind を確かめてから SDK を初期化する（SDK は kind の有無を検査しない）。
    const supported = await facilitator.getSupported();
    if (supportedKindOf(supported, config.table.network) === undefined) throw new Error("facilitator does not support this network");
    supportedChecked = supported;
    await server.initialize();
    if (server.getSupportedKind(2, network, "exact") === undefined) throw new Error("facilitator does not support this network");
    initialized = true;
  }

  function ready(signal: AbortSignal, stageFor: () => Stage): Promise<void> {
    if (initialized) return Promise.resolve();
    if (inflight === undefined) {
      initStage = stageFor;
      inflight = initialize().finally(() => {
        inflight = undefined;
        initStage = undefined;
      });
      inflight.catch(() => {}); // 待つ要求が全部先に諦めても unhandled にしない（失敗は次の要求がやり直す）
    }
    return withSignal(signal, inflight);
  }

  /** 初期化済みのときだけ（`ready` の後に呼ぶ）。 */
  async function requirements(): Promise<PaymentRequirements[]> {
    if (!initialized) throw new Error("not initialized");
    const built = await server.buildPaymentRequirementsFromOptions(
      [
        {
          scheme: "exact",
          network,
          payTo: config.payTo,
          price: { amount: config.table.amount, asset: config.table.asset, extra: { ...config.table.extra } },
          maxTimeoutSeconds: config.table.maxTimeoutSeconds,
        },
      ],
      undefined,
    );
    if (built.length !== 1) throw new Error("exactly one requirement expected");
    return built;
  }

  return {
    ready,
    requirements,
    async paymentRequired(url: string, description: string, error?: string): Promise<PaymentRequired> {
      const accepts = await requirements();
      return server.createPaymentRequiredResponse(accepts, { url, description, mimeType: "application/json" }, error ?? "Payment required");
    },
    async match(payload: PaymentPayload): Promise<PaymentRequirements | undefined> {
      const accepts = await requirements();
      let accepted: string;
      try {
        accepted = stableJson((payload as { accepted?: unknown }).accepted);
      } catch (error) {
        if (error instanceof TooDeepError) return undefined;
        throw error;
      }
      return accepts.find((entry) => stableJson(entry) === accepted);
    },
  };
}
