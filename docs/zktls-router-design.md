# zkTLS 秘匿要求 Router（private purchase）設計 v5.1

要件: `docs/zktls-router-requirements.md` v3.3。対象 worktree `subetha-router/zktls-router-20261020`（branch `task/zktls-router`、基点 `origin/main` `f4eb0ca`）。
設計フェーズの成果物であり、実装は含まない。v1 は Codex の独立レビュー（`.claude_workflow/local/zktls-design-review1.md`、REJECT、blocking 9・should 4）を受けて v2 に、v2 のレビュー（`zktls-design-review2.md`、REJECT、残 8・新規 2）を受けて v3 に、v3 のレビュー（`zktls-design-review3.md`、REJECT、残 4・新規 1）を受けて v4 に、v4 のレビュー（`zktls-design-review4.md`、REJECT、残 2・新規 2）を受けて v5 に改めた。v5 のレビュー（`zktls-design-review5.md`、**APPROVE WITH CHANGES**、should 2・minor 1）の修正を v5.1 に入れた（§13 に対応表）。
既存の設計（`docs/design.md`、`docs/dynamic-upstream-design.md`、`docs/dynamic-upstream-post-design.md`、`docs/multirail-outbound-design.md`、`docs/dynamic-gas-fee-design.md`）
を変えずに **別の口・別の core・別の adapter 面** を足す。既存コードの変更は最小の接続点（§10）に限り、既存の口の挙動と journal の形は不変（golden）。

## 1. 役割とシーケンス

```
Payer (executor = MPC-TLS prover)        Router (inbound + issuer + Verifier)                 Provider
──────────────────────────────           ────────────────────────────────────                 ────────
1 intent 封筒を作る (payer-keygen → §5.1 の封筒)
2 POST /v1/private/quotes {profileId, requestId, intentB64}
                                         ─ 封筒バイト列を検査・保存, sha256 → routeBinding
                                         ─ 本文に依存しない未払い探り (GET / POST "{}") ───────▶ 402
                                         ◀─ challenge (terms) ─────────────────────────────────
                                         ─ プロファイル規則で offer を選び、価格 (上流額+手数料。Tempo は cap)
                                         ─ 受信 offer を発行、quote 文書 + private 欄 + ownerKey を返す
3 承認 → 受信 credential を作る (sign)
4 POST /v1/private/purchases {quoteId, requestId, approval, credential, ownerKey}
                                         ─ 容量予約 → preflight → 探り再照合 → 残高 → verify → 昇格 → settle (既存の動的の段をそのまま)
                                         ─ 探り再照合 (2 回目) + 承認期限 → 発行予約 (intent 一意 + 受信支払い一意) を journal に fsync
                                         ─ issueCredential (送らない。x402: 署名 / Tempo: pull 署名) → ヘッダ検査 → 寿命検査
                                         ─ release バイト列 → journal → 作業ディレクトリに最終注文/intent/release → verifier-serve 起動
                                         ─ journal `private_handed_over` → 応答
                                         ◀─ {verifier.address, releasedHeader, headerFile, releaseB64, deadlines}
5 payer-finalize-order (intent + headerFile)
6 executor-session ──── MPC-TLS ────────▶ Verifier ◀══════ TLS (prover が接続) ═══════════════▶ Provider
                                         ─ record.json (公開 prefix・ハッシュ・応答ヘッダ)         (verify → settle → 200 + 領収)
7 executor-prove → bundle
8 POST /v1/private/purchases/{id}/attest {bundleB64, ownerKey}
                                         ─ 受付手順 (§3.4) → verifier-verify (record + bundle) → FR-Z08 の検査 → 領収
                                         ─ journal: private_attested (delivered_private) / unknown
9 GET /v1/private/purchases/{id}/record ◀─ {recordB64, releaseB64, recordAvailableUntil} (保持期限まで何度でも。取得で削除しない)
10 payer-decrypt (bundle + record + intent + release) → 応答平文は Payer だけが得る
```

Router が見るもの: intent（commitment を含む）、402 ヘッダ（探り）、受信 credential、bundle（証明・公開入力）、record（公開 prefix・ハッシュ・応答ヘッダ）。
見ないもの: 本文、salt、穴の nonce、Payer 鍵、応答本文、復号鍵（FR-Z10）。

## 2. 公開契約（HTTP。MCP は同じ操作の薄い包み §8）

| 操作 | HTTP | 入力 | 出力 |
|---|---|---|---|
| private quote | `POST /v1/private/quotes` | `{profileId, requestId, intentB64}`。`intentB64` は Payer が作った封筒の**正確なバイト列**の base64（標準 alphabet、padding あり）。復号後 ≤ `maxIntentBytes`（既定 2048 B。符号化長 ≤ 2732 字）。Router は復号したバイト列を保存し sha256 を取る（再直列化しない）| 既存 dynamic quote 文書 + `private` 欄（§2.1）+ `ownerKey` |
| private purchase | `POST /v1/private/purchases` | `{quoteId, requestId, approval, credential(base64), ownerKey}` | 200 `{paymentId, status:"awaiting_session", verifier:{address}, releasedHeader:{name,value}, headerFile:{order_id,intent_sha256,name,value}, releaseB64, release, deadlines:{credentialExpiresAt, sessionBy}}`（§2.2）。失敗は既存の `status`/`code` 体系（§8.1 の写像）|
| attest | `POST /v1/private/purchases/{paymentId}/attest` | `{bundleB64, ownerKey}`（bundle は executor の `bundle.json` バイト列）。本文上限 `MAX_ATTEST_BODY_BYTES = 4096 + ceil(maxBundleBytes × 4 / 3)`（既定 ≈ 354 KiB）。復号後 ≤ `maxBundleBytes` | 200 `{paymentId, status:"delivered_private" \| "unknown", terminalReason?, private}`、409 `attest_not_ready` / `attest_in_progress` / `attest_closed` / `attest_expired`、429 `private_capacity`、404 |
| record | `GET /v1/private/purchases/{paymentId}/record`（`x-router-owner-key`）| — | 200 `{paymentId, recordB64, releaseB64, recordAvailableUntil}`。所有者でない・無い → 404 `not_found`; 所有者で record 未完成 → 409 `record_not_available`; 保持期限切れ → 410 `record_expired` |
| status | 既存 `GET /v1/purchases/{paymentId}`（`x-router-owner-key`）| — | 既存射影 + `private` 欄（§7.3）|

認証: 既存の principal トークン。`ownerKey` は動的購入と同じ（`sha256:` ハッシュを記録に保存し、提出値を一定時間比較）。purchase・attest・record・status のすべてで所有 principal と
`ownerKey` の一致を要求し、合わなければ**存在しないのと同じ応答**（404）。HTTP の `MAX_BODY_BYTES`（16 KiB）は attest だけ `MAX_ATTEST_BODY_BYTES` に広げる（他の口は不変）。
符号化長の上限（HTTP）と復号後の上限（core）を別に検査し、どちらも固定コードで拒否する（`intent_too_large` / `bundle_too_large`）。

### 2.1 quote の `private` 欄（承認対象。FR-Z14）
```
private: {
  intentSha256, orderId, payerPk: {x, y}, target: {host, port: 443, path}, method, framing,
  body: {len, commitmentHex},                       // GET は {len: 0, commitmentHex: ""}
  outbound: {rail: "x402"|"mpp", mode: "sign-only"|"pull", network, asset, payTo, amount, fundsMoveAt: "provider_paid_request"|"provider_broadcast"},
  inbound:  {rail: "x402", network, asset, payTo, total, fee, fundsMoveAt: "router_purchase_settle_before_issuance"},
  policy:   {minCredentialLifetimeMs, sessionTimeoutMs, attestTimeoutMs, retentionMs},   // 長さ（方針）。絶対時刻は確定した時点で射影に載る（§7.3）
  limits:   {maxSentBytes: 4096, maxBodyBytes: 512, maxResponseBytes: 704, maxHeaderValueBytes: 2048|3072, maxPathBytes: 256,
             tls: {version: "TLSv1.2", cipherSuites: ["TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"], responseFraming: "content-length-identity-single-response"}},
  disclosures: {noRefund: true, unknownPossible: true, verifierLoopbackOnly: true, deliveredPrivateMeaning: "verified delivery to payer_pk, not human receipt"}
}
```
`approval.deadlineMs`（絶対時刻）は既存どおり。期限 3 種（FR-Z15）のうち quote 時点で確定できるのは**方針の長さ**だけなので承認対象には長さを示し、
確定した絶対時刻（`credentialExpiresAt`・`sessionBy`・`attestBy`・`recordAvailableUntil`）はそれぞれ確定した journal 行に永続化して射影に載せる（要件 v3.3 FR-Z15・FR-Z11）。
**承認した方針は quote の記録に写す**（`private.policy`・`private.limits`。§7.2）: 以後の期限はすべて**記録の方針**から導き、設定の変更は purchase 前の指紋の照合（§3.2）で検出する。
**購入口**: 秘匿 quote の文書の `resource` は `{url: "<base>/v1/private/purchases", method: "POST"}`（既存の動的 quote の `GET /v1/routes/{id}/resource` ではない）。client（§8.2）は
この組を承認した購入口として照合する。秘匿 quote の文書は `privateQuoteBody`（§8.1）が明示的に組み、動的の文書を継承しない。

### 2.2 purchase の応答（Payer のファイル契約。FR-Z20〜Z22）
- `releasedHeader {name, value}`: 発行した支払いヘッダ。
- `headerFile {order_id, intent_sha256, name, value}`: `delivery payer-finalize-order --payment-header-file` が要求する**そのままの内容**（`main.rs` `payer_finalize_order`）。
- `releaseB64`: Router が Verifier に渡した release 文書の**正確なバイト列**（`intent.rs` は `release_sha256 = sha256(release bytes)` を record に固定する。Payer は
  `payer-decrypt --release` に**同じバイト列**を渡す必要があるので、JSON 値ではなくバイト列を配る）。`release` は同じ内容の読める写し（情報用）。
- `verifier.address`: `127.0.0.1:<port>`（addr-file の内容）。`deadlines.credentialExpiresAt`（署名済み credential の `validBefore` × 1000）、`deadlines.sessionBy`。

## 3. core: `src/core/private.ts`（`createPrivateCore`）

動的購入（`src/core/dynamic.ts`）と同じ構えで、**別の core**。journal・store・budget・ledger・gate は共有。dispatch は入力の形ではなく**記録のメタデータ**で決める（§3.0）。

### 3.0 dispatch と fail closed
- quote: `/v1/private/quotes` の口だけが `privateCore.quote` を呼ぶ（既存 `/v1/quotes` は変えない）。
- purchase: 既存の `/v1/private/purchases` → `core.purchase`。orchestrator の `purchaseDispatch` は、store か控え（ledger）の intent に `private` 欄があれば **必ず** dynamicCore へ
  渡し、dynamicCore は `intent.private !== undefined` のとき受信レグの後の継続を private に切り替える（§3.2）。`private.profiles` の設定が無い（`privateCore` 無し）のに
  `private` 欄を持つ記録は `rejected`/`private_disabled`（何も書かない）。
- 読めない `private` 欄（`privateInvalid`、§7.2）は `rejected`/`quote_unreadable`。orchestrator の静的 `deliver` に `private` 欄の intent が届いた場合（到達し得ない経路）は
  `paid_undelivered`/`quote_changed`（未発行）で止める。`offerFor`・`status` は既存の `readable`（`dynamic` 欄がある intent は `ownerKey` 必須）で守られる（private 記録は
  `dynamic` 欄も持つ）。

### 3.1 quote
1. `config.router.private` が無ければ `private_disabled`。`profileId` が `private.profiles` に無ければ `unknown_route`。`(principal, requestId)` の衝突・控えの状態・門は dynamic と同じ。
2. `intentB64` を復号（符号化の形・長さ → バイト列 ≤ `maxIntentBytes`）。`parseIntent(bytes)`（§5.1）で**全欄**を検査。拒否は `invalid_intent` + 固定 `reason`。
3. URL = `https://${target.host}${target.path}`（port は 443 固定なので URL に書かない）。`parseUpstreamUrl`（deny list 込み）。失敗は `invalid_upstream_url`。
4. 探り（FR-Z16）: `rail.discover(profileId, probeTarget)`（§6）。`probeTarget` = GET: `{url, method:"GET"}`、POST: `{url, method:"POST", body:"{}"}`。返る `{offers, challenge}` から
   dynamic と同じ規則で選ぶ（scheme・network・額 ≤ `maxUpstreamAmount`・額 ≠ 0）。Tempo は pull を提供する challenge だけが候補（§6.2）。
5. intent の `outbound`/`inbound` 欄（§5.1）と選んだ offer・プロファイルの照合（`intent_mismatch`）: `outbound.protocol`/`network`/`asset`（小文字比較）/`payTo`（小文字比較）が
   offer と一致し `offer.amount ≤ outbound.maxAmount`; `inbound.network`/`asset` がプロファイルの受信と一致し `pricing.total ≤ inbound.maxTotal`。
6. 価格: `priceOf(profile, selected.amount, cap)`（Tempo は `estimateFor` の cap。`rail.estimateFee` を経由。既存関数を再利用）。1 件上限 `perPurchaseLimitOf` も同じ。
7. `routeBinding = private|<profileId>|<METHOD>|<url>|<intentSha256>`（各要素 `encodeURIComponent`。`dynamicBindingOf` と同じ形で先頭語と 5 要素目だけ違う）。
   受信 offer を `inbound.createOffer` で発行し、dynamic と同じ照合（額・資産・network・binding）。
   `routeFingerprint = fingerprintOf({dynamic: dynamicAuthoritativeTermsOf(dynamic, profile), private: privateAuthoritativeTermsOf(config.private, profileId)})`
   （`privateAuthoritativeTermsOf` = `{allowlisted: profiles.includes(profileId), trust, deliveryBinSha256, srsSha256, policy: {minCredentialLifetimeMs(rail), sessionTimeoutMs, attestTimeoutMs, retentionMs},
   limits: {maxIntentBytes, maxBundleBytes, maxRecordBytes}}`）。purchase の指紋の照合（dynamic.ts）は `intent.private !== undefined` のとき同じ合成で計算するので、`private.profiles` からの除外・
   方針の変更・バイナリの差し替えは `quote_changed`（settle の前）で止まる。
8. 記録（控え = `QuoteLedger`、dynamic と同じ）: dynamic の record に `private` 欄（承認した方針 `policy`・`limits` を含む。§7.2）を足す。`upstream` は**探りの要求**: GET `{url, method:"GET"}`、POST
   `{url, method:"POST", body:"{}", bodySha256: sha256("{}")}`（`validUpstreamRequest` を満たす）。控えの 1 行は 8 KiB 以内（`maxIntentBytes` 2048 B → base64 2732 字、
   プロファイル写し・offer・private 欄を足して ≈ 5.5 KiB。超えれば既存の `quote_too_large`）。
9. 返す: dynamic quote 文書 + `private` 欄（§2.1）+ `ownerKey`。

### 3.2 purchase（受信レグまで dynamic と同一、その後が私的）
dynamic.ts の `purchaseOfIntent → purchaseAdmitted → purchaseWithHost` を**引数化して共有**する（重複実装しない。§10）: `createDynamicCore` に任意の `private` 依存
`{ isPrivate(intent), outbound(intent): OutboundRead, reserveCapacity(intent): CapacityLease | undefined, deliver(paymentId, diag): Promise<Outcome> }` を渡し、
`intent.private !== undefined` のときだけ (a) 上流の読み取り（`readOffers`・`estimateFor`）を private rail の `discover`/`estimateFee` に、(b) 受信成立後の継続を
`private.deliver` に切り替える。既存の挙動（private 欄の無い intent）は 1 行も変えない。

受信レグ（dynamic と同じ順・同じ journal 行）: 持ち主の証明 → 指紋 → 期限 → credential → 門 → **容量予約**（§3.7。preflight の直後・残高の前。取れなければ
`awaiting_payment`/`private_capacity`、何も書かない）→ preflight → attempt → 残高 → 宛先ホストの枠 → 探りで読み直し・`stableJson` 一致（FR-Z18 の 1 回目）→ Tempo は
cap の再見積り → verify → 期限 → 昇格 → `source_pending` → 期限 → settle → `source_settled {txRef, eventId?}`（x402 受信 adapter が返す `eventId` = authorization nonce。§10）。
容量の lease は、受信レグが settle に至らずに終わるすべての出口で解放する（`withLease` と同じ try/finally）。

送信レグ（`private.deliver(paymentId)`。すべて同じ購入の `withKey` の中）:
1. **再照合（FR-Z18 の 2 回目）**: `discover(probeTarget)` → `stableJson(selectedOffer)` と一致する offer を探す。読めない → `paid_undelivered`/`offer_unavailable`、
   無い → `paid_undelivered`/`offer_changed`、承認期限（`approvalDeadlineMs`）を過ぎた → `paid_undelivered`/`approval_expired`。いずれも**未発行**（outcome `not_sent`）で、
   容量 lease を解放し作業ディレクトリを削除する。一致した challenge（adapter の不透明な handle）を発行に渡す（発行は HTTP の発見をしない）。
2. **受信支払いの識別子**: `inboundIdentity = ${sourceRail}|${source.network}|${txRef}|${eventId}`。x402 受信で `eventId` が無い（adapter が返さなかった）なら
   `paid_undelivered`/`private_inbound_identity_missing`（未発行。黙って `txRef` だけに落とさない）。
3. **発行予約（FR-Z06）**: `store.reservePrivateIssuance(paymentId, intentSha256, inboundIdentity)`（§7.1。同じ store の mutex の中で 2 集合の検査 → journal 行
   `private_issuance_reserved` の append（fsync）→ 集合の更新を不可分に）。`collision` → 送信レグ `unknown`/`private_issuance_duplicate`（既に別の発行があるので資金の行方は不明）、
   `unavailable`（書けたか不明）→ `unknown`/`private_issuance_unknown`。以後の失敗はすべて `destination.outcome = "unknown"` を明示した `unknown` 行（FR-Z09）。
4. **発行**: `rail.issueCredential({profileId, offer, target, challenge, deadlineMs: approvalDeadlineMs, maxFee: pricing.maxFee?})` → `{name, value, expiresAtMs, expectedRef?}`
   または `{notIssued: reason}`。例外・`notIssued` → `unknown`/`private_issue_failed`。
5. **ヘッダ検査**（Rust `validate_payment_header_max` と同じ規則を発行側で先に）: 名前が `PAYMENT-SIGNATURE`（x402）/`Authorization`（MPP、値は `Payment ` + 1 文字以上）、
   値は 1..=cap バイトの VCHAR/SP（先頭・末尾・連続 SP 無し）。cap は POST 2048 / GET 3072。さらに最終要求の全長（§5.3 の期待 prefix + POST: 64 + 4 + body_len）≤ 4096 B。
   不成立 → `unknown`/`private_header_invalid`（署名済み。再署名しない）。
6. **寿命**（FR-Z15）: `expiresAtMs - now < minCredentialLifetimeMs[rail]` → 値を捨て `unknown`/`private_credential_lifetime`。
7. **release**（§5.2）: バイト列を作り journal 行 `private_released {headerName, headerSha256, expiresAtMs, expectedRef?, releaseB64, sessionBy: now + policy.sessionTimeoutMs}`
   （値は書かない。release 文書に値は無い）。**`sessionBy` はここで永続化する**: 子プロセスが存在する前に期限が journal にあり、以後の受理・record の完成・再構成の
   資格判定はすべてこの 1 つの値で行う（§3.3・§3.6）。書けなければ `unknown`/`private_release_unknown`（メモリの credential を捨てる）。
8. **Verifier 起動**（§4 の起動手順）: 作業ディレクトリに `intent.json`（バイト列そのまま）、`release.json`（バイト列そのまま）、`order_final.json`（§5.1）を 0600 で書く。
   **期限の検査（起動前）**: `remaining = sessionBy - now`。`remaining < minSessionRemainingMs`（既定 5 s）なら起動せず `unknown`/`private_session_timeout`。
   起動門 `launch.serve` を書き（§4）、spawn の直前に `remaining` を取り直して `verifier-serve` を spawn（`--timeout-secs = max(1, floor(remaining / 1000))`。これは CLI の
   **正の相対 timeout** であって `sessionBy` の強制ではない: 起動の遅れとバイナリ自身の受理／session の別々の timer があるので、`sessionBy` の強制は Router の watchdog（§3.3）と
   record の期限の資格（§3.3）が行う）、`serve.pid` と**新しく公開された** `addr-file` を**絶対期限の内側**（≤ min(5 s, sessionBy - now)）で待つ。
   待てなければ子を止めて終了を待ち（§4）`unknown`/`private_verifier_unavailable`。
   **期限の検査（アドレス取得後）**: `now ≥ sessionBy` なら子を止めて終了を待ち `unknown`/`private_session_timeout`。
9. journal 行 `private_handed_over {handedOverAtMs, verifierAddress}` を**応答の前に** fsync。書けなければ子を止め `unknown`/`private_handover_unknown`
   （応答は credential を含まない失敗応答）。**応答を返す直前にもう一度** `now < sessionBy` を確かめ、過ぎていれば子を止めて `unknown`/`private_session_timeout`
   （credential は返さない）。成功なら状態 `private_awaiting_session`、応答 §2.2（`deadlines.sessionBy` は 7 の値）。

### 3.3 セッションと record
- 監督は `sessionBy`（§3.2 7。release の時刻 + 方針。journal に永続化済み）で打ち切る: `sessionBy` に達したら SIGTERM → 2 s → SIGKILL（終了の猶予は受理の期限を延ばさない）。
  バイナリ自身の `--timeout-secs`（受理と session に別々に効く）には残り時間を渡すが、Router は自分の `sessionBy` だけを権威とする。
- 正常終了で `record.json` を**上限つきで**読む（`stat` の大きさ ≤ `maxRecordBytes`、読むのも `maxRecordBytes + 1` まで）。JSON で、`order_id`・`target`・
  `intent_binding.{intent_sha256, release_sha256, header_sha256, inbound_tx}` が購入の値と一致すれば **完成の認定**。
  完成の時刻は record 自身の `tls_accept_unix_ms + session_wall_ms`（Verifier が書いた安定な値。再起動で動かない）= `recordCompletedAtMs`。
  **期限の資格**: `record.tls_accept_unix_ms ≤ sessionBy` かつ `recordCompletedAtMs ≤ sessionBy` のときだけ「期限内の完成」。期限の後に完成した record は
  `private_session_timeout` の `unknown` にし、attest の資格を与えない（`attestBy` は無し）。ただし Payer の自衛のために record 自体は保持・取得の対象にする
  （`private_recorded {…, late: true}` を `unknown` の後に書く。配送の成立とは別の欄 = `artifacts`）。通常の完成と再構成（§3.6）で同じ判定を使う。
  **取得専用の record を残す終端はすべて同じ掃除**（遅い record、再起動の回収、attest の失敗・期限切れ）: 子の終了を確認した後、record 以外の全ファイルを削除し、
  予約を record の実測の大きさに縮める（§3.7 `attestSettled`）。掃除に失敗したら予約は縮めない（次の再起動の再構成が引き継ぐ）。
  **耐久化してから journal**: ファイルを `fsync`、ディレクトリを `fsync`、そのうえで journal 行
  `private_recorded {recordSha256, recordBytes, recordCompletedAtMs, summary, attestBy: recordCompletedAtMs + policy.attestTimeoutMs, recordAvailableUntil: recordCompletedAtMs + policy.retentionMs}`
  （summary = trust、external_gate、server_name、target、request_line、len_sent、body_len、status_line、領収ヘッダ名、cred_len。**`revealed_prefix` の値は書かない**）。
  状態 `private_recorded`。容量: **セッション枠だけ**を返す（保存の予約は成果物を削除するまで保つ。§3.7）。ファイルは umask 077 で生まれる（0600）。
- タイムアウト・異常終了・record 不成立: 子の終了を**待ってから**（§4 の監督）`unknown`/`private_session_timeout`。record の無い作業成果物を削除し、セッション枠と保存の予約を返す。
- journal に `private_recorded` を書けなかった場合（成否不明）: record ファイルは残し、プロセス内では `unknown`/`private_record_unknown` を試みる。再起動の再構成（§3.6）が
  完成した record を**終端の理由によらず**回収する。

### 3.4 attest（受付手順。同じ購入の `withKey` で直列化）
1. 認証: 所有 principal と `ownerKey`。合わなければ 404（状態不変）。
2. 本文: `bundleB64` の符号化長 → 復号 → ≤ `maxBundleBytes` → JSON object。不成立 → 400 `invalid_bundle`（状態不変）。`bundleSha256` を取る。
3. 重複: 購入の `private.attest` が記録済みで `bundleSha256` が一致 → その耐久結果（成功も失敗も）をそのまま返す（冪等）。進行中（受理済み・待ち行列か実行中）の digest と一致 →
   そのジョブの結果を待って返す（**同じジョブに合流**。2 つ目の検証は起こさない）。
4. 拒否（状態不変）: 購入が終端で digest が違う → 409 `attest_closed`; 状態が `private_awaiting_session` → 409 `attest_not_ready`; 進行中のジョブと digest が違う → 409 `attest_in_progress`;
   `now ≥ attestBy` → タイマがまだなら `unknown`/`private_attest_timeout` を書いてから 409 `attest_expired`。
5. **束縛の事前検査（FR-Z03・FR-Z19。状態不変）**: 検証の枠を取る前・ファイルを書く前に、bundle の `public.order_id === intent.order_id`、`public.payer_pk` が intent の鍵、
   `public.committed_hash_hex === record.committed_hash_hex`、`public.payload_len === record.body_len`、POST なら `request.public.{tls_body_hash_hex, tls_cred_hash_hex}` が record の
   `request.{sent_body_hash_hex, sent_cred_hash_hex}`、`request.public.payer_commitment_hex === body_commitment_hex`、`body_len`・`cred_len` が record と一致、GET なら `request` 欄が無い。
   1 つでも外れる = 別購入・別セッションの bundle → 409 `attest_foreign`（購入は変わらない）。**終端の `unknown` を書けるのは、この検査を通って受理した 1 件の bundle だけ**。
6. 受理: 検証ジョブの枠（`maxConcurrentVerifications` 実行 + `maxQueuedVerifications` 待ち）が無ければ 429 `private_capacity`（状態不変）。枠を取った時点で **pending digest** を記録し
   （以後の提出は 3・4 で合流か拒否）、`bundle.json` を 0600 で書く。待ち行列に入ったジョブは **受理時に期限内**であれば、実行の開始が `attestBy` を過ぎても期限切れにしない
   （期限の判定は受理時の 1 回）。
7. 検証: `verifier-verify --verifier-dir D --order order_final.json --bundle bundle.json --expect-host H --expect-port 443 --expect-path P --intent intent.json --release release.json
   [--require-external-gate]`（実モード必須。試験 trust のときだけ外す）、`verifyTimeoutMs`（超過は子を止めて `private_verify_timeout`）。`verify_result.json`（≤ 64 KiB、上限つき読み）を読む。
8. FR-Z08 の Router 側検査（`src/private/attest.ts`、純関数。§5.4）→ 領収（`rail.checkReceipt`）。
9. 結果の記録（成否とも 1 行、`attest: {bundleSha256, result}` を含む）: 成立 → `private_attested {bundleSha256, txRef?, receiptRef, recordSha256, proof}`、状態 `delivered_private`、
   `destination.outcome = "paid"`; 不成立 → `unknown {outcome:"unknown", reason: private_attest_invalid | private_receipt_mismatch | private_verify_timeout, attest:{bundleSha256}}`。
   record は保持期限まで残す（Payer の復号に使う）。結果の記録後に record 以外のすべてのファイルを削除し（§3.7 `attestSettled`）、保存の予約を record の大きさに縮める。
- 期限タイマと検証の競合: タイマは同じ `withKey` を取り、状態が `private_recorded` かつ受理済みのジョブが無いときだけ `unknown`/`private_attest_timeout` を書き、
  record 以外のすべてのファイルを削除する（§3.7 `attestSettled`。record は保持期限まで残す）。受理済みのジョブがあれば検証の結果が勝つ。再起動後の購入は終端で attest を
  受け付けないので、再起動後にこのタイマは無い（§3.6）。

### 3.5 record の取得と保持
`GET …/record`: 所有者（principal + `ownerKey`）に、記録済みの record のバイト列（`recordB64`）と release のバイト列（`releaseB64`）を返す。対象は `private.record` を持つ
購入（`private_recorded`・`delivered_private`・record 付きの `unknown`）。**取得で削除しない**。`recordAvailableUntil`（`private_recorded` 行に永続化）まで何度でも取得でき、
再起動をまたいで残る。期限経過で削除し journal `private_record_expired {}`（状態は変えない。`private.artifacts.record = "expired"`）。保持中は
`sha256(record bytes) === private.record.sha256` を取得のたびに確かめ、違えば 500 `record_corrupt`（配らない）。

### 3.6 再起動（FR-Z25）: 子の終了 → journal → 作業ディレクトリの再構成
順序が重要: **前世代の子プロセスを全部終わらせてから**再構成し、再構成が済むまで新しい受信 settle を受け付けない（容量の予約を開かない）。
0. **前世代の起動の取り消しと子の終了**（§4 の起動手順・監督）: まず `workDir` 配下のすべての起動門 `launch.*` を `*.cancelled` に rename する（保留中の wrapper は exec しない）。
   次に `serve.pid`・`verify.pid`（tmp を含む）を読み、pid が生きていれば（`kill(pid, 0)`）**OS 由来の同一性**で確かめる:
   `ps -o command= -p <pid>` の命令行が `deliveryBin` の絶対パスと**その購入の作業ディレクトリ**（購入ごとに一意）を含む = 自分の子（pid の再利用なら命令行が違う）。
   該当すれば SIGTERM → 5 s → SIGKILL、終了（`kill(pid, 0)` が ESRCH）を待つ。`ps` が読めない・終了を確認できない・pid ファイルが tmp のまま／空／数字でない pid が 1 つでもあれば
   **秘匿購入の受付を閉じたまま**（quote・purchase は `private_unavailable`、note に固定文）にして起動を続ける（既存の口は動く）。棚卸しが済むまで 2〜5 の掃除と `reserve()` の
   開放はしない。lab の `write_new` は `create_dir_all(parent)` を呼ぶので、ディレクトリの
   削除や create-new の性質では遅い書き込みを防げない。**終了の確認が先**。
1. `IntentStore.#resolveInterrupted`（§7.1 の表の「再起動」列。store の load の中）。再起動で確定した購入はすべて終端で、以後できるのは status と record の取得だけ。
2. `workDir` の各 `<paymentId>/` について、store に intent が無い・`private` 欄が無い → ディレクトリごと削除。
3. 購入が `private.record` を持つ → `record.json` の sha256 が記録と一致すれば保持（他のファイルは削除）、一致しない・無い → `private_record_expired {reason:"record_mismatch"}` を書き削除。
4. **発行済み（`private_released` 以降に達した）で `private.record` を持たない購入すべて**（終端の理由が `interrupted_after_release`・`private_record_unknown`・`private_session_timeout`
   などどれでも）→ `record.json` があり**完成の認定**（§3.3）を満たせば「完成したが journal に届かなかった record」として、ファイルとディレクトリを `fsync` し
   `private_recorded {…, recordCompletedAtMs: record.tls_accept_unix_ms + session_wall_ms, recordAvailableUntil: recordCompletedAtMs + policy.retentionMs, recoveredAtRestart: true,
   late: !(期限内の完成 §3.3)}` を書く。**状態は再起動で確定した終端（`unknown`）のまま、attest は受け付けない**（`attestBy` 無し。FR-Z25 の終端の回復の型: 再起動後の購入は
   record の取得だけができる。再起動後の attest は本 v1 に無い）。保持期限の起点は record の完成時刻なので、再起動を繰り返しても延びない。
   record 以外のファイル（`intent.json`・`release.json`・addr-file・`order_final.json`・`bundle.json`・子の出力・`verify_result.json`・pid ファイル）はすべて削除する。
5. 保持中の record の期限タイマを `recordAvailableUntil` から張り直す。容量（§3.7）の保持量と件数を、残った record のファイルの大きさから**再構成**する（再起動後の購入は
   すべて終端なので、残る義務は record のバイト数と件数だけ）。再構成が終わるまで `reserve()` は失敗（`private_capacity`）。

### 3.7 容量（FR-Z27・FR-Z12）: 予約は受信 verify の前・不可分、義務は成果物を消すまで
`PrivateCapacity.reserve(paymentId)`（同期・プロセス内の 1 つの状態で判定。再起動時は §3.6 5 で再構成してから開く）:
`activeSessions + 1 ≤ maxConcurrentSessions`、`committedPurchases + 1 ≤ maxRetainedPurchases`、`committedBytes + purchaseAllowance ≤ maxRetainedBytes` のすべてを満たすときだけ、
`<workDir>/<paymentId>` を `mkdir 0700`（既に在れば失敗）し、`committedBytes += purchaseAllowance`、`committedPurchases += 1`、`activeSessions += 1` として lease を返す。
`purchaseAllowance = maxRecordBytes + maxBundleBytes + maxVerifyResultBytes(64 KiB) + 4 × maxChildOutputBytes + maxFinalOrderBytes(8 KiB) + 8 KiB`（intent・release・addr・pid）。
- `release()`: settle 前の失敗・未発行の終端（ディレクトリ削除、枠・件数・量を全部返す）。
- `sessionEnded()`: **セッション枠だけ**を返す。保存の予約（`purchaseAllowance`）は attest の成果物を削除するまで保つ。
- `attestSettled()`: attest の完了・期限切れで **record 以外のすべてのファイル**（`intent.json`・`release.json`・addr-file・pid・`order_final.json`・`bundle.json`・
  `verify_result.json`・子の出力）を削除した**後にだけ**、予約を `recordBytes`（実測）に縮める。record が無ければ量と件数を全部返す。
- `retire()`: record の期限切れ・削除で残りの量と件数を返す。
- 検証ジョブの待ち行列・実行は `maxQueuedVerifications`・`maxConcurrentVerifications` で別に数える。再起動後の購入は attest を受け付けない（§3.6）ので、再構成する義務は
  record のバイト数と件数だけ。新規の購入の受付（`reserve()`）は再構成の完了後に開く。
子が作るファイルはすべて上限を持ち、読むときも上限つき: `record.json` ≤ `maxRecordBytes`、`verify_result.json` ≤ 64 KiB、addr-file ≤ 64 B、stdout/stderr ≤ `maxChildOutputBytes`（pipe で受けて
作業ディレクトリ内のファイルへ、超過分は捨てる）。これ以外のファイルがディレクトリに現れたら削除する（成功の判定には使わない）。
`close()`（drain）: 進行中の子に SIGTERM → 5 s → SIGKILL し、**終了を待ってから** record の無い作業成果物を消す（購入は再起動時の規則で終端になる）。

## 4. Verifier ランナー: `src/private/verifier.ts`

- 入力: `deliveryBin`（起動時に sha256 照合、不一致なら `ConfigError`）、`srsPath`（同）、`workDir`、`trust`（`mozilla` 固定。試験は `privateTrustForTest`）。
- 環境変数は最小: `PATH`、`DELIVERY_SRS_DAT=<srsPath>`（lab の `rust_env` と同じ名前）、`RUST_LOG=info`。cwd は作業ディレクトリ。
- **起動手順（launch protocol）**。Router が死ぬ時点がどこでも、前世代の起動を再構成が**取り消せる**ことが不変条件:
  1. Router が**起動門** `D/launch.<kind>`（`serve`／`verify`。中身は `{at}`）を書く（これが「起動が保留中かもしれない」印）。
  2. `spawn("/bin/sh", ["-c", WRAPPER, deliveryBin, <args…>], {stdio: ["ignore","pipe","pipe"], env: {PATH, DELIVERY_SRS_DAT, RUST_LOG, PIDFILE: D/<kind>.pid, GATE: D/launch.<kind>}})`。
     `WRAPPER` は固定文字列（引数は位置パラメータ、パスは env。文字列へ補間しない）:
     `umask 077 && printf %s "$$" > "$PIDFILE.tmp" && mv -f "$PIDFILE.tmp" "$PIDFILE" && [ -e "$GATE" ] && exec "$0" "$@"`
     — **pid の公開 → 起動門の確認 → exec** の順。どこかで失敗すれば exec せずに終わる（`&&`）。`exec` の後も pid はシェルのものと同じ。
  3. `serve`: Router は `serve.pid`（内容 = `spawn` の pid）と**今回新しく公開された** `addr-file`（起動前に無いことを確かめる）を `sessionBy` の内側で待つ。
     `verify`: `verify.pid` を確かめ、addr-file は見ず、`verifyTimeoutMs` の内側で**プロセスの完了**を待つ。起動門の取り消しと所有の規則は両方同じ。
  **なぜ取り消せるか**: 再構成（§3.6 0）は先に起動門を外す（`launch.<kind>` → `launch.<kind>.cancelled` に rename）。門の確認（2 の `[ -e ]`）がその後なら wrapper は exec
  せずに終わる。門の確認がその前なら pid の公開はさらに前なので、門を外した後の pid の棚卸しで必ず見つかり、終了させられる（wrapper のままでも exec 後でも pid は同じ）。
  pid ファイルの無い状態は「起動が無い」証明ではない: 門がある限り保留中とみなし、門を外してから棚卸しする。**前提**（満たせなければ掃除も受付もしない）: (a) `workDir` 配下の
  **正確なパス** `<paymentId>/launch.serve`・`<paymentId>/launch.verify` を全部列挙して取り消せたこと（列挙・rename の失敗は受付を閉じる）、(b) 回収された購入の門を
  再作成しないこと（再起動後の購入は終端で起動しない）、(c) 同じ `workDir` を書く Router は 1 つ（journal のロックと同じ）。取り消しが示すのは「以後バイナリは実行されない」であり、
  取り消された wrapper が既に終了していることではない（wrapper は pid の公開だけして終わり得る。棚卸しはそれも拾う）。
  pid ファイルが tmp のまま・空・数字でない・`spawn` の pid と違う → その起動は不明として SIGTERM/SIGKILL の対象にできないので、**秘匿購入の受付を閉じたまま**にする（§3.6 0）。
  umask 077 で、バイナリが `0o644` で作るファイル（`record.json`・`verify_result.json`・addr の tmp）は **生成時から 0600**。
  バイナリの出力ファイルは **create-new**（既存なら失敗）なので、Router は購入ごとに新しいディレクトリを使い、同じ購入で `verifier-serve` を 2 度起動しない。
  `--listen` は `127.0.0.1:0` 固定（設定 `verifierListen` が loopback 以外なら `ConfigError`）。addr-file から実アドレスを読む（≤ 64 B）。
- **監督**: 起動門と pid ファイル（`serve.pid`／`verify.pid`、子が書く）は子の終了（`exit`）の後に Router が削除する。`sessionBy`／`verifyTimeoutMs` で SIGTERM → 猶予 → SIGKILL し、
  `exit` を**待つ**。`close()`（drain）と再起動（§3.6 0）は、**起動門を外してから** pid ファイルで前世代の子を棚卸しし、生存と OS 由来の同一性（`ps -o command=` の命令行が
  `deliveryBin` とその購入の作業ディレクトリを含む。wrapper のままなら `/bin/sh -c … <deliveryBin> … <D>` も同じ条件を満たす）を確かめて終了させ、終了を待ってから掃除する。
  確認できなければ秘匿購入の受付を閉じたままにする。「ディレクトリを消せば書けない」「create-new だから上書きできない」には頼らない（lab の `write_new` は親ディレクトリを作り直す）。
- `verifier-verify` も同じランナー（別プロセス、`verifyTimeoutMs`。exit 1 = `ok:false`）。

## 5. 契約の実装

### 5.1 intent（`src/private/intent.ts`）
`parseIntent(bytes, nowMs): Intent | {error: reason}`。検査（すべて I/O の前。Rust の骨格の規則と同じか、より厳しい）:
- バイト列は UTF-8 の JSON object で、**`JSON.stringify(JSON.parse(bytes)) === bytes`**（compact・鍵の重複無し・余分な空白無し。lab の Payer は `JSON.stringify(doc)` で作る。
  serde は重複鍵を拒否するので、重複を含むバイト列は Router でも拒否する）。
- トップレベルの鍵は `version`・`order`・`outbound`・`inbound` のちょうど 4 つ。`version === "phase5-intent-v1"`。
- `order` の鍵はちょうど `order_id, payer_pk, curve, target, request`。`order_id` 64 hex 小文字; `payer_pk {x, y}` 各 64 hex 小文字; `curve === "grumpkin"`;
  `target {host, port, path}`: `host` は小文字の DNS 名（Rust `tls::validate_target` の `dns_name` + 小文字の規則と、`parseUpstreamUrl` の規則・deny list。IP リテラル不可）、
  `port === 443`（整数）、`path` は `/` で始まり、クエリ（`?`）・`#`・空白・制御文字を含まない VCHAR で **≤ 256 B**（Rust と同じ上限。超えると Verifier の起動で落ちるので、
  探りと支払いの前に拒否する）、URL として自分自身に正規化される。
- `request` の鍵はちょうど `framing, method, content_type, body_len, body_commitment_hex, executor_header, max_executor_value_len`（`payment_header` があれば拒否）。
  POST: `framing === "phase5-post-json-canonical-v1"`、`method === "POST"`、`content_type === "application/json"`、`body_len` 整数 1..=512、`body_commitment_hex` 64 hex、
  `executor_header === "X-Lab-Credential"`、`max_executor_value_len === 64`、`path === "/select"`。
  GET: `framing === "phase5-get-public-v1"`、`method === "GET"`、`content_type === ""`、`body_len === 0`、`body_commitment_hex === ""`、`executor_header === ""`、
  `max_executor_value_len === 0`。
- `outbound` の鍵はちょうど `protocol, network, asset, payTo, maxAmount`（`protocol` は `x402`|`mpp`、`network` CAIP-2、`asset`/`payTo` は EVM アドレス、`maxAmount` 10 進 ≤ 30 桁）。
  `inbound` の鍵はちょうど `network, asset, maxTotal`。これらは quote の結果と照合する（§3.1 5）。Rust は `outbound`/`inbound` を読まない。
- `intentSha256 = sha256(bytes)`。`finalOrderOf(order, header)` = Rust の `Order` 構造体の**フィールド順**で組んだ `{order_id, payer_pk, curve, target, request:{…, payment_header:{name,value}}}` を
  `JSON.stringify`（compact）で書く（serde は鍵順を問わないが、Router の記録と Payer の `payer-finalize-order` の出力が同じ値になる）。

### 5.2 release（`src/private/release.ts`）
`releaseBytesOf({intentSha256, orderId, headerName, headerValue, inboundTx})` = `JSON.stringify({version:"phase5-release-v1", intent_sha256, order_id, header_name, header_sha256: sha256(value),
inbound:{tx}})`（この鍵順・compact。以後このバイト列だけを使う: Verifier の `--release`、journal の `releaseB64`、Payer への `releaseB64`、record 取得）。
`inbound.tx` は受信 settle の `txRef`（空は不可）。

### 5.3 期待 prefix と要求長（`src/private/attest.ts`）
lab の `request.rs` と同じ直列化を TypeScript で再現する:
- POST（canonical）: `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${body_len}\r\nConnection: close\r\n${name}: ${value}\r\nX-Lab-Credential: `。
  record の `revealed_prefix` と文字列として厳密一致。全長の上限: `prefix.length + cred_len + 4 + body_len ≤ 4096`（発行前は cred_len = 64 で見積もる）。
- GET: `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${name}: ${value}\r\n\r\n` が `revealed_prefix` と厳密一致し、`len_sent === prefix.length`、`cred_len === 0`。
- 単体テストは lab の live 記録の `revealed_prefix`（`phase5/results/*/verifier/record.json`）を golden に使う。

### 5.4 attest の検査（純関数 `checkAttest(expect, record, verifyResult, bundle)`）
record の欄（`types.rs` `VerifierRecord`）: `trust`（実モード `"mozilla-webpki-roots"`、`external_gate === true`; 試験 trust は `"lab-fixture-ca"`、`false`）、`target` が intent と同一、
`server_name === host`、`order_id`、`intent_binding` の 4 欄が購入の値（`intentSha256`・`sha256(releaseBytes)`・`headerSha256`・`inboundTx`）と一致、`request.framing` が intent の framing、
`request.spec` が最終注文の `request` と同一、`revealed_prefix`/`len_sent`/`cred_len`（§5.3）、POST は `request.sent_body_hash_hex` と `sent_cred_hash_hex` が bundle の
`request.public.{tls_body_hash_hex, tls_cred_hash_hex}` と一致し `request.public.payer_commitment_hex === body_commitment_hex`・`body_len`、`http_framing === "content-length-identity-single-response"`、
`content_length === body_len`、`revealed_recv_headers` を解析（`\r\n` 区切り、1 行目の状態行 `HTTP/1.1 200 OK`、ヘッダ名は大文字小文字を区別せず、領収ヘッダ（x402 `PAYMENT-RESPONSE`、
MPP `Payment-Receipt`）が**ちょうど 1 つ**）、`verify_result.ok === true` かつ `checks` に `UltraHonk delivery proof verified`（POST はさらに `request-binding proof verified`）、
bundle の `public.order_id`・`payer_pk` が intent と一致。1 つでも外れれば `private_attest_invalid`。領収は `rail.checkReceipt(headerValue, issued)` → `{ok, txRef?, receiptRef}` /
`{ok:false}` → `private_receipt_mismatch`。

## 6. 私的送信 adapter 面: `src/ports/private-outbound.ts`

```ts
interface PrivateOutboundRail {
  readonly rail: "x402" | "mpp";
  /** 本文に依存しない未払い探り。offers は検査を通ったものだけ・上流の順。challenge は issueCredential に渡す不透明な handle（adapter 内の型）。 */
  discover(profileId: string, target: UpstreamTarget): Promise<{ readonly offers: readonly DestinationOffer[]; readonly challenge: unknown }>;
  /** Tempo だけ。既存 `estimateFee` と同じ契約（読取 RPC だけ）。 */
  estimateFee?(profileId: string, offer: DestinationOffer, target: UpstreamTarget): Promise<FeeEstimate>;
  /** 送らずに 1 件だけ作る。HTTP の発見はしない（challenge は再照合で得たもの）。 */
  issueCredential(args: { profileId: string; offer: DestinationOffer; target: UpstreamTarget; challenge: unknown; deadlineMs: number; maxFee?: string }): Promise<IssuedCredential | NotIssued>;
  checkReceipt(headerValue: string, issued: IssuedCredential): { ok: true; txRef?: string; receiptRef: string } | { ok: false; reason: string };
}
IssuedCredential = { name: "PAYMENT-SIGNATURE" | "Authorization"; value: string; expiresAtMs: number; expectedRef?: string }
NotIssued = { notIssued: string }
```
dynamic の受信レグが使う `OutboundRead = { readChallenge(profileId, target), estimateFee? }` は `discover` を包んで作る（`offers` だけ返す）。

### 6.1 x402（`src/adapters/outbound/private-x402.ts`）
- `discover`: `x402-dynamic.ts` の `getChallenge(target, ctx)` と `checkDynamicX402Offer` を **export して再利用**（関数の切り出しのみ。既存 `pay` は不変）。POST の探りは
  `requestInitOf({url, method:"POST", body:"{}"})`。`resource.url === url` は既存の検査。`challenge` handle = `{accepts, resource}`。
- `issueCredential`: `pay` の署名部分（`createRebuildingSigner`、`x402Client` + `setSpendControls` + `onBeforePaymentCreation`、`createPaymentPayload`、`guard.signatures() === 1`、
  `accepted` 一致、`encodePaymentSignatureHeader`）を `signOnly(challenge, approved, deadlineMs)` として切り出し、`transport.fetch` を**呼ばない**（transport への参照を持たない）。
  `expiresAtMs = Number(payload.payload.authorization.validBefore) * 1000`。`expectedRef` 無し（x402 の tx は facilitator が決める）。
- `checkReceipt`: 既存 `receiptOf` 相当の検査（`decodePaymentResponseHeader` → `success`、bytes32、network、`payer` = 署名者）を `EVM_RECEIPT_FORM(signer.address)` で。

### 6.2 MPP Tempo pull（`src/adapters/outbound/private-mpp.ts`）
- 既存 `mpp.ts`/`mpp-dynamic.ts` の push の規則は変えない。私的 adapter は **pull 専用**で新規、ただし署名・検査の部品は mpp-dynamic.ts のものを **export して再利用**する:
  `checkDynamicMppChallenge(challenge, profile, operators, url, nowMs, {mode: "pull", method})`（引数を足す。既定は `{mode:"push", method:"GET"}` = 既存の挙動不変）、
  `createGuardedTempoAccount`、`approvedTransferOf`、`checkRawTempoTransfer`、`isSendOrSignMethod`、`guardedRpcTransport`、`baseFeeOf`、`chainIdOf`。
- `discover`: 未払い要求（GET、または `{}` の POST）→ `Challenge.deserializeList` → `checkDynamicMppChallenge(..., {mode:"pull", method})`: 候補条件は `supportedModes` が無いか
  `pull` を含む（push-only は候補外）、`feePayer !== true`、`machineTokenEnabled` 等の未知欄は既存どおり拒否、scope（あれば）`${method} ${url}`、realm = host。
- `issueCredential`（署名は 1 回・放送 0 回）:
  1. `capability.getClient` の素の `http` transport を SSRF 防御 A の transport に乗せ直し（既存と同じ）、**読取専用の RPC guard** で包む: 許すメソッドは**列挙した読取だけ**
     `PRIVATE_RPC_READ_METHODS = {eth_chainId, eth_getBlockByNumber, eth_fillTransaction, eth_estimateGas, eth_gasPrice, eth_maxPriorityFeePerGas, eth_feeHistory, eth_getTransactionCount, eth_call}`
     （pinned の pull 経路 `prepareTransactionRequest` が呼び得るもの。単体テストが偽 RPC で実際の呼び出し集合を固定する）。それ以外（送出・署名・`wallet_*`・未知）は例外なく拒否し、
     `params` の JSON 写しだけを送る、要求ごとの期限と予算（`rpcBudgetMs`）。
  2. baseFee を 1 回読む（`eth_getBlockByNumber latest`）。`approvedTransferOf(profile, offer, sender, cap)`（cap = quote の `maxFee`。無ければ `notIssued: destination_fee_cap_invalid`）。
  3. `createGuardedTempoAccount({account, profile, offer, maxFee: cap, baseFee, now, deadlineMs, expectedData})`: 署名口は 1 回だけ、`feeToken` は承認資産に**固定**（SDK が渡した tx の
     `feeToken` が無い・違えば拒否。chain の既定に任せない）、calls は 1 件・value 0・`to` = 資産で、**calldata は Router が組んだ期待値と完全一致**:
     `expectedData = encodeFunctionData(tip20.transferWithMemo, [payTo, amount, Attribution.encode({challengeId: challenge.id, serverId: challenge.realm})])`（SDK の既定 = clientId 無し
     = 匿名の 10 バイト 0。`mppx/tempo` の `Attribution.encode`）。`ApprovedTransfer.expectedData?` を足し、あれば `checkedTransferData` は等値だけを受ける（無ければ従来の検査 = 既存の
     push 経路は不変）。nonceKey = expiring（SDK の `nonceKey:"expiring"` を viem が変換した値）、`validBefore` は未来かつ上限内、手数料 ≤ cap、priority = Router の単価。
  4. `Mppx.create({ methods:[tempo.charge({ account: guard.account, getClient: () => sdkClient(chain.feeToken = 承認資産), mode: "pull", autoSwap: false, expectedChainId, allowedChainIds,
     expectedRecipients:[payTo] })], fetch: 拒否, polyfill:false, maxPaymentRetries: 0 })` → `createCredential(402 Response with the one challenge)`。SDK の pull 経路は
     `prepareTransactionRequest → signTransaction` だけ（mppx 0.11.0 `tempo/client/Charge.js`。送出無し）。
  5. 独立検査: `Credential.deserialize(value)` → `payload.type === "transaction"` → `checkRawTempoTransfer(payload.signature, guard.approved, now)`（envelope の復号・鍵の allowlist・
     sender 署名・fee-payer 署名無し・chainId・calls 1 件・`to`/`data`（= `expectedData`）/`value`・`feeToken`・priority・手数料・nonce・`validBefore`）、かつ `payload.signature === guard.signedRaw()`
     （署名口が返した raw そのもの）、`guard.signatures() === 1`、`Credential.challenge.id` が選んだ challenge。`TxEnvelopeTempo.serialize(deserialize(raw)) === raw`（正準）。
     不成立 → `notIssued`（署名済みでも**送っていない**ので資金は動かない。core は予約後なので `unknown` に写す = 要件どおり）。
  6. `expiresAtMs = validBefore * 1000`、`expectedRef = keccak256(raw)`。
- `checkReceipt`: `Receipt.deserialize(header)` → `status === "success"`、`method === "tempo"`、`reference` bytes32 かつ `=== expectedRef`（小文字比較）、`payer`（あれば）= 送信鍵。
- `ox/tempo` の `TxEnvelopeTempo` は既存コード（mpp-dynamic.ts）が既に使う。`mppx` 0.11.0 の pull は上記の経路で**利用可能**（検証済み。SDK の更新は不要）。

## 7. journal・状態・射影

### 7.1 権威の表（journal 行 → 状態・outcome・再起動）
| journal 行（patch） | 状態（内部）| 公開状態 | destination.outcome | 再起動時（`#resolveInterrupted`）|
|---|---|---|---|---|
| `created {…, private}`（昇格。dynamic と同じ）| `created` | awaiting_payment | none | 既存どおり（終端にしない）|
| `source_pending` / `source_settled {txRef, eventId?}` | 既存 | paid | none | 既存: `source_settled` → `paid_undelivered`/`interrupted_at_restart`（予約前 = 未発行）|
| `private_issuance_reserved {intentSha256, inboundIdentity}` | `private_issuance_reserved` | paid | none → 以後の失敗は unknown | `unknown {outcome:"unknown", reason:"interrupted_before_release"}` |
| `private_released {headerName, headerSha256, expiresAtMs, expectedRef?, releaseB64, sessionBy}` | `private_released` | paid | unknown（発行済み）| `unknown`/`interrupted_before_handover`（応答は出ていないが署名済み。§3.6 0 で子があれば終了）|
| `private_handed_over {handedOverAtMs, verifierAddress}` | `private_awaiting_session` | awaiting_session | unknown | `unknown`/`interrupted_after_release`（§3.6 0・4: 子の終了と record の回収。取得のみ）|
| `private_recorded {recordSha256, recordBytes, recordCompletedAtMs, summary, attestBy?, recordAvailableUntil, recoveredAtRestart?, late?}` | `private_recorded`（終端の後に書かれた回収・`late` の行は状態を変えず `private.record` だけを足す）| attesting | unknown | `unknown`/`interrupted_after_release`（record は保持・取得のみ。attest 不可）|
| `private_attested {bundleSha256, txRef?, receiptRef, recordSha256, proof}` | `delivered_private` | delivered_private | paid | 終端 |
| `unknown {outcome:"unknown", reason, attest?:{bundleSha256}}` | `unknown` | unknown | unknown | 終端 |
| `paid_undelivered {outcome:"not_sent", reason}`（予約前の失敗）| `paid_undelivered` | paid_data_unavailable | not_sent | 終端 |
| `private_record_expired {reason?}` | 状態不変 | — | — | `private.artifacts.record = "expired"` |

- `isInterrupted` に `private_issuance_reserved`・`private_released`・`private_awaiting_session`・`private_recorded` を足し、`isTerminal` に `delivered_private`。
- `SAFE_REASONS` に追加: `private_capacity`、`attest_foreign`、`private_inbound_identity_missing`、`private_issuance_duplicate`、`private_issuance_unknown`、`private_issue_failed`、`private_header_invalid`、
  `private_credential_lifetime`、`private_release_unknown`、`private_verifier_unavailable`、`private_handover_unknown`、`private_session_timeout`、`private_record_unknown`、
  `private_attest_timeout`、`private_attest_invalid`、`private_receipt_mismatch`、`private_verify_timeout`、`interrupted_before_release`、`interrupted_before_handover`、`interrupted_after_release`。
- **store の操作** `reservePrivateIssuance(paymentId, intentSha256, inboundIdentity): Promise<"reserved"|"collision"|"unavailable">`（`reserveMessage` と同じ形）: 同じ `#queue` の中で
  `#issuedIntents.has` / `#consumedInbound.has` を見て、無ければ `#appendLocked(paymentId, "private_issuance_reserved", …)` し、適用で両集合に足す。journal の replay でも
  同じ行から両集合を復元する（形の壊れた行は起動を止める）。対象の intent が `source_settled` でなければ `unavailable`。

### 7.2 `Intent.private` 型と復元（`privateFieldsOf`、明示的）
```
private: { intentSha256, intentB64, orderId, payerPk, target, method, framing, bodyLen, bodyCommitmentHex, executorHeader, maxExecutorValueLen, probeBody?,
           outbound: {protocol, network, asset, payTo, maxAmount}, inbound: {network, asset, maxTotal},
           policy: {minCredentialLifetimeMs, sessionTimeoutMs, attestTimeoutMs, retentionMs}, limits: {maxIntentBytes, maxBundleBytes, maxRecordBytes},   // 承認した方針の写し。期限はここから導く
           reservation?: {intentSha256, inboundIdentity},
           issuance?: {headerName, headerSha256, expiresAtMs, expectedRef?, releaseB64, sessionBy},   // `private_released` の行。sessionBy は handover と独立に復元される
           handover?: {handedOverAtMs, verifierAddress},
           record?: {sha256, bytes, completedAtMs, summary, attestBy?, recordAvailableUntil, recoveredAtRestart?, late?, expired?},   // attestBy は取得専用の record には無い
           attest?: {bundleSha256, result: "delivered_private"|"unknown", reason?} }
```
復元は `created` 行の `private` 欄（上の 1〜4 行目）を `privateFieldsOf` が、以後の行（`reservation`〜`attest`）を reducer が明示的に写す（任意の patch を保たない）。
射影と再構成は復元したこれらの欄だけを使う。復元の規則（`dynamicFieldsOf` と同じ考え方）: `private` 欄があれば `dynamic`/`upstream` も要る; `sha256(base64decode(intentB64)) === intentSha256`; `parseIntent` が通る; `policy`・`limits` の
各欄が正の整数;
受信 offer の `routeBinding` が `private|<profileId>|<METHOD>|<url>|<intentSha256>` と一致（`upstreamMatchesBinding` に `private|` の分岐を足す）; `upstream` が探りの形
（GET 本文無し / POST `{}`）。1 つでも外れれば `privateInvalid: true`（`dynamic` は保ち、実行しない）。

### 7.3 射影の `private` 欄（FR-Z04。`projectionOf` で組む）
```
private: { intentSha256, headerSha256?, outbound: {issued: boolean, expectedRef?}, verifier: {trust, externalGate, requestLine, lenSent, bodyLen, status200, receiptHeaderName}?,
           proof: {delivery, requestBinding, onChainFinality: "not_checked"}?, deadlines: {credentialExpiresAt?, sessionBy?, attestBy?}, artifacts: {record: "none"|"available"|"expired", recordAvailableUntil?},
           attest?: {bundleSha256, result} }
```
credential 値・record 本体・`revealed_prefix`・`intentB64` は決して含めない（canary）。

## 8. HTTP と MCP

### 8.1 HTTP（`src/http/app.ts`）
`/v1/private/{quotes,purchases,purchases/{id}/attest,purchases/{id}/record}` の 4 経路を追加（§2）。既存経路は不変。秘匿 quote の文書は `privateQuoteBody`（`src/http/projection.ts`）が
**明示的に**組む: `{quoteId, paymentId, routeId, resource: {url: "<base>/v1/private/purchases", method: "POST"}, source{…offer}, destination{…}, pricing, disclosures, private(§2.1), approval, ownerKey}`
（`upstream` 欄は無い: 探りの要求は承認対象ではない。動的の文書を継承しない）。写像: private quote の失敗は `DYNAMIC_QUOTE_STATUS` +
`invalid_intent 400`・`intent_too_large 413`・`intent_mismatch 409`・`private_disabled 404`; purchase の handover は 200; 進行中（`awaiting_session`・`attesting`）の再提出は 409
`in_progress`; `delivered_private` の再提出は 200（本文無し、射影の `private` 欄）; attest・record の固定コードは §2。

### 8.2 client（`src/client/index.ts`・`types.ts`）
`privateQuote({profileId, requestId, intentB64})`（応答は **専用の parser** `privateQuoteViewOf` で読む: `quoteId`・`paymentId`・`routeId`・`resource {url, method}`・`source`（offer を含む）・
`destination`・`pricing`・`disclosures`・`approval`・`ownerKey`・`private`（§2.1 の全欄: `intentSha256`・`orderId`・`payerPk`・`target`・`method`・`framing`・`body`・`outbound`・`inbound`・
`policy`・`limits`・`disclosures`）。どれか欠ければ quote として扱わない）、`privatePurchase({quote, requestId, approval, credential})`（既存 `execute` と同じ順の検査。
束縛のスナップショット `privateBindingOf(quote)` = 上の全欄の `stableJson`（`ownerKey` を含む）を発行時に保持し、持ち回った quote と完全一致しなければ `resource_mismatch`;
`quote.resource` が `{url: <baseUrl>/v1/private/purchases, method: "POST"}` でなければ要求を出さない; `allowUnissuedQuotes` の opt-in は既存と同じ意味）、
`privateAttest({paymentId, ownerKey, bundleB64})`、`privateRecord({paymentId, ownerKey})`、`status`（既存）。既存の `call` を使う。

### 8.3 MCP（`src/mcp/tools.ts`・`server.ts`）
`subetha_router_private_quote`（承認対象に §2.1 を説明。資金が動く時点をレグ別に、返金無し・unknown・`delivered_private` の意味）、`subetha_router_private_purchase`
（credential は既存どおり `npm run sign`。応答の `verifier.address`・`releasedHeader`・`headerFile`・`releaseB64` をそのまま返し、「`payer-finalize-order` → `executor-session` を
今すぐ（sessionBy まで）」と案内。`_meta: anthropic/requiresUserInteraction`）、`subetha_router_private_attest`、`subetha_router_private_record`。既存 5 ツールは不変。

## 9. 設定と合成

- `router.private`（設定 JSON）: `{ deliveryBin, deliveryBinSha256, srsPath, srsSha256, profiles: string[], verifierListen: "127.0.0.1:0", sessionTimeoutMs: 180000, attestTimeoutMs: 600000,
  verifyTimeoutMs: 60000, minCredentialLifetimeMs: {x402: 40000, mpp: 12000}, minSessionRemainingMs: 5000, workDir: "runtime/private", retentionMs: 3600000, maxConcurrentSessions: 2, maxConcurrentVerifications: 1,
  maxQueuedVerifications: 4, maxIntentBytes: 2048, maxBundleBytes: 262144, maxRecordBytes: 65536, maxChildOutputBytes: 65536, maxRetainedBytes: 67108864, maxRetainedPurchases: 256 }`。
  `profiles` は `dynamic.profiles` に存在し、**受信**が x402 の Base Sepolia USDC（`sourceRail x402`、`source.network eip155:84532`）、**送信**が x402（EVM、`tokenDomain` あり）か
  mpp（Tempo、`feeAsset`・`maxFee` あり）であること（FR-Z13。他は起動時 `ConfigError`）。trust は設定にない: `mozilla` 固定（FR-Z24）。試験 trust `lab-fixture-ca` は
  `RouterCapabilities.privateTrustForTest` でのみ注入でき、`src/main.ts` の実入口は渡さない。
- `src/main.ts composeRails`: `config.router.private` があれば `privateRails: Record<profileId, PrivateOutboundRail>` を組む（x402: 既存の EVM 署名能力 + dynamic transport、
  mpp: 既存の Tempo 能力 + dynamic transport。どちらも loopback 不可・DNS 期限つき）。`createRouterCore` に `private: {rails, runner, capacity, config, trust}` を渡す。
- config golden: `private` 無しの出力は不変。

## 10. 既存コードの接続点（最小）

| ファイル | 変更 |
|---|---|
| `src/core/orchestrator.ts` | `private` option、`purchaseDispatch` の private 判定（記録のメタデータ）、`projectionOf` の `private` 欄、`isTerminal`/`currentOutcome` の新状態、静的 `deliver` の fail-closed 門、`SAFE_REASONS` |
| `src/core/dynamic.ts` | `createDynamicCore` に任意の `private` 依存（`outbound(intent)`・`reserveCapacity`・`deliver`）。`source_settled` の patch に `eventId?`。private 欄の無い intent の挙動は不変 |
| `src/core/store.ts` | `privateFieldsOf`、新 journal 行の reduce、`#issuedIntents`/`#consumedInbound` と `reservePrivateIssuance`、`#resolveInterrupted` の私的状態、`upstreamMatchesBinding` の `private|` |
| `src/core/intent.ts` | 状態と `Intent.private` 型、公開状態 `awaiting_session`/`attesting`/`delivered_private` |
| `src/ports/inbound.ts`, `src/adapters/inbound/x402.ts` | `SettleResult.eventId?`。x402 受信の settle は検証済み payload の `authorization.nonce`（小文字）を `eventId` に返す |
| `src/adapters/outbound/x402-dynamic.ts` | `getChallenge`・`requestInitOf`・署名部分（`signOnly`）の関数化と export（`pay` の挙動は不変）|
| `src/adapters/outbound/mpp-dynamic.ts` | `checkDynamicMppChallenge` に `{mode, method}`（既定は従来値）、`createGuardedTempoAccount`・`approvedTransferOf`・`checkRawTempoTransfer`・`isSendOrSignMethod`・`guardedRpcTransport`・`baseFeeOf` の export |
| `src/http/app.ts`, `src/http/projection.ts`, `src/client/*`, `src/mcp/*` | 新経路・新ツール |
| `src/config.ts`, `src/main.ts` | `private` 設定・合成・`privateTrustForTest` |

## 11. テスト（要件 TR）

- 単体（`tests/unit/private-*.test.ts`）: intent 解析と拒否（各欄・重複鍵・非 compact・port・path・GET/POST の規則）、`routeBinding`、期待 prefix の直列化（lab 記録の golden）、
  attest 検査の各欄のすり替え、x402 `issueCredential` が fetch を持たない（transport spy）、Tempo pull `issueCredential` が送出 RPC を呼ばない（guard が例外）と envelope 検査の各欄、
  `reservePrivateIssuance` の二重一意性（同時 2 件・再起動・成否不明）、attest の受付手順（重複・別 digest・期限・進行中・容量）、期限 3 種、`#resolveInterrupted` と作業ディレクトリの再構成
  （record の回収）、射影・journal・診断の canary、設定の検査、Verifier ランナー（偽バイナリ: 期待引数・環境・addr-file・timeout・出力の上限）、符号化長と復号長の境界、控えの復元。
- wire（`tests/wire/private-x402.test.ts`）: `SUBETHA_ZKTLS_LAB_DIR`（lab のバイナリ `phase5/runner/target/release/delivery`、SRS、fixture CA `phase5/.local/upstream-tlsn/crates/
  tls-server-fixture/src/{test_server.crt,test_server.key,root_ca.crt}`）が無ければ skip。**実合成**（`composeRails` + `createRouterCore` + `startHttpServer` をテストプロセス内で。
  T14 `dynamic-integration.test.ts` と同じ）に試験の差し替えだけを足す: `dynamicTransportHooksForTest`/`transportHooksForTest` = 公開アドレスを返す lookup（`publicLookup`）+
  `dialTo({"test-server.io": providerPort, "facilitator.other.test": …})` + `tls.ca = [root_ca.crt]`、`privateTrustForTest: "lab-fixture-ca"`。
  fixture: `verifying-facilitator`（EIP-3009 の署名を検証）、**新 fixture `tests/fixtures/private/zktls-provider.ts`**（HTTPS、lab の fixture 証明書 `test-server.io`（RSA）、
  `minVersion/maxVersion: TLSv1.2`、`ciphers: "ECDHE-RSA-AES128-GCM-SHA256"`（TLSNotary が有効にする 2 suite のうち RSA 証明書で使える方）、x402 402 → verify/settle → 200、
  `POST /select` と `GET /v1/paid-snapshot`、応答は `Content-Length` 明示・≤ 704 B・`Connection: close`、本文は支払い後に検査）。
  **Router の子プロセス**: 新 fixture `tests/fixtures/private/router-private-process.ts`（実 `startRouter` + fixture 能力: 公開 lookup、`dialTo` の表（argv）、fixture CA、
  `privateTrustForTest`、`knownNetworksForTest`、`privateHooksForTest`）。`privateHooksForTest` は停止点（`afterReserve`・`afterRelease`・`afterLaunchGate`（起動門を書いた後・spawn
  の前）・`afterSpawn`（spawn の直後・pid の公開を待つ前）・`afterHandoverJournal`（応答の前）・`afterRecordPublish`（journal の前）・`afterAttestAdmission`・`beforeResultPersist`・
  `duringRecoveryInventory`（起動門を外した後・pid の棚卸しの前））で合図のファイルを書いて止まり、テストが子を SIGKILL して起動し直す。wrapper 側の境界は、試験専用の
  `launchHooksForTest`（wrapper の 3 つの段 = **pid の公開の前・公開の後で門の確認の前・門の確認の後で exec の前**に「到着を書いて、解放ファイルが現れるまで待つ」
  固定の 1 行を挟む。本番の wrapper は固定で、注入できない）で**到着を確認してから**再現する: `serve` と `verify` の両方で、各段に止めた wrapper を残して Router を殺し、
  再起動が起動門を外して棚卸しを終えた**後に**wrapper を解放し、「exec しない（門が無い）」または「公開済みの pid が終了させられた」と、遅れたバイナリの出力（record・
  verify_result）が無いことを確かめる。公開と exec の間で wrapper 自身を殺す場合も含める（既存の `svmOutboundHooksForTest` と同じ扱い: 検査の順序は変えず、本番の入口は
  渡さない）。クラッシュの試験はこの子で行い、プロセス内の `createRouterCore` の開き直しは単体の範囲。Payer 側は lab のバイナリを子プロセスで: `payer-keygen` → 封筒（§5.1。テストが組む）→ quote → `tools/x402-payer.ts` の受信 credential →
  purchase → `payer-finalize-order` → `executor-session --connect 127.0.0.1:<port> --trust lab-fixture-ca` → `executor-prove` → attest → record（2 回取得して同じ）→ `payer-decrypt` →
  平文の検証。HTTP と MCP（`mcp-harness` と同じ stdio の子）の両方。否定ケース: 注文のすり替えは TLS 前に拒否、bundle の改変・別購入の bundle・期限後は attest で拒否、
  セッション無しの timeout は `unknown`、同時二重発行、**Router 子の kill と再起動**（予約後・release 後・handover の journal 後（応答が失われた purchase）・record の公開後
  （journal の前）・attest 受理後・結果の永続化の前）、生き残った Verifier 子の終了と record の回収、失われた attest／record の応答の再取得、所有者違い、別購入の bundle（`attest_foreign`、
  状態不変）、依存ハッシュ不一致で起動拒否、全成果物（作業ディレクトリ・子の出力・診断・journal・射影）の canary。HTTP と MCP の両方。
- 受入（`tests/acceptance/private-live.test.ts`、`PRIVATE_LIVE_AC=1` + 鍵の env、owner 実行）: Provider C（x402）、Provider F（Tempo pull）、A/B。

## 12. 未解決・リスク
- Tempo pull の `validBefore`（+25 s）に対し、Router の受信 settle 後の発行 → Payer の `finalize` → MPC-TLS 接続までの実測（lab では ~5 s）。`minCredentialLifetimeMs.mpp = 12 s`。
- Verifier の loopback 制約: 受入は Router と Payer を同一ホストで動かす。
- 再起動後の attest は本 v1 に無い（再起動後の購入は終端 `unknown` + record の取得のみ。FR-Z25 の型）。Payer 側の救済は record の取得と `payer-decrypt`。

## 13. v1 → v2 の対応（Codex 設計レビュー 1 回目）
| 指摘 | 対応 |
|---|---|
| 1 settle 後の再照合 | §3.2 送信レグ 1（探りで再発見・`stableJson`・承認期限、失敗は未発行 `paid_undelivered`、challenge を発行に渡す）|
| 2 Tempo の fee token・guard | §6.2（feeToken を承認資産に固定して 1 回署名、`checkRawTempoTransfer` で独立検査、nonce/validBefore/value/1 call/正準/sender 署名/非 sponsored、autoSwap 無効、読取専用 RPC guard は送出・署名メソッドを例外なく拒否、2 署名比較はしない）|
| 3 journal の境界 | §7.1 の権威の表（予約・release・handover・record・attest・期限切れ、各行の outcome と再起動の帰結、`interrupted_before_handover`）|
| 4 attest の受付順 | §3.4（認証 → 重複は耐久結果 → 拒否は状態不変 → 期限 → 容量 → 検証、成否とも記録、タイマとの競合）|
| 5 record の保持 | §1・§2・§3.5・§3.6（取得で削除しない、完成の認定、クラッシュ前に完成した record の回収、0700 ディレクトリ + 完成時 chmod 0600）|
| 6 dynamic との統合 | §3.0・§3.2・§7.2・§10（記録のメタデータで dispatch、`bodySha256`、`private|` 束縛、`estimateFee`/`maxFee`/残高、`checkDynamicMppChallenge` の引数化、fail closed）|
| 7 Payer のファイル契約 | §2.2・§5.2（`headerFile`、`releaseB64` = 正確なバイト列、`DELIVERY_SRS_DAT`、create-new、`revealed_recv_headers` の解析 §5.4）|
| 8 事前検査 | §5.1（compact・重複鍵・全欄・1..512・content_type・`outbound`/`inbound` の必須欄）、§3.2 5（ヘッダ構文・2048/3072・4096）|
| 9 容量 | §3.7（verify 前に枠・ディレクトリ・量を不可分に予約、出口ごとの解放、子出力の上限、close の掃除）|
| 10 一意性の操作 | §7.1 `reservePrivateIssuance`、§10 `eventId` の配管（無ければ fail closed）|
| 11 期限の定義 | §2.1・§7.3（quote は方針の長さ、確定した絶対時刻は journal に永続化して射影へ。要件 v3.2）|
| 12 サイズ上限 | §2（符号化長と復号長を分ける、`maxIntentBytes` 2048、`MAX_ATTEST_BODY_BYTES`、控えの 8 KiB 以内）|
| 13 wire の足場 | §11（実合成 + 公開 lookup + dial + fixture CA、TLS 1.2、identity framing、HTTP と MCP、再起動の境界、canary。SDK 更新の疑問を削除）|

v2 → v3（Codex 設計レビュー 2 回目）:
| 指摘 | 対応 |
|---|---|
| 1 別購入の bundle | §3.4 5（束縛の事前検査 → `attest_foreign`、状態不変）、§3.4 3・6（pending digest、合流、受理時の期限判定）|
| 2 record の耐久化・回収 | §3.3（fsync → journal、完成時刻 = record の `tls_accept_unix_ms + session_wall_ms`）、§3.6 4（発行済みで record 無しの購入すべて）、§4（umask 077）|
| 3 孤児 Verifier | §3.6 0・§4 監督（pid ファイル、同一性、終了を待つ）、§3.7 `close()` |
| 4 容量の会計 | §3.7（新規予約を含む不等式、セッション枠だけ返す、attest 完了で縮める、全ファイルの上限と上限つき読み、再構成）|
| 5 path 256 B | §5.1 |
| 6 Tempo の境界 | §6.2（RPC 読取の allowlist、`expectedData` = Attribution 付き calldata の等値）|
| 7 1 つの sessionBy・timeout の掃除 | §3.2 9・§3.3・§3.4（起動時刻基準、猶予で延ばさない、attest 期限で最終注文と過渡成果物を削除）、§2.1（TLS suite の列挙）|
| 8 Router 子の harness | §11（`router-private-process.ts`、`privateHooksForTest` の停止点）|
| 新 1 方針の永続化と指紋 | §2.1・§3.1 7・§7.2（`private.policy`/`limits` の写し、`privateAuthoritativeTermsOf` を指紋に、allowlist の除外も `quote_changed`）|
| 新 2 購入口の資源 | §2.1・§8.1・§8.2（`resource = POST <base>/v1/private/purchases`、`privateQuoteBody`、client の照合）|
| FR-Z11 の整合 | 要件 v3.3 |

v3 → v4（Codex 設計レビュー 3 回目）:
| 指摘 | 対応 |
|---|---|
| 1 子の所有の公開 | §3.2 8・§4（シェルが自分の pid を書いてから `exec`、OS 由来の同一性 = 命令行の `deliveryBin` + 作業ディレクトリ、確認できなければ受付を閉じる）、§12 の記述を削除 |
| 2 容量の会計 | §3.4・§3.7（record 以外の全ファイルを削除してから縮める、再構成は record のバイト数と件数）|
| 3 セッション期限と再構成 | §3.2 7（`sessionBy` を `private_released` で子の前に永続化）、§3.3（期限の資格: `tls_accept ≤ sessionBy ∧ completed ≤ sessionBy`、遅い record は `late` で取得のみ）、§3.6 4 |
| 4 client の parser と束縛 | §8.2（`privateQuoteViewOf`、`privateBindingOf`、resource の照合）|
| 新 再起動後の attest | §3.6・§7.1・§12（選択肢 1: 再起動後の購入は終端 `unknown` + record の取得のみ。attest は受け付けない）|

v4 → v5（Codex 設計レビュー 4 回目）:
| 指摘 | 対応 |
|---|---|
| 1 所有の公開と棚卸しの競合 | §4 起動手順（起動門 → spawn → wrapper は pid 公開 → 門の確認 → exec; 再構成は門を外してから棚卸し）、§3.6 0、§11 の境界（`afterLaunchGate`・`afterSpawn`・`duringRecoveryInventory`・wrapper の prelude）|
| 2 状態の型 | §7.2（`issuance.sessionBy`、`record.{completedAtMs, attestBy?, late?, recoveredAtRestart?}`、reducer が明示的に写す）|
| 3 期限の検査 | §3.2 8・9（起動前・アドレス取得後・応答直前の 3 回、残り時間の内側の待ち、`--timeout-secs` は切り下げ、`minSessionRemainingMs`）、§9 |
| 4 遅い record の掃除 | §3.3（取得専用の record を残す終端は子の終了後に record 以外を削除し予約を縮める）|

v5 → v5.1（Codex 設計レビュー 5 回目、APPROVE WITH CHANGES）:
| 指摘 | 対応 |
|---|---|
| 1 serve の準備と verify の実行の区別 | §4 起動手順 3 |
| 2 wrapper の境界は到着の確認と解放で | §11（`launchHooksForTest`）|
| 3 timeout の丸めの説明 | §3.2 8（CLI の timeout は相対・正、強制は watchdog と資格）|
| 前提の明示 | §4（列挙と取り消しの成功、門の再作成なし、単一 Router）|

## 14. v5.1 → 実装（T-Z1〜T-Z8、2026-10-20。Codex 実装レビュー 1・2 回目の指摘と、wire で見つかった差分）

実装は v5.1 の設計どおりで、次の点だけ設計の文面より具体化・修正した（設計の意図は変えていない）。

| 事項 | 実装 | 由来 |
|---|---|---|
| 受信 rail の解決 | `profileIdOfBinding`（`src/main.ts`）が `private\|<profileId>\|<METHOD>\|<url>\|<intentSha256>` の束縛からもプロファイルを引く（§3.1 の束縛は受信レグの rail を同じプロファイルの受信 rail に写す）。これが無いと実合成で purchase が 500 になった | wire（実合成）で発見 |
| verify の check 文字列 | `CHECK_DELIVERY_PROOF` / `CHECK_REQUEST_PROOF`（`src/private/attest.ts`）は lab バイナリの実際の文字列 `UltraHonk delivery proof verified against verifier-derived VK` / `UltraHonk request-binding proof verified against verifier-derived VK` | wire で発見（偽バイナリの文字列が実物と違っていた）|
| MCP の出力 schema | 秘匿 4 ツールに専用の `outputSchema`（`privateQuote`/`privatePurchase`/`privateAttest`/`privateRecord`）。attest の `status` は文字列（`delivered_private`/`unknown`）で、失敗の HTTP 状態は `httpStatus`。流用していた `purchase` の schema（`status: number`）では SDK の出力検証で isError になった | 実 stdio の MCP 子を通す wire で発見 |
| 保持期限と検証の競合（§3.5・§3.7） | 保持期限が来たら取得は 410（`private_record_expired` を先に追記）にするが、受理済み（待ち行列・実行中）の検証があれば**入力ファイルと容量の計上は検証ジョブの終わりまで残す**（`expiredDuringAttest`）。期限切れの record には attest できない（`attest_closed`）。設定は `retentionMs ≥ attestTimeoutMs + verifyTimeoutMs` を要求（`ConfigError`） | Codex 実装レビュー 2 回目 1 |
| 領収の生ヘッダ | journal・射影には Provider の領収ヘッダの **sha256**（`destination.receiptSha256`、射影 `private.outbound.receiptSha256`）と検証済みの tx 参照だけ。生のヘッダは認証済みの record にだけ（Provider が反射した文字列を Router 側の面に出さない） | 同 2 |
| 検証の例外 | `runner.verify` が例外を投げた・起動できない・シグナルで終わった（結果が無い）ときは、受理した digest の結果として固定の `unknown/private_verifier_unavailable` を他の検証失敗と同じ経路で永続化する（`attesting` のまま残らない）。非 0 終了・形の不一致は `private_attest_invalid`、期限は `private_verify_timeout` | 同 5 |
| 再構成の停止点 | `duringRecoveryInventory` は `runner.inventory(workDir, onGatesCancelled)` の callback（門を外した後・pid の棚卸しの前。§4・§11 の文面どおり） | 同 3 |
| 予約の追記失敗 | `reservePrivateIssuance` が `unavailable` なら、もう一度追記せず固定の `unknown/private_issuance_unknown` を返して受付を閉じる（`persistenceLost`。成果物と計上は残す） | 同（前回 2 の残り）|
| 通常の動的購入の journal | `source_settled` の `eventId` は秘匿購入だけ（通常の行は不変。`dynamic-integration.test.ts` に回帰の assert） | 実装レビュー 1 回目 8 |
| wire の範囲（§11） | GET の全経路、実 stdio の MCP 子、verify の wrapper 3 段 + 公開と exec の間の kill、遅れた公開の不在、棚卸し中（門の後・pid の前）の kill、否定ケースの固定コード（`intent_mismatch`/`in_progress`/`nonce_mismatch`/`attest_not_ready`/`attest_foreign`/`attest_closed`/`attest_expired`/`private_session_timeout`/`private_attest_invalid`）、掃除前の作業ディレクトリの写しと符号化を解いた canary、診断ファイル、executor の秘密（salt・blinder・eph 鍵）の走査 | 同 3・4 |
| 受入（T-Z8） | `tools/private-payer.ts`（Payer 側の手順、支払い範囲の記録が無ければ実 Provider に払わない、5 ゲート別の証跡）、`tests/acceptance/private-live.test.ts`（`PRIVATE_LIVE_AC=1`、owner 実行、ゲートごとの test）、`docs/zktls-router-acceptance.md` | タスク T-Z8 |

wire の証跡は `lab-fixture-ca` の **synthetic**。実 Provider（C/F/A/B）の受入は owner のゲート（`docs/zktls-router-acceptance.md`）で、本フェーズでは**未実行**。

### 14.1 Codex 実装レビュー 3 回目（最終 1 回目、2026-10-20）の指摘と対応
| 指摘 | 対応 |
|---|---|
| 1 承認の 2 回起動が、見た quote を買っていない（毎回 keygen と quote をやり直す） | `tools/private-payer.ts`: quote 止まりの起動が `checkpoint.json`（0600: quote 文書・ownerKey・requestId・注文・引数・`quote.json` の sha256）を書き、`--approve` は同じ `--out` の再開点を**再開**する（keygen・quote 無し）。別 `--out`・引数違い・`quote.json` の改変・quote の期限切れ・引き渡し済みは拒否。wire で 2 回起動と各拒否を試験 |
| 2 失敗時の証跡が受信決済を「未決済」と書く・ownerKey が残らない | ゲートは分かった時点で書く（引き渡し直後に status から受信 tx、attest・復号の後にそれぞれ）。失敗後は読み取り専用の status で補い、purchase の応答喪失・`unknown` は両決済に `uncertain: true`。ownerKey は `checkpoint.json` に。`--recover`（`recoverPrivatePayer`）が別プロセスから status・record を読み直し、bundle があれば復号。wire で引き渡し後の失敗と回復を試験 |
| 3 私的 x402 の領収が payer 欠落を通す | `createPrivateX402Rail.checkReceipt` は領収に **payer が存在し署名者と一致**することを要求（欠落・null・別アドレスは `destination_receipt_payer_mismatch` → core は `unknown/private_receipt_mismatch`）。動的経路は不変 |
| 4 timer の上限（2^31−1 ms）を越える期限が即座に満了する | `scheduleAt(untilMs)`: 上限で刻んで待ち、発火のたびに絶対時刻を確かめる。設定は各期限を 2^31−1 ms 以下に限る（`ConfigError`）。単体で 30 日の保持期限が即座に満了しないことを確認 |
| 診断の code・op の集合 | `src/shared/diagnostics.ts` に秘匿購入の固定 code（SAFE_REASONS の追加分・終端理由・attest/record の code）と op `private_probe`/`private_rpc` を登録（既存の抽出テストが要求） |
| x402 受信の `eventId` | credential のオブジェクトを 2 度読まない（`payloadOf` の写しから `nonce` を取る。hot path は `JSON.stringify` 1 回・要求本文の parse 無し、既存の cid の試験が要求） |

### 14.2 Codex 最終レビュー 2 回目（2026-10-20）の指摘と対応
| 指摘 | 対応 |
|---|---|
| 1 受入テストが同じ起動で quote と承認を続け、owner が quote を読む機会が無い | `tests/acceptance/private-live.test.ts` は **1 回の起動で 1 つの操作**（`PRIVATE_LIVE_MODE=quote|approve|recover`）。approve/recover は owner が明示する `PRIVATE_LIVE_EVIDENCE_DIR`（`checkpoint.json` のあるディレクトリ）を再開し、新しい quote・本文を作らない。approve の test は再開点の paymentId・intentSha256・`quote.json` の sha256 が買われたものと一致することを確かめる。手順書 §5 |
| 2 拒否された起動が証跡を上書きする・引き渡し後に status が読めないと受信決済が false のまま・回復が証跡を初期化する | 証跡は既存を読み**単調に**更新（`loadEvidence`）。購入に触れる前の拒否は `evidence.json` を触らず `refusals.json` に追記。引き渡し = 受信決済 済みを status の可否によらず記録（tx は読めた分）。`--recover` は既存の証跡を引き継ぎ、提出済みで結果不明なら両決済を `uncertain`。wire で拒否後の証跡不変・CLI 別プロセスの `--recover` を試験 |
| 3 応答を失った購入のあとで再承認が可能（二度署名し得る） | 署名・提出の**前**に再開点へ `purchaseAttempted` を書く（耐久の latch）。以後の `--approve` は拒否し `--recover` へ。wire で latch 後の承認が署名も購入要求も起こさないこと（facilitator の verify 回数不変）、期限切れ・`quote.json` 削除の拒否を試験 |
| `allowUnissuedQuotes` の注記 | 再開は client の控え照合を飛ばすので、保証は再開点（ローカルの権威、`quote.json` の sha256 で改変検出）と Router 側の束縛の検査による旨をコードの注記に明記 |

### 14.3 Codex 最終レビュー 3 回目（2026-10-20）の指摘と対応
| 指摘 | 対応 |
|---|---|
| 1 回復の証跡が別ファイルで、次の回復や再復号の失敗で確立した事実が後退する | 証跡は `evidence.json` **1 つ**に単調に併合（`--recover` も同じ）。復号の結果は `ok: true` を失敗で上書きしない（`mergePayerReceipt`）。status・record が読めない・再復号の失敗は `recovery-log.json` に追記。wire で「Router を止めた状態の回復（再開点と同じ URL）が通常の経路で返り、確立した受信 tx が残り、status/record の失敗が `recovery-log.json` に残る」「bundle を壊した再回復でも `payer_receipt.ok` が残る」「別 URL は identity の検査で拒否」を試験 |
| 2 latch の書き込みが耐久・原子的でない | 再開点・証跡・記録は `writeDurable`（一時ファイル 0600 → fsync → rename → 親ディレクトリの fsync。rename の前の失敗なら前の内容が残り、rename の後の失敗なら latch つきの新しい再開点が置かれたまま → 以後の承認は拒否し `--recover` へ）。wire で、故障注入（write / fsync / rename / 親ディレクトリの fsync の各段）で latch が書けないとき署名も購入要求も起きないこと（rename の前の失敗では前の再開点が無傷、rename の後の失敗では latch つきの再開点が残り以後の承認は拒否）、latch 直後の割り込みの後の新しい起動が署名せず拒否すること、残骸（`.tmp`）が無く常に読める JSON であることを確認（試験専用の `hooksForTest`） |

### 14.4 Codex 最終レビュー 4 回目（2026-10-20、APPROVE WITH CHANGES）の指摘と対応
| 指摘 | 対応 |
|---|---|
| 1 「Router に届かない回復」の試験が identity の拒否で早期に返っていた | Router を止めて再開点と同じ URL で回復し、通常の経路で返ること・確立したゲートの保持・`recovery-log.json` の status/record の記録を assert（§14.3 の記述も修正）|
| 2 耐久書き込みの試験が成功経路だけ | `hooksForTest.durableFail`（write/fsync/rename/dirfsync）と `afterLatch`（割り込み）の故障注入を追加し、latch が書けなければ署名・提出が起きず前の再開点が無傷、割り込み後の新しい起動は拒否、を assert |

### 14.5 Codex 最終レビュー 5 回目（2026-10-20、**APPROVE**）
nit 1 件（耐久書き込みの文言: rename の前後で「前の再開点が残る／latch つきの再開点が残る」を区別）を反映。実 Provider C/F/A/B の受入・両チェーンの読み取り・finality は owner のゲートのまま（未実行）。

### 14.6 受入の実行記録（2026-10-20/21 UTC、owner の testnet 包括承認のもと作者が実行。実合成 `tools/remote-router-process.ts` + `tools/private-payer.ts`）
| Provider | 結果 | 受信 tx（Base Sepolia） | 送信 tx | 平文 | 証跡 |
|---|---|---|---|---|---|
| C（x402 POST `/select`） | **delivered_private**、5 ゲート成立 | `0x2feed4c9…5a68`（11000 USDC、21 conf） | `0x7c0a4a81…97de`（10000 USDC → 0x9014…、20 conf） | `select-post-c` / `lab.select.v1`、`received_sha256` = 承認本文 | `.claude_workflow/local/zktls-live-C-20261021.json` |
| A（x402 GET `/v1/eth/snapshot`） | **delivered_private**、5 ゲート成立 | `0xf08deae2…ba36` | `0xf72ed059…3593` | `market-data-a` 400 B | `zktls-live-A-20261021.json` |
| B（Tempo pull GET） | **delivered_private**、5 ゲート成立 | `0xea9b641e…3071` | Tempo `0xd482e92b…3b25`（10000 pathUSD + fee 29、59 conf） | `market-data-b` 704 B | `zktls-live-B-20261021.json` |
| F（Tempo pull POST） | **未成立**（Provider 側） | 3 件決済（各 11000 USDC） | 無し（pathUSD 不変） | — | `zktls-live-F-20261021-diagnosis.json` |

F の経緯: (1) 1 回目は purchase の再照合で `offer_changed`（資金移動なし）。原因は Tempo の offer の比較条件に `opaque` の `_mppx_nonce`（mppx 0.13 が 402 ごとに更新）が含まれていたこと → `comparableMetaOf` で除外（§14.5 の後の修正、単体テスト追加）。(2) 修正後は引き渡しまで進むが executor が「status line not 200」で失敗。(3) 診断（`--stop-after-handover` で発行直後の credential を直接送信）で Provider F が **HTTP 500 `internal-payment-error`** を 0.3 秒で返すことを確認。Router の credential は形式・expiring nonce・validBefore（+25 s）・memo とも正常で、同じ Tempo pull credential は Provider B で成立した。Provider F（owner デプロイの Worker）側の確認（`wrangler tail`、`TEMPO_RPC_URL`、Durable Object）が要る。
Router 側の budget の注意: 動的予算は 1 件の両レグを同じバケットで合算する（USDC 21000/件、Tempo は送金 + fee cap 210000/件）。受入の設定は `runtime/private-live/router.config.json`（git 管理外）。

