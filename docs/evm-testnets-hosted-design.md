# 設計: EVM testnet 3 つを hosted Router に出す（第 2 版、2026-10-15）

> 要件 `docs/evm-testnets-hosted-requirements.md` 第 2.1 版 + Q-4（`00753e6`。owner の確認 2026-10-13「進めて良いです」、受信も公開「testnet だからいいか」）。
> 下敷き: `docs/evm-testnets-x402-design.md` 第 3 版（ローカル版。自前 facilitator §3.3、Provider §3.4、`localCounterparties` §3.5）。ローカル版の決定は変えず、**hosted に出すための差分** だけを書く。
> 提出期限（2026-10-13 15:59 JST）は過ぎた。本番の入れ替えは Q-3 のとおり期限の後ならいつでも。
> 第 1 版（`8a4b3b2`）は Codex D-1 で **REJECT**（blocker 2・major 1・minor 2。§11）。第 2 版で反映: 実行者の排他を OS の `flock` に（§2.3）、受け入れと本番で facilitator の journal と lock を 1 つに・本番用の新しい gas 鍵（§2.3・§4・§7）、補充を journal の理由つきの記録に（§2.2）、Tempo 宛ての両区分の不等式（§5）、参照の更新。

## 0. 一枚で

- **facilitator は Router のコンテナの中の 2 つ目の子 process**（公開の入口 `tools/remote-mcp.ts` が Router の子と並べて起動する）。gas 鍵はこの子の env にだけ渡す。journal は既存のボリューム（`/app/runtime`）。
- **Router → facilitator** はコンテナの中の loopback（`http://127.0.0.1:8611/<token>`）。egress 制御 B は Router の bridge の外向きだけを見るので触れない（コンテナ内の loopback は host の chain から見えない: `docs/ssrf-egress-design.md` §8.1）。SSRF 防御 A の例外は **facilitator の origin の完全一致** に限り、**受信の adapter の transport だけ**（静的・動的）。動的上流の transport は変えない（§3）。
- **Provider（Worker）→ facilitator** は公開の HTTPS `https://router.subethalabs.com/evm-facilitator/<token>/…` を Caddy が host の `127.0.0.1:8611`（コンテナの publish）へ流す。`Host` は Caddy が `127.0.0.1:8611` に書き換え、`Origin` は落とす（§4）。DNS・host は増えない。
- 36 組は **動的プロファイル**（`dyn-<src>-to-<dst>`）。静的 route は足さない。有効化は `RAILS_ACTIVATION.evm`（チェーン × 方向）。既定 `false`、golden は byte 一致（§5）。
- facilitator の追加: bind の選択（コンテナの中は `0.0.0.0`）、**gas の累計を journal から復元**、**単一の実行者の lock**（§2）。
- Provider は `providers/x402-workers` の env `rh`・`arbsep`・`hyperevm` を custom domain で配備。`FACILITATOR_URL` は secret（§6）。
- 受け入れは行列 driver の **hosted 動的モード**（`quote_url` + 宛先のレールの Provider の URL + `ownerKey`）。G-3 は前例の排他の引き継ぎ、G-4 の後は公開の HTTPS（§8）。

## 1. 確かめた事実（コード、`00753e6`）

| 事実 | 場所 |
|---|---|
| 動的プロファイルの x402 受信は facilitator を **動的用の transport**（`allowLoopback: false`）で呼ぶ | `src/main.ts:596-600,940-948` |
| `localCounterparties` は静的 route の受信・送信にしか効かない。origin は literal の `http://127.0.0.1:<port>` だけ | `src/main.ts:141-166,214-262` |
| facilitator は `127.0.0.1` に bind、`Host` が `127.0.0.1:<port>` でなければ 403、`Origin` つきは 403、path は `/<token>/<op>` だけ | `tools/evm-facilitator.ts:1215-1223,1316` |
| gas の累計 `spent` はメモリだけ。journal の再生は支払いの状態だけを戻す | `tools/evm-facilitator.ts:585,619-647,868-970` |
| facilitator の 1 件の金額の上限 20,000 | `tools/evm-facilitator.ts:58,397` |
| 公開のコンテナは `-p 127.0.0.1:8787:8787` だけを publish、ボリューム `/app/runtime`、env は `--env-file` | `deploy/swap-image.sh:185` |
| Caddy は `router.subethalabs.com { reverse_proxy 127.0.0.1:8787 }` | `docs/DEPLOY.md` §7 |
| 動的の x402 送信は定額 1,000・上流の上限 10,000、Router はチェーン手数料を払わない（x402 送信に `maxFee` は無い） | `tools/remote-mcp-config.ts:261-275,316-325` |
| 動的の区分は (network, asset)。既存の Arc・Solana は `railBuckets` で 1 件 20,000（Solana は 21,000）、総額は env `SUBETHA_DYNAMIC_MAX_TOTAL`（既定 100,000,000） | `tools/remote-mcp-config.ts:277-292,461-466,661-664` |
| Worker は https の facilitator（ローカル試験は loopback の http）だけを受ける | `providers/x402-workers/src/config.ts:113-114,179` |
| payer の発見は対応外の source network を除く | `packages/payer/src/daemon/handler.ts:34-35,60` |

## 2. facilitator（`tools/evm-facilitator.ts`）の変更

### 2.1 bind
- env `EVM_FACILITATOR_BIND`（`127.0.0.1` か `0.0.0.0` だけ。既定 `127.0.0.1`）。コンテナの中は `0.0.0.0`（docker の publish はコンテナの eth0 に届くため。コンテナの bridge には Router だけ: §8b.1）。
- `Host` の検査は変えない（`127.0.0.1:<port>` の完全一致）。Router は loopback で直接、Worker は Caddy の書き換えで同じ値になる。`Origin` つきの拒否も変えない（Caddy が落とす。Worker の `fetch` は `Origin` を付けないが、念のため）。

### 2.2 gas の累計の永続と補充（FR-H9）
- `submit_intent` に `gasReservedWei`（= `gasLimit × maxFeePerGas`、今の `worst`）を書く。`settled`・`reverted` に `gasUsedWei`（`receipt.gasUsed × receipt.effectiveGasPrice`）を書く（startup の照合で receipt が取れたときも）。
- 起動時の再生で network ごとに `spent = Σ(settled・reverted の gasUsedWei) + Σ(未解決の submit_intent の gasReservedWei)`。`aborted_before_send` は 0（送出していない）。`resolved_by_operator` は予約の分をそのまま数える（戻さない）。
- 上限は journal の記録だけで決まる: 最初の起動で env `EVM_FACILITATOR_GAS_CAP_<chainId>` の値を `gas_cap_init { network, capWei, at }` として fsync で書く。以後の起動で env の値が journal の `gas_cap_init` と違えば **起動しない**（固定文。env の書き換えで黙って補充できない）。
- **補充** = 運用者の CLI `tsx tools/evm-facilitator.ts raise-cap --network <id> --add-wei <n> --reason <文>`: journal の lock（§2.3）を取ってから（= facilitator が止まっているときだけ）`gas_cap_raise { network, addWei, reason, at }` を fsync で追記する。理由は必須（空・制御文字は拒む）。有効な上限 = `capWei + Σ addWei`。起動の log に有効な上限と累計を出す（値は wei、鍵・token は出さない）。
- 新しい形の journal（`gas_cap_init` があるもの）だけを受ける。`gas_cap_init` の無い既存の行（ローカル版の journal）を含むファイルでは起動しない（本番は新しい journal で始める。§7 の新しい gas 鍵と合わせ、ローカル版の状態を持ち込まない）。

### 2.3 単一の実行者（FR-H8）: OS の `flock`
- Router の journal と同じ仕組み（`src/core/journal.ts:109-131`、`fs-ext` の `flockSync(fd, "exnb")`）: journal の隣の常設の `facilitator.lock` を open（作成、切り詰めない）し、**process の寿命の間** 排他 lock を持つ。取れなければ起動しない。lock ファイルは消さない（解放は fd のクローズ = process の終了。kernel が解く）。heartbeat・奪取は **しない**。
- 止まった（`docker pause` など）process は lock を持ったままなので、後継は起動しない（fail closed）。kernel の lock は process の終了・コンテナの kill で解ける。
- lock と journal のパスは **本番と受け入れで同じ 1 つ**（`/app/runtime/evm-facilitator/journal.ndjson`・`facilitator.lock`、同じボリューム）。受け入れのコンテナと公開のコンテナは同じ host の同じボリュームを mount するので、同じファイルの `flock` で互いを排除する（同じ kernel。docker の local volume は bind で同じ inode）。受け入れ・本番・再起動・rollback のどれでも gas 鍵の状態（累計・未解決の保留）は続く。
- `raise-cap` の CLI も同じ lock を取る（動いている facilitator と同時に journal を書かない）。
- 試験: 同時の 2 起動で 1 つだけ listen、1 つ目を SIGSTOP（> 30 秒）しても 2 つ目は起動しない、SIGKILL の後は起動できる、`raise-cap` は動いている間は拒む。

## 3. Router（`src/main.ts`）の変更: 受信の facilitator の transport

- 能力 `localCounterparties` の allowlist を、**動的プロファイルの x402 受信** の facilitator にも効かせる: `facilitatorFor(profile.source.network)` の URL の origin が allowlist にあれば、その受信の adapter の transport を静的と同じ「`allowLoopback: true` + 要求ごとの origin の完全一致の包み」で作る。無ければ今の `dynamicTransport`。
- 起動時の拒否（静的と同じ）: 動的プロファイルの受信の facilitator の URL が loopback の literal で allowlist に無ければ起動しない。
- 動的上流（呼び出し側の URL）の transport・送信の adapter の `dynamic` の transport は **変えない**（loopback 不可 `src/main.ts:596-613`、`denyHosts` に facilitator のホストが入るのも既存のまま `src/main.ts:635-646`、redirect 不可 `src/net/guarded-fetch.ts:425`）。
- 公開の子の能力（`tools/rails-entry.ts` の `routerProcessCapabilitiesOf`。`tools/remote-router-process.ts:18-21` が import する）: 内部の env `SUBETHA_EVM_FACILITATOR_URL` があり、それが `http://127.0.0.1:<port>/<token>` の形なら、その origin だけで `localCounterparties` を作り、`evmSigningByNetwork` に有効な新 3 の network を足す（送信の鍵は既存の `SUBETHA_OUTBOUND_X402_KEY`、D-11）。env が無ければ今と同じ（能力を足さない）。

## 4. 入口とコンテナ

- `tools/remote-mcp.ts` の `startHost`: 有効化 `RAILS_ACTIVATION.evm` のどれかが `true` のとき（公開）、または受け入れの起動で新 3 の token があるとき、**Router の子より先に facilitator の子を起動** する（`tools/evm-facilitator.ts`、`EVM_FACILITATOR_BIND=0.0.0.0`、`EVM_FACILITATOR_PORT=8611`、journal と lock は本番・受け入れとも `/app/runtime/evm-facilitator/`（§2.3。Router の journal は前例どおり受け入れで別のパスだが、facilitator は gas 鍵の状態なので 1 つ）。listening の 1 行を待ち、`/<token>/supported` を 1 回読んで、有効な network が全部あることを確かめてから Router の子を起動する。どちらかが落ちたら両方を止めて入口も終わる（`--restart unless-stopped` がコンテナごと戻す）。
- facilitator の子の env（allowlist）: `EVM_FACILITATOR_KEY`（本番の env の `SUBETHA_EVM_FACILITATOR_KEY` から）、`EVM_FACILITATOR_TOKEN`（`SUBETHA_EVM_FACILITATOR_TOKEN`）、network、payTo の allowlist（Router の受取先 `SUBETHA_ROUTER_RECEIVER` と `SUBETHA_EVM_PROVIDER_PAYTO`）、gas の上限、RPC（任意）。**Router の子には gas 鍵を渡さない**（facilitator の URL と token だけ）。
- `deploy/swap-image.sh`: `docker run` に `-p 127.0.0.1:8611:8611` を足す（host の loopback だけ）。受け入れのコンテナ（DEPLOY §2c）も同じ。
- Caddy（`/etc/caddy/Caddyfile`）:
  ```
  router.subethalabs.com {
      handle_path /evm-facilitator/* {
          reverse_proxy 127.0.0.1:8611 {
              header_up Host 127.0.0.1:8611
              header_up -Origin
          }
      }
      reverse_proxy 127.0.0.1:8787
  }
  ```
  access log は有効にしない（token が path に入る）。本番の Caddyfile に `log` が無いことを G-2 で確かめる。`/mcp` の経路は変わらない。

## 5. 公開の設定生成（`tools/remote-mcp-config.ts`）

- `RailsActivation.evm?: { rh, arbsep, hyperevm }`（各 `{ inbound, outbound }`）。`RAILS_ACTIVATION.evm` は第 1 段で全部 `false`。無い・`false` なら golden は byte 一致（AC-H1）。
- 受信（`evm[c].inbound`）: `x402.inboundFacilitators[network] = { kind: "x402", url: env.SUBETHA_EVM_FACILITATOR_URL, timeoutMs: 表のチェーン別 }`（ローカル版 §3.6 の値）。受取先は `receiver`（`SUBETHA_ROUTER_RECEIVER`）。
- 送信（`evm[c].outbound`）: x402 送信の network に新 3 を足す（`evmSigningByNetwork`、§3）。上流は動的のみ。
- 動的プロファイル: 源の集合 S（`base`・`tempo`（MPP 受信が有効）・`arc`・`sol`・`solmpp`（各受信が有効）・`evm[c].inbound` の c）× 宛先の集合 D（`x402`（Base）・`mpp`（Tempo）・`arc`・`sol`・`solmpp`（各送信が有効）・`evm[c].outbound` の c）のうち、**どちらかが新 3** で、源と宛先が同じレールでないもの。id は既存の名付け（源: `x402`/`mpp`/`arc`/`sol`/`solmpp`、宛先: 同じ）に新 3 の短縮名を足す: 例 `dyn-rh-to-mpp`・`dyn-x402-to-arbsep`・`dyn-hyperevm-to-rh`。既存の 20 の id・値は変えない。
  - 新 3 宛て: `rail: "x402"`、`destination: { scheme: "exact", network, asset, decimals: 6, tokenDomain: 表 }`、`fee: DYNAMIC_FEE_X402_OUT`、`maxUpstreamAmount: 10000`、`par: true`。
  - 新 3 からの既存宛て: 既存のビルダー（`toX402`・`toMpp`・`toArc`・`toSol`・`toSolMpp`）に源を渡す（`sourceRail: "x402"`、payTo = `receiver`）。Tempo 宛ては既存の gas の cap の規則のまま。
- 区分: 新 3 の (network, asset) を `railBuckets` と同じ形で足す（受信か送信が有効なとき）。1 件の上限 `M` = 20,000。1 件の予約は区分ごとの合算（`src/core/dynamic.ts:223-230,239-252`）。上流額 `u`（呼び出し側の offer、≤ 10,000）、Tempo の gas の cap `c`（≤ `maxFee` 50,000）、手数料 `f = max(1,000, c)`（Tempo 宛て）または 1,000（x402 宛て）:
  - 新 → Tempo: 源の区分（新）に `u + f ≤ M`、宛先の区分（Tempo pathUSD。手数料の資産も同じ区分）に `u + c ≤ M`。どちらかを超える quote は `per_purchase_limit`（既存の `dyn-x402-to-mpp` と同じ振る舞い。`c` の実測 79〜706 では `u` = 10,000 で両方とも ≤ 11,000）。
  - 新 → x402 の宛先（Base・Arc・Solana・新）: 源 `u + 1,000 ≤ M`、宛先 `u ≤ M`。
  - 既存 → 新: 源（既存の区分）`u + 1,000 ≤ M`（Solana は 21,000 の区分のまま）、宛先（新）`u ≤ M`。
  - 試験: `u` を 1・9,999・10,000 で、`c` を等号（`u + c = M`）と 1 超過で、両区分の受理・拒否を固定する（AC-H2）。facilitator の 1 件の上限 20,000 は、源の区分の検査を通った quote の源のレグ（`u + f ≤ M = 20,000`）を常に受ける。
- 区分の総額: 既存の動的と同じ env `SUBETHA_DYNAMIC_MAX_TOTAL`（既定 100,000,000）。G-1 で値を確かめる。
- 文書の表（README・CLAUDE.md の route 表・llms.txt）は G-4 の後に更新（FR-H7）。

## 6. Provider（`providers/x402-workers`）

- `wrangler.toml` の `[env.rh]`・`[env.arbsep]`・`[env.hyperevm]`: `workers_dev = false` は残し、`routes = [{ pattern = "provider-x402-<c>.subethalabs.com", custom_domain = true }]` を足す（`sepolia` は今のまま配備しない）。
- `FACILITATOR_URL` は `wrangler secret put FACILITATOR_URL --env <c>`（値 `https://router.subethalabs.com/evm-facilitator/<token>`）。var には書かない。コードは env の `FACILITATOR_URL` を読むので secret でも同じ（Workers は secret を env に出す）。
- 配備は G-2 の後（facilitator が公開で動いてから）。未払いの 402 は facilitator なしでも返るが、支払いつきは facilitator が要る。

## 7. 鍵・資金（G-1 の案）

| 役割 | 鍵 | 要る資金 | 案 |
|---|---|---|---|
| facilitator の gas | 本番用の **新しい鍵 E-FAC-H**（`wallet:new` と同じ生成、本番の env にだけ置く）。ローカル版の E-FAC とは別にし、nonce を共有しない | 新 3 のネイティブ通貨。E-FAC から送る（2026-10-14 15:1xZ の読み取り: Robinhood 0.00998 ETH、Arbitrum Sepolia 0.0500 ETH、HyperEVM 1.008 HYPE。各半分程度） | 本番の env に `SUBETHA_EVM_FACILITATOR_KEY`。E-FAC の送金の前にローカル版の journal に未解決が無いことを確かめる |
| facilitator の token | 新しい 32 バイトの乱数 | — | 本番の env に `SUBETHA_EVM_FACILITATOR_TOKEN`、Worker 3 つの secret |
| Router の受取（新 3 の受信） | 本番の `SUBETHA_ROUTER_RECEIVER`（既存の EVM の受取先） | — | facilitator の allowlist に入る |
| Router の送信（新 3 へ） | 本番の `SUBETHA_OUTBOUND_X402_KEY` のアドレス | 新 3 の通貨 各 ≥ 0.2（36 組の送信のうち新 3 宛て 18 件 × 0.01 + 余裕） | T7（ローカルのクライアント）から EIP-3009 で送る（`tools/evm-testnets-prefund.ts`、自前 facilitator で settle） |
| 新 3 の Provider の受取 | E-PROV（Q-2） | — | allowlist に入る |
| 受け入れのクライアント | T7（EVM・Tempo）、T6 Solana payer | 既存の残高 | 新 3 の残高は G-1 で読む |

- gas の上限（最初の起動の `gas_cap_init`）: 各 network で E-FAC-H の入金額の半分（G-1 で決める）。公開の受信で第三者が使っても、この値で止まる（Q-4）。

## 8. 受け入れ

### 8.1 driver（`tools/evm-testnets-matrix.ts` に hosted 動的モード）
- `--hosted <MCP の URL>`: 静的の `mx-*` の代わりに 36 の `dyn-<src>-to-<dst>` を plan にする。各件の `url` は **宛先のレールの Provider**: `x402` → Provider A、`mpp` → Provider B、`arc` → Arc の Provider、`sol` → Solana の Provider（`/v1/eth/snapshot`）、`solmpp` → Provider D、新 3 → `https://provider-x402-<c>.subethalabs.com/v1/eth/snapshot`。
- quote は `subetha_router_quote_url`（`profileId`・`url`・新しい `requestId`）。署名の前に subject の upstream URL・源と宛先の network・資産・受取先・金額（上流 10,000 + 手数料 1,000 = 11,000、Tempo 宛ては cap を含む plan の上限以下）を plan と照合。`ownerKey` は私的な証跡にだけ保存（公開の要約に出さない）。status は `ownerKey` つき。
- 既存の印・保留（Tempo MPP の `funds_possibly_moved` は二度と署名しない、SR-H7）・両レグの chain の照合・finality・reopen はそのまま使う。

### 8.2 段取り
1. **G-2**（無効のまま配備）: イメージ（`RAILS_ACTIVATION.evm` 全部 `false`）、`swap-image.sh` の `-p 127.0.0.1:8611`、Caddyfile。facilitator は有効化が無いので起動しない。既存の一覧が byte 一致、`/healthz`、egress の check。
2. **G-3**（本番の env での受け入れ）: env に facilitator の鍵・token・上限を足す。前例の排他の引き継ぎ（公開を止める → 同じイメージ・network・ボリュームで受け入れの入口 `--rails` に新 3 の token を足した起動 → 終わったら公開を戻す）。この間に Provider 3 つを配備し（facilitator が公開の path で届く）、driver で 36 組を各 1 回。
3. **G-4**: `RAILS_ACTIVATION.evm` を全部 `true` にしたイメージに入れ替え、公開の HTTPS の MCP から 36 組を各 1 回 + 既存の数組（各レール 1 回以上）。Router の再起動の後に全 status を読み直す。
4. 文書（FR-H7）。

## 9. タスク（実装の PR の単位）

- **H-1** facilitator: bind・gas の累計の永続と `gas_cap_init`・`raise-cap`・`flock` の排他（§2）。試験: 再起動で上限が戻らない、env の上限が journal と違えば起動しない、`raise-cap` は理由が必須で動作中は拒む、旧形式の journal で起動しない、§2.3 の lock の試験（同時起動・SIGSTOP・SIGKILL の後）。
- **H-2** Router: 動的受信の facilitator の transport（§3）。試験: allowlist の origin の facilitator にだけ loopback で届く、別の loopback の origin・redirect は送出前に拒否、動的上流の transport は loopback を拒んだまま、allowlist に無い loopback の facilitator で起動しない。
- **H-3** 設定生成と有効化（§5）、公開の子の能力（§3 の最後）。試験: golden の byte 一致（無効）、有効時の差分が追加だけ、36 の id と値、区分、1 件の上限の境界（新 3 → Tempo の cap）。
- **H-4** 入口とコンテナ（§4）、`swap-image.sh`、受け入れの起動の token。試験: facilitator の子が先に起動し `/supported` を確かめる、どちらかが落ちると両方止まる、Router の子の env に gas 鍵が無い。mock の docker での `swap-image.sh` の試験（前例）。
- **H-5** Provider の `wrangler.toml`（§6）と driver の hosted 動的モード（§8.1）。
- **H-6** 文書（DEPLOY §2f の新しい節、README・CLAUDE.md・llms.txt は G-4 の後）。
- 各 PR: Codex の review、macOS + Linux の試験、sabotage の確認。owner の確認は G-1〜G-4。

## 10. 要件からの逸脱・未決

- **D-1** facilitator は Router と同じコンテナで動く: Router のコンテナの入れ替え（数秒）の間は facilitator も止まり、Provider の settle も止まる（Provider は facilitator の失敗で 5xx を返す → 動的の送信は `unknown` か `paid_data_unavailable`）。進行中の購入が無いときに入れ替える前例の決まりで足りるとする。
- 未決: Caddy の `header_up -Origin` の挙動は G-2 の前に手元の Caddy で確かめる。

## 11. 独立レビューの記録

- **D-1（Codex `gpt-6-astra`、CLI read-only、第 1 版 `8a4b3b2`）: REJECT**。SSRF・egress の経路は問題なし（origin の pinning、動的上流の transport は不変、公開ホスト名の拒否、URL の検査、redirect 不可で、呼び出し側の URL から facilitator への直接・redirect の経路は見つからない。コンテナ内の `0.0.0.0` の bind は単独の bridge と loopback だけの publish の前提で可）。36 のプロファイル・起動の順序・子 env の分離・driver の照合は原則として整合。指摘と反映:
  1. blocker — heartbeat の奪取では実行者が 1 つにならない（2 つの奪取、止まった process の復帰、後継の lock の削除）→ §2.3 を OS の `flock` に（奪取なし、lock は消さない）。
  2. blocker — 受け入れと本番で facilitator の journal・lock が別だと、同じ gas 鍵の累計と未解決の保留が途切れ、互いを排除できない → §2.3・§4 で 1 つのパス、§7 で本番用の新しい gas 鍵（ローカル版の状態を持ち込まない）。
  3. major — 補充を env の変更にするのは FR-H9 に反する → §2.2 の `gas_cap_init`・`raise-cap`。
  4. minor — Tempo 宛ての境界で宛先の区分（`u + c`）が抜けている → §5 の両区分の不等式と試験。
  5. minor — 参照の誤り（`denyHosts` の行、`routerProcessCapabilitiesOf` の場所）→ §3。
