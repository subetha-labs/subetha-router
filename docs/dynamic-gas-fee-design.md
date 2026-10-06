# 動的上流 URL — MPP 送信の手数料を quote 時のガス代で決める（設計）

> 2026-10-06、第 4 版（§8: Router が手数料の単価を決める。owner の決定 2026-10-06「a で進めましょう」。第 3 版までは独立レビュー #1〜#3 を反映。§6）。owner の方針（2026-10-06）: 「運営がガス代を負担するリスクは構造として排除する。
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
**払う額に結び付いている**こと: `total = converted + fee`、`converted = upstreamAmount`（MPP 送信は桁が同じ・par なので換算は恒等）、
**実際の受信 offer**（settle に渡る `source.offer`）の額 = `total`（写しの `source.amount` ではなく）、`upstreamAmount` = 選んだ上流 offer の額
（記録の `fee`・`maxFee`・`converted`・`source.amount` を書き換えて、払っていない手数料で大きな cap を通せないように。実装レビュー #4・#5 の指摘 1）。予約があれば手数料の資産の区分の合計が
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

- `pricing.maxFee`・`pricing.estimate` が §3.1 の形で存在し、`fee >= maxFee`、`total = converted + fee`、`converted = upstreamAmount`、実際の受信 offer（`source.offer`）の額 = `total`、
  上流 offer の額 = `upstreamAmount`
- 予約（昇格済みなら必須）に `{ network: destination.network, asset: destination.feeAsset }` の区分があり、その合計が `upstreamAmount + maxFee` 以上
  （`feeAsset` = 送信資産なので、元本の区分と手数料の区分は同じ鍵に落ちる。`reservationOf` の形）

復元と同じ関数（`capCoversFee`）を使うが、**予約の区分を引く宛先（network・feeAsset）は設定のプロファイルから渡す**（指紋で quote 時の設定と一致を確かめた後。
記録のプロファイルの写しは書き換えられ得るので、写しの宛先に合わせて区分を移した記録は再開で落ちる。実装レビュー #6 の指摘）。復元は写しで引く（状態の照会と
offer の抑止のため）ので、実行の守りは再開の検査。数値の検査は復元と同じなので単独では観測できない（両方を外す変異で落ちる）。関数そのものは入力ごとに直接試験する。

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
| 5 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。実装 `ca29f8f`） | **REJECT** | 指摘 1 が部分的: `converted` が上流額に結び付いておらず（下げて `fee` を上げられる）、復元が写しの `source.amount` を見ていた（settle に渡る `source.offer` ではなく）→ `converted = upstreamAmount` と `source.offer.amount = total` に結び付けた（§3.2・§3.3）。他の 3 点は解消 |
| 6 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ・範囲限定。実装 `b7580ae`） | **REJECT** | 数値の不変条件は閉じた（cap ≤ 受信 offer − 上流 offer）。残り 1 点: 予約の区分を記録のプロファイルの写しで引いていた（写しの宛先を書き換えて区分を移せる）→ 再開は設定のプロファイルの宛先で引く（§3.3） |
| 7 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ・範囲限定。実装 `b7580ae` の修正後） | **APPROVE** | 移した予約の抜け道は全実行経路で閉じた（再開・昇格後の読み直し・配達）。写しの他の欄は応答の表示にしか使われない。正当な記録の退行なし |
| 8 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。§7 第 1 版 `3ebe9e2`、Tempo のソース tag v1.16.0 を併読） | **REJECT** | (1) 配備された版との一致を版名と commit の題だけで主張していた → tag object/commit を記録し、配備 commit との比較を加えた。(2) 「invalid → 含まれない → 手数料なし」を段で区別していなかった → 前払い・実行後・送金そのものの失敗の表（§7.3）。(3) 式に `saturating_sub` が無く、AMM の丸めと two-hop が無かった → 訂正。gas の上限の裏付け（AA の gas_limit の復元・TIP-1016・TIP-1060・keychain）を追加 |
| 9 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ・範囲限定。`dab5d40`） | **APPROVE WITH CHANGES** | (1) diverged な compare の変更ファイル一覧は両端の差ではない → `023f1d0` と `74b6915` の tree を直接比較（全 blob 一致）に置き換えた。(2) `gas.used()` = receipt の `gasUsed` という同一視を外した（reservoir で一致しない場合がある） |
| 10 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 4 版 §8 `5a733bf`） | **APPROVE WITH CHANGES** | (1) アドレスの枠を 100 に上げるのは第三者の宛先の緩和でもある。「第三者は 10／分のまま」は誤り → 目的に照らして妥当と判断した理由を書き、誤りを消した（§8.2）。(2) clamp・署名拒否の閾値が 2.4 倍ずれていた（4.8×/11.5× → 2×/4.8×、再見積りは 2× で settle 前）→ 訂正。(3) `pricingPolicy` の版上げが無かった → v2（§8.2・§8.4）。(4) block の読取で `viaFillTransaction` が偽になる既存の実装の依存 → fill の成否で立てる（§8.2・§8.4）。(5) 「tip で競わない」は言い過ぎ → pool の並び順・最小 priority の設定・容量を書いた（§8.2・§8.3）。(6) p90 の tip と提案値の混同 → 提案値の直接の証拠は ③、21 倍は仮の計算と明記、8 件/7 件・ライブの件数・history の性質を書いた（§8.1） |
| 11 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ・範囲限定。`14f849b`） | **APPROVE** | 6 点すべて解消。設計の承認であって実装・実機の検証ではない |
| 12 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。§8 の**実装** `1f65489`） | **REJECT** | (1) 支払いの baseFee の読取が RPC の予算（20 秒）の外にあり、試験もそれを隠していた → 予算の開始を読取の前に移し、残りの予算を期限にした。試験を締め、予算内であることの試験を足した。(2) 観測ツールがノードの提案で測っていた → Router の単価で測る形に（`--node-policy` で旧挙動）。(3) 鍵の導出の例外に値が出得る → 固定の文言に |
## 7. Tempo の手数料の仕様の確認（`DEPLOY.md` §2b 条件 6 の前提。2026-10-06）

owner の依頼（2026-10-06「1 を進めていきましょう」）で、「チェーンが実際に請求する手数料 ≤ 署名時の `ceil(gas × maxFeePerGas / 10^12)`」を**観測ではなく仕様とノードの実装**で確かめた。
対象は Tempo testnet Moderato（chainId 42431）のノード `tempo/v1.16.0-023f1d0`（`web3_clientVersion`、2026-10-06）。読んだのは公開ドキュメント、TIP-0001、
ノードのソース（`github.com/tempoxyz/tempo` の tag `v1.16.0`。tag object `b2b832e` → commit `74b6915`）。すべて読取だけで、署名も送金もしていない。

**ソースの版と配備されたバイナリの結び付き**: 配備されたノードが名乗る commit `023f1d0`（release/v1.16.0 ブランチ。「fix(deps): backport Reth proof fix to v1.16.0」）と
tag の commit `74b6915`（同じ変更を #8123 として取り込んだもの）は、**tree を直接比べて全ファイルの blob が同一**（GitHub の git/trees API で `023f1d0` の再帰的な tree を取り、
`git ls-tree -r 74b6915` と path・blob hash で比較。949 の blob がすべて一致、3 つの submodule の pointer も一致。diverged な compare の「変更ファイル一覧」は merge base からの差で
あって両端の差ではないので、根拠にしない）。依存の版も `revm 43.0.3`・`revm-handler 43.0.3`・`revm-interpreter 43.0.2`・`alloy-eips 2.5.0`（`Cargo.lock`）。したがって
**手数料の経路のソースは配備された版と一致する**（バイナリそのものを検証したわけではない。ノードが名乗る版名と commit を信じている）。main `0b511ac` との diff も手数料の計算に変更なし。

### 7.1 仕様（公開ドキュメント・TIP）

- 手数料の単位: `max_fee_per_gas` は attodollar（10^-18 USD）/gas、TIP-20 の 1 単位は microdollar（10^-6 USD）。**「the fee for a transaction can be calculated as
  `ceil(base_fee * gas_used / 10^12)`」**（Fee specification、`tempo.xyz/developers/docs/protocol/fees/spec-fee`）
- 徴収の形: **前払いと返金**。「Deduct `max_fee` from the `fee_payer`'s balance of `fee_token`」（`max_fee = gas_limit × gas_price`）、実行後に
  「Compute the `refund_amount` as `(gas_limit − gas_used) × gas_price`. Credit the `fee_payer`'s address」（同ページ）。TIP-0001 §Error Cases:
  「Fee payer balance insufficient for `gas_limit * max_fee_per_gas` in fee token → invalid」、「This address is used for all fee accounting (pre-charge, refund) via the TIP Fee Manager precompile」
- Fee AMM: 送信者の fee token と validator の token が違うときだけ、**post-tx に**固定レート 0.9970 で swap する。「`validatorTokenOut = userTokenIn × 0.9970`」——
  差額は validator 側の受取が減る形で、送信者の支払いは増えない。流動性不足は「the entire transaction reverts」（同ページ）

### 7.2 実装（tag `v1.16.0`）

| 段 | コード | 内容 |
|---|---|---|
| 換算 | `crates/primitives/src/transaction/mod.rs:53,59-63` | `calc_gas_balance_spending(gas, price) = ceil(gas × price / 10^12)`（`div_ceil`、`TEMPO_GAS_PRICE_SCALING_FACTOR = 10^12`） |
| 単価 | `crates/primitives/src/transaction/tempo_transaction.rs:699-705` | `effective_gas_price = alloy_eips::eip1559::calc_effective_gas_price(max_fee_per_gas, max_priority_fee_per_gas, base_fee)` = `min(max_fee_per_gas, base_fee + max_priority_fee_per_gas)` |
| 事前の検査 | `crates/revm/src/tx.rs:255-258`（revm-handler 43.0.3 `calculate_caller_fee` → `ensure_enough_balance`） | 残高 ≥ `ceil(gas_limit × max_fee_per_gas / 10^12) + value`。足りなければ invalid（含まれない） |
| 前払い | `crates/revm/src/handler.rs:1236,1407-1420`、`crates/revm/src/tx.rs:261-269` | `gas_balance_spending = ceil(gas_limit × effective_gas_price / 10^12)` を fee manager に移す（`collect_fee_pre_tx`。`crates/precompiles/src/tip_fee_manager/mod.rs:158`、`tip20/mod.rs:1438`）。validator の token が違えば流動性を検査・予約し、無ければ **invalid**（`handler.rs:1431`。transaction は含まれず、手数料は無い） |
| 実行後 | `crates/revm/src/handler.rs:1679-1700` | `actual_spending = ceil(max(gas.used() − gas.reservoir(), 0) × effective_gas_price / 10^12)`（`saturating_sub`。`gas.used()` は handler が会計を終えた後の `Gas::used()` = spent − refunded。receipt の `gasUsed` とは別に定義する——reservoir の扱いで一致しない場合がある。`tips/tip-1016.md:182-187`）、`refund_amount = 前払い − actual_spending`。`collect_fee_post_tx`（`tip_fee_manager/mod.rs:234`）が返金し（残高の移動は `tip20/mod.rs:1507-1508`）、TIP-20 の `Transfer(fee_payer → fee manager, actual_spending)` を出す（`tip20/mod.rs:1471-1481`。T0-b が receipt で見たもの） |
| Fee AMM | `tip_fee_manager/mod.rs:250-264`、`amm.rs:15,28-32,664-688` | `fee_token == validator_token` なら validator は `actual_spending` をそのまま受ける。違えば直接 swap で `floor(actual_spending × 9970 / 10000)`、T5 以降の two-hop ではそれを 2 回掛けた額を受ける。swap は pool の reserve を動かすだけで、**送信者からの転送は前払いの 1 回だけ**（`execute_fee_swap` は送信者に触れない） |
| 既定の validator token | `tip_fee_manager/mod.rs:68-76`、`contracts/src/precompiles/mod.rs:44` | 未設定なら pathUSD（`DEFAULT_FEE_TOKEN`）。Router の `feeToken` も pathUSD なので、validator が別の token を選んでいなければ swap は起きない |

### 7.3 帰結

送信者（Router。fee payer を使わないので `fee_payer = sender`）が払う額は `actual_spending = ceil(max(gas.used() − gas.reservoir(), 0) × effective_gas_price / 10^12)` で、

- `gas.used() = spent − refunded ≤ spent = limit − remaining ≤ gas_limit`（revm の `Gas`。reservoir は差し引く側にしか働かない）。AA（Tempo transaction）の実行は失敗時も
  元の gas_limit を復元してから会計する（`handler.rs:619,655-661,697-733`、`normalize_failed_batch_result_gas` `:223-254`）ので、上限を超えて課金する経路は見つからなかった。
  state gas（TIP-1016）は同じ gas の予算の中で消費され、別の token の請求ではない（`tips/tip-1016.md:122,152-172`）。TIP-1060 の storage credit は gas の返金を記録するだけで、
  手数料のフックでは無効（`revm/src/gas_credits.rs:63-86`、`revm/src/fee_manager.rs:37-49`）。keychain の spending limit は認可の制約で、別の手数料ではない
- `effective_gas_price = min(max_fee_per_gas, base_fee + max_priority_fee_per_gas) ≤ max_fee_per_gas`
- `ceil(x / 10^12)` は単調

なので **`actual_spending ≤ ceil(gas_limit × max_fee_per_gas / 10^12)` = 署名の境界が照合する bound**（`mpp-dynamic.ts` の `feeBoundOf` と `checkFeeAndValidity`。署名する transaction の
`gas` は gas_limit の欄に置かれ、`maxFeePerGas` と共に raw の復号後にもう一度照合する）。Fee AMM の 0.3% は validator の受取から引かれ、送信者の支払いには乗らない。

失敗の段ごとの扱い:

| 失敗 | 段 | 結果 |
|---|---|---|
| fee token の残高が `ceil(gas_limit × max_fee_per_gas / 10^12)` 未満、Fee AMM の流動性不足、fee token が**既に** pause | 前払い（pre-tx） | checkpoint を戻して validation error（`handler.rs:1422-1464`）→ **invalid、含まれない、手数料なし** |
| 返金・swap の失敗（post-tx） | 実行後 | `EVMError::Custom`（`handler.rs:1722-1737`）→ **実行の失敗**で結果は commit されない（`crates/evm/src/block.rs:558-610`）。payload builder はこれを内部エラーとして伝え、無効な transaction として飛ばすのではない（`crates/payload/builder/src/lib.rs:698-721`）。前払いだけ残った transaction を含むブロックは成立しない |
| 送金そのものの失敗（元本の残高不足、call の途中で token が pause） | 実行中 | transaction は**含まれ、失敗し、gas は課金される**（上の bound の内側）。実行中に fee token が pause されても返金は行われる（`tip20/mod.rs:1438-1443,1467-1508`） |

前払いと返金は同じ transaction の実行の中で行われ、返金だけが別に失敗して前払いが残る経路は無い。これで `dynamic-upstream-design.md` §3.3 T0-b の「観測と一致した」換算は、
**この版のソース（配備されたバイナリと同じ版名・同じ依存の版）について**仕様とソースで裏付けられた。

**限界**: (1) 将来の版や **hardfork の有効化**（版が変わらなくても挙動が変わり得る。`is_t5`・`is_t8` のような分岐がソースにある）で変わり得る。本書が読んだのは v1.16.0 のソースで、
`DEPLOY.md` §2b は版と確認日を記録し、ノードの版名が変わるか hardfork が有効になれば読み直す。バイナリそのものは検証していない（公開された版名・commit・依存の pin を信じている）。(2) keychain の access key で署名する場合は spending limit の検査が加わるが、
Router は root の secp256k1 鍵で署名するので対象外。(3) validator が pathUSD 以外を選ぶ環境では Fee AMM の流動性不足で transaction が含まれないことがあり得る（手数料は発生しないが、
配達は `destination_rejected`／`unknown` になる。可用性の話で、運営の負担の話ではない）。(4) 「請求額 ≤ bound」は運営のチェーン手数料の上限であって、送金の成功を保証しない。

## 8. Router が手数料の単価を決める（第 4 版。owner の決定 2026-10-06）

### 8.1 観測（`DEPLOY.md` §2b 条件 6 の「quote 時と purchase 時の bound」。すべて読取だけ）

`tools/dyn-mpp-bound-observe.ts`（`history`: `eth_feeHistory` でブロックごとの baseFee、`observe`: Router の見積りと同じ経路で 30 秒ごと、`report`: Δ ごとの比）。

| 観測 | 範囲 | 結果 |
|---|---|---|
| ① baseFee の履歴 | 2026-10-03 07:38Z 〜 10-06 07:40Z、432,128 ブロック（約 0.6 秒/ブロック） | baseFee **6.0e8〜7.47e8（最大 1.24 倍）**。bound（gas 48,945、priority 1）は 71〜88。Δ = 1・2・5・10 分の窓の最悪は **1.24 倍**、2 倍超 0 件 |
| ② ライブ（ノードの提案をそのまま写す第 1 版の経路。`observe --node-policy` に相当） | 2026-10-06 06:55Z〜（30 秒ごと、6 時間の予定。本書の執筆時点で 141 サンプル、エラー 0） | bound 71 で一定（ノードの fill は `maxFeePerGas = 2 × baseFee + priority`、viem が 1.2 倍。実測 1,440,000,001）。終了後の集計は §8.5 |
| ③ 本番 journal の Tempo 送金 18 件（RPC で transaction を読む） | 2026-09-26〜10-06 | 9/26〜27 の 10 件は `maxFeePerGas` 1.30e10・`maxPriorityFeePerGas` **9.6e9**。10 月の 8 件（うち 7 件が①の 72 時間の中）は `priority` 1（`maxFeePerGas` 1.44e9）。gas は 18 件とも 54,278、両時期のブロックの baseFee は 6e8（block を読んだ）。これらは SDK がノードの fill を写して署名した transaction なので、**ノードの提案が 9/26〜27 に 9.6e9 に達していた直接の証拠**。T0-b の「約 17 倍」は baseFee ではなく priority の差 |
| ④ 他人の tip（`eth_feeHistory` の reward パーセンタイル） | ①と同じ 72 時間 | 取り込まれた transaction の p90 の tip が 1e8 を超えるブロックが **45,640 件（73 の時間帯すべて）**、最大 **2.44e10**。ノードの提案（reth の gas oracle: 直近 20 ブロックの各最安 3 件の tip の 60 パーセンタイル、`ignore_price` 0、`max_price` 500 gwei。Tempo は既定の提案を 0 に設定、`crates/node/src/rpc/mod.rs:605`）はこれらの tip から計算されるが、**提案値そのものは観測していない**（①〜③は提案値が 9.6e9 に達し得ること、④は材料が 2.44e10 まであることを示す） |

帰結: **bound を動かすのは baseFee（10 分で最大 1.24 倍）ではなく、ノードが提案する priority fee（他人の tip に連動）**。観測した 9.6e9 で bound は 71 → 約 630（9 倍）、
材料の最大 2.44e10 が提案になれば約 1,500（21 倍。**仮の計算**）。`feeMargin` を広げても根本の対策にならない。`history` は固定の gas と補間した timestamp で bound を**計算**したもので（単価は §8.2 の `feePerGasOf(baseFee)`。①の数値は priority 1 のノードの fill の式で
計算したが、両式は ±1 wei/gas の差で bound は同じ）、Router の見積りを過去に実行したものではない。

### 8.2 方針: Router が自分で決める

Tempo の仕様では、TIP-20 の送金は専用の payment lane で取り込まれる（`tempo.xyz/developers/docs` の gas pricing は `eth_maxPriorityFeePerGas` が通常 0 と書く）。
ノードのソース（v1.16.0）では: Router の transaction（AA、`transferWithMemo` 1 call、access list・authorization 無し）は payment に分類される
（`crates/primitives/src/transaction/envelope.rs:297-309`、`crates/transaction-pool/src/transaction.rs:105`）。pool の並び順は effective tip（`crates/transaction-pool/src/ordering.rs:17-25`）で、
最小の priority fee はノードの設定（`crates/node/src/node.rs:796`。既定 `Some(0)`、`bin/tempo/src/defaults.rs:192`）。payment の transaction は general lane の gas 上限を免れるが、
ブロック全体の容量の内側（`crates/payload/builder/src/lib.rs:578-605`）。つまり **priority 1 は「tip で競わない」のではなく「混まなければ tip は要らない」**。
10 月の本番の送金 7 件は priority 1 で、同じ時間帯に他人の p90 の tip が 2e10 に達していても取り込まれた（ブロックの利用率は約 0.05%。ブロック単位では跳ねと重なっていない）。
そこで Router は**ノードの提案を写さず**、手数料の単価を自分で決める:

```
ROUTER_PRIORITY   = 1 wei                                    // 固定
feePerGasOf(base) = ceil(base × 24 / 10) + 1                  // = 2.4 × baseFee + 1。ノードの fill（2 × baseFee）× viem の 1.2 と同じ余裕を、priority 抜きで
```

- **見積り（quote・purchase の再見積り）**: `eth_getBlockByNumber("latest")` で baseFee を読み、`maxFeePerGas = feePerGasOf(baseFee)`・`maxPriorityFeePerGas = ROUTER_PRIORITY` を
  **渡して** `prepareTransactionRequest` を呼ぶ（viem は渡された手数料を優先し、fill はノードの提案で上書きしない: `fillTransaction.ts` の「Preference supplied fees」。
  手数料が両方あれば fallback の手数料の見積りも行わない）。ノードからは `gas` だけを受け取る。`bound = ceil(gas × maxFeePerGas / 10^12)`。
  RPC は対応ノードで **2 回**（block ＋ fill）、非対応で 3 回（block ＋ fill の失敗 ＋ `eth_estimateGas`）。`viaFillTransaction` は **fill が成功したかどうか**で立てる（今の実装の
  「fill 以外の RPC を見たら偽」では block の読取で偽になる。`mpp-dynamic.ts:753-755` を直す。起動時の `verify` の試験も足す）。§1.3・§4 の容量の計算を R = 2 に改める:
  本番の最悪 `quote 10 × 2 + purchase 10 × (2 + 3 + 1)` = **80 > 60**（quote を 8 にしても 76）。同時に飽和したときは purchase の RPC が枠で `not_sent`／`fee_estimate_unavailable`
  になり得る（可用性の話で、§3.4 の分類は変わらない）。**動的の `limits.perAddressPerMinute` の既定を 60 → 100 にする**。これは RPC だけの緩和ではなく、
  宛先アドレスの枠全体の緩和である（ホスト名の枠は操作を数え、アドレスの枠は接続を数える。別名が同じアドレスに解決すれば合算される。`dynamic-gate.ts:261-298`）:
  第三者の 1 アドレスへ Router が張る接続は最大 100／分になる。本設計 §7.3 がこの枠に置いた目的は「Router を踏み台にした 1 宛先への負荷の上限」で、100／分（1.7／秒）はその目的の中に
  収まると判断する（ホスト名ごとの 10／分・同時 2、アドレスごとの同時 4 は変えない）。`dynamic-upstream-design.md` §7.3 の表を直す
- **署名の境界（§3.4 に追加）**: `pay` は credential を作る前に `eth_getBlockByNumber("latest")` を 1 回読み、`baseFee_now` を guard に渡す（RPC は block ＋ fill ＋ 送金の 3 回）。
  facade は SDK が提案した `maxFeePerGas`・`maxPriorityFeePerGas` を**写さず**、
  `maxPriorityFeePerGas = ROUTER_PRIORITY`、`maxFeePerGas = min(feePerGasOf(baseFee_now), capPerGas)`（`capPerGas = floor(cap × 10^12 / gas)`）で組み直す。
  `maxFeePerGas < baseFee_now` なら署名しない（`destination_signing_fee_over_limit`。取り込まれない transaction に署名しない）。`gas` はノードの提案のまま。
  既存の検査 `ceil(gas × maxFeePerGas / 10^12) ≤ cap` は組み直した値に対して**そのまま残す**（構成上必ず通るが、独立の門として）。送信の境界（raw の復号）は同じ値を照合し、
  `maxPriorityFeePerGas === ROUTER_PRIORITY` も確かめる
- **cap の性質は変わらない**: 呼び出し側が先に払う手数料 ≥ cap ≥ 署名する transaction の手数料の上限。変わるのは bound が他人の tip に連動しなくなること
- **`feeMargin` 2 倍は妥当**（観測 ①: baseFee の 10 分の最悪 1.24 倍）。gas が同じとして、quote 時の bound ≈ `gas × 2.4 × base₀ / 10^12`、cap ≈ 2 × bound、`capPerGas ≈ 4.8 × base₀`。
  purchase の再見積り（§1.4、settle の前）は現在の bound が cap を超える= `base_now > 2 × base₀` で `fee_too_high`。settle の後の署名では `feePerGasOf(base_now) > capPerGas`
  = `base_now > 2 × base₀` で clamp が始まり（それでも `maxFeePerGas = capPerGas ≥ base_now` なら取り込まれる）、`base_now > capPerGas ≈ 4.8 × base₀` で署名しない。
  観測の 1.24 倍はどちらにも遠い
- **権威の欄**: 手数料の決め方が変わるので `pricingPolicy` を `"gas-indexed-v2"` に上げる（MPP 送信だけ。v2 = priority 1 固定・24/10 の係数・capPerGas への clamp）。
  発行済みの v1 の quote は `quote_changed` で拒否される（配備の時点で MPP 送信は本番で未登録なので影響なし）。x402 送信の直列化は変えない（試験で固定）

### 8.3 前提と限界

- **前提「priority 1 でも取り込まれる」**: ノードの既定（最小 priority 0）・payment の分類・本番の 7 件の実績（§8.1 ③、ブロックの利用率 0.05%）に基づく。`maxFeePerGas ≥ baseFee` だけでは
  受理・取り込みの保証にならない: ノードの設定（最小 priority fee）とブロックの容量に依る。ブロックが混み合う状況（利用率が高い、mainnet）では tip が要る可能性があり、
  その場合は transaction が**取り込まれない**（手数料は発生しない。配達は `unknown` → 自動再送なし）。**mainnet の前提ではない**。
  本番で MPP 送信を有効にする前に、testnet で priority 1 の送金が通ることを G-2 と同じ形で 1 件確かめる（実送金。owner の承認が要る）。1 件の試行は混雑時の挙動を示さない
- fill の結果の手数料の欄は「返ってきた値が truthy のとき」だけ Router の値に置き換わる（`fillTransaction.ts:197-209`）。見積りは prepare の結果の `maxFeePerGas`・`maxPriorityFeePerGas` が
  **Router の値と一致すること**を確かめ、違えば失敗にする（ノードが欄を返さない等）
- 支払いでは SDK の prepare（ノードの提案の手数料）が署名の前に走るので、fill の段で失敗し得る（残高の検査など）。これは今と同じ
- ノードが `gas` を過小に提案すれば失敗して gas 分だけ請求される（§3.3 の「帰結」と同じ）
- `eth_getBlockByNumber` が 1 回増える。期限は見積りの予算（6 秒）・支払いの予算（20 秒）の中

### 8.4 変更するファイル（第 4 版で追加）

| ファイル | 変更 |
|---|---|
| `src/adapters/outbound/mpp-dynamic.ts` | `ROUTER_PRIORITY`・`feePerGasOf`。`estimateFee` が block を読んで手数料を渡し、結果の手数料が Router の値であることを確かめる。`viaFillTransaction` は fill の成功で立てる。`pay` が block を読み、guard が単価を組み直す。`checkFeeAndValidity` に `maxPriorityFeePerGas === ROUTER_PRIORITY`・`maxFeePerGas ≥ baseFee_now`・`≤ capPerGas` |
| `src/config.ts` | `limits.perAddressPerMinute` の既定を 100 に（`DEFAULT_DYNAMIC_LIMITS`。`dynamic-upstream-design.md` §7.3 の表を直す）。`pricingPolicy` を `"gas-indexed-v2"` に（MPP 送信だけ） |
| `tests/fixtures/dynamic/tempo-rpc.ts` | ノードの提案（priority・fill の maxFee）を試験から動かせるように |
| 試験 | wire: 提案が跳ねても見積りは baseFee だけで決まる（RPC 2／3 回、`viaFillTransaction` は fill の成否）、署名した raw の priority = 1・maxFee = feePerGasOf(baseFee)、baseFee が上がれば capPerGas に clamp、baseFee > capPerGas で署名しない、送信の境界が priority を照合、ノードが手数料の欄を返さなければ見積り失敗。unit: `pricingPolicy` v2 の指紋（v1 の quote は `quote_changed`、x402 は不変）、`perAddressPerMinute` の既定。統合: ノードの提案を跳ねさせた状態で quote → purchase が delivered、起動時の `verify` が block の読取で偽にならない |

### 8.5 独立レビューと観測の追記

（レビューは §6 に続けて記録する。ライブ観測②の最終の集計はここに追記する）
