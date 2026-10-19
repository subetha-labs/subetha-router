/**
 * 秘匿購入の MPP（Tempo）**pull** 送信 adapter（`docs/zktls-router-design.md` §6.2、要件 FR-Z05・FR-Z08）。
 *
 * 既存の `mpp-dynamic.ts` は push 専用（Router が放送する）。こちらは pull 専用で、公式 client に**署名だけ**させ（放送は Provider）、
 * できた credential を Router 自身が独立に復号・検査してから Payer に渡す。放送 0 回・署名 1 回。
 *
 * - RPC は**列挙した読取だけ**（`PRIVATE_RPC_READ_METHODS`）。送出・署名・`wallet_*`・未知のメソッドは例外なく拒否する。
 * - 署名口は既存の `createGuardedTempoAccount`（feeToken を承認資産に固定、1 回だけ、Router の単価、expiring nonce、validBefore の範囲）に
 *   **calldata の完全一致**（`expectedData` = challenge に束縛した Attribution memo を持つ `transferWithMemo`）を足したもの。
 * - 発行した envelope は `checkRawTempoTransfer` で独立に再検査し、正準に直列化し直せること・署名口が返した raw そのものであることを確かめる。
 * - 領収は `Payment-Receipt` の `reference` が発行時の envelope の keccak（期待 tx）と一致するときだけ。
 */

import { Challenge, Constants, Credential, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { TxEnvelopeTempo } from "ox/tempo";
import { createClient as createViemClient, custom, encodeFunctionData, keccak256, toBytes, type Client, type Hex } from "viem";
import { Abis } from "viem/tempo";

import type { DynamicProfile } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../net/bounded-body.js";
import { discardBody, type GuardedTransport } from "../../net/guarded-fetch.js";
import { guardedRpcTransport } from "../../net/guarded-rpc.js";
import { parseUpstreamUrl } from "../../net/upstream-url.js";
import type { DestinationOffer, FeeEstimate, MppTempoCapability, UpstreamTarget } from "../../ports/outbound.js";
import type { IssueCredentialArgs, IssueOutcome, PrivateDiscovery, PrivateOutboundRail, ReceiptCheck } from "../../ports/private-outbound.js";
import {
  baseFeeOf,
  chainFor,
  chainIdOf,
  checkDynamicMppChallenge,
  checkRawTempoTransfer,
  createGuardedTempoAccount,
  createMppDynamicPath,
  MPP_DYNAMIC_DEFAULTS,
  payerMatches,
  plainHttpTransportOf,
  TempoSigningRefusedError,
  withDeadline,
} from "./mpp-dynamic.js";

/**
 * pinned の pull 経路（mppx 0.11.0 `tempo/client/Charge.js`: `prepareTransactionRequest → signTransaction`）が呼び得る**読取**の RPC。
 * これ以外は例外なく拒否する（単体テストが偽 RPC で実際の呼び出し集合を固定する）。
 */
export const PRIVATE_RPC_READ_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_fillTransaction",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
  "eth_call",
]);

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TEMPO_SCHEME = "tempo/charge";

export interface PrivateMppOptions {
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  /** 探りと RPC の transport（loopback 不可・DNS の期限）。 */
  readonly transport: GuardedTransport;
  readonly denyHosts?: readonly string[];
  readonly unpaidTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly rpcBudgetMs?: number;
  readonly now?: () => number;
  readonly operatorAddresses?: readonly string[];
}

/**
 * MPP の attribution memo（mppx 0.11.0 `tempo/Attribution.js` と同じ 32 バイト。`mppx/tempo` は 0.11.0 でこれを export しないので同じ規則で組む）:
 * `keccak256("mpp")[0..4] ‖ 0x01 ‖ keccak256(serverId)[0..10] ‖ 0x00×10（clientId 無し = SDK の既定） ‖ keccak256(challengeId)[0..7]`。
 * 単体テストが pinned SDK の実際の calldata と一致することを確かめる。
 */
export function attributionMemoOf(challengeId: string, serverId: string): Hex {
  const out = new Uint8Array(32);
  const tag = toBytes(keccak256(toBytes("mpp"))).slice(0, 4);
  out.set(tag, 0);
  out[4] = 0x01;
  out.set(toBytes(keccak256(toBytes(serverId))).slice(0, 10), 5);
  out.set(toBytes(keccak256(toBytes(challengeId))).slice(0, 7), 25);
  return `0x${Buffer.from(out).toString("hex")}`;
}

/** 承認した送金の calldata（TIP-20 `transferWithMemo(recipient, amount, memo)`）。署名口と raw の再検査が完全一致を要求する。 */
export function expectedTransferDataOf(recipient: string, amount: bigint, memo: Hex): Hex {
  return encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [recipient as Hex, amount, memo] });
}

interface Candidate {
  readonly challenge: Challenge.Challenge;
  readonly offer: DestinationOffer;
}

/**
 * 読取専用の RPC guard（設計 §6.2 1）: `PRIVATE_RPC_READ_METHODS` に列挙したメソッドだけを、`params` の JSON 写しで送る。送出・署名・`wallet_*`・未知のメソッドは
 * 例外なく拒否し、予算（`deadlineMs`）を過ぎたら出さない。`send` は SSRF 防御 A の transport に乗った JSON-RPC。
 */
export function privateReadOnlyRequestOf(send: (method: string, params?: unknown) => Promise<unknown>, policy: { readonly now: () => number; readonly deadlineMs: number }): (raw: unknown) => Promise<unknown> {
  return async (raw: unknown): Promise<unknown> => {
    const method: unknown = isRecord(raw) ? raw["method"] : undefined;
    if (typeof method !== "string" || !PRIVATE_RPC_READ_METHODS.has(method)) {
      throw new TempoSigningRefusedError("private_rpc_method_refused");
    }
    if (policy.now() >= policy.deadlineMs) {
      throw new TempoSigningRefusedError("destination_rpc_budget_exhausted");
    }
    let params: unknown;
    try {
      const given: unknown = (raw as Record<string, unknown>)["params"];
      params = given === undefined ? undefined : (JSON.parse(JSON.stringify(given)) as unknown);
    } catch {
      throw new TempoSigningRefusedError("destination_rpc_request_refused");
    }
    return send(method, params);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPrivateMppRail(capability: MppTempoCapability, options: PrivateMppOptions): PrivateOutboundRail & { readonly estimateFee: NonNullable<PrivateOutboundRail["estimateFee"]> } {
  const transport = options.transport;
  if (transport.allowLoopback) {
    throw new Error("the private mpp rail must not use a transport that allows loopback");
  }
  if (!transport.boundsDns) {
    throw new Error("the private mpp rail requires a transport with a DNS deadline");
  }
  if (capability.account.type !== "local") {
    throw new Error("the private mpp rail requires a local account");
  }
  if (capability.kind !== "real-key") {
    throw new Error("the private mpp rail does not accept a non-signing fixture capability");
  }
  const now = options.now ?? Date.now;
  const denyHosts = options.denyHosts ?? [];
  const unpaidTimeoutMs = options.unpaidTimeoutMs ?? MPP_DYNAMIC_DEFAULTS.unpaidTimeoutMs;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? MPP_DYNAMIC_DEFAULTS.rpcTimeoutMs;
  const rpcBudgetMs = options.rpcBudgetMs ?? MPP_DYNAMIC_DEFAULTS.rpcBudgetMs;

  const profiles = new Map<string, DynamicProfile>();
  for (const [profileId, profile] of Object.entries(options.profiles)) {
    if (profile.rail !== "mpp") continue;
    if (profile.destination.scheme !== TEMPO_SCHEME || profile.destination.feeAsset === undefined || profile.destination.maxFee === undefined) {
      throw new Error(`private profile ${profileId} is not a tempo/charge profile with feeAsset and maxFee`);
    }
    if (capability.chainId !== chainIdOf(profile.destination.network)) {
      throw new Error(`private profile ${profileId}: the MPP capability is for another chain`);
    }
    profiles.set(profileId, profile);
  }
  function profileFor(profileId: string): DynamicProfile {
    const profile = profiles.get(profileId);
    if (profile === undefined) throw new Error("no private mpp profile for route");
    return profile;
  }
  function operatorAddressesOf(profile: DynamicProfile): string[] {
    return [capability.account.address, profile.source.payTo, ...(options.operatorAddresses ?? [])];
  }
  // 見積りは既存の動的経路のもの（読取だけ・同じ guard）。push 専用の `pay` はここからは呼ばない。
  const estimator = createMppDynamicPath({ ...capability, mode: "push" }, { profiles: Object.fromEntries(profiles), transport, denyHosts, now, ...(options.operatorAddresses === undefined ? {} : { operatorAddresses: options.operatorAddresses }) });

  async function readCandidates(profile: DynamicProfile, target: UpstreamTarget, ctx: { routeId: string; operation: string }): Promise<Candidate[]> {
    const parsed = parseUpstreamUrl(target.url, { denyHosts });
    if (!parsed.ok) throw new Error("private mpp probe rejected: url");
    const method = target.method ?? "GET";
    const init: RequestInit =
      method === "POST"
        ? { method: "POST", headers: { "content-type": "application/json" }, body: target.body ?? "{}", redirect: "error", signal: AbortSignal.timeout(unpaidTimeoutMs) }
        : { method: "GET", redirect: "error", signal: AbortSignal.timeout(unpaidTimeoutMs) };
    const response = await transport.fetch(target.url, init, ctx);
    const header = response.headers.get(Constants.Headers.wwwAuthenticate);
    discardBody(response);
    if (response.status !== 402) throw new Error("private mpp probe rejected: status");
    if (header === null || header === "") throw new Error("private mpp probe rejected: no_header");
    let challenges: readonly Challenge.Challenge[];
    try {
      challenges = Challenge.deserializeList(header);
    } catch {
      throw new Error("private mpp probe rejected: undecodable");
    }
    if (challenges.length > DYNAMIC_RESPONSE_LIMITS.maxOffers) throw new Error("private mpp probe rejected: too_many_offers");
    const operators = operatorAddressesOf(profile);
    const candidates: Candidate[] = [];
    for (const challenge of challenges) {
      const check = checkDynamicMppChallenge(challenge, profile, operators, target.url, now(), { mode: "pull", method });
      if (check.ok) candidates.push({ challenge, offer: check.offer });
    }
    return candidates;
  }

  return {
    rail: "mpp",
    async discover(profileId: string, target: UpstreamTarget): Promise<PrivateDiscovery> {
      const profile = profileFor(profileId);
      const candidates = await readCandidates(profile, target, { routeId: profileId, operation: "private_probe" });
      return { offers: candidates.map((candidate) => candidate.offer), challenge: candidates };
    },

    estimateFee(profileId: string, offer: DestinationOffer, _target: UpstreamTarget): Promise<FeeEstimate> {
      return estimator.estimateFee(profileId, offer);
    },

    async issueCredential(args: IssueCredentialArgs): Promise<IssueOutcome> {
      const profile = profileFor(args.profileId);
      const chainId = chainIdOf(profile.destination.network);
      const candidates = Array.isArray(args.challenge) ? (args.challenge as Candidate[]) : [];
      const approvedJson = stableJson(args.offer);
      const selected = candidates.find((candidate) => isRecord(candidate) && stableJson(candidate.offer) === approvedJson);
      if (selected === undefined) {
        return { ok: false, reason: "destination_offer_changed", signed: false };
      }
      // quote が決めた署名時の上限（cap）。無ければ発行しない（天井に落とさない）。
      if (typeof args.maxFee !== "string" || !AMOUNT_PATTERN.test(args.maxFee) || BigInt(args.maxFee) > BigInt(profile.destination.maxFee!)) {
        return { ok: false, reason: "destination_fee_cap_invalid", signed: false };
      }
      const cap = BigInt(args.maxFee);
      const challenge = selected.challenge;
      const challengeId = (challenge as unknown as { id?: unknown }).id;
      const realm = (challenge as unknown as { realm?: unknown }).realm;
      if (typeof challengeId !== "string" || typeof realm !== "string") {
        return { ok: false, reason: "destination_challenge_unreadable", signed: false };
      }
      const expectedData = expectedTransferDataOf(args.offer.payTo, BigInt(args.offer.amount), attributionMemoOf(challengeId, realm));

      // 能力の client。素の http transport でなければ、どこへ出るか保証できないので使わない。
      let request: (method: string, params?: unknown) => Promise<unknown>;
      let chain: Client["chain"];
      const rpcDeadline = now() + rpcBudgetMs;
      try {
        const client = await withDeadline(Promise.resolve(capability.getClient({ chainId })), rpcTimeoutMs);
        const plain = plainHttpTransportOf(client);
        const resolved = chainFor(client, chainId);
        if (plain === undefined || resolved === undefined) {
          return { ok: false, reason: "destination_capability_unsupported", signed: false };
        }
        chain = resolved;
        const guarded = createViemClient({
          chain: resolved,
          transport: guardedRpcTransport(transport, plain.url, () => ({ routeId: args.profileId, operation: "private_rpc" }), {
            fetchOptions: plain.fetchOptions,
            retryCount: 0,
            timeout: Math.min(plain.timeout ?? rpcTimeoutMs, rpcTimeoutMs),
          }),
        });
        const send = guarded.request.bind(guarded) as (a: { method: string; params?: unknown }, o?: Record<string, unknown>) => Promise<unknown>;
        request = (method, params) => withDeadline(send(params === undefined ? { method } : { method, params }, { retryCount: 0 }), rpcTimeoutMs + 1_000);
      } catch {
        return { ok: false, reason: "destination_capability_unsupported", signed: false };
      }
      const readOnlyRequest = privateReadOnlyRequestOf(request, { now, deadlineMs: rpcDeadline });

      // 署名の直前の baseFee（単価は Router が決める）。
      let baseFee: bigint;
      try {
        baseFee = baseFeeOf(await readOnlyRequest({ method: "eth_getBlockByNumber", params: ["latest", false] }));
      } catch {
        return { ok: false, reason: "destination_rejected", signed: false };
      }
      const guard = createGuardedTempoAccount({ account: capability.account, profile, offer: args.offer, maxFee: cap, baseFee, now, deadlineMs: args.deadlineMs, expectedData });
      const sdkClient = createViemClient({
        // fee token を承認資産に固定する（viem は未指定のとき chain の値を入れる。入らなければ署名口が拒否する）。
        chain: { ...chain!, feeToken: profile.destination.feeAsset as Hex } as never,
        account: guard.account as never,
        transport: custom({ request: readOnlyRequest as never }, { retryCount: 0 }),
      });
      const mppx = Mppx.create({
        methods: [
          tempo.charge({
            account: guard.account as never,
            getClient: () => sdkClient as never,
            mode: "pull",
            autoSwap: false,
            expectedChainId: chainId,
            allowedChainIds: [chainId],
            expectedRecipients: [args.offer.payTo as Hex],
          } as never),
        ],
        // SDK には HTTP をさせない。
        fetch: (async () => {
          throw new TempoSigningRefusedError("destination_sdk_fetch_refused");
        }) as unknown as typeof globalThis.fetch,
        polyfill: false,
        maxPaymentRetries: 0,
      });
      let value: string;
      try {
        value = await mppx.createCredential(new Response(null, { status: 402, headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) } }));
      } catch {
        if (guard.deadlineRefused()) return { ok: false, reason: "destination_deadline", signed: false };
        return { ok: false, reason: guard.signatures() === 0 ? "destination_not_signed" : "private_issue_failed", signed: guard.signatures() > 0 };
      }
      // 独立検査（設計 §6.2 5）。
      const raw = guard.signedRaw();
      if (guard.signatures() !== 1 || raw === undefined) {
        return { ok: false, reason: "private_issue_failed", signed: guard.signatures() > 0 };
      }
      if (typeof value !== "string" || !value.startsWith("Payment ")) {
        return { ok: false, reason: "private_issue_failed", signed: true };
      }
      let payload: unknown;
      let credentialChallenge: unknown;
      try {
        const deserialized = Credential.deserialize(value) as { payload?: unknown; challenge?: unknown };
        payload = deserialized.payload;
        credentialChallenge = deserialized.challenge;
      } catch {
        return { ok: false, reason: "private_issue_failed", signed: true };
      }
      if (!isRecord(payload) || payload["type"] !== "transaction" || payload["signature"] !== raw) {
        return { ok: false, reason: "private_issue_failed", signed: true };
      }
      if (!isRecord(credentialChallenge) || credentialChallenge["id"] !== challengeId) {
        return { ok: false, reason: "private_issue_failed", signed: true };
      }
      let validBefore: number;
      try {
        checkRawTempoTransfer(raw, guard.approved, now());
        const envelope = TxEnvelopeTempo.deserialize(raw as never) as unknown as Record<string, unknown>;
        if (TxEnvelopeTempo.serialize(envelope as never) !== raw) {
          return { ok: false, reason: "private_issue_failed", signed: true };
        }
        const vb = envelope["validBefore"];
        if (typeof vb !== "number" || !Number.isInteger(vb)) return { ok: false, reason: "private_issue_failed", signed: true };
        validBefore = vb;
      } catch {
        return { ok: false, reason: "private_issue_failed", signed: true };
      }
      return { ok: true, issued: { name: "Authorization", value, expiresAtMs: validBefore * 1000, expectedRef: keccak256(raw) } };
    },

    checkReceipt(headerValue: string, _offer: DestinationOffer, issued): ReceiptCheck {
      let receipt: Receipt.Receipt;
      try {
        receipt = Receipt.deserialize(headerValue);
      } catch {
        return { ok: false, reason: "destination_receipt_unverified" };
      }
      const reference = (receipt as unknown as Record<string, unknown>)["reference"];
      if (
        receipt.status !== "success" ||
        receipt.method !== "tempo" ||
        typeof reference !== "string" ||
        !BYTES32_PATTERN.test(reference) ||
        issued.expectedRef === undefined ||
        reference.toLowerCase() !== issued.expectedRef.toLowerCase()
      ) {
        return { ok: false, reason: "destination_receipt_unverified" };
      }
      if (!payerMatches((receipt as unknown as Record<string, unknown>)["payer"], capability.chainId, capability.account.address)) {
        return { ok: false, reason: "destination_receipt_payer_mismatch" };
      }
      return { ok: true, txRef: reference, receiptRef: headerValue };
    },
  };
}
