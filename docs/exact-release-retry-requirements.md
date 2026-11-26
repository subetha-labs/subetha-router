# subetha-exact の release を facilitator の短い停止で諦めない — 要件 v3

対象: 受信レール `subetha-exact`（hosted の `md-zusdc-eth-snapshot`）の release（`POST /exact/orders/:id/release`）。
関連: `docs/subetha-exact-inbound-design.md` §3.7（予算）・§4.4（release）、`src/adapters/inbound/subetha-exact.ts` の `release()`、`src/adapters/inbound/subetha-exact-classify.ts` の `classifyReleasePost`・`classifyReconstruct`。

## 1. 問題（観測）

- 2026-11-25 の SubEtha 側の P3 の配備の間、facilitator の daemon が再起動した。その間の release は次のように終わった（SubEtha の運用セッションの報告。Router の要件として採る。Router 側の記録では確かめていない）:
  - **502**（daemon が止まっている）: 約 1 秒で `unknown`。
  - **503 + `Retry-After: 30`**: 予算の内に回復を待てず `unknown`。
- release が `unknown` の購入は、受信の支払いが成立した後に上流へ送らない終端（`paid_undelivered`、理由 `source_release_unknown`）になる（`src/core/orchestrator.ts` の release の分岐）。**買い手は払い、データは届かない。** 返金は無い。
- そのため P3 の配備の間は、運用者が新しい offer を止めて（`SUBETHA_EXACT_MAX_COMMITTED=0`）避けた。止めずに済むようにしたい。

## 2. 原因（コード）

`release()` の流れ（今。`src/adapters/inbound/subetha-exact.ts:644-713`）:
1. POST が 425 → 待って POST を再試行（予算の内、POST は最大 3 回）。
2. POST が 429・5xx・timeout・transport → **GET で状態を確かめる**（`probe("transport")`、GET は 1 回の機会につき最大 2 試行、間の待ちは `Retry-After` か無ければ 1 秒）。
   - GET が `release.state === "none"` → 待って POST を再試行（待ちは `Retry-After` か無ければ 2 秒）。
   - GET が自分の値の `authorized` → `released`（復元）。
   - **GET が 2 試行とも 429・5xx・timeout・transport → その場で `unknown`。**
3. POST が 409 `already-claimed` → `probe("claimed")`。GET が 2 試行とも一時的な失敗なら、やはり `unknown`。
4. 待ちは `Retry-After` を切り詰めずに守り、待った後に 1 秒以上残らなければその場で `unknown`。

観測の 2 つの形はこう説明できる:
- **502**: POST 502 → GET 502 → 1 秒待ち → GET 502 → 2 試行目なので `unknown`（約 1 秒）。
- **503 + 30 秒**: POST 503 → GET 503 → 30 秒待ち → GET 503 → `unknown`（約 30 秒）。2 回目の GET が `none` を返したときも、次の POST の前の 30 秒の待ちが残りの予算に収まらず `unknown` になり得る。

予算は `min(承認期限 − 今 − 5 秒, 60 秒)`（`subetha-exact.ts:651`）。hosted の承認時間は 120 秒なので、release の予算はふつう 60 秒。

## 3. facilitator 側の契約（`apps/facilitator/src/exact-routes.ts`、protocol main `ca55448` で確認）

- `POST /exact/orders/:id/release` は `beginRelease` を呼ぶ。**release の券は 1 回だけ**。2 回目以降は 409 `already-claimed` 等。
- Router はすでに 409 `already-claimed` を「復元」（GET で、自分の値の `authorized` なら `released`）として扱っている。**だから POST を繰り返しても二重の release にはならない**（応答を失った 1 回目の後の 2 回目は `already-claimed` → 復元）。
- release は資金を動かさない（受信の settle はその前に済んでいる。release は「上流へ渡してよい」の券）。

## 4. 要件

- **FR-1（一時的な失敗だけ続ける）**: GET の結果が**一時的な失敗**（例外 = timeout・transport、または HTTP 429・5xx）のときだけ、`unknown` で終えずに予算の内で続ける。
  - `transport` の経路（POST が一時的な失敗の後）: 待って **POST をやり直す**。
  - `claimed` の経路（POST が 409 `already-claimed` の後）: POST は何度でも 409 になるので、待って **GET をやり直す**。
  - それ以外の GET の結果は今までどおり、その場で終える（ただし次の行の `none` の規則が先）: 401・2xx 以外の決まった応答・読めない本文・binding や `deliveryKey`・`txRef`・`eventId` の不一致・`afterRelease` あり・`state` が `none` 以外で条件を満たさないもの。
  - `transport` の経路で `release.state === "none"` を「POST をやり直す」と読むのは今までどおり（照合より先）。`claimed` の経路では `none` は今までどおり `refused`。
- **FR-2（待ちの上限）**: 1 回の待ちに上限を設け、`Retry-After` がそれより長くても上限で切る（残りの予算の内にもう一度試せるように）。上限は POST の前の待ちと GET の前の待ちの両方に効く。`Retry-After` が無いときは、短い待ちから少しずつ延ばす。
  - **どのヘッダーを使うか**: 次の待ちは、**直前に受けた応答**（POST の後に GET をしたなら GET の応答）の `Retry-After` を使う。直前の試行が例外（応答なし）なら `Retry-After` は無いものとする。
  - **数列の位置**: 1 回の release の中で 1 本だけ持ち、待つたびに 1 つ進める（POST の前・GET の前・経路の移り変わりで分けない。`transport` から `claimed` へ移っても続きから）。`Retry-After` を使った待ちでも 1 つ進める。
- **FR-3（GET は 1 回の機会につき 1 試行）**: `transport` の経路の GET は 1 試行にする（分からなければ POST へ戻るので、GET を 2 回重ねる意味が無い。待ちが二重にならない）。`claimed` の経路の GET は、予算と下の回数の上限の内で繰り返す。
- **FR-4（回数の上限）**: POST の回数の上限を今の 3 回から増やす。`claimed` の経路の GET の回数にも上限を置く。予算（時間）と回数のどちらか先に尽きた方で止まる。
- **FR-5（予算の上限は今のまま）**: release の予算 `min(承認期限 − 今 − 5 秒, 60 秒)` の上限を増やさない。停止の無いときの流れ・時間は今と同じ。
  - 注: 1 回の購入の要求の最悪の時間（settle 60 秒 + release 60 秒 + 上流 + 成功のときも待つ complete 35 秒）は、公開の x402 入口の proxy の 170 秒（`src/mcp/x402-proxy.ts:222-225`）を超え得る。**これは今もある性質で、今回は増やさない**（release の上限を変えないため）。ただし停止の間は release が予算の終わりまで使う場面が増えるので、AC-8 で測る。
- **FR-6（二重にしない・資金を動かさない）**: settle・上流への支払いは今までどおり 1 回だけ。release の再試行は資金を動かさない。409 `already-claimed` は今までどおり復元へ。
- **FR-7（記録）**: `release` の行に次を残す。値・token は書かない。
  - `attempts`（POST の回数。今と同じ）、`probes`（GET の回数。新規）、
  - `httpStatus`（**最後に受けた HTTP 応答**の状態。今は最後の試行が例外だと消える → 消さずに残す）、`lastFailure`（最後の試行が例外なら `"transport"`。新規）、
  - `elapsedMs`（今と同じ: 通信にかかった時間の合計。待ちを含まない）、`wallMs`（release の開始から終わりまで、待ちを含む。新規）。
- **FR-8（変更の範囲と戻し方）**: 変更は adapter の `release()` と分類の関数、行の欄、設計 §3.7 の表、試験。公開の一覧・見積もりの文書・承認の対象（`subject`）・port の型・core は変えない。戻すのは、この変更のコミットを revert した image に入れ替える（journal の行の欄は足すだけなので、古い image でも読める）。

## 5. 決めていただく値（案）

| 値 | 今 | 案 | 理由 |
|---|---|---|---|
| release の予算 | 60 秒 | **60 秒（変えない）** | FR-5 |
| POST の回数の上限 | 3 | **8** | 下の待ちで 60 秒の内に入る回数（下の時系列） |
| `claimed` の経路の GET の回数の上限 | 2 | **6** | 同じく 60 秒の内 |
| 1 回の待ちの上限 | なし（`Retry-After` を切り詰めない） | **10 秒** | `Retry-After: 30` でも 60 秒の内に 6 回試せる |
| `Retry-After` が無いときの待ち | POST の前 2 秒、GET の前 1 秒 | **2 → 4 → 8 → 10 → 10 … 秒**（POST・GET 共通） | 短い停止はすぐ、長い停止は間隔を空けて |

**時系列（応答はすぐ返るとして）**
- 502 が続く: POST と GET（各すぐ失敗）を 1 組として、組の間の待ちが 2・4・8・10・10・10・10 秒。POST は 0・2・6・14・24・34・44・54 秒の **8 回**。
- 503 + `Retry-After: 30` が続く: 待ちは毎回 10 秒に切られ、POST は 0・10・20・30・40・50 秒の **6 回**。
- どちらも、停止が **約 50 秒以内**に終われば、その後の最初の POST（または GET で `none` → POST）が通る見込み。それより長い停止は今までどおり `unknown`（受付を止める運用は残る）。1 回の試行が遅い（timeout まで待つ）ときは回数が減る。

## 6. 範囲の外（今回はしない）

- **要求が終わった後の release の続き**（背景で release を続け、通ったら上流から取って `status` で渡す）。公開の x402 入口では接続が終わっているので渡せず、complete の意味も変わる。必要なら別の課題。
- complete の再試行（今は 35 秒・2 試行。起動時の掃き出しもある）と、購入の要求の全体の時間（FR-5 の注）。
- facilitator 側の変更。

## 7. 受け入れ条件

- **AC-1（502 からの回復）**: POST・GET が 502 を 20 秒返した後に回復する偽の facilitator で、release が `released`、購入が delivered。**変更の前のコードではこの試験が `unknown` で落ちる**こと（壊して確かめる）。
- **AC-2（503 + 30 秒からの回復）**: POST・GET が 503 + `Retry-After: 30` を 25 秒返した後に回復: 待ちが 10 秒で切られ、`released`。
- **AC-3（予算と回数）**: 停止が予算より長い → 予算で `unknown`。POST の回数・GET の回数が上限を超えない。承認期限が近く予算が 60 秒より短い場合、残りが 1 秒未満なら試行しない場合、遅い POST・GET（timeout）の場合、時間より先に回数の上限に達する場合のそれぞれで、上限と予算を守る。
- **AC-4（応答を失った後）**: 1 回目の POST が facilitator で成功し応答が失われ、続く GET も一時的に失敗 → 待って 2 回目の POST → 409 `already-claimed` → GET の復元で `released`。settle・上流への支払いは 1 回。
- **AC-5（`claimed` の経路の一時的な失敗）**: 409 `already-claimed` の後の GET が 2 回 502 の後に回復 → `released`。POST は 1 回だけ。
- **AC-6（決まった答えは続けない）**: `transport`・`claimed` の両方の経路で、GET の 401・読めない本文、および `state` が `authorized` で `afterRelease` あり・binding の不一致・`deliveryKey`／`txRef`／`eventId` の不一致のどれかでは、追加の POST も GET もせずに終わり、上流への支払いは 0 回。POST の `refused` の各コード・401 も今までどおり。
- **AC-6b（`none` の規則は今までどおり）**: `transport` の経路で GET が読める `none` を返したときは、binding の不一致や `afterRelease` が同居していても今までどおり POST へ戻る（照合より先）。`claimed` の経路の `none` は `refused`。
- **AC-6c（待ちの数え方）**: POST が timeout・GET が 503 + `Retry-After: 30` の組では次の待ちが 10 秒（GET の値を上限で切る）、POST が 503 + `Retry-After: 30`・GET が timeout の組では数列の値（2 秒など）。`transport` から `claimed` へ移った後の待ちが数列の続きであること。
- **AC-7（記録）**: `release` の行に `attempts`・`probes`・`httpStatus`（最後の試行が例外でも、最後に受けた応答の値）・`lastFailure`・`elapsedMs`・`wallMs`（待ちを含む）が入り、token・値が入らない。
- **AC-8（公開の入口での応答）**: AC-1 の形の停止を公開の x402 入口の経路（proxy を通る）で再現し、買い手に応答（delivered）が proxy の期限の内に届く。
- **AC-9（回帰）**: 期待の値を変える既存の試験（例: POST 3 回を期待する `tests/unit/subetha-exact-adapter.test.ts:616`）は新しい値に直したうえで、Linux の全体の試験が今までどおり通る。
