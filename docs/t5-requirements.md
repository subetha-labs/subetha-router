# T5 要件 — chat ↔ Router 実プロセス相互実装 wire テスト（無課金）

- 起案: 2026-09-26 JST。オーナー承認（選択肢 A）。独立レビュー1回（NEEDS_FIX）を反映した v2。
- 前提フェーズ: T1–T4 受け入れ済み（HEAD `9c76329`）。本書は T4 までの要件・設計をやり直さない。
- ラベル: `T5-crossimpl-nopay`

## 1. なぜ必要か（発見された実際のギャップ）

`docs/requirements.md` の U-07（chat 側の実インタフェース）は**ソース上で既に解決済み**である。
chat worktree（別オーナー所有。所在は `.claude_workflow/local/` に記録）の
`apps/chat-demo/router-execution.mts`（`createRouterChatExecution`）と `router-contract.mjs`、
テスト3本が実装されている（2026-09-25 21:47–22:28）。

親が読み取り専用で突き合わせた結果、wire 契約は本 Router と一致している（独立レビューで13項目すべて再確認済み）:

- エンドポイント: `POST /v1/quotes`、`GET /v1/purchases/{paymentId}`、`GET /v1/routes/{routeId}/resource`
- R2 top-level: `quoteId, paymentId, routeId, resource, source, destination, approval`
- `source`: `rail, amount, asset, decimals, network, payTo, expiresAt, offer`（`rail === "subetha"`）
- `destination`: `rail, quoted, asset, network, quoteFingerprint`
- 束縛: `approval.boundTo === quoteId`、`quoteId === offer.extra.challengeNonce`、`routeBinding` の一致
- 認証ヘッダ、R3 要求ヘッダ、R4 射影キー、`offer.extra` の optional 集合も一致

**しかし chat 側のテストは `http.createServer` による自前スタブ Router に対して実行されている**
（`router-http.test.mts:100`）。本 Router の `src/main.ts` と突き合わせた実行は**一度も存在しない**。
両者は「同じ契約のつもり」の独立実装にとどまる。これが埋めるべき実際のギャップである。

**T5 は AC-7 を達成しない。** AC-7 は「その承認に束縛された**支払い**」の因果を要求するが、
T5 は無課金であり支払いレグを実行しない。AC-7 の達成には B-01（実決済）解除後の別ゲートを要する。
T5 が到達するのは **chat の実行レイヤ（`ChatExecutionFactory` 実装）との実結合まで**である。

## 2. 満たすべき要件

- **T5-01** 本 Router を実プロセス（`src/main.ts`）として起動し、chat 側の `createRouterChatExecution` を
  **読み取り専用で import** して実 TCP で駆動できる。
- **T5-02** R1/R2 の契約が両実装間で成立する。chat 側 `decodeQuote` の `exact()` 検証を、
  本 Router の実応答が**無改変で**通過すること。
- **T5-03** 承認束縛が両実装間で成立する。以下がいずれも**Router へ要求を出さない**こと:
  未承認 / 別 quote への承認 / canonical 改変 / 期限切れ quote への承認。
  さらに**承認成功後の 2 回目の承認が R3 を再送しない**（at-most-once）。
- **T5-04** 保存 → 再オープンで、chat 側 journal の状態と Router の R4 射影が同一 `paymentId` で整合する。
- **T5-05** **実鍵・実署名・実送金を伴う payer を注入しない。** 支払いは一切発生させない。
  R3 到達が必要な検証には、chat 側自身のテストと同形の**署名しない spy payer**
  （`challengeNonce` を返すだけ、鍵なし・ブロードキャストなし。`router-http.test.mts:134` と同形）を注入する。
  `prepareSubethaCredential` を**注入しない**構成（`executionAvailability === 'source_payer_unconfigured'`）は、
  T5-03 の否定系ケースの一つとして別に検証する。
- **T5-06** 合成上流 fixture は chat 側 `market-data.mjs` の snapshot プロファイルに適合する body を返すこと。
  現行 `tests/fixtures/upstream-server.ts` の body は**不適合**（`providerId`・`market`・`dataSource`・
  `payment`・`data` のすべてが異なる）ため、**適合 fixture の新設が本タスクに含まれる**。
  要求形: `providerId ∈ {market-data-a, market-data-b}`、canonical path `/v1/eth/snapshot`、
  `market{kind,symbol,quote}`・`dataSource{name,network}`・`payment{protocol,network}`・`fetchedAt` ISO・
  A は `data{markPx,prevDayPx,dayNtlVlm,change24h,assetIndex}`。
- **T5-07** 他 principal の分離が実結合で成立する。BOB の bearer で ALICE の `paymentId` を引くと
  Router が 404 を返し、chat 側が `router_access_denied` 相当として扱うこと。
- **T5-08** `unknown` の耐久性。R3 途中で Router を落としたとき、chat 側が `unknown` を**永続**させ、
  自動リトライ・自動再承認をしないこと（D-01 を解除しない）。
- **T5-09** 観測手段を独立に持つ。「Router へ要求が出ない」の判定は chat 側 journal だけに依存せず、
  **Router 側の R2/R3 到達回数と上流課金呼び出し回数を独立に計数**して確認する。
- **T5-10** chat 側契約のアンカー固定。`router-contract.mjs` の内容ハッシュまたは
  `PROFILE`（`chat-demo/router-market/v1`）/`PROTOCOL`（`router-http/subetha`）をテストにピン留めし、
  chat 側が契約を変えたら**明示的に失敗**すること。
- **T5-11** journal の前提を満たす。chat 側は dir `0o700`・`uid` 一致・`create` 時は空ディレクトリ・
  file `0o600`・`nlink === 1` を要求するため、テストの一時ディレクトリは
  `realpathSync`（macOS `/var`→`/private/var`）と `chmod 0o700` を満たすこと。
  ロック保持中の二重 open が fail-closed になることも確認する。

## 3. 差分が出た場合の扱い（T5-06 の判断規則）

契約差分を検出した場合、以下の3分岐で扱い、**無条件に Router を曲げない**:

1. **テスト fixture のみの修正** — 上流 body プロファイル等、製品仕様に影響しないもの。本タスク内で実施。
2. **Router 製品コードの修正** — `src/http/projection.ts` の固定射影など製品仕様に触る場合は、
   **要件・設計ゲートに戻す**。射影を緩めて不変条件を壊すことはしない。
3. **差分を記録して据え置き** — chat 側が変更すべきと判断される場合。本リポジトリでは修正せず、
   証拠付きで記録しオーナーに委ねる（chat worktree は編集しない）。

## 4. 境界（本タスクで解除しないもの）

- **chat worktree を編集しない**（`AGENTS.md`）。import と子プロセス起動のみ。テストは本 worktree に置く。
- 実決済・実鍵・署名・ブロードキャスト・faucet・実 RPC（B-01 / U-04 / U-05）は範囲外。
- Provider A/B の実 API 到達（B-05 / U-06）、finality（D-05）、push・公開（B-04）も範囲外。
- **D-01**（自動 reconcile・自動返金・自動再購入・`unknown` の自動解決）は T5 でも解除しない。
- **U-01 / U-02**（SubEtha 実ランタイム詳細）を解決しない。合成 facilitator 上の検証にとどまる。
- chat 側の実 UI（ブラウザ上の操作・`ui.js`・`server.mts` の HTTP 層）は本タスクでは扱わない。
- chat 側に実行ホールドがある場合、本リポジトリで再試行しない（B-03）。

## 5. 受け入れ条件

- `T5-crossimpl-nopay` ラベルで、実 Router プロセス × chat 実実装の結合テストが green。
- T5-02〜T5-11 がテスト本文で実際に検証されている（テスト名だけの主張を認めない）。
- 親のフルチェック（test/types/build）と独立レビュー LGTM。
- README に「chat 実行レイヤとの結合は確認済み／**実 UI・実決済・AC-7 は未達**」の区別を明記し、
  現 README の「drop-in 互換性は示していない」を実測結果に更新する。

## 6. 未確定・依存

- chat worktree は別オーナーが 2026-09-25 に作業中。本タスクは chat 側を変更しないため書き込み競合はないが、
  **本テストが検知できるのはテストが実際に触る契約面に限られる**（`ui.js`・`server.mts`・`market-data.mjs` の
  変更は沈黙しうる）。T5-10 のアンカーでこれを部分的に補う。
- chat 側は `--experimental-strip-types` で `.mts` を実行。本 worktree は vitest。
  **子プロセス起動（chat と同じ strip-types）を第一候補**とし、直接 import が成立しない場合の退避路を持つ。
  方式は設計フェーズで確定する。
