# Arc・Solana の Provider（`subetha-provider-x402` の Arc 版・Solana 版）— 要件と設計（第 1 版）

owner の決定（2026-10-08）: 既存の Provider と同じ **Cloudflare Workers** に揃える。新しい鍵は Router 側（この worktree の作業者）が作る。
公開名は `provider-x402-arc.subethalabs.com`（Arc）・`provider-x402-sol.subethalabs.com`（Solana）。
送信レールの要件 D-10（`docs/multirail-outbound-requirements.md`）で「owner が `subetha-provider-x402` を Arc と Solana に配備する」と決めた分の実体。

## 0. 範囲と置き場

- 作るのは **x402 v2 の `exact` を受け取る HTTP の資源サーバ**を 2 つ（Arc testnet USDC、Solana devnet USDC）。1 つの Worker のソースを env（`PROVIDER_NETWORK = arc | solana`）で切り替え、2 つの Worker として配備する。
- 置き場は **この Router リポジトリの `providers/x402-workers/`**（独立した `package.json`・`wrangler.toml`。Router の `src/` は import しない。Circle の売り手証明だけ `src/adapters/inbound/seller-proof.ts` の純粋な部分を**写して**使う（§3.2）。Router の build・試験には影響しない）。
  既存の Provider のソースは手元に無い（Cloudflare にだけある）ので、**同じ 402 の形**（§2.1）に合わせる。
- 資源は 1 本: `GET /v1/eth/snapshot`。支払い後の本文は既存の Provider と同じ封筒（§2.3）。クエリは受けない。
- 範囲外: Base／Tempo の既存 Provider の変更、MPP の Provider、同一チェーンの組（Router の D-16）、Bazaar、動的価格。

## 1. 外部の事実（2026-10-08 に確認）

| 事実 | 出典 |
|---|---|
| Circle の facilitator `https://api.circle.com/v1/facilitator/x402` は `eip155:5042002` の USDC `0x3600…`（6 桁、domain USDC/2）の `exact` v2 を提供する。x402.org の facilitator は Arc を提供しない | `/supported` の応答 |
| Circle は売り手に `Facilitator-Seller-Proof`（EIP-712 `SellerRequest`、受取鍵で署名、**要求本文の keccak256 を含む**）を要求する。API key は使わない。要求の形は `{ x402Version, paymentPayload, paymentRequirements }`。trial が尽きると `403 registration_required` | Router の受信 adapter（`src/adapters/inbound/x402.ts` kind `circle`、`seller-proof.ts`）、`docs/multirail-design.md` §3・§6 |
| Circle の受取は requirements の `extra` に `assetTransferMethod: "eip3009"` を要求する | Router の受信 adapter（`CIRCLE_ISSUED_EXTRA_KEYS`） |
| x402.org の facilitator は `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`（devnet）の `exact` v2 を提供し、`extra.feePayer` を名乗る。fee payer（手数料）は facilitator | `/supported` の応答、Router の受信 adapter |
| SVM の `exact` は `payTo` を **owner** として扱い、宛先 ATA は `findAssociatedTokenPda(mint, owner)` で導く。**ATA は事前に作る**（rent は運用者） | `docs/multirail-outbound-requirements.md` V-7、SDK |
| x402 SDK `@x402/core` 2.28.0 の `x402ResourceServer`／`x402HTTPResourceServer` は Node の module を使わず Workers で動く。`HTTPFacilitatorClient` の `createAuthHeaders` は**本文を受け取らない**ので、Circle の売り手証明には使えない | `node_modules/@x402/core`（`grep "node:"` が空）、`createAuthHeaders(path)` の実装 |
| データ源: Hyperliquid の公開 `POST https://api.hyperliquid.xyz/info` `{"type":"metaAndAssetCtxs"}` に ETH の `markPx`・`prevDayPx`・`funding` がある（鍵不要）。既存の Provider の 402 の説明は「ETH perpetual snapshot (Hyperliquid mark price, 24h change)」 | 実測、既存 Provider の `PAYMENT-REQUIRED` |
| wrangler はこの機械に未インストールで、Cloudflare の認証も無い | `which wrangler`、`~/.wrangler` |

## 2. 要件

### 2.1 402（未払いの GET）

- `PAYMENT-REQUIRED` ヘッダ（base64 JSON、x402 v2）。`accepts` は **1 件**:
  - Arc: `{ scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "10000", payTo: <Arc の受取 address>, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }`
  - Solana: `{ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "10000", payTo: <受取 owner の公開鍵>, maxTimeoutSeconds: 60, extra: { feePayer: <facilitator の feePayer> } }`。**Memo は出さない**（Router が `subetha:<paymentId>` を付ける。付けるなら固定値ではなく要求ごとに新しい値でなければならない: Router は同じ message に二度署名しない）
- `resource.url` は要求された canonical URL（`https://<host>/v1/eth/snapshot`）、`description`・`mimeType: application/json`。トップレベルに `accepts`・`resource`・`x402Version: 2`・`error` 以外は載せない（Router は未知のトップレベルを捨てる。`extra` の未知の鍵は候補外にするので上の集合以外を足さない）。
- 本文は `{"x402Version":2}` 程度の小さな JSON、`cache-control: no-store`。
- 額は既存と同じ **10000**（0.01 USDC）。Router の静的 route の `destination.quoted`・動的の `maxUpstreamAmount` 10000 と整合する。

### 2.2 支払いつきの GET（`PAYMENT-SIGNATURE`）

1. ヘッダを decode し、SDK（`x402HTTPResourceServer.processHTTPRequest`）に検証させる: `accepted` が自分の requirements と一致、facilitator `/verify` が `isValid`。
2. `/settle` を呼び、`success` なら **200** と `PAYMENT-RESPONSE`（`{ success: true, transaction, network, payer }`。SDK の `createSettlementHeaders`）と本文（§2.3）。
3. verify が落ちれば **402**（`PAYMENT-REQUIRED` を付け直す）。settle が落ちれば **402**（本文に `errorReason`。資金は動いていない）。facilitator に届かない・期限（verify 10 秒、settle 40 秒）は **502** で本文に固定の `error`（上流に秘密を含めない）。
4. **1 要求 1 settle**。再送・再試行はしない（Router 側が `unknown` として扱う契約と対になる）。
5. Arc: facilitator は Circle。要求ごとに売り手証明（§3.2）。Solana: facilitator は x402.org。証明は無い。

### 2.3 本文（支払い後）

既存の Provider と同じ封筒: `{ providerId, market, dataSource, payment, fetchedAt, data }`。
- `providerId`: `market-data-arc`／`market-data-sol`、`market`: `ETH-PERP`、`dataSource`: `hyperliquid:metaAndAssetCtxs`、`payment`: `{ scheme: "exact", network, asset, amount, transaction }`、`fetchedAt`: UTC の ISO 文字列（`Z`）、
  `data`: `{ markPx, prevDayPx, change24hPct, funding, disclaimer }`（`disclaimer`: 「Hyperliquid の mark price の参照値。取引できる気配ではない」）。
- Hyperliquid が落ちていれば **502**（settle の前に取る: §3.1 の順序）。
- 256 KiB 未満・`application/json`（Router の受け取りの上限）。

### 2.4 鍵と env（Workers の secret）

| secret / var | Arc | Solana |
|---|---|---|
| `PROVIDER_NETWORK` (var) | `arc` | `solana` |
| `PAY_TO` (var) | 受取 address（売り手証明の鍵の address と一致） | 受取 owner の公開鍵（base58） |
| `SELLER_PROOF_KEY` (secret) | 受取鍵（`0x` 32 バイト。**Router の受取鍵 `SUBETHA_ARC_RECEIVER_KEY` とは別の新しい鍵**: Router は自分の受取先宛ての offer を候補外にする） | — |
| `FACILITATOR_URL` (var) | `https://api.circle.com/v1/facilitator/x402` | `https://www.x402.org/facilitator` |

- 鍵は Workers の secret にだけ置く（`wrangler secret put`）。**ログに出さない**。Solana の受取鍵は Provider には要らない（受け取るだけ。使うときは owner の `wallet:new:solana` の鍵）。
- Solana: 受取 owner の **USDC の ATA を配備前に作る**（rent は運用者）。Provider は起動時に確かめられない（Workers は起動時の検査を持たない）ので、配備の手順（§5）で `getAccountInfo` を見る。

### 2.5 受け入れ条件

- AC-P1: 402 の `accepts` が §2.1 のとおりで、Router の候補検査（Arc: `checkDynamicX402Offer` に §4 の変更を入れたもの、Solana: `checkSvmOffer`）を通る（Router の既存の fixture・試験で確認）。
- AC-P2: Router の fixture の facilitator（`tests/fixtures/circle-facilitator.ts`・`svm-facilitator.ts`）に向けた Worker（`wrangler dev`）で、Router の送信 adapter の wire 試験と同じ購入が `delivered` になる。
- AC-P3: 実 facilitator への probe は owner の承認のもとで（Arc: Circle の trial の消費、Solana: V-8b と同じく資金が動く）。
- AC-P4: 配備後、Router の UG-A／UG-S の V-6・V-7・V-12・V-13 の記録（402 を 2 回取り、`extra` の鍵と要求ごとの変化、宛先 ATA の存在）。

## 3. 設計

### 3.1 構造（1 つの Worker）

```
providers/x402-workers/
  package.json   (@x402/core, @x402/evm, @x402/svm, viem, @solana/kit ※svm の server scheme の依存, wrangler, vitest)
  wrangler.toml  (name は配備時に 2 つ: provider-x402-arc / provider-x402-sol。compatibility_flags = ["nodejs_compat"])
  src/
    index.ts           fetch handler: ルート → 402 or 支払い処理 → 本文
    config.ts          env の検査（network ごとの固定値の表。payTo の形、鍵の形）
    circle-client.ts   FacilitatorClient 実装（verify/settle/getSupported。本文を 1 度だけ直列化し、売り手証明を付ける）
    seller-proof.ts    Router の seller-proof.ts の純粋部分の写し（randomNonce は crypto.getRandomValues、署名は viem の privateKeyToAccount）
    snapshot.ts        Hyperliquid の取得と封筒
  test/                vitest（Workers の実行環境ではなく Node で: 純粋関数と、fetch を差し替えた handler）
```

処理の順序（支払いつきの GET）: ヘッダの decode → **Hyperliquid を先に取る**（データが取れないなら 502 で支払いを受けない: 「払ったのにデータが無い」を作らない）→ verify → settle → 200。settle の後に本文の組み立てで失敗しない（取得済みの値を返すだけ）。

### 3.2 Circle の facilitator client

- `verify`／`settle` は `JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements })` を **1 度だけ**作り、その文字列の keccak256 を `bodyHash` にして `SellerRequest` に署名し、同じ文字列を body に送る（Router と同じ束縛）。`getSupported` は GET（証明の `method` は `POST` だけなので付けない。Circle は `/supported` に証明を要らない: 上の `/supported` は無認証で読めた）。
- `SellerRequest` の型・domain（`Circle Facilitator Seller Request` / `1` / chainId 5042002）・寿命 60 秒・nonce 32 バイト・封筒（base64url JSON）は Router と同じ。鍵は `SELLER_PROOF_KEY` から viem の account を作り、`signTypedData` だけを closure に閉じる。
- `redirect: "error"`、期限 verify 10 秒・settle 40 秒（Circle の窓 30 秒 + 10）。応答の本文は 64 KiB まで。

### 3.3 Solana

- SDK の `registerExactSvmScheme(server, { networks: [SOL] })` と `HTTPFacilitatorClient({ url: x402.org })`。`feePayer` は SDK が `/supported` から `extra` に入れる（`initialize()` で取る。Workers では**要求ごとに** `initialize()` を呼ぶか、isolate ごとに 1 度。後者）。
- `payTo` は owner。Memo を requirements に入れない。

### 3.4 Router 側の変更（別 PR。この設計の P-0）

- `src/adapters/outbound/x402-dynamic.ts` `checkDynamicX402Offer`: `extra.assetTransferMethod` を **値が `"eip3009"` のときだけ**許す（他の値・他の未知の鍵は今までどおり候補外）。組み直しの署名器は `extra` を読まないので署名の内容は変わらない。`tests/wire/x402-arc-outbound.test.ts` の「V-6 の結果まで候補にしない」を「`eip3009` は候補、`permit2` は候補外」に。
- 静的 route（`x402.ts`）は `extra` の鍵を見ない（変更なし）。SVM（`checkSvmOffer`）は `assetTransferMethod` を今までどおり拒む（Solana の Provider は出さない）。

## 4. 試験

| 層 | 内容 |
|---|---|
| unit（Worker） | config の検査（network の表、payTo の形、鍵の形、秘密の露出なし）、seller-proof の往復（Router の fixture と同じ検証: 復号 → recover → payTo 一致 → bodyHash 一致 → 寿命）、snapshot の封筒（Hyperliquid の応答の形違い → 502） |
| handler（Node で fetch を差し替え） | 402 の形（§2.1 と byte 一致の `accepts`）、支払いつき: verify 落ち → 402、settle 落ち → 402、facilitator 不達 → 502、データ不達 → 502 で facilitator を呼ばない、成功 → 200 と `PAYMENT-RESPONSE`、settle は 1 回 |
| Router の既存の試験 | §3.4 の変更の wire 試験。Router の Arc／SVM の送信 adapter が §2.1 の offer を候補にすること（`x402-arc-outbound`・`x402-svm-outbound` の fixture の accepts を §2.1 と同じ形にして確認） |
| 結合（手元） | `wrangler dev`（ローカル）に Router の fixture の facilitator を向け、Router の wire 試験の harness から購入 → delivered（AC-P2） |

## 5. 配備（owner の作業を含む）

1. Router 側の P-0 を merge。
2. 鍵: Arc の受取鍵を 1 本作る（`npm run wallet:new` 相当。ホストの env と同じく、値は secret にだけ）。Solana の受取 owner は `npm run wallet:new:solana` で 1 本（公開鍵が `PAY_TO`）。**owner が ATA を作る**（`spl-token create-account 4zMMC9… --owner <公開鍵>`、devnet）。
3. owner が `wrangler login`（この機械には認証が無い。私は認証情報を扱わない）。`wrangler deploy --name provider-x402-arc`／`--name provider-x402-sol`、`wrangler secret put SELLER_PROOF_KEY`（Arc）。Cloudflare の DNS に 2 つのサブドメインを Worker の custom domain として追加。
4. 配備後の確認（私）: 402 を 2 回取り記録（V-6・V-7・V-12）、Solana の宛先 ATA を `getAccountInfo` で確認（V-13）。
5. Router の UG-A／UG-S: `UPSTREAM_ARC`／`UPSTREAM_SOL` と受取先の env を入れる PR → G-2′ → G-3′（受け入れの購入。資金が動く。owner の承認） → G-4′。

## 6. 決めていないこと

- Circle の trial の残量と、尽きたときの登録（owner）。
- 本番の Provider の価格を 10000 のままにするか（Router の区分・上限と整合しているので据え置きを推奨）。
