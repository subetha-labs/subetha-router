# 設計: Arc と Solana で払う（S-1・S-2。第 3 版、2026-10-06）

> 要件は `multirail-requirements.md`（owner の決定 §0、確認の結果 §2.5）。本書は **S-1（Arc の USDC で払って既存の上流に届く）** と **S-2（Solana devnet の USDC で払って既存の上流に届く）** の設計。
> S-3・S-4（送信）は別紙。**FR-2（network ごとの `evmSigning`）は S-3 に送る**（第 1 版の受信では送信の鍵に触れない）。原則は既存の設計（`dynamic-upstream-design.md`・`ssrf-*`）を継ぐ:
> core はレールの port 越しにだけ外へ出る、署名・検査の境界は確かめた値だけで組む、`src/` の外への接続はすべて SSRF 防御 A の transport、鍵は `tools/` だけが env から読む、testnet だけ。
>
> 第 2 版からの訂正（独立レビュー #2、§12）: 表の照合の範囲と試験の注入路（§1）、settle の期限と client の購入の期限（§4.4）、静的の `source_failed` は終端（§6）、fee payer の隔離を起動時の不等式で明示（§5.1）。
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

照合の**範囲**: `sourceRail` が `x402`／`mpp` の `source` と、`rail` が `x402`／`mpp` の `destination` だけ。`subetha` 受信（`sourceRail` 未指定の既定。`src/config.ts:35`、`src/main.ts:191`）は
**今の検査のまま**（表に載せない。既存の synthetic 構成を壊さない）。静的 route の `destination`（`DestinationAllow`: scheme・network・asset・payTo。`src/config.ts:21-25`）は
network・向き・asset・payTo の形だけ、動的プロファイルの `source`／`destination` はそれに加えて `decimals`（x402 は `tokenDomain`、mpp は `feeAsset` が表の資産）を照合する。

照合の**注入路**: `parseRouterConfig(raw, { networks? })` は `networks` が渡されたときだけ照合する。`loadRuntimeConfig(env, read, { networks? })` は
`ROUTER_ADAPTER_MODE=real` のとき `networks ?? KNOWN_NETWORKS` を渡し、`synthetic` のときは渡さない（synthetic の harness は `src/main.ts` を `eip155:11155111`・偽の資産で起動する。
`tests/fixtures/router-harness.ts:17,177`）。`startRouter(capabilities)` は `capabilities.knownNetworksForTest`（コードからだけ注入できる。`dynamicTransportHooksForTest` と同じ扱い）を
`loadRuntimeConfig` に渡す——real モードで表の外の network・資産を使う fixture の起動側（`tests/fixtures/router-*-process.ts`）はそれで自分の表を渡す。`parseRouterConfig` を直接呼ぶ
unit 試験（指紋の `eip155:1`・`eip155:4217` 等。`tests/unit/dynamic-config.test.ts:187-203`）は `networks` を渡さないので今のまま通る。本番の入口（`tools/remote-mcp-config.ts`・
`startRouter` の既定）は `KNOWN_NETWORKS` しか使えない。

- 対象の `source`／`destination` ごとに、`network` が表にあり、向きとレールが `inbound`／`outbound` にあり、`asset` が表の資産に一致し（family 別の比較）、動的なら `decimals` が一致すること
- 動的 x402 の destination の `tokenDomain` は表の `domain` と**一致**すること（今は任意の文字列を受ける `src/config.ts:541-545` を締める）
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
  /** header の値（base64url の封筒）を返す。時刻（作るときに注入した時計）・nonce・method は能力の中で決める。 */
  proofFor(purpose: "verify" | "settle", bodyHash: Hex): Promise<string>;
}
```

- `tools/real-seller-proof-capability.ts` が env `SUBETHA_ARC_RECEIVER_KEY` と時計（`Date.now`）から作る。adapter は時刻を渡せない（鮮度は能力が持つ）（`src/` は env を読まない。SR-5 の正確な形: **受取鍵の秘密鍵はホストにあり、`src/` に渡るのは
  `proofFor` の閉包だけ**。この鍵の資金は受取先として受けた USDC で、鍵で動かせるのは `tools/` の運用者の操作だけ）
- 能力の中で固定: EIP-712 domain `{ name: "Circle Facilitator Seller Request", version: "1", chainId: 表の network の chainId }`（verifyingContract 無し）、型 `SellerRequest{purpose,method,bodyHash,network,payTo,nonce,issuedAt,expiresAt}`、
  `method = "POST"`（verify・settle。`status` は第 2 版では**持たない**）、`network = this.network`、`payTo = this.address`、`nonce = CSPRNG 32 バイト`（要求ごと）、
  `issuedAt = floor(now()/1000)`、`expiresAt = issuedAt + 60`（整数。`issuedAt < expiresAt`、寿命 60 秒 ≤ Circle の上限 300 秒、`issuedAt` は Circle の「現在＋30 秒以内」の内側）
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
| HTTP の期限 | verify・settle とも 10 秒 | verify 10 秒。settle は **`maxTimeoutSeconds + 10` 秒**（circle: 40 秒、SVM: 50 秒。kind `x402`/EVM は今の 10 秒のまま）。購入全体の期限は §4.4 |
| requirements の `extra` | `name`・`version`・`challengeNonce`・`expiresAt`・`routeBinding`・`fundsMoveOnCredential` | circle は **`assetTransferMethod: "eip3009"`** を足す。発行 extra のキー集合は kind ごと（preflight の「未知キー拒否」はその集合で）。`accepted` は offer の完全一致を要求するので requirements と `accepted` は常に同じ値 |
| 要求のヘッダ | `content-type` だけ | circle は `Facilitator-Seller-Proof`（§4.2）。API key は使わない（D-8） |
| settle の結果 | §6 の表（kind `x402` は今のまま） | §6 の表 |

### 4.2 売り手証明の作り方

```
body      = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements })   // 1 度だけ直列化し、この文字列をそのまま送る
bodyHash  = keccak256(utf8(body))
header    = await capability.proofFor(purpose, bodyHash)                             // purpose は呼ぶ endpoint と同じ
```

- 証明が作れない（能力が拒む・例外）→ **要求を出さない**: verify なら `isValid: false`、settle なら `rejected`（`source_rejected`、§6 の「要求前」）
- `purpose` ごとに nonce は新しい（Circle は `(network, payTo, purpose)` で一意を要求する）

### 4.3 試験の fixture

`tests/fixtures/circle-facilitator.ts`: loopback の facilitator で、**売り手証明を検証する**（header を decode し、EIP-712 で recover して `payTo` と一致、`bodyHash` が受けた body の keccak256 と一致、
`purpose` が endpoint と一致、`issuedAt`・`expiresAt` の規則、nonce の再使用拒否）。証明が無い・違う・古い・再使用の要求は 401。`assetTransferMethod` を要求する。settle は
`success/transaction/network/payer` と `extensions.settlement-status` を返し、状態で `settlement_pending`・`403 registration_required`・409・`transaction` の形崩れ・`network` 違いに切り替えられる。
試験は AC-3（否定: 証明の各欄の改変）・AC-4（§6 の表の各行）・要求の回数（settle は 1 回だけ）を数える。

### 4.4 購入の期限（Router と client）

| 層 | 今 | 変更 |
|---|---|---|
| Router の core | settle の**前**に承認期限と offer の期限を再検査する（`src/core/orchestrator.ts:621-635`、`src/core/dynamic.ts:564-567`）。settle の完了には期限を掛けない | 変えない（settle の待ちが承認期限の中に収まる必要はない） |
| Router の ingress | `requestTimeout`・`headersTimeout` 10 秒（`src/http/app.ts:467`）。これは**要求の受信**の期限で、応答には掛からない（動的購入は今も 100 秒の応答を返す） | 変えない |
| client（`src/client`・MCP tool） | 静的購入は `timeoutMs`（10 秒）、動的購入だけ `executeTimeoutMs`（120 秒。`src/client/index.ts:189,423`） | **購入はすべて `executeTimeoutMs`** にし、既定を **180 秒**に（静的の Arc・Solana は settle に 40〜50 秒掛かり得る。10 秒で切ると Router が続けているのに `transport_uncertain` になる）。動的の最悪は 102 ＋ 40 = **142 秒 < 180**。SVM は settle が 50 秒なので 152 秒、§5.8 の追跡（完了の期限 15 秒）を足して **167 秒 < 180**（余裕 13 秒。102 秒の見積りは旧い settle の枠を含むので、50 秒を丸ごと足すのは保守的な側）。静的の settle ＋ 追跡は 50 ＋ 15 = 65 秒（購入全体ではない: 上流の読取・verify・journal・送信が加わる）。13 秒の余裕は運用上の許容で、端から端の保証ではない（受信・永続化・応答の送出が余裕を使う） |
| MCP の ingress | 1 要求が接続を使える上限 `maxRequestMs` 180 秒（受信から応答の完了まで。`src/mcp/ingress.ts:170` で socket を切る） | 変えない。client の `executeTimeoutMs` だけを上げても ingress の上限は残る |

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
  `data.parsed.info.owner === payTo`、`data.parsed.info.mint === 表の mint` を要求。読めない・違う → 起動しない（fail closed）。quote・verify の中では RPC に出ない。purchase では settle の要求の**後**に限り、§5.8 の追跡で `getSignatureStatuses` に出る（FR-18、D-9）
- `extra.memo = challengeNonce`（facilitator も照合する。`index.mjs:790-810`）
- `feePayer` は起動時に facilitator の `/supported` から読む: `kinds[]` のうち **`x402Version === 2` かつ `network === この network` かつ `scheme === "exact"`** の `extra.feePayer`。
  該当が 0 件、または該当の `feePayer` が **1 つに定まらない**（複数の違う値）→ 起動しない。**1 つに固定**し、quote ごとに読まない。変われば再起動（FR-15）
- 起動時の **fee payer の隔離**（FR-16 の「どの命令の口座にも現れない」を不等式で固定する）: `feePayer` は base58 で 32 バイト、かつ `feePayer ∉ { payTo, 宛先 ATA, mint, token program, Memo program,
  ComputeBudget program }`。違えば起動しない。preflight では残りの口座（`source`・`authority`）との不等式（§5.3 の 5）で、組み直した message に fee payer が [0] 以外に現れないことが決まる
- mint は表の **legacy SPL token program** に固定。Token-2022 の mint・命令は（SDK の facilitator は両方を受けるが）Router は受けない
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
| 5 | 取った値の範囲: `units ≤ 200,000`（**Router の方針**。SDK の facilitator の既定は上限なし `scheme-BcpmRJSH.d.mts:52-62`）、`microLamports ≤ 5,000,000`（facilitator の既定の上限と同じ。`chunk-RXPBSPMZ.mjs:14`）、`source ≠ feePayer`、`source ≠ 宛先 ATA`、`authority ≠ feePayer`、`authority ≠ payTo`。`source` が署名者の ATA であることは**確かめない**（所有・残高は chain と facilitator の simulate の検査。Router は主張しない） | `credential_mismatch` |
| 6 | Memo の data（UTF-8）`=== challengeNonce`（組み直しに含まれるが、理由を分けるために先に照合する） | `nonce_mismatch` |

- facilitator（v2 の静的経路 `index.mjs:670-830`）は命令 3〜7、Lighthouse・Memo の任意の追加、2 つの token program、smart wallet の経路を許す。Router は**自分が発行した形**（`npm run sign` が組む形）
  だけを通す。別の wallet が作った、facilitator は受けるが並びの違う transaction は Router が拒む（受け入れる形を狭める方向。安全側）
- 署名の検証は `@noble/curves` の既定（ZIP-215。公開鍵は base58 を decode した 32 バイトを渡す）。chain の検証（ed25519-dalek）と境界で違いがあっても、Router が受けて chain が拒めば facilitator の verify（simulate）で落ちるだけで、資金は動かない
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
settle の結果は §6 の表。HTTP の期限は verify 10 秒、settle **50 秒**（wire 40 ＋ 10。SDK の settle は `confirmTransaction` に wire の値を渡さない `index.mjs:284` ので、wire の値は上限の主張ではない）。
settle の応答の後に §5.8 の追跡が入るとき、settle 全体は最長 50 ＋ 15 = **65 秒**（追跡の 15 秒は**完了の期限**で、最後の RPC の要求もその期限で打ち切る）。購入全体の予算は §4.4（動的の最悪 167 秒 < 180）。

### 5.8 settle の応答の後の期限つきの追跡（D-9。G-3 の結果で足した）

**事実**（SDK `@x402/svm` 2.28.0 `exact/facilitator/index.mjs:262-340`、`chunk-RXPBSPMZ.mjs:370-390`）: facilitator の settle は sign → send → confirm で、send の**後**の失敗は
`success: false` に **`transaction: <署名>`** を付けて返す（confirm の timeout → `errorReason: "settlement_pending"`（facilitator 側は pending store に残す）、チェーン上の失敗 → `invalid_exact_svm_transaction_failed`、
受取の事後検証の失敗 → `post_settlement_transfer_not_confirmed`）。`sendTransaction` の呼び出しが例外になった場合は `transaction: ""`（送信の成否が不明なこともあり得る。`index.mjs:271`）。G-3 の 4 件目は応答本文を記録していないので形は不明だが、
後から見た transaction は Router が `unknown` を書いた約 1.5 秒前の blockTime で finalized しており、SDK の挙動から「confirm の timeout で署名つきの `settlement_pending`」が有力な説明。

**追跡**（adapter `createX402SvmInbound` の `settle` の中。core は変えない。静的・動的で同じ）:

1. settle の HTTP 応答を読む。形どおりの成功（§6 の最終行）なら従来どおり `settled`
2. そうでなく、**本文が JSON object で `transaction` が署名の形（base58 で 64 バイト）で `network` が offer と一致**するときだけ追跡に入る（HTTP status は問わない。署名が無い・形が違う・network が違う・JSON でない → 従来どおり `unknown`）
3. 設定の RPC（`ROUTER_SOLANA_RPC_URL`、既定 devnet）に `getSignatureStatuses([signature], { searchTransactionHistory: true })` を POST する。transport は起動時の検査と同じ guarded transport
   （loopback 不可・DNS 期限 3 秒・HTTP 期限 10 秒・redirect 無し・応答 64 KiB 以下）。間隔 **2 秒**、全体は **15 秒の完了の期限**（最後の要求の期限も残り時間で切る。`followUp: { totalMs, intervalMs }`。
   試験は短くする。既定は adapter の定数）。要求は ≤ ⌈15 / 2⌉ ＋ 1 = 9 回。要求の params は `[[signature], { searchTransactionHistory: true }]` に固定
4. 判定（`result.value[0]`）。**形の正しい status** とは、object で `err` の欄を持ち（`null` か値）、`confirmationStatus` が `processed`／`confirmed`／`finalized` のいずれかであること。
   形の正しい status で `err === null` かつ `confirmationStatus` が `confirmed` または `finalized` → **`settled`（txRef = 署名）**、運用者向けの固定の診断 `svm_settle_followed_up`（U-1 の統計用。finality は主張しない）。
   形の正しい status で `err !== null`（`confirmationStatus` が何であっても）→ **打ち切って `unknown`**（SDK は同じ署名を照合し直すだけで差し替えない `index.mjs:345`。別の署名が後から成立しても、追跡している署名を settled にする理由にはならない）。
   `null`（知らない署名）・`processed`・**形の違う status（`{}` や `err` の欄の無いもの）**・JSON でない・RPC の失敗（timeout・5xx・64 KiB 超）→ 次の間隔まで待って再度。期限で `unknown`
5. 使う RPC method は `getSignatureStatuses` だけ（`getTransaction` は読まない）。要求の回数は ≤ ⌈totalMs / intervalMs⌉ ＋ 1 で、試験は回数を数える
6. 優先順位: この追跡は §6 の表の「要求を出した後の失敗 → `unknown`」の **例外**（D-9）で、HTTP 4xx・5xx の応答でも本文が 2 の条件を満たせば追跡する（HTTP status だけでは送信の有無が分からない）

**変わらないこと**: core の journal の遷移（settle の 1 回の呼び出しが長くなるだけ。追跡の途中の crash は `interrupted_at_restart` の `unknown`。自動の再 settle は無い）、予約の扱い、`unknown` の終端の意味、
`proof.onChainFinality: "not_checked"`。**限界（FR-21）**: 署名は facilitator の申告で、チェーンの確定はその署名の transaction が確定したことを示すだけ（memo・額・宛先は読み直さない。
形どおりの成功の経路と同じ信頼の範囲）。facilitator が pending を後で自分で解決しても Router は知らない（Router の判定は追跡の期限内だけ）。

### 5.6 呼び出し側の道具（`tools/svm-payer.ts`、`npm run sign` から）

- 鍵: env `SOLANA_PAYER_PRIVATE_KEY`（base58 の 64 バイト、または hex の 32 バイトの seed）。`npm run wallet:new:solana` で作る（`tools/wallet-new-solana.ts`）
- **SDK の client（`createPaymentPayload`）は使わない**（mint の metadata を RPC から読み、桁と program を RPC の値で決める。`chunk-WIPN332D.mjs:2-9`）。transaction は
  `@solana/kit`・`@solana-program/token`・`@solana-program/compute-budget` で**固定値だけで組む**: 表の mint・decimals・token program、offer の `payTo` → 宛先 ATA（同じ導出）、
  `amount`、`extra.feePayer`、memo = `extra.memo`、`units = 60,000`（SDK の既定 20,000 では 66 文字の memo で尽きる。T6 の実測 25,332 CU）、`microLamports = 1`（SDK の既定と同じ）。署名者の ATA は鍵から導く
- RPC は **`getLatestBlockhash` の 1 回だけ**（`SOLANA_RPC_URL`、既定 `https://api.devnet.solana.com`。tools は呼び出し側で、`wallet:balance` と同じく自分の fetch）。
  mint も残高も読まない。simulate しない
- decimals・token program は**表から**（offer には無い）。offer の `extra` にそれらが入っていて表と違えば拒否
- 署名の前に拒否（SR-7）: network が表に無い、mint が表と違う、`payTo` が 32 バイトでない、`feePayer`・`memo` が無い、額が上限（20,000）超、offer の期限切れ、
  `fundsMoveOnCredential` が true
- **署名だけで資金は動かない**（送信は fee payer）——x402/EVM と同じ開示。出力は既存と同じ封筒（`x402Version`・`accepted`・`payload{ challengeNonce, transaction }`）の base64

### 5.7 試験の fixture

- `tests/fixtures/svm-facilitator.ts`: loopback の facilitator。verify・settle の判定は **`@x402/svm` 2.28.0 の facilitator クラス（`@x402/svm/exact/facilitator` の `ExactSvmScheme`。
  root の `ExactSvmScheme` は client）をそのまま**使い、signer だけ fixture（`getAddresses`・`signTransaction`（fee payer の鍵で署名）・`simulateTransaction`・`sendTransaction`・
  `confirmTransaction`。`signer-gUqhJy7y.d.mts:57-112`。記録して成功・失敗を切り替える。chain には出ない）。
  Router が発行した形を **本物の verify の論理**が受けることを offline で固定する。`/supported` も返す
- `tests/fixtures/svm-payer.ts`: 試験の payer。`tools/svm-payer.ts` の組み立てを共有し、改変の口（宛先・額・mint・桁・命令の追加と並べ替え・memo・fee payer・lookup table・version・署名の破壊・
  fee payer の署名の混入・口座の追加・data の末尾の追加・1,233 バイト）を持つ
- **互換の試験**: `@x402/svm` の **client** `createPaymentPayload` を loopback の RPC fixture（`fetchMint` が読める **encoded の mint account data**（base64）と `getLatestBlockhash`。
  起動時の ATA の jsonParsed とは別の応答）に向けて走らせ、その payload を Router の preflight が
  **受ける**こと（組み直しの並びが SDK と同じであることの証拠。U-3）
- `tests/fixtures/solana-rpc.ts`: `getAccountInfo`（ATA・mint）と `getLatestBlockhash` だけ
- 数える: 外部の要求の回数（verify 1・settle 1・`/supported` は起動時 1・RPC は起動時 1）

## 6. 決済の結果の表（FR-19・FR-20。kind `circle` と SVM）

| 時点 | 事象 | adapter の結果 | core |
|---|---|---|---|
| settle の要求を**出す前** | 売り手証明が作れない、offer の期限切れ | `rejected`（`source_rejected`） | 静的: journal は `source_failed`（**終端**。同じ quote の再購入は同じ結果を返すだけで verify・settle をやり直さない `src/core/orchestrator.ts:496-498`）、公開状態は `awaiting_payment`。回復は**新しい quote**。動的: 昇格前は再試行可（§5.4）、昇格後は `unknown` |
| 要求を**出した後** | timeout、接続の失敗、応答が JSON でない、HTTP 5xx | `unknown`（`source_settle_unknown`）。**SVM で本文が署名を含むなら §5.8 の追跡が優先（D-9）** | `unknown`、予約を保つ、自動再 settle しない |
| 〃 | HTTP 4xx（400・401・**403 registration_required**・409） | `unknown`（`source_settle_unknown`）。運用者向け診断に `facilitator_trial_exhausted`（403 の `errorReason` がそれのとき）を出す。**自動で再試行しない、facilitator を替えない**。運用者の作業（登録または API key の決定）。**SVM で本文が署名を含むなら §5.8 の追跡が優先（D-9）** | 同上 |
| 〃 | `success: false`（`settlement_pending` を含む）、**署名を含まない** | `unknown`（`source_settle_unknown`） | 同上 |
| 〃（SVM だけ） | `success: false` または形の違う成功で、**`transaction` が署名の形、`network` 一致** | §5.8 の追跡: 期限内に `confirmed`／`finalized`（`err` 無し）→ `settled`（txRef = 署名）。それ以外 → `unknown` | `settled` なら `source_settled` → 配送。`unknown` は同上 |
| 〃 | `success: true` だが `network` が offer と違う、`transaction` の形が違う | `unknown` | 同上 |
| 〃 | `success: true`、`network` 一致、`transaction` が **EVM: `0x` ＋ 64 hex、SVM: base58 で decode して 64 バイト** | `settled`（txRef） | `source_settled` → 配送 |

- `payer`・`amount`・`extensions` は読まない（判定に使わない。型も要求しない）
- これは**形の検査**で、settle の証明ではない（FR-21。`proof.onChainFinality: "not_checked"` のまま）
- kind `x402` **かつ family evm**（Base Sepolia、既存）の `success: false` → `rejected` の写像は**今のまま**（静的 core が終端の `source_failed` を書き、公開状態 `awaiting_payment`。回復は新しい quote。変えるのは別の決定。§10 U-5）。SVM は kind `x402` でも §6 の表（adapter で分岐する）
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

## 9. 新しい依存（SR-1 の記録。T0-a で確定、2026-10-07）

入れる前に版・依存の木・「何を読み何に接続するか」を dist の grep と `npm view` で確かめ、`package.json` は固定版（`^` 無し）で書く。

| 依存 | 版 | 何を読み、どこへ接続するか（dist の実物） |
|---|---|---|
| `@x402/{core,evm,fetch}` | **2.28.0**（2.27.0 から） | `core`・`fetch` の dist は同一。`evm` の esm は chunk 名のハッシュが変わるだけで、名前を正規化した diff は **0 行**。依存の変更は `@x402/core ~2.28.0` だけ |
| `@solana/kit` | **8.4.0**（直接の依存 27 個、root の `@solana/*` は kit を含め **43 個すべて 8.4.0**。node ≥ 20.18） | `src/`: codec・compile・decompile（`@solana/transactions`・`transaction-messages`・`codecs`・`addresses`・`instructions`。fetch・WebSocket 無し）。`@solana/addresses`・`keys`・`signers` は PDA の導出と鍵に **WebCrypto（`crypto.subtle`）**を使う（起動時の ATA の導出は非同期でよい。preflight では使わない）。RPC（`@solana/rpc-transport-http`: 裸の `fetch(`）と subscription（`@solana/rpc-subscriptions`: `WebSocket`）は `tools/` だけ。`process.env` は `NODE_ENV` だけ |
| `@solana-program/token` | **0.17.0**（依存 `@solana-program/system` 0.15.0） | 命令の組み立てと parse（純粋）。`fetchMint` は渡した RPC を使う（`src/` では呼ばない）。`process.env.NODE_ENV` だけ |
| `@solana-program/compute-budget` | **0.19.0** | 命令の組み立てと parse（純粋）。接続・env 無し |
| `@noble/curves` | **1.9.1**（viem 2.54.0 が解決している版と同じ。`@noble/hashes` 1.8.0 も既存） | ed25519 の**同期**検証（`abstract/edwards.js` の `verify`）。接続・env 無し |
| `@x402/svm` | **2.28.0、devDependency** | fixture（`@x402/svm/exact/facilitator` の facilitator クラス）と互換の試験だけ。`src/`・`tools/` は import しない（`tests/unit/dependency-direction.test.ts` で固定）。自分の依存は**古い系列**（`@solana-program/token` 0.9.0・`token-2022` 0.6.1・`compute-budget` 0.11.0・`@solana/program-client-core` 6.10.0。peer `@solana/kit ^5`）で `node_modules/@x402/svm/node_modules/` に入れ子になり、`@solana/kit` 自体は root の 8.4.0 を使う（npm は peer の衝突を警告して上書き）。**kit 8.4 の上で古い program package が動くかは T4-c の fixture の試験で確かめる**（動かなければ fixture の facilitator を別 package に隔離する）。入れ子の `@solana/*` は **5.5.1**（`accounts`・`sysvars` 等、`token-2022` 0.6.1 の peer）と **6.10.0**（`program-client-core` の子孫）の 2 系列。dist に `fetch(` は無く、RPC は渡した signer・`createSolanaRpc` 経由だが、**client は network ごとの公開 RPC（`api.devnet/testnet/mainnet-beta.solana.com`）を既定で持つ**（`chunk-RXPBSPMZ.mjs:7`）——互換の試験は必ず `rpcUrl` に loopback の fixture を渡す（既定に落ちたら試験を落とす）。`crypto.subtle` は署名検証。`@solana/keys` には鍵をファイルに書く helper（`writeKeyPair`）があるが呼ばれない限り何もしない（Router・道具は使わない） |

Memo の命令は `@solana-program/memo` を入れずに生で組む（program `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`、口座無し、data = UTF-8。SDK の client も同じ）。

`tests/unit/no-direct-fetch` の規則（`src/` は直接 fetch しない）はそのまま。`src/` では `@solana/kit` の RPC client を作らない（`createSolanaRpc` 等の名前を `tests/unit/dependency-direction.test.ts` で禁止。起動時の ATA の検査は guarded transport で JSON-RPC を POST する）。

## 10. 未解決（実装の中で確かめる）

| # | 事項 | 扱い |
|---|---|---|
| U-1 | Circle の `/settle` が 30 秒の窓の中で `success: true` を返す割合。`settlement_pending` が多ければ `/status` の bounded な polling（能力に purpose `status`・method `GET` を足す）を足す | **G-3（2026-10-07）の計測**: Circle は 2 件とも 1 回の `/settle` で `success`（purchase 全体 7.6 秒・6.9 秒、`settlement_pending` 無し）。**SVM（x402.org）は 2 件中 1 件が `unknown`**: facilitator の応答（約 4.4 秒）が形どおりの成功でなく、transaction は後から見ると finalized（blockTime は journal の `unknown` の約 1.5 秒前。確定が観測された時刻との前後関係は不明。`docs/DEPLOY.md` §2c の記録）。SVM には `/status` が無いので、**owner の決定（2026-10-07、D-9）で §5.8 の追跡を足した**（T11、PR #66。配備 `b-4d2c925`）。再試行（同日 09:41Z）: Solana の動的・静的とも 1 回の settle で delivered（6.5 秒・4.4 秒。追跡が働いたかは hosted では観測できない）。AC-2 を満たした |
| U-2 | x402.org の SVM `/verify` が §5.3 の形を受理すること（simulate を含む） | **確認済み（T6、2026-10-07）**: 使い捨ての鍵と devnet の USDC（faucet）で、起動時の検査（`/supported`・ATA）→ adapter の offer → `svm-payer` の署名 → x402.org の `/verify` が **`isValid: true`**（settle はしていない）。最初の試行は `invalid_exact_svm_transaction_simulation_failed`（命令 3 = Memo で `ProgramFailedToComplete`）: SDK の既定の compute 上限 20,000 CU では **66 文字の memo（nonce）で尽きる**。devnet の simulate の実測は **25,332 CU**（上限 200,000 で成功）。道具の既定を **60,000 CU** に上げた（Router の上限 200,000 の内側。§5.6）。**配備先の facilitator の `maxComputeUnits` は不明**（SDK の既定は上限なし）。**再測定の手順**: memo・命令を変えたら、devnet の RPC `simulateTransaction`（読取）で `unitsConsumed` を読み、既定をその 2 倍以上かつ 200,000 以下に置き、`rails-verify-probe.ts svm verify` で `/verify` が `isValid: true` であることを確かめる（settle は要らない）。Circle も同日に `/verify` **`isValid: true`**（使い捨ての証明専用の受取鍵、Arc testnet の USDC を持つ使い捨て payer。封筒の `version: 1` と `assetTransferMethod` が受理された。settle はしていない） |
| U-3 | `@solana/kit` の compile の並びが SDK の client と同じこと、decoder の API 名 | **固定済み（T4-a）**: 本物の `@x402/svm` の client が組んだ transaction を Router の検査が受ける互換の試験 |
| U-4 | Circle の wire `maxTimeoutSeconds`（30）と settle の実際の所要 | **G-3 の 2 件で確認**: settle を含む purchase 全体で 7.6 秒・6.9 秒。この 2 件の範囲では 30 で足りる。30 のまま |
| U-5 | kind `x402`/EVM（Base Sepolia）の `success: false` → `rejected`（静的は終端の `source_failed`、公開状態 `awaiting_payment`）を §6 の表（`unknown`）に揃えるか | owner の決定。揃えると静的の既存の試験と公開状態が変わる |

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
| 2 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 2 版 `e2499f8`） | **APPROVE WITH CHANGES**（中 3・低 2） | (1) 表の照合が `subetha` 受信と synthetic の harness を壊す、静的の destination に桁・domain が無い → §1 に範囲（x402/mpp だけ）・注入路（`loadRuntimeConfig` の `networks`、`knownNetworksForTest`、synthetic は照合しない）・静的と動的の欄の区別。(2) settle の期限が client の静的購入の 10 秒に通らない、SVM の期限が wire と同じ → §4.4（購入はすべて `executeTimeoutMs`、既定 180 秒）、SVM settle 50 秒。(3) 静的の `rejected` を「再試行可」と書いた → §6 を終端の `source_failed`・回復は新しい quote に。(4) fee payer の隔離が組み直しだけでは不足 → §5.1 の起動時の不等式と `/supported` の選び方（x402Version 2、1 つに定まる）。(5) 200,000 CU は Router の方針、FR-1 の env の文言、V-3 は core だけ → 訂正（要件 FR-1 も）。能力の時計は作るときに注入（§3）。第 3 版で反映、再レビューは実装の PR で |
| 1 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 1 版 `b2e2f5d`） | **REJECT**（高 4・中 4） | (1) SVM の `payTo` は owner（SDK の client・facilitator とも owner から ATA を導く）→ §5.1、要件 §2.2・FR-14 を訂正。(2) preflight が署名を検証せず fee payer の隔離が不完全、同期の契約 → §5.3 を「組み直して byte 一致」＋ `@noble/curves` の同期検証に、命令はちょうど 4。(3) FR-19・20 違反（4xx → rejected、`transaction` 非空だけ）→ §6 の表（要求後は unknown、EVM は 0x＋64 hex）。(4) payer の SDK client が RPC から mint を読む → §5.6 で固定値だけで組む。(5) 設定の照合（domain 未照合・family だけの行列・fixture の破壊）→ §1 を向き×レール×kind の表に、`parseRouterConfig` の `networks` 引数。facilitator は設定ファイルに（§2）。(6) `settleWaitSeconds` と 10 秒の HTTP 期限の矛盾 → §4.1 で有効期間・wire・HTTP 期限を分離。(7) 再提出の主張が既存の再試行と矛盾 → §5.4。(8) 能力の検査（時刻の整合・method・network の束縛）→ §3 で能力の中に固定。FR-2 は S-3 送り、Circle の `payer`/`amount` は読まない（§6） |
