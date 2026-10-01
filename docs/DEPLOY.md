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

# 4) 起動（env ファイルは root 所有 600 なので **sudo が要る**）
sudo docker run -d --name subetha-router --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
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
  それでも、**最も価値の高い標的（IAM 認証情報）を、アプリ側の対策より先に外せる**。

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

  ホスト上の他のエージェントも IMDS を使わないなら、`--http-endpoint disabled` で
  エンドポイントごと閉じる方が強い。Router が使わないことだけでは、その判断の根拠にならない。

  **到達そのものを止める層は別**で、`docs/ssrf-requirements.md` に段階として定めている。
  **アプリ側（fetch 前の検査 + 接続固定）か、インフラ側（`DOCKER-USER` の egress 規則か
  迂回不能な forward proxy）のどちらか**で満たす。**AI が上流 URL を指定できる構成に進む前に**要る。

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
