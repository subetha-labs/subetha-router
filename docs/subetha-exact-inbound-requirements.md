# Router を SubEtha v2 facilitator の Provider として動かす（受信レール `subetha-exact`）要件定義 v4.4

対象: 本 worktree（`subetha-router/v2-exact-inbound`、branch `task/v2-exact-inbound`、基点 `origin/main` `1dc29ad`）。要件フェーズの成果物であり、設計・実装は含まない。
入力は紙の案 `ROUTER-V2-PROVIDER-PLAN.md` v3（研究 repo、2026-11-20、Codex review-21/22 反映、オーナー「この案で進めて良いです」「実装に進んで良いです」）と、その §4 の 9 つの問い。
本書は 9 つの問いに**要件の水準**で答える（§3）。仕組みの選択は設計書（次フェーズ）が決める。
v1 は Codex（`gpt-6-astra`、CLI、`.claude_workflow/local/req-review1.md`）の独立レビューで **REVISE**（must-fix 8、should-fix 3）。v2 は全件を反映した（§9 に対応表）。v2 の再レビュー（`req-review2.md`）は **REVISE**（前回の partly 6・not fixed 1、新規 must 2・should 2）で、v3 はそれを反映した（§10）。v3 の再レビュー（`req-review3.md`）は **REVISE**（not fixed 1、partly 2、新規 must 1・should 1・note 1）で、v4 はそれを反映した（§11）。v4 の再レビュー（`req-review4.md`）は **APPROVE WITH CHANGES**（must 無し。should 2・note 1・partly 1）で、v4.1 に反映した（§11 の末尾）。

facilitator の記述は protocol repo `origin/main` `68e061b`（以下 `P:`）、Router の記述は本 branch の基点 `1dc29ad`（以下パスのみ）について確認した。
印: 【事実】出典付き。【推論】本書の考え。【未確認】確かめていない。【決定】本書の要件としての決め。

## 0. 目的と範囲

**目的**: ローカルの Router が、今の multi-tenant SubEtha v2 facilitator（`https://facilitator-testnet.subethalabs.com/p/<id>`）の**普通の Provider（tenant）**として動き、
買い手が **Base Sepolia の zUSDC** を標準の x402 `exact`（EIP-3009）で署名して払い、Router が注文の settle → release を経て上流に払い、データを渡す経路を **1 本の静的 route** で通す。
その過程で紙の案 §6 の数字（所要時間、失敗と未解決の率、枠の消費、withdraw の手数料）を測れる記録を残す。

| # | 内容 | 本スライス |
|---|---|---|
| S-1 | 新しい受信レール adapter `subetha-exact`（facilitator の Provider 用 API を直接呼ぶ。紙の案 §3.1 の A 案） | 対象 |
| S-2 | core の変更: settle の後・上流への支払いの前の **release**、終端の後の **complete**、復旧の規則、「払われたかもしれない」の開示 | 対象 |
| S-3 | 表（`src/shared/networks.ts`）・設定・`npm run sign`・一覧（R1／MCP）への追加。`@subetha/payer` がこの route を**載せない・署名しない**ことの固定（FR-10.2） | 対象 |
| S-4 | 合成 facilitator（tenant の面を模す fixture）での単体・wire 試験 | 対象 |
| S-5 | 運用者の確認（Router の記録と facilitator の注文の突き合わせ。facilitator には読み取りだけ。唯一のローカルの書き込みは明示の `--abandon`。FR-11） | 対象 |
| S-6 | テストネットの facilitator への登録、Provider 用 wallet、実購入、§6 の計測 | **対象外**（紙の案の段 3・4。オーナーの別の go） |
| S-7 | hosted Router への配備、メインネット、動的上流（任意 URL）、秘匿購入との組み合わせ、facilitator 側の変更、料金の決定、旧 `subetha-zerc20` adapter の変更 | 対象外 |
| S-8 | `@subetha/payer` でこの route を**払えるようにする**こと | 対象外（別スライス。載せない・署名しないことは S-3） |

## 1. 前提の事実（紙の案 §1 の補足。本書で新しく確かめたもの）

- **facilitator の token の domain**【事実】: hosted の配備は `TOKEN_NAME=zERC20 USD Coin`、`TOKEN_VERSION=1`、`CHAIN_ID=84532`、`CHALLENGE_TTL_SECONDS=300`、`MAX_ORDER_AMOUNT=1000000`
  （`P:deploy/public-testnet/facilitator-multi.env:4-11, 50, 116`）。facilitator は起動時に token の on-chain `eip712Domain()` と設定の一致を検査する（`P:packages/zerc20-v2-adapter/src/exact-settle.ts:182-183`）。
  requirements の `maxTimeoutSeconds` は `max(1, floor(challengeTtlSeconds / 2))` = 150（同 `:236`）。配備の値は運用で変わり得る（【未確認】現在の実値）。
- **Bearer の settle の応答**【事実】: `POST /exact/orders/:id/settle` は `ExactSettleResult`（`SettleResponse` + `orderId?`、`outcome: accepted | late-paid | pending | rejected`。`P:exact-settle.ts:138`）に `order`（注文の view）を添えて返す
  （`P:apps/facilitator/src/exact-routes.ts:133-144`）。通常の変換は `P:exact-settle.ts:455-457`（`pending` → `errorReason: settlement_pending`）だが、`broadcast-not-permitted` を `pending` の outcome で返す経路もある（同 `:305-308`）。
- **公式 SDK の verify が `accepted` から読むもの**【事実】: `scheme` と `network` だけ（`node_modules/@x402/evm/dist/cjs/exact/facilitator/index.js:1058, 1078`、2.28.0）。`payTo`・`amount`・domain は `requirements` から読む。
  `validBefore` は `now + 6` 以上、`validAfter` は `now` 以下、`value` は `amount` と**等しい**こと（同 `:1158, 1168, 1178`）。
- **facilitator の `#locate`**【事実】: `payload.accepted` と台帳の requirements を `scheme`・`network`・`asset`（小文字）・`amount`・`payTo`（小文字）・`maxTimeoutSeconds`・`extra.name`・`extra.version` で照合し、
  違えば `accepted-requirements-mismatch`（`P:exact-settle.ts:250-252`）。`extra` のほかのキーは見ない。
- **settle の前の拘束**【事実】: **最初の予約**（注文に intent が無いとき）は `open` で期限内、`to = saleId`、`value = amount`、`validBefore ≤ order.expiresAt` を要求する（`P:packages/zerc20-v2-adapter/src/burn-sale-backend.ts:1110-1115`）。
  既に intent がある注文は別の扱い（同 `:1096-1108`: 同じ authorization なら `observed` の昇格、違えば `conflicting-authorization`）。
- **注文の再利用**【事実】: `exactOrdersFor` は (requester, resource) の注文のうち `closedReason` の無いもの・release が完了していないものを返す（同 `:705-713`）。額・期限は鍵に入らない。
  `createExactOrder` はその 1 件を返し、無ければ新しく作る（同 `:743-760`）。multi-tenant は作成が `CREATE_ANSWER_MS`（hosted は 30 000 ms。`P:deploy/public-testnet/facilitator-multi.env:98`）で 503 を返しても割当を取り消さない（`P:apps/facilitator/src/multi/multi-routes.ts:168-170`）。
- **Router の `npm run sign`**【事実】: `exact` + `eip155:` の offer は、表の network・資産（`tools/sign-classify-evm.ts:63-78`）と EIP-712 domain（同 `:80-90`）が一致するときだけ署名し、`validBefore = offer.extra.expiresAt`、`nonce = offer.extra.challengeNonce`、`validAfter = 0` で署名する（`tools/x402-payer.ts:49-57`）。
  額の上限は `SIGN_MAX_AMOUNT = 20_000`（`tools/sign-classify-evm.ts:10`）。
- **Router の core**【事実】: `quoteId = offer.extra.challengeNonce`（`src/core/orchestrator.ts:607`）。承認期限は `min(issuedAtMs + approvalTtlMs, offer.extra.expiresAt × 1000)`（同 `:602`）。
  **同じ (principal, requestId) の再 quote は、同じ静的 route なら intent の状態によらず保存済みの quote 文書（offer を含む）を返し**、別の route なら `request_id_conflict`（同 `:556-565`）。purchase は `status !== "created"` なら現在の終端を返して何も始めない（同 `:672-674`）。
  `npm run sign` は quote 文書の `source.offer` だけを読み、状態を見ない（`tools/sign-run.ts:57-66`）。
  `source_settled` の次は `deliver()`（`src/core/orchestrator.ts:943`）で、`InboundRail` に settle の後の呼び出しは無い（`src/ports/inbound.ts`）。
  上流の読み直しの失敗・offer の変化・運用者の残高不足は、credential の検査（verify）より**前**に `source_failed` の行を書く（`src/core/orchestrator.ts:749-786`）。再起動時、`source_settled` は `paid_undelivered`（`interrupted_at_restart`）、`source_pending`／`destination_*` は `unknown`（`src/core/store.ts:669-690`）。
- **表**【事実】: `eip155:84532` の資産は USDC `0x036C…CF7e` だけ（`src/shared/networks.ts:77-82`）。`0x32c8…3D9f` は Sepolia（`11155111`）の `SUBETHA_ZERC20_ASSETS` の行（同 `:184`）。`KnownNetwork.inbound` は network 単位（資産単位の制限は無い。同 `:52-72`）。
- **payer**【事実】: `@subetha/payer` は一覧の静的 route の `source.rail` が `x402`／`mpp` 以外なら **network の表の rail に fallback** し（`packages/payer/src/daemon/handler.ts:25-35`）、表（`src/vendor/networks.ts`、Router の表の写し。`packages/payer/scripts/vendor.ts:20-24`）に資産があれば払える行として載せる（`handler.ts:44-51` の `payable`）。
  今 zUSDC が載らないのは、表に無いからだけである。
- **注文の TTL の起点**【事実】: `expiresAt` は POS の割当（`pos.next()`）が**終わった後**の時刻 + TTL（`P:burn-sale-backend.ts:515-521`）。503 の後に続く割当がいつ終わるかに上限は無い（`P:multi-routes.ts:150-170`「uncancellable SDK work」）。

## 2. 用語

- **注文（order）**: facilitator の `POST /exact/orders` が作る 1 件。`orderId` は 32 バイトの hex で、台帳の `challengeNonce`・release の `deliveryKey` と同じ値（`P:burn-sale-backend.ts:1320, 1782`）。
- **release**: `POST /exact/orders/:id/release`。1 回だけ成功し、`deliveryKey`・`txRef`・`eventId` を返す。2 回目は `already-claimed`（完了後は `already-delivered` / `already-failed`。同 `:1257`）。
- **complete**: `POST /exact/orders/:id/complete { deliveryKey, outcome }`。同じ outcome は冪等、違う outcome は 409（同 `:1695-1710`）。
- **確定した結果**: Router の journal に終端の行（`delivered`／`paid_undelivered`／`dest_failed`）が fsync された状態。`unknown` は確定した結果ではない。
- **実行可能な authorization**: 買い手の鍵で正しく署名され、`to` が注文の burn address、`value` が注文の額、`validBefore` が未来の EIP-3009 authorization。**Router が送らなくても**、それを持つ誰でも（買い手自身を含む）facilitator の公開 settle や chain に出せる（`P:docs/PUBLIC-TESTNET-QUICKSTART.md` §3「A refused authorization stays valid on chain until its validBefore」）。

## 3. 9 つの問いへの答え（要件の水準）【決定】

| # | 問い（紙の案 §4） | 答え |
|---|---|---|
| 1 | 注文を作るタイミングと枠の消費 | quote（`createOffer`）で注文を 1 つ作る（`payTo` が要るため）。払われない quote も枠を消費する事実は変えられないので、**Router 側で quote の負荷に上限を置き、作成の要求を出す前に耐久に枠を取る**（FR-9）。requester の識別は **(principal, requestId) から決定的に導く**（FR-2）: 応答が失われた・503 で切れた・`created` 行の前に落ちた、のどれでも、同じ requestId の再 quote は同じ digest で呼び、facilitator に**未解決の注文が残っていればそれ**が返る。それが無ければ（閉じた後、別 route）新しい注文になり得る。これは facilitator の規則で、Router は「同じ注文に戻る」とは約束しない（FR-2.2）。 |
| 2 | release と復旧の状態の契約 | `InboundRail` に **任意の `release`・`complete`** を足す（持たない rail は今までどおり）。core は `source_settled` の後・上流の読み直しの前に release を 1 回呼び、結果を journal の**行**に書く（状態は増やさない。FR-5）。release が成功しない購入は上流に払わず、`paid_undelivered` で終える。**再起動後に release も上流への支払いも再開しない**（FR-7）。 |
| 3 | complete の意味 | complete は**確定した結果**の報告（FR-6）。`delivered` は結果の行が fsync され、所有 principal が status で取り出せる状態。`failed` は Router が二度と配信しないと確定した終端（`paid_undelivered`／`dest_failed`）で、かつ release 成功の**耐久の証拠**（journal の行）があるもの。`unknown` は報告しない。release の成功を推測して complete しない。 |
| 4 | `requesterDigest`・`resourceDigest`・復旧の対応付け | `resourceDigest = sha256(routeBinding)`（route ごとに決まる）。`requesterDigest = sha256(Router 固有の salt ‖ principalId ‖ requestId)`（長さ付きの符号化。quote ごとに決まり、再 quote で同じ値）。`CreateOfferRequest` に **(principalId, requestId) を任意の欄として足す**。この rail は欄が無ければ offer を発行しない。adapter は注文を作る**前**に (requesterDigest, resourceDigest, routeId, amount) を自分の耐久の記録に書く（FR-2）。 |
| 5 | Router の外で使われる authorization と買い手の取り戻し | **settle を呼んだ後の失敗はすべて `unknown`**（`rejected` にする code は無い。FR-4.2）。settle の前（facilitator の verify の拒否、期限・予算）で止めた購入は、資金は Router の経路では動いていないが、**実行可能な authorization が存在し得る**ので、その事実を耐久に記録し、公開の結果に「`validBefore` まで払われ得る」と開示する（FR-4.4）。Router は同じ注文に新しい署名を求めない（FR-4.5）。取り戻しは既存の principal 認証の status（所有 principal だけ。FR-8）。SIWX は採らない。 |
| 6 | 複数の買い手と tenant の枠 | ローカルの検証では Router が唯一の tenant で、買い手は設定の principal。枠は Router 全体で管理する（FR-9）。買い手ごとの配分は hosted の条件（紙の案 §7 段 5）として**本スライスの対象外**と明記する。 |
| 7 | rate limit と負荷 | 注文の作成は adapter で **同時 1 本**に直列化し、超えた quote は資金が動く前に断る（FR-9）。1 購入の facilitator 呼び出しは 作成 1・verify 1・settle 1・release 1・complete 1 を基本とし、読み取りの GET は失われた応答の復元（release）と、枠の確認の requester の照会（503 の後・起動時。FR-9.2）だけ。Bearer の route の rate limit は作成・GET・release・complete で**共有**されるので（`P:multi-routes.ts:334`、`facilitator-multi.env:86-98`）、復旧の呼び出しも 429 を受け得る前提で設計する（FR-5.3）。 |
| 8 | 秘密と登録 | Router が持つのは **Provider token だけ**（0600 のファイルから読む）。token、`Authorization` ヘッダ、署名、credential、facilitator との生の要求・応答の本文は、記録・応答・エラー・診断・レビュー用の出力に出さない（FR-1）。wallet の seed・view key・POS key は持たない。登録と wallet は段 3（対象外）。 |
| 9 | 既存の制限との関係 | rail 名 `subetha-exact`、scheme `exact`。表に **zUSDC@`eip155:84532`** を足すが、**その資産は `subetha-exact` の受信だけ**に許す（資産単位の制限。`x402` の受信・送信は今までどおり受けない。FR-10）。payer は明示の未知の rail を**載せない**（FR-10.2）。上限は既存の 20,000（sign の cap）に従い、route の額はそれ以下。動的プロファイルには開かない。 |

## 4. 機能要件

### 4.1 設定と秘密
- **FR-1** 新しい受信レール `sourceRail: "subetha-exact"` を静的 route に設定できる。facilitator の base URL（`…/p/<id>`）と Provider token は env から読む。token は**ファイルのパス**で受け取り（通常のファイル、0600、symlink 不可）、
  値は起動ログ・応答・エラー文・journal・adapter の記録・診断・レビュー用の出力のどこにも出さない。**同じ扱いの秘密**: `Authorization` ヘッダ、買い手の署名と credential、facilitator との生の要求・応答の本文（記録に残すのは固定の code・status・長さ・所要時間だけ）。
  URL は https（試験の fixture の能力があるときだけ loopback）で、host は `facilitator-testnet.subethalabs.com` か loopback、path は `/p/<id>`（`<id>` は `[a-z0-9-]+`）に限り、query・userinfo・fragment は不可（`ConfigError`）。`subetha-exact` の route が無ければ、これらの env は要らず、何も変わらない。
- **FR-1.1** `subetha-exact` は**動的プロファイルの `sourceRail` には使えない**（`ConfigError`）。`subetha-exact` の route に `source.payTo` があれば `ConfigError`（受取先は facilitator が注文ごとに決める）。
- **FR-1.2** 既存の env（`ROUTER_SUBETHA_FACILITATOR_URL` ほか）と既存の rail の設定・挙動は変わらない。

### 4.2 quote（注文の作成）
- **FR-2** `createOffer` は、(a) `requesterDigest`・`resourceDigest` を §3-4 のとおり導き（`requester` の欄が無ければ offer を発行しない）、(b) それらと routeId・額・時刻を adapter の耐久の記録に **fsync してから** `POST /exact/orders` を呼び（この行が FR-9 の枠の予約でもある）、
  (c) 応答（`orderId`、`requirements`、`status.expiresAt`、`existing`、`binding`）を同じ記録に書く。応答が失われた・5xx・timeout なら quote を失敗させ（資金は動かない）、新しい digest で作り直さない。同じ (principal, requestId) の再 quote は同じ digest で呼ぶ（process・再起動をまたいでも同じ: salt は耐久のファイル）。
- **FR-2.1** facilitator の拒否は資金が動く前の quote の失敗として、理由を Router の固定の code に分類して返す: 503（`order-creation-busy` ほか admission の 4 つ、`tenant-unavailable`）と 429 → `source_offer_unavailable`（HTTP 503 と `Retry-After`）、
  403（額の方針）→ `source_offer_refused`、401／404（token・tenant）→ `source_offer_refused`（運用者向けに固定文で `note`）、5xx・timeout・読めない本文 → `source_offer_unavailable`。facilitator の文章は転送しない。
- **FR-2.2** 返った注文が `existing: true` のとき、adapter の記録に**この digest の注文が記録されていれば `orderId` が一致すること**を要求し、違えば quote を失敗させる（`source_offer_refused`）。記録が無い（応答の喪失）なら受け入れて記録する。
  `existing: false` は新しい注文として記録する。**新しい注文が作られ得るのは、core の `created` 行が無い間だけ**（作成の応答の喪失・`created` の前に落ちた、の再 quote。前の注文が閉じていれば facilitator は新しく作る。別 route での同じ requestId も `created` の前なら別の resource として別の注文になる）。
  `created` 行の後は core が同じ route には同じ文書を返し、別 route は `request_id_conflict` で拒むので、adapter に 2 つ目の作成は届かない。adapter の記録は追記だけで、要求と注文の履歴を上書きしない。
- **FR-3** 買い手に示す offer は facilitator の `requirements` が権威: `payTo`（注文ごとの burn address）、`asset`、`network`、`amount`、`maxTimeoutSeconds`、`extra.name`／`extra.version` を写す。Router は自分で `payTo` を作らない。
  写す前に検査し、違えば offer を発行しない（quote の失敗。`source_offer_refused`）: `network`・`asset`（小文字比較）・`amount` が route の設定と一致、`extra.name`／`version` が表の domain と一致、`payTo` が EVM address の形、`binding` の 2 つの digest が自分の値と一致、`expiresAt` が `now + 最低の猶予` より未来。
  **再利用された注文（`existing: true`）も同じ検査**を通す（額と期限の確かめ直し）。期限切れ・別額の再利用注文で失敗した quote は、同じ requestId では解けない（買い手は新しい requestId を使う。応答の `reason` でそれを言う）。
- **FR-3.1** offer の `extra`: `challengeNonce = orderId`（quoteId・署名の nonce・deliveryKey が同じ値になる。同じ鍵による 2 つ目の署名は token の上で同じ (from, nonce) = 高々 1 回しか実行されない）、`expiresAt = min(order.expiresAt, now + offerSeconds)`、`routeBinding`、`fundsMoveOnCredential: false`。
  `offerSeconds` は env で変えられ、既定は 120。`expiresAt` は承認期限の上限であり、同時に買い手の署名の `validBefore` になる（`tools/x402-payer.ts`）。**`expiresAt ≤ order.expiresAt`** を必ず満たす（facilitator の `valid-before-after-order-expiry` を起こさない）。

### 4.3 preflight・verify・settle
- **FR-4** `preflight`（同期・journal の前）は、既存の x402 受信の `bindAuthorizationNonce` と同じ束縛を**常に**要求する: `accepted` の Router 発行欄が全部一致、`extra` は発行キーだけ、authorization の `nonce = challengeNonce`、`to = payTo`（大小無視）、`value = amount`、`validBefore ≤ expiresAt`、`validAfter ≤ now`、署名が hex。
- **FR-4.1** `verify` は、(a) 鍵に触れずに手元で EIP-712 の署名を検査し（domain は表、`verifyingContract` は資産、復元した署名者 = `from`）、通れば (b) 公開の `POST /p/<id>/exact/verify`（`paymentRequirements` は facilitator の requirements の形）を呼び、`isValid: true` のときだけ有効とする。
  (a) が通った時点で**実行可能な authorization が存在する**ので、`verify` の結果に `mayStillSettleUntil = validBefore`（秒）を添える（(b) の結果によらず）。facilitator の `invalidReason` の文章は転送しない（診断には Router の表で分類した token だけ）。
- **FR-4.2** `settle` は `POST /exact/orders/:id/settle { paymentPayload, requesterDigest, resourceDigest }` を 1 回だけ呼ぶ。結果の表:
  - `success: true` かつ `outcome: "accepted"` かつ `transaction` が 0x+64 hex かつ `network` が offer と一致 → `settled`（`txRef`、`eventId` = authorization の nonce 小文字）。
  - **それ以外はすべて `unknown`**（`pending`／`settlement_pending`、`late-paid`、`rejected` の全 code、route の 400／401／403／404／409、429、5xx、timeout、読めない本文、network 違い、知らない形）。
    理由: settle に届く payload は preflight と FR-4.1 (a) を通った**実行可能な authorization**であり、facilitator のどの拒否 code も「この authorization が chain で決して実行されない」ことの chain-final な証拠ではない（v1 のレビュー #1。`accepted-requirements-mismatch` 等は封筒の不一致、`payer-*` は方針、`invalid-signature` は手元の検査との矛盾、`authorization-consumed-before-order` は `createdBlock - 1` の読みで finality を見ていない。`P:exact-settle.ts:298-318, 608-631`）。
    facilitator の G6c（`negative-evidence`、`final: true`）による確定の否定は本スライスでは使わず、`unknown` に留める（安全側）。
  - 同じ authorization を再送しない。`unknown` の行にも `mayStillSettleUntil` を写す。
- **FR-4.3** `verify` が通った credential が settle に進めない失敗（承認期限・予算）は、既存どおり `source_failed`（`not_sent`）でよい（Router の経路では資金は動いていない）。ただし FR-4.4 の開示を付ける。
- **FR-4.4** **「払われたかもしれない」の開示**。3 つの場合を分ける。rail は「この offer への標準の署名が実行可能でいられる上限」（= `offer.extra.expiresAt`。preflight が `validBefore ≤ expiresAt` を要求する）を `InboundRail` の任意の同期の問い合わせで core に返し、持たない rail では欄が出ない:
  (i) **手元の署名の検査より前・journal の行なし**で止まった purchase（credential の無い／承認期限切れの purchase、preflight の拒否）: 応答に **上限として** `mayStillSettleUntil = expiresAt` と `awaitingPaymentDoesNotMeanUnpaid: true` を出す。
  (i′) **手元の署名の検査より前・終端の行あり**（上流の読み直しの失敗 `offer_unavailable`、offer の変化 `offer_changed`、運用者の残高不足 `operator_funds_unavailable`。§1 の `orchestrator.ts:749-786`）: その `source_failed` の行に**上限の** `mayStillSettleUntil = expiresAt` を書き、status と purchase の応答に (ii) と同じ欄を出す。
  (ii) **手元の署名の検査（FR-4.1 (a)）の後**に書く `source_failed`・`unknown` の行は、**正確な** `mayStillSettleUntil = validBefore`（秒）を持ち、status と purchase の応答の `source` に `mayStillSettleUntil` と `awaitingPaymentDoesNotMeanUnpaid: true` を出す（動的購入の同名の欄と同じ意味）。
  MCP の応答もこれを人に伝える文を添える。既存 rail の行・応答は変わらない（欄が無いだけ）。AC-2 (k3) で (i′) の 3 経路を固定する。
- **FR-4.5** **同じ注文に新しい署名を求めない**（公開の契約。**全 rail に効く core の変更**で、既存 rail では「どのみち purchase が拒む quote を署名の対象として再提示しない」安全側の変更。オーナーに明示して承認を得る）:
  (a) 同じ (principal, requestId)・同じ route の再 quote は、intent が `created` のままなら既存どおり同じ文書を返す。intent が **`created` を離れた後**は、文書に `closed: true` と `status`（公開の状態）を足し、**`source.offer` を載せない**（署名の対象が無い。`paymentId`・`quoteId`・`approval` の欄はそのまま）。
  (b) `created` 以外の状態の quote への purchase は、facilitator を**一切呼ばずに**現在の状態を返す（既存の挙動）。
  (c) `npm run sign` は `closed: true` の文書と `source.offer` の無い文書を拒む（「この quote は使用済み。新しい requestId で quote を取り直す」）。MCP の `quote` の応答は `closed` のとき `nextStep` で署名しないことを言う。
  (d) `challengeNonce = orderId` により、同じ鍵の署名し直しは同じ authorization identity（token の上で高々 1 回）。
  **保証の範囲**: Router は使用済みの offer を再提示せず、CLI は `closed` の文書を拒む。**最初の quote の文書を保存した買い手が、それを別の鍵で署名することは防げない**（Router の外の署名）。その authorization は facilitator の公開 settle で使われ得るので、FR-4.4 の開示と FR-11 の確認が残る手段である（§7）。
  AC-2 (m) で (a)〜(c) を固定する。

### 4.4 release と上流への支払い
- **FR-5** core は `source_settled` の行の後・上流の読み直しの前に、rail が `release` を持てば **1 回**呼ぶ（持たない rail は今までどおり）。adapter は `POST /exact/orders/:id/release { requesterDigest }` を呼び、結果を 3 つに分ける:
  - `released`（200: `deliveryKey`・`txRef`・`eventId`。`deliveryKey` が `orderId`、`txRef` が settle の `txRef` と一致、`eventId` が `<chainId>:<txRef>:<logIndex>` の形で chainId・tx が一致、のすべてを満たすこと。違えば `unknown`）。
  - `refused`（`incident`／`late-after-reinclusion`／`already-delivered`／`already-failed`／`requester-mismatch`／`unknown-order`、および「GET による復元」が合わなかった `already-claimed`）。
  - `unknown`（timeout・5xx・429・読めない本文、復元できない `already-claimed`、`not-ready`／`receipt-not-final`／`coins-not-spendable` の 425 が再試行の後も続くとき）。
  `not-ready` 系の 425 と transport の失敗は、承認期限の内で**上限つき**に再試行してよい（回数・間隔・`Retry-After` の扱いは設計）。
- **FR-5.1** **`already-claimed` の復元**は、**同じ purchase の中**（同じ process、同じ quote の排他の中、この購入が release を呼んだ後）に限る: `GET /exact/orders/:id` を読み、`binding` の 2 つの digest が自分の値、`status.state` が `accepted`／`settled`、`status.release.state` が `"authorized"`、
  `status.release.deliveryKey` が `orderId`、`status.release.txRef` が settle の `txRef`、`status.release.eventId` が `<chainId>:<txRef>:<logIndex>` の形で chainId・tx が一致（直接の応答と同じ検査）、`status.release.afterRelease` が無い、のすべてを満たすときだけ `released`（失われた応答の復元）。
  GET の timeout・5xx・読めない本文は `unknown`（`refused` に落とさない）。GET は過去の release の許可を読むだけで、`beginRelease` の receipt の再検査（`P:burn-sale-backend.ts:1300-1321`）を再実行しない。
- **FR-5.2** core は release の結果を journal に書く（成功: 行 `source_released`（`deliveryKey`・`txRef`・`eventId`）。**状態は `source_settled` のまま**。失敗: 終端 `paid_undelivered`、`destination.outcome: not_sent`、理由 `source_release_refused`／`source_release_unknown`）。
  **`release` を持つ rail の購入では**、`source_released` の行がある購入だけが上流の読み直し・`destination_pending` に進む（持たない rail は今までどおり `source_settled` の直後に進む）。行の順序は `source_settled` → `source_released` → `destination_pending` → … で、設計で表にする。
- **FR-5.3** facilitator への呼び出しの共通の規則: 1 回ごとの期限と、**再試行の待ちを含む操作全体の期限**（値は設計）、応答の本文は 64 KiB まで、redirect は追わない（`redirect: "error"`）。**再試行は操作ごとに違う**:

  | 操作 | 429・5xx・timeout・transport |
  |---|---|
  | 作成 | 再試行しない。quote は `source_offer_unavailable`（`Retry-After` を写す） |
  | 公開 verify | 再試行しない。`isValid: false`（FR-4.4 (ii) の開示つき） |
  | **settle** | **再試行しない。1 回だけ。** 429 も含めて `unknown`（FR-4.2） |
  | GET（復元・掃き出し） | 上限の内で `Retry-After` を守って再試行。尽きれば `unknown` |
  | release | 上限の内で再試行。尽きれば `unknown` |
  | complete | 上限の内で再試行。尽きれば `source_complete_unreported`（**購入の状態は変えない**） |

### 4.5 complete
- **FR-6** core は終端の行が fsync された**後**に、rail が `complete` を持ち、かつ **`source_released` の行がある**購入でだけ呼ぶ: `delivered` → `"delivered"`、`paid_undelivered`／`dest_failed` → `"failed"`。`unknown` では呼ばない。release の成功を推測して呼ばない。
  失敗の扱い: timeout・5xx・429 は上限つきで同じ outcome で再試行し、それでも届かなければ journal に `source_complete_unreported`（outcome・固定の理由）を残す（状態は変えない）。
  **409 `conflicting-outcome`・`not-authorized`・`delivery-key-mismatch`、404 は同じ要求の反復で解けない**ので再試行せず、`source_complete_unreported` に理由を残す。応答・status の射影は complete の成否で変わらない。
- **FR-6.1** 起動時、journal から「`source_released` の行あり・終端の行あり（`delivered`／`paid_undelivered`／`dest_failed`）・`source_completed` の行なし」の購入を集め、同じ outcome で complete を呼ぶ（**1 回の起動につき購入ごとに 1 回**。FR-6 の上限つきの再試行はその 1 回の中。送金ではなく報告で、同じ outcome は冪等）。`unknown` の購入と `source_released` の無い購入は対象外。
  `source_complete_unreported` の理由が「解けない 409／404」の購入も対象外（運用者の確認に回す）。

### 4.6 再起動と復旧
- **FR-7** 再起動の規則は既存のまま: `source_settled`（`source_released` の行の有無によらず）→ `paid_undelivered`（`interrupted_at_restart`）、`source_pending`／`destination_pending`／`destination_submitted` → `unknown`。**facilitator の状態が `accepted`・`authorized` でも、それだけで release や上流への支払いを再開しない。**
  `source_released` の行があって再起動で `paid_undelivered` になった購入は、FR-6.1 により `failed` が報告される（Router は二度と配信しないため正確）。**行が無い**購入（release の応答・記録の前に落ちた）は報告しない: facilitator 側に release 済み・未完了の注文が残り得るが、FR-11 の確認で見える（運用者の判断）。
- **FR-7.1** 自動の照合（Router が自分の判断で facilitator を呼ぶもの）は次に限る: **同じ購入の中**（同じ process・承認期限の内）の release の GET による復元と complete の同じ outcome の再試行、再起動時の FR-6.1 の complete、および **読み取りだけ**の FR-9.2 (c) の requester の照会（quote の直前・起動時）。
  作成の再呼び出しは自動では行わない（FR-5.3）: 同じ digest での再呼び出しは、買い手が同じ requestId を再 quote したときだけ起きる。

### 4.7 取り戻し・読み取り
- **FR-8** 支払い済みで未配信・配信済みの結果は、既存の `GET /v1/purchases/{paymentId}`（所有 principal の token）でだけ読める。別の principal は `not_found`。新しい認証（SIWX 等）は足さない。
- **FR-11** 運用者の読み取り専用の確認（S-5）: adapter の耐久の記録と journal から、注文ごとに (orderId, routeId, paymentId, quote 時刻, 作成の所要時間・`existing`, settle の結果と `txRef`・所要時間, release の結果, complete の結果, 終端, `mayStillSettleUntil`) を一覧し、
  任意で facilitator の `GET /exact/orders/:id` を読んで `status.state`・`status.release.state`・**`status.release.afterRelease`**・`status.exact.state`・`status.exact.origin` を並べて表示する（Router が `source_failed`／`unknown` なのに facilitator が `accepted` の注文 = 外で払われたものが見える）。
  注文が分からない要求（FR-9.2 (c)）には `GET /exact/requesters/:digest/orders?resourceDigest=` で照会し、見つかった注文を同じ形で表示する（遅れた割当の発見の経路）。
  **facilitator には読み取りしか送らない**（release・complete・settle・作成を呼ばない）。唯一の書き込みは `--abandon <requesterDigest>`（FR-9.2 (d)。adapter の記録への 1 行。明示の flag と理由を要求する）。token は env のファイルから読み、出力しない。

### 4.8 枠と負荷
- **FR-9** adapter の上限（設定の `subethaExact.limits`、既定は保守的な値）: 累積の**要求**数（FR-2 (b) の行を数える。結果が分からない要求も数え、再起動で戻らない）、未解決の要求数、1 分あたりの要求数、同時の作成 1 本。
  上限に達した quote は資金が動く前に `source_offer_unavailable` で断る。復旧の呼び出し（GET・release・complete）はこの上限の対象外だが、facilitator の共有の rate limit（§3-7）は受ける。
- **FR-9.2** **未解決の要求の解き方**。要求は次のどれかでだけ未解決から外れる。**経過時間だけでは外れない**（割当は 503 の後も続き、注文の TTL は割当の完了から始まる。§1）:
  (a) 注文が分かった（`created` の記録がある）要求は、settle が確定するか、`expiresAt` + 猶予を過ぎたら外れる（TTL が分かっているので安全）。
  (b) 確定の拒否（403／401／404／検査の不一致）は外れる。
  (c) 注文が分からない要求（503・5xx・timeout・応答の喪失）は、facilitator に **`GET /exact/requesters/:digest/orders?resourceDigest=`** で照会し、注文が見つかれば `created` として記録して (a) に移る。**見つからなくても外れない**（一覧は記録済みの注文だけを返し、進行中の割当は返さない。割当は取り消されず、いつ終わるかに上限が無い）。照会は上限に達した quote の直前と起動時に、要求ごとに 1 回（rate limit を受ける）。照会が失敗すれば未解決のまま。
  (d) 注文が分からないまま残る要求は、**運用者の明示の操作**（FR-11 の道具の `--abandon <requesterDigest>`。adapter の記録にその判断を書くだけで、facilitator は呼ばない）でだけ外れる。Router は自動では外さない。
  (e) 外れた後に割当が遅れて完了した注文は、次の同じ digest の quote（`existing: true`）か FR-11 の照会で見える。
- **FR-9.1** 検証の期間と停止の条件（AC-7）は本スライスの設定の既定値として書き、段 4 の計画で確定する。

### 4.9 既存の安全条件と表
- **FR-10** 表に `{ network: "eip155:84532", id: "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f", decimals: 6, domain: { name: "zERC20 USD Coin", version: "1" } }` を足し、**資産単位の rail の制限**でこの資産を `subetha-exact` の受信だけに許す。
  `eip155:84532` の USDC の行と、`x402` 受信・送信が受ける資産の集合は変わらない。`SUBETHA_ZERC20_ASSETS`（Sepolia の `subetha-zerc20`）は変えない。
  `npm run sign` は、`exact` + `eip155:84532` + この資産の offer を、表の domain と一致するときだけ署名する（既存の分類器の規則に従う。cap 20,000）。
- **FR-10.1** 既存の安全条件（承認、quote の束縛、予算、1 支払い 1 署名、読み直しの一致、再起動後の非再送、`unknown` の耐久）は緩めない。既存の rail と旧 `subetha-zerc20` adapter の試験は変わらず通る。
- **FR-10.2** R1／MCP の一覧は、この route を `rail: "subetha-exact"`、`scheme: "exact"`、`fundsMoveOnCredential: false` で示す。**`@subetha/payer` の互換**: payer は `source.rail` が**明示されていて** `x402`／`mpp` 以外の静的 route を載せず（表の rail への fallback は `rail` が無いときだけ）、
  したがって quote も署名もしない。これを payer の単体試験で固定する（この route を含む一覧を与え、行が落ちること）。表の写し（`packages/payer/src/vendor/`）は機械的に更新し、byte 一致の試験が通ること。

## 5. 非機能要件

- **NFR-1** テストネットだけ: 表の行は `eip155:84532` だけで、`subetha-exact` はこの (network, asset) 以外を設定できない（`ConfigError`）。メインネットの network・資産は構造上設定できない。
- **NFR-2** 計測の記録: adapter の耐久の記録と既存の診断（`DiagnosticsSink`）に、注文ごとの時刻と所要時間（作成・verify・settle・release・complete）、HTTP の status の分類、結果を残す。値（URL・token・本文の文章・署名）は残さない。
- **NFR-3** 失敗の分類の固定: journal・応答に出る理由は既存の `SAFE_REASONS` の集合に新しい固定 code を足して閉じる（`source_offer_unavailable`、`source_offer_refused`、`source_release_refused`、`source_release_unknown`、`source_complete_unreported`）。
- **NFR-4** 合成 facilitator（fixture）は tenant の面（Bearer の注文 route、公開の verify）を**実装の source の挙動のまま**模す: status code、固定の本文、`existing` の再利用、503 の admission と割当の継続、release の 1 回性と 425、complete の冪等と 409、署名の検査（viem）、`binding`・`status.release`・`afterRelease` の view。fixture の振る舞いの表は設計に載せる。

## 6. 受け入れの条件（本スライス = 合成 facilitator での試験。段 4 の実購入は別）

- **AC-1** 合成 facilitator を相手に、実 CLI（`src/main.ts`）・実 TCP・実 EIP-712 署名（`tools/x402-payer.ts`）で、quote → 承認 → `npm run sign` 相当 → purchase が `delivered` になり、journal に `source_settled` → `source_released` → `destination_pending` → `delivered` → `source_completed` の順で行があり、fixture の注文が `release.state: "delivered"` になる。
- **AC-2** 失敗の経路（それぞれ資金の結果・journal の行・facilitator の呼び出し数を固定する）:
  (a) quote のあと払わない（注文は作られ、期限で閉じる。Router は何も呼ばない）。
  (b) facilitator の 503・429・403・401 で quote が失敗する（code と HTTP の対応）。
  (c) **作成の応答の喪失**（fixture が注文を作ってから応答を落とす）: 同じ requestId の再 quote が同じ注文を得る。**別の requestId** は別の注文を得る。
  (c′) 再利用の注文が期限切れ・別額: quote は `source_offer_refused` で失敗し、資金は動かない。記録と違う `orderId` の `existing: true` も失敗する。
  (d) **release の応答の喪失**（fixture が release を記録してから応答を落とす）: GET で復元して `delivered` に至る。復元の条件（binding・deliveryKey・txRef・eventId・afterRelease）が 1 つでも違えば `paid_undelivered`。GET が 5xx なら `source_release_unknown`。
  (e) release の 425 のあと成功。(f) release の `incident` → `paid_undelivered` `source_release_refused`、上流への送信は 0 回。
  (f′) **release の前の reorg**: fixture が receipt の消失・block の変化・非 canonical を `not-ready`（425）で返し続ける → 再試行の上限で `source_release_unknown`、上流への送信は 0 回、complete は呼ばれない。
  (g) **再起動の境界**（それぞれ、再起動後の状態・complete の有無・上流への送信 0 回を固定）: settle の前（`source_pending`）→ `unknown`；settle の後 release の前 → `paid_undelivered`、release も complete も呼ばれない；
      release の**遠隔の記録の後・ローカルの行の前** → `paid_undelivered`、complete は呼ばれない（facilitator に `authorized` が残る。FR-11 で見える）；release の行の後 送出の前 → `paid_undelivered`、`failed` が報告される；
      送出の途中（`destination_pending`）と送出の後（`destination_submitted`）→ どちらも `unknown`、complete は呼ばれない；終端の行の後 complete の前 → 起動時に同じ outcome で complete；complete の応答の喪失の後 → 起動時に同じ outcome で complete（冪等で 200）。
  (h) **重複した購入**（同じ quote を並行・連続で purchase）: settle は 1 回、release は 1 回、complete は 1 回。
  (i) **別の principal の取り戻し**: `not_found`。
  (j) **complete の再試行**: 最初の complete が 5xx でも同じ outcome で届く。409 `conflicting-outcome` は再試行せず `source_complete_unreported` になり、起動時にも呼ばない。
  (k) 承認に時間を使って期限が切れる。2 つに分ける: (k1) credential を出す前に承認期限が過ぎた purchase（`approval_expired`、journal に行なし）: 応答に上限の `mayStillSettleUntil = expiresAt`（FR-4.4 (i)）。
      (k2) 手元の署名の検査の後、facilitator の verify・予算の間に期限が過ぎた purchase（`source_failed` `approval_expired`）: 行と応答に正確な `mayStillSettleUntil`（FR-4.4 (ii)）。どちらも **Router は送らない**（「Router が送っていない」と「外で払われていない」を区別する）。
      (k3) 手元の検査の前の終端（`offer_unavailable`・`offer_changed`・`operator_funds_unavailable` の 3 経路）: `source_failed` の行と status に上限の `mayStillSettleUntil`（FR-4.4 (i′)）。
  (l) settle の失敗の全 code（`rejected` の code、`pending`、`late-paid`、5xx、timeout）が `unknown` になり、`awaiting_payment` にならない。
  (l′) facilitator の verify が拒否した後に、fixture がその注文を**外から払われた**状態（`accepted`）にする: Router の status は `awaiting_payment` のまま `awaitingPaymentDoesNotMeanUnpaid: true`・`mayStillSettleUntil` を出し、FR-11 の確認がその食い違いを一覧する。
  (m) 同じ requestId の再 quote（`created` を離れた後）は `closed: true` で `source.offer` の無い文書を返し、`npm run sign` はそれを拒み（**この再 quote の文書には**署名の対象の offer が無い。保存済みの最初の文書は別: FR-4.5 の保証の範囲）、その quote への purchase（元の credential でも）は facilitator を呼ばずに現在の状態を返す。`created` のままの再 quote は今までどおり同じ文書。
  (n) **枠**: 503・応答の喪失・再起動のどれでも、要求の枠は戻らない（累積・未解決の数が記録から復元される）。上限に達した quote は**作成の POST を 0 回**（枠の確認の GET は FR-9.2 (c) に従う）。**遅れた割当**: fixture が 503 の後に注文を作る → 要求時刻 + TTL + 猶予を過ぎても未解決のまま（時間では外れない）→ 照会で注文が見つかり `created` に移る。
      **照会が空でも外れない**: fixture が 503 を返し、1 時間以上（時計を進める）照会が空のまま → 未解決のまま（上限に数える）→ その後に割当が完了 → 次の照会で `created`。運用者の `--abandon` だけが外す（道具の試験）。
- **AC-3** 既存の試験（unit・wire）が変わらず通る。`subetha-exact` の route が無い構成の起動ログ・一覧・golden は変わらない。
- **AC-4** `npm run sign` が、この route の quote を表の domain で署名し、違う domain・違う network・20,000 超・`closed: true` の文書を拒む（単体試験）。zUSDC@84532 の `exact` offer は表の資産単位の制限により **`subetha-exact` の route からしか出ない**（`x402` の route に zUSDC を設定すると `ConfigError`。NFR-1 の試験）ので、CLI は rail を判別しなくてよい。quote 文書の `source.rail` が rail を人に示す。payer の一覧の試験（FR-10.2）が通る。
- **AC-5** FR-11 の確認が、AC-1・AC-2 の記録を一覧し、通常の実行では **facilitator に GET 以外を送らず・ローカルの記録も変えない**ことを試験で固定する（fixture の呼び出し数と、journal・adapter の記録の前後の byte 一致）。`--abandon` だけが adapter の記録に 1 行を足し、Router の稼働中は拒む。
- **AC-6** Codex（`gpt-6-astra`、CLI）の独立レビューを要件・設計・タスク・実装の各段で行い、出力を `.claude_workflow/local/` に残す。
- **AC-7** 段 4 の検証の上限（累積の要求数・未解決の数・1 分あたりの数）が設定の既定値として入っている。期間と停止の条件（累積の上限に達したら止める、未解決が上限に達したら FR-11 で確かめる）は `docs/subetha-exact-inbound-acceptance.md` に書く（v4.2: 期間は設定の値ではなく段 4 の計画の値）。

## 7. やらないこと・残す危険

- facilitator の変更は無い。必要になれば止めて報告する。
- 買い手が Router の外で（公開 settle 経由で）同じ authorization を出した場合: facilitator は注文を `accepted` にするが Router は `source_failed`（開示つき）／`unknown` のまま。FR-11 の確認で見つけ、返金は運用者の判断（テストネットでは無視できる）。Router は自動では何もしない。
- 受信の取り消し（reorg）: facilitator の release は receipt だけを見る（finality 無し）。Router は上流に払った後の reorg を検知しない（既存どおり）。`afterRelease` は FR-11 で見えるだけ。
- release の遠隔の記録の後・ローカルの行の前に落ちた購入は、facilitator に `authorized`・未完了の注文を残す（FR-7）。Router は推測で complete しない。FR-11 で見える。
- hosted に載せる条件（quote の入口の認証、買い手ごとの制限、全体の割り当ての予算）は紙の案 §7 段 5 のまま、本スライスでは扱わない。

## 8. 出典と未確認

- 【事実】の出典は §1 の行番号（v2 で全件を `grep -n` で確かめ直した。v1 の `exact-settle.ts` の行は別ファイルと連結した出力の行番号で 392 ずれていた）。facilitator の配備の値（domain・TTL・上限）は `facilitator-multi.env` の repo の値で、実行中の値は段 3 で `GET /p/<id>/exact/supported`・最初の注文の `requirements` で確かめる。
- 【未確認】hosted の実測の性能（注文の作成の所要時間、release の 425 の頻度、settle が facilitator の 30 秒の要求期限に収まるか）。段 4 で測る。
- 【推論】§3 の 1・4・5 の選択（決定的な requesterDigest、`challengeNonce = orderId`、settle の失敗を全部 `unknown`）。設計で facilitator の source と突き合わせて固定する。

## 9. v1 → v2 の対応（Codex `req-review1.md`）

| # | 指摘 | 反映 |
|---|---|---|
| 1 must | `rejected` の集合は「払えない」集合ではない | FR-4.2: settle の後の失敗は**全部 `unknown`**。理由と source を書いた |
| 2 must | verify の拒否・settle 前の拒否で未知の支払いを未払いとして公開 | FR-4.1 (a) の後は `mayStillSettleUntil` を耐久に記録し、status／purchase／MCP に開示（FR-4.4）。AC-2 (k)(l′) |
| 3 must | 決定的 digest は永久の idempotency key ではない | §3-1・FR-2・FR-2.2・FR-3 を facilitator の規則どおりに書き直した（閉じた後・別 route は新しい注文。`existing` の照合、salt の耐久、長さ付き符号化、欄なしは拒否）。FR-7.1 と整合 |
| 4 must | 終端の quote は再提示される | §1 に事実を書き、FR-4.5 で公開の契約（再 quote・purchase の拒否・nonce = orderId）を定め、AC-2 (m) |
| 5 must | `source_released` の再起動の規則と耐久の証拠 | 行であって状態ではない（FR-5.2）。`failed` は行があるときだけ、推測しない（FR-6・FR-7）。AC-2 (g) に境界を全部 |
| 6 should | GET 復元の条件と保証 | FR-5.1 に条件を列挙（binding・state・deliveryKey・txRef・eventId・`status.release.afterRelease`）。GET の失敗は `unknown` |
| 7 must | 作成結果不明の要求が枠から漏れる | FR-2 (b) の行を枠の予約にし、要求数で数える（FR-9）。AC-2 (n) |
| 8 must | payer は未知 rail を無視しない | §1 に事実、S-3／FR-10.2 で payer の fallback を「`rail` が無いときだけ」に限り試験で固定。AC-4 |
| 9 should | 引用行の誤り | §1 を全件修正（§8 に原因） |
| 10 must | AC-2 が計画の異常系を満たさない | AC-2 (c′)(d)(f′)(g)(k)(l′)(m)(n) を追加・具体化 |
| 11 should | HTTP と秘密の要件 | FR-1 の秘密の対象を拡大、FR-5.3（期限・64 KiB・redirect・429）、FR-6（解けない 409／404 は再試行しない）、FR-11 に `afterRelease` |

## 10. v2 → v3 の対応（Codex `req-review2.md`）

| # | 指摘 | 反映 |
|---|---|---|
| 前回 3 partly | 別 route の再利用と「同じ注文」の矛盾 | FR-2.2: 新しい注文が作られ得るのは `created` 行の前だけ、と限定。記録は追記だけ |
| 前回 4 not fixed | 再 purchase の抑止は再署名の抑止ではない | FR-4.5 を書き直し: `created` を離れた quote の再 quote は `closed: true` で **`source.offer` を載せない**（全 rail の core の変更として明示）、CLI は `closed`／offer 無しを拒む、MCP は署名しないと言う。AC-2 (m)、AC-4 |
| 前回 6 partly | GET 復元で eventId の形を見ていない | FR-5.1 に直接の応答と同じ eventId の検査 |
| 前回 7 partly | 未解決の枠を時間で戻すのは安全でない | FR-9.2: 時間だけでは外さない。注文が分かれば TTL で、分からなければ `GET /exact/requesters/…` の照会で解く。AC-2 (n) に遅れた割当 |
| 前回 9 partly | 引用の 3 点 | §1: 同じ route の条件、分類器の行、`handler.ts` の明記。TTL の起点の事実を追加 |
| 前回 10 partly | `destination_submitted` | AC-2 (g) に明示 |
| 前回 11 partly | 操作全体の期限 | FR-5.3 に「再試行の待ちを含む操作全体の期限」 |
| N1 must | 共通の 429 再試行が settle の再送禁止を上書き | FR-5.3 を操作ごとの表に（settle は 1 回だけ、complete は購入の状態を変えない）。FR-6.1 の「1 回」の範囲 |
| N2 must | AC-2 (k) は要件の順では成立しない | FR-4.4 を (i) 手元の検査の前（上限 = `expiresAt`、rail の同期の問い合わせ）と (ii) 後（正確な `validBefore`）に分け、AC-2 (k) を (k1)(k2) に |
| N3 should | `source_released` 必須の適用範囲 | FR-5.2 を「`release` を持つ rail の購入では」に限定 |
| N4 should | CLI が 2 つの rail を区別する契約が無い | AC-4 を書き直し: 表の資産単位の制限で zUSDC の `exact` は `subetha-exact` からしか出ない（CLI は判別しない）。`source.rail` が人に示す |

## 11. v3 → v4 の対応（Codex `req-review3.md`）

| # | 指摘 | 反映 |
|---|---|---|
| 前回 7 not fixed | 空の照会 + 経過時間は割当の終了の証拠ではない | FR-9.2 (c)(d): 照会が空でも外れない。外れるのは注文が分かって期限／settle を過ぎたとき、確定の拒否、**運用者の明示の `--abandon`** だけ。`abandoned` の自動化を削除。FR-11 に requester の照会を足し、AC-2 (n) に「1 時間超・照会が空・その後の割当」 |
| 前回 9 partly | 引用 2 点 | §1: `orchestrator.ts:943`、`handler.ts:44-51` |
| N5 must | 手元の検査の前にも終端の行がある | FR-4.4 を (i)(i′)(ii) に。(i′) = `offer_unavailable`・`offer_changed`・`operator_funds_unavailable` の行に上限を書く。§1 に事実、AC-2 (k3) |
| N6 should | 自動照合の範囲の矛盾 | FR-7.1: 作成の再呼び出しを自動の照合から外し（買い手の再 quote だけ）、FR-9.2 の読み取りの照会を列挙に足す |
| N7 note | 再提示の抑止 ≠ 署名材料の取得不能 | FR-4.5 に保証の範囲（保存済みの文書の外部署名は防げない）を明記 |

v4 → v4.1（Codex `req-review4.md`、APPROVE WITH CHANGES）: N7 partly → AC-2 (m) を「この再 quote の文書には offer が無い」に限定；N8 → AC-2 (n) を「作成の POST は 0 回、枠の確認の GET は FR-9.2 (c)」に、§3-7 の GET の記述を揃えた；N9 → S-5 と AC-5 に `--abandon`（ローカルの記録だけ）と記録の前後比較；N10 → `orchestrator.ts:749-786`、`CREATE_ANSWER_MS` の出典。

v4.1 → v4.2（設計 v2 とタスクのレビューからの註。設計 §13）: AC-7 の期間と停止の条件は acceptance 文書へ（設定の値は 3 つの上限）；NFR-2 の「診断に」は verify・settle の往復と transport の出来事（所要時間の計測は adapter の記録）；FR-9.2 (d)／FR-11 の `--abandon` の鍵は attempt の識別子；FR-4.5 (a) の「`source.offer` を載せない」は公開の面（HTTP・MCP）の契約で、core の in-process の文書の型は変えない。

v4.2 → v4.3（設計 v3 の註。設計 §13）: FR-6 の「反復で解けない」失敗に **401 と tenant の 404**（`{error:"unknown"}`）を含める（一時として起動時に再試行するのは timeout・5xx・429・読めない 200 だけ）；FR-5.3 の公開 verify の transport の失敗は adapter が捕まえて `isValid: false`（正確な `mayStillSettleUntil` を保つ。throw しない）；AC-2 (g) の `destination_submitted` は静的・動的の経路では書かれない行なので wire の SIGKILL では作れず、単体試験で journal に行を直接書いて再起動の規則を確かめる（受け入れの逸脱として記録）。

v4.3 → v4.4（設計 v5 の註、設計 §17）: FR-9.2 (c) の「照会で注文が見つかれば `created` として記録して (a) に移る」を改める: 照会で見つかった注文は **pair の記録（`discovered`）として未解決の負荷に数える**が、**結果の分からない要求には結び付けない**（facilitator の view に要求の識別が無く、要求の記録の順と server の実行の順は一致しないため）。結果の分からない要求は FR-9.2 (d) の運用者の `--abandon` でだけ外れる。不変条件: 結果の分からない要求は Router の自動の判断では未解決から外れない。
