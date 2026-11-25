# `/costs` の読み取りの移行 要件・設計・タスク v3

2026-11-25。オーナーの承認：準備から PR まで（同日）。**merge・deploy・有効化は別の承認**。
背景：settle facilitator の次の release は `/costs` の `items` を呼び出し側の行だけにし、service 全体の `summary` に `l1FeeMaxWei`、別に `budget` を足す。
[exact-pricing-design.md](exact-pricing-design.md) §3 と要件 R3・R4 のうち、この文書に書いた点を置き換える。価格の式・記録は変えない。
v1 は Codex（`gpt-6-astra`、CLI）の独立レビューで REVISE（MUST 4、SHOULD 2）。v2 は、覚え方を 1 つの状態表にし、失敗の後の期限と、断る場所（照会より前）を決め、受け入れを足した。v2 も REVISE（MUST 3、SHOULD 2）で、v3 は 1 回の読み取りで両方を同じ状態から返す形、2 つの時計、route ごとの適用にした。3 回目の REVISE（MUST 1、SHOULD 1）は反映済みで、直しの後の設計だけのレビューはしていない（実装のレビューで見る）。

## 1. 要件

- **C1** `l1` は `summary.l1FeeMaxWei`（先頭に 0 の無い 10 進の文字列、30 桁まで）だけから取る。**無い・null・形が違えば使えない**。`items` の行から補わない（前の release の応答も使えない）。
- **C2** `items` は配列で 500 行以下であることだけを見る。空でもよい。行の中身は読まない。
- **C3** 読むのは `?n=100`。本文の上限 256 KiB・3 秒・再試行なしは今のまま。
- **C4** 費用と別に、**自分の tenant**（Provider の URL の `/p/<id>` の `<id>`）の `budget` の項を読む。`accepting` が boolean の項がちょうど 1 つの時だけ値とする。
  配列でない・項が無い・2 つ以上・boolean でない時は「不明」。200 の応答でも、使える前の値を「不明」で置き換える。**`reason` と残りの数値は無くてよく、使わない**（`router-hosted` の応答には出ない予定。`accepting: false` に `reason` が無いこともある）。知らない欄は無視する。
- **C5** 費用の値と `accepting` は別々に判定する（費用が使えない応答でも `accepting: false` は効く）。どちらも chain id と token が一致した 200 の応答だけから取る。
- **C6（式の route。`budgetGate` とは独立）** `accepting` が true でなければ（false・不明）`pricing_unavailable`。費用の前の値は今と同じく 10 分まで使えるが、**`accepting: true` は読んだ時刻から 60 秒まで**なので、
  相手が 60 秒を越えて答えない（401 を含む）間、式の route は売らない。今の要件 R3（10 分まで使ってよい）より厳しい側。
  この契約は、式の route の今の動き（`budget` を見ない、前の release の応答で価格を作る）を**必ず**変える。
- **C7（固定の額の route だけのスイッチ）** 設定 `subethaExact.budgetGate: true` の時だけ、新しい注文を作る前に読み、**明確な false の時だけ** `source_offer_unavailable`・`settle_budget` で断る。不明・読めない時は今までどおり売る（`budget` は相手の助言で、最終の判断は settle の時）。
  欄が無い時は、固定の額だけの Router は `/costs` を読まない（今と同じ）。settle 先の token が無いのに `true` なら `ConfigError`。
- **C8** `settle_not_accepted:tenant_budget`・`settle_not_accepted:tenant_capacity` を既知の理由に足す。どちらも待たない（待つ長さは今と同じ。記録が `unrecognized` でなくなるだけ）。
- **C9** 既定は無効。hosted の生成される設定と子の env は今と byte 一致。有効化は `RAILS_ACTIVATION.subethaExact.budgetGate: true`（別の承認）。
- **C10** token・生の本文・URL・費用の値・予算の値を、記録・例外・一覧に出さない（今と同じ）。断る理由は固定の token だけ。
- **C11** 断るのは新しい offer だけ。発行済みの注文の支払い・照会・complete は続く。断った時は、読み取りの `GET /costs` を除き facilitator を呼ばず（上限の照会の sweep も含む）、ledger に行を足さない。

含まない：式の下限（`overheadRate`・`l1FloorWei`）の見直し、settle の 401 の後の送り直し、release の再試行の改善、残りの数値を使う先回り。

## 2. 設計

| 場所 | 変更 |
|---|---|
| `src/adapters/inbound/settle-costs.ts` | `parseSettleCosts`（C1・C2）、`parseTenantAccepting(json, expected, tenant)`（C4・C5）。`SettleCostsReader.read()` が `{ costs?, accepting? }` を返す（必要なら 1 回読み、**返す時点**の期限で両方を同じ状態から取り出す）。進行中の読み取りは共有する |
| `src/adapters/inbound/exact-pricing.ts` | `settleAcceptingOf`（固定の route だけ読む）。式は `read()` を 1 回だけ呼び、`accepting` が true で費用があり ETH の価格が使える時だけ、待ちを挟まずに計算する（C6） |
| `src/adapters/inbound/subetha-exact.ts` | 任意の option `settleAccepting(routeId)`。下の場所で呼び、`false` だけ断る（C7・C11）。例外は不明と同じ |
| `src/ports/inbound.ts` | `OfferRefusalDetail` と閉じた集合に `settle_budget` |
| `src/shared/settle-reasons.ts` | C8 |
| `src/config.ts`・`src/main.ts` | `budgetGate`。reader は式の route か `budgetGate` がある時だけ 1 つ作り、共有する。`settleAccepting` は `budgetGate` の時だけ渡し、**`pricing` の無い route の id にだけ読む**（式の route には undefined を返し、読まない。式の route は価格の段で見る） |
| `tools/remote-mcp-config.ts` | `budgetGate`（既定なし） |

**断る場所**：送信元ごとの上限・総数・毎分の検査（どれも手元だけ）の後、**未解決の上限の検査（`lookupSweep` を呼び得る）の前**。

**読み取りの状態**（1 つだけ）。「答え」= 200 で本文が読め、JSON で、chain id と token が一致。それ以外（401・429・5xx・redirect・時間切れ・大き過ぎる本文・JSON の不正・不一致）は「失敗」。

| 事象 | `accepting` | 費用 | 次に読みに行けるのは（単調な時計） |
|---|---|---|---|
| 答え | その応答の値（true・false・不明）で**必ず**置き換える | 使えれば置き換える。使えなければ前の値と**前の時刻**を残す | 読み取りの**開始**から 60 秒後 |
| 失敗 | 触らない | 触らない | 失敗の**終わり**から 10 秒後（429 は `Retry-After`、1〜300 秒） |

- **時計は 2 つ**：次に読みに行ける時刻は単調な時計（壁時計の逆行は効かない）。値の古さは、読み取りの開始からの**壁時計と単調な時計の経過の大きい方**で数える（逆行で失効した値が復活しない）。壁時計の経過が負の値は使えない。**1 度失効した値は捨てる**（後で時計が直っても復活しない）。記録に残る `costsAtMs` は壁時計。
- 使えるか：`accepting: true` は 60 秒未満、`accepting: false` は 10 分未満（失敗では消さない。次の答えで置き換わる）、費用は 10 分未満。
- `read()`：次に読みに行ける時刻を過ぎていれば 1 回読み（進行中なら待つだけ）、過ぎていなければ待たない。そのあと、今の状態から `{ costs?, accepting? }` を 1 度に取り出す。3 秒の時間切れは**読み取り全体**（DNS・headers・本文）を打ち切り、transport が中断に応じなくても必ず解放する。
- 壁時計が戻り値が使えない間は、次に読みに行ける時刻が来るまで「無し」と「不明」になる（最長 300 秒）。

## 3. 受け入れ

| # | 確かめること |
|---|---|
| A-1 | `l1FeeMaxWei` の正常値。無い・null・数・`"01"`・負・31 桁・前の release の形は使えない。行に大きい `l1Fee` があっても使われない。`items` が空でも使える |
| A-2 | `accepting` true・false・理由なし・数値なし・余分な欄。項が無い・2 つ・別の tenant だけ・boolean でない・配列でない・chain id か token が違うなら不明 |
| A-3 | 式：false と不明で断り、true で値が出る。費用が 10 分以内でも `accepting` が false になれば断る。`budgetGate` の有無によらない |
| A-4 | 固定：有効で false なら断り（`settle_budget`）、注文の作成・照会・sweep 0 回、ledger の行 0（**未解決の上限に達している時も**）。値の無い時の失敗（500・401・時間切れ）と不明の答えは売る。**false の答えから 10 分未満の失敗は断り**、10 分ちょうどで売る。無効（省略・false）なら固定の route は `/costs` を呼ばない。quote の入口と標準の入口の両方 |
| A-5 | 答えの間は 60 秒に 1 回、同時 100 件（式と固定の混在）で 1 回、`n=100`。失敗の後は 10 秒、429 は指定の秒数。費用が使えない答えの後も 60 秒は読まない。DNS で止まる・headers が来ない・本文の途中で止まる、のそれぞれで、待つ側が終わり、次の読み取りと次の注文ができる。3 秒後に返る 429（`Retry-After: 1`）の待ちは返った時から数える |
| A-6 | 状態：true→false、true→不明の答え（直ちに不明）、true→失敗（60 秒ちょうどで使えない）、false→失敗（10 分ちょうどで使えない）。費用の使えない `accepting: true` の答えが続いても、前の費用は 10 分で失効する。壁時計が戻った後に失敗が続いても、読む回数は待ちに従い、失効した値は（経過が正に見えても）復活しない。60 秒の境目で費用が上がった時は、上がった費用で計算する。読み取りの間に費用が 10 分を越えたら使わない |
| A-7 | 2 つの理由が既知になり、待たない |
| A-8 | 既定の hosted の設定が変わらない。有効にした時だけ 1 欄増える。token が無い `true` は `ConfigError`。固定だけ・式だけ・混在の 3 通り × 省略・false・true：固定の route の quote 1 回の読み取りは、true の時だけ 1、ほかは 0。式の route は常に 1（混在でも合計は共有で 1）。false の応答なら、固定は true の時だけ `settle_budget`、式は常に `pricing_unavailable` |
| A-9 | 断った後も、発行済みの注文の支払い・照会・complete が続く。token・本文・費用・予算の値が、記録・例外・一覧に出ない |
| A-10 | 非公開の契約の見本との照合は手元だけで行い、固定と式の両方の結果を確かめる（見本・期待値・識別子は repo に入れない） |

## 4. 未確認

相手の release は、本番の応答でまだ確かめていない（この作業の範囲外。この文書は本番の読み取り・deploy の承認を含まない）。`l1FeeMaxWei` が下がる方向の影響は、式の下限の見直しで扱う。
