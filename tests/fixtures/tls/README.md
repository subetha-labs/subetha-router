# 試験用 TLS 素材（実行時に生成。repo には置かない）

SSRF 防御 A の transport 試験（`docs/ssrf-app-guard-design.md` T-A12）で、**証明書検証を有効のまま**
固定した IP への HTTPS 接続を確かめる。素材は `generate.ts` が試験の開始時に `openssl` CLI で一時ディレクトリに作る
（`.gitignore` の `*.pem` / `*.key` に従い、鍵も証明書もコミットしない。試験環境に `openssl` が無ければ T-A12 は失敗する）。

| 生成物 | 内容 |
|---|---|
| `ca.pem` | 試験用 CA（`CN=subetha-router test CA (not for production)`）。transport の `tls.ca` に注入する |
| `provider.test.pem` / `.key` | CA が署名、SAN `DNS:provider.test` |
| `other.test.pem` / `.key` | CA が署名、SAN `DNS:other.test`（ホスト名不一致の試験） |
| `untrusted.pem` / `.key` | 自己署名、SAN `DNS:provider.test`（CA に無い証明書の試験） |

本番コードはこれらを読まない。
