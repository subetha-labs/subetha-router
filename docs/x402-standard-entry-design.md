# 標準の x402 クライアント用の入口（受信レール `subetha-exact`）設計 v3

対象: branch `task/x402-standard-entry`（基点 `origin/main` `45f46f6`）。入力は要件定義 v3（`docs/x402-standard-entry-requirements.md`、以下 R）。
v1 は Codex（`gpt-6-astra`、`.claude_workflow/local/x402e-design-review1.md`）で **REVISE**（must-fix 5、should-fix 3、note 1）。v2 は全件を反映した（§11）。v2 の再レビュー（`x402e-design-review2.md`）は **REVISE**（前回の fixed 7・partly 2、新規 must 2・note 1）で、v3 はそれを反映した（§12）。v3 は単独の再レビューをせず、実装のレビューで確かめる。
出典の記法は R と同じ（`P:` = protocol `68e061b`、`X:` = `@x402/*` 2.28.0、無印 = Router）。印: 【事実】【決定】【推論】。

## 1. 方針

**今ある購入の経路を 1 本のまま使い、入口と「offer の種類」だけを足す。** 標準入口の購入は、core の中では「内部の requestId で作った quote を、標準クライアントの署名で買う」静的 route の購入であり、
verify → settle → release → 上流 → 配達 → complete と復旧は前スライスの実装をそのまま通る。足すのは次の 5 つだけ。

| # | 足すもの | 場所 |
|---|---|---|
| 1 | 標準入口の HTTP の口（402 の発行、`PAYMENT-SIGNATURE` の受け取り、応答の写像） | `src/http/x402-entry.ts`（新）、`src/http/app.ts`（振り分け 1 か所） |
| 2 | offer の種類の印 `extra.entry = "x402"` と、その offer だけの検査（nonce 自由、期限 = 注文の期限）、手元の署名の検査の口、verify の通信失敗の区別 | `src/adapters/inbound/subetha-exact.ts` |
| 3 | 標準 quote の発行と、`payTo` からの対応、credential の結び付け | `src/core/orchestrator.ts`、`src/core/store.ts`、`src/core/intent.ts`、`src/main.ts`（rail の振り分けの包みに `checkSignature` と `entry` を通す） |
| 4 | 入口をまたがない検査 | `src/core/orchestrator.ts` |
| 5 | 一覧の 1 項目、README、試験 | `src/http/projection.ts`、`src/mcp/tools.ts`、`tests/` |

## 2. URL と振り分け

- 【決定】標準入口は **`GET /x402/v1/routes/{routeId}/resource`**。R3（`/v1/routes/{routeId}/resource`）と同じ形に接頭辞 `/x402` を付ける。`src/http/app.ts` の `handle` は、Bearer の認証（今の位置のまま）の後、
  `segments[0] === "x402"` のときだけ新しい handler に渡す。それ以外の分岐は 1 行も変えない（R FR-3.2）。
- クエリは今の共通の検査で 400。`GET` 以外は 405。
- `routeId` が `sourceRail: "subetha-exact"` の静的 route でない、パスの形が違う → **404 `not_found`**（今の `sendError(response, 404, "not_found")` と同じ本文。以下「固定の 404」）。動的プロファイルの ID も同じ。
- `resource.url` = `canonicalBaseUrl` + パス（`Host` から作らない）。

## 3. credential なしの GET

1. ヘッダーの検査（§4.1 の 400 の条件のうち、支払いのヘッダーが無い場合に当たらないもの）を済ませる。
2. `core.quoteStandard({ principalId, routeId })` を呼ぶ。core は内部の requestId **`x402e:` + 128 bit の乱数（hex）**を作り、今の `quoteLocked` と同じ手順で quote を作る。違いは `createOffer` に `entry: "x402"` を渡すことだけ。
   乱数が既存の `(principal, requestId)` に当たったら（起こらないはず）作らずに 503。
3. adapter は `entry === "x402"` のとき:
   - facilitator の注文の作成は今と同じ（requester digest は内部の requestId から導くので、毎回新しい組 = 新しい注文。R D-10）。
   - facilitator が `existing: true` を返したら（同じ組の注文が既にある。乱数の衝突か facilitator の異常）`InboundOfferError("source_offer_unavailable", "order_exists")` で止める（2 度見せない。R FR-1.5）。`order_exists` を `OFFER_REFUSAL_DETAILS` に足す。
   - offer の `extra` は `{name, version, challengeNonce: orderId, expiresAt: 注文の expiresAt, routeBinding, fundsMoveOnCredential: false, entry: "x402"}`。**`expiresAt` を「発行 + 120 秒」で切らない**（R FR-2.9）。
     これで core の `settleWindowOf`（= `extra.expiresAt`）は注文の期限になり、`created` の行に保守的な上限が永続に残る（今の仕組みのまま）。
   - `maxTimeoutSeconds + minLeadSeconds > 注文の残り時間`なら（標準クライアントが今すぐ署名しても期限を超える）`source_offer_unavailable`／`order_window_short` で止める。
   - 同時の発行は今の `inflight` の守りで 1 つだけ通り、他は `limit_concurrency` の 503（枠を超えない。R D-10）。
4. core は `created` の行に今と同じ項目を書く。`source.offer.extra.entry` が印になる（新しい列を足さない）。承認の期限は今の式 `min(発行 + approvalTtlMs, offer の期限)`。これが R D-7 の「受付の期限」。
5. 成功: **402**。ヘッダー `PAYMENT-REQUIRED` = base64(UTF-8 の JSON)、本文も同じ JSON（`content-type: application/json`）:

   ```json
   {"x402Version":2,"error":"payment_required",
    "resource":{"url":"<canonicalBaseUrl>/x402/v1/routes/<routeId>/resource","description":"<route の表示名>","mimeType":"application/json"},
    "accepts":[{"scheme":"exact","network":"eip155:84532","asset":"0x…","amount":"…","payTo":"0x…","maxTimeoutSeconds":150,"extra":{"name":"…","version":"…"}}]}
   ```

   `accepts[0]` は **facilitator の requirements の 8 項目だけ**（Router の `extra` の項目を出さない。sample Provider と同じ形。`P:exact-settle.ts:231-238`）。`quoteId`・`paymentId`・requestId は 402 に出さない。
6. 失敗: `source_offer_unavailable` → **503** + `Retry-After`（`retryAfterMs` があれば秒に切り上げ、無ければ 60）、`source_offer_refused` → **502**、上流の quote の失敗（`quote_failed` など）→ **502**。本文は `{error, reason?}`（今の sanitized の集合）。402 にしない。

## 4. `PAYMENT-SIGNATURE` 付きの GET

### 4.1 ヘッダーと形（HTTP 層、何も作らない）

次は全て **400 `invalid_payment`**（本文は固定、facilitator も core も呼ばない）:
`X-PAYMENT` がある（単独でも併用でも）／`PAYMENT-SIGNATURE` が空・重複（Node の `rawHeaders` で数える）／今の `X-Payment` の上限を超える／base64 の JSON として読めない／`x402Version !== 2`／
`accepted` が object でない／`payload.authorization` の 6 項目（`from` `to` `value` `validAfter` `validBefore` `nonce`）と `payload.signature` が今の adapter の `authorizationOf` の形（address、10 進、32 byte hex、hex の署名）でない。

### 4.2 対応を引く（core）

`core.purchaseStandard({ principalId, routeId, presented })` を呼ぶ。`presented` = `{accepted, authorization, signature}`（形は 4.1 で確かめたもの）。

- core は **`payTo`（小文字）→ quoteId の索引**を持つ。索引は `created` の行の `source.offer` から作る（`extra.entry === "x402"` のものだけ）。journal の再生で作り直すので再起動の後も残る（R D-5）。
  同じ `payTo` に 2 つの intent が現れたら、その `payTo` を「曖昧」と印して以後どちらも引かない（fail closed）。
- `authorization.to` から intent を引き、`principalId`・`routeId` が一致し、動的でないことを確かめる。1 つでも外れたら **固定の 404**（R FR-2.2）。
- ここまでは「どの quote か」を決めるだけ。**以後の判断は全て、今の購入と同じ直列の鍵（quoteId。`orchestrator.ts:1405`）を取った後で、intent を store から読み直して行う**
  （store は更新のたびに intent の object を置き換える。`store.ts:439, 773`。鍵の前に読んだ写しで結び付けを判断しない）。所有・route・結び付き・状態を鍵の中で確かめ直す。
  結び付け（§4.4）と実行は同じ鍵の中で続けて行い、実行は今の診断と開示の包み（`purchaseLockedCore`／`withDisclosure`。`orchestrator.ts:743-758`）を通す。

### 4.3 同じ credential か（時刻の検査より先）

credential の同一性は digest `sha256("x402e-cred-v1" ‖ from ‖ to ‖ value ‖ validAfter ‖ validBefore ‖ nonce ‖ signature)`。address・nonce・署名は小文字、数は 10 進の正規形（先頭の 0 なし）にしてから、長さ付きで連結する。base64 や JSON の項目の順序に依らない（R FR-2.6）。

- intent に **結び付いた digest がある**:
  - 同じ → §4.5 の「続行または今の状態」。
  - 違う → **409 `credential_conflict`**（§5）。facilitator を呼ばない。
- 無い → §4.4。

### 4.4 最初の credential: 検査と結び付け

1. `presented` から内部の credential を組む: `{x402Version: 2, accepted: 保存済みの offer, payload: {challengeNonce: orderId, authorization, signature}}`。
   その前に、買い手の `accepted` の 8 項目が保存済みの offer と一致することを core が確かめる（文字列は address だけ大小を無視）。
   **(a) 署名が本物か**: 今の `preflight` は項目しか見ず、署名の復元は `verify` の中にある【事実】（`subetha-exact.ts:399-414, 364-375, 429-436`）。port に任意の口 **`checkSignature(offer, credential): Promise<boolean>`** を足し、adapter は今ある復元の関数（EIP-712、offer の domain、`from` と一致）をそのまま出す。facilitator は呼ばない。口を持たない adapter は標準入口を使えない（404）。
   実 CLI の受信 port は `src/main.ts` の包み（`inboundByRoute`。method を 1 つずつ明示して渡す。`src/main.ts:636-657`）なので、**包みにも `checkSignature` を足し、offer の rail の adapter へ渡す**。口を持たない rail・例外・`true` 以外の戻り値は全て「本物でない」として扱う（fail closed。release／complete の `{outcome: "none"}` の fallback をここに写さない）。実 CLI の試験（T-d）で通ることを確かめる。
   **(b) 受け付けられるか**: adapter の同期の `preflight`。`offer.extra.entry === "x402"` のときだけ、(i) `extra` の許す key に `entry` を足し（今は `ISSUED_EXTRA_KEYS` に無い key を `offer_mismatch` で拒む。`subetha-exact.ts:116, 408-409`）、(ii) **`authorization.nonce === challengeNonce` を外す**。
   残り（`to`、`value`、`validAfter ≤ 今`、`validBefore ≤ extra.expiresAt` = 注文の期限、offer の期限）は今のまま。印の無い offer の検査は 1 行も変えない。
   **(c) 受付の期限・設定の変更**（今の `approval_expired`・`quote_changed` と同じ判定）。
2. (a)(b)(c) のどれかに落ちたら **409 `payment_not_accepted`**（§5）。結び付けない（R FR-2.3）。(a) を通った（署名が本物の）場合に限り、その credential の `validBefore` を `presentedValidBefore` として示す（(b) の期限超過・(c) を含む）。(a) に落ちたものには示さない。
3. 通ったら journal に **`source_credential_bound`** `{digest, payer: from, validBefore}` を書く（fsync まで待つ今の `store.append`）。状態は `created` のまま。**この行が書けてから**次へ進む。書いた直後に intent を読み直し、結び付きが載っていることを確かめる。
   直列の鍵の中なので、同時に届いた 2 つの credential のうち結び付くのは 1 つ（R D-11）。
4. 今の購入の経路を、`requestId` = 内部の requestId、`approval` = quoteId、`credential` = 上の内部の credential、`entry: "x402"` で呼ぶ。以後は前スライスの経路そのもの。
5. **結び付けた後に、journal の行を書かずに戻る拒否を残さない**: 今の経路は承認の期限・設定の変更・preflight の拒否で行を書かずに戻る【事実】（`orchestrator.ts:806-848`）。標準入口では、呼び出しが戻った後に **store から intent を読み直し**（呼び出しの前の object を見ない）、状態が `created` のままなら、
   `source_failed {outcome: "not_sent", reason: <その code>}` を書いて終わらせる（「Router は facilitator に送っていない」の記録。結び付いた credential の `validBefore` の開示は残る）。以後の再送は記録済みの結果を返し、実行をやり直さない。
   `source_failed` は `created` から書ける【事実】（`store.ts:451-458`）。公開の状態は `awaiting_payment`（`intent.ts:43-45`）で、再送は保存した理由を返す（`orchestrator.ts:1331-1340`）。`source_pending` は verify の前に待って書く（`:901-906`）ので、読み直した状態が `created` なら Router は verify も settle も送っていない。これは「外で払われていない」ことの証明ではない（開示は残る）。

### 4.5 結び付いた credential の再送

- 状態が `created` のまま → §4.4 の 5 により、これは「結び付けの行を書いた直後・実行の前に process が止まった」場合だけ（`source_pending` は verify の前に書く【事実】ので、verify は呼ばれていない）。
  §4.4 の 4 から続ける。受付の期限を過ぎていれば今の規則で止まり、5 が `source_failed not_sent` を書く（facilitator を呼ばない）。
- それ以外 → 今の `currentOutcome`（`delivered` なら保存済みの本文）。facilitator を呼ばない。期限の検査をしない（R FR-2.3 の順序）。

## 5. 応答の写像（`PAYMENT-SIGNATURE` 付きの要求）

**402 は 1 つも無い。`PAYMENT-REQUIRED` ヘッダーも付けない**（R D-9）。分かっている結果は下の表で 409 に写す。これは結果の写像であり、やり直しを防ぐ保証ではない（どの層が再送するかはクライアント次第。標準の wrapper は支払いのヘッダーを付けた要求を送る。`X:fetch/index.mjs:55-62`）。
`handle` の外側の例外の 500（`src/http/app.ts:275-280`）は今のまま challenge を持たない（試験で確かめる）。
**判定の順**: `source.txRef` がある（settle が確定した）なら、状態が unknown でも「支払いは成立、配達は未完」を先に言う（`paid_no_data` の行）。

| 場合 | status | 本文（JSON） | `PAYMENT-RESPONSE` |
|---|---|---|---|
| `delivered` | **200** | 上流の JSON そのまま | `{success: true, transaction, network, payer}` |
| settle 済みで配達が完了していない（`source.txRef` があり `delivered` でない全ての状態。unknown を含む） | **409** `paid_no_data` | 射影 + `paymentId` | `{success: true, …}` |
| unknown／進行中（`in_progress`） | **409** `payment_unresolved` | 射影 + 開示 | なし |
| verify の拒否・失敗、settle の拒否、結び付け後の Router 側の拒否（今の `awaiting_payment`／`rejected` の各 code） | **409** `payment_not_completed` | 射影 + 開示 + `code`（今の公開の code） | なし |
| 違う credential | **409** `credential_conflict` | 射影 + 開示 + 固定の文 | なし |
| 最初の credential が手元の検査に落ちた | **409** `payment_not_accepted` | `paymentId`、状態、開示、`presentedValidBefore?`、固定の文 | なし |
| 引けない | **404** `not_found` | 固定 | なし |
| 形が悪い | **400** `invalid_payment` | 固定 | なし |

- **射影**は R4 の `projectionBody` と同じ（`paymentId`、`routeId`、`status`、`source`、…）。**開示**は今の `disclosureFor`／`withDisclosure` の値: `mayStillSettleUntil` と `awaitingPaymentDoesNotMeanUnpaid: true`（受信が未 settle の間）。
  **標準入口の intent の開示は、結び付きがあればその `validBefore` を正とする**: 今の開示は `source.mayStillSettleUntil`／`source.settleWindow` だけを読み（`orchestrator.ts:341-345`）、verify の前の失敗は注文の期限を書く（`:858-912`）ので、
  共有の関数 **`disclosureOf`**（`orchestrator.ts:341-345`。射影もこれを使う。`:288-298`）に標準入口の分岐を足す: **まず今の条件（受信が未 settle = `source.txRef` が無い）を見て**、開示する場合に限り、`boundCredential` があればその `validBefore` を、無ければ今の値（注文の期限）を返す。
  settle が確定した・`delivered` の購入には開示を出さない（今と同じ）。HTTP・R4・MCP・再起動の後で同じ値になり、後の行が注文の期限で上書きしても変わらない。印の無い intent は今のまま。
  （§6 の `disclosureFor` は R3 の credential なしの再提示用の別の口で、標準の intent には `undefined` を返す。混同しない。）
- **固定の文**（`credential_conflict`・`payment_not_accepted`）: `"note": "This request did not forward this credential and did not start settlement. This is not a statement that nothing was paid."`
- **固定の文**（`payment_not_completed`・`payment_unresolved`）: `"note": "A refused, failed or unanswered verification or settlement is not proof that nothing was paid. The signed authorization can be used on chain until mayStillSettleUntil."`
- 全ての応答に `X-Router-Payment-Id`（持ち主が確かめられた場合だけ）。`PAYMENT-RESPONSE` は base64(JSON)。`transaction` = `source.txRef`、`network` = offer の network、`payer` = 結び付けの行の `payer`。
- R FR-2.5 (e): 今の adapter は verify の時間切れ・切断・200 以外・壊れた応答を `isValid: false` にまとめ、core は `source_failed {outcome: "rejected"}` を書く【事実】（`subetha-exact.ts:436-440`、`orchestrator.ts:927-934`）。
  標準入口では**答えが得られなかった verify を rejected と記録しない**: adapter は `offer.extra.entry === "x402"` のとき、これらを `isValid: false` にせず**例外にする**。core の今の catch が `unknown {reason: "source_verify_unavailable"}` を書く（`orchestrator.ts` の verify の catch。core の分岐は増えない）。
  この `unknown` の行の `outcome: "none"` は**送信側（上流）に何もしていない**の意味で、受信の支払いの拒否ではない（`store.ts:526-537`）。再起動の後も `unknown` のまま残り、中断した `source_pending` も `unknown` になる（`store.ts:697-717`）。起動時の complete の sweep の対象外（`orchestrator.ts:1305-1310`）。release・settle のやり直しは起きない。
  facilitator が**はっきり拒んだ**（200 で `isValid: false`）場合だけ、今の `source_failed {outcome: "rejected", reason: "verify_failed"}`（公開は `awaiting_payment` + 開示 + 上の固定の文）。これは「verify が拒まれた」の記録であり、支払いの結果の記録ではない。
  印の無い offer（quote 入口）の verify は今のまま。

## 6. 入口をまたがない（R D-8）

- `purchaseStatic`: `intent.source.offer.extra.entry === "x402"` で、呼び出しが標準入口でない（`entry` の引数が無い）→ `rejected`／`unknown_quote`（R3・MCP から見て存在しない）。**今の「`created` でなければ今の状態を返す」近道（`orchestrator.ts:776-778`）より前**に置く。逆（印の無い intent に `entry: "x402"`）は §4.2 の索引に現れないので 404。
- `quoteLocked`: 既存の `(principal, requestId)` の intent が標準入口の印を持つなら `request_id_conflict`（文書を返さない）。requestId の接頭辞では拒まない（`x402e:` で始まる quote 入口の requestId は今までどおり使える。R FR-3.2）。
- `offerFor`・`disclosureFor`（R3 の credential なしの再提示）: 標準の intent には `undefined`（R3 が標準 offer を 2 度見せない）。
- `status`（R4・MCP）: 今のまま読める（R FR-2.8）。

## 7. store と復旧

- 新しい行 `source_credential_bound` を `src/core/store.ts` の再生の**本体の switch**に足す（知らない種類の行は今は黙って落ちる。`store.ts:545-555`）。状態を変えず、intent に `boundCredential: {digest, payer, validBefore}` を載せる。形が壊れた行は「結び付きあり・digest 不明」として扱い、以後どの credential も 409 にする（fail closed）。
- 再起動の後: 索引（§4.2）と結び付き（§4.3）は journal から戻る。`created` + 結び付きありは §4.5 の続行。`source_pending` 以降は前スライスの復旧の表のまま（unknown のまま、`paid_undelivered` を含む。R AC-9）。
- adapter の ledger は変えない（attempt の行は今と同じ。`created` の行の `requirements` が既にある）。

## 8. 一覧と文書

- R1（`routeListBody`）と MCP の一覧: 対象の route に `x402Url`（標準入口の URL）を足す。他の route の出力は変わらない。
- README に「標準の x402 クライアントで買う」の節: 例（`@x402/fetch`）、Bearer が要ること、承認の段が無いこと、1 GET = 1 注文で枠を使うこと、失敗の後のやり直しは新しい購入になること、hook を足した場合の危険（R §7）。
- `docs/subetha-exact-inbound-acceptance.md` に段 4 の標準クライアントの行を足す。

## 9. 試験

| # | 試験 | R の AC |
|---|---|---|
| T-a | `tests/unit/x402-entry-http.test.ts`: 402 の形（ヘッダーと本文、8 項目だけ）、400／404／405 の表、503／502、ヘッダーの重複 | AC-7、AC-10 |
| T-b | `tests/unit/x402-entry-core.test.ts`: settle 済み・`delivered` の標準の購入に開示が出ない、索引、digest の正規化（順序・大小）、結び付けの原子性（同時の違う 2 つ・同時の同じ 2 つ）、結び付けの直後と再生の後の読み直し、期限を過ぎた同じ credential の再送が記録を返す、遅れた本物の署名（`presentedValidBefore` あり）と偽の署名（なし）、結び付け後の早い拒否が `source_failed not_sent` になり再送で実行されない、開示が結び付きの `validBefore`（HTTP・R4・MCP・再生の後）、verify の通信失敗が `unknown`・明示の拒否が `verify_failed`、入口をまたぐ 2 方向、`offerFor` が標準 offer を返さない、`x402e:` の requestId の quote 入口が今までどおり、曖昧な `payTo` | AC-3、AC-5、AC-6 |
| T-c | `tests/unit/subetha-exact-adapter.test.ts` に追加: `entry: "x402"` の offer（期限 = 注文の期限、`existing` で止まる、窓が短いと止まる）、preflight（nonce 自由、`validBefore` の境界、quote 入口の offer は今のまま） | AC-2 |
| T-d | `tests/wire/x402-entry-client.test.ts`: **実物の `@x402/fetch` + `@x402/evm`**、実 CLI、実 TCP、合成 facilitator。通信の記録、署名の回数（signer を包んで数える。authorization は書き換えない）、実物の library での decode。枠: 同時の GET、2 つの principal、2 つの route、総数の枠、作成の応答の喪失（fixture の既存の障害の注入）で 402 が出ず注文が枠を超えない | AC-1、AC-2、AC-3、AC-4 |
| T-e | `tests/wire/x402-entry-restart.test.ts`: R AC-9 の各点。止め方: 402 の後 = 応答を受けてから SIGKILL、結び付けの後 = 新しい stop point `after_credential_bound`、verify を送った後 = fixture が verify の応答を保留している間に SIGKILL、settle の応答の喪失 = fixture が settle を実行して応答を保留している間に SIGKILL、settle・配達の記録の後 = 前スライスの stop point。stop point は前スライスと同じ試験用の起動（`tests/fixtures/router-subetha-exact-process.ts`）で入れる（実 CLI は入れない。`orchestrator.ts:258-265`） | AC-9 |
| T-f | 既存の全試験、R1 の snapshot、payer の一覧の試験 | AC-8 |

- 実物のクライアントは、既定では zUSDC に払わない（spendControls。R §1）。T-d のクライアントは `x402Client.fromConfig` に `spendControls.allowedAssets`（zUSDC、上限 20000）を渡す。それ以外の設定・hook・加工は無い。
- 実際の試験の置き場所（実装のレビュー 2 回を反映）: HTTP の表（T-a）は wire の試験（`tests/wire/x402-entry-client.test.ts`。実 process）に寄せた。core の分岐（T-b）は `tests/unit/x402-entry-core.test.ts`、adapter（T-c）は `tests/unit/subetha-exact-adapter.test.ts` の末尾の describe。
  期限を過ぎた同じ credential の再送、結び付け後の早い拒否、曖昧な `payTo`、壊れた結び付けの行、`existing`・短い窓、別の認証済み principal、quote 入口の注文の持ち込みを含む。
- 依存: `@x402/fetch`・`@x402/evm`・`@x402/core` 2.28.0 は Router の既存の実行時の依存（`src/adapters/outbound/x402.ts` など）。足さない・動かさない（`package.json` と lockfile は無変更）。標準入口のコードは import しない。
- 合成 facilitator（`tests/fixtures/subetha-exact-facilitator.ts`）は nonce を既に自由に受ける【事実】（`:454, 543-545`）。`validBefore > 注文の期限`の拒否が実物と同じ code であることを T-c／T-d で確かめる。
- sabotage: (1) adapter の nonce の分岐を外す、(2) 結び付けの行を書かない、(3) 409 を 402 に変える、(4) `offerFor` の守りを外す — それぞれで対応する試験が落ちることを確かめる。

## 10. 残す点

- R §7 のとおり（アプリのやり直しによる二重購入、利用者が足した hook、枠の消費、使われなかった署名、期限の窓）。
- 標準入口の 402 が `quoteId`・`paymentId` を出さないので、買い手が結果を R4 で読むには、`PAYMENT-SIGNATURE` 付きの応答の `X-Router-Payment-Id`（または本文の `paymentId`）を控える必要がある。同じ credential の再送でも読める。

## 11. v1 → v2 の対応（Codex `x402e-design-review1.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 1 must | `extra.entry` が preflight の key の検査に落ちる | §4.4 1(b)(i) |
| 2 must | preflight は署名を検証しない | §4.4 1(a) `checkSignature`、2 |
| 3 must | 鍵の中で intent を読み直す | §4.2 |
| 4 must | 開示が結び付きを読まない／`created` の意味 | §5 の開示、§4.4 5、§4.5、§7 |
| 5 must | verify の通信失敗が rejected | §5 の R FR-2.5 (e) の項、固定の文 |
| 6 should | requestId の接頭辞の予約 | §6 |
| 7 should | 409 の説明と順序 | §5 の冒頭、表 |
| 8 should | 試験の列挙 | §9 T-b、T-d、T-e |
| 9 note | 要件 v3 は前回の指摘を解いている | — |

## 12. v2 → v3 の対応（Codex `x402e-design-review2.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 新 1 must（前 2 partly） | `checkSignature` が実 CLI の包みを通らない | §1 の表、§4.4 1(a)（`src/main.ts` の `inboundByRoute`、fail closed） |
| 新 2 must（前 4 partly） | 開示の上書きが settle 済みの除外を飛び越す | §5 の開示（`disclosureOf` の分岐の順）、T-b |
| 新 3 note | 2 つの遷移の意味 | §4.4 5、§5 の R FR-2.5 (e) の項 |
