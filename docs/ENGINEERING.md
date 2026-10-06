# Engineering notes

Detail split out of the README so that file stays short enough for a first-time reader.
Nothing here is a summary: these are the working records — contracts confirmed over real
TCP, the settlement evidence with its transaction hashes, env wiring, and the commands.

**The README remains the entry point.** What is achieved and what is not is stated there;
this file gives the evidence behind it.

## Verified environment

- Run and confirmed on Node **22.23.1** / **macOS (darwin)**. `engines` in `package.json` is `>=22.12.0`.
- **Not run** on Linux.
- `fs-ext` (OS `flock(2)` exclusion) is a native addon, and `node-gyp configure build` runs at install
  time. The build requires Xcode Command Line Tools and python3.

## Setup (exactly the steps that were run)

```sh
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm rebuild fs-ext --foreground-scripts --no-audit --no-fund
```

- Direct dependencies are **pinned to exact versions** in `package.json`, with a `package-lock.json`.
- `--legacy-peer-deps` is only there to bypass npm's peer resolution; it is not a relaxation of permissions.
- Because `--ignore-scripts` stops install-time scripts, the native build of `fs-ext` is run explicitly
  with the `npm rebuild` above.

## Commands

```sh
npm run test    # vitest run (tests/unit + tests/wire)
npm run types   # tsc --noEmit
npm run build   # tsc
```

To run only wire (real CLI, real TCP):

```sh
npm run test -- tests/wire/router-cli.test.ts      # R1->R2->R3->R4, the 3 terminals, and restart (synthetic rail)
npm run test -- tests/wire/http-contract.test.ts   # the public contract's rejection surface and canonical binding
npm run test -- tests/wire/concurrency.test.ts     # concurrent R3 (same quote / different quote)
npm run test -- tests/wire/crash-recovery.test.ts  # crash before any response byte is emitted, and restart
npm run test -- tests/wire/subetha-inbound.test.ts # real HTTP contract of the inbound rail adapter
npm run test -- tests/wire/x402-outbound.test.ts   # outbound rail A: v2 wire of the official x402 SDK
npm run test -- tests/wire/x402-cli.test.ts        # A end-to-end through the real composition
npm run test -- tests/wire/mpp-outbound.test.ts    # outbound rail B: wire of the official mppx client
npm run test -- tests/wire/mpp-cli.test.ts         # B end-to-end through the real composition
npm run test -- tests/wire/client.test.ts          # typed client (approval binding, reopen)
npm run test -- tests/wire/chat-crossimpl.test.ts  # existing chat implementation x real Router cross-implementation (unpaid)
# ^ The chat implementation lives in a separate repository, so pass its location via `T5_CHAT_APP_DIR`. Skipped if unset.
npm run test -- tests/wire/mcp-server.test.ts      # MCP wrapper (tool exposure, approval binding, evidence)
```

- **The wire test harness (`tests/fixtures/router-harness.ts`) starts `src/main.ts` as a child process
  automatically** (it launches `node --import tsx src/main.ts` directly, and the child is just the one
  real app process). There is no procedure for starting it manually, and **manual startup is not verified**.
- The harness also starts the synthetic facilitator fixture and the synthetic upstream fixture, each in a
  **separate process**, and writes the configuration files and a disposable journal into a temporary
  directory under `runtime/`. All ports are ephemeral on `127.0.0.1` (`--port 0`).
- The tests use the real filesystem, create disposable directories only under `runtime/`, and delete only
  the paths they created. `runtime/` is not under git management. They terminate only the child processes
  they started, and wait for close.
- Rejection of a double writer is confirmed by actually starting a separate process. The unit-test purchase
  lifecycle runs against a synthetic rail in the same process.
- All of it is **unpaid, unsigned, keyless, loopback only** (it does not go out to an external network).

## Current properties of the journal

- Appends NDJSON, and updates the in-memory table **only after fsync returns** (write-ahead).
- Serialization, validation and freezing are done before writing, and a request that does not hold up is
  rejected without writing a single byte.
- On new creation, the parent directory is also fsynced before open returns success. On failure it is not
  treated as success, and locks already acquired are released.
- It holds an OS non-blocking exclusive lock on the permanent `journal.lock` for the life of the process,
  and does not delete the lock file.
- Replay checks JSON validity, record shape, `seq` sequence numbering and a truncated tail, and a violation
  **aborts startup with a byte offset** (no auto-truncation, no auto-completion).
- Appends are serialized with a single mutex. The writer is not allowed to continue after close, or after a
  write/fsync failure.

## Dynamic purchase lifecycle (differences from the static one)

1. `quote`: URL rules → requestId collision rules → gates (source/global rate, outstanding quotes, destination host) → unpaid read of the upstream through the
   dynamic transport (no loopback, DNS deadline, header cap 32 KiB, 402 body never read) → the first offer passing the profile's field-by-field check → pricing
   (par: `converted` = the upstream amount expressed in the inbound asset's decimals, exact or rejected; `fee = max(min, flat + ceil(converted × bps / 10000))`;
   `total = converted + fee`, 30-digit cap; per-purchase bucket limits) → inbound offer for `total` → **ledger** row (`<journal dir>/dynamic-quotes/<date>.ndjson`,
   ≤ 8 KiB; the quote's deadline is `min(approvalTtlMs, offer expiry)` and may not exceed 24 h; files are kept 7 days) with `sha256(ownerKey)`. Nothing in the journal.
2. `purchase` (requires the `ownerKey`): ownership → approval → profile fingerprint (includes `enabled`) → deadline → purchase gate → preflight (x402: the signed
   authorization's nonce, recipient and amount must match the quote and its expiry must not be later than the offer's; MPP: the embedded challenge id) → one
   `attempt` row in the ledger (first time only)
   → optional balance pre-check → host gate held to the end → reread and whole-offer match → inbound verify → deadline recheck → **promotion**: dynamic budget
   check and one journal `created` row carrying the reservation, in one mutex → `source_pending` → inbound settle → outbound (target = the saved URL) → terminal.
   Any failure before promotion writes nothing to the journal; a promoted `created` retried later repeats every check and skips only the reservation.
   After promotion, any settle failure is recorded as `unknown` (never as "unpaid").
3. Outbound (dynamic path): the saved offer must match a current offer **in full**; the x402 typed data and the Tempo transaction are **rebuilt by the Router**
   from the profile and the approved values before signing (the SDK only proposes); one signature, one send per payment; the receipt is checked before a body
   capped at 256 KiB; only an `application/json` object is delivered, anything else is `paid_data_unavailable` (`unsupported_response` / `response_too_large`).

## Current purchase lifecycle (synthetic rail only)

`quote -> approval -> strict preflight -> re-check of the upstream offer -> verify -> deadline re-check ->
budget reservation -> inbound settle -> outbound write-ahead -> pay -> durable storage of the result` runs as one path on a real
journal. The core does not branch on rail name, and this path also runs **over a real CLI and real TCP**
(with synthetic fixtures on the other end).

- Approval is bound to `quoteId`, and the approval deadline is an **absolute time** fixed at quote time (the
  earlier of the TTL and the expiry of the issued offer), carried in the journal so that the same value is
  used for the decision after a restart.
- `(principal, requestId)` -> `quoteId` is immutable. No one but the owning principal can start it or read it.
- Budgets are totaled per `(network, asset)` bucket, and inbound and outbound that fall into the same bucket
  are summed. After passing the count cap, the per-item cap and the amount format check, "check -> append+fsync
  of the reservation row" is done indivisibly under a single mutex, and the inbound settle is not started
  unless it succeeds. A reservation that was taken is never released, including when the purchase ends in
  `unknown`; failures and interruptions before the reservation hold no allocation.
  **The reservation is taken only after `verify` succeeds, directly before the settle.** Reservations never
  come back, and the strict preflight only compares fields a caller can copy, so reserving before `verify`
  let anyone exhaust the budget with credentials that carry an invalid signature, without paying. An attempt
  that ends at `verify` (rejected, unavailable, or expired meanwhile) never reached the settle and holds no
  allocation. **Not covered**: a settle that the rail rejects after a successful `verify` still keeps its
  allocation.
- Twice, right before the inbound settle and right before the transfer, the upstream presentation is re-read
  and checked against the approved offer. The check uses **the entire set of top-level fields of the verified
  offer**, so a change in anything other than the amount (`maxTimeoutSeconds`, etc.) is detected too. A
  mismatch before settle **starts neither leg** (no charge), and a mismatch after settle terminates without
  paying, as `paid_data_unavailable` (`destination.outcome="not_sent"`, no receipt).
- Exceptions, timeouts and responses that cannot be interpreted are finalized durably as `unknown`, and there
  is **no auto-retry, no auto re-settle and no auto-refund**. An interrupted intermediate state is appended to
  the journal as `unknown` on restart.
- The reason codes that are published are limited to a fixed safe set, and do not expose upstream URLs, tokens
  or exception strings.

## Current public HTTP contract (confirmed over real TCP against a synthetic rail)

| # | Method/path | Role |
|---|---|---|
| R1 | `GET /v1/routes` | allowlisted `routeId`, canonical URL and asset metadata only (does not return upstream URLs) |
| R2 | `POST /v1/quotes` | `{routeId, requestId}` -> takes the upstream quote first, issues the inbound offer and fixes the `quoteId` |
| R3 | `GET /v1/routes/{routeId}/resource` | Executes the purchase. On success returns **the upstream JSON as-is** in the body |
| R4 | `GET /v1/purchases/{paymentId}` | A fixed public projection that only the owning principal reads |

**Dynamic upstream URLs** (feature present, **disabled in production**; design `dynamic-upstream-design.md`):

| # | Addition | Role |
|---|---|---|
| R1 | `dynamic: { enabled, profiles[] }` | The profiles a caller can pay with (rails, assets, decimals, `maxUpstreamAmount`, `fee`, disclosures). No `payTo`, no token domain |
| R2 | body `upstream: { url }` with `routeId` = profile id | Reads the caller's URL (https, no userinfo/port/IP literal/fragment, host not denied), selects the first offer that passes the profile's checks, prices it (`pricing`), issues the inbound offer for `total` and returns the quote with `upstream`, `pricing`, `disclosures` and an **`ownerKey`** (only in this response). The quote is kept in a ledger, not the journal |
| R3 | header `x-router-owner-key` | Required for a dynamic quote: with a credential, a missing or wrong key is a 404 `unknown_quote` (same as nonexistent); without a credential the 402 says `quote_required` instead of re-presenting the offer. Path `/v1/routes/{profileId}/resource`, only while enabled |
| R4 | header `x-router-owner-key`; fields `upstream`, `dynamic.{profileId,pricing,promoted,fundsMoveOnCredential,awaitingPaymentDoesNotMeanUnpaid}` | A missing or wrong key is a 404 `not_found` |
| R2/R3 | header `x-router-source` | The source identity for rate limiting. The MCP entry derives it (`X-Forwarded-For` last value, else the socket address) and overwrites anything the caller sent |

Dynamic quote error codes: `dynamic_disabled`/`unknown_route` 404, `upstream_url_required`/`invalid_upstream_url` 400, `request_id_conflict` 409,
`rate_limited`/`dynamic_capacity` 429, `dynamic_unavailable` 503, `source_terms_mismatch`/`quote_failed` 502 (`reason`: `no_matching_offer`, `offer_unavailable`,
`amount_unrepresentable`, `per_purchase_limit`, `bucket_not_allowed`, `quote_too_large`).

- Authentication is 2 things: `X-Router-Principal` and `Authorization: Bearer <token>`. R3 additionally
  requires `X-Router-Quote-Id` / `X-Router-Request-Id` / `X-Router-Approval` and the inbound rail's payment
  credential (`X-Payment`, base64 JSON). If even one is missing or mismatched, the purchase is not started.
- An R3 without credentials only re-presents the 402 offer of an existing quote, or returns an instruction to
  "take a quote at R2", and **writes not a single line to the journal**.
- The canonical URL is assembled from configuration values, not derived from the request's `Host`. **A query
  string is a 400**, anything other than `GET` is a 405, and a `routeId` outside the allowlist is a 404. The
  purchase entrance is only when **the raw request path matches the configured `canonicalPath` exactly**; it
  does not execute for aliases like `/./`, `//` or a trailing `/`.
- The R4 projection is fixed fields only (`paymentId / routeId / status / source / destination /
  quoteFingerprint / terminalReason / updatedAt`, plus `result` when `delivered`). It does not expose secrets,
  upstream URLs or the raw journal, and there is no admin entrance for a full dump. From another principal it
  is a 404.
- There are 3 terminals, `delivered` / `paid_data_unavailable` / `unknown`, and after a restart R4 returns the
  same status and the same result. Re-sending the same request does not re-send either leg.
- **Concurrent requests (T-10)**: even with 2 concurrent R3s to the same `quoteId` over real TCP, the inbound
  settle and the outbound pay each happen only once, and both responses return the same body and the same
  `paymentId` (`attempt` is 1). With different `quoteId`s, both go through as 2 independent purchases under the
  shared budget.
- **Crash before the response is emitted (T-11)**: even if the Router process is SIGKILLed **immediately after
  the result is fsynced and before a single response byte is emitted**, an R4 after restarting on the same
  journal returns the same status, the same result, and the evidence for both legs (`source.txRef` /
  `destination.txRef` / `receiptRef`). Even if the client re-issues the same request, **neither leg is re-sent**.
  This stop point is made with a test seam (`crashBarrierPath`) that can only be written in the `synthetic`
  section, and **is not read in the default (real) configuration**.

## Startup configuration (env)

`src/main.ts` is the real CLI entry point. Secrets are taken only from env, and the allowlist and the caps live
in a non-secret JSON configuration file.

| Key | Default | Contents |
|---|---|---|
| `ROUTER_CONFIG_PATH` | (required) | JSON of `{"router":{approvalTtlMs,routes,budget}, "x402":{upstreams}, "synthetic":{facilitatorUrl,upstreams,crashBarrierPath?}}`. In `real`, `x402.upstreams` (`routeId` -> upstream canonical URL) is required |
| `ROUTER_PRINCIPAL_TOKENS` | (required) | Comma-separated `<principalId>:<token>`. Not emitted in responses, logs or the journal |
| `ROUTER_ADAPTER_MODE` | `real` | `real` or `synthetic`. **The synthetic rail only when explicitly specified** |
| `ROUTER_SUBETHA_FACILITATOR_URL` | (required in `real`) | Base URL of the inbound rail facilitator (a single setting) |
| `ROUTER_JOURNAL_PATH` | `runtime/journal.ndjson` | NDJSON journal (`journal.lock` is in the same directory) |
| `ROUTER_HTTP_HOST` / `ROUTER_HTTP_PORT` | `127.0.0.1` / `8500` | Listener. `0` for ephemeral |
| `ROUTER_CANONICAL_BASE_URL` | `http://127.0.0.1:8500` | Base for the canonical URL (not derived from `Host`) |
| `ROUTER_MPP_INBOUND_RPC_URL` | (chain default) | Tempo RPC used by the MPP inbound adapter to check receipts. Its host is also denied as a dynamic upstream |

The `router.dynamic` section of the config (optional; **absent means the feature does not exist**): `enabled`, `profiles` (a map keyed by profile id; each
profile carries `profileId` equal to its key, `sourceRail`, `source`, `rail`, `destination` incl. `tokenDomain` for x402 or `feeAsset`/`maxFee`/`feeMargin` for MPP (the MPP fee is set per quote from a gas-cost estimate; `maxFee` is the ceiling of the per-quote cap, see `docs/dynamic-gas-fee-design.md`), `par: true`,
`maxUpstreamAmount`, `fee {flat,bps,min}`; the public R1 listing is an array derived from it), `budget` (counted
separately from the static budget), `limits` (rates, concurrency, outstanding quotes, per host/address, ledger retention), `denyHosts`. The wiring adds the
facilitators, the canonical base, the MPP RPCs and `RouterCapabilities.dependencyUrls` to the deny list (not the static upstreams: the operator's own providers
may be dynamic targets), and refuses to start when the MPP capability's RPC host is not denied.

- **By default (`ROUTER_ADAPTER_MODE=real`) it wires up the real adapters (official SDK wiring), but if no
  payment capability has been injected it aborts startup with `signer_not_authorized`. It does not fall back to
  the synthetic rail, and does not create a fake signer.** For the outbound rail's signing and payment
  capability it uses only what is **injected from code at startup**, and does not load it from the configuration
  file or env (it does not load arbitrary plugins). The outbound rail is resolved by the per-`routeId` `rail`
  (`x402` / `mpp`), and it does not start if the capability for that rail is absent.
  **Preparing a capability backed by a real key and real RPC is out of scope for this document, and no usable
  wallet setup procedure is provided.**
- What is confirmed in an executable form is only the end-to-end runs with the **non-signing spy capability from
  tests** injected (`tests/wire/x402-cli.test.ts` / `tests/wire/mpp-cli.test.ts`), where the startup log's `label`
  is `T2-fixture-nopay` / `T3-fixture-nopay`. The `real` display appears only when a real capability is injected.
- Only when `synthetic` is explicitly specified does it assemble the known in-repository fixture configuration (it
  does not load arbitrary plugins). Connections are restricted to **loopback only**, and it does not follow
  redirects.
- `routeId` is limited to a path-safe form, and if `canonicalPath` does not match the
  `/v1/routes/{routeId}/resource` that is actually served, it is **rejected at startup with `config_invalid`**.
- `synthetic.crashBarrierPath` is a **synthetic-only test seam** for T-11 (it stops before any response byte is
  emitted and writes out that it was reached). Because it can only be written in the `synthetic` section, it is
  not even parsed in the default `real` configuration. It is not an operational feature.

## Typed client for the existing chat (T4)

`src/client/{index,types}.ts` is a **thin typed wrapper** over R1-R4, and
`examples/chat-market-data-profile.ts` shows a callable example of "quote -> **explicit human approval** ->
execute -> status / reopen". **It does not build a UI.**

- Approval is only an explicit value bound to `quoteId`. When unapproved, rejected, approved for a different
  quote, or on anything other than the approved canonical path, it **does not issue a request to the Router**
  (confirmed with a synthetic fixture that "neither leg moved").
- **It does not create credentials and does not sign.** It uses only the existing `X-Payment` value that the
  caller passes after approval.
- Requests are fixed to the origin of the configured `baseUrl`, and it does not follow redirects. Even if the
  origin of the canonical URL returned by the quote differs, it does not send the principal token or credentials
  there.
- It does not auto-retry, auto re-quote, or re-create the `requestId`. `unknown` and `paid_data_unavailable` are
  kept as different results, and **both return a `paymentId`**, so they can be reconciled with `status()`.
- The Router's snapshot envelope is passed through as-is. **It does not cast to an article type and does not
  fabricate a pseudo-article.**
- **Modification of the fetched canonical URL (origin / query / hash / path) or rewriting of the conditions is
  not accepted.** It can only execute **quotes issued by that client instance itself**, and after the client is
  re-created only reading via `status()` is possible (no auto re-quote and no re-execution). Re-executing the
  same approval on the same client is safe (on the Router side, both legs happen only once).
- An R3 counts as a success only when **the `X-Router-Payment-Id` header exactly matches the approved
  `paymentId`** and the JSON body could be fetched. The explicit `paid_data_unavailable` / `unknown` results are
  conditioned on **a `paymentId` match in the body**, and it does not read a same-named field inside the upstream
  snapshot as Router metadata. A missing, mismatched or contradictory value becomes **`unknown` with the approved
  `paymentId` kept**, and is not re-sent. R4 accepts only a projection that matches the `paymentId` that was
  queried.
- **Distinguishing the evidence**: the above is the scope confirmed by the client's own wire test
  (`tests/wire/client.test.ts`, against a synthetic fixture, `T4-fixture-nopay`).
  `examples/chat-market-data-profile.ts` imports from that same test and confirms **the example's own paths**
  (rejection / approval mismatch / invalidation of callback modification / normal execution / `unknown` retention /
  reopen after restart).

## Cross-implementation test against the existing chat's execution layer (T5)

`tests/wire/chat-crossimpl.test.ts` (label `T5-crossimpl-nopay`) puts **the existing chat side's real
implementation** (`createRouterChatExecution` in `apps/chat-demo/router-execution.mts` in a separate worktree)
and the **real Router process** (`src/main.ts`) together over real TCP, both as real processes.
The chat side's files are **imported read-only and are not modified at all**.

Until then the two were independent implementations that "assumed the same contract": the chat side's tests were
green against its own stub Router, and ours were green against our own client. **That they mesh had not been
confirmed.**

What was confirmed (synthetic fixture, unpaid):

- The Router's real R2 response passes the chat side's `decodeQuote` strict validation (an exact key set that
  allows no extra fields) **without modification**. Provider A-shaped and B-shaped snapshots also pass the chat
  side's `market-data.mjs` validation.
- With approval -> execution -> **reopen in a separate process**, the chat side's journal and the Router's R4
  projection agree on the same result for the same `paymentId`.
- With no approval / approval for a different quote / a canonical origin mismatch / an expired approval,
  **payment does not start**. Even on a second approval after a successful one, R3 is not re-sent (at-most-once).
- Another principal cannot read it (the Router returns 404 and does not even reveal existence).
- Even if the Router dies before the response bytes are emitted, `unknown` remains, and reopening **does not
  auto-retry**.

The negative-case determinations do not rely on the chat side's journal alone: they are cross-checked
independently against **a loopback proxy that counts reaches to the Router**
(`tests/fixtures/router-calls-proxy.ts`) and the upstream's and facilitator's `/calls`. That is because the
Router's HTTP layer has no access log, and the upstream charge count alone cannot distinguish the case where
"the Router received it and rejected it with a 4xx".

**What this integration does not achieve**: causality on the real chat UI (browser) (the rest of B-03 / U-07),
real settlement, real keys, real signing, real API reach for Providers A/B, and finality.
**AC-7 is also not met** (because no payment leg was executed). Drop-in compatibility with
`ChatExecutionFactory` is limited to the scope of having been able to drive `createRouterChatExecution` against a
real Router; the chat's UI and HTTP layers (`server.mts` / `ui.js`) are out of scope.

## x402 inbound -> MPP outbound (P4, achieved)

**"Someone who only has x402 can use a Provider that only accepts MPP"** was run through on a real chain.

| Leg | Chain | Real tx | Transfer |
|---|---|---|---|
| Inbound (x402) | Base Sepolia | `0x6f7d60f5...125e` (block 47303606) | client -> **Router** 10000 USDC base units |
| Outbound (MPP) | Tempo Moderato | `0x89cc773d...1829` (block 36903699) | Router -> Provider 10000 pathUSD + 69 fee |

- R2's `source.rail` is **`x402`** and `destination.rail` is **`mpp`** (the projection names the real rail).
- R4 is `delivered` / `outcome: paid`, and **the txRefs of both legs remain**.
- **The 2 legs are independent payments.** There is no exchange, no bridge and no FX conversion.
- The inbound rail is chosen by the route's **`sourceRail`**. **Unspecified means `subetha`**, so existing
  configurations are unchanged.

**A design point**: the facilitator reconstructs the EIP-712 domain from the `name` / `version` in
`requirements.extra`, so the Router **issues these itself**. If `accepted.extra` contains anything other than
keys issued by the Router it is **rejected**, so the payer cannot inject the signing domain.
`paymentRequirements` is always built **from the Router-issued offer**, and `credential.accepted` is not sent to
the facilitator.

**What this path does not reach**: **AC-4 is not met** (because the wording of the requirement refers to the
SubEtha inbound leg). Same-rail coverage (x402 -> x402 / MPP -> MPP) remains **not verified**. finality and
AC-7 are also not met.
Also, the chat contract requires `rail === 'subetha'` and `scheme === 'subetha-zerc20'`, so
**the x402 inbound route cannot be used from chat** (it coexists with the SubEtha route).

## Real settlement of outbound legs A / B (T7, achieved)

**Real testnet settlement holds for both rails.**

| Rail | Provider | Real tx | Amount |
|---|---|---|---|
| A (x402 / Base Sepolia) | `provider-a.subethalabs.com` | `0x68b9469f...f371` (block 47301621) | 10000 USDC base units |
| B (MPP / Tempo Moderato) | `provider-b.subethalabs.com` | `0x84157b93...ea69` (block 36898398) | 10000 pathUSD base units + 69 fee |

**About the URL rename**: the Provider URLs in the table above are **the facts at the time of settlement** and
are not rewritten. Afterwards `provider-a` was renamed to **`provider-x402`** and `provider-b` to
**`provider-mpp`**, and **the old URLs were deleted** (unreachable; the parent confirmed this). The current
endpoints are the new URLs. The `providerId`s (`market-data-a` / `market-data-b`), the prices, the recipients,
the chains and the paths are unchanged.

Both started the real `src/main.ts` with **`mode: real` / `label: real`** and ran R1->R2->R3->R4 end-to-end, R4
returned `delivered` / `outcome: paid`, and it was independently verified on chain.

**Rails A and B differ in who performs the transfer** (measured):
- **A**: the Router **only signs**, and the broadcast and gas are borne by the facilitator.
  -> It works even when the payer's native balance is 0.
- **B**: **the payer broadcasts themselves**, and **the fee is also denominated in pathUSD**.
  -> The payer needs pathUSD, and because **the transfer happens before the paid GET**,
  "transferred but data not fetched" can happen in principle (in that case too it is not re-sent and `unknown` is
  retained).

### Provider A details

| Item | Value |
|---|---|
| Network | Base Sepolia `eip155:84532` |
| Asset / amount | USDC `0x036CbD53...CF7e` / **10000 base units ($0.01)** |
| Real tx | `0x68b9469f7081053b632d221863070de517b85ca821cff3a18a31e805a79ef371` (status `0x1` / block 47301621) |
| Path | Started the real `src/main.ts` with **`mode: real` / `label: real`** and ran R1->R2->R3->R4 end-to-end |
| Data fetched | A real snapshot of the Hyperliquid ETH perpetual |

- **AC-5 (real settlement of the outbound leg) is reached.** However, **the inbound leg is still the synthetic
  facilitator**, so **AC-4 is not met**.
- The signing capability is **not placed in product code**. A startup tool under `tools/` receives the key from
  env and **injects it from code** (`src/**` does not read keys from env or configuration files).
- Signing for a wrong recipient or amount is rejected by a **guarded signer**
  (`src/adapters/outbound/x402.ts`). That rejection surface is verified unpaid in
  `tests/wire/x402-guarded-signer.test.ts`.
- On the EIP-3009 path of x402 the Router does not connect to the chain and only signs, and
  **the broadcast and gas are borne by the facilitator** (it works with the payer's ETH balance still at 0).
- The settlement scope is recorded (`docs/t7-requirements.md` §2).
  **The public facilitator hits nonce collisions when hammered, so leave a few seconds between payments.**

## Running it locally (if you clone)

The hosted version ("Try it now" at the top) is enough, but if you want to run everything in your own
environment, do this.

```sh
git clone https://github.com/subetha-labs/subetha-router.git
cd subetha-router
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm rebuild fs-ext --foreground-scripts --no-audit --no-fund

claude mcp add subetha-router \
  -e SUBETHA_PAYER_PRIVATE_KEY=0x<a disposable Base Sepolia key> \
  -- npm run --silent demo:mcp
```

`demo:mcp` **starts exactly one Router as a child process** and puts an MCP server on top of it.
Unlike the hosted version, **the inbound leg's key is passed to this process** (it stays local because it is
your own machine).

Measured:
```
quote: 10000 base units (decimals 6) on eip155:84532
purchase outcome=delivered
inbound  tx=0x17d1ab62...8847   (Base Sepolia, block 47304257)
outbound tx=0x78385ee1...58ce   (Tempo Moderato, block 36905875)
```

The deployment (EC2 + Docker + TLS) procedure is in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## MCP details (tools, evidence, scope reached)

### Exposed tools

| tool | Maps to | Notes |
|---|---|---|
| `subetha_router_list_routes` | R1 | Upstream Provider URLs are not returned |
| `subetha_router_quote` | R2 | **Does not start a payment.** The returned `subject` is what gets approved; carry the `quote` around as-is |
| `subetha_router_purchase` | R3 | Pass the `quote` and a `credential` signed with your own key |
| `subetha_router_status` | R4 | Equivalent to save -> reopen. The txRefs of both legs remain. `ownerKey` is optional in the schema but **required** to read a dynamic purchase |
| `subetha_router_quote_url` | R2 with `upstream` | **Dynamic upstream URL** (disabled in production). `{ profileId, url, requestId }`. The returned `quote` carries the `ownerKey`; pass the whole document to `purchase`, and its `ownerKey` to `status`. A **delivered** dynamic purchase comes back from `purchase` as top-level `result: { untrusted: true, source: "upstream", contentType, body }` with `proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" }`; from `status` the same envelope sits at `projection.result` |

`tools/list` and `quote` are **free**, and `purchase` is **paid** (matching the convention for MCP with payment).
The payment is **tied to the call, not to the session**, so the remote works **statelessly**.

- Always look at `subject.source.decimals`. `amount` is in base units, and without `decimals` you cannot tell
  whether `10000` is 0.01 or 10000.
- Use **the same value** for `requestId` in `quote` and in `purchase`. Changing it makes it a different purchase.
- **The Router does not hold the caller's key.** There are 0 references to a private key in `src/**`, and it does
  not read one from env either.

### Execution evidence (`evidence`)

Every tool response carries `evidence: { label, source, verified }`.

- `source: "router_listening_line"` / `verified: true` ... a value read **from the Router's own startup line**
- `source: "operator_asserted"` / `verified: false` ... the operator's self-declaration (not a value the Router
  stated)

**Do not trust a bare label.** `verified: false` means nothing more than "the operator says so".

### What this path does not reach

- **The SubEtha inbound leg** is still synthetic. -> **AC-4 is not met**
- Real API reach and real settlement for Providers A/B are **reached** (see the sections above)
- finality is not confirmed

