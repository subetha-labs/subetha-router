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

## 10. 設計レビュー #2（v2、`aeaf925`）: **REJECT** → v3 で応答

レビュー実施: 2026-10-01、`gpt-6-astra`。blocking 5 件、non-blocking 3 件。
「v2 は大きく改善したが、改訂後の B 不変条件をまだ確立していない」。各指摘と応答:

| # | 指摘（要約） | 判定 | v3 での応答 | 実測 |
|---|---|---|---|---|
| 1 | DNAT 前の判定は「host の全アドレスが拒否されている」前提に立つ。グローバルな host アドレス・公開 NAT アドレスは通り、変換後の宛先は再判定されない | **正しい** | **host アドレス目録を必須**にした（インタフェースのアドレスを apply 時に自動収集 + `HOST_ADDRS4` を必須キーに。公開 NAT アドレスはインタフェースに無いので operator が書く）。同じチェーンを **`FORWARD` と `INPUT` にも張り、変換後の宛先を再判定** | 26（目録無しでは host の別名アドレスに**届く**、目録で止まる）、27c（operator 追加の DNAT 後の宛先を `FORWARD` で落とす）、27b（Docker 28.3 は bridge 発パケットを DNAT しない。hairpin は **userland proxy 経由の host 宛て**になり、目録で止まる） |
| 2 | IPv6 一覧が現行レジストリに対して不完全（`100:0:0:1::/64`、`2001::/23`、`3fff::/20`、`5f00::/16`）。「未掲載は拒否」は静的一覧では実装できない | **正しい** | レジストリ（**2025-10-09 更新版**）を取得し直し、v4/v6 とも**日付付きの分類表**（§11.4）にした。保守的除外を明示。「未掲載は拒否」は**スナップショット日付 + 見直し規則**として実装する（実行時の性質ではない）。v4-mapped は socket 上の表現で、パケットは IPv4 として v4 規則で分類される、と明記 | — |
| 3 | 「user-defined network なら DNS は host namespace から出る」は一般化しすぎ。port 53 例外は**その宛先への HTTP も通す**。観測した宛先を「承認」にしてはならない | **正しい** | **DNS 例外を規則から削除**。要件: 埋め込み resolver の上流が **host の loopback resolver**（systemd-resolved stub）であること。その時だけ host namespace から出る。上流が非 loopback だとコンテナ namespace から出る——**両方を実測**。検証は**未キャッシュの実在名**で行い、resolver アドレスの 53 番への HTTP が落ちることも確認 | 25（daemon の `dns` を非 loopback にすると veth 上に DNS が出て落ちる）、31 |
| 4 | 検証に盲点と自己矛盾（V2-1 の期待が loopback/multicast と矛盾、V2-2 の隣接と「Router のみ」、V2-3 の app ログ、V2-7 の再起動と捕捉、V2-11、rebinding/proxy/変換後/host 全アドレス未試験、uplink 捕捉は host 宛てを見ない） | **正しい** | 検証を**宛先ごとの期待クラス**（firewall-dropped / kernel-rejected / namespace-local(= A) / allowed-control）で定義し直し、観測点を経路ごとに指定（§11.6）。host 宛ては veth の SYN/SYN-ACK + conntrack 不在 + listener で見る。再起動は **boot 時に docker より前に起動する捕捉 unit** と独立の受信側で見る。隣接試験は一時的な敵対構成として最終トポロジ assertion と分離。rebinding は B では**構成上対象外**（アドレスで判定するので DNS 応答は無関係）と明記し、試験は主張しない | 32、34、29 |
| 5 | fail-closed の前提が未記述: live-restore ならコンテナは daemon 停止を生き延びる。v4/v6/jump をまたぐ原子性、後からの flush、初回導入順、AL2023 の対応表 | **正しい** | `LiveRestoreEnabled=false` を**前提条件**にし検証項目に入れた。原子性は「family ごとの 1 コミット + 永続する jump」と正確に書いた。**guard timer（30 秒）**で外部 flush を自己修復（窓は閉じず**上限 30 秒**、保守中の flush は手順で禁止）。初回導入と移行の順序を書いた。AL2023 は**未実測**で、検証 runner の実行が受け入れ | 28、22、34 |
| 6 | A/B 分担は正当。ただし release gate を明示し、「namespace を出るパケットが 0」は「禁止宛先に**届く**パケットが 0」と直す | 正しい | 要件 §9 を書き直した | — |
| 7 | hook と REPLY 例外は妥当だが説明が過大。`--ctdir REPLY` は Caddy だけでなく**全ての返信方向**を通す。Docker の raw DROP が先に効く場合がある。`docker0`/`br+` は任意名の bridge を守らない | 正しい | 記述を直し、試験時に raw/nat/mangle の Docker 規則を記録。Router の **attachment set の assertion**（network は `subetha-router-net` のみ、`NetworkMode` が host/container でない）を検証に追加 | 27b（Docker の raw/nat 規則を記録） |
| 8 | parser/unit/計測の主張は狭く書く。スクリプト本体がコミットに無く検査できない | 正しい | parser の契約（§11.5）。スクリプトと unit は**実装フェーズで `deploy/egress/` に入れる**（本設計の実測はそのスクリプトで行った）。AL2023 での再実行を受け入れ条件に | — |

数の訂正: レビューは v2 の v6 DROP 行を 16 と数えたが v2 は 15 行だった。**v3 は 16 行**（レジストリ準拠）。

## 11. 設計 v3（現行。§9 の規則・ライフサイクル・検証を置き換える）

> 実測 25〜34 は §9 と同じローカル VM。v2 の実測 12〜24 のうち v3 でも成り立つもの
> （Caddy 経路 13、原子性 14、行列 15、隣接 16、br+ 19、既存接続 20、`apply` 24）はそのまま根拠にする。

### 11.1 v2 からの変更

| 変更 | 理由（§10） |
|---|---|
| host アドレス目録（自動 + `HOST_ADDRS4` 必須） | 1 |
| 同じチェーンを `PREROUTING` + `FORWARD` + `INPUT` に張る（変換後の再判定） | 1 |
| DNS 例外を削除。上流 resolver が host loopback であることを要件に | 3 |
| IANA 2025-10-09 版の分類表、v6 16 件 | 2 |
| guard timer、live-restore 前提、導入順、firewalld 不在 | 5 |
| 検証プロトコルを期待クラスと観測点で再定義、boot 時捕捉 unit | 4 |
| env parser の契約（必須キー、重複・未知キー拒否、CIDR 検査） | 8 |

### 11.2 守る範囲（§9.2 の言い直し）

B は **namespace を出た後**のパケットを見る。B の不変条件は
「**禁止宛先に届く**（host の socket 層に受理される、または上流へ出る）接続試行パケットが 0」。
namespace 内の宛先（`127.0.0.0/8`、`::1`、自アドレス、`127.0.0.11`）は A の担当（要件 §9）。

### 11.3 トポロジと DNS

- Router は専用 user-defined bridge `subetha0`（`subetha-router-net`）に**単独**で置く（実測 16: `br_netfilter` 無しでは同 bridge 隣接は規則で止まらない。**reboot 後は `br_netfilter` が無い**ことも実測 34 で確認——モジュールは持続しない。隣接の保証はトポロジのみ）
- **DNS 条件**: Docker の埋め込み resolver の上流が **host の loopback resolver**（systemd-resolved stub `127.0.0.53`）であること。このとき上流問い合わせは **host の namespace から**出る（実測 18、31: veth 上の DNS 0、eth0 上の送信元は host）。上流が非 loopback（daemon の `dns` や host の `/etc/resolv.conf` が直接 VPC DNS を指す）だと**コンテナ namespace から**出て規則に落ちる（実測 25: veth 上 6 パケット、解決失敗）。**その場合の正しい対処は loopback resolver の導入であって port 53 の例外ではない**（AL2023 は systemd-resolved が既定）
- 規則に **DNS 例外は無い**。resolver アドレスの 53 番への HTTP も落ちる（実測 31: `exit=28`）

### 11.4 規則

**hook**: `mangle` の `PREROUTING`（DNAT 前の宛先）、`FORWARD`、`INPUT`（DNAT 後の宛先）に、
`-i subetha0` / `-i docker0` / `-i br+` で同じチェーンへ jump（計 9 本、v4/v6 それぞれ）。

**Docker 28.3 との関係**（実測 27b で記録）: Docker は `raw PREROUTING` に公開ポート保護の DROP を置く
（ours より先に効くことがある。試験では**自チェーンのカウンタ**で帰属を示す）。`nat DOCKER` チェーンは
**bridge 発のパケットを先頭で RETURN** する（`-A DOCKER -i docker0 -j RETURN`、`-i subetha0 -j RETURN`）ので、
コンテナから公開ポートへの hairpin は DNAT されず **userland proxy（host のプロセス）への host 宛て接続**になる。
よって hairpin の防御は **host アドレス目録**（実測 26、27b）。`FORWARD` の再判定が効くのは
operator が加えた DNAT のような非 Docker の変換（実測 27c）。

**チェーン**（v4。`render` の出力。host 目録は展開で変わるので省いた形）:

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

v6（16 件）:

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
-A SUBETHA-EGRESS -d 100:0:0:1::/64 -j DROP
-A SUBETHA-EGRESS -d 2001::/23 -j DROP
-A SUBETHA-EGRESS -d 2001:db8::/32 -j DROP
-A SUBETHA-EGRESS -d 2002::/16 -j DROP
-A SUBETHA-EGRESS -d 3fff::/20 -j DROP
-A SUBETHA-EGRESS -d 5f00::/16 -j DROP
-A SUBETHA-EGRESS -d fc00::/7 -j DROP
-A SUBETHA-EGRESS -d fe80::/10 -j DROP
-A SUBETHA-EGRESS -d fec0::/10 -j DROP
-A SUBETHA-EGRESS -d ff00::/8 -j DROP
-A SUBETHA-EGRESS -j RETURN
COMMIT
```

**分類表**（IANA Special-Purpose Address Registry、更新日 **2025-10-09**。検証 runner はレジストリの
`<updated>` を取得し、この日付より新しければ**見直しを要求**する）:

| family | 規則 | 根拠 |
|---|---|---|
| v4 | `0.0.0.0/8` `10/8` `100.64/10` `127/8` `169.254/16` `172.16/12` `192.0.0.0/24` `192.0.2.0/24` `192.168/16` `198.18/15` `198.51.100/24` `203.0.113/24` `240/4` | Globally Reachable = **False** の全件（`0.0.0.0/32`、`192.0.0.0/29`、`192.0.0.8/32`、`192.0.0.170-171/32`、`192.88.99.2/32`、`255.255.255.255/32` はそれぞれ上位ブロックに含まれる） |
| v4 | `192.88.99.0/24` | 6to4 relay anycast、非推奨（レジストリに到達性の記載なし） |
| v4 | `224.0.0.0/4` | multicast（レジストリ外、unicast ではない） |
| v4 **保守的除外** | `192.0.0.9/32`、`192.0.0.10/32`（PCP / TURN anycast、True）を `192.0.0.0/24` ごと拒否 | Router に用は無い |
| v4 許可 | `192.31.196/24` `192.52.193/24` `192.175.48/24`（True） | — |
| v6 | `::/128` `::1/128` `::ffff:0:0/96` `64:ff9b:1::/48` `100::/64` `100:0:0:1::/64` `2001::/23` `2001:db8::/32` `3fff::/20` `5f00::/16` `fc00::/7` `fe80::/10` | Globally Reachable = **False** の全件（`2001:2::/48` は `2001::/23` に含まれる。`2001:db8::/32` は**含まれない**ので別掲） |
| v6 | `ff00::/8` | multicast |
| v6 **保守的除外** | `2001::/23` ごと（内側の True: `2001:1::1-3/128`、`2001:3::/32`、`2001:4:112::/48`、`2001:20::/28` ORCHIDv2、`2001:30::/28` DETs。Teredo `2001::/32` は N/A）、`64:ff9b::/96`（NAT64 well-known、True だが翻訳無し）、`2002::/16`（6to4、N/A）、`fec0::/10`（非推奨 site-local、レジストリ外） | Router に用は無い |
| v6 許可 | `2620:4f:8000::/48`（True） | — |

**IPv4-mapped**: `::ffff:a.b.c.d` は socket API 上の表現で、**ワイヤ上は IPv4 パケット**になり v4 規則で分類される。
v6 側の `::ffff:0:0/96` は念のための行であり、v4 側の分類の代替ではない。

**host 目録**: `apply` 時に `ip -4/-6 -o addr show scope global` の全アドレスを DROP 行にする（bridge の gateway を含む）。
加えて `HOST_ADDRS4`（**必須**。公開/Elastic IP はインタフェースに無い。無ければ `none` と明示）。
`EXTRA_DENY4/6` はグローバルアドレスを持つ内部サービス用。

**REPLY 例外**: `--ctstate ESTABLISHED,RELATED --ctdir REPLY` は **host（または外部）がコンテナへ開いた接続の返信方向すべて**を通す
（Caddy → Router がその用途。Router が開いた接続は `ORIGINAL` 方向なので対象外。実測 20）。

### 11.5 ライフサイクル

| 項目 | 内容 | 実測 |
|---|---|---|
| 投入 | `docker.service` drop-in `ExecStartPre=/usr/local/sbin/subetha-egress apply`。コンテナ復元の前に入り、失敗なら Docker が上がらない | 22、23、**34（実 reboot）**: `Starting docker` 09:33:16.022 → `applied` **.069** → `Loading containers` **.268**。復元後最初の試行は `exit=28` |
| 前提 | **`LiveRestoreEnabled=false`**（true だとコンテナが daemon 停止を生き延び、「dockerd 無し ⇒ Router 無し」が成り立たない）。**firewalld 不在/無効**。`userland-proxy` は既定（on） | 25 で `false` / `not-found` を記録 |
| 再適用 | `subetha-egress apply`（24 ms）。family ごとに `iptables-restore --noflush` の 1 コミット。jump は `-C || -I` で永続 | 14、24 |
| guard | `subetha-egress-guard.timer`（30 秒毎に `check || apply`）。外部 flush を自己修復。**窓は閉じない（上限 30 秒）**ので、Router 稼働中の flush/reload は手順で禁止し、保守前に `check` を見る | 28（flush 後 22 秒で復旧、journal に記録） |
| 初回導入・移行 | (1) スクリプト・env・drop-in・guard を入れ `apply`（Router が docker0 上でも `-i docker0` で効く）→ (2) `docker network create ... subetha0` → (3) Router を `--network subetha-router-net` で作り直す → (4) 検証 runner | — |
| env parser | `KEY=value`、値は任意で二重引用符、`#` コメント。**source しない**。許可キー: `IFACES` `HOST_ADDRS4` `HOST_ADDRS6` `EXTRA_DENY4` `EXTRA_DENY6`。未知キー・重複キー・`KEY=` でない行・空の `IFACES`・未設定の `HOST_ADDRS4`・CIDR 形でない値は **exit 65**（fail-closed） | ローカルで 5 通り確認 |
| 削除 | `subetha-egress remove`（Router 停止中のみ） | — |

### 11.6 検証プロトコル v3（§9.6 を置き換える）

**期待クラス**を宛先ごとに先に決め、クラスごとに観測点を固定する:

| クラス | 意味 | 証拠 |
|---|---|---|
| **firewall-dropped** | 自チェーンで落ちた | veth に SYN あり・SYN-ACK なし、対応 DROP 行のカウンタ増、conntrack にエントリ無し、uplink/宛先で 0 |
| **kernel-rejected** | 送信前に socket で失敗（multicast への TCP 等） | 即時エラー、veth に無し |
| **namespace-local** | B の対象外（A） | 規則に当たらず到達/拒否。A の検証へ |
| **allowed-control** | 通るべき | 成功 |

| ID | 試験 | 期待クラス / 証拠 |
|---|---|---|
| V3-1 | 行列: v4 の全 15 範囲 × TCP、代表 × UDP/ICMP、**Router の netns から** | firewall-dropped（`127/8` は namespace-local、`224/4` の TCP は kernel-rejected） |
| V3-2 | host の全アドレス（`ip addr` + 公開 IP）宛て | firewall-dropped（host 目録行） |
| V3-3 | host の別名アドレス（試験用に追加）宛て、目録前/後 | 前: 到達（gap の再現）/ 後: firewall-dropped |
| V3-4 | 公開ポート hairpin（同 bridge）→ userland proxy | firewall-dropped（host 目録行） |
| V3-5 | operator 風 DNAT の後の宛先 | firewall-dropped（`FORWARD`、`172.16/12` 行） |
| V3-6 | 隣接（一時的な敵対構成: 同 bridge・docker0） | firewall-dropped。**終了後**に最終 assertion: `subetha-router-net` の Containers が Router のみ、Router の `NetworkMode` がそれのみ |
| V3-7 | Caddy → Router、公開 HTTPS、quote | allowed-control |
| V3-8 | DNS: 未キャッシュの実在名（`<random>.1.1.1.1.nip.io`）解決 + veth の port 53 捕捉 + resolver:53 への HTTP | 解決成功・veth 0・HTTP は firewall-dropped。前提: 上流が host loopback |
| V3-9 | 既存接続（規則除去 → 接続 → `apply`） | 以後 firewall-dropped |
| V3-10 | 再適用の原子性 | `strace`: 1 バッチ。並行 SYN 到達 0 |
| V3-11 | reboot: boot 時に docker より前に起動する捕捉 unit + host listener unit + 独立受信側 | journal 順序、復元後最初の試行が firewall-dropped、捕捉は host の正の対照 1 件のみ |
| V3-12 | fail-closed: env 不正 ×2 | docker 起動失敗、`dockerd` 0 |
| V3-13 | guard: `-F` 後 | 30 秒以内に `check` ok |
| V3-14 | IPv6: コンテナ内 `disable_ipv6=1`、link-local への接続 | kernel-rejected。bridge `EnableIPv6=false`。`ip6tables` チェーン 16 DROP |
| V3-15 | 前提の記録 | `LiveRestoreEnabled=false`、firewalld 不在、`userland-proxy` 既定、backend、kernel、Docker 版、raw/nat/mangle の Docker 規則、レジストリ更新日 |
| V3-16 | loopback（A の対象であることの確認） | namespace-local |

**捕捉点**: veth（規則より前。`br_netfilter` の有無に依らず見える）。bridge デバイス上は `br_netfilter` 有効時に見えない（実測 15）。
uplink は正の対照（host 自身の同宛先接続）が**同じフィルタで捕捉される**ことを同時に示す。

### 11.7 実測 25〜34

| # | 実測 | 結果 |
|---|---|---|
| 25 | daemon `dns: ["192.168.5.2"]`（非 loopback）にして未キャッシュ名を解決 | veth 上に **6** DNS パケット（`172.30.0.2 → 192.168.5.2:53`）、全て DROP、解決失敗。戻すと veth 上 **0**。`LiveRestoreEnabled=false`、firewalld `not-found` |
| 26 | eth0 に `11.22.33.44/32`（どの拒否範囲にも無い）を付け listener。目録再適用の前後 | 前: **`http=404`、listener に 1 到達**（gap）。後: `exit=28`、到達増えず |
| 27b | 同 bridge の公開ポート `11.22.33.44:18000`（目録行を故意に除去） | `http=200`、宛先 veth の SYN の送信元は **`172.30.0.1`（host = docker-proxy）**。`nat DOCKER` 先頭に `-i subetha0 -j RETURN`。目録を戻すと `exit=28` |
| 27c | operator 風 DNAT（`11.22.33.44:18001 → 172.17.0.3:8000`、目録行除去） | `FORWARD` 再判定あり: `exit=28`、`172.16/12` **+2**、宛先 veth に SYN 0。jump 除去時も Docker の bridge 間隔離で 0（正の対照は取れず） |
| 28 | `iptables -t mangle -F SUBETHA-EGRESS` | `check` FAIL、Mac に到達可。**22 秒後**に guard が復旧（journal: `re-applying`） |
| 29 | コンテナ内 IPv6 | `disable_ipv6=1`、link-local 宛て `Network unreachable`（kernel-rejected）、bridge `EnableIPv6=false` |
| 31 | `u<epoch>.1.1.1.1.nip.io` を解決・接続（例外行 0） | `1.1.1.1` に解決、veth の DNS **0**、eth0 の送信元 host。`http://192.168.5.2:53/` は `exit=28` |
| 32 | host 宛て drop の packet-level 証拠 | veth: SYN **6**、SYN-ACK **0**、conntrack エントリ **0**、listener 到達 0 |
| 34 | **実 reboot**（`colima restart`）。boot 時 unit で eth0 捕捉、host listener、probe `--restart unless-stopped` | journal: capture/observer 09:33:15.788 → `Starting docker` 16.022 → `applied (18 IPv4, 18 IPv6)` **16.069** → `Loading containers` 16.268 → `Started docker` 16.668。復元後最初の試行 **17.670 `exit=28`**。34/34/34。捕捉 SYN は host の正の対照 **1 件のみ**。host listener 到達 0。Mac 到達は同じ対照 1 件のみ。`br_netfilter` は未ロード |

### 11.8 未解決・残余

- **AL2023 は未実測**。受け入れは本番 host での検証 runner（V3-1〜16）。必要事実: kernel、Docker 版、backend、iptables 版、`bridge-nf-call-iptables`、resolv.conf が stub か、`LiveRestoreEnabled`、firewalld、`userland-proxy`
- nftables backend: hook は Docker のチェーンに依存しないが**共存は未実測**
- `subetha0`/`docker0`/`br+` 以外の任意名 bridge は jump の対象外 → V3-6 の attachment assertion で検出
- guard の窓（≤ 30 秒）。閉じるには保守手順の遵守が要る
- 公開 NAT アドレス経由の hairpin は `HOST_ADDRS4` に依存。検証 runner は host 上で IMDS の `public-ipv4` を読み、目録に含まれることを assert する
- `userland-proxy=false` の構成は未実測（Docker が DNAT を使う経路。`FORWARD` 再判定が効くはずだが実測していない）

### 11.9 実装フェーズの成果物

`deploy/egress/subetha-egress`、`deploy/egress/10-subetha-egress.conf`、`deploy/egress/subetha-egress-guard.{service,timer}`、
`deploy/egress/subetha-egress-verify`（V3-1〜16 を実行し証拠を出す。検証補助 unit を含む）、`DEPLOY.md`。

## 12. 設計レビュー #3（v3、`5dd1748`）: **REJECT** → v4 で応答

レビュー実施: 2026-10-01、`gpt-6-astra`。blocking 6 件。v2 の 5 件は「部分的に解決・絞り込み」。
レビュアはスクリプトを **mock した firewall コマンドでユニット実行**し、制御フローの欠陥を実証した。

| # | 指摘（要約） | 判定 | v4 での応答 | 実測 |
|---|---|---|---|---|
| 1 | `check`/`guard` は弱体化した policy を受け入れる（DROP 行数 ≥15 と jump の存在しか見ない。目録行の削除、早い RETURN、jump の上の規則、目録の陳腐化、`guard` が validate を呼ばない） | **正しい** | `check` を**完全一致**に変えた: いま render した policy を scratch chain に載せてカーネルの正規形で読み出し、live chain と**行単位で比較**。各 hook の**先頭 N 行が自分の jump** であることも要求。`guard` は validate → check → apply → check | 36（5 通りの sabotage すべてを `check` が拒否、無効 env を `guard` が拒否） |
| 2 | 検証・目録収集が成功しても意図した保護が入らない（`IFACES="   "`、`HOST_ADDRS4=` 空、`999.999.999.999/99`、`ip` 失敗が空の目録になる、`scope global` の狭さ、引用符の片側剥がし） | **正しい** | 文法を定義し強制（§13.5）。interface トークン検査、`HOST_ADDRS4` 非空必須、IPv4 のオクテット/プレフィクス検査、`ip` 失敗は fatal、全 scope を収集、引用符は両側必須。両 family を **`iptables-restore --test` で dry-run してから**コミット | ローカルで 5 通り、36 |
| 3 | DNS 条件が出所と分類を取り違えている。Docker 28.3.3 は `HostLoopback = !NSOverride`: **継承した** nameserver は host namespace、**上書きした** nameserver はコンテナ namespace。実測 25 は出所とアドレスを同時に変えていた | **正しい** | 4 通りを分離して実測（継承 stub / 継承 non-loopback / 上書き loopback / 上書き non-loopback）。条件を「**上書き無し**」に改め、検証は `HostConfig.Dns*` 空・daemon.json に `dns` 無し・resolv.conf が `127.0.0.11`・未キャッシュ名の解決中に veth の port 53 が 0 | **35** |
| 4 | 検証行列の矛盾（同 bridge 隣接の期待が `br_netfilter` 無しと矛盾、既存接続は conntrack が残る、UDP/ICMP の証拠未定義、attachment set、27c に正の対照が無い、rebinding/proxy の扱い） | **正しい** | 期待をトポロジと sysctl に**条件付け**（`bridge-nf-call-iptables=1` なら dropped、無ければ **reachable** を期待し singleton を必須に）。既存接続は別クラス。UDP/ICMP は veth の往路あり・復路なし + カウンタ。attachment set は `NetworkSettings.Networks` 全体。DNAT の正の対照は **bridge 外の宛先**（同 bridge 宛先は SYN-ACK が host を迂回し成立しない）。rebinding は「禁止アドレスに解決される名前」で試験、proxy は要件で対象外を明示 | 36（runner 全項目）、37 |
| 5 | boot 時の観測 unit は `Type=simple` で readiness を保証しない。`eth0`・宛先・180 秒が固定 | **正しい** | `ExecStartPost` で readiness を待つ（tcpdump の `listening on`、listener への HTTP 応答）。uplink・フィルタ・寿命は runner が展開から導出して置換。試験中だけ `docker.service` に `Requires=` の drop-in を入れ、観測が無ければ Docker を上げない | 37 |
| 6 | guard の「30 秒上限」は保証ではない。初回導入は Router 稼働中。`remove` が Router/timer と協調しない。`Restart=always` の再試行を観測していない | **正しい** | guard は **best-effort の復旧**と言い直す（`AccuracySec=1s`）。導入・破壊試験は Router 停止中に行う手順を書く。`remove` は timer 稼働中・Router 稼働中は拒否（`FORCE=1` は検証専用）。fail-closed 試験は 20 秒待って dockerd と containerd-shim の不在を見る | 36、37 |

non-blocking: hook と REPLY 例外は妥当、transaction の主張は適切に限定済み、deny 一覧はスナップショットを網羅
（Teredo は N/A — §11.4 を訂正）、A/B 分担と release gate は妥当、AL2023 は展開ゲート。

## 13. 設計 v4（現行。§11 のうち規則表以外を置き換える）

> 実測 35〜38 は §9 と同じローカル VM。v4 の成果物は `deploy/egress/`（スクリプト、drop-in、guard unit、
> 検証補助 unit、検証 runner）で、**本節の実測はすべてその runner で取った**。

### 13.1 v3 からの変更

| 変更 | §12 の指摘 | 実測 |
|---|---|---|
| `check` = いま render した policy とカーネル正規形で**完全一致**、各 hook の先頭 N 行が自分の jump | 1 | 36 |
| `guard` = validate → check → apply → check | 1 | 36 |
| 設定文法の強制、`HOST_ADDRS4` 非空必須、IPv4 の意味検査、`ip` 失敗は fatal、両 family を `--test` してからコミット | 2 | 36 |
| 目録は link-local を除く**全 scope**（veth の fe80 で policy が揺れるのを防ぐ。link-local はレジストリ行が落とす） | 2 | 36（churn 下で `check` 安定） |
| DNS 条件 = **上書き無し**（出所で決まる） | 3 | 35 |
| 検証の期待クラスをトポロジ・sysctl に条件付け、DNAT の正の対照は bridge 外の宛先、Docker raw による drop を帰属 | 4 | 36 |
| 観測 unit に readiness（`ExecStartPost`）、試験中だけ `docker.service` に `Requires=` | 5 | 37 |
| guard は best-effort、`AccuracySec=1s`、`remove` は timer/Router 稼働中は拒否、fail-closed は再試行期間を観測 | 6 | 36、38 |

### 13.2 守る範囲

§11.2 のとおり。B の不変条件は「禁止宛先に**届く**接続試行パケットが 0」。namespace 内は A。

### 13.3 トポロジと DNS

- Router は専用 user-defined bridge `subetha0` に**単独**（§11.3）。
- **DNS 条件: Router の DNS を上書きしない。** Docker 28.3.3 の埋め込み resolver は、host から**継承した**
  nameserver へは host の namespace から、`--dns` / daemon `dns` で**上書きした** nameserver へは
  コンテナの namespace から問い合わせる（`HostLoopback = !NSOverride`）。loopback かどうかは無関係。

| 実測 35 | host の nameserver | 上書き | veth 上の DNS | 解決 |
|---|---|---|---|---|
| (a) | `127.0.0.53`（stub、継承） | なし | **0** | 成功 |
| (b) | `192.168.5.2`（非 loopback、継承。host の resolv.conf を一時的に差し替え） | なし | **0** | 成功 |
| (c) | — | `--dns 127.0.0.53` | 0（コンテナ内 loopback で死ぬ） | **失敗** |
| (d) | — | `--dns 192.168.5.2` / daemon `dns` | **6**（`172.30.0.x → 192.168.5.2:53`、全て DROP） | **失敗** |

  → 展開条件は「`HostConfig.Dns*` が空、daemon.json に `dns` が無い、コンテナの resolv.conf が `127.0.0.11`」で、
  AL2023 が systemd-resolved かどうかに**依存しない**。検証は未キャッシュの実在名（`<random>.1.1.1.1.nip.io`）の
  解決中に Router の veth で port 53 が 0 であること、および上流 resolver の 53 番への HTTP が落ちること。

### 13.4 規則

§11.4 の表のとおり（Teredo は N/A に訂正済み）。目録行は `apply` 時点の host の全アドレス（link-local 除く）+
`HOST_ADDRS4`（公開/Elastic IP。**必須**、無ければ `none`）+ `EXTRA_DENY*`。
この VM では v4 **21 行**（REPLY 1 + 目録 4 + レジストリ 15 + RETURN 1）、v6 **19 行**（1 + 1 + 16 + 1）。
**起動直後**は bridge の gateway アドレスが未生成なので v4 は 19 行で入り、guard の初回（≤30 秒）で 21 行になる。
その間 gateway アドレスは `172.16/12` 行が落とす（実測 37）。

### 13.5 スクリプトの契約（`deploy/egress/subetha-egress`）

| 項目 | 契約 |
|---|---|
| 設定文法 | 空行と `#` 始まりの行のみ無視（行内コメント無し）。`KEY=value` または `KEY="value"`（引用符は両側）。キーは 5 つ、未知・重複・不正行・片側引用符・空の `IFACES`・未設定/空の `HOST_ADDRS4`・不正アドレスは **exit 65** |
| `apply` | validate → 両 family を render → **両方を `--test`** → 両方をコミット（family ごとに 1 トランザクション）→ jump を `-C || -I`。失敗時は非 0 で ExecStartPre を落とす |
| `check` | validate → render（新しい目録）→ scratch chain に載せて `-S` で正規形に → live chain と**行単位で一致** → 各 hook の先頭 N 行に自分の jump が全部ある。差分は stderr に `diff` |
| `guard` | validate（失敗なら触らず exit 65）→ check → 不一致なら apply → check |
| `remove` | `subetha-egress-guard.timer` 稼働中、または `ROUTER_CONTAINER`（既定 `subetha-router`）稼働中は拒否。`FORCE=1` は検証専用 |
| 目録 | `ip -4/-6 -o addr show` の全アドレスから `scope link` を除く。`ip` が失敗したら fatal |

### 13.6 ライフサイクル

- **投入**: `docker.service` の `ExecStartPre`（§11.5）。**実 reboot で 2 回**確認（実測 34、37）。
- **前提**（runner が検証し、満たさなければ FAIL）: `LiveRestoreEnabled=false`、firewalld 不在/無効、`userland-proxy` 既定、
  `ExecStartPre` の存在、guard timer 稼働、Router の attachment set が `{subetha-router-net}` のみで `NetworkMode` も同じ、
  network の Containers が Router のみ、bridge 名が `subetha0` で `IFACES` に含まれる、`EnableIPv6=false`、DNS 上書き無し。
- **guard** は **best-effort の復旧**であって保証ではない（実測 36: flush 後 31 秒で復旧。その間は到達可）。
  **Router 稼働中に firewall を触らない**ことが運用条件。保守は Router 停止中に行い、`check` が通ってから再開する。
- **導入と移行**（Router 停止中）: ファイル配置 → env（`HOST_ADDRS4` に公開 IP）→ `apply` → `check` → network 作成 →
  Router を `--network subetha-router-net` で作り直す → runner（standard → adversarial → fail-closed → reboot）→ 稼働。
- **fail-closed**: env が不正なら `docker.service` は `Restart=always` の再試行を含めて上がらない（実測 38: 20 秒観測で dockerd 0、containerd-shim 0）。
- **boot 時の観測 unit**（検証専用）: `ExecStartPost` で readiness（tcpdump の `listening on`、listener の HTTP 応答）を待ってから
  "Started" になるので、`Before=docker.service` が「観測が開いてから Docker」を意味する。試験中は
  `99-egress-verify.conf` が `docker.service` に `Requires=` を足し、観測が無ければ Docker を上げない。
  tcpdump は `-Z root`（実測 37 の 1 回目で、boot 時だけ非特権ユーザが pcap を作れず EACCES で死んだ。再現せず原因未特定）。

### 13.7 検証プロトコル v4（`deploy/egress/subetha-egress-verify`）

| モード | 内容 | 破壊性 |
|---|---|---|
| （既定） | 前提と事実、V4-1 行列（TCP 13 件 + multicast + loopback + UDP/ICMP + DNS 由来の private 宛先 + observer）、V4-2 host 全アドレス + 公開 IP（IMDS から読み `HOST_ADDRS4` と照合）、V4-7 対照、V4-8 DNS、V4-10 原子性 + hammer、V4-14 IPv6、V4-16 loopback | なし |
| `--adversarial` | + V4-17 `check` の sabotage 5 通りと無効 env、V4-3 別名アドレスの gap/修復、V4-4 hairpin、V4-5 DNAT 再判定 + **正の対照**、V4-6 隣接（sysctl で期待を切替）、V4-9 既存接続、V4-13 guard | 別名アドレス追加、一時コンテナ、policy の除去/再適用。**Router 停止中に** |
| `--fail-closed` | V4-12 | Docker 停止 |
| `--reboot-prepare` → reboot → `--post-boot` → `--reboot-cleanup` | V4-11 | probe コンテナと観測 unit、試験用 drop-in |

**期待クラス**: firewall-dropped（veth に往路あり・復路なし、カウンタ増、conntrack 無し、uplink/宛先で 0）、kernel-rejected、
namespace-local（A）、allowed-control、**dropped-by-Docker**（raw の DROP が先に効いた。届かないが自分の証拠ではない）。
隣接は `bridge-nf-call-iptables=1` なら firewall-dropped、無ければ **reachable** を期待し（§11.3 の根拠）、singleton を必須にする。

### 13.8 実測 35〜38

| # | 実測 | 結果 |
|---|---|---|
| 35 | DNS の出所 4 通り（§13.3） | 継承 → host namespace、上書き → コンテナ namespace |
| 36 | runner `--adversarial`（OBSERVER = Mac） | **70 PASS / 0 FAIL**。`check` は目録行削除・早い RETURN・v6 行削除・jump 上の規則・目録陳腐化を全て拒否、`guard` は無効 env を拒否。別名 `11.22.33.44`: 目録無しで **404 到達**、apply 後 28。hairpin 28。DNAT（`11.22.33.44:18001 → 192.168.5.2:19999`）: `FORWARD` 再判定で `192.168/16` **+2**、jump 除去で **200**（observer に到達記録）。同 bridge 隣接は `bridge-nf-call-iptables` 無しで **200**（期待通り）、docker0 隣接は **Docker の raw DROP** が先（+2）。既存接続は apply 時刻に tick が止まる。guard 31 秒。veth churn 下で `check` ok×3 |
| 37 | 実 reboot ×2（readiness 付き観測 unit、`Requires=` drop-in、probe `--restart unless-stopped`） | 1 回目: tcpdump が boot 直後に EACCES（§13.6）。2 回目: observers 10:47:42.442/.666 → `applied` **.725** → `Loading containers` **.792** → 復元後最初の試行 **:44.098 `deny 28`**。成功した禁止試行 0、公開対照到達、boot 捕捉に probe 発 0（host 発 935 が対照）、host listener 0、`check` は guard 初回後に ok |
| 38 | `--fail-closed` | 不正 `HOST_ADDRS4`: 20 秒の再試行後 dockerd 0・shim 0。未知キー: 失敗。復旧後 `check` ok、Router 稼働 |

### 13.9 未解決・残余

- **AL2023 は未実測**。runner の全モードを本番 host で通すことが受け入れ。transfer できない事実: Docker のチェーン構成、`userland-proxy`、resolver の出所、backend、`br_netfilter`、復元タイミング、公開 IP の hairpin、IPv6
- nftables backend との共存は未実測。`userland-proxy=false`（Docker が DNAT を使う経路）は未実測（runner は FAIL にする）
- IPv6 は「bridge で無効」を確認するのみ。有効化した場合の強制は**未実証**（runner は FAIL にする）
- boot 時の tcpdump EACCES の原因は未特定（`-Z root` で回避）
- guard の窓は閉じない。任意名の bridge は jump の対象外（attachment assertion で検出）
- V4-9 の OBSERVER は**行を記録する TCP listener** が要る（HTTP server では tick が記録されない）

### 13.10 成果物

`deploy/egress/subetha-egress`、`10-subetha-egress.conf`、`subetha-egress-guard.{service,timer}`、
`egress-host-observer.service`、`egress-boot-capture.service`、`99-egress-verify.conf`、`subetha-egress-verify`。
`DEPLOY.md` の手順は実装フェーズで書く（設置、env、network、移行順、runner の実行順、保守規則）。

## 14. 設計レビュー #4（v4、`92c146b`）: **REJECT** → v5 で応答

レビュー実施: 2026-10-02、`gpt-6-astra`。blocking 5 件。v3 の 6 件は「部分的に解決」。
レビュアは再び mock した firewall コマンドでスクリプトを実行し、**偽の成功**になる経路を実証した。

| # | 指摘（要約） | 判定 | v5 での応答 | 実測 |
|---|---|---|---|---|
| 1 | `check` の hook 検査が部分一致（`-j SUBETHA-EGRESS-BYPASS` が通る）。`IFACES` の重複トークンで先頭 N 行検査が破れる。`apply` は jump の**存在**しか見ず、押し下げられた jump を直さない | **正しい** | 先頭 N 行を期待集合と**完全一致**で比較。重複トークンは validate で拒否。`place_jumps` が全 jump を先頭に入れ直してから下の自分の jump を**行番号で**削除（新しい方を先に入れるので窓が無い）。`apply` は最後に `check` を走らせ、通らなければ失敗する（ExecStartPre が落ちる） | 40（look-alike chain、重複トークン、押し下げ、いずれも検出。押し下げは `apply` が修復） |
| 2 | 目録の読み出し失敗が `check`/`guard` で fatal にならない（`$(...)` の中の exit、pipeline、`if check` による errexit 抑止） | **正しい** | `set -e` に依存しない。`host_ifaddrs` は非 0 を返し、`render` → `apply`/`check` の各段で**明示的に**状態を見る。`guard` は validate → check → apply(→ check) | 40（偽の `ip` で `check`・`guard` とも失敗、policy は無傷） |
| 3 | reboot の捕捉は **MASQUERADE 後**の送信元で probe を探していた（必ず 0 になる）。正の対照が gate でない。OBSERVER 無しでは uplink を通らない。HTTP ログは accept を全部記録しない。捕捉の読み出し失敗が 0 になる | **正しい** | 外部 observer を**必須**にし、uplink 捕捉は observer 宛て全パケット。帰属は**宛先ポート + epoch 時刻**（probe ポートへの SYN が制御接続より前に 1 つでもあれば leak）。正の対照は同じ捕捉経路で**必ず 1 以上**。observer は accept 単位で記録し JSON で返す。読めない捕捉は FAIL | 42 |
| 4 | runner の空の assertion（SYN-ACK 検査が復路を捕捉していない、DNS 捕捉の起動失敗、resolver への HTTP の判定、既存接続が INFO、listener の readiness、sabotage の setup 失敗、UDP/ICMP の混同、DNAT は片経路） | **正しい** | veth は**双方向**捕捉。観測が立たなければ FAIL。resolver HTTP は `exit=28` + 行カウンタ増。既存接続は host observer の行記録で assert。sabotage の各 setup を検査。UDP/ICMP を分離。DNAT は INPUT（host observer）と FORWARD（外部 observer）の**両経路**、正の対照付き | 39、40 |
| 5 | 前提の検査が不完全（firewalld の is-active、daemon の cmdline/config-file、ExecStartPre の内容、subnet が RFC1918 である前提、破壊試験中の Router の扱い） | **正しい** | `is-active` も見る。dockerd の cmdline と `--config-file` を解決して見る。ExecStartPre は `subetha-egress apply` と完全一致。network の subnet が拒否範囲内であることを前提として検査。adversarial は **Router 停止中**に同 network の代役コンテナで行う（runner が Router 稼働中なら拒否） | 40 |

non-blocking で取り込んだもの: `flock` で apply/check/guard/remove を直列化、scratch chain の後始末を検査、`remove` は状態不明なら拒否、
link-local は **範囲**で除外（`169.254/16`、`fe80::/10`）、「≤30 秒」の表現を削除、fail-closed は journal の再試行記録を見る、
実測 35 は runner ではなく個別コマンドで取ったと明記、Docker 版依存（DNS）は runner が稼働版で再測定。

## 15. 設計 v5（現行。§13 のうち以下で言い直した部分を置き換える）

> 成果物: `deploy/egress/subetha-egress`（policy）、`subetha-egress-verify`（runner）、`egress-observer.py`（観測）、
> unit 6 つ。実測 39〜43 は runner の出力。実測 35（DNS の出所）は個別コマンドによる（§13.3）。

### 15.1 観測の仕組み

- **observer**（`egress-observer.py`）: 指定ポートで accept した接続と受信した行をすべて記録し（HTTP 要求にはヘッダを記録してから応答）、
  別ポートで `GET /?since=<epoch>` に JSON で返す。host 上（`egress-host-observer.service`、runner が起動/停止）と、
  **VPC 内の別 host**（外部 observer。RFC1918 アドレス、`OBSERVER` / `OBSERVER_REPORT`）で動かす。
- runner は observer の記録を**読んで判定**する: 禁止宛先への試行中は accept 0、正の対照（`X-Control` ヘッダ付きの host 自身の接続）は記録あり。
- uplink の帰属: probe は MASQUERADE 後に host のアドレスで出るので、**宛先ポートと epoch 時刻**で見る（probe ポートへの SYN が制御接続より前に 0）。
- 捕捉は readiness（`listening on`）を待ってから試行し、読めない捕捉は FAIL。veth は双方向（復路の SYN-ACK を数える）。

### 15.2 スクリプト契約（§13.5 の差分）

| 項目 | v5 |
|---|---|
| hook の検査 | 各 hook の先頭 N 行（N = IFACES 数）が期待集合（`-A HOOK -i IF -j SUBETHA-EGRESS` × N）と**文字列として完全一致** |
| `IFACES` | トークンの重複を拒否 |
| `place_jumps` | 先頭 N 行が期待集合なら何もしない。違えば全 jump を位置 1 に**新規挿入**し、N 行目より下にある自分の jump を**行番号の大きい順に削除**（`-D <spec>` は新しい方を消してしまう） |
| `apply` | validate → render ×2（目録失敗は fail）→ `--test` ×2 → commit ×2 → place_jumps ×2 → **check**。どこかで失敗すれば非 0 |
| `check` | render・scratch 読み出し・後始末・比較の各段で明示的に状態を見る。`set -e` に依存しない |
| `guard` | validate（失敗なら触らず exit 65）→ check → apply（内部で check） |
| 直列化 | `flock /run/subetha-egress.lock` |
| `remove` | timer 稼働中、Router 稼働中、**どちらも判定できない場合**も拒否。`FORCE=1` は検証専用 |
| 目録 | 全 scope から `169.254.0.0/16` と `fe80::/10` を**範囲で**除外 |

### 15.3 runner（`subetha-egress-verify`）

| モード | 前提 | 内容 |
|---|---|---|
| 既定 | Router 稼働、外部 observer 任意 | 前提（§15.4）、行列（TCP 13 + multicast TCP/UDP 別 + loopback + UDP/ICMP 別 + 外部 observer + DNS 由来 private）、host 全アドレス（observer accept 0 + 制御接続あり）、対照、DNS（上書き無し・未キャッシュ名・veth 0・resolver:53 HTTP drop）、原子性（strace 1 バッチ、hammer 200、再適用 20 回で accept 0）、IPv6、loopback |
| `--adversarial` | **Router 停止**、外部 observer **必須** | 代役コンテナを同 network に置き、その netns で行列と DNS、`check` の sabotage（目録行削除・早い RETURN・v6 行削除・押し下げ→`apply` が修復・look-alike chain・陳腐化・無効 env・重複トークン・目録読み出し失敗で check/guard 失敗）、別名アドレス（gap → 修復）、hairpin、DNAT **INPUT と FORWARD** 両経路 + 正の対照、隣接（sysctl で期待切替、Docker raw の帰属）、既存接続（host observer の tick 行で assert）、guard 復旧、最終 check |
| `--fail-closed` | — | 不正 env → 20 秒後 dockerd 0・shim 0・journal に再試行記録 ≥2、未知キー → 失敗、復旧 |
| `--reboot-prepare` / `--post-boot` / `--reboot-cleanup` | 外部 observer 必須 | probe（外部 observer / host observer / 公開）、boot 時 unit（readiness 付き）、試験用 `Requires=`。post-boot: 順序、捕捉稼働中、`check`、復元後最初の試行、外部/host observer の accept 0、公開対照、正の対照（捕捉 + observer）、probe ポートへの SYN 0、cleanup 後の check |

### 15.4 前提（runner が FAIL にする）

`check` 合格、Router 稼働、attachment set が `{subetha-router-net}` のみ、network に Router のみ、bridge 名、`IFACES` に bridge、
**network の subnet が拒否範囲内**（起動直後の目録遅延を覆う）、`EnableIPv6=false`、`LiveRestoreEnabled=false`、firewalld 不在/無効/非稼働、
`userland-proxy` 既定（cmdline と config-file）、`ExecStartPre` が `subetha-egress apply` と一致、guard timer 稼働、
IANA レジストリ日付、DNS 上書き無し（container・daemon config・cmdline）、resolv.conf が `127.0.0.11`。

### 15.5 ライフサイクルの言い直し

- guard は**復旧**であって上限ではない（「≤30 秒」は撤回）。運用条件は「Router 稼働中に firewall を触らない」。
- fail-closed の証拠は dockerd/shim の不在 **と journal の失敗・再試行記録**。
- 導入・移行・破壊試験は Router 停止中。adversarial は代役コンテナで行う。
- 起動直後の目録遅延は「subnet が拒否範囲内」を前提として受容し、runner がその前提を検査する。

### 15.6 実測 39〜43

| # | 実測 | 結果 |
|---|---|---|
| 39 | runner 既定モード（Router 稼働、外部 observer 付き） | **59 PASS / 0 FAIL**。UDP 1 往路 0 復路、ICMP 同、SYN-ACK 0（双方向捕捉）、uplink probe 0 / host 発 378、observer accept 0 + 制御記録、resolver:53 HTTP `28` + `192.168/16` +2 |
| 40 | runner `--adversarial`（Router 停止、代役） | **51 PASS / 0 FAIL**。sabotage 10 通り全て検出。押し下げは `apply` が修復。目録読み出し失敗で `check`/`guard` 失敗・policy 無傷。別名: 目録無しで `200` + observer accept、apply 後 `28` + accept 0。DNAT: INPUT `172.30.0.1` +2 / jump 除去で `200` + host observer accept 1、FORWARD `192.168/16` +2 / jump 除去で `200` + 外部 observer accept 1。既存接続: tick 4 → 0（conntrack 2 残存）。guard 2 秒 |
| 41 | `--fail-closed` | 不正 `HOST_ADDRS4`: dockerd 0・shim 0、journal に失敗/再試行 **7 件**、原因行あり。未知キー: 失敗。復旧 ok |
| 42 | reboot ×2（readiness unit、`Requires=`、外部 observer） | 1 回目: leak 判定が **timezone に依存**（tcpdump の JST と UTC の比較で制御接続自身を数えた）→ epoch 比較に修正。2 回目: **11 PASS / 0 FAIL**。observers 19:56:18.68/.90 → `applied` **19.01** → `Loading containers` **19.09** → 復元後最初の試行 **20.41 `28`**。外部/host observer accept 0、正の対照 1 SYN + 記録、probe ポートへの SYN 0 |
| 43 | runner が成果物の欠陥を検出 | v5 初版の `place_jumps` は `-D <spec>` で**新しく入れた jump を消していた**（押し下げの修復が check で落ちる）→ 行番号削除に修正。観測の時計が 1 秒解像度で前段の accept を拾った → `%s.%N` |

### 15.7 残余

- **AL2023 は未実測**。受け入れは本番 host で runner 全モード `failed 0`（外部 observer は VPC 内の別 host）
- DNS の出所は Docker 28.3.3 で実測。他版では runner の V5-8（未キャッシュ名・veth 0）が稼働版での再測定になる
- boot 時の tcpdump EACCES は原因未特定（`-Z root` で回避。検証補助のみ）
- `userland-proxy=false`、IPv6 有効化、任意名 bridge、nftables backend は runner が FAIL/未対応として扱う
- guard の窓は閉じない。保守規則で補う

### 15.8 成果物

`deploy/egress/`: `subetha-egress`、`subetha-egress-verify`、`egress-observer.py`、`10-subetha-egress.conf`、`99-egress-verify.conf`、
`subetha-egress-guard.{service,timer}`、`egress-host-observer.service`、`egress-boot-capture.service`。`DEPLOY.md` は実装フェーズ。

## 16. 設計レビュー #5（v5、`8938253`）: **REJECT** → v6 で応答

レビュー実施: 2026-10-02、`gpt-6-astra`。blocking 6 件、non-blocking 3 件。
レビュアは mock で「挿入失敗後の削除」「状態不明での remove」「scratch 読み出し失敗の無視」「前提の文字列解析」を再現した。

| # | 指摘（要約） | 判定 | v6 での応答 | 実測 |
|---|---|---|---|---|
| 1 | `place_jumps` は挿入が 1 つでも失敗しても下の jump を削除し、**生き残っていた保護を消す** | **正しい** | 全 jump の挿入が成功し、かつ先頭 N 行が自分の jump であることを**読み直して確認してから**しか削除しない。失敗時は何も削除せず非 0。runner が fault injection（`iptables` の shim で 1 本の挿入を拒否）で確認 | 45 |
| 2 | `remove` は `docker inspect` の**あらゆる失敗**を「存在しない」と解釈して進む。runner の「Router 停止」判定も `true` 以外を通す | **正しい** | inspect が成功して `false` のときだけ、または inspect 失敗時に `docker ps -a` が**成功して**名前が無いときだけ進む。timer と guard service の状態も判定不能なら拒否。runner も同じ判定（`router_stopped`）。daemon 不達を shim して remove が拒否することを確認 | 45 |
| 3 | reboot の捕捉評価が 1 秒解像度で、probe が制御接続後も走り続け、制御と leak を区別していない。observer の時刻と host の時刻を比べている | **正しい** | 制御接続の前に **probe を停止**し、boot から静止までの区間で probe ポートへの SYN が 0 であることを epoch（小数）で判定。制御後の SYN は**ちょうど 1 本**で、外部 observer の accept **ちょうど 1 件**（`X-Control` 行付き）と対応付ける。observer は時刻ではなく **seq カーソル**（prepare 時に記録）で読む | 48 |
| 4 | observer は report ポートだけで readiness を名乗り、観測ポートの bind 失敗を伝えない。再起動で記録が消える。accept 前の backlog を見ていない | **正しい** | 観測ポートを**同期的に bind** してから report を開始（失敗は exit 1 → unit 失敗 → `Requires=` で Docker が上がらない）。`session`（起動時刻-pid）と単調 `seq` を返し、runner は prepare 時の session と一致・`listening` を要求、host observer は `NRestarts=0` を要求。`backlog`（`ss` の Recv-Q）を返し 0 を要求 | 48 |
| 5 | runner の空の gate（hammer の実行確認なし、conntrack の失敗が 0 に化ける、fail-closed の回数の数え方、未知キーの診断未要求、hairpin の宛先 readiness、DNS の veth 失敗が無言） | **正しい** | hammer は開始/終了時刻と exit を記録し再適用ループと**重なった**ことを要求。`conntrack -L` の失敗は FAIL。fail-closed は journal の**policy 診断行が ≥2 回**（試行ごとに出る）を要求、未知キーも診断行を要求。hairpin 宛先は host から 200 を確認してから。veth 失敗は FAIL | 44、46 |
| 6 | 前提の解析が弱い（gateway 文字列で subnet を判定、daemon.json の grep、ExecStartPre の前方一致、backend は印字のみ、読み出し失敗が「無し」になる） | **正しい** | IPAM の**全 subnet** を `ipaddress` で拒否範囲に包含判定。daemon.json は JSON として解析（不在/不正を区別）。dockerd の cmdline は読めなければ FAIL。ExecStartPre は `argv[]=/usr/local/sbin/subetha-egress apply ; ignore_errors=no` と一致。backend が `iptables` でなければ FAIL。firewalld は exit code で判定 | 44 |

non-blocking: scratch 読み出しと hook 一覧は**出力を受けてから**変換する（status が sed のものにならない）。guard は check から修復まで
**同じ lock を保持**（`apply_unlocked`）。runner に cleanup trap（env・別名・DNAT・コンテナ・policy・timer を復元）。
IANA は v4/v6 両方の日付を見る。「Caddy path」→「host→Router（Caddy の upstream 経路）」、strace は「IPv4 chain の restore」と表記。
証拠（pcap、observer JSON、journal 抜粋、runner 出力）は `/var/tmp/egress-verify-<時刻>-<mode>/` に残す。

## 17. 設計 v6（現行。§15 のうち以下で言い直した部分を置き換える）

> 成果物は `deploy/egress/` の v6。実測 44〜49 は runner v4 の出力（証拠ディレクトリ `/var/tmp/egress-verify-<時刻>-<mode>/`）。

### 17.1 スクリプト契約の差分（§15.2 に対して）

| 項目 | v6 |
|---|---|
| `place_jumps` | 先頭 N 行が期待集合なら何もしない。違えば全 jump を位置 1 に新規挿入し、**全部成功し、かつ先頭 N 行が期待集合だと読み直して確認できた場合に限り**、N 行目より下の自分の jump を行番号の大きい順に削除。挿入が 1 つでも失敗したら**何も削除せず**非 0（既存の保護はそのまま） |
| `apply` | `apply_unlocked`（validate → render ×2 → `--test` ×2 → commit ×2 → place_jumps ×2 → check）を lock の下で。`guard` は **同じ lock を保持したまま** check → apply_unlocked |
| `check` | scratch chain の `-S` と hook の `-S` は**出力を受けてから**変換する（status が `sed`/`head` のものにならない）。scratch の後始末失敗も FAIL |
| `remove` | `docker inspect` が**成功して `false`** のときだけ、または inspect 失敗時に `docker ps -a` が**成功して**名前が無いときだけ進む。timer と guard service は `is-active` の exit code で判定し、判定不能なら拒否。`FORCE=1` は検証専用 |
| 設定 | `IFACES` の重複トークンを拒否（§15.2 と同じ） |

### 17.2 観測プログラム（`egress-observer.py` v2）

- 観測ポートを **main で同期的に bind/listen** してから report サーバを開始。bind 失敗は exit 1（unit が失敗し、試験用 `Requires=` で Docker が上がらない）
- `GET /health` は観測ソケットが listen 中のときだけ 200（unit の `ExecStartPost` と runner の readiness はこれを使う。**引用符を含まない**ので systemd の unquoting に壊されない）
- `GET /?since_seq=<n>` は `{session, listening, seq_last, backlog, rows[{seq,t,kind,src,sport,data}]}`。`session` = 起動時刻-pid（再起動検出）、`seq` は単調（カーソル）、`backlog` は `ss` の Recv-Q（accept 待ちの接続。無ければ null）

### 17.3 runner v4 の gate（§15.3 に対して）

| 項目 | v6 |
|---|---|
| 前提 | IPAM の全 subnet を `ipaddress` で拒否範囲に包含判定。daemon config を JSON 解析（不在/不正を区別）、dockerd の cmdline（`--config-file` も解決）を読めなければ FAIL。`ExecStartPre` は `argv[]=/usr/local/sbin/subetha-egress apply ; ignore_errors=no` と一致。backend が `iptables` でなければ FAIL。firewalld は `is-active` の exit code。IANA は v4/v6 両方の更新日 |
| adversarial の前提 | **Router が停止していることを成功した query で確認**（`router_stopped`）。guard timer と service を止めて非 active を確認。cleanup trap で env・別名・DNAT・コンテナ・policy・timer を復元 |
| sabotage | §15.3 の 10 通り + **fault injection**（`iptables` の shim で 1 本の挿入を拒否 → `apply` は失敗し、既存の jump は残る）+ `remove` が daemon 不達で拒否 |
| hammer | 開始/終了時刻と exit を記録し、再適用ループと**重なった**ことを要求 |
| conntrack | `conntrack -L` の失敗は FAIL |
| fail-closed | journal の policy 診断行（試行ごと）が **≥2**、未知キーの診断行を要求 |
| hairpin | 宛先が host から 200 を返す（readiness）ことを確認してから |
| DNS | veth が見つからなければ FAIL |
| reboot | prepare で外部 observer の `session` と `seq` カーソルを記録。post-boot は: 順序、捕捉稼働中、**捕捉の連続性**（Started 1 回、NRestarts 0）、docker の起動回数を記録、外部 observer の session 不変 + listening、host observer listening + NRestarts 0、`check`、**probe を停止**してから boot〜静止の区間を評価（成功 0、外部 accept 0 since カーソル、host accept 0、backlog 0）、t0（小数 epoch）後に制御接続 ×2 → **稼働中の捕捉のコピー**を解析: t0 前の probe ポート SYN **0**、t0 後は**ちょうど 1 本**で外部 observer の accept **1 件**（`X-Control` 行付き）と対応、host observer も制御 1 件 |
| cleanup | 試験用 drop-in を削除して **`daemon-reload` してから** 補助 unit を止める（先に止めると `Requires=` で docker.service が止まり、socket activation で両方が再起動して捕捉が切り詰められる。実測 49 で踏んだ） |
| 証拠 | pcap、observer JSON、journal 抜粋、runner 出力を `/var/tmp/egress-verify-<時刻>-<mode>/` に残す |

### 17.4 実測 44〜49

| # | 実測 | 結果 |
|---|---|---|
| 44 | runner v4 既定モード（Router 稼働） | **62 PASS / 0 FAIL**。前提の構造解析（subnet 包含、daemon config JSON、ExecStartPre 完全一致、backend）、hammer は再適用ループと重なって exit 0 |
| 45 | runner v4 `--adversarial`（Router 停止を確認、代役） | **57 PASS / 0 FAIL**。fault injection: 挿入失敗で `apply` が失敗し `subetha0` の jump は残る（2 → 3 本）。daemon 不達で `remove` 拒否。DNAT は INPUT（host observer、目録行 `172.30.0.1` +2 / jump 除去で 200 + accept 1）と FORWARD（外部 observer、`192.168/16` +2 / jump 除去で 200 + accept 1）。既存接続 tick 4 → 0 |
| 46 | `--fail-closed` | **3 PASS**。不正 `HOST_ADDRS4`: 3 回の起動試行がいずれも policy の診断行で失敗、dockerd 0・shim 0。未知キー: 診断行あり |
| 47 | observer unit の readiness が systemd の unquoting で壊れていた（`\"listening\": true` → `grep "listening": true`）→ unit 失敗 → 試験用 `Requires=` が Docker を止め、docker CLI は socket activation で永久待ち | **設計どおりの fail-closed**（観測が無いと Docker が上がらない）が、原因は計測器。`/health` に変更 |
| 48 | runner の INPUT DNAT 試験が registry 行（`172.16/12`）を読んでいた | 落としたのは目録行（`172.30.0.1`）。修正 |
| 49 | reboot（v6 初回）: post-boot が捕捉 unit を止めた瞬間に `Requires=` で docker.service が止まり、socket activation で docker と捕捉が再起動、`-w` が pcap を切り詰めた（24 バイト）。`systemctl restart docker` 単体では捕捉 unit は再起動しない（MainPID 不変）ことを実測 | 捕捉は止めずにコピーを解析、連続性を assert、cleanup は drop-in 削除 + daemon-reload を先に。**再実行の結果は下記** |

| 50 | reboot（v6、修正後。`colima restart`、Colima が boot +7 秒で docker を 1 回再起動する環境） | **15 PASS / 0 FAIL / 2 INFO**。observers 20:45:43.77/44.00 → `applied` **44.12** → `Loading containers` **44.20** → 復元後最初の試行 **45.50 `28`**。捕捉は Started 1 回・NRestarts 0。docker は 2 回起動（INFO、各回 ExecStartPre）。外部 observer session 不変、カーソル以降 accept 0、host observer accept 0。boot〜静止の probe ポート SYN **0**。制御: t0 後の SYN **1** ↔ 外部 observer accept **1**（`X-Control`）、host observer 制御 1。backlog は Mac（`ss` 無し）で null → INFO |

### 17.5 残余

- **AL2023 は未実測**。受け入れは本番 host で runner v4 の全モード `failed 0`（外部 observer は VPC 内の別 host で `egress-observer.py`。`ss` があれば backlog も gate になる）
- DNS の出所は Docker 28.3.3 で実測。V6-8 が稼働版で再測定する
- boot 時の tcpdump EACCES（§13.6）は原因未特定（`-Z root` で回避）
- `userland-proxy=false`、IPv6 有効化、`iptables` 以外の backend、任意名 bridge は runner が FAIL にする
- guard の窓は閉じない（運用条件「Router 稼働中に firewall を触らない」）
- 本番 host が reboot 後に docker を再起動する運用（AL2023 では通常無い）は INFO として記録される。各起動で ExecStartPre が規則を入れ直す

### 17.6 成果物

`deploy/egress/`: `subetha-egress`（v6）、`subetha-egress-verify`（v4）、`egress-observer.py`（v2）、`10-subetha-egress.conf`、`99-egress-verify.conf`、
`subetha-egress-guard.{service,timer}`、`egress-host-observer.service`、`egress-boot-capture.service`。`DEPLOY.md` は実装フェーズ。

## 18. 設計レビュー #6（v6、`9f8cdf4`）: **REJECT** → v7 で応答

レビュー実施: 2026-10-02、`gpt-6-astra`。blocking 6 件、non-blocking 2 件。
**policy スクリプトについては「修復後の policy が弱いまま成功を報告する経路は再現できなかった」**。残った指摘はすべて runner/observer の証拠の妥当性。

| # | 指摘（要約） | 判定 | v7 での応答 | 実測 |
|---|---|---|---|---|
| 1 | hammer は exit だけで「curl が走った」ことを示せない（mock で全 curl が 127 でも exit 0）。重なりの判定が整数秒・閉区間で空になり得る | **正しい** | hammer は **curl ごとの exit を記録**（200 本すべて、28 = drop のみ許容、0 = leak と 7/127 = 計測器故障は FAIL）。重なりは **veth 捕捉の SYN の epoch（小数）が再適用ループの [l0, l1] に入っている本数 ≥50** で判定（host の時計、同一 invocation） | 51 |
| 2 | observer の継続性が不十分（host observer は `NRestarts` だけ、外部 observer の session は最初に 1 回しか見ない） | **正しい** | **判定に使う全 report を session に束縛**（`obs_get` は期待 session と違えば ERR）。host observer は boot 以来 **1 invocation**（`MESSAGE_ID` の Started を数える）+ report の `pid` が `MainPID` と一致。評価の**最後に**両 observer の session と両 unit の `InvocationID` を再確認 | 55 |
| 3 | backlog が optional で、`ss` 失敗が null になり、accept() と record() の間に snapshot の競合がある。host observer の backlog を見ていない | **正しい** | observer v3: `backlog` は `{supported, value, error}`、`ss` の失敗を区別。**accept と record を同じ lock の下で**（`select` してから accept するので lock 中に block しない）、report の snapshot は同じ lock を取る。runner は両 observer の backlog 0 を要求（`ss` 無しは `ALLOW_NO_BACKLOG=1` のときだけ INFO。本番は Linux observer）。静止後に **settle**（seq が 1 秒不変）してから数える。probe の禁止フローの conntrack エントリ無しも要求 | 55 |
| 4 | `guard_pause` と cleanup がコマンド失敗を成功扱い | **正しい** | `systemctl stop` の成功 + 両 unit が **exit 3 かつ `inactive`** を要求。cleanup は drop-in 削除 → `daemon-reload` → docker の `Requires` に補助 unit が無いことを確認してから unit を止め、最終状態（unit inactive、docker active、probe 無し、`check`）を assert。復元失敗は runner の exit に反映（trap） | 52、55 |
| 5 | post-boot が静止と再起動境界を検証しない | **正しい** | `docker stop` の成功 + inspect で `Running=false`。prepare で **boot id・observer 設定・session・カーソル**を記録し、post-boot で boot id の変化と設定の一致を要求。順序は `journalctl -o json` の `__MONOTONIC_TIMESTAMP` と `ActiveEnterTimestampMonotonic` で判定（人間向け文字列に依存しない） | 55 |
| 6 | fault injection の失敗が注入した故障に帰属できない | **正しい** | shim は**全呼び出しと拒否を記録**し、runner は「shim が拒否した」「apply の stderr に期待の診断がある」「jump 数が減っていない」を同時に要求。remove の拒否は docker の**全呼び出し**を拒否して「cannot query the Docker daemon」を要求 | 53 |

non-blocking: `remove` は削除/flush の失敗を伝播し、chain と jump の不在を確認してから成功を報告。既存接続試験は `conntrack -L` の成功と**エントリ ≥1** を要求。
「Caddy path」は「Caddy の upstream 経路（end-to-end ではない）」、unit コメントの「atomic」は「family ごとの置換」に改めた。

## 19. 設計 v7（現行。§17 のうち以下で言い直した部分を置き換える）

> 成果物は `deploy/egress/` の v7（スクリプト v7、runner v5、observer v3）。実測 51〜55 は runner v5 の出力。

### 19.1 差分

| 項目 | v7 |
|---|---|
| `subetha-egress remove` | 行番号で削除し、失敗を伝播、chain と全 hook の jump の不在を確認してから `removed` |
| observer v3 | 同期 bind、`/health`、`session`/`pid`/`seq`、`backlog{supported,value,error}`、**accept+record を 1 つの lock で**（`select` → accept → record） |
| runner v5 | session 束縛の report、settle、backlog gate、構造化 journal、boot id、invocation 再確認、hammer の packet-level 証拠、attributable fault injection（shim log）、stop/cleanup の明示的 status、trap で復元失敗を exit に反映、証拠ディレクトリ |
| 運用 | `ALLOW_NO_BACKLOG=1` は試験環境専用（本番 observer は Linux + `ss`） |

### 19.2 実測 51〜55

| # | 実測 | 結果 |
|---|---|---|
| 51 | runner v5 既定モード | **63 PASS / 0 FAIL**。hammer 200/200 curl が走り全て 28、**134 SYN** が再適用ループ窓 [l0, l1] 内（小数秒）、accept 0、host observer backlog 0 |
| 52 | runner v5 `--adversarial`（1 回目） | 55/2: remove 拒否試験が **inspect だけ**を拒否していたため、実 `docker ps -a` が既定名 `subetha-router` の不在を正しく証明して policy を外した（契約どおり、試験が誤り）→ 全 docker 呼び出しを拒否し `ROUTER_CONTAINER` を渡すよう修正 |
| 53 | runner v5 `--adversarial`（修正後） | **57 PASS / 0 FAIL**。fault injection は shim log の REJECT + 診断行 + jump 数不減で帰属。remove は inspect/ps とも拒否で「cannot query the Docker daemon」。guard 停止は両 unit inactive を確認。復元検証 PASS |
| 54 | `--fail-closed` | **3 PASS**（3 回の試行が policy 診断で失敗、未知キー診断あり、復旧） |
| 55 | reboot（runner v5、`colima restart`） | **post-boot 20 PASS / 0 FAIL / 2 INFO、cleanup 1 PASS**。boot id 変化、observer 設定一致、外部 session 不変（カーソル seq 16）、host observer 1 invocation・`pid`=`MainPID`、捕捉 1 invocation。monotonic: observers 3.07/3.30 s → `applied` **3.43 s** → `Loading containers` **3.51 s**。docker は 2 回起動（Colima、INFO）。probe 停止を inspect で確認、settle 後: 外部 accept 0、host accept 0、host backlog 0（外部は `ss` 無し → INFO）、probe フローの conntrack 0、boot〜静止の probe ポート SYN **0**、制御 1 SYN ↔ 1 accept（`X-Control`）、終了時に invocation と session が不変。cleanup: drop-in 削除 → reload → `Requires` 無しを確認 → unit 停止 → 最終状態 PASS |

### 19.3 残余

- **AL2023 は未実測**。受け入れは本番 host で runner v5 の全モード `failed 0`（外部 observer は VPC 内の Linux host で `egress-observer.py`、`ss` あり。`ALLOW_NO_BACKLOG` は使わない）
- DNS の出所は Docker 28.3.3 で実測。V7-8 が稼働版で再測定する
- boot 時の tcpdump EACCES（§13.6）は原因未特定（`-Z root` で回避）
- `userland-proxy=false`、IPv6 有効化、`iptables` 以外の backend、任意名 bridge は runner が FAIL にする
- guard の窓は閉じない（運用条件「Router 稼働中に firewall を触らない」）
- userspace の accept 数と kernel の accept queue（backlog）は「socket 層に受理された接続」の証拠。SYN が届いたが応答されなかったケースは host 側の捕捉（veth の往路のみ・復路なし）と conntrack 不在で見る

### 19.4 成果物

`deploy/egress/`: `subetha-egress`（v7）、`subetha-egress-verify`（v5）、`egress-observer.py`（v3）、`10-subetha-egress.conf`、`99-egress-verify.conf`、
`subetha-egress-guard.{service,timer}`、`egress-host-observer.service`、`egress-boot-capture.service`。`DEPLOY.md` は実装フェーズ。

## 20. 設計レビュー #7（v7、`106ff89`）: **REJECT** → v8 で応答

レビュー実施: 2026-10-02、`gpt-6-astra`。blocking 5 件（すべて runner の失敗処理と証拠の束縛）、non-blocking 2 件。
policy スクリプトは「文書化したトポロジ・目録・同時変更なしの前提の下で、弱い policy のまま成功を報告する新たな経路は見つからなかった」。

| # | 指摘（要約） | 判定 | v8 での応答 | 実測 |
|---|---|---|---|---|
| 1 | EXIT trap が到着時の exit status を捨て、前提拒否（`exit 64/69`）が「0 failed、exit 0」になる | **正しい**（mock で再現） | trap は `rc=$?` を保持し、`rc≠0` なら FAIL 行を出して非 0 で終了。negative test（Router 稼働中の `--adversarial`）を手順に含める | 58 |
| 2 | cleanup が失敗後も「verified」。NAT 削除の失敗が pipeline 内で消える、inspect 失敗が「無い」扱い、`Requires` 取得失敗が「依存無し」扱い、`[` の後の `$?` | **正しい** | 主要操作の status を拾い、最後に**成功した query**で最終状態を証明（nat に別名無し、インタフェースに別名無し、`docker ps -a` に一時コンテナ無し、`Requires` に補助 unit 無し、unit の `is-active` は exit code で判定）。失敗は trap 経由で exit に反映。一部操作（一時コンテナの `rm`、shim 削除、observer 停止）は status を捨て、最終 inventory で補う | 57、61 |
| 3 | 既定モードの外部 observer が session に束縛されていない（`XSESSION` 空） | **正しい** | 既定モードも開始時に `/health` で session を束縛（`bind_observer`）。判定に使う read は session 未設定なら ERR | 56 |
| 4 | accept 数・backlog・制御カーソルを別々の report から取るため、その間に accept が入り得る。hammer や他の 0-accept 判定に backlog gate と正の対照が無い | **正しい** | `obs_verdict` が **1 つの report** から accepts・seq・backlog・listening を返し、0-accept 判定を `zero_accepts`（backlog 0 かつ listening）に統一。hammer に正の対照を追加。**ただし v8 では制御カーソルを別 report から取り直しており、レビュー #8 がその隙間を再現した → v9 で verdict の seq を境界にし、regression を追加** | 56、57、60 → v9 |
| 5 | post-boot の conntrack 判定が、停止後に取った空の probe IP で空振りする | **正しい** | probe の IP は**稼働中に**取得・非空を要求し、停止確認後も保持。文言を「現時点の snapshot」に限定 | 61 |

non-blocking: `remove` の不在判定は「読めない」と「無い」を区別（`No chain` の stderr でのみ不在）。observer は backlog を**同じ lock の中で**読み（queue と log が 1 観測）、listen socket を non-blocking にし（lock 中に accept が block しない）、session にランダム nonce を付与。
hammer の表現は「ループ区間（両端含む）内の SYN」に限定。

## 21. 設計 v8（現行。§19 のうち以下で言い直した部分を置き換える）

> 成果物は `deploy/egress/` の v8（スクリプト v8、runner v6、observer v4）。実測 56〜60 は runner v6 の出力。

### 21.1 差分

| 項目 | v8 |
|---|---|
| runner の終了状態 | trap が到着時の `rc` を保持。`rc≠0`（前提拒否・中断）は FAIL 行 + 非 0。復元失敗も非 0 |
| 既定モード | `OBSERVER` を指定した場合は開始時に `/health` で session を束縛（`bind_observer`）。判定 read は session 未束縛なら ERR |
| 0-accept の判定 | `zero_accepts`: **1 つの report** から accepts=0・backlog 0（`ss` 無しは `ALLOW_NO_BACKLOG=1` のときだけ INFO）・listening を同時に要求。制御接続のカーソルは同じ report の `seq` |
| hammer | 上記に加え、host observer への正の対照（`X-Control` 付き accept ちょうど 1） |
| adversarial / reboot の cleanup | 各操作の status を拾い、最終状態を**成功した query**（nat・インタフェース・`docker ps -a`・`Requires`・`is-active` の exit code）で証明 |
| post-boot | probe の IP を**稼働中に**取得・非空を要求。最終 report から制御カーソルを取る。conntrack 判定は snapshot と明記 |
| negative test | Router 稼働中の `--adversarial` は拒否され、FAIL 行と exit 1（実測 58） |
| `subetha-egress remove` | `No chain` の stderr でのみ「不在」。読めなければ失敗 |
| observer v4 | backlog を snapshot の lock 内で取得、listen socket を non-blocking に、session に nonce |

### 21.2 実測 56〜60

| # | 実測 | 結果 |
|---|---|---|
| 56 | runner v6 既定モード（外部 observer 束縛あり） | **64 PASS / 0 FAIL / 5 INFO**。外部 observer: 1 report で accepts 0・listening（backlog は Mac で `ss` 無し → INFO）。host observer: hammer 中 accepts 0・backlog 0、正の対照 accept 1（`X-Control`） |
| 57 | runner v6 `--adversarial` | **61 PASS / 0 FAIL / 2 INFO**。alias/DNAT の 0-accept は 1 report で backlog 0。復元は fresh query で検証 |
| 58 | negative test: Router 稼働中に `--adversarial` | 「refusing to remove the policy」→ `FAIL V7-0 invocation ended early with exit 64` → **exit 1** |
| 59 | `--fail-closed` | **3 PASS** |
| 60 | runner v6 初版の `obs_verdict` が python の引用符で壊れ、4 件の 0-accept 判定が空の verdict で FAIL した | 空の verdict は **FAIL になる**（成功に化けない）ことを確認した上で修正 |
| 61 | reboot（runner v6、`colima restart`） | **post-boot 20 PASS / 0 FAIL / 2 INFO、cleanup 1 PASS**。boot id 変化、observer 設定一致、外部 session（nonce 付き）不変、host observer 1 invocation・`pid`=`MainPID`、捕捉 1 invocation。monotonic: observers 2.89/3.12 s → `applied` **3.26 s** → `Loading containers` **3.33 s**。probe IP を稼働中に取得（172.30.0.2）、停止を inspect で確認。1 report で外部 accept 0（backlog は Mac で `ss` 無し → INFO）、host accept 0・backlog 0。conntrack 0。boot〜静止の probe ポート SYN **0**。制御: 最終 report のカーソルから 1 SYN ↔ 1 accept（`X-Control`）、host observer も 1。終了時の invocation と session が不変。cleanup は fresh query で検証 |

### 21.3 残余

- **AL2023 は未実測**。受け入れは本番 host で runner v6 の全モード `failed 0`、**`ALLOW_NO_BACKLOG` なし**（外部 observer は VPC 内の Linux host で `egress-observer.py`、`ss` あり）。証拠ディレクトリを保存し、設置した成果物と設定を記録する
- DNS の出所は Docker 28.3.3 で実測。V7-8 が稼働版で再測定する
- boot 時の tcpdump EACCES（§13.6）は原因未特定（`-Z root` で回避）
- `userland-proxy=false`、IPv6 有効化、`iptables` 以外の backend、任意名 bridge は runner が FAIL にする
- guard の窓は閉じない（運用条件「Router 稼働中に firewall を触らない」）
- hammer の「重なり」はループ区間内の SYN の存在であり、各コミットとの重なりではない
- userspace の accept 数 + kernel の accept queue は「socket 層に受理された接続」の証拠。届いたが応答されなかった SYN は host 側の捕捉（往路のみ）と conntrack 不在で見る
- `--reboot-prepare` 後に host が再起動するまでに外部 observer が再起動すると session が変わり、post-boot は FAIL する（意図どおり）

### 21.4 成果物

`deploy/egress/`: `subetha-egress`（v8）、`subetha-egress-verify`（v6）、`egress-observer.py`（v4）、`10-subetha-egress.conf`、`99-egress-verify.conf`、
`subetha-egress-guard.{service,timer}`、`egress-host-observer.service`、`egress-boot-capture.service`。`DEPLOY.md` は実装フェーズ。

## 22. 設計レビュー #8（v8、`2e0a22f`）: **REJECT** → v9 で応答

レビュー実施: 2026-10-02、`gpt-6-astra`。blocking 2 件、non-blocking 2 件、文書の参照訂正 1 件。
v7 の 5 件のうち 1・3・5 は構造的に解決、2 は主要経路が解決、4 は「狭まっただけ」（下記 #1）。

| # | 指摘（要約） | 判定 | v9 での応答 | 実測 |
|---|---|---|---|---|
| 1 | hammer と host-address 試験は `zero_accepts` の report を捨て、**別の report** から制御カーソルを取る。その間に入った accept は数えられない（mock で再現: 2 PASS / 0 FAIL） | **正しい** | `zero_accepts` が判定に使った report の `seq` を `ZA_SEQ` に出し、`control_after` は**その seq 以降**に「accept がちょうど 1 件で `X-Control` 付き」を要求。post-boot も同じ契約。**regression** を adversarial に追加: 判定と制御の間に無印の accept を 1 件入れると gate が拒否することを確認 | 63 |
| 2 | post-boot は `host` 宛て probe の結果を一切 assert していない（`host 3 000` でも 3 PASS）。probe 生成時の `$(gateway_ip)` を検査していない | **正しい** | prepare で gateway を IPv4 として検証し、両 target を記録。post-boot は **deny と host の両方**について「最初の試行が 28、全試行が 28、成功 0、その他の status 0（計測器故障）、試行 ≥1」を要求 | 66 |
| 3 | observer の backlog が同一ポートの別 listener（IPv6 等）の行を拾い得る | 正しい（non-blocking） | `ss -4` で IPv4 に限定し、LISTEN 行が**ちょうど 1**でなければ `unsupported`（曖昧）として扱う | — |
| 4 | cleanup の主張が検査より広い（一部操作の status を捨てる、shim/observer/sabotage 規則の最終確認が無い） | 正しい（non-blocking） | 最終 inventory に shim ディレクトリ・sabotage 規則（`--dport 6500x`）・look-alike chain の不在と observer の **pid ファイル**の不在を追加し、文言を検査した内容に限定。**observer プロセスの終了自体は v9 では確認していない**（レビュー #9 が指摘 → v10 で bounded wait + 注入試験） | — → v10 |
| 5 | §20 の #5 と reboot cleanup の参照が実測 60（python の引用符の件）を指していた（正しくは 61）。#4 の記述が完了を過大評価 | 正しい | §20 を訂正 | — |

non-blocking で取り込んだもの: IMDS **不達**は FAIL（`ALLOW_NO_IMDS=1` は試験環境専用）、probe の identity 取得時に `Running=true` も要求。**ただし v9 は token 取得後の public-ipv4 取得失敗を「公開 IP 無し」と解釈していた**（レビュー #9 の blocking → v10）。
レビュアの結論: 「文書化した前提の下で、`apply`/`check`/`guard` が弱い policy のまま成功を報告する新たな経路は見つからなかった」。

## 23. 設計 v9（現行。§21 のうち以下で言い直した部分を置き換える）

> 成果物は `deploy/egress/` の v9（スクリプト v8 のまま、runner v7、observer v5）。実測 62〜66 は runner v7 の出力。

### 23.1 差分

| 項目 | v9 |
|---|---|
| 0-accept 判定と制御接続 | `zero_accepts` は判定に使った report の `seq` を `ZA_SEQ` に出す。`control_after` はその境界以降に「accept ちょうど 1 件・`X-Control` 付き」を要求。host-address・hammer・post-boot のすべてがこの契約 |
| regression | adversarial で、判定と制御の間に無印の accept を 1 件入れ、gate が拒否することを確認（実測 63） |
| reboot | prepare で gateway を IPv4 として検証し `deny_target`/`host_target` を記録。post-boot は両 target について「最初の試行 28・全試行 28・成功 0・その他 0・試行 ≥1」を要求。probe の identity は `Running=true` も要求 |
| IMDS | 不達は FAIL（`ALLOW_NO_IMDS=1` は試験環境専用） |
| cleanup | 最終 inventory に shim ディレクトリ・observer プロセス・sabotage 規則・look-alike chain の不在を追加。文言を検査内容に限定 |
| observer v5 | backlog は `ss -4` で IPv4 listener に限定、LISTEN 行がちょうど 1 でなければ曖昧として `unsupported` |

### 23.2 実測 62〜66

| # | 実測 | 結果 |
|---|---|---|
| 62 | runner v7 既定モード | **64 PASS / 0 FAIL / 5 INFO**。host-address と hammer の制御: 「判定 report の seq 以降に accept ちょうど 1 件、`X-Control` 付き」 |
| 63 | runner v7 `--adversarial`（Router 停止、代役） | **63 PASS / 0 FAIL / 2 INFO**。**regression**: 判定の後に無印の accept を入れると制御 gate が拒否（seq 以降 2 件）。復元 inventory（shim・observer・sabotage 規則・look-alike chain を含む）PASS |
| 64 | `--fail-closed` | **3 PASS** |
| 65 | runner v7 初版の patch が、v8 で既に書き換えた行を探して**何も書き込まずに**失敗した（空振りの危険） | patch の対象行を実物から取り直して適用。計測器の変更は適用前に `grep` で確認する運用に |
| 66 | reboot（runner v7、`colima restart`） | **post-boot 20 PASS / 0 FAIL / 2 INFO、cleanup 1 PASS**。prepare で target を記録（deny `http://192.168.5.2:19999/`、host `http://172.30.0.1:19998/`）。boot id 変化、設定一致、外部 session 不変、host observer 1 invocation、捕捉 1 invocation。monotonic: observers 3.46/3.69 s → `applied` **3.80 s** → `Loading containers` **3.87 s**。probe identity（`Running=true`）取得後に停止確認。**deny: 52 試行すべて 28、host: 51 試行すべて 28、成功 0、その他 0**。1 report で外部 accept 0（backlog は Mac で `ss` 無し → INFO）、host accept 0・backlog 0。conntrack 0。boot〜静止の probe ポート SYN 0。制御は最終 report のカーソル以降に 1 SYN ↔ 1 accept（`X-Control`）、host observer も 1。終了時の identity 不変。cleanup は fresh query で検証 |

### 23.3 残余

- **AL2023 は未実測**。受け入れは本番 host で runner v7 の全モード `failed 0`、**`ALLOW_NO_BACKLOG` / `ALLOW_NO_IMDS` なし**（外部 observer は VPC 内の Linux host、`ss` あり）。証拠ディレクトリと設置した成果物・設定を保存する
- 注入した cleanup 失敗の試験は未実施（cleanup の失敗伝播はコード検査 + 最終 inventory で担保）
- DNS の出所は Docker 28.3.3 で実測。V7-8 が稼働版で再測定する
- boot 時の tcpdump EACCES（§13.6）は原因未特定（`-Z root` で回避）
- `userland-proxy=false`、IPv6 有効化、`iptables` 以外の backend、任意名 bridge は runner が FAIL にする
- guard の窓は閉じない（運用条件「Router 稼働中に firewall を触らない」）
- hammer の「重なり」はループ区間内の SYN の存在であり、各コミットとの重なりではない
- accept 数と backlog は「socket 層に受理された接続」の証拠であり、packet の到達履歴ではない。届いて応答されなかった SYN は host 側の捕捉（往路のみ）と conntrack 不在（snapshot）で見る
- `remove` の「不在」判定は `No chain` という診断文字列に依存する（ロケールで異なれば保守的に失敗する）

### 23.4 成果物

`deploy/egress/`: `subetha-egress`（v8）、`subetha-egress-verify`（v7）、`egress-observer.py`（v5）、`10-subetha-egress.conf`、`99-egress-verify.conf`、
`subetha-egress-guard.{service,timer}`、`egress-host-observer.service`、`egress-boot-capture.service`。`DEPLOY.md` は実装フェーズ。

## 24. 設計レビュー #9（v9、`41d039b`）: **REJECT** → v10 で応答

レビュー実施: 2026-10-02、`gpt-6-astra`。blocking 1 件、non-blocking 2 件。v8 の 2 件の blocking（制御カーソル、host target）は**構造的に解決**、backlog の束縛も解決。

| # | 指摘（要約） | 判定 | v10 での応答 | 実測 |
|---|---|---|---|---|
| 1 | IMDS の両要求が curl の transport/HTTP status を捨てる。token 取得成功後に `public-ipv4` が timeout すると「公開 IP 無し」の INFO になり、`HOST_ADDRS4=none` が未掲載の公開 IP を持つ host で通る（mock で再現） | **正しい**（blocking） | 両要求で transport と HTTP status を検査。`public-ipv4` は **HTTP 200 + IPv4 として妥当**なら目録と照合、**HTTP 404 だけ**を「公開 IP 無し」の証明とし、それ以外は FAIL。`ALLOW_NO_IMDS=1` は **token 要求自体が到達不能**な場合（非 EC2）だけを INFO にし、token 成功後の失敗は免除しない | 68 |
| 2 | regression が「`fail` が増えた」ことを検出成功と解釈し、`obs_verdict` が `ERR` でも PASS になる | 正しい（non-blocking） | 注入接続と制御接続の HTTP 200 を要求し、**1 つの session 束縛 report** から「accept ちょうど 2 件・うち marked ≥1」を直接 assert。`ERR` は FAIL のまま（v10 では本番の述語そのものは呼んでいない → §26） | 70 |
| 3 | `hobs_stop` が `kill` の失敗を無視し pid ファイルを消すので、「observer gone」が証明されない | 正しい（non-blocking） | `hobs_stop` は pid を保持して **終了を bounded wait（5 秒）で確認**、生き残れば非 0。最終 inventory は pid への `kill -0` 失敗を要求。**注入試験**: SIGTERM を無視するプロセスを observer として登録し、teardown が失敗を報告することを確認（v10 では teardown 1 回分の失敗のみ。停止失敗後に別の observer を起動してしまう経路はレビュー #10 の指摘 → §26） | 70 |

AL2023 の受け入れ条件は変わらず（全モード、Linux の外部 observer + `ss`、免除なし、証拠と設置物の記録）。

## 25. 設計 v10（現行。§23 のうち以下で言い直した部分を置き換える）

> 成果物は `deploy/egress/` の v10（スクリプト v8 のまま、runner v8、observer v5 のまま）。実測 67〜71 は runner v8 の出力。

### 25.1 差分

| 項目 | v10 |
|---|---|
| 公開アドレス目録（IMDS） | token と `public-ipv4` の両要求で transport と HTTP status を検査。`200` + IPv4 として妥当 → `HOST_ADDRS4` と照合。**`404` のみ**「公開 IP 無し」の証明。それ以外（timeout、他の status、不正な本文）は FAIL。`ALLOW_NO_IMDS=1` は token 要求が**到達不能**な場合だけ INFO（非 EC2 の試験環境） |
| regression | 注入接続と制御接続の HTTP 200 を要求し、**1 つの session 束縛 report** から「accept 2 件・marked ≥1」を直接 assert。`ERR` は FAIL |
| observer の終了 | `hobs_stop` は pid を保持し、SIGTERM 後 5 秒以内の終了を `kill -0` で確認。生き残れば非 0（呼び出し側は FAIL）。最終 inventory は保持した pid への `kill -0` 失敗を要求 |
| cleanup 失敗の注入試験 | SIGTERM を無視するプロセス（ハンドラ設置を ready ファイルで同期）を observer として登録し、teardown が失敗を報告することを確認 |

### 25.2 実測 67〜71

| # | 実測 | 結果 |
|---|---|---|
| 67 | runner v8 既定モード | **64 PASS / 0 FAIL / 5 INFO**。IMDS は token 要求が到達不能 → `ALLOW_NO_IMDS=1` で INFO（VM には IMDS が無い） |
| 68 | IMDS gate の分岐（コード） | `200`+IPv4 / `404` / それ以外 / token 不達、の 4 分岐。本番 host での実測は AL2023 受け入れ時 |
| 69 | runner v8 `--adversarial`（1 回目） | 63/1: cleanup 注入試験が**競合**で失敗（python がハンドラを設置する前に SIGTERM が届き、普通に終了した）→ ready ファイルで同期 |
| 70 | runner v8 `--adversarial`（修正後）、`--fail-closed` | **64 PASS / 0 FAIL / 2 INFO**（regression は 1 report で accept 2・marked 1、cleanup 注入は teardown が失敗を報告）、fail-closed **3 PASS**。終了後に observer プロセス残存 0（自分の ssh を除外した pgrep） |
| 71 | reboot（runner v8、`colima restart`） | **post-boot 20 PASS / 0 FAIL / 2 INFO、cleanup 1 PASS**。boot id 変化、設定一致、外部 session 不変（カーソル seq 21）、host observer 1 invocation、捕捉 1 invocation。monotonic: observers 2.54/2.76 s → `applied` **2.90 s** → `Loading containers` **2.97 s**。**deny 52/52、host 52/52 が timeout**、成功 0、その他 0。1 report で外部 accept 0（backlog は Mac で `ss` 無し → INFO）、host accept 0・backlog 0。conntrack 0。boot〜静止の probe ポート SYN 0。制御は最終 report のカーソル以降に 1 SYN ↔ 1 accept（`X-Control`）、host observer も 1。終了時の identity 不変。cleanup は fresh query で検証 |

### 25.3 残余

- **AL2023 は未実測**。受け入れは本番 host で runner v8 の全モード `failed 0`、**`ALLOW_NO_BACKLOG` / `ALLOW_NO_IMDS` なし**（外部 observer は VPC 内の Linux host、`ss` あり。IMDS は token 取得と `public-ipv4` の `200`/`404` が実測される）。証拠ディレクトリと設置した成果物・設定を保存する
- DNS の出所は Docker 28.3.3 で実測。V7-8 が稼働版で再測定する
- boot 時の tcpdump EACCES（§13.6）は原因未特定（`-Z root` で回避）
- `userland-proxy=false`、IPv6 有効化、`iptables` 以外の backend、任意名 bridge は runner が FAIL にする
- guard の窓は閉じない（運用条件「Router 稼働中に firewall を触らない」）
- hammer の「重なり」はループ区間内の SYN の存在であり、各コミットとの重なりではない
- accept 数と backlog は「socket 層に受理された接続」の証拠であり、packet の到達履歴ではない。届いて応答されなかった SYN は host 側の捕捉（往路のみ）と conntrack 不在（snapshot）で見る
- `remove` の「不在」判定は `No chain` という診断文字列に依存する（ロケールで異なれば保守的に失敗する）
- 注入した cleanup 失敗の試験は observer の teardown についてのみ（他の cleanup 操作は最終 inventory で担保）

### 25.4 成果物

`deploy/egress/`: `subetha-egress`（v8）、`subetha-egress-verify`（v8）、`egress-observer.py`（v5）、`10-subetha-egress.conf`、`99-egress-verify.conf`、
`subetha-egress-guard.{service,timer}`、`egress-host-observer.service`、`egress-boot-capture.service`。`DEPLOY.md` は実装フェーズ。

## 26. 設計レビュー #10（v10、`8a57367`）: **APPROVE WITH CHANGES** → 設計フェーズ終了、実装フェーズへ

レビュー実施: 2026-10-02、`gpt-6-astra`。「v10 は v9 の blocking（IMDS）を構造的に解決した。残る 2 件は non-blocking で、
DEPLOY.md の実装フェーズに進むことを妨げない。本番の受け入れ（AL2023）は未了」。
IMDS の 4 分岐（9 ケース）はレビュアが mock で独立に実行し、すべて期待どおり。

| # | 指摘（non-blocking） | 実装フェーズでの変更 |
|---|---|---|
| 1 | `hobs_start` が前の observer の停止失敗を無視して別のプロセスを起動し、`/health` に答えた方を受け入れる。pid ファイルを終了確認前に消す | `hobs_start` は停止失敗で**起動しない**。readiness は report の `pid` が起動した pid と一致することで束縛。pid ファイルは終了確認後に削除。注入試験に「停止失敗 → 起動拒否」を追加 |
| 2 | regression は件数を assert するだけで、本番の制御述語を呼んでいない。report を保存していない | 述語を `control_ok` として本番の `control_after` と regression で**共有**し、regression は「述語が拒否する」ことを assert。report と verdict を証拠ディレクトリに保存 |
| — | IMDS 要求は curl の既定設定や proxy 環境に影響され得る | `curl -q --noproxy '*'`（IMDS から直接の応答だけを証拠にする） |
| — | §24 の実測参照（69 → 70）、observer lifecycle の閉じ方の表現 | 訂正 |

AL2023 の受け入れ条件（変更なし）: 全モード、実 reboot、Linux の外部 observer（`ss`）、`ALLOW_NO_BACKLOG`/`ALLOW_NO_IMDS` なし、
実 IMDS、稼働版での DNS 再測定、証拠と設置物の保存。Caddy の TLS は runner の対象外。要件 §9 の **B + A** の release gate は変わらない。

### 26.1 実装フェーズの成果物

- `docs/DEPLOY.md` §8「egress 制御」（前提、設置、network、検証の実行順、運用規則）、§6 の `docker run` に `--network subetha-router-net`、§9 の参照
- `deploy/egress/subetha-egress-verify`（v9: 上記の変更）
- 実測 72〜74: 変更後の runner で既定 / adversarial / fail-closed を再実行（下記）

### 26.2 実測 72〜74（実装フェーズの runner v9）

| # | 実測 | 結果 |
|---|---|---|
| 72 | 既定モード | **64 PASS / 0 FAIL / 5 INFO** |
| 73 | `--adversarial`（Router 停止、代役） | **65 PASS / 0 FAIL / 2 INFO**。regression は本番の述語 `control_ok` が「accept 2 件」の report を**拒否する**ことを assert（report と verdict を保存）。cleanup 注入: teardown 失敗の報告 + **停止失敗中の再起動を拒否**。復元 inventory PASS、observer プロセス残存 0 |
| 74 | `--fail-closed` | **3 PASS** |

reboot モードは runner v9 で変更していない経路（`hobs_start` は post-boot では使わない）なので再実行していない（実測 71 が現行の証拠）。

### 26.3 実装レビュー #1（`b4d2e06`）: **REJECT** → 手順を改訂

レビュー実施: 2026-10-02、`gpt-6-astra`。runner の変更は承認どおりと判定。**手順（DEPLOY.md）**に blocking 4 件、non-blocking 4 件。

| # | 指摘（要約） | 判定 | 改訂 |
|---|---|---|---|
| 1 | `sudo -E` + 「`failed 0`」だけでは試験用の免除（`ALLOW_NO_BACKLOG`/`ALLOW_NO_IMDS`）が通る | **正しい** | 受け入れ条件に「両方を **unset**」「外部 observer は Linux + `ss`」「証拠ディレクトリ・成果物の commit・env の保存」を明記。手順の最初に `unset` |
| 2 | 設置手順の IMDS 読み出しが runner で直した曖昧さを再現（`${PUB:-none}` が失敗を none に変える） | **正しい** | runner に `--public-ipv4` モードを追加（runner と同じ判定: token → 200 + IPv4 / 404 → none / それ以外は失敗）。手順は失敗で**止める**。既定値で埋めない |
| 3 | 移行手順の `docker rm -f` が journal を消す（§6 の `docker run` に `-v` が無かった） | **正しい** | §6 手順 4 に `mkdir/chown` と `-v /var/lib/subetha-router:/app/runtime` を入れ、移行手順は `docker inspect` で mount を確認し、無ければ `docker cp` で journal を取り出してから削除 |
| 4 | 保守手順が guard を再開せず、アドレス変更の順序も無い | **正しい** | 順序を明記: Router 停止 → timer と service 停止 → 作業（アドレス変更を含む）→ `apply`（check 含む）→ timer 再開と確認 → Router 起動。Router 稼働中のアドレス変更を禁止 |
| 5 | reboot の手順が環境変数を失い、900 秒の期限が無い。`ROUTER`/`HEALTH_URL` の意味 | 正しい | 再起動前後に分け、再接続後の再設定、外部 observer を止めないこと、期限（`CAPTURE_SECONDS` 既定 900 秒）、`ROUTER` はコンテナ名、`HEALTH_URL` は内外から同じ URL の health endpoint（Caddy の TLS ではない）を明記 |
| 6 | 依存パッケージの導入と preflight が無い。network を 2 か所で作る | 正しい | `dnf install -y iptables-nft tcpdump conntrack-tools strace python3 util-linux curl` と `command -v` の preflight。network は §6 手順 4 だけで作り（存在すれば作らない）、§8b.3 は確認のみ |
| 7 | journal の確認が boot 全体から先頭 2 件を取る | 正しい | `_SYSTEMD_INVOCATION_ID` で**その再起動の invocation だけ**を見て、両方のメッセージの順序を確認 |
| 8 | regression が保存するのは評価した report ではなく 2 回目の取得 | 正しい | 1 回だけ取得し、その JSON を保存してから同じ JSON で verdict を導く。保存失敗は FAIL |

実測 75〜77（runner v10）: `--public-ipv4` は IMDS 不達で `IMDS token request failed (ERR transport)`・exit 1（既定値を出さない）。
既定 **64/0**、adversarial **65/0**（保存した verdict `accepts=2 seq=11 backlog=0 listening=True marked=1` が評価した report と一致）、fail-closed **3/0**。
