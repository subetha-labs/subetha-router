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

## B-5 V2 担当（セッション `subetha-v2-0c`）からの回答（2026-10-22、セッション間メッセージ。要約。原文は `.claude_workflow/local/zktls-v2-boundary-20261022.md`）
- V2 側の実機（Sepolia testnet-v2、`@zerc20/wallet-sdk` 0.4.0）: (a) receive code 宛 private send、(b) PointOfSale の注文別 burn address（burn-sale）への公開 z token 支払い、(c) 既存 SubEtha facilitator の HTTP 面（`/challenge → /verify → /settle → /admin/finalize`）に (b) を載せた accepted → settled、をいずれも live 確認済み。
- **B-1 の 4 行は burn-sale 経路なら満たせる。receive code 宛 private send は注文 binding が現 SDK で満たせない**（`activity()` の received に `via: null`、`send()` に memo/reference 無し。zERC20 チームへ確認中）。
  1. 注文 binding: burn-sale は 1 challengeNonce = 1 sale（Sale.id = burn address）。`/challenge` は routeBinding を受けないので、Router 側 adapter が routeBinding ↔ challengeNonce を保持する案（facilitator の echo 拡張も可）。
  2. 支払い identity: txHash と `(chainId, txHash, logIndex)`（facilitator 台帳に保存、再起動後も同じ値）。nullifier は spend 時にしか出ない。提案 `zerc20-v2-burn-sale|eip155:11155111|<txHash>|<chainId>:<txHash>:<logIndex>`。
  3. 確定状態: POS confirming → chain final → ASP screening → approved → proved root 被覆で spendable。facilitator の `/settle` は receipt success（mined）で **accepted**（policy `receipt` を運用者が二重明示したときだけ）、finalize ループで **settled**。実測: burn-sale の settled まで約 13 分（ASP 600 s 含む）。取消: reorg（`afterRelease: "reorged"`）、ASP rejected（`"screening-rejected"`）、復元時の `"uncertain"`。通知は `GET /admin/payments/:nonce`（admin 認証・ポーリング）のみ。V2 の意見: 発行は初期は settled を既定、accepted は少額かつ運用者明示のみ。
  4. 再利用・返金: 受領 private 残高は店舗 wallet の coin（送信レグの公開 USDC には直接ならない）。返金請求者の認証は V2 に無い → Router 側の責任。`refundOnFailure: false` 維持に賛成。
- B-3: 1 は「注文別 burn-sale への支払い → 受領確定」に定義変更すれば V2 側は済（T21/T22）。2（Router の偽受信 rail）の先行着手に賛成、受領通知の形は `V2PaymentStatus`（`packages/facilitator/src/backend.ts`）。3 は `apps/facilitator/scripts/run-v2-local.mjs`（port 4132、Sepolia zETH）で V2 facilitator を起動可能、**zETH** での検証を提案。
- 要確認 8 件: (1) routeBinding の格納場所 (2) 発行時点 accepted/settled (3) 通知の認証 (4) identity の名前と `/settle` 応答の logIndex (5) 取消通知時の Router 側状態 (6) receive code 経路の扱い (7) 返金の責任分界 (8) 検証 token。

## B-6 Router 側の立場（返信、2026-10-22。owner の判断が要る点は **owner** と記す）
前提として **Router には既に SubEtha facilitator の HTTP 面に載る受信 adapter がある**（`src/adapters/inbound/subetha.ts`、scheme `subetha-zerc20`、`/challenge → /verify → /settle`、offer の `extra.routeBinding` と `challengeNonce`、hosted の静的 route で zUSDC の受入済み）。V2 の burn-sale はこの adapter にほぼそのまま載る。秘匿購入に使うための差分は次の 4 つ。

| 要確認 | Router の立場 |
|---|---|
| (1) routeBinding | **Router 側で持つ**（今の subetha adapter と同じ: offer の `extra.routeBinding` に Router が載せ、credential の `accepted` が同じ offer（challengeNonce・routeBinding・全欄）であることを `preflight` で照合）。facilitator の echo は不要 |
| (4) identity | Router の形は `${sourceRail}\|${network}\|${txRef}\|${eventId}`。`sourceRail` は Router の rail 名 `subetha`（adapter の既存名）、`txRef` = burnTxHash、`eventId` = `<chainId>:<txHash>:<logIndex>`。**`/settle` の応答（`extra`）に logIndex を出してほしい**（Router は settle の応答から `eventId` を取る。別 API の読取は要らない。無ければ秘匿購入は fail closed） |
| (2) 発行時点 | **今の Router は settle が同期で返る前提**（purchase の HTTP 1 回の中で verify → settle → 発行 → 引き渡し。入口の期限は要求 1 件 120 s）。したがって (a) accepted（receipt mined、数秒）で発行なら既存の流れに載る。(b) settled（約 13 分）で発行するには、Router に「受信待ち」の状態（purchase は受付で返し、settled の通知で発行、Payer は status で handover を受ける）を**新設**する必要がある = 別の増分。Router の提案: testnet の最初の結合は (a)（運用者の明示フラグ + 少額）で行い、`afterRelease`（reorg / screening-rejected）は発行後なら既存の `unknown`（返金無し）、発行前なら `paid_undelivered`。(b) は次の増分として設計。**owner** |
| (3) 通知の認証 | Router は受信の確定を settle の同期応答で読む（(a) なら追加の通知は要らない）。(b) に進むときは、admin token の共有ではなく **challengeNonce の知識 + Router の merchant 認証で読める読取 API**（`GET /payments/:nonce` 相当）を希望。webhook は不要（Router はポーリングで十分） |
| (5) 取消 | 発行前（settle の前）に取消 → `paid_undelivered` 相当（受信は成立していない）。発行後 → 既存どおり `unknown`（送信 credential は Payer に渡っている。返金無し）。Router の journal に `afterRelease` の種類を固定語で書く（新規コード） |
| (6) receive code 経路 | zERC20 の回答待ちでよい。burn-sale で先に通す。注意: burn-sale は payer が tx sender として公開される（方針書 §4.2 の「受取人への payer 開示」とは別に、公開台帳にも出る） |
| (7) 返金 | `refundOnFailure: false` のまま。Router は返金しない（既存どおり）。返金請求者の認証は本増分の対象外 |
| (8) token | Router の動的プロファイルは受信資産と送信資産を **1:1（`par: true`）** とみなす。zUSDC → USDC なら成り立つが、**zETH → USDC は換算規則が無い**（Router に FX は無い）。Router の提案: 最初の結合は zUSDC（par が成り立つ。relayer fee 2.6 USDC/回は payer の testnet コスト）、zETH は「プロファイルごとの固定換算」を設定に足す別の増分。**owner** |

Router 側の次の着手（B-3 の 2、V2 の賛成あり）: 既存 `subetha.ts` を秘匿購入の受信に使えるようにする増分（`DynamicProfile.sourceRail` に `subetha` を許す、`private.profiles` の受信検査を V2 の network/資産に広げる、`settle` の応答から `eventId` を取る、`afterRelease` の固定語）と、V2 facilitator を模した fixture（`V2PaymentStatus` の形）での wire。要件・設計を短く書いて Codex レビューの後に実装する。
