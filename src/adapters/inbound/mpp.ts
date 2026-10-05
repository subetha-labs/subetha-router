/**
 * 受信レール **MPP**（Tempo charge）の adapter（P5 / `docs/p5-inbound-rails-design.md`）。
 *
 * Router は受信側＝**受取人**なので、ここに**署名鍵は無い**。必要なのは
 * challenge を HMAC 束縛する `secretKey` と受取先 `recipient` だけで、
 * どちらも**外から注入**する（`src/**` は env から秘密を読まない）。
 *
 * 公式 `mppx/server` の `Mppx.create` + `tempo.charge` をそのまま呼ぶ。
 * 自前の challenge 生成・自前の HMAC・自前の検証は書かない。
 *
 * **push 固定。** `tempo.charge` には push（payer が broadcast 済み）と
 * pull（**サーバが broadcast する**）があり、pull では Router が送信主体になって
 * gas を負担する。本スライスは `supportedModes: ["push"]` に固定し、
 * 受信レグに鍵も gas 予算も持ち込まない。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { Challenge } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { Store } from "mppx";
import { createClient as createViemClient } from "viem";
import { tempo as tempoMainnet, tempoModerato } from "viem/tempo/chains";

import { stableJson } from "../../core/intent.js";
import type { GuardedTransport, TransportContext } from "../../net/guarded-fetch.js";
import { guardedRpcTransport } from "../../net/guarded-rpc.js";
import type {
  CreateOfferRequest,
  InboundCallContext,
  InboundOffer,
  InboundRail,
  PaymentCredential,
  PreflightResult,
  SettleResult,
} from "../../ports/inbound.js";

export const MPP_INBOUND_SCHEME = "tempo/charge";

/** `meta` に載せる予約キー。route 束縛と per-quote 一意性をここで担保する。 */
const META_ROUTE_BINDING = "routeBinding";
const META_PAYMENT_ID = "paymentId";

export interface MppInboundOptions {
  /**
   * challenge の HMAC 束縛鍵（**32 バイト以上**）。署名鍵ではないが秘密。
   * SDK は `MPP_SECRET_KEY` を自動検出するが、**必ず明示的に渡す**
   * （`src/**` が env から秘密を読む経路を作らないため）。
   */
  readonly secretKey: string;
  /** 受取先（Router 自身のアドレス）。 */
  readonly recipient: string;
  /** 受信資産（TIP-20 トークンアドレス）。 */
  readonly currency: string;
  /** 受信チェーン。 */
  readonly chainId: number;
  /** offer の有効期間（秒）。**必ず渡す**（下記参照）。 */
  readonly maxTimeoutSeconds: number;
  /** realm（challenge の HMAC 入力に入る）。 */
  readonly realm?: string;
  /**
   * **テスト用の継ぎ目。** `broadcastCredential` を差し替える。
   * 実 SDK には任意のレシート（証跡なしの成功など）を返させられないため、
   * `settle` の分岐を実際に走らせるにはここを置き換えるしかない。
   * **本番では渡さない**（省略時は実 SDK を呼ぶ）。
   */
  /** SSRF 防御 A の transport（必須）。SDK の JSON-RPC（receipt の照合等）はこれを通る（設計 §3.5 経路 11）。 */
  readonly transport: GuardedTransport;
  /** Tempo の JSON-RPC。省略時は viem の既知チェーン（4217 / 42431）の既定 URL（SDK の既定と同じ）。 */
  readonly rpcUrl?: string;
  /** RPC 応答全体（headers + body）の期限。既定 10 s。 */
  readonly rpcTimeoutMs?: number;
  readonly broadcastForTest?: (credential: string, options: unknown) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ISO 8601 → unix 秒。
 *
 * `Challenge.expires` は **ISO 文字列で、しかも optional**。一方 `InboundOffer.extra.expiresAt`
 * は **unix 秒の必須欄**で、`preflight` が `expiresAt * 1000 <= nowMs` で失効を見る。
 * ここで数値化に失敗すると**失効検査が一度も発火しない**ので、黙って 0 や NaN にしない。
 */
function unixSecondsOf(expires: unknown): number {
  if (typeof expires !== "string" || expires === "") {
    throw new Error("mppx challenge did not carry an expiry");
  }
  const ms = Date.parse(expires);
  if (!Number.isFinite(ms)) {
    throw new Error(`mppx challenge has an unparsable expiry: ${expires}`);
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds <= 0) {
    throw new Error("mppx challenge expiry is not a positive instant");
  }
  return seconds;
}

export function createMppInbound(options: MppInboundOptions): InboundRail {
  if (options.secretKey.length < 32) {
    // SDK の要求。短い鍵で HMAC 束縛が弱くなる状態で起動させない。
    throw new Error("MPP inbound secretKey must be at least 32 bytes");
  }

  /**
   * replay 防止ストア。**プロセス内**なので Router を再起動すると消える
   * （`docs/p5-inbound-rails-design.md` の既知の制約）。Router 自身の at-most-once は
   * `quoteId` 直列化と `intent.status` 判定で、**こちらに依存していない**。
   */
  const store = Store.memory();

  /**
   * SDK の JSON-RPC を SSRF 防御 A の transport に通す（設計 §3.5 経路 11）。SDK は `getClient` を verify / settle の
   * 内側で呼ぶので、route は呼び出しの文脈を AsyncLocalStorage で運んで付ける。
   */
  const rpcContext = new AsyncLocalStorage<TransportContext>();
  const knownChain = [tempoMainnet, tempoModerato].find((chain) => chain.id === options.chainId);
  const rpcUrl = options.rpcUrl ?? knownChain?.rpcUrls.default.http[0];
  const getClient = (parameters: { chainId?: number | undefined }) => {
    if (parameters.chainId !== undefined && parameters.chainId !== options.chainId) {
      throw new Error(`refusing to build an RPC client for chain ${parameters.chainId}`);
    }
    if (rpcUrl === undefined) {
      throw new Error(`MPP inbound rpcUrl is required for chain ${options.chainId}`);
    }
    return createViemClient({
      chain: knownChain ?? { ...tempoModerato, id: options.chainId },
      transport: guardedRpcTransport(options.transport, rpcUrl, () => rpcContext.getStore() ?? { operation: "rpc" }, {
        timeout: options.rpcTimeoutMs,
      }),
    });
  };
  const rpcContextOf = (context: InboundCallContext | undefined): TransportContext => ({
    operation: "rpc",
    ...(context === undefined ? {} : { routeId: context.routeId }),
  });

  const mppx = Mppx.create({
    secretKey: options.secretKey,
    ...(options.realm === undefined ? {} : { realm: options.realm }),
    methods: [
      tempo.charge({
        getClient,
        recipient: options.recipient as `0x${string}`,
        currency: options.currency,
        /**
         * **`decimals: 0` は必須。** SDK は challenge の `amount` に
         * `parseUnits(amount, decimals)` を掛け、`decimals` の既定は 6
         * （`mppx/dist/tempo/internal/defaults.js`）。Router が扱う `amount` は
         * **既に base units** なので、既定のままだと HMAC に 10^6 倍の額が焼き付き、
         * **人間が承認した額と束縛された額が食い違う**（実測: 1000 → 1000000000）。
         */
        decimals: 0,
        // **push 固定**: payer が broadcast 済みの credential だけを受ける。
        supportedModes: ["push"],
        store,
      }),
    ],
  });

  /** SDK challenge → ポートの `InboundOffer`。 */
  function offerOf(
    challenge: Record<string, unknown>,
    request: CreateOfferRequest,
    amount: string,
  ): InboundOffer {
    const id = challenge["id"];
    if (typeof id !== "string" || id === "") {
      throw new Error("mppx challenge has no id");
    }
    /**
     * **SDK が実際に束縛した値と、これから payer に見せる値が一致するか確かめる。**
     *
     * 型では守れない。`tempo.charge()` の factory に `chainId` を渡しても**黙って無視され**、
     * `amount` は `decimals` 既定 6 で **10^6 倍**される。どちらも実測で踏んだ。
     * 食い違ったまま offer を出すと、**人間が承認した額・チェーンと、HMAC に焼き付いた
     * 額・チェーンが別物**になる。offer を発行せず止める。
     */
    const bound = challenge["request"];
    if (!isRecord(bound)) {
      throw new Error("mppx challenge has no request to verify against");
    }
    if (bound["amount"] !== amount) {
      throw new Error(
        `mppx bound a different amount than offered (offered ${amount}, bound ${String(bound["amount"])})`,
      );
    }
    const details = bound["methodDetails"];
    const boundChainId = isRecord(details) ? details["chainId"] : undefined;
    if (boundChainId !== options.chainId) {
      throw new Error(
        `mppx bound a different chain than offered (offered ${options.chainId}, bound ${String(boundChainId)})`,
      );
    }
    return {
      scheme: MPP_INBOUND_SCHEME,
      network: `eip155:${options.chainId}`,
      asset: options.currency,
      amount,
      payTo: options.recipient,
      maxTimeoutSeconds: options.maxTimeoutSeconds,
      extra: {
        challengeNonce: id,
        expiresAt: unixSecondsOf(challenge["expires"]),
        routeBinding: request.routeBinding,
        /**
         * **`true`。** MPP の credential は「送金済み tx の hash」なので、
         * payer は**先に broadcast しないと credential を作れない**。取り消せない。
         */
        fundsMoveOnCredential: true,
        /**
         * **payer が支払うために必要**。MPP の credential は「送金済み tx の hash」なので、
         * payer は challenge 本体（`realm` / `opaque` / 額 / 宛先）を知らないと
         * **challenge に束縛された memo を作れない**。id だけでは足りない。
         *
         * 秘密ではない（発行相手に返しているだけ）。x402 受信が `name` / `version` を
         * 載せて payer に EIP-712 domain を渡しているのと同じ役割。
         * `WWW-Authenticate` 形式なので、payer は公式 `Challenge.deserialize` で読める。
         */
        challenge: Challenge.serialize(challenge as Parameters<typeof Challenge.serialize>[0]),
      },
    };
  }

  return {
    async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
      const expires = new Date(request.nowMs + options.maxTimeoutSeconds * 1000).toISOString();
      /**
       * `challenge.id` は `realm|method|intent|request|expires|digest|opaque` の HMAC。
       * **同じ額・宛先・期限・scope なら同じ id になる**ので、`meta` に一意値を混ぜて
       * per-quote の一意性を作る（混ぜないと別 intent の credential が nonce 検査を通り得る）。
       * `meta` は `opaque` に畳まれて HMAC 入力に入り、クライアントは改変できない。
       *
       * **時刻では足りない**: `nowMs` はミリ秒なので、同一ミリ秒に 2 回発行すると
       * 同じ nonce になる（実測で確認済み）。`CreateOfferRequest` に一意な id が無いため、
       * ここで暗号論的乱数を混ぜる。
       */
      const challenge: unknown = await rpcContext.run({ routeId: request.routeId, operation: "rpc" }, () => mppx.challenge.tempo.charge({
        amount: request.amount,
        /**
         * **chainId は challenge 呼び出し側で渡す。** `tempo.charge()` の factory 引数に
         * 渡しても**黙って無視され**、mainnet 4217 に落ちる（実測）。
         * offer が名乗る network と HMAC 束縛が食い違うと、**別チェーンの支払い**になる。
         */
        chainId: options.chainId,
        expires,
        scope: request.routeBinding,
        meta: {
          [META_ROUTE_BINDING]: request.routeBinding,
          [META_PAYMENT_ID]: `${request.routeId}:${request.nowMs}:${randomUUID()}`,
        },
      }));
      if (!isRecord(challenge)) {
        throw new Error("mppx did not return a challenge");
      }
      return offerOf(challenge, request, request.amount);
    },

    /**
     * journal 生成**前**の strict preflight。**同期**でなければならない
     * （`src/core/orchestrator.ts:413` は await しない。async にすると全購入が落ちる）。
     * したがってここで SDK を呼ばない。理由文字列は core が知る固定集合から選ぶ。
     */
    preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
      if (credential.payload.challengeNonce !== offer.extra.challengeNonce) {
        return { ok: false, reason: "nonce_mismatch" };
      }
      if (offer.extra.expiresAt * 1000 <= nowMs) {
        return { ok: false, reason: "offer_expired" };
      }
      const accepted = credential.accepted as InboundOffer | undefined;
      if (accepted === undefined || accepted.scheme !== MPP_INBOUND_SCHEME) {
        return { ok: false, reason: "credential_mismatch" };
      }
      if (accepted.extra?.routeBinding !== offer.extra.routeBinding) {
        return { ok: false, reason: "route_binding_mismatch" };
      }
      if (stableJson(accepted) !== stableJson(offer)) {
        return { ok: false, reason: "offer_mismatch" };
      }
      return { ok: true };
    },

    /**
     * 非破壊の事前検査。**replay 防止はここに無い**
     * （`tryClaim` はすべて broadcast 側にある）。したがって
     * **`verify` が通ったことを「受領した」根拠にしてはならない**。
     */
    async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean }> {
      const wire = credential.payload["credential"];
      if (typeof wire !== "string" || wire === "") {
        return { isValid: false };
      }
      try {
        // `request` は渡さない。渡すと SDK が route 要件を組み直して
        // `credential opaque does not match this route's requirements` になる（実測）。
        // 額・宛先の照合は challenge（`opaque`）に既に束縛されている。
        await rpcContext.run(rpcContextOf(context), () => mppx.validateCredential(wire, { scope: offer.extra.routeBinding }));
        return { isValid: true };
      } catch {
        // 検証できないまま settle へ進まない（この時点で課金は起きていない）。
        return { isValid: false };
      }
    },

    /**
     * 実際の受領。**失敗を安易に `rejected` にしない。**
     *
     * push mode では payer が既に broadcast しているので、こちらの確認が失敗しても
     * **送金は成立している可能性がある**。`rejected` を返すと core は `source_failed` →
     * 公開状態 `awaiting_payment`（＝未払い）を表明してしまう（`orchestrator.ts:530-539`）。
     * 断定できないものはすべて `unknown` に落とす。
     */
    async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
      const wire = credential.payload["credential"];
      if (typeof wire !== "string" || wire === "") {
        // 資格情報の形が違う。**課金は起きていないと断定できる**数少ない場合。
        return { outcome: "rejected", reason: "source_rejected" };
      }
      let receipt: unknown;
      try {
        // `request` を渡さない理由は verify と同じ（opaque 不一致になる）。
        const broadcastOptions = { scope: offer.extra.routeBinding };
        receipt =
          options.broadcastForTest === undefined
            ? await rpcContext.run(rpcContextOf(context), () => mppx.broadcastCredential(wire, broadcastOptions))
            : await options.broadcastForTest(wire, broadcastOptions);
      } catch {
        // 例外は成否不明。自動再 settle はしない。
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      if (!isRecord(receipt)) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      // `Receipt.status` は `z.literal("success")`（失敗は 402 + Problem Details の
      // **例外**として来る）。それでも値を信じずに確認する: 契約違反の応答を
      // `settled` に通さないため。
      if (receipt["status"] !== "success") {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      // mppx のレシートは txHash を `reference` に載せる（`payload.hash` ではない）。
      const reference = receipt["reference"];
      if (typeof reference !== "string" || reference === "") {
        // 成功と名乗っているが証跡が無い。証跡なしで `settled` にしない。
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      return { outcome: "settled", txRef: reference };
    },
  };
}
