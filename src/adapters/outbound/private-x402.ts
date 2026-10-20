/**
 * 秘匿購入の x402（EVM）送信 adapter（`docs/zktls-router-design.md` §6.1、要件 FR-Z05）。
 *
 * - `discover`: 動的経路と同じ未払いの読取（`createX402ChallengeReader`。POST は探り本文 `{}`）と offer の検査（`checkDynamicX402Offer`）。
 * - `issueCredential`: 動的 `pay` の署名部分そのもの（`signX402PaymentOnly`: 組み直しの署名器・SDK の client・署名 1 回・`accepted` 一致）。**transport への参照を持たず、`fetch` は 0 回。**
 * - `checkReceipt`: Verifier の record に現れた `PAYMENT-RESPONSE` を、動的経路と同じ規則（`success`・bytes32・network・payer = 署名者）で読む。
 */

import type { DynamicProfile } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import type { GuardedTransport } from "../../net/guarded-fetch.js";
import type { DestinationOffer, EvmSigningCapability, UpstreamTarget } from "../../ports/outbound.js";
import type { IssueCredentialArgs, IssueOutcome, PrivateDiscovery, PrivateOutboundRail, ReceiptCheck } from "../../ports/private-outbound.js";
import { EVM_RECEIPT_FORM } from "../../shared/x402-receipt.js";
import { decodePaymentResponseHeader } from "@x402/core/http";

import { checkDynamicX402Offer, createX402ChallengeReader, receiptOf, signX402PaymentOnly, X402_DYNAMIC_UNPAID_TIMEOUT_MS, type DynamicChallenge } from "./x402-dynamic.js";

export interface PrivateX402Options {
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  /** 探りの transport（動的と同じ: loopback 不可・DNS の期限）。発行はこれに触れない。 */
  readonly transport: GuardedTransport;
  readonly denyHosts?: readonly string[];
  readonly unpaidTimeoutMs?: number;
  readonly now?: () => number;
  readonly operatorAddresses?: readonly string[];
}

const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

function evmChainIdOf(network: string): void {
  if (!/^eip155:[1-9][0-9]{0,15}$/.test(network)) {
    throw new Error("private x402 profile network is not eip155:<chainId>");
  }
}

export function createPrivateX402Rail(capability: EvmSigningCapability, options: PrivateX402Options): PrivateOutboundRail {
  const transport = options.transport;
  if (transport.allowLoopback) {
    throw new Error("the private x402 rail must not use a transport that allows loopback");
  }
  if (!transport.boundsDns) {
    throw new Error("the private x402 rail requires a transport with a DNS deadline");
  }
  if (capability.kind !== "real-key") {
    throw new Error("the private x402 rail does not accept a non-signing fixture capability");
  }
  const now = options.now ?? Date.now;
  const profiles = new Map<string, DynamicProfile>();
  for (const [profileId, profile] of Object.entries(options.profiles)) {
    if (profile.rail !== "x402") continue;
    if (profile.destination.scheme !== "exact" || profile.destination.tokenDomain === undefined) {
      throw new Error(`private profile ${profileId} is not an x402 exact profile with a tokenDomain`);
    }
    evmChainIdOf(profile.destination.network);
    if (capability.network !== profile.destination.network) {
      throw new Error(`private profile ${profileId}: the EVM signing capability is for another network`);
    }
    profiles.set(profileId, profile);
  }
  function profileFor(profileId: string): DynamicProfile {
    const profile = profiles.get(profileId);
    if (profile === undefined) throw new Error("no private x402 profile for route");
    return profile;
  }
  function operatorAddressesOf(profile: DynamicProfile): string[] {
    return [capability.signer.address, profile.source.payTo, ...(options.operatorAddresses ?? [])];
  }
  const reader = createX402ChallengeReader({ transport, denyHosts: options.denyHosts ?? [], unpaidTimeoutMs: options.unpaidTimeoutMs ?? X402_DYNAMIC_UNPAID_TIMEOUT_MS });
  const receiptForm = EVM_RECEIPT_FORM(capability.signer.address);

  return {
    rail: "x402",
    async discover(profileId: string, target: UpstreamTarget): Promise<PrivateDiscovery> {
      const profile = profileFor(profileId);
      const challenge = await reader.getChallenge(target, { routeId: profileId, operation: "private_probe" });
      const operators = operatorAddressesOf(profile);
      const offers: DestinationOffer[] = [];
      for (const entry of challenge.accepts) {
        if (checkDynamicX402Offer(entry, profile, operators) === undefined) offers.push(entry as DestinationOffer);
      }
      return { offers, challenge };
    },

    async issueCredential(args: IssueCredentialArgs): Promise<IssueOutcome> {
      const profile = profileFor(args.profileId);
      const challenge = args.challenge as DynamicChallenge | undefined;
      if (challenge === undefined || !Array.isArray(challenge.accepts) || typeof challenge.resource?.url !== "string") {
        return { ok: false, reason: "private_issue_failed", signed: false };
      }
      if (challenge.resource.url !== args.target.url) {
        return { ok: false, reason: "destination_offer_changed", signed: false };
      }
      // 保存してあった offer も、今のプロファイルの検査をもう一度通す。
      if (checkDynamicX402Offer(args.offer, profile, operatorAddressesOf(profile)) !== undefined) {
        return { ok: false, reason: "destination_offer_not_allowed", signed: false };
      }
      const signed = await signX402PaymentOnly({ capability, profile, approved: args.offer, challenge, now, deadlineMs: args.deadlineMs });
      if (!signed.ok) {
        return { ok: false, reason: signed.reason, signed: signed.reason === "destination_payload_mismatch" };
      }
      const entry = Object.entries(signed.headers).find(([name]) => name.toUpperCase() === PAYMENT_SIGNATURE_HEADER);
      if (entry === undefined || typeof entry[1] !== "string" || entry[1] === "") {
        return { ok: false, reason: "private_issue_failed", signed: true };
      }
      return { ok: true, issued: { name: "PAYMENT-SIGNATURE", value: entry[1], expiresAtMs: Number(signed.validBefore) * 1000 } };
    },

    checkReceipt(headerValue: string, offer: DestinationOffer, _issued): ReceiptCheck {
      // 動的経路と同じ判定（`receiptOf`）: ヘッダの値だけを持つ Response に写す。
      const response = new Response(null, { status: 200, headers: { "PAYMENT-RESPONSE": headerValue } });
      const receipt = receiptOf(response, offer, receiptForm);
      if (receipt.kind !== "settled") {
        return { ok: false, reason: receipt.kind === "payer_mismatch" ? "destination_receipt_payer_mismatch" : "destination_receipt_unverified" };
      }
      // 秘匿購入（FR-Z08・設計 §6.1）: 領収は**必ず**この Router の署名者を payer として名乗ること（動的経路は payer の欄が無くても通すが、ここでは要求する）。
      let decoded: unknown;
      try {
        decoded = decodePaymentResponseHeader(headerValue);
      } catch {
        return { ok: false, reason: "destination_receipt_unverified" };
      }
      const payer = typeof decoded === "object" && decoded !== null ? (decoded as Record<string, unknown>)["payer"] : undefined;
      if (typeof payer !== "string" || payer.toLowerCase() !== capability.signer.address.toLowerCase()) {
        return { ok: false, reason: "destination_receipt_payer_mismatch" };
      }
      return { ok: true, txRef: receipt.transaction, receiptRef: receipt.header };
    },
  };
}

/** 試験と診断のため: offer の一致の定義（`stableJson` の完全一致）。 */
export function sameOffer(a: DestinationOffer, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}
