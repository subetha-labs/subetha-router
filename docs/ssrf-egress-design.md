# 設計: SSRF 防御 B（インフラ側 egress 制御）

> 2026-10-01。要件は `ssrf-requirements.md` §8（限定レビューで承認）。
> 実現手段 B（インフラ側）を採る。**Router のコードは変更しない。**
> 成果物は `DEPLOY.md` の手順と、§8.2 の受け入れ不変条件を満たす**検証手順**。

## 1. 実測に基づく前提（ローカル Docker 28.3.3 / iptables backend / Ubuntu 24.04）

設計を文書の引用ではなく実測に置く。本番と同じ backend（`Firewall Backend: iptables`）で確認した。

| # | 実測 | 結果 | 設計への含意 |
|---|---|---|---|
| 1 | `DOCKER-USER` に DROP を置き、コンテナから**転送される**宛先へ接続 | カウンタ **0 → 3〜4 pkts**（SYN 再送） | **`DOCKER-USER` は転送トラフィックを確実に止める** |
| 2 | 同じ DROP を **host 自身**（`172.17.0.1`）宛てに置く | 「Connection refused」、**カウンタ 0** | **host 宛ては `FORWARD` を通らない**。`INPUT` で別に止める必要がある |
| 3 | 経路の無い宛先（`10.255.255.1`）へ接続 | 即時失敗、**規則に到達しない** | 経路が無い宛先はカーネルが落とす。**規則の試験には転送される宛先を使う** |
| 4 | DROP / REJECT(icmp-admin-prohibited) / 規則なし を `curl` で計時 | DROP **4s timeout** / REJECT **4s timeout** / なし **0.0006s refused** | **コンテナ内から DROP と REJECT は区別できない**。ICMP が戻らない。→ FR-C1' を実証: Router は遮断を報告できず、**証拠はカウンタだけ** |
| 5 | bridge の IPv6 | `EnableIPv6: false` | 既定では IPv6 egress が無い。**有効化したら ip6tables 側も同じ規則が要る** |
| 9 | `systemctl restart docker` 前後で `DOCKER-USER` 内のユーザ規則 | **残った**（count 1 → 1、チェーンも存続） | §3.4 の根拠を訂正: 消えるのは **host 再起動**。`ExecStartPost` は daemon 再起動のためではなく、reboot 後に `DOCKER-USER` 生成**後**に入れ直すため。**V-7 は reboot で行う** |
| 7 | 実測 6 の修正（resolver 例外）を **host の `/etc/resolv.conf`** から取って適用 | **まだ `exit=6`**。host の値は `127.0.0.53`（systemd-resolved stub）、コンテナの値は `192.168.5.2` | **resolver はコンテナの中から読む**。host の stub はコンテナから到達不能で、Docker がその理由でコンテナ側を書き換えている |
| 8 | コンテナ側 resolver で例外を張って再検証 | 公開 HTTPS **`exit=0` 0.07s**、禁止宛先 **`exit=28`**。UDP 53 RETURN **2 pkts**、`192.168/16` DROP **4 pkts** | **修正版は正しく動く**。例外と DROP が port で正しく分岐している証拠がカウンタに出る |
| 6 | **§3.1 の規則をそのまま適用**し、公開 HTTPS へ接続 | **`curl exit=6`（名前解決失敗）**。`192.168.0.0/16` の DROP が **4 pkts** | **deny 一覧が resolver（`192.168.5.2`）を落とし、DNS が死んだ**。EC2 でも resolver は `169.254.169.253` か `10.x` で**同じく deny 範囲内**。→ DNS 例外を DROP より前に置く（§3.1 に追加）。コンテナ間（172.17.x）は生きていた |

実測 4 は要件 §8.4 の「drop はタイムアウトに見える」を**裏付けた**。
REJECT にしても改善しないので、**DROP で統一**する（REJECT は余計な ICMP を生むだけ）。

## 2. 方針: 禁止リスト（deny）であって許可リストではない

| 方式 | 内容 | 判断 |
|---|---|---|
| **deny（採用）** | 内部・特殊用途の宛先だけを落とし、それ以外は通す | INV-1 が求めるのはこれ。新しい Provider を足しても規則を触らない |
| allow（不採用・将来） | Alchemy / Tempo RPC / 各 Provider だけを許す | 強いが、**Provider を足すたびに規則が要る**。Provider の IP は CDN で変動する |

deny を採る根拠: 脅威は「内部に到達される」ことであり、「外部のどこへ行くか」ではない（要件 §7.1 の訂正「未認可の到達が違反」）。
**allow は将来の強化として記録**し、今は採らない。

## 3. 規則（iptables backend）

### 3.1 転送トラフィック（`DOCKER-USER`）

```sh
# 冪等: 自前チェーンを作り DOCKER-USER から 1 回だけ呼ぶ
sudo iptables -N SUBETHA-EGRESS 2>/dev/null || sudo iptables -F SUBETHA-EGRESS
sudo iptables -C DOCKER-USER -j SUBETHA-EGRESS 2>/dev/null || sudo iptables -I DOCKER-USER 1 -j SUBETHA-EGRESS

# 対象はコンテナ発の転送（docker0 から出るもの）に限る。戻りパケットは通す
sudo iptables -A SUBETHA-EGRESS ! -i docker0 -j RETURN
sudo iptables -A SUBETHA-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

# **DNS の例外を DROP より前に置く**（INV-1 の唯一の例外）。実測 6: これが無いと名前解決が死ぬ。
# RESOLVER は展開先の resolver（EC2 なら VPC の 169.254.169.253 か VPC DNS の 10.x。
# どちらも下の deny 範囲に入る）。承認済みリゾルバ **1 つだけ**を許し、53 番の他宛ては落とす
# **host の /etc/resolv.conf を読んではならない**（実測 7）。systemd-resolved 環境では stub の
# 127.0.0.53 が入っており、コンテナからは到達不能。Docker はそのためにコンテナ側の resolv.conf を
# 書き換えている。**コンテナの中から読む**のが唯一正しい出所
RESOLVER="$(sudo docker run --rm alpine:latest awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)"
sudo iptables -A SUBETHA-EGRESS -d "$RESOLVER" -p udp --dport 53 -j RETURN
sudo iptables -A SUBETHA-EGRESS -d "$RESOLVER" -p tcp --dport 53 -j RETURN

# 禁止宛先（要件 FR-A1 の IPv4 部分。未掲載の special-purpose は既定で拒否 = ここに足す）
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
           172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 \
           224.0.0.0/4 240.0.0.0/4; do
  sudo iptables -A SUBETHA-EGRESS -d "$net" -j DROP
done
sudo iptables -A SUBETHA-EGRESS -j RETURN
```

**`169.254.0.0/16` に IMDS（`169.254.169.254`）が含まれる。** 段階 0 がトークン取得を止め、
この規則が**到達そのもの**を止める。二重になるが、守る層が違う（段階 0 は IMDS 固有、これは経路）。

### 3.2 host 宛て（`INPUT`）— 実測 2 で必要と確定

```sh
# コンテナからホスト自身への到達を止める（docker0 から INPUT に入るもの）
# ただし DNS（ホストの resolver を使う場合）は通す — INV-1 の唯一の例外
sudo iptables -N SUBETHA-FROM-CONTAINER 2>/dev/null || sudo iptables -F SUBETHA-FROM-CONTAINER
sudo iptables -C INPUT -i docker0 -j SUBETHA-FROM-CONTAINER 2>/dev/null || \
  sudo iptables -I INPUT 1 -i docker0 -j SUBETHA-FROM-CONTAINER
sudo iptables -A SUBETHA-FROM-CONTAINER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
sudo iptables -A SUBETHA-FROM-CONTAINER -p udp --dport 53 -j RETURN   # 承認済みリゾルバ（ホスト）への DNS
sudo iptables -A SUBETHA-FROM-CONTAINER -p tcp --dport 53 -j RETURN
sudo iptables -A SUBETHA-FROM-CONTAINER -j DROP
```

**注意**: Caddy はホスト上で動き、`127.0.0.1:8787` の Router へは**ホスト → コンテナ**方向（`-p 127.0.0.1:8787:8787`）。
この規則は**コンテナ → ホスト**方向だけを止めるので、Caddy からの到達は影響を受けない。
**実測で確認する項目**（§5）。

### 3.3 IPv6

bridge の IPv6 は既定で無効（実測 5）。**有効にする場合のみ**、`ip6tables` に同じ構造で
`::1/128`、`fc00::/7`、`fe80::/10`、`::ffff:0:0/96`、`64:ff9b::/96`、`ff00::/8` を置く。
手順書には「IPv6 を有効化したら必須」と明記し、既定では入れない。

### 3.4 永続化

**実測 9**: `systemctl restart docker` では `DOCKER-USER` 内のユーザ規則は**消えない**
（restart 前後で `-j SUBETHA-PROBE` が残り、チェーンも残った）。Docker は自分のチェーンは作り直すが
`DOCKER-USER` の中身には触らない。
→ 規則が消えるのは **host の再起動**（netfilter はカーネルメモリ上）であって daemon 再起動ではない。

したがって永続化の要件は「**host 再起動後、Docker が `DOCKER-USER` を作った後に**規則を入れ直す」。
`docker.service` の **`ExecStartPost`** で上記スクリプトを呼ぶ drop-in が、この順序を満たす
（`DOCKER-USER` は Docker 起動時に作られるので、その後に `-I DOCKER-USER 1` できる）。
スクリプトは**冪等**（§3.1 の `-N || -F`、`-C || -I`）なので daemon 再起動で二重に入ることはない。
`iptables-persistent` は Docker 起動**前**に復元して順序が崩れるので**使わない**。

**V-7（再起動後の再検証）は daemon restart ではなく `sudo reboot` で行う**こと。

## 4. nftables backend の場合

**`DOCKER-USER` は存在しない**（要件 §8.2）。本番が nftables なら、
`inet` テーブルに `forward` hook（priority を Docker より前）で同等の deny を置く。
**本設計は iptables backend を実測した**。nftables は未実測なので、
手順書には「backend を先に確認し、nftables なら本節は適用できない。別途設計する」と書く。

確認コマンド: `docker info --format '{{.FirewallBackend}}'`（28.x）。

## 5. 検証手順（要件 §8.2 の受け入れ不変条件）

「`curl` が失敗した」では証拠にならない（実測 4: DROP も到達不能も同じに見える）。
**証拠はカウンタ**。各項目で「接続試行 → 対応する DROP 規則の pkts が増えた」を確認する。

| ID | 検証 | 期待 | 証拠 |
|---|---|---|---|
| V-1 | コンテナから `169.254.169.254` へ | 失敗 | `SUBETHA-EGRESS` の `169.254.0.0/16` 行の pkts **増加** |
| V-2 | コンテナから `10.0.0.1`（VPC 内の別ホスト等、**転送される**宛先）へ | 失敗 | 対応行の pkts 増加 |
| V-3 | コンテナからホスト `172.17.0.1:<任意>` へ | 失敗 | `SUBETHA-FROM-CONTAINER` の DROP の pkts 増加 |
| V-4 | コンテナから**承認済み resolver**の 53 へ（`/etc/resolv.conf` の値。host か VPC DNS か展開次第） | **成功** | `SUBETHA-EGRESS` の `dport 53` RETURN 行の pkts 増加 |
| V-4b | コンテナから**承認外**の DNS（例 `8.8.8.8:53`、deny 範囲外の公開 resolver） | **成功**（deny 範囲外なので通る） | — 。これは INV-1 の対象外。**resolver を 1 つに絞る目的は「deny 範囲内の宛先を 53 番で抜ける」穴を塞ぐこと**であり、公開 resolver への DNS を止めることではない |
| V-5 | コンテナから Alchemy / Tempo RPC / Provider へ | **成功** | Router の `healthz` と quote が通る |
| V-6 | Caddy → Router（`127.0.0.1:8787`） | **成功** | `curl https://router.subethalabs.com/healthz` |
| V-7 | **再起動後**に V-1〜V-6 を再実行 | 同じ | 永続化の証明 |
| V-8 | DNS rebinding の模擬: 公開名を内部 IP に解決させて接続 | 失敗 | 宛先 IP の行の pkts 増加（**名前でなくアドレスで落ちる**ことの証明） |

V-8 が B の存在理由（rebinding を名前解決と無関係に止める）。
V-5 と V-6 が「止めすぎていない」ことの証明で、**V-1〜V-3 と同じ重みで必須**。

## 6. やらないこと

- Router のコード変更（A は別設計）
- allow リスト（§2）
- nftables の実装（§4。未実測のまま手順を書かない）
- `destination_blocked` の報告（実測 4 により不可能。`transport_failed` のまま）
- 本番への適用（**手順書の作成まで**。適用は owner が実行する。このマシンに AWS 認証情報は無い）

## 7. 未解決

- **U-1** 本番の backend。`docker info` で確認するまで §3 か §4 かが決まらない
- **U-2** 本番の resolver アドレス。ローカルでは gateway（`192.168.5.2`）だった。EC2 では VPC DNS（`169.254.169.253` または VPC CIDR の `.2`）が既定で、**いずれも deny 範囲内**。§3.1 の `RESOLVER` はこれを `/etc/resolv.conf` から取る。**host が resolver でなければ §3.2 の DNS 例外は不要**（残しても無害）
- **U-3** VPC 内に Router が正当に到達すべき private アドレスがあるか（例: 同一 VPC の RPC ノード）。あれば `10.0.0.0/8` 一括 DROP が壊す。**展開固有のポリシー**として owner 確認

## 8. 設計レビュー: **REJECT** — B 単独では §8.2 を満たせないことが確定

レビュー実施: 2026-10-01、`gpt-6-astra`、対象 `71411e6`（私の修正 3 件より前の版）。
blocking 3 件。**うち 1 件は規則の誤りではなく、B という手段の構造的な限界**だった。
blocking はすべて自分で実測して確認した。

### 8.1 blocking 2: **コンテナ内 loopback を host の chain は一切見られない**（実測 10）

`127.0.0.0/8` の DROP を **`FORWARD`（`DOCKER-USER`）と `INPUT` の両方**に置いた状態で、
コンテナが自分の `127.0.0.1:9999` へ接続 → **`ok`**。host 側 chain のカウンタは**一切動かず**。

→ `127.0.0.1` / `::1` / コンテナ自身の IP 宛ては **namespace 内で完結し、host は無力**。
これは規則の書き方では直らない。**host 側の制御（= B）は、定義上この宛先を守れない。**

しかも loopback は**正当な依存先**である（`Dockerfile:61-62` の `HEALTHCHECK` が
`127.0.0.1:8787/healthz` を叩く。Router の既定 listen も `127.0.0.1`、`config.ts:562`）。
「コンテナ内 loopback を全部塞ぐ」は health check を殺す。

**含意**: §8.2 の不変条件「禁止宛先に接続試行パケットが 0 個」を**コンテナ内 loopback について**
満たせる手段は、**アプリ側（A）だけ**である。または**要件を改訂して loopback を INV-1 の対象から外す**。

### 8.2 blocking 3: 起動時と規則入れ替え時が fail-open（実測 11）

`--restart unless-stopped` のコンテナは **daemon init 中に復元**される。実測: `systemctl restart docker` は
active になるまで **10.6 秒**、その間にコンテナは既に動いていた。`ExecStartPost` はその**後**。
→ reboot 後、Router は**規則が入る前に egress できる窓**を持つ。

加えて再適用の `-F SUBETHA-EGRESS` は、参照中の chain を空にしてから積み直す。**空の user chain は即 RETURN**
なので、積み直し中も窓が開く。

**対処の方向**（設計で選ぶ）: (a) 規則を **Docker 起動前**に、`DOCKER-USER` に依存しない形で入れる
（`FORWARD` に直接、または独自 chain を `FORWARD` 先頭に置き Docker 起動後に `DOCKER-USER` へも張る）、
(b) 入れ替えは**新 chain を作って jump を差し替え**、旧 chain を後で消す（トランザクション的）、
(c) 規則が入るまで Router コンテナを起動させない（`docker.service` の `After=` ではなく、
Router の unit を別に切り `Requires=` で規則 unit に依存させる）。

### 8.3 blocking 8: V-1〜V-8 は「0 個」を証明しない

DROP カウンタの増加は「落ちた packet がある」の証明であって「抜けた packet が無い」の証明ではない。
欠けている対象: コンテナ内 loopback（§8.1 で host では不可能）、隣接コンテナ、host の他アドレス、
DNAT 後の宛先、proxy 迂回、既存接続、起動/再適用の窓、UDP/ICMP。
V-8 は rebinding ではなく**静的な private 解決**の試験だった。

### 8.4 その他の指摘（反映する）

| # | 指摘 | 対応 |
|---|---|---|
| 1 | `docker0` は既定だが設定可能。user-defined bridge（`br-…`）は両 chain を迂回 | 「Router は既定 bridge にのみ接続」を**展開要件**にし、`docker inspect` で検証する |
| 4 | `ESTABLISHED` は「戻りトラフィック」と同義ではない。規則投入前に確立した禁止接続は以後通る | 投入時に既存接続を `conntrack -D` で落とす手順を加える。Caddy の返信経路は `ESTABLISHED` に依存するので**一括で前に出さない** |
| 5 | INPUT の 53 例外が host の**全アドレス**に効く。port 一致は DNS の証明にならない | resolver アドレスに束縛（§3.1 と同様）。V-4 は「DNS 応答が返る」ことで判定 |
| 6 | 未掲載の宛先は RETURN（= 通る）。`192.0.2/24`・`198.51.100/24`・`203.0.113/24` 等が漏れ、「既定 deny」を実装していない | IANA special-purpose を**全列挙**して DROP。既定 deny を文字通り実装 |
| 7 | Caddy の説明が返信経路を無視 | 「コンテナの返信は `docker0` から `INPUT` に入り `ESTABLISHED` で通る」と書き直す |
| 9 | REJECT が timeout に見えた説明は未証明。Linux は ICMP admin-prohibited を接続エラーとして**報告し得る** | 「区別できない」を**一般論として主張しない**。DROP 採用と `transport_failed` は維持（それに依存しない） |
| 10 | 「本番と同 backend」は U-1 未解決と矛盾 | 「ローカルで実測した構成」とだけ書く |

### 8.5 自分で先に直していた点（レビューと一致）

- 指摘 3 の「daemon restart は `DOCKER-USER` を保持」→ 実測 9 で発見済み
- 指摘 5 の resolver（host の stub ではなくコンテナ側）→ 実測 6〜8 で発見済み

### 8.6 **結論: 判断を owner に戻す**

B は「規則を直せば通る」段階ではない。**§8.1 により B 単独では要件を満たせない**。選択肢:

| 選択 | 内容 | 代価 |
|---|---|---|
| **B + 要件改訂** | コンテナ内 loopback を INV-1 の対象から**明示的に外す**。host 側 egress のみ守る | loopback 宛て SSRF（Router 自身の 8787、同梱プロセス）は**守らない**と宣言する |
| **B + A（併用）** | host 側で転送を止め、**アプリ側で loopback 宛てを fetch 前に拒否** | A の実装（10 経路）が結局必要。ただし A は loopback と transport 固定に絞れる |
| **A のみ** | アプリ側で全部 | B の利点（アプリのバグまで守る）を失う |

**私の推奨は「B + A（併用）」**。理由: 守る対象が物理的に分かれている
（転送 = host が強い、loopback = アプリしか見えない）ので、**どちらか一方では構造的に足りない**。
A を「loopback 拒否 + 接続固定」に絞れば、全 10 経路に入れる負担は小さくない が、
**手段ごとに守る範囲を明示できる**。

**blocking 3 は選択に依らず直す**（§8.2 の (a)〜(c)）。
