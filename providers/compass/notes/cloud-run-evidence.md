# CR1 Cloud Run 包装・offline証跡（2026-10-15）

本段は実装候補。クラウド、network、Docker、install、credentials/.env、git変更、旧workflow実行は行っていない。親baselineの全既存ファイルを追加・削除込みで検証した。既存製品src/catalog/config/試験と要件・設計・tasksは無変更。CR2独立レビューとparent検証、CR3実測は未完了。

変更7パス：`cloud-run/Dockerfile`、`cloud-run/launcher.mjs`、`cloud-run/patch_entrypoint.py`、`cloud-run/download_model.py`、`cloud-run/test-cloud-run.cjs`、本note、`.claude_workflow/local/run_cloud_run_probe.py`。

固定基準：parent baseline SHA256 `28db88e73bfdcba8942ec569ef25892a7b3bcb159de61536bf8d25053dd08286`。entrypointは親images.jsonのSHA256 `2bc01a85e6479079745214a2da7af70880d69313d3fbd7ce504c173fee031148` と照合する。model-manifest.jsonの全14ファイル（隠し2ファイル、README、Apache licenseを含む）をサイズ/hash検証し、全部成功後だけ.readyを作る。出所は既存model-evidence.md、固定djev OCI imageと親取得manifest。公式@zerc20/sdk/BUSLコードの複製なし。上流のnotice/licenseを保持し、それ以外の同梱物のlicenseへ推定を拡張しない。

起動は既存factory＋既存4候補catalog＋diagnostic 60/65秒。ingress8080/private API8081/model8082、proxy70秒、上限8192 bytes。healthはmodelの非推論health本文を検証する。boot UUID、要求終了、既存observerイベントを記録する。CUDA compatを保持し、NVIDIA driver library pathをassert、driver版とlibcuda候補を記録する。実driver適合を証明した記録ではない。

最初のbehavioral fixtureはentrypoint patch module未実装で **exit 1 / FileNotFoundError / AssertionError: entrypoint behavioral fixture**（RED）。実装後 **exit 0 / PASS patch fixed source, overlay ordering, private bind, compat**（GREEN）。その後のsocket-free試験もexit 0：

- `PASS baseline, 14-file download, corruption, symlink, deadlines, cleanup restart/ownership, service schema, explicit zero; real executor calls=0`
- `PASS watchdog shortened deadline, actual refusal durable unknown, no retry, STOP race guard; real executor calls=0`
- `PASS socket-free proxy health/path/header/body/abort/boot boundaries; cloud calls=0`

assemblyは既存tsconfigを既存tscでemitし、製品JS5件だけと固定包装・catalog/config/manifestsをpositive allowlist stagingする。全repo/TS tests/logs/tokenは送らない。実行結果はignoredの `cloud-run-run-cr1-first`、`cloud-run-run-cr1-final` 等のrun領域にある。初期assemblyは14ファイル、hash一覧追加後は15ファイル。後続修正前のcontextは実行へ流用せず、新規assemblyのcontext/plan hashをレビューする。

再実行可能なofflineコマンド（cwdは専用worktree、既存.c0専用HOME/TMP）：

```sh
env -i PATH="$PATH" HOME="$PWD/.c0/cr1-home" TMPDIR="$PWD/.c0/cr1-tmp" TMP="$PWD/.c0/cr1-tmp" TEMP="$PWD/.c0/cr1-tmp" CI=true npm_config_offline=true node providers/compass/cloud-run/test-cloud-run.cjs
env -i PATH="$PATH" HOME="$PWD/.c0/cr1-home" TMPDIR="$PWD/.c0/cr1-tmp" TMP="$PWD/.c0/cr1-tmp" TEMP="$PWD/.c0/cr1-tmp" CI=true npm_config_offline=true python3 -I -B .claude_workflow/local/run_cloud_run_probe.py --offline-assemble "$PWD/.claude_workflow/local/cloud-run-run-PARENT-UNIQUE"
```

run名のsuffixは小文字英数字/hyphenで6–48文字。上のPARENT-UNIQUEは実際の固有小文字値へ置換する。既存runを上書きしない。

controller用CLI（本段では実行していない）：

```sh
python3 -I -B .claude_workflow/local/run_cloud_run_probe.py --watchdog "$RUN_DIR" &
python3 -I -B .claude_workflow/local/run_cloud_run_probe.py --prepare "$RUN_DIR" --authorization "$PWD/.claude_workflow/local/cloud-run-probe-authorization-20261015.json" --baseline-sha256 28db88e73bfdcba8942ec569ef25892a7b3bcb159de61536bf8d25053dd08286 --worker-lock-fd "$INHERITED_LOCK_FD"
python3 -I -B .claude_workflow/local/run_cloud_run_probe.py --gpu "$RUN_DIR" --authorization "$PWD/.claude_workflow/local/cloud-run-probe-authorization-20261015.json" --baseline-sha256 28db88e73bfdcba8942ec569ef25892a7b3bcb159de61536bf8d25053dd08286 --worker-lock-fd "$INHERITED_LOCK_FD"
python3 -I -B .claude_workflow/local/run_cloud_run_probe.py --cleanup-only "$RUN_DIR"
```

親はterminalでwatchdogのPIDを追跡し、別process group・caffeinateを管理する。nohup/disownなし。prepare前にmanifestのplan全体をレビューし、表示されたplan hashを`parent_approved_plan_sha256`へ、容量/費用の根拠を`feasibility_evidence`へ、build service-agent/actAs/Run image pull/認証caller権限の照合根拠を`permission_evidence`へ記録する。これらは同じignored runのDATA。worker.lockは親が取得・継承し、FDを明示する。cleanup-onlyはworker.lock不要だが、run専用cleanup lockとSTOPでpaid mutationを遮断する。既定CLIは拒否。paid段階の再開は拒否し、再起動時はcleanup-only。

prep USD3、GPU USD2、contingency USD5。Singapore build E2_HIGHCPU_8 USD0.019188/min×30分、extra100GiB SSD USD0.000286438/GiB/hour、L4+8CPU32GiB USD1.705104/hを根拠に親が保存/通信等を検証する。クレジットは仮定しない。USD10は請求hard capではない。P+2h preparation cutoff、P+3h cleanup期限、GPU前に全3600秒が収まることを要求し、watchdogが短縮期限を認識してから1 createのみ実行する。

researchの旧「正のquota値をbuild前に要求」は撤回済みのcontroller計画前提であり、割当完了として扱わない。初回regional deploymentの標準nonredundant quota自動付与の記述を踏まえ、details={}だけでは拒否しない。親報告のrun API有効化、validateOnly HTTP200、list=[]/describe=not-foundは、実GPU利用可能性とは別。実拒否時は停止・cleanup、増枠申請/再試行/代替なし。

残るgate：CR2独立コードレビュー、parentの製品回帰・型検査、全controller stageのmock結合/child異常・signal実process検査、cloud API schema/IAM/async operation実照合、Docker RUNでのNode共有library検証、モデルdownload/ビルド、32GiB/L4とCUDA適合、実4選定、boot/log照合、最新active+idle明示zeroと再起動、cleanup/readback、最終請求。個々のoffline境界試験を全段階の検証完了とはしない。Mac停止・network断時のwatchdog保証はなく、常設hostingや下流購入は許可されない。

## CR2 修正と実クラウド試行 1回目（2026-10-15 UTC）

修正：impl r1 の MUST 8件（応答形、descriptor パス、AR DELETE、LRO/SA 待機、条件付き UNWRAP、非致命診断、結果不明 create の再読取、boot ログの page 処理）と、HTTPError の body 読取、post-wait 送信枠、selection の union 検証。各修正を1件ずつ戻すと該当 assert で失敗することを確認（15件）。Codex gpt-6-astra の read-only レビュー：r2 REJECT（2件）→ r3 APPROVE → r4（regional build の poll）APPROVE。最後の画像照合修正はレビュー前。製品 vitest 260/260、tsc 0、TCP smoke 0、baseline 不変。

実行（run `cloud-run-run-cr2-r2`、id `crp-570d562fb1e14b9d`、asia-southeast1）：repository・bucket・SA 2件・スコープ限定 IAM・context upload は成功。Cloud Build は1回だけ投入し、09:37:31Z–10:14:23Z に SUCCESS（モデル14ファイルを hash 検証、djev 上で Node v22.23.1、patch 後の entrypoint `802f7c0f…`、digest `sha256:16f3b812…`）。

harness の不具合が2件ありました。
1. regional build の操作名を global URL で poll していたため 404 が返り、それを「未完了」として扱っていた。prepare を mutation のない sleep 中に SIGKILL し、build resource を GET する方式に修正した（r4 で承認）。
2. `--finalize-build` が画像を「ちょうど1件」と要求していたが、実際の応答は同じ digest の `probe` と `probe:latest` の2件だった。照合に失敗し、既定の経路どおり cleanup が complete で終わった。

L4 service は作成していない。選定応答、scale-to-zero、コールドスタートはいずれも未計測。再ビルドは実施していない（失敗後の再試行は owner 判断）。

削除確認（harness とは別の gcloud 読取、10:29Z）：Run service なし、AR repository は NOT_FOUND、bucket は 404、SA 一覧はデフォルト compute SA のみ、実行中の build なし。概算費用は build 約37分で約 USD0.7＋保存・通信がわずか（請求は未確認）。

## 実クラウド試行 2回目（owner 承認後、2026-10-15 UTC）

run `cloud-run-run-cr2-t2`、id `crp-3b9c97e181fd4b69`。Codex r5 は APPROVE。

- build：1回、10:3x–11:15:45Z に SUCCESS。digest `sha256:eb74bcec…`、prepare は exit 0。
- GPU：11:16Z に L4 service を1回 create。11:20:35Z に container が起動し、Cloud Run の診断値は `nvidia-ld-path=present`、`driver=580.126.20`、`unwrap=not-needed`。
- 11:21:28Z に vLLM 側の `torch.cuda` が **Error 803: system has unsupported display driver / cuda driver combination** を出して exit(1)。startup probe の失敗として operation がエラーで終わった（code 9）。
- 原因：image の LD_LIBRARY_PATH は先頭に `/usr/local/cuda-13.0/compat` を置いている。この compat libcuda は Cloud Run の新しいドライバと合わない。VM で compat を隠して回避したのと同じ現象で、`compat_policy: preserve` の前提が誤っていた。
- health 200、選定応答、scale-to-zero、コールドスタートはいずれも未到達。再試行は実施していない。
- 削除確認（11:23Z、別の gcloud 読取）：service なし、repository は NOT_FOUND、bucket は 404、SA はデフォルトのみ、実行中の build なし。
- 概算費用：build 約40分で約 USD0.8、L4 は起動から失敗まで数分で約 USD0.2 以下。2回の累計で約 USD1.8（請求は未確認）。

## 実クラウド試行 3回目：成功（owner 承認後、2026-10-15 UTC）

run `cloud-run-run-cr2-t3`、id `crp-4afa9e46035241b2`、asia-southeast1、L4 1台・8 vCPU・32 GiB・min 0 / max 1・concurrency 1。

変更（Codex gpt-6-astra：r6 REJECT 3件 → r7 REJECT 3件 → r8 APPROVE）：`images.json` の `compat_policy` を `hide` にし、`patch_entrypoint.py` が LD_LIBRARY_PATH から `/usr/local/cuda-13.0/compat` を外す（VM の空 compat マウントと同等）。親 baseline は images.json の項目だけ再生成（新 hash `28db88e7…`）。GPU 起動失敗（Cloud Run operation code 9・startup probe 失敗と明示分類できた場合のみ）に対し、同じ image と runtime SA を保持して同じ GPU 1時間の枠内で 1 回だけ再試行できる経路と、起動コマンドの上書き（`command`/`args` のみ）を追加。各修正は元に戻すと該当試験が失敗する。今回の実行ではどちらも使われていない。

- build：1回、11:47Z 投入、12:22Z 完了（約 35 分）。digest `sha256:f2d78cd4…`。
- GPU：12:22:49Z に create。instance 起動は 12:31:30Z（割当まで約 8.5 分）。compass_boot 12:31:35Z、driver 580.126.20、vLLM engine 初期化（vram 22.0 GiB、sm 8.9）、ENGINE_READY 12:34:11Z（起動から 151 秒）。
- 選定（live model、同一 instance `9c175ca4`、catalogSha256 `7db0f0d1…`、modelSource `live`、purchaseEnabled/paid false）：
  - eth-perp → `hyperliquid_eth_perp` 11.1 秒（readiness 後の初回推論。cold start ではない）
  - sol-perp → `hyperliquid_sol_perp` 0.4 秒
  - uniswap-spot → `uniswap_usdc_weth_spot` 0.3 秒
  - topic-search → `exa_search` 3.1 秒
- scale-to-zero：最終要求 12:34:33Z。Monitoring `instance_count` が 12:46:00Z に active 0 / idle 0 を明示。
- ゼロ台からの復帰：12:47:04Z に要求送信、12:47:05Z instance 起動（AUTOSCALING）、boot `18b159cd`、ENGINE_READY 12:49:31Z、応答 12:49:46Z。要求から応答まで **161.3 秒**、選定 `hyperliquid_eth_perp` で一致。result `observed-zero-restart`。boot ログ照合：2 boot、要求側 boot 2件とも一致、欠落なし。
- GPU 課金時間：create 12:22:49Z → cleanup 完了 12:50:32Z で約 28 分。
- 削除確認（12:50:47Z、harness とは別の gcloud 読取）：service は Cannot find、repository は NOT_FOUND、bucket は 404、SA はデフォルト compute SA のみ、実行中の build なし、ローカルの probe process なし。
- 概算費用：build 約 USD0.7 + L4 約 28 分 約 USD0.8 ≒ USD1.5。3 回累計で約 USD3.3（請求額は未確認、credit も未確認）。

既知の未修正（nonblocking）：`main()` が cleanup 後に書く `gpu_seconds_used` は cleanup lock の外で書かれ、watchdog の cleanup pass に上書きされた（manifest に値がない）。再試行経路の枠計算に使う値なので、次回変更時に lock 内へ移すこと。今回は再試行が不要だったため影響なし。
