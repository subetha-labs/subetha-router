/**
 * Provider D（MPP `solana/charge` の資源サーバ。Cloudflare Workers）の fetch handler（`docs/provider-mpp-solana-workers.md` §2.2・§3.1）。
 * 順序: 404 → `Authorization` の判定（pay-kit と同じ: 小文字化して `payment ` で始まるか）→ 未払い: `Authorization` を外した要求で pay-kit の 402 →
 * 支払いつき: **先にデータ**（取れなければ 502、pay-kit を呼ばない）→ pay-kit（検証・simulate・共同署名・送出・確定待ち・照合・領収）→ 本文の固定化。
 * 送出の後には Worker の期限を掛けない。応答の本文とヘッダは固定文だけ（mppx の文言・鍵・URL を含めない）。
 * この module の export は handler と関数だけ（workerd は entry の export に値があると起動しない）。定数は config.ts。
 */
import { configOf, RESOURCE_PATH, type ProviderConfig, type ProviderEnv } from "./config.js";
import { DATA_TIMEOUT_MS, DeadlineError, RequestDeadline } from "./deadline.js";
import { installLogRedaction } from "./log.js";
import { createPayKitRuntime, type PayKitRuntime } from "./paykit.js";
import { DataUnavailableError, fetchSnapshot, serializeSnapshot } from "./snapshot.js";
import { NETWORK } from "./config.js";

const ENCODER = new TextEncoder();

/** 固定文の応答。`content-length` を明示し、本文は 1 つの文字列。`cache-control: no-store`。 */
function respond(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "content-length": String(ENCODER.encode(text).byteLength), ...headers },
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return respond(status, JSON.stringify(body), headers);
}

/** isolate ごとの状態（秘密を含まない config と pay-kit の runtime。鍵は signer の closure の中だけ）。 */
export interface Runtime {
  readonly config: ProviderConfig;
  readonly paykit: PayKitRuntime;
}

export interface Hooks {
  /** 試験の差し替え（データ源への fetch）。 */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export async function runtimeOf(env: ProviderEnv): Promise<Runtime> {
  const config = configOf(env);
  installLogRedaction(config.rpcUrl);
  const paykit = await createPayKitRuntime(env, config);
  return { config, paykit };
}

/** pay-kit と同じ判定（`detect`）: 大文字小文字を区別しない。 */
export function isPaymentAuthorization(value: string | null): boolean {
  return value !== null && value.toLowerCase().startsWith("payment ");
}

/** `Authorization` を外した写し（未払いの枝で pay-kit が settle に進める経路を残さない）。 */
export function withoutAuthorization(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  return new Request(request.url, { method: request.method, headers });
}

export async function handle(request: Request, runtime: Runtime, hooks: Hooks = {}): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== RESOURCE_PATH || url.search !== "" || request.method !== "GET") return json(404, { error: "not_found" });

  // 未払い: pay-kit の 402 をそのまま（本文も pay-kit の `accepts`）。`cache-control` を足す。402 でなければ想定外 → 500 固定文。
  if (!isPaymentAuthorization(request.headers.get("authorization"))) {
    let challenge: Response;
    try {
      challenge = await runtime.paykit.challenge(withoutAuthorization(request));
    } catch {
      console.error("provider: challenge failed");
      return json(500, { error: "challenge_failed" });
    }
    if (challenge.status !== 402) {
      void challenge.body?.cancel().catch(() => {});
      console.error("provider: challenge was not a 402");
      return json(500, { error: "challenge_failed" });
    }
    const wwwAuthenticate = challenge.headers.get("www-authenticate");
    const text = await challenge.text();
    return respond(402, text, wwwAuthenticate === null ? {} : { "www-authenticate": wwwAuthenticate });
  }

  // 1. データ（支払いの前。取れない・形が違う・直列化して 64 KiB を超える → pay-kit を呼ばない: 「払ったのにデータが無い」を作らない）。
  const deadline = new RequestDeadline(hooks.now ?? Date.now, DATA_TIMEOUT_MS);
  const dataStage = deadline.stage(DATA_TIMEOUT_MS);
  let bodyText: string;
  try {
    const snapshot = await fetchSnapshot(runtime.config.dataUrl, NETWORK, dataStage.signal, hooks.fetch, hooks.now);
    bodyText = serializeSnapshot(snapshot).text;
  } catch (error) {
    if (!(error instanceof DataUnavailableError) && !(error instanceof DeadlineError)) console.error("provider: data stage failed");
    return json(502, { error: "data_unavailable" });
  } finally {
    dataStage.dispose();
    deadline.release();
  }

  // 2. pay-kit（検証・simulate・共同署名・送出・確定待ち・照合・領収）。ここには Worker の期限を掛けない（送出の後に切ると資金だけ動く）。
  let paid: Response;
  try {
    paid = await runtime.paykit.paid(request, bodyText);
  } catch {
    console.error("provider: payment stage threw");
    return json(502, { error: "payment_failed" });
  }
  if (paid.status === 402) {
    // 検証の失敗・RPC の不達・確定待ちの timeout のどれも pay-kit は 402（新しい challenge つき、領収なし）。本文は固定（mppx の文言を透過しない）。
    void paid.body?.cancel().catch(() => {});
    const wwwAuthenticate = paid.headers.get("www-authenticate");
    return respond(402, "{}", wwwAuthenticate === null ? {} : { "www-authenticate": wwwAuthenticate });
  }
  if (paid.status !== 200) {
    void paid.body?.cancel().catch(() => {});
    console.error("provider: payment stage answered a non-200, non-402 status");
    return json(502, { error: "payment_failed" });
  }
  const receipt = paid.headers.get("payment-receipt");
  void paid.body?.cancel().catch(() => {});
  if (receipt === null || receipt === "") {
    console.error("provider: 200 without a receipt");
    return json(502, { error: "receipt_missing" });
  }
  // 3. 200 + Payment-Receipt（pay-kit の値そのまま）+ 本文（1 で直列化した文字列そのもの）。
  return respond(200, bodyText, { "payment-receipt": receipt });
}

/** Workers の入口。config・鍵の失敗は isolate の全要求で 500 固定文（値は出ない）。 */
let cached: Promise<Runtime> | undefined;
export default {
  async fetch(request: Request, env: ProviderEnv): Promise<Response> {
    cached ??= runtimeOf(env).catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    let runtime: Runtime;
    try {
      runtime = await cached;
    } catch {
      console.error("provider: misconfigured");
      return json(500, { error: "misconfigured" });
    }
    return handle(request, runtime);
  },
};
