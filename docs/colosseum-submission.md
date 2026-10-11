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
| SubEtha's first piece, confidential payments for AI agents built on zERC20, already developed by the owner outside this repository; the Router is the second piece; bringing the two together is the plan, and nothing in the Router today hides intent | owner-attested (2026-10-10), not in this repository; the pitch states the zERC20 payments as existing SubEtha work and the integration as a plan | owner |
| Repository `github.com/subetha-labs/subetha-router` public under the MIT license since 2026-10-10 | measured by us | GitHub repository settings; `LICENSE`; README "Sources and license" |
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

### A.3 技術デモ動画（§3 の訳。目標 2:50、「どのように」）

オーナーの Mac で収録する。公開済み payer を通した実際の購入を 1 件（テストネット、Base Sepolia → Tempo MPP）、その後にメインネットの証拠を録画済み素材として示す。画面上に常時ラベルを出す: ライブ部分は **TESTNET**、証拠部分は **MAINNET (owner-run, loopback)**。セキュリティフレーズは新しいものを使い、パスフレーズはマスクし、鍵ファイルは決して映さない。

| 時間 | 画面 | ナレーション（オーナー） |
|---|---|---|
| 0:00–0:15 | タイトルカード。ミスマッチの図: エージェントは Base USDC を保有 → プロバイダーは Tempo 上の MPP のみ受け付ける。キャプション「Provider: our reference Provider B (testnet)」（プロバイダー: 当方のリファレンス Provider B、テストネット） | 「エージェントは Base 上に USDC を持ち、x402 を話します。プロバイダーは、このデモでは当方のリファレンスプロバイダーですが、Tempo 上の MPP しか受け付けません。これから購入が通るところをお見せします。」 |
| 0:15–0:30 | ターミナル: `npm i -g @subetha/payer`。`subetha-payer daemon` は起動済み。リポジトリ外の新しい Claude Code セッションで `claude mcp add --scope user subetha-payer -- subetha-payer mcp` | 「payer は npm にあります。人間が、鍵を保持するデーモンを起動します。Claude Code はローカルのシム経由でのみそれと話します。」 |
| 0:30–0:50 | Claude Code: find_routes → quote。subject（金額 0.01 USDC、decimals、受取先、期限） | 「エージェントがルートを見つけ、見積もりを取ります。まだ何も支払われていません。」 |
| 0:50–1:15 | macOS のネイティブダイアログ: セキュリティフレーズ、正確な条件、パスフレーズ入力、Approve | 「このルートでの購入はすべて、人間がネイティブダイアログで確認します。起動時に自分で選んだセキュリティフレーズと正確な条件を確認し、パスフレーズを入力します。ツールの引数では支払いを承認できません。これは payer が文書化している信頼の前提に依拠しています。改変されていないインストールと実行環境、他のプロセスがデーモンを覗いたりそのダイアログを操作したりできないようにする OS、そして自分だけが知るセキュリティフレーズです。」 |
| 1:15–1:40 | purchase → `delivered`。プロバイダーの JSON。保存された ref を示す `subetha_payer_status` | 「Router は自身の残高から MPP でプロバイダーに支払い、データを返しました。結果は参照番号とともにローカルに保存されます。」（再起動を見せる場合: カメラの前でデーモンを停止・再起動し、改めて status を読む。見せない場合は、保存済みの結果を再度開けるとは主張しない。） |
| 1:40–2:00 | **その**購入のエクスプローラーページ（画面上の結果と同じ paymentId と tx ハッシュ）: 自分のウォレットから Router への Base Sepolia 送金。Router からプロバイダーへの Tempo 送金。キャプション「recorded after the purchase; waits cut」（購入後に収録、待ち時間はカット） | 「二つの独立した支払いで、どちらもオンチェーンです。エージェントの鍵はマシンから一度も出ていません。」 |
| 2:00–2:20 | アーキテクチャ図: Claude → stdio シム → ローカルデーモン → HTTPS の Router (MCP) → プロバイダー。二本の支払い矢印。ハッシュチェーン台帳 | 「設計上の選択: ホスティングされた Router は呼び出し側の鍵を決して保持しません。デーモンはあらゆる副作用の前にハッシュチェーン台帳を書きます。結果が不確かなときは決して盲目的に再試行しません。」 |
| 2:20–2:40 | 録画済みの証拠、日付 2026-10-10: メインネット購入。Tempo メインネットの入金（inbound）tx、x402 のみの API への Base メインネットの出金（outbound）tx、配信された JSON。キャプション「2026-10-10, Router run on the owner's machine, loopback only, signed with the repository's tools」（2026-10-10、オーナーのマシンで動かした Router、ループバックのみ、リポジトリのツールで署名） | 「同じ Router のコードを自分のマシンで動かし、10 月 10 日にメインネット購入を 1 件行いました。Tempo 上の MPP ウォレットで、Base 上の x402 しか受け付けない API から購入しました。ホスティングされた Router はテストネットのままです。」 |
| 2:40–2:50 | リポジトリ（収録時点で公開されている場合のみ）、npm、ホスティングされた MCP の URL。20 ペアのマトリクス | 「私たちの Router と payer のコードは MIT ライセンスでオープンソースです。ホスティングされたエンドポイント、npm の payer、設計とレビューの完全な記録はリポジトリにあります。」 |
