# 要件: Arc と Solana の Provider に払う（S-3・S-4。第 2 版、2026-10-07）

> `multirail-requirements.md`（受信 S-1・S-2）の別紙。受信の展開は G-4（2026-10-07 11:03Z、`docs/DEPLOY.md` §2c）で完了し、公開 Router は Arc testnet USDC・Solana devnet USDC で**払える**。
> 本書はその続き——**Arc または Solana でしか受け取らない Provider に、Router が払って届ける**（送信 = Arc／Solana）——の要件。
> 受信の要件で S-3・S-4 として置いた項目（§3.1、FR-2、FR-22〜FR-26、AC-8・AC-9、D-3・D-5）を引き継ぎ、今の実装に合わせて具体化する。設計・タスクは別紙。
>
> 第 1 版からの訂正（独立レビュー #1、§10）: §1 の断定を実装の範囲に限定（network 別の能力は「同時に選べない」、動的の組み直しは `validAfter`・`validBefore`・`nonce` を SDK から範囲検査で引き継ぐ、
> 「chain を読まない」は領収の独立検証に限定）。`payTo` は owner で確定し、宛先 ATA の事前作成を Provider の責任に。**Memo が無い購入の一意性**（FR-24・FR-37）。署名済み raw の再検査と
> fee payer の隔離の列挙（FR-24・FR-35）。blockhash の期限は秒の保証ではなく取得〜署名の局所的な制限と送出直前の再検査に（FR-34・FR-36）。残高の事前確認は owner の判断（D-15）。
> 有効化は受信・送信で独立（FR-30）。静的・動的の予算は別で、方向間の共有は可用性の問題（FR-29・D-14）。SDK の事実と Provider 側の仮定を分離（§2）。AC を分け、失敗の表を送信専用に（§6）。

## 0. owner の指示（2026-10-07）

「Arc と Solana の受信レールだけでなく、**Arc と Solana を利用している Provider も Router から利用できるように**してほしい」。
本書はこれを **S-3（送信 = Arc）と S-4（送信 = Solana）の両方**を範囲とする要件に起こしたもの。順・公開する組・鍵と資金・Provider の置き場は §8 で owner に決めてもらう。

## 1. 今の Router（送信側）が持つもの

調べた基準は `722217c`（本書の初版の時点。以後の `main` は記録の追加だけ）。file:line は目安:

- **送信レールは名前で 2 本**: `"x402"` と `"mpp"`（`src/config.ts:19` `OutboundRailName`）。合成（`src/main.ts:370-413` `composeRails`）は `"x402"` に `capabilities.evmSigning`、`"mpp"` に `capabilities.mppTempo` を**1 つずつ**束ね、
  知らない名前は起動を止める。route／プロファイルからレールを引くのも名前だけ（`src/main.ts:156-200` `railByRoute`）。残高の能力の選択も rail 名だけ（`src/main.ts:613`・`:831`）。
  したがって **同じ x402 の network 別の能力を同時に選べない**（動的 adapter 自体は能力とプロファイルの network の不一致を `not_sent` で拒む `src/adapters/outbound/x402-dynamic.ts:491`）。
  受信の要件 FR-2（network ごとの `evmSigning`）は S-3 に送られて未実装（`docs/multirail-design.md:4`）
- **x402 の送信能力は Base Sepolia に固定**: 本番の入口は `createRealEvmCapability(evmKey).capability("eip155:84532")`（`tools/rails-entry.ts:119`）。能力の工場は network を引数に取る（`tools/real-evm-capability.ts:28-57`）が、
  **network は能力の札であって署名器が chainId を検証するわけではない**（`:38`・`:54`）。chainId は組み直しの domain に入る
- **静的 x402 送信**（`src/adapters/outbound/x402.ts`）は公式 SDK（`@x402/fetch`・`@x402/evm` の `ExactEvmScheme`）で offer を読み、guarded signer（`:410-440`）が chainId・contract・to・from・value を承認値と照合してから **SDK の typed data をそのまま**署名器に渡す。
  受信の要件 §3.3 で「この形を新しい network に広げない」と決めた
- **動的 x402 送信**（`src/adapters/outbound/x402-dynamic.ts`）は offer の検査（`:118-175`。scheme・network・asset・額・payTo・`maxTimeoutSeconds`・`extra` の鍵の allow-list・`tokenDomain`。
  **`extra.assetTransferMethod` を含む offer は拒む** `:160`）の後、domain・contract・from・to・value を**プロファイルと承認値から組み**、`validAfter`・`validBefore`・`nonce` の 3 つだけを
  **SDK の提案から範囲検査で引き継いで**署名する（`:199-294`、範囲 `:258-283`）。送金直前に offer を読み直し、保存した offer と**完全一致**する accepts があるときだけ払う（`:506`）。
  network は `eip155:` 前提（`:88-94`）、領収は bytes32 の tx hash 前提（`:438`）。運用者のアドレスとして拒むのは **その能力の署名者と、そのプロファイルの `source.payTo` の 2 つだけ**（`:362`）。
  Arc（EVM）はこの形に乗る。Solana は乗らない
- **MPP 送信**は Tempo 専用（`mpp.ts:421-428`、`mpp-dynamic.ts:595-599`）。見積りで Tempo の RPC を読む（`mpp-dynamic.ts:760`・`:813`）。受信の要件 §3.3 どおり変えない
- **network の表**（`src/config.ts:45-79` `KNOWN_NETWORKS`）: Arc・Solana は `outbound: []`。表の照合は real モードで route の `destination` とプロファイルの `destination` に掛かる（`:891-914`）が、
  照合の引数に **token program は無い**（`:131`）。動的プロファイルの `rail` は `x402|mpp`（`:717-719`）、x402 は `tokenDomain` 必須（`:735-740`）——SVM の `mint`・token program の形はまだ無い
- **予算**（`src/core/budget.ts`）は `(network, asset)` の区分で、1 購入の両レグを合算して検査する（`:194-222`）。**静的の予算と動的の予算は別の台帳**で互いの予約を数えない（`:84`）。
  本番は受信レールが有効なとき Arc USDC・Solana USDC の区分を既に持つ（`tools/remote-mcp-config.ts:217-220`）。送信レグが同じ `(network, asset)` に落ちれば**同じ区分に合算**される（Base の送信が受信の区分を共有するのと同じ。`:301-303`）
- **本番の入口の鍵**: `SUBETHA_OUTBOUND_PRIVATE_KEY`（MPP 送信。必須）、`SUBETHA_OUTBOUND_X402_KEY`（x402 送信。既定は同じ鍵。`tools/remote-mcp.ts:91-124`）。**現行の入口が Solana について読むのは受信の owner の公開鍵だけ**
  （`tools/rails-entry.ts:49`）。ホストの env の実態は運用の記録（`docs/DEPLOY.md` §2c G-1）の範囲でしか言えない
- **Solana の RPC** は受信（SVM の `sourceRail`）があるときだけ依存先・拒否ホストに入る（`src/main.ts:349`）
- **SVM の transaction を組む code は受信 adapter にある**（`src/adapters/inbound/x402-svm.ts:90` `buildSvmTransactionMessage`: version 0、命令 4 つ = compute limit・compute price・`transferChecked`・Memo。
  上限の定数 `:41-54`。`lastValidBlockHeight: 0n` を置く `:96`）。`npm run sign` の Solana 側（`tools/svm-payer.ts`）はこれで部分署名するが、封筒は Router 受信専用で、blockhash は素の `fetch` で取る（`:76`）。
  `@x402/svm`（2.28.0）は **devDependency**（fixture の facilitator 用。`package.json:38`）で、`src/` は import しない。`@solana/kit`・`@solana-program/token`・`compute-budget` は dependencies（`:24-26`）
- **上流の Provider**: 本リポジトリの本番の設定にある上流は owner の別リポジトリの 2 つ（`provider-mpp.subethalabs.com`、`provider-x402.subethalabs.com`。`tools/remote-mcp-config.ts:12,19`）。
  **Arc で受ける Provider、Solana で受ける Provider はこの設定には無い**（受信の要件 D-3 は owner の判断待ちだった。D-10 で確認する）
- **結果の形**: `delivered`／`paid_data_unavailable`／`unknown`（`src/core/orchestrator.ts:776-830`。`not_sent`・`rejected` は受信が成立した後なので公開の状態は `paid_data_unavailable` `:817`）と
  `proof.onChainFinality: "not_checked"`（`src/mcp/tools.ts:402`）。**送信の領収を Router が独立に chain で確かめることはない**

## 2. 外部の事実と、確かめること

### 2.1 SDK の事実（`node_modules` の 2.28.0 を読んで確かめた）

- **Arc（EVM、x402 `exact`、EIP-3009）**: 払う側は EIP-712 の typed data（`TransferWithAuthorization`、domain USDC/2・chainId 5042002・contract `0x3600…0000`）に **offline で署名**する
  （`@x402/evm` の client の通常経路）。broadcast と gas は **Provider 側の facilitator** が持つ。Router は facilitator を呼ばない
- **Solana（x402 `exact`、SVM）**: 払う側（SDK の client `@x402/svm` `chunk-C3NL2A6D.mjs`）は `payTo` を **owner の公開鍵**として宛先 ATA を導き（`:74`）、`extra.feePayer` を fee payer にし（無ければ error `:90-92`）、
  RPC の `getLatestBlockhash` で lifetime を置き（`:94`）、命令 **4 つ**（compute price・compute limit・`transferChecked`・Memo）を組み、Memo は `extra.memo` があればそれ、**無ければ乱数 16 バイトの hex**（`:95-106`）、
  部分署名して facilitator に渡す（`:124`）。facilitator は署名を足して送信し（`exact/facilitator/index.mjs:262`）、**`extra.memo` があるときだけ** Memo が 1 つでその値と一致することを照合し（`chunk-RW6WN7YC.mjs:275-290`）、
  settle の後に `payTo` から導いた宛先 ATA の残高の増分を読む（`:447-453`）。**通常経路は宛先 ATA を作らない**（client は transfer と Memo を足すだけ、facilitator の通常経路は追加命令を Memo／Lighthouse に限る）。
  offer の `extra.recentBlockhash`・`lastValidBlockHeight` を使う経路もある（`chunk-RXPBSPMZ.mjs:277-290`）
- **blockhash の期限**は秒ではなく `lastValidBlockHeight`（block の高さ）で決まる。「約 60〜90 秒」は運用上の目安で、取得時刻からの保証ではない

### 2.2 Provider 側の仮定（offer からは証明できない。D-10 の構成の前提）

- Arc の Provider が Circle の facilitator を、Solana の Provider が x402.org の facilitator を使うこと。offer の `extra.feePayer` がその事業者の鍵であること。Router が確かめるのは
  **offer に書かれた宛先・fee payer と Router 自身の不等式**（FR-35）だけ
- Provider の offer が要求の間で**安定**していること（Router は送金直前に読み直して完全一致を求める `:506`）。SDK の server が乱数の Memo や新しい blockhash を offer に入れる構成なら一致しない（V-12）
- Provider が宛先 ATA を先に作っていること（rent は Provider）。無ければ Router は払わない（FR-24）
- Router は購入の transaction の **fee**（SOL）を払わない（fee payer は facilitator）。Router 自身の ATA の rent（1 回）は運用者（D-11）

### 2.3 確かめること（設計の前。V-6 以降は受信の V-1〜V-5 の続き番号）

| # | 確かめること | 方法 | 通らなければ |
|---|---|---|---|
| V-6 | Arc で x402 を受ける Provider の 402 の offer が、表と `checkDynamicX402Offer` の検査に通るか。**特に `extra.assetTransferMethod`**（Circle の要求の形には `"eip3009"` が入る。受信の V-1）を Provider の offer が含むか。含むなら、**列挙した値 `"eip3009"` だけ**を許す変更を別途レビューで審査する（allow-list の緩和は他の値には広げない） | Provider が立ったら `curl` で 402 を取り、検査の unit 試験に写す | 対応する offer を限定する（Provider 側で外せるなら外す） |
| V-7 | Solana で x402 を受ける Provider の 402 の offer の形: `extra.feePayer`、`asset` = mint、`payTo` = owner の公開鍵（SDK の導出で固定。受信の設計 §5.1 と同じ）、`extra.memo` の有無と長さ、`extra.recentBlockhash` の有無。**宛先 ATA が存在する**こと（`getAccountInfo`。rent は Provider） | 同上 | ATA が無い・`recentBlockhash` を含む offer は候補にしない（FR-24・FR-34） |
| V-8a | **offline**: Router が組んだ部分署名の transaction が、fixture の中で動かす本物の `@x402/svm` の facilitator の `/verify`（simulate）を通るか（命令 4 つ・compute 60,000・Memo） | 既存の fixture（`tests/fixtures/svm-facilitator.ts`）で | compute 予算・Memo を facilitator の規則に合わせる（Router の上限は動かさない） |
| V-8b | **実 facilitator**: devnet で x402.org の `/verify` → `/settle` が受けるか。**資金が動く**ので owner の承認の上で、使い捨ての鍵で 1 回（G-3′ より前の実決済として扱う） | Provider の fixture を Router の外で立て、実 facilitator に向ける | 同上 |
| V-9 | 運用者の資金: Arc の送信鍵（D-11）に Arc testnet USDC、Solana の送信鍵の ATA（rent は運用者）に devnet USDC が入り、faucet で補充できるか | owner の作業 | 受け入れ（G-3′）に進めない |
| V-10 | `ExactEvmScheme`／`@x402/fetch` が `eip155:5042002` を**静的**送信で扱えるか（viem の chain 定義） | 試験で確かめる。**扱えなくても要件は変えない**: Arc の静的 route も**動的の組み直しの形**で署名する（FR-22） | 静的 x402 送信 adapter を Arc には使わない |
| V-11 | Memo: SDK の上限（`MAX_MEMO_BYTES`）の値、空文字の扱い、facilitator が `extra.memo` 無しの transaction の Memo を読むか（読まない: `:275`） | SDK の code | FR-37 の上限を合わせる |
| V-12 | 候補の Provider（owner の `subetha-provider-x402`）の offer が要求ごとに変わる欄（Memo・feePayer・`recentBlockhash`）を持つか。持つなら Router の完全一致の規則と両立しない | Provider の実装を読む／402 を 2 回取って比べる | Provider 側で固定するか、一致の規則の緩和を**欄を列挙して**別途審査 |
| V-13 | Provider の実際の `PAYMENT-RESPONSE`（成功・失敗・pending の形）、HTTP の状態、応答時間。受信 facilitator の実績は Provider の HTTP の経路の証明にならない | V-8b と同時に記録 | FR-32 の表を直す |

## 3. スコープ

### 3.1 行列（受信 × 送信）

受信は 4 本（Base x402・Tempo MPP・Arc x402・Solana x402）、送信は本書で 4 本になる（Base x402・Tempo MPP・**Arc x402**・**Solana x402**）。新しく生まれる組:

| # | 受信（払う側が持つもの） | 送信（Provider が受けるもの） | 主張 | 静的 route 名（案） | 動的プロファイル名（案） |
|---|---|---|---|---|---|
| O-1 | Base Sepolia USDC（x402） | **Arc** USDC（x402） | Base の USDC しか持たない agent が Arc の Provider を使える（同じプロトコル、別チェーン） | `md-arc-eth-snapshot` | `dyn-x402-to-arc` |
| O-2 | Tempo pathUSD（MPP） | **Arc** USDC（x402） | MPP しか持たない agent が Arc の Provider を使える | `md-arc-eth-snapshot-mpp` | `dyn-mpp-to-arc` |
| O-3 | Base Sepolia USDC（x402） | **Solana** USDC（x402） | Base の USDC しか持たない agent が Solana の Provider を使える | `md-sol-eth-snapshot` | `dyn-x402-to-sol` |
| O-4 | Tempo pathUSD（MPP） | **Solana** USDC（x402） | MPP しか持たない agent が Solana の Provider を使える | `md-sol-eth-snapshot-mpp` | `dyn-mpp-to-sol` |
| O-5 | Arc USDC（x402） | **Solana** USDC（x402） | 新しいチェーン同士。**par の宣言が要る**（D-17） | `md-sol-eth-snapshot-arc` | `dyn-arc-to-sol` |
| O-6 | Solana USDC（x402） | **Arc** USDC（x402） | 同上 | `md-arc-eth-snapshot-sol` | `dyn-sol-to-arc` |
| — | Arc → Arc、Solana → Solana | | **同レール同チェーン**。本書の範囲外（D-16 で owner の承認）。足すなら 1 件の上限は両レグの和（§4.1 FR-29） | | |

名前の規則は既存どおり（送信先を先に、受信を接尾辞で。`md-mpp-eth-snapshot-arc` = Arc で払って MPP）。

### 3.2 推奨する範囲と順

- **S-3（Arc 送信）→ S-4（Solana 送信）**。S-3 は既存の動的 x402 の形に乗る（Router 側は小さい）。S-4 は新しい署名の境界（受信の要件どおり、独立レビュー 2 回以上）。
  有効化はレールごとに独立（FR-30）なので、**Arc を先に公開し、Solana は AC-14 の後**にできる（D-13）
- **公開する組は D-12**。推奨は **静的 2 本（O-1・O-4）＋動的 4 本（O-1〜O-4）**を先に。O-5・O-6 は能力の束縛が独立（FR-27）なら設定だけで足せる**見込み**だが、
  足すときも受け入れの購入と有効化の gate を通す（D-17）
- **Provider が先**（D-10）: Router の受け入れ（AC-13・AC-14）は Arc／Solana で受ける Provider が立っていることが前提。立つまでは fixture（本リポジトリの試験用 Provider）で開発し、
  本番の静的 route の上流 URL は Provider が立ってから入れる

### 3.3 やらないこと

- MPP で Arc・Solana に払う（MPP は Tempo 専用のまま）
- 資産の交換・ブリッジ。par（1:1）の宣言は受信の D-4 の組（Arc／Solana USDC ↔ Base USDC／Tempo pathUSD）に限る。Arc ↔ Solana は D-17
- 「任意の EVM／SVM チェーン」対応。送信も表の**列挙**だけ（Arc testnet・Solana devnet）
- 静的 x402 送信の「typed data をそのまま渡す」形を Arc に広げること（V-10）
- 送信先の chain を Router が読んで領収を独立に確かめること（`onChainFinality: "not_checked"` のまま。受信の D-9 の追跡は受信の settle の話で、送信には足さない）
- 同レール同チェーン（Arc → Arc、Solana → Solana）。D-16
- mainnet（受信の §3.4 と同じ）

## 4. 機能要件

### 4.1 共通（送信能力の network ごとの束縛・表・予算・有効化）

- **FR-27**（FR-2 の実現）: 送信能力（署名と、あれば残高）は **(レール, network)** で束ねる。`evmSigning` は network ごとに複数注入でき（Base・Arc）、`svmSigning`（新）は Solana の network に束ねる。
  route／プロファイルの送信は `rail` と `destination.network` の組で能力を引く。**起動時**: 組に対応する能力が無い・同じ組に 2 つある・能力の network の形が family と合わない → 起動しない。
  **署名時**: 承認済み offer の `network` と能力の `network` が一致しなければ `not_sent`（既存の `:491` を全レールに）。能力の network は札であり署名器は chainId を検証しないので、
  **chainId・mint は組み直しの側がプロファイル／表から入れる**（FR-22・FR-24）。Base 用の能力は Arc の offer を拒み、Arc 用は Base を拒む（AC-8）。**設定の `rail` の値は `x402`／`mpp` のまま**
- **FR-28**: `KNOWN_NETWORKS` の Arc・Solana に `outbound: ["x402"]` を足す。表が **mint・decimals・token program の権威**: Solana の `destination` は `tokenDomain` の代わりに `mint`（= asset）・`decimals` を照合し、
  token program は設定に値があれば表と一致を要求、無ければ表から導く（照合の引数に token program を足す）。mint は表の legacy SPL token program に固定（受信の設計 §5.1 と同じ。Token-2022 は受けない）
- **FR-29**: 予算は `(network, asset)` の区分に乗る。**静的と動的は別の台帳**（既存）。Arc USDC・Solana USDC の送信レグは**受信と同じ区分に合算**する（既存の Base と同じ）。これは資金の移動・補充・相殺ではなく
  **枠の共有**で、受信の利用が送信の残枠を使い切る（逆も）**可用性の問題**がある（D-14 で受容を決める）。同レール同チェーンを足すなら 1 件の上限は両レグの和（受信 11,000 ＋ 送信 10,000 は 20,000 を超える）。
  区分の無い `(network, asset)` は `bucket_not_allowed`
- **FR-30**: 本番の入口（`tools/remote-mcp-config.ts`・`tools/rails-entry.ts`・`tools/remote-mcp.ts`）の有効化は **レールごと・方向ごとに独立**（例 `{ arc: { inbound, outbound }, solana: { inbound, outbound } }`。
  形は設計）。**受信有効・送信無効**を保てること。無効な方向の**専用の**鍵（Solana の送信鍵）は読まない。Base と共有する EVM 鍵は Base のために読むので、Arc の送信が無効なら
  **Arc の能力を作らない**（鍵は読む）。Solana の RPC は **SVM の受信か送信のどちらかがある**とき依存先・拒否ホストに入る（`src/main.ts:349` を広げる）。有効化は受信と同じ gate（§6.3）
- **FR-31**: 呼び出し側の手順（CLAUDE.md、`npm run sign`）は**変わらない**——受信のレールは増えない。変わるのは一覧に出る route／プロファイルと `subject` の送信先の表示だけ（AC-11）
- **FR-32**（送信の結果の表）: 送信の結果は送信 adapter の規則で決まる（受信の設計 §6 は受信の表で、送信には使わない）。EVM（Base・Arc）は既存の動的 x402 の規則（領収の `success`・`network` の一致・
  bytes32 の `transaction`・`payer` があれば署名者と一致 `x402-dynamic.ts:424-440`・`:562`）。SVM は同じ構造で `transaction` が **base58 の 64 バイトの署名**。整合しない領収は `unknown`（資金が動いたかもしれない）。
  `not_sent`（署名の前の失敗。送信レグの資金は動かない）は受信が成立した後なので公開の状態は `paid_data_unavailable`（返金は無い。既存の開示）。この表は設計で 1 枚にする
- **FR-38**（運用者の集合）: 候補にしない宛先の集合は **「その能力の署名者と、そのプロファイルの `source.payTo`」だけではなく**、設定にある全 route／プロファイルの受取先（全 network）・全送信鍵の
  アドレス・それらから導いた ATA を、network と形（`0x`／base58）を保って登録し、**静的・動的の両方**で `payTo`・`feePayer` と照合する

### 4.2 Arc の送信（S-3）

- **FR-22**（引き継ぎ）: Arc の Provider の offer（EIP-3009、USDC/2）に **Arc 用の `evmSigning`** で署名する。署名の境界は動的の組み直し（`createRebuildingSigner`。domain・contract・from・to・value は
  プロファイルと承認値、`validAfter`・`validBefore`・`nonce` は SDK の提案を範囲検査で引き継ぐ——既存のまま）。静的 route も同じ形で署名する（V-10）
- **FR-23**（引き継ぎ）: 動的プロファイルの `tokenDomain`・`network` の組は表で許す。本番の静的 route の上流は Arc で受ける Provider（D-10）。`extra.assetTransferMethod` は V-6 の結果で（列挙した値だけ）
- **FR-33**: Arc の送信は chain を読まない（EIP-3009 は offline の署名。残高の事前確認は D-15）。残高切れは Provider 側の facilitator の verify／settle の失敗 → `paid_data_unavailable`／`unknown`（FR-32）。
  運用上は D-11 の補充で防ぐ

### 4.3 Solana の送信（S-4）

- **FR-24**（引き継ぎ、具体化）: 払う transaction は **承認値・表・Router 自身の値だけで組む**:
  fee payer = offer の `extra.feePayer`、source = Router の ATA（鍵の公開鍵と mint から導く）、destination = offer の `payTo`（owner の公開鍵）から導いた ATA（**存在を V-7／quote 時に確かめ、無ければ `not_sent`**。作らない）、
  mint・decimals・token program = 表、額 = 承認値、Memo = FR-37、compute budget = Router の既定（60,000 units・1 micro-lamport。上限 200,000・5,000,000）、lifetime = FR-34。
  **命令は常に 4 つ**（compute limit・compute price・`transferChecked`・Memo。受信の builder と同じ形）。署名は 1 回、部分署名、送信は facilitator。**SDK の提案は読まない**（`@x402/svm` の client を使わない）。
  **署名器から戻った wire の transaction を復号して再検査してから送る**: message の bytes が組んだものと一致、version 0、lookup table 無し、署名の数 = 2、[0]（fee payer）は全ゼロ、[1] は Router の署名で
  ed25519 の検証が通る、全体 ≤ 1,232 バイト（受信の preflight §5.3 の 1〜4 と同じ検査を送信にも）。`extra.recentBlockhash` を含む offer は候補にしない
- **FR-25**（引き継ぎ）: Router の Solana 鍵は ed25519 で x402 の送信にだけ使う。鍵は `tools/` だけが env から読む（名前は設計）。`src/` は能力（署名器＋公開鍵＋network、あれば `balanceOf`）だけを受け取る。
  残高の事前確認は D-15
- **FR-26**（引き継ぎ）: 動的プロファイルで `rail: "x402"` ＋ `destination.network: "solana:…"` を許す。`tokenDomain` の代わりに `mint`・`decimals`・token program（FR-28）
- **FR-34**（blockhash）: Router の Solana RPC（SSRF 防御 A の transport、既存の `ROUTER_SOLANA_RPC_URL`）に `getLatestBlockhash`（commitment `confirmed`）を **署名の直前に 1 回**。応答は
  base58 32 バイトの `blockhash` と整数の `lastValidBlockHeight` を要求（形が違えば `not_sent`）。`lastValidBlockHeight` は transaction の lifetime に入れる（`0n` を置かない）。
  **取得から署名までを局所的な上限（例 5 秒）で切る**（超えれば取り直さずに `not_sent`）。秒数での「期限切れに署名しない」保証は**しない**（期限は block の高さで、chain が決める）。
  RPC の失敗は `not_sent`。Provider の facilitator の `/supported` は呼ばない（fee payer は offer から）
- **FR-35**（隔離の不等式）: offer の `feePayer` は base58 32 バイトで、**`feePayer ∉ { Router の公開鍵, Router の ATA, payTo, 宛先 ATA, mint, token program, Memo program, ComputeBudget program, System program }`**。
  `payTo ∉ 運用者の集合（FR-38）`、`payTo ≠ mint`、`宛先 ATA ≠ Router の ATA`。1 つでも破れば候補にしない（`not_sent`／quote 不成立）
- **FR-36**（期限）: `PayRequest` に **承認の期限**を載せ（今は無い `src/ports/outbound.ts:83`）、adapter は **署名の直前と送出の直前**に `now < 期限` を再検査する。過ぎていれば `not_sent`。
  受信は成立済みなので、呼び出し側には「送信レグの資金は動いていない、受信の資金は返らない、Router は自動で買い直さない」と伝える（既存の開示の範囲）
- **FR-37**（Memo と購入の一意性）: Memo は **常に 1 つ**。offer に `extra.memo` があればその値（UTF-8 で 1 バイト以上・SDK の上限以下・制御文字無し。範囲外なら候補にしない）、無ければ
  **Router の `paymentId` から決まる値**（購入ごとに一意）。Provider が固定の Memo を要求する構成では、同じ blockhash・source・destination・額で **別の購入が同じ message になり得る**
  （同じ署名 = chain では 1 つの transaction）ので、Router は **署名した message の hash を保持し、同じ message には 2 度署名しない**（`not_sent`、理由 `destination_message_collision`）。
  同じ購入の再提出・再起動後は**再署名しない**（既存の 1 回の規則）。試験: 固定 Memo の fixture に対し、同じ blockhash で 2 件を並行 → 2 件目は `not_sent`

## 5. 安全・運用の要件

- **SR-1**（引き継ぎ）: 新しい依存は増やさない方針。SVM の送信は `@solana/kit`・`@solana-program/*`（既に dependencies）と `@noble/curves`（受信の preflight と同じ）で組む。`@x402/svm` を `src/` から使うなら SR-1 の記録の上で dependencies に移す
- **SR-2**: Solana の送信鍵は**資金を動かす鍵**。Base／Tempo の送信鍵と同じ扱い（ホストの env ファイル、ログに出さない、`tools/` だけが読む、`npm run sign` の鍵と混ぜない）。受信の受取 owner の鍵とは**別**にする（D-11 で選ぶ。別鍵なら受信の資金は送信の権限から隔離される）
- **SR-3**: 署名の境界のレビュー: S-3 は 1 回以上、S-4 は **2 回以上**。sabotage: 組み直しの欄（宛先 ATA・額・mint・fee payer・compute 上限・Memo・lifetime）を 1 つずつ外した変異、署名済み raw の再検査を外した変異、
  message の hash の記録を外した変異が試験で落ちる
- **SR-4**: egress: 送信で新しく接続する先は **Provider の URL**（静的は固定、動的は呼び出し側の URL）と Solana RPC だけ。Circle・x402.org への接続は増えない。拒否ホストの規則は既存
- **SR-5**: 実決済（V-8b・G-3′）は testnet・使い捨てまたは運用者の口座・owner の承認。公開の Router を止めて受け入れ用の起動で行う（既存の手順）

## 6. 受け入れ条件

### 6.1 Router（offline、fixture）

- **AC-8**（S-3）: 既存のレール（Base x402・Tempo MPP）で払って Arc の Provider（fixture）が `delivered`。authorization の domain・chainId・額・宛先が承認値（組み直し）。Base 用の能力は Arc の offer を拒み、Arc 用は Base を拒む
- **AC-9**（S-4）: 既存のレールで払って Solana の Provider（fixture: 本物の `@x402/svm` の facilitator を fixture の中で動かす既存の形。**simulate・send・confirm は模擬**なので、実 ATA・compute の消費の証拠にはならない）が `delivered`。
  命令が承認値だけ（FR-24）、署名 1 回、fee payer ≠ Router。改変は 3 つに分けて試験する: **(a) offer の改変**（宛先・額・feePayer・memo・未知の `extra`）は候補にしない、
  **(b) 組み立ての改変**（builder に別の宛先・額・追加の命令を混ぜる変異）は署名の前の再検査で落ちる、**(c) 署名器が返した raw の改変**は送出前の再検査で落ちる
- **AC-10**: D-12 で選んだ組の静的・動的が統合の harness（`tests/wire/multirail-integration.test.ts`）で `delivered`。失敗の経路を列挙して試す: 承認の期限切れ（署名前・送出前）、運用者の集合への宛先、
  未知の `extra`、宛先 ATA 不在、RPC の失敗（blockhash）、取得〜署名の上限超過、Memo の衝突、受信成立後・送出前の crash（再起動後に再署名・再送信 0）、送出後の応答喪失（`unknown`、再起動後も再送信 0）
- **AC-12**: sabotage（SR-3）と、能力の束縛（network の取り違え・重複・欠落）・表（token program）・予算の区分・領収の形（FR-32）・運用者の集合（FR-38）を外した変異が落ちる

### 6.2 本番（受け入れの購入）

- **AC-13**（S-3）: 公開する Arc 宛の組**すべて**（推奨なら静的 O-1 と動的 O-1・O-2）で各 1 件 `delivered`。記録: 両レグの tx（受信の settle、Provider 側の facilitator の Arc の tx を Arc の RPC で `success` と転送の内容まで）、
  送受取先・額、Provider の応答の本文、client が受けた結果、保存した結果の再読取
- **AC-14**（S-4）: 公開する Solana 宛の組**すべて**（推奨なら静的 O-4 と動的 O-3・O-4）で各 1 件 `delivered`。記録: 署名が devnet で finalized、Provider 側の ATA の増分、以下 AC-13 と同じ。
  これらの外部の確認は Router の `onChainFinality: "not_checked"` と矛盾しない（Router は主張しない。運用者が確かめる）
- **AC-11**: 公開 MCP の一覧に新しい route／プロファイルが出て、`subject` の送信先（network・asset・decimals）と `disclosures` が正しい。CLAUDE.md の表を更新（英語）

### 6.3 gate（受信と同じ形。レールごとに独立）

G-1′（鍵と資金: D-11、V-9）→ G-2′（無効のまま配備）→ G-3′（受け入れの購入 AC-13／AC-14。V-8b の実 facilitator の probe はこれより前の実決済として別に承認）→ G-4′（有効化。Arc と Solana で別々にできる）。各段 owner の確認。

## 7. 受容するリスク

| リスク | 扱い |
|---|---|
| Provider 側の facilitator（Circle／x402.org）が verify／settle を失敗させる・遅らせる | Router は `paid_data_unavailable`／`unknown` を返す（FR-32）。送信先の chain は読まない（§3.3）。返金は無い（既存の開示） |
| Router の送信資金（Arc USDC・devnet USDC）が尽きる | D-15 の結果次第で事前確認の有無が決まる。無ければ受信の成立後に facilitator の verify（simulate）か settle で分かり、`paid_data_unavailable`。運用で補充（D-11） |
| blockhash の期限が承認〜署名〜送出の間に切れる | FR-34・FR-36 で署名の前に止める（秒の保証ではない）。切れた後の送出は facilitator の simulate で落ち `paid_data_unavailable`。呼び出し側は quote を取り直す（受信の資金は返らない） |
| Provider の offer が要求ごとに変わる（乱数の Memo 等） | 完全一致で `not_sent`（V-12 で先に確かめる） |
| 固定の Memo で別の購入が同じ message になる | FR-37 で 2 件目を止める |
| 方向間で予算の枠を共有する | D-14 |
| 一覧が長くなり、呼び出し側が組を取り違える | D-12 で公開する組を絞る。名前の規則を守る |

## 8. owner に決めてもらうこと

| # | 問い | 推奨 |
|---|---|---|
| D-10 | **Provider**: Arc で x402 を受ける Provider と Solana で x402 を受ける Provider を**誰がどこに**立てるか（owner の `subetha-provider-x402` を Arc と Solana でも動かす／本リポジトリに試験用の Provider を足して owner が配備する／第三者の Provider を使う）。URL と受取先（owner の公開鍵と、**事前に作った ATA**）はいつ分かるか。facilitator は Circle／x402.org か | owner の `subetha-provider-x402` を 2 つ追加で配備（facilitator は Provider 側の設定）。Router の開発は fixture で先に進め、URL が決まった時点で静的 route に入れる |
| D-11 | **鍵と資金**: Arc の送信鍵は Base／Tempo と同じ EVM 鍵（既定）か別か。Solana の送信鍵は**新しい ed25519 鍵**か、**受信の受取 owner の鍵を再利用**するか。Router の ATA の作成と rent（運用者）。faucet で Arc testnet USDC・devnet USDC を入れる作業 | Arc は同じ鍵（既定の `SUBETHA_OUTBOUND_X402_KEY` を Arc にも束ねる。env は増やさない）。Solana は**新しい鍵**（受信の資金を送信の権限から隔離する）。鍵は Router の開発側が作って G-1′ で owner が承認し、owner が資金を入れる |
| D-12 | **公開する組**: §3.1 の O-1〜O-6 のうちどれを静的 route／動的プロファイルで出すか | 先に静的 2（O-1・O-4）＋動的 4（O-1〜O-4）。O-5・O-6 は D-17 |
| D-13 | **順と公開**: S-3 → S-4 の順で作り、**Arc を先に有効化**するか（FR-30 で独立）、両方の AC が揃うまで待つか | S-3 → S-4 の順で作り、Arc は AC-13 の後に先に有効化 |
| D-14 | **予算**: 新しい組の静的・動的の区分は受信の D-7 と同じ桁か。**方向間で枠を共有し、片方向が他方を止め得ること**を受容するか（分けるなら区分の鍵を変える設計が要る） | 同じ桁（動的 1 件 20,000、通算 100,000,000、件数 1,000）。testnet では共有を受容（通算の枠は十分大きい） |
| D-15 | **残高の事前確認**: 元の FR-25 は Solana の残高の事前確認を求めていた。今の本番は EVM・MPP とも事前確認を注入していない（`balanceOf` は全プロファイルにあるときだけ core に渡る）。Solana だけ足すか（RPC は既にある。core の「全部あるとき」の規則をプロファイルごとに変える）、全レールで見送る（受信成立後に不足が分かるリスクを明記）か | Solana に足す（quote 時に Router の ATA の残高を 1 回読む。guarded transport）。EVM は RPC を持たないので見送り、リスクを明記 |
| D-16 | **同レール同チェーン**（Arc → Arc、Solana → Solana）を本書の範囲外とすることの承認（受信の要件 §3.3 には書かれていない） | 範囲外。足すなら別の行列の項目として要件から |
| D-17 | **O-5・O-6（Arc ↔ Solana）の par の宣言**（受信の D-4 に無い組）と、足すときの受け入れ・有効化の gate | testnet では par。足すときは AC-13／AC-14 と同じ購入と gate を通す |

## 9. 本書で決めていないこと

- 能力の注入の具体（`RouterCapabilities` の形、有効化の形、route からの能力の引き方、`PayRequest` の期限の欄）——設計
- SVM の offer の検査の欄の全列挙、Memo の上限の値、取得〜署名の上限の値、message の hash の保持の形（process 内か journal か）——設計
- 試験用 Provider（fixture）の形（Arc は既存の `tests/fixtures/dynamic/x402-upstream.ts` の network の一般化、Solana は `tests/fixtures/svm-facilitator.ts` と組む新しい fixture）——タスク
- Provider 側（別リポジトリ）の変更——本書の範囲外（D-10）

## 10. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-07 | `gpt-6-astra`（read-only。第 1 版 `448d9b3`） | **REJECT**（12 項目: §1 の断定、`payTo` = owner と ATA の事前作成、Memo の一意性、署名済み raw の再検査と隔離の列挙、blockhash の期限、残高の事前確認の矛盾、有効化の独立、予算の共有、SDK の事実と Provider の仮定の分離、AC の分割と失敗の表、owner の判断の不足、形式）。第 2 版で反映 |
