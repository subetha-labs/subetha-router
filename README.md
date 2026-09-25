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

**現状: 耐久コア（journal + 購入ライフサイクル）の単体テストのみ。**
Router の HTTP/TCP はまだ無く、購入経路は同一プロセス内の合成レール（鍵なし・署名なし・送金なし）に
対してのみ通っている。実 SDK 配線（A = T2 / B = T3）、実決済、実 API 配信、クライアント受領、
chat 連携、finality はいずれも未実施で別ゲート。本 README はその範囲だけを書く。

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
npm run test    # vitest run（現時点の対象は journal と購入ライフサイクルの単体テストのみ）
npm run types   # tsc --noEmit
npm run build   # tsc
```

テストは実ファイルシステムを使い、使い捨てディレクトリを `runtime/` 配下にのみ作って
自分の作ったパスだけ削除する。`runtime/` は git 管理外。二重 writer の拒否は実際に別プロセスを
起動して確認している。購入ライフサイクルのテストは同一プロセス内の合成レール（`synthetic`）に対して
行い、**無課金・無署名・鍵なし・ネットワークアクセスなし**。

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

## 現時点の購入ライフサイクル（core、合成レールのみ）

`quote → 承認 → strict preflight → 上流 offer の再照合 → 予算予約 → verify → 受信 settle →
送信の write-ahead → pay → 結果の durable 保存` を 1 本、実 journal の上で通している。

- 承認は `quoteId` に束縛し、承認期限は quote 時に確定した**絶対時刻**（TTL と発行 offer の失効の
  早い方）を journal に載せて再起動後も同じ値で判定する。
- `(principal, requestId)` → `quoteId` は不変。所有 principal 以外は開始も参照もできない。
- 予算は `(network, asset)` バケットごとに通算し、同一バケットに落ちる受信・送信は合算する。
  件数上限・1 件上限・金額の形式検査を通したうえで、単一 mutex で「検査 → 予約行の append+fsync」を
  不可分に行い、成功しない限り受信 settle を始めない。`unknown` は枠を保持したままにする。
- 送金直前に上流の提示をもう一度読み直し、承認済みの offer と一致しなければ署名も送信もしない。
- 例外・タイムアウト・解釈できない応答は `unknown` として durable に確定し、**自動再送・自動再
  settle・自動返金はしない**。中断された途中状態は再起動時に `unknown` として journal に追記する。
- 公開する理由コードは固定の安全な集合に限り、上流 URL・トークン・例外文字列を出さない。

## 出典とライセンス

- 本リポジトリのソースは新規に書いたもので、過去の `subetha-payment-router` PoC のコードは
  複製していない。PoC の結果は本提出物の検証にはならない。
- 公式 `@zerc20/sdk` および BUSL ソースは vendoring も再配布もしていない。
- `fs-ext`（MIT）は外部依存として取得するだけで、リポジトリに取り込んでいない。

## まだ解除していないもの

Router の公開 HTTP 契約と TCP 配線（T1b）、実 SDK 配線（A = T2 / B = T3）、受信レグ・送信レグの実決済、
実ウォレット・鍵・署名、Provider A/B の実 API 到達、API 配信とクライアント受領、既存 chat との接続と
結果の再取得、finality の確認。いずれも本段階では未実施であり、成功の主張はない。
ここにある証拠は**ローカルの合成単体テストのみ**で、レビュー合格を意味しない。
