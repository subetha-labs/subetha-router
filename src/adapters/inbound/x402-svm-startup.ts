/**
 * SVM 受信の**起動時の検査**（multirail 設計 §5.1、要件 FR-14・FR-15・FR-18、SR-2。タスク T4-b）。
 *
 * 1. facilitator の `/supported` を **1 回**読み、`x402Version === 2`・この network・scheme `exact` の `extra.feePayer` を 1 つに固定する
 * 2. 受取 owner（`payTo`）の ATA を導く（純粋）
 * 3. fee payer の隔離の不等式: `feePayer ∉ { payTo, ATA, mint, token program, Memo program, ComputeBudget program }`、32 バイトの base58
 * 4. Solana の RPC に `getAccountInfo(ATA, jsonParsed)` を **1 回** POST し、口座が token program のもので owner・mint が表と一致すること
 *
 * すべて guarded transport（loopback 不可・DNS の期限・redirect 無し）を通し、応答は 64 KiB まで。どれかが違えば `ConfigError`（起動しない）。
 * quote・purchase の中では呼ばない（FR-18）。
 */

import { address, getBase58Encoder } from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { findAssociatedTokenPda } from "@solana-program/token";

import { ConfigError } from "../../config.js";
import { readJsonObjectBody } from "../../net/bounded-body.js";
import type { GuardedTransport } from "../../net/guarded-fetch.js";
import { MEMO_PROGRAM_ADDRESS, type SvmInboundPolicy } from "./x402-svm.js";

/** 起動時の読取の応答の上限（設計 §5.1）。 */
export const SVM_STARTUP_RESPONSE_MAX_BYTES = 64 * 1024;
export const SVM_STARTUP_TIMEOUT_MS = 10_000;

export interface SvmStartupInputs {
  readonly network: string;
  readonly facilitatorUrl: string;
  readonly rpcUrl: string;
  /** 受取 owner（設定の `payTo`）。 */
  readonly payTo: string;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  readonly transport: GuardedTransport;
  readonly timeoutMs?: number;
  /** 運用者向けの診断の帰属（route／profile の ID）。 */
  readonly routeId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSvmAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === 32;
  } catch {
    return false;
  }
}

/** 1 回の要求（redirect 無し・期限・上限つき）。JSON object でなければ `undefined`。 */
async function fetchJson(transport: GuardedTransport, url: string, init: { method: "GET" | "POST"; body?: string }, timeoutMs: number, operation: string, routeId: string): Promise<Record<string, unknown> | undefined> {
  const response = await transport.fetch(
    url,
    {
      method: init.method,
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    },
    { routeId, operation },
  );
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const read = await readJsonObjectBody(response, SVM_STARTUP_RESPONSE_MAX_BYTES);
  return read.kind === "object" ? read.body : undefined;
}

/** `/supported` から、この network の `exact`（x402Version 2）の fee payer を 1 つに固定する。 */
export function feePayerOfSupported(supported: Record<string, unknown>, network: string): string {
  const kinds = supported["kinds"];
  if (!Array.isArray(kinds)) {
    throw new ConfigError("svm inbound: /supported has no kinds");
  }
  const feePayers = new Set<string>();
  for (const kind of kinds) {
    if (!isRecord(kind)) continue;
    if (kind["x402Version"] !== 2 || kind["network"] !== network || kind["scheme"] !== "exact") continue;
    const extra = kind["extra"];
    const feePayer = isRecord(extra) ? extra["feePayer"] : undefined;
    if (!isSvmAddress(feePayer)) {
      throw new ConfigError("svm inbound: /supported lists an exact kind without a well-formed feePayer");
    }
    feePayers.add(feePayer);
  }
  if (feePayers.size === 0) {
    throw new ConfigError("svm inbound: /supported has no exact kind (x402Version 2) for the configured network");
  }
  if (feePayers.size > 1) {
    throw new ConfigError("svm inbound: /supported lists more than one feePayer for the configured network");
  }
  return [...feePayers][0]!;
}

/** fee payer の隔離の不等式（設計 §5.1）。 */
export function assertFeePayerIsolated(feePayer: string, policy: { payTo: string; destinationAta: string; mint: string; tokenProgram: string }): void {
  const forbidden = [policy.payTo, policy.destinationAta, policy.mint, policy.tokenProgram, String(MEMO_PROGRAM_ADDRESS), COMPUTE_BUDGET_PROGRAM_ADDRESS];
  if (forbidden.includes(feePayer)) {
    throw new ConfigError("svm inbound: the facilitator feePayer collides with a fixed account (payTo, ATA, mint or a program)");
  }
}

/** `getAccountInfo(jsonParsed)` の応答が、表どおりの ATA であること。 */
export function assertAtaAccount(reply: Record<string, unknown> | undefined, expected: { owner: string; mint: string; tokenProgram: string }): void {
  const result = reply?.["result"];
  if (!isRecord(result) || !("value" in result)) {
    // JSON-RPC の error、形の違う応答、読めなかった応答: 口座の有無は分からない。
    throw new ConfigError("svm inbound: the Solana RPC did not return an account record for the receiving ATA");
  }
  const value = result["value"];
  if (value === null) {
    throw new ConfigError("svm inbound: the receiving ATA does not exist (create it before starting; the operator pays the rent)");
  }
  if (!isRecord(value)) {
    throw new ConfigError("svm inbound: the Solana RPC returned an unexpected account record");
  }
  if (value["owner"] !== expected.tokenProgram) {
    throw new ConfigError("svm inbound: the receiving ATA is not owned by the configured token program");
  }
  const data = value["data"];
  const parsed = isRecord(data) ? data["parsed"] : undefined;
  const info = isRecord(parsed) ? parsed["info"] : undefined;
  if (!isRecord(data) || data["program"] !== "spl-token" || !isRecord(parsed) || parsed["type"] !== "account" || !isRecord(info)) {
    throw new ConfigError("svm inbound: the receiving ATA could not be parsed as a token account");
  }
  if (info["owner"] !== expected.owner) {
    throw new ConfigError("svm inbound: the receiving ATA is not owned by the configured payTo");
  }
  if (info["mint"] !== expected.mint) {
    throw new ConfigError("svm inbound: the receiving ATA is for a different mint");
  }
}

/**
 * 起動時の検査。成功すれば adapter に渡す固定値（policy）を返す。失敗は `ConfigError`。
 * 外への要求は `/supported` 1 回と RPC 1 回だけ。
 */
export async function resolveSvmInboundPolicy(inputs: SvmStartupInputs): Promise<SvmInboundPolicy> {
  const timeoutMs = inputs.timeoutMs ?? SVM_STARTUP_TIMEOUT_MS;
  const routeId = inputs.routeId ?? "-";
  if (!isSvmAddress(inputs.payTo)) {
    throw new ConfigError("svm inbound: payTo must be a 32-byte base58 owner address");
  }
  let destinationAta: string;
  try {
    const [ata] = await findAssociatedTokenPda({ mint: address(inputs.mint), owner: address(inputs.payTo), tokenProgram: address(inputs.tokenProgram) });
    destinationAta = String(ata);
  } catch {
    // 依存の例外（値を含み得る）を外に出さない。
    throw new ConfigError("svm inbound: the receiving ATA could not be derived from payTo, mint and token program");
  }

  let supported: Record<string, unknown> | undefined;
  try {
    supported = await fetchJson(inputs.transport, `${inputs.facilitatorUrl.replace(/\/$/, "")}/supported`, { method: "GET" }, timeoutMs, "facilitator_supported", routeId);
  } catch {
    throw new ConfigError("svm inbound: the facilitator /supported could not be read at startup");
  }
  if (supported === undefined) {
    throw new ConfigError("svm inbound: the facilitator /supported did not return a JSON object");
  }
  const feePayer = feePayerOfSupported(supported, inputs.network);
  const policy: SvmInboundPolicy = Object.freeze({
    feePayer,
    payTo: inputs.payTo,
    destinationAta,
    mint: inputs.mint,
    decimals: inputs.decimals,
    tokenProgram: inputs.tokenProgram,
  });
  assertFeePayerIsolated(feePayer, policy);

  let reply: Record<string, unknown> | undefined;
  try {
    reply = await fetchJson(
      inputs.transport,
      inputs.rpcUrl,
      { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [destinationAta, { encoding: "jsonParsed", commitment: "confirmed" }] }) },
      timeoutMs,
      "solana_rpc_startup",
      routeId,
    );
  } catch {
    throw new ConfigError("svm inbound: the Solana RPC could not be read at startup");
  }
  assertAtaAccount(reply, { owner: inputs.payTo, mint: inputs.mint, tokenProgram: inputs.tokenProgram });
  return policy;
}
