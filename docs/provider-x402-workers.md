# Arc・Solana の Provider（`subetha-provider-x402` の Arc 版・Solana 版）— 要件と設計（第 3 版）

owner の決定（2026-10-08）: 既存の Provider と同じ **Cloudflare Workers** に揃える。新しい鍵は Router 側（この worktree の作業者）が作る。
公開名は `provider-x402-arc.subethalabs.com`（Arc）・`provider-x402-sol.subethalabs.com`（Solana）。
送信レールの要件 D-10（`docs/multirail-outbound-requirements.md`）で「owner が `subetha-provider-x402` を Arc と Solana に配備する」と決めた分の実体。

第 2 版はレビュー 1 回目（§8）の 6 点を反映: settle は **1 回だけ**（SDK の再試行を使わない）、送出後の失敗は **502（Router は `unknown`）**、本文は **記録済みの Provider A の契約**、期限の予算、鍵の扱い、証拠のラベル。
第 3 版は readback（§8）の 5 点を反映: 領収の `payer` は**同一性**まで検査、本文は契約の**拡張**（`payment.network`）として chat 側の確認を gate に、数値の制約、要求ごとの**1 つの期限**（cold start を含む）、Solana の seed を出力しない作り方、`unknown` の後の扱い。

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
| Router の送信（x402）の有料要求の期限は **30 秒**（`paidTimeoutMs`。動的経路と Solana は当初から。静的 EVM 経路は AC-P2 で 5 秒と分かり、§9 の 6 の follow-up で 30 秒に揃えた）。領収は `PAYMENT-RESPONSE` の `success === true`・`network` 一致・`transaction` の形（EVM は bytes32、SVM は base58 64 バイト）・`payer` があれば署名者と一致を要求し、**領収なしの 5xx は `unknown`、4xx は `rejected`**（`dest_failed`） | `src/adapters/outbound/x402-dynamic.ts` `receiptOf`／`paidOutcomeOf`、送信の設計 §5 |
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

処理の順序と時間の予算。**要求ごとに 1 つの期限**（要求の到着から **26 秒**）を持ち、各段の HTTP の期限はその残りと段の上限の小さい方。cold start（isolate の最初の要求）は facilitator の `/supported` の読み込み（上限 **5 秒**。失敗なら **503** 固定文、支払いは受けない）も同じ期限の内側。
settle に入る前に残りが **12 秒未満**なら settle を呼ばずに **503** `{ error: "provider_busy" }`（送出前なので資金は動いていない。Router は領収なしの 5xx = `unknown` にするが、facilitator は呼んでいない）。warm の経路: data 2 + verify 4 + settle 20 = 26 秒。cold の経路: 5 + 2 + 4 + settle（残り ≥ 15 秒）。

| 段 | 内容 | 期限 | 失敗したときの応答 |
|---|---|---|---|
| 0 | ヘッダを decode。`accepted` が自分の requirements（§2.1 を同じ関数で組み直す）と**完全一致** | — | **402**（`PAYMENT-REQUIRED` を付け直す。本文は固定文。資金は動いていない） |
| 1 | データを取る（Hyperliquid）。検証（§2.3 の形）と大きさ（64 KiB）までここで終える | 2 秒 | **502** `{ error: "data_unavailable" }`。facilitator は呼ばない（「払ったのにデータが無い」を作らない） |
| 2 | `/verify`（自前の client。§3.2） | 4 秒 | `isValid: false` → **402**（本文 `{ error: "payment_invalid" }`。facilitator の文言は透過しない）。HTTP 不達・期限・形違い → **502** `{ error: "facilitator_unavailable" }`（資金は動いていないが、Provider からは断定できないので `unknown` に揃える。Router は `unknown` を保ち、買い直さない） |
| 3 | `/settle` **1 回だけ**（§3.2 の guard。SDK の `settlePayment` は使わない） | min(20 秒, 残り) | 下の表 |
| 4 | **200** + `PAYMENT-RESPONSE` + 本文（§2.3。1 で取った値を返すだけ。`content-length` と `content-type: application/json` を付け、本文は 1 回の `end` で送る。署名（Arc の売り手証明）と応答の本文の読み書きも要求の期限の内側。**例外**: settle の成功を確かめた後に期限が過ぎていても 200 を返す（settle の後に残るのは領収の検査と封筒の組み立てだけで、I/O も署名も無い。ここで 502 にすれば確かめられた成功を `unknown` に変えるだけで、Router を守らない）） | — | 領収を受け取った後に本文の送出で接続が切れれば Router は `paid_no_data`（Provider からは防げない。Router は再送しない） |

settle の結果の表（送出後なので、成功を確かめられたとき以外は **`unknown` を Router に伝える = 領収なしの 502**）:

| facilitator の応答 | Provider の応答 | Router の結果（送信の設計 §5） |
|---|---|---|
| 200、`success: true`、`network` が requirements と一致、`transaction` が形どおり（Arc: `0x` + 64 hex、Solana: base58 で 64 バイトに復号）、`payer` があれば**支払い側の署名者と同一**（Arc: `paymentPayload.payload.authorization.from` と大文字小文字無視で一致。Solana: `paymentPayload.payload.transaction` を復号した message の 2 番目の static account（authority。Router の受信と同じ読み方）と一致） | **200** + `PAYMENT-RESPONSE { success: true, transaction, network, payer? }` + 本文 | `paid` → `delivered`（**本文まで受け取れたとき**。Router は `payer` を自分の署名者と比べる。facilitator が別の `payer` を返したら Provider が 502 にするので `unknown`） |
| 200、`success: true` だが `payer` が署名者と違う | **502** `{ error: "receipt_malformed" }` | `unknown` |
| 200、`success: false`、`errorReason: "settlement_pending"`（Solana。署名つきでも） | **502** `{ error: "settlement_pending" }`（追跡はしない。範囲外） | `unknown` |
| 200、`success: false`、他の `errorReason` | **502** `{ error: "settle_failed" }` | `unknown` |
| 200 だが `transaction`／`network`／`payer` の形が違う | **502** `{ error: "receipt_malformed" }`（成功を名乗らない） | `unknown` |
| 403 `registration_required`（Circle の trial 切れ。`/verify` でも `/settle` でも） | **502** `{ error: "facilitator_registration_required" }`。運用者向けに同じ固定文を `console.error`（値無し） | `unknown`（verify で起きたときも 5xx = `unknown` に揃える。Router は `unknown` を保ち、買い直さない。運用者が登録してから新しい購入を始める） |
| 4xx・5xx・不達・期限・JSON でない | **502** `{ error: "facilitator_unavailable" }` | `unknown` |

- **応答の本文もヘッダも固定文だけ**（facilitator の文言・例外の文字列・鍵・URL を含めない）。SDK の `processHTTPRequest` は例外の文言を 402 に入れるので、支払いつきの経路では使わない（§3.1）。
- 1 要求で facilitator の settle は最大 1 回。Provider は再試行しない。Router 側は `unknown` を**そのまま保つ**（自動で買い直さない・新しい authorization を作らない: 送信の設計 §5）。同じ authorization をそのまま再送されても facilitator が nonce で拒む（これは同じ署名の再生の防御であって、新しい署名による二重払いの防御ではない。二重払いを防ぐのは Router の「`unknown` は再送しない」規則）。

### 2.3 本文（支払い後）— 記録済みの Provider A の契約の、`payment.network` だけの拡張

`docs/t5-design.md` §1.5・`tests/fixtures/market-snapshot-server.ts` の形を**過不足なく**。記録済みの契約は `payment.network` を `eip155:84532` と書いているので、Arc／Solana の値は**契約の拡張**になる。拡張の受け入れは chat（契約の持ち主）の確認を gate にする（§7。確認が取れるまで chat からの利用は主張しない。Router の配達には影響しない）。

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

- 数値は文字列 `/^-?\d+(?:\.\d+)?$/`（指数表記・`+`・空白・`.5`・`5.` 不可）。**`markPx`・`prevDayPx` は正**（`-` で始まらず `1`〜`9` を含む）、**`dayNtlVlm` は非負**、**`assetIndex` は非負の安全な整数**（JSON number）。鍵の集合は上と完全一致（余剰の鍵を 1 つも足さない）。これらは**settle の前**（段 1）に検査し、満たさなければ 502 で支払いを受けない。
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
- Solana の受取 owner の鍵は **owner の管理**。`providers/x402-workers/scripts/keygen-solana.mjs` が乱数の seed を **owner が指定した file にだけ**（mode 0600、既存なら上書きしない）書き、標準出力には**公開鍵だけ**を出す（`wallet:new:solana` や `echo` のように鍵を端末に出さない）。Provider に渡すのは公開鍵だけ。
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
    receipt.ts         settle の応答の検査（§2.2 の表。`payer` の同一性は支払い側の `from`／authority と）と `PAYMENT-RESPONSE` の作成
    deadline.ts        要求ごとの 1 つの期限（残りの計算、各段の期限 = min(段の上限, 残り)、settle の前の最小残り 12 秒）
  test/                vitest（Node で: 純粋関数と、fetch を差し替えた handler。facilitator と Hyperliquid は差し替え）
```

fetch handler の順序（§2.2）: `GET /v1/eth/snapshot` 以外は 404。`PAYMENT-SIGNATURE` が無ければ 402（SDK で requirements を組み、`encodePaymentRequiredHeader`）。あれば `decodePaymentSignatureHeader` → `accepted` の完全一致（`stableJson`）→ データ → verify（自前の client）→ settle（自前の client、1 回）→ 領収の検査 → 200。**SDK の `processHTTPRequest`・`settlePayment`・`processSettlement` は使わない**（例外の文言の透過と settle の再試行を避ける）。SDK を使うのは requirements の作成・402 の封筒・`PAYMENT-RESPONSE` の符号化だけ。

### 3.2 自前の facilitator client

- 1 つのクラスを両方で使う。`verify`／`settle` は `JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements })` を **1 度だけ**作り、Circle のときはその文字列の keccak256 を `bodyHash` にして `SellerRequest` に署名し `Facilitator-Seller-Proof` を付ける。同じ文字列を body に送る。
- `redirect: "manual"`（Workers の fetch に `error` は無い。3xx は状態コードの検査で失敗になる = 追わない）、期限 verify **4 秒**・settle **min(20 秒, 要求の残り)**・supported **5 秒**。応答の本文は 64 KiB まで。HTTP の状態と本文の形を見て §2.2 の表に写す。facilitator の文言は client の外に出さない（固定の分類だけ）。
- **settle の guard**: 要求ごとの client の object が `settle` の呼び出しを数え、2 度目は throw（試験で確かめる。SDK を通さないので再試行は起きないが、二重の防御）。
- `getSupported` は GET（上限 **5 秒**）。SDK の `x402ResourceServer` に渡すのはこの client（`initialize()` が `/supported` を読む）。isolate ごとに 1 度 `initialize()`（要求ごとの期限の内側で。失敗したら次の要求でやり直す。402 を出せない間は 503 固定文、支払いは受けない）。

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
| unit（Worker） | config（network の表、payTo の形、鍵の形、鍵 → address の一致、Solana に鍵があれば拒む、例外の文言に値が無い）、seller-proof の往復（Router の fixture と同じ検証: 復号 → recover → payTo 一致 → bodyHash 一致 → 寿命）、snapshot の封筒（§2.3 の鍵の集合・数値の形・正負の制約。Hyperliquid の形違い → 失敗）、receipt の検査（表の各行。`payer` が `from`／authority と違えば `receipt_malformed`）、deadline（残りの計算、settle 前の最小残り） |
| handler（Node で fetch を差し替え） | 402 の形（§2.1 と byte 一致の `accepts`、トップレベルの鍵）、支払いつき: `accepted` 不一致 → 402、データ不達 → 502 で facilitator 0 回、verify 不正 → 402、verify 不達・403 registration_required → 502、settle の各行 → 502 と settle 1 回、`payer` 違い → 502、成功 → 200 と `PAYMENT-RESPONSE`（SDK の decoder で読める）、cold start で `/supported` が遅い・落ちる → 503 で支払いを受けない、残りが 12 秒未満で settle を呼ばず 503、**応答のヘッダと本文に facilitator の文言・鍵・URL が無い** |
| Router の既存の試験 | §3.5 の変更の wire 試験。`x402-arc-outbound`・`x402-svm-outbound` の fixture の accepts を §2.1 と同じ値にして候補になることを確認 |
| 結合（手元、AC-P2） | `wrangler dev` に Router の fixture の facilitator を向け、Router の wire 試験の harness から購入 → `delivered`。settle の pending／4xx／不達の各行 → Router が `unknown`、fixture の settle の計数 1 |

## 5. 配備（owner の作業を含む）

1. Router 側の P-0 を merge。
2. owner: `wrangler login`（この機械には認証が無い。私は認証情報を扱わない）。Cloudflare の DNS に 2 つのサブドメインを Worker の custom domain として追加。
3. 鍵: Arc は `scripts/keygen.mjs`（§2.4。address だけが出る。`--env arc` の secret に直接）。`PAY_TO` にその address を `wrangler.toml` の `[env.arc.vars]` に書く。Solana は owner が `scripts/keygen-solana.mjs <file>` で作り（file にだけ。公開鍵だけが出る）、公開鍵を `[env.sol.vars]` の `PAY_TO` に。
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
| 2 | 2026-10-08 | `gpt-6-astra`（readback。第 2 版） | **REJECT**（解決: 再試行、V-13。残り: `payer` の同一性と本文の受領、契約は拡張であること・数値の制約、cold start を含む 1 つの期限、Solana の seed の出力、`unknown` の後の文言）。第 3 版で反映 |
| 3 | 2026-10-08 | `gpt-6-astra`（readback。第 3 版 `cbe704c`） | **APPROVE WITH CHANGES**（文言 3 点: verify の失敗・403 の行に残っていた「新しい購入で再試行できる」の根拠を削除、`delivered` は本文まで受け取れたときと明記、署名と本文の読み書きも期限の内側と明記）。同じ版で反映（小さな訂正なので再レビューはしない） |

## 9. 実装と AC-P2 の記録（2026-10-08）

- 実装: `providers/x402-workers/`（PR #86。独立レビュー `gpt-6-astra`: REJECT（7 点）→ readback REJECT（3 点が部分的）→ readback APPROVE WITH CHANGES（3 点）→ 範囲を絞った readback APPROVE。unit と handler の試験 33、変異 27 を全部検出）。
- AC-P2 の試験: `tests/acceptance/provider-x402-workers.test.ts`（**`PROVIDER_WORKER_AC=1` のときだけ**走る。`providers/x402-workers/node_modules` の wrangler が要るので、Linux の suite では skip）。
  本物の Worker を `wrangler dev --env arc` / `--env sol`（workerd）で起動し、Router の fixture の facilitator（`circle-facilitator`・`svm-facilitator`）に向け、Router 自身の送信 adapter（Arc: `createX402Outbound` の組み直しの署名器、Solana: `createX402SvmOutbound` + RPC の fixture）で買う。Worker（平文 http）と TLS の fixture の間は試験が立てる loopback の proxy（Worker → facilitator は http→TLS、Router → Worker は `arc.provider.test` / `sol.provider.test` の TLS front）。Arc の売り手鍵は試験が乱数で作り、0600 の一時ファイル（`--env-file`）で渡して消す。
  実行: `PROVIDER_WORKER_AC=1 npx vitest run tests/acceptance/provider-x402-workers.test.ts`
  外に出ない根拠: Router の dial は表に無いホストを拒む fixture、proxy と front は 127.0.0.1 へだけ接続、wrangler の telemetry・error report・banner（通常の経路の npm の更新確認）は env で止め、警告・エラーの経路に残る更新確認のために npm の registry を閉じた loopback のポートに向ける（`npm_registry`: wrangler の update-check は `rc("npm")` で読み、`rc` は接頭辞 `npm_` を外した名前を鍵にするので `npm_config_registry` では効かない）。試験は生の log に banner・更新の案内が無いことも見る。
- 結果（macOS、wrangler 4.148.0、workerd）: **7 件 pass**。Arc: 402 が Router の候補を通り、購入は `paid`（契約の本文を入れ子まで検査、facilitator の verify 1・settle 1、売り手証明の失敗 0、領収の `payer` = Router の署名者、Worker の 200 の wire は `content-type`・`no-store`・`PAYMENT-RESPONSE` つき）。settle の表の 9 行（pending・失敗・403・500・形違い・切断・network 違い・別 payer・64 KiB 超の chunked）→ **Worker は 502 の固定の本文で領収なし**、Router は `unknown`、settle は各 1 回。facilitator が 25 秒黙る → Worker は 20 秒で 502（settle 1 回）。verify が不正 → Worker 402（固定の本文）→ Router `rejected`（settle 0）。Solana: `/supported` の feePayer で 402（読取 1 回）、購入は `paid`、confirm の timeout（pending）・切断・409 → Worker 502・Router `unknown`、settle は各 1 回。Worker の生の log に鍵・facilitator の文言・wrangler の banner（更新確認）は無い。
- **workerd で初めて分かったこと（Node の試験では出ない。実装に反映済み）**:
  1. entry module（`src/index.ts`）の export に handler と関数以外の値があると workerd が起動しない（定数は `config.ts` へ）。
  2. global の `fetch` を instance に持たせて `this.#fetch(...)` と呼ぶと `Illegal invocation`（`this` を付けずに呼ぶ）。
  3. Workers の fetch に `redirect: "error"` は無い（`manual` にし、3xx は状態コードで失敗）。
  4. Router は 402 の `resource.url` を canonical URL と**完全一致**で束縛する。Worker は `request.url` の origin から組むので、手元の `wrangler dev` では `--local-upstream <公開ホスト> --upstream-protocol https` が要る（本番は custom domain で `https://provider-x402-<arc|sol>.subethalabs.com` になる。Router は設定した canonical URL と違う `resource.url` を拒むので、`workers.dev` の host で開いた 402 は **設定が custom domain のときは**候補にならない。`workers.dev` そのものを Router が禁じているのではなく、設定した URL と一致しないだけ）。
  5. `wrangler dev` の proxy は、client が `accept-encoding` を送ると本文を圧縮して `transfer-encoding: chunked` で中継し、Worker が付けた `content-length` は wire から消える。`accept-encoding` 無しなら Worker の `content-length`（395 バイト）がそのまま wire に出る。Router は本文を上限つきで読むので、どちらでも依存しない。試験は Worker への hop で `accept-encoding` を渡さない（圧縮された応答の経路はこの試験の範囲外。本番の edge の圧縮の挙動は AC-P3/AC-P4 で見る）。
  6. **Router 側の不整合（AC-P2 の期限の行で判明。Router の follow-up が UG-A の前に要る）**: §1 の「Router の送信（x402）の有料要求の期限は 30 秒」は動的経路（`x402-dynamic.ts` の `paidTimeoutMs`）と Solana（`x402-svm.ts`）には正しいが、**静的 EVM 経路**（`createX402Outbound`、Base と Arc の静的 route）は `timeoutMs` 1 つ（既定 **5 秒**）を 402 の読取にも有料要求にも使う（`src/adapters/outbound/x402.ts`）。本番の合成（`src/main.ts`）は値を渡さない。Worker の warm の経路は data 2 + verify 4 + settle ≤ 20 秒なので、Circle の settle が 5 秒を超えると Router は `unknown` を記録し、Worker はそのまま settle を続ける（資金が動きうる。期限は settle の成否を決めない）。試験はこの挙動をそのまま記録している（Router 5 秒で `unknown`、Worker 20 秒で 502、settle 1 回）。推奨: 静的 EVM 経路に `paidTimeoutMs`（既定 30 秒、402 の読取は 5 秒のまま）を足して動的・Solana と揃える（Router の小さな PR。owner の判断）。**→ owner 承認（2026-10-08）、`createX402Outbound` に `paidTimeoutMs`（既定 `X402_STATIC_PAID_TIMEOUT_MS` = 30 秒）を足して解決。** 本番の合成は既定を使う。
- fixture の変更: `tests/fixtures/circle-facilitator.ts` の領収の `payer` を payload の `authorization.from`（本物の Circle と同じ）にし、`wrong-payer`（形は正しいが署名者と違う payer）の行を足した（受信の試験は値を見ない）。
