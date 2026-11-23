/**
 * 合成の SubEtha v2 multi-tenant facilitator（`docs/subetha-exact-inbound-design.md` §7、タスク T-3）。**試験基盤であり製品ではない。**
 * 鍵・送金・chain は無い。tenant の面（`/p/:id/exact/*`）を protocol `68e061b` の source のとおりに模す（NFR-4）:
 * `apps/facilitator/src/exact-routes.ts`（route の status・本文・検査の順）、`apps/facilitator/src/multi/multi-routes.ts`（tenant の層: Bearer の 401／404、
 * 注文 id の 404 `unknown-order`、公開 verify の署名優先と固定本文、JSON の 64 KiB）、`packages/zerc20-v2-adapter/src/burn-sale-backend.ts`
 * （`exactOrdersFor` の再利用は額を見ない、`reserveExact` の 1 つの authorization の予約と拒否の code、`beginRelease` の 1 回性と 425、`completeRelease` の冪等と 409）、
 * `exact-settle.ts`（`requirementsFor` の `maxTimeoutSeconds = floor(ttl/2)`、`#locate` の `same`、`#settleOnce` の失敗の形）、`tenant-runtime.ts:222`
 * （tenant は `exactDelivery: "receipt"`: release は admitted な receipt だけで通り、注文の `state` は `accepted` のまま、release の `policy` は `exact-receipt`）。
 * Express の JSON の扱い（`application/json` のときだけ parse、strict で primitive は 400 `invalid_json`、`64kb` = 65 536 bytes を超えると 413 `too_large`）。
 *
 * 2 つの使い方: 同一 process（`createSubethaExactFacilitator` → `listen()`）と子 process（CLI 引数、`{"event":"listening",…}` の 1 行）。
 * モードは起動時の `--mode <route>=<mode>` と、試験中の `POST /_fixture/mode { route, mode, status?, headers?, body? }`。
 * 署名の検査は viem の `verifyTypedData`（offline。EOA の署名の復元だけ）。
 *
 * 2026-11-22（protocol `f30e4bb`、relay の廃止。`docs/subetha-exact-provider-settle-design.md`）: tenant の settle は**送らない**（未払いの正しい payload には
 * `broadcast-not-permitted`／`pending`）。`bind`（`exact-routes.ts` の bind、`exact-settle.ts` の `bindProviderSettled`）と `reconcile`（`reconcileOrder`）を足した。
 * 同じ server の `/xfac/settle` は **Provider が自分で選ぶ外部の x402 facilitator** の模型（Bearer なし）: 有効な署名なら合成の「chain」に載せる。
 * chain に載った authorization が注文に bind されたものと同じなら、その注文は `accepted` になる（bind されていなければ、reconcile は `no-intent`）。
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { getAddress, verifyTypedData, type Hex } from "viem";

export type FixtureRoute = "create" | "status" | "requesters" | "verify" | "settle" | "bind" | "submit" | "reconcile" | "release" | "complete";
export const FIXTURE_ROUTES: readonly FixtureRoute[] = ["create", "status", "requesters", "verify", "settle", "bind", "submit", "reconcile", "release", "complete"];
/** 外部の x402 facilitator の模型の path（tenant の外。Bearer なし）。 */
export const FIXTURE_EXTERNAL_FACILITATOR_PATH = "/xfac";
const defaultModeOf = (route: FixtureRoute): string => (route === "settle" || route === "submit" ? "accepted" : "ok");

export interface FacilitatorFixtureOptions {
  readonly providerId: string;
  readonly bearer: string;
  readonly chainId: number;
  readonly asset: string;
  readonly domainName: string;
  readonly domainVersion: string;
  /** 注文の TTL（秒）。`requirements.maxTimeoutSeconds = floor(ttl/2)`。 */
  readonly ttlSeconds?: number;
  readonly maxOrderAmount?: bigint;
  readonly modes?: Partial<Record<FixtureRoute, string>>;
  /** 秒の時計（既定は実時計）。 */
  readonly now?: () => number;
}

interface ExactIntentView {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  sigSha256: string;
  state: "reserved" | "signed" | "observed" | "paid" | "canceled" | "failed" | "relaying" | "relayed";
  origin: "facilitator" | "external-broadcast" | "facilitator-relay";
  txHash?: string;
  /** bind された注文の印（`exact.path`。消えない）。 */
  path?: "provider";
}

export interface FixtureOrder {
  orderId: string;
  saleId: string;
  amount: string;
  createdAt: number;
  expiresAt: number;
  state: "open" | "accepted" | "settled" | "expired" | "rejected" | "uncertain" | "settled-unknown" | "late-paid";
  binding: { requesterDigest: string; resourceDigest: string };
  exact?: ExactIntentView;
  evidence?: { txHash: string; blockNumber: number; logIndex: number; level: "mined" | "final" };
  release?: { deliveryKey: string; authorizedAt: number; txRef: string; eventId: string; mode: "exact-receipt"; completed?: { outcome: "delivered" | "failed"; at: number } };
  afterRelease?: "reorged" | "screening-rejected";
  closedReason?: string;
}

interface RawInjection {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FacilitatorFixture {
  readonly server: http.Server;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
  /** 内部の状態（試験の断言用）。 */
  readonly orders: Map<string, FixtureOrder>;
  readonly calls: { readonly byRoute: Record<string, number>; readonly byOrder: Record<string, Record<string, number>>; /** `Authorization` の付いた外部への送信の数（0 でなければ token が漏れている）。 */ submitWithAuthorization: number };
  setMode(route: FixtureRoute, mode: string, raw?: Omit<RawInjection, never>): void;
  /** 遅れた割当の完了（`busy-then-create` の後）。`createdAt`・`expiresAt` は試験が与える（adapter の時計に合わせる）。 */
  allocate(input: { requesterDigest: string; resourceDigest: string; amount?: string; createdAt?: number; expiresAt?: number }): FixtureOrder;
  readonly baseUrl: string | undefined;
}

const hex32 = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const lower = (s: string): string => s.toLowerCase();
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const FIXED_VERIFY = { isValid: false, invalidReason: "invalid_payment" };
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const MAX_BODY = 64 * 1024;

function pairKey(requesterDigest: string, resourceDigest: string): string {
  return `${lower(requesterDigest)}|${lower(resourceDigest)}`;
}

export function createSubethaExactFacilitator(options: FacilitatorFixtureOptions): FacilitatorFixture {
  const ttl = options.ttlSeconds ?? 300;
  const maxOrderAmount = options.maxOrderAmount ?? 1_000_000n;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const network = `eip155:${options.chainId}`;
  const asset = getAddress(options.asset);
  const domain = { name: options.domainName, version: options.domainVersion, chainId: options.chainId, verifyingContract: asset };
  const modes: Record<FixtureRoute, string> = { create: "ok", status: "ok", requesters: "ok", verify: "ok", settle: "accepted", bind: "ok", submit: "accepted", reconcile: "ok", release: "ok", complete: "ok", ...options.modes };
  const raw: Partial<Record<FixtureRoute, RawInjection>> = {};
  /** `-once` のモードの消費と `claimed-before`／`preset` の適用済みの印。 */
  const onceSpent = new Set<string>();
  const orders = new Map<string, FixtureOrder>();
  const pendingAllocations = new Map<string, { requesterDigest: string; resourceDigest: string; amount: string }>();
  const calls: { byRoute: Record<string, number>; byOrder: Record<string, Record<string, number>>; submitWithAuthorization: number } = { byRoute: {}, byOrder: {}, submitWithAuthorization: 0 };
  /** 合成の chain: 使われた authorization（`from|nonce` の小文字）→ 載せた transaction。 */
  const chainUsed = new Map<string, string>();
  const reconcileCalls = new Map<string, number>();
  let baseUrl: string | undefined;

  /** 経路ごとの回数（要求 1 つにつき 1 回）。注文が分かればその注文の回数も。 */
  const countOrder = (route: string, orderId: string): void => {
    const perOrder = (calls.byOrder[orderId] ??= {});
    perOrder[route] = (perOrder[route] ?? 0) + 1;
  };
  const count = (route: string, orderId?: string): void => {
    calls.byRoute[route] = (calls.byRoute[route] ?? 0) + 1;
    if (orderId !== undefined) countOrder(route, orderId);
  };

  const requirementsOf = (order: FixtureOrder): Record<string, unknown> => ({
    scheme: "exact",
    network,
    asset,
    amount: order.amount,
    payTo: getAddress(order.saleId),
    maxTimeoutSeconds: Math.max(1, Math.floor(ttl / 2)),
    extra: { name: options.domainName, version: options.domainVersion },
  });
  /** `paymentStatus` + `requirements` + `binding`（`exact-routes.ts` の `orderView`。`createdAt` は無い）。 */
  const orderView = (order: FixtureOrder): Record<string, unknown> => {
    const rel = order.release;
    return {
      orderId: order.orderId,
      status: {
        kind: "zerc20-v2-burn-sale",
        challengeNonce: order.orderId,
        saleId: order.saleId,
        token: asset,
        chainId: options.chainId,
        amount: order.amount,
        expiresAt: order.expiresAt,
        state: order.state,
        receipt: order.evidence === undefined ? { level: "none", tx: null } : { level: order.evidence.level, tx: { txHash: order.evidence.txHash, blockNumber: order.evidence.blockNumber, blockHash: `0x${"bb".repeat(32)}`, logs: [{ logIndex: order.evidence.logIndex, value: order.amount }], payer: order.exact?.from } },
        eligible: "none",
        coins: [],
        root: "none",
        intake: "unknown",
        release: {
          policy: rel?.mode ?? "finalized",
          state: rel === undefined ? "none" : rel.completed === undefined ? "authorized" : rel.completed.outcome,
          deliveryKey: order.orderId,
          ...(rel === undefined ? {} : { authorizedAt: rel.authorizedAt, txRef: rel.txRef, eventId: rel.eventId }),
          ...(rel?.completed === undefined ? {} : { completedAt: rel.completed.at }),
          ...(order.afterRelease === undefined ? {} : { afterRelease: order.afterRelease }),
        },
        ...(order.exact === undefined ? {} : { exact: { ...order.exact } }),
        gate: gateOf(order),
      },
      requirements: requirementsOf(order),
      binding: { ...order.binding },
    };
  };
  /** `burn-sale-backend.ts` の `#gateOf`（receipt mode）。 */
  const gateOf = (order: FixtureOrder): string => {
    const rel = order.release;
    if (rel?.completed !== undefined) return rel.completed.outcome;
    if (rel !== undefined) return "claimed";
    if (order.state === "late-paid") return "late-paid";
    if (order.state === "uncertain" || order.state === "settled-unknown") return "operator-review";
    if (order.state === "rejected" || (order.state === "expired" && order.exact === undefined)) return "closed";
    if ((order.state === "accepted" || order.state === "settled") && order.exact !== undefined && order.evidence !== undefined && order.afterRelease === undefined) return "ready";
    if (order.state === "accepted" || order.state === "settled") return "awaiting-finality";
    return "awaiting-payment";
  };
  const unresolvedFor = (requesterDigest: string, resourceDigest: string): FixtureOrder[] =>
    [...orders.values()].filter((o) => pairKey(o.binding.requesterDigest, o.binding.resourceDigest) === pairKey(requesterDigest, resourceDigest) && o.closedReason === undefined && o.release?.completed === undefined);
  const createOrder = (input: { requesterDigest: string; resourceDigest: string; amount: string; createdAt?: number; expiresAt?: number }): FixtureOrder => {
    const createdAt = input.createdAt ?? now();
    const order: FixtureOrder = {
      orderId: `0x${randomBytes(32).toString("hex")}`,
      saleId: getAddress(`0x${randomBytes(20).toString("hex")}`),
      amount: input.amount,
      createdAt,
      expiresAt: input.expiresAt ?? createdAt + ttl,
      state: "open",
      binding: { requesterDigest: input.requesterDigest, resourceDigest: input.resourceDigest },
    };
    orders.set(order.orderId, order);
    return order;
  };
  const corrupt = (view: Record<string, unknown>, field: string): Record<string, unknown> => {
    const copy = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
    const status = copy["status"] as Record<string, unknown>;
    const release = status["release"] as Record<string, unknown>;
    const binding = copy["binding"] as Record<string, unknown>;
    switch (field) {
      case "binding.requesterDigest": binding["requesterDigest"] = `0x${"77".repeat(32)}`; break;
      case "binding.resourceDigest": binding["resourceDigest"] = `0x${"77".repeat(32)}`; break;
      case "release.deliveryKey": release["deliveryKey"] = `0x${"77".repeat(32)}`; break;
      case "release.txRef": release["txRef"] = `0x${"77".repeat(32)}`; break;
      case "release.eventId": release["eventId"] = "not-an-event-id"; break;
      case "release.state": release["state"] = "none"; break;
      case "state": status["state"] = "rejected"; break;
      default: throw new Error(`unknown corrupt field: ${field}`);
    }
    return copy;
  };

  async function validlySigned(payload: unknown): Promise<{ ok: true; authorization: Record<string, string>; signature: string } | { ok: false }> {
    const p = (payload as { payload?: { authorization?: Record<string, unknown>; signature?: unknown } } | undefined)?.payload;
    const a = p?.authorization;
    const sig = p?.signature;
    if (!a || typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) return { ok: false };
    try {
      for (const k of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) if (typeof a[k] !== "string") return { ok: false };
      if (!hex32(a["nonce"])) return { ok: false };
      const ok = await verifyTypedData({
        address: getAddress(a["from"] as string),
        signature: sig as Hex,
        primaryType: "TransferWithAuthorization",
        types: AUTHORIZATION_TYPES,
        domain,
        message: { from: getAddress(a["from"] as string), to: getAddress(a["to"] as string), value: BigInt(a["value"] as string), validAfter: BigInt(a["validAfter"] as string), validBefore: BigInt(a["validBefore"] as string), nonce: a["nonce"] as Hex },
      });
      return ok ? { ok: true, authorization: a as Record<string, string>, signature: sig } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  /** `exact-settle.ts` の `#locate` の `same`: 要求の accepted が台帳の requirements と一致するか。 */
  const sameRequirements = (r: unknown, order: FixtureOrder): boolean => {
    if (typeof r !== "object" || r === null) return false;
    const x = r as Record<string, unknown>;
    const extra = (x["extra"] ?? {}) as Record<string, unknown>;
    return x["scheme"] === "exact" && x["network"] === network && lower(String(x["asset"])) === lower(asset) && String(x["amount"]) === order.amount && lower(String(x["payTo"])) === lower(order.saleId) && x["maxTimeoutSeconds"] === Math.max(1, Math.floor(ttl / 2)) && extra["name"] === options.domainName && extra["version"] === options.domainVersion;
  };

  const isJsonType = (contentType: string | undefined): boolean => contentType !== undefined && /^application\/json(\s*;.*)?$/i.test(contentType);
  /** Express の `express.json({ limit: "64kb" })`: 上限は JSON の content-type のときだけ（他の型は読まずに捨てる）。 */
  const readBody = (req: http.IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; status: number; body: Record<string, unknown> }> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const json = isJsonType(req.headers["content-type"]);
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (json && size <= MAX_BODY) chunks.push(chunk);
      });
      req.on("end", () => {
        if (json && size > MAX_BODY) resolve({ ok: false, status: 413, body: { error: "too_large" } });
        else resolve({ ok: true, text: json ? Buffer.concat(chunks).toString("utf8") : "" });
      });
      req.on("error", () => resolve({ ok: false, status: 400, body: { error: "invalid_json" } }));
    });
  /** Express の `express.json()`: `application/json` 以外は parse せず `{}`、空も `{}`、strict で object／array 以外は 400 `invalid_json`。 */
  const parseJson = (text: string, contentType: string | undefined): { ok: true; value: unknown } | { ok: false } => {
    if (contentType === undefined || !/^application\/json(\s*;.*)?$/i.test(contentType)) return { ok: true, value: {} };
    if (text === "") return { ok: true, value: {} };
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null ? { ok: true, value } : { ok: false };
    } catch {
      return { ok: false };
    }
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.destroy();
    });
  });
  const sendJson = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  };
  /** 任意の注入（`raw`・`huge-body`・`redirect`・`stall-body`・`unreadable`）: 当たれば応答して true。 */
  const injected = (route: FixtureRoute, res: http.ServerResponse): boolean => {
    const mode = modes[route];
    const injection = raw[route];
    if (mode === "raw" && injection !== undefined) {
      modes[route] = defaultModeOf(route);
      delete raw[route];
      res.writeHead(injection.status, injection.headers);
      res.end(injection.body);
      return true;
    }
    if (mode === "huge-body") {
      sendJson(res, 200, { pad: "x".repeat(70 * 1024) });
      return true;
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" });
      res.end();
      return true;
    }
    if (mode === "stall-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      // 本文を止めたまま（socket は開いたまま）。呼び出し側の期限で終わる。
      return true;
    }
    if (mode === "unreadable") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not json");
      return true;
    }
    return false;
  };
  /** `-once` のモード: 1 回だけ当たる。 */
  const once = (route: FixtureRoute, mode: string): boolean => {
    if (modes[route] !== mode) return false;
    modes[route] = defaultModeOf(route);
    return true;
  };
  const bearerOk = (req: http.IncomingMessage): boolean => req.headers.authorization === `Bearer ${options.bearer}`;
  const delayOf = (route: FixtureRoute): number => (modes[route].startsWith("slow:") ? Number(modes[route].slice(5)) : 0);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fixture");
    const method = req.method ?? "GET";
    // ---- 試験の操作・観測 ----
    if (url.pathname.startsWith("/_fixture/")) {
      const body = await readBody(req);
      if (!body.ok) return sendJson(res, body.status, body.body);
      const parsed = parseJson(body.text, req.headers["content-type"]);
      if (!parsed.ok) return sendJson(res, 400, { error: "invalid_json" });
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      if (method === "GET" && url.pathname === "/_fixture/calls") return sendJson(res, 200, calls);
      if (method === "GET" && url.pathname.startsWith("/_fixture/orders/")) {
        const order = orders.get(url.pathname.slice("/_fixture/orders/".length));
        return order === undefined ? sendJson(res, 404, { error: "unknown" }) : sendJson(res, 200, order);
      }
      if (method === "POST" && url.pathname === "/_fixture/mode") {
        const route = input["route"];
        const mode = input["mode"];
        if (typeof route !== "string" || !(FIXTURE_ROUTES as readonly string[]).includes(route) || typeof mode !== "string") return sendJson(res, 400, { error: "expect { route, mode }" });
        fixture.setMode(route as FixtureRoute, mode, mode === "raw" ? { status: Number(input["status"] ?? 200), headers: (input["headers"] as Record<string, string> | undefined) ?? {}, body: typeof input["body"] === "string" ? input["body"] : JSON.stringify(input["body"] ?? {}) } : undefined);
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/_fixture/allocate") {
        if (!hex32(input["requesterDigest"]) || !hex32(input["resourceDigest"])) return sendJson(res, 400, { error: "expect digests" });
        const order = fixture.allocate({ requesterDigest: input["requesterDigest"], resourceDigest: input["resourceDigest"], ...(typeof input["amount"] === "string" ? { amount: input["amount"] } : {}), ...(typeof input["createdAt"] === "number" ? { createdAt: input["createdAt"] } : {}), ...(typeof input["expiresAt"] === "number" ? { expiresAt: input["expiresAt"] } : {}) });
        return sendJson(res, 201, orderView(order));
      }
      const paid = /^\/_fixture\/orders\/(0x[0-9a-fA-F]{64})\/paid-external$/.exec(url.pathname);
      if (method === "POST" && paid !== null) {
        const order = orders.get(paid[1]!);
        if (order === undefined) return sendJson(res, 404, { error: "unknown" });
        markAccepted(order, { from: typeof input["from"] === "string" ? input["from"] : `0x${"ee".repeat(20)}`, origin: "external-broadcast" });
        return sendJson(res, 200, orderView(order));
      }
      return sendJson(res, 404, { error: "unknown-route" });
    }
    // ---- tenant の面 ----
    if (url.pathname.startsWith(`${FIXTURE_EXTERNAL_FACILITATOR_PATH}/`)) {
      const body = await readBody(req);
      if (!body.ok) return sendJson(res, body.status, body.body);
      const parsed = parseJson(body.text, req.headers["content-type"]);
      if (!parsed.ok) return sendJson(res, 400, { error: "invalid_json" });
      if (method === "POST" && url.pathname === `${FIXTURE_EXTERNAL_FACILITATOR_PATH}/settle`) return submit(req, (parsed.value ?? {}) as Record<string, unknown>, res);
      return sendJson(res, 404, { error: "unknown-route" });
    }
    const tenant = /^\/p\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
    if (tenant === null) return sendJson(res, 404, { error: "unknown-route" });
    const knownTenant = tenant[1] === options.providerId;
    const rest = tenant[2] ?? "";
    const body = await readBody(req);
    if (!body.ok) return sendJson(res, body.status, body.body);
    const parsed = parseJson(body.text, req.headers["content-type"]);
    if (!parsed.ok) return sendJson(res, 400, { error: "invalid_json" });
    const input = (parsed.value ?? {}) as Record<string, unknown>;

    // 公開 verify（署名が先。tenant が無くても固定本文）。
    if (method === "POST" && rest === "/exact/verify") {
      count("verify");
      if (injected("verify", res)) return;
      await sleep(delayOf("verify"));
      const payload = input["paymentPayload"];
      if (typeof payload !== "object" || payload === null) return sendJson(res, 400, { isValid: false, invalidReason: "invalid_request" });
      const signed = await validlySigned(payload);
      if (!signed.ok || !knownTenant) return sendJson(res, 200, FIXED_VERIFY);
      const order = [...orders.values()].find((o) => lower(o.saleId) === lower(signed.authorization["to"] ?? ""));
      if (order === undefined) return sendJson(res, 200, FIXED_VERIFY);
      countOrder("verify", order.orderId);
      const clientReq = input["paymentRequirements"];
      if ((clientReq !== undefined && !sameRequirements(clientReq, order)) || !sameRequirements((payload as Record<string, unknown>)["accepted"], order)) return sendJson(res, 200, FIXED_VERIFY);
      if (modes["verify"] === "invalid") return sendJson(res, 200, { isValid: false, invalidReason: "insufficient_funds", payer: signed.authorization["from"] });
      const a = signed.authorization;
      const t = now();
      if (BigInt(a["validBefore"]!) < BigInt(t + 6)) return sendJson(res, 200, { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_before", payer: a["from"] });
      if (BigInt(a["validAfter"]!) > BigInt(t)) return sendJson(res, 200, { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_after", payer: a["from"] });
      if (a["value"] !== order.amount) return sendJson(res, 200, { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_value", payer: a["from"] });
      // 実 verify は注文の状態・予約を見ない（`exact-settle.ts:257-269`。予約の検査は settle の側）。
      return sendJson(res, 200, { isValid: true, payer: a["from"] });
    }
    if (!rest.startsWith("/exact/")) return sendJson(res, 404, { error: "unknown-route" });
    // Bearer の層（`multi-routes.ts`）: 知らない tenant は 404、token 違いは 401。
    if (!knownTenant) return sendJson(res, 404, { error: "unknown" });
    if (!bearerOk(req)) return sendJson(res, 401, { error: "unauthorized" });
    // tenant の層（`multi-routes.ts`）: この tenant に無い hex64 の注文 id は、`/orders/<id>` のどの route でも 1 つの固定の答え。
    const guarded = /^\/exact\/orders\/(0x[0-9a-fA-F]{64})(?:[/?]|$)/.exec(rest);
    if (guarded !== null && !orders.has(guarded[1]!)) return sendJson(res, 404, { error: "unknown-order" });
    const orderRoute = /^\/exact\/orders\/([^/]+)(\/(settle|bind|release|complete|reconcile))?$/.exec(rest);
    if (orderRoute !== null) {
      const id = orderRoute[1]!;
      const op = orderRoute[3];
      // 壊れた id は handler の 400（`exact-routes.ts` の `hex32` の検査）。
      if (!hex32(id)) {
        if (op === undefined && method === "GET") return sendJson(res, 400, { error: "malformed order id" });
        if ((op === "settle" || op === "bind") && method === "POST") return sendJson(res, 400, { error: "expect { paymentPayload, requesterDigest, resourceDigest }" });
        if (op === "release" && method === "POST") return sendJson(res, 400, { error: "expect { requesterDigest }" });
        if (op === "complete" && method === "POST") return sendJson(res, 400, { error: "expect { deliveryKey, outcome: 'delivered' | 'failed' }" });
        if (op === "reconcile" && method === "POST") return sendJson(res, 400, { error: "malformed order id" });
        return sendJson(res, 404, { error: "unknown-route" });
      }
      const order = orders.get(id)!;
      if (op === undefined && method === "GET") return status(order, res);
      if (op === "settle" && method === "POST") return settle(order, input, res);
      if (op === "bind" && method === "POST") return bind(order, input, res);
      if (op === "reconcile" && method === "POST") return reconcileRoute(order, res);
      if (op === "release" && method === "POST") return release(order, input, res);
      if (op === "complete" && method === "POST") return complete(order, input, res);
      return sendJson(res, 404, { error: "unknown-route" });
    }
    if (method === "POST" && rest === "/exact/orders") return create(input, res);
    const requesters = /^\/exact\/requesters\/([^/]+)\/orders$/.exec(rest);
    if (method === "GET" && requesters !== null) {
      count("requesters");
      if (injected("requesters", res)) return;
      const resourceDigest = url.searchParams.get("resourceDigest");
      if (!hex32(requesters[1]) || !hex32(resourceDigest)) return sendJson(res, 400, { error: "expect requester and resource digests" });
      if (modes["requesters"] === "error") return sendJson(res, 500, { error: "internal" });
      if (modes["requesters"] === "rate-limited") return sendJson(res, 429, { error: "rate-limited" }, { "retry-after": "1" });
      if (modes["requesters"] === "empty") return sendJson(res, 200, { orders: [] });
      return sendJson(res, 200, { orders: unresolvedFor(requesters[1]!, resourceDigest).map(orderView) });
    }
    return sendJson(res, 404, { error: "unknown-route" });
  }

  function markAccepted(order: FixtureOrder, input: { from: string; origin: ExactIntentView["origin"]; authorization?: Record<string, string>; signature?: string; state?: FixtureOrder["state"]; txHash?: string }): void {
    const txHash = input.txHash ?? `0x${randomBytes(32).toString("hex")}`;
    const a = input.authorization;
    const path = order.exact?.path;
    order.state = input.state ?? "accepted";
    order.exact = {
      from: getAddress(input.from),
      to: getAddress(order.saleId),
      value: a?.["value"] ?? order.amount,
      validAfter: a?.["validAfter"] ?? "0",
      validBefore: a?.["validBefore"] ?? String(order.expiresAt),
      nonce: (a?.["nonce"] ?? order.orderId).toLowerCase(),
      sigSha256: sha256(input.signature?.toLowerCase() ?? "external"),
      state: "paid",
      origin: input.origin,
      txHash,
      ...(path === undefined ? {} : { path }),
    };
    order.evidence = { txHash, blockNumber: 1000 + orders.size, logIndex: 0, level: "final" };
  }

  async function create(input: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    count("create");
    if (injected("create", res)) return;
    await sleep(delayOf("create"));
    const amount = input["amount"];
    if (!hex32(input["resourceDigest"]) || !hex32(input["requesterDigest"]) || typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
      return sendJson(res, 400, { error: "expect { amount: atomic string, resourceDigest: 0x32B, requesterDigest: 0x32B }" });
    }
    if (BigInt(amount) > maxOrderAmount || BigInt(amount) === 0n) return sendJson(res, 403, { error: "amount not allowed by the run policy", maxOrderAmount: maxOrderAmount.toString() });
    const normalizedAmount = BigInt(amount).toString();
    const requesterDigest = input["requesterDigest"];
    const resourceDigest = input["resourceDigest"];
    const mode = modes["create"];
    if (mode === "busy" || mode === "busy-then-create") {
      if (mode === "busy-then-create") pendingAllocations.set(pairKey(requesterDigest, resourceDigest), { requesterDigest, resourceDigest, amount });
      return sendJson(res, 503, { error: "order-creation-busy" }, { "retry-after": "30" });
    }
    if (mode === "paused") return sendJson(res, 503, { error: "order-creation-paused" }, { "retry-after": "30" });
    if (mode === "rate-limited") return sendJson(res, 429, { error: "rate-limited" }, { "retry-after": "2" });
    // 再利用（`exactOrdersFor`）: 同じ (requester, resource) の未解決の注文は額を見ずに返す。
    const open = unresolvedFor(requesterDigest, resourceDigest);
    if (open.length > 0) {
      const existing = open[0]!;
      countOrder("create", existing.orderId);
      let view = orderView(existing);
      if (mode === "existing-mismatch:amount") view = { ...view, requirements: { ...(view["requirements"] as Record<string, unknown>), amount: String(BigInt(existing.amount) + 1n) } };
      if (mode === "existing-mismatch:id") view = { ...view, orderId: `0x${"ab".repeat(32)}` };
      if (mode === "existing-mismatch:expired") view = { ...view, status: { ...(view["status"] as Record<string, unknown>), expiresAt: now() - 1 } };
      return sendJson(res, 200, { existing: true, ...view });
    }
    const order = createOrder({ requesterDigest, resourceDigest, amount: normalizedAmount });
    countOrder("create", order.orderId);
    if (mode === "lose-response") {
      res.destroy();
      return;
    }
    return sendJson(res, 201, { existing: false, ...orderView(order) });
  }

  function status(order: FixtureOrder, res: http.ServerResponse): void {
    count("status", order.orderId);
    if (injected("status", res)) return;
    const mode = modes["status"];
    if (mode === "error") return sendJson(res, 500, { error: "internal" });
    if (mode === "rate-limited") return sendJson(res, 429, { error: "rate-limited" }, { "retry-after": "1" });
    if (mode === "after-release:reorged") {
      order.afterRelease = "reorged";
      return sendJson(res, 200, orderView(order));
    }
    if (mode.startsWith("corrupt:")) return sendJson(res, 200, corrupt(orderView(order), mode.slice("corrupt:".length)));
    return sendJson(res, 200, orderView(order));
  }

  async function settle(order: FixtureOrder, input: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    count("settle", order.orderId);
    if (injected("settle", res)) return;
    const payload = input["paymentPayload"];
    if (!hex32(input["requesterDigest"]) || !hex32(input["resourceDigest"]) || typeof payload !== "object" || payload === null) return sendJson(res, 400, { error: "expect { paymentPayload, requesterDigest, resourceDigest }" });
    if (lower(order.binding.requesterDigest) !== lower(input["requesterDigest"]) || lower(order.binding.resourceDigest) !== lower(input["resourceDigest"])) return sendJson(res, 403, { error: "order is bound to another requester or resource" });
    const payTo = lower(String((payload as { payload?: { authorization?: { to?: string } } }).payload?.authorization?.to ?? ""));
    if (payTo !== lower(order.saleId)) return sendJson(res, 409, { error: "payload pays another order" });
    const mode = modes["settle"];
    if (mode === "timeout") return;
    if (mode === "error") return sendJson(res, 500, { error: "internal" });
    const withOrder = (r: Record<string, unknown>): Record<string, unknown> => ({ ...r, order: orderView(order) });
    /** `#settleOnce` の `fail`: locate の失敗は `orderId`・`payer` 無し、それ以降は `orderId`（と payer）付き。 */
    const fail = (errorReason: string, outcome = "rejected", extra: Record<string, unknown> = {}): Record<string, unknown> => withOrder({ success: false, errorReason, transaction: "", network, outcome, ...extra });
    // `#locate`: 形 → payTo の注文 → `same`（clientReq があればそれも）。失敗は code そのまま、orderId 無し。
    const p = (payload as { payload?: { authorization?: Record<string, unknown>; signature?: unknown } }).payload;
    const a = p?.authorization;
    if (!a || typeof p?.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(p.signature)) return sendJson(res, 200, fail("not-an-eip3009-payload"));
    for (const k of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) if (typeof a[k] !== "string") return sendJson(res, 200, fail("malformed-authorization"));
    const clientReq = input["paymentRequirements"];
    if (clientReq !== undefined && !sameRequirements(clientReq, order)) return sendJson(res, 200, fail("requirements-mismatch"));
    if (!sameRequirements((payload as Record<string, unknown>)["accepted"], order)) return sendJson(res, 200, fail("accepted-requirements-mismatch"));
    const from = getAddress(a["from"] as string);
    const located = { orderId: order.orderId, payer: from };
    if (mode.startsWith("rejected:")) return sendJson(res, 200, fail(mode.slice("rejected:".length), "rejected", located));
    const sigHash = typeof p.signature === "string" ? sha256(p.signature.toLowerCase()) : "";
    /** `reserveExact` の `sameAuth`: 全欄 + 署名の hash。 */
    const sameAuth = (): boolean => order.exact !== undefined && ["from", "to", "value", "validAfter", "validBefore", "nonce"].every((k) => lower(String((order.exact as unknown as Record<string, unknown>)[k])) === lower(String(a[k]))) && order.exact.sigSha256 === sigHash;
    /** `reconcilePayload` の同一性: 既に結び付いた注文は `from` + `nonce` で引く（`exact-settle.ts:601-606`）。 */
    const sameIdentity = (): boolean => order.exact !== undefined && lower(order.exact.from) === lower(String(a["from"])) && lower(order.exact.nonce) === lower(String(a["nonce"]));
    /** `reconcilePayload`／`reconcileOrder` 相当: 既に記録のある同じ authorization は、その状態をそのまま返す（同じ tx）。 */
    const reconcile = (): Record<string, unknown> => {
      const exact = order.exact!;
      if (order.state === "accepted" || order.state === "settled") return withOrder({ success: true, transaction: exact.txHash, network, payer: exact.from, outcome: "accepted", orderId: order.orderId });
      if (order.state === "late-paid") return withOrder({ success: false, errorReason: "late-paid", transaction: exact.txHash, network, payer: exact.from, outcome: "late-paid", orderId: order.orderId });
      return withOrder({ success: false, errorReason: "settlement_pending", transaction: exact.txHash ?? "", network, payer: exact.from, outcome: "pending", orderId: order.orderId });
    };
    // `verify`（SDK 相当）が落ちた後は `reconcilePayload`（`exact-settle.ts:310-318`）: 既に払われた同じ authorization は accepted、未使用の有効な署名は observed のまま pending。
    const signed = await validlySigned(payload);
    if (!signed.ok) return sendJson(res, 200, sameIdentity() ? reconcile() : fail("invalid-signature", "rejected", located));
    const t = now();
    const sdkReason = BigInt(a["validBefore"] as string) < BigInt(t + 6) ? "invalid_exact_evm_payload_authorization_valid_before" : BigInt(a["validAfter"] as string) > BigInt(t) ? "invalid_exact_evm_payload_authorization_valid_after" : a["value"] !== order.amount ? "invalid_exact_evm_payload_authorization_value" : undefined;
    const auth = { from, to: getAddress(a["to"] as string), value: a["value"] as string, validAfter: a["validAfter"] as string, validBefore: a["validBefore"] as string, nonce: (a["nonce"] as string).toLowerCase(), sigSha256: sigHash };
    if (sdkReason !== undefined) {
      if (sameIdentity()) return sendJson(res, 200, reconcile());
      if (order.exact !== undefined) return sendJson(res, 200, fail("conflicting-authorization", "rejected", { orderId: order.orderId }));
      // `admitObserved` 相当: 注文に合わない authorization（額・受取先）は記録せず rejected、合う未使用の署名は observed のまま（送らない）。
      // 結果は reconcile の `settlement_pending`（SDK の理由ではない。`exact-settle.ts:455-457, 628-631`）。
      if (lower(auth.to) !== lower(order.saleId) || auth.value !== order.amount) return sendJson(res, 200, fail("authorization-does-not-match-order", "rejected", located));
      if (order.state !== "open" && order.state !== "expired") return sendJson(res, 200, fail("order-not-open", "rejected", located));
      order.exact = { ...auth, state: "observed", origin: "external-broadcast" };
      void sdkReason;
      return sendJson(res, 200, fail("settlement_pending", "pending", located));
    }
    // 送らない（`canBroadcast` は false）: 記録のある同じ authorization は reconcile、違うものは `conflicting-authorization`、未払いの正しい payload は
    // `broadcast-not-permitted`／`pending`（`exact-settle.ts:286`）。
    if (order.exact !== undefined) return sendJson(res, 200, sameAuth() ? reconcile() : fail("conflicting-authorization", "rejected", { orderId: order.orderId }));
    if (order.state !== "open") return sendJson(res, 200, fail("order-not-open", "rejected", { orderId: order.orderId }));
    if (t > order.expiresAt) return sendJson(res, 200, fail("order-expired", "rejected", { orderId: order.orderId }));
    if (lower(auth.to) !== lower(order.saleId)) return sendJson(res, 200, fail("recipient-mismatch", "rejected", { orderId: order.orderId }));
    if (auth.value !== order.amount) return sendJson(res, 200, fail("amount-mismatch", "rejected", { orderId: order.orderId }));
    return sendJson(res, 200, fail("broadcast-not-permitted", "pending", located));
  }

  const usedKey = (from: string, nonce: string): string => `${lower(from)}|${lower(nonce)}`;
  /** chain に載った使用を、bind された同じ authorization の注文に反映する（`reconcileOrder` の `admitExact`）。 */
  const admitFromChain = (order: FixtureOrder): void => {
    const exact = order.exact;
    if (exact === undefined || exact.state === "paid") return;
    const txHash = chainUsed.get(usedKey(exact.from, exact.nonce));
    if (txHash === undefined) return;
    const late = now() > order.expiresAt || modes["submit"] === "late-paid";
    order.state = late ? "late-paid" : "accepted";
    order.exact = { ...exact, state: "paid", origin: "external-broadcast", txHash };
    order.evidence = { txHash, blockNumber: 1000 + orders.size, logIndex: 0, level: "final" };
  };

  /** `POST /exact/orders/:id/bind`（`exact-routes.ts` の bind、`bindProviderSettled`）。送らない。 */
  async function bind(order: FixtureOrder, input: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    count("bind", order.orderId);
    if (injected("bind", res)) return;
    await sleep(delayOf("bind"));
    const payload = input["paymentPayload"];
    if (!hex32(input["requesterDigest"]) || !hex32(input["resourceDigest"]) || typeof payload !== "object" || payload === null) return sendJson(res, 400, { error: "expect { paymentPayload, requesterDigest, resourceDigest }" });
    if (lower(order.binding.requesterDigest) !== lower(input["requesterDigest"]) || lower(order.binding.resourceDigest) !== lower(input["resourceDigest"])) return sendJson(res, 403, { error: "order is bound to another requester or resource" });
    const payTo = lower(String((payload as { payload?: { authorization?: { to?: string } } }).payload?.authorization?.to ?? ""));
    if (payTo !== lower(order.saleId)) return sendJson(res, 409, { error: "payload pays another order" });
    const mode = modes["bind"];
    if (mode === "timeout") return;
    if (mode === "error") return sendJson(res, 500, { error: "internal" });
    if (mode === "busy") return sendJson(res, 503, { error: "upstream-busy" }, { "retry-after": "1" });
    if (mode === "missing") return sendJson(res, 404, { error: "unknown-route" });
    if (mode.startsWith("refused:")) return sendJson(res, 409, { error: mode.slice("refused:".length) });
    const signed = await validlySigned(payload);
    if (!signed.ok) return sendJson(res, 409, { error: "invalid-signature" });
    const a = signed.authorization;
    const auth = { from: getAddress(a["from"]!), to: getAddress(a["to"]!), value: a["value"]!, validAfter: a["validAfter"]!, validBefore: a["validBefore"]!, nonce: a["nonce"]!.toLowerCase(), sigSha256: sha256(signed.signature.toLowerCase()) };
    const identityOf = (): Record<string, unknown> => ({ from: order.exact!.from, nonce: order.exact!.nonce, sigSha256: order.exact!.sigSha256 });
    // 試験の準備: bind の前に、同じ authorization が chain に載っていた（先回りした第三者の送信）。
    if (mode === "already-used-paid" && order.exact === undefined) chainUsed.set(usedKey(auth.from, auth.nonce), `0x${randomBytes(32).toString("hex")}`);
    if (mode === "already-used") return sendJson(res, 200, { ack: "already-used", recorded: false, outcome: "pending" });
    // 試験の準備: 同じ authorization を別の送信者が chain に載せていた。bind の答えは「まだ記録していない」か拒否で、reconcile が後から受け入れる。
    if ((mode === "already-used-then-paid" || mode === "refused-then-paid") && order.exact === undefined) {
      order.exact = { ...auth, state: "observed", origin: "external-broadcast", path: "provider" };
      chainUsed.set(usedKey(auth.from, auth.nonce), `0x${randomBytes(32).toString("hex")}`);
      return mode === "refused-then-paid" ? sendJson(res, 409, { error: "order-not-open" }) : sendJson(res, 200, { ack: "already-used", recorded: false, outcome: "pending" });
    }
    if (order.exact !== undefined) {
      const same = ["from", "to", "value", "validAfter", "validBefore", "nonce"].every((k) => lower(String((order.exact as unknown as Record<string, unknown>)[k])) === lower(String((auth as unknown as Record<string, unknown>)[k]))) && order.exact.sigSha256 === auth.sigSha256;
      if (!same) return sendJson(res, 409, { error: "conflicting-authorization" });
      if (order.exact.path !== "provider") return sendJson(res, 409, { error: "order-on-other-path" });
      // 同じ authorization の bind の繰り返しは ledger だけで答える（chain を読まない。`exact-settle.ts:590`）。
      if (order.exact.state === "paid") return sendJson(res, 200, { ack: "already-used", recorded: true, outcome: order.state === "late-paid" ? "late-paid" : "accepted", txHash: order.exact.txHash, identity: identityOf() });
    } else {
      if (order.state !== "open") return sendJson(res, 409, { error: "order-not-open" });
      if (now() > order.expiresAt) return sendJson(res, 409, { error: "order-expired" });
      if (auth.value !== order.amount) return sendJson(res, 409, { error: "amount-mismatch" });
      if (BigInt(auth.validBefore) > BigInt(order.expiresAt)) return sendJson(res, 409, { error: "valid-before-after-order-expiry" });
      order.exact = { ...auth, state: "observed", origin: "external-broadcast", path: "provider" };
      admitFromChain(order);
      if (order.exact.state === "paid") return sendJson(res, 200, { ack: "already-used", recorded: true, outcome: "accepted", txHash: order.exact.txHash, identity: identityOf() });
    }
    if (mode === "no-identity") return sendJson(res, 200, { ack: "bound" });
    if (mode === "identity-mismatch") return sendJson(res, 200, { ack: "bound", identity: { ...identityOf(), nonce: `0x${"77".repeat(32)}` } });
    if (mode === "lose-response") {
      res.destroy();
      return;
    }
    return sendJson(res, 200, { ack: "bound", identity: identityOf() });
  }

  /** `POST /exact/orders/:id/reconcile`（`reconcileOrder`）。送らない。 */
  async function reconcileRoute(order: FixtureOrder, res: http.ServerResponse): Promise<void> {
    count("reconcile", order.orderId);
    if (injected("reconcile", res)) return;
    await sleep(delayOf("reconcile"));
    const mode = modes["reconcile"];
    if (mode === "timeout") return;
    if (mode === "error") return sendJson(res, 500, { error: "internal" });
    const seen = (reconcileCalls.get(order.orderId) ?? 0) + 1;
    reconcileCalls.set(order.orderId, seen);
    const view = (): Record<string, unknown> => orderView(order);
    if (order.exact === undefined) return sendJson(res, 200, { outcome: "rejected", reason: "no-intent", order: view() });
    // chain の遅れ: 最初の n 回は、載っていてもまだ見えない。
    if (mode.startsWith("pending-first:") && seen <= Number(mode.slice("pending-first:".length))) return sendJson(res, 200, { outcome: "pending", order: view() });
    admitFromChain(order);
    const txHash = order.exact.txHash;
    if (order.state === "accepted" || order.state === "settled") {
      if (mode === "bad-tx") return sendJson(res, 200, { outcome: "accepted", txHash: "0x1234", order: view() });
      if (mode === "no-order") return sendJson(res, 200, { outcome: "accepted", txHash });
      if (mode === "wrong-identity") {
        const altered = JSON.parse(JSON.stringify(view())) as { status: { exact: { nonce: string } } };
        altered.status.exact.nonce = `0x${"77".repeat(32)}`;
        return sendJson(res, 200, { outcome: "accepted", txHash, order: altered });
      }
      return sendJson(res, 200, { outcome: "accepted", txHash, order: view() });
    }
    if (order.state === "late-paid") return sendJson(res, 200, { outcome: "late-paid", txHash, order: view() });
    if (order.state === "rejected" || order.state === "settled-unknown") return sendJson(res, 200, { outcome: "rejected", reason: order.closedReason ?? order.state, order: view() });
    return sendJson(res, 200, { outcome: "pending", order: view() });
  }

  /**
   * 外部の x402 facilitator の模型（`POST /xfac/settle`、本文 `{ x402Version, paymentPayload, paymentRequirements }`）。SubEtha の注文も bind も知らない:
   * 署名と期間が正しく、nonce が未使用なら chain に載せる。答えは x402 の `SettleResponse` の形。
   */
  async function submit(req: http.IncomingMessage, input: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== undefined) calls.submitWithAuthorization += 1;
    const payload = input["paymentPayload"];
    const to = lower(String((payload as { payload?: { authorization?: { to?: string } } } | undefined)?.payload?.authorization?.to ?? ""));
    const order = [...orders.values()].find((o) => lower(o.saleId) === to);
    count("submit", order?.orderId);
    if (injected("submit", res)) return;
    await sleep(delayOf("submit"));
    const mode = modes["submit"];
    if (mode === "timeout") return;
    if (mode === "error") return sendJson(res, 500, { error: "internal" });
    if (mode === "bad-request") return sendJson(res, 400, { error: "invalid_request" });
    const failed = (errorReason: string): void => sendJson(res, 200, { success: false, errorReason, transaction: "", network });
    if (mode === "refused") return failed("insufficient_funds");
    // 理由の表にある語で断る（記録の分類の試験用）。
    if (mode === "refused-known") return failed("invalid_exact_evm_transaction_failed");
    // 理由の欄が文字列でない。
    if (mode === "refused-malformed") return sendJson(res, 200, { success: false, errorReason: { secret: "Bearer leak-me" }, transaction: "", network });
    // 外部は断ったが、同じ authorization を別の送信者が chain に載せた。
    if (mode === "refused-but-on-chain") {
      const a0 = (payload as { payload?: { authorization?: Record<string, string> } } | undefined)?.payload?.authorization;
      if (a0 !== undefined) chainUsed.set(usedKey(String(a0["from"]), String(a0["nonce"])), `0x${randomBytes(32).toString("hex")}`);
      return failed("invalid_exact_evm_payload_authorization_nonce_used");
    }
    if (mode === "claims-success") return sendJson(res, 200, { success: true, transaction: `0x${randomBytes(32).toString("hex")}`, network });
    if (input["x402Version"] !== 2 || typeof payload !== "object" || payload === null) return sendJson(res, 400, { error: "invalid_request" });
    const signed = await validlySigned(payload);
    if (!signed.ok) return failed("invalid_exact_evm_payload_signature");
    const a = signed.authorization;
    const requirements = input["paymentRequirements"];
    const r = (typeof requirements === "object" && requirements !== null ? requirements : {}) as Record<string, unknown>;
    if (r["scheme"] !== "exact" || r["network"] !== network || lower(String(r["asset"])) !== lower(asset) || lower(String(r["payTo"])) !== lower(a["to"]!) || String(r["amount"]) !== a["value"]) return failed("invalid_payment_requirements");
    const t = now();
    if (BigInt(a["validBefore"]!) < BigInt(t + 6)) return failed("invalid_exact_evm_payload_authorization_valid_before");
    if (BigInt(a["validAfter"]!) > BigInt(t)) return failed("invalid_exact_evm_payload_authorization_valid_after");
    const key = usedKey(a["from"]!, a["nonce"]!);
    if (chainUsed.has(key)) return failed("invalid_exact_evm_payload_authorization_nonce_used");
    const txHash = `0x${randomBytes(32).toString("hex")}`;
    chainUsed.set(key, txHash);
    if (mode === "lose-response") {
      res.destroy();
      return;
    }
    // 外部の答えの hash が chain の hash と違う場合（証拠にしてはいけない）。
    return sendJson(res, 200, { success: true, transaction: mode === "other-hash" ? `0x${randomBytes(32).toString("hex")}` : txHash, network, payer: getAddress(a["from"]!) });
  }

  /** `#beginReceiptRelease`: 注文の `state` は変えない（`accepted` のまま）。release の mode は `exact-receipt`。 */
  function recordRelease(order: FixtureOrder): { deliveryKey: string; txRef: string; eventId: string } {
    const txRef = order.evidence!.txHash;
    const eventId = `${options.chainId}:${txRef}:${order.evidence!.logIndex}`;
    order.release = { deliveryKey: order.orderId, authorizedAt: now(), txRef, eventId, mode: "exact-receipt" };
    return { deliveryKey: order.orderId, txRef, eventId };
  }

  function release(order: FixtureOrder, input: Record<string, unknown>, res: http.ServerResponse): void {
    count("release", order.orderId);
    if (injected("release", res)) return;
    if (!hex32(input["requesterDigest"])) return sendJson(res, 400, { error: "expect { requesterDigest }" });
    const mode = modes["release"];
    if (once("release", "error-once")) return sendJson(res, 500, { error: "internal" });
    if (once("release", "rate-limited-once")) return sendJson(res, 429, { error: "rate-limited" }, { "retry-after": "1" });
    // `claimed-before`: Router の最初の呼び出しの前に release が記録されていた（別の経路で主張済み）。
    if (mode === "claimed-before" && !onceSpent.has(`claimed-before:${order.orderId}`) && order.release === undefined && (order.state === "accepted" || order.state === "settled")) {
      onceSpent.add(`claimed-before:${order.orderId}`);
      recordRelease(order);
    }
    // `beginRelease` の順: requester → prior release → state。
    if (lower(order.binding.requesterDigest) !== lower(input["requesterDigest"])) return sendJson(res, 403, { error: "requester-mismatch" });
    if (order.release !== undefined) return sendJson(res, 409, { error: order.release.completed === undefined ? "already-claimed" : `already-${order.release.completed.outcome}` });
    if (order.state !== "accepted" && order.state !== "settled") return sendJson(res, 425, { error: "not-ready" });
    if (mode === "not-ready-always" || once("release", "not-ready-once")) return sendJson(res, 425, { error: "not-ready" });
    if (mode === "incident" || order.afterRelease !== undefined) return sendJson(res, 409, { error: "incident" });
    // receipt mode: admitted な exact の証拠（paid）が無ければ `not-ready`（observed・signed の authorization だけでは通らない）。
    if (order.exact === undefined || order.exact.state !== "paid" || order.evidence === undefined) return sendJson(res, 425, { error: "not-ready" });
    const ticket = recordRelease(order);
    if (mode === "lose-response") {
      res.destroy();
      return;
    }
    return sendJson(res, 200, ticket);
  }

  function complete(order: FixtureOrder, input: Record<string, unknown>, res: http.ServerResponse): void {
    count("complete", order.orderId);
    if (injected("complete", res)) return;
    const outcome = input["outcome"];
    if (typeof input["deliveryKey"] !== "string" || (outcome !== "delivered" && outcome !== "failed")) return sendJson(res, 400, { error: "expect { deliveryKey, outcome: 'delivered' | 'failed' }" });
    const mode = modes["complete"];
    if (mode.startsWith("preset:") && order.release !== undefined && order.release.completed === undefined && !onceSpent.has(`preset:${order.orderId}`)) {
      onceSpent.add(`preset:${order.orderId}`);
      order.release.completed = { outcome: mode.slice("preset:".length) as "delivered" | "failed", at: now() };
    }
    if (once("complete", "error-once")) return sendJson(res, 500, { error: "internal" });
    if (order.release === undefined) return sendJson(res, 409, { error: "not-authorized" });
    if (lower(order.release.deliveryKey) !== lower(input["deliveryKey"])) return sendJson(res, 409, { error: "delivery-key-mismatch" });
    if (order.release.completed !== undefined && order.release.completed.outcome !== outcome) return sendJson(res, 409, { error: "conflicting-outcome" });
    if (order.release.completed === undefined) order.release.completed = { outcome, at: now() };
    if (mode === "lose-response" || once("complete", "lose-response-once")) {
      res.destroy();
      return;
    }
    return sendJson(res, 200, { state: order.release.completed.outcome, completedAt: order.release.completed.at });
  }

  const fixture: FacilitatorFixture = {
    server,
    orders,
    calls,
    get baseUrl() {
      return baseUrl;
    },
    async listen(port = 0, host = "127.0.0.1"): Promise<string> {
      await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
      baseUrl = `http://${host}:${(server.address() as AddressInfo).port}`;
      return baseUrl;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    setMode(route, mode, rawInjection) {
      modes[route] = mode;
      if (mode === "raw") raw[route] = rawInjection ?? { status: 200, headers: {}, body: "{}" };
    },
    allocate(input) {
      const pending = pendingAllocations.get(pairKey(input.requesterDigest, input.resourceDigest));
      pendingAllocations.delete(pairKey(input.requesterDigest, input.resourceDigest));
      const amount = input.amount ?? pending?.amount;
      if (amount === undefined) throw new Error("allocate: no pending allocation and no amount");
      return createOrder({ requesterDigest: input.requesterDigest, resourceDigest: input.resourceDigest, amount, ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }), ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) });
    },
  };
  return fixture;
}

/** CLI（子 process）: `--provider-id`・`--bearer`・`--chain-id`・`--asset`・`--domain-name`・`--domain-version`・`--ttl-seconds`・`--max-order-amount`・`--port`・`--mode <route>=<mode>`（複数可）。 */
async function main(): Promise<void> {
  const arg = (name: string, fallback: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
  };
  const modes: Partial<Record<FixtureRoute, string>> = {};
  process.argv.forEach((value, index) => {
    if (value !== "--mode") return;
    const spec = process.argv[index + 1] ?? "";
    const eq = spec.indexOf("=");
    if (eq > 0 && (FIXTURE_ROUTES as readonly string[]).includes(spec.slice(0, eq))) modes[spec.slice(0, eq) as FixtureRoute] = spec.slice(eq + 1);
  });
  const fixture = createSubethaExactFacilitator({
    providerId: arg("provider-id", "router-test"),
    bearer: arg("bearer", "fixture-provider-token"),
    chainId: Number(arg("chain-id", "84532")),
    asset: arg("asset", "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f"),
    domainName: arg("domain-name", "zERC20 USD Coin"),
    domainVersion: arg("domain-version", "1"),
    ttlSeconds: Number(arg("ttl-seconds", "300")),
    maxOrderAmount: BigInt(arg("max-order-amount", "1000000")),
    modes,
  });
  const baseUrl = await fixture.listen(Number(arg("port", "0")));
  process.stdout.write(`${JSON.stringify({ event: "listening", port: Number(new URL(baseUrl).port), role: "subetha-exact-facilitator" })}\n`);
  const stop = (): void => {
    void fixture.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
