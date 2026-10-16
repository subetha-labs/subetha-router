# タスク分解: hosted Router の受信レグで SubEtha（zUSDC）決済を受ける

> 2026-10-16、第 2 版（第 1 版は独立レビューで REJECT、11 件。§5）。入力は `docs/subetha-hosted-inbound-requirements.md`（要件 v4、owner 承認）と `docs/subetha-hosted-inbound-design.md`（設計 v4、Codex APPROVE、
> O-1〜O-8 は owner 決定済み）。以下「設計 §x」「要件 FR-x」はそれらを指す。本書はタスクフェーズの成果物で、コード・実行結果・合格の主張は含まない。記載のコマンドは**計画であり未実行**。
> **owner の承認**: 2026-10-16「進めて良いです」（実行フェーズ開始）。
> 形は先行の `docs/mpp-solana-tasks.md` と同じ（§0 の規則、1 タスク 1 PR、sabotage、独立レビュー）。

## 0. 全タスク共通

- **担当**: 親（controller）が状態・commit を持ち、実装後に実ソースを読み戻してテストを実際に実行する。レビューは `gpt-6-astra`・read-only で差分と実ソースを見る。writer は 1 つ。
- **順序**: まず落ちるテストを書き、赤を確かめてから実装する。完了条件の試験は**守っているコードを外して落ちること**（sabotage）を確かめ、結果を PR に書く。**変異の前に commit する**。
- **完了コマンド**: focused → `npm run types` → `npm test`。skip と失敗を区別して報告する。「Linux」と書いた完了条件は `node:22-bookworm` で実行した結果を要する（macOS の既知の揺れ: 127.0.0.2 の alias を要る試験、ingress 408）。
- **1 タスク 1 PR**。各 PR は Codex の承認と実テストでマージする（要件 §8 の段階 4）。
- **資金**: 親の操作で資金が動くのは **G-2 と G-4 だけ**で、範囲は要件 §7（payer: Sepolia ETH 0.05 以下・試験用 USDC の mint と wrap 各 1 USDC 以下、購入は合計 10 件以下、送信レグは Base Sepolia USDC・Tempo pathUSD 各 0.10 以下）。
  owner の決定（2026-10-08）で testnet の資産が動く段は確認なしで進めてよいが、**範囲を超えるときは owner に確認する**。faucet は owner が使う。それ以外のタスクは本物の facilitator・RPC・Provider に接続しない（loopback の fixture だけ）。**mainnet の資産は使わない**。
- **鍵**: `src/` は env を読まない。試験の鍵は毎回の乱数。実鍵は `tools/` と ignored の env ファイルだけ（payer は既存の `SUBETHA_PAYER_PRIVATE_KEY`。G-2 の payer は**新しい使い捨ての鍵**）。
  **鍵・RPC の URL とキー・facilitator の秘密・ローカルの絶対パスを docs・PR に書かない**。facilitator の秘密の作成と所在は `.claude_workflow/local/` にだけ記録する。
- **BUSL**: `@zerc20/sdk` を Router のリポジトリ・image・npm に入れない。SDK の取得と build は owner が facilitator のホストで行う（設計 §2.2）。
- **既定で無効**: `RAILS_ACTIVATION.subetha` は T1 で `{ inbound: false }` に固定し、G-4 で `true`。
- **既存の挙動で意図して変えるもの**（各タスクに明記）: (a) **core**: purchase の検査の順に申告の記録を挿入（設計 §5.1。subetha 受信だけが書く）、(b) **射影**: 静的購入に `fundsMoveOnCredential` と `awaitingPaymentDoesNotMeanUnpaid`（Tempo・Solana の MPP の静的 route にも加算で付く。設計 §5.2）、(c) **一覧**: `sourceRail: "subetha"` を明示した route だけ `rail`・`scheme`、(d) **受信 adapter の期限**: subetha の route の network の期限（Sepolia 50 秒）、(e) **入口**: 拒否ホストに facilitator のホスト名を常に、(f) **道具**: `classifyOffer` の前に subetha の分岐。他の既存の wire 試験は bytes も結果も変えない。

## 1. 依存

```
T0  実装前の確認（読取だけ）                                   ← main
T1  表・設定生成・切り替え・一覧                                ← T0
T2  core: 申告の記録・状態の伝搬・射影・rollback の試験          ← T1
T3  受信の表示と期限: MCP の subject・説明・adapter の期限・AC-2  ← T1
T4  sign: 分類・試行記録・送出・照会（AC-3・AC-4）              ← T1
T5  zUSDC の準備の道具（mint・wrap）                           ← T4
T6  文書: CLAUDE.md・README・DEPLOY.md（facilitator の手順書）   ← T2, T3, T4, T5
G-1 facilitator の配備（owner の作業 + 親の設定と観測）         ← T6、owner の EC2 等
G-2 ローカル Router で AC-6・AC-7・AC-8                        ← G-1, T6
G-3 hosted の image を subetha 無効のまま入れ替え（基準の image） ← G-2
G-4 有効化した image に入れ替え、hosted で AC-9                 ← G-3
G-5 payer 0.3.0 の設計（別の要件の段階へ）                       ← G-4
```

writer は 1 つなので順に T1 → T2 → T3 → T4 → T5 → T6。

## 2. タスク

### T0 — 実装前の確認（読取だけ。設計 §2.2・§2.4・§4.3 の「T-段階で確かめる」）

- **範囲**（コードを変えない。結果は本書の §4 に追記して commit）:
  - (a) facilitator（`1aeac60`）と SDK（owner の checkout `b890773`）のソースで、外へ出る接続の URL が設定の 4 つ（`rpc_url`・`hub_rpc_url`・`indexer_url`・`decider_url`）だけであること（`fetch`・`http(`・`createPublicClient` の呼び出し箇所の一覧）。O-8 の保証の前提
  - (b) SDK の build に要る toolchain（owner の checkout の `package.json`・build script を読む。Rust・wasm-pack の要否）。結果は G-1 の owner の作業の一覧に入れる
  - (c) Router の購入全体の外側の期限（HTTP の handler・MCP の purchase・`npm run sign` の待ち）が、Sepolia の受信 50 秒と sign の receipt 待ち 120 秒に足りるか。足りなければ直す場所を T3 の範囲に足す
  - (d) AL2023 の dnsmasq が `nftset=` を持つか: 公開の `amazonlinux:2023` の container（Colima、一度に 1 つ）で `dnf info dnsmasq` と、入れた dnsmasq の `--version` の
    compile options に `nftset` があるか。host の準備は要らない（owner の作業なし）
- **完了条件**: 4 つの結果がファイル・行（(d) はコマンドと出力）つきで §4 にある。(a) で設定外の URL が見つかれば、設計 §2.4 と O-8 を owner に諮るまで G-1 に進まない。
  (d) が「無い」なら設計 §2.4 の代替を設計に戻して決め、**T6 の dnsmasq・nftables の見本と G-1 に進まない**

### T1 — 表・設定生成・切り替え・一覧（設計 §4.1・§4.2 の一覧、§6.1 の表。FR-3.1〜3.5、FR-4.1、AC-1）

- **範囲**: `src/shared/networks.ts` に `SUBETHA_ZERC20_ASSETS`（zUSDC、6 桁、上限 20,000）。`tools/remote-mcp-config.ts` に `INBOUND_ZUSDC`・route id 2 つ・`SUBETHA_FACILITATOR_HOSTNAME`・
  `SUBETHA_FACILITATOR_URL_ENV`、`RailsActivation.subetha`（`subethaOf`、既定 `false`）、`RAILS_ACTIVATION.subetha = { inbound: false }`、有効時の route 2 本・上流・予算の区分、
  env の検査（無い・`https:` でない・host 違い・path 付きで固定文で停止）、`denyHosts` に facilitator のホスト名を**常に**。`tools/remote-mcp.ts` の子の env（有効時だけ
  `ROUTER_SUBETHA_FACILITATOR_URL` を env の値に）。`src/http/projection.ts` の `sourceRailListingOf` に `subetha`（明示のときだけ）
- **成果物**: 上の変更、`tests/unit/remote-mcp-config*.test.ts`（追加）、一覧の射影の unit
- **完了条件（unit）**: off で route 0 本・env を読まない（未設定でも生成が通る）・`denyHosts` に facilitator のホスト名、on で route 2 本（`sourceRail: "subetha"`・`source` は zUSDC・`payTo` 無し）・
  上流・予算の区分（`maxPerPurchase` 10,000）・子の env、env の 4 種の誤りで固定文の停止（値を含まない）、一覧で `source.rail: "subetha"`・`scheme: "subetha-zerc20"`、
  `sourceRail` 未指定の route の一覧が今と同じ。既存の設定生成の golden（route 10・プロファイル 56）が off で不変
- **完了条件（wire、AC-1）**: loopback の合成 facilitator（既存の `tests/fixtures/facilitator-server.ts`）と Provider の fixture で、設定生成の出力そのもので起動した Router について:
  off で一覧に 2 本が無く `quote` が `unknown_route`、on で一覧に 2 本（`source.rail: "subetha"`・`scheme: "subetha-zerc20"`）と `quote` の成立
- **sabotage**: `denyHosts` の常時の追加を有効時だけに → off の試験が落ちる／env の host の検査を外す → host 違いの試験が落ちる／一覧の明示の条件を外す → 未指定の route の試験が落ちる／
  route の生成の有効化の条件を外す → off の wire 試験が落ちる

### T2 — core: 申告の記録・状態の伝搬・射影（設計 §5。FR-7.1〜7.3、AC-5）

- **範囲**: `src/core/orchestrator.ts` の `purchaseStatic` に ④（設計 §5.1 の規則: 対象の条件、重複は書かない、上限 8 件で `claim_limit_reached`、書き込み失敗で
  `unknown`/`source_claim_unrecorded`、終端でも書く）、`src/core/intent.ts` の `source.claimedTxRefs`、`src/core/store.ts` の `reduce` の `source_claimed`（変えるのは
  `claimedTxRefs` と `updatedAt` だけ）、`Projection`・`projectionOf` の `claimedTxRefs` と静的の `fundsMoveOnCredential`、`src/http/projection.ts` の `projectionBody`
  （`claimedTxRefs`・`claimedTxRefsAreUnverified`・静的の `awaitingPaymentDoesNotMeanUnpaid`）、公開の理由コードの集合に `claim_limit_reached`・`source_claim_unrecorded`
- **成果物**: 上の変更、`tests/unit/store-claims.test.ts`（新）、`tests/wire/subetha-claim.test.ts`（新）。合成 facilitator は**既存の** `tests/fixtures/facilitator-server.ts`（`--settle`・`--verify`・
  `--challenge`・`--settle-delay-ms`・`--after-headers` の mode と `/calls`）を使い、足りない mode（例: settle の応答を返さない）だけを足す。既存の mode の挙動は変えない
- **完了条件（unit・wire。Linux）**:
  - AC-5 の各経路の後に status が `claimedTxRefs` を返す: verify 失敗、preflight の `offer_expired`、`approval_expired`、`quote_changed`（設定変更）、`offer_changed`（上流の変化）、
    settle の応答喪失（fixture が応答を返さない）、Router の再起動（journal の replay）
  - 終端（`source_failed`・`delivered`・`unknown`）の intent への出し直しが記録され、**状態と返る結果が変わらず**、verify・settle・送信の呼び出しが増えない
  - 9 件目の新しい hash で `claim_limit_reached`、verify 0 回。同じ hash の出し直しは行を増やさない
  - journal の append の失敗の注入で `source_claim_unrecorded`、verify 0 回
  - 他人の principal・別の `requestId`・`approval` 違い・nonce 違い・hash の形違いでは書かない
  - 送信の呼び出しは各経路で 0 回か 1 回。同じ quote で新しい challenge が出ない（fixture の `/calls` に **`challengeCalls` を足し**、同じ `requestId` の quote と purchase の繰り返しで値が増えない）
  - **MCP の `subetha_router_status`** の応答に `claimedTxRefs`・`claimedTxRefsAreUnverified`、`awaiting_payment` のとき `awaitingPaymentDoesNotMeanUnpaid` が届く（journal の replay の後も）
  - **rollback の試験**（設計 §5.3）: 申告の行を含む journal を、現行の reducer と `source_claimed` を知らない reducer（今の `reduce` の写し）で replay し、状態が同じ
  - Tempo・Solana の MPP・x402 の既存の静的・動的の wire 試験が bytes も結果も変わらない（射影の加算の欄は除く。加算の欄は試験で明示）
- **sabotage**: ④ を状態の検査の後に移す → 終端への出し直しの試験が落ちる／上限の拒否を「書かずに続行」に → **状態が `created` のまま**（承認が正しく、期限内、設定・上流が quote と一致）で永続化された申告 8 件を持つ intent に 9 件目を出す試験が、verify に到達して落ちる（変異なしでは `claim_limit_reached`・verify 0 回）／reducer で状態を変える → 終端の試験が落ちる／
  書き込み失敗の分岐を外す → `source_claim_unrecorded` の試験が落ちる

### T3 — 受信の表示と期限（設計 §4.2・§4.3。FR-2.3、FR-4.2・4.3、AC-2）

- **範囲**: `src/mcp/tools.ts` の `approvalSubject`（subetha のとき `source.rail`・`scheme`・`payTo` と `subethaDisclosures`）、`src/mcp/server.ts` の手順の説明に subetha の一行、
  `src/main.ts` の `createSubethaInbound` に subetha の route の network の期限（`evmTestnetDeadlinesOf` の最大、route が無ければ今の既定）、T0 (c) で見つかった外側の期限の修正
- **成果物**: 上の変更、`tests/unit/mcp-subject*.test.ts`（追加）、`tests/wire/subetha-inbound-fee.test.ts`（新。AC-2）、期限の試験。AC-2 は既存の fixture に
  `--challenge fee-added`（`amount` に手数料を足して返す）を足す。遅延は既存の `--settle-delay-ms`
- **完了条件（unit・wire）**: subetha の subject に 6 つの開示、他のレールの subject が不変、合成 facilitator が `amount` に手数料を足すと quote が `source_terms_mismatch`（AC-2）、
  合成 facilitator の settle の応答が 5 秒を超え 50 秒未満でも `settled`（clock の差し替えか遅延の fixture）、subetha の route が無い構成の期限が今と同じ
- **sabotage**: 期限の受け渡しを外す → 遅延の試験が `unknown` で落ちる／`orchestrator.ts:461-467` の amount の比較を外す → AC-2 が落ちる

### T4 — `npm run sign` の subetha 分岐（設計 §6。FR-5.1〜5.7、AC-3・AC-4）

- **範囲**: `tools/subetha-payer.ts`（新）: 束縛の検査、試行記録（ディレクトリの耐久性、`link` による原子的な作成、読む時の検査と `rawTx` の復号、`EEXIST`）、照会、期限、
  鍵 → 残高 → 署名 → 記録 → 送出 → receipt、`unknown` の出力。`tools/sign-run.ts` の振り分け（`classifyOffer` の前に `scheme === "subetha-zerc20"`）。
  RPC は `SEPOLIA_RPC_URL`（既定なし。無ければ固定文で停止）。fs と RPC は差し替えられる依存として渡す（製品の分岐に試験用の hook を入れない）
- **成果物**: 上の変更、`tests/unit/sign-subetha.test.ts`（新。AC-3）、`tests/wire/sign-subetha-crash.test.ts`（新。AC-4: 偽 RPC は HTTP、子 process は試験用の入口
  `tests/fixtures/sign-subetha-child.ts` が fs・RPC の包みで指定の位置で `process.kill(process.pid, "SIGKILL")`）
- **完了条件（unit・wire。Linux）**:
  - AC-3: 設計 §6.1 の 1. の 5 つの拒否で鍵の読み出し 0 回（spy）。**試行記録の無い新しい試行**で残り 120 秒未満・期限切れの offer は鍵の読み出し・署名・送出 0 回。残高不足（zUSDC・ETH）で `signTransaction`・`sendRawTransaction` 0 回
  - AC-4: 設計 §6.3 の各行の位置で子を殺し、再実行の stdout・exit・偽 RPC の `eth_sendRawTransaction` の受信回数が表どおり（どの行でも 2 本目は 0）。期限の後の再実行も照会に進む。
    初回と `mkdir` の直後の中断の後で、署名の前に 3 つのディレクトリの `fsync`（fs の包みが順を記録）、どれかの失敗で署名 0 回。記録の各欄・`rawTx` の各要素（chain・`to`・`value`・
    calldata・nonce・署名者）は、**その 1 要素だけが違う transaction を試験の鍵で正しく署名し直し、`txHash` も合わせ、他の束縛はすべて保った**記録で fail closed（先の hash・署名者の照合では落ちない記録にする）。**署名者の違いの行だけは別**: 2 本目の乱数の鍵で署名し、`txHash` は合わせ、記録の `payer` は元のまま残して、復元した署名者の照合で落ちることを確かめる（sabotage でその照合を外すと照会に進む）。2 つの子を同時に走らせ、`eth_sendRawTransaction` が 1 回、負けた側は勝った側の hash
  - receipt: `success` で credential（形は設計 §6.1、`accepted` が offer と `stableJson` で一致）、`success` で Transfer の log が合わない → exit 2・stdout 空、`reverted` → exit 1、
    receipt 無し・例外・時間切れ → exit 2 で `unknown`・hash・記録のパス
  - 既存の `npm run sign` の他のレールの unit が変わらない
- **sabotage**: 照会を期限の後に移す → 期限の後の再実行の試験が落ちる／`link` を `writeFile` に → 途中の中断の試験が落ちる／`~` の `fsync` を外す → 順の試験が落ちる／
  `rawTx` の calldata の照合を外す → calldata だけが違う正しく署名された記録が照合を**通り過ぎて**照会に進み、試験が落ちる（各要素の照合も同じ形で 1 つずつ）／新しい試行の期限の検査を外す → 120 秒未満の試験が鍵の読み出しで落ちる（既存の記録の照会の試験は通ったまま）／`EEXIST` で自分の `rawTx` を送る → 同時の試験が落ちる

### T5 — zUSDC の準備の道具（設計 §3。要件 R-4・§7）

- **範囲**: `tools/zusdc-fund.ts`（新、`npm run wallet:zusdc`）: payer の Sepolia で、試験用 USDC（`0x2f6f…7590`）の `mint(payer, amount)` → LiquidityManager への `approve` →
  wrap（関数は T5 の最初に LiquidityManager の ABI を公式文書・verified source で確かめて固定する）。道具の 1 回の呼び出しの上限は 1,000,000（1 USDC）で、超える引数は拒否する。**これは 1 回の上限で、§7 の承認は通算（mint・wrap 各 1 USDC 以下）**。通算の管理は G-2・G-4 の記録で行う。
  各 transaction の hash を出す。`.claude/settings.json` の allow に足すかは owner に諮る（資金を動かす道具なので既定では足さない）
- **成果物**: 上の変更、`tests/unit/zusdc-fund.test.ts`（偽 RPC で 3 つの呼び出しの calldata と順、上限の拒否）
- **完了条件（unit）**: calldata が表の address と額に一致、上限を超える額で送出 0 回、途中の失敗で後続を送らない
- **sabotage**: 上限の検査を外す → 拒否の試験が落ちる

### T6 — 文書（設計 §2・§4.2・§5.3・§6.4。S-6 の文書の部分）

- **範囲**:
  - `CLAUDE.md`: 「Step 4 means different things on different rails」の表に subetha の行（sign で burn を送る、承認は sign の前、`unknown` は再実行で照会だけ）、route の表への 2 行は
    **G-4 の後**に足す（今は「無効」の注記だけ）
  - `README.md`（payer の準備）: Sepolia ETH の faucet、`npm run wallet:zusdc`、`npm run sign` の zUSDC の流れと試行記録の場所
  - `docs/DEPLOY.md`: facilitator の節（EC2 の要件、SDK と SubEtha の build、`fac.toml`、systemd の unit、Caddyfile、security group、dnsmasq と nftables の設定、
    観測 (a)(b)(c) の手順、秘密の作り方は手順だけ）、Router の env `SUBETHA_ZERC20_FACILITATOR_URL`、**rollback の規則**（設計 §5.3: G-4 の後は G-3 以降の image に限る）、
    `deploy/swap-image.sh` の rollback の候補の説明への一行
  - 設定ファイルの見本: `deploy/zerc20-facilitator/`（`fac.toml.example`、`subetha-facilitator.service`、`Caddyfile.example`、`dnsmasq.conf.example`、`nftables.conf.example`）。秘密・RPC のキーは入れない
- **完了条件**: 見本の `fac.toml` を facilitator の設定の parser（`1aeac60` の `apps/facilitator/src/config.ts` の読み込みの関数を、親が手元の checkout で直接呼ぶ。鍵は試験用の乱数、ネットワークの検査は呼ばない）に通して未知キーの警告 0 件。**T6 を閉じる前に行う**。Codex の docs review

### G-1 — facilitator の配備（AC-6 の前半）

- **owner の作業**: EC2（AL2023、t3.small 程度。SDK の build に大きめが要れば build の間だけ）・Elastic IP・DNS（`zerc20-facilitator.subethalabs.com`）・security group
  （443 は Router の Elastic IP と作業 IP、80 は公開）・RPC のキー（O-6）・SDK の取得と build・SubEtha `1aeac60` の build・秘密 3 つの作成・treasury と relayer の資金
  （relayer: Sepolia ETH と Base Sepolia ETH 各 0.05 以下）
- **親の作業**（owner がホストへの接続を渡したとき。渡さなければ手順を owner が実行し、親は出力を読む）: `fac.toml`・unit・Caddyfile・dnsmasq・nftables の設置、
  `subetha-facilitator check`、起動、`/healthz`、Caddy の 404（`/admin/*`）、§2.4 の観測 (a)(b)、起動時の (c)
- **完了条件**: 上の各項目の出力を `docs/evidence/` に記録（秘密・キーを除く）

### G-2 — ローカル Router で AC-6・AC-7・AC-8

- **前提**: payer の新しい使い捨て鍵（owner が Sepolia ETH を faucet で入れる、0.05 以下）。親が `npm run wallet:zusdc` で mint・wrap（各 1 USDC 以下）
- AC-6: hosted の設定生成（`routerConfigOf` と子の env、`subetha.inbound = true` を試験用の起動で）でローカル Router を起動し、facilitator から `/challenge` を 1 件。動的上流に facilitator のホストと私設アドレスを指定して `destination_blocked`（on と off）
- AC-7: zUSDC → A、zUSDC → B を各 1 件（`npm run sign` → purchase）。`delivered`
- AC-8: 2 件が `finalized`、mint の額 = 10,000 − ⌈10,000 × bps / 10,000⌉（その時点の `redeemFeeBps()`）、`accepted` → `finalized` の時間。§2.4 の (c) を記録。
  設計 §1 の測定: SDK の commit、host の型、SDK の資産の大きさ（`du`）、証明の時間（facilitator の log の時刻から）
- **完了条件**: `docs/evidence/` に tx・journal の行・時間。**§7 の通算の表**（mint・wrap の合計、購入の件数、送信レグの USDC・pathUSD の合計）を毎回の資金の操作の後に更新し、
  次の資金の操作の前に上限との差を確かめる。G-4 はこの表を引き継ぐ

### G-3 — 基準の image への入れ替え

- **owner の gate**（要件 §8 の段階 5「配備（owner ゲート）」）: 入れ替えと rollback は、owner がその回の入れ替えを明示に承認（または委任）したときだけ行う。親は build・確認の手順・記録の準備までを行い、
  承認の文言と日時を `docs/DEPLOY.md` の記録に残す。
- `subetha.inbound = false` の main を build して `deploy/swap-image.sh` で入れ替える。公開の一覧が入れ替え前と同じ（route 10・プロファイル 56）、`/healthz`、`subetha-egress check`。
  この image を「申告の射影を持つ基準の image」として `docs/DEPLOY.md` に記録

### G-4 — 有効化と AC-9

- G-3 と同じ owner の gate（有効化の入れ替えも rollback も、その回の owner の承認か委任が要る）。
- `RAILS_ACTIVATION.subetha.inbound = true` の commit（PR）→ build → 入れ替え。公開の一覧に 2 本、hosted の MCP で 2 件 `delivered`（AC-9）。CLAUDE.md の route の表に 2 行（T6 の残り）
- 失敗したら `false` の image（G-3）に戻す（owner の承認の範囲で。承認が「失敗したら戻してよい」を含まなければ戻す前に確認する）

### G-5 — payer 0.3.0 の設計へ

- 設計 §9 のとおり、payer 0.3.0 の設計書を書き、レビューと owner の確認を経る。AC-10 はその段階で

## 3. 設計の各節の主担当

| 設計 | タスク |
|---|---|
| §1・§2.2 の SDK・§2.4 の前提 | T0、G-1 |
| §2.1〜§2.5 の配備 | T6（手順と見本）、G-1 |
| §3 | T1（額）、T5（資金）、G-2（AC-8） |
| §4.1 | T1 |
| §4.2 | T1（一覧）、T3（subject・説明） |
| §4.3・§4.4 | T3（期限）、T4（sign の 120 秒） |
| §5.1〜§5.4 | T2 |
| §6.1〜§6.4 | T4、T6（CLAUDE.md） |
| §9 | G-5 |
| §11 のゲート | G-1〜G-5 |

## 4. T0 の結果

（T0 の実行後に追記する）

## 5. 第 1 版のレビュー（2026-10-16、Codex CLI 0.157.1、`gpt-6-astra`、read-only）への対応

判定 **REJECT**（high 2、medium 6、low 3）。全件をソースで確かめ、反映した。

| # | 指摘 | 反映 |
|---|---|---|
| 1（high） | G-3・G-4 の入れ替えと rollback に owner の gate が無い | G-3・G-4 に owner の承認か委任を要件として明記 |
| 2（high） | `rawTx` の calldata の sabotage が先の hash・署名者の照合で落ち、守る箇所を通らない | T4: 1 要素だけ違う transaction を正しく署名し直した記録で試験し、sabotage はその記録が照合を通り過ぎることで観測 |
| 3 | 上限の sabotage が終端の intent では verify に届かない | T2: `created` のまま 8 件を持つ intent で 9 件目 |
| 4 | AC-1 の wire 試験の主担当が無い | T1 に wire の完了条件と sabotage |
| 5 | AC-3 に新しい試行の期限の拒否が無い | T4 の AC-3 と sabotage |
| 6 | dnsmasq の `nftset=` の確認が無い | T0 (d)、無ければ T6 の見本と G-1 に進まない |
| 7 | mint・wrap の上限を 1 回の上限と書いた | T5 で 1 回の上限と §7 の通算を区別、G-2 に通算の表 |
| 8 | MCP の status の試験が無い | T2 の完了条件 |
| 9 | fixture に `/challenge` の回数が無い | T2 で `challengeCalls` を足す |
| 10 | T6 の完了条件が後の G-1 に依存 | T6 を閉じる前に parser の検査を親が手元で行う |
| 11 | AC-8 に設計 §1 の測定が無い | G-2 の AC-8 に追加 |

### 5.1 第 2 版のレビュー

判定 **APPROVE WITH CHANGES**。11 件は RESOLVED 10・PARTIAL 1（署名者の違いの行の文言）。新しい critical・high は無し。PARTIAL の 1 件（low）は T4 に反映した。
