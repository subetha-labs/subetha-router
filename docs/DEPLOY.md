# リモート MCP のデプロイ手順（EC2 + Docker）

**この文書は運用手順であり、秘密は一切含まない。**
鍵は**実行時に env で渡す**（イメージに焼き込まない。親が `docker run --rm` で確認済み）。

## 1. イメージをビルドする

```sh
docker build -t subetha-router .
```

- `fs-ext`（journal の `flock`）が**ネイティブビルド**を要るので、ビルド段に `python3 make g++` を入れ、
  **実行段には持ち込まない**（多段ビルド）。
- 実行段は `node:22-bookworm-slim` / **非 root（uid 10001）**で動く。
- `runtime/` だけを書き込み可能にしてある（journal の置き場）。

## 2. 起動する

```sh
docker run -d --name subetha-router --restart unless-stopped \
  -p 8787:8787 \
  -v /var/lib/subetha-router:/app/runtime \
  -e SUBETHA_OUTBOUND_PRIVATE_KEY=0x<送信レグを払う運営の鍵> \
  -e SUBETHA_ROUTER_RECEIVER=0x<受信レグの受取先アドレス> \
  subetha-router
```

| env | 必須 | 内容 |
|---|---|---|
| `SUBETHA_OUTBOUND_PRIVATE_KEY` | ✓ | **送信レグ**（Provider への支払い）＝運営の資金。Tempo pathUSD |
| `SUBETHA_ROUTER_RECEIVER` | ✓ | **受信レグ**の受取先。呼び出し側の USDC がここに入る |
| `PORT` | | 既定 `8787` |
| `SUBETHA_MAX_PURCHASES` | | 既定 `100000` |
| `SUBETHA_INBOUND_MAX_TOTAL` / `SUBETHA_OUTBOUND_MAX_TOTAL` | | 既定 `1000000000` base units |
| `SUBETHA_MPP_INBOUND_SECRET` | | **MPP 受信**を公開する場合のみ。challenge の HMAC 束縛鍵（**32 バイト以上**）。署名鍵ではない |
| `SUBETHA_OUTBOUND_X402_KEY` | | x402 送信に別ウォレットを使う場合のみ。既定は `SUBETHA_OUTBOUND_PRIVATE_KEY` を流用 |
| `SUBETHA_TEMPO_RPC_URL` | | **推奨。** Tempo の認証付き RPC。未設定だと公開エンドポイントを使い、共有 egress IP からは**レート制限を受けやすい**。MPP 送信と MPP 受信の照合の両方に使う。**注意: 2026-10-06 より前のイメージは、この値を Router の子プロセスに渡していなかった**（設定しても送信は公開 RPC を使っていた。起動ログの `tempo rpc: public` で分かる）。この診断行は Router の子プロセス（`tools/remote-router-process.ts`）の stderr に出るもので、hosted の入口はそれを転送しない。確かめるには `SUBETHA_TEMPO_RPC_URL` を与えて `tools/remote-router-process.ts` を直接起動する |
| `SUBETHA_APPROVAL_TTL_SECONDS` | | 承認期限（秒）。既定 `600`。**`SUBETHA_OFFER_SECONDS` と揃える**こと |
| `SUBETHA_JOURNAL_PATH` | | journal の置き場。既定 `runtime/journal.ndjson`。**ボリュームの中を指すこと** |
| `SUBETHA_DYNAMIC_MAX_PURCHASES` | | 動的上流 URL の通算の件数上限。既定 `1000`（§2b） |
| `SUBETHA_DYNAMIC_MAX_TOTAL` | | 動的上流 URL の通算の額の上限（受信・送信の各バケット、base units）。既定 `100000000` |
| `SUBETHA_DENY_HOSTS` | | 動的上流 URL の宛先にできないホスト名（カンマ区切り）。公開ホスト名・facilitator・RPC の**ホスト名**（とそのサブドメイン）は設定に関係なく拒否する。運用者の Provider A・B（静的 route の上流）は拒否しない。別の名前で同じサービスに解決する宛先は拒否できない（設計 §7.4 の限界） |

### 2b. 動的上流 URL（呼び出し側が上流を指定する機能）— **本番で両方向のプロファイルが有効**（2026-10-06、G-4 の 1 回目と 2 回目）

呼び出し側が**自分で上流の URL を選んで**、x402 か MPP で払い、もう一方のレールで上流に届く機能
（設計 `dynamic-upstream-design.md`、要件 `dynamic-upstream-requirements.md`）。本番の入口（`tools/remote-mcp-config.ts`）が登録するのは
**`dyn-mpp-to-x402`**（Tempo pathUSD で払って、x402 の上流に Base Sepolia USDC で届く。2026-10-06 の 1 回目）と
**`dyn-x402-to-mpp`**（Base Sepolia USDC で払って、MPP の上流に Tempo pathUSD で届く。同日の 2 回目、`MPP_OUTBOUND_PROFILE_ENABLED = true`。
手数料は quote 時のガス代の見積りから——`docs/dynamic-gas-fee-design.md`）。有効・無効もプロファイルの構成も env からは変えられない。
`subetha_router_list_routes` の `dynamic` に `enabled: true` と登録済みのプロファイルが出る。

**有効にする条件**（T16 の G-4。owner の判断。7 つ）:

1. **G-2（testnet の実決済）が済んでいること**: 本番と同じ構成で、運用者の Provider A・B を動的に指定して両方向を各 1〜2 件、件数・額・口座を示してから行い、
   成立・手数料が送信費用を賄うこと・`delivered` の示す範囲を確かめる。その記録が無ければ有効にしない
2. SSRF 防御 B（egress 制御、§8b）が**このホストで受け入れ済み**で、その記録（受け入れの日付と証拠の場所）が**設定の変更と並べて**残っていること。
   動的経路の transport は loopback を許さず、名前解決に期限を付け、宛先アドレスの枠を取ってから接続するが、**ホスト側の egress 制御はそれとは別の層**である。
   拒否ホストは**ホスト名**（とそのサブドメイン）の一致で見る。別の名前で同じサービスに解決する宛先は拒否できない（設計 §7.4 の限界）
3. Router の port（`8787` と Router 本体の HTTP）を **Caddy 以外に公開しない**（`-p 127.0.0.1:8787:8787`）。
   送信元の識別は Caddy が付ける `X-Forwarded-For` の最後の値で、Router の HTTP に直接届くローカルのプロセスは任意の送信元を名乗れる。
   **Router の HTTP に届くローカルのプロセスは信頼する**、という前提で運用する
4. 動的の通算の上限（`SUBETHA_DYNAMIC_MAX_PURCHASES`・`SUBETHA_DYNAMIC_MAX_TOTAL`）が許容できる値であること。
   この上限は**運用者の送信側の支出の上限**（送信の元本＋MPP 送信の手数料の上限 `maxFee`。手数料の上限が実際の負担の上限であることは 6 の前提）で、
   実際の損失の集計ではなく、呼び出し側が purchase の前に送った MPP の送金を守るものでもない。
   動的購入の予算は静的 route とは別に数え、journal の `created` 行（予約つき）から再起動で復元する。結果不明・昇格後の settle の拒否は予約を保持する。
   上限に達したら `purchase_count_limit`／`bucket_limit` で止まり、**止まること自体が安全機構**
5. 控え（未払いの quote の記録）のディレクトリ `dynamic-quotes/` は journal と同じディレクトリに作られる。**ボリュームの中**にあること（`-v`）。
   7 日より古いファイルは Router が消す。最悪のディスク使用量は設計 §7.3（約 860 MiB）
6. MPP 送信のプロファイルは、Tempo の手数料の仕様で「チェーンが請求する額が署名時の上限以下」が確立するまで有効にしない（設計 §3.3 の T0-b。
   **x402 送信のプロファイルだけ先に有効にできる**）。**2026-10-06 に、ソースの版 v1.16.0 について確立**: 公開仕様・TIP-0001・ノードのソース tag `v1.16.0`
   （commit `74b6915`）で、請求額 = `ceil(max(gas_used − reservoir, 0) × min(maxFeePerGas, baseFee + priority) / 10^12)` ≤ 署名時の上限（`docs/dynamic-gas-fee-design.md` §7）。
   testnet Moderato のノードは `tempo/v1.16.0-023f1d0` を名乗り、`023f1d0` の tree は tag の commit `74b6915` と全ファイルの blob が一致する（直接比較）ので、
   手数料の経路のソースは配備された版と一致する（バイナリは未検証）。**ノードの版名が変わるか、hardfork が有効になったら読み直す**こと（版が変わらなくても挙動は変わり得る）。
   **Router の単価（priority 1）での送金の testnet の試行は 2026-10-06 に 1 件成立**（`docs/dynamic-gas-fee-design.md` §8.5。観測・試行は**公開の testnet RPC**に対して行った。
   本番の Router に設定した RPC（`SUBETHA_TEMPO_RPC_URL`）については、配備時の起動 probe（`eth_fillTransaction`）が通ったことを配備の記録に書く）。あわせて、quote 時と purchase 時の bound を本番の RPC で並べた記録（`feeMargin` 2 倍の見直し材料。
   `docs/dynamic-gas-fee-design.md` §2・§4）と、RPC ノードが `eth_fillTransaction` に対応していること（起動時の `verify` が読取で確かめる。非対応ノードでは
   quote・purchase の RPC が宛先アドレスの枠に収まらない。同 §4）
7. 手数料・上限の値（`fee`・`maxUpstreamAmount`・`maxFee`・`feeMargin`。G-1）。**2026-10-06 に決定**: x402 送信は定額 1,000。MPP 送信は quote 時のガス代の見積りから
   quote ごとに決める（`docs/dynamic-gas-fee-design.md`: cap = ceil(bound × `feeMargin` 20,000 / 10,000)、手数料 = max(定額 1,000, cap)、cap が天井 `maxFee` 50,000 を
   超える quote は出さない。呼び出し側が先に払う手数料 ≥ 署名時の上限、を quote ごとに保つ。運営がチェーン手数料を負担しないのは、6 の前提が成り立つ場合）、
   `maxUpstreamAmount 10000`

**有効化の記録（2026-10-06）**: 条件 1〜7 を満たして x402 送信のプロファイルだけ有効にした。受け入れの記録は `tools/remote-mcp-config.ts` の
`routerConfigOf` のコメントに日付と場所を並べて書いてある（B: 設計 `ssrf-egress-design.md` §25・レビュー #10、本番ホストへの設置と受け入れ 2026-10-05、§8b.0・§8b.6。
G-2: `dynamic-upstream-tasks.md` T16、2026-10-06）。

**有効化の記録（2026-10-06、2 回目）**: 条件 6 の前提（手数料の仕様の確立 `dynamic-gas-fee-design.md` §7・Router の単価での testnet の試行 §8.5・起動時の `eth_fillTransaction` の確認）が揃い、
owner の決定で MPP 送信のプロファイル（`dyn-x402-to-mpp`）も登録した（`MPP_OUTBOUND_PROFILE_ENABLED = true`）。記録は `tools/remote-mcp-config.ts` のコメントと
`dynamic-upstream-tasks.md` T16・T18。配備は同日 10:07Z、イメージ `b-b1524b0`。起動時の probe は本番に設定した RPC で通り、公開 MCP から両方向の一覧・MPP 送信の quote・
動的購入 1 件（delivered、請求額 29 ≤ cap 158）を確認した（T16 の記録）。

**変更の手順**: `tools/remote-mcp-config.ts` の `routerConfigOf`（`enabled`）と `MPP_OUTBOUND_PROFILE_ENABLED` だけを変えて、§6 の手順でイメージを作り直して入れ替える。
戻し方は 2 段階: `MPP_OUTBOUND_PROFILE_ENABLED = false` は **MPP 送信のプロファイルだけ**を外す（journal の昇格済みの購入は予約を保ったまま再生され、`created` の購入は支払いの前に `quote_changed`）、
`enabled: false` は**両方向**を止める。**戻すのも同じ 1 箇所**（`enabled: false`）（無効にした Router は、動的購入を含む journal をそのまま再生し、予算を保ち、動的 quote と控えの購入を拒否する。
静的 route はそのまま動く）。

**有効にした後に見るもの**: stderr の `outbound transport destination_blocked`（動的 URL が内部や拒否ホストに向いた）、`rate_limited` の頻度、
journal の `dynamic.reservation` を持つ `created` 行の数（通算の件数）、`unknown` の終端（MPP 受信では credential を作った時点で資金が動く。
`awaiting_payment` は「未払い」を意味しない）。

### 2c. 多レールの受信（Arc testnet USDC・Solana devnet USDC で払う）— **本番で有効（2026-10-07 11:03Z から。当時の `RAILS_ACTIVATION = { arc: true, solana: true }`、今の形では `arc.inbound`・`solana.inbound` が `true`。下の G-4 の記録）**

呼び出し側が **Arc testnet の USDC**（x402、facilitator は Circle）か **Solana devnet の USDC**（x402 の SVM `exact`、facilitator は x402.org）で払い、
既存の Provider A（x402）・B（MPP）に届く機能（要件 `multirail-requirements.md`、設計 `multirail-design.md`、タスク `multirail-tasks.md`）。
有効にすると本番の入口（`tools/remote-mcp-config.ts`）が登録するのは、静的 route **`md-mpp-eth-snapshot-arc`**（Arc USDC 10,000 → Provider B/MPP）と
**`md-x402-eth-snapshot-sol`**（Solana USDC 10,000 → Provider A/x402）、動的プロファイル **`dyn-arc-to-mpp`・`dyn-arc-to-x402`・`dyn-sol-to-x402`・`dyn-sol-to-mpp`**、
`(network, asset)` ごとの予算の区分（静的 1 件 10,000、動的 1 件 20,000。通算は既存の env の上限）、`x402.inboundFacilitators`（`eip155:5042002` → Circle、
`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` → x402.org。Base Sepolia は env のまま）。**有効・無効は 1 つの値 `activation { arc, solana }`** で、設定生成と
Router の process の能力の注入の**両方**がそれを見る（`tools/rails-entry.ts`）。公開の入口はコードの定数 `RAILS_ACTIVATION` を渡し、**env からは変えられない**。

**鍵と口座（G-1。owner が行う。mainnet の資産は使わない）**:

1. **Arc の受取鍵は証明専用の新しい鍵**（Base Sepolia の受取鍵・送信の鍵とは別）。`npm run wallet:new` で作り、**秘密鍵をホストの env `SUBETHA_ARC_RECEIVER_KEY`** に置く。
   Router の `src/` に渡るのは Circle の売り手証明（EIP-712 `SellerRequest`）に署名する閉包だけで、この鍵で資金を動かす署名（EIP-3009）は得られない（設計 §3）。
   受取先（`payTo`）はこの鍵の address で、入口が鍵から導く（設定ファイルには address だけが入る）。受け取った USDC を動かすのは運用者の手元の操作
2. **Solana の受取 owner の鍵はホストに置かない**（運用者の手元。`npm run wallet:new:solana` で作れる）。ホストの env `SUBETHA_SOLANA_RECEIVER` には **owner の address だけ**を置く。
   **ATA（owner の USDC の口座）は運用者が先に作る**（rent 1,488,440 lamports ≈ 0.0015 SOL。devnet の SOL は faucet）。Router は起動時に ATA の存在・owner・mint を
   RPC で 1 回確かめ、無ければ起動しない（設計 §5.1、FR-14）
3. `SUBETHA_SOLANA_RPC_URL`（任意。無ければ公開 devnet `https://api.devnet.solana.com`）。起動時の検査だけに使い、quote・purchase では使わない。ホスト名は動的上流の拒否ホストに入る。
   URL は鍵を含み得るのでログに出さない（query つきの URL は設定が拒む。鍵は path に）
4. 使い捨ての payer（受け入れの支払い側）に Arc testnet の USDC と devnet の USDC（faucet）を入れる（T6・G-3 で使う。Router の鍵ではない）

**配備（G-2。無効のまま）**: env（上の 1〜3）を置いて公開の process を再起動する。無効なので新しい route・facilitator・起動時の検査は**動かない**——確かめるのは
「起動して既存の経路が従来どおり」と、egress 制御（§8b）のもとで **Circle（`api.circle.com`）・x402.org・Solana の RPC** に届き、内部や自分自身の宛先は遮断されること
（egress は「公開経路でない宛先・ホスト自身のアドレス・`EXTRA_DENY` を拒む」方式で、宛先の許可リストではない。公開の 3 ホストに規則の追加は要らない）。rollback の container を 1 つ保つ。

**配備の記録（G-2、2026-10-07）**: owner の決定で、T6 の使い捨ての受取（Arc の証明専用の鍵、Solana の受取 owner と ATA。どちらも testnet）をそのまま本番の受取にした。
本番の env に `SUBETHA_ARC_RECEIVER_KEY`・`SUBETHA_SOLANA_RECEIVER` を置き、イメージ `b-478c0f9`（多レールのコードを含み、`RAILS_ACTIVATION` は無効）に入れ替えた
（07:44Z。入口の閉鎖は約 15 秒、journal の先頭バイト列は不変、`subetha-egress check` 合格、rollback は `subetha-router-prev-20261007T074436Z` = `b-b1524b0`）。
確かめたこと: 公開 MCP の一覧は従来の 2 route・2 プロファイルのまま、既存 route の quote が成立、コンテナの中から Circle・x402.org・Solana devnet RPC に届き、IMDS と
ホスト自身のアドレスは遮断される（egress は「公開経路でない宛先を拒む」方式なので新しいホストの追加は不要）、Router の子プロセスには有効化の値が空で渡り、
Arc の鍵は渡っていない。**イメージは手元（arm64）で作って `docker save`/`docker load` で入れた**: ホスト（1.8 GB）でのビルドは型検査でヒープ不足になった
（Dockerfile の型検査の `lib` と `skipLibCheck` を `tsconfig.json` に揃えた。PR #62）。

**受け入れ（G-3。owner の確認の上で、支払いごとに quote を見せる）**: 公開の process の定数は触らず、**受け入れ用の起動**で行う。
egress 制御の network `subetha-router-net` には **Router を 1 つだけ**置く決まり（§8b.1。runner は 2 つ目のメンバーを FAIL にし、同じ bridge の中の通信は
フィルタを通らない）なので、受け入れの間は**公開の Router を止める**（`docker stop subetha-router`。終わったら `docker start subetha-router`。
**2 つを同時に動かさない**）。止めている間、公開の要求は失敗し、発行済みの quote の期限は進み続け、stop の時点で終わっていなかった購入は再起動後に `unknown` として
確定し得る（graceful shutdown の中で終わる要求はそのまま終わる）——**進行中の購入が無いときに**行う。この間の §8b.4 の検証はコンテナ名 `subetha-router-acceptance` を対象にする（verifier は唯一のメンバーの名前を見る）。そのうえで公開の Router と**同じイメージ・同じ network・同じボリューム**から受け入れのコンテナを起動し、MCP の入口は
**ホストの loopback だけ**に公開する（Node や依存をホストに入れる必要はない。イメージに `tools/` と `node_modules` が入っている）:

```sh
docker stop subetha-router
# 公開の Router と同じ env（送信の鍵・MPP 受信の秘密・Tempo の RPC）に、Arc の受取鍵・Solana の受取 owner・Solana の RPC を足す。
# journal はボリュームの中の別のパス（公開の journal と同じファイル・別名は拒まれる）。コンテナの中では 0.0.0.0 に bind し、ホスト側は 127.0.0.1 だけに公開する。
docker run --rm --name subetha-router-acceptance \
  --network subetha-router-net -p 127.0.0.1:8788:8788 \
  -v /var/lib/subetha-router:/app/runtime \
  -e SUBETHA_OUTBOUND_PRIVATE_KEY=... -e SUBETHA_ROUTER_RECEIVER=... -e SUBETHA_MPP_INBOUND_SECRET=... -e SUBETHA_TEMPO_RPC_URL=... \
  -e SUBETHA_ARC_RECEIVER_KEY=... -e SUBETHA_SOLANA_RECEIVER=... -e SUBETHA_SOLANA_RPC_URL=... \
  -e SUBETHA_ACCEPTANCE_PORT=8788 -e SUBETHA_ACCEPTANCE_BIND=0.0.0.0 \
  -e SUBETHA_ACCEPTANCE_JOURNAL_PATH=runtime/acceptance/journal.ndjson \
  subetha-router node --import tsx tools/rails-acceptance-run.ts --rails arc-in,solana-in
# stdout の 1 行（起動できたとき）: {"event":"listening","port":8788,"address":"0.0.0.0","routerPort":<Router>,"mode":"acceptance","rails":"arc-in,solana-in"}
# 手元からは ssh -L 8788:127.0.0.1:8788 <Router の host> で MCP（http://127.0.0.1:8788/mcp）に届く。Router 本体の HTTP はコンテナの外に出さない。
# 終わったら、この端末で Ctrl-C（入口が SIGINT で子の Router を止めて終わる。--rm でコンテナは消える）→ docker start subetha-router
```

公開の経路を止めたくないときの代わり: 受け入れの起動を**公開の Router のコンテナの中**で動かす（`docker exec`。network のメンバーは増えない。
入口は既定の `127.0.0.1` に bind し、コンテナの外には出ない）。この場合は支払いの手順（`CLAUDE.md` の quote → 承認 → `npm run sign` → purchase）も
同じコンテナの中で、使い捨ての payer の鍵を `docker exec -e SUBETHA_PAYER_PRIVATE_KEY=... -e SOLANA_PAYER_PRIVATE_KEY=...` で渡して行う:

```sh
# 前景（-it）で動かす: Ctrl-C が SIGINT として入口に届き、入口が子の Router を止めて終わる（-d で切り離すと止める手段が無い。pkill は使わない）。
docker exec -it -e SUBETHA_ARC_RECEIVER_KEY=... -e SUBETHA_SOLANA_RECEIVER=... -e SUBETHA_SOLANA_RPC_URL=... \
  -e SUBETHA_ACCEPTANCE_PORT=8788 -e SUBETHA_ACCEPTANCE_JOURNAL_PATH=runtime/acceptance/journal.ndjson \
  subetha-router node --import tsx tools/rails-acceptance-run.ts --rails arc-in,solana-in
# 送信の鍵・MPP 受信の秘密・Tempo の RPC はコンテナの env から読まれる（docker run で渡したもの）。
# 終わった後に残っていないことの確認: cmdline か environ に印を含む process の PID を出す（自分自身は除く。印は pgrep の [ ] の形で、検査の process 自身には一致しない）。
# 何も出なければ、受け入れの入口（印 rails-acceptance-ru[n]）とその子の Router（environ の ROUTER_JOURNAL_PATH。印 acceptance/journal.ndjso[n]）は残っていない。
docker exec subetha-router sh -c 'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; { tr "\0" " " < "$p/cmdline"; tr "\0" " " < "$p/environ"; } 2>/dev/null | grep -q "rails-acceptance-ru[n]\|acceptance/journal.ndjso[n]" && echo "${p#/proc/}"; done'
```

起動に失敗したときホスト（この起動）の stderr に出るのは固定文（`could not start the Router`）だけで、Router の process の stderr（`svm inbound` の起動時の検査の
失敗の理由、`tempo rpc:` の行）は**転送されない**（§2 の表の `SUBETHA_TEMPO_RPC_URL` の注と同じ制限）。理由を見るには、入口が子に渡すのと同じ env
（`tools/remote-mcp.ts` の `hostPlanOf` と `tools/rails-entry.ts` の `railsChildEnvOf` の写し。**名前が変わる**: 送信の鍵は `SUBETHA_OUTBOUND_MPP_KEY`・
`SUBETHA_OUTBOUND_X402_KEY`、MPP 受信の秘密は `ROUTER_MPP_INBOUND_SECRET`）と、入口が書いた設定（ボリュームの `remote-*/router.config.json`）で
`tools/remote-router-process.ts` を直接起動する。network のメンバーを増やさないよう `docker exec` で、**動いているコンテナの中で**: 別コンテナの変種では
`subetha-router-acceptance` が動いている間はそれを対象にし（下の例の名前を読み替える）、受け入れの起動そのものが失敗したとき（`--rm` でコンテナは消えている）は
`docker start subetha-router` で公開の Router を戻してからその中で行う（保存された設定はボリュームの `remote-*/` に残っている）。`docker exec` の変種では
`subetha-router` の中で。受け入れの起動が動いたままなら、その journal のロックを取り合わないよう journal は 3 つ目のパスに。前景（-it）で動かして Ctrl-C で止める:

```sh
docker exec -it \
  -e SUBETHA_OUTBOUND_MPP_KEY=<SUBETHA_OUTBOUND_PRIVATE_KEY の値> -e SUBETHA_OUTBOUND_X402_KEY=<SUBETHA_OUTBOUND_X402_KEY か、無ければ同じ値> \
  -e ROUTER_CONFIG_PATH=runtime/remote-<起動が作った名前>/router.config.json -e ROUTER_JOURNAL_PATH=runtime/acceptance/diag/journal.ndjson \
  -e ROUTER_HTTP_PORT=0 -e ROUTER_CANONICAL_BASE_URL=http://127.0.0.1:8500 -e ROUTER_PRINCIPAL_TOKENS=judge:public -e ROUTER_ADAPTER_MODE=real \
  -e ROUTER_SUBETHA_FACILITATOR_URL=https://www.x402.org/facilitator -e ROUTER_X402_INBOUND_FACILITATOR_URL=https://www.x402.org/facilitator \
  -e ROUTER_X402_INBOUND_OFFER_SECONDS=<SUBETHA_OFFER_SECONDS の値、無ければ 600> -e ROUTER_MPP_INBOUND_SECRET=<SUBETHA_MPP_INBOUND_SECRET の値> -e ROUTER_MPP_INBOUND_OFFER_SECONDS=<同じ> \
  -e SUBETHA_TEMPO_RPC_URL=<値> -e ROUTER_MPP_INBOUND_RPC_URL=<同じ値> \
  -e SUBETHA_RAILS_ACTIVATION=arc-in,solana-in -e SUBETHA_ARC_RECEIVER_KEY=... -e SUBETHA_SOLANA_RPC_URL=<値> -e ROUTER_SOLANA_RPC_URL=<同じ値> \
  subetha-router node --import tsx tools/remote-router-process.ts
# stderr に理由の固定文（例: `svm inbound: ...`）か、`{"event":"listening",...}` が出る。終わったら Ctrl-C（SIGINT で Router が止まる）。
# 残っていないことの確認は、この Router だけが持つ印（environ の ROUTER_JOURNAL_PATH の acceptance/dia[g]）で、動かしたコンテナの中で（公開・受け入れの Router は印を持たない）:
docker exec <動かしたコンテナ> sh -c 'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; tr "\0" " " < "$p/environ" 2>/dev/null | grep -q "acceptance/dia[g]" && echo "${p#/proc/}"; done'
```

**最初に**この起動で Solana の起動時の検査（`/supported`・ATA）が通ることを確かめる（本番 env での検査の証拠）。次に AC-1（Arc → Tempo、静的・動的）、AC-2（Solana → Base または Tempo、
静的・動的）を各 1 件、使い捨ての payer で。証拠: Arc は settle の tx が Arc の RPC で `success` かつ受取先の残高の増分、Solana は signature が devnet で confirmed かつ ATA の残高の増分、
結果の `proof.onChainFinality` は `not_checked`。U-1（settle の `success` までの時間、`settlement_pending` の有無）・U-4（Circle の wire 30 秒で足りるか）を記録する。
`settlement_pending` が出たら設計 §10 U-1（`/status` の polling）を改訂してから G-4 へ。

**受け入れの記録（G-3、2026-10-07 07:53–07:57Z）**: owner の決定（デモ運用なので公開の停止を許容、testnet なので購入ごとの承認は不要）のもと、公開の Router を止めて
受け入れ用の Router を単独で起動した。**両レールの起動時の検査（x402.org の `/supported`、devnet の ATA）は本番 env で通った。** 使い捨ての payer で 4 件:
Arc 静的 → Provider B/MPP は delivered（Arc tx `0x205c8a…f691`、Arc の RPC で `success`、block 65933098、7.6 秒）、Arc 動的 → Provider B の URL は delivered
（`0x3085f3…20c0`、`success`、block 65933150、6.9 秒）、Solana 静的 → Provider A/x402 は delivered（signature `g8MKCq…`、devnet で finalized、6.7 秒）、
**Solana 動的 → Provider A の URL は `unknown`**（`source_settle_unknown`、5.6 秒。**AC-2 の動的は未達**: `delivered` が条件で、facilitator が返したはずの signature も Router には無い）。
4 件目はチェーン上では成立している（後から受取 ATA の署名を辿ると signature `4gRU9q…`、memo = quote の nonce、11,000、finalized。blockTime は 07:55:39Z で、
journal の `unknown` は 07:55:40.562Z。確定が観測された時刻と facilitator の応答の前後関係は分からない）が、facilitator の settle 応答が形どおりの成功でなく
（確定待ちの timeout が有力な見立て。応答本文は Router が記録しない）、Router は FR-19 どおり `unknown` を残して再 settle も送信もしなかった。呼び出し側は 0.011 USDC を払って
データを受け取っていない（開示どおり返金なし）。受取先の残高の増分: Arc 0.021 USDC、Solana の ATA 0.021 USDC。`proof.onChainFinality` は `not_checked`。
U-4: Circle の wire 30 秒は十分。**U-1: SVM では「settle の応答の後にチェーンで確定する」ケースが実際に出たので、G-4 の前に設計 §10 U-1 の改訂（期限つきの追跡か、
現状のままか）を owner が決める。** 終了後は公開の Router を戻し、`/healthz`・`subetha-egress check`・公開の一覧（従来の 2 route）を確認。公開の停止は約 4 分。

**再試行の記録（G-3、2026-10-07 09:40–09:42Z、T11 の後）**: 追跡（設計 §5.8）を含むイメージ `b-4d2c925` に公開の Router を入れ替え（無効のまま。rollback は
`subetha-router-prev-20261007T094049Z` = `b-478c0f9`）、同じ手順で受け入れ用を単独で起動し、Solana → Provider A を動的（`dyn-sol-to-x402`、signature `2iBaHM…`、finalized、6.5 秒）と
静的（`md-x402-eth-snapshot-sol`、signature `bZUbak…`、finalized、4.4 秒）で各 1 件、どちらも **delivered**。受取 ATA は 0.021 → 0.042 USDC。これで **AC-2 の動的も満たした**
（AC-1 は 1 回目で満たしている）。追跡が働いたかは hosted では観測できない（上記の制限）。公開の停止は約 1 分。

**有効化（G-4。owner の判断）**: `tools/remote-mcp-config.ts` の `RAILS_ACTIVATION` の `arc.inbound`・`solana.inbound` を `true` にして（片方だけでもよい。G-4 の当時は `{ arc: true, solana: true }` の形だった。
送信の `outbound` は別の gate G-4′ で、下の「送信」を見る）、§6 の手順でイメージを作り直して入れ替える
（入れ替えは `deploy/swap-image.sh <image:tag>`: 入口を閉じ → 旧を `-prev-<ts>` に改名 → 新を同じ network・port・volume・env で起動 → `/healthz` と Router の `listening` 行 →
journal の先頭バイト列が不変 → `subetha-egress check` → 入口を開ける → 公開の `/healthz` を 30 秒まで再試行。**イメージと旧コンテナの ID を確かめるまでは何も変えず、
その後の失敗（INT/TERM も）は旧コンテナを ID で元の名前に戻して起動し（復旧の待ち 60 秒）、入口を開け直す**。docker・systemctl の呼び出しはどれも上限付き（`timeout -k`）。
変更操作（stop・rename・run）は成功と確認できるまで「未確定」と記し（失敗の種類は見分けない）、未確定の操作は daemon 側で続いているかもしれない（docker はその順序を保証しない）ので、
復旧は最善を尽くした上で **`STATE UNKNOWN`（exit 2）** と報告し、復旧したとは言わない（上限に当たった `docker stop` は、旧コンテナを起動する前に `Running=false` を最大 30 秒見る。これは最善であって完了の保証ではない）。
復旧の各段（名前の照合・削除・改名・起動・`/healthz`・caddy・`docker ps`）も同じで、確認できなければ exit 2。旧コンテナが元の名前で `/healthz` に答え、入口が active と確認できたときだけ exit 1。
検証はどれも致命。待ちは経過時間で切り、ループの中の各要求にも残りの予算を渡す（予算を超えるのは `timeout` の kill の猶予 5 秒と、要約のための `docker logs` の別枠 10 秒 + 5 秒まで。段ごとの予算で、script 全体の期限ではない）。コンテナのログの中身と変更操作の docker の stderr は出さない（listening 行と bind 行の有無、`could not start the Router` の行数だけ）。それ以外の docker・systemctl の stderr はそのまま出る。有効化の後は子の Router が listen の前に Solana の起動時の検査（最大 10 秒 × 2）と Tempo の probe（MPP 送信のプロファイルごとに
最大 6 秒、3 本）を行うので、入口の起動待ちは 120 秒（replay の分の余裕を含む運用上の値で、端から端の保証ではない）、入れ替えの待ちは 180 秒の経過時間にしてある）。
**戻すのも同じ 1 箇所**（`inbound: false`）。無効にした Router は、その route・プロファイルを一覧から外し、発行済みの quote は支払いの前に `quote_changed` で止まる（journal の記録と予算は保つ）。

**送信（Arc・Solana の Provider に払う。送信の設計 §6、タスク U5・U9）**: 有効化の定数は方向別になった——`RAILS_ACTIVATION = { arc: { inbound, outbound }, solana: { inbound, outbound } }`
（受信は G-4 で両方 `true`、**送信は両方 `false`**。G-4′ でレールごとに `true` にする）。内部の env `SUBETHA_RAILS_ACTIVATION` と受け入れ用の起動の `--rails` の token も方向別
（`arc-in`・`arc-out`・`solana-in`・`solana-out`。旧い `arc`・`solana` は受け付けない）。受け入れ用の起動の既定は `arc-in,solana-in`。
Arc の送信: 鍵は Base と同じ `SUBETHA_OUTBOUND_X402_KEY`（既定は `SUBETHA_OUTBOUND_PRIVATE_KEY`。**その address に Arc testnet USDC が要る**。D-11）。
生成した設定に x402 の送信（route かプロファイル）があるときは常に子に渡す（以前は MPP 受信のときだけで、Arc／Solana 受信 → Base 送信の動的プロファイルに漏れていた）。
`arc.outbound: true` で動的プロファイル `dyn-x402-to-arc`（Base USDC で払う）と `dyn-mpp-to-arc`（Tempo pathUSD で払う。MPP 受信があるとき）が出る。静的 route `md-arc-eth-snapshot` は
Provider の URL（`tools/remote-mcp-config.ts` の `UPSTREAM_ARC`。Provider が立つまで空）と受取先（env `SUBETHA_ARC_PROVIDER_PAYTO`、`0x` の address）がそろったときだけ出る
（URL があるのに受取先が無い・形が違えば起動しない）。Arc USDC の予算の区分は受信か送信のどちらかが有効なら出て、両方向で**同じ区分に合算**する（D-14）。
段は受信と同じ（G-1′ 鍵と資金 → G-2′ 無効のまま配備 → G-3′ 受け入れの購入 → G-4′ 有効化。`docs/multirail-outbound-tasks.md` UG-A）。

**Solana の送信（送信の設計 §6.2〜§6.5、タスク U9。gate は UG-S）**: `solana.outbound: true`（token `solana-out`）で動的プロファイル `dyn-x402-to-sol`（Base USDC で払う）と
`dyn-mpp-to-sol`（Tempo pathUSD で払う。MPP 受信があるとき）が出る。静的 route `md-sol-eth-snapshot-mpp`（Tempo pathUSD → Solana の Provider。D-12 の O-4）は **MPP 受信があり**、
Provider の URL（`tools/remote-mcp-config.ts` の `UPSTREAM_SOL`。Provider が立つまで空）と受取先（env `SUBETHA_SOLANA_PROVIDER_PAYTO`、owner の base58 32 バイトの公開鍵）がそろったときだけ出る
（URL があるのに受取先が無い・形が違えば起動しない）。宛先は表の mint・桁・token program（`tokenDomain` は無い）。Solana USDC の予算の区分は受信か送信のどちらかが有効なら出て、両方向で**同じ区分に合算**する（D-14）。
鍵は **専用の** `SUBETHA_OUTBOUND_SOLANA_KEY`（ed25519 の seed。`npm run wallet:new:solana` が出す base58 32 バイト。D-11）: `solana-out` のときだけ読んで子に渡し、無効なら参照もしない。
無い・形が違えば process は固定文 `SUBETHA_OUTBOUND_SOLANA_KEY is required and must be a base58 seed …` で止まる（鍵の値は出ない）。
G-1′ の手順: (1) `npm run wallet:new:solana` で鍵を作り、ホストの env に `SUBETHA_OUTBOUND_SOLANA_KEY` として置く（journal と同じく他に写さない）。(2) **その address の USDC の ATA を運用者が作る**
（`spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <address>` 相当。rent は運用者。Router は ATA を作らない。**起動時に確かめるのは静的 route の宛先（Provider）の ATA だけ**で、
送信元（Router）の ATA の有無は起動では見ない——残高は購入ごとに `getTokenAccountBalance` で読み、ATA が無ければその購入が `operator_funds_unavailable` で止まる。起動の成功を送信元の ATA の存在の確認と読まないこと）。
(3) devnet USDC を入れる（https://faucet.circle.com → Solana Devnet / USDC）。残高は `getTokenAccountBalance <ATA>`（`solana` CLI なら `spl-token balance --owner <address> --url devnet 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`）。
送信は facilitator（x402.org）の fee payer が手数料を払うので **SOL は要らない**。Router は購入ごとに残高を 1 回読み（D-15）、足りなければ `operator_funds_unavailable` で受信の verify の前に止まる。
V-8b（実 facilitator の probe。資金が動く）は owner の承認で **公開の Router の外**で行い、G-3′ は公開の Router を止めて受け入れ用の起動（`--rails arc-in,arc-out,solana-in,solana-out`）で O-4 静的・O-3 動的・O-4 動的を各 1 件（`docs/multirail-outbound-tasks.md` UG-S）。
`RAILS_ACTIVATION` は **`solana.outbound: false` のまま**（G-4′ で `true` にする。`arc` は UG-A で承認された状態のまま）。

**G-1′ の記録（2026-10-08。両レール）**: owner が Arc・Solana の Provider（Cloudflare Workers、`providers/x402-workers/`。`docs/provider-x402-workers.md` §10）を配備した。
`UPSTREAM_ARC = https://provider-x402-arc.subethalabs.com/v1/eth/snapshot`、`UPSTREAM_SOL = https://provider-x402-sol.subethalabs.com/v1/eth/snapshot`（この PR の commit で固定）。
ホストの env に置く受取先: `SUBETHA_ARC_PROVIDER_PAYTO=0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1`、`SUBETHA_SOLANA_PROVIDER_PAYTO=4LrB4peq75FSg9UhSyfhp4onb6GMKgEtC3o3wndgguBc`（Solana の受取 ATA
`HnuscuMcYCh8urbQ83vYNd3vTH4VKMdBLCW52tt6J63E` は owner が作成済み。Router は `solana-out` の起動時にこの ATA を確かめる）。**まだ owner の作業として残るもの**: Arc 送信鍵（`SUBETHA_OUTBOUND_X402_KEY` の address）への Arc testnet USDC、
Solana 送信鍵（`wallet:new:solana` → `SUBETHA_OUTBOUND_SOLANA_KEY`）とその ATA・devnet USDC。送信の有効化（`outbound`）は両レールとも `false` のままなので、この commit の配備（G-2′）で公開の経路は変わらない。

**G-2′ の記録（2026-10-08 04:22Z。owner の決定「進めて良いです」）**: 送信鍵の資金は入った（Arc: 送信 address `0x5d78CBD6fFA81a5dBe435ccfC79271a0F6a42274` に 20 USDC、tx `0x65855a…18a4e`。
Solana: 送信鍵 `CLtWCWFy3dD8ufQoAnAFGfBxpThxbTearB77tyRzP9Vw`、ATA `2mpwiLPKbNSan8zsGNCNAngxXJuFHb3MfbeK17aiyyXf` に 20 USDC、faucet の tx は finalized。どちらも読取で確認）。
owner がホストの env に `SUBETHA_OUTBOUND_SOLANA_KEY`・`SUBETHA_ARC_PROVIDER_PAYTO`・`SUBETHA_SOLANA_PROVIDER_PAYTO` を足した（9 行、root 0600。鍵は形だけ確認）。
イメージ `b-f0c9f0e`（main `f0c9f0e`: Provider の URL、静的 x402 の有料要求 30 秒、`outbound` は両レールとも `false`）は手元（arm64）で build し `docker save`/`load` で入れた。
ホスト側の image ID は手元と違う（image store の方式の違い）が、**14 層の内容ハッシュはすべて一致**。`swap-image.sh` で入れ替え: 04:22:00Z 開始、04:22:09Z 終了、exit 0、
journal の先頭 93,818 バイトは不変、`subetha-egress check` 合格、子の listening 行あり、`could not start` 0 行。rollback は `subetha-router-prev-20261008T042200Z`（`b-ce7de77`）。
確かめたこと: コンテナは healthy、公開 MCP の一覧は 4 route・6 プロファイルのまま、既存 route の quote が成立（支払わない）、**子プロセスの env は `SUBETHA_RAILS_ACTIVATION=arc-in,solana-in` で、
Solana の送信鍵も 2 つの受取先も子には渡っていない**（`/proc/<pid>/environ` の名前だけを見た）。次は G-3′（受け入れの購入。公開の Router を止めて行う。owner の確認）。

**G-3′ の記録（2026-10-08 04:35–04:42Z。両レール。owner の決定「進めて良いです」、MPP の 3 件も明示の承認）**: 公開の Router を止め（04:35:01Z。直前の journal に進行中の購入なし）、
同じイメージ `b-f0c9f0e`・同じ env から受け入れ用を `--rails arc-in,arc-out,solana-in,solana-out` で単独起動した。**4 レールの起動時の検査（x402.org の `/supported`、受信・送信の両方の devnet の ATA、Tempo の probe）は本番 env で通った**。
egress check 合格。一覧は route 6・プロファイル 10。手元からは ssh トンネルで MCP に接続し、quote → credential → purchase → status を 1 件ずつ（driver は私的な script。payer は使い捨て: Base USDC `0xEd5F…`、Tempo pathUSD `0xfCea…`）。
結果（6 本すべて **delivered**。Provider は owner が配備した Worker。**証拠の出所**: 結果・額・txRef・所要・`PAYMENT-RESPONSE` の中身・本文の鍵は purchase と status の応答の記録（`.claude_workflow/local/g3p-*.json`）、
block・slot・finalized・転送の内容・残高は私が explorer / RPC を読取で見た値、起動時の検査・egress・停止時間はホスト側のログ。受信は Base Sepolia（`eip155:84532`）と Tempo Moderato（`eip155:42431`）。）:

| # | 経路 | payer | 受信の tx | Router → Provider の tx | purchase の所要 |
|---|---|---|---|---|---|
| 1 | `md-arc-eth-snapshot`（静的、O-1） | Base USDC 10,000 | Base `0xbc0ff26b…` | Arc `0x8db28dad…`（block 66080235、`transferWithAuthorization`、`0x5d78…` → `0x719e…` 10,000） | 5.4 s |
| 2 | `dyn-x402-to-arc` + Arc Worker の URL（O-1 動的） | Base USDC 11,000 | Base `0xc8ae69f8…` | Arc `0xccd44647…`（block 66080265、10,000） | 5.0 s |
| 3 | `dyn-mpp-to-arc` + Arc Worker の URL（O-2 動的） | pathUSD 11,000（MPP） | Tempo `0xefe450c0…`（block 38661072） | Arc `0x5263776b…`（block 66080573、10,000） | 4.3 s |
| 4 | `md-sol-eth-snapshot-mpp`（静的、O-4） | pathUSD 10,000（MPP） | Tempo `0xa6eece13…`（block 38661101） | Solana `2iDWk9o4…`（finalized、slot 508699248） | 3.3 s |
| 5 | `dyn-x402-to-sol` + Solana Worker の URL（O-3 動的） | Base USDC 11,000 | Base `0x993e35d5…` | Solana `42zkNQgS…`（finalized、slot 508699324） | 3.2 s |
| 6 | `dyn-mpp-to-sol` + Solana Worker の URL（O-4 動的） | pathUSD 11,000（MPP） | Tempo `0x1062f29b…`（block 38661141） | Solana `2pi7iKfw…`（finalized、slot 508699347） | 2.6 s |

- 本文は 6 件とも記録済みの Provider A の契約の鍵（`providerId`・`market`・`dataSource`・`payment`・`fetchedAt`・`data`）で、`payment.network` は Arc / Solana の値。動的の 4 件の `proof` は `upstreamReceipt: claimed`、`onChainFinality: not_checked`（静的の応答には `proof` の欄が無い）。
- **V-13**（Provider の有料応答）: 6 件とも Provider の応答は成功（Router が `paid` にした = 200 と領収。Router は生の HTTP 状態を記録しない）で、`PAYMENT-RESPONSE` は `{ success: true, transaction, network, payer }`（`payer` は Router の送信鍵: Arc `0x5d78…`、Solana `CLtW…`）。
  Router の purchase 全体（受信の settle から配達まで。Provider の verify・settle を含む端から端の値で、Worker の settle 単体の計測ではない）の所要は 2.6〜5.4 秒。pending の結果は観測していない。
- 残高の増分: Arc の受取 `0x719e…` 0 → 0.03 USDC（3 件 × 0.01）、Solana の受取 ATA `Hnus…` 0 → 0.03 USDC、Router の Solana 送信 ATA 20 → 19.97。
- **1 回目の失敗 2 件**: (a) #1 の最初の試みは `source_rejected`（受信の settle の段。journal は `source_pending` → `budget_reserved` → `source_failed`。payer の Base Sepolia に転送は無く、同じ payer・同じ offer で x402.org の `/verify` を私が直接呼ぶと `isValid: true`）。原因は特定できていない（Router は facilitator の応答本文を記録しない）。新しい quote での再試行は delivered。
  (b) #3 の最初の試みは **私の driver が MPP の credential を Router の封筒（`sign-run.ts` の形）に入れずに送った**ため Router が `invalid_payment_header`（400）で拒んだ。MPP は署名の時点で送金するので、
  payer の 0.011 pathUSD は Router の受取先 `0x9b10…` に移り（Tempo `0xd94e667c…`、block 38660842）、購入は成立していない（運用者の受取先に入ったので運用者の損失ではない。quote の `ownerKey` を driver が保存していなかったので同じ quote への出し直しはできなかった）。driver を直して新しい quote で成功。
- 終了: 04:42:01Z 受け入れを stop（exit 1 = SIGTERM、残プロセス無し）→ 公開を start → `/healthz` 200 → egress check 合格 → caddy start → 公開 `/healthz` 200 → 受け入れコンテナを rm。**公開の停止は約 7 分**。ホスト側ログは `~/g3p-acceptance-host.log`、受け入れの journal は `/var/lib/subetha-router/acceptance/journal.ndjson`。
- AC-11 の前提（UG-A・UG-S の G-3′）は両レールとも満たした。次は G-4′（`RAILS_ACTIVATION` の `outbound` を `true` にする PR と入れ替え。owner の判断）。

**G-4′ の記録（2026-10-08 05:04Z。owner の決定「進めて良いです」）**: PR #92（`24bae1a`。Codex のレビュー APPROVE WITH CHANGES の文書の訂正を反映、Linux の full suite 1773 passed）で
`RAILS_ACTIVATION` を `{ arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true } }` に。イメージ `b-24bae1a` は手元（arm64）で build して `docker save`/`load`（14 層の内容ハッシュ一致）。
`swap-image.sh` で入れ替え: 05:04:06Z 開始、05:04:15Z 終了、exit 0、journal の先頭 95,716 バイトは不変、`subetha-egress check` 合格、子の listening 行あり、`could not start` 0 行。rollback は
`subetha-router-prev-20261008T050406Z`（`b-f0c9f0e`。それより古い prev `b-ce7de77`・`b-4d2c925` も残っている）。起動時の検査（受信の `/supported`・ATA、送信の Provider の ATA、Tempo の probe）は本番 env で通り、
子プロセスの env は `SUBETHA_RAILS_ACTIVATION=arc-in,arc-out,solana-in,solana-out` で Solana の送信鍵が渡っている（受取先は設定に入る。`/proc` の名前だけを見た）。
**AC-11**: 公開 MCP を HTTPS で呼び、一覧は **route 6 本**（従来の 4 + `md-arc-eth-snapshot`・`md-sol-eth-snapshot-mpp`）・**プロファイル 10 本**（従来の 6 + `dyn-x402-to-arc`・`dyn-mpp-to-arc`・`dyn-x402-to-sol`・`dyn-mpp-to-sol`）。
新しい 6 組は各 1 回 quote を取り（支払わない）、`subject` の network・asset・decimals・額（静的 10,000、動的は上流 10,000 + 手数料 1,000 = 11,000）、宛先の受取先（Arc `0x719e…`、Solana `4LrB…`）と `disclosures`
（MPP の組は `fundsMoveOnCredential: true`・`awaitingPaymentDoesNotMeanUnpaid: true`）が設定どおり。動的の 4 件目の quote は入口の `rate_limited` に 1 回当たり、20 秒後の再試行で成立。
**これで多レールの送信の rollout は完了**（Arc・Solana の受信と送信がすべて公開）。残高の運用: Router の送信資金は Arc 20 USDC・Solana 19.97 USDC（1 件 0.01 USDC。尽きれば `operator_funds_unavailable` で受信の verify の前に止まる）。

**実施の記録（G-4、2026-10-07 11:03Z。owner の決定「進めて良いです」）**: PR #68（`ce7de77`）で `RAILS_ACTIVATION = { arc: true, solana: true }`。
イメージ `b-ce7de77` は手元で作った（§6。製品のファイルは PR の最初の試験済みの commit から変えていないことを `git diff` で確かめ、読み込み済みのイメージに tag を付け直した）。
入れ替えは `deploy/swap-image.sh`（Codex のレビュー 7 回: #1 は有効化の変更に APPROVE WITH CHANGES、#2〜#6 は script の失敗時の扱いに REJECT、#7 で APPROVE WITH CHANGES を反映。
加えて偽の docker・systemctl・curl による 12 通りの模擬実行で、exit 0/1/2 の各経路と「ログの中身が出ない」ことを確かめた）。結果: 11:03:26Z 開始、11:03:37Z 終了、exit 0。
入口の閉鎖は約 7 秒。journal の先頭 93,818 バイトは不変、`subetha-egress check` 合格、子の listening 行あり、`could not start the Router` 0 行。
rollback は `subetha-router-prev-20261007T110330Z`（`b-4d2c925`。それより古い prev は削除）。公開の MCP を HTTPS で直接呼んで確認: route 4 本
（`md-mpp-eth-snapshot-arc` の受取 `0xAF42…b4Ea`、`md-x402-eth-snapshot-sol` の受取 `GHGd…sg4d`）、動的プロファイル 6 本、`dynamic.enabled: true`。
**AC-6（公開の有効化）はこれで満たした。**

**有効にした後に見るもの**（hosted の入口は Router の process の stderr を転送しないので、**ログの不在は成功の証拠にならない**。見るのは次の口）:
起動の成否は `docker logs` の `router: {"event":"listening",...}` の有無（Solana の起動時の検査が落ちれば Router は起動せず、入口は `could not start the Router` で終わる。
理由は上記のとおり `tools/remote-router-process.ts` を直接起動して読む）。稼働中は journal（ボリュームの `journal.ndjson`）の終端: `unknown`（settle の要求の後の失敗。自動で再 settle しない。
**facilitator が止まれば資金は動かない、とは言えない**）と、`subetha_router_status` の射影。Circle の trial が尽きた（HTTP 403 `registration_required`）ときの診断
`facilitator diagnostic facilitator_trial_exhausted` と、動的 URL が Circle・x402.org・Solana RPC に向いたときの `destination_blocked` は Router の process の stderr にしか出ない——
hosted では journal の `unknown` と呼び出し側への `url` の拒否として現れる。Solana の settle が `settlement_pending` でも、Router は設定の RPC で最長 15 秒
確定を追い、確定すれば `delivered` に進む（設計 §5.8、D-9。診断 `svm_settle_followed_up` も Router の process の stderr にしか出ない。**journal では追跡で確定した settle と facilitator が直接成功を返した settle を
区別できない**（どちらも `source_settled`）ので、hosted の Router で追跡が働いた回数は分からない。数えられるのは、受け入れ用の起動のように stderr が読める起動だけ）。

### 2d. Solana の MPP（Solana devnet USDC を **MPP** で受ける・払う）— **コードは入っているが本番では無効**（M6、2026-10-08。有効化は G-4″）

呼び出し側が **Solana devnet の USDC を MPP（`solana/charge`、pull）** で払って既存の Provider A（x402）・B（MPP）に届く**受信**と、Router が **Provider D**
（運用者の pay-kit の server、`solana/charge`、pull、**`feePayer: true`** = Provider の fee payer が共同署名して送出する）に Solana devnet の USDC を MPP で払う**送信**（要件 `mpp-solana-requirements.md`、設計 `mpp-solana-design.md`、
タスク `mpp-solana-tasks.md`）。x402 の Solana（§2c）とは別のレールで、**同じ受取 owner・同じ送信鍵・同じ RPC・同じ Solana USDC の予算の区分**を共有する。

**有効・無効は §2c と同じ 1 つの定数**: `tools/remote-mcp-config.ts` の `RAILS_ACTIVATION.solanaMpp = { inbound, outbound }`（M6 の配備では両方 `false`。内部の token は
`solana-mpp-in`・`solana-mpp-out`。受け入れ用の起動は `--rails solana-mpp-in,solana-mpp-out` で選ぶ）。有効にすると入口が登録するもの:

| 向き | 静的 route | 動的プロファイル | 条件 |
|---|---|---|---|
| 受信（`solanaMpp.inbound`） | `md-x402-eth-snapshot-solmpp`（Solana USDC/MPP 10,000 → Provider A/x402）、`md-mpp-eth-snapshot-solmpp`（→ Provider B/MPP） | `dyn-solmpp-to-x402`・`dyn-solmpp-to-mpp`、Arc／Solana の送信が有効なら `dyn-solmpp-to-arc`・`dyn-solmpp-to-sol` | `SUBETHA_MPP_INBOUND_SECRET` が**必須**（Tempo の MPP 受信と同じ HMAC の秘密。無ければ入口が固定文で止まる） |
| 送信（`solanaMpp.outbound`） | `md-solmpp-eth-snapshot`（Base USDC/x402 → Provider D）、`md-solmpp-eth-snapshot-mpp`（Tempo pathUSD/MPP → Provider D。MPP 受信があるとき） | `dyn-x402-to-solmpp`・`dyn-mpp-to-solmpp`、Arc／Solana の受信が有効なら `dyn-arc-to-solmpp`・`dyn-sol-to-solmpp`（宛先は `solana/charge`。`feeAsset`・`maxFee` は無い: Router はこの送信にチェーン手数料を払わない） | 静的 2 本は **定数 `UPSTREAM_SOL_MPP`（Provider D の URL。D が立つまで空）と env `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`** がそろったときだけ。動的は URL に関係なく出る |

**env**（新しいのは Provider D の受取 owner だけ。他は §2c と同じ名前・同じ値）:

| env | いつ要るか |
|---|---|
| `SUBETHA_MPP_INBOUND_SECRET`（既存） | Tempo の MPP 受信 **または** `solana-mpp-in`。子には `ROUTER_MPP_INBOUND_SECRET` として渡る |
| `SUBETHA_SOLANA_RECEIVER`（既存） | `solana-in` **または** `solana-mpp-in`（同じ受取 owner。ATA は運用者が作る。Router は起動時に ATA を 1 回確かめ、無ければ起動しない） |
| `SUBETHA_OUTBOUND_SOLANA_KEY`（既存） | `solana-out` **または** `solana-mpp-out`（同じ鍵・同じ能力 1 つ。どちらも無効なら読まない・渡さない）。MPP の送信では Router の鍵は転送に署名するだけで **SOL は要らない**（送出と手数料は Provider D の fee payer）。USDC の残高は要る |
| `SUBETHA_SOLANA_RPC_URL`（既存） | Solana のどの向きでも（起動時の ATA の検査、受信の `transaction` 型の送出と追跡、`signature` 型の読み取り、送信の blockhash・残高・receipt の照合） |
| `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`（**新**） | `solana-mpp-out` ∧ `UPSTREAM_SOL_MPP` ≠ ""（Provider D の受取 owner の公開鍵。D の URL が定数に入るまで読まれない） |

**gate（要件 §8。AC-17・AC-18。owner の作業と並行）**:

1. **G-1″（owner）**: Provider D を devnet で立てる（pay-kit の server。`solana/charge`、**`feePayer: true`**（Provider の fee payer が送出する pull。Router は `feePayer: false` の challenge を `mode` で拒む: 設計 §4.2 の 6）。`externalId` の有無は任意——Router は無くても払う。
   受取 owner の ATA は運用者が作る。置き場は Node か Workers。D-26）。URL を定数 `UPSTREAM_SOL_MPP` に入れ、受取 owner を `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO` に。
   Router の送信鍵（`SUBETHA_OUTBOUND_SOLANA_KEY` の address）の ATA に devnet USDC（Router は起動時に自分の ATA も確かめる）
2. **G-2″（配備。無効のまま）**: M6 を含むイメージに入れ替える（§2c と同じ `deploy/swap-image.sh`。rollback の container を 1 つ保つ）。確かめるのは「公開の一覧が従来の route 6・プロファイル 10 のまま」、
   子プロセスの env に `solana-mpp-*` の語が無いこと、`subetha-egress check` 合格。Solana の MPP の起動時の検査は無効なので動かない
3. **G-3″（受け入れ。testnet の資金のみ。公開の Router を止めて受け入れ用の起動で。§2c の手順と同じ）**: `--rails solana-mpp-in,solana-mpp-out`（Provider D が無ければ `solana-mpp-in` だけ）。
   受信: 使い捨ての payer（**devnet USDC と devnet SOL**。`npm run wallet:new:solana` の案内）で静的 `md-x402-eth-snapshot-solmpp` と動的 `dyn-solmpp-to-x402` を各 1 件、
   `npm run sign`（署名だけ。送出は Router の purchase）→ `delivered`。証拠: journal の `source_settled` の `txRef`（= payer の transaction の署名）が devnet で confirmed／finalized、
   受取 owner の ATA の残高の増分、`sendTransaction` が 1 回（受け入れ用の起動では Router の stderr が読めるので診断行も見る）。
   送信: 静的 `md-solmpp-eth-snapshot` と動的 `dyn-x402-to-solmpp` を各 1 件 → `delivered`。証拠: receipt の署名が devnet で confirmed、Provider D の ATA の残高の増分、
   `proof.upstreamReceipt: "claimed"`。**U-13**: Provider D の確定待ち（pay-kit の server の 30 秒）の実測を記録し、45 秒（`MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS`）で足りなければ定数を変える
4. **G-4″（owner の判断）**: `RAILS_ACTIVATION.solanaMpp` を方向別に `true` にして（片方だけでもよい）イメージを作り直し、`swap-image.sh` で入れ替える。
   公開 MCP の一覧で route +4（送信の静的 2 本は Provider D の URL と受取 owner があるとき）・プロファイル +8 を確かめ、各 1 回 quote を取る（支払わない）。
   `subject` の `fundsMoveOnCredential` は受信の MPP Solana でも `true`（別の client が `signature` 型を出せば credential の時点で動く。CLAUDE.md の開示のとおり）

**G-1″ の記録（2026-10-08）**: Provider D は `providers/mpp-solana-workers/`（Cloudflare Workers。pay-kit の server を包む。設計・試験・配備は `docs/provider-mpp-solana-workers.md`、実装 PR #108、値 PR #109）。
owner が script で鍵を作り（fee payer の seed は Worker の secret `FEE_PAYER_KEY` にだけ、受取 owner の seed は owner の file にだけ、HMAC の秘密は secret `MPP_SECRET`）、`wrangler deploy`（version `fc901ca8-521e-4be8-ba2b-82be78f3227a`、
upload 3,051 KiB / gzip 518 KiB、起動 55 ms、custom domain `provider-mpp-sol.subethalabs.com`）。受取 owner `26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc`、fee payer `DAmvTYsraoup88EJvs3KK3gFYfofULevXVGjz2wXM5gS`（devnet SOL 1.0）、
受取 ATA `MUbNoZ9cjg2vtwEJxbnChk315fhj1daMYEumWKDCR4S`（owner が devnet で作成、signature `3M1VCrCwHV43ATzimfzMZYApE5WL3xEz3YtWuwxedVzgo5gPp6Gk7S2TQBjHxRPAV7YvVuHwvGCmUSLDwLVgD4qm`。`getAccountInfo`（finalized）で owner・mint・Token program・`initialized` を確認）。
**AC-PD3**: 公開 URL の未払い GET を 2 回（0.59 秒・0.67 秒）: どちらも 402、`cache-control: no-store`、`content-type: application/json`、`WWW-Authenticate` は `method="solana"`・`intent="charge"`・`realm="subetha-provider-mpp-sol"`、
`request = { amount: "10000", currency: <devnet USDC>, recipient: 26jZd9…, methodDetails: { decimals: 6, feePayer: true, feePayerKey: DAmvTY…, network: "devnet", tokenProgram: Tokenkeg… } }`（`externalId`・`opaque` 無し）、`expires` は約 300 秒、2 回で変わるのは `id` と `expires` だけ。
Router の候補の検査（`checkMppSolanaChallenge` に本番の運用者の集合 = Solana の受取 owner・送信鍵とその ATA・x402 Provider の受取先とその ATA）を手元で掛けて**候補**、ATA の不等式も通る。別のパス・HEAD は 404。
この PR で `UPSTREAM_SOL_MPP` を定数に入れた（`solanaMpp.outbound` は `false` のままなので公開の経路は変わらない）。**残る owner の作業**: ホストの env に `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO=26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc` を足す（G-2″ の配備の前）。

**rollback**: 定数を `false` に戻してイメージを作り直す（§2c と同じ。env は残してよい——無効なら読まれない）。

**有効にした後に見るもの**（§2c の注と同じく、hosted の入口は Router の process の stderr を転送しない）: 受信の `transaction` 型で Router が送出した後に確定を観測できなかった purchase は
journal に `unknown`（`source_settle_unknown`）、**verify の後**に期限・予算で止まった `signature` 型（資金は動いている）は `unknown`（`source_paid_unsettled`）で残る。
どちらも Router は再送しない。呼び出し側には「`rejected` も `unknown` も未送金の証明ではない」と案内してある（CLAUDE.md）。診断（`solana mpp diagnostic …`）は受け入れ用の起動でだけ読める。

### journal を残す（`-v` は必須）

R4（`subetha_router_status`）は**保存 → 再オープン**を謳っている。journal が消えると
**過去の paymentId が 404 になり、その主張が成立しない**。

**`-v` を使うなら、先にディレクトリを作って `chown` すること。順序が逆だと起動しない。**

```sh
sudo mkdir -p /var/lib/subetha-router
sudo chown 10001:10001 /var/lib/subetha-router   # コンテナの非 root uid
ls -ld /var/lib/subetha-router                   # 10001 10001 になっていること
```

**`chown` を飛ばすと Docker が root 所有で自動作成し、コンテナ内の uid 10001 が
journal を書けずに落ちる**（`/healthz` が無応答になる。実際に踏んだ）。
その場合は `chown` してから `docker restart` すれば復旧する。

`-v` を付けずに起動すると、**コンテナを作り直した時点で全記録が消える**。
（以前は起動側が `mkdtemp` で毎回別ディレクトリを作っていたため、
`-v` の有無に関係なく**プロセス再起動だけで消えていた**。これは修正済み。）

**承認期限と offer 期限は短いほうが効く**（`min(approvalTtlMs, offerExpiry)`）。
片方だけ伸ばしても実効期限は変わらない。人間が承認を挟む運用では、
読み上げや確認で数分かかるため**5 分では承認前に失効する**（実測）。既定はどちらも 600 秒。

### Tempo の RPC を認証付きにする（推奨）

Router は送金の前に chainId / nonce / 見積りをチェーンから読む。公開エンドポイント
（`rpc.moderato.tempo.xyz`）を Cloudflare のような共有 egress IP から叩くと
**レート制限に当たりやすく**、送信レグが不安定になる。

```sh
  -e SUBETHA_TEMPO_RPC_URL=https://<network>.g.alchemy.com/v2/<key> \
```

**URL 自体が資格情報**（パスに API キーを含む）。起動ログには
`tempo rpc: configured` / `public (...)` としか出さず、**URL は出力しない**。

未設定でも起動して動作する（既定の公開 RPC を使う）。

### MPP 受信（逆向きの経路）を公開する

既定は **x402 受信 → MPP 送信** の 1 経路だけ。
**MPP 受信 → x402 送信** も出すには、秘密を 1 本足すだけでよい
（x402 送信は既定で `SUBETHA_OUTBOUND_PRIVATE_KEY` を流用する）:

```sh
# 32 バイト以上の秘密を作る（署名鍵ではないが秘密。使い回さない）
openssl rand -hex 32
```

```sh
  -e SUBETHA_MPP_INBOUND_SECRET=<上で作った値> \
  -e SUBETHA_OUTBOUND_X402_KEY=0x<Base Sepolia USDC を持つ鍵> \
```

**片方だけでは経路は増えない**（起動ログにその旨が出て、既存経路だけで動き続ける）。
これは意図した挙動: 送信レグの資金が無い経路を公開すると、購入が受信レグの支払い後に
失敗し得るため、**最初から出さない**。

有効にすると route が 2 本になる:

| routeId | 受信 | 送信 |
|---|---|---|
| `md-mpp-eth-snapshot` | x402（Base Sepolia USDC） | MPP（Provider B） |
| `md-x402-eth-snapshot` | MPP（Tempo pathUSD） | x402（Provider A） |

**呼び出し側（審査員）の鍵はこのコンテナに渡さない。** 受信レグの署名は呼び出し側の手元で作られ、
サーバには**署名済みの credential だけ**が届く（`inbound payer: the caller's own key` と起動ログに出る）。

### journal が効いているか確かめる

起動しただけでは足りない。**決済を 1 回通してからファイルを見る。**

```sh
ls -la /var/lib/subetha-router/     # journal.ndjson にサイズがあること
wc -l /var/lib/subetha-router/journal.ndjson
```

`journal.ndjson` が 0 バイトのままなら、Router は別の場所に書いている。
`remote-XXXXXX` というディレクトリが増えるのは**正常**（config と証拠ログ用の
使い捨て領域で、journal はそこには置かない）。

最終確認は **`docker restart` してから同じ paymentId を R4 で読む**こと。
読めれば成立、404 なら経路がどこかで切れている。

## 3. 動作確認

```sh
curl -s http://127.0.0.1:8787/healthz     # → {"status":"ok","router":"up"}
docker logs subetha-router | tail -3      # → mode=real / label=real / inboundPayer=none
```

## 4. 審査員が使う

```sh
claude mcp add --transport http subetha-router https://<domain>/mcp
```

clone も `npm install` も不要。**支払いは審査員自身の鍵**で、署名は手元で作られる。

## 5. EC2 の具体的な構成

### インスタンス

| 項目 | 推奨 | 理由 |
|---|---|---|
| タイプ | **t4g.small**（arm64 / 2 vCPU / 2 GiB） | 実測でコンテナは**アイドル約 192 MiB・CPU 0.1%**。2 GiB あればビルドも通る |
| AMI | **Amazon Linux 2023（arm64）** | t4g は Graviton = arm64 |
| ストレージ | **gp3 20 GiB** | イメージ 638 MB + `node_modules` 198 MB + 余裕 |
| リージョン | `ap-northeast-1` 等、どこでも可 | |

**x86 を使う場合は `t3.small` + x86_64 AMI**。どちらでも動くが、**AMI とインスタンスの
アーキテクチャを揃えること**（`docker build` はインスタンス上で行うので、そこで合う）。

### セキュリティグループ

| 方向 | ポート | ソース | 用途 |
|---|---|---|---|
| inbound | **443** | `0.0.0.0/0` | 審査員がここに繋ぐ |
| inbound | 22 | **自分の IP のみ** | SSH |
| outbound | all | — | facilitator / RPC / Provider に出る |

**8787 は開けない。** TLS 終端の背後に置く。

## 6. デプロイ手順（インスタンスに SSH して実行）

```sh
# 1) Docker
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user && exec sudo su - ec2-user   # グループ反映

# 2) 取得してビルド（インスタンス上でビルドするのでアーキテクチャは自動で合う）
git clone https://github.com/subetha-labs/subetha-router.git
cd subetha-router
docker build -t subetha-router .

# 3) 鍵を EnvironmentFile に置く（シェル履歴とプロセス一覧に残さない）
sudo install -m 600 /dev/null /etc/subetha-router.env
sudo tee /etc/subetha-router.env >/dev/null <<'ENVEOF'
SUBETHA_OUTBOUND_PRIVATE_KEY=0x...
SUBETHA_ROUTER_RECEIVER=0x...
ENVEOF

# 4) 起動（env ファイルは root 所有 600 なので **sudo が要る**）。
#    先に §8b.2 の egress 制御を設置してから。Router は専用 network に**単独**で置く（§8b.1 の前提）。
#    journal は §2 のとおりボリュームに置く（`-v` が無いとコンテナ削除で全記録が消える）
sudo mkdir -p /var/lib/subetha-router && sudo chown 10001:10001 /var/lib/subetha-router
sudo docker network inspect subetha-router-net >/dev/null 2>&1 || \
  sudo docker network create --driver bridge -o com.docker.network.bridge.name=subetha0 subetha-router-net
sudo docker run -d --name subetha-router --restart unless-stopped \
  --network subetha-router-net \
  -p 127.0.0.1:8787:8787 \
  -v /var/lib/subetha-router:/app/runtime \
  --env-file /etc/subetha-router.env \
  subetha-router

# 5) 確認
curl -s http://127.0.0.1:8787/healthz         # → {"status":"ok","router":"up"}
sudo docker logs subetha-router | tail -3     # → mode=real / label=real / inboundPayer=none
```

`--env-file` は **docker クライアントを実行したユーザが読む**ので、600 の root 所有ファイルには
`sudo docker` が必要（`permission denied` はこれが原因）。
鍵ファイルの権限を緩めるより `sudo` を付ける方が安全。以降 `docker ps` / `docker logs` も `sudo` 付きになる。

`-p 127.0.0.1:8787:8787` としているので、**8787 は外から直接叩けない**（プロキシ経由のみ）。

## 7. TLS とドメイン（Caddy が最短）

```sh
sudo dnf install -y caddy    # 無ければ https://caddyserver.com/docs/install
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDYEOF'
router.subethalabs.com {
    reverse_proxy 127.0.0.1:8787
}
CADDYEOF
sudo systemctl enable --now caddy
```

Caddy が **Let's Encrypt の証明書を自動取得**する。事前に DNS の **A レコード**を
`router.subethalabs.com` → インスタンスの **Elastic IP** に向けておくこと
（Elastic IP を割り当てないと再起動で IP が変わる）。

確認:
```sh
curl -s https://router.subethalabs.com/healthz
```

## 8. 審査員への案内

```sh
claude mcp add --transport http subetha-router https://router.subethalabs.com/mcp
```

## 8b. egress 制御（SSRF 防御 B。設計は `ssrf-egress-design.md` §25、レビュー #10 で承認）

Router のコンテナから**内部宛先へ届くパケットを 0 にする** host 側の規則。Router のコードは変えない。
namespace 内の宛先（loopback、自アドレス）は host から見えないので **A（アプリ側）の担当**であり、
**B だけでは要件 INV-1'' は完成しない**（`ssrf-requirements.md` §9）。AI が上流 URL を指定する機能は、
B と A の両方が通るまで出さない。

### 8b.0 Docker の版と、既存ホストの扱い（本番受け入れで見つかった前提。2026-10-05）

**egress 制御は Docker 28.2 以上を前提にする**（設計の実測は 28.3.3。runner の V7-15 は `docker info` の `FirewallBackend.Driver` が
`iptables` であることを要求する。このフィールドは 28.1.0 で入った。28.2 以上はこの手順の方針。DNS の出所は V7-8 が稼働版で再測定する）。
**AL2023 のリポジトリの `docker` は 25.0.x しか無く、そのままでは受け入れは通らない**（§6 手順 1 の `dnf install -y docker` は
egress 制御を入れない構成用）。29 系は未測定なので 28 系に固定する。

**既存ホストの Docker をその場で入れ替えない。** 入れ替えと降格の手順を書いてリハーサルしたが（同じコンテナ ID で復帰、戻しも通った）、
独立レビューで中断・再起動・作り直しの経路に未解決の指摘が残った（2 回 REJECT）。**新しいホストを作り、受け入れを通してから切り替える**
（§8b.6）。新しいホストでは Router を作る前に、次のブロックを**ファイルに保存して `sudo bash -e <file>` で実行する**（shebang を貼るだけでは
失敗で止まらない）。Docker の公式手順が対象にするのは CentOS Stream で、AL2023 は対象外: これは **運用者が検証した別ディストリビューションへの導入**であり、
根拠は §8b.4 をこの版・この host で通した結果だけである（28.3.3 での実測は代わりにならない）:

```sh
#!/bin/bash -e
set -o pipefail
# Docker 公式の署名鍵は指紋を照合してから登録する（docs.docker.com/engine/install/centos）
curl -fsS -m 30 https://download.docker.com/linux/centos/gpg -o /tmp/docker.gpg
FP=$(gpg --show-keys --with-colons /tmp/docker.gpg | awk -F: '$1=="fpr"{print $10; exit}')
[ "$FP" = 060A61C51B558A7F742B77AAC52FEB6B621E9F35 ]
install -m 644 /tmp/docker.gpg /etc/pki/rpm-gpg/docker-ce.gpg
rpm --import /etc/pki/rpm-gpg/docker-ce.gpg
# CentOS 9 用のリポジトリ（AL2023 の $releasever は使えないので 9 に固定）
printf '[docker-ce-stable]\nname=Docker CE Stable (el9)\nbaseurl=https://download.docker.com/linux/centos/9/$basearch/stable\nenabled=1\ngpgcheck=1\ngpgkey=file:///etc/pki/rpm-gpg/docker-ce.gpg\n' > /etc/yum.repos.d/docker-ce.repo
dnf install -y --setopt=install_weak_deps=False docker-ce-28.5.2-1.el9 docker-ce-cli-28.5.2-1.el9 containerd.io-2.3.6-1.el9
dnf install -y 'dnf-command(versionlock)'
dnf versionlock add docker-ce docker-ce-cli containerd.io
LOCKS=$(dnf versionlock list | grep -cE '^(docker-ce|docker-ce-cli|containerd\.io)-' || true)
[ "$LOCKS" = 3 ]
systemctl enable --now docker
V=$(docker version --format '{{.Server.Version}}'); [ "$V" = 28.5.2 ]
FB=$(docker info --format '{{.FirewallBackend.Driver}}'); [ "$FB" = iptables ]
LR=$(docker info --format '{{.LiveRestoreEnabled}}'); [ "$LR" = false ]
echo "docker-ce $V installed (backend $FB) and version-locked"
```

セキュリティ更新は、新しい版で §8b.4 を通してから固定を付け替える（自動では上がらない）。

### 8b.1 前提（runner が検証する。満たさなければ運用に入らない）

- Docker の firewall backend が `iptables`（`docker info --format '{{.FirewallBackend.Driver}}'`）。`iptables` コマンド（nft 版で可）
- `docker info --format '{{.LiveRestoreEnabled}}'` が `false`（既定）。firewalld が無いか無効。`userland-proxy` を daemon.json で `false` にしない
- **Router の DNS を上書きしない**（`--dns` を付けない、daemon.json に `dns` を書かない）。
  埋め込み resolver は host から継承した nameserver へ **host の namespace から**問い合わせる（上書きするとコンテナ側から出て落ちる）
- Router は専用 network `subetha-router-net`（bridge `subetha0`、RFC1918 の subnet）に**単独**で置く。他のコンテナを同じ network に付けない
- IPv6 は bridge で無効（既定）。有効化は本手順の対象外（runner が FAIL にする）
- **host が応答する全アドレス**のうちインタフェースに無いもの（EC2 の公開 IPv4 / Elastic IP）を `HOST_ADDRS4` に書く。
  インタフェース上のアドレスは `apply` が毎回自動で集める。公開 IPv4 は **IMDS から読み、読めなければ設置を中止する**（推測しない）
- 検証に使う **外部 observer**: VPC 内の別 host（RFC1918 アドレス、**Linux、`ss` あり**）で `deploy/egress/egress-observer.py` を動かす。
  Router host からその両ポートに届くこと（SG）

### 8b.2 設置（Router 停止中に。初回は Router を作る前に）

次のブロックを**ファイルに保存して `sudo bash -e` で実行する**（対話シェルに貼ると、途中の失敗で止まらない）。
どの段階でも失敗したら、そこで終わる。先に進めるために既定値で埋める箇所は無い。

```sh
#!/bin/bash -e
# 0) 依存（runner と補助 unit が使う）と preflight。無いものがあれば終了
# curl は入れない: AL2023 は curl-minimal が同梱で、`curl` パッケージを指定すると衝突して止まる（本番受け入れで判明）。直後の検査が存在を確かめる
dnf install -y iptables-nft tcpdump conntrack-tools strace python3 util-linux diffutils
for t in iptables ip6tables iptables-restore tcpdump conntrack strace flock python3 curl ss cmp sha256sum awk tar sync findmnt readlink; do command -v $t >/dev/null || { echo "MISSING: $t"; exit 1; }; done

# 1) 成果物（リポジトリの checkout の直下で実行する。sudo は cwd を保つ）
[ -f deploy/egress/subetha-egress ] || { echo "run this from the subetha-router checkout"; exit 1; }
install -m 755 deploy/egress/subetha-egress deploy/egress/subetha-egress-verify /usr/local/sbin/
mkdir -p /usr/local/lib/subetha-egress /etc/systemd/system/docker.service.d
install -m 644 deploy/egress/egress-observer.py deploy/egress/egress-host-observer.service \
  deploy/egress/egress-boot-capture.service deploy/egress/99-egress-verify.conf /usr/local/lib/subetha-egress/
install -m 644 deploy/egress/subetha-egress-guard.service deploy/egress/subetha-egress-guard.timer /etc/systemd/system/
install -m 644 deploy/egress/10-subetha-egress.conf /etc/systemd/system/docker.service.d/

# 2) 公開 IPv4 を IMDS から読む。runner と同じ判定（token 取得 → 200 + IPv4 なら採用、404 なら none、それ以外は失敗）。
#    失敗すると `-e` で**ここで終わる**。既定値で埋めない
PUB=$(subetha-egress-verify --public-ipv4)
echo "public IPv4: $PUB"
printf 'IFACES="subetha0 docker0 br+"\nHOST_ADDRS4="%s"\n' "$PUB" > /etc/subetha-egress.env

# 3) 適用と確認（apply は最後に check を走らせ、通らなければ失敗する）
systemctl daemon-reload
subetha-egress apply
systemctl enable --now subetha-egress-guard.timer
[ "$(systemctl is-active subetha-egress-guard.timer)" = active ]

# 4) ExecStartPre が効くことを、**この再起動の invocation だけ**で確認する（両方のメッセージがこの順で無ければ終了）
systemctl restart docker
sleep 1
journalctl _SYSTEMD_INVOCATION_ID="$(systemctl show -p InvocationID --value docker.service)" -o cat \
  | grep -E 'subetha-egress: applied|Loading containers: start' > /tmp/egress-startup.txt
sed -n 1p /tmp/egress-startup.txt | grep -q 'subetha-egress: applied'
sed -n 2p /tmp/egress-startup.txt | grep -q 'Loading containers: start'
echo "egress control installed and verified at docker startup"
```

`/etc/subetha-egress.env` は `KEY=value`（空白を含む値は二重引用符。行内コメント不可）。未知のキー・重複・
不正なアドレス・空の `IFACES`・未設定の `HOST_ADDRS4` は **`apply` が失敗し、Docker が上がらない**（fail-closed）。
意図した挙動なので、`journalctl -u docker` の `subetha-egress:` 行を読んで直す。

### 8b.3 Router の network と、既存 Router の移行

network は §6 の手順 4 で作る（既にあれば `docker network inspect subetha-router-net` で bridge 名が `subetha0`、
subnet が RFC1918 であることを確認する）。

既に既定 bridge（docker0）で動いている Router を移す場合。journal（既定 `/app/runtime/journal.ndjson`）は
**過去の paymentId の唯一の記録**なので、次の順序を**ファイルに保存して `sudo bash -e` で実行する**。
**旧 Router が動いている状態で**実行する（スクリプトが止める。止める前に、旧 Router が**実際に開いている** journal を host の
`/proc` で見て、その最後の購入を旧 Router 自身が返すことを確かめるため）。設定ファイルを自前で解釈して journal の場所を
推定することはしない（Docker の env-file の解釈と食い違い得る）。**入口（Caddy）は最初に閉じ、終わるまで閉じたまま**にする:
新コンテナは最終構成のまま先に起動して検証するので、検証が済む前に外から届いてはいけない。全部通ってから旧コンテナを消して
名前を付け替え、入口を開け直す。失敗したときの状態は段階で決まる: **引き渡し（記録が `handoff` になる）より前**の失敗では旧コンテナが残り、
作りかけの新コンテナは消され、入口は**閉じられた後なら**開け直されるまで閉じたまま（閉じる前に止まれば触っていない）。**引き渡し後**の
失敗では新コンテナを残して前進で終える（入口を開け直した後に止まることもあるので、入口の実際の状態を見る）。どちらも
`/var/lib/subetha-router-migration.state` の記録と下の復旧手順に従う。
mask は**再起動しても残る**もの（`systemctl mask`）を使い、新コンテナは引き渡しの直前まで再起動ポリシー無しで作るので、途中で host が
再起動しても、入口は閉じたまま、新コンテナは勝手に上がらない。進行状況は `/var/lib/subetha-router-migration.state` に記録し、復旧はそれを読む。
host 上の他のプロセスが `127.0.0.1:8787` を使わないこと（受け入れ runner を同時に走らせない）。

```sh
#!/bin/bash -e
set -o pipefail
R=subetha-router
N=subetha-router-new                                      # 検証中の新コンテナの仮の名前（最後に $R に付け替える）
DEST=/var/lib/subetha-router                              # 新コンテナが mount する場所（§6 手順 4 と同じ）
ENVF=/etc/subetha-router.env
IMAGE=subetha-router
GATE=caddy.service                                        # 127.0.0.1:8787 へ転送する唯一の入口（§7）。unit は /usr/lib/systemd/system（公式パッケージ）
STATE=/var/lib/subetha-router-migration.state             # 復旧のための記録（root FS 上。再起動しても残る。成功したら消す）
NID=""; FINAL=0; STOPPED_GATE=0; DEST_ROLE=undetermined; J_ID=""; R_ID=""; JP=""; ROWS=""; SUM=""; SRC=""; PREVPHASE=none
ATTEMPT=$(date -u +%Y%m%dT%H%M%SZ)-$$                      # この実行の識別子（記録と、作る新コンテナの label に付ける）
record() { local body; body=$(printf 'updated=%s\nattempt=%s\nphase=%s\nprevious_phase=%s\ngate_was_running=%s\ndest=%s\ndest_role=%s\nold_container=%s\nold_source=%s\njournal=%s\njournal_ident=%s\nruntime_ident=%s\njournal_rows=%s\njournal_sha256=%s\nnew_container_id=%s' "$(date -u +%FT%TZ)" "$ATTEMPT" "$1" "$PREVPHASE" "$STOPPED_GATE" "$DEST" "$DEST_ROLE" "$R" "$SRC" "/app/runtime/$JP" "$J_ID" "$R_ID" "$ROWS" "${SUM%% *}" "$NID") && printf '%s\n' "$body" > "$STATE.tmp" && [ "$(sed -n 's/^phase=//p' "$STATE.tmp")" = "$1" ] && sync "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE" && sync "$(dirname "$STATE")" && PREVPHASE=$1; }
#   記録は一度に組み立てて 1 回の printf で書き、書いた tmp から phase を読み戻してから rename する。どれか失敗すれば非 0（-e で止まる）。PREVPHASE は全部通った後だけ更新
cleanup() { rc=$?; rm -f /tmp/journal.peek /tmp/journal.verify
  if [ "$rc" -ne 0 ]; then
    DUR=$(sed -n 's/^phase=//p' "$STATE" 2>/dev/null || true)     # ディスク上の記録の段階。復旧はこれを読むので、trap もこれに従う
    if [ "$FINAL" = 0 ] && [ "$DUR" != handoff ]; then
      # このスクリプトが `docker create` で作った新コンテナ（その ID）だけを消す。名前では消さない（前回の残骸や旧コンテナに触らない）
      [ -z "$NID" ] || docker rm -f "$NID" >/dev/null 2>&1 || true
      record failed-before-handoff 2>/dev/null || echo "warning: could not update the recovery record $STATE (durable phase: ${DUR:-none})" >&2
      echo "stopped with exit $rc before the handoff: the old container is untouched; ingress ($GATE) stays stopped and masked (it was running before: $STOPPED_GATE); $DEST is $DEST_ROLE. Recovery record: $STATE. See the recovery notes below the script" >&2
    else
      record failed-after-handoff 2>/dev/null || echo "warning: could not update the recovery record $STATE (durable phase: ${DUR:-none})" >&2
      echo "stopped with exit $rc after the handoff: the new container $NID is kept (it may already be named $R); ingress ($GATE) is now $(systemctl is-enabled "$GATE" 2>/dev/null || true)/$(systemctl is-active "$GATE" 2>/dev/null || true) (it was running before: $STOPPED_GATE). Recovery record: $STATE. See the recovery notes below the script" >&2
    fi
  fi; exit "$rc"; }
# 前回の復旧記録が残っていれば、**trap を仕掛ける前に**止まる（trap は記録を書き換えるので、先に確認する）
! [ -e "$STATE" ] || { echo "a recovery record from an earlier attempt exists: $STATE. Finish that recovery first (see the notes below the script)"; cat "$STATE"; exit 1; }
trap cleanup EXIT
real() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
norm() { python3 -c 'import os,sys
p=sys.argv[1]
if ".." in p.split("/"): sys.exit("SUBETHA_JOURNAL_PATH=%s contains ..: not covered by this procedure" % p)
a=os.path.normpath(p if p.startswith("/") else os.path.join("/app",p))
if not a.startswith("/app/runtime/"): sys.exit("SUBETHA_JOURNAL_PATH=%s is outside /app/runtime: not covered by this procedure" % p)
print(a[len("/app/runtime/"):])' "$1"; }
lastcreated() { python3 -c 'import json,sys
last="none"
for l in open(sys.argv[1],"rb").read().splitlines():
    try:
        d=json.loads(l)
        if isinstance(d,dict) and d.get("event")=="created" and isinstance(d.get("paymentId"),str): last=d["paymentId"]
    except ValueError: pass
print(last)' "$1"; }
inner() { docker logs "$1" 2>&1 | sed -n 's/^router: //p' | tail -n1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["port"])'; }
r4() { docker exec "$1" node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/v1/purchases/"+process.argv[2],{headers:{"x-router-principal":"judge",authorization:"Bearer public"}}).then(r=>{console.log("R4 status",r.status);process.exit(r.status===200?0:1)})' "$2" "$3"; }
ident() { stat -L -c '%d:%i' "$1"; }                     # (dev:inode)。/proc の magic link（fd、root）も辿る
# コンテナのプロセスが開いているファイルのうち名前に $2 を含むものを、host の /proc から "PID FD 経路（コンテナの中の経路のまま）" で列挙する
openfds() { local pid fd t; for pid in $(docker top "$1" -o pid | tail -n +2 | tr -d ' '); do for fd in /proc/"$pid"/fd/*; do t=$(readlink "$fd" 2>/dev/null) || continue; case "$t" in *"$2"*) echo "$pid ${fd##*/} $t" ;; esac; done; done; }
# 0) 入口を閉じる。Caddy を止め（起動中なら起動を取り消し）、**再起動しても残る mask**（/etc/systemd/system/caddy.service -> /dev/null）で
#    誰も起動できないようにし、状態が **inactive そのもの**であること（activating などの途中状態は不可）と、443/80 に listener が無いこと
#    （列挙の失敗も不可）を確認する。開始時に動いていた（active / activating / reloading）場合だけ、成功後に開け直す。
#    （前回の復旧記録の有無は trap を仕掛ける前に見ている）
PRE=$(systemctl is-active "$GATE" 2>/dev/null || true)
case "$PRE" in active|activating|reloading) STOPPED_GATE=1 ;; esac
record started
systemctl stop "$GATE" 2>/dev/null || true
systemctl reset-failed "$GATE" 2>/dev/null || true
systemctl mask "$GATE"
[ "$(systemctl is-enabled "$GATE" 2>/dev/null || true)" = masked ] || { echo "$GATE is not masked"; exit 1; }
STATE_GATE=$(systemctl is-active "$GATE" 2>/dev/null || true)
[ "$STATE_GATE" = inactive ] || { echo "$GATE is not inactive (state: $STATE_GATE)"; exit 1; }
LISTEN=$(ss -Hltn '( sport = :443 or sport = :80 )')
[ -z "$LISTEN" ] || { echo "something still listens on 443/80:"; printf '%s\n' "$LISTEN"; exit 1; }
echo "ingress closed ($GATE was $PRE; now inactive and masked across reboots, nothing on 443/80)"
# 1) 旧 Router が実際に使っている journal を確定する（まだ何も止めない）
[ "$(docker inspect -f '{{.State.Running}}' "$R")" = true ] || { echo "$R must be running (this script stops it itself)"; exit 1; }
! docker inspect "$N" >/dev/null 2>&1 || { echo "a container named $N exists from an earlier attempt: inspect and remove it first"; exit 1; }
#    a. mount 配置: /app/runtime ちょうどの bind / 名前付きボリュームだけを受け付ける。/app/runtime を含む mount や、その下の mount があれば止まる
SRC=$(docker inspect "$R" --format '{{json .Mounts}}' | python3 -c 'import json,sys
src=""
for m in json.load(sys.stdin):
    d=(m.get("Destination") or "").rstrip("/") or "/"
    if d=="/app/runtime":
        if m.get("Type") not in ("bind","volume"): sys.exit("unsupported mount type %s at /app/runtime" % m.get("Type"))
        src=m["Source"]
    elif d=="/" or "/app/runtime".startswith(d+"/") or d.startswith("/app/runtime/"):
        sys.exit("unsupported mount layout: a mount at %s overlaps /app/runtime" % d)
print(src)')
#    b. 旧 Router のプロセスが開いている .ndjson（カーネルが解決した経路）がちょうど 1 つで、/app/runtime の下の消されていない
#       ファイルであり、同じディレクトリの journal.lock も開いていること。設定の解釈ではなく、開いているファイルそのものを見る
JF=$(openfds "$R" .ndjson)
[ "$(printf '%s\n' "$JF" | grep -c .)" = 1 ] || { echo "the old Router holds $(printf '%s\n' "$JF" | grep -c .) .ndjson files open, expected exactly one:"; printf '%s\n' "$JF"; exit 1; }
read -r PID FD J <<< "$JF"
case "$J" in
  *" (deleted)") echo "the old Router's journal was deleted while open: $J"; exit 1 ;;
  /app/runtime/?*) JP=${J#/app/runtime/} ;;
  *) echo "the old Router has $J open, not a file under /app/runtime: not covered by this procedure"; exit 1 ;;
esac
[ "$(openfds "$R" /journal.lock | awk '{print $3}')" = "$(dirname "/app/runtime/$JP")/journal.lock" ] || { echo "the old Router does not hold journal.lock next to $J"; exit 1; }
#    c. その journal と、コンテナが見ている /app/runtime の identity (dev:inode) を、プロセスの fd と root 経由で取る。
#       host の mount 元が**同じもの**を見せていること（コンテナ起動後に host 側で重ねた mount などで、host の経路が別の中身を見せていれば止まる）
J_ID=$(ident "/proc/$PID/fd/$FD"); R_ID=$(ident "/proc/$PID/root/app/runtime")
if [ -n "$SRC" ]; then
  [ "$(ident "$SRC")" = "$R_ID" ] || { echo "the host path $SRC does not show the directory the container uses ($(ident "$SRC") vs $R_ID): not covered by this procedure"; exit 1; }
  [ "$(ident "$SRC/$JP")" = "$J_ID" ] || { echo "$SRC/$JP is not the file the old Router has open: not covered by this procedure"; exit 1; }
  [ "$(real "$SRC/$JP")" = "$(real "$SRC")/$JP" ] || { echo "symlink inside $SRC: unsupported layout"; exit 1; }
fi
#    d. $DEST の役割。まず、$DEST が **root ファイルシステムの上に直接**あること（$DEST を含む mount が / だけ。bind や別のファイルシステムで
#       覆われていれば止まる: 再起動後に同じ経路に同じ中身がある保証は、fstab に載っていても無い）。次に、$DEST の**下**に mount があれば止まる
#       （ファイル 1 つの bind も含む。後で消すときに辿り、新コンテナの再帰 bind にも入る）。そのうえで、コンテナが見ている runtime と $DEST の
#       identity が同じなら authoritative（コピーしない。何も消してはいけない）。host の mount 表で、正規位置が同じなのに別物（重ねた/隠れた
#       mount）、経路や正規位置の入れ子なら止まる。mount 表が読めなければ止まる。それ以外だけ copy（使い捨ての複製）
D_ID=$(ident "$DEST" 2>/dev/null || true)
role() { python3 -c '
import os,sys,re
def unesc(s): return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1),8)), s)   # mountinfo escapes space/tab/newline/backslash as \040 etc.
s,d,rid,did=sys.argv[1:5]
mounts=[]
for line in open("/proc/self/mountinfo"):
    f=line.split(); mounts.append((unesc(f[4]), unesc(f[3]), f[2]))
def canon(p):
    p=os.path.realpath(p); best=None
    for mp,root,dev in mounts:
        if p==mp or p.startswith(mp.rstrip("/")+"/"):
            if best is None or len(mp)>=len(best[0]): best=(mp,root,dev)   # same length: the later entry is the mount on top
    mp,root,dev=best; rel=p if mp=="/" else p[len(mp):]
    return dev, (os.path.normpath((root if root!="/" else "")+rel) or "/")
def inside(a,b): return a.startswith(b.rstrip("/")+"/")
rd=os.path.realpath(d)
covering=[mp for mp,_,_ in mounts if mp!="/" and (rd==mp or inside(rd,mp))]
if covering: sys.exit("%s is not directly on the root filesystem (covered by a mount at %s): what it contains after a reboot is not established: not covered by this procedure" % (d, ", ".join(covering)))
below=[mp for mp,_,_ in mounts if inside(mp,rd)]
if below: sys.exit("unsupported: something is mounted beneath %s (%s): not covered by this procedure" % (d, ", ".join(below)))
if did and did==rid: print("authoritative"); sys.exit()
if s:
    rs=os.path.realpath(s); cs,cd=canon(s),canon(d)
    if cs==cd: sys.exit("ambiguous: %s and %s map to the same place in the mount table but are different directories (stacked or hidden mounts): not covered by this procedure" % (s,d))
    if inside(rs,rd) or inside(rd,rs): sys.exit("overlap: %s and %s are nested paths: not covered by this procedure" % (s,d))
    if cs[0]==cd[0] and (inside(cs[1],cd[1]) or inside(cd[1],cs[1])): sys.exit("overlap: %s resolves to %s and %s to %s on the same filesystem (bind mount alias): not covered by this procedure" % (s,cs[1],d,cd[1]))
print("copy")' "$SRC" "$DEST" "$R_ID" "$D_ID"; }
DEST_ROLE=$(role)
#       authoritative なら、$DEST/$JP が旧 Router の開いている journal そのもの（同じ inode）であること（ディレクトリの一致だけでは journal は束縛されない）
if [ "$DEST_ROLE" = authoritative ]; then [ "$(ident "$DEST/$JP")" = "$J_ID" ] || { echo "$DEST/$JP is not the file the old Router has open: not covered by this procedure"; exit 1; }; fi
echo "$DEST is $DEST_ROLE ($([ "$DEST_ROLE" = authoritative ] && echo "the old Router already stores its journal there: nothing is copied and nothing there may be deleted" || echo "a copy of the old Router's runtime"))"
echo "current /app/runtime backing: ${SRC:-<no mount: inside the container>}; the old Router (pid $PID) has /app/runtime/$JP open"
#    e. 候補の journal を、**コンテナ自身の見え方**（/proc/$PID/root 経由）で覗き、その最後の購入を動いている旧 Router が返すこと。
#       copy の場合、$DEST に内容の違う journal が既にあれば、旧 Router を止める前に止まる（前の試行で何かが書いた可能性。上書きしない）
PEEK=/proc/$PID/root/app/runtime/$JP
LAST0=$(lastcreated "$PEEK")
if [ "$DEST_ROLE" = copy ] && [ -e "$DEST/$JP" ]; then cmp "$PEEK" "$DEST/$JP" || { echo "$DEST/$JP exists and differs from the old Router's journal: a previous attempt may have written there. Reconcile first; nothing was overwritten"; exit 1; }; fi
if [ "$LAST0" != none ]; then
  INNER0=$(inner "$R")
  r4 "$R" "$INNER0" "$LAST0" || { echo "the running Router does not serve $LAST0, the last purchase in the candidate journal: not the journal it uses"; exit 1; }
fi
# 2) Router を止め、止まったことを確認する（コピーは停止後。停止までの追記を取りこぼさない）
docker stop "$R"
[ "$(docker inspect -f '{{.State.Running}}' "$R")" = false ]
record old-stopped
# 3) 実体から $DEST へ写し、journal が元と同じバイト列であることを**別の読み出し**で確認する（どれが失敗しても終了）。
#    $DEST に**内容の違う** journal が既にあれば上書きせずに止まる（前の試行で何かが書いた可能性。journal.lock は flock 用の常設ファイルで、写しても害は無い）
mkdir -p "$DEST"
if [ -n "$SRC" ]; then
  #  停止後も host の mount 元が同じディレクトリと同じファイル（同じ inode）であること
  [ "$(ident "$SRC")" = "$R_ID" ] || { echo "$SRC changed identity after the stop"; exit 1; }
  [ "$(ident "$SRC/$JP")" = "$J_ID" ] || { echo "$SRC/$JP changed identity after the stop"; exit 1; }
  if [ "$DEST_ROLE" = authoritative ]; then
    [ "$(ident "$DEST")" = "$R_ID" ] || { echo "$DEST changed identity after the stop"; exit 1; }
    [ "$(ident "$DEST/$JP")" = "$J_ID" ] || { echo "$DEST/$JP changed identity after the stop"; exit 1; }
  fi
  if [ "$DEST_ROLE" = copy ]; then
    [ ! -e "$DEST/$JP" ] || cmp "$SRC/$JP" "$DEST/$JP" || { echo "$DEST/$JP exists and differs from the old Router's journal: a previous attempt may have written there. Reconcile first; nothing was overwritten"; exit 1; }
    cp -a "$SRC/." "$DEST/"; cmp "$SRC/$JP" "$DEST/$JP"
  fi
else
  docker cp "$R:/app/runtime/$JP" /tmp/journal.verify   # 停止後の独立した読み出し。無ければここで終わる
  [ ! -e "$DEST/$JP" ] || cmp /tmp/journal.verify "$DEST/$JP" || { echo "$DEST/$JP exists and differs from the old Router's journal: a previous attempt may have written there. Reconcile first; nothing was overwritten"; exit 1; }
  docker cp "$R:/app/runtime/." "$DEST/"
  cmp /tmp/journal.verify "$DEST/$JP"; rm -f /tmp/journal.verify
fi
chown -R 10001:10001 "$DEST"
[ "$(stat -c %u:%g "$DEST")" = 10001:10001 ]
#    複製をディスクに確定する（cp も docker cp も fsync しない）。ファイル、そのディレクトリ、親ディレクトリ、最後にファイルシステム全体。失敗すればここで止まる
if [ "$DEST_ROLE" = copy ]; then sync "$DEST/$JP"; sync "$(dirname "$DEST/$JP")" "$DEST" "$(dirname "$DEST")"; sync -f "$DEST"; fi
[ -f "$DEST/$JP" ]
[ "$(real "$DEST/$JP")" = "$(real "$DEST")/$JP" ] || { echo "symlink inside $DEST: unsupported layout"; exit 1; }
# 4) 旧配置（21155eb より前の image は journal を runtime/remote-*/ の下に置いた）なら止まる。走査自体の失敗も止まる。
#    行数・内容・最後の購入は、起動前の複製（元と同じバイト列）から取る
LEGACY=$(find "$DEST" -mindepth 2 -name journal.ndjson ! -path "$DEST/$JP")
[ -z "$LEGACY" ] || { echo "legacy layout: $LEGACY. Recover it separately; nothing was removed"; exit 1; }
ROWS=$(wc -l < "$DEST/$JP"); SUM=$(sha256sum < "$DEST/$JP"); LAST=$(lastcreated "$DEST/$JP")
[ "$LAST" = "$LAST0" ] || { echo "the copy's last purchase is $LAST but the candidate's was $LAST0"; exit 1; }
record copied
# 5) 新コンテナを**最終構成のまま**仮の名前で作って起動する（§6 手順 4 と同じ引数。旧コンテナは止まっているのでポートは空いている。
#    入口は閉じているので外からは届かない）。起動時の replay 全部（journal の検査、intent の同一性、予算）を通って上がること、
#    Docker が解釈した env の journal の場所と、プロセスが実際に開いているファイルが /app/runtime/$JP そのものであること、
#    最後の購入を R4 で返すことを、旧コンテナを消す前に確かめる
docker network inspect subetha-router-net >/dev/null 2>&1 || \
  docker network create --driver bridge -o com.docker.network.bridge.name=subetha0 subetha-router-net
#    再起動ポリシーは付けずに作る（検証が終わる前に host が再起動しても、新コンテナが勝手に上がらない）。引き渡しの直前に unless-stopped にする
NID=$(docker create --name "$N" --label "subetha.migration=$ATTEMPT" --network subetha-router-net -p 127.0.0.1:8787:8787 \
  -v "$DEST:/app/runtime" --env-file "$ENVF" "$IMAGE")
record replacement-created
docker start "$NID" >/dev/null
record replacement-started
for i in $(seq 1 60); do H=$(curl -sf http://127.0.0.1:8787/healthz 2>/dev/null || true); [[ "$H" == *'"router":"up"'* ]] && break; [ "$(docker inspect -f '{{.State.Running}}' "$NID")" = true ] || break; sleep 1; done
[[ "$H" == *'"router":"up"'* ]] || { echo "the new container did not come up on the copied journal:"; docker logs "$NID" 2>&1 | tail -n 20; exit 1; }
NEWJ=$(docker inspect "$NID" --format '{{range .Config.Env}}{{println .}}{{end}}' | { grep '^SUBETHA_JOURNAL_PATH=' || echo 'SUBETHA_JOURNAL_PATH=runtime/journal.ndjson'; } | tail -n1 | cut -d= -f2-)
[ "$(norm "$NEWJ")" = "$JP" ] || { echo "as Docker read $ENVF, the new container's SUBETHA_JOURNAL_PATH=$NEWJ is not /app/runtime/$JP"; exit 1; }
JN=$(openfds "$NID" .ndjson | awk '{print $3}' | sort -u)
[ "$JN" = "/app/runtime/$JP" ] || { echo "the new container has '$JN' open, not /app/runtime/$JP"; exit 1; }
[ "$(openfds "$NID" /journal.lock | awk '{print $3}' | sort -u)" = "$(dirname "/app/runtime/$JP")/journal.lock" ] || { echo "the new container does not hold journal.lock next to its journal"; exit 1; }
#    新コンテナが開いている journal が、host の $DEST/$JP そのもの（同じ inode）であること
read -r NPID NFD _ <<< "$(openfds "$NID" .ndjson | head -n1)"
[ "$(ident "/proc/$NPID/fd/$NFD")" = "$(ident "$DEST/$JP")" ] || { echo "the new container's open journal is not $DEST/$JP"; exit 1; }
[ "$(docker inspect "$NID" --format '{{range .Mounts}}{{if eq .Destination "/app/runtime"}}{{.Source}}{{end}}{{end}}')" = "$DEST" ]
[ "$(head -n "$ROWS" "$DEST/$JP" | sha256sum)" = "$SUM" ]   # 元の行はそのまま（起動で unknown 行が後ろに足されることはある）
# 新コンテナの Router が journal.lock を排他 flock している: host の /proc/locks で device と inode が一致し、保持 PID が新コンテナのプロセス（docker top）であること
KEY=$(python3 -c 'import os,sys; st=os.stat(sys.argv[1]); print("%02x:%02x:%d" % (os.major(st.st_dev), os.minor(st.st_dev), st.st_ino))' "$(dirname "$DEST/$JP")/journal.lock")
HOLDER=$(awk -v key="$KEY" '$2=="FLOCK" && $4=="WRITE" && $6==key {print $5}' /proc/locks)
[ -n "$HOLDER" ]
docker top "$NID" -o pid | tail -n +2 | tr -d ' ' | grep -x "$HOLDER" >/dev/null
if [ "$LAST" != none ]; then
  # 最後の購入を R4（GET /v1/purchases/<id>）で引く。Router の HTTP API はコンテナ内 loopback の一時ポートだけで聞いている
  # （8787 は MCP と /healthz）。ポートは起動ログの "router:" 行、principal は tools/remote-mcp.ts が固定する judge:public
  INNER=$(inner "$NID")
  r4 "$NID" "$INNER" "$LAST"
fi
# 6) 削除の境界の直前に、もう一度ファイルシステムを確定する（新コンテナが起動で足した行も含めて）。ここで止まれば trap が新コンテナを消し、旧コンテナは残る
sync -f "$DEST"
#    記録を handoff にできた時点から先は、止まっても新コンテナは残る（前進で復旧する）。記録の書き込みに失敗すればここで止まり、trap は
#    ディスク上の記録（まだ replacement-started）に従って新コンテナを消す。その後、再起動ポリシーを最終構成（unless-stopped）にし、旧コンテナを消し、新コンテナを $R に付け替え、入口を開け直す
record handoff
FINAL=1
docker update --restart unless-stopped "$NID" >/dev/null
[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$NID")" = unless-stopped ]
echo "all checks passed and the copy is durable: the new container $NID serves the migrated journal ($ROWS rows, last purchase $LAST); ingress was running before: $STOPPED_GATE. Removing the old container, renaming, reopening ingress"
docker rm "$R"
docker rename "$NID" "$R"
[ "$(docker inspect -f '{{.Id}}' "$R")" = "$NID" ]
H=$(curl -sf http://127.0.0.1:8787/healthz); [[ "$H" == *'"router":"up"'* ]]
systemctl unmask "$GATE"
if [ "$STOPPED_GATE" = 1 ]; then systemctl start "$GATE"; [ "$(systemctl is-active "$GATE")" = active ]; echo "ingress reopened ($GATE unmasked and active)"
else echo "ingress ($GATE) was not running when this script started: unmasked, left stopped"; fi
rm -f "$STATE"
echo "migration complete: $ROWS journal rows reopened by the new container"
```

止まる条件（引き渡し前。どれも旧コンテナを消さず、作りかけの新コンテナは消し、入口は閉じた後なら止めたまま mask も残す）: 前回の復旧記録が
残っている、入口が閉じない（Caddy が inactive にならない、mask できない、443/80 に listener が残る、listener の列挙に失敗する）、旧 Router の mount 元と `$DEST` が重なる木
（一方が他方の中）、旧 Router が動いていない、前回の `subetha-router-new` が残っている、`/app/runtime` と重なる別の mount、bind / ボリューム
以外の mount、旧 Router が開いている `.ndjson` が 1 つでない・`/app/runtime` の下でない（symlink や `..` で別の場所に解決されている）・
消されている、隣の `journal.lock` を開いていない、host の mount 元がコンテナの見ている runtime / journal と別物（identity 不一致。停止後の再確認も含む）、`$DEST` が root ファイル
システムの上に直接ない（bind や別のファイルシステムで覆われている）、`$DEST` の下に mount がある（ファイル 1 つの bind も）、authoritative
なのに `$DEST` の journal が旧 Router の開いているファイルと別物、mount 元や複製の中の symlink、候補の最後の購入を旧 Router が
返さない、`$DEST` に内容の違う journal が既にある、コピーや再読み出しの失敗、元と複製の不一致、複製の `sync` の失敗、旧配置（`remote-*/` の下に journal）、
走査の失敗、`$DEST` の下に mount がある、重ねた/隠れた mount で別のディレクトリが同じ場所に見える、**最終構成で起動した新コンテナが上がらない**（Router の起動時の replay が拒む: 改行の無い末尾、JSON でない行、`seq` の飛び、
欠けた項目、paymentId / quoteId の重複、予算）、Docker が解釈した新コンテナの env の journal の場所が旧と違う、新コンテナのプロセスが
開いている journal が旧と違う、元の行が変わっている、flock の保持者が新コンテナでない、新コンテナが最後の購入を返さない。

**止まった後の復旧**（入口は、閉じるのに成功した後なら開け直すまで止まったまま mask されている。閉じる前に止まった場合は触っていない。
引き渡し後は `systemctl is-enabled caddy` / `is-active caddy` で実際の状態を見る。まず記録を読む）:
`sudo cat /var/lib/subetha-router-migration.state` に `phase`（スクリプトの trap も、停止時にこのディスク上の段階に従う。記録を更新できなかった
ときは `warning: could not update the recovery record` と出る。その場合も**ディスク上の記録の段階が正**）、`gate_was_running`（0/1）、`dest_role`（`copy` / `authoritative` / `undetermined`）、
`old_source`、`journal`、`journal_ident`（旧 Router が開いていた journal の dev:inode）、`journal_rows` / `journal_sha256`（停止後に検証した
journal。`copied` 以降）、`new_container_id` がある。途中で host が再起動していても同じ: 入口は mask されたまま、新コンテナは
`handoff` の前なら再起動ポリシー無しなので上がらず、旧コンテナは止めたまま（`unless-stopped` は手で止めたものを起動しない）。
`phase` で**排他的に**分ける:

- **引き渡し前**（`phase` が `started` / `old-stopped` / `copied` / `replacement-created` / `replacement-started`、または `failed-before-handoff`。
  後者は `previous_phase` が最後に通った段階）。**何も消す前に**、記録の中身で分ける:
  - **`journal_ident` が空**（`started` で止まった。journal の確定より前）: 旧 Router は止めておらず、何も写しておらず、新コンテナも無い。
    `docker ps` で `subetha-router` が running であることを見て、下の「最後に」だけを行う（記録を消し、入口を扱う）。running でなければ
    記録に無い状態なので**止めて調べる**（何も消さない）。
  - **`journal_ident` がある**（`old-stopped` 以降）: 旧 Router は止めてある。順に:
    1. 新コンテナの後始末。`new_container_id` があれば `docker ps -a --no-trunc` でその ID を見て、running なら `docker stop`、そして
       `docker rm`（この ID だけ）。ID が無くても、`docker create` の直後に落ちた場合に備えて
       `docker ps -a --filter label=subetha.migration=<記録の attempt> --format '{{.ID}} {{.Status}}'` を見る。出てきたものは
       この試行が作った（起動していない）新コンテナなので `docker rm` する。名前（`subetha-router-new`）で消さない。
    2. **回復に使える journal がどこにあるか**を、消す前に確定する。`$DEST`（記録の `dest`）側は:
       `authoritative` なら `stat -c '%d:%i' <dest>/<journal の /app/runtime/ 以下>` が `journal_ident` と一致すること、
       `copy` で `journal_rows` があるなら `head -n <journal_rows> <dest>/<同じ相対パス> | sha256sum` が `journal_sha256` と一致すること。
       どちらでもない（`copy` で `journal_rows` が空 = 写す前、など）なら `$DEST` には回復に使えるものは無い。
    3. 旧 Router を `sudo docker start subetha-router` し、`/healthz` を待ってから、**開いている journal が記録のものか**を確かめる
       （health だけでは足りない。一時的な bind 越しに使っていた mount 元は、再起動で別の中身を見せ得る）:
       ```sh
       pid=$(for p in $(docker top subetha-router -o pid | tail -n +2 | tr -d ' '); do readlink /proc/$p/fd/* 2>/dev/null | grep -q '\.ndjson$' && echo $p; done | head -n1)
       fd=$(for f in /proc/$pid/fd/*; do readlink "$f" | grep -q '\.ndjson$' && echo "${f##*/}"; done | head -n1)
       stat -L -c '%d:%i' /proc/$pid/fd/$fd          # 記録の journal_ident と一致すること
       ```
       - 一致: 旧 Router はそのまま使う。`copy` なら `$DEST` は不要なので、`findmnt -l -n -o TARGET | grep '^/var/lib/subetha-router/'` が
         何も出さないことを見て `rm -rf --one-file-system /var/lib/subetha-router`（`authoritative` は何も消さない）。
       - 不一致、かつ 2 で `$DEST` に回復に使える journal が**ある**: 入口を開けず、`docker stop subetha-router && docker rm subetha-router`
         のうえ、§6 手順 4 の `docker run`（`-v /var/lib/subetha-router:/app/runtime`）で作り直し、同じ確認で `stat -L` の値が
         `authoritative` なら `journal_ident`、`copy` なら `stat -c '%d:%i' <dest>/<相対パス>` と一致することを見る。
       - 不一致、かつ 2 で回復に使える journal が**無い**: **止めて調べる**。旧コンテナは `docker stop` するだけで**消さない**
         （mount の無い旧コンテナでは、その書き込み層が唯一の記録）。入口は閉じたまま。下の「最後に」には進まない。
- **`handoff` / `failed-after-handoff`**（引き渡し後。**前進で終える。旧に戻さず、`$DEST` も新コンテナも消さない**）:
  新コンテナ（`new_container_id`）が記録を開いている。`docker ps -a --no-trunc --format '{{.ID}} {{.Names}} {{.Status}}'` でその行を見る:
  - 止まっていれば `docker start <id>`。再起動ポリシーが `no` なら `docker update --restart unless-stopped <id>`。
  - 名前が `subetha-router-new` なら、`curl -s http://127.0.0.1:8787/healthz` が `"router":"up"` を返すことを確かめ、旧コンテナが残っていれば
    `docker rm subetha-router`、そして `docker rename subetha-router-new subetha-router`。
  - 名前が既に `subetha-router` なら旧コンテナは消えている。`/healthz` を確かめる（返らなければ `docker logs`。記録は `$DEST` にあり、
    コンテナを消す理由は無い）。
- どの場合も最後に: `sudo rm /var/lib/subetha-router-migration.state`、`sudo systemctl unmask caddy`、そして **`gate_was_running=1` のときだけ**
  `sudo systemctl start caddy`（`0` なら、移行前から止めてあった入口なので、開けない）。

`$DEST`（`/var/lib/subetha-router`）は **root ファイルシステムの上に直接ある通常のディレクトリ**であること（AL2023 の既定）。bind や別の
ファイルシステムで覆われていると止まる（`/etc/fstab` に載っていても、`noauto` や別の source など、再起動後に同じ中身がある保証にならない）。
別のボリュームに置く構成は本手順の対象外。
購入記録が一つも無い Router は **0 バイトの journal ファイルがある**状態なので通り、R4 の照会だけ省かれる。
旧配置の回収は本手順の範囲外（起動ごとに別ファイルで、`seq` もファイルごとに 1 から始まるため、単純に連結できない）。
MCP 側からも `subetha_router_status` に最後の `paymentId` を渡して同じ記録が返ることを見れば、運用で使う経路での確認になる。

### 8b.4 検証（稼働前に全モード。証拠を保存する）

受け入れ条件: **全モードで `failed 0`、かつ `ALLOW_NO_BACKLOG` と `ALLOW_NO_IMDS` を設定しない**。
この 2 つは試験環境専用の免除で、設定すると不足した証拠が INFO になる。本番では**必ず unset** する。
runner の出力と証拠ディレクトリ（`/var/tmp/egress-verify-<時刻>-<mode>/`）、設置した成果物の commit と
`/etc/subetha-egress.env` の内容を保存する。

環境変数: `ROUTER` は Router の**コンテナ名**（既定 `subetha-router`）、`HEALTH_URL` は Router の health endpoint で
**コンテナの中からも外からも同じ URL で届くもの**（既定 `http://127.0.0.1:8787/healthz`。Caddy の TLS endpoint ではない）、
`OBSERVER=<observer ip>:19999`、`OBSERVER_REPORT=<observer ip>:19996`（外部 observer は
`python3 egress-observer.py --port 19999 --report-port 19996`。**検証の全期間、再起動せずに**動かし続ける。
runner は observer の記録を自分で読み、session が変わると FAIL にする）。

```sh
unset ALLOW_NO_BACKLOG ALLOW_NO_IMDS
export OBSERVER=<observer ip>:19999 OBSERVER_REPORT=<observer ip>:19996
sudo -E subetha-egress-verify                        # 非破壊（Router 稼働中）
sudo docker stop subetha-router                      # 以下 2 つは Router を止めて
sudo -E subetha-egress-verify --adversarial          # 代役コンテナを同じ network に置き、policy の除去/再適用と check の sabotage を行う
sudo -E subetha-egress-verify --fail-closed          # Docker を止め env を壊し、再試行を含めて上がらないことを journal で見る
sudo docker start subetha-router
sudo -E subetha-egress-verify --reboot-prepare       # probe と boot 時の観測 unit を入れる（捕捉の寿命は既定 900 秒）
sudo reboot
```

再起動後（**900 秒以内**に。超えたら `--reboot-cleanup` して `--reboot-prepare` からやり直す）:

```sh
unset ALLOW_NO_BACKLOG ALLOW_NO_IMDS
export OBSERVER=<observer ip>:19999 OBSERVER_REPORT=<observer ip>:19996   # 再接続した shell で同じ値を再設定
sudo -E subetha-egress-verify --post-boot
sudo -E subetha-egress-verify --reboot-cleanup
```

`--adversarial` は Router が止まっていることを**成功した query で確認**し、確認できなければ拒否して非 0 で終わる。
観測が立ち上がらない・observer の session が変わる・捕捉が読めない、はすべて FAIL になる。

### 8b.5 運用規則

- **イメージのビルドは `docker build --network host` で行う。** 既定 bridge のビルド用コンテナは DNS を host の nameserver（VPC の内部アドレス）へ
  直接問い合わせ、egress 制御に落とされる（`apt-get` が失敗する。2026-10-05 の本番で確認）。規則を緩めない
- **Router 稼働中に firewall と host のアドレスを触らない**（`iptables -F`、firewalld の導入、他の管理ツール、
  Elastic IP の付け替え、インタフェースへのアドレス追加）。guard timer は 30 秒毎に復旧するが**その間は開く**。保証ではない
- 保守とアドレス変更は次の順序で: `docker stop subetha-router` → `systemctl stop subetha-egress-guard.timer subetha-egress-guard.service`
  → 作業（`subetha-egress remove` を含む保守、アドレス変更なら `HOST_ADDRS4` の更新）→ `sudo subetha-egress apply`（check を含む）
  → `systemctl start subetha-egress-guard.timer` と `systemctl is-active subetha-egress-guard.timer` → `docker start subetha-router`
- 再適用だけなら `sudo subetha-egress apply`（原子的、数十 ms）。Docker の再起動は不要
- 状態は `sudo subetha-egress status`。`check` が非 0 なら差分が stderr に出る
- IANA の special-purpose レジストリが更新されたら（runner が検出して FAIL にする）`DENY4` / `DENY6` を見直す
- 起動直後、guard の初回実行までは bridge の gateway アドレスが目録に無い（network の subnet が RFC1918 なので
  レジストリ行が落とす。runner はそれを前提として検査する）。`check` はその間だけ差分を報告する

### 8b.6 既存ホストから新しいホストへの切り替え

既定 bridge・Docker 25 で動いている既存ホスト（旧）を、§8b.0〜§8b.4 を通した新しいホスト（新）に置き換える。
**旧ホストは切り替えが確定するまで変更しない**（止めるだけ）。

**journal の原則**: 書き手は常に 1 つ。**新の Router が要求を受けられる状態になった時点から、新の journal が正**（完了した購入だけでなく、
保留・unknown・起動時の復旧記録も含む。起動しただけで追記され得る）。以後、旧を使うには両方を止めて新の journal を旧へ写す。

**この手順が扱う journal の配置は 1 つだけ**: `SUBETHA_JOURNAL_PATH` を設定しておらず、Router が**実際に開いている**ファイルが
mount した directory 直下の `journal.ndjson` であること。旧を止める前に確かめる: `docker inspect` の `Config.Env` に `SUBETHA_JOURNAL_PATH` が無いこと、
Router のプロセスが開いている journal（host の `/proc/<pid>/fd` の `readlink`）が `/app/runtime/journal.ndjson` の 1 つだけであること、その dev:inode が
host の `<mount 元>/journal.ndjson` と同じこと（`stat -L -c %d:%i`）。**満たさなければこの手順は使わない。** 新でも起動後に同じ確認をする。
以下の「journal」「写し」「比較」はすべてこのファイルを指す。

**MPP 受信の既知の制約**: 資格情報の再生防止ストアはプロセス内（`p5-inbound-rails-design.md`）で、**切り替えは再起動と同じく消える**。
journal を写しても移らない。Router 自身の at-most-once は journal（quote の直列化と intent の状態）に依る。この制約が解消されるまで、
MPP 受信で実価値を扱わない（testnet のみ）という既存の前提は切り替え後も変わらない。

準備（公開に影響しない）:

1. 新: 旧と同じ VPC・サブネット・SG、AL2023、IMDSv2 必須 + hop limit 1（§9）。§8b.0 → §8b.2
2. 旧 → 新へ、**イメージ**（`docker save <イメージ ID>` を `docker load`。ID が一致すること）と `/etc/subetha-router.env`（root 600、sha256 が一致）を
   端から端まで暗号化した経路で写す（秘密を作業端末のディスクに置かない）
3. 新: §6 手順 4 で Router を起動（**空の journal**、`127.0.0.1:8787` のみ）。同じ支払い鍵を持つ 2 つ目のプロセスなので、**購入の経路を一切持たせない**:
   入口（Caddy）を起動しない、8787 を転送しない、購入を出す client を向けない。**検証中の journal は空のままであること**を切り替え直前に確かめる
   （1 行でもあれば調べ終わるまで切り替えない）
4. 新: §8b.4 を全モード `failed 0`（外部 observer、免除なし、実 reboot）。証拠を保存
5. 新: Caddy を入れ、設定と証明書（`/etc/caddy/Caddyfile`、Caddy の data directory）を旧から同じ経路で写す。所有者と権限を service の実行ユーザに合わせ、
   `caddy validate` を通す。**起動はしない**（`systemctl disable caddy`、`is-active` が `inactive`）
6. 旧へ **プライベート IP で SSH できること**を新ホスト経由（ProxyJump）で実際に試す（Elastic IP を外すと旧は公開 IP を失う）

切り替え（公開が止まる。数分）。各行は前の行が成功してから:

1. 新: `docker stop subetha-router`。検証中の journal が空であることを確かめ、directory を `/var/lib/subetha-router.verify-<時刻>` に退避して空にする
2. 旧: 入口を閉じる `systemctl disable --now caddy`（`is-active` が `inactive`）→ `docker stop -t 60 subetha-router` → `docker update --restart no subetha-router`
3. 旧（止める前に済ませておく確認の再掲）: 上の「journal の配置」の確認が通っていること。旧: journal の全行が JSON として読め、末尾が改行で終わること。行数・バイト数・sha256 を記録（**引き渡し時点の写し**）
4. 旧 → 新へ journal の directory を写す（`journal.ndjson` の sha256・行数・バイト数が一致。所有者 10001:10001）。引き渡し時点の写しを新にも別名で残す
5. Elastic IP を旧から新へ付け替える（**付け替える EIP のアドレスを控えておく**）
6. 新: §8b.5 の順序で `HOST_ADDRS4` を更新: guard timer と service を止める → `subetha-egress-verify --public-ipv4` の値が**控えた EIP と一致する**まで
   進まない（404 や旧アドレスは「付け替え未完了」）→ `/etc/subetha-egress.env` を書き換える → `subetha-egress apply` → guard timer を起動して `is-active`
7. 新: `docker start subetha-router` → `healthy`、`/healthz`、起動ログの mode / label。**アプリ自身が journal を replay して起動したこと**が受け入れ条件
   （JSON の検査は予備）。**新の Router が開いている journal が `<mount 元>/journal.ndjson` であること**（上の確認を新で行う）。
   その journal は引き渡し時点の写しと**先頭バイト列が一致**（`cmp -n <写しのバイト数>`）= 追記だけ
8. 新: **入口を閉じたまま** `subetha-egress-verify`（既定モード）を `failed 0`（公開 IPv4 の照合、DNS、行列を含む）
9. 新: 入口を開ける `systemctl enable --now caddy` → 外から `https://<domain>/healthz` と MCP の `tools/list`（AAAA や別の入口が無いことも確認）

戻す（どの時点でも、次の 1 本の順序に合流する）:

1. 新: Caddy と Router を止める（`systemctl disable --now caddy`、`docker stop -t 60 subetha-router`。未起動なら不要）
2. **使う journal を決める**: 新の Router を一度も起動していない（切り替え手順 7 より前）なら旧の journal のまま。起動していたなら、新の journal
   （上で確かめた、Router が開いていたファイル）を引き渡し時点の写しと `cmp` する。**バイト単位で同一なら旧の journal のまま。1 バイトでも増えていれば新が正**:
   旧の journal を別名に退避し、新の journal を旧へ写して sha256・バイト数が一致することを確かめる。古い journal のまま旧を起動しない
3. Elastic IP を旧へ戻し、旧で `subetha-egress` を使っていなければそのまま、公開 IPv4 が戻ったことを IMDS で確かめる
4. 旧: `docker update --restart unless-stopped subetha-router` → `docker start` → `healthy`、`/healthz`、Router が開いている journal が手順 2 で決めたファイルであること
5. 旧: 入口を開ける `systemctl enable --now caddy` → 外から `https://<domain>/healthz`

切り替え後: 旧ホストは Router と Caddy を止めたまま数日置き、問題が無ければ終了する。

## 9. EC2 側で必要なこと（このリポジトリの範囲外）

- インスタンス作成（`ap-northeast-1` 等）、Docker のインストール
- セキュリティグループ: **443 のみ公開**。8787 は直接公開せずリバースプロキシ経由にする
- TLS 終端（Caddy / nginx / ALB のいずれか）とドメイン（`subethalabs`）の DNS
- **鍵の配置**: env を直接書かず、systemd の `EnvironmentFile`（mode 600）か
  AWS Secrets Manager 等を使う。**シェル履歴とプロセス一覧に鍵を残さない**
- **IMDS のトークン取得を塞ぐ**: Router は上流 URL を `fetch` する。
  コンテナは既定の bridge ネットワークで動くため、`169.254.169.254` に**到達できる**。
  Router 自身は IMDS を使わないので、**IMDSv2 を必須にし PUT 応答の hop limit を 1 にする**。
  bridge 経由のコンテナはホストから 1 hop 先なので、トークン応答が届かず**新規のトークンを取れない**。
  **両方が必要**: v1 を許したままでは PUT 不要なので hop limit だけでは効かない。

  **守る範囲を正確に言う**: これは「bridge トポロジのコンテナが IMDS から**自力でトークンを得る**」ことを
  止める。`169.254.169.254` への到達そのものは止めないし、ホスト側で得たトークンの中継も、
  `--network host` で動かした場合も防がない。他のリンクローカル宛て（DNS `169.254.169.253` 等）にも効かない。
  言い換えると、守るのは「**bridge トポロジから IMDSv2 トークンを直接・新規に取得する**」経路だけであり、
  それ以上は主張しない。

  ```sh
  # 現在値（HttpTokens が optional なら v1 が許可されている）
  aws ec2 describe-instances --instance-ids <id> \
    --query 'Reservations[].Instances[].MetadataOptions' --output table

  # v2 必須 + hop limit 1。--http-endpoint は指定しない（既に disabled なら再有効化してしまう）
  aws ec2 modify-instance-metadata-options --instance-id <id> \
    --http-tokens required --http-put-response-hop-limit 1

  # 反映確認。稼働中のインスタンスでは State が pending → applied に変わるまで待つ。
  # HttpTokens=required, HttpPutResponseHopLimit=1, **State=applied** の 3 つを確認する
  aws ec2 describe-instances --instance-ids <id> \
    --query 'Reservations[].Instances[].MetadataOptions' --output table
  ```

  **IMDS のエンドポイントは閉じない。** §8b の egress 制御は、設置時（公開 IPv4 の取得）と受け入れ runner
  （`HOST_ADDRS4` の照合）で **host から** IMDSv2 を使う。`HttpTokens=required` と hop limit 1 で
  コンテナからのトークン取得を止めれば足りる。`--http-endpoint disabled` にすると設置と受け入れが fail-closed で止まる。

  **到達そのものを止める層は別**で、インフラ側（B）は §8b の egress 制御として実装した
  （`docs/ssrf-egress-design.md`）。namespace 内の宛先（loopback、自アドレス）は host から見えないので
  アプリ側（A）の担当であり、**未実装**。**AI が上流 URL を指定できる構成に進む前に** B と A の両方の
  受け入れが要る（`docs/ssrf-requirements.md` §9）。

### 単一インスタンス前提
Router は journal を `flock(2)` で排他する。**同一ホストで 2 つ起動すると 2 つ目は起動に失敗する**
（二重購入を防ぐ意図的な設計）。水平スケールする場合は journal の共有方法を先に決める必要がある。

## 6. 運用上の注意

- **決済は数秒空ける**。公開 x402 facilitator は連続実行で nonce 衝突を起こす
  （実測: 0ms で 2/20 失敗、3 秒で 0/15）。
- 上限に達すると `bucket_limit` で止まる。**止まること自体が安全機構**。
- `unknown` は「送金済みか確定できない」状態。**自動再送しない**（二重支払いを避けるため）。

## 7. 検証済みの実績

このイメージを `docker run` して、リモート MCP 経由で**実決済が通ることを確認済み**:

| レグ | tx |
|---|---|
| 受信（x402 / Base Sepolia） | `0x46aaed66...7f00`（block 47306126、10000 USDC） |
| 送信（MPP / Tempo） | `0x016510e2...4e30` |

イメージ内に `.env` 系ファイルと `.claude_workflow/` が**含まれていない**ことも確認済み。
