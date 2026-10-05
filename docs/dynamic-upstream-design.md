# 設計: 動的上流 URL

> 2026-10-05、第 2 版。要件は `docs/dynamic-upstream-requirements.md`（以下「要件」）。FR・AC・U の番号はその文書のもの。
> 本書は U-1〜U-9 に結論を出し、変更箇所と試験を定める。**実装の着手とタスク分割は次のフェーズ**。
> 第 1 版は独立レビューで REJECT（重大 1・高 7・中 4）。指摘と反映先は §15。
> 先行して出した修正: 予算の予約を verify の後へ（PR #6、本番反映済み）、MPP 受信の credential を quote に束縛（PR #7）。

## 0. 一枚で

```
呼び出し側 ─ quote(profileId, url) ─> Router ─ GET url（未払い・A の transport）─> 上流
            <─ subject（url・payTo・上流額・手数料・受信額・開示）＋ ownerKey
人間が承認
呼び出し側 ─ purchase(credential, ownerKey) ─> Router
     1. 持ち主・承認・設定の指紋・期限・preflight（署名／送金そのものに効く束縛）
     2. 試行の印を控えに残す（1 quote に 1 行まで）
     3. 上流を読み直して保存済み offer と照合 → 受信 verify
     4. 期限の再検査 →【予算の確認と journal への昇格を 1 つの操作で】→ 受信 settle
     5. 運用者の鍵は「設定から組み直した支払い」だけに署名 → 応答（上限つき）
```

柱は 4 つ。

1. **動的プロファイル** = 運用者が設定で宣言する「宛先だけが空いた route」（U-1）
2. **未払いの quote は journal に入れない**。耐久性のある「控え」に置き、**予算が通ったときだけ** journal に昇格する（FR-21・FR-33）
3. **運用者の鍵は、上流や SDK が渡してきたものではなく、設定と承認済みの値から組み直したものにだけ署名する**（FR-18）
4. **持ち主の証明は `ownerKey`**。共有 principal・`requestId`・`paymentId` は証明に使わない（FR-32）

## 1. 設定（U-1・U-3・FR-2・FR-13）

`RouterConfig` に `dynamic` を足す。**省略時は無効**。env からは有効にできない（本番の入口 `tools/remote-mcp.ts` がコードで組む）。

```ts
interface DynamicConfig {
  readonly enabled: boolean;
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  readonly budget: BudgetLimits;              // 静的 route とは別の通算（§6.4）
  readonly limits: DynamicLimits;             // §7 の数値
  readonly denyHosts: readonly string[];      // §7.4
}
interface DynamicProfile {
  readonly profileId: string;                 // routeId と同じ文字種・同じ名前空間。route と重複したら起動失敗
  readonly sourceRail: "x402" | "mpp";        // SubEtha 受信は対象外
  readonly source: { network; asset; decimals; payTo };          // 額は持たない
  readonly rail: "x402" | "mpp";
  readonly destination: {
    scheme; network; asset; decimals;
    tokenDomain?: { name; version };          // x402 送信: EIP-712 domain の権威
    feeAsset?: string; maxFee?: string;       // mpp 送信: 手数料資産（必須）と 1 件の上限（feeAsset の base units）
  };
  readonly par: true;                          // 1:1 とみなす宣言。true 以外は起動失敗
  readonly maxUpstreamAmount: string;          // 送信資産の base units
  readonly fee: { flat: string; bps: number; min: string };      // 受信資産の base units
}
```

**プロファイルは `enabled` に関わらず解決できる**（HTTP・core とも）。無効のとき:
quote は外部接続の前に `dynamic_disabled`。purchase は、未昇格の quote なら `quote_changed`、既に始まった購入なら現在の状態を返す
（新しい実行は起きない。`orchestrator.ts:402-405` の既存の順序どおり）。指紋には全欄と `enabled` を含めるので、
**手数料・上限・ペア・有効／無効のどれを変えても、変更前の未実行の quote は `quote_changed`**（FR-16・FR-34）。

### 1.1 起動時の配線で変える箇所（第 1 版は「列挙元だけ」と書いたが誤り）

| 箇所 | 変更 |
|---|---|
| `main.ts:192-201` 能力の要求と upstream Map の構築 | プロファイルのレールも `railsInUse` に入れる。プロファイルは upstream Map に**入れない** |
| `main.ts:75-98` `railByRoute` | route＋プロファイルで Map を作る。**`readChallenge(routeId, target)` の `target` を転送する**（今は捨てる。`:95`） |
| `main.ts:109-154` `inboundByRoute`、`:252-305` 受信 adapter の生成 | プロファイルごとに受信 adapter を作り、`routeBinding`（プロファイル単位）で引けるようにする |
| `orchestrator.ts` `quoteLocked`／`purchaseLocked` | `resolveRoute` に加え `resolveProfile`。動的は別関数に分け、静的の経路に条件分岐を増やさない |
| `http/app.ts:286,313` | route かプロファイルのどちらかに解決できれば通す。動的の投影は `dynamicQuoteBody`（静的の関数は触らない） |
| `client/index.ts:234`、`mcp/tools.ts:209` | 一覧の `dynamic` を落とさず返す。動的 quote 文書の追加欄（`upstream`・`pricing`・`disclosures`・`ownerKey`）を保持する |
| `Intent`・`store.ts:51-82` | `upstream`・`dynamic` を追加し、`intentFromCreated` で**明示的に復元**する（列挙式なので足し忘れると消える） |

client／MCP が quote 文書から読むのは、**credential を組むための受信 offer、購入口のパス（`/v1/routes/<profileId>/resource`）、
承認の束縛、`paymentId`、`ownerKey`**。Router が実行するのは保存した記録で、文書中の URL・`payTo`・額は実行に使わない。

## 2. 入口と記録（FR-1・FR-3〜5・FR-7・FR-14）

### 2.1 入口

- HTTP: `POST /v1/quotes` の本文に `upstream: { url }` を足せる。`routeId` にプロファイル ID。`upstream` が無ければ現行と同じ処理
- MCP: **新しい tool `subetha_router_quote_url`**（`profileId`・`url`・`requestId`）。既存 tool の schema は変えず、
  purchase／status に省略可能な引数を足す（§5）
- 呼び出し側が**自分の払えるレールのプロファイルを選ぶ**。Router は推測で選ばない

### 2.2 URL（FR-3・FR-4・U-8）

`parseUpstreamUrl(raw)` は純粋関数で、**ネットワークに出る前に**拒否する。通ったら `new URL(raw).href` が唯一の表現。

| 規則 | 値 |
|---|---|
| 長さ | 2048 文字以下 |
| scheme | `https:` のみ |
| userinfo・fragment | 拒否 |
| ポート | 既定（443）のみ |
| ホスト | IP リテラル（v4・v6）と末尾ドットは拒否 |
| `raw !== href` | **拒否**（`new URL()` が書き換える入力は、呼び出し側に直して出し直させる） |
| クエリ | 文字列の一部として許す |
| `denyHosts` 等 | §7.4 |

### 2.3 offer の選び方（FR-14）

上流が返した順に見て、**§3.3 の「offer の検査」をすべて通る最初の 1 件**。入力は offer 列・プロファイル・能力の種類だけ。
通るものが無ければ `no_matching_offer`。金額は 10 進の**正規形**（`^(0|[1-9][0-9]{0,29})$`。先頭ゼロ・指数・符号・空は拒否）だけを BigInt にする。記録に保存する額も同じ形（T5 の復元が要求する）。

### 2.4 quote の記録（FR-5・FR-11）

控え（昇格後は journal の `created`）に、既存の欄に加えて次を保存する。**承認対象に出す値はすべてここにある**。

```
upstream: { url, method: "GET" }
dynamic: {
  profileId,
  profile: { source: {network, asset, decimals, payTo}, destination: {scheme, network, asset, decimals, tokenDomain?, feeAsset?, maxFee?},
             rail, sourceRail, fee, maxUpstreamAmount },      // 適用したプロファイルの写し
  pricing: { upstreamAmount, converted, fee, total },
  ownerKeyHash
}
destination.selectedOffer    // payTo を含む。既存欄
routeFingerprint             // プロファイルの指紋。既存欄
```

### 2.5 `requestId` の衝突（FR-7）

`(principal, requestId)` が既にあるとき、既存が静的で要求も同じ静的 route なら従来どおり既存 quote を返す。
**それ以外は `request_id_conflict`**（動的 quote は冪等に再取得できない。返すには持ち主の証明が要るが、取り直す側はまだ持っていない）。

## 3. 送信レール（FR-8・FR-18・FR-24・FR-27・FR-28）

```ts
interface UpstreamTarget { readonly url: string }
interface OutboundRail {
  readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]>;
  pay(request: PayRequest /* + target?: UpstreamTarget */): Promise<PayResult>;
}
```

`target` が無い呼び出しは現行と同じ。ある呼び出しは adapter 生成時の `dynamic` オプション（プロファイル・動的用 transport・上限）を使い、
`dynamic` を持たない adapter では例外。core は動的 intent に**常に** `intent.upstream.url` を渡す。

### 3.1 動的経路の transport（FR-24・AC-12）— 要件どおり、loopback 例外を作らない

- 動的経路が使う transport は**すべて** `allowLoopback: false`: 上流への HTTP、動的プロファイルの MPP 送信の RPC、
  動的プロファイルの受信 adapter（facilitator・RPC）。`composeRails` は静的用とは別のインスタンスを作って渡す
- 動的プロファイルの MPP 能力は **viem の素の `http` transport** であること（`mpp.ts:246-275` の guarded 経路に必ず乗る）。
  `non-signing-fixture` の `custom` transport は guarded transport を通らないので、**動的プロファイルでは起動失敗**にする
- **無課金の成立試験（AC-2）のための継ぎ目**: `GuardedTransportOptions.dialForTest`。
  宛先の判定（解決・分類・拒否）は**本番と同じコードがそのまま走り**、判定を通った公開アドレスへの TCP 接続だけを、
  試験が指定した loopback の fixture（任意のポート）に向け直す。SNI と証明書検証は元のホスト名のまま（fixture は試験用 CA の証明書を出す）。
  つまり試験の Router でも、`https://127.0.0.1/…` や内部に解決する名前は**判定で拒否される**（AC-12 を書き換えない）
- `dialForTest` を渡せるのは `tests/fixtures/*` の起動スクリプトだけ。`src/main.ts` の本番経路と `tools/` はこの名前を参照しない（静的検査を試験にする）

### 3.2 一致の定義（FR-8・AC-6）

purchase 時の読み直しで比較するのは**保存した `DestinationOffer` の全体**（既存の `stableJson` 一致）。

| レール | 含む | 含まない |
|---|---|---|
| x402 | `scheme`・`network`・`asset`・`amount`・`payTo`・`maxTimeoutSeconds`・`extra`（`name`・`version`） | 402 の本文、`resource` の記述、`error` |
| mpp | `scheme`・`network`・`asset`・`amount`・`payTo`・`extra.realm`・`extra.terms`（`request` と `meta` の全文） | challenge の `id`・`expires`（`mpp.ts:120-145` の既存の射影） |

### 3.3 支払い操作の範囲（FR-18・U-3・AC-16）

**原則: 署名器に渡すものを、設定と承認済みの値から Router が組み直す。** 上流の offer と SDK は「何を払うか」の提案者でしかない。
検査は 3 段: (i) offer の検査（quote 時・読み直し時）、(ii) **署名の境界**、(iii) 送信の境界（MPP のみ・二重の確認）。

**x402 送信（EIP-3009 `exact`）**

| 段 | 内容 |
|---|---|
| (i) offer | 許す欄は下の T0-c の 3 のとおり（標準の 7 欄＋説明だけの欄。未知の欄は拒否）。`extra.name`・`extra.version` は**プロファイルの `tokenDomain` と一致**。`scheme === "exact"`、`network`・`asset` はプロファイルと一致、`amount <= maxUpstreamAmount`、`payTo` は EVM アドレスでゼロ・運用者自身・token コントラクトでない、`maxTimeoutSeconds` は 1〜600 |
| (ii) 署名（`x402.ts:399-424` の `guardedSigner` を置き換え） | SDK が渡した typed data から**取り出すのは `validAfter`・`validBefore`・`nonce` だけ**。`validAfter <= now`、`now < validBefore <= now + 660`、`nonce` は 32 バイトであることを確かめ、それ以外の値が承認済みと一致すること（`to`・`from`・`value`・`chainId`・`verifyingContract`）も確かめたうえで、**`domain = {name, version, chainId, verifyingContract}`（プロファイルから）、固定の `EIP712Domain`／`TransferWithAuthorization` 型定義、`message` を Router が組み直して署名器に渡す**。SDK が渡した `types`・`domain`・`primaryType` はそのまま使わない（`types.EIP712Domain` の差し替えで署名対象を変えられるため。`viem/_esm/utils/signature/hashTypedData.js:9`） |

**MPP 送信（Tempo charge・push・local account）**

| 段 | 内容 |
|---|---|
| 能力 | 動的プロファイルの MPP 能力は `mode: "push"` を明示し、**`account.type === "local"`** であること。違えば起動失敗（JSON-RPC account は `sendCallsSync` に行き、署名の境界を Router が持てない。`mppx/dist/tempo/client/Charge.js:200-219`） |
| (i) challenge | `method === "tempo"`・`intent === "charge"`。`request` と `methodDetails` のキーは許可リスト（下の T0-c の 4）。**`splits`・`feePayer`・`machineTokenEnabled`・未知のキーは拒否**。`amount > 0`（0 は送金ではなく proof 署名になる。`Charge.js:80-97`）、`supportedModes` が無いか `push` を含む、`currency`・`chainId` はプロファイルと一致 |
| (ii) 署名 | SDK に渡す account を **包んだ local account** にする。`signTransaction(tx)` は次を確かめてから、**確かめた欄だけで組み直した transaction** を元の account に署名させる: Tempo 型、`chainId` 一致、**call はちょうど 1 つ**で `to === asset`・`value === 0`・`data` が `transferWithMemo(recipient, amount, memo)` か `transfer(recipient, amount)` で `recipient`・`amount` が保存した offer と一致、**`feeToken === feeAsset`（未指定は拒否）**、`gas > 0`・`maxFeePerGas > 0` で手数料の上限が `maxFee` 以下、`validBefore <= now + 60`、`feePayer`・`authorizationList`・`keyAuthorization`・`accessList` が無い。1 支払いにつき署名は 1 回。**SDK に見せる account は最小の facade**: 持つのは `address`・`type: "local"`・この `signTransaction` だけ。`sign({hash})`（生の署名）・`signMessage`・`signTypedData`・`signAuthorization` は**存在しないか常に拒否**。`signTransaction` に渡された `serializer` 引数は**使わず**、Router が選んだ Tempo の serializer で直列化する（viem は serializer の出力のハッシュに署名するため。`viem/_esm/accounts/utils/signTransaction.js`）。元の account は `tempo.charge` の `account` にも、SDK に返す client にも**載せない**（今は両方に載っている。`mpp.ts:285`・`:332`）。組み直すとき、SDK が決めた nonce（expiring nonce）と有効期限の欄は範囲を確かめたうえで引き継ぐ |
| fee token の固定 | adapter が SDK に渡す client の chain に `feeToken: feeAsset` を設定する（viem は未指定のとき chain の値を入れる。`viem/_esm/tempo/chainConfig.js:123-124`）。入らなかった場合は (ii) が拒否する |
| (iii) 送信（既存の RPC guard に追加。`mpp.ts:307-321`） | **送金系のメソッド**のうち通すのは `eth_sendRawTransactionSync`／`eth_sendRawTransaction` のみ（見積り・nonce・receipt などの読取はそのまま通す）。raw を `ox/tempo` の `TxEnvelopeTempo.deserialize` で復号し、(ii) と同じ欄を**もう一度**確かめる。1 支払い 1 回 |

**実測（T0-a・T0-b、2026-10-05）**

*T0-a: SDK が署名器に渡すもの*（`tools/dyn-mpp-sign-probe.ts`。実 `mppx` の client と server、鍵は毎回の乱数、送金の RPC は常に stub）

| 問い | 結果 |
|---|---|
| 最小の facade（自分のプロパティは `address`・`type: "local"`・`signTransaction` の 3 つだけ）で支払いが通るか | **通る**。`signTransaction` は 1 回。SDK は facade に無い `keyType`・`source`・`nonceManager` も読みに来るが、`undefined` で先へ進む。`sign`・`signMessage`・`signTypedData`・`signAuthorization` は**読まれもしない** |
| 迂回の試み（オフライン。呼び出し側を直接演じた） | 生の署名口は facade に**存在しない**（`typeof` が `undefined`）。別の受取先・100 倍の額を出力する serializer を `signTransaction` に渡しても、**署名されるのは検査した transaction**。対照として、渡された serializer を使う素の account は差し替えた中身に署名した |
| SDK は `serializer` 引数を渡すか | **渡す**。したがって facade は渡された serializer を無視し、Router が選んだ Tempo の serializer（`viem/tempo` の `Transaction.serialize`）を使う。そうして署名した raw は送金の RPC に渡る raw と一致し、`0x76` の Tempo transaction として復号できる |
| `signTransaction` に渡る欄 | `calls`（1 つ。`to`＝token、`data`＝`transferWithMemo(recipient, amount, memo)`。SDK は `abi`・`functionName`・`args`・`address` も付ける）、`chainId`、`from`、`gas`、`maxFeePerGas`、`maxPriorityFeePerGas`、`nonce: 0`、`nonceKey: 2^256−1`（expiring nonce）、`validBefore`（現在＋25 秒）、`type`、`feeToken`（下記）。ほかに `account`・`chain`・`nonceManager` と、値が無い `accessList`・`authorizationList`・`blobs`・`data`・`gasPrice`・`maxFeePerBlobGas`・`to`・`value` |
| chain に `feeToken` を設定すると入るか | **入る**（署名に渡る transaction にも、送る raw にも）。設定しないと**欄ごと無い** |
| 1 件の支払いで出る RPC | **実ノードで測ったのは署名の手前まで**: 読取の RPC は `eth_fillTransaction` の 1 回で、そこで `gas`・`maxFeePerGas`・`maxPriorityFeePerGas` が埋まって署名に到達する（実測: `gas 54278`、`type: "tempo"`）。その後の送金（`eth_sendRawTransactionSync`）は**実ノードでは実行していない**（ソースからの見込みで計 2 回）。`eth_fillTransaction` を持たない stub では `eth_getBlockByNumber`・`eth_maxPriorityFeePerGas`・`eth_estimateGas` を経て送金まで計 5 回（実行して確認）。`eth_maxPriorityFeePerGas` も無いノードでは `eth_gasPrice` に落ちて 6 回になり得る（ソースから。未実行）。**送金の RPC は 1 回**で、viem は送金の RPC を再試行しない |
| 残高の無い送信者 | `eth_fillTransaction` の段で `InsufficientBalance` になり、**署名に到達しない** |

帰結: **gas と手数料の単価は RPC ノードの応答から決まる**（`eth_fillTransaction`、または手数料の見積り。viem は見積りに既定で 1.2 倍の係数を掛ける）。Router は署名の境界で上限と照合する以外にそれを抑える手段を持たない。
上限は**損失の上限**であって、経済的な値や成功を保証しない: ノードは上限の内側で高い手数料を提案でき、少なすぎる gas を提案すれば手数料だけ取られて失敗する。
上流の challenge は gas や単価を直接は指定できないが、支払いの内容（宛先・額・memo）を通して見積りに影響し得る。
facade が組み直すときに引き継ぐのは、SDK・ノードが決めた `gas`・`maxFeePerGas`・`maxPriorityFeePerGas`・`nonce`・`nonceKey`・`validBefore` で、
それぞれ範囲を確かめる（`nonceKey` は `2^256−1`、`nonce` は 0、`validBefore` は現在＋60 秒以内、`maxPriorityFeePerGas <= maxFeePerGas`）。
T9 の試験が固定する RPC の回数は、**再試行なし・成功する指定の fixture に対して**「送金 1 回、全体 5 回以下」とする（ノードの対応で回数が変わるため等号では固定しない。`eth_gasPrice` への落ち方は別の fixture で記録する）。

**組み直しの契約（T9）**:
- call は検証した `to`・`data`・`value`（0）だけを写す。SDK が付ける `abi`・`functionName`・`args`・`address` は捨てる（直列化に使われるのは前の 3 つだけ）
- `account`・`chain`・`nonceManager` と、値の無い欄は捨てる。**値のある未対応の欄**（`feePayerSignature`、署名・multisig、`authorizationList`、`keyAuthorization`、`accessList`、`validAfter` など）があれば拒否する
- `type` は、対応する形であることを確かめたうえで `"tempo"` に揃える（見積りに落ちた経路では SDK が `"eip1559"` と付けてくるが、`calls` があれば Tempo として直列化される）
- 数値は有限の整数であること。`now < validBefore <= now + 60`、`gas > 0`、`maxFeePerGas > 0`、`0 <= maxPriorityFeePerGas <= maxFeePerGas`、`nonceKey === 2^256 − 1`、`nonce === 0`

*T0-b: 手数料の実額と換算*（`tools/dyn-mpp-fee-probe.ts`。本番の journal にある**既に送った** MPP 送信 13 件の transaction と receipt を公開 RPC から読んだだけ）

| 項目 | 結果 |
|---|---|
| 手数料の徴収の現れ方 | receipt に、送信者から fee manager（`0xfeec…`）への Transfer として出る。receipt は `feeToken`・`feePayer` を持つ |
| 換算 | **手数料（6 桁の資産の base units）= ceil(gasUsed × effectiveGasPrice / 10^12)**。13 件すべてで実額と**一致**（fee manager の正確なアドレス宛て・receipt の `feeToken`・送信者から、の Transfer が各 1 件。fee manager からの戻りは 0 件） |
| 署名前に分かる上限 | **ceil(gas × maxFeePerGas / 10^12)**。13 件すべてで実額以上（実額 29〜478 に対し上限 79〜706） |
| 実額の幅 | 元本 10000（0.01）に対し **29・276〜277・478 base units**（0.000029〜0.000478）。`gasUsed` は 13 件とも 46683 で、差は単価（`effectiveGasPrice` 6.0e8〜1.02e10、約 17 倍）による |
| 手数料の資産 | 過去の 13 件は transaction に `feeToken` を**指定していない**が、receipt の `feeToken` は 13 件とも pathUSD（`0x20c0…`）。指定が無いときの決まり方はチェーン側の規則で、**本書はそれに依らず `feeToken` の明示を要求する** |

**この換算と上限は「観測と一致した」段階で、保証としては未確立**（M-1 は**一部だけ済**）:

- 10^12 は「単価は 18 桁、手数料の資産は 6 桁」という関係に合い、優先手数料は `maxFeePerGas` に含まれる（別に足さない）。ここまでは手元のコードと矛盾しない
- しかし手数料の**徴収そのもの**（Fee AMM を通す換算、その差額、丸め、返金）は導入済みのパッケージには実装が無く、チェーン側の規則である。
  `feeToken` が検証者の受け取る資産と違う場合に送信者の負担が増えるかどうかを、手元では確かめられない
- 観測したのは **pathUSD を手数料に使った 13 件だけ**。他の資産（6 桁であっても）には当てはめない

したがって: 署名の境界は「ceil(gas × maxFeePerGas / 10^12) <= maxFee」を確かめるが、**これが実際の負担の上限であることは、Tempo の手数料の仕様で
AMM と返金の扱いを確認するまで主張しない**。確認が済むまで、MPP 送信のプロファイルは `feeAsset` = pathUSD に限り、
T16 の G-2（testnet の実決済）で receipt の実額が上限以下であることを毎件確かめる。仕様で上限が確立できなければ、MPP 送信のプロファイルは有効にしない。

値の案（G-1 で owner が決める）: `maxFee` は **5000 base units**（0.005。観測した上限の最大 706 の約 7 倍。単価がさらに上がると支払いを拒否する側に倒れる）。
手数料規則は、元本 10000 に対し送信手数料が最大 478（約 4.8%）だったことから、**定額で賄う**のが分かりやすい（例: `flat 1000`・`bps 0`・`min 1000`。
0.001 を上乗せし、観測した最大の約 2 倍）。率で取ると少額の購入で送信手数料を賄えない。
**`flat 1000` が賄うのは観測した範囲であって、許可する上限（`maxFee 5000`）ではない**: 単価が上がった支払いでは、1 件あたり最大 4000 base units の送信手数料が運用者の持ち出しになり得る。持ち出しを無くすなら `flat` を `maxFee` 以上にする。

**まだ示していないこと**: 製品の facade が**拒否すべき入力**（call 2 つ、別の `to`、`feeToken` の不一致、`keyAuthorization` など）で元の account を呼ばないこと。
probe が示したのは「生の署名口が無い」「serializer の差し替えが効かない」の 2 点で、欄ごとの拒否は T9 の実装と試験で確かめる。実ノードでの**新しい**送金は行っていない。

*T0-c: 実在のエンドポイントが未払いの GET に返す欄*（`tools/dyn-challenge-survey.ts`、2026-10-05T11:12Z と 11:16Z の 2 回。各回、各 URL に支払いヘッダなしの GET を 1 回。欄の名前と型だけを記録し、本文は保存していない。**標本は 8 件（うち第三者 6 件）で、以下の結論はこの 8 件についてのもの**）

x402（8 件中 7 件。すべて v2 で `PAYMENT-REQUIRED` ヘッダを返し、**`resource.url` は要求した URL と一致**）:

| エンドポイント | ヘッダ | offer（順に） | 標準の 7 欄と `extra.{name,version}` 以外 |
|---|---|---|---|
| `provider-x402.subethalabs.com/v1/eth/snapshot`（運用者の A） | 620 B | `exact` Base Sepolia | なし |
| `crypto.apitoll.cloud/v1/crypto/price` | 3.8 KB | `exact` Base／`exact` Solana | 1 件目: なし。2 件目: `extra.feePayer` |
| `x402.ottoai.services/crypto-news` | 10.6 KB | `exact` Base／`exact` Base／`exact` Solana | 1 件目: なし。2 件目: `extra.assetTransferMethod`。3 件目: `extra.feePayer` |
| `rubric-protocol.com/v1/x402/hedera-facts/exchange-rate` | 4.1 KB | `exact` Base／Solana／Algorand | 1 件目: なし。他: `extra.feePayer` |
| `api.oblique.markets/api/v1/paid/time` | 4.5 KB | `exact` Base／Solana | 1 件目: `description`・`maxAmountRequired`・`resource`、`extra.bazaar` |
| `hypernatt.com/api/m2m/liq-radar` | 5.0 KB | `exact` Base／Solana | 1 件目: `description`・`maxAmountRequired`・`mimeType`・`resource`、`extra.decimals` |
| `api.onesource.io/api/chain/erc20-balance` | 4.2 KB | `exact` Base／`batch-settlement` Base | 1 件目: `currency`・`maxAmountRequired`・`recipient`、`extra.credentialTypes`。2 件目: `extra.receiverAuthorizer`・`withdrawDelay` |

`PAYMENT-REQUIRED` のトップレベルは `accepts`・`error`・`resource`・`x402Version` に加えて `extensions`（6 件）、`contact`・`free_demo`・`gateway`・`outputSchema`（1 件）。
`resource` は `url`・`description`・`mimeType` に加えて `serviceName`・`tags`・`iconUrl`。
**トップレベルの `resource.url` は要求した URL との完全一致を要求する**（§3.2・§11。これが resource の束縛）。それ以外の `resource` の欄と、上のトップレベルの追加の欄は、署名にも照合にも使わない。
offer の中の `resource`（一部の Provider が残している旧い形）は説明用の欄として扱い、束縛には使わない。

MPP（3 件。`WWW-Authenticate: Payment`）:

| エンドポイント | challenge の欄 | `request` の欄 | `methodDetails` |
|---|---|---|---|
| `provider-mpp.subethalabs.com/v1/eth/snapshot`（運用者の B） | `id`・`realm`・`method`・`intent`・`request`・`expires`・`opaque` | `amount`・`currency`・`recipient`・`methodDetails` | `chainId: 42431` |
| `api.oblique.markets/…`（x402 と同じ URL） | `opaque` なし | 上に加えて `description` | `chainId: 4217`、`supportedModes: ["pull"]` |
| `api.onesource.io/…`（x402 と同じ URL） | `opaque` なし、`description` あり。**1 つのヘッダに challenge が 3 つ** | 上に加えて `description`。3 つ目は `suggestedDeposit` も | `chainId: 4217`。3 つ目は `escrowContract`・`minVoucherDelta`（charge ではない別の種類） |

生の `WWW-Authenticate` のパラメータ名と、SDK が正規化した後の欄は、3 件とも一致した（SDK が落とした未知の欄は無かった）。

**ここから決めること**

1. **調べた第三者の 6 件はすべて mainnet の資産を要求した**（x402 は Base `eip155:8453`、MPP は Tempo `4217`）。testnet の資産ペアしか持たない現在のプロファイルでは、
   この 6 件はどれも `no_matching_offer` になる。testnet で動いている第三者の Provider があるかどうかは**調べていない**（discovery の一覧の先頭から選んだ 6 件だけ）。
   確かなのは、testnet の間に動的 URL で買えると分かっているのが運用者の A・B だけ、ということ
2. **offer の選択**: 第三者の x402 の 6 件は複数の offer を並べ、1 件目が EVM の `exact` だった（運用者の A は 1 件だけ）。MPP も 1 つのヘッダに複数の challenge を返すものがあった（1 件）ので、**x402・MPP とも**「上流の順に見て、検査を通る最初の 1 件」（§2.3）とする。
   `extra.assetTransferMethod`（Permit2）・`extra.feePayer`・`batch-settlement`、MPP の charge 以外の種類は検査で候補から外れる
3. **x402 の offer に許す欄**（(i) の「トップレベルのキー」を次に改める）:
   - 必須: `scheme`・`network`・`asset`・`amount`・`payTo`・`maxTimeoutSeconds`・`extra.name`・`extra.version`
   - **説明だけの欄として許す**（署名は Router が組み直すので、これらは署名の内容に影響しない）: `description`・`mimeType`・`resource`、`extra.bazaar`。
     値が支払いの条件と重なる欄は**一致するときだけ**許す: `maxAmountRequired === amount`、`extra.decimals === プロファイルの decimals`
   - それ以外（`currency`・`recipient`・`extra.credentialTypes`・`extra.assetTransferMethod`・`extra.paymentFlow`・`extra.feePayer` など未知の欄）は拒否。
     このうち `assetTransferMethod`（転送方法を Permit2 に切り替える）と `paymentFlow` は、SDK が**支払いの仕方そのもの**を変える欄である
   - 前提は **x402 v2**（`x402Version === 2`）。`maxAmountRequired` は v1 の欄で、v2 では意味を持たないので「`amount` と同じ値のときだけ許す」にしている
   - 選んだ offer は、許した欄を含めて**そのまま上流に送り返される**（SDK が `accepted` に入れる）。署名の権限は広がらないが、
     その欄を上流がどう解釈するかは分からないので、**許した欄があっても成立するとは限らない**
   - この規則で 1 件目の offer が通るのは、第三者 6 件中 **5 件**（標準の欄だけに絞ると 3 件）。network が合えば、の話である
4. **MPP の challenge に許す欄**: challenge は `id`・`realm`・`method`・`intent`・`request`・`expires` と、任意の `opaque`・`description`・`digest`。
   `request` は `amount`・`currency`・`recipient`・`methodDetails` と、任意の `description`。`methodDetails` は `chainId` と、任意の `supportedModes`。
   SDK が認識する他の欄は**拒否する**: challenge の `header`（credential の送り先を変える）、`request.externalId`、`methodDetails` の `splits`・`feePayer`・`machineTokenEnabled`・`memo`
   （`memo` は SDK が challenge から作った値で上書きするので、上流が指定する意味が無い）。`digest` は要求本文の束縛で、本文の無い GET では使われない。
   `supportedModes` が `pull` だけのもの（今回 1 件）は拒否。**第三者の 2 件はどちらも `opaque`（scope）を持たない**ので、§11 の「あれば照合・無ければ不問」が必要であることが確かめられた。
   これは動的経路で**新しく作る**振る舞いで、既存の adapter は scope を必須にしている（`src/adapters/outbound/mpp.ts`）。`opaque` があるときは中身を変えずに保ち、復号した scope を照合する
5. **ヘッダの上限**: `PAYMENT-REQUIRED` だけで最大 10.6 KB あった。応答ヘッダ全体の大きさは測っていないので 16 KiB で足りないと示したわけではないが、
   余裕を取って §3.4 の上限を **16 KiB から 32 KiB に上げる**
6. 同じ URL が x402 と MPP の両方を返すエンドポイントが 2 件あった。プロファイルは送信レールを 1 つ決めているので、使うのはそのレールの方だけ

この調査は**未払いの応答の形**だけを見ている。Router の動的 quote がこれらの URL で成立するかどうか（M-4。これも未払いの読取で測る）と、
実際に支払って成立するかどうか（T16 の G-2・G-3）は、どちらもまだ測っていない。

### 3.4 上流から受け取るものの上限と、応答の扱い（FR-27・FR-28）

| 対象 | 上限 | 超過時 |
|---|---|---|
| 応答ヘッダ全体 | **32 KiB**（動的用 Agent に `maxHeaderSize` を**明示**。undici の既定は Node から継承され固定値ではない。実測で `PAYMENT-REQUIRED` だけで 10.6 KB のものがあった） | **未払いの要求**では transport の失敗。**支払いヘッダを付けた要求**では送金の有無が分からないので `unknown` |
| 402 の本文 | 64 KiB | 中断。quote 不成立／`destination_challenge_unreadable` |
| `accepts`／challenge の個数 | 16 | 同上 |
| 有料応答の本文 | 256 KiB | 下の順序で判定 |

有料応答は**本文を読む前に** receipt ヘッダを Router 自身が検証する（x402 の SDK の `processResponse` は本文を先に読むので使わない。
`@x402/core` の該当箇所を確認済み。receipt の復号は SDK の関数を使う）。
receipt が整合 → 本文を上限つきで読む → 超過は `paid_no_data`（`response_too_large`）、対応外の形は `paid_no_data`（`unsupported_response`）。
receipt が不整合・無い → 本文は読まずに捨て、`unknown`（既存の判定のまま）。

**対応する応答**: `content-type` が `application/json`（パラメータ可）で、**最上位が JSON object**。配列・文字列・数値・text は対応外（AC-15 のとおり）。
journal に保存する本文は 256 KiB が上限。

## 4. 受信の束縛（U-2・FR-6・AC-5）

**x402 受信**（動的プロファイルの adapter だけに有効にする生成時オプション。静的は変えない）: preflight に
`authorization.nonce === offer.extra.challengeNonce`、`to === offer.payTo`、`value === offer.amount`、`validBefore <= offer.extra.expiresAt` を追加する。
**束縛を成立させるのは preflight ではなく、続く facilitator の署名検証**である: 署名は `nonce` を含むので（`@x402/evm/dist/esm/exact/facilitator/index.mjs:121`）、
別の quote 用の署名の `nonce` 欄だけを書き換えた credential は preflight を通っても **verify で落ちる**。preflight の追加は、
「別の quote の署名をそのまま持ち込む」ものを早く落とす役目。試験は両方の形を verify まで通して確かめる。
呼び出し側の署名ツールは既にこの形で署名している（`tools/x402-payer.ts:56-57`）。

**MPP 受信**: PR #7 の束縛（wire credential の**中の** challenge の id が、発行した offer の id と一致）を前提にする。
SDK は中の challenge を HMAC で認証し（額・受取先・期限・opaque を含む）、送金の memo をその challenge に照合する。
SDK の memo 束縛は challenge の 56 ビットの要約であり、衝突に依らない一意性ではない（§11）。
AC-5 は**実 SDK＋実際の形の receipt を返す RPC fixture**で、(a) 正しい credential が通る (b) B の id に A の欄 (c) B の challenge に A の送金、
の 3 つを verify と settle の両方で確かめ、journal の再オープン後と A/A・A/B の並行でも**送信の呼び出し回数**を数える。

**額**: 受信額は quote ごとに違う。adapter の `createOffer` は元々 `request.amount` を使う。core の照合（`orchestrator.ts:329-339`）は、
動的では「設定の額」ではなく「計算した `total`」と比べる。

## 5. 持ち主の分離（U-7・FR-32・AC-20）

- quote 発行時に `ownerKey`（乱数 32 バイト、base64url）を作り、**`sha256(ownerKey)` だけ**を保存する。`ownerKey` は quote の応答に 1 度だけ載る
- 動的 quote／intent に対する**すべての入口**で、応答を組む前に照合する（`timingSafeEqual`）: `purchase`（既に始まった購入の現在状態を返す分岐・
  冪等な応答を含む）、`status`、`offerFor` の 2 箇所（`http/app.ts:331`・`:392`）。不一致は**存在しない場合と同じ応答**
- 運び方: HTTP はヘッダ `x-router-owner-key`。MCP の purchase は持ち回っている quote 文書の `ownerKey` を載せる。status に省略可能な引数 `ownerKey`
- **漏らさない**: journal・控えにはハッシュだけ。ログ・エラー本文・診断に `ownerKey` と要求ヘッダを出さない。
  `tools/remote-mcp.ts:281` は例外のメッセージをそのまま出しているので、固定文に変える。漏洩の有無を試験する（§13）

## 6. 控え・昇格・予算（FR-19〜22・FR-33・U-5）

### 6.1 控え（quote ledger）

`<journal の directory>/dynamic-quotes/<UTC 日付>.ndjson` に append＋fsync。書き手は Router プロセスだけ。行は 2 種類:

- `quote`: §2.4 の記録
- `attempt`: `{ quoteId, at, credentialDigest }`。**1 quote につき最初の 1 行だけ**書く

メモリには**期限内の quote**だけを持つ。起動時は保持期間内のファイルから、期限内の quote と、journal に昇格済みでないものを読む。
**保持期間は 7 日**（`limits.ledgerRetentionDays`）。それより古いファイルは起動時と、日付が替わって最初に書くときに削除する
（控え自身は、何も書かれないまま日付が替わっただけでは削除しない。**定期的な削除の呼び出しは T10 で組み込む**）。
期限内の未払い quote の数に上限（§7）。超えたら上流に接続する前に `dynamic_capacity`。

### 6.2 purchase の順序

```
1. ownerKey・requestId・approval・指紋・期限・preflight                         … 何も書かない
2. 控えに attempt を書く（その quote で初めてのときだけ）
3. 残高の事前確認（§6.6）→ 上流の読み直しと照合 → 受信 verify                    … 何も書かない
4. 期限の再検査
5. 【昇格】動的予算の mutex の中で: 残枠の検査 →（通れば）journal に 1 行 `created`（記録の写し＋予約の内容）を append＋fsync
     通らなければ何も書かずに `bucket_limit` 等で終わる
6. `source_pending` → 受信 settle → 以降は静的と同じ
```

- **予算と昇格は 1 つの journal 行**。動的の予算は `created` 行のうち `dynamic.reservation` を持つものを数える（別のイベントを足さない）。
  「予約はあるが intent が無い」「intent はあるが予約が無い」という中間状態が存在しない
- **journal に行が増えるのは予算が通ったときだけ**なので、journal・`IntentStore`・再生時間は**動的予算の件数上限**で有界になる（FR-33）。
  予算が尽きた後の試行、verify 後の期限切れ、無効な署名は、いずれも journal を増やさない
- クラッシュの境界: 5 の前 → journal に何も無く、quote は控えにあり、期限内なら再試行できる。5 の後・6 の前 → `created`（予約済み）が残る。
  **その quote の再試行は手順 1〜4 をすべてやり直し（持ち主・承認・指紋／無効化・期限・preflight・上流の読み直し・verify）、省くのは手順 5 の予約だけ**
  （`created` 行が既にあれば予約済みとして扱う）。期限切れ・無効化された quote は予約済みでも settle に進まない。6 の途中 → 再起動で `unknown`（既存の規則）。
  journal の行が途中で切れた場合は、既存どおり起動時に fail closed（自動では再試行可能にならない。`src/core/journal.ts`）
- 既存の `Budget` はこの形を**まだ持たない**（`budget_reserved` だけを数え、受信・送信の 2 つの額しか持たない。`src/core/budget.ts:61-82`、`:108-149`）。
  動的用に「`created` 行の `dynamic.reservation` を数える再生」「手数料の額」「検査と append を同じ mutex で行う昇格」を足す。二重の昇格は
  quote ごとの直列化（`orchestrator.ts` の `withKey`）と `IntentStore` の同一性検査（`store.ts:211-216`）が止める

### 6.3 「何も書かない」と既存の `unknown` の意味の関係

静的の流れは verify の前に `source_pending` を書き、中断を `unknown` にする。動的は昇格まで journal に書かない。この違いが安全な理由と、失うもの:

- **Router 側**: 5 より前に Router が動かす資金は無い（verify は資金も replay の記録も動かさない）。journal に残すべき Router の行為が無い
- **x402 受信の呼び出し側**: 5 より前に資金は動かない。失うものは無い
- **MPP 受信の呼び出し側（ここは安全性ではなく、証拠の保持と回復の取り引き）**: 送金は purchase の前に済んでいる。verify が `false` を返しても**未払いの証明ではない**
  （adapter は RPC の失敗も `false` にする。`src/adapters/inbound/mpp.ts`）。そこで:
  - 手順 2 の `attempt` 行が「この quote に対して credential が提出された」事実を**7 日間**残す（credential 自体ではなく要約）
  - 昇格前の失敗は quote を潰さない。**期限内なら同じ credential で再試行できる**（静的では verify の失敗で quote が終端になるので、動的の方が呼び出し側に有利）
  - 期限が切れたら再試行はできず、資金は戻らない。これは静的でも同じ（要件 §7）。`attempt` 行は運用者が手作業で調べる手掛かりになる
  - **静的より弱くなる点**: 静的は verify 中の中断を journal の `unknown` として**無期限に**残す。動的が残すのは「最初に提出された credential の要約」
    1 行で、**7 日で消え**、後から別の credential が出された場合はそれを指さない。公開状態も `unknown` ではなく `awaiting_payment` になる。
    journal を払わない試行で増やさないことと引き換えの、**期限つきの証拠保持**である（§11）
- 公開状態: 昇格前の quote に対する status は `awaiting_payment` を返す。**MPP では「未払い」を意味しない**ことを、動的 quote の `disclosures` と status の応答に明記する（§8）

### 6.4 動的側の予算（FR-19・FR-22）

- `dynamic.budget` は別の `Budget` インスタンス。静的は従来どおり `budget_reserved` だけを数え、互いに干渉しない
- 1 件の予約 = 受信額（受信資産のバケット）＋ 送信元本（送信資産のバケット）＋ **`maxFee`（`feeAsset` のバケット）**。
  MPP 送信では §3.3 (ii) が手数料資産と上限を署名前に強制し、署名は 1 支払い 1 回なので、**動的購入による送信側の支出（元本＋手数料）は
  `dynamic.budget` の通算上限を超えない**。x402 送信は facilitator がガスを払うので `maxFee` は 0
- この主張は M-1（換算）が確かめられた範囲でのみ成り立つ（§3.3）
- 動的側が尽きると動的 purchase は明示的に失敗し、静的 route は影響を受けない。**最大損失は `dynamic.budget` の通算上限**と `DEPLOY.md` に書く

### 6.5 予算の 4 分類（FR-21・U-5）

| 分類 | 残るもの | 動的予算 |
|---|---|---|
| (1) 発行しただけの quote | 控え | 消費しない |
| (2) 受信が成立しなかったと確定した試行 | 控え（`attempt`） | 消費しない |
| (3) 結果が不明な試行（昇格後） | journal（`unknown`） | 保持 |
| (3') MPP 受信で、昇格前に verify できなかった試行 | 控え（`attempt`、7 日） | 消費しない。**未払いとは言えない**が Router は何も支出していない |
| (4) 受信が成立した購入 | journal | 保持 |

rail ごとの「確定」:

| rail | 確定して未成立 | 不明として保持 |
|---|---|---|
| x402 受信 | verify が成立しない（昇格前）。 | 昇格後の settle の失敗すべて。facilitator は送信前に `success:false` を返すことも、送信後に返すこともあり（`@x402/evm/.../facilitator/index.mjs:305` 付近）、**Router は応答からその 2 つを確実には区別できない**（理由文字列を信用しない方針。`src/adapters/inbound/x402.ts:14-17`） |
| MPP 受信 | 昇格前に終わる試行は予算に触れない（未払いの証明ではないが、Router は何も支出していない） | 昇格後の settle の失敗すべて |

昇格後の settle 拒否を解放する仕組み（x402 なら期限後に `authorizationState` を読んで未使用を確かめる）は**本スライスに入れない**。
攻撃には資金のある口座の有効な署名と、verify と settle の間に失敗させる操作が要り、1 回で減るのは動的側の 1 件分（§11）。

### 6.6 受信額・手数料・残高（FR-15・FR-17・FR-20）

```
converted = upstreamAmount × 10^(source.decimals − destination.decimals)   // 負の指数で割り切れなければ拒否
fee       = max(fee.min, fee.flat + ceil(converted × fee.bps / 10000))
total     = converted + fee                                                // BigInt。30 桁を超えたら拒否
```

`upstreamAmount > maxUpstreamAmount`、`total` が受信側の 1 件上限を超える、は quote 不成立。**手数料の値は owner が決める**（M-1 の後に案を出す）。

残高の事前確認: 送信能力に省略可能な `balanceOf(asset)`。あるとき、手順 3 で**元本の資産と手数料の資産を別々に**確かめ（同じ資産なら合算）、
足りなければ `operator_funds_unavailable`。無いときは検査しない。検査と送信の間の競合は残る。MPP 受信の呼び出し側は守らない（FR-10 (c)）。

## 7. 匿名利用への対策（FR-25・FR-26・FR-30・FR-31・U-6）

### 7.1 入口の資源上限（FR-31）— **静的の呼び出しにも掛かる。要件 FR-35 に例外として追記する**（§12）

| 入口 | 上限 |
|---|---|
| `tools/remote-mcp.ts` | 要求本文 64 KiB（超過は読み切らずに 413）、ヘッダ＋本文の受信期限 10 秒、同時接続数 64 |
| `src/http/app.ts`（R1〜R4） | 本文 16 KiB（既存）。`server.headersTimeout`・`requestTimeout` を 10 秒に明示 |

正当な呼び出しは quote 文書と credential を合わせても数 KiB で、影響を受けない
（T12 の実測: 実際の MCP クライアントが送る本文は quote 190 バイト・purchase 5845 バイト・status 153 バイト。上限の 1/11 以下）。

T12 の独立レビューを受けて、入口に次を**足した**（いずれも匿名の相手が接続の枠を持ち続けるのを防ぐため）:

- **GET の stream は出さない**（405）。ステートレスなのでサーバから送り始める stream が無く、受け付けると応答を返さない接続だけで枠を埋められる。MCP の仕様上、stream を出さないサーバは 405 を返してよい
- **要求 1 件が接続を使える時間の上限 120 秒**（受信開始から応答の完了まで）。受信の期限は応答の時間を縛らないので、応答をわざと遅く読む相手が枠を持ち続けられた
- **POST の本文は入口で JSON として検証**し、`mcp-protocol-version` は日付の形だけを通す（SDK は解析エラーと未対応の値を応答にそのまま写す）
- 拒否の応答は**書き終えてから**接続を切る（すぐ切ると応答が届かない）
- tool の中の例外は `src/mcp/server.ts` で固定文にする（SDK に任せると `error.message` が結果に載る）

**残る限界**: MCP の SDK が自分で作るエラー応答（JSON-RPC の形式エラー、対応していない日付の protocol version など）は SDK の文面のままで、
呼び出し側自身の入力についての説明を含む。応答の stream が内部で失敗したときに SDK の下の層が `console.error` に出す経路も残る。
同時接続数 64 は Caddy の接続の使い回しと合わせた実負荷での妥当性を未確認（T16 の G-2 で観察する）。

### 7.2 送信元の識別

送信元 = Caddy が付ける `X-Forwarded-For` の最後の値。Caddy の `reverse_proxy` は既定で外から来た転送ヘッダを信用せず上書きする。
**この信頼は配置に依存する**: プロセスは `0.0.0.0` で待ち受け（`tools/remote-mcp.ts:296`）、Docker の公開設定が `127.0.0.1:8787` に限っている（`DEPLOY.md` §6）。
同じホストや同じ Docker network から直接届く要求はヘッダを偽れるが、それは運用者の管理下にある。ヘッダが無い要求は 1 つの送信元として数える。
`DEPLOY.md` に「動的 URL を有効にするホストは、Router の port を Caddy 以外に公開しない」を条件として書く。

### 7.3 動的の門（`DynamicGate`、core 内）

quote と purchase 試行の両方が通る。**上流・facilitator・RPC のどれにも接続する前**に判定し、purchase は**手順 1〜6 の全体**を 1 つの枠として数える。

| 対象 | 上限（初期値） |
|---|---|
| 動的 quote: 全体／送信元ごと | 10／分 ／ 3／分 |
| 動的 purchase 試行: 全体／送信元ごと | 10／分 ／ 3／分 |
| 同時に進行中の動的操作: 全体／送信元ごと | 8 ／ 2 |
| 期限内の未払い quote | 200 |
| 宛先ホスト名ごと: 頻度／同時 | 10／分 ／ 2 |
| 宛先アドレスごと: 頻度／同時 | 60／分 ／ 4 |

- **送信元は MCP 層から core に渡す**（HTTP ヘッダ `x-router-source`）。MCP サーバは外から来た同名のヘッダを使わず、**自分が導いた値で必ず上書きする**。
  このヘッダは認証ではない: Router の HTTP（既定で loopback。`src/config.ts:562`）に直接届くプロセスは任意の値を名乗れる。
  公開しているのは MCP の port だけ（`DEPLOY.md` §6）なので遠隔からは届かないが、**Router の HTTP に届くローカルのプロセスは信頼する**ことを配置の条件として `DEPLOY.md` に書く
- **アドレス単位**: guarded transport の `vet` が返す**検査済みアドレスの全部**に対して、接続の前に枠を取る（どれに接続するかは undici が決めるため、
  全アドレスが枠内のときだけ通す）。枠は応答の本文を読み終えるか中断したときに返す。`admit`／`release` のフックを `src/net/guarded-fetch.ts` の `vet` の直後に足す
- 枠を取るのは**重複を除いた検査済みアドレスの全部**に対して不可分に。返すのは本文の読了・中断・失敗のとき
  （`fetch` は headers で戻るので、`finally` ではなく本文の stream の終了に結び付ける。`guarded-fetch.ts:282`）
- **DNS**: 動的用 transport では解決に**期限（3 秒）**を付け、要求の中断と期限のどちらでも待ちを打ち切る（今の `vet` は中断を見ない。`guarded-fetch.ts:228`）。
  `dns.lookup` 自体は取り消せないので、**進行中の解決の数にも上限**を置き、期限で待ちをやめた解決は終わるまでその枠を使い続ける
- 門の待ち行列は持たない（超過は即 429）。カウンタは時間窓ごとに捨て、保持するキーの数に上限。**上限を超えたら新しいキーの要求は拒否する**（緩い枠に落とさない）
- 控えの 1 行は**直列化後 8 KiB 以下**（超える quote は成立させない）。`attempt` 行は 1 quote に 1 行・512 バイト以下
- 状態はプロセス内で、再起動で消える。上限と未払い quote の保持（7 日・行の大きさ）から、控えの最悪ディスク使用量は
  `10／分 × 60 × 24 × 7 × 8.5 KiB ≈ 860 MiB`。メモリに載るのは期限内の 200 件まで
- facilitator・RPC の容量: 1 件の purchase は verify・settle・送信の準備・receipt の照合でそれぞれ複数の要求を出すので、
  **purchase の頻度上限は RPC の要求数の上限ではない**。抑えるのは同時実行数（全体 8）と 1 要求ごとの期限・再試行なし（A の transport）で、
  1 件あたりの要求数の上限は実装時に数えて試験に固定する（M-2）。静的 route の要求はこの枠の外にある

### 7.4 自分自身と依存先（FR-25・AC-13）— **別名は防げない。要件に限界として追記する**（§12）

`parseUpstreamUrl` はホスト名が次に一致するかそのサブドメインなら拒否する: `canonicalBaseUrl` のホスト、`dynamic.denyHosts`、
設定済みの facilitator と RPC の URL のホスト。

- **Router 自身**: 公開アドレスへの直接接続は B が落とす。公開プロキシ経由は A・B の範囲外（`ssrf-requirements.md:277-278`）で、ホスト名の拒否が唯一の防御
- **facilitator・RPC**: 同じサーバを指す**別の有効なホスト名**（CDN の別名、有効な証明書つき）は拒否できない。第 1 版の「TLS で失敗する」は誤り。
  これらは誰でも直接届く公開サービスであり、Router 経由で増えるのは負荷だけなので、**アドレス単位の上限（7.3）で抑える**ことを防御とする。
  アドレスの一致で拒否する案は、CDN を共有する無関係な Provider を巻き込むので採らない
- 試験: 拒否ホスト名・サブドメインの拒否（AC-13）と、**別名で同じアドレスに届く場合にアドレス単位の枠を共有する**こと（AC-17）

### 7.5 配置の条件（FR-24 の運用条件）

`DEPLOY.md` に追記: 動的 URL を有効にしてよいのは、B の標準受け入れ（`subetha-egress-verify`）が通っているホストだけ。
Router 自身は B の有無を内側から確かめられないので、これは**運用の gate**であり、`tools/remote-mcp.ts` の設定に有効化を書く行に、
受け入れの記録（日付・runner の結果の場所）をコメントで残すことを手順にする。

## 8. 表示と結果（FR-9〜12・FR-29・U-9）

**quote の応答（動的）**: 既存の欄に加えて、§2.4 の記録から組む。

```
upstream:    { url, method: "GET" }
destination: { ..., payTo, decimals }
pricing:     { upstreamAmount, converted, fee, total, sourceDecimals, destinationDecimals }
disclosures: {
  destinationVerifiedByOperator: false,
  refundOnFailure: false,
  fundsMoveOnCredential: <受信 offer の申告>,
  routerMayRejectAfterFundsMoved: ["expired", "upstream_changed", "dynamic_disabled", "budget_exhausted", "operator_funds_unavailable"],  // fundsMoveOnCredential のとき
  awaitingPaymentDoesNotMeanUnpaid: <fundsMoveOnCredential>,
  unsupportedResponseIsPaidWithoutData: true,
  supportedResponse: "application/json object, <= 256 KiB"
}
ownerKey
```

MCP の `subject` はこれらをそのまま含め、`nextStep` に同じ内容を文でも書く（FR-10）。

**結果（動的）**: MCP は上流の本文を `{ untrusted: true, source: "upstream", contentType, body }` に包み、
`proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" }` を添える。`contentType` は `application/json` に正規化した固定値だけを返す。
静的 route の結果の形は変えない。

**ログ**: 運用者向けの stderr に、動的 quote／purchase ごとに `profileId`・**ホスト名のみ**・結果コード・送信元を出す（パス・クエリ・`ownerKey` は出さない）。

## 9. 回帰と旧実装（FR-35）

- `dynamic.enabled: false` の Router（同じ実装）: §1 のとおり。journal の動的 intent は読め、予算は数え続け、`ownerKey` の検査は効く
- **この機能より前のイメージに戻した場合**: 動的 intent は設定に無い route として purchase できない。動的の `created` 行は静的予算に数えられない。
  **`ownerKey` の検査は無い**ので、`paymentId`（UUID）を知る相手は動的購入の結果を読める。要件が求めるのは「無効にした Router」での分離で、
  旧イメージへの巻き戻しは対象外とし §11 に記録する。巻き戻すときは控えの directory を残す

## 10. 実装の前に測るもの

| ID | 内容 | 方法 | 使い道 |
|---|---|---|---|
| M-1（**一部済**: pathUSD での観測と換算式。**仕様での上限の確立は未了**。§3.3 の T0-b） | MPP 送信の実手数料と、`gas × maxFeePerGas` から `feeAsset` の額への換算 | **既存の**送信 tx の receipt を読む（新しい支払いはしない） | `maxFee`・手数料規則、§3.3 |
| M-2（**済**。§3.3 の T0-a） | SDK が包んだ account の `signTransaction` と送金 RPC に渡す実物の形、chain の `feeToken` が入ること | fixture（署名のみ・送信しない）。足りなければ **testnet で 1 件の新しい支払い**（owner の了承済みの範囲: testnet・使い捨て口座） | §3.3 (ii)(iii) |
| M-3（**済**。§3.3 の T0-c） | 実 challenge の欄の一覧（Provider A・B と、公開されている第三者の x402／MPP エンドポイント数件） | 未払いの読取のみ | §3.3 (i) の許可キー |
| M-4 | 第三者 Provider での quote 成立率 | 未払いの読取のみ | §11 の互換性の制約が実用に耐えるか |

**順序は M-2 → M-1 → M-3**（M-4 はタスク分割を止めないが、第三者 Provider 対応を公表する前に必要）。
M-1 は receipt の標本だけでは上限の規則を証明できないので、Tempo の手数料の仕様と照らして換算と丸めを定める。
M-2 は SDK → 包んだ account → 固定の serializer → guarded RPC を**オフライン**で通し、正の対照と迂回の試み（生の署名、serializer の差し替え）を含める。
新しい testnet の支払いが要る場合は、その都度の範囲（件数・額・口座）を示してから行う。
結果で §3.3 の表が変わる場合は本書を改訂してから実装する。

## 11. 受容する制約（要件 §7 への追加）

| 制約 | 理由 |
|---|---|
| 昇格後に settle が拒否された試行は動的予算を保持する | §6.5 |
| 動的 quote は冪等に再取得できない。他人の `requestId` の先取りが可能 | §2.5 |
| 上流が `resource` を fetch URL と 1 バイトでも違う形で申告すると使えない。許可した説明用の欄以外を足す Provider も使えない | 束縛と署名範囲を緩めないため。T0-c の 6 件では `resource.url` は全件一致、offer の欄は 5 件が通る見込み。**動的 quote の成立率（M-4、未払い）も、支払っての成立も未計測** |
| testnet の間に動的 URL で買えると分かっているのは運用者の A・B だけ | T0-c で見た第三者 6 件はすべて mainnet の資産を要求した。testnet の第三者 Provider の有無は調べていない |
| MPP の第三者 Provider は既存の scope（`_mppx_scope`）を持たない | 動的経路では「あれば照合・無ければ不問」。保存した URL・guarded な TLS 接続・offer の照合が権威。静的は従来どおり必須 |
| facilitator・RPC を別名で指す URL は拒否できない | §7.4 |
| MPP 受信の束縛は SDK の 56 ビットの memo 要約に依る | SDK の仕様。衝突に依らない一意性は主張しない |
| 旧イメージへの巻き戻しで動的購入の結果が `paymentId` で読める | §9 |
| MPP 受信で昇格前に検証できなかった試行の証拠は、最初の credential の要約 1 行・7 日だけ（静的は journal に `unknown` が残る） | §6.3。**owner 承認済み（2026-10-05、保持は 7 日）。mainnet に進む段階で返金の設計と合わせて見直す** |
| `dialForTest` の試験が示すのは宛先の判定と HTTP の配線で、本番の経路や B の強制ではない | B は別の運用 gate（§7.5） |
| 静的 route の無効な purchase 試行は従来どおり journal に行を残す | 静的の記録順を変えない。入口の資源上限（§7.1）だけが掛かる |
| 昇格前に Router が落ちると、進行中だった試行は journal に残らない（控えの `attempt` だけ） | §6.3 |

## 12. 要件書に入れる改訂（本書と同じ commit）

| 箇所 | 改訂 | 理由 |
|---|---|---|
| FR-35 | 「FR-23 による予算の扱いの修正**と FR-31 の入口の資源上限**を除く」 | FR-31 は入口で本文を読む前に効くので、静的・動的を区別できない |
| FR-25・AC-13 | 「ホスト名で拒否する。**同じサーバを指す別の有効なホスト名は拒否できず、FR-30 のアドレス単位の上限で負荷を抑える**」 | §7.4 |
| FR-5 | 「journal に保存」→「**耐久性のある記録（控え）に保存し、購入を実行するときは journal の記録として実行する**」 | §6 |

owner の決定（D-1〜D-3）と他の FR は変えない。**3 点とも owner が承認した（2026-10-05）。** FR-25 は「名前で拒否＋頻度の上限」を選び、アドレスでの拒否は採らない。
2 回目のレビューの評価は次のとおり:
FR-5 は保存場所の明確化（ただし §6.3 の「7 日で消える証拠」まで承認するものではない。それは §11 の制約として別に確認する）。
**FR-25 と FR-35 は実質的な緩和**である。FR-25 は「宛先にできない」が「既知の名前は拒否し、別名は頻度で抑える」になる
（アドレスで拒否する方法もあるが、CDN を共有する無関係な Provider を巻き込むので選ばなかった、という選択）。
FR-35 は既存の呼び出しに 64 KiB・10 秒の上限が掛かる。正当な要求の大きさは実装時に測る
（動的の結果は最大 256 KiB なので、**結果を含む文書を purchase にそのまま送り返すクライアントは上限に当たる**。MCP が持ち回るのは quote 文書だけであることを試験で確かめる）。

## 13. 試験計画（AC との対応）

| AC | 層 | 要点 |
|---|---|---|
| 1・11・13 | unit | `parseUpstreamUrl`、無効時の拒否。**接続数 0** を fixture のカウンタで確かめる |
| 2 | wire | `dialForTest` つきの Router＋TLS の上流 fixture（x402・MPP）で両方向。**宛先の判定は本番と同じ** |
| 3・24 | unit／wire | 応答の全欄（FR-9・FR-10 の全項目）を記録と突き合わせる |
| 4・7・10・22 | unit | 改竄した quote 文書、`requestId` 衝突、設定変更、無効化、無効の Router での再生（予算・持ち主・実行不可） |
| 5 | wire | §4 の 3 形（x402 は「署名そのまま別 quote」「nonce 欄だけ書き換え」を **verify まで**。MPP は実 SDK＋実形の receipt）。同額・**異額**・静的↔動的・並行（A/A・A/B）・**journal 再オープン後**。送信の呼び出し回数。**正の対照**（正しい credential は通る） |
| 6 | wire | §3.2 の各欄を 1 つずつ変える。`id`／`expires` だけの変化では成立 |
| 8・9 | unit | offer の選択順、換算、手数料の丸め、桁あふれ |
| 12 | wire | 既存の T-A 系 fixture を動的の全接続点（quote 読取・再読取・有料要求・MPP 送信の RPC・受信の facilitator／RPC）に当てる。`dialForTest` つきでも loopback・内部解決は拒否。本番の入口が `dialForTest` を参照しない静的検査。`custom` transport の MPP 能力で動的プロファイルが起動失敗 |
| 14・15 | wire | リダイレクト、期限、ヘッダ・本文・個数の各上限（未払い／支払い後で終端が違うこと）、text／配列／偽 receipt、**本文より先に receipt を判定している**こと |
| 16 | unit＋wire | 範囲外の offer／challenge は候補にならない。**SDK を差し替えて範囲外の typed data／transaction を作らせ**、元の署名器の呼び出しが 0。`EIP712Domain` 型の差し替え、`feeToken` 未指定・別資産、call 2 つ、`keyAuthorization`、JSON-RPC account、`pull`、額 0 |
| 17 | unit＋wire | 門の各上限（頻度・同時実行、全体・送信元・ホスト名・アドレス）。別名 2 つ→同じアドレスで枠を共有。DNS の期限。入口の本文・受信時間。枠の返却（本文の読了・中断） |
| 18・19 | unit | 無効な credential の反復で両方の予算が減らない。**予算が尽きた後・verify 後の期限切れの反復で journal が 1 行も増えない**。`unknown` は枠を保持。動的側を使い切っても静的が成立 |
| 20 | unit＋wire | `quoteId`・`requestId`・`paymentId` を知っていても `ownerKey` 無しでは取得・購入・参照・終端状態の読取ができない。再起動後も。**`ownerKey` が journal・控え・ログ・エラー本文のどこにも出ない** |
| 21 | unit | 控えの上限、期限切れの除去、保持期間、起動時の読込量。昇格の各クラッシュ点（5 の前・5 の後・6 の途中）。MPP 受信で verify が不能だった試行の `attempt` が残り、期限内に再試行できる |
| 23 | 全体 | 既存テスト（skip と失敗を区別） |

fixture の試験は**守っているコードを外して落ちること**を確かめる。

## 14. 変更するファイル（見込み）

`src/config.ts`、`src/net/upstream-url.ts`（新規）、`src/net/guarded-fetch.ts`（`admit`／`release`・DNS の期限・`maxHeaderSize`・`dialForTest`）、
`src/ports/outbound.ts`、`src/adapters/outbound/{x402,mpp}.ts`、`src/adapters/inbound/x402.ts`、
`src/core/{orchestrator,store,intent,budget}.ts`、`src/core/quote-ledger.ts`（新規）、`src/core/dynamic-gate.ts`（新規）、
`src/http/{app,projection}.ts`、`src/client/*`、`src/mcp/{server,tools}.ts`、`src/main.ts`、`tools/remote-mcp.ts`、
`docs/DEPLOY.md`・`CLAUDE.md`・`README.md`。

## 15. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-05 | `gpt-6-astra`（read-only） | **REJECT**（重大 1・高 7・中 4） |
| 2 | 2026-10-05 | `gpt-6-astra`（read-only・範囲限定） | **APPROVE WITH CHANGES**（12 件中 8 件解消・4 件一部。再設計は不要、タスク分割に進める） |

2 回目の残り 4 点は本版に反映した（再々レビューはしない）: 予約済み `created` の再試行は全検査をやり直す（§6.2）、
署名の facade から生の署名と serializer の差し替えを除く（§3.3）、MPP の昇格前の不確かさは期限つきの証拠保持という取り引きであると明記（§6.3・§6.5・§11）、
資源上限の実装条件と RPC 要求数の主張の訂正（§7.3）。

| # | 指摘（第 1 版） | 反映 |
|---|---|---|
| 1 | MPP 受信の credential が quote に束縛されていない（封筒だけを照合）。**現行の本番にも当てはまる** | PR #7 で修正。§4 |
| 2 | MPP の検査が署名の後にある | 署名の境界に移した（包んだ local account）。§3.3 |
| 3 | `feeToken` 未指定を許すと手数料資産の保証が崩れる | 必須・一致に変更、chain 設定で固定、残高は資産別。§3.3・§6.6 |
| 4 | 昇格が予算の前で、未払いのまま journal が増え続ける | 予算と昇格を 1 行に統合。§6.2 |
| 5 | 「verify の前は何も書かない」が MPP の支払いの証拠と `unknown` の意味を失う | `attempt` 行・7 日保持・再試行可・開示。§6.1・§6.3・§8 |
| 6 | テスト用の loopback 例外は FR-24／AC-12 の弱体化。fixture の MPP 能力が guarded RPC を迂回する | 例外をやめ `dialForTest`（判定は本番と同じ）。`custom` transport は起動失敗。§3.1 |
| 7 | 未払いの仕事の上限が不足（同時実行・DNS・入口・purchase 全体） | §7.1〜7.3 |
| 8 | 別名は TLS で止まらない | 誤りを訂正し、限界として要件に追記。§7.4・§12 |
| 9 | EIP-712 の型定義を差し替えられる | typed data を Router が組み直す。§3.3 |
| 10 | 上限つき応答と SDK の読み順が合わない。配列の扱いが AC-15 と違う | receipt を先に自前で判定。object のみ。§3.4 |
| 11 | 記録に decimals・価格・プロファイルの写しが無い。開示が FR-10 (c) を満たさない。選択順・数値検査・B の gate | §2.3・§2.4・§6.6・§7.5・§8 |
| 12 | 「既存の配線は変更なし」が不正確 | §1.1 を書き直し |
