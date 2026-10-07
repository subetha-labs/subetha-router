# タスク分解: Arc と Solana で払う（S-1・S-2）

> 2026-10-06、第 3 版。入力は `docs/multirail-requirements.md`（要件 v3、owner の決定 §0、確認の結果 §2.5）と `docs/multirail-design.md`（設計 第 3 版、owner 承認
> 「現在の設計で良いです」2026-10-06）。以下「設計 §x」「要件 FR-x」はそれらを指す。本書はタスクフェーズの成果物で、コード・実行結果・合格の主張は含まない。
> 記載のコマンドは**計画であり未実行**。第 1 版は独立レビューで APPROVE WITH CHANGES（高 3・中 4）、第 2 版は範囲限定で APPROVE WITH CHANGES（高 1・中 4・低 1）。指摘と反映先は §4。

## 0. 全タスク共通

- **担当**: 親（controller）が状態・commit を持ち、実装後に実ソースを読み戻してテストを実際に実行する。レビューは `gpt-6-astra`・read-only で差分を見る
- **順序**: まず落ちるテストを書き、赤を確かめてから実装する。完了条件の試験は**守っているコードを外して落ちること**（sabotage）を確かめ、結果を PR に書く
- **完了コマンド**: focused（当該テスト）→ `npm run types` → `npm test`。skip と失敗を区別して報告する。「Linux」と書いた完了条件は Linux（Colima の `node:22-bookworm`）で実行した結果を要する
- **資金**: **Router の購入の settle（資金が動く決済）は T10 G-3 だけ**。T9 までのどのタスクも**本物の facilitator の `/settle`** を呼ばない（loopback の fixture の settle は試験であり、資金は動かない）。例外として許すのは、T6 の使い捨て口座への **faucet の testnet 資産**の受け取り、
  T6 の準備（devnet の SOL の airdrop と、受取 owner の ATA の作成——使い捨て payer が rent と手数料を払う devnet の tx）、送信しない部分署名（SVM）・署名だけ（EIP-3009）。**mainnet の資産は一切使わない**（SR-6）
- **外部への接続**（T9 まで）: T0-a の npm の取得、T6 の **faucet（faucet.circle.com・faucet.solana.com）の受け取り**と **未払いの読取**——x402.org の `/supported`・`/verify`、Circle の `/verify`、
  Solana devnet の RPC（`getBalance`・`requestAirdrop`・`getLatestBlockhash`・`getAccountInfo`・`simulateTransaction`、ATA 作成の `sendTransaction` とその確認）
  （各 1〜数回。日時・回数を記録）。それ以外の試験はすべて loopback の fixture
- **既定で無効**: T9 まで、Arc・Solana の route／プロファイルは**本番の入口の設定に出さない**（`ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` = `false`）。T8-a がそれを試験で固定する
- **既存を壊さない**（SR-4・FR-5）: 各タスクで既存テスト全通過（AC-5）。試験の数・内容を減らさない。既存の Base Sepolia・Tempo の経路で**意図して変えるのは次の 3 つだけ**で、各タスクに明記する:
  (a) client の購入の期限（静的も `executeTimeoutMs`、既定 180 秒。設計 §4.4、T7-a）、(b) `npm run sign` の上限 10,000 → 20,000（D-7、T5）、(c) `npm run sign` の offer の検査の強化（表に無い network・domain を拒む。SR-7、T5）。
  有効な Base Sepolia・Tempo の offer の署名、MPP の開示と承認 → 署名の順は変えない
- **依存**: 新しい npm 依存は T0-a で記録してから入れる。それ以外のタスクで依存を足さない
- **鍵**: `src/` は env を読まない。試験の鍵は毎回の乱数。実鍵は `tools/` と ignored の env ファイルだけ。**鍵・RPC の URL・ローカルの絶対パスを docs・PR に書かない**
- **SR-3（独立レビュー 2 回以上）の置き場**: SVM の検査は **T4-a の PR のレビュー（1 回目）と T7-c の PR のレビュー（2 回目。T4-a〜T4-c の実ソースを範囲に含める）**。
  Circle の証明の境界は **T3（1 回目）と T8-b（2 回目。本番の入口の注入を含める）**。2 回目は「差分」ではなく実ソースを見る指示を出す
- **commit**: 1 タスク 1 PR。レビューの指摘は同じタスクの中で直す。小さな訂正に全体の再レビューをしない。Codex の承認と試験の通過で親が merge する（owner の確認は T10 と配備）
- **停止条件**: 誤支払い・二重支払いの可能性、秘密の露出、設計と実測の食い違い（設計を改訂してから続ける）、未許可の権限、外部の事実の変化（facilitator の `/supported`・SDK の挙動が設計と違う）

## 1. 依存

```
T0-a 依存の記録と導入
T1 表と設定（parse だけ）                       ← T0-a（base58 の codec）
T2 core の EVM 前提                             ← T1
T3 Arc 受信（adapter・能力の port・fixture）     ← T1（port の型は T3 が導入する）
T4-a SVM の transaction 検査・payer fixture・最小 RPC fixture ← T0-a, T1
T4-b SVM の起動時の検査（/supported・ATA・transport）        ← T4-a
T4-c SVM adapter（offer・verify・settle・§6）                ← T4-b
T5 道具（sign・svm-payer・wallet・能力）         ← T0-a, T1, T3（能力の port）, T4-a
T6 実機の確認（/verify だけ。U-2）              ← T3, T4-c, T5
T7-a client・MCP                                ← T2
T7-b 合成（main.ts の配線・transport の否定・拒否ホスト） ← T3, T4-c, T6, T7-a
T7-c 統合・回復                                 ← T7-b
T8-a 本番の入口の設定生成（無効のまま）          ← T7-c
T8-b 本番の入口の process（能力の注入・受け入れ用の起動）← T8-a
T9 文書                                         ← T8-b
T10 gate（owner）                               ← T9
```

T0-a と並行できるタスクは無い（T1 が base58 の codec を要る）。T1 の後は T2・T3・T4-a が並行できる。

## 2. タスク

### T0-a — 依存の記録と導入（設計 §9、SR-1）

| 内容 | 成果物 | 完了条件 |
|---|---|---|
| `@x402/{core,evm,fetch}` 2.28.0、`@solana/kit`・`@solana-program/token`・`@solana-program/compute-budget`・`@noble/curves` の固定版、`@x402/svm` 2.28.0（devDependency）。入れる**前に**、各パッケージの版・依存の木・「何を読み何に接続するか」（RPC client の有無、`fetch` の呼び出し箇所、WebCrypto の使用）を設計 §9 の表に記録。`@x402/evm`・`@x402/fetch` の 2.27.0 → 2.28.0 の dist の diff を取る | `package.json`・lockfile、設計 §9 の更新 | `npm ls` の木が記録と一致。`tests/unit/no-direct-fetch` が通る（`src/` に新しい fetch の口が無い）。既存の全試験が通る（Linux）。`@x402/svm` が `src/`・`tools/` から import されていないことを試験で固定（依存の向きの試験） |

### T1 — network の表と設定（設計 §1・§2、FR-1・FR-3・FR-7）

- **範囲**: `src/config.ts`（`KNOWN_NETWORKS`・`KnownNetwork`・`assetKeyOf`・`parseRouterConfig(raw, { networks? })`・`loadRuntimeConfig(env, read, { networks? })`・`x402.inboundFacilitators`。
  base58 は `@solana/kit` の codec）、`src/main.ts` の `startRouter(capabilities)` → `loadRuntimeConfig` への `knownNetworksForTest` の受け渡し（**parse までの配線**。adapter の選択は T7-b）、
  `tests/fixtures/known-networks.ts`、**既存の real モードの fixture の起動側（`tests/fixtures/router-*-process.ts`）に `knownNetworksForTest` を渡す移行**（設計 §1 の注入路）
- **完了条件（unit）**:
  - 照合の範囲: `sourceRail` x402／mpp の `source`、`rail` x402／mpp の `destination` だけ。`subetha` 受信と synthetic 構成は照合しない（既存の harness の設定がそのまま通る）
  - 表に無い network・向き・レール・資産・桁、動的 x402 の `tokenDomain` の不一致、mpp の `feeAsset` が表に無い、Arc の 18 桁（FR-7）、evm の `payTo` が `0x`＋40 hex でない、svm の `payTo` が 32 バイトでない → `config_invalid`（否定の試験、各 1 本以上）
  - `networks` を渡さなければ照合しない（指紋の既存の試験が変わらない）。`ROUTER_ADAPTER_MODE=real` で `KNOWN_NETWORKS`、`synthetic` で無し
  - `inboundFacilitators`: `kind` が表と違う、`eip155:84532` を env と両方に書く、query・userinfo・fragment のある URL、x402 受信の network に facilitator が無い → `config_invalid`。**parse の結果に facilitator の一覧が入る**（拒否ホスト・`dependencyUrls` への合成は T7-b）
  - 既存の本番の設定（`tools/remote-mcp-config.ts` が生む JSON）が `KNOWN_NETWORKS` で通る。既存の real モードの fixture 起動が通る
- **sabotage**: 表の照合を外す／`tokenDomain` の比較を外す／svm の `payTo` の長さの検査を外す → 各否定の試験が落ちる

### T2 — core の EVM 前提（設計 §1、FR-4）

- **範囲**: `src/core/dynamic.ts` の `balanceOf` に渡す資産の鍵を `assetKeyOf` に（`dynamic.ts:627-631`）、`src/mcp/tools.ts`・`src/client/types.ts` の payer interface の `chainId` → `network`（既存の引数は互換のまま受ける）、
  `src/http/projection.ts` の `subject` の表示（family で桁・アドレスの形）。予算の鍵（設定の文字列）は変えない
- **完了条件（unit）**: `assetKeyOf` の直接の試験（evm は小文字化、svm はそのまま、family は network から）／core の孤立した試験で `balanceOf` に渡る資産の引数が `assetKeyOf` の値（SVM の送信を本番で許す意味ではない。S-4 まで表の `outbound` に svm は無い）／
  既存の MCP の引数で呼べる／Solana の受信の `subject` に base58 の受取先と 6 桁が出る
- **sabotage**: `assetKeyOf` を小文字化だけに戻す → 直接の試験が落ちる

### T3 — Arc の受信: adapter・能力の port・fixture（設計 §3・§4・§6、FR-8〜13）

- **範囲**: `src/adapters/inbound/x402.ts`（`kind`、`offerSeconds`／`maxTimeoutSeconds` の分離、settle の HTTP 期限 `maxTimeoutSeconds + 10`、`assetTransferMethod`、
  売り手証明の header、kind `circle` の §6 の表）、`src/ports/inbound.ts`（`SellerProofCapability`）、`tests/fixtures/circle-facilitator.ts`（証明を検証する）、
  `tests/fixtures/seller-proof-capability.ts`（試験用。乱数の鍵）。合成（main.ts）は触らない
- **完了条件（unit・wire）**:
  - kind `x402` は wire・HTTP 期限・extra のキー集合・settle の写像が**今のまま**（既存の試験が変わらない）
  - kind `circle`: requirements に `assetTransferMethod: "eip3009"`、`maxTimeoutSeconds` 30、`extra.expiresAt` は `offerSeconds`、settle の期限 40 秒（fixture の遅延 39 秒で通り 41 秒で `unknown`）
  - 証明（肯定）: header を fixture が検証して通る／`bodyHash` が送った body と一致／purpose が endpoint と一致／nonce が要求ごとに違う
  - 証明（否定。設計 §4.3）: header 無し・別の鍵の署名・`bodyHash` の不一致・purpose の入れ替え・`issuedAt` が未来・`expiresAt` 切れ・寿命 61 秒・nonce の再使用・`network`／`payTo` の改変 → fixture が 401、adapter は（verify）`isValid: false`／（settle、応答後）`unknown`。能力が拒むと**要求を出さない**（verify は `isValid: false`、settle は `rejected`。接続 0）
  - 能力の境界: `proofFor` 以外の署名の口が無い（型の試験）、`purpose` の列挙外・`bodyHash` の形違いを拒む、時計は作るときに注入（adapter から渡せない）、`network`・`payTo` が固定
  - 順序と衛生（FR-9・FR-10）: verify が `isValid: false` なら settle の要求は 0 回／facilitator の `invalidReason`・`errorReason` の文字列が adapter の結果にも公開応答にも出ない
  - §6 の表の各行（timeout・5xx・4xx（403 `registration_required` は診断つき）・`success: false`・`settlement_pending`・`network` 違い・`transaction` の形違い → `unknown`、`0x`＋64 hex → `settled`）。
    `payer`・`amount`・`extensions` の有無で結果が変わらない。settle の要求は 1 回だけ（回数を数える）
  - 静的 core の `rejected` は終端の `source_failed`、公開状態 `awaiting_payment`、同じ quote の再購入は同じ結果（既存の挙動の確認）
  - transport（**Linux**）: Circle への要求が guarded transport を通る（redirect を追わない、応答の上限、期限。既存の x402 adapter の試験の形で）
- **sabotage**: `bodyHash` を固定値にする／purpose を入れ替える／`transaction` の形の検査を「非空」に戻す／4xx を `rejected` に戻す／能力の `payTo` の束縛を外す／寿命の検査を外す → 各試験が落ちる

### T4-a — SVM の transaction の検査・payer fixture・最小 RPC fixture（設計 §5.2〜5.4、FR-16）

- **範囲**: `src/adapters/inbound/x402-svm.ts` の **純粋な部分**（復号・署名検証・組み直し・比較。ネットワークに出ない）、`tests/fixtures/svm-payer.ts`（`tools/svm-payer.ts` と共有する組み立て＋改変の口）、
  `tests/fixtures/solana-rpc.ts` の**最小**（encoded の mint account data、`getLatestBlockhash`。ATA の `getAccountInfo` は T4-b で足す）
- **完了条件（unit）**:
  - 正しい transaction（fixture の payer が組む）が通る。**同期**（`PreflightResult` を返す。await 無し）
  - transaction の検査の否定（各 1 本。AC-3。理由は **transaction の検査では** `credential_mismatch`・`nonce_mismatch` のどちらか）: base64 でない／1,233 バイト／読み残し／署名の数が 1・3／fee payer の枠に署名がある／
    authority の署名が壊れている（1 bit）／別の鍵の署名／version legacy／lookup table あり／`staticAccounts[0]` が fee payer でない／命令が 3・5 個（**transfer が 2 つ**、**不明な program** を含む）／並べ替え／
    ComputeBudget の data の末尾に 1 バイト／`units` 200,001／`microLamports` 5,000,001／Token-2022 の program／宛先・mint・桁・額の違い／`source` = fee payer・= 宛先／`authority` = fee payer・= payTo／
    memo の違い（`nonce_mismatch`。署名は壊れていてもこの理由が先）／口座の追加／data の末尾の追加／**fee payer を Router に向けた tx**（fee payer が宛先）
  - 封筒の検査（既存の preflight を継ぐ。理由は既存のもの）: 未知の nonce・失効（`offer_expired`）・route の束縛（`route_binding_mismatch`）・`accepted` の各欄の不一致（`offer_mismatch`）・`extra` の未知キー
  - 例外の文言が出ない
  - **互換の試験**（U-3）: `@x402/svm` の client `createPaymentPayload` を最小の RPC fixture に向けて作った payload が検査を通る
  - **変異の行列**（AC-7。各行に試験名を書く）: 署名検証／byte 比較（長さだけに）／fee payer の枠／`units` の上限／`microLamports` の上限／不等式の各 1 つ／memo の照合／大きさの上限／読み残し／lookup table／署名の数／封筒の各検査 → 落ちる試験が 1 本以上ずつ
- **sabotage**: 上の行列を PR で実行して記録

### T4-b — SVM の起動時の検査（設計 §5.1、FR-14・FR-15・FR-18、SR-2）

- **範囲**: `/supported` の読取と `feePayer` の固定・不等式、ATA の検査（guarded transport で JSON-RPC を POST）、`tests/fixtures/solana-rpc.ts` に ATA の `getAccountInfo`（jsonParsed）、
  `tests/fixtures/svm-facilitator.ts` の `/supported` 部分。関数として実装し、呼び出しは T7-b
- **完了条件（unit・wire、**Linux**）**:
  - `/supported`: `x402Version === 2`・network・scheme で選ぶ。該当 0 件・`feePayer` が 2 つ・32 バイトでない・`feePayer` が payTo／ATA／mint／token program／Memo program／ComputeBudget program のどれかと等しい → 失敗（fail closed）
  - ATA: 無い・owner 違い・mint 違い・program 違い（Token-2022）・RPC が読めない・応答が 64 KiB 超・JSON でない → 失敗
  - transport の方針（SR-2）: loopback 不可（`fixtureFacilitators` 無しで loopback の URL は 0 接続で失敗）、DNS 期限 3 秒、HTTP 期限 10 秒、redirect を追わない（3xx で失敗、Location へ 0 接続）、
    禁止アドレス（private・link-local・metadata）への解決は 0 接続で失敗。既存の `guarded-transport` の試験の seam（`dialForTest`）で
  - 回数: 起動時に `/supported` **ちょうど 1 回**、RPC **ちょうど 1 回**（接続と要求を数える）
- **sabotage**: `x402Version` の絞り込みを外す／不等式を 1 つ外す／ATA の owner の照合を外す／応答の上限を外す → 各試験が落ちる

### T4-c — SVM の adapter（設計 §5.1・§5.5・§6、FR-19・FR-20）

- **範囲**: `createX402SvmInbound`（offer・preflight（T4-a）・verify・settle・§6 の表）、`tests/fixtures/svm-facilitator.ts`（`@x402/svm/exact/facilitator` の `ExactSvmScheme` ＋ fixture の signer: `getAddresses`・`signTransaction`・`simulateTransaction`・`sendTransaction`・`confirmTransaction` を記録し成功・失敗を切り替える）
- **完了条件（unit・wire）**:
  - offer: `payTo` = owner、`extra.feePayer`・`extra.memo` = `challengeNonce`、`maxTimeoutSeconds` 40、`fundsMoveOnCredential: false`、`extra.expiresAt` は `offerSeconds`
  - verify・settle の payload に `challengeNonce` が無い。**本物の verify の論理**（fixture の facilitator）が Router の形を受ける。settle の期限 50 秒（49 秒で通り 51 秒で `unknown`）
  - 順序と衛生: verify が `isValid: false` なら settle 0 回／`invalidReason` を転送しない
  - §6 の表の各行（SVM 版: `transaction` が base58 64 バイトでない → `unknown`、64 バイト → `settled`）。settle は 1 回だけ
  - fee payer が変わった後（fixture の `/supported` を変えて **adapter を作り直す**。process の再起動と journal の回復は T7-c）、発行済みの quote は verify で落ちる（AC-4）
  - transport（SR-2、**Linux**）: verify・settle の要求が guarded transport を通る——redirect を追わない（3xx で `isValid: false`／`unknown`、Location へ 0 接続）、応答の上限、期限、`fixtureFacilitators` 無しで loopback の facilitator は 0 接続。既存の x402 adapter の transport の試験を共有の形にして SVM でも走らせる
  - quote・purchase の中で RPC・`/supported` に出ない（接続を数える）
- **sabotage**: settle の形の検査を「非空」に戻す／`challengeNonce` を payload に残す／memo を offer から外す → 各試験が落ちる

### T5 — 道具（設計 §3・§5.6・§7、FR-17、SR-5・SR-7）

- **範囲**: `tools/sign-payment.ts`（scheme と family で振り分け、chainId・domain は表から、上限 **20,000**（10,000 から。D-7）、offer の検査の強化）、`tools/svm-payer.ts`（固定値だけで組む。RPC は `getLatestBlockhash` 1 回）、
  `tools/wallet-new-solana.ts`、`tools/real-seller-proof-capability.ts`、`package.json` の scripts（`wallet:new:solana`）
- **完了条件（unit。鍵は乱数、RPC は loopback の fixture）**: 表に無い network・mint・桁・token program・domain、`payTo` の形違い、`feePayer`／`memo` 無し、20,001、失効、`fundsMoveOnCredential: true` の
  SVM offer、形の違う offer を**署名の前**に拒む（署名の回数 0 を数える）／組んだ transaction を T4-a の検査が受ける／RPC の要求は 1 回・方法は `getLatestBlockhash` だけ／EVM の x402 は Base Sepolia と Arc で chainId・domain が表のもの／
  既存の Base Sepolia（10,000・11,000）と Tempo の offer は今までどおり署名できる／MPP の開示と順序は変わらない／能力は `SellerRequest` 以外に署名しない（型と試験）
- **sabotage**: 上限の検査を外す／chainId を固定に戻す／token program の検査を外す → 試験が落ちる

### T6 — 実機の確認（設計 §10 U-2。testnet、`/verify` だけ、settle しない）

| 内容 | 成果物 | 完了条件 |
|---|---|---|
| 使い捨ての ed25519 鍵（`wallet:new:solana`）と devnet の USDC（faucet.circle.com）。受取 owner の ATA を作るための少量の devnet SOL（faucet.solana.com。購入そのものには SOL は要らない——fee payer は facilitator）。**offer は T4-c の adapter に作らせ**（`createOffer`。`feePayer` は本物の `/supported` から）、T5 の道具で署名し、x402.org の **`/verify` だけ**に出す。Circle は、Arc testnet の USDC を faucet で得られれば、T3 の adapter の offer と売り手証明（使い捨ての受取鍵）で `/verify` だけ（得られなければ T10 G-3 に送る）。道具は `tools/rails-verify-probe.ts`（`/settle` の経路を持たない） | 設計 §10 の U-2 の行に結果（日時・`isValid`・`invalidReason` の有無。鍵・URL・本文は書かない）、`.claude_workflow/local/` に記録 | **必須**: SVM の `isValid: true` が 1 回。**条件つき**: Circle は Arc testnet の USDC が faucet で得られれば `isValid: true` 1 回、得られなければその事実を記録して G-3 に送る。false なら理由を設計に照らし、**設計を改訂してから T7-b に進む**。外部の要求は `/supported` 1 回・`getLatestBlockhash` 1 回・`/verify` 数回。settle 0 回 |

### T7-a — client・MCP（設計 §4.4、AC-6）

- **範囲**: `src/client/index.ts`（購入はすべて `executeTimeoutMs`、既定 **180 秒**。quote・status・listing の期限は変えない）、`src/mcp/tools.ts`（listing・nextStep の文言。英語）
- **完了条件（unit）**: 制御した時計と signal で、静的購入の既定の期限が 180 秒ちょうど（179 秒で abort されず 181 秒で abort）、明示の `executeTimeoutMs` が効く、quote・status の期限は従来（10 秒）／
  既存の client の試験が変わらない／listing に `network`・`asset`・`decimals`・受取先、`feePolicy`
- **sabotage**: 静的購入を `timeoutMs` に戻す → 試験が落ちる

### T7-b — 合成（設計 §2・§3・§5.1、FR-1・FR-14・FR-15、SR-2）

- **範囲**: `src/main.ts`（network ごとの facilitator と adapter の選択、`sellerProofs`・`knownNetworksForTest`、T4-b の起動時の検査の呼び出し、facilitator・Solana RPC のホストを拒否ホストと `dependencyUrls` に）、
  `tests/fixtures/router-multirail-process.ts`（loopback の facilitator ×3・RPC・`fixtureFacilitators`・`knownNetworksForTest`）
- **完了条件（wire、**Linux**）**:
  - route／プロファイルの network ごとに正しい facilitator が選ばれる（facilitator ごとの要求数: Arc の購入で Circle だけ、Solana で x402.org の fixture だけ、Base Sepolia で既存だけ）
  - `sellerProofs` が無い・`network` 違い・`address` が `payTo` と違う → 起動しない（route と**プロファイルの両方**で）
  - 拒否ホスト・`dependencyUrls` に Circle・x402.org・Solana RPC のホストが入る（動的の URL にそれらを渡すと `destination_blocked`）
  - 起動時の検査の失敗で起動しない（T4-b の各否定を合成で 1 本ずつ）。起動時の回数 `/supported` 1・RPC 1
- **sabotage**: facilitator の選択を network に依らず先頭にする／`sellerProofs` の照合を外す／拒否ホストの追加を外す → 各試験が落ちる

### T7-c — 統合・回復（AC-3〜AC-7、FR-5・FR-6・FR-19）

- **範囲**: `tests/wire/multirail-integration.test.ts`（T7-b の fixture 構成）。製品コードは直さない（直す必要が出たら該当タスクに戻す）
- **完了条件（wire、**Linux**）**:
  - 本番と同じ構成で、Arc → MPP、Arc → x402、Solana → x402、Solana → MPP の静的・動的の購入が `delivered`（AC-1/2 の offline 版）
  - AC-3（各 1 本、結果と回数を書く）: 別の宛先・額・mint・桁・fee payer が Router 向き・transfer 2 つ・不明な program・memo の書き換え・lookup table → `rejected` と facilitator・RPC への要求 0。
    再提出: 別の quote（`nonce_mismatch`、要求 0）・別の route（`route_binding_mismatch`、要求 0）・**同じ quote の並行**（settle は合計 1 回。2 本目は既存の結果）・**再起動後**（settle 1 回のまま）。
    昇格前の同じ credential の再試行は通る（要求はあるが settle は 1 回）
  - AC-4: settle の応答の喪失・crash・形の違う／network の違う／識別子の無い成功応答で `unknown` が耐久的に残り、再起動後に settle が再発しない（要求数）。**両レグの予約が保たれる**（予算の残が減ったまま）。fee payer が変わった後の **process の再起動**で、発行済みの quote が verify で落ちる
  - FR-5・FR-6: 旧い journal（Base Sepolia・Tempo の記録）を読んで新しい記録と混在した identity を保つ／権威の欄（facilitator の kind・表の資産）を変えた再起動で発行済みの quote が `quote_changed`／
    再起動後の予算の合計が復元される／`(network, asset)` の区分が別（Arc の消費が Base Sepolia の予算を減らさない）
  - AC-6: `ownerKey` 無しの status が読めない、結果の保存と再読取が既存どおり
  - 既存の Base Sepolia・Tempo の統合試験が変わらない
- **sabotage**: 予算の鍵から network を外す／再起動後の予約の復元を外す → 各試験が落ちる。**SR-3 の 2 回目のレビュー**（T4-a〜T4-c の実ソース）をこの PR で依頼する

### T8-a — 本番の入口の設定生成（設計 §8。無効のまま）

- **範囲**: `tools/remote-mcp-config.ts`（route・プロファイル・予算・`inboundFacilitators`、`ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` = `false`）
- **完了条件（unit）**: 生成した設定が `KNOWN_NETWORKS` で通る／定数が `false` のとき Arc・Solana の route／プロファイル・facilitator が設定に**出ない**（listing にも出ない）／`true` にしたときだけ出て、予算の区分がある／
  設定に鍵・URL の秘密を埋め込まない
- **sabotage**: 定数を無視して常に出す → 試験が落ちる

### T8-b — 本番の入口の process（設計 §3・§8）

- **範囲**: `tools/remote-router-process.ts`（env `SUBETHA_ARC_RECEIVER_KEY` → `real-seller-proof-capability`、`SUBETHA_SOLANA_RPC_URL`、`startRouter` への注入）。**有効化は 1 つの値 `activation: { arc, solana }`** で、設定生成（T8-a）と能力の注入の**両方**がそれを見る。本番の入口は定数（`false`）を渡す。
  **受け入れ用の起動 `tools/rails-acceptance-run.ts`**（G-3 用）: 同じ生成器と同じ process の入口に `activation` を `true` で渡し、別の journal・公開しない port・本番の env（鍵・facilitator）で起動する。公開の process の定数は触らない
- **完了条件（unit。鍵は乱数）**: `activation` が `true` のとき、env から能力が作られ **route とプロファイルの両方**に束縛される（`address` = 設定の `payTo`、`network` = Arc）／env が無い・鍵の形違い・`payTo` と違う鍵 → 起動しない／
  Solana RPC の URL が拒否ホストと `dependencyUrls` に入る／`activation` が `false` のとき env を読まず、新しい route・プロファイル・facilitator も出ない／鍵の値がログ・エラーに出ない／
  受け入れ用の起動が fixture の構成で: `activation` `true` の設定と能力で起動し、別の journal を使い、公開の process の設定（定数 `false`）を変えない。**SR-3 の 2 回目のレビュー**（証明の境界: T3 と本入口の実ソース）をこの PR で依頼する
- **sabotage**: `payTo` の照合を外す／能力を route だけに束縛する → 試験が落ちる

### T9 — 文書

- `docs/DEPLOY.md` §2c（Arc・Solana の有効化の条件と手順: 鍵の作り方、ATA の作成と rent、`inboundFacilitators`、env、gate の順）、`README.md`・`CLAUDE.md`（英語。`npm run sign` が Arc・Solana でも通ること、
  `wallet:new:solana`、MPP の開示は変えない）、`docs/ENGINEERING.md`（新しい adapter と能力）。設計 §9・§10 の更新（T0-a・T6 の結果）
- **完了条件**: 文書に鍵・URL の秘密・絶対パスが無い（grep）。手順を fixture の構成で 1 度なぞる

### T10 — gate（owner の確認の上で。設計 §8・§10、AC-1・AC-2、U-1・U-4・U-5）

| 段 | 内容 | 条件 |
|---|---|---|
| G-1 | 鍵と口座: Arc の証明専用の受取鍵を作る（ホストの env。Base Sepolia の鍵とは別）。Solana の受取 owner の鍵は**ホストに置かない**（運用者の手元）。ATA を作る（rent 1,488,440 lamports は運用者）。使い捨ての payer に Arc testnet USDC・devnet USDC を faucet で入れる | owner の確認。mainnet の資産は使わない |
| G-2 | 配備（無効のまま）: env（鍵・RPC）を置き、公開の process を再起動。無効なので新しい route・facilitator・起動時の検査は**動かない**——確かめるのは「起動して既存の経路が従来どおり」と、**SSRF 防御 B（egress）の配備の受け入れ**（新しいホスト Circle・x402.org・Solana RPC への egress が許され、それ以外は拒まれる）。rollback の container を 1 つ保つ | owner の確認（配備） |
| G-3 | 受け入れの購入: **T8-b の受け入れ用の起動**（`tools/rails-acceptance-run.ts`。本番の鍵・本番と同じ facilitator・別の journal・公開しない port）で。**最初に**その起動で `/supported`・ATA の起動時の検査が通ることを確かめ（これが本番 env での検査の証拠）、次にAC-1（Arc → Tempo、静的・動的）、AC-2（Solana → Base または Tempo、静的・動的）。各 1 件、使い捨て口座。証拠: Arc は settle の tx が Arc の RPC で `success` かつ受取先の残高の増分、Solana は signature が devnet で confirmed かつ ATA の残高の増分、結果の `proof.onChainFinality` が `not_checked`。U-1（settle の `success` までの時間、`settlement_pending` の有無）・U-4 を記録 | owner の確認（支払いごとに quote を見せる）。`settlement_pending` が出たら設計 §10 U-1 を改訂（`/status` の polling の設計）してから G-4 |
| G-4 | 有効化: `ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` = `true` の PR と配備。CLAUDE.md の route の表を更新 | owner の確認 |
| U-5 | Base Sepolia の `success: false` の写像を揃えるか | owner の決定（急がない） |

## 3. AC との対応

| AC | タスク |
|---|---|
| 1 | T7-c（offline）・T10 G-3（実決済と chain の証拠） |
| 2 | T7-c（offline）・T10 G-3 |
| 3 | T4-a（transaction と封筒）・T7-c（再提出・並行・再起動） |
| 4 | T3・T4-c（応答の形）・T7-c（耐久性・予約・再起動） |
| 5 | 全タスク・T7-c（Linux） |
| 6 | T2・T5・T7-a・T7-c・T8-a・T8-b・T9・T10 G-4（公開の有効化。listing の試験は公開の受け入れではない） |
| 7 | T1・T3・T4-a（行列）・T4-b・T4-c・T5・T7-a・T7-b・T7-c・T8-a・T8-b（各 sabotage） |

## 4. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-06 | `gpt-6-astra`（read-only。第 1 版 `fc8422b`） | **APPROVE WITH CHANGES**（高 3・中 4） |
| 2 | 2026-10-06 | `gpt-6-astra`（read-only・範囲限定。第 2 版 `796ed1b`） | **APPROVE WITH CHANGES**（高 1・中 4・低 1）: G-3 の有効化の仕組みが無い → T8-b に `activation` と受け入れ用の起動。G-2 が無効のまま起動時の検査を求めていた → G-2 は配備と防御 B、検査は G-3 の起動。依存図（T3 と T0-a、T5 ← T3、T7-b ← T6）→ §1。SVM の verify・settle の transport → T4-c。資金・接続の規則（fixture の settle、faucet）と T6 の条件 → §0・T6。T4-c の再起動は adapter の作り直し、process は T7-c。AC-6 に T8・G-4。第 3 版で反映 |

| # | 指摘（第 1 版） | 反映 |
|---|---|---|
| 1 | 本番の入口が能力を注入しなくても T7・T8 が通る | T8-b を分け、route とプロファイルの両方への束縛・欠落・不一致・Solana RPC のホストを完了条件に |
| 2 | SR-2 の transport の受け入れが観測できない。起動時の回数が「購入中に出ない」だけ | T4-b に DNS・HTTP 期限・64 KiB・redirect・禁止アドレス・loopback の否定（Linux）、`/supported` 1・RPC 1 の回数。T3 に transport の条件。G-2 に防御 B の受け入れ |
| 3 | AC-3/AC-7 の検査が不完全（封筒の検査・理由の範囲・再提出の各形・変異の行列・証明の否定・SR-3 の置き場） | T4-a に封筒の検査と変異の行列、T7-c に再提出の各形と回数、T3 に証明の否定、§0 に SR-3 の 2 回のレビューの置き場 |
| 4 | 依存の隠れた前提（T1 と T0-a、T4-a の RPC fixture、T1 の拒否ホスト、T4-b の動的の試験、T6 と T3・T4-c） | §1 を作り直し。最小 RPC fixture を T4-a に、合成の主張を T7-b に、動的の再試行を T7-c に、T6 は adapter の offer を使う。既存 fixture の移行を T1 に |
| 5 | 回復・回帰・実決済の条件が明示より広い | T7-c に両レグの予約・混在 journal・`quote_changed`・予算の復元・`ownerKey`、G-3 に chain の証拠、T3・T4-c に verify → settle 0・`invalidReason` の非転送 |
| 6 | T2 の試験が変更を証明しない、15 秒の購入は 180 秒を証明しない、T7 が大きい | T2 は `assetKeyOf` と `balanceOf` の引数、T7-a は制御した時計、T7 を a/b/c に、T4-b を起動時と adapter に分割 |
| 7 | 「資金は T10 だけ」が faucet と矛盾、接続の許可リストの漏れ、「M3」、G-2〜G-4 の順、意図した変更の列挙 | §0 の資金・接続・既存の変更（3 つ）を書き直し、G-3 は別インスタンス |

## 5. 本書で決めていないこと

- T10 G-3 で `settlement_pending` が出た場合の `/status` の polling の形（設計 §10 U-1。出てから設計する）
- S-3・S-4（送信）のタスクは別紙
