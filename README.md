# SubEtha Router

A Router for when **the payment method an agent holds** does not match
**the payment method an API provider demands**.

**Hold only x402? You can still use a provider that accepts only MPP.**

```
caller ──(1) x402 / Base Sepolia USDC──> Router ──(2) MPP / Tempo pathUSD──> Provider
```

The 2 legs are **independent payments, not an exchange and not a bridge**. There is no FX conversion.

## Try it now

Pay **with your own key** and use the remote Router.

```sh
git clone https://github.com/subetha-labs/subetha-router.git
cd subetha-router
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm rebuild fs-ext --foreground-scripts --no-audit --no-fund

# 1) Create a disposable wallet
npm run wallet:new
#    -> Save the displayed key to .env.local, and fund the address with Base Sepolia USDC
#      https://faucet.circle.com (network: Base Sepolia / token: USDC)
#      **No gas (ETH) needed** - with EIP-3009 the facilitator submits and pays the gas

npm run wallet:balance   # 10000 base units (0.01 USDC) per run is enough

# 2) Register the remote Router
claude mcp add --transport http subetha-router https://router.subethalabs.com/mcp
```

Permission to run `npm run sign` is in `.claude/settings.json` (included in the clone).
**Without it the agent stops at the signing step**, so do not delete it.

Then start Claude Code **in this directory** and ask it something like:

> I only have Base Sepolia USDC. What's the reference price of ETH?

**Say what you hold, not which tool to use.** The agent reads the routes and works out that
the provider it needs takes only pathUSD on Tempo, which you do not have — and that the
Router will bridge it. Naming the tool works too, but then you have made the interesting
decision for it.

The agent takes a quote, **asks for approval**, creates a signature from your local key with
`npm run sign`, and proceeds through purchase (the steps are written in `CLAUDE.md`).

**Why the clone is needed**: to create the inbound leg signature **on your own machine**.
The Router does not hold the caller's key, so the signing capability has to be local.
**The key does not go out over the network** (only the signed `credential` does).

**Measured** (results of running this procedure against the production endpoint):

| Leg | Real tx |
|---|---|
| Inbound (x402 / Base Sepolia) | `0x61434be7...4a3a` (block 47308787) |
| Outbound (MPP / Tempo Moderato) | `0x703ea3c0...a582` |

### Notes

- **Leave a few seconds between payments.** The public x402 facilitator hits nonce collisions on
  back-to-back runs (measured: 2/20 failures at 0ms spacing, 0/15 with 3 seconds of spacing).
- **`paid_data_unavailable` can come back.** This is the state where the payment went through but
  fetching the data failed, and **the funds have moved**. The Router **does not auto-retry** (to
  avoid double payment). Retrying will go through.
  **This is not rare**: there is a real case from another environment where a real settlement
  **hit this on the first attempt** (`delivered` on retry).
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

The hosted version has 2 routes:

| routeId | Inbound | Outbound |
|---|---|---|
| `md-mpp-eth-snapshot` | x402 (Base Sepolia USDC) | MPP (`subetha-provider-mpp`) |
| `md-x402-eth-snapshot` | MPP (Tempo pathUSD) | x402 (`subetha-provider-x402`) |

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

**Not verified yet**:

- **Real settlement of the SubEtha inbound leg** (still the synthetic facilitator). -> **AC-4 is not met**
- Same-rail (x402 -> x402 / MPP -> MPP) is **not verified**
- **Replay prevention for MPP inbound across restarts, on a real chain**. The SDK's replay state is in-process
  and is lost on restart. The Router now refuses an MPP credential whose embedded challenge is not the one
  issued for that quote, and a quote runs at most once (journal). Fixture tests cover the adapter's refusal
  of another quote's credential; the check keeps no state, so it does not depend on the process surviving.
  Replay across a restart has not been exercised end to end with real receipts or real funds, and the SDK
  binds a transfer to its challenge through a 56-bit memo tag, not the full challenge id
- finality (the mined/canonical determination)
- **Real UI integration** with the existing chat (integration with the execution layer is confirmed. T5)

Payments are **testnet only**. The market data reads mainnet reference values, but **these are not
tradable quotes**. Providers A/B are **hosted by us**, and this is not a claim that Hyperliquid or
Uniswap support these payment methods.

## Dynamic upstream URLs (implemented, disabled on the hosted Router)

A caller can name **its own upstream URL** (a third-party x402 or MPP provider) and pay for it over the
other rail: pay in Base Sepolia USDC (x402) for an MPP upstream, or in Tempo pathUSD (MPP) for an x402
upstream. The Router selects the first offer that passes the profile's checks, prices it (upstream amount +
a flat fee), issues the inbound offer, and only after the inbound payment is verified does it pay the
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

What is **not** done: it is **off in production** (`dynamic.enabled: false`, one line in
`tools/remote-mcp-config.ts`), and the MPP-outbound fee bound is observed rather than established from
the Tempo fee specification (the caller's fee covers it under that assumption, which the Router checks at
startup). The design and the task record live in `docs/dynamic-upstream-*.md`.

## Not verified yet

**Real settlement is reached for all four legs in use** -- x402 inbound, MPP inbound, x402 outbound and MPP
outbound -- and each has been verified independently on chain (see the txs above). However, it is
**testnet only**, and the following remain behind separate gates, **not done**.

- **Real settlement of the SubEtha inbound leg.** The inbound side is still the synthetic facilitator, and the
  real facilitator is only in a state where it can be run locally (anvil chainId 31337). -> **AC-4 is not met.**
  Note that U-01/U-02 (schema, field names) are settled from the implementation source, and
  **the remaining obstacle is not the schema but deployment to a public testnet**.
- **Real UI integration** with the existing chat (operation in the browser, `server.mts` / `ui.js`).
  Real TCP integration with the chat's **execution layer** (`createRouterChatExecution`), and R4 re-fetch and
  reopen through it, are confirmed (T5). Causality on the real UI is a separate gate.
  Note that the chat contract requires `rail === 'subetha'`, so **the x402 inbound route cannot be used from chat**.
- **Confirmation of finality** (the mined / canonical determination).
- **Reproduction from a clean install.** clone -> build -> startup on EC2 has been done, but other environments
  (non-Linux, different architectures) are not verified.
- MPP's `pull` mode (server-side broadcast) is **not verified**. The adapter refuses before credential generation
  **only when the capability explicitly states `mode: "pull"`**; if `mode` is omitted, the choice is left to the
  SDK, and depending on the challenge's `supportedModes` and the account type, `pull` can be chosen. That path is
  **not confirmed** (it cannot be said that there is a guard).
- **Same-rail coverage** (x402 -> x402 / MPP -> MPP) is **not verified**. Both *cross*-rail directions are
  settled on a real chain -- see the table above.
- **Dynamic upstream URLs in production** (fee values G-1, enabling G-4) are **not done**; the testnet gates
  G-2 and G-3 are recorded in `docs/dynamic-upstream-tasks.md`.

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

