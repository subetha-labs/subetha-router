# 標準の x402 クライアント用の入口（受信レール `subetha-exact`）要件定義 v3

対象: 本 worktree（branch `task/x402-standard-entry`、基点 `origin/main` `45f46f6`）。要件フェーズの成果物であり、設計・実装は含まない。
入力はオーナーの指示（2026-11-21）: 「その入り口を足しましょう。SubEtha v2 に対応した Inbound を Router に足すことによって、標準の x402 の Client から zToken を Router に対して支払うことで、outbound の Provider を利用できるようになる形」。
前提のスライス: `docs/subetha-exact-inbound-{requirements,design,tasks,acceptance}.md`（PR #203、main に merge 済み）。本書はその上に**買い手向けの入口を 1 つ足す**。facilitator との間の手順（注文・settle・release・complete・復旧）は変えない。

v1 は Codex（`gpt-6-astra`、CLI、`.claude_workflow/local/x402e-req-review1.md`）の独立レビューで **REVISE**（must-fix 8、should-fix 2、note 1）。v2 は全件を反映した（§9 に対応表）。v2 の再レビュー（`x402e-req-review2.md`）は **REVISE**（前回の fixed 8・partly 3、新規 must 1・should 2・note 1）で、v3 はそれを反映した（§10）。v3 は単独の再レビューをせず、設計のレビューの入力に含める（小さな訂正に全体の再レビューを繰り返さない規則）。

facilitator の記述は protocol repo `origin/main` `68e061b`（以下 `P:`）、標準クライアントの記述は npm の `@x402/fetch` `@x402/core` `@x402/evm` 2.28.0（以下 `X:`。protocol repo の `node_modules` にある配布物を読んだ）、Router の記述は基点 `45f46f6`（以下パスのみ）について確認した。
印: 【事実】出典付き。【推論】本書の考え。【未確認】確かめていない。【決定】本書の要件としての決め。

## 0. 目的と範囲

**目的**: 何も手を加えていない標準の x402 v2 クライアント（`@x402/fetch` + `@x402/evm` の `exact`）が、Router の 1 つの URL を GET するだけで、
402 → 署名 → 再送の標準の手順で **Base Sepolia の zUSDC** を払い、Router が上流（outbound）の Provider に払って得たデータを 200 で受け取れるようにする。

| # | 内容 | 本スライス |
|---|---|---|
| S-1 | 新しい HTTP の入口（標準の x402 v2 の 402 と再送を受ける。以下「標準入口」） | 対象 |
| S-2 | `subetha-exact` adapter と core の、標準入口に必要な最小の変更（買い手が決める nonce、署名の有効期間、注文から quote を引く経路） | 対象 |
| S-3 | 一覧（R1／MCP）への標準入口の URL の追加、README・acceptance の追記 | 対象 |
| S-4 | 実物の `@x402/fetch` を使った合成 facilitator との試験（`@x402/fetch`・`@x402/evm`・`@x402/core` 2.28.0 は Router の既存の実行時の依存。新しく足さない） | 対象 |
| S-5 | 段 4（testnet の実購入）で標準クライアントからも 1 回以上買うこと | 対象（段 3 の登録の後。オーナーの承認済みの段 4 の枠の中） |
| S-6 | 他の受信レール（Base Sepolia USDC の `x402`、Arc、Solana、MPP）と動的プロファイルへの標準入口 | 対象外 |
| S-7 | 認証なしの公開、hosted Router への展開、ブラウザ（CORS）、x402 v1（`X-PAYMENT`） | 対象外 |
| S-8 | `@subetha/payer` の対応 | 対象外（今までどおり、この route を載せない・署名しない） |

## 1. 前提の事実

- **標準クライアントの手順**【事実】: 最初の応答が 402 のとき `PAYMENT-REQUIRED` ヘッダー（base64 の JSON）を読み、`accepts` から 1 つ選んで署名し、
  同じ要求に `PAYMENT-SIGNATURE` ヘッダーを足して再送する。元の要求のヘッダーは保たれる（`X:fetch/dist/esm/index.mjs:31-67`）。
  **JSON の本文だけでは動かない**: v2 のクライアントは `PAYMENT-REQUIRED` ヘッダーを要る（`X:core/dist/esm/chunk-FV2JN4FK.mjs:2156-2164`）。
  呼び出し側がすでに `PAYMENT-SIGNATURE`／`X-PAYMENT` を付けた要求への 402 でも、**署名を作った後で**例外にする（`X:fetch/index.mjs:45-53`）。つまり 402 に署名できる offer があれば署名は作られる。
- **標準クライアントの署名**【事実】: EIP-3009 の `TransferWithAuthorization`。`to = payTo`、`value = amount`、**`validAfter = "0"`**、`validBefore = floor(now/1000) + maxTimeoutSeconds`、
  `nonce` は**クライアントが作る 32 byte の乱数**（v2: `X:evm/dist/esm/chunk-DLPUE5VK.mjs:26-35, 107-138`、`chunk-EKCH75YB.mjs:25-26`。v1 の class だけが `now − 600` を使う）。
  payload は `{x402Version: 2, accepted, resource, extensions, payload: {authorization, signature}}` で、`accepted` は選んだ requirements の写し、`resource` と `extensions` は 402 のものの写し（`X:core/dist/esm/client/index.mjs:300-305`）。
- **再署名の条件**【事実】: 再送の応答を `processPaymentResult` が読み、client に登録された hook が `recovered: true` を返したときだけ**新しい payload に署名して再々送する**（`X:fetch/dist/esm/index.mjs:63-78`、`X:core/dist/esm/chunk-FV2JN4FK.mjs:2204-2232`）。
  再署名は**最初の 402 の requirements**に対して行う（`X:fetch/index.mjs:68-69`）ので、2 回目の応答の `accepts` を空にしても hook を持つクライアントは止まらない。
  既定の構成には応答の hook も extension も無く（`X:core/client/index.mjs:65-75`）、`exact` の client は recovery の hook を足さない（`X:evm/chunk-DLPUE5VK.mjs:78-140`）。
  **利用者が自分で足した hook は server からは止められない**（§7）。
- **標準クライアントの支払いの制限（spendControls）**【事実】: `@x402/core` 2.28.0 の client は、既定では library が知っている「既定の資産」（USDC など）にしか払わない。
  zUSDC は既定の資産ではないので、買い手が `spendControls.allowedAssets` に zUSDC（network と資産の address）を足すか `spendControls: false` にしないと、402 を受けても署名しない
  （`X:core/dist/esm/x402Client-C7_OogbK.d.mts:1885-1917`。実装の試験で実際に拒まれた: 「All payment requirements were rejected by spendControls」）。
  これは library の普通の設定であり、hook でも Router 向けの加工でもない。sample Provider など zUSDC を受ける全ての Provider に同じことが言える。AC-1 の「手を加えていない」はこの設定を含む。
- **`resource.url`**【事実】: 既定のクライアントは `resource.url` と要求の URL の不一致を拒まない。payload に写すだけ（`X:fetch/index.mjs:31-32`、`X:core/client/index.mjs:300-305`）。
- **facilitator の requirements**【事実】: 注文ごとに `{scheme: "exact", network, asset, amount, payTo, maxTimeoutSeconds, extra: {name, version}}`。`payTo` は注文ごとに違う。
  `maxTimeoutSeconds = max(1, floor(challengeTtlSeconds / 2))`（`P:packages/zerc20-v2-adapter/src/exact-settle.ts:231-238`）。
  protocol repo の public testnet 用の設定は TTL 300（= `maxTimeoutSeconds` 150）（`P:deploy/public-testnet/facilitator-multi.env:50`）。これは設定の記録であり、動いている hosted の値の証明ではない（段 4 で実際の requirements を記録する）。
- **facilitator の検査**【事実】: 注文は `authorization.to`（= `payTo`）から引く。`accepted` は上の 8 項目が注文のものと一致すること（余分な `extra` の項目は見ない）。
  `nonce` に条件は無い（注文と authorization の結び付きは `from + nonce`、1 注文に 1 authorization。別の authorization は `order-bound-to-another-authorization`）。
  `validBefore ≤ 注文の expiresAt`（超えると `valid-before-after-order-expiry`。これは**予約（settle）の時の制約**であり、verify が拒むとは限らない）（`P:exact-settle.ts:242-254, 602-605`、`P:burn-sale-backend.ts:1110-1115`）。
  本物の authorization は `validBefore` まで誰でも chain に出せる（facilitator 自身が外からの broadcast を扱う。`P:exact-settle.ts:592-628`）。
  したがって標準クライアントが通るのは、**署名の時刻 + `maxTimeoutSeconds` ≤ 注文の期限**のときだけ（注文の作成から TTL の半分まで）【推論】。
- **sample Provider**【事実】: `PAYMENT-REQUIRED` で `accepts` と `extensions.subetha.info.orderId` を返し、`PAYMENT-SIGNATURE` を受ける（`P:apps/provider-x402-ext-sample/test/fork/fork.test.ts:152-153, 221`）。
- **Router の今の入口**【事実】: 全ての HTTP の口は Bearer の principal を要る（`src/http/app.ts:299-304`）。購入口 R3（`GET /v1/routes/{routeId}/resource`）は、credential なしだと quote を作らない。quoteId も無ければ `accepts: []` と `quoteUrl` を、有効な quoteId があればその発行済みの offer を返す（`src/http/app.ts:662-672`）。
  credential は `X-Payment` + `X-Router-Quote-Id` で、`payload.challengeNonce` と `authorization.nonce` が offer の `challengeNonce`（= 注文 id）に一致し、`validBefore ≤ offer.extra.expiresAt`（= min(注文の期限, 発行 + 120 秒)）であることを要る（`src/adapters/inbound/subetha-exact.ts:400-413, 329-334`）。
- **Router の枠**【事実】: 注文を作った attempt は、settle が確定するか注文の期限 + 猶予を過ぎるまで「未解決」に数える。枠の既定は総数 100・未解決 3・毎分 6（`src/shared/subetha-exact.ts:36`。設定で変えられる）（`src/adapters/inbound/subetha-exact-ledger.ts:227-236`、`subetha-exact.ts:276-285`）。
  **払われない 402 は注文を 1 つ作り、注文の期限 + 猶予まで未解決の枠を 1 つ、総数の枠を 1 つ（戻らない）使う**。作成の応答が失われた attempt は operator が abandon するまで未解決のまま【事実】。
- **Router の今の core**【事実】: 静的 route の購入は、quote が `created` を離れた後は**credential を比べずに**今の結果を返す（`src/core/orchestrator.ts:772-778`）。
  verify が遠隔で失敗すると adapter は `isValid: false` にまとめ、core は `rejected` を記録する（`subetha-exact.ts:433-440`、`orchestrator.ts:927-934`）。
  `settleWindowOf` は offer の `extra.expiresAt`（発行 + 120 秒が上限）を返し、core は verify の前と中断の後の開示にそれを使う（`subetha-exact.ts:322-334, 416-417`、`orchestrator.ts:336-345, 855-859`）。
  再起動後、`source_settled` まで残った購入は配達を再開せず `paid_undelivered` になる（`src/core/store.ts:706-715`）。

## 2. 用語

- **標準入口**: 本書が足す URL。credential なしの GET に 402 と署名できる offer を返し、`PAYMENT-SIGNATURE` 付きの GET を購入として扱う。
- **quote 入口**: 今ある手順（`POST /v1/quotes` → `npm run sign` → R3、または MCP）。
- **標準 offer**: 標準入口が出す offer。facilitator の requirements と 8 項目が一致する。

## 3. 決めたこと（要件の水準）【決定】

| # | 問い | 答え |
|---|---|---|
| D-1 | どこに足すか | **新しいパス**。今ある R1〜R4・MCP・`npm run sign` の応答と挙動は変えない（一覧に項目が 1 つ増えることを除く。D-12）。R3 の意味は変えない。 |
| D-2 | どの route か | `sourceRail: "subetha-exact"` の静的 route だけ。それ以外の routeId は標準入口では存在しない（404）。 |
| D-3 | 認証 | 今までどおり principal の認証（`x-router-principal` と `Authorization: Bearer`。`src/http/auth.ts:41-54`）を要る。401 は 402 より先。標準クライアントは要求のヘッダーをそのまま再送するので通る（§1）。認証なしの公開は別スライス。 |
| D-4 | x402 の版 | v2 だけ（`PAYMENT-REQUIRED`／`PAYMENT-SIGNATURE`／`PAYMENT-RESPONSE`）。`X-PAYMENT`（v1）を標準入口に送った要求は固定の 400 で拒み、何も作らない。 |
| D-5 | requestId と quote | 買い手は requestId も quoteId も送らない。Router が内部で作る。再送された credential からは **`authorization.to`（注文ごとの `payTo`）と principal と route** で quote を引く。この対応（正規化した `payTo` → principal・route・quote・payment・入口の印）は**永続**で、再起動の後も引ける。対応が 1 つに決まらないときは拒む（fail closed）。 |
| D-6 | 人の承認 | 標準入口には Router 側の承認の段は無い。払うかどうかはクライアントの側の方針が決める。README と一覧でそう明示する。quote 入口・MCP の承認の規則は変えない。 |
| D-7 | nonce と有効期間 | 標準 offer への credential は、`nonce` を任意の 32 byte、`validAfter ≤ 今`、`validBefore ≤ 注文の期限`で受ける。`payload.challengeNonce` は要らない。quote 入口の offer への credential の検査は今のまま。**3 つの期限を分ける**: 受付の期限（Router が credential を受ける上限）、注文の期限、authorization の期限（`validBefore`）。開示（`mayStillSettleUntil`）は FR-2.9。 |
| D-8 | 入口をまたぐ使用 | 標準 offer は標準入口でだけ、quote 入口の offer は quote 入口でだけ買える。またぐ要求は facilitator を呼ばずに拒む。 |
| D-9 | 再署名を誘わない | `PAYMENT-SIGNATURE` か `X-PAYMENT` を持つ要求への応答は、**標準入口への要求である限り、どの場合も（エラーも、その入口の途中の層の応答も）支払いの challenge を持たない**: 402 にせず、`PAYMENT-REQUIRED` ヘッダーも署名できる offer も付けない。保証の範囲は既定の構成の標準クライアント（hook なし）。R3 の今の 402（credential 付きの要求への再提示）は変えない。 |
| D-10 | 1 つの注文を 2 度見せない | credential なしの GET は**毎回新しい注文**を作る（前スライスの枠の中で）。**一度 402 で見せた標準 offer を、別の GET への応答で再び見せない**（同じ注文に 2 つの署名を誘わないため。前スライスの FR-4.5 と同じ考え）。枠が尽きたら 402 ではなく 503 + `Retry-After`。同時の GET でも、共有の枠を超えて注文を作らず、1 つの注文を 2 つの応答に見せない（仕組みは設計）。 |
| D-11 | 同じ注文への 2 つ目の署名 | 1 つの標準 offer に受ける credential は 1 つ。最初の credential は、外への呼び出しの前に**永続かつ原子的に**その注文に結び付ける。違う authorization が来たら facilitator に送らず固定の 409 で答え、**「この要求は、この credential を転送せず、settle を始めていない」**と言い、過去に渡していないこと・未払いであることは言わない。持ち主が確かめられた注文については、今の `paymentId`・状態・当てはまる開示（FR-2.9）を併せて示す。同じ credential の再送は、今の状態（`delivered` なら本文）を返す。credential の同一性は FR-2.6。 |
| D-12 | 一覧 | R1 と MCP の一覧は、対象の route に標準入口の URL を 1 項目で示す。 |

## 4. 機能要件

### 4.1 credential なしの GET（offer の発行）

- **FR-1.1** 標準入口は `GET` だけを受ける。クエリは受けない（今の規則どおり）。
- **FR-1.2** credential の無い要求には、Router が内部の requestId で quote を作り（= facilitator に注文を 1 つ作り）、**402** を返す。
  `PAYMENT-REQUIRED` ヘッダーは x402 v2 の `{x402Version: 2, error, resource, accepts: [標準 offer]}`。本文にも同じ内容の JSON を置く。
- **FR-1.3** 標準 offer の `scheme`・`network`・`asset`・`amount`・`payTo`・`maxTimeoutSeconds`・`extra.name`・`extra.version` は facilitator の注文の requirements と**同じ値**（§1）。
  それ以外の項目を `extra` に足すかどうかは設計が決めるが、足しても標準クライアントの署名と facilitator の検査が変わらないことを試験で示す。
- **FR-1.4** `resource.url` は設定の公開の基点から作る（`Host` ヘッダーから作らない。今の規則どおり）。
- **FR-1.5（再提示しない）** D-10。標準入口は発行済みの標準 offer を別の応答で再び返さない。credential なしの GET は新しい内部 requestId で新しい注文を作る。
  facilitator が同じ買い手・同じ資源の組に**既存の注文**を返した場合（前スライスの `existing`）、それを 2 度目の署名の対象として見せない（503 で答えるか、別の組で作るかは設計が決める）。
  同時の GET・複数の principal・複数の route でも枠を超えない。
- **FR-1.6** 注文を作れないとき（枠、facilitator の不通・拒否）は、前スライスの分類のまま **503 + `Retry-After`**（`source_offer_unavailable`）か **502**（`source_offer_refused`）で答える。402 にしない。理由の文字列は前スライスの sanitized の集合だけ。
  `Retry-After` は待てば戻る枠（毎分・未解決）の目安であり、**総数の枠が尽きたときに自動で戻ることは約束しない**（operator の判断で上げる）。枠を戻すために attempt を黙って消したり abandon したりしない。
- **FR-1.7** credential なしの GET は、買い手の資金を動かさない。journal と ledger に残る行は quote 入口の quote と同じ種類だけ。

### 4.2 `PAYMENT-SIGNATURE` 付きの GET（購入）

- **FR-2.1** `PAYMENT-SIGNATURE` は base64 の JSON。大きさの上限は今の `X-Payment` と同じ。読めないもの・v2 でないもの・`exact` の EIP-3009 の形でないもの・ヘッダーが空か重複しているもの・`PAYMENT-SIGNATURE` と `X-PAYMENT` の両方を持つものは **400** で拒み、facilitator を呼ばない。
- **FR-2.2** quote は D-5 で引く。引けない（他の principal の注文、知らない `payTo`、他の route、quote 入口の注文）ときは **固定の 1 つの応答（同じ status・本文・ヘッダー。D-2 の 404 と同じもの）**で拒み、存在を明かさない。facilitator を呼ばない。
- **FR-2.3** 手元の検査（facilitator を呼ぶ前）: `accepted` の 8 項目が標準 offer と一致、`authorization.to = payTo`、`value = amount`、D-7 の期間、署名の復元が `from` と一致。
  1 つでも外れたら facilitator を呼ばずに拒む。応答は D-11 と同じ文言（「この要求は、この credential を転送せず、settle を始めていない」。未払いとは言わない）に、持ち主が確かめられた注文の `paymentId`・状態・当てはまる開示を添える。
  **署名として本物であること**と**受け付けられること**は別: `validBefore > 注文の期限`の credential は、署名が本物でも受け付けず、facilitator に送らない（手元の拒否）。その応答は、拒んだ credential 自身の `validBefore` を「この署名が chain で使われ得る上限」として示す（結び付けはしない）。
  **順序**: 同じ credential の再送かどうか（FR-2.6）を、時刻に依る検査（期限）より**先に**判定する。期限を過ぎた credential でも、記録済みの結果は読める。
- **FR-2.4** 検査を通った credential は、quote 入口の購入と**同じ core の経路**（verify → settle 1 回 → release → 上流への支払い → 配達 → complete）に入る。前スライスの不変条件（settle は 1 回、unknown を rejected にしない、復旧の表）はそのまま。
- **FR-2.5（応答）**
  (a) `delivered`: **200**、本文は上流の JSON、`PAYMENT-RESPONSE` ヘッダーに `{success: true, transaction, network, payer}`。Router の `paymentId` を別のヘッダーで示す。
  (b) settle が確定して上流のデータが無い（`paid_data_unavailable` など）: 402 以外。`PAYMENT-RESPONSE` は `success: true`。本文は R4 と同じ公開の射影（`paymentId`、状態）。
  (c) unknown・未確定: 402 以外。本文に `paymentId`、`mayStillSettleUntil`、`awaitingPaymentDoesNotMeanUnpaid: true`（前スライスの開示と同じ条件）。`PAYMENT-RESPONSE` は付けない。
  (d) facilitator が settle を拒んだ: 402 以外。「拒否は未払いの証明ではない」ことを本文で言い、`paymentId` と `mayStillSettleUntil` を示す。
  (e) **verify** が拒まれた・時間切れ・壊れた応答・切断: 402 以外。本文に `paymentId` と `mayStillSettleUntil`（= その credential の `validBefore`）、`awaitingPaymentDoesNotMeanUnpaid: true`。
      verify の拒否も失敗も未払いの証明ではない（authorization は `validBefore` まで chain で使える）。標準入口の購入では、この結果を「何も払われていない」と読める形で記録・表示しない。
      その注文に新しい offer を出さず、settle をやり直さない。quote 入口の今の挙動は変えない。
  (f) credential を結び付けた後・settle の前の Router 側の拒否（予算、上流の事前の検査、受付の期限）: 402 以外。(e) と同じ開示。
  具体的な status は設計が決める。どの場合も D-9 を守る。`PAYMENT-RESPONSE` は base64 の JSON（x402 v2 の settle の応答の形）で、実物の library で decode できること。
- **FR-2.6（同じ credential の再送）** D-11。credential の同一性は**意味で**決める: 正規化した `from`・`to`・`value`・`validAfter`・`validBefore`・`nonce`・署名が全て同じなら同じ credential。
  base64 の文字列や JSON の項目の順序の違いは別物にしない。同じ credential の再送は新しい支払いも 2 回目の settle も起こさず、今の状態を返す。
  最初の credential の結び付けは、verify を呼ぶ前に永続にする。同時に届いた同じ credential・違う credential でも、結び付くのは 1 つだけ。
- **FR-2.7（違う credential）** D-11。facilitator を呼ばない。
- **FR-2.9（開示の期限）** 標準 offer を 402 で見せた時点から、その注文について「払われたかもしれない」上限を**実際より短く言わず、再起動で失わない**。保守的な値から、結び付けた credential の正確な値へ狭めることは許す。
  正確な値は**結び付けた credential**のものであり、「その注文へのあらゆる authorization が切れた」ことの証明ではない（応答はそう読める文言にしない）。
  credential を検査する前は、受け得る全ての authorization を覆う保守的な値（注文の期限）を永続にして使う。credential を検査した後は、その `validBefore` を永続にして使う。
  前スライスの「発行 + 120 秒」の上限は quote 入口の offer だけに使い、標準 offer の開示に使わない。受付の期限は注文の期限と core の期限の両方を守る。quote 入口の開示は変えない。
- **FR-2.8** 結果は R4（`GET /v1/purchases/{paymentId}`）と MCP の status でも読める。標準入口の購入は (e)(f) の正直な結果を持ち得るが、quote 入口から始まった購入の R4／MCP の表示は今と同じ。標準入口の購入は journal で quote 入口の購入と区別できる（入口の印を 1 つ持つ）。

### 4.3 既存の入口との関係

- **FR-3.1** D-8。標準 offer の quoteId を R3 に、quote 入口の quoteId の注文の `payTo` を標準入口に持ち込んでも買えない。
- **FR-3.2** `POST /v1/quotes`・R3・R4・MCP・`npm run sign` の応答は、標準入口を使わない限り byte 単位で今と同じ（一覧の 1 項目を除く）。FR-4.5（closed の再 quote）は quote 入口でそのまま成り立つ。
- **FR-3.3** 一覧（D-12）: 対象の route に標準入口の URL を示す。`@subetha/payer` はこの route を今までどおり載せない（前スライスの試験が通ること）。

### 4.4 枠と負荷

- **FR-4.1** 標準入口が作る注文も、前スライスの枠（総数・未解決・毎分）と ledger に数える。別の枠を作らない。
- **FR-4.2** 枠の残りが無いときの応答は FR-1.6。標準入口のせいで quote 入口が使えなくなること（逆も）は起こり得る。README に書く。

## 5. 非機能要件

- **NFR-1（退行なし）** 既存の試験が全て通る。標準入口を使わない Router の挙動は変わらない。
- **NFR-2（秘密）** Provider token、`PAYMENT-SIGNATURE` の値、署名は、ログ・エラー本文・journal の公開の射影に出さない。
- **NFR-3（依存）** 依存を足さない・動かさない。`@x402/fetch`・`@x402/evm`・`@x402/core`（2.28.0 固定）は Router の既存の**実行時の依存**（送信側の x402 adapter が使う）であり、試験はそれを使う。標準入口のコード（`src/http/x402-entry.ts`）はこれらを import しない。`package.json` と lockfile は変えない。
- **NFR-4（testnet だけ）** 対象は今までどおりローカルの Router と testnet。

## 6. 受け入れの条件（合成 facilitator）

- **AC-1** 実 CLI（`src/main.ts`）・実 TCP・合成 facilitator に対し、**手を加えていない `@x402/fetch` の `wrapFetchWithPayment` + `@x402/evm` の `exact` の client** が、標準入口の URL と Bearer ヘッダーだけで GET して **200 と上流のデータ**を得る。
  クライアントの準備は普通の signer と network の登録だけで、hook・fetch の書き換え・Router 向けの payload の加工をしない。Router の独自の項目（requestId、quoteId、`challengeNonce`、`X-Router-*` ヘッダー）をクライアントに教えない。
  通信を記録し、「402 → 署名 1 回 → Bearer 付きの再送 → 200」であること、`PAYMENT-REQUIRED` と `PAYMENT-RESPONSE` が**実物の library で decode でき**、`transaction`・`network`・`payer` が fixture の settle と一致することを確かめる。
  journal に前スライスの AC-1 と同じ順の行があり、fixture の注文が `release.state: "delivered"` になる。この試験が示すのは fixture との相互運用であり、hosted の settle や finality ではない。
- **AC-2** AC-1 の署名は `validAfter = "0"`、`validBefore = now + maxTimeoutSeconds`、乱数の `nonce` であり（**クライアントが作ったまま。試験は authorization を書き換えない**）、Router と fixture がそれを受ける。fixture は `validBefore > 注文の期限`を実物と同じ理由で拒む。
  402 を受けてから遅れて署名した場合（`validBefore` が注文の期限を超える）は、Router が手元で拒み、fixture を呼ばず、応答がその credential の `validBefore` を示す。境界の値も試す。
- **AC-3（再署名を誘わない）** 次の各場合に、`PAYMENT-SIGNATURE` 付きの要求への応答が署名できる offer を持たず、実物のクライアントが 2 つ目の署名を作らないこと（署名の回数を数える）:
  verify が拒否・時間切れ・壊れた応答・切断、settle が unknown、settle が拒否、release が未確定、上流が失敗（`paid_data_unavailable`）、settle の前の予算・上流の拒否、手元の検査の失敗、違う credential（409）、引けない `payTo`（404）。
  各場合に応答が 402 でなく `PAYMENT-REQUIRED` を持たないこと、(c)(d)(e)(f) の本文に `paymentId` と FR-2.9 の `mayStillSettleUntil` があること、公開の射影が「未払い」と読めないことを確かめる。保証の範囲は既定の構成（hook なし）。
- **AC-4（再提示しないことと枠）** credential なしの GET を続けて送ると、402 のたびに `payTo` が違い、同じ標準 offer が 2 つの応答に現れない（同時の GET でも）。未解決の枠が尽きた後の GET は 503 + `Retry-After` で 402 ではなく、fixture の注文は枠の数を超えない（同時の GET、2 つの principal、2 つの route）。
  総数の枠が尽きた状態、注文の作成の応答が失われた状態でも 402 を返さず、attempt が黙って消えない。credential が届かなかった（遅れた・失われた）注文は、次の GET で再び見せられない。
- **AC-5（1 注文 1 credential）** 同じ標準 offer に 2 つの違う authorization を送ると（順に・同時に）、結び付くのは 1 つで、他方は 409、fixture への verify／settle の呼び出しが増えない。同じ credential の再送（同時を含む、JSON の項目の順序を変えたものを含む）は fixture の settle を増やさず、`delivered` の後は同じ本文を返す。
  期限を過ぎた後の同じ credential の再送が、記録済みの結果を返す。
- **AC-6（入口をまたがない）** FR-3.1 の 2 方向が拒まれ、fixture への呼び出しが増えない。
- **AC-7（存在を明かさない）** 他の principal の標準 offer の `payTo` を使った credential、知らない `payTo`、対象外の routeId は、互いに区別できない固定の応答になる。
- **AC-8（退行なし）** 標準入口を足す前の試験が全て通る。R1 の一覧の差分は対象の route の 1 項目だけ（snapshot）。payer の一覧の試験が通る。
- **AC-9（再起動）** 次の各点で止めて再起動する: 402 を返した後（credential なし）、credential を結び付けた後・verify の前、verify を送った後、settle を送って応答を失った後、settle を記録した後、配達を記録した後。
  結び付けの前（最初の点）: `payTo` からの対応と開示が残り、その標準 offer が次の GET で再び見せられず、後から届いた最初の credential は規則どおり扱われる。
  結び付けの後（残りの点）: 結び付きが残る、同じ credential の再送が同じ `paymentId` の今の状態を返す、違う credential は 409、settle と上流への支払いが 2 回起きない、開示（FR-2.9）が失われない。
  許す結果は前スライスの復旧の規則のまま（unknown のまま残る、`paid_undelivered` になる、を含む）。配達の成功や確定を要件にしない。
- **AC-10（v1 と壊れた入力）** `X-PAYMENT` だけの要求、両方のヘッダーを持つ要求、空・重複のヘッダー、base64 でない値、上限を超える値、`accepted` の無い payload が 400 で、402 でなく、注文も journal の行も増えない。

## 7. やらないこと・残す危険

- **二重購入**: 標準の x402 では「GET を 1 回 = 購入を 1 回」であり、失敗の後にアプリが同じ GET をやり直すと新しい注文に新しい署名をする。Router は D-9 で**応答の中では**誘わないが、アプリのやり直しは止められない。README に書く。quote 入口の「1 requestId = 1 購入」の守りは標準入口には無い。
- **利用者が足した hook**: 標準クライアントに recovery の hook を自分で足した利用者は、Router の応答に関係なく最初の requirements に再署名できる（§1）。server からは止められない。保証は既定の構成まで。
- **枠の消費**: 払われない 402 は注文を 1 つ使う（D-10）。既定の未解決 3 では、払わない GET が 3 回で注文の期限 + 猶予まで入口が 503 になり、quote 入口も同じ枠で止まる。総数の枠は戻らない。枠の値は operator が設定で決める。
- **使われなかった署名**: 409 や手元の検査で拒んだ credential は、本物の authorization を含み得る。買い手の手元から他へ渡れば chain で使われ得る。Router は「この要求では転送していない」としか言わない。
- **期限の窓**: 標準クライアントは `validBefore = now + maxTimeoutSeconds` を選ぶので、402 を受けてから署名までに時間を置くと `validBefore` が注文の期限を超える。Router はそれを手元で拒み（FR-2.3）、facilitator に送らない。無くせない。
- **認証なしの公開・hosted・他の rail**: 対象外（S-6、S-7）。

## 8. 出典と未確認

- 出典は §1 の各項に示した。protocol は `68e061b`、`@x402/*` は 2.28.0、Router は `45f46f6`。
- v1 の【未確認】4 件は Codex のレビューで解けた（§1 に行を示した）: v2 の署名の値、既定の hook が無いこと、`resource.url` の不一致を拒まないこと、設定上の TTL 300。
- 【未確認】動いている hosted facilitator の実際の `maxTimeoutSeconds`。段 4 で 402 の requirements を記録して確かめる。段 4 の実購入（S-5）は、オーナーが承認した段 4 の枠と記録の規則（`docs/subetha-exact-inbound-acceptance.md` §3）の中でだけ行う。

## 9. v1 → v2 の対応（Codex `x402e-req-review1.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 1 must | v2 の署名は `validAfter = "0"` | §1、AC-2 を訂正 |
| 2 must | 既存ヘッダーの guard は署名の後。再署名は最初の requirements に行う | §1 を訂正。D-9 を「challenge を一切持たない」に強め、保証の範囲を既定の構成に限定。§7 |
| 3 must | 同じ注文の再提示は再署名を誘う | D-10・FR-1.5 を「再提示しない・毎回新しい注文」に変更。AC-4 |
| 4 must | 永続・原子的な credential の結び付けが無い | D-5、D-11、FR-2.3 の順序、FR-2.6、AC-5、AC-9 |
| 5 must | 開示の期限が短くなる | D-7 の 3 つの期限、FR-2.9、AC-2、AC-3、AC-9 |
| 6 must | verify の失敗が契約に無い | FR-2.5 (e)(f)、AC-3 |
| 7 must | 409 と手元の拒否の文言が言い過ぎ | D-11、FR-2.3 の文言。「資金は動かない」を削除。§7 |
| 8 must | AC-9 が言い過ぎ | 止める点と許す結果を列挙 |
| 9 should | 枠 | §1、FR-1.6、AC-4、§7 |
| 10 should | wire の証明 | §1（ヘッダー必須）、FR-2.1、FR-2.2、FR-2.5、AC-1、AC-7、AC-10 |
| 11 note | 残りの出典 | §1、§8 |

## 10. v2 → v3 の対応（Codex `x402e-req-review2.md`）

| # | 指摘 | 対応 |
|---|---|---|
| 5 partly / 新 1 must | 期限の規則の矛盾と開示 | FR-2.3（手元の拒否、本物であることと受付の区別、拒んだ credential の `validBefore` の開示）、FR-2.5 (f) の範囲、FR-2.9 の定義、AC-2、§7 |
| 7 partly | 409／手元の拒否に今の状態と開示を添える | D-11、FR-2.3、§7 の文言 |
| 8 partly / 新 2 should | AC-9 の結び付け前の点 | AC-9 を前後に分けた |
| 新 3 should | D-9 の範囲 | 標準入口への要求に限定。R3 は変えない。FR-2.8 |
| 新 4 note | 「直列」は設計 | D-10、FR-1.5 を観測できる要件に |
