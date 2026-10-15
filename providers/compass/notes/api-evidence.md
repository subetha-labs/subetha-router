# Compass内部API — ローカル検証と実GCP試行の証跡

更新: 2026-10-15T03:37:33.088272+00:00

## 最新: API経由の実GCP検証は初回タイムアウト（2026-10-15T03:32:19.583948+00:00）

**結果: 未成立。** Mac上の最小Compass API → 実`httpTransport` → IAP → 東京L4の固定実モデルという経路で試行。API自体をGCPへ常設した実証ではない。

- 新規VM: `compass-api-l4-20261015-030007`。L4×1、東京c、既存と同じ固定startup/image/model revision。承認は最大1時間・追加USD10（disk/network込み）、VM絶対DELETE `03:40:05Z`、cleanup枠終端`03:45:05Z`。
- 新しいcatalog由来の入力を実APIが組み立て、事前固定入力と送信前に照合。期待値はモデルへ送らない。初回の有効な応答を得るまで後続を送らない方式。隠れwarm-upなし。
- 起動・health: HTTP200 / `mode=inproc-vllm`。run開始→healthは **1598.572秒（26.64分）**。リソース作成・boot・driver・重み取得/ロードを含む合計で、内訳は未計測。APIの応答時間とは別。
- API呼出1、上流transport呼出試行1。最初のweatherが **10.010720秒**でHTTP504 `model_timeout`。`transport_kind=unknown`、有効な選定回答0、残7件は未実施、期待値一致は`null`で**精度未評価**。0/8の正答率とはしない。
- API返答は`paid=false` / `purchaseEnabled=false`。自動再送0。失敗時にclientを終了したため、実GCP runで後続要求を送りlatch拒否を測ったわけではない（その受付停止の実測は先行ローカルTCP試験）。
- runnerは失敗直後`03:26:57Z`にserialを保存していた。そこに要求時間帯の **Triton kernel JIT compilation during inference / latency spike** 警告がある。初回推論のJIT遅延は有力な寄与要因だが、request ID付き受理/完了証跡・最終回答・正確な寄与秒数は取得できていない。「推論されなかった」「モデルが不正解」とは扱わない。
- `model.ts`のモデル全体/HTTP transportは10秒、`http.ts`のAPI全体は15秒。前回の直接probe初回も9.298秒であり、health成功を初回要求が10秒以内に返る保証とみなせない。今回はこれら製品コードを変更していない。
- VM/boot disk/firewall/subnet/networkは **03:28:39.934Zに削除完了**。親が別のfresh CLIで5種すべて空を確認。冗長disk削除のexit1は`038-command.json`に`was not found`。期限前に明示削除されたのであり、期限による自動DELETEの発火試験ではない。実請求額・credit残高は未確認、USD10は請求hard capではない。
- 検証済み製品source/config/test/fixture 15ファイルのhash、実VM metadataのstartup hashを親が再照合。既存Router・製品コード・依存変更なし。既存全体回帰6失敗は未解消。

証跡: `.claude_workflow/local/l4-api-run-20261015-030007/` の `api-results.json`, `manifest.json`, `health.json`, `instance-created.json`, `serial-latest.log`, `036-command.json`, `038-command.json`, `parent-verification.json`, `parent-cleanup-command-receipt.json`。入力は `.claude_workflow/local/api-live-inputs/requests.jsonl`。`l4-api-run-local-mock-*` は事前の保存応答テストであって実モデルの結果ではない。

準備用harnessはClaude Code Opus5.5のRead-onlyレビューで必須0・LGTM。その**後**の任意の削除2行補強（破損receiptの形を問わず削除続行、削除中SIGINT無視）は、準備時レビューの対象外で、親のexact AST fragment/4入力形検査を通した。今回の結果レビューではその2行も読まれている。事前mockも親が`PATH`/専用`HOME`/`CI`のみで起動したため、childの継承envは実runと同じ最小構成。

**結果レビュー:** Claude Code **Opus5.5実使用**・Read-only・権限拒否なしで、**失敗記録としてLGTM、High/Medium必須0、Low任意6**（`.claude_workflow/local/api-live-result-review.json`）。Low6点の文書上の明確化を本節へ反映。これは選定成功や製品readyのLGTMではない。reviewerは引用JIT警告と証跡記述を照合したが巨大serial/VM原本のhashを独自計算しておらず、それらの照合は親の実測。

**次の判断:** 課金段階へ進まず、cold初回の計測・待機期限/ready設計を見直す。`model.ts`にはモデル全体とHTTP transportの**10秒タイマーが2箇所**あり、`http.ts`にはHTTP全体15秒がある。いずれかだけを延ばすのではなく一体で検討する。`agent:false`による毎回の新規TCP/IAP接続の確立時間も未分離であり、JITだけを原因と断定しない。実測用のrequest-bound受付/完了ログを残し、推論不明時の受付停止・自動再送禁止は維持する。今回の最後のserialはtimeout約1秒後の03:26:57Z。削除後03:28:45Zの追加取得はresource not foundで、その後の完了は確認できない。次回は削除期限内での短い終端ログ回収を設計し、再推論や期限延長で代替しない。製品変更には計画差分/TDD/独立レビュー、実GPU再試験には別枠の承認が必要。今回枠の再起動・常設への転用はしない。

## 先行ローカル検証（2026-10-15T02:42Z時点）

`POST /internal/v1/select` の無課金・loopback限定試作について、実装、独立コードレビュー、親による単体/型検査、実TCP検証まで完了。製品受入・新しい指示による実モデル品質・決済成立を意味しない。追加GPU、外部推論、課金、公開、commit/pushなし。既存Router sourceは変更していない。

## 実測

| 対象 | 結果 |
|---|---|
| 親によるCompass単体再実行 | 151成功 / 0失敗 / 0skip |
| 型検査 | exit 0 |
| Router関連回帰 | 266成功 / 0失敗 / 0skip |
| Router全体回帰 | 2660成功 / 6失敗 / 29skip。前回と同じ失敗ID。全体未合格 |
| Claude Code独立レビュー | `claude-opus-5-5`、LGTM、必須High/Medium 0 |
| API入口の実TCP | 保存応答8件、拒否400/403/415、stream超過413、body期限408、busy、切断abort、unknown受付停止、モデル期限504と後続受付停止。exit 0 |
| API→HTTP接続先の実TCP | 本実装の`httpTransport`で保存応答8件を往復。完読した非200/不正応答の後は再受付、64KiB超過/途中切断/10秒期限は受付停止・追加送信0。exit 0 |

後者は127.0.0.1上に保存応答サーバーを置き、`httpTransport`を`source=recorded-fixture`として注入したcontroller検証。バックエンド要求は計15回（正常8、完読失敗2とその後の正常2、不明終了3）。モデルは動かしていない。両試験ともlistener/接続を終了し、processは正常終了した。実装・試験入力のhashは親unit時と同一だった。

## 証跡ファイル

すべてworktreeの `.claude_workflow/local/` 配下。

- `api-parent-unit.json` / `api-parent-unit-tests.json`: 単体・型検査、実行前後hash。
- `api-review.stdout`: 独立レビュー原本。ソースLGTMであり実TCP成功とは分離。
- `api-regression-baseline-summary.json`: 関連/全体回帰。前回の `contract-regression-baseline-summary.json` と親が失敗IDおよびroot/依存fingerprintを比較。
- `api-parent-tcp.json` / `api-parent-tcp-tcp.log`: 入口側TCP実測。
- `api-parent-upstream.json` / `api-parent-upstream.log` / `api-upstream-tcp-check.ts`: HTTP transportの追加実測。controller harnessであり、上記独立レビューの対象には含めていない。
- `api-verification-checkpoint.json`: 証跡hashと検証済みコード/設定/fixtureのhash。

## 先行ローカル検証時点の境界（最新状態は冒頭）

- 新しいAPI指示・metadata構成を実モデルに送った品質確認は未実施。前回GCPの8/8と今回の保存応答replayを混同しない。
- 実TCPでの遅い送出/backpressureによる15秒打切りは未検証（socket-free単体のみ）。
- レビューLow 5件は未修正。ソースLGTMの範囲内であり、解消したとは扱わない。
- rootの6失敗と原因/完全比較可能性の保留を維持。新失敗IDなしだけで無回帰を断定しない。
- 課金、下流Providerの購入、受領、永続化、公開認証、GCP常設運用、モデル/worker licenseゲートは未達。
- 前回GPUの費用枠は終了済み。再接続に必要な新規クラウド起動は別途承認が必要。
