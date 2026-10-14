# 設計: EVM testnet 3 つを hosted Router に出す（第 1 版、2026-10-15）

> 要件 `docs/evm-testnets-hosted-requirements.md` 第 2.1 版 + Q-4（`00753e6`。owner の確認 2026-10-13「進めて良いです」、受信も公開「testnet だからいいか」）。
> 下敷き: `docs/evm-testnets-x402-design.md` 第 3 版（ローカル版。自前 facilitator §3.3、Provider §3.4、`localCounterparties` §3.5）。ローカル版の決定は変えず、**hosted に出すための差分** だけを書く。
> 提出期限（2026-10-13 15:59 JST）は過ぎた。本番の入れ替えは Q-3 のとおり期限の後ならいつでも。

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

### 2.2 gas の累計の永続（FR-H9）
- `submit_intent` に `gasReservedWei`（= `gasLimit × maxFeePerGas`、今の `worst`）を書く。`settled`・`reverted` に `gasUsedWei`（`receipt.gasUsed × receipt.effectiveGasPrice`）を書く（startup の照合で receipt が取れたときも）。
- 起動時の再生で network ごとに `spent = Σ(settled・reverted の gasUsedWei) + Σ(未解決・aborted でない submit_intent の gasReservedWei)`。`aborted_before_send` は 0（送出していない）。`resolved_by_operator` は予約の分をそのまま数える（戻さない）。
- 旧形式の行（`gasReservedWei` の無い、ローカル版の journal）は **読まない**: 本番は新しい journal のパスで始める（ローカル版の journal を本番に持ち込まない）。旧形式の行を見つけたら起動しない（固定文）。
- 上限は env `EVM_FACILITATOR_GAS_CAP_<chainId>`（wei）。**補充 = 運用者が env の値を上げてコンテナを入れ替える**（root 所有の env ファイルの変更で、記録を DEPLOY に残す）。要件 FR-H9 の「journal に理由つきで追記」はこの形に置き換える（同じく運用者の明示の操作で、再起動だけでは戻らない。§10 の逸脱 D-1）。

### 2.3 単一の実行者の lock（FR-H8）
- journal の隣に `facilitator.lock`。起動時に `O_EXCL` で作り（中身: `{ pid, startedAt, heartbeatAt }`）、5 秒ごとに `heartbeatAt` を更新（fsync）。既にあれば `heartbeatAt` が 30 秒より古いときだけ奪う（書き換えて読み直し、自分の値なら取得）。新しければ **起動しない**。終わるとき消す。
- 本番の入れ替えは古いコンテナを止めてから新しいものを起動する（`swap-image.sh`）ので、通常は lock が残っていない。異常終了の後でも 30 秒で奪える。2 つが同時に動く窓は、前例の「同時に 2 つの Router を動かさない」（DEPLOY §2c の排他）と合わせて閉じる。
- journal の書き込み・fsync の失敗で送出しない（既存。§3.3 手順 10）。lock の更新が 2 回続けて失敗したら、以後の settle を全部 5xx（network を保留）にする。

## 3. Router（`src/main.ts`）の変更: 受信の facilitator の transport

- 能力 `localCounterparties` の allowlist を、**動的プロファイルの x402 受信** の facilitator にも効かせる: `facilitatorFor(profile.source.network)` の URL の origin が allowlist にあれば、その受信の adapter の transport を静的と同じ「`allowLoopback: true` + 要求ごとの origin の完全一致の包み」で作る。無ければ今の `dynamicTransport`。
- 起動時の拒否（静的と同じ）: 動的プロファイルの受信の facilitator の URL が loopback の literal で allowlist に無ければ起動しない。
- 動的上流（呼び出し側の URL）の transport・送信の adapter の `dynamic` の transport は **変えない**（loopback 不可、`denyHosts` に facilitator のホストが入るのも既存のまま `src/main.ts:479-490`）。
- 公開の子（`tools/remote-router-process.ts` の `routerProcessCapabilitiesOf`）: 内部の env `SUBETHA_EVM_FACILITATOR_URL` があり、それが `http://127.0.0.1:<port>/<token>` の形なら、その origin だけで `localCounterparties` を作り、`evmSigningByNetwork` に有効な新 3 の network を足す（送信の鍵は既存の `SUBETHA_OUTBOUND_X402_KEY`、D-11）。env が無ければ今と同じ（能力を足さない）。

## 4. 入口とコンテナ

- `tools/remote-mcp.ts` の `startHost`: 有効化 `RAILS_ACTIVATION.evm` のどれかが `true` のとき（公開）、または受け入れの起動で新 3 の token があるとき、**Router の子より先に facilitator の子を起動** する（`tools/evm-facilitator.ts`、`EVM_FACILITATOR_BIND=0.0.0.0`、`EVM_FACILITATOR_PORT=8611`、journal は `/app/runtime/evm-facilitator/journal.ndjson`、受け入れは `/app/runtime/acceptance/evm-facilitator/…`）。listening の 1 行を待ち、`/<token>/supported` を 1 回読んで、有効な network が全部あることを確かめてから Router の子を起動する。どちらかが落ちたら両方を止めて入口も終わる（`--restart unless-stopped` がコンテナごと戻す）。
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
- 区分: 新 3 の (network, asset) を `railBuckets` と同じ形で足す（受信か送信が有効なとき）。1 件の上限 20,000。新 3 → Tempo の最悪: 源のレグ = 上流 10,000 + 手数料 max(1,000, cap)、cap ≤ `maxFee` 50,000 なので **源の区分で 60,000 まで** 予約し得る → 既存の `dyn-x402-to-mpp` と同じく cap が 10,000 を超える quote は `per_purchase_limit` で止まる（既存と同じ振る舞い。cap の実測 79〜706 なので通常は 11,000 以下）。境界の試験を置く（AC-H2）。facilitator の 1 件の上限 20,000 も同じ境界で足りる。
- 区分の総額: 既存の動的と同じ env `SUBETHA_DYNAMIC_MAX_TOTAL`（既定 100,000,000）。G-1 で値を確かめる。
- 文書の表（README・CLAUDE.md の route 表・llms.txt）は G-4 の後に更新（FR-H7）。

## 6. Provider（`providers/x402-workers`）

- `wrangler.toml` の `[env.rh]`・`[env.arbsep]`・`[env.hyperevm]`: `workers_dev = false` は残し、`routes = [{ pattern = "provider-x402-<c>.subethalabs.com", custom_domain = true }]` を足す（`sepolia` は今のまま配備しない）。
- `FACILITATOR_URL` は `wrangler secret put FACILITATOR_URL --env <c>`（値 `https://router.subethalabs.com/evm-facilitator/<token>`）。var には書かない。コードは env の `FACILITATOR_URL` を読むので secret でも同じ（Workers は secret を env に出す）。
- 配備は G-2 の後（facilitator が公開で動いてから）。未払いの 402 は facilitator なしでも返るが、支払いつきは facilitator が要る。

## 7. 鍵・資金（G-1 の案）

| 役割 | 鍵 | 要る資金 | 案 |
|---|---|---|---|
| facilitator の gas | 本番は **E-FAC を使い回す**（ローカル版の facilitator は以後動かさない。同じ gas 鍵の nonce を 2 つの process で使わない） | 新 3 のネイティブ通貨（残高はローカル版の後の値を G-1 で読む） | 本番の env に `SUBETHA_EVM_FACILITATOR_KEY` |
| facilitator の token | 新しい 32 バイトの乱数 | — | 本番の env に `SUBETHA_EVM_FACILITATOR_TOKEN`、Worker 3 つの secret |
| Router の受取（新 3 の受信） | 本番の `SUBETHA_ROUTER_RECEIVER`（既存の EVM の受取先） | — | facilitator の allowlist に入る |
| Router の送信（新 3 へ） | 本番の `SUBETHA_OUTBOUND_X402_KEY` のアドレス | 新 3 の通貨 各 ≥ 0.2（36 組の送信のうち新 3 宛て 18 件 × 0.01 + 余裕） | T7（ローカルのクライアント）から EIP-3009 で送る（`tools/evm-testnets-prefund.ts`、自前 facilitator で settle） |
| 新 3 の Provider の受取 | E-PROV（Q-2） | — | allowlist に入る |
| 受け入れのクライアント | T7（EVM・Tempo）、T6 Solana payer | 既存の残高 | 新 3 の残高は G-1 で読む |

- gas の上限（`EVM_FACILITATOR_GAS_CAP_<chainId>`）: 各 network で E-FAC の残高の半分（G-1 で残高を読んで決める）。公開の受信で第三者が使っても、この値で止まる（Q-4）。

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

- **H-1** facilitator: bind・gas の累計の永続・lock（§2）。試験: 再起動で上限が戻らない、旧形式の journal で起動しない、lock の競合で 2 つ目が起動しない・古い lock は奪える、lock の更新の失敗で保留。
- **H-2** Router: 動的受信の facilitator の transport（§3）。試験: allowlist の origin の facilitator にだけ loopback で届く、別の loopback の origin・redirect は送出前に拒否、動的上流の transport は loopback を拒んだまま、allowlist に無い loopback の facilitator で起動しない。
- **H-3** 設定生成と有効化（§5）、公開の子の能力（§3 の最後）。試験: golden の byte 一致（無効）、有効時の差分が追加だけ、36 の id と値、区分、1 件の上限の境界（新 3 → Tempo の cap）。
- **H-4** 入口とコンテナ（§4）、`swap-image.sh`、受け入れの起動の token。試験: facilitator の子が先に起動し `/supported` を確かめる、どちらかが落ちると両方止まる、Router の子の env に gas 鍵が無い。mock の docker での `swap-image.sh` の試験（前例）。
- **H-5** Provider の `wrangler.toml`（§6）と driver の hosted 動的モード（§8.1）。
- **H-6** 文書（DEPLOY §2f の新しい節、README・CLAUDE.md・llms.txt は G-4 の後）。
- 各 PR: Codex の review、macOS + Linux の試験、sabotage の確認。owner の確認は G-1〜G-4。

## 10. 要件からの逸脱・未決

- **D-1** FR-H9 の補充の方法: journal への追記ではなく、env の上限を上げてコンテナを入れ替える（§2.2）。どちらも運用者の明示の操作で、再起動だけでは戻らない。
- **D-2** facilitator は Router と同じコンテナで動く: Router のコンテナの入れ替え（数秒）の間は facilitator も止まり、Provider の settle も止まる（Provider は facilitator の失敗で 5xx を返す → 動的の送信は `unknown` か `paid_data_unavailable`）。進行中の購入が無いときに入れ替える前例の決まりで足りるとする。
- 未決: Caddy の `header_up -Origin` の挙動は G-2 の前に手元の Caddy で確かめる。
