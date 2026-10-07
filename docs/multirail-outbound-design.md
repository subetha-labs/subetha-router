# 設計: Arc と Solana の Provider に払う（S-3・S-4。第 4 版、2026-10-07）

> 要件は `multirail-outbound-requirements.md`（owner の決定 §0、FR-22〜FR-38、AC-8〜AC-14、V-6〜V-13）。本書は **S-3（Arc の Provider に払う）** と **S-4（Solana の Provider に払う）** の設計。
> 受信の設計（`multirail-design.md`）と動的上流の設計（`dynamic-upstream-design.md` §3.3 の署名の境界）の原則を継ぐ: core はレールの port 越しにだけ外へ出る、署名・検査の境界は確かめた値だけで組む、
> `src/` の外への接続はすべて SSRF 防御 A の transport、鍵は `tools/` だけが env から読む、testnet だけ。調べた基準は `main` の `f1897bd`（file:line は目安）。
>
> 第 3 版からの訂正（独立レビュー #3、§12）: 署名前の検査の header は 2／1／4、口座の並びは kit の規則から期待値だけで算出（相対順が逆になる試験も）、parser の復号に加えて program ID・discriminator・data 長・口座数・読み残しを明示（§4.5 7）。
> step 10 を外す sabotage は 11-(ii) が止めるので、検出は理由の変化で（§4.6）。MPP の期限の拒否は「署名の前・最初の RPC の委譲の前」を識別する例外と状態で `not_sent` に写し、委譲の後は既存の不明扱い（§2.4・§7.2）。
>
> 第 2 版からの訂正（独立レビュー #2、§12）: 署名前の検査は builder と**独立に**（復号した命令・口座・役割・header・data を期待値と 1 欄ずつ照合し、組み直しの関数を使わない）、期待値は原始値の私有 object で builder には別の写しを渡す（§4.5）。
> noble には公開鍵を 32 バイトに復号して渡す（§4.5 10）。MPP の期限は**実署名の委譲の直前と送金 RPC の直前**で、broadcast の後は `not_sent` にしない（§2.4）。crash の試験は子 process の停止で（§7.2）。sabotage の観測を明記し、「HTTP 0」は支払いヘッダ付きの要求 0 件に（§4.6）。
> AC-11 の公開後の確認を完了条件に（§7.3）。有効化の受信だけを見る箇所を列挙（§6.1）。
>
> 第 1 版からの訂正（独立レビュー #1、§12）: **署名の前に unsigned の message を期待値だけで検査**し、署名器には写しを渡し、署名の後も同じ snapshot と照合する（§4.5）。`feePayer` も運用者の集合と照合し、
> 静的 x402・MPP も候補の段階で運用者宛てを外す（§2.3）。**Base の静的の領収の処理は変えない**（§3.2・§5）。adapter に `startup()` と静的 route の期待値を持たせ、ATA の導出は起動時に（§4.1・§4.4）。
> 署名器は同期（`@noble/curves`）で `tools` の同期の入口に合わせる（§6.4）。期限の検査は**実際の署名の委譲の直前**（EVM の両 signer）と MPP にも（§2.4）。静的の残高の hook の失敗の契約（§2.6）。
> RPC helper は封筒を返す今の形のまま共有し、回数は上限で書く（§4.3）。Memo の既定も実行時に検査、予約の契約を明文化（§2.5・§4.5）。有効化の token の移行（受け入れ用の起動・DEPLOY）と子の env の条件（§6）。
> 試験の観測点（signer の回数と bytes、停止点の hook、settle 後の切断）と受け入れの完了条件（§7）。

## 0. 一枚で

| 項 | S-3（Arc） | S-4（Solana） |
|---|---|---|
| 新しい adapter | **無し**。既存の x402 送信（静的 `x402.ts`・動的 `x402-dynamic.ts`）を **network ごとに 1 つずつ**作る。静的の Arc は **組み直しの署名器**で署名する（§3.2） | **`src/adapters/outbound/x402-svm.ts`**（新）。offer の検査・ATA・blockhash・組み立て・**署名前の検査**・hash の予約・署名・wire の再検査・送出・領収（§4） |
| 能力 | `evmSigning` を network ごとに（`evmSigningByNetwork`）。Arc は Base と**同じ鍵**を別の札で（D-11） | `svmSigning`（新。ed25519。**message の bytes に署名するだけ**の同期の署名器） |
| 合成 | 送信レールの鍵を **`(rail, network)`** に（§2.2） | 同左。adapter の `startup()` を起動時の検査に繋ぐ |
| 表 | `outbound: ["x402"]` | 同左＋ `tokenProgram` の照合 |
| 設定 | 静的 route・動的プロファイルは今の形（`tokenDomain` = USDC/2） | 動的プロファイルの `destination` に `tokenDomain` の代わりに `decimals`・（任意の）`tokenProgram` |
| RPC | 無し（EIP-3009 は offline） | Solana RPC（受信と同じ guarded transport）: ATA・blockhash・残高 |
| core の変更 | `PayRequest.deadlineMs`（FR-36）、運用者の集合の注入（FR-38）、静的 route の残高の hook（D-15） | 同左＋ **message の hash の予約**（`PayRequest.reserveMessage`、journal の行 `destination_message_reserved`。FR-37） |
| 本番の入口 | `RAILS_ACTIVATION` を方向別に拡張。route `md-arc-eth-snapshot`、プロファイル `dyn-x402-to-arc`・`dyn-mpp-to-arc` | route `md-sol-eth-snapshot-mpp`、プロファイル `dyn-x402-to-sol`・`dyn-mpp-to-sol`、鍵 `SUBETHA_OUTBOUND_SOLANA_KEY` |

**作る順**: §1（表・設定）→ §2（能力と合成、core の port の拡張）→ §3（Arc）→ 受け入れ（AC-8・AC-13）→ §4（Solana）→ 受け入れ（AC-9・AC-14）。有効化はレールごと（D-13）。
**公開する行列は D-12 で固定**（静的 2・動的 4。§6.3）。同レール同チェーンは範囲外（D-16）。Arc ↔ Solana（O-5・O-6）は par の宣言（D-17）の上で、足すときに AC-13／AC-14 と同じ購入と gate を通す。

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

### 1.3 静的 route

- 形は変えない（`DestinationAllow`: scheme・network・asset・payTo `:192-197`。**額は持たない**——静的の送信の額は quote で保存した承認済み offer の額）。Solana 宛は `payTo` = Provider の **owner の公開鍵**（base58 32 バイト。ATA ではない。受信の設計 §5.1 と同じ約束）
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
  readonly address: string;                              // base58 32 バイト（Router の送信の公開鍵）
  readonly sign: (messageBytes: Uint8Array) => Uint8Array; // ed25519。64 バイト。同期。message の bytes 以外は受け取らない
  readonly kind: "real-key" | "fixture-key";              // fixture-key = 試験用の鍵で本当に署名する（回数と bytes を記録）
}
```

- **署名器が受け取るのは Router が組んで検査した message の bytes の写しだけ**（SDK の `TransactionSigner` を渡さない）。adapter が wire の transaction を自分で組み、署名を [1] に入れる（§4.5）
- 残高（D-15）は **rail（adapter）** が持つ（RPC と transport は adapter にある）: `OutboundRail.balanceOf?(routeId: string, asset: string): Promise<bigint>`。EVM の rail は持たない。
  既存の能力の任意の `balanceOf`（`src/ports/outbound.ts:42`・`:52`）は**捨てない**: 配線（§2.6）は rail の `balanceOf` → 無ければ能力の `balanceOf` → 無ければ検査なし、の順

### 2.2 合成（`src/main.ts` `composeRails` `:370-413`、`railByRoute` `:156-197`）

- 使う送信の組 = `{ rail: route.rail ?? "x402", network: route.destination.network }` と `{ rail: profile.rail, network: profile.destination.network }` の集合。鍵は `` `${rail}:${network}` ``
- 組ごとに adapter を 1 つ作る:
  - `x402` × evm の network → `createX402Outbound({ upstreams: その network の route だけ, capability: evmByNetwork[network], transport, rebuildSignatures: network !== "eip155:84532", operatorAddresses, dynamic: その network のプロファイルだけ })`
  - `x402` × svm の network → `createX402SvmOutbound({ … })`（§4.1）。返り値の `startup` を `startupChecks`（`main.ts:652`。`startRouter` が `rails.startup()` で `await` する `:749`）に足す
  - `mpp` × Tempo → 今のまま（`createMppOutbound`）に `operatorAddresses` を渡す
- **起動時の検査**（fail closed、`SignerNotAuthorizedError`）: 組に能力が無い／同じ network が `evmSigning` と `evmSigningByNetwork` の両方にある／**Record の key と能力の `network` と組の network が完全一致しない**
  （Base の能力を Arc の key に入れた誤設定を拒む）／能力の `network` の family が合わない／`svmSigning[*].address` が base58 32 バイトでない
- `railByRoute` の Map は routeId／profileId → **その組の adapter**（今は rail 名だけ `:163`・`:171`）。`estimateFee`・`balanceOf` も同じ Map で引く
- **Solana RPC**（`:349-350`）: `usesSvm = SVM の受信 ∨ SVM の送信` のとき `solanaRpcUrl` を決め、拒否ホストと依存先に入れる。送信の adapter の RPC transport は受信の起動時の検査と同じ作り（`:479`）。
  `createGuardedTransport` の呼び出しを `svmRpcTransportOf(staticHooks, report)` に括り出して受信・送信で共有する
- `composeRails` は同期のまま。非同期の仕事（ATA の導出）は adapter の `startup()` に置く（§4.4）

### 2.3 運用者の集合（FR-38）

`composeRails` が起動時に 1 度作り、**全送信 adapter**（x402 静的・動的・SVM・MPP）に `operatorAddresses: readonly string[]` として渡す（network ごとに分けず、形で見分けられる文字列の集合。EVM は小文字化して比較、SVM はそのまま）:

- (a) `sourceRail` が `x402`／`mpp` の全 route／プロファイルの `source.payTo`
- (b) 注入された送信能力の公開アドレス: `evmSigning.signer.address`、`evmSigningByNetwork[*].signer.address`、`mppTempo.account.address`、`svmSigning[*].address`
- (c) (a)(b) の SVM のアドレス × 表の SVM の mint・token program から導いた ATA。`findAssociatedTokenPda` は非同期なので、この部分は **SVM adapter の `startup()` の中で**足す（adapter は集合を可変の Set として受け取り、起動時に ATA を加える。`startup()` が終わるまで `pay`・`readChallenge` は拒む）

静的 route の `destination.payTo` は入れない。照合する欄と場所:

| adapter | 欄 | 場所 |
|---|---|---|
| x402 動的（`x402-dynamic.ts`） | `payTo` | 既存の `operatorAddressesOf`（`:362`）を **この集合＋自分の署名者**に置き換え（候補の段階 `checkDynamicX402Offer` と `pay` の再検査の両方。既存どおり） |
| x402 静的（`x402.ts`） | `payTo` | **候補の段階**（`offersOf` `:347-357`）で外す（今は候補をそのまま返す `:349`・`:367`）＋ `pay` でも（`:394` の後） |
| SVM（§4.2） | `payTo` と `feePayer` | 候補の段階と `pay` |
| MPP（`mpp.ts`・`mpp-dynamic.ts`） | challenge の受取先（`recipient`） | challenge を読む所（候補）と `pay` の照合 |

### 2.4 core の port の拡張（`src/ports/outbound.ts`、`src/core/orchestrator.ts` `deliver` `:756-764`）

```ts
export interface PayRequest {
  // 既存: routeId, offer, paymentId, attempt, target?, maxFee?
  readonly deadlineMs: number;   // FR-36: intent.approvalDeadlineMs（static・dynamic とも同じ欄 src/core/intent.ts:157）
  readonly reserveMessage?: (messageHash: string) => Promise<"reserved" | "collision" | "unavailable">;   // FR-37。SVM の rail だけが使う
}
```

- `deliver()` が `PayRequest` を組むとき `deadlineMs = intent.approvalDeadlineMs` と、`reserveMessage = (hash) => store.reserveMessage(paymentId, hash)` を付ける
- 期限の検査の場所（**実際の署名の委譲の直前**と送出の直前。「arm の前」では SDK が間で待てば期限後に署名できる）:
  - x402 動的: `createRebuildingSigner` に `deadlineMs` を渡し、`args.signer.signTypedData` を呼ぶ直前（`x402-dynamic.ts:275`）で `now < deadlineMs` でなければ `SigningRefusedError("destination_deadline")`
  - x402 静的 Base: guarded signer の委譲の直前（`x402.ts:438`）で同じ検査（**Base への変更はこれだけ**）。静的 Arc は組み直しの署名器なので上と同じ
  - SVM: §4.5 の 8・11
  - MPP（FR-36 は全 adapter に掛ける。`:409`・`:865` は `pay` の入口で、credential の生成 `:485`・`:1014` の中に非同期の処理と broadcast がある）: 動的 MPP は **実署名の委譲の直前（`mpp-dynamic.ts:460`）と送金 RPC の直前（`:978`）**、
    静的 MPP は `:287` の account を**期限を検査する署名 wrapper で包み**、送金 RPC（`:323`）の直前にも検査。**結果の写像**: 期限の拒否は専用の例外 `DeadlineRefusedError` で、wrapper は **実署名・最初の RPC の委譲の前**（署名・送信の counter を増やす前）に投げ、
    adapter の状態 `refusedBeforeDispatch = true` を立てる。`pay` の catch（静的 `mpp.ts:485-493`——今は `getClient` に達した時点で `reach.touched` が立ち credential の失敗を `unknown` にする `:289`；動的は `sendRefusedBeforeDispatch` `mpp-dynamic.ts:1017`）は
    **`refusedBeforeDispatch` が立ち、署名 0・送信 0 のときだけ** `not_sent`（`destination_deadline`）に写す。一度でも署名か RPC を委譲した後の失敗は既存の不明扱い。**broadcast の後**（Provider への HTTP の前）に期限が切れても `not_sent` にはしない——
    既存の「送金済みかもしれない」扱い（`mpp.ts:440`・`:491`、`mpp-dynamic.ts:930`）をそのまま保つ。動的の署名・送信の counter の加算（`:458`・`:975`）より前に検査を置く
  - EVM・SVM は送出の直前にもう一度（署名だけでは資金が動かない）。過ぎていれば `not_sent`（`destination_deadline`）

### 2.5 message の hash の予約（FR-37。`src/core/store.ts` `IntentStore`）

- 新しい journal の event **`destination_message_reserved`**、patch `{ messageHash: <sha256 の小文字 hex 64 文字> }`。reducer（`store.ts:272-345`）は intent の状態を変えない（`destination_pending` のまま）
- `IntentStore.reserveMessage(paymentId, hash)` の契約:
  - `hash` は小文字 hex 64 文字でなければ `"unavailable"`（書かない）。対象の intent が `destination_pending` でなければ `"unavailable"`
  - 既存の `#queue`（`:418-425`）の中で直列に **(1) `#messageHashes`（Set）に無いことを確かめ → (2) `#appendLocked` 相当で `journal.append`（追記＋fsync `journal.ts:291-298`）→ (3) Set に足す**。
    queue の中から公開の `append()` を await しない（自己待機しない）
  - (1) で既にあれば `"collision"`（**同じ paymentId からの 2 度目も collision**。journal には書かない）、(2) が失敗すれば `"unavailable"`（journal はその後使えない `journal.ts:264`。既存の挙動）
  - `load`（`:370`）の replay で全 `destination_message_reserved` の hash を Set に戻す。**形の壊れた行（hex 64 文字でない）は起動を止める**（fail closed。budget の「数える側に倒す」と同じ方向）。保持は journal と同じ = 永続
- 予約の後に crash → 再起動で intent は `unknown`（`#resolveInterrupted` `:383-393`。既存の規則）。別の購入が同じ message を組んでも Set にあるので `collision`。同じ購入の再提出は既存の規則で送信に戻らない
- `PayRequest.reserveMessage` の closure は core の内部の port。**署名器そのものを縛る境界ではない**（縛るのは §4.5 の順序と、予約無しでは署名しない規則＋その sabotage）

### 2.6 残高の hook（D-15）

- 配線（`main.ts:611-619`・`:827-833`）: `balanceOf(id, asset)` は **rail の `balanceOf`** → 無ければ **能力の `balanceOf`**（既存の任意。互換）→ どちらも無ければ `undefined` を返す。`dynamicCoreOptionsOf` の「全プロファイルにあるときだけ渡す」規則はやめ、常に渡す
- 動的（`src/core/dynamic.ts:628-651` `fundsAvailable`）: `balanceOf` が **`undefined` を返したら「検査なし」として通す**（今は `undefined` も不足扱い `:643`）。throw・`bigint` でない・不足 → 不足（`awaiting_payment` `operator_funds_unavailable`。既存）
- 静的（`orchestrator.ts` `purchaseLocked`）: `readAndMatchDestination` の後、**`source_pending` を書く前**（`:596` の直前）に `balanceOf(routeId, intent.destination.asset)`。`undefined` → 通す。throw・`bigint` でない・`< 承認した額` →
  `source_failed { outcome: "not_sent", reason: "operator_funds_unavailable" }`（`:578` の `offer_unavailable` と同じ形。受信の verify の前なので資金は動いていない）、応答は `awaiting_payment`・code `operator_funds_unavailable`（`intent.ts:35` の写像）
- SVM の rail の `balanceOf(routeId, asset)`: `asset` が自分の mint と一致しなければ throw。RPC `getTokenAccountBalance(RouterのATA, { commitment: "confirmed" })` を 1 回（§4.3）。`value.amount` の 10 進文字列を `bigint` に。形が違えば throw

## 3. S-3: Arc に払う

### 3.1 動的（`dyn-x402-to-arc`・`dyn-mpp-to-arc`）

- 既存の `createX402DynamicPath`（`x402-dynamic.ts:330`）が **Arc の能力**で作られれば、そのまま動く: `evmChainIdOf("eip155:5042002")` = 5042002、`tokenDomain` = USDC/2（表）、contract = `0x3600…0000`、組み直し（`:199-294`）は変えない（期限の検査 §2.4 を足す）
- `checkDynamicX402Offer`（`:118-175`）の `EXTRA_KEYS`（`:54`）: V-6 の結果で **`assetTransferMethod` を足し、値は `"eip3009"` だけ**許す（他の値は `extra` で拒否）。Base の Provider は今この鍵を出していないので影響しない。**V-6 で Provider が出さないと分かれば足さない**
- 運用者の集合 §2.3。領収は EVM の規則のまま（bytes32 の tx hash）

### 3.2 静的（`md-arc-eth-snapshot`）: 組み直しの署名器で。Base の静的は変えない

`x402.ts` の静的 `pay`（`:370-595`）の guarded signer（`:410-440`。SDK の typed data を**そのまま**署名器に渡す）を Arc には使わない（要件 §3.3・V-10）:

- `X402OutboundOptions`（`:192-205`）に `rebuildSignatures: boolean` を足す。`composeRails` は **Base 以外の EVM の network で `true`**。`false`（Base）のときの経路は **署名の委譲の直前の期限の検査（§2.4）と候補の段階の運用者の照合（§2.3）以外、今のまま**
  （領収の処理 `:519-594` も変えない: `transaction` は非空文字列、本文の失敗は `unknown`、502 の特別扱い、SDK の `processResponse`）
- `true` のとき静的 `pay` は、offer の照合（完全一致 `:394`・`sameOfferFields` `:399`）の後、**動的と同じ経路**で払う: `createRebuildingSigner({ signer, destination: { network, asset, tokenDomain }, offer, now, deadlineMs })`、
  単一候補の `x402Client`・spend controls・`onBeforePaymentCreation` で arm（動的の `:514-532` と同じ）、`createPaymentPayload` の後の検査（署名 1 回・`accepted` の一致・v2）、送出、**動的の領収の関数**（§5）
- `createRebuildingSigner` の引数 `profile: DynamicProfile`（`:199-206`）を **`destination: { network, asset, tokenDomain }`** に狭める（使っているのはその 3 つ `:208-213`。動的の呼び出しは `profile.destination` を渡す）。静的 route は `tokenDomain` を持たないので表（`knownAssetOf`）から引く
- `receiptOf`（`:424-447`）と `deliveredBodyOf`（`:450-468`）は factory の閉包（能力・transport を参照）なので、**module の関数に出して依存を引数に**: `receiptOf(response, approved, form: { transactionPattern, payerForm, signerAddress })`、
  `deliveredBodyOf(response, receipt, { maxBodyBytes, report })`。動的 EVM・静的 Arc・SVM がこれを使う。Base の静的は使わない

### 3.3 Arc の静的 route の `destination.payTo`

Provider（D-10）の Arc の受取先。入口の env `SUBETHA_ARC_PROVIDER_PAYTO` と定数 `UPSTREAM_ARC`。**静的 route はその両方があるときだけ生成**し、動的プロファイルは（Provider の受取先が要らないので）方向が有効なら常に生成する（§6.3 と同じ規則）。

## 4. S-4: Solana に払う（`src/adapters/outbound/x402-svm.ts`）

### 4.1 構造

```ts
export function createX402SvmOutbound(options: {
  network: string;
  upstreams: Record<string, string>;                              // 静的 route の上流
  destinations: Record<string, { payTo: string; asset: string; scheme: string }>;   // 静的 route の destination（起動時の ATA の検査と候補の照合に）
  capability: SvmSigningCapability;
  transport: GuardedTransport;                                     // 上流への HTTP（既存の静的と同じ）
  rpc: { url: string; transport: GuardedTransport };               // Solana RPC（§2.2）
  operatorAddresses: Set<string>;                                  // §2.3。startup() が ATA を足す
  mint: string; decimals: number; tokenProgram: string;            // 表から（network の資産は 1 つ）
  dynamic?: { profiles: Record<string, DynamicProfile>; transport: GuardedTransport; denyHosts: readonly string[] };
  now?: () => number;
  unpaidTimeoutMs?: number; paidTimeoutMs?: number;                // 5 秒・30 秒（既存の既定）
  fetchToSignMs?: number;                                          // 既定 5,000（FR-34）
  hooksForTest?: { afterReserve?(): void; afterSign?(): void; beforeSend?(): void; wire?(bytes: Uint8Array): Uint8Array };   // §7 の停止点・改変（試験だけ）
}): OutboundRail & { startup(): Promise<void>; balanceOf(routeId: string, asset: string): Promise<bigint> }
```

静的と動的を **1 つの adapter** で持つ。違いは「offer の許容の元」だけ: 静的 = route の `destination`（payTo・asset・scheme の完全一致。額は承認済み offer）、動的 = プロファイル（`maxUpstreamAmount` と表）。

### 4.2 offer の検査 `checkSvmOffer(raw, scope, operatorAddresses): SvmOfferRejection | undefined`（純粋関数。候補の段階と purchase の両方で）

| # | 検査 | 失敗の理由 |
|---|---|---|
| 1 | object で、鍵は `REQUIRED_KEYS`（scheme・network・asset・amount・payTo・maxTimeoutSeconds・extra）＋記述の鍵（description・mimeType・resource。文字列のみ）だけ。`maxAmountRequired` は `amount` と同じときだけ | `unknown_field`／`missing_field` |
| 2 | `scheme === "exact"`、`network === scope.network`、`asset === scope.mint`（**大文字小文字を区別**） | `scheme`／`network`／`asset` |
| 3 | `amount` は `AMOUNT_PATTERN`、`> 0`。動的は `≤ maxUpstreamAmount` | `amount`／`amount_over_limit` |
| 4 | `payTo` は base58 32 バイト、`∉ operatorAddresses`、`≠ mint`、`≠ tokenProgram`。導いた宛先 ATA `≠ Router の ATA` | `pay_to` |
| 5 | `maxTimeoutSeconds` は 1..600 の整数 | `max_timeout` |
| 6 | `extra` は object、鍵は `{ feePayer, memo, decimals }` の部分集合、`feePayer` 必須。**`recentBlockhash`・`lastValidBlockHeight`・`recentSlot`・`lighthouse`・`assetTransferMethod` 等は未知の鍵として拒否** | `extra` |
| 7 | `feePayer` は base58 32 バイト、`∉ operatorAddresses`、`∉ { Router の公開鍵, Router の ATA, payTo, 宛先 ATA, mint, tokenProgram, Memo program, ComputeBudget program, System program }`（FR-35・FR-38） | `fee_payer` |
| 8 | `memo` があれば文字列、UTF-8 で 1..256 バイト、制御文字（U+0000–U+001F・U+007F）無し | `memo` |
| 9 | `decimals` があれば `=== scope.decimals` | `decimals` |

`宛先 ATA = findAssociatedTokenPda({ mint, owner: payTo, tokenProgram })`（受信の設計 §5.1 と同じ導出。非同期なので、検査は「同期の形の検査（1–3・5–9 と 4 の形）」と「ATA を要する不等式（4・7 の ATA の項）」の 2 段で、後者は候補の段階で `await` して行う）。

### 4.3 RPC

- `src/adapters/inbound/x402-svm-startup.ts` の私有の `fetchJson`（`:55-74`。**JSON の封筒全体**を返す。`assertAtaAccount` は既に export されていて `reply.result` を読む `:110`）を **`svmFetchJson` として export** し、形は変えない。
  送信は JSON-RPC の封筒を自分で組み、`result` を取り出す薄い関数 `svmRpcResult(…)` を adapter 側に置く。受信の起動時の検査（`/supported` は JSON-RPC ではない）と settle の追跡（`x402-svm.ts:418-458`。残り時間に応じた期限）は **今のまま**
- 送信が使う method は 3 つだけ: `getAccountInfo`（ATA。`assertAtaAccount` で検査）、`getLatestBlockhash`（`{ commitment: "confirmed" }`）、`getTokenAccountBalance`。他は呼ばない。期限は 10 秒・応答 64 KiB（受信の起動時の検査と同じ）
- 回数の**上限**（1 購入。core は `readChallenge` を quote・purchase の受信前（`orchestrator.ts:576`）・`deliver`（`:733`）で呼ぶ）: quote = 候補ごとに `getAccountInfo` 1 回（動的。静的は起動時 1 回で quote では呼ばない）。
  purchase = `readChallenge` 2 回分の `getAccountInfo`（動的。候補ごと）＋ `getTokenAccountBalance` 1 回（§2.6）＋ `pay` の中の `getAccountInfo` 1 回・`getLatestBlockhash` 1 回。settle・領収の後は呼ばない

### 4.4 `startup()` と `readChallenge(routeId, target?)`

- `startup()`（起動時に 1 回。`startRouter` が `await`）: Router の ATA を導く（`findAssociatedTokenPda({ mint, owner: capability.address, tokenProgram })`）、運用者の集合に (c) の ATA を足す、
  **静的 route ごとに `destinations[routeId].payTo` の ATA を導いて `getAccountInfo` → `assertAtaAccount`**（無い・違う → 起動しない。受信の FR-14 と同じ fail closed）。`startup()` が終わるまで `readChallenge`・`pay`・`balanceOf` は throw
- `readChallenge`: 1. 上流の GET（支払いヘッダ無し。静的 = `upstreams[routeId]`、動的 = `target.url` を `parseUpstreamUrl` と拒否ホストで検査）。402 でなければ失敗。
  2. `PAYMENT-REQUIRED` を SDK の `x402HTTPClient.getPaymentRequiredResponse` で読む（EVM の静的 `x402.ts:305-345` と同じ関数を `x402-challenge.ts` に括り出して共有: v2・raw と SDK の件数一致・`resource.url` の一致）。
  3. 各 accepts に §4.2 を掛け、通ったものだけ候補。静的はさらに `destinations[routeId]` と payTo・asset・scheme が一致するものだけ。
  4. 動的: 候補の `payTo` の宛先 ATA を `getAccountInfo` → `assertAtaAccount({ owner: payTo, mint, tokenProgram })`。無い・違う → その offer は候補にしない（`ata_missing`）

### 4.5 `pay(request)`（purchase 時。順序は要件 FR-24）

| # | 段 | 失敗 |
|---|---|---|
| 1 | `capability.network === network`、`request.offer` に §4.2（保存した offer をもう一度。静的は `destinations[routeId]` とも）、`now < request.deadlineMs`、`request.reserveMessage` がある | `not_sent`（`destination_offer_not_allowed`／`destination_deadline`／`destination_reservation_unsupported`） |
| 2 | 上流を読み直し（§4.4 の 1–2）、**保存した offer と `stableJson` で完全一致**する accepts があること（`x402-dynamic.ts:506` と同じ規則） | `not_sent` `destination_offer_changed` |
| 3 | 宛先 ATA の再確認（`getAccountInfo`）。quote の後の消失は防げない——送る直前にもう一度見るだけ | `not_sent` `destination_ata_missing` |
| 4 | `getLatestBlockhash({ commitment: "confirmed" })`。`blockhash` は base58 32 バイト、`lastValidBlockHeight` は 0 より大きい整数（`number` でも 10 進文字列でも）。`fetchedAt = now()` | `not_sent` `destination_blockhash_unavailable` |
| 5 | **期待値を固める**（adapter が自分で決める値だけ。offer からは `feePayer`・`payTo`・`amount`・`memo` だけ）: `expected = Object.freeze({ feePayer, source: RouterのATA, authority: capability.address, destination: 宛先ATA, mint, amount: BigInt(offer.amount), decimals, memo, units: 60_000, microLamports: 1n, blockhash, lastValidBlockHeight, tokenProgram })`——**原始値（文字列・bigint・number）だけの私有 object**。builder には別の写し（`{ ...expected }`）を渡し、`expected` 自体は検査にだけ使う（builder が入力を書き換える変異は検査に届かない）。`memo = offer.extra.memo ?? \`subetha:${paymentId}\``——**既定にも §4.2 の 8 の検査を実行時に掛ける**（`paymentId` は任意の文字列 `src/ports/outbound.ts:87`。既定は UUID なら 44 バイト） | `not_sent` `destination_memo_invalid` |
| 6 | 組み立て: `buildSvmTransactionMessage({ ...expected })`（**`lastValidBlockHeight` を引数に足す**。受信は `0n` のまま渡す `x402-svm.ts:96`）→ `compileTransaction(message)` → `messageBytes`。**snapshot** = `Uint8Array.from(messageBytes)`（以後の照合はすべて snapshot と） | — |
| 7 | **署名前の検査**（`checkSvmOutboundMessage(snapshot, expected)`。純粋関数。**builder と独立**: `buildSvmTransactionMessage` を呼ばず、復号した結果を期待値と 1 欄ずつ照合する）: `getCompiledTransactionMessageDecoder` で復号し（**読み残し無し**）、version 0・lookup table 無し・header **`{ numSignerAccounts: 2, numReadonlySignerAccounts: 1, numReadonlyNonSignerAccounts: 4 }`**（fee payer = 署名・書込、authority = 署名・**読取**（`TransferChecked` の authority は読取専用 `@solana-program/token` `transferChecked.ts:163`）、source・destination = 書込、mint・token program・ComputeBudget・Memo = 読取。計 8 口座）・
  `staticAccounts` が **期待値から kit の規則で独立に算出した並び**と一致（規則: fee payer が先頭、次に署名・書込、署名・読取、非署名・書込、非署名・読取、同じ役割の中はアドレスの順 `@solana/transaction-messages` `compile/v0/accounts.ts:201`。
  `source` と `destination` の相対順はアドレスで変わるので**単一の fixture の順を一般化しない**。試験は相対順が逆になる 2 組の鍵で）・`lifetimeToken === expected.blockhash`・命令が**ちょうど 4 つ**で順に
  (i) program = ComputeBudget、discriminator 2、data 長 5、口座 0、`units` が期待値、(ii) program = ComputeBudget、discriminator 3、data 長 9、口座 0、`microLamports` が期待値、
  (iii) program = token program、discriminator 12、data 長 10、口座 **ちょうど 4**（`[source, mint, destination, authority]`。役割: source 書込・mint 読取・destination 書込・authority 署名）、`amount`・`decimals` が期待値、
  (iv) program = Memo、口座 0、data が `memo` の UTF-8 と byte 一致。`parseSetComputeUnitLimitInstruction`・`parseTransferCheckedInstruction` 等の parser（`@solana-program/*` 0.19.0／0.17.0）は data を復号するだけで discriminator・口座数の上限を検証しない
  （`setComputeUnitLimit.ts:62`・`:103`、`transferChecked.ts:225` は「4 以上」）ので、**program ID・discriminator・data 長・口座数・余剰の有無は検査側が明示的に見る**。builder の変異（別の source・宛先・額・追加の命令・口座の入れ替え・discriminator・余剰の data・余剰の口座）はここで落ち、**署名器は呼ばれない**（AC-9 (c)） | `not_sent` `destination_message_mismatch` |
| 8 | `messageHash = sha256(snapshot)`（`node:crypto`、小文字 hex）。`request.reserveMessage(messageHash)` → `"collision"` → `destination_message_collision`、`"unavailable"` → `destination_message_record_unavailable`。`hooksForTest.afterReserve?.()` | `not_sent` |
| 9 | **もう一度** `now < deadlineMs` と `now - fetchedAt ≤ fetchToSignMs` | `not_sent` `destination_deadline`／`destination_blockhash_stale` |
| 10 | `signature = Uint8Array.from(capability.sign(Uint8Array.from(snapshot)))`（**写しを渡し、返った署名も写して保持**。`Buffer.slice` の共有領域を避ける）。64 バイトで、`ed25519.verify(signature, snapshot, publicKeyBytes)` が true——`publicKeyBytes` は `capability.address` を base58 で復号した 32 バイト（noble は文字列を hex と解釈する。受信の `x402-svm.ts:221` と同じ渡し方）。`hooksForTest.afterSign?.()` | `not_sent` `destination_not_signed` |
| 11 | wire の組み立て: `compileTransaction` が作った署名の map（signer の順。`feePayer → null`、`authority → signature`。**map の列挙順を保つ**——encoder は列挙順で並べる）を `getTransactionEncoder().encode`（null は全ゼロ 64 バイト）。`hooksForTest.wire?.(bytes)`（試験の改変）。**再検査**: (i) `getTransactionDecoder` で復号し、`messageBytes` が snapshot と byte 一致、署名 2 つ・[0] 全ゼロ・[1] が `signature`、読み残し無し、全体 ≤ 1,232 バイト。(ii) base64 にして受信の `checkSvmTransaction(base64, policy, amount, memo)`（`x402-svm.ts:152`。**base64 を受け取る**）を policy `{ feePayer, payTo, destinationAta, mint, decimals, tokenProgram }` で掛ける（第 2 層。`lastValidBlockHeight` は wire に無いので policy に足さない——message には blockhash しか入らない） | `not_sent` `destination_payload_mismatch` |
| 12 | `now < deadlineMs`（送出の直前）。`hooksForTest.beforeSend?.()` | `not_sent` `destination_deadline` |
| 13 | 送出: `PaymentPayload = { x402Version: 2, resource: challenge.resource, accepted: <完全一致した accepts の写し>, payload: { transaction: base64 } }` を `x402HTTPClient.encodePaymentSignatureHeader` で header に。GET、`redirect: "error"`、期限 `paidTimeoutMs`。**1 回だけ**。throw → `unknown` `destination_pay_unknown` | `unknown` |
| 14 | 領収（§5）: `receiptOf(response, approved, { transactionPattern: base58 64 バイト, payerForm: "svm", signerAddress: capability.address })` | 表のとおり |

- `payload` の形は SDK の client（`@x402/svm` `chunk-C3NL2A6D.mjs:124` 付近）が作るものと同じ `{ transaction }`。V-8a の試験で **SDK の client が同じ offer から組む封筒と鍵の集合が一致**することを確かめる（値は blockhash・Memo で違う）
- 署名の後・送出の前に失敗したら（9–12）`not_sent`（未送出が確か）。予約した hash は残る（その message には二度と署名しない。次の購入は新しい blockhash か Memo で別の message になる）

### 4.6 署名の境界（まとめ）

- 署名器に渡るのは **Router が期待値だけから組み、期待値だけで検査した message の bytes の写し**。SDK の提案は読まない（`@x402/svm` の client を使わない。SR-1: dependencies は増えない）
- 順序: 期待値 → 組み立て → **署名前の検査** → hash の予約 → 期限 → 署名 → 署名の検証 → wire の組み立て → **wire の再検査（snapshot との一致＋受信の検査）** → 期限 → 送出
- sabotage（SR-3。AC-12。観測は **signer の回数・渡された bytes**、**支払いヘッダ付きの要求の件数**（challenge の GET は数えない。upstream の `seen.paid`）、journal の行）:
  builder の変異（source・宛先・額・mint・fee payer・compute・Memo・blockhash を 1 つずつ、命令の追加、口座の入れ替え、入力の書き換え）→ 7 で `not_sent`、signer 0、支払い要求 0；
  署名前の検査を外す → その変異で signer が 1 回呼ばれる（試験が落ちる。第 2 層が止めるかどうかに関わらず、**署名の有無**で検出）；
  予約を署名の後に動かす → 並行 2 件で signer 2 回（試験が落ちる）；`reserveMessage` 無しで署名する → 1 の試験で signer 1 回；
  wire の再検査 (i) を外す → `hooksForTest.wire` の改変で支払い要求 1 件（試験が落ちる）；署名の検証（10）を外す → 壊れた署名は 11-(i)（返った署名と wire の一致だけ）を通り、**11-(ii) の `checkSvmTransaction` の ed25519 検証**（`x402-svm.ts:220`）で止まる——
  検出は「10 だけを外したとき、壊れた署名の fixture-key の結果の理由が `destination_not_signed` から `destination_payload_mismatch` に変わる」こと（支払い要求は両方 0）。二重の変異（10 と 11-(ii) を外す）なら支払い要求 1 件
- 独立レビュー: Arc の署名の境界 1 回以上、SVM の署名の境界 **2 回以上**（SR-3）。置き場はタスクの表

## 5. 送信の結果の表（FR-32）

- **Base の静的（`x402.ts` の `rebuildSignatures: false`）は今の処理のまま**（`:519-594`: SDK の `processResponse`、`transaction` は非空文字列、本文の失敗は `unknown`、200 と 502 の分岐、402 と他の 4xx は `rejected`、5xx は `unknown`）
- **それ以外（動的 EVM・静的 Arc・SVM）**は共有の `receiptOf`／`deliveredBodyOf`（§3.2）で次の 1 枚。`form` で EVM（bytes32、`getAddress` 比較）と SVM（base58 64 バイト、文字列比較）を分ける

| 段 | 条件 | 結果 |
|---|---|---|
| 送出前 | 候補外・期限・ATA・blockhash・Memo・署名前の検査・予約・署名・再検査の失敗 | `not_sent`（未送出が確か。理由は §4.5） |
| 送出 | `transport.fetch` が throw（期限・redirect・ヘッダの上限） | `unknown` `destination_pay_unknown` |
| 領収 | `PAYMENT-RESPONSE` を decode、`success === true`、`network` 一致、`transaction` が form の形、`payer` があれば form で署名者と一致 | 整合 → 次へ。`payer` だけ違う → `unknown` `destination_receipt_payer_mismatch`。それ以外の不整合 → 「領収なし」 |
| 整合 ∧ 200 | 本文（`application/json` の object、上限）が読めた | `paid` |
| 整合 ∧ 200 | 本文が読めない・大きい・形が違う | `paid_no_data`（`paid_data_unavailable`／`response_too_large`／`unsupported_response`） |
| 整合 ∧ 200 以外 | | `paid_no_data` `paid_data_unavailable` |
| 領収なし | 2xx | `unknown` `destination_receipt_unverified` |
| 領収なし | ≥ 500 | `unknown` `destination_pay_unknown`（`x402-dynamic.ts:579` の既存の理由名） |
| 領収なし | それ以外 | `rejected` `destination_rejected` |

core の写像は既存（`orchestrator.ts:784-829`）: `paid` → `delivered`、`paid_no_data` → `paid_undelivered`、`not_sent`／`rejected` → `dest_failed`（公開 `paid_data_unavailable`）、他 → `unknown`。

## 6. 本番の入口（FR-30・D-11・D-12）

### 6.1 有効化（`tools/remote-mcp-config.ts:74-94`、`tools/rails-entry.ts:19-43`、`tools/rails-acceptance-run.ts:92`）

```ts
export interface RailActivation { readonly inbound: boolean; readonly outbound: boolean; }
export interface RailsActivation { readonly arc: RailActivation; readonly solana: RailActivation; }
export const RAILS_ACTIVATION: RailsActivation = Object.freeze({ arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false } });
export const RAILS_NONE = { arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: false } };
export const railActive = (a: RailsActivation): boolean => Object.values(a).some((r) => r.inbound || r.outbound);
```

- 内部 env `SUBETHA_RAILS_ACTIVATION` の token を **`arc-in`・`arc-out`・`solana-in`・`solana-out`** に。**旧 token `arc`・`solana` は受け付けない**（復元は未知・重複を拒否、今のまま）。移行は 1 つの PR で揃える:
  受け入れ用の起動の `--rails` の既定を `"arc-in,solana-in"` に、「少なくとも 1 つ」の判定を `railActive` に（`rails-acceptance-run.ts:92-94`。今は boolean 前提）、`announcementOf` の `rails` は新しい token、
  `docs/DEPLOY.md` の実行例（`:154`・`:168`・`:192`）と rollback の文、`tests/wire/rails-process-entry.test.ts`・`tests/unit/rails-entry.test.ts`・`remote-mcp-config.test.ts` の token
- 1 つの値が決めるもの: 設定生成（route・プロファイル・予算の区分・`inboundFacilitators`）、子の env（鍵・RPC の転送）、能力の注入（`routerProcessCapabilitiesOf`）。env で上書きできない（今のまま）
- object 化の後、**受信だけ**を見る箇所（`.inbound` を見る。truthiness で判定しない）: `railsReceiversOf` の両分岐（`tools/rails-entry.ts:51`・`:55`）、`sellerProofs`（`:82`）、Arc の受取鍵の転送（`:131`）、`receiverOf`（`tools/remote-mcp-config.ts:101`）、
  受信の route・`inboundFacilitators`・受信のプロファイルの生成。**送信だけ**: 送信の route・プロファイル、送信の鍵、`evmSigningByNetwork`／`svmSigning`。**どちらか**: Solana RPC（依存先・拒否ホスト・子の env）、予算の区分
- G-2′ は `outbound: false` のまま配備、G-4′ でレールごとに `true`

### 6.2 鍵と env（`tools/remote-mcp.ts:89-150`、`tools/rails-entry.ts:102-143`）

| env | 用途 | いつ読む・渡す |
|---|---|---|
| `SUBETHA_OUTBOUND_X402_KEY`（既存。既定は `SUBETHA_OUTBOUND_PRIVATE_KEY`） | Base **と Arc** の x402 送信（同じ鍵。D-11） | **生成した設定に `rail: "x402"` の送信（route かプロファイル）があるとき**子に渡す（今は MPP 受信のときだけ `:124`。Arc／Solana 受信 → Base 送信の動的プロファイルも x402 送信なので、今の条件では漏れる `remote-mcp-config.ts:167`） |
| `SUBETHA_OUTBOUND_SOLANA_KEY`（新） | Solana の送信（ed25519。`wallet:new:solana` と同じ base58 32 バイトの seed） | `solana.outbound` のときだけ読む・渡す |
| `SUBETHA_SOLANA_RPC_URL`（既存） | 受信の検査・追跡・**送信**の RPC | `solana.inbound ∨ solana.outbound` |
| `SUBETHA_ARC_PROVIDER_PAYTO`・`SUBETHA_SOLANA_PROVIDER_PAYTO`（新） | Provider の受取先（D-10。Arc は `0x`、Solana は owner の公開鍵） | **静的 route を生成するときだけ必須**（§6.3。無ければ静的 route を出さない。動的だけの構成では要らない） |

`routerProcessCapabilitiesOf`（同期のまま）: `evmSigning` = Base（今のまま）、`evmSigningByNetwork = arc.outbound ? { "eip155:5042002": createRealEvmCapability(evmKey).capability("eip155:5042002") } : {}`、
`svmSigning = solana.outbound ? { [SOL]: createRealSvmCapability(solKey).capability(SOL) } : undefined`、`dependencyUrls` に Solana RPC（受信か送信）。無効な方向の専用鍵は読まない（`SUBETHA_OUTBOUND_SOLANA_KEY`）。

### 6.3 route・プロファイル・予算（`tools/remote-mcp-config.ts`）

| 種類 | ID | 受信 | 送信 | 上流 | 生成の条件 |
|---|---|---|---|---|---|
| 静的 | `md-arc-eth-snapshot` | Base USDC（x402） | Arc USDC（x402）、`payTo` = `SUBETHA_ARC_PROVIDER_PAYTO` | `UPSTREAM_ARC`（定数） | `arc.outbound` ∧ `UPSTREAM_ARC` が空でない ∧ env の受取先あり |
| 静的 | `md-sol-eth-snapshot-mpp` | Tempo pathUSD（MPP） | Solana USDC（x402）、`payTo` = `SUBETHA_SOLANA_PROVIDER_PAYTO` | `UPSTREAM_SOL` | `solana.outbound` ∧ MPP 受信あり ∧ `UPSTREAM_SOL` ∧ 受取先 |
| 動的 | `dyn-x402-to-arc`・`dyn-mpp-to-arc` | Base x402／Tempo MPP | Arc x402（`tokenDomain` USDC/2、`decimals` 6、`maxUpstreamAmount` 10000、fee flat 1000） | 呼び出し側 | `arc.outbound`（MPP 受信のものは MPP 受信あり） |
| 動的 | `dyn-x402-to-sol`・`dyn-mpp-to-sol` | Base x402／Tempo MPP | Solana x402（`decimals` 6、`tokenProgram` 表） | 呼び出し側 | `solana.outbound`（同上） |

- 定数 `OUTBOUND_ARC = { network, asset: 0x3600…, decimals: 6 }`、`OUTBOUND_SOL = { network, asset: 4zMMC9…, decimals: 6, tokenProgram }`（`payTo` は env）。`UPSTREAM_ARC`／`UPSTREAM_SOL` は Provider が立つまで空文字
- **公開する行列はこの 6 本で固定**（D-12）。O-5・O-6（Arc ↔ Solana）は生成しない。足すときは要件 D-17（par の宣言、AC-13／AC-14 と同じ購入、G-3′・G-4′）
- 予算の区分: `railBuckets`（`:217-220`）は **その network が受信か送信のどちらかで有効**なら Arc USDC・Solana USDC の区分を出す（今は受取先の有無 = 受信）。静的・動的とも。上限は D-14（既存と同じ桁）
- `x402.upstreams` に新しい静的 route の URL。MPP 受信の route／プロファイルは `SUBETHA_MPP_INBOUND_SECRET` があるときだけ（既存の規則）

### 6.4 `tools/real-svm-capability.ts`（新）・`tools/svm-key.ts`（新）

- `svmSeedFromKey(key: string): Uint8Array`（同期。`tools/svm-payer.ts:37-56` の `svmSignerFromKey` の解析の部分を取り出す: base58 64 バイト（先頭 32 が seed）／32 バイト／hex seed）。`svm-payer.ts` はこれを使って kit の signer を作る（今のまま非同期）
- `createRealSvmCapability(key)`（**同期**。`routerProcessCapabilitiesOf` と `remote-router-process.ts:31` は同期で呼ぶ）: `seed = svmSeedFromKey(key)`、`address = base58(ed25519.getPublicKey(seed))`、`sign(bytes) = ed25519.sign(bytes, seed)`（`@noble/curves/ed25519`。受信の検証と同じ library）。
  鍵の文字列は保持しない（seed は closure の中。EVM の `privateKeyToAccount` が鍵を持つのと同じ扱い）。`signCount()`（試験用）
- `capability(network): SvmSigningCapability { network, address, sign, kind: "real-key" }`

### 6.5 DEPLOY・CLAUDE.md・README

- `docs/DEPLOY.md` §2c に送信の段（G-1′〜G-4′）: env の 3 本（鍵・Provider の受取先）、`wallet:new:solana` で送信鍵を作る手順、Router の ATA の作成（運用者。`spl-token create-account` 相当は Router の外。rent は運用者）、
  残高の見方（`getTokenAccountBalance`）、有効化の token（新旧）、V-8b（実 facilitator の probe）は G-3′ の前に owner の承認で別に行い、公開の Router は止めて受け入れ用の起動で
- CLAUDE.md: 一覧の表に 2 行（`md-arc-eth-snapshot`: pay Base USDC → Arc の Provider、`md-sol-eth-snapshot-mpp`: pay Tempo pathUSD → Solana の Provider）とプロファイル 4 本。呼び出し側の手順は変わらない（FR-31）

## 7. 試験と fixture（AC-8〜AC-12）

### 7.1 fixture

- **Arc の Provider**: `tests/fixtures/dynamic/x402-upstream.ts` の `standardAccept(overrides)`（`:118`）で `network: ARC, asset: ARC_USDC, extra: { name: "USDC", version: "2" }`、`paidOk(payer, body, network = FIXTURE_NETWORK)` に network の引数を足す。
  署名の検証は `tests/fixtures/dynamic/verifying-facilitator.ts`（requirements から chainId・contract を導く `:66`・`:76`。引数化は不要）
- **Solana の Provider**（新 `tests/fixtures/svm-upstream.ts`）: 402 で SVM の accepts（`feePayer` は fixture の facilitator の `/supported` から、`extra.memo` は試験ごとに有無）を返し、`PAYMENT-SIGNATURE` を受けたら fixture の SVM facilitator
  （`tests/fixtures/svm-facilitator.ts`。本物の `@x402/svm` の facilitator、simulate／send／confirm は差し替え `:109`）に `/verify` → `/settle` し、200 と `PAYMENT-RESPONSE { success, transaction: <署名>, network, payer }` を返す。
  `state` で: 固定 Memo、乱数 Memo（V-12 の再現）、`recentBlockhash` 入り、`feePayer` を Router の公開鍵に、`payTo` を運用者に、500、**`dropAfterSettle`（facilitator の settle が返った後に socket を切る**。既存の `dropSettle` は settle の前 `:203`）。
  `seen` に受けた payload（transaction の bytes）と回数
- **Solana RPC**（`tests/fixtures/solana-rpc.ts`）に `getTokenAccountBalance` と、宛先 ATA の有無（`state.atas` の複数化）を足す。`getLatestBlockhash` は既に `lastValidBlockHeight: 1000`
- **署名器**（`tests/fixtures/svm-signer-fixture.ts`）: 試験用の seed で**本当に署名**し（`ed25519.verify` を通る成功の経路を作る）、`sign` の回数と渡された bytes を記録。`kind: "fixture-key"`。改変の試験用に「壊れた署名を返す」モード
- **MPP**: 既存の fixture のまま（運用者宛ての受取先と期限の試験を足す。§7.2）

### 7.2 試験の置き場

| 層 | ファイル | 内容 |
|---|---|---|
| unit | `tests/unit/svm-offer-check.test.ts` | §4.2 の各行の肯定・否定、不等式の各組（feePayer・payTo・ATA） |
| unit | `tests/unit/svm-outbound-message.test.ts` | 期待値 → 組み立て → 署名前の検査（各欄の変異で落ちる）→ hash → 署名 → wire → 再検査の往復、`lastValidBlockHeight`、Memo の既定と実行時の検査 |
| unit | `tests/unit/message-reservation.test.ts` | `IntentStore.reserveMessage`: 直列の衝突（同じ paymentId からも）、形の悪い hash・状態の違う intent → `unavailable`、journal 追記の失敗 → `unavailable`、replay で復元、壊れた行で起動しない、再起動後の別 paymentId の衝突 |
| unit | `tests/unit/outbound-composition.test.ts` | `(rail, network)` の合成: 欠落・重複・key と network の不一致・family 不一致で起動しない、`railByRoute` が組で引く、運用者の集合の構成（(a)(b)、ATA は startup）、Solana RPC の拒否ホスト（受信無し・送信あり）、残高の配線の順（rail → 能力 → なし） |
| unit | `tests/unit/remote-mcp-config.test.ts`・`rails-entry.test.ts`・`rails-acceptance-run.test.ts` | 方向別の有効化の生成・復元（旧 token の拒否）、鍵を読まない、静的 route の生成の条件、x402 送信の鍵の転送の条件、区分の生成、受け入れ用の既定 |
| wire | `tests/wire/x402-arc-outbound.test.ts` | 静的（組み直し）・動的、Base 用の能力で Arc の offer → `not_sent` と Arc 用で Base → `not_sent`（AC-8 の両方向）、`assetTransferMethod`（V-6 の結果で）、Base の静的の既存試験が変わらない |
| wire | `tests/wire/x402-svm-outbound.test.ts` | §4.5 の各段の失敗（AC-10 の列挙）、改変（AC-9）: (a) 初見の offer の違反 → 候補外（signer 0・HTTP 0）、(b) 保存した offer からの変更 → `destination_offer_changed`（signer 0）、(c) builder の変異 → 署名前の検査で `not_sent`（signer 0）、(d1) 署名器が壊れた署名を返す → `not_sent`、(d2) `hooksForTest.wire` の改変 → 再検査で `not_sent`（HTTP 0）。固定 Memo の並行 2 件（2 件目 `collision`、signer 1 回）。**中断**（throw では core が捕まえてその場で `unknown` を書く `orchestrator.ts:765` ので証拠にならない）: Router を**子 process**で起動し、`afterReserve`／`afterSign`／`beforeSend` の hook で `process.kill(process.pid, "SIGKILL")`（core の catch と終端の追記を通さない）→ journal に予約の行があり intent が `destination_pending` のまま → 同じ journal で再起動 → `interrupted_at_restart` で `unknown`（`store.ts:384`）、signer 0・支払い要求 0 → 別の paymentId で同じ message → `collision`。`dropAfterSettle` → `unknown`、再起動後も再送信 0。SDK の client の封筒との鍵の一致（V-8a） |
| wire | `tests/wire/mpp-outbound.test.ts`・`mpp-dynamic-outbound.test.ts`（既存に追加） | 運用者宛ての受取先 → 候補外；期限: credential の生成の中（署名の委譲の直前）で切れる → `not_sent`・署名 0・送金 0；**署名の後・送金 RPC の前**で切れる → `not_sent`・署名 1・送金 0（静的・動的とも）；broadcast の後に切れる → 既存の「送金済みかもしれない」結果のまま（`not_sent` にならない） |
| integration | `tests/wire/multirail-integration.test.ts` | 公開する組（静的 O-1・O-4、動的 O-1〜O-4。D-12）の `delivered`（能力は `evmSigningByNetwork[ARC]`・`svmSigning[SOL]` を注入）、残高の hook（静的・動的、不足と RPC 失敗）、既存の経路が変わらない |
| process | `tests/wire/rails-process-entry.test.ts` | 方向別の token、送信の鍵の注入、無効な方向で env を読まない、静的 Solana route の ATA の起動時の検査で止まる |

fixture の facilitator は simulate／send／confirm を模擬するので、**実 ATA の増分・compute の消費・finality は offline では観測できない**（V-8b と AC-13／AC-14 で）。

### 7.3 完了の条件（タスクに写す）

- 既存の suite が緑のまま（Base の静的・動的の挙動は §2.3・§2.4 の追加以外変えない）
- Linux（`node:22-bookworm`）で全部緑。sabotage の表（§4.6 と、能力の束縛・表・予算の区分・領収の形・運用者の集合を外した変異）を PR に
- AC-13／AC-14: 公開する組（静的 2・動的 4）**すべて**で各 1 件。記録: 両レグの tx（受信の settle、Provider 側の facilitator の tx: Arc は RPC で `success` と転送の内容、Solana は devnet で finalized と Provider の ATA の増分）、
  送受取先・額、Provider の応答の本文、client が受けた結果、保存した結果の再読取（`subetha_router_status`）。公開の Router は止めて受け入れ用の起動で（SR-5）
- SR-3 の独立レビュー: Arc の署名の境界 1 回以上（§3.2 の PR）、SVM の署名の境界 2 回以上（§4 の adapter の PR と、統合の PR）
- AC-11（公開の後、G-4′ ごと）: 公開 MCP を HTTPS で直接呼び、一覧に新しい route／プロファイルが出ること、`subetha_router_quote`／`quote_url` の `subject` の送信先（network・asset・decimals）と `disclosures` が設定どおりであること（各組 1 回。支払わない）を記録。CLAUDE.md の表と一致

## 8. `npm run sign`・呼び出し側

変わらない（FR-31）。`sign-dispatch.ts` の `classifyOffer` は受信の表を見るだけで、送信の表の変更に影響されない（`entry.inbound` を見る `:55`）。

## 9. 新しい依存

無し。`@solana/kit`・`@solana-program/*`・`@noble/curves` は既に dependencies、sha256 は `node:crypto`。`@x402/svm` は devDependency のまま（fixture の facilitator だけ）。

## 10. 未解決（設計の中で消せないもの）

| # | 内容 | 扱い |
|---|---|---|
| U-6 | `extra.assetTransferMethod`（V-6）。Arc の Provider（Circle の server 側）が出すか | Provider の 402 を取ってから §3.1 の分岐を決める。タスクの中で `curl` の記録を残す |
| U-7 | Provider の offer の安定性（V-12）。SDK の server が乱数 Memo を出す構成なら完全一致が成り立たない | Provider 側で Memo を固定するか出さない（owner の Provider の設定）。Router は緩めない |
| U-8 | 取得〜署名の上限 5 秒の妥当性（RPC の遅さ） | 本番の RPC で測って決める（G-3′）。上限は設定ではなく定数 |
| U-9 | Solana の fixture の facilitator は simulate を模擬するので、compute の消費の証拠は実 facilitator（V-8b）でしか得られない | V-8b を G-3′ の前に 1 回（owner の承認。資金が動く） |

## 11. 変更するファイル

| ファイル | 変更 |
|---|---|
| `src/config.ts` | 表の `outbound`、`TermsToValidate.tokenProgram`、`DynamicProfile.destination.tokenProgram`、`parseDynamicProfile` の family 分岐 |
| `src/ports/outbound.ts` | `SvmSigningCapability`、`PayRequest.deadlineMs`・`reserveMessage`、`OutboundRail.balanceOf?`・`startup?` |
| `src/main.ts` | `RouterCapabilities`（`evmSigningByNetwork`・`svmSigning`）、`(rail, network)` の合成と起動時の検査、運用者の集合、Solana RPC の条件、`svmRpcTransportOf`、残高の配線（rail → 能力 → なし）、SVM の `startup` を `startupChecks` に |
| `src/core/store.ts`・`src/core/journal.ts`（event 名） | `destination_message_reserved`、`reserveMessage`、replay（壊れた行で止める） |
| `src/core/orchestrator.ts`・`src/core/dynamic.ts` | `PayRequest` の 2 欄、静的の残高の hook（`source_pending` の前）、`balanceOf` の `undefined` = 検査なし |
| `src/adapters/outbound/x402.ts` | `rebuildSignatures`、候補の段階の運用者の照合、Base の guarded signer の委譲の直前の期限、Arc の経路（動的と同じ） |
| `src/adapters/outbound/x402-dynamic.ts` | `createRebuildingSigner` の引数と期限、`receiptOf`／`deliveredBodyOf` の module 化（form・依存を引数に）、運用者の集合、（V-6）`assetTransferMethod` |
| `src/adapters/outbound/mpp.ts`・`mpp-dynamic.ts` | 運用者の集合（受取先）、期限（credential の直前・送出の直前） |
| `src/adapters/outbound/x402-challenge.ts`（新） | 402 の読み取りの共有 |
| `src/adapters/outbound/x402-svm.ts`（新） | §4（`checkSvmOffer`・`checkSvmOutboundMessage`・adapter） |
| `src/adapters/inbound/x402-svm.ts`・`x402-svm-startup.ts` | `buildSvmTransactionMessage` の `lastValidBlockHeight`、`svmFetchJson` の export |
| `tools/remote-mcp-config.ts`・`rails-entry.ts`・`remote-mcp.ts`・`rails-acceptance-run.ts`・`remote-router-process.ts`（固定文） | 方向別の有効化と token、route／プロファイル／区分、env、能力 |
| `tools/real-svm-capability.ts`・`tools/svm-key.ts`（新）、`tools/svm-payer.ts` | §6.4 |
| `tests/fixtures/*`・`tests/unit/*`・`tests/wire/*` | §7 |
| `docs/DEPLOY.md`・`CLAUDE.md`・`README.md` | §6.5 |

## 12. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-07 | `gpt-6-astra`（read-only。第 1 版 `8c1889f`） | **REJECT**（10 項目: 署名前の検査の欠落と `checkSvmTransaction` の性質、`feePayer` と候補の段階の運用者の照合、Base の静的の領収の互換、`startup` と非同期の配線、期限の検査の位置と MPP、残高の hook の失敗の契約、RPC helper の封筒と回数、Memo の実行時検査と予約の契約、有効化の移行と子の env の条件、試験の観測点）。第 2 版で反映 |
| 2 | 2026-10-07 | `gpt-6-astra`（read-only。第 2 版 `1f94224`） | **REJECT**（5 項目: 署名前の検査を builder と独立に、noble の公開鍵の渡し方、MPP の期限は実署名・送金 RPC の直前で broadcast 後は `not_sent` にしない、crash の試験は子 process の停止で、AC-11 の完了確認）。第 3 版で反映 |
| 3 | 2026-10-07 | `gpt-6-astra`（read-only。第 3 版 `a57dd0c`） | **REJECT**（4 項目: header は 2／1／4 と口座の並びの規則、parser は検証しないので program ID・discriminator・data 長・口座数・読み残しを明示、step 10 の sabotage の検出は理由の変化で、MPP の期限の拒否の `not_sent` への写像）。第 4 版で反映 |
