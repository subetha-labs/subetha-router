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
