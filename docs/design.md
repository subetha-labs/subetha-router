# SubEtha Router 設計 v1（docs/requirements.md v1 に対する設計）

本書は設計フェーズの成果物。実装コード・タスク分解・実行証拠は含まない。最初に貫通させるのは要件 §3 の
P1（SubEtha 受信 → Router → x402 Provider A）で、**P2（同一受信口 → MPP Provider B）も v1 スコープ**として
§10 に具体的マイルストーンを置く。D-03 で後回しにするのは P3–P5 のみ。

## 1. 最小垂直経路（v1 の 1 本）

```
client ──HTTP──▶ Router 公開契約 ──▶ core（intent + 追記 journal + 予算）
                                   ├─ InboundRail(subetha) … 402 offer 発行 / verify / settle
                                   └─ OutboundRail          … x402(A) quote/pay ▸ Provider A
                                                              mpp(B)  challenge/charge ▸ Provider B（P2）
                                     いずれも GET /v1/eth/snapshot（canonical、クエリ無し）
```

core は rail 名で分岐しない。両 rail はポート（TypeScript interface）越しにのみ触れ、無課金テストでは
同じ interface の代替実装を注入する。代替実装による実行は **synthetic** とラベルし実決済ゲートの証拠に
しない（AC-3）。ポートは永久の合成足場ではなく、§10 のスライスで実 SDK 配線に到達させる。

## 2. レイヤと責務

`http/`＝公開契約・認可・canonical ガード・公開射影（支払い SDK を知らない）、`core/`＝intent 状態機械・
write-ahead journal・予算・ロック・重複抑止（rail 固有スキーマを知らない）、`adapters/`＝各レールの wire
契約（相手レグの金額・予算に触れない）、`config/`＝allowlist・上限・パス（秘密を出力しない）。

## 3. Router 公開契約（新規提案。既存 chat の支援 API とは別物）

canonical リソース識別子は **上流 URL ではなく Router 側の識別子**。`routeId`（例 `md-a-eth-snapshot`）が
allowlist の key で、上流 URL は設定にのみ存在し外部に出さない。Router canonical resource URL は
`http://127.0.0.1:8500/v1/routes/{routeId}/resource`（既定）。ホストは `ROUTER_CANONICAL_BASE_URL` で固定し
リクエスト `Host` から導かない（A/B の canonical guard と同方針）。クエリ不可、`GET` 以外は 405。

| # | メソッド/パス | 認可 | 役割 |
|---|---|---|---|
| R1 | `GET /v1/routes` | principal | allowlist の `routeId`・canonical URL・資産メタのみ。上流 URL は返さない |
| R2 | `POST /v1/quotes` | principal | `{routeId, requestId}` → 上流 quote を先に取得し、受信 offer を発行して `quoteId` を確定 |
| R3 | `GET /v1/routes/{routeId}/resource` | principal + `quoteId` + 承認 | 購入実行。曖昧さを残さない（下記） |
| R4 | `GET /v1/purchases/{paymentId}` | 所有 principal | status と結果の**公開射影**（§7） |

R2 のレスポンス（`quoteId` = 受信 offer の idempotency key）:

```jsonc
{ "quoteId":"0x…64hex", "routeId":"md-a-eth-snapshot", "resource":{"url":"<Router canonical URL>","method":"GET"},
  "source":{"rail":"subetha","amount":"<wire>","asset":"0x…","decimals":6,"network":"eip155:<id>","payTo":"0x…","expiresAt":0,"offer":{/* 発行 offer 全体 */}},
  "destination":{"rail":"x402"|"mpp","quoted":"<wire>","asset":"0x…","decimals":6,"network":"eip155:84532","quoteFingerprint":"sha256:…"},
  "approval":{"required":true,"boundTo":"<quoteId>","deadlineMs":0} }
```

R3 の購入成功は `200` + 上流 JSON をそのまま body とし（改変しない）、支払いメタは R4 側に置く。配信不能で
終わった場合は状態に応じた 4xx/5xx と `paymentId` を返し、R4 で確定状態を読む。

**R3 の必須入力（1 つでも欠落・不一致なら 4xx。推測で補わない）**

1. principal 認証ヘッダ 2 本: `X-Router-Principal: <principalId>` と HTTP 認証ヘッダ
   `Authorization`（`Bearer` スキーム + 設定 allowlist に登録済みの principal トークン）。
2. `X-Router-Quote-Id`: R2 が返した `quoteId`。パス・金額・直近履歴からは推定しない。
3. `X-Router-Request-Id`: クライアント生成、principal 内一意。
4. `X-Router-Approval: <quoteId>`: 承認。`X-Router-Quote-Id` と一致しなければ開始しない。
5. 受信レールの支払い資格情報（§4.1）。

`quoteId` の**所有**は R2 時点の principal に durable に紐付き、他 principal は開始も参照もできない。
**`(principal, requestId)` → `quoteId` は R2 で確定し不変**。同じ `(principal, requestId)` で R2 を再呼び出し
した場合、要求内容が同一なら既存 `quoteId` をそのまま返し、`routeId` 等が異なれば `409 request_id_conflict`
として**新しい quote を作らない**。R3 での同一 `(principal, requestId)` 再送も新規購入を作らず、既存
`paymentId` の現在状態を返す。トークンは journal・応答・ログに出さない。

資格情報なしの `GET /v1/routes/{routeId}/resource` は、`X-Router-Quote-Id` があればその quote の 402 offer を
再提示し、なければ `402` + 「R2 で quote を取得せよ」という指示（`quoteUrl` と `routeId` のみ）を返す。
**どちらの場合も新しい quote・intent・課金対象の孤児レコードを作らない。**

## 4. 束縛順序（destination quote → 承認 → source settle → outbound）

1. R2 で **先に上流 A を quote**（402 の純粋読取、無課金／FR-06）し、`destination.quoted/asset/network` と
   `quoteFingerprint = sha256(stable-json(上流 offer))` を確定してから、受信 offer を発行する。
2. 受信 offer は `quoteId`・`routeId`・Router canonical URL に束縛し、発行内容を丸ごと保持する。
3. R3 受理時、journal 生成の**前に** strict preflight：nonce 既知・未失効・route 束縛一致・発行 offer と
   拡張フィールド込みの完全一致（キー順非依存の安定 JSON 比較）。preflight を持たない inbound adapter では
   有料ライフサイクルを開始しない（fail closed／FR-04）。
4. **受信 settle を開始する前に、上流の現在の offer を読み直して承認済み `selectedOffer` と照合する**
   （純粋読取・無課金）。一致しない、または読み直しに失敗した場合は **どちらのレグも実行しない**：
   受信 settle を呼ばず、`quoteId` を失効させ、`409 offer_changed` として R2 からの新しい quote と
   新しい明示承認を要求する。この時点では課金が一切起きていないので `paid_undelivered` にはしない
   （FR-05「変更時はいずれのレグも開始しない」）。
5. 照合成功後に、レール実契約に従う **verify → 成功時のみ settle**（FR-06b）。verify 省略不可。
6. 受信レグ成功後に限り outbound を実行する。
7. outbound は送金直前に**もう一度**上流の現在の challenge を読み直し（手順 4 の後に起きた変更＝レース
   対策として維持する二段目の検査）、承認済み `selectedOffer` と照合したうえで、
   **SDK が実際に支払おうとしている要求を署名前に照合**する（§4.2）。凍結した accepts をそのまま使って
   古い offer に支払うことはしない。指紋一致だけでも不十分。
8. 手順 7 の照合に失敗した（＝受信成立後に上流の提示が変わった）場合は支払わない。受信レグは成立済みな
   ので終了状態 `paid_undelivered`（理由 `quote_changed`）を記録し、再課金も「もう一度購入してください」も
   出さない。手順 4 の失敗（未課金）とは別の終端であり、混同しない。

金額は受信・送信で**別フィールド**。受信額は Router 自身の見積り（`ROUTER_SOURCE_PRICE_<routeId>`。v1 は
ローカル設定の固定値で、上流額から導出しない＝U-03 の設計決定）を権威、送信額は上流 offer を権威とし、
生の数値をコピーしない。FX・ブリッジ・流動性は行わず、各レールのウォレットは事前資金供給（prefunded）。

### 4.1 SubEtha 受信レールの wire 契約（PoC の inbound adapter と demo 合成から確定。コードは複製しない）

フィールド名は既読の許可済みソース（`src/adapters/inbound/subetha.ts`、`demo/router.ts`）から確定する。
設定は facilitator base URL 1 本（`ROUTER_SUBETHA_FACILITATOR_URL`）のみで、いずれも素の JSON over HTTP。

- `POST {base}/challenge` req `{amount}` → res `{payTo, amount(10進文字列), token(0x20byte),
  chainId(数値), challengeNonce(0x+64hex), expiresAt(unix 秒), helper?, deadline?, fee?{amount,bps}}`。
  `helper` と `deadline` は**両方あるか両方ないか**。不整合・型違反は offer を発行しない。
- Router が発行する offer: `{scheme:"subetha-zerc20", network:"eip155:<chainId>", asset:token, amount,
  payTo, maxTimeoutSeconds, extra:{challengeNonce, expiresAt, routeBinding, helper?, deadline?, fee?}}`。
  `routeBinding` は `encodeURIComponent` した `routeId|GET|<canonical path>` を `|` 連結した 1 本の文字列。
  U-02 の「nonce・失効・リソース束縛」の実フィールドは `extra.challengeNonce` / `extra.expiresAt` /
  `extra.routeBinding`、idempotency key は `challengeNonce`（＝ Router の `quoteId`）。
- 支払い資格情報（payer→Router）: `{x402Version:2, accepted:<offer 全体>, payload:{challengeNonce, …}}`。
  `payload.challengeNonce` が `quoteId` と一致しない、`accepted.scheme` が `subetha-zerc20` でない、
  `accepted` が発行 offer と完全一致しない、のいずれでも settle しない。
- `POST {base}/verify` と `POST {base}/settle` は同一 body `{x402Version:2, paymentPayload,
  paymentRequirements}`。verify res `{isValid:boolean}`、settle res `{success, transaction, network,
  extra?{phase:"pending"|"accepted"}}`。`isValid!==true` で settle に進まない（FR-06b）。
  settle の 5xx・ネットワーク断・`extra.phase==="pending"` は `unknown`（4xx は `rejected`）。
  `network` が発行 offer の `network` と異なる応答は不正として扱う。

よって **受信レールの HTTP 統合は `@subetha/*` パッケージの公開を待たない**。Router は受信側（検証者）で
あり署名しないため、scheme クライアント SDK を必要としない。private facilitator を依存として取り込まず、
コードも複製しない。未確定として残るのは**実行時の値と権限**（facilitator の実 URL、資産・チェーン、
settle 再呼び出しの安全条件）だけで、これらは別ゲート（§12 U-01r）。

### 4.2 送金前に何を照合するか（実 API は M4 で固定する）

x402 クライアントは 402 文書の `accepts[]` から自分で 1 件選んで署名する。**インストール済み SDK が
「署名前の選択結果」を公開しているかは未検証であり、返ると仮定して設計しない。** 満たすべき不変条件と、
それを実現する 2 通りの受け皿を先に決め、どちらを採るかは M4 で実 API を確認してから固定する。

不変条件: (a) 支払う相手・金額・資産・ネットワークは、承認された `selectedOffer` と field 単位で一致する。
(b) 送金の瞬間に上流が提示している challenge も同じ内容である。(c) 1 件上限と該当バケットの残枠（§5）を
満たす。(d) いずれかを満たさなければ署名も送信もしない（`not_sent`）。(e) SDK 側の自動支払いリトライ
（402 を受けて再度支払う挙動）は無効化する。自動再送は行わない。

1. R2 で上流 402 を読み、`accepts[]` から設定の許容 `scheme/network/asset/payTo` 集合に一致する最初の 1 件を
   `destination.selectedOffer` として丸ごと永続化する（`quoteFingerprint = sha256(stable-json(...))`）。
   一致 0 件なら quote 失敗（推測で選ばない）。
2. 送金直前に上流 challenge を読み直し、現在の `accepts[]` に `selectedOffer` と完全一致する要素が
   あることを確認する。凍結した accepts を SDK に渡すだけでは古い offer に払い得るので、これを必須とする。
3. 受け皿 A: SDK が payment-requirement の**セレクタ/フックまたは明示的な payload 生成 API**を公開して
   いる場合、それを使って「これから署名する要求」を取り出し、(a)–(c) を検査してから署名させる。
   受け皿 B: 公開していない場合、payload 生成と署名・送信を Router 側の **guarded signer/send ポート**に
   分け、そのポート内で (a)–(c) を最終検査してから初めて署名鍵と送信を呼ぶ。
   M4 で実 API 名・シグネチャを確認し、どちらかに確定して本節に追記する（発明しない）。
4. 送金後に上流から返る支払い応答（`PAYMENT-RESPONSE` 等）は evidence として journal に残す。

本フェーズでは**ウォレットにも鍵にも触れず、署名も送金も行わない**。上記は M4/M6 の実装契約であり、
実行は B-01 解除後のゲート。

#### 4.2a 受け皿の確定（T2 / M4。インストール済み `2.27.0` の実 API を実物で確認した結果）

**受け皿 A を採り、受け皿 B を最終段として併用する**（どちらか一方では足りない）。確認した公開 API は
`@x402/fetch` が再輸出する `x402Client` / `x402HTTPClient`（実体は `@x402/core/client`）と
`@x402/evm` の `ExactEvmScheme` / `ClientEvmSigner`、および `@x402/core/http` の
`encodePaymentRequiredHeader` / `decodePaymentSignatureHeader` / `decodePaymentResponseHeader`。

- **明示的 payload 生成**: `x402Client.createPaymentPayload(paymentRequired)`（`x402HTTPClient` にも同名の
  委譲がある）。返る `PaymentPayload.accepted` が **SDK が選んだ requirements そのもの**なので、送信前に
  承認値と照合できる。
- **セレクタ**: `new x402Client(selector)` の `SelectPaymentRequirements = (x402Version, requirements[]) => requirements`。
  Router は承認済み 1 件だけを渡し、件数と field 一致を検査する。
- **署名前フック**: `client.onBeforePaymentCreation(ctx => …)` は scheme の署名より**先**に走り、
  `{abort:true, reason}` で生成を止められる（`ctx.selectedRequirements` / `ctx.paymentRequired.resource.url` を検査）。
- **SDK 側支出ガード**: `client.setSpendControls({maxAmountPerPayment:false, allowedAssets:[{network, asset,
  maxAmountPerPayment: 承認額}]})`。既定の USD キャップではなく承認額そのものに縛る。
- **受け皿 B（最終段）**: `ExactEvmScheme(signer)` の `signer` は `ClientEvmSigner`（`address` +
  `signTypedData`）だけを要求する狭い境界なので、Router はそこを guarded signer で包む。EIP-3009 既定経路では
  `primaryType:"TransferWithAuthorization"`・`domain.chainId`・`domain.verifyingContract`・`message.to` /
  `from` / `value` を承認値（viem `getAddress` 正規化後）と照合し、外れたら注入された署名能力を呼ばない。
  T2 で確認したのは EIP-3009 経路のみで、`permit2` 等は fail closed。
- **wire は v2**: 402 の `PAYMENT-REQUIRED`、支払い要求の `PAYMENT-SIGNATURE`、応答の `PAYMENT-RESPONSE`
  （`X-PAYMENT-RESPONSE` も読む）。`wrapFetchWithPayment` は**使わない**（402 受信後の自動再支払いを避け、
  1 要求につき payload 生成 1 回・送信 1 回）。`x402HTTPClient.processResponse` は hook を発火しないため
  自動再送が起きない。
- **応答の解釈**: `success===true` かつ `network` が承認済み値、`transaction` が非空で、レシートが `payer` を
  名乗る場合は注入された署名者と一致して初めて `paid`。HTTP 200 だけでは支払いの証拠にしない。JSON 本文を
  実際に取得できなければ、決済証跡を保持したまま「支払い済み・データ未取得」として終端する（再送しない）。
- **未知フィールド**: SDK の zod は accepts の未知トップレベル欄を落とすため、Router は `PAYMENT-REQUIRED`
  を**生の JSON としても**読み、未知欄まで含めた完全一致で再照合する（SDK 側の件数・必須欄と突き合わせる）。

実行条件: 署名能力は**起動時にコードから注入**されたものだけを使い、構成ファイル・env からは読み込まない
（任意のプラグイン読み込みを許さない）。素の CLI（`ROUTER_ADAPTER_MODE=real`）は能力が無ければ
`signer_not_authorized` で起動を中止し、合成レールへは落ちない。T2 の実行証拠は**非署名 spy + loopback
fixture**による `T2-fixture-nopay` ラベルに限られ、実鍵・実署名・実決済・finality（B-01 / U-01r / U-04 /
U-05）は未解除のゲートのまま。

## 5. journal と状態（単一プロセス・追記専用）

`ROUTER_JOURNAL_PATH`（既定 `runtime/journal.ndjson`。`runtime/` は既に `.gitignore` 済みで提出物に
含めない＝U-08 の設計決定）に NDJSON 追記。各行は `{seq, at, paymentId, event, patch}`。
**append + fsync が完了してから**メモリ表を更新する（write-ahead）。

**単一 writer と破損末尾**: `runtime/journal.lock` は**常設ファイル**として open（無ければ作成）し、
その fd に対し **OS の非ブロッキング排他ロック**をプロセス生存中ずっと保持する。取得できなければ起動しない
（同一 journal に 2 プロセスは書かない）。`O_EXCL` の「作成できたら勝ち」方式は採らない——異常終了で残った
ファイルが恒久的な偽の排他になるため。ロックファイルは**削除しない**（削除は競合の原因）。ロックは
Node 標準に無いので、Node/macOS/Linux で動作する最小限の OS ロックライブラリを採用してよく、採否は
§8 の版検証に含める。replay は `seq` の連番と各行の JSON 妥当性を検査し、**末尾行が途中で切れている場合のみ**「未適用の書き込み」とみなす。自動切り詰めも自動補完もせず、
**fail closed**：オフセットを添えて起動を中止し、運用者の判断を待つ（自動復旧基盤は作らない／D-01）。

内部状態と要件 FR-13 の公開値の対応:

| 内部（journal） | 公開 status | 意味 |
|---|---|---|
| `created` / `source_pending` | `awaiting_payment` | 受信レグ未完。`source_pending` は settle 送出前の write-ahead |
| `source_settled` / `destination_pending` / `destination_submitted` | `paid` | 受信済み・配信未確定。`destination_*` は送出前後の write-ahead |
| `delivered` | `delivered` | 上流応答を durable 化済み |
| `paid_undelivered` | `paid_data_unavailable` | 課金成立・データなし（B の 502、`quote_changed` 等） |
| `unknown` | `unknown` | 送金有無不明。人の判断で解決 |
| `source_failed`（受信レグの `rejected` / `not_sent` / `failed`） | `awaiting_payment` | 受信決済が成立していない。課金は起きていない |
| `dest_failed`（送信レグの `not_sent` / `rejected` / `failed`） | `paid_data_unavailable` | 受信済み・送信確定失敗。§FR-12 と同じ終端 |

**失敗はレグ別に保持する**（一律の `rejected`/`not_sent`/`failed` を持たない）。`awaiting_payment` に写像
できるのは受信 settle 成立**前**の失敗だけで、**受信成立後に `awaiting_payment` へ戻すことはない**。
送信レグの確定失敗（`not_sent` / `rejected` / `failed`）は公開 `paid_data_unavailable` へ写像し、
受信証跡（`source.evidence`・settle transaction）と `terminalReason`、および送信側の分類
（`destination.outcome` = どれで終わったか）を durable に保持する。
`receiptRef` は上流が実際に課金レシートを返したときだけ記録し、送信未実行（`not_sent`）や拒否
（`rejected`）では記録しない——**B が課金したという偽の主張を作らない**。したがって公開
`paid_data_unavailable` は「受信は課金済み」の意味であり、送信側が課金済みか否かは
`destination.outcome` と `receiptRef` の有無で区別する。

- `destination_pending` は **write-ahead 予約**。`(paymentId, attempt)` を確定・fsync してから送出する。
  attempt の繰り上げで再送抑止を回避しない（D-02）。
- 例外・タイムアウト・不明応答は必ず `unknown`。自動再試行・自動再支払い・自動返金・自動照合をしない
  （FR-11/D-01）。受信レグ settle の再呼び出しは、実契約で安全と確認できた条件下でのみ許可し、未確認なら
  禁止して `unknown` を保持する（FR-14/14b）。
- **replay で `source_pending` / `destination_pending` / `destination_submitted` のまま終わっている記録は、
  一律 `unknown` に確定する**。`destination_pending` は送出**前**に fsync されるが、その直後・送出中の
  クラッシュと区別できない以上「未送出」を証明しない。よって `not_sent` は、送出せずに終わったことを
  記録した行がある場合にのみ確定する。いずれの場合も自動再送・自動再 settle はしない。
- 再起動の原則: **確定済み終了状態（`delivered` / `paid_undelivered` / `unknown` / `source_failed` /
  `dest_failed`）は再起動で変化しない**（AC-8）。`not_sent` / `rejected` / `failed` は終了状態名ではなく
  `destination.outcome`（および受信側の対応フィールド）というレグ内の分類値であり、`dest_failed` などの
  終了状態に添えて保持する。唯一の例外が上記——中断された pending を保守的に `unknown` へ確定する処理で
  あり、これは曖昧な途中状態の解消であって終了状態の書き換えではない。
- 結果の耐久化順序: 上流応答 body・contentType・両レグ evidence・所有 principal を journal に書いて
  fsync した**後に** R3 のレスポンスを返す。応答途中のクラッシュでも R4 が同じ結果を返せる。

**予算はプロセス全体で 1 つ、ただし資産ごとにバケットを分ける**: budget レジャー
（`budget_reserved` / `budget_settled` / `budget_unknown`）は同じ journal に書き、全 principal・全購入を通算
する。金額の通算は **`(network, asset)` ごとのバケット**単位で行い、**異なる資産の生の数値を足し合わせない**
（例: SubEtha 受信側の資産と Base Sepolia USDC と Tempo pathUSD は別枠。FX 換算もしない）。
件数上限だけは全体で 1 本の通算カウンタ。予約は core 内の**単一 mutex 下で、「件数枠 + 受信側バケット +
送信側バケットの残枠検査 → 予約行の append+fsync」を 1 つの不可分な操作**として行い、これが成功しない限り
**受信レグの settle を開始しない**（支払いが始まってから枠不足が判明する順序にしない）。上限は起動時
replay で復元され、**再起動をまたいで通算**される。取った予約は `unknown` で終わっても支出済みとして
該当バケットの枠を消費したまま、自動解放しない（FR-09）。予約は受信 verify の成立後・settle の直前に取るので、
**予約より前の失敗や中断（verify の不成立・応答なし・その間の期限切れ・再起動）は枠を消費しない**。

**再起動と並行性**: 起動時 replay で表を再構築し、status は再起動前と同一値で読める（AC-8）。`quoteId`
単位の mutex で直列化し、同一 `quoteId` に既存 intent があれば新規ライフサイクルを開始せず現在状態を返す。
異なる `quoteId` は独立した購入として並行実行できる（結果も個別）が、**予算枠だけは上記の通り共有**する。
`(paymentId, attempt)` の重複送出は replay 後も抑止される。

## 6. 現行 chat との統合（将来の境界付き adapter、再実装しない）

`apps/chat-demo/server.mts` の公開シームは `/api/quote`・`/api/status`・`/api/approve` で、これらは
`ChatExecutionFactory` の `proposal / quote / validateApproval / approve / status` に委譲される。
`direct-v1-execution.mts` の提案引数は `{sourceId, revision, options:{maxCharacters}}` の **article 形**で、
`status()` は `text`（UTF-8 本文）を返す。

不整合点（観測事実）: Router の成果物は文字数上限を持つ記事本文ではなく、`providerId / market /
dataSource / payment / fetchedAt / data` を持つ snapshot JSON エンベロープであり、`sourceId` ではなく
`routeId` で識別される。したがって **article 型への cast や擬似 article の合成は行わない**。統合は chat 側に
`ChatExecutionFactory` の実装（market-data profile）を 1 つ足す形で、`quoteId` を R2 から取り、`approve` を
R3 に、`status()` を R4 の公開射影に写像する。Router 側は AC-7 が求める束縛（承認は `quoteId` に束縛、
未承認・拒否・対象変更時は無支払い）と再オープン時の同一 `paymentId` 読み出しのみを提供する。
chat 側の実行ホールドは本リポジトリで再試行しない（U-07 未確定は設計全体の停止要因ではない）。

## 7. 公開射影とアクセス保護

R4 が返すのは固定の射影のみ: `paymentId / routeId / status`（§5 の公開値）`/ source{amount,asset,
network,txRef?} / destination{quoted,asset,network,attempt,outcome,txRef?,receiptRef?} /
quoteFingerprint / terminalReason / updatedAt`、および `delivered` のとき `result`（上流 JSON）。

- `destination.outcome` は**常に含める**固定フィールドで、送信レグがどう終わったかを表す
  （`none`（未着手）/ `not_sent` / `rejected` / `failed` / `unknown` / `paid`）。
- `receiptRef` は**上流が実際にレシートを返したときにのみ**現れる任意フィールド。`paid_data_unavailable`
  でも同じ規則で、B が課金してレシートを返した場合のみ含み、`outcome` が `not_sent` / `rejected` の
  ときは含めない。**レシート不在を「課金されたが不明」と読ませない。**
- したがって「受信は成立したが送信は未実行」は `status=paid_data_unavailable` かつ
  `destination.outcome="not_sent"` かつ `receiptRef` なしで表され、B が実際に課金した場合
  （`outcome="paid"` + `receiptRef` あり）と公開射影の上で区別できる。
- `paid_data_unavailable` では `result` を返さず、`terminalReason` と上記フィールドを返す。

journal の生レコード、上流 URL、principal トークン、内部ヘッダ、例外文字列は返さない。R4 は
**所有 principal のみ**が読める（所有は §5 の通り durable）。未認証の全件ダンプ用 admin エンドポイントは
作らない。返金・再照合基盤も作らない（D-01）。

## 8. 依存候補（実ソースから確認した版。推測・最新化はしない）

| 依存 | 候補版 | 根拠 |
|---|---|---|
| Node | `>=22.12.0` | providers `package.json` engines |
| TypeScript / tsx | `5.9.3` / `4.23.15` | 同上 devDependencies |
| vitest | providers 表記 `5.0.1`、PoC 表記 `^2.1.0` | 二者で乖離。採用前に実在版を確認 |
| `@x402/core`, `@x402/evm` | `2.27.0` | providers が実使用（A の x402 wiring） |
| `@x402/fetch`（送信側） | PoC は `2.17.0`。`2.27.0` の実在は未確認 | 送信クライアントとして必要。版整合の確認対象 |
| `viem` | `2.54.0` | providers 実使用（PoC は `^2.21.0`） |
| HTTP サーバ | `hono 4.12.25` + `@hono/node-server 2.1.1`、または `node:http` のみ | providers 実使用。Router は依存を減らすなら `node:http` で足りる |
| `mppx` | `0.11.0` | P2（B）の支払い側で必要。B の provider 側が実使用している版 |
| SubEtha 受信レール | **追加依存なし**（`fetch` + 標準ライブラリ） | §4.1 の素の JSON HTTP 契約で足りる |

`@subetha/facilitator` / `@subetha/provider` / `@subetha/x402-scheme` は PoC で **`link:` 依存**であり、
クリーンな再現セットアップには使えない。ただし本 Router は受信側で署名しないため、これらを必要としない
（§4.1）。**SDK の公開有無は受信レール HTTP 統合の阻害要因ではない**。公式 `@zerc20/sdk` / BUSL ソースは
vendoring も再配布もせず、private facilitator も依存として取り込まない。

**インストール前に検証する項目**: (a) `@x402/*` の 2.27.0 系に `@x402/fetch` が存在するか、(b) `vitest` の
採用版（providers 表記と PoC 表記が乖離）、(c) `mppx` 0.11.0 の**支払い側**エントリポイントの有無、
(d) 上記が同一 `viem`/`@x402/core` 版グラフで解決するか。**ソースからの発見は互換性の検証ではない**。

## 9. 同一チェーン送信 vs 別ネットワークの事前資金供給

- **案 A（同一チェーン）**: 受信・送信を同一 EVM チェーンに寄せる。ウォレット供給が 1 系統で済み、
  観測も単純。ただし A の canonical 支払い面は Base Sepolia `eip155:84532` USDC で固定であり、
  受信面を同一チェーンに寄せられるかは U-01r の実設定次第。
- **案 B（別ネットワーク・各レール prefunded／採用）**: 受信は SubEtha の実チェーン、送信は Base Sepolia を
  それぞれ独立に事前資金供給する。2 レグは交換ではなく独立支払いという要件 §1 と一致し、B（Tempo）拡張も
  同型で足りる。コストは残高監視が 2 系統になること。
- いずれも **LayerZero 等のクロスチェーン前提を要求しない**。ブリッジ・FX は設計に入れない。

## 10. 実装スライス（数個の実行可能なマイルストーン）

1. **M1 core 単体（無課金）**: config/allowlist、offer 完全一致検査、単位保持、上限、journal 追記と replay。→ AC-1
2. **M2 HTTP 契約（無課金・TCP）**: R1–R4、canonical/クエリ/非 GET/allowlist 外/別レール資格の拒否、
   principal 認可、公開射影。上流はローカルスタブ。→ AC-2
3. **M3 縦貫（synthetic）**: 両 rail 代替実装で R2→R3→R4 を通し、`delivered` / `paid_undelivered` /
   `unknown` の 3 終端、および再起動後の status 不変を確認。→ AC-3 / AC-8（synthetic ラベル付き）
4. **M4 送信レグ A の実 SDK 配線**: まず `@x402/fetch` + `@x402/evm` の**インストール済み API を実物で確認**し、
   §4.2 の受け皿 A（セレクタ/フック・payload 生成 API）か受け皿 B（guarded signer/send ポート）かを確定して
   §4.2 に追記する。そのうえで送金直前の再読み取り照合・予算検査・自動支払いリトライ無効化を実コードで
   通す。署名・送金そのものは B-01 解除後のゲート。→ AC-5 の前提
5. **M5 受信レグ実配線**: §4.1 の契約でローカル facilitator スタブに対し challenge/verify/settle を接続し、
   実 URL・実資産が与えられた時点で設定値だけを差し替える。→ AC-4 の前提
6. **M6 P2（Provider B / MPP）**: outbound に mpp adapter を追加。B の 402 challenge（mppx の scope は
   `"GET <canonical snapshot URL>"`）を読み、`mppx` 支払い側で 1 回だけ charge する。課金成立後に
   **`502 paid_data_unavailable`** が返った場合は、レシート参照を evidence として journal に記録し、公開
   status を `paid_data_unavailable` にして終了する（自動返金・自動再購入・自動リトライなし／FR-12）。
   正常系はレシート付きで Uniswap v3 参照価格の JSON をクライアントへ返す。→ AC-6 / AC-6b の前提

M4–M6 は「いつまでも合成足場のまま」にしないための必須スライスとして固定する。

## 11. テストマトリクス（境界付き。すべて無課金で到達可能な範囲）

| ID | 対象 | 種別 | ゲート |
|---|---|---|---|
| T-01 | offer 完全一致・nonce/失効/route 束縛の拒否理由 | unit | AC-1 |
| T-02 | 受信/送信の資産・小数桁が混ざらない（コピー禁止） | unit | AC-1 |
| T-03 | 1 件上限・全購入通算の累計上限・`unknown` の枠保持・並行予約の不可分性 | unit | AC-1 |
| T-04 | journal replay で公開 status 同値、attempt 重複抑止、末尾破損で fail closed、二重 writer 拒否 | unit | AC-1/AC-8 |
| T-04b | `source_pending` / `destination_submitted` のまま再起動 → `unknown` 確定、再送なし | unit | AC-1/AC-8 |
| T-05 | 402 形、クエリ付き・非 GET・allowlist 外・別レール資格の拒否 | wire | AC-2 |
| T-06 | `quoteId`/`approval`/principal/資格情報の欠落・不一致で R3 拒否、他 principal から R4 不可 | wire | AC-2 |
| T-06b | 射影に秘密・上流 URL・生 journal が出ない。admin ダンプが存在しない | wire | AC-2 |
| T-07 | 正常縦貫（synthetic）→ `delivered` と上流形 JSON の受領 | wire | AC-3 |
| T-08 | SDK 選択 offer が `selectedOffer` と不一致 → 署名前に中止（送金なし）／settle 後なら `paid_data_unavailable` | wire | AC-3 |
| T-09 | pay 例外/タイムアウト → `unknown`、自動再送なし | wire | AC-3 |
| T-10 | 同一 `quoteId`（および同一 `requestId`）並行 2 要求で購入 1 回、別 `quoteId` は独立 2 購入 | wire | AC-3 |
| T-11 | 応答直前クラッシュ後の再起動で R4 が同一 status と結果を返す | wire | AC-8 |
| T-12 | B スタブが課金後 `502 paid_data_unavailable` → `paid_data_unavailable` 終了・レシート記録・再購入なし | wire | AC-6b の前段（synthetic） |

## 12. 未解決入力（設計時点）

| ID | 内容 | 種別 |
|---|---|---|
| ~~U-01/U-02~~ | wire スキーマ・フィールド名・verify/settle 契約 | **解決済**（§4.1、既読ソースから確定） |
| ~~U-03~~ | 受信額の権威 | **設計決定**: ローカル設定の固定値（§4） |
| ~~U-08~~ | journal 保存先・同梱可否 | **設計決定**: `runtime/journal.ndjson`、git 非追跡（§5） |
| U-01r | SubEtha facilitator の実 URL・実資産/チェーン、settle 再呼び出しが安全な条件 | 実行時の値・権限（owner） |
| U-04 | 送信ウォレットの実在・資金供給元・上限値 | 実行時の権限（owner／B-01） |
| U-05 | A の x402 facilitator 設定値、B の Tempo RPC・支払い側設定 | 実行時の値（設定/秘密は読まない） |
| U-06 | A/B の現在の有効・`setup-disabled` 状態と価格確定値 | 実行時の値（README は stale） |
| U-07 | chat の market-data profile 受け入れ可否と結果保存形式 | owner（chat は別セッション所有） |
| U-09 | `@x402/fetch` 2.27.0 系の実在、vitest 採用版、`mppx` 支払い側 API | ソースから確認可能（§8） |
| U-10 | A/B の canonical base URL 既定値の設定キー名 | ソースから確認可能 |

## 13. 近い将来に作るソースファイル（M1–M3、および M6 で 1 本追加）

`src/config.ts` / `src/core/intent.ts` / `src/core/journal.ts`（単一 writer ロック・破損末尾検査を含む）/
`src/core/store.ts` / `src/core/budget.ts`（全購入通算の単一レジャー）/ `src/core/orchestrator.ts` /
`src/ports/inbound.ts` / `src/ports/outbound.ts` / `src/adapters/inbound/subetha.ts` /
`src/adapters/outbound/x402.ts` /（M6）`src/adapters/outbound/mpp.ts` / `src/http/app.ts` /
`src/http/projection.ts` / `src/http/auth.ts` / `tests/unit/*` / `tests/wire/*`。

旧 PoC からの流用は「新規実装＋出典記録」に限る。流用候補は概念（write-ahead、strict preflight、
安定 JSON 比較、rail 名で分岐しない core）であり、断片を写す場合は出典
`subetha-payment-router`（Apache-2.0、dirty な作業ツリー・凍結された技術検証）と改変点をファイル冒頭に
記録する。PoC の過去の E2E 報告は本提出物の合格証拠ではない。

## 14. 本設計で解除していないゲート

実決済（AC-4/AC-5/AC-6）、鍵・ウォレット・署名（B-01）、chat 接続（B-03）、A/B の fresh な paid
readiness（B-05）、remote/push（B-04）はいずれも未解除。SubEtha の実ランタイム値（U-01r）と支払い権限は
**pending であって設計全体の停止要因ではない**——M1–M3 と、§4.1/§4.2 の契約に対する M4–M6 の無課金部分は
進行できる。本書に E2E 成功の主張は含まれず、ソースからの発見は互換性の検証ではない。
