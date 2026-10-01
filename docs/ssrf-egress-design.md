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

## 9. 改訂設計（v2）— §8 の blocking 3 件への構造的な応答

> 2026-10-01。§3〜§5 を**置き換える**。§1〜§8 は記録として残す。
> 実測 12〜24 はすべてローカル Colima VM（Ubuntu 24.04、kernel 6.8、Docker 28.3.3、
> `FirewallBackend: iptables`、`iptables v1.8.10 (nf_tables)`）で、**出荷する成果物そのもの**に対して行った。

### 9.1 何を変えたか

| §8 の blocking | 原因 | v2 での応答 |
|---|---|---|
| 2: コンテナ内 loopback は host から見えない | 手段の構造的限界 | **守る範囲を宣言する**（§9.2）。namespace を出ない宛先は A の担当。要件側に明記（`ssrf-requirements.md` §9） |
| 3: 起動時・再適用時に fail-open | `ExecStartPost` は復元の後、`-F` は空チェーンを作る | 規則を **`docker.service` の `ExecStartPre`** で入れる（復元の前、失敗なら Docker が上がらない）。再適用は **`iptables-restore` の 1 トランザクション**（§9.5） |
| 8: カウンタは「抜けていない」を証明しない | 証拠モデルの誤り | 「試行の存在」「上流で 0」「宛先側で 0」「対照は通る」を**別々の観測点**で取る（§9.6） |

加えて、規則の置き場を `DOCKER-USER` + `INPUT` から **`mangle PREROUTING` の単一チェーン**に変えた（§9.4）。
Docker が並べ替えない場所にあること、host 宛てと転送を 1 か所で見られること、DNAT 前の宛先で判定できることが理由。

### 9.2 守る範囲の宣言

B が強制できるのは **Router の network namespace を出てホストに入ったパケット**である。
次は namespace 内で完結し、**host 側の規則は構造的に見られない**（実測 10、13）:
`127.0.0.0/8`、`::1`、コンテナ自身のアドレス（`172.30.0.x` 自身）、埋め込み DNS `127.0.0.11`。

これらは**正当な依存先でもある**（`Dockerfile:61-62` の `HEALTHCHECK`、`config.ts:562` の既定 listen）。
したがって **namespace 内の宛先は A（アプリ側）の担当**とし、INV-1' の完成は **B + A** である。
B の受け入れ不変条件（要件 §8.2）は「**namespace を出る**接続試行パケットが 0 個」と読む。
この分担は `ssrf-requirements.md` §9 に要件として書いた。

### 9.3 トポロジ: Router 専用 bridge、単独

```sh
docker network create --driver bridge -o com.docker.network.bridge.name=subetha0 subetha-router-net
docker run ... --network subetha-router-net ...
```

| 理由 | 実測 |
|---|---|
| 同一 bridge 内の隣接コンテナは **`br_netfilter` が無いと L2 で届く**。規則では止められない | 16: `bridge-nf-call-iptables=1` で隣接 `exit=28`、**`=0` で `http=200`** |
| 専用 bridge に Router しかいなければ、隣接は存在しない。他 bridge へは**経路**を通り規則に当たる | 16: docker0 上の隣接へ `exit=28`、カウンタ増 |
| user-defined network では DNS が埋め込み resolver（`127.0.0.11`）経由になり、上流問い合わせは **host の namespace から出る** | 18: veth 上の DNS パケット **0**、eth0 上は `192.168.5.1 → 192.168.5.2:53`（送信元が host）。**例外規則なしで名前解決が通る** |
| 名前が固定なので規則が `-i subetha0` で一致する | 12〜24 すべて |

**展開要件**: `docker network inspect subetha-router-net` の `Containers` が **Router だけ**であること。
`docker0` と `br+` にも同じチェーンを張る（§9.4）ので、誤って別 network に付けても規則は効く。
ただし **隣接の保証はトポロジだけ**が与える。

### 9.4 規則: `mangle PREROUTING` の単一チェーン

**置き場を変えた理由**（それぞれ実測で確認）:

1. **Docker が触らない**。Docker 28.3 は `filter`/`nat`/`raw` を管理し、起動時に `FORWARD` を並べ替える。`mangle` には規則を置かない（実測: `iptables -t mangle -S` は Docker 規則 0 件）。起動順の依存が消える
2. **host 宛てと転送を同じ場所で見る**。`PREROUTING` は経路判定の前なので、`INPUT` 行きも `FORWARD` 行きも通る（実測 12: host 宛て `172.30.0.1` と転送 `192.168.5.2` が同じチェーンで落ちる）。旧 §3.2 の `INPUT` チェーンは不要
3. **DNAT の前**（`mangle` は `nat` より先）。公開ポートへの hairpin のような「変換後に内部へ向く」宛先は、**変換前の宛先（= host のアドレス）で落ちる**
4. **conntrack は使える**（conntrack の hook は `mangle` より先）。実測 13 で `--ctdir REPLY` が動いた

**規則本体**（`subetha-egress render` の出力そのまま。IPv4、resolver 例外なしの既定）:

```
*mangle
:SUBETHA-EGRESS - [0:0]
-A SUBETHA-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN
-A SUBETHA-EGRESS -d 0.0.0.0/8 -j DROP
-A SUBETHA-EGRESS -d 10.0.0.0/8 -j DROP
-A SUBETHA-EGRESS -d 100.64.0.0/10 -j DROP
-A SUBETHA-EGRESS -d 127.0.0.0/8 -j DROP
-A SUBETHA-EGRESS -d 169.254.0.0/16 -j DROP
-A SUBETHA-EGRESS -d 172.16.0.0/12 -j DROP
-A SUBETHA-EGRESS -d 192.0.0.0/24 -j DROP
-A SUBETHA-EGRESS -d 192.0.2.0/24 -j DROP
-A SUBETHA-EGRESS -d 192.88.99.0/24 -j DROP
-A SUBETHA-EGRESS -d 192.168.0.0/16 -j DROP
-A SUBETHA-EGRESS -d 198.18.0.0/15 -j DROP
-A SUBETHA-EGRESS -d 198.51.100.0/24 -j DROP
-A SUBETHA-EGRESS -d 203.0.113.0/24 -j DROP
-A SUBETHA-EGRESS -d 224.0.0.0/4 -j DROP
-A SUBETHA-EGRESS -d 240.0.0.0/4 -j DROP
-A SUBETHA-EGRESS -j RETURN
COMMIT
```

IPv6（同じ構造。bridge は既定で IPv6 無効（実測 17）だが、有効化された場合に備えて常に入れる）:

```
*mangle
:SUBETHA-EGRESS - [0:0]
-A SUBETHA-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN
-A SUBETHA-EGRESS -d ::/128 -j DROP
-A SUBETHA-EGRESS -d ::1/128 -j DROP
-A SUBETHA-EGRESS -d ::ffff:0:0/96 -j DROP
-A SUBETHA-EGRESS -d 64:ff9b::/96 -j DROP
-A SUBETHA-EGRESS -d 64:ff9b:1::/48 -j DROP
-A SUBETHA-EGRESS -d 100::/64 -j DROP
-A SUBETHA-EGRESS -d 2001:2::/48 -j DROP
-A SUBETHA-EGRESS -d 2001:db8::/32 -j DROP
-A SUBETHA-EGRESS -d 2001:10::/28 -j DROP
-A SUBETHA-EGRESS -d 2001:20::/28 -j DROP
-A SUBETHA-EGRESS -d 2002::/16 -j DROP
-A SUBETHA-EGRESS -d fc00::/7 -j DROP
-A SUBETHA-EGRESS -d fe80::/10 -j DROP
-A SUBETHA-EGRESS -d fec0::/10 -j DROP
-A SUBETHA-EGRESS -d ff00::/8 -j DROP
-A SUBETHA-EGRESS -j RETURN
COMMIT
```

| 行 | 意味 |
|---|---|
| `--ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN` | **方向で**例外にする。host → コンテナ（Caddy → Router）の**返信**だけ通す。コンテナが始めた接続は `ORIGINAL` 方向なので、規則投入前に確立していても落ちる（実測 20）。旧 §3 の `ESTABLISHED` 一括例外（§8.4 指摘 4）を置き換える |
| `-d <resolver> -p udp/tcp --dport 53 -j RETURN` | **既定では生成されない**（`RESOLVERS4` 空）。§9.3 の構成では不要（実測 18）。コンテナ namespace から上流 resolver に直接問い合わせる構成（既定 bridge、または host の resolv.conf が非 loopback）でだけ `RESOLVERS4` に **1 つ**書く。アドレスは**コンテナの中から読む**（実測 7） |
| `-d <範囲> -j DROP` ×15（v4）/ ×15（v6） | IANA special-purpose レジストリの **Globally Reachable = False 全件** + multicast + class E（255.255.255.255 を含む）。v6 は加えて site-local（`fec0::/10`）、6to4（`2002::/16`）、NAT64（`64:ff9b::/96`、`64:ff9b:1::/48`。翻訳が無いので拒否側）。**§8.4 指摘 6 の漏れ（`192.0.2/24`、`198.51.100/24`、`203.0.113/24`、`192.0.0/24`、`192.88.99/24`）を含む** |
| `EXTRA_DENY4` / `EXTRA_DENY6` | 展開固有の追加（host の公開 NAT アドレス、グローバル IP を持つ内部サービス）。「公開 IP ＝ 安全」ではない（要件 FR-A1） |
| 末尾 `-j RETURN` | それ以外は既定ポリシーへ |

**張り方**: `PREROUTING` の先頭に `-i subetha0`、`-i docker0`、`-i br+` の 3 本の jump（冪等: `-C || -I`）。
入力インタフェースで絞るので、**eth0 から来る返信**（コンテナ発の公開向け接続の戻り）は触らない。

### 9.5 ライフサイクル

**投入**: `/etc/systemd/system/docker.service.d/10-subetha-egress.conf`

```
[Service]
ExecStartPre=/usr/local/sbin/subetha-egress apply
```

| 性質 | 実測 |
|---|---|
| 規則は **dockerd がコンテナを復元する前**に入る | 22: journal で `Starting docker.service` 08:06:54.813 → `subetha-egress: applied` **.822** → dockerd `Loading containers: start` **.846**。復元後の最初の試行（08:06:56.088）は既に `exit=28`。stop → 全テーブル flush → start の全区間で **eth0 上 0 パケット、宛先側 0 到達** |
| 規則が入らなければ **Docker が上がらない**（fail-closed） | 23: 不正 CIDR → `docker.service` 失敗、`dockerd` プロセス **0**、journal に `iptables-restore: host/network 'not-an-address' not found`。未知キー → 同様に失敗、`unknown key 'TYPO_KEY'`。env を戻せば復帰 |
| **別 unit + `Requires=` は採らない** | 21: `Requires=` は stop/restart を**伝播**する。`systemctl restart subetha-egress` が **Docker を再起動**し（10.1 秒）、その間コンテナは SIGTERM を無視して動き続けた。規則の再適用が Docker 再起動になるのは運用上の罠 |

**再適用**: `sudo subetha-egress apply`（**24 ms**、実測 24）。
`iptables-restore --noflush` に `:SUBETHA-EGRESS - [0:0]` と全規則を渡すので、**flush と再構築が 1 コミット**になる。
実測 14: `strace` で netlink `sendmsg` は **1 回**（`NFNL_MSG_BATCH_BEGIN`〜`END` の 1 バッチ）。
300 本の並行 SYN を当てながら 30 回再適用（691 ms）して**宛先側の到達 0**。
`-F` → `-A` の旧手順（§8.2 の 2 つ目の窓）は無くなった。

**設定ファイル** `/etc/subetha-egress.env`: `KEY=value`（値に空白があれば二重引用符）。
**シェルとして source しない**（実測 19 で発見: `IFACES=subetha0 br+` を source すると `br+` がコマンドとして実行され、
`br+` が張られないまま unit は成功した）。許可キー以外は**拒否**（fail-closed に倒す）。

**削除**: `subetha-egress remove`（保守用。Router 稼働中には使わない）。

### 9.6 検証プロトコル（§5 を置き換える）

**証拠モデル**: 「0 個」は次の 4 つを**同時に**満たして初めて主張する。
1. **試行が存在した** — コンテナの veth で捕捉（規則より手前の観測点）。**bridge デバイス上では見えない**（実測 15: `br_netfilter` は bridge **ポート**で PREROUTING を走らせるので、落ちたパケットは `subetha0` デバイスに届かない）
2. **上流に出ていない** — uplink（eth0 / ens5）で禁止宛先への捕捉 **0**。ただし**正の対照**（host 自身の同じ宛先への接続が**捕捉される**）を同じフィルタで取る
3. **宛先に届いていない** — 宛先側の受信ログ **0**（host 上の listener は常に使える。VPC 内の別 host があればそこにも）
4. **対照は通る** — 公開 HTTPS、Caddy → Router、名前解決

| ID | 検証 | 期待と証拠 |
|---|---|---|
| V2-1 | **行列**: 禁止範囲 15 件 × TCP、代表 5 件 × UDP/ICMP を **Router の netns から**（`docker run --network container:subetha-router`） | TCP `exit=28`、veth で各宛先に試行あり、uplink 0（正の対照あり）、各 DROP 行のカウンタ増 |
| V2-2 | 隣接: 同 bridge の別コンテナ、docker0 のコンテナ | `exit=28`。**`subetha-router-net` の Containers が Router だけ**であること |
| V2-3 | host 宛て: bridge gateway の listener | `exit=28`、listener 受信 0 |
| V2-4 | Caddy → Router | `https://router.subethalabs.com/healthz` 200、REPLY 例外行のカウンタ増 |
| V2-5 | DNS 経路の判別: 名前解決中に Router の veth で `port 53` を捕捉 | **0 パケットかつ解決成功** → 例外不要（既定）。**パケットあり** → その宛先を `RESOLVERS4` に書いて再適用し、再検証 |
| V2-6 | 公開上流: Alchemy / Tempo RPC / Provider | quote が通る |
| V2-7 | 起動窓: `--restart unless-stopped` の probe を置き、uplink 捕捉を回したまま **host を再起動** | journal で `applied` が `Loading containers` より前、probe の復元後最初の試行が失敗、uplink 0、宛先 0 |
| V2-8 | fail-closed: env に不正値 → `systemctl restart docker` | 失敗する。戻して復帰 |
| V2-9 | 既存接続: 規則を外して接続を確立 → `apply` | 以後のパケットが落ちる（conntrack は `ESTABLISHED` のまま） |
| V2-10 | 再適用の原子性 | `strace -e sendmsg iptables-restore --noflush` が 1 バッチ。再適用中の並行 SYN が宛先に届かない |
| V2-11 | IPv6 | コンテナにグローバル v6 経路なし、`ip6tables` チェーン張り済み |
| V2-12 | loopback（**B の対象外であることの確認**） | `127.0.0.1` への接続が**規則に当たらず**即時に `refused`/成功する → A の検証項目へ |

V2-7 と V2-8 は本番 host で行うため、`DEPLOY.md` に probe コンテナの作り方を書く
（**PID 1 の `sh` は SIGTERM を無視する**ので `docker stop` に 10 秒かかる。想定内）。

### 9.7 実測 12〜24

| # | 実測 | 結果 |
|---|---|---|
| 12 | 稼働中に `apply`。probe は 0.2 秒毎に Mac（`192.168.5.2`、RFC1918・転送）/ host（`172.30.0.1`）/ 公開 `1.1.1.1` | 投入秒の到達を最後に両宛先とも **以後 0**。次の試行から `exit=28`。公開は `301` のまま |
| 13 | host → コンテナ（`-p 127.0.0.1:18787`）、コンテナ内 loopback / 自 IP、コンテナ → host NEW | **200** / **200・200**（namespace 内、規則に当たらない）/ **blocked**。REPLY 例外行 0 → 6 pkts |
| 14 | `strace` 付き `iptables-restore --noflush`。300 並行 SYN 中に 30 回 `apply` | `sendmsg` **1 回** = 1 バッチ。691 ms。宛先到達 **0**。hammer の実在: 100 SYN でカウンタ +100 |
| 15 | 16 宛先 × TCP、5 宛先 × UDP/ICMP。eth0 と veth と bridge デバイスで捕捉 | 転送 14 件 `exit=28`、`127.1.2.3` **0.1 ms で refused**（namespace 内）、`224.0.0.1` TCP はカーネルが拒否。eth0 **0**（正の対照 1 SYN は捕捉）。veth で全宛先に試行。bridge デバイス **0**（観測点の問題） |
| 16 | 同 bridge 隣接 / docker0 隣接 / `bridge-nf-call-iptables=0` | `28` / `28` / **`200`** |
| 17 | IPv6 | グローバル v6 なし、`curl -6` `exit=6`。`ip6tables` 17 規則 |
| 18 | DNS（user-defined network、例外なし） | resolv.conf `127.0.0.11`。veth 上 DNS **0**。eth0 上 `192.168.5.1 → 192.168.5.2:53`。解決成功 |
| 19 | `br-*` network のコンテナ | Mac `exit=28`、公開 `200`。env を source した版は `br+` が張られず（修正済み） |
| 20 | 既存ストリーム（1 秒毎 tick）を張ってから `apply` | tick 4 まで到達、`apply` 12 ms、**以後 0**。conntrack は `ESTABLISHED [ASSURED]` のまま |
| 21 | 別 unit + `Requires=` で `systemctl restart subetha-egress` | **10.1 秒**（Docker が再起動）。採用しない |
| 22 | `ExecStartPre` で stop → flush → start | §9.5 の通り。tempo-mpp-e2e は healthy のまま |
| 23 | fail-closed ×2 | §9.5 の通り |
| 24 | `apply` 単体の時間、remove → `apply` 直後の新規接続 | **24 ms**。直前の試行まで `200`、直後から `28` |

### 9.8 §8 の指摘との対応

| # | 対応 |
|---|---|
| 1 topology | §9.3 の展開要件 + `docker0`/`br+` にも張る（実測 19） |
| 2 loopback | §9.2、要件 §9（A の担当） |
| 3 startup / `-F` | §9.5（実測 22、14） |
| 4 ESTABLISHED | `--ctdir REPLY`（実測 20） |
| 5 port 53 | 既定で例外なし（実測 18）。必要時も resolver アドレスに束縛 |
| 6 address list | IANA 全件（§9.4） |
| 7 Caddy reply | §9.4 の例外行の説明 |
| 8 verification | §9.6 の 4 条件 |
| 9 ICMP | 「区別できない」の主張を削除。DROP は「返信パケットを生まない」ことで選ぶ |
| 10 backend 主張 | §9 冒頭に「ローカルで実測した構成」と明記 |

### 9.9 未解決・残余

- **U-1'** 本番 backend。hook は Docker のチェーンに依存しないので nftables backend でも**規則自体は効くはず**だが、Docker の nft テーブルとの共存は**未実測**。`iptables` コマンド（nft 版で可）は必要
- **U-2'** 本番の DNS 経路。AL2023 が systemd-resolved なら実測 18 と同じ（例外不要）。**V2-5 で判別する**
- **U-3** VPC 内に Router が正当に到達すべき private アドレスがあるか（旧 §7 と同じ）
- host の **公開 NAT アドレス**: コンテナ → 公開 IP → IGW → host に戻る経路は規則の外。SG が守る。必要なら `EXTRA_DENY4`
- `docker.service` は `Restart=always` なので、fail-closed 時は 2 秒間隔で再試行し `StartLimitBurst` で止まる。想定内

### 9.10 実装フェーズの成果物

`deploy/egress/subetha-egress`（本節で実測したスクリプト）、`deploy/egress/10-subetha-egress.conf`、
`deploy/egress/subetha-egress-verify`（V2-1〜V2-12 を host 上で実行して証拠を出す）、
`DEPLOY.md` の変更（network 作成、`--network`、env、drop-in、検証手順、probe の作り方）。
