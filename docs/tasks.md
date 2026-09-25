# SubEtha Router タスク分解 v1（docs/design.md v1 に対するタスク化）

本書はタスクフェーズの成果物。コード・実行結果・合格主張は含まない。要件 d74c0ad と設計 00292c9（design-review-v1 +
v2/v3 訂正を反映、LGTM）を入力とし、前フェーズのやり直しはしない。T1→T4 の順で各タスクは有限かつ実行可能な単位。
記載のコマンドは**計画であり未実行**。

## 0. 全タスク共通規約

- **担当分離**: 親（controller）が state/lock/commit を所有し、ソース読み戻し後に安定ロック下でテストを実際に実行する。
  writer は worker 起動・state 更新・commit/push をしない。reviewer は read-only で実ソースを見て範囲限定の判定を返す。
- **TDD**: 各タスクはまず失敗する振る舞いテストを書き、赤を確認してから実装する。テストなしの実装着手をしない。
- **完了コマンド**: 各タスクに focused（当該テスト）／neighbor（近接既存テスト）／types（`tsc --noEmit`）／build を記す。親が実行し出力を証拠として保存する。`docs` の検証はランタイムテストではない。コマンドは**ローカルにインストール済みの script（`npm run …`）か `npx --no-install`** を使い、暗黙の未ピン留めダウンロードを起こさない。
- **依存**: 追加前に実在版とパッケージメタデータを検証（設計 §8 の (a)–(d)）。検証できない版は入れず、推測版に置き換えない。汎用フレームワークを足さない。受信レールは追加依存なし（`fetch` + 標準ライブラリ）。公式 `@zerc20/sdk` / BUSL ソースを vendoring しない。依存を変更するタスクは `package-lock.json` を allowed file set に含め、ロック差分も証拠とする。
- **流用**: 旧 PoC 断片を写す場合のみファイル冒頭に出典 `subetha-payment-router`（Apache-2.0）と改変点を記録する。
  概念参照は流用ではない。過去の E2E 報告を合格証拠にしない。
- **テスト範囲**: すべて無課金 loopback で独立に完結。既存ウォレット・鍵の読み取り、署名、ブロードキャスト、faucet、有料 API 呼び出しをしない。chat 側の native/proof/SQL 実行ホールドを本リポジトリに引き継がない。
- **SDK ガードの検証方法**: 送金前ガードのテストは**署名しない spy**（呼び出し引数を記録し、ラベル付き synthetic fixture を返す代替）で行う。**実秘密鍵・実鍵素材・暗号署名は決して使わない。** spy の記録は wire 証拠であり実決済証拠ではない。
- **synthetic ラベル**: 代替実装・fixture を注入した実行は `synthetic（合成・無課金）` と明記し AC-4/5/6 の証拠にしない。
  **SDK の import／typecheck が通ることは実決済ではない。**
- **commit**: 一貫して検証済みのスライス単位で、当該タスクの allowed file set に限ったパスを親が明示指定して commit する。
- **停止条件**: 実際のクォータ、所有権衝突、安全性（重複/誤支払い・秘密露出・未許可権限）、当該タスクの正当な完了のみ。
  タスク完了は次タスクへ継続する。

## 1. T1 — Router コア縦貫（M1–M3 統合、synthetic、無課金）

- **目的**: 実 Node プロセス・実 TCP のライフサイクルを耐久コアの上で 1 本通す。M1/M2/M3 を分割せず 1 タスクとする。
- **allowed file set**: `package.json` / `package-lock.json` / `tsconfig.json` / `vitest.config.ts` / `README.md` /
`src/main.ts` / `src/config.ts` / `src/core/{intent,journal,store,budget,orchestrator}.ts` /
`src/ports/{inbound,outbound}.ts` / `src/http/{app,auth,projection}.ts` / `src/adapters/inbound/subetha.ts` /
`src/adapters/outbound/x402.ts` / `tests/unit/*` / `tests/wire/*` / `tests/fixtures/*` / `.gitignore`。
他ツリー・他 worktree を編集しない。
- **consumer / caller / input / output**: caller は別プロセスのテストクライアント（HTTP）。input は R1–R4 のリクエスト
（principal 2 ヘッダ・`X-Router-Quote-Id`・`X-Router-Request-Id`・`X-Router-Approval`・受信資格情報）。output は R2 の
quote 文書、R3 の上流 JSON body、R4 の公開射影、`runtime/journal.ndjson`。上流と各レールの相手側は**別プロセスの合成
fixture**（`tests/fixtures/*`）で、これは**テスト基盤であり新規 Provider ではない**。

**満たす振る舞い（先に失敗テストを書く）**:
- 耐久コア: NDJSON write-ahead（append+fsync 後にメモリ更新）、常設 `runtime/journal.lock` の非ブロッキング OS 排他（二重 writer 起動拒否、ロックファイルを削除しない）、replay の `seq` 連番・JSON 妥当性検査、末尾破損は fail closed（オフセット付きで起動中止、自動切り詰めなし）。
- 束縛: principal 所有・`(principal, requestId)`→`quoteId` 不変・`409 request_id_conflict`・承認は `quoteId` に束縛。未承認／拒否／対象 offer・経路・金額の変更時はいずれのレグも開始しない。資格情報なしの R3 は孤児レコードを作らない。
- strict preflight: nonce 既知・未失効・`routeBinding` 一致・発行 offer と拡張フィールド込みの完全一致（キー順非依存の安定 JSON 比較）を journal 生成**前**に行い、preflight 不在 adapter は fail closed。
- 予算: `(network, asset)` バケット別累計と全体件数カウンタを、単一 mutex 下で「残枠検査 → 予約行 append+fsync」として不可分に実行し、成功前に受信 settle を開始しない。異資産の生数値を足さない。`unknown` は枠を保持し自動解放しない。
- 重複抑止: 再起動をまたいで同一 `(paymentId, attempt)` を**両レグとも**再送しない。attempt 繰り上げで抑止を回避しない。
- `unknown` 保持: 例外・タイムアウト・不明応答、および replay 時に `source_pending` / `destination_pending` /
  `destination_submitted` のまま終わった記録は `unknown` に確定。自動再送・自動再 settle・自動返金をしない。
- 結果所有: 上流 body・contentType・両レグ evidence・所有 principal を fsync した**後に** R3 応答を返し、再起動後も
  R4 が同一 status と同一結果を返す。
- wire 拒否: クエリ付き・非 GET（405）・allowlist 外・別レール資格情報・他 principal からの R4 読み取り。射影に秘密・
  トークン・上流 URL・生 journal を出さず、admin ダンプを作らない。
- 3 終端: `delivered` / `paid_data_unavailable`（`quote_changed` 含む）/ `unknown`。
- 起動合成: `src/main.ts` が実 Node CLI エントリポイントとして config 読み込み・journal ロック取得・adapter 合成・HTTP listen を行う。**合成実装を本番既定にしない**——fixture/代替 adapter は明示設定でのみ選択でき、既定構成では実 adapter を解決し、未設定なら synthetic に落とさず fail closed で起動を中止する。
- 再現性: `README.md` に Node 版・インストール・起動・検証コマンド（本タスクの完了コマンド）を記載し、クリーンな環境から AC-1/AC-2/AC-3 を再実行できる手順に限定する（S-01）。

- **内部分割（再計画不要。author 実行単位のみ）**: T1a = config・journal・store・budget・intent の耐久コアと `tests/unit/*`（T-01〜T-04b）。T1a は**実行可能なコアテストに必要な範囲で `src/ports/*` と `src/core/orchestrator.ts` を定義してよい**（ポート定義は HTTP 配線ではない）。T1b = adapters 合成実装・`src/main.ts`・`src/http/*` の接続と `tests/wire/*`（T-05〜T-11）。T1a 完了後に T1b を同一タスク内で続行し、フェーズを再定義しない。
- **依存**: なし（基点）。追加は Node `>=22.12.0`、TypeScript/tsx/vitest、`@types/node`、および**最小限の OS ロックライブラリ**のみ。Node 標準に `flock` 相当がなく設計 §5 が OS 排他を必須としているため 1 本だけ採る。採用前に (1) 実在版・(2) `package.json` メタデータ（ライセンス・`engines`・依存グラフ・ネイティブビルド有無）・(3) macOS/Linux + Node 22 での対応・(4) 二重 writer 拒否の実挙動を実テストで確認し、確認できなければ入れずに親へ報告する。`@types/node` と vitest も採用版を実在確認してから入れる（§8 (b)）。HTTP は `node:http` を既定とし、不要なら hono を採らない。
- **完了コマンド（計画・未実行）**: focused `npm run test -- tests/unit tests/wire`（または `npx --no-install vitest run tests/unit tests/wire`）/ neighbor（新規ツリーのため focused と同一）/ types `npx --no-install tsc --noEmit` / build `npx --no-install tsc -p tsconfig.json`。
- **ゲートと証拠ラベル**: AC-1 / AC-2 / AC-3 / AC-8、および README 手順での AC-9、ラベル `T1-synthetic-nopay`。AC-4 / AC-5 / AC-6 は未達成と明記する。

## 2. T2 — 送信レグ A（x402）実 API 配線 + 受信レグ HTTP 配線（M4/M5、無課金）

- **目的**: 合成足場のまま止めないため実 SDK と実 HTTP 契約に接続する。**実決済は別ゲートのまま**。
- **allowed file set**: `src/adapters/outbound/x402.ts` / `src/adapters/inbound/subetha.ts` / `src/config.ts` /
`src/ports/outbound.ts` / `src/main.ts`（実 adapter の登録・構成のみ）/ `package.json` / `package-lock.json` /
`tests/wire/*` / `tests/fixtures/*` / `docs/design.md`（§4.2 の受け皿確定の追記のみ）。
- **CLI 構成への配線**: `src/main.ts` で実 x402 outbound adapter と実 SubEtha inbound adapter を登録し、T3 と同一の
別プロセス caller（CLI 起動 → R2→R3→R4）で縦貫を確認する。adapter 単体テストの合格だけで完了としない。テストは
無署名・無課金のままで、相手は x402 fixture と facilitator fixture（`synthetic` ラベル）。
- **consumer / caller / input / output**: outbound の caller は orchestrator、相手は**ローカル x402 fixture**。inbound の
caller は Router 受信 adapter で、相手は**ローカル facilitator fixture**（設計 §4.1 の素の JSON HTTP: `/challenge`・
`/verify`・`/settle`）。input は `selectedOffer`・発行 offer・支払い資格情報、output は送金前照合の可否判定（`not_sent`
を含む）と `{isValid}` / `{success, transaction, network, extra?}` の解釈結果。

**満たす振る舞い（先に失敗テストを書く）**:
- **インストール済みの公式 `@x402/fetch` + `@x402/evm` の実 API を実物で確認**し、設計 §4.2 の受け皿 A（セレクタ/フック・
  明示的 payload 生成 API）か受け皿 B（guarded signer/send ポート）かを確定して §4.2 に追記する（発明しない）。
- 送金直前に上流 challenge を読み直し、現在の `accepts[]` に `selectedOffer` と完全一致する要素があることを確認する。
  凍結 accepts をそのまま渡さない。相手・金額・資産・ネットワークを field 単位で承認済み値と照合し、1 件上限と該当
  バケット残枠も満たしてから初めて署名側を呼ぶ。1 つでも外れたら署名も送信もしない（`not_sent`）。
- SDK の自動支払いリトライ（402 受信後の再支払い挙動）を無効化する。
- 受信レール: `helper`/`deadline` の片側欠落や型違反で offer を発行しない。`isValid!==true` で settle に進まない。
  settle の 5xx・ネットワーク断・`extra.phase==="pending"` は `unknown`、4xx は `rejected`、`network` 不一致応答は不正。
  settle 再呼び出しは安全条件が確認できた範囲でのみ許可し、未確認なら禁止する。
- 実 URL・実資産は**設定値の差し替えだけ**で到達できる形にする。

- **依存**: T1 完了。`@x402/fetch` / `@x402/evm` / `@x402/core` / `viem` は §8 の候補版をインストール前に実在確認し、同一
グラフで解決することを確かめてから追加する。解決できなければ停止して親に報告する。
- **完了コマンド（計画・未実行）**: focused `npx --no-install vitest run tests/wire/x402-outbound.test.ts
tests/wire/subetha-inbound.test.ts` / neighbor `npx --no-install vitest run tests/unit` / types
`npx --no-install tsc --noEmit` / build `npx --no-install tsc -p tsconfig.json`。
- **ゲートと証拠ラベル**: AC-5 / AC-4 の**前提**のみ、ラベル `T2-fixture-nopay`。実送信元・実送信先の決済
（B-01 / U-01r / U-04 / U-05）は別途ゲートで未解除。

## 3. T3 — 送信レグ B（MPP / Provider B）（M6、無課金）

- **allowed file set**: `src/adapters/outbound/mpp.ts` / `src/main.ts`（mpp adapter の登録・構成のみ）/ `src/config.ts` /
`src/ports/outbound.ts` / `package.json` / `package-lock.json` / `tests/wire/*` / `tests/fixtures/*`。
Provider B 本体は読み取り専用参照で編集しない。
- **consumer / caller / input / output**: caller は CLI（`src/main.ts`）で起動した Router プロセスに対する**別プロセスの
テストクライアント**で、経路は T1/T2 と**同一の受信口**（R2→R3→R4、rail 名で分岐しない同一ポート経由）。相手は**ローカル B
fixture**。input は B の 402 challenge（`mppx` の scope は `"GET <canonical snapshot URL>"`）、output は正常系のレシート付き
上流 JSON（Uniswap v3 参照価格の形）と、課金後失敗時の R4 終了状態。

**満たす振る舞い（先に失敗テストを書く）**:
- `mppx` の支払い側 API を実物で確認し、**1 回だけ** charge する。自動リトライをしない。
- **CLI 構成への登録**: `src/main.ts` で mpp adapter を outbound として登録し、`routeId` の allowlist から B 経路を解決できるようにする（T1 の「合成実装を本番既定にしない／未設定は fail closed」を維持）。adapter 単体テストの合格をもって P2 到達と主張しない。
- **縦貫確認（無署名・無課金・別プロセス）**: CLI 起動 → 同一受信口 R2→R3 → B fixture → R4 を、正常系と課金後 `502 paid_data_unavailable` の**両方**について通す。実鍵・実署名・実決済を使わず、fixture 実行は `synthetic` ラベル付き。
- 正常系: レシート参照を evidence として journal に記録し、上流 JSON をクライアントへ返して `delivered`、R4 で同値が読める。
- `502 paid_data_unavailable`: 「支払い済み・データなし」を終了状態として記録し、自動返金・自動再購入・自動リトライを
  しない。`receiptRef` は上流が実際にレシートを返した場合のみ記録し、`not_sent` / `rejected` では記録しない
  （B が課金したという偽の主張を作らない）。
- AC-6b のみの達成を AC-6 の合格と書かない。

- **依存**: T1 完了、T2 の outbound ポート確定。`mppx` は §8 の候補版 `0.11.0` の**支払い側エントリポイント有無**を
インストール前に確認する（§8 (c)）。
- **完了コマンド（計画・未実行）**: focused `npx --no-install vitest run tests/wire/mpp-outbound.test.ts` / neighbor
`npx --no-install vitest run tests/unit tests/wire` / types `npx --no-install tsc --noEmit` / build
`npx --no-install tsc -p tsconfig.json`。
- **ゲートと証拠ラベル**: AC-6 / AC-6b の**前提**のみ、ラベル `T3-fixture-nopay`。

## 4. T4 — 既存 chat 向けの型付きクライアント + 例題（統合用パッケージ）

- **allowed file set**: `src/client/{index,types}.ts` / `examples/chat-market-data-profile.ts` / `README.md` /
`tests/wire/client.test.ts`。**既存 chat worktree・既存 UI を一切編集せず、新規 UI も作らない。**
- **consumer / caller / input / output**: consumer は既存 chat の `ChatExecutionFactory` 実装者（別オーナー）。input は
`routeId` と principal 資格情報、output は `quote()`→R2、`approve()`→R3、`status()`→R4 公開射影の型付き薄いラッパ。
Router の snapshot エンベロープ（`providerId/market/dataSource/payment/fetchedAt/data`）を**article 型へ cast せず、
擬似 article を合成しない**。

**満たす振る舞い（先に失敗テストを書く）**:
- 承認は `quoteId` に束縛され、未承認・拒否・対象変更時は支払いが開始されない（クライアント越しに観測）。
- 保存 → 再オープン相当の呼び出し（Router エンドポイント R4 の再取得）で、同一 `paymentId` の同一 status と同一結果が
  観測できる。
- 他 principal からは開始も参照もできない。トークンが応答・ログに出ない。

- **依存**: T1 完了（T2/T3 とは独立に着手可）。新規依存を追加しない。
- **完了コマンド（計画・未実行）**: focused `npx --no-install vitest run tests/wire/client.test.ts` / neighbor
`npx --no-install vitest run tests/wire` / types `npx --no-install tsc --noEmit` / build
`npx --no-install tsc -p tsconfig.json`。
- **ゲートと証拠ラベル**: AC-7 の**Router 側の束縛と状態提供のみ**、ラベル `T4-fixture-nopay`。実 chat UI 上の
因果確認（B-03 / U-07）は別ゲートで未解除であり、本タスクの合格は AC-7 の合格ではない。

## 5. 本タスク群で解除しない項目

- P3（MPP 受信→A）/ P4（x402 受信→B）/ P5（同一レールマトリクス）は要件どおり v1 では **DEFER**。adapter 差し替えで到達
  可能な設計を維持するが、**未実施であり暗黙に「完了」と主張しない**（忘れた受け入れ条件ではない）。
- D-01（自動照合・返金・再購入・`unknown` 自動解決）、D-02（外部 B のストア改善）、D-04、D-05 も作らない。
- B-01（実決済・鍵・署名・faucet）、B-03（chat 実接続）、B-04（remote/push・公開）、B-05（A/B の fresh paid readiness）は
  未解除。本書に E2E 成功の主張はなく、ソースからの発見は互換性の検証ではない。
