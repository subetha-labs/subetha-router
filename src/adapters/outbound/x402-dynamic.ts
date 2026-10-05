/**
 * x402 送信の**動的経路**（設計 `docs/dynamic-upstream-design.md` §3.2〜§3.4、タスク T8）。
 *
 * 静的経路（`x402.ts` の `createX402Outbound`）との違い:
 *
 * - 接続先は起動時の設定ではなく、呼び出しごとに渡された URL（`parseUpstreamUrl` を通ったもの）。
 * - 上流は信頼しない第三者。offer は**許可した欄だけ**を持つものに限り、上流の順で検査を通ったものだけを返す。
 * - **署名器に渡す typed data は Router が組み直す。** SDK が渡したものから引き継ぐのは `validAfter`・`validBefore`・
 *   `nonce` の 3 つだけで、それも範囲を確かめる。domain はプロファイルの `tokenDomain`、型定義は固定。
 * - 402 の本文は**読まない**（`PAYMENT-REQUIRED` ヘッダが権威）。有料応答は receipt を先に判定し、本文は上限つきで読む。
 */

import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { Network, PaymentRequired } from "@x402/fetch";
import { getAddress } from "viem";

import type { DynamicProfile } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import { DYNAMIC_RESPONSE_LIMITS, readBoundedBody } from "../../net/bounded-body.js";
import { discardBody, type GuardedTransport } from "../../net/guarded-fetch.js";
import { parseUpstreamUrl } from "../../net/upstream-url.js";
import type { DestinationOffer, EvmSigningCapability, PayRequest, PayResult } from "../../ports/outbound.js";

export interface X402DynamicOptions {
  /** `profileId` → プロファイル。送信レールが x402 のものだけを使う。 */
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  /** 動的経路の transport。**loopback を許すものは受け取らない**（設計 §3.1）。 */
  readonly transport: GuardedTransport;
  /** 動的 URL の宛先にできないホスト名（core と同じ検査をここでもう一度掛ける）。 */
  readonly denyHosts?: readonly string[];
  /** 未払いの読取の期限。既定 5 秒。 */
  readonly unpaidTimeoutMs?: number;
  /** 支払いヘッダを付けた要求の期限。既定 30 秒（暫定の方針。設計 §3.3）。 */
  readonly paidTimeoutMs?: number;
  readonly now?: () => number;
}

/** 署名してから `validBefore` までの長さの上限（秒）。`maxTimeoutSeconds` の上限 600 ＋余裕。 */
const MAX_VALIDITY_SECONDS = 660;
const MAX_TIMEOUT_SECONDS = 600;

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** offer のトップレベルに必ず要る欄。 */
const REQUIRED_KEYS = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"] as const;
/** 説明だけの欄（署名の内容に影響しない。文字列に限る）。 */
const DESCRIPTIVE_KEYS = ["description", "mimeType", "resource"] as const;
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([...REQUIRED_KEYS, ...DESCRIPTIVE_KEYS, "maxAmountRequired"]);
const EXTRA_KEYS: ReadonlySet<string> = new Set(["name", "version", "bazaar", "decimals"]);

/** EIP-3009 の型定義。**上流と SDK のどちらが何を渡しても、署名に使うのはこれ。** */
const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;
const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;
const SDK_TYPES_JSON = stableJson({ TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION });
const DOMAIN_KEYS = ["chainId", "name", "verifyingContract", "version"] as const;
const MESSAGE_KEYS = ["from", "nonce", "to", "validAfter", "validBefore", "value"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function evmChainIdOf(network: string): number {
  const match = /^eip155:([1-9][0-9]{0,15})$/.exec(network);
  if (match === null) {
    throw new Error("dynamic x402 profile network is not eip155:<chainId>");
  }
  return Number(match[1]);
}

/** offer を候補にしない理由。運用者向けの分類で、上流の文字列は入らない。 */
export type OfferRejection =
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "scheme"
  | "network"
  | "asset"
  | "amount"
  | "amount_over_limit"
  | "pay_to"
  | "max_timeout"
  | "extra"
  | "token_domain"
  | "decimals"
  | "max_amount_required"
  | "descriptive_field";

/**
 * offer の検査（設計 §3.3 (i)、キーは T0-c の 3）。**純粋関数**。通れば `undefined`。
 * `operatorAddresses` は「運用者自身」（署名者・受信の受取先）。そこへ払う offer は候補にしない。
 */
export function checkDynamicX402Offer(
  raw: unknown,
  profile: DynamicProfile,
  operatorAddresses: readonly string[],
): OfferRejection | undefined {
  if (!isRecord(raw)) return "not_an_object";
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) return "unknown_field";
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(raw, key)) return "missing_field";
  }
  const destination = profile.destination;
  if (raw["scheme"] !== "exact" || destination.scheme !== "exact") return "scheme";
  if (raw["network"] !== destination.network) return "network";
  const asset = raw["asset"];
  // アドレスは大文字小文字を区別しない同一性で比べる（保存した offer との一致は別で、そちらは綴りまで見る）。
  if (typeof asset !== "string" || !ADDRESS_PATTERN.test(asset) || !sameAddress(asset, destination.asset)) return "asset";
  const amount = raw["amount"];
  if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount) || amount === "0") return "amount";
  if (BigInt(amount) > BigInt(profile.maxUpstreamAmount)) return "amount_over_limit";
  const payTo = raw["payTo"];
  if (
    typeof payTo !== "string" ||
    !ADDRESS_PATTERN.test(payTo) ||
    sameAddress(payTo, ZERO_ADDRESS) ||
    sameAddress(payTo, destination.asset) ||
    operatorAddresses.some((own) => sameAddress(payTo, own))
  ) {
    return "pay_to";
  }
  const maxTimeoutSeconds = raw["maxTimeoutSeconds"];
  if (
    typeof maxTimeoutSeconds !== "number" ||
    !Number.isInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < 1 ||
    maxTimeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    return "max_timeout";
  }
  const extra = raw["extra"];
  if (!isRecord(extra)) return "extra";
  for (const key of Object.keys(extra)) {
    // `assetTransferMethod`・`paymentFlow`・`feePayer` などは、SDK が支払いの仕方そのものを変える欄。
    if (!EXTRA_KEYS.has(key)) return "extra";
  }
  const tokenDomain = destination.tokenDomain;
  if (tokenDomain === undefined || extra["name"] !== tokenDomain.name || extra["version"] !== tokenDomain.version) {
    return "token_domain";
  }
  if (Object.hasOwn(extra, "decimals") && extra["decimals"] !== destination.decimals) return "decimals";
  // v1 の欄。v2 では意味を持たないので、`amount` と同じ値のときだけ許す。
  if (Object.hasOwn(raw, "maxAmountRequired") && raw["maxAmountRequired"] !== amount) return "max_amount_required";
  for (const key of DESCRIPTIVE_KEYS) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== "string") return "descriptive_field";
  }
  return undefined;
}

/** 署名の境界で止めた（元の署名器は呼んでいない）。 */
export class SigningRefusedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SigningRefusedError";
  }
}

export interface RebuildingSigner {
  /** SDK に渡す署名者。持つのは `address` と `signTypedData` だけ。 */
  readonly signer: ClientEvmSigner;
  /** 次の 1 回だけ署名を許す。 */
  arm(): void;
  /** 元の署名器を呼んだ回数。 */
  signatures(): number;
}

/**
 * 署名の境界（設計 §3.3 (ii)、AC-16）。SDK が渡した typed data が**承認済みの値とプロファイルから組んだものと
 * 1 欄ずつ一致する**ことを確かめ、そのうえで**Router が組み直したもの**を元の署名器に渡す。
 * SDK が渡した `domain`・`types`・`primaryType` のオブジェクトは署名器に届かない。
 */
export function createRebuildingSigner(args: {
  readonly signer: ClientEvmSigner;
  readonly profile: DynamicProfile;
  readonly offer: DestinationOffer;
  readonly now: () => number;
}): RebuildingSigner {
  const { profile, offer } = args;
  const tokenDomain = profile.destination.tokenDomain;
  if (tokenDomain === undefined) {
    throw new Error("dynamic x402 profile has no tokenDomain");
  }
  const chainId = evmChainIdOf(profile.destination.network);
  const verifyingContract = getAddress(profile.destination.asset);
  const from = getAddress(args.signer.address);
  const to = getAddress(offer.payTo);
  const value = BigInt(offer.amount);
  let armed = false;
  let signatures = 0;

  const signer = {
    address: args.signer.address,
    async signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      if (!armed) {
        throw new SigningRefusedError("destination_signer_not_armed");
      }
      armed = false;
      if (!isRecord(message) || message.primaryType !== "TransferWithAuthorization") {
        throw new SigningRefusedError("destination_unsupported_asset_transfer_method");
      }
      // 型定義: SDK の定義と同じであること。`EIP712Domain` を足されたら、それだけで拒否する。
      if (!isRecord(message.types) || stableJson(message.types) !== SDK_TYPES_JSON) {
        throw new SigningRefusedError("destination_signing_args_mismatch");
      }
      const domain = message.domain;
      if (
        !isRecord(domain) ||
        !hasExactlyKeys(domain, DOMAIN_KEYS) ||
        domain["name"] !== tokenDomain.name ||
        domain["version"] !== tokenDomain.version ||
        domain["chainId"] !== chainId ||
        domain["verifyingContract"] !== verifyingContract
      ) {
        throw new SigningRefusedError("destination_signing_args_mismatch");
      }
      const inner = message.message;
      if (
        !isRecord(inner) ||
        !hasExactlyKeys(inner, MESSAGE_KEYS) ||
        inner["from"] !== from ||
        inner["to"] !== to ||
        inner["value"] !== value
      ) {
        throw new SigningRefusedError("destination_signing_args_mismatch");
      }
      // 引き継ぐのはこの 3 つだけ。範囲を確かめる。
      const validAfter = inner["validAfter"];
      const validBefore = inner["validBefore"];
      const nonce = inner["nonce"];
      const nowSeconds = BigInt(Math.floor(args.now() / 1000));
      if (
        typeof validAfter !== "bigint" ||
        typeof validBefore !== "bigint" ||
        validAfter < 0n ||
        validAfter > nowSeconds ||
        validBefore <= nowSeconds ||
        validBefore > nowSeconds + BigInt(MAX_VALIDITY_SECONDS) ||
        typeof nonce !== "string" ||
        !BYTES32_PATTERN.test(nonce)
      ) {
        throw new SigningRefusedError("destination_signing_validity_out_of_range");
      }
      signatures += 1;
      return args.signer.signTypedData({
        domain: { name: tokenDomain.name, version: tokenDomain.version, chainId, verifyingContract },
        types: {
          EIP712Domain: EIP712_DOMAIN.map((field) => ({ ...field })),
          TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION.map((field) => ({ ...field })),
        },
        primaryType: "TransferWithAuthorization",
        message: { from, to, value, validAfter, validBefore, nonce: nonce as `0x${string}` },
      });
    },
  };
  return {
    signer,
    arm: () => {
      armed = true;
    },
    signatures: () => signatures,
  };
}

/** 未払いの読取が成立しなかった理由（上流の文字列は入らない）。 */
export class DynamicChallengeError extends Error {
  constructor(
    readonly reason:
      | "url"
      | "status"
      | "no_header"
      | "undecodable"
      | "version"
      | "no_offers"
      | "too_many_offers"
      | "resource_mismatch",
  ) {
    super(`dynamic x402 challenge rejected: ${reason}`);
    this.name = "DynamicChallengeError";
  }
}

interface DynamicChallenge {
  readonly accepts: readonly unknown[];
  /** SDK に渡す `resource`（`url` と、文字列の説明だけ）。 */
  readonly resource: { url: string; description?: string; mimeType?: string };
}

type Receipt =
  | { readonly kind: "none" }
  | { readonly kind: "payer_mismatch" }
  | { readonly kind: "settled"; readonly header: string; readonly transaction: string };

export interface X402DynamicPath {
  readChallenge(profileId: string, url: string): Promise<readonly DestinationOffer[]>;
  pay(request: PayRequest & { readonly target: { readonly url: string } }): Promise<PayResult>;
}

export function createX402DynamicPath(capability: EvmSigningCapability, options: X402DynamicOptions): X402DynamicPath {
  const transport = options.transport;
  if (transport.allowLoopback) {
    throw new Error("the dynamic x402 path must not use a transport that allows loopback");
  }
  const unpaidTimeoutMs = options.unpaidTimeoutMs ?? 5_000;
  const paidTimeoutMs = options.paidTimeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const denyHosts = options.denyHosts ?? [];

  const profiles = new Map<string, DynamicProfile>();
  for (const [profileId, profile] of Object.entries(options.profiles)) {
    if (profile.rail !== "x402") continue;
    if (profile.destination.scheme !== "exact" || profile.destination.tokenDomain === undefined) {
      throw new Error(`dynamic profile ${profileId} is not an x402 exact profile with a tokenDomain`);
    }
    evmChainIdOf(profile.destination.network);
    profiles.set(profileId, profile);
  }

  function profileFor(profileId: string): DynamicProfile {
    const profile = profiles.get(profileId);
    if (profile === undefined) {
      throw new Error("no dynamic x402 profile for route");
    }
    return profile;
  }

  /** 運用者自身のアドレス（署名者と、受信の受取先）。 */
  function operatorAddressesOf(profile: DynamicProfile): string[] {
    return [capability.signer.address, profile.source.payTo];
  }

  /** 未払いの GET（支払いヘッダを付けない）。本文は読まずに捨てる。 */
  async function getChallenge(url: string, ctx: { routeId: string; operation: string }): Promise<DynamicChallenge> {
    const parsed = parseUpstreamUrl(url, { denyHosts });
    if (!parsed.ok) {
      throw new DynamicChallengeError("url");
    }
    const response = await transport.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(unpaidTimeoutMs),
    }, ctx);
    const header = response.headers.get("PAYMENT-REQUIRED");
    // ヘッダが権威。本文の `accepts` は見ないので、本文は 1 バイトも読まない。
    discardBody(response);
    if (response.status !== 402) {
      throw new DynamicChallengeError("status");
    }
    if (header === null || header === "") {
      throw new DynamicChallengeError("no_header");
    }
    let raw: unknown;
    try {
      raw = decodePaymentRequiredHeader(header);
    } catch {
      throw new DynamicChallengeError("undecodable");
    }
    if (!isRecord(raw)) {
      throw new DynamicChallengeError("undecodable");
    }
    if (raw["x402Version"] !== 2) {
      throw new DynamicChallengeError("version");
    }
    const accepts = raw["accepts"];
    if (!Array.isArray(accepts) || accepts.length === 0) {
      throw new DynamicChallengeError("no_offers");
    }
    if (accepts.length > DYNAMIC_RESPONSE_LIMITS.maxOffers) {
      throw new DynamicChallengeError("too_many_offers");
    }
    const resource = raw["resource"];
    // 上流が「この URL の支払い条件だ」と言っていること。別の資源の条件を払わない。
    if (!isRecord(resource) || resource["url"] !== url) {
      throw new DynamicChallengeError("resource_mismatch");
    }
    const description = resource["description"];
    const mimeType = resource["mimeType"];
    return {
      accepts,
      resource: {
        url,
        ...(typeof description === "string" ? { description } : {}),
        ...(typeof mimeType === "string" ? { mimeType } : {}),
      },
    };
  }

  /** receipt ヘッダを本文より先に判定する（SDK の `processResponse` は本文を先に読むので使わない）。 */
  function receiptOf(response: Response, approved: DestinationOffer): Receipt {
    const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
    if (header === null || header === "") return { kind: "none" };
    let decoded: unknown;
    try {
      decoded = decodePaymentResponseHeader(header);
    } catch {
      return { kind: "none" };
    }
    if (!isRecord(decoded) || decoded["success"] !== true || decoded["network"] !== approved.network) {
      return { kind: "none" };
    }
    const transaction = decoded["transaction"];
    // 送信先は EVM なので、取引の参照は 32 バイトのハッシュに限る（上流の任意の文字列を記録に入れない）。
    if (typeof transaction !== "string" || !BYTES32_PATTERN.test(transaction)) {
      return { kind: "none" };
    }
    // receipt が購入者を名乗るなら、それはこの Router の署名者でなければならない。
    const payer = decoded["payer"];
    if (payer !== undefined && (typeof payer !== "string" || !ADDRESS_PATTERN.test(payer) || !sameAddress(payer, capability.signer.address))) {
      return { kind: "payer_mismatch" };
    }
    return { kind: "settled", header, transaction };
  }

  /** receipt が整合した 200 の本文。対応するのは `application/json` の JSON object だけ（設計 §3.4）。 */
  async function deliveredBodyOf(response: Response, receipt: { header: string; transaction: string }, ctx: { routeId: string; operation: string }): Promise<PayResult> {
    const noData = (reason: string): PayResult => ({ outcome: "paid_no_data", reason, receiptRef: receipt.header });
    const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mediaType !== "application/json") {
      discardBody(response);
      return noData("unsupported_response");
    }
    let read;
    try {
      read = await readBoundedBody(response, DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes);
    } catch (error) {
      // 支払いは receipt で確かめてある。取れなかったのはデータだけ。
      transport.report(error, ctx);
      return noData("paid_data_unavailable");
    }
    if (!read.ok) {
      return noData("response_too_large");
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
    } catch {
      return noData("unsupported_response");
    }
    if (!isRecord(body)) {
      return noData("unsupported_response");
    }
    return { outcome: "paid", body, contentType: "application/json", txRef: receipt.transaction, receiptRef: receipt.header };
  }

  return {
    /** 検査を通った offer だけを、**上流の順のまま**返す（先頭が §2.3 の「最初の 1 件」）。 */
    async readChallenge(profileId: string, url: string): Promise<readonly DestinationOffer[]> {
      const profile = profileFor(profileId);
      const challenge = await getChallenge(url, { routeId: profileId, operation: "challenge" });
      const operatorAddresses = operatorAddressesOf(profile);
      const offers: DestinationOffer[] = [];
      for (const entry of challenge.accepts) {
        if (checkDynamicX402Offer(entry, profile, operatorAddresses) === undefined) {
          offers.push(entry as DestinationOffer);
        }
      }
      return offers;
    },

    async pay(request): Promise<PayResult> {
      const profile = profileFor(request.routeId);
      const url = request.target.url;
      const approved = request.offer;
      const approvedJson = stableJson(approved);

      if (capability.network !== profile.destination.network) {
        return { outcome: "not_sent", reason: "destination_signer_network_mismatch" };
      }
      // 保存してあった offer も、今のプロファイルの検査をもう一度通す。
      if (checkDynamicX402Offer(approved, profile, operatorAddressesOf(profile)) !== undefined) {
        return { outcome: "not_sent", reason: "destination_offer_not_allowed" };
      }

      let challenge: DynamicChallenge;
      try {
        // 送金直前に読み直す。
        challenge = await getChallenge(url, { routeId: request.routeId, operation: "pay_challenge" });
      } catch {
        return { outcome: "not_sent", reason: "destination_challenge_unreadable" };
      }
      // 一致の定義（設計 §3.2）: 保存した offer の全体が、今の accepts のどれかと一致すること。
      const current = challenge.accepts.find((entry) => stableJson(entry) === approvedJson);
      if (current === undefined) {
        return { outcome: "not_sent", reason: "destination_offer_changed" };
      }
      // SDK には写しを渡す（SDK が書き換えても、照合に使う値は変わらない）。
      const selected = JSON.parse(JSON.stringify(current)) as PaymentRequired["accepts"][number];

      const guard = createRebuildingSigner({ signer: capability.signer, profile, offer: approved, now });
      const client = new x402Client((_version, requirements) => {
        if (requirements.length !== 1 || stableJson(requirements[0]) !== approvedJson) {
          throw new SigningRefusedError("destination_selected_offer_mismatch");
        }
        return requirements[0]!;
      });
      client.setSpendControls({
        maxAmountPerPayment: false,
        allowedAssets: [{ network: approved.network as Network, asset: approved.asset, maxAmountPerPayment: approved.amount }],
      });
      client.register(capability.network as Network, new ExactEvmScheme(guard.signer));
      client.onBeforePaymentCreation(async (context) => {
        if (stableJson(context.selectedRequirements) !== approvedJson || context.paymentRequired.x402Version !== 2) {
          return { abort: true, reason: "destination_selected_offer_mismatch" };
        }
        guard.arm();
        return undefined;
      });
      const httpClient = new x402HTTPClient(client);

      let payload;
      try {
        // 上流のトップレベルの欄（`extensions`・`error` など）は SDK に渡さない。渡すのは確かめた 3 つだけ。
        payload = await httpClient.createPaymentPayload({ x402Version: 2, resource: challenge.resource, accepts: [selected] } as PaymentRequired);
      } catch {
        // payload 生成の失敗は送信前。署名の境界で止めた場合もここに来る。
        return { outcome: "not_sent", reason: "destination_not_signed" };
      }
      if (guard.signatures() !== 1 || stableJson((payload as { accepted?: unknown }).accepted) !== approvedJson || payload.x402Version !== 2) {
        return { outcome: "not_sent", reason: "destination_payload_mismatch" };
      }

      const payCtx = { routeId: request.routeId, operation: "pay" };
      let response: Response;
      try {
        // 1 要求 1 回だけ。402 を受けても再署名・再送信をしない。
        response = await transport.fetch(url, {
          method: "GET",
          headers: httpClient.encodePaymentSignatureHeader(payload),
          redirect: "error",
          signal: AbortSignal.timeout(paidTimeoutMs),
        }, payCtx);
      } catch {
        // 送ったかどうか分からない（期限・ヘッダの上限超過・リダイレクトを含む）。自動再送しない。
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      const receipt = receiptOf(response, approved);
      if (receipt.kind === "settled") {
        if (response.status === 200) {
          return deliveredBodyOf(response, receipt, payCtx);
        }
        // 整合した receipt があるのに 200 でない。支払いは成立していて、データは無い。
        discardBody(response);
        return { outcome: "paid_no_data", reason: "paid_data_unavailable", receiptRef: receipt.header };
      }
      // receipt が無い・不整合。本文は読まない。
      discardBody(response);
      if (receipt.kind === "payer_mismatch") {
        return { outcome: "unknown", reason: "destination_receipt_payer_mismatch" };
      }
      if (response.status >= 200 && response.status < 300) {
        return { outcome: "unknown", reason: "destination_receipt_unverified" };
      }
      if (response.status >= 500) {
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }
      // 402 を含む 4xx: 上流が支払いを受け付けなかった。再署名はしない。
      return { outcome: "rejected", reason: "destination_rejected" };
    },
  };
}
