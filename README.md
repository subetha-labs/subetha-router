# SubEtha Router

A Router for when **the payment method an agent holds** does not match
**the payment method an API provider demands**.

**Hold only x402? You can still use a provider that accepts only MPP.**

```
caller ──(1) x402 / Base Sepolia USDC──> Router ──(2) MPP / Tempo pathUSD──> Provider
```

The 2 legs are **independent payments, not an exchange and not a bridge**. There is no FX conversion.

## For judges and reviewers: 5 minutes or 15 minutes

**5 minutes, no wallet.** Register the hosted Router in Claude Code and look at what it offers:

```sh
claude mcp add --scope user --transport http subetha-router https://router.subethalabs.com/mcp
```

Ask for `subetha_router_list_routes`: ten static routes and twenty dynamic profiles, each a pair of
"what you pay with" and "what the provider accepts" across x402 (Base Sepolia, Arc testnet, Solana
devnet) and MPP (Tempo, Solana devnet). Taking a quote (`subetha_router_quote` with a listed `routeId` and any fresh
`requestId`) pays nothing and shows the human-readable `subject` an agent must present before a
purchase. Then read [`docs/public-brief-2026-10-08.md`](docs/public-brief-2026-10-08.md) (all 20
cross-rail pairs settled on testnets, with transaction hashes) and
[`docs/mainnet-first-route.md`](docs/mainnet-first-route.md) (one bounded mainnet purchase, 2026-10-10,
Router run on the owner's machine). The hackathon claim/source matrix is
[`docs/colosseum-submission.md`](docs/colosseum-submission.md) §5.

**15 minutes, testnet funds (macOS 14+, Node 22).** Make one real cross-rail purchase through the
published payer: `npm i -g @subetha/payer`, create a disposable wallet, fund it with a little Base
Sepolia USDC from a faucet, start `subetha-payer daemon` in your own terminal, register the shim with
`claude mcp add --scope user subetha-payer -- subetha-payer mcp`, and ask Claude Code for the ETH
reference price while holding only Base Sepolia USDC. You approve the purchase in the daemon's native
dialog (check your security phrase, enter your passphrase); the Router pays the MPP-only provider on
Tempo from its own balance and the data comes back. Step-by-step:
[`packages/payer/README.md`](packages/payer/README.md). The payer supports this one route; the hosted
Router's other routes use the developer signing path below.

## Try it now

The recommended agent payment path is the [local SubEtha Payer](packages/payer/README.md):
install → encrypted wallet → owner faucet funding → human-started daemon → user-scope
Claude registration → quote → native human approval → purchase → saved status/recovery.
Its first slice is **macOS 14+ / Node 22 / Base Sepolia USDC / static
`md-mpp-eth-snapshot` only**.

**Release gate: `@subetha/payer@0.1.2` is on npm** (0.1.0 published 2026-10-10, G-A1; a funded
owner purchase through 0.1.0 was `delivered` the same day, G-A2; 0.1.2 was accepted by the owner
with a cancel test, G-F — records in `docs/agent-payer-tasks.md` and
`docs/agent-payer-followups-tasks.md`). Install it with `npm i -g @subetha/payer`. The payer README
also gives a locally built tarball path. The Router results below are not payer acceptance results.
This source repository is **public under the MIT license** (`LICENSE`; made public on 2026-10-10).

### Wallet-free hosted discovery

The existing hosted MCP endpoint can be registered without a clone or wallet:

```sh
claude mcp add --scope user --transport http subetha-router https://router.subethalabs.com/mcp
```

Ask for `subetha_router_list_routes` to discover the hosted Router's ten static
routes and twenty dynamic profiles (trust the current listing). Discovery does
not pay, fund a wallet or authorize purchase. This hosted low-level API is
separate from the local payer's five tools and native confirmation flow.

### Developer-only clone and signing path

Developers can clone the repository and use the existing low-level
signing workflow below. Its plaintext key handling is a developer path, not the
payer onboarding path. It requires a separate disposable
wallet and explicit human approval; do not use payer secrets here.

```sh
git clone https://github.com/subetha-labs/subetha-router.git
cd subetha-router
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm rebuild fs-ext --foreground-scripts --no-audit --no-fund

# Register the low-level remote Router
claude mcp add --scope user --transport http subetha-router https://router.subethalabs.com/mcp
```

The developer signing tools require separately provisioned disposable credentials;
never reuse payer secrets here. Credential provisioning is outside this guide.

Permission to run `npm run sign` is in `.claude/settings.json` (included in the clone).
**Without it the agent stops at the signing step**, so do not delete it.

Then start Claude Code **in this directory** and ask it something like:

> I only have Base Sepolia USDC. What's the reference price of ETH?

**Say what you hold, not which tool to use.** The agent reads the routes and works out that
the provider it needs takes only pathUSD on Tempo, which you do not have — and that the
Router will pay the independent outbound leg. Naming the tool works too, but then you have made the interesting
decision for it.

The agent takes a quote, **asks for approval**, creates a signature from your local key with
`npm run sign`, and proceeds through purchase (the steps are written in `CLAUDE.md`).

**Why the clone is needed**: to create the inbound leg signature **on your own machine**.
The Router does not hold the caller's key, so the signing capability has to be local.
**The key does not go out over the network** (only the signed `credential` does).

**Measured** (historical developer signing procedure against the production endpoint):

| Leg | Real tx |
|---|---|
| Inbound (x402 / Base Sepolia) | `0x61434be7...4a3a` (block 47308787) |
| Outbound (MPP / Tempo Moderato) | `0x703ea3c0...a582` |

### Notes

- **Leave a few seconds between payments.** The public x402 facilitator hits nonce collisions on
  back-to-back runs (measured: 2/20 failures at 0ms spacing, 0/15 with 3 seconds of spacing).
- **`paid_data_unavailable` can come back.** This is the state where the payment went through but
  fetching the data failed, and **the funds have moved**. The Router **does not auto-retry** (to
  avoid double payment). **A new purchase is a new payment**: it needs a **new quote and a new human
  approval** (never reuse the old `requestId`). The same holds for `unknown` and `awaiting_payment`:
  none of them proves that nothing was paid. **This is not rare**: there is a real case from another
  environment where a real settlement **hit this on the first attempt** (`delivered` on a new purchase).
- **Pass the `quote` object back into purchase.** The remote Router is **stateless** and does not
  retain the quote. `quoteId` alone gives you `quote_required`.
  You pass **5 things**: `quoteId` / `requestId` / `approval` / `quote` / `credential`
  (if you do not put the approved `quoteId` into `approval`, it stops with `approval_required`).
- **Build the `credential` with `npm run sign`. Do not assemble it by hand.** Same for remote use.
  Assembling by hand stops with `invalid_payment_header` (both `accepted` and
  `payload.challengeNonce` are required). The shape is as below, but **the signature has to be made
  with your local key**, so going through this tool is faster anyway:

  ```
  { x402Version: 2, accepted: <the quote's source.offer as-is>,
    payload: { challengeNonce, signature, authorization } }
  ```
- **The quote is valid for 10 minutes.** The approval window is also 10 minutes, and **the shorter
  one wins**. If it expires, take a new one and **get approval again**.
- **If it stops with `bucket_limit`, the cap was reached.** Stopping is itself the safety mechanism.

## What is working

| Item | Status |
|---|---|
| x402 inbound -> MPP outbound (P4) | **Settled on a real chain** |
| **MPP inbound -> x402 outbound (P5)** | **Settled on a real chain** |
| Outbound leg A (x402 / Base Sepolia) | **Settled for real** |
| Outbound leg B (MPP / Tempo) | **Settled for real** |
| MCP (local stdio / remote HTTP) | **Settled for real on both** |
| Real API reach for Providers A/B | **Reached** (real data fetched) |

### Both directions work

"Pay with the method you have, and you get bridged to the method the Provider requires" holds
**in both directions**:

| Route | Inbound tx | Outbound tx |
|---|---|---|
| x402 -> MPP | `0x239b6019…74a2` (block 47309247) | `0xe4477dfa…d491` (block 36922546) |
| **MPP -> x402** | `0xcbe845e4…d698` (block 36967307) | `0xb7ba21dc…b381` (block 47322681) |

Both are real settlements against the **hosted version** (`router.subethalabs.com`), and the outbound
leg is paid **by the operator wallet out of its own funds**.

**A note when checking in an explorer**: for x402 txs, `tx.from` is the **facilitator**
(measured `0xd407e409…`, the same no matter who pays). That is because with EIP-3009 the facilitator
submits and pays the gas. **Look at the Transfer log for the address that actually paid**
(for the outbound leg above, `0x5d78cbd6…` -> Provider A). Looking only at `tx.from` makes it look
like someone else's payment.

The hosted Router lists **ten static routes and twenty dynamic profiles** (since 2026-10-08; trust the current listing). The original two:

| routeId | Inbound | Outbound |
|---|---|---|
| `md-mpp-eth-snapshot` | x402 (Base Sepolia USDC) | MPP (`subetha-provider-mpp`) |
| `md-x402-eth-snapshot` | MPP (Tempo pathUSD) | x402 (`subetha-provider-x402`) |

**Two more inbound rails are enabled on the hosted Router since 2026-10-07** (G-4;
`RAILS_ACTIVATION` in `tools/remote-mcp-config.ts` with `arc.inbound` and `solana.inbound` set to `true`; the switch is a code constant,
not an env, and setting them back to `false` removes them from the listing again):

| routeId | Inbound | Outbound |
|---|---|---|
| `md-mpp-eth-snapshot-arc` | x402 (Arc testnet USDC, facilitator: Circle) | MPP (`subetha-provider-mpp`) |
| `md-x402-eth-snapshot-sol` | x402 (Solana devnet USDC, facilitator: x402.org, SVM `exact`) | x402 (`subetha-provider-x402`) |

**Outbound rails** (paying providers that accept only Arc or Solana) sit behind the same one-constant switch, per direction
(`RAILS_ACTIVATION = { arc: { inbound, outbound }, solana: { inbound, outbound } }`); **outbound was switched on at G-4′ (2026-10-08)** after six acceptance purchases
to the operator's own Arc and Solana providers (Cloudflare Workers, `providers/x402-workers/`); the hosted Router carries it from the image swap recorded in `docs/DEPLOY.md` §2c. The Arc outbound routes
(`md-arc-eth-snapshot`, `dyn-x402-to-arc`, `dyn-mpp-to-arc`) and the Solana outbound routes (`md-sol-eth-snapshot-mpp`: Tempo pathUSD in, Solana devnet USDC out through the x402
SVM `exact` scheme signed by the Router's own ed25519 key; `dyn-x402-to-sol`, `dyn-mpp-to-sol`) are in the listing while the switch is on. The Solana path builds the transfer
transaction itself (fixed shape: compute budget, SPL `TransferChecked`, memo), checks the compiled message independently of the builder, reserves its hash in the journal before
signing so the same message is never signed twice (also across a crash and restart), verifies the signature and the wire before the single send, and keeps a per-purchase balance
pre-check; all of this is covered by fixture tests including child-process SIGKILL interruption tests, and by two independent signing-boundary reviews.

**MPP on Solana, both directions, is on the hosted Router since 2026-10-08** (G-4″; `RAILS_ACTIVATION.solanaMpp`, the same one-constant
switch, per direction; design `docs/mpp-solana-design.md`, rollout `docs/DEPLOY.md` §2d). The hosted listing has 10 routes and 20 profiles (the last two, `dyn-arc-to-sol` / `dyn-sol-to-arc`, since the G-4⁗ swap of 2026-10-08 18:52Z recorded in `docs/DEPLOY.md` §2c-2). Inbound: the caller pays
**Solana devnet USDC over MPP** (`solana/charge`); the Router issues the challenge itself, verifies the fully-signed transaction the caller
hands it (structure, amount, Memo, signature; no chain read), broadcasts it once at purchase and follows the confirmation
(`md-x402-eth-snapshot-solmpp`, `md-mpp-eth-snapshot-solmpp`, `dyn-solmpp-to-*`). Outbound: the Router pays a provider that accepts only
that (`md-solmpp-eth-snapshot`, `md-solmpp-eth-snapshot-mpp`, `dyn-*-to-solmpp`) with its own Solana key, rebuilding the transfer from the
approved values, reserving the message hash before signing and verifying the provider's receipt against the chain; the provider's fee payer
broadcasts, so the Router pays no chain fee on that leg. Covered by fixture tests (real `@solana/pay-kit` client and server in the fixtures,
in-process and child-process interruption tests) and by independent reviews per task. The operator's Solana MPP provider (`providers/mpp-solana-workers/`,
a Cloudflare Worker wrapping `@solana/pay-kit`'s server, `docs/provider-mpp-solana-workers.md`) runs at `provider-mpp-sol.subethalabs.com`, and the
**G-3″ acceptance purchases of 2026-10-08** (three inbound over MPP on Solana, three outbound to that provider, all `delivered`, all six Solana transactions
finalized; records in `docs/DEPLOY.md` §2d) preceded the switch-on.

What is verified for them: fixture tests of the whole path (in-process, no chain), **one live `/verify` each** against Circle and
x402.org with disposable keys, and the **G-3 acceptance purchases of 2026-10-07** with disposable payers in the production environment
(Arc static and dynamic → Tempo: delivered; Solana static and dynamic → Base: delivered with finalized signatures; records in
`docs/DEPLOY.md` §2c). `npm run sign` handles both offers (EIP-3009 on Arc; a
partially-signed Solana transaction that the facilitator's fee payer submits), and refuses any offer whose network or asset is not in the
Router's table. `npm run wallet:new:solana` creates a Solana key; `npm run wallet:balance` shows Base Sepolia USDC only.

**A note when paying with MPP**: with x402 the facilitator submits and pays the gas, but
**with MPP the caller broadcasts themselves and pays the fee too**.
That fee **is not determined by the payment amount and is not predictable**. For the exact same
payment of 10000, we have measured **505 / 945 / 2283 / 23370** (about a 50x spread).
**Do not estimate from these numbers.**
**A payment that fails after broadcast does not come back.**
If you are just trying it once, x402 is easier.

Because of that, **the meaning of `npm run sign` changes with the rail**:

| Inbound rail | `npm run sign` |
|---|---|
| x402 (`md-mpp-eth-snapshot`) | **Signs only.** No funds move yet |
| MPP (`md-x402-eth-snapshot`) | **Sends funds on the spot.** Get approval **before this** |
| x402 on Arc or Solana (when enabled) | **Signs only.** On Solana the facilitator's fee payer submits and pays the fee; your key never pays SOL |
| MPP on Solana (`md-*-solmpp`, when enabled) | **Signs only** (a fully-signed transaction). The Router broadcasts it at purchase; **your key pays the fee, so you need devnet SOL**. Call purchase right away: the blockhash lives about a minute |

A defect found while adding that row: since 2026-10-07 the sign tool's common nonce check accepted only the `0x` hex form, which is
what the x402 adapters issue, while both MPP adapters (Tempo and Solana) use the mppx challenge id (base64url). `npm run sign` therefore
refused every Tempo MPP offer with "no well-formed challengeNonce". Fixed on 2026-10-08 (M6) with a regression test that signs a real
adapter's offer.

**Not verified yet**:

- **Real settlement of the SubEtha inbound leg** (still the synthetic facilitator). -> **AC-4 is not met**
- Same-protocol, different chain: x402 -> x402 is covered by the Solana -> Base acceptance purchases (G-3, 2026-10-07) and MPP -> MPP by the Solana devnet <-> Tempo MPP acceptance purchases (2026-10-08); **same-protocol on the same chain (e.g. MPP Tempo -> MPP Tempo) is not a route and is not verified**
- **MPP on Solana (both directions): only the acceptance purchases recorded on 2026-10-08** (static and dynamic in each direction, testnets; `docs/public-brief-2026-10-08.md` has the full list); no sustained operation yet
- **Arc and Solana inbound: only the four acceptance cases** (static and dynamic on each rail, testnets, 2026-10-07; six attempts in
  total, five delivered and one `unknown` whose payment settled on chain without delivery, which led to the SVM follow-up in
  `docs/DEPLOY.md` §2c); no sustained operation yet, and the hosted entry does not forward the child Router's stderr (§2c says what to look at instead)
- **Replay prevention for MPP inbound across restarts, on a real chain**. The SDK's replay state is in-process
  and is lost on restart. The Router now refuses an MPP credential whose embedded challenge is not the one
  issued for that quote, and a quote runs at most once (journal). Fixture tests cover the adapter's refusal
  of another quote's credential; the check keeps no state, so it does not depend on the process surviving.
  Replay across a restart has not been exercised end to end with real receipts or real funds, and the SDK
  binds a transfer to its challenge through a 56-bit memo tag, not the full challenge id
- finality is not determined by the Router itself (results report `onChainFinality: not_checked`); the acceptance records and `docs/mainnet-first-route.md` verified finality afterwards by reading the chains
- **Real UI integration** with the existing chat (integration with the execution layer is confirmed. T5)

Payments on the hosted Router are **testnet only**. One owner-run mainnet purchase (Tempo mainnet USDC.e over MPP → an x402-only API on Base mainnet, 2026-10-10) was made with the same code bound to loopback; see `docs/mainnet-first-route.md`. The market data reads mainnet reference values, but **these are not
tradable quotes**. Providers A/B are **hosted by us**, and this is not a claim that Hyperliquid or
Uniswap support these payment methods.

## Dynamic upstream URLs (twenty profiles enabled on the hosted Router)

A caller can name **its own upstream URL** (a third-party x402 or MPP provider) and pay for it over the
other rail: pay in Base Sepolia USDC (x402) for an MPP upstream, or in Tempo pathUSD (MPP) for an x402
upstream. The Router selects the first offer that passes the profile's checks, prices it (upstream amount +
the Router's fee; for an MPP upstream the fee is set per quote from a gas-cost estimate of that very transfer,
read from the chain without signing, so the caller always prepays at least the chain-fee cap the Router will
sign under -- `docs/dynamic-gas-fee-design.md`), issues the inbound offer, and only after the inbound payment is verified does it pay the
upstream — rebuilding the signed EIP-3009 authorization or the Tempo transaction itself from the approved
values, so the SDK and the upstream can only propose, never widen, what the operator's key signs.

What is in place: anonymous use behind rate limits (per source, global, per destination host and address),
a quote ledger that keeps unpaid quotes out of the journal, an `ownerKey` that makes a dynamic quote
readable and executable only by whoever took it, the SSRF defences applied to every dynamic connection
(no loopback, DNS deadline, header and body caps, the Router's own dependencies denied as destinations by
hostname — another name resolving to the same service is not denied, a limitation the design accepts),
and a dynamic budget counted separately from the static routes. All of this is covered by unit, wire and
integration tests that run the product wiring with real keys and real SDKs against local fixtures
(`tests/wire/dynamic-integration.test.ts`), on macOS and Linux.

Real-network check (testnet, 2026-10-06, a local Router built from the production config with the
feature enabled): one dynamic purchase in each direction against the operator's providers **settled on
both chains** (x402→MPP: inbound `0x40c42b34…c4f` on Base Sepolia, outbound `0x4b117218…1a2` on Tempo
with a 29 base-unit fee; MPP→x402: inbound `0xff82c44f…d8b`, outbound `0x64f7acde…a88`), and the quote
step succeeded for 11 of 21 third-party Base Sepolia providers with unpaid reads.

On the hosted Router (since 2026-10-06) both profiles are enabled: `dyn-mpp-to-x402` (pay in Tempo
pathUSD for any x402 upstream on Base Sepolia) and `dyn-x402-to-mpp` (pay in Base Sepolia USDC for any
MPP upstream on Tempo). For the MPP-outbound profile the fee is set per quote from a gas-cost estimate
and the Router chooses the fee price itself (priority 1 wei, `maxFeePerGas` from the latest baseFee);
the chain-fee bound was established from the Tempo fee specification and the v1.16.0 node source
(`docs/dynamic-gas-fee-design.md` §7–§8).
The design and the task record live in `docs/dynamic-upstream-*.md`.

## Not verified yet

**Real settlement is reached for all four legs in use** -- x402 inbound, MPP inbound, x402 outbound and MPP
outbound -- and each has been verified independently on chain (see the txs above). However, the hosted Router is
**testnet only** (the one mainnet purchase of 2026-10-10 was made on the owner's machine, `docs/mainnet-first-route.md`),
and the following remain behind separate gates, **not done**.

- **Real settlement of the SubEtha inbound leg.** The inbound side is still the synthetic facilitator, and the
  real facilitator is only in a state where it can be run locally (anvil chainId 31337). -> **AC-4 is not met.**
  Note that U-01/U-02 (schema, field names) are settled from the implementation source, and
  **the remaining obstacle is not the schema but deployment to a public testnet**.
- **Real UI integration** with the existing chat (operation in the browser, `server.mts` / `ui.js`).
  Real TCP integration with the chat's **execution layer** (`createRouterChatExecution`), and R4 re-fetch and
  reopen through it, are confirmed (T5). Causality on the real UI is a separate gate.
  Note that the chat contract requires `rail === 'subetha'`, so **the x402 inbound route cannot be used from chat**.
- **Confirmation of finality by the Router itself** (it reports `not_checked`); the acceptance records verified finality afterwards by reading the chains.
- **Reproduction from a clean install.** clone -> build -> startup on EC2 has been done, but other environments
  (non-Linux, different architectures) are not verified.
- MPP's `pull` mode (server-side broadcast) is **not verified**. The adapter refuses before credential generation
  **only when the capability explicitly states `mode: "pull"`**; if `mode` is omitted, the choice is left to the
  SDK, and depending on the challenge's `supportedModes` and the account type, `pull` can be chosen. That path is
  **not confirmed** (it cannot be said that there is a guard).
- **Same-rail coverage** (x402 -> x402 / MPP -> MPP) is **not verified**. Both *cross*-rail directions are
  settled on a real chain -- see the table above.
- **Dynamic upstream URLs over MPP outbound** (paying an MPP upstream with USDC) are enabled in
  production since 2026-10-06 on the **testnet** assumption that a 1-wei priority fee is included (block
  utilization is far below capacity); it is not a mainnet assumption. Gates are
  recorded in `docs/dynamic-upstream-tasks.md`.

## Where the detail went

This file is the entry point. The working records live next to it:

| Document | What is in it |
|---|---|
| [`docs/ENGINEERING.md`](docs/ENGINEERING.md) | HTTP contract, purchase lifecycle, journal, env wiring, commands, settlement evidence with transaction hashes, MCP tool reference, running it locally |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Deploying the hosted Router (EC2 + Docker + TLS) |
| [`CLAUDE.md`](CLAUDE.md) | The steps an agent follows to pay through this Router |
| [`docs/`](docs/) | Requirements and design per phase (Japanese) |

## Sources and license

- The source in this repository was newly written, and no code from the earlier `subetha-payment-router` PoC was
  copied. The PoC's results do not count as verification of this submission.
- The official `@zerc20/sdk` and the BUSL sources are neither vendored nor redistributed.
- `fs-ext` (MIT) is only fetched as an external dependency, and is not taken into the repository.
- The Router and payer code in this repository is licensed under the MIT license ([`LICENSE`](LICENSE)).
  Dependencies keep their own licenses.

