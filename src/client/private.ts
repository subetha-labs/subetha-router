/**
 * 秘匿 quote の parser と束縛（`docs/zktls-router-design.md` §8.2）。既存の `quoteViewOf`／`bindingOf` は `upstream` の有無で動的の欄を読むので、秘匿 quote（`upstream` 無し）は
 * 専用の parser で読み、承認対象の**全欄**（`ownerKey` を含む）を束縛のスナップショットにする。どれか欠ければ quote として扱わない。
 */
import type { PrivateQuoteView } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const PRIVATE_KEYS = ["intentSha256", "orderId", "payerPk", "target", "method", "framing", "body", "outbound", "inbound", "policy", "limits", "disclosures"] as const;

export function privateQuoteViewOf(body: unknown): PrivateQuoteView | undefined {
  if (!isRecord(body)) return undefined;
  const quoteId = str(body, "quoteId");
  const paymentId = str(body, "paymentId");
  const routeId = str(body, "routeId");
  const ownerKey = str(body, "ownerKey");
  const resource = body["resource"];
  const source = body["source"];
  const destination = body["destination"];
  const pricing = body["pricing"];
  const disclosures = body["disclosures"];
  const priv = body["private"];
  const approval = body["approval"];
  if (quoteId === undefined || paymentId === undefined || routeId === undefined || ownerKey === undefined) return undefined;
  if (!isRecord(resource) || !isRecord(source) || !isRecord(destination) || !isRecord(pricing) || !isRecord(disclosures) || !isRecord(priv) || !isRecord(approval)) return undefined;
  const url = str(resource, "url");
  const method = str(resource, "method");
  const boundTo = str(approval, "boundTo");
  if (url === undefined || method === undefined || boundTo === undefined || typeof approval["deadlineMs"] !== "number") return undefined;
  if (!Object.hasOwn(source, "offer") || source["offer"] === undefined) return undefined;
  for (const key of PRIVATE_KEYS) {
    if (priv[key] === undefined) return undefined;
  }
  if (typeof priv["intentSha256"] !== "string" || typeof priv["orderId"] !== "string" || typeof priv["method"] !== "string" || typeof priv["framing"] !== "string") return undefined;
  return {
    quoteId,
    paymentId,
    routeId,
    resource: { url, method },
    source: source as PrivateQuoteView["source"],
    destination,
    pricing,
    disclosures,
    private: priv as PrivateQuoteView["private"],
    approval: { required: approval["required"] === true, boundTo, deadlineMs: approval["deadlineMs"] },
    ownerKey,
  };
}

/** キー順に依存しない安定 JSON。 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

/** 束縛のスナップショット: quote・payment・profile の同一性、資源、受信・送信の条件、価格、開示、承認、ownerKey、承認対象の全欄。 */
export function privateBindingOf(quote: PrivateQuoteView): string {
  return stableJson({
    quoteId: quote.quoteId,
    paymentId: quote.paymentId,
    routeId: quote.routeId,
    resource: quote.resource,
    source: quote.source,
    destination: quote.destination,
    pricing: quote.pricing,
    disclosures: quote.disclosures,
    private: quote.private,
    approval: quote.approval,
    ownerKey: quote.ownerKey,
  });
}
