# 受信レール `subetha-exact`（Router = SubEtha v2 facilitator の Provider）設計 v5.3

> 入力: `docs/subetha-exact-inbound-requirements.md` v4.2（Codex review 4 回、APPROVE WITH CHANGES + 註）。本書は設計フェーズの成果物で、実装は含まない。
> facilitator は protocol repo `origin/main` `68e061b`（`P:`）、Router は本 branch の基点 `1dc29ad`。行番号は `grep -n` で確かめた。
> v1 は Codex の独立レビュー（`.claude_workflow/local/design-review1.md`、REVISE、must-fix 11・should-fix 2）を受け、v2 で全件を反映した（§14）。v2 の再レビュー（`design-review2.md`、REVISE、partly 8・新規 must 1）を v3 で反映した（§15）。v3 の再レビュー（`design-review3.md`、REVISE、must 4・should 2）を v4 で反映した（§16）。v4 の再レビュー（`design-review4.md`、REVISE、must 2・should 2）を v5 で反映した（§17）。v5 の再レビュー（`design-review5.md`、**APPROVE WITH CHANGES**、should 3）を v5.1 で反映した（§17 の末尾）。

## 0. 要約

| 項目 | 決定 |
|---|---|
| rail 名 / scheme | `sourceRail: "subetha-exact"` / offer の `scheme: "exact"`（標準の x402 EIP-3009。買い手の署名は `npm run sign` の既存の x402-EVM の分岐） |
| 1 購入の facilitator 呼び出し | `POST /exact/orders`（quote）→ `POST /exact/verify`（公開）→ `POST /exact/orders/:id/settle` → `POST /exact/orders/:id/release` → `POST /exact/orders/:id/complete`。読み取りの GET は release の復元と requester の照会だけ |
| port の変更 | `CreateOfferRequest.requester?`、`verify` の結果に `mayStillSettleUntil?`、任意の `settleWindowOf`・`release`・`complete`（**持たない rail は結果 `none`**）、`InboundOfferError` |
| core の変更 | `deliver()` の先頭に release（行 `source_released`）、終端の後に complete（行 `source_completed` / `source_complete_unreported`）、起動時の complete の掃き出し（core が所有し `close()` で待つ）、`mayStillSettleUntil` の耐久と開示、**`created` を離れた quote の再 quote は `closed: true` で offer 無し（全 rail）**、`SAFE_REASONS` に 5 つ、試験用の停止点 |
| 状態機械 | **状態は増やさない**。新しい行は `source_settled` の intent に欄を足すだけ。再起動の規則は既存のまま（§6） |
| adapter の耐久の記録 | `<journal のディレクトリ>/subetha-exact/orders.ndjson`（既存の `Journal` を再利用: fsync・flock・replay の検査）。**1 行の鍵は attempt**（要求ごとの識別子）。`requester.salt` は fsync つきで作る |
| 表 | `KnownAsset.rails?`（資産単位の rail の上書き）。`eip155:84532` に zUSDC を足し `{ inbound: ["subetha-exact"], outbound: [] }` |
| 試験 | 合成 facilitator `tests/fixtures/subetha-exact-facilitator.ts`（tenant の面を source のとおりに模す + 試験の操作）。core と adapter の**停止点**（試験の能力からだけ注入）で再起動の境界を決定的に作る |

## 1. 流れ（1 購入）

```
buyer                 Router core                adapter subetha-exact                facilitator /p/<id>
  | POST /v1/quotes      |                              |                                     |
  |--------------------->| readChallenge(upstream)      |                                     |
  |                      | createOffer(+requester) ---->| limits → ledger: requested (fsync)  |
  |                      |                              |-- POST /exact/orders -------------->| 201/200 {orderId, requirements, status, binding, existing}
  |                      |                              | validate → ledger: created          |
  |                      |<--- offer (payTo = burn addr, challengeNonce = orderId)            |
  |<-- quote (expiresAt) | journal: created                                                   |
  | npm run sign (validBefore = expiresAt, nonce = orderId)                                   |
  | GET resource + credential                                                                 |
  |--------------------->| preflight (sync) → readAndMatch(upstream) → balance → source_pending|
  |                      | verify ------------------->| local EIP-712 → POST /exact/verify  | {isValid}
  |                      |   {isValid, mayStillSettleUntil}                                   |
  |                      | deadline → budget → deadline                                       |
  |                      | settle ------------------->| POST /exact/orders/:id/settle ------>| {success, outcome, transaction, ...}
  |                      |   settled | unknown         |                                     |
  |                      | journal: source_settled                                            |
  |                      | release ------------------>| POST /exact/orders/:id/release ----->| {deliveryKey, txRef, eventId} | 425 | 409 | ...
  |                      |   released → journal: source_released                              |
  |                      |   refused/unknown → journal: paid_undelivered (not_sent)            |
  |                      | readAndMatch(upstream) → destination_pending → pay → delivered     |
  |                      | complete ----------------->| POST /exact/orders/:id/complete ----->| {state, completedAt}
  |                      |   journal: source_completed | source_complete_unreported            |
  |<-- 200 body          |                                                                    |
```

## 2. port の変更（`src/ports/inbound.ts`）

```ts
export interface CreateOfferRequest {
  …既存…;
  /** quote の要求の識別（要件 FR-2、§3-4）。core は静的・動的・秘匿の 3 箇所で渡す。使うのは `subetha-exact` だけ（他の rail は読まない）。 */
  readonly requester?: { readonly principalId: string; readonly requestId: string };
}
/** verify の結果（既存の 2 欄 + 1 欄）。 */
export interface InboundVerifyResult {
  readonly isValid: boolean;
  readonly fundsMoved?: boolean;
  /** 手元の署名の検査が通った = 実行可能な authorization が存在する。その `validBefore`（unix 秒）。無い rail は欄なし（要件 FR-4.1・FR-4.4）。 */
  readonly mayStillSettleUntil?: number;
}
export interface InboundCallContext { readonly routeId: string; /** release・complete の操作全体の期限（承認期限。無ければ adapter の既定）。 */ readonly deadlineMs?: number; /** settle の `txRef`（release の照合）。 */ readonly sourceTxRef?: string }
/**
 * `none` = **この rail は release を持たない**（wrapper が下の rail に method が無いときに返す）。core は `none` を「今までどおり送信へ進む」と読む。
 * 下の rail が release を持つなら `none` は返らない（adapter は 3 つのどれかを返す）。
 */
export type ReleaseResult =
  | { readonly outcome: "none" }
  | { readonly outcome: "released"; readonly deliveryKey: string; readonly txRef: string; readonly eventId: string }
  | { readonly outcome: "refused"; readonly reason: "source_release_refused" }
  | { readonly outcome: "unknown"; readonly reason: "source_release_unknown" };
export type CompleteResult = { readonly outcome: "none" } | { readonly outcome: "completed" } | { readonly outcome: "unreported"; readonly reason: CompleteUnreportedReason };
/**
 * 固定の token（journal に写す）。**恒久**（反復で解けない。起動時の掃き出しの対象外）: `conflicting_outcome`・`not_authorized`・`delivery_key_mismatch`・`unknown_order`・`invalid_request`・`refused`。
 * **一時**（起動時に 1 回だけ再試行）: `unavailable`（timeout・transport・5xx・429 の上限・読めない 2xx）だけ。401 と tenant の 404 は `unauthorized`／`unknown_tenant` で**恒久**（要件 v4.3）。
 */
export type CompleteUnreportedReason = "conflicting_outcome" | "not_authorized" | "delivery_key_mismatch" | "unknown_order" | "unknown_tenant" | "unauthorized" | "invalid_request" | "refused" | "unavailable";
export const COMPLETE_TRANSIENT_REASONS: ReadonlySet<CompleteUnreportedReason> = new Set(["unavailable"]);   // それ以外は恒久（要件 FR-6: 404・409 は反復で解けない。401・tenant の 404 も恒久 = §13）
export interface InboundRail {
  …既存…;
  verify(…): Promise<InboundVerifyResult>;            // 型を広げるだけ（既存の実装はそのまま適合）
  /** 同期。credential を見る前でも言える「この offer への標準の署名が実行可能でいられる上限」（unix 秒。FR-4.4 (i)(i′)）。`subetha-exact` は `offer.extra.expiresAt`。持たない rail は `undefined`。 */
  settleWindowOf?(offer: InboundOffer): number | undefined;
  /**
   * 同期。**過去に自分が発行した offer か**（route の束縛が設定から消えた後でも、offer の scheme・network・資産で判定できる rail だけ）。
   * wrapper が `routeBinding` で rail を引けないとき（route の変更・削除の後の `quote_changed` の開示、起動時の complete の掃き出し）の fallback。
   * `subetha-exact` は `scheme === "exact"` かつ `assetKeyOf(network, asset)` が自分の資産（表で一意）。持たない rail は fallback の対象にならない。
   */
  ownsOffer?(offer: InboundOffer): boolean;
  release?(offer: InboundOffer, context: InboundCallContext): Promise<ReleaseResult>;
  complete?(offer: InboundOffer, deliveryKey: string, outcome: "delivered" | "failed", context: InboundCallContext): Promise<CompleteResult>;
}
/** quote の失敗（資金は動いていない）。core は `QuoteOutcome` の code・reason・retryAfterMs に写す（FR-2.1）。`detail` は固定 token だけ。 */
export class InboundOfferError extends Error { readonly code: "source_offer_unavailable" | "source_offer_refused"; readonly detail: OfferRefusalDetail; readonly retryAfterMs?: number }
export type OfferRefusalDetail =
  | "facilitator_busy" | "rate_limited" | "response_unreadable"          // unavailable（予約は未解決のまま）
  | "amount_refused" | "unauthorized" | "unknown_tenant" | "requirements_mismatch" | "order_reused_expired" | "order_reused_mismatch" | "order_reused_other_id" // refused（確定）
  | "limit_total" | "limit_unresolved" | "limit_rate" | "limit_concurrency" | "requester_missing" | "ledger_unavailable";                                      // Router 側（facilitator を呼ばない）
```

- **wrapper の契約**（`inboundByRoute`、`src/main.ts:569-630`）: `settleWindowOf`・`release`・`complete` を**常に定義**し、下の rail に method が無ければ `settleWindowOf` は `undefined`、`release`・`complete` は `{ outcome: "none" }` を返す。
  下の rail に method があれば**その結果をそのまま**返す（adapter は `none` を返してはならない: 単体試験で固定）。既存の rail（x402・mpp・subetha）は 1 文字も変わらない。
  **rail の解決**: 今までどおり `offer.extra.routeBinding` → rail。引けないとき（束縛が設定に無い = route の変更・削除の後）、`complete` に限り、`ownsOffer(offer)` が真の rail に fallback する（無ければ `none`）。`settleWindowOf` は quote のときだけ呼ばれる（束縛は必ずある。§4.2）。`release`・`verify`・`settle`・`preflight` は fallback しない（purchase は設定の指紋の照合を先に通り、同じ process では束縛が消えない。`quote_changed` で止まる購入に release は無い）。
  **最後の route を消した後の complete**: adapter は「`subetha-exact` の route がある」**または**「env（URL・token ファイル）があり ledger のディレクトリに記録がある」ときに作る（§5.4）。env も無ければ adapter は無く、`complete` は `none`（報告されない注文は FR-11 の道具の `--remote` で見える。運用者が env を戻して起動すれば掃き出しが報告する）。
  **tenant の束縛**: adapter の `complete` は、ledger の `created.tenant`（注文を作った `/p/<id>`）が自分の URL の path と違えば呼ばずに `unreported refused`（恒久）+ `note`（別の tenant の注文を今の token で完了させない）。
- **core の契約**: core は wrapper からも、wrapper 無しの rail（単体試験の合成 rail）からも呼ばれる。だから core は **method が無い**（`typeof options.inbound.release !== "function"`）ときも「持たない」と読み（既存の `preflight` の `typeof` 分岐と同じ）、method が**ある**のに結果が契約の形でない（`undefined`・知らない `outcome`）ときだけ `unknown` にする。`complete`・`settleWindowOf`・`ownsOffer` も同じ。
- `requester` は core が常に渡す（`quoteLocked`、`dynamic.ts:451`、`private.ts:470` の 3 箇所）。既存の rail は読まないので挙動は不変。
- `QuoteOutcome` の失敗の形に `retryAfterMs?: number` を足す（`source_offer_unavailable` のとき）。

## 3. adapter `src/adapters/inbound/subetha-exact.ts`

### 3.1 構成と依存

```ts
export interface SubethaExactInboundOptions {
  readonly facilitatorUrl: string;             // `https://…/p/<id>`（末尾 / 無し）
  readonly token: () => string;                // 閉包。値はこの関数の中にだけ（options に文字列で持たせない = 誤って JSON 化しない）
  readonly transport: GuardedTransport;
  readonly asset: { readonly network: string; readonly id: string; readonly decimals: number; readonly domain: { name: string; version: string } }; // 表の行
  readonly ledgerDir: string;                  // `<dirname(journalPath)>/subetha-exact`
  readonly limits: SubethaExactLimits;         // §3.6
  readonly offerSeconds?: number;              // 既定 120
  readonly timeouts?: Partial<SubethaExactTimeouts>; // §3.7（試験で短くする）
  readonly now?: () => number;                 // 試験の時計（ledger の `atMs`、`expiresAt` の判定）
  readonly note?: (message: string) => void;   // 固定文だけ
  readonly diagnostics?: DiagnosticsSink;
  /** 試験だけ（合成が `RouterCapabilities.subethaExactHooksForTest` から渡す）。`stop("after_release_remote", orderId)` は release の応答を受けた後・返す前に待つ。 */
  readonly hooksForTest?: { readonly stop?: (point: "after_release_remote", orderId: string) => Promise<void> };
}
export interface SubethaExactInbound extends InboundRail { startup(): Promise<void>; close(): Promise<void> }
```

- adapter は **1 つ**（facilitator = tenant が 1 つ）。`subetha-exact` の route が複数あっても同じ instance（額は route ごとに `createOffer` の引数）。
- 鍵・署名能力は持たない（受信側）。手元の署名の検査は viem の `recoverTypedDataAddress`（純粋。RPC 無し）。

### 3.2 耐久の記録（`subetha-exact-ledger.ts`）

既存の `openJournal`（`src/core/journal.ts`）をそのまま使う: `ledgerDir/orders.ndjson` + `ledgerDir/journal.lock`（flock。Router の journal とは別のディレクトリなので lock 名は衝突しない）。行は `{ seq, at, paymentId: <attemptId>, event, patch }`。
**鍵は attempt**（要求ごとの 16 バイトの乱数の hex）。同じ requester の 2 回目の要求、別 resource、閉じた後の新しい注文は、すべて別の attempt として履歴に残る（上書きしない）。

| event | patch | 書く時点 |
|---|---|---|
| `requested` | `{ requesterDigest, resourceDigest, routeId, amount, atMs }`（principal は書かない） | `POST /exact/orders` の**前**（fsync 後に送る）。**枠の予約**（FR-9） |
| `create_failed` | `{ kind: "transient", detail, httpStatus?, elapsedMs }` | 503／429／5xx／timeout／読めない本文（**未解決のまま**: 割当が続き得る） |
| `created` | `{ orderId, payTo, expiresAt, existing: boolean, tenant: "<facilitator の URL の path /p/<id>>", requirements: { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra: { name, version } }, binding: { requesterDigest, resourceDigest }, httpStatus, elapsedMs }` | `POST /exact/orders` の応答の検査が通った後だけ（FR-2 (c)。欄は allowlist の写しで、他の欄は捨てる。view に `createdAt` は無い: `P:exact-routes.ts:96-100`、`status` の欄は `burn-sale-backend.ts:1770-1787`）。`tenant` は注文の持ち主の tenant（後の complete の照合。§5.4） |
| `lookup` | `{ outcome: "found" \| "empty" \| "failed", httpStatus?, elapsedMs }` | requester の照会のたび（NFR-2） |
| `discovered` | `{ pair: { requesterDigest, resourceDigest }, orderId, payTo, expiresAt, tenant, requirements, binding }`（鍵は **pair の digest を連結した文字列**。attempt ではない） | 照会で見つかった注文（§3.2 の集計の規則。**どの attempt にも結び付けない**）。同じ orderId は 1 回だけ |
| `refused` | `{ detail, httpStatus?, elapsedMs }` | 403／401／404／読める応答の条件の不一致（**確定の失敗**: 未解決から外す） |
| `verify` | `{ orderId, local: "ok" \| "invalid", remote?: "valid" \| "invalid" \| "http_error" \| "not_json" \| "threw", httpStatus?, elapsedMs }` | verify の結果を返す前 |
| `settle` | `{ orderId, outcome: "settled" \| "unknown", txRef?, httpStatus?, elapsedMs, mayStillSettleUntil }` | settle の結果を返す前（`txRef` は `settled` のとき。core の記録が失敗しても inspector がここで読める） |
| `release` | `{ orderId, outcome, attempts, httpStatus?, elapsedMs, reconstructed?: true }` | release の結果を返す前 |
| `complete` | `{ orderId, outcome, reported: "delivered" \| "failed", attempts, httpStatus?, elapsedMs, reason? }` | complete の結果を返す前 |
| `abandoned` | `{ by: "operator", reason: "operator_timeout" \| "operator_facilitator_reset" \| "operator_other" }` | **運用者の明示の操作だけ**（`tools/subetha-exact-inspect.ts --abandon <attemptId> --reason <token>`。FR-9.2 (d)）。adapter 自身は書かない |

- 読み込み（`startup()`）で index を作る: `attempts: Map<attemptId, AttemptView>`（`AttemptView` = 上の行の畳み込み）、`byPair: Map<requesterDigest + "|" + resourceDigest, attemptId[]>`（要求の順）、`byOrderId: Map<orderId, attemptId[]>`（同じ注文を返した attempt は複数あり得る: 再 quote）、`discoveredByPair: Map<pair, DiscoveredOrder[]>`。
- **操作の行の持ち主**: `verify`・`settle`・`release`・`complete` の行は、**その offer の orderId（`offer.extra.challengeNonce`）を `created` に持つ最新の attempt** に書く。解決は**常に耐久の index（`byOrderId`、`startup()` で ledger から組み、`created` の追記で更新）**で行い、process 内の map は持たない（quote の後に再起動し、最初の purchase が再起動の後に来る経路でも同じ attempt に届く: core は再 quote で `createOffer` を呼ばず、`created` のままの intent の purchase を進める。`orchestrator.ts:556-565, 672-674`）。該当の attempt が無い orderId（ledger の消失）は行を書かずに `note`（遠隔の結果はそのまま返す）。試験: quote → 再起動 → 最初の purchase で、作成の POST が増えず、操作の行が同じ attempt に付く。
- **同じ (requester, resource) の attempt と注文の関係（集計の規則。attempt への帰属はしない）**: facilitator は作成を lock で直列化し、未解決の注文があればそれを返す（`P:burn-sale-backend.ts:743-760`、`multi-routes.ts:172-184`）が、Router の要求の記録の時刻と server 側の実行の順は一致しない（遅れて届く・queue で待つ要求がある）し、view に要求の識別は無い。
  だから**結果の分からない attempt（`created` も `refused` も無い）を、見つかった注文に結び付けることはしない**。照会で見つかった注文は pair の `discovered` として記録するだけ（`existing` の照合と FR-11 の表示に使う）。結果の分からない attempt は、**運用者の `--abandon`（attempt ごと）でだけ**未解決から外れる。
  **不変条件**: 「結果の分からない attempt は、Router の自動の判断では未解決から外れない」。多めに数えることはあっても、別の attempt の注文の settle・期限で空くことは無い（FR-9.2）。`--abandon` は attempt を名指しするので、運用者が B を abandon しても A の枠は残る。
  試験（数は**未解決の合計** = 結果の分からない attempt + 結び付かない `discovered`）: 同じ pair で応答を 2 回失い、注文が 1 つ見つかる → 合計 **3**（attempt 2 + `discovered` 1）；`--abandon` で片方の attempt を外す → **2**；`discovered` の期限 + 猶予 → **1**（残る attempt は遅れた割当の後も数えられたまま）；遅れて届いた要求（fixture `slow`）が注文の完了の後に別の注文を作る場合も、未解決の数は減っていない（遅れた割当 → 照会 → 期限／完了 → 他方の abandon → 遅れた割当、の順の試験）。
- `existing: true` の照合（§3.4 の 6）は **同じ pair の最新の `created` の attempt** の `orderId` と比べる（pair に `created` が無ければ受け入れる）。
- **残さないもの**: token、署名、credential、`payTo`・requirements 以外の応答の本文、URL、principalId。`payTo` と requirements は買い手にも出る公開の値。
- `requester.salt`: 32 バイトの hex。無ければ `salt.tmp` に書き → `fsync` → `rename` → ディレクトリを `fsync`（journal の新規作成と同じ手順）。読むときは通常のファイル・64 hex を要求。**ledger に行があるのに salt が無い・読めないなら起動を止める**（`ConfigError`: 予約済みの要求の digest を導けない）。

### 3.3 digest

```
resourceDigest  = "0x" + sha256( "subetha-exact|resource|" + routeBinding )
requesterDigest = "0x" + sha256( "subetha-exact|requester|" + salt + "|" + len(principalId) + ":" + principalId + "|" + len(requestId) + ":" + requestId )
```
長さ付き（`len:` は 10 進の UTF-8 バイト数）なので `("ab","c")` と `("a","bc")` は別の値。`requester` が無ければ `InboundOfferError("source_offer_refused", "requester_missing")`（この rail は無名の quote を出さない）。

### 3.4 `createOffer`

1. `request.network`／`asset` が options の資産と一致（小文字比較）。違えば throw（設定の不整合。起動時に表で落ちるので到達しない）。
2. **上限**（§3.6）。未解決の上限に当たったら、先に照会（§3.6）を 1 巡してから数え直す。なお上限なら `InboundOfferError("source_offer_unavailable", "limit_*")`。作成の POST は出さない。
3. digest（§3.3）。常に POST する（Router は自分の記録から注文を再提示しない: facilitator の `existing` の規則に任せる）。
4. attemptId を作り、ledger `requested`（fsync）。
5. `POST /exact/orders { amount, resourceDigest, requesterDigest }`（Bearer、`createMs`、再試行なし）。
6. 分類（§3.8 の表 A）。「読める応答」= JSON の object で `orderId` が hex32、`requirements` と `status` が object、`binding` が object、`existing` が **boolean**。読めなければ `create_failed`（transient）+ `unavailable`。
   読める応答の検査（FR-3）: `requirements.scheme === "exact"`、`requirements.network === request.network`、`requirements.asset` が資産と一致（小文字）、`requirements.amount === request.amount`、`requirements.payTo` が address の形、
   `requirements.extra.name/version` が表の domain と一致、`requirements.maxTimeoutSeconds` が正の整数、`status.expiresAt` が正の整数で `expiresAt - nowSec ≥ minLeadSeconds`（既定 30）、`binding` の 2 つが自分の値（小文字比較）。
   `existing === true` のとき、同じ pair の最新の `created` の attempt があれば、その `orderId` と一致（違えば `order_reused_other_id`）。期限切れは `order_reused_expired`、額・binding の不一致は `order_reused_mismatch`。条件の不一致は ledger `refused` + `InboundOfferError("source_offer_refused", detail)`。
7. ledger `created`。
8. offer を返す:
```ts
{ scheme: "exact", network: request.network, asset: request.asset /* 設定の文字列のまま（core の厳密比較）*/, amount: request.amount, payTo: getAddress(requirements.payTo),
  maxTimeoutSeconds: requirements.maxTimeoutSeconds,
  extra: { name, version, challengeNonce: orderId /* 小文字 */, expiresAt: Math.min(status.expiresAt, nowSec + offerSeconds), routeBinding: request.routeBinding, fundsMoveOnCredential: false } }
```
`extra` のキーは x402 受信の `ISSUED_EXTRA_KEYS` と同じ 6 つ（`npm run sign` と既存の payer の封筒がそのまま通る）。

### 3.5 `preflight`・`verify`・`settle`

- **preflight**（同期）: x402 adapter の `bindAuthorizationNonce: true` と同じ検査を常に行う + `validAfter ≤ nowSec` + `signature` が `0x` hex。`accepted` のトップレベル未知キーは許す（標準 client の `resource`・`extensions`）。
- **settleWindowOf(offer)** = `offer.extra.expiresAt`。
- **verify**:
  1. 手元: `recoverTypedDataAddress({ domain: { name, version, chainId, verifyingContract: asset.id }, types: TransferWithAuthorization, message, signature })` が `getAddress(from)` と一致。違えば `{ isValid: false }`（欄なし: 実行可能な authorization は無い）。ledger `verify { local: "invalid" }`。
  2. 通れば `mayStillSettleUntil = Number(validBefore)` を確定。
  3. 公開 `POST ${base}/exact/verify`（認証なし、`verifyMs`、再試行なし）body `{ x402Version: 2, paymentPayload: payloadOf(offer, credential), paymentRequirements: ledgerRequirementsOf(offer) }`。
     `ledgerRequirementsOf` = `{ scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra: { name, version } }`（facilitator の `#locate` の `same` が見る欄だけ。`P:exact-settle.ts:250`）。`payloadOf` = x402 adapter と同じ（`accepted: credential.accepted`、`payload` の写し）。
  4. `200` かつ `isValid === true` → `{ isValid: true, mayStillSettleUntil }`。それ以外（`isValid: false`、他の status、読めない本文、429、**transport の例外・timeout も adapter が捕まえて**）→ `{ isValid: false, mayStillSettleUntil }`（FR-5.3「公開 verify は再試行しない。`isValid: false`」。この rail は verify で throw しないので、core の `source_verify_unavailable` の経路には入らず、正確な値が行に残る）。`invalidReason` は診断の表の分類だけ（`emitInboundRoundTrip`、`facilitator: "x402"`。transport の例外は `transport.report` に）。ledger `verify`。
- **settle**: `POST ${base}/exact/orders/${orderId}/settle { paymentPayload, requesterDigest, resourceDigest }`（Bearer、`settleMs`、**再試行なし**）。表 B（§3.8）。`settled` のとき `eventId` = authorization の nonce 小文字（x402 adapter と同じ。facilitator の settle 応答に `eventId` は無い）。`unknown` には `mayStillSettleUntil` を添える。ledger `settle`（`settled` なら `txRef` も）。

### 3.6 上限（FR-9・FR-9.2）

```ts
export interface SubethaExactLimits { readonly maxRequestsTotal: number; readonly maxUnresolved: number; readonly requestsPerMinute: number }
export const SUBETHA_EXACT_DEFAULT_LIMITS = { maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 6 }
```
- 累積 = `requested` 行の数（再起動で復元。戻らない）。
- **未解決** = **attempt の集計** + **`discovered` の注文の集計**:
  - attempt: `requested` のうち次のどれでもないもの: (a) `created` があって、`settle` の **`outcome: "settled"`** がある、または `now > created.expiresAt + 60 s`；(b) `refused`；(c) 運用者の `abandoned`。**`created` の無い attempt（`create_failed`・行なし）は時間でも照会でも外れない**（§3.2 の不変条件）。`settle` が `unknown` の attempt は (a) の期限で外れる（注文の TTL は分かっている）。
  - `discovered` の注文: その orderId をどの attempt も `created` として持たないもののうち、`now ≤ expiresAt + 60 s` のもの（facilitator 側で開いている注文の負荷として数える。期限で外れる: TTL は view の `status.expiresAt` で分かる）。
  同じ注文が attempt と `discovered` の両方にあれば attempt の側だけで数える。
- 照会（FR-9.2 (c)）: `createOffer` が未解決の上限に当たったとき、その**直前**に、`created` の無い未解決の attempt を**全部、古い順に 1 件ずつ**（同じ pair は 1 回だけ）、`GET /exact/requesters/<digest>/orders?resourceDigest=<r>`（Bearer、予算 20 秒、429・5xx・timeout・transport は予算の内で最大 2 試行、`Retry-After` を守る）で照会する。件数は `maxUnresolved` 以下なので有界。
  200 で `orders[]` に注文があれば、FR-3 と同じ検査（binding・額。期限は見ない）を通したものを pair の `discovered` に記録する（既に `created`／`discovered` にある orderId は書かない）。attempt の状態は変えない（§3.2）。それ以外（空・失敗）→ ledger `lookup` だけ。
  照会の目的は **(1) 遅れた割当を facilitator の負荷として数えに入れること、(2) `existing` の照合と FR-11 の表示** で、attempt を解くことではない（要件 FR-9.2 (c) の「見つかれば `created` に移る」は v4.4 でこの形に改める: 結び付けの根拠が API に無いため）。
  `via: "lookup"` の `created` の行は使わない（削除）。
  起動時（`startup()`）は同じく**全件を 1 巡**（直列）。照会の後で上限を数え直し、まだ上限なら `limit_unresolved`（`note` に固定文「subetha-exact: unresolved requests at the limit; inspect with the operator tool」）。
- 1 分 = `requested` の `atMs` が直近 60 秒のもの。
- 同時 = process 内の Promise 1 本（進行中なら即 `limit_concurrency`。待ち行列は作らない）。
- **検証の期間と停止の条件（AC-7・FR-9.1。要件 v4.2 で「期間は acceptance 文書」に改めた）**: 設定の既定 `maxRequestsTotal: 100` が停止の条件（達したら quote を断る。上げるには設定の変更 = 運用者の判断）。期間は `docs/subetha-exact-inbound-acceptance.md`（T-6）に「段 4 の実行は 1 回の計画で 7 日以内、`maxRequestsTotal` 100、`maxUnresolved` 3、`requestsPerMinute` 6。未解決が 3 に達したら止めて FR-11 で確かめる」と書く。

### 3.7 時間と予算

| 値 | 既定 | 根拠 |
|---|---|---|
| `createMs` | 40 000 | facilitator は 30 秒で 503 を返す（`CREATE_ANSWER_MS=30000`、`P:deploy/public-testnet/facilitator-multi.env:98`、`multi-routes.ts:168-170`）。それより長く待って応答を受け取る |
| `verifyMs` | 15 000 | 署名の検査と simulation だけ |
| `settleMs` | 60 000 | relay の POST 30 秒（`RELAY_TIMEOUT_MS`）+ 照合。facilitator 自身の要求期限は 30 秒（`HTTP_REQUEST_TIMEOUT_MS`）なので、実際には facilitator が先に切ることがある → `unknown`（段 4 で測る） |
| `statusMs`（GET） | 15 000 | |
| `releaseMs` | 20 000 | receipt の再検査（chain の読み取り 1〜3 回） |
| `completeMs` | 15 000 | |
| `offerSeconds` | 120 | 承認の時間。`expiresAt = min(order.expiresAt, now + 120)` |
| `minLeadSeconds` | 30 | 注文の残り時間がこれ未満なら offer を出さない |

**操作全体の予算**（FR-5.3。再試行の待ちと本文の読み取りを含む。1 回の試行の期限 = `min(1 回の期限, 残りの予算)`。残りが 1 秒未満なら試行しない）:

| 操作 | 予算 | 再試行 |
|---|---|---|
| 作成 | `createMs` | なし |
| 公開 verify | `verifyMs` | なし |
| settle | `settleMs` | **なし**（1 回だけ） |
| release（GET の復元を含む） | `min(deadlineMs - now - 5 s, 60 s)` | POST: 425・429・5xx・timeout・transport で予算の内に再試行、最大 3 試行。待ちは `Retry-After` があればその値（**切り詰めない**。残りの予算を超えるなら試行せず `unknown`）、無ければ 2 秒。**GET（復元・状態の確認）は POST とは別に数え、1 回の機会につき最大 2 試行**（429・5xx・timeout・transport で再試行）、同じ予算の内 |
| complete | 35 s | 429・5xx・timeout・transport: 予算の内で最大 2 試行、待ちは `Retry-After` かそれが無ければ 1 秒 |
| requester の照会 | 20 s（1 件につき） | 429・5xx・timeout・transport で最大 2 試行（`Retry-After` を守る） |

承認期限 = `min(issuedAtMs + approvalTtlMs, expiresAt × 1000)`（core）。SDK は `validBefore ≥ now + 6` を要求する（`index.js:1158`）ので、期限の 6 秒前以降の purchase は facilitator の verify で落ちる（資金は動かない。`awaiting_payment` + 開示）。

### 3.8 分類の表（純粋関数。単体試験で全行を固定）

**A. `POST /exact/orders`**（`P:exact-routes.ts:102-118`、`multi-routes.ts:334-343, 168-170`）。上から順に最初に合う行。

| 応答 | 結果 | ledger |
|---|---|---|
| transport の例外・timeout | `unavailable` `response_unreadable` | `create_failed` |
| 503 | `unavailable` `facilitator_busy`、`retryAfterMs` = `Retry-After` か 30 s | `create_failed` |
| 429 | `unavailable` `rate_limited`（同上） | `create_failed` |
| 5xx（503 以外） | `unavailable` `facilitator_busy` | `create_failed` |
| 401 | `refused` `unauthorized` + `note` | `refused` |
| 404 | `refused` `unknown_tenant` + `note` | `refused` |
| 403 | `refused` `amount_refused` | `refused` |
| 400・その他 4xx | `refused` `requirements_mismatch` | `refused` |
| 200／201 で**読めない**（JSON でない・`orderId`／`requirements`／`status`／`binding`／boolean の `existing` のどれかが無い） | `unavailable` `response_unreadable`（注文は作られたかもしれない） | `create_failed` |
| 200／201 で読めるが条件の不一致 | `refused`（detail = 不一致の種類） | `refused` |
| 200／201 で読めて条件 OK | 成功 | `created` |
| その他の 2xx（200・201 以外）、1xx、3xx（`redirect: "error"` で transport の失敗になる） | `unavailable` `response_unreadable` | `create_failed` |

**B. `POST /exact/orders/:id/settle`**（`P:exact-routes.ts:133-144`、`exact-settle.ts:138, 298-318, 455-457`）

| 応答 | 結果 |
|---|---|
| 200、`success === true`、`outcome === "accepted"`、`transaction` が 0x+64 hex、`network === offer.network` | `settled { txRef: transaction 小文字, eventId: nonce 小文字 }` |
| それ以外すべて（`pending`／`late-paid`／`rejected`、4xx、429、5xx、timeout、読めない本文、形違い） | `unknown { reason: "source_settle_unknown", mayStillSettleUntil }` |

**C. `POST /exact/orders/:id/release`**（`P:exact-routes.ts:183-192`、`burn-sale-backend.ts:1251-1259, 1300-1321`。`refusalStatus`（同 `:54`）: `not-ready`／`receipt-not-final`／`coins-not-spendable` → 425、`unknown-order` → 404、`requester-mismatch` → 403、ほか 409）

| 応答 | 結果 |
|---|---|
| 200 で `deliveryKey === orderId`、`txRef === sourceTxRef`（小文字）、`eventId` が `^<chainId>:<txRef>:<logIndex>$` | `released` |
| 200 だが読めない・上のどれかが違う | `unknown`（release は記録されたかもしれない。再試行しない） |
| 425 | 再試行（予算内）。尽きれば `unknown` |
| 409 `already-claimed` | **復元**（表 D） |
| 409 `incident`／`late-after-reinclusion`／`already-delivered`／`already-failed`、403 `requester-mismatch`、404 `unknown-order` | `refused` |
| 429、5xx、timeout、transport | **GET で状態を読む**（表 D′）。`release.state === "none"` なら再試行（予算内）。尽きれば `unknown` |
| 401 | `unknown` + `note` |
| 409 のほかの code・400・ほかの 4xx（429 以外）・200 以外の 2xx・その他の status | `unknown`（保守。既定） |

**D. 復元 `GET /exact/orders/:id`（`already-claimed` の後）**（`P:exact-routes.ts:96-101, 120-126`、`burn-sale-backend.ts:1770-1783`）: 200 で読める view（`binding` が object、`status.release` が object）かつ `binding.requesterDigest/resourceDigest` = 自分の値、`status.state ∈ {accepted, settled}`、`status.release.state === "authorized"`、`status.release.deliveryKey === orderId`、`status.release.txRef === sourceTxRef`、`status.release.eventId` が `^<chainId>:<sourceTxRef>:<logIndex>$`、`status.release.afterRelease` が無い → `released`（ledger `release` に `reconstructed: true`）。
読めて条件のどれかが違う（`state: "none"` を含む: `already-claimed` と矛盾）→ `refused`。読めない 200・400・401・403・404・429 の上限・5xx・timeout・その他の status → `unknown`（GET の失敗で release の有無を決めない）。
**D′. transport の失敗の後の GET**: 同じ条件で `released`；`status.release.state === "none"` → 「記録されていない」= 再試行へ；`authorized` だが条件の不一致・`delivered`／`failed`・読めない・4xx・5xx → `unknown`（`refused` にしない: release が記録されたかもしれない）。

**E. `POST /exact/orders/:id/complete`**（`P:exact-routes.ts:194-203`、`burn-sale-backend.ts:1695-1710`、tenant の 404 `{error:"unknown"}` は `multi-routes.ts:339`）

上から順に最初に合う行（行は互いに素）。

| 応答 | 結果 |
|---|---|
| transport の例外・timeout | 再試行（予算内）。尽きれば `unreported unavailable`（一時） |
| 429 | 再試行（予算内、`Retry-After`）。尽きれば `unreported unavailable`（一時） |
| 5xx | 再試行（予算内）。尽きれば `unreported unavailable`（一時） |
| 200 で読めて `state` が送った outcome | `completed` |
| 200 だが読めない・`state` が違う、200 以外の 2xx | `unreported unavailable`（一時。facilitator は冪等） |
| 409 `conflicting-outcome` / `not-authorized` / `delivery-key-mismatch` | `unreported <その token>`（恒久） |
| 409 のほかの本文 | `unreported refused`（恒久） |
| 400 | `unreported invalid_request`（恒久） |
| 401 | `unreported unauthorized`（恒久。token の誤り。§13） |
| 404 `unknown-challenge`／`unknown-order` | `unreported unknown_order`（恒久） |
| 404 のほかの本文（`unknown` = tenant 無し `P:multi-routes.ts:339`、読めない本文） | `unreported unknown_tenant`（恒久。要件 FR-6「404 は反復で解けない」。tenant を直した後は FR-11 で見て運用者が判断） |
| 403・ほかの 4xx（429 以外）・その他の status | `unreported refused`（恒久。既定） |

### 3.9 HTTP の共通

`call(method, path, body?, { op, deadlineMs, auth })`: `transport.fetch(base + path, { method, headers: { "content-type": "application/json", authorization: auth ? "Bearer " + token() : undefined }, body, redirect: "error", signal: AbortSignal.timeout(deadlineMs) }, { routeId, operation: op })`、本文は `readBoundedBody(response, 64 KiB)` を**同じ signal の期限の中で**読む（本文の読み取りも操作の予算に入る: `Promise.race` で期限を超えたら中断して `unreadable` 扱い）、JSON の parse の失敗は `json: undefined`。`op` は `DIAG_OPS` に足す 5 語（`facilitator_order_create`・`facilitator_order_status`・`facilitator_requester_orders`・`facilitator_release`・`facilitator_complete`。verify・settle は既存の `facilitator_verify`／`facilitator_settle`）。
`call` は例外を投げない（transport の例外・timeout は `{ kind: "threw" }` として返す）。各操作の例外の契約は操作ごと: `createOffer` は `InboundOfferError` だけを投げる、`verify` は投げない（§3.5）、`settle` は投げない（表 B で `unknown`）、`release`・`complete` は投げない（表 C・E）。core の `source_verify_unavailable`／throw の経路は、この rail では使われない。

**adapter の ledger の書き込みの失敗**（`Journal` の append・fsync の失敗は writer を以後使えなくする: `src/core/journal.ts:264-269, 290-295`）:
- **遠隔の操作の前の行**（`requested` = 枠の予約）: 書けなければ facilitator を呼ばず `InboundOfferError("source_offer_unavailable", "ledger_unavailable")`（fail closed）。以後 `ledgerBroken = true` で、**新しい `createOffer` はすべて同じ理由で断る**（再起動まで）。`note` に固定文。
- **遠隔の操作の後の行**（`verify`・`settle`・`release`・`complete`・`lookup`・`discovered`・`create_failed`・`refused`・`created`）: 書けなくても**遠隔の結果はそのまま返す**（`settled` を落とさない、手元の検査で得た正確な `validBefore` を落とさない、`released` を落とさない）。`note` に固定文。core の journal が購入の権威で、adapter の ledger は枠の予約と計測の記録。`created` が書けなかった場合は offer を**返さない**（その注文に quote を結び付けられない: `InboundOfferError("source_offer_unavailable", "ledger_unavailable")`。注文は facilitator に残り、同じ requestId の再 quote（`existing`）か FR-11 で見える）。
- `OfferRefusalDetail` に `ledger_unavailable` を足す。試験: 各行の append を失敗させて、遠隔の結果が保たれること・新しい作成が止まること。

## 4. core の変更

### 4.1 quote（`quoteLocked`、`dynamic.ts`、`private.ts`）
- `createOffer` に `requester: { principalId, requestId }` を渡す。
- `quoteLocked` で `InboundOfferError` を捕まえ `{ ok: false, code, reason: detail, retryAfterMs? }`。HTTP（`app.ts`）: `source_offer_unavailable` → 503 + `Retry-After: ceil(retryAfterMs/1000)`（既定 30）、`source_offer_refused` → 502。本文に `reason`。MCP（`quoteFailureOf`）: code・reason・`retryAfterMs` と、`order_reused_*` のとき `nextStep: "This requestId can no longer be quoted on this route; take a new quote with a new requestId."`。
- **閉じた quote の再 quote（FR-4.5、全 rail）**: `quoteLocked` の「既存の quote を返す」分岐で `existing.status !== "created"` なら、`QuoteDocument` に `closed: true`・`status: toPublicStatus(existing.status)` を足す（**core の型は変えない**: `source.offer` は in-process の文書には残る。既存の試験・in-process の利用者はそのまま）。
  **公開の面で落とす**: `quoteBody`（HTTP R2）と MCP の `quote` の応答は、`closed` のとき `source.offer`・`source.payTo`・`source.expiresAt` を**出さない**（`closed`・`status`・`quoteId`・`paymentId`・`approval` は出す）。`src/client/types.ts` の `QuoteView.source.offer` は `unknown` のままで、無い文書も読める。
  `created` のままの再 quote は byte 単位で今までどおり。動的・秘匿の quote は再 quote 自体が `request_id_conflict`（既存）なので変わらない。
- MCP `quote`: `closed` なら `nextStep: "This quote was already used (status: …). Do not sign anything for it; take a new quote with a new requestId."`、`subject` は出さない。
- `tools/sign-run.ts`: `quote.closed === true` → `Refusing to sign: this quote was already used (status …); take a new quote with a new requestId.`（`source.offer` が無い既存の拒否より先に見る）。
- **オーナーの承認**: この項は既存 rail の公開の契約の変更（安全側）なので、実装の前にオーナーに明示して承認を得る（要件 FR-4.5。本書の報告に含める）。

### 4.2 「払われたかもしれない」（`purchaseStatic`・`dynamic.ts` の同じ段）

`window` は **quote のときに** `options.inbound.settleWindowOf?.(sourceOffer)` で求め、数値なら `created` の行に `source.settleWindow` として書く（この rail だけ欄が付く。他の rail の `created` の行は不変）。以後の開示は `intent.source.settleWindow` を読む（route が消えた後・adapter が無い構成でも journal から出せる: 旧 #14）。`precise = verified.mayStillSettleUntil`（手元の検査の後）。**欄の規則**: `mayStillSettleUntil` を出すときは**常に** `awaitingPaymentDoesNotMeanUnpaid: true` も出す（status によらず。`unknown` でも true）。

| 経路 | journal | 応答（purchase の初回・再提出・status） |
|---|---|---|
| (i) credential 無し（`payment_required`）、承認期限切れ（credential の前）、preflight の拒否、`quote_changed`（設定の変化。`orchestrator.ts:698-717`） | 行なし（既存） | `window` があれば `mayStillSettleUntil: window` + 真 |
| (i′) `offer_unavailable`・`offer_changed`・`operator_funds_unavailable`（`source_failed`、手元の検査の前） | patch に `mayStillSettleUntil: window` | 同じ欄 |
| (ii) 手元の検査の後の `source_failed`（`verify_failed`（facilitator の拒否・transport の失敗とも: adapter は throw しない §3.5）・`approval_expired`・予算）、`unknown`（`source_settle_unknown`） | patch に `mayStillSettleUntil: precise` | 同じ欄 |
| `source_verify_unavailable`（verify が throw: この rail では起きない。他の rail の既存の経路） | `window` があれば patch に `mayStillSettleUntil: window` | 同じ欄 |
| 既存 rail（`window` も `precise` も無い） | 変わらない | 変わらない |

`window` は journal の `source.settleWindow`（quote のときの値）。wrapper の `settleWindowOf` を呼ぶのは quote の 1 回だけ（`ownsOffer` の fallback は `complete` の解決に使う。§2）。

- `PurchaseOutcome` に `mayStillSettleUntil?: number` を足す。**値の優先**: 行に書いた正確な値 `intent.source.mayStillSettleUntil` があればそれ、無ければ quote のときの上限 `intent.source.settleWindow`（行を書かない経路・(i′) の前の経路・再起動の後）。`currentOutcome`（再提出）と `projectionOf`（status）も同じ優先で出す。HTTP は error 本文（402／409／500 系）と `projectionBody` の `source` に、MCP は `purchase`／`status` の結果に写し、文を添える。
  試験: 初回の purchase の応答、再提出、status、再起動の後の status、最後の route を消して adapter が無い構成の status、の 5 つで同じ値が出ること（AC-2 (k1)(k3)）。
- 動的の経路（`dynamic.ts`）にも同じ規則で足す（プロファイルはこの rail を使えないが、core の規則として対称に。`window` は常に `undefined` なので値は出ない）。

### 4.3 journal の行と intent（`store.ts`・`intent.ts`）

| 行 | patch | 状態 | intent への反映 |
|---|---|---|---|
| `source_failed`／`unknown`（既存） | + `mayStillSettleUntil?: number` | 既存のまま | `source.mayStillSettleUntil` |
| `source_released` | `{ deliveryKey, txRef, eventId }` | **変えない**（`source_settled` のまま） | `source.release = { deliveryKey, txRef, eventId, at }` |
| `source_completed` | `{ outcome: "delivered" \| "failed" }` | 変えない（終端の後） | `source.release.completed = { outcome, at }`、`unreported` を消す |
| `source_complete_unreported` | `{ outcome, reason }` | 変えない | `source.release.unreported = { outcome, reason, at }` |

- `reduce` に 3 つの case を足す（既存の `default → reducePrivate` は非 private の intent で `current` を返すので、足し忘れると行が黙って消える: 試験で固定）。`source_released` の行は `source.release` が既にあれば無視（二重の行は書かない前提だが、読み戻しで上書きしない）。
- `IntentSource` に `settleWindow?: number` を足し、**`intentFromCreated`（`store.ts:397-432`）が `created` の patch の `source.settleWindow` を復元する**（正の安全な整数のときだけ。無い・形違いは欄なし。`created` の適用は append の直後にも走るので、ここを変えないと欄は即座に消える）。`created` の行に欄が無い既存 rail の intent は今までどおり（欄なし）。ほかの行（`source_released` など）は `created` の後なので `intentFromCreated` は触らない。
- 公開の射影: `source.mayStillSettleUntil` があれば `source: { …, mayStillSettleUntil, awaitingPaymentDoesNotMeanUnpaid: true }`。`source.release` は射影に出さない（運用者の確認は journal を直接読む）。
- **上限の値の範囲（v5.2、実装レビュー 1 の #6）**: 行に書いた正確な値（`source.mayStillSettleUntil`）は**常に**出す。quote のときの上限（`source.settleWindow`）で出すのは、受信がまだ settle していない状態（`created`・`source_pending`・`source_failed`、受信の `txRef` の無い `unknown`）だけ。settle 済みの購入（`source_settled` 以降の `delivered`・`paid_undelivered`・`dest_failed`、送信側の `unknown`）では authorization は消費済みなので「まだ払われ得る」は成り立たず、欄は出ない。表の 5 つの経路（(i)(i′)(ii)・`quote_changed`・`source_verify_unavailable`）はすべて settle の前なので変わらない。
- **公開の面の値の検査（v5.2、実装レビュー 1 の #2・#3）**: client・MCP は応答の `mayStillSettleUntil` を「正の安全な整数で Date にできる値」のときだけ読み、文に写すときも投げない（範囲外は欄なし）。core は `InboundOfferError` の `code`・`detail`・`retryAfterMs` を閉じた集合（`OFFER_REFUSAL_DETAILS`）と有限の値（正の整数、1 時間まで）で照合してから `QuoteOutcome` に写す。HTTP の quote の失敗の本文に `reason` を出すのは `source_offer_unavailable`／`source_offer_refused` だけ（既存の `quote_failed` の内部の reason は出さない）。

### 4.4 `deliver()` の先頭（release）

```ts
const intent = store.byPaymentId(paymentId);
if (intent.status === "source_settled" && intent.source.release === undefined && typeof options.inbound.release === "function") {   // method が無い rail は今までどおり
  await hooks.stop?.("after_source_settled", paymentId);                               // 試験の停止点（§10）
  let result: unknown;
  try { result = await options.inbound.release(intent.source.offer, { routeId: intent.routeId, deadlineMs: intent.approvalDeadlineMs, sourceTxRef: intent.source.txRef }); }
  catch { result = { outcome: "unknown", reason: "source_release_unknown" }; }
  const outcome = isRecord(result) ? result["outcome"] : undefined;
  if (outcome === "none") { /* wrapper: この rail は release を持たない: 今までどおり */ }
  else if (outcome === "released" && typeof deliveryKey/txRef/eventId === "string" && txRef === intent.source.txRef) {
    await store.append(paymentId, "source_released", { deliveryKey, txRef, eventId });
    await hooks.stop?.("after_source_released", paymentId);
  } else {
    const reason = outcome === "refused" ? "source_release_refused" : "source_release_unknown";
    await store.append(paymentId, "paid_undelivered", { outcome: "not_sent", reason }); destNote("not_sent", reason);
    await reportComplete(paymentId);   // release は無いので何もしない（対称のため呼ぶ）
    return { paymentId, status: "paid_data_unavailable", terminalReason: reason };
  }
}
```
- `none` は wrapper が「持たない」ときだけ返す（§2）。既存の rail は 1 行も変わらない（FR-5.2 の「`release` を持つ rail の購入では」）。
- `deliver` は動的でも使う（`dynamicCore` に渡す）。動的プロファイルはこの rail を使えないので常に `none`。
- 二重の release: `withKey("purchase\0quoteId")` の直列化の中で 1 回だけ。再起動後は `deliver` に戻らない（FR-7）。

### 4.5 complete（終端の後）と起動時の掃き出し

```ts
async function reportComplete(paymentId): Promise<void> {
  const intent = store.byPaymentId(paymentId);
  const release = intent?.source.release;
  if (release === undefined || release.completed !== undefined) return;
  if (release.unreported !== undefined && !COMPLETE_TRANSIENT_REASONS.has(release.unreported.reason)) return;   // 恒久の拒否は二度と呼ばない
  const outcome = intent.status === "delivered" ? "delivered" : intent.status === "paid_undelivered" || intent.status === "dest_failed" ? "failed" : undefined;
  if (outcome === undefined) return;             // unknown・進行中は報告しない
  if (typeof options.inbound.complete !== "function") return;   // method が無い rail
  await hooks.stop?.("after_terminal", paymentId);
  let result; try { result = await options.inbound.complete(intent.source.offer, release.deliveryKey, outcome, { routeId: intent.routeId }); } catch { result = { outcome: "unreported", reason: "unavailable" }; }
  // （以下の append は try/catch の中。`reportComplete` は値を返さず、例外も出さない）
  if (isRecord(result) && result.outcome === "none") return;      // wrapper: 持たない
  if (!isRecord(result) || (result.outcome !== "completed" && result.outcome !== "unreported")) result = { outcome: "unreported", reason: "unavailable" };
  // 報告の行の追記が失敗しても、終端の行は fsync 済み = 購入の応答は変えない（FR-6）。固定文の note だけ。次の起動の掃き出しが耐久の証拠（release あり・completed なし）から再試行する。
  try { await store.append(paymentId, result.outcome === "completed" ? "source_completed" : "source_complete_unreported", { outcome, ...(reason) }); }
  catch { options.note?.(`complete report could not be journaled (paymentId=${paymentId})`); }
}
```
- 終端の行の `store.append` の**後**、応答を返す**前**に `await reportComplete(paymentId)`（`delivered`・`paid_undelivered`・`dest_failed` の各終端）。`unknown` の終端では呼ばない。応答の形は complete の成否で変わらない。
- **起動時の掃き出し（FR-6.1）の所有**: `createRouterCore` は store の load の直後に候補を**snapshot**（`source.release` あり・`completed` 無し・`unreported` 無しか一時・状態が終端の 3 つ）し、`sweep: Promise<void>` を **core が保持**して開始する（await しない。失敗は握って `note`）。各候補は `withKey("purchase\0quoteId")` の中で `reportComplete` を呼ぶ（新しい purchase と同じ quote で重ならない）。
  `close()` は `sweepAbort = true` を立て、`sweep` の完了を**待ってから** journal を閉じる（進行中の 1 件は complete の予算 35 秒で終わる。候補の残りは次の起動）。`startRouter` の listen の失敗の経路も `core.close()` を通るので同じ。adapter の `close()` は core の `close()` の後（`shutdown` の順）。
  候補を snapshot するのは起動時だけ: 起動の後に終端に達した購入は `deliver()` の経路が complete する。

### 4.6 `SAFE_REASONS` と停止点
- `SAFE_REASONS` に `source_offer_unavailable`・`source_offer_refused`・`source_release_refused`・`source_release_unknown`・`source_complete_unreported` を足す。preflight の集合は変えない。
- **停止点**（試験だけ。`RouterCoreOptions.hooksForTest?: { stop?: (point: "before_source_settle" | "after_source_settled" | "after_source_released" | "after_terminal", paymentId: string) => Promise<void> }`。`before_source_settle` は `source_pending` の行の後・`settle` の呼び出しの前。秘匿購入の `PrivateHooksForTest.stop` と同じ流儀）。
  実入口（`src/main.ts` の CLI）は渡さない。`tests/fixtures/router-subetha-exact-process.ts` が env `SUBETHA_EXACT_STOP_AT=<point>` を読み、その点で**合図のファイルを書いて永遠に待つ**（応答バイトを出さない）→ 試験は合図を待って SIGKILL → 再起動（停止点なし）。adapter の `after_release_remote` も同じ経路（`RouterCapabilities.subethaExactHooksForTest`）。

## 5. 表・設定・合成・一覧

### 5.1 表（`src/shared/networks.ts`）
```ts
export type InboundRailName = "x402" | "mpp" | "subetha-exact";
export interface KnownAsset { …; /** 資産単位の rail の上書き。無ければ network の列。 */ readonly rails?: { readonly inbound: readonly InboundRailName[]; readonly outbound: readonly OutboundRailName[] } }
// eip155:84532 の assets に追加:
{ id: "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f", decimals: 6, domain: { name: "zERC20 USD Coin", version: "1" }, rails: { inbound: ["subetha-exact"], outbound: [] } }
export function inboundRailsOf(entry: KnownNetwork, asset: KnownAsset): readonly InboundRailName[] { return asset.rails?.inbound ?? entry.inbound; }
export function outboundRailsOf(entry: KnownNetwork, asset: KnownAsset): readonly OutboundRailName[] { return asset.rails?.outbound ?? entry.outbound; }
```
- `validateTermsAgainstTable`（`config.ts:49-60`）の順は今 network → rail（network の列）→ 資産。**v2 の順**: network → 資産 → rail（`inboundRailsOf`／`outboundRailsOf`）。文言は network の列で拒むとき今のまま、上書きで拒むとき `is not allowed for this asset`。
  **変わる場合**: rail と資産の**両方**が表に無い設定は、今は rail の文言、v2 では資産の文言で落ちる（結果は同じ `ConfigError`）。既存の試験でその組を固定しているものは無いことを T-1 で確かめる（あれば本書を直す）。
- payer の `inboundRailsOf(network)`（network の列）は変わらない（`eip155:84532` は `["x402"]` のまま）。
- `packages/payer/src/vendor/*` は `npm run vendor` で機械的に更新（byte 一致の試験 `vendor.test.ts`）。

### 5.2 設定（`config.ts`）
- `parseRoute`: `sourceRail` に `"subetha-exact"` を許す。`subetha-exact` で `source.payTo` があれば `ConfigError`。**`source.amount ≤ 20 000`**（`SIGN_MAX_AMOUNT`。要件 §3-9）でなければ `ConfigError`。
- `parseDynamicProfile`: `sourceRail` は今の 3 つだけ（`subetha-exact` は `ConfigError`。FR-1.1）。
- **synthetic モード**（`parseSynthetic`、`config.ts:1467`）: `sourceRail: "subetha-exact"` の route があれば `ConfigError`（合成レールにこの rail は無い。synthetic は表の照合と `inboundByRoute` を通らないので、ここで明示に止める）。real モードは T-5 まで `inboundByRoute` の既存の `ConfigError` で止まる（合成の試験で固定）。
- `validateRouterConfigAgainstTable`: `sourceRail === "subetha-exact"` の route は `validateTermsAgainstTable(…, { direction: "inbound", rail: "subetha-exact", … })` → zUSDC@84532 だけ通る（NFR-1）。
- `RealRailsConfig.subethaExact?: { facilitatorUrl: string; tokenFile: string; offerSeconds?: number; limits: SubethaExactLimits }`。`parseReal` は `subetha-exact` の route があるときだけ env を要求:
  `ROUTER_SUBETHA_EXACT_FACILITATOR_URL`（https、host `facilitator-testnet.subethalabs.com` か loopback、path `^/p/[a-z0-9-]+$`、query・userinfo・fragment 不可）、`ROUTER_SUBETHA_EXACT_TOKEN_FILE`（パス。中身は起動時に読む）、`ROUTER_SUBETHA_EXACT_OFFER_SECONDS`（`parseOfferSeconds`）。
  設定ファイル `subethaExact.limits`（任意。3 つとも 1 以上の整数。無ければ既定）。
- loopback の URL は `fixtureFacilitators` の能力があるときだけ（`composeRails` で検査。実入口は `ConfigError`）。

### 5.3 token のファイル（`src/main.ts` の合成）
`readSecretFile(path)`: `lstat` で通常のファイル（symlink 不可）、**`mode & 0o777 === 0o600`**（FR-1 のとおり厳密）、サイズ ≤ 4096、UTF-8、trim 後が `^[\x21-\x7e]{16,4096}$`。違えば `ConfigError`（値を含めない）。読んだ値は adapter の閉包にだけ渡す。

### 5.4 合成（`composeRails`）
- adapter を 1 つ作る条件: `subetha-exact` の route がある、**または** `RealRailsConfig.subethaExact`（env の URL と token ファイル）があり `<journal のディレクトリ>/subetha-exact/orders.ndjson` が存在する（過去の注文の complete の報告のため。§2）。route が無く env も無ければ何も作らない（FR-1）。route が無く env だけあって ledger も無ければ作らない（`note` で固定文）。`inboundRails["subetha-exact"]` に置く（`inboundByRoute` は `sourceRail` が x402/mpp 以外を `rails[sourceRail]` で引くので変更不要。route が無いときは `byRoute` に載らず、`ownsOffer` の fallback だけで届く）。
  `parseReal` は route が無くても env が**両方**あれば `subethaExact` を読む（片方だけなら `ConfigError`）。
- transport: `createGuardedTransport({ ...staticHooks, allowLoopback: inboundLoopback, report, dns: { timeoutMs: 3_000, maxInFlight: 16 } })`。
- `denyHosts` に facilitator の URL を足す（動的上流がある構成で自分の依存先に向けない）。
- `startupChecks` に `adapter.startup()`（ledger の open・salt・照会の 1 巡）、`ComposedRails.shutdown` に `adapter.close()`。
  **資源の所有（起動の失敗を含む）**: `adapter.startup()` は ledger を開いた後に失敗したら自分で閉じてから投げる。`startRouter` は `composeRails` の後の全部（`rails.startup()`・`rails.dynamic?.verify()`・`createRouterCore`・`startHttpServer`）を 1 つの `try` に入れ、失敗なら「core があれば `core.close()`（掃き出しを待ち journal を閉じる）→ `rails.shutdown?.()`（adapter の ledger の lock を解放）」の順で片付けてから `reportStartupFailure`。drain（SIGTERM）も同じ順。`src/main.ts:1430-1487` の既存の `try`（listen だけ）を広げる形で、既存の経路の順は変えない。
- `operatorAddressesOf`・`svmUsageOf` は触らない（この rail に `payTo` は無い）。`localCounterpartyPlanOf` も触らない（それは `sourceRail: "x402"` の route だけを選ぶ。Base Sepolia は EVM testnet だが、この rail は選ばれない）。

### 5.5 一覧・MCP・`npm run sign`・payer
- `sourceRailListingOf`: `subetha-exact` → `{ rail: "subetha-exact", scheme: "exact", fundsMoveOnCredential: false }`（この rail だけ 3 欄目を足す。FR-10.2）。`quoteBody` の `source.rail` は既存の式のまま。
- MCP `railHintOf`: `scheme === "exact"` かつ `extra.name === "zERC20 USD Coin"`（= この rail の offer）→ 「SubEtha facilitator の注文に払う。`npm run sign` は署名するだけで資金は purchase で動く。**Router が断っても署名は `validBefore` まで有効**で、同じ quote に署名し直しても同じ authorization（高々 1 回）。`unknown`／`awaiting_payment` は未払いの証明ではない」。購入・status の応答で `mayStillSettleUntil` があれば同じ文を添える。
- `tools/sign-classify-evm.ts` `checkExactCommon`: `inboundRailsOf(parsed.entry, parsed.known)` が `x402` か `subetha-exact` を含めば通す（文言は既存のまま）。
- `packages/payer/src/daemon/handler.ts` `staticSourceRailOf`: **`source.rail` が存在しない（`undefined`）ときだけ** network の表に fallback。存在して `x402`／`mpp` 以外（文字列・null・数値のどれでも）→ `undefined`（載せない）。既存の hosted の一覧（`rail` 付き・無し）の挙動は不変（試験で固定）。

## 6. 再起動と行の順序（FR-5.2・FR-7）

| 落ちた位置 | journal の最後の行 | 再起動後 | complete | 上流 |
|---|---|---|---|---|
| settle の前（停止点 `before_source_settle`） | `source_pending` | `unknown`（既存） | 呼ばない | 0 |
| settle の後、release の前（停止点 `after_source_settled`） | `source_settled` | `paid_undelivered`（既存） | 呼ばない（`source.release` 無し） | 0 |
| release の遠隔の記録の後、行の前（停止点 `after_release_remote`） | `source_settled` | `paid_undelivered` | 呼ばない（facilitator に `authorized` が残る。FR-11 で見える） | 0 |
| release の行の後、送出の前（停止点 `after_source_released`） | `source_released` | `paid_undelivered`（状態は `source_settled` だったので既存の規則） | 起動時に `failed` | 0 |
| 送出の途中（upstream の `--after-headers stall`） | `destination_pending` | `unknown`（既存） | 呼ばない | 不明 |
| 終端の後、complete の前（停止点 `after_terminal`） | `delivered`／`paid_undelivered`／`dest_failed` | 変わらない | 起動時に同じ outcome | — |
| complete の応答の喪失（fixture `complete lose-response` = **全部の試行の応答を落とす**。1 回だけ落として 2 回目で届く場合は `lose-response-once`） | 同上 + `source_complete_unreported unavailable` | 変わらない | 起動時に同じ outcome（冪等で 200） | — |

- `destination_submitted` は静的・動的の経路では書かれない行（`store.ts` の reduce にだけある）。再起動の規則は既存のまま `unknown`。**AC-2 (g) のこの行は wire の SIGKILL では作れない**（書く経路が無い）ので、単体試験で journal に行を直接書いて再起動の規則を確かめる（受け入れの逸脱として記録）。
- 再起動で止めるのは Router の process だけ。fixture（facilitator）と upstream の process と状態（注文・release の記録・呼び出し数）はそのまま残る（harness の `killRouter` → `restartRouter`。既存の `router-harness.ts` と同じ）。

## 7. 合成 facilitator（`tests/fixtures/subetha-exact-facilitator.ts`）

tenant の面を source のとおりに模す（NFR-4）。引数: `--provider-id`、`--bearer`、`--chain-id 84532`、`--asset`、`--domain-name`、`--domain-version`、`--ttl-seconds 300`、`--max-order-amount 1000000`、`--port 0`、およびモード（起動時の引数と、試験中に `POST /_fixture/mode { route, mode }` で切り替え）。

| 経路 | 模す挙動（出典） | モード |
|---|---|---|
| `POST /p/:id/exact/orders` | Bearer（401 `unauthorized`／404 `unknown`。`P:multi-routes.ts:334-343`）、本文の形（400）、額の方針（403 + `maxOrderAmount`）、(requester, resource) の未解決の注文の再利用（200 `existing: true`）、新規 201、`orderView`（`orderId`・`status`・`requirements`・`binding`） | `ok` / `busy`（503 + `Retry-After`）/ `busy-then-create`（503 を返し、注文は `POST /_fixture/allocate` で後から作る = 遅れた割当）/ `paused` / `rate-limited`（429）/ `lose-response`（注文を作ってから socket を閉じる）/ `slow:<ms>` / `unreadable`（200 で JSON でない本文）/ `existing-mismatch:amount|id|expired`（再利用の応答の額・id・期限を変える） |
| `GET /p/:id/exact/orders/:id` | `orderView`（`status.state`・`status.release.{state, deliveryKey, txRef, eventId, afterRelease}`・`status.exact.{state, origin}`） | `error`（5xx）/ `rate-limited` / `corrupt:<field>`（`binding.requesterDigest`・`binding.resourceDigest`・`release.deliveryKey`・`release.txRef`・`release.eventId`・`release.state`・`state` のどれかを変える）/ `after-release:reorged` |
| `GET /p/:id/exact/requesters/:d/orders?resourceDigest=` | 未解決の一覧（`orders: orderView[]`。`P:exact-routes.ts:127-132`） | `error` / `rate-limited` / `empty`（常に空） |
| `POST /p/:id/exact/verify` | 署名を先に検査（viem `verifyTypedData`、fixture の domain）→ 固定本文 `{isValid:false, invalidReason:"invalid_payment"}`（`P:multi-routes.ts:83, 310`）→ `#locate` 相当の `same` の照合 → `isValid` | `ok` / `invalid` / `slow:<ms>`（k2: 承認期限を verify の間に越える） |
| `POST /p/:id/exact/orders/:id/settle` | binding の照合（403）、`payTo` の照合（409）、`ExactSettleResult` + `order` | `accepted` / `pending` / `late-paid` / `rejected:<code>` / `error` / `timeout` / `lose-response` / `unreadable` |
| `POST …/release` | 1 回だけ 200 `{deliveryKey, txRef, eventId}`。2 回目 409 `already-claimed`（完了後 `already-delivered`／`already-failed`）。`not-ready` は 425 | `ok` / `not-ready-once` / `not-ready-always`（reorg の再現）/ `incident` / `lose-response`（記録してから切る → D′）/ `claimed-before`（Router の最初の呼び出しの**前**に release を記録しておく → 最初の POST が 409 `already-claimed` → D）/ `error-once` / `rate-limited-once` / `unreadable` |
| 任意の応答の注入（transport の境界の試験） | `POST /_fixture/mode { route, mode: "raw", status, headers, body }`（次の 1 回だけ任意の status・header・本文）、`mode: "huge-body"`（70 KiB の JSON）、`mode: "redirect"`（302 + `Location`）、`mode: "stall-body"`（headers の後に本文を止める。既存の `--after-headers` と同じ仕組み） | どの経路にも |
| `POST …/complete` | release 済み・`deliveryKey` 一致・同じ outcome は冪等 200、違う outcome は 409 `conflicting-outcome`、未 release は 409 `not-authorized`（`P:exact-routes.ts:194-203`） | `ok` / `error-once` / `lose-response`（全部の試行）/ `lose-response-once` / `unreadable` / `preset:<outcome>`（j: 先に別の outcome で完了させておく） |
| 試験の操作 | `POST /_fixture/orders/:id/paid-external`（注文を `accepted` に: l′）、`POST /_fixture/allocate { requesterDigest, resourceDigest, createdAt?, expiresAt? }`（遅れた割当を完了。**`createdAt`・`expiresAt` を試験が与えられる** = adapter の注入した時計と合わせる）、`POST /_fixture/mode`（モードの切り替え） | |
| 観測 | `GET /_fixture/calls`（経路ごと・注文ごとの回数）、`GET /_fixture/orders/:id`（内部の状態） | |

settle の `accepted` は `transaction` を `0x` + 64 hex の合成値、release は `eventId` を `<chainId>:<tx>:<logIndex>` で返す。時計は fixture の実時計（期限の試験は `--ttl-seconds` を短くして行う）。**時計の合わせ方（遅れた割当の試験）**: adapter の `now` を試験が注入して進め（例: 要求から 1 時間後）、`/_fixture/allocate` に `createdAt = adapter の今`・`expiresAt = createdAt + 300` を渡す。見つかった注文は adapter の時計で `expiresAt + 60` まで未解決に数えられること（新しい TTL）を断言する。

## 8. 運用者の確認（`tools/subetha-exact-inspect.ts`、FR-11）

`npm run subetha-exact:inspect -- [--remote] [--abandon <attemptId> --reason <token>]`: env `ROUTER_JOURNAL_PATH`（既定 `runtime/journal.ndjson`）から journal と `subetha-exact/orders.ndjson` を**読み取り専用**で開き（lock は取らない: `readFileSync` で replay だけ）、attempt ごとの 1 行（JSON Lines）を出す。
`--remote` のときだけ `ROUTER_SUBETHA_EXACT_FACILITATOR_URL`・`ROUTER_SUBETHA_EXACT_TOKEN_FILE` を読み、注文ごとに `GET /exact/orders/:id`、注文の分からない attempt ごとに `GET /exact/requesters/:digest/orders?resourceDigest=` を 1 回（同時 1、`Retry-After` を守る。見つかった注文は `foundByLookup: true`）。
**remote の欄は閉じた集合で写す**（それ以外の値は `"other"`）: `status.state` ∈ `ORDER_STATES`（`P:multi-routes.ts:85` の 15 語）、`release.state` ∈ `{none, authorized, delivered, failed}`、`release.afterRelease` ∈ `{reorged, screening-rejected}`（`burn-sale-backend.ts:245`）、`exact.state` ∈ `{reserved, signed, observed, paid, canceled, failed, relaying, relayed}`、`exact.origin` ∈ `{facilitator, external-broadcast, facilitator-relay}`（同 `:204-217`）。
出す欄: `attemptId, requesterDigest, orderId?, routeId, paymentId?, quotedAt, createMs, existing, settle, sourceTxRef, settleMs, release, releaseMs, complete, terminal, mayStillSettleUntil, remote: { state, release: { state, afterRelease }, exact: { state, origin } }, mismatch: boolean`（Router が `source_failed`／`unknown` で remote が `accepted`、Router が release 無しで remote が `authorized`、または注文の分からない attempt に remote の注文がある）。token・URL・本文は出さない。
facilitator への POST は 1 つも無い。`--abandon` は **adapter の ledger に `abandoned` の 1 行を書くだけ**（Router の process が動いていれば ledger の lock で失敗する = Router を止めてから行う。`--reason` は上の 3 つの token のどれか、TTY で確認）。試験は fixture の呼び出し数と、journal・ledger の前後の byte 一致で固定する。

## 9. 診断と計測（NFR-2）

- 所要時間と HTTP の分類の**計測の記録は adapter の ledger**（§3.2 の `elapsedMs`・`httpStatus`。作成・verify・settle・release・complete・照会の全部）。
- 既存の診断（`DiagnosticsSink`）には、verify・settle の往復（既存の `emitInboundRoundTrip`）と、transport の出来事（`DIAG_OPS` の 5 語の op）だけが入る。作成・release・complete の成功の往復は診断の閉じた形に段が無いので**入れない**（要件 NFR-2 の「診断に」はこの範囲: 要件 v4.1 の註として記録する）。

## 10. 試験の計画（要件 §6 との対応）

| 試験 | 中身 | AC |
|---|---|---|
| `tests/unit/subetha-exact-table.test.ts` | 表の上書き（zUSDC は `subetha-exact` だけ、USDC は不変、`x402` で zUSDC を設定すると `ConfigError`、他 network は `ConfigError`、額 > 20 000 は `ConfigError`）、`parseRoute`／profile／env／limits／token ファイル（mode 0600 厳密・symlink・形）の検査、既存 golden 不変、一覧の `rail`／`scheme`／`fundsMoveOnCredential`、既存の rail+資産の両方が無い設定の文言（T-1 で確かめる） | AC-3, AC-4, NFR-1 |
| `tests/unit/subetha-exact-classify.test.ts` | 表 A〜E・D′ の純粋関数（全行。読めない本文・知らない code・`existing` が boolean でない）、digest の符号化、復元の条件の 1 欄ずつの違い、予算の計算（`Retry-After` が残りを超える） | AC-2 (b)(d)(l) |
| `tests/unit/subetha-exact-adapter.test.ts` | fixture を相手に adapter 単体: 作成（ok／existing／expired／other id／mismatch／503／401／`unreadable`／lose-response → 同じ digest の再呼び出し／**別の requestId は別の注文**／同じ pair の 2 つ目の attempt と `byOrderId` の複数）、上限（累積・未解決・1 分・同時。作成の POST は 0 回、照会の GET は規則どおり）、照会（`busy-then-create` → 時間では外れない → `/_fixture/allocate`（adapter の時計に合わせた `createdAt`・`expiresAt`）→ 照会で `discovered` に記録され attempt は未解決のまま → **`discovered` は新しい期限まで、attempt は `--abandon` まで数える**；同じ pair で 2 回失う → `discovered` 1・未解決 2 → `--abandon` で 1 つだけ外れる；遅れた割当 → 照会 → 期限 → 他方の abandon → 遅れた割当、で数が減らない；`empty` のまま 1 時間（adapter の `now` を進める）→ 未解決のまま；5xx → 2 試行して `lookup failed`；起動時の 1 巡；`maxUnresolved` を 5 にして全件が照会されること）、preflight、verify（手元の拒否 → 欄なし、facilitator の拒否・**transport の失敗** → `isValid: false` + 正確な `mayStillSettleUntil`、throw しない）、settle の表、release（ok／425→ok／not-ready-always／incident／**D: `claimed-before` → GET 復元 → `released`、`claimed-before` + 各 `corrupt:<field>`（7 欄）→ `refused`、+ `after-release:reorged` → `refused`**／**D′: `lose-response` → GET → `released`、`lose-response` + `corrupt` → `unknown`**／error→GET（`none` → 再試行）／GET の 5xx → 2 試行／`Retry-After` 30 s が予算を超える → unknown。**復元が成功した D・D′ は送信へ 1 回だけ進む（AC-2 (d) の `delivered`）。失敗・不一致の D・D′ は送信 0 回**）、complete（ok／`preset` → `conflicting_outcome` 恒久／error-once／lose-response（全部）→ `unavailable`／tenant 404 → `unknown_tenant` 恒久／401 → `unauthorized`）、`ownsOffer`、**ledger の append の失敗**（`requested` で fail closed + 以後の作成の停止、遠隔の後の行で結果の保持）、salt の fsync と欠落時の `ConfigError`、`startup()` の失敗で ledger の lock が解放されること、adapter は `none` を返さない、**transport の境界**（fixture の `huge-body`・`redirect`・`stall-body`・`raw`: 64 KiB 超・redirect・headers 後に止まる本文 → 期限で `unreadable`／`unavailable`、任意の status が表の既定に落ちる）、**秘密の不在**（token・署名・credential の canary が ledger・`note`・例外の message・診断に無い。fixture が返す任意の欄・文が ledger に写らない） | AC-2 (b)(c)(c′)(d)(e)(f)(f′)(j)(n) |
| `tests/unit/subetha-exact-fixture.test.ts` | fixture 自身が facilitator の契約の表どおりか | NFR-4 |
| `tests/unit/lifecycle-release.test.ts` | core + 同一 process の合成 rail（`settleWindowOf`／`release`／`complete` 付き、`none` を返す wrapper 風の rail、**method を持たない rail**（wrapper 無しで core に渡す）、`release` が契約外の値を返す rail の 4 種）: 行の順序、`none`・method 無しで既存どおり、契約外の値で `unknown`、refused／unknown → `paid_undelivered` と上流 0、complete の行、恒久／一時の `unreported`、`unknown` 終端で complete 無し、`mayStillSettleUntil` の (i)(i′)(ii)（`quote_changed`・`source_verify_unavailable` を含む）と `awaitingPaymentDoesNotMeanUnpaid`（`unknown` でも真）、**route を消した後の `quote_changed` の開示（journal の `settleWindow` から。adapter 無し）と起動時の complete（`ownsOffer` の fallback。`inboundByRoute` を通す）、`created.tenant` が違う注文の complete は `refused`、報告の行の append の失敗（2 つの event とも）で応答が変わらず `note` だけ**、閉じた quote の再 quote、再起動の表（§6 の全行 + `destination_submitted` は行を直接書く、掃き出し、`close()` が掃き出しを待つ、行なしなら掃き出し無し）、同じ quote の並行・連続の purchase で settle／release／complete が各 1 回、`lifecycle.test.ts` 不変 | AC-2 (g)(h)(k)(l′)(m), FR-7 |
| `tests/unit/sign-subetha-exact.test.ts` | `classifyOffer`／`runSign` が zUSDC@84532 の `exact` を署名の対象にし、domain 違い・network 違い・20,000 超・`fundsMoveOnCredential: true`・`closed: true` の文書・offer 無しの文書を拒む | AC-4 |
| `packages/payer/test/unit/hosted-contract.test.ts` に追加 | `rail: "subetha-exact"`・`rail: null`・`rail: 1` の静的 route は `routeRowsOf` が落とし、`rail` 無しと `rail: x402` は不変 | FR-10.2 |
| `tests/wire/subetha-exact-cli.test.ts` | 実 CLI（`tests/fixtures/router-subetha-exact-process.ts`: `fixtureFacilitators: true`、`knownNetworksForTest`、署名 spy の送信能力、停止点の env）+ fixture + `x402-upstream`: AC-1 の通し、**release の応答の喪失（D′）と `claimed-before`（D）の復元が成功して `delivered` に至り上流の支払いが 1 回**（AC-2 (d)）、復元の失敗（`corrupt`）で `paid_undelivered` と上流 0（実 EIP-712 署名は `createX402Payer` で。journal の行の順序と fixture の `release.state: "delivered"`）、R1 の一覧、(a)(b)(i)(m)、(l′) の外部支払い + inspect の `mismatch`、`npm run sign` 相当の封筒がそのまま通ること、inspect の読み取り（AC-5: 呼び出し数と byte 一致） | AC-1, AC-2 一部, AC-5 |
| `tests/wire/subetha-exact-restart.test.ts` | §6 の各行（`destination_submitted` を除く）を停止点（`SUBETHA_EXACT_STOP_AT`）・upstream の stall・fixture の `lose-response` で決定的に作り、SIGKILL → 再起動（停止点なし。fixture と upstream は生かしたまま）→ 状態・complete の呼び出し数・上流の呼び出し数。**最後の route を消して再起動**（env は残す）: 掃き出しが `ownsOffer` の fallback で complete を報告する；env も消して再起動: 報告されず、`note` の固定文、inspect の `--remote` で見える | AC-2 (g), 旧 #14 |
| `tests/unit/subetha-exact-inspect.test.ts`・wire | 敵対的な sentinel: fixture が返す任意の欄・自由な文（remote の state・error・本文）が journal・診断・応答・inspect の出力に現れない（閉じた集合の `other` に写る） | FR-1, NFR-3 |
| `tests/unit/subetha-exact-inspect.test.ts` | 一覧の形と閉じた集合、`--remote` の GET と照会だけ（POST 0）、`mismatch` の 3 条件、`--abandon` の行・理由の token・Router 稼働中の拒否（lock）・前後の byte 比較 | AC-5, FR-9.2 (d) |
| 既存の全試験 | 不変 | AC-3 |

## 11. 事実の確認（本書で新しく読んだ行）

- `refusalStatus` の対応（425／404／403／409）: `P:exact-routes.ts:54`。release の route は `ExactRefusal` の `code` をそのまま本文 `{ error: code }` に（同 `:183-192`）。complete の route は `Error` の message の先頭語を本文に（`unknown-challenge` → 404、`conflicting-outcome`／`not-authorized`／`delivery-key-mismatch` → 409。同 `:194-203`）。tenant が無い・token が違うときの 404 `{error:"unknown"}`／401 は tenant の層（`P:multi-routes.ts:334-343`）。
- 公開 verify の固定本文 `{ isValid: false, invalidReason: "invalid_payment" }`（`P:multi-routes.ts:83`）、署名を先に（同 `:310`）。
- `orderView` に `binding` が載る（`P:exact-routes.ts:96-101`）。facilitator の注文の view の `status.release` の欄（`P:burn-sale-backend.ts:1782`）。`ORDER_STATES`（`P:multi-routes.ts:85`）、`afterRelease` の値（`burn-sale-backend.ts:245`）、`ExactIntent.state`／`origin`（同 `:204-217`）。
- settle の応答に `eventId` は無い（`P:exact-settle.ts:455-457`。`eventId` は release の応答と `status.release`）。Router 側の `eventId`（authorization の nonce）は x402 受信と同じ Router の値。
- SDK の `validBefore ≥ now + 6`（`node_modules/@x402/evm/dist/cjs/exact/facilitator/index.js:1158`）。
- `readBoundedBody` はバイト数だけを縛る（`src/net/bounded-body.ts:24-56`）: 時間は呼び出し側の signal／`Promise.race` で縛る（§3.9）。

## 12. 残す危険・未確認

- facilitator 自身の要求期限 30 秒より settle が長いと、Router は `unknown` を見る（§3.7）。段 4 で頻度を測る。頻発するなら Provider kit の `settlement_pending` + reconcile に相当する経路を別スライスで足す。
- `recoverTypedDataAddress` は EOA の署名だけを検査する（EIP-1271 は見ない）。zUSDC は ECDSA だけ（quickstart §3）なので一致。
- fixture は facilitator の source を模すが、実物ではない（段 4 で実機の応答と照合し、差があれば fixture と表を直す）。
- 閉じた quote の再 quote（§4.1）は全 rail の公開の契約の変更。オーナーの承認を本書の報告で得る。

## 13. 要件への小さな註（v4.1 → v4.2 に写したもの、および v3 で足すもの）
- NFR-2: 計測の所要時間は adapter の ledger が持ち、診断には verify・settle の往復と transport の出来事だけ（§9）。
- FR-9.2 (d)／FR-11: `--abandon` の鍵は `attemptId`（要求ごとの識別子。requester の digest は複数の attempt を持ち得るため）。
- AC-7: 設定の既定値に入るのは 3 つの上限（累積・未解決・1 分）で、**期間と停止の条件は `docs/subetha-exact-inbound-acceptance.md` に書く**（期間は設定の値ではなく段 4 の計画の値。停止の条件 = 累積の上限と「未解決が上限に達したら FR-11 で確かめてから」）。
- FR-4.5 (a): 「`source.offer` を載せない」は公開の面（HTTP R2・MCP）の契約。core の in-process の文書の型は変えない（§4.1）。
- **v3 で足す**（要件 v4.3 の註に写す）: FR-6 の恒久の失敗に **401 と tenant の 404**（`{error:"unknown"}`）を含める（§3.8 E）。FR-5.3 の「公開 verify は再試行しない」の transport の失敗は `isValid: false`（adapter は throw しない。§3.5）。AC-2 (g) の `destination_submitted` は wire では作れず、単体試験で行を直接書く（§6）。

## 14. v1 → v2 の対応（Codex `design-review1.md`）

| # | 指摘 | 反映 |
|---|---|---|
| 1 must | wrapper の `undefined` が既存 rail を壊す | §2: `ReleaseResult`／`CompleteResult` に `none` を足し、wrapper は常に定義して `none` を返す。core は `none` を「持たない」と読む（§4.4・§4.5）。adapter は `none` を返さない（試験） |
| 2 must | 掃き出しが一時の `unreported` を除外 | §2 の `COMPLETE_TRANSIENT_REASONS`、§4.5 の `reportComplete` の guard（恒久だけ除外）、`source_completed` が `unreported` を消す（§4.3） |
| 3 must | ledger が要求の履歴を表せない | §3.2: 鍵を attempt に。`created` に requirements・binding、`settle` に `txRef`。未解決は `settled` だけで解く（§3.6） |
| 4 must | 開示の欄の矛盾・早い応答の欠落 | §4.2 の表: `mayStillSettleUntil` を出すときは常に `awaitingPaymentDoesNotMeanUnpaid: true`、`quote_changed`・`source_verify_unavailable` を含む、初回・再提出・status の 3 つ |
| 5 must | 表 A・C・D・E の網羅と優先 | §3.8 を上から順の表に書き直し: 読めない本文、`none` の文脈差（D と D′）、E の 400／401／404 `unknown`／知らない 409 |
| 6 must | 再試行の時間と照会の飢餓 | §3.7: `Retry-After` を切り詰めない（予算を超えれば試行しない）、1 回の期限 = 残りの予算、complete も `Retry-After`、照会は cursor で全件を巡る（§3.6）、本文の読み取りも予算の内（§3.9） |
| 7 must | 掃き出しの所有 | §4.5: core が Promise を保持、候補は起動時に snapshot、`close()` が待つ、listen 失敗の経路も同じ、adapter の close は後（§5.4） |
| 8 must | 再起動の境界が決定的でない | §4.6 の停止点（core 3 点 + adapter 1 点。試験の能力からだけ）、§6・§10 |
| 9 must | fixture の操作の不足 | §7: `existing-mismatch`、`corrupt:<field>`、`after-release`、verify `slow`、complete `preset`、`/_fixture/allocate`、`/_fixture/mode`、注文ごとの回数。§10 に (c) の別 requestId・(h) の並行／連続・(l′) + inspect |
| 10 must | salt の耐久・記録の欄 | §3.2: salt は tmp+fsync+rename+dir fsync、欠落で起動を止める。`created` に requirements・binding、`verify`・`create_failed` の行、`settle` に `txRef` |
| 11 must | 機構の無い要件 | AC-7 の期間と停止（§3.6）、一覧の `fundsMoveOnCredential`（§5.5）、額 ≤ 20 000 の `ConfigError`（§5.2）、`retryAfterMs` を `QuoteOutcome` に（§2・§4.1）、`order_reused_*` の案内（§4.1）、NFR-2 の機構を明記（§9・§13） |
| 12 should | 値の検査 | `existing` は boolean（§3.4）、inspector の閉じた集合（§8）、`--abandon` の理由は 3 token |
| 13 should | 互換の主張と出典 | §5.1 の順の変更と「両方が無い」場合の文言、`refusalStatus` は `:54`、Base Sepolia の記述（§5.4）、settle に `eventId` は無い（§11）、0600 厳密（§5.3）、payer は `rail` が**無い**ときだけ fallback（§5.5） |

## 15. v2 → v3 の対応（Codex `design-review2.md`）

| # | 指摘 | 反映 |
|---|---|---|
| 1 must | wrapper 無しの rail で `release` が無いと `unknown` になる | §2「core の契約」: method が無ければ持たない、あって契約外なら `unknown`。§4.4・§4.5 の `typeof` の guard。§10 に 4 種の rail |
| 3 must | attempt の対応付けが曖昧 | §3.2: `byPair`・`byOrderId: attemptId[]`、操作の行の持ち主（offer を返した attempt／最新の `created`）、照会の結果が解く attempt の規則（同じ pair・`requestedAt ≤ createdAt`）、`via: "lookup"` の `existing` と `createdAt`。§3.4 の `existing` の照合は同じ pair |
| 4 must | verify の transport の失敗で正確な値が落ちる | §3.5: adapter が捕まえて `isValid: false` + 正確な値（throw しない）。§4.2 の表 |
| 5 must | 表の既定と FR-6 との矛盾 | §3.8: A に 2xx／1xx／3xx の既定、D に GET の 4xx、E に tenant 404・401・403 を恒久に（§13 の註） |
| 6 must | GET の再試行と照会の巡り | §3.7: GET は POST と別に最大 2 試行、照会も 2 試行。§3.6: 照会は全件（`lookupBatch` を廃止） |
| 7 must | 起動の途中の失敗の片付け | §5.4: `startRouter` の `try` を広げ、`core.close()` → `rails.shutdown()` の順。adapter の `startup()` は自分で閉じる |
| 8 must | 再起動の境界の不足 | §4.6 に `before_source_settle`、§6 に `destination_submitted` の逸脱・fixture と upstream の生存・complete `lose-response`（全部）と `-once` |
| 9 must | 遅れた割当の時計 | §7: `/_fixture/allocate` に `createdAt`・`expiresAt`、時計の合わせ方、新しい期限まで未解決。`corrupt` に `binding.resourceDigest`・`release.state` |
| 11 must | AC-7 の設定、照会の記録 | 要件 v4.2 の註（期間は acceptance 文書）。§3.2 に `lookup` の行 |
| 12 note | 敵対的な sentinel の試験 | §10 に行を足した |
| 14 must | route の変更の後の offer の rail の解決 | §2 `ownsOffer` と wrapper の fallback（`settleWindowOf`・`complete` だけ）。§10 に試験 |
| 2・10・13 | fixed | — |

## 16. v3 → v4 の対応（Codex `design-review3.md`）

| # | 指摘 | 反映 |
|---|---|---|
| 2 must | 照会の対応付けが view に無い `createdAt` に依存し、複数の attempt を一度に解いていた | §3.2: `createdAt` を捨て、「見つかった注文 1 つにつき、その pair の最も古い `created` の無い attempt を 1 つだけ」の保守の規則。試験に 2 回の応答の喪失と遅れた要求 |
| 3 must | 最後の route を消すと fallback の adapter が無い | §4.2: 開示の上限は quote のときに `created` の行へ（`source.settleWindow`。adapter 無しで出る）。§2・§5.4: adapter は route **または**（env + ledger）で作る。`created.tenant` で別 tenant の注文の complete を拒む。§10 に最後の route を消した再起動の wire 試験 |
| 4 must | complete の表の矛盾（401・tenant 404、429 と「ほかの 4xx」） | §2 の型の註、表 E を互いに素な上から順の表に、表 C に既定の行 |
| 5 must | 報告の行の append の失敗で 500 | §4.5: append を try/catch、応答は変えず `note` だけ、次の起動の掃き出しに任せる。試験に 2 つの event の注入 |
| 6 should | §3.9 の古い文、D と D′ の試験の区別 | §3.9 を操作ごとの例外の契約に、§7 に `claimed-before`、§10 に D／D′ の別の試験 |
| 7 should | fixture の注入の手段 | §7 に `raw`・`huge-body`・`redirect`・`stall-body` |

## 17. v4 → v5 の対応（Codex `design-review4.md`）

| # | 指摘 | 反映 |
|---|---|---|
| 2 must | 照会の結果を attempt に帰属させる根拠が無い | §3.2・§3.6: 帰属をやめ、見つかった注文は pair の `discovered`（attempt ではない鍵）に記録して負荷として数える。結果の分からない attempt は運用者の `--abandon` でだけ外れる（不変条件を明記）。`via: "lookup"` を削除。試験に遅れた要求の順序。要件 FR-9.2 (c) を v4.4 で改める |
| 3 must | `settleWindow` が `intentFromCreated` で消える | §4.3: `IntentSource.settleWindow` と `intentFromCreated` の復元。§4.2: 値の優先（正確な値 → 上限）と 5 つの経路の試験 |
| 4 should | adapter の ledger の失敗 | §3.9: `requested` は fail closed + `ledgerBroken`、遠隔の後の行は結果を保つ、`ledger_unavailable`。試験 |
| 5 should | D／D′ の成功で上流 0 の誤り | §10: 成功した復元は送信へ 1 回、失敗は 0 |

v5 → v5.1（`design-review5.md`、APPROVE WITH CHANGES）: should 2 → §10 の wire の試験に D／D′ の成功で `delivered`・上流 1 回、失敗で 0（adapter の単体試験は結果の分類だけ）；should 3 → §3.2 の操作の行の持ち主を耐久の index で解決（process の map を持たない。quote → 再起動 → 最初の purchase の試験）；should 4 → §3.2 の集計の試験を合計 3 → 2 → 1 で明記。

### 3.10 実装で確定した契約の補足（実装レビュー 3、v5.3）

- **ledger に attempt の無い注文の settle**（ledger の消失）: adapter は requester の digest を導けないので、facilitator を**呼ぶ前に** `rejected`（`source_rejected`）を返す（表 B は「要求を出した後」の失敗の表）。これは「送らない」の宣言であって、外で払われていないことの証明ではない（core は `source_failed` + 開示で止め、FR-11 の `--remote` で注文が見える）。`release` は同じ条件で `unknown`。
- **`createOffer` の資産の不一致**（設定の不整合。起動時に表で落ちるので到達しない）: `InboundOfferError("source_offer_refused", "requirements_mismatch")` + `note`（§3.9 の「`InboundOfferError` だけを投げる」のとおり）。
- **別の tenant の注文の complete**（facilitator の URL が変わった後）: 呼ばずに `unreported unknown_tenant`（恒久）+ `note` の固定文。
- **表 B の `unknown`** は `mayStillSettleUntil` を添える（`SettleResult` の任意の欄。core は verify で得た値を使う）。
- **表 D／D′ の `afterRelease` の有無**: 文字列で無い値が有るときも「有る」と読む（`parseOrderView` が `malformed` に写す）: 落として「無い」にしない。
- **合成**: loopback の facilitator の URL は `fixtureFacilitators` の能力があるときだけ（無ければ起動時に `ConfigError`）。ledger があるのに env が無い起動は `note` の固定文（未報告の complete は送られない）。
- **運用者の確認**: 照会で見つかった注文（ledger に無いもの）も `discovered` の行で出す（`foundByLookup: true`。attempt には結び付けない）。abandon 済みの attempt も読取だけの照会は続ける（FR-9.2 (e)）。`Retry-After` は切り詰めず、60 秒を超えるなら照会を諦める。`createMs`・`settleMs`・`releaseMs`・`completeMs` は ledger の `elapsedMs`。

## 18. v5.1 → v5.2（実装レビュー 1、`impl-review1.md`、REVISE。T-1〜T-2b の実装の後。「上限の値の範囲」「公開の面の値の検査」の 2 項は §4.3 の末尾（射影の規則の直後）に置いた）

| # | 指摘 | 反映 |
|---|---|---|
| 1 must | HTTP の quote の失敗で既存の `quote_failed` の本文に `reason` が増える | §4.3 末尾: `reason` は `source_offer_*` だけ。試験に `quote_failed` + 内部の reason の本文の不変 |
| 2 must | 相手の `mayStillSettleUntil` で MCP の文が投げ得る | §4.3 末尾: client・MCP の値の検査（Date の範囲）、投げない写し。敵対的な値の試験 |
| 3 should | `InboundOfferError` の値を型で信用している | §4.3 末尾: 閉じた集合と有限の値で照合。敵対的な値の試験 |
| 4 should | 試験の不足（k2 の時間の進行、`destination_pending` からの再起動、route と adapter を消した後の開示、Retry-After の切り上げ） | §10 の `lifecycle-release.test.ts`・HTTP の試験に追加 |
| 5 should | 動的の対称（`created.settleWindow`、昇格の後の行の `mayStillSettleUntil`）が無い | §4.2 のとおり `dynamic.ts` にも入れる（profile はこの rail を使えないので値は出ない。記録の形は不変） |
| 6 note | settle 済みの購入で上限を出さない逸脱 | §4.2 に明文化（上の「上限の値の範囲」）。`paid_undelivered`・再起動の試験 |
