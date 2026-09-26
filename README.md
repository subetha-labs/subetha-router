# SubEtha Router

ETHGlobal Tokyo 提出実装。**エージェント側が持っている支払い手段**と、**API プロバイダ側が要求する
支払い手段**が違っていても使えるようにする Router。

**x402 しか持っていない人が、MPP でしか払えない Provider を使える。**

```
呼び出し側 ──①x402 / Base Sepolia USDC──> Router ──②MPP / Tempo pathUSD──> Provider
```

2 レグは**交換でもブリッジでもなく独立した支払い**。FX 変換もしない。

## 今すぐ試す

リモートの Router に、**自分の鍵で**払って使う。

```sh
git clone https://github.com/subetha-labs/subetha-router-egt.git
cd subetha-router-egt
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm rebuild fs-ext --foreground-scripts --no-audit --no-fund

# 1) 使い捨てウォレットを作る
npm run wallet:new
#    → 表示された鍵を .env.local に保存し、アドレスに Base Sepolia の USDC を入れる
#      https://faucet.circle.com （ネットワーク: Base Sepolia / トークン: USDC）
#      **ガス（ETH）は不要** — EIP-3009 では facilitator が送信して gas を負担する

npm run wallet:balance   # 10000 base units（0.01 USDC）×回数分あればよい

# 2) リモート Router を登録する
claude mcp add --transport http subetha-router https://router.subethalabs.com/mcp
```

あとは Claude Code を**このディレクトリで**起動して、こう頼む:

> subetha-router で ETH の価格を取ってきて

エージェントが quote を取り、**承認を求め**、`npm run sign` で手元の鍵から署名を作り、
purchase まで進める（手順は `CLAUDE.md` に書いてある）。

**なぜ clone が要るのか**: 受信レグの署名を**自分のマシンで**作るため。
Router は呼び出し側の鍵を持たないので、署名能力は手元に要る。
**鍵はネットワークに出ない**（出るのは署名済みの `credential` だけ）。

**実測済み**（この手順で本番エンドポイントに対して実行した結果）:

| レグ | 実 tx |
|---|---|
| 受信（x402 / Base Sepolia） | `0x61434be7...4a3a`（block 47308787） |
| 送信（MPP / Tempo Moderato） | `0x703ea3c0...a582` |

### 注意

- **決済は数秒空ける。** 公開 x402 facilitator は連続実行で nonce 衝突を起こす
  （実測: 0ms 間隔で 2/20 失敗、3 秒空けて 0/15）。
- **`paid_data_unavailable` が返ることがある。** 支払いは成立したがデータ取得に失敗した状態で、
  **資金は動いている**。Router は**自動再送しない**（二重支払いを避けるため）。再試行すれば通る。
  **稀ではない**: 別環境からの実決済で**初回がこれだった**実例がある（再試行で `delivered`）。
- **`quote` オブジェクトを purchase に渡し直すこと。** リモート Router は**ステートレス**で
  quote を保持しない。`quoteId` だけでは `quote_required` になる。
  渡すのは `quoteId` / `requestId` / `approval` / `quote` / `credential` の **5 つ**
  （`approval` に承認した `quoteId` を入れないと `approval_required` で止まる）。
- **`credential` は `npm run sign` で作る。手で組まない。** リモート利用でも同じ。
  手で組むと `invalid_payment_header` で止まる（`accepted` と `payload.challengeNonce` の
  両方が要る）。形は下記のとおりだが、**署名は手元の鍵で作る必要がある**ので
  結局このツールを通すのが速い:

  ```
  { x402Version: 2, accepted: <quote の source.offer をそのまま>,
    payload: { challengeNonce, signature, authorization } }
  ```
- **quote の有効期限は 10 分。** 切れたら取り直して**改めて承認**する。
- **`bucket_limit` で止まったら上限到達。** 止まること自体が安全機構。

## 何が動いているか

| 項目 | 状態 |
|---|---|
| x402 受信 → MPP 送信（P4） | **実チェーンで決済済み** |
| **MPP 受信 → x402 送信（P5）** | **実チェーンで決済済み** |
| 送信レグ A（x402 / Base Sepolia） | **実決済済み** |
| 送信レグ B（MPP / Tempo） | **実決済済み** |
| MCP（ローカル stdio / リモート HTTP） | **両方で実決済済み** |
| Provider A/B の実 API 到達 | **到達済み**（実データ取得） |

### 両方向が通っている

「持っている手段で払えば、その Provider が要求する手段に橋渡しされる」が**両向きで**成立する:

| 経路 | 受信 tx | 送信 tx |
|---|---|---|
| x402 → MPP | `0x239b6019…74a2`（block 47309247） | `0xe4477dfa…d491`（block 36922546） |
| **MPP → x402** | `0xcbe845e4…d698`（block 36967307） | `0xb7ba21dc…b381`（block 47322681） |

どちらも**ホスト版**（`router.subethalabs.com`）に対する実決済で、送信レグは
**運営ウォレットが自分の資金で**払っている。

**エクスプローラで確認するときの注意**: x402 の tx は `tx.from` が
**facilitator**（実測 `0xd407e409…`、誰が払っても同じ）になる。EIP-3009 では
facilitator が送信して gas を負担するため。**実際に払ったアドレスは Transfer ログ**を見る
（上の送信レグなら `0x5d78cbd6…` → Provider A）。`tx.from` だけ見ると別人の支払いに見える。

ホスト版の route は 2 本:

| routeId | 受信 | 送信 |
|---|---|---|
| `md-mpp-eth-snapshot` | x402（Base Sepolia USDC） | MPP（Provider B） |
| `md-x402-eth-snapshot` | MPP（Tempo pathUSD） | x402（Provider A） |

**MPP で払う場合の注意**: x402 は facilitator が送信して gas を負担するが、
**MPP は呼び出し側が自分で broadcast し、手数料も払う**。実測で支払額 10000 に対し
手数料は **945〜23370**（固定ではなく大きく振れる）。**broadcast 後に失敗した支払いは戻らない。**
1 回試すだけなら x402 のほうが簡単。

そのため **`npm run sign` の意味がレールで変わる**:

| 受信レール | `npm run sign` |
|---|---|
| x402（`md-mpp-eth-snapshot`） | **署名するだけ。** 資金はまだ動かない |
| MPP（`md-x402-eth-snapshot`） | **その場で送金する。** 承認は**この前に**取ること |

**まだ確認していないもの**:

- **SubEtha 受信レグの実決済**（合成 facilitator のまま）。→ **AC-4 は未達**
- 同一レール（x402 → x402 / MPP → MPP）は **未検証**
- **再起動をまたぐ MPP 受信の replay 防止**。replay 状態はプロセス内にあり、
  再起動で消える（Router 自身の at-most-once は `quoteId` 基準で credential を鍵にしていない）
- finality（mined/canonical の判定）
- 既存 chat の**実 UI 連携**（実行レイヤとの結合までは確認済み。T5）

支払いは**テストネット限定**。市場データはメインネットの参照値を読むが、**約定可能な気配値ではない**。
Provider A/B は**自前でホストしている**ものであり、Hyperliquid や Uniswap がこれらの支払い方式に
対応しているという主張ではない。

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
# ↑ chat 実装は別リポジトリにあるため `T5_CHAT_APP_DIR` で場所を渡す。未設定なら skip する。
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

## x402 受信 → MPP 送信（P4・達成済み）

**「x402 しか持っていない人が、MPP でしか払えない Provider を使える」**を実チェーンで通した。

| レグ | チェーン | 実 tx | 送金 |
|---|---|---|---|
| 受信（x402） | Base Sepolia | `0x6f7d60f5...125e`（block 47303606） | client → **Router** 10000 USDC base units |
| 送信（MPP） | Tempo Moderato | `0x89cc773d...1829`（block 36903699） | Router → Provider 10000 pathUSD + 69 手数料 |

- R2 の `source.rail` が **`x402`**、`destination.rail` が **`mpp`**（射影が実レールを名乗る）。
- R4 は `delivered` / `outcome: paid` で、**両レグの txRef が残る**。
- **2 レグは独立した支払い**。交換もブリッジも FX 変換もしない。
- 受信レールは route の **`sourceRail`** で選ぶ。**未指定は `subetha`** なので既存構成は不変。

**設計上の要点**: facilitator は `requirements.extra` の `name` / `version` から EIP-712 domain を
再構成するため、Router はこれを**自分で発行**する。`accepted.extra` に Router 発行キー以外があれば
**拒否**するので、payer が署名ドメインを差し込むことはできない。
`paymentRequirements` は必ず **Router 発行の offer から**組み、`credential.accepted` は facilitator へ送らない。

**この経路で到達していないもの**: **AC-4 は未達**（要件の文言は SubEtha 受信レグを指すため）。
P3（MPP 受信→A）/ P5（同一レール）は DEFER 継続。finality・AC-7 も未達。
なお chat 契約は `rail === 'subetha'` と `scheme === 'subetha-zerc20'` を要求するため、
**x402 受信 route は chat からは使えない**（SubEtha route と並存させる）。

## 送信レグ A / B の実決済（T7・達成済み）

**両レールとも実テストネット決済が成立している。**

| レール | Provider | 実 tx | 額 |
|---|---|---|---|
| A（x402 / Base Sepolia） | `provider-a.subethalabs.com` | `0x68b9469f...f371`（block 47301621） | 10000 USDC base units |
| B（MPP / Tempo Moderato） | `provider-b.subethalabs.com` | `0x84157b93...ea69`（block 36898398） | 10000 pathUSD base units + 69 手数料 |

**URL の改称について**: 上表の Provider URL は**決済当時の事実**であり書き換えない。
その後 `provider-a` → **`provider-x402`**、`provider-b` → **`provider-mpp`** に改称され、
**旧 URL は削除された**（到達不能。親が確認済み）。現在の接続先は新 URL。
`providerId`（`market-data-a` / `market-data-b`）・価格・受取先・チェーン・パスは不変。

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

## ローカルで動かす（clone する場合）

ホスト版（冒頭「今すぐ試す」）で足りるが、自分の環境で全部動かしたい場合はこちら。

```sh
git clone https://github.com/subetha-labs/subetha-router-egt.git
cd subetha-router-egt
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm rebuild fs-ext --foreground-scripts --no-audit --no-fund

claude mcp add subetha-router \
  -e SUBETHA_PAYER_PRIVATE_KEY=0x<Base Sepolia の使い捨て鍵> \
  -- npm run --silent demo:mcp
```

`demo:mcp` は **Router を子プロセスとして 1 つだけ起動**し、その上に MCP サーバを立てる。
ホスト版と違い、**受信レグの鍵をこのプロセスに渡す**形になる（自分のマシンなので手元に閉じる）。

実測済み:
```
quote: 10000 base units (decimals 6) on eip155:84532
purchase outcome=delivered
inbound  tx=0x17d1ab62...8847   (Base Sepolia, block 47304257)
outbound tx=0x78385ee1...58ce   (Tempo Moderato, block 36905875)
```

デプロイ（EC2 + Docker + TLS）の手順は [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## MCP の詳細（tool・証拠・到達範囲）

### 公開される tool

| tool | 対応 | 備考 |
|---|---|---|
| `subetha_router_list_routes` | R1 | 上流 Provider の URL は返らない |
| `subetha_router_quote` | R2 | **支払いを開始しない。** 返る `subject` が承認対象、`quote` をそのまま持ち回る |
| `subetha_router_purchase` | R3 | `quote` と、自分の鍵で署名した `credential` を渡す |
| `subetha_router_status` | R4 | 保存 → 再オープン相当。両レグの txRef が残る |

`tools/list` と `quote` は**無料**、`purchase` が**有料**（支払い付き MCP の慣行に合わせている）。
支払いは**セッションではなく呼び出しに紐づく**ので、リモートは**ステートレス**で動く。

- `subject.source.decimals` を必ず見ること。`amount` は base units で、
  `decimals` なしでは `10000` が 0.01 なのか 10000 なのか判断できない。
- `requestId` は `quote` と `purchase` で**同じ値**を使う。変えると別の購入になる。
- **Router は呼び出し側の鍵を持たない。** `src/**` に秘密鍵の参照は 0 件で、env からも読まない。

### 実行証拠（`evidence`）

全 tool の応答に `evidence: { label, source, verified }` が付く。

- `source: "router_listening_line"` / `verified: true` … **Router 自身の起動行**から読んだ値
- `source: "operator_asserted"` / `verified: false` … 運用者の自己申告（Router が名乗った値ではない）

**裸のラベルを信用しないこと。** `verified: false` は「運用者がそう言っている」以上の意味を持たない。

### この経路で到達していないもの

- **SubEtha 受信レグ**は合成のまま。→ **AC-4 は未達**
- Provider A/B の実 API 到達・実決済は**到達済み**（上記の各節）
- finality は未確認

## 出典とライセンス

- 本リポジトリのソースは新規に書いたもので、過去の `subetha-payment-router` PoC のコードは
  複製していない。PoC の結果は本提出物の検証にはならない。
- 公式 `@zerc20/sdk` および BUSL ソースは vendoring も再配布もしていない。
- `fs-ext`（MIT）は外部依存として取得するだけで、リポジトリに取り込んでいない。

## まだ確認していないもの

**実決済は x402 受信 / x402 送信 / MPP 送信のいずれも到達済み**で、オンチェーンで独立に検証している
（各節の tx を参照）。ただし**テストネット限定**であり、以下は別ゲートのまま**未実施**。

- **SubEtha 受信レグの実決済**。受信側は合成 facilitator のままで、実 facilitator は
  ローカル（anvil chainId 31337）でしか動かせる状態にない。→ **AC-4 は未達。**
  なお U-01/U-02（スキーマ・フィールド名）は実装ソースから確定済みで、
  **残る障害はスキーマではなく公開テストネットへのデプロイ**。
- 既存 chat の**実 UI 連携**（ブラウザ上の操作・`server.mts` / `ui.js`）。
  chat の**実行レイヤ**（`createRouterChatExecution`）との実 TCP 結合と、その越しの
  R4 再取得・再オープンまでは確認済み（T5）。実 UI の因果は別ゲート。
  なお chat 契約は `rail === 'subetha'` を要求するため、**x402 受信 route は chat からは使えない**。
- **finality の確認**（mined / canonical の判定）。
- **クリーンインストールからの再現**。EC2 上での clone → build → 起動は実施済みだが、
  他環境（Linux 以外・別アーキテクチャ）は未検証。
- MPP の `pull` モード（server 側 broadcast）は**未検証**。adapter が credential 生成前に断るのは
  **能力が `mode: "pull"` を明示した場合だけ**で、`mode` を省略すると SDK 側の選択に委ねられ、
  challenge の `supportedModes` と account 種別次第で `pull` が選ばれ得る。その経路は
  **確認していない**（guard があるとは言えない）。
- P3（MPP 受信→A）/ P4（x402 受信→B）/ P5（同一レール）は v1 の範囲外（DEFER）。
