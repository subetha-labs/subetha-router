# 動的上流 URL — MPP 送信の手数料を quote 時のガス代で決める（設計）

> 2026-10-06、第 1 版。owner の方針（2026-10-06）: 「運営がガス代を負担するリスクは構造として排除する。上流の手数料が高騰する場合は、
> それに応じた価格を下流（呼び出し側）に提示する」。前提は `dynamic-upstream-design.md`（以下「本設計」）§3.3・§6.6・§11 と、
> G-1 で入れた条件 `fee.min >= maxFee`（PR #30）。MPP 送信のプロファイルを本番で有効にする前提（`DEPLOY.md` §2b の条件 6）の一部。

## 0. 一枚で

- 今: MPP 送信の手数料は**定額**（`fee.min >= maxFee` を設定で固定。本番は 5,000 = `maxFee`）。平時のガス代は 29〜478 なので呼び出し側が払いすぎ、
  高騰時は `maxFee` で支払いが止まる。
- 変更: quote の時点で**その送金のガス代を見積もり**、`maxFee` と手数料を quote ごとに決める。平時は安く、高騰時は高く提示し、天井を超えたら quote を出さない。
- 保つもの: 「呼び出し側が先に払う手数料 ≥ Router が署名する transaction の手数料の上限」を **quote ごとに**保つ（構造は変えず、値を動的にする）。
- 変えないもの: 署名の境界（§3.3 (ii)）は「quote が決めた `maxFee`」を使うだけで、検査の中身は同じ。x402 送信のプロファイルは対象外（Router にガス代がかからない）。

## 1. 見積り（quote の手順に足す段）

MPP 送信のプロファイルで offer を選んだ直後（§2.3 の後、受信 offer を発行する前）に、送信 adapter の**動的経路**が RPC を読む。

```
estimate = adapter.estimateFee(profileId, offer)      // { gas, maxFeePerGas, bound: ceil(gas × maxFeePerGas / 10^12) }
```

- 見積もる transaction は**実際に署名するものと同じ形**: `transferWithMemo(offer.payTo, offer.amount, memo)` を 1 call、`feeToken = feeAsset`、
  expiring nonce。memo は quote 時には無い（challenge の id から SDK が作る）ので、同じ長さのダミー（32 バイト）を入れる。ガス量は memo の値に依らない
  （実測: 46,683 で一定。`dynamic-upstream-design.md` §3.3 T0-b）
- 読み方は署名時と同じ経路: 能力の client を guarded RPC transport（動的用。loopback 不可・DNS 期限・門の `admit`）に乗せ直し、viem の
  `prepareTransactionRequest`（Tempo chain の `eth_fillTransaction`、無ければ `eth_estimateGas` と手数料の見積り）で `gas`・`maxFeePerGas` を埋める。
  **署名はしない**（account は address だけの facade。`signTransaction` を持たない）。送金系のメソッドは T9 の guard と同じ規則で拒否する
- RPC の期限: 1 回 3 秒以下（`estimateRpcTimeoutMs`）、合計 6 秒（`estimateRpcBudgetMs`）、再試行なし。quote 全体の最悪は「上流の読取 5 秒＋見積り 6 秒＋1 回 3 秒」= 14 秒。
  client の `quoteUrl` の期限を 30 秒にする（今は 10 秒）
- 見積りに失敗したら quote は不成立（`quote_failed`、理由 `fee_estimate_unavailable`）。**定額に落とさない**（落とすと高騰時に負担が運営に戻る）
- 1 件の quote で出る RPC の回数を試験で固定する（fixture では `eth_fillTransaction` 非対応 → `eth_getBlockByNumber`・`eth_maxPriorityFeePerGas`・`eth_estimateGas` の 3 回。
  対応ノードでは `eth_fillTransaction` の 1 回）

## 2. 値の決め方

```
maxFee     = ceil(estimate.bound × feeMargin / 10000)        // feeMargin はプロファイルの欄（bps。既定 20000 = 2 倍）
if maxFee > destination.maxFee → quote 不成立（quote_failed, fee_too_high）   // destination.maxFee は「天井」になる
fee        = max(fee.min, fee.flat + ceil(converted × fee.bps / 10000), maxFee)
total      = converted + fee
```

- `destination.maxFee` の意味が「署名時の上限」から「**quote が決められる上限の天井**」に変わる。署名時の上限は quote が決めた `maxFee`
- 手数料の規則（`fee`）は運営の取り分として残る。`fee.min` は 0 でもよい（ガス代は `maxFee` が賄う）。G-1 の条件 `fee.min >= destination.maxFee` は
  **この段に置き換える**: 保つ性質は同じ（手数料 ≥ 署名時の上限）で、設定ではなく quote ごとの計算で保証する。設定の検査は `feeAsset` = 送信資産・桁が同じ、を残す
- 本番の値の案: `feeMargin 20000`（2 倍）、`destination.maxFee`（天井）50,000（0.05。実測の最大の約 100 倍。これを超える単価では断る）、`fee` は `flat 1000` に戻す
  （x402 送信と同じ運営の取り分）。平時の手数料は `max(1000, 29×2=58)` = 1,000、単価が実測の最大なら `max(1000, 478×2)` = 1,000 で、1,000 を超えるのは
  単価が実測の 2 倍超のとき

## 3. 記録と署名

- quote の記録（§2.4）の `pricing` に `maxFee` を足す（MPP 送信のときだけ。`^(0|[1-9][0-9]{0,29})$`）。控え → 昇格で journal にそのまま写る
- 予約（§6.4）の手数料の区分は `pricing.maxFee`（プロファイルの天井ではなく）
- quote 時の 1 件あたりの上限の検査（§6.6）も `pricing.maxFee` で
- purchase: core は `pay` に `maxFee: pricing.maxFee` を渡す（`PayRequest.maxFee?`）。adapter の署名の境界は `min(request.maxFee, destination.maxFee)` を上限にする
  （quote の値が天井を超えていたら記録が壊れている。天井で抑える）。`maxFee` の無い `PayRequest`（静的・x402）は従来どおり
- 残高の事前確認（§6.6）の手数料の分も `pricing.maxFee`

## 4. 変えないこと・限界

- 署名の境界・送信の境界の検査の中身（T9）は変えない。変わるのは上限の値の出所だけ
- quote と purchase の間（最大 10 分）に単価がさらに上がれば、署名前の検査で止まる（`destination_rejected`）。その場合、x402 受信なら呼び出し側の資金は動いていない。
  MPP 受信なら動いている（本設計 §6.3 の既存の性質。`disclosures.routerMayRejectAfterFundsMoved` に `fee_too_high` を足す）
- 「チェーンが実際に請求する額が署名時の上限以下」という Tempo 側の前提（本設計 §3.3 T0-b）はこのスライスでも変わらない。MPP 送信のプロファイルを本番で
  有効にする条件 6 は、この実装の後も「前提の確認」が要る
- RPC のホストへの接続は quote ごとに増える（最大 3 回）。宛先ホストの門は上流のホストにだけ掛かるが、RPC は guarded transport のアドレスの枠と quote の
  頻度の上限（10 件／分）で抑えられる。RPC の負荷が問題になるなら、見積りを短時間キャッシュする（このスライスでは入れない）

## 5. 変更するファイル（見込み）

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `DynamicProfile.feeMargin?`（bps、既定 20000、1 以上）。`fee.min >= maxFee` の検査を外し、`feeAsset`・桁の検査は残す |
| `src/ports/outbound.ts` | `OutboundRail.estimateFee?(profileId, offer, target)`、`PayRequest.maxFee?` |
| `src/adapters/outbound/mpp-dynamic.ts` | `estimateFee`（署名しない facade・読取だけの guard・期限）、`pay` が `request.maxFee` を上限に使う |
| `src/adapters/outbound/mpp.ts`・`src/main.ts` | `estimateFee` の転送（`railByRoute`） |
| `src/core/dynamic.ts` | quote の手順に見積りを足す。`priceOf(profile, amount, maxFee?)`、`reservationOf`・`perPurchaseLimitOf`・`fundsAvailable` が `pricing.maxFee` を使う、`pay` に渡す |
| `src/core/store.ts` | `pricing.maxFee` の復元 |
| `src/http/projection.ts`・`src/client`・`src/mcp` | `pricing.maxFee` の表示、`disclosures` の理由に `fee_too_high`、client の `quoteUrl` の期限 30 秒 |
| `tools/remote-mcp-config.ts` | MPP 送信のプロファイル: `feeMargin 20000`、天井 50,000、`fee` を 1,000 に（登録は引き続き無効） |
| 試験 | unit（config・priceOf・core の順序と RPC 0 の経路）、wire（adapter の見積り: RPC の回数・値・失敗・期限・送金系メソッドの拒否・署名器が呼ばれない）、統合（fixture の単価を変えて `maxFee`・手数料が動く、天井超えで断る、署名前の検査が quote の `maxFee` を使う） |

## 6. 独立レビューの記録

| # | 日付 | レビュア | 結果 |
|---|---|---|---|
