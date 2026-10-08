# タスク分解: Solana の MPP を受信・送信の両方で（S-5・S-6）

> 2026-10-08、第 2 版。入力は `docs/mpp-solana-requirements.md`（要件 第 6 版、D-18〜D-30 は owner 採用）と `docs/mpp-solana-design.md`（設計 第 3 版、owner 承認「どちらも勧めて良いです」2026-10-08、PR #96）。
> 以下「設計 §x」「要件 FR-x」はそれらを指す。本書はタスクフェーズの成果物で、コード・実行結果・合格の主張は含まない。記載のコマンドは**計画であり未実行**。
> 先行の `docs/multirail-outbound-tasks.md` と同じ形（§0 の規則、1 タスク 1 PR、変異の表、独立レビュー）。
> 第 1 版は独立レビューで REJECT（8 項目。§4）。第 2 版で反映: §3 を 1 項目 1 主担当に、M4-a の依存に M3-a、M3-a の fixture の完了条件（pay-kit の server の verify が fixture の RPC で通る）、M4-b の FR-53 の表と FR-54、M5 の中断の期待値、sabotage の観測点、MG の資金と接続の範囲（両レグ）と再配備の規則、§0 の変更の一覧。

## 0. 全タスク共通

- **担当**: 親（controller）が状態・commit を持ち、実装後に実ソースを読み戻してテストを実際に実行する。レビューは `gpt-6-astra`・read-only で差分を見る。writer は 1 つ
- **順序**: まず落ちるテストを書き、赤を確かめてから実装する。完了条件の試験は**守っているコードを外して落ちること**（sabotage）を確かめ、結果を PR に書く。**変異の前に commit する**（復元は commit から）
- **完了コマンド**: focused → `npm run types` → `npm test`。skip と失敗を区別して報告する。「Linux」と書いた完了条件は Linux（`node:22-bookworm`）で実行した結果を要する（`multirail-compose` の停止 DNS の 1 件は単独で再実行してから判断する）
- **資金**: 資金が動くのは **MG の G-3″ だけ**。動くのは**両レグ**の testnet の資産: 受信 S-5 の行は payer の devnet USDC（手数料は devnet SOL）と Router の送信レグ（Base Sepolia USDC／Tempo pathUSD／Arc testnet USDC／devnet USDC のいずれか）、送信 S-6 の行は payer の Base Sepolia USDC か Tempo pathUSD（か Arc・devnet USDC）と Router の devnet USDC（pull なので Router の SOL は動かない）。owner の決定（2026-10-08）: **testnet の資産が動く段は owner に確認せずに進めてよい**。それ以外のタスクは本物の Provider・RPC に接続しない（loopback の fixture だけ。fixture の RPC の `sendTransaction` は模擬で、資金は動かない）。**mainnet の資産は一切使わない**
- **外部への接続は MG の中だけ**（各 1〜数回。日時・回数を記録）: Provider D の 402 と有料要求、Solana devnet の RPC（受信の `sendTransaction`／`getSignatureStatuses`／`getTransaction`、送信の 4 方法）、**もう一方のレグの既存の接続**（Provider A／B／Arc／Solana の Worker、x402.org と Circle の facilitator、Tempo の RPC。受け入れ用の起動が今までどおり使う）、運用者の確認の読取（署名の finalized・ATA の増分・EVM の tx）、公開 MCP の一覧と quote（AC-18。支払わない）。**owner の作業（G-1″）**: Provider D の配備（D-26）、payer の試験用鍵への devnet SOL と USDC、Provider D の fee payer に SOL。Router の送信鍵の USDC は既存。**親の作業（G-2″〜G-4″）**: 定数と env の名前の設定の commit、イメージの入れ替え、購入、記録
- **既定で無効**: `RAILS_ACTIVATION.solanaMpp` は M6 が `{ inbound: false, outbound: false }` で固定し、MG の G-4″ で方向別に `true`。`UPSTREAM_SOL_MPP` は Provider D が立つまで空
- **gate と開発の直列化**: MG が検証するのは固定した commit・設定・イメージ。MG の間に `tools/remote-mcp-config.ts`・`tools/rails-entry.ts`・`docs/DEPLOY.md`・`CLAUDE.md` を変える PR は gate の各段の合間に直列に取り込み、**取り込んだ後は G-2″ の配備からやり直す**（G-3″ の購入は固定した commit に対して 1 度。G-4″ の前に繰り返すのは: 受け入れ用の起動の `startup`（受取 owner の ATA・Router の ATA・静的 route の宛先 ATA）と、有効化した方向の各組 1 回の quote）
- **既存の挙動で意図して変えるもの**（各タスクに明記）: (a) **core**: `source_settled` の journal 追記の失敗を捕まえて `unknown` を返す（静的・動的。全レールに効く。設計 §2.3。M2）、(b) **x402 SVM の builder の引数**（`memo?`・`computeBudget?`。既定は今の bytes。M2）、(c) **追跡の helper の括り出し**（x402 受信の挙動は同じ。M2）、(d) **本番の入口**: `RailsActivation` に `solanaMpp` と token 2 つ（旧 token はそのまま有効。`railActive` の判定に加わる）、`SUBETHA_SOLANA_RECEIVER`・`SUBETHA_OUTBOUND_SOLANA_KEY`・`SUBETHA_MPP_INBOUND_SECRET`・Solana RPC の読む／渡す条件に `solanaMpp` を足す、Solana USDC の予算の区分を出す条件に `solanaMpp` を足す（M6）、(e) **依存**: `@solana/pay-kit`（dev）と `overrides` の `mppx`（M3-a）、(f) **x402 SVM 送信の helper の括り出し**（`svm-outbound-common.ts`。挙動は同じ。M2）、(g) **道具と文書**: `classifyOffer` に `mpp-svm` の分岐（既存の分岐は同じ）、`wallet:new:solana` の案内、CLAUDE.md の MPP Solana の節（既存の節は同じ。M6）。他の既存の wire 試験は bytes も結果も変えない
- **鍵**: `src/` は env を読まない。試験の鍵は毎回の乱数。実鍵は `tools/` と ignored の env ファイルだけ（payer は既存の `SOLANA_PAYER_PRIVATE_KEY`）。**鍵・RPC の URL・ローカルの絶対パスを docs・PR に書かない**。起動の失敗の文は固定
- **SR-M の署名の境界の独立レビュー**（AC-21）: **M4-b の PR（1 回目。送信 adapter の実ソース。M4-a を含む）と M5 の PR（2 回目。M2〜M5 の実ソース全体）**。「差分」ではなく実ソースを見る指示を出す
- **SR-M6**: `@solana/pay-kit` を `src/`・`tools/` から import しない試験（`@x402/svm` の既存の試験と同じ形）を M3-a で足す

## 1. 依存

```
M1   表・設定・手数料の例外                                   ← main
M2   共有の primitives・追跡 helper・store の集合・core の callback と try/catch ← M1
M3-a 受信の純粋関数・pay-kit の client fixture・RPC fixture の拡張 ← M2
M3-b 受信 adapter と合成（受信）                               ← M3-a
M4-a 送信の純粋関数（challenge の検査・view・offer）           ← M2, M3-a（`mppSolanaChargeMethod` の schema）
M4-b 送信 adapter・Provider D の fixture・合成（送信）          ← M4-a, M3-a（RPC fixture）
M5   統合（行列 12 本・予算・中断・process の入口の試験）        ← M3-b, M4-b
M6   本番の入口・`npm run sign`・文書                           ← M5
MG   gate G-1″〜G-4″（AC-17・AC-18）                          ← M6、Provider D（owner、D-26）
```

M2 の後は M3-a と M4-a が並行できる（writer は 1 つなので順に: M3 → M4）。

## 2. タスク

### M1 — 表・設定・手数料の例外（設計 §1、FR-41・FR-42・FR-44）

- **範囲**: `KNOWN_NETWORKS` の Solana に `mpp`（受信・送信）、`parseDynamicProfile` の `mpp ∧ svm` の分岐（`decimals` 必須、`tokenProgram` 任意、`tokenDomain`・`feeAsset`・`maxFee`・`feeMargin` は **`ConfigError`**、`scheme === "solana/charge"`）、`pricingPolicy` は `mpp ∧ evm` だけ、`validateRouterConfigAgainstTable` の `tokenProgram`、`src/core/dynamic.ts` の quote（`estimateFor` を呼ばない）と purchase（`capCoversFee` は残し、再見積りだけ飛ばす）、`src/core/store.ts` の `capCoversFee`（`solana:` 宛は cap を要求しない）、`src/main.ts` の `dynamic.verify`（`eip155:` 宛に絞った record を `assertDynamicMppCapability` にも）
- **成果物**: 上の変更、`tests/unit/dynamic-fee-exception.test.ts`（新）、既存の config の試験への追加
- **完了条件（unit）**: 設定の 3 欄で `ConfigError`、`scheme` 違いで `ConfigError`、quote の `pricing` に `maxFee`・`estimate` が無く `estimateFee` が呼ばれない（spy）、purchase で `capCoversFee` が走り再見積りが走らない、復元で `dynamicInvalid` にならない、Tempo の記録は今までどおり落ちる、`dynamic.verify` が Solana 宛のプロファイルで `chainIdOf` に入らない（Tempo と Solana の混在で起動する）
- **sabotage**: 3 欄の禁止を外す → 試験が落ちる／store の例外を外す → 復元の試験が落ちる／`verify` の絞り込みを外す → 混在の起動の試験が落ちる

### M2 — 共有の primitives・追跡 helper・store の集合・core（設計 §2.3・§5、FR-47 の settle・SR-M1・SR-M2）

- **範囲**: `buildSvmTransactionMessage` の `memo?`・`computeBudget?`、送信の `SvmExpected.memo?` と `expectedOf`・`expectedStaticAccountsOf`・`compileSvmMessage`・`checkSvmOutboundMessage`・`assembleSvmWire`・`recheckSvmWire` の Memo 任意、`decodeBase64Strict`・`embeddedChallengeIdOf` の export、`svm-outbound-common.ts`（`startup`・`balanceOf`・ATA・RPC の helper の移動）、`svm-follow-up.ts`（`followSvmSignature`: `errTerminalAt`・`searchTransactionHistory`・`maxPolls`）、`IntentStore.settledSourceTxRefs`、`RouterCoreOptions.onStoreLoaded`、`source_settled` の append の try/catch（静的 `orchestrator.ts:739`・動的 `dynamic.ts:615`）
- **成果物**: 上の変更、`tests/unit/svm-outbound-message.test.ts`（追加）、`tests/wire/svm-settle-followup.test.ts`（helper 経由で同じ結果 + `maxPolls`・`errTerminalAt: "confirmed"` の行）、store の unit（集合の復元と append）、`tests/wire/crash-recovery.test.ts`（append の失敗 → `unknown` の応答、再起動で行の有無により `unknown`／`paid_undelivered`）
- **完了条件（unit・wire。Linux）**: 既存の x402 SVM の wire 試験が**bytes も結果も**変わらない（受信・送信・追跡）、Memo 無しの 3 命令と `price-first` の往復、`maxPolls` 15 で止まる、`processed` + `err` は続行し `confirmed` + `err` で `failed`、集合が replay と append で一致、append の失敗で `unknown` を返し送信を始めない
- **sabotage**: `maxPolls` を外す → 回数の試験が落ちる／`errTerminalAt` を無視 → `processed` + `err` の試験が落ちる／try/catch を外す → 応答の試験が例外で落ちる／集合の append での更新を外す → **reload の前に** `settledSourceTxRefs` を読む試験が落ちる（復元だけでは見えない）

### M3-a — 受信の純粋関数と fixture（設計 §3.2〜§3.4・§8.1、FR-46・FR-47、SR-M6、U-10）

- **範囲**: `src/adapters/inbound/mpp-solana.ts` の純粋な部分（`mppSolanaChargeMethod`、`checkMppSolanaTransaction`、`preflightMppSolana`、`mppSolanaSettleStatusOf`、`MPP_SOLANA_ISSUED_EXTRA_KEYS`）、`package.json`（`@solana/pay-kit` dev、`overrides`）、`tests/fixtures/mpp-solana-payer.ts`（本物の pay-kit の client。`broadcast` の有無）、`tests/fixtures/solana-rpc.ts` の拡張（`sendTransaction`・`simulateTransaction`・`getTransaction` の base64／`jsonParsed`、`state.sendReply`・`state.transactions`）、依存の向きの試験
- **成果物**: 上の変更、`tests/unit/mpp-solana-check.test.ts`、`tests/unit/mpp-solana-fixtures.test.ts`（fixture の自己試験: pay-kit の client が fixture の RPC で両型の credential を作れる、`npm ls mppx` の二重解決）
- **完了条件（unit。Linux）**: §3.3 の 7 行の肯定・否定（compute の 0〜2 命令と 2 順序、Memo 無し／違い／`externalId` 以外、署名 2 つ、lookup table、version 1、ATA 作成、source の owner 違い、自己支払い、1232 超）、preflight の 5 点と型の形、**U-10**: 0.11.0 の `Challenge.serialize` → pay-kit の client が読める、pay-kit の client の credential → 0.11.0 の `Credential.deserialize` と `Challenge.verify`（HMAC）が通る（**最初に確かめ、違えば止めて owner に D-25 を諮る**）、**fixture の RPC の準備**: pay-kit の **server**（`createPayKit`、library として unit で呼ぶ。Provider D の fixture は M4-b）の `verify` が `transaction` 型と `signature` 型で fixture の RPC に対して通って receipt を返す（= `simulateTransaction` の `result.value.err`、`sendTransaction`、`getSignatureStatuses`、`getTransaction` の `jsonParsed` の全命令の `programId`・`transferChecked` の `info`・memo の `parsed` が pay-kit の読み方を満たす）、`src/`・`tools/` が pay-kit を import しない
- **sabotage**: 組み直しの比較を外す → 余分な口座の試験が落ちる／ed25519 を外す → 署名改変の試験が落ちる／Memo の明示の比較を外す → 理由が `nonce_mismatch` から `credential_mismatch` に**変わって**落ちる（組み直しの比較が拾うので「落ちる」だけでは観測できない。理由を assert する）

### M3-b — 受信 adapter と合成（受信）（設計 §2.2〜§2.3・§3.5〜§3.6、FR-45・FR-48、SR-M1・SR-M2、AC-15 の受信分）

- **範囲**: `createMppSolanaInbound`（`startup`・`createOffer`・`preflight`・`verify`・`settle`。`validateCredential` の明示の呼び出し、`transaction` 型の送出と追跡、`consumed` の holder）、`src/main.ts` の受信の family の分岐・`svmUsageOf`・`mppInboundChains`・holder と `bindConsumed`・`startupChecks` への登録、`startRouter` の `onStoreLoaded`
- **成果物**: 上の変更、`tests/wire/mpp-solana-inbound.test.ts`
- **完了条件（wire。Linux）**: pay-kit の client の両型で `source_settled` → 既存の送信で `delivered`（静的・動的）、§3.6 の各行（静的と動的の写像の違い）、HMAC 改竄で `verify_failed`、`broadcast` hook が呼ばれない、`sendTransaction` 1 回・**要求の option の `maxRetries: 0`・`skipPreflight: false`・`preflightCommitment: "confirmed"` を fixture が記録して assert**、error 後の 1 回の `searchTransactionHistory`、追跡 ≤ 15 回・経過時間 30 秒・全体 50 秒（clock の差し替え）、`confirmed` + `err` → `source_rejected`、AlreadyProcessed → `settled`、応答なし → `unknown`、replay（並行 2 件、再起動後。bind の前に `has` → throw。**消費済みの検査は settle を直接呼ぶ unit**: 消費済みの署名で `rejected`。端から端では preflight／Memo／終端の読み返しが先に拒むので、そこでは観測しない）、`signature` 型の `blockTime` の窓、Tempo 受信の wire 試験が変わらない、x402 SVM 受信との USDC の区分の通算
- **sabotage**: `validateCredential` を外す → 改竄の試験が落ちる／error 後の status 検査を飛ばす → AlreadyProcessed の試験が落ちる／`consumed.has` を外す → settle を直接呼ぶ unit が落ちる／`maxRetries` を 1 に → option を assert する試験が落ちる（fixture の HTTP の回数は変わらない）

### M4-a — 送信の純粋関数（設計 §4.2、FR-50・SR-M4）

- **範囲**: `checkMppSolanaChallenge`（9 行）、`viewOf`／`offerOf`（`terms` は id・expires を含まない）、`mppSolanaChargeMethod` の client 側（`Method.toClient` の形。credential は hook が返す）
- **成果物**: `src/adapters/outbound/mpp-solana.ts` の純粋な部分、`tests/unit/mpp-solana-challenge-check.test.ts`
- **完了条件（unit）**: 9 行の肯定・否定（`feePayer` 無し／`false` → `destination_unsupported_mode`、`feePayerKey` の除外集合、`externalId` の 256 バイト、未知の欄、`recentBlockhash` の形）、同じ request で id・expires が違う 2 つの challenge の `terms` と `offerOf` が一致
- **sabotage**: `feePayerKey ∉ 運用者` を外す → 試験が落ちる／`terms` に `id` を入れる → 一致の試験が落ちる

### M4-b — 送信 adapter・Provider D の fixture・合成（送信）（設計 §4.3〜§4.6・§8.1、FR-51〜FR-54、SR-M3・SR-M4、AC-16）

- **範囲**: `createMppSolanaOutbound`（`startup`・`balanceOf`・`readChallenge`・`pay` の 14 段・領収の `getTransaction` 照合・`hooksForTest`）、`src/main.ts` の送信の family の分岐と `svmStartups`、`tests/fixtures/mpp-solana-upstream.ts`（本物の pay-kit の server。`--external-id`・`--fee-payer`・`--pay`・`--after-headers`・`/calls`・`seen`）
- **成果物**: 上の変更、`tests/wire/mpp-solana-outbound.test.ts`
- **完了条件（wire。Linux）**: 静的・動的が `delivered`（署名 1 回・有料要求 1 件・fixture の server の本物の検証を通る・領収の `reference` が `getTransaction` で予約した message と一致）、`externalId` あり／なしで Memo の有無が合う、`feePayer: false` → 候補外、§4.3 の各段の `not_sent`（期限、候補外、`destination_offer_changed`、ATA 不在、blockhash、`fetchToSignMs`、送出直前の `sendWithinMs`、予約の衝突、署名の検証、wire の改変、hook の出力の改変 = 別の bytes・別の challenge id）、複数の challenge を返す server で SDK の選択の照合、**FR-53 の表の全行**: 送出の例外・期限 → `unknown` `destination_pay_unknown`、領収なしの 200 → `unknown` `destination_receipt_unverified`、領収なしの 4xx／5xx → `unknown` `destination_pay_unknown`、領収の不整合（`challengeId` 無し／違い、`reference` の形違い・別の署名、`method` 違い、`payer` 相当の欄の不一致、`getTransaction` の `null`／message 不一致／`err`／`slot` 無し）→ `unknown` `destination_receipt_unverified`、整合した領収の非 200 → `paid_no_data`、整合した領収の 200 で本文が JSON でない／256 KiB 超／途中で切れる → `paid_no_data`、整合した領収の 200 の JSON → `paid`。**FR-54**: purchase ごとに `getTokenAccountBalance` 1 回が受信の verify の**前**（fixture の呼び出し順）、不足 → `operator_funds_unavailable`、RPC の失敗 → 同じ。`slow`（fixture の RPC の `getSignatureStatuses` の列で確定を 30 秒遅らせる = pay-kit の server の確定待ち。HTTP を遅らせるのではない）→ `paid`、45 秒超 → `unknown`、RPC は 4 方法だけ、`startup` 前の呼び出しは throw、`estimateFee` を持たない
  **SR-M（1 回目）**: この PR のレビューで adapter の実ソース（M4-a を含む）を見る
- **sabotage**: 設計 §4.6 の (a)〜(d) + 予約を署名の後に動かす → 並行で signer 2／返った credential の再検査を外す → hook の改変の試験が落ちる／`challengeId` を任意に → 領収の試験が落ちる

### M5 — 統合（設計 §8.2 の integration・中断・process、FR-43、AC-15〜AC-16 の行列・AC-20・AC-21）

- **範囲**: `tests/wire/multirail-integration.test.ts`（行列 §7 の 12 本: 静的 4・動的 8。同じ USDC の区分を両レグで使う I-4・O-10 の 1 件の上限と通算）、中断（受信 `transaction` 型の送出の前・後・行の後、`signature` 型の行の前後、送信の予約・署名・送出の前。子 process + SIGKILL）、`tests/wire/rails-process-entry.test.ts`（M6 の前は fixture の起動側で能力の注入と `startup` の順序）
- **完了条件（wire・integration。Linux）**: 行列 12 本が `delivered`、I-4・O-10 で 1 件の上限と通算が両レグ分で効く。**中断の期待値**（各停止点で SIGKILL → 同じ journal で再起動）: 受信 `transaction` 型の送出前 → `unknown`（`interrupted_at_restart`。送出 0）、送出後・行の前 → `unknown`（送出 1。chain 上の署名はそのまま）、行の後 → `paid_undelivered`（送信は始まらない。signer 0・支払い要求 0）、受信 `signature` 型の行の前 → `unknown`、行の後 → `paid_undelivered`、送信の予約の後 → `unknown`（signer 0・要求 0。同じ message を別の paymentId で → `collision`）、署名の後 → `unknown`（signer 1・要求 0）、送出の前 → `unknown`（要求 0）。**同じ intent の再提示**は再起動の後も現在の終端を返す（新しい購入を始めない）。既存の 4 レールの wire 試験が変わらない。**SR-M（2 回目）**: M2〜M5 の実ソース全体
- **sabotage**: `startup` の登録を外す → 統合が落ちる／区分の合算を外す → 通算の試験が落ちる／`onStoreLoaded` の bind を外す → 再起動後の replay の試験が落ちる

### M6 — 本番の入口・`npm run sign`・文書（設計 §6・§7、FR-40・FR-42・FR-49・FR-55・FR-56、AC-19）

- **範囲**: `RailsActivation.solanaMpp`・token `solana-mpp-in`／`solana-mpp-out`・`railActive`、`solanaMppReceiverOf`、route 4 本・プロファイル 8 本・区分・`x402.upstreams`、env の条件（秘密・受取 owner・鍵・RPC・`SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`）、`UPSTREAM_SOL_MPP`（空）、`classifyOffer` の `mpp-svm`、`tools/svm-mpp-payer.ts`、`sign-run.ts` の stderr、`wallet-new-solana.ts` の案内、`docs/DEPLOY.md` §2d、CLAUDE.md（表・MPP Solana の節・「送信済み」の置き換え）、README
- **成果物**: 上の変更、`tests/unit/remote-mcp-config.test.ts`・`rails-entry.test.ts`（有効化の組み合わせの表）、`tests/wire/rails-process-entry.test.ts`（token・env・静的 route の起動時の検査）、`tests/wire/mpp-solana-cli.test.ts`（道具 → Router の受信 → `settled`。RPC は `getLatestBlockhash` 1 回・`sendTransaction` 0 回、拒否の各行、鍵を出さない）
- **完了条件（unit・wire。Linux）**: 上記。`RAILS_ACTIVATION.solanaMpp` は両方 `false`。有効化の各組で出る route／プロファイルと子の env が表どおり（`solana.outbound` も `solanaMpp.outbound` も無効なら鍵を渡さない、片方だけなら渡す）。受取 owner があるだけで x402 の route が出ない
- **sabotage**: `sendTransaction` を道具に足す → 回数の試験が落ちる／`solanaMppReceiverOf` を `receiverOf` に戻す → x402 の route が出て試験が落ちる／鍵の転送の条件を `solana.outbound` だけに → 試験が落ちる

### MG — gate（要件 §8、AC-17・AC-18。owner の作業と並行）

- **G-1″**（owner の提供 → 親の設定）: owner が Provider D を devnet に配備（pay-kit の server、`feePayer: true`。Node か Workers は owner）し URL と受取 owner を伝える、payer の試験用鍵に devnet SOL と USDC、Provider D の fee payer に SOL、ホストの env に `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`。親は `UPSTREAM_SOL_MPP` の定数を PR で入れる（これも §0 の直列化の対象）。Router の送信鍵の USDC は既存（pull なので SOL は要らない）
- **G-2″**（親）: `solanaMpp` 無効のまま配備（イメージの入れ替えの手順は `docs/DEPLOY.md` §2c のとおり）
- **G-3″**（親。資金が動く = 両レグの testnet の資産。owner の確認は不要 = 2026-10-08 の決定）: 公開を止めて受け入れ用の起動で、受信 S-5 は I-1 の静的と動的・I-3 か I-4 の動的を各 1 件、送信 S-6 は O-7 の静的と動的・O-9 か O-10 の動的を各 1 件。証拠は要件 AC-17（両レグの tx・finalized・ATA の増分・Provider の本文・client の結果・`status` の再読取・再起動後も同じ）。**D-30 の 45 秒の実測**（U-13）。固定した commit・イメージに対して 1 度。途中で入口・文書の PR を取り込んだら G-2″ からやり直す
- **G-4″**（親）: 方向別に `true` の PR → 配備（`startup` の検査が通ること）→ AC-18（公開 MCP の一覧と各組 1 回の quote。支払わない）。CLAUDE.md の表と一致。G-3″ の後に入口を変える PR が入っていれば、G-4″ の前に受け入れ用の起動の `startup` と有効化した組の quote を繰り返す（購入は繰り返さない）
- **記録**: `docs/DEPLOY.md` §2d。鍵・URL は書かない

## 3. 要件・設計との対応（**1 項目 1 主担当**。補助は別の層の試験）

| 対象 | 主担当 | 補助 |
|---|---|---|
| 設計 §1、FR-41・FR-44 | M1 | M6（生成の値） |
| 設計 §2.1（能力。新しい型は無い）・§2.2 の送信側の合成 | M4-b | M5 |
| 設計 §2.2 の受信側の合成（接続） | M3-b | M5（再起動） |
| 設計 §2.3（集合・callback・try/catch）・§5（primitives・helper・括り出し） | M2 | M3-a・M4-a（利用）、M3-b（接続） |
| 設計 §3.2〜§3.4、FR-46 | M3-a | M3-b |
| 設計 §3.5〜§3.6、FR-45・FR-47・FR-48、D-18・D-20・D-21・D-22・D-28 | M3-b | M5 |
| 設計 §4.2、FR-50、SR-M4 | M4-a | M4-b |
| 設計 §4.3〜§4.6、FR-51〜FR-54、SR-M3、D-19・D-23・D-24・D-30 | M4-b | M5 |
| 設計 §2.2 の両方向の整合・§8.2 の integration と中断、FR-39・FR-43、AC-20 | M5 | M3-b・M4-b（各方向） |
| 設計 §6・§7・§6.4、FR-40・FR-42・FR-49・FR-55・FR-56、D-27・D-29、AC-19 | M6 | MG（公開の確認） |
| 設計 §8.1 の RPC・client の fixture、§9（依存）、SR-M6、D-25（U-10 の判定） | M3-a | — |
| 設計 §8.1 の Provider D の fixture | M4-b | — |
| 設計 §8.3 の記録、要件 §8、AC-17・AC-18、D-26、U-13 | MG | — |
| SR-M1（受信の RPC の上限: method・回数・追跡の 30 秒／15 回） | M3-b | M2（helper の `maxPolls`） |
| SR-M1（送信の RPC の上限: 4 方法・回数） | M4-b | — |
| SR-M1（道具: `getLatestBlockhash` 1 回・送出 0） | M6 | — |
| SR-M2（送信の予約・受信の消費済み集合の永続化） | M2 | M3-b（settle の unit）、M5（再起動） |
| SR-M5（固定の失敗の文） | M6（起動の文） | M3-b・M4-b（adapter の理由の列挙） |
| AC-15（受信の fixture の試験） | M3-b | M5（行列） |
| AC-16（送信の fixture の試験。有効化の組み合わせは M6） | M4-b | M1（手数料の例外）、M6 |
| AC-21（変異の表と 2 回の独立レビュー） | M5（2 回目のレビューの置き場） | M4-b（1 回目）、各タスクの変異の表 |

## 4. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版 `e87b9ce`） | **REJECT**（8 項目: §3 の主担当の一意性、M4-a の依存、fixture の準備の完了条件、FR-53／FR-54／中断の期待値、sabotage の観測点、G-3″ の資金と接続は両レグ、再配備の規則、§0 の変更の一覧）。第 2 版で反映 |

## 5. 本書で決めていないこと

- Provider D の置き場（Node か Workers。owner。D-26・U-14）と URL・受取 owner
- push（第 2 段。D-23）の credential の型と手数料の勘定（要件 FR-44 の push）。本書の範囲外
- D-25（mppx を 0.13.x に上げるか）は U-10 の結果で。M3-a の最初の試験で互換が無ければ止めて owner に
