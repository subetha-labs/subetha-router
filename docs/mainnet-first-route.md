# mainnet の最初の 1 経路（限定実証）— 要件と設計（第 3 版、2026-10-10）

> **第 3 版**: readback R-2（CHANGES_REQUIRED 4 点）を反映。静的 route の送信 adapter は challenge の `_mppx_scope` を要求し、Pinata の challenge はそれを持たない（読取で確認）ので、実証は **動的プロファイル `dyn-x402-to-mpp-mainnet`**（scope は任意扱い、予約に gas の上限を含む、Tempo mainnet の RPC は `eth_fillTransaction` に応答することを読取で確認）で行う。静的 route `md-pinata-json` は `router.routes` を空にできない規則のために残すが、quote で拒まれ資金は動かない。CID は GET で取得して JSON object（340 バイト、BAYC #0 の metadata）であることを確認し、bytes を保存した。PayAI の settle の応答の分類は既存の adapter の試験が担い、FR-M6 は正常系を Router 経由で確かめる。

> **第 2 版**: 独立レビュー R-1（`gpt-6-astra`、CHANGES_REQUIRED 8 点）を反映。最大の変更は **hosted Router に出さない**こと: mainnet は owner の Mac で同じ Router を **mainnet 専用の設定・loopback 限定**で起動して実証する（R-1 #1 の owner 限定の境界）。これにより chain ごとの能力（第 1 版 §2.3）と配備・rollback は不要になり、公開の Router は一切変わらない。
>
> owner の決定（2026-10-10）: Colosseum 提出（締切 10/13 15:59 JST）に向け、**x402 で払う agent が MPP 専用の provider を使える**ことを mainnet で 1 件だけ実証する。期限は **10/12 昼（JST）**。資金は両側とも owner 自身の wallet で $1〜2 程度。

## 0. 経路

| 項目 | 値 | 根拠 |
|---|---|---|
| 受信（agent が払う） | **Base mainnet** `eip155:8453` の USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`（6 桁、EIP-712 domain `USD Coin` / `2`）を x402 `exact` で。受取先は owner の受信 wallet（本番の `SUBETHA_ROUTER_RECEIVER` と同じアドレス） | CoinGecko の 402（2026-10-10 読取）と同じ条件 |
| 受信の facilitator | **PayAI** `https://facilitator.payai.network`（kind `x402`。`/supported` に `x402Version 2`・`exact`・`eip155:8453` と `eip155:84532`。API key 不要、受取 wallet ごとに 1,000 件の無料枠）。Router と同じ形の credential を `/verify` に送って `isValid: true` を得た（Base Sepolia、2026-10-10） | `/supported`・`/verify` の読取 |
| 送信（Router が払う） | **Tempo mainnet** `eip155:4217` の USDC.e `0x20C000000000000000000000b9537d11c60E8b50`（6 桁）を MPP `tempo/charge` の **push** で。手数料も USDC.e。送信用の鍵は **この実証のために新しく作る**（本番の鍵と共用しない。R-1 #5 の懸念を減らす） | Pinata の 402: `amount`、`currency` USDC.e、`methodDetails {chainId: 4217}` のみ |
| provider | **Pinata**（`https://mpp.pinata.cloud/v1/pin/public/<cid>`、GET、API key 不要、MPP on Tempo mainnet のみ）。**動的プロファイル** `dyn-x402-to-mpp-mainnet` で caller が URL を指定する（第 3 版。静的は `_mppx_scope` が無く使えない）。受取先（`recipient`）は CID ごとに違う（pin した人への支払い。読取で 2 つの CID で確認）ので 402 から読む | `docs.pinata.cloud/files/mpp/overview`、catalog `first-party`、mpp.ts:151 / mpp-dynamic.ts:229 |
| 取得物 | CID **`Qmc5UM1ZBbb9ZNvsk8sqYxNxqEyXtrve2zRUGbuwBYkGeS`**（BAYC #0 の metadata JSON。公開 gateway の GET で `application/json`、340 バイト、JSON object を確認し bytes を保存。Pinata の 402 は `amount 1000`（$0.001）、`currency` USDC.e、`chainId 4217`、`recipient 0x2959…88f7`） | R-2 #4 |
| 入口 | owner の Mac で `SUBETHA_MAINNET_FIRST_ROUTE_CID=<cid> tsx tools/remote-mcp.ts`（**`bind 127.0.0.1` 固定**、mainnet 専用モード、journal は別パス）。agent（Claude Code）は `http://127.0.0.1:<port>/mcp` を登録し `subetha_router_quote_url`（`dyn-x402-to-mpp-mainnet`、Pinata の URL）→ owner が subject を確認して承認 → `npm run sign` → `purchase`（quote 文書ごと）→ `status`（`ownerKey`） | hosted と同じコード・同じ MCP |
| 価格と上限 | 上流 1,000（この CID。上限 `maxUpstreamAmount` 10,000）+ Router 手数料 `max(1000, gas の上限)`。動的の予約は受信側 = 上流 + 手数料、送信側 = 上流 + gas の上限（`src/core/dynamic.ts`）で、区分の `maxPerPurchase` は既存の動的と同じ 20,000、`maxTotal` は **60,000**（$0.06。1〜2 件分）。`SIGN_MAX_AMOUNT` 20,000 ≥ 1,000 + 手数料。静的の区分（30,000 / 10,000）は使われない | R-1 #2・R-2 #2 |

## 1. 要件

- FR-M1: 表（`KNOWN_NETWORKS`）に Base mainnet（x402 受信・送信、kind `x402`）と Tempo mainnet（MPP 受信・送信、USDC.e）を加える。既存の 4 件と検証は変えない。payer の vendor を同期する（payer の挙動は変わらない）。
- FR-M2: 設定生成に **mainnet 専用モード**（`HostOptions.mainnetFirstRoute?: { cid: string }`）を加える。このモードでは: 静的 route は `md-pinata-json` の 1 本（規則上の placeholder。quote で拒まれる）、**動的プロファイル `dyn-x402-to-mpp-mainnet` 1 本**（`dyn-x402-to-mpp` と同じ形で network だけ mainnet。`fee` は既存の `{flat 1000}`、`feeAsset` USDC.e、`maxFee`・`feeMargin` は既存の値）、予算の区分は静的 2 つ（30,000 / 10,000）と動的 2 つ（60,000 / 20,000）、`x402.inboundFacilitators` に `eip155:8453 → PayAI`、`upstreams` に Pinata の URL、`denyHosts` は env の分だけ。子 process の env は `SUBETHA_TEMPO_RPC_URL`（mainnet。既定 `https://rpc.tempo.xyz`）、**`SUBETHA_TEMPO_CHAIN_ID=4217`**（新設）、`ROUTER_MPP_INBOUND_RPC_URL` は渡さない（MPP 受信なし）、`SUBETHA_RAILS_ACTIVATION` は none。**モードを指定しない生成は byte 単位で今と同じ**（golden 比較で証明。R-1 #6）。
- FR-M3: Router の process は `SUBETHA_TEMPO_CHAIN_ID`（省略時 42431）で Tempo の能力の chain を決め、`createRealMppCapability(key, { chainId, rpcUrl })` に渡す。`dependencyUrls`（拒否ホスト）には渡した RPC を入れる。起動時の案内（`remote-router-process.ts`）は chain id も出す（URL は出さない）。
- FR-M4: 起動時に Tempo の能力（kind `real-key`）の RPC へ **読取だけの `eth_chainId`** を 1 回送り、能力の `chainId` と一致しなければ `ConfigError` で起動しない（R-1 #5。testnet でも同じ検査が走る。fixture の能力は対象外）。
- FR-M5: `npm run sign` は表の追加だけで Base mainnet の offer を `x402-evm` として署名できる（試験済み）。
- FR-M6（前提）: **PayAI の `/settle` を Router 経由で Base Sepolia で 1 件確かめる**（R-1 #7）: 設定生成の env `SUBETHA_X402_INBOUND_FACILITATOR_URL`（新設。省略時は今の x402.org）で facilitator を差し替え、ローカルの Router（testnet の公開構成、loopback）で `md-mpp-eth-snapshot` を使い捨ての鍵で購入し、`delivered` と両レグの tx を得る。これが通らなければ mainnet に進まない。settle の応答の分類（不正な形・network の不一致・tx 無し・timeout 後の `unknown`、自動再試行なし）は facilitator に依らない adapter の性質で、既存の unit 試験（`src/adapters/inbound/x402.ts` の試験と `tests/unit/dynamic-core.test.ts` の「昇格後の settle の拒否は unknown」「クラッシュ点ごとの再起動後の状態」）が担う（R-2 #3）。
- FR-M7: 成功の定義（R-1 #8）: (1) client が `delivered` と JSON の本文を受け取る、(2) `status` の読み直しが同じ、(3) Base の inbound tx（PayAI の settle）と Tempo の outbound tx（Pinata への USDC.e）が explorer で確認でき、受領の receipt が送った tx と一致する、(4) 取得した本文が CID の内容と一致する。
- SR-M1: 既存の安全性（承認・fingerprint・予算・SSRF・1 支払い 1 署名・push 固定・許可リスト）を緩めない。mainnet 用の例外を作らない。
- SR-M2: 鍵・URL（認証付き RPC）・`ownerKey` を文書や PR に出さない。
- SR-M3: 公開の Router（hosted）は本変更で**一切変わらない**（golden 比較、配備なし）。
- **前提条件の扱い（R-1 #1・R-2 #2）**: `docs/dynamic-upstream-requirements.md` §7 が mainnet の前提条件とした返金方針・資産の組の見直し・規制の整理は**未充足のまま**であり、本実証は「loopback 限定・owner の資金のみ・動的の予約（gas の上限を含む）で $0.06 まで・プロファイル 1 本・実施後に停止」という**限定された例外**として行う。送信の gas は予約の上限（`maxFee` 50,000 = $0.05）までしか見積りに含まれず、`maxTotal` が wallet の支出の厳密な上限ではないことも記録する。公開運用の根拠にしない。

## 2. 設計

### 2.1 表（`src/shared/networks.ts`）— 実装済み（本 PR）

Base mainnet（`USD Coin`/`2`）と Tempo mainnet（USDC.e）の 2 件。試験: `tests/unit/network-table.test.ts`（mainnet のプロファイルが本番の表で通り、向きが違えば拒む）、`tests/unit/sign-classify-evm.test.ts`（Base mainnet は `USD Coin` で分類、`USDC` では拒否）。

### 2.2 設定生成（`tools/remote-mcp-config.ts`・`tools/remote-mcp.ts`）

- `routerConfigOf` に新しい引数は足さず、**別関数 `mainnetFirstRouteConfigOf(env, receiver, cid)`** を作る（公開の生成関数に触らない。R-1 #6）。中身: 定数 `MAINNET_FIRST_ROUTE = { inbound: {network 8453, asset, facilitator PayAI}, outbound: {network 4217, asset USDC.e, payTo <Pinata の recipient。402 から>}, upstream: "https://mpp.pinata.cloud/v1/pin/public/" }`。Pinata の `recipient` は 402 で読んだ値を定数に置き、起動後の最初の購入で 402 の `recipient` と一致しなければ Router が従来どおり `quote_inconsistent` 相当で拒む。
- `hostPlanOf(options, env)`: `options.mainnetFirstRoute` があればこの関数で `config` を作り、`childEnv` は mainnet 用（上の FR-M2）。無ければ今までどおり。
- `SUBETHA_X402_INBOUND_FACILITATOR_URL`（env、省略時 `INBOUND.facilitator`）を `ROUTER_X402_INBOUND_FACILITATOR_URL` に渡す（FR-M6 の testnet 確認用。公開の起動では設定しないので golden は変わらない）。

### 2.3 process（`tools/rails-entry.ts`・`tools/real-mpp-capability.ts`・`tools/remote-router-process.ts`）

- `routerProcessCapabilitiesOf`: `SUBETHA_TEMPO_CHAIN_ID` を読み（整数、省略時 42431）、`createRealMppCapability(mppKey, { chainId, rpcUrl })`。`rpcUrl` 省略時の既定は chain に応じて `tempoMainnet` / `tempoModerato` の公開 RPC（`real-mpp-capability.ts` の既定を chain で選ぶ）。
- `remote-router-process.ts` の案内に `tempo chain: <id>` を足す。

### 2.4 起動時の chain の検査（`src/main.ts`）

- `capabilities.mppTempo.kind === "real-key"` のとき、`startupChecks` に「`getClient({chainId})` の `getChainId()`（読取 1 回）が `chainId` と一致」を足す。不一致は `ConfigError("the Tempo RPC reports chain <x>, capability is for <y>")`。試験: fake の transport が別の chain id を返す能力で `composeRails`/起動が止まる。

### 2.5 試験

- `tests/unit/config-golden.test.ts`（新規）: `tests/fixtures/config-golden/{public,none}.json`（**origin/main のコードで生成**した `hostPlanOf` の `config` と `childEnv` の鍵と値。秘密は固定の fixture 値）と現在の生成が **完全一致**。mainnet の env（`SUBETHA_TEMPO_CHAIN_ID` など）を与えても公開の生成は変わらない。
- `tests/unit/remote-mcp-config.test.ts`: mainnet 専用モードの `hostPlanOf` → route 1・dynamic 無し・facilitator の表・予算 2 区分・`childEnv` の `SUBETHA_TEMPO_CHAIN_ID` と RPC、`loadRuntimeConfig`（real + `KNOWN_NETWORKS`）を通る。
- `tests/unit/rails-entry.test.ts`: `SUBETHA_TEMPO_CHAIN_ID=4217` で能力の `chainId` 4217、`getClient({chainId: 42431})` を拒否、`dependencyUrls` に mainnet RPC。省略時は 42431。
- `tests/unit/compose-rails.test.ts`（or 新規）: chain id の検査。
- sabotage: 検査を外す／chain id の env を無視する／公開の生成に mainnet の区分を混ぜる、のそれぞれで落ちる。

### 2.6 手順

1. 親: 本書 v2 の readback（Codex）→ 実装 PR → 差分レビュー → merge。
2. 親: FR-M6（PayAI の settle、Base Sepolia、ローカル）。使う鍵: caller は既存の使い捨て Sepolia 鍵、Router の送信用は新しい鍵に Tempo testnet の faucet で pathUSD、受取先は新しいアドレス。
3. owner: (a) caller の使い捨て wallet（`npm run wallet:new`）に Base mainnet の USDC $1、(b) Router の送信用の新しい wallet（親が作り、アドレスだけ渡す）に Stargate で Base → Tempo に $2（USDC.e で届く）、(c) Pinata で小さな JSON を pin して CID を渡す（アカウントが無ければ親が公開 gateway で条件を満たす既存の CID を探す）。
4. 親: CID の `Content-Type`・サイズを gateway の HEAD で確認。Pinata の 402 の `recipient` を定数に入れる。
5. owner の Mac で mainnet 専用モードの Router を loopback で起動 → Claude Code に登録 → quote → **owner が subject を確認して承認** → sign → purchase → status。証拠を保存。
6. Router を停止。記録を本書 §3 と `docs/public-brief` に追記。残った USDC.e と USDC は owner の wallet に残る（回収は任意）。

### 2.7 時間と中止

実装と試験 3〜4 時間、FR-M6 1 時間、owner の資金と CID の用意（並行）、実証 1 時間。**10/12 12:00 JST までに 5 が終わらなければ中止**（公開の Router には何も影響しない）。

## 3. 記録（実施後に追記）

- 2026-10-10: PayAI `/verify` に Router と同じ形の credential（Base Sepolia、使い捨ての鍵）を送り `isValid: true`。x402.org でも同じ。送金なし。
- 2026-10-10: Tempo mainnet RPC（`rpc.tempo.xyz`）の `eth_chainId` は `0x1079`（4217）、`eth_fillTransaction` は応答する（残高 0 で revert = method は存在）。Pinata の 402 を 3 つの CID で読取: `methodDetails` は `chainId` だけ、`recipient` は CID ごとに違う。Tempo 運営の proxy（`*.mpp.tempo.xyz`）は通貨が pathUSD で `machineTokenEnabled` を持ち Router の許可リストに合わないので除外。
- 2026-10-10 FR-M6: ローカルの Router（testnet の公開構成、loopback、`SUBETHA_X402_INBOUND_FACILITATOR_URL=https://facilitator.payai.network`、送信は新しい testnet の鍵に faucet の pathUSD、受取先は新しいアドレス）で `md-mpp-eth-snapshot` を使い捨ての Sepolia の鍵で購入: `delivered`（5.6 秒）、受信 tx `0xbfbdfe3e…4166`（Base Sepolia、PayAI が settle）、送信 tx `0xd21ef1d2…9f80`（Tempo testnet、Provider B へ）、`status` の読み直しも `delivered` / `paid`。PayAI の `/settle` は Router の wire と互換。
- 2026-10-10: owner が caller の wallet（`0x5cb0…DC3D`）に Base mainnet USDC 1.00、Router の送信用 wallet（`0x4460…9515`、本実証のために新しく作った鍵）に Tempo mainnet USDC.e 2.00（Stargate）を入金。読取で確認。

## 4. 独立レビューの記録

| # | 日付 | reviewer | 結果 |
|---|---|---|---|
| R-2 | 2026-10-10 | `gpt-6-astra`（readback。第 2 版） | **CHANGES_REQUIRED**（4 点: 静的 MPP 送信の `_mppx_scope`、gas が `maxTotal` に含まれない、PayAI の失敗の分類、HEAD では JSON object を確かめられない）。**第 3 版で反映**（動的プロファイルへ、限界の記録、既存の試験の参照、GET での確認） |
| R-1 | 2026-10-10 | `gpt-6-astra`（read-only。第 1 版） | **CHANGES_REQUIRED**（8 点: owner 限定の境界が無い、上限の数値、子 process の RPC の配線、能力の移行の漏れ、RPC の chain の検査、byte 一致の証明、PayAI の settle、Pinata の配信内容）。**第 2 版で反映**（hosted に出さず loopback 限定の mainnet 専用モードに変更、静的 route 化、golden 比較、chain id の検査、settle の前提化、CID の事前確認） |
