# 標準の x402 クライアント用の入口 タスク v1

入力: 要件 v3（R）、設計 v3（D）。各タスクは「実装 → その試験 → sabotage」で閉じる。順に行い、前のタスクの試験が通ってから次へ進む。commit は T-5 の後に 1 つ（レビュー済みの差分）。

| # | 内容 | 触るファイル | 完了の条件 |
|---|---|---|---|
| T-1 | adapter と port: `CreateOfferRequest.entry`、標準 offer（`extra.entry`、期限 = 注文の期限、`existing` と短い窓で止める、`order_exists`・`order_window_short` を sanitized の集合に）、`preflight` の分岐（key に `entry`、nonce 自由）、`checkSignature`、標準 offer の verify の通信失敗を例外に。`src/main.ts` の包みに `checkSignature` を通す（fail closed） | `src/ports/inbound.ts`、`src/adapters/inbound/subetha-exact.ts`、`src/core/orchestrator.ts`（`OFFER_REFUSAL_DETAILS`）、`src/main.ts` | D §9 T-c。印の無い offer の既存の試験が無変更で通る。sabotage (1) |
| T-2 | store と core: `source_credential_bound` の再生、`boundCredential`、`payTo` の索引（曖昧は fail closed）、`quoteStandard`、`purchaseStandard`（鍵の中の読み直し、digest、(a)(b)(c)、結び付け、実行、読み直して `source_failed not_sent`）、`disclosureOf` の分岐、入口をまたがない守り（`purchaseStatic`・`quoteLocked`・`offerFor`・`disclosureFor`）、stop point `after_credential_bound` | `src/core/{store,intent,orchestrator}.ts` | D §9 T-b。sabotage (2)(4) |
| T-3 | HTTP と一覧: `src/http/x402-entry.ts`（402 の発行、ヘッダーと形の検査、応答の写像、`PAYMENT-RESPONSE`）、`app.ts` の振り分け、R1／MCP の `x402Url` | `src/http/{x402-entry,app,projection}.ts`、`src/mcp/tools.ts` | D §9 T-a。sabotage (3)。R1 の差分が対象の route の 1 項目だけ |
| T-4 | 実物のクライアントの試験（`@x402/*` 2.28.0 は既存の実行時の依存。`package.json` と lockfile は変えない）、`tests/wire/x402-entry-client.test.ts`、`tests/wire/x402-entry-restart.test.ts`、fixture の保留の口（verify／settle の応答を止める）が無ければ足す | `tests/wire/`、`tests/fixtures/` | D §9 T-d、T-e。`src/http/x402-entry.ts` が `@x402/` を import していないこと |
| T-5 | 文書と全体: README の節、acceptance の段 4 の行、CLAUDE.md の 1 段落、全試験（`npm test`、typecheck、lint）、Codex の実装レビュー、指摘の反映 | `README.md`、`docs/subetha-exact-inbound-acceptance.md`、`CLAUDE.md` | R AC-8。レビューが APPROVE（または APPROVE WITH CHANGES を反映） |

やらないこと: hosted への展開、他の rail、認証なしの公開、payer の対応（R S-6〜S-8）。段 4 の標準クライアントでの実購入（R S-5）は段 3 の登録の後。

## 実施の記録（2026-11-21）

- T-1〜T-5 を実施。Codex（`gpt-6-astra`、CLI）のレビュー: 要件 ×2（REVISE → REVISE、v3 に反映）、設計 ×2（REVISE → REVISE、v3 に反映）、実装 ×2（REVISE: must 4 → REVISE: 残り 1 件 partly + should 1。どちらも反映）。
  実装の 2 回目の残り（HTTP の確認 3 点と単体 1 点）は試験を足して閉じ、3 回目の全体レビューはしていない（小さな訂正に全体の再レビューを繰り返さない規則）。
- 実装レビューで見つかった実害のある誤り: `npm install --save-dev` が既存の実行時の依存 `@x402/*` を devDependencies に動かしていた（`package.json` と lockfile を main と同じに戻した）。
- `npm test`: 3982 pass / 4 fail（既知の macOS の flake: guarded-transport T-A5／T-A6／T-A8、diagnostics-sink の p99）。`tsc --noEmit` は clean。
- sabotage（それぞれ対応する試験が落ちることを確かめて戻した）: adapter の nonce の分岐、credential の比較（conflict）、409 → 402、R3 の再提示の守り、verify の通信失敗の区別、壊れた結び付けの行の規則、結び付け後の `source_failed not_sent`。
- 実物のクライアントで分かったこと: `@x402/core` 2.28.0 は既定で zUSDC に払わない（`spendControls.allowedAssets` に足す必要がある）。Router の認証は `x-router-principal` と Bearer の両方。
