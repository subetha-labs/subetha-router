# SubEtha Router

ETHGlobal Tokyo 提出実装。AI エージェント側の支払い手段と、API プロバイダ側が要求する
支払い手段をつなぐ Router を作る。

**現状: 耐久コアの journal（追記・replay・単一 writer ロック）のみが動く段階。**
Router の HTTP エンドポイントはまだ存在せず、実際の受信/送信の決済、Provider の実 API、
chat からのレシート取得、finality はいずれも未検証で別ゲート。本 README はその範囲だけを書く。

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
npm run test    # vitest run（現時点の対象は journal の単体テストのみ）
npm run types   # tsc --noEmit
npm run build   # tsc
```

テストは実ファイルシステムを使い、使い捨てディレクトリを `runtime/` 配下にのみ作って
自分の作ったパスだけ削除する。`runtime/` は git 管理外。二重 writer の拒否は実際に別プロセスを
起動して確認している。無課金・無署名・ネットワークアクセスなし。

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

## 出典とライセンス

- 本リポジトリのソースは新規に書いたもので、過去の `subetha-payment-router` PoC のコードは
  複製していない。PoC の結果は本提出物の検証にはならない。
- 公式 `@zerc20/sdk` および BUSL ソースは vendoring も再配布もしていない。
- `fs-ext`（MIT）は外部依存として取得するだけで、リポジトリに取り込んでいない。

## まだ解除していないもの

Router の公開 HTTP 契約、受信レグ/送信レグの実決済、実ウォレット・鍵・署名、Provider A/B の実 API 到達、
既存 chat との接続と結果の再取得、finality の確認。いずれも本段階では未実施であり、成功の主張はない。
