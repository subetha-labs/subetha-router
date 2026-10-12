# Colosseum Crypto World's Fair — submission kit (draft 1, 2026-10-10)

Owner decisions (2026-10-10): tracks **Tempo, Base, Solana**; the owner narrates both videos in English; the repository becomes public under MIT; the pitch should quantify what providers gain (reach they did not have) with sourced numbers; the spoken pitch is confident hackathon language, and the qualifications live in §4/§5, not in the script; the pitch names SubEtha's zERC20 confidential payments as its existing first piece, the Router as the second, and their integration as the plan; the ask for fifty providers, the local payer and "dynamic" are not spoken (owner, 2026-10-10 evening).

Deadline: 2026-10-12 23:59 PT = **2026-10-13 15:59 JST**. Pitch video ≤ 2 min (form, read 2026-10-10: "introduce yourselves, tell us what you're building, and tell us why you're the people to build it. Nothing fancy required. We're interested in how you think and communicate. YouTube, Loom, or Vimeo. Up to 2 minutes."). Technical demo video 2–3 min. All content in English.

Everything below is honest to the repository's records. Numbers carry a source in §5; the matrix marks what is measured by us, what is third-party, and what is a forecast.

---

## 1. One-line framing

> SubEtha Router lets an AI agent pay for an API with the payment rail it holds, while the provider receives the rail it accepts — x402 or MPP, across Base, Solana, Arc and Tempo. A published local payer adds native human approval for every purchase on its supported route. Working testnet prototype, one bounded owner-run mainnet purchase.

Submission description (form; 590 characters, confirm the form's limit):

> Agents and paid APIs do not always share a protocol: x402 (Base, Solana) and MPP (Tempo) cannot pay each other. SubEtha Router sits between them: the agent pays the Router on the rail it has; the Router pays the provider on the rail it accepts from its own balance and returns the response. An MCP server that never holds the agent's key. All 20 cross-rail pairs settle on testnets; one bounded mainnet purchase (Router on the owner's machine) reached an x402-only API from an MPP wallet. `@subetha/payer` (npm) adds native human approval on its first route (Base Sepolia to Tempo testnet).

---

## 2. Pitch video script (295 spoken words in the quoted paragraphs: 2:16 at 130 wpm, 1:58 at 150 wpm; segment times below assume 150 wpm, rounded up — the form's limit is 2 minutes, so the owner must time a read-through before recording and cut until the measured length is ≤ 1:55; Codex round 4 suggests a planning budget of 220–230 words for an unrehearsed non-native read at 120 wpm; the form asks for an introduction, what you are building and why you are the people to build it, "nothing fancy")

**[0:00–0:17] Who I am.**
"I'm Takuya Fujita, building SubEtha, after years building chains and cross-chain protocols. The problem I ran into: an agent finds the right paid API and still cannot pay, because the two sides share no payment protocol, no chain, not even a currency."

**[0:17–0:42] The gap.**
"x402 passed 100 million transactions on Base by the first quarter of 2026, and Solana has grown into a major x402 chain as well. MPP, Stripe's protocol on Tempo: 118 of the 129 services in its directory advertise MPP only. An agent holding USDC on Base cannot buy from a Tempo service priced in pathUSD; each side is invisible to the other."

**[0:42–1:10] What I'm building.**
"SubEtha Router is the bridge, a hosted MCP server. The agent pays the Router on its rail; the Router pays the provider on the provider's rail from its own balance. No swap, no key custody. All 20 cross-rail pairs settle on testnets: buyers on Base, Solana, Arc and Tempo reach providers on the other side, and the ecosystems grow each other. And the Router is already proven on mainnet."

**[1:10–1:35] Why me, and where this goes.**
"SubEtha already has its first piece: confidential payments for AI agents, built on zERC20, so an agent can use on-chain services without revealing what it does or why. The Router is the second piece. Bring the two together, and agents whose strategy must stay private get every rail at once; that expands the on-chain agent market far beyond any single rail."

**[1:35–1:59] Business and close.**
"Providers gain reach: a provider on a supported route gets buyers from the other rail at once, and the Router takes a routing fee. Our vision for SubEtha is a payment layer that lets AI pay without friction, on any rail, with no third party learning its intent. This is the infrastructure agentic commerce will need as it grows. Thank you."

Do not say in the pitch: partners, customers, audited, production-ready, all APIs, anonymous, or secure without qualification. The hedges were removed by owner decision (2026-10-10); the matrix in §5 still carries every qualification, and the script is meant to stay true, only unqualified. Codex rounds of 2026-10-10: round 3 approved the unhedged 3-minute draft; round 4 requested corrections to the 2-minute cut, subsequently applied; round 5 required three wording changes on the owner's rewrite (confidential payments stated as a plan, no blanket "cannot use public chains", "advertise" not "accept" for the 118 services), applied; round 6 found no further correction to the spoken script and corrected this history line; round 7 reviews the owner's second rewrite (name, Solana share, zERC20 as the existing first piece, payer sentence removed, "dynamic" dropped from the fee statement, provider ask replaced, new close); it found no false spoken sentence and three note/translation corrections, applied. Round 8 reviews the owner's third pass (Solana share softened, mainnet sentence generalized, "use on-chain services", value sentence before the close); it passed the spoken facts and required the value sentence to carry an explicit vision cue plus two translation fixes, applied. The 3-minute draft is in this file's history (commit 87b1185).

### 2b. Candidate B: value-first (239 spoken words: 1:51 at 130 wpm, 1:36 at 150 wpm; segment times at 150 wpm, rounded up)

Added 2026-10-11 at the owner's request as an alternative to the script above (candidate A), which stays as is. Same facts and the same "Do not say" line; the mechanics (MCP, the Router's own balance, swap and custody, the 20-pair matrix, zERC20, rail names) are left to the technical demo, and the spoken words carry the value: pay with what you hold, receive what you accept, intent stays private. The owner picks one candidate before recording. The owner (2026-10-11) replaced 'pay freely' with 'pay without friction' in the vision sentence (here and in candidate A) so it cannot be heard as 'free of charge'. The owner (2026-10-11) also asked the opening to mention AI-driven crypto products (kit §5 founder background: AI-driven DeFi platform; earlier projects include HiveFi and Flovia). The owner (2026-10-11) asked that the first problem name all three layers of the mismatch, so 'no shared way to pay' became 'share no payment protocol, no chain, not even a currency' (the same wording as candidate A). Codex round 9 (2026-10-11) reviewed candidate B and required five corrections (strategy "clues" not "read", directory scope, keys not funds, no "stop competing", the Japanese promise line), applied. Codex brush-up review (2026-10-12, gpt-6-astra, read-only) proposed eight script changes; the owner adopted six — open with the blocked purchase (the founder's name is spoken second; the segment is still the form's introduction), one provider-reach sentence, a future-facing integration sentence ('Next, we'll combine them …'), 'a mainnet purchase is verified' (owner's wording; kit §5: one purchase, 2026-10-10), a market passage that answers 'why now' ('Adoption is growing' is editorial synthesis of the dated third-party figures, not Router traction), and 'charges a routing fee on purchases it handles' — and declined two (a GitHub ask at the close; framing the promise as a vision). 264 → 230 words; the first problem now reads 'The barrier: no shared payment protocol, no chain, not even a currency.' The owner (2026-10-12, after watching the sample) restored the bridge sentence 'Two things hold AI agents back today.' between the background and the barrier, because the jump from the introduction to 'The barrier:' was abrupt and the two-card screen it names had lost its spoken cue: 237 words. The owner (2026-10-12, while rehearsing) added a greeting, 'Hi everyone.', as the first spoken sentence (captioned like every other sentence): 239 words.

**[0:00–0:22] An agent that cannot pay, and who I am.**
"Hi everyone. An AI agent finds the right service and cannot pay. I'm Takuya Fujita, building SubEtha. I've built chains, cross-chain protocols and AI-driven crypto products. Two things hold AI agents back today. The barrier: no shared payment protocol, no chain, not even a currency. And public on-chain payments can reveal clues about its strategy."

**[0:22–0:33] The promise.**
"That is what SubEtha is for: the agent pays with what it holds, the provider receives what it accepts, and the agent's intent stays its own."

**[0:33–0:48] A large market, split in two.**
"x402 passed 100 million transactions on Base, with Solana another major chain. Stripe's MPP directory on Tempo lists 129 services; 118 advertise MPP only. Adoption is growing, but the payment systems cannot pay each other directly."

**[0:48–1:04] What changes.**
"With SubEtha Router, agents pay with what they hold. Compatible providers reach buyers across payment systems without changing their setup. The agent keeps its keys. Every supported rail pair settled on testnets, and a mainnet purchase is verified."

**[1:04–1:21] Intent stays private.**
"SubEtha already has confidential payments for AI agents: an agent uses on-chain services without revealing what it does or why. The Router is the second piece. Next, we'll combine them so agents can reach supported rails while keeping their strategy private."

**[1:21–1:39] Business and close.**
"The Router charges a routing fee on purchases it handles. Our vision is a payment layer that lets AI pay without friction, on any rail, with no third party learning its intent: the infrastructure agentic commerce will need as it grows. Thank you."

---

## 3. Technical demo video (target 2:45–2:55, hard limit 3:00; "how")

Revised 2026-10-12 after a Codex review (gpt-6-astra, read-only) of the first table (kept in this file's history): the demo opens on the purchase itself, the implementation explanation comes after the proof, and nothing the pitch already said (market, background, privacy vision, business) is repeated. 275 spoken words, 27 sentences, the longest 17 words (owner 2026-10-12: the official page as the entry point, no app for people, any provider by URL, no open-source mention); planning pace ≈ 110 wpm including pauses (the pitch's measured continuous read), so the words take ≈ 2:30 and the remaining 15–25 s go to holds on the dialog, the delivered data and the explorers. Record on the owner's Mac: first the real purchase through the published payer (testnet, Base Sepolia USDC → our reference Provider B over MPP on Tempo testnet), then one continuous narration read against the assembled footage (continuous mode, pauses kept; if screen waits are cut, the film says "Waits cut"). Persistent labels: **TESTNET** during the payer purchase and the coverage statement; **MAINNET · OWNER-RUN · LOOPBACK** plus a large **Recorded evidence · 2026-10-10** during the mainnet part. No small print, no file paths on screen (owner's on-screen policy). Use a fresh security phrase and redact it in the published footage; the passphrase entry is masked by the dialog; never show key files, `ownerKey`, credentials or notifications. Each sentence names the §5 row it rests on (tags are not spoken).

| Time | On screen | Sentences (owner) |
|---|---|---|
| 0:00–0:22 | The official page subethalabs.com/router: its "Try without a wallet" section and the registration command `claude mcp add --transport http subetha-router https://router.subethalabs.com/mcp`; then Claude Code lists the routes (subetha_router_list_routes) | 1. Everything starts at subethalabs.com/router. [official page row] 2. One command registers the Router in Claude Code. [official page row; hosted endpoint row] 3. With no wallet, the agent can list routes and take a quote. [official page row] |
| 0:22–0:36 | A route strip "Base Sepolia USDC → SubEtha Router → Provider B · MPP on Tempo testnet"; the payer's terminal already running | 4. I'll buy an API response using USDC on Base Sepolia. [payer npm row] 5. The provider is our own reference Provider B, using MPP on Tempo testnet. [demo provider row] 6. To pay, I run the payer on this Mac; it holds my key and asks me first. [payer architecture row] |
| 0:36–0:48 | The real request; find_routes → quote; the quote subject enlarged (amount with decimals, asset/network, recipient, deadline) | 7. In Claude Code, I ask for the route and a quote. [payer architecture row] |
| 0:48–1:12 | The native macOS dialog: security phrase redacted, terms readable, passphrase masked, Approve; a short readable line with the three trust assumptions | 6. I check the terms and my security phrase in the native dialog. [payer architecture row] 7. Then I enter my passphrase and approve. [payer architecture row] 8. This relies on an unmodified install, OS isolation of the daemon, and a secret phrase. [trust assumptions row] |
| 1:12–1:27 | `delivered`; the provider's actual JSON held long enough to read; the purchase reference | 9. Here is the delivered response from the provider. [payer npm row; requires the successful capture] 10. The Router paid through MPP from its own balance. [payment architecture row; demo provider row] |
| 1:27–1:45 | Base Sepolia transfer (my wallet → Router) and Tempo testnet transfer (Router → Provider B) for the same purchase, linked by the purchase record; highlight token-transfer participants and amounts | 11. These are the two payments for this purchase. [payment architecture row] 12. First, my wallet pays the Router on Base Sepolia. [payment architecture row; payer npm row] 13. Then, the Router pays the provider on Tempo testnet. [payment architecture row; demo provider row] |
| 1:45–2:08 | Architecture with a "This Mac / Hosted" boundary: Claude Code → stdio shim → local daemon (key, native dialog) → hosted Router (HTTPS, MCP) → provider; on 18a–18b the diagram shows no screen or person on the agent's side, only the MCP call | 15. I start the local daemon myself, and Claude Code connects through a local shim. 17. The daemon holds my key and contacts the hosted Router over MCP. 18. The hosted Router never holds my key. [payer architecture row; payment architecture row] 18a. There is no app for people here. 18b. The Router is an MCP server, and the agent calls it directly. [hosted endpoint row; payer architecture row] |
| 2:08–2:16 | Large statement "20 cross-rail pairs settled on testnets" (the matrix optional, labelled as recorded test results) | 19. The Router's twenty supported cross-rail pairs have settled on testnets. [20 pairs row] |
| 2:16–2:46 | The two dated explorer screenshots (Tempo inbound 0x4ea7d6c2…, Base outbound 0x699cd8f2…) and a "Recorded result: delivered" summary; on 21a–21b the upstream URL line is highlighted and a strip reads "any x402 or MPP provider · by URL · operator-unverified"; labels MAINNET · OWNER-RUN · LOOPBACK and Recorded evidence · 2026-10-10 | 20. This is recorded evidence of one mainnet purchase on October tenth. 21. Tempo MPP paid for an API accepting only x402 on Base. 21a. That API was a third-party service; the agent needed only its URL. 21b. Give the Router a provider's URL, and it quotes and pays the same way. [mainnet purchase row; dynamic upstream row] 22. The Router ran on my machine, using repository signing tools. [mainnet purchase row] |
| 2:46–2:55 | End card: subethalabs.com/router (largest), router.subethalabs.com/mcp with TESTNET, npm @subetha/payer — no repository line, no licence line (owner 2026-10-12) | 24. Start at subethalabs.com/router. [official page row] |

Not in the demo: open source or the licence (owner 2026-10-12: not to be mentioned; the end card points to the official page), the npm install on camera (done beforehand; npm on the end card), the hash-chained ledger and retry narration, any privacy or "private intent" claim on the working Router (the integration is planned, §5), route/profile counts other than the 20 settled pairs, a second purchase path shown as a normal workflow, and a new mainnet purchase. Fallback order if the live purchase fails: use the saved successful rehearsal capture; inspect status before anything else (a timeout is not proof of nonpayment, never retry blindly); a genuine hosted-Router purchase with the repository signing tools labelled "Developer tools · TESTNET"; otherwise recorded acceptance evidence with the missing fresh capture disclosed. Troubleshooting on camera is capped at about an hour.

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
| SubEtha's first piece, confidential payments for AI agents built on zERC20, already developed by the owner outside this repository; the Router is the second piece; bringing the two together is the plan, and nothing in the Router today hides intent | owner-attested (2026-10-10), not in this repository; the pitch states the zERC20 payments as existing SubEtha work and the integration as a plan | owner |
| Repository `github.com/subetha-labs/subetha-router` public under the MIT license since 2026-10-10 | measured by us | GitHub repository settings; `LICENSE`; README "Sources and license" |
| Official page `subethalabs.com/router` (EN/JA): "Try without a wallet" (discovery and quotes without signing), the Claude Code registration command `claude mcp add --transport http subetha-router https://router.subethalabs.com/mcp`, the five rails on four test networks, "10 fixed routes · 20 dynamic profiles", caveats (testnet-only proof of concept, unaudited, not for production; no automatic retry of `paid_data_unavailable` / `unknown` / `awaiting_payment`; payments not atomic; no anonymity claims; `approval=quoteId` is not proof of human consent) | measured by us (page read 2026-10-12) | https://subethalabs.com/router/ |
| Hosted Router MCP endpoint `https://router.subethalabs.com/mcp` (testnet only) | measured by us | `docs/DEPLOY.md`; README |
| `@subetha/payer` on npm (`npm i -g @subetha/payer`) | measured by us | npm registry; `packages/payer/README.md` |
| Payment architecture: two independent payments, the outbound leg from the Router's prefunded balance; no swap, no bridge, no key custody | measured by us (design and acceptance records) | README; `docs/ENGINEERING.md`; `docs/public-brief-2026-10-08.md` |
| The demo's live provider is our reference Provider B (MPP on Tempo testnet), hosted by us | measured by us | `docs/public-brief-2026-10-08.md`; README "Providers A/B are hosted by us" |
| Approval guarantee of the payer rests on its trust assumptions (unmodified install/runtime, OS isolation of the daemon and its dialog, secret security phrase) | measured by us (documented threat model) | `docs/agent-payer-requirements.md` T1–T4′; `packages/payer/README.md` "Limits of this trust model" |
| Design-to-test trail and independent model reviews for every feature | measured by us | review tables in `docs/*-tasks.md`; `docs/agent-usability-study.md` |
| "First fifty providers" and "design partners" | owner's intent (ask), not a claim about the market | this document §4 |
| Payer architecture: Claude Code → stdio shim (no key) → human-started local daemon (holds the key, native dialog, hash-chained ledger written before every side effect, no blind retry of uncertain outcomes) → hosted Router over HTTPS (MCP) → provider; the quote `subject` shows amount, decimals, recipient and deadline | measured by us (design and acceptance records) | `packages/payer/README.md`; `docs/agent-payer-design.md`; `docs/agent-payer-tasks.md` G-A2 |
| x402: "well over 100 million cumulative transactions" on Base through Q1 2026 | third-party (Chainalysis) | https://www.chainalysis.com/blog/x402-agentic-payments-adoption/ |
| Base: 3.1M x402 transactions, $1.2M in 30 days (as of 2026-05-29) | third-party, secondary (CryptoBriefing attributes it to Base; given, returned 403 during review, not independently verified) | https://cryptobriefing.com/agent-payments-growth-x402/ |
| Solana ~70% of monthly x402 volume (reported 2026-08-24), 35M+ cumulative x402 transactions on Solana | third-party | https://solanacompass.com/news/solana-claims-top-spot-on-x402-as-ai-agents-settle-33m-usdc-in-a-single-week ; https://cryptobriefing.com/solana-x402-market-share-dominance/ (given; returned 403 during review, not independently verified) |
| Tempo mainnet live 2026-03-18 with MPP; directory of 100+ providers at launch | third-party | https://www.coindesk.com/tech/2026/03/18/stripe-led-payments-blockchain-tempo-goes-live-with-protocol-for-ai-agents ; https://www.theblock.co/post/394131/tempo-mainnet-goes-live-with-machine-payments-protocol-for-agents |
| mpp.dev catalog: 129 services, 118 advertise MPP only (`methods` lists only `tempo`); directory metadata, not a test that they refuse other methods | **measured by us, 2026-10-10** | `docs/evidence/mpp-catalog-2026-10-10.json`, `docs/mainnet-first-route.md` §3 |
| Agentic commerce $1.5T in 2030 (press release of 2026-04-07; no 2026 figure given there; dropped from the 2-minute pitch, kept for the form) | forecast (Juniper Research) | https://www.juniperresearch.com/press/agentic-commerce-set-to-generate-15-trillion-globally-by-2030-as-payments-infrastructure-leaders-revealed/ |
| 20 cross-rail pairs settled on testnets, both legs on chain | measured by us | `docs/public-brief-2026-10-08.md` §3, `docs/DEPLOY.md` §2b–§2e |
| One mainnet purchase (Tempo USDC.e MPP → x402-only API on Base), signed with the repository's tools, Router on the owner's machine (loopback); the upstream was a third-party price API chosen by URL through a dynamic profile (not verified by the operator) | measured by us, 2026-10-10 | `docs/mainnet-first-route.md` §3 |
| Dynamic upstream URLs: the hosted Router quotes and pays an x402 or MPP upstream URL the caller chooses (twenty profiles enabled since 2026-10-08; the operator has not verified the destinations; every pair settled on testnets) | measured by us | README "Dynamic upstream URLs"; `docs/DEPLOY.md` §2b–§2e; `docs/public-brief-2026-10-08.md` §3 |
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
4. Final checks as before: full decode, duration ≤ 2:00 / 2:50, stem alignment, captions match the script, stills reviewed. The owner watches the whole film once before upload.

---

## 7. What is still open

- README reconciliation (route counts, caveats, payer version) and a "judges: try it in 5 minutes / 15 minutes" guide.
- Repository visibility: LICENSE merged; the owner flips the repository to public after the final audit note.
- The videos (owner recording), the form fields, and the upload with time to spare before 2026-10-13 15:59 JST.

---

## Appendix A. 動画用内容の日本語訳（オーナーのレビュー用）

この付録は §2（ピッチ動画スクリプト）と §3（技術デモ動画）をオーナーがレビューするための日本語訳であり、提出物ではない。英語の原文が正本であり、両者が食い違う場合は原文に従う。数値、固有名詞、限定表現（「潜在的」「計測していない」など）は原文どおりに訳している。収録はこの訳ではなく §2 / §3 の英語で行う。

### A.2 ピッチ動画スクリプト（§2 の訳）

見出しの注記: 引用段落の話し言葉は 295 語。130 wpm で 2:16、150 wpm で 1:58。下記の各区間の所要時間は 150 wpm を前提に算出し、切り上げている。フォームの上限は 2 分なので、オーナーは収録前に一度通し読みして時間を計り、実測が 1:55 以下になるまで削ること。Codex 第 4 回は、リハーサルなしの非ネイティブの読みを 120 wpm と見て、220〜230 語を計画上の目安として提案している。フォームは自己紹介、何を作っているか、なぜ自分たちがそれを作るべき人なのかを求めており、「凝ったものは不要」としている。

**[0:00–0:17] 自己紹介。**
「SubEtha を開発している Takuya Fujita です。チェーンやクロスチェーンのプロトコルを何年も作ってきて、この問題にぶつかりました。エージェントが必要な有料 API を見つけても、支払えない。決済プロトコルも、チェーンも、通貨さえも、両者で揃っていないからです。」

**[0:17–0:42] ギャップ。**
「x402 は 2026 年第 1 四半期までに Base 上で 1 億トランザクションを超え、Solana も x402 の主要なチェーンへと成長しています。MPP は Tempo 上で使われる Stripe の決済プロトコルです。そのディレクトリに掲載された 129 サービスのうち、118 は決済方法として MPP だけを掲げています。Base に USDC を持つエージェントは、pathUSD 建ての Tempo のサービスを買えません。どちらの側からも、相手が見えないのです。」

**[0:42–1:10] 何を作っているか。**
「SubEtha Router がその橋渡しです。ホスティングされた MCP サーバーです。エージェントは自分のレールで Router に支払い、Router は自身の残高からプロバイダーのレールでプロバイダーに支払います。スワップなし、鍵の預かりなし。クロスレール 20 ペアすべてがテストネットで決済されています。Base・Solana・Arc・Tempo の買い手が別のレールのプロバイダーも利用でき、互いのエコシステムの成長につながります。そして Router は、メインネットでも検証済みです。」

**[1:10–1:35] なぜ私か、そしてこの先。**
「SubEtha にはすでに最初のピースがあります。zERC20 を用いた AI エージェント向けの秘匿決済で、エージェントは何を、なぜしているのかを明かさずにオンチェーンのサービスを利用できます。Router は二つ目のピースです。この二つを組み合わせれば、戦略を秘密にしておく必要があるエージェントがすべてのレールを一度に使えるようになり、エージェントのオンチェーン市場は一つのレールの枠をはるかに超えて広がります。」

**[1:35–1:59] ビジネスと締め。**
「プロバイダーは、これまで届かなかった買い手にもサービスを提供できます。対応ルート上のプロバイダーは、もう一方のレールの買い手にも、すぐにサービスを提供でき、Router はルーティング手数料を得ます。SubEtha が目指すのは、AI が第三者に意図を知られることなく、どのレールでも滞りなく決済できる決済基盤です。これは、これから成長していくエージェント型コマースに欠かせないインフラです。ありがとうございました。」

ピッチで言わないこと: パートナー、顧客、監査済み、本番対応（production-ready）、すべての API、匿名、限定なしの「安全（secure）」。控えめな限定表現はオーナーの決定（2026-10-10）で削除した。§5 のマトリクスには引き続きすべての限定が残っているので、スクリプトは真のまま、限定を付けていないだけという方針である。2026-10-10 の Codex レビュー: 第 3 回で限定なしの 3 分版を承認。第 4 回は 2 分版に修正を求め、その後反映済み。第 5 回はオーナーの書き直しに 3 件の文言修正（秘匿決済は計画として述べる、「パブリックチェーンを使えない」と断定しない、118 件は「受け付ける」ではなく「掲げている」）を求め、反映済み。第 6 回は話し言葉のスクリプトに追加の修正なし、この履歴の記述を訂正。第 7 回はオーナーの二度目の書き直し（名前、Solana の割合、既存の最初のピースとしての zERC20、payer の文を削除、手数料の文から「dynamic」を削除、プロバイダー募集の文を差し替え、新しい締め）をレビューし、話し言葉に虚偽なし、注記と訳の修正 3 件を反映。第 8 回はオーナーの三度目の手直し（Solana の割合を和らげる、メインネットの文を一般化、「サービスを利用できる」、締めの前の価値の一文）をレビューし、話し言葉の事実関係は通過、価値の一文に「目指す」の明示と訳の修正 2 件を求め、反映。3 分版の草稿はこのファイルの履歴（コミット 87b1185）にある。

### A.2b 候補 B: 価値中心（§2b の訳。239 語。130 wpm で 1:51、150 wpm で 1:36。区間時間は 150 wpm、切り上げ）

2026-10-11 にオーナーの依頼で、上のスクリプト（候補 A）の代案として追加した。候補 A はそのまま残す。事実関係と「言わないこと」は同じ。仕組みの説明（MCP、Router 自身の残高、スワップと鍵の預かり、20 ペアのマトリクス、zERC20、レール名）は技術デモ動画に任せ、話し言葉は価値を伝える。持っているもので払い、対応する決済手段で受け取り、意図は秘密のまま。収録前にオーナーがどちらかを選ぶ。Codex 第 9 回（2026-10-11）が候補 B をレビューし、5 件の修正（戦略を「読める」ではなく「手掛かり」、ディレクトリの範囲、資金ではなく鍵、「奪い合いをやめる」の削除、約束の訳文）を求め、反映済み。Codex のブラッシュアップレビュー（2026-10-12）の脚本提案 8 件のうち 6 件をオーナーが採用し、264 語から 230 語になった（冒頭を「買えない瞬間」から始める、提供者の到達は 1 文に、統合は将来形に、メインネットの購入は「検証済み」、市場の段落に「今なぜ」、手数料の文を自然に）。採用しなかったのは GitHub への誘導と、約束を「ビジョン」として語ること。オーナーはサンプル視聴後（2026-10-12）、自己紹介から「壁」への飛躍が唐突だったため、つなぎの一文「今日、AI エージェントを縛っているものが二つあります。」を戻した（237 語）。練習中に冒頭の挨拶「Hi everyone.」を追加（239 語、字幕にも出す）。

**[0:00–0:22] エージェントが支払えない瞬間と、自己紹介。**
「皆さん、こんにちは。AI エージェントが必要なサービスを見つけても、支払えない。SubEtha を開発している Takuya Fujita です。チェーン、クロスチェーンのプロトコル、そして AI とクリプトを組み合わせたプロダクトを作ってきました。今日、AI エージェントを縛っているものが二つあります。壁になっているのは、共通する決済プロトコルも、チェーンも、通貨さえもないことです。そして、公開されるオンチェーン決済は、エージェントの戦略を推測する手掛かりになります。」

**[0:22–0:33] 約束。**
「SubEtha が目指すのは、エージェントが持っているもので支払い、提供者が対応する決済手段で代金を受け取り、エージェントの意図が外部に知られないことです。」

**[0:33–0:48] 大きな市場が、二つに割れている。**
「x402 は Base 上で 1 億トランザクションを超え、Solana ももう一つの主要なチェーンです。Stripe の MPP ディレクトリは Tempo 上に 129 のサービスを掲載し、そのうち 118 は MPP だけを掲げています。利用は広がっていますが、二つの決済方式は互いに直接支払えません。」

**[0:48–1:04] 何が変わるか。**
「SubEtha Router があれば、エージェントは持っているもので支払えます。互換性のある提供者は、設定を何も変えずに、別の決済方式の買い手に届きます。エージェントは鍵を自分で管理します。対応レールのすべての組み合わせがテストネットで決済され、メインネットでの購入も検証済みです。」

**[1:04–1:21] 意図は秘密のまま。**
「SubEtha にはすでに AI エージェント向けの秘匿決済があります。エージェントは何を、なぜしているのかを明かさずにオンチェーンのサービスを利用できます。Router は二つ目のピースです。次に、この二つを組み合わせ、戦略を秘密にしたままのエージェントが対応レールに届くようにします。」

**[1:21–1:39] ビジネスと締め。**
「Router は、取り扱う購入に対してルーティング手数料を課します。目指すのは、AI が第三者に意図を知られることなく、どのレールでも滞りなく決済できる決済基盤です。それは、これから成長していくエージェント型コマースに欠かせないインフラです。ありがとうございました。」

### A.3 技術デモ動画（§3 の訳。目標 2:45〜2:55、上限 3:00、「どのように」）

2026-10-12 に Codex レビューとオーナーの指示で改訂。導入は公式ページ subethalabs.com/router（登録コマンドと「ウォレットなしで試す」）、次に payer での本物の購入、2 つの支払い、アーキテクチャ（人間向けアプリは無い）、20 ペアの実績、メインネット証拠（第三者 API を URL 指定で）、終了カードは公式ページ。オープンソースやライセンスには触れない。275 語・27 文（最長 17 語）。先に購入を画面収録し、その映像に合わせてナレーションを 1 本通しで収録する（連続モード、間はそのまま）。常時表示: TESTNET（payer と実績）、MAINNET · OWNER-RUN · LOOPBACK と「Recorded evidence · 2026-10-10」（メインネット証拠）。小さな注記やファイルパスは出さない。セキュリティフレーズは新しいものを使い、公開映像では伏せ字にする。

1. すべては subethalabs.com/router から始まります。
2. コマンド 1 つで Claude Code に Router を登録できます。
3. ウォレットがなくても、エージェントはルートの一覧と見積もりを取れます。
4. Base Sepolia の USDC で API のレスポンスを買います。
5. 提供者は私たち自身の参照用 Provider B で、Tempo テストネット上の MPP を使います。
6. 支払うために、この Mac で payer を動かします。鍵を持ち、毎回先に私に確認します。
7. Claude Code でルートと見積を求めます。
8. ネイティブのダイアログで、条件と自分のセキュリティフレーズを確認します。
9. パスフレーズを入れて承認します。
10. これは、改変されていないインストール、デーモンの OS による分離、秘密のフレーズを前提にしています。
11. 提供者から届いたレスポンスがこれです。
12. Router は自分の残高から MPP で支払いました。
13. この購入の 2 つの支払いです。
14. まず、私のウォレットが Base Sepolia で Router に支払います。
15. 次に、Router が Tempo テストネットで提供者に支払います。
16. ローカルのデーモンは私自身が起動し、Claude Code はローカルのシムを通して接続します。
17. デーモンが鍵を持ち、MCP でホストされた Router に接続します。
18. ホストされた Router は私の鍵を持ちません。
19. ここに人間向けのアプリはありません。
20. Router は MCP サーバで、エージェントが直接呼びます。
21. Router が対応する 20 のクロスレールの組み合わせは、テストネットで決済済みです。
22. これは 10 月 10 日のメインネット購入 1 件の記録です。
23. Tempo の MPP で、Base 上の x402 しか受け付けない API に支払いました。
24. その API は第三者のサービスで、エージェントに必要だったのは URL だけです。
25. Router に提供者の URL を渡せば、同じように見積もりと支払いができます。
26. Router は私のマシン上で、リポジトリの署名ツールを使って動かしました。
27. subethalabs.com/router から始めてください。

