# T7 要件 — 実 EVM 署名能力と Provider A への実決済

- 起案: 2026-09-26 JST。**オーナー承認済み**（「必要なもの全て進めて良い」）。
- 前提: T1–T6 受け入れ済み（HEAD `bd0fbd3`）。既存の要件・設計をやり直さない。
- ラベル: `T7-real-settlement`（**本タスクで初めて実決済が発生する**）

## 1. なぜ必要か

Provider A（`https://provider-a.subethalabs.com`）が公開され ready になった。親が読み取りのみで確認済み:

- `/health` → `market-data-a` / `ready` / `paymentConfigured: true`
- 402 は **v2 `PAYMENT-REQUIRED` ヘッダ**（本 Router の x402 adapter が読む形式と一致）
- `accepts[0]`: `exact` / `eip155:84532` / `10000` base units / USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` /
  payTo `0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1` / `maxTimeoutSeconds: 60`

しかし Router からは到達できない。[src/adapters/outbound/x402.ts:261] が
**「署名しない試験用能力は loopback fixture 以外に向けない」**という安全装置を持つため、
現在唯一存在する能力（`kind: "non-signing-fixture"`）では実 Provider を向けた瞬間に起動が失敗する。

**このガードは正しい。** spy は固定の偽署名を返すので、到達できても「実 Provider に到達した」という
誤った証拠が残るだけになる。したがって**ガードを外すのではなく、実署名能力を実装する**のが本タスク。

## 2. 決済スコープ（B-01 解除の記録。AGENTS.md が要求する項目）

**この範囲を超える送金を行わない。超える必要が生じたら停止して報告する。**

| 項目 | 値 |
|---|---|
| ネットワーク | **Base Sepolia（`eip155:84532`）のみ**。mainnet へは一切送らない |
| 資産 | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` のみ |
| 送金先 | Provider A の `payTo` `0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1` のみ |
| 1 回あたり上限 | **10000 base units（$0.01）**。承認値と完全一致しないものは送らない |
| 累計上限 | **50000 base units（$0.05、= 5 回分）**。budget bucket で機械的に強制する |
| 実行回数 | **検証で最大 5 回**。デモ本番は別途 |
| 実行間隔 | **3 秒以上**（公開 facilitator の nonce 衝突回避。実測で 0ms は 2/20 失敗、3000ms は 0/15） |
| Provider B | **対象外**（改修中のため）。B への送金は本タスクで行わない |

## 3. 満たすべき要件

- **T7-01** 実 EVM 署名能力（`kind: "real-key"` の `EvmSigningCapability`）を用意し、
  `src/main.ts` の既存注入経路で渡せるようにする。ポート側は既に `"real-key"` を想定済み
  （`src/ports/outbound.ts:37,45`）だが、**生成する実装は存在しない**。
  **鍵は env・構成ファイルから読まない**（`docs/design.md:183`）。起動時にコードから注入する形を維持する。
  実鍵を扱うエントリは**製品コードに置かず**、実行者が明示的に起動するものに閉じる。
- **T7-02 （最重要）guarded signer の検証。**
  **調査で判明: guarded signer は既に実装済み**（`src/adapters/outbound/x402.ts:365-399`）。
  `primaryType === "TransferWithAuthorization"`・`domain.chainId`・`domain.verifyingContract`・
  `message.to` / `from` / `value` を `getAddress` 正規化後に照合し、外れれば
  `destination_signing_args_mismatch` を投げて**注入能力を呼ばない**。1 要求 1 回の arming もある。
  **しかしテストが 1 件も無い**（`destination_signing_args_mismatch` /
  `destination_unsupported_asset_transfer_method` / `not_armed` を検索してヒット 0）。
  → 本タスクの中心は**この拒否面にテストを与えること**。
  実鍵も送金も不要で検証でき、**誤った宛先・誤った額への署名を防ぐ最後の砦**なので最優先。
- **T7-03** SDK 側の支出ガードを併用する（`setSpendControls` で承認額そのものに縛る。既定の USD キャップに依存しない）。
- **T7-04** 1 要求につき **payload 生成 1 回・送信 1 回**。`wrapFetchWithPayment` は使わない
  （402 受信後の自動再支払いを避ける）。**自動再試行・自動再購入をしない**（D-01 を解除しない）。
- **T7-05** 応答の解釈: `success === true` かつ `network` が承認済み値、`transaction` が非空、
  レシートが `payer` を名乗るなら注入署名者と一致して初めて `paid`。**HTTP 200 だけでは支払いの証拠にしない。**
  本文を取得できなければ「支払い済み・データ未取得」として終端し**再送しない**。
- **T7-06** 秘密を出さない。**秘密鍵・ニーモニックをログ・応答・journal・コミットに出さない。**
  例外メッセージに混ざらないことを確認する。
- **T7-07** 実決済の証拠を残す: tx hash・ブロック・実際に動いた額・取得したデータを
  `.claude_workflow/local/` に不変ファイルとして保存する（**秘密は含めない**）。
- **T7-08** 証拠ラベルを偽らない。実能力で走った場合は `real`、spy なら `T2-fixture-nopay` のまま。
  MCP の `evidence` も実態と一致させる（T6-07 の仕組みをそのまま使う）。
- **T7-09** 既存テストを壊さない（現在 177/177・15 ファイル）。
  **実決済テストは既定の `npm run test` に含めない**（CI や不用意な実行で送金が起きないようにする）。
  明示的なフラグ／別コマンドでのみ実行する。
- **T7-10** 残高不足・facilitator エラー・nonce 衝突では**停止して報告**する。自動リトライしない。

## 4. 未確定（オーナー対応が必要。これが無いと実行できない）

- **U-T7-1 使い捨て鍵。** 以下のいずれか:
  - (a) 既存の `.env.testnet.local`（別 worktree）の**読み取り許可**。
    親は権限分類器に拒否されており、**迂回しない**。Bash permission rule の追加が必要。
  - (b) 親が新規に使い捨て鍵を生成し、**アドレスをオーナーに伝えてオーナーが資金供給**する
    （親は faucet を叩かない）。
  - どちらでも良いが、**(b) の方が既存資産に触れないぶん安全**。
- **U-T7-2 受信レグ（SubEtha）の扱い。** 本タスクは**送信レグ A の実決済のみ**を対象とし、
  受信レグは合成 facilitator（無課金）のままにする。
  受信レグも実決済にするなら U-01/U-02（SubEtha 実ランタイム）が別途必要。

## 5. 境界（T7 で解除しないもの）

- **Provider B（MPP / Tempo）への実決済**（改修中のため対象外）。
- 受信レグ（SubEtha）の実決済（U-01/U-02 未確定）。
- push・リモート作成・公開・デプロイ（B-04）。
- chat worktree の編集（AGENTS.md）。
- mainnet への送金（**一切行わない**）。faucet（オーナーが行う）。
- finality（D-05）。P3/P4/P5（DEFER）。

## 6. 受け入れ条件

- guarded signer の**拒否面**が単体テストで確認できる（承認値と違う `to`/`value`/`chainId`/
  `primaryType` で**署名を呼ばない**）。ここは無課金で検証できるので必ずテストする。
- 実決済 1 回が成立し、tx hash と取得データが証拠として残る。
- 親のフルチェック（既存 177 + 新規）と独立レビュー LGTM。
- README に到達範囲と**残る未達**（Provider B・受信レグ・finality・AC-7）を明記する。
