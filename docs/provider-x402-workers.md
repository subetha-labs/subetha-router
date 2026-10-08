# Arc・Solana の Provider（`subetha-provider-x402` の Arc 版・Solana 版）— 要件と設計（第 2 版）

owner の決定（2026-10-08）: 既存の Provider と同じ **Cloudflare Workers** に揃える。新しい鍵は Router 側（この worktree の作業者）が作る。
公開名は `provider-x402-arc.subethalabs.com`（Arc）・`provider-x402-sol.subethalabs.com`（Solana）。
送信レールの要件 D-10（`docs/multirail-outbound-requirements.md`）で「owner が `subetha-provider-x402` を Arc と Solana に配備する」と決めた分の実体。

第 2 版はレビュー 1 回目（§8）の 6 点を反映: settle は **1 回だけ**（SDK の再試行を使わない）、送出後の失敗は **502（Router は `unknown`）**、本文は **記録済みの Provider A の契約そのもの**、期限の予算、鍵の扱い、証拠のラベル。

## 0. 範囲と置き場

- 作るのは **x402 v2 の `exact` を受け取る HTTP の資源サーバ**を 2 つ（Arc testnet USDC、Solana devnet USDC）。1 つの Worker のソースを wrangler の環境（`--env arc` / `--env sol`）で切り替え、2 つの Worker として配備する。
- 置き場は **この Router リポジトリの `providers/x402-workers/`**（独立した `package.json`・`wrangler.toml`。Router の `src/` は import しない。Circle の売り手証明は `src/adapters/inbound/seller-proof.ts` の純粋な部分を**写して**使う（§3.3）。Router の build・試験には影響しない）。
  既存の Provider のソースは手元に無い（Cloudflare にだけある）ので、**同じ 402 の形**（§2.1）と**同じ本文の契約**（§2.3）に合わせる。
- 資源は 1 本: `GET /v1/eth/snapshot`。クエリは受けない。
- 範囲外: Base／Tempo の既存 Provider の変更、MPP の Provider、同一チェーンの組（Router の D-16）、Bazaar、動的価格、settle 後の追跡（§2.2 の `settlement_pending` は `unknown` で返す）。

## 1. 外部の事実（2026-10-08 に確認）

| 事実 | 出典 |
|---|---|
| Circle の facilitator `https://api.circle.com/v1/facilitator/x402` は `eip155:5042002` の USDC `0x3600…`（6 桁、domain USDC/2）の `exact` v2 を提供する。x402.org の facilitator は Arc を提供しない | `/supported` の応答 |
| Circle は売り手に `Facilitator-Seller-Proof`（EIP-712 `SellerRequest`、受取鍵で署名、**要求本文の keccak256 を含む**）を要求する。API key は使わない。要求の形は `{ x402Version, paymentPayload, paymentRequirements }`。trial が尽きると `403 registration_required` | Router の受信 adapter（`src/adapters/inbound/x402.ts` kind `circle`、`seller-proof.ts`）、`docs/multirail-design.md` §3・§6 |
| Circle の受取は requirements の `extra` に `assetTransferMethod: "eip3009"` を要求する。Router の Circle 受信は wire の窓 `maxTimeoutSeconds` を 30 秒、settle の HTTP 期限を窓 + 10 秒にしている | Router の受信 adapter（`CIRCLE_ISSUED_EXTRA_KEYS`、`CIRCLE_DEFAULT_WIRE_TIMEOUT_SECONDS`） |
| x402.org の facilitator は `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`（devnet）の `exact` v2 を提供し、`extra.feePayer` を名乗る。fee payer（手数料）は facilitator。settle は `settlement_pending`（署名つき）で返ることがある | `/supported` の応答、Router の受信 adapter（§5.8 の追跡） |
| SVM の `exact` は `payTo` を **owner** として扱い、宛先 ATA は `findAssociatedTokenPda(mint, owner)` で導く。**ATA は事前に作る**（rent は運用者） | `docs/multirail-outbound-requirements.md` V-7、SDK |
| x402 SDK `@x402/core` 2.28.0: `x402ResourceServer.settlePayment` は `settlement_pending` や一部の例外で **facilitator の settle をもう 1 度呼ぶ**（`settleWithPendingRetry`）。`x402HTTPResourceServer.processHTTPRequest` は検証の例外を **例外の文言を含む 402** にする。`HTTPFacilitatorClient` は既定 90 秒・redirect を追う・`createAuthHeaders` は本文を受け取らない | `node_modules/@x402/core` の実装 |
| SDK の EVM／SVM の server scheme は `node:` の module を import しない（Workers での動作は AC-P2 の `wrangler dev` で確かめる。import が無いだけでは証明にならない） | `grep "node:"` が空 |
| Router の送信（x402）の有料要求の期限は **30 秒**（`paidTimeoutMs`）。領収は `PAYMENT-RESPONSE` の `success === true`・`network` 一致・`transaction` の形（EVM は bytes32、SVM は base58 64 バイト）・`payer` があれば署名者と一致を要求し、**領収なしの 5xx は `unknown`、4xx は `rejected`**（`dest_failed`） | `src/adapters/outbound/x402-dynamic.ts` `receiptOf`／`paidOutcomeOf`、送信の設計 §5 |
| 記録済みの Provider A の本文の契約（chat の `market-data.mjs` が検証する形。鍵は**過不足なく**一致） | `docs/t5-design.md` §1.5、`tests/fixtures/market-snapshot-server.ts` |
| データ源: Hyperliquid の公開 `POST https://api.hyperliquid.xyz/info` `{"type":"metaAndAssetCtxs"}` に ETH の `markPx`・`prevDayPx`・`dayNtlVlm` と universe の index（`assetIndex`）がある（鍵不要）。既存の Provider の 402 の説明は「ETH perpetual snapshot (Hyperliquid mark price, 24h change)」 | 実測、既存 Provider の `PAYMENT-REQUIRED` |
| wrangler はこの機械に未インストールで、Cloudflare の認証も無い | `which wrangler`、`~/.wrangler` |

## 2. 要件

### 2.1 402（未払いの GET）

- `PAYMENT-REQUIRED` ヘッダ（base64 JSON、x402 v2）。`accepts` は **1 件**:
  - Arc: `{ scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "10000", payTo: <Arc の受取 address>, maxTimeoutSeconds: 30, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }`
  - Solana: `{ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "10000", payTo: <受取 owner の公開鍵>, maxTimeoutSeconds: 30, extra: { feePayer: <facilitator の feePayer> } }`。**`memo` は出さない**（Router が `subetha:<paymentId>` を付ける。固定 Memo は FR-37 で許されるが衝突の拒否を招き、要求ごとの乱数 Memo は読み直しの一致を壊す）。SDK の SVM scheme に `rpcUrl` を渡さない（`recentBlockhash` を足させない）。
- `maxTimeoutSeconds` は **30**（Arc: Circle の窓と同じ。Solana: 同じ値。Router の候補検査 1..600 の内側）。
- `resource.url` は要求された canonical URL（`https://<host>/v1/eth/snapshot`）、`description`・`mimeType: application/json`。トップレベルは `x402Version`・`error`・`resource`・`accepts` だけ（Router は未知のトップレベルを捨てる。`extra` の未知の鍵は候補外にするので上の集合以外を足さない）。
- 本文は `{}`、`cache-control: no-store`。
- 額は既存と同じ **10000**（0.01 USDC）。Router の静的 route の `destination.quoted`・動的の `maxUpstreamAmount` 10000 と整合する。

### 2.2 支払いつきの GET（`PAYMENT-SIGNATURE`）と結果の表

処理の順序と時間の予算（Router の有料要求の期限 30 秒の内側に収める。合計の上限 **28 秒**）:

| 段 | 内容 | 期限 | 失敗したときの応答 |
|---|---|---|---|
| 0 | ヘッダを decode。`accepted` が自分の requirements（§2.1 を同じ関数で組み直す）と**完全一致** | — | **402**（`PAYMENT-REQUIRED` を付け直す。本文は固定文。資金は動いていない） |
| 1 | データを取る（Hyperliquid）。検証（§2.3 の形）と大きさ（64 KiB）までここで終える | 2 秒 | **502** `{ error: "data_unavailable" }`。facilitator は呼ばない（「払ったのにデータが無い」を作らない） |
| 2 | `/verify`（自前の client。§3.2） | 4 秒 | `isValid: false` → **402**（本文 `{ error: "payment_invalid" }`。facilitator の文言は透過しない）。HTTP 不達・期限・形違い → **502** `{ error: "facilitator_unavailable" }`（資金は動いていないが、Router 側で `rejected` にしないため。verify は冪等なので Router が新しい購入で再試行できる） |
| 3 | `/settle` **1 回だけ**（§3.2 の guard。SDK の `settlePayment` は使わない） | 20 秒 | 下の表 |
| 4 | **200** + `PAYMENT-RESPONSE` + 本文（§2.3。1 で取った値を返すだけ） | — | — |

settle の結果の表（送出後なので、成功を確かめられたとき以外は **`unknown` を Router に伝える = 領収なしの 502**）:

| facilitator の応答 | Provider の応答 | Router の結果（送信の設計 §5） |
|---|---|---|
| 200、`success: true`、`network` が requirements と一致、`transaction` が形どおり（Arc: `0x` + 64 hex、Solana: base58 で 64 バイトに復号）、`payer` があれば形どおり | **200** + `PAYMENT-RESPONSE { success: true, transaction, network, payer? }` + 本文 | `paid` → `delivered` |
| 200、`success: false`、`errorReason: "settlement_pending"`（Solana。署名つきでも） | **502** `{ error: "settlement_pending" }`（追跡はしない。範囲外） | `unknown` |
| 200、`success: false`、他の `errorReason` | **502** `{ error: "settle_failed" }` | `unknown` |
| 200 だが `transaction`／`network`／`payer` の形が違う | **502** `{ error: "receipt_malformed" }`（成功を名乗らない） | `unknown` |
| 403 `registration_required`（Circle の trial 切れ） | **502** `{ error: "facilitator_registration_required" }`。運用者向けに同じ固定文を `console.error`（値無し） | `unknown`。**自動で再試行しない、facilitator を替えない** |
| 4xx・5xx・不達・期限・JSON でない | **502** `{ error: "facilitator_unavailable" }` | `unknown` |

- **応答の本文もヘッダも固定文だけ**（facilitator の文言・例外の文字列・鍵・URL を含めない）。SDK の `processHTTPRequest` は例外の文言を 402 に入れるので、支払いつきの経路では使わない（§3.1）。
- 1 要求で facilitator の settle は最大 1 回。Provider は再試行しない。client（Router）の再送は新しい購入として扱う（同じ authorization の nonce は facilitator が拒む）。

### 2.3 本文（支払い後）— 記録済みの Provider A の契約そのもの

`docs/t5-design.md` §1.5・`tests/fixtures/market-snapshot-server.ts` の形を**過不足なく**:

```json
{
  "providerId": "market-data-a",
  "market": { "kind": "perpetual", "symbol": "ETH", "quote": "USD" },
  "dataSource": { "name": "hyperliquid", "network": "hyperliquid-mainnet" },
  "payment": { "protocol": "x402", "network": "<eip155:5042002 | solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1>" },
  "fetchedAt": "<ISO、ミリ秒 3 桁、Z>",
  "data": { "markPx": "<文字列>", "prevDayPx": "<文字列>", "dayNtlVlm": "<文字列>", "change24h": { "absolute": "<文字列>", "percent": "<文字列>" }, "assetIndex": <number> }
}
```

- 数値は文字列 `/^-?\d+(?:\.\d+)?$/`（指数表記・`+`・空白・`.5`・`5.` 不可）。`assetIndex` は JSON number。鍵の集合は上と完全一致（余剰の鍵を 1 つも足さない）。
- `providerId` は **`market-data-a`**（これらは Provider A（x402 の Provider）の別チェーン版で、契約の ID は固定。チェーンは `payment.network` で表す）。**未確認**: chat 側の検証が `payment.network` を `eip155:84532` に限っていれば、Arc／Solana の本文は chat では弾かれる（Router の配達には影響しない）。契約の持ち主（chat）の確認を §7 に残す。
- `change24h.absolute = markPx − prevDayPx`、`percent = absolute / prevDayPx × 100`。小数の桁は Hyperliquid の値をそのまま（絶対値は `markPx` と同じ桁、percent は小数 2 桁）。
- Hyperliquid の応答の形が違えば（ETH が無い、数値の形が違う）**502**（段 1）。

### 2.4 鍵・env・Workers の環境

| 名前 | 種類 | Arc（`--env arc`） | Solana（`--env sol`） |
|---|---|---|---|
| `PROVIDER_NETWORK` | var | `arc` | `solana` |
| `PAY_TO` | var | 受取 address（**起動ごとに** `SELLER_PROOF_KEY` から導いた address と一致を検査。違えば全要求 500 固定文） | 受取 owner の公開鍵（base58 32 バイト） |
| `SELLER_PROOF_KEY` | secret | 受取鍵（`0x` 32 バイト） | 置かない（置いてあれば起動時の検査で 500） |
| `FACILITATOR_URL` | var | `https://api.circle.com/v1/facilitator/x402` | `https://www.x402.org/facilitator` |

- **鍵の作り方（標準出力に出さない）**: `providers/x402-workers/scripts/keygen.mjs` が乱数の鍵を作り、**標準出力には address だけ**を出し、鍵は `wrangler secret put SELLER_PROOF_KEY --env arc` の標準入力に**直接**流す（`node scripts/keygen.mjs | wrangler secret put …` ではなく、script が wrangler を子 process で起動して stdin に書く。端末・ログ・file に鍵が残らない）。owner が `wrangler login` 済みの端末で実行する。
- Solana の受取 owner の鍵は **owner の管理**（`npm run wallet:new:solana` は鍵を標準出力に出すので、owner が自分の端末で実行し `.env.local` にだけ保存する手順のまま）。Provider に渡すのは公開鍵だけ。
- 受取先は **Router の運用者の address の全部**と別にする: Router の受取先（Base `SUBETHA_ROUTER_RECEIVER`、Arc `SUBETHA_ARC_RECEIVER_KEY` の address、Solana `SUBETHA_SOLANA_RECEIVER`）、送信の署名者（`SUBETHA_OUTBOUND_X402_KEY`／`SUBETHA_OUTBOUND_PRIVATE_KEY` の address、`SUBETHA_OUTBOUND_SOLANA_KEY` の公開鍵）とそれらの ATA。新しく作る鍵なので一致しないが、配備の手順で address の一覧と突き合わせる（Router 側は運用者の集合で二重に拒む）。
- Solana: 受取 owner の **USDC の ATA を配備前に作る**（rent を払う devnet の鍵は owner）。Provider は起動時の検査を持たないので、配備の手順（§5）で `getAccountInfo` を見る。

### 2.5 受け入れ条件

- AC-P1: 402 の `accepts` が §2.1 のとおりで、Router の候補検査（Arc: `checkDynamicX402Offer` に §3.5 の変更を入れたもの、Solana: `checkSvmOffer`）を通る（Router の試験で、fixture の accepts を §2.1 と同じ値にして確認）。
- AC-P2: Router の fixture の facilitator（`tests/fixtures/circle-facilitator.ts`・`svm-facilitator.ts`）に向けた Worker（`wrangler dev`）で、Router の送信 adapter の wire 試験と同じ購入が `delivered` になる。あわせて settle の結果の表の各行（pending・4xx・不達・形違い）が **502** で返り、facilitator の settle が **1 回**であることを fixture の計数で確かめる（Workers の実行環境での動作の確認もここ）。
- AC-P3: 実 facilitator への probe は owner の承認のもとで（Arc: Circle の trial の消費、Solana: V-8b と同じく資金が動く）。
- AC-P4（配備後）: V-6・V-7・V-12 の記録 = 402 を 2 回取り、`extra` の鍵と要求ごとの変化、Solana の宛先 ATA の存在（`getAccountInfo`）。**V-13** = 実際の有料要求の HTTP の状態・`PAYMENT-RESPONSE` の形・応答時間（成功・失敗・pending）— UG-A／UG-S の G-3′ で記録する（未払いの 402 では満たさない）。

## 3. 設計

### 3.1 構造（1 つの Worker）

```
providers/x402-workers/
  package.json     (@x402/core, @x402/evm, @x402/svm, viem, @solana/kit, wrangler, vitest, typescript)
  wrangler.toml    ([env.arc] / [env.sol] に vars。compatibility_flags = ["nodejs_compat"]。name は env ごと)
  scripts/keygen.mjs   §2.4 の鍵の作成（address だけ出力、鍵は wrangler の stdin へ）
  src/
    index.ts           fetch handler（§3.1 の順序）
    config.ts          env の検査（network ごとの固定値の表。payTo の形、鍵の形、鍵 → address の一致）
    requirements.ts    §2.1 の requirements を組む（SDK の `x402ResourceServer` で `/supported` を読み、`buildPaymentRequirementsFromOptions` → `createPaymentRequiredResponse`。feePayer は SDK が足す）
    facilitator-client.ts  自前の client（§3.2。verify/settle/getSupported。期限・redirect・本文の上限・固定の失敗。Circle のときは売り手証明）
    seller-proof.ts    Router の seller-proof.ts の純粋部分の写し（§3.3）
    snapshot.ts        Hyperliquid の取得と §2.3 の封筒（形の検証を含む）
    receipt.ts         settle の応答の検査（§2.2 の表）と `PAYMENT-RESPONSE` の作成
  test/                vitest（Node で: 純粋関数と、fetch を差し替えた handler。facilitator と Hyperliquid は差し替え）
```

fetch handler の順序（§2.2）: `GET /v1/eth/snapshot` 以外は 404。`PAYMENT-SIGNATURE` が無ければ 402（SDK で requirements を組み、`encodePaymentRequiredHeader`）。あれば `decodePaymentSignatureHeader` → `accepted` の完全一致（`stableJson`）→ データ → verify（自前の client）→ settle（自前の client、1 回）→ 領収の検査 → 200。**SDK の `processHTTPRequest`・`settlePayment`・`processSettlement` は使わない**（例外の文言の透過と settle の再試行を避ける）。SDK を使うのは requirements の作成・402 の封筒・`PAYMENT-RESPONSE` の符号化だけ。

### 3.2 自前の facilitator client

- 1 つのクラスを両方で使う。`verify`／`settle` は `JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements })` を **1 度だけ**作り、Circle のときはその文字列の keccak256 を `bodyHash` にして `SellerRequest` に署名し `Facilitator-Seller-Proof` を付ける。同じ文字列を body に送る。
- `redirect: "error"`、期限 verify **4 秒**・settle **20 秒**・supported 10 秒。応答の本文は 64 KiB まで。HTTP の状態と本文の形を見て §2.2 の表に写す。facilitator の文言は client の外に出さない（固定の分類だけ）。
- **settle の guard**: 要求ごとの client の object が `settle` の呼び出しを数え、2 度目は throw（試験で確かめる。SDK を通さないので再試行は起きないが、二重の防御）。
- `getSupported` は GET。SDK の `x402ResourceServer` に渡すのはこの client（`initialize()` が `/supported` を読む）。isolate ごとに 1 度 `initialize()`（失敗したら次の要求でやり直す。402 を出せない間は 503 固定文）。

### 3.3 売り手証明（Arc）

- `SellerRequest` の型・domain（`Circle Facilitator Seller Request` / `1` / chainId 5042002）・寿命 60 秒・nonce 32 バイト（`crypto.getRandomValues`）・封筒（base64url JSON）は Router と同じ。鍵は `SELLER_PROOF_KEY` から viem の account を作り、`signTypedData` だけを closure に閉じる（config には address だけ）。

### 3.4 Solana

- SDK の `registerExactSvmScheme(server, { networks: [SOL] })`（`rpcUrl` 無し）。`feePayer` は `/supported` から SDK が `extra` に足す。`payTo` は owner。Memo は入れない。
- facilitator は §3.2 の client（証明無し）。

### 3.5 Router 側の変更（別 PR。この設計の P-0）

- `src/adapters/outbound/x402-dynamic.ts` `checkDynamicX402Offer`: `extra.assetTransferMethod` を **値が `"eip3009"` のときだけ**許す（他の値・他の未知の鍵は今までどおり候補外）。組み直しの署名器は `extra` を読まず、domain・宛先・額・authorization の型を自分で固定して検査するので、署名の内容は変わらない。SDK の client は `eip3009` を既定の経路として扱う。`tests/wire/x402-arc-outbound.test.ts` の「V-6 の結果まで候補にしない」を「`eip3009` は候補、`permit2`・他は候補外」に。
- 静的 route（`x402.ts`）は `extra` の鍵を見ない（変更なし）。SVM（`checkSvmOffer`）は `assetTransferMethod` を今までどおり拒む（Solana の Provider は出さない）。

## 4. 試験

| 層 | 内容 |
|---|---|
| unit（Worker） | config（network の表、payTo の形、鍵の形、鍵 → address の一致、Solana に鍵があれば拒む、例外の文言に値が無い）、seller-proof の往復（Router の fixture と同じ検証: 復号 → recover → payTo 一致 → bodyHash 一致 → 寿命）、snapshot の封筒（§2.3 の鍵の集合と数値の形。Hyperliquid の形違い → 失敗）、receipt の検査（表の各行） |
| handler（Node で fetch を差し替え） | 402 の形（§2.1 と byte 一致の `accepts`、トップレベルの鍵）、支払いつき: `accepted` 不一致 → 402、データ不達 → 502 で facilitator 0 回、verify 不正 → 402、verify 不達 → 502、settle の各行 → 502 と settle 1 回、成功 → 200 と `PAYMENT-RESPONSE`（SDK の decoder で読める）、**応答のヘッダと本文に facilitator の文言・鍵・URL が無い** |
| Router の既存の試験 | §3.5 の変更の wire 試験。`x402-arc-outbound`・`x402-svm-outbound` の fixture の accepts を §2.1 と同じ値にして候補になることを確認 |
| 結合（手元、AC-P2） | `wrangler dev` に Router の fixture の facilitator を向け、Router の wire 試験の harness から購入 → `delivered`。settle の pending／4xx／不達の各行 → Router が `unknown`、fixture の settle の計数 1 |

## 5. 配備（owner の作業を含む）

1. Router 側の P-0 を merge。
2. owner: `wrangler login`（この機械には認証が無い。私は認証情報を扱わない）。Cloudflare の DNS に 2 つのサブドメインを Worker の custom domain として追加。
3. 鍵: Arc は `scripts/keygen.mjs`（§2.4。address だけが出る。`--env arc` の secret に直接）。`PAY_TO` にその address を `wrangler.toml` の `[env.arc.vars]` に書く。Solana は owner が `wallet:new:solana` で作り、公開鍵を `[env.sol.vars]` の `PAY_TO` に。
4. Solana: owner が ATA を作る（`spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <公開鍵> --url devnet`。rent は owner の devnet の鍵）。私が `getAccountInfo` で確かめる（V-7）。
5. 受取先が Router の運用者の address（§2.4）のどれとも違うことを一覧で確認。
6. `wrangler deploy --env arc`／`--env sol`。配備後に 402 を 2 回取り記録（V-6・V-12）。
7. Router の UG-A／UG-S: `UPSTREAM_ARC`／`UPSTREAM_SOL` と受取先の env を入れる PR → G-2′ → G-3′（受け入れの購入。資金が動く。owner の承認。ここで V-13）→ G-4′。

## 6. 決めていないこと

- Circle の trial の残量と、尽きたときの登録（owner）。
- 価格は 10000 のまま（Router の区分・上限と整合）。

## 7. 未確認（契約の持ち主に聞く）

- chat の `market-data.mjs` が `payment.network` を `eip155:84532` に限っているかどうか（限っていれば chat 側の許可リストの更新が要る。Router の配達は影響を受けない）。

## 8. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版） | **REJECT**（高 3: SDK の settle の再試行、settle 失敗を 402 にする誤り、本文が記録済みの契約と違う；中 3: 期限の不整合、鍵の作り方と配備、V-13 のラベル）。第 2 版で反映 |
