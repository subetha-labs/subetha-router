/**
 * Provider（x402 v2 `exact` の資源サーバ。Cloudflare Workers）の fetch handler（`docs/provider-x402-workers.md` §2.2・§3.1）。
 * 順序: 402（未払い）／ decode と `accepted` の一致 → データ（直列化と大きさの検査まで）→ verify → settle（1 回）→ 領収の検査 → 200。
 * 要求ごとに 1 つの期限を作り、各段には **signal** を配る（署名・送出・本文の読取を止める）。
 * 応答の本文とヘッダは固定文だけ（facilitator の文言・鍵・URL を含めない）。鍵は env から署名の closure を作るときに 1 度読むだけ。
 */
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";

import { configOf, isEvmKey, MAX_PAYMENT_HEADER_CHARS, RESOURCE_PATH, type ProviderConfig, type ProviderEnv } from "./config.js";
import { DATA_TIMEOUT_MS, DeadlineError, INIT_TIMEOUT_MS, RequestDeadline, SETTLE_TIMEOUT_MS, VERIFY_TIMEOUT_MS, type Stage } from "./deadline.js";
import { BoundedFacilitatorClient, FacilitatorUnavailableError, SettleCalledTwiceError, type FacilitatorClientOptions } from "./facilitator-client.js";
import { checkReceipt } from "./receipt.js";
import { createRequirementsBuilder, type RequirementsBuilder } from "./requirements.js";
import type { SellerProofSigner } from "./seller-proof.js";
import { DataUnavailableError, fetchSnapshot, serializeSnapshot } from "./snapshot.js";

// この module の export は handler と関数だけ（workerd は entry の export に値があると起動しない: AC-P2 で判明）。定数は config.ts。
const ENCODER = new TextEncoder();

/** 固定文の応答。`content-length` を明示し、本文は 1 つの文字列。 */
function respond(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "content-length": String(ENCODER.encode(text).byteLength), ...headers },
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return respond(status, JSON.stringify(body), headers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** isolate ごとの状態（秘密を含まない config・署名の closure・requirements の builder）。鍵は closure の中だけ。 */
export interface Runtime {
  readonly config: ProviderConfig;
  readonly builder: RequirementsBuilder;
  readonly facilitatorFor: (fetchImpl: typeof fetch, stageFor: FacilitatorClientOptions["stageFor"]) => BoundedFacilitatorClient;
}

export interface Hooks {
  /** 試験の差し替え（facilitator・データ源への fetch）。 */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** 入口で作った期限（Workers の入口は runtime を組む前に作る）。無ければ `handle` が作る。 */
  readonly deadline?: RequestDeadline;
}

export function runtimeOf(env: ProviderEnv, hooks: Hooks = {}): Runtime {
  const config = configOf(env);
  let signer: SellerProofSigner | undefined;
  if (config.network === "arc") {
    // 鍵は env から 1 度だけ読み、account（署名の closure）にだけ渡す。config にも Runtime にも入れない。
    const key = env.SELLER_PROOF_KEY;
    if (!isEvmKey(key)) throw new Error("SELLER_PROOF_KEY is required for arc and must be a 0x-prefixed 32-byte hex key");
    const account = privateKeyToAccount(key);
    if (account.address.toLowerCase() !== config.payTo.toLowerCase()) throw new Error("PAY_TO does not match the address of SELLER_PROOF_KEY");
    signer = {
      network: config.table.network,
      chainId: config.table.chainId ?? 0,
      address: account.address,
      signTypedData: (typedData) => account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message }),
      ...(hooks.now === undefined ? {} : { now: hooks.now }),
    };
  }
  const defaultFetch = hooks.fetch ?? fetch;
  const facilitatorFor: Runtime["facilitatorFor"] = (f, stageFor) => new BoundedFacilitatorClient({ url: config.facilitatorUrl, ...(signer === undefined ? {} : { signer }), fetch: f, stageFor });
  const builder = createRequirementsBuilder(config, (stageFor) => facilitatorFor(defaultFetch, stageFor));
  return { config, builder, facilitatorFor };
}

async function paymentRequired(runtime: Runtime, canonical: string, error?: string): Promise<Response> {
  const required = await runtime.builder.paymentRequired(canonical, error);
  return json(402, error === undefined ? {} : { error: "payment_invalid" }, { "payment-required": encodePaymentRequiredHeader(required) });
}

function facilitatorError(error: unknown): Response {
  if (error instanceof SettleCalledTwiceError) return json(502, { error: "internal" });
  const kind = error instanceof FacilitatorUnavailableError ? error.kind : "facilitator_unavailable";
  if (kind === "facilitator_registration_required") console.error("provider: facilitator registration required");
  return json(502, { error: kind });
}

export async function handle(request: Request, runtime: Runtime, hooks: Hooks = {}): Promise<Response> {
  const deadline = hooks.deadline ?? new RequestDeadline(hooks.now ?? Date.now);
  // 期限の timer はどの出口でも外す（404/405 も含む）。
  try {
    const url = new URL(request.url);
    if (url.pathname !== RESOURCE_PATH) return json(404, { error: "not_found" });
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    if (url.search !== "") return json(404, { error: "not_found" });
    return await handleWithin(request, url, runtime, hooks, deadline);
  } finally {
    deadline.release();
  }
}

function stageFor(deadline: RequestDeadline): (stage: "verify" | "settle" | "supported") => Stage {
  return (stage) => deadline.stage(stage === "verify" ? VERIFY_TIMEOUT_MS : stage === "settle" ? SETTLE_TIMEOUT_MS : INIT_TIMEOUT_MS);
}

async function handleWithin(request: Request, url: URL, runtime: Runtime, hooks: Hooks, deadline: RequestDeadline): Promise<Response> {
  const canonical = `${url.origin}${RESOURCE_PATH}`;
  const fetchImpl = hooks.fetch ?? fetch;

  // isolate の最初の要求: facilitator の `/supported`（上限 5 秒、要求の期限の内側。並行は 1 本）。
  const stages = stageFor(deadline);
  const initStage = stages("supported");
  try {
    await runtime.builder.ready(initStage.signal, () => stages("supported"));
  } catch (error) {
    // 運用者向けの固定文（分類だけ。facilitator の文言・URL は出さない）。
    console.error(`provider: facilitator not ready (${error instanceof FacilitatorUnavailableError ? error.kind : error instanceof Error ? error.name : "unknown"})`);
    return json(503, { error: "facilitator_unavailable" });
  } finally {
    initStage.dispose();
  }

  const header = request.headers.get("payment-signature");
  if (header === null || header === "") return paymentRequired(runtime, canonical);
  if (header.length > MAX_PAYMENT_HEADER_CHARS) return paymentRequired(runtime, canonical, "payment_invalid");

  // 0. decode、形の検査、`accepted` の完全一致（どれも固定の 402。facilitator もデータ源も呼ばない）。
  let decoded: unknown;
  try {
    decoded = decodePaymentSignatureHeader(header);
  } catch {
    return paymentRequired(runtime, canonical, "payment_invalid");
  }
  if (!isRecord(decoded) || decoded["x402Version"] !== 2 || !isRecord(decoded["accepted"]) || !isRecord(decoded["payload"])) {
    return paymentRequired(runtime, canonical, "payment_invalid");
  }
  const payload = decoded as unknown as PaymentPayload;
  // `accepted` の一致（深すぎる入れ子は一致しない。ここで例外が出ても固定の 402）。
  let requirements: Awaited<ReturnType<RequirementsBuilder["match"]>>;
  try {
    requirements = await runtime.builder.match(payload);
  } catch {
    requirements = undefined;
  }
  if (requirements === undefined) return paymentRequired(runtime, canonical, "no_matching_requirements");

  // 1. データ（支払いの前。取れない・形が違う・直列化して 64 KiB を超える → facilitator を呼ばない）。
  let bodyText: string;
  const dataStage = deadline.stage(DATA_TIMEOUT_MS);
  try {
    const snapshot = await fetchSnapshot(runtime.config.dataUrl, runtime.config.table.network, dataStage.signal, fetchImpl, hooks.now);
    bodyText = serializeSnapshot(snapshot).text;
  } catch (error) {
    if (!(error instanceof DataUnavailableError) && !(error instanceof DeadlineError)) console.error("provider: data stage failed");
    return json(502, { error: "data_unavailable" });
  } finally {
    dataStage.dispose();
  }

  // 2. verify（段の内側で署名・送出・読取。送出の直前に時計でも経過を見る: client）。
  const facilitator = runtime.facilitatorFor(fetchImpl, stages);
  let verified: { isValid: boolean };
  try {
    verified = await facilitator.verify(payload, requirements);
  } catch (error) {
    return facilitatorError(error);
  }
  if (!verified.isValid) return paymentRequired(runtime, canonical, "payment_invalid");

  // 3. settle（1 回だけ。残りが足りなければ呼ばない: 送出前なので資金は動かない）。
  if (!deadline.canSettle()) return json(503, { error: "provider_busy" });
  let settled: unknown;
  try {
    settled = await facilitator.settle(payload, requirements);
  } catch (error) {
    return facilitatorError(error);
  }
  const receipt = checkReceipt(runtime.config.network, runtime.config.table.network, payload, settled);
  if (!receipt.ok) return json(502, { error: receipt.reason });

  // 4. 200 + PAYMENT-RESPONSE + 本文（1 で直列化した文字列そのもの）。settle の後は I/O も署名も無い（領収の検査と封筒の組み立てだけ）。
  // ここで期限が過ぎていても 200 を返す: 資金は動いており、502 にすれば確かめられた成功を `unknown` に変えるだけ（設計 §2.2 の段 4 の例外）。
  return respond(200, bodyText, { "payment-response": receipt.header });
}

/** Workers の入口。config の失敗は isolate の全要求で 500 固定文。 */
let cached: Runtime | undefined;
let cachedError: string | undefined;
export default {
  async fetch(request: Request, env: ProviderEnv): Promise<Response> {
    // 期限は入口で（isolate の最初の要求では runtime の構築も期限の内側）。
    const deadline = new RequestDeadline();
    if (cached === undefined && cachedError === undefined) {
      try {
        cached = runtimeOf(env);
      } catch {
        cachedError = "misconfigured";
      }
    }
    if (cached === undefined) {
      deadline.release();
      return json(500, { error: cachedError ?? "misconfigured" });
    }
    return handle(request, cached, { deadline });
  },
};
