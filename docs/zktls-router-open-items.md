# zkTLS 秘匿購入: 他担当への確認事項（2026-10-22）

本書は Router 担当（このリポジトリ）から、(A) zkTLS lab の担当と (B) zERC20 V2 決済側の担当へ、**本人経由で**渡す確認事項をまとめたもの。
相手の worktree は変更しない。API を一方的に確定しない。根拠は `docs/zktls-router-thirdparty.md` §9/§9.1（第三者 Provider での実測）と設計 §14.7。

## A. zkTLS lab（`subetha-zktls-router` worktree `private-payment-binding-20261017`、phase3/phase5）への確認

### A-1 有料応答の上限 704 B（`MAX_PAYLOAD`、`phase3/runner/src/types.rs`）
- **実測**: 第三者 Provider 5 件の有料応答は 91 B・214 B・326 B（×2）が通り、938 B（genesisblock `/api/joke` の `{data, meta}` 封筒）が `body length 938 outside circuit bounds (1..=704)` で落ちた（両レグ決済済み、返金無し）。CDP の公開一覧で Base Sepolia の GET 候補 38 ホストのうち、応答が 704 B に収まるかは**払うまで分からない**（事前検査では見えない）。
- **確認したいこと**:
  1. 704 B の根拠（回路の固定サイズ = `ciphertext[720]`/`payload[704]`、`CT_LEN`、`BLINDER_LEN`）と、これを 2 KiB・4 KiB 級へ広げたときの影響（証明生成時間、検証時間、SRS の大きさ、`MAX_RECV_DATA` 16 KiB との関係、bundle の大きさ → Router 側 `maxBundleBytes` 256 KiB・`maxRecordBytes` 64 KiB）。
  2. 可変長（複数ブロックの配送証明）にする案の実現性と、公開入力の変更点（Router の `checkAttest` は `payload_len === record.body_len` と `content_length` を照合している）。
  3. 変える場合のバイナリの sha256 の更新手順（Router は起動時に `deliveryBinSha256`/`srsSha256` を照合する。設定で切り替え可。両バージョンの並存は想定していない）。
- **Router 側の前提**: バイナリは変更しない・複製しない（要件 §2）。上限が変わればプロファイルの `limits.maxResponseBytes` の開示（quote の `private.limits`）と事前検査の説明文を追従させる。

### A-2 応答の framing（`Transfer-Encoding: chunked` の拒否）
- Vercel 系の host は 402 を chunked で返した（有料応答も chunked の可能性が高い）。chunked を受け付ける予定の有無（受け付けないなら、事前検査の「402 が chunked」を**不適合の兆候**として扱う）。

### A-3 TLS 1.2 の 2 suite
- 56 ホストの未払い probe はすべて `ECDHE-{ECDSA,RSA}-AES128-GCM-SHA256` で handshake できた。現時点で障害にはなっていない（参考情報）。

## B. zERC20 V2 決済側（別 worktree、別担当）との接続境界（案。確定ではない）

### B-1 Router の受信レグが要るもの（現在の x402 受信の契約から）
Router の受信 rail は `src/ports/inbound.ts` の `InboundRail` で、秘匿購入はこの上に載る（`docs/zktls-router-design.md` §3.2）。V2 の private 都度払いを受信レグにする場合、次の 4 点の対応物が要る。

| Router 側の要素 | 今（x402 Base Sepolia USDC） | V2 で決めたいこと |
|---|---|---|
| 注文 binding（`routeBinding`、`private\|<profileId>\|<METHOD>\|<url>\|<intentSha256>`） | 受信 offer の `extra.routeBinding` に載せ、credential が同じ offer を指すことを `preflight` で照合 | V2 の支払いに「この注文のための支払い」を結び付ける場所（Receive Code / reference / memo のどれか）。時刻・金額・自己申告 payer だけの推測照合はしない |
| 支払い identity（`txRef` + `eventId`、FR-Z06 (b) の一意性） | `txRef` = settle の tx、`eventId` = EIP-3009 の authorization nonce | V2 で「同じ受領を二度数えない」ための識別子（nullifier？ 受領イベント id？）。これが無いと秘匿購入は fail closed（`private_inbound_identity_missing`） |
| 確定状態（`verify` → `settle` → `settled`） | facilitator の `verify`（署名・残高）と `settle`（tx 実行）。settle 後にだけ送信 credential を発行 | V2 の `paid` / `confirmed` / `Ready` のどこで「受領成立」とみなして送信 credential を発行するか（方針書 §6.2・§5.5）。**受領通知を無条件に finalized へ変換しない** |
| 再利用可否・返金先 | 返金無し（`refundOnFailure: false`）。`unknown` は「払ったかもしれない」 | 受領した private 残高の扱い、失敗時の返金経路（あれば）と、返金請求者の認証 |

### B-2 Router 側の制約（変えない前提）
- 送信レグは Router の公開資金（Base Sepolia USDC 等）で払う。V2 で受けた資金をそのまま第三者 Provider に渡せるわけではない（方針書 §5.5）。
- 受信が private でも、Router は利用先（host・path）・料金・時刻を知る。本文は見ない（秘匿購入の範囲）。
- 発行予約（intent の一意性 + 受信 identity の一意性）は journal に fsync してから署名する。V2 の受領が「後から取り消され得る」なら、取り消しの通知と Router 側の扱い（`unknown` のまま）を決める。

### B-3 最小の共同検証（方針書 §5.5 の 3 点に合わせた案）
1. V2 側で「注文 reference 付きの private send → 受領確定」を 1 件示す（Router 不要）。
2. Router 側で、受領確定の通知（形は B-1 の表）を受ける**偽の受信 rail** を試験で作り、秘匿購入の経路（発行 → MPC-TLS → attest）がそのまま動くことを示す（lab wire の拡張。資金は動かない）。
3. 両者をつないで testnet で 1 件（受信 V2 private、送信 x402 Base Sepolia、Provider は自社 A か第三者 tollbooth）。

### B-4 本人に確認したいこと
- B-1 の表を V2 担当に渡してよいか（Router 側の用語で書いてあるので、V2 側の用語との対応は相談で決める）。
- 共同検証の順序（B-3）と、Router 側で先に作れる 2 の着手可否。
