# Compass — 東京L4の実選定probe（2026-10-15）

## 結論と範囲

固定した英語8ケースを実DiffusionGemmaへ1回ずつ送信し、**HTTP 200・許可済みID・事前期待値との一致が8/8**。これは3候補の小規模な選定成立性の実測であり、一般精度・製品受入・決済E2Eの合格ではない。モデルはコミュニティのdjev-runで自己ホストし、Google管理のJevサービスではない。

前回のHTTP422記録は保存したまま、criteriaだけを実imageの辞書形式へ修正した。同じexpectedと入力内容で再試験し、最初の有効応答をrunnerが自動判定してから残り7件を送信。期待値をモデルへ送っていない。実HTTPの生応答と事前fixtureをcontrollerが照合済み。

入力指示と評価タスクは同じ検証設計の中で作成し、3候補向けの必須情報・検索への逃避を避ける明示的ヒントを含む。未知候補/独立holdoutへの汎化を示すものではない。API化では候補固有の指示をこの3候補向けに固定せずcatalogの能力・必須入力メタデータから組み立てる設計とし、その汎用性は別途未検証と扱う。

## 対象と許可

- project/configuration: `subetha` / `subetha-compass`。
- `asia-northeast1-c`、`g2-standard-4`、L4×1、100GB pd-balanced boot disk。
- 既存Routerを変更せず、今回の使い捨てVM内だけDockerを使用。外向き通信用のephemeral外部IPあり。受信はIAP ingress限定、service accountなし、VMの絶対期限DELETEとboot disk auto-delete。firewall describeの実応答（許可source range/port/target tag）は `010-command.json` に保存されている。
- serving image: `ghcr.io/taeold/djev-run@sha256:efbf11a54e10c42b7d1379194befe100535171bfe9ed70dc1e431302d2b7a14b`。
- model: `nvidia/diffusiongemma-26B-A4B-it-NVFP4`、revision `ec4ff3df205028f4e81c954c2227f9312b3ec2ea`。
- ownerの「進めて良いです！！」で、新規最大1h・追加USD10・Mac IAP用loopback確認を明示承認。古い枠のリセットではない。今回のnot-afterは`2026-10-15T02:00:08Z`、cleanup込みの承認枠終端は`02:05:08Z`。期間内の再起動・追加推論は行っていない。
- Mac側のloopback確認はこの新しい直接承認後に成功。以前のCodex sandboxでの拒否は消していない。今回の許可は公開/常設・実支払・下流購入を含まない。

## 観測結果

| ケース | 実際の回答 | 事前期待値 | Mac→IAP→モデルの秒数 |
|---|---|---|---:|
| weather | `openweather_current` | 一致 | 9.298 |
| price | `coingecko_price` | 一致 | 0.308 |
| search | `exa_search` | 一致 | 0.327 |
| missing-location | `needs_clarification` | 一致 | 1.077 |
| ambiguous | `needs_clarification` | 一致 | 0.313 |
| unsupported-music | `none` | 一致 | 0.329 |
| unsupported-transfer | `none` | 一致 | 0.290 |
| untrusted-description | `openweather_current` | 一致 | 0.282 |

`needs_clarification`は確認が必要という**分類**。質問文の生成や追加回答後の再選定は未実施。`none`は能力不一致の分類であり通信失敗ではない。誘導文ケースは1件の観測であって、一般的なprompt injection耐性の保証ではない。候補は公開directoryの記載に基づく評価用メタデータで、現在購入可能・Router登録済みという証拠ではない。

- 初回要求: **9.298秒**。server自身の報告時間は9151.990msで、遅延の大部分がサーバー処理側にある。初回warm-upは可能な説明であって原因特定ではない。health okを低遅延readyと同一視しない。
- 残り7件: **0.282〜1.077秒**、中央値 **0.313秒**。
- VM作成→health確認: **896.954秒**。新規VMのインストール・重み取得込み。上記要求時間に含まれず、製品APIのcold/warm SLA試験でもない。
- probe開始→cleanup完了: **1068.169秒**。
- healthは`status=ok, mode=inproc-vllm`。各実応答は`model=dgemma`、`diagnostics.engine=vllm`。
- 生応答の確率辞書について5ID完全一致、有限値/範囲/合計、argmaxとchoice、confidenceと選択確率の一致を別途検査した。これらは返却値の整合であり、校正済み正答率でも生logit/全語彙の独立監査でもない。モデルconfidenceを支払権限にはしない。

## 削除と費用

runnerがVM（boot diskを含む）・firewall・subnet・networkを削除した後、controllerが新しいread-only CLI呼出しで5種すべて空を確認。確認時刻: `2026-10-15T01:23:54.282283+00:00`。VMの自動削除期限が実発火したという主張ではなく、期限前に明示削除された実測。実請求・credit残高は未確認で、予算をクラウド請求のhard capとは扱わない。

VM削除に続く冗長な `disks delete` はreturncode=1、`028-command.json` のstderrに対象diskの `was not found` を確認した。残存diskではなく、親の独立一覧も空。初期親read-backの記録を変更せず、追加の `parent-cleanup-command-receipt.json` に新規CLIの完全argv・filter・exit・stdout/stderr・時刻も保存した。

## 証跡

非公開local: `.claude_workflow/local/l4-run-20261015-010529/`

- `manifest.json`: 各HTTP status・無加工応答・期待値・時間・削除操作。
- `health.json` / `instance-created.json` / `serial-latest.log`: 健康状態、実VM設定、GPUモデル起動ログ。
- `parent-verification.json`: controllerによる生応答の再検査、計算値、元artifact hash。
- `cleanup-verification.json` / `parent-cleanup-verification.json`: runnerおよび親の別CLIによる削除確認。
- 入力: `probe/requests.jsonl`、事前期待値: `probe/cases.json`。hashは上記parent証跡へ固定。

CLI終了0だけでなく、上記の実応答と後続読取を根拠とする。Claude Code Opus5.5が今回の生応答と証跡を独立Read-onlyレビュー。評価指示とケースの同一設計という限界等を追記し、再レビューで実probe・証跡文書ともLGTM、必須修正なし。API試作への材料として十分との判定であり、製品readyの判定ではない。記録は `.claude_workflow/local/live-probe-review.json` と `live-probe-review-final.json`。以前の入力契約修正LGTMとは区別する。

## 次の最小段階と未検証

選定成立性の初期確認は通ったため、次はこの実応答をCompassの型付きAPI結果へ接続する最小実装を検討する。先に全決済基盤を作る順序には戻さない。API化ではcandidate IDを固定catalogへ照合し、chosen/needs_clarification/none/技術失敗を分離、上限・未準備・timeoutを決定的コードで制御する。公開の未払い推論は許可していない。

既存要件/設計/tasksに残るCloud Run・支払先行の記述は旧計画。以降の製品実装前に、owner指示どおりの選定→API→課金およびCompute Engine方針へ短く整合させ、独立レビューを受ける。今回の8件をK11全受入の代わりにはしない。

未検証: 反復・新規タスク・候補拡大・低confidence、cold/warm製品SLA、API/認証/永続化、Compass課金、別本人承認後の下流購入/配信、全体回帰の残存6失敗、審査用の継続deployment。常設は別予算・owner承認が必要。今回製品コードの変更なし。直近回帰は関連266成功/0失敗/0skip、全体2660成功/6失敗/29skipで、全体未合格。
