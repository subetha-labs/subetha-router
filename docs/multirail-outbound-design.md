# 設計: Arc と Solana の Provider に払う（S-3・S-4。第 1 版、2026-10-07）

> 要件は `multirail-outbound-requirements.md`（owner の決定 §0、FR-22〜FR-38、AC-8〜AC-14、V-6〜V-13）。本書は **S-3（Arc の Provider に払う）** と **S-4（Solana の Provider に払う）** の設計。
> 受信の設計（`multirail-design.md`）と動的上流の設計（`dynamic-upstream-design.md` §3.3 の署名の境界）の原則を継ぐ: core はレールの port 越しにだけ外へ出る、署名・検査の境界は確かめた値だけで組む、
> `src/` の外への接続はすべて SSRF 防御 A の transport、鍵は `tools/` だけが env から読む、testnet だけ。調べた基準は `main` の `f1897bd`（file:line は目安）。

## 0. 一枚で

| 項 | S-3（Arc） | S-4（Solana） |
|---|---|---|
| 新しい adapter | **無し**。既存の x402 送信（静的 `x402.ts`・動的 `x402-dynamic.ts`）を **network ごとに 1 つずつ**作る。静的の Arc は **組み直しの署名器**で署名する（§3.2） | **`src/adapters/outbound/x402-svm.ts`**（新）。offer の検査・ATA・blockhash・組み立て・hash の予約・署名・raw の再検査・送出・領収（§4） |
| 能力 | `evmSigning` を network ごとに（`evmSigningByNetwork`）。Arc は Base と**同じ鍵**を別の札で（D-11） | `svmSigning`（新。ed25519。**message の bytes に署名するだけ**の署名器） |
| 合成 | 送信レールの鍵を **`(rail, network)`** に（§2.2） | 同左 |
| 表 | `outbound: ["x402"]` | 同左＋ `tokenProgram` の照合 |
| 設定 | 静的 route・動的プロファイルは今の形（`tokenDomain` = USDC/2） | 動的プロファイルの `destination` に `tokenDomain` の代わりに `decimals`・（任意の）`tokenProgram` |
| RPC | 無し（EIP-3009 は offline） | Solana RPC（受信と同じ guarded transport）: ATA・blockhash・残高 |
| core の変更 | `PayRequest.deadlineMs`（FR-36）、運用者の集合の注入（FR-38）、静的 route の残高の hook（D-15） | 同左＋ **message の hash の予約**（`PayRequest.reserveMessage`、journal の行 `destination_message_reserved`。FR-37） |
| 本番の入口 | `RAILS_ACTIVATION` を方向別に拡張。route `md-arc-eth-snapshot`、プロファイル `dyn-x402-to-arc`・`dyn-mpp-to-arc` | route `md-sol-eth-snapshot-mpp`、プロファイル `dyn-x402-to-sol`・`dyn-mpp-to-sol`、鍵 `SUBETHA_OUTBOUND_SOLANA_KEY` |

**作る順**: §1（表・設定）→ §2（能力と合成、core の port の拡張）→ §3（Arc）→ 受け入れ（AC-8・AC-13）→ §4（Solana）→ 受け入れ（AC-9・AC-14）。有効化はレールごと（D-13）。

## 1. network の表と設定

### 1.1 表（`src/config.ts` `KNOWN_NETWORKS`）

- Arc `eip155:5042002`: `outbound: ["x402"]`（`:66`）。Solana `solana:EtWT…`: `outbound: ["x402"]`（`:75`）。他は変えない
- `TermsToValidate`（`:130-138`）に `tokenProgram?: string` を足す。`validateTermsAgainstTable`（`:145-173`）: family が `svm` のとき、`tokenProgram` が渡されれば表の `tokenProgram` と一致を要求、
  `tokenDomain` が渡されれば拒否（SVM に domain は無い）。family が `evm` のとき `tokenProgram` が渡されれば拒否
- `validateRouterConfigAgainstTable`（`:891-914`）: 動的プロファイルの送信レグに `tokenProgram` を渡す。静的 route の送信レグは今のまま（network・向き・asset・payTo の形。`isWellFormedPayTo` は SVM の base58 32 バイトを既に扱う `:109-120`）

### 1.2 動的プロファイル（`parseDynamicProfile` `:698-810`）

- `rail: "x402"` の分岐（`:735-740`）を family で分ける: **evm** → `tokenDomain` 必須（今のまま）。**svm** → `tokenDomain` は禁止、`decimals` 必須、`tokenProgram` は任意（文字列。表と照合）。
  `DynamicProfile.destination`（`:236-276`）に `tokenProgram?: string` を足す
- `mint` という欄は作らない。**`asset` が mint**（受信のプロファイルの `source.asset` と同じ約束）
- 本番の生成（`tools/remote-mcp-config.ts` `dynamicProfilesOf`）は §6.3

### 1.3 静的 route

- 形は変えない（`DestinationAllow`: scheme・network・asset・payTo `:192-197`）。Solana 宛は `payTo` = Provider の **owner の公開鍵**（base58 32 バイト。ATA ではない。受信の設計 §5.1 と同じ約束）
- 上流の URL は `x402.upstreams[routeId]`（今のまま）

## 2. 能力と合成（FR-27・FR-38・FR-36・D-15）

### 2.1 能力の形（`src/ports/outbound.ts`、`src/main.ts` `RouterCapabilities`）

```ts
// 既存: evmSigning?: EvmSigningCapability（Base）。残す（既存の試験・入口の互換）。
// 追加:
evmSigningByNetwork?: Readonly<Record<string, EvmSigningCapability>>;   // key = network。evmSigning と重複する network は起動時に拒否
svmSigning?: Readonly<Record<string, SvmSigningCapability>>;            // key = network（solana:…）

export interface SvmSigningCapability {
  readonly network: string;
  readonly address: string;                         // base58 32 バイト（Router の送信の公開鍵）
  readonly sign: (messageBytes: Uint8Array) => Promise<Uint8Array>;   // ed25519。64 バイト。message の bytes 以外は受け取らない
  readonly kind: "real-key" | "non-signing-fixture";
}
```

- **署名器が受け取るのは compile 済みの message の bytes だけ**（SDK の `TransactionSigner` を渡さない）。adapter が wire の transaction を自分で組み、署名を [1] に入れる（§4.6）。
  署名器の実装は `tools/real-svm-capability.ts`（§6.4）。受信の受取 owner の鍵と別（D-11）
- 残高（D-15）は能力ではなく **rail（adapter）** が持つ（RPC と transport は adapter にある）: `OutboundRail.balanceOf?(routeId: string, asset: string): Promise<bigint>`。EVM の rail は持たない（見送り）

### 2.2 合成（`src/main.ts` `composeRails` `:370-413`、`railByRoute` `:156-197`）

- 使う送信の組 = `{ rail: route.rail ?? "x402", network: route.destination.network }` と `{ rail: profile.rail, network: profile.destination.network }` の集合。鍵は `` `${rail}:${network}` ``
- 組ごとに adapter を 1 つ作る:
  - `x402` × evm の network → `createX402Outbound({ upstreams: その network の route だけ, capability: evmByNetwork[network], transport, rebuildSignatures: network !== "eip155:84532", operatorAddresses, dynamic: その network のプロファイルだけ })`
    （`upstreamsFor`・`dynamicOptionsFor` を `(rail, network)` で絞る）
  - `x402` × svm の network → `createX402SvmOutbound({ upstreams, capability: svmSigning[network], transport, rpc: { url: solanaRpcUrl, transport: rpcTransport }, operatorAddresses, dynamic, now })`
  - `mpp` × Tempo → 今のまま（`createMppOutbound`）
- **起動時の検査**（fail closed、`SignerNotAuthorizedError`）: 組に能力が無い／同じ network が `evmSigning` と `evmSigningByNetwork` の両方にある／能力の `network` の family が組の family と合わない／`svmSigning` の `address` が base58 32 バイトでない
- `railByRoute` の Map は routeId／profileId → **その組の adapter**（今は rail 名だけ `:163`・`:171`）。`estimateFee`・`balanceOf` も同じ Map で引く
- **Solana RPC**（`:349-350`）: `usesSvm = SVM の受信 ∨ SVM の送信` のとき `solanaRpcUrl` を決め、拒否ホストと依存先に入れる（今は受信だけ）。送信の adapter の RPC transport は受信の起動時の検査と同じ作り（`:479`: guarded、loopback 不可、DNS 期限 3 秒・同時 4）。
  `createGuardedTransport` の呼び出しを `svmRpcTransportOf(staticHooks, report)` に括り出して受信・送信で共有する

### 2.3 運用者の集合（FR-38）

`composeRails` が起動時に 1 度作り、全送信 adapter に `operatorAddresses: readonly string[]` として渡す（network ごとに分けず、形で見分けられる文字列の集合。EVM は小文字化して比較、SVM はそのまま）:

- (a) `sourceRail` が `x402`／`mpp` の全 route／プロファイルの `source.payTo`
- (b) 注入された送信能力の公開アドレス: `evmSigning.signer.address`、`evmSigningByNetwork[*].signer.address`、`mppTempo.account.address`、`svmSigning[*].address`
- (c) (a)(b) の SVM のアドレス × 表の SVM の mint・token program から導いた ATA（`findAssociatedTokenPda`）

静的 route の `destination.payTo` は入れない。adapter 側の照合: x402 動的は既存の `operatorAddressesOf`（`x402-dynamic.ts:362`）を **この集合＋自分の署名者**に置き換える。x402 静的（`x402.ts`）は今 運用者の照合が無いので `pay` の前に `approved.payTo ∉ 集合` を足す（`not_sent`、`destination_offer_not_allowed`）。SVM は §4.2 の検査に含める

### 2.4 core の port の拡張（`src/ports/outbound.ts`、`src/core/orchestrator.ts` `deliver` `:756-764`）

```ts
export interface PayRequest {
  // 既存: routeId, offer, paymentId, attempt, target?, maxFee?
  readonly deadlineMs: number;   // FR-36: intent.approvalDeadlineMs（static）／dynamic の期限（同じ欄）。adapter は署名の直前と送出の直前に now < deadlineMs を見る
  readonly reserveMessage?: (messageHash: string) => Promise<"reserved" | "collision" | "unavailable">;   // FR-37。SVM の rail だけが使う
}
```

- `deliver()` が `PayRequest` を組むとき `deadlineMs = intent.approvalDeadlineMs`（`src/core/intent.ts:157`。動的も同じ欄に入っている）と、`reserveMessage = (hash) => store.reserveMessage(paymentId, hash)` を付ける
- EVM の rail は `deadlineMs` だけ使う（署名の直前・送出の直前に見る。既存の Base にも付く——**Base の挙動の変更は「期限切れなら `not_sent`」の追加だけ**。今は core が verify の後に期限を見ている `:622-636` ので、実質は送信の中の時間だけが新しく守られる）

### 2.5 message の hash の予約（FR-37。`src/core/store.ts` `IntentStore`）

- 新しい journal の event **`destination_message_reserved`**、patch `{ messageHash: <sha256 の hex 64 文字> }`。reducer（`store.ts:272-345`）は intent の状態を変えない（`destination_pending` のまま）
- `IntentStore.reserveMessage(paymentId, hash)`: 既存の `#queue`（`:418-425`）の中で直列に **(1) `#messageHashes`（Set）に無いことを確かめ → (2) `journal.append`（追記＋fsync `journal.ts:291-298`）→ (3) Set に足す**。
  (1) で既にあれば `"collision"`（journal には書かない）、(2) が失敗すれば `"unavailable"`。`load`（`:370`）の replay で全 `destination_message_reserved` の hash を Set に戻す（**保持は journal と同じ = 永続**。
  blockhash が失効した後の衝突は chain では起きないが、Router は同じ message に 2 度署名しないという規則を単純に保つ。Set の大きさは購入の数で、問題にならない）
- 予約の後に crash → 再起動で intent は `unknown`（`#resolveInterrupted` `:383-393`。既存の規則）。別の購入が同じ message を組んでも Set にあるので `collision`
- 同じ購入の再提出は既存の規則で送信に戻らない（1 回だけ）

### 2.6 残高の hook（D-15）

- 動的: `src/core/dynamic.ts:508-513` の `fundsAvailable` はそのまま。`options.balanceOf(profileId, asset)` の実装（`main.ts:611-619`）を **rail の `balanceOf`** に替え、rail に無ければ **`undefined` を返す = 検査しない**
  （今の「全部にあるときだけ渡す」`:827-833` をやめ、`fundsAvailable` は `undefined` を「検査なし」と読む）。RPC の失敗（throw）は不足扱い（`awaiting_payment` `operator_funds_unavailable`。既存）
- 静的: `purchaseLocked`（`orchestrator.ts`）の **受信 verify の前**（`:600` の直前）に同じ hook を足す: `balanceOf(routeId, intent.destination.asset)` が `undefined` でなく `< 承認した額` なら `source_failed`（`operator_funds_unavailable`。**受信の verify の前なので資金は動いていない**）。
  公開の状態は既存の `source_failed` の写像
- SVM の rail の `balanceOf(routeId, asset)`: `asset` が自分の mint と一致することを確かめ、RPC `getTokenAccountBalance(RouterのATA, { commitment: "confirmed" })` を 1 回（§4.3 の `svmRpc`）。`value.amount` の 10 進文字列を `bigint` に

## 3. S-3: Arc に払う

### 3.1 動的（`dyn-x402-to-arc`・`dyn-mpp-to-arc`）

- 既存の `createX402DynamicPath`（`x402-dynamic.ts:330`）が **Arc の能力**で作られれば、そのまま動く: `evmChainIdOf("eip155:5042002")` = 5042002、`tokenDomain` = USDC/2（表）、contract = `0x3600…0000`、組み直し（`:199-294`）は変えない
- `checkDynamicX402Offer`（`:118-175`）の `EXTRA_KEYS`（`:54`）: V-6 の結果で **`assetTransferMethod` を足し、値は `"eip3009"` だけ**許す（他の値は `extra` で拒否）。Base の Provider は今この鍵を出していないので影響しない。**V-6 で Provider が出さないと分かれば足さない**
- 運用者の集合 §2.3
- 領収は EVM の規則のまま（bytes32 の tx hash）

### 3.2 静的（`md-arc-eth-snapshot`）: 組み直しの署名器で

`x402.ts` の静的 `pay`（`:370-595`）の guarded signer（`:410-440`。SDK の typed data を**そのまま**署名器に渡す）を Arc には使わない（要件 §3.3・V-10）:

- `X402OutboundOptions`（`:192-205`）に `rebuildSignatures: boolean` を足す。`composeRails` は **Base 以外の EVM の network で `true`**（Base は `false` のまま。既存の挙動を変えない）
- `true` のとき静的 `pay` は、offer の照合（完全一致 `:394`・`sameOfferFields` `:399`）の後、`createRebuildingSigner({ signer, destination: { network, asset, tokenDomain }, offer, now })` を使う。
  `createRebuildingSigner` の引数 `profile: DynamicProfile`（`:199-206`）を **`destination: { network, asset, tokenDomain }`** に狭める（使っているのはその 3 つ `:208-213`。動的の呼び出しは `profile.destination` を渡す）。
  静的 route は `tokenDomain` を持たないので表（`knownAssetOf`）から引く
- SDK の `x402Client` の組み立て（単一候補・spend controls・`onBeforePaymentCreation` で arm）は動的の `:514-532` と同じ形。`createPaymentPayload` の後の検査（署名 1 回・`accepted` の一致・v2）も同じ
- `receiptOf`（`x402-dynamic.ts:424-447`）と `deliveredBodyOf`（`:450-468`）を export し、静的の inline の領収の検査（`x402.ts:527-547`）と **同じ関数**にする（Base の静的も同じ関数になるが、検査の内容は同じ: `success`・`network`・bytes32・`payer`）。
  §5 の表が静的・動的で 1 つになる
- `deadlineMs`（§2.4）: 署名の直前（arm の前）と送出の直前

### 3.3 Arc の静的 route の `destination.payTo`

Provider（D-10）の Arc の受取先。owner の Provider が立つまでは入口の定数を空にし、**定数が空なら route とプロファイルを生成しない**（有効化が `true` でも）。§6.3

## 4. S-4: Solana に払う（`src/adapters/outbound/x402-svm.ts`）

### 4.1 構造

```ts
export function createX402SvmOutbound(options: {
  upstreams: Record<string, string>;                 // 静的 route の上流
  capability: SvmSigningCapability;
  transport: GuardedTransport;                        // 上流への HTTP（既存の静的と同じ）
  rpc: { url: string; transport: GuardedTransport };  // Solana RPC（§2.2）
  operatorAddresses: readonly string[];
  mint: string; decimals: number; tokenProgram: string;   // 表から（network の資産は 1 つ）
  dynamic?: { profiles: Record<string, DynamicProfile>; transport: GuardedTransport; denyHosts: readonly string[] };
  now?: () => number;
  unpaidTimeoutMs?: number; paidTimeoutMs?: number;    // 5 秒・30 秒（既存の既定）
  fetchToSignMs?: number;                              // 既定 5,000（FR-34）
}): OutboundRail & { balanceOf(routeId, asset): Promise<bigint> }
```

静的と動的を **1 つの adapter** で持つ（x402 の EVM が静的＋動的の path を持つのと同形）。違いは「offer の許容の元」だけ: 静的 = route の `destination`（完全一致）、動的 = プロファイル（`maxUpstreamAmount` と表）。

### 4.2 offer の検査 `checkSvmOffer(raw, scope, operatorAddresses): SvmOfferRejection | undefined`（純粋関数。quote・purchase の両方で）

| # | 検査 | 失敗の理由 |
|---|---|---|
| 1 | object で、鍵は `REQUIRED_KEYS`（scheme・network・asset・amount・payTo・maxTimeoutSeconds・extra）＋記述の鍵（description・mimeType・resource。文字列のみ）だけ。`maxAmountRequired` は `amount` と同じときだけ | `unknown_field`／`missing_field` |
| 2 | `scheme === "exact"`、`network === scope.network`、`asset === scope.mint`（**大文字小文字を区別**） | `scheme`／`network`／`asset` |
| 3 | `amount` は `AMOUNT_PATTERN`、`> 0`。動的は `≤ maxUpstreamAmount`。静的は route の額（完全一致は呼び出し側） | `amount`／`amount_over_limit` |
| 4 | `payTo` は base58 32 バイト、`∉ operatorAddresses`、`≠ mint`、`≠ tokenProgram` | `pay_to` |
| 5 | `maxTimeoutSeconds` は 1..600 の整数 | `max_timeout` |
| 6 | `extra` は object、鍵は `{ feePayer, memo, decimals }` の部分集合、`feePayer` 必須。**`recentBlockhash`・`lastValidBlockHeight`・`recentSlot`・`lighthouse`・`assetTransferMethod` 等は未知の鍵として拒否** | `extra` |
| 7 | `feePayer` は base58 32 バイト、`∉ { Router の公開鍵, Router の ATA, payTo, 宛先 ATA, mint, tokenProgram, Memo program, ComputeBudget program, System program }`（FR-35） | `fee_payer` |
| 8 | `memo` があれば文字列、UTF-8 で 1..256 バイト、制御文字（U+0000–U+001F・U+007F）無し | `memo` |
| 9 | `decimals` があれば `=== scope.decimals` | `decimals` |

`宛先 ATA = findAssociatedTokenPda({ mint, owner: payTo, tokenProgram })`（受信の設計 §5.1 と同じ導出）。`Router の ATA` は起動時に 1 度導く。

### 4.3 RPC（`svmRpc(method, params, { timeoutMs, operation, routeId })`）

- `src/adapters/inbound/x402-svm-startup.ts` の私有の `fetchJson`（`:55-74`）を **`svmRpcCall` として export** し、受信の起動時の検査・settle の追跡（`x402-svm.ts:418-458` の手組みの POST）・送信で共有する。応答は 64 KiB 以下、HTTP 期限 10 秒、JSON object、`result` を返す
- 使う method は 3 つだけ: `getAccountInfo`（ATA の存在。`assertAtaAccount` を export して再利用 `:110`）、`getLatestBlockhash`（`{ commitment: "confirmed" }`）、`getTokenAccountBalance`（残高）。他は呼ばない（fixture は他の method に `-32601` を返す）
- 呼ぶ場所と回数（1 購入）: quote = `getAccountInfo` 1 回（動的。静的は起動時 1 回）。purchase = `getTokenAccountBalance` 1 回（D-15）、`getAccountInfo` 1 回（再確認）、`getLatestBlockhash` 1 回。settle・領収の後は呼ばない

### 4.4 `readChallenge(routeId, target?)`（quote 時）

1. 上流の GET（支払いヘッダ無し。静的 = `upstreams[routeId]`、動的 = `target.url` を `parseUpstreamUrl` と拒否ホストで検査）。402 でなければ `DynamicChallengeError`／既存の失敗
2. `PAYMENT-REQUIRED` を SDK の `x402HTTPClient.getPaymentRequiredResponse` で読む（EVM の静的 `x402.ts:305-345` と同じ関数を `x402-challenge.ts` に括り出して共有: v2・raw と SDK の件数一致・`resource.url` の一致）
3. 各 accepts に §4.2 を掛け、通ったものだけ候補（core の `selectOffer` が route の `destination` と完全一致で選ぶ。動的は `destination` の規則で）
4. **宛先 ATA の存在**: 候補の `payTo` の ATA を `getAccountInfo(jsonParsed)` → `assertAtaAccount({ owner: payTo, mint, tokenProgram })`。無い・違う → その offer は候補にしない（`ata_missing`）。静的 route は起動時（`startup()`）に同じ検査を 1 回して fail closed、quote では呼ばない

### 4.5 `pay(request)`（purchase 時。順序は要件 FR-24）

| # | 段 | 失敗 |
|---|---|---|
| 1 | `capability.network === scope.network`、`request.offer` に §4.2（保存した offer をもう一度）、`now < request.deadlineMs` | `not_sent` |
| 2 | 残高（§2.6 は core が先に呼ぶ。ここでは呼ばない） | — |
| 3 | 上流を読み直し（§4.4 の 1–2）、**保存した offer と `stableJson` で完全一致**する accepts があること（`:506` と同じ規則） | `not_sent` `destination_offer_changed` |
| 4 | 宛先 ATA の再確認（`getAccountInfo`）。quote の後の消失は防げない——送る直前にもう一度見るだけ | `not_sent` `destination_ata_missing` |
| 5 | `getLatestBlockhash({ commitment: "confirmed" })`。`blockhash` は base58 32 バイト、`lastValidBlockHeight` は 0 より大きい整数（`number` でも 10 進文字列でも）。`fetchedAt = now()` | `not_sent` `destination_blockhash_unavailable` |
| 6 | 組み立て: `buildSvmTransactionMessage({ feePayer: offer.extra.feePayer, source: RouterのATA, authority: capability.address（noop signer）, destination: 宛先ATA, mint, amount: BigInt(offer.amount), decimals, memo, units: 60_000, microLamports: 1n, blockhash, lastValidBlockHeight, tokenProgram })`。**`lastValidBlockHeight` を引数に足す**（受信は `0n` のまま渡す `x402-svm.ts:96`）。`memo = offer.extra.memo ?? \`subetha:${paymentId}\``（paymentId は Router の ID。256 バイト以下であることを型で保証）。`compileTransaction(message).messageBytes` | — |
| 7 | `messageHash = sha256(messageBytes)`（`node:crypto`、hex）。`request.reserveMessage(messageHash)` → `"collision"` → `not_sent` `destination_message_collision`、`"unavailable"` → `not_sent` `destination_message_record_unavailable`。`reserveMessage` が無い（core が付けていない）→ `not_sent`（fail closed） | `not_sent` |
| 8 | **もう一度** `now < deadlineMs` と `now - fetchedAt ≤ fetchToSignMs` | `not_sent` `destination_deadline`／`destination_blockhash_stale` |
| 9 | `signature = await capability.sign(messageBytes)`。64 バイトで、`ed25519.verify(signature, messageBytes, capability.address)` が true（`@noble/curves`。受信の preflight と同じ） | `not_sent` `destination_not_signed` |
| 10 | wire の組み立て: `{ messageBytes, signatures: { [feePayer]: null, [capability.address]: signature } }` を `getTransactionEncoder().encode`（kit は null の署名を全ゼロ 64 バイトに写す）。**再検査**: encode した bytes を `getTransactionDecoder` で復号し、`checkSvmTransaction`（受信 `x402-svm.ts:152-228`）を policy `{ feePayer, payTo, destinationAta, mint, decimals, tokenProgram }`・`amount`・`memo` で掛ける（version 0、lookup table 無し、署名 2 つ・[0] 全ゼロ・[1] の ed25519 検証、組み直しとの byte 一致、`units`・`microLamports` の範囲、不等式、Memo）。`checkSvmTransaction` は policy の `lastValidBlockHeight` を受け取れるように拡張（受信は 0n） | `not_sent` `destination_payload_mismatch` |
| 11 | `now < deadlineMs`（送出の直前） | `not_sent` `destination_deadline` |
| 12 | 送出: `PaymentPayload = { x402Version: 2, resource: challenge.resource, accepted: <完全一致した accepts の写し>, payload: { transaction: base64 } }` を `x402HTTPClient.encodePaymentSignatureHeader` で header に。GET、`redirect: "error"`、期限 `paidTimeoutMs`。**1 回だけ**。throw → `unknown` `destination_pay_unknown` | `unknown` |
| 13 | 領収（§5）: `receiptOf(response, approved, { transactionPattern: base58 64 バイト, payerForm: "svm", signerAddress })` | 表のとおり |

- `payload` の形は SDK の client（`@x402/svm` `chunk-C3NL2A6D.mjs:124` 付近）が作るものと同じ `{ transaction }`。V-8a の試験で **SDK の client が同じ offer から組む封筒と鍵の集合が一致**することを確かめる（値は blockhash・Memo で違う）
- 署名の後・送出の前に失敗したら（8–11）`not_sent`（未送出が確か）。予約した hash は残る（その message には二度と署名しない。問題にならない: 次の購入は新しい blockhash か Memo で別の message になる）

### 4.6 署名の境界（まとめ）

- 署名器に渡るのは **Router が自分で組んだ message の bytes だけ**。SDK の提案は読まない（`@x402/svm` の client を使わない。SR-1: dependencies は増えない）
- 署名の前に hash を予約し（FR-37）、署名の後に wire を復号して組み直しと byte 一致を確かめ（受信と同じ関数）、送出の直前に期限を見る
- sabotage（SR-3）: 宛先 ATA・額・mint・fee payer・compute の上限・Memo・lifetime を 1 つずつ外す、再検査を外す、予約を署名の後に動かす、`reserveMessage` 無しで署名する → 各試験が落ちる

## 5. 送信の結果の表（FR-32。静的・動的・EVM・SVM で 1 枚）

`receiptOf(response, approved, form)` を `x402-dynamic.ts` から export し、`form = { transactionPattern, payerForm: "evm" | "svm", signerAddress }` で EVM（bytes32、`getAddress` 比較）と SVM（base58 64 バイト、文字列比較）を分ける。本文の検査は `deliveredBodyOf`（`:450-468`）。

| 段 | 条件 | 結果 |
|---|---|---|
| 送出前 | 候補外・期限・ATA・blockhash・予約・署名・再検査の失敗 | `not_sent`（未送出が確か。理由は §4.5） |
| 送出 | `transport.fetch` が throw（期限・redirect・ヘッダの上限） | `unknown` `destination_pay_unknown` |
| 領収 | `PAYMENT-RESPONSE` を decode、`success === true`、`network` 一致、`transaction` が form の形、`payer` があれば form で署名者と一致 | 整合 → 次へ。`payer` だけ違う → `unknown` `destination_receipt_payer_mismatch`。それ以外の不整合 → 「領収なし」 |
| 整合 ∧ 200 | 本文（`application/json` の object、上限）が読めた | `paid` |
| 整合 ∧ 200 | 本文が読めない・大きい・形が違う | `paid_no_data`（`paid_data_unavailable`／`response_too_large`／`unsupported_response`） |
| 整合 ∧ 200 以外 | | `paid_no_data` `paid_data_unavailable` |
| 領収なし | 2xx | `unknown` `destination_receipt_unverified` |
| 領収なし | ≥ 500 | `unknown` `destination_upstream_5xx`（既存の理由名） |
| 領収なし | それ以外 | `rejected` |

core の写像は既存（`orchestrator.ts:784-829`）: `paid` → `delivered`、`paid_no_data` → `paid_undelivered`、`not_sent`／`rejected` → `dest_failed`（公開 `paid_data_unavailable`）、他 → `unknown`。

## 6. 本番の入口（FR-30・D-11・D-12）

### 6.1 有効化（`tools/remote-mcp-config.ts:74-94`、`tools/rails-entry.ts:19-43`）

```ts
export interface RailActivation { readonly inbound: boolean; readonly outbound: boolean; }
export interface RailsActivation { readonly arc: RailActivation; readonly solana: RailActivation; }
export const RAILS_ACTIVATION: RailsActivation = Object.freeze({ arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false } });
export const RAILS_NONE = { arc: { inbound: false, outbound: false }, solana: { … } };
```

- 内部 env `SUBETHA_RAILS_ACTIVATION` の token を **`arc-in`・`arc-out`・`solana-in`・`solana-out`** に（今の `arc`・`solana` は受け付けない。復元は未知・重複を拒否、今のまま）。
  受け入れ用の起動の `--rails` も同じ token
- 1 つの値が決めるもの: 設定生成（route・プロファイル・予算の区分・`inboundFacilitators`）、子の env（鍵・RPC の転送）、能力の注入（`routerProcessCapabilitiesOf`）。env で上書きできない（今のまま）
- G-2′ は `outbound: false` のまま配備、G-4′ でレールごとに `true`

### 6.2 鍵と env（`tools/remote-mcp.ts:89-150`、`tools/rails-entry.ts:102-143`）

| env | 用途 | いつ読む |
|---|---|---|
| `SUBETHA_OUTBOUND_X402_KEY`（既存。既定は `SUBETHA_OUTBOUND_PRIVATE_KEY`） | Base **と Arc** の x402 送信（同じ鍵。D-11） | MPP 受信が有効 **または** `arc.outbound` のとき子に渡す（今は MPP 受信のときだけ `:124`） |
| `SUBETHA_OUTBOUND_SOLANA_KEY`（新） | Solana の送信（ed25519。`wallet:new:solana` と同じ base58 32 バイトの seed） | `solana.outbound` のときだけ読む・渡す |
| `SUBETHA_SOLANA_RPC_URL`（既存） | 受信の検査・追跡・**送信**の RPC | `solana.inbound ∨ solana.outbound` |
| `SUBETHA_ARC_PROVIDER_PAYTO`・`SUBETHA_SOLANA_PROVIDER_PAYTO`（新） | Provider の受取先（D-10。Arc は `0x`、Solana は owner の公開鍵） | その方向が有効なとき必須（無ければ `HostPlanError("config")`） |

`routerProcessCapabilitiesOf`: `evmSigning` = Base（今のまま）、`evmSigningByNetwork = arc.outbound ? { "eip155:5042002": createRealEvmCapability(evmKey).capability("eip155:5042002") } : {}`、
`svmSigning = solana.outbound ? { [SOL]: createRealSvmCapability(solKey).capability(SOL) } : undefined`、`dependencyUrls` に Solana RPC（受信か送信）。無効な方向の専用鍵は読まない（`SUBETHA_OUTBOUND_SOLANA_KEY`）。

### 6.3 route・プロファイル・予算（`tools/remote-mcp-config.ts`）

| 種類 | ID | 受信 | 送信 | 上流 |
|---|---|---|---|---|
| 静的 | `md-arc-eth-snapshot` | Base USDC（x402） | Arc USDC（x402）、`payTo` = `SUBETHA_ARC_PROVIDER_PAYTO` | `UPSTREAM_ARC`（定数。Provider が立ったら入れる） |
| 静的 | `md-sol-eth-snapshot-mpp` | Tempo pathUSD（MPP） | Solana USDC（x402）、`payTo` = `SUBETHA_SOLANA_PROVIDER_PAYTO` | `UPSTREAM_SOL` |
| 動的 | `dyn-x402-to-arc`・`dyn-mpp-to-arc` | Base x402／Tempo MPP | Arc x402（`tokenDomain` USDC/2、`decimals` 6、`maxUpstreamAmount` 10000、fee flat 1000） | 呼び出し側 |
| 動的 | `dyn-x402-to-sol`・`dyn-mpp-to-sol` | Base x402／Tempo MPP | Solana x402（`decimals` 6、`tokenProgram` 表） | 呼び出し側 |

- 定数 `OUTBOUND_ARC = { network, asset: 0x3600…, decimals: 6 }`、`OUTBOUND_SOL = { network, asset: 4zMMC9…, decimals: 6, tokenProgram }`（`payTo` は env）。`UPSTREAM_ARC`／`UPSTREAM_SOL` が空文字なら静的 route を生成しない（動的は生成する）
- 予算の区分: `railBuckets`（`:217-220`）は **その network が受信か送信のどちらかで有効**なら Arc USDC・Solana USDC の区分を出す（今は受取先の有無 = 受信）。静的・動的とも。上限は D-14（既存と同じ桁）
- `x402.upstreams` に新しい静的 route の URL
- MPP 受信（`md-sol-eth-snapshot-mpp`・`dyn-mpp-to-*`）は `SUBETHA_MPP_INBOUND_SECRET` があるときだけ（既存の規則）

### 6.4 `tools/real-svm-capability.ts`（新）

- `createRealSvmCapability(key: string)`: `svmSignerFromKey`（`tools/svm-payer.ts:37-56`。base58 64／32 バイト、hex seed）を `tools/svm-key.ts` に移して共有。`@solana/kit` の `createKeyPairSignerFromPrivateKeyBytes` → `address`、`sign(bytes) = signBytes(keyPair.privateKey, bytes)`。鍵の文字列は保持しない。`signCount()`（試験用）
- `capability(network): SvmSigningCapability { network, address, sign, kind: "real-key" }`

### 6.5 DEPLOY・CLAUDE.md・README

- `docs/DEPLOY.md` §2c に送信の段（G-1′〜G-4′）: env の 3 本（鍵・Provider の受取先）、`wallet:new:solana` で送信鍵を作る手順、ATA の作成（運用者。`spl-token create-account` 相当は Router の外）、残高の見方、有効化の token
- CLAUDE.md: 一覧の表に 2 行（`md-arc-eth-snapshot`: pay Base USDC → Arc の Provider、`md-sol-eth-snapshot-mpp`: pay Tempo pathUSD → Solana の Provider）とプロファイル 4 本。呼び出し側の手順は変わらない（FR-31）

## 7. 試験と fixture（AC-8〜AC-12）

### 7.1 fixture

- **Arc の Provider**: `tests/fixtures/dynamic/x402-upstream.ts` の `standardAccept(overrides)`（`:118`）で `network: ARC, asset: ARC_USDC, extra: { name: "USDC", version: "2" }`、`paidOk(payer, body, network = FIXTURE_NETWORK)` に network の引数を足す。
  署名の検証は `tests/fixtures/dynamic/verifying-facilitator.ts`（EIP-3009 の署名と nonce を検証）を chainId 5042002・contract `0x3600…` で動かす（引数化）
- **Solana の Provider**（新 `tests/fixtures/svm-upstream.ts`）: 402 で SVM の accepts（`feePayer` は fixture の facilitator の `/supported` から、`extra.memo` は試験ごとに有無）を返し、`PAYMENT-SIGNATURE` を受けたら fixture の SVM facilitator
  （`tests/fixtures/svm-facilitator.ts`。本物の `@x402/svm` の facilitator、simulate／send／confirm は差し替え）に `/verify` → `/settle` し、200 と `PAYMENT-RESPONSE { success, transaction: <署名>, network, payer }` を返す。
  `state` で: 固定 Memo、乱数 Memo（V-12 の再現）、`recentBlockhash` 入り、`feePayer` を Router の公開鍵に、`payTo` を運用者に、応答の喪失、500
- **Solana RPC**（`tests/fixtures/solana-rpc.ts`）に `getTokenAccountBalance` と、宛先 ATA の有無（`state.atas` の複数化）を足す。`getLatestBlockhash` は既に `lastValidBlockHeight: 1000`
- **署名器**: `tests/fixtures/svm-signer-spy.ts`（`sign` の回数と渡された bytes を記録。`non-signing-fixture` の kind）

### 7.2 試験の置き場

| 層 | ファイル | 内容 |
|---|---|---|
| unit | `tests/unit/svm-offer-check.test.ts` | §4.2 の各行の肯定・否定、不等式の各組 |
| unit | `tests/unit/svm-message.test.ts` | 組み立て→hash→wire→`checkSvmTransaction` の往復、`lastValidBlockHeight`、Memo の既定 |
| unit | `tests/unit/message-reservation.test.ts` | `IntentStore.reserveMessage`: 直列の衝突、journal 追記の失敗 → `unavailable`、replay で復元、再起動後の別 paymentId の衝突 |
| unit | `tests/unit/outbound-composition.test.ts` | `(rail, network)` の合成: 欠落・重複・family 不一致で起動しない、`railByRoute` が組で引く、運用者の集合の構成、Solana RPC の拒否ホスト（受信無し・送信あり） |
| unit | `tests/unit/remote-mcp-config.test.ts`・`rails-entry.test.ts` | 方向別の有効化の生成・復元、鍵を読まない、Provider の受取先が無ければ `HostPlanError`、route／プロファイル／区分の生成、`UPSTREAM_*` が空なら静的 route 無し |
| wire | `tests/wire/x402-arc-outbound.test.ts` | 静的（組み直し）・動的、Base 用の能力で Arc の offer → `not_sent`、`assetTransferMethod`（V-6 の結果で） |
| wire | `tests/wire/x402-svm-outbound.test.ts` | §4.5 の各段の失敗（AC-10 の列挙）、改変の 4 種（AC-9 (a)〜(d)）、固定 Memo の並行 2 件、予約直後・署名直後の crash（journal を切って再起動）、応答の喪失 → `unknown`・再起動後も再送信 0、SDK の client の封筒との一致（V-8a） |
| integration | `tests/wire/multirail-integration.test.ts` | O-1〜O-4 の静的・動的が `delivered`（能力は `evmSigningByNetwork[ARC]`・`svmSigning[SOL]` を注入）、残高の hook（静的・動的）、既存の経路が変わらない |
| process | `tests/wire/rails-process-entry.test.ts` | 方向別の token、送信の鍵の注入、無効な方向で env を読まない |

### 7.3 完了の条件（タスクに写す）

- 既存の suite が緑のまま（Base の静的・動的の挙動は `deadlineMs` の追加以外変えない。期限の既定は十分遠い）
- Linux（`node:22-bookworm`）で全部緑。sabotage の表を PR に

## 8. `npm run sign`・呼び出し側

変わらない（FR-31）。`sign-dispatch.ts` の `classifyOffer` は受信の表を見るだけで、送信の表の変更に影響されない（`entry.inbound` を見る `:55`）。

## 9. 新しい依存

無し。`@solana/kit`・`@solana-program/*`・`@noble/curves` は既に dependencies、sha256 は `node:crypto`。`@x402/svm` は devDependency のまま（fixture の facilitator だけ）。

## 10. 未解決（設計の中で消せないもの）

| # | 内容 | 扱い |
|---|---|---|
| U-6 | `extra.assetTransferMethod`（V-6）。Arc の Provider（Circle の server 側）が出すか | Provider の 402 を取ってから §3.1 の分岐を決める。T の中で `curl` の記録を残す |
| U-7 | Provider の offer の安定性（V-12）。SDK の server が乱数 Memo を出す構成なら完全一致が成り立たない | Provider 側で Memo を固定するか出さない（owner の Provider の設定）。Router は緩めない |
| U-8 | 取得〜署名の上限 5 秒の妥当性（RPC の遅さ） | 本番の RPC で測って決める（G-3′）。上限は設定ではなく定数 |
| U-9 | Solana の fixture の facilitator は simulate を模擬するので、compute の消費の証拠は実 facilitator（V-8b）でしか得られない | V-8b を G-3′ の前に 1 回 |

## 11. 変更するファイル

| ファイル | 変更 |
|---|---|
| `src/config.ts` | 表の `outbound`、`TermsToValidate.tokenProgram`、`DynamicProfile.destination.tokenProgram`、`parseDynamicProfile` の family 分岐 |
| `src/ports/outbound.ts` | `SvmSigningCapability`、`PayRequest.deadlineMs`・`reserveMessage`、`OutboundRail.balanceOf?` |
| `src/main.ts` | `RouterCapabilities`（`evmSigningByNetwork`・`svmSigning`）、`(rail, network)` の合成、運用者の集合、Solana RPC の条件、残高の配線 |
| `src/core/store.ts`・`src/core/journal.ts`（event 名） | `destination_message_reserved`、`reserveMessage`、replay |
| `src/core/orchestrator.ts`・`src/core/dynamic.ts` | `PayRequest` の 2 欄、静的の残高の hook、`balanceOf` の `undefined` |
| `src/adapters/outbound/x402.ts` | `rebuildSignatures`、運用者の照合、共有の `receiptOf`、`deadlineMs` |
| `src/adapters/outbound/x402-dynamic.ts` | `createRebuildingSigner` の引数、`receiptOf`／`deliveredBodyOf` の export と form、運用者の集合、`deadlineMs`、（V-6）`assetTransferMethod` |
| `src/adapters/outbound/x402-challenge.ts`（新） | 402 の読み取りの共有 |
| `src/adapters/outbound/x402-svm.ts`（新） | §4 |
| `src/adapters/inbound/x402-svm.ts`・`x402-svm-startup.ts` | `lastValidBlockHeight` の引数、`checkSvmTransaction` の policy、`svmRpcCall`・`assertAtaAccount` の export |
| `tools/remote-mcp-config.ts`・`rails-entry.ts`・`remote-mcp.ts`・`rails-acceptance-run.ts` | 方向別の有効化、route／プロファイル／区分、env、能力 |
| `tools/real-svm-capability.ts`・`tools/svm-key.ts`（新） | §6.4 |
| `tests/fixtures/*`・`tests/unit/*`・`tests/wire/*` | §7 |
| `docs/DEPLOY.md`・`CLAUDE.md`・`README.md` | §6.5 |

## 12. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
