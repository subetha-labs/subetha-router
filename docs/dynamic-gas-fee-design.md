# 動的上流 URL — MPP 送信の手数料を quote 時のガス代で決める（設計）

> 2026-10-06、第 3 版（独立レビュー #1〜#3 を反映。§6）。owner の方針（2026-10-06）: 「運営がガス代を負担するリスクは構造として排除する。
> 上流の手数料が高騰する場合は、それに応じた価格を下流（呼び出し側）に提示する」。前提は `dynamic-upstream-design.md`（以下「本設計」）§3.3・§6.6・§11 と、
> G-1 で入れた条件 `fee.min >= maxFee`（PR #30）。MPP 送信のプロファイルを本番で有効にする前提（`DEPLOY.md` §2b の条件 6）の一部。

## 0. 一枚で

- 今: MPP 送信の手数料は**定額**（`fee.min >= maxFee` を設定で固定。本番は 5,000 = `maxFee`）。署名前の上限の実測は 79〜706 なので呼び出し側が払いすぎ、
  高騰時は `maxFee` で支払いが止まる。
- 変更: quote の時点で**その送金のガス代を見積もり**、`maxFee` と手数料を quote ごとに決める。平時は安く、高騰時は高く提示し、天井を超えたら quote を出さない。
- 保つもの: 「呼び出し側が先に払う手数料 ≥ Router が署名する transaction の手数料の上限」を **quote ごと、記録ごとに**保つ（構造は変えず、値を動的にする）。
  この性質は quote の計算だけでなく、**記録の復元・昇格済みの再開・adapter の境界**のそれぞれが独立に確かめる（§3）。
- 変えないもの: 署名の境界（本設計 §3.3 (ii)）は「quote が決めた `maxFee`」を使うだけで、検査の中身は同じ。x402 送信のプロファイルは対象外（Router にガス代がかからない）。
- 言葉: **bound** = `ceil(gas × maxFeePerGas / 10^12)`（署名前に分かる手数料の上限。本設計 §3.3 T0-b）。**cap** = quote が決め、記録に固定する `pricing.maxFee`。
  **ceiling** = プロファイルの `destination.maxFee`（cap がこれを超える quote は出さない）。

## 1. 見積り（quote の手順に足す段）

MPP 送信のプロファイルで offer を選んだ直後（本設計 §2.3 の後、受信 offer を発行する前）に、送信 adapter の**動的経路**が RPC を読む。

```
estimate = adapter.estimateFee(profileId, offer, target)      // { gas, maxFeePerGas, bound }
```

### 1.1 見積もる transaction

**実際に署名するものと同じ形**（本設計 §3.3 T0-a「`signTransaction` に渡る欄」）:

| 欄 | 値 |
|---|---|
| 送信者 | 能力の account のアドレス（`capability.account.address`） |
| chain | `chainIdOf(profile.destination.network)`（能力の chainId と一致することは起動時に確認済み） |
| `calls` | 1 つ。`to` = `profile.destination.asset`、`data` = `transferWithMemo(offer.payTo, offer.amount, memo)`、`value` = 0 |
| `memo` | quote 時には無い（challenge の id から SDK が作る）ので、**同じ長さ（32 バイト）の非ゼロのダミー** |
| `feeToken` | `profile.destination.feeAsset` |
| nonce | expiring nonce（`nonce: 0`、`nonceKey: 2^256−1`）、`validBefore` = 現在＋25 秒（SDK と同じ） |
| `type` | `"tempo"` |

- **ガス量は memo の中身に依る**（実測。第 1 版の「依らない」は誤り）: `tools/dyn-mpp-estimate-probe.ts`（読取だけ。testnet の RPC に
  `eth_fillTransaction` / `eth_estimateGas` を出すだけで、署名も送金もしない）で 2026-10-06 に測った prepared gas は、memo がゼロ 32 バイトで **48,558**、
  非ゼロ 32 バイト（ダミー）で **48,945**、SDK の帰属 memo と同じ形（非ゼロ）で **48,945**（自分宛て 10,000。残高の無い宛先では 53,796 / 54,182 / 54,182。
  T0-a の 54,278 と整合）。差は calldata の単価（ゼロのバイト 4 gas、非ゼロ 16 gas）で、**全バイト非ゼロのダミーは 32 バイトの memo の中で最大**。
  SDK の帰属 memo は tag・version・指紋・nonce を詰めた 32 バイトで、ゼロのバイトがあれば安くなるだけ。宛先の残高の有無（約 5,200 gas）は、見積りが**実際の
  `offer.payTo`・`offer.amount`** で行われるので織り込まれる。本番の 13 件の `gasUsed` が 46,683 で一定だったのは、同じ形の送金が同じ宛先に繰り返されたため
  （本設計 §3.3 T0-b）。この実測は**この形の transaction についての証拠**であって一般則ではなく、署名の境界は見積りに依らず権威（下記）
- 見積りで使う `gas` は **ノードが提案する値（prepared gas。T0-a の実測 54,278）** であって receipt の `gasUsed`（46,683）ではない。署名の境界が照合するのも
  prepared gas なので、bound の定義は署名前の検査と同じ量で揃う
- **署名の境界は見積りに依らず権威**: 見積りと署名時の値がどう違っても、署名時の bound が cap を超えれば署名しない（§3.4）

### 1.2 読み方

- 能力の client を guarded RPC transport（動的用。loopback 不可・DNS 期限・門の `admit`）に乗せ直し、**viem の `prepareTransactionRequest` を直接呼ぶ**
  （`parameters` は既定のまま。SDK の push 経路 `sendTransactionSync` が通すのと同じ欄で、RPC の列も同じになる。Tempo chain は `eth_fillTransaction` を先に試し、
  非対応なら `eth_estimateGas` と手数料の見積りに落ちる）。
  **mppx の credential 作成は呼ばない**（その経路は署名・送金まで進む。`mppx/dist/tempo/client/Charge.js`）
- **署名はしない**: account は `address` と `type: "local"` だけの facade で、`signTransaction` を持たない。transport の guard は
  **署名・送金系のメソッドをすべて拒否する**（`eth_sendRawTransaction[Sync]` も含む。支払いの guard が検査済みの raw に限って許す例外は、ここには無い）。
  読取のメソッドだけを、支払いの guard と同じ規則（method は原始値として 1 度読む、params は JSON の写し）で通す
- RPC の期限: 1 回 3 秒以下（`estimateRpcTimeoutMs`）、合計 6 秒（`estimateRpcBudgetMs`）、再試行なし。**合計の期限は本当に 6 秒**: 各 RPC の期限を
  `min(3 秒, 残り)` にする（`guardedRpcTransport` の `timeout` を関数にして要求ごとに残りを読む）ので、最後の 1 回が合計を超えて続くことはない。
  期限後は次の RPC を出さない。能力から client を受け取る待ちも同じ予算の中。見積り全体にも同じ予算の期限を掛ける（余裕を足さない。RPC でない準備の経路——
  chain のフック——が止まっても 6 秒で終わる）
- 見積りに失敗したら quote は不成立（`quote_failed`、理由 `fee_estimate_unavailable`）。**定額に落とさない**。これは「定額は危険」ではなく
  （上限まで資金を積んだ定額の cap も構造としては安全）、**owner の方針（ガス代に応じた価格を提示する）から外れる**ため
- quote 全体の最悪は「上流の読取 5 秒＋見積り 6 秒（client の取得を含む）＋1 回 3 秒」= 14 秒。client の `quoteUrl` の既定の期限を 30 秒にする
  （今は 10 秒。**`quoteUrl` だけ**。優先順位は明示の `quoteTimeoutMs` → 明示の `timeoutMs` → 既定 30 秒で、呼び出し側の明示の `timeoutMs` と静的の `quote` は
  変えない。`src/client/index.ts` の期限は今 quote と quoteUrl で共有されているので分ける）。purchase は再見積り（§1.4）で 6 秒増え、Router 側の最悪は約 96 秒 → **約 102 秒**（client の既定 120 秒の内側。
  `DEFAULT_DYNAMIC_EXECUTE_TIMEOUT_MS` の注釈を直す）

### 1.3 RPC の回数

viem は `eth_fillTransaction` を先に試し、非対応（method not found）を **client の uid ごとに**憶える（`prepareTransactionRequest.ts`）。見積りは
quote ごとに client を作る（支払いと同じ）ので、憶えたものは次の quote には引き継がれない。

| ノード | RPC |
|---|---|
| `eth_fillTransaction` 対応（本番の RPC。T0-a） | 1 回 |
| 非対応（fixture） | `eth_fillTransaction`（失敗）→ `eth_getBlockByNumber`・`eth_maxPriorityFeePerGas`・`eth_estimateGas` の **4 回** |
| 非対応で `eth_maxPriorityFeePerGas` も無い | `eth_gasPrice` に落ちて **5 回** |

試験は 3 通り（対応・非対応・非対応で `eth_gasPrice` へ落ちる）の RPC の列を固定し、非対応の 2 回目の見積りも同じ 4 回であること（client の uid で憶えたものが
quote をまたいで引き継がれない）、どの経路でも**送金・署名系の RPC が 0 回**、**`signTransaction` が存在しない**ことを確かめる。

### 1.4 purchase 時の再見積り（§6.2 の手順 3 の中、受信 verify の前）

purchase の手順 3（本設計 §6.2: 残高 → 上流の読み直しと照合 → 受信 verify）の「上流の読み直しと照合」の直後に、同じ `estimateFee` をもう一度呼ぶ
（昇格済みの再開も同じ経路なので同じ）。結果は既存の昇格前の失敗と同じ形で、**どちらの受信レールでも `awaiting_payment`**:

| 結果 | code |
|---|---|
| 現在の bound > 記録の cap（`pricing.maxFee`） | `awaiting_payment` / `fee_too_high` |
| 見積りに失敗（RPC の失敗・期限・門） | `awaiting_payment` / `fee_estimate_unavailable` |

- cap・価格を**黙って上げることはしない**。purchase 時の見積りは記録に書かない（quote 時の見積りが承認の証跡。§3.1）
- x402 受信では、呼び出し側の資金はまだ動いていない（settle 前）。**新しい quote を取り直す**のが正しい（同じ quote の再試行は、単価が下がるまで同じ結果）
- MPP 受信では、資金は credential を作った時点で動いている（本設計 §6.3）。`awaiting_payment` は「未払い」を意味しない（本設計 §6.3）。
  **同じ credential を期限内にもう一度出せる**（単価が下がれば通る）。新しい quote を取るともう一度払うことになる
- 証跡: 昇格前は quote の控えに credential の digest の attempt（7 日。本設計 §6.3）だけが残る。昇格後は journal の `created` 行（予約つき）が残る
- この再見積りは**署名の境界の検査を置き換えない**（verify・settle の後に単価がさらに上がり得る）。署名前の検査も cap を使う（§3.4）

## 2. 値の決め方

```
cap        = ceil(estimate.bound × feeMargin / 10000)        // feeMargin はプロファイルの欄（bps。既定 20000 = 2 倍）
if cap > destination.maxFee (ceiling) → quote 不成立（quote_failed, fee_too_high）
fee        = max(fee.min, fee.flat + ceil(converted × fee.bps / 10000), cap)
total      = converted + fee
```

- `destination.maxFee` の意味が「署名時の上限」から「**quote が決められる cap の天井**」に変わる。**署名時の上限は cap**。ceiling は運用者が決める
  受け入れの上限で、見積りの精度の話ではない: ceiling を後から上げても、発行済みの quote の cap は変わらない
- 手数料の規則（`fee`）は運営の取り分として残る。`fee.min` は 0 でもよい（ガス代は cap が賄う）。G-1 の条件 `fee.min >= destination.maxFee` は
  **この段に置き換える**: 保つ性質は同じ（手数料 ≥ 署名時の上限）で、設定ではなく quote ごとの計算で保証し、記録・再開・adapter が各自で確かめる（§3）。
  設定の検査は `feeAsset` = 送信資産・桁が同じ、を残す
- `feeMargin`: **10,000 以上 1,000,000 以下の安全な整数**（1 倍〜100 倍。1 倍未満は、署名で必ず止まる quote を出すだけなので認めない）。
  `cap` と `total` は桁数の上限（30 桁）の中で検査する。**支払いの権威の欄に入れる**（`dynamicAuthoritativeTermsOf` に `destination.feeMargin` と
  `pricingPolicy: "gas-indexed-v1"` を足す。権威の欄は列挙なので、足さないと `feeMargin` の変更が発行済み quote を無効にしない。要件 FR-16）。
  **MPP 送信のプロファイルだけ**に足し、x402 送信の権威の欄の直列化は**変えない**（変えると配備の時点で発行済みの x402 送信の quote——MPP 受信なら払った後の
  昇格済み `created` も——が `quote_changed` になる。FR-16 は変えた価格の束縛を求めるのであって、変えていないレールの無効化は求めない）。
  試験: x402 送信の権威の欄が、変更前と同じ object に直列化されること
- **2 倍は見積りの前提ではなく、可用性の前提**: 運営の保護は「cap を超える署名を拒む」ことから来るのであって、予測の精度からではない。2 倍は
  「quote から purchase までの最大 10 分で単価が 2 倍を超えなければ通る」という**仮の値**で、本番の RPC で quote 時と purchase 時の bound を並べて記録してから
  見直す（§4）。超えれば purchase は `fee_too_high` で止まり、呼び出し側は新しい quote を取る
- 本番の値の案: `feeMargin 20000`（2 倍）、ceiling 50,000（0.05。実測の bound の最大 706 の約 70 倍。これを超える cap では断る）、`fee` は `flat 1000` に戻す
  （x402 送信と同じ運営の取り分）。**例は署名前の bound（79〜706）で**: cap は 158〜1,412、手数料は `max(1000, cap)` = 1,000〜**1,412**。
  実測の最大の bound ではすでに `flat` を超える。実額（29〜478）は cap より小さい側の参考値で、計算には使わない

## 3. 記録・復元・再開・adapter の境界

性質「手数料 ≥ cap」を保つ場所は 4 つ。どれか 1 つに頼らない。

### 3.1 記録

- quote の記録（本設計 §2.4）の `pricing` に `maxFee`（cap。`^(0|[1-9][0-9]{0,29})$`）と `estimate`（quote 時の見積りの証跡:
  `{ gas, maxFeePerGas, bound, atMs }`。額は同じ形式の 10 進文字列、`atMs` は quote 時の時刻（ms、非負の整数））を足す。MPP 送信のプロファイルでは**どちらも必須**。
  x402 送信では持たない。控え → 昇格で journal にそのまま写り、**以後は変えない**（purchase 時の再見積りは書かない。承認の証跡を上書きしない）。
  journal の 1 行の上限（8 KiB。`quote-ledger.ts`）はそのままで、境界の試験に欄を足す
- 予約（本設計 §6.4）の手数料の区分は `pricing.maxFee`（ceiling ではなく）。quote 時の 1 件あたりの上限の検査（§6.6）と残高の事前確認（§6.6）も `pricing.maxFee`

### 3.2 復元（`store.ts`）

MPP 送信のプロファイルの記録（`dynamic.profile.rail === "mpp"`）は、`pricing.maxFee`・`pricing.estimate` が上の形で揃い、`fee >= maxFee` であり、
**払う額に結び付いている**こと: `total = converted + fee`、受信 offer の額（呼び出し側が先に払う額）= `total`、`upstreamAmount` = 選んだ上流 offer の額
（記録の `fee`・`maxFee` だけを書き換えて、払っていない手数料で大きな cap を通せないように。実装レビュー #4 の指摘 1）。予約があれば手数料の資産の区分の合計が
`upstreamAmount + maxFee` 以上、journal の記録（昇格済み）なら予約が必須。この検査は 1 つの関数（`capCoversFee`）で、復元と再開（§3.3）が共有する。
そうでなければ **`dynamic` はそのまま復元したうえで、intent に `dynamicCapInvalid: true` を立てる**（既存の `dynamicInvalid` とは別。`dynamicInvalid` は
`dynamic` 全体を捨てるので `ownerKeyHash` が失われ、状態の照会が「存在しない」になる）。

| 記録 | 復元後 |
|---|---|
| 終端（`paid`・`rejected`・`unknown` 等）の履歴 | そのまま。状態の照会・予算の集計は従来どおり（予算は journal の予約から独立に集計する。`budget.ts`） |
| 昇格済みの `created`（予約あり） | `ownerKeyHash`・予約・結果は保たれ、状態の照会は通る。**purchase は `rejected` / `quote_unreadable`**（settle へ進まない）。**受信 offer の再発行（`offerFor`。HTTP の offer 口）もしない**（Router が断ると分かっている記録に向けて MPP の呼び出し側が払うのを防ぐ）。予約は通算の予算に数えられたまま（昇格済みで完了しない購入と同じ扱い） |
| 控え（ledger）の quote | `intentOfLedger` も同じ検査。purchase は `rejected` / `quote_unreadable`、offer の再発行もしない |

core で `dynamicCapInvalid` を見る場所: 控えから組んだ直後（`dynamic.ts` の quote の応答）、purchase の検査（門・見積り・verify・settle の前）、昇格後の読み直し
（`source_pending` の前）、配達（`orchestrator.ts` の `deliver`。settle 済みなら「払ったが届かない」結果を保つ）、offer の取得（`offerFor`）。状態の照会（`readable`）は
`ownerKeyHash` で通す。

- 旧い記録の移行は**しない**: 本番は MPP 送信のプロファイルを一度も登録していない（G-4。`MPP_OUTBOUND_PROFILE_ENABLED = false`）ので、cap の無い MPP 送信の記録は
  本番の journal に存在しない。試験・開発の journal にあれば `dynamicCapInvalid` のまま期限切れにする

### 3.3 昇格済みの再開

昇格済み（`created` ＋予約あり）の purchase は予約を取り直さない（本設計 §6.2 の 5）。そこで core は、再開の前に**記録から**次を確かめ、
違えば `rejected` / `quote_unreadable`（復元で `dynamicCapInvalid` になるものと同じ条件を、復元に頼らず core でも見る）:

- `pricing.maxFee`・`pricing.estimate` が §3.1 の形で存在し、`fee >= maxFee`、`total = converted + fee`、受信 offer の額 = `total`、上流 offer の額 = `upstreamAmount`
- 予約（昇格済みなら必須）に `{ network: destination.network, asset: destination.feeAsset }` の区分があり、その合計が `upstreamAmount + maxFee` 以上
  （`feeAsset` = 送信資産なので、元本の区分と手数料の区分は同じ鍵に落ちる。`reservationOf` の形）

復元と同じ関数（`capCoversFee`）を使う。復元が同じ検査をしているので core の検査は多重の防御で、単独では試験で観測できない（復元と両方を外す変異で落ちる）。
関数そのものは入力ごとに直接試験する。

これは x402 受信なら settle 前（資金は動いていない）、MPP 受信なら credential を作った時点で動いている（本設計 §6.3）。どちらでも Router の送信は起きない。

### 3.4 adapter の境界

- core は `pay` に `maxFee: pricing.maxFee` を渡す（`PayRequest.maxFee?`。`orchestrator.ts` の `deliver` → `outbound.pay` が渡す。`dynamic.ts` は呼ばない）
- MPP の動的経路（`target` あり）では **`request.maxFee` は必須**: 無い・形式が違う・ceiling を超える（記録が壊れている）なら `not_sent` / `destination_fee_cap_invalid`。
  **ceiling に丸めない**（fingerprint が ceiling の変更を `quote_changed` で止めるので、超えているのは記録の破損だけ）
- `ApprovedTransfer` は 1 件の `pay` で**1 度だけ**作り（`maxFee = request.maxFee`）、署名の境界と送信の境界（raw の復号後の再検査）は**同じ object**を使う。
  今は `approvedTransferOf` がプロファイルから読むが、request から読む形に変える
- `maxFee` の無い `PayRequest`（静的・x402 送信）は従来どおり。x402 の動的 adapter は `maxFee` を読まない
- **署名後・送信前の拒否は `not_sent`**: 送金の RPC（raw の送信 1 回）が**接続の前に**断られた場合——adapter の RPC の予算切れ、transport の門
  （`admission_refused`）、方針（`destination_blocked`）——は、raw は出ていないので `not_sent` / `destination_send_refused_before_dispatch`
  （署名した raw は捨てる。expiring nonce なので `validBefore` で死ぬ。再署名・再送はしない）。今はこれも `unknown` に落ちる（署名 1 回の後の失敗はすべて不明扱い）が、
  門の拒否は socket を開く前に起きるので「送っていない」と言える。接続した後の失敗は従来どおり `unknown`。
  判定は**その送金の要求の失敗の `cause` を辿って** Router 自身の例外型（`TransportError` の code、`RpcBudgetExhaustedError`）を見る（viem は元の例外を `cause` に包む。
  文字列や RPC 側のラベルでは判定しない）。**最初の送金の要求にだけ**結び付け、1 度目が接続した後に失敗していれば、以後どんな拒否があっても `unknown` のまま
- 新しい理由コード `destination_fee_cap_invalid`・`destination_send_refused_before_dispatch` は core の理由の許可リスト（`orchestrator.ts` の `SAFE_REASONS`）に足す
  （足さないと journal・応答で `destination_rejected` に潰れ、証跡が残らない）。core の試験で journal と応答に残ることを見る

## 4. 変えないこと・限界

- 署名の境界・送信の境界の検査の中身（T9）は変えない。変わるのは上限の値の出所だけ
- quote と purchase の間（最大 10 分）に単価が上がれば、purchase の再見積り（§1.4）か署名前の検査（`destination_rejected`）で止まる。
  **どちらの受信レールでも、受信 settle の後に止まれば呼び出し側は払っていて届かない**（本設計 §6.2 の順序: settle → 送信。返金しない。FR-10）。
  再見積りは x402 受信でこれを避ける手段で、MPP 受信の前払いは取り消せない。開示（`disclosures`）: MPP 送信のプロファイルでは**受信レールに依らず**
  `routerMayRejectAfterSettle: ["fee_too_high"]`（settle の後、署名前の検査で止まり得る。返金しない）を出し、MPP 受信の `routerMayRejectAfterFundsMoved` には
  `fee_too_high`・`fee_estimate_unavailable` を足す。人への承認表示（MCP の instructions・client）に **手数料・cap（`pricing.maxFee`）・見積りの時刻
  （`pricing.estimate.atMs`）・期限**を出し、「見積りは配達の保証ではなく、払った後に拒否され得る」と書く
- 「チェーンが実際に請求する額が署名時の bound 以下」という Tempo 側の前提（本設計 §3.3 T0-b）はこのスライスでも変わらない。MPP 送信のプロファイルを本番で
  有効にする条件 6 は、この実装の後も「前提の確認」が要る。あわせて、quote 時と purchase 時の bound を本番の RPC で並べた記録（2 倍の見直し材料）を条件 6 の資料に加える
- **RPC ホストの容量**（本設計 §7.3 の宛先アドレスごとの枠 60／分・同時 4）: この枠は**動的 transport を通る全部の接続**——上流の GET、x402 の facilitator、
  MPP 受信の RPC、MPP 送信の RPC（今も数えている）、このスライスの見積り——に、**名前解決で得た全アドレス**ごとに掛かる。本番の形（各ホストが別のアドレス。
  Tempo の RPC は受信・送信とも同じホスト `SUBETHA_TEMPO_RPC_URL`、`eth_fillTransaction` 対応 = R 1）では、Tempo の RPC のアドレスの 1 分の最悪は
  `quote 10 × 1 + MPP 送信の purchase 10 × (1 + 1 + 1) + MPP 受信の purchase の RPC`（purchase の全体の枠は 10／分で両プロファイルの合計）。
  R = 4／5（非対応）のノードでは見積りだけで 40／50 になり、purchase の RPC（1 件 9／11）と合わせると枠に収まらない。**非対応のノードは運用の条件から外す**
  （`DEPLOY.md` §2b の条件に足す。起動時の `verify` でも `eth_fillTransaction` の有無を読取で確かめる）。
  枠で止まる purchase は、再見積りなら `fee_estimate_unavailable`、送信の読取なら `destination_rejected`、**送金の RPC なら `not_sent`**（§3.4。署名後でも接続の前）。
  **容量は可用性の話で、安全の話は §3.4 の分類が持つ**。試験: (a) fixture を R 1 にして quote を全体の上限まで出した直後に purchase が通ること、
  (b) 送金の RPC の門を閉じて `not_sent`（raw は出ていない）になること、(c) 送金の RPC が接続後に失敗して `unknown` のままであること。
  見積りの短時間キャッシュはこのスライスでは入れない
- 見積りの RPC はノードの応答で決まる（本設計 §3.3「帰結」）。ノードが高い単価を返せば quote は高くなり、ceiling で断られる。運営はノードを選ぶ以外にそれを抑えない

## 5. 変更するファイル（見込み）

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `DynamicProfile.destination.feeMargin?`（bps、既定 20000、10,000〜1,000,000 の安全な整数。MPP 送信だけ）。`fee.min >= maxFee` の検査を外し、`feeAsset`・桁の検査は残す。権威の欄に `feeMargin`・`pricingPolicy`（MPP 送信だけ。x402 送信の直列化は不変） |
| `src/ports/outbound.ts` | `OutboundRail.estimateFee?(profileId, offer, target)`、`PayRequest.maxFee?` |
| `src/net/guarded-rpc.ts` | `timeout` を関数でも受ける（`fetchFn` の中で要求ごとに読む。0 以下なら出さずに失敗。数値の呼び出し側はそのまま） |
| `src/adapters/outbound/mpp-dynamic.ts` | `estimateFee`（署名しない facade・読取だけの guard・残り予算の期限・client の取得も予算内）、`pay` が `request.maxFee` を必須にし `ApprovedTransfer` を 1 度だけ作る、送金の RPC の接続前の拒否を `not_sent` に |
| `src/adapters/outbound/mpp.ts`・`src/main.ts` | `estimateFee` の転送（`railByRoute`） |
| `src/core/dynamic.ts` | quote の手順に見積りを足す。`priceOf(profile, amount, cap?)`、`reservationOf`・`perPurchaseLimitOf`・`fundsAvailable` が `pricing.maxFee` を使う。purchase の再見積り（§1.4）と再開前の検査（§3.3）、`dynamicCapInvalid` の拒否 |
| `src/core/orchestrator.ts` | `deliver` が `pay` に `maxFee` を渡す。`SAFE_REASONS` に新しい理由コード。`deliver`・`offerFor` が `dynamicCapInvalid` を見る |
| `src/core/store.ts`・`src/core/intent.ts` | `pricing.maxFee`・`pricing.estimate` の復元と `dynamicCapInvalid`（§3.2） |
| `src/http/projection.ts`・`src/client`・`src/mcp` | `pricing.maxFee`・`pricing.estimate` の表示、`disclosures` の `routerMayRejectAfterSettle`・`routerMayRejectAfterFundsMoved`、client の `quoteUrl` の期限 30 秒・`DEFAULT_DYNAMIC_EXECUTE_TIMEOUT_MS` の注釈 |
| `tools/remote-mcp-config.ts`・`src/main.ts`・`docs/DEPLOY.md` | MPP 送信のプロファイル: `feeMargin 20000`、ceiling 50,000、`fee` を 1,000 に（登録は引き続き無効）。`verify` で RPC の `eth_fillTransaction` 対応を読取で確かめる。§2b の条件に足す |
| `tools/dyn-mpp-estimate-probe.ts` | memo 3 通りの読取だけの見積り（§1.1。新規） |
| 試験 | unit（config・priceOf・権威の欄・store の復元・core の順序と再開前の検査・RPC 0 の経路）、wire（adapter の見積り: 4 通りの RPC の列・値・失敗・残り予算の期限・送金系メソッドの拒否・署名器が無い。`pay`: `maxFee` 無し／ceiling 超えの拒否、署名と送信が同じ cap）、統合（fixture の単価を変えて cap・手数料が動く、ceiling 超えで断る、purchase の再見積りで `fee_too_high`・`fee_estimate_unavailable`、署名前の検査が cap を使う、昇格済みの再開と再開前の検査、journal の再読込で `dynamicCapInvalid` の記録の状態照会が通り purchase が `quote_unreadable`、x402 送信の quote が配備をまたいで有効、R 1 の fixture で quote 飽和後の purchase、送金の RPC の接続前の拒否が `not_sent`・接続後の失敗が `unknown`） |

## 6. 独立レビューの記録

| # | 日付 | レビュア | 結果 | 反映 |
|---|---|---|---|---|
| 1 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 1 版 `3c5da30`） | **REJECT** | (1) cap を記録・復元・再開・adapter の 4 か所で必須に（§3。`orchestrator.ts` を変更対象に追加）。(2) 「x402 受信なら払っていない」は誤り（settle → 送信の順）。両レールの開示に直し、purchase 時の再見積りを足した（§1.4・§4）。(3) 例を署名前の bound（79〜706）で書き直し、2 倍を仮の値とした（§2）。(4) RPC の回数を `eth_fillTransaction` の失敗を含めて 4／5 回に直し、合計の期限を要求ごとの残り予算で本当に 6 秒にし、RPC ホストの容量を 60／分の枠で計算し直した（§1.3・§4）。(5) `feeMargin` を 10,000〜1,000,000 に限定し、権威の欄に入れた（§2）。(6) memo 非依存を「この形についての実測」に言い直し、prepared gas と `gasUsed` を区別し、memo 3 通りの probe を足した（§1.1）。ほか: 見積りは `prepareTransactionRequest` 直接呼び・credential 作成を呼ばない・送金系メソッドを例外なく拒否、30 秒は `quoteUrl` だけ、承認表示の項目、静的への fallback の表現を修正 |
| 2 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 2 版 `a92e8e3`） | **REJECT** | (1) `dynamicInvalid` は `ownerKeyHash` ごと捨てるので状態の照会が通らない → `dynamic` を保ったまま `dynamicCapInvalid` を立てる形に。終端・昇格済み・控えの各記録の扱いと、再開前の検査の内容（cap の形・予約の区分）を明記（§3.2・§3.3）。(2) 容量の計算が送信の RPC だけで、上流の GET・facilitator・受信の RPC・名前解決の全アドレスを数えていなかった。「署名前に止まる」も誤り（送金の RPC の門の拒否は署名後で `unknown`）→ 全消費者を数え、非対応ノードを運用条件から外し、**送金の RPC の接続前の拒否を `not_sent` に分類**（§3.4・§4）。(3) `pricingPolicy` を無条件に足すと発行済みの x402 送信の quote が `quote_changed` になる → MPP 送信だけに限定し x402 の直列化を不変に（§2）。(4) purchase 時の見積り失敗の結果、証跡の表現、再開の「資金は動いていない」、レール別の助言、x402 受信への開示を明記（§1.4・§3.3・§4）。(5) `timeout` 関数は `fetchFn` の中で読む、client の取得も予算内、purchase の最悪 102 秒、見積りの証跡 `pricing.estimate` を定義（§1.2・§3.1・§5）。`feeMargin` の位置を `destination.feeMargin` に統一 |
| 3 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 3 版 `e575a84`） | **APPROVE WITH CHANGES** | (1) `dynamic` を保つと `offerFor` が受信 offer を再発行し、断ると分かっている記録に向けて払える → offer の取得でも `dynamicCapInvalid` を見る（§3.2 に core の検査点を列挙）。(2) 新しい理由コードが `SAFE_REASONS` に無いと `destination_rejected` に潰れる → 許可リストと core の試験（§3.4・§5）。ほか: 接続前の拒否の判定は `cause` を辿って Router の例外型で（viem が包む）、最初の送金の要求にだけ結び付ける（§3.4）。§3.3 に `pricing.estimate` の検査を明記。実装の前提になる設計上の障害は無し |
| 4 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。**実装** `df8c80a`） | **REJECT** | (1) 高: 復元の検査が記録の `fee` を信じ、払う額（受信 offer）と結び付いていない → `capCoversFee` に `total = converted + fee`・受信 offer の額 = `total`・上流 offer の額 = `upstreamAmount` を足した（§3.2）。(2) 再開の検査が形を見ず予約を任意にしていた → 復元と同じ関数で形を検査し、昇格済みは予約必須（§3.3）。(3) client の `quoteTimeoutMs` が明示の `timeoutMs` を無視 → 優先順位を直した（§1.2）。(4) 見積り全体の期限に 1 秒の余裕があった → 予算そのものに（§1.2）。ほか: `parameters` は既定（SDK と同じ）と明記、試験の経路は 3 通り＋「quote をまたいで憶えない」に訂正（§1.3） |
