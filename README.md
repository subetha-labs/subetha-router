# SubEtha Router

ETHGlobal Tokyo 提出実装。AI エージェント側の支払い手段と、API プロバイダ側が要求する
支払い手段をつなぐ Router を作る。

最初に通すのは **SubEtha 受信 → Router → x402 Provider A**。次に**同じ受信口から MPP Provider B**へ
（`routeId` の解決先を差し替えるだけで、core はレール名で分岐しない）。

- Provider A: Hyperliquid の ETH マーケットスナップショット、Base Sepolia の x402 exact。
- Provider B: Uniswap v3 プールの参照価格、Tempo の MPP charge。
- A/B はいずれも**自前でホストしているプロバイダ**であり、Hyperliquid や Uniswap がこれらの
  支払い方式に対応しているという主張ではない。
- 市場データは**メインネットの参照データ**を読むが、**支払いはテストネット限定**が目標。
- 2 つのレグは交換ではなく**独立した支払い**で、各レールを個別に事前資金供給（prefunded）する。
  **FX 変換もブリッジも行わない。**

**現状: 耐久コア + HTTP 公開契約 + 送信レール A（x402）/ B（MPP）の公式 SDK 配線 + 型付き
クライアントを、実 CLI・実 TCP で合成 fixture 相手に通した段階。**
`src/main.ts` を実プロセスとして起動し、**別プロセスのテストクライアント**から実 TCP で
R1→R2→R3→R4 を通している。送信レールはインストール済みの公式 SDK（A = `@x402/fetch` +
`@x402/evm` の `x402Client` / `ExactEvmScheme`、B = `mppx/client` の `Mppx.create` + `tempo.charge`）を
**実際に呼ぶ**が、相手は**リポジトリ内の別プロセス合成 fixture**（`tests/fixtures/*`・loopback のみ）で、
署名能力は**署名しない試験用 spy**を注入している。したがって**実決済ではない**
（証拠ラベル: A = `T2-fixture-nopay` / B = `T3-fixture-nopay` / クライアント = `T4-fixture-nopay`、
T1 の合成レールは `T1-synthetic-nopay`）。

実ウォレット・鍵・署名・ブロードキャスト、Provider A/B の**実 API 到達**、既存 chat の実 UI 連携、
finality はいずれも**未実施で別ゲート**。**クリーンインストールからの再現・手動起動・実決済・
Provider 実 API・chat 実接続・finality を検証したという主張はしない。** 本 README はその範囲だけを書く。

順序は **A（x402）→ B（MPP）**。市場データは**メインネットの参照データ**を読み、**支払いはテストネット
限定**が目標で、その実行には**別途の認可が必要**（本書の範囲では未解除）。2 レグは交換ではなく
**独立した支払い**で、各レールを個別に事前資金供給（prefunded）する。**ブリッジも FX 変換も行わない。**

## 検証済みの環境

- Node **22.23.1** / **macOS（darwin）** で実行・確認。`package.json` の `engines` は `>=22.12.0`。
- Linux では**実行していない**。
- `fs-ext`（OS の `flock(2)` 排他）はネイティブアドオンで、インストール時に `node-gyp configure build`
  が走る。ビルドには Xcode Command Line Tools と python3 が必要。

## セットアップ（実行した手順そのまま）

```sh
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm rebuild fs-ext --foreground-scripts --no-audit --no-fund
```

- 直接依存は `package.json` で**完全一致版に固定**し、`package-lock.json` を伴う。
- `--legacy-peer-deps` は npm の peer 解決を回避するためだけの指定で、権限の緩和ではない。
- `--ignore-scripts` でインストール時スクリプトを止めているため、`fs-ext` のネイティブビルドは
  上記 `npm rebuild` で明示的に実行する。

## コマンド

```sh
npm run test    # vitest run（tests/unit + tests/wire）
npm run types   # tsc --noEmit
npm run build   # tsc
```

wire（実 CLI・実 TCP）だけを走らせる場合:

```sh
npm run test -- tests/wire/router-cli.test.ts      # R1→R2→R3→R4 と 3 終端・再起動（合成レール）
npm run test -- tests/wire/http-contract.test.ts   # 公開契約の拒否面と canonical 束縛
npm run test -- tests/wire/concurrency.test.ts     # 並行 R3（同一 quote / 別 quote）
npm run test -- tests/wire/crash-recovery.test.ts  # 応答バイト送出前のクラッシュと再起動
npm run test -- tests/wire/subetha-inbound.test.ts # 受信レール adapter の実 HTTP 契約
npm run test -- tests/wire/x402-outbound.test.ts   # 送信レール A: 公式 x402 SDK の v2 wire
npm run test -- tests/wire/x402-cli.test.ts        # A を実 composition 越しに縦貫
npm run test -- tests/wire/mpp-outbound.test.ts    # 送信レール B: 公式 mppx client の wire
npm run test -- tests/wire/mpp-cli.test.ts         # B を実 composition 越しに縦貫
npm run test -- tests/wire/client.test.ts          # 型付きクライアント（承認束縛・再オープン）
npm run test -- tests/wire/chat-crossimpl.test.ts  # 既存 chat 実装 × 実 Router の相互実装（無課金）
npm run test -- tests/wire/mcp-server.test.ts      # MCP ラッパ（tool 公開・承認束縛・証拠）
```

- **wire テストの harness（`tests/fixtures/router-harness.ts`）が `src/main.ts` を子プロセスとして
  自動起動する**（`node --import tsx src/main.ts` を直接起動し、子は実アプリ 1 プロセスだけ）。
  手動で起動する手順は用意しておらず、**手動起動は検証していない**。
- harness は合成 facilitator fixture と合成上流 fixture もそれぞれ**別プロセス**で起動し、構成
  ファイルと使い捨て journal を `runtime/` 配下の一時ディレクトリに書く。ポートはすべて
  `127.0.0.1` のエフェメラル（`--port 0`）。
- テストは実ファイルシステムを使い、使い捨てディレクトリを `runtime/` 配下にのみ作って自分の
  作ったパスだけ削除する。`runtime/` は git 管理外。起動した子プロセスだけを終了させ、close を待つ。
- 二重 writer の拒否は実際に別プロセスを起動して確認している。単体テストの購入ライフサイクルは
  同一プロセス内の合成レールに対して行う。
- すべて **無課金・無署名・鍵なし・loopback のみ**（外部ネットワークへ出ない）。

## 現時点の journal の性質

- NDJSON を append し、**fsync が返ってから**メモリ表を更新する（write-ahead）。
- 書き込み前に serialize → 検証 → 凍結を済ませ、成立しない要求は 1 バイトも書かずに拒否する。
- 新規作成時は親ディレクトリも fsync してから open の成功を返す。失敗時は成功扱いにせず、
  取得済みロックを解放する。
- 常設 `journal.lock` に対する OS 非ブロッキング排他ロックをプロセス生存中保持し、ロックファイルは
  削除しない。
- replay は JSON 妥当性・レコード形・`seq` 連番・末尾の欠けを検査し、違反は**バイトオフセット付きで
  起動を中止**する（自動切り詰め・自動補完なし）。
- 追記は単一 mutex で直列化する。close 後、および書き込み/fsync 失敗後は writer を継続させない。

## 現時点の購入ライフサイクル（合成レールのみ）

`quote → 承認 → strict preflight → 上流 offer の再照合 → 予算予約 → verify → 受信 settle →
送信の write-ahead → pay → 結果の durable 保存` を 1 本、実 journal の上で通している。
core は rail 名で分岐せず、この経路を**実 CLI・実 TCP 越しでも**（相手は合成 fixture）通している。

- 承認は `quoteId` に束縛し、承認期限は quote 時に確定した**絶対時刻**（TTL と発行 offer の失効の
  早い方）を journal に載せて再起動後も同じ値で判定する。
- `(principal, requestId)` → `quoteId` は不変。所有 principal 以外は開始も参照もできない。
- 予算は `(network, asset)` バケットごとに通算し、同一バケットに落ちる受信・送信は合算する。
  件数上限・1 件上限・金額の形式検査を通したうえで、単一 mutex で「検査 → 予約行の append+fsync」を
  不可分に行い、成功しない限り受信 settle を始めない。`unknown` は枠を保持したままにする。
- 受信 settle の直前と送金の直前の 2 回、上流の提示を読み直して承認済み offer と照合する。
  照合には**検証済み offer のトップレベルフィールドを丸ごと**使うので、金額以外
  （`maxTimeoutSeconds` など）が変わっても検知する。settle 前の不一致は**どちらのレグも
  開始せず**（課金なし）、settle 後の不一致は支払わずに `paid_data_unavailable`
  （`destination.outcome="not_sent"`・レシートなし）で終端する。
- 例外・タイムアウト・解釈できない応答は `unknown` として durable に確定し、**自動再送・自動再
  settle・自動返金はしない**。中断された途中状態は再起動時に `unknown` として journal に追記する。
- 公開する理由コードは固定の安全な集合に限り、上流 URL・トークン・例外文字列を出さない。

## 現時点の HTTP 公開契約（合成レール相手に実 TCP で確認）

| # | メソッド/パス | 役割 |
|---|---|---|
| R1 | `GET /v1/routes` | allowlist の `routeId`・canonical URL・資産メタのみ（上流 URL は返さない） |
| R2 | `POST /v1/quotes` | `{routeId, requestId}` → 上流 quote を先に取り、受信 offer を発行して `quoteId` を確定 |
| R3 | `GET /v1/routes/{routeId}/resource` | 購入実行。成功時は**上流 JSON をそのまま** body で返す |
| R4 | `GET /v1/purchases/{paymentId}` | 所有 principal のみが読む固定の公開射影 |

- 認証は `X-Router-Principal` と `Authorization: Bearer <token>` の 2 本。R3 はさらに
  `X-Router-Quote-Id` / `X-Router-Request-Id` / `X-Router-Approval` と、受信レールの支払い資格情報
  （`X-Payment`、base64 JSON）を要求する。1 つでも欠落・不一致なら購入を開始しない。
- 資格情報なしの R3 は、既存 quote の 402 offer を再提示するか「R2 で quote を取れ」という指示を
  返すだけで、**journal に 1 行も書かない**。
- canonical URL は設定値から組み立て、リクエストの `Host` からは導かない。**クエリ付きは 400**、
  `GET` 以外は 405、allowlist 外の `routeId` は 404。購入口は**生のリクエストパスが設定の
  `canonicalPath` と完全一致**したときだけで、`/./`・`//`・末尾 `/` のような別名では実行しない。
- R4 の射影は固定フィールドのみ（`paymentId / routeId / status / source / destination /
  quoteFingerprint / terminalReason / updatedAt`、`delivered` のとき `result`）。秘密・上流 URL・
  生 journal は出さず、全件ダンプの admin 口も無い。他 principal からは 404。
- 終端は `delivered` / `paid_data_unavailable` / `unknown` の 3 つで、再起動後も R4 が同じ status と
  同じ結果を返す。同一要求を再送しても両レグとも再送しない。
- **並行要求（T-10）**: 同一 `quoteId` への並行 R3 を実 TCP で 2 本投げても、受信 settle と送信 pay は
  それぞれ 1 回だけで、両方の応答が同じ body・同じ `paymentId` を返す（`attempt` は 1）。別 `quoteId`
  なら共有予算の下で独立した 2 購入として両方成立する。
- **応答送出前のクラッシュ（T-11）**: 結果を fsync した**直後・応答バイトを 1 バイトも出す前**に
  Router プロセスを SIGKILL しても、同じ journal で再起動した R4 が同一 status・同一結果・両レグの
  証跡（`source.txRef` / `destination.txRef` / `receiptRef`）を返す。クライアントが同一要求を
  出し直しても**どちらのレグも再送しない**。この停止点は `synthetic` セクションにのみ書ける
  試験用シーム（`crashBarrierPath`）で作り、**既定（real）構成では読まれない**。

## 起動構成（env）

`src/main.ts` が実 CLI エントリポイント。秘密は env からのみ受け取り、allowlist と上限は非秘密の
JSON 構成ファイルに置く。

| キー | 既定 | 内容 |
|---|---|---|
| `ROUTER_CONFIG_PATH` | （必須） | `{"router":{approvalTtlMs,routes,budget}, "x402":{upstreams}, "synthetic":{facilitatorUrl,upstreams,crashBarrierPath?}}` の JSON。`real` では `x402.upstreams`（`routeId` → 上流 canonical URL）が必須 |
| `ROUTER_PRINCIPAL_TOKENS` | （必須） | `<principalId>:<token>` のカンマ区切り。応答・ログ・journal に出さない |
| `ROUTER_ADAPTER_MODE` | `real` | `real` または `synthetic`。**合成レールは明示指定のときだけ** |
| `ROUTER_SUBETHA_FACILITATOR_URL` | （`real` で必須） | 受信レール facilitator の base URL（設定 1 本だけ） |
| `ROUTER_JOURNAL_PATH` | `runtime/journal.ndjson` | NDJSON journal（`journal.lock` は同階層） |
| `ROUTER_HTTP_HOST` / `ROUTER_HTTP_PORT` | `127.0.0.1` / `8500` | 待ち受け。`0` でエフェメラル |
| `ROUTER_CANONICAL_BASE_URL` | `http://127.0.0.1:8500` | canonical URL の基点（`Host` から導かない） |

- **既定（`ROUTER_ADAPTER_MODE=real`）では実 adapter（公式 SDK 配線）を組むが、支払い能力が
  注入されていなければ `signer_not_authorized` で起動を中止する。合成レールへフォールバックせず、
  偽の署名者も作らない。** 送信レールの署名・支払い能力は**起動時にコードから注入**するものだけを
  使い、構成ファイルや env からは読み込まない（任意のプラグイン読み込みをしない）。
  `routeId` ごとの `rail`（`x402` / `mpp`）で送信レールを解決し、そのレールの能力が無ければ起動しない。
  **実鍵・実 RPC を伴う能力の用意は本書の範囲外で、使えるウォレット設定手順は提供していない。**
- 実行可能な形で確認しているのは、**tests 内の署名しない spy 能力**を注入した縦貫
  （`tests/wire/x402-cli.test.ts` / `tests/wire/mpp-cli.test.ts`）だけで、起動ログの `label` が
  `T2-fixture-nopay` / `T3-fixture-nopay` になる。`real` 表示は実能力注入時のみ。
- `synthetic` を明示したときだけ、リポジトリ内の既知の fixture 構成を組み立てる（任意のプラグイン
  読み込みはしない）。接続先は **loopback のみ**に制限し、リダイレクトも追わない。
- `routeId` はパス安全な形に限り、`canonicalPath` は実際に提供する
  `/v1/routes/{routeId}/resource` と一致しなければ**起動時に `config_invalid` で拒否**する。
- `synthetic.crashBarrierPath` は T-11 のための**合成専用の試験用シーム**（応答バイト送出前で停止し
  到達を書き出す）。`synthetic` セクションにしか書けないため、既定の `real` 構成では解析対象にすら
  ならない。運用機能ではない。

## 既存 chat 向けの型付きクライアント（T4）

`src/client/{index,types}.ts` は R1–R4 の**薄い型付きラッパ**で、`examples/chat-market-data-profile.ts`
が「quote → **人間の明示承認** → 実行 → status / 再オープン」の呼び出し可能な例を示す。**UI は作らない。**

- 承認は `quoteId` に束縛した明示値だけ。未承認・拒否・別 quote への承認・承認した canonical path 以外では
  **Router へ要求を出さない**（合成 fixture で「両レグとも動いていない」ことを確認している）。
- **credential は作らない・署名しない。** 承認後に呼び出し側が渡す既存の `X-Payment` 値だけを使う。
- 要求は設定した `baseUrl` の origin に固定し、リダイレクトを追わない。quote が返す canonical URL の
  origin が違っても、そこへ principal トークンや資格情報を送らない。
- 自動再試行・自動再 quote・`requestId` の作り直しをしない。`unknown` と `paid_data_unavailable` は
  別の結果として保ち、**どちらでも `paymentId` を返す**ので `status()` で突き合わせられる。
- Router の snapshot エンベロープはそのまま渡す。**article 型へ cast せず、擬似 article も作らない。**
- 取得した canonical URL の**改変（origin / query / hash / path）や条件の書き換えは受理しない**。
  実行できるのは**その client インスタンス自身が発行した quote だけ**で、client を作り直したあとは
  `status()` による参照のみ（自動 re-quote も再実行もしない）。同一 client での同一承認の再実行は
  安全（Router 側で両レグとも 1 回だけ）。
- R3 の成功は **`X-Router-Payment-Id` ヘッダが承認済み `paymentId` と完全一致**し、JSON body を
  取得できたときだけ。`paid_data_unavailable` / `unknown` の明示結果は**本文の `paymentId` 一致**を
  条件にし、上流 snapshot 内の同名フィールドを Router のメタとして読まない。欠落・不一致・矛盾は
  **承認済み `paymentId` のまま `unknown`** にして再送しない。R4 は問い合わせた `paymentId` と
  一致する射影だけを受理する。
- **証拠の区別**: 上記はクライアント自身の wire テスト（`tests/wire/client.test.ts`、合成 fixture
  相手・`T4-fixture-nopay`）で確認した範囲。`examples/chat-market-data-profile.ts` は同テストから
  import して**例自身の経路**（拒否 / 承認不一致 / callback 改変の無効化 / 正常実行 / `unknown` 保持 /
  再起動後の reopen）を確認している。

## 既存 chat の実行レイヤとの相互実装テスト（T5）

`tests/wire/chat-crossimpl.test.ts`（ラベル `T5-crossimpl-nopay`）は、**既存 chat 側の実実装**
（別 worktree の `apps/chat-demo/router-execution.mts` の `createRouterChatExecution`）と
**実 Router プロセス**（`src/main.ts`）を、どちらも実プロセスにして実 TCP で突き合わせる。
chat 側のファイルは**読み取り専用で import するだけで、一切変更しない**。

それまで両者は「同じ契約のつもり」の独立実装で、chat 側のテストは自前のスタブ Router に対して、
こちらのテストは自前クライアントに対して緑だった。**噛み合うことは確かめられていなかった。**

確認できたこと（合成 fixture・無課金）:

- Router の実 R2 応答が chat 側 `decodeQuote` の厳格検証（余剰フィールドを許さない exact key set）を
  **無改変で**通る。Provider A 形・B 形の snapshot も chat 側 `market-data.mjs` の検証を通る。
- 承認 → 実行 → **別プロセスでの再オープン**で、chat 側 journal と Router の R4 射影が
  同一 `paymentId` の同一結果で整合する。
- 未承認 / 別 quote への承認 / canonical origin 相違 / 承認期限切れ では**支払いが始まらない**。
  承認成功後の 2 回目の承認でも R3 は再送されない（at-most-once）。
- 他 principal からは参照できない（Router が 404 で存在も明かさない）。
- 応答バイト送出前に Router が落ちても `unknown` が残り、再オープンしても**自動再送しない**。

否定系の判定は chat 側の journal だけに頼らず、**Router 到達回数を数える loopback プロキシ**
（`tests/fixtures/router-calls-proxy.ts`）と上流・facilitator の `/calls` を独立に突き合わせている。
Router の HTTP 層にはアクセスログが無く、上流の課金回数だけでは「Router が受けて 4xx で弾いた」
場合と区別できないため。

**この結合をもって達成しないもの**: 実 chat UI（ブラウザ）上の因果（B-03 / U-07 の残り）、
実決済・実鍵・実署名、Provider A/B の実 API 到達、finality。
**AC-7 も未達**（支払いレグを実行していないため）。`ChatExecutionFactory` への drop-in 互換性は、
`createRouterChatExecution` を実 Router に対して駆動できたという範囲にとどまり、
chat の UI・HTTP 層（`server.mts` / `ui.js`）は対象外。

## 送信レグ A / B の実決済（T7・達成済み）

**両レールとも実テストネット決済が成立している。**

| レール | Provider | 実 tx | 額 |
|---|---|---|---|
| A（x402 / Base Sepolia） | `provider-a.subethalabs.com` | `0x68b9469f...f371`（block 47301621） | 10000 USDC base units |
| B（MPP / Tempo Moderato） | `provider-b.subethalabs.com` | `0x84157b93...ea69`（block 36898398） | 10000 pathUSD base units + 69 手数料 |

どちらも実 `src/main.ts` を **`mode: real` / `label: real`** で起動し R1→R2→R3→R4 を縦貫、
R4 が `delivered` / `outcome: paid` を返し、オンチェーンで独立に検証済み。

**レール A と B は送金の主体が違う**（実測）:
- **A** は Router が**署名するだけ**で、broadcast と gas は facilitator 負担。
  → payer の native 残高が 0 でも成立する。
- **B** は **payer 自身が broadcast** し、**手数料も pathUSD 建て**。
  → payer に pathUSD が必要で、**送金が有料 GET より前に起きる**ため
  「送金済み・データ未取得」が原理的に起こりうる（その場合も再送せず `unknown` を保持する）。

### Provider A の詳細

| 項目 | 値 |
|---|---|
| ネットワーク | Base Sepolia `eip155:84532` |
| 資産 / 額 | USDC `0x036CbD53...CF7e` / **10000 base units（$0.01）** |
| 実 tx | `0x68b9469f7081053b632d221863070de517b85ca821cff3a18a31e805a79ef371`（status `0x1` / block 47301621） |
| 経路 | 実 `src/main.ts` を **`mode: real` / `label: real`** で起動し R1→R2→R3→R4 を縦貫 |
| 取得データ | Hyperliquid ETH perpetual の実 snapshot |

- **AC-5（送信レグ実決済）に到達。** ただし**受信レグは合成 facilitator のまま**なので **AC-4 は未達**。
- 署名能力は**製品コードに置かない**。`tools/` 配下の起動ツールが env から鍵を受け取り、
  **コードから注入**する（`src/**` は env・構成ファイルから鍵を読まない）。
- 誤った宛先・額への署名は **guarded signer**（`src/adapters/outbound/x402.ts`）が拒否する。
  その拒否面は `tests/wire/x402-guarded-signer.test.ts` で無課金で検証している。
- x402 の EIP-3009 経路では Router はチェーンに接続せず署名するだけで、
  **ブロードキャストと gas は facilitator 負担**（payer の ETH 残高は 0 のままで成立する）。
- 決済スコープは記録済み（`docs/t7-requirements.md` §2）。
  **公開 facilitator は連打すると nonce 衝突を起こすため、決済は数秒空ける。**

## MCP から使う（T6・審査員向けの再現手順）

Router を **MCP サーバ**として Claude Code から呼べる。**フロントエンドは用意していない。**
「本来支払いができず使えなかった API Provider を、Router に支払わせて使う」体験を
**審査員自身の環境**で再現できることを狙っている。

### 1. Router を起動する（MCP サーバは Router を起動しない）

MCP サーバは**稼働中の Router に接続するだけ**で、Router を内蔵起動しない
（購入の直列化はプロセス内なので、Router が増えると直列化が効かなくなるため）。
起動出力の `{"event":"listening",...,"label":...}` 行を**ファイルに残す**と、
証拠ラベルの出所が Router 自身になる（下記 3）。

### 2. MCP サーバを登録する（1 行）

```sh
claude mcp add subetha-router -- npm run --silent mcp
```

必要な env:

| env | 必須 | 内容 |
|---|---|---|
| `ROUTER_MCP_BASE_URL` | ✓ | 稼働中 Router の origin |
| `ROUTER_MCP_PRINCIPAL_ID` | ✓ | principal 名 |
| `ROUTER_MCP_TOKEN` | ✓ | principal トークン。**tool の引数では渡さない／応答にも出ない** |
| `ROUTER_MCP_ADAPTER_MODE` | | `synthetic`（既定）/ `real` |
| `ROUTER_MCP_EVIDENCE_FILE` | ✓ (いずれか) | Router の起動出力。`label` を**そこから読む** |
| `ROUTER_MCP_EVIDENCE_LABEL` | ✓ (いずれか) | 運用者の自己申告（`verified: false` として出る） |

**どちらも無ければ起動を拒否する**（どのレールに繋いでいるかを名乗らないまま動かさない）。

検証に使ったバージョン（T6-13）:

| 項目 | 値 |
|---|---|
| `@modelcontextprotocol/sdk` | `1.30.1`（完全一致固定） |
| MCP protocol version | SDK の `LATEST_PROTOCOL_VERSION` = `2025-11-25`（ネゴシエーションで下位も可: `2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07`） |
| Node | v22（type-stripping 既定 ON） |

### 3. 公開される tool

| tool | 対応 | 備考 |
|---|---|---|
| `subetha_router_list_routes` | R1 | 上流 Provider の URL は返らない |
| `subetha_router_quote` | R2 | **支払いを開始しない。** 返る `subject` が人間の承認対象 |
| `subetha_router_purchase` | R3 | `approval` に承認した `quoteId` を渡す |
| `subetha_router_status` | R4 | 保存 → 再オープン相当 |

- **明示承認を飛ばさない。** `quote` は支払いを始めず、`purchase` は `approval` が
  `quoteId` と一致しなければ実行されない。**MCP 層は承認を判定し直さない**（渡された値を
  そのまま束縛に使う）。拒否面は 2 層ある: **型付きクライアント層**が束縛不一致を見て
  Router へ要求を出さずに止め（`approval_mismatch`）、**Router 自身**も承認ヘッダの無い R3 を
  `approval_required` で拒否する（どちらもテストで固定している）。
  **エージェントが自律的に払う形にはしていない。**
- `subject.source.decimals` を必ず見ること。`amount` は base units なので、
  `decimals` なしでは `10000` が 0.01 なのか 10000 なのか判断できない。
- `requestId` は**再試行しても同じ値**を使う。変えると別の購入になり得る
  （同一引数で反復しても購入が 1 回に潰れることをテストで固定している）。
- **MCP サーバを再起動すると `purchase` は失敗する**（quote の発行元が消えるため。
  `quote` を取り直す）。`status` は再起動後も参照できる。

### 4. 実行証拠（`evidence`）

全 tool の応答に `evidence: { label, source, verified }` が付く。

- `source: "router_listening_line"` / `verified: true` … Router 自身の起動行から読んだ値
- `source: "operator_asserted"` / `verified: false` … 運用者の自己申告（Router が名乗った値ではない）

**裸のラベルを信用しないこと。** `verified: false` は「運用者がそう言っている」以上の意味を持たない。

### 5. この経路で到達していないもの

- **実決済は未解除。** `real` モードの `purchase` は
  `real_settlement_not_authorized` を返して**支払いを始めない**（実署名能力が未実装）。
  合成モードの資格情報は `synthetic: true` を含む無課金トークンで、実 x402 / MPP の支払いではない。
- Provider A/B の**実 API 到達**、finality、**AC-7** はいずれも未達。
  この MCP 経路は Router 側の束縛と状態提供までを示すもので、実決済デモではない。

## 出典とライセンス

- 本リポジトリのソースは新規に書いたもので、過去の `subetha-payment-router` PoC のコードは
  複製していない。PoC の結果は本提出物の検証にはならない。
- 公式 `@zerc20/sdk` および BUSL ソースは vendoring も再配布もしていない。
- `fs-ext`（MIT）は外部依存として取得するだけで、リポジトリに取り込んでいない。

## まだ確認していないもの

現時点の証拠は**ローカルの合成 fixture に対するテストのみ**（`tests/unit` + `tests/wire`、
`types` / `build` は exit 0）で、レビュー合格や受け入れ完了を意味しない。
**合成 fixture に対する settle・receipt は実決済ではない。**

別ゲートのまま**未実施**のもの:

- **受信レグ（SubEtha）の実決済**。受信側は合成 facilitator のままで、実ランタイム値（U-01/U-02）が未確定。
  → **AC-4 は未達。**
- Provider **B**（MPP / Tempo）の実決済と実 API 到達（改修中のため対象外）。
- 既存 chat の**実 UI 連携**（ブラウザ上の操作・`server.mts` / `ui.js`）。
  MCP 経路（上記「MCP から使う」）は用意したが、**実決済は未解除**のまま。
  chat の**実行レイヤ**（`createRouterChatExecution`）との実 TCP 結合と、その越しの
  R4 再取得・再オープンまでは確認済み（T5、上記の節）。実 UI の因果は別ゲート。
- finality の確認。テストネット支払いの実行には**別途の認可**が必要。
- **クリーンインストールからの再現**と**手動起動手順**（用意しておらず、動いたという主張もしない）。
  Linux 未実行。
- MPP の `pull` モード（server 側 broadcast）は**未検証**。adapter が credential 生成前に断るのは
  **能力が `mode: "pull"` を明示した場合だけ**で、`mode` を省略すると SDK 側の選択に委ねられ、
  challenge の `supportedModes` と account 種別次第で `pull` が選ばれ得る。その経路は
  **確認していない**（guard があるとは言えない）。
- P3（MPP 受信→A）/ P4（x402 受信→B）/ P5（同一レール）は v1 の範囲外（DEFER）。
