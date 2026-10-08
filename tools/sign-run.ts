/**
 * `npm run sign` の本体（鍵の読取・payer の生成を注入できる形。タスク T5 の試験のため）。**製品コードではない。**
 * 順序: 振り分けと拒否（鍵に触れない）→ 鍵を読む → payer を作る → （MPP は開示を書いてから）署名／送金 → 封筒を stdout に。
 */
import { classifyOffer, SIGN_MAX_AMOUNT, type SignDispatch } from "./sign-dispatch.js";

export interface SignDeps {
  readonly nowMs: () => number;
  readonly readEvmKey: () => string;
  readonly readSolanaKey: () => string;
  readonly solanaRpcUrl?: string;
  readonly mppPayer: (key: string, scope: { chainId: number; asset: string; payTo: string; maxAmount: bigint }) => { readonly address: string; payAndCredential(offer: never): Promise<{ credential: string; txRef: string }> };
  readonly evmPayer: (key: string) => { readonly address: string; credentialFor(offer: never, chainId: number): Promise<string> };
  readonly svmPayer: (key: string, options: { rpcUrl?: string }) => Promise<{ readonly address: string; credentialFor(offer: never, scope: { mint: string; decimals: number; tokenProgram: string }): Promise<string> }>;
  /** MPP の SVM（`solana/charge`）: 同じ Solana の鍵で全署名した mppx の wire を返す（封筒はここで組む）。 */
  readonly svmMppPayer: (key: string, options: { rpcUrl?: string }) => Promise<{ readonly address: string; credentialFor(offer: never, scope: { mint: string; decimals: number; tokenProgram: string }): Promise<string> }>;
  readonly stderr: (text: string) => void;
}

export type SignOutcome = { readonly ok: true; readonly stdout: string; readonly dispatch: Exclude<SignDispatch, { kind: "refuse" }> } | { readonly ok: false; readonly reason: string };

/** quote（JSON）から credential（base64 の封筒）を作る。拒む offer では鍵を読まず、payer も作らない。 */
export async function runSign(quote: unknown, deps: SignDeps): Promise<SignOutcome> {
  const source = typeof quote === "object" && quote !== null ? (quote as Record<string, unknown>)["source"] : undefined;
  const offer = typeof source === "object" && source !== null ? (source as Record<string, unknown>)["offer"] : undefined;
  if (offer === undefined) {
    return { ok: false, reason: "The quote has no source.offer. Pass the `quote` field from the subetha_router_quote response." };
  }
  const dispatch = classifyOffer(offer, deps.nowMs());
  if (dispatch.kind === "refuse") {
    return { ok: false, reason: dispatch.reason };
  }
  const offerRecord = offer as Record<string, unknown>;
  if (dispatch.kind === "mpp") {
    // ---- MPP 受信。**ここで実際に送金する。** 鍵は振り分けの後で読む。
    const payer = deps.mppPayer(deps.readEvmKey(), { chainId: dispatch.chainId, asset: dispatch.asset, payTo: dispatch.payTo, maxAmount: SIGN_MAX_AMOUNT });
    deps.stderr(
      `MPP: about to send ${dispatch.amount} to ${dispatch.payTo} on eip155:${dispatch.chainId}.\n` +
        "     **This transfer cannot be undone.** Only run this after a human has approved.\n",
    );
    const { credential, txRef } = await payer.payAndCredential(offerRecord as never);
    // 両レールで出力の形を揃える（x402 側は payer が封筒まで組む。MPP は mppx の wire 文字列なのでここで同じ封筒に入れる）。
    const extra = offerRecord["extra"] as Record<string, unknown> | undefined;
    const envelope = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offerRecord, payload: { challengeNonce: extra?.["challengeNonce"], credential } }), "utf8").toString("base64");
    deps.stderr(`paid by ${payer.address} / tx ${txRef} (your key is never sent)\n`);
    return { ok: true, stdout: `${envelope}\n`, dispatch };
  }
  if (dispatch.kind === "mpp-svm") {
    // ---- MPP の Solana 受信（設計 §7）。**署名だけ**: 送出は Router の purchase（settle）。fee payer は自分の鍵（devnet SOL が要る）。
    const payer = await deps.svmMppPayer(deps.readSolanaKey(), deps.solanaRpcUrl === undefined ? {} : { rpcUrl: deps.solanaRpcUrl });
    const credential = await payer.credentialFor(offerRecord as never, { mint: dispatch.mint, decimals: dispatch.decimals, tokenProgram: dispatch.tokenProgram });
    const extra = offerRecord["extra"] as Record<string, unknown> | undefined;
    const envelope = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offerRecord, payload: { challengeNonce: extra?.["challengeNonce"], credential } }), "utf8").toString("base64");
    deps.stderr(
      "MPP Solana: signed only, nothing was sent. Funds move when the Router broadcasts at purchase. " +
        "Call purchase right away (the blockhash expires in about a minute). You need devnet SOL for the fee.\n",
    );
    deps.stderr(`signed by ${payer.address} on Solana (your key is never sent; the Router broadcasts)\n`);
    return { ok: true, stdout: `${envelope}\n`, dispatch };
  }
  if (dispatch.kind === "x402-evm") {
    const payer = deps.evmPayer(deps.readEvmKey());
    const credential = await payer.credentialFor(offerRecord as never, dispatch.chainId);
    deps.stderr(`signed by ${payer.address} for eip155:${dispatch.chainId} (your key is never sent)\n`);
    return { ok: true, stdout: `${credential}\n`, dispatch };
  }
  const payer = await deps.svmPayer(deps.readSolanaKey(), deps.solanaRpcUrl === undefined ? {} : { rpcUrl: deps.solanaRpcUrl });
  const credential = await payer.credentialFor(offerRecord as never, { mint: dispatch.mint, decimals: dispatch.decimals, tokenProgram: dispatch.tokenProgram });
  deps.stderr(`signed by ${payer.address} on Solana (your key is never sent; the facilitator broadcasts)\n`);
  return { ok: true, stdout: `${credential}\n`, dispatch };
}
