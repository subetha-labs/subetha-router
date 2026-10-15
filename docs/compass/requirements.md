# SubEtha Compass 要件（requirements, 第 1 段・改訂 1）

## 0.4 Compass Provider（審査期間の wake 方式公開、2026-10-28 まで・要件、改訂 6）

本節は§0.3の成果を前提に、ownerが2026-10-15夜に承認した新しい範囲の正本とする（承認記録 `.claude_workflow/local/compass-provider-authorization-20261015.json`）。§0.2の「使い捨て・1時間・常設なし・未認証公開なし」は本節で明示的に置き換え、それ以外の§0.2/§0.3の固定物（project/configuration/region、L4×1・8 vCPU・32 GiB、max 1、モデル revision、serving image digest、`compat_policy=hide`、4候補catalog hash、下流購入・支払なし）は維持する。独立レビュー r1（REJECT 7 MUST）・r2（REJECT、4件未解消）・r3（REJECT、3件未解消）・r4（REJECT、1件未解消）（`.claude_workflow/local/compass-provider-review-requirements-r{1,2,3,4}-result.md`）を反映した改訂。

- **目的**: ハッカソンの審査員が、既存Router（`https://router.subethalabs.com`、本体は変更しない）または直接の x402 クライアントから、Compassの選定（4候補からの `chosen`／`needs_clarification`／`none`）を **Base Sepolia USDC の x402 支払いで** 受け取れる。実モデルの応答だけを配信し、fixture replay・keyword分岐・CPU代替モデルを置かない。応答の `paid=false`／`purchaseEnabled=false` は「Compassが下流APIを購入していない」の意味であり、Compass自体の有料配信とは別の欄である（README に明記）。
- **稼働形態（owner決定）**: min instances は 0 のまま。初回接続で GPU instance を起動し、準備完了後に有料要求を受ける。常時稼働（min 1）は採らない。service・image（Artifact Registry）・runtime identity・受取先の記録を **2026-10-28（ファイナリスト発表、JST）まで保持し、2026-10-29（JST）に controller が削除**して別読取で不在を確認する。削除対象と責任者はmanifestに固定する。
- **待ち時間の開示（必須・§0.3の実測に限定）**: README、Router向け手順、`/health` の応答本文に次を記載する。「停止状態（instance 0）からの復帰は実測 1 回で、要求送信→instance 起動 約1秒、engine 準備 約147秒、要求→応答 161.3秒（§0.3）。新 revision の deploy 時には GPU 割当に 8.5分かかった例があり（§0.3）、GPU の割当待ちが発生すると復帰も数分〜10分超になり得る（推定、未実測）。最後の要求から約11.5分後に instance 0 を観測した（§0.3）。停止までの時間は Cloud Run の挙動で保証値ではない。起動中の要求は Cloud Run が保留し、request timeout 600秒で失敗し得る。timeout 後も起動が続くかは未実測で、受入(5)で確認する」。**wake の手順（有限）**: `/health` を 60 秒間隔で確認し、最初の wake から **最大 15 分（900 秒）** で 200 にならなければ起動失敗として確認を止め、購入へ進まず報告する（revision の startup probe 失敗は Cloud Run 側で instance を失敗扱いにし、次の要求が新しい起動を始める）。審査員役の wake は 1 セッションあたり 2 回まで。推定・未実測はそう明記し、保証と書かない。
- **wake と支払いの分離（厳密化）**: `GET /health` は無料・無認証・推論なし。instance 起動の契機かつ準備確認手段。起動中（startup probe 未通過）は **アプリは応答できず、Cloud Run が要求を保留または失敗させる**（アプリによる503案内はできない。案内は README/手順と、準備後の `/health` 本文で行う）。有料 `POST /select`（JSON body、8 KiB、既存 `/internal/v1/select` の公開版）は次を満たす。(a) model 未準備・busy・停止中は、**credential の有無にかかわらず verify/settle を一切呼ばず** 503（`Retry-After` 付き）を返す。(b) 準備済みで credential なしなら 402 チャレンジ（x402 v2 `exact`、`network eip155:84532`、asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`（USDC、decimals 6、EIP-712 domain `USDC`/`2`、`src/shared/networks.ts` と一致）、`amount` **10000**（0.01 USDC、Router の `maxUpstreamAmount` 10000 以下）、`payTo` は専用受取アドレス、`maxTimeoutSeconds` 60）。チャレンジは無状態で、instance 再起動後も同じ値を返す。(c) credential 付きなら、受付（ready・空き）を再確認 → facilitator `verify` → 推論 → `settle` → 配信の順。verify 失敗・期限切れ（stale）は新しい402で応答し settle しない。(d) **at-most-once と durable な記録**: 決済の at-most-once は EIP-3009 の nonce がチェーン上で一度しか使えないことで成立し、Provider の記憶に依存しない。推論・settle の試行を instance 再起動をまたいで一度に限るため、Provider は **専用の非公開 GCS bucket**（runtime identity だけが objectAdmin、他の権限なし）に nonce ごとの小さな記録を書く。順序は **verify 成功 → `accepted/<nonce>`（推論の前、受付の永続記録）→ 推論 → `settling/<nonce>` → settle → `settled/<nonce>` → 配信**。credential 到着時に `accepted`・`settling`・`settled`・`unknown` のいずれかが存在すれば **推論も settle もせず** 409 と記録の種別・nonce を返す（推論の試行も instance 再起動をまたいで一度）。`settling` があって `settled` が無い nonce は settle の結果不明として扱い（instance 終了・応答喪失）、Provider は自動で再試行・再 settle せず、controller の手動 inspect（チェーン上の nonce 消費の確認）だけで `unknown/<nonce>` または `settled` に閉じる。`accepted` だけが残る nonce（推論中の終了）は、支払いが成立していないので再提示を 409 で拒むが損失はない旨を本文に含める。GCS に書けない時はその段で止める（`accepted` 前なら 503 課金なし、`settling` 後なら settle を送らない）。(e) **paid, no data の窓**: settle 要求を送った時点から応答が client に届くまで（settle 成功後の `settled` 書込失敗・配信前の instance 終了・応答喪失を含む）。この間に終わると支払いは成立し返金されない。README に開示する。
- **Router 経由の支払いの事実**: hosted Router の `subetha_router_quote_url` は **POST + JSON body**（8 KiB 以下、x402 EVM 経路）を受け付ける（ツール schema と `docs/dynamic-upstream-post-design.md`）。Base Sepolia x402 の upstream に到達する profile は **他レール起点の7件**（`dyn-mpp-to-x402`〔Tempo pathUSD〕、`dyn-arc-to-x402`、`dyn-sol-to-x402`、`dyn-solmpp-to-x402`、`dyn-rh-to-x402`、`dyn-arbsep-to-x402`、`dyn-hyperevm-to-x402`、2026-10-15 の listing）で、Base→Base の同レール profile は無い。したがって Router 経由の審査員は上記いずれかのレールで支払い、Router が Compass に Base Sepolia USDC を払う。**Router は inbound の支払いを受けてから upstream を呼ぶ**ので、quote 時に Compass が準備済みでも purchase 時に停止していれば `paid_data_unavailable`（返金なし）になる。手順書では「`/health` 200 を確認 → quote → 直ちに purchase（quote の deadline 内、数分以内）」を必須とし、この残リスクを開示する。Router の listing・静的 route・本体は変更しない（Compass の URL と手順を README で配る）。
- **公開範囲（§0.2からの変更）**: `/health` と `/select` は公開URL（IAM 認証なし）。支払いが有料経路の認可を兼ねる。他 path・モデル endpoint・内部 API は公開しない。
- **同時要求の枠（§0.2からの変更）**: Cloud Run の `maxInstanceRequestConcurrency` を **2** にし、アプリの推論枠は **1** のままにする。これにより推論中でも 2 件目の要求がアプリに到達し、`/health` は応答でき、`/select` は verify/settle に進まず busy 503 を返せる（platform で待たせると、解除後に到達して決済に進んでしまう）。推論の同時実行は 1 のまま変わらない。instance は 1 台のまま。
- **費用・wake 連打・停止**: Cloud Run はアプリより前に instance を起動するため、**アプリ側で wake を拒否・冷却することはできない**。費用の上界は「max 1 instance × 稼働時間」だけであり、公開 `/health` への連打は instance を起動し続け、idle 時間もリセットする。これを承認記録に明記し、次で監視・停止する。(i) Cloud Billing 予算 USD30（50/90/100% アラート、owner 宛）。(ii) controller が **6 時間以内の間隔**で `instance_count` の積算（GPU 稼働時間、active/idle/欠測を稼働扱いの保守的な数え方）を読み、記録する。**改訂 6（設計 r2 の指摘）**: gcloud から請求実績は読めないため、Billing の実績読取は予算アラート（50/90/100%、owner 宛、通知のみ）に置き換え、停止判断の根拠は GPU 時間の積算とする。**停止規則（owner の確認が設計前に必要。承認記録 `stop_rule.owner_confirmed` が true になるまで実装・公開しない）**: 累積 GPU 稼働が **8 時間（≒USD14）** に達した時点で controller は owner の指示を待たずに service を削除し（image は削除日まで保持）、事後に報告する。6 時間到達で owner に事前警告する。Billing 予算の 90% アラートも同じ停止の契機とする。**検知遅延の上界は読取間隔 6 時間**なので、最悪 14 GPU 時間（≒USD24）＋保存・ログ約 USD3 で USD30 以内に収まる見込み。controller が 6 時間以上読取できない見込み（Mac 停止等）なら、その前に service を削除する。これらは計画上の規則で、cloud 側の hard cap ではない。(iii) **drain**: SIGTERM 後、新規は 503、進行中の有料要求は Cloud Run の猶予 10 秒内で、まだ settle 前なら推論を中断して 503（課金なし）、`settling` 記録後で応答がなければ `unknown/<nonce>` を GCS に書いてから終了する（再試行しない）。settle 後なら配信を試み、終了すれば (e) の開示どおり。計画上限 USD30 は build（§0.3 の 1 回分は既支出）、CPU/RAM、ログ・通信、保存、削除を含む見込み値で、請求 hard cap ではない。
- **鍵と秘密**: x402 Provider は秘密鍵を持たない。`payTo` は owner が新規に作る受取用アドレス（既存鍵・payer の鍵は使わない）、facilitator は `https://www.x402.org/facilitator`（Router の inbound と同じ公開 facilitator、認証不要）。runtime が必要とする秘密は無し。受け取った testnet USDC は配信の証跡としてのみ扱う。ログに支払い credential・生 prompt を残さない。
- **受入（実測 gate、各1件以上）**: (1) instance 0 を Monitoring で確認した状態から審査員役が `/health` で起こし、200 後に **直接 x402**（`npm run sign` 相当のクライアント）で `/select` を購入し、期待どおりの選定（`probe/demo-cases.json` の4件のいずれか）を受領、`paymentId`/settle の tx と `bootId` を照合。(2) 同様に **Router 経由**（`dyn-*-to-x402` の1つ、POST body）で quote→purchase が **195秒以内**に `delivered` で完了。(3) 未準備時に credential 付き `/select` を送っても facilitator の verify/settle が **0 回**で 503。(4) stale（期限切れ）credential、同一 nonce の再提示、busy 中の2件目がそれぞれ settle なしで拒否される。(5) wake 要求を 600 秒の timeout まで放置し、その後 60 秒間隔・最大 15 分の再確認で 200 に到達するかを **観測して記録**し、README の記述を観測結果（到達した／しなかった、所要）に合わせる。断定は観測後にだけ行う。(6) 開示文が README・手順・`/health` 本文に存在。(7) 2026-10-29 の削除と別読取。(8) **再起動をまたぐ重複**: 配信済み credential を instance 0 の観測後に再提示し、新 instance が GCS の `settled` 記録により推論・settle なしで 409 を返す。さらに controller が `settling/<nonce>` だけの記録と `accepted/<nonce>` だけの記録を bucket に置き、それぞれの nonce の再提示が推論・settle なしで 409（結果不明／受付済み）になることを確認。(9) **quote 後の受付不可**: Router 経由で quote を取り、Compass の推論枠を **別の `/select` で占有**（platform concurrency 2・アプリ推論枠 1 により、purchase の要求は待たされずアプリに到達して busy 503 になる）した状態で purchase し、Compass の要求ログ（同じ `bootId`、purchase 由来の要求が到達して 503 で終わった記録）と Router 側が `paid_data_unavailable` 等（inbound は返金されない）で終わったことを両側の記録で示し、Compass 側の verify/settle が 0 回であることを facilitator 呼出のログで示す（testnet の少額損失を伴う試験として承認記録に含める）。instance 0 からの保留→到達の経路は (11) で別に観測する。(10) **停止時の進行中決済**: (10a) 実機：推論中に controller が service を削除し、Compass が settle 前の 503 で終わり settle が 0 回、チェーン上で nonce 未消費。(10b) settle 要求送出後の応答喪失は実機で意図的に起こせないため、**ローカルの偽 facilitator**（応答を返さない）で `settling` 記録→終了→`unknown` 扱いの経路を試験し、GCS への記録書込は実 bucket への 1 回の staging 書込で確認する。二重 settle がないことは (8) の `settling` 再提示で確認。(11) **二種類の未準備**: startup probe 前の cold 要求（platform が保留・失敗、所要を記録）と、アプリ到達後の未準備（model child 停止時の 503）を別々に観測。本節の記述だけでは何も成立しない。
- **追加される専用資源**: 非公開 GCS bucket 1 つ（nonce 記録、公開アクセス禁止、soft-delete 0、削除日に削除）と、それへの runtime identity の objectAdmin。これ以外の資源・権限は増やさない。
- **含まないもの**: mainnet・実資金、Compass による下流 API の購入・呼出、min 1 常時稼働、自動 warm-up、複数 instance、別 region/GPU/model、quota 増枠、Router 本体・listing の変更、MPP。

## 0.3 Cloud Run L4試行の結果と要件からの逸脱（2026-10-15・実測済み）

§0.2の試行は3回目で成立した（run `cloud-run-run-cr2-t3`、記録は `providers/compass/notes/cloud-run-evidence.md`）。本節は§0.2の要件に対する達成・未達・逸脱の記録であり、常設hosting・未認証公開・下流購入/支払・Compass課金の許可を追加しない。

- **達成**: 認証付きAPI（ownerのidentity token、allUsersなし）から、実モデル（`modelSource=live`、catalogSha256 `7db0f0d1…`）がETH perp→`hyperliquid_eth_perp`、SOL perp→`hyperliquid_sol_perp`、Uniswap spot→`uniswap_usdc_weth_spot`、Exa→`exa_search` を各1件、同一instanceで正しく選定した。`purchaseEnabled=false`／`paid=false` を維持。Monitoring `instance_count` の明示zero（active 0／idle 0、12:46:00Z）の後、ETHの同じintentを1回再送し、新boot IDで同じ選定を受領（要求→応答161.3秒、result `observed-zero-restart`）。boot log照合は2 boot全件一致。全専用資源を削除し、別のgcloud読取で不在を確認した。
- **計測値（§0.2「coldとwarmの分離」、revision-logs.txtとmanifestの時刻から）**: service create 12:22:49Z→instance起動12:31:30Z（約8.5分、GPU割当）、instance起動→engine ready 約161秒（内部timer値151秒）、readiness後の初回推論11.1秒（cold start ではない）、warm 0.3〜3.1秒。明示zero sample 12:46:00Z→post-zero要求送信12:47:04Z→新instance起動12:47:05Z（zero sampleからは約65秒、要求からは約1秒）→engine ready 約147秒（内部timer値139秒）→応答12:49:46Z。GPU課金はcreate→cleanup完了（12:50:32Z）で約28分。3回の試行の累計費用見込み約USD3.3（請求額・creditは未確認）。
- **要件からの逸脱（owner承認済み、2026-10-15夜）**:
  1. CUDA compat方針を、設計/tasks §0.2の既定「保持」から「除外」に変更した（要件§0.2「固定対象とアクセス」はbuild前に方針を固定することだけを求めている）。2回目の試行で、Cloud Run L4のdriver 580.126.20とimage同梱のcompat libcudaの組み合わせがCUDA error 803で起動に失敗したため（VMと同じ現象）。`images.json` の `compat_policy=hide`、親baseline再生成。
  2. 「再送やrestartによる失敗回避をしない」に対し、GPU起動失敗（Cloud Run operation code 9・startup probe失敗と明示分類できる場合のみ）に限り、同じimage・runtime identityを保持して同じGPU 1時間の枠内で1回だけ再作成できる経路を追加した。quota拒否・不明結果・readiness後の失敗は保持せず全削除する。この再作成時の期限は `now + (3600 − 初回attemptの使用秒)` で再設定されるため、attempt間の待機時間は3600秒に算入されず、§0.2「最初の作成時刻＋3600秒を再作成でリセットしない」と異なる。これはbuild約40分の再実行を避けるためで、3回目では使われていない。
  3. 起動コマンドの上書き（Cloud Run service specの `command`/`args` のみ）を、再buildなしの起動調整手段として追加した。3回目では使われていない。
- **未達・保留**: 1回目は harness の誤り（regional buildの操作名を誤ったURLで待機、buildのimage一覧の形）で中断、2回目はCUDA 803で中断。いずれも全資源削除を別読取で確認。既知の未修正（nonblocking）: GPU使用秒の最終書込がcleanup lockの外にあり、watchdogの書込に上書きされた（3回目の再試行枠には影響なし）。実請求額の確認、常設化・課金・API Provider化は本節の範囲外で別の要件・承認を要する。

## 0.2 使い捨てCloud Run L4試行（2026-10-15・最新承認範囲）

本節を今回の範囲の正本とし、下の§0.1・§0および旧本文の矛盾する実行保留・構成・前提だけを本試行に限って上書きする。既存4候補catalog/source/testsの受入済みローカル結果と過去の証跡は維持し、実モデル品質やCloud Run成功へ読み替えない。Router/sourceと旧cold C3〜C7は各段の明示allowlist以外HOLDとし、旧11ケースframeworkの完了を前提にせず、拡張もしない。

- **目的と受入**: 外部の許可された呼出主体が認証付きAPIから、Hyperliquid ETH（perpetual mark price・24時間変化）、Hyperliquid SOL（同）、Uniswap（Ethereum USDC/WETH pool spot参考価格）、Exa（topic指定web検索）の各代表英語intentについて実モデルによる正しい選定を受領する。4候補版/hashを固定し、共通の能力・必須入力metadataから選ぶ。fixture replay・keyword分岐は代替証拠にしない。既存の `chosen`／`needs_clarification`／`none` と技術errorの区別、`purchaseEnabled=false`／`paid=false` を維持する。選定対象APIの購入・呼出・下流支払、Compass課金、署名・送金は含めない。
- **固定対象とアクセス**: project `subetha`、configuration `subetha-compass`、Singapore `asia-southeast1`、L4×1・8 vCPU・32 GiB、min instances=0／max instances=1、concurrency=1、GPU zonal redundancy off。複数service/revisionの重複稼働も防ぐ。モデルは `nvidia/diffusiongemma-26B-A4B-it-NVFP4`、revision `ec4ff3df205028f4e81c954c2227f9312b3ec2ea`、元serving imageは `ghcr.io/taeold/djev-run@sha256:efbf11a54e10c42b7d1379194befe100535171bfe9ed70dc1e431302d2b7a14b` に固定する。Cloud Run用包装が必要なら、build前にbase digest・出所・変更範囲（VM版のenv・CUDA compat回避・UNWRAPを引き継ぐか変更するかを含む）を固定し、build後かつGPU service作成前に最終image digestをmanifestへ記録する。deployはそのdigest参照だけを許す。APIは最小IAMの許可主体だけが呼べる認証付きとし、未認証推論・モデルendpointの直接公開を許さない。
- **coldとwarmの分離**: 初回cold要求、同じ稼働instanceでのwarm要求、instance数ゼロを実観測した後の第二cold要求を別々に記録する。初回要求はdeployが起動済みのinstanceへの初回推論とrequestが起動を誘発したcoldを区別し、instance識別子・bootログとの相関がない場合はcold未確認と記録する。warm要求も同じinstance識別子であることを確認し、max1や時間の近さでは推定しない。deploy時のreadiness起動・load・idleも費用と3600秒枠に含める。先行warm-upを隠さず、要求開始から受領までの時間と起動・load・初回推論を区別する。health成功や単なる待機時間をcold完了・scale-to-zeroの証拠にしない。各要求の期待値・最大件数・有限期限を実行前に固定し、試行数・有効回答数・正しい選定数を別記する。共通障害・timeout・unknownで停止し、再送やrestartによる失敗回避をしない。正常な観測済みzeroからの第二coldは承認された別計測であり、失敗再試行ではない。zero未観測や第二cold未完了は未達とし、枠を延長しない。
- **費用と絶対期限**: 準備（build・モデル保存・registry等）、GPU、CPU/RAM、通信・ログ、cleanupまで合計USD10以内とする。最初の実GPU service作成時刻を起点に最大3600秒、cleanup/readback完了の絶対期限をその時刻＋3600秒以内に固定する。起動・load・idle・zero待機・再起動も同じ壁時計枠に含め、health成功・第二cold・再作成でリセットしない。作成時刻が不明なら作成要求開始時刻を保守的起点とする。準備開始時刻を起点とする有限の準備期限と、GPU作成に進まなかった場合にも有効な準備資源cleanup絶対期限を、最初の有料準備より前にmanifestへ固定する。GPU枠へ進んだ場合も3600秒以内のcleanup/readbackは準備資源を含む全専用資源を対象とする。削除・確認の余裕を先に確保し、残予算不足なら要求を開始せずcleanupへ進む。USD10とmax1は請求hard capではなく、常設hostingや次回試行の許可でもない。
- **quota訂正**: researchおよび `cloud-run-probe-authorization-20261015.json` の旧「有料build・保存・GPU作成前に正のquota割当を確認」というgateは、今回の公式資料再確認に基づくcontrollerの計画訂正により前提から外す（ownerによる追加発言・増枠承認があったという意味ではない）。公式GPU文書にある初回regional deployment時の標準nonredundant L4 quota自動付与（3 L4）はownerによる増枠申請ではなく、使用許可は上記L4×1だけである。controller報告の `run.googleapis.com` 有効化、quota `details={}`、Singapore L4/8CPU/32Gi/min0/max1のREST `create(validateOnly=true)` HTTP200、後続 `list=[]`／`describe=not-found` を区別する。空のquota詳細は割当成功でも拒否でもなく、dry-runはservice作成・実GPU割当・容量確保の証拠ではない。初回前のquota数値欠落だけでは停止しないが、実作成は承認時間・費用枠内に限り、実際のquota拒否で停止する。手動増枠、再試行、region/GPU/model/executorの代替は禁止する。
- **有料準備前の成立性gate**: controllerが固定モデルの重み容量、配置・取得・展開・cache・重複copyとload時ピークRAM/VRAMを調査し、32 GiB/L4に収める根拠を記録する。VMのdisk hardlinkを `/dev/shm` にmountする既存手法はCloud Run互換とみなさない。GPU startup probeの1800秒記述と一般container起動4分記述の適用条件、実際に受理される設定、request/API/model/client期限の整合を調べる。上流RTXの47.5秒やdry-runをL4実起動実績とせず、有界な起動・初回推論・zero待機・第二cold・cleanupが枠に収まる見込みを確認してから有料資源へ進む。実起動・メモリ適合はなお実測gateとして残す。
- **manifest・cleanup・段階**: 外部操作前にcontrollerが正確なresource名/ID、project/region、service/revision・build・image・保存object等の作成/変更/削除範囲、API/IAM/呼出主体の最小権限、モデル/catalog/入力の固定識別、費用内訳・時間枠・cleanup責任とreadback対象をmanifestに固定する。成功・失敗・拒否・中断を問わず専用資源と一時権限を無条件cleanupし、独立した再読取で削除/復元を確認する。準備段階の失敗でも準備資源を回収し、削除失敗・未確認は残存として報告する。zeroだけではcleanup完了としない。外部操作はcontrollerのみ。本段はCodex gpt-6-astraによる本節追記だけとし、Claude opus-5-5の独立read-onlyレビュー→設計→独立レビュー→タスク→独立レビューの順を守る。workerはcontroller所有lock/stateを操作せず、設計/tasks/source、cloud/network/Docker/install、credentials/.env、git変更、他worktreeへ触れない。


## 0.1 Existing-resource demo scope (2026-10-15)

本節はowner承認済みの独立ローカルsliceとして、旧catalogの選択とC3〜C7の優先順だけを上書きする。既存の期限・入力・wire・安全契約と過去の記録は維持する。cold workflow・cronはHOLDのまま、自動続行せず、拒否されたcron execute_code payloadの再試行ではない。
目的は既存資源4件を使えるCompass選定であり、新Provider・汎用framework・通貨やnetworkのroutingを作らない。既存 `directory-v1` の3件snapshot・fixtures・default、probe原本・保存応答は無変更とし、別catalogを追加する明示opt-inだけを後続範囲とする。

候補は次の4資源に限定する。表の資源説明は能力の識別であり、実行route・購入条件・支払可能性を表さない。

| 資源 | 選定対象の能力 |
|---|---|
| Hyperliquid ETH | ETH perpetualのmark priceと24時間変化 |
| Hyperliquid SOL | SOL perpetualのmark priceと24時間変化 |
| Uniswap | Ethereum上のUSDC/WETH poolのspot参考価格 |
| Exa | 明示された情報・topicについてのweb検索。最小必須入力はtopic |

選定metadataに実行URL、quote・価格値、chain/network設定、支払条件・許可を持たせない。能力説明はpayabilityを保証しない。既存の `purchaseEnabled=false`／`paid=false` 契約を維持し、結果は資源の `chosen`、`needs_clarification`、`none` に限る。clarificationは結果を返すだけで、質問文生成や対話管理を追加しない。
共通指示と能力・必須入力からモデルが選ぶ。決定的keyword router、候補固有if、task→期待回答lookupでモデル選定を代替しない。後続の英語intent casesは以下を含み、期待値は要件であって推論成功の証拠ではない。

| 英語intent例 | 要求する結果 |
|---|---|
| “Get the Hyperliquid ETH perpetual mark price and 24-hour change.” | Hyperliquid ETHを選定 |
| “Get the Hyperliquid SOL perpetual mark price and 24-hour change.” | Hyperliquid SOLを選定 |
| “Get the Uniswap Ethereum USDC/WETH pool spot reference price.” | Uniswapを選定 |
| “What is the ETH price?” / “What is the price?” | 資源・価格種別が曖昧なため `needs_clarification` |
| “Get the exact current BTC price.” | 対応資源なしの `none`。検索で価格を代替しない |
| “Search the web.” | topic欠落の `needs_clarification` |
| “What is account abstraction?” / “Find recent updates about Ethereum scaling.” | 一般的なtopicの質問・更新情報としてExaを選定 |

後続の有界な受入はsocket-free・offlineに限定する。catalog読込の妥当性・不正入力拒否、選択版に対応するrequest criteria、parsed responseの候補整合・不正応答拒否、API handlerの選定／clarification／noneと既存error契約を検査する。backend応答は明示的にsyntheticとし、fixture一致をモデル品質・実推論の成功と呼ばない。
旧3件版と新4件版をversion/hashで隔離し、版の取り違え・他版の候補混入を拒否すること、defaultと旧snapshot/fixturesが維持されること、禁止されたURL・価格値・支払fieldが混入しないことを受入に含める。具体的な型・schema・実装方法は本要件では設計しない。
既知の根拠は `providers/x402-workers/src/config.ts` と `docs/provider-x402-workers.md` のETH/SOL、SOLの過去の公開unpaid curlのHTTP402（description: SOL perpetual snapshot）、README/docsの旧Provider B Uniswap、`docs/mainnet-first-route.md` の過去のExa有料検索成功である。いずれも今回の現行runtime・支払E2Eの新規証拠ではない。
本sliceの外部支払は未実施。ローカルmetadata・合成契約試験が完了しても、4資源の実モデル選定品質と購入・支払・配信のE2Eは別の未達gateとする。
進行順は本要件のClaude opus-5-5による独立read-onlyレビュー→設計→独立レビュー→タスク→独立レビュー→承認範囲内の実装とする。今回はCodex gpt-6-astraが本ファイルだけを追記し、設計・製品変更・テストは行わない。controller所有lockを維持し、第二worker起動、state/lock操作、並行テストを行わない。
後続テストも別途レビュー済みallowlist内で、既存controller helper `python3 .claude_workflow/local/run_cold_check.py product UNIQUE_LABEL` と `types UNIQUE_LABEL` のみを継承lock下で使う。環境をscrubする `.c0` 経路を維持し、raw npm test・listener・C3 harnessは使わない。拒否時は停止し、迂回・executor/model置換・quota再試行をせず、時間上限は未完了とする。
既存cold runtime・local runner/client、`model.ts`／`http.ts`／`server.ts` とその試験は別途レビューされたタスクなしに変更しない。追加tracking文書は作らず、後続記録は正本文書と小さな実装証跡noteに限る。commit/push・git変更・network/cloud/GPU・install/deploy・有料API・faucet・wallet/key/.envアクセス、Router core・他worktree・保護文書の変更は本承認に含めない。

## 0. 現行要件：選定 → 最小ローカルAPI → 課金（2026-10-15）

現在地は[API検証証跡](../../providers/compass/notes/api-evidence.md)を正本とする。最小ローカルAPIの先行実装・独立レビュー・親による単体/型検査/実TCP検証の後、別途承認されたAPI経由の実GCP試行を行ったが、初回timeoutで未成立となった。「追加cloudは一度も実施していない」とはしない。今回のowner承認範囲は、その結果を受けた**初回起動時の待機・タイムアウト・完了ログのローカル設計見直しだけ**である。今回、新規cloud・推論・有料再試行・実装・テスト実行・公開・課金は行わない。

**本節を現行の範囲と進行順序の基準とする。下の最初の区切り以降は歴史的な課金版計画であり、状態表示・「今回」・依存順序も当時の記録である。** 旧FR/NFR/EV/AC、過去のレビュー・失敗・未達を削除・達成扱いにしない。今回の差分は未実装であり、既存レビューLGTMや先行試験結果を差分の合格証拠へ流用しない。

### 0.1 観測済みの事実と維持する契約

- [旧直接probe](../../providers/compass/notes/model-evidence.md)は固定英語8件で8/8一致。新API経由の試行はAPI呼出1・transport試行1、初回が **10.010720秒で504 `model_timeout`**、transport結果はunknown、有効回答0、残7件は未試行である。新APIの品質は未評価であり、0/8の正答率でも旧8/8の再現でもない。
- run開始からhealth成功までの **1598.572秒**はprovisioning・download・load等の混合集計で、内訳は未計測。API SLAや初回推論時間ではない。同時間帯のJIT警告は寄与要因の候補であり、要求に結び付いた受理/完了や原因・寄与秒数を証明しない。
- 当該VM・boot disk・firewall・subnet・networkは削除済み。前回の承認枠は消費済みで、期限も再利用しない。新規GPUには新たなowner承認が必要であり、本節はその承認ではない。
- 現runtime方針は東京GCE L4 `g2-standard-4`、既存Router EC2は無変更。Cloud Run構成A／RTX、支払先行、32 receiver/proof運用は未採用の後段hold。常設・公開・追加cloud実行を今回に含めない。
- `POST /internal/v1/select`、支払版と別schema、strict入力、固定catalog、型付き `chosen`／`needs_clarification`／`none`、非200技術errorを維持する。制御可能なJSON応答は `purchaseEnabled=false`／`paid=false`、購入条件・領収なし。HTTP parser段の固定/空bodyの例外も維持する。
- `exa_search`／`coingecko_price`／`openweather_current`はdirectory metadataのみで、購入可能・Router登録済み・購入条件確認済みとはしない。[probe目録](../../providers/compass/probe/catalog.json)と[事前要求](../../providers/compass/probe/requests.jsonl)を保存する。能力・必須入力metadataから共通指示を作り、候補固有のif選択やtask→answer lookupを設けない。過去8件は独立holdoutではなく、保存応答replayは新しい推論・品質合格ではない。
- 既存の入力/JSON/Unicode/byte上限、固定wire・確率検査、loopback限定、Host/Origin等の防御、redirect禁止、環境変数/proxyの暗黙利用禁止、製品のmain/live起動scriptなし、新依存なしを維持する。具体契約は[設計§0](design.md#0-現行設計最小ローカル選定api2026-10-15)、変更ファイルと受入は[タスク§0](tasks.md#0-現行タスク文書整合から最小ローカルapiへ2026-10-15)で順次差分レビューする。両文書の先行版にある追加cloud未実施の記述も、過去のAPI試行と今回の設計見直しを区別して整合させる。

### 0.2 待機・期限・受付の要件

起動待機、health観測、初回要求、transport、API応答完了、controller受領、cleanupを別の段階とする。起動待機時間をAPI期限に足さず、health成功を初回推論の時間保証としない。`backendPort`設定による現行 `ready` は構成上の受付可否であり、remote/model readinessではない。loopback TCP connectもIAP先やモデルの要求受理を証明しない。

以下では、API factoryも同一process内で動かすTypeScript harnessを「controller client」、そのchild・資源・cleanupを管理するPython harnessを「orchestrator」と呼ぶ。

期限は内部factory/controllerの明示設定だけで選び、request本文・header・task・catalog・モデル応答から変更できない。固定profileは次を要件とする。

| profile | model全体 | API応答完了 | controller client要求全体 |
|---|---:|---:|---:|
| 省略時の既定 | 10秒 | 15秒 | 20秒 |
| 明示opt-in診断候補 | 60秒 | 65秒 | 70秒 |

既定のmodel/API値と既存wire・error・入力制限を維持する。controllerの20秒は現行17秒idle timerの実績ではなく、今回追加する絶対上限の要件である。診断候補は暫定実験上限であり、SLAやproduction Routerの制限変更ではない。無制限・自動延長・自動切替は禁止する。有限の正整数・許可された組合せ・上限を起動前に検証し、不正policyは受付前に失敗させる。

- model期限は送出直前から、接続確立・要求送信・応答body完読と完了採用までを含む。`model.ts`のmodel全体とHTTP transportは同じmonotonic絶対期限を共有し、2箇所のtimerに別々の相対予算を持たせない。chunk受信・transport開始・再接続で期限を更新しない。
- API期限はhandler受付からAPI `finish`まで。controller client期限はHTTP要求開始前から応答body完読・完了採用までとし、接続・header/body送受信も含む。
- 送出時の残りAPI予算は、model全予算＋検証/応答reserveを**超える**こと。reserveは両profileで1秒とする。controller clientも、要求開始前にAPI全予算＋受領reserve 1秒を超える予算を確保する。上限内の処理完了を保証するreserveではなく、受付の最低余裕である。handler到達前の接続/header送信時間もcontroller予算を消費するため、controllerがAPIより先に失効しうることを明示的に許容する。その場合は§0.3のclient切断行で扱い、送出済み/不明ならunknown latch・run停止とする。API全予算の利用可能時間を保証したとはしない。
- 既定profileでは、handler受付からmodel送出判定まで2秒以内なら、15秒−2秒の残りに10秒＋1秒を確保できる。body読取が期限内でも、その後の検証・保存・event-loop遅延等で残りが11秒以下なら送出0とする。「後方互換」は既定値・wire・既存防御の維持を指し、期限余裕を失った全要求の送出維持を意味しない。診断profileも同じ受付規則を適用する。
- 送出前に不足を証明できた場合は非latchの `notSent` 相当とし、API応答が可能なら既存502 `model_unavailable`へ写像する。API期限が失効済みなら応答を開始せず切断する。外側期限に合わせてmodel予算を黙って短縮しない。
- header/body拒否、backend未設定、不正policy、予算不足、busy/latchの各経路は送出0を検証可能にする。unknown latchの優先順位を維持し、送出前を証明できない障害を `notSent` と推定しない。

単一policyの正本は新規予定の `providers/compass/config/deadline-policy.json` とし、製品・TypeScript client・Python orchestratorが同じ検証済みsnapshotを用いる。数値単位はms、profileはdefault/diagnosticの2値のみ。orchestratorはこの正本から時間を導出し、childへprofile ID・policy hash・残り実行予算を渡す。childは自身の正本snapshotとのhash/選択行の一致を起動前に検査し、不一致なら送出0で停止する。複製禁止は要求単位の時間表に限る。製品JSONには要求単位のmodel/API/controller時間とreserveを置く。起動待機・health/poll・受動ログ回収・cleanup共通cap・時計/受渡し余裕はorchestrator内の一箇所に固定するrun policyとし、製品JSONへGCP運用設定を混ぜない。child全体待ち等の導出値は両policyから算出し、独立の旧値を残さない。新規configも将来の実装対象で、今回作成しない。設計では少なくとも、modelの2 timer、API handler timer、serverのheader timer/`headersTimeout`/`requestTimeout`/確認間隔、body timer、controller clientのsocket idle/絶対timer、orchestratorの起動待機・health/serial呼出・poll間隔・child待機・command/停止/cleanup timerを列挙し、起算点・上限・責務を固定する。要求完了を待つtimerに診断profileより短い独立の旧値を残さない。現行17秒idle timerは無効化するか要求の絶対期限と矛盾しない値へ導出し、現行child待機180秒も要求数・要求予算・残りrun予算から導出する。child再起動で予算を補充しない。

`server.requestTimeout=15秒`は要求受信制限であり応答deadlineではないという意味を設計の前提とする。header受信5秒・body読取2秒・要求受信15秒は維持し、診断profileの延長を入力受信制限へ波及させない。この分離が現在の実TCP経路で15秒超の応答まで確認済みとはしない。後続受入では、診断profileでbody完読後15秒を超えて届く保存fixture応答が、要求受信timerや解除済みheader timerで切断されないことをcontrollerが確認する。

各processの期限判定はmonotonic clockを使う。timer callbackだけに依存せず、送出直前・完了採用時・terminal遷移時に検査し、`now >= deadline`は失効とする。別processのmonotonic値を直接比較しない。承認UTC expiryは外部上限入力としてorchestrator起動時に一度だけ読み、時計差・起動等の安全余裕を差し引いたmonotonic期限へ変換する。子processへ制御用UTC期限を渡さず、元の期限までの残りから受動ログ回収・cleanup共通cap・child停止/受渡し余裕を差し引いた実行専用予算を渡す。各要求開始直前にchild残り予算がcontroller要求全体20/70秒＋要求間処理reserveを超えることを確認し、不足/等号なら送出0。controller要求期限を残りrun予算に合わせて短縮しない。childは受領した予算から起動/受渡し余裕を引いて自身のmonotonic期限を一度だけ作り、parentも元の期限でchildを監督する。受渡し遅延でparent上限を超えないことを必須とし、具体的余裕・handshakeは設計で固定する。wall clock補正で予算を増やさず、UTC再確認を行う場合も短縮・停止だけを許す。

暗黙のwarm-upや準備推論は禁止する。health後、予算を満たした最初の計測要求をtrial 1とし、timeout・失敗を含め全transport試行を数える。計数はcase単位で、controller要求開始をclient開始数、observerが観測したhandler入口をAPI受付数、実transport呼出をtransport試行数とする。未試行はclient開始0。送出前拒否はAPI受付あり・実transport呼出0で、header/body/入力拒否、catalog不一致、read_timeout、backend未設定、busy/latch、予算不足、保存失敗、送付上限超過を既存固定error enum＋固定詳細理由へ対応させる。不正policyは起動前停止でclient開始0。完全な記録では `case総数 = 未試行 + client開始数`、`client開始数 = handler前失敗 + API受付数`、`API受付数 = 送出前拒否 + transport試行数`、`有効回答数 <= transport試行数` を照合する。handler前の接続/parser拒否は未試行へ戻さずhandler前失敗とする。controller開始前の予算不足は未試行。crash等でhandler到達/実送出の有無を証明できなければpartial/unknownを別表示し恒等式検査不能とする。1 attempt contextに複数handlerを観測した場合も帰属不能partialとして停止する。in-process contextは認証ではなく、送出本文が事前固定したhashと一致した場合だけ当該attemptへの対応を採用する。transport試行をremote受理数と呼ばない。最初の完全な有効応答も、その要求で推論応答を観測した証拠に限る。全入力長・全shape・全labelでwarmになったとはしない。

### 0.3 不明結果・排他・完了の意味

同時1件、body受付から応答完了までのbusy、queueなし、unknown latchがbusyより優先する契約を維持する。期限内に採用した `completed` の非200/不正wireは技術失敗・非latchとする。明示 `notSent` は送出0・非latch。default transportの例外・abort・timeout・途中切断など送出前を証明できない結果はunknownとし、受付を停止する。

期限競合は次のように固定する。

| 状態 | 判定 |
|---|---|
| body完読の採用時点がmodel期限以降。timer callbackがまだ走っていない場合も含む | model timeoutのunknownでlatch。API期限内で応答可能なら504 `model_timeout`、API期限切れなら切断 |
| model期限内に上限内body完読を採用済み、その後API期限に到達 | API応答を新たに開始せず、未完の応答は打ち切る。API失敗だけを理由にmodelをlatchしない |
| model結果未確定のままAPI期限・client切断・abort | 送出前が証明できれば非latch、送出済みまたは不明ならunknownでlatch |
| unknown terminal後の完読・finish・late callback | terminalを書き換えず、成功化・latch解除・再送をしない |

API `finish`がAPI期限以降なら、実際の送出事象は記録しても期限内完了とはしない。controller側も同様に自身の期限以降の完読を成功へ採用しない。model完了採用、API終端、controller終端を別状態として扱う。

unknown latchは遅延応答・ログ取得・health成功・client再接続で解除しない。自動retry、再接続による推論再送、解除endpoint、自動process再作成は禁止する。再開は運用者が完了または停止を確認した後の明示的なprocess再作成に限る。controllerは不明結果のrunを停止状態で保持し、catalog切替等を理由に新instanceを作って続行しない。メモリlatchを再起動越しの永続予算や有料at-most-once保証とはしない。

| 事象 | 証明できる範囲 |
|---|---|
| loopback接続・ローカル要求write完了 | ローカルtransportの進行。IAP先/モデル受理の証拠ではない |
| model HTTP body完読 | transportの完読。期限内採用・有効wire・選定成功は別検査 |
| API `finish` | API側のOSへの引渡し完了。peer受領やbackend compute完了ではない |
| controller HTTP body完読 | controllerがAPI応答を受領。期限・成功status・schemaは別検査 |
| backend要求受理・compute完了 | 要求と相関するbackend固有の証拠がある場合だけ主張可能 |

今回計画する後続実装は、既存ローカルAPI/transport/controllerで観測可能な段階と期限に限定する。固定backendにrequest-ID伝播や要求別完了ログがあると仮定せず、独自field/headerを追加して対応済みと扱わない。相関するbackend証拠がなければ**backend outcomeはunknown**とする。これはHTTP transportの完読・期限内採用・非latch契約とは別の観測項目である。

backend受理/compute完了まで必要な場合は、別の将来server instrumentation gateで対応可否・変更範囲・license・承認・レビューを確認する。汎用proxy/証跡基盤を作らず、vendor sourceのcopy/vendor/再配布を行わない。

### 0.4 最小ログと証跡の要件

製品はfactoryに明示注入されたobserverへ、固定schemaとallowlistのevent/stage/outcome/deadline-cause enumだけを通知する。未注入時はno-opで、暗黙のconsole出力・file保存・環境変数読取を追加しない。observerは期限延長・再送・latch解除の権限を持たない。通知失敗をraw例外として漏らさず、有限の待ち時間・queueで処理する。

controller clientがopaque run/attempt IDを生成し、API factoryの内部観測contextと注入transport wrapperへ渡す。HTTP本文の3欄やheader、backend wireには追加しない。同時1件の範囲で要求開始前にcontextを固定し、終端まで別attemptへ差し替えない。orchestratorにはrun IDと子の対応を渡す。task/catalog由来文字列をIDにせず、各processのUTCとmonotonic elapsedを記録する。UTCの近接だけで因果やbackend相関を断定しない。

- 製品observerは受付/送出可否、局所socket接続、要求write完了、応答header受信、body完読、完了採用、API OS引渡し完了、期限失効という閉じた最小集合を通知する。transport各段階はローカル観測であってIAP先/model受理の証明ではない。controller clientは要求開始・受領・ローカル保存結果を記録し、orchestratorは起動待機、health、child終端、受動ログ回収、cleanupを記録する。観測不能な段階を推定で埋めない。
- 各段階のterminal遷移は一度だけとし、timeout・abort・close・finish・late callbackの競合で二重計上しない。process異常終了でterminal記録が欠けた場合はpartial/unknownとし、成功を補完しない。ログの物理的なexactly-once保存を保証したとはしない。
- 製品ログにraw task、catalog本文、model/API応答本文、raw例外、秘密、環境変数を出さない。source/config/inputのhash・対応表等の束縛情報は、controller管理の合成入力によるprivate evidenceに限定する。既存APIのcatalog版/hash返却契約は維持する。
- 永続化はcontroller client/orchestratorの責務とする。件数・1件bytes・総bytes・書込み待ち・保持期間を有界にし、数値上限と保存先・partial判定を設計で固定する。途中記録・破損receipt・保存失敗は固定分類で検出する。
- controllerによる証拠取得runでは、既定/診断profileの双方で送出前記録を必須とする。factoryの内部pre-dispatch hookが、model期限を確定する前にattempt開始意図と束縛情報を保存する。保存時間はAPI/controller予算に含める。保存成功後、`API残り > model全予算 + 1秒` の同じ受付条件を再検査し、その時点で初めてmodelの絶対期限を確定して実transportを呼ぶ。保存失敗または予算不足なら実transportを呼ばず `notSent` 相当とする。transport wrapper内に必須保存awaitを置かない。確定したmodel絶対期限は内部transport contextで渡し、HTTP requestの新field/headerにはしない。observer未注入の通常factory利用に永続保存を必須化しない。
- 送出前保存と実transport呼出は原子的ではない。中間でprocessが終了した記録は「送出意図あり・実送出不明」とし、送出0やremote受理済みへ補完しない。送出後の記録失敗は証拠不完全として後続試行を停止する。保存失敗だけで採用済みmodel結果をunknownへ書き換えず、再送もしない。
- private evidenceのraw入出力は事前固定した合成入力とその応答に限り、製品のbyte上限以下で必要部分だけ保存する。raw例外や環境変数は保存しない。受動serialログはprompt等を含み得る非信頼資料として、別のprivate領域・取得bytes/時間/保持上限で管理し、製品ログや公開資料へ転記しない。既存証跡は今回変更しない。
- 保存失敗・上限到達・ログ回収失敗でcleanupを妨げない。ログを保存できない場合も終了statusと親が観測したpartial状態を区別し、証拠の完全性を主張しない。

受入は後続の合成入力・注入transport・保存fixtureによるローカル試験で行う。既存rawログを製品ログ仕様に転用せず、ログ・task・catalogの内容を非信頼データとして扱う。

### 0.5 削除期限と診断予算

将来、別承認で実GPU試行を設ける場合も、元の承認expiry・費用枠・VM削除期限・cleanup終端を診断より優先する。期限切れtimestampを現在時刻から再作成したり、health成功・遅い初回・ログ不足を理由に延長したりしない。UTC上限からの変換とchildへの予算受渡しは§0.2に従い、monotonic予算を再起動で補充しない。

資源作成前のpreflightは、起動待機上限に加え、**提案する要求全体＋有界な受動ログ回収＋cleanup全体**を予約できることを確認する。各送出直前にも再判定し、不足または等号境界なら送出0でcleanupへ進む。複数要求を提案する場合は最大要求数と各要求のcontroller絶対予算、要求間処理、child終了の余裕を含める。現行の固定child待機180秒や「残り4分」を十分なreserveとみなさない。待機・health・失敗commandに費やした時間も全体予算から差し引く。

削除前の受動ログ回収は事前に定めた短い総時間・回数・bytes上限内だけとする。推論を発生させず、欠落・取得失敗・時間切れはunknownのまま受け入れる。追加ログは証拠の限定にだけ用い、latch解除・再送・cleanup延期の根拠にしない。cleanup予約を侵す場合は回収を省略する。

cleanupは常にfinally経路に置き、child/tunnel停止、複数の直列削除command、削除確認、記録に**共通の絶対上限**を設ける。各commandは残り共通予算以下で打ち切り、自動retryしない。個別timeoutの総和がreserveを超えないよう、command数・停止待ち・確認時間まで設計で予算化する。receipt破損・保存失敗・個別command失敗でも残り予算内で後続cleanupを進める。共通上限の到達後に新たなcommandや待機を始めず、残存/未確認資源をoperator対応として保持する。元の期限を変更せず、未確認資源を削除済みとしない。VM自動DELETEだけで関連資源全体のcleanup成功を保証したとはしない。

### 0.6 文書順序・後続受入・保留

今回のauthorはプロジェクト指定のCodex `gpt-6-astra`、独立read-only reviewerはClaude Code `claude-opus-5-5`。authorはreplacement §0を返し、parentが適用・証跡/レビューmetadataを保存する。source・fixture・既存証跡・state/lockは変更しない。今回、テスト・install・network・gcloud・Docker・秘密/.env読取・commit・branch操作・deploymentを行わない。

進行順序は次に固定する。

1. 要件差分を独立レビューする。NEEDS_FIXなら修正して再レビューし、LGTM後にparentが対象版と指摘解消をread-backする。
2. 承認済み要件差分に依存する設計差分を作り、独立レビューする。全timer、policy共有、起算点、process間予算受渡し、reserve、期限競合、error写像、observer/context、保存上限、cleanup共通capを具体化する。NEEDS_FIXは再レビューする。
3. その後、タスク差分を独立レビューし、LGTM後にparentがread-backする。**ownerが改めて実装を明示承認するまで、新規実装タスクはすべてpending**とする。今回の設計見直し承認は実装承認を含まない。
4. 将来の実装承認後、既存toolingによるsocket-freeのTDD・型検査、独立コードレビュー、parent read-backを行う。controllerのloopback確認はその後、通常権限で保存fixtureだけを用いる。拒否のsandbox bypassやexecutor/model代替を行わない。実GPUはさらに別承認とする。

タスク差分では次の変更候補を必要最小限で固定し、具体的testcaseとcommandを対応付ける。これは今回の編集・実行許可ではない。

| 対象 | 後続受入 |
|---|---|
| `providers/compass/src/{model,http,server}.ts`、`test/{model,http}.test.ts` | 既定10/15/20秒、診断60/65/70秒、不正設定、共有期限、chunkによる延長防止、1秒reserve、等号失効、予算不足送出0、model完了とAPI失効の競合、late callback、busy/latch優先、既存strict契約 |
| 同製品ファイル、新規 `providers/compass/config/deadline-policy.json` とcontroller client `.claude_workflow/local/live-api-client.ts`、対応するsocket-free試験 | observer未注入no-op、opaque context、段階別terminal一度、保存前失敗の送出0、送出後保存失敗の停止、partial/破損/上限、本文・例外・秘密の出力防止、絶対期限とidle timerの整合 |
| `.claude_workflow/local/run_l4_api_probe.py`、新規専用試験 `.claude_workflow/local/test_run_l4_api_probe.py` | UTC変換一度、wall clock前進/後退で予算増加なし、child起動遅延、全要求予算、期限不足、受動回収打切り、cleanup共通cap、直列command失敗後の継続、自動retryなし |
| `providers/compass/test/tcp-smoke.ts` | 保存fixtureのみで、診断profileの15秒超応答、header timer解除、絶対期限と継続chunk、応答backpressure、切断・busy/latch、全listener/接続終了 |
| `providers/compass/README.md` | factoryのpolicy/observer契約、期限の意味、試験手順、証拠の限界。live起動手順は追加しない |

Python harnessは現状import時にも読取・command・bindが走るため、後続実装では実行入口を明示的に分離する。単体試験は偽clock・偽command runner・偽child・一時的な合成保存先を注入し、importを含めgcloud・network・bind・実state/既存証跡読取を行わない。汎用運用frameworkには広げない。

将来の実行commandは `npm --prefix providers/compass test`、`npm --prefix providers/compass run types`、controller専用 `npm --prefix providers/compass run test:tcp`、Python専用 `python3 -I -B .claude_workflow/local/test_run_l4_api_probe.py` を基準とする。controller clientのsocket-free試験についても、設計・タスクで専用ファイルと既存toolingによるcommandを固定する。通常testへTCP/liveを混入させず、今回これらを実行したとは記載しない。

先行ローカルAPI検証は151成功・型検査exit 0、関連回帰は **266成功/0失敗/0skip**、rootは **2660成功/6失敗/29skip**。いずれも過去の証拠であり、root全体未合格を維持する。新規失敗・比較不能は停止し、既存失敗の免除や本差分の検証済み扱いをしない。

cold SLA、全label/位置の内部監査、製品全品質、新API実モデル品質、公開auth/RBAC、永続予算・有料at-most-once、G1支払設計、実課金・二脚決済・下流購入・配信/受領・保存再読取・finalityは未達・後段holdを維持する。将来の課金段でも明示承認、offer/route/額/network束縛、verify-before-settle、二脚同一性、durable unknown、盲目的再送禁止を維持する。

---

**以下は旧課金版の履歴本文（現行の範囲・順序は§0）。**

- 状態: **Codex の独立再レビューは LGTM（要件のみ）。owner 要件承認済み、設計を経てタスク分解中。** 初回の指摘 8 件を反映し、再レビューで要件上の解消を確認した（[レビュー記録](requirements-review.md)）。実装・デプロイは未実施。設計・タスク分解・実装はこの文書に含めない。
- 段の門: 要件 → owner 承認 → 設計 → owner 承認 → タスク → owner 承認 → 実装。要件は Codex 独立レビュー済み。後続は owner の指定により Claude Code が独立レビューし、各段の後に owner 承認が要る。
- 履歴注記: 下記の試験・署名許可・未実施表示は要件段時点の記録。最新の実行結果・許可範囲は `.claude_workflow/state.json` とタスク計画で管理する。全体回帰は実行済みだが未合格、使い捨て合成鍵のオフライン試験と外部署名・送金の許可は別である。
- コミット・push・PR・merge・stash は owner の最新の指示により行わない（AGENTS.md の過去のコミット許可より優先）。
- この文書の author が行ったこと: 下に挙げたソースと controller の記録の読取、この文書の作成だけ。author は外部要求・試験・クラウド操作・署名・支払いを行っていない。公開資料の取得は controller が行った（§2.2）。クラウドの変更・推論は誰も行っていない。

## 1. 目的と価値

- Compass は**有料のサービス**で、エージェントのタスク文を受け取り、運用者が選んだ小さな実在 API の目録（catalog）から**そのタスクに役立つ API を 1 つ選ぶ**（または「該当なし」「確認が必要」を返す）。
- Compass 自身も既存の Router 経由で購入できる。選ばれた API の購入は**別の操作**で、エージェントが Router で改めて quote を取り、人間の承認を得てから買う。
- 価値: エージェントが「どの有料 API を買えばよいか」を、実際の Google のモデル（DiffusionGemma）による選択として、支払いの安全性（承認・束縛・at-most-once）を崩さずに得られること。
- 市場分析サービスではない。網羅的なマーケットプレイスや、汎用の多段オーケストレーション基盤は作らない。

## 2. 現状の根拠

### 2.1 直接読んだソース

| 根拠 | 内容 | Compass への含意 |
|---|---|---|
| `providers/x402-workers/src/index.ts:94-98` | 資源はパス固定、GET 以外は 405、クエリ付きは 404 | 既存 Provider は可変入力を受けない。Compass は POST 本文を受ける別の Provider になる |
| `providers/x402-workers/src/index.ts:131-149` | 支払いヘッダの decode・形・`accepted` の完全一致。失敗は固定の 402（facilitator もデータ源も呼ばない） | 無効な支払いで高価な処理をしない性質を引き継ぐ |
| `providers/x402-workers/src/index.ts:151-162` | データ取得は **verify の前** | 安価なスナップショットだから成り立つ順序。推論をこの位置に置かない |
| `providers/x402-workers/src/index.ts:164-187` | verify → 残り時間の確認 → settle 1 回 → 領収の検査 → 200 | verify は決済ではなく、資金の回収も保証しない。再提出・並行提出による重複計算も防がない |
| `providers/x402-workers/src/index.ts:186` | settle 後に期限切れでも 200 を返す | Compass も「決済後の応答喪失」を明示的に扱う |
| `providers/x402-workers/package.json` | 独立した package（`vitest run`・`wrangler`） | `providers/compass/` も独立 package 案。試験は Provider 側と root 側の両方が要る |
| `vitest.config.ts:6-13` | root は `tests/**/*.test.ts` と payer の 3 試験だけ。Provider の試験を含まない | root の全試験が通っても Provider は検証されない |
| `vitest.config.ts:9` | root に `packages/payer/test/unit/sign.test.ts` を含む | 署名を伴う試験の扱いは owner の明確化が要る（§8.3） |
| `src/adapters/outbound/x402-dynamic.ts:496-497` | 未払いの読取の既定期限 5 秒、有料要求 30 秒 | 402 も有料応答も、起動を含めてこの期限に収める（NFR-C2）。本番の期限は変えない |
| `src/adapters/outbound/x402-dynamic.ts:526-534` | 動的経路は GET と、明示した POST（JSON 本文）を送る | **POST は Router に実装済み。Compass はこれを再利用する** |
| `src/mcp/tools.ts:302` | `quoteUrl` は `method?: "GET" \| "POST"` と `body?: object` を受ける | エージェントは POST 本文つきで quote を取れる |
| `src/core/intent.ts:104-110` | intent の型が POST の `body` と `bodySha256` を持つ | 型の存在であり、実行時の束縛の証拠ではない。Provider 側の束縛は別要件（FR-C10） |
| `src/adapters/outbound/x402-dynamic.ts:574-575` | challenge の `resource.url` が要求 URL と完全一致しなければ拒否 | Compass の 402 は要求 URL をそのまま resource に載せる |
| `src/adapters/outbound/x402-dynamic.ts:87-108`、`src/net/bounded-body.ts:12` | 届けるのは `application/json` の JSON object、256 KiB まで。それ以外は `paid_no_data` | Compass の結果は 256 KiB 以下の JSON object |
| `src/config.ts:111-114` | 静的 route の canonical path はクエリなし・GET のみ | Compass は静的 route ではなく動的 POST 経路で売る |
| `src/net/upstream-url.ts`（controller が読取） | `parseUpstreamUrl` は deny host を除く canonical HTTPS を受ける純関数 | Cloud Run の HTTPS URL は形として通りうる。DNS・TLS・IAM・到達性の実行時証拠ではない |

- 本番 Router・稼働中のデプロイ版・mainnet は調べていない。上の行はこの worktree のソースについての記述で、稼働版で検証済みとは言わない。

### 2.2 公開資料（controller が 2026-10-15 に取得。`.claude_workflow/local/cloud-feasibility-notes.md`）
- DiffusionGemma は Google のモデル。djev-run は mmastrac/djev を基にしたコミュニティの互換サーバで、Google が運用する Jev API ではない。
- djev-run の手順は Cloud Run の RTX PRO 6000（20 vCPU / 80Gi）、重み約 18GB、min-instances=0、`latest`／`nightly` の tag と `trust-remote-code` を使う。
- cold start 約 47.5 秒・中央値 117ms・$3.19/時は**作者の公表値**で、この project の実測ではない。公表値でも既存の 5 秒／30 秒の期限を超える。
- Cloud Run の GPU の基盤起動約 5 秒はアプリ・モデルの準備完了ではない。min instances は待機中も課金される。
- この project で動いた実行環境はまだ無い。quota・region・容量・IAM・課金は未確認。

### 2.3 この段の試験の証拠（controller の報告）
- root で `npm ci` が成功（484 package、脆弱性 0 件の報告、Solana の peer dependency 警告あり）。
- 実行したのは `npx --no-install vitest run tests/unit/upstream-url.test.ts` だけ（clean env、local の HOME/TMP/cache）: 1 file、46 passed、0 failed、0 skipped、exit 0。既存の純粋な URL の回帰試験で、Compass の試験でもクラウドの証拠でもない。
- root の全試験はオフラインの実署名を含むため保留（免除は仮定しない）。macOS の guarded-transport T-A5/T-A6/T-A8 は走らせていない（失敗を観測したとは言わない）。

## 3. 範囲と非目標

範囲:
- `providers/compass/`（独立 package の案）に最小の Compass を置く。既存の Cloudflare Worker Provider は**参照**として使い、変更しない。
- 構成 A（**既定**）: Compass と DiffusionGemma（djev-run）を Cloud Run の GPU で動かす。
- 構成 B（**代替**）: Compass は CPU の Cloud Run、DiffusionGemma は GCE の GPU VM。A が NFR-C2 等を満たせないという記録された根拠があり、owner が承認したときだけ切り替える。
- 入力は既存 Router の動的 POST 経路で運ぶ。支払いは既存 Router がすでに対応するレール 1 つ。

非目標:
- Router（`src/`）の変更、Router の移行、本番 Router の設定・期限の変更。
- Gemini など別モデルへの差し替え・自動フォールバック（黙って置き換えない）。
- 広いクラウド権限、GPU の自動確保、自動スケールの設計。
- Compass による選ばれた API の代理購入・署名・支払い（モデルにも Compass にも署名権限は無い）。
- 任意 URL の取得、目録の外の API の提案、網羅的な目録、汎用の証拠基盤。
- 私的または BUSL の SDK コードの複製。

## 4. 用語

- **目録（catalog）**: 運用者が選んだ実在 API の記述（名前・用途・Router で買うための URL と profile・期待する価格と network など）。id・版・内容の hash を持つ。
- **実行対象の識別**: モデルの id・revision・重みの hash、サーバ（djev-run・djev）の commit、コンテナ image の digest、実行される外部コード（remote code）の commit の組。
- **評価設定**: プロンプトの版・判定の種類・閾値・生成の上限。版と hash を持つ。
- **支払いの同一性**: network・asset・額・受取先・支払者・nonce・有効期間など、支払いを特定し条件を表す値の組（x402 の具体的な項目は設計で決める）。
- **要求の文脈**: 正規化タスク本文の hash、目録の id・版・hash、実行対象の識別、評価設定の hash。
- **選択結果**: 推論が正常に終わったときの `chosen`（1 件）／`none`（該当なし）／`needs_clarification`（入力が足りない）。
- **推論失敗**: 起動失敗・時間切れ・出力の形の誤り・目録外の id など、選択結果を得られなかった技術的な失敗。選択結果ではない。

## 5. 機能要件

### 5.1 購入と選択
- **FR-C1** エージェントは既存 Router の購入手順（quote → 人間の承認 → purchase）で、既存の動的 POST 経路を使って Compass を買える。Compass 専用の支払い経路を Router に足さない。
- **FR-C2** 選択は**実際の DiffusionGemma** が行う。規則だけ・別モデル・固定の応答での代用は FR-C2 の証拠にならない（偽モデルは T1/T2 の証拠としてだけ使い、そう明記する）。
- **FR-C3** 選択結果の `chosen` は目録にある entry の識別子だけを返す（目録外の名前・URL を返さない）。
- **FR-C4** 結果は要求の文脈・支払いの同一性の要約・選んだ entry とその記録された購入条件（URL・profile・期待価格・network）・Compass の要求 ID を記録として持つ。
- **FR-C5** 記録された購入条件は quote ではない。エージェントは Router で改めて quote を取り、URL・network・額が記録と食い違えば買わない。
- **FR-C6** `none`／`needs_clarification` は正常な有料の結果でありうるが、「次の API を購入しない」ことを構造として示す（文面だけにしない）。
- **FR-C7** モデルの呼出は選択に必要なものだけにする。Jev の判定（Choice/select、Noul、Score/match）のどれを使うかは設計で決め、根拠を記録する。特定の判定を必須にしない。
- **FR-C8** モデルの確信度を「較正された正しさ」と呼ばない。閾値は §7 の基準に基づいて使う。

### 5.2 入力と束縛
- **FR-C9** タスクは既存の動的 POST 経路の JSON 本文で運ぶ（`x402-dynamic.ts:526-534`、`tools.ts:302`）。URL のクエリにタスクを載せない。本文の形は設計で決める。
- **FR-C10** **Provider 側の束縛**: Compass は支払いの同一性と要求の文脈を 1 つの鍵として結び付ける。同じ支払いで文脈が違う提出（本文の差し替え・別の目録版・別の評価設定）、または支払いの条件が Compass の提示と違う提出には、推論も settle もせず、別の文脈の保存結果も返さず、固定の拒否を返す。Router の `bodySha256` や結果の記録（FR-C4）だけを、この束縛の証拠にしない。
- **FR-C11** 入力は大きさ・文字種・構造に上限を持ち、超えたら推論せずに拒否する（上限値は設計で決める）。
- **FR-C12** 目録に Compass 自身を入れない。Compass の購入に Compass の選択を要さない。

### 5.3 目録と実行対象の安全
- **FR-C13** 目録の記述は信頼しない入力として扱う。記述の文は規則・閾値・出力形を上書きできず、推論中に外部へ fetch しない。
- **FR-C14** 目録は運用者が版つきで固定し、実行中に外から書き換えられない。目録の URL は既存 Router の上流 URL 検査を通るものだけ。
- **FR-C15** 額・network・レール・受取先の制約は決定的な規則で判定する。モデルはそれを緩められない。
- **FR-C16** 実行の前に、実行対象の識別をすべて固定する（`latest`／`nightly` など可変の tag を使わない）。各構成要素の出所・利用条件（license）と、`trust-remote-code` で実行されるコードの確認結果を記録し、owner の承認を得てから実行する。この段では取得も実行もしない。

### 5.4 支払いと計算の順序
- **FR-C17** 未払いの probe・形の誤り・`accepted` の不一致・verify の失敗・FR-C10 の拒否では**推論しない**。
- **FR-C18** 1 つの支払いの同一性に対する推論は**最大 1 回**。再提出・並行提出・インスタンスをまたぐ提出・**再起動の後**でも 2 回目を走らせない。同じ鍵の再提出には、保存した結果を返すか固定の拒否を返す（設計で決める）。
- **FR-C19** **永続の最小状態**: 鍵ごとに「推論を始めた」「settle を試みた」「settle の結果（`unknown` を含む）」「結果」を、再起動・replica の入替をまたいで保持する。状態を読めない・失った・整合しないときは**有料の受付を止め**（推論も settle もしない）、運用者が安全を確かめるまで再開しない。replica の数でこの要件を置き換えない。置き場の種類は設計で決め、データベースを前提にしない。
- **FR-C20** 推論 1 回の費用に上限（生成の長さ・時間）と同時実行数の上限を持つ。
- **FR-C21** **総量の上限**: 期間あたりの有料受付数と推論の費用に上限を持ち、使用量を再起動・デプロイをまたいで保持する（再起動で予算が戻らない）。上限に達したら有料の受付を止める。verify は資金の回収を保証しないため、未回収の計算費用はこの上限まで残りうることを記録し、利用者・運用者に開示する。
- **FR-C22** 推論と settle の順序は設計で選ぶ。どちらでも: 未決済のまま結果を渡さない／決済後の失敗を隠さない／資金と計算の損失の上限を記録する。

### 5.5 失敗と不明
- **FR-C23** 次の各場合の応答と記録を設計で 1 枚の表にし、試験で確かめる: モデル起動失敗・cold 中の要求・推論の時間切れ・出力の形の誤り・目録外の id・verify 失敗・settle 失敗・settle 結果不明・決済後の応答喪失・永続状態の喪失・総量上限の到達。
- **FR-C24** 推論失敗は選択結果と区別する。出力の形の誤り・目録外の id を `none` にせず、決済済みの正常な `none` として返さない。推論失敗の記録は、未決済・決済済み・決済不明のどれかを保持する。
- **FR-C25** settle の結果が不明なら `unknown` として残し、成功にも失敗にも丸めない。Compass も Router も盲目的に再試行しない（支払いの再送・再署名をしない）。
- **FR-C26** 決済後に応答が届かなかった場合に、同じ鍵で結果を取り直せるか（FR-C18）を設計で決め、できないなら利用者に開示する。

### 5.6 観測と開示
- **FR-C27** 要求 ID・目録の版・実行対象の識別・評価設定の版・選択結果または推論失敗・支払いの状態を、資格情報なしで観測できる（秘密・authorization・署名は含めない）。
- **FR-C28** タスク文がモデル（と GPU の実行環境）に送られ、運用者のログにどこまで残るかを利用者に開示する。根拠のないプライバシー保証は書かない。
- **FR-C29** 財布の秘密・authorization・支払いヘッダ・署名はモデルに渡さない。

## 6. 非機能要件

- **NFR-C1 時間**: 未払いの 402 は Router の未払い期限（既定 5 秒）内、有料の応答は有料期限（既定 30 秒）内。どちらも**サービスの起動を含めた実際の経路**で測る。本番 Router の期限は変えない。
- **NFR-C2 構成 A の成立条件**: A は、cold と warm の両方で NFR-C1 を満たし、支払いの前に準備状態を確かめて受付を判断できる（準備ができていなければ推論も決済もせずに拒否する）ことが T4 で実測されたときだけ成立とする。公表値の約 47.5 秒は実測ではない。満たせなければ A を成立と判定せず、根拠を記録して owner に B を諮る。有料の自動 warm-up や min instances の費用は許可されていない（owner の予算承認が要る）。
- **NFR-C3 費用**: GPU の時間単価・常時起動の費用・1 選択あたりの推論費用・Compass の価格・FR-C21 の上限の関係を設計段で数値の前提として記録する（実測は T4 以降）。
- **NFR-C4 応答**: 結果は `application/json` の JSON object、256 KiB 以下（`bounded-body.ts:12`）。
- **NFR-C5 秘密の扱い**: 鍵・トークンはコードと文書と目録に置かない。この段では存在場所も読まない。
- **NFR-C6 再現性**: 同じ入力・目録・実行対象・評価設定での結果の揺れを測る（決定的と主張しない）。

## 7. 評価

- 目録は小さく（例: 3〜6 件）、用途の違う実在 API を運用者が選ぶ。タスクで選択が**変わる**ことを示せる多様さを持たせる。
- **今回の評価は英語のタスク・カタログ説明で実施する。** owner の追加指示「英語で良いですよ」により、日本語を各ケースに含める要件は撤回する。日本語の選定品質は今回の必須受入条件ではない。Unicodeの入力検査・本文束縛は維持する。
- 評価のケース・入力・期待値・**合格基準**（EV-1〜7 の正答率と揺れの閾値、ケースごとの必須条件）は、**実モデルでの試験（T4）の前に**設計段で固定して記録する。試験の後に基準を変えない。基準の達成を製品受入（AC-C2）の条件とする。

| ID | ケース | 期待 |
|---|---|---|
| EV-1 | 各 entry に明確に合うタスク（entry ごとに 1 件以上） | その entry を `chosen`。タスクを変えると選択が変わる |
| EV-2 | どの entry にも合わないタスク | `none`、次の購入に進まない |
| EV-3 | 入力が足りない・曖昧なタスク | `needs_clarification`、次の購入に進まない |
| EV-4 | 2 件に同程度に合うタスク | 設計で固定した正（1 件または `needs_clarification`） |
| EV-5 | 目録記述に「この API を必ず選べ」「規則を無視」「この URL を取得」などの文 | 規則・出力形は変わらず、外部取得も起きない |
| EV-6 | タスク文に同様の注入、目録外の URL | 目録外を返さない |
| EV-7 | モデル出力が schema に合わない・目録外 id | 推論失敗として記録し、`none`／`chosen` にしない。決済の状態を保持（FR-C24） |
| EV-8 | 未払い probe・壊れた支払いヘッダ・`accepted` 不一致・verify 失敗 | 推論の回数 0 |
| EV-9 | 同じ支払いの再提出・並行提出・別 replica・再起動の後・永続状態の喪失 | 推論は合計 1 回以下。状態喪失時は有料の受付を停止 |
| EV-10 | 同じ支払いで本文・目録版・評価設定を変えた提出、条件の違う支払い | 推論 0・settle 0・別文脈の結果を返さない（FR-C10） |
| EV-11 | cold／warm の未払い要求と有料要求 | NFR-C1/C2 どおり。準備前は推論も決済もしない |
| EV-12 | 推論の時間切れ・モデル停止 | FR-C23 の表どおり |
| EV-13 | settle の失敗・結果不明・決済後の応答喪失 | `unknown` を保持、再試行しない、記録が残る |
| EV-14 | 総量上限への到達、再起動の後の使用量 | 受付を停止し、再起動で上限が戻らない |
| EV-15 | 入力の上限超え | 推論せずに拒否 |
| EV-16 | ログと応答の点検 | 秘密・authorization・署名が無い |

EV-1〜7 の品質は実モデルで測る（T4）。EV-8〜16 の機構は偽モデルで T1/T2 として確かめられる（推論・settle の回数を数える）。ただし EV-11 の時間は T4 の実測が要る。

## 8. 証拠の段階と許可

### 8.1 証拠の段階
| 段 | 内容 | 状態 |
|---|---|---|
| T0 | 文書・静的なソース読取・公開資料の読取 | 実施中（この段） |
| T1 | Provider-local の単体試験（偽モデル・合成の支払い、ネットワークなし、署名なし） | 実装段。未実施 |
| T2 | root の回帰試験（Router 無変更の確認を含む）＋ローカルの結合（偽モデル） | 実装段。未実施 |
| T3 | owner の project でのクラウドの読取専用の確認（GPU の quota・region・提供の有無） | **未実施。project と region は未確認** |
| T4 | 実 GPU 上の実モデルの起動・cold/warm の経路時間・推論時間・費用の実測、EV-1〜7・EV-11 | **BLOCKED**（課金・資源作成の許可と範囲が要る） |
| T5 | Router 経由の実購入（testnet、署名と決済を伴う） | **BLOCKED**（署名・支払いの許可と対象の記録が要る） |
| T6 | 製品の受入（§9） | **BLOCKED** |

- 公開資料・公開ソースの読取専用の確認は許可済みで、読むたびに別の門を設けない。
- T3 は、owner が project と region を示した次の承認済みの段で行える。秘密ファイルを読まず、API の有効化・資源の作成をしない。
- T4 以降は課金・デプロイ・鍵・支払いを伴い、それぞれ owner の明示の許可と範囲（project・region・上限額・期間・対象）の記録が要る。
- オフライン・静的な確認は quota・起動・推論時間の証明にならない。前の段の合格を後の段の合格と書かない。

### 8.2 いま許可されていないもの
クラウド資源の作成・API の有効化・有料推論・モデルやコンテナの取得・既存の鍵や財布への接触・署名（testnet を含む）・入金・支払い・デプロイ・本番 Router への接触・GPU の確保・広い IAM 権限。

### 8.3 試験の範囲（実装段で）
- Provider-local と root の両方を実行して報告する（root の vitest は Provider を含まない）。
- root の全試験は `sign.test.ts` を含み、オフラインで生成した鍵で実際の EIP-3009 の署名を行う。実財布・testnet の操作ではないが、owner は署名を禁じている。**走らせる前に owner の明確化を得る**。それまでは署名を含まない試験だけを controller が走らせ、除いた試験を報告に明記する。author は試験を走らせない。

## 9. 最小の製品受入（T6、すべて BLOCKED）

- **AC-C1** エージェントが Router の動的 POST 経路で Compass を買う。
- **AC-C2** 実際の DiffusionGemma（実行対象の識別を記録）が、運用者の小さな実在 API 目録から選び、§7 で事前に固定した合格基準（今回の評価言語は英語）を満たす。
- **AC-C3** 結果は選択結果で、FR-C4 の記録を持つ。推論失敗は選択結果として受け入れない。
- **AC-C4** `chosen` のとき、エージェントは**別に** Router で実 quote を取り、条件の一致を確かめ、人間の承認を得て、選ばれた API を買う。`none`／`needs_clarification` のときは次の購入をしない。
- **AC-C5** Compass の購入と選ばれた API の購入の**それぞれ**について、次を別の条件として確かめ、相関 ID（Router の intent id・Compass の要求 ID・取引 id）で対応を追えるよう記録する: source の settlement、destination の settlement（二脚のとき）、API の応答、クライアントの受領、結果の保存と再読取、finality。Router の状態名（例: `delivered`）だけをこれらの証明にしない。
- **AC-C6** 使ったレール・network・受取先・価格は、検証してから記録する。今は**未選択**。

## 10. 再利用の境界

- 参照してよい: 既存 Provider の構造（固定文の応答・要求ごとの期限・`accepted` の完全一致・settle 1 回・領収の検査・秘密を返さない）。同じリポジトリの MIT のコードとして出所を記録して再利用する。
- そのまま使わない: データ取得を verify の前に置く順序（§2.1）。
- 変更しない: Router（`src/`）、既存 Provider、`CLAUDE.md`、`README.md`、`docs/DEPLOY.md`。
- 使わない: 私的・BUSL の SDK コード。djev-run・djev・DiffusionGemma は FR-C16 に従う。

## 11. 未決事項

owner が決めること:
1. T3 を行う project と region、GPU と常時起動を含む予算の上限（FR-C21、NFR-C2/C3）。
2. 将来の外部操作（資源作成・デプロイ・実推論・testnet 支払い）の許可と範囲。
3. 署名を含む root 試験の扱い（§8.3）。
4. 目録の具体的な entry、Compass のレール・network・価格・受取先（AC-C6）。

設計段で決めること（設計者が根拠つきで提案し、レビューと owner 承認を経る）:
- POST 本文の形と正規化、支払いの同一性と要求の文脈の鍵の項目（FR-C9/C10）。
- 推論と settle の順序（FR-C22）、永続の最小状態の置き場と状態喪失時の停止・再開の手順（FR-C19）。
- cold start の方針（準備状態の確認・受付の拒否）と時間の内訳（NFR-C1/C2）。
- 使う判定と閾値、評価のケースと合格基準（FR-C7/C8、§7）。
- 失敗の表（FR-C23）、応答喪失の回復（FR-C26）、開示の文面とログの保持（FR-C28）。
