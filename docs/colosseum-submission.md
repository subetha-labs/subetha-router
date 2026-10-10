# Colosseum Crypto World's Fair — submission kit (draft 1, 2026-10-10)

Owner decisions (2026-10-10): tracks **Tempo, Base, Solana**; the owner narrates both videos in English; the repository becomes public under MIT; the pitch should quantify what providers gain (reach they did not have) with sourced numbers.

Deadline: 2026-10-12 23:59 PT = **2026-10-13 15:59 JST**. Pitch video ≤ 3 min. Technical demo video 2–3 min. All content in English.

Everything below is honest to the repository's records. Numbers carry a source in §5; the matrix marks what is measured by us, what is third-party, and what is a forecast.

---

## 1. One-line framing

> SubEtha Router lets an AI agent pay for an API with the payment rail it holds, while the provider receives the rail it accepts — x402 or MPP, across Base, Solana, Arc and Tempo. A published local payer adds native human approval for every purchase on its supported route. Working testnet prototype, one bounded owner-run mainnet purchase.

Submission description (form; 590 characters, confirm the form's limit):

> Agents and paid APIs do not always share a protocol: x402 (Base, Solana) and MPP (Tempo) cannot pay each other. SubEtha Router sits between them: the agent pays the Router on the rail it has; the Router pays the provider on the rail it accepts from its own balance and returns the response. An MCP server that never holds the agent's key. All 20 cross-rail pairs settle on testnets; one bounded mainnet purchase (Router on the owner's machine) reached an x402-only API from an MPP wallet. `@subetha/payer` (npm) adds native human approval on its first route (Base Sepolia to Tempo testnet).

---

## 2. Pitch video script (399 spoken words in the quoted paragraphs: 3:04 at 130 wpm, 2:39 at 150 wpm; segment times below assume 150 wpm — the owner must time a read-through before recording and cut until the measured length is ≤ 2:50; "why", not a demo)

**[0:00–0:15] Founder and problem.**
"I'm Fujita, solo builder of SubEtha, after years building chains and cross-chain protocols. The problem I keep hitting: an agent finds the right paid API and still cannot pay, because the two sides speak different payment protocols."

**[0:15–0:45] Two ecosystems that cannot pay each other.**
"x402, started by Coinbase, passed 100 million transactions on Base in the first quarter of 2026; by August Solana carried about 70 percent of monthly x402 volume. MPP, Stripe's protocol on Tempo, launched in March with over 100 paid services. On October 10th I crawled its directory: 118 of 129 services advertise MPP as their only payment interface, one an x402 client does not speak. Pick one rail, and the other side cannot see you."

**[0:45–1:11] Product.**
"SubEtha Router is the bridge, a hosted MCP server. The agent takes a quote; with the local payer a human approves it in a native dialog; the agent pays the Router on its rail, the Router pays the provider on the provider's rail from its own balance and returns the response. Two independent payments. No swap, no key custody. A compatible provider changes nothing."

**[1:11–1:41] Evidence.**
"On testnets, all 20 cross-rail pairs, x402 on Base, Arc and Solana, MPP on Tempo and Solana, settle end to end, both legs on chain. On October 10th, running the Router on my own machine, I made one bounded mainnet purchase: an MPP wallet on Tempo bought from an API that accepts only x402 on Base. The local payer is on npm; its first route, Base Sepolia to Tempo testnet, works in Claude Code today."

**[1:41–2:18] What providers gain, and the business.**
"For providers the value is reach. A Tempo-only provider is paid only by agents holding Tempo stablecoins. Through the Router the x402 side could pay it too, an ecosystem past 100 million transactions, once its challenge is compatible and the mainnet prerequisites are met. Potential reach, not measured customers. The Router earns a routing fee per purchase: 0.001 in the agent's stablecoin on dynamic routes to x402 providers. Juniper expects agentic commerce to reach 1.5 trillion dollars by 2030. I need the first fifty providers who want buyers from the other rail."

**[2:18–2:40] Validation, honesty, ask.**
"This is engineering validation, not customer validation: a design-to-test trail for every feature, independent model reviews, fourteen agent-side issues found by dogfooding and those reviews. I'm looking for design partners: paid-API providers and agent developers who will run real purchases and tell me where it breaks. Testnet today, one mainnet route proven, prerequisites documented. Thank you."

Do not say in the pitch: partners, customers, audited, production-ready, all APIs, anonymous, or secure without qualification.

---

## 3. Technical demo video (target 2:50; "how")

Record on the owner's Mac. One real purchase through the published payer (testnet, Base Sepolia → Tempo MPP), then the mainnet evidence as recorded material. Keep a persistent on-screen label: **TESTNET** during the live part, **MAINNET (owner-run, loopback)** during the evidence part. Use a fresh security phrase; mask the passphrase; never show the key files.

| Time | On screen | Narration (owner) |
|---|---|---|
| 0:00–0:15 | Title card; the mismatch diagram: agent holds Base USDC → provider accepts only MPP on Tempo. Caption: "Provider: our reference Provider B (testnet)" | "The agent holds USDC on Base and speaks x402. The provider, our own reference provider for this demo, only accepts MPP on Tempo. Here is a purchase going through." |
| 0:15–0:30 | Terminal: `npm i -g @subetha/payer`, `subetha-payer daemon` already running; a fresh Claude Code session outside the repo with `claude mcp add --scope user subetha-payer -- subetha-payer mcp` | "The payer is on npm. The human starts a daemon that holds the key; Claude Code only talks to it through a local shim." |
| 0:30–0:50 | Claude Code: find_routes → quote; the subject (amount 0.01 USDC, decimals, recipient, deadline) | "The agent discovers the route and takes a quote. Nothing has been paid." |
| 0:50–1:15 | The native macOS dialog: security phrase, exact terms, passphrase entry, Approve | "Every purchase on this route is confirmed by a human in a native dialog: I check the security phrase I chose at startup and the exact terms, then enter my passphrase. Tool arguments cannot approve a payment. This relies on the payer's documented trust assumptions: an unmodified installation and runtime, an operating system that keeps other processes from inspecting the daemon or driving its dialog, and a security phrase I keep to myself." |
| 1:15–1:40 | purchase → `delivered`; the provider's JSON; `subetha_payer_status` showing the saved ref | "The Router paid the provider over MPP from its own balance and returned the data. The result is saved locally with its reference." (If the restart is shown: stop and restart the daemon on camera, then read the status again; otherwise do not claim reopening.) |
| 1:40–2:00 | Explorer pages for **that** purchase (same paymentId and tx hashes as the result on screen): Base Sepolia transfer from my wallet to the Router; Tempo transfer from the Router to the provider. Caption: "recorded after the purchase; waits cut" | "Two independent payments, both on chain. The agent's key never left the machine." |
| 2:00–2:20 | Architecture diagram: Claude → stdio shim → local daemon → HTTPS Router (MCP) → provider; two payment arrows; hash-chained ledger | "Design choices: the hosted Router never holds the caller's key; the daemon writes a hash-chained ledger before every side effect; an uncertain outcome is never retried blindly." |
| 2:20–2:40 | Recorded evidence, dated 2026-10-10: the mainnet purchase — Tempo mainnet inbound tx, Base mainnet outbound tx to the x402-only API, the delivered JSON. Caption: "2026-10-10, Router run on the owner's machine, loopback only, signed with the repository's tools" | "The same Router code, run on my machine, made one mainnet purchase on October 10th: an MPP wallet on Tempo bought from an API that accepts only x402 on Base. The hosted Router stays on testnets." |
| 2:40–2:50 | Repo (only if public by recording time), npm, hosted MCP URL; the 20-pair matrix | "Our Router and payer code are open source under MIT. The hosted endpoint, the payer on npm, and the full design and review trail are in the repository." |

---

## 4. Go-to-market (form field)

- First customers: paid-API providers already on one rail and agent developers who hold one stablecoin and hit a 402 they cannot pay. The MPP directory lists 118 services that advertise MPP only; of their GET endpoints priced at or below $0.01, we screened 55 on 2026-10-10 and found none compatible with the Router's current safety checks (rotating recipients, extra challenge fields); CoinGecko's tested x402 endpoint fails the exact resource binding because its 402 omits the query string. Compatibility work with each prospect is part of the plan, not a given.
- Distribution: hosted MCP endpoint (zero install for discovery), `@subetha/payer` on npm for Claude Code users, listing in x402/MPP directories (pay.sh, Bazaar, mpp.dev) once mainnet routes are opened.
- Pricing experiment: a routing fee per purchase in the agent's stablecoin (today: flat 0.001 on dynamic routes to x402 providers; max(0.001, gas-derived cap) on dynamic routes to Tempo providers) and, for providers, a share of the cross-rail volume they would not otherwise receive.
- Measured next: completed cross-rail purchases per provider, repeat use, integration effort (should be zero on the provider side), willingness to pay the routing fee.
- Prerequisites before public mainnet: refund policy for paid-no-data, asset-pairing review, compliance review — documented in `docs/dynamic-upstream-requirements.md` §7.

---

## 5. Claim / source matrix

| Claim | Kind | Source |
|---|---|---|
| Founder background (chains, cross-chain protocols, AI-driven DeFi platform) | owner-attested (Onlab application, 2026-09) | owner |
| x402: "well over 100 million cumulative transactions" on Base through Q1 2026 | third-party (Chainalysis) | https://www.chainalysis.com/blog/x402-agentic-payments-adoption/ |
| Base: 3.1M x402 transactions, $1.2M in 30 days (as of 2026-05-29) | third-party (Base) | https://cryptobriefing.com/agent-payments-growth-x402/ |
| Solana ~70% of monthly x402 volume (reported 2026-08-24), 35M+ cumulative x402 transactions on Solana | third-party | https://solanacompass.com/news/solana-claims-top-spot-on-x402-as-ai-agents-settle-33m-usdc-in-a-single-week ; https://cryptobriefing.com/solana-x402-market-share-dominance/ (given; returned 403 during review, not independently verified) |
| Tempo mainnet live 2026-03-18 with MPP; directory of 100+ providers at launch | third-party | https://www.coindesk.com/tech/2026/03/18/stripe-led-payments-blockchain-tempo-goes-live-with-protocol-for-ai-agents ; https://www.theblock.co/post/394131/tempo-mainnet-goes-live-with-machine-payments-protocol-for-agents |
| mpp.dev catalog: 129 services, 118 advertise MPP only (`methods` lists only `tempo`); directory metadata, not a test that they refuse other methods | **measured by us, 2026-10-10** | `docs/evidence/mpp-catalog-2026-10-10.json`, `docs/mainnet-first-route.md` §3 |
| Agentic commerce $1.5T in 2030 (press release of 2026-04-07; no 2026 figure given there) | forecast (Juniper Research) | https://www.juniperresearch.com/press/agentic-commerce-set-to-generate-15-trillion-globally-by-2030-as-payments-infrastructure-leaders-revealed/ |
| 20 cross-rail pairs settled on testnets, both legs on chain | measured by us | `docs/public-brief-2026-10-08.md` §3, `docs/DEPLOY.md` §2b–§2e |
| One mainnet purchase (Tempo USDC.e MPP → x402-only API on Base), signed with the repository's tools, Router on the owner's machine (loopback) | measured by us, 2026-10-10 | `docs/mainnet-first-route.md` §3 |
| `@subetha/payer` on npm (0.1.0 published 2026-10-10, funded purchase through 0.1.0; 0.1.2 accepted with a cancel test); supports one route, Base Sepolia → Tempo testnet | measured by us | `docs/agent-payer-tasks.md` G-A1/G-A2, `docs/agent-payer-followups-tasks.md` G-F |
| 14 agent-side issues (10 from dogfooding, F-11–F-14 from Codex review) | measured by us | `docs/agent-usability-study.md` §3 |
| Router fee: flat 1,000 base units of the source asset on dynamic routes to x402 providers; max(1,000, gas-derived cap) on dynamic routes to Tempo providers | measured by us | `tools/remote-mcp-config.ts` (`DYNAMIC_FEE_*`, `DYNAMIC_MAX_FEE_CEILING`) |

Figures deliberately not used: "165 million transactions / 69,000 active agents / $50M" circulate in secondary articles without a primary source, so the pitch cites Chainalysis (Base, through Q1 2026) and the dated Solana share instead; the 30-day Base figure stays in this matrix only. Reach statements describe the ecosystem a provider becomes reachable from, not users of the Router.

---

## 6. Production plan (reusing `~/Projects/subetha-promo-video`)

The earlier explainer was produced by Claude Code (`claude-opus-5-5`) in that worktree: scenes in `src/*.mjs` rendered with Chrome via Playwright (`scripts/render_range.mjs`, `check_range.mjs`), a canonical script JSON (`script.en.json`) with per-unit `display_text`/`tts_text`, narration stems mixed per unit (`scripts/mix_range.py`), full-decode and stem-alignment checks, and Codex reviews at plan and final. The difference this time: **the owner records the narration**. Procedure:

1. Freeze the two scripts above (after Codex review and the owner's edits). Split each into numbered units (one sentence or two per unit) in a `script.en.json` for a new `production/colosseum-v1/` (pitch) and `production/colosseum-demo-v1/` (demo).
2. The owner records each unit as a separate WAV/M4A in a quiet room (phone or Mac mic is fine), naming files by unit id. For the demo, the screen capture is recorded first (QuickTime), then narration is recorded while watching it, per unit.
3. The earlier `mix_range.py` expects Fish Audio synthesis receipts and cache keys, so it is not reused as is: a small new mixer for the new directories takes human-recorded stems by unit id, records each stem's hash and duration, normalizes to −16 LUFS, aligns to the timeline, and writes a truthful provenance record (owner recording, no synthesis). Old artifacts stay untouched. Subtitles come from the canonical script.
4. Final checks as before: full decode, duration ≤ 3:00 / 2:50, stem alignment, captions match the script, stills reviewed. The owner watches the whole film once before upload.

---

## 7. What is still open

- README reconciliation (route counts, caveats, payer version) and a "judges: try it in 5 minutes / 15 minutes" guide.
- Repository visibility: LICENSE merged; the owner flips the repository to public after the final audit note.
- The videos (owner recording), the form fields, and the upload with time to spare before 2026-10-13 15:59 JST.
