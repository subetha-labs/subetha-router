/**
 * drain の上限の試験（`tests/unit/drain-deadline.test.ts`、タスク R-0）が使う、1 件の購入の **core の中の回数**。**製品コードではない。**
 * 値は推定ではなく、`tests/unit/dynamic-core.test.ts` の「drain の上限のモデル」の試験が実際の core（静的・動的の購入）で数えて固定する
 * （core の手順が変わって回数が増えれば、その試験が落ちる）。
 * - `rereadsPerPurchase`: 購入 1 件の `readChallenge`（settle の前と送信の前。quote の読取は含まない。adapter の `pay` の中の読取は adapter 側の期限で数える）
 * - `estimatesPerPurchase`: 動的の購入 1 件の `estimateFee`（手数料の上限のあるプロファイル）
 */
export const DRAIN_MODEL = Object.freeze({ rereadsPerPurchase: 2, estimatesPerPurchase: 1 });
