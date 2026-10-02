# 試験用 TLS 素材（本番コードは読まない）

SSRF 防御 A の transport 試験（`docs/ssrf-app-guard-design.md` T-A12）で、**証明書検証を有効のまま**
固定した IP への HTTPS 接続を確かめるための自己署名の素材。有効期間 10 年、鍵は試験専用。

| ファイル | 内容 |
|---|---|
| `ca.pem` | 試験用 CA（`CN=subetha-router test CA (not for production)`）。transport の `tls.ca` に注入する |
| `provider.test.pem` / `.key` | CA が署名、SAN `DNS:provider.test` |
| `other.test.pem` / `.key` | CA が署名、SAN `DNS:other.test`（ホスト名不一致の試験） |
| `untrusted.pem` / `.key` | 自己署名、SAN `DNS:provider.test`（CA に無い証明書の試験） |

生成（再生成するときはこの手順で。EC P-256）:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -days 3650 \
  -subj "/CN=subetha-router test CA (not for production)"
for n in provider.test other.test; do
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout $n.key -out $n.csr -subj "/CN=$n"
  printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\n' "$n" > $n.ext
  openssl x509 -req -in $n.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out $n.pem -days 3650 -extfile $n.ext
done
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout untrusted.key -out untrusted.pem \
  -days 3650 -subj "/CN=provider.test" -addext "subjectAltName=DNS:provider.test"
```

`ca.key` は含めない（署名し直す必要があれば上の手順で CA ごと作り直す）。
