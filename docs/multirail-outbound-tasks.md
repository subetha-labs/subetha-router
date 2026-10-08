# タスク分解: Arc と Solana の Provider に払う（S-3・S-4）

> 2026-10-07、第 2 版。入力は `docs/multirail-outbound-requirements.md`（要件 第 3 版、owner の決定 §0）と `docs/multirail-outbound-design.md`（設計 第 5 版、owner 承認「この設計で進めてください」2026-10-07）。
> 以下「設計 §x」「要件 FR-x」はそれらを指す。本書はタスクフェーズの成果物で、コード・実行結果・合格の主張は含まない。記載のコマンドは**計画であり未実行**。
> 第 1 版は独立レビューで APPROVE WITH CHANGES（高 3・中 4・低 1。§4）。第 2 版で反映: Arc 先行の有効化と U9 の整合と gate の直列化、予算の検証の主担当（U8-a）、結果の表の主担当（U3）、U2 の sabotage の観測、
> 残高の配線の責任分担、§0 の「既存の変更」の列挙、gate の外部接続と記録、§3 の主担当の表、試験ファイルの対応、U6・U8 の分割。

## 0. 全タスク共通

- **担当**: 親（controller）が状態・commit を持ち、実装後に実ソースを読み戻してテストを実際に実行する。レビューは `gpt-6-astra`・read-only で差分を見る。writer は 1 つ（worker を重ねない）
- **順序**: まず落ちるテストを書き、赤を確かめてから実装する。完了条件の試験は**守っているコードを外して落ちること**（sabotage）を確かめ、結果を PR に書く。**変異の前に commit する**（mutation の復元は commit から）
- **完了コマンド**: focused（当該テスト）→ `npm run types` → `npm test`。skip と失敗を区別して報告する。「Linux」と書いた完了条件は Linux（Colima の `node:22-bookworm`）で実行した結果を要する
- **資金**: **資金が動く決済は gate（UG-A・UG-S の V-8b・G-3′）だけ**。それ以外のどのタスクも本物の facilitator・Provider・RPC に接続しない（loopback の fixture だけ。fixture の facilitator の settle は模擬で、資金は動かない）。
  **mainnet の資産は一切使わない**
- **外部への接続は gate の中だけ**。許す範囲（各 1〜数回。日時・回数を記録）:
  - Provider の 402 の読取（V-6・V-7・V-12・V-13: `PAYMENT-RESPONSE`・HTTP の状態・応答時間も G-3′ で記録）
  - Router の adapter が使う Solana devnet の RPC（`getAccountInfo`・`getTokenAccountBalance`・`getLatestBlockhash`。設計 §4.3 の 3 方法）
  - **運用者（親）が確認のために使う読取**（Router の外。adapter の 3 方法とは別）: Arc の RPC で tx の `success` と転送の内容（AC-13）、Solana devnet の RPC で署名の finalized と Provider の ATA の増分（AC-14）、公開 MCP を HTTPS で呼ぶ一覧・各組の quote（AC-11。支払わない）
  - owner の作業: faucet（Arc testnet USDC・devnet USDC）、Router の ATA の作成（rent）、Provider の配備
  - 受け入れ用の起動（G-3′）が受信側で使う既存の接続（facilitator・Tempo の RPC・Solana の起動時の検査）と、実 facilitator の probe（V-8b。owner の承認）
- **既定で無効**: **レールごと**に、その G-4′ まで送信の route／プロファイルを本番の入口に出さない（`RAILS_ACTIVATION` の `outbound: false`。U5 が Arc・Solana とも `false` を固定し、UG-A の G-4′ で `arc.outbound: true`、U9 は **Arc の承認済みの状態を保ったまま `solana.outbound: false`** を固定する）。
  Provider の URL の定数（`UPSTREAM_ARC`／`UPSTREAM_SOL`）は Provider が立つまで空
- **gate と開発の直列化**: gate（UG-A）が検証するのは**固定した commit・設定・イメージ**。gate の間に `tools/remote-mcp-config.ts`・`tools/rails-entry.ts`・`docs/DEPLOY.md`・`CLAUDE.md` を変える PR（U9 等）は、gate の各段の**合間に直列に**取り込み、取り込んだ後は G-2′ の配備からやり直す（受け入れ G-3′ の後に取り込んだなら G-4′ の前に再配備して AC-11 を再確認）。Provider／owner 待ちの間に U6〜U8 の開発は進める
- **既存の adapter の挙動で意図して変えるのは次の 2 つだけ**で、各タスクに明記する: (a) 送信 adapter の**期限の検査**（実署名の委譲の直前・送出の直前。MPP は実署名の前と送金 RPC の前。設計 §2.4。U3）、
  (b) **運用者宛ての offer を候補の段階で外し、`pay` でも再検査する**（設計 §2.3。U3）。Base の静的の領収の処理・MPP の送金後の扱いは変えない。
  **adapter 以外で既存の動作が変わるもの**: (c) 本番の入口の有効化の token（`arc`・`solana` → `arc-in`・`arc-out`・`solana-in`・`solana-out`。設計 §6.1。U5）、(d) 本番の入口の **x402 送信の鍵の転送**（今は MPP 受信のときだけで、Arc／Solana 受信 → Base 送信の動的プロファイルに漏れる。生成した設定に x402 送信があるときに。設計 §6.2。U5）、
  (e) 残高の配線（rail → 能力 → なし。能力に `balanceOf` を持つ既存の構成では「全部あるときだけ」の規則が無くなる。設計 §2.6。U2）
- **依存**: 新しい npm 依存は足さない（設計 §9）。`@x402/svm` は devDependency のまま（`src/`・`tools/` から import しない試験は既存。U6-b で再確認）
- **鍵**: `src/` は env を読まない。試験の鍵は毎回の乱数（SVM の fixture-key は本当に署名する乱数の seed）。実鍵は `tools/` と ignored の env ファイルだけ。**鍵・RPC の URL・ローカルの絶対パスを docs・PR に書かない**。能力は鍵の文字列を保持しない（U6-b）。起動の失敗の文は固定（U9）
- **SR-3（署名の境界の独立レビュー）の置き場**: Arc は **U4 の PR（1 回目）**。SVM は **U7 の PR（1 回目。adapter の実ソース。U6-a・U6-b を含む）と U8-b の PR（2 回目。U6-a〜U8-b の実ソース全体を範囲に含める。「差分」ではなく実ソースを見る指示を出す）**
- **commit**: 1 タスク 1 PR。レビューの指摘は同じタスクの中で直す。小さな訂正に全体の再レビューをしない。Codex の承認と試験の通過（Linux）で親が merge する（owner の確認は gate と配備）
- **停止条件**: 誤支払い・二重支払いの可能性、秘密の露出、設計と実測の食い違い（設計を改訂してから続ける）、未許可の権限、外部の事実の変化（Provider の offer の形・SDK の挙動が設計と違う。V-6・V-7・V-12）

## 1. 依存

```
U1 表と設定（parse だけ）                                   ← main
U2 core の port・hash の予約・残高の hook                     ← U1
U3 送信 adapter の期限・運用者の集合・共有の領収（x402 静的/動的・MPP） ← U2
U4 合成 (rail, network)・Arc の静的（組み直し）              ← U3
U5 本番の入口（方向別の有効化・token の移行・Arc）           ← U4
UG-A Arc の gate（V-6・V-12・V-13、G-1′〜G-4′。owner）       ← U5、Provider（D-10）
U6-a SVM の純粋関数（offer・message・wire）                   ← U2
U6-b SVM の鍵の道具・能力・fixture                           ← U6-a
U7 SVM の adapter と Provider の fixture                      ← U6-b, U3
U8-a 合成に SVM・統合（行列・予算・残高）                     ← U7, U4
U8-b process の中断の試験                                    ← U8-a
U9 本番の入口（Solana）と文書                                ← U8-b, U5
UG-S Solana の gate（V-7・V-8b・V-12・V-13、G-1′〜G-4′。owner） ← U9、Provider（D-10）
```

U2 の後は U3 と U6-a が並行できる（writer は 1 つなので、実際には順に）。UG-A は U5 の後なら U6-a〜U8-b の開発と並行できる（§0 の直列化の規則の下で。Arc を先に有効化する。D-13）。

## 2. タスク

### U1 — network の表と設定（設計 §1、FR-26・FR-28）

| 内容 | 成果物 | 完了条件（unit） |
|---|---|---|
| `KNOWN_NETWORKS` の Arc・Solana に `outbound: ["x402"]`。`TermsToValidate.tokenProgram`。`validateTermsAgainstTable`: svm で `tokenProgram` は表と一致・`tokenDomain` は拒否、evm で `tokenProgram` は拒否。`DynamicProfile.destination.tokenProgram?`。`parseDynamicProfile` の x402 の分岐を family で分ける（evm: `tokenDomain` 必須、svm: `tokenDomain` 禁止・`decimals` 必須・`tokenProgram` 任意）。`validateRouterConfigAgainstTable` がプロファイルの送信レグに `tokenProgram` を渡す。`tests/fixtures/known-networks.ts` の `TEST_NETWORKS` も同じ | `src/config.ts`、`tests/unit/config*.test.ts` | 表: Arc・Solana 宛の静的 route と動的プロファイルが real モードの照合を通る／`tokenProgram` が表と違う・evm に `tokenProgram`・svm に `tokenDomain` → 起動時に拒否。parse: svm の x402 プロファイルが `tokenDomain` 無し・`decimals` ありで通り、`tokenDomain` あり・`decimals` 無しで落ちる。評価は **mint = `asset`**（`mint` の欄は受けない: 未知の鍵で拒否）。既存の全試験が通る |

- **sabotage**: `outbound` を `[]` に戻す／`tokenProgram` の照合を外す → 試験が落ちる

### U2 — core の port・message の hash の予約・残高の hook（設計 §2.4・§2.5・§2.6、FR-36・FR-37、D-15）

- **範囲**: `src/ports/outbound.ts`（`PayRequest.deadlineMs`・`reserveMessage?`、`OutboundRail.balanceOf?`・`startup?`、`SvmSigningCapability` の型）、`src/core/store.ts`（event `destination_message_reserved`、`reserveMessage` を `#queue` の中で未使用の検査 → 追記・fsync → 索引、replay、壊れた行で `load` が throw）、
  `src/core/orchestrator.ts`（`deliver` が `deadlineMs`・`reserveMessage` を付ける；静的の残高の hook を `source_pending` の前に、`source_failed`／`operator_funds_unavailable`）、`src/core/dynamic.ts`（`balanceOf` の `undefined` = 検査なし）、`src/main.ts` の残高の配線の**契約**（rail → 能力 → なし。`dynamicCoreOptionsOf` の「全部あるとき」をやめる。組ごとの選択は U4）。
  `src/core/journal.ts` は event が任意の文字列なので**変更不要**（確認して PR に記す）
- **完了条件（unit。`tests/unit/message-reservation.test.ts`、既存の orchestrator・dynamic の試験に追加）**:
  - `reserveMessage`: 形（小文字 hex 64）・状態（`destination_pending` 以外）→ `unavailable`、同じ hash（別 paymentId・同じ paymentId）→ `collision`、journal の追記の失敗 → `unavailable` で Set に入らない、replay で復元して衝突、壊れた行で起動しない、queue の中で直列（並行 2 件の予約で 1 件だけ `reserved`）
  - `deliver` が `deadlineMs = intent.approvalDeadlineMs` と `reserveMessage` を渡す（fixture の rail で観測）。既存の rail は余分な欄を無視して今までどおり
  - 静的の残高の hook: `undefined` → 通る、不足・throw・`bigint` でない → `source_failed`（`not_sent`、`operator_funds_unavailable`）、公開の状態 `awaiting_payment`、**journal に `source_pending` が 1 行も無く**受信の verify 0 回。動的: `undefined` で通り、不足で `awaiting_payment`（既存）、能力の `balanceOf` だけがあるときも使われる（互換）
- **sabotage**: 未使用の検査を queue の外に出す → 並行の試験が落ちる／永続化を省く → 再起動の衝突の試験が落ちる／replay を外す → 同上／hook の位置を `source_pending` の後に動かす → 「`source_pending` が無い」試験が落ちる。（「予約を署名の後に動かす」は adapter の順序なので U7）

### U3 — 送信 adapter の期限・運用者の集合・共有の領収（設計 §2.3・§2.4・§3.2 の共有・§5、FR-32・FR-36・FR-38）

- **範囲**: `src/adapters/outbound/x402-challenge.ts`（402 の読取の共有）、`x402-dynamic.ts`（`createRebuildingSigner` の引数を `destination` に・`deadlineMs` を委譲の直前 `:275` で検査、`receiptOf`／`deliveredBodyOf` を module の関数に（form・依存を引数に）、
  運用者の集合 `operatorAddresses` を注入して `operatorAddressesOf` を置き換え（候補の段階と `pay` の再検査）、`x402.ts`（候補の段階 `offersOf` で運用者宛てを外し `pay` でも再検査、guarded signer の委譲の直前 `:438` と送出の直前 `:503` の期限、`operatorAddresses`・`rebuildSignatures` の option は受けるが **`true` の経路は U4**）、
  `mpp.ts`・`mpp-dynamic.ts`（運用者の集合: challenge の受取先が集合にあれば候補外・`pay` で再検査；期限: `DeadlineRefusedError`・`refusedBeforeDispatch`、(A) 実署名の前・(B) 署名の後・送金 RPC の前 → `not_sent`、送金 RPC の後は既存）
- **完了条件（wire。既存の試験ファイルに追加）**:
  - x402 静的・動的: 期限を署名の直前に過ぎさせる fixture（SDK の `onBeforePaymentCreation` で時計を進める）→ `not_sent` `destination_deadline`・署名 0・支払い要求 0；署名の後・送出の前に過ぎる → `not_sent`・署名 1・支払い要求 0。運用者宛ての offer（受信の受取先・署名者）は候補に出ない（quote が不成立）、`pay` の再検査でも `not_sent`
  - MPP 静的・動的: (A)・(B)・送金後の 3 つ（設計 §7.2 の行）。送金 RPC の委譲の後の期限切れは既存の結果（`not_sent` にならない）。運用者宛ての受取先は候補外
  - **結果の表（設計 §5）の主担当**: 共有の `receiptOf`／`deliveredBodyOf` を **EVM の form と SVM の form の両方**で 1 つの試験の表に: `transaction` の形違い、`success` 偽、`network` 不一致、`payer` の形違い・不一致（→ `unknown`）、整合した領収つきの非 200（4xx・500 とも → `paid_no_data`）、領収なしの 2xx（`unknown`）・≥ 500（`unknown`）・それ以外（`rejected`）、整合かつ 200 で本文の取得失敗・過大・object でない（→ `paid_no_data` の 3 つの理由）。動的 EVM の既存の試験が全部通る。**Base の静的の領収の試験は変わらない**（`rebuildSignatures: false`）
- **sabotage**: 期限の検査を arm の前に戻す（委譲の直前から外す）→ 「署名の直前に過ぎる」試験が落ちる／候補の段階の運用者の照合を外す → quote が成立してしまう／MPP の (B) を外す → 署名 1・送金 0 の試験が `unknown` になって落ちる／領収の `network` の照合・`payer` の照合を外す → 表の試験が落ちる

### U4 — 合成 `(rail, network)`・Arc の静的（設計 §2.1〜§2.3・§3、FR-22・FR-23・FR-27・FR-33・AC-8）

- **範囲**: `src/main.ts`（`RouterCapabilities.evmSigningByNetwork`・`svmSigning`（型だけ。SVM の合成は U8-a）、送信の組の集合と adapter の生成、起動時の検査（欠落・重複・key と `network` の不一致・family）、`railByRoute` を組で、運用者の集合 (a)(b) の構築、`upstreamsFor`／`dynamicOptionsFor` を組で、
  **残高の選択を組で**（rail → 能力 → なし。U2 の契約の上に）、Solana RPC の条件（受信 ∨ 送信）、`svmRpcTransportOf`）、`x402.ts` の `rebuildSignatures: true` の経路（組み直しの署名器・動的と同じ組み立て・共有の領収）、`tests/fixtures/dynamic/x402-upstream.ts`（`standardAccept` の Arc、`paidOk` の network 引数）
- **完了条件**:
  - unit（`tests/unit/outbound-composition.test.ts`）: 組ごとに adapter が 1 つ、`railByRoute` が routeId／profileId から組の adapter を引く、欠落・重複・key と `network` の不一致・family の不一致で `SignerNotAuthorizedError`、同じ x402 の Base と Arc で残高の選択が組ごと（rail の `balanceOf` → 能力の → なし の順）、運用者の集合に (a)(b) が入り Provider の `destination.payTo` が入らない、Solana RPC が送信だけでも拒否ホストに入る
  - wire（`tests/wire/x402-arc-outbound.test.ts`）: 静的 Arc が組み直しの署名器で `delivered`（domain・chainId 5042002・contract・to・value が承認値。署名 1 回）、動的 `dyn-x402-to-arc` が `delivered`、**Base 用の能力で Arc の offer → `not_sent`、Arc 用で Base の offer → `not_sent`**（AC-8 の両方向）、Arc の領収は bytes32（共有の関数に繋がっている: `network` 不一致で `unknown`）、
    **Arc の送信で chain の RPC に 0 接続**（FR-33。guarded transport の接続を数える）、`extra.assetTransferMethod` は V-6 の結果まで**拒否のまま**（試験で固定）。Base の静的・動的の既存の試験が変わらない
  - **SR-3（Arc、1 回目）**: この PR のレビューで組み直しの境界の実ソースを見る
- **sabotage**: 起動時の key と `network` の照合を外す → 不一致の試験が落ちる／`rebuildSignatures` を無視して passthrough に戻す → 「SDK の typed data を変える fixture」で署名してしまう試験が落ちる／能力の network の照合（`not_sent`）を外す → 両方向の試験が落ちる

### U5 — 本番の入口: 方向別の有効化・token の移行・Arc（設計 §6.1〜§6.3・§6.5、FR-29（生成）・FR-30、D-11〜D-14・D-16）

- **範囲**: `tools/remote-mcp-config.ts`（`RailsActivation = { arc: { inbound, outbound }, solana: {…} }`、`RAILS_ACTIVATION`（送信は `false`）、`RAILS_NONE`、`railActive`、受信だけを見る箇所の `.inbound` 化、`OUTBOUND_ARC`・`UPSTREAM_ARC`（空）、route `md-arc-eth-snapshot`（条件つき）、プロファイル `dyn-x402-to-arc`・`dyn-mpp-to-arc`、`railBuckets` を受信 ∨ 送信に、D-14 の値）、
  `tools/rails-entry.ts`（token `arc-in` 等の変換と復元、`evmSigningByNetwork` の注入、`SUBETHA_ARC_PROVIDER_PAYTO` の読み取り）、`tools/remote-mcp.ts`（x402 送信の鍵の転送を「生成した設定に x402 送信があるとき」に）、`tools/rails-acceptance-run.ts`（既定 `arc-in,solana-in`、`railActive`、`announcementOf`）、`tools/remote-router-process.ts`（固定文）、
  `docs/DEPLOY.md`（token の実行例と rollback の文、§2c に Arc 送信の段の手順）、`CLAUDE.md`・`README.md`（Arc の route／プロファイルの行。**「有効化の後に出る」と明記**）
- **完了条件（unit・process。既存の `remote-mcp-config.test.ts`・`rails-entry.test.ts`・`rails-acceptance-run.test.ts`・`tests/wire/rails-process-entry.test.ts` に追加）**:
  - 旧 token（`arc`・`solana`）は拒否、新 token の往復、未知・重複は拒否。`RAILS_ACTIVATION` の送信が **Arc・Solana とも `false`**（公開の設定に送信の route／プロファイルが出ない）
  - `arc.outbound: true` で `dyn-x402-to-arc`・`dyn-mpp-to-arc`（MPP 受信あり）が出て、`md-arc-eth-snapshot` は `UPSTREAM_ARC` と受取先の env があるときだけ。受取先の形が悪ければ `HostPlanError("config")`。**公開する ID の集合は設計 §6.3 の 6 本だけ**（O-5・O-6 の ID が無い。D-12・D-16）
  - 区分の生成（FR-29）: Arc USDC の区分が送信だけでも出て、静的・動的の両方にあり、`maxPerPurchase`・`maxTotal`・件数が D-14 の値（既存と同じ桁）。**合算・別台帳・区分欠落の動作の検証は U8-a**
  - 受信だけの箇所が `outbound` に反応しない（`arc.outbound` だけ `true` で受取鍵・`sellerProofs`・受信の route が出ない）
  - x402 送信の鍵の転送: MPP 受信無しでも Arc／Solana 受信の動的プロファイルがあれば子に渡る（今の漏れの修正を試験で固定）
  - process: `arc-out` で `evmSigningByNetwork["eip155:5042002"]` が同じ鍵の address で注入される。無効なら無い
- **sabotage**: 受信だけを見る箇所を truthiness に戻す → 「送信だけ true」の試験が落ちる／鍵の転送の条件を MPP 受信に戻す → 試験が落ちる／区分の生成を受信だけに戻す → 送信だけの区分の試験が落ちる

### UG-A — Arc の gate（要件 §6.3、AC-11・AC-13。owner の確認。§0 の直列化の規則）

| 段 | 内容 | 条件 |
|---|---|---|
| V-6・V-12・V-13 | Provider（D-10。owner の `subetha-provider-x402` の Arc 用）が立ったら 402 を 2 回取り、`extra` の鍵（`assetTransferMethod`）と要求ごとの変化を記録。`assetTransferMethod: "eip3009"` が出るなら **列挙した値だけ許す変更を別の PR で**（U4 の試験を更新、Codex のレビュー）。G-3′ で `PAYMENT-RESPONSE`・HTTP の状態・応答時間を記録 | owner が Provider の URL と受取先を知らせる |
| G-1′ | 送信鍵は Base と同じ（D-11）。その address に Arc testnet USDC（faucet）。`UPSTREAM_ARC` と `SUBETHA_ARC_PROVIDER_PAYTO` を入れる PR（commit を固定） | owner（資金） |
| G-2′ | `outbound: false` のまま配備（イメージは手元で作る。`deploy/swap-image.sh`）。既存の経路が従来どおり | owner の確認（配備） |
| G-3′ | 受け入れ用の起動（`--rails arc-in,arc-out,solana-in`。公開の Router は止める）で O-1 静的・O-1 動的・O-2 動的を各 1 件。記録は設計 §7.3（両レグの tx、Arc の RPC で tx の `success` と転送の内容、Provider の応答の本文、client の結果、`status` の再読取、V-13） | owner の確認（公開の停止） |
| G-4′ | `arc.outbound: true` の PR と入れ替え。AC-11: 公開 MCP を HTTPS で呼び、一覧に 3 本（route 1・プロファイル 2）が出て、**各組 1 回の quote** の `subject`（network・asset・decimals）と `disclosures` が設定どおり（支払わない）。DEPLOY §2c に記録 | owner の確認 |

### U6-a — SVM の純粋関数（設計 §4.2・§4.5 の 5〜7・10〜11、FR-24・FR-34・FR-35）

- **範囲**: `src/adapters/outbound/x402-svm.ts` の純粋な部分（`checkSvmOffer`（同期の形の検査と、ATA を要する不等式の 2 段）、`expectedOf`、`checkSvmOutboundMessage`、`messageHashOf`、`assembleWire`、`recheckWire`（snapshot との一致＋受信の `checkSvmTransaction`）、`memoOf`（既定と実行時の検査））、
  `src/adapters/inbound/x402-svm.ts`（`buildSvmTransactionMessage` の `lastValidBlockHeight`）、`x402-svm-startup.ts`（`svmFetchJson` の export）
- **完了条件（unit。`tests/unit/svm-offer-check.test.ts`・`tests/unit/svm-outbound-message.test.ts`）**:
  - `checkSvmOffer`: §4.2 の各行の肯定・否定（`feePayer`・`payTo` の各不等式、運用者の集合、未知の `extra`（`recentBlockhash`・`assetTransferMethod`）、Memo の長さ・制御文字、`decimals`）
  - `checkSvmOutboundMessage`: 正しい message を通す（**source/destination の相対順が逆になる 2 組の鍵**）。各欄の変異（source・宛先・額・decimals・mint・fee payer・authority・units・microLamports・Memo・blockhash）、命令の追加・削除・入れ替え、discriminator・余剰の data・余剰の口座・header の数・読み残し → 落ちる。**builder を呼ばない**（builder を変異させても検査が落ちることで確認）
  - `recheckWire`: snapshot と違う message・署名の数・[0] が非ゼロ・[1] が壊れている・1,233 バイト → 落ちる。受信の `checkSvmTransaction` の policy の 6 欄で通る
  - Memo の既定: `subetha:<paymentId>`、257 バイト・制御文字 → `destination_memo_invalid`
- **sabotage**: header の 1 を 0 に／discriminator の検査を外す／読み残しの検査を外す／`checkSvmOutboundMessage` を builder の再構築で置き換える → 各試験が落ちる

### U6-b — SVM の鍵の道具・能力・fixture（設計 §6.4・§7.1、FR-25、SR-1・SR-2）

- **範囲**: `tools/svm-key.ts`（`svmSeedFromKey`）、`tools/real-svm-capability.ts`（同期、noble）、`tools/svm-payer.ts`（`svmSeedFromKey` を使う）、`tests/fixtures/svm-signer-fixture.ts`（乱数の seed で本当に署名、回数と bytes、壊れた署名のモード）、`tests/fixtures/solana-rpc.ts`（`getTokenAccountBalance`、複数の ATA）
- **完了条件（unit）**: `createRealSvmCapability`: `wallet:new:solana` の seed から kit と同じ address（`createKeyPairSignerFromPrivateKeyBytes` と比較）、署名が `ed25519.verify` を通る、**鍵の文字列を保持しない**（能力の object を列挙・JSON 化しても seed・鍵が出ない。SR-2）、`signCount`。`svm-payer.ts` の既存の試験が通る。
  依存の向き（`@x402/svm` を `src/`・`tools/` から import しない。SR-1）の既存の試験が通る。fixture-key の署名が `recheckWire` を通り、壊れたモードで落ちる
- **sabotage**: seed を閉包の外に置く → 保持の試験が落ちる

### U7 — SVM の adapter と Provider の fixture（設計 §4、FR-24・FR-32〜FR-37、AC-9・AC-10）

- **範囲**: `createX402SvmOutbound`（`startup`・`readChallenge`・`pay` の 14 段・`balanceOf`・`hooksForTest`）、`tests/fixtures/svm-upstream.ts`（402 の accepts、`PAYMENT-SIGNATURE` を fixture の facilitator に `/verify` → `/settle`、`PAYMENT-RESPONSE`、`state`: 固定 Memo・乱数 Memo・`recentBlockhash`・feePayer を Router に・payTo を運用者に・500・`dropAfterSettle`、`seen.paid`）、
  `tests/wire/x402-svm-outbound.test.ts`
- **完了条件（wire。Linux）**:
  - 成功: 静的・動的が `delivered`（署名 1 回・支払い要求 1 件・`seen.paid` の transaction が `recheckWire` を通り、領収の `transaction` が base58 64 バイト）。fixture の facilitator の `/verify` が **Router の transaction を受ける**（V-8a。本物の verify の論理）。SDK の client（`@x402/svm/exact/client`、試験だけ）が同じ offer から組む封筒と鍵の集合が一致
  - §4.5 の各段の失敗（AC-10 の列挙）: 期限（1・9・12）、候補外、`destination_offer_changed`、ATA 不在（quote で候補外、purchase で `not_sent`）、blockhash の RPC 失敗・形違い、`fetchToSignMs` 超過、Memo の衝突（並行 2 件）、`reserveMessage` 無し、署名の検証の失敗、wire の改変（`hooksForTest.wire`）、送出の例外 → `unknown`、`dropAfterSettle` → `unknown`、
    **領収なし**の 500 → `unknown`・4xx → `rejected`、**整合した領収つき**の非 200 → `paid_no_data`、`payer` 不一致 → `unknown`（SVM の form が共有の関数に繋がっていることの確認。表の主担当は U3）
  - AC-9 の (a)〜(d2)（設計 §7.2 の行）。観測は signer の回数・bytes と `seen.paid`
  - RPC: 方法は 3 つだけ（他を呼ばない）、回数の上限（設計 §4.3）、すべて guarded transport（loopback の fixture は hooks なしで 0 接続。SR-4）
  - `startup` の前の `pay`・`readChallenge`・**`balanceOf`** は throw。静的 route の宛先 ATA が無ければ `startup` が throw
  - **SR-3（SVM、1 回目）**: この PR のレビューで adapter の実ソース（U6-a・U6-b を含む）を見る
- **sabotage**: 設計 §4.6 の表（builder の変異で signer 0、署名前の検査を外す→ signer 1、**予約を署名の後に動かす** → 並行で signer 2、`reserveMessage` 無しで署名、(i) を外す → wire の改変が通る、10 を外す → 理由が `destination_payload_mismatch` に変わる）

### U8-a — 合成に SVM・統合（行列・予算・残高）（設計 §2.2・§2.3 (c)・§7.2、FR-27・FR-29、AC-8・AC-9・AC-12、D-14）

- **範囲**: `src/main.ts`（`svmSigning` の組、`startup` を `startupChecks` に、運用者の集合の (c) は adapter の `startup` で、SVM の key／`network` 不一致・不正な address の起動時の拒否）、`tests/wire/multirail-integration.test.ts`（公開する組: 静的 O-1・O-4、動的 O-1〜O-4 が `delivered`。能力は `evmSigningByNetwork[ARC]`・`svmSigning[SOL]`。残高の hook（静的・動的、不足・RPC 失敗。SVM の実配線）。既存の経路が変わらない）、
  **予算の動作（FR-29・D-14 の主担当）**: 受信と送信が同じ `(network, asset)` に合算される（Arc 受信 → Arc 送信の構成は範囲外なので、Arc USDC の区分を受信の購入と送信の購入が**順に**使って通算が合算されること）、静的と動的が別の台帳、区分の無い `(network, asset)` → `bucket_not_allowed`、D-14 の値で 1 件の上限が効く
- **完了条件（wire・integration。Linux）**: 上記すべて。`startup` 前の `pay` が統合でも throw
- **sabotage**: `startup` を `startupChecks` から外す → 統合の試験が落ちる／予算の区分の検査（`bucketFor`）を外す → `bucket_not_allowed` の試験が落ちる／合算を外す → 通算の試験が落ちる／SVM の key と `network` の照合を外す → 起動時の拒否の試験が落ちる

### U8-b — process の中断の試験（設計 §7.2、AC-10）

- **範囲**: `tests/fixtures/router-rails-process.ts`（SVM の能力と停止の hook を注入できる子 process）、`tests/wire/x402-svm-outbound.test.ts` に中断の試験（`afterReserve`／`afterSign`／`beforeSend` で SIGKILL → journal に予約の行・intent は `destination_pending` → 同じ journal で再起動 → `unknown`（`interrupted_at_restart`）、signer 0・支払い要求 0 → 別の paymentId で同じ message → `collision`）
- **完了条件（wire。Linux）**: 上記。中断の観測は「停止前の signer の回数」と「再起動後の回数」を分けて記録。`dropAfterSettle` の後の再起動で再送信 0
- **SR-3（SVM、2 回目）**: この PR のレビューで U6-a〜U8-b の実ソース全体を範囲に含める
- **sabotage**: `#resolveInterrupted` を外す → 再起動の試験が落ちる／replay の hash の復元を外す → 衝突の試験が落ちる

### U9 — 本番の入口（Solana）と文書（設計 §6.2〜§6.5、FR-30・FR-31、D-11・D-12・D-16）

- **範囲**: `tools/rails-entry.ts`（`SUBETHA_OUTBOUND_SOLANA_KEY` を `solana.outbound` のときだけ読み `svmSigning` を注入、Solana RPC を受信 ∨ 送信で依存先に）、`tools/remote-mcp.ts`（鍵と `SUBETHA_SOLANA_PROVIDER_PAYTO` の転送）、`tools/remote-mcp-config.ts`（`OUTBOUND_SOL`・`UPSTREAM_SOL`（空）、route `md-sol-eth-snapshot-mpp`（条件つき）、プロファイル `dyn-x402-to-sol`・`dyn-mpp-to-sol`、Solana USDC の区分の D-14 の値）、
  `tools/remote-router-process.ts`（起動の失敗の固定文）、`docs/DEPLOY.md` §2c（Solana 送信の段: 鍵の作成 `wallet:new:solana`、Router の ATA の作成と rent、残高の見方、env、V-8b の扱い）、`CLAUDE.md`・`README.md`（Solana の route／プロファイルの行。有効化の後に出ると明記）
- **完了条件（unit・process）**: `solana-out` で `svmSigning[SOL]` が注入され、無効なら env を読まない（`SUBETHA_OUTBOUND_SOLANA_KEY` を置いても触らない）、route／プロファイル／区分の生成の条件、受取先の形（base58 32 バイト）、静的 Solana route の宛先 ATA が無いと process が起動しない（fixture の RPC）、
  `RAILS_ACTIVATION` は **`solana.outbound: false`、`arc` は UG-A で承認された状態のまま**、公開する ID の集合は 6 本だけ（D-12・D-16）、起動の失敗の文に鍵・URL が出ない（SR-2）
- **sabotage**: 鍵を無効でも読む → 試験が落ちる／RPC の依存先の条件を受信だけに戻す → 送信だけの試験が落ちる

### UG-S — Solana の gate（要件 §6.3、AC-11・AC-14。owner の確認。§0 の直列化の規則）

| 段 | 内容 | 条件 |
|---|---|---|
| V-7・V-12・V-13 | Provider（Solana 用）の 402 を 2 回取り、`payTo`（owner）・`extra`（`feePayer`・`memo` の有無と安定性・`recentBlockhash` の有無）・宛先 ATA の存在を記録。設計と違えば設計を改訂してから続ける。G-3′ で `PAYMENT-RESPONSE`・HTTP の状態・応答時間を記録 | owner が Provider の URL と受取先を知らせる |
| G-1′ | `wallet:new:solana` で送信鍵を作る（ホストの env `SUBETHA_OUTBOUND_SOLANA_KEY`）。owner が ATA を作り（rent）、devnet USDC を入れる。`UPSTREAM_SOL`・`SUBETHA_SOLANA_PROVIDER_PAYTO` の PR（commit を固定） | owner（鍵の承認・資金） |
| V-8b | 実 facilitator（x402.org）の probe（資金が動く）: 使い捨ての ed25519 鍵（devnet USDC と ATA。owner が入れる）、Router の形の transaction（U7 の fixture の Provider を devnet と x402.org に向けて Router の外で起動）で `/verify` → `/settle` を 1 回。公開の Router は止めない（Router の外で行う）。成功の判定: `settle` の `success` と署名が devnet で confirmed、受取 ATA の増分。記録: 日時・署名・compute の消費（`getTransaction` の meta）・応答 | owner の承認 |
| G-2′ | `solana.outbound: false` のまま配備 | owner の確認（配備） |
| G-3′ | 受け入れ用の起動（`--rails arc-in,arc-out,solana-in,solana-out`。公開の Router は止める）で O-4 静的・O-3 動的・O-4 動的を各 1 件。記録は設計 §7.3（署名の finalized、Provider の ATA の増分、Provider の応答、client の結果、再読取、V-13）。U-8（取得〜署名の実測） | owner の確認（公開の停止） |
| G-4′ | `solana.outbound: true` の PR と入れ替え。AC-11: 一覧に 3 本が出て、各組 1 回の quote の `subject`・`disclosures` が設定どおり。DEPLOY §2c に記録 | owner の確認 |

### U10 — O-5・O-6 を動的プロファイルで（要件 §11、設計 §13。2026-10-09、D-17 の決定の後）

- **範囲**: `tools/remote-mcp-config.ts`（`pairs` の型と定数（両方 `false`）、`dyn-arc-to-sol`・`dyn-sol-to-arc` の生成と固定文）、`tools/rails-entry.ts`（token `arc-to-sol`・`sol-to-arc` の往復）、`tools/rails-acceptance-run.ts`（usage）、設計 §13.3 の試験 4 本、`docs/DEPLOY.md` §2c の段（G-2⁗〜G-4⁗）
- **完了条件**: 要件 AC-19 のすべて（20 本の全列挙、18 本のまま、固定文 4 通り、guard row 20 本、token 8 語、行列 O-5・O-6 delivered、process の受け入れの起動で 2 本）。`src/` に差分が無い。公開の定数は `pairs` 両方 `false`（一覧は 18 のまま）
- **sabotage**: 生成の条件から `solOutbound`（または `arcOutbound`）を外す → 固定文の試験が落ちる／token を 1 語だけ足す → 往復の試験が落ちる／行列の O-5 の送信先を Arc に変える → Provider の支払いの期待が落ちる

### UG-P — O-5・O-6 の gate（要件 §11.4。owner の確認。§0 の直列化の規則）

| 段 | 内容 | 条件 |
|---|---|---|
| G-2⁗ | U10 を含むイメージを `pairs` 両方 `false` のまま入れ替え（`deploy/swap-image.sh`）。公開の一覧は route 10・プロファイル 18 のまま | owner の確認（配備） |
| G-3⁗ | 受け入れ用の起動（`--rails arc-in,arc-out,solana-in,solana-out,arc-to-sol,sol-to-arc`。公開の Router は止める）で O-5・O-6 を各 1 件 `delivered`。記録は AC-13／AC-14 と同じ（payer は使い捨て: Arc `0xfCea…`、Solana `HTaz…`） | owner の確認（公開の停止・支払い） |
| G-4⁗ | `pairs` 両方 `true` の PR と入れ替え。**同じ PR で、`RAILS_ACTIVATION` を直接読む試験の期待を 20 本・8 語に変え、`pairs` を `false` にした固定の構成で 18 本を見る試験を残す**（`remote-mcp-config.test.ts`・`rails-entry.test.ts`）。一覧 20 本、各 1 回の quote、hosted で各 1 件の実購入（§2e と同じ証拠）。CLAUDE.md・README・公開ブリーフ（20/20） | owner の確認 |

## 3. 要件・設計との対応（主担当と補助）

| 対象 | 主担当 | 補助（別の層の試験） |
|---|---|---|
| 設計 §1、FR-26・FR-28 | U1 | U5・U9（生成） |
| 設計 §2.4〜§2.6、FR-36・FR-37、D-15 | U2 | U3・U7（adapter）、U8-a（統合）、U8-b（中断） |
| 設計 §2.3・§5、FR-32・FR-38 | U3 | U4・U8-a（集合の構築）、U7（SVM の接続） |
| 設計 §2.1〜§2.2・§3、FR-22・FR-23・FR-27・FR-33 | U4 | U8-a（SVM の組、Arc の統合） |
| 設計 §4・§6.4、FR-24・FR-25・FR-34・FR-35 | U6-a（純粋関数）・U6-b（鍵）・U7（adapter） | U8-a・U8-b |
| 設計 §6、FR-30・FR-31、D-11〜D-13・D-16 | U5（Arc）・U9（Solana） | UG-A・UG-S（公開の確認） |
| FR-29、D-14 | U8-a（動作） | U5・U9（生成の値） |
| SR-1・SR-2・SR-4 | U6-b（依存の向き・鍵の保持）、U9（固定文）、U7・U8-a（guarded の接続） | §0 の規則 |
| SR-3 | U4（Arc）、U7・U8-b（SVM） | — |
| SR-5、D-10、AC-11・AC-13・AC-14 | UG-A（Arc）・UG-S（Solana） | — |
| D-12・D-16・D-17 | U5・U9（公開 ID が 6 本だけ） | 将来の追加は別の gate |
| D-17（決定 2026-10-09）、FR-39〜FR-43、AC-19 | U10 | UG-P（AC-20・AC-21） |
| AC-8 | U4 | U8-a（Arc の統合）、UG-A G-3′ |
| AC-9・AC-10 | U7 | U8-a・U8-b |
| AC-12 | 各タスクの sabotage（U2・U3・U4・U6-a・U6-b・U7・U8-a・U8-b） | 能力の束縛 U4・U8-a、表 U1、予算 U8-a、領収 U3、運用者の集合 U3・U4・U7 |

## 4. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-07 | `gpt-6-astra`（read-only。第 1 版 `87ef717`） | **APPROVE WITH CHANGES**（高 3: UG-A と U9 の有効化の矛盾と gate の直列化、予算の検証の未割当、結果の表の完了条件；中 4: U2 の sabotage の観測、残高の配線の責任、§0 の「3 つだけ」、gate の外部接続と記録；中 1: §3 の主担当の表；低 1: 試験ファイルの対応。U6・U8 の分割を推奨）。第 2 版で反映 |

## 5. 本書で決めていないこと

- Provider の URL・受取先（D-10。owner）。`extra.assetTransferMethod` の扱い（V-6 の結果。UG-A）
- 取得〜署名の上限の値（設計 U-8。G-3′ の実測）
- ~~O-5・O-6（Arc ↔ Solana）を足すか（D-17。別の gate）~~ → 2026-10-09 に決定（U10・UG-P）
