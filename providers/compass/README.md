# Compass 最小ローカル選定API

無課金・内部試作用の `POST /internal/v1/select`。入力は `schema: "compass.internal.select.v1"`、`task`、`catalogVersion: "directory-v1"` の3文字列だけです。成功は `chosen` / `needs_clarification` / `none`、技術失敗は非200です。制御可能なJSON応答は常に `purchaseEnabled=false` / `paid=false`。購入URL、条件、価格、署名、領収は返しません。

## Factory契約

`src/server.ts` の `createCompassServer({port, backendPort?, catalogPath?, transport?})` は `{server, listen}` を返します。import/factory呼出ではbindしません。`listen()` のhostは127.0.0.1固定で、port=0はcontroller harness用のOS割当です。Hostは実listen portを含む完全一致を要求します。環境変数・main・公開起動scriptはありません。

backendPort省略/不正は503 `not_ready`、送出0。backendPortは整数1〜65535のみです。default transportは `node:http`、`agent:false` で `127.0.0.1:<backendPort>/v1/systemone` に直接POSTし、proxy環境変数を読みません。任意URLやrequestからの接続先指定はありません。catalogは起動時に上限付きで読み、検証・copy/freeze・SHA-256算出後に固定します。不正catalogではfactoryが失敗します。

transport注入は `{source: "live" | "recorded-fixture", send(body, signal)}`。返り値は `completed{status,bytes}` / `notSent` / `unknown{timeout?}` のunionです。completedは上限内bodyを最後まで読んだ場合だけです。例外・abort・10秒の全体期限・途中切断・64KiB応答超過はunknownとしてinstanceを恒久的にnot_readyへlatchします。遅延完了でも解除しません。32KiB送付上限超過は送出前500、非latchです。自動retryはありません。

leaseはbody受付からresponse finishまで1件。競合はqueueなし503 busy、latchはbusyより優先します。serverはresponse切断からmodel abortを通知します。header上限8KiB/5秒、body上限8KiB/2秒、要求受付後の応答完了期限15秒。期限や上限で接続を閉じます。parser段のエラーbodyは空です。同一ホストのprocessに対する認証や公開RBACではありません。

## ローカル検査

依存取得なしでroot既存toolingを使います。controllerが秘密を継承しない隔離環境を用意したうえで、rootから以下を実行する契約です。

```sh
npm --prefix providers/compass test
npm --prefix providers/compass run types
```

通常testは `contracts/catalog/model/http.test.ts` の4ファイルのみ。transportとHTTP streamをsocket-freeで検査し、listenerはbindしません。型検査はTCP harnessも対象です。

独立コードレビューとcontroller確認後、controllerのみが同じ隔離環境で次を実行します。拒否が出たら停止し、権限変更・別executorへの迂回はしません。

```sh
npm --prefix providers/compass run test:tcp
```

TCP harnessは127.0.0.1だけにbindし、保存fixtureを注入します。正常8件・非200・stream超過・読取/モデル期限・busy・切断abort・unknown latchを確認し、finallyでlistener/接続を閉じます。実GPUは使いません。authorはこのharnessを実行していません。遅い送出の15秒打切りはsocket-freeの保留Writableで検証し、TCPでの送出backpressure検証は未実施です。

## 現在の検証状態

独立コードLGTM、親単体151件・型検査、controller実TCPまで完了。実HTTP transportとローカル保存応答サーバー間も確認した。新しい実モデル推論ではない。件数・原本・残る境界は [API検証証跡](notes/api-evidence.md) を参照。

## データ出所と検証境界

`catalog/selection.json` は `probe/catalog.json`（mpp.dev directory、2026-10-15取得）の3候補を、endpoint能力と必須入力だけに絞って転記したmetadataです。directory掲載は購入可能・Router登録・条件検証の証拠ではありません。選定処理に候補ID固有のifやtask lookupはありません。

`test/fixtures/recorded-responses.json` は `.claude_workflow/local/l4-run-20261015-010529/manifest.json` の8件の `results[].raw_response` を無加工stringで保存し、case_id・expected・元artifact相対path・元artifact SHA-256・応答SHA-256を保持します。元artifactは変更していません。test case IDが応答を選びます。応答表示は `modelSource=recorded-fixture` で、新promptとの意味照合や新しいモデル推論を行った証拠ではありません。raw diagnosticsはAPIに返しません。

実装はこの作業で新規作成し、旧PoC/SDK/第三者worker sourceのコピーはありません。metadataと保存実応答の出所は上記の作業artifact（git commit未登録）。rootのlicense表記はMITですが、directoryやモデルの権利確認を代替しません。`@zerc20/sdk`/BUSL sourceは含みません。モデル/workerの来歴・licenseゲートG2は未解消です。

独立Claude Opus 5.5による文書§0のLGTMを着手根拠としています。コード独立レビュー、controllerのTCP確認とroot回帰比較は別ゲートで、authorの単体試験では代替しません。新API入力/metadata指示の実モデル品質、cold SLA、全label内部監査、公開auth、永続予算・有料at-most-once、決済二脚、下流購入、配信/受領、保存再読取、finalityは未検証・未達です。既存root全体の6失敗も免除していません。
