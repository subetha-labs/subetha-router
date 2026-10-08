# 設計: Solana の MPP（`method="solana"`、`intent="charge"`）を受信・送信の両方で（S-5・S-6。第 3 版、2026-10-08）

> 要件は `docs/mpp-solana-requirements.md`（第 6 版。D-18〜D-30 は owner が採用）。先行の設計 `docs/multirail-outbound-design.md`（S-3・S-4）と同じ章立て。
> 行番号は `main` の `29d522c`。本書は**何をどこに作るか**を決める。タスクは別紙。
>
> 第 2 版（独立レビュー #1、§12）: SDK の server hook は `validate` + 投げる `broadcast`（`verify` ではない）で `Validation` の全欄を返す、HMAC の検査は `mppx.validateCredential` を**明示的に**呼ぶ、構造の検査は preflight ではなく **verify**（`verify_failed` を journal に残す。compute budget は各高々 1 つ）、
> 追跡の予算は SR-M1 のまま（follow-up の開始から 30 秒・15 回）、`blockTime` の窓は FR-47 のまま、store の bind は `createRouterCore` の callback、受信の `startup()` の登録、送信は SDK が選んだ `prepared.challenge` を承認値と照合し**hook が返した credential を復号して再検査**、送出の直前に blockhash の経過時間、`challengeId` は必須、
> `assertDynamicMppCapability` にも絞ったプロファイル、purchase の cap の検査は残して見積りだけ飛ばす、受取 owner の述語を x402 と MPP で分ける、`z` は `mppx` の export、pay-kit の `mppx` は `overrides` で 0.13.x に固定。
>
> **owner の承認**: 2026-10-08「どちらも勧めて良いです」（PR #96）。
>
> 第 3 版（readback #1、§12）: `source_settled` の追記の失敗は core が捕まえて `unknown`（`source_settle_unknown`）を返す（§2.3。FR-48 の表のとおり。静的・動的）、§3.5 の verify は型別に署名者を得てから ATA を導く、§3.6 の preflight の行に `signature` 型の既払を明記、§5.2 の helper の回数の上限、simulate の応答は JSON-RPC の `result` の中。
> 本書の中で「x402 SVM 送信」は `src/adapters/outbound/x402-svm.ts`、「x402 SVM 受信」は `src/adapters/inbound/x402-svm.ts`、「Tempo 受信」は `src/adapters/inbound/mpp.ts`、「Tempo 送信」は `src/adapters/outbound/mpp.ts`。

## 0. 一枚で

| 項 | S-5（MPP で Solana を受ける） | S-6（MPP で Solana の Provider に払う） |
|---|---|---|
| 新しい adapter | **`src/adapters/inbound/mpp-solana.ts`**（§3）: challenge の発行は `mppx` 0.11.0 の `Mppx.create` + 自前の `Method.toServer`（schema だけ）、検査は Router の純粋関数、`transaction` 型は Router が送出して確定を追う | **`src/adapters/outbound/mpp-solana.ts`**（§4）: 402 の読取は `mppx` の client（`Method.toClient` + `preparePayment`）、transaction は x402 SVM 送信の primitives で組み・検査し・予約し・署名する。pull だけ（D-23） |
| 能力 | 署名鍵は無い。HMAC の秘密は既存の `ROUTER_MPP_INBOUND_SECRET`（Tempo と共有） | 既存の **`svmSigning[solana:…]`**（`SvmSigningCapability`。x402 SVM 送信と同じ鍵・同じ ATA。D-19）。新しい能力の型は作らない |
| 合成 | `main.ts` の MPP 受信の loop を **network の family で分ける**（`eip155:` → Tempo、`solana:` → 本書） | `pairsInUse` の `mpp` の分岐を family で分ける（`eip155:` → Tempo、`solana:` → 本書）。`startup()` を起動時の検査に繋ぐ |
| 表 | Solana の `inbound: ["x402", "mpp"]` | Solana の `outbound: ["x402", "mpp"]`。scheme は **`solana/charge`** |
| 設定 | 受信の route／プロファイルの `source` は x402 Solana 受信と同じ欄（`payTo` = 受取 owner） | 動的プロファイルの `destination`（`rail: "mpp"` ∧ `solana:`）は **`feeAsset`・`maxFee`・`feeMargin` を持たない**（FR-44 の明示の例外）。`decimals` 必須、`tokenProgram` 任意 |
| RPC | Solana RPC（x402 SVM 受信と同じ guarded transport）: `getTransaction`（`signature` 型）、`sendTransaction` + `getSignatureStatuses`（`transaction` 型） | Solana RPC: ATA・blockhash・残高・領収の `getTransaction` |
| core の変更 | journal の `source_settled` の `txRef` の集合を adapter に見せる（`createRouterCore` の callback。SR-M2）。`svmUsageOf` に MPP の Solana 受信 | 動的 core・設定・store の **Solana 宛 MPP の手数料の例外**（FR-44）。送信の期限 45 秒 |
| 本番の入口 | `RAILS_ACTIVATION.solanaMpp.inbound`、route `md-x402-eth-snapshot-solmpp`・`md-mpp-eth-snapshot-solmpp`、プロファイル `dyn-solmpp-to-*` | `RAILS_ACTIVATION.solanaMpp.outbound`、route `md-solmpp-eth-snapshot`・`md-solmpp-eth-snapshot-mpp`、プロファイル `dyn-*-to-solmpp`、Provider D の URL と受取先 |

**作る順**: §1（表・設定・手数料の例外）→ §2（合成の分岐と core の口）→ §5（共有の primitives の拡張: Memo 任意、追跡の helper）→ §3（受信）→ §4（送信）→ §6（入口）→ §7（道具）→ 受け入れ（§8）。
**公開する行列**は要件 §7 の 12 本（静的 4・動的 8）。push は第 2 段（D-23。本書は pull の形だけを決め、push の credential の型は決めない）。

## 1. 表と設定

### 1.1 表（`src/config.ts` `KNOWN_NETWORKS` `:45-80`）

- Solana `solana:EtWT…`（`:70-78`）: `inbound: ["x402", "mpp"]`、`outbound: ["x402", "mpp"]`。他の行は変えない。`x402Facilitator` はそのまま（MPP は facilitator を持たない）
- `validateTermsAgainstTable`（`:144-200`）は rail の名前と向きを見るだけなので、表の変更だけで `mpp` が Solana で通る。`tokenProgram` の照合（`:187-195`）は family が `svm` なら rail に関係なく効く（MPP の宛先にも渡す。§1.2）

### 1.2 動的プロファイル（`parseDynamicProfile` `:698-810`）

- `destination` の分岐（`:753-790`）を 3 つに: **x402 ∧ svm**（今のまま）、**x402 ∧ evm**（今のまま）、**mpp ∧ evm**（今のまま: `feeAsset`・`maxFee` 必須、`feeMargin` 既定）、**mpp ∧ svm（新）**: `decimals` 必須（表と照合）、`tokenProgram` 任意（表と照合）、`tokenDomain` 禁止、
  **`feeAsset`・`maxFee`・`feeMargin` のどれかがあれば `ConfigError`**（FR-44 (a)。「無視」ではなく拒否: 設定に書けば効くと誤解させない）。`pricingPolicy: "gas-indexed-v2"`（`:384`）は **mpp ∧ evm だけ**に付ける
- `scheme` は `"solana/charge"` を要求（`requireString` の後に照合。Tempo は `"tempo/charge"` を要求している規則と同じ。定数は §3 の `MPP_SOLANA_SCHEME`）
- `validateRouterConfigAgainstTable`（`:891-914`）: 送信レグが `mpp` ∧ `svm` でも `tokenProgram` を渡す（x402 ∧ svm と同じ）

### 1.3 静的 route

- 形は変えない（`DestinationAllow`: scheme・network・asset・payTo）。Solana MPP 宛は `scheme: "solana/charge"`、`payTo` = Provider D の **owner の公開鍵**（base58 32 バイト。ATA ではない）。受信側（S-5）の静的 route は `sourceRail: "mpp"`、`source.network` = Solana、`source.asset` = 表の mint、`source.payTo` = 受取 owner（x402 Solana 受信と同じ値）
- 上流の URL は `x402.upstreams[routeId]`（今のまま）

### 1.4 手数料の例外（FR-44。設定・動的 core・store の 3 か所に**明示**）

| 場所 | 今 | 変更 |
|---|---|---|
| `src/config.ts` `parseDynamicProfile` `:778-786` | `rail === "mpp"` は一律 `feeAsset`・`maxFee` 必須 | §1.2 の 4 分岐。svm の mpp は 3 欄を**禁止** |
| `src/core/dynamic.ts` `quote` `:339-347` | `profile.rail === "mpp"` なら `estimateFor` を呼び、cap を持つ quote | `profile.rail === "mpp" && networkFamilyOf(profile.destination.network) === "svm"` なら **`estimateFor` を呼ばず** `cap = undefined`（`priceOf` は cap 無しで規則の手数料だけを出す `:130-165`。`pricing.maxFee`・`estimate` は出ない）。`legsOf`（`:180`）は `feeAsset` が無いので手数料の leg を足さない（今の条件のまま成り立つ）。purchase 時（`:533-552`）は **`capCoversFee` の検査は残し**（下の store の例外で cap 無しを許す）、**`estimateFor` と `fee_too_high` の比較だけ飛ばす**。cap の読み直し（`:636-640`）は `cap === undefined` なので今の条件で自然に飛ぶ |
| `src/core/store.ts` `capCoversFee` `:189-215` と復元の検査（`dynamicInvalid`、`intent.ts:157`） | MPP 送信の記録に cap が無ければ `dynamicInvalid` | **宛先が `solana:` の MPP の記録は cap を要求しない**（`fee >= maxFee` の検査をせず、`total = converted + fee`・`source.offer.amount = total`・`upstreamAmount` の検査だけ）。Tempo（`eip155:`）の記録に cap が無ければ今までどおり不可。判定は記録の `profile.destination.network` の family（復元）と設定のプロファイル（再開）の**両方**で同じ結果でなければ不可 |
| `src/main.ts` `dynamic.verify` `:793-815` | `rail === "mpp"` の全プロファイルで `assertDynamicMppCapability`・RPC ホスト・`eth_fillTransaction` の probe | **`mppProfiles` を `eip155:` 宛に限り、`assertDynamicMppCapability`（`:796`）にも全 `profiles` ではなく絞った record を渡す**（`mpp-dynamic.ts:625-627` は MPP の宛先をすべて EVM と見て `chainIdOf` する）。Solana 宛 MPP の起動時の確認は adapter の `startup()`（§4.5） |
| `src/core/orchestrator.ts` `deliver` `:806` | `pricing.maxFee` があれば `PayRequest.maxFee` | 変更なし（無ければ付かない） |

試験（AC-16）: 設定の生成・読み込み（3 欄のどれかで `ConfigError`）、quote が `estimateFee` を呼ばない（adapter は `estimateFee` を持たない。§4.1）、`pricing` に `maxFee`・`estimate` が無い、復元で `dynamicInvalid` にならない、Tempo の記録は今までどおり落ちる。

## 2. 能力と合成（FR-39・FR-40・FR-43）

### 2.1 能力（`src/main.ts` `RouterCapabilities` `:78-130`）

- 受信: 新しい能力は無い。HMAC の秘密は `real.mppInboundSecret`（`:721`）を**そのまま**使う（鍵の種類が増えない。realm も既定のまま）。受取先は route／プロファイルの `source.payTo`
- 送信: `svmSigning[network]`（`:87`）を x402 SVM 送信と**共有**（D-19）。`outboundCapabilitiesOf`（`:216-240`）は変えない。`operatorAddressesOf`（`:244-258`）も変えない（能力の公開鍵は既に (b) で入る。ATA は両 adapter の `startup()` が同じ `operatorSet` に足す: 冪等）
- `MppTempoCapability` は Tempo だけ。**Solana の MPP に `mppTempo` は要らない**（`pairsInUse` の `mpp` ∧ `solana:` は `svmByNetwork` を見る。無ければ `SignerNotAuthorizedError`）

### 2.2 合成（`composeRails` `:383-835`）

- **送信**（`:514-583`）: `pair.rail === "mpp"` の分岐（`:565`）を `networkFamilyOf(pair.network)` で分ける。`svm` なら `createMppSolanaOutbound({ network, upstreams, destinations, capability: svmByNetwork.get(network), transport, rpc: { url: solanaRpcUrl, transport: svmRpcTransportOf(...) }, operatorAddresses: operatorSet, mint, decimals, tokenProgram, dynamic?: { profiles: rail mpp ∧ この network のもの, transport: dynamicTransport, denyHosts }, paidTimeoutMs: 45_000 })`。
  `svmStartups` に `startup()` を足す（x402 SVM 送信の後に走る。順序は `pairsInUse` の挿入順 = 設定の順。どちらも同じ ATA を導くので順序に意味は無い）。表の資産の取り方（`:530-540`）は x402 SVM と同じ helper に括る
- **受信**（`:715-770`）: `usesMppInbound` の loop を family で分ける。`solana:` の route／プロファイルは `createMppSolanaInbound({ secretKey, recipient: payTo, mint, decimals, tokenProgram, network, maxTimeoutSeconds: real.mppInboundOfferSeconds ?? 600, rpc: { url: solanaRpcUrl, transport: svmRpcTransportOf(...) }, consumed: settledTxRefs, onDiagnostic })`。
  `mppInboundChains`（`:436-439`）は **`eip155:` の route／プロファイルだけ**を数える（`Number("solana:…")` は NaN）。`chainId` の検査（`:745`・`:757`）は family が `evm` のときだけ
- **RPC の依存先**: `svmUsageOf`（`:195-205`）の `inbound` を `(sourceRail === "x402" || sourceRail === "mpp") && svm` に。`solanaRpcUrl`（`:452`）はこれで MPP の Solana 受信だけの構成でも入る。`denyHosts` は変更なし（`solanaRpcUrl` が入る）
- **受信の key**（`inboundByRoute` `:309`）: `mpp:<routeId>`／`mpp:<profileId>` のまま（受信は `sourceRail` と id で引く。family は合成が見る）
- **運用者の集合**: 受取 owner は `operatorAddressesOf` (a) で入る。Solana MPP 送信の候補検査で `recipient ∉ 運用者`（FR-50）に使う

### 2.3 journal の消費済み署名（SR-M2。`src/core/store.ts`・`src/core/orchestrator.ts`）

- `IntentStore` に **`settledSourceTxRefs: ReadonlySet<string>`** を足す: replay（`load` `:378-385`）で `source_settled` の行（`:275-279`）の `txRef` を集め、`append` でも足す（Set は reducer の中で更新。`txRef` が空の行は入れない）。永続化は journal そのもの（別の行を書かない。FR-47）
- store は `createRouterCore` の中で load される（`orchestrator.ts:333`）し、core の API は store を見せない（`:940-970`）。**`RouterCoreOptions.onStoreLoaded?: (view: { settledSourceTxRefs: ReadonlySet<string> }) => void`** を足し、`IntentStore.load` の直後（budget の load の前）に 1 回呼ぶ。`composeRails` は受信 adapter に **`consumed` の holder**（`has(txRef)`。bind 前に呼ばれたら throw）を渡し、戻り値に `bindConsumed(view)` を足す。`startRouter`（`main.ts:923-`）は `createRouterCore({ ..., onStoreLoaded: rails.bindConsumed })` と渡す。quote／purchase は core の生成の後にしか呼べないので、bind は必ず先に終わる
- 使う場所: §3.5 の settle の (1)。core の `source_settled` の追記は今までどおり settle の後（`orchestrator.ts:739`、`dynamic.ts:615`）。**追記の失敗（core の小さな変更。静的・動的の両方）**: 今は例外が purchase から escape する。FR-48 の表（記録に失敗 → `unknown`、`source_settle_unknown`）に合わせ、`source_settled` の `store.append` を try/catch で包み、失敗したら **別の行を書こうとせず**（journal はその後使えない `journal.ts:264`）`{ status: "unknown", terminalReason: "source_settle_unknown" }` を返す。memory の intent は `source_pending` のまま（reducer は journal の書込の後に走る）で、同じ intent の再提示は `currentOutcome` の `source_pending` の写像（`unknown`）。再起動では既存の復元処理のとおり: 行が残っていなければ `unknown`（`interrupted_at_restart`）、**`appendFile` は成功し `fsync` だけ失敗して完全な `source_settled` の行が残っていれば `paid_undelivered`（`interrupted_at_restart`）**（`store.ts:395-407`）。どちらも再送しない。**送信は始めない**（受信は chain 上で settle 済みなので `paid_undelivered` 相当だが、記録が無いので `unknown`）。他の append の失敗は変えない（この 1 点だけ）。試験: journal の append を失敗させる fixture（§8.2）
- 受信 adapter の **`startup()` は `composeRails` の `startupChecks` に登録**する（x402 SVM 受信の holder と同じ場所。`:590`・`:647`。送信の `svmStartups` より前）
- 原子性: `has` の検査と `source_settled` の追記は別の時点だが、**別の intent は認証済みの一意な `externalId`（Memo）で verify が先に落ち、同じ intent は core の lock（`withKey("purchase…")`）で直列**なので、同じ署名が 2 つの intent で `settled` になる経路は無い。消費済みの検査は再起動後の防御の層。両方を試験で残す（§8.2）

## 3. S-5: `src/adapters/inbound/mpp-solana.ts`

### 3.1 構造

```ts
export const MPP_SOLANA_SCHEME = "solana/charge";                 // offer.scheme・route の destination.scheme
export const MPP_SOLANA_METHOD = "solana"; export const MPP_SOLANA_INTENT = "charge";
export function createMppSolanaInbound(options: {
  secretKey: string;                                              // ≥ 32 バイト（Tempo と同じ検査）
  recipient: string;                                              // 受取 owner（base58 32 バイト）
  mint: string; decimals: number; tokenProgram: string;           // 表
  network: string;                                                // CAIP-2（`solana:…`）。challenge の methodDetails.network は "devnet" 固定（FR-41。表の network → "devnet" の写像は定数 1 つ）
  maxTimeoutSeconds: number;
  rpc: { url: string; transport: GuardedTransport };
  consumed: { has(txRef: string): boolean };                      // §2.3
  realm?: string; now?: () => number; sleep?: (ms) => Promise<void>;
  settleDeadlineMs?: number;                                      // 既定 50_000（FR-53 の 1 本の経過時間）
  onDiagnostic?: (code: string) => void;
}): InboundRail & { startup(): Promise<void> }
```

- **純粋な部分**（同じファイルに export。試験は RPC 無しで）: `mppSolanaChargeMethod`（`Method.from` の schema）、`checkMppSolanaTransaction(bytes, policy, amount, externalId): MppSolanaCheck`（§3.3）、`preflightMppSolana(offer, credential, nowMs)`（§3.4）、`mppSolanaSettleStatusOf(json)`（確定度の読み取り: `confirmed`／`finalized` ∧ `err === null` → `settled`、`confirmed` 以上 ∧ `err` → `failed`、それ以外 → `pending`）
- **`startup()`**: 受取 owner の ATA を導き `getAccountInfo` → `assertAtaAccount({ owner, mint, tokenProgram })`（x402 SVM 受信の起動時の検査 `x402-svm-startup.ts:111` と同じ関数。無い・違う → 起動しない）。`/supported` は無い（facilitator が無い）。policy（`destinationAta`）はここで固まる。`startup()` の前に `createOffer` 等が呼ばれたら throw

### 3.2 challenge の発行（FR-45・FR-46）

- schema（`Method.from({ name: "solana", intent: "charge", schema })`。`z` は **`mppx` が export する `z`**（`node_modules/mppx/dist/index.js:14`。§9）:
  `request = { amount: string, currency: string, recipient: string, externalId: string, methodDetails: { network: string, decimals: number, tokenProgram: string, feePayer: boolean } }`、
  `credential.payload = { type: "transaction" | "signature", transaction?: string, signature?: string }`（型の列挙は schema で、形の検査は Router の関数で）
- server method: **`Method.toServer(mppSolanaChargeMethod, { validate, broadcast })`**（`Method.d.ts:371-383` の `validate` + `broadcast` の形。`verify` は置かない）。**`broadcast` は呼ばれたら throw する**（Router は `broadcastCredential` を呼ばない。走る経路が無いことを試験で確かめる）。
  `validate` は SDK の `validateCredential`（`server/Mppx.js:289-296`。その前に `Challenge.verify` = HMAC `:199`、期限、scope、method の一致）の後に呼ばれる hook で、**`Validation` の全欄**（`challenge`・`credential`・`details: {}`・`intent`・`method`・`request`。`Method.d.ts:100-131`）を返す（構造の検査は SDK の外。§3.3）。
  Tempo と違い `request` hook は置かない（額の単位変換が無い: `amount` は base units のまま HMAC に入る）。`offerOf` は Tempo（`mpp.ts:188-213`）と同じく **SDK が束縛した `request` と offer の値の一致**（amount・currency・recipient・network・decimals・tokenProgram・feePayer=false・externalId）を発行前に確かめる
- `createOffer(request)`: `externalId = base58(randomBytes(16))`（22 文字。Memo の照合の値。HMAC の入力）。`mppx.challenge.solana.charge({ amount, currency: mint, recipient, externalId, methodDetails: { network: "devnet", decimals, tokenProgram, feePayer: false }, expires, scope: routeBinding, meta: { routeBinding, paymentId: <routeId:nowMs:uuid> } })`。
  **`recentBlockhash`・`feePayerKey`・`splits` は出さない**（FR-45）
- `InboundOffer`: `scheme: "solana/charge"`、`network`、`asset: mint`、`amount`、`payTo: recipient`、`maxTimeoutSeconds`、`extra: { challengeNonce: challenge.id, expiresAt, routeBinding, fundsMoveOnCredential: true, challenge: Challenge.serialize(challenge), externalId, decimals, tokenProgram }`。
  `fundsMoveOnCredential: true`（D-29。`src/mcp/tools.ts:139` はこの欄を読む）。**発行する `extra` の鍵の集合は定数 `MPP_SOLANA_ISSUED_EXTRA_KEYS`**（preflight の完全一致に使う）

### 3.3 共通の形 `checkMppSolanaTransaction(bytes, policy, amount, externalId, signerAta)`（FR-47。純粋・同期。`signerAta` は呼び出し側が非同期で導く）

x402 SVM 受信の `checkSvmTransaction`（`x402-svm.ts:154-230`）と同じ手順だが **形が違う**（署名 1 つ、compute budget は各高々 1 つで順序は問わない、source の owner = 署名者）。x402 の関数は変えない。

| # | 検査 | 失敗 |
|---|---|---|
| 1 | `bytes.length ≤ 1232`。`getTransactionDecoder().read` で読み残し無し。署名の数の prefix = **1**、`sig0` が全ゼロでない | `credential_mismatch` |
| 2 | message: version 0、`addressTableLookups` 無し、`header.numSignerAccounts === 1`、`staticAccounts[0]` = 署名者（fee payer）。命令は **2〜4 つ**: 先頭に compute-budget の命令が 0〜2 つ、次に `TransferChecked`、最後に Memo（ATA の作成を含め他は無い） | `credential_mismatch` |
| 3 | compute-budget の命令は discriminator **2（limit）・3（price）をそれぞれ高々 1 つ**（順序はどちらでも。FR-47）。limit は `1..200_000`、price は `0..5_000_000`（`SVM_MAX_*` の定数を共有）。discriminator 1・4 は不可 | `credential_mismatch` |
| 4 | `TransferChecked`（discriminator 12、`policy.tokenProgram`）: `amount`・`decimals` 一致、`mint = policy.mint`、`destination = policy.destinationAta`、`authority = 署名者`、`source = signerAta`（呼び出し側が `findAssociatedTokenPda(mint, 署名者, tokenProgram)` で導いた値。source の owner が署名者であることの確認） | `credential_mismatch` |
| 5 | Memo（program、口座 0、data が UTF-8 で **`externalId` と byte 一致**） | `nonce_mismatch` |
| 6 | **組み直して byte 一致**: `buildSvmTransactionMessage` を `computeBudget: { limit?, price?, order }`（§5.1）付きで呼び、compile した bytes と `messageBytes` を比較（header・口座の並び・data・lookup table 無しがここで一度に決まる） | `credential_mismatch` |
| 7 | `ed25519.verify(sig0, messageBytes, 署名者)` | `credential_mismatch` |

通れば `{ ok: true, signature: base58(sig0), signer, blockhash }`。`署名者 ∈ { policy.payTo, policy.destinationAta, mint, tokenProgram }` は不可（自己支払い・プログラムの口座）。

### 3.4 preflight（同期。FR-46。**封筒と形だけ**）

Tempo 受信の 5 点（`mpp.ts:286-313`）をそのまま: `payload.challengeNonce` = offer の nonce、期限、`accepted.scheme === "solana/charge"`、route binding、`stableJson(accepted) === stableJson(offer)`、wire の中の challenge id = nonce（`embeddedChallengeIdOf` を共有の module に出す）。加えて `payload.credential`（wire）を `Credential.deserialize` し、`payload.type` が `"transaction"`（`transaction` が正準の base64 で復号後 1232 バイト以下）か `"signature"`（base58 64 バイト）であること（他は `credential_mismatch`）。
**構造の検査（§3.3）は preflight では走らせない**: preflight の拒否は journal に残らず（`orchestrator.ts:584-591`）、要件 FR-48 は構造違反を **`verify_failed`**（journal の `source_failed`。`:653-658`）と決めている。ATA の導出も非同期（`x402-svm-startup.ts:153`）。

### 3.5 verify と settle（FR-47）

- **verify（両型。順序は固定）**: (1) **`await mppx.validateCredential(wire, { scope: offer.extra.routeBinding })`**（HMAC・期限・scope・method。Tempo が `mpp.ts:330` で呼ぶのと同じ。失敗 → `isValid: false`。RPC は使わない）。SDK が返した `challenge.id` が offer の nonce と一致。(2) 型ごとに **transaction の bytes を得て**（`transaction` 型は credential から、`signature` 型は下の `getTransaction` から）、decode して `staticAccounts[0]`（署名者）を読み、**`signerAta` を導いてから** §3.3 を掛ける:
  - `transaction` 型: RPC 無し。`isValid: 検査の結果`
  - `signature` 型: `getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "base64" })` を 1 回（`svmFetchJson`、10 秒、64 KiB）。`result === null` → `isValid: false`。`result.transaction[0]` の base64 から署名者と `signerAta` を得て §3.3 に掛け、`signature` が credential の署名と一致、`meta.err === null`、`slot` が正の整数、**`blockTime` が整数で `expiresAt − maxTimeoutSeconds ≤ blockTime ≤ expiresAt`**（= challenge の発行〜期限。`null` は不正。FR-47）。RPC の失敗・形違い・上限超え → throw（core が `source_verify_unavailable`）。検査の不一致 → `isValid: false`（`verify_failed`）
- **settle、`transaction` 型**（**全体の期限 `settleDeadlineMs` 50 秒**。各 RPC の期限は `min(10 秒, 残り)`）:
  1. `consumed.has(signature)` → `rejected`（`source_rejected`）
  2. `sendTransaction([base64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }])` を 1 回
  3. 応答が JSON-RPC の `error` → `getSignatureStatuses([[signature], { searchTransactionHistory: true }])` を 1 回: `settled` → 5、`failed` → `rejected`（`source_rejected`。診断 `mpp_solana_tx_failed_on_chain`）、`pending`・形違い・失敗 → 4。応答が無い（transport・期限）→ 4。応答が `result` = 署名 → 4（署名が一致しなければ `unknown`）
  4. §5.2 の追跡 helper: **期限は `min(全体の期限, 追跡の開始 + 30 秒)`、間隔 2 秒、回数は高々 15**（SR-M1。送出が速くても 25 回にはならない）、`errTerminalAt: "confirmed"`: `settled` → 5、`failed` → `rejected`、期限 → `unknown`（`source_settle_unknown`）
  5. `{ outcome: "settled", txRef: signature }`（core が `source_settled` を書く）
- **settle、`signature` 型**: `consumed.has(signature)` → `rejected`、そうでなければ `settled`（RPC 無し）

### 3.6 結果の表（要件 FR-48 を adapter の段に写す。静的の core）

| 段 | 型 | 事象 | 結果 |
|---|---|---|---|
| preflight | 両方 | 5 点・`type`・形 | `rejected`（`nonce_mismatch`／`credential_mismatch`／`offer_expired`／`offer_mismatch`／`route_binding_mismatch`。journal に残らない。`transaction` 型: Router は送出していない。`signature` 型: **payer は送金済み**で返金は無い = FR-48） |
| verify | 両方 | HMAC・期限・scope（`validateCredential`） | `verify_failed` |
| verify | `transaction` | §3.3 | `verify_failed` |
| verify | `signature` | RPC 不達・形違い・上限 | `source_verify_unavailable` |
| verify | `signature` | `null`・`err`・§3.3・署名・期限外 | `verify_failed` |
| settle | 両方 | 消費済み | `source_rejected` |
| settle | `transaction` | `confirmed` 以上で `err` | `source_rejected` |
| settle | `transaction` | 期限まで `confirmed` が見えない（RPC の error の後を含む） | `source_settle_unknown` |
| settle | 両方 | 記録できた | `settled` |

**動的の core は違う**（`dynamic.ts:618-624`。設計 `docs/dynamic-upstream-design.md` §6.5）: 昇格後の settle の `rejected` は理由を保ったまま **`unknown`** に写す（facilitator／RPC は送金の前後を区別できない、という既存の規則）。本書はこれを変えない。試験は静的・動的で期待値を分ける。

## 4. S-6: `src/adapters/outbound/mpp-solana.ts`

### 4.1 構造

```ts
export function createMppSolanaOutbound(options: {
  network: string;
  upstreams: Record<string, string>;                              // 静的 route
  destinations: Record<string, { payTo: string; asset: string; scheme: string }>;
  capability: SvmSigningCapability;                               // D-19（x402 SVM 送信と同じ）
  transport: GuardedTransport; rpc: { url: string; transport: GuardedTransport };
  operatorAddresses: Set<string>; mint: string; decimals: number; tokenProgram: string;
  dynamic?: { profiles: Record<string, DynamicProfile>; transport: GuardedTransport; denyHosts: readonly string[] };
  now?: () => number; unpaidTimeoutMs?: number /* 10_000 */; paidTimeoutMs?: number /* 45_000 (D-30) */; fetchToSignMs?: number /* 5_000 */; rpcTimeoutMs?: number;
  hooksForTest?: { afterReserve?(); afterSign?(); beforeSend?(); wire?(bytes) };
}): OutboundRail & { startup(): Promise<void>; balanceOf(routeId, asset): Promise<bigint> }
```

- **`estimateFee` は持たない**（§1.4。core は Solana 宛 MPP で呼ばない。持たせないことで「呼べば失敗」が型で見える）
- 静的と動的を 1 つの adapter で（x402 SVM 送信と同じ）。`startup()`・`balanceOf`・ATA・RPC の helper は x402 SVM 送信から **`svm-outbound-common.ts` に括り出して共有**（§5.1。挙動は変えない）

### 4.2 402 の読取と候補の検査（FR-50）

- 読取は Tempo 送信と同じ SDK の経路（`mpp.ts:430-470`）: `Mppx.create({ methods: [Method.toClient(mppSolanaChargeMethod, { createCredential })], fetch: guarded, polyfill: false, maxPaymentRetries: 0 })`、`rawFetch` → 402 → `preparePayment(response, { request: init })` → `prepared.challenges`。本文は捨てる（設計 A §3.3-7）。動的は `parseUpstreamUrl` と拒否ホスト（x402 SVM 送信の `dynamicChallenge` `:620-640` と同じ検査を URL に）
- **view**（Tempo の `viewOf` `mpp.ts:136-180` と同じ形。`id`・`expires` は view に持ち offer には入れない）→ `checkMppSolanaChallenge(view, scope, operators, profile?)`（純粋）:

| # | 検査 | 理由 |
|---|---|---|
| 1 | `method === "solana"`、`intent === "charge"`、`scope === "GET <canonical url>"` | `method`／`scope` |
| 2 | `request` の鍵は `{ amount, currency, recipient, methodDetails, externalId?, description? }` だけ。`methodDetails` の鍵は `{ network, decimals, tokenProgram?, feePayer?, feePayerKey?, recentBlockhash? }` だけ。`splits`・`confidential`・未知の鍵 → 候補外 | `unknown_field` |
| 3 | `currency === mint`（大文字小文字を区別）、`network === "devnet"`、`decimals === 6`、`tokenProgram` があれば表と一致 | `asset`／`network`／`decimals`／`token_program` |
| 4 | `amount` は `AMOUNT_PATTERN`、`> 0`、動的は `≤ maxUpstreamAmount` | `amount` |
| 5 | `recipient` は base58 32 バイト、`∉ operatorAddresses`、`≠ mint`・`≠ tokenProgram`・`≠ Router の鍵`。導出 ATA `≠ Router の ATA` | `pay_to` |
| 6 | `feePayer === true` ∧ `feePayerKey` が base58 32 バイト ∧ `feePayerKey ∉ operatorAddresses ∪ { Router の鍵, Router の ATA, recipient, 宛先 ATA, mint, tokenProgram, System, ComputeBudget, Memo, ATA program }`（SR-M4）。`feePayer === true` で `feePayerKey` 無し・形違い → 候補外。**`feePayer` が無い・`false` → 候補外 `destination_unsupported_mode`**（pull だけ。D-23）。`feePayer: false` で `feePayerKey` あり → 候補外 | `fee_payer`／`mode` |
| 7 | `externalId` があれば string、UTF-8 で 1..256 バイト、制御文字無し（`isValidSvmMemo`）。`description` は読まない | `memo` |
| 8 | `recentBlockhash` があれば base58 32 バイト（読むが使わない。D-24） | `blockhash` |
| 9 | `expires` があれば未来（静的・動的とも。purchase 時は署名の直前と送出の直前にもう一度） | `expired` |

- `DestinationOffer`: `{ scheme: "solana/charge", network, asset: currency, amount, payTo: recipient, extra: { realm, scope, terms, feePayerKey, decimals, tokenProgram, externalId? } }`（`terms` = Tempo と同じ `stableJson({ realm, method, intent, request, meta })`。**`id`・`expires` を含まない**ので、Provider が要求ごとに新しい challenge を出しても承認値は変わらない）。静的は `destinations[routeId]`（payTo・asset・scheme）と一致するものだけ
- 候補の段階（quote）: 動的は宛先 ATA の存在（`getAccountInfo` → `assertAtaAccount`）。静的は起動時に検査済み

### 4.3 `pay(request)`（x402 SVM 送信の `pay` `:666-760` の順序。違いだけ書く）

| # | 段 | 違い |
|---|---|---|
| 1 | 能力の network、保存した offer の再検査（§4.2 を保存した offer に）、`now < deadlineMs`、`reserveMessage` あり | 同じ |
| 2 | 読み直し: **SDK が選んだ `prepared.challenge`**（`createCredential`・`setCredential` はこれに束縛される。`client/Mppx.js:81-133`。`prepared.challenges` から選び直すことはできない）の view が **`terms` と `offerOf(view)` で保存した offer と完全一致**すること（違えば `destination_offer_changed`。Tempo と同じ規則 `mpp.ts:529-540`）。その view の `id`・`expires` を以後の値に。`expires` が過ぎていれば `destination_offer_expired` | 複数の challenge が返っても SDK の選択を照合するだけ（選び直さない） |
| 3 | 宛先 ATA の再確認 | 同じ |
| 4 | `getLatestBlockhash`（**challenge の `recentBlockhash` は使わない**。D-24） | 同じ |
| 5 | 期待値: `feePayer = extra.feePayerKey`、`source = Router の ATA`、`authority = Router の鍵`、`destination`、`mint`、`amount`、`decimals`、**`memo = extra.externalId`（無ければ Memo 命令なし）**、units・price は x402 SVM の定数、`computeOrder: "limit-first"` | `expectedOf` に `memo?: string` の選択肢（§5.1） |
| 6–7 | 組み立て（snapshot）と builder と独立の検査（`checkSvmOutboundMessage`。命令 3 つか 4 つ） | §5.1 |
| 8 | `reserveMessage(messageHashOf(snapshot))` | 同じ |
| 9 | 期限と blockhash の鮮度（署名の直前） | 同じ |
| 10 | 署名（写し）と `verifySvmSignature` | 同じ |
| 11 | wire（署名 2 つ: [0] 空 = fee payer、[1] Router）と `recheckSvmWire` | 同じ |
| 12 | **credential**: `prepared.createCredential()` → client hook は **渡された `challenge.id` が 2 の view の `id` と一致することを確かめ**（違えば throw）、`Credential.serialize({ challenge, payload: { type: "transaction", transaction: base64(wire) } })` を返す（1 回だけ。2 回目は throw）。**返った credential 文字列を `Credential.deserialize` し、`challenge.id` が選んだ id、`payload.type === "transaction"`、`payload.transaction` の bytes が 11 の wire と byte 一致**することを確かめる（hook の出力の改変は wire の再検査では捕まらない。違えば `not_sent` `destination_payload_mismatch`）。`prepared.setCredential(init, credential)`。**送出の直前**: 期限（`destination_deadline`）と **blockhash の経過時間 `now − fetchedAt ≤ sendWithinMs`（定数 10 秒。FR-52。x402 SVM 送信は署名の前だけ `:725-750`）→ `destination_blockhash_stale`**。署名だけでは資金は動かない | `Authorization: Payment <base64url>` は SDK が付ける |
| 13 | 送出 1 回（`paidTimeoutMs` 45 秒、`redirect: "error"`） | 期限は D-30 |
| 14 | 領収（§4.4） | — |

hook の `createCredential` は `pay` の中の closure で **既に組んで検査した wire を返すだけ**（SDK に transaction を組ませない。署名器は SDK に渡さない。SR-M3）。

### 4.4 領収と結果（FR-53）

- `Payment-Receipt` を `Receipt.deserialize`: `status === "success"`、`method === "solana"`、`reference` が base58 64 バイト、**`challengeId` が view の `id` と一致（必須。FR-53）**、`externalId` があれば offer の `externalId` と一致、`payer` 相当の欄があれば Router の鍵と一致（文字列比較）
- **pull の対応づけ**（RPC 1 回、10 秒）: `getTransaction(reference, { commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0 })`。`null` → `unknown`。読めた tx を decode し、(a) `messageBytes` が予約した snapshot と byte 一致、(b) 署名列の [0] = `reference`、[1] = Router の署名（bytes）、(c) `meta.err === null`、(d) `slot` が正の整数、`meta` が object。1 つでも違えば `unknown`（`destination_receipt_unverified`）
- 表（要件 FR-53 のまま。pull の列）: 送出前の失敗 → `not_sent`、送出の例外・期限 → `unknown` `destination_pay_unknown`、領収なしの 4xx／5xx → `unknown` `destination_pay_unknown`、領収なしの 200 → `unknown` `destination_receipt_unverified`、領収の不整合 → `unknown` `destination_receipt_unverified`、整合 ∧ 200 ∧ JSON object ≤ 256 KiB → `paid`（`txRef = reference`、`receiptRef = header`）、整合 ∧ 本文の失敗・非 200 → `paid_no_data`
- 本文の読取は共有の `deliveredBodyOf`（x402 の動的と同じ上限 256 KiB）

### 4.5 `startup()`・`balanceOf`・RPC

x402 SVM 送信と同じ（`:583-640`）: Router の ATA、静的 route の宛先 ATA の検査、運用者の集合に ATA、`getTokenAccountBalance`。method は `getAccountInfo`・`getLatestBlockhash`・`getTokenAccountBalance`・`getTransaction` の 4 つ（SR-M1）。

### 4.6 署名の境界（まとめ）

Router が署名するのは **自分で組み・builder と独立に検査し・hash を予約した message の写しだけ**。SDK（mppx client）には署名器も鍵も渡さない（`createCredential` hook は検査済みの wire を返すだけ）。fee payer の署名は相手（[0] は空のまま送る）。`feePayerKey` は SR-M4 の除外をすべて通る。sabotage: (a) hook が別の bytes を返す → 返った credential の復号と wire の byte 比較（§4.3 の 12）で `not_sent`、(b) 予約を飛ばす → 試験が `destination_reservation_unsupported` を要求、(c) Memo を外す／変える → `checkSvmOutboundMessage` で `not_sent`、(d) `feePayerKey` を Router の鍵にした challenge → 候補外。

## 5. 共有の primitives と helper（x402 の挙動は変えない）

### 5.1 Memo 任意・compute budget の順序（`x402-svm.ts`（受信・送信））

- `buildSvmTransactionMessage(params)`（受信 `:92-113`）に `memo?: string`（`undefined` なら Memo 命令を付けない）と `computeBudget?: { limit?: number; price?: bigint; order: "limit-first" | "price-first" }`（省略時は今の `units`・`microLamports` を limit → price の順で両方。受信の §3.3 は観測した組み合わせで組み直す）。x402 の呼び出し側は今の引数のままなので bytes は変わらない（既存の wire 試験が証拠）
- 送信の `SvmExpected.memo?: string`、`expectedOf` の `memo` の選択肢に「`undefined` = 付けない」を足す（x402 SVM 送信は `extra.memo` か `defaultMemoOf(paymentId)` で**必ず付ける**。変えない）。`expectedStaticAccountsOf`（Memo program は memo があるときだけ）、`compileSvmMessage`、`checkSvmOutboundMessage`（命令 3 つか 4 つ。Memo の有無は期待値どおり）、`assembleSvmWire`・`recheckSvmWire` を memo 任意に。`SVM_INSTRUCTION_COUNT` は x402 受信の定数のまま
- `decodeBase64Strict`・`embeddedChallengeIdOf`（Tempo 受信）を export して共有
- x402 SVM 送信の `startup`・`balanceOf`・`ataOf`・`ataExists`・`rpcResult`・`blockhashOf`・`candidateAtaOf` の ATA 部分を `src/adapters/outbound/svm-outbound-common.ts` に移す（同じ関数を 2 つの adapter が使う。移すだけで挙動は変えない）

### 5.2 追跡の helper（`src/adapters/inbound/svm-follow-up.ts`）

x402 SVM 受信の `followSignature`（`x402-svm.ts:420-460`）を関数に出す: `followSvmSignature({ rpc, signature, routeId, deadlineAt, intervalMs, clock, sleep, errTerminalAt: "any" | "confirmed", searchTransactionHistory: boolean, onDiagnostic })`。x402 受信は `errTerminalAt: "any"`・`searchTransactionHistory: true`（今の `svmSignatureStatusOf` の読み方のまま。既存の試験 `svm-settle-followup.test.ts` が変わらない）。MPP Solana は `errTerminalAt: "confirmed"`（`processed` + `err` は続行）。**回数の上限 `maxPolls`**（MPP Solana は 15。x402 受信は渡さない = 今のまま期限だけ）: loop の各周で `polls += 1` し、`polls > maxPolls` なら期限と同じ扱い（`unknown`）。要求の期限は `svmFollowUpRequestTimeoutOf(残り)` のまま。

## 6. 本番の入口（FR-40・FR-42・FR-55・FR-56）

### 6.1 有効化（`tools/remote-mcp-config.ts:118-128`、`tools/rails-entry.ts:36-66`）

- `RailsActivation` に **`solanaMpp: RailActivation`** を足す。`RAILS_ACTIVATION` の既定は `{ inbound: false, outbound: false }`（G-2″ は無効のまま配備、G-4″ で方向別に `true`）。内部 env `SUBETHA_RAILS_ACTIVATION` の token に **`solana-mpp-in`・`solana-mpp-out`** を足す（`ACTIVATION_TOKENS`。未知・重複は今までどおり起動しない）。`activationToEnv`／`activationFromEnv`／受け入れ用の起動の `--rails` は同じ語
- 1 つの値が決めるもの（今までと同じ 3 か所）: 設定生成、子の env、能力の注入。`railActive`（`:153-154`）に `solanaMpp` を足す。受け入れ用の起動（`rails-acceptance-run.ts`）の `--rails` の語も同じ

### 6.2 鍵と env

| env | 用途 | いつ |
|---|---|---|
| `SUBETHA_MPP_INBOUND_SECRET`（既存） | HMAC（Tempo と共有） | `mppInboundEnabled ∨ solanaMpp.inbound`（**受信の MPP Solana は Tempo の MPP 受信が無効でも要る**。`remote-mcp.ts:150` の転送の条件を広げる） |
| `SUBETHA_SOLANA_RECEIVER`（既存） | 受取 owner（x402 Solana 受信と同じ値） | `solana.inbound ∨ solanaMpp.inbound`（`railsReceiversOf` `rails-entry.ts:51-60` の条件を広げる。鍵ではない）。**設定生成の述語は分ける**: `receiverOf(rails, "solana")`（`remote-mcp-config.ts:170-177`）は x402 の受信（`solana.inbound`）のまま、新しい `solanaMppReceiverOf(rails)` は `solanaMpp.inbound` のときだけ同じ値を返す。受取 owner があるだけで x402 の route（`:411-419`）が出ることはない |
| `SUBETHA_OUTBOUND_SOLANA_KEY`（既存） | 送信の鍵（D-19） | `solana.outbound ∨ solanaMpp.outbound`（`routerProcessCapabilitiesOf` `:127-136`、`railsChildEnvOf` `:160-165`） |
| `SUBETHA_SOLANA_RPC_URL`（既存） | RPC | `solana.* ∨ solanaMpp.*` |
| `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`（新） | Provider D の受取 owner（静的 route を出すときだけ。D-10 と同じ規則） | `solanaMpp.outbound ∧ UPSTREAM_SOL_MPP ≠ ""` |

`svmSigning[SOL]` は `solana.outbound ∨ solanaMpp.outbound` で注入する（同じ能力 1 つ。両方有効でも 1 回）。

### 6.3 route・プロファイル・予算（`routerConfigOf`・`dynamicProfilesOf`）

| 種類 | ID | 受信 | 送信 | 条件 |
|---|---|---|---|---|
| 静的 | `md-x402-eth-snapshot-solmpp` | Solana USDC（MPP） | Base USDC（x402、Provider A） | `solanaMpp.inbound` |
| 静的 | `md-mpp-eth-snapshot-solmpp` | Solana USDC（MPP） | Tempo pathUSD（MPP、Provider B） | `solanaMpp.inbound` |
| 静的 | `md-solmpp-eth-snapshot` | Base USDC（x402） | Solana USDC（MPP、Provider D） | `solanaMpp.outbound ∧ UPSTREAM_SOL_MPP ∧ 受取先` |
| 静的 | `md-solmpp-eth-snapshot-mpp` | Tempo pathUSD（MPP） | Solana USDC（MPP、Provider D） | 上 ∧ `mppInboundEnabled` |
| 動的 | `dyn-solmpp-to-x402`・`dyn-solmpp-to-mpp`・`dyn-solmpp-to-arc`・`dyn-solmpp-to-sol` | Solana USDC（MPP） | Base x402／Tempo MPP／Arc x402／Solana x402 | `solanaMpp.inbound`（Arc・Solana 宛はそのレールの `outbound`、Tempo 宛は `MPP_OUTBOUND_PROFILE_ENABLED` と同じ条件） |
| 動的 | `dyn-x402-to-solmpp`・`dyn-mpp-to-solmpp`・`dyn-arc-to-solmpp`・`dyn-sol-to-solmpp` | Base x402／Tempo MPP／Arc x402／Solana x402 | Solana USDC（MPP） | `solanaMpp.outbound`（MPP 受信のものは `mppInboundEnabled`、Arc・Solana 受信のものはそのレールの `inbound`） |

- 宛先の形: `{ scheme: "solana/charge", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, decimals: 6, tokenProgram }`（`feeAsset`・`maxFee` 無し。§1.4）。手数料は `DYNAMIC_FEE_MPP_OUT` と同じ規則（flat/bps/min）
- 定数 `UPSTREAM_SOL_MPP`（Provider D が立つまで空文字 → 静的の送信 route を出さない）、`ROUTE_*` の 4 つ
- 予算の区分: Solana USDC の区分（`railBuckets`）は `solana.* ∨ solanaMpp.*` のどれかで出す（4 つの向きが同じ 1 区分に合算。FR-43）
- `x402.upstreams` に静的 4 本の URL（受信 2 本は `UPSTREAM`／`UPSTREAM_X402`、送信 2 本は `UPSTREAM_SOL_MPP`）

### 6.4 DEPLOY・CLAUDE.md・README（FR-55）

- `docs/DEPLOY.md` §2d（新）: env（新規は Provider D の受取先と token だけ）、G-1″〜G-4″、Provider D（owner。pay-kit の server を devnet で。`feePayer: true`、`externalId` あり／なしは任意）、rollback
- CLAUDE.md: 一覧の表に静的 4 本、プロファイル 8 本。**MPP Solana の節**: `npm run sign` は署名だけで送出しない（資金は purchase で Router が送出する時点に動く）、sign の直後に purchase（blockhash の寿命）、devnet SOL が要る（手数料は payer）、`fundsMoveOnCredential` は `true` のまま（別の client で `signature` 型を出すなら credential の時点で動く）、**「step 5 が失敗したら支払いは送信済み」を MPP Solana では置き換える**: 「資金は既に動いているかもしれない。`rejected` も `unknown` も未送金の証明ではない。自分で再試行せず人間に報告する」。`wallet:new:solana` の案内の修正

## 7. `npm run sign`（FR-49）

- `tools/sign-dispatch.ts` `classifyOffer`: `scheme === "solana/charge"` ∧ family `svm` ∧ `entry.inbound.includes("mpp")` → `{ kind: "mpp-svm", mint, decimals, tokenProgram, payTo, amount, externalId }`。**署名の前に拒む**: `extra.challenge` 無し、`externalId` 無し・256 バイト超、`extra.decimals`／`tokenProgram` が表と違う、`challenge` の `methodDetails.network !== "devnet"`、`feePayer === true`、`splits` あり、額 > `SIGN_MAX_AMOUNT`、期限切れ。`fundsMoveOnCredential` の検査（`:68`）は `exact` だけのまま
- `tools/svm-mpp-payer.ts`（新。`tools/svm-payer.ts` と同じ形）: `Challenge.deserialize(extra.challenge)` → **challenge の `request` の全欄と offer・表の一致を署名の前に確かめる**（amount・currency = mint・recipient = payTo・externalId、`methodDetails.network === "devnet"`・decimals・tokenProgram が表、`feePayer === false`、`feePayerKey`・`splits`・`recentBlockhash` 無し。封筒の `extra` だけでなく中身も）→ `getLatestBlockhash` 1 回 → `buildSvmTransactionMessage({ feePayer: 自分, source: 自分の ATA, authority: signer, destination: 受取 owner の ATA, mint, amount, decimals, memo: externalId, units: 60_000, microLamports: 1, blockhash, computeOrder: "limit-first" })` → **`signTransactionMessageWithSigners`（全署名）** → `Credential.serialize({ challenge, payload: { type: "transaction", transaction: base64 } })` → 封筒 `{ x402Version: 2, accepted: offer, payload: { challengeNonce, credential } }`（`sign-run.ts:38` と同じ）。**`sendTransaction` を呼ばない**（RPC は 1 method。試験が数える）
- `sign-run.ts` の stderr: 「MPP Solana: signed only, nothing was sent. Funds move when the Router broadcasts at purchase. Call purchase right away (the blockhash expires in about a minute). You need devnet SOL for the fee.」。`wallet:new:solana` の案内を「MPP で払うなら devnet SOL が要る」に

## 8. 試験と fixture（AC-15〜AC-21）

### 8.1 fixture

- **Provider D の fixture** `tests/fixtures/mpp-solana-upstream.ts`（新。Node の http。**本物の `@solana/pay-kit` の server** `createPayKit({ network: "devnet", rpcUrl: <RPC fixture>, accept: ["mpp"], operator: { signer: fee payer の fixture 鍵, feePayer: true, recipient }, mpp: { challengeBindingSecret } })` + `pay.fetch(usd(...), handler)` を `Request`／`Response` に包む）。引数: `--external-id on|off`、`--fee-payer true|false`（`false` は候補外の試験）、`--pay ok|no-receipt|wrong-reference|500|slow:<ms>`（`slow` は RPC fixture の `getSignatureStatuses` の列で確定を遅らせる = 確定待ち 30 秒の再現）、`--after-headers`、`/calls`。受けた credential の `type`・tx の bytes・回数を `seen` に
- **payer の fixture** `tests/fixtures/mpp-solana-payer.ts`（新。**本物の pay-kit の client** `createPayKitClient({ signer, rpcUrl: <RPC fixture>, network: "devnet", accept: ["mpp"] })`。`broadcast` の有無で `transaction`／`signature` 型。credential の wire を Router の封筒に入れる）と、Router の道具 `tools/svm-mpp-payer.ts` を使う payer（AC-19）
- **Solana RPC の fixture** `tests/fixtures/solana-rpc.ts` に足す: `sendTransaction`（受けた tx を decode して署名を返す。`state.sendReply: "ok" | "rpc-error" | "already-processed" | "no-response"`）、`simulateTransaction`（pay-kit の server が呼ぶ。`ok`）、`getTransaction`（`state.transactions`: 署名 → `{ base64 の tx, meta: { err }, slot, blockTime }`。`encoding: "base64"` と **`jsonParsed`**（pay-kit の `verifyOnChain` `index.js:836-918` と allowlist `:1004-1049` が読む: **全命令の `programId`・`program`**（compute budget を含む）、`transferChecked` の `info{ destination, mint, tokenAmount.amount }`、memo の `parsed`。fixture は受けた tx を decode して組む）、`simulateTransaction` は JSON-RPC の **`result` に `{ context: { slot }, value: { err: null, logs: [] } }`**（pay-kit は `data.result.value.err` を見る `:1124-1148`）、`getSignatureStatuses` は既存の列（`searchTransactionHistory` を記録）
- **fee payer の fixture 鍵**: `tests/fixtures/svm-signer-fixture.ts` と同じ seed 生成。pay-kit の `operator.signer` は `@solana/kit` の signer
- **mppx の二重化の確認**: `npm ls mppx` で Router の 0.11.0 と pay-kit 配下の 0.13.x が別に解決されること（SR-M6）。fixture は `@solana/pay-kit` だけを import し、`mppx` は Router のものを使う

### 8.2 試験の置き場

| 層 | ファイル | 内容 |
|---|---|---|
| unit | `tests/unit/mpp-solana-check.test.ts` | §3.3 の各行の肯定・否定（compute の 2 順序、Memo の有無・違い、署名 2 つ、lookup table、version 1、ATA 作成、source の owner 違い、自己支払い）、`mppSolanaSettleStatusOf` |
| unit | `tests/unit/mpp-solana-challenge-check.test.ts` | §4.2 の各行、`terms` が id・expires を含まない、`feePayer: false` → `destination_unsupported_mode` |
| unit | `tests/unit/svm-outbound-message.test.ts`（既存に追加） | Memo 無しの 3 命令の往復、`computeOrder`、x402 の bytes が変わらない |
| unit | `tests/unit/dynamic-fee-exception.test.ts` | §1.4 の 4 か所（設定・quote・store・verify） |
| unit | `tests/unit/remote-mcp-config.test.ts`・`rails-entry.test.ts` | `solanaMpp` の有効化の組み合わせ（AC-16 の表: 出る route／プロファイル、子の env、鍵の転送の条件 `solana.outbound ∨ solanaMpp.outbound`、受取先の条件） |
| wire | `tests/wire/mpp-solana-inbound.test.ts` | pay-kit の client（両型）→ Router の受信 → fixture の RPC。§3.6 の各行（静的と動的の写像の違い）、**HMAC を改竄した challenge（`validateCredential` で落ちる）**、送出の回数と `maxRetries: 0`、`searchTransactionHistory`、**追跡の回数（≤ 15 + error 後の 1）と経過時間の期限**（clock の差し替え）、replay（並行 2 件・再起動後。`consumed` の holder と bind の順序）、`broadcast` hook が呼ばれない、Tempo 受信の wire 試験が変わらない |
| wire | `tests/wire/mpp-solana-outbound.test.ts` | pay-kit の server の fixture → Router の送信。§4.3 の各段の `not_sent`、`externalId` あり／なし、`feePayer: false`、領収の不整合（`reference` 違い・`getTransaction` の `null`／message 不一致／`err`）、`slow` 30 秒 → `paid`、45 秒超 → `unknown`、**複数の challenge を返す server で SDK の選択と承認値の照合**、**hook の出力の改変（別の bytes・別の challenge id）→ `not_sent`**、送出直前の blockhash の経過時間、sabotage (a)〜(d)、中断（子 process + `hooksForTest` で SIGKILL。x402 SVM と同じ） |
| wire | `tests/wire/multirail-integration.test.ts`（既存に追加） | 行列 §7 の 12 本（静的 4・動的 8）の `delivered`。同じ USDC の区分の両レグ（I-4・O-10）で 1 件の上限と通算 |
| wire | `tests/wire/mpp-solana-cli.test.ts` | AC-19: `npm run sign` の往復（道具 → Router の受信 → `settled`）、拒否の各行、RPC の method が 1 つ、鍵を出さない |
| process | `tests/wire/rails-process-entry.test.ts` | 新しい token、受取 owner・鍵・秘密の転送の条件、静的 route の起動時の検査 |
| 中断 | `tests/wire/crash-recovery.test.ts`（既存に追加）か上の wire | AC-20: 受信（`transaction` 型）の送出の前・後・行の後、**受信（`signature` 型）の行の前後**、送信の予約・署名・送出の前。**journal の追記の失敗**（`source_settled` の append が throw → 再起動で `unknown`） |

### 8.3 完了の条件（タスクに写す）

- 既存の suite が緑のまま（x402 SVM・Tempo の wire 試験の bytes と結果が変わらない）。Linux（`node:22-bookworm`）で全部緑。sabotage の表を PR に
- SR-3 と同じ署名の境界の独立レビュー 2 回（送信 adapter の PR と統合の PR）
- AC-17（G-3″）: 要件 §6 のとおり。公開の Router は止めて受け入れ用の起動で
- AC-18（G-4″）: 公開 MCP の一覧と quote（支払わない）

## 9. 新しい依存

- `@solana/pay-kit`（**devDependency**。fixture と試験だけ。`src/`・`tools/` からは import しない = SR-M6。lint で禁止）。pay-kit の依存は `mppx >= 0.8.15` なので、そのままでは Router の 0.11.0 に **dedupe され**、fixture が 0.11.0 の上で動く（spike と違う解決）。**`package.json` の `overrides` で `@solana/pay-kit` 配下の `mppx` を `0.13.2` に固定**し、`npm ls mppx` で Router の 0.11.0 と fixture の 0.13.2 が別に解決されることをタスクで確かめる（U-10 の互換の試験はこの構成で意味を持つ）
- `zod` は足さない: `Method.from` の schema は **`mppx` が export する `z`**（`import { z } from "mppx"`。`dist/index.js:14`。mppx 0.11.0 の zod 4 の mini）。Router の top-level の `zod` 3.25（MCP SDK）には触れない
- 他は既存（`@solana/kit`・`@solana-program/*`・`@noble/curves`・`mppx` 0.11.0）

## 10. 未解決（設計の中で消せないもの）

| # | 内容 | 扱い |
|---|---|---|
| U-10 | mppx 0.11.0 の client（`preparePayment`）と pay-kit（mppx 0.13.x）の server の `WWW-Authenticate` の互換、0.11.0 の server（`validateCredential`）と 0.13.x の client の `Authorization: Payment` の互換 | §8.1 の fixture の最初の試験で固定。違えば D-25（0.13 への更新）を owner に |
| U-12 | pay-kit の server が返す receipt の `payer` 相当の欄の有無 | fixture の wire を記録して §4.4 の照合に写す |
| U-13 | devnet で pay-kit の server の確定待ち（30 秒）が実際にどれだけかかるか（D-30 の 45 秒の妥当性） | G-3″ で測る。足りなければ定数を変える（設定ではない） |
| U-14 | Provider D を Workers で動かせるか | owner の判断（要件 D-26）。Node の http でも AC-17 は満たせる |

## 11. 変更するファイル

| ファイル | 変更 |
|---|---|
| `src/config.ts` | 表の Solana の `inbound`／`outbound`、`parseDynamicProfile` の mpp ∧ svm の分岐（3 欄の禁止）、`pricingPolicy` の条件、`validateRouterConfigAgainstTable` の `tokenProgram` |
| `src/core/dynamic.ts`・`src/core/store.ts`・`src/core/intent.ts`・`src/core/orchestrator.ts` | §1.4 の例外、`settledSourceTxRefs`、`onStoreLoaded` |
| `src/main.ts` | 受信・送信の family の分岐、`svmUsageOf`、`mppInboundChains`、`dynamic.verify` の条件、`consumed` の holder と `startRouter` の bind |
| `src/adapters/inbound/mpp-solana.ts`（新） | §3 |
| `src/adapters/outbound/mpp-solana.ts`（新） | §4 |
| `src/adapters/inbound/x402-svm.ts`・`src/adapters/outbound/x402-svm.ts`・`svm-outbound-common.ts`（新）・`svm-follow-up.ts`（新）・`src/adapters/inbound/mpp.ts` | §5（export と括り出し。挙動は変えない） |
| `tools/remote-mcp-config.ts`・`rails-entry.ts`・`remote-mcp.ts`・`rails-acceptance-run.ts`・`remote-router-process.ts` | §6 |
| `tools/sign-dispatch.ts`・`tools/sign-run.ts`・`tools/sign-payment.ts`・`tools/svm-mpp-payer.ts`（新）・`tools/wallet-new-solana.ts` | §7 |
| `tests/fixtures/*`・`tests/unit/*`・`tests/wire/*` | §8 |
| `package.json` | `@solana/pay-kit`（dev）と `overrides` の `mppx` |
| `docs/DEPLOY.md`・`CLAUDE.md`・`README.md` | §6.4 |

## 13. 実装の記録（設計からの逸脱。各タスクの PR のレビューで決まったもの。M6 で転記）

設計の本文は第 3 版のまま残し、実装が変えた点をここに集める（主担当のタスクと PR）。

| 節 | 設計 | 実装 | 由来 |
|---|---|---|---|
| §3.5 verify | 証拠を残さない | **verify の証拠**: `verify` は `{kind, check, bytes}` を `nonce | sha256(stableJson(offer) + "\0" + wire)` で保持し、offer の期限 + 1 h（`MPP_SOLANA_EVIDENCE_GRACE_MS`）まで（期限だけで掃く。件数の上限は無い）、使う settle が消費する。**`signature` 型の settle は RPC も再判定もしない**（payer は払い済み。再検査で `rejected` = 未払いの宣言にしない）。証拠が無ければ throw（core は `unknown`）。`transaction` 型は証拠が無ければ RPC 無しの同じ検査をやり直す。消費済みの検査は最初 | M3-b（PR #102、Codex 4 回） |
| §2.3 core | — | **settle の直前の期限の再検査**: `orchestrator.ts`（予約の後）と `dynamic.ts`（`source_pending` の後）が `inbound.settle` を呼ぶ直前に承認・offer の期限を見て `approval_expired` で終える（`source_failed { not_sent }`）。証拠の保持の上限はこれで決まる（settle は期限の前にしか呼ばれない） | M3-b |
| §2.3・§3.6 core | — | **資金が動いた credential の写像**: `InboundRail.verify` は `fundsMoved?` を返せる。verify の後に期限の再検査か予算の予約で止まるとき、資金が動いた credential（MPP Solana の `signature` 型、`fundsMoveOnCredential: true` の offer = Tempo の push）は `source_failed { not_sent }` ではなく **`unknown { reason: "source_paid_unsettled" }`**（動的は promotion の後だけ）。Tempo の push の既存の予算の行 3 本がこれで変わった | M5（PR #105） |
| §4.2 | server metadata の scope は必須 | pay-kit 0.13.1 の server は `opaque` を出さない → **scope は任意**（無ければ通す、あれば一致、`terms` に残す）。mppx 0.11.0 の client の `preparePayment` は request を schema で parse しない（未知の欄は残る。`externalId` の欠けは client 側では問題にならない） | M4-a（PR #103） |
| §4.3 | 承認期限と blockhash の年齢 | 署名の前と送出の前に **challenge の `expires` も**見る。`createCredential` の hook は export した純粋な `createCredentialHookOf`。Provider D の fixture はプロセス内（TLS の loopback の後ろの本物の pay-kit の server。応答は後から書き換える）。実時間の試験は `mpp-solana-outbound-timing.test.ts`（≈80 s、変異の表から除外） | M4-b（PR #104） |
| §4.1・SR-M1 | quote 時に 1 回 | **送信の ATA の存在の証拠** `createAtaEvidence`: ATA ごと、最新の quote の challenge の期限 + 1 h まで保持（hit で延長、件数の上限は無い）。purchase 時の 402 の再読取は読まない。`pay` は送出の前に必ず読み直す。x402 SVM 送信の動的の再読取は変えていない（毎回読む） | M5 |
| §3.2・§7 | nonce の形は書いていない | **MPP（Tempo・Solana）の `challengeNonce` は mppx の challenge の id（HMAC の base64url、43 文字）**で、x402 の `0x` の hex ではない。`npm run sign` の共通の nonce の検査（T5、2026-10-07）は hex だけを通していたので、**Tempo の MPP の offer は T5 から M6 まで `npm run sign` で「no well-formed challengeNonce」と拒まれていた**（道具だけの欠陥。Router・adapter は正しい）。M6 で MPP の 2 レールに mppx の id の形を許し、実 adapter の offer で回帰試験を置いた | M6 |
| §7 | 振り分けと payer が別々に検査 | challenge の中身の検査は **1 つの純粋関数 `checkSvmMppChallenge`**（`tools/svm-mpp-payer.ts`）で、`classifyOffer`（鍵の前）と payer（署名の前）の両方が呼ぶ | M6 |
| §6.2 | — | `hostPlanOf` は `solanaMpp.inbound` で `SUBETHA_MPP_INBOUND_SECRET` が無ければ **env の固定文で止まる**（子の Router の `ROUTER_MPP_INBOUND_SECRET is required` より前）。`RailProviders.solanaMpp`・`RailUpstreams.solanaMpp`（Provider D の受取 owner と URL は x402 の Solana の欄と別） | M6 |
| §6.4 | — | CLAUDE.md の「step 5 が失敗したら支払いは送信済み」は Tempo に限り、MPP Solana は「資金は既に動いているかもしれない。`rejected` も `unknown` も未送金の証明ではない。自分で再試行せず報告する」に置き換えた。`wallet:new:solana` は MPP で払うなら devnet SOL が要ると案内する | M6 |

## 12. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版 `23a1481`） | **REJECT**（10 項目: server hook は `validate` + `broadcast`、`validateCredential` の明示の呼び出し、構造の検査は verify に（compute budget は各高々 1 つ）、追跡の予算と `blockTime` の窓、store の bind と受信の `startup`、SDK の `prepared.challenge` の照合と hook の出力の再検査、`assertDynamicMppCapability` と purchase の cap の検査、受取 owner の述語、試験の追加と fixture の `jsonParsed`、`z` と `mppx` の解決）。第 2 版で反映 |
| 1r | 2026-10-08 | `gpt-6-astra`（readback。第 2 版 `c5eb989`） | **REJECT**（残り 1: `source_settled` の追記の失敗は FR-48 の `unknown` 応答と一致しない → core の try/catch を設計に。新しい不整合 3: `signature` 型の署名者の取得順、§3.6 の preflight の既払、helper の回数の上限、simulate の `result`）。第 3 版で反映 |
| 2r | 2026-10-08 | `gpt-6-astra`（readback。第 3 版 `8501e15`） | **APPROVE WITH CHANGES**（1 点: 追記の失敗の後の再起動は行の有無で `unknown` か `paid_undelivered`。反映済み）。core の変更は妥当で最小、再送禁止は維持、3 点の不整合は解消 |
