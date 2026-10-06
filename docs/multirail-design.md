# 設計: Arc と Solana で払う（S-1・S-2。第 1 版、2026-10-06）

> 要件は `multirail-requirements.md`（owner の決定 §0、確認の結果 §2.5）。本書は **S-1（Arc の USDC で払って既存の上流に届く）** と **S-2（Solana の USDC で払って既存の上流に届く）** の設計。
> S-3・S-4（送信）は別紙。原則は既存の設計（`dynamic-upstream-design.md`・`ssrf-*`）を継ぐ: core はレールの port 越しにだけ外へ出る、署名・検査の境界は確かめた値だけで組む、
> 外への接続は SSRF 防御 A の transport、鍵は `tools/` だけが読む、testnet だけ。

## 0. 一枚で

| | S-1 Arc | S-2 Solana |
|---|---|---|
| 受信 adapter | 既存の `createX402Inbound` に **facilitator の種類**（素の x402 ／ Circle）と **売り手証明の能力**を足す | 新しい `createX402SvmInbound`。facilitator は x402.org（SVM `exact`） |
| 受取先 | Arc 上の**証明専用の受取鍵**のアドレス（`0x`） | Router の Solana 鍵の **ATA**（base58）。実行時に署名しない |
| Router が自分で確かめること | 既存の preflight（nonce・期限・束縛・offer の完全一致）＋ EIP-3009 の authorization の束縛（既存の `bindAuthorizationNonce`） | 既存の preflight ＋ **transaction の復号と命令の照合**（§5.3） |
| 新しい外部接続 | Circle の facilitator（`/verify`・`/settle`・`/status`） | x402.org の facilitator（既存のホスト）、起動時だけ Solana の RPC（ATA の検査） |
| 新しい鍵 | 証明専用の受取鍵（EIP-712 `SellerRequest` にだけ署名） | 無し（受取先の owner の公開鍵だけ） |
| 呼び出し側の道具 | `npm run sign` が network から chainId と domain を引く | `npm run sign` が SVM の transaction を組んで部分署名（新規 `tools/svm-payer.ts`） |

## 1. network の表（要件 FR-3）

設定の権威として `src/config.ts` に**列挙の表**を置く（env からは変えられない。本番の入口の方針と同じ）:

```ts
export interface KnownNetwork {
  readonly network: string;                 // CAIP-2
  readonly family: "evm" | "svm";
  readonly assets: readonly {
    readonly id: string;                    // EVM: 0x アドレス（小文字で比較）、SVM: mint（base58、大文字小文字を保つ）
    readonly decimals: number;
    readonly domain?: { name: string; version: string };   // EVM の EIP-712 domain
    readonly tokenProgram?: string;          // SVM
  }[];
}
KNOWN_NETWORKS = [
  { network: "eip155:84532",   family: "evm", assets: [{ id: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, domain: { name: "USDC", version: "2" } }] },
  { network: "eip155:42431",   family: "evm", assets: [{ id: "0x20c0000000000000000000000000000000000000", decimals: 6 }] },        // Tempo pathUSD（MPP。domain 無し）
  { network: "eip155:5042002", family: "evm", assets: [{ id: "0x3600000000000000000000000000000000000000", decimals: 6, domain: { name: "USDC", version: "2" } }] },
  { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", family: "svm", assets: [{ id: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }] },
]
```

- `parseRouterConfig` は route・プロファイルの `source`／`destination` の `network`・`asset`・`decimals` を表と照合し、違えば `config_invalid`。`payTo` の形は family で分ける
  （evm: `0x` 40 hex、svm: base58 32〜44 文字で decode して 32 バイト）。既存の設定はすべて表に合う（回帰なし）
- 受信レールと family の組: `sourceRail: "x402"` は evm／svm とも可、`sourceRail: "mpp"` は evm（Tempo）だけ、`rail: "mpp"` は evm だけ、`rail: "x402"` は第 1 版では evm だけ（S-4 で svm）
- 資産の比較は family で分ける: evm は小文字化して比較（既存）、svm はそのまま。`src/core/dynamic.ts:631` の小文字化は `assetKeyOf(network, asset)` に置き換える
- Arc のネイティブ USDC（18 桁）は表に無いので設定できない（FR-7）。桁 18 を書けば表と違って落ちる

## 2. facilitator を network ごとに（FR-1）

`RealRailsConfig.x402InboundFacilitators: Readonly<Record<network, { url: string; kind: "x402" | "circle" }>>`:

- env: 既存の `ROUTER_X402_INBOUND_FACILITATOR_URL` は **`eip155:84532` の既定**として残す（互換）。追加は `ROUTER_X402_INBOUND_FACILITATORS` =
  `eip155:5042002=circle:https://api.circle.com/v1/facilitator/x402,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1=x402:https://www.x402.org/facilitator`
  （`network=kind:url` をカンマ区切り。URL に `@`・`?` を含むものは拒否——API key を URL に入れさせない）
- 起動時: `sourceRail: "x402"` の route／プロファイルの network ごとに facilitator があること。無ければ `config_invalid`
- すべての facilitator のホストを拒否ホストと `dependencyUrls` に入れる（既存の `denyHostsOf` の入力に足す）

## 3. 能力の注入（`RouterCapabilities`）

```ts
readonly sellerProofs?: Readonly<Record<network, SellerProofCapability>>;   // S-1。Circle の facilitator を使う network に必須
readonly svmReceivers?: Readonly<Record<network, { readonly owner: string }>>;  // S-2。受取先の owner（公開鍵）。鍵は要らない
```

- `SellerProofCapability = { address: string; signSellerRequest(request: SellerRequest): Promise<Hex> }`。`tools/real-seller-proof-capability.ts` が env `SUBETHA_ARC_RECEIVER_KEY` から
  作る。**この能力は `SellerRequest` 型以外に署名しない**: 引数は構造化した request で、能力の中で EIP-712 の型を固定し、`purpose ∈ {verify, settle, status}`、`method === "POST"|"GET"`、
  `network` が表にある、`payTo === address`、`expiresAt − issuedAt ≤ 300`、`issuedAt ≤ now + 30` を確かめてから署名する。それ以外の typed data の口は持たない
  （`signTypedData` を公開しない。EIP-3009 の authorization にはこの鍵で署名できない）
- 起動時: Circle を使う network の route／プロファイルの `source.payTo` が `sellerProofs[network].address` と一致すること。違えば起動しない
- `svmReceivers[network].owner` から ATA を導き（`findAssociatedTokenPda(owner, mint, tokenProgram)`）、route／プロファイルの `source.payTo` と一致すること。
  **起動時に guarded transport で RPC に 1 回**（`getAccountInfo` jsonParsed）: 口座が存在し、`owner === owner`、`mint === 表の mint`、program が表の token program。違えば起動しない。
  RPC の URL は env `SUBETHA_SOLANA_RPC_URL`（既定 `https://api.devnet.solana.com`）、ホストは拒否ホストと `dependencyUrls` に入れる。quote・purchase の中では RPC に出ない（FR-18）

## 4. S-1: Arc の受信（`createX402Inbound` の拡張）

### 4.1 変更点

| 項目 | 今 | 変更 |
|---|---|---|
| `assetDomain` | 既定 USDC/2 | 表から渡す（network・asset で引く） |
| requirements の `extra` | `name`・`version`・`challengeNonce`・`expiresAt`・`routeBinding`・`fundsMoveOnCredential` | Circle のときは **`assetTransferMethod: "eip3009"`** を足す。発行 extra のキー集合（`ISSUED_EXTRA_KEYS`）は facilitator の種類ごとに持ち、preflight の「未知キー拒否」はその集合で |
| 要求のヘッダ | `content-type` だけ | Circle のときは `Facilitator-Seller-Proof`（§4.2）。API key は使わない（D-8） |
| settle の判定 | `success === true` ＋ `network` 一致 ＋ `transaction` 非空 → settled | 同じ。加えて Circle の `success: false, errorReason: "settlement_pending"`（待ち窓を超えた）は **`unknown`**（`source_settle_unknown`）。`/status` の polling は**第 1 版では入れない**（§8 の未解決）。`maxTimeoutSeconds` は Circle が待つ窓なので、requirements には**別の値**（`settleWaitSeconds`、既定 30）を入れる——offer の `maxTimeoutSeconds`（120）をそのまま渡すと settle が最大 120 秒待ち、購入の予算（120 秒）を食い潰す |
| 400 系 | `rejected` | 同じ。`403 registration_required`（trial の枠切れ）も `rejected`／`source_rejected`（運用者向けの診断に `facilitator_trial_exhausted` を出す） |
| 409（idempotency） | — | Router は `payment-identifier` 拡張を使わない（第 1 版）。409 は `unknown` |

### 4.2 売り手証明の作り方

```
body      = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements })   // 1 度だけ直列化し、この bytes をそのまま送る
message   = { purpose, method: "POST", bodyHash: keccak256(utf8(body)), network, payTo, nonce: random32, issuedAt: now, expiresAt: now + 60 }
signature = capability.signSellerRequest(message)                                      // domain { name: "Circle Facilitator Seller Request", version: "1", chainId }
header    = base64url(JSON.stringify({ version: 1, signature, network, payTo, nonce, issuedAt, expiresAt }))
```

- `purpose` は呼ぶ endpoint と同じ（`verify`／`settle`）。nonce は要求ごとに新しく、`(network, payTo, purpose)` で一意（CSPRNG 32 バイト）
- 時刻は `now()`（core と同じ時計）。`expiresAt − issuedAt = 60 秒`（Circle の上限 5 分の内側、要求の期限 10 秒の外側）
- 証明の失敗（能力が拒む・署名できない）は、verify なら `isValid: false`、settle なら**要求を出す前**なので `rejected`（`source_rejected`）

### 4.3 試験の fixture

`tests/fixtures/circle-facilitator.ts`: loopback の facilitator で、**売り手証明を検証する**（header を decode し、EIP-712 で recover して `payTo` と一致、`bodyHash` が受けた body と一致、
`purpose` が endpoint と一致、期限の規則）。証明が無い・違う・古い要求は 401。`assetTransferMethod` を要求する。settle は `success/transaction/network/payer` と
`extensions.settlement-status` を返し、`settlement_pending`・`registration_required`・409 を状態で切り替えられる。

## 5. S-2: Solana の受信（新規 `src/adapters/inbound/x402-svm.ts`）

### 5.1 offer

```
scheme: "exact", network: "solana:Et…", asset: <mint>, amount, payTo: <Router の ATA>, maxTimeoutSeconds,
extra: { feePayer: <起動時に固定>, memo: challengeNonce, challengeNonce, expiresAt, routeBinding, fundsMoveOnCredential: false }
```

- `extra.memo = challengeNonce`（spec の seller-defined memo。呼び出し側はこれを Memo 命令に入れる。facilitator も照合する）
- `feePayer` は起動時に facilitator の `/supported` から読む（`kinds[].network === この network && scheme === "exact"` の `extra.feePayer`）。**1 つに固定**し、quote ごとに読まない。
  `/supported` が複数の署名者を返す形（`signers`）でも、固定した 1 つだけを使う（facilitator が `fee_payer_not_managed_by_facilitator` を返せば verify が落ちるだけ）

### 5.2 credential

`payload: { challengeNonce, transaction: <base64 の部分署名 versioned transaction> }`。`accepted` は offer の完全一致（既存の preflight）。

### 5.3 preflight（Router が自分で確かめる。FR-16）

既存の検査（nonce・期限・`accepted` の完全一致・未知キー）に加えて、facilitator に渡す前に:

| # | 検査 | 失敗の理由 |
|---|---|---|
| 1 | `transaction` は base64 で、decode 後 **≤ 1,232 バイト**（Solana の transaction の上限） | `credential_mismatch` |
| 2 | `@solana/kit` の `getTransactionDecoder` で復号し、`getCompiledTransactionMessageDecoder` → message。**address lookup table を使っていない**（`addressTableLookups` が空）。version は legacy か 0 | `credential_mismatch` |
| 3 | `staticAccounts[0]`（fee payer）= 固定した `feePayer`。署名者の数 = 2（fee payer と authority）。**fee payer の署名の枠は未署名**（全ゼロ）、authority の署名は 64 バイトの非ゼロ | `credential_mismatch` |
| 4 | `decompileTransactionMessage` の命令が **3〜4 個**で、順に: ComputeBudget `SetComputeUnitLimit`、ComputeBudget `SetComputeUnitPrice`（単価 ≤ 5 lamports/CU = 5,000,000 microlamports）、`TransferChecked`（表の token program）、Memo（`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`）。それ以外の program・順・個数は拒否。facilitator は 3〜6 個を許すが Router は**自分が発行した形だけ**を通す | `credential_mismatch` |
| 5 | `TransferChecked`: `destination === Router の ATA`、`mint === 表の mint`、`decimals === 表の桁`、`amount === offer.amount`、`authority === 署名者`、`authority !== feePayer`、source の口座が fee payer でない | `credential_mismatch` |
| 6 | Memo のデータ（UTF-8）`=== challengeNonce` | `nonce_mismatch` |
| 7 | 同じ `transaction`（bytes の sha256）を同じ quote に 2 度出す／別の quote に出す: 既存の nonce の規則（quoteId = challengeNonce）で止まる。Memo が nonce なので別の quote には合わない | `nonce_mismatch` |

復号は `@solana/kit` の純粋な関数だけ（ネットワークに出ない）。復号の例外はすべて `credential_mismatch`。

### 5.4 verify／settle

既存の adapter と同じ `post("/verify" | "/settle", { x402Version: 2, paymentPayload: { x402Version, scheme, network, accepted, payload: { transaction } }, paymentRequirements })`。
`payload` から `challengeNonce` は**外して**送る（facilitator は未知の欄を無視するはずだが、送る必要が無い）。settle の成功: `success === true`、`network` 一致、
`transaction` が **base58 で decode して 64 バイト**（SVM の signature）。違えば `unknown`。

### 5.5 呼び出し側の道具（`tools/svm-payer.ts`、`npm run sign` から）

- 鍵: env `SOLANA_PAYER_PRIVATE_KEY`（base58 の 64 バイト、または hex の 32 バイトの seed）。`npm run wallet:new:solana` で作る（`tools/wallet-new-solana.ts`）
- 組み立て: `@x402/svm` の `ExactSvmScheme`（client）に `toClientSvmSigner(keypair)` を渡し、`createPaymentPayload(2, requirements)` を呼ぶ。requirements は **Router の offer から**
  組む（`payTo`・`asset`・`amount`・`extra.feePayer`・`extra.memo`）。SDK は RPC（devnet、`SOLANA_RPC_URL` 既定 `api.devnet.solana.com`）から blockhash を取る。**署名だけで資金は動かない**
  （fee payer が送信する）——x402/EVM と同じ開示
- 署名の前に拒否: network が表に無い、mint・decimals が表と違う、額が上限（20,000）超、offer の期限切れ、`feePayer` が無い
- 出力は既存と同じ封筒（`x402Version`・`accepted`・`payload{ challengeNonce, transaction }`）の base64

### 5.6 試験の fixture

`tests/fixtures/svm-facilitator.ts`: loopback の facilitator。`/supported` で feePayer を返し、`/verify`・`/settle` で transaction を復号して **§5.3 と同じ検査**を行い、settle は
fee payer の鍵で署名して 64 バイトの signature を返す（チェーンには出さない）。試験の payer は `@solana/kit` で transaction を組む（`tests/fixtures/svm-payer.ts`。
ComputeBudget・TransferChecked・Memo。改変の口: 宛先・額・mint・命令の追加・memo・fee payer・lookup table）。ATA の検査の RPC は `tests/fixtures/solana-rpc.ts`（`getAccountInfo` だけ）。

## 6. `npm run sign` の一般化（SR-7）

```
offer.scheme === "tempo/charge" → MPP（既存）
offer.scheme === "exact" && network が evm   → x402-payer（chainId = 表の network から、domain = offer.extra）
offer.scheme === "exact" && network が svm   → svm-payer
それ以外 → 拒否
```

受信の上限は **20,000**（D-7）。表に無い network・資産・桁・domain・mint、失効した offer、形の違う offer は署名の前に拒否。MPP の「署名で資金が動く」開示と承認 → 署名の順は変えない。

## 7. 本番の入口（`tools/remote-mcp-config.ts`・`tools/remote-router-process.ts`）

- 静的 route（D-6）: `md-mpp-eth-snapshot-arc`（Arc USDC 10,000 → Provider B/MPP）、`md-x402-eth-snapshot-sol`（Solana USDC 10,000 → Provider A/x402）
- 動的プロファイル: `dyn-arc-to-mpp`、`dyn-arc-to-x402`、`dyn-sol-to-x402`、`dyn-sol-to-mpp`（par 1:1、手数料は既存の規則: x402 送信は定額 1,000、MPP 送信はガス代連動）
- 予算: 静的・動的とも `(eip155:5042002, 0x3600…)` と `(solana:Et…, 4zMM…)` の区分を足す（上限は D-7 の桁）
- env: `ROUTER_X402_INBOUND_FACILITATORS`、`SUBETHA_ARC_RECEIVER_KEY`（証明専用。受取先はその address）、`SUBETHA_SOLANA_RECEIVER`（owner の公開鍵。ATA は起動時に導く）、`SUBETHA_SOLANA_RPC_URL`
- 登録は `ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` の定数で（G-4 と同じ gate。初期値 `false`、受け入れ後に `true`）

## 8. 未解決（実装の中で確かめる）

| # | 事項 | 扱い |
|---|---|---|
| U-1 | Circle の `/settle` が待ち窓の中で `success: true` を返す割合。`settlement_pending` が多ければ `/status` の bounded な polling（purpose `status`）を足す | AC-1 の試行で測る。第 1 版は `unknown` |
| U-2 | x402.org の SVM `/verify` が §5.3 の形（ComputeBudget 2 ＋ TransferChecked ＋ Memo）を受理すること。`smartWalletSupported` は使わない | 使い捨ての ed25519 鍵と devnet の USDC（faucet.circle.com）で `/verify` を実行（settle はしない）。実装の最初のタスク |
| U-3 | `@solana/kit` の復号 API の正確な名前と、lookup table の有無の判定 | 実装で固定し、fixture で試験 |
| U-4 | Arc の `maxTimeoutSeconds` と offer の期限の関係（Circle は requirements の値を待ち窓に使う） | §4.1 の `settleWaitSeconds` で分離。試行で確認 |

## 9. 変更するファイル（見込み）

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `KNOWN_NETWORKS`・`assetKeyOf`、route／プロファイルの表との照合、`payTo` の family 別の検査、`x402InboundFacilitators` の env |
| `src/core/dynamic.ts` | 残高の区分の鍵を `assetKeyOf` に |
| `src/adapters/inbound/x402.ts` | facilitator の種類、`assetTransferMethod`、売り手証明、`settleWaitSeconds`、`settlement_pending` → unknown |
| `src/adapters/inbound/x402-svm.ts`（新規） | §5 |
| `src/ports/inbound.ts`・`src/main.ts` | `SellerProofCapability`・`svmReceivers`、network ごとの facilitator と adapter の選択、起動時の ATA の検査、拒否ホスト |
| `src/mcp/tools.ts`・`src/client` | network の表示（family で桁・アドレスの形）、payer interface の chainId → network |
| `tools/sign-payment.ts`・`tools/svm-payer.ts`（新規）・`tools/wallet-new-solana.ts`（新規）・`tools/real-seller-proof-capability.ts`（新規）・`tools/remote-*.ts` | §5.5・§6・§7 |
| `package.json` | `@x402/{core,evm,fetch}` 2.28.0、`@x402/svm` 2.28.0、`@solana/kit`（固定版） |
| `tests/fixtures/{circle-facilitator,svm-facilitator,svm-payer,solana-rpc}.ts`、unit・wire・統合の試験 | §4.3・§5.6、AC-3〜AC-7 の否定の試験、sabotage |
| docs | DEPLOY §2c（Arc・Solana の有効化の条件と手順）、README／CLAUDE.md（英語の手順）、ENGINEERING |

## 10. 独立レビューの記録

| # | 日付 | レビュア | 結果 | 反映 |
|---|---|---|---|---|
