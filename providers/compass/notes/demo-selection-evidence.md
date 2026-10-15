# D1 既存4資源 catalog 実装証跡（2026-10-15）

Codex gpt-6-astra author。最新の要件・設計・タスク §0.1 に基づくローカル実装。以下の受入追記はcontrollerによる実測記録。独立実装レビューとparent再検証は完了したが、実モデル・購入E2Eの完了ではない。cold workflow / cron はHOLD、C3〜C7へ進めない。

## Controller受入（2026-10-15）
- 親側再実行: `python3 .claude_workflow/local/run_cold_check.py product demo-parent-product-r1` は5ファイル・260件成功、失敗/skipなし。`types demo-parent-types-r1` はexit 0。両方とも排他lock下・socket-free・環境scrubで実行。原本は `.claude_workflow/local/cold-impl-demo-parent-{product,types}-r1.{log,json}`。
- 独立Claude Code `claude-opus-5-5`（firstParty）の実装レビューは **LGTM**、permission_denialsなし。原文は `.claude_workflow/local/demo-review-impl-r1.stdout`。ソース/ログのread-onlyレビューで、実モデルの評価ではない。
- 親のhash照合は `.claude_workflow/local/demo-parent-r1.json`。旧カタログ・probe・保存応答・既存試験・model/http/server・C3途中成果は基線から不変。変更は正本3文書と本slice6ファイルのみ。
- 非blockingのレビュー指摘（多重理由で拒否される境界試験の診断性、件数単独試験の補強）は保留。既存境界検査の安全性を外したわけではなく、今回追加の精密な故障検出試験は未実施。
- 実行方法: 既存factoryへ `catalogPath` として `providers/compass/catalog/demo-selection.json` を明示指定し、要求の `catalogVersion` を `existing-resources-v1` にする。既定値は旧版のまま。これは起動・GPU実行・支払を行うコマンドではない。
- 次の実証には新catalog/11ケースを使う実モデル実行経路と、新しいGPU費用承認が必要。現在の旧GPU runnerは旧8ケースに固定されているため、そのまま実行できない。C3〜C7全体の完成を条件にせず必要最小限の接続だけを別途扱う。


変更は `src/catalog.ts`、`catalog/demo-selection.json`、`probe/demo-cases.json`、`test/demo-selection.test.ts`、`vitest.config.ts` と本noteの6パスのみ。新版は `catalogPath` の明示指定で選ぶ。旧版default・3件・本文bytes/SHAを保持し、新版の件数/evidence/ID集合を検証、新版だけ共通指示1文を追加。taskを解釈するkeyword routerは追加していない。

継承controller lock下で既存helperを直列実行。全コマンドの接頭辞は `python3 .claude_workflow/local/run_cold_check.py`。環境scrub/.c0、socket-free/offline、listenerなし。

| helper引数 | 実結果 | immutable log（worktree root相対） |
|---|---|---|
| `product demo-d1-red-01` | exit 1、202成功/1失敗。旧bytes/SHA成功、新版のみ `invalid_catalog` | `.claude_workflow/local/cold-impl-demo-d1-red-01.log` |
| `product demo-d1-green-01` | exit 0、260成功（既存201＋新規59） | `.claude_workflow/local/cold-impl-demo-d1-green-01.log` |
| `types demo-d1-types-01` | exit 2。snapshot版の型拡大とmock引数型を検出 | `.claude_workflow/local/cold-impl-demo-d1-types-01.log` |
| `product demo-d1-green-02` | 型注釈修正後 exit 0、260成功 | `.claude_workflow/local/cold-impl-demo-d1-green-02.log` |
| `types demo-d1-types-02` | 修正後 exit 0 | `.claude_workflow/local/cold-impl-demo-d1-types-02.log` |

各logと同名の `.json` にhelperのexit・所要時間・source hashesを保存済み。親の `demo-legacy-request.json` から本文literalとSHA `09dfd4f1ce3b9f87ead1cb60cd97aa07ddc0680c105a2cf4d1bd01d6138720fd` をtestへ固定し、変更後builderから期待値を再生成していない。親の `demo-baseline-hashes.json` と製品既存ファイルを照合し、差分は許可済みcatalog.ts/vitest.config.tsだけだった。

新59件は `boundary` / `falsepayment` / `modelSource` を明示。固定metadata全文・11 intent資料、loader境界、freeze/hash、版別criteria、実factoryのdefault/opt-in、stream handler経由の11件と両方向409送出0、他版choice/確率keys・不正wireの502、notSent、504→503 latch、400を確認。全JSON成功/エラーは `purchaseEnabled=false` / `paid=false`。wire上の `modelSource=recorded-fixture` は生成したSYNTHETIC応答であり、実モデルの過去記録でも新規推論でもない。probeには期待値だけを保存した。

候補の由来（owner提示の既知根拠。今回新規取得なし）：ETH/SOLは [config](../../x402-workers/src/config.ts) と [Provider文書](../../../docs/provider-x402-workers.md)。SOLの既知unpaid curlはHTTP402、descriptionは「SOL perpetual snapshot」。Uniswapは [root README](../../../README.md) /既存docsの旧Provider B。Exaは [mainnet-first-route](../../../docs/mainnet-first-route.md) の過去有料検索成功。これらは現行runtimeのpayabilityや今回の支払E2Eを証明しない。

到達点はローカルmetadata・合成契約試験のみ。実モデルの4資源選定品質は未検証で、GPU実行はfresh owner承認を要する別gate。今回の外部支払は未実施、購入・支払・配信E2Eも未検証。commit/push・cloud・network・有料API実行なし。
