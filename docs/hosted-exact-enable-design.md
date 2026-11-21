# hosted の Router で `subetha-exact` と標準の x402 入口を、上限付きの実証として有効にする 設計 v3

対象: branch `task/hosted-exact-enable`（基点 `origin/main` `42f8a0d`）。入力は要件定義 v3（`docs/hosted-exact-enable-requirements.md`、以下 R）。印: 【事実】【決定】【推論】。
v1 は Codex（`gpt-6-astra`、`.claude_workflow/local/hx-design-review1.md`）で **REVISE**（must-fix 5、should-fix 2、note 2）。v2 は全件を反映した（§11）。v2 の再レビュー（`hx-design-review2.md`）は **REVISE**（前回の fixed 7・partly 2、新規 must 2・should 2・note 1）で、v3 はそれを反映した（§12）。v3 は単独の再レビューをせず、実装のレビューで確かめる。

## 1. 方針

足すものは 5 つ。Router の購入の経路（verify → settle → release → 上流 → complete）と、標準入口の規則（PR #204）は変えない。

| # | 足すもの | 場所 |
|---|---|---|
| 1 | route ごとの **offer の上限**（実証の件数）: offer を出す前に数える | `src/config.ts`、`src/core/orchestrator.ts` |
| 2 | 送信元ごとの**注文の作成の制限**（頻度と占有）: adapter の ledger で数える | `src/ports/inbound.ts`、`src/adapters/inbound/subetha-exact{,-ledger}.ts`、`src/config.ts` |
| 3 | 標準入口の**公開の URL の基点**（一覧の `x402Url` と 402 の `resource.url`） | `src/config.ts`、`src/http/{x402-entry,projection}.ts` |
| 4 | ingress の**公開の経路** `GET /x402/v1/routes/{routeId}/resource`（子の Router への固定の転送） | `src/mcp/x402-proxy.ts`（新）、`src/mcp/ingress.ts`、`tools/remote-mcp.ts` |
| 5 | hosted の設定の生成とスイッチ、文書 | `tools/remote-mcp-config.ts`、`tools/rails-entry.ts`、`docs/DEPLOY.md`、`README.md` |

## 2. offer の上限（R FR-3.2）

- **設定**: 静的 route に任意の欄 `offerCap: { maxCommitted: <0 以上の整数> }`。`sourceRail: "subetha-exact"` の route にだけ許す（他は `ConfigError`）。欄が無い route は今のまま（数えない）。`0` は「新しい offer を出さない」= R H-9 (iii)。
- **数え方**（core。その route の intent を store から読む。再起動の後も同じ）:

  | intent の状態 | 数 | 理由 |
  |---|---|---|
  | `created` で、今 < 承認の期限（`approvalDeadlineMs`） | 入る（一時） | 払われ得る。期限の後は `purchaseStatic` が settle を始めない（`approval_expired`）【事実】 |
  | `created` で、今 ≥ 承認の期限 | 外れる | Router はこの offer で settle を始めない。**未払いの証明ではない** |
  | `source_pending`（verify 中・settle 中） | 入る（一時） | 進行中 |
  | `source_failed` で、行に **`settleStarted: false`** の印がある | 外れる | 終端で、Router は settle を呼んでいない |
  | `source_failed` で、印が無い・`true`・形が違う | 入る（確定） | settle を呼んだ後の拒否か、分からない。分からなければ外さない |
  | `unknown` | 入る（確定） | どこまで進んだか分からない |
  | `source_settled` 以降（`delivered`・`paid_*` を含む） | 入る（確定） | 使った |

  **理由の文字列では settle の前後を区別しない**: settle の後の拒否も同じ安全な理由の集合から理由を受ける（`orchestrator.ts:1202-1204, 436`）ので、core が `source_failed` を書く場所のうち **settle の呼び出しより前**のもの（上流の照合・残高・verify の拒否・settle 直前の期限・予算、標準入口の結び付け後の早い拒否）にだけ `settleStarted: false` を足す。
  store はこの欄を intent に残す（真偽値でなければ欄なし）。旧い行・印の無い行は「入る」。試験: settle の後に同じ理由（例 `approval_expired`）で終わった購入が数に残ること。
- **予算の区分は上限にしない**: verify の後の予約は、その後に期限で止まっても戻らない【事実】（`orchestrator.ts:1141-1172`、`budget.ts:314-322`）。その offer は上の表では外れる（settle を呼んでいない）ので、予約だけが残る。
  zUSDC の区分でこの route を縛ると、こうした予約の積み重ねで件数より先に区分が尽きる。したがって hosted の zUSDC の区分は「注文の作成の総数 × 受信額」（300 × 12,000 = 3,600,000）より大きい値（10,000,000）にして**決して先に尽きない**ようにし、実証の上限は offer の上限だけで決める。
  Router の持ち出し（上流への支払い）が起こるのは settle が確定した購入だけで、それは必ず数に入っている。
- **既存の quote の再取得**（同じ `(principal, requestId)` の再 quote）は新しい offer ではないので、上限の判定の対象外（今の分岐のまま、判定より前に戻る）。
- **判定の場所**: `quoteLocked`（quote の入口・標準入口の共通の経路）で、上流の読み取りより前に、**同期の 1 区間**で「数 + 発行の途中の数 ≥ maxCommitted なら断る、でなければ発行の途中の数を +1」を行い、`finally` で −1（その時点で intent が store にあれば数に入っている）。
  発行の途中の数は **route ごとに 1 つ**で、両方の入口が共有する（今の quote の鍵は `(principal, requestId)` で route 単位ではない。`orchestrator.ts:1565, 1601`）。await を挟まないので、残り 1 枠に同時の要求が来ても通るのは 1 つ。
- **断り方**: `source_offer_unavailable`／`offer_cap_reached`（sanitized の集合に足す）。HTTP の quote は今の 503、標準入口は 503（`Retry-After` は目安の 60 秒。戻ることは約束しない）、MCP は今の形。注文は作らない。
- **既存の予算**（verify の後の予約）はそのまま。hosted の設定では zUSDC の区分を上限にしない（下）ので、この route が予算で断られるのは共有の件数（`maxPurchases` 100,000）か USDC の送信の区分（既定 1,000 USDC 相当）が尽きた場合だけ。
  **実際の送金の上限**は 40 件 × 0.01 = 0.4 USDC。**共有の USDC の区分の予約**は、予約の後に期限で止まった購入の分も残るので、最大で注文の作成の総数 300 × 0.01 = 3 USDC（区分の 0.3%）。既存の route の枠を食い尽くさない。

## 3. 送信元ごとの制限（R FR-3.3）

- **送信元の tag**: `sourceTag = sha256("x402e-src-v1" ‖ source)` の先頭 16 hex。`source` は core が受け取った値（下）。生の address は ledger に書かない。
- **source の経路**: (a) quote の入口: `src/http/app.ts` の `handleQuote` が今の `sourceOf(request, principalId)`（`x-router-source` ヘッダー。MCP 層が必ず上書きする）を core の `quote` に渡す（今は動的 quote だけが渡している）。
  (b) 標準入口: `x402-entry.ts` が同じ `x-router-source` を `quoteStandard` に渡す。ingress の転送（§5）がこのヘッダーを**自分で導いた値**で必ず付け、買い手が送った値は渡さない。ヘッダーが無ければ principal（ローカルの Router は今までどおり principal ごと）。
  core は `createOffer` の `requester` に `sourceTag` を足す。
- **adapter**: `limits` に任意の 2 つを足す: `maxUnresolvedPerSource`、`requestsPerMinutePerSource`。ledger の `requested` の行に `sourceTag` を書き、今ある「未解決」の定義（`created` があり settle が確定せず注文の期限 + 60 秒の内、または `created` の無い試行）を**同じ tag の行だけ**で数える。
  作成の応答を失った試行も、支払いの処理中も、unknown も同じ定義で入る（credential を出しただけでは外れない）。ledger から読むので再起動の後も同じ。
  **全体の数と同じ単位で数える**: 全体の未解決は「attempt + どの attempt にも結び付かない `discovered` の注文」（`subetha-exact-ledger.ts:227-239, 286`）。`discovered` の注文は pair（requesterDigest・resourceDigest）で記録されるので、
  その pair の `requested` の行の tag が**ちょうど 1 種類で、tag の無い行が混ざっていない**ときだけ、その tag を注文の送信元とする。それ以外（tag が 2 種類以上: requester digest は送信元を含まないので、同じ `(principal, requestId)` を別の送信元から再試行すると起こる。tag の無い行が混ざる。行が無い）は
  **全ての送信元の数に入れる**（保守的。全体の枠も同じだけ使っている）。
  **後からの発見で上限を超えないための規則**: 作成の結果が分からない attempt（`created` の無い attempt）は、後で注文が見つかると attempt 1 + `discovered` 1 の 2 つを占める。そこで、**そういう attempt を 1 つでも持つ送信元は、それが片付くまで新しい注文を作れない**（`limit_source_unresolved`）。
  これで 1 つの送信元の占有は、通常は `maxUnresolvedPerSource` 以下、応答を失った場合でも attempt 1 + その注文 1 = 2 以下（`maxUnresolvedPerSource` は 2 以上にする。設定の検査で 2 未満を拒む）。
  片付くのは今の規則どおり（注文が見つかって期限が過ぎる、または運用者の `--abandon`）。応答を失ったまま注文も見つからない送信元は、運用者が片付けるまで作れない（実証としては保守的でよい）。
  超えたら `source_offer_unavailable`／`limit_source_unresolved`（`Retry-After` は固定の 300 秒: 期限の分からない試行があるので残り時間は計算しない）・`limit_source_rate`（60 秒）。facilitator は呼ばない。全体の枠の検査より前に見る。
  試験: 作成の応答の喪失 → 照会で発見 → 再起動、の後でも同じ送信元は止まり、別の送信元は通る。応答を 2 回続けて失おうとしても 2 回目は作成の前に止まる。同じ pair を別の送信元から再試行 → 発見 → 再起動で、曖昧な注文が全ての送信元に数えられる。
  2 つの欄が無い設定（ローカル）は今のまま。
- **HTTP の写像**: core の結果は `source_offer_unavailable` + reason `limit_source_*` + `retryAfterMs`。
  標準入口: **429**、本文 `{"error":"rate_limited","reason":"limit_source_…"}`、`Retry-After`。それ以外の `source_offer_unavailable` は今の 503。
  quote の入口（`POST /v1/quotes`）: `limit_source_*` のときだけ **429**、本文 `{"error":"rate_limited","reason":…,"retryAfterMs":…}`（MCP の client は本文の `error` をそのまま返すので、MCP では今の `rate_limited` と同じ形になる。`src/client/index.ts:345-346`）。それ以外は今のまま。

### 3.1 verify の無応答（両方の入口。R の standing rule）

今の adapter は、標準入口の offer だけ「答えの得られなかった verify」を例外にし（core が `unknown` と記録）、quote の入口の offer では `isValid: false`（core が `source_failed rejected verify_failed`）にする【事実】（`subetha-exact.ts:460-465`、`orchestrator.ts:1091-1098`）。
hosted では MCP の購入もこの rail を通るので、**無応答を拒否として記録しない**ことを両方の入口に効かせる:
- 設定 `subethaExact.unansweredVerifyIsUnknown: true`（任意の真偽値）。`true` のとき adapter は offer の種類に関わらず、無応答（時間切れ・切断・200 以外・`isValid` が boolean でない）を例外にする。facilitator が 200 で `isValid: false` と答えた場合だけ拒否。
- hosted の生成は常に `true` を出す。欄が無い設定（ローカルの今の挙動）は変わらない。
- 実装の条件は **`isStandardOffer(offer) || option === true`**（欄が無い・`false` でも、標準入口の offer は今までどおり例外。旧い挙動に戻さない）。`src/config.ts` の `subethaExact` の検査は今 `limits` 以外の欄を拒む（`:1348-1352`）ので、この欄と `limits` の新しい 2 つを allowlist に足し、真偽値・正の整数を厳密に検査する。`src/main.ts:1034-1044` から adapter に渡す。
  前スライスの試験（`tests/unit/subetha-exact-adapter.test.ts` の「印の無い offer は全て `isValid: false`」）は「欄が無いとき」の互換の試験として残し、`true` の試験を足す。試験は「無応答 → unknown」と「明示の拒否 → verify_failed」を、MCP の経路と標準入口の両方で分ける。

## 4. 公開の URL の基点（R H-3）

- env `ROUTER_X402_ENTRY_BASE_URL`（任意。https か loopback の origin。末尾の `/` なし、path なし）。あれば一覧の `x402Url` と 402 の `resource.url` はこの基点から作る。無ければ今の `ROUTER_CANONICAL_BASE_URL`（ローカルは今のまま）。
- 既存の route の `resource.url`（`canonicalBaseUrl` から作る）は変えない。

## 5. ingress の公開の経路（R FR-2）

`src/mcp/x402-proxy.ts` に `createX402Proxy(options)` を置き、`createMcpIngress` に任意の `x402Proxy` として渡す。渡さなければ ingress は今と 1 byte も変わらない。

- **照合（最初。R FR-2.0）**: 要求の**生の** `request.url` 文字列が、`/x402/v1/routes/<id>/resource`（`<id>` は設定の対象の routeId の集合のどれか）と**完全に一致**するときだけ自分の経路とする。正規化した URL では照合しない: 符号化した区切り・dot segment・絶対 URL・クエリ・末尾の `/` は一致しないので、今の「それ以外は 404」に落ちる。`Host` は見ない。
  一致した後: `GET` 以外は 405（`allow: GET`）、本文付き（`content-length`／`transfer-encoding`）は接続を閉じる 400。
- **ヘッダー**: `rawHeaders` から `payment-signature` と `x-payment` を数える。`x-payment` あり・`payment-signature` が 2 つ以上・空・8 KiB 超 → 400 `invalid_payment`（子と同じ本文）。子へは送らない。
- **頻度（ingress の中、メモリ）**: 送信元（`sourceOfRequest`）ごとに、署名付きの要求は毎分 30、署名なしは毎分 12 まで（子の ledger の制限より緩い外側の守り）。超えたら 429 + `Retry-After: 60`。同時に転送中の数は全体で 16 まで（超えたら 503）。値は定数。
- **転送**: `node:http` の `request` で、**ingress が起動時に得た子の Router の address**（`router.baseUrl`）へ、**照合に使った固定のパス**を `GET`。ヘッダーは `x-router-principal`・`authorization`（ingress の固定の principal）・`x-router-source`（導いた値）・`payment-signature`（あれば）だけ。redirect は追わない（`http.request` は追わない）。期限は ingress の `maxRequestMs`（180 秒）より短い 170 秒。
- **応答**: 子の status と本文（上限 300 KiB。超えたら接続を切る）、ヘッダーは `content-type`・`cache-control`・`payment-required`・`payment-response`・`x-router-payment-id`・`retry-after`・`allow` だけを写す。
- **ingress が作る応答（R FR-2.5）**: **転送を始めた後の失敗は全て proxy の中で処理し、ingress の既存の catch（固定の 500 `internal_error`。`ingress.ts:261-265`）に落とさない。**
  対象: 期限、接続の失敗、子の切断、子のヘッダーを受けた後・公開の応答を書く前の例外、子の応答の形の不正（status が数でない等）、本文の上限の超過。
  判定は公開の応答の **`response.headersSent`** だけ: まだなら、署名付きは **502** `{"error":"result_unknown","note":"The Router did not answer. This is not proof that nothing was paid. Do not sign again; read the result later by sending the same PAYMENT-SIGNATURE again."}`、
  署名なしは **503** `{"error":"unavailable","note":"This request did not start a payment."}` + `Retry-After: 60`。もう書き始めていれば接続を切る。どれも 402 でなく、`payment-required` を持たない。
  子の応答は**全部を読み終えてから**公開の応答を書き始める（本文は 300 KiB 以下なのでメモリに持つ）。これで「書き始めた後の失敗」は公開の socket の失敗だけになる。
  （「同じ PAYMENT-SIGNATURE の再送」は新しい署名ではない。再署名の案内ではない。）
- **drain**: ingress の先頭の `drain.admit()` と数は今のまま全ての要求に効く（この経路も入る）。**クライアントが切れても転送は中断しない**: proxy の Promise は、子の応答を読み終えるか期限が来るまで解決しない（公開の応答の `close` では解決しない）。
  ingress は handler の Promise の `finally` と応答の `close` の両方で数を外す（`ingress.ts:194-200, 265`）ので、子の購入が続いている間は drain の数に残る。子の購入は進み、結果は再送で読める。
- **ログ**: `note` は固定文だけ。`payment-signature` の値・署名・送信元の address を出さない。

`tools/remote-mcp.ts`: 計画（plan）が「exact が有効」のときだけ、対象の routeId の集合と子の `baseUrl`、固定の principal で proxy を作って ingress に渡す。無効なら渡さない（公開のパスは 404 のまま）。

## 6. hosted の設定の生成（R FR-1、H-1、H-4、H-9）

- `RAILS_ACTIVATION.subethaExact?: { inbound: boolean }`（欄なし = `false`。既存の `subethaOf` と同じ流儀の `subethaExactOf`）。activation の token は `subetha-exact-in`。
- 定数（オーナーが変える場所は 1 つ）:

  ```ts
  export const HOSTED_EXACT = {
    routeId: "md-zusdc-eth-snapshot",
    source: { network: "eip155:84532", asset: "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f", decimals: 6, amount: "12000" },
    /** 実証の件数。0 = 新しい offer を出さない（受付停止）。Router の持ち出しの上限 = 40 × 0.01 USDC = 0.4 USDC。 */
    maxCommitted: 40,
    limits: { maxRequestsTotal: 300, maxUnresolved: 6, requestsPerMinute: 12, maxUnresolvedPerSource: 2, requestsPerMinutePerSource: 3 },
    publicOrigin: "https://router.subethalabs.com",
  } as const;
  ```

  送信は既存の `OUTBOUND_X402`（Provider A、10,000）。1 つの送信元は未解決 2 つまでなので、全体の 6 を埋めるには 3 つの送信元が要る。
- 有効なとき生成に足すもの: route 1 本（`offerCap.maxCommitted`）、zUSDC（Base Sepolia）の予算の区分（`maxTotal` = 10,000,000、`maxPerPurchase` 20,000。§2）、`subethaExact.limits` と `unansweredVerifyIsUnknown: true`（§3.1）、
  子の env `ROUTER_SUBETHA_EXACT_FACILITATOR_URL`（host の env `SUBETHA_EXACT_FACILITATOR_URL` から）・`ROUTER_SUBETHA_EXACT_TOKEN_FILE`（`SUBETHA_EXACT_TOKEN_FILE` から）・`ROUTER_X402_ENTRY_BASE_URL`（定数）。
  host の env の 2 つが無い・空なら `HostPlanError("env")`（今の固定文。値は出さない）。
- 無効なら、生成物・子の env・一覧は今と byte 一致（既存の golden に 1 行も差が出ない）。
- **3 状態**（R H-9）: (i) `inbound: false`。(ii) `inbound: true`、`maxCommitted` > 0。(iii) `inbound: true`、`maxCommitted: 0`（route・adapter・proxy は残る。新しい offer だけ 503）。

## 7. 秘密と host（R FR-5）

- token は host の `/var/lib/subetha-router/secrets/subetha-exact.token`（directory 0700、file 0600、owner は container の uid 10001）= container の `/app/runtime/secrets/subetha-exact.token`。`/etc/subetha-router.env` に入るのは path だけ。
- 運び方: 手元の 0600 のファイルを `scp` で host の一時の path（0600）へ → `sudo install -o 10001 -g 10001 -m 600` → 一時のファイルを消す。値を argv・echo・ログに出さない。
- 照合: 手元と host で `sha256sum` を取り、**一致・不一致だけ**を表示する（hash の値も表示しない）。log・journal・診断の記録に対する確認は `grep -c -F -f <token のファイル>` で**件数だけ**を出す（token を argv に載せない）。
- hosted 用の Provider: id `router-hosted`、新しい EOA と POS key は手元の `.claude_workflow/local/provider-wallet-hosted/`（host に置かない）。登録は段 3 と同じ手順（招待の発行にオーナーの AWS login、ETH は owner の決めた出どころ）。

### 7.1 開示（R H-7、FR-4.2、H-9）

- 一覧: 対象の route に `demonstration: { capped: true, acceptingNewOffers: <maxCommitted > 0> }` を足す（有効なときだけ。無効なら欄ごと無い = byte 一致）。`x402Url` は公開の URL。
- MCP: サーバの説明（instructions）、`list_routes` の案内、**この route の quote の `nextStep`**（`src/mcp/tools.ts:521` の静的 quote の案内。対象の route のときだけ 1 文を足す）に 1 文ずつ（有効なときだけ。無効なら案内は byte 一致）: 実証で上限があり尽きたら 503 で止まること、標準入口には承認の段が無いこと、標準クライアントは zUSDC を `spendControls.allowedAssets` に足すこと。
- `README.md`・`CLAUDE.md`・llms の記述: G-4 の後に「hosted で有効」と書き換える（G-4 の PR）。それまでは「ローカルだけ」のまま。
- 試験: 有効・受付停止・無効の 3 状態で一覧と案内の文言を確かめる（無効は byte 一致）。

## 8. 段階と rollback（R H-8、NFR-3）

| 段 | すること | 確かめること |
|---|---|---|
| G-2 | 手元で `tools/remote-mcp.ts` を (ii) の設定で起動（testnet の facilitator、`router-hosted`） | R AC-5。facilitator の tenant ごとの上限に当たらないこと |
| G-3 | (i) の image を本番に入れ替え（今の版の `swap-image.sh`） | R AC-6。Caddy の現物の設定を読む |
| G-4 | host に token と env を置き、(ii) の image に入れ替え（**オーナーの go**） | R AC-7 |
| G-4b | (iii) の image に入れ替え、戻す | R AC-7b |

rollback: G-4 の後は (iii) へ。(i) や `b-6aa3f20` へ戻すのは、inspect で未報告の complete と未解決の注文が 0 と確かめた後だけ。

## 9. 試験

| # | 試験 | R の AC |
|---|---|---|
| T-a | `tests/unit/x402-entry-core.test.ts` に追加: offer の上限の表（各状態で入る／外れる）、`settleStarted: false` の印のある行だけ外れる（settle の後に同じ理由で終わった購入・印の無い旧い行は残る）、残り 1 枠の同時の発行（quote の入口と標準入口）、発行済みを全部買っても超えない、予算を予約した直後に期限で止まった購入（外れる・再起動の後も）、再起動の後の数、上限 0、欄の無い route は数えない、既存の quote の再取得は対象外 | AC-3 |
| T-b | `tests/unit/subetha-exact-adapter.test.ts` に追加: 送信元ごとの未解決・毎分（別の tag は独立、作成の応答の喪失 → 発見 → 再起動でも入る、tag の無い `discovered` は全ての送信元に入る、facilitator を呼ばない）、欄が無ければ今のまま。`unansweredVerifyIsUnknown`: quote の入口の offer でも無応答は例外・明示の拒否は `isValid: false`、欄が無ければ今のまま | AC-3 |
| T-c | `tests/unit/x402-proxy.test.ts`（新。偽の子）: 照合（生の URL。細工の各種が ingress の 404 に落ちる）、ヘッダーの転送と除去、応答のヘッダーの allowlist、400／405／429／503、子が答えない各場合（署名あり 502・なし 503・書き始めた後は切断）、クライアントが切れても転送が続く、proxy を渡さない ingress が今と同じ | AC-2、AC-4 |
| T-d | `tests/unit/remote-mcp-config.test.ts` ほか既存の golden: 無効で byte 一致、有効で route・予算・limits・子の env、env が無ければ `HostPlanError` | AC-1 |
| T-e | `tests/wire/hosted-exact-entry.test.ts`（新）: 実 `tools/remote-mcp.ts` の child + 合成 facilitator + x402 上流。**実物の `@x402/fetch` が ingress の URL だけで買う**（principal を知らない）、`resource.url` が公開の origin、MCP の quote → sign → purchase、偽の `X-Forwarded-For` で枠が増えない、購入の途中でクライアントを切ってから SIGTERM → `drain: complete`、上限 0 の起動 | AC-2〜AC-4 |
| T-f | 既存の全試験 | AC-8 |

sabotage: 上限の同期の区間に await を入れる、settle の後の `source_failed` に印を付ける、proxy の照合を正規化した URL に変える、`x-router-source` を買い手の値のまま渡す、応答のヘッダーの allowlist を外す — それぞれ試験が落ちること。

## 10. 残す点

R §6 のとおり。加えて: ingress の頻度の守りはメモリの中（再起動で戻る）。永続の守りは adapter の ledger（§3）。

## 11. v1 → v2 の対応（Codex `hx-design-review1.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 1 note | 要件 v3 は前回の指摘を解いている | — |
| 2 must | 理由だけでは settle の前後を区別できない | §2（`settleStarted: false` の印、store に残す、旧い行は保持）、T-a |
| 3 must | 予約は戻らない | §2（zUSDC の区分は上限にしない。値 10,000,000）、§6、T-a |
| 4 must | `discovered` が送信元別の数から漏れる | §3（全体と同じ単位、pair から tag、tag なしは全送信元、`Retry-After` 固定）、T-b |
| 5 must | MCP の verify の無応答が rejected | §3.1（`unansweredVerifyIsUnknown`）、T-b |
| 6 must | 転送後の失敗 | §5（proxy の中で全て処理、`headersSent`、子の応答を読み終えてから書く、Promise の寿命） |
| 7 should | 429 と `rate_limited` の写像 | §3 |
| 8 should | 開示と秘密の照合 | §7.1、§7 |
| 9 note | 同期の予約・送信元・raw URL | §2（route ごとの数、再取得は対象外） |

## 12. v2 → v3 の対応（Codex `hx-design-review2.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 新 1 must | `discovered` の送信元を pair だけで一意に選べない | §3（tag がちょうど 1 種類で欠けが無いときだけ帰属。それ以外は全送信元） |
| 新 2 must | 後からの発見で占有が上限を超える | §3（結果の分からない attempt を持つ送信元は作成を止める。`maxUnresolvedPerSource` ≥ 2） |
| 新 3 should | 共有の USDC の区分の予約 | §2（実際の送金 0.4 USDC と、予約の最大 3 USDC を分けて記載） |
| 新 4 should | quote の `nextStep` | §7.1 |
| 新 5 note | `unansweredVerifyIsUnknown` の互換の条件 | §3.1 |
