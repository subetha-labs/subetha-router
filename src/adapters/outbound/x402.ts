/**
 * 送信レール（x402 形）の adapter 2 種。
 *
 * - `createSyntheticX402Outbound`: **合成・無課金**の足場（T1）。鍵・ウォレット・署名・
 *   ブロードキャストは一切なく、送るのは `synthetic` と明示したラベル付きトークンで、相手は
 *   リポジトリ内の loopback fixture だけ。**実 SDK 配線ではない**と明示し続ける。
 * - `createX402Outbound`: 公式 `@x402/fetch` + `@x402/evm` を実際に呼ぶ配線（T2 / 設計 §4.2a）。
 *   署名能力は外から注入されたものだけを使う。
 *
 * どちらも共通の不変条件: 上流 canonical は**クエリ無しの GET** 1 本、リダイレクトを追わない、
 * 自動支払いリトライをしない（1 要求 1 回）、承認済み `selectedOffer` だけを渡す。
 */

import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { getAddress } from "viem";

import { assertLoopbackUrl } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import type { GuardedTransport } from "../../net/guarded-fetch.js";
import type {
  DestinationOffer,
  EvmSigningCapability,
  OutboundRail,
  PayRequest,
  PayResult,
} from "../../ports/outbound.js";

export interface SyntheticX402Options {
  /** `routeId` → 上流 canonical URL（loopback の fixture に限る）。 */
  readonly upstreams: Readonly<Record<string, string>>;
  /** 上流へ出る全要求が通る transport（SSRF 防御 A。必須）。 */
  readonly transport: GuardedTransport;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 上流 offer を**丸ごと**保持する（必須フィールドの型だけを検査し、それ以外の
 * トップレベルフィールドを落とさない）。落とすと指紋と再照合の入力から消えてしまい、
 * `maxTimeoutSeconds` のような欄が変わっても検知できなくなる。
 */
function offerOf(value: unknown): DestinationOffer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { scheme, network, asset, amount, payTo } = value;
  if (
    typeof scheme !== "string" ||
    typeof network !== "string" ||
    typeof asset !== "string" ||
    typeof amount !== "string" ||
    typeof payTo !== "string"
  ) {
    return undefined;
  }
  // 検証済みの必須フィールドで上書きしつつ、未知のフィールドもそのまま残す。
  return { ...value, scheme, network, asset, amount, payTo };
}

export function createSyntheticX402Outbound(options: SyntheticX402Options): OutboundRail {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const transport = options.transport;
  // 接続先は起動時に固定する（要求ごとに URL を組み立てない）。
  const upstreams = new Map<string, string>();
  for (const [routeId, raw] of Object.entries(options.upstreams)) {
    const url = new URL(assertLoopbackUrl(raw, `synthetic.upstreams.${routeId}`));
    if (url.search !== "") {
      throw new Error(`synthetic.upstreams.${routeId} must not carry a query`);
    }
    upstreams.set(routeId, url.toString());
  }

  function urlFor(routeId: string): string {
    const url = upstreams.get(routeId);
    if (url === undefined) {
      throw new Error("no upstream configured for route");
    }
    return url;
  }

  return {
    /** 上流の現在の 402 challenge を読む（純粋読取・無課金）。 */
    async readChallenge(routeId: string): Promise<readonly DestinationOffer[]> {
      const ctx = { routeId, operation: "challenge" };
      const response = await transport.fetch(urlFor(routeId), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }, ctx);
      if (response.status !== 402) {
        throw new Error(`upstream challenge returned status ${response.status}`);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch (error) {
        transport.report(error, ctx);
        throw error;
      }
      if (!isRecord(json) || !Array.isArray(json["accepts"])) {
        throw new Error("upstream challenge has no accepts[]");
      }
      const offers: DestinationOffer[] = [];
      for (const entry of json["accepts"]) {
        const offer = offerOf(entry);
        if (offer !== undefined) {
          offers.push(offer);
        }
      }
      return offers;
    },

    async pay(request: PayRequest): Promise<PayResult> {
      // 合成の支払いトークン。**署名ではない**ことがそのまま読み取れる形にする。
      const credential = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          synthetic: true,
          label: "T1-synthetic-nopay",
          scheme: request.offer.scheme,
          network: request.offer.network,
          payload: {
            paymentId: request.paymentId,
            attempt: request.attempt,
            offer: request.offer,
          },
        }),
        "utf8",
      ).toString("base64");

      // 1 要求 1 回だけ。402 を受けても再送しない（自動支払いリトライ無効）。
      const ctx = { routeId: request.routeId, operation: "pay" };
      const response = await transport.fetch(urlFor(request.routeId), {
        method: "GET",
        headers: { "x-payment": credential },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }, ctx);
      const receipt = response.headers.get("x-payment-response");

      if (response.status === 200) {
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          transport.report(error, ctx);
          return { outcome: "unknown", reason: "destination_pay_unknown" };
        }
        return {
          outcome: "paid",
          body,
          contentType: response.headers.get("content-type") ?? "application/json",
          ...(receipt === null ? {} : { txRef: receipt, receiptRef: receipt }),
        };
      }
      // 課金は成立したがデータがない（設計 §10 M6 と同じ終端）。
      if (response.status === 502) {
        return {
          outcome: "paid_no_data",
          reason: "paid_data_unavailable",
          // レシートは上流が実際に返したときだけ記録する。
          ...(receipt === null ? {} : { receiptRef: receipt }),
        };
      }
      if (response.status >= 500) {
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }
      return { outcome: "rejected", reason: "destination_rejected" };
    },
  };
}

/* ------------------------------------------------------------------------- *
 * 実 x402 SDK 配線（T2 / 設計 §4.2）
 *
 * インストール済みの公式 `@x402/fetch`（`x402Client` / `x402HTTPClient`）と `@x402/evm`
 * （`ExactEvmScheme`）を**そのまま**呼ぶ。wire は v2 の `PAYMENT-REQUIRED` /
 * `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` ヘッダで、`wrapFetchWithPayment` の自動支払い
 * リトライは使わない（1 要求につき payload 生成 1 回・送信 1 回）。
 *
 * 署名能力は外から注入されたものだけを使い（`EvmSigningCapability`）、adapter 内に鍵も
 * 偽の署名者も持たない。承認値と外れた要求では**署名も送信もしない**（`not_sent`）。
 * ------------------------------------------------------------------------- */

export interface X402OutboundOptions {
  /** `routeId` → 上流 canonical URL（クエリ無しの GET 1 本）。実 URL は設定値の差し替えだけで届く。 */
  readonly upstreams: Readonly<Record<string, string>>;
  /** 署名能力（無いまま組み立てない。呼び出し側が fail closed を決める）。 */
  readonly capability: EvmSigningCapability;
  /** 上流へ出る全要求が通る transport（SSRF 防御 A。必須）。 */
  readonly transport: GuardedTransport;
  readonly timeoutMs?: number;
}

/** 照合に使う承認済み offer の必須フィールド（field 単位で見る）。 */
const OFFER_FIELDS = ["scheme", "network", "asset", "amount", "payTo"] as const;

function sameOfferFields(offer: DestinationOffer, requirements: PaymentRequirements): boolean {
  const candidate = requirements as unknown as Record<string, unknown>;
  for (const field of OFFER_FIELDS) {
    if (candidate[field] !== offer[field]) {
      return false;
    }
  }
  const expected = (offer as unknown as Record<string, unknown>)["maxTimeoutSeconds"];
  return expected === undefined || candidate["maxTimeoutSeconds"] === expected;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** SDK の `Network`（CAIP-2）として扱えることを実行時に確かめる。 */
function asNetwork(value: string): Network {
  if (!/^[^\s:]+:[^\s:]+$/.test(value)) {
    throw new Error("destination network is not a CAIP-2 network");
  }
  return value as Network;
}

/** CAIP-2 `eip155:<chainId>` の chainId。SDK と同じ前提で読む（推測しない）。 */
function evmChainIdOf(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (match === null) {
    throw new Error("destination network is not eip155:<chainId>");
  }
  return Number(match[1]);
}

class NotSentError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "NotSentError";
  }
}

/** 402 応答の `PAYMENT-REQUIRED` を**生の JSON としても**読む（未知フィールドを落とさない）。 */
function decodeRawPaymentRequired(header: string): { accepts: readonly unknown[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new Error("upstream PAYMENT-REQUIRED header is not base64 JSON");
  }
  if (!isRecord(raw) || !Array.isArray(raw["accepts"])) {
    throw new Error("upstream PAYMENT-REQUIRED has no accepts[]");
  }
  return { accepts: raw["accepts"] };
}

interface Challenge {
  /**
   * SDK が検証・選択に使う形（公式 decoder が zod 検証した結果）。
   * v2 であることは**実行時に**確かめる（SDK 型の `x402Version` は `number`）。
   */
  readonly parsed: PaymentRequired;
  /** 未知のトップレベル / extra フィールドまで保った生の accepts。 */
  readonly rawAccepts: readonly unknown[];
  /** `PAYMENT-REQUIRED` ヘッダそのもの。 */
  readonly header: string;
}

export function createX402Outbound(options: X402OutboundOptions): OutboundRail {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const capability = options.capability;
  const transport = options.transport;

  // 接続先は起動時に固定する（要求ごとに URL を組み立てない）。
  const upstreams = new Map<string, string>();
  for (const [routeId, raw] of Object.entries(options.upstreams)) {
    const at = `x402.upstreams.${routeId}`;
    // 署名しない試験用能力は loopback fixture 以外に向けない。
    const normalized =
      capability.kind === "non-signing-fixture" ? assertLoopbackUrl(raw, at) : raw;
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${at} must use http(s)`);
    }
    if (url.search !== "") {
      throw new Error(`${at} must not carry a query`);
    }
    upstreams.set(routeId, url.toString());
  }

  function urlFor(routeId: string): string {
    const url = upstreams.get(routeId);
    if (url === undefined) {
      throw new Error("no upstream configured for route");
    }
    return url;
  }

  /** 純粋読取の GET（支払いヘッダを付けない）。 */
  async function getChallenge(url: string, ctx: { routeId: string; operation: string }): Promise<Challenge> {
    const response = await transport.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }, ctx);
    if (response.status !== 402) {
      throw new Error(`upstream challenge returned status ${response.status}`);
    }
    const header = response.headers.get("PAYMENT-REQUIRED");
    let body: unknown;
    try {
      body = await response.text();
    } catch (error) {
      transport.report(error, ctx);
      throw error;
    }
    if (header === null || header === "") {
      throw new Error("upstream challenge has no v2 PAYMENT-REQUIRED header");
    }
    // 実 SDK に読ませて検証する（自前の解釈で置き換えない）。
    const httpClient = new x402HTTPClient(new x402Client());
    const parsed = httpClient.getPaymentRequiredResponse(
      (name) => response.headers.get(name),
      body,
    );
    if (parsed.x402Version !== 2) {
      throw new Error("upstream challenge is not x402 v2");
    }
    const { accepts } = decodeRawPaymentRequired(header);
    // SDK が読んだ件数と生の件数が違えば、どの要素を承認したのか一致させられない。
    if (accepts.length !== parsed.accepts.length) {
      throw new Error("upstream challenge accepts[] could not be matched to the SDK view");
    }
    // canonical resource の束縛（クエリ無しの GET 1 本）。
    if (parsed.resource.url !== url) {
      throw new Error("upstream challenge resource does not match the canonical URL");
    }
    return { parsed, rawAccepts: accepts, header };
  }

  function offersOf(challenge: Challenge): readonly DestinationOffer[] {
    const offers: DestinationOffer[] = [];
    challenge.rawAccepts.forEach((entry, index) => {
      const offer = offerOf(entry);
      // SDK が読んだ必須フィールドと生の値が食い違う要素は候補にしない。
      if (offer !== undefined && sameOfferFields(offer, challenge.parsed.accepts[index]!)) {
        offers.push(offer);
      }
    });
    return offers;
  }

  return {
    /** 上流の現在の 402 challenge を読む（純粋読取・無課金）。 */
    async readChallenge(routeId: string): Promise<readonly DestinationOffer[]> {
      return offersOf(await getChallenge(urlFor(routeId), { routeId, operation: "challenge" }));
    },

    async pay(request: PayRequest): Promise<PayResult> {
      const url = urlFor(request.routeId);
      const approved = request.offer;
      const approvedJson = stableJson(approved);

      // 署名能力の network が承認済み offer と違うなら、署名側にも触らない。
      if (capability.network !== approved.network) {
        return { outcome: "not_sent", reason: "destination_signer_network_mismatch" };
      }

      let challenge: Challenge;
      try {
        // 送金直前に読み直す（凍結した accepts をそのまま渡さない）。
        challenge = await getChallenge(url, { routeId: request.routeId, operation: "pay_challenge" });
      } catch {
        // まだ何も送っていない。
        return { outcome: "not_sent", reason: "destination_challenge_unreadable" };
      }

      // 現在の accepts に、承認済み offer と**未知フィールドまで含めて**完全一致する要素があるか。
      const index = challenge.rawAccepts.findIndex((entry) => stableJson(entry) === approvedJson);
      if (index === -1) {
        return { outcome: "not_sent", reason: "destination_offer_changed" };
      }
      const selected = challenge.parsed.accepts[index]!;
      if (!sameOfferFields(approved, selected)) {
        return { outcome: "not_sent", reason: "destination_offer_changed" };
      }

      const chainId = evmChainIdOf(approved.network);
      let armed = false;

      /**
       * guarded signer（設計 §4.2 受け皿 B）。承認と外れた typed data では**注入された
       * 署名能力を呼ばない**。1 要求につき 1 回だけ武装する。
       */
      const guardedSigner = {
        ...capability.signer,
        address: capability.signer.address,
        async signTypedData(message: {
          domain: Record<string, unknown>;
          types: Record<string, unknown>;
          primaryType: string;
          message: Record<string, unknown>;
        }): Promise<`0x${string}`> {
          if (!armed) {
            throw new NotSentError("destination_signer_not_armed");
          }
          armed = false;
          if (message.primaryType !== "TransferWithAuthorization") {
            // T2 で確認済みなのは EIP-3009 の exact 経路だけ。ほかは fail closed。
            throw new NotSentError("destination_unsupported_asset_transfer_method");
          }
          const domain = message.domain;
          const inner = message.message;
          const mismatch =
            domain["chainId"] !== chainId ||
            domain["verifyingContract"] !== getAddress(approved.asset) ||
            inner["to"] !== getAddress(approved.payTo) ||
            inner["from"] !== capability.signer.address ||
            inner["value"] !== BigInt(approved.amount);
          if (mismatch) {
            throw new NotSentError("destination_signing_args_mismatch");
          }
          return capability.signer.signTypedData(message);
        },
      };

      // 承認済みの 1 件だけを SDK に渡す（選択の余地を残さない）。
      const client = new x402Client((_version, requirements) => {
        if (requirements.length !== 1 || !sameOfferFields(approved, requirements[0]!)) {
          throw new NotSentError("destination_selected_offer_mismatch");
        }
        return requirements[0]!;
      });
      // 実 SDK 側の支出ガードも承認済みの資産・金額に縛る。
      client.setSpendControls({
        maxAmountPerPayment: false,
        allowedAssets: [
          {
            network: asNetwork(approved.network),
            asset: approved.asset,
            maxAmountPerPayment: approved.amount,
          },
        ],
      });
      client.register(asNetwork(capability.network), new ExactEvmScheme(guardedSigner));
      client.onBeforePaymentCreation(async (context) => {
        // 署名前の最終照合（SDK が選んだ要求そのものを見る）。
        if (
          !sameOfferFields(approved, context.selectedRequirements) ||
          stableJson(context.selectedRequirements) !== stableJson(selected) ||
          context.paymentRequired.x402Version !== 2 ||
          context.paymentRequired.resource.url !== url
        ) {
          return { abort: true, reason: "destination_selected_offer_mismatch" };
        }
        armed = true;
        return undefined;
      });
      const httpClient = new x402HTTPClient(client);

      let payload;
      try {
        payload = await httpClient.createPaymentPayload({
          ...challenge.parsed,
          accepts: [selected],
        });
      } catch {
        // payload 生成の失敗は**送信前**。署名も送信もしていない。
        return { outcome: "not_sent", reason: "destination_not_signed" };
      } finally {
        armed = false;
      }

      // 署名済み payload が主張する `accepted` が承認値と一致しなければ送らない。
      const accepted = (payload as { accepted?: unknown }).accepted;
      if (
        accepted === undefined ||
        !sameOfferFields(approved, accepted as PaymentRequirements) ||
        stableJson(accepted) !== stableJson(selected)
      ) {
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
          signal: AbortSignal.timeout(timeoutMs),
        }, payCtx);
      } catch {
        // 送ったかどうか分からない。自動再送しない（durable unknown）。transport は既に報告済み。
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      const receiptHeader =
        response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
      const contentType = response.headers.get("content-type") ?? "application/json";
      let parsedResult;
      try {
        parsedResult = await httpClient.processResponse(response);
      } catch (error) {
        // body の読み取り（headers 後）の失敗は adapter が報告する（設計 A §3.3-7）。
        transport.report(error, payCtx);
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }
      const header = parsedResult.header;
      /** SDK が解釈した決済レシートが、承認済み network と整合しているか。 */
      const settled =
        header !== undefined &&
        "success" in header &&
        header.success === true &&
        header.network === approved.network &&
        typeof header.transaction === "string" &&
        header.transaction !== "";

      /**
       * レシートが購入者を名乗る場合、それは**この Router が注入された署名者**でなければ
       * ならない。別 payer の決済を自分の支払いの証拠にしない（提示が無い場合は
       * network / transaction の整合だけで判断する）。
       */
      const claimedPayer = settled
        ? (header as unknown as Record<string, unknown>)["payer"]
        : undefined;
      const payerMatches =
        claimedPayer === undefined ||
        (typeof claimedPayer === "string" &&
          ADDRESS_PATTERN.test(claimedPayer) &&
          getAddress(claimedPayer) === getAddress(capability.signer.address));

      /** 配信データとして使えるのは JSON 本文を実際に取得できたときだけ。 */
      const jsonDelivered =
        contentType.includes("application/json") &&
        typeof parsedResult.body === "object" &&
        parsedResult.body !== null;

      if (response.status === 200) {
        // HTTP 200 だけでは支払いの証拠にしない（レシートが整合して初めて `paid`）。
        if (!settled || receiptHeader === null) {
          return { outcome: "unknown", reason: "destination_receipt_unverified" };
        }
        if (!payerMatches) {
          // 課金されたのが誰の支払いか確定できない。再送も再署名もしない。
          return { outcome: "unknown", reason: "destination_receipt_payer_mismatch" };
        }
        if (!jsonDelivered) {
          // 決済証跡は保持したまま「支払い済み・データ未取得」として終端する。
          return {
            outcome: "paid_no_data",
            reason: "paid_data_unavailable",
            receiptRef: receiptHeader,
          };
        }
        return {
          outcome: "paid",
          body: parsedResult.body,
          contentType,
          txRef: (header as { transaction: string }).transaction,
          receiptRef: receiptHeader,
        };
      }
      if (response.status === 502) {
        // 「支払い済み・データなし」を主張するには整合した実レシートが必要。
        if (!settled || receiptHeader === null || !payerMatches) {
          return { outcome: "unknown", reason: "destination_pay_unknown" };
        }
        return { outcome: "paid_no_data", reason: "paid_data_unavailable", receiptRef: receiptHeader };
      }
      if (response.status === 402) {
        // 上流が支払いを受け付けなかった。再署名はしない。
        return { outcome: "rejected", reason: "destination_rejected" };
      }
      if (response.status >= 500) {
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }
      return { outcome: "rejected", reason: "destination_rejected" };
    },
  };
}
