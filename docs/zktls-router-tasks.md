# zkTLS 秘匿要求 Router（private purchase）タスク分解 v1.1

要件 `docs/zktls-router-requirements.md` v3.3、設計 `docs/zktls-router-design.md` v5.1（Codex 5 回のレビューで APPROVE WITH CHANGES、修正済み）に基づく。
v1 の Codex レビュー（`.claude_workflow/local/zktls-tasks-review1.md`、APPROVE WITH CHANGES、7 件）を v1.1 に反映した（末尾の対応表）。
worktree `subetha-router/zktls-router-20261020`（branch `task/zktls-router`）。各タスクは「変更するファイル / 受入（テスト）/ 依存」を持つ。owner のゲート（実送金・配備・push）は含まない。
作業規律: 既存の口・journal・config golden は byte 単位で不変（各タスクの受入に `npm test` の既存部分を含める）。秘匿値・credential 値の扱いは下の canary の行列に従う。
**状態の表記**: T-Z1・T-Z2 は実装済みだが、受入の証跡（`npm test` の実行ログ）と中間レビューを経るまで「完了」としない。

| # | タスク | 変更 | 受入 | 依存 |
|---|---|---|---|---|
| T-Z0 | 基線の記録 | `.claude_workflow/state.json`（基線: `npm ci --ignore-scripts` + `npm rebuild fs-ext`、vitest 3319 passed / 8 failed（macOS 固有）、`npm run types` は `packages/payer` の既存 2 件） | 既存テストの失敗一覧を固定し、以後の比較に使う | — |
| T-Z1 | 契約の純関数（実装済み・受入待ち）: intent・release・最終注文・期待 prefix・attest 検査 | `src/private/intent.ts`（`parseIntent`、`finalOrderOf`、`finalOrderBytesOf`、`headerFileOf`）、`src/private/release.ts`（`releaseBytesOf`、`parseReleaseBytes`）、`src/private/attest.ts`（`expectedPrefixOf`、`requestLengthBoundOf`、`validatePaymentHeader`、`parseRecvHeaders`、`parseVerifierRecord`、`parseBundlePublic`、`checkBundleBinding`、`checkAttest`） | `tests/unit/private-intent.test.ts`（compact・重複鍵・各欄・port≠443・path ≤ 256 B・GET/POST・outbound/inbound の必須欄・lab の golden）、`tests/unit/private-attest.test.ts`（lab 記録の golden: `revealed_prefix`/`len_sent`（GET 1176、POST 1718+39+4+88=1849）、各欄のすり替えで fail closed、`revealed_recv_headers` の解析、ヘッダ値の構文・2048/3072、別購入の bundle の束縛） | — |
| T-Z2 | 状態・journal・store（実装済み・受入待ち） | `src/core/intent.ts`（新状態・`IntentPrivate`・公開状態）、`src/core/store.ts`（`privateFieldsOf`、reduce の private 行、`#issuedIntents`/`#consumedInbound`、`reservePrivateIssuance`、`#resolveInterrupted`、`upstreamMatchesBinding` の `private\|`、`source_settled` の `eventId`）、`src/core/orchestrator.ts`（`SAFE_REASONS`、`privateProjectionOf`、静的 `deliver` の門）、`src/http/projection.ts`（`private` の通過） | `tests/unit/private-store.test.ts`（復元の明示性・`privateInvalid` の各条件; `reservePrivateIssuance` は**独立の 4 ケース**: (a) 同じ intent・別の受信支払い → collision、(b) 別の正しい intent・同じ受信支払い → collision、(c) (a)(b) を再起動の後にも、(d) journal の append の失敗を注入 → `unavailable` で集合に入らず、以後の自動再試行が無い; `#resolveInterrupted` の 4 区分、reduce の outcome、既存 journal の replay が不変） | T-Z1 |
| T-Z3 | 私的送信 adapter 面 | 新規 `src/ports/private-outbound.ts`、`src/adapters/outbound/private-x402.ts`（`discover`/`issueCredential`（`signX402PaymentOnly`）/`checkReceipt`）、`src/adapters/outbound/private-mpp.ts`（pull 専用・RPC 読取の allowlist・Attribution 付き calldata の等値・独立検査）。既存 `x402-dynamic.ts`（`createX402ChallengeReader`・`signX402PaymentOnly` の切り出し。`pay` の挙動は不変）、`mpp-dynamic.ts`（`checkDynamicMppChallenge` の `{mode, method}`、`ApprovedTransfer.expectedData`、guard 群の export）、`src/ports/inbound.ts` + `src/adapters/inbound/x402.ts`（`SettleResult.eventId`） | `tests/unit/private-x402-issue.test.ts`（transport spy: `fetch` 0 回、署名 1 回、`validBefore`、payload の `accepted` 一致、deadline 拒否、別の offer は `destination_offer_changed`; 領収: `success`・network・bytes32・payer = 署名者の各ケース）、`tests/unit/private-mpp-issue.test.ts`（偽 RPC で pinned SDK の実際の credential 生成を通し、呼ばれた RPC メソッドの集合を記録して**すべてが `PRIVATE_RPC_READ_METHODS` に含まれる**ことを assert; 送出・署名・`wallet_*`・未知のメソッドは別ケースで例外; 署名 1 回・放送 0 回; envelope 検査の各欄のすり替え（chainId・calls・to・data（Attribution memo の等値）・value・feeToken・nonceKey・validBefore・手数料・sponsored・非正準）; pull-only challenge は候補、push-only は候補外、`feePayer: true` は候補外、scope `POST …`; 領収: `reference` が発行時の envelope の keccak と一致するときだけ ok、`status`/`method`/`payer` の違いは不一致）、既存 `x402-dynamic-outbound`/`mpp-dynamic-outbound` の wire が不変 | T-Z1 |
| T-Z4a | Verifier ランナー（起動手順・監督） | 新規 `src/private/verifier.ts`（起動門・固定 wrapper（pid 公開 → 門 → exec）・`serve` は新しい addr-file を `sessionBy` の内側で待ち、`verify` は addr を見ず `verifyTimeoutMs` で完了を待つ・SIGTERM → 猶予 → SIGKILL と `exit` の待ち・`ps -o command=` による同一性・pid ファイルの tmp/空/不一致の扱い・umask 077・子出力の上限） | `tests/unit/private-verifier.test.ts`（偽バイナリ = Node スクリプト: 期待引数と env、pid ファイルが exec の前に存在、`serve` は addr を待ち `verify` は待たない、`verifyTimeoutMs` 超過で kill と exit の待ち、出力ファイルが 0600、stdout/stderr が上限で切れる、門を外すと wrapper は exec しない、pid ファイルが壊れていれば「確認できない」を返す） | T-Z1 |
| T-Z4b | 容量 | 新規 `src/core/private-capacity.ts`（`reserve`/`release`/`sessionEnded`/`attestSettled`/`retire`、検証ジョブの枠、再構成） | `tests/unit/private-capacity.test.ts`（新規予約を含む不等式、`reserve` の失敗は mkdir せず、`sessionEnded` はセッション枠だけ返す、`attestSettled` は record 以外を全部消した後にだけ縮める、掃除の失敗は予約を保つ、再構成は record のバイト数と件数、再構成前の `reserve` は失敗） | — |
| T-Z4c | private core（quote・送信レグ・session・attest・record・再構成）と dynamic の引数化 | 新規 `src/core/private.ts`、`src/core/dynamic.ts`（`private` 依存の注入: `outbound(intent)`・`reserveCapacity`・`deliver`、`source_settled` の `eventId`、private の指紋）、`src/core/orchestrator.ts`（`private` option・dispatch・`currentOutcome`） | `tests/unit/private-core.test.ts`（合成 rail + 偽バイナリ: 全経路 quote → purchase → session → attest → record; 容量の拒否は受信 verify/settle の**前**（verify 0 回）; 再照合失敗・`eventId` 無し → `paid_undelivered`（未発行、容量解放・ディレクトリ削除）; 予約後の各失敗 → `unknown`（outcome unknown、理由コード）; 期限の検査 3 回（起動前・addr 後・応答前）; 別購入の bundle → 409 `attest_foreign` で状態・ファイル・検証の枠が不変; 同じ digest の再送は耐久結果、進行中の同じ digest は合流（検証 1 回）、別 digest は 409; 受理時に期限内なら実行が `attestBy` を過ぎても検証; 期限タイマと検証の競合; 遅い record・回収の record は取得できるが attest 不可; 保持期限は再起動で延びない; 壊れた record（sha 不一致）は返さない; 門の列挙・取り消しの失敗や確認できない pid で掃除も受付も止まる; canary の行列（下）; 既存 `dynamic-core` の試験が不変） | T-Z2, T-Z3, T-Z4a, T-Z4b |
| T-Z5 | 設定と合成 | `src/config.ts`（`router.private` の parse・検査、`RouterConfig.private`、`privateAuthoritativeTermsOf`）、`src/main.ts`（`privateRails`、`privateTrustForTest`、`privateHooksForTest`/`launchHooksForTest`、`createRouterCore` への配線、`dependencyUrls`） | `tests/unit/private-config.test.ts`（各欄・profiles の両レグ検査・loopback・hash 不一致 → `ConfigError`）、`tests/unit/config-golden.test.ts` 不変、`tests/unit/compose-rails.test.ts` に private の合成（trust は test 能力のみ、実入口は渡さない: 静的検査） | T-Z4c |
| T-Z6 | HTTP・client・MCP | `src/http/app.ts`（4 経路・写像・attest の本文上限）、`src/http/projection.ts`（`privateQuoteBody`（resource = `POST <base>/v1/private/purchases`）・`projectionBody` の `private`）、`src/client/{index,types}.ts`（`privateQuoteViewOf`・`privateBindingOf`・4 操作）、`src/mcp/{tools,server}.ts`（4 ツール・説明文・schema） | `tests/wire/private-http.test.ts`（合成 rail + 偽バイナリで 4 経路・状態コード・所有者違い 404・サイズ上限 413・既存経路の不変）、`tests/unit/private-client.test.ts`（`privateQuoteViewOf`: 必須欄の欠落で quote と扱わない、`upstream` 無しで通る; `privateBindingOf`: `ownerKey`・policy・limits・disclosures・resource・source/destination・pricing・approval のそれぞれを 1 欄ずつ変えた quote は `resource_mismatch` で**購入要求 0 回**; `allowUnissuedQuotes` の意味）、`tests/unit/mcp-private.test.ts`（承認対象の欄・nextStep; purchase は `releasedHeader`・`headerFile`・`releaseB64` を**返す**（Payer のファイル契約）が、quote・status の応答と `nextStep` の文面に credential 値が無い） | T-Z4c |
| T-Z7 | wire（lab の実バイナリ・fixture CA・Router 子プロセス・MCP） | 新規 `tests/fixtures/private/zktls-provider.ts`（x402 Provider fixture: TLS 1.2 `ECDHE-RSA-AES128-GCM-SHA256`・fixture 証明書・`POST /select`・`GET /v1/paid-snapshot`・identity framing ≤ 704 B）、`tests/fixtures/private/lab.ts`（`SUBETHA_ZKTLS_LAB_DIR` の解決・skip 判定・Payer 側コマンド・封筒の組み立て）、新規 `tests/fixtures/private/router-private-process.ts`（実 `startRouter` + fixture 能力 + `privateHooksForTest`/`launchHooksForTest`）、新規 `tests/wire/private-x402.test.ts` | lab があれば: HTTP と MCP の全経路（quote → purchase → finalize → session → prove → attest → record ×2 → decrypt → 平文の検証 → status）、否定ケース一式（設計 §11）、Router 子の kill と再起動（予約後・release 後・起動門後・spawn 直後・handover 後・record 公開後・attest 受理後・結果永続化前・棚卸し中）、wrapper の 3 段の境界（`serve` と `verify` の両方、到着を確認してから Router を殺し、再起動が門を外して棚卸しを終えた後に解放、「exec しない」または「終了させられた」と遅れたバイナリ出力が無いこと、公開と exec の間で wrapper 自身を殺す場合）、生き残った Verifier の終了と record の回収、canary の行列。無ければ skip（skip は「未検証」と記録し、合格と書かない。実行ログを `.claude_workflow/local/` に残す） | T-Z5, T-Z6 |
| T-Z8 | 受入の雛形（owner ゲート） | `tests/acceptance/private-live.test.ts`（`PRIVATE_LIVE_AC=1`。Provider C/F/A/B。実行は owner）、`tools/private-payer.ts`（Payer 側の手順: 封筒 → quote → sign → purchase → finalize → session → prove → attest → record → decrypt）、`docs/zktls-router-acceptance.md`（手順・鍵の扱い・証跡の置き場・ゲート） | 雛形はローカルでは skip（skip は「未検証」と記録し、合格と書かない）。**静的検査**で雛形と手順書が TR-3 を覆うことを確かめる: 実合成（`src/main.ts`、`real`）、C/F の POST と A/B の GET、実行前の支払い範囲の記録、受信決済・送信決済・秘匿配送・Payer 復号/受領・finality を**別々の証跡**として記録する欄。**実送金は owner の承認後**（AGENTS.md）。ローカルの実装完了と owner 実行の受入を区別して報告する | T-Z7 |
| T-Z9 | 文書・状態・最終レビュー | `docs/zktls-router-design.md` の実装との差分の追記、`README`/`docs/` の索引、`.claude_workflow/state.json`、Codex 最終レビュー（全 diff）と指摘の修正、ローカル commit（push しない） | `npm test`（基線の 8 件以外が全部通る）、`npm run types`（基線の 2 件以外）、golden 不変、レビュー APPROVE | T-Z0〜T-Z8 |

## canary の行列（面ごと。T-Z4c・T-Z6・T-Z7 が同じ表で検査する）
| 値 | Router のどの成果物にも無い | 許される場所 |
|---|---|---|
| 要求本文・応答本文の平文、本文の salt、隠し穴の nonce、Payer の鍵、復号鍵 | **すべて**（journal・射影・診断・stderr・作業ディレクトリ・子の出力・テストの出力） | 無し（Payer の executor だけが持つ）|
| 送信 credential の値（bearer） | journal・状態の射影・診断・一般ログ・テストの出力 | 作業ディレクトリの `order_final.json`（0600、attest 完了で削除）・`record.json`（0600、保持期限まで）、認証済みの purchase の応答（`releasedHeader`・`headerFile`）、認証済みの record の応答 |
| intent のバイト列（`intentB64`） | 公開の射影・診断・一般ログ | 権威の保管（控え・journal の `created`）、Verifier の入力 `intent.json`、認証済みの record の応答（`releaseB64` と組） |
| 受信 credential（署名） | journal（既存どおり digest のみ）・射影・診断 | 受信 adapter が facilitator に送る要求だけ |
検査は値の部分文字列の走査（`JSON.stringify` した成果物と作業ディレクトリ・子出力の全ファイル）に加え、ファイルの mode（dir 0700、file 0600）と削除の時点（attest 完了・保持期限）を assert する。

## 設計の節 → タスク → 試験の対応
| 設計 | タスク | 試験（名前）| 期待 |
|---|---|---|---|
| §2 公開契約・§2.1 承認対象・§2.2 応答 | T-Z6 | `private-http.test.ts`、`mcp-private.test.ts` | 4 経路の状態コード、`private` 欄の全欄、`headerFile`/`releaseB64` |
| §3.0 dispatch・§3.1 quote | T-Z4c | `private-core.test.ts` quote 群 | `private_disabled`/`unknown_route`/`invalid_intent`/`intent_mismatch`、控えの記録の形、指紋 |
| §3.2 purchase（受信レグ共有・送信レグ） | T-Z4c | `private-core.test.ts` purchase 群 | 容量 → preflight → 再照合 → 予約 → 発行 → ヘッダ → 寿命 → release(sessionBy) → 起動 → handover、各失敗の終端 |
| §3.3 session・record の資格・耐久化 | T-Z4a/T-Z4c | `private-verifier.test.ts`、`private-core.test.ts` session 群 | `sessionBy` の watchdog、`fsync` → journal、遅い record は `late` |
| §3.4 attest | T-Z4c | `private-core.test.ts` attest 群 | 受付手順の各分岐、`attest_foreign` は不変、合流、受理時の期限 |
| §3.5 record の取得・保持 | T-Z4c/T-Z6 | `private-core.test.ts`、`private-http.test.ts` | 何度でも取得、期限で 410、壊れた record は 500 |
| §3.6 再起動 | T-Z4c/T-Z7 | `private-core.test.ts` recovery 群、`private-x402.test.ts` crash 群 | 門の取り消し → 棚卸し → 終端 → 回収 → 掃除 → 再構成 |
| §3.7 容量 | T-Z4b | `private-capacity.test.ts` | 不等式・解放の時点・再構成 |
| §4 ランナー | T-Z4a/T-Z7 | `private-verifier.test.ts`、wrapper の境界 | 起動手順・監督・同一性 |
| §5 契約 | T-Z1 | `private-intent.test.ts`、`private-attest.test.ts` | golden と各欄のすり替え |
| §6 adapter 面 | T-Z3 | `private-x402-issue.test.ts`、`private-mpp-issue.test.ts` | fetch 0 / 放送 0 / RPC allowlist / 領収 |
| §7 journal・状態・射影 | T-Z2 | `private-store.test.ts` | 復元・一意性・reduce・再起動 |
| §8 HTTP/client/MCP | T-Z6 | `private-http.test.ts`、`private-client.test.ts`、`mcp-private.test.ts` | 束縛と資源の照合 |
| §9 設定・合成 | T-Z5 | `private-config.test.ts`、`compose-rails.test.ts`、`config-golden.test.ts` | `ConfigError` の各条件、golden 不変 |
| §11 wire・受入 | T-Z7/T-Z8 | `private-x402.test.ts`、`private-live.test.ts`（owner） | HTTP と MCP の全経路、否定ケース、crash、synthetic の表示 |

## レビューの門
- Codex（`gpt-6-astra`、`codex exec --sandbox read-only`）: 本文書（v1.1）、T-Z4c の後、T-Z7 の後、最終（全 diff）の 4 回。各レビューの指摘は**解決してから**依存するタスクに進む。
  レビューの出力と、レビューした版（ファイルの sha256）を `.claude_workflow/local/zktls-impl-review*.md` に残す。途中で止まった・時間切れのレビューは承認ではない。
- fixture trust（`lab-fixture-ca`）で得た wire の証跡は「synthetic」と表示し、lab が無い環境の skip は「未検証」と報告する（合格ではない）。
- 実送金（Provider C/F/A/B）は owner のゲート。本フェーズでは**実行しない**。

## v1 → v1.1（Codex タスクレビュー 1 回目）
| 指摘 | 対応 |
|---|---|
| 1 canary の規則 | canary の行列（面ごと・許される場所・mode と削除の時点）|
| 2 client の束縛の試験 | T-Z6 `private-client.test.ts` |
| 3 Tempo の RPC の試験 | T-Z3（実際の呼び出し集合が allowlist に含まれること、領収のケース）|
| 4 T-Z4 の分割と具体化 | T-Z4a/b/c、T-Z7 の crash の assert |
| 5 一意性の独立した試験 | T-Z2（4 ケース）、実装済みタスクの表記 |
| 6 対応表と門 | 設計の節 → タスク → 試験、レビューの門 |
| 7 受入の証跡 | T-Z8（静的検査、別々の証跡、未検証の表記）|

## 実施の記録（2026-10-20）
| タスク | 状態 | 証跡 |
|---|---|---|
| T-Z0〜T-Z4c | 済（commit 80e134c） | `tests/unit/private-*.test.ts`、Codex 実装レビュー 1 回目（REJECT → 全指摘を修正、2 回目で確認）|
| T-Z5・T-Z6 | 済（commit f088e70） | `private-config`・`private-http`・`private-client`・`mcp-private` |
| T-Z7 | 済（commit e385c53 + レビュー 2 回目の拡張） | `tests/wire/private-x402.test.ts`: lab 実バイナリで全件 pass（HTTP/GET/MCP 全経路、payer ツール、否定、改変・期限、停止点の kill、wrapper の段、record/attest の途中の kill）。証跡は synthetic（fixture CA）。実行ログは `.claude_workflow/local/zktls-wire-run*.log`（git 管理外）|
| T-Z8 | 雛形 済・**実送金 済（C/A/B 成立、F は Provider 側の 500 で未成立。設計 §14.6）** | `tools/private-payer.ts`、`tests/acceptance/private-live.test.ts`（lab 無し・gate 無しでは skip = 未検証）、`docs/zktls-router-acceptance.md` |
| T-Z9 | 文書 済。Codex 最終レビュー 1 回目（REJECT、4 件）→ 対応（§14.1）→ 2 回目（REJECT、3 件）→ 対応（§14.2）→ 3 回目（REJECT、should 2 件）→ 対応（§14.3）→ 4 回目（APPROVE WITH CHANGES、試験の補強 2 件）→ 対応（§14.4）→ 5 回目 **APPROVE**（nit 1 件反映、§14.5） | `docs/zktls-router-design.md` §14〜§14.4、`.claude_workflow/local/zktls-impl-review{3,4,5,6}.md` |

wire で見つかった実合成の不具合 3 件（受信 rail の解決、verify の check 文字列、MCP の出力 schema）は設計 §14 に記録した。
