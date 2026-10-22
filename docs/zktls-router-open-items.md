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

## B-7 V2 担当の 2 回目の返答（2026-10-22）と、Router の受信 fixture が合わせる形
- **`/settle` 応答への `eventId` 追加は V2 側で実装・テスト済み**（subetha-v2 worktree、未コミット = owner の commit 判断待ち）。V2 backend のときだけ `extra` に `{phase: "accepted", settlementKind: "zerc20-v2-burn-sale", policy: "receipt", deliveryKey: <challengeNonce>, receiptLevel: "mined"|"final", txRef: <burnTxHash>, eventId: "<chainId>:<txHash>:<logIndex>", logIndex}`。同じ nonce の再送でも同じ `eventId`。V1 応答は不変。
- T22 live（Sepolia testnet-v2、zETH `0x7E72…eAf0`、2026-10-21 21:34–21:48Z）の応答の形:
  - `POST /challenge {amount}` → `{payTo（= 注文別 burn address）, amount, token, chainId: 11155111, challengeNonce, expiresAt, extra: {settlementKind, policy}}`
  - `POST /verify`（x402 の body。`paymentPayload.payload = {challengeNonce, burnTxHash}`、`paymentRequirements = {scheme: "subetha-zerc20", network: "eip155:11155111", asset, payTo, amount, extra: {challengeNonce}}`）→ `{isValid, payer}`（payer = on-chain の transfer の from）
  - `POST /settle` → `{success: true, transaction: <burnTxHash>, network, extra: {...上}}`。pending は `"pending_burn"`、expired/uncertain は rejected 系。
  - `GET /admin/payments/<nonce>`（admin 認証）→ `V2PaymentStatus`（`packages/facilitator/src/backend.ts` L182–205）: `{state, receipt: {level, tx: {txHash, blockNumber, blockHash, logs: [{logIndex, value}], payer}}, eligible, coins: [{ref, state}], root, intake, release: {policy, state, deliveryKey, authorizedAt}}`。
  - `/supported` は V1 と同形（`scheme subetha-zerc20`、`network eip155:11155111`）。
- 要確認の受け止め: (1)(3)(5)(6)(7) は Router 案で異議なし、(4) は実装済み。(2) 発行時点と (8) token は owner 判断へ（V2 facilitator も policy `receipt` + 運用者の二重明示 + afterRelease の事後計上なので (a) accepted で結合可能。zUSDC を選ぶなら V2 側で先に burn-sale の live を 1 件通す: faucet mint + deposit 15 分 + relayer fee 2.6 USDC は payer 負担）。
- V2 側の境界文書: `subetha-v2/docs/ZERC20-V2-ROUTER-BOUNDARY.md`。

**Router 側の次の増分（owner の 2 判断の後に着手）**: 既存 `src/adapters/inbound/subetha.ts` を秘匿購入の受信に使う。(i) `DynamicProfile.sourceRail` に `subetha` を許し受信 rail の選択を配線、(ii) `private.profiles` の受信検査を `subetha` + `eip155:11155111` + 設定の z token に広げる、(iii) `settle` 応答の `extra.eventId`（形 `<chainId>:<txHash>:<logIndex>` を検査）を `SettleResult.eventId` に写す（無ければ秘匿購入は fail closed）、(iv) `extra.phase`/`receiptLevel` を journal の固定語に、(v) V2 facilitator を模した fixture（上の形）で wire（HTTP/MCP の秘匿購入全経路、`pending_burn`・rejected・eventId 欠落の否定）。(b) settled 待ちの状態新設と zETH の固定換算は別の増分。

## B-8 owner の判断（2026-10-22）
- **(2) 発行時点: accepted**（V1 と同じ。受信 facilitator の `/settle` が receipt mined で成功を返した時点で Router は送信 credential を発行する）。「以前の SubEtha v1 の実装のように accepted で発行の想定でいます。」 発行後の取消（reorg / screening-rejected）は既存どおり送信レグ `unknown`・返金無しとして記録する。settled 待ちの状態新設は行わない。
- (8) token: 未決。Router の増分は受信の network・資産を設定値として扱い、どちらでも載る形で作る（zETH を選ぶ場合は 1:1 の前提が崩れるので、固定換算の設定が別に要る）。

## B-9 V2 担当の追記（2026-10-22）: payer の burn の代替
- V2 の burn-sale は EIP-3009 ではなく「公開 z token を payTo（注文別 burn address）へ `transfer` するだけ」。結合（B-3 の 3）の payer 操作は subetha-v2 側の harness `packages/zerc20-v2-adapter/scripts/live-slice.mjs` の `pos-pay A <payTo> <amount>`（A の ETH を zETH に wrap → transfer → tx hash を出力。T22 の live で使用）で代替できる。zUSDC 版は `mint-usdc` + deposit 済み残高からの transfer を足せば同様。
- 手順案: Router が quote（`/challenge` 相当）で得た payTo を V2 側に渡す → V2 側が `pos-pay` で支払い、tx hash を返す → Router 側（payer 道具）が credential `{challengeNonce, burnTxHash}` を組んで purchase（Router が `/verify` → `/settle`）。`task/subetha-hosted-inbound` の merge を待たずに結合できる。
- Router 側の対応: `tools/private-payer.ts` に「受信 credential を外部で得た burn tx hash から組む」入力（`--burn-tx-hash`。subetha 受信の quote だけ）を足せば足りる（鍵も署名も Router 側に無い。承認対象の burn address・額を V2 側に渡すのは人手）。**owner の判断材料**。

## B-10 V2 担当の確認（2026-10-22）: Router v1.3 が依存する契約と結合の前提
- Router v1.3 が依存する 4 点（`/challenge` の `extra.settlementKind`、`/settle` の `transaction` = burnTxHash、`extra.eventId` の chainId/txHash 整合、同じ nonce → 同じ eventId と 1 tx → 1 challenge）は **V2 facilitator の現実装で満たされている**（台帳 `txOwners`/`evidence`）。V2 側は `subetha-v2/docs/ZERC20-V2-ROUTER-BOUNDARY.md` §5b に同じ文言で記録。
- transport: V2 の `runV2Daemon` は listen host を引数に取るので、**V2 facilitator を loopback 以外のホスト名で公開するのは設定で可能**（`run-v2-local.mjs` は今 127.0.0.1 固定。結合時に host 指定の env を足す。`/admin/*` は token 必須のまま）。
- owner への判断事項は双方同じ 4 点: (1) 発行時点 accepted の本人確認（Router 経由の判断を V2 側が確定扱いにするため）、(2) token、(3) payer の支払い道具、(4) transport（Router 子 = synthetic transport か、非 loopback 公開か）。

## B-11 結合 1 件目（2026-10-22）: 成立
- owner の判断（4 点）→ Router v1.3.1（payer 道具 `--burn-tx-hash`）・v1.3.2（表の行 + `sameAsset`）→ Router 子（synthetic 受信 transport）で V2 facilitator（127.0.0.1:4133、zUSDC V2、merchant D）と結合。paymentId `060fd61f…`、burn `0x8ec7…a831`（logIndex 151）、送信 `0x12be…cf17`、delivered_private。記録は `docs/zktls-router-v2-inbound.md` §11。
- V2 側は Router の `/settle` を accepted で観測、`/admin/payments/<nonce>` の eventId は Router の受信 identity と同値。**settled 07:57:47Z**（支払いから約 13.5 分、receipt final、pending 0 / finalized 2 / failed 0）。両側で close。
- 残り: 実 transport（公開到達可能な V2 facilitator）での再実行、zETH（価格規則）、lab の §A（704 B）、push。

## B-12 結合 2 件目（2026-10-22）: 実 transport で成立
- owner の指示で実合成の Router（試験能力なし）× 公開到達可能な V2 facilitator（run の間だけ ngrok の https トンネル）。paymentId `56c85a2c…`、burn `0x50a0…c197`（logIndex 253）、送信 `0x6956…b8c1`、delivered_private。記録は `docs/zktls-router-v2-inbound.md` §12。コード変更なし。
- zETH は owner の判断で対象外（利用想定なし）。
- V2 側 settled 08:21:21Z（receipt final、pending 0 / finalized 3 / failed 0）。両側で close。
- 残り: lab の §A（704 B）、push。
