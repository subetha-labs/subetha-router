/**
 * 設計の実測 M-3（`docs/dynamic-upstream-design.md` §3.3 (i)・§10、タスク T0-c）。**製品コードではない。**
 *
 * 問い: 実在の x402／MPP エンドポイントは、未払いの GET に対してどんな**欄**を返すか。
 * 許可する欄の一覧（動的経路の offer／challenge の検査）を、推測ではなく実物から決めるため。
 *
 * 各 URL に**支払いヘッダなしの GET を 1 回**送り、応答の**欄の名前と型だけ**を出す。値は、分類に要る
 * scheme・network・x402Version・method・intent 以外は出さない。本文は保存しない。リダイレクトは追わない。
 *
 * usage: npx tsx tools/dyn-challenge-survey.ts https://… [https://… ...]
 */
import { Challenge } from "mppx";

const SHOW_VALUES = new Set(["scheme", "network", "x402Version", "method", "intent", "chainId", "supportedModes"]);

/** 値を「型」に畳む。分類に要る欄だけ値を残す。 */
function shapeOf(value: unknown, key = ""): unknown {
  if (SHOW_VALUES.has(key) && (typeof value === "string" || typeof value === "number" || Array.isArray(value))) return value;
  // `accepts` は要素ごとに欄が違い得る（別の network・scheme を並べる）ので全部出す。他の配列は先頭だけ。
  if (Array.isArray(value)) return value.length === 0 ? [] : key === "accepts" ? value.map((entry) => shapeOf(entry)) : [shapeOf(value[0])];
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, shapeOf(v, k)]));
  }
  return value === null ? "null" : typeof value;
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
  out["contentType"] = response.headers.get("content-type");
  out["headerNames"] = [...response.headers.keys()].filter((name) => /payment|authenticate|x402|accept-payment|location/i.test(name)).sort();

  // x402 v2: PAYMENT-REQUIRED（base64 JSON）。
  const paymentRequired = response.headers.get("payment-required");
  if (paymentRequired !== null) {
    const decoded = decodeBase64Json(paymentRequired) as { accepts?: unknown[]; resource?: { url?: unknown } } | undefined;
    out["x402Header"] = { bytes: paymentRequired.length, shape: shapeOf(decoded) };
    out["x402ResourceUrlEqualsRequestUrl"] = decoded?.resource?.url === url;
    out["x402AcceptsCount"] = Array.isArray(decoded?.accepts) ? decoded.accepts.length : null;
  }
  // MPP: WWW-Authenticate: Payment …
  const authenticate = response.headers.get("www-authenticate");
  if (authenticate !== null) out["wwwAuthenticateScheme"] = authenticate.split(/\s/)[0];
  if (authenticate !== null && /^payment\s/i.test(authenticate)) {
    try {
      const challenge = Challenge.deserialize(authenticate) as Record<string, unknown>;
      out["mppChallenge"] = { bytes: authenticate.length, shape: shapeOf(challenge) };
    } catch {
      out["mppChallenge"] = { bytes: authenticate.length, error: "not deserializable by mppx" };
    }
  }
  // 本文（x402 v1 は本文に accepts を置く）。形だけ。
  let text = "";
  try {
    text = (await response.text()).slice(0, 262_144);
  } catch {
    out["bodyError"] = true;
  }
  out["bodyBytes"] = text.length;
  if (text !== "") {
    try {
      const body = JSON.parse(text) as { accepts?: unknown[]; resource?: unknown };
      out["bodyShape"] = shapeOf(body);
      if (Array.isArray(body.accepts)) out["bodyAcceptsCount"] = body.accepts.length;
    } catch {
      out["bodyShape"] = "not JSON";
    }
  }
  return out;
}

const urls = process.argv.slice(2).filter((arg) => /^https:\/\//.test(arg));
const results: Record<string, unknown>[] = [];
for (const url of urls) {
  results.push(await survey(url));
}
console.log(JSON.stringify({ at: new Date().toISOString(), count: results.length, results }, null, 1));
