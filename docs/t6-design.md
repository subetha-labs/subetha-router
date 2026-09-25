# T6 設計 — Router の MCP ラッパ（フロントエンドなし）

- 対象要件: `docs/t6-requirements.md` v2（T6-01〜T6-14）。ラベル `T6-mcp-nopay`。
- 前提: T1–T5 受け入れ済み（HEAD `108629f`）。**製品コード（`src/http/*`・`src/core/*`）は変更しない。**

## 1. 構成

```
審査員の Claude Code ──stdio(MCP)──> src/mcp/server.ts ──HTTP(R1-R4)──> 稼働中の Router ──> Provider
```

- MCP サーバは **R1–R4 の HTTP 公開契約だけ**を叩く（T6-02）。`src/core/*` を import しない。
  → import 境界をテストで固定できる（`src/mcp/**` が `src/core/**` を参照しないことを grep で確認）。
- **Router を内蔵起動しない**（T6-10）。接続先は `ROUTER_MCP_BASE_URL` で受け取る。
  Router が起動していなければ **tool 呼び出しを試す前に明示エラー**にし、
  「Router を起動してください」という復旧手順を文面に含める（推測で起動しない）。
- 既存の T4 クライアント（`src/client/index.ts`）を**再利用する**。
  承認束縛・canonical 比較・`unknown` 保持・ID 照合は T4 で実装し T5 で相互検証済みなので、
  MCP 層はその上に**薄い変換だけ**を置く（新しい支払い経路を作らない = T6-02）。
- **プロセス内状態の前提（明記）**: `execute()` は **その client インスタンスが発行した quote
  のみ**実行できる（`src/client/index.ts:319-333` の `issued` Map、未発行なら
  `quote_not_issued_by_client`）。また `execute()` は `quoteId` ではなく
  **`QuoteView` オブジェクト全体**を要求する（`src/client/types.ts:74`）。
  → MCP サーバは `quoteId → QuoteView` のマップを**プロセス内に保持**する。
  2 段 tool（`quote` → `purchase`）は同一プロセスがこれを保つ限り成立する。
- **再起動を跨ぐ非対称性（tool description と README に必ず書く）**:
  MCP サーバを再起動すると `purchase` は必ず失敗する（発行元 client が消えるため）。
  一方 `status` は client を作り直しても参照できる（T4 設計・`tests/wire/client.test.ts:180-186` で実証）。
  審査員が詰まるポイントなので明示する。

## 2. 公開する tool（T6-11: prefix 固定）

| tool | 対応 | 引数 | 返すもの |
|---|---|---|---|
| `subetha_router_list_routes` | R1 | なし | `routeId`・canonical URL・両レグの資産メタ（上流 URL は出さない） |
| `subetha_router_quote` | R2 | `routeId`, `requestId` | quote（`quoteId`・両レグの額・`approval.deadlineMs`）と**承認の要否** |
| `subetha_router_purchase` | R3 | `routeId`, `requestId`, `quoteId`, `approval` | `delivered` / `payment_required` / `rejected` / `unknown` + `paymentId` |
| `subetha_router_status` | R4 | `paymentId` | 公開射影（保存 → 再オープン相当） |

tool 名は README に固定して記載する（T6-01 の成功判定 = `tools/list` にこの 4 つが出ること）。

## 3. 明示承認をどう保つか（T6-03。設計の核心）

**採用: tool を 2 段に分ける（`quote` → 人間の承認 → `purchase`）。**

`OnPaymentRequired` 形（challenge に束縛を載せて承認フックで見せる）は**採らない**。理由:

1. あのフックは**クライアント側**＝「自分が有料 MCP tool を呼ぶとき」の口で、
   本 Router は payer なので役割が逆（要件 §2）。
2. 束縛を運べるのは `opaque` だけで、**`description` と `meta` は HMAC 非対象**（実測確認済み）。
   人間に見せる文面を安全に運ぶには `opaque` を復号して提示する実装が必要になり、
   **MCP クライアント側にその実装を要求することになる**（審査員の Claude Code は素のままである）。
3. フックは**再試行のたびに呼ばれる**ため、「1 回承認 = 1 回実行」をクライアントの作法に預けてしまう。

2 段方式なら承認は**Router の既存拒否面**で強制される（T6-03 の要件どおり）:

- `purchase` tool の `approval` は **任意引数**にする。未指定・空でも MCP 層で弾かず
  **そのまま Router へ送り**、Router の拒否面で `approval_required` を受け取る
  （`src/core/orchestrator.ts:392`。`src/http/app.ts:360` は `approval === undefined` なら
  ヘッダを付けずに core へ渡す）。
  **必須引数にすると SDK のスキーマ検証で Router に届く前に落ち、
  「Router の拒否面で強制される」ことの検証にならない**（レビュー指摘）。
  MCP 層は独自に承認を判定しない。
  **訂正（実装レビューで判明）**: 拒否面は実際には **2 層**ある。
  T4 クライアントは束縛不一致を見て **Router へ要求を出さずに** `approval_mismatch` で止める
  （`src/client/types.ts` の型コメントが「Router へ要求を出していない」と明記）。
  したがって MCP tool 経由の否定系は**クライアント層で止まる**のが正しい挙動で、
  その場合 `payCalls === 0` は自明に成立する（Router には届いていない）。
  §9 では **(a) MCP 経路で停止層を `approval_mismatch` に固定**し、
  **(b) Router 自身の拒否面（承認ヘッダ無しの R3 → `approval_required`）を
  公開契約を直接叩いて別途確認**する。片方だけでは権限境界の所在を示せない。
- `quote` の応答に「**この quote を承認するには `approval` に `quoteId` を渡す**」ことと、
  **承認対象（額・`decimals`・資産・ネットワーク・canonical URL・期限）**を明記する。
  **`decimals` は必須**: `amount` は base units なので、`decimals` なしでは
  `10000` が 0.01 USDC なのか 10000 USDC なのか人間が判断できない。
  R2 は `decimals` を返す（`src/http/projection.ts:51`）が `QuoteView` の名前付きフィールドには
  無いため（`src/client/types.ts:39-47` の `Record<string, unknown>` 経由で通過する）、
  MCP 層が明示的に取り出して提示する。
  人間はこれを読んで承認する。提示内容は Router の R2 応答そのもので、
  MCP 層が合成・要約しない（乖離を作らない）。
- `quote` の応答に `approval_required: true` を含め、**エージェントが勝手に `purchase` へ進まない**
  ことを文面で明示する（tool description にも書く）。

**この方式は「エージェントが自律的に支払う」形にはならない。** それは要件 T6-03 の意図どおり。

## 3b. credential（`X-Payment` 値）の担い手 — 設計の核心

**これを決めないと `purchase` tool は動かない。** 事実:

- `ExecuteInput.credential` は**必須**（`src/client/types.ts:73-80`）。空なら
  R3 を呼ばずに `credential_required`（`src/client/index.ts:341-343`）。
- Router 側も `x-payment` が無ければ購入経路に入らない（`src/http/app.ts:328-338`）。
  orchestrator も `credential === undefined` で `payment_required`（`src/core/orchestrator.ts:398-405`）。
- credential は「offer 全体 + その offer の `challengeNonce`」で、strict preflight が完全一致を要求する
  （`src/adapters/inbound/subetha.ts:177-195`）。
- **製品コードに credential を作る実装は存在しない。** 現在作っているのは
  テスト fixture の `paymentHeader`（`tests/fixtures/router-harness.ts:217-228`、`synthetic: true` 付き）だけ。

### 採用: 合成モード限定で MCP サーバが fixture credential を組む

- **`credential` を tool 引数にしない**（T6-04 の「資格情報を引数で受け取らない」を守る。
  また審査員に credential を作らせるのは T6 のデモ主張 —「自分の手持ちでは払えない Provider が使える」—
  を崩すため採らない）。
- MCP サーバは **`ROUTER_MCP_ADAPTER_MODE=synthetic` を明示したときだけ**、
  quote が返した offer に対して `{x402Version:2, accepted:<offer>, payload:{challengeNonce, synthetic:true}}`
  を組む。**`synthetic: true` を必ず含め、隠さない。**
- **実レール（`real`）では credential を組まない。** 組めないので `purchase` は
  「**実署名能力が未実装のため実決済は未解除**」という固定エラーを返す（推測で署名しない）。
  これは B-01 の境界そのもので、実決済は別タスク。
- T6-02（新しい支払い経路を作らない）との関係: **これは新しい支払い経路ではなく、
  既存 fixture が合成レール向けに作っている値と同一形式のものを合成モードでのみ組むもの**である。
  実レールの署名経路は一切作らない。この例外を T6-02 の明示的な但し書きとして記録する。
- 検証: 合成モードで `purchase` が `delivered` に到達すること、
  `real` モードでは**支払いが始まらず**固定エラーになること（上流 payCalls 0）。

## 4. `requestId` の決定論性（T6-05c）

- `requestId` は **tool の引数として呼び出し側が渡す**（MCP 層が生成しない）。
- 同一引数で 2 回呼べば**同一 `paymentId`** が返ることをテストで固定する。
  根拠: quote の冪等性キーは `(principalId, requestId)`（`orchestrator.ts:692`, `:289`）、
  購入の直列化キーは `quoteId`（`:698`）。`requestId` が安定していれば `quoteId` も安定し、
  反復は 1 回に潰れる。
- tool description に「`requestId` は再試行しても同じ値を使うこと」を明記する。

## 4b. 起動エントリ（T6-01 の「1 行で登録」を成立させる）

`package.json` には現在 `bin` も起動 script も無く（`scripts` は test/types/build のみ）、
既存テストは `node --import tsx <script>` 形で直接叩いている。審査員向けには:

- **`package.json` に `"mcp": "tsx src/mcp/server.ts"` を追加**し、
  登録は `claude mcp add subetha-router -- npm run --silent mcp` 相当の 1 行にする。
  `--silent` は **npm 自身の出力が stdout に混ざるのを防ぐため必須**（stdio は JSON-RPC 専用）。
  実測して、混ざるなら `npx tsx src/mcp/server.ts` 直叩きに切り替える（どちらでも README に固定記載）。
- `dist/` 経由（`node dist/mcp/server.js`）は**採らない**。`dist/` は gitignore 済みで
  審査員に別途ビルドを要求することになるため。
- 必要な env は README に列挙（T6-01）: `ROUTER_MCP_BASE_URL`、`ROUTER_MCP_PRINCIPAL_ID`、
  `ROUTER_MCP_TOKEN`、`ROUTER_MCP_ADAPTER_MODE`、`ROUTER_MCP_EVIDENCE_FILE`（無ければ env の自己申告）。

## 5. 秘密と stdout（T6-04）

- **stdout は JSON-RPC 専用。** MCP モードのログは**すべて stderr** に出す。
  MCP サーバは `src/main.ts` を起動しないので、既存の起動ラベル（`src/main.ts:205` の stdout 書き込み）
  とは衝突しない。MCP 層自身は stdout に何も書かない（SDK の transport にのみ渡す）。
- principal トークンは **env（`ROUTER_MCP_PRINCIPAL_ID` / `ROUTER_MCP_TOKEN`）でのみ**受け取り、
  **tool の引数にしない・応答にエコーしない**。
  HTTP へは既存の `x-router-principal` + `Authorization: Bearer`（`src/http/auth.ts:44-45`）で渡す。
- 例外・スタックトレースをそのまま返さない。**固定の安全な文言 + 既存の安全な理由コード**に変換する
  （T4 クライアントが既に `errorCodeOf` で `/^[a-z0-9_]{1,64}$/` に限定している）。
- 上流 URL を出さない（R1 の既存方針をそのまま通す）。

## 6. 合成であることを隠さない（T6-07）

- Router の R1 応答・起動情報から**証拠ラベル相当**を取得し、**すべての tool 応答に含める**
  （`evidence` フィールド）。起動ログだけに出すのでは審査員に見えない。
- 現状 R1–R4 はラベルを返さないため、**MCP 層が接続先 Router の `/v1/routes` 応答と
  env の構成から「合成か実物か」を判定できない**。
  → **設計判断（レビュー指摘を受けて修正）**: 裸のラベル文字列を env で受けて応答に載せるのは
  **「嘘を書ける穴」**になる（運用者が `real` と書けば合成レールでも `real` を名乗れてしまい、
  MCP 層には検知手段がない）。要件 T6-07 の主眼は**偽れないこと**なので、次の 2 段構えにする:

  1. **出所を Router 自身にする（第一候補）**: README の手順で Router の起動出力を
     `ROUTER_MCP_EVIDENCE_FILE` に残し、MCP サーバがその
     `{"event":"listening",...,"label":...}` 行（`src/main.ts:205` が書くもの）を**パースして読む**。
     値の出所が Router になるため自己申告でなくなる。
  2. **出所と検証状態を構造として必ず載せる**: `evidence` は裸の文字列にせず
     `{ label, source: "router_listening_line" | "operator_asserted", verified: boolean }` とする。
     ファイルから読めた場合は `source: "router_listening_line", verified: true`、
     env の自己申告に落ちた場合は `source: "operator_asserted", verified: false`。
     **`source` / `verified` を欠く `evidence` は T6-07 を満たさない。**
  - どちらも製品コード無変更で実装できる。`verified: false` でも虚偽の余地は残るが、
    審査員が「これは運用者の自己申告」と読める形にはなる。
  - 検証（§9）では **`evidence.source` と `evidence.verified` の値まで**確認する
    （「`evidence` が存在する」だけでは通さない）。
  - **Router が公開契約でラベルを返す**のが本来の解だが R1 の契約変更になるため T6 では採らない
    （backlog に記録）。

## 7. ライフサイクル（T6-12）

- stdin EOF / `SIGTERM` で MCP サーバは**自分の HTTP 要求を中断しない**。
  進行中の `purchase` は完了させてから終了する（中断すると `unknown` を無用に増やす = D-01 抵触）。
- MCP サーバは journal を持たない（Router が持つ。`src/core/orchestrator.ts:718-720`）。
  したがって MCP 側に lock も close も不要。切断時に Router 側の状態は一切触らない。
- **要件 T6-12 後半の「終了時は journal を明示的に閉じる（`core.close()` 経路）」は、
  T6-10 で内蔵起動を否定した結果として該当しない**（要件文が内蔵起動前提で書かれていた）。
  MCP サーバは `core` を保持しないため閉じる対象がない。

## 8. 依存（T6-14）

- 追加するのは **`@modelcontextprotocol/sdk` 1 つだけ**。**完全一致版で固定**（`^` / `>=` を使わない）。
  インストール直前にバージョンを確認し、その値を `package.json` に書く。
- `@x402/mcp` は追加しない（payee 側の仕組みで T6 の範囲外）。
- stdio のみを使うため express / hono / jose / ajv 等は実行時にロードされない
  （インストール面と実行面を区別して README に記載）。

## 9. テスト（T6-08）

新規 `tests/wire/mcp-server.test.ts`。実 Router プロセス（合成レール）＋ 実 MCP サーバプロセスを起動し、
**SDK のクライアントで実際に `tools/list` / `tools/call` を叩く**。

**足場の前提（レビュー指摘を反映）**:
- Router の合成構成（`ROUTER_CONFIG_PATH` は必須。`src/config.ts:387-390`）は
  **既存 `tests/fixtures/router-harness.ts` が生成するもの**を再利用する（読むだけ・変更しない）。
  `startHarness()` が facilitator・上流・Router を立てるので、`mcp-harness.ts` はそれを使い、
  そこに MCP サーバプロセスを足す。
- **既存 `tests/fixtures/loopback.ts` の `spawnApp` は stdin が `ignore` なので stdio MCP に使えない。**
  `mcp-harness.ts` で **stdin/stdout をパイプする spawn を新規に持つ**（既存 fixture は変更しない）。
- **stdout 非汚染の検証方法**: SDK クライアント経由だと SDK がパースしてしまい非 JSON-RPC 行を
  検知できない。したがって**別に raw spawn して stdout 全バイトを収集し、
  空でない全行が JSON-RPC として `JSON.parse` できること**を確認する。

| 要件 | 検証 |
|---|---|
| T6-01 | `tools/list` に 4 つの tool 名が出る |
| T6-02 | `src/mcp/**` が `src/core/**` を import しない（境界テスト） |
| T6-03 | `approval` 無しの `purchase` は支払いが始まらない（上流 payCalls 0）。不一致も同様 |
| T6-05/05b/05c | 同一引数で `purchase` を 3 回反復 → `paymentId` 同一・両レグ 1 回 |
| T6-04 | 応答 JSON にトークンが出ない。例外注入時も固定文言。**stdout に JSON-RPC 以外が出ない** |
| T6-06 | 支払い能力なしの構成で合成に落ちない（既存 `signer_not_authorized` を壊さない） |
| T6-07 | 全 tool 応答の `evidence` に `label` / `source` / `verified` が揃う。
  ファイルから読めたとき `source: "router_listening_line"` かつ `verified: true`、
  env 自己申告のとき `verified: false`。**値まで確認する**（存在確認では通さない） |
| T6-03b | `approval` 不一致（別 `quoteId`）で停止層が `approval_mismatch` に固定される（Router へ要求は出ない） |
| T6-03c | Router 自身の拒否面: 承認ヘッダ無しの R3 を公開契約に直接投げて `approval_required`（400）を観測 |
| T6-10 | 同一 journal に 2 つ目の Router を立てると `flock` で fail closed する（接続先が 1 つに保たれる根拠） |
| 3b | 合成モードで `purchase` が `delivered` に到達。`real` モードでは支払いが始まらず固定エラー（上流 payCalls 0） |
| T6-09 | README の手順どおりの env で起動できる |

## 10. 変更対象ファイル（allowed file set）

1. `src/mcp/server.ts`（新規。MCP サーバ本体）
2. `src/mcp/tools.ts`（新規。R1–R4 と tool の変換）
3. `tests/wire/mcp-server.test.ts`（新規）
4. `tests/fixtures/mcp-harness.ts`（新規。Router + MCP サーバ + SDK クライアントの組み立て）
5. `package.json` / `package-lock.json`（SDK 追加＝**完全一致固定**、`^`/`>=` を使わない。
   既存直接依存はすべて完全一致で固定済みなのでこの規律を崩さない。
   加えて **`scripts.mcp` の追加**＝起動エントリ。§4b）
6. `README.md`（再現手順・tool 名・未達の区別）
7. `docs/tasks.md`（T6 節の追記）

**変更しない**: `src/http/*`・`src/core/*`・`src/client/*`・`src/main.ts`（製品コード）、
既存 fixture・既存テスト、`tsconfig.json`、`vitest.config.ts`、chat worktree。
上記以外が必要になれば**停止して報告**する。

## 11. 未解決・リスク

- **T6-07 の evidence を env で持つのは妥協**。Router が公開契約でラベルを返すのが本来だが
  R1 の契約変更になるため T6 では採らない（backlog）。運用者が値を一致させる責任を負う。
- SDK の protocol version を README に記録する（T6-13）。実測してから書く。
- 審査員の環境で Router をどう起動するかは README の手順に依存する。
  MCP サーバは Router を起動しないため、**Router 未起動時の文面が実質の UX** になる。
- 実決済は範囲外（T6 は `T6-mcp-nopay`）。実署名能力が未実装のため別タスク。
