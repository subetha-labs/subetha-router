# T5 設計 — chat ↔ Router 実プロセス相互実装 wire テスト（無課金）v2

- 対象要件: `docs/t5-requirements.md` v2（T5-01〜T5-11）。ラベル `T5-crossimpl-nopay`。
- 独立レビュー1回（NEEDS_FIX）を反映。v1 は `.claude_workflow/local/t5-design-v1.md` に保存。
- 前提: T1–T4 受け入れ済み（HEAD `9c76329`）。既存設計・製品コードをやり直さない。

## 1. 方式

### 1.1 chat 実装の駆動方式 — one-shot driver（確定）

Node v22.23.1 では type-stripping が既定 ON のため `.mts` はフラグ無しで import できる
（親が実測で確認済み。tsx 退避路は不要）。`./synthetic-execution.mts` は `import type` のみなので
その先の workspace 依存は解決不要。`./router-contract.mjs` は素の `.mjs`。

**採用: one-shot driver。** 既存 `loopback.ts` の `spawnApp` は `stdio[0] === "ignore"` で
親からステップ指示を送れないため、**stdin 行プロトコルの長命 driver は採らない**
（採ると `loopback.ts` の改変が必要になり allowed file set を汚す）。

- driver は argv でシナリオ名を受け取り、**そのシナリオの全ステップを完走**して
  各ステップの観測を stdout の JSON 行で出力し exit する（既存 `journal-lock-child.ts` と同形）。
- 親テストは `runToExit`（`loopback.ts:62`、既存）で driver を起動し、JSON 行を突き合わせる。
- T5-08（R3 途中で Router を SIGKILL → 再オープン観測）は **driver を 2 回叩く**形で成立させる
  （1 回目: 承認〜R3 で落ちる／親が `killRouter()`。2 回目: 同一 journal ディレクトリを reopen）。
- **型の扱い**: `tsconfig.json` は `rootDir: "."` + emit する `tsc`（`npm run build`）なので、
  worktree 外の `.mts` を**静的 import すると `types`/`build` が落ちる**。
  driver からの chat モジュール参照は**非リテラル指定子の動的 `await import(spec)`**とし、
  戻りは `unknown` 経由で扱う。`tsconfig.json` は変更しない。
- driver の env は `loopback.ts` の `ENV_ALLOWLIST` 相当（`PATH`/`HOME`/`TMPDIR`/`LANG`/`LC_ALL`）に
  絞り、親の秘密を子に渡さない。

### 1.2 Router の起動 — 素の main + synthetic（確定）

`src/main.ts:91-99` の synthetic 分岐は `capabilities` を**参照しない**。
`evidenceLabelOf`（`src/main.ts:151-153`）も synthetic なら無条件に `T1-synthetic-nopay` を返す。
したがって:

- **`router-x402-process.ts`（spy 注入）は使わない**（synthetic では spy が no-op になるため無意味）。
  既存 `router-harness.ts:171` と同形に**素の `src/main.ts` を起動**する。
- **T5-05a の観測を訂正**: 期待するラベルは `T2-fixture-nopay` ではなく
  **`{"label":"T1-synthetic-nopay"}`**。real + spy の証拠ラベルを主張しない。
  「実鍵・実署名 payer を注入していない」ことは、合成 outbound が
  署名しない合成トークンを作るだけであること（`src/adapters/outbound/x402.ts`）で担保する。

### 1.3 canonical origin と実ポートの一致（新規・必須）

既存 harness は `ROUTER_HTTP_PORT: "0"`（エフェメラル）かつ
`ROUTER_CANONICAL_BASE_URL: http://127.0.0.1:8500` で、**両者は意図的に不一致**
（`tests/wire/client.test.ts:258` のコメント参照）。T4 client は自身の `baseUrl` に固定するため無害だった。

しかし chat 側は **`binding.quote.resource.url` へ実際に fetch する**
（`router-execution.mts:245`）。この不一致のままでは:
- R3 が**実 Router に届かない**（8500 で動く無関係なプロセスへ飛ぶ事故もあり得る）
- T5-04 が全滅する

**対策**: T5 harness は**空きポートを先に確保**し、`ROUTER_HTTP_PORT` と
`ROUTER_CANONICAL_BASE_URL` を**同一 origin に揃えて**起動する。
ポート確保と listen の間の競合を避けるため、確保したポートで listen 失敗した場合は
**再試行せず失敗させる**（偽陽性を作らない）。

副次的利用: **T5-03c（canonical 改変）は `ROUTER_CANONICAL_BASE_URL` を別 origin/別 path に
した構成**で検証する。Router も chat も曲げずに拒否を確認できる。

### 1.4 Router 到達の独立計数（新規・必須）

要件 T5-09 は「Router 側の R2/R3 到達回数」の独立計数を求めるが、
**`src/http/app.ts` にログ・カウンタ・stdout イベントは 0 件**（親が確認）。
Router が stdout に出すのは起動行 1 行のみ（`src/main.ts:205`）。

上流の `payCalls` だけでは不十分: Router が R3 を受けて 4xx で弾いた場合も
`payCalls === 0` になるため、**chat が誤って R3 を送っていても green になる**すり抜けが生じる。

**対策**: `tests/fixtures/router-calls-proxy.ts`（新規）を追加。
chat → proxy → Router の loopback プロキシで、**method + path 別の到達回数**を計数し
`/calls` で返す（既存 fixture と同形）。chat には proxy の origin を canonical として渡し、
§1.3 のポート一致は **proxy の origin** に対して成立させる。

- 否定系（T5-03a〜03d）は **proxy 計数で R3 到達 0** かつ **上流 `payCalls` 0** かつ
  **facilitator `verifyCalls`/`settleCalls` 0** の三点で確認する。
- proxy は転送のみで body を書き換えない（T5-02 の「無改変」を壊さない）。

### 1.5 上流 fixture（T5-06）

新規 `tests/fixtures/market-snapshot-server.ts`。既存 `upstream-server.ts` は変更しない
（既存13ファイル150件への影響を出さない）。**argv `--provider a|b` で body を分岐**する
（既存 harness は同一 fixture を 2 プロセス立てる形なので、それに合わせる）。

`market-data.mjs` から読み取った要求形（推測なし。**余剰フィールドは 1 つでも不可**
＝ `keys()` が `Object.keys().sort().join()` の完全一致）:

- descriptor 側（`validateMarketResource`）: キーは `method,providerId,url` の**3個ちょうど**、
  `url.href === url`、query/hash/userinfo 不可、`http:` はホスト `127.0.0.1`/`[::1]`/`localhost` のみ、
  path は `/v1/eth/snapshot`、`method: "GET"`
- top-level: `providerId, market, dataSource, payment, fetchedAt, data`
- `fetchedAt`: `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/` かつ `new Date(x).toISOString() === x`
- **数値の形式**（v1 が落としていた点）: `markPx`/`prevDayPx`/`dayNtlVlm`/`change24h.absolute`/
  `change24h.percent`/`priceUsdcPerWeth` は**文字列**で `/^-?\d+(?:\.\d+)?$/`。
  指数表記・`+`・空白・`.5`・`5.` は不可。`positive` は `!startsWith("-")` かつ `/[1-9]/` を含む
  （`"0"`/`"0.0"` 不可）。`assetIndex`・`feeBps`・`decimals` は **JSON number**。
- **Provider A**（`market-data-a`）: `market{kind:"perpetual",symbol:"ETH",quote:"USD"}`、
  `dataSource{name:"hyperliquid",network:"hyperliquid-mainnet"}`、
  `payment{protocol:"x402",network:"eip155:84532"}`、
  `data{markPx,prevDayPx,dayNtlVlm,change24h{absolute,percent},assetIndex}`
- **Provider B**（`market-data-b`）: `market{kind:"spot-reference",symbol:"ETH",quote:"USDC"}`、
  `dataSource{name:"uniswap-v3",network:"eip155:1"}`、
  `payment{protocol:"mpp",network:"tempo-moderato-42431"}`、
  `data{pool,feeBps:5,feeLabel:"0.05%",blockNumber,sqrtPriceX96,priceUsdcPerWeth,token0,token1,disclaimer}`
  - `pool = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`
  - `blockNumber` 文字列 `/^(0|[1-9]\d*)$/`、`sqrtPriceX96` 文字列 `/^[1-9]\d*$/`（`"0"`・先頭0 不可）
  - `token0 = {address:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, symbol:"USDC", decimals:6}`
  - `token1 = {address:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, symbol:"WETH", decimals:18}`
    （各 `keys` は `address,symbol,decimals` の3個ちょうど）
  - `disclaimer = "pool spot reference, not an executable quote"`

これらは mainnet の実アドレス・実データの**形**だが、fixture が返すのは**固定の合成値**であり
チェーン・実 API に到達しない（U-06 非解決と整合。実 API 到達を主張しない）。
`/calls` 計数口を既存 fixture と同形で持たせる。

## 2. テスト構成

新規 `tests/wire/chat-crossimpl.test.ts`。各ケースは proxy + 実 Router + 新上流 + facilitator +
chat driver（子プロセス）で構成。

| 要件 | 検証方法 | 観測 |
|---|---|---|
| T5-02 | chat `decodeQuote` に Router の実 R2 応答を無改変で通す | driver の decode 成否 |
| T5-03a | 未承認で実行試行 | **proxy R3 到達 0** + payCalls 0 + verify/settle 0 |
| T5-03b | 別 quote への承認 | 同上 + chat `approval_mismatch` |
| T5-03c | `ROUTER_CANONICAL_BASE_URL` を別 origin/path に | 同上 |
| T5-03d | `approvalTtlMs` 極小で期限切れ承認。`decodeQuote` の `deadlineMs > 0 && <= expiresAt*1000` を満たす範囲で設定 | 同上 |
| T5-03e | 承認成功後の 2 回目の承認 | **proxy R3 到達が 1 回のまま** |
| T5-04 | spy payer で 1 回実行 → close → 別プロセスで reopen | chat journal と R4 が同一 `paymentId` で整合 |
| T5-05a | 実鍵・実署名 payer を注入しない | 起動行が `{"label":"T1-synthetic-nopay"}` |
| T5-05b | payer 未注入構成 | `executionAvailability === "source_payer_unconfigured"` |
| T5-07 | BOB の bearer で ALICE の `paymentId` を引く | Router 404 → chat は **`status_unknown`**（後述） |
| T5-08 | `crashBarrier` + `killRouter()` で R3 途中に落とす → reopen | chat が `execution_unknown` を永続、再送 0（proxy 計数） |
| T5-09 | 全否定系 | proxy `/calls` + 上流 `/calls` + facilitator `/calls` を独立取得 |
| T5-10 | `router-contract.mjs` **と `market-data.mjs`** の SHA-256、`PROFILE`/`PROTOCOL` をピン留め | 不一致で明示的失敗 |
| T5-11 | dir `0o700`・`realpathSync`・create 時空・ロック保持中の二重 open | fail-closed |

**T5-07 の訂正**: chat 側は 401/403/429 のみを `router_access_denied` に写し、
**404 は `status_unknown`** になる（`router-execution.mts:139,187-188`）。
要件 T5-07 の「`router_access_denied` 相当」という文面は実装と食い違うため、
**本設計では「Router が 404 を返し所有者以外に存在を明かさない／chat 側は `status_unknown` として
安全に失敗する」を検証対象とする**。これは要件 §3 の分岐3（差分を記録して据え置き）に該当し、
Router も chat も変更しない。

**T5-10 の拡張**: T5-06 の適合先は `market-data.mjs` なので、`router-contract.mjs` だけを
ピン留めすると `market-data.mjs` の変更が沈黙する。両方をピン留めする。

## 3. 差分検出時の扱い

要件 §3 の3分岐に従う。設計時点で判明している差分:
- T5-06（上流 body プロファイル）→ **分岐1**（テスト fixture のみ）
- T5-07（404 → `status_unknown`）→ **分岐3**（据え置き記録）

`src/**` に触る必要が生じた場合は**実装を止めて要件・設計ゲートに戻す**。

## 4. 変更対象ファイル（allowed file set）

1. `tests/wire/chat-crossimpl.test.ts`（新規）
2. `tests/fixtures/market-snapshot-server.ts`（新規）
3. `tests/fixtures/chat-router-driver.ts`（新規）
4. `tests/fixtures/chat-crossimpl-harness.ts`（新規）
5. `tests/fixtures/router-calls-proxy.ts`（新規・§1.4）
6. `README.md`（到達点と未達の区別）

**変更しないもの**: `src/**`（製品コード）、chat worktree、既存 fixture
（`loopback.ts`・`upstream-server.ts`・`facilitator-server.ts`・`router-harness.ts`）、
既存テスト、`tsconfig.json`。

**`vitest.config.ts` について**: 現在 `testTimeout` 未設定＝既定 5000ms。T5 の 1 ケースは
proxy + facilitator + 上流 + Router + driver の多段起動（+ SIGKILL + 再起動）で 5s を超える。
**設定ファイルは変更せず、`it(名前, fn, timeout)` の第3引数でケース単位に延長**する。
これで `vitest.config.ts` を allowed file set に入れずに済む。

上記以外の変更が必要と判明した場合は**停止して報告**する。

## 5. 未解決・リスク

- chat worktree は別オーナーが作業中。**本テストが検知するのは触る契約面に限る**
  （`ui.js`・`server.mts` の変更は沈黙しうる）。T5-10 の2ファイルピン留めで部分補完。
- 空きポート確保と listen の間の競合（TOCTOU）は残る。再試行せず失敗させる方針で偽陽性を避ける。
- chat 側 `startRouterMarketChat`（HTTP 層）と実 UI（ブラウザ）は範囲外（要件 §4）。
- 本設計は AC-7 を達成しない（支払いレグ無し。要件 §1 に明記）。
