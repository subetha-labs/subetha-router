# タスク分解: Arc と Solana で払う（S-1・S-2）

> 2026-10-06、第 1 版。入力は `docs/multirail-requirements.md`（要件 v3、owner の決定 §0、確認の結果 §2.5）と `docs/multirail-design.md`（設計 第 3 版、owner 承認
> 「現在の設計で良いです」2026-10-06）。以下「設計 §x」「要件 FR-x」はそれらを指す。本書はタスクフェーズの成果物で、コード・実行結果・合格の主張は含まない。
> 記載のコマンドは**計画であり未実行**。

## 0. 全タスク共通

- **担当**: 親（controller）が状態・commit を持ち、実装後に実ソースを読み戻してテストを実際に実行する。レビューは `gpt-6-astra`・read-only で差分を見る
- **順序**: まず落ちるテストを書き、赤を確かめてから実装する。完了条件の試験は**守っているコードを外して落ちること**（sabotage）を確かめ、結果を PR に書く
- **完了コマンド**: focused（当該テスト）→ `npm run types` → `npm test`。skip と失敗を区別して報告する。「Linux」と書いた完了条件は Linux（Colima の `node:22-bookworm`）で実行した結果を要する
- **無課金**: M3 までのどのタスクも、署名済みの送金・有料 API を使わない。外部への接続があるのは T0（npm の取得・公開の `/supported`）と T6（testnet の `/verify` のみ。settle しない。
  faucet の testnet 資産だけ）。実決済は T10 の gate。**mainnet の資産は一切使わない**（SR-6）
- **既定で無効**: T9 まで、Arc・Solana の route／プロファイルは**本番の入口の設定に出さない**（`ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` = `false`）。T8 がそれを試験で固定する
- **既存を壊さない**: 各タスクで既存テスト全通過（AC-5、SR-4）。試験の数・内容を減らさない。既存の Base Sepolia・Tempo の経路の挙動は変えない（例外は設計 §4.4 の client の購入の期限。T7 で明記）
- **依存**: 新しい npm 依存は T0-a で記録してから入れる。それ以外のタスクで依存を足さない
- **鍵**: `src/` は env を読まない。試験の鍵は毎回の乱数。実鍵は `tools/` と ignored の env ファイルだけ。**鍵・RPC の URL・ローカルの絶対パスを docs・PR に書かない**
- **commit**: 1 タスク 1 PR。レビューの指摘は同じタスクの中で直す。小さな訂正に全体の再レビューをしない。Codex の承認と試験の通過で親が merge する（owner の確認は T10 と配備）
- **停止条件**: 誤支払い・二重支払いの可能性、秘密の露出、設計と実測の食い違い（設計を改訂してから続ける）、未許可の権限、外部の事実の変化（facilitator の `/supported`・SDK の挙動が設計と違う）

## 1. 依存

```
T0-a 依存の記録と導入
T1 表と設定                 ← T0-a（型だけ。先に書ける）
T2 core の EVM 前提         ← T1
T3 Arc 受信（adapter・能力・fixture）   ← T1
T4-a SVM preflight と payer fixture    ← T0-a, T1
T4-b SVM adapter・起動時の検査・facilitator fixture ← T4-a
T5 道具（sign・svm-payer・wallet・能力）← T0-a, T1, T4-a
T6 実機の確認（SVM /verify。U-2）      ← T4-b, T5
T7 配線・client・MCP・統合試験          ← T2, T3, T4-b, T5, T6
T8 本番の入口（無効のまま）             ← T7
T9 文書                                 ← T8
T10 gate（owner）: 鍵・口座・配備・AC-1/AC-2・有効化 ← T9
```

T1・T3 は T0-a と並行できる（T3 は依存を増やさない）。T4-a・T5 は T0-a の導入が要る。

## 2. タスク

### T0-a — 依存の記録と導入（設計 §9、SR-1）

| 内容 | 成果物 | 完了条件 |
|---|---|---|
| `@x402/{core,evm,fetch}` 2.28.0、`@solana/kit`・`@solana-program/token`・`@solana-program/compute-budget`・`@noble/curves` の固定版、`@x402/svm` 2.28.0（devDependency）。入れる**前に**、各パッケージの版・依存の木・「何を読み何に接続するか」（RPC client の有無、`fetch` の呼び出し箇所、WebCrypto の使用）を設計 §9 の表に記録。`@x402/evm`・`@x402/fetch` の 2.27.0 → 2.28.0 の dist の diff を取る | `package.json`・lockfile、設計 §9 の更新 | `npm ls` の木が記録と一致。`tests/unit/no-direct-fetch` が通る（`src/` に新しい fetch の口が無い）。既存の全試験が通る（Linux）。`@x402/svm` が `src/`・`tools/` から import されていないことを試験で固定（依存の向きの試験） |

### T1 — network の表と設定（設計 §1・§2、FR-1・FR-3・FR-7）

- **範囲**: `src/config.ts`（`KNOWN_NETWORKS`・`KnownNetwork`・`assetKeyOf`・`parseRouterConfig(raw, { networks? })`・`loadRuntimeConfig(env, read, { networks? })`・`x402.inboundFacilitators`）、
  `src/main.ts` の `startRouter(capabilities)` → `loadRuntimeConfig` への `knownNetworksForTest` の受け渡し（配線の本体は T7）、`tests/fixtures/known-networks.ts`
- **完了条件（unit）**:
  - 照合の範囲: `sourceRail` x402／mpp の `source`、`rail` x402／mpp の `destination` だけ。`subetha` 受信と synthetic 構成は照合しない（既存の harness の設定がそのまま通る）
  - 表に無い network・向き・レール・資産・桁、動的 x402 の `tokenDomain` の不一致、mpp の `feeAsset` が表に無い、Arc の 18 桁（FR-7）、evm の `payTo` が `0x`＋40 hex でない、svm の `payTo` が 32 バイトでない → `config_invalid`（否定の試験、各 1 本以上）
  - `networks` を渡さなければ照合しない（指紋の既存の試験が変わらない）。`ROUTER_ADAPTER_MODE=real` で `KNOWN_NETWORKS`、`synthetic` で無し
  - `inboundFacilitators`: `kind` が表と違う、`eip155:84532` を env と両方に書く、query・userinfo・fragment のある URL、x402 受信の network に facilitator が無い → `config_invalid`。ホストが拒否ホストと `dependencyUrls` に入る
  - 既存の本番の設定（`tools/remote-mcp-config.ts` が生む JSON）が `KNOWN_NETWORKS` で通る
- **sabotage**: 表の照合を外す／`tokenDomain` の比較を外す／svm の `payTo` の長さの検査を外す → 各否定の試験が落ちる

### T2 — core の EVM 前提（設計 §1、FR-4）

- **範囲**: `src/core/dynamic.ts` の資産の比較を `assetKeyOf` に、`src/mcp/tools.ts`・`src/client/types.ts` の payer interface の `chainId` → `network`（既存の引数は互換のまま受ける）、
  `src/http/projection.ts` の `subject` の表示（family で桁・アドレスの形）。予算の鍵（設定の文字列）は変えない
- **完了条件（unit）**: SVM の mint（大文字小文字あり）の offer が動的の照合を通り、小文字化した mint は通らない／EVM は今までどおり大文字小文字を無視／既存の MCP の引数で呼べる／
  Solana の `subject` に base58 の受取先と 6 桁が出る
- **sabotage**: `assetKeyOf` を小文字化だけに戻す → SVM の試験が落ちる

### T3 — Arc の受信: adapter・能力・fixture（設計 §3・§4・§6、FR-8〜13）

- **範囲**: `src/adapters/inbound/x402.ts`（`kind`、`offerSeconds`／`maxTimeoutSeconds` の分離、settle の HTTP 期限 `maxTimeoutSeconds + 10`、`assetTransferMethod`、
  売り手証明の header、kind `circle` の §6 の表）、`src/ports/inbound.ts`（`SellerProofCapability`）、`tests/fixtures/circle-facilitator.ts`（証明を検証する）、
  `tests/fixtures/seller-proof-capability.ts`（試験用。乱数の鍵）
- **完了条件（unit・wire）**:
  - kind `x402` は wire・HTTP 期限・extra のキー集合・settle の写像が**今のまま**（既存の試験が変わらない）
  - kind `circle`: requirements に `assetTransferMethod: "eip3009"`、`maxTimeoutSeconds` 30、`extra.expiresAt` は `offerSeconds`、settle の期限 40 秒（fixture の遅延で確かめる）
  - 証明: header を fixture が検証して通る／`bodyHash` が送った body と一致／purpose が endpoint と一致／nonce が要求ごとに違う／能力が拒むと**要求を出さない**（verify は `isValid: false`、settle は `rejected`。外部接続 0）
  - 能力の境界: `proofFor` 以外の署名の口が無い（型の試験）、`purpose` の列挙外・`bodyHash` の形違いを拒む、時計は作るときに注入（adapter から渡せない）、`network`・`payTo` が固定
  - §6 の表の各行（timeout・5xx・4xx（403 `registration_required` は診断つき）・`success: false`・`settlement_pending`・`network` 違い・`transaction` の形違い → `unknown`、`0x`＋64 hex → `settled`）。
    `payer`・`amount`・`extensions` の有無で結果が変わらない。settle の要求は 1 回だけ（回数を数える）
  - 静的 core の `rejected` は終端の `source_failed`、公開状態 `awaiting_payment`、同じ quote の再購入は同じ結果（既存の挙動の確認）
- **sabotage**: `bodyHash` を固定値にする／purpose を入れ替える／`transaction` の形の検査を「非空」に戻す／4xx を `rejected` に戻す／能力の `payTo` の束縛を外す → 各試験が落ちる

### T4-a — SVM の preflight と payer fixture（設計 §5.2〜5.4、FR-16）

- **範囲**: `src/adapters/inbound/x402-svm.ts` の **純粋な部分**（復号・署名検証・組み直し・比較。ネットワークに出ない）、`tests/fixtures/svm-payer.ts`（`tools/svm-payer.ts` と共有する組み立て＋改変の口）
- **完了条件（unit）**:
  - 正しい transaction（fixture の payer が組む）が通る。**同期**（`PreflightResult` を返す。await 無し）
  - 否定（各 1 本。AC-3）: base64 でない／1,233 バイト／読み残し／署名の数が 1・3／fee payer の枠に署名がある／authority の署名が壊れている（1 bit）／別の鍵の署名／version legacy／lookup table あり／
    `staticAccounts[0]` が fee payer でない／命令が 3・5 個／並べ替え／ComputeBudget の data の末尾に 1 バイト／`units` 200,001／`microLamports` 5,000,001／Token-2022 の program／
    宛先・mint・桁・額の違い／`source` = fee payer・= 宛先／`authority` = fee payer・= payTo／memo の違い（`nonce_mismatch`。署名は壊れていてもこの理由が先）／口座の追加／data の末尾の追加
  - 理由は `credential_mismatch`・`nonce_mismatch` のどちらか。例外の文言が出ない
  - **互換の試験**（U-3）: `@x402/svm` の client `createPaymentPayload` を loopback の RPC fixture（encoded の mint account data、`getLatestBlockhash`）に向けて作った payload を preflight が受ける
- **sabotage**: 署名検証を外す／byte 比較を長さの比較にする／`units` の上限を外す／fee payer の枠の検査を外す → 各試験が落ちる（AC-7）

### T4-b — SVM の adapter・起動時の検査・facilitator fixture（設計 §5.1・§5.5・§6、FR-14・FR-15・FR-18〜20）

- **範囲**: `createX402SvmInbound`（offer・verify・settle・§6 の表）、起動時の `/supported` の読取と `feePayer` の固定・不等式、ATA の検査（guarded transport の JSON-RPC）、
  `tests/fixtures/svm-facilitator.ts`（`@x402/svm/exact/facilitator` の `ExactSvmScheme` ＋ fixture の signer）、`tests/fixtures/solana-rpc.ts`
- **完了条件（unit・wire）**:
  - offer: `payTo` = owner、`extra.feePayer`・`extra.memo` = `challengeNonce`、`maxTimeoutSeconds` 40、`fundsMoveOnCredential: false`
  - 起動時: `/supported` に該当が 0 件・`feePayer` が 2 つ・32 バイトでない・`feePayer` が payTo／ATA／mint／program のどれかと等しい → 起動しない。ATA が無い・owner 違い・mint 違い・program 違い・RPC が読めない → 起動しない。
    quote・purchase の中で RPC・`/supported` に出ない（接続を数える）
  - verify・settle の payload に `challengeNonce` が無い。facilitator fixture（本物の verify の論理）が Router の形を受ける。settle の期限 50 秒
  - §6 の表の各行（SVM 版: `transaction` が base58 64 バイトでない → `unknown`）。fee payer が変わった後、発行済みの quote は verify で落ちる（AC-4）
  - 動的: 昇格前の再試行は同じ credential で通る、昇格後は 1 回だけ、別の quote への再提出は `nonce_mismatch`（§5.4）
- **sabotage**: `/supported` の `x402Version` の絞り込みを外す／不等式を 1 つ外す／ATA の owner の照合を外す／settle の形の検査を「非空」に戻す → 各試験が落ちる

### T5 — 道具（設計 §3・§5.6・§7、FR-17、SR-5・SR-7）

- **範囲**: `tools/sign-payment.ts`（scheme と family で振り分け、chainId・domain は表から、上限 20,000）、`tools/svm-payer.ts`（固定値だけで組む。RPC は `getLatestBlockhash` 1 回）、
  `tools/wallet-new-solana.ts`、`tools/real-seller-proof-capability.ts`、`package.json` の scripts（`wallet:new:solana`）
- **完了条件（unit。鍵は乱数、RPC は loopback の fixture）**: 表に無い network・mint・桁・domain、`payTo` の形違い、`feePayer`／`memo` 無し、20,001、失効、`fundsMoveOnCredential: true` の
  SVM offer を**署名の前**に拒む／組んだ transaction を T4-a の preflight が受ける／RPC の要求は 1 回・方法は `getLatestBlockhash` だけ／EVM の x402 は Base Sepolia と Arc で chainId・domain が表のもの／
  MPP の開示と順序は変わらない／能力は `SellerRequest` 以外に署名しない（型と試験）
- **sabotage**: 上限の検査を外す／chainId を固定に戻す → 試験が落ちる

### T6 — 実機の確認（設計 §10 U-2。testnet、settle しない）

| 内容 | 成果物 | 完了条件 |
|---|---|---|
| 使い捨ての ed25519 鍵（`wallet:new:solana`）と devnet の USDC（faucet.circle.com。devnet SOL は不要——fee payer は facilitator）で、T5 の道具が組んだ transaction を x402.org の **`/verify` だけ**に出す。Router の offer と同じ requirements（`feePayer` は `/supported` の値、memo あり）。Circle の `/verify` は、Arc testnet の USDC を faucet で得られれば同じく verify だけ（売り手証明つき。得られなければ T10 に送る） | 設計 §10 の U-2 の行に結果（日時・`isValid`・`invalidReason` の有無。鍵・URL・本文は書かない）、`.claude_workflow/local/` に記録 | `isValid: true` が 1 回。false なら理由を設計に照らし、**設計を改訂してから T7 に進む**。settle を呼ばない（コードで `/settle` に出られないことを試験の道具で固定） |

### T7 — 配線・client・MCP・統合試験（設計 §2・§3・§4.4・§5.7、AC-3〜AC-7）

- **範囲**: `src/main.ts`（network ごとの facilitator と adapter の選択、`sellerProofs`・`knownNetworksForTest`、起動時の検査の呼び出し、拒否ホスト）、`src/client/index.ts`（購入はすべて `executeTimeoutMs`、既定 180 秒）、
  `src/mcp/tools.ts`（listing・nextStep の文言。英語）、`tests/wire/multirail-integration.test.ts`、`tests/fixtures/router-multirail-process.ts`
- **完了条件（wire・Linux）**:
  - 本番と同じ構成（fixture の facilitator・RPC、`fixtureFacilitators`・`knownNetworksForTest`）で、Arc → MPP、Arc → x402、Solana → x402、Solana → MPP の静的・動的の購入が `delivered`（AC-1/2 の offline 版）
  - AC-3 の全項目で外部接続 0（facilitator・RPC の要求数を数える）
  - AC-4: settle の応答の喪失・crash・形の違う成功応答で `unknown` が耐久的に残り、再起動後に settle が再発しない（要求数）
  - network の取り違え: Arc の credential を Solana の route に、Base Sepolia の facilitator に Arc の要求が行かない（facilitator ごとの要求数）
  - 予算: `(network, asset)` の区分が別（Arc の消費が Base Sepolia の予算を減らさない）
  - client: 静的購入の期限が 180 秒（fixture で 15 秒の settle を通す）。既存の Base Sepolia・Tempo の統合試験が変わらない
  - AC-6: listing に新しい route／プロファイルと `feePolicy`、`subject` の network・asset・decimals・受取先
- **sabotage**: facilitator の選択を network に依らず先頭にする／予算の鍵から network を外す／client の期限を 10 秒に戻す → 各試験が落ちる（AC-7）

### T8 — 本番の入口（設計 §8。無効のまま）

- **範囲**: `tools/remote-mcp-config.ts`（route・プロファイル・予算・`inboundFacilitators`、`ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` = `false`）、`tools/remote-router-process.ts`（env の名前）
- **完了条件（unit）**: 生成した設定が `KNOWN_NETWORKS` で通る／定数が `false` のとき Arc・Solana の route／プロファイルが設定に**出ない**（listing にも出ない）／`true` にしたときだけ出て、予算の区分がある／
  env に鍵・URL の値を埋め込まない
- **sabotage**: 定数を無視して常に出す → 試験が落ちる

### T9 — 文書

- `docs/DEPLOY.md` §2c（Arc・Solana の有効化の条件と手順: 鍵の作り方、ATA の作成と rent、`inboundFacilitators`、env、gate の順）、`README.md`・`CLAUDE.md`（英語。`npm run sign` が Arc・Solana でも通ること、
  `wallet:new:solana`、MPP の開示は変えない）、`docs/ENGINEERING.md`（新しい adapter と能力）。設計 §9・§10 の更新（T0-a・T6 の結果）
- **完了条件**: 文書に鍵・URL・絶対パスが無い（grep）。手順を fixture の構成で 1 度なぞる

### T10 — gate（owner の確認の上で。設計 §8・§10、AC-1・AC-2、U-1・U-4・U-5）

| 段 | 内容 | 条件 |
|---|---|---|
| G-1 | 鍵と口座: Arc の証明専用の受取鍵を作る（ホストの env。Base Sepolia の鍵とは別）。Solana の受取 owner の鍵は**ホストに置かない**（運用者の手元）。ATA を作る（rent 1,488,440 lamports は運用者）。使い捨ての payer に Arc testnet USDC・devnet USDC を faucet で入れる | owner の確認。mainnet の資産は使わない |
| G-2 | 配備（無効のまま）: `inboundFacilitators`・env を入れて再起動。起動時の検査（`/supported`・ATA）が通ること。rollback の container を 1 つ保つ | owner の確認（配備） |
| G-3 | 受け入れの購入: AC-1（Arc → Tempo、静的・動的）、AC-2（Solana → Base または Tempo、静的・動的）。各 1 件、使い捨て口座。U-1（settle の `success` までの時間、`settlement_pending` の有無）・U-4 を記録 | owner の確認（支払いごとに quote を見せる）。`settlement_pending` が出たら設計 §10 U-1 を改訂（`/status` の polling の設計）してから有効化 |
| G-4 | 有効化: `ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` = `true` の PR と配備。CLAUDE.md の route の表を更新 | owner の確認 |
| U-5 | Base Sepolia の `success: false` の写像を揃えるか | owner の決定（急がない） |

## 3. AC との対応

| AC | タスク |
|---|---|
| 1 | T7（offline）・T10 G-3（実決済） |
| 2 | T7（offline）・T10 G-3 |
| 3 | T4-a・T4-b・T7 |
| 4 | T3・T4-b・T7 |
| 5 | 全タスク・T7（Linux） |
| 6 | T2・T5・T7・T9 |
| 7 | T1・T3・T4-a・T4-b・T5・T7・T8（各 sabotage） |

## 4. 独立レビューの記録

| 回 | 日付 | モデル | 判定 | 反映 |
|---|---|---|---|---|

## 5. 本書で決めていないこと

- T10 G-3 で `settlement_pending` が出た場合の `/status` の polling の形（設計 §10 U-1。出てから設計する）
- S-3・S-4（送信）のタスクは別紙
