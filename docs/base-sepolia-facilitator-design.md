# 設計: Base Sepolia の決済を自前の facilitator に移す（第 2.1 版、2026-11-26。実装との差を §10 に）

> 要件 `docs/base-sepolia-facilitator-requirements.md`。下敷き `docs/evm-testnets-hosted-design.md`。行番号は main `81db1b3`。**実装はまだしない**（G-B1）。

## 0. 一枚で

- facilitator は今の子 process のまま。有効な network に `eip155:84532` が増える。Router → loopback、Worker → Caddy の経路は今と同じ（Caddy・publish・token・鍵の変更なし）。
- `EVM_TESTNET_NETWORKS` は**広げない**（Router の受信の domain・期限・送信の束ねに効くため）。facilitator と受信の例外だけの集合を別に作る。
- 変更の中身は 5 つ: facilitator の Base 対応（L1 手数料・残高・準備・復帰）、Router の受信の例外と期限、設定生成と有効化、Worker の Base の行と準備の確認、文書。
- 戻せる順に出す: **無効の image を先に**入れ替え（Base の行を読める image = 戻す先）→ P → I。

## 1. 確かめた事実

| 事実 | 場所 |
|---|---|
| 受信の facilitator は `eip155:84532` だけ env `ROUTER_X402_INBOUND_FACILITATOR_URL` が担当し、設定ファイルの表には書けない | `src/config.ts:533,1586`、`src/main.ts:1115-1120` |
| hosted はその env に `INBOUND.facilitator`（x402.org）を入れる | `tools/remote-mcp.ts:341` |
| loopback の例外は `EVM_TESTNET_NETWORKS` の network だけ（受信の静的・動的、送信の静的） | `src/main.ts:316-384` |
| kind `x402` の受信の期限は 10 秒、hosted の新 3 は 20 秒。自前 facilitator の締め切りは新 3 が 10 秒（Ethereum Sepolia は別の値） | `src/adapters/inbound/x402.ts`（`X402_INBOUND_DEFAULT_TIMEOUT_MS`）、`src/shared/networks.ts:211`、`tools/evm-facilitator.ts`（`defaultDeadlinesOf`） |
| Base の送信の有料要求の期限は静的・動的とも 30 秒（Worker の要求全体 26 秒の外側） | `src/adapters/outbound/x402.ts:293`、`x402-dynamic.ts:654` |
| 静的 route は settle の前と送信の前に上流の 402 を読み直し、保存した offer と完全一致を求める | `src/core/orchestrator.ts:1616` |
| 上流の URL は route の指紋に入らない。payTo・資産・金額は入る | `docs/routeconfig-fingerprint-design.md` §2.2 |
| facilitator の累計は `gasUsed × effectiveGasPrice` だけ（L1 の手数料を数えない） | `tools/evm-facilitator.ts`（`settleInLine` の手順 11、`resolveAtStartup`） |
| 保留は起動時の照合でだけ解ける。起動の照合は鍵ごとに 60 秒まで、入口が facilitator の listen を待つ上限も 60 秒 | 同 `start`・`resolveAtStartup`、`tools/remote-mcp.ts:473` |
| 起動時に全 network の chain id を RPC で確かめ、1 つでも失敗すると process が起動しない（入口も終わる） | 同 `viemChainIo`・`main` |
| payTo の allowlist は全 network で 1 つ | 同 `createEvmFacilitator`・`checkBinding` |
| 期限を過ぎた送出の `submitted` は、直列の待ち行列を出た後に追記され得る | 同 `settleInLine`（`:1246`） |
| journal の `gas_cap_*` の行は `EVM_TESTNET_NETWORKS` の外の network なら起動しない | 同 `parseJournalLine`（`:1658`） |
| Worker は `/supported` を isolate で 1 回だけ読む | `providers/x402-workers/src/requirements.ts` |
| 入口は起動時に `/supported` に有効な network が全部あることを求める | `tools/remote-mcp.ts`（`facilitatorSupportsAll`） |
| Base Sepolia: 0.2 秒/block、base fee 0.005 gwei、`transferWithAuthorization` 約 86,000 gas、実費 L2 6.5e11〜8.7e11 wei + L1 約 1.1e10 wei（2026-11-25 19:29Z、4 件） | 公開 RPC の読み取り |
| `eth_getLogs` の幅: `sepolia.base.org` は 200 block まで、publicnode は 10,000 block で可（同時刻） | 同 |

## 2. facilitator（`tools/evm-facilitator.ts`）

### 2.1 network の集合
- `src/shared/networks.ts` に `SELF_FACILITATOR_NETWORKS = EVM_TESTNET_NETWORKS ∪ { "eip155:84532" }` を足す。facilitator の 4 つの検査（`createEvmFacilitator`・`cliConfigOf`・`parseJournalLine`・`raiseCapArgsOf`）をこれに替える。`EVM_TESTNET_NETWORKS` は変えない。
- 資産: 表に `rails` の上書きがあり `x402` の受信を含まない資産（zUSDC）は `asset_not_in_table` で断る（`identify`。表を直接見ているので、明示の検査が要る）。
- 既定値（Base）: RPC publicnode、log の幅 5,000 block、`maxFeePerGas` の上限 1 gwei、settle の gas の上限 200,000、期限は新 3 と同じ（10 秒・6 秒・6 秒）。
- 照合の窓: `RECONCILE_LOOKBACK_SECONDS`（3,600 秒）は約 18,000 block。`blockAtOrBefore` は推定の距離の 1.2 倍まで戻るので、範囲は約 21,600 block になり得る。幅 5,000 なら `eth_getLogs` は 5 回ほど（推定）、ほかに block の時刻と receipt の読み取りがあり、すべて 10 秒の締め切りの内。
  締め切りを過ぎれば 5xx（安全側）。`sepolia.base.org` の幅 200 では 100 回を超えて実用にならないので既定にしない。探索・log・receipt を合わせた回数と期限を、0.2 秒/block・1 秒に 5 block が同じ時刻、の偽の chain で試験する。

### 2.2 L1 の手数料（FR-B2）
- `ReceiptView` に任意の `l1FeeWei`。Base の I/O だけ、receipt を生の JSON-RPC で読み `l1Fee`（hex）を写す。`waitForReceipt` の後も同じ receipt を読み直して写す。形が違う・欄が無ければ `undefined`。
- network の定数 `L1_FEE_RESERVE_WEI`（Base 2,000,000,000,000 wei = 実測の約 170 倍。ほかは 0）。**保守的な見積りで、上限ではない。**
- 予約 = `gasLimit × maxFeePerGas + L1_FEE_RESERVE_WEI`。実費 = `gasUsed × effectiveGasPrice + (l1FeeWei ?? L1_FEE_RESERVE_WEI)`。Base 以外は式も journal の値も今と同じ。
- L1 の手数料は送出の後に決まり、tx では上限を付けられない。予約を超えたら実費を数える（累計が上限を超え得る。超過の大きさに上限は無い。次の送出は止まる）。L1 の欄が無いときと、hash の分からない照合は予約を数える（実費が予約を超えていれば過少。要件 §8）。
- journal の形は変えない（`gasReservedWei`・`gasUsedWei` の値に含める）。

### 2.3 残高（FR-B3）と準備（FR-B4）
- `ChainReader.nativeBalance(address)` を足す。**Base だけ**、手順 8 の後（上限の検査の隣）で `balance < 予約` なら `refuseIfStillUnused("gas_balance_low")`、読めなければ `refuseIfStillUnused("gas_balance_unavailable")`。意図は書かない。
  （今は残高が無いと送出の RPC が失敗し、`send_outcome_unknown` で network が保留になる。新 3 への適用は、この変更では広げない。）
- `GET /<token>/ready` → 200 `{ "networks": { "<id>": { "ready": true|false } } }`。理由・残高・累計は返さない（log と診断にだけ残す）。`ready` = Base の I/O が使える（§2.5）∧ 保留でない ∧ **見積りの `maxFeePerGas` ≤ 設定の上限** ∧ 累計 + R ≤ 上限 ∧ 残高 ≥ R。
  R = 20 件分の予約（`maxSettleGas × 見積りの maxFeePerGas + L1_FEE_RESERVE_WEI` の 20 倍）。手数料はどれも**見積りの値**（送出の手順 8 と同じ `feesPerGas()`）。
  残高・手数料の読み取りは network ごとに 5 秒の控え、並行は 1 本、期限 2 秒。失敗は `ready: false`（控えない）。drain 中は 503（今と同じ）。
- `/supported` は変えない（保留の network を落とすと、入口が起動しなくなる）。
- `/verify` も Base だけ、`/ready` と同じ 1 つの条件で準備ができていなければ `isValid: false`・固定の理由 `facilitator_not_ready`（I: Router は受信の settle を始めない。署名そのものは取り消せない）。

### 2.4 保留からの復帰（FR-B6）
- 保留の鍵ごとに、15 秒後から間隔 15 秒（最大 40 回、約 10 分）で `resolveAtStartup` と同じ照合を 1 回だけ行う。対象は Base だけ。成功したら `settled`/`reverted` を書いて `release`。
- 照合は network の直列の待ち行列の**内側**で行う。**待ち行列だけでは足りない**（期限を過ぎた送出と journal の追記は、待ち行列を出た後も続く）ので、鍵ごとに終わっていない仕事（送出の promise、その後の `submitted`、終わっていない追記）を数え、
  「**Base が有効で chain id の一致を確認済み（§2.5）** ∧ 同じ鍵の要求が処理中でない ∧ 終わっていない仕事が 0 ∧ 保留中」を、**待ち行列に入った後に**読み直して、満たすときだけ始める。満たさなければ次の回に回す（終わらない追記があれば保留のまま）。chain id が未確認・不一致の間は、照合の RPC・終端の追記・release とも 0 回。期限 8 秒、`startupDeadline` は引数にする。
- 始めた回は、まず journal の状態を見る: 追記が遅れて成功し、既に終端（`settled`・`reverted`・`aborted_before_send` が fsync 済み）なら、RPC も追記もせず `release` だけ行う（再起動の後と同じ結果）。未解決なら照合する。journal に鍵が無い・運用者の解決は保留のまま。
- 終端の状態と `release` は、`settled`/`reverted` の追記（fsync）が成功した後だけ。追記が失敗・期限切れなら保留のまま（その追記が終わるまで次の回は始まらず、遅れて成功すれば次の回が上の経路で `release` する）。
- `applyRecord` の守り: `settled`・`reverted` の後の `submitted` は hash を変えない（再生でも同じ。今の journal の順では起きない）。
- Base の起動時の未解決も、ここで照合する（§2.5）。`transfer_mismatch` は対象外（確定した不一致）。hash が無く authorization が未使用の鍵は解けないまま（要件 §8）。
- drain: `close()` の後は新しい回を始めない。始まった回は `outstanding` に数え、行を書き終えるまで journal の close と lock の解放は待つ（今の drain の順）。待っている回は取り消す。timer は `unref` し、process を生かさない。
- `resolved_by_operator` の扱いは変えない。

### 2.5 起動の隔離と allowlist（FR-B1）
- **起動**: env・journal の検査は今と同じく全 network で失敗すれば起動しない。**Base だけ**、chain id の RPC の確認は listen の後に裏で行い（期限 5 秒、失敗は 15 秒ごとに再試行）、確かめるまで Base の settle は 503 `network_unavailable`、verify と `/ready` は準備ができていない。
  確かめた chain id が違えば再試行せず使えないまま。`/supported` には載せる（入口の起動の検査）。新 3 の確認は今と同じ（listen の前）。
- **照合**: Base の未解決は起動時に RPC を読まず、すぐ保留にして §2.4 の復帰に任せる（listen を遅らせない）。新 3 は今と同じ。
- **allowlist**: `payToAllowlist` に加えて、任意の `payToAllowlistByNetwork`（env `EVM_FACILITATOR_PAYTO_ALLOWLIST_<chainId>`）。ある network は**それだけ**を使い、無ければ共通のもの。Base は自分の一覧（Router の受取先と Base の Provider の受取先）、新 3 は共通のまま。

## 3. Router（`src/main.ts`）

- `localCounterpartyPlanOf` の**受信**の 2 か所（静的・動的）だけ、集合を `SELF_FACILITATOR_NETWORKS` に替える。送信の束ねは `EVM_TESTNET_NETWORKS` のまま。
  Base の facilitator が loopback で allowlist に無ければ起動しない（今は Base の loopback を検査していない。`ROUTER_X402_INBOUND_FACILITATOR_URL` に loopback を使う既存の fixture は `localCounterparties` を渡さないので変わらない: `origins === undefined` で早く返る）。
- 受信の期限: Base で facilitator が allowlist の loopback のときだけ 20 秒（それ以外は今の 10 秒）。10 秒同士だと、facilitator の応答の前に Router が切り `unknown` になる。domain は既定の `USDC`/`2` のままで表と一致。
- 今の Base の静的の受信の transport（`transportFor(inboundLoopback, …)`）は、allowlist の loopback のときだけ origin を固定した transport になる（既存の分岐。`localOrigin !== undefined` が先）。
- `accepted` の完全一致: 自前 facilitator は `paymentPayload.accepted` と requirements の完全一致を求める（`accepted_mismatch`）。Router の preflight は `accepted` のトップレベルの未知の鍵（`resource` など）を許すので、
  **そうした credential は Base で今は通り、I の後は verify で断られる**（Router は settle しない）。`npm run sign` と payer は余分な鍵を付けない（試験で固定）。facilitator は緩めない。
- 診断の `facilitator` の欄は `x402` のまま（adapter の kind）。

## 4. 設定生成と有効化（`tools/remote-mcp-config.ts`・`tools/remote-mcp.ts`）

- `RailsActivation.baseFacilitator?: { provider: boolean; inbound: boolean }`。`RAILS_ACTIVATION` には最初は**欄を置かない**（内部の env の往復も byte 一致）。
- `provider: true` → `UPSTREAM_X402` を使う静的 route の上流を `https://provider-x402-base.subethalabs.com/v1/eth/snapshot` に（`ROUTE_MPP_IN`・`ROUTE_SOL`・`ROUTE_SOLMPP_TO_X402`・`HOSTED_EXACT`・`ROUTE_ZUSDC_TO_X402` のうち今出ているもの）。destination の値は同じ。
- `inbound: true` → 子の env `ROUTER_X402_INBOUND_FACILITATOR_URL` = facilitator の URL。`ROUTER_SUBETHA_FACILITATOR_URL` の埋め草と Solana の facilitator は変えない（拒否ホストに `www.x402.org` が残る）。
- どちらかが `true` なら facilitator の計画に `eip155:84532` を足し（新 3 が全部無効でも計画を作る）、env `SUBETHA_EVM_FACILITATOR_GAS_CAP_84532` が必須、Base 用の allowlist の env（`SUBETHA_ROUTER_RECEIVER` と `OUTBOUND_X402.payTo`）を渡す。共通の allowlist は変えない。新 3 が全部無効なら、共通の一覧は Router の受取先だけ。新 3 の受取先 `SUBETHA_EVM_PROVIDER_PAYTO` は新 3 が有効なときだけ必須。
- Router の子の `localCounterparties` は `SUBETHA_EVM_FACILITATOR_URL` から作る（今と同じ。`inbound` が `false` でも無害: Base の URL は x402.org）。
- 受け入れの起動 `--rails` に `base-provider`・`base-in` の語を足す。

## 5. Provider（`providers/x402-workers`）

- `TABLE.base`: `eip155:84532`、USDC、10,000、`extra` `{ name: "USDC", version: "2" }`（`assetTransferMethod` は付けない: 今の Provider A と同じ 402）、`facilitatorUrl` 空（secret 必須）、`STANDARD_DEADLINES`、`maxTimeoutSeconds` 60、新しい欄 `readiness: true`。ほかの行は `false`。
- `[env.base]`: `name = "provider-x402-base"`、`workers_dev = false`、custom domain `provider-x402-base.subethalabs.com`、`PAY_TO` は Q-3。`FACILITATOR_URL` は secret。
- 準備の確認（FR-B5）: `readiness` の行だけ、**支払いヘッダの無い要求**の 402 の前に `GET <facilitator>/ready`（期限 2 秒、redirect 不可、64 KiB、isolate の控え 2 秒、並行 1 本）。自分の network が `ready: true` のときだけ 402、ほかはすべて 503 `{"error":"facilitator_unavailable"}`。
  支払いつきの要求では見ない（facilitator の verify・settle が自分で断る。402 の本文の再掲 `payment_invalid` も今のまま）。
- 未払いの GET が 503 のときの Router の結果（経路ごと。AC-B5 で固定）: 静的 MCP は `source_failed`（`not_sent`）を記録し `awaiting_payment`／`offer_unavailable`（`src/core/orchestrator.ts:1153`）、標準の x402 入口は 409 `payment_not_completed`、
  動的は `awaiting_payment`／`offer_unavailable`（`src/core/dynamic.ts:698,709`）。どれも受信の settle は 0 回だが、先に送金した買い手（Tempo の MPP）の送金は戻らない。
- 支払いつきで facilitator が `facilitator_not_ready` を返したら（準備の確認の後に停止した競争）: verify の `isValid: false` → Worker は 402 → Router は `rejected`（送信の資金は動かない）。受信は済んでいるので `paid_data_unavailable` になる。**この窓は残る**（FR-B5）。

## 6. 入れ替えと戻し（FR-B9）

1. **G-B3**: 欄の無い image（Base の行を読める）を入れ替え。公開の一覧は byte 一致。この image の tag を「戻す先」として記録する。
2. **G-B4**（この順だけ）: 入金 → env に上限 `SUBETHA_EVM_FACILITATOR_GAS_CAP_84532` → Worker の secret と配備（未払いの GET が 503 であることを確認。まだ誰も使わない）→ `provider` だけ `true` の image に入れ替え → 公開の path で `/ready`・402 を確認 → 購入。
   入れ替えの直後、Base の I/O の確認が終わるまで Worker は 503 を返し、Router は Provider A 宛ての quote を断る。
3. **G-B5**: `inbound` も `true` の image。
- **戻す**: 手順 1 の image に戻す。それより前の image（Base を知らない code）に戻すと、journal の `gas_cap_init`（Base）で facilitator が起動せず、**Router の入口ごと起動しない**。
  `swap-image.sh` の自動の復旧は image の再作成ではなく**前のコンテナをそのまま再起動**し、新しい env は読まない。手順 2・3 の前に、動いているコンテナの image が手順 1 以降で、その env（journal の volume・facilitator の鍵・新 3 の上限）が今と同じことを確かめる。
  Base 無効のコンテナは Base の上限の env を要らない。Base 有効のコンテナの上限の env は、journal の `gas_cap_init` と同じ値でなければ起動しないので、**最初の値を後から変えない**。補充は停止中に同じ lock の下で `raise-cap`。
- 切り替えをまたぐ購入: 入れ替えは drain を通る。発行済みの quote の受信は、入れ替え後は新しい facilitator に送られる（authorization は同じ chain・同じ payTo なので有効。高々 1 回は nonce）。
  入れ替えの前に `unknown` になった受信は再送しない（今と同じ）。

## 7. 検討して採らなかったもの

- **`EVM_TESTNET_NETWORKS` に Base を足す**: Router の受信の domain・期限・送信の loopback の束ね・試験の前提が一度に変わる。
- **x402.org を予備にする（failover）**: 断られたのか送出したのかを外から区別できず、Router の「1 回だけ」の規則を複雑にする。戻しは運用者の入れ替えで行う。
- **SubEtha の settle facilitator に USDC も任せる**: zUSDC の注文に結びついた決済で、契約の変更が別の持ち主に要る。
- **`provider-x402.subethalabs.com` の付け替え**: Provider A の持ち主の作業と、切り替えの途中の停止が要る。後からでもできる。
- **送出の前に署名済み tx の hash を journal に書く**: hash の無い保留を無くせるが、送出の経路の変更が新 3 にも及ぶ。必要になれば別の変更で。

## 8. タスクと試験

- **B-1** facilitator（§2）: AC-B3・B4・B6。既存の `tests/unit/evm-facilitator*.test.ts` は変更なしで通る。
- **B-2** Router の受信（§3）: AC-B7、期限 20 秒と drain の上限の試験、余分な鍵の credential。
- **B-3** 設定生成と入口（§4）: AC-B1・B2。
- **B-4** Worker（§5）: AC-B5。Router と合わせた wire 試験（準備ができていない → 受信の settle 0 回）。
- **B-5** 文書（DEPLOY の新しい節、provider の文書、README の URL）。有効化の後に公開の文書を更新。
- 各 PR: Codex のレビュー、macOS と Linux の試験、sabotage の確認。

## 9. 独立レビューの記録

- **R1（Codex `gpt-6-astra`、CLI read-only、第 1 版）: REVISE**（MUST 6・SHOULD 3・NOTE 1）。第 2 版で全件を反映: 1 手数料の上限を準備の条件に（§2.3）、2 保証を「Router が受信の settle を始めない」に限定し経路ごとの結果を固定（FR-B5・AC-B5・要件 §8）、
  3 復帰の開始条件・追記の成功後だけの終端化・遅い `submitted` の守り（§2.4）、4 Base の起動の隔離（§2.5）、5 network ごとの allowlist（§2.5・§4）、6 L1 の予約は見積り（§2.2・要件 §8）、7 戻しの env と順序（§6）、8 照合の回数と期限の記述（§1・§2.1）、9 事実と推測の書き分け（要件 §1・§7）、10 無効の 2 通り・再起動と finality（AC-B1・B8）。
- **R2（第 2 版の設計の編集が保存されていない状態を読んだ。要件だけが第 2 版）: REVISE**。設計の編集をやり直した。
- **R3（第 2 版の両方）: REVISE**（R1 の 9 件は解決、1 件が一部、新しい MUST 1 件）。反映: 遅れて終端になった鍵の復帰の経路、chain id の確認前の復帰の遮断（§2.4・AC-B4）。
- **R4（readback）: APPROVE**。新しい指摘なし（静的な照合だけ。実装・試験の承認ではない）。

## 10. 実装で決めたこと・設計との差（2026-11-26、B-1〜B-4）

- **受信の例外の旗**: `localCounterparties` に任意の `baseSepoliaInbound` を足し、公開の子は `baseFacilitator.inbound` のときだけ渡す。旗が無ければ Base には効かない
  （設計 §3 では Base を常に対象にしていた。狭めた）。`SELF_FACILITATOR_NETWORKS` は `src/shared/self-facilitator.ts`（`networks.ts` は payer のパッケージが写すので触らない）。
- **`/ready` に載るのは Base だけ**: ほかの network は残高・手数料を見ないので、準備の値を返さない。
- **Worker の並行**: 準備の確認の promise は要求をまたいで共有しない（workerd は別の要求の I/O を待てない）。控えは値だけで、読み取りの集約は facilitator の側（1 本）。`true` も `false` も 2 秒控える。
- **復帰の対象外**: `transfer_mismatch` のほかに、journal の書き込みの失敗（`journal_write_failed`）。この process で追記が 1 度でも失敗したら、以後は復帰の追記をしない（途中の行が残り得る。再起動の照合に任せる）。
  使えない間（chain id が未確認）は 40 回の回数に数えない。
- **receipt の `l1Fee`** は viem が生のまま残す欄から読む（追加の RPC なし）。
- **既存の試験の変更**: 「未知の network」の例に `eip155:84532` を使っていた 3 か所を `eip155:8453` に、Worker の「知らない network」の例の `base` を別の語に替えた。有効化の語の一覧の固定文に 2 語が増えた（`base-provider`・`base-in`）。ほかの既存の試験は変えていない。
- **未確認**: 実際の Base Sepolia の RPC・workerd・Cloudflare での動作（G-B3〜G-B5 で確かめる）。

### 実装のレビューの記録
- **I-1（Codex `gpt-6-astra`、CLI read-only）: REVISE**（MUST 3・SHOULD 4）。反映: 1 `close`・起動の失敗でも裏の仕事を止めて待ってから journal と lock を放す、2 期限切れの `aborted_before_send`・`reverted` の追記も復帰の対象に（保留の理由を分けた。log の文字列だけ全 network で変わる）、
  3 復帰の追記と解除の直前に journal の失敗を見直す、4 準備の読み取りは下の RPC が終わるまで 1 本、6 無効の byte 一致を変更前の golden とも照合・実際の Worker と facilitator の核をつないだ wire 試験、7 DEPLOY の遅れと対象外の記述。
  5（不正なヘッダの要求にも準備の確認）は採らない: 手元で断った支払いつきの要求を 503 にすると、送出していないのに Router が `unknown` にする。要件 FR-B5 の文言を「支払いヘッダの無い要求」に明確にした。
- **I-2（readback）: REVISE**（5 件解決、2 件が一部、新しい 1 件。5 の不採用の理由は妥当と判定）。反映: 裏の仕事が上限（10 秒）までに終わらなければ journal も lock も閉じない、寿命の過ぎた読み取りを待っていた要求もその値を使わない、
  無効のときの計画の全部（設定・子の env・facilitator の計画）と一覧を、変更前の code（`e24bd6f`）が書いた fixture と照合（`tests/fixtures/config-golden/pre-base-facilitator.json`）。
