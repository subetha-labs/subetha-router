# Compass タスク計画・独立レビュー記録

## 結論
- Codexがタスク案作成・修正、Claude Code（実使用 `claude-opus-5-5`）が独立読取専用レビュー。
- 初回 **NEEDS_FIX（4件）** → 修正後 **LGTM（文書のみ）**。
- controllerがレビューJSONの本文・正常終了・permission_denialsなしを確認し、対象文書のhashがレビュー中に変化していないことを照合。
- owner指示「英語で良いですよ」を要件・設計・タスクへ同期し、再レビュー対象に含めた。日本語の選定品質は必須外、Unicode/本文hashの安全性検査は維持。
- **タスク段のowner承認待ち。実装・クラウド課金・実購入は未着手。**

## 必須指摘の解消
| 指摘 | 修正 |
|---|---|
| B1 支払い成立確認がGPU課金の後 | K09bで採用railの登録/proof成立を小さく確認し、実store/GPUの前提化。登録/proof成功と実settlementは別証拠 |
| B2 性能評価が測定するだけ | K11で品質とcold/warm両方の期限達成を合格条件化。不達は停止、warm限定や別構成は別判断 |
| B3 既存失敗との比較条件不足 | K05で変更前の同環境baselineを確保。K07で新規失敗0・残存ID/原因を照合。既存失敗残存時はfull PASSにせずownerの進行判断を別にする |
| B4 新規依存取得の許可が曖昧 | G0aで具体的package/固定版/license/registry/配置/容量を承認してから取得。初期は既存toolingを再利用 |

任意指摘も反映: quota読取の早期実施、実Router対象の固定、chosen経路の明示検証、未追跡文書の空白検査。controllerは実回帰のtsx CLI子プロセスprobeもK05へ追加。

## controllerの確認
- 要件・設計・タスクの英語評価への同期を検査。設計のJSONコードブロック5件はparse成功。
- 追跡済み製品コードのdiffなし。文書とgitignoredローカルのworkflow記録のみ変更。
- 未追跡文書は`git diff --no-index --check`で検査。新規差分によるexit 1/診断なしと、意図的な空白不正fixtureのexit 3/診断ありを実測。最初の「exit 0必須」というcontroller検査の誤りは修正し、初回記録も保存した。
- レビュー後は状態表示と上記exit解釈の注記のみ補足。レビュー入力hashと最終ファイルhashを別に記録する。
- これは文書検査であり、Provider試験・全体回帰・実モデル・実決済の成功ではない。

## 既存試験の状態
| 区分 | 記録 |
|---|---|
| 関連試験 | 195成功・0失敗（以前の実行） |
| 初回全体 | 2639成功・27失敗・29skip、全体未合格 |
| 不適切なTMP再試験 | 2404成功・259失敗・32skip、suite errorあり。tsx依存削除で汚染された実行 |
| 依存復元後 | npm ciと実tsx/Router import成功。全体再実行なし |
| 今回 | 製品試験の追加実行なし。文書検査・独立レビューのみ |

## 未決事項と次の承認
タスク段承認後は、まず既存railのsource比較と安全な試験環境/baselineの確認から進める。GCP接続が用意され、読取範囲が承認されればquota等は並行して確認可能。
$300クレジット取得はowner申告・セットアップの申し出。適用先、GPU利用可能性、費用枠は未確認で課金許可ではない。receiver pool・再購入制限・warm限定、外部署名/送金も未承認のまま。

## 証拠（ローカル・非公開）
- `.claude_workflow/local/tasks-review.stdout` / `tasks-review-final.stdout`
- `.claude_workflow/local/tasks-final-review-inputs.json`
- `.claude_workflow/local/tasks-controller-checks-final.json`
- `.claude_workflow/local/tasks-whitespace-check-probe.json`
- `.claude_workflow/state.json`
