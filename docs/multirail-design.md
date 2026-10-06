# 設計: Arc と Solana で払う（S-1・S-2。第 2 版、2026-10-06）

> 要件は `multirail-requirements.md`（owner の決定 §0、確認の結果 §2.5）。本書は **S-1（Arc の USDC で払って既存の上流に届く）** と **S-2（Solana devnet の USDC で払って既存の上流に届く）** の設計。
> S-3・S-4（送信）は別紙。**FR-2（network ごとの `evmSigning`）は S-3 に送る**（第 1 版の受信では送信の鍵に触れない）。原則は既存の設計（`dynamic-upstream-design.md`・`ssrf-*`）を継ぐ:
> core はレールの port 越しにだけ外へ出る、署名・検査の境界は確かめた値だけで組む、`src/` の外への接続はすべて SSRF 防御 A の transport、鍵は `tools/` だけが env から読む、testnet だけ。
>
> 第 1 版からの主な訂正（独立レビュー #1、§12）: SVM の `payTo` は **owner の公開鍵**で ATA ではない（SDK の client・facilitator とも owner から ATA を導く）。SVM の preflight は
> 「Router が同じ値から組み直した message と **byte 単位で一致**」＋ **ed25519 の同期検証**。決済の結果の表を 1 つにし、要求が出た後の失敗は `unknown`。facilitator の表は設定ファイル。

## 0. 一枚で

| | S-1 Arc | S-2 Solana |
|---|---|---|
| 受信 adapter | 既存の `createX402Inbound` に **facilitator の種類**（`x402` ／ `circle`）と **売り手証明の能力**を足す | 新しい `createX402SvmInbound`。facilitator は x402.org（SVM `exact`、v2） |
| offer の `payTo` | Arc 上の**証明専用の受取鍵**のアドレス（`0x`） | Router の受取 **owner の公開鍵**（base58）。資金は owner の **ATA** に入る。実行時に Router は署名しない |
| Router が自分で確かめること | 既存の preflight（nonce・期限・束縛・offer の完全一致）＋ EIP-3009 の authorization の束縛（既存） | 既存の preflight ＋ **message の組み直しと byte 一致**＋ **署名の検証**（§5.3） |
| 新しい外部接続（すべて guarded transport） | Circle の facilitator（`/verify`・`/settle`） | x402.org の facilitator（`/supported` を起動時、`/verify`・`/settle`）、起動時だけ Solana の RPC（ATA の検査） |
| 新しい鍵 | 証明専用の受取鍵（EIP-712 `SellerRequest` にだけ署名。資金を動かす型には署名できない） | 無し（owner の公開鍵は設定値） |
| 呼び出し側の道具 | `npm run sign` が表から chainId と domain を引く | `npm run sign` が **固定値だけで** SVM の transaction を組んで部分署名（新規 `tools/svm-payer.ts`。SDK の client は使わない） |

## 1. network の表（FR-3）

`src/config.ts` に**列挙の表**（コードだけ。env・設定ファイルからは変えられない）:

```ts
export interface KnownNetwork {
  readonly network: string;                       // CAIP-2
  readonly family: "evm" | "svm";
  /** この network で許す向きとレール（第 2 版）。表に無い組は config_invalid。 */
  readonly inbound: readonly ("x402" | "mpp")[];  // sourceRail
  readonly outbound: readonly ("x402" | "mpp")[]; // rail（静的の destination・動的の rail）
  readonly x402Facilitator?: "x402" | "circle";   // x402 受信の facilitator の種類（受信 x402 のときだけ）
  readonly assets: readonly {
    readonly id: string;                          // EVM: 0x アドレス（比較は小文字化）。SVM: mint（base58。比較はそのまま）
    readonly decimals: number;
    readonly domain?: { name: string; version: string };   // EVM/x402 の EIP-712 domain（x402 で使う資産に必須）
    readonly tokenProgram?: string;               // SVM に必須
  }[];
}
```

| network | family | inbound | outbound | x402 facilitator | 資産 |
|---|---|---|---|---|---|
| `eip155:84532` | evm | x402 | x402 | `x402` | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`、6、domain USDC/2 |
| `eip155:42431` | evm | mpp | mpp | — | pathUSD `0x20c0000000000000000000000000000000000000`、6（domain 無し） |
| `eip155:5042002` | evm | x402 | —（S-3） | `circle` | USDC `0x3600000000000000000000000000000000000000`、6、domain USDC/2 |
| `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | svm | x402 | —（S-4） | `x402` | USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`、6、token program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |

照合（`parseRouterConfig(raw, { networks })`。**既定は `KNOWN_NETWORKS`**、試験の harness は自分の表を渡す——synthetic の `eip155:11155111`・偽の資産・指紋の試験の `eip155:1` 等は
**試験の表**に載せて同じ検査を通す。本番の入口 `tools/remote-mcp-config.ts`・`src/main.ts` は既定の表しか使えない）:

- route・プロファイルの `source`／`destination` ごとに、`network` が表にあり、向きとレールが `inbound`／`outbound` にあり、`asset` が表の資産に一致し（family 別の比較）、`decimals` が一致すること
- x402 の destination の `tokenDomain` は表の `domain` と**一致**すること（今は任意の文字列を受ける `src/config.ts:541-545` を締める）
- `payTo` の形は family で分ける: evm は `0x` ＋ 40 hex、svm は base58 を decode して **32 バイト**（owner の公開鍵。ATA ではない）
- 違えば `config_invalid`。既存の本番設定は表に合う（回帰なし。試験の設定は試験の表で守る）
- 残高・予算の区分の鍵は**設定に書かれた文字列をそのまま**使う（今の `budget.ts` と同じ。書き換えない）。offer との比較だけ `assetKeyOf(network, asset)`（evm: 小文字化、svm: そのまま）に通す。
  `src/core/dynamic.ts:631` の小文字化はこれに置き換える
- Arc のネイティブ USDC（18 桁）は表に無いので設定できない（FR-7）

## 2. facilitator を network ごとに（FR-1）

設定ファイルの `x402` 節（今は `upstreams` だけ）に **`inboundFacilitators`** を足す（env ではなく設定ファイル。URL の規則は既存の `assertAbsoluteHttpUrl`: 絶対 http(s)、**query・userinfo・fragment 禁止**）:

```json
"x402": {
  "upstreams": { "...": "..." },
  "inboundFacilitators": {
    "eip155:5042002": { "kind": "circle", "url": "https://api.circle.com/v1/facilitator/x402" },
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": { "kind": "x402", "url": "https://www.x402.org/facilitator" }
  }
}
```

- `kind` は表の `x402Facilitator` と一致すること（Arc に `x402` を書けば `config_invalid`）
- 既存の env `ROUTER_X402_INBOUND_FACILITATOR_URL` は **`eip155:84532` の facilitator**として残す（互換）。`inboundFacilitators` に `eip155:84532` も書かれていれば `config_invalid`（優先順位を持たない）
- 起動時: `sourceRail: "x402"` の route／プロファイルの network ごとに facilitator があること。無ければ `config_invalid`
- すべての facilitator のホストを拒否ホストと `dependencyUrls` に入れる（既存の `denyHostsOf` の入力に足す）
- loopback の URL は、既存どおり `fixtureFacilitators` の能力があるときだけ（本番の入口は渡さない）

## 3. 能力の注入（`RouterCapabilities`）

```ts
readonly sellerProofs?: Readonly<Record<network, SellerProofCapability>>;   // S-1。kind "circle" の network に必須
```

```ts
interface SellerProofCapability {
  readonly network: string;        // 作るときに固定
  readonly address: Hex;           // payTo（この鍵のアドレス）
  /** header の値（base64url の封筒）を返す。時刻・nonce・method は能力の中で決める。 */
  proofFor(purpose: "verify" | "settle", bodyHash: Hex, nowMs: number): Promise<string>;
}
```

- `tools/real-seller-proof-capability.ts` が env `SUBETHA_ARC_RECEIVER_KEY` から作る（`src/` は env を読まない。SR-5 の正確な形: **受取鍵の秘密鍵はホストにあり、`src/` に渡るのは
  `proofFor` の閉包だけ**。この鍵の資金は受取先として受けた USDC で、鍵で動かせるのは `tools/` の運用者の操作だけ）
- 能力の中で固定: EIP-712 domain `{ name: "Circle Facilitator Seller Request", version: "1", chainId: 表の network の chainId }`（verifyingContract 無し）、型 `SellerRequest{purpose,method,bodyHash,network,payTo,nonce,issuedAt,expiresAt}`、
  `method = "POST"`（verify・settle。`status` は第 2 版では**持たない**）、`network = this.network`、`payTo = this.address`、`nonce = CSPRNG 32 バイト`（要求ごと）、
  `issuedAt = floor(nowMs/1000)`、`expiresAt = issuedAt + 60`（整数。`issuedAt < expiresAt`、寿命 60 秒 ≤ Circle の上限 300 秒、`issuedAt` は Circle の「現在＋30 秒以内」の内側）
- **それ以外の typed data には署名しない**: `signTypedData` も生の署名も公開しない。`purpose` は列挙、`bodyHash` は 32 バイトの hex であることを確かめる。EIP-3009 の
  `TransferWithAuthorization`（domain `{name:"USDC", version:"2", chainId, verifyingContract}`）とは domain も型も違うので、この能力から資金を動かす署名は得られない
- 起動時: kind `circle` の network の route／プロファイルの `source.payTo` が `sellerProofs[network].address` と一致し、`sellerProofs[network].network` がその network であること。違えば起動しない
- D-5 の「既存と同じ鍵」は要件 §2.5 V-1 の補足どおり**証明専用の新しい受取鍵**に読み替える（要件 §0 に注記を足す）

## 4. S-1: Arc の受信（`createX402Inbound` の拡張）

### 4.1 変更点

| 項目 | 今 | 変更 |
|---|---|---|
| `assetDomain` | 既定 USDC/2 | 表から渡す（network・asset で引く） |
| offer の有効期間と wire の `maxTimeoutSeconds` | 同じ値（`maxTimeoutSeconds` = 有効期間 = `ROUTER_X402_INBOUND_OFFER_SECONDS`） | **分ける**: `offerSeconds`（有効期間。`extra.expiresAt`、承認期限。既存の env）と `maxTimeoutSeconds`（wire。facilitator が settle を待つ窓）。kind `x402` は**両方とも今の値**（wire の挙動を変えない）。kind `circle` は wire **30 秒** |
| HTTP の期限 | verify・settle とも 10 秒 | verify 10 秒。settle は **`maxTimeoutSeconds + 10` 秒**（circle: 40 秒。kind `x402` は今の 10 秒のまま） |
| requirements の `extra` | `name`・`version`・`challengeNonce`・`expiresAt`・`routeBinding`・`fundsMoveOnCredential` | circle は **`assetTransferMethod: "eip3009"`** を足す。発行 extra のキー集合は kind ごと（preflight の「未知キー拒否」はその集合で）。`accepted` は offer の完全一致を要求するので requirements と `accepted` は常に同じ値 |
| 要求のヘッダ | `content-type` だけ | circle は `Facilitator-Seller-Proof`（§4.2）。API key は使わない（D-8） |
| settle の結果 | §6 の表（kind `x402` は今のまま） | §6 の表 |

### 4.2 売り手証明の作り方

```
body      = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements })   // 1 度だけ直列化し、この文字列をそのまま送る
bodyHash  = keccak256(utf8(body))
header    = await capability.proofFor(purpose, bodyHash, now())                      // purpose は呼ぶ endpoint と同じ
```

- 証明が作れない（能力が拒む・例外）→ **要求を出さない**: verify なら `isValid: false`、settle なら `rejected`（`source_rejected`、§6 の「要求前」）
- `purpose` ごとに nonce は新しい（Circle は `(network, payTo, purpose)` で一意を要求する）

### 4.3 試験の fixture

`tests/fixtures/circle-facilitator.ts`: loopback の facilitator で、**売り手証明を検証する**（header を decode し、EIP-712 で recover して `payTo` と一致、`bodyHash` が受けた body の keccak256 と一致、
`purpose` が endpoint と一致、`issuedAt`・`expiresAt` の規則、nonce の再使用拒否）。証明が無い・違う・古い・再使用の要求は 401。`assetTransferMethod` を要求する。settle は
`success/transaction/network/payer` と `extensions.settlement-status` を返し、状態で `settlement_pending`・`403 registration_required`・409・`transaction` の形崩れ・`network` 違いに切り替えられる。
試験は AC-3（否定: 証明の各欄の改変）・AC-4（§6 の表の各行）・要求の回数（settle は 1 回だけ）を数える。

## 5. S-2: Solana の受信（新規 `src/adapters/inbound/x402-svm.ts`）

### 5.1 offer

```
scheme: "exact", network: "solana:Et…", asset: <mint>, amount, payTo: <owner の公開鍵>, maxTimeoutSeconds: 40,
extra: { feePayer: <起動時に固定>, memo: challengeNonce, challengeNonce, expiresAt, routeBinding, fundsMoveOnCredential: false }
```

- **`payTo` は owner**（SDK の client は `findAssociatedTokenPda({ mint, owner: payTo })` で宛先を導き、facilitator も同じ導出で宛先を照合する。`@x402/svm` 2.28.0
  `chunk-C3NL2A6D.mjs:74`、`exact/facilitator/index.mjs:745`）。Router は起動時に同じ導出で **宛先 ATA** を求め、adapter に固定する
- 起動時の ATA の検査（FR-14）: guarded transport（動的と同じ方針: loopback 不可、DNS 期限 3 秒、応答 64 KiB 以下、HTTP 期限 10 秒）で `SUBETHA_SOLANA_RPC_URL`
  （既定 `https://api.devnet.solana.com`、ホストは拒否ホストと `dependencyUrls`）に `getAccountInfo(ata, { encoding: "jsonParsed" })` を 1 回。`owner === program（表の token program）`、
  `data.parsed.info.owner === payTo`、`data.parsed.info.mint === 表の mint` を要求。読めない・違う → 起動しない（fail closed）。quote・purchase の中では RPC に出ない（FR-18）
- `extra.memo = challengeNonce`（facilitator も照合する。`index.mjs:790-810`）
- `feePayer` は起動時に facilitator の `/supported` から読む（`kinds[]` の `network === この network && scheme === "exact"` の `extra.feePayer`）。**1 つに固定**し、quote ごとに読まない。
  読めない・無い → 起動しない。変われば再起動（FR-15）
- `maxTimeoutSeconds` は wire の値（40）。offer の有効期間は `offerSeconds`（§4.1 と同じ分離）

### 5.2 credential

`payload: { challengeNonce, transaction: <base64 の部分署名 versioned transaction> }`。`accepted` は offer の完全一致（既存の preflight と同じ規則）。

### 5.3 preflight（同期。Router が自分で確かめる。FR-16）

既存の検査（nonce・期限・`accepted` の完全一致・未知キー）に加え、facilitator に渡す前に、**純粋関数だけ**で（ネットワークに出ない。`@solana/kit` の codec と `@noble/curves` の ed25519）:

| # | 検査 | 失敗の理由 |
|---|---|---|
| 1 | `transaction` は base64（`[A-Za-z0-9+/=]`、長さ ≤ 1,644）で、decode 後 **≤ 1,232 バイト**（Solana の packet の上限）。decode は `getTransactionDecoder().read` で行い、**読み残しが無い**こと | `credential_mismatch` |
| 2 | 署名の欄: 署名の数 = 2。**[0]（fee payer）は wire が全ゼロ 64 バイト**（decoder は null に写すので、wire の bytes も見る）、**[1]（authority）は 64 バイト**で、`ed25519.verify(sig, messageBytes, staticAccounts[1])` が **true**（`@noble/curves/ed25519`、同期） | `credential_mismatch` |
| 3 | message を `getCompiledTransactionMessageDecoder` で復号: version 0、`addressTableLookups` 無し（legacy・lookup table は拒否）、`staticAccounts[0] === feePayer`（固定値）、`header.numSignerAccounts === 2` | `credential_mismatch` |
| 4 | **組み直し**: 提出された message から取るのは `lifetimeToken`（blockhash）、命令 0 の `units`、命令 1 の `microLamports`、`TransferChecked` の `source`、`staticAccounts[1]`（authority）だけ。それに Router の固定値（feePayer、宛先 ATA、mint、decimals、offer の `amount`、memo = challengeNonce、token program）を合わせて `@solana/kit` で **同じ version 0 の message を compile し、`getCompiledTransactionMessageEncoder` の bytes が `messageBytes` と一致**すること。これで命令の数（**ちょうど 4**: SetComputeUnitLimit・SetComputeUnitPrice・TransferChecked・Memo の順）、各命令の program・口座の数と役割・data の長さと値、口座の並びと header、fee payer がどの命令の口座にも現れないこと、追加の口座・data が無いことが 1 度に決まる | `credential_mismatch` |
| 5 | 取った値の範囲: `units ≤ 200,000`、`microLamports ≤ 5,000,000`（facilitator の上限と同じ。`chunk-RXPBSPMZ.mjs:14`）、`source ≠ feePayer`、`source ≠ 宛先 ATA`、`authority ≠ feePayer`、`authority ≠ payTo` | `credential_mismatch` |
| 6 | Memo の data（UTF-8）`=== challengeNonce`（組み直しに含まれるが、理由を分けるために先に照合する） | `nonce_mismatch` |

- facilitator（v2 の静的経路 `index.mjs:670-830`）は命令 3〜7、Lighthouse・Memo の任意の追加、2 つの token program、smart wallet の経路を許す。Router は**自分が発行した形**（`npm run sign` が組む形）
  だけを通す。別の wallet が作った、facilitator は受けるが並びの違う transaction は Router が拒む（受け入れる形を狭める方向。安全側）
- 署名の検証は `@noble/curves` の既定（ZIP-215）。chain の検証（ed25519-dalek）と境界で違いがあっても、Router が受けて chain が拒めば facilitator の verify（simulate）で落ちるだけで、資金は動かない
- 復号・compile の例外はすべて `credential_mismatch`。例外の文言は出さない

### 5.4 再提出の扱い（FR-16 の最後の項の訂正）

preflight は「同じ transaction の 2 度目」を**それ自体では拒まない**。二重の settle を防ぐのは、既存どおり:

- 静的: verify の失敗で quote は終端、settle は 1 回だけ（journal）
- 動的: 昇格前は同じ credential の再試行を**許す**（`dynamic-upstream-design.md` §6.5 の取り引き）。昇格後は 1 回だけ。並行は quote ごとの lock
- 別の quote に同じ transaction を出す: memo = その quote の challengeNonce なので、組み直しで一致しない（`nonce_mismatch`）
- facilitator が同じ transaction を 2 度 broadcast しても、同じ signature は blockhash の有効期間内では chain が重複として拒む（これは Router の保証ではなく chain の性質）

### 5.5 verify／settle

既存の adapter と同じ `post("/verify" | "/settle", { x402Version: 2, paymentPayload: { x402Version, scheme, network, accepted, payload: { transaction } }, paymentRequirements })`。
`payload` の `challengeNonce` は送らない。facilitator の verify は simulate を含む（`index.mjs:812`）ので、payer の口座に残高が無ければ verify で落ちる（資金は動かない）。
settle の結果は §6 の表。HTTP の期限は verify 10 秒、settle 40 秒。

### 5.6 呼び出し側の道具（`tools/svm-payer.ts`、`npm run sign` から）

- 鍵: env `SOLANA_PAYER_PRIVATE_KEY`（base58 の 64 バイト、または hex の 32 バイトの seed）。`npm run wallet:new:solana` で作る（`tools/wallet-new-solana.ts`）
- **SDK の client（`createPaymentPayload`）は使わない**（mint の metadata を RPC から読み、桁と program を RPC の値で決める。`chunk-WIPN332D.mjs:2-9`）。transaction は
  `@solana/kit`・`@solana-program/token`・`@solana-program/compute-budget` で**固定値だけで組む**: 表の mint・decimals・token program、offer の `payTo` → 宛先 ATA（同じ導出）、
  `amount`、`extra.feePayer`、memo = `extra.memo`、`units = 20,000`、`microLamports = 1`（SDK の既定と同じ）。署名者の ATA は鍵から導く
- RPC は **`getLatestBlockhash` の 1 回だけ**（`SOLANA_RPC_URL`、既定 `https://api.devnet.solana.com`。tools は呼び出し側で、`wallet:balance` と同じく自分の fetch）。
  mint も残高も読まない。simulate しない
- 署名の前に拒否（SR-7）: network が表に無い、mint・decimals・token program が表と違う、`payTo` が 32 バイトでない、`feePayer`・`memo` が無い、額が上限（20,000）超、offer の期限切れ、
  `fundsMoveOnCredential` が true
- **署名だけで資金は動かない**（送信は fee payer）——x402/EVM と同じ開示。出力は既存と同じ封筒（`x402Version`・`accepted`・`payload{ challengeNonce, transaction }`）の base64

### 5.7 試験の fixture

- `tests/fixtures/svm-facilitator.ts`: loopback の facilitator。verify・settle の判定は **`@x402/svm` 2.28.0 の facilitator クラス（`ExactSvmScheme`、devDependency）をそのまま**使い、
  signer だけ fixture（fee payer の鍵で署名、`sendTransaction`/`confirmTransaction`/`simulateTransaction` は記録して成功・失敗を切り替える。chain には出ない）。
  Router が発行した形を **本物の verify の論理**が受けることを offline で固定する。`/supported` も返す
- `tests/fixtures/svm-payer.ts`: 試験の payer。`tools/svm-payer.ts` の組み立てを共有し、改変の口（宛先・額・mint・桁・命令の追加と並べ替え・memo・fee payer・lookup table・version・署名の破壊・
  fee payer の署名の混入・口座の追加・data の末尾の追加・1,233 バイト）を持つ
- **互換の試験**: `@x402/svm` の **client** `createPaymentPayload` を loopback の RPC fixture（`getAccountInfo` で mint、`getLatestBlockhash`）に向けて走らせ、その payload を Router の preflight が
  **受ける**こと（組み直しの並びが SDK と同じであることの証拠。U-3）
- `tests/fixtures/solana-rpc.ts`: `getAccountInfo`（ATA・mint）と `getLatestBlockhash` だけ
- 数える: 外部の要求の回数（verify 1・settle 1・`/supported` は起動時 1・RPC は起動時 1）

## 6. 決済の結果の表（FR-19・FR-20。kind `circle` と SVM）

| 時点 | 事象 | adapter の結果 | core |
|---|---|---|---|
| settle の要求を**出す前** | 売り手証明が作れない、offer の期限切れ | `rejected`（`source_rejected`） | 静的: `awaiting_payment`（再試行可）。動的: 既存どおり |
| 要求を**出した後** | timeout、接続の失敗、応答が JSON でない、HTTP 5xx | `unknown`（`source_settle_unknown`） | `unknown`、予約を保つ、自動再 settle しない |
| 〃 | HTTP 4xx（400・401・**403 registration_required**・409） | `unknown`（`source_settle_unknown`）。運用者向け診断に `facilitator_trial_exhausted`（403 の `errorReason` がそれのとき）を出す。**自動で再試行しない、facilitator を替えない**。運用者の作業（登録または API key の決定） | 同上 |
| 〃 | `success: false`（`settlement_pending` を含む） | `unknown`（`source_settle_unknown`） | 同上 |
| 〃 | `success: true` だが `network` が offer と違う、`transaction` の形が違う | `unknown` | 同上 |
| 〃 | `success: true`、`network` 一致、`transaction` が **EVM: `0x` ＋ 64 hex、SVM: base58 で decode して 64 バイト** | `settled`（txRef） | `source_settled` → 配送 |

- `payer`・`amount`・`extensions` は読まない（判定に使わない。型も要求しない）
- これは**形の検査**で、settle の証明ではない（FR-21。`proof.onChainFinality: "not_checked"` のまま）
- kind `x402`（Base Sepolia、既存）の `success: false` → `rejected` の写像は**今のまま**（静的 core が `source_failed` → `awaiting_payment` にする既存の挙動。変えるのは別の決定。§10 U-5）
- `/status` の polling（purpose `status`）は第 2 版では入れない（U-1 の結果で決める）

## 7. `npm run sign` の一般化（SR-7）

```
offer.scheme === "tempo/charge"                   → MPP（既存）
offer.scheme === "exact" && family(network) === "evm" → x402-payer（chainId = 表から、domain = 表と offer.extra の一致を確かめて）
offer.scheme === "exact" && family(network) === "svm" → svm-payer（§5.6）
それ以外                                          → 拒否
```

受信の上限は **20,000**（D-7）。表に無い network・資産・桁・domain・mint・token program、失効した offer、形の違う offer は署名の前に拒否。MPP の「署名で資金が動く」開示と承認 → 署名の順は変えない。

## 8. 本番の入口（`tools/remote-mcp-config.ts`・`tools/remote-router-process.ts`）

- 静的 route（D-6）: `md-mpp-eth-snapshot-arc`（Arc USDC 10,000 → Provider B/MPP）、`md-x402-eth-snapshot-sol`（Solana USDC 10,000 → Provider A/x402）
- 動的プロファイル: `dyn-arc-to-mpp`、`dyn-arc-to-x402`、`dyn-sol-to-x402`、`dyn-sol-to-mpp`（par 1:1、手数料は既存の規則: x402 送信は定額 1,000、MPP 送信はガス代連動）
- 予算: 静的・動的とも `(eip155:5042002, 0x3600…)` と `(solana:Et…, 4zMM…)` の区分を足す（上限は D-7 の桁）
- 設定: `x402.inboundFacilitators`（§2）。env: `SUBETHA_ARC_RECEIVER_KEY`（証明専用。受取先はその address）、`SUBETHA_SOLANA_RPC_URL`。Solana の受取 owner は設定の `payTo`
- 登録は `ARC_PROFILES_ENABLED`／`SOLANA_PROFILES_ENABLED` の定数で（G-4 と同じ gate。初期値 `false`、受け入れ後に `true`）

## 9. 新しい依存（SR-1 の記録）

| 依存 | 版 | 何を読み、どこへ接続するか |
|---|---|---|
| `@x402/{core,evm,fetch}` | 2.28.0（2.27.0 から。dist は同一、V-3） | 変わらない |
| `@solana/kit` | 固定版（導入時の最新。8.x） | `src/`: codec・compile（純粋）。`tools/`: 同じ＋RPC client（`getLatestBlockhash`） |
| `@solana-program/token`・`@solana-program/compute-budget` | 固定版 | 命令の組み立てと parse（純粋） |
| `@noble/curves` | 1.9.1（viem 経由で既に解決されている版を**直接の依存**に固定） | ed25519 の同期検証（純粋） |
| `@x402/svm` | 2.28.0、**devDependency** | 試験の fixture（facilitator クラス）と互換の試験（client）。`src/`・`tools/` は import しない |

`tests/unit/no-direct-fetch` の規則（`src/` は直接 fetch しない）はそのまま。`@solana/kit` の RPC client は `src/` では作らない（起動時の ATA の検査は guarded transport で JSON-RPC を POST する）。

## 10. 未解決（実装の中で確かめる）

| # | 事項 | 扱い |
|---|---|---|
| U-1 | Circle の `/settle` が 30 秒の窓の中で `success: true` を返す割合。`settlement_pending` が多ければ `/status` の bounded な polling（能力に purpose `status`・method `GET` を足す）を足す | AC-1 の試行で測る。第 2 版は `unknown` |
| U-2 | x402.org の SVM `/verify` が §5.3 の形を受理すること（simulate を含む） | 使い捨ての ed25519 鍵と devnet の USDC（faucet.circle.com）で `/verify` を実行（settle はしない）。実装の最初のタスク |
| U-3 | `@solana/kit` の compile の並びが SDK の client と同じこと、decoder の API 名 | §5.7 の互換の試験で固定 |
| U-4 | Circle の wire `maxTimeoutSeconds`（30）と settle の実際の所要 | AC-1 で確認。30 で足りなければ値を上げる（settle の HTTP 期限も連動） |
| U-5 | kind `x402`（Base Sepolia）の `success: false` → `rejected` を §6 の表に揃えるか | owner の決定。揃えると静的の既存の試験と挙動（再試行可）が変わる |

## 11. 変更するファイル（見込み）

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `KNOWN_NETWORKS`・`assetKeyOf`・`parseRouterConfig(raw, { networks })`、表との照合（向き・レール・資産・桁・domain・payTo の形）、`x402.inboundFacilitators` |
| `src/core/dynamic.ts` | offer との比較を `assetKeyOf` に |
| `src/adapters/inbound/x402.ts` | kind、`offerSeconds`／`maxTimeoutSeconds` の分離、settle の期限、`assetTransferMethod`、売り手証明、§6 の表 |
| `src/adapters/inbound/x402-svm.ts`（新規） | §5 |
| `src/ports/inbound.ts`・`src/main.ts` | `SellerProofCapability`、network ごとの facilitator と adapter の選択、起動時の `/supported`・ATA の検査、拒否ホスト |
| `src/mcp/tools.ts`・`src/client` | network の表示（family で桁・アドレスの形）、payer interface の chainId → network |
| `tools/sign-payment.ts`・`tools/svm-payer.ts`（新規）・`tools/wallet-new-solana.ts`（新規）・`tools/real-seller-proof-capability.ts`（新規）・`tools/remote-*.ts` | §5.6・§7・§8 |
| `package.json` | §9 |
| `tests/fixtures/{circle-facilitator,svm-facilitator,svm-payer,solana-rpc,known-networks}.ts`、unit・wire・統合の試験 | §4.3・§5.7・§6 の各行、AC-3〜AC-7 の否定の試験、sabotage |
| docs | `multirail-requirements.md` の訂正（§2.2 の `payTo`、FR-14、FR-16 の再提出、D-5 の注記、FR-2 の S-3 送り）、DEPLOY §2c、README／CLAUDE.md（英語の手順）、ENGINEERING |

## 12. 独立レビューの記録

| # | 日付 | レビュア | 結果 | 反映 |
|---|---|---|---|---|
| 1 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 1 版 `b2e2f5d`） | **REJECT**（高 4・中 4） | (1) SVM の `payTo` は owner（SDK の client・facilitator とも owner から ATA を導く）→ §5.1、要件 §2.2・FR-14 を訂正。(2) preflight が署名を検証せず fee payer の隔離が不完全、同期の契約 → §5.3 を「組み直して byte 一致」＋ `@noble/curves` の同期検証に、命令はちょうど 4。(3) FR-19・20 違反（4xx → rejected、`transaction` 非空だけ）→ §6 の表（要求後は unknown、EVM は 0x＋64 hex）。(4) payer の SDK client が RPC から mint を読む → §5.6 で固定値だけで組む。(5) 設定の照合（domain 未照合・family だけの行列・fixture の破壊）→ §1 を向き×レール×kind の表に、`parseRouterConfig` の `networks` 引数。facilitator は設定ファイルに（§2）。(6) `settleWaitSeconds` と 10 秒の HTTP 期限の矛盾 → §4.1 で有効期間・wire・HTTP 期限を分離。(7) 再提出の主張が既存の再試行と矛盾 → §5.4。(8) 能力の検査（時刻の整合・method・network の束縛）→ §3 で能力の中に固定。FR-2 は S-3 送り、Circle の `payer`/`amount` は読まない（§6） |
