# `subetha-exact`：settle を SubEtha 自前の settle facilitator に向ける準備 要件 v3

2026-11-24。branch `task/exact-settle-facilitator`（基点 `origin/main` `94bb0f1`）。要件の段階の成果物で、設計・実装は含まない。
入力：オーナーの承認（2026-11-24。範囲は §2、送信「最大 1 回」は保つ）、SubEtha の protocol main `71deb50` のコードと `docs/FACILITATOR-OPERATIONS.md` §15.22。
前提の文書：[subetha-exact-provider-settle-design.md](subetha-exact-provider-settle-design.md)（以下「settle 設計」）。この文書は、その R6・R7（認証情報なし）・§3.4・§3.7 の一部を変える。
v1 は Codex（`gpt-6-astra`、CLI）の独立レビューで REVISE（MUST 2、SHOULD 2）。v2 は全件を反映した（§7）。v2 の再レビューは、前回の 4 件を FIXED、新規 MUST 1（§7 の 5）。v3 はそれを反映した。v3 は単独の再レビューをせず、設計のレビューの入力に含める。
印：【事実】コードか文書で確かめた。【伝達】SubEtha の担当から聞いた。【未確認】確かめていない。【決定】この文書の要件。

## 1. 背景

- 今の Router は、注文を bind したあと、買い手の authorization を `https://www.x402.org/facilitator` に最大 1 回送り、結果を SubEtha の reconcile だけで決める【事実】。
- SubEtha は自前の x402 facilitator（settle facilitator）を持った。オーナーは、Router の settle をこれに向け、外部の facilitator を使わないと決めた（2026-11-24）【伝達】。
- 公開の名前は `https://settle-testnet.subethalabs.com`。通る path は `/settle`、`/verify`、`/supported`、`/costs` の 4 つ。**まだ稼働していない**【事実：§15.22 の手順、伝達：未実行】。

### 1.1 settle facilitator の答え【事実】（`apps/settle-facilitator/src/http.ts`・`engine.ts`・`state.ts`）

| 答え | 意味 |
|---|---|
| 401 `{ error: "unauthorized" }` | token が無い・違う。body を読まない |
| 429 `{ error: "rate-limited" }`、`Retry-After` | 呼び出し側の毎分の上限。body を読まない |
| 400／413 | JSON でない／大きすぎる |
| 200 `success: true` | tx が成功し、その中に支払いがあった（finalized の前に答え得る） |
| 200 `success: false`、`settle_not_accepted:<理由>` | 受け付けていない。この要求では何も送られない |
| 200 `success: false`、`settle_pending` | 受け付けたが 25 秒の中で結果が出ていない。**あとから成立し得る**。tx hash が付くことがある |
| 200 `success: false`、`settle_failed:<理由>` | この facilitator の最後の答え。tx hash が付くことがあるが、支払いの証拠ではない |

`settle_failed` でも、**支払いが成立している、または成立し得る**理由がある：
- `already-used`：送る前に authorization が chain で使用済みだった（ほかの送信者が先に載せた場合を含む）。
- `simulation-failed`、`no-transfer-in-settlement-transaction`、`transaction-failed-twice`：確認のあとに、ほかの送信者が先に載せた場合にも起こる。
- `cancelled`、`no-transfer-in-settlement-transaction`：finalized の前の仮の観測からも答える。reorg で観測が取り消されると、この facilitator は送信を続ける。

- 残り（`expired-in-queue`、`order-expired-in-queue`、`not-bound`、`oversized`、`cancelled-by-operator`）：この facilitator は送らないが、authorization はまだ有効なことがある
  （期限の 30 秒前に止める）。ほかの送信者が載せれば成立する。

つまり「この facilitator が送らない」と「支払いが成立しない」は別で、どの理由も後者の証拠にならない。
`success: true` と `settle_failed` は不変の答えだが、finalized の前の観測からも作られる。どれも注文の結果の証拠にしない。

### 1.2 今の Router をそのまま向けると起きること【事実】

1. `settle_pending` は 200・`success: false` なので「はっきり断った」と読まれ、reconcile は 1 回だけ。あとで成立する支払いが `unknown` で終わる。
2. `settle_failed` も reconcile は 1 回だけで、SubEtha の照合が追い付く前なら `unknown` で終わる。
3. 送り先の host が許可リストに無く、起動しない。
4. `Authorization` を付けないので、401 になる。その注文には送信の印が付き、もう送らない。
5. `settle_*` の理由は、記録では全て `unrecognized` になる。

## 2. 範囲

**含む**：送り先を向けられるようにするコード・設定・試験・文書。PR まで。
**含まない**：既定の送り先の変更、本番の env・token・切り替え、merge、mainnet、`/costs` と上乗せの式（(b)）、引き出し（(c)）、`/verify` の利用、再送、SubEtha 側の作業。

## 3. 要件

- **R1（送り先）** `settle-testnet.subethalabs.com` を settle 先として設定できる。https、port なし、query・userinfo・fragment なし、**path なし**（base は origin だけ。送り先は `/settle`）。
  env が無いときの既定は今の `https://www.x402.org/facilitator` のまま。
- **R2（token の組み合わせ）** settle 先の token は専用のファイルから読む（今の `readSecretFile` の規則：通常のファイル、0600、4096 byte 以下）。
  形は **小文字の hex 64 桁**（SubEtha の手順の形）。
  次の組み合わせは起動を止める：(a) 自前の host で token が無い、(b) x402.org の host で token がある、(c) settle 先の token が Provider token と同じ値、(d) 形が違う。
  loopback（fixture）では token は任意。
- **R3（token の行き先）** settle 先の token は settle 先の `POST /settle` にだけ付ける。SubEtha の tenant への要求には付けない。Provider token は settle 先に付けない。
  x402.org への要求には、今までどおり `Authorization` を付けない。redirect は今までどおり拒否する。
- **R4（秘密）** settle 先の token を、log、ledger、note、診断、例外、argv、config の file に写さない。env に置くのはファイルの path だけ。
- **R5（待つ答え）** 次の答えでは、`settle` 全体の予算（60 秒）の中で、reconcile が `pending` か答え無しの間、繰り返す（今の「成功」と同じ待ち方）。
  - `settle_pending`（200・`success: false`・完全一致）
  - `settle_failed:` の R8 の一覧の 10 個すべて（同上）
  `settle_not_accepted:*`、一覧に無い値、4xx は、今までどおり reconcile 1 回（受け付けていないので、この facilitator は送らない。
  その間にほかの送信者が載せる場合は残るが、今の x402.org が断った時と同じで、`unknown` と `mayStillSettleUntil` を返す）。5xx・読めない本文・例外は、今までどおり待つ。
  **この待ち方は、settle 先が自前の host（または、token のある fixture）のときだけ**。x402.org の答えの読み方は変えない。
- **R6（結果の出どころ）** `settled` と答える根拠は、SubEtha の reconcile の一致する `accepted` だけ。settle facilitator の `success`・`transaction`・理由は、待つ長さと記録にだけ使う。
- **R7（最大 1 回）** 1 つの注文について送るのは一生に 1 回まで（settle 設計 R3 のまま。オーナーの決定 2026-11-24）。401、429、`settle_not_accepted` のあとも送り直さない。
  settle facilitator は同じ支払いの再送を既存の件に結び付けるが、Router は使わない。
- **R8（記録）** 断った答えの理由を、`settle_pending`、`settle_not_accepted:<理由>`、`settle_failed:<理由>` の**固定の一覧**との完全一致で ledger に残す。一覧に無い文字列は今までどおり `unrecognized`、欄なし・`null` は `absent`、文字列でない・空は `malformed`。
  一覧：`settle_pending`；`settle_not_accepted:` の `out_of_scope`・`stopping`・`conflict`・`verify_unavailable`・`invalid_payment`・`bound_unreachable`・`not_bound`・`blocked`・`unavailable`；`settle_failed:` の §1.1 の 10 個。
  settle 先が x402.org のときの記録は変えない。
  生の文字列は残さない。一覧は protocol の版（commit）を明記する。x402 の SDK に由来する理由の表（`payment-reasons.ts`）の意味と版は変えない。
  4xx の本文（`{ error }` や、Cloudflare の JSON でない 429）は理由を持たない：status だけを残す。
- **R9（入れ替えと戻し）** env を外せば今の送り先に戻る。送り先を変えても、送信の印のある注文はもう送らない。ledger の行は、古い版が読んでも壊れない。
- **R10（hosted の入口）** host の env から、子の Router に URL と token のファイルの path を渡せる（値は渡さない）。どちらも無ければ、子の env と生成される設定は今と同じ。
- **R11（動的 URL）** settle 先の host は、動的 URL の拒否ホストに入る（今の仕組みのまま）。
- **R12（変えないもの）** 買い手に見える状態・code・時間の上限、`createOffer`・`preflight`・`verify`・`release`・`complete`、core、標準の x402 入口、SubEtha への要求、**token の無い構成の挙動**。
- **R13（文書）** README、`docs/DEPLOY.md` §2i に、設定、token の作り方と渡し方（SubEtha に渡すのは sha256 だけ）、切り替えと戻しの手順、確かめ方を書く。切り替えは、オーナーの別の go が要ると明記する。

## 4. 判断が要る点

**決定（オーナー、2026-11-24）：A。**

**D-1：60 秒を越えて成立した支払い。** settle facilitator は 60 秒より長く送信を続け得る（gas の高騰、上限、待ち行列）。その間に Router の購入は `unknown` で終わり、あとから reconcile で拾う処理は無い。
買い手は払ったのにデータが届かない。Router は上流に払っていないので、Router の持ち出しは無い（受け取った zUSDC は Provider の wallet に残る）。今の x402.org でも同じことは起き得る。

| 選択肢 | 内容 | 大きさ |
|---|---|---|
| **A（おすすめ）** | (a) では変えない。`unknown` と `mayStillSettleUntil` を今までどおり返し、運用者は inspect `--remote` で見つける。実際の件数を見てから決める | なし |
| B | 別のスライスで、`unknown` の購入をあとから reconcile し、`accepted` なら配達まで進める。core の終端の扱い、上流への支払いの条件（期限・予算・価格）、買い手の読み方を設計し直す | 大 |
| C | `settle` の予算を 60 秒より長くする。買い手の待ち時間と、標準入口・MCP・入れ替えの drain の上限に響く | 中 |

## 5. 受け入れ

- **AC-1** 自前の settle 先（fixture）で正しい購入：bind 1、`/settle` 1（settle 先の token 付き）、reconcile ≥ 1、`settled`。
- **AC-2** `settle_pending` のあと、reconcile が数回目に `accepted`：`settled`。予算の中で `accepted` にならなければ `unknown`。どちらも送信は 1 回。
- **AC-3** R8 の 10 個の `settle_failed` それぞれのあと、同じ authorization が chain に載り、reconcile が `pending` → `accepted`：`settled`。予算の中で `accepted` にならなければ `unknown`。送信は 1 回。
- **AC-4** `settle_not_accepted:*`、一覧に無い `settle_failed:*`、401、429（JSON と JSON でないもの）、400、413、418：reconcile は 1 回。一致する `accepted` でなければ `unknown`。送信は合計 1 回で、同じ注文の 2 回目の `settle` も送らない。
- **AC-5** 似た値（`settle_pending ` 、`SETTLE_PENDING`、`settle_pending:x`、`settle_failed:already-used:x`）：待たない。記録は `unrecognized`。
- **AC-6** `settle_pending`・`success: true` に tx hash が付き、reconcile が `accepted` にならない：`unknown`（`settled` にしない）。
- **AC-7** 送り先が x402.org のとき：`Authorization` なし、答えの読み方と記録は変更前と同じ（`settle_pending` という文字列が来ても待たない）。
- **AC-8** R1・R2 の起動の検査。エラーの文に、値（URL、token、path の中身）が出ない。
- **AC-9** 両方の token の canary が、log・ledger・journal・note・診断・例外・子の env・生成される設定に出ない。settle 先の token は SubEtha の fixture に届かず、Provider token は settle 先の fixture に届かない。
- **AC-10** hosted：2 つの env が無ければ、子の env と生成される設定が変更前と一致（今の golden）。あれば URL と path だけが渡る（token の値は渡らない）。組み合わせの検査は R2 のまま：URL だけの x402.org・loopback は起動し、token の無い自前の host と、token だけの設定は、固定の文で止まる（値は出さない）。
- **AC-11** Router の process を通した wire の試験（quote の入口と標準の x402 入口）で、`settle_pending` → `delivered`。再起動のあとも、同じ注文には送らない。
- **AC-12** `settle` 全体が予算を越えない（`settle_pending` が 25 秒かかった場合を含む）。
- **AC-13** R8 の一覧の全項目で、ledger の `submit` の行にその値が残る。欄なし・`null`・文字列でない・空・一覧に無い値も、R8 のとおり残る。生の文字列は ledger の file に出ない。
- **AC-14** 自前の host で送った注文（新しい理由の行を含む）は、URL の設定を x402.org に戻して起動し直しても、送信が 0 回。
  同じ ledger を基点版（`94bb0f1`）の ledger の読み手で開き、開けて、送信済みの索引にその注文があること（1 回きりの確認で、記録に残す）。
- 緑の試験は、守っている code を壊して落ちることを確かめる（待つ答えの判定、token の行き先、起動の検査、送信の印、`accepted` の条件）。
- 全体の `npm test` と typecheck。既知の flake は名前を挙げて分ける。

**この PR では確かめないこと**：本物の settle facilitator への購入、公開の名前への到達、本番の egress、まとめ送り。どれも、稼働の知らせとオーナーの go のあとに別の作業で行う。

## 6. 切り替えの前提（この PR の外）

1. SubEtha 側：公開の名前の稼働、呼び出し側（id `router`、tenants `["router-hosted"]`、毎分 120）の登録。
2. Router 側の運用者：token を **Router の host で**作り（32 byte、hex 64 桁）、sha256 だけを渡す。値を端末・argv・file・chat に出さない手順は `docs/DEPLOY.md` に書く。
3. Router の container から公開の名前への到達を確かめる（token なしで 401）。
4. オーナーの go のあと、本番の入れ替えと購入 1 件。手元の testnet の 1 件を先にするには、別の tenant と token が要る（`router-local` は削除の予定だった【伝達】）。ないなら、受付を 1 件分だけ開けた本番で確かめる（§2i の手順）。
5. Cloudflare の回数の制限（1 IP あたり 10 秒に約 20 回の案、未決【伝達】）。今の上限（作成は毎分 12、settle は注文ごとに最大 1 回）では越えない見込み。429 になった注文はもう送れない（R7）ので、制限を決める時は知らせてもらう。

## 7. 独立レビューの反映（v1 → v2）

| # | 指摘 | 反映 |
|---|---|---|
| 1 MUST | 仮の観測からの `settle_failed` でも成立し得る | §1.1、R5、AC-3。相手のコードを読み直し、ほかの送信者が先に載せる場合の 2 つ（`simulation-failed`・`transaction-failed-twice`）も足した |
| 2 MUST | AC-10 の「片方だけなら停止」が R2・R12 と矛盾 | AC-10 を R2 の宛先別の条件に合わせた |
| 3 SHOULD | 理由の一覧の受け入れが無い | R8 に一覧、AC-13 |
| 5 MUST（再レビュー） | 待たない理由（`expired-in-queue` など）でも、ほかの送信者の支払いが成立し得る | 一覧の `settle_failed` 10 個をすべて待つ（§1.1、R5、AC-3、AC-4）。失敗の答えが最大 60 秒遅くなるだけで、結果の決め方は変わらない |
| 4 SHOULD | 送り先の変更・旧版での 1 回の保証が受け入れに無い | AC-14 |
