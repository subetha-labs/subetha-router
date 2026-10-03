/**
 * 送信レール B（MPP / Provider B 形）の adapter（T3 / 設計 §10 M6）。
 *
 * インストール済みの公式 `mppx`（`mppx/client` の `Mppx.create` + `tempo.charge`、`mppx` の
 * `Receipt` / `Constants`）を**そのまま**呼ぶ。高レベル `mppx.fetch` の自動支払いは使わず、
 * `rawFetch` → `preparePayment`（署名前に選択済み challenge を公開）→ `createCredential`（1 回）
 * → `setCredential` → 1 回だけ送信、という明示的な経路だけを使う（`maxPaymentRetries: 0`）。
 *
 * 署名・送信能力（viem account と client）は**外から注入**されたものだけを使い、adapter 内に
 * 鍵も偽の署名者も持たない。承認値と外れた challenge では credential を作らず送信もしない
 * （`not_sent`）。自動 swap / FX / bridge / 自動再購入 / 自動返金は行わない。
 */

import { Challenge, Constants, Credential, PaymentRequest, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { createClient as createViemClient, custom, type Client } from "viem";

import { assertLoopbackUrl } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import { discardBody, type GuardedTransport, type TransportContext } from "../../net/guarded-fetch.js";
import { guardedRpcTransport } from "../../net/guarded-rpc.js";
import type {
  DestinationOffer,
  MppTempoCapability,
  OutboundRail,
  PayRequest,
  PayResult,
} from "../../ports/outbound.js";

/** mppx の `_mppx_scope` は `GET <canonical URL>`（クエリ無し）で cross-resource replay を防ぐ。 */
const SCOPE_META_KEY = "_mppx_scope";

export interface MppOutboundOptions {
  /** `routeId` → 上流 canonical URL（クエリ無しの GET 1 本）。 */
  readonly upstreams: Readonly<Record<string, string>>;
  /** 支払い能力（無いまま組み立てない。呼び出し側が fail closed を決める）。 */
  readonly capability: MppTempoCapability;
  /** 上流へ出る全要求（`mppx.rawFetch` を含む）が通る transport（SSRF 防御 A。必須）。 */
  readonly transport: GuardedTransport;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 実 SDK が解析した challenge から読む欄（欠けていれば候補にしない）。 */
interface ChallengeView {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  readonly scope: string;
  readonly chainId: number;
  readonly amount: string;
  readonly currency: string;
  readonly recipient: string;
  readonly expiresAt: number | undefined;
  /**
   * 支払い条件の全文（realm / method / intent / request / meta を未知フィールドまで含む）。
   * `id` / `expires` / `digest` / `opaque` は発行ごとに変わるのでここには入れない。
   */
  readonly terms: string;
}

/**
 * challenge の server metadata（`_mppx_scope` を含む）を読む。
 *
 * `Challenge.meta()` はプロセス内の `challenge.meta` をそのまま返すだけで、wire を通った
 * challenge では meta は `opaque` に畳まれている（`Challenge.from` が
 * `PaymentRequest.serialize(meta)` で符号化し、challenge ID の HMAC にも含める）。
 * よって対称の公式 decoder `PaymentRequest.deserialize` で読む（自前の復号はしない）。
 */
function metaOf(challenge: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = Challenge.meta(challenge as unknown as Challenge.Challenge);
  if (isRecord(direct)) {
    return direct;
  }
  const opaque = challenge["opaque"];
  if (typeof opaque !== "string" || opaque === "") {
    return undefined;
  }
  try {
    const decoded: unknown = PaymentRequest.deserialize(opaque);
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function viewOf(challenge: unknown): ChallengeView | undefined {
  if (!isRecord(challenge)) {
    return undefined;
  }
  const { id, realm, method, intent, request, expires } = challenge;
  if (
    typeof id !== "string" ||
    typeof realm !== "string" ||
    typeof method !== "string" ||
    typeof intent !== "string" ||
    !isRecord(request)
  ) {
    return undefined;
  }
  const meta = metaOf(challenge);
  const scope = meta?.[SCOPE_META_KEY];
  const details = request["methodDetails"];
  const chainId = isRecord(details) ? details["chainId"] : undefined;
  const { amount, currency, recipient } = request;
  if (
    typeof scope !== "string" ||
    typeof chainId !== "number" ||
    !Number.isInteger(chainId) ||
    typeof amount !== "string" ||
    typeof currency !== "string" ||
    typeof recipient !== "string"
  ) {
    return undefined;
  }
  const expiresAt = typeof expires === "string" ? Date.parse(expires) : undefined;
  return {
    id,
    realm,
    method,
    intent,
    scope,
    chainId,
    // wire の atomic amount をそのまま真とする（human 価格を二重に parseUnits しない）。
    amount,
    currency,
    recipient,
    expiresAt: expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt : undefined,
    terms: stableJson({ realm, method, intent, request, meta: meta ?? null }),
  };
}

/** core の allowlist 照合に渡す形（`extra.terms` に条件全文を畳み込む）。 */
function offerOf(view: ChallengeView): DestinationOffer {
  return {
    scheme: `${view.method}/${view.intent}`,
    network: `eip155:${view.chainId}`,
    asset: view.currency,
    amount: view.amount,
    payTo: view.recipient,
    extra: { realm: view.realm, scope: view.scope, terms: view.terms },
  };
}

function offerTermsOf(offer: DestinationOffer): string | undefined {
  const terms = offer.extra?.["terms"];
  return typeof terms === "string" ? terms : undefined;
}

/**
 * 送金を発生させ得る RPC メソッド（読取は含めない）。
 *
 * 公式 SDK は単一 transfer のとき `experimental_fallback: true` で `wallet_sendCalls` を呼ぶため、
 * viem は曖昧な失敗（`UnknownRpcError` 等）でも `eth_sendTransaction` へ落ちる。`maxPaymentRetries: 0`
 * はこの内部 fallback を止めないので、**能力境界**で 1 支払い 1 送金要求に制限する。
 */
const SEND_RPC_METHODS = new Set([
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_signTransaction",
  "wallet_sendCalls",
  "wallet_sendCallsSync",
  "wallet_sendTransaction",
]);

/** 2 度目の送金要求を拒否する（最初の送金の成否が不明でも追加送金はしない）。 */
class DuplicateSendError extends Error {
  readonly code = "duplicate_send_blocked";

  constructor() {
    super("duplicate_send_blocked: only one payment send is allowed per purchase attempt");
    this.name = "DuplicateSendError";
  }
}

/**
 * receipt が payer を名乗る場合の厳密照合。`did:pkh:eip155:<chainId>:<address>` /
 * `eip155:<chainId>:<address>` / 素のアドレスのいずれかに**完全一致**していなければ受理しない
 * （部分一致を許すと別チェーンや前後に文字列を足した payer を通してしまう）。
 */
function payerMatches(payer: unknown, chainId: number, address: string): boolean {
  if (payer === undefined) {
    // 省略可能欄。名乗っていないものを名乗ったことにはしない。
    return true;
  }
  if (typeof payer !== "string") {
    return false;
  }
  const claimed = payer.trim().toLowerCase();
  const account = address.toLowerCase();
  return (
    claimed === account ||
    claimed === `eip155:${chainId}:${account}` ||
    claimed === `did:pkh:eip155:${chainId}:${account}`
  );
}

export function createMppOutbound(options: MppOutboundOptions): OutboundRail {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const capability = options.capability;

  const upstreams = new Map<string, string>();
  for (const [routeId, raw] of Object.entries(options.upstreams)) {
    const at = `mpp.upstreams.${routeId}`;
    // 署名しない試験用能力は loopback fixture 以外に向けない（fixture credential を外に出さない）。
    const url = new URL(
      capability.kind === "non-signing-fixture" ? assertLoopbackUrl(raw, at) : raw,
    );
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

  /**
   * 公式 client を 1 支払いごとに組む。承認済み offer があるときは、実 SDK 側の
   * 受取先・チェーン allowlist にも承認値そのものを渡す（SDK が先に弾く）。
   */
  const transport = options.transport;

  /** request-local な文脈。1 回の `pay` の中で `pay_challenge` → `pay` と進める（adapter 全体では共有しない）。 */
  type MutableContext = { routeId: string; operation: string };

  type RpcRequest = (args: { method: string; params?: unknown }, options?: Record<string, unknown>) => Promise<unknown>;

  /**
   * 能力の client の JSON-RPC も SSRF 防御 A の transport に通す（設計 §3.5 経路 12）。
   * viem の**素の** `http` transport（`type` と `key` が `http`）なら、その URL・`fetchOptions`（認証ヘッダ等）・retry・timeout で
   * guarded な http transport を**作り直す**（能力側の fetch は使わない。`onFetchRequest` 等の closure は引き継げないので対象外）。
   * 試験用 spy（`non-signing-fixture`）の `custom` transport は HTTP を持たないのでそのまま。
   * 実鍵で素の http 以外の transport（`fallback`、`webSocket`、`withFeePayer` 等の装飾）は fail closed（どこへ出るか保証できない）。
   */
  function guardedRpcRequestOf(client: Client, ctx: MutableContext): RpcRequest {
    const t = client.transport as {
      type?: unknown;
      key?: unknown;
      url?: unknown;
      fetchOptions?: RequestInit;
      retryCount?: number;
      retryDelay?: number;
      timeout?: number;
    };
    if (t.type === "http" && t.key === "http" && typeof t.url === "string") {
      const guarded = createViemClient({
        ...(client.chain === undefined ? {} : { chain: client.chain }),
        ...(client.account === undefined ? {} : { account: client.account }),
        transport: guardedRpcTransport(transport, t.url, () => ({ routeId: ctx.routeId, operation: "rpc" }), {
          fetchOptions: t.fetchOptions,
          retryCount: t.retryCount,
          retryDelay: t.retryDelay,
          timeout: t.timeout,
        }),
      });
      return guarded.request.bind(guarded) as RpcRequest;
    }
    if (capability.kind === "non-signing-fixture") {
      return client.request.bind(client) as RpcRequest;
    }
    throw new Error("MPP capability client must use viem's plain http transport (SSRF defense A)");
  }

  function createClient(
    ctx: MutableContext,
    approved?: { readonly chainId: number; readonly recipient: string },
    /** 注入された支払い能力への到達と送金要求回数を記録する。 */
    reach?: { touched: boolean; sends: number },
  ) {
    const method = tempo.charge({
      account: capability.account,
      getClient: async (parameters) => {
        if (reach !== undefined) {
          reach.touched = true;
        }
        const client = await capability.getClient(parameters);
        const rpcRequest = guardedRpcRequestOf(client, ctx);
        if (reach === undefined) {
          return createViemClient({
            ...(client.chain === undefined ? {} : { chain: client.chain }),
            ...(client.account === undefined ? {} : { account: client.account }),
            transport: custom({ request: rpcRequest }, { retryCount: 0 }),
          });
        }
        /**
         * 能力から返る client には実送金権限がある前提で、**送金系 RPC を 1 支払い 1 回**に
         * 制限する。読取系（chainId・nonce・見積り等）はそのまま通す。
         *
         * 送金 request は内側の retry も 0 に固定する（viem `buildRequest` は
         * `overrideOptions.retryCount` が無いと 3 回再試行し、`sendCalls` は本来
         * `request(args, { retryCount: 0 })` で呼ぶ）。caller の options / signal は保つ。
         */
        const injectedRequest = rpcRequest;
        const guardedRequest = async (args: {
          method: string;
          params?: unknown;
          [key: string]: unknown;
        }): Promise<unknown> => {
          if (!SEND_RPC_METHODS.has(args.method)) {
            return injectedRequest(args);
          }
          if (reach.sends >= 1) {
            // 1 度目の成否が不明でも、SDK / viem の内部 fallback に 2 度目を出させない。
            throw new DuplicateSendError();
          }
          reach.sends += 1;
          return injectedRequest(args, { retryCount: 0 });
        };

        /**
         * SDK に渡すのは **guard した primitive request だけを持つ最小の base client**。
         * decorated な action closure（walletClient の `sendCalls` 等）は元の client を
         * 捕捉しており、`getAction` がそれを優先すると guard を迂回するため持ち込まない。
         * これで実 SDK の action 実装はそのまま走り、RPC は必ず guard を通る。
         */
        return createViemClient({
          ...(client.chain === undefined ? {} : { chain: client.chain }),
          ...(client.account === undefined ? {} : { account: client.account }),
          transport: custom({ request: guardedRequest }, { retryCount: 0 }),
        });
      },
      // FX・DEX 経由の自動調達はしない。
      autoSwap: false,
      ...(capability.mode === undefined ? {} : { mode: capability.mode }),
      ...(approved === undefined
        ? {}
        : {
            expectedChainId: approved.chainId,
            allowedChainIds: [approved.chainId],
            expectedRecipients: [approved.recipient as `0x${string}`],
          }),
    });
    return Mppx.create({
      methods: [method],
      // 全要求（rawFetch）を SSRF 防御 A の transport に通す。文脈は呼び出し時の ctx を読む。
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        transport.fetch(url instanceof Request ? url.url : url, init, ctx as TransportContext)) as typeof globalThis.fetch,
      // `globalThis.fetch` を置き換えない。自動支払いリトライもしない。
      polyfill: false,
      maxPaymentRetries: 0,
    });
  }

  const baseInit = (): RequestInit => ({
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    /** 上流の現在の challenge を読む（純粋読取・無課金・credential を作らない）。 */
    async readChallenge(routeId: string): Promise<readonly DestinationOffer[]> {
      const url = urlFor(routeId);
      const mppx = createClient({ routeId, operation: "challenge" });
      const init = baseInit();
      const response = await mppx.rawFetch(url, init);
      // SDK は challenge を headers から読み body を消費しない。読まない body は捨てる（設計 A §3.3-7）。
      const discard = (): void => discardBody(response);
      if (response.status !== 402) {
        discard();
        throw new Error(`upstream challenge returned status ${response.status}`);
      }
      // 実 SDK に challenge を解析・選択させる（自前の解釈で置き換えない）。
      let prepared;
      try {
        prepared = await mppx.preparePayment(response, { request: init });
      } finally {
        discard();
      }
      const offers: DestinationOffer[] = [];
      for (const challenge of prepared.challenges) {
        const view = viewOf(challenge);
        // scope は canonical URL への束縛。別リソースの challenge は候補にしない。
        if (view !== undefined && view.scope === `GET ${url}`) {
          offers.push(offerOf(view));
        }
      }
      return offers;
    },

    async pay(request: PayRequest): Promise<PayResult> {
      const url = urlFor(request.routeId);
      const approved = request.offer;
      const approvedTerms = offerTermsOf(approved);
      const approvedJson = stableJson(approved);
      if (approvedTerms === undefined) {
        return { outcome: "not_sent", reason: "destination_offer_unbound" };
      }
      const chainIdMatch = /^eip155:(\d+)$/.exec(approved.network);
      if (chainIdMatch === null) {
        return { outcome: "not_sent", reason: "destination_network_unsupported" };
      }
      const chainId = Number(chainIdMatch[1]);
      // 支払いチェーンは注入された能力の側でも一致していること（testnet/mainnet を混同しない）。
      if (capability.chainId !== chainId) {
        return { outcome: "not_sent", reason: "destination_signer_network_mismatch" };
      }

      /**
       * `pull`（server 側 broadcast）は本 slice では未検証で、credential から receipt を
       * 相関させる材料（取引ハッシュ）も得られない。課金してから未対応に気づく流れを作らず、
       * credential 生成**前**に fail closed で断る。
       */
      if (capability.mode === "pull") {
        return { outcome: "not_sent", reason: "destination_unsupported_mode" };
      }

      // push mode では credential 生成の途中で既に broadcast され得るので、能力に触れたかを
      // 記録し、触れた後の失敗は `not_sent` と断定しない。
      const reach = { touched: false, sends: 0 };
      const ctx: MutableContext = { routeId: request.routeId, operation: "pay_challenge" };
      const mppx = createClient(ctx, { chainId, recipient: approved.payTo }, reach);
      const init = baseInit();

      // 送金直前に読み直す（凍結した challenge をそのまま払わない）。
      let prepared;
      try {
        const response = await mppx.rawFetch(url, init);
        // SDK は challenge を headers から読み body を消費しない。読まない body は捨てる（設計 A §3.3-7）。
        const discard = (): void => discardBody(response);
        if (response.status !== 402) {
          discard();
          return { outcome: "not_sent", reason: "destination_challenge_unreadable" };
        }
        try {
          prepared = await mppx.preparePayment(response, { request: init });
        } finally {
          discard();
        }
      } catch {
        // transport の失敗は既に報告済み。SDK の解析失敗は接続後の事象で、固定の結果に変える。
        return { outcome: "not_sent", reason: "destination_challenge_unreadable" };
      }

      // 実 SDK が選んだ challenge を、承認済み offer と field / 条件全文で照合する。
      const view = viewOf(prepared.challenge);
      if (view === undefined) {
        return { outcome: "not_sent", reason: "destination_challenge_unreadable" };
      }
      if (view.scope !== `GET ${url}`) {
        return { outcome: "not_sent", reason: "destination_resource_mismatch" };
      }
      if (view.terms !== approvedTerms || stableJson(offerOf(view)) !== approvedJson) {
        return { outcome: "not_sent", reason: "destination_offer_changed" };
      }
      if (view.expiresAt !== undefined && view.expiresAt <= Date.now()) {
        return { outcome: "not_sent", reason: "destination_offer_expired" };
      }

      // credential は 1 回だけ作る（SDK 契約でも at-most-once）。
      let credential: string;
      try {
        credential = await prepared.createCredential();
      } catch {
        // 能力に触れる前の失敗（allowlist 違反など）なら、まだ何も動いていない。
        if (!reach.touched) {
          return { outcome: "not_sent", reason: "destination_not_signed" };
        }
        // 触れた後の失敗は broadcast 済みの可能性を否定できない。保守的に unknown を保持し、
        // 自動再作成・自動再送・自動返金はしない。
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      /**
       * 今回の送金に receipt を束縛する材料を、公式 decoder で credential から取り出す。
       * push（`payload.type === "hash"`）では `payload.hash` が broadcast した取引で、上流の
       * receipt はその `reference` を返す。束縛できない payload 形（pull の署名等）は、この
       * slice では receipt を自分の送金と対応づけられないため fail closed にする。
       */
      let expectedReference: string | undefined;
      try {
        const decoded = Credential.deserialize(credential);
        const payload = (decoded as { payload?: unknown }).payload;
        if (isRecord(payload) && payload["type"] === "hash" && typeof payload["hash"] === "string") {
          expectedReference = payload["hash"];
        }
      } catch {
        expectedReference = undefined;
      }

      ctx.operation = "pay";
      let response: Response;
      try {
        // 1 要求 1 回だけ。402 を受けても再作成・再送信をしない。
        const paidInit = prepared.setCredential(init, credential);
        response = await mppx.rawFetch(url, {
          ...paidInit,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // 課金有無が不明。自動再送しない（durable unknown）。
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      const receiptHeader = response.headers.get(Constants.Headers.paymentReceipt);
      const contentType = response.headers.get("content-type") ?? "application/json";

      /** 実 SDK に receipt を解析させ、challenge と対応しているかまで見る。 */
      let receipt: Receipt.Receipt | undefined;
      if (receiptHeader !== null && receiptHeader !== "") {
        try {
          receipt = Receipt.deserialize(receiptHeader);
        } catch {
          receipt = undefined;
        }
      }
      const claimedPayer = (receipt as unknown as Record<string, unknown> | undefined)?.["payer"];
      const receiptOk =
        receipt !== undefined &&
        receipt.status === "success" &&
        // 別 method のレシートを自分の支払いの証拠にしない。
        receipt.method === view.method &&
        typeof receipt.reference === "string" &&
        receipt.reference !== "" &&
        // **今回の送金**への束縛。別取引の receipt を自分の支払いの証拠にしない。
        expectedReference !== undefined &&
        receipt.reference.toLowerCase() === expectedReference.toLowerCase() &&
        // payer を名乗る receipt は、注入された支払い元と厳密に一致していなければならない。
        payerMatches(claimedPayer, chainId, capability.account.address);

      if (response.status === 200) {
        // HTTP 200 だけでは課金の証拠にしない。
        if (!receiptOk) {
          discardBody(response); // 読まない body は捨てて接続を即時に解放する（設計 §3.3-7）
          return { outcome: "unknown", reason: "destination_receipt_unverified" };
        }
        let body: unknown;
        try {
          body = contentType.includes("application/json")
            ? await response.json()
            : await response.text();
        } catch (error) {
          // body の読み取り（headers 後）の失敗は adapter が報告する（設計 A §3.3-7）。
          transport.report(error, ctx);
          body = undefined;
        }
        if (!contentType.includes("application/json") || !isRecord(body)) {
          // 課金証跡は保持したまま「支払い済み・データ未取得」として終端する。
          return {
            outcome: "paid_no_data",
            reason: "paid_data_unavailable",
            receiptRef: receiptHeader ?? "",
          };
        }
        return {
          outcome: "paid",
          body,
          contentType,
          txRef: receipt!.reference,
          receiptRef: receiptHeader!,
        };
      }
      if (response.status === 502) {
        discardBody(response); // 502 の body は読まない
        // 「支払い済み・データなし」を主張するには整合した実 receipt が必要。
        if (!receiptOk || receiptHeader === null) {
          return { outcome: "unknown", reason: "destination_pay_unknown" };
        }
        return {
          outcome: "paid_no_data",
          reason: "paid_data_unavailable",
          receiptRef: receiptHeader,
        };
      }
      // 402 を含む 4xx も 5xx も、credential を送ったあとは課金有無を断定できない
      // （push は client 側で broadcast 済み、pull も server が broadcast した可能性を否定できない）。
      // durable unknown を保持し、再作成・再送・自動返金はしない。
      discardBody(response);
      return { outcome: "unknown", reason: "destination_pay_unknown" };
    },
  };
}
