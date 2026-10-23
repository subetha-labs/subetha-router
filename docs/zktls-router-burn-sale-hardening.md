# 秘匿購入 × SubEtha V2 burn-sale の安全化（増分 v1.4、設計 v2、2026-10-23）

対象: `docs/zktls-router-v2-inbound.md` の受信（`sourceRail: "subetha"`）で、**払った後に戻らない**場面の事故を減らす 3 点。
2 件の結合（§11・§12）で実際に手で補った箇所だけを扱う。Router の決済・発行の順序と契約（FR-V*、FR-P*）は変えない。

## 1. 背景（結合で起きたこと）
- 受信の burn は Payer が Router に credential を渡す**前**に動く。Router の拒否（期限切れ・facilitator の rejected・容量）で戻らない。
- `--recover --chain` は受信を `skipped: protocol` で読まない（EIP-3009 ではない）。2 件とも、受入側が Sepolia の receipt を curl で別に読んで照合した。
- `--approve --burn-tx-hash` は渡された hash を確かめずに purchase へ進む。別の tx・未確定の tx でも、`/verify` で落ちるまで分からない（その時点で burn が別にあれば戻らない）。
- 承認期限は `min(now + router.approvalTtlMs, challenge の expiresAt)`。既定の運用値 600 s は人手の受け渡し（payFirst を渡す → 3 tx → hash を返す）には短く、2 件とも 1,200 s に設定を変えた。期限の後に mine された burn は Router が `approval_expired` で拒み、戻らない。

## 2. 要件
- **FR-H1 承認期限（burn-sale だけ）**: `private.burnSaleApprovalTtlMs`（任意）。`sourceRail: "subetha"` のプロファイルの秘匿 quote の承認期限は `min(issuedAt + burnSaleApprovalTtlMs, challenge の expiresAt)`。それ以外（x402 受信の秘匿 quote、静的 route、通常の動的 quote）は `router.approvalTtlMs` のまま（**挙動不変**）。
  - 検査の表（`MAX = MAX_QUOTE_LIFETIME_MS` = 1 日、`cap = min(retentionMs, MAX)`）:

    | 設定 | 明示の値 | 省略 |
    |---|---|---|
    | subetha のプロファイルが `private.profiles` に無い | 安全な整数で [60,000, MAX] でなければ `ConfigError`（`retentionMs` とは比べない） | 1,200,000（使われない） |
    | ある | 上と同じ検査に加えて `> cap` なら `ConfigError` | `min(1,200,000, cap)` |
    | ある、かつ `cap < 60,000` | `ConfigError` | `ConfigError`（`retentionMs` が短すぎて burn-sale の承認に足りない） |

    既存の設定はこの欄を持たないので、x402 だけの設定は今と同じく起動する。
  - **新しく発行する quote だけ**に効く。発行済みの quote は期限を ledger に固定して持つので、設定の変更（増減）で期限は変わらず、`quote_changed` にもならない（`privateAuthoritativeTermsOf` に入れない）。
- **FR-H2 払う期限の表示**: payer 道具の quote 出力の `payFirst` に `payBy`（ISO 8601、= 承認期限 − `BURN_PAY_MARGIN_MS` 180,000）。stdout と log の両方。quote の時点で `payBy` が過ぎていれば `payBy: null` と「払わない（期限が短すぎる）」注記。
- **FR-H3 承認前の burn 照合**: `--approve --burn-tx-hash` は、既存の拒否（引数・quote.json・期限・scheme・burn 必須）の後、**latch の前**に Sepolia の receipt を読む。判定は **V2 facilitator と同じ選び方**:
  1. `eth_chainId` が offer の network の chain id と一致（違えば `wrong_chain`）
  2. `eth_getTransactionReceipt`: `null` → `not_found`。形の検査（**fail closed**: どれかが違えば `unreadable`）: `transactionHash` が要求した hash と一致（大小文字無視）、`status` が `"0x1"` か `"0x0"`、`blockNumber` が hex 数、`blockHash` が 32 byte hex、`logs` が配列で各 log の `address`（20 byte hex）・`topics`（32 byte hex の配列）・`data`（hex）・`logIndex`（hex 数）
  3. 同じ番号の block を読み直し、hash が一致（違えば `reorged`、`null`・形違いは `unreadable`）。`reverted` もこの検査の後にだけ出す
  4. `status = "0x0"` → `reverted`
  5. log の順に、**address = offer の `asset`（大小文字無視）かつ topic0 = Transfer（`0xddf252ad…`）かつ topics の数が 3 かつ data が 32 byte** のもののうち、`to`（topics[2] の下位 20 byte）= offer の `payTo`（大小文字無視）の**最初の 1 つ**を選ぶ。無ければ `mismatch`（`no_transfer_to_pay_to`）。その `value`（BigInt）が offer の `amount`（BigInt）と**完全一致**なら `transferred`（その log の `logIndex` を記録）、違えば `mismatch`（`amount_differs`）。先の log を越えて額の一致を探さない・合計しない
  6. 例外・timeout・JSON-RPC error → `rpc_unavailable`
  - `from` と receipt の `to` は束縛しない（quote に権威ある payer の address が無い。receipt の `to` は呼んだ contract で helper のこともある）。
  - `transferred` 以外は approve の段で拒否（latch・credential・purchase は起きない。`refusals.json`）。**拒否文はすべて「この結果だけを根拠に払い直さない」を含み、その禁止は `payBy` と quote の期限の後も続く**（同じ注文の transfer が別にある・後で mine され得る）。結論ごとの案内:
    - `not_found`: 未 mine か hash の誤り。`payBy` までに同じコマンドを再実行。払い直さない
    - `reverted`: **この tx** は何も送っていない（approve/wrap の hash を渡した、別の tx 等もあり得る）。この注文に向けた transfer を V2 担当・explorer で**照合してから**判断する。この結果は払い直しの許可ではない
    - `mismatch`: 選んだ log の宛先・額がこの quote と違う（`amount_differs` は正しい burn address に違う額が届いている）。照合してから。払い直さない
    - `reorged` / `unreadable` / `wrong_chain` / `rpc_unavailable`: 読めなかった。再実行（`--sepolia-rpc-url` で RPC を変えられる）。照合を飛ばすには `--burn-precheck off`（証跡に `skipped_by_operator`）。払い直さない
  - 照合は非同期なので、**latch の直前にもう一度承認期限を確かめる**（照合中に過ぎたら拒否。burn 付きの期限切れの文 = 払い直さない・照合）。
  - 通ったら証跡 `evidence.burn = { verdict: "transferred", txRef, block, blockHash, logIndex, readAt, rpcHost, at: "approve" }`。
- **FR-H4 回復時の burn 読取**: `--recover --chain` は、再開点に `progress.burnTxHash` がある subetha の購入で FR-H3 と同じ読取をし、`evidence.burn` に**最新の結論**を書く（`at: "recover"`。前の結論は `recovery-log.json` に）。**受信の決済のゲート（`gates.inbound_settlement` の `settled`・`uncertain`・`chain`）は変えない**: burn の receipt は資金が burn address に届いた観測であって、facilitator の受理・Router の `source_settled`・受信 identity の確立ではない（それは status の `txRef` が決める。既存）。`evidence.burn` は観測の時点の canonical であり finality ではない。Base Sepolia の送信レグの読取（既存）は変えない。
- **FR-H5 出力の方針**: `consoleProjectionOf` は `burn` を `{ verdict, block }` に**置き換える**（全体を spread しない）。新しい log の行は結論だけ（hash・blockHash・RPC URL を出さない）。既存の delivered の行（`inboundTx=`）は変えない。RPC は host だけ証跡に。
- **FR-H6 RPC**: `--sepolia-rpc-url` > env `SUBETHA_SEPOLIA_RPC_URL` > 既定 `https://ethereum-sepolia-rpc.publicnode.com`。20 s の timeout、`fetch`（操作者が選ぶ URL。Router の transport 規則の対象外。既存の Base Sepolia の reader と同じ）。

## 3. 設計
- `tools/private-payer.ts`:
  - `BurnReader { chainId(); receipt(txHash) → unknown; blockByNumber(n) → unknown }`（生の JSON を返し、形の検査は判定側が持つ）と `rpcBurnReader(url)`。試験は差し替え（`burnReaderForTest`）。
  - `selectBurnTransfer(logs, expect)`（純粋。FR-H3 の 5）と `readBurn(reader, rpcHost, expect) → BurnEvidence`（1〜6）。
  - approve: 既存の拒否の後に `readBurn`（`--burn-precheck off` なら読まない）→ 期限の再確認 → latch。
  - quote: `payFirstOf` に `payBy`。
  - recover: `options.chain` があり、再開点の offer が subetha で `burnTxHash` があれば `readBurn` → `evidence.burn` を置き換え、前の値は recovery-log へ。
- `src/config.ts`: `PrivateConfig.burnSaleApprovalTtlMs`（FR-H1 の既定・上限・検査の条件）。
- `src/core/private.ts`（1 行）: 承認期限の TTL を `profile.sourceRail === "subetha" ? config.private.burnSaleApprovalTtlMs : config.approvalTtlMs`。

## 4. 試験
- 単体（lab 不要・ネットワーク不要）:
  - `selectBurnTransfer`: 一致、先の log が別の宛先で後が一致（通る）、**先の log が同じ宛先で額違い・後が一致（`amount_differs`）**、別 token の log だけ（`no_transfer_to_pay_to`）、Transfer 以外の topic、topics の数違い・data 長違いは選ばない、大小文字、`logIndex` が選んだ log のもの。
  - `readBurn`: `not_found`、`reverted`（block の照合の後）、`reorged`、`wrong_chain`、`unreadable`（hash 不一致・status 形違い・blockHash 形違い・logs の形違い・block が null）、`rpc_unavailable`（例外・JSON-RPC error）。
  - approve: 結論ごとの拒否で latch 無し・再開点と証跡のバイト列不変・文に「払い直さない」・`reverted` の文が払い直しを許さない、`transferred` で latch → `evidence.burn`、`--burn-precheck off`、照合中に期限切れ → 拒否、RPC の優先順位。
  - `payFirst.payBy`（通常・期限が短すぎる）。
  - recover: `transferred` でもゲートは不変（`uncertain` は残る）、繰り返しの回復で `evidence.burn` が最新になり前の値が recovery-log に残る、後の読取が `reorged`/`unreadable` になる場合、Router が読めない回復。
  - 出力: stdout（quote・approve の成功と拒否・recover・bypass）と stderr に burn の tx hash・blockHash・RPC URL が無い（既存の delivered の行を除く）。
  - CLI: `--burn-precheck` の値検査、`--sepolia-rpc-url` の形。
- config: 省略時の既定（subetha あり / なし）、明示の範囲外、`retentionMs` が 1,200,000 未満の既存 x402 だけの設定が起動する、subetha ありで上限に切られる。
- private-core: subetha プロファイルの期限が `burnSaleApprovalTtlMs`、x402 プロファイルは `approvalTtlMs`、challenge の `expiresAt` で上限、**旧 10 分を過ぎた purchase が通る**（clock の差し替え）、TTL を増減した再起動で既存 quote の期限が不変かつ `quote_changed` にならない、期限内でも容量の拒否は settle・発行無し（既存の経路）。**quote の寿命**（private-result の保持とは別）: challenge が 1 日を超えても TTL = MAX の quote は ledger に入る（期限 = 1 日）、期限前の再起動で ledger から読み戻せる、期限の後は満了して未処理の quote の数から外れ、受付の余地が戻る。
- lab wire（`--burn-tx-hash` の場合）: 偽の `BurnReader` で `transferred` → delivered、`not_found` → approve 拒否・settle 0。
- 既存の試験（x402 受信の payer、第三者 Provider、V2 受信）は不変。

## 4.1 設計 v1 → v2（Codex 設計レビュー 1 回目、REJECT）
| 指摘 | 対応 |
|---|---|
| 1 High: 額の一致する別の log で通り、facilitator と食い違う | facilitator と同じ「宛先が一致する最初の Transfer」を選び、その額を BigInt で完全一致。先を探さない・合計しない。選んだ log の `logIndex`。`from`・receipt の `to` は束縛しない（理由を明記） |
| 2 High: `reverted` が払い直しを許す | 許さない（この tx が何も送っていないだけ）。照合を要求。`reverted` は block の照合の後・`status` は `0x0` だけ。全ての未解決の結論に「払い直さない」、期限の後も続く。`mismatch` の文を訂正 |
| 3 High: 回復で burn の観測を決済の確立と混同 | ゲートを変えない。`evidence.burn` は観測として別に持つ。finality ではないと明記。回復の繰り返し・後の reorg/読めない場合を試験 |
| 4 Medium: 範囲が quote ledger の上限を超える、既存設定を落とす | 上限 `min(retentionMs, MAX_QUOTE_LIFETIME_MS)`、省略時は上限で切る、検査は subetha があるときだけ |
| 5 Medium: 互換と寿命の試験 | 新規 quote だけに効く・権威に入れないと明記、TTL 増減の再起動、旧 10 分超の purchase、照合中の期限切れ、latch 前の期限の再確認 |
| 6 Medium: RPC の形の検査・出力の境界 | fail closed の形の検査（hash 一致・status・block・log の各欄）、`unreadable`、stdout と stderr の試験、`consoleProjectionOf` は `burn` を要約に置き換え |

## 5. 変えないもの
- Router の受信・発行の順序、`/verify → /settle`、受信 identity、durable `unknown`、返金しない方針。
- x402 受信の payer の経路、`--recover --chain` の Base Sepolia の判定。
- hosted の設定生成（`private` 節は無いまま）。

## 4.2 設計 v2 → v2.1（Codex 設計レビュー 2 回目、APPROVE WITH CHANGES）
| 指摘 | 対応 |
|---|---|
| 1 Medium: FR-H1 の検査の条件が矛盾、省略時の既定が下限を割り得る | 検査の表に一本化（明示は常に [60,000, 1 日]、subetha があれば `cap` も、`cap < 60,000` は省略でも拒否）。境界ごとに試験 |
| 2 Medium: quote の寿命の試験が足りない | 1 日を超える challenge、ledger への登録・期限前の再起動・満了で未処理数から外れ受付が戻る、を private-core に。latch の直前の期限の再確認は新しい `now()` で、`--burn-precheck off` でも行う |
