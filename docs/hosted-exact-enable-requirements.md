# hosted の Router で受信レール `subetha-exact` と標準の x402 入口を、上限付きの実証として有効にする 要件定義 v3

対象: branch `task/hosted-exact-enable`（基点 `origin/main` `42f8a0d`）。要件フェーズの成果物であり、設計・実装は含まない。
入力はオーナーの決定（2026-11-21）: (1)「段階的に有効化まで」、(2)「hosted 用に新しく登録」（Provider を `router-local` と分ける）、(3)「A で進めて良いです」= **価格は今のまま、Router の持ち出しを予算で上限にし、採算は問わない実証**。
前提: `docs/subetha-exact-inbound-*`（PR #203）、`docs/x402-standard-entry-*`（PR #204）、段 3・段 4 の記録（`docs/subetha-exact-inbound-acceptance.md`）、本番の image `b-6aa3f20`（`docs/DEPLOY.md` §2h）。
v1 は Codex（`gpt-6-astra`、CLI、`.claude_workflow/local/hx-req-review1.md`）の独立レビューで **REVISE**（must-fix 9、should-fix 1、note 2）。v2 は全件を反映した（§8 に対応表）。v2 の再レビュー（`hx-req-review2.md`）は **REVISE**（前回の fixed 6・partly 6、新規 must 4・should 1）で、v3 はそれを反映した（§9）。v3 は単独の再レビューをせず、設計のレビューの入力に含める。
印: 【事実】出典付き。【推論】本書の考え。【未確認】確かめていない。【決定】本書の要件としての決め。

## 0. 目的と範囲

**目的**: 公開の Router（`https://router.subethalabs.com`）で、(a) MCP から `subetha-exact` の route を quote → 署名 → purchase で買えること、
(b) **手を加えていない標準の x402 v2 クライアントが公開の URL を GET するだけで買えること**を、上限の中で実証する。

| # | 内容 | 本スライス |
|---|---|---|
| S-1 | hosted の設定の生成に `subetha-exact` の静的 route を 1 本足す（スイッチ付き、既定は無効） | 対象 |
| S-2 | 公開の入口（MCP の ingress）に、標準入口の HTTP の経路を 1 つ足す | 対象 |
| S-3 | hosted 用の上限（facilitator への要求の枠、Router の持ち出しの予算、送信元ごとの頻度） | 対象 |
| S-4 | hosted 用の Provider の登録（`router-local` と別。wallet・token は別） | 対象（運用の手順。オーナーの AWS login が要る） |
| S-5 | 配備: 無効のまま入れ替え（G-3）→ 有効にして入れ替え（G-4）→ 公開での受け入れ | 対象 |
| S-6 | 採算（価格の見直し、withdraw の consolidate）、mainnet、他の rail の標準入口、`@subetha/payer` の対応 | 対象外 |
| S-7 | 上限に達した後の自動の回復・自動の増枠 | 対象外（止まるのが仕様。上げるのは運用者の判断） |

## 1. 前提の事実

- **hosted の作り**【事実】: Router の公開の入口は MCP の ingress（`POST|DELETE /mcp` と `GET /healthz`。それ以外は 404）。Caddy は `/evm-facilitator/*` だけを別の port（8611）へ、それ以外を ingress（8787）へ渡す（`docs/DEPLOY.md:670-677` の設定例。host の現物との一致は G-3 の前に読んで確かめる）。Router 本体は子 process で、loopback の任意の port に listen し、
  ingress の中の MCP server が principal `judge`（token は固定の公開値）で呼ぶ。`ROUTER_CANONICAL_BASE_URL` は `http://127.0.0.1:8500`（`src/mcp/ingress.ts:158-215`、`tools/remote-mcp.ts:249, 678`）。
  したがって**今の hosted には、標準入口（Router 本体の `GET /x402/v1/routes/{id}/resource`）に外から届く道が無い**。また hosted の買い手は全員が同じ principal を共有する。
- **設定の生成**【事実】: hosted の route・予算・子の env は `tools/remote-mcp-config.ts`／`tools/remote-mcp.ts` が定数 `RAILS_ACTIVATION` から作る。rail ごとのスイッチを `true` にして image を作り直し、`deploy/swap-image.sh` で入れ替える（`tools/remote-mcp-config.ts:260-276`）。
- **枠**【事実】: adapter の既定は総数 100・未解決 3・毎分 6。払われない 402 は注文を 1 つ作り、注文の期限（hosted の facilitator では 300 秒）+ 猶予まで未解決の枠を、総数の枠を恒久に 1 つ使う。枠が尽きると 503（`docs/x402-standard-entry-requirements.md` §1、D-10）。
  段 4 の実測: 注文の作成 0.7〜1.1 秒、402 → 200 は 5.0〜7.5 秒（`docs/subetha-exact-inbound-acceptance.md` §3.1、§3.3）。
- **持ち出し**【事実】: 1 件で買い手は 12,000（zUSDC）を払い、Router は上流に 10,000（Base Sepolia USDC）を払う。withdraw は 1 note から 1 回で、手数料は約 8,900。1 件から引き出せるのは約 3,000（同 §3.1）。
  hosted の送信の鍵（`SUBETHA_OUTBOUND_X402_KEY`）の USDC が Router の持ち出しになる。
- **facilitator**【事実。記録の時点】: hosted の facilitator の Provider の枠は 6 のうち 3 が使用中（2026-11-21）。自己登録は招待コード・probe・activate（`docs/subetha-exact-inbound-acceptance.md` §2）。
- **秘密の置き場所**【事実】: adapter は Provider token を「0600 ちょうど・通常のファイル・4096 byte 以下」のファイルから読む（`src/main.ts` の `readSecretFile`）。本番の container は volume `/var/lib/subetha-router` → `/app/runtime` を持ち、uid は 10001（`docs/DEPLOY.md` §2h）。
  adapter の ledger は journal と同じ directory の下（`<journalDir>/subetha-exact/`）で、volume に残る。
- **drain と入れ替え**【事実】: 入れ替えは **先に Caddy を止め**（公開のクライアントの接続はここで切れる）、その後 container に SIGTERM を送る（`deploy/swap-image.sh:186-199`）。ingress は進行中の要求の数が 0 になるのを**上限付きで**待ち、子の終了まで確かめて `drain: complete` を出す。上限を過ぎれば `drain: timeout` で、script は入れ替えをやめて戻す（`tools/remote-mcp.ts:575-594`）。
- **予算**【事実】: 今の予算は、静的購入の全体で共通の件数（`maxPurchases`）と、資産ごとの累計・1 件の上限（`buckets`）。route ごとの上限は無い。**予約は verify が通った後**（`src/core/budget.ts:1, 191`、`src/core/orchestrator.ts:1068, 1133`）。
  つまり予算で断られる時点では、買い手の署名は既に facilitator に渡っている。新しい route は既存の Base Sepolia USDC の送信の区分を使う（`tools/remote-mcp-config.ts:809, 820`）。
- **送信元の決め方**【事実】: MCP の入口は `X-Forwarded-For` の**末尾**を送信元にする（`src/mcp/server.ts:257-270`）。ingress は loopback にだけ bind し、Caddy が末尾に接続元を足すので、Caddy の後ろでは末尾は買い手が偽れない【推論。host の Caddy の設定で確かめる】。
- **枠の意味**【事実】: adapter の `limits` は**注文の作成の試行**の枠で、verify・settle・release・照会の回数は数えない。毎分の枠は時間で戻り、未解決の枠は注文の期限 + 猶予で戻り、総数の枠は戻らない（`src/adapters/inbound/subetha-exact.ts:279-287, 443-456`）。
- **無効にしたときの後始末**【事実】: facilitator の設定（URL・token）が無いと adapter は登録されず、残った注文の complete の報告も照会もできない（`src/main.ts:1014, 1049-1051`）。route が設定から消えても adapter が登録されていれば、`ownsOffer` で complete は届く（前スライスの設計 §2）。
- **inspect**【事実】: image に道具と npm script は入っている（`Dockerfile:51-55`、`package.json:21`）。実行には journal の path と facilitator の env が要る（`tools/subetha-exact-inspect.ts:304, 328-338`）。遠隔の照会ができない注文は `unavailable` で、不一致とは別に数える（同 `:193, 222-227`）。

## 2. 決めたこと（要件の水準）【決定】

| # | 問い | 答え |
|---|---|---|
| H-1 | 何を出すか | 静的 route 1 本: 受信 `subetha-exact`（Base Sepolia zUSDC、12,000）→ 送信 x402（Provider A、Base Sepolia USDC、10,000）。スイッチ `RAILS_ACTIVATION` の新しい欄で、**既定は無効**。 |
| H-2 | 標準入口の公開 | 公開の origin に **`GET /x402/v1/routes/{routeId}/resource` だけ**を足す。ingress が子の Router の同じパスへ渡す。principal は ingress が付ける（買い手は認証しない）。それ以外のパス・method は今までどおり 404／405。 |
| H-3 | 買い手に見える URL | 402 の `resource.url` と一覧の `x402Url` は**公開の origin**（`https://router.subethalabs.com/...`）を示す。loopback の URL を出さない。既存の route の一覧の他の欄は変えない。 |
| H-4 | 上限 | **戻らない上限**: (a) 注文の作成の総数、(b) 実証の件数のうち**確定して使った分**（Router が settle を始めた、または結果が分からない購入。Router の持ち出し = 件数 × 10,000 の上限になる）。達したら新しい offer は 503 で、運用者が定数を上げて image を入れ替えるまで戻らない（S-7）。実証の件数は、まだ結果の決まっていない offer も**一時的に**占める（FR-3.2）。**時間で戻る上限**: (c) 毎分の作成、(d) 未解決の注文の数（どちらも 503 + `Retry-After`）、(e) 送信元ごとの作成の頻度（429 + `Retry-After`）。値は設計が決め、オーナーが定数で変えられる。上限は**新しい注文の作成**を止めるもので、発行済みの注文への支払い・結果の読み取りは止めない。 |
| H-5 | Provider | hosted 用に新しく登録する（id は `router-local` と別）。wallet の鍵と POS key は**本番の host に置かない**。host に置くのは token のファイルだけ（0600、container の uid の所有）。 |
| H-6 | 入れ替えの安全 | 標準入口の要求も ingress の drain の数に入り、drain は今と同じ上限付きで待つ。上限を過ぎたら入れ替えをやめて戻す（今の script のまま）。入れ替えで公開のクライアントの接続が切れても、進行中の購入は Router の中で終わりまで進み、結果は同じ credential の再送か `paymentId` で読める。スイッチが無効のとき、公開のパスは 404 のまま。 |
| H-7 | 開示 | 一覧と README・llms の記述で、実証であること、上限があり尽きたら止まること、承認の段が無いこと（標準入口）、zUSDC を払ってよい資産に足す設定が要ることを言う。 |
| H-9 | 状態は 3 つ | **(i) 完全に無効**（スイッチ `false`。今と byte 一致。G-3）、**(ii) 有効**（スイッチ `true`、実証の件数の上限 N > 0）、**(iii) 新規の受付だけ止める**（スイッチ `true`、**上限 0**）。(iii) は別のスイッチではなく上限の値で表す。G-4 の後に止めるときは (iii) を使う。

| 操作 | (i) 完全に無効 | (ii) 有効 | (iii) 受付停止 |
|---|---|---|---|
| 一覧に route が出る | 出ない | 出る | 出る（受付停止の注記付き） |
| 新しい offer（MCP の quote、標準入口の支払いなしの GET） | 無い（`unknown_route`／404） | 出る | 503（注文を作らない） |
| 発行済みの注文への支払い（`PAYMENT-SIGNATURE` 付きの GET、MCP の purchase） | 無い | できる | できる（受付停止の前に出た offer は期限まで払える） |
| 同じ credential の再送で結果を読む | 無い | できる | できる |
| `paymentId` で結果を読む（MCP の status） | できる（今と同じ） | できる | できる |
| 残った注文の complete の報告・inspect の照会 | **できない** | できる | できる |
| H-8 | 段階 | G-2（手元で hosted の入口を起動して受け入れ）→ G-3（無効のまま image を入れ替え、公開が今と同じことを確かめる）→ G-4（有効にして入れ替え、公開で受け入れ）。各段の後にオーナーへ報告。G-4 の入れ替えはオーナーの go を取る。 |

## 3. 機能要件

### 3.1 設定の生成とスイッチ

- **FR-1.1** `RAILS_ACTIVATION` に `subethaExact: { inbound: boolean }` を足す（H-9 の (i) と (ii)／(iii) を分けるスイッチ。(ii) と (iii) の違いは実証の件数の上限の定数）。欄が無い・`false` なら、生成される設定・子の env・公開の一覧は**今と byte 単位で同じ**（golden の試験）。
- **FR-1.2** `true` なら: route 1 本（H-1）、zUSDC の予算の区分、adapter の上限（H-4 (a)）、子の env（facilitator の tenant の URL と token のファイルのパス）が出る。
  host の env に必要な値（tenant の URL、token のファイルのパス）が無ければ、**起動の前に固定文で止まる**（値は出さない）。
- **FR-1.3** 既存の rail の route・プロファイル・予算は変わらない（追加だけ）。

### 3.2 公開の標準入口（ingress）

- **FR-2.0（判定の順）** 無効・対象外の route・形の違うパスは、ヘッダーの検査・頻度の制限より**先に** 404（存在を足さない。今の「それ以外は 404」と同じ本文）。
- **FR-2.1** ingress は `GET /x402/v1/routes/{routeId}/resource` を受け、子の Router の同じパスへ 1 回だけ渡す。**渡す先は ingress が持っている子の Router の address と、設定にある対象の routeId から組んだパスに固定**で、要求の `Host`・絶対 URL の request-target・符号化した区切り（`%2F`・`%5C`）・dot segment・redirect で変えられない（子の応答の redirect は追わない）。渡す要求のヘッダーは `PAYMENT-SIGNATURE`（あれば 1 つ）と ingress が付ける principal の 2 つ（とその認証）だけ。
  買い手の `Authorization`・`X-Router-*`・`X-PAYMENT`・その他のヘッダーは渡さない。`X-PAYMENT` を持つ要求、`PAYMENT-SIGNATURE` の重複・過大は ingress が 400 で拒む（子の規則と同じ結果）。
- **FR-2.2** 応答は status・本文と、`PAYMENT-REQUIRED`・`PAYMENT-RESPONSE`・`X-Router-Payment-Id`・`Retry-After`・`content-type`・`cache-control` だけを返す。子の他のヘッダーは返さない。
- **FR-2.3** クエリ付き・本文付き・`GET` 以外は、子に渡さずに拒む。`routeId` は設定にある対象の id との**完全一致**だけを通す。
- **FR-2.3b（量の上限）** この経路にも、ヘッダーの全体の量、受信の時間、同時に処理する数、応答を読まない相手への書き込みの時間の上限がある（今の ingress の上限の考え方に合わせる。`src/mcp/ingress.ts:15-36`）。
  `PAYMENT-SIGNATURE` を付けた要求は送信元ごとの作成の頻度（FR-3.3）の対象外だが、**無制限ではない**: 形の悪い署名ヘッダーを大量に送る相手は、同時処理の上限と別の頻度の上限で抑える。
- **FR-2.4** スイッチが無効、または対象の route が無いとき、このパスは今の「それ以外は 404」と同じ応答になる（存在を足さない）。
- **FR-2.5** ingress が自分で作る応答の規則。`PAYMENT-SIGNATURE` を子に渡した後で、子の応答を得られない全ての場合（期限、子の切断、本文の途中の切断、内部の例外、形の合わない子の応答）に当てはまる:
  応答を書き始める前なら、**402 でも 200 でもない固定の応答**で「結果は分からない。未払いの証明ではない」と言い、やり直しを促さない。応答を書き始めた後（ヘッダーを送った後）なら接続を切る。どちらでも challenge も再署名の案内も出さず、`rejected`・未払いと読める形にしない。
  `PAYMENT-SIGNATURE` の無い要求で子が答えない場合は、固定の 503（注文ができたかどうかは分からない。**この要求によって** Router が支払いを始めることはない。既にある注文が未払いであることの証明ではない）。
  （支払い付きの要求への応答に challenge を載せない規則 = `docs/x402-standard-entry-requirements.md` D-9 は、ingress が作る応答にも当てはまる。）
- **FR-2.6** 1 件の要求の時間の上限は、購入の最長（verify + settle + release + 上流）を覆う。今の MCP の purchase と同じ上限を使う。
- **FR-2.7** drain: 標準入口の要求は ingress の数に入り、drain の開始の後の新しい要求は 503 で断る（今の規則と同じ）。

### 3.3 上限

- **FR-3.1（注文の作成の枠）** hosted の設定は adapter の `limits`（総数・未解決・毎分）を明示する（既定に頼らない）。総数が尽きたら MCP の quote も標準入口の 402 も 503 で止まり、運用者が定数を上げて image を入れ替えるまで戻らない。毎分と未解決は時間で戻る（503 + `Retry-After`）。
  どの枠が尽きていても、**発行済みの注文**への支払い（`PAYMENT-SIGNATURE` 付きの GET、MCP の purchase）と結果の読み取りは今までどおり動く。
- **FR-3.2（実証の件数 = 持ち出しの上限）** この route だけの**購入の件数の上限**を持つ（今の予算には route ごとの上限が無いので足す）。
  (a) **offer を出す前に見る**: 上限に達していれば、MCP の quote も標準入口の 402 も出さない（503。注文も枠も使わない）。数に入るのは、発行した offer のうち
      「**今後その offer から Router の settle・上流への支払いが起こらないと、永続的に確定していないもの**」の全て。内訳は 2 つ:
      **確定して使った分（戻らない）** = Router が settle を始めた購入（結果が settled・拒否・unknown のどれでも）と、どこまで進んだか分からない購入。
      **一時的に占めている分（戻る）** = まだ払われていない offer と、verify の前後で止まり Router が settle を始めていないもの。これは「その offer ではもう Router が settle を始めない」と確定したとき（受付の期限が過ぎた、または終端の記録が付いた）に数から外れる。分からなければ外さない。
      数から外れることは**未払いの証明ではない**（Router が見ていない署名済みの authorization は存在し得る。外すのは「Router の持ち出しが起こらない」ことだけを根拠にする）。
      発行の途中のもの（注文を作っている最中）も数に入り、**残り 1 枠で MCP の quote と標準入口の GET が同時に来ても、出る offer は 1 つ**。発行済みの offer が全て買われても上限を超えない。
      数の判定に要る事実（発行、credential の結び付け、settle の開始、終端、受付の期限）は journal から復元でき、再起動で数が変わらない。
  (b) **既存の予算はそのまま最後の守り**: verify の後の予約（今の仕組み）は残る。そこで断られた場合、買い手の署名は既に facilitator に渡っているので、Router は「settle を始めていない」と言えるだけで、**未払いの証明ではない**（開示は今の規則）。(a) により、この route がここで断られるのは既存の route との共有の区分が尽きた場合だけ。
  (c) 既存の route への影響: この route は共通の件数と Base Sepolia USDC の送信の区分を使う。実証の上限 × 10,000 が、その区分に対して占める割合を設計が示し、既存の route の枠を食い尽くさない値にする（必要なら区分の上限を足す。既存の値は減らさない）。
  (d) 数は journal から導くので、再起動で変わらない。
- **FR-3.3（送信元ごと）** **この route の注文の作成**は、送信元ごとに頻度を抑える。標準入口の支払いの無い GET と、MCP の quote の**両方**に同じ数え方で効く（片方で迂回できない）。超えた要求は 429 + `Retry-After`（MCP では今の `rate_limited` の形）で、注文を作らない。
  送信元は「信頼する proxy（Caddy）が足した接続元」だけから決め、買い手が送ったヘッダーの値で枠を増やせないこと（ingress は loopback にだけ bind する。host の Caddy の設定を G-3 の前に読んで確かめ、違えば止める）。
  1 つの送信元が同時に占められる数にも上限を置き、**1 つの送信元だけでは全体の未解決の枠を全部は埋められない**ようにする。数えるのは「その送信元から始まり、全体の未解決の枠を占めている注文と作成の試行」
  （offer が返らなかった作成の試行、支払いの処理中、unknown を含む。credential を出しただけでは外れない）。標準入口と MCP の同時の要求、作成の応答の喪失、再起動の後でも成り立つこと。
  残る危険（§6）: 複数の送信元、共有の NAT の後ろの買い手どうしの取り合い。
- **FR-3.4** 上限の値と、達したときの挙動を `docs/DEPLOY.md` に書く。

### 3.4 MCP

- **FR-4.1** 有効なとき、`subetha_router_list_routes` はこの route を出す（`rail: "subetha-exact"`、`fundsMoveOnCredential: false`、`x402Url` は公開の URL）。quote → `npm run sign` → purchase は今の MCP の道具でそのまま通る。
- **FR-4.2** MCP の quote もこの route では facilitator の注文を作るので、同じ枠を使う（FR-3.1）。MCP の案内（`nextStep`・サーバの説明）に、この route の注意を 1 つ足す（H-7）。

### 3.5 Provider と秘密

- **FR-5.1** hosted 用の Provider は、新しい EOA・新しい POS key で登録する。登録の道具・招待・probe は段 3 と同じ手順。記録は acceptance の文書に、秘密なしで残す。
- **FR-5.2** token のファイルは host の volume の下の専用の directory（0700）に 0600 で置く。container の uid が読めること。image・env の値・ログ・journal・診断の記録・応答に token が出ないこと。確かめ方は**件数か成否だけを出す**照合で、token を argv・shell の履歴・trace・検査の出力に載せない。host へ運ぶ途中の一時ファイルも 0600 で、置いた後に消す。
- **FR-5.3** wallet の鍵・POS key・view key は host に置かない。受け取りの確認と withdraw は運用者の手元で行う。

## 4. 非機能要件

- **NFR-1（退行なし）** スイッチが無効の image は、公開の一覧・既存の購入・ingress の応答が今と同じ（G-3 で一覧の一致と購入 1 回を確かめる）。
- **NFR-2（秘密）** FR-5.2。加えて、`PAYMENT-SIGNATURE` の値と署名を ingress のログに出さない。
- **NFR-3（rollback）** 今の本番の image（`b-6aa3f20`）には既に `subetha-exact` と標準入口の code がある（`docs/DEPLOY.md` §2h）ので、journal の行は読める。ただし G-4 で注文を作った後に「完全に無効」の image へ戻すと、残った注文の complete の報告と照会ができなくなる（§1）。
  したがって G-4 の後に止めるときは H-9 (iii)（上限 0 = 新規の受付だけ止める image）を使う。「完全に無効」へ戻すのは、未報告の complete と未解決の注文が無いことを inspect で確かめた後だけ。
- **NFR-4（testnet だけ）** 対象は testnet。資産の表と上限（1 件 20,000 以下）は今のまま。

## 5. 受け入れの条件

- **AC-1（生成）** スイッチ無効: 生成物が今と byte 一致。有効: route・予算・limits・子の env が期待どおり。必要な env が無ければ起動の前に止まり、固定文に値が無い。
- **AC-2（ingress、合成）** 手元で hosted の入口（`tools/remote-mcp.ts`）を合成 facilitator に向けて起動し、**実物の `@x402/fetch` が ingress の公開のパスだけで買える**（Router の principal を知らない）。`resource.url` は公開の origin。
  渡らないヘッダー（`Authorization`・`X-Router-*`）、返らないヘッダー、400／404／405／429／503 の各場合、支払い付きの要求への応答が 402 でないこと。パスの細工（符号化した区切り・dot segment・絶対 URL・別の `Host`）が 404 で、子に届かないこと。
  `PAYMENT-SIGNATURE` を渡した後に子の応答を失う各場合: 応答を書き始める前（期限、子の切断）は固定の「結果は分からない」の応答、書き始めた後（本文の途中）は接続の切断。どちらも 402 でなく challenge を持たない。その購入の結果は同じ credential の再送で読めること。
- **AC-3（上限、合成）** 送信元ごとの頻度が標準入口と MCP の quote の両方に効く（429、注文が増えない。偽の `X-Forwarded-For` で増えない）、1 つの送信元だけでは未解決の枠を埋められない、未解決の枠（503 + `Retry-After`、時間で戻る）、総数（503、戻らない）、
  実証の件数（offer を出す前に 503。残り 1 枠で MCP の quote と標準入口の GET を同時に出しても offer は 1 つ。発行済みの offer を並行に全部買っても上限を超えない。期限切れ・verify の拒否と失敗・記録の前の停止のそれぞれで、数が規則どおりに保たれる／外れる。再起動の後も同じ数）。
  送信元ごとの占有の上限が、標準入口と MCP の同時の要求・作成の応答の喪失・再起動の後でも効く。どの枠が尽きていても、発行済みの注文への支払いと結果の読み取りは通る。支払い付きの要求は作成の頻度で止まらないが、形の悪い署名ヘッダーの連投は抑えられる。
- **AC-4（入れ替えの途中の購入、合成）** 実際の入れ替えの順を再現する（合成の試験は切断の模擬。**proxy を通した実際の入れ替えの途中の購入**は本番では試さない: 入れ替えは購入の無いときに行う運用であり、G-4 の入れ替えの記録に「進行中の要求 0」を残す）: 標準入口の購入の途中で**クライアントの接続を切り**（Caddy の停止に当たる）、その後 SIGTERM。子は購入を終わりまで進め、ingress は `drain: complete` を出す。再起動の後、同じ credential の再送が結果を返し、settle と上流への支払いは 1 回。
  drain の上限を過ぎる場合: `drain: timeout`（入れ替えはやめる）。そのまま止められた購入は、前スライスの復旧の規則どおり unknown として残り、再起動の後に 2 回目の settle・支払いが起きない。drain の開始の後の GET は 503。
- **AC-5（G-2、手元・実 network）** 手元の hosted の入口を testnet の facilitator（hosted 用の Provider）に向け、標準クライアントで 1 回、MCP の quote の入口で 1 回 `delivered`。
- **AC-6（G-3、本番・無効）** 入れ替えの前後で公開の一覧が一致、`GET /x402/v1/routes/…` が 404、既存の route の購入 1 回が `delivered`。host の Caddy の設定（どのパスがどこへ行くか、`X-Forwarded-For` の扱い）を読んで §1 の前提と一致することを記録する。
- **AC-7（G-4、本番・有効）** 公開の HTTPS で: 標準クライアントで 2 回以上、MCP の quote の入口で 1 回、払わない 402 を 1 回。購入ごとに**別々に**記録する: クライアントの署名が 1 回、本文を受け取った、受信の settle の tx と上流への支払いの tx、保存した結果の再読（`paymentId`）、finality（後から照合）。
  container の中の inspect（journal の path と facilitator の env を明示したコマンド）で、**予定した件数の注文が全て観測でき**（`unavailable` 0）、不一致 0。token の照合は件数だけ（FR-5.2）。egress の検査が通る。
- **AC-7b（止め方、本番）** G-4 の実データのまま H-9 (iii)（上限 0）の image に入れ替える: 新しい offer は MCP でも標準入口でも 503（注文が増えない）、G-4 の購入の状態が `paymentId` で読め、**公開の標準入口への同じ credential の再送**が記録を返し、inspect の照会ができ、枠の数が保たれ、2 回目の settle が起きない。その後 (ii) の image に戻して実証を続ける（または止めたままにする。オーナーの判断）。
- **AC-8** 既存の全試験が通る。

## 6. やらないこと・残す危険

- **枠の枯渇**: 誰でも支払いなしの GET（または MCP の quote）で注文を作れる。送信元ごとの制限（FR-3.3）で 1 つの送信元の独占は抑えるが、複数の送信元からの要求は未解決の枠を埋め、総数の枠を恒久に使う。尽きたら実証は止まる（S-7）。共有の NAT の後ろの買い手は 1 つの送信元として数えられる。
- **facilitator の側の上限**: hosted の facilitator が 1 つの tenant に課す注文の上限は repo からは分からない（Provider の登録の枠 3/6 とは別）。G-2 で観測し、Router の枠がそれを超えない値であることを有効化の前に確かめる。
- **持ち出し**: 1 件ごとに Router の USDC が 10,000 減り、引き出せるのは約 3,000。上限は予算で決まる（H-4 (b)）。testnet の資金。
- **共有の principal**: hosted の買い手は同じ principal なので、`paymentId` を知っていれば他人の購入の状態を読める（今の hosted の全 route と同じ）。標準入口の「1 注文 1 credential」は principal ではなく credential の同一性で守られる。
- **アプリのやり直し・利用者の hook**: `docs/x402-standard-entry-requirements.md` §7 のとおり。

## 7. 出典と未確認

- 出典は §1 の各項。Router は `42f8a0d`。
- v1 の【未確認】のうち、(1) は repo の設定例では `/x402/...` が ingress に届く（`/evm-facilitator/*` だけ別）、(4) は道具が image に入っている、まで分かった（§1）。
- 【未確認】(a) host の Caddy の現物の設定（パスの振り分け、`X-Forwarded-For`）。AC-6 で読む。(b) facilitator の tenant ごとの注文の上限。G-2 で観測する。

## 8. v1 → v2 の対応（Codex `hx-req-review1.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 1 must | 予算の予約は verify の後 | §1（予算）、FR-3.2 (a)(b) |
| 2 must | route 専用の予算と既存の予算の関係 | FR-3.2 (a)(c)(d)、AC-3 |
| 3 must | 停止の仕様の矛盾 | H-4（戻らない／時間で戻る）、FR-3.1、§1（枠の意味） |
| 4 must | 送信元の偽装・MCP での迂回 | §1（送信元）、FR-3.3、AC-3、§6 |
| 5 must | proxy の境界 | FR-2.0、FR-2.1、FR-2.3、FR-2.3b |
| 6 must | 転送後の ingress の応答 | FR-2.5、AC-2（下の行） |
| 7 must | 実際の入れ替えの順 | §1（drain と入れ替え）、H-6、AC-4 |
| 8 must | rollback と無効時の後始末 | §1、H-9、NFR-3、AC-7b |
| 9 should | 秘密の検査の漏えい | FR-5.2 |
| 10 must | AC-7 の証拠 | AC-7 |
| 11 note | §7 の更新 | §1、§7 |
| 12 note | §1 の範囲 | §1（Caddy の例外、記録時点の事実） |

## 9. v2 → v3 の対応（Codex `hx-req-review2.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 新 1 must | 件数の枠の解放条件 | FR-3.2 (a)（確定して使った分／一時的に占めている分、解放は未払いの証明ではない、journal から復元）、AC-3 |
| 新 2 must | 並行の発行と一時の占有 | H-4、FR-3.2 (a)、AC-3 |
| 新 3 must | H-9 の状態 | H-9 を 3 状態の表に（受付停止 = 上限 0）、FR-1.1、NFR-3、AC-7b |
| 新 4 must | 送信元ごとの占有の対象 | FR-3.3、AC-3 |
| 新 5 should | FR-2.5 と AC-2 | 応答の開始の前後で分けた |
| 7 partly | 実際の proxy 経由の入れ替え | AC-4 に範囲を明記（本番では購入の無いときに入れ替える運用） |
