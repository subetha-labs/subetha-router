# 要件: EVM testnet 3 つ（Robinhood・Arbitrum Sepolia・HyperEVM）を hosted Router に出す（第 1 版、2026-10-13）

> owner の依頼（2026-10-13 14:3x JST）: 「追加したチェーンをちゃんと Provider も用意して、Hosted testnet demo で検証を進めましょう。テストネットの資産なので、どんどん勝手に Router 使って送金して検証を進めてもらって構わない」。
> 前提: `docs/evm-testnets-x402-design.md`（第 3 版、ブランチ `task/evm-testnets-x402`）で、4 つの testnet の x402 受信・送信と、新 3 チェーン × 既存のレールの 30 組を **手元の Router** で実決済まで確かめた（§7・§8.6）。hosted Router・公開の設定生成・golden はそこでは **変えていない**（同 §5 で「hosted への展開」は後続とした）。本書はその後続。
> 進め方は前例どおり（多レール・送信・MPP Solana と同じ）: 要件 → 設計 → タスク → 実装 PR → G-1（鍵・資金・値）→ G-2（無効のまま配備）→ G-3（本番の env での受け入れ購入）→ G-4（公開の有効化）。各段で Codex（`gpt-6-astra`）の独立レビューと owner の確認。

## 1. 目的と範囲

- **目的**: hosted Router（`https://router.subethalabs.com/mcp`）で、新 3 チェーン（Robinhood Chain testnet USDG・Arbitrum Sepolia USDC・HyperEVM testnet USDC、どれも x402 `exact` / EIP-3009）を **受信（払う側）と送信（受ける側）の両方** で使えるようにし、既存の 5 レールとの **36 の向き付きの組**（新 × 既存 15、既存 × 新 15、新 × 新 6）を hosted で実決済まで確かめる。
- **Provider**: 新 3 チェーンそれぞれで x402 だけを受ける Provider を **公開の場所に配備** する（既存の Arc・Solana の Provider と同じ `providers/x402-workers` のソース、同じ資源 `GET /v1/eth/snapshot`）。
- **範囲外**: Ethereum Sepolia（owner の決定待ち。§7 Q-1。既定は外す）、payer（`@subetha/payer`）の対応、mainnet、第三者 facilitator の利用、ブリッジ・DEX・自動補充、新 3 チェーンの MPP。

## 2. 用語

- **新 3**: `rh`（`eip155:46630`、USDG）・`arbsep`（`eip155:421614`、USDC）・`hyperevm`（`eip155:998`、USDC）。値は `src/shared/networks.ts` の表（ローカル版で確定済み）。
- **既存 5 レール**: `base`（Base Sepolia USDC、x402）・`tempo`（Tempo pathUSD、MPP）・`arc`（Arc USDC、x402）・`sol`（Solana devnet USDC、x402）・`solmpp`（Solana devnet USDC、MPP `solana/charge`）。
- **自前 facilitator**: `tools/evm-facilitator.ts`（ローカル版 §3.3）。新 3 に対応する公開 facilitator は無いか、settle の実績を確かめられない（ローカル版 §1.3）。

## 3. 機能要件（FR-H）

- **FR-H1 facilitator の常設**: 自前 facilitator を本番で常時動かし、(a) hosted Router の受信（新 3 の settle）と (b) 新 3 の Provider（Worker）の verify・settle の両方から到達できるようにする。ローカル版の安全の性質（journal-first の送出、使用済みの照合、payTo の allowlist、network ごとの直列と gas の上限、未解決の送出での保留、token による呼び出し元の認証）はすべて保つ。置き場所（EC2 の同じ host か別の場所か、Router からの到達の経路）は設計で決める。gas 鍵は Cloudflare Worker の secret に置かない（ローカル版 §3.5 の判断を引き継ぐ。変えるなら設計で理由を書く）。
- **FR-H2 Provider の配備**: `providers/x402-workers` の env `rh`・`arbsep`・`hyperevm` を公開の custom domain（`provider-x402-<c>.subethalabs.com`、既存の命名に合わせる）で配備する。`FACILITATOR_URL`（token を含む）は var でなく Worker の secret で渡す。受取先は E-PROV（ローカル版と同じ、鍵は owner の手元）か新しいもの（G-1 で決める）。配備は owner の作業か owner の承認つき（前例: Arc・Solana の Provider の配備は owner）。
- **FR-H3 hosted の受信**: 新 3 の kind `x402` 受信を公開の設定生成（`routerConfigOf`）に足す。受取先は Router の EVM の受取先（既存）。facilitator は FR-H1。
- **FR-H4 hosted の送信**: 新 3 への x402 送信を公開の設定生成に足す（Router の EVM 送信鍵、D-11 と同じ鍵を新 3 の network でも使う）。上流は FR-H2 の Provider。
- **FR-H5 組の出し方**: 36 の組を hosted の一覧（`subetha_router_list_routes`）から買えるようにする。既存の 20 組と同じく **動的プロファイル `dyn-<src>-to-<dst>`** で出すことを既定とする（静的 route を 36 本足すと一覧が 10 → 46 本になり、既存の 20 組の出し方とも揃わない）。新しい静的 route を足すか（例: ローカル版の `md-x402-eth-snapshot-<c>`・`md-<c>-eth-snapshot`）は設計で決める。プロファイルの金額の規則・fee・上限は既存の動的プロファイルの規則に従う。
- **FR-H6 有効化**: 新 3 の受信・送信を `RAILS_ACTIVATION` の新しい欄（チェーンごと・方向ごと）で切り替える。既定は `false`。G-4 で `true` にする（イメージを作り直して入れ替える。既存と同じ）。
- **FR-H7 文書**: README・CLAUDE.md・`docs/DEPLOY.md`・llms.txt（subetha-lp、別リポジトリ）の一覧と手順を、有効化した後に更新する。

## 4. 安全要件（SR-H）

- **SR-H1 既存の不変条件**: 明示的な承認、offer・route・金額・network の束縛、verify してから settle、2 レグの同一性、高々 1 回、`unknown` の永続、自動の再試行なし。既存の受信・送信の adapter のコードの意味は変えない。
- **SR-H2 既存の利用を壊さない**: 有効化が `false` の間、公開の設定・一覧・golden は byte 一致（新 3 を足す前と同じ）。`true` にした後も既存の 10 route・20 プロファイルの値は変わらない（追加だけ。golden の差分で確かめる）。
- **SR-H3 facilitator の公開面**: 公開の到達経路を持つなら、token（32 バイトの乱数、path の接頭辞）なしの要求・allowlist 外の payTo・表にない資産・上限を超える金額を、SDK・RPC・送出の前に拒む。gas の累計の上限と、payTo の allowlist（Router の EVM 受取先・新 3 の Provider の受取先だけ）で、第三者がこの facilitator を使って gas を消費させる・他人宛ての送金に使う余地を閉じる。token は log・commit・証跡に出さない。
- **SR-H4 egress と SSRF**: hosted Router の egress 制御（deny-list、`docs/DEPLOY.md` §8b）と SSRF 防御 A を緩めない。facilitator への到達のために loopback・私有アドレスを許すなら、ローカル版の `localCounterparties` と同じく **origin の完全一致の allowlist** で、その adapter の transport だけに限る。動的上流の transport は今どおり loopback・私有アドレスを拒む。
- **SR-H5 鍵**: 新しい鍵（facilitator の gas 鍵など）は本番の env ファイル（root 所有 600）か、owner の手元。chat・引数・commit に出さない。
- **SR-H6 testnet だけ**: mainnet の資産は使わない。

## 5. 受け入れ（AC-H）

- **AC-H1（unit・golden）** 有効化 `false` で golden が byte 一致。`true` で、追加分だけが差分に出る（新 3 の受信・送信と 36 組のプロファイル）。
- **AC-H2（unit・wire）** 新しい設定生成と能力の試験（ローカル版の AC-E2〜E5 に相当するもの。公開の入口で）。facilitator の公開面の拒否（SR-H3）の試験。
- **AC-H3（回帰）** Router・payer・Provider の試験が Linux で通る（macOS の既知の flake は記録のとおり）。
- **AC-H4（G-3、本番の env、資金が動く）** 本番の host で受け入れの Router（公開を止めるか別 port。前例 DEPLOY §2c）から、36 組それぞれを 1 回以上買い、`delivered` と 2 レグの on-chain の `Transfer`（token・from・to・value が quote と一致、receipt 成功、チェーン別の確定）がそろうこと。
- **AC-H5（G-4 の後、公開の hosted、資金が動く）** 公開の hosted MCP（HTTPS）から 36 組を各 1 回買い、AC-H4 と同じ証跡がそろうこと。既存の 20 組から少なくとも各レールを 1 回ずつ含む数組を買い、回帰が無いこと。Router を同じ journal で再起動した後も全 paymentId の status が同じ。
- **AC-H6（Provider）** 3 つの Provider の公開の URL が未払いで 402 と正しい offer（network・資産・domain・payTo・金額）を返し、支払いつきでデータを返す（AC-H4・H5 の購入で兼ねてよい）。

## 6. owner の gate

- **G-1**: 鍵と値（facilitator の置き場所・gas 鍵・token、Provider の受取先、Router の送信鍵の新 3 での資金、fee・上限の値）。
- **G-2**: 無効のまま配備（Router のイメージ、facilitator、Provider）。**提出期限（2026-10-13 15:59 JST）の後**。
- **G-3**: 本番の env での受け入れ購入（AC-H4）。testnet の資金は owner の承認済み（2026-10-13）。公開の停止が要るなら数分（前例）。
- **G-4**: 公開の有効化（`RAILS_ACTIVATION` の新しい欄を `true`）と AC-H5。

## 7. 決めること（owner）

- **Q-1** Ethereum Sepolia も hosted に出すか。既定は **出さない**（提出物の「56 組」と揃える。Sepolia は gas が高く、ローカルで 2 回 `paid_data_unavailable`・1 回 gas 不足があった）。
- **Q-2** 新 3 の Provider の受取先: E-PROV（ローカル版で使った、owner の手元の鍵）を使い回すか、新しく作るか。既定は **使い回す**（testnet、前例 G-1 で使い捨ての受取先を本番に使った）。
- **Q-3** 本番の入れ替えの時刻: 提出期限の後ならいつでもよいか。
