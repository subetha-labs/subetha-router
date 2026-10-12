# Dynamic upstream request bodies (POST + JSON) — requirements and design (2026-10-13)

Owner's direction (2026-10-13 05:40 JST): make a mainnet purchase from a well-known provider and show it in the demo. The well-known
x402 providers (Exa, Firecrawl, Nansen) take a **POST with a JSON body**; the Router's dynamic upstream is GET-only
(`docs/dynamic-upstream-design.md` §2.1, `upstream: { url, method: "GET" }`). Probe of Exa `POST https://api.exa.ai/search`
(2026-10-13 05:45 JST, body `{"query":…,"numResults":3,"type":"fast"}`): 402 with `PAYMENT-REQUIRED` (x402 v2, `resource.url` equal to the
request URL, first offer `exact` on `eip155:8453`, USDC `0x8335…2913`, `amount: "7000"`, `payTo 0x6d6E…9192`, `maxTimeoutSeconds 60`,
`extra: { name: "USD Coin", version: "2", breakdown, totalUsd, acceptId }`), plus an MPP challenge (Tempo mainnet, `supportedModes: ["pull"]`
only — refused by the Router's push-only rule, so the x402 leg is the one). The Router's offer check refuses the three informational
`extra` keys today (`unknown extra`).

## 1. Requirements

- FR-P1 `subetha_router_quote_url` (and `POST /v1/quotes` `upstream`) accept `method` (`"GET"` default, `"POST"`) and, for POST, `body`:
  a JSON **object** (not array/scalar), sent as its canonical JSON text (`stableJson`, sorted keys) with `content-type: application/json`,
  **≤ 8 KiB** of UTF-8. No other method, content type or header. GET quotes are byte-for-byte unchanged.
- FR-P2 The body is part of the terms. Binding `dynamic|<profile>|POST|<url>|sha256:<hex>` (hex = sha256 of the canonical body text; GET stays
  `dynamic|<profile>|GET|<url>`). The quote record stores `upstream: { url, method, body?, bodySha256? }`; the purchase re-reads the 402 with
  the **same bytes**, requires the saved offer to still be offered (unchanged rule), and sends the paid request with the same bytes.
  The subject and projection carry `upstream.method`, `upstream.body` (the text the Router will send, so the human sees it) and
  `upstream.bodySha256`. The MCP `purchase` passes the quote document through as today (the record is authoritative).
- FR-P3 Only the **x402 EVM dynamic path** sends POST today. The MPP paths (Tempo, Solana) and the SVM x402 path refuse a POST target
  **before any network I/O** (`DynamicChallengeError("method")` → quote `quote_failed` / `method_not_supported`).
- FR-P4 Offer check (`checkDynamicX402Offer`): the informational `extra` keys `breakdown`, `totalUsd`, `acceptId` are allowed with any
  JSON value. They are not read; the chosen offer is still echoed verbatim in `accepted` (as today) and the signature is rebuilt from the
  profile's domain, so these keys cannot change what is signed. `assetTransferMethod` and every other key keep today's rules.
- FR-P5 Scope of the run: the **loopback mainnet Router** (`docs/mainnet-first-route.md`, profile `dyn-mpp-to-x402-mainnet`, the owner's
  Tempo key pays USDC.e over MPP, the Router pays Exa on Base mainnet). Hosted Router: unchanged until the owner swaps the image
  (`SR-M3`). The local payer is not updated (its record schema accepts only `method: "GET"`, so a POST quote is refused there — fail closed).
- SR-P1 Nothing else is loosened: host policy (`parseUpstreamUrl`, deny lists), `resource.url === url`, one payment one signature,
  re-read equality (`stableJson(offer)`), budget/reservation, approval binding, ownerKey. The body is caller data: fixed content type,
  no header or URL derived from it, size-capped before any I/O, not logged.

## 2. Design (files)

- `src/ports/outbound.ts` `UpstreamTarget { url; method: "GET" | "POST"; body?: string }` (body = canonical text, present iff POST).
- `src/core/dynamic.ts`: `normalizeUpstreamBody(raw)` (object → canonical text ≤ 8192 bytes, else `invalid_upstream_body`),
  `dynamicBindingOf(profileId, url, method, bodySha256?)`, record `upstream` fields, `readOffers(profile, target)` and purchase re-read with
  the target, `pay` target. `src/main.ts` `profileIdOfBinding` accepts 4 (GET) or 5 (POST) parts.
- `src/adapters/outbound/x402-dynamic.ts`: `getChallenge(target)` and the paid request use `target.method`, `body`, `content-type`;
  `EXTRA_KEYS` += `breakdown`, `totalUsd`, `acceptId` (informational, any value). `mpp-dynamic.ts`, `mpp-solana.ts`, `x402-svm.ts`:
  refuse `method !== "GET"` targets.
- `src/core/store.ts` (record validation: method GET|POST; POST needs body text ≤ 8192 bytes and a matching bodySha256), `src/core/orchestrator.ts`
  (`upstream` type, target passed to `pay`), `src/http/app.ts` (`upstream.method`/`body`), `src/mcp/server.ts` + `tools.ts` + `src/client`
  (`method?`, `body?`), `src/http/projection.ts` (subject/projection carry method/body/bodySha256).
- Docs: this file; `docs/dynamic-upstream-design.md` gets a pointer; `docs/mainnet-first-route.md` §3 gets the Exa run record.

## 3. Tests

Unit: body normalization (object only, canonical, limit, invalid), binding build/parse round trip (GET 4 parts, POST 5 parts, old GET
bindings unchanged), offer check (the three keys allowed with any value; other unknown keys still refused; `assetTransferMethod` rules
unchanged), x402-dynamic challenge + pay with a fake transport asserting method/body/content-type for POST and the absence of a body for GET,
MPP/SVM paths refuse POST before fetch (fetch spy not called), store validation, dynamic-core quote→purchase with a POST target (binding,
record, re-read with the same body, paid request), HTTP/MCP input (defaults, limits), config golden unchanged, `npm test` green.

## 4. Mainnet run (owner gate; after review)

`SUBETHA_MAINNET_FIRST_ROUTE=1` loopback Router as on 2026-10-10; `quote_url` with `dyn-mpp-to-x402-mainnet`, `url https://api.exa.ai/search`,
`method POST`, `body {"query":"<a question>","numResults":3,"type":"fast"}`; expected upstream 7,000 + fee 1,000 = 8,000 base units USDC.e
(per-purchase limit 20,000; dynamic total 60,000 of which 2,000 used on 10-10). The owner approves (funds move at `npm run sign` on Tempo MPP),
`purchase`, `status`; evidence: Tempo inbound tx, Base outbound tx, the saved record with the body and the delivered JSON.

## 5. Independent review (Codex `gpt-6-astra`, 2026-10-13, `.claude_workflow/local/dynamic-post-review1.md`)

APPROVE WITH CHANGES, no blocking finding in the caller-accessible flow. Safety assessment: canonical bytes are hashed into a
method-specific binding; both purchase re-reads, fee estimation and the paid request keep the stored target; body content never supplies
URLs or headers; host policy, redirects, `resource.url` equality, approval, ownerKey, budget and single-signature rules are intact; the three
extra keys are inert for signing and are echoed in `accepted` (and take part in re-read equality). Nonblocking, applied: the MPP adapter's
`estimateFee` refuses a POST target before any RPC I/O; store recovery cross-checks the restored `upstream` (url, method, body sha256)
against the inbound offer's `routeBinding` when that binding has the dynamic form (`dynamic|…`; synthetic fixtures and non-dynamic
bindings are left to the inbound adapter's own verification) and marks inconsistent records invalid; a real-adapter refusal test (MPP dynamic path with a
POST target: rejection and zero connections). Not done today: the composed quote → reopen → purchase test through `main.ts`
(recorded as follow-up).

**Run record (2026-10-13 20:36Z, owner-approved)**: `docs/mainnet-first-route.md` §3 — Exa `POST /search` bought through `dyn-mpp-to-x402-mainnet`
on the loopback mainnet Router: inbound Tempo tx `0x7ab25ff5…46d7` (8,000 USDC.e base units), outbound Base tx `0x3ab9b229…4558`
(7,000 USDC to Exa), `delivered` with three JSON search results; the status projection carries `upstream.method`, `body` and `bodySha256`.

