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
| `SUBETHA_TEMPO_RPC_URL` | | **推奨。** Tempo の認証付き RPC。未設定だと公開エンドポイントを使い、共有 egress IP からは**レート制限を受けやすい** |
| `SUBETHA_APPROVAL_TTL_SECONDS` | | 承認期限（秒）。既定 `600`。**`SUBETHA_OFFER_SECONDS` と揃える**こと |
| `SUBETHA_JOURNAL_PATH` | | journal の置き場。既定 `runtime/journal.ndjson`。**ボリュームの中を指すこと** |

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
git clone https://github.com/subetha-labs/subetha-router-egt.git
cd subetha-router-egt
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
dnf install -y iptables-nft tcpdump conntrack-tools strace python3 util-linux curl diffutils
for t in iptables ip6tables iptables-restore tcpdump conntrack strace flock python3 curl ss cmp sha256sum awk tar; do command -v $t >/dev/null || { echo "MISSING: $t"; exit 1; }; done

# 1) 成果物（リポジトリの checkout の直下で実行する。sudo は cwd を保つ）
[ -f deploy/egress/subetha-egress ] || { echo "run this from the subetha-router-egt checkout"; exit 1; }
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
名前を付け替え、入口を開け直す。どの段階で失敗しても旧コンテナは残り、作りかけの新コンテナは消され、入口は閉じたまま。
host 上の他のプロセスが `127.0.0.1:8787` を使わないこと（受け入れ runner を同時に走らせない）。

```sh
#!/bin/bash -e
set -o pipefail
R=subetha-router
N=subetha-router-new                                      # 検証中の新コンテナの仮の名前（最後に $R に付け替える）
DEST=/var/lib/subetha-router                              # 新コンテナが mount する場所（§6 手順 4 と同じ）
ENVF=/etc/subetha-router.env
IMAGE=subetha-router
GATE=caddy.service                                        # 127.0.0.1:8787 へ転送する唯一の入口（§7）
NID=""; FINAL=0; STOPPED_GATE=0
cleanup() { rc=$?; rm -f /tmp/journal.peek /tmp/journal.verify
  if [ "$rc" -ne 0 ] && [ "$FINAL" = 0 ]; then
    # このスクリプトが `docker create` で作った新コンテナ（その ID）だけを消す。名前では消さない（前回の残骸や旧コンテナに触らない）
    [ -z "$NID" ] || docker rm -f "$NID" >/dev/null 2>&1 || true
    echo "stopped with exit $rc: the old container is untouched; ingress ($GATE) stays closed (stopped by this script: $STOPPED_GATE). See the recovery notes below the script" >&2
  fi; exit "$rc"; }
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
# コンテナのプロセスが開いているファイルのうち名前が $2 で終わるものを、host の /proc から（コンテナの中の経路のまま）列挙する
openfiles() { local pid; for pid in $(docker top "$1" -o pid | tail -n +2 | tr -d ' '); do readlink /proc/"$pid"/fd/* 2>/dev/null | grep -F -- "$2" || true; done | sort -u; }
# 0) 入口を閉じる。止めて、止まったことと 443/80 に listener が無いことを確認する。既に止まっていればそのまま。
#    成功したときだけ（このスクリプトが止めた場合に）開け直す
if [ "$(systemctl is-active "$GATE" 2>/dev/null || true)" = active ]; then systemctl stop "$GATE"; STOPPED_GATE=1; fi
[ "$(systemctl is-active "$GATE" 2>/dev/null || true)" != active ] || { echo "$GATE is still active"; exit 1; }
[ -z "$(ss -Hltn '( sport = :443 or sport = :80 )')" ] || { echo "something still listens on 443/80:"; ss -Hltnp '( sport = :443 or sport = :80 )'; exit 1; }
echo "ingress closed ($GATE inactive, nothing on 443/80)"
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
J=$(openfiles "$R" .ndjson)
[ "$(printf '%s\n' "$J" | grep -c .)" = 1 ] || { echo "the old Router holds $(printf '%s\n' "$J" | grep -c .) .ndjson files open, expected exactly one:"; printf '%s\n' "$J"; exit 1; }
case "$J" in
  *" (deleted)") echo "the old Router's journal was deleted while open: $J"; exit 1 ;;
  /app/runtime/?*) JP=${J#/app/runtime/} ;;
  *) echo "the old Router has $J open, not a file under /app/runtime: not covered by this procedure"; exit 1 ;;
esac
[ "$(openfiles "$R" /journal.lock)" = "$(dirname "/app/runtime/$JP")/journal.lock" ] || { echo "the old Router does not hold journal.lock next to $J"; exit 1; }
echo "current /app/runtime backing: ${SRC:-<no mount: inside the container>}; the old Router has /app/runtime/$JP open"
#    c. 候補の journal を覗き、その最後の購入を**動いている旧 Router が返す**こと。mount 元の中の symlink は対象外として止まる
if [ -n "$SRC" ]; then
  [ -e "$SRC/$JP" ] || { echo "no journal at $SRC/$JP"; exit 1; }
  [ "$(real "$SRC/$JP")" = "$(real "$SRC")/$JP" ] || { echo "symlink inside $SRC: unsupported layout"; exit 1; }
  PEEK=$SRC/$JP
else
  docker cp "$R:/app/runtime/$JP" /tmp/journal.peek; PEEK=/tmp/journal.peek
fi
LAST0=$(lastcreated "$PEEK")
rm -f /tmp/journal.peek
if [ "$LAST0" != none ]; then
  INNER0=$(inner "$R")
  r4 "$R" "$INNER0" "$LAST0" || { echo "the running Router does not serve $LAST0, the last purchase in the candidate journal: not the journal it uses"; exit 1; }
fi
# 2) Router を止め、止まったことを確認する（コピーは停止後。停止までの追記を取りこぼさない）
docker stop "$R"
[ "$(docker inspect -f '{{.State.Running}}' "$R")" = false ]
# 3) 実体から $DEST へ写し、journal が元と同じバイト列であることを**別の読み出し**で確認する（どれが失敗しても終了）。
#    $DEST に**内容の違う** journal が既にあれば上書きせずに止まる（前の試行で何かが書いた可能性。journal.lock は flock 用の常設ファイルで、写しても害は無い）
mkdir -p "$DEST"
if [ -n "$SRC" ]; then
  if [ "$SRC" != "$DEST" ]; then
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
[ -f "$DEST/$JP" ]
[ "$(real "$DEST/$JP")" = "$(real "$DEST")/$JP" ] || { echo "symlink inside $DEST: unsupported layout"; exit 1; }
# 4) 旧配置（21155eb より前の image は journal を runtime/remote-*/ の下に置いた）なら止まる。走査自体の失敗も止まる。
#    行数・内容・最後の購入は、起動前の複製（元と同じバイト列）から取る
LEGACY=$(find "$DEST" -mindepth 2 -name journal.ndjson ! -path "$DEST/$JP")
[ -z "$LEGACY" ] || { echo "legacy layout: $LEGACY. Recover it separately; nothing was removed"; exit 1; }
ROWS=$(wc -l < "$DEST/$JP"); SUM=$(sha256sum < "$DEST/$JP"); LAST=$(lastcreated "$DEST/$JP")
[ "$LAST" = "$LAST0" ] || { echo "the copy's last purchase is $LAST but the candidate's was $LAST0"; exit 1; }
# 5) 新コンテナを**最終構成のまま**仮の名前で作って起動する（§6 手順 4 と同じ引数。旧コンテナは止まっているのでポートは空いている。
#    入口は閉じているので外からは届かない）。起動時の replay 全部（journal の検査、intent の同一性、予算）を通って上がること、
#    Docker が解釈した env の journal の場所と、プロセスが実際に開いているファイルが /app/runtime/$JP そのものであること、
#    最後の購入を R4 で返すことを、旧コンテナを消す前に確かめる
docker network inspect subetha-router-net >/dev/null 2>&1 || \
  docker network create --driver bridge -o com.docker.network.bridge.name=subetha0 subetha-router-net
NID=$(docker create --name "$N" --restart unless-stopped --network subetha-router-net -p 127.0.0.1:8787:8787 \
  -v "$DEST:/app/runtime" --env-file "$ENVF" "$IMAGE")
docker start "$NID" >/dev/null
for i in $(seq 1 60); do H=$(curl -sf http://127.0.0.1:8787/healthz 2>/dev/null || true); [[ "$H" == *'"router":"up"'* ]] && break; [ "$(docker inspect -f '{{.State.Running}}' "$NID")" = true ] || break; sleep 1; done
[[ "$H" == *'"router":"up"'* ]] || { echo "the new container did not come up on the copied journal:"; docker logs "$NID" 2>&1 | tail -n 20; exit 1; }
NEWJ=$(docker inspect "$NID" --format '{{range .Config.Env}}{{println .}}{{end}}' | { grep '^SUBETHA_JOURNAL_PATH=' || echo 'SUBETHA_JOURNAL_PATH=runtime/journal.ndjson'; } | tail -n1 | cut -d= -f2-)
[ "$(norm "$NEWJ")" = "$JP" ] || { echo "as Docker read $ENVF, the new container's SUBETHA_JOURNAL_PATH=$NEWJ is not /app/runtime/$JP"; exit 1; }
JN=$(openfiles "$NID" .ndjson)
[ "$JN" = "/app/runtime/$JP" ] || { echo "the new container has '$JN' open, not /app/runtime/$JP"; exit 1; }
[ "$(openfiles "$NID" /journal.lock)" = "$(dirname "/app/runtime/$JP")/journal.lock" ] || { echo "the new container does not hold journal.lock next to its journal"; exit 1; }
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
echo "all checks passed: the new container serves the migrated journal ($ROWS rows, last purchase $LAST). Removing the old container, renaming, reopening ingress"
# 6) ここで初めて旧コンテナを消し、新コンテナを $R に付け替え、入口を開け直す（ここから先で止まっても新コンテナは残る）
FINAL=1
docker rm "$R"
docker rename "$NID" "$R"
[ "$(docker inspect -f '{{.Id}}' "$R")" = "$NID" ]
H=$(curl -sf http://127.0.0.1:8787/healthz); [[ "$H" == *'"router":"up"'* ]]
if [ "$STOPPED_GATE" = 1 ]; then systemctl start "$GATE"; [ "$(systemctl is-active "$GATE")" = active ]; echo "ingress reopened ($GATE active)"
else echo "ingress ($GATE) was not active when this script started: left as is"; fi
echo "migration complete: $ROWS journal rows reopened by the new container"
```

止まる条件（どれも旧コンテナを消さず、作りかけの新コンテナは消し、入口は閉じたまま）: 入口が閉じない（Caddy が止まらない、443/80 に
listener が残る）、旧 Router が動いていない、前回の `subetha-router-new` が残っている、`/app/runtime` と重なる別の mount、bind / ボリューム
以外の mount、旧 Router が開いている `.ndjson` が 1 つでない・`/app/runtime` の下でない（symlink や `..` で別の場所に解決されている）・
消されている、隣の `journal.lock` を開いていない、mount 元や複製の中の symlink、mount 元に journal が無い、候補の最後の購入を旧 Router が
返さない、`$DEST` に内容の違う journal が既にある、コピーや再読み出しの失敗、元と複製の不一致、旧配置（`remote-*/` の下に journal）、
走査の失敗、**最終構成で起動した新コンテナが上がらない**（Router の起動時の replay が拒む: 改行の無い末尾、JSON でない行、`seq` の飛び、
欠けた項目、paymentId / quoteId の重複、予算）、Docker が解釈した新コンテナの env の journal の場所が旧と違う、新コンテナのプロセスが
開いている journal が旧と違う、元の行が変わっている、flock の保持者が新コンテナでない、新コンテナが最後の購入を返さない。

**止まった後の復旧**（入口は閉じたまま。先に状態を見る）:
- 手順 5 までで止まった場合、新コンテナは消えている。`$DEST` に journal が残っていれば、旧 Router の journal と比べる
  （`cmp /var/lib/subetha-router-old/... /var/lib/subetha-router/journal.ndjson` の要領。同じなら消してよい。
  `"event":"unknown"` かつ `"reason":"interrupted_at_restart"` の行が後ろに足されているだけなら、新コンテナの起動が足したもので、
  消してよい。それ以外の行が増えていたら、旧 journal に無い記録なので消さずに調べる。入口が閉じていればこれは起きない）。
  旧 Router に戻すなら `sudo docker start subetha-router` → `/healthz` → `sudo systemctl start caddy`。直して再実行するなら
  旧 Router を起動してから（スクリプトは動いている旧 Router を要求する）。
- 手順 6 に入ってから止まった場合（`all checks passed` の後）は、新コンテナがもう動いていて記録も開いている。残っている旧コンテナを
  `docker rm` し、`docker rename subetha-router-new subetha-router` し、`sudo systemctl start caddy` して終える。

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
