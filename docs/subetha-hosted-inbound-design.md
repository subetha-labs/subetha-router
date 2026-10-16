# 設計 v5: hosted Router の受信レグで SubEtha（zERC20）決済を受ける

> 入力: `docs/subetha-hosted-inbound-requirements.md` v4（2026-10-16 owner 承認）。本書は設計フェーズの成果物で、実装は含まない。
> facilitator の記述は SubEtha リポジトリ origin/develop `1aeac6005430d436dd8ae58d2aa343a6eea3b89d`（以下 `F:`）、
> Router の記述は `01e2c4c` 以降の本ブランチ（以下パスのみ）について確認した。
> v1 は独立レビューで REJECT（12 件）。v2 はその全件を反映した（§12）。v2 も REJECT（high 1 件、ほか 5 件）で、v3 は全件を反映した（§13）。v3 は REJECT（v2 の high の残り 1 件）。
> **v4 は要件 v4（受ける資産を zETH から zUSDC へ、owner の決定 2026-10-16）に合わせ、v3 の指摘を反映した（§14）。**

## 0. 要約と範囲

| 項目 | 決定 |
|---|---|
| Q-1 | **解決**。単一支払いの finalize は `root_*`・decider・外部 prover を要らない。公式 operator の root 証明を待ち、SDK の Groth16 鍵で wasm 証明を作り、relayer が `singleTeleport` を送る（§1） |
| O-1 facilitator の置き場所 | **別ホスト（EC2 1 台）＋公開 HTTPS**（**2026-10-16 owner 決定: 案 A**、§2.1） |
| O-2 受ける資産と額 | **zUSDC、10,000（0.01 zUSDC）**（owner 決定、§3） |
| route | `md-x402-eth-snapshot-zusdc`（→ Provider A）、`md-mpp-eth-snapshot-zusdc`（→ Provider B）。`RAILS_ACTIVATION.subetha.inbound` の後ろ（§4） |
| burn 参照 | journal の新しい行 `source_claimed`。状態の検査より**前**に書き、status まで伝える（§5） |
| `npm run sign` | `subetha-zerc20` の分岐。既存の試行の照会を最優先、署名 → 原子的な試行記録 → 送出 → receipt（§6） |

**本書の範囲**: S-1〜S-4 と S-6（facilitator、Router、sign、配備）。**S-5（`@subetha/payer`、FR-6・AC-10）は別の設計書**（payer 0.3.0）で扱い、
その設計・レビュー・AC-10 までを本要件の完了条件とする（§9）。本書の §6 は payer が再利用する分類・送出・試行記録の部品を定める。

## 1. Q-1 の答え（facilitator のソースから）

- finalize は `F:apps/facilitator/src/loop.ts:59` → `finalizeOnce`（`F:packages/zerc20-backend/src/index.ts:2589-2953`）。
- root は**自分で証明しない**。SDK の `collectRedeemContext`（`useLocalRoot: true`、`F:…/redeem.ts:354-361`）が「証明済みでない」と返す間は pending のまま待つ（`F:index.ts:2727-2740`）。
- 証明は `generateSingleTeleportProof`（Groth16、`F:redeem.ts:387-406`）。読むのは SDK の `withdraw_local_groth16_{pk,vk}.bin` だけで、
  global の鍵は、**ファイルが無いときだけ** local に alias される（`F:…/sdkRuntime.ts:7-12, 24-27`。単一 teleport は local scope なので global は読み込まれるが使われない）。
  owner の checkout `b890773` には `withdraw_global_groth16_{pk,vk}.bin` が commit されている（タスク §4 (b)。`sdkRuntime.ts` の注釈はこの checkout では古い）ので、alias は働かない。
  実行時のダウンロードは無い。資産の大きさと証明の時間はここでは主張しない。AC-8 で配備先の値を測って記録する（SDK の commit と host の型と一緒に）。
- 送出は relayer の鍵で `Verifier.singleTeleport`（Sepolia、`F:redeem.ts:409-431`）。receipt で treasury への mint がちょうど 1 件あることを確かめて `finalized`（`F:index.ts:2881-2920`）。
- `decider_url` は設定の検査で必須だが、batch（Nova）経路でしか使わない（`F:config.ts:253`、`F:redeem.ts:580`）。
- `root_*`（約 4 GB）は、ローカル実証で自前の zERC20 スタックの decider が読んでいたもの（`F:docs/BUILDING-THE-STACK.md:150-161`）。facilitator は読まない。
- **finalize の時間切れは自動では再投入されない**。`finalize_timeout_ms` を超えた burn は pending から外れて `failed` になり（`F:index.ts:2717-2722`）、
  再投入は `retryFailed()` の明示の呼び出しだけ（`F:index.ts:3437-3458`。daemon の loop は `finalize()` しか呼ばない、`F:loop.ts:48-59`）。
  再投入は operator の回復手順で、本要件の範囲外（要件 v3 の「やらないこと」）。
- **未確定**: 公式 operator の root 証明の周期（文書は「5 分を超えうる」とだけ書く）。SDK の wasm が Hub（Base Sepolia）RPC を呼ぶか。どちらも §2.4 の観測で確定する。

→ facilitator は **Node の CLI daemon 1 つ**で、Postgres も GPU も要らない。Dockerfile は SDK を再配布しないため意図的に無い（`F:docs/FACILITATOR.md:654-660`）。

## 2. facilitator の運用（FR-1）

### 2.1 置き場所（O-1。owner 決定: 案 A）

| 案 | 内容 | 判定 |
|---|---|---|
| **A** | **別ホスト**（EC2 1 台、AL2023）に host process として置き、Caddy で公開 HTTPS。Router は公開インターネット経由で届く | **採用**。要件 v3 の FR-1.5 を満たす。Router の SSRF 防御 A・B は変えない。Router の image の入れ替えと寿命が独立 |
| B | Router のホストに置き、公開 HTTPS で届かせる（要件 v3 の O-1 推奨） | **不可**。egress 制御はコンテナから host のアドレス（公開・Elastic IP は運用者が書く目録 `HOST_ADDRS4`）への接続を落とし、公開ポートへの hairpin も同じ目録で落ちる（`docs/ssrf-egress-design.md:453, 495-503, 607-609`） |
| C | Router のコンテナの netns を共有するサイドカー＋loopback の origin 完全一致の例外（`src/main.ts:250`）を subetha 受信に広げる | 不採用。要件 v3 が範囲外にした「私設配置のための SSRF 防御の例外」に当たる。image の入れ替えでサイドカーも作り直しになる |
| D | facilitator を Router の image に入れて子 process にする | 不採用。BUSL の `@zerc20/sdk` を Router の image に入れることになる（AGENTS.md:10） |

### 2.2 配備（案 A）

- **SDK の取得は owner が配備先で行う**。Router の作業（Claude）は SDK を複製・転送しない（AGENTS.md:10）。SDK は owner の fork
  `peaceandwhisky/zERC20` の `sdk`（ローカル実証の checkout は `b890773`）。owner が配備先で clone して build し、SubEtha の
  `packages/zerc20-backend/package.json` の `link:../../../zerc20-work/sdk` が解決する位置に置く（同 `:20-24`。workspace の package も配備先で `pnpm install`・`pnpm -r build`）。
  SDK の build に要る toolchain（Rust・wasm-pack の要否）は T-段階の最初に owner の手元の checkout で確かめ、要るなら build の間だけ大きめの型にする。
- **SubEtha facilitator**: 配備先で `1aeac60` を checkout して build（FR-1.1。これより新しい commit を使うなら、その commit で §1・要件 FR-7.4 の記述を確かめ直す）。
- **起動確認**: `subetha-facilitator check --config …` が成功し、`start` の後 `GET /healthz` が 200、未知キーの警告が出ないこと。
- **process**: 専用の system user `subetha-fac`。systemd の unit 1 つ（`subetha-facilitator start --config /etc/subetha-facilitator/fac.toml`）。秘密は
  `EnvironmentFile=`（root 所有、0600）。`Restart=on-failure`。
- **TLS**: Caddy（別 user）が `zerc20-facilitator.subethalabs.com`（O-5）で TLS を終端し、`127.0.0.1:4032` へ流す。**転送するのは**
  `POST /challenge`、`POST /verify`、`POST /settle`、`GET /supported`、`GET /healthz` **だけ**。`/admin/*`・`/history*` ほかは Caddy が 404（FR-1.5）。
- **security group**: 443 は **Router のホストの Elastic IP** と、**受け入れの間だけ owner の作業 IP**（AC-6〜8 のローカル Router 用）。
  80 は ACME（HTTP-01）のため公開し、Caddy は ACME の応答と 443 への redirect だけを返す。self-transfer 経路では payer は facilitator に話しかけないので、一般に公開する必要はない。
- journal は EBS 上のファイル（`"none"` にしない。pending の finalize が再起動で失われる。`F:docs/FACILITATOR.md:370`）。

### 2.3 設定（`fac.toml`。秘密・RPC のキーは書かない）

```toml
profile = "testnet"

[listen]
host = "127.0.0.1"
port = 4032

[network]
chain_id     = 11155111
rpc_url      = "<Sepolia RPC: O-6>"
token        = "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF"   # zUSDC（Sepolia、6 桁）
verifier     = "0xb199A85463Bc5c0009c058E80b8A0d3D5e0025D6"
hub          = "0xF64Bd0a90120611b0c941e3eF546f2F82F1eaB44"   # zUSDC の Hub（Base Sepolia。zETH の Hub とは別）
hub_chain_id = 84532
hub_rpc_url  = "<Base Sepolia RPC: O-6>"
indexer_url  = "https://beta-v1.api.zerc20.io/indexer/zusdc"
decider_url  = "https://beta-v1.api.zerc20.io/decider"         # 単一支払いでは使わない（§1）。設定の検査を通すため

[settlement]
treasury              = "<treasury の address（FR-1.4）>"
journal               = "/var/lib/subetha-facilitator/journal.jsonl"
challenge_ttl_seconds = 600        # 既定 300。§4.4
finalize_timeout_ms   = 1800000    # F:docs/FACILITATOR.md:154 の例

[daemon]
rate_limit_per_min        = 120
challenge_per_key_per_min = 20
max_open_challenges       = 200
# [fee] は置かない（FR-2.1）
```

- `[listen] host`・`port` は `F:apps/facilitator/src/config.ts:111-123, 266-269` のキー。未知キーは警告だけで無視される（同 `:152-161`）ので、起動確認で警告 0 件を見る。
- `[daemon]` の 3 つのキーは `F:config.ts:120-122, 406-410`（既定 120・1000・20）。
- `profile = "testnet"` で起動時に `rpc_url` が 11155111、`hub_rpc_url` が 84532 を返すことを daemon が検査する（`F:daemon.ts:46-56`）。
- **rate limit の鍵は `req.ip`**（`F:apps/facilitator/src/http.ts:58`）。Caddy の後ろでは全要求が同じ鍵になる。`challenge_per_key_per_min = 20` は
  「zUSDC route の quote が全体で 1 分 20 件まで」と同じ意味で、testnet ではこれで足りる。`/challenge` の 429 は quote の失敗（資金は動かない）。
  `/settle` の 429 は既存の adapter が `unknown` に分類する（`src/adapters/inbound/subetha.ts:289`）。
- 秘密（FR-1.3）: `SUBETHA_TREASURY_PK`、`SUBETHA_RELAYER_PK`、`SUBETHA_ADMIN_TOKEN` は新しく作る。作成と所在は `.claude_workflow/local/` にだけ記録する。

### 2.4 facilitator の出口の制限と観測（FR-1.6）

facilitator の process（user `subetha-fac`）だけを対象にする。Caddy の ACME（Let's Encrypt）と OS の更新は別の user で、対象外。

> **v5 の変更**: T0 (d) で、AL2023 の dnsmasq 2.90（`1.amzn2023.0.3`）は **`no-nftset`**（`ipset` はあり）と分かった（タスク §4）。nftables の set を dnsmasq から埋める
> v4 の方式は使えないので、**dnsmasq の `ipset=` と ipset（7.11）と iptables-nft（1.8.8）の `-m set`** に置き換える。保証の範囲（O-8）と観測は v4 と同じ。

- **名前の制限（dnsmasq）**: dnsmasq を `listen-address=127.0.0.2` と **`bind-interfaces`** で `127.0.0.2:53` にだけ bind させ（systemd-resolved の `127.0.0.53` と衝突しない）、
  `subetha-fac` 専用の resolver にする。**`cache-size=0`**（毎回の問い合わせが上流へ行き、そのたびに ipset に入る。cache の hit では ipset が更新されないため）。
  facilitator の systemd の unit で `BindReadOnlyPaths=/etc/subetha-facilitator/resolv.conf:/etc/resolv.conf`（中身は `nameserver 127.0.0.2` だけ）と
  `BindReadOnlyPaths=/etc/subetha-facilitator/nsswitch.conf:/etc/nsswitch.conf`（`hosts: files dns`。`resolve` の NSS module を使わせない）、
  `InaccessiblePaths=/run/systemd/resolve /run/dbus`（systemd-resolved の Unix socket・D-Bus に届かせない）とする。ホストの他の process の設定は変えない。
  **既定の resolver を変えるだけでは強制にならない**ので、強制は下の iptables が持つ（`127.0.0.53` などへの直接の問い合わせも落ちる）。dnsmasq が上流へ転送するのは O-6 の 2 つの RPC のホスト名と
  `beta-v1.api.zerc20.io` だけで、ほかの名前は NXDOMAIN（`address=/#/` と許可名ごとの `server=`）。
- **接続の制限（ipset + iptables）**: ipset `fac_allowed4`（`hash:ip family inet timeout 3600`）。dnsmasq の `ipset=/<許可名>/fac_allowed4` で、許可名の解決結果の IPv4 を
  set に入れる（dnsmasq が上流の応答を処理するたびに入れ直し、timeout が戻る。`cache-size=0` なので問い合わせのたび）。iptables の `OUTPUT` の**先頭**（既存の広い ACCEPT より前）に
  `-m owner --uid-owner subetha-fac -j FAC-EGRESS` を挿し、chain `FAC-EGRESS` の順は:
  1. `-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`（4032 への Caddy の接続への応答、確立済みの接続）
  2. `-o lo -d 127.0.0.2 -p udp --dport 53 -j ACCEPT`、同じく tcp（dnsmasq だけ。**loopback の他の宛先は許さない**）
  3. `-m set --match-set fac_allowed4 dst -p tcp --dport 443 -m conntrack --ctstate NEW -j LOG --log-prefix fac-allow`、続けて同じ条件で `-j ACCEPT`
  4. counter つきの `-j DROP`
  ip6tables は `OUTPUT` の先頭で同じ uid を DROP。
  **確立済みの接続の扱い**: 1. があるので、set の要素が timeout で消えても**既に確立した接続**（keep-alive）は続く。新しい接続は 3. の set の照合を通る。log は NEW のときだけなので、
  keep-alive の再利用は log に出ない（観測 (c) は新しい接続の宛先の記録）。
- **起動の順**: `subetha-fac-egress.service`（set と規則を作る。oneshot、`RemainAfterExit=yes`）→ `dnsmasq.service`（`Requires=`・`After=` egress）→ facilitator の unit
  （`Requires=`・`After=` の両方に egress と dnsmasq）。dnsmasq が待ち受けるまで facilitator を起動しない（dnsmasq の unit が `Type=forking` で bind の後に戻る既定の形を使う。
  G-1 で `ss -lunp` で確かめる）。規則が無ければ facilitator は起動しない。
- **前提の確認**: kernel の module `ip_set`・`xt_set`・`xt_owner` が AL2023 の kernel で読めることを、G-1 の最初にホストで確かめる（container の kernel は Colima のものなので T0 では確かめられない）。
  読めなければ設計に戻す。
- **保証の範囲（O-8、owner 決定）**: これは「`subetha-fac` は許可した名前しか解決できず、接続できるのは許可した名前が解決した IPv4 の 443 だけ」という保証で、
  **ホスト名そのものの排他ではない**。許可した IP を共有する別のホスト名（CDN）への HTTPS は、IP では区別できない。facilitator の
  コードが接続先に使う URL は設定の 4 つ（`rpc_url`・`hub_rpc_url`・`indexer_url`・`decider_url`）だけである（タスク T0 (a) の記録）ことと合わせて、
  FR-1.6 をこの範囲で満たすものとする。
- **観測（受け入れの証拠）**:
  - (a) 名前の拒否: facilitator と同じ設定（`systemd-run --uid=subetha-fac -p BindReadOnlyPaths=… -p InaccessiblePaths=…`）で `getent hosts example.com` が失敗し、
    dnsmasq の query log に NXDOMAIN が出る。**直接の問い合わせも拒否**: 同じ条件で `dig @127.0.0.53 example.com` と `dig @<VPC の resolver> example.com` が失敗し、DROP の counter が増える。
    `resolvectl query example.com` が socket に届かず失敗する。
    TCP の DNS（`dig +tcp @127.0.0.53 example.com`）も同じく失敗する。set の期限の後の再接続: set の要素を手で消し（`ipset del`）、新しい解決 → set への再登録 → 新しい接続が通ることを確かめる。
  - (b) IP の拒否: 同じ条件で `curl --resolve example.com:443:<許可外の IPv4> https://example.com` が失敗し、DROP の counter が増える。
  - (c) 実際の依存先: 起動時（daemon は起動時に `hub_rpc_url` を呼ぶ: `F:apps/facilitator/src/daemon.ts:46-56`）と AC-7・AC-8 の間を**分けて**、`fac-allow` の log の宛先 IP と
    dnsmasq の query log の名前を記録する。DROP の counter が増えたら宛先を記録し、許可するかを判断する。IP は共有されうるので、通信を SDK の呼び出しに帰属させるのは
    ソースの呼び出し箇所（T0 (a)）と合わせたときだけ。

### 2.5 監視（R-1・R-2）

- `GET /healthz` を owner の手元から見る。finalize の進み具合は facilitator の journal（`accepted` → `finalized` / `failed`）で見る。
- `failed`（時間切れ）は自動では戻らない（§1）。AC-8 で起きたら `failed` として記録し、回復するかどうかは owner の判断（本要件の範囲外）。

## 3. 額と手数料（FR-2、O-2）

- **`source.amount = "10000"`（0.01 zUSDC、6 桁）**。owner の決定（2026-10-16）で、他の静的 route の受信額 `INBOUND.amount = "10000"`（`tools/remote-mcp-config.ts:27`）と
  Provider の価格にそろえる。
- facilitator は `quoted − teleportFee(quoted) ≤ 0` の challenge を 400 で拒む（`F:index.ts:985-987`）。redeem 手数料は on-chain の `redeemFeeBps()` を採用し
  （`F:index.ts:472-497`）、**切り上げ**で計算する: `fee = ⌈amount × bps / 10000⌉ + 定額`（`F:index.ts:422-424`）。
- zUSDC の verifier の `redeemFeeBps()` は **10**（2026-10-16 の読取、`docs/evidence/subetha-hosted-inbound-probe-2026-10-16.md` §4）。正味 = 10,000 − ⌈10,000 × 10 / 10,000⌉ = **9,990** > 0。
  値は運用者が変えうるので、AC-6 の `/challenge` が 200 を返すことを観測とし、AC-8 では mint の額をその時点の `redeemFeeBps()` で計算した値と比べる。
- `[fee]` を置かないので、challenge の `amount` は `source.amount` と等しい（`F:index.ts:979-981`）。`src/core/orchestrator.ts:461-467` の一致検査はそのまま通る。
  手数料付きの facilitator では quote が `source_terms_mismatch` で止まる（AC-2）。
- payer の資金: 試験用 USDC（`0x2f6f…7590`）を mint し、LiquidityManager `0xB9f4…F3C6` に approve して wrap すると zUSDC になる（公式文書 `for-developers/quickstart/wrap-unwrap.md`）。
  `mint` が誰でも呼べることは、1 つの送り主・1 回の `eth_call` の模擬で観測しただけ（証跡 §4）。実際の mint・wrap は T-段階の payer の準備で確かめる。
  要件 §7 の上限（mint・wrap 各 1 USDC）は token の量としては 100 回分だが、**購入は §7 の上限 10 件まで**で、Sepolia ETH のガスも回数を制限する。手順は README に書く（R-4）。
- facilitator のコードに token の決め打ちは無い（zETH・18 桁の検索で 0 件。`redeem.ts:74` の 18 は chain の native ETH）。zUSDC での最初の確認は AC-6・AC-7（要件 R-7）。

## 4. hosted の構成（FR-3、`tools/remote-mcp-config.ts`・`tools/remote-mcp.ts`）

### 4.1 定数と切り替え

```ts
export const INBOUND_ZUSDC = {
  network: "eip155:11155111",
  asset: "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF",
  decimals: 6,
  amount: "10000",
} as const;
export const ROUTE_ZUSDC_TO_X402 = "md-x402-eth-snapshot-zusdc";   // → Provider A
export const ROUTE_ZUSDC_TO_MPP  = "md-mpp-eth-snapshot-zusdc";    // → Provider B
/** SubEtha facilitator の公開ホスト名（O-5）。動的上流の宛先として、有効化に関係なく常に拒否する。 */
export const SUBETHA_FACILITATOR_HOSTNAME = "zerc20-facilitator.subethalabs.com";
export const SUBETHA_FACILITATOR_URL_ENV = "SUBETHA_ZERC20_FACILITATOR_URL";
```

- `RailsActivation` に `readonly subetha?: { readonly inbound: boolean }` を足す（送信は範囲外なので欄を持たない）。無ければ `false`（`subethaOf`）。
  `RAILS_ACTIVATION` は G-4 まで `false`（FR-3.3）。
- `subetha.inbound` が `true` のとき:
  - env `SUBETHA_ZERC20_FACILITATOR_URL` が無い・`https:` でない・host が `SUBETHA_FACILITATOR_HOSTNAME` でない・path を持つなら、固定文で設定生成を止める（値は出さない）。
  - 子の Router への `ROUTER_SUBETHA_FACILITATOR_URL` をこの値にする。`false` のときは今どおり `INBOUND.facilitator`（subetha の route が無いので使われない）。
  - route 2 本（`sourceRail: "subetha"`、`source` は `INBOUND_ZUSDC`、`payTo` は無し: `src/config.ts:549-553`）。上流は既存の `UPSTREAM_X402`・`UPSTREAM`。
  - 静的の予算の区分 `{ network, asset: INBOUND_ZUSDC.asset, maxTotal: env SUBETHA_INBOUND_MAX_TOTAL ?? "1000000000", maxPerPurchase: "10000" }`（既存の静的の区分と同じ値と env）（FR-3.5）。
- **動的上流の拒否**（FR-3.4、有効化に関係なく）: `denyHosts`（`tools/remote-mcp-config.ts:784`）に `SUBETHA_FACILITATOR_HOSTNAME` を**常に**入れる
  （`PUBLIC_HOSTNAME` と同じ扱い）。`src/main.ts:716-727` の `real.subethaFacilitatorUrl` 由来の拒否は、off のとき埋め草の host しか入れないため、それに頼らない。
- **egress**: facilitator のホストは公開アドレスなので、Router のホストの SSRF 防御 B を通る（変更なし）。

### 4.2 一覧と quote の表示（FR-4）

- `sourceRailListingOf`（`src/http/projection.ts:77`）: `route.sourceRail === "subetha"`（**明示のときだけ**）に `{ rail: "subetha", scheme: "subetha-zerc20" }`。
  未指定の既存 route（fixture・ローカル構成）の一覧は変えない。
- MCP の `approvalSubject`（`src/mcp/tools.ts:262`）: 受信の offer の `scheme` が `subetha-zerc20` のとき、`source` に `rail`・`scheme`・`payTo` を足し、
  `subethaDisclosures` を足す（加算のみ）:
  ```json
  { "payToIsOneTimeBurnAddress": true, "burnTotal": "<offer.amount>", "fundsMoveAtSign": true,
    "deliveredOnAccepted": true, "treasuryMintIsAsynchronous": true, "awaitingPaymentDoesNotMeanUnpaid": true }
  ```
- MCP の server の説明（`src/mcp/server.ts:103-108`）に「SubEtha（zUSDC）は sign で burn を送る。承認は sign の前」を足す。

### 4.3 受信の HTTP の期限

- 今は `createSubethaInbound` に `timeoutMs` を渡しておらず既定 5 秒（`src/adapters/inbound/subetha.ts:143`、`src/main.ts:889-892`）。subetha の route の network の
  `evmTestnetDeadlinesOf(...).inboundFacilitatorMs`（Sepolia 50 秒、`src/shared/networks.ts:183-186`）の最大を渡す（route が無ければ今の既定）。
- 購入全体の外側の期限（HTTP・MCP）が 50 秒の受信に足りるかを T-段階で確かめる（足りなければ同じタスクで直す）。

### 4.4 期限（R-5）

- 承認の期限は `min(approvalTtlMs = 600 秒, offer の期限)`（`orchestrator.ts:471-473`）。facilitator の `challenge_ttl_seconds = 600` で他の route と同じ 10 分にそろえる。
- sign は**新しい burn**を残り 120 秒未満の offer では作らない（§6.1）。
- `accepted` の記録が消えるのは `expiresAt + challengeTtlSeconds` の後（`F:index.ts:3413-3433`）。

## 5. Router の core（FR-7）

### 5.1 申告された burn の記録（`source_claimed`）

`purchaseStatic`（`src/core/orchestrator.ts:524-`）の検査の順を次にする。**変えるのは ④ の挿入だけ**:

1. 動的の intent ではない（526 行）
2. `principalId` の一致（530 行）
3. `routeId` の一致（535 行）、`requestId` の一致（539 行）
4. **申告の記録（新規）**
5. 状態が `created` 以外なら現在の状態を返す（543 行。既存）
6. 承認の一致（546 行。既存）以下、既存のまま

④ の規則:

- 対象: 受信の offer の `scheme` が `subetha-zerc20`、`request.credential` がある、`request.approval === intent.quoteId`、
  `credential.payload.challengeNonce === intent.quoteId`、`credential.payload.burnTxHash` が `^0x[0-9a-fA-F]{64}$`。どれかを満たさなければ ④ は何もしない（既存の流れのまま）。
- 小文字に正規化した hash が既にその intent の申告にあれば、書かずに ⑤ へ。
- 無ければ `{ event: "source_claimed", patch: { burnTxHash, claimedBy: "payer" } }` を書いてから ⑤ へ。**状態が終端でも書く**（verify 失敗の後に正しい hash を出し直した場合も残る）。
- **件数の上限**: 1 intent あたり 8 件。上限に達していて新しい hash が来たら、**書かずに** `{ status: "rejected", code: "claim_limit_reached" }` を返し、
  ⑤ 以降（verify・settle）に**進まない**（記録できない credential を settle しない）。
- **書き込みが失敗したら** `{ status: "unknown", terminalReason: "source_claim_unrecorded" }` を返し、⑤ 以降に進まない（FR-7.1。journal の writer はその後止まる: `src/core/journal.ts:294-297`）。
- 所有者・`requestId`・承認の一致を先に検査するので、他人の quote に申告を書けない。

### 5.2 status までの伝搬

- `Intent`（`src/core/intent.ts`）の `source` に `claimedTxRefs?: readonly string[]`。
- `reduce`（`src/core/store.ts:310-386`）に `source_claimed`: **変えるのは `source.claimedTxRefs`（重複なしで足す）と `updatedAt` だけ**。状態・`terminalReason`・`source.outcome`・
  検証済みの `source.txRef`・`destination`・`result` は保つ（終端の購入に申告を足しても、`orchestrator.ts:543-545` の再実行の防壁は状態に依るので崩れない）。
  試験: `delivered`・`unknown`・`source_failed` の intent に申告を足し、再起動の replay と同じ quote の再購入で、状態と返る結果が変わらないこと。
  `created` の intent の復元（`store.ts:276-306`）は今までどおり欄を持たない。
- `Projection`（`src/core/orchestrator.ts:104-129`）の `source` に `claimedTxRefs?` と、静的購入の `fundsMoveOnCredential?: boolean`（受信の offer の
  `extra.fundsMoveOnCredential === true`）を足し、`projectionOf`（`orchestrator.ts:184-`）で埋める。
- `projectionBody`（`src/http/projection.ts:211`）の `source` に `claimedTxRefs`（1 件以上のときだけ）と `claimedTxRefsAreUnverified: true`。
  `txRef`（settle が確かめたもの）とは別の欄。
- 静的購入で `fundsMoveOnCredential` が `true` かつ状態が `awaiting_payment` のとき、`awaitingPaymentDoesNotMeanUnpaid: true`（動的の既存の開示 `projection.ts:253` と同じ意味）。
  Tempo・Solana の MPP の静的 route にも付く（加算のみ、意味は正しい）。
- MCP の `subetha_router_status` は HTTP の射影を返す。新しい欄がそのまま届くことを試験で確かめる。

### 5.3 rollback

- 古い image は未知の event を読み飛ばす（`store.ts:383-385`）ので journal は読めるが、**申告の表示（FR-7.2）は失われる**。
- 規則: `source_claimed` を書くのは subetha の route だけで、route は `RAILS_ACTIVATION.subetha.inbound` が `true` の image でしか出ない。
  - G-4（有効化）より前の image への rollback は自由（申告の行は無い）。
  - **G-4 の後の rollback の先は、本設計の申告の射影を含む image に限る**（G-3 で配備する image 以降。§11）。`docs/DEPLOY.md` の該当節と `deploy/swap-image.sh` の rollback の候補の説明に書く。
  - 申告の射影を持たない image に戻す必要が出たら、先に有効化を `false` にした image を出し（新しい購入を止める）、既存の申告は journal の行（`source_claimed`）を運用者が読んで答える。
- 試験: 申告の行を含む journal を、現行の reducer と、`source_claimed` を知らない reducer（今の `reduce` の写し）の両方で replay し、前者は表示、後者は状態が同じであること。

### 5.4 送信レグと再送（FR-7.3・7.4）

- 送信レグは既存の write-ahead 予約と at-most-once のまま。⑤ により、同じ quote で 2 度目の verify・settle・送信は起きない（`orchestrator.ts:543-545`）。
- 同じ `requestId` の quote は記録済みの quote を返す（冪等）。Router が同じ購入に新しい challenge を出すことはない。
- settle の自動再送はしない。

## 6. `npm run sign` の subetha 分岐（FR-5）

### 6.1 流れ（`tools/sign-run.ts` → `tools/subetha-payer.ts`、新規）

`runSign`（`tools/sign-run.ts:57-`）は quote 文書全体を受け、`source.offer` を取り出している。`offer.scheme === "subetha-zerc20"` のとき、次の順で進む。
**鍵を読むのは 4. から**。

1. **束縛の検査**（鍵・RPC に触れない）: 拒否なら終わり。

   | 検査 | 拒否の理由 |
   |---|---|
   | network・token が表 `SUBETHA_ZERC20_ASSETS` に無い | `the SubEtha offer's network or token is not in the table` |
   | `payTo` が EVM address でない、または 0 address | `the SubEtha offer has a malformed burn address` |
   | `extra.challengeNonce` が `0x` + 64 hex でない | `the SubEtha offer has no well-formed challengeNonce` |
   | `amount` が 10 進でない・0・表の `maxAmount` 超え | `the SubEtha offer amount is out of range` |
   | quote の `source.amount` が無い、または `amount` と違う | `the SubEtha offer amount differs from the approved quote` |

   表（`src/shared/networks.ts`、受信の表とは別）:
   ```ts
   export const SUBETHA_ZERC20_ASSETS = Object.freeze([
     { network: "eip155:11155111", token: "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF", decimals: 6, maxAmount: 20_000n },   // 上限は既存の SIGN_MAX_AMOUNT と同じ
   ]);
   ```
   `extra.helper` は拒否しない（self-transfer を選ぶ。helper は能力の広告: `src/adapters/inbound/subetha.ts:222-230`）。
2. **既存の試行の照会**（§6.2。期限に関係なく、鍵に触れない）: この `(chainId, challengeNonce)` の記録があれば **5.** へ進み、新しい transfer は作らない。
   記録が壊れている・束縛が offer と違う・一時ファイルだけがある、なら §6.3 の fail closed。
3. **期限**: `extra.expiresAt` − 現在 < 120 秒なら拒否（新しい burn だけに効く）。
4. **鍵 → 残高 → 署名 → 記録 → 送出**:
   - 鍵を読み、payer の address を出す。
   - 残高（FR-5.2）: zUSDC の `balanceOf(payer)` ≥ amount、ETH ≥ `gas × maxFeePerGas`（gas は `estimateGas` × 1.2、上限 120,000、`maxFeePerGas = 2 × baseFee + priority`）。
     足りなければ拒否（署名も送出もしない）。
   - `nonce = getTransactionCount(payer, "pending")`。`transfer(payTo, amount)` を明示の nonce・gas・fee で `signTransaction`、`txHash = keccak256(rawTx)`。
   - 試行記録を原子的に作る（§6.2）。**作れなければ送らずに終わる**（既に記録があったなら 5.）。
   - `sendRawTransaction(rawTx)`。例外は 6.（`unknown`）。
5. **receipt の照会**（上限 120 秒。既存の記録から来た場合も同じ）:
   - `success` かつ logs に `Transfer(payer → payTo, amount)`（token のログ）がちょうど 1 件 → credential を stdout に出す（FR-5.6）。
   - `success` だが上のログが合わない → fail closed（stdout に何も出さない。stderr に「burn の receipt が期待と違う。資金は動いた可能性がある」と hash、exit 2）。
   - `reverted` → 拒否（transfer は失敗、ガスだけ消費）。credential は出さない。exit 1。
   - receipt が無い・RPC の例外・時間切れ → 6.
6. **`unknown`**（FR-5.5）: stdout に何も出さず、stderr に `unknown`・`txHash`・記録のパスを出して exit 2。再送しない（同じ `rawTx` の再送出もしない）。

credential（stdout、base64）:

```json
{ "x402Version": 2, "accepted": <offer そのまま>, "payload": { "challengeNonce": "<offer.extra.challengeNonce>", "burnTxHash": "<txHash>" } }
```

（ローカル実証の形 `tools/u01r-s3-inbound.ts:49-53`。preflight の `stableJson` 一致のため `accepted` は offer を変えない。）

### 6.2 試行記録（原子的な作成）

- 場所: `~/.subetha-router/sign-attempts/`（0700）。名前 `<chainId>-<challengeNonce>.json`（0600）。リポジトリの外（別 worktree でも同じ記録を見る）。
- **ディレクトリの耐久性（毎回、署名の前）**: `~/.subetha-router` と `sign-attempts` を 1 段ずつ作る（無ければ `mkdir`）。その後、**誰が作ったかに関係なく毎回**、
  `sign-attempts`、`~/.subetha-router`、`~`（ホーム）の 3 つを `open` して `fsync` する（ディレクトリの中身の `fsync` は、そのディレクトリの親の中の名前を永続化しない。
  前の実行が `mkdir` の直後に中断して親の `fsync` をしていない場合も、次の実行がここで永続化する）。どれかが失敗したら署名の前に止まる（鍵は読んでも署名しない）。
  記録の作成（下）の `fsync` と合わせ、送出の前に記録の名前とそこまでのディレクトリの名前がすべて永続化されている。
- 作成: 一時ファイル `.<名前>.<pid>.<乱数>.tmp` に書く → `fsync` → **`link(tmp, 最終名)`**（既にあれば `EEXIST` で失敗する。最終名は**完全な中身でしか現れない**）
  → ディレクトリの `fsync` → `unlink(tmp)` → ディレクトリの `fsync`。送出は最終名のディレクトリの `fsync` が返った**後**だけ。
- 中身: `{ version: 1, chainId, challengeNonce, payer, payTo, token, amount, nonce, txHash, rawTx, createdAt }`。書くのは 1 回だけ（結果は書かない。真実は chain の receipt）。
- 読む時の検査（鍵を読まずに行う）: JSON として読めて全欄の形が正しく、`chainId`・`challengeNonce`・`payTo`・`token`・`amount` が今の offer と一致し、`keccak256(rawTx) === txHash`。
  さらに **`rawTx` を復号して**（viem の `parseTransaction`・`recoverTransactionAddress`）: chain id = `chainId`、`to` = `token`、`value` = 0、`data` = `transfer(payTo, amount)` の calldata と完全一致、
  `nonce` = 記録の `nonce`、署名から復元した address = 記録の `payer`。一つでも違えば §6.3 の fail closed。鍵を読んだ後の新しい試行では、`payer` = 鍵の address も確かめる。
- **`link` が `EEXIST`**（同時の sign に負けた）: 自分が署名した transaction は捨て、**勝った側の記録を読んで上の検査をし、その `txHash` で 5. の照会へ**進む。自分の `rawTx` は送らない。
- `rawTx` は秘密ではない（送出すれば公開される署名済みの transaction）。鍵・passphrase は書かない。記録は自動で消さない。

### 6.3 中断点と再実行の挙動

| 中断した位置 | 残るもの | 再実行の挙動 | 2 本目の送出 |
|---|---|---|---|
| 署名の前・署名の後で記録の前 | 無し（一時ファイルが残ることがある） | 最終名が無く一時ファイルがあるとき: **fail closed**（「前の sign が中断した。送出はしていないはずだが、記録を確かめてから手で消す」）。一時ファイルも無ければ新規 | 無し |
| 一時ファイルの write・fsync の途中 | 一時ファイル | 同上 | 無し |
| `link` の後、ディレクトリの fsync の前 | 最終名（電源断で消えることがある）。送出前 | 最終名があれば照会 → receipt 無し → `unknown`。消えていれば一時ファイルで fail closed | 無し |
| 記録の後、送出の前 | 最終名 | 照会 → receipt 無し → `unknown`（送られていないが、それを証明できない） | 無し |
| 送出の後、receipt の前 | 最終名 | 照会 → receipt で確定、または `unknown` | 無し |
| receipt の後、credential の出力の前 | 最終名 | 照会 → 同じ credential を出す | 無し |
| 同時に 2 つの sign | 片方の `link` が `EEXIST` | 負けた側は照会へ（相手が未送出なら `unknown`） | 無し |
| 記録が壊れている・束縛が違う | 最終名 | fail closed（「資金が動いたか分からない」、記録のパス）。消さない・作り直さない | 無し |

### 6.4 承認の順序（FR-5.7）

- sign の時点で資金が動く（Tempo の MPP と同じ）。CLAUDE.md の「Step 4 means different things on different rails」の表に subetha の行を足し、承認は sign の前と書く。

## 7. AC-3（要件 v4 で修正済み）

payer の address は鍵（env `SUBETHA_PAYER_PRIVATE_KEY`、`tools/sign-payment.ts:161`）からしか得られないので、残高は鍵を読んだ後にしか確かめられない。
要件 v4 の AC-3（owner の決定 2026-10-16、O-7）: FR-5.1 の各条件では鍵に触れる前に拒み、FR-5.2 の残高不足では鍵は読むが**署名も送出もしない**
（`signTransaction`・`sendRawTransaction` 0 回）。§6.1 はこのとおり。

## 8. FR・AC の対応

| 要件 | 設計 | 試験・証跡 |
|---|---|---|
| FR-1.1〜1.5 | §2.1〜2.3 | AC-6 の記録（commit、`check`、`/healthz`、Caddy の 404、security group） |
| FR-1.6 | §2.4 | §2.4 の観測（負の対照、DROP の counter、dnsmasq の log） |
| FR-2.1〜2.4 | §3 | AC-2、AC-6（`/challenge` 200）、AC-8（mint の額） |
| FR-3.1〜3.3 | §4.1 | 設定生成の unit（off: route 0・env を読まない・quote が `unknown_route`、on: 2 本） |
| FR-3.4 | §4.1 | 設定生成の unit（on・off とも `denyHosts` に含む）＋ AC-6 |
| FR-3.5 | §4.1 | 予算の unit（区分・1 件の上限） |
| FR-4.1〜4.3 | §4.2 | 一覧・subject の unit |
| FR-5.1〜5.7 | §6 | AC-3、AC-4 |
| FR-6.1〜6.3 | §0・§9（別設計） | AC-10（別設計で試験を定める） |
| FR-7.1〜7.4 | §5 | AC-5、§5.3 の replay 試験 |

| AC | 試験 | 置き場所 |
|---|---|---|
| AC-1 | off で一覧に無く、quote が `unknown_route`。on で 2 本、`source.rail/scheme` | `tests/unit/remote-mcp-config*.test.ts`、wire の一覧・quote |
| AC-2 | 合成 facilitator が `amount` に手数料を足す → `source_terms_mismatch` | `tests/wire/`（合成 facilitator） |
| AC-3 | §6.1 の 1. の各拒否で鍵の読み出し 0 回。残高不足で `signTransaction`・`sendRawTransaction` 0 回（§7 の修正後の文言） | `tests/unit/sign-subetha*.test.ts`。sabotage: 各検査を外して落ちる |
| AC-4 | 偽 RPC（HTTP）と**子 process の SIGKILL**: §6.3 の各行の位置で子を殺し、再実行の結果と `sendRawTransaction` の受信回数（偽 RPC が数える）が表どおり。期限の後の再実行も照会に進む。初回の実行（ディレクトリが無い）と、`mkdir` の直後に中断した後の実行の両方で、署名の前に `sign-attempts`・`~/.subetha-router`・`~` の `fsync` が呼ばれる（fs の包みが呼び出しの順を記録）。どれかの `fsync` の失敗で署名 0 回。記録の各欄・`rawTx` の各要素を 1 つずつ壊した記録で fail closed。`EEXIST` で勝った側の hash を使う。**SIGKILL は process の中断の証拠で、電源断の耐久性の証拠ではない**: 電源断については `fsync` の呼び出しの順の試験と POSIX の意味に依る（実機の電源断は試さない） | `tests/wire/sign-subetha-crash*.test.ts`（子は試験用の入口で fs・RPC の包みに殺す位置を差す。製品のコードに試験用の分岐は入れない） |
| AC-5 | 合成 facilitator で: verify 失敗・preflight の期限切れ・`quote_changed`・`offer_changed`・settle の応答喪失・再起動の後、status に `claimedTxRefs`。終端の状態への出し直しも記録。上限で `claim_limit_reached` かつ verify 0 回。送信の呼び出し 0 回または 1 回。同じ quote で新しい challenge が出ない | `tests/wire/subetha-claim*.test.ts` |
| AC-6 | hosted の設定生成で起動したローカル Router が facilitator から `/challenge` を 1 件。動的上流に facilitator のホストと私設アドレスで `destination_blocked`（on・off の両方） | 手動（無課金）。`docs/evidence/` |
| AC-7 | zUSDC → A、zUSDC → B が各 1 件 `delivered` | 実決済。`docs/evidence/`（burn・送信の tx、journal の行） |
| AC-8 | AC-7 の 2 件が `finalized`、mint の額が §3 の式と一致。`accepted` → `finalized` の時間 | 観測。`docs/evidence/`（facilitator の journal、mint の tx） |
| AC-9 | 配備後の hosted で 2 件 `delivered` | 実決済。`docs/DEPLOY.md` |
| AC-10 | payer 0.3.0（別設計） | 別設計 |

## 9. S-5（`@subetha/payer`）の扱い

- §6 の分類・試行記録・送出・照会は、payer の daemon が vendor できる module にする（`networks.ts` と同じ。BUSL の SDK は使わない: burn は ERC-20 の `transfer` だけ）。
- payer 0.3.0 の設計書（ダイアログの rail 行、Cancel・時間切れで送出 0 回、`find_routes` の必要資産 zUSDC と Sepolia ETH）は、§11 の G-4 の後に書き、
  レビューと owner の確認を経る（§11 の G-5）。**その設計と AC-10 が終わるまで本要件は完了としない。**

## 10. owner の判断

| ID | 判断 | 状態 |
|---|---|---|
| O-1 | facilitator の置き場所 | **決定（2026-10-16）: 案 A**。EC2・Elastic IP・DNS・security group の作成は owner |
| O-2 | 受ける資産と額 | **決定（2026-10-16）: zUSDC、10,000**（§3） |
| O-5 | facilitator の公開ホスト名 | **決定（2026-10-16）: `zerc20-facilitator.subethalabs.com`** |
| O-6 | facilitator の Sepolia・Base Sepolia RPC | **決定（2026-10-16）: Router と別のキー** |
| O-7 | AC-3 の修正（§7） | **決定（2026-10-16）**。要件 v4 の AC-3 |
| O-8 | FR-1.6 の保証の範囲（§2.4: 名前は排他、接続は許可名が解決した IP まで） | **決定（2026-10-16）: この範囲で可**（owner「一旦テストネットでの検証なので、その制限で良い」） |

## 11. ゲートの名前（要件 §8 の段階 5 との対応）

| ゲート | 内容 | 要件の AC |
|---|---|---|
| G-1 | facilitator を配備し、起動確認と §2.4 の観測 (a)(b) | AC-6 の前半 |
| G-2 | Router の変更（本設計の §4〜§6）を main に入れ、ローカル Router で AC-6・AC-7・AC-8 | AC-6〜AC-8 |
| G-3 | hosted の image を、本設計の Router の変更を含み **`subetha.inbound = false`** の image に入れ替える（申告の射影を持つ基準の image） | — |
| G-4 | `subetha.inbound = true` の image に入れ替え、hosted で 2 件 | AC-9 |
| G-5 | payer 0.3.0（別設計）。設計は G-4 の後に書く | AC-10 |

§5.3 の rollback の規則の「G-4 の後」は、`subetha.inbound = true` の image が一度でも公開された後を指す。その後の rollback の先は G-3 以降の image に限る。

## 12. 次の段階

本書 → Codex 独立レビュー（v4 APPROVE）→ 親の読み返し → owner の確認（O-8 を含め 2026-10-16 に完了）→ **タスク分解**。

## 12. v1 レビュー（2026-10-16、Codex CLI 0.157.1、`gpt-6-astra`、read-only）への対応

判定 **REJECT**（12 件）。全件をソースで確かめ、反映した。

| # | 指摘 | 反映 |
|---|---|---|
| 1 | 期限の検査が既存の試行の照会より先 | §6.1: 照会（2.）を期限（3.）の前に。AC-4 に期限の後の再実行 |
| 2 | 試行記録の途中・同時・receipt 後の失敗が未定義 | §6.2 を `link` による原子的な作成に。§6.3 の中断点の表。AC-4 を子 process の SIGKILL に |
| 3 | 申告の位置が状態の検査の後、上限で黙って捨てる | §5.1: 状態の検査より前、上限で `claim_limit_reached` を返し verify に進まない |
| 4 | status までの伝搬と rollback | §5.2（Intent → Projection → HTTP・MCP）、§5.3（rollback の規則と replay 試験） |
| 5 | off で facilitator の拒否が消える | §4.1: ホスト名の定数を `denyHosts` に常に入れる |
| 6 | FR-1.6 の根拠が無い、引用が古い | §2.4（dnsmasq＋nftables、観測）。§2.1 の引用を現行の節に |
| 7 | `daemon.listen` は存在しないキー | §2.3 を `[listen] host`・`port` に |
| 8 | SDK の鍵の説明が誤り、SDK の配備が copy 禁止と食い違う | §1（global は local の alias、大きさ・時間は主張せず AC-8 で測る）。§2.2（SDK は owner が配備先で取得） |
| 9 | 時間切れの自動再投入は誤り | §1・§2.5 |
| 10 | 手数料は切り上げ、正味が正は条件つき | §3 |
| 11 | AC-3 を設計内で弱めた | §7 で要件の修正として提案（O-7） |
| 12 | FR-6・AC-10 の脱落、対応表の不足 | §0・§9（完了条件に含める）、§8 の全 FR・AC の表 |

## 13. v2 レビュー（2026-10-16、同じ reviewer）への対応

判定 **REJECT**。v1 の 12 件は RESOLVED 9・PARTIAL 3。新しい high は 1 件。

| # | 指摘 | 反映 |
|---|---|---|
| 1（high） | 初回にディレクトリの名前が親に永続化されず、送出の後の電源断で記録が消えうる | §6.2: 毎回、送出の前に新しい段とその親を `fsync`。AC-4 に初回の `fsync` の順と、SIGKILL と電源断の証拠の区別 |
| 2 | 記録の `rawTx` の中身を照合していない、`EEXIST` の扱い | §6.2: `rawTx` を復号して chain・`to`・`value`・calldata・nonce・署名者を照合。`EEXIST` は勝った側の記録の hash |
| 3 | reducer の文が逆（状態を変えてよいと読める） | §5.2: 変えるのは `claimedTxRefs` と `updatedAt` だけ。終端への申告の試験 |
| 4 | NXDOMAIN では DROP の counter は増えない、IP の set はホスト名の排他ではない、resolver の付け方 | §2.4: 名前と IP の試験を分けた、`fac-allow` の log、保証の範囲を O-8 に、DNAT と set の timeout を明記 |
| 5 | AC-3 は v3 に対して未充足 | §10 の O-7: 承認まで未充足として扱う |
| 6 | G-2・G-4 が未定義 | §11 のゲートの表 |

## 14. v4 の変更

### 14.1 要件 v4（zUSDC）への追従

§0、§2.3（`fac.toml` の token・verifier・hub・indexer）、§3（額 10,000、`redeemFeeBps()` = 10、正味 9,990、payer の資金の得方）、§4.1（定数・route 名・予算の区分）、
§4.2、§6.1（表 `SUBETHA_ZERC20_ASSETS` は zUSDC、6 桁、上限 20,000）、§7（AC-3 は要件 v4 で修正済み）、§8 の AC-7、§9、§10（O-2・O-5・O-6・O-7 は決定）。

### 14.2 v3 レビュー（2026-10-16、同じ reviewer）への対応

判定 **REJECT**。v2 の 6 件は RESOLVED 5（O-7・O-8 は明示のゲートとして可）、PARTIAL 1。

| # | 指摘 | 反映 |
|---|---|---|
| 1（high、v2 #1 の残り） | 前の実行が `mkdir` の直後に中断すると、次の実行は `~` を `fsync` しない | §6.2: 誰が作ったかに関係なく毎回、署名の前に `sign-attempts`・`~/.subetha-router`・`~` を `fsync`。AC-4 に中断後の実行と `fsync` の失敗 |
| 2（non-blocking） | log だけでは Hub RPC の呼び出しを SDK に帰属できない。daemon も起動時に Hub RPC を呼ぶ | §2.4 (c): 起動時と受け入れの間を分け、帰属はソースの呼び出し箇所と合わせたときだけ |

### 14.3 v4 レビュー（2026-10-16、同じ reviewer）

判定 **APPROVE**。v3 の high は RESOLVED、zUSDC への変更は要件・証跡と一致、新しい critical・high は無し。non-blocking 2 件（§3 の「100 回」は token の量で購入は 10 件まで、`mint` の観測は模擬 1 回）を §3 に反映した。

## 15. v5 の変更（2026-10-16、タスク T0 (d) の結果）

| 箇所 | v4 | v5 | 理由 |
|---|---|---|---|
| §2.4 の set の埋め方 | dnsmasq の `nftset=` と nftables の set | dnsmasq の `ipset=` と ipset、iptables-nft の `-m set` | AL2023 の dnsmasq 2.90 は `no-nftset`（`ipset` はあり）。ipset 7.11・iptables-nft 1.8.8 は AL2023 の repo にある |
| §2.4 の resolver の付け方 | nftables の `nat` で uid の 53 を DNAT | systemd の `BindReadOnlyPaths` で facilitator だけに別の `resolv.conf` | DNAT を使わずに済み、他の process の DNS を変えない |
| §2.4 の前提 | — | kernel の `ip_set`・`xt_set`・`xt_owner` を G-1 の最初に確かめる | container では host の kernel を確かめられない |

保証の範囲（O-8）は v4 と同じ。v4 との違い: (1) 名前の制限の**強制**は uid の loopback の DNS を `127.0.0.2:53` だけにする iptables の規則が持つ（v4 は DNAT が持っていた）。
`BindReadOnlyPaths` は既定の resolver を変えるだけ。(2) 確立済みの接続は set の timeout の後も続く（v4 の nftables の規則も `ct state established` を先に許すなら同じ）。
(3) log は新しい接続だけ。観測 (a) に直接の問い合わせの拒否を足した。

### 15.1 v5 のレビュー（2026-10-16、同じ reviewer）

判定 **APPROVE WITH CHANGES**。high 1 件（`BindReadOnlyPaths` は強制にならず、loopback の全許可で `127.0.0.53` や NSS の `resolve` を経由して許可外の名前を引ける）を反映した:
loopback は `127.0.0.2:53` だけ、`nsswitch.conf` の差し替えと `InaccessiblePaths`、観測 (a) に直接の問い合わせ。non-blocking 3 件（`bind-interfaces`・起動の順、cache が ipset を更新しない →
`cache-size=0`、確立済みの接続と NEW の log の意味・規則の位置）も反映した。

判定（修正の再レビュー）**APPROVE**。high は RESOLVED、新しい critical・high は無し。軽微な 2 件（TCP の DNS の拒否、set の期限の後の再接続）を観測 (a) に足した。
