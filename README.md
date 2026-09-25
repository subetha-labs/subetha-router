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

**現状: 耐久コア + Router の HTTP 公開契約を、実 CLI・実 TCP で合成レール相手に 1 本通した段階。**
`src/main.ts` を実プロセスとして起動し、**別プロセスのテストクライアント**から実 TCP で
R1→R2→R3→R4 を通している。ただし両レグの相手は**リポジトリ内の別プロセス合成 fixture**
（`tests/fixtures/*`、`synthetic`・無課金・無署名・鍵なし・loopback のみ）で、**実決済ではない**。
公式 `@x402/*` / `mppx` SDK 配線（A = T2 / B = T3）、実ウォレット・鍵・署名・送金、Provider A/B の
実 API 到達、既存 chat 連携、finality はいずれも**未実施で別ゲート**。本 README はその範囲だけを書く。

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
npm run test    # vitest run（unit 45 + wire 20 = 65 tests）
npm run types   # tsc --noEmit
npm run build   # tsc
```

wire（実 CLI・実 TCP）だけを走らせる場合:

```sh
npm run test -- tests/wire/router-cli.test.ts      # R1→R2→R3→R4 と 3 終端・再起動
npm run test -- tests/wire/http-contract.test.ts   # 公開契約の拒否面と canonical 束縛
npm run test -- tests/wire/concurrency.test.ts     # 並行 R3（同一 quote / 別 quote）
npm run test -- tests/wire/crash-recovery.test.ts  # 応答バイト送出前のクラッシュと再起動
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
| `ROUTER_CONFIG_PATH` | （必須） | `{"router":{approvalTtlMs,routes,budget},"synthetic":{facilitatorUrl,upstreams,crashBarrierPath?}}` の JSON |
| `ROUTER_PRINCIPAL_TOKENS` | （必須） | `<principalId>:<token>` のカンマ区切り。応答・ログ・journal に出さない |
| `ROUTER_ADAPTER_MODE` | `real` | `real` または `synthetic`。**合成レールは明示指定のときだけ** |
| `ROUTER_JOURNAL_PATH` | `runtime/journal.ndjson` | NDJSON journal（`journal.lock` は同階層） |
| `ROUTER_HTTP_HOST` / `ROUTER_HTTP_PORT` | `127.0.0.1` / `8500` | 待ち受け。`0` でエフェメラル |
| `ROUTER_CANONICAL_BASE_URL` | `http://127.0.0.1:8500` | canonical URL の基点（`Host` から導かない） |

- **既定（`ROUTER_ADAPTER_MODE=real`）では実 adapter を解決できず、`adapter_not_wired` で起動を
  中止する。合成レールへフォールバックしない。** 実 SDK 配線は T2 / T3 のゲート。
- `synthetic` を明示したときだけ、リポジトリ内の既知の fixture 構成を組み立てる（任意のプラグイン
  読み込みはしない）。接続先は **loopback のみ**に制限し、リダイレクトも追わない。
- `routeId` はパス安全な形に限り、`canonicalPath` は実際に提供する
  `/v1/routes/{routeId}/resource` と一致しなければ**起動時に `config_invalid` で拒否**する。
- `synthetic.crashBarrierPath` は T-11 のための**合成専用の試験用シーム**（応答バイト送出前で停止し
  到達を書き出す）。`synthetic` セクションにしか書けないため、既定の `real` 構成では解析対象にすら
  ならない。運用機能ではない。

## 出典とライセンス

- 本リポジトリのソースは新規に書いたもので、過去の `subetha-payment-router` PoC のコードは
  複製していない。PoC の結果は本提出物の検証にはならない。
- 公式 `@zerc20/sdk` および BUSL ソースは vendoring も再配布もしていない。
- `fs-ext`（MIT）は外部依存として取得するだけで、リポジトリに取り込んでいない。

## まだ確認していないもの

現時点の証拠は**ローカルの合成テストのみ**（unit 45 + wire 20 = 65、`types` / `build` は exit 0）で、
レビュー合格や受け入れ完了を意味しない。**合成 fixture に対する settle は実決済ではない。**

T-10（並行 HTTP）と T-11（応答送出前クラッシュ）は上記のとおり実 TCP で取得済み。ただし
**T1 全体の受け入れが完了したわけではない**（受け入れ判断は親とレビューの担当）。

別ゲートのまま**未実施**のもの:

- 公式 SDK 配線（A = `@x402/*` / T2、B = `mppx` / T3）。SDK の import や typecheck は実決済ではない。
- 受信レグ・送信レグの**実決済**、実ウォレット・鍵・署名・ブロードキャスト・faucet。
- Provider A/B の**実 API 到達**と実 URL・実資産（SubEtha facilitator の実値を含む）。
- API 配信とクライアント受領、既存 chat との接続と結果の再取得、finality の確認。
- 手動起動手順の検証（用意しておらず、**動いたという主張もしない**）。Linux 未実行。
