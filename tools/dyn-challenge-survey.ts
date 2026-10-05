/**
 * 設計の実測 M-3（`docs/dynamic-upstream-design.md` §3.3 (i)・§10、タスク T0-c）。**製品コードではない。**
 *
 * 問い: 実在の x402／MPP エンドポイントは、未払いの GET に対してどんな**欄**を返すか。
 * 許可する欄の一覧（動的経路の offer／challenge の検査）を、推測ではなく実物から決めるため。
 *
 * 各 URL に**支払いヘッダなしの GET を 1 回**送り、応答の**欄の名前と型だけ**を出す。値を出すのは、分類に要る
 * scheme・network・x402Version・method・intent・chainId・supportedModes だけで、**決まった形の値に限る**（下の `classify`）。
 * 本文は保存しない（上限つきで読み、形だけ取り出す）。リダイレクトは追わない。
 *
 * MPP の challenge は 2 通りに記録する: 生の `WWW-Authenticate` の**パラメータ名**（未知の欄も見える）と、
 * SDK（`Challenge.deserialize`）が正規化した後の形（SDK が認識する欄だけ。未知の欄は落ちる）。
 *
 * usage: npx tsx tools/dyn-challenge-survey.ts https://… [https://… ...]
 */
import { Challenge } from "mppx";

/** 値を出してよい欄と、その値が満たすべき形。満たさなければ型だけを出す。 */
const CLASSIFIERS: Readonly<Record<string, (value: unknown) => boolean>> = {
  scheme: (v) => typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v),
  network: (v) => typeof v === "string" && /^[a-z0-9]{1,16}:[A-Za-z0-9+/=_-]{1,64}$/.test(v),
  x402Version: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100,
  method: (v) => typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v),
  intent: (v) => typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v),
  chainId: (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  supportedModes: (v) => Array.isArray(v) && v.length <= 4 && v.every((mode) => mode === "push" || mode === "pull"),
};

/** 値を「型」に畳む。分類に要る欄だけ、決まった形のときに値を残す。配列は全要素の形を出す（重複は除く）。 */
function shapeOf(value: unknown, key = ""): unknown {
  const classify = CLASSIFIERS[key];
  if (classify !== undefined && classify(value)) return value;
  if (Array.isArray(value)) {
    const shapes = value.map((entry) => shapeOf(entry));
    if (key === "accepts") return shapes;
    const seen = new Map(shapes.map((shape) => [JSON.stringify(shape), shape]));
    return [...seen.values()];
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, shapeOf(v, k)]));
  }
  return value === null ? "null" : typeof value;
}

/** `WWW-Authenticate` から `Payment` の challenge を取り出し、**パラメータ名だけ**を返す（値は返さない）。 */
function paymentChallengesOf(header: string): { names: string[]; raw: string }[] {
  const challenges: { names: string[]; raw: string }[] = [];
  // 他の認証方式が前にあっても拾う。`Payment ` で始まる区間を、次の方式名（`, Word `）の手前まで。
  for (const match of header.matchAll(/(?:^|,\s*)(Payment\s+.*?)(?=,\s*[A-Za-z][A-Za-z0-9-]*\s+[a-z]+=|$)/gs)) {
    const raw = match[1]!.trim();
    const names = [...raw.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)=(?:"[^"]*"|[^,\s]*)/g)].map((m) => m[1]!).sort();
    challenges.push({ names, raw });
  }
  return challenges;
}

/** 本文を上限つきで読む（超えたら残りは読まずに捨てる）。 */
async function readLimited(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: "", bytes: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.length > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    bytes += value.length;
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, truncated };
}

function decodeBase64Json(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function survey(url: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { host: new URL(url).host, pathLength: new URL(url).pathname.length, hasQuery: new URL(url).search !== "" };
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  } catch (cause) {
    return { ...out, error: cause instanceof Error ? cause.name : "unknown" };
  }
  out["status"] = response.status;
  // media type だけ（パラメータは落とす）。決まった形でなければ出さない。
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  out["contentType"] = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(mediaType) ? mediaType : mediaType === "" ? null : "other";
  out["headerNames"] = [...response.headers.keys()].filter((name) => /payment|authenticate|x402|accept-payment|location/i.test(name)).sort();

  // x402 v2: PAYMENT-REQUIRED（base64 JSON）。
  const paymentRequired = response.headers.get("payment-required");
  if (paymentRequired !== null) {
    const decoded = decodeBase64Json(paymentRequired) as { accepts?: unknown[]; resource?: { url?: unknown } } | undefined;
    out["x402Header"] = { bytes: paymentRequired.length, shape: shapeOf(decoded) };
    out["x402ResourceUrlEqualsRequestUrl"] = decoded?.resource?.url === url;
    out["x402AcceptsCount"] = Array.isArray(decoded?.accepts) ? decoded.accepts.length : null;
  }
  // MPP: WWW-Authenticate: Payment …（複数の challenge・他の方式との併記もある）
  const authenticate = response.headers.get("www-authenticate");
  if (authenticate !== null) {
    const challenges = paymentChallengesOf(authenticate);
    out["mppChallengeCount"] = challenges.length;
    out["mppChallenges"] = challenges.map((entry) => {
      let normalized: unknown;
      try {
        normalized = shapeOf(Challenge.deserialize(entry.raw));
      } catch {
        normalized = "not deserializable by mppx";
      }
      return { bytes: entry.raw.length, wireParameterNames: entry.names, sdkNormalizedShape: normalized };
    });
  }
  // 本文（x402 v1 は本文に accepts を置く）。上限つきで読み、形だけ取り出す。
  try {
    const body = await readLimited(response, 262_144);
    out["bodyBytes"] = body.bytes;
    out["bodyTruncated"] = body.truncated;
    if (body.truncated) {
      out["bodyShape"] = "not parsed (truncated)";
    } else if (body.text !== "") {
      try {
        const parsed = JSON.parse(body.text) as { accepts?: unknown[] };
        out["bodyShape"] = shapeOf(parsed);
        if (Array.isArray(parsed.accepts)) out["bodyAcceptsCount"] = parsed.accepts.length;
      } catch {
        out["bodyShape"] = "not JSON";
      }
    }
  } catch {
    out["bodyError"] = true;
  }
  return out;
}

const urls = process.argv.slice(2).filter((arg) => /^https:\/\//.test(arg));
const results: Record<string, unknown>[] = [];
for (const url of urls) {
  results.push(await survey(url));
}
console.log(JSON.stringify({ at: new Date().toISOString(), count: results.length, results }, null, 1));
