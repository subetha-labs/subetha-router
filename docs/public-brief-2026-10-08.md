# SubEtha Router — public brief (as of 2026-10-08; updated 2026-10-08 19:00Z after the last two pairs, Arc x402 ↔ Solana x402, were enabled and purchased)

Source material for the official site, announcements and the hackathon submission. Every statement here is backed by a record in this repository; the pointers are in §7. Nothing here is a promise about mainnet.

## 1. One-paragraph description

SubEtha Router is a proof of concept, on testnets only, that lets an AI agent pay for an HTTP resource over one payment rail while the provider is paid over another. The caller pays the Router over x402 (Base Sepolia USDC, Arc testnet USDC or Solana devnet USDC) or over MPP (Tempo pathUSD or Solana devnet USDC); the Router pays the provider over whichever of those five the provider accepts and returns the provider's response. It is exposed as a hosted MCP server, and the Router never holds the caller's key: the caller signs the inbound payment locally and hands the Router a credential. Each of the five rails has been settled end to end on testnets in both directions, with both legs confirmed on chain, and all 20 cross-rail pairs are offered and have been purchased end to end on testnets (12 during the rollouts of 2026-10-05 … 2026-10-08, 6 more on 2026-10-08 17:41–17:52Z, and the last 2, Arc x402 ↔ Solana x402, on 2026-10-08 18:42–18:54Z; see §3).

## 2. What is live on the hosted Router

- Endpoint: `https://router.subethalabs.com/mcp` (MCP over HTTPS; tools `subetha_router_list_routes`, `subetha_router_quote`, `subetha_router_quote_url`, `subetha_router_purchase`, `subetha_router_status`).
- Image `b-d162524` since 2026-10-08 18:52Z; all five rails enabled inbound and outbound, plus the Arc x402 ↔ Solana x402 pair (`pairs` switch, G-4⁗).
- Listing: 10 static routes, 20 dynamic profiles.

### 2.1 Rails

| rail | network (CAIP-2) | asset | inbound (caller pays the Router) | outbound (Router pays the provider) | live since |
|---|---|---|---|---|---|
| x402 `exact` | Base Sepolia `eip155:84532` | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | yes | yes | 2026-10-05 (original) |
| MPP `tempo/charge` | Tempo testnet `eip155:42431` | pathUSD `0x20c0000000000000000000000000000000000000` | yes | yes | 2026-10-05 (original) |
| x402 `exact` (EIP-3009) | Arc testnet `eip155:5042002` | USDC `0x3600000000000000000000000000000000000000` | yes (2026-10-07) | yes (2026-10-08, G-4′) | |
| x402 `exact` (SVM) | Solana devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | yes (2026-10-07) | yes (2026-10-08, G-4′) | |
| MPP `solana/charge` | Solana devnet (same) | USDC (same mint) | yes (2026-10-08, G-4″) | yes (2026-10-08, G-4″) | |

Five inbound means × five outbound means. Same-rail pairs (for example x402 Base → x402 Base) are deliberately not offered. That leaves 20 cross-rail pairs, all reachable through dynamic profiles (the Arc x402 ↔ Solana x402 pair since 2026-10-08 18:52Z, as `dyn-arc-to-sol` / `dyn-sol-to-arc`, dynamic only); 10 of them also exist as static routes.

### 2.2 Static routes (operator-fixed providers)

| routeId | caller pays | provider paid over | provider |
|---|---|---|---|
| `md-mpp-eth-snapshot` | Base Sepolia USDC (x402) | MPP Tempo | B |
| `md-x402-eth-snapshot` | Tempo pathUSD (MPP) | x402 Base | A |
| `md-mpp-eth-snapshot-arc` | Arc testnet USDC (x402) | MPP Tempo | B |
| `md-x402-eth-snapshot-sol` | Solana devnet USDC (x402) | x402 Base | A |
| `md-arc-eth-snapshot` | Base Sepolia USDC (x402) | x402 Arc | Arc Worker |
| `md-sol-eth-snapshot-mpp` | Tempo pathUSD (MPP) | x402 Solana | Solana Worker |
| `md-x402-eth-snapshot-solmpp` | Solana devnet USDC (MPP) | x402 Base | A |
| `md-mpp-eth-snapshot-solmpp` | Solana devnet USDC (MPP) | MPP Tempo | B |
| `md-solmpp-eth-snapshot` | Base Sepolia USDC (x402) | MPP Solana | D |
| `md-solmpp-eth-snapshot-mpp` | Tempo pathUSD (MPP) | MPP Solana | D |

All static routes sell the same demo resource: an ETH/USDC snapshot (`/v1/eth/snapshot`, a Uniswap v3 pool spot reference with a disclaimer; not a tradable quote) for 10,000 base units (0.01 USDC or pathUSD).

### 2.3 Dynamic profiles (caller-chosen upstream URL)

`dyn-<source>-to-<destination>` where `x402` = Base Sepolia USDC over x402, `mpp` = Tempo pathUSD over MPP, `arc` = Arc testnet USDC over x402, `sol` = Solana devnet USDC over x402, `solmpp` = Solana devnet USDC over MPP:

`dyn-x402-to-mpp`, `dyn-x402-to-arc`, `dyn-x402-to-sol`, `dyn-x402-to-solmpp`, `dyn-mpp-to-x402`, `dyn-mpp-to-arc`, `dyn-mpp-to-sol`, `dyn-mpp-to-solmpp`, `dyn-arc-to-x402`, `dyn-arc-to-mpp`, `dyn-arc-to-sol`, `dyn-arc-to-solmpp`, `dyn-sol-to-x402`, `dyn-sol-to-mpp`, `dyn-sol-to-arc`, `dyn-sol-to-solmpp`, `dyn-solmpp-to-x402`, `dyn-solmpp-to-mpp`, `dyn-solmpp-to-arc`, `dyn-solmpp-to-sol`.

The caller names a public `https` URL of a third-party x402 or MPP provider whose 402 meets the supported constraints: the destination rail's scheme (`exact` or `tempo/charge` / `solana/charge`), an asset and network in the Router's table, a price within the cap, no redirects, and the URL and challenge-field restrictions in `docs/dynamic-upstream-design.md` (§4 there). The Router reads the provider's 402, quotes upstream price + Router fee, and after the caller's inbound payment settles, pays the provider with its own key and returns the body.

### 2.4 Our reference providers (for demos; not a product)

| name | accepts | URL | hosting |
|---|---|---|---|
| Provider A | x402, Base Sepolia USDC | `https://provider-x402.subethalabs.com/v1/eth/snapshot` | our own |
| Provider B | MPP, Tempo pathUSD | `https://provider-mpp.subethalabs.com/v1/eth/snapshot` | our own |
| Arc Worker | x402, Arc testnet USDC | `https://provider-x402-arc.subethalabs.com/v1/eth/snapshot` | Cloudflare Workers |
| Solana Worker | x402, Solana devnet USDC | `https://provider-x402-sol.subethalabs.com/v1/eth/snapshot` | Cloudflare Workers |
| Provider D | MPP, Solana devnet USDC (`@solana/pay-kit` server, provider as fee payer) | `https://provider-mpp-sol.subethalabs.com/v1/eth/snapshot` | Cloudflare Workers |

## 3. Claims that are safe to publish

- Cross-rail payment routing between x402 and MPP, in both directions, on five rail/asset combinations across four testnets (Base Sepolia, Arc testnet, Tempo testnet, Solana devnet); also x402 → x402 across chains (Base/Arc/Solana) and MPP → MPP across chains (Tempo/Solana).
- Settled end to end on testnets, with both legs' transaction hashes/signatures, finality, balance deltas and the provider's response in the acceptance records: Base x402 ↔ Tempo MPP (both directions, static and dynamic); Arc x402 → Tempo MPP (static and dynamic); Solana x402 → Base x402 (static and dynamic); Base x402 → Arc x402 (static and dynamic); Tempo MPP → Arc x402 (dynamic); Tempo MPP → Solana x402 (static and dynamic); Base x402 → Solana x402 (dynamic); Solana MPP → Base x402 (static and dynamic); Solana MPP → Tempo MPP (dynamic); Base x402 → Solana MPP (static and dynamic); Tempo MPP → Solana MPP (dynamic); and, purchased on 2026-10-08 17:41–17:52Z against the hosted Router (`b-3606fb6`, dynamic profiles, `docs/DEPLOY.md` §2e): Arc x402 → Base x402; Solana x402 → Tempo MPP; Solana MPP → Arc x402; Solana MPP → Solana x402; Arc x402 → Solana MPP; Solana x402 → Solana MPP; and, enabled and purchased on 2026-10-08 (acceptance start 18:42Z, hosted Router `b-d162524` 18:54Z; `docs/DEPLOY.md` §2c-2): Arc x402 → Solana x402; Solana x402 → Arc x402. That is all 20 offered pairs and every rail inbound and outbound.
- Until 2026-10-08 17:41Z the six profiles `dyn-arc-to-x402`, `dyn-sol-to-mpp`, `dyn-solmpp-to-arc`, `dyn-solmpp-to-sol`, `dyn-arc-to-solmpp`, `dyn-sol-to-solmpp` had only been quoted (AC-18, 2026-10-08 15:43–16:07Z) and covered by the wire test matrix; since the purchases of 2026-10-08 17:41–17:52Z they are settled like the others (both legs on chain, balance deltas, provider body delivered, status re-readable from the saved ids). One honest detail to keep: the first attempt on `dyn-arc-to-x402` ended `paid_data_unavailable` (the caller's Arc payment settled, Provider A rejected the Router's Base payment without a receipt, nothing refunded, cause not identified from the hosted entry); the retry ten minutes later delivered. 7 purchases, 6 delivered.
- The Router never holds the caller's key. The caller signs locally (`npm run sign` in the repository detects the rail from the quote) and only the credential travels.
- Dynamic upstreams: an agent can pay a compatible public x402 or MPP provider URL on a supported rail without the operator having configured it (compatible = the provider's 402 meets the constraints in §2.3).
- Hosted as an MCP server over HTTPS, usable from Claude Code or any MCP client.
- Safety properties that were designed and reviewed: explicit human approval before any payment, idempotent quotes per request id, fingerprinted quotes (the Router refuses if the provider's terms change), SSRF defences (application guard plus host egress control), per-purchase and cumulative budgets, no retries that could double-pay.

### 3.1 One mainnet purchase (2026-10-10, owner-only, not on the hosted Router)

- An agent holding **Tempo mainnet USDC.e** paid over **MPP** and received data from `crypto.apitoll.cloud/v1/crypto/price`, a third-party API that accepts **only x402** (Base mainnet USDC / Solana). The Router paid the provider over x402 on Base mainnet with its own key. Both legs are on chain: inbound Tempo `0x4ea7d6c2…a0b8` (2,000 base units = 0.002 USDC.e: provider price 0.001 + Router fee 0.001), outbound Base `0x699cd8f2…e71a` (1,000 base units = 0.001 USDC, settled by the provider's facilitator). The delivered body was a JSON object with BTC/ETH/SOL prices. Record: `docs/mainnet-first-route.md` §3.
- Scope of that claim: the same Router code, run on the owner's machine bound to loopback with a mainnet-only configuration, owner-funded disposable wallets on both sides, a $0.06 budget cap, one dynamic profile, stopped afterwards. The hosted Router stayed testnet-only and unchanged. The mainnet prerequisites in `docs/dynamic-upstream-requirements.md` §7 (refund policy, asset pairing, compliance) remain open; this was a bounded exception, not a launch.
- A first attempt the same day failed before settlement (`invalid_payment_header`) because the operator's script passed the MPP credential without the Router's envelope; the caller's 0.002 USDC.e (2,000 base units) went to the owner's own receiving wallet and nothing was paid to the provider. The second attempt delivered.
- Two providers were tried first and refused by the Router's own safety checks, not by the providers: Pinata (MPP-only) rotates its recipient address on every challenge, which the pre-settlement re-read treats as a changed offer; CoinGecko's x402 `resource.url` omits the query string, which fails the exact resource binding. Neither check was relaxed.

## 4. Caveats to state alongside

- Testnets only; proof of concept; the operator can switch any rail off with one constant (clients must trust the live listing).
- Amounts are small: static price 0.01; dynamic upstream price capped at 0.01 plus a Router fee of 0.001 (for Tempo-destination profiles the fee is the larger of 0.001 and a gas-derived cap taken at quote time, ceiling 0.05, and the Router refuses with `fee_too_high` if the chain fee later exceeds the cap). Per-purchase budget caps: static 10,000 base units per bucket; dynamic 20,000 per bucket, 21,000 for the Solana USDC bucket whose two legs can share it.
- Dynamic upstreams are not verified by the operator; nothing is refunded if the provider takes the payment and returns no usable data, or if the Router itself refuses after the caller's funds moved. Only `GET` and an `application/json` object up to 256 KiB are delivered.
- Rate limits: dynamic quotes 3 per minute per caller, 10 per minute per upstream host, 2 concurrent per host.
- MPP on Tempo moves funds when the credential is built (before purchase); MPP on Solana with our sign tool only signs, and the Router broadcasts at purchase (the caller's key pays the devnet SOL fee). A failed or `unknown` purchase on an MPP rail does not prove that nothing was paid.
- MPP on Solana outbound is the pull form only (the provider's fee payer co-signs and broadcasts); the push form is not implemented.
- Same-rail pairs are not offered. The `priceUsdcPerWeth` in the demo resource is a pool spot reference, not a quote.
- The hosted entry forwards only the Router's public outcomes, not its diagnostics; `unknown` outcomes are recorded durably and never retried.

## 5. Suggested wording

Short:

> SubEtha Router (PoC, testnets only) bridges payment rails in both directions: an agent pays over x402 (Base Sepolia USDC, Arc testnet USDC, Solana devnet USDC) or MPP (Tempo pathUSD, Solana devnet USDC) and reaches a provider that accepts one of the others (all 20 cross-rail pairs), through a hosted MCP server that never holds the caller's key. Every rail has been settled end to end on testnets in both directions and every pair has been purchased end to end; caps are small and dynamic upstreams are unverified.

Longer (three sentences for a site section):

> Agents and providers do not always speak the same payment protocol. SubEtha Router sits between them: the agent pays the Router on the rail it can use, and the Router pays the provider on the rail the provider accepts, then returns the provider's response. Today, on testnets, that covers x402 on Base Sepolia, Arc and Solana devnet and MPP on Tempo and Solana devnet, inbound and outbound, with the agent's key never leaving the agent.

## 6. Timeline (for a changelog)

| date (UTC) | milestone |
|---|---|
| 2026-10-05 | Hosted Router on the new host; x402 Base ↔ MPP Tempo in both directions purchased end to end |
| 2026-10-06 | Dynamic upstream URLs enabled (caller-chosen providers), both directions |
| 2026-10-07 | Inbound Arc testnet USDC and Solana devnet USDC (x402) enabled |
| 2026-10-08 | Outbound Arc and Solana (x402) enabled (G-4′); MPP on Solana enabled inbound and outbound (G-4″); the shared-bucket cap fix (PR #116); production image `b-3606fb6` |
| 2026-10-08 (17:41–17:52Z) | The remaining six dynamic pairs purchased end to end on the hosted Router (G-5); every offered pair now settled on testnets; one first attempt ended paid-no-data and was retried |
| 2026-10-10 (08:05Z) | First mainnet purchase: Tempo mainnet USDC.e over MPP → Router (owner's machine, loopback) → x402 on Base mainnet to a third-party x402-only API; delivered, both legs on chain (`docs/mainnet-first-route.md`) |
| 2026-10-08 (18:40–18:54Z) | Arc x402 ↔ Solana x402 added as dynamic profiles (D-17; G-2⁗ deploy, G-3⁗ acceptance purchases, G-4⁗ enable, image `b-d162524`); both purchased on the hosted Router; all 20 cross-rail pairs offered and settled |

## 7. Evidence pointers (repository)

- Deployment and gate records: `docs/DEPLOY.md` §2b (dynamic upstreams), §2c (Arc/Solana x402, G-1…G-4′), §2d (MPP on Solana, G-1″…G-4″ including AC-18), §2e (G-5: the remaining six pairs purchased on the hosted Router, 2026-10-08 17:41–17:52Z), §2c-2 (O-5/O-6 Arc x402 ↔ Solana x402: G-2⁗…G-4⁗, 2026-10-08 18:40–18:54Z).
- Designs: `docs/design.md` (core), `docs/dynamic-upstream-design.md`, `docs/dynamic-gas-fee-design.md`, `docs/multirail-design.md`, `docs/multirail-outbound-design.md`, `docs/mpp-solana-design.md`; requirements and task records next to each.
- Security: `docs/ssrf-requirements.md`, `docs/ssrf-app-guard-design.md`, `docs/ssrf-egress-design.md`.
- Providers: `docs/provider-x402-workers.md`, `docs/provider-mpp-solana-workers.md`, code under `providers/`.
- Agent-facing usage: `CLAUDE.md` (route table, signing steps, rail-specific warnings), `README.md`.
- Review trail: every task has an independent review row (Codex `gpt-6-astra`) in its tasks document; Linux test runs are recorded per PR.

## 8. Glossary

- Static route: a route whose provider URL the operator fixed in the Router's configuration and verified at deploy time; paid at the provider's price; identified by `routeId` (`md-…`).
- Dynamic profile: a rail pair the operator enabled; the caller supplies the provider URL at quote time; paid at provider price plus Router fee; identified by `profileId` (`dyn-…`); the quote carries an `ownerKey` the caller must keep to read the result.
- Inbound rail: how the caller pays the Router. Outbound rail: how the Router pays the provider.
- Credential: the caller's signed payment (x402 `X-Payment` value or MPP credential) produced locally and passed to `subetha_router_purchase`.
