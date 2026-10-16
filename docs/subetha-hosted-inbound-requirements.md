# 要件 v4: hosted Router の受信レグで SubEtha（zERC20）決済を受ける

> 対象: `router.subethalabs.com`（hosted）が、呼び出し側の **Sepolia zUSDC の SubEtha 決済**（`scheme: subetha-zerc20`）を受信レグとして受け、
> 既存の Provider A（x402）・Provider B（MPP）に支払って配信すること。本書は要件フェーズの成果物であり、設計・実装は含まない。
> v1 は独立レビューで REJECT（7 件）。v2 はその指摘を反映した版（§9）。v2 は APPROVE WITH CHANGES で、v3 はその中・低の指摘を反映した版（§10）。**v4 は owner の決定（2026-10-16）で受ける資産を zETH から zUSDC に変え、AC-3 を直した版である（§11）。**

## 0. 出発点（実測済みの事実）

| 事実 | 根拠 |
|---|---|
| 受信 adapter は実装済み（`/challenge`・`/verify`・`/settle`、preflight、未確定応答の `unknown` 分類） | `src/adapters/inbound/subetha.ts`、`docs/u01r-requirements.md` §11–12 |
| **ローカルでは両レグ完走済み**: SubEtha 受信（Sepolia zETH）→ x402 送信（Provider A）、`delivered` | `docs/u01r-requirements.md` §25–26（2026-09-29、burn tx `0x294e80c30810a7d914c9c16580002163d263e06a5ddda9c46f073a2775b8203f`） |
| そのときの facilitator は **SubEtha 自身の実装**（SubEtha リポジトリ `apps/facilitator`）をローカルで起動したもの。indexer・decider-prover・Postgres 2 本も自前。単一支払いに要った証明鍵は `root_*` の約 4 GB | 同 §19.2・§22–23・§27 |
| quote は facilitator が返す challenge の `amount`・`asset`・`network` が route の `source` と**完全一致**しなければ成立しない | `src/core/orchestrator.ts:458-466`。adapter は `route.source.amount` をそのまま `/challenge` に送る（`src/adapters/inbound/subetha.ts:195`） |
| 実構成の受信 transport は loopback・私設アドレスを拒む（fixture 能力のときだけ loopback を許す） | `src/main.ts:887-893`、`src/net/destination-policy.ts`（`DENY4`・`DENY6`） |
| hosted は route 構成に `sourceRail: "subetha"` を持たない。必須キー `ROUTER_SUBETHA_FACILITATOR_URL` には x402 の facilitator URL が**埋め草として**入っている | `tools/remote-mcp-config.ts:24-29`、`tools/remote-mcp.ts:251` |
| adapter は offer に `fundsMoveOnCredential: true` を載せる（payer が自分で burn を broadcast するため） | `src/adapters/inbound/subetha.ts:231`、`docs/fundsmove-requirements.md` §8.1 |
| `npm run sign` と `@subetha/payer` は `subetha-zerc20` を扱わない | `tools/sign-dispatch.ts:5-11` |
| 動的プロファイルの `sourceRail` は `x402` / `mpp` のみ | `src/core/dynamic.ts:276`、`tools/remote-mcp-config.ts:332` |
| 既存 chat は `rail === "subetha"` と `scheme === "subetha-zerc20"` を要求する | `docs/p5-inbound-rails-design.md` §2（chat の `router-contract.mjs:82`、`tests/wire/chat-crossimpl.test.ts:452`） |

## 1. facilitator の調査結果（2026-10-16）

owner の当初の想定は「testnet・v1 では zERC20 公式が用意した facilitator を使う」だった。観測の記録は
`docs/evidence/subetha-hosted-inbound-probe-2026-10-16.md`。

- **zERC20 公式に公開の x402 facilitator は見当たらない**（公式文書・公式リポジトリに記載なし、公式 API ホストの facilitator 系パスは 404）。
- **公式 testnet v1 が公開しているのは indexer と decider**（`https://beta-v1.api.zerc20.io/indexer/<token>`、`/decider/healthz`）。indexer は Sepolia の zETH と zUSDC を同期している。
  **v4 で受けるのは zUSDC**: token `0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF`（6 桁、symbol `zUSDC`）、verifier `0xb199A85463Bc5c0009c058E80b8A0d3D5e0025D6`（`redeemFeeBps()` = 10）、
  Hub は Base Sepolia の `0xF64Bd0a90120611b0c941e3eF546f2F82F1eaB44`、indexer は `https://beta-v1.api.zerc20.io/indexer/zusdc`（公式文書 `reference/addresses.md`、2026-10-16 の on-chain 読取。§11）。
  zUSDC の元の token は LiquidityManager `0xB9f41F93882c2ddC212a4EcC776BBd9D97D2F3C6` の `underlyingToken()` = `0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590`（試験用の USDC、6 桁）で、
  `mint(address,uint256)` は任意の送り主で成功する（`eth_call` の模擬。Circle の Sepolia USDC とは別の token）。
- **過去の testnet 決済の facilitator は SubEtha 自身の実装をローカル起動したもの**（§0）。外部の facilitator URL の記録は無い。
- SubEtha の facilitator は `network.indexer_url` / `network.decider_url` を設定で受け、`profile = "testnet"` で支払い受付と finalize を行う。
  `decider_url` は **batch（Nova）経路専用**で `check` も検査しない（SubEtha `docs/FACILITATOR.md` 構成表、`apps/facilitator/src/check.ts`）。
  testnet では「公式 operator の root 証明の周期」が 5 分を超えうるので `settlement.finalize_timeout_ms` を伸ばすよう指示がある（同表）。

**owner の決定（2026-10-16、本作業の対話で回答。対話の記録は `.claude_workflow/local/` にあり公開しない。§8 段階 1 の owner 確認で本書の記載どおりであることを改めて確認する）**: facilitator は **SubEtha 自身の実装**を hosted 用に動かし、indexer（と、必要なら decider）は
**公式 testnet v1** を使う。

**ライセンス**: SubEtha の README は「公開ホストのデモは別途 zERC20 licensor の許諾が要る」と書く。owner は同日「問題ない」と回答した。
許諾文面の所在は O-4 で記録する。Router リポジトリは従来どおり `@zerc20/sdk` を import・vendor しない。

**未確定（Q-1）**: 単一支払いの finalize（treasury への mint）が facilitator のホストで何を要するか（証明鍵のダウンロードと計算資源、
または公式サービスへの依存）。ローカル実証では自前の decider に `root_*`（約 4 GB）を読ませていたが、それが公式 operator の root 証明で
置き換わるのかは**未確認**。設計フェーズで facilitator と SDK のソースから確定し、AC-8 で実測する。O-1（置き場所）はこの答えに依存する。

## 2. スコープ

### やること

| # | 内容 |
|---|---|
| S-1 | SubEtha の facilitator を hosted 用に 1 つ動かす（testnet profile、公式 indexer） |
| S-2 | hosted Router に**静的 route 2 本**を追加: Sepolia zUSDC（SubEtha）→ Provider A（x402）、→ Provider B（MPP）。operator のスイッチの後ろに置く |
| S-3 | Router の journal と status に、payer が提出した burn の参照を残す（FR-7） |
| S-4 | `npm run sign` に `subetha-zerc20` の分岐（自己 transfer 経路）を追加 |
| S-5 | `@subetha/payer` の対応（S-4 の後。publish は owner） |
| S-6 | 配備と資金の動く受け入れ、CLAUDE.md・README の表の更新 |

### やらないこと

- 動的プロファイル `dyn-subetha-to-*`
- 送信レグを SubEtha にすること、permit（gasless）経路、mainnet、Sepolia 以外のチェーン、zETH・zBNB・zJPYC
- facilitator の私設ネットワーク配置のための SSRF 防御の例外（FR-1.5）
- `unknown` からの自動・手動の回復手順（FR-7.4）

## 3. 機能要件

### FR-1 facilitator の運用（S-1）

- **FR-1.1** SubEtha の facilitator を**無改変のリリース**から起動し、commit を固定して記録する。以降の挙動の記述（再送・保持期間）はその commit について確認する。
- **FR-1.2** 設定: `profile = "testnet"`、`chain_id = 11155111`、token・verifier・`hub`（`hub_chain_id = 84532`）は §1 の zUSDC の公式アドレス、`indexer_url` は公式 testnet v1 の `zusdc`、`finalize_timeout_ms` は公式の周期に合わせて伸ばす。journal は永続ボリューム。
- **FR-1.3** 秘密（`SUBETHA_TREASURY_PK`・`SUBETHA_RELAYER_PK`・`SUBETHA_ADMIN_TOKEN`）は**新しい testnet 専用の値**とし、Router の鍵と共有しない。値も所在も本書・リポジトリに書かない。
- **FR-1.4** `settlement.treasury`（mint 先）は operator の受取アドレス。受取は facilitator の構成で決まり、Router の route 構成には現れない（`src/config.ts:551`）。
- **FR-1.5** **公開 HTTPS のホスト名**で待ち受ける。Router の実構成の transport は私設アドレスを拒むので（§0）、P1 は SSRF 防御を変えずに公開アドレス経由で届かせる。
  お金の動く endpoint は facilitator 自身のレート制限（`daemon.rate_limit_per_min`・`challenge_per_key_per_min`・`max_open_challenges`）で守る。`/admin/*` はトークン必須で、
  リバースプロキシで外部に出さない。
- **FR-1.6** facilitator が出るのは Sepolia RPC、Base Sepolia RPC、公式 indexer（と、Q-1 次第で decider）のホストだけ。

### FR-2 手数料と額（v1 の未決を確定する）

- **FR-2.1** P1 の facilitator は **手数料を設定しない**（`fee.*` を一切設定しない。`chargeTo: "provider"` も使わない。provider 課金でも treasury から手数料が出ていくため、SubEtha `packages/zerc20-backend/src/fee.ts:20-22`、`docs/FEES.md`）。このとき challenge の `amount`
  は route の `source.amount` と等しい（SubEtha `docs/PROTOCOL.md` の challenge 表、`packages/zerc20-backend/src/index.ts` の `quoteWithFee`）。
- **FR-2.2** 用語を分ける: **list price** = route の `source.amount`、**burn 総額** = challenge の `amount`（P1 では list price と同じ）、
  **treasury の正味受取** = burn 総額 − verifier の redeem 手数料（on-chain の `redeemFeeBps` 等）。FR-2.1 により facilitator の手数料は 0 なので、mint の入金額と正味受取は一致する。承認・sign の上限・予算は**burn 総額**に束縛する。
- **FR-2.3** facilitator が payer 課金の手数料付きで動いていた場合、quote は `orchestrator.ts:458-466` の一致検査で**成立しない**（fail closed）。これを試験で固定する。
- **FR-2.4** `source.amount` は **10,000（0.01 zUSDC）**。他の静的 route の受信額（0.01 USDC、`tools/remote-mcp-config.ts:27`）と Provider の価格にそろえる（owner の決定 2026-10-16、O-2）。
  正味受取は 10,000 − ⌈10,000 × 10 / 10,000⌉ = 9,990（`redeemFeeBps()` = 10 のとき）。

### FR-3 Router の構成（S-2）

- **FR-3.1** `ROUTER_SUBETHA_FACILITATOR_URL` に FR-1 の facilitator を入れる。x402 受信は既存どおり `ROUTER_X402_INBOUND_FACILITATOR_URL`。
- **FR-3.2** 静的 route 2 本。`sourceRail: "subetha"`、`source.network: "eip155:11155111"`、`source.asset` は zUSDC、`decimals: 6`、`source.amount` は FR-2.4。
- **FR-3.3** operator の定数（既存の `RAILS_ACTIVATION` と同じ型）で出し入れできる。切っている間は一覧に出ず quote も受けない。
- **FR-3.4** 動的上流の宛先拒否に facilitator のホストが含まれる（`docs/DEPLOY.md` の `SUBETHA_DENY_HOSTS` 行: facilitator のホスト名は設定に関係なく拒否）。
- **FR-3.5** 受信の予算に Sepolia zUSDC の区分を加える。1 件の上限は burn 総額。

### FR-4 一覧と quote の提示

- **FR-4.1** 静的 route の `source` に `rail: "subetha"`・`scheme: "subetha-zerc20"` を出す（今は subetha 受信だけ scheme 欄が無い、`src/http/projection.ts:63`）。
- **FR-4.2** `subject` に `fundsMoveOnCredential: true`、受取先が**一回限りの burn アドレス**であること、burn 総額、challenge の期限を出す。
- **FR-4.3** 配信は `accepted`（burn がチェーンで確定し facilitator が受理）の時点で行い、mint（finalize）は後で非同期に起きる、と開示する。

### FR-5 `npm run sign` の分岐（S-4）

- **FR-5.1** `scheme: "subetha-zerc20"` を振り分ける。**鍵に触れる前に**拒む: network が `eip155:11155111` でない、asset が表の zUSDC でない、`payTo` の形が不正、
  `challengeNonce` の欠落・形違い、challenge の期限切れ、額が上限超え、offer の額が quote の `subject` の burn 総額と違う。
- **FR-5.2** 残高の事前確認: zUSDC が burn 総額に足りない、または Sepolia ETH がガスに足りない場合は broadcast 前に拒む。
- **FR-5.3** **送出の前に耐久記録する**: transfer を自分の鍵で署名して tx hash を確定させ、`challengeNonce`・送信元・account nonce・tx hash を
  ローカルの試行記録に書き込んでから raw tx を送る。応答喪失やプロセス中断があっても hash が残る。
- **FR-5.4** 同じ `challengeNonce`（または同じ quote）に試行記録があれば、**新しい burn を作らない**。記録の tx hash で receipt を確かめるか、`unknown` で止まる。
- **FR-5.5** 送出エラー・中断・receipt 待ちの時間切れは**明示の `unknown`** として tx hash と記録の場所を出し、停止する。再送しない。
- **FR-5.6** receipt が成功したときだけ credential `{x402Version, accepted: <offer>, payload: {challengeNonce, burnTxHash}}` を base64 で出す（SubEtha `docs/PROTOCOL.md` の
  自己 transfer の規則: 成功 receipt の後に payload を送る。実測の形は `tools/u01r-s3-inbound.ts:38-52`）。
- **FR-5.7** **sign の時点で資金が動く**（Tempo MPP と同じ）。人間の承認は sign の前。

### FR-6 `@subetha/payer`（S-5）

- **FR-6.1** FR-5 と同じ検査・耐久記録・`unknown` 扱いを daemon で行う。ネイティブダイアログの rail 行に「Approve で burn transfer を送る（取り消せない）」と出す。
- **FR-6.2** ダイアログで Cancel・時間切れのとき broadcast は 0 回。
- **FR-6.3** `find_routes` が新 route を `fundsMoveOnCredential: true`・必要資産（zUSDC と Sepolia ETH）付きで返す。

### FR-7 Router の burn 参照と未確定（S-3）

- **FR-7.1** purchase で受け取った credential の `burnTxHash` を、verify より前に journal に**payer の申告**として耐久記録する。settle 後の検証済み `txRef` と区別する。
- **FR-7.2** status は、verify 失敗・期限切れ・上流の変化・settle 応答の喪失・再起動のいずれの後でも、申告された burn 参照を返す。`awaiting_payment`・`unknown` を「未払い」と提示しない（既存の開示 `src/http/projection.ts:145` を維持）。
- **FR-7.3** 送信レグは既存の write-ahead 予約と at-most-once を経由する（変更なし）。同じ burn で 2 度目の送信を起こさない。
- **FR-7.4** Router は settle を自動で再送しない。根拠: 固定する facilitator の版（origin/develop `1aeac60` で確認）は、同じ `burnTxHash` の再送に同じ `accepted` を返す
  （`packages/zerc20-backend/src/index.ts:1724-1733` の冪等再送）が、`accepted` の記録は challenge の期限＋もう 1 TTL の猶予を過ぎると消え、その後の再問い合わせは `unknown` になる
  （`index.ts:3413-3433`。`expired_challenge_retention_seconds` は期限切れの `open` 記録の保持期間で、`accepted` には効かない）。
  `docs/u01r-requirements.md` §10.1 の「再送は常に `rejected`」は**当時読んだ版の観測**であり、現行版には当てはまらない。回復手順は別の要件で扱う。

## 4. 受け入れ条件

| ID | 条件 | ゲート |
|---|---|---|
| AC-1 | 新 route が切り替え off で一覧・quote に出ず、on で出る。`source` が `rail: subetha`・`scheme: subetha-zerc20` | wire（無課金） |
| AC-2 | challenge の `amount` が route と違う（手数料付き facilitator）と quote が成立しない | wire（合成 facilitator） |
| AC-3 | `npm run sign` が FR-5.1 の各条件で**鍵に触れる前に**拒む。FR-5.2 の残高不足では鍵は読むが**署名も送出もしない**（payer の address は鍵からしか得られないため。owner の決定 2026-10-16、O-7） | unit（無課金）＋ sabotage |
| AC-4 | 送出の失敗注入: 送出エラー・receipt の時間切れでは出力が `unknown` で hash を示す。送出後のプロセス中断では、中断したプロセスの出力ではなく**試行記録に hash が残っていること**を観測する。いずれも再実行で 2 本目の transfer を作らず、記録の hash で確認するか `unknown` で止まる | unit／wire（偽 RPC、無課金） |
| AC-5 | burn の後に verify 失敗・期限切れ・**上流の変化（verify より前に拒む経路を含む、`src/core/orchestrator.ts:634-639`）**・settle 応答の喪失・Router の再起動が起きても、status が申告された burn 参照を返し、送信レグは 0 回または 1 回。同じ quote・`requestId` に対して Router が新しい challenge（2 本目の burn の要求）を出さない | wire（合成 facilitator、無課金） |
| AC-6 | **hosted と同じ構成生成**で起動したローカル Router の実 adapter が、FR-1 の facilitator（公開 HTTPS）から `/challenge` を 1 件取得する。同じ Router で、動的上流の宛先に facilitator のホストと私設アドレスを指定すると拒否される | 無課金 |
| AC-7 | AC-6 の Router で zUSDC → Provider A、zUSDC → Provider B が各 1 件 `delivered` | testnet 実決済（§7 の範囲内） |
| AC-8 | AC-7 の 2 件が facilitator で `finalized`（treasury に mint、正味受取が burn 総額 − redeem 手数料と一致、FR-2.2） | testnet、観測のみ。配信とは別ゲート。Q-1 を確定する |
| AC-9 | 配備後の hosted で同じ 2 件が `delivered` | testnet 実決済 |
| AC-10 | payer 0.3.0 から 1 件 `delivered`。Cancel では broadcast 0 回 | owner ゲート（ネイティブダイアログ） |

テストは `npm test` を実際に実行し、新規テストは守っている箇所を壊して落ちることを確認する（sabotage）。

## 5. リスク

| ID | 内容 | 扱い |
|---|---|---|
| R-1 | 公式 testnet v1 に SLA が無い。止まると finalize が遅れる | 配信は `accepted` で行うので購入は止まらない。AC-8 で遅延を観測し運用文書に書く |
| R-2 | `accepted` から `finalized` までの失敗は operator（treasury 側）が負う | FR-4.3 で開示。testnet のみ |
| R-3 | facilitator の記録は保持期間後に消える。応答喪失は `unknown` で終わる | FR-7。回復手順は別要件 |
| R-4 | payer の burn に Sepolia ETH のガスが要る（zETH の実測 約 0.00009 ETH/回、`docs/u01r-requirements.md` §29.3）。zUSDC を得るには試験用 USDC の mint・approve・wrap のガスも要る | FR-5.2、README に faucet と mint・wrap の手順を書く |
| R-7 | SubEtha の facilitator で zUSDC を受けた実績は無い（ローカル実証は zETH） | AC-6・AC-7 が最初の確認。facilitator の挙動が token に依存する点は設計で facilitator のソースから確かめる |
| R-5 | Sepolia は遅い（`SLOW_EVM_TESTNETS`）。challenge の TTL（既定 300 秒）内に burn が確定しないことがある | 設計で TTL と receipt 待ちの時間を決める |
| R-6 | facilitator の money endpoint が公開になる（FR-1.5） | facilitator 自身のレート制限と上限。burn アドレスは一回限りで、facilitator は資金を預からない（自己 transfer 経路） |

## 6. owner の判断が要るもの

| ID | 判断 | 推奨 |
|---|---|---|
| O-1 | facilitator を置く場所 | **決定（2026-10-16）: 別ホスト（EC2 1 台）＋公開 HTTPS**（設計 §2.1 の案 A。同じホストは egress 制御で不可） |
| O-2 | 受ける資産と `source.amount` | **決定（2026-10-16）: zUSDC、10,000（0.01 zUSDC）**（FR-2.4） |
| O-5 | facilitator の公開ホスト名 | **決定（2026-10-16）: `zerc20-facilitator.subethalabs.com`** |
| O-6 | facilitator の RPC | **決定（2026-10-16）: Router と別のキー** |
| O-7 | AC-3 の文言 | **決定（2026-10-16）: 残高の確認は鍵を読んだ後、署名・送出の前**（AC-3） |
| O-3 | §7 の支払い範囲の確定 | 下表のとおり |
| O-4 | zERC20 の許諾の記録 | 許諾文面の所在だけを `.claude_workflow/local/` に記録する |

## 7. 実決済の範囲（AGENTS.md「Record concrete testnet payment scope before live payment」）

既存の owner 承認（2026-10-08 の対話での「testnet で資金の動くゲートは確認なしで進めてよい」。文書の記録は無いので、**§8 段階 1 の owner 確認で本節の範囲を承認として記録する**。
使い捨てアカウントの方針は `docs/u01r-requirements.md` §15、2026-09-29）を**次の範囲に限って**使う。範囲を超えるときは owner に確認する。faucet の利用は owner が行うか、この範囲の承認として記録してから行う。

| 項目 | 範囲 |
|---|---|
| アカウント | 新しい使い捨て payer 鍵 1 本、facilitator の treasury・relayer 各 1 本（FR-1.3）。既存の Router 送信鍵（Provider への支払い） |
| ネットワーク・資産 | Sepolia（ETH、試験用 USDC `0x2f6f…7590`、zUSDC）、Base Sepolia（ETH、USDC）、Tempo testnet（pathUSD） |
| 資金供給の上限 | payer: Sepolia ETH 0.05 以下、試験用 USDC の mint 1,000,000（1 USDC）以下、zUSDC への wrap 1 USDC 以下。relayer: Sepolia ETH・Base Sepolia ETH 各 0.05 以下 |
| 購入の件数 | AC-7・AC-9・AC-10 で合計 10 件以下（失敗の調査を含む） |
| 送信レグの総額 | Base Sepolia USDC 0.10 以下、Tempo pathUSD 0.10 以下 |

## 8. 段階とゲート

1. 本書 → Codex 独立レビュー → 親の読み返し → **owner の確認**（**2026-10-16 承認済み**: v3 の内容、§1 の決定、§7 の範囲を owner が本作業の対話で承認した）
2. 設計（Q-1 の確定、facilitator の配置と設定、route と切り替え、burn 参照の journal、sign の試行記録、額）→ レビュー → owner の確認
3. タスク分解 → レビュー
4. 実装（Router・sign・facilitator の配置）。各 PR は Codex の承認と実テストでマージ
5. AC-6 → AC-7 → AC-8（ローカル）→ 配備（owner ゲート）→ AC-9 → payer と AC-10

## 9. v1 レビュー（2026-10-16、Codex CLI 0.157.1、`gpt-6-astra`、read-only）への対応

判定 **REJECT**。7 件すべてを実ソースで確認し、反映した。

| # | 指摘 | 確認 | 反映 |
|---|---|---|---|
| 1 | 手数料の扱いは facilitator 側で定義済みで、payer 課金だと全 quote が一致検査で落ちる | `orchestrator.ts:458-466`、SubEtha `PROTOCOL.md` challenge 表、`quoteWithFee` | FR-2、AC-2 |
| 2 | 私設ネットワーク配置は実構成の transport（私設アドレス拒否）と両立しない | `main.ts:887-893`、`destination-policy.ts` | FR-1.5 を公開 HTTPS に変更、AC-6 |
| 3 | sign で hash が返る前の送出不確定が抜けている | `u01r-s3-inbound.ts:40-44`（送出完了まで hash を記録しない） | FR-5.3–5.5、AC-4、FR-6.2 |
| 4 | burn 参照の永続化が未定義（status は settle 後の `txRef` しか出さない） | `orchestrator.ts` の status と settle の記録 | FR-7.1–7.2、AC-5 |
| 5 | 「accepted 後の再送は rejected」は古い版の観測 | 現行 `index.ts` の §7.2 冪等再送 | FR-7.4 |
| 6 | 「funded testnet ゲートは確認不要」を範囲なしで使っている | AGENTS.md:9 | §7 に範囲を記録 |
| 7 | 事実の誤り（11 GB、decider の役割）と証跡の欠如 | `u01r-requirements.md` §19.2、`check.ts`、`FACILITATOR.md` | §0・§1・Q-1、証跡ファイル |

## 10. v2 レビュー（2026-10-16、Codex CLI 0.157.1、`gpt-6-astra`、read-only）への対応

判定 **APPROVE WITH CHANGES**。critical・high は無し。§9 の 7 件は RESOLVED 3・PARTIAL 4。PARTIAL の指摘を実ソースで確認し反映した。

| # | 指摘 | 反映 |
|---|---|---|
| 1 | provider 課金の手数料も treasury から出る（`fee.ts:20-22`） | FR-2.1 を「手数料を設定しない」に、FR-2.2・AC-8 の期待値を明示 |
| 4 | AC-5 に上流の変化（verify 前の拒否）と「2 本目の burn を求めない」が無い | AC-5 |
| 5 | `accepted` の記録は期限＋1 TTL で消え、その後は `unknown`（`index.ts:3413-3433`） | FR-7.4 |
| 6 | 2026-10-08 の承認に文書の記録が無い | §7。段階 1 の owner 確認で範囲を記録 |
| 7 | owner の決定に記録の参照が無い。公式 endpoint の応答はレビュー側で再現できていない | §1 に注記。証跡は作成者の観測として扱う |
| 他 | Q-1 の AC 参照の誤り、AC-4 の中断時の観測対象 | §1 Q-1、AC-4 |

## 11. v4 の変更（2026-10-16、owner の決定）

| 変更 | 内容 | 理由 |
|---|---|---|
| 受ける資産 | zETH → **zUSDC**（§1、FR-1.2、FR-2.4、FR-3.2、FR-3.5、FR-5、FR-6.3、AC-7、§7） | owner: 実際に使われるのは zUSDC が多い |
| 額 | 10,000（0.01 zUSDC） | owner: 他のサンプルの Provider の額を参考に（静的 route の受信額 0.01 USDC） |
| AC-3 | 残高不足は鍵を読んだ後・署名と送出の前に拒む | owner の決定 O-7（設計 v3 §7 の提案） |
| §7 の範囲 | 試験用 USDC の mint と wrap を加え、zETH の wrap を外した | 資産の変更に伴う |
| R-7 | zUSDC の実績が無いことを加えた | 資産の変更に伴う |

zETH のローカル実証（§0）は参考の事実として残す（Router の adapter と facilitator の経路が動くことの証拠）。
