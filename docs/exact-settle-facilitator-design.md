# `subetha-exact`：SubEtha 自前の settle facilitator に向ける準備 設計・タスク v2

2026-11-24。要件は [exact-settle-facilitator-requirements.md](exact-settle-facilitator-requirements.md)（v3）。オーナーの決定（2026-11-24）：設計から PR まで続ける、D-1 は A（60 秒を越えた分は変えない）、送信は最大 1 回。
v1 は Codex（`gpt-6-astra`、CLI）の独立レビューで APPROVE WITH CHANGES（MUST 1、SHOULD 1）。v2 は反映した：AC-13 を adapter の試験（実際の ledger の file）にも入れ、4xx の本文は「読まない」ではなく「使わない」とした（読み取りは今の `exchange` のまま：64 KiB まで、期限の中）。

## 1. 1 つの軸：settle 先の token の有無

adapter は新しい任意の引数 `settleToken`（閉包）を受ける。**あれば「SubEtha の settle facilitator」として扱い、無ければ今のまま**。

| settle 先の host | token | 扱い |
|---|---|---|
| `www.x402.org`・`x402.org` | 無し | 今のまま（header なし、`classifySubmit`） |
| 同上 | あり | 起動を止める |
| `settle-testnet.subethalabs.com` | あり | `Authorization` を付け、`classifySubethaSettle` |
| 同上 | 無し | 起動を止める |
| loopback（fixture の能力があるときだけ） | 無し／あり | 今のまま／SubEtha の扱い |

要件 R5 の「自前の host（または fixture）」の fixture は、**token のある loopback** のこと（R12：token の無い構成の挙動を変えない）。

## 2. 変更

### 2.1 設定（`src/shared/subetha-exact.ts`・`src/config.ts`）
- 新しい env `ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE`（任意、空は無し）。
- `SUBETHA_EXACT_OWN_SETTLE_HOSTS`（`settle-testnet.subethalabs.com`）を足し、URL の検査はこの host も許す。この host だけは path が `/`（base は origin）。
- `parseSubethaExact` の中で、host と token の有無の組み合わせ（§1）を検査し、違えば `ConfigError`（固定文。値なし）。`SubethaExactConfig.settleTokenFile?` を足す。無いときは欄を出さない。
- 設定の全体に env が無い（`subetha-exact` を使わない）ときは、今の settle の URL と同じく読まない。

### 2.2 合成（`src/main.ts`）
- `settleTokenFile` があれば `readSecretFile` で読み、`^[0-9a-f]{64}$` でなければ `ConfigError`。Provider token と同じ値なら `ConfigError`。値は閉包だけに渡す。
- 読むのは adapter を作るときだけ（今の Provider token と同じ場所）。loopback の検査は今のまま先に行う。

### 2.3 adapter（`src/adapters/inbound/subetha-exact.ts`）
- `submitExternal` だけが `settleToken` を読む。`call`（SubEtha への要求）は読まない。
- 答えは `settleToken` の有無で `classifySubethaSettle`／`classifySubmit` に分ける。以後（待ち方、記録、reconcile）は共通。
- bind、送信の印、1 回だけの規則、時間の予算、`accepted` の条件は変えない。

### 2.4 答えの読み方（`classifySubethaSettle`、`subetha-exact-classify.ts`）

上から順に、最初に合うもの。

| 答え | wait | 記録 |
|---|---|---|
| 例外 | true | — |
| 4xx | false | status だけ（本文の内容は使わない。理由なし） |
| 200 でない、object でない、`success` が boolean でない | true | status だけ |
| `success: true` | true | `success`、`transaction`（32 byte の hex のとき） |
| `success: false` | 理由が `settle_pending` か `settle_failed:*` の一覧にあるとき true、ほかは false | `success`、`transaction`（同上）、`reason` |

### 2.5 理由の一覧（新しい `src/shared/settle-reasons.ts`）
要件 R8 の 20 個を固定の配列で持ち、出どころ（protocol `71deb50`、file）を注記する。`classifySettleReason(raw)` は完全一致で、その値か `absent`・`malformed`・`unrecognized`。
待つ理由は、同じ file の固定の集合（`settle_pending` と `settle_failed:*` 10 個）。前方一致は使わない。`payment-reasons.ts` は触らない。

### 2.6 hosted（`tools/remote-mcp-config.ts`・`tools/remote-mcp.ts`）
host の env `SUBETHA_EXACT_SETTLE_TOKEN_FILE`（任意、空は無し）を、子の `ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE` に渡す。組み合わせの検査は子の Router（今の URL と同じ）。無ければ子の env は今と byte 一致。

### 2.7 変えないもの
core、ほかの rail、`payment-reasons.ts`、ledger の形（`submit` の `reason` に新しい値が入るだけ）、既定の送り先、公開の定数。

## 3. 危険と守り

| 危険 | 守り |
|---|---|
| token を別の相手に送る | 付ける場所は 1 つ。host と token の組は起動時に検査。redirect は拒否（今のまま） |
| Provider token を settle 先に送る | `submitExternal` は Provider token を読まない。同じ値なら起動しない |
| 理由の文字列で支払い済みと誤る | 理由は待つ長さだけ。結果は reconcile |
| 待ちが増えて入れ替えの drain に響く | 予算は 60 秒のまま。待つ答えの種類だけが増える |
| 送り直し | 印・索引は変えない |

## 4. タスク

1. `settle-reasons.ts`、`classifySubethaSettle`、unit（AC-2〜AC-6・AC-13 の分類）。
2. URL・env・組み合わせの検査、合成、unit（AC-8）。`denyHosts`（R11）。
3. adapter。fixture（`/xfac` に token の検査と settle facilitator の答え）。unit（AC-1〜AC-7、AC-9、AC-12、AC-13：20 個の理由と異常な値を、実際に保存した ledger の file で）。
4. hosted の受け渡し。unit（AC-10）。
5. wire（AC-11、AC-14 の設定の戻し）。quote の入口と標準の入口。
6. 文書：README、`DEPLOY.md` §2i、settle 設計への注記。
7. 壊して落ちる確認、全体の試験、AC-14 の基点版での読み取り（1 回きり）、独立レビュー、PR。

## 5. 実装の独立レビューと確認（2026-11-24）

- Codex（`gpt-6-astra`、CLI、読み取りのみ）の実装レビュー：APPROVE WITH CHANGES（MUST なし、SHOULD 4）。4 件とも反映：AC-9 に診断の記録と送った process 自身の stderr、AC-14 に別の送り先、AC-12 の許容の幅、token のファイルの owner。
- 壊して落ちる確認：待つ答え、完全一致、4xx、token の行き先（3 通り）、token の有無の分岐、送信の印、`accepted` と identity の条件、起動の検査（5 通り）、hosted と合成の受け渡し、予算の数え直し、token の stderr・ledger への漏れ。全て試験が落ちた。
- AC-14 の基点版（`94bb0f1`）の ledger の読み手：新しい理由の行を持つ ledger を開け、`submitStarted` がその注文だけ true（一時の試験で 1 回。試験は残していない）。
- 確かめていないこと：本物の settle facilitator、公開の名前への到達、本番の egress、まとめ送り。
