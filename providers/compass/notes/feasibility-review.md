# K01 source比較レビュー記録

- author: Codex、independent reviewer: Claude Code / `claude-opus-5-5`。
- 初回: NEEDS_FIX（必須1、任意2）。限定比較から代替の不在を断定しないこと、本文hashの根拠位置、receiverごとのseller署名鍵を明確化。
- 修正: 単一recipient・一意amount永久割当は未確認候補としてのみ追加。価格固定・bundle・人間承認・永続割当・枯渇・実facilitator検証の未確認事項を明示。採用値を設定せず、要件・設計は変更しない。
- 再レビュー: **LGTM（必須0）**。`subtype=success`、`is_error=false`、`permission_denials=[]`をcontrollerが確認。終了コードのみの判定ではない。
- controller: 修正差分、x402 offer検査・署名再構築、seller-proof、MPPのPOST拒否、本文hash関数を実sourceで確認。承認済みdocsのhash不変を確認。再レビュー後は本書作成とfeasibilityの状態表示だけ更新。
- 未実施: この比較作業ではコード変更・試験・実モデル・実署名/決済・クラウド作成/課金を実施していない。K05の別実行は別証拠で記録する。
- **G1での採用方式決定、既存要件変更のowner承認、実環境の成立とは別。**

生レビューはgitignoredの `.claude_workflow/local/k01-review.stdout` / `k01-review-final.stdout`。本書には秘密・署名・認証情報を含めない。
