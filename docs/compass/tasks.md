# SubEtha Compass タスク分解案

## 0.4 Compass Provider のタスク（2026-10-15 夜〜、要件 §0.4 改訂 6・設計 §0.4 改訂 3 に基づく、改訂 2）

順序と allowlist。owner の方針：PR #192 を先に出し、Provider 化は進められる範囲で進める。各段は独立レビュー（Codex gpt-6-astra read-only）→ parent 検証の順。worker.lock は parent が保持。tasks レビュー r1（`.claude_workflow/local/compass-provider-review-tasks-r1-result.md`、REJECT 5 MUST）を反映。**P-0 が全段の前提**：要件 §0.4 の停止規則に従い、承認記録 `compass-provider-authorization-20261015.json` の `stop_rule.owner_confirmed` が true になるまで **P-1 以降（実装を含む）を開始しない**。

| 段階 | 作業と完了条件 |
|---|---|
| P-0 owner 入力（gate） | (a) `stop_rule` の確認（`owner_confirmed=true` を parent が承認記録へ記入、owner の発言を引用）。(b) 受取アドレス `PAY_TO`。(c) 受入の支払い入力：直接購入用の **専用** Base Sepolia payer（新規鍵、USDC 少額と gas 不要の EIP-3009）、Router 経由用の controller の Arc testnet USDC（専用の少額、既存 E-FAC/T8 系の鍵は使わない）、(9) の少額損失。これらを承認記録に追記してから P-1 へ |
| P-1 x402 ゲートと公開モード（offline） | `providers/compass/cloud-run/x402-gate.mjs`（新規）、`launcher.mjs`（公開モードの分岐のみ追加）、`test-cloud-run.cjs`（公開モード fixture の追加。既存 fixture は不変）。設計 §0.4 手順 1〜12 の全分岐を偽 facilitator・偽 GCS・偽 clock で試験。`PROVIDER_MODE` 未設定の既存経路は既存 fixture 全件で不変、公開モードで `/internal/v1/select` が 404、ログに credential/prompt が無いことを assert。wire fixture は `src/adapters/inbound/x402.ts` と `providers/x402-workers` の試験 fixture から写す。各修正は sabotage（戻すと RED）で確認 |
| P-2 harness の公開段（offline） | `.claude_workflow/local/run_cloud_run_probe.py` に `--publish`／`--readback`／`--stop`／`--reconcile` と cleanup の bucket 対象を追加。gates は設計どおり（新承認記録の hash、`owner_confirmed`、baseline、plan 承認、context hash、lock、watchdog 不要）。fixture で検証する完了条件：`owner_confirmed` false での拒否；`--publish` が組む **service spec（concurrency 2、env 5 種、min0/max1、L4、probe）・`allUsers` invoker・非公開 nonce bucket（uniform、PAP、soft-delete 0、versioning off）と runtime SA への objectAdmin のみ**；公開失敗時の cleanup（service と bucket を削除、image 保持）；保持 manifest（`retained_resources`、`delete_on`、`stop_rule` 状態）；GPU 時間の保守的積算（active/idle/欠測）と 6 h `warn`／8 h `stop_due`；`--stop` の対象（service と invoker binding だけ）；`--reconcile` の遷移。offline assembly が新ファイルを context に含むことを確認 |
| P-3 独立レビュー＋parent 検証 | P-1/P-2 の実差分、README-provider.md の初版、controller（`L/run_cloud_run_controller.py`）の変更を Codex が read-only でレビュー（MUST 閉鎖まで）。parent は全試験・tsc・製品 vitest・baseline・sabotage を再実行 |
| P-4 運用の成立と build・公開 | 公開前に成立させ、確認証跡を manifest に残す：Cloud Billing 予算 USD30（50/90/100%、owner 宛通知）の設定（owner）、`--readback` の 6 時間以内の実行計画と担当（parent）、6 h 警告・8 h 停止・90% 通知時停止・6 時間以上の監視中断前の停止の手順（parent）。その後、新 image の build（約 40 分、1 回）→ `--publish` → `/health` 200 の確認 |
| P-5 受入（要件 (1)〜(11)） | 設計「受入の実施順」どおり：(6) 開示文の存在 → (11)/(5) cold の観測（platform 保留、600 秒 timeout 後の再確認の結果、busy 503；アプリ到達後の model 未準備は未解決と記録）→ (1) 直接購入：`delivered`、settle tx hash、`PAYMENT-RESPONSE` の `transaction` と GCS `settled` 記録と `bootId` の照合 → (2) Router 経由 `dyn-arc-to-x402`：quote→purchase が **195 秒以内**に `delivered`、Router の `paymentId` と Compass 側 settle tx の照合 → (3)(4)：facilitator 呼出ログで verify/settle **0 回**、応答 503/402/409 → (8)：配信済み credential を **instance 0 の観測後**に再提示し、新 `bootId` の instance が 409（`recorded:settled`、`paid:yes`）を返し、facilitator 呼出 0 回・内部 API 呼出 0 回をログで確認；controller が置いた `settling` だけ／`accepted` だけの記録でも同様に 409（`paid:possibly`／`paid:no`）と呼出 0 回 → (9)：Router 側 `paid_data_unavailable`（inbound 損失を Router の記録で確認）、Compass 側 verify/settle 0 回 → (10b)：ローカルの偽 facilitator（settle に応答しない）で `settling` 遷移 → 終了 → `unknown` 遷移 → 502 `{status:unknown}` の順を fixture で確認し、実 bucket へ staging 用 key の create→遷移を 1 回行って `ifGenerationMatch` の挙動（412 を含む）を実機で確認。(10a) は `--stop` 時に実施：推論中に service を削除し、応答 503、facilitator settle 呼出 0 回、チェーン上で `authorizationState(from, nonce)` が未消費、GCS 記録が `accepted` のままであることを確認。(7) は 10/29 に実施。(10a)(7) まで **受入は未完**。観測後に README を更新する。結果は `providers/compass/notes/cloud-run-evidence.md` に追記し、`--readback` を 6 時間以内の間隔で運用 |

変更 allowlist：`P/cloud-run/x402-gate.mjs`（新規）、`P/cloud-run/launcher.mjs`、`P/cloud-run/test-cloud-run.cjs`、`P/cloud-run/README-provider.md`（新規）、`P/cloud-run/Dockerfile`（新ファイルの COPY 1 行。env の既定は置かない）、`L/run_cloud_run_probe.py`（offline assembly の context allowlist に新ファイルを加えることを含む）、`L/run_cloud_run_controller.py`、`P/notes/cloud-run-evidence.md`、`docs/compass/{requirements,design,tasks}.md` の **§0.4 のみ**。parent 専用：`L/cloud-run-parent-baseline.json`（P-1 開始前に現状を固定し、新規 2 ファイルを allowlist に **追加するだけ**、既存項目の hash は変えない）と `L/compass-provider-authorization-20261015.json`（P-0 の追記）。製品 `src/`・catalog・config・probe・既存試験・Router 本体は変更しない。

完了の意味：P-5 の (1)〜(6)、(8)、(9)、(10b)、(11) の観測が上記の完了条件で記録され、`--readback` が運用されている状態を「公開中・受入進行中」とする。(10a) と (7) は後日の実施まで未完、(11) のアプリ到達後の未準備は未解決として、いずれも全受入完了とは区別する。

## 0.3 Cloud Run L4試行の完了記録（2026-10-15）

CR1〜CR3は完了した。独立レビューは実装 r1（`L/cloud-run-review-impl-r1.stdout`、要修正8件）→ r2〜r8（`L/cloud-run-review-impl-r{2..8}-result.md`、Codex gpt-6-astra read-only、r2/r6/r7 REJECT、r3/r4/r5/r8 APPROVE）、docs r1（`L/cloud-run-review-docs-r1-result.md`）。各修正を1件ずつ元に戻すと該当試験が失敗することを親が確認した（`L/cloud-run-impl-r4-sabotage.py` の一意15件と `L/cloud-run-impl-r6-r8-sabotage.py` の10件、実行出力 `L/cloud-run-impl-r6-r8-sabotage.out`、計25件）。製品vitest 260/260、tsc 0、TCP smoke 0、baseline一致（親の記録 `.claude_workflow/state.json` `cloud_run_scope`）。

| 試行 | run | 結果 |
|---|---|---|
| 1 | `cloud-run-run-cr2-r2` | build成功（約37分）。harnessがregional build操作を誤URLで待機→停止。finalizeが2件のimage一覧を拒否→cleanup完了。GPU未作成。約USD0.75 |
| 2 | `cloud-run-run-cr2-t2` | build成功。L4 service作成、container起動、CUDA error 803（compat）→startup probe失敗→cleanup完了。約USD1.0 |
| 3 | `cloud-run-run-cr2-t3` | build成功（約35分）。4選定すべて正しい、明示zero、新instanceで再開161.3秒、`observed-zero-restart`、cleanup完了・別読取で不在確認。約USD1.5 |

CR1 allowlistへの追加変更: `L/images.json`（compat_policy hide、親の固定入力を親が変更）、`L/cloud-run-parent-baseline.json`（images.json項目のみ再生成）、`L/run_cloud_run_controller.py`（親のwatchdog/stage起動用、新規）。各レビューと各有料段の起動コードはworker.lockを排他取得してから子processを起動する（`L/run_cloud_run_stage.py`、`L/run_cloud_run_controller.py`）。

残タスク（すべて新規承認が必要）: (a) `gpu_seconds_used` のlock内書込（nonblocking修正）; (b) 実請求額の確認; (c) 常設化・課金・API Provider化は本範囲外。

## 0.2 使い捨てCloud Run L4試行のタスク（2026-10-15・最新）

要件§0.2・設計§0.2と独立LGTM `cloud-run-review-requirements-r2.stdout`／`cloud-run-review-design-r2.stdout` を基準とし、本節を今回の順序・allowlistとする。下の旧本文は保存する。既存4候補のローカル受入を利用し、Router/source・旧cold C3〜C7はHOLD、旧11ケースframeworkを依存条件にしない。今回は `docs/compass/tasks.md` だけを編集する。Codex gpt-6-astra author、Claude opus-5-5独立read-only reviewer、controller所有worker.lock下の単一workerを維持する。workerはlock/stateを操作せず、cloud/network/Docker/install、credentials/.env、署名/支払、git変更、他worktree書込を行わない。現在のbranch/rootを保持する。

owner承認済みの範囲は現DiffusionGemma NVFP4、`subetha` / `subetha-compass` / Singapore `asia-southeast1`、L4×1・8CPU・32GiB、service/revision min0/max1・concurrency1・nonredundant、準備込みUSD10、GPU最大1時間と全専用資源cleanupである。認証された外部呼出主体による実モデル4資源選定とobserved-zero後の再開を試す。常設・未認証公開・下流API購入/支払は含まない。通常の各段でowner承認を取り直さず、独立レビューとparent検証を順に通す。以下はすべてpendingであり、本タスク独立レビューLGTM・parent read-back後にCR1へ進む。

| 段階 | 作業と完了条件 |
|---|---|
| CR1 offline packaging実装 | 親の凍結入力を照合し、下記7パス内だけで最小包装・有界controller harness・mock試験と証跡noteを作る。Docker/network/依存追加なし |
| CR2 独立レビュー＋parent検証 | Claude opus-5-5が実差分をread-onlyレビュー。parentがallowlist・全src不変・入力/context hash・offline試験と型検査・cleanup故障経路を検証し、LGTMと実行証跡を揃える。レビューからcloudを実行しない |
| CR3 bounded cloud実行＋無条件cleanup＋結果レビュー | controllerだけが費用/期限/所有範囲gateを確認して1回のbuildと実作成・最大5要求を実行し、全経路でcleanup/readback。親の生証跡照合とClaudeの独立結果レビューで達成/partial/残存を判定する |

**Controller補足（tasks-r1 MUST閉鎖、2026-10-15）。** 以下を同節の具体化として優先する。追加のframework・製品機能は作らない。

- baselineはCR1の**前にparent**が採取する。P全体（以下の新規allowlistだけ除外、catalog/config/probe/test/package/tsconfigを含む）と親入力 `L/model-manifest.json`,`L/images.json`,`L/cloud-run-source-entrypoint.sh` のpath/size/SHA256を固定する。baselineはworker書込禁止のcontroller専用 `L/cloud-run-parent-baseline.json` に保存し、そのファイル自体のhashをparentのtool記録へ残す。CR2とCR3前に追加/削除込み完全一致を確認する。OS権限による隔離ではなく、worker allowlistと外部記録hashで改変を検出する。
- watchdogは新規実装ファイルを増やさず `L/run_cloud_run_probe.py` の `--watchdog <run-dir>` / `--cleanup-only <run-dir>` 入口に置く。parentが通常terminalのbackground追跡で別process groupとして起動し、起動receiptとpidを確認する。権限は既存gcloudの明示configurationのみ、秘密file読取なし。固定run-dirの状態と所有IDだけに作用し、cleanup確認後に終了する。実controllerとは別processなのでcontroller crash/SIGKILLには耐えるが、Mac停止・停電・ネットワーク断まで保証するcloud側のhard capではない。parentは試行中caffeinateでsleepを抑止し、定期確認・期限前cleanupと併用する。この残存リスクを有料開始前に利用者へ明記し、保証と称さない。自己拡張したcloud schedulerは作らない。
- 有料準備Pより前にparentが配置/取得/展開/cache/重複copy・RAM/VRAMの成立見込みと時間/費用を根拠ノートへ記録し、根拠不足なら停止する。今回の実測根拠は同じ固定モデル・L4・16GiBホストRAMで旧8件の実行が成立したこと（model-evidence.md）。32GiB containerでは重みをread-only imageから読み、全量tmpfsコピーを排除する。これはcacheを含む実peakやCloud Run driver適合の証明ではなく、試行可能性の根拠である。未知peak自体を追加frameworkで実測してから試行するという循環前提にしない。
- worker/parentのoffline試験コマンドは `node providers/compass/cloud-run/test-cloud-run.cjs` と `python3 .claude_workflow/local/run_cloud_run_probe.py --offline-assemble <固有run-dir>`。環境はPATHのみ継承、HOME/TMPDIR/TMP/TEMPを既存.c0配下の専用dir、CI=true、npm_config_offline=trueとし、CLOUDSDK_*/GOOGLE_*等は継承しない。実行はsocket-free/mock executorだけ、real executor呼出0をassertする。既存product/typesは既存run_cold_check.pyを使用。既定実行は拒否し、実cloud modeはparentの明示mode・承認file・固定manifest・実worker.lock・親baseline一致・watchdog確認が全部ある場合だけ許す。tokenはgcloud stdoutからメモリだけで受け取り、argv/receipt/log/noteへ保存しない。
- 有効APIの有限allowlistは `run,cloudbuild,artifactregistry,iam,iamcredentials,logging,monitoring,storage,serviceusage,cloudresourcemanager` の各 `.googleapis.com`。run/cloudbuild/artifactregistry/iamは今回有効化済み、他は既存状態を事前照合する。cloudresourcemanagerがIAM操作上必要ならcontrollerのみ有効化可能とし、これ以外の追加APIが必要なら停止する。終了後はAPIと自動作成された既定service agentを有効のまま保持し、既定agent/共有IAMを削除しない。今回専用identity/その明示binding・専用bucket/image/serviceは削除対象。自動default bucket/cacheは許可せず明示専用bucketを使う。

**CR1の変更allowlist（7パスのみ）。** `P=providers/compass`、`L=.claude_workflow/local`。既存src/catalog/probe/config/package/依存・既存試験を変更しない。不足なら黙って拡張しない。

| パス | 最小責務 |
|---|---|
| `P/cloud-run/Dockerfile` | 固定amd64 imageからNodeを持込む派生image、固定モデルのread-only層、shard別COPY。最終serving base内のbuild RUNでコピー済みNodeと必要共有libraryの実動作を検査 |
| `P/cloud-run/launcher.mjs` | 設計どおり既存factoryの4候補opt-in、private model/API、認証付きingress向け限定proxy、health/child監督、boot UUID・有限timeout/終了。新routingやschema変更なし |
| `P/cloud-run/patch_entrypoint.py` | 親固定source SHA・置換数を照合する限定変換。overlay後UNWRAP、model loopback、TEST_PAGE無効化、copy回避と実効path検査 |
| `P/cloud-run/download_model.py` | cloud build内だけで固定revisionの原本14ファイル全件をsize/hash照合し取得、全件検証後だけ.ready生成。offline検査ではmock I/O |
| `P/cloud-run/test-cloud-run.cjs` | 既存Node/Pythonによるsocket-freeの包装・境界・harness故障試験。新依存なし、mockを明示 |
| `L/run_cloud_run_probe.py` | controller専用の単一有界harness。明示command生成・allowlist staging・期限/費用・serial要求・所有資源cleanup・cleanup-only再開。workerは外部実行しない |
| `P/notes/cloud-run-evidence.md` | 出所/変更/固定hash、offline結果と実測の区別、CR3後の受入・未達・残存・請求未確認を記録 |

親が実装前に `L/model-manifest.json` と `L/images.json` を凍結供給する（workerは作成/変更せず読取のみ）。元model14ファイルは `.gitattributes`・`.quant_summary.txt`・README/licenseも保持し、全filename/size/hashを照合する。serving/Node22.23.1-bookworm-slim/Python3.12-slim-bookworm/docker builderのdigest/platformと元entrypoint SHAは親入力を正本とし、会話から転記して確定扱いにしない。欠落/不一致は実装の該当部分を停止し推測しない。CUDA_VERSION13.0.2、NV_CUDA_CUDART_VERSION13.0.96-1、unversioned cuda-compat-13-0ではcompat libraryの正確な版は未確定なので、既定はcompat保持。VMのempty-compat mountを移植せず、実効 `/usr/local/nvidia/lib64` と実driver/libcuda解決先を記録する。実RAM/VRAM適合は未検証とする。

ローカルassemblyはharnessのoffline専用入口から既存 `node_modules/typescript/bin/tsc` を使い、既存tsconfigを読取り、出力先だけ固有ignored stagingへ指定してemitする（設定・source変更なし、noEmit解除、incremental無効）。開始前に `P/src` 全ファイルの相対path/bytes SHA-256をbaseline化し、実装後と親検証時に追加/削除を含め完全一致を確認する。contextは上記5包装ファイルのうちbuildに必要な4ファイル、emit済み必要JS、最小ESM宣言、`catalog/demo-selection.json`・`config/deadline-policy.json`、親の2manifestとhash一覧だけを明示allowlistで組み立てる。試験・raw log・全repo・履歴・秘密を送らず、各path成分のsymlink/逸脱・特殊fileを拒否し、staging一覧とhashを親が照合する。source baseline・context・mock出力・receiptはharnessの固有ignored run領域内の生成物だけとし、新たな実装ファイルを増やさない。

**CR2の受入。** 既存Node/Python/tscだけで直列に検査する。固定hash/14件欠落・置換数不一致・symlink逸脱拒否、copy回避・compat保持、最終baseでのNode検査がrecipeに存在すること、proxy境界/上限/abort・health非推論・child異常/終了、boot identity、最大5件/再送禁止、期限等号/残費用不足、build失敗・quota拒否・parser失敗・signal・watchdog・cleanup-only再起動・所有ID不一致をmockで検証する。offline試験でDocker RUNやGPU動作成功とは記録しない。親はscrub環境と固有logを使い既存製品suite/typesも既存helperで検証し、受入済みsourceの保存を確認する。tool拒否は保持し、実行系/modelの代替や旧C3〜C7起動で迂回しない。

**CR3の有料操作前gate。** controllerは全commandへproject/configuration/regionを明示し、固有run IDに結び付く専用service/revision、registry、source/log bucket、build/runtime identity、一時IAMだけをmanifest化する。既存共有resourceと衝突なら停止する。buildのmachine/disk、展開・download・layer重複の容量、30分build費・最大3h保存/通信/log/cleanup・GPU1hを合算しUSD10未満の余裕を確認する。source/log/cacheの行先を明示し、暗黙staging/cache bucketを作らせない。bucket soft-delete/versioning/retentionも残存課金がない設定を確認する。最小IAM・service agent/image pull/actAs差分も対象を限定する。buildは最大30分・1回・retryなし、Macへのモデルdownload/Docker/installなし。最終image digestは元manifest hashに結ぶ不変receiptへ記録し、そのdigestだけをdeployする。startup probe最大900秒、Cloud Run request600秒、model60/API65/proxy70秒の実template整合を確認し、validateOnlyを起動成功としない。

researchの旧「正のGPU quota確認前は有料build不可」はcontrollerの計画訂正として撤回する。公式の初regional deployment時nonredundant標準3 L4自動付与は手動申請や3台使用承認ではない。`details={}` は正の割当でも拒否でもなく、親のvalidateOnly HTTP200と後続list=[]/describe=not-foundは実service未作成の証拠に留まる。初回前の数値欠落だけでは止めず、実作成は承認枠内で行い、実quota拒否で停止、手動増枠・再試行・region/GPU/model/executor代替なし。`run.googleapis.com` は既に有効化済みの構成変更として報告し、有効のまま残す（課金serviceの残存とは分離）。

最初の有料資源直前をP、準備期限P+2h、全資源cleanup/readback期限P+3hとする。**有料資源より前にcontroller本体から独立したdeadline cleanup watchdogを登録・動作確認**する。controller crash/SIGKILL後も動く最小の単発監視とし、大きなschedulerを作らない。永続run stateには予定ID・所有根拠・作成要求/結果・絶対期限を記録し、再起動はcleanup-only、paid callの暗黙再開は禁止する。watchdogはGPU作成前に短縮期限を確実に反映し、未確認なら作成しない。signal/finally/watchdogは推論成功・response parserに依存せずcleanupへ進む。

GPU最初のcreate要求開始をG、D=min(G+3600秒,P+3h)、削除/readback reserveを最低300秒（必要なら増加）とする。G+3600秒全体がP+3hに収まらなければ作成しない。deploy/readiness・min1相当で稼働し続ける起動/idle・zero待機も同じ枠と費用へ算入し、min0で即停止するとは推定しない。各開始前に残時間/費用を検査し、期限不足なら未試行のままcleanupする。期限はhealthや再起動でリセットしない。

要求は既存 `probe/demo-cases.json` の `eth-perp,sol-perp,uniswap-spot,topic-search` の順で固定し、expectedをモデルへ送らずcontrollerが照合する。初回最大600秒、次の3件各70秒、観測zero後ETHを最大600秒の計最大5推論を直列実行する。最初のerror/誤選定/timeout/unknown/予期しないboot変更で停止し再送しない。初回を無条件coldと呼ばず、deploy起動済み初推論とrequest起因coldを分け、次3件は同じbootでのみwarmとする。応答 `X-Compass-Boot-Id` を実起動ログのboot/process identityに照合し、受領時間・起動/load・model/API時間を分離する。

zero観測のdescriptor/query/aggregationはofflineで選定・レビューし、実descriptorと明示zero取得可否はcontrollerがruntimeで照合する。初回deploy前のlive zero sampleを前提にしない。4要求後はingress pingを停止し、`run.googleapis.com/container/instance_count` の対象service/revision全series・active/idle全stateを被覆する最新要求後の鮮度ある明示0とraw timestamp/値を保存する。欠測・series消滅・補間/丸めをzeroとせず、待機終端は動的にD−reserve−600秒。未観測はpartialで打切り、zero後の1要求だけ新bootと実ログを照合する。強制restart/redeployなし。

成功・失敗・拒否・中断を問わず、進行buildのcancel/終了確認、service/残revision、専用image/registry、全source/log/cache object/bucket、専用identity/一時IAMを所有ID照合後だけ削除/復元する。任意の共有/project資源を削除しない。別readbackで全対象の不在/復元を確認し、削除失敗・不明は残存と期限を明記、zeroをcleanup完了としない。結果noteと独立レビューではmock/real、試行数/有効回答数/正答数、4資源受領、初回cold/warm/post-zero、cleanupと請求確認を別gateとして記録する。実容量・メモリ・起動・明示zero・最終請求の未達を成功へ読み替えない。

## 0.1 既存4資源デモの最新タスク（2026-10-15）

要件・設計の最新§0.1と独立レビュー `demo-review-requirements-r1.stdout`／`demo-review-design-r2.stdout`（ともに `.claude_workflow/local/`、LGTM）に基づく。本節を今回の範囲・順序・allowlistの基準とし、以下の旧本文を保持する。cold workflow・cronはHOLD、C3〜C7の自動続行・依存化なし。拒否されたcron payloadの再試行ではない。
今回の書込は `docs/compass/tasks.md` だけで、製品変更・テスト実行はしない。Codex gpt-6-astraがauthor、Claude opus-5-5が独立read-only reviewer。controller所有worker.lockを継承し、第二worker・state編集・lock操作・並行テストは禁止。本タスクの独立レビューLGTM後にのみD1へ進む。

**D1（ローカル受入完了）：新catalogの明示opt-inから合成API応答までを一つの小さな縦断RED→GREENで実装。** Controller追記：親260件・型検査成功、独立Claude opus-5-5実装LGTM。原本は `.claude_workflow/local/demo-parent-r1.json` と `demo-review-impl-r1.stdout`、詳細は `providers/compass/notes/demo-selection-evidence.md`。実モデル品質・GPU・購入E2Eは未検証。以下は実施時の契約を保持する。`P = providers/compass` とし、製品変更allowlistは次の6パスだけ。範囲不足なら停止して別途レビューし、黙って拡張しない。

| パス | D1の変更 |
|---|---|
| `P/src/catalog.ts` | 新版の型・検証と新版だけの共通指示追記 |
| `P/catalog/demo-selection.json` | 設計の固定4資源metadataを新規追加 |
| `P/probe/demo-cases.json` | 設計の英語intent 11件を期待値資料として新規追加 |
| `P/test/demo-selection.test.ts` | socket-freeの縦断・境界・旧版回帰試験を新規追加 |
| `P/vitest.config.ts` | 新testのincludeだけ追加、単一worker・fileParallelism:falseを維持 |
| `P/notes/demo-selection-evidence.md` | 変更・実検査・根拠・未達gateだけの小さな証跡note |

D1開始時、parentだけがcontroller所有worker.lock下で、**ソース編集前に一度だけ**旧catalogのbaselineを採取する。cwdは本worktree root、環境は `run_cold_check.py` と同じscrub済み環境（PATHだけ継承、HOME/TMPDIR/TMP/TEMP・npm cache/configは同じ `.c0` 配下、CI=true・npm offline=true、その他は継承しない）とする。既存nodeで次のinline moduleだけを実行する。
`node --import tsx --input-type=module -e 'import { readFileSync } from "node:fs"; import { createHash } from "node:crypto"; import { loadCatalog, buildRequest } from "./providers/compass/src/catalog.ts"; const task = "Get the Hyperliquid ETH perpetual mark price and 24-hour change."; const raw = readFileSync("./providers/compass/catalog/selection.json"); const body = JSON.stringify(buildRequest(loadCatalog(raw), task)); const bytes = Buffer.from(body, "utf8"); console.log(JSON.stringify({task, body, sha256: createHash("sha256").update(bytes).digest("hex")}));'`
parentは正常終了したstdoutのJSON `{task,body,sha256}` を `.claude_workflow/local/demo-legacy-request.json` へ排他的に新規保存し、上書きしない。これはhelper-only検査規則に対する明示的な一回限りのparent準備操作の例外であり、workerの試験迂回や拒否済みC3 payloadの再試行ではない。listener/network・新local source/script・npm実行なし。拒否時は当該操作を停止し、迂回しない。
このsnapshotはworkerの書込allowlist外で、workerは読むだけとし、欠落/不整合なら停止する。sourceは未追跡なのでHEADからimportしない。新testへ元のserialized本文を固定literal、記録済みSHAをliteral定数として埋め込み、同じ固定taskで実builderのserialized UTF-8 bytesを元literalと直接比較しhashも固定SHAへ照合する。変更後builderから期待bytes/hashを再生成しない。
REDでは新test・includeと読込対象の新版JSONを先に追加し、旧版baseline回帰testがPASSし、新版testが未対応機能による `invalid_catalog` で失敗することを必須とする。欠落ファイル/importエラー・拒否・環境障害・時間切れをREDに数えない。GREENでは同じD1内でcatalog.tsを最小実装し、読込→request criteria→合成response検証→factory handler応答までの同じ受入を通して証跡へ記録する。
loaderは `directory-v1` の3件/`directory_listing_only` と `existing-resources-v1` の4件/`candidate_metadata_only` を分離し、新版ID集合を `hyperliquid_eth_perp,hyperliquid_sol_perp,uniswap_usdc_weth_spot,exa_search` に固定する。ID検証はsource整合だけでtask routingには使わず、旧ID検証仕様は不変。設計のexact keys・既存Unicode/byte/深さ/member/配列上限・deep freeze・canonical hashを保持する。
新catalogは設計表の順序・capabilities/requiredInputs全文・version/evidence/purchaseEnabledをdeep-equalで照合する。metadataへ実行URL・quote/価格値・chain/network設定・支払条件/許可を入れず、能力をpayabilityとしない。禁止fieldはexact keysと固定catalog完全一致で検査し、substring router/parserを追加しない。
`buildRequest` の既存指示末尾へ新版だけに付ける英文は次の一文に固定する：`If multiple resources are plausible or the requested price type is unspecified and cannot be distinguished, select needs_clarification.` 分岐は版だけで、task・ID・資産名・keyword・期待回答lookupによる選定は禁止。旧版の指示・wire・bytes/hashは不変。新旧criteriaは各snapshotのID＋2 sentinel（旧5/new6 keys）、stateはtask/選択版metadataだけ。
11件は設計通り、ETH perp・SOL perp・Uniswap spot・明示topic検索の4選定、曖昧なETH価格/価格一般のclarification、BTC exact価格のnone、topicなし検索のclarification、一般topic質問/更新情報のExa、unsupported tradeのnoneとする。BTC価格を検索で代替しない。期待choiceはtestの明示引数として注入し、transportでtaskを解釈しない。これはモデル選定品質試験ではない。
新test内だけに安定した合成request/response shimを置く。既存http試験に倣うPassThrough requestとWritable派生responseへsetHeader/statusCode・header/body蓄積を実装し、writableFinished/destroyed等のflags・finish/closeはWritableから継承する。`server.emit('request',...)` を使い、listener・実socket・実HTTP clientなし。各試験でtimer/streamを終了し、有界な合成transport/fake timerを使う。
受入は `boundary`（catalog版/件数/evidence/未知欄/禁止field/Unicode/byte等の拒否・freeze/hash・不正wire/確率）、`falsepayment`（制御可能なJSON応答のpurchaseEnabled=false/paid=false・購入条件/領収なし）、`modelSource`（wireはrecorded-fixture、試験名/noteは生成syntheticで実モデル記録ではない）のlabelsを明示する。
factory既定は旧3件の版/hashを保持し、明示catalogPath opt-inだけ新4件の版/hashになることを確認する。11件の200 chosen/needs_clarification/none、両方向の版不一致409とtransport呼出0、他版だけのchoice/確率keysおよび不正確率の502 model_invalid（共通Exaでも全keys一致必須）、notSentの502、timeoutの504→503 latch、入力不正400を検査する。既存error/unknown latch契約を変更しない。
旧catalog・probe原本・fixture・保存応答・既存試験を変更/弱化しない。model.ts/http.ts/server.tsとその試験、contracts.ts、tsconfig、package/依存、cold runtime・policy・local runner/clientも変更しない。新Provider・汎用framework・追加tracking文書を作らない。
上記parent baseline採取だけを例外とし、製品テスト・型検査は継承controller lock下で直列に、既存の確認済みhelper `python3 .claude_workflow/local/run_cold_check.py product UNIQUE_LABEL` と `python3 .claude_workflow/local/run_cold_check.py types UNIQUE_LABEL` だけを使う。各呼出に未使用の固有log tagを指定し、scrub環境/.c0を維持する。新local script・raw npm test・listener・C3 harnessは禁止。拒否された操作は停止、迂回/executor・model置換/自動quota再試行なし。実quotaは停止、時間上限は未完了。
D1 authorのRED/GREEN・types証跡後、Claude opus-5-5が6パスの実差分を独立read-onlyレビューする。parentが入力固定とallowlist・legacy保存をread-backし、同helperで既存201件＋新規全件の製品suiteとtypesを直列実行し、対象版・件数・exit・固有logを確認する。今回それらを実行済み/レビュー済みとはしない。
noteではETH/SOLのconfig/docs、SOLの既知unpaid HTTP402 description、README/docsの旧Uniswap Provider B、過去Exa有料成功のdocs/mainnet-first-route.mdを区別して参照し、新規取得しない。過去の根拠は現runtime・今回支払E2Eの証明ではない。本sliceの外部支払は未実施。
到達点はD1のローカル実装受入までで停止。その後の実モデル選定品質はfresh owner承認による明示的な実モデル/GPU gateであり、旧C3/C7や広範な回帰frameworkを依存条件にしない。購入・支払・配信E2Eはさらに別の未検証gate。ローカルmetadata/合成試験の完了でそれらを合格にしない。
commit/push/git変更・network/cloud/GPU/install/deploy/有料API/faucet/wallet/key/.envアクセス、Router core・他worktree・保護文書（docs/DEPLOY.md、CLAUDE.md、root README）の変更は承認外のまま。

## 0. 現行タスク：文書整合から最小ローカルAPIへ（2026-10-15）

本節が現行の順序と変更allowlist。[要件§0](requirements.md#0-現行要件選定--最小ローカルapi--課金2026-10-15)と[設計§0](design.md#0-現行設計最小ローカル選定api2026-10-15)に依存する。下の最初の区切り以降のK00〜K15・状態表示・「今回」は歴史的な課金版計画として保存し、旧基準・過去失敗を削除・達成扱いにしない。

今回の承認は初回起動時の待機・タイムアウト・完了ログの**ローカル設計見直しだけ**。authorはCodex `gpt-6-astra`、独立read-only reviewerはClaude Code `claude-opus-5-5`。parentがreplacement適用・対象版read-back・証跡とレビューmetadata保存を担当し、controllerが各bounded runのlockと入力固定を管理する。authorはread-onlyで、state/lock・source・fixture・証跡を変更しない。今回、テスト・install・network・gcloud・Docker・秘密/.env読取・commit・branch操作・公開・課金・deploymentを行わない。

### 0.1 今回の文書段と後続の変更ファイル

要件差分は `cold-requirements-review-r4.stdout`、設計差分は `cold-design-review-r4.stdout` でLGTM。本タスク差分はその後段の独立レビュー対象であり、LGTMを先取りしない。設計§0は変更せず、r4の任意明確化を下記C3/C4の実装条件に固定する。**新規実装・検証タスクC1〜C7はすべてpendingで、別途ownerの明示的な実装承認まで着手しない。**

先行API実装・独立コードレビュー・親単体151成功・型検査exit 0・保存fixtureによる実TCP確認は実装済み基線。その後、別承認のAPI経由GCP試行は初回 **10.010720秒で504 `model_timeout`**、API呼出1・transport試行1・有効回答0・残7件未試行となった。[API検証証跡](../../providers/compass/notes/api-evidence.md)を正本とし、「追加cloudを一度も実行していない」とはしない。今回の見直しでは新規cloudを実行していない。

旧直接probeの8/8は新APIの品質証拠ではない。run→healthの1598.572秒はprovisioning/download/load等の混合時間で、API SLAではない。同時間帯のJIT警告も要求別受理・完了の証明ではない。VM/boot disk/firewall/subnet/networkは削除済み、前回承認枠は消費済みで期限を再利用しない。

後続差分の変更allowlistは次の12ファイルだけとする（`P = providers/compass`、`L = .claude_workflow/local`）。表は将来の実装範囲であり、今回の編集許可ではない。

| 対象ファイル | 担当する差分 |
|---|---|
| `P/config/deadline-policy.json`（新規） | 要求単位の唯一のpolicy正本 |
| `P/src/model.ts`, `P/src/http.ts`, `P/src/server.ts` | snapshot検証・共有期限・受付reserve・observer・hook・terminal・policyIdentity |
| `P/test/model.test.ts`, `P/test/http.test.ts` | model/transport/handler/serverのsocket-free受入 |
| `P/test/tcp-smoke.ts` | parent専用の保存fixture TCP受入 |
| `P/README.md` | factory契約・期限と証拠の意味・試験手順。live起動手順なし |
| `L/live-api-client.ts`, `L/live-api-client.test.ts`（試験は新規） | 明示入口・identity/grant・絶対期限・計数・有界保存・socket-free試験 |
| `L/run_l4_api_probe.py`, `L/test_run_l4_api_probe.py`（試験は新規） | 明示入口・run予算・child監督・cleanup・socket-free試験 |

共有policyの実装は既存model/server境界内に置く。contracts/catalog、その試験、保存fixture、probe原本、`contract_parser`、startup、既存証跡は変更しない。package/tsconfig/Vitest/root設定・依存・lockfileを変更せず、新module・汎用proxy・汎用証跡基盤を追加しない。追加ファイルが必要ならallowlistへ黙って足さない。合成試験出力は専用一時領域、将来の新規private証跡は設計指定領域に限定する。C7回帰証跡だけは§0.3指定の `L/cold-regression-*` log/JSONとsummaryを追加許可し、既存証跡を上書きしない。

実装済みwire/input/security契約は設計§0.1〜0.3を維持する。strictな本文3欄、Unicode/JSON/byte上限、固定catalogと共通builder、固定dgemma wire・確率検査、固定error写像、loopback/Host/Origin防御、redirect禁止、暗黙proxy/環境変数利用禁止、`purchaseEnabled=false`／`paid=false`を保持する。候補はdirectory metadataのみ。既存試験を削除・弱化せず、reserveによる送出0が適用される期待値変更だけを明示する。

### 0.2 順序とテスト受入（実行は後続段）

依存順は **本タスク独立レビュー→parent read-back→別途実装承認→C1→C2→C3→C4→C5→C6→C7**。NEEDS_FIXは修正・再レビューし、未完了やtool拒否を成功へ読み替えない。

| ID・状態 | 実装対象と完了条件 |
|---|---|
| C1 pending | policy JSON、model/serverと対応試験。default 10/15/20秒・diagnostic 60/65/70秒、両reserve 1秒を設計§0.5どおり共有する |
| C2 pending | model/http/serverと対応試験。monotonic期限、送出前hook、拒否順・lease、独立terminal、最小observerを実装する |
| C3 pending | TS clientと専用試験。明示入口、identity/grant、各factory照合、絶対要求期限、計数、有界private保存を実装する |
| C4 pending | Python orchestratorと専用試験。承認期限変換、startup/child予算、bounded flush、always-finally cleanupを実装する |
| C5 pending | README・全差分のsocket-free TDD/型検査を完了し、独立コードレビュー、parentの対象版read-backを受ける |
| C6 pending | C5後、parentが通常権限で保存fixtureだけのloopback TCPを確認する |
| C7 pending | parentが既存安全runnerで関連/全体回帰を比較し、コードレビュー・実行証拠・残存失敗を照合する |

**C1：policyとtimer。** JSONは2KiB以下、固定key/schema/profile、有限正整数・70000ms以下・許可行・大小関係を検査してdeep freezeする。欠落、不正型、未知欄、任意時間上書き、`model+reserve == API` / `API+reserve == controller` はlisten前に拒否する。factoryの読込原本hash/profile/実使用行を `policyIdentity` として返す。modelは必須snapshotを受け取り、省略fallbackや再読込をしない。既存単独model試験にsnapshot、transport直呼出試験にclock/deadline contextを供給し、wrapperは第3引数をそのまま転送する。

| C1/C2受入 | 必須ケース |
|---|---|
| 全timer | 設計§0.5のtimer表を実コードと一対一で照合。modelの2 timerは同じ絶対期限。APIはhandler入口→finish、clientはHTTP開始直前→完読採用。17秒idleの置換はC3試験、180秒child待機・残り4分判定の導出値化はC4試験で検査 |
| 入力受信 | header 5秒、body 2秒、requestTimeout 15秒、確認間隔250msを維持。requestTimeoutを応答期限にしない。request/checkContinue/checkExpectation/closeで独自header timerを解除 |
| admission | 両profileで `API残り > model全予算+1秒`、client開始前に `client予算 > API全予算+1秒`。handler入口から4秒未満と4秒等号/超過、hook前後の不足を検査。model予算を短縮せず送出0 |
| 絶対境界 | `now >= deadline` は失効。timer callback未実行でも送出直前・完了採用・terminalで判定。接続遅延・継続chunk・再接続・wall clock変動で期限補充なし |
| 完了競合 | 期限後model完読はunknown latch、期限内completed後のAPI失効はmodel非latch。未確定でAPI失効/client切断は送出前証明がなければunknown。API finish/client完読の等号も期限内成功にしない |
| 終端 | timeout/abort/close/finish/late競合でmodel/API/client各terminal一度。unknown後のlate成功化・再送・解除0。期限内completedの非200/不正wireは技術失敗・非latch |

**C2：拒否・lease・hook。** 順序はmodel.ready（latch/未設定）→busy→既存header→lease/body→parse/catalog→context→予算→32KiB→hook→abort/予算再検査→model期限確定→実呼出直前検査。全拒否についてHTTP・固定detail・lease・実transport呼出数・送出有無を試験する。

| 拒否経路 | 受入 |
|---|---|
| latch/未設定・busy・header/route/media/framing | 既存優先順・固定errorを維持、実呼出0、新規leaseなし。latchはbusyより優先 |
| body上限/read_timeout・parse/Unicode/JSON・catalog不一致 | 既存error、実呼出0。body開始時に得たleaseをfinish/切断まで保持し一度だけ解放 |
| missing_attempt | 503 `not_ready`、非latch・実呼出0・evidence run停止。取得済みleaseを応答終端まで保持 |
| 重複handler/binding_mismatch | 既存優先拒否を維持し、そこを通過すれば502 `model_unavailable`。追加送出0・partial停止。元要求未確定ならabortし送出状態でlatch判定、採用済みcompletedは不変 |
| insufficient_budget/persistence_failed/pre_dispatch_hook_timeout | 502 `model_unavailable`、非latch・実呼出0・evidence run停止 |
| model送付32KiB超過 | 500 `internal_error`、非latch・実呼出0 |
| pre_dispatch_disconnect/pre_dispatch_api_expired | 新規応答なし・切断。送出前を証明できれば非latch |
| model期限確定後・実呼出前失効／明示notSent | 前者は実呼出0、後者はtransport試行1・送出0。応答可能なら502 `model_unavailable`、非latch |

全行でAPI期限失効/応答不能なら新規応答を開始しない。hookは32KiB検査後、期待送付hash照合と合成private intent保存を行う。factory所有の `min(500ms,API残り)` raceと採用時検査で制限し、要求中の同期file I/Oを禁止する。成功後もabort/reserveを再検査する。wrapper内の必須保存awaitは禁止。late保存は送出を再開せず、intentと実呼出間のcrashは送出不明とする。observer未注入はno-op、同期非await通知の例外はraw出力せず捕捉し、製品queue/file/consoleを設けない。

**C3：clientとprivate evidence。** import時読取/実行を明示入口へ分離し、clock・HTTP/factory・保存先・制御channelを注入してsocket-freeに試験する。opaque run/attempt IDをclientで生成し、attemptを要求開始前に固定、client/API終端まで交換しない。本文/header/backend wireへIDを追加しない。期待hashは事前固定したbuildRequest相当のUTF-8 bytesと照合する。

初期factory生成と読込済み `policyIdentity` の照合は**後段grantの5秒内・ack前**に行う。listenはparent確認後だけとし、実行専用予算・最初の処理reserve 2秒内に収める。grant ack後・trial 1前のflushも同じ実行予算を消費する。listen/flush後に要求開始条件を再検査し、不足/等号なら要求0。factory生成の同期処理を強制中断できるとはせず、採用時検査とparent監督を使う。

catalog切替を含む各factoryでgrant固定snapshotとhash/profile/selectedPolicyを照合する。**旧instanceの全接続終了・close完了を確認してから次を生成**し、close/再生成/照合を要求間reserve 2秒に含める。旧instanceがunknown/partialなら再生成禁止。照合不一致は固定detail `binding_mismatch` とし、deadline-causeにしない。初回・切替後の不一致、close遅延/失敗、unknown/partial、ack前timeout、parent確認欠落を送出0の試験にする。

health後の最初の適格要求をtrial 1とし、warm-upなし。client開始・handler入口・実transport呼出を別計数し、注入notSentもtransport試行1。設計§0.6の4恒等式を完全記録だけで検査する。handler前失敗を未試行へ戻さず、crash/複数handler/帰属不明はpartialで照合不能とする。client/API/model完了を独立検査し、API受信8KiB超過、client期限等号、送出後保存失敗で後続停止を確認する。

| 保存・ログ受入 | 固定上限・失敗ケース |
|---|---|
| schema/漏洩 | 設計§0.7のstage/event/outcome/detailとdeadline-cause `header/body/model/api/controller/startup/identity/grant/child/persistence/passive/cleanup` だけ。opaque ID・sequence・UTC・process内elapsedを持ち、raw task/catalog/応答/例外/秘密/環境変数を製品出力へ出さない |
| 保存先/容量 | `L/cold-api-runs/<opaque-run-id>/` を0700、fileを0600。JSONL各1件2KiB・1024件/2MiB、2 process計4MiB、buffer各128件。129件目拒否、byte/件数等号と超過を試験 |
| flush/event予算 | 各write/flushは500msまたはphase残り以下。parentはstartup各command/poll間、clientはgrant ack後・trial 1前と要求間、最終flushは終了5秒内。flush event再帰なし。parent最大492件、client最大576件の内訳を設計§0.7と照合 |
| private payload | source/config/input束縛は合成private領域のみ。API入出力各8KiB、model要求32KiB/応答64KiB。serial各256KiB/run8MiB、2 process stdout/stderr各stream256KiB/合計1MiB、run全体16MiB |
| receipt | intent排他的作成、終端は別fileへ一時保存→rename→長さ/hash/sequence/schema再読。部分行・破損・欠落・保存拒否・timeoutを固定分類しpartial停止。採用済みmodel結果は改変しない |
| 保持/異常終了 | 保持7日、期限後削除はoperator手動判断で自動jobなし。物理exactly-once/crash耐久性を主張しない。保存不能でもchild終了statusとparent観測partialを分けcleanup継続 |

制御channelはchild stdin/stdoutのUTF-8 NDJSON（LF、1 frame 1024 bytes以下、方向別最大8 frames/8KiB）に固定し、stdoutへ診断文字列を混ぜない。共通欄は `v:1,kind,runId`。種別/順序は child→parent `identity`、parent→child `identity_ack`、parent→child `grant`、child→parent `grant_ack`、parent→child `go`。identity確立後のparent→child `stop` は任意時点で終了を要求する。grantだけが `profile,policySha256,selectedPolicy,executionBudgetMs,backendPort` を追加し、grant_ackはそのうちprofile/hash/selectedPolicyを返す。他のframeは共通欄のみ。runIdはclient生成の32桁lowercase hex、hashは64桁lowercase hex、profileはdefault/diagnostic、budgetは有限正整数、portは1〜65535の整数。選択行は `modelMs,apiMs,controllerMs,modelReserveMs,controllerReserveMs` の5欄でC1の構造/大小条件を満たす。JSON正本は `schema:"compass.deadline-policy.v1",profiles:{default:<選択行>,diagnostic:<選択行>}` とし、schema/欄名を3者で共有する。

未知欄/種別、不正UTF-8/JSON、過大/途中EOF、重複message、順序違い、runId不一致はfail-closed。要求前なら送出0、開始後なら追加送出0と既存unknown/partial規則を適用する。identity/grantそれぞれの全往復は5秒内、go欠落も無期限待機しない。C3/C4の言語間共通valid/invalid policy・wire vectorを新規予定 `L/test_run_l4_api_probe.py` 内のASCIIだけのraw三重引用JSON文字列定数 `CONFORMANCE_VECTORS_JSON`（Pythonのescape展開なし）一箇所に保持し、不正UTF-8などはhex欄からbyte列へ復元する。Python試験はjson.loads、TS側は `L/live-api-client.test.ts` だけが同fileの明示marker間のliteralをUTF-8で読みJSON.parseする（Pythonの実行/importや新fixture fileなし）。このlocal TS試験から `createCompassServer({policyPath})` へ専用一時領域の合成policyを渡し、実際の製品検証器・policyIdentityを同じvectorで検査する。`P/test` は `L/` を読まない。C1の製品単体試験は等号・70000/70001・未知欄などの独立境界ケースを持ち、言語間共有vector表の複製とは区別する。両言語で同じbytes・期待値・hashと全異常vectorを検査する。

**C4：orchestrator。** import時の実state/既存証跡読取・command・bindを明示入口へ分離する。`-I` 試験は `importlib.util.spec_from_file_location` で絶対pathから対象をロードし、`contract_parser` も明示入口内で同方式にする。sys.path改変なし。偽clock/runner/child/合成保存先を使い、試験から実command・network・bind・既存state操作を起こさない。Python試験は標準unittestと明示 `__main__` だけを使い、失敗exit非0とする。

高水準の偽runnerだけでなく、実adapterへ偽Popen/pipe/socket/clockを注入して検査する。healthは全体8秒絶対・本文4KiBまでとし、継続する短いchunkでも更新しない。urllibのidle timeoutだけに依存せず、接続/読取/採用を共通monotonic期限で監督する。commandはowned process groupを新sessionで起動し、TERM→KILL、KILL後確認、pipe drainを同じ操作絶対上限内へ含める。全waitに残り予算を渡し、無期限wait/communicateを残さない。serialは全量buffer化前にstreamの256KiB上限で止める。偽下位層で各期限等号/超過、chunk継続、pipeを保持する孫process、KILL後未終了、停止待ち失敗を試験し、上限後に待機を追加しない。

| run制御受入 | 固定条件 |
|---|---|
| Python policy読込 | identity/command/bindより前に明示profileで正本を2KiB以下で読み、C1と同じ固定schema/key/型/70000ms上限/厳密不等号を検証。共通不正vectorは操作0。生bytes SHA-256と選択行をTS policyIdentityと共通vectorで照合し、要求時間表をPythonへ複製しない。導出値は要求snapshotとrun policyだけから計算 |
| early identity | cloud/preflight command・bind・資源操作より前にchild起動を含む5秒identity/ackでrun ID確定。ID前は有界process内診断だけ。失敗は固定statusとchild停止のみでrun領域/cloud/推論0 |
| startup | 共通1800秒にpreflight/作成/health/flushを含める。通常command120秒、VM作成300秒、health各8秒・15秒間隔・最大120、serial各5秒・60秒間隔・最大30、その他startup/preflight command最大16。全操作はphase残り以下 |
| startupログ | 最大health/serial反復を偽clockで通し、parentの240+60+32+64+32+64=492件、clientの64×8+64=576件以内を確認。途中flush失敗・129件目・想定外反復はpartial停止、成功へ切詰めない |
| 承認/全N予算 | 新しいexpiry/VM削除期限/cleanup終端/run capの最早上限から時計差5秒を引きDへ一度変換。未承認/消費済み/期限切れは資源操作0。ID後preflight前に `残り > 1800+5+5+N×(controller秒+2)+5+10+300`、Nは事前固定で最大8。初期計画にidentity5秒も含める。全N件送出の保証ではない。grant往復遅延と各要求が全予算を消費して最終caseが不足/等号で未試行になる境界も確認 |
| grant/監督 | health後に一回限り5秒grant、`E=min(D−310秒,grant開始+5秒+5秒+N×(controller秒+2)+5秒)`。childへ残り実行予算と固定policyを渡し、childは受渡し余裕5秒を引いて自process期限を一度確定。往復5秒以上、不一致、不足は送出0 |
| 起算/切断 | startup中はlisten/推論/要求timerなし。各要求前にchild残り `> controller全予算+2秒+終了5秒`、不足/等号は未試行。parent待機はEと残要求数由来の上限以下。進捗frameは追加せず、確定した進捗がない間の残要求数は初期Nを保守的上限として使う。Eは更新しない。EOFは待機終了またはabort、送出状態に応じunknown/partial。再付与・child再起動なし |
| 時計 | process間monotonic値/制御用UTCを渡さない。起動/受渡し遅延、UTC前進/後退でもD/Eを延長しない。VM termination-timeは承認期限以下で作成後照合 |

cleanupは全経路のfinallyに置き、開始Cで共通期限 `min(C+300秒,D)` を固定する。child→tunnel停止合計20秒（各TERM5秒＋KILL後確認5秒）、受動回収最大1回10秒、VM削除130秒、boot disk/firewall/subnet/network各25秒、5種確認各6秒、記録10秒の計300秒とする。各操作は共通残り以下、自動retryなし。別予約の回収10秒を再送/延長へ転用しない。

command開始前に対象を保持し、破損receipt・保存不能・個別command timeout・繰返し停止signalでも残り予算内の後続cleanupへ進む試験を行う。child停止未確認/cleanup予約不足なら受動回収を省略。共通期限等号以降にcommand/waitを追加せず、残存/未確認をoperator対応として保持する。CLI timeoutをserver側完了とせず、VM自動DELETEだけで全資源削除済みとしない。

### 0.3 将来の実行commandと独立ゲート

以下は実装承認後にrepository rootから実行するcommandであり、**今回未実行**。C1〜C4のTDDは意図した未実装のRED→GREENを記録し、tool拒否・環境失敗をREDに数えない。版/hash・件数・exit・試験範囲をparentが保存する。

| 対象 | command |
|---|---|
| 製品socket-free試験 | `npm --prefix providers/compass test` |
| 製品型検査 | `npm --prefix providers/compass run types` |
| TS client socket-free試験 | `node --import tsx --test .claude_workflow/local/live-api-client.test.ts` |
| TS harness本体と専用試験の型検査 | `node node_modules/typescript/bin/tsc --noEmit --target ES2023 --lib ES2024 --module NodeNext --moduleResolution NodeNext --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck .claude_workflow/local/live-api-client.ts .claude_workflow/local/live-api-client.test.ts` |
| Python socket-free試験 | `python3 -I -B .claude_workflow/local/test_run_l4_api_probe.py` |
| C6 parent専用TCP | `npm --prefix providers/compass run test:tcp` |
| C7 関連（下記隔離環境内） | `npx --no-install vitest run tests/unit/dynamic-post.test.ts tests/unit/upstream-url.test.ts tests/unit/receipt-form.test.ts tests/wire/x402-dynamic-outbound.test.ts --reporter=json --outputFile=.claude_workflow/local/cold-regression-related-tests.json` |
| C7 全体（同隔離環境内） | `npx --no-install vitest run --reporter=json --outputFile=.claude_workflow/local/cold-regression-root-tests.json` |

local TS harnessの2ファイルは製品tsconfigのinclude外なので専用型検査を必須とし、新tsconfig・依存を追加しない。通常testへTCP/probe/liveを混入させない。

C5ではClaudeの独立コードレビュー後、parentが実コード・allowlist・試験対象版をread-backする。C6はその後に通常権限でのみ実行し、拒否なら停止・記録する。sandbox bypass・executor/model代替・自動quota retryは行わない。

C6は保存fixture backendだけで、実client→API→実default HTTP transport→保存fixture上流HTTPの全TCP経路を検査する。`tcp-smoke.ts` のclient側17秒idleも共有policyからの絶対期限へ置換する。診断profileで要求bodyを完読した後、最初の応答byteまで20秒遅延させるケース、requestTimeoutとの分離、header timer解除、継続chunkでも絶対打切り、backpressure、client切断、busy/latch、全listener/接続終了を確認する。先行TCP成功をこの差分の証拠へ流用せず、HTTP mock・実TCP・実GPUを別ゲートとする。

C7の参照runnerは `L/run_api_regression.py`。固定OUT/TMPを持つone-shotであり、既存証跡があるため直接再実行しない。parentの単一tool実行内でworker.lockを取得し、Data使用率90%未満・HEAD/branch/tracked diffと基線の比較可能性を確認して記録する。その後、同runnerの隔離環境・preflight・fingerprint・固定4対象の手順を組み直す（新しい製品/runner fileは作らない）。短い専用TMPは未存在/非symlink/所有者を検査したworktree内 `.c1` とし、HOME/npm-cache/空の別user・global npmrcをそこへ隔離する。環境はPATHとそのHOME/TMPDIR/TMP/TEMP/npm各指定、offline=true、CI=trueだけをallowlistし、既存secretを渡さない。旧runnerと同じnode-version/router-import/tsx-childの各30秒preflightとtsx pipe長・依存fingerprintを確認する。各Vitestは600秒、owned groupのTERM/KILL/確認は追加10秒以内で全waitを有界化する。新規cold-regressionのlog/summaryは排他的に作成する。VitestのoutputFile自体は排他的作成ではないため、同じworker.lock下で上表JSONの未存在を実行前に確認し、完了後に対象版/内容を再読検査する。衝突時停止、直接の再試行なし、既存api-regressionを上書きしない。比較元は `L/api-regression-baseline-summary.json` と `L/api-regression-{related,root}-tests.json`、保存先summaryは `L/cold-regression-summary.json`。これはparent専用の将来実行で、現在は未実行。専用TMP・cleanup範囲・固定対象を引き継ぎ、関連/全体の実command、環境、失敗ID、原因、fingerprintを比較する。歴史的基線は関連 **266成功/0失敗/0skip**、root **2660成功/6失敗/29skip**。root全体未合格を維持し、新規失敗・比較不能で停止する。root修正で帳尻を合わせず、既存6失敗の免除や失敗ID一致だけの無回帰断定をしない。

### 0.4 完了の意味と後段hold

本差分の到達点はローカルで観測可能な起動待機・health・初回要求・transport・API finish・client受領・保存・cleanupの分離である。loopback connect/writeはIAP先/model受理ではなく、API finishはOSへの引渡しでpeer受領ではない。要求相関のbackend証拠がなければbackend outcomeはunknown。最初の完全有効応答も当該要求の推論応答観測に限り、全shape/長さ/labelのwarm保証にしない。

unknown latchは遅延応答・health・受動ログ・再接続で解除せず、運用者が完了または停止を確認した後の明示的process再作成まで保持する。受動回収は証拠を限定するだけで再送・cleanup延期に使わない。backend要求別完了の追加計装は別の将来server instrumentation gateでlicense・範囲・承認・レビューを確認し、request-ID対応を仮定せずvendor sourceをcopy/vendor/再配布しない。

共通vectorだけでは実Python⇔実TS childのpipe結合を証明しない。本差分のローカル単体/TCP試験をその代用にせず、GPU前にcloudなしの実process間identity/grant/go/stop・EOF・期限伝達の結合証拠を別途揃える。担当はparent、hold IDは `G-PIPE`（pending）。C4の明示入口を使い、追加mode等が既定allowlist/承認範囲を超える場合だけ事前に範囲を改訂する。未実施ならGPUゲートを開かない。

新GPUはfresh owner authorityによる別ゲート。東京GCE L4 `g2-standard-4`方針とRouter EC2無変更を維持し、Cloud Run A／RTX・支払先行・32 receiver/proofはhold。cold SLA、新API実モデル品質、全label内部監査、製品全品質、公開auth/RBAC、永続予算/有料at-most-once、G1支払束縛、二脚決済・下流購入・配信/受領・保存再読取・finalityは未達のまま。将来の課金でも明示承認、offer/route/額/network束縛、verify-before-settle、二脚同一性、durable unknown、盲目的再送禁止を維持する。

---

**以下は旧課金版の履歴本文（現行の範囲・順序・allowlistは§0）。**

## 1. 最初に確認する実現性

既存 Router の動的 POST を使い、新規 `providers/compass/` だけで最小縦経路を作る。現 x402/EVM 案は、文脈専用 receiver 最大32件、Circle の受取先と一致する売り手 proof、同じ task/body・bundle の後日再購入不可を伴う。これは **paid POST 一般の必須条件ではなく、この束縛案の制約**である。巨大な pool 運用を先に実装せず、K01 の小さな source 比較で必要性と既存対応 rail の選択肢を確かめる。比較結果なしに MPP 等へ変更しない。rail選択も実成立の実証も未完了。
Cloud Run GPU 案 A の cold/warm 両方の5秒／30秒適合は未実証。warm 営業時間限定は元の cold 要件を満たしたことにならず、独立した owner 判断が必要。A 不成立なら根拠を示して B を諮り、自動移行しない。GCP・実 DiffusionGemma を使わない mock で最終製品受入を埋めない。

## 2. 現在地と作業境界

- author は Codex、独立 reviewer は Claude Code（claude-opus-5-5）。B1〜B4の修正とowner指示の英語化を再レビューし **LGTM（文書のみ）**。controller read-back済み、ownerの「進めて良いです。」によりタスク段承認済み。K01のsource比較から着手。実装タスクの完了宣言ではない。レビュー記録は [tasks-review.md](tasks-review.md)。
- owner の「続きをお願いいたします。」は設計→タスク分解の進行承認。Claude 独立レビュー後にownerのタスク段承認を取得済み。通常ローカル作業は計画に従って進め、G1等の個別ゲートは必要な直前に確認する。warm限定・pool・一文脈一購入・課金・署名の包括承認に読み替えない。
- 今回の変更は本書だけ。要件・設計・既存レビュー、root `src/`、既存 Provider、tests、設定、保護文書（`CLAUDE.md`、root `README.md`、`docs/DEPLOY.md`）を変更しない。以下の変更ファイルは将来の提案で、作成済みを意味しない。
- 専用 worktree `compass-gcp-prototype`／branch `task/compass-gcp-prototype`、開始 commit `10dd795`。単一 writer。controller が bounded run ごとに既存 worker lock を管理し、author と reviewer を重ねず、入力を固定する。安定 lock を削除しない。本 author は state/lock を編集しない。
- 各段の実作業・証拠を controller が確認する。quota/refusal はそのまま停止、timeout は未完了。自動再試行・executor/model/tool の逃避をしない。
- 今回は試験・ネットワーク要求・秘密探索/読取・署名・購入・課金・GPU/モデル取得・Docker・クラウド操作・commit/push/PR/merge/stash・フォーム送信を実施しない。
- 再利用は出所・commit・license を記録する。既存 MIT 構造の参照と第三者の利用許諾を混同せず、公式 `@zerc20/sdk`／BUSL source をコピー・vendor・再配布しない。

## 3. 許可ゲート（必要な直前にまとめる）

| ゲート | 判断内容・止める範囲 |
|---|---|
| G0 タスク段 | Claude の独立レビューと指摘解消、owner の次段承認。通常ローカル作業を一件ずつ再承認にはしない |
| G0a 新規依存取得 | 新規packageの具体的一覧・固定版・license・registry接続先/操作/許可範囲、配置・追加容量を事前記録しowner承認。後続Firebase等にも適用し、承認まで取得/ネットワーク依存のlockfile生成を停止 |
| G0b 回帰後の進行 | K07で既存失敗が残る場合、full PASSとはせず、比較証拠を基にownerが後続進行を明示判断。不明/新規失敗/比較不能は保留。K09の独立したread-only確認はこの待ちに含めない |
| G1 製品・束縛案 | K01 の根拠を見て rail、32 receiver/proof 運用、一文脈一購入、有限20購入・未回収費用・回復制約を判断。warm限定への要件変更は別項目。非承認なら該当実装を停止し設計へ戻す。既存文書の改訂も別範囲でレビューする |
| G2 来歴・モデル | license、正確な model ID/revision/全重みhash、djev/djev-run/remote-code commit、完成image digest、依存条件、実行コード検査をまとめて承認。欠落label/位置の内部検査が不能、または許諾不明なら実モデル停止 |
| G3 クラウド読取 | project/region と quota/capacity/IAM/価格/Firestore 条件の read-only 操作範囲。API有効化・資源作成・課金は含めない |
| G4 外部実行・費用 | 取得/build/Docker/配備/DB/GPU/実推論の対象と操作、期間・総額・単価、停止担当/手順/停止確認・超過許容額を一括記録。評価300推論/3000予約秒と販売20受付/200秒・30分を分離。通知をhard bill capと呼ばない |
| G5 購入条件・実決済 | receiver/profile/catalog の実値・出所、network/asset/額/回数/期間、登録/proof の操作範囲、限定した testnet 資金準備・署名・送金承認を直前にまとめる。Router実検証対象をlocalかhostedか、版/接続先/設定・鍵の出所（秘密値なし）/操作権限とともに事前固定する。設計のEC2想定は本番操作の自動許可ではなく、未確定なら実検証停止。Compass と下流 API の対象を明記し、各 quote に対する人間の購入承認は保持 |
| G6 提出・公開 | 実証に沿った応募素材の準備と提出/公開を分離。送信・公開は別承認 |

ownerの$300 GCP credit提供はセットアップの申し出であり、課金承認でもbilling/projectへの適用確認でもない。
ownerの追加指示「英語で良いですよ」により、今回のモデル選定評価は英語とする。controllerが要件§7/AC-C2・設計§7/§8の言語指定とfixtureキー`taskEn`を同期した。日本語選定品質は必須条件から外すが、Unicodeの入力安全性・hash検査は維持する。作業報告は日本語。

G2 の license/固定source の確認を取得・実行より先に行う。完成image digest等は許可されたbuild後、実行前に確定する二段階の記録とし、可変tagで実行しない。既承認の公開source読取も今回はネットワーク禁止のため実施せず、後続の許可範囲内で行う。

## 4. 最小縦経路のタスク表

表の `P/` は `providers/compass/`。各行の省略したファイルパスもP/配下。K05はK01から独立し、K02等のソース変更より前に安全な比較baselineを確保する。環境変更時はpreflightとbaselineの比較可能性を再確認する。ファイル名・試験コマンドは将来作成する契約。K00の文書作成・独立再レビュー・controller確認とowner承認は完了。K01を開始し、K02以降の実作業は未実施。証拠種別を併記し、前段成功で後段を代用しない。

| ID・証拠種別 | 依存 | 変更ファイル（予定） | 受入条件 | 試験コマンドと証拠 | 許可ゲート |
|---|---|---|---|---|---|
| K00 設計/レビュー・T0 | 要件/設計 | 今回 `docs/compass/tasks.md` のみ | 指定資料と最新stateに整合。Claude が独立レビューし、controller が判定と対象hashを確認 | 文書read-back、追跡対象は `git diff --check`、未追跡本書は `git diff --no-index --check /dev/null docs/compass/tasks.md` で空白検査。新規差分だけでもexit 1になるため終了値単独では判定せず、空白診断・stderrも確認する（controllerの正常/不正fixtureで確認済み）。レビューは別runの実記録 | 本書提出後停止、G0 |
| K01 短い実現性比較・T0 | K00/G0 | `P/notes/feasibility.md` | 既存 x402 EVM と MPP 等の署名対象、challenge/URL/method/body束縛、nonce/replay、Provider検証、再購入、既存POST/profile適合をsource行/固定版で比較。receiver/proof依存を明示。少数候補で可否/不明を出して終了、汎用rail frameworkは作らない | 下記S1の限定source読取。未確認項目を残し、実行証拠と呼ばない。別railは設計レビュー/owner判断まで保留 | G1。課金/署名なし |
| K02 独立package・入力縦経路・実装/ローカルfake・T1 | K01、K05、採用案確定 | `P/package.json`, lockfile, `tsconfig.json`, `vitest.config.ts`, `src/{http,contracts,catalog}.ts`, `test/contracts.test.ts` | POST本文→正規形/hash→固定catalog→結果封筒の最短経路。設計§3の8KiB/1200scalar/4800bytes、Unicode・重複キー・追加欄拒否、URL完全一致、自己参照禁止。Router exported stableJson と掲載vector一致 | P1 `test/contracts.test.ts`。境界拒否時の推論0、bytes/hash、JSON object/8KiBを記録。fake結果は品質証拠にしない | G0/G1、新規取得はG0a。初期は既存root tooling再利用、root変更なし |
| K03 台帳・支払い・実装/ローカルfake・T1 | K02 | `P/src/{ledger,payment,http}.ts`, `test/{ledger,payment}.test.ts` | verify→原子予約→推論試行印→候補保存→settle試行印→receipt/結果保存。各支払いの推論/settle≤1、台帳不整合で停止。採用した束縛方式の改変先取りと並行攻撃を拒否 | P1の2ファイル。fake transaction/verify/model/settle の回数、状態遷移、競合/再起動ケース。詳細S2 | G0/G1。pool/proof運用の自動拡張なし |
| K04 モデルadapter・実装/ローカルfake・T1 | K03 | `P/src/model.ts`, `test/{model,failures}.test.ts` | 固定choice wire、N依存丸め境界・全label/位置の検査契約、不正分布の補正禁止。技術失敗をnoneにしない。秘密をモデル/ログへ渡さず設計§6の失敗表を網羅 | P1の2ファイル＋Provider全件。偽wireの異常応答/timeout/期限等号、推論/settle回数・秘密非出力。検査契約だけで実worker適合としない | G0/G1。第三者source複製なし |
| K05 試験環境preflight/baseline・T2準備 | K00/G0（K01非依存） | `P/notes/regression.md`（root変更なし） | 短い専用隔離TMP、cleanup対象、実tsx/Router importとtsx CLI子プロセスprobe、offline限定を確認。ソース変更前の10dd795でR1/R2を同じ安全な環境で実行し失敗ID/理由のbaselineを固定。キー出力拒否を維持し、比較基準が得られなければ保留 | S3、R1/R2。版/依存/環境/コマンドと失敗ID/原因分類を記録。今回実行しない | G0。worktree外一時領域が必要なら狭い追加許可 |
| K06 TCP接続・T2 | K04、K05 | `P/test/router-tcp.test.ts` | 実Routerをread-only importしloopback TCPで402再probe→同一POST→領収/JSON。切断/timeout/body上限、別文脈拒否、保存receipt再取得を検証。外部facilitator/model/storeはfake | P1 `test/router-tcp.test.ts`。実socket経路、要求hash、回数、受領bytesを記録。HTTP mockのみは不可 | G0、既承認の合成offline範囲。OS alias変更なし |
| K07 root回帰・T2 | K05、K06 | `P/notes/regression.md` のみ | root関連・全体とProvider全体を別集計。K05と同じ安全な環境/条件で新規失敗0、残る既存失敗は同一ID/原因分類を示す。比較不能なら保留。既存失敗残存はfull PASSではなく後続進行はG0b。既存試験を改変してPASSにせず、root修正が必要なら停止/報告 | R1、R2、P1全件。pass/fail/skip/suite error、exit、環境・依存復元状態と失敗IDを保存 | G0。合成offline署名許可はstateの範囲のみ |
| K08 固定catalog/評価/来歴・T0 | K01、K04 | `P/config/bundle.json`, `catalog/catalog.json`, `eval/selection.jsonl`, `notes/provenance.md`, `README.md` | ownerの実在3〜6 API、profile/条件を固定。英語タスク/カタログ説明・期待値・dataset hashとK13用chosenケース/期待APIを人間/独立reviewで実モデル試験前に固定。model/worker許諾、補完確率の内部検査可否を確定 | 文書/source照合とP1のfixture検査。EV-1〜7は設計§8の件数/閾値を継承、未評価表示 | G2、G5のcatalog/profile部分。登録/署名はしない |
| K09 実環境の読取・T3 | K00/G0、G3（ローカル完了待ち不要） | `P/notes/cloud-check.md` | project/regionのGPU提供/quota/capacity/IAM/価格、Firestore transaction/専用identity、clock・egress隔離の成立条件を確認。不成立なら停止 | 承認対象確定後にread-onlyコマンドを同記録へ固定。応答日時/対象/不足条件を記録。資源作成なし | G3 |
| K09b rail実成立の小確認・登録/proof証拠 | K01、G1採用案確定 | `P/notes/rail-evidence.md` | 採用rail固有のseller登録/proof等の実成立を確認。x402案なら承認済み少数receiver（例2件）で登録と売り手proof適合を確認し、不成立/不明で停止。API/受取先を推測しない | 出所付き実値・対象・固定操作票と登録/proof結果。成功はsettlement成功ではなく、決済はK12で別検証 | G1およびG5の限定した登録/proof/必要署名の許可。購入/送金を含めない |
| K10 実store・T4の永続性 | K07（残存失敗時G0b）、K08、K09、K09b成功 | `P/src/ledger.ts`, `package.json`, `vitest.live.config.ts`, `test/store.test.ts`, `notes/store-evidence.md` | 専用Firestoreで2process/異revisionの一括CAS、再起動、読取不能/欠落/commit不明、slot/累積非復活を実証。transaction callback内に外部副作用なし | P2 `test/store.test.ts`。S2の停止点・競合を実storeで再実行、fake model/settleのままと明記 | G4のDB作成/料金/限定障害注入範囲、追加依存はG0a |
| K11 実モデル・実HTTPS・T4 | K08、K09b成功、K10 | `P/Dockerfile`, `config/bundle.json`, `test/live-model.test.ts`, `notes/model-evidence.md`, `README.md` | 固定実DiffusionGemmaで全EV-1〜7の実品質/揺れ基準を満たし、NFR-C2どおりcold/warm×未払い/有料の各20回すべてが起動込み5秒/30秒以内。不達はK11不合格で停止、測定完了だけでは合格にしない。warmへの正式要件改訂又はB移行はowner別判断。S4、内部label検査、モデル隔離、ログ/外部ingress閉鎖/停止確認。GCP無しでは受入不可 | P2 `test/live-model.test.ts`。manifest照合、全ケース/全試行、時間・費用・停止証拠。facilitatorはfake、実決済証拠なし | G2/G4、warm変更はG1別判断。B移行も再判断 |
| K12 Compass実購入・実決済・T5 | K07、K11合格（cold条件改訂時も実モデル/品質/実store合格は必須） | `P/notes/payment-evidence.md`, `README.md` | 承認済みrailでquote→人間承認→購入。K09bの登録/proof証拠とは別に、source/destination settlementを別々に検証、unknown再送なし | 固定した操作票に既存Router tool/引数を記載。intent/request/tx IDと各脚のnetwork/asset/額/receiver、verify/settle結果。秘密/署名を証拠文書に含めない | G5。実財布流用・本番操作は含めない |
| K13 下流購入・配信/受領・T6 | K12 | `P/notes/acceptance.md` | K08で事前固定したケースで実chosenと期待APIを確認し、別quote、全購入条件比較、別人間承認後に選択API購入。none/clarificationなら下流購入0だが、それだけではK13合格にしない。二購入それぞれAPI配信とclient受領を確認 | 既存Routerの具体的操作票＋応答/受領bytesのhash・相関ID。source/destinationを分離、delivered名だけで合格にしない | G5の下流対象/回数/額を含む範囲 |
| K14 保存再読取/finality・T6 | K13 | `P/notes/acceptance.md` | 二購入それぞれの結果を保存し別読取で一致、各脚のchain finalityを確認。欠落/unknownは未完了。AC-C1〜6の全条件が揃うまで製品受入しない | 保存/再読取hash、chain確認方法・基準・観測時刻・tx IDを固定操作票で記録。Provider再提出能力とclient保存を区別 | G5のread-only照合範囲。回復用の新規購入/再署名なし |
| K15 応募素材準備・証拠整理 | K14 | `P/notes/submission-draft.md` | 得られた証拠だけで価値・制約・再現方法を説明。未達gate、mock区間、cold失敗、費用を隠さない | acceptanceとの文書照合・独立review。URL公開/フォーム送信はしない | G6は提出/公開直前 |

## 5. コマンドと証拠の具体化

以下は **後続段での予定**であり今回は実行しない。`P1` は独立packageで `npm --prefix providers/compass test -- <表のtestファイル>`（全件は引数なし）、型検査は `npm --prefix providers/compass run types`。scriptsはK02で定義する。root vitest設定にProviderを追加しない。初期scriptsは既存rootのvitest/typescript/tsxを再利用し、独立Provider設計とroot無変更を優先する。node_modules一つの助言はディスク対策であり設計変更ではない。不要な全root複製/二重installをせず追加配置・容量をG0aで事前記録し、ディスク使用率90%超なら追加取得/作成を停止する。
`P2` はK10/K11で用意する明示的live専用script `npm --prefix providers/compass run test:live -- <表のtestファイル>`。通常testからliveを除外し、承認済み対象/上限を検査して未指定なら拒否する。現時点でscriptは存在せず、実行可能と主張しない。
`R1` はrootで `npx --no-install vitest run tests/unit/dynamic-post.test.ts tests/unit/upstream-url.test.ts tests/unit/receipt-form.test.ts tests/wire/x402-dynamic-outbound.test.ts`。`R2` はrootで `npx --no-install vitest run`。既存195成功の完全再現コマンドと同一とは主張しない。
各実行はcontrollerが承認済み隔離環境を与え、終了コード・対象版/hash・実行環境・pass/fail/skip/suite error・証拠種別を記録する。生ログは許可された `.claude_workflow/local/` に限定し、公開可能な要約だけP/notesへ置く。秘密を含むraw header・鍵・authorizationは保存しない。

- **S1 比較の限定範囲**: `src/adapters/outbound/{x402-dynamic,mpp-dynamic,mpp,mpp-solana}.ts`、`src/core/intent.ts`、`tests/unit/dynamic-post.test.ts`、`tests/wire/{x402-dynamic-outbound,mpp-dynamic-outbound}.test.ts` とそこから直接参照する署名/検証sourceだけを読む。`sed -n '<必要行>' <対象>` / `rg -n '<束縛項目>' <対象>` で引用する。既存依存の版/licenseも確認。Router内bodyHash、送金署名、seller proof、Providerの照合を別列にし、未読SDK内部を推定しない。全体スキャン、秘密探索、ネットワーク、署名は行わない。
- **S2 支払い/台帳の必須ケース**: 同一payment別bodyの先取り、catalog/model/config/receiver差替え、未検証claim非消費、別nonce双方verify後の予約競合、claim後の別払いverify0、busy時claim/予算非消費、消費後再probe/後日再購入拒否（現案採用時）。同一証明の保存JSON+PAYMENT-RESPONSE再取得を期限/準備/容量拒否より優先し、他証明へ結果を漏らさない。
- **S2 続き**: 各CAS前後、推論送出前後、候補保存前後、settle送出前後、receipt保存前後、200送出途中に停止。推論≤1/settle≤1、未知slot非再利用、累積予算復活0、状態喪失でfail closed。保存成功未確認で副作用を始めず、unknownを成功/失敗に丸めない。fakeと実storeは別結果表にする。
- **S3 preflight**: TMPはnode_modules/tsx・依存配下・共用ディレクトリを絶対に使わない。短い専用隔離先の実path/所有/非symlink/cleanup範囲、socket path長、child processへの環境伝播を先に確認。専用先以外を消すcleanupは実行しない。必要なworktree外領域は狭い用途/期間/削除範囲の許可を別途得る。worktree内キー出力を拒否する既存テストを緩めない。
- **S3 続き**: `node --import tsx` で実Router exported `stableJson` をimportし既知vectorをassertするpreflightに加え、実回帰で使うtsx CLIの最小子プロセスprobeも同じTMP/環境で行いIPC pathの成立を確認する計画。両方成功後に変更前baselineを固定し、環境差のある過去実行と単純比較しない。試験設定変更とコード回帰を区別し、`/etc`・loopback alias設定を変更しない。T-A5/T-A6/T-A8の既知3flake以外を一括flake扱いしない。環境制約による未実施もPASSにしない。
- **S4 実モデル受入**: 設計§8の件数/合格閾値/揺れ基準をそのまま使用、同manifestで各ケース5回、cache不可、技術失敗を分母から除外しない。EV-7の異常注入と無加工実出力を区別。全label/位置の内部検査と丸め/argmax wire一致が不能なら停止し別モデルへ逃げない。
- **S4 続き**: cold/warm×未払い/有料を各20回、全回5秒/30秒以内か記録。有料wireの40推論＋評価最大260＝300の別枠。推論中probe/pay前再probe、HTTP8枠超のqueue/timeout、slot=1、未準備拒否を測る。warmだけ合格でも原NFR-C2合格とは書かない。GPU固定費・推論按分・DB等付帯費・停止遅延を区別し、按分を固定費に二重加算しない。

## 6. 現在の試験状態（最新stateを優先）

| 区分 | 既存記録 | この計画での扱い |
|---|---|---|
| 関連 | 195成功、失敗/skipなし | 関連回帰のみ。Compass/全体の成功ではない |
| 初回root全体 | 2639成功、27失敗、29skip | 全体未合格。27失敗の記録は存在するがID/理由の照合は未了。一時領域依存の汚染/環境差を除外できず、この件数を直接baselineにせずK05で固定 |
| 不適切な短TMP再試験 | 2404成功、259失敗、32skip＋`tests/wire/evm-testnets-entry.test.ts` suite error | `TMPDIR=node_modules` によりtsx自身が削除された汚染実行。コード回帰の一括証拠にも成功にも使わない |
| 復元 | npm ci成功、実tsx＋実Router import/assertion成功 | 復元後の全体再実行なし。新preflightの代わりにもならない |
| Compass | 未作成/未実行 | T1〜T6は未達 |

出典は `.claude_workflow/state.json` の `verification` と `history`。旧要件/設計の「root未実行・offline署名承認待ち」は履歴であり、最新の使い捨て合成鍵offline試験許可を優先する。既存財布・live-test環境・外部署名/送金まで拡張しない。タスク段では全体再実行しない。

## 7. 要件・設計段への対応

| 要件 | 主タスク | 証拠段と残る境界 |
|---|---|---|
| FR-C1/C9/C10 | K01〜03、K06、K09b、K12 | T0束縛比較→T1 fake→T2 TCP、独立した登録/proof確認→T5実決済 |
| FR-C2/C7/C8/C16、NFR-C6、EV-1〜7 | K04、K08、K11 | T1 adapterのみ、T0固定/検査、T4実モデル品質 |
| FR-C3〜6/C11〜15、NFR-C4、EV-15 | K02、K08、K11、K13 | T1機構、T4選択、T6別quote/承認/下流購入 |
| FR-C17〜22、EV-8〜10/14 | K03、K06、K10、K12 | T1 fake、T2 TCP、T4実store、T5実決済を分離 |
| FR-C23〜26、EV-12/13 | K03/04、K06、K10〜14 | T1失敗表→T4実障害→T5 unknown→T6保存再読取。Router再送機能は保証しない |
| FR-C27〜29、NFR-C5、EV-16 | K04、K08、K11〜15 | T1秘密非出力、T4実内部logging/隔離、T5/T6相関証拠/開示 |
| NFR-C1/C2、EV-11 | K01、K09、K11 | T0成立条件、T3環境読取、T4起動込み実HTTPS。warm変更は別判断 |
| NFR-C3 | K03、K09〜12 | T1累積機構、T3料金確認、T4実費/停止、T5販売収支 |
| AC-C1〜3/C6 | K08、K11、K12 | T4実モデル＋T5条件確認済み実Compass購入 |
| AC-C4/C5 | K13、K14 | T6二購入の各脚決済、配信、client受領、保存再読取、finality |

Claude Code独立再レビューLGTM、controller確認済み。ownerタスク段承認済み。K01/K05から順に実施する。実装・外部実行の成功や未決gateの承認を推定しない。
