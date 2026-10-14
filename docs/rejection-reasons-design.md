# 設計: 拒否・不明の理由の分類を診断の記録に残す（第 1 版、2026-10-15）

> 要件 `docs/rejection-reasons-requirements.md` 第 2.1 版と §7 の owner の決定（Q-1 → 運用者だけ、Q-2 → 進行中の購入が無ければ本番の入れ替えは Claude の判断）。
> コードは `origin/main`。SDK は `@x402/core`・`@x402/evm`・`@x402/fetch`・SVM の実装 2.28.0 に固定（`package.json:28-30,40`）。SDK の実装は同じ版の `node_modules` で読んだ（下の `chunk-*.mjs`）。
> 下書きは Plan エージェント（コードを引いて作成）、親が読んで採用。進め方: 設計 → Codex のレビュー → タスク → 実装の PR。

## 0. 一枚で

- **診断の記録は journal と別のファイル**で、追記だけ。`DiagnosticsSink.emit()` は同期で呼び、throw しない。呼び出し側は書き込みを待たない。上限（1 行・1 支払い・1 分・ファイル）を超えた分は捨てて数える。ファイルは 1 世代だけ回す。置き場所は journal と同じボリューム: Router は `/app/runtime/diagnostics/router.ndjson`、facilitator は `/app/runtime/evm-facilitator/diagnostics.ndjson`。driver は手元の `<evidence-dir>/diagnostics/driver.ndjson`。
- **結びつけ**: core が adapter を呼ぶ箇所を、`AsyncLocalStorage` の診断の scope（`paymentId`・`attempt`・`quoteId`・`requestHash`・`promoted`・`routeId`）で包む。adapter の記録と `TransportEvent` は、emit の時点の scope を sink が足す。**port の型は変えない**（前例 `src/adapters/inbound/mpp.ts:138`）。
- **Router と facilitator の結びつけ**: 診断用の id `cid = sha256("subetha-diag-cid/v1|network|asset|from|nonce")` の先頭 16 hex。facilitator は受け取った authorization から、Router は自分で検査した（受信）・自分で署名した（送信）authorization から、同じ関数（`src/shared/diagnostics.ts`）で作る。
- **理由は Router が持つ版つきの表で、完全一致だけ**（`src/shared/payment-reasons.ts`）。表の値・`absent`・`malformed`・`unrecognized` のどれかしか記録しない。試験が SDK の版と中身の両方を照合する。
- **宛先の理由はまずヘッダから読む**。x402 v2 の SDK の資源サーバは理由をヘッダに入れる（`PAYMENT-REQUIRED.error`・`PAYMENT-RESPONSE.errorReason`、本文は `{}`）。ヘッダは既にメモリにあり I/O は無い。**本文は sink が有効なときだけ**、結果を返した後で切り離して読む（1 KiB・250 ms）。見るのは JSON の `error`・`errorReason`・`invalidReason` だけ。sink が無効なら今の `discardBody` のまま。
- **範囲**: x402 の受信（kind `x402`・`circle`、EVM・SVM）と送信（動的 EVM・静的 Arc・静的 Base・SVM）の adapter に hook。MPP は core の段と transport の分類だけ（adapter の中の理由は後続）。自前の facilitator（verify の理由・RPC の分類）、署名の道具と driver（段・送出の観測・tx hash）、読むだけの道具 `tools/diagnostics-read.ts`。
- **触らないもの**: 支払いの結果（`outcome`・`reason`）、journal の形と中身、status・reopen の公開の射影、外への要求の数・順序・期限、再署名しない規則。

## 1. 確かめた事実（要件 §1 に足すもの）

| 事実 | 場所 |
|---|---|
| 受信の port の文脈は `routeId` だけ。送信の `PayRequest` は `paymentId`・`attempt` を持つ | `src/ports/inbound.ts:43-46,60-61`、`src/ports/outbound.ts:102-125` |
| core が adapter を呼ぶのは 5 か所（静的の verify・settle、動的の verify・settle、送信 1 か所） | `src/core/orchestrator.ts:647,741,797,836`、`src/core/dynamic.ts:626,689,704` |
| 動的の受信の verify は昇格（`budget.promote`・journal の `created`）の前。`paymentId`・`quoteId`・`requestId`・`principalId` は intent にある | `src/core/dynamic.ts:589-640,642-664`、`src/core/intent.ts:134-140` |
| 動的の受信では `quoteId` = `challengeNonce` = 束縛した EIP-3009 の `nonce` | `src/core/dynamic.ts:447`、`src/adapters/inbound/x402.ts:300-309` |
| 公開してよい理由の code の集合は `SAFE_REASONS`。adapter の任意の文字列は通さない | `src/core/orchestrator.ts:265-326` |
| x402 受信の `post` は kind `x402` で本文を全部、`circle` で 64 KiB まで読む。本文の読み取りの失敗は `report` して再び投げる | `src/adapters/inbound/x402.ts:146-180` |
| SVM 受信の `post` も上限つきで読み、`invalidReason` などは読まない | `src/adapters/inbound/x402-svm.ts:398-419,467-499` |
| `TransportError` は固定の `code`、`classifyTransportError` は純粋関数。headers の前の失敗は transport が、本文の失敗は adapter が報告する | `src/net/guarded-fetch.ts:24-59,236-246,451-454` |
| 送信の領収の判定（`receiptOf`）は `PAYMENT-RESPONSE` を先に、無ければ `X-PAYMENT-RESPONSE`。無い・壊れた・失敗・network 違い・tx の形違いは `none` にまとまる | `src/adapters/outbound/x402-dynamic.ts:54-85` |
| `paidOutcomeOf` は動的 EVM・静的 Arc・SVM で共有。領収が無ければ本文を `discardBody` | `src/adapters/outbound/x402-dynamic.ts:121-150`、`x402.ts:401`、`x402-svm.ts:700` |
| 静的の Base は SDK の `processResponse` で本文を先に読み、ヘッダの領収を見る | `src/adapters/outbound/x402.ts:575-655` |
| 動的の送信の `not_sent` は固定の code。challenge の読み直しの失敗の分類（`DynamicChallengeError.reason`）は捨てている | `src/adapters/outbound/x402-dynamic.ts:458-474,610-680` |
| 動的の transport は門の枠（`admit`）を本文を読み終える・中断するまで持つ | `src/net/guarded-fetch.ts:372-382,427` |
| SDK の資源サーバは verify の失敗を `PAYMENT-REQUIRED` の `error`（= `invalidReason`）に入れた 402 にし、本文は `{}` | `@x402/core/dist/esm/chunk-FV2JN4FK.mjs:1135-1147,2596-2607,3119-3157` |
| settle の失敗は 402 + `PAYMENT-RESPONSE`（`success:false`・`errorReason`）、本文 `{}`。例外のときの `errorReason` は例外の文言（自由な文字列） | `chunk-FV2JN4FK.mjs:2748-2800,2822-2825,2918-2940` |
| `@x402/evm` の verify の simulate は RPC の例外を握りつぶし `invalid_exact_evm_transaction_simulation_failed` を返す（429 も同じ値） | `@x402/evm/dist/esm/chunk-DBLZWTJ6.mjs:215-270` |
| 理由の値は `var Err… = "…"` の定数と `invalidReason: "…"` の literal で約 170 個 | `@x402/evm/dist/esm/chunk-VEDHRFNU.mjs` ほか |
| 自前の Worker（Provider）は 402 に `{error:"payment_invalid"}`（ヘッダの `error` は `payment_invalid`・`no_matching_requirements`）、502・503 に固定の token（`facilitator_unavailable`・`facilitator_registration_required`・`data_unavailable`・`provider_busy`・`settle_failed`・`settlement_pending`・`receipt_malformed`・`internal`） | `providers/x402-workers/src/index.ts:76-88,122,159,175,183`、`receipt.ts:59-74`、`facilitator-client.ts:16` |
| facilitator の verify は SDK の `invalidReason` を応答に入れる。自分の失敗 code は `failure(status, code)`。識別の `key` は nonce をそのまま含む | `tools/evm-facilitator.ts:389,547,1111-1128` |
| facilitator の RPC の読み取りの失敗は `catch {}` で `rpc_unavailable` にし分類を捨てる。viem の transport は `retryCount: 0`・15 秒 | `tools/evm-facilitator.ts:802-826,879-890,1641` |
| facilitator の `handle` は verify と settle の入口が 1 か所。既存の file logger に上限は無い | `tools/evm-facilitator.ts:1214-1239,1744-1759` |
| viem 2.54.0: `HttpRequestError.status`、`TimeoutError`、`LimitExceededRpcError.code = -32005` | `viem/_esm/errors/request.js:4-20,134-139`、`rpc.js:196-209` |
| 子 process の stdout・stderr は入口のメモリに貯まるだけ | `tests/fixtures/loopback.ts:128-129`、`tools/remote-mcp.ts:521-534` |
| 子の env は allowlist。Router の子の journal は `ROUTER_JOURNAL_PATH`、facilitator の journal は公開の journal のディレクトリの下 | `tools/remote-mcp.ts:139-150,190-200,291-325` |
| 能力（`RouterCapabilities`）はコードから注入する。公開の子は env を `routerProcessCapabilitiesOf` に渡す | `src/main.ts:81-170`、`tools/remote-router-process.ts:30-58`、`tools/rails-entry.ts:226` |
| `composeRails` は全部の transport に 1 つの `report` を渡す | `src/main.ts:190-207,539-569` |
| MPP の payer は RPC の `fetchFn` を差し替えられる。送金は `mppx.createCredential` の中で起き、tx hash は成功の後にしか取れない | `tools/mpp-payer.ts:66-70,121,155-169` |
| driver は `payAndCredential` の前に `paying = true`、想定外の例外を `"signing failed"` にまとめる。止める判断は `fundsMoveAtSign \|\| fundsMayHaveMoved` | `tools/evm-testnets-matrix.ts:654-691,1186-1205` |
| `src/`・`tools/` には SVM の SDK の package 名を（コメント以外で）書けない | `tests/unit/dependency-direction.test.ts` |

## 2. 診断の記録（`DiagnosticsSink`）

### 2.1 置き場所と作り方

| 構成要素 | 作る場所 | ファイル | env |
|---|---|---|---|
| Router の子 | `tools/remote-router-process.ts`（`routerProcessCapabilitiesOf` は純粋なまま、結果に `diagnostics` を足して `startRouter` へ） | `<journal のディレクトリ>/diagnostics/router.ndjson`（公開 `/app/runtime/diagnostics/router.ndjson`、受け入れ `/app/runtime/acceptance/diagnostics/router.ndjson`） | 入口（`hostPlanOf` の公開・受け入れ）が childEnv に `SUBETHA_DIAGNOSTICS_PATH` を足す（`options.journalPath` から作る）。mainnet の 1 経路は足さない |
| facilitator の子 | `tools/evm-facilitator.ts` の CLI（`cliConfigOf` に `diagnostics`） | `/app/runtime/evm-facilitator/diagnostics.ndjson`（journal の隣。公開と受け入れで同じ。`flock` で同時に 1 つ） | `evmFacilitatorPlanOf` が `EVM_FACILITATOR_DIAGNOSTICS` を足す |
| driver | `tools/evm-testnets-matrix.ts`（`run`） | `<evidence-dir>/diagnostics/driver.ndjson` | なし |

- 止めるとき: 本番の env の `SUBETHA_DIAGNOSTICS=off` で、入口は両方の子に path を渡さない（no-op の sink）。新しい env は必須にしない。
- **D-1（journal と別、best effort、fsync なし）**: process が落ちると最後の数行は失われ得る。代わりに支払いの経路に待ちを足さない。

### 2.2 interface（`src/shared/diagnostics.ts`。純粋。`node:fs` は使わない）

```ts
export interface DiagnosticsSink { emit(record: DiagRecordInput): void }   // 同期・throw しない
export const NOOP_DIAGNOSTICS: DiagnosticsSink;
export function safeEmit(sink: DiagnosticsSink, build: () => DiagRecordInput): void; // build と emit の例外を両方握る
export function withDiagnosticScope<T>(scope: DiagScope, fn: () => Promise<T>): Promise<T>; // AsyncLocalStorage.run
export function currentDiagnosticScope(): DiagScope | undefined;
export function diagCorrelationIdOf(network: string, asset: string, from: string, nonce: string): string; // §5.2
export function requestHashOf(principalId: string, requestId: string): string;                          // §3
export function validateDiagRecord(value: unknown): DiagRecord | undefined;                             // §3 の閉じた値の集合
```

ファイルの sink は `src/shared/diagnostics-file.ts`: `createFileDiagnosticsSink({ path, component, limits?, clock?, fs? }): DiagnosticsSink & { counters(): DiagCounters; close(): Promise<void> }`。

- 開き方: ディレクトリを 0700、ファイルを `open(path, "a", 0o600)`。書き込みは 1 本の promise の連鎖（前例 `tools/evm-facilitator.ts:1744-1759`）。
- `emit`: 今の scope を足す → `validateDiagRecord` → 上限 → 待ち行列。外れた・超えたものは捨てて数える。どの段の例外も握る。

| 上限（既定） | 値 | 超えたとき |
|---|---|---|
| 1 行 | 2,048 バイト | 捨てて `droppedLineTooLarge` |
| 1 つの鍵あたり（`paymentId`、無ければ `quoteId`、無ければ `cid`） | 32 行。覚える鍵は 10,000（古い順） | `droppedPerKey` |
| 全体の頻度 | 600 行 / 分 | `droppedRate` |
| 待ち行列 | 1,000 行 | `droppedQueueFull` |
| ファイル | Router 32 MiB・facilitator 16 MiB・driver 8 MiB | `x.ndjson` → `x.ndjson.1` に rename（1 世代、最大計 112 MiB）。rename の失敗は `rotateFailed`、以後は数えるだけ |
| 検査の失敗 | — | `droppedSchema`（試験では 0 を要求） |
| 書き込みの失敗 | — | `writeFailed` |

- 捨てた数が増えたとき、最大 1 分に 1 回 `component:"sink", stage:"counters"` の行を書く（`close` でも 1 回）。
- **D-12: scope の外の transport の出来事は記録しない**（quote の段の失敗は匿名の呼び出し手が起こせ、ファイルを埋められる）。これまでどおり stderr だけ。
- 試験の差し替え（`tests/fixtures/diagnostics.ts`）: `recordingDiagnostics()`、`throwingDiagnostics()`、fs の差し替え（書けない・遅い・ENOSPC）。

### 2.3 注入の経路（Router）

1. `RouterCapabilities` に `readonly diagnostics?: DiagnosticsSink`（`src/main.ts:81`）。本番では公開の子だけが渡す。無ければ `NOOP_DIAGNOSTICS`。
2. `composeRails`（`src/main.ts:564`）: `report` を包む。元の `report` を先にそのまま呼び（stderr は byte 一致）、scope があるときだけ `stage:"transport_event"` を残す。x402 の受信・送信の adapter（動的を含む）・SVM の受信と送信に `diagnostics` を渡す。
3. `createRouterCore` の option に `diagnostics?`。`startRouter`（`src/main.ts:1236-1248`）が渡す。
4. core は 5 か所の adapter の呼び出しを `withDiagnosticScope` で包む（§4.1）。返り値と例外はそのまま。
5. adapter の hook は **結果のオブジェクトを作り終えた後** に `safeEmit` を呼び、作った結果をそのまま返す（D-3）。

**D-2（scope は AsyncLocalStorage）**: port の型（`InboundCallContext`・`PayRequest`・`TransportContext`）を変えずに済む。MPP・`guardedRpcTransport` の深い `report` まで 1 か所で結びつく。前例（`src/adapters/inbound/mpp.ts:138`、`src/net/guarded-rpc.ts:75`）。代わりの案は §10。

## 3. 記録の形（版 1）

1 行に 1 つの JSON object。欄が無い = 見ていない・当てはまらない。`"absent"` = 相手の応答にその欄が無かった。

| 欄 | 値の集合 | 備考 |
|---|---|---|
| `v` | `1` | |
| `at` | ISO 8601 UTC | sink が付ける |
| `seq` | 0 以上の整数 | process の中の連番 |
| `component` | `router`・`facilitator`・`signer`・`driver`・`sink` | |
| `stage` | Router: `source_verify`・`source_settle`・`dynamic_precheck`・`dest_challenge`・`dest_sign`・`dest_pay_request`・`dest_reject_body`・`dest_outcome`・`transport_event`。facilitator: `verify`・`settle`・`rpc`。signer・driver: `sign`・`purchase_call`・`status_call`。sink: `counters` | 閉じた集合 |
| `paymentId` | `^[0-9a-f-]{36}$` | Router が発行（`orchestrator.ts:351`） |
| `attempt` | 1〜1000 | |
| `quoteId` | `^0x[0-9a-f]{64}$` | D-9 |
| `requestHash` | 16 hex（`sha256("subetha-diag-req/v1\|principalId\|requestId")` の先頭） | `requestId` は自由な文字列なので hash |
| `cid` | 16 hex | §5.2 |
| `promoted` | 真偽 | 動的の昇格の前か後か |
| `routeId` | `^[A-Za-z0-9._@:-]{1,96}$` | 設定の id |
| `network` | `KNOWN_NETWORKS` の id か `"unrecognized"` | |
| `facilitator` | `x402`・`circle`・`self` | |
| `op` | transport の operation の閉じた集合（`facilitator_verify`・`facilitator_settle`・`challenge`・`pay_challenge`・`pay`・`rpc`・`estimate_rpc`・`read_challenge`・`svm_settle_follow_up`・`mpp_solana_*` …）か `"other"` | |
| `httpStatus` | 100〜599 | |
| `transport` | `TransportCode` の 7 つ | 実際に観測した分類だけ。経過時間からは決めない |
| `response` | verify: `valid`・`invalid`・`not_json`・`http_error`・`proof_refused`。settle: `ok`・`success_false`・`network_mismatch`・`tx_malformed`・`not_json`・`http_error`・`proof_refused` | |
| `receipt` | `absent`・`malformed`・`failed`・`network_mismatch`・`tx_malformed`・`payer_mismatch`・`ok` | §4.3 |
| `receiptHeader` | `payment-response`・`x-payment-response`・`none` | |
| `reasonField` | `invalidReason`・`errorReason`・`error` | |
| `reasonSource` | `facilitator_body`・`payment_required_header`・`payment_response_header`・`response_body` | |
| `reason` | 表の token、`absent`・`malformed`・`unrecognized` | 完全一致だけ |
| `table` | `REASON_TABLE_VERSION`（例 `r1/x402-2.28.0`） | `reason` があるときだけ |
| `outcome` | `settled`・`rejected`・`unknown`・`valid`・`invalid`・`paid`・`paid_no_data`・`not_sent`・`awaiting`・`threw` | 決まった結果の写し |
| `code` | Router の固定の code（`SAFE_REASONS` ∪ 動的の awaiting の code ∪ `not_sent` の code ∪ `DynamicChallengeError` の 9 つ ∪ facilitator の自分の code ∪ signer の段）か `"unrecognized"` | |
| `rpc` | `timeout`・`rate_limited`・`other` | §5.3 |
| `rpcHttpStatus` | 100〜599 | |
| `rpcCode` | −2^31〜2^31 の整数 | JSON-RPC の数値の code |
| `elapsedMs` | 0〜3,600,000 | `performance.now()` の差 |
| `bytes` | 0〜2^31 | |
| `txRef` | `^0x[0-9a-f]{64}$` | signer・driver だけ（chain の上で公開の値） |
| `txRefSource` | `computed`・`rpc_result`・`both`・`mismatch` | |
| `broadcast` | `not_observed`・`attempted`・`accepted`・`rpc_error`・`http_error`・`timeout` | signer |
| `fundsMayHaveMoved` | 真偽 | driver |
| `counters` | 整数だけの固定の鍵の object | sink |

- `validateDiagRecord`: 知らない鍵・集合の外の値・正規表現に合わない文字列が 1 つでもあれば行ごと捨てる。読み替えはしない。型（literal の union）と実行時の検査の両方で縛る。
- **D-9（`quoteId` はそのまま、`requestId` は hash）**: `quoteId` は Router が発行し、journal と呼び出し側への応答に既にある。FR-R8 は `quoteId` で引けることを求める。動的の受信では `quoteId` が authorization の `nonce` と同じ値だが、このファイルを読める運用者は journal も読めるので新しく漏れるものは無い（代わりの案 §10 Q-A）。

## 4. Router の hook

### 4.1 core（`src/core/orchestrator.ts`・`src/core/dynamic.ts`）

| 呼び出し | scope | 記録（呼んだ後） |
|---|---|---|
| 静的の verify（`orchestrator.ts:647`） | `{paymentId, quoteId, routeId, promoted:true}` | `source_verify`: `outcome`（`valid`・`invalid`・`threw`）・`elapsedMs`。throw なら `transport: classifyTransportError(e)`（TransportError でなければ `transport_failed`）。`code` は今の journal・応答と同じ値 |
| 静的の settle（`:741`） | 同上 | `source_settle`: `outcome`・`code`（`safeReason` の後）・`elapsedMs`・throw なら `transport` |
| 動的の verify（`dynamic.ts:626`） | `{paymentId, quoteId, requestHash, routeId: profileId, promoted: isPromoted}` | `source_verify`。**journal・ledger・予算には何も書かない**。`awaiting(...)` は今のまま |
| 動的の settle（`:689`） | 同上（`promoted:true`） | `source_settle` |
| 動的の awaiting の helper（`:591`） | 今の scope | `dynamic_precheck`: `code`（`offer_unavailable`・`offer_changed`・`fee_estimate_unavailable`・`fee_too_high`・`approval_expired` …） |
| 送信（`orchestrator.ts:836`、静的・動的） | `{paymentId, quoteId, routeId, attempt}` | `dest_outcome`: `outcome`・`code`（`safeReason` の後）・`elapsedMs`。throw は `threw`。**`not_sent` の手元の理由（FR-R3(e)）はここ** |

- 記録は journal に追記した後・応答の値を作った後に置く。journal の `append` の順序・回数は変えない。

### 4.2 受信の adapter（`src/adapters/inbound/x402.ts`・`x402-svm.ts`）

- **verify**（`x402.ts:328-347`）: 売り手証明が作れない → `response:"proof_refused"`（要求 0 回）。それ以外は `post` が返した `status`・`json`（既に読んである）から: `httpStatus`、`response`、`reason = classifyReason(json.invalidReason)`（`reasonField:"invalidReason"`、`reasonSource:"facilitator_body"`）、`elapsedMs`、`facilitator`、`network`。EVM なら `cid`（`credential.payload.authorization` の `from`・`nonce` と `offer.network`・`offer.asset`。形が違えば欄を書かない）。結果を先に作り、記録してから返す。
- **settle**（`:349-386`、circle `:395-407`）: 同じ欄と `response`（`ok`・`success_false`・`network_mismatch`・`tx_malformed`・`not_json`・`http_error`）、`reason = classifyReason(json.errorReason)`。Circle の `403 registration_required` は `httpStatus:403`・`reason:"registration_required"`、結果は今どおり `unknown`。`onDiagnostic` もそのまま。
- **transport の失敗**: `post` が throw したとき adapter は記録しない（core が §4.1 で `transport` を残す）。`transport.report` の出来事も scope があれば `transport_event`。
- **SVM**（`x402-svm.ts:467-499`）: 同じ形。`cid` は書かない（EIP-3009 ではない）。

### 4.3 送信の adapter（`src/adapters/outbound/x402-dynamic.ts`・`x402.ts`・`x402-svm.ts`）

- **領収の分類** `receiptClassOf(response, approved, form)`（純粋）: `receiptOf` と同じ順・同じ decoder。ヘッダの順は `PAYMENT-RESPONSE` → `X-PAYMENT-RESPONSE`（`x402-dynamic.ts:55`）。空・無し → `absent`、decode できない・object でない → `malformed`、`success !== true` → `failed`（`errorReason` を表で分類、`reasonSource:"payment_response_header"`）、network 違い → `network_mismatch`、`transaction` の形違い → `tx_malformed`、`payer` 違い → `payer_mismatch`、それ以外 → `ok`。大きさは transport のヘッダの上限に従う（動的 32 KiB `src/net/bounded-body.ts`）。試験の不変条件: `ok` ⇔ `receiptOf` が `settled`、`payer_mismatch` ⇔ `payer_mismatch`、それ以外 ⇔ `none`。
- **`paidOutcomeOf`**（`:121-150`）: `deps` に `diagnostics?`・`cid?`。結果を決めた後で `dest_pay_request`: `httpStatus`・`receipt`・`receiptHeader`・`elapsedMs`・`cid`。領収が `ok` でなく 402 なら `PAYMENT-REQUIRED` を decode して `error` だけを表で分類（`reasonSource:"payment_required_header"`）。本文の読み取りの失敗（`deliveredBodyOf`）は `transport` と `code:"paid_data_unavailable"`。
- **断った本文（`dest_reject_body`、D-5）**: 領収が `ok` でなく status ≥ 400 のときだけ。sink が `NOOP` なら今の `discardBody(response)` だけ。有効なら **`return` の後に切り離した非同期の処理で**: `content-type` が `application/json` で `content-length` が無いか 1,024 以下のときだけ `readBoundedBody(response, 1024)` を 250 ms と競わせ、時間切れは `body.cancel()`。JSON の最上位の `error`・`errorReason`・`invalidReason`（文字列）だけを表で分類し `bytes` と記録。最後は必ず `discardBody`。失敗は無視。影響は動的の transport の門の枠の返却が最大 250 ms 遅れることだけ（§8.2 で確かめる）。
- **`not_sent` と challenge**: `not_sent` は core の `dest_outcome`。読み直しの失敗（`x402-dynamic.ts:618-624`、`x402.ts:429-436`）は `catch (e)` にして `dest_challenge`: `code`（`DynamicChallengeError` ならその `reason`、`TransportError` ならその `code` を `transport` に、それ以外は `challenge_invalid`）・`elapsedMs`。message は使わない。
- **`cid`**: `createPaymentPayload` の返した `payload.authorization` の `from`・`nonce` と `approved.network`・`approved.asset` から（`x402-dynamic.ts:654-664`、`x402.ts:376-386`）。`dest_sign`（`outcome`: `signed` か `not_sent` の code）に残し、`paidOutcomeOf` に渡す。
- **有料の要求の transport の失敗**（`x402-dynamic.ts:677-680`、`x402.ts:397-399,570-573`）: `catch (e)` にし、結果（`destination_pay_unknown`）は変えない。`dest_pay_request` に `transport`・`elapsedMs`。
- **静的の Base**（`x402.ts:575-655`）: SDK が本文を読むので切り離しの読み取りはしない。返す値を決めた後、ヘッダの `receiptClassOf` と `PAYMENT-REQUIRED.error` だけ。`processResponse` の失敗は `transport`。
- **SVM 送信**（`x402-svm.ts:612,696,700`）: 共有の `paidOutcomeOf`。`cid` は書かない。

### 4.4 MPP（FR-R4 の範囲）

**D-7**: MPP（Tempo・Solana、受信・送信）は §4.1 の core の段と `transport_event`（`guardedRpcTransport` の `report` を含む）だけ。理由: adapter の中の結果の出口が約 41 か所（`mpp.ts`・`mpp-dynamic.ts`・`mpp-solana.ts`）、mppx の失敗は problem-details の自由な文字列で表が無い、今回の出来事のうち MPP は Tempo の署名の後の失敗（Router の外、§6）だけ。adapter の中の理由の表は後続（§10）。

## 5. 自前の facilitator（`tools/evm-facilitator.ts`）

### 5.1 hook

- `EvmFacilitatorOptions` に `diagnostics?`（既定 `NOOP`）。CLI は `EVM_FACILITATOR_DIAGNOSTICS` があれば file sink（`component:"facilitator"`、16 MiB）。
- **既存の `log`（`key` を含む）は変えない**（§10 Q-D）。
- `handle`（`:1214-1239`）で `op` が `verify`・`settle` のとき: (1) `bodyJson` から `cid` を軽く読み出す（`identify` とは別の純粋関数、形どおりのときだけ）、(2) `withDiagnosticScope({ cid, network }, …)` で包む、(3) 応答を作った後で `stage: verify | settle`: `httpStatus`、`reason`（応答の `invalidReason`・`errorReason`。SDK の値と自分の code の両方を表で完全一致）、`elapsedMs`。
- verify の失敗の理由（FR-R6）: SDK の `invalidReason` は `handleVerify`（`:1123`）と settle の中の verify（`:893-898` → `invalid_payment`）。settle の中の verify は `refuseIfStillUnused` に渡す前に SDK の値を `stage:"verify"` で残す（応答は今どおり `invalid_payment`）。識別・束縛の失敗の値（`malformed_request`・`network_not_enabled`・`asset_not_in_table`・`malformed_payload`・`malformed_authorization`・`unsupported_x402_version`、`checkBinding` の 15 個）は表の `self` の節。
- `catch {}` で `rpc_unavailable` にしている 4 か所（`:806-808,823-825,880-885`、verify の `:1125-1126`）は `catch (e)` にし `rpc` の記録を足す。応答は今どおり。

### 5.2 診断用の id（`cid`）

- `cid = hex(sha256("subetha-diag-cid/v1|" + network + "|" + assetKeyOf(network, asset) + "|" + from.toLowerCase() + "|" + nonce.toLowerCase())).slice(0, 16)`（`assetKeyOf` は `src/shared/networks.ts:212`）。入力は `identify`（`:389`）の `key` と同じ 4 つ。nonce は 32 バイトの乱数で、64 bit の先頭から戻せない。
- Router 側: 受信は §4.2（facilitator に送る要求と同じ値から）、送信は §4.3（Router が署名した authorization。Provider は payload を変えずに facilitator に渡すので同じ値）。
- 関数は `src/shared/diagnostics.ts` の 1 つ。試験で `identify` の `key` から作った値と一致することを固定。

### 5.3 RPC の失敗の分類

- `viemChainIo`（`:1631-1742`）で `reader` の 6 つ、`writer.transferWithAuthorization`、SDK に渡す `signer` の `readContract`・`verifyTypedData`・`getCode` を `observeRpc(op, fn)` で包む。例外を `classifyRpcError` で分類して `stage:"rpc"` を残し、**同じ例外をもう一度投げる**。SDK が握りつぶす simulate の失敗も、包んだ `readContract` で先に見える。
- `classifyRpcError` は `cause` の連鎖を深さ 5 まで辿り、最初に当たったもの:

| 当たったもの | 記録 |
|---|---|
| `HttpRequestError` で status 429 | `rate_limited`、`rpcHttpStatus` |
| `LimitExceededRpcError`、または数値の `code === -32005` | `rate_limited`、`rpcCode` |
| `TimeoutError`（viem） | `timeout` |
| facilitator 自身の `DeadlineExceeded`（`:495-500`） | `timeout`、`code:"deadline"` |
| ほかの `HttpRequestError` | `other`、`rpcHttpStatus` |
| ほかの数値の `code` | `other`、`rpcCode` |
| それ以外 | `other` |

  文言は読まない（viem の message は URL を含み得る: `:1566`）。起動時の照合（`resolveAtStartup`）は scope の外なので `cid` は付かない。

## 6. 署名の道具と driver（FR-R7）

- **`tools/sign-run.ts`**: `SignDeps` に `onStage?: (e: SignStageEvent) => void`（閉じた集合: `dispatch`・`refused`・`key_read`・`payer_create`・`disclosure_written`・`pay_and_credential`・`credential_for`・`envelope`・`done`）。各段の入口で呼び、try/catch で包む。順序・stdout・stderr は変えない。
- **`tools/mpp-payer.ts`**: options に `observeRpc?`。あるときだけ `fetchFn` を包む。要求を変えずに: `init.body` の JSON の `method` が `eth_sendRawTransaction` なら **送る前に** `txRef = keccak256(params[0])` を作って `broadcast:"attempted"`（raw の tx は残さない）。応答の HTTP の status、`content-length` ≤ 4 KiB のときだけ `clone()` から JSON-RPC の `error.code`（数値）と `result`（tx hash の形のときだけ）を読み、`txRefSource` を `both`・`mismatch` など。例外は `timeout`・`other`。観測の失敗は無視。
- **`tools/evm-testnets-matrix.ts`**（`:621-691`）: `matrixSignerOf` が `onStage` と `observeRpc` を受けて最後の段・`broadcast`・`rpc`・`txRef` を集め、`MatrixSignResult.diagnostic?` に載せる。`"signing failed"` の文は変えない。`run`（`:1186-1205`）は `evidence.signDiagnostic` に写し、`driver.ndjson` に `stage:"sign"`（`paymentId`・`quoteId`・`fundsMayHaveMoved`・`txRef`）。`purchase_call`・`status_call` の失敗も分類（`timeout`・`httpStatus`・`other`）。
- **D-11（保留を弱めない）**: `paying = true`（`:658-662`）、`fundsMayHaveMoved`、止める判断（`:1204`）、署名の印（`:1186-1192`）は診断を一切読まない。`broadcast:"not_observed"` でも `funds_possibly_moved` で止まり二度と署名しない（試験で固定）。`txRef` が分かれば `evidence.signTxRef` に入る（計算した hash でも。印・保留の扱いは同じ）。
- `tools/evm-testnets-e2e.ts:937`（x402 EVM だけ）も `onStage` の最後の段を証跡に残す。

## 7. 理由の表（FR-R1。`src/shared/payment-reasons.ts`）

- `REASON_TABLE_VERSION = "r1/x402-2.28.0"`。`REASON_TABLE: ReadonlyMap<string, ReasonToken>`（生の値 → token。ほとんどは同じ値、SDK の文 `"No matching payment requirements"`・`"Settlement failed"` だけ `sdk_no_matching_requirements`・`sdk_settlement_failed` に写す）。
- 節（このファイルに SVM の SDK の package 名は書かない。出どころは「x402 の SVM の実装 2.28.0」と書く）:

| 節 | 中身 | 出どころ |
|---|---|---|
| `x402_core` | `extension_echo_mismatch`・`unsupported_scheme`・`unsupported_payload_type`・`network_mismatch`・`duplicate_settlement`・`settlement_pending`・`invalid_transaction_state`・`post_settlement_transfer_not_confirmed`・SDK の 2 文 | `@x402/core` の dist |
| `x402_evm` | `var Err… = "…"` の全部（exact の EIP-3009・permit2・eip2612・erc20 approval・batch-settlement・upto） | `@x402/evm` の dist |
| `x402_svm` | 同上（`invalid_exact_svm_*` など）と `invalidReason:` の literal | SVM の dist |
| `circle` | `registration_required`・`settlement_pending` | `src/adapters/inbound/x402.ts:86-90,396`、`docs/multirail-design.md` §6 |
| `self_facilitator` | 識別・束縛の 21 個、`failure()` の code（`rpc_unavailable`・`authorization_used_unmatched`・`queue_full`・`queue_timeout`・`network_held`・`invalid_payment`・`verify_unavailable`・`malformed_request` ほか） | `tools/evm-facilitator.ts` |
| `provider_worker` | `payment_invalid`・`no_matching_requirements`・`facilitator_unavailable`・`facilitator_registration_required`・`data_unavailable`・`provider_busy`・`settle_failed`・`settlement_pending`・`receipt_malformed`・`internal`・`not_found`・`method_not_allowed`・`misconfigured` | `providers/x402-workers/src/*` |

- `classifyReason(raw)`: 欄が無い・`undefined`・`null` → `absent`。文字列でない・空 → `malformed`。`REASON_TABLE.get(raw)` → token、無ければ `unrecognized`。前方一致・部分一致・大文字小文字の読み替えはしない。
- **表の照合の試験**（`tests/unit/payment-reasons-pin.test.ts`）: SDK の 3 つの package の版が 2.28.0 であること。`dist/esm/*.mjs` から `var Err\w+ = "…"` と `(invalidReason|errorReason): "…"` を抜き出し、表の `x402_*` の節と **集合として等しい**。版を上げると落ちる（FR-R1）。`self_facilitator` は `tools/evm-facilitator.ts` の `fail("…")`・`failure(…, "…")` の literal と、`provider_worker` は Worker の `json(…, { error: "…" })` と同じ方法で等しさを確かめる。

## 8. 安全と受け入れ

### 8.1 SR-R1〜SR-R5 の根拠

| 要件 | 仕組み | 試験 |
|---|---|---|
| SR-R1 外の文字列を入れない | 記録の型が literal の union だけ、`validateDiagRecord` が実行時に行ごと拒む、理由は §7 の写像を通った token だけ、例外は分類だけで message は読まない | canary: facilitator の `invalidReason`・`invalidMessage`・`errorReason`・`errorMessage`、`PAYMENT-REQUIRED.error`、`PAYMENT-RESPONSE.errorReason`、本文の `error`、URL、例外の message に一意の文字列を入れ、ファイルの bytes に現れない。全部の行が検査を通る（`droppedSchema` = 0） |
| SR-R2 秘密を残さない | `paymentId`・`quoteId`（D-9）・hash・設定の id・tx hash だけ。ヘッダの値・authorization・署名・raw の tx・`ownerKey`・token・鍵は型の上で置き場が無い | canary（鍵の hex、token、`ownerKey`、署名、raw の nonce、raw の tx）がどのファイルにも無い |
| SR-R3 結果と通信を変えない | 記録は結果の後、`safeEmit` が全部の例外を握る、sink は同期で待たせない、本文の読み取りは返した後に切り離し sink が無効なら今の道のまま、core は返り値と例外をそのまま渡す | §8.2 |
| SR-R4 上限 | §2.2 の上限・回すこと・数えること | `diagnostics-sink.test.ts`: 各上限の境界、ENOSPC・EACCES・rename の失敗・遅い fs で `emit` が即座に返り throw せず、メモリが待ち行列の上限で止まる |
| SR-R5 公開しない | 0600・0700・ボリュームの中、読むのは `tools/diagnostics-read.ts` だけ、`src/http`・`src/mcp`・core は読まない | 静的な試験（`src/` に診断のファイルを読むコードが無い）、AC-R4 の wire |

### 8.2 「結果と外への要求の数が変わらない」の証明

1. **既存の試験を変えない**: R-2〜R-6 の PR は既存の試験の期待値を 1 行も変えない（足すだけ）。
2. **3 通りで比べる**（`tests/fixtures/diag-compare.ts`）: 同じ fixture の場面を (a) `diagnostics` 無し、(b) `recordingDiagnostics`、(c) `throwingDiagnostics` で動かし、adapter の返り値、fixture の要求の記録（method・path・回数・順序・本文の hash）、core の場面では journal の bytes（注入した時計と `nextPaymentId` のもとで）が 3 通りで deepEqual。場面は AC-R1 の全部の形。
3. **時間**: 断った応答の本文を 5 秒かけて流す fixture で、(b) の `pay()` が 100 ms 以内に返る。本文の読み取りは 250 ms で打ち切られ、門の枠は 300 ms 以内に返る。
4. **sink が壊れていても**: fs をすべての書き込みが失敗する・永遠に止まるものに差し替えても 2 と同じ。

### 8.3 受け入れと試験

| AC | 試験 |
|---|---|
| AC-R1 | 段ごとに期待する 1 行を固定し §8.2 の比較もする。受信（`x402`・`circle`・SVM）の verify・settle: 4xx・5xx・形の違う JSON・表にある・無い理由・欄なし・`upstream_timeout`・`connect_failed`・本文の読み取りの失敗・売り手証明の拒否。送信（動的 EVM・静的 Arc・静的 Base・SVM）: 同じ形 + 領収の 7 分類 × 2 つのヘッダ、402 の `PAYMENT-REQUIRED.error`、断った本文の `error`（大きすぎ・JSON でない・content-type 違い・遅い）、`not_sent` の各 code、challenge の 9 分類 |
| AC-R2 | file sink のパスを「書けない」・「上限を超える」・「壊れた行がある」にしても購入の結果と journal は (a) と同じ。core を作り直すと journal から同じ状態に戻り status も同じ |
| AC-R3 | 動的の verify の失敗（`isValid:false` と throw）で `budget.promote`・`store.append` を呼ばず、ledger は `recordAttempt` だけ、記録に `quoteId`・`requestHash`・`promoted:false`・`reason` |
| AC-R4 | `startHost`（受け入れの形、fixture の facilitator・上流）で失敗する購入のあと `<journal のディレクトリ>/diagnostics/router.ndjson` が 0600 で行を持つ。MCP の `status`・reopen の応答が sink の有無で byte 一致し、記録の鍵・表の版の文字列を含まない |
| AC-R5 | facilitator: fake の `ChainIo` が `HttpRequestError(429)`・`LimitExceededRpcError`・viem の `TimeoutError`・`DeadlineExceeded`・`RpcRequestError(-32000)` を投げると `rpc` の分類・`rpcHttpStatus`・`rpcCode`・`cid` が残り、応答は今と同じ。SDK の verify の理由が残る。鍵・token・raw の `key` が出ない。署名の道具: fake の RPC で `eth_sendRawTransaction` の後に receipt の待ちが時間切れ → 段 `pay_and_credential`・`broadcast:"accepted"`・`txRef`（`both`）。送る前の失敗 → `not_observed`。どちらも driver は `funds_possibly_moved` で止まり再署名を拒む |
| AC-R6 | 下の表の fixture（`tests/wire/rejection-incidents.test.ts`）。`tools/diagnostics-read.ts` で引いて期待する行が並ぶ |
| AC-R7 | §9.3 |

**AC-R6（出来事の表）**

| 出来事 | fixture | 残るもの | それでも分からないこと |
|---|---|---|---|
| x402.org の受信の拒否 | 受信の facilitator が settle に `200 {success:false, errorReason:"invalid_exact_evm_transaction_failed"}`、別の場面で知らない文字列、`429` | `source_settle`: `httpStatus`・`response:"success_false"`・`reason`・`elapsedMs`。core の `code:"source_rejected"` | x402.org の中の理由（表に無ければ `unrecognized`）、頻度制限か（429 を返したときだけ分かる） |
| Provider A の拒否 | 上流が支払いつきの要求に 402 + `PAYMENT-REQUIRED`（`error:"invalid_exact_evm_insufficient_balance"`）+ 本文 `{}` | `dest_pay_request`: `httpStatus:402`・`receipt:"absent"`・ヘッダの `reason`。`dest_reject_body`: `reason:"absent"`。`dest_outcome`: `destination_rejected` | Provider A の中（理由を返さなければ `absent`） |
| HyperEVM の Provider への 3.4 秒の `unknown` | 自前の Worker の形の上流が 502 `{error:"facilitator_unavailable"}`、fixture の facilitator が同じ authorization の verify で RPC 429 | Router: `httpStatus:502`・`receipt:"absent"`・本文の `reason:"facilitator_unavailable"`・`elapsedMs`・`cid`。facilitator: 同じ `cid` の `rpc:"rate_limited"` と `verify`。Worker が facilitator を呼ぶ前に失敗する場面では facilitator の行が無い | Worker の中、facilitator を呼ぶ前の失敗の理由 |
| Arc の Provider への 20 秒の `unknown` | 上流が headers を返さずに期限まで止まる。別の場面で 20 秒後に 502 `{error:"provider_busy"}` | `transport:"upstream_timeout"`（観測したときだけ）または `httpStatus` と本文の `reason`、`elapsedMs` | Circle の facilitator の中の段 |
| Tempo の署名の後の失敗 | fake の Tempo の RPC: `eth_sendRawTransaction` は成功、receipt の読み取りが 429 | driver: `stage:"sign"`・段 `pay_and_credential`・`broadcast:"accepted"`・`rpc:"rate_limited"`・`txRef`・`fundsMayHaveMoved:true` | RPC の中の理由 |

## 9. タスクと本番

### 9.1 タスク（実装の PR の単位）

- **R-1 共有の部品**: `src/shared/diagnostics.ts`、`diagnostics-file.ts`、`payment-reasons.ts` と照合の試験、`tests/fixtures/diagnostics.ts`。振る舞いの変更は無し。
- **R-2 Router の配線**（R-1 の後）: `RouterCapabilities.diagnostics`、`report` の包み、`createRouterCore` の option、core の 5 か所の scope と §4.1、`tools/remote-router-process.ts` の sink、`tools/remote-mcp.ts` の `SUBETHA_DIAGNOSTICS_PATH`・`SUBETHA_DIAGNOSTICS=off`。試験: AC-R2・AC-R3・AC-R4、stderr の byte 一致。
- **R-3 受信の adapter**（R-2 の後）: §4.2。試験: AC-R1 の受信、§8.2。
- **R-4 送信の adapter**（R-2 の後、R-3 と並べてよい）: §4.3。試験: AC-R1 の送信、§8.2 の時間。
- **R-5 facilitator**（R-1 の後）: §5 と入口の `EVM_FACILITATOR_DIAGNOSTICS`。試験: AC-R5 の facilitator、`cid` が Router と一致。
- **R-6 署名の道具と driver**（R-1 の後）: §6。試験: AC-R5 の signer、保留の回帰。
- **R-7 読む道具と出来事の表**（R-3〜R-6 の後）: `tools/diagnostics-read.ts`（`--payment <uuid> | --quote <0x…> | --cid <hex> | --request <principal>:<requestId>`、`--root /app/runtime`、`--file <path>`、`--json`。Router の行を引き、出た `paymentId`・`quoteId`・`cid` で 1 回だけ広げ、facilitator を `cid` で、driver を `paymentId`・`quoteId` で引いて `at` の順に並べる。読むだけ、4 KiB を超える行・検査を通らない行は数えるだけ）、AC-R6 の fixture、`docs/DEPLOY.md` §2h。
- **R-8 本番**（全部の後）: §9.2・§9.3。
- 各 PR: Codex のレビュー、macOS と Linux の試験、sabotage（hook を外す・`safeEmit` の catch を外すと試験が落ちる）。

### 9.2 本番への出し方

1. main のイメージを `deploy/swap-image.sh` で入れ替える（Q-2: 進行中の購入が無いこと — journal の末尾が終わった状態、`source_pending`・`destination_pending` で止まった支払いが無い、最後の attempt から 10 分）。終わったら owner に報告。
2. env の変更は要らない。止めるときは `SUBETHA_DIAGNOSTICS=off` を足して作り直すか前のイメージに戻す。ボリュームに残ったファイルは害が無い。
3. 確かめること: `/app/runtime/diagnostics`・`/app/runtime/evm-facilitator` の権限（0600・0700）、公開の一覧の byte 一致、`/healthz`、egress の check、子の stderr の行が今と同じ形。
4. `docs/DEPLOY.md` §2h 診断の記録: 置き場所、上限と回し方、読む道具のコマンド（`docker exec subetha-router node --import tsx tools/diagnostics-read.ts --payment <id>`）、運用者だけが読むこと、消してよいこと、止め方。

### 9.3 AC-R7（本番での確認。testnet の小額は owner の承認の範囲 2026-10-13）

- **(a) 資金が動かない**: Robinhood の USDG が 0 の新しい支払い手の鍵で `dyn-rh-to-x402` を quote・署名・purchase。昇格の前の verify で自前の facilitator が `invalid_exact_evm_insufficient_balance` を返し、Router は `awaiting_payment`（`verify_failed`）。読む道具で `quoteId` を引き、Router の `source_verify`（`reason`・`cid`）と facilitator の `verify`（同じ `cid`・同じ `reason`）が並ぶこと。
- **(b) 宛先の拒否（任意、owner の確認が要る）**: Worker の env を 1 つ足す（`rh-reject`。`PAY_TO` = facilitator の allowlist に無いアドレス）。facilitator が `recipient_not_allowed` で拒み、Worker が 402 `payment_invalid`、Router は `destination_rejected`（受信の 0.011 は動く）。Router の `dest_pay_request` と facilitator の `verify` が同じ `cid` で並ぶこと。しないなら宛先の側は AC-R6 の fixture だけで確かめる。
- 期限切れの quote だけにしない（facilitator を通らない）。

## 10. 未決・考えた代わりの案

- **Q-A `quoteId` を hash にするか**: 今の案はそのまま（D-9）。hash にすれば診断のファイルから authorization の nonce に戻れないが、読む道具が入力を hash する必要がある。
- **Q-B 本文の読み取り（D-5）**: 門の枠の返却が最大 250 ms 遅れる。許さないならヘッダだけ（HyperEVM の出来事の Worker の token は残らない）。別案: 自前の Worker の 502・503 に固定の token のヘッダ（例 `x-subetha-provider-error`）を足す（Worker の配備が要り、Provider A には効かない）。
- **Q-C MPP の adapter の中の理由**（D-7）: 後続。
- **Q-D facilitator の既存の log が `key`（nonce を含む）を出している**: この件では変えない。後で hash に替えるかは別の作業。
- **子の stderr を転送する案**（不採用）: 支払いと結びつかない（`TransportEvent` に id が無い）、自由な文の行が混じる、上限が無い。SR-R1・SR-R4 を満たせない。
- **journal に入れる案**（不採用）: 要件 §2。
- **明示の欄で結びつける案**: `InboundCallContext`・`TransportContext` に id を足す。型が見える利点はあるが、port の 3 つの型と約 20 か所の ctx の literal、`guardedRpcTransport` の getter を変え、MPP の transport まで届かせるのが重い。scope（D-2）は前例があり、試験で中と外を固定できる。
- **OpenTelemetry などの外部の仕組み**（不採用）: 依存が増え、自由な属性を防ぐ仕組みが無い。
- **残す期間**: 自動では消さない（回すことで上限）。運用者が消してよい。
