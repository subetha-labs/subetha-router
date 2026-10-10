# Colosseum Crypto World's Fair — submission kit (draft 1, 2026-10-10)

Owner decisions (2026-10-10): tracks **Tempo, Base, Solana**; the owner narrates both videos in English; the repository becomes public under MIT; the pitch should quantify what providers gain (reach they did not have) with sourced numbers; the spoken pitch is confident hackathon language, and the qualifications live in §4/§5, not in the script (owner, 2026-10-10 evening).

Deadline: 2026-10-12 23:59 PT = **2026-10-13 15:59 JST**. Pitch video ≤ 2 min (form, read 2026-10-10: "introduce yourselves, tell us what you're building, and tell us why you're the people to build it. Nothing fancy required. We're interested in how you think and communicate. YouTube, Loom, or Vimeo. Up to 2 minutes."). Technical demo video 2–3 min. All content in English.

Everything below is honest to the repository's records. Numbers carry a source in §5; the matrix marks what is measured by us, what is third-party, and what is a forecast.

---

## 1. One-line framing

> SubEtha Router lets an AI agent pay for an API with the payment rail it holds, while the provider receives the rail it accepts — x402 or MPP, across Base, Solana, Arc and Tempo. A published local payer adds native human approval for every purchase on its supported route. Working testnet prototype, one bounded owner-run mainnet purchase.

Submission description (form; 590 characters, confirm the form's limit):

> Agents and paid APIs do not always share a protocol: x402 (Base, Solana) and MPP (Tempo) cannot pay each other. SubEtha Router sits between them: the agent pays the Router on the rail it has; the Router pays the provider on the rail it accepts from its own balance and returns the response. An MCP server that never holds the agent's key. All 20 cross-rail pairs settle on testnets; one bounded mainnet purchase (Router on the owner's machine) reached an x402-only API from an MPP wallet. `@subetha/payer` (npm) adds native human approval on its first route (Base Sepolia to Tempo testnet).

---

## 2. Pitch video script (274 spoken words in the quoted paragraphs: 2:06 at 130 wpm, 1:50 at 150 wpm; segment times below assume 150 wpm, rounded up — the form's limit is 2 minutes, so the owner must time a read-through before recording and cut until the measured length is ≤ 1:55; Codex round 4 suggests a planning budget of 220–230 words for an unrehearsed non-native read at 120 wpm; the form asks for an introduction, what you are building and why you are the people to build it, "nothing fancy")

**[0:00–0:15] Who I am.**
"I'm Fujita, solo builder of SubEtha, after years building chains and cross-chain protocols. The problem I keep hitting: an agent finds the right paid API and still cannot pay, because the two sides speak different payment protocols."

**[0:15–0:39] The gap.**
"x402 passed 100 million transactions on Base by the first quarter of 2026; by August Solana carried about 70 percent of monthly x402 volume. MPP, Stripe's protocol on Tempo, launched in March, and 118 of the 129 services in its directory advertise MPP as their only payment interface. Pick one rail, and the other side cannot see you."

**[0:39–1:14] What I'm building.**
"SubEtha Router is the bridge, a hosted MCP server. The agent pays the Router on its rail; the Router pays the provider on the provider's rail from its own balance. Two independent payments, no swap, no key custody, and with the local payer a human approves every purchase in a native dialog. On testnets all 20 cross-rail pairs settle end to end. On October 10th I made the first mainnet purchase: an MPP wallet on Tempo bought from an API that accepts only x402 on Base."

**[1:14–1:31] Why me, and how I work.**
"I have built chains and cross-chain protocols, and I ship alone with a method: requirements, design, tasks, independent model review and a test that proves it, for every feature, all in the public repository. Dogfooding and those reviews found fourteen agent-side issues."

**[1:31–1:52] Business and ask.**
"Providers gain reach: an MPP-only provider on Tempo becomes payable from the x402 side, and the Router earns a routing fee on every dynamic purchase. Juniper expects agentic commerce to reach 1.5 trillion dollars by 2030. I need the first fifty providers who want buyers from the other rail. Thank you."

Do not say in the pitch: partners, customers, audited, production-ready, all APIs, anonymous, or secure without qualification. The hedges were removed by owner decision (2026-10-10); the matrix in §5 still carries every qualification, so the script stays true, only unqualified (checked by the Codex review of 2026-10-10, round 3; the 2-minute cut is round 4). The 3-minute draft is in this file's history (commit 87b1185).

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

見出しの注記: 引用段落の話し言葉は 274 語。130 wpm で 2:06、150 wpm で 1:50。下記の各区間の所要時間は 150 wpm を前提に算出し、切り上げている。フォームの上限は 2 分なので、オーナーは収録前に一度通し読みして時間を計り、実測が 1:55 以下になるまで削ること。Codex 第 4 回は、リハーサルなしの非ネイティブの読みを 120 wpm と見て、220〜230 語を計画上の目安として提案している。フォームは自己紹介、何を作っているか、なぜ自分たちがそれを作るべき人なのかを求めており、「凝ったものは不要」としている。

**[0:00–0:15] 自己紹介。**
「私は Fujita、SubEtha を一人で作っています。チェーンとクロスチェーンのプロトコルを何年も作ってきました。繰り返しぶつかる問題はこれです。エージェントが必要な有料 API を見つけても、支払えない。両者が話す決済プロトコルが違うからです。」

**[0:15–0:39] ギャップ。**
「x402 は 2026 年第 1 四半期までに Base 上で 1 億トランザクションを超えました。8 月の時点では、月間 x402 取引量の約 70 パーセントを Solana が占めていました。Stripe のプロトコルである MPP は 3 月に Tempo 上でローンチし、そのディレクトリの 129 サービス中 118 が MPP を唯一の決済インターフェースとして掲げています。どちらか一方のレールを選ぶと、もう一方の側からはあなたが見えません。」

**[0:39–1:14] 何を作っているか。**
「SubEtha Router がその橋渡しです。ホスティングされた MCP サーバーです。エージェントは自分のレールで Router に支払い、Router は自身の残高からプロバイダーのレールでプロバイダーに支払います。二つの独立した支払い、スワップなし、鍵の預かりなし。ローカル payer を使えば、人間がすべての購入をネイティブダイアログで承認します。テストネットでは、クロスレール 20 ペアすべてがエンドツーエンドに決済されています。10 月 10 日、初のメインネット購入を行いました。Tempo 上の MPP ウォレットで、Base 上の x402 しか受け付けない API から購入したのです。」

**[1:14–1:31] なぜ私か、そしてどう仕事をするか。**
「私はチェーンとクロスチェーンのプロトコルを作ってきました。そして一人で、方法論をもって出荷しています。要件、設計、タスク化、独立したモデルによるレビュー、そしてそれを証明するテスト。これをすべての機能について行い、すべて公開リポジトリにあります。ドッグフーディングとそのレビューでエージェント側の問題を 14 件見つけました。」

**[1:31–1:52] ビジネスとお願い。**
「プロバイダーはリーチを得ます。Tempo 上の MPP 専用プロバイダーが x402 側から支払いを受けられるようになり、Router は動的な購入ごとにルーティング手数料を得ます。Juniper はエージェント型コマースが 2030 年までに 1.5 兆ドルに達すると予測しています。私が必要としているのは、もう一方のレールの買い手を求める最初の 50 のプロバイダーです。ありがとうございました。」

ピッチで言わないこと: パートナー、顧客、監査済み、本番対応（production-ready）、すべての API、匿名、限定なしの「安全（secure）」。控えめな限定表現はオーナーの決定（2026-10-10）で削除した。§5 のマトリクスには引き続きすべての限定が残っているので、スクリプトは真のまま、限定を付けていないだけである（2026-10-10 の Codex レビュー第 3 回で確認。2 分版は第 4 回）。3 分版の草稿はこのファイルの履歴（コミット 87b1185）にある。

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
