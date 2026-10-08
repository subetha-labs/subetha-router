# Provider D（Solana devnet USDC を **MPP** で受ける資源サーバ。Cloudflare Workers）— 要件・設計・試験・配備

> MPP Solana の送信（`docs/mpp-solana-design.md` §4、`docs/mpp-solana-tasks.md` MG の G-1″）の相手。要件 D-26「owner が pay-kit の server を devnet で」の置き場を
> **Cloudflare Workers**（Arc／Solana の x402 Provider と同じ `providers/` の 1 Worker。`docs/provider-x402-workers.md` の方式）にする案。U-14（Workers で動くか）はこの文書の
> AC-PD2（workerd での結合試験）で確かめる。確かめられなければ Node の http（`tests/fixtures/mpp-solana-upstream.ts` の本物化）に落とす（§6）。
> 先行の Provider と同じく、**作るのは私、鍵・資金・配備は owner**（私は Cloudflare の認証情報を扱わない）。

## 0. 範囲と置き場

- 作るのは **MPP の `solana/charge`（pull）を受け取る HTTP の資源サーバ** 1 つ（Solana devnet USDC、受取は owner の ATA、送出は Provider の fee payer）。
  `@solana/pay-kit` 0.13.1 の server（Router の fixture と同じ版・同じ API）を Cloudflare Workers で動かす。
- 置き場は **`providers/mpp-solana-workers/`**（独立した `package.json`・`wrangler.toml`。Router の `src/` は import しない。`providers/x402-workers/` の `snapshot.ts`・`deadline.ts` の純粋な部分は**写して**使う）。
- 資源は 1 本: `GET /v1/eth/snapshot`。クエリは受けない。名前は `provider-mpp-sol`、custom domain は **`provider-mpp-sol.subethalabs.com`**（owner の DNS）。
- 範囲外: push（`signature` 型。D-23 の第 2 段）、`splits`、x402 の受け付け、HTML の 402、複数 replica で共有する replay store（§3.4 に限界を書く）、同一チェーンの組（Router の D-16）。

## 1. 外部の事実（2026-10-08 に確認）

| 事実 | 根拠 |
|---|---|
| pay-kit 0.13.1 の server は `createPayKit({ network: "devnet", rpcUrl, accept: ["mpp"], operator: { signer, feePayer: true, recipient }, mpp: { challengeBindingSecret, realm, expiresIn } })` と `Gate.create({ amount: usd("0.01"), name, externalId?, description? }, { accept: ["mpp"], payTo })`、`pay.fetch(gate, handler)` で動く。Router の fixture（`tests/fixtures/mpp-solana-upstream.ts`）がこの API で本物の server を立て、Router の送信 adapter の wire 試験 30 本が通っている | `node_modules/@solana/pay-kit/dist/index.d.ts`、M4-b・M5 の試験 |
| pay-kit の server の 402 は `WWW-Authenticate: Payment id=… realm=… method="solana" intent="charge" request="<base64url>"`、`request = { amount, currency, recipient, externalId?, description?, methodDetails: { network: "devnet", decimals: 6, tokenProgram, feePayer: true, feePayerKey } }`。`opaque`（route scope）は無い。`expires` は `expiresIn`（既定 **120 秒**。この Worker は 300 を明示する） | fixture の wire、`docs/mpp-solana-design.md` §13（scope は任意） |
| 支払いつきの要求で pay-kit がすること（`transaction` 型、pull）: credential の HMAC・期限の検証 → transaction の構造の検証 → **fee payer として共同署名** → `sendTransaction` → `getSignatureStatuses` を **最長 30 秒**（`waitForConfirmation`）→ `getTransaction`（jsonParsed）で内容の照合（受取先・額・mint）→ `Payment-Receipt`（`method: "solana"`, `challengeId`, `reference` = 署名, `status: "success"`, `timestamp`。**`payer` は無い**）を付けて handler の応答を返す。失敗（検証・simulate・送出の error・確定待ちの timeout・RPC の不達を含む mppx の例外）は mppx の `InvalidProofError` → **402**（新しい challenge つき。領収なし）。RPC は素の `fetch`で 4 method: **`simulateTransaction`（送出の前。`preflight: false` でも呼ぶ）**・`sendTransaction`・`getSignatureStatuses`・`getTransaction`。replay は `replayStore`（既定は **isolate 内のメモリ**。予約 → 確定の 2 段で、別の process とは共有しない） | `dist/index.js`（`waitForConfirmation` 3e4、`verifyOnChain`、`verifyAndSettle`、`:772-803` の replay） |
| pay-kit の `detect` は `authorization.toLowerCase().startsWith("payment ")`（大文字小文字を区別しない）。challenge の期限 `expiresIn` の既定は **120 秒** | `dist/index.js:8193`、`:7752` |
| mppx の server は検証の例外を `console` に書く（任意の例外の文言。RPC の URL を含み得る）。Workers の log は owner の dashboard・`wrangler tail` にだけ出る | `node_modules/@solana/pay-kit/node_modules/mppx/dist/server/Mppx.js:851-853` |
| Router の送信 adapter（`createMppSolanaOutbound`）が Provider に求めるもの: 402 の候補の検査（設計 §4.2 の 9 行: `feePayer === true` ∧ `feePayerKey` が運用者の集合・受取先・mint・program 等のどれでもない、`currency` = 表の mint、`network === "devnet"`、`decimals === 6`、`externalId` があれば Memo として有効、`expires` は未来）、有料要求の期限 **45 秒**（`MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS`）、領収の `challengeId` が challenge の id と一致（必須）、`reference` の tx を `getTransaction` で読み直し message が予約した snapshot と byte 一致・[1] が Router の署名・`meta.err === null`、本文は `application/json` の object ≤ 256 KiB | `src/adapters/outbound/mpp-solana.ts`、設計 §4.2〜§4.4 |
| pay-kit の dist は `node:` の module を import しない（`@solana/kit`・`mppx`・`@solana-program/*`・`buffer`・`@solana/keychain-memory` だけ）。`process.env` は設定の既定の解決にだけ読む（明示した値が優先）。署名は WebCrypto の Ed25519（Workers は対応） | `grep` の結果、`dist/index.js:7713,7754` |
| 先行の Worker（x402）で workerd について分かったこと: entry の export は handler と関数だけ、`fetch` は `this` を付けずに呼ぶ、`redirect: "error"` は無い、`resource.url` は公開 origin が要る（`--local-upstream`）、`wrangler dev` の proxy は `accept-encoding` があると圧縮する | `docs/provider-x402-workers.md` §9 |
| wrangler はこの機械に未インストール（`providers/x402-workers/node_modules/.bin/wrangler` は devDependency として入っている）。Cloudflare の認証は owner の端末にだけ | `which wrangler`、§5 |

## 2. 要件

### 2.1 402（未払いの GET）

- pay-kit の server がそのまま出す `WWW-Authenticate`（上の形。`realm` は **`subetha-provider-mpp-sol`**、`id` は HMAC、`expires` は **`expiresIn: 300` を明示**（既定は 120 秒）。Router の静的 route の承認期限 600 秒より短いが、Router は purchase 時に 402 を読み直して SDK が選んだ challenge で払うので、quote 時の challenge の期限は承認値に入らない（設計 §4.2 の `terms` に `id`・`expires` は無い））。本文は pay-kit の既定（JSON）。`cache-control: no-store` を足す。
- `request`: `amount: "10000"`（`usd("0.01")`）、`currency` = devnet USDC の mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`、`recipient` = owner の受取 owner（`PAY_TO`）、`description: "ETH perpetual snapshot (Hyperliquid mark price, 24h change)"`、**`externalId` は出さない**（§6 の決定 2 のとおり。Router は無くても払う。出すなら固定文になり、購入ごとの束縛にならない）、`methodDetails: { network: "devnet", decimals: 6, tokenProgram: Tokenkeg…, feePayer: true, feePayerKey: <Worker の fee payer の公開鍵> }`。
- Router の候補の検査（§1）を通ること。特に `feePayerKey` と `recipient` は **Router の運用者の address の全部**（Base・Arc・Solana の受取先、送信の署名者、それらの ATA）と違うこと（新しい鍵なので違う。配備の手順で一覧と突き合わせる）。
- `GET /v1/eth/snapshot` 以外は 404（固定文）。クエリつき・`HEAD`・`POST` も 404。

### 2.2 支払いつきの GET（`Authorization: Payment …`）と結果の表

**pay-kit に credential を渡す前に本文を用意する**（「払ったのにデータが無い」を作らない。先行の Worker の段 1 と同じ）。pay-kit の検証・送出・確定待ち・照合は pay-kit に任せる（自前で再実装しない: 送出の後に Worker が期限で切ると資金だけ動くので、**送出の後の段には Worker の期限を掛けない**）。

| 段 | 内容 | 期限 | 失敗したときの応答 |
|---|---|---|---|
| 0 | パスと method。`Authorization` を **pay-kit と同じ判定**（小文字化して `payment ` で始まるか）で見る。支払いつきなら段 1 へ。そうでなければ **`Authorization` を外した要求**を pay-kit に渡して 402 を得る（pay-kit が settle に進める経路を未払いの枝に残さない） | — | 404 固定文 |
| 1 | データを取る（Hyperliquid。先行の `snapshot.ts` の写し）。形の検証と大きさ（64 KiB）までここで終える | 2 秒 | **502** `{ error: "data_unavailable" }`。pay-kit は呼ばない（資金は動かない） |
| 2 | `pay.fetch(gate, () => 200 + 本文)`: pay-kit が credential を検証し、simulate し、共同署名して送出し、確定（最長 30 秒）を待ち、`getTransaction` で照合して `Payment-Receipt` を付ける | pay-kit の内部（30 秒 + RPC の往復）。Worker は切らない | pay-kit の 402（領収なし。新しい challenge つき。検証の失敗も RPC の不達も確定待ちの timeout もここ）→ Worker は状態 402 と `WWW-Authenticate` を保ち、**本文を `{}` に置き換え、`content-length` を付け直し、`cache-control: no-store`**（mppx の文言を透過しない）。pay-kit から例外が escape したとき（想定外）→ **502** `{ error: "payment_failed" }`（領収なし。同じく固定文・`no-store`） |
| 3 | 200 + `Payment-Receipt`（**pay-kit の値をそのまま**。`payer` 等を足さない: Router は `payer` があれば自分の鍵と比べ、fee payer の鍵が入っていれば `unknown` になる）+ 本文（段 1 の値。`content-type: application/json`、`content-length`、`cache-control: no-store`） | — | 本文の送出で切れれば Router は `paid_no_data`（防げない。Router は再送しない） |

Router 側の写像（設計 §4.4）: 領収つき 200 ∧ 照合が通る → `paid`、領収なしの 402／5xx → `unknown`（`destination_pay_unknown`。**Router は再送しない**）、領収なしの 200 → `unknown`。pay-kit の 402 は「検証で落ちた = 送出していない」場合と「送出したが確定を 30 秒で見られなかった」場合を区別しない（どちらも 402）。Router はどちらも `unknown` に写すので安全側（買い直さない）。

- **応答の本文もヘッダも固定文だけ**（mppx の例外の文言・鍵・RPC の URL を含めない）。pay-kit が `console.error` に書く simulate の log は Workers の log にだけ出る（応答には出ない）。
- 1 要求で送出は pay-kit の 1 回（pay-kit は再送しない。`sendTransaction` は `skipPreflight: false`）。Worker は再試行しない。
- **replay**（§3.4。**受け入れる限界**）: pay-kit の `replayStore` は isolate ごとのメモリ。同じ credential を**同時に**別の isolate に出されると、両方が送出し（chain は同じ transaction を 1 回だけ取り込む）、両方が `getTransaction` で同じ成功した transaction を見て、**両方が本文を配達し得る**（資金は 1 回しか動かないが、同じ支払いで本文が 2 回出る。逐次なら 2 回目は chain の already-processed か replay の予約で 402）。損なうのは Provider の本文だけ（資金の二重移動は無い。Router は credential を 1 回しか出さない）。testnet のデモの Provider として受け入れ、共有の原子的な replay store（Durable Object）は範囲外（§6 の決定 6）。

### 2.3 本文（支払い後）

先行の Provider A の契約（`docs/provider-x402-workers.md` §2.3）の **`payment` だけを `{ protocol: "mpp", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }` に**。他の鍵は過不足なく同じ（`providerId: "market-data-a"`、Hyperliquid の `markPx`・`prevDayPx`・`dayNtlVlm`・`change24h`・`assetIndex`、数値は文字列）。chat 側の検証が `protocol: "x402"` を要求していれば弾かれる（Router の配達には影響しない。契約の持ち主の確認は先行の §7 と同じく未確認のまま）。

### 2.4 鍵・env・Workers の環境

| 名前 | 種類 | 値 |
|---|---|---|
| `PAY_TO` | var | 受取 owner の公開鍵（base58 32 バイト）。**鍵は owner の file にだけ**（`scripts/keygen-recipient.mjs`。先行の `keygen-solana.mjs` と同じ: 排他的に作り（既存なら書かない）、mode 0600。**file はリポジトリの外**に置く。script はリポジトリの中のパスを拒む） |
| `FEE_PAYER_KEY` | secret | fee payer の seed（base58 32 バイト）。`scripts/keygen-fee-payer.mjs` が乱数で作り、**標準出力には公開鍵だけ**、seed は `wrangler secret put FEE_PAYER_KEY` の stdin に直接（先行の `keygen.mjs` と同じ方式。端末・log・file に残らない）。**wrangler の終了コードが 0 のときだけ公開鍵を出す**（upload に失敗した鍵に資金を入れない） |
| `MPP_SECRET` | secret | challenge の HMAC の秘密（32 バイト以上の乱数）。`scripts/secret-new.mjs` が作って `wrangler secret put MPP_SECRET` の stdin に直接 |
| `SOLANA_RPC_URL` | secret（**実質必須**。§7 U-P3: 公開 devnet RPC は Cloudflare からの要求を拒む） | devnet の RPC（owner の Alchemy 等）。無ければ公開 `https://api.devnet.solana.com`（402 は出るが支払いは通らない）。鍵を含み得るので var ではなく secret に。**mppx は検証の例外の文言を log に書き、RPC の URL を含み得る**（§1）: log は owner の dashboard・`wrangler tail` にだけ出るが、URL に鍵を埋める RPC を使うなら、鍵を header で渡せる RPC か、log の閲覧を owner に限ることを前提にする。Worker は `console.error` を**差し替えて**（isolate の起動時に 1 度）RPC の URL の文字列を `<rpc>` に伏せる |
| `FEE_PAYER_PUBKEY` | var | fee payer の公開鍵。**起動ごとに `FEE_PAYER_KEY` から導いた公開鍵と一致を検査**（違えば全要求 500 固定文。先行の Arc の `PAY_TO` と同じ守り） |

- fee payer の鍵が払うのは **devnet SOL の手数料だけ**（1 件 2 署名 × 5,000 lamports + 優先手数料。0.1 SOL で数千件）。USDC は持たない。
- 受取 owner の **USDC の ATA を配備前に作る**（rent は owner の devnet の鍵）。Provider は起動時の検査を持たない（isolate ごとに RPC を叩かない）ので、配備の手順（§5）で `getAccountInfo` を見る。Router は静的 route の起動時に宛先 ATA を確かめる（既存）。
- fee payer・受取 owner は Router の運用者の address（Base `SUBETHA_ROUTER_RECEIVER`、Arc の受取鍵の address、`SUBETHA_SOLANA_RECEIVER`、送信の署名者 `SUBETHA_OUTBOUND_X402_KEY`／`SUBETHA_OUTBOUND_PRIVATE_KEY`／`SUBETHA_OUTBOUND_SOLANA_KEY` の公開鍵、x402 Provider の受取先 `4LrB…`、それらの ATA）のどれとも違うこと（Router の SR-M4 の除外に当たると候補外になる）。

### 2.5 受け入れ条件

- AC-PD1（unit・handler、Node）: 402 の形が §2.1（pay-kit の実物の wire を Router の `checkMppSolanaChallenge` に掛けて候補。fee payer・受取先が運用者の集合・宛先 ATA・予約した program に当たる組は候補外になることも同じ関数で確かめる）、`Authorization` の `payment`／`PAYMENT`／`Payment` の全部が支払いつきの枝に入り、未払いの枝では pay-kit に `Authorization` が渡らない、段 1 の失敗は 502 で pay-kit を呼ばない（RPC の要求 0）、支払いつきの経路は Router の **実 adapter**（`createMppSolanaOutbound` + Router の RPC fixture `tests/fixtures/solana-rpc.ts` を Worker の handler と共有）で買って `paid`（本文の契約、領収は pay-kit の値そのまま、送出 1 回）、pay-kit の 402（検証の失敗・RPC の不達・確定待ちの timeout）は本文 `{}` + `no-store` + 正しい `content-length`、escape した例外は 502 固定文、env の検査（`FEE_PAYER_PUBKEY` 不一致 → 500）、**同じ credential を 2 つの handler（2 つの pay-kit instance = 2 isolate の模擬）に同時に出す行**（§2.2 の限界の記録: 資金は 1 回、本文は 2 回まで）と逐次の行（2 回目は 402）。
- AC-PD2（結合、手元。**本物の Worker = `wrangler dev`（workerd）**。先行の `tests/acceptance/provider-x402-workers.test.ts` と同じ gate `PROVIDER_WORKER_AC=1`。**配備の前提: これが通るまで配備しない**）: Router の送信 adapter が workerd の Worker から買って `paid`（cold start の 1 件目と warm の 2 件目、同時の 2 件）。Worker → RPC は試験の proxy で Router の RPC fixture へ。確定待ちの timeout（fixture の status を `null` のまま）→ Worker 402（領収なし）→ Router `unknown`、送出 1 回。送出の後に Router 側の接続を切る → Worker は続行し資金は動く（Router は `unknown`）。RPC が 45 秒を超えて黙る → Router は 45 秒で `unknown`、Worker の送出は高々 1 回。
- AC-PD3（配備後。owner の作業と G-3″）: 公開 URL の未払い 402 を 2 回取り記録（`feePayerKey`・`recipient`・`expires` の形、要求ごとの変化は `id`・`expires` だけ）、受取 ATA の `getAccountInfo`、fee payer の SOL 残高。実際の有料要求は **G-3″**（Router の受け入れ用の起動から。資金が動く）で記録する。

## 3. 設計

### 3.1 構造（1 つの Worker）

```
providers/mpp-solana-workers/
  package.json     (@solana/pay-kit 0.13.1, @solana/kit, @noble/curves, wrangler, vitest, typescript)
  wrangler.toml    (name = "provider-mpp-sol", custom domain, compatibility_flags = ["nodejs_compat"], [vars] PAY_TO / FEE_PAYER_PUBKEY)
  scripts/keygen-fee-payer.mjs   fee payer の seed → wrangler secret の stdin（公開鍵だけ出力）
  scripts/keygen-recipient.mjs   受取 owner の seed → owner の file（公開鍵だけ出力。先行の keygen-solana.mjs の写し）
  scripts/secret-new.mjs         MPP_SECRET → wrangler secret の stdin
  src/
    index.ts     fetch handler（§2.2 の順序。export は handler と関数だけ）
    config.ts    env の検査（PAY_TO・FEE_PAYER_PUBKEY の形、seed → 公開鍵の一致、RPC の URL の形）、定数
    paykit.ts    createPayKit / Gate の組み立て（isolate ごとに 1 回。鍵は signer の closure にだけ）
    snapshot.ts  Hyperliquid の取得と §2.3 の封筒（先行の写し。`payment.protocol: "mpp"`）
    deadline.ts  段 1 の期限（先行の写し。段 2 には掛けない）
  test/          vitest（Node で: 純粋関数と handler。Hyperliquid は差し替え、RPC は Router の fixture）
```

- `paykit.ts`: `Signer.from(await createKeyPairSignerFromPrivateKeyBytes(seed), { feePayer: true })`（`@solana/kit`。seed は `FEE_PAYER_KEY` から 1 度だけ読み、config にも Runtime にも入れない）。`createPayKit({ network: "devnet", rpcUrl, accept: ["mpp"], operator: { signer, feePayer: true, recipient: PAY_TO }, mpp: { challengeBindingSecret: MPP_SECRET, realm: "subetha-provider-mpp-sol", expiresIn: 300, html: false }, preflight: false })`（`preflight` は isolate ごとに RPC を叩くので切る。配備の手順で確かめる。`simulateTransaction` は `preflight` と無関係に送出の前に呼ばれる）。`Gate.create({ amount: usd("0.01"), name: "eth-snapshot", description }, { accept: ["mpp"], payTo: PAY_TO })`。
- `index.ts` の順序: 404 → `Authorization` の判定（pay-kit と同じ小文字化）→ 無し: **`Authorization` を外した要求**で `pay.fetch(gate, …)` の 402 を得る（`cache-control` を足す）→ あり: 段 1（snapshot）→ `pay.fetch(gate, () => json(snapshot))` → 応答の本文の置き換え（402 なら `{}`、5xx なら固定文、どちらも `content-length` を付け直し `no-store`。200 と `Payment-Receipt` はそのまま）。
- 先行の §9 の workerd の教訓をそのまま適用（entry の export、`fetch` の呼び方、`redirect`、`accept-encoding`）。

### 3.2 pay-kit に任せるもの・任せないもの

- 任せる: challenge の発行と HMAC、credential の検証（構造・署名・期限）、共同署名、送出、確定待ち（30 秒）、chain の読み直し、領収。**自前で再実装しない**（fixture と同じ経路 = Router の wire 試験 30 本が既に通っている経路）。
- 任せない: データの取得（段 1。支払いの前）、応答の本文の固定化、env の検査、404。

### 3.3 RPC

pay-kit の RPC は素の `fetch`（redirect は既定、上限なし、1 回の fetch に期限なし: 確定待ちの 30 秒は polling の全体に掛かるだけ）。相手は **owner が選ぶ devnet の RPC**（secret）で、第三者が指定する URL ではないので Router の SSRF 防御は要らない（Worker からの egress は Cloudflare の経路）。公開 RPC（`api.devnet.solana.com`）は共有の egress IP からのレート制限を受け得る → 配備で観測し、必要なら owner の RPC を secret に。RPC が黙れば pay-kit の 1 回の fetch が終わらず、Router 側が 45 秒で `unknown` にする（Worker の送出は高々 1 回）。log: mppx が例外の文言を `console.error` に書くので、Worker は起動時に `console.error`／`console.warn` を包み、RPC の URL の文字列を `<rpc>` に置き換える（§2.4）。

### 3.4 限界（書いておくもの）

- replay store は isolate ごと（§2.2）。同時に別の isolate に届いた同じ credential は本文を 2 回出し得る（資金は 1 回）。受け入れる限界。共有の原子的な store（Durable Object）は範囲外。
- pay-kit の 402 は「送出前の拒否」と「送出後の確定待ちの timeout」を区別しない。Router は両方 `unknown`（再送しない）。送出後の timeout では**資金は動いているが Provider は 402 を返す**（Router は `destination_pay_unknown` を残し、運用者が chain を見る）。
- pay-kit が `getTransaction` を jsonParsed で読む = 応答は数 KiB。Workers の fetch に上限は無いが、相手は owner の RPC。
- Workers の 1 要求の中で 30 秒の polling（subrequest は数十回）と CPU 数十 ms: 無料・有料の plan の subrequest の上限（50／1000）の内側。bundle の大きさ（pay-kit + kit ≈ 1 MiB 未満）は 3 MiB の内側（配備で記録）。

## 4. 試験

| 層 | 内容 |
|---|---|
| unit（Node） | `config.ts`（形・一致・不一致 → 500 固定文）、`snapshot.ts`（先行の試験の写し: 形・大きさ・Hyperliquid の失敗）、本文の置き換え（402 → `{}`、5xx → 固定文、200 はそのまま） |
| handler（Node。pay-kit は本物、RPC は Router の fixture、Hyperliquid は差し替え） | 402 の wire を Router の `checkMppSolanaChallenge` に掛けて候補（fee payer・受取先の除外の組は候補外）/ `Authorization` の大文字小文字の 3 通りが支払いつきの枝、未払いの枝は `Authorization` を外す / 段 1 の失敗で pay-kit を呼ばない（fixture の RPC の要求 0）/ Router の `createMppSolanaOutbound` で買って `paid`（領収は pay-kit の値そのまま、`challengeId`・`reference`、`sendTransaction` 1 回、本文の契約、`no-store`）/ 確定待ちの timeout（fixture の status `null`）→ 402 本文 `{}`・領収なし・`no-store`・`content-length` → Router `unknown` / RPC の不達 → 402（pay-kit の例外は 402 に写る）/ 別の mint・別の受取先の credential → 402（pay-kit の検証）/ 同じ credential の逐次 2 回目 → 402（replay）/ **同時 2 instance** → 資金 1 回・本文は 2 回まで（限界の記録）/ クエリつき → 404 / log の伏せ字（RPC の URL が `console.error` の出力に出ない） |
| 結合（手元、AC-PD2） | `wrangler dev` の Worker に Router の送信 adapter で買う → `paid`。timeout の行 → Router `unknown`。gate `PROVIDER_WORKER_AC=1` |
| 変異 | §2.2 の順序（段 1 を pay-kit の後に）、本文の置き換えを外す、`feePayer: false`、`preflight: true`、`FEE_PAYER_PUBKEY` の一致の検査を外す、`externalId` を固定で出す、`cache-control` を外す、`Authorization` の判定を大文字小文字を区別する形に、未払いの枝で `Authorization` を外さない、`expiresIn` を既定に、log の伏せ字を外す |

## 5. 配備（owner の作業を含む）

1. この文書の独立レビュー → owner の確認 → 実装の PR（Router の試験には影響しない。`tests/acceptance/provider-mpp-solana-workers.test.ts` は gate つき）→ **AC-PD2 が手元で通る**（私の機械。通らなければ配備しない）→ 独立レビュー → merge。
2. owner: `wrangler login` 済みの端末で `providers/mpp-solana-workers/` の `npm ci`。Cloudflare の DNS に `provider-mpp-sol.subethalabs.com` を Worker の custom domain として追加。
3. 鍵（owner の端末。鍵は端末に出ない）: `node scripts/keygen-fee-payer.mjs`（seed を secret `FEE_PAYER_KEY` に直接。**upload が成功したときだけ**公開鍵を出す → `wrangler.toml` の `FEE_PAYER_PUBKEY`。`--dry-run` は wrangler を呼ばず**使い捨ての**公開鍵を出すだけ（その seed は捨てられ、どこにも無い。本番には使えない））、`node scripts/keygen-recipient.mjs <リポジトリの外の file>`（公開鍵だけ出る → `PAY_TO`。seed は owner の file 0600。排他的に作る。symlink でリポジトリの中を指すパスも拒む）、`node scripts/secret-new.mjs`（`MPP_SECRET` に直接）。任意: `wrangler secret put SOLANA_RPC_URL`。
   **注意**: Worker がまだ無いときの `wrangler secret put` は、その名前の Worker（空の下書き）を Cloudflare に作ってから secret を入れる。6 の `wrangler deploy` はそれを置き換えるので順序はこのままでよい。
4. owner（**3 の upload が成功した後に**）: fee payer の公開鍵に **devnet SOL**（faucet。0.1 SOL で十分）。受取 owner の **USDC の ATA を作る**（`spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <PAY_TO> --url devnet`。rent は owner の devnet の鍵）。私が `getAccountInfo`・SOL の残高を読んで確かめる（AC-PD3）。
5. fee payer と受取 owner が Router の運用者の address（§2.4）のどれとも違うことを一覧で確認。
6. `wrangler deploy`。配備後に 402 を 2 回取り記録（AC-PD3）。Router の候補の検査に手元で掛ける。
7. Router 側（MG）: `UPSTREAM_SOL_MPP = https://provider-mpp-sol.subethalabs.com/v1/eth/snapshot` と `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO=<PAY_TO>` の PR → G-2″（無効のまま配備。owner の確認）→ G-3″（受け入れの購入。testnet なので購入ごとの確認は不要 = 2026-10-08 の決定）→ G-4″（有効化。owner の判断）。

## 6. owner に決めてもらうこと

1. **置き場**: Workers（この文書。先行の 2 Worker と同じ運用）か Node の http（fixture を本物化。常時動かす機械が要る）。推奨は Workers。
2. **`externalId`（Memo）**: 出さない（推奨。Router は無くても払い、固定文では購入ごとの束縛にならない）か、固定の説明文を出すか。
3. **RPC**: 公開 devnet のまま始めるか、owner の RPC（Helius 等の devnet）を secret で入れるか。公開で始めて、レート制限が見えたら切り替える案。
4. **ドメイン名**: `provider-mpp-sol.subethalabs.com`（Worker 名 `provider-mpp-sol`）でよいか。
5. **本文の契約**: `payment.protocol: "mpp"` の拡張でよいか（chat の検証の扱いは先行と同じく未確認）。
6. **replay の限界**（§2.2・§3.4）: 同時の replay で本文が 2 回出得ることを testnet のデモとして受け入れるか、Durable Object の共有 store を足すか（追加の設計と費用。推奨は受け入れ）。

## 7. 未確認（実装か配備で分かること）

- U-P1（**手元の workerd で確認済み、2026-10-08**）: `wrangler dev`（workerd、`nodejs_compat`）で `@solana/kit` の Ed25519 の署名と検証が通り、pay-kit の `createPayKit`（`Signer.from(kit の signer, { feePayer: true })`）が起動し、`GET /v1/eth/snapshot` が 402 を返した（`WWW-Authenticate` の `request` は `amount: "10000"`、`currency` = mint、`methodDetails: { decimals: 6, feePayer: true, feePayerKey, network: "devnet", tokenProgram }`、`recipient`。本文は pay-kit の `accepts`）。使い捨ての鍵・loopback だけ・RPC は閉じたポート（402 は RPC を要しない）。残るのは支払いつきの経路（AC-PD2）。
- U-P2: Workers の 1 要求の中で pay-kit の確定待ち 30 秒 + `getTransaction` が収まるか（Workers の HTTP の wall time に上限は無い。CPU は数十 ms。subrequest は数十回）。AC-PD2 と配備で観測。
- U-P3（**解決、2026-10-08**）: 公開 devnet RPC（`api.devnet.solana.com`）は Cloudflare からの要求を **「Your IP or provider is blocked from this endpoint」で拒む**（`wrangler tail` で mppx の `internal verification error` に出た。未払いの 402 は RPC を要しないので通り、支払いつきの要求だけ pay-kit が送出の前に 402 で止まっていた。資金は動いていない）。owner が Alchemy の devnet の RPC を secret `SOLANA_RPC_URL` に入れて解決（再 deploy 不要）。`SOLANA_RPC_URL` は**実質必須**として §2.4・§5 を読むこと。
- U-13（Router 側）: Router の 45 秒と pay-kit の 30 秒 + RPC の往復の関係。G-3″ で実測。

## 8. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版） | **REJECT**（P1 2 点: isolate ごとの replay store では同時の replay で本文が 2 回出得る（限界として明示するか共有 store）、`Authorization` の判定が pay-kit の大文字小文字を区別しない判定と違い未払いの枝で settle し得る。P2: `expiresIn` の既定は 120、`simulateTransaction` は呼ばれる、RPC の不達は 402、AC-PD2 の強化（cold start・同時・送出後の切断・45 秒超の RPC）、領収をそのまま、`no-store`・`content-length`、鍵の file はリポジトリの外・upload の成功の後に資金、mppx の log の伏せ字）。第 2 版で反映 |
| 1r | 2026-10-08 | `gpt-6-astra`（readback。第 2 版） | **APPROVE WITH CHANGES**（P1 2 点は解消。残り P2 1 点: §1 の `expiresIn` の既定の記述の矛盾 → 120 に訂正、反映済み）。replay の受け入れは owner の決定（§6 の 6）、手元の spike は AC-PD2 の代わりにならない |
| I-1 | 2026-10-08 | `gpt-6-astra`（read-only。実装 `940564e`） | **REJECT**（P1 3 点: 受取 owner の seed の file の検査が字面だけで symlink を見抜けない、AC-PD2 が Miniflare の `cf.json` の取得と継いだ env で外に出得る、workerd での確定待ち 30 秒と RPC が 45 秒超黙る行が無い。P2: 未払いの枝の `Authorization` 除去を handler 越しに観測する、harness が `content-length` を付け直して欠けを隠す、別の mint／受取先・本文の上限・例外の正規化・候補の除外の行、seed の消去を finally に、`--dry-run` と `secret put` の下書きの文書）。`b024da8` で反映 |
| I-1r | 2026-10-08 | `gpt-6-astra`（readback。`b024da8`） | **APPROVE WITH CHANGES**（P1 3 点・P2 4 点は解消。残り P2 1 点: 同じ秘密で受取 owner だけ違う credential の行と候補の除外の各行 → 追加、反映済み） |

## 9. 実装と AC-PD1／AC-PD2 の記録（2026-10-08）

- 実装: `providers/mpp-solana-workers/`（branch `provider-d/impl`）。§3.1 のとおり。`package.json` に vitest は無い（この機械の npm の resolver が vitest 5 の peer の集合で落ちたため。
  試験はリポジトリの根の vitest から Worker のソースを直接 import して走らせる: `tests/wire/provider-mpp-solana-handler.test.ts`・`provider-mpp-solana-scripts.test.ts`・
  `provider-mpp-solana-timing.test.ts`（実時間 30 秒）・`tests/acceptance/provider-mpp-solana-workers.test.ts`（AC-PD2、gate `PROVIDER_WORKER_AC=1`）。
  Router の `tsc` は Worker のソースも型検査する（Web の型だけを使う。`@cloudflare/workers-types` の型は使わない））。
- `log.ts` の伏せ字は install 時点の console の method を包む（isolate の起動時のもの。試験の spy もその 1 つ）。
- AC-PD1（Node。pay-kit は本物、RPC は Router の fixture、Hyperliquid は差し替え、Router の実 adapter で購入）: handler 14 行、script 3 行、実時間 1 行。
  観測した限界（§2.2）: 同じ credential を**未消費の 2 instance**に同時に出すと両方が 200 を返し得る（fixture では 2 つ目の instance が同じ取引を送出し直し、chain は同じ署名を 1 件のまま、`getTransaction` で成功を見て 200）。
- AC-PD2（macOS、wrangler 4.148.0、workerd）: cold start の購入 `paid`（本文は契約、領収あり、Worker の 200 の wire は `content-type`・`no-store`・`Payment-Receipt`）、warm、同時 2 件（別の adapter・別の blockhash）、
  送出の RPC error → Worker 402（領収なし）→ Router `unknown`、送出の後に Router が去る（期限 2 秒）→ Router `unknown`・Worker は続行して 200 + 領収（資金は動く）、
  **確定待ちの timeout（workerd の中の pay-kit、30 秒）→ 402 → Router `unknown`（45 秒の内側）**、**RPC が 45 秒超黙る → Router は 45 秒で `unknown`、chain への送出 0**、生の log に seed・秘密なし。
  外に出ない根拠: fixture・proxy・front は 127.0.0.1、wrangler の telemetry・error report・banner・Miniflare の `cf.json` の取得（`CLOUDFLARE_CF_FETCH_ENABLED=false`）は env で止め、npm の registry は閉じた loopback、子の env は親を継がない。
- 変異: §4 の表の 21 件（`provider-d-mutations.py`。各 1 件ずつ当てて該当の suite を走らせ、commit から戻す）。21 件すべて検出（PR #108）。
- **配備と AC-PD3（2026-10-08。owner の作業）**: `npm ci` → `wrangler login` 済みの端末で `scripts/keygen-fee-payer.mjs`（secret `FEE_PAYER_KEY`。公開鍵 `DAmvTYsraoup88EJvs3KK3gFYfofULevXVGjz2wXM5gS`）、
  `scripts/keygen-recipient.mjs`（owner の file。公開鍵 `26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc`）、`scripts/secret-new.mjs`（`MPP_SECRET`）。`wrangler.toml` の 2 値は PR #109。受取 ATA `MUbNoZ9cjg2vtwEJxbnChk315fhj1daMYEumWKDCR4S` は owner が
  `spl-token create-account … --fee-payer ~/.config/solana/id.json`（この版の CLI は `--owner` に公開鍵を渡すと既定の signer を fee payer に拾わないので明示が要る）で作成（signature `3M1VCr…`）、fee payer に devnet SOL 1.0。
  `wrangler deploy`: version `fc901ca8-521e-4be8-ba2b-82be78f3227a`、upload 3,051 KiB / gzip 518 KiB、起動 55 ms、custom domain `provider-mpp-sol.subethalabs.com`。
  AC-PD3: 公開 URL の未払い GET 2 回（0.59 秒・0.67 秒）は 402・`no-store`・`application/json`、`WWW-Authenticate` の `request` は §2.1 のとおり（`externalId`・`opaque` 無し、`expires` ≈ 300 秒）、2 回で変わるのは `id` と `expires` だけ。
  Router の候補の検査（本番の運用者の集合）で候補、ATA の不等式も通る。別のパス・HEAD は 404。`getAccountInfo`（finalized）で ATA の owner・mint・program・`initialized` を確認。Router 側は `UPSTREAM_SOL_MPP` を定数に入れた（G-2″ 以降は `docs/DEPLOY.md` §2d）。
- 独立レビュー（実装）: §8 の表。
