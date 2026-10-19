# zkTLS 秘匿要求 Router（private purchase）要件定義 v3.3

対象: 本 worktree（`subetha-router/zktls-router-20261020`、branch `task/zktls-router`、基点 `origin/main` `f4eb0ca`）。
要件フェーズの成果物であり、設計・実装は含まない。v1 は Codex の独立レビュー（`.claude_workflow/local/zktls-req-review1.md`、REJECT、
blocking 8 件・should 4 件）を受けて v2 に、v2 のレビュー（`zktls-req-review2.md`、REJECT、blocking 3 件・should 2 件）を受けて v3 に、v3 のレビュー（`zktls-req-review3.md`、REJECT、残 1 件）を受けて v3.1 に改めた（§9 に対応表）。

owner の依頼（2026-10-20）: 「SubEtha Router 自体を改修して、TLS と zkTLS を用いて、Router 側にリクエストの本文を見せないままにして、
Router が実行してもちゃんと指定された Provider に対して指定された内容を実行したことが検証できるようにする。これまで検証したテストネットの
自前 Provider でテストが通るところまで」。

## 1. 目的と到達点

現行 Router は Payer の代わりに上流へ HTTP 要求を送り、本文を受け取って返す（`docs/design.md` §1、動的上流 `docs/dynamic-upstream-design.md`、
POST 本文 `docs/dynamic-upstream-post-design.md`）。したがって Router は要求本文と応答本文を見る。

本件は **秘匿購入（private purchase）** を加える。Router は従来どおり受信レグで支払いを受け、送信レグの支払い credential を 1 件発行するが、
上流への要求そのものは **Payer の executor（MPC-TLS の prover）と Router の Verifier が共同で実行**する。Router（Verifier）が見るのは、
要求の公開 prefix（メソッド・path・Host・自分が発行した支払いヘッダ）、本文と隠し穴のハッシュ、応答の状態行・ヘッダ・長さ、配送証明・
要求束縛証明だけであり、**要求本文と応答本文は見ない**。応答を復号できるのは Payer だけである。

**Router が検証し記録するもの（主張の範囲）**: 「承認した Payer 鍵に対し、承認した要求（host・path・メソッド・本文 commitment・Router が発行した
支払いヘッダ）を含む MPC-TLS transcript が 1 つ、公開 PKI で認証した指定 Provider との間で受理され、`200` と領収ヘッダが返った」こと、および
「この intent に対して Router は送信 credential を高々 1 件発行した」こと。**主張しないもの**: Payer が同じ credential を他所に提示しなかったこと、
Provider 側の再生防止の普遍性、Router のネットワーク経路の帰属、応答内容の正しさ。より強い「1 回だけ実行された」主張は Provider 側の保証を別途要する。

到達点: ローカルの単体・wire テスト（無課金・loopback・試験用 trust）が通り、さらに owner のゲートの下で、これまでテストネットで検証した
自前 Provider（Provider C `provider-x402-post.subethalabs.com` = x402 の秘匿 POST、Provider F `provider-mpp-post.subethalabs.com` = MPP Tempo pull の
秘匿 POST、加えて公開 GET の A/B）に対する受入テストが通ること。

## 2. 所有権と参照（再実装・vendoring しない）

| 対象 | 所有 | 本リポジトリの扱い |
|---|---|---|
| zkTLS lab（`subetha-zktls-router` worktree `private-payment-binding-20261017`、phase3/phase5） | 別リポジトリ（同一 owner） | **外部依存**。Rust バイナリ `delivery`（MPC-TLS の prover/verifier・UltraHonk 証明・検証）、Noir 回路と SRS、TLS 試験用 fixture CA、Payer 側の手順はそのまま使う。**ソースを複製しない**。パス・sha256 は設定で与える。契約（§4.6）はバイナリの側に合わせ、バイナリは変更しない |
| Provider C / F（`phase5/providers/{x402,mpp}-post-worker`） | zkTLS lab（本人がデプロイ済み） | 読み取り専用の相手。発見契約（§4.3）を満たすことは lab 側で確認済み（未払い要求に本文へ依存しない 402） |
| Provider A / B / D | 別プロジェクト・Router リポジトリ | 読み取り専用の相手 |
| Router 本体 | 本リポジトリ | orchestrator・ports・adapters・journal・HTTP/MCP 入口・設定 |
| `@subetha/payer`（`packages/payer`） | 本リポジトリ | **本 v1 では変更しない**（Payer 側の executor は lab の Rust バイナリを直接使う。payer への統合は別フェーズ） |

## 3. スコープと優先度

| # | 経路 | 優先 | 状態要件 |
|---|---|---|---|
| Z1 | 受信 x402（Base Sepolia USDC）→ 秘匿 canonical POST → Provider C（x402、同一チェーン） | 最優先 | 本 v1。lab の live4 と同じ型 |
| Z2 | 受信 x402（Base Sepolia USDC）→ 秘匿 canonical POST → Provider F（MPP Tempo **pull**、クロスレール） | 次 | 本 v1。lab の live6 と同じ型。Router の既存 Tempo 送信は push 専用なので、pull の発行経路を新設する |
| Z3 | 同じ機構で公開 GET → Provider A / B（x402 / Tempo pull） | 次 | 本 v1（本文無し。要求束縛証明は無く配送証明のみ） |
| Z4 | Solana pull（Provider D） | 後続 | 要件は枠のみ。Router の既存 Solana 送信 adapter に「送らずに署名」を足せば到達可能であることを設計要件とする |
| Z5 | push 型（Tempo push）、`@subetha/payer` 統合、hosted Router への配備、Verifier の第三者運用・公開露出 | 対象外 | 本 v1 では未実施を明示 |

**有効化**: 秘匿購入を許すレール・ネットワーク・プロファイルは設定の明示的な allowlist（FR-Z13）で決め、既存の動的プロファイル全部を暗黙に対象にしない。

## 4. 機能要件

### 4.1 入口と契約（HTTP と MCP の両方。既存の静的・動的購入は一切変えない）
- FR-Z01 **秘匿 quote**（`POST /v1/private/quotes`、MCP `subetha_router_private_quote`）。入力: `profileId`（FR-Z13 の allowlist 内）、`requestId`、
  **intent の完全なバイト列**（Payer が作る §4.6 の `phase5-intent-v1` 封筒。`order` は骨格注文で支払いヘッダを含まない。`outbound`・`inbound` 欄の値は
  Router が quote の結果で検査する）。Router は intent バイト列をそのまま保存し、その sha256（`intentSha256`）を受信 offer の `routeBinding` に束縛する。
  返すもの: 受信 offer、承認対象（FR-Z14）、承認期限、`intentSha256`、`ownerKey`（動的購入と同じ持ち主の証明。以後の購入・状態・成果物取得に必須）。
- FR-Z02 **購入**（既存 `purchase` と同じ口。credential 必須）。受信レグは既存の規則（preflight → verify → settle、承認束縛、期限、予算）で成立させる。
  受信成立後、Router は (1) 発行予約（FR-Z06）、(2) 送信 credential を **1 件だけ、上流へ要求を送らずに**発行（FR-Z05）、(3) release 文書（§4.6）を journal に記録、
  (4) **Verifier を起動**（FR-Z07）、(5) Payer に `verifier {address}`・`releasedHeader {name, value}`・`release`（文書そのもの）を返す。状態は `awaiting_session`。
- FR-Z03 **attest**（`POST /v1/private/purchases/{paymentId}/attest`、MCP `subetha_router_private_attest`）。Payer は MPC-TLS セッション後に executor が作った
  **bundle**（証明と公開入力。平文を含まない）を送る。Router は Verifier の record と照合して検証（FR-Z08）し、成功なら `delivered_private`、
  失敗なら送信レグ **`unknown`**（理由 `private_attest_invalid`。資金が動いたかは分からない。FR-Z09）。同じ bundle の再送は同じ結果を返し（冪等）、
  別の bundle・別の購入の bundle・期限後の bundle は状態を変えずに拒否する。
- FR-Z04 **状態と成果物**（`ownerKey` 必須、所有 principal のみ）。射影に `private: {intentSha256, headerSha256, outbound: {issued, expectedRef?}, verifier: {trust, externalGate,
  requestLine, lenSent, bodyLen, status200, receiptHeaderName}, proof: {delivery, requestBinding}, deadlines: {credentialExpiresAt, sessionBy, attestBy}}` を載せる。
  **成果物の受け渡し**: `GET /v1/private/purchases/{paymentId}/record` は record がある購入（attest 成功後。attest が失敗・期限切れで `unknown` になった購入も、
  record 自体は検証済みの TLS 記録なので Payer の自衛のために返す）で Verifier の record と release 文書を返す（Payer の `payer-decrypt` に必要。本文を含まず、公開 prefix に
  Router 発行の支払いヘッダを含む。§4.5 の保管規則の対象。取得は保持期限まで繰り返せる）。応答本文・本文・salt・鍵は決して載せない。再起動後も状態は読める。

### 4.2 送信 credential の発行（送らない）
- FR-Z05 送信 adapter に **`issueCredential`**（送らずに credential だけ作る）を加える。
  - x402 EVM: 既存の rebuilding signer で EIP-3009 authorization に 1 回署名し `PAYMENT-SIGNATURE` の値を返す。transport に触れない（`fetch` 0 回）。署名した
    authorization の `validBefore` を記録する（FR-Z15）。
  - MPP Tempo **pull**: 公式 client の pull で署名済み transfer の credential（`Authorization: Payment …`）を作る。**放送しない**（transport・RPC の送出 0 回。
    RPC の読み取りは nonce・gas の取得に限る）。発行前に署名済み envelope を**独立に復号して検査**する: chainId・currency・recipient・amount・calls が承認値と一致、
    fee token が許可資産、手数料上限（プロファイルの cap）以下、nonce key と validBefore が妥当。既存 push 経路の規則（pull-only challenge の拒否）は秘匿購入には適用しない。
  - push・SVM x402・MPP Solana は本 v1 では `private_rail_unsupported` で拒否（送出前）。既存の `pay` は変えない。
- FR-Z06 **二重の一意性**。(a) 1 つの intent（`intentSha256`）に対する発行は高々 1 回、(b) 1 つの受信支払い（レール・ネットワーク・txRef・支払いイベントの識別子
  （x402 受信なら authorization nonce / log index）の組）が資金源になる発行は高々 1 回。両方を独立に、同時要求と再起動をまたいで耐久に強制する（journal に予約行を
  fsync してから署名）。成否不明の予約は消費済みのまま残す。`requestId`・`quoteId`・attempt を変えても回避できない。

### 4.3 発見（本文を見せない 402 の取得）と再照合
- FR-Z16 秘匿購入の価格・条件の発見は **本文に依存しない未払い要求**で行う: 承認した host・path・メソッドに対し、GET はそのまま、POST は固定の探り本文 `{}`
  （`application/json`、2 バイト）を送り、402 の challenge を読む。**Payer の秘匿本文は Router のどの経路にも載らない**。既存の「有料 fetch への fallback」は無い。
- FR-Z17 Provider 契約: 未払い探り要求への 402 の支払い条件は、同じ host・path・メソッドへの有料要求が受ける条件と同一であること（Provider C/F はこの契約で作られている:
  本文の検査は支払い済み要求にだけ適用）。発見した challenge は、x402 なら `resource.url` が `https://<host><path>` に一致、MPP なら `realm` と scope（あれば
  `<method> https://<host><path>`）が一致、プロファイルの受取先・資産・ネットワーク・額の規則を通ることで、承認した資源との対応を確かめる。
- FR-Z18 再照合: 受信 settle の前と、送信 credential の発行の前に FR-Z16 の探り要求で条件を読み直し、quote 時の offer と完全一致（`stableJson`）しなければ fail closed
  （既存の `offer_changed` と同じ）。発見できないレール（push 等）は quote で拒否する。

### 4.4 Verifier（Router が実行する側）
- FR-Z07 Router は購入ごとに **Verifier プロセス**（lab の `delivery verifier-serve`）を起動する: 最終注文（intent の `order` + 発行ヘッダ）、`--expect-host/port/path`
  （intent の target）、trust 方針（§4.7）、`--intent`/`--release`（最終注文が intent と発行ヘッダから導かれることの門）、セッション期限。listen は **loopback のみ**
  （本 v1 では loopback 以外の listen・公開アドレスの設定を拒否する）。Verifier の入出力は購入ごとの作業ディレクトリ（`runtime/private/<paymentId>/`、0700）に置く。
- FR-Z08 検証（attest）: record の trust が方針どおり（§4.7）、`target`・`server_name` が intent の host/path、`revealed_prefix` が「`<method> <path> HTTP/1.1`・`Host`・
  発行ヘッダ 1 行・（POST なら）`X-Lab-Credential` の穴」に厳密一致、クエリ無し、注文 id が prefix に無い、POST なら `cred_len > 0`・本文/穴のハッシュがあり bundle に
  要求束縛証明がある、`verifier-verify` が成功、応答が `HTTP/1.1 200 OK` で領収ヘッダを持つ。領収は送信 adapter の規則で読む:
  x402 `PAYMENT-RESPONSE` = `success true`・`transaction` bytes32・`network` 一致・`payer` = Router の送信鍵; MPP `Payment-Receipt` = `status success`・`method tempo`・
  `reference` = **発行時に記録した署名済み envelope の keccak（期待 tx）**。一致すれば `destination.receiptRef`/`txRef` に記録し送信レグ `paid`。領収が無い・不一致なら送信レグ **unknown**。
  これは Provider の決済主張であり、チェーンの独立確認（finality）は既存どおり行わない（`proof.onChainFinality: not_checked`）。

### 4.5 秘匿（Router が見ないもの）と bearer 成果物の保管
- FR-Z10 要求本文、本文の salt、隠し穴の nonce、Payer の鍵、応答本文、復号鍵は Router（プロセス・journal・診断・stderr・作業ディレクトリ）に **一切届かない**。
  Router が受け取るのは intent（commitment を含む）・受信 credential・bundle（証明と公開入力）だけ。bundle の公開入力に平文が無いことは lab の回路の性質。
- FR-Z11 **送信 credential の値（bearer）が存在してよい場所**: 発行側のメモリ、認証済みの Payer への応答、そして外部バイナリが要求する購入ごとの私的な Verifier 入力
  （最終注文）と record（公開 prefix にヘッダ値を含む）。これらは作業ディレクトリ（0700）にだけ置く。**record の取得（FR-Z04）は保持期限（設定。既定 1 時間。quote の承認対象には方針の長さを、
  record の完成時に確定した絶対時刻を応答と射影に開示する: FR-Z15 と同じ扱い）まで何度でも可能で、Router の再起動をまたいで残る**（応答を送ったことは Payer が受け取ったことを意味しないので、取得で削除しない）。保持期限の経過で
  削除し、射影の `private.artifacts` に「record あり／期限切れ」を検証済み配送や支払い結果とは**別の欄**で示す。最終注文は attest の完了（成否にかかわらず）で削除する。
  journal・射影・診断・一般ログには credential の sha256 と非秘密のメタデータだけを残し、**record そのものは journal に書かない**。
- FR-Z19 attest・record 取得は所有 principal と `ownerKey` を要求する。アドレスや `paymentId` だけでは権限にならない。別購入の bundle・record の提出・取得は状態を変えずに拒否する。

### 4.6 外部バイナリとの契約（lab の `delivery` に合わせる。バイナリは変更しない）
- FR-Z20 **intent**: `{"version":"phase5-intent-v1","order":{order_id, payer_pk{x,y}, curve:"grumpkin", target{host,port,path}, request{framing, method, content_type,
  body_len, body_commitment_hex, executor_header, max_executor_value_len}}, "outbound":{…}, "inbound":{…}}`。`intentSha256` は **Payer が送った封筒の正確なバイト列**の
  sha256。Router は封筒を正規化せず、そのバイト列を保存・配布する（Payer の executor と Router の Verifier は同じバイト列・同じダイジェストを見る）。
  `request.payment_header` があれば拒否。framing は `phase5-post-json-canonical-v1`（POST、path は `/select`）または `phase5-get-public-v1`（GET、本文 0）。
- FR-Z21 **release**: `{"version":"phase5-release-v1","intent_sha256","order_id","header_name","header_sha256","inbound":{"tx"}}` の JSON 文書。真正性は Router の
  認証済みチャネル（所有 principal + `ownerKey`）と journal（権威の保管）による。**暗号署名は付けない**（付けると主張しない）。Verifier は `--release` でこの文書を受け取り、
  最終注文のヘッダの sha256 と intent の sha256 を照合する。
- FR-Z22 **最終注文**: intent の `order` に `request.payment_header = {name, value}` を足したもの。Router が作って Verifier に渡し、Payer は `payer-finalize-order` 相当で同じものを作る。
- FR-Z23 バイナリと SRS は sha256 で固定（FR-Z12）。契約の適合はローカル wire（TR-2）で、バイナリを変更せずに示す。

### 4.7 trust 方針
- FR-Z24 Verifier の trust は `mozilla` 固定で、attest は `external_gate = true` を要求する。試験用 trust（lab の `lab-fixture-ca`）は **設定では指定できず**、既存の
  `*ForTest` 能力と同じくテストだけが Router の合成に注入できる（`src/main.ts` の実入口は渡さない）。試験 trust で得た証跡は「synthetic」と表示し、公開 PKI の受入の代わりにはならない。

### 4.8 期限・ライフサイクル・中断
- FR-Z15 **三つの期限を分ける**: (a) credential の寿命 = 署名済み credential の実際の期限（x402 `validBefore`、Tempo `validBefore`）。署名の直後に測り、残りが設定の
  最小値（既定 x402 40 s、Tempo 12 s）未満なら Payer に渡さない。**発行予約は消費済みのまま**、送信レグは `unknown`（理由 `private_credential_lifetime`）、再署名しない;
  (b) セッション期限 = Verifier が TLS セッションの受理と record の完成を待つ上限（既定 180 s）; (c) attest 期限 = record 完成から bundle 提出までの上限（既定 600 s。
  証明生成は Payer 側で数秒〜）。quote の承認対象には各期限の**方針（長さ）**を示し（絶対時刻は credential の署名・Verifier の起動・record の完成の時点でしか確定しない）、
  確定した絶対時刻（`credentialExpiresAt`・`sessionBy`・`attestBy`・record の保持期限）は確定した時点で journal に永続化し、purchase の応答と射影に示す。
- FR-Z09 **送信レグの帰結**。credential を発行した後は、Verifier の record が無い・セッション期限切れ・attest 無し・attest 無効・プロセス中断のいずれでも、
  送信レグは **耐久的な `unknown`**（理由コード固定: `private_session_timeout` / `private_attest_timeout` / `private_attest_invalid` / `interrupted_after_release`）。
  credential の期限切れは**未払いの証明にならず**、返金も意味しない。再署名・再 settle・代替購入は行わない。**発行予約（FR-Z06）を書いた後は**、署名の成否・寿命不足・
  release 前の中断を含め、送信レグは常に `unknown` で予約は消費済みのまま。`paid_undelivered`（送信 credential を**発行していない**）を使うのは、発行予約の **前** の失敗が
  耐久に確定している場合（FR-Z18 の再照合失敗、容量不足、予約行を書く前の中断）に限り、どのレグが成立済みかを射影に示す。
- FR-Z25 中断と再開（再起動時の帰結。すべて journal に書き、状態は再起動後も読める。credential は再発行しない）:
  (i) 受信 settle の後・発行予約の前 → `paid_undelivered`（`interrupted_at_restart`。既存どおり。発行は無い）;
  (ii) 発行予約の後・release の記録の前 → `unknown`（`interrupted_before_release`。署名したかは不明。予約は消費済み）;
  (iii) release の記録の後・record の前、または record の後・attest の前 → `unknown`（`interrupted_after_release`。credential が Payer に届いたか・使われたかは不明）;
  (iv) record はあるが attest が無いまま期限を過ぎた → `unknown`（`private_attest_timeout`）。
  再起動時、**完成した record（Verifier が TLS セッションを受理して書き終えたもの）は、その購入の最終状態が `delivered_private` でも `unknown` でも、FR-Z04 の取得対象として
  保持期限（FR-Z11）まで残す**。削除してよいのは未完成の作業成果物（addr-file、途中の verifier dir、最終注文、bundle）だけで、両者は作業ディレクトリ内で区別して保存する。
- FR-Z26 `delivered_private` の意味: 承認した Payer 鍵に対する検証済み配送（Verifier の record と証明）であり、人が結果を受け取り開いたことの証明ではない。

### 4.9 設定・資源の上限
- FR-Z12 `private` セクション: `deliveryBin` と `deliveryBinSha256`（起動時に照合。不一致なら秘匿購入を無効化し、実モードでは起動しない）、`srsPath` と `srsSha256`、
  `verifierListen`（loopback のみ）、`sessionTimeoutMs`、`attestTimeoutMs`、`minCredentialLifetimeMs`（レール別）、`workDir`（`runtime/private/`）、`retentionMs`、
  `maxConcurrentSessions`（既定 2。進行中の TLS セッション）、`maxConcurrentVerifications`（既定 1。attest の証明検証ジョブ。セッションとは独立）、
  `maxQueuedVerifications`（既定 4。超えたら attest を `private_capacity` で断る。状態は変えない）、`maxBundleBytes`（既定 256 KiB）、`maxRecordBytes`（既定 64 KiB）、
  `verifyTimeoutMs`、`maxRetainedBytes`（既定 64 MiB）と `maxRetainedPurchases`（既定 256。超えたら新規の受信 settle を `private_capacity` で止める）。同じ購入への bundle の
  重複提出は同時には 1 つしか検証しない（2 つ目は 1 つ目の結果を待って返す）。試験 trust は設定にない（§4.7）。
  無指定なら秘匿購入の口は 404/`private_disabled`（既存の挙動は byte 単位で不変: config golden）。
- FR-Z13 秘匿購入の対象は `private.profiles`（既存の動的プロファイル ID の allowlist）。起動時に **両レグ**を検査する: 受信は本 v1 では x402 の Base Sepolia USDC のみ
  （Z1〜Z3。MPP 受信・他チェーン受信のプロファイルは拒否）、送信は FR-Z05 の対象（x402 EVM、MPP Tempo pull）のみ。上流 URL は intent の `https://<host><path>`
  （クエリ不可、`parseUpstreamUrl` と deny list は既存どおり）。価格は既存の動的 quote と同じ（上流額 + 手数料、MPP は cap）。
- FR-Z28 **同一 origin の束縛**: intent の `target.port` は **443 以外を拒否**する（試験でも同じ。loopback の fixture へは Payer の executor の接続先の差し替えと Router の
  試験用 dial で届かせ、注文・URL・探り・Verifier の期待値はすべて `https://<host>:443<path>` を指す）。探り（FR-Z16）、承認対象、routeBinding、release、Verifier の
  `--expect-host/port/path` は同じ host・443・path・メソッドを名乗る。
- FR-Z27 受信 settle の前に容量（同時セッション数・作業ディレクトリ）を確保できなければ `awaiting_payment`（理由 `private_capacity`）で止め、資金を動かさない。

### 4.10 承認対象（Payer に見せるもの）
- FR-Z14 quote は承認対象として次を返す: 受信レグ（額・資産・ネットワーク・受取先）、送信レグ（上流額・資産・ネットワーク・受取先、手数料と cap、合計）、
  host・path・メソッド、本文 commitment と長さ、Payer 鍵（`payer_pk`）、`intentSha256`、各期限（FR-Z15）と record の保持期限（FR-Z11）、資金が動く時点を**レグ別に**
  （受信: Router の purchase で facilitator が決済する = 送信 credential の発行より前; 送信: x402 は Provider が有料要求を受けた時、Tempo pull は Provider が放送した時）、
  「返金無し・`unknown` の可能性」の開示。Payer は承認した本文を commitment に自分で束縛し、本文を Router に送らない。
  対応する framing と大きさの上限（要求 ≤ 4096 B、本文 ≤ 512 B、応答 ≤ 704 B、TLS 1.2 の対応 suite）を公開する。

## 5. 安全要件
- SR-Z1 既存の束縛（承認・offer 完全一致・verify-before-settle・二重レグ同一性・at-most-once・unknown の永続化）を一切緩めない。秘匿購入は別の口であり、既存の口の挙動と
  journal の形は不変（golden）。
- SR-Z2 Verifier は購入ごとに 1 プロセス、同時数・入力サイズ・検証時間・保持成果物を上限で縛る（FR-Z12）。Rust バイナリと SRS はハッシュで固定。
- SR-Z3 失敗の理由は固定コードのみ（既存 `SAFE_REASONS` と同じ方針）。例外文字列・上流の文言・パス・credential 値を公開しない。
- SR-Z4 Provider の決済主張（領収）と Router が独立に確かめた事実（発行した credential の期待 tx との一致）を区別して記録する。
- SR-Z5 Payer の送る intent・bundle・credential は信頼しないデータ。形とサイズの検査を I/O の前に行い、Verifier と検証にだけ渡す。

## 6. テスト要件
- TR-1 単体: intent バイト列の保存とダイジェスト、`routeBinding` 束縛、FR-Z06 の二重一意性（同時・再起動）、`issueCredential` が transport/RPC 送出を呼ばないこと（spy）、
  Tempo pull の envelope 検査（各欄のすり替えで拒否）、push/SVM/Solana の拒否、attest 検査（prefix・target・trust・領収・期待 tx）が各欄のすり替えで fail closed、
  期限 3 種の判定、中断ごとの帰結（FR-Z25）、射影・journal・診断に秘匿値・credential 値が無いこと（canary）、設定の検査（試験 trust は synthetic のみ）。
- TR-2 wire（実プロセス・実 TCP・loopback TLS、**試験 trust**。合格は「synthetic」として記録し公開 PKI の受入の代わりにしない）: Router 子プロセス + 合成 facilitator +
  lab の fixture CA で TLS を話す有料 Provider fixture（x402、`POST /select` と `GET`）+ lab の Rust バイナリ（Payer 側 executor と Router 側 Verifier）。
  HTTP と MCP の両方で quote → purchase → session → attest → record 取得 → Payer の `payer-decrypt` と結果の検証 → status の全経路。否定ケース: 注文のすり替えは TLS 前に拒否、
  bundle の改変・別購入の bundle は attest で拒否、セッション無しの timeout は `unknown`、同時二重発行の拒否、release 後の再起動で `unknown`、依存ハッシュ不一致で起動拒否。
  Tempo pull の **発行**は単体で（放送 0 回を spy で確認）、wire は x402 で行う（Tempo pull の wire はチェーンを要するので受入へ）。
  lab のバイナリ・SRS・fixture が無ければ skip（`T5_CHAT_APP_DIR` と同じ扱い。skip は合格ではない）。
- TR-3 受入（owner ゲート、実送金）: Provider C（Z1）、Provider F（Z2）、A/B（Z3）に対し、Router の実合成（`src/main.ts`、`real`）で quote → purchase → session → attest →
  record → Payer 復号。受信は Base Sepolia USDC の実 x402 決済、送信は実 credential。証跡は journal・射影・両チェーンの読み取り（受信 tx、送信 tx と期待 tx の一致）。
  受信決済・送信決済・秘匿配送・Payer 受領・finality は別々のゲートとして記録する。**実行は owner の承認後**（AGENTS.md）。
- TR-4 config golden と既存テスト（`npm test`）が不変に通ること。失敗・成功両経路で Router が触れる全成果物（作業ディレクトリ・子プロセス出力・診断）の canary 走査。

## 7. 非目標・未解決
- Verifier の公開露出（本 v1 は loopback のみ。hosted では別途トンネルか公開 listener と、その認証）。
- `@subetha/payer` への executor 統合。push 型レール。Solana pull の `issueCredential`（Z4）。チェーン finality の確認と、`unknown` を読み取り専用で解消する reconcile
  （lab にはあるが Router 本体には本 v1 で入れない）。Router の経路帰属。

## 8. 用語
- **intent**: Payer が送る `phase5-intent-v1` 封筒（バイト列）。**最終注文**: その `order` + 発行ヘッダ。**release**: Router の発行の記録文書。**record**: Verifier の記録
  （公開 prefix・ハッシュ・応答ヘッダ）。**bundle**: executor の証明と公開入力。**attest**: bundle を Router が検証する操作。

## 9. v1 → v2 の対応（Codex レビュー 1 回目）
| 指摘 | 対応 |
|---|---|
| 1 timeout ≠ 未払い | FR-Z09・FR-Z25（発行後は耐久 `unknown`、`paid_undelivered` は発行無しのときだけ） |
| 2 本文を見せない発見 | §4.3（固定探り本文 `{}`、Provider 契約、再照合 2 回、fallback 禁止） |
| 3 外部バイナリ契約 | §4.6（封筒バイト列のダイジェスト、release は文書で署名無し、最終注文） |
| 4 bearer 成果物 | FR-Z11（存在してよい場所・保持・削除、record は journal に書かない） |
| 5 Tempo pull | FR-Z05（独立検査）・FR-Z08（期待 tx との一致、不一致は unknown）、SR-Z4 |
| 6 一意性 | FR-Z06（intent と受信支払い識別子の二重、耐久） |
| 7 ライフサイクル | FR-Z04（record の受け渡し）、FR-Z15・FR-Z25・FR-Z26、FR-Z03 の冪等・拒否 |
| 8 trust の矛盾 | §4.7・TR-2（試験 trust は synthetic のみ、Tempo pull は単体 + 受入） |
| 9 露出・資源 | FR-Z07（loopback のみ）、FR-Z12・FR-Z19・FR-Z27 |
| 10 主張の範囲 | §1 |
| 11 範囲と開示 | FR-Z13（allowlist）・FR-Z14・FR-Z15 |
| 12 受入の証跡 | TR-2・TR-3・TR-4 |

v2 → v3（Codex レビュー 2 回目）: 1 寿命不足は予約消費のまま `unknown`（FR-Z15・FR-Z09）; 7 record の取得は保持期限まで繰り返し可・再起動をまたぐ・取得で削除しない、
中断 4 区分（FR-Z11・FR-Z04・FR-Z25）; 9 検証ジョブ・キュー・保持成果物の上限と重複提出の直列化（FR-Z12）; 11 受信レグの scope と資金が動く時点のレグ別開示
（FR-Z13・FR-Z14）; N1 port 443 固定と同一 origin の束縛（FR-Z28）; FR-Z24 試験 trust は設定ではなくテスト能力の注入のみ。
v3 → v3.1（3 回目）: 7 再起動時も完成した record は最終状態によらず保持期限まで残す（FR-Z25）。
v3.1 → v3.2（設計レビュー 1 回目の指摘 11）: FR-Z15 の期限の開示を「quote は方針の長さ、確定した絶対時刻は確定時に永続化して応答・射影へ」に明確化（FR-Z14 の「各期限」はこの意味）。
v3.2 → v3.3（設計レビュー 2 回目）: FR-Z11 の保持期限の開示を FR-Z15 と同じ扱い（quote は方針の長さ、確定した絶対時刻は応答・射影）に揃えた。
