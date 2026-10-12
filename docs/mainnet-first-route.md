# mainnet の最初の 1 経路（限定実証）— 要件・設計・記録（第 4 版、2026-10-10）

> **第 4 版（案 B、実施済み）**: 第 3 版まで（x402 で払って MPP 専用の provider へ）は、Router の安全条件を満たす MPP 専用の provider が無く中止した（§3 の記録）。owner の決定（2026-10-10「B で良いと思います」）で向きを戻し、**Tempo mainnet の USDC.e を MPP で払う agent が、x402 しか受けない第三者の API を使う**ことを、owner の Mac の loopback 限定の Router で実証した。**結果: `delivered`**（§3）。
>
> 第 1〜3 版の経緯は §4 のレビューの記録と §3 の時系列に残す。

## 0. 経路（実施した構成）

| 項目 | 値 |
|---|---|
| 受信（agent が払う） | **Tempo mainnet** `eip155:4217` の USDC.e `0x20C000000000000000000000b9537d11c60E8b50`（6 桁）を MPP `tempo/charge`（push。手数料も USDC.e で払われた。receipt で確認）。受取先は owner の受信 wallet `0x9b10…F8a2`。facilitator は不要（Router が RPC で照合） |
| 送信（Router が払う） | **Base mainnet** `eip155:8453` の USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`（6 桁、EIP-712 domain `USD Coin`/`2`）を x402 `exact`（EIP-3009）で。gas は上流側の facilitator |
| 上流 | `https://crypto.apitoll.cloud/v1/crypto/price`（x402 のみを受ける第三者の価格 API。Base mainnet と Solana の offer。GET、クエリ不要、`resource.url` が要求 URL と一致、`extra` は `name`/`version` だけ、`maxTimeoutSeconds` 300）。動的プロファイル **`dyn-mpp-to-x402-mainnet`** で caller が URL を指定 |
| 価格 | 上流 1,000（$0.001）+ Router 手数料 1,000（`{flat 1000}`）= caller が 2,000 base units（0.002 USDC.e）を払う。動的の予約は受信 2,000・送信 1,000、区分の `maxPerPurchase` 20,000、`maxTotal` 60,000（$0.06） |
| 入口 | `SUBETHA_MAINNET_FIRST_ROUTE=1 tsx tools/remote-mcp.ts`（**`bind 127.0.0.1` 固定**、journal は別パス。`hostPlanOf` の mainnet 専用の分岐）。MCP は hosted と同じ 5 tool |
| caller の署名 | `tools/mpp-payer.ts`（`npm run sign` と同じ経路）で Tempo mainnet に送金し、`tools/sign-run.ts` と同じ封筒（`{x402Version: 2, accepted: offer, payload: {challengeNonce, credential}}` の base64）を `purchase` の `credential` に渡す |
| 静的 route | `md-coingecko-price` は `router.routes` を空にできない規則のための placeholder（静的の上流はクエリを持てず、CoinGecko はクエリ無しだと 422 なので購入には使わない） |
| 鍵 | caller = 本実証のために作った Tempo 用の鍵（`0x4460…9515`、owner が Stargate で USDC.e $2 を入金）。Router の送信用 = 本実証のために作った Base 用の鍵（`0x5cb0…DC3D`、owner が USDC $1 を入金）。**本番の鍵は使っていない** |

## 1. 要件（第 4 版）

- FR-M1: 表（`KNOWN_NETWORKS`）に Base mainnet（x402 受信・送信、kind `x402`）と Tempo mainnet（MPP 受信・送信、USDC.e）を加える（末尾に追加。既存の 4 件と検証は不変。payer の vendor を同期）。
- FR-M2: 設定生成に **mainnet 専用モード**（`HostOptions.mainnetFirstRoute: true`、起動は env `SUBETHA_MAINNET_FIRST_ROUTE=1`）を加える。別関数 `mainnetFirstRouteConfigOf` で、公開の生成 `routerConfigOf` には触れない。静的 route 1 本（placeholder）、動的プロファイル `dyn-mpp-to-x402-mainnet` 1 本、予算の区分（静的 30,000/10,000、動的 60,000/20,000）、`x402.upstreams`。子 process の env は x402 送信の鍵と `SUBETHA_X402_OUTBOUND_NETWORK=eip155:8453`、MPP 受信の秘密（`SUBETHA_MPP_INBOUND_SECRET`。無ければ起動しない）、`ROUTER_MPP_INBOUND_RPC_URL`（既定 `https://rpc.tempo.xyz`、`SUBETHA_TEMPO_MAINNET_RPC_URL` で上書き）、多レール none。MPP 送信の鍵・facilitator・多レールの鍵は渡さない。**モードを指定しない生成は byte 単位で今と同じ**（golden 比較）。
- FR-M3: Router の process は `SUBETHA_X402_OUTBOUND_NETWORK`（省略時 `eip155:84532`）で x402 送信（`evmSigning`）の network を決める。表に無い・x402 送信の無い・EVM でない network は起動しない（`x402_network`）。
- FR-M5: `npm run sign` は表の追加だけで Base mainnet の offer を `x402-evm` に分類できる（試験）。caller 側の MPP の署名（`tools/mpp-payer.ts`）は変えない: `tempo.charge` の `feeToken` option は `mppx@0.11.0` が読まない（readback R-4 #1）ので足さず、手数料が転送する資産（USDC.e）で払われることは on-chain の receipt で確認した（§3。USDC.e だけを持つ wallet で払えた）。
- FR-M7（成功の定義）: (1) client が `delivered` と JSON の本文を受け取る、(2) `status` の読み直しが同じ、(3) 受信の Tempo tx と送信の Base tx が explorer で確認でき、受領の receipt が送った tx と一致する、(4) 本文が上流の内容である。
- SR-M1: 既存の安全性（承認・fingerprint・予算・SSRF・1 支払い 1 署名・push 固定・許可リスト・`resource.url` の束縛・読み直しの一致）を緩めない。本実証で**一切緩めていない**（Pinata と CoinGecko が使えなかったのはこの条件のため）。
- SR-M2: 鍵・URL（認証付き RPC）・`ownerKey` を文書や PR に出さない。
- SR-M3: 公開の Router（hosted）は本変更で変わらない（golden 比較、配備なし）。
- **前提条件の扱い**: `docs/dynamic-upstream-requirements.md` §7 が mainnet の前提条件とした返金方針・資産の組の見直し・規制の整理は**未充足のまま**であり、本実証は「loopback 限定・両側とも owner の資金・動的の予約で $0.06 まで・プロファイル 1 本・実施後に停止」という**限定された例外**として行った。公開運用の根拠にしない。送信の x402 に gas の予約は無く（facilitator が払う）、`maxTotal` は受信・送信の額の上限であって wallet の支出の厳密な上限ではない。

削除した要件: 第 2〜3 版の FR-M4（Tempo の能力の RPC の chain id の起動時の検査）と `SUBETHA_TEMPO_CHAIN_ID` は、案 B では mainnet の process に Tempo の送信の能力が無い（受信は RPC の照合だけ）ため不要になり、実装から外した。Tempo mainnet への MPP 送信を将来有効にするときは、readback R-3 #1（答えが無い RPC を通さない厳密な検査）の要求を満たす形で入れる。第 2〜3 版の FR-M6（PayAI の settle）も、案 B の受信は MPP で facilitator を使わないため前提から外した（記録は §3 に残す。PayAI の互換性は確認済み。差し替えの env も削除）。

## 2. 設計の要点（実装した差分）

- `src/shared/networks.ts`: 2 件追加（末尾）。`packages/payer/src/vendor/networks.ts` を同期。
- `tools/remote-mcp-config.ts`: `MAINNET_FIRST_ROUTE` と `mainnetFirstRouteConfigOf(env, receiver)`。
- `tools/remote-mcp.ts`: `HostOptions.mainnetFirstRoute`、`hostPlanOf` の分岐（loopback 以外は拒否、秘密が無ければ拒否）、`start()` の env `SUBETHA_MAINNET_FIRST_ROUTE=1`（journal `runtime/mainnet-first-route.ndjson`、`SUBETHA_MAINNET_JOURNAL_PATH` で上書き）。
- `tools/rails-entry.ts`: `SUBETHA_X402_OUTBOUND_NETWORK`（表で検証）、`ProcessEntryError("x402_network")`。`tools/real-mpp-capability.ts`: chain ごとの公開 RPC の既定（`defaultTempoRpcUrl`）。
- 試験: `tests/unit/config-golden.test.ts`（origin/main のコードで生成した `tests/fixtures/config-golden/{public,none}.json` と **値まで完全一致**。mainnet の env を与えても不変）、`tests/unit/mainnet-first-route.test.ts`（mainnet 専用の生成が本番の読み込みを通る、bind と秘密の拒否、認証付き RPC の秘匿、x402 送信の network）、`tests/unit/network-table.test.ts`・`tests/unit/sign-classify-evm.test.ts`・`tests/unit/shared-extraction.test.ts`（表）。

## 3. 記録

- 2026-10-10 06:4xZ: PayAI `/verify` に Router と同じ形の credential（Base Sepolia、使い捨ての鍵）を送り `isValid: true`。x402.org でも同じ。送金なし。
- 2026-10-10: Tempo mainnet RPC（`rpc.tempo.xyz`）の `eth_chainId` は `0x1079`（4217）、`eth_fillTransaction` は応答する。
- 2026-10-10: owner が Base 用の wallet（`0x5cb0…DC3D`）に Base mainnet USDC 1.00、Tempo 用の wallet（`0x4460…9515`）に Tempo mainnet USDC.e 2.00（Stargate）を入金。読取で確認。
- 2026-10-10 07:3xZ: MPP catalog（`https://mpp.dev/api/services`）を取得: 129 サービス、そのうち `methods` に `tempo` だけを載せるものが 118（directory の表示であって、他の決済方式を拒むことの確認ではない）。保存した抜粋は `docs/evidence/mpp-catalog-2026-10-10.json`。
- 2026-10-10 07:1xZ（案 A・x402 → MPP 専用の検討。中止）: MPP catalog の Tempo 専用・GET・$0.01 以下のエンドポイント 55 件を 402 の読取で機械的に調べ、Router の条件（x402 を併用しない、受取先が安定、USDC.e、`methodDetails` に余計な項目が無い）を満たすものは **0 件**。Pinata は **402 ごとに受取先が変わる**（10 秒で 3 つ）ため、Router の「購入直前の読み直しで条件が 1 つでも違えば決済の前に止める」安全装置に必ず掛かる。Tempo 運営の proxy（`*.mpp.tempo.xyz`）は pathUSD と `machineTokenEnabled` で許可リストに合わない。StableTravel は適合するが x402 も受ける。
- 2026-10-10 FR-M6（PayAI の settle、案 A の前提。参考記録）: ローカルの Router（testnet の公開構成、loopback、facilitator を PayAI に差し替え、送信は faucet の pathUSD を持つ新しい鍵、受取先は新しいアドレス）で `md-mpp-eth-snapshot` を使い捨ての Sepolia の鍵で購入: `delivered`（5.6 秒）、受信 tx `0xbfbdfe3e…4166`（Base Sepolia、settle は PayAI の口座 `0xc669…cb63` から）、送信 tx `0xd21ef1d2…9f80`（Tempo testnet）。PayAI の `/settle` は Router の wire と互換。
- 2026-10-10 07:4xZ（案 A の Pinata の見積もり。購入せず）: mainnet 専用の Router を loopback で起動（当時の構成）、`quote_url`（Pinata の CID）で見積もりは取れた（上流 $0.001 + 手数料 $0.001、gas の上限 884）が、上記の受取先の問題で購入に進まず失効させた。資金は動いていない。
- 2026-10-10 07:5xZ（案 B）: CoinGecko（`/x402/simple/price?ids=…`）は **402 の `resource.url` がクエリ無し**で、Router の「要求した URL との完全一致」（`docs/dynamic-upstream-design.md` §3.2・§11 の資源の束縛）を満たせず `offer_unavailable`。束縛は緩めず、設計時の調査（同 §4）で互換が確認されていた x402 専用の実在 API 5 件（Base mainnet、GET、クエリ不要）を 402 の読取で再確認し、`crypto.apitoll.cloud/v1/crypto/price`（$0.001、`extra` は `name`/`version` だけ）を選択。
- 2026-10-10 08:00Z（1 回目。**失敗**、資金は owner の wallet 間で移動）: owner が条件（上流 URL、受取先、$0.001 + $0.001、USDC.e、署名で資金が動く、返金なし）を承認。見積もりを取り直して条件の完全一致を機械的に確かめ、caller が Tempo mainnet で 2,000 base units（0.002 USDC.e）を受信 wallet `0x9b10…F8a2` に送金（tx `0x99c0dd5d…0282`、手数料 178 base units = 0.000178 USDC.e）。**`purchase` は `invalid_payment_header`（400）で拒否**: 私（親）が MPP の wire の credential を Router の封筒に包まずに渡した誤り（`tools/sign-run.ts` は包む）。Router は何も払っていない。失効した quote は再提出できず、この 2,000 base units（0.002 USDC.e）は owner の受信 wallet に残る（owner 自身の wallet 間の移動で**元本の損失は無し**。Tempo の取引手数料 178 base units（0.000178 USDC.e）は消費された）。原因が分かるまで追加の送金はしなかった。
- 2026-10-10 08:0xZ（2 回目。**成功**）: 同じ条件で見積もりを取り直し（quoteId `l7ObTtC7…ryc`、paymentId `ddfea611-22e7-4852-9524-42dad3a098ac`、期限 08:06:21Z）、caller が 2,000 base units（0.002 USDC.e）を送金（受信 tx **`0x4ea7d6c29070ad7d701c9ffcbbc74529981f4e689c02369cc58006f44495a0b8`**、Tempo mainnet block 43458585、手数料 29 base units = 0.000029 USDC.e、finalized）、封筒に包んだ credential で `purchase` → **`delivered`**（5.5 秒）。Router が Base mainnet で 1,000 base units（0.001 USDC）を上流の受取先 `0x3dA4…4664` に支払い（送信 tx **`0x699cd8f2f432e318078a60fe0dcd0465fee24d2651287101fff1f07a0673e71a`**、block 52414821、送出は上流の facilitator `0x64cc…1f0a`、receipt あり）。本文は `application/json` の object（BTC / ETH / SOL の価格、`asOf 2026-10-10T07:56:26Z`）。`status`（`ownerKey`）の読み直しも `delivered` / `paid`。手数料は USDC.e で払われた（receipt の `0xfeec…` への Transfer 29 base units。`feeToken` の指定なしで、wallet が持つ唯一のトークンが使われた）。残高: caller 2.000000 → 1.995793 USDC.e、受信 wallet 0 → 0.004000 USDC.e（2 回分）、Router の送信用 1.000000 → 0.999000 USDC。Base の finality は下の行。
- 2026-10-10 08:10:38Z: Base mainnet の送信 tx の block 52414821 が `finalized`（finalized block 52414834。公開 RPC の読取）。受信の Tempo tx は 08:0xZ の時点で finalized。これで FR-M7 の (1)〜(4) をすべて満たした。
- 2026-10-10 08:1xZ: ローカルの mainnet Router を停止。journal と quote の記録は ignored の `.claude_workflow/local/mainnet-route/` に保存。
- **2026-10-13 20:36Z（第 2 の経路、POST 本文つき上流 = Exa。成功）**: `docs/dynamic-upstream-post-design.md`（PR #173）の後、同じ構成（loopback の mainnet Router、プロファイル `dyn-mpp-to-x402-mainnet`、caller の Tempo 鍵 `0x4460…9515`、Router の Base 鍵 `0x5cb0…DC3D`）で、**Exa の検索 API**（`POST https://api.exa.ai/search`、本文 `{"numResults":3,"query":"AI agents paying for APIs with USDC: x402 and MPP","type":"fast"}`、本文の sha256 `1d03676b…ac07`、x402 のみ、Base mainnet USDC 7,000 = $0.007、受取先 `0x6d6E…9192`、`extra` に `breakdown`/`totalUsd`/`acceptId`）を URL と本文の指定で購入した。見積もり（quoteId `GAGj6F9e…CPh4`、paymentId `f6f47154-bf35-41f0-827c-2d135886b39d`、期限 20:45:54Z）→ owner が条件（URL・本文・7,000 + 1,000 = 8,000 USDC.e・受取先・署名で資金が動く・返金なし）を chat で承認 → `npm run sign`（Tempo mainnet で 8,000 base units = 0.008 USDC.e を受信 wallet `0x9b10…F8a2` へ送金、受信 tx **`0x7ab25ff53cf3e88f7b4cb4cdde57bf4a6405c34e3eb0707380853a8e0b5646d7`**、block 43844686、`status 0x1`）→ `purchase` → **`delivered`**（3 秒）。Router が Base mainnet で 7,000 base units を Exa に支払い（送信 tx **`0x3ab9b229b879f147754312e50385ce79078a331268ee4ccdcc80212ba3a94558`**）、本文は Exa の検索結果 3 件（`results[].url`: alchemy.com の「x402 vs MPP」、agent402.tools、docs.celo.org）の `application/json`。`status`（ownerKey つき）は同じ投影（`upstream.method: POST`、`upstream.body`、`bodySha256`、両 tx）。記録は ignored の `.claude_workflow/local/mainnet-route/`（journal・quote の控え）。hosted Router は未配備のまま（SR-M3）。

## 4. 独立レビューの記録

| # | 日付 | reviewer | 結果 |
|---|---|---|---|
| R-1 | 2026-10-10 | `gpt-6-astra`（read-only。第 1 版） | **CHANGES_REQUIRED**（8 点: owner 限定の境界が無い、上限の数値、子 process の RPC の配線、能力の移行の漏れ、RPC の chain の検査、byte 一致の証明、PayAI の settle、Pinata の配信内容）。**第 2 版で反映** |
| R-2 | 2026-10-10 | `gpt-6-astra`（readback。第 2 版） | **CHANGES_REQUIRED**（4 点: 静的 MPP 送信の `_mppx_scope`、gas が `maxTotal` に含まれない、PayAI の失敗の分類、HEAD では JSON object を確かめられない）。**第 3 版で反映** |
| R-3 | 2026-10-10 | `gpt-6-astra`（第 3 版と実装の差分） | **CHANGES_REQUIRED**（3 点: 答えが無い RPC を通す chain 検査、settle の失敗の分類の試験、golden の scrub が値の入れ替えを隠す）。**第 4 版で反映**: chain 検査と `SUBETHA_TEMPO_CHAIN_ID` は案 B で不要なので削除（将来の MPP 送信の mainnet 化で厳密版を入れる）、PayAI は案 B の経路外（差し替えの env も削除）、golden は値まで完全一致 |
