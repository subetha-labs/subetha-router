# `subetha-exact` の式の価格：L1 の手数料に上限を設ける 要件・設計 v1

親：[exact-pricing-requirements.md](exact-pricing-requirements.md)（要件 v3）、[exact-pricing-design.md](exact-pricing-design.md)、[exact-costs-reader-design.md](exact-costs-reader-design.md)。
オーナーの選択（2026-11-26）：案 A（L1 の上限を Router 側に設ける）と、§3 の値。式の価格の有効化（`RAILS_ACTIVATION.subethaExact.formulaPricing`）はこの変更に含めない。

## 1. 背景（2026-11-26 03:4x Z の本番の `/costs`、block 63,711,333）

- `summary.l1FeeMaxWei` = 3,495,157,411,208（tx `0xff3095bd…`、11-25 の 1 件）。ほかの item の `l1Fee` は 1,408、1,539、43,030,124,044。
- 式は `l1 = max(l1FeeMaxWei, l1Floor)` を使うので、この 1 件が新しい 100 tx に押し出されるまで価格を決める（今は 8 tx）。
- 今の値（`withdrawCost` 18,000、`l1FloorWei` 2,000）と ETH 1,700 USD では、settle 11,310、合計 **24,145**。`maxSettle` 8,000 と `maxAmount` 20,000 を越えるので、有効にすると zUSDC の offer がすべて断られる。
- `allocatedP90Wei` = 982,828,124,044（全 11 件の p90）。外れ値は p90 にまだ入っていない。

## 2. 要件

- **L-1（上限の欄）** route の `pricing` に任意の欄 `l1CapWei`（10 進の文字列、1 以上 10^15 以下）を足す。`l1FloorWei` 以上であること。範囲外・形の違い・下限より小さい、は起動しない（既存の R2 と同じ固定文で、値は出さない）。
- **L-2（式）** `l1 = min( max(l1FeeMaxWei, l1FloorWei), l1CapWei )`。`l1CapWei` が無ければ今の式（上限なし）。ほかの項（`p90`、`baseFeePerGas`、`tip`、`overheadPpm`、`withdraw`、`take`、0.35%）は変えない。
  上限は L1 の項だけにかける。`p90` は上限で切らない（外れ値が成功の 10% を越えて p90 に入れば、価格は上がり、上限を越えれば断る。今と同じ）。
- **L-3（指紋）** `l1CapWei` は支払いの条件として route の指紋に入る（`pricingTermsOf` は `maxPerDay`・`ethPriceMaxAgeDays` 以外の全欄を入れる）。欄が無い route の指紋と journal の行は、変更前と byte 一致。
- **L-4（hosted の値）** `HOSTED_EXACT_PRICING` を `withdrawCost` 19,000、`l1FloorWei` 100,000,000,000、`l1CapWei` 500,000,000,000 にする。ほかは変えない。`formulaPricing` は付けないので、本番の子の設定は今と byte 一致（固定の 12,000 のまま）。
- **L-5（損の扱い）** 実際の L1 の手数料が上限を越えた分は、Router の持ち出しになる（11-25 の 1 件なら約 3,900 base units、ETH 1,700 USD）。式の価格は黒字の保証ではない（親の要件 §3 と同じ）。買い手に見える内訳（`settle` など）の形は変えない。
- **L-6（読み取り）** `/costs` の読み取り・検査（exact-costs-reader-design.md）は変えない。

## 3. 値の根拠

| 値 | 今 | 新 | 根拠 |
|---|---|---|---|
| `withdrawCost` | 18,000 | 19,000 | 引き出しの実測 17,831、18,432、18,784 の最大を越える |
| `l1FloorWei` | 2,000 | 1×10¹¹ | 普段の値（4.3×10¹⁰）の 2 倍強。2,000 は効かない |
| `l1CapWei` | なし | 5×10¹¹ | 普段の値の約 12 倍。外れ値（3.5×10¹²）は Router がかぶる |

ETH 1,700 USD（有効化の時に env で設定。この変更の外）と §1 の `/costs` で：settle 3,672、withdraw 2,375、take 500、合計 **16,606**（`maxSettle`・`maxAmount` の中）。`l1` がふだんの 4.3×10¹⁰ なら下限 1×10¹¹ が効いて settle 2,652、合計 15,582。

## 4. 設計

- `src/shared/exact-pricing.ts`：`ExactPricingConfig` に `readonly l1CapWei?: string`。`parseExactPricing` は欄があれば範囲（1〜10^15）と `l1CapWei ≥ l1FloorWei` を見る（文は `l1CapWei must be …`、値は出さない）。`computeExactPrice` で `l1` を上限で切る。
- `priceConsistent`・`pricingMatches` は内訳の合計だけを見るので変えない（`settle` は記録の値）。
- `tools/remote-mcp-config.ts`：L-4 の値。
- 文書：親の要件 §3.1 の表と §3 の式の下に、この文書への 1 行。`docs/DEPLOY.md` の式の価格の節に、値を変えた理由の 2 行と、b-50749f9 の deploy の記録（release の再試行）。有効化の記録は有効化の時に書く。

## 5. 受け入れ

- **AC-1** 上限の効き方：`l1FeeMax` が上限より大きい／等しい／小さい、下限が効く場合、欄が無い場合（今の値と同じ）。§1 の `/costs` の値と ETH 1,700 USD で合計 16,606、新しい値から上限だけ外すと 24,270（`pricing_over_limit`。今の値なら 24,145）。
- **AC-2** 設定：`l1CapWei` の両端（`l1FloorWei` と同じ値、10^15）と外（0、10^15 + 1、数値、`"01"`、下限より 1 小さい）。文に値が出ない。
- **AC-3** 指紋：`l1CapWei` を足す・変える・外すと変わり、変更前の quote では払えない。`l1CapWei` の無い**式の** route の指紋と journal の行は、変更前の main で取った値と byte 一致（新しい golden）。
- **AC-3b** p90 は切らない：p90 が上限で切った 1 件の見積もりより大きい時は p90 を使い、`maxSettle` を越えれば `pricing_over_limit`。p90 を切ると落ちること。
- **AC-4** hosted：`formulaPricing` が無い時の生成される設定が変わらない（既存の試験）。有効な時の `pricing` が新しい値。
- 守っている code を壊して落ちることを確かめる（上限の `min` を外す、`≥ l1FloorWei` の検査を外す）。全体の試験は Linux。
