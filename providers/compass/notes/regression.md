# Compass変更前の回帰baseline（K05）

2026-10-15。製品source変更前の `10dd7956d1f9944075edce3d24fba361208a8d5a`。**全体未合格。baseline採取済み、原因分類は一部未確定。**

## 環境と境界

- macOS、Node `v22.23.1`。既存lockfile/installed依存を使用、追加取得なし。
- TMPDIR/TMP/TEMPは、このworktree内に新規作成した `.k5`（73 path bytes、6桁PIDを仮定したtsx pipe path 93 bytes）。HOME=`.k5/home`、npm cache=`.k5/npm-cache`、user/global npmrcは別々の空ファイル、offline=true。ホストの財布/cloud envは渡さない。
- `.k5` は依存ディレクトリと分離し、開始時に存在しないこと・所有uid・symlinkなしを確認。cleanup対象はこのrunの専用領域だけ。今回再帰削除やhost設定変更は行っていない。runtime fixtureは既存testsの動作に従う。
- Node version、実Router stableJson import、実tsx CLI子プロセスのmarker/exitは全てPASS。
- 実行前後のpackage-lockと記録したtsx package/CLI/loaderのhash一致、終了後tracked diffなし。前回のTMPDIR=node_modulesによる依存削除は再発せず。これだけで全体成功とはしない。

## 実行結果

| 範囲 | pass | fail | skip | suite error | exit |
|---|---:|---:|---:|---:|---:|
| R1 関連 | 266 | 0 | 0 | 0 | 0 |
| R2 全体 | 2658 | 8 | 29 | 0 | 1 |

R1対象は `tests/unit/{dynamic-post,upstream-url,receipt-form}.test.ts` と `tests/wire/x402-dynamic-outbound.test.ts`。

実行コマンドは既存ローカルnpxで `npx --no-install vitest run <R1対象 または対象省略> --reporter=json --outputFile=.claude_workflow/local/k05-<related|root>-tests.json`。各runは同じ隔離envを使用。この節は初回baselineの記録。後続の再実測は末尾に追記する。

## 失敗分類（8件）

- `guarded-transport.test.ts` T-A5/T-A6/T-A8（3件）: `cannot bind 127.0.0.2: EADDRNOTAVAIL`。host loopback前提の不足。alias/sudo等の設定変更なし。
- `provider-mpp-solana-scripts.test.ts` keygen-recipient（1件）: repository内へのseed出力拒否でexit 1。worktree内TMPの制約との衝突。安全guardは維持し、鍵出力を許可範囲外へ逃していない。
- `rails-process-entry.test.ts` Arcのみ、6-rail、solana-mpp-inの受付起動probe（3件）: remote-*新規ディレクトリ件数が期待1に対し3/3/2。sourceのruntimeRootはrepository共有runtime。並列干渉は仮説で、単独再現・原因確定は未実施。
- `router-cli.test.ts` 既定real adapterのfail-closed起動（1件）: 5000ms timeout。どの段階で停止したかは未確定。timeout延長やコード修正はしていない。

既知bind失敗と残る5件を同一視しない。後続比較では失敗IDだけでなく原因・環境も照合し、比較不能なら保留。全件成功へ読み替えない。

## 証拠・現在地

gitignored `.claude_workflow/local/` の `run_k05_baseline.py`、`k05-baseline-summary.json`、`k05-{related,root}-tests.json`、各log、`k05-failure-classification.md` にenv/command/hash/失敗fullNameを保持。以前の失敗報告も上書きせず保持。

K05はbaseline採取まで。未確定4件の根因・再現性を含む完全な比較可能性は未確定。製品変更後のK07、Compass試験、実モデル/GCP、実決済・配信・finalityはこの結果で代用しない。

## 入力契約修正後の再実測（2026-10-15 09:55 JST）

Codexによるprobe入力とローカルPython runnerの修正、Claude Code Opus5.5の独立LGTM後、親が全体回帰を再実行した。製品TypeScript・既存testsは変更なし。元runnerを複製し、実行識別子と専用TMPだけを `.k6` / `contract-regression-*` に変更。元の証跡は保存した。これはCodex sandboxで拒否されたL4 runnerの `127.0.0.1:18096` bindの再実行ではなく、既存の独立したRouter回帰試験である。

| 範囲 | pass | fail | skip | suite error | exit |
|---|---:|---:|---:|---:|---:|
| 関連 | 266 | 0 | 0 | 0 | 0 |
| 全体 | 2660 | 6 | 29 | 0 | 1 |

- Node/import/tsx preflightはPASS。package-lockと記録したtsx依存hashは前後一致、tracked diffなし。
- 新しい失敗IDはなし。ただし **全体未合格、無回帰を断定しない**。
- macOS `127.0.0.2` bindの3件と、repo内seed出力拒否1件は今回も失敗。host aliasや安全guardは変更していない。
- directory件数の失敗はArc単独とsolana-mpp-inの2件（いずれも期待1に対し2）。前回の6-rail件数とCLI timeoutは今回は通ったが、修正したわけではなく根因未確定。
- 別のPython試験は実parser 5・mock loop 3・起動guard 2が親実測PASS。修正入力8件のparser受理は、HTTP受理や実モデル選定の証拠ではない。
- 証跡: `.claude_workflow/local/contract-regression-baseline-summary.json`、`contract-regression-{related,root}-tests.json`、`contract-parent-verification.json`。実行期間09:53:42–09:55:17 JST。


## ローカルAPI実装後の再実測（2026-10-15）

親の `api-regression-baseline-summary.json` は関連266/0/0、全体2660/6/29（成功/失敗/skip）。直前 `contract-regression-baseline-summary.json` と失敗IDは一致し、root/依存fingerprintも一致した。root全体未合格・根因/完全比較可能性保留は継続する。Compass単体151/0/0・型検査・実TCPは別証拠として [API検証証跡](api-evidence.md) に記録。
