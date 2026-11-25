# `subetha-exact`：上乗せを費用の式で決める 設計・タスク v2

2026-11-24。要件は [exact-pricing-requirements.md](exact-pricing-requirements.md)（v3）。オーナーの決定（2026-11-24）：D-1〜D-5 はおすすめ、§3.1 の値は案のとおり、設計から PR まで続ける。本番は無効のまま。
v1 は Codex（`gpt-6-astra`、CLI）の独立レビューで REVISE（MUST 2、SHOULD 2）。v2 は全件を反映した：件数は**枠を予約した時刻の日**に数える（日またぎの二重の検査を無くした）、端数は記録せず計算する、`issuedAtMs` を行の時刻に拘束する、発行前と発行後の検査を分ける。

## 1. 部品

| 部品 | 場所 | 役目 |
|---|---|---|
| 式と検査（純粋） | `src/shared/exact-pricing.ts` | 設定の型と検査、`computeExactPrice`、記録の検査 `pricingMatches` |
| 費用の読み取り | `src/adapters/inbound/settle-costs.ts` | `GET {settle 先}/costs?n=20`。検査・使い回し・1 つにまとめる |
| 価格の供給 | 合成（`src/main.ts`）が作る `ExactPricing`（port は `src/ports/exact-pricing.ts`） | 費用と ETH の価格から、route と上流の額に対する内訳か、固定の理由を返す |
| core | `src/core/orchestrator.ts` | offer の発行の前に 1 回呼ぶ。件数、照合、記録、再開の検査 |

core は wei も ETH の価格も token も知らない。受け取るのは base units の内訳だけ。

## 2. 設定

route に任意の `pricing` を足す（`sourceRail: "subetha-exact"` だけ）。欄は全て必須、知らない欄は拒む。

```
pricing: { kind: "settle-cost-v1", factorBps, take, withdrawCost, withdrawBatch, tipWei, l1FloorWei, maxSettle, maxAmount, maxPerDay, ethPriceMaxAgeDays }
```

額と wei は 10 進の文字列、ほかは安全な整数。範囲は要件 §3.1（`ethPriceMaxAgeDays` は 1〜30）。

- `source.amount` は `maxAmount` と同じ値（一覧に出る額 = 上限。D-2）。`source` は Base Sepolia の zUSDC（6 桁）。
- `offerCap` が必須。送信は `rail: "x402"`・`scheme: "exact"`・`eip155:84532`・Base Sepolia USDC（6 桁）。違えば `ConfigError`。
- real mode：settle 先の token のファイルが無ければ `ConfigError`。予算に source の区分があり `maxPerPurchase ≥ maxAmount`。
- 指紋 `authoritativeTermsOf`：`pricing` のある route だけ、`pricing`（`maxPerDay`・`ethPriceMaxAgeDays` を除く）を足す。無い route は byte 一致。
- env：`ROUTER_SUBETHA_EXACT_ETH_PRICE`、`ROUTER_SUBETHA_EXACT_ETH_PRICE_AT`。起動では検査せず、価格を求める時に要件 §3.1 の規則で判定する（使えなければ `pricing_unavailable`）。式の route が無ければ読まない。

## 3. 費用の読み取り

**2026-11-25 に [exact-costs-reader-design.md](exact-costs-reader-design.md) が置き換えた**（`l1` の元、`n`、受付の確認、覚え方）。下は置き換える前の記録。

- transport は adapter と同じ guarded transport。header は `Authorization` だけ。redirect 拒否、256 KiB、3 秒（`n` は tx の数で、まとめ送りは 1 tx に 20 件まで。20 tx なら 400 item・約 130 KB）。再試行なし。
- 応答の検査は要件 R4。`l1` は、`l1Fee` が 10 進の文字列の item の最大（item の数は 500 まで。越えたら使えない）。
- 読めた値は 60 秒使い回す。進行中の読み取りは共有する。失敗したら 10 秒は読みに行かない（429 は `Retry-After` の秒数、1〜300 の範囲、無ければ 10 秒）。失敗の間は、読んだ時刻から 10 分までの前の値を使う。
- 「読んだ時刻」は要求を始めた時刻。生の本文、token、URL は残さない。

## 4. 発行（`issueQuote`）

1. 上流の offer を選ぶ（今のまま）。式の route では、額が `^[1-9][0-9]{0,29}$` でなければ `quote_failed`。
2. `exactPricing.price(route, upstreamAmount)`。失敗は `source_offer_unavailable`、理由は `pricing_unavailable`・`pricing_over_limit` の 2 つだけ。port が無い・例外も `pricing_unavailable`。
3. core が内訳を `priceConsistent`（§7 の (a)。合計・`share`・`upstream`・`maxSettle`・`maxAmount`）で検査し直す。違えば `pricing_unavailable`。
4. `createOffer` に `amount: total` を渡す。offer の照合も `total` と行う。
5. `created` の行の `source.amount` は `total`、`source.pricing` に内訳と `issuedAtMs`（§5 の予約の時刻）を書く。固定の route は欄を書かない。

**存在する注文の再利用**：作成のあとに記録が書けず、同じ `requestId` で取り直した場合、SubEtha は元の額の注文を返し得る。額が違えば今の `order_reused_mismatch` で断る（安全な側。新しい `requestId` が要る）。

## 5. 件数（1 日）

- `offerCap` の検査と同じ await の無い区間で、`offerCap` と `maxPerDay` を両方数え、両方通った時だけ予約する。数え方は要件 R7（`issuedAtMs` の UTC の日）。式になる前の記録は `issuedAtMs` が無いので、日の数には入らない（`offerCap` には入る）。
- 予約の時刻（その区間で 1 回読む）を `issuedAtMs` とし、そのまま記録に書く。発行の途中で日が変わっても、その offer は予約した日の 1 件で、新しい日の数には入らない。
- `issuedAtMs` は、同じ行の `approvalDeadlineMs`（同じ時計で決めた承認の期限）より前で、その 20 分前以降に限る（journal の `at` は別の時計なので使わない）。外れた記録は `pricingInvalid` で、**どの日の数にも入れる**（枠が戻らない側）。
- 予約は発行の終わりに外す（成功・失敗とも。`finally`）。

## 6. 復元と再開

- `created` の行に、内訳の指紋 `pricingFingerprint`（`{ pricing, quoteId }` の sha256。`source` の外の欄）を書く。**復元では、指紋が一致しなければ `pricingInvalid`**（内訳・予約の時刻の書き換え、どちらか片方の欄の削除を見つける）。どちらの欄も無い行は固定の額の記録。
  journal の書き換えを防ぐ仕組みではなく（鍵を持たない）、1 つの欄の破損・編集が枠や支払いに効かないことだけを守る。
- `source.pricing` が形どおりで `pricingMatches`（§7 の (a)・(b)）なら `IntentSource.pricing` に復元。欄があるのに違えば `pricingInvalid: true`。
- 購入の検査（上流の読み直し・verify の前）：route に `pricing` があるのに記録に無い、記録にあるのに route に無い、`pricingInvalid`、`total > maxAmount` のどれかなら `quote_changed`（何も送らない）。指紋の検査と重なるが、記録だけの書き換えを捕まえる。
- 同じ検査を、offer の再提示（`offerFor`）、`created` の quote の再取得、標準入口の credential の受付でも行う（再提示しない・`quote_failed`・受け付けない）。状態の照会は通す。
- 配達（`deliver`）の直前にも、記録の検査（`pricingInvalid`）を行う。

## 7. 内訳の検査（純粋）

- **(a) `priceConsistent(price, upstream, limits?)`**：`kind` が一致、各額が 10 進の文字列で 30 桁まで、`costsAtMs` が正の安全な整数、`upstream` が一致、`total = ceil((upstream + settle + withdraw + take) × 10000 / 9965)`、`share = ceil(total × 35 / 10000)`。
  `limits` があれば `settle ≤ maxSettle`、`total ≤ maxAmount`。
- **(b) `pricingMatches`**：(a) に加えて、`upstream` = 記録した上流 offer の額 = `destination.quoted`、`total` = `source.amount` = `source.offer.amount`、`issuedAtMs` が §5 の範囲。
- 端数 `rounding` は記録せず、見せる時に計算する。

## 8. 見せるもの

- 一覧：式の route だけ `pricing: { kind, maxAmount, amountIs: "per_quote" }`。`source.amount` は上限。費用の値は出さない。
- quote の文書と MCP の `subject`：`pricing: { kind, upstream, settle, withdraw, take, share, rounding, total, costsAtMs }`。`rounding` = total − (upstream + settle + withdraw + take + share)（0 以上）。
- 標準入口の 402 は今と同じ 8 項目（額だけが式の値）。
- 状態の射影は今のまま（`source.amount` は実際の額）。

公開の案内（`https://subethalabs.com/router/llms.txt`、この repo の外）に足す文案。有効化の時に、公開の手順で足す：

> Routes that carry `pricing` in the listing are priced per quote (or per 402). `source.amount` in the listing is the maximum; the exact amount and its breakdown are in the quote's `subject` (or in the 402's `amount`) and do not change afterwards. New quotes can be refused with `pricing_unavailable`, `pricing_over_limit`, `offer_daily_cap_reached` or `offer_cap_reached`; nothing was paid and no order was created in those cases. Cap standard x402 clients with `maxAmountPerPayment`.

## 9. hosted

`RAILS_ACTIVATION.subethaExact.formulaPricing`（任意、既定なし = 無効）。有効なら `HOSTED_EXACT_PRICING` の値（要件 §3.1 の案、`maxPerDay` 20）で route に `pricing`、`source.amount` は 20,000。host の env `SUBETHA_EXACT_ETH_PRICE`・`SUBETHA_EXACT_ETH_PRICE_AT` を子に渡す（無ければ渡さない。子は起動する）。
無効なら env を読まず、生成は byte 一致。

## 10. タスク

1. `exact-pricing.ts`（式・設定の検査・記録の検査）と unit（AC-1、AC-12 の一部）。
2. `settle-costs.ts` と unit（AC-2、AC-5、AC-10）。fixture の `/xfac/costs`。
3. 設定・指紋・env・合成（AC-7、AC-12）。
4. core（発行・件数・記録・再開）と unit（AC-3、AC-4、AC-6、AC-8、AC-13 の予約の額）。
5. 一覧・quote・MCP・説明文（AC-13）。
6. hosted（AC-11）。
7. wire：quote の入口と標準入口（AC-9、AC-10、再起動）。
8. 文書（README、DEPLOY、要件の索引）。
9. 壊して落ちる確認、全体の試験（macOS、Linux）、独立レビュー、PR。

## 11. 独立レビューと確認（2026-11-24〜25）

- Codex（`gpt-6-astra`、CLI、読み取りのみ）：要件 REVISE ×2、設計 REVISE、実装 REVISE（MUST 2：予約の時刻の書き換え・内訳の削除で日の枠が戻る）→ 内訳の指紋を足して再レビュー APPROVE。全ての指摘を反映した。
- 壊して落ちる確認：36 通り。途中で 1 通り（処理中の購入を日の数に残す条件）が見逃されていたので試験を直し、全て落ちることを確かめた。
- 固定の額の route の指紋・`created` の行・一覧・quote の文書は、変更の前（`9e6f74e`）の版で取った値と byte 一致。
- 全体の試験：Linux（`node:22-bookworm`）4070 成功・失敗 0。macOS は実装レビューの反映の前に 4086 成功・5 失敗（1 件は今回の変更が原因で直した。3 件は 127.0.0.2 の設定が要る既知のもの。1 件は単独で通る既知の不安定な試験）。反映の後の macOS の全体は走らせていない。
- 確かめていないこと：本物の `/costs` を使った購入、まとめ送りが多い時の応答の大きさ、ETH の価格の実際の更新の手順、公開の案内。
