/**
 * `npm run sign` の本体（鍵の読取・payer の生成を注入できる形。タスク T5 の試験のため）。**製品コードではない。**
 * 順序: 振り分けと拒否（鍵に触れない）→ 鍵を読む → payer を作る → （MPP は開示を書いてから）署名／送金 → 封筒を stdout に。
 *
 * 診断（`docs/rejection-reasons-design.md` §6・§12.7）: `onStage` があれば各段の入口で呼ぶ。観測だけで、順序・stdout・stderr・結果は変えない。
 */
import type { DiagSignerStage } from "../src/shared/diagnostics.js";

import { classifyOffer, SIGN_MAX_AMOUNT, type SignDispatch } from "./sign-dispatch.js";

/** 署名の段（設計 §6 の閉じた集合。記録の `signerStage` と同じ集合であることは試験が固定する）。 */
export type SignStage = DiagSignerStage;
export interface SignStageEvent {
  readonly stage: SignStage;
}

export interface SignDeps {
  readonly nowMs: () => number;
  readonly readEvmKey: () => string;
  readonly readSolanaKey: () => string;
  readonly solanaRpcUrl?: string;
  /** loopback の Solana RPC を許す（手元の node・試験の fixture）。既定は拒む（`tools/svm-rpc.ts`）。 */
  readonly solanaRpcAllowLoopback?: boolean;
  readonly mppPayer: (key: string, scope: { chainId: number; asset: string; payTo: string; maxAmount: bigint }) => { readonly address: string; payAndCredential(offer: never): Promise<{ credential: string; txRef: string }> };
  readonly evmPayer: (key: string) => { readonly address: string; credentialFor(offer: never, chainId: number): Promise<string> };
  readonly svmPayer: (key: string, options: { rpcUrl?: string; allowLoopback?: boolean }) => Promise<{ readonly address: string; credentialFor(offer: never, scope: { mint: string; decimals: number; tokenProgram: string }): Promise<string> }>;
  /** MPP の SVM（`solana/charge`）: 同じ Solana の鍵で全署名した mppx の wire を返す（封筒はここで組む）。 */
  readonly svmMppPayer: (key: string, options: { rpcUrl?: string; allowLoopback?: boolean }) => Promise<{ readonly address: string; credentialFor(offer: never, scope: { mint: string; decimals: number; tokenProgram: string }): Promise<string> }>;
  readonly stderr: (text: string) => void;
  /**
   * 各段の入口で呼ぶ（診断の記録。設計 §6・§12.7）。**観測だけ**: 例外は握り、順序・stdout・stderr・結果を変えない。
   * 署名・送金の判断（payer の呼び出し・保留）はこの callback を一切読まない（D-11）。
   */
  readonly onStage?: (event: SignStageEvent) => void;
}

/** `onStage` を呼ぶ関数（例外は握る。観測の失敗は署名の経路に出さない）。 */
function stageOf(deps: SignDeps): (stage: SignStage) => void {
  const observe = deps.onStage;
  if (observe === undefined) return () => {};
  return (stage) => {
    try {
      observe({ stage });
    } catch {
      // 観測の失敗は無視する（SR-R3・SR-R4）。
    }
  };
}

function svmRpcOptionsOf(deps: SignDeps): { rpcUrl?: string; allowLoopback?: boolean } {
  return { ...(deps.solanaRpcUrl === undefined ? {} : { rpcUrl: deps.solanaRpcUrl }), ...(deps.solanaRpcAllowLoopback === undefined ? {} : { allowLoopback: deps.solanaRpcAllowLoopback }) };
}

export type SignOutcome = { readonly ok: true; readonly stdout: string; readonly dispatch: Exclude<SignDispatch, { kind: "refuse" }> } | { readonly ok: false; readonly reason: string };

/** quote（JSON）から credential（base64 の封筒）を作る。拒む offer では鍵を読まず、payer も作らない。 */
export async function runSign(quote: unknown, deps: SignDeps): Promise<SignOutcome> {
  const stage = stageOf(deps);
  stage("dispatch");
  const source = typeof quote === "object" && quote !== null ? (quote as Record<string, unknown>)["source"] : undefined;
  const offer = typeof source === "object" && source !== null ? (source as Record<string, unknown>)["offer"] : undefined;
  if (offer === undefined) {
    stage("refused");
    return { ok: false, reason: "The quote has no source.offer. Pass the `quote` field from the subetha_router_quote response." };
  }
  const dispatch = classifyOffer(offer, deps.nowMs());
  if (dispatch.kind === "refuse") {
    stage("refused");
    return { ok: false, reason: dispatch.reason };
  }
  const offerRecord = offer as Record<string, unknown>;
  if (dispatch.kind === "mpp") {
    // ---- MPP 受信。**ここで実際に送金する。** 鍵は振り分けの後で読む。
    stage("key_read");
    const key = deps.readEvmKey();
    stage("payer_create");
    const payer = deps.mppPayer(key, { chainId: dispatch.chainId, asset: dispatch.asset, payTo: dispatch.payTo, maxAmount: SIGN_MAX_AMOUNT });
    deps.stderr(
      `MPP: about to send ${dispatch.amount} to ${dispatch.payTo} on eip155:${dispatch.chainId}.\n` +
        "     **This transfer cannot be undone.** Only run this after a human has approved.\n",
    );
    stage("disclosure_written");
    stage("pay_and_credential");
    const { credential, txRef } = await payer.payAndCredential(offerRecord as never);
    stage("envelope");
    // 両レールで出力の形を揃える（x402 側は payer が封筒まで組む。MPP は mppx の wire 文字列なのでここで同じ封筒に入れる）。
    const extra = offerRecord["extra"] as Record<string, unknown> | undefined;
    const envelope = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offerRecord, payload: { challengeNonce: extra?.["challengeNonce"], credential } }), "utf8").toString("base64");
    deps.stderr(`paid by ${payer.address} / tx ${txRef} (your key is never sent)\n`);
    stage("done");
    return { ok: true, stdout: `${envelope}\n`, dispatch };
  }
  if (dispatch.kind === "mpp-svm") {
    // ---- MPP の Solana 受信（設計 §7）。**署名だけ**: 送出は Router の purchase（settle）。fee payer は自分の鍵（devnet SOL が要る）。
    stage("key_read");
    const key = deps.readSolanaKey();
    stage("payer_create");
    const payer = await deps.svmMppPayer(key, svmRpcOptionsOf(deps));
    stage("credential_for");
    const credential = await payer.credentialFor(offerRecord as never, { mint: dispatch.mint, decimals: dispatch.decimals, tokenProgram: dispatch.tokenProgram });
    stage("envelope");
    const extra = offerRecord["extra"] as Record<string, unknown> | undefined;
    const envelope = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offerRecord, payload: { challengeNonce: extra?.["challengeNonce"], credential } }), "utf8").toString("base64");
    deps.stderr(
      "MPP Solana: signed only, nothing was sent. Funds move when the Router broadcasts at purchase. " +
        "Call purchase right away (the blockhash expires in about a minute). You need devnet SOL for the fee.\n",
    );
    deps.stderr(`signed by ${payer.address} on Solana (your key is never sent; the Router broadcasts)\n`);
    stage("done");
    return { ok: true, stdout: `${envelope}\n`, dispatch };
  }
  if (dispatch.kind === "x402-evm") {
    stage("key_read");
    const key = deps.readEvmKey();
    stage("payer_create");
    const payer = deps.evmPayer(key);
    stage("credential_for");
    const credential = await payer.credentialFor(offerRecord as never, dispatch.chainId);
    deps.stderr(`signed by ${payer.address} for eip155:${dispatch.chainId} (your key is never sent)\n`);
    stage("done");
    return { ok: true, stdout: `${credential}\n`, dispatch };
  }
  stage("key_read");
  const key = deps.readSolanaKey();
  stage("payer_create");
  const payer = await deps.svmPayer(key, svmRpcOptionsOf(deps));
  stage("credential_for");
  const credential = await payer.credentialFor(offerRecord as never, { mint: dispatch.mint, decimals: dispatch.decimals, tokenProgram: dispatch.tokenProgram });
  deps.stderr(`signed by ${payer.address} on Solana (your key is never sent; the facilitator broadcasts)\n`);
  stage("done");
  return { ok: true, stdout: `${credential}\n`, dispatch };
}
