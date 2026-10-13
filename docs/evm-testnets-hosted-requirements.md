# 要件: EVM testnet 3 つ（Robinhood・Arbitrum Sepolia・HyperEVM）を hosted Router に出す（第 2 版、2026-10-13）

> owner の依頼（2026-10-13 14:3x JST）: 「追加したチェーンをちゃんと Provider も用意して、Hosted testnet demo で検証を進めましょう。テストネットの資産なので、どんどん勝手に Router 使って送金して検証を進めてもらって構わない」。
> 前提: `docs/evm-testnets-x402-design.md`（第 3 版、ブランチ `task/evm-testnets-x402`）で、4 つの testnet の x402 受信・送信と、新 3 チェーン × 既存のレールの 30 組を **手元の Router** で実決済まで確かめた（§7・§8.6。行列は **静的 route** `mx-*`）。hosted Router・公開の設定生成・golden はそこでは **変えていない**（同 §5 で「hosted への展開」は後続とした）。本書はその後続。
> 進め方は前例どおり（多レール・送信・MPP Solana と同じ）: 要件 → 設計 → タスク → 実装 PR → G-1（鍵・資金・値）→ G-2（無効のまま配備）→ G-3（本番の env での受け入れ購入）→ G-4（公開の有効化）。各段で Codex（`gpt-6-astra`）の独立レビューと owner の確認。
> 第 1 版（`146362e`）は Codex R1 で APPROVE WITH CHANGES（blocker 1・major 5。§8）。第 2 版で全件を反映: facilitator の到達経路の制約（FR-H1・SR-H4）、facilitator の永続と単一の実行者（FR-H8）、gas の上限の寿命（FR-H9）、動的の価格・区分・宛先の意味（FR-H5）、G-3 の排他の引き継ぎ（AC-H4）、受け入れのクライアントと動的の証跡（AC-H7・§1 範囲外の payer）。

## 1. 目的と範囲

- **目的**: hosted Router（`https://router.subethalabs.com/mcp`）で、新 3 チェーン（Robinhood Chain testnet USDG・Arbitrum Sepolia USDC・HyperEVM testnet USDC、どれも x402 `exact` / EIP-3009）を **受信（払う側）と送信（受ける側）の両方** で使えるようにし、既存の 5 レールとの **36 の向き付きの組**（新 × 既存 3×5 = 15、既存 × 新 5×3 = 15、新 × 新 3×2 = 6。同じレール同士は除く）を hosted で実決済まで確かめる。既存の 20 組と合わせて 56。
- **Provider**: 新 3 チェーンそれぞれで x402 だけを受ける Provider を **公開の場所に配備** する（既存の Arc・Solana の Provider と同じ `providers/x402-workers` のソース、同じ資源 `GET /v1/eth/snapshot`）。
- **範囲外**: Ethereum Sepolia（owner の決定 §7 Q-1）、mainnet、第三者 facilitator の利用、ブリッジ・DEX・自動補充、新 3 チェーンの MPP。
- **payer（`@subetha/payer`）は範囲外**: payer の発見は対応外の source network のプロファイルを除く（`packages/payer/src/daemon/handler.ts:34-35,60`）。新 3 を source とする組は payer からは見えない。新 3 を destination とする組（既存の source から）は payer の対応範囲で見える可能性があるが、payer での購入は本件の受け入れに数えない。この制限を README・llms.txt に書く（FR-H7）。

## 2. 用語

- **新 3**: `rh`（`eip155:46630`、USDG）・`arbsep`（`eip155:421614`、USDC）・`hyperevm`（`eip155:998`、USDC）。値は `src/shared/networks.ts` の表（ローカル版で確定済み。domain・decimals 6 を含む）。
- **既存 5 レール**: `base`（Base Sepolia USDC、x402）・`tempo`（Tempo pathUSD、MPP）・`arc`（Arc USDC、x402）・`sol`（Solana devnet USDC、x402）・`solmpp`（Solana devnet USDC、MPP `solana/charge`）。
- **自前 facilitator**: `tools/evm-facilitator.ts`（ローカル版 §3.3）。新 3 に対応する公開 facilitator は無いか、settle の実績を確かめられない（ローカル版 §1.3）。

## 3. 機能要件（FR-H）

- **FR-H1 facilitator の常設と到達**: 自前 facilitator を本番で常時動かし、次の 3 つの呼び出し元から到達できるようにする。
  (a) hosted Router の **静的** 受信（新 3 を source とする静的 route を出す場合）、
  (b) hosted Router の **動的** 受信（`dyn-<新>-to-*`）: 動的プロファイルの受信は動的用の transport（loopback・私有アドレス不可）で facilitator を呼ぶ（`src/main.ts:940-948`）。ローカル版の `localCounterparties` は静的の adapter にしか効かず、literal の `http://127.0.0.1:<port>` だけを受ける（`src/main.ts:145-162`）。
  (c) 新 3 の Provider（Cloudflare Worker）の verify・settle: Worker はローカルの試験以外では https の facilitator だけを受ける（`providers/x402-workers/src/config.ts:179`）。
  到達経路は、本番の Router コンテナの実際の network（専用 bridge に単独、egress の deny-list は非 global の範囲と **host 自身のアドレス** を遮断。`docs/DEPLOY.md` §8b、`:792-795`）と SSRF 防御 A を **緩めずに** 成り立つこと。facilitator は今 loopback に bind し、`Host` が loopback の完全一致でない要求を拒む（`tools/evm-facilitator.ts:1130,1215`）ので、公開する場合は TLS の終端と proxy の振る舞い（`Host` の書き換え、token を含む path の log からの除去）を設計で決める。gas 鍵は Cloudflare Worker の secret に置かない（ローカル版 §3.5 の判断を引き継ぐ。変えるなら設計で理由を書く）。ローカル版の安全の性質（journal-first の送出、使用済みの照合、payTo の allowlist、network ごとの直列、未解決の送出での保留、token による呼び出し元の認証）はすべて保つ。
- **FR-H2 Provider の配備**: `providers/x402-workers` の env `rh`・`arbsep`・`hyperevm` を公開の custom domain（`provider-x402-<c>.subethalabs.com`、既存の命名に合わせる）で配備する。`FACILITATOR_URL`（token を含む）は var でなく Worker の secret で渡す。受取先は E-PROV（§7 Q-2）。配備は owner の承認つき（前例: Arc・Solana の Provider の配備は owner）。
- **FR-H3 hosted の受信**: 新 3 の kind `x402` 受信を公開の設定生成（`routerConfigOf`）に足す。受取先は Router の EVM の受取先（既存）。facilitator は FR-H1。offer の `extra.name/version` は表の domain（ローカル版 FR-E2 の修正が公開の経路でも効くこと）。
- **FR-H4 hosted の送信**: 新 3 への x402 送信を公開の設定生成に足す（Router の EVM 送信鍵、D-11 と同じ鍵を新 3 の network でも使う）。x402 送信では Router はチェーン手数料を払わない（上流の facilitator が送出する）ので、Router の送信鍵に要るのは新 3 の通貨だけ。
- **FR-H5 組の出し方・価格・区分**: 36 の組を hosted の一覧（`subetha_router_list_routes`）から買えるようにする。既存の 20 組と同じく **動的プロファイル `dyn-<src>-to-<dst>`** で出す（静的 route を 36 本足すと一覧が 10 → 46 本になり、既存の出し方とも揃わない）。動的プロファイルは **呼び出し側が選ぶ URL** を買うもので、FR-H2 の Provider に固定されない（`tools/remote-mcp-config.ts:390` の既存のプロファイルと同じ）。各プロファイルについて次を明示する（設計で値を表にする）:
  - 宛先: scheme `exact`、network・資産・decimals 6・`tokenDomain`（表の domain。USDG は `Global Dollar`/`1`、Arbitrum Sepolia は `USD Coin`/`2` など）。
  - 価格: 新 3 への x402 送信は既存の x402 送信と同じ定額 1,000、上流の上限 10,000（`DYNAMIC_FEE_X402_OUT`・`DYNAMIC_MAX_UPSTREAM_AMOUNT`）。新 3 → Tempo（MPP 送信）は既存の Tempo の見積もりと上限の規則（`feeMargin`・`maxFee` 50,000）をそのまま使う。新 3 → `solmpp` は既存の `toSolMpp` の規則（`maxFee` なし）。
  - 予算の区分: 新 3 の (network, asset) ごとに `dynamic.budget.buckets` の区分を足す（区分が無いと quote は拒まれる。`src/core/dynamic.ts:223-252`）。総額と 1 件の上限は G-1 で決める。1 件の予約は源と宛先の区分ごとの合算で見る規則（`tools/remote-mcp-config.ts:277-284`）に照らし、新 3 → Tempo で gas の cap が手数料を押し上げる場合も含めて境界の試験を置く。新 × 新は源と宛先が別の区分になる（同じチェーン同士は組にしない）。
  - facilitator の金額の上限（`tools/evm-facilitator.ts:58,397` の 20,000）が、源のレグの最大（上流の上限 + 手数料、Tempo 宛では cap を含む）を下回らないこと。
  - 新しい静的 route を足すか（例: ローカル版の `md-x402-eth-snapshot-<c>`・`md-<c>-eth-snapshot`）は設計で決める（足すなら FR-H1(a)）。
- **FR-H6 有効化**: 新 3 の受信・送信を `RAILS_ACTIVATION` の新しい欄（チェーンごと・方向ごと）で切り替える。既定は `false`。G-4 で `true` にする（イメージを作り直して入れ替える。既存と同じ）。組の欄が必要なら既存の `pairs` と同じく「必要な方向が無ければ固定文で止まる」こと。
- **FR-H7 文書**: README・CLAUDE.md・`docs/DEPLOY.md`・llms.txt（subetha-lp、別リポジトリ）の一覧と手順を、有効化した後に更新する。payer の制限（§1）を書く。
- **FR-H8 facilitator の永続と単一の実行者**: journal は本番の永続の場所（コンテナの入れ替え・host の再起動を越える）に置く。同じ gas 鍵で送出する facilitator の process は常に 1 つ（入れ替え・受け入れの間も 2 つ同時に動かない。起動時に排他を確かめ、取れなければ起動しない）。journal の書き込み・fsync に失敗したら送出しない（fail-closed）。再起動の後、確定した settle は再生され、未解決の送出は保留のまま（2 回目の送出が無い）。
- **FR-H9 gas の上限の寿命**: facilitator の gas の上限は今は process の寿命の累計で、メモリだけにある（再起動で戻る。`tools/evm-facilitator.ts:218,585,619-647`）。本番では **累計を journal から復元** し（確定した送出の gas と未解決の予約を含む）、再起動で黙って補充されないこと。補充は運用者が journal に理由つきで追記したときだけ（ローカル版の `resolved_by_operator` と同じ扱い）。facilitator の gas（新 3 のネイティブ通貨）は Router の資金とは別に入れる。

## 4. 安全要件（SR-H）

- **SR-H1 既存の不変条件**: 明示的な承認、offer・route・金額・network の束縛、verify してから settle、2 レグの同一性、高々 1 回、`unknown` の永続、自動の再試行なし。既存の受信・送信の adapter のコードの意味は変えない。
- **SR-H2 既存の利用を壊さない**: 有効化が `false` の間、公開の設定・一覧・golden は byte 一致（新 3 を足す前と同じ）。`true` にした後も既存の 10 route・20 プロファイルの値は変わらない（追加だけ。golden の差分で確かめる）。
- **SR-H3 facilitator の公開面**: 公開の到達経路を持つなら、token（32 バイトの乱数、path の接頭辞）なしの要求・allowlist 外の payTo・表にない資産・上限を超える金額を、SDK・RPC・送出の前に拒む。gas の累計の上限（FR-H9）と、payTo の allowlist（Router の EVM 受取先・新 3 の Provider の受取先だけ）で、第三者がこの facilitator を使って gas を消費させる・他人宛ての送金に使う余地を閉じる。token は log・commit・証跡に出さない（proxy の access log を含む）。
- **SR-H4 egress と SSRF**: hosted Router の egress 制御（deny-list、`docs/DEPLOY.md` §8b）と SSRF 防御 A を緩めない。動的上流の transport は今どおり loopback・私有アドレス・自分の公開ホスト名を拒む。facilitator への到達のために例外を設けるなら、その例外は **facilitator の URL の origin の完全一致** に限り、受信の adapter（静的・動的）の transport だけに効き、動的上流（呼び出し側が選ぶ URL）には効かないこと（試験で固定）。
- **SR-H5 鍵**: 新しい鍵（facilitator の gas 鍵など）は本番の env ファイル（root 所有 600）か、owner の手元。chat・引数・commit に出さない。
- **SR-H6 testnet だけ**: mainnet の資産は使わない。
- **SR-H7 資金が先に動くレグ**: Tempo（MPP）を source とする組は署名の時点で送金される。受け入れで署名の後の段が失敗・`unknown` になったら、再署名・再試行をせず止めて記録する（ローカル版 §8.5 M-1 と同じ）。

## 5. 受け入れ（AC-H）

- **AC-H1（unit・golden）** 有効化 `false` で golden が byte 一致。`true` で、追加分だけが差分に出る（新 3 の受信・送信の設定と 36 組のプロファイル・区分）。
- **AC-H2（unit・wire）** 公開の設定生成・入口・能力の試験（ローカル版の AC-E2〜E5 に相当するものを公開の入口で）。各プロファイルの宛先・価格・区分の値と、1 件の上限の境界（新 3 → Tempo の cap を含む）。SR-H4 の例外の範囲（facilitator の origin だけ、動的上流には効かない）。
- **AC-H3（facilitator）** 公開面の拒否（SR-H3）、FR-H8 の永続と排他（2 つ目の process が起動しない、journal の書き込み失敗で送出しない、再起動で確定の再生と未解決の保留、2 回目の送出が無い）、FR-H9 の累計の復元（再起動で上限が戻らない）。`/supported`・verify・settle が実際の到達経路（proxy を含む）を通ること。
- **AC-H4（G-3、本番の env、資金が動く）** 前例の排他の引き継ぎ（`docs/DEPLOY.md:137-141`）に従う: 進行中の購入が無いときに公開の Router を止め、**同じイメージ・同じ network・同じボリューム** で受け入れの Router を単独で動かし、終わったら止めて公開の Router を戻す（同時に 2 つの Router を動かさない。journal は前例どおりの扱い）。この中で 36 組それぞれを 1 回以上買い、`delivered` と 2 レグの on-chain の `Transfer`（token・from・to・value が quote と一致、receipt 成功、チェーン別の確定）がそろうこと。
- **AC-H5（G-4 の後、公開の hosted、資金が動く）** 公開の hosted MCP（HTTPS）から 36 組を各 1 回買い、AC-H4 と同じ証跡がそろうこと。既存の 20 組から少なくとも各レールを 1 回ずつ含む数組を買い、回帰が無いこと。Router を同じ journal で再起動した後も全 paymentId の status が同じ。
- **AC-H6（Provider）** 3 つの Provider の公開の URL が未払いで 402 と正しい offer（network・資産・domain・payTo・金額）を返し、支払いつきでデータを返す（AC-H4・H5 の購入で兼ねてよい）。
- **AC-H7（受け入れのクライアントと動的の証跡）** 受け入れのクライアントはこのリポジトリの道具（hosted MCP を HTTPS で呼び、`npm run sign` と同じ `runSign` で署名する driver。前例 G-5、`docs/DEPLOY.md` §2e）。各購入で: `subetha_router_quote_url` の `url` に **FR-H2 の Provider の URL を明示** し、subject の upstream URL・宛先・価格が plan と一致することを署名の前に確かめる。quote の `ownerKey` を保存し、`subetha_router_status` を `ownerKey` つきで読み直す。保存した結果を Router の再起動の後に読み直す（AC-H5）。SR-H7 を守る。

## 6. owner の gate

- **G-1**: 鍵と値（facilitator の置き場所・gas 鍵・token、Router の送信鍵の新 3 での資金、facilitator の gas の資金と上限、区分の総額と 1 件の上限）。
- **G-2**: 無効のまま配備（Router のイメージ、facilitator、Provider）。**提出期限（2026-10-13 15:59 JST）の後**（§7 Q-3）。
- **G-3**: 本番の env での受け入れ購入（AC-H4）。testnet の資金の支出は owner の承認済み（2026-10-13）。公開の停止は数分（前例）。
- **G-4**: 公開の有効化（`RAILS_ACTIVATION` の新しい欄を `true`）と AC-H5。

## 7. owner の決定（2026-10-13 14:4x JST）

- **Q-1 → 出さない**（owner）。Ethereum Sepolia を hosted に出すか（提出物の「56 組」と揃える。Sepolia は gas が高く、ローカルで 2 回 `paid_data_unavailable`・1 回 gas 不足があった）。
- **Q-2 → E-PROV を使い回す**（owner）。新 3 の Provider の受取先（testnet、前例 G-1 で使い捨ての受取先を本番に使った）。
- **Q-3 → 提出期限（15:59 JST）の後ならいつでも**（owner）。G-2〜G-4 の入れ替えの時刻。

## 8. 独立レビューの記録

- **R1（Codex `gpt-6-astra`、CLI read-only、第 1 版 `146362e`）: APPROVE WITH CHANGES**。36 の数は正しい。動的プロファイルは成り立ち、新 3 の x402 宛先は Router の gas の見積もりを要しない。指摘 6 件と反映:
  1. blocker — facilitator の到達経路が動的受信（動的用 transport）と host の egress に合わない → FR-H1（a〜c と制約）、SR-H4（例外の範囲）、AC-H3。
  2. major — facilitator の永続と単一の実行者の受け入れが無い → FR-H8、AC-H3。
  3. major — gas の累計の上限が再起動で戻る → FR-H9、AC-H3。
  4. major — 動的の価格・区分・宛先の意味が「既存の規則」では足りない、プロファイルは呼び出し側の URL → FR-H5、AC-H2、AC-H7。
  5. major — G-3 の「別 port」は前例の排他に反する → AC-H4。
  6. major — 受け入れのクライアントと payer の制限、動的の証跡、Tempo の資金が先に動く規則 → §1、AC-H7、SR-H7。
