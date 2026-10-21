# zkTLS 秘匿購入: 第三者 Provider への最小の実利用経路（増分 v1.1）

**位置づけ**: `docs/zktls-router-requirements.md` v3.3・`docs/zktls-router-design.md` v5.1（§14 実装記録、§14.6 受入記録）・`docs/zktls-router-tasks.md` v1.1 の上に載せる**増分**。
要件・設計・タスクを 1 つの短い文書にまとめる（小さな増分に全体計画の再レビューは要らない。`docs/zktls-router-tasks.md` 作業規律）。
v1 の Codex レビュー（`.claude_workflow/local/zktls-3p-design-review1.md`、**APPROVE WITH CHANGES**、should 6 件）を v1.1 に反映した（§7）。
worktree `subetha-router/zktls-router-20261020`（branch `task/zktls-router`、HEAD `f14b5e2`）。owner の依頼（2026-10-22、引き継ぎ書 `02-ROUTER-ZKTLS.ja.md`）: 「既存の zkTLS 統合を維持し、保存済みの成果と現在の実装を照合して、**既存の第三者 Provider を使う最小の実利用**への不足を特定し、許可範囲内で実装・ローカル検証まで進める」。

## 0. 現状の照合（2026-10-22 JST、この worktree で実測）

| 対象 | 保存済みの記録 | 今回の確認 |
|---|---|---|
| 実装 T-Z1〜T-Z9 | `.claude_workflow/state.json`（DONE locally）、Codex 最終レビュー 5 回目 APPROVE、8 回目 APPROVE | `git status` clean、HEAD `f14b5e2`。state の `phase` 文字列は live 未実施のままだが、`live_acceptance` 欄・設計 §14.6・受入 §8・commit `04854dc`/`f14b5e2` に C/A/B/F の `delivered_private` が記録されている（文字列の古さであって未実施ではない） |
| 単体（private 群） | — | `tests/unit/private-{intent,attest,x402-issue,client,config}.test.ts` + `mcp-private`: **76 passed**（`.claude_workflow/local/zktls-3p-unit-baseline-20261022.log`） |
| wire（lab 実バイナリ・fixture CA） | run11: 10 passed / 1 skipped | **run12: 10 passed / 1 skipped、183 s**（`zktls-wire-run12-all.log`）。synthetic（`lab-fixture-ca`）であり公開 PKI の受入ではない |
| lab バイナリ・SRS | sha256 `1b3180c8…f18f` / `7eaff854…fb25` | 同一（`shasum`）。lab worktree は別担当のプロセスが cwd に持つので**読むだけ**。バイナリは変更しない |
| 受入用 Router（`runtime/private-live/`） | §14.6 の実行に使った実合成の設定・journal | プロセスは停止済み（`router.pid` の pid は無い）。設定は 4 プロファイル（`priv-{c,a,f,b}-*`）だけ |
| 自社 Provider の live | C/A/B/F 4 件 `delivered_private`（5 ゲート、両チェーン読取） | 過去の成功であり、今の runtime の成功でも第三者 Provider 対応の証明でもない |

**第三者 Provider の実決済は未実施**（本文書の到達点は「ローカル実装 + 事前互換検査 + owner ゲートの準備」まで。実送金は §6 の別承認の後）。

## 1. 第三者 Provider が満たすべき条件（どこで固定されているか）

秘匿購入の経路は、変更しない外部バイナリ（lab `delivery`、phase3 ソース）と Router の検査の両方で縛られる。第三者 Provider を「使える」とは、以下を**全部**満たすこと。

| # | 条件 | 固定している場所 | 未払いで確かめられるか |
|---|---|---|---|
| B1 | TLS 1.2 で `TLS_ECDHE_{ECDSA,RSA}_WITH_AES_128_GCM_SHA256` のどちらかを選ぶ（MPC-TLS の対応 suite） | バイナリ（tlsn）。Router の quote は `limits.tls` として開示 | **可**（suite を絞った handshake） |
| B2 | 要求は HTTP/1.1 の固定骨格 `GET <path> HTTP/1.1\r\nHost: <host>\r\nConnection: close\r\nPAYMENT-SIGNATURE: <値>\r\n\r\n`（`Accept`・`User-Agent` 等は無い）。全長 ≤ 4096 B、ヘッダ値 ≤ 3072 B | バイナリ `request.rs` = Router `src/private/attest.ts` `expectedPrefixOf` | **可**（同じ骨格で未払い要求を送り、応答の形を見る） |
| B3 | 有料応答は **`HTTP/1.1 200 OK`** ちょうど、`Content-Length` が 1 つ（`Transfer-Encoding` 無し、`Content-Encoding` は identity のみ）、本文 **1..=704 B**、受信全体 ≤ 16 KiB | バイナリ `tls.rs` `validate_response_framing`、`MAX_PAYLOAD=704`、`MAX_RECV_DATA` | **不可**（支払った応答の framing・大きさは払うまで分からない。402 の framing と公開情報からの**推定**だけ） |
| B4 | 有料応答に領収ヘッダ `PAYMENT-RESPONSE`（または `X-PAYMENT-RESPONSE`）が**ちょうど 1 つ**、`success: true`・`transaction` bytes32・`network` 一致・**`payer` = Router の送信鍵** | Router `attest.ts` `receiptHeaderOf`、`private-x402.ts` `checkReceipt`（FR-Z08） | **不可**（v2 の facilitator（x402.org / CDP）の settle 応答は `payer` を含むので、v2 の middleware なら満たす見込み） |
| R1 | 未払い GET に **402** + `PAYMENT-REQUIRED`（x402 **v2**）、`resource.url` が要求した URL と**完全一致**、`accepts` ≤ 16 | Router `x402-dynamic.ts` `getChallenge` | **可** |
| R2 | `accepts` に `exact`・`eip155:84532`・USDC `0x036C…CF7e`・`extra {name: USDC, version: 2}`（他の `extra` 鍵は限定）・`maxTimeoutSeconds` 1..600・`amount` ≤ プロファイルの `maxUpstreamAmount`・`payTo` が運用者でない offer が 1 つ | Router `checkDynamicX402Offer`、`createPrivateX402Rail` | **可**（運用者アドレスの除外だけは Router 側で） |
| R3 | 受信は Base Sepolia USDC の x402 のみ（FR-Z13）、送信は x402 EVM（本増分は Base Sepolia）か Tempo pull | Router `parsePrivate`、`createPrivateX402Rail`（署名能力の network と一致） | 設定 |
| R4 | host は小文字 DNS 名（IP 不可）、path は `/` 始まり・クエリ無し・≤ 256 B・正準、port 443（FR-Z28）。`denyHosts` に無い | Router `src/private/intent.ts`、`parseUpstreamUrl` | **可**（I/O の前） |
| R5 | POST は lab 契約の `/select`・`X-Lab-Credential` 穴（Provider C/F の契約）に限る | Router `intent.ts` `CANONICAL_POST_PATH`、バイナリ | — |

したがって**第三者で使えるのは公開 GET（framing `phase5-get-public-v1`、本文無し、要求束縛証明無し・配送証明のみ = Z3 と同じ型）**。POST の秘匿本文は lab の Provider 契約（C/F）に限られ、本増分では対象外（R5）。

## 2. 候補の調査（未払い・読取のみ。支払いも署名もしていない）

1. CDP の公開 discovery（`/platform/v2/x402/discovery/resources`、全 28,406 件）を読み、`eip155:84532` の offer を持つもの **1,565 件**を集めた。
2. GET の形（path にパラメータ `:x` やクエリが無い）・USDC・`extra` USDC/2・**額 ≤ 10,000 atomic**・x402 v2 の条件で **1,432 件 / 56 ホスト**。ホストごとに 1 件を選び、B1・B2・R1・R2・R4 を**未払いの要求 1 回**（suite を 2 つに絞った TLS 1.2 + 上の骨格から支払いヘッダを除いたもの）で当てた。
3. 結果（生データ `.claude_workflow/local/zktls-3p-probe-20261022.json`、git 管理外。本文は保存していない）: **38 ホストが未払い条件をすべて通過**（TLS 1.2 + 対応 suite、402 + v2 ヘッダ、`resource.url` 一致、Base Sepolia USDC の offer）。通らなかった 18: 404/405/409/200（一覧が古い・POST 専用・方式違い）10、`resource.url` 不一致（クエリ付き・別ホスト）3、Base Sepolia 以外の offer のみ 2、名前解決不可 1、Vercel で 402 が chunked（有料応答も chunked の可能性）1 は通過側に数えたが候補から外す。
4. **B3（応答 ≤ 704 B・`Content-Length`）は払うまで分からない**。推定の材料: (a) 402 が `Content-Length` で返る（Cloudflare Workers 由来のホストは全部そう。Vercel は chunked）、(b) 公開の説明に応答が小さいと書いてある、(c) この repo の過去の実決済記録。

**選定**: `GET https://tollbooth-hello-testnet.sjwilliams8.workers.dev/hello`（1,000 atomic = 0.001 USDC、payTo `0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B`、`maxTimeoutSeconds` 300）。
理由: 額が最小、Cloudflare Workers（402 は `Content-Length`、`cf-ray` 等の応答ヘッダ合計 ≈ 2.9 KB で 16 KiB の内側）、公開の自己説明が「静的な挨拶を返す smoke test 用」、**この repo の過去の記録で 2 回決済成立**（2026-10-05 静的 adapter で `paid`、同日 G-3 で動的経路 `ok`、`docs/dynamic-upstream-design.md`。ただし応答の大きさは記録されていない）。
控え（同じ未払い条件を通過、額 1,000）: `x402-test.genesisblock.ai/api/joke`（CDP facilitator、`{data, meta}` 封筒）、`shelf-production-43b5.up.railway.app/v1/sepolia/block-height/q1`、`wallet-services-poc-clean.3hz-services.workers.dev/fx-rate`。**選定は owner が §6 で確認する**。

## 3. 不足（現在の実装と第三者 Provider の最小経路の差分）

| # | 不足 | 根拠 |
|---|---|---|
| G1 | **事前互換検査の道具が無い**。既存の `tools/dyn-challenge-survey.ts` は欄の形だけを出し、TLS 1.2 の suite・固定骨格・`resource.url`・offer 規則・402 の framing を当てず、Payer の封筒に要る値（payTo・額）も出さない | §1 の B1/B2/R1/R2/R4 は未払いで検査できるのに、今は手作業の probe しか無い |
| G2 | **受入の雛形が自社 4 Provider に固定**。`tests/acceptance/private-live.test.ts` の `LIVE_PROVIDERS` は C/F/A/B の表で、平文の検査が `providerId` の契約（`market-data-a` 等）。`tools/private-payer.ts` は値を引数で手入力（転記ミスで `intent_mismatch` か、別の受取先への承認） | 第三者の値は事前検査の出力から**そのまま**渡すべき |
| G3 | **手順書に第三者 Provider の節が無い**（支払い範囲の記録の書き方、B3/B4 が払うまで分からないこと、超過時の帰結、再試行の規則） | `docs/zktls-router-acceptance.md` は C/F/A/B 専用 |
| G4 | Router コア（quote → 探り → 発行 → Verifier → attest → record）は**変更不要**（静的読取: R1〜R4 は設定と既存規則で満たせる。`HOSTNAME` は `*.workers.dev` を通す、`parseUpstreamUrl` の拒否は `denyHosts` のみ、領収は `payer` 必須のまま） | 第三者 1 件のために汎用 Provider 基盤・模擬 Provider を作らない（引き継ぎ書の非目標） |

## 4. 増分の設計

### 4.1 `tools/private-provider-precheck.ts`（G1。製品コードではない。何も払わない・署名しない）
- 入力: `--url https://<host><path>`（GET のみ）、`--max-amount`（既定 `10000`）、`--out <dir>`（`provider.json` を 0600 で書く）。試験専用: `--ca <pem>`（trust に足す）・`--connect 127.0.0.1:<port>`（TCP の行き先の差し替え。`--ca` と組でのみ）。network/asset は Base Sepolia USDC 固定（R3。Router の私的 x402 送信は署名能力の network に限る）。
- I/O の前（R4）: `parseIntent` と同じ host/path 規則（`src/private/intent.ts` の `HOSTNAME`/`PATH`・256 B・正準・port 443 を URL に書かない）と `parseUpstreamUrl({denyHosts: []})`。
- 接続先（Router の動的 transport と同じ方針）: 期限つき（5 s）の名前解決（`dns.lookup`、全アドレス）→ 解決した**すべて**のアドレスを `classifyAddress`（`src/net/destination-policy.ts`: loopback・自アドレス・特殊用途を拒否）に通し、1 つでも拒否なら `address_denied`、解決できなければ `dns_failed` → 通った先頭のアドレスへ接続（SNI と証明書の検査は host 名のまま）。`--connect` は試験専用の loopback（`127.0.0.1:<port>` だけ）の差し替えで `--ca` と組でしか使えず、その結果は **synthetic**（下）。
- 接続（B1）: `node:tls` で `minVersion = maxVersion = TLSv1.2`、`ciphers = "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256"`、SNI = host、ALPN 無し（lab と同じ）。`rejectUnauthorized: true`。`--ca` はその CA **だけ**を信頼する（公開 PKI の代わり。試験専用）。
- 要求（B2）: `GET <path> HTTP/1.1\r\nHost: <host>\r\nConnection: close\r\n\r\n`（支払いヘッダを除いた lab の骨格そのもの）。受信は 16 KiB（`MAX_RECV_DATA`）+1 まで、10 s。
- 応答の検査: 状態行 `HTTP/1.1 402 …`、ヘッダは `parseRecvHeaders` と同じ構文（obs-fold 不可）、`payment-required` がちょうど 1 つ → `decodePaymentRequiredHeader` → `x402Version === 2`、`accepts` 1..16、`resource.url === url`（R1）。402 の framing（`Content-Length` 1 つ・`Transfer-Encoding` 無し・`Content-Encoding` 無しか identity）を**観測として記録**（B3 の推定材料。合否ではない）。
- offer（R2）: `checkDynamicX402Offer(entry, profile, [])` を**そのまま**使う（`profile` = `{rail: "x402", destination: {scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6, tokenDomain: {name: "USDC", version: "2"}}, maxUpstreamAmount}` の最小の写し）。上流の順で最初に通る 1 件を選ぶ。運用者アドレスの除外は Router が quote で行う（道具は知らない。出力に明記）。
- 要求長（B2）: `expectedPrefixOf` の GET 形に 3072 B のヘッダ値を入れた全長が 4096 B 以下（= prefix ≤ 1024 B）。
- 出力 `provider.json`（Payer の封筒の値。`tools/private-payer.ts --provider-file` が読む）: `{version: "private-provider-v1", method: "GET", host, path, url, outbound: {protocol: "x402", network, asset, payTo, maxAmount: <offer.amount>}, observed: {synthetic, trust: "mozilla"|"test-ca", tlsVersion, cipher, status: 402, httpVersion: "HTTP/1.1", framing402: "content-length"|"chunked"|"other", headBytes402, acceptsCount, maxTimeoutSeconds, skeletonBytes}, notVerified: [B3, B4 の文], checkedAt}`。stdout には同じ JSON と固定の理由コード。**402 の本文・状態行の reason phrase・ヘッダの値・例外文字列は出さない・保存しない**（状態は数字だけ。`cf-ray` 等の値も出さない。欄の名前と大きさだけ）。**意図した例外**: 支払い条件（`payTo`・額・`maxTimeoutSeconds`）は `PAYMENT-REQUIRED` の値そのもので、`checkDynamicX402Offer` の形の検査を通ったものだけを出す。`--ca`/`--connect` で得た観測は `observed.synthetic: true`（公開 PKI・実アドレスの観測ではない。`tools/private-payer.ts` は `--trust mozilla` でこれを拒む）。
- 失敗は固定コード: `url_invalid`・`connect_invalid`・`dns_failed`・`address_denied`・`tls_handshake`（suite/version/証明書/名前）・`not_402`（数字の状態を添える）・`recv_headers`（obs-fold 等）・`no_payment_required_header`（0 個か 2 個以上）・`undecodable`・`version`・`no_offers`・`too_many_offers`・`resource_mismatch`・`no_acceptable_offer`（最初の offer の拒否理由を添える）・`request_too_long`・`recv_too_large`・`timeout`。

### 4.2 `tools/private-payer.ts` と受入の雛形（G2）
- `--provider-file <provider.json>`: `readProviderFile` が**実行の前に**形を検査する（版 `private-provider-v1`、`method: "GET"` のみ、host/path が `checkTarget` を通る、`url === https://<host><path>`、`outbound` が x402・Base Sepolia・USDC・EVM アドレスの `payTo`・10 進の `maxAmount`、`observed.synthetic` が boolean）。通れば `method`/`host`/`path`/`outbound` を**そのまま**写す（手入力 8 引数 `--method/--host/--path/--outbound-protocol/--outbound-network/--outbound-asset/--outbound-pay-to/--outbound-max-amount` と**排他**。1 つでもあれば exit 2）。ファイルの sha256 は `evidence.json` の `providerFileSha256` と `checkpoint.json` の `args.providerFileSha256` に入る: 承認で違えば既存の「引数が違う」拒否（署名も購入要求も無し）、回復は証跡を単調に保つ。`observed.synthetic: true` のファイルは `--trust mozilla` で前提の段で拒む（実 Provider の購入に試験の観測を持ち込まない）。
- `tests/acceptance/private-live.test.ts`: `PRIVATE_LIVE_PROVIDER=X` で `PRIVATE_LIVE_PROVIDER_FILE`（事前検査の `provider.json`）を読む。ゲート 4 の平文検査は第三者では契約を知らない（JSON とも限らない）ので **「手元の bundle 検証が先、1..=704 B、sha256 が `decryptedSha256` と一致、`providerFileSha256` が証跡にある」**（配送の事実の検証であって内容の検証ではない旨を test 名に書く）。JSON object の検査は応答契約を知る自社 C/F/A/B だけ。C/F/A/B の表と検査は不変。
- どちらも**新しい PoC・模擬 Provider ではない**: 既存の道具に入力経路を 1 つ足すだけ。

### 4.3 文書（G3）
- `docs/zktls-router-acceptance.md` に §9「第三者 Provider（公開 GET）」: 事前検査 → `provider.json` → 支払い範囲の記録（Provider・payTo・額・`maxPurchases`）→ quote → owner 読取 → approve → 証跡。**B3/B4 は払うまで分からない**: 応答が 704 B を超える・chunked・領収が無いときは executor か attest が失敗し、**受信レグ（Payer → Router、2,000 atomic）は既に決済済み**、送信レグ（Router → Provider、1,000 atomic）は `unknown`（Provider が決済済みのこともある。**払ったかもしれない**）。自動の返金は無い。framing で落ちた場合は record も bundle も残らず復号の救済も無い。再試行は owner が証跡と両チェーンを読んでから別の承認で。
- `docs/zktls-router-design.md` §14.7 に本増分の記録、`docs/zktls-router-tasks.md` 末尾に T-3P 行、`.claude_workflow/state.json`。

## 5. タスク

| # | タスク | 変更 | 受入 |
|---|---|---|---|
| T-3P1 | 事前互換検査の道具 | 新規 `tools/private-provider-precheck.ts`（§4.1）、`src/private/intent.ts` の host/path 規則を `checkTarget` として export（挙動不変） | 新規 `tests/wire/private-provider-precheck.test.ts`（**lab 不要**、`generateTestTls()` = openssl の EC 証明書、TLS 1.2 固定・`ECDHE-ECDSA-AES128-GCM-SHA256` の HTTPS fixture + raw TLS fixture に `--ca` + `--connect`）。正: 402 + v2 + 一致 → `provider.json`（0600、値が fixture の offer と一致、`synthetic: true`、`notVerified` 2 件）、要求が lab の骨格（`GET`・`Host`・`Connection: close` だけ）、出力に本文・ヘッダ値・reason phrase が無い（成功・失敗とも canary）、CLI の exit 0/1。負（固定コード）: 200、`resource.url` が別、v2 ヘッダ無し、`x402Version: 1`、mainnet の offer だけ、額超過（後ろの offer が通れば選ぶ）、offer 17 個、TLS 1.3 のみ、別の CA、名前違いの証明書、`PAYMENT-REQUIRED` 2 つ、obs-fold、応答が来ない（timeout）、16 KiB 超、非正準 URL 9 種は I/O 無し、`--connect`/`--ca` の片方・loopback 以外、改変した `provider.json`（path のクエリ・url 不一致・版・method・outbound の各欄・`synthetic` の型・大文字 host）。観測: chunked の 402 は通過し `framing402: "chunked"` |
| T-3P2 | 入力経路と受入の雛形 | `tools/private-payer.ts`（`--provider-file`、`withProviderFile`、`providerFileSha256`・`providerSynthetic`）、`tests/acceptance/private-live.test.ts`（`X` + `PRIVATE_LIVE_PROVIDER_FILE`、汎用のゲート 4） | 新規 `tests/unit/private-payer-provider-file.test.ts`（**lab 不要・Router 不要**）: 壊れた `provider.json` 10 種は `undefined`、CLI の併用 8 通りと読めないファイルは exit 2 で何も書かない、synthetic + `mozilla` は前提の段で拒む（`lab-fixture-ca` なら通る）、承認時に `provider.json` のバイト列が違えば `approve` で拒み（latch 無し・`refusals.json`・証跡の `providerFileSha256` は quote のまま）、同じバイト列なら次の段へ。既存 wire `private-x402.test.ts` に 1 ケース（lab）: fixture を事前検査して書いた `provider.json`（synthetic）を `--provider-file` 相当で渡し、quote → 改変した承認は拒否（settle 不変）→ 元に戻して approve → `delivered`（`providerFileSha256` が証跡と再開点にある、平文は証跡に無い）。受入テストはローカルでは skip（未検証と記録） |
| T-3P3 | 文書・状態・レビュー | §4.3 の文書、`state.json` | `npm test` の private 群と新規 wire が通る、`npm run types` は既存 2 件以外無し、Codex レビュー（本文書 → 実装 diff）APPROVE、ローカル commit（push しない） |

## 6. owner のゲート（実送金の前に別途承認。本増分では実行しない）

提示する内容（引き継ぎ書「外部実行前には対象、金額上限、鍵・支払元、再試行条件、回復方法を提示し、別の本人承認を得る」）:

| 項目 | 案 |
|---|---|
| 対象 | `GET https://tollbooth-hello-testnet.sjwilliams8.workers.dev/hello`（事前検査の `provider.json` の値に固定。他の候補は §2） |
| 金額の上限 | 受信 2,000 atomic USDC/件（上流 1,000 + Router 手数料 1,000）、送信 1,000 atomic USDC/件、`maxPurchases` 2（2 件目は 1 件目の証跡を owner が読んでから）。**合計の上限: 受信 4,000 + 送信 2,000 = 6,000 atomic USDC**（Router の USDC bucket は両レグを合算するので `maxPerPurchase` 3,000・`maxTotal` 6,000） |
| 鍵・支払元 | Payer `0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1`（既存の標準 Base Sepolia test payer、env だけ）、Router 受取先 `0xcD8eCC44D54d1E7a35b6625f681267ABa4ad47F5`、Router 送信鍵の公開アドレス `0x8763ce96fface4c7a92d40b049704632785b2b19`（§14.6 の受入と同じ鍵。Base Sepolia の送信 tx `0xf72ed059…3593` の Transfer から読取。Base Sepolia USDC 残高 ≥ 1,000 要）、Provider の受取先 `0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B`（事前検査の値） |
| Router 設定 | `runtime/private-live/router.config.json` に `priv-3p-x402-get`（受信 x402 Base Sepolia USDC → 送信 x402 Base Sepolia USDC、`maxUpstreamAmount` 1000、fee flat 1000）と `private.profiles` への追加、予算 bucket（USDC 2,000 + 1,000 = 3,000/件） |
| 再試行 | 無し。`unknown`（executor の失敗・attest 失敗・応答喪失）は「払ったかもしれない」。`--recover` で status/record を読む。再購入は新しい quote と新しい承認 |
| 回復 | record があれば `payer-decrypt`。両チェーンは owner が読取（受信 tx・送信 tx の Transfer と期待値）。B3 超過（> 704 B・chunked）や B4 不成立なら、**受信 2,000 atomic は決済済み**、送信 1,000 atomic は Provider が決済済みのこともある `unknown`、自動の返金は無く、framing で落ちた場合は record も bundle も残らない（復号の救済も無い）。損失の上限は 1 件あたり 3,000 atomic（0.003 USDC、testnet） |
| 証跡 | `runtime/private-live/x1/`（git 管理外）、`.claude_workflow/local/zktls-live-X-<日付>.json`、設計 §14.7 |

承認が無ければ何も払わない（`--scope-file` が無い起動はツールも受入テストも止まる）。

## 7. v1 → v1.1（Codex 設計レビュー 1 回目、APPROVE WITH CHANGES）
| 指摘 | 対応 |
|---|---|
| 1 接続先の安全（名前だけでは不十分） | §4.1: 期限つき名前解決 → `classifyAddress` で全アドレスを検査 → 通った実アドレスへ接続。`--connect` は loopback の試験差し替えに限定 |
| 2 reason phrase を出さない・支払い条件の例外を明記 | §4.1: `status` は数字、`httpVersion` 固定。支払い条件は `PAYMENT-REQUIRED` 由来の意図した例外。成功・失敗の出力に canary（試験） |
| 3 汎用ゲート 4 に JSON の契約を押しつけない | §4.2: bundle 検証 → 1..=704 B → sha256 一致 → 出所の記録。JSON object は自社 Provider だけ |
| 4 provider.json の検査と出所の保持 | §4.2: 版・GET・`checkTarget`・url 一致・outbound の表・`synthetic` の型を実行前に検査、手入力 8 引数と排他、sha256 を再開点の `args` にも入れて承認・回復で保持、synthetic は `mozilla` で拒否 |
| 5 損失の全体像と上限 | §4.3・§6: 受信 2,000 は決済済み、送信 1,000 は決済済みのこともある、返金無し、framing の失敗は record/bundle 無し、2 件の合計上限と全桁のアドレス |
| 6 lab 無しの試験 | §5: T-3P1 は lab 不要（証明書名・重複ヘッダ・obs-fold・timeout・16 KiB・非正準 URL を含む）、T-3P2 の入力検査は `tests/unit/private-payer-provider-file.test.ts`（lab・Router 不要） |

## 8. 実装レビュー（Codex、`.claude_workflow/local/zktls-3p-impl-review1.md`、APPROVE WITH CHANGES、should 6・nit 2）への対応
| 指摘 | 対応 |
|---|---|
| 1 上限を超えた受信を読み続ける | 上限を超えた時点で socket を破棄し `recv_too_large`（開いたままの応答で timeout を待たない）。raw fixture で 20 KiB を送って閉じないケースを試験 |
| 2 検査した provider.json と digest のバイト列が別 | `withProviderFile` は 1 回だけ読み、同じバイト列を `parseProviderFile` で検査して sha256。読めなければ `undefined` |
| 3 拒否の応答と回復で出所が崩れる | 証跡の `providerFileSha256` は quote で書き、承認では再開点の `args` と一致したとき（= 再開点の値）だけ、回復は再開点の `args` から復元。返された証跡・保存された証跡の両方と、証跡を失った回復（lab wire）を試験 |
| 4 単体が署名・ネットワークに触れる | 復元ケースは試験専用の `afterLatch` で**署名の前**に止める（latch は書かれ、署名・purchase 無し、以後の承認は拒否）。wire の fixture は loopback であることを名前に書く |
| 5 名前解決・方針の経路に試験が無い | `resolveVetted` を export し、試験専用 hooks（`resolve`・`interfaces`・`dnsTimeoutMs`・`dial`）で loopback/混在/自アドレス/特殊用途/解決失敗/期限/通過を試験。全経路で解決 1 回・検査済みアドレスへの dial を記録。hooks だけ（`--ca` 無し）は拒否 |
| 6 既存の provider.json が 0644 のまま | 0600 で新規作成した一時ファイルに書いて rename + chmod。既存 0644 を書き直す試験 |
| 7 `parseIntent` の拒否の優先順 | `checkHost` → port → `checkPath` の順に戻し、回帰ケースを追加 |
| 8 署名者の全桁と合計 | Router 送信鍵の公開アドレス（Base Sepolia の送信 tx の Transfer から読取）と、2 件の合計 6,000 atomic（bucket の `maxPerPurchase` 3,000・`maxTotal` 6,000） |
| その他 | 受入の注記から JSON object の文言を削除、wire の診断に平文を載せない |
| 再レビュー（`zktls-3p-impl-review2.md`、APPROVE WITH CHANGES、新規 1） 一時ファイルが予測できる名前で `w` | 乱数名の一時ファイルを `wx`（排他作成）+ 0600 で開いて rename。植えた `provider.json.tmp` と symlink の先が無傷で、残骸が無いことを試験 |

## 9. 実行記録（2026-10-22）
owner が §6 を承認（「承認します」）。事前検査（公開 host、synthetic でない）→ `runtime/private-live/x1/scope.json`（上限: 受信 4,000・送信 2,000、`maxPurchases` 2）→ 専用の Router 設定（`priv-3p-x402-get`、専用 journal、USDC bucket 3,000/6,000）→ quote（承認対象を §6 と照合: 受信 2,000 → `0xcD8e…47F5`、送信 1,000 → `0xb3e7…bF5B`、`GET /hello`）→ `--approve`。
結果: **1 回目で `delivered_private`、5 ゲート成立**（受信 tx `0x74cc1d6f…266f`、送信 tx `0xafc13f15…5045`、record `HTTP/1.1 200 OK` + `Content-Length: 326` + `PAYMENT-RESPONSE`、平文 326 B の JSON、両チェーン読取 322/332 conf）。B3/B4 は実測で成立。使用額は受信 2,000 + 送信 1,000 atomic（2 件目は未実行）。証跡 `.claude_workflow/local/zktls-live-X-20261022.json`、設計 §14.7。
