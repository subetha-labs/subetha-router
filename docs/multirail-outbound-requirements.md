# 要件: Arc と Solana の Provider に払う（S-3・S-4。第 1 版、2026-10-07）

> `multirail-requirements.md`（受信 S-1・S-2）の別紙。受信の展開は G-4（2026-10-07 11:03Z、`docs/DEPLOY.md` §2c）で完了し、公開 Router は Arc testnet USDC・Solana devnet USDC で**払える**。
> 本書はその続き——**Arc または Solana でしか受け取らない Provider に、Router が払って届ける**（送信 = Arc／Solana）——の要件。
> 受信の要件で S-3・S-4 として置いた項目（§3.1、FR-2、FR-22〜FR-26、AC-8・AC-9、D-3・D-5）を引き継ぎ、今の実装に合わせて具体化する。設計・タスクは別紙。

## 0. owner の指示（2026-10-07）

「Arc と Solana の受信レールだけでなく、**Arc と Solana を利用している Provider も Router から利用できるように**してほしい」。
本書はこれを **S-3（送信 = Arc）と S-4（送信 = Solana）の両方**を範囲とする要件に起こしたもの。順・公開する組・鍵と資金・Provider の置き場は §8 で owner に決めてもらう。

## 1. 今の Router（送信側）が持つもの

調べた範囲（`722217c`。file:line は目安）:

- **送信レールは名前で 2 本**: `"x402"` と `"mpp"`（`src/config.ts:19` `OutboundRailName`）。合成（`src/main.ts:370-413` `composeRails`）は `"x402"` に `capabilities.evmSigning`、`"mpp"` に `capabilities.mppTempo` を**1 つずつ**束ね、
  知らない名前は起動を止める。route／プロファイルからレールを引くのも名前だけ（`src/main.ts:156-200` `railByRoute`）。**同じ x402 でも network が違えば区別できない**——受信の要件 FR-2
  （network ごとの `evmSigning`）は S-3 に送られて未実装（`docs/multirail-design.md:4`）
- **x402 の送信能力は Base Sepolia に固定**: 本番の入口は `createRealEvmCapability(evmKey).capability("eip155:84532")`（`tools/rails-entry.ts:119`）。能力の工場そのものは network を引数に取る（`tools/real-evm-capability.ts:28-57`）ので Arc に再利用できる
- **静的 x402 送信**（`src/adapters/outbound/x402.ts`）は公式 SDK（`@x402/fetch`・`@x402/evm` の `ExactEvmScheme`）で offer を読み、guarded signer（`:410-440`）が chainId・contract・to・from・value を承認値と照合してから **SDK の typed data をそのまま**署名器に渡す。
  受信の要件 §3.3 で「この形を新しい network に広げない」と決めた
- **動的 x402 送信**（`src/adapters/outbound/x402-dynamic.ts`）は offer の検査（`:118-175`。scheme・network・asset・額・payTo・`maxTimeoutSeconds`・`extra`・`tokenDomain`）の後、
  **プロファイルと承認値だけから typed data を組み直して**署名する（`:199-294`）。network は `eip155:` 前提（`:88-94`）、領収は bytes32 の tx hash 前提（`:438`）。Arc（EVM）はこの形に乗る。Solana は乗らない
- **MPP 送信**は Tempo 専用（`mpp.ts:421-428`、`mpp-dynamic.ts:595-599`）。受信の要件 §3.3 どおり変えない
- **network の表**（`src/config.ts:45-79` `KNOWN_NETWORKS`）: Arc・Solana は `outbound: []`。表の照合は real モードで route の `destination` と プロファイルの `destination` に掛かる（`:891-914`）。
  動的プロファイルの `rail` は `x402|mpp`（`:717-719`）、x402 は `tokenDomain` 必須（`:735-740`）——SVM の `mint`・token program の形はまだ無い
- **予算**は `(network, asset)` の区分で受信・送信を合算する（`src/core/budget.ts:280-310`）。本番は受信レールが有効なとき Arc USDC・Solana USDC の区分を既に持つ（`tools/remote-mcp-config.ts:217-220`）。
  送信レグが同じ `(network, asset)` に落ちれば**同じ区分に合算**される（Base の送信が受信の区分を共有するのと同じ。`:301-303`）
- **本番の入口の鍵**: `SUBETHA_OUTBOUND_PRIVATE_KEY`（MPP 送信。必須）、`SUBETHA_OUTBOUND_X402_KEY`（x402 送信。既定は同じ鍵。`tools/remote-mcp.ts:91-124`）。Solana の鍵は受信の **owner の公開鍵だけ**で、
  **署名する Solana 鍵はホストに無い**（受信の設計どおり）
- **SVM の transaction を組む code は受信 adapter にある**（`src/adapters/inbound/x402-svm.ts:90` `buildSvmTransactionMessage`: version 0、命令 4 つ = compute limit・compute price・`transferChecked`・Memo。
  上限の定数 `:41-54`）。`npm run sign` の Solana 側（`tools/svm-payer.ts`）はこれで部分署名するが、封筒は Router 受信専用で、blockhash は素の `fetch` で取る。`@x402/svm`（2.28.0）は **devDependency**
  （fixture の facilitator 用）で、`src/` は import しない。`@solana/kit`・`@solana-program/token`・`compute-budget` は dependencies
- **上流の Provider**: 静的 route の上流は owner の別リポジトリ（`provider-mpp.subethalabs.com`、`provider-x402.subethalabs.com`。`tools/remote-mcp-config.ts:12,19`）。
  **Arc で受ける Provider、Solana で受ける Provider はまだ無い**（受信の要件 D-3 は owner の判断待ちだった）
- **結果の形**: `delivered`／`paid_data_unavailable`／`unknown` と `proof.onChainFinality: "not_checked"`（`src/core/orchestrator.ts:776-830`）。送信先の chain を Router が読むことはない

## 2. 外部の事実と、確かめること

### 2.1 Arc（送信）

- Provider が出す x402 offer は `exact`・`eip155:5042002`・USDC `0x3600…0000`（6 桁、EIP-712 domain USDC/2）。**Router が署名するのは EIP-3009 の authorization だけ**で、送信（broadcast）と gas は
  **Provider 側の facilitator**（Circle）が持つ。Router は facilitator を呼ばない。受信で確かめた Circle の `/verify`・`/settle` の挙動は Provider 側の話で、Router の送信には直接関係しない
- 既存の動的 x402 送信の組み直し（FR-22）は chainId・contract を プロファイルの `destination` から取るので、**表に Arc の送信を足し、Arc 用の `evmSigning` を束ねれば**署名の形は変わらない

### 2.2 Solana（送信）

- Provider が出す x402 offer は `exact`・`solana:EtWT…`・USDC mint `4zMMC9…`、`extra.feePayer` に **Provider 側の facilitator の fee payer** が入る（受信で x402.org の `/supported` から取ったのと同じ値の形）。
  払う側（Router）は **fee payer を facilitator にした transaction を組み、自分の token 口座（ATA）からの `transferChecked` に部分署名**し、facilitator が署名を足して送信する。Router は SOL を払わない
- `@x402/svm` の client（`./exact/client`）は SDK の提案（命令の列）を組むが、受信の要件 FR-24 は **SDK の提案を写さず承認値だけで組み直す**と決めている。組み直しの code（上の builder）は既にある
- Router が必要とする外部の読み取りは **recent blockhash だけ**（`getLatestBlockhash`）。受信の起動時の検査・settle の追跡と同じ Solana RPC（`ROUTER_SOLANA_RPC_URL`、SSRF 防御 A の transport）で取る
- Router の Solana 鍵は **資金を動かす鍵**（受信の受取 owner と違う）。ATA に devnet USDC が要る

### 2.3 確かめること（設計の前。V-6 以降は受信の V-1〜V-5 の続き番号）

| # | 確かめること | 方法 | 通らなければ |
|---|---|---|---|
| V-6 | Arc で x402 を受ける Provider の 402 の offer が、表（network・asset・domain）と `checkDynamicX402Offer` の検査に**そのまま通る**か（`extra` の鍵、`maxTimeoutSeconds`、`payTo`） | Provider が立ったら `curl` で 402 を取り、検査の unit 試験に写す | 検査の緩和は**しない**。Provider 側の offer を直す |
| V-7 | Solana で x402 を受ける Provider の 402 の offer の形（`extra.feePayer`、`asset` = mint、`payTo` = owner の公開鍵か ATA か） | 同上 | 設計 §（SVM の offer 検査）で形を固定 |
| V-8 | Router が組んだ部分署名の transaction を Provider 側の facilitator（x402.org）が `/verify` → `/settle` で受けるか（命令 4 つ・compute budget 60,000・Memo の有無） | 使い捨ての鍵で Provider の fixture に 1 回 | Memo の扱い・compute 予算を Provider 側の facilitator の規則に合わせる（Router の上限は動かさない） |
| V-9 | 運用者の資金: Arc の送信鍵（D-11）に Arc testnet USDC、Solana の送信鍵の ATA に devnet USDC が入り、faucet で補充できるか | owner の作業 | 受け入れ（G-3′）に進めない |
| V-10 | `ExactEvmScheme`／`@x402/fetch` が `eip155:5042002` を **静的** 送信で扱えるか（viem の chain 定義） | 試験で確かめる。**扱えなくても要件は変えない**: Arc の静的 route も**動的の組み直しの形**で署名する（FR-22） | 静的 x402 送信 adapter を Arc には使わない |

## 3. スコープ

### 3.1 行列（受信 × 送信）

受信は 4 本（Base x402・Tempo MPP・Arc x402・Solana x402）、送信は本書で 4 本になる（Base x402・Tempo MPP・**Arc x402**・**Solana x402**）。新しく生まれる組:

| # | 受信（払う側が持つもの） | 送信（Provider が受けるもの） | 主張 | 静的 route 名（案） | 動的プロファイル名（案） |
|---|---|---|---|---|---|
| O-1 | Base Sepolia USDC（x402） | **Arc** USDC（x402） | Base の USDC しか持たない agent が Arc の Provider を使える（同じプロトコル、別チェーン） | `md-arc-eth-snapshot` | `dyn-x402-to-arc` |
| O-2 | Tempo pathUSD（MPP） | **Arc** USDC（x402） | MPP しか持たない agent が Arc の Provider を使える | `md-arc-eth-snapshot-mpp` | `dyn-mpp-to-arc` |
| O-3 | Base Sepolia USDC（x402） | **Solana** USDC（x402） | Base の USDC しか持たない agent が Solana の Provider を使える | `md-sol-eth-snapshot` | `dyn-x402-to-sol` |
| O-4 | Tempo pathUSD（MPP） | **Solana** USDC（x402） | MPP しか持たない agent が Solana の Provider を使える | `md-sol-eth-snapshot-mpp` | `dyn-mpp-to-sol` |
| O-5 | Arc USDC（x402） | **Solana** USDC（x402） | 新しいチェーン同士 | `md-sol-eth-snapshot-arc` | `dyn-arc-to-sol` |
| O-6 | Solana USDC（x402） | **Arc** USDC（x402） | 新しいチェーン同士 | `md-arc-eth-snapshot-sol` | `dyn-sol-to-arc` |
| — | Arc → Arc、Solana → Solana | | **同レール同チェーン**。行列の別項目（受信の要件 §3.3）。本書の範囲外 | | |

名前の規則は既存どおり（送信先を先に、受信を接尾辞で。`md-mpp-eth-snapshot-arc` = Arc で払って MPP）。

### 3.2 推奨する範囲と順

- **S-3（Arc 送信）→ S-4（Solana 送信）**。S-3 は既存の動的 x402 の形に乗る（Router 側は小さい）。S-4 は新しい署名の境界（受信の要件どおり、独立レビュー 2 回以上）
- **公開する組は D-12**。推奨は **静的 2 本（O-1・O-4）＋動的 4 本（O-1〜O-4）**を先に。O-5・O-6 は Router の変更無しに**設定だけ**で足せる（受信・送信の能力は独立に束ねる。FR-27）ので、
  受け入れの後に足すかを owner が決める。一覧が長くなること（route 6 本・プロファイル 10 本）は呼び出し側の選択の負担になる
- **Provider が先**（D-10）: Router の受け入れ（AC-8・AC-9）は Arc／Solana で受ける Provider が立っていることが前提。立つまでは fixture（本リポジトリの試験用 Provider）で開発し、
  本番の静的 route の上流 URL は Provider が立ってから入れる

### 3.3 やらないこと

- MPP で Arc・Solana に払う（MPP は Tempo 専用のまま）
- 資産の交換・ブリッジ。par（1:1）の宣言は受信の D-4 と同じ（testnet）
- 「任意の EVM／SVM チェーン」対応。送信も表の**列挙**だけ（Arc testnet・Solana devnet）
- 静的 x402 送信の「typed data をそのまま渡す」形を Arc に広げること（V-10）
- 送信先の chain を Router が読んで領収を独立に確かめること（`onChainFinality: "not_checked"` のまま。受信の D-9 の追跡は受信の settle の話で、送信には足さない）
- mainnet（受信の §3.4 と同じ）

## 4. 機能要件

### 4.1 共通（送信能力の network ごとの束縛）

- **FR-27**（FR-2 の実現）: 送信能力は **(レール, network)** で束ねる。`evmSigning` は network ごとに複数注入でき（Base・Arc）、`svmSigning`（新）は Solana の network に束ねる。
  route／プロファイルの送信レールは `rail` に加えて `destination.network` で引き、**承認済み offer の `network` と能力の `network` が一致しなければ fail closed**（`not_sent`）。
  Base 用の能力は Arc の offer を拒み、Arc 用は Base を拒む（AC-8）。**設定の `rail` の値は `x402`／`mpp` のまま**（レールは プロトコル、network は表）
- **FR-28**: `KNOWN_NETWORKS` の Arc・Solana に `outbound: ["x402"]` を足す。表の照合（route の `destination`、プロファイルの `destination`）は今の規則のまま、Solana の `destination` は
  `tokenDomain` の代わりに **`mint`（= asset）・`decimals`・token program** を照合する（FR-26）
- **FR-29**: 予算は `(network, asset)` の区分に乗る。Arc USDC・Solana USDC の送信レグは**受信と同じ区分に合算**する（既存の Base と同じ）。区分の無い `(network, asset)` は `bucket_not_allowed`
- **FR-30**: 本番の入口（`tools/remote-mcp-config.ts`・`tools/rails-entry.ts`・`tools/remote-mcp.ts`）は、**受信と同じ 1 つの有効化の値**で送信の route／プロファイル／能力を出し入れする
  （`RAILS_ACTIVATION` を `{ arc: { inbound, outbound }, solana: { inbound, outbound } }` の形にするか、別の定数にするかは設計）。無効なら送信鍵の env を読まない。有効化は受信と同じ gate（§6.3）
- **FR-31**: 呼び出し側の手順（CLAUDE.md、`npm run sign`）は**変わらない**——受信のレールは増えない。変わるのは一覧に出る route／プロファイルと `subject` の送信先の表示だけ。
  動的プロファイルの `destination` に Arc／Solana が出ること、`disclosures` が既存どおりであることを AC-11 で見る
- **FR-32**: 領収の照合は network ごとの形: EVM は bytes32 の tx hash（既存）、SVM は **base58 の 64 バイトの署名**と `network` の一致。形が違えば `unknown`（既存の表 `docs/multirail-design.md` §6 と同じ扱い）

### 4.2 Arc の送信（S-3）

- **FR-22**（引き継ぎ）: Arc の Provider の offer（EIP-3009、USDC/2）に **Arc 用の `evmSigning`** で署名する。署名の境界は動的の組み直し（`createRebuildingSigner`）。静的 route も同じ形で署名する（V-10）
- **FR-23**（引き継ぎ）: 動的プロファイルの `tokenDomain`・`network` の組は表で許す。本番の静的 route の上流は Arc で受ける Provider（D-10）
- **FR-33**: Arc の送信は chain を読まない（EIP-3009 は offline の署名）。残高の事前確認は既存どおり無し（`balanceOf` は本番で注入していない）。残高切れは Provider 側の facilitator の `settle` の失敗 →
  `paid_data_unavailable`／`unknown`（既存の表）で見える。運用上は D-11 の補充で防ぐ

### 4.3 Solana の送信（S-4）

- **FR-24**（引き継ぎ）: 払う transaction は **承認値だけで組み直す**: fee payer = offer の `extra.feePayer`、source = Router の ATA（鍵の公開鍵と mint から導く）、destination = offer の `payTo` から導いた ATA
  （`payTo` が owner の公開鍵なら ATA を導く。ATA そのものなら表の規則で拒むか受けるかを V-7 で決める）、mint・decimals = 表、額 = 承認値、Memo = offer が求める値（無ければ命令 3 つ）、
  compute budget = Router の既定（60,000・1 micro-lamport。上限 200,000・5,000,000）。署名は 1 回、部分署名、送信は facilitator。**SDK の提案は読まない**（`@x402/svm` の client を使わない。
  使う場合も提案を写さず、組み直したものと byte 単位で一致するときだけ署名する）
- **FR-25**（引き継ぎ）: Router の Solana 鍵は ed25519 で x402 の送信にだけ使う。鍵は `tools/` だけが env から読む（`SUBETHA_OUTBOUND_SOLANA_KEY`。名前は設計）。`src/` は能力（署名器＋公開鍵＋network）だけを受け取る
- **FR-26**（引き継ぎ）: 動的プロファイルで `rail: "x402"` ＋ `destination.network: "solana:…"` を許す。`tokenDomain` の代わりに `mint`・`decimals`・token program
- **FR-34**: blockhash は Router の Solana RPC（SSRF 防御 A の transport、既存の `ROUTER_SOLANA_RPC_URL`）から取る。offer を読んでから署名するまでの RPC は **1 回**（`getLatestBlockhash`）。
  失敗は `not_sent`（資金は動かない）。Provider の facilitator の `/supported` は**呼ばない**（fee payer は offer から）
- **FR-35**: `offer.extra.feePayer` が Router の公開鍵・Router の ATA・mint・system program 等の既知のアドレスと一致する offer は候補にしない（受信の fee payer の隔離の不等式を送信にも）。
  `payTo` が運用者自身（受信の受取 owner・送信鍵）の offer も候補にしない（既存の `operatorAddresses` と同じ）
- **FR-36**: 期限: 承認の期限と blockhash の有効期間（約 60〜90 秒）の**短い方**で署名を止める。期限を過ぎた transaction に署名しない（`not_sent`）

## 5. 安全・運用の要件

- **SR-1**（引き継ぎ）: 新しい依存は増やさない方針。SVM の送信は `@solana/kit`・`@solana-program/*`（既に dependencies）で組む。`@x402/svm` を `src/` から使うなら SR-1 の記録（何を読み何に接続するか）の上で dependencies に移す
- **SR-2**: Solana の送信鍵は**資金を動かす鍵**。Base／Tempo の送信鍵と同じ扱い（ホストの env ファイル、ログに出さない、`tools/` だけが読む、`npm run sign` の鍵と混ぜない）。受信の受取 owner の鍵とは**別**
- **SR-3**: 署名の境界のレビュー: S-3 は 1 回以上、S-4 は **2 回以上**（受信の要件 §3.2）。sabotage: 組み直しの欄（宛先 ATA・額・mint・fee payer・compute 上限・Memo）を 1 つずつ外した変異が試験で落ちる
- **SR-4**: egress: 送信で新しく接続する先は **Provider の URL**（静的は固定、動的は呼び出し側の URL）と Solana RPC だけ。Circle・x402.org への接続は増えない。拒否ホストの規則は既存
- **SR-5**: 受け入れの購入は testnet・使い捨ての口座・owner の確認（受信の G-3 と同じ）。公開の Router を止めて受け入れ用の起動で行う（既存の手順）

## 6. 受け入れ条件

### 6.1 Router（offline、fixture）

- **AC-8**（引き継ぎ、S-3）: 既存のレール（Base x402・Tempo MPP）で払って Arc の Provider（fixture）が `delivered`。authorization の domain・chainId・額・宛先が承認値（組み直し）。Base 用の能力は Arc の offer を拒み、Arc 用は Base を拒む
- **AC-9**（引き継ぎ、S-4）: 既存のレールで払って Solana の Provider（fixture: 本物の `@x402/svm` の facilitator を fixture の中で動かす既存の形）が `delivered`。命令が承認値だけ（FR-24）、署名 1 回、fee payer ≠ Router。
  Provider 側が宛先・額・命令を変えた transaction を返しても署名しない
- **AC-10**: 行列 O-1〜O-4（D-12 で選んだ組）の静的・動的が統合の harness（`tests/wire/multirail-integration.test.ts`）で `delivered`。再提出・並行・再起動の耐久性は既存の試験に新しい組を足す
- **AC-12**: sabotage（SR-3）と、能力の束縛（network の取り違え）・表・予算の区分・領収の形（FR-32）を外した変異が落ちる

### 6.2 本番（受け入れの購入）

- **AC-13**（S-3）: Arc で受ける Provider（D-10）に、Base USDC で払って（O-1）と Tempo pathUSD で払って（O-2）各 1 件 `delivered`。Provider 側の受取の残高の増分と、Arc の tx（Provider 側の facilitator の settle）を記録
- **AC-14**（S-4）: Solana で受ける Provider に O-3・O-4 各 1 件 `delivered`。署名が devnet で finalized、Provider 側の ATA の増分
- **AC-11**: 公開 MCP の一覧に新しい route／プロファイルが出て、`subject` の送信先（network・asset・decimals）と `disclosures` が正しい。CLAUDE.md の表を更新（英語）

### 6.3 gate（受信と同じ形）

G-1′（鍵と資金: D-11）→ G-2′（無効のまま配備）→ G-3′（受け入れの購入 AC-13・AC-14）→ G-4′（有効化）。各段 owner の確認。

## 7. 受容するリスク

| リスク | 扱い |
|---|---|
| Provider 側の facilitator（Circle／x402.org）が settle を失敗させる・遅らせる | Router は `paid_data_unavailable`／`unknown` を返す（既存の表）。送信先の chain は読まない（§3.3）。返金は無い（既存の開示） |
| Router の送信資金（Arc USDC・devnet USDC）が尽きる | 事前確認は無い（FR-33）。運用で補充（D-11）。尽きたときの失敗は `not_sent` ではなく facilitator 側の失敗として見える |
| Solana の blockhash の期限（約 60〜90 秒）が承認〜署名の間に切れる | FR-36 で署名を止める。呼び出し側は quote を取り直す |
| Provider が Router の送信鍵のアドレスに依存した制限をかける | 範囲外（Provider 側） |
| 一覧が長くなり、呼び出し側が組を取り違える | D-12 で公開する組を絞る。名前の規則を守る |

## 8. owner に決めてもらうこと

| # | 問い | 推奨 |
|---|---|---|
| D-10 | **Provider**: Arc で x402 を受ける Provider と Solana で x402 を受ける Provider を**誰がどこに**立てるか（owner の `subetha-provider-x402` を Arc と Solana でも動かす／本リポジトリに試験用の Provider を足して owner が配備する／第三者の Provider を使う）。URL と受取先はいつ分かるか | owner の `subetha-provider-x402` を 2 つ追加で配備（Circle・x402.org の facilitator は Provider 側の設定）。Router の開発は fixture で先に進め、URL が決まった時点で静的 route に入れる |
| D-11 | **鍵と資金**: Arc の送信鍵は Base／Tempo と同じ EVM 鍵（既定）か別か。Solana の送信鍵は新しい ed25519 鍵（ホストの env）。faucet で Arc testnet USDC・devnet USDC を入れる作業 | Arc は同じ鍵（既定の `SUBETHA_OUTBOUND_X402_KEY` を Arc にも束ねる。env は増やさない）。Solana は新しい鍵（`SUBETHA_OUTBOUND_SOLANA_KEY`）を私が作り、owner が資金を入れる |
| D-12 | **公開する組**: §3.1 の O-1〜O-6 のうちどれを静的 route／動的プロファイルで出すか | 先に静的 2（O-1・O-4）＋動的 4（O-1〜O-4）。O-5・O-6 は受け入れ後に設定で |
| D-13 | **順**: S-3 → S-4 か、両方同時か | S-3 → S-4（S-4 は署名の境界のレビューが 2 回要る） |
| D-14 | **上限**: 新しい組の静的・動的の区分は受信の D-7 と同じ桁か | 同じ（動的 1 件 20,000、通算 100,000,000、件数 1,000）。区分は受信と共有（FR-29） |

## 9. 本書で決めていないこと

- 能力の注入の具体（`RouterCapabilities` の形、`RAILS_ACTIVATION` の形、route からの能力の引き方）——設計
- SVM の offer の検査の欄と `payTo` の形（owner の公開鍵か ATA か）——V-7 の後、設計
- 試験用 Provider（fixture）の形（Arc は既存の `tests/fixtures/dynamic/x402-upstream.ts` の network の一般化、Solana は `tests/fixtures/svm-facilitator.ts` と組む新しい fixture）——タスク
- Provider 側（別リポジトリ）の変更——本書の範囲外（D-10）

## 10. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
