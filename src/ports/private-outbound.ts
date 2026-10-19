/**
 * 秘匿購入の送信 adapter 面（`docs/zktls-router-design.md` §6、要件 FR-Z05・FR-Z16〜Z18）。
 *
 * 既存の `OutboundRail`（`readChallenge` + `pay`）との違い: **上流へ有料要求を送らない**。Router が行うのは、本文に依存しない未払いの探り（`discover`）、
 * 送らずに 1 件だけ credential を作る `issueCredential`、Verifier の record に現れた領収ヘッダの照合（`checkReceipt`）だけ。要求そのものは Payer の executor が
 * MPC-TLS で送る。
 */

import type { DestinationOffer, FeeEstimate, UpstreamTarget } from "./outbound.js";

/** 探りの結果。`challenge` は adapter 内の不透明な handle（再照合で得たものを発行に渡す。発行は HTTP の発見をしない）。 */
export interface PrivateDiscovery {
  readonly offers: readonly DestinationOffer[];
  readonly challenge: unknown;
}

export interface IssuedCredential {
  readonly name: "PAYMENT-SIGNATURE" | "Authorization";
  /** bearer。journal・射影・診断に書かない（設計 §7.3、canary の行列）。 */
  readonly value: string;
  /** 署名済み credential の実際の期限（x402 `validBefore`、Tempo `validBefore`）。ミリ秒。 */
  readonly expiresAtMs: number;
  /** Tempo pull: 署名済み envelope の keccak（Provider の領収 `reference` と照合する期待 tx）。x402 には無い。 */
  readonly expectedRef?: string;
}

export type IssueOutcome =
  | { readonly ok: true; readonly issued: IssuedCredential }
  /** `signed`: 署名口が呼ばれた後の失敗か（送っていないので資金は動かないが、core は予約後なので `unknown` に写す）。 */
  | { readonly ok: false; readonly reason: string; readonly signed: boolean };

export type ReceiptCheck = { readonly ok: true; readonly txRef?: string; readonly receiptRef: string } | { readonly ok: false; readonly reason: string };

export interface IssueCredentialArgs {
  readonly profileId: string;
  /** quote で選び、再照合で一致を確かめた offer。 */
  readonly offer: DestinationOffer;
  readonly target: UpstreamTarget;
  /** 再照合（`discover`）で得た handle。 */
  readonly challenge: unknown;
  /** 承認の絶対期限（ミリ秒）。署名の直前に見る。 */
  readonly deadlineMs: number;
  /** Tempo だけ: quote が決めた署名時の手数料の上限（cap）。無ければ発行しない。 */
  readonly maxFee?: string;
}

export interface PrivateOutboundRail {
  readonly rail: "x402" | "mpp";
  /** 本文に依存しない未払い探り（GET、または `{}` の POST）。検査を通った offer だけを上流の順で返す。 */
  discover(profileId: string, target: UpstreamTarget): Promise<PrivateDiscovery>;
  /** Tempo だけ。既存 `estimateFee` と同じ契約（読取 RPC だけ）。 */
  estimateFee?(profileId: string, offer: DestinationOffer, target: UpstreamTarget): Promise<FeeEstimate>;
  /** 送らずに 1 件だけ作る。HTTP の発見はしない。 */
  issueCredential(args: IssueCredentialArgs): Promise<IssueOutcome>;
  /** Verifier の record に現れた領収ヘッダの値を、この発行に照合する。 */
  checkReceipt(headerValue: string, offer: DestinationOffer, issued: IssuedCredential): ReceiptCheck;
}
