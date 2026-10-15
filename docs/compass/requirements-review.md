# Compass 要件レビュー・確認記録

## 現在の門

**要件レビュー LGTM／owner の要件承認待ち。設計・タスク・実装へは未移行。**

- 作業場所: `~/.worktrees/subetha-router/compass-gcp-prototype`
- branch: `task/compass-gcp-prototype`
- 開始点: fetch 後の `origin/main` = `10dd795`。
- 作成前の Data volume 使用率: 69%（owner の停止条件 90% 超には該当せず）。
- 作成: Claude Code 2.1.296、実モデル `claude-opus-5-5` / firstParty（実行結果の modelUsage）。
- 初回独立レビュー: Codex CLI 0.157.1、`gpt-6-astra` / openai、read-only / approval never（実セッション metadata）。
- 初回は NEEDS_FIX、要件 8 点を Claude が修正。Codex の独立再レビューで LGTM。生ログは `.claude_workflow/local/` に保存（gitignore、成果物には同梱しない）。
- 親 controller は要件全文・該当ソース・レビュー実体を read-back。再レビュー後の要件変更は冒頭の状態表示と本記録へのリンクのみ（機能・受入要件は変更なし）。
- いずれも owner 承認や実行結果の代わりではない。

## 再レビューの判定（原文）

**LGTM（要件フェーズのみ）。未解決の重大事項・新たな要件ブロッカーはありません。**

過去8件はすべて要件として解消されています。

1. 永続状態・再起動後の重複防止・状態喪失時の受付停止。
2. Provider 側の支払いとタスク・目録・評価設定の束縛。
3. 累積費用／受付上限、使用量の永続化、未回収リスクの開示。
4. 不正なモデル出力と正常な `none` の区別、決済状態の保持。
5. cold／warm の期限実測と支払い前の準備確認、A 不成立時の承認付き B 移行。
6. 当時は日本語評価と実モデル測定前の合格基準固定をレビューした。後続のowner指示「英語で良いですよ」により、評価言語は英語へ変更（本記録の初回レビューと最新要件を区別する）。
7. 各購入の決済・配信・受領・保存／再読取・finality の証拠分離。
8. モデル・サーバ・image・remote code の固定、来歴／license 確認。

既存の動的 POST 再利用も明記されています。永続化方式・本文形式・処理順序・具体的閾値は設計段の決定事項であり、要件承認のブロッカーではありません。

確認対象は指定の要件・前回レビュー・実現性メモの全文。変更・テスト・外部アクセスは実施していません。報告済み46件の成功は URL 単体試験のみで、root 全体や Compass の検証成功を意味しません。

**STOP：owner の要件承認まで次段階へ進めません。** 本判定は設計・実装の承認ではありません。課金・クラウド操作・署名・実購入は別途明示承認が必要で、署名を含む root 全試験も明確化待ちです。

## 試験と制約

- `npm ci`: exit 0。484 packages added、audit 0 vulnerabilities の表示。Solana 関連 peer dependency 警告あり。依存指定・lockfile の変更なし。
- `npx --no-install vitest run tests/unit/upstream-url.test.ts --reporter=json --outputFile=.claude_workflow/local/upstream-url-test.json`: 1 file、46 passed、0 failed、0 skipped、exit 0。
- clean env、worktree 内 HOME/TMP/npm cache で実行。対象はソース確認済みの純粋 URL 関数。署名・ウォレット読取・外部接続なし。
- root 全体 `npx vitest run`: **未実行**。含まれる使い捨て鍵による実暗号署名テストが owner の署名禁止の例外か、明確化待ち。全体 PASS と言わない。
- macOS で既知と指定された `guarded-transport.test.ts` の T-A5/T-A6/T-A8: 今回は未実行で、失敗を観測したとは扱わない。
- Provider-local の Compass 試験: 実装前のため未作成・未実行。root の試験で代用しない。

## 境界・未決事項

- 変更成果物は `docs/compass/requirements.md` と本記録のみ。補助的な状態・プロンプト・ログは、この worktree 内の gitignored `.claude_workflow/`。
- 他 worktree の作業ファイル、既存 Provider、Router のコード、`CLAUDE.md`・`README.md`・`docs/DEPLOY.md` は変更していない。
- commit/push/PR/merge/stash、Docker、SSH、Cloudflare 操作、/etc 変更、秘密ファイル読取・検索、署名・送金、クラウド配備は行っていない。`git fetch` と worktree 作成による共有 Git metadata の更新は owner 指定の準備手順。
- 設計前なので「承認済み設計からの逸脱」はなし。POST 非対応という controller の初期認識は誤りで、最新ソースと owner 指摘に従い修正済み。既存の動的 POST 経路を再利用する。
- public-source の A の成立可能性と、実アカウントでの GPU quota/実起動/料金/期限は別。後者は未確認。A を実証済みと扱わない。
- owner の確認事項: 要件から設計へ進めてよいか、オフライン使い捨て鍵の署名テストを許可するか。GCP project・region・予算や実購入の範囲は後続の外部実行前に確認する。
