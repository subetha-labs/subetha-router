# 調査: x402 + Lightning Network への Router 対応可能性

> **状態: 調査メモ（設計判断ではない）。** 2026-09-30 作成。
> Block 社が x402 に Lightning 支払いを用意するという話について、
> 「Router 側で何が必要になるか」をコードから確定させた部分と、
> 外部情報に依存する部分を分けて記録する。

## 1. 結論（先に）

**対応可能。ただし最大の障害は Router 側ではなく「参照実装がまだ無い」こと。**

仕様は **2026-09-23 にマージ済み**（`scheme_exact_lnbtc.md`、Block の Bitcoin 部門 Spiral の
エンジニアが著者）。私が直接取得して内容を確認した（§5.1）。

Router 側の適合性:

- **受信（inbound）**: `InboundRail` の 4 メソッドに**そのまま対応づく**。
  資金移動タイミングの申告にハードコードがあり、そこは直す必要がある（§4.1）
- **送信（outbound）**: `src/core/orchestrator.ts` の送金直前ガードが**現状は Lightning を拒否する**（§4.2）。
  ただし**仕様側は「同等なら通す」設計**であり（§5.2）、修正は core の設計意図と一致する
- **Lightning は U-01r で諦めた「結果照会」を持つ**（§5.3）。
  `network:payment_hash` で確定的に再照会でき、**応答喪失からの回復が安全に実装できる**。
  SubEtha・MPP の両レールに無い利点

**推奨: 今は実装しない。仕様の理解として記録し、参照実装の出現を待つ。**
理由は §6.2。

## 2. Router 側の前提（コードで確認済み）

| 事実 | 確認方法 |
|---|---|
| **core は rail 名で分岐しない** | `grep -rE '"x402"\|"mpp"\|"subetha"' src/core/*.ts` → **0 件** |
| 金額は `BigInt` の base-unit 文字列 | `src/core/budget.ts:37,86`。18 decimals を前提にしていない |
| `destination.payTo` は**書式自由**（`requireString` のみ） | `src/config.ts:278` |
| `source.payTo` は **`0x` 40 hex 必須** | `src/config.ts:253` |
| EVM 依存は x402 adapter 内に閉じている | `src/adapters/outbound/x402.ts` に viem/eip155 参照 9 件 |

前 2 つは Lightning に**有利**（msat は単に別の base unit であり、`decimals` を持つ既存の仕組みに乗る）。

## 3. Lightning を `InboundRail` に対応づける

| ポート | Lightning での相当 | 難易度 |
|---|---|---|
| `createOffer` | BOLT-11 invoice（または BOLT-12 offer）を発行する | 低 |
| `preflight` | payment hash と失効の突合（**同期・無課金**である必要） | 低 |
| `verify` | invoice が未払いか、期限内かの確認 | 低 |
| `settle` | preimage の検証、または hold invoice の settle | 中 |

`InboundOffer.extra` は `Record<string, unknown>` なので、`paymentHash` / `bolt11` /
`expiresAt` を載せられる。**`challengeNonce` に payment hash を入れるのが自然**
（SubEtha が `challengeNonce` を idempotency key に使っているのと同じ構造）。

`asset` / `network` の表現は決める必要がある（例: `network: "lightning:bitcoin"`,
`asset: "msat"`）。CAIP-2 に Lightning の標準表現があるかは**未確認**。

## 4. 実際に直さないといけない箇所（コードで特定済み）

### 4.1 受信: 資金移動タイミングの申告がハードコード

> **解決済み（2026-09-30）**: 本節が指摘したハードコードは
> `docs/fundsmove-requirements.md` のスライスで**修正された**。
> 現在は各 adapter が `extra.fundsMoveOnCredential` を申告し、MCP 層は読むだけである。
> Lightning adapter を書く場合は **`true` を申告する**だけでよく、
> 本節の「対処」は不要。以下は当時の記録として残す。

`src/mcp/tools.ts:95-99`:

```ts
function fundsMoveBeforePurchase(quote: QuoteView): boolean {
  const offer = (quote.source as Record<string, unknown>)["offer"];
  return isRecord(offer) && offer["scheme"] === "tempo/charge";   // ← 単一スキーム名の直書き
}
```

Lightning は **invoice を払った瞬間に資金が出ていく**（MPP と同じ側）。
しかしこの関数は `"tempo/charge"` しか見ないので、Lightning route では
**`fundsMoveOnCredential: false` を返す**——つまり
**「まだ支払われていない」と人間に伝えてしまう**。これは誤った承認を招く。

`src/mcp/server.ts:167-169` の説明文も `"(the MPP rail)"` と直書きしている。

**対処**: 資金移動タイミングを**スキーム名の判定ではなく offer 自身の属性**にする
（例: adapter が `extra.fundsMoveOnCredential` を申告し、core/MCP はそれを読むだけにする）。
これは Lightning 抜きでも**設計上正しい方向**であり、レール追加のたびに
この関数を編集する必要がなくなる。

### 4.2 送信: 送金直前の再照合が Lightning を構造的に拒否する

`src/core/orchestrator.ts:669-673`:

```ts
async function readAndMatchDestination(intent: Intent): Promise<boolean> {
  const offers = await options.outbound.readChallenge(intent.routeId);
  const target = stableJson(intent.destination.selectedOffer);
  return offers.some((offer) => stableJson(offer) === target);   // ← バイト一致を要求
}
```

これは「承認後に上流の条件が変わっていたら払わない」ための**正しいガード**であり、
`:428` と `:572`（送金直前と settle 直前）の 2 箇所で使われ、
不一致なら**どちらのレグも開始しない**（`:440` 以降）。

**問題**: Lightning の invoice は**毎回 payment hash が異なる**。
上流を読み直せば必ず別の invoice が返るので、`stableJson` の一致は**原理的に成立しない**。
つまり **Lightning 送信はこのガードで 100% 拒否される**。

**対処には core の変更が必要**。方向性は 2 つある:

1. **照合の粒度を adapter に委ねる**——`OutboundRail` に
   「この offer は承認時と同等か」を判定するメソッドを追加し、
   x402 は現在のバイト一致、Lightning は「金額・宛先・期限が同等か」を実装する。
   core は判定を**委譲するだけ**になり、rail 非依存性は保たれる。
2. **invoice を再読み込みしない**——承認済み invoice をそのまま使い、
   期限内であることだけを確認する。ただし「承認後に条件が変わっていない」保証が弱くなる。

**1 を推す。** core が `stableJson` の一致を直接要求している現状は、
「core は rail を知らない」という設計意図に対して**実は特定レールの前提を埋め込んでいる**。
Lightning はその前提を可視化しただけであり、修正は設計の一貫性を高める。

## 5. 仕様は実在し、マージ済み（一次資料で確認）

### 5.1 確認した一次資料

| 対象 | 内容 |
|---|---|
| Block の発表 | `block.xyz/inside/block-joins-the-x402-foundation-to-advance-open-agentic-commerce`（2026-09-24）。「Block has contributed Bitcoin Lightning payments to the x402 protocol」 |
| **仕様（本体）** | `specs/schemes/exact/scheme_exact_lnbtc.md`（PR #2861、**2026-09-23 マージ**）。著者 `benthecarman`（GitHub の company が `@spiralxyz`＝Block の Bitcoin 部門 Spiral） |

**私が直接取得して確認した**（`raw.githubusercontent.com` から 42,076 バイト、HTTP 200）。
以下の引用は**すべて実ファイルの行番号付きで確認済み**であり、伝聞ではない。

### 5.2 §4.1 の予想は当たり、しかし §4.2 の予想は**外れていた**

**資金移動タイミング（`lnbtc.md:602`）**:

> Settlement does not move funds. The Lightning payment completed before the client
> received the preimage.

**予想どおり MPP 側**である。credential（preimage）が存在する時点で**既に不可逆に支払われている**。
`/verify` は**呼ばれない**（`:61` "It MUST NOT call `/verify` for this flow"、`:545`）。
返金は**無い**（`:114-115` "provides no refund path … MUST NOT assume a refund is available"）。

**しかし結果照会について、私の §4.2 の懸念は Lightning には当てはまらない（`lnbtc.md:212`）**:

> An unused proof MUST be accepted for another challenge with the same request
> binding and payment terms if all validation rules pass.

つまり **未使用の preimage は「別の challenge」に対して再提示できる**。
`extra.invoice` は *dynamic* フィールドとされ、サーバは challenge ごとの payment hash を
追跡する必要すらない。**invoice が毎回変わることは問題にならない**——
照合対象は invoice の同一性ではなく **request binding と支払い条件**である。

これは §4.2 で「Lightning 送信は `stableJson` 一致で 100% 拒否される」と書いた見立てを
**部分的に覆す**。拒否されるのは事実だが、原因は Lightning の欠陥ではなく
**core が「同等性」ではなく「同一性」を要求していること**であり、
仕様側は最初から「同等なら通す」設計になっている。§4.2 の対処案 1（照合を adapter に委譲）が
**仕様の意図と一致する**ことが裏付けられた。

### 5.3 U-01r で「無い」と結論した結果照会が、Lightning には**ある**

replay 保護キーは **`network + ":" + payment_hash`**（`:604`）で、
**restart-durable な store への atomic insert が必須**（`:616`、
`:739` "An in-memory replay store is not compliant because a restart loses consumed keys"）。
重複は `duplicate_settlement` になる。

したがって**応答を失っても、同じ preimage を再提示すれば
「リソースが返る」か「`duplicate_settlement`」のどちらかが確定的に得られる**。
U-01r-a（§10）で SubEtha について「nonce 単位の結果参照が無いので `unknown` から回復できない」と
結論したが、**Lightning では回復が安全に実装できる**。レール間で最も大きな差である。

### 5.4 その他の確定事項

| 項目 | 内容 |
|---|---|
| 402 に載るもの | **BOLT-11 invoice のみ**（`extra.invoice`）。BOLT-12 / LNURL / Lightning Address は**対象外**（将来課題としても言及なし） |
| credential | `payload.preimage`（32 バイト）。**bearer proof**。preimage を返せない payer adapter は使用禁止 |
| 単位 | **millisatoshi** の 10 進文字列。`"1000"` = 1 sat。`"21"` を sat と解釈するのは禁止 |
| 手数料 | **payer が routing fee を上乗せ負担**（amount には含まれない） |
| network | 新 CAIP-2 namespace `lnbtc:`（mainnet `lnbtc:000000000019d6689c085ae165831e93`） |
| `payTo` | 受信ノードの**圧縮 secp256k1 pubkey**（66 hex）。`0x` アドレスではない → §4 の `config.ts:253` 制約に該当 |
| 失効 | **`maxTimeoutSeconds` は BOLT11 expiry と完全一致必須**（余裕なし）。仕様の test vector は **300 秒**。clock skew 既定 60 秒 |
| request binding | BOLT11 の `description_hash` に `SHA-256(JCS(binding))` を埋める。**`mcp:1` プロファイルは MCP `tools/call` 用**で、JSON-RPC `id` と `progressToken` を binding から除外（＝再試行が安全） |
| facilitator | **Lightning ノード不要**。検証は完全にローカル（BOLT11 デコード + `SHA-256`）。ただし**共有・永続・atomic な replay store が必須**（EVM facilitator より stateful） |
| 受信側の制約 | **受信ノードの invoice 発行権限を排他的に持つ必要がある**。マルチテナント custodial ノードは**非対応**（他テナントが自分で払った preimage を流用できるため） |

### 5.5 最大の実務的障害: **参照実装がまだ無い**

サブエージェントの調査によると、x402 リポジトリに含まれる lnbtc 関連ファイルは
**この仕様 markdown 1 本だけ**で、TypeScript / Python / Go の実装コードは**マージされていない**。
実装 PR は #1873（Python、open）、#2262（TypeScript、**旧 `bip122` 設計**が対象で古い）が未マージ。

**この点は私自身では未検証**（GitHub の code search API が認証を要求したため）。
ただし仕様ディレクトリの一覧は取得でき、`scheme_exact_lnbtc.md` の存在は確認した。

したがって Block の発表にある「try the Lightning implementation」は、
**現時点で公式リポジトリからは満たせない**可能性が高い。採用するなら
**我々が最初の実装者になる**。これは §6 の見積りを大きく変える。

## 6. 見積りと推奨

### 6.1 作業規模

| 作業 | 規模 | 備考 |
|---|---|---|
| `src/adapters/inbound/lightning.ts` | 中 | 既存 3 本と同形。BOLT11 デコード + `SHA-256` 検証 |
| 資金移動タイミングの脱ハードコード（§4.1） | **小** | **Lightning 抜きでも直す価値がある**（今の実装は誤った承認を招く） |
| `source.payTo` の書式制約緩和（`config.ts:253`） | 小 | Lightning の `payTo` は secp256k1 pubkey で `0x` ではない |
| 送信側の照合を adapter に委譲（§4.2） | **大** | **core の interface 変更**。独立レビュー必須 |
| **restart-durable な replay store** | 中 | 仕様が**必須**とする（in-memory は非準拠）。既存 journal と統合できる可能性 |
| BOLT11 のパーサ/検証 | 中〜大 | 自前実装は避けたい。ライブラリ選定が必要 |
| 合成 fixture + wire テスト | 中 | ノード不要で組める（facilitator 検証がローカルなので有利） |

### 6.2 なぜ「今は実装しない」を推すか

1. **参照実装が無い**（§5.5）。最初の実装者になると、
   仕様解釈の誤りを自分で発見しなければならない。U-01r で経験した通り、
   **実物と合成 fixture の差は独立レビューでしか見つからない**ことがある
2. **受信側の排他的 invoice 発行権限**（§5.4）が運用要件として重い。
   Lightning ノードの運用か、テナント分離を保証する custodial 事業者の選定が必要
3. **仕様がまだ動く可能性**。preimage を返せない payer 向けの
   `invoice` asset transfer method（PR #3571/#3572）が議論中で、
   これが入ると payer 側の前提が変わる
4. **Router の現在の価値は cross-rail であり、レール数ではない**。
   SubEtha ⇄ x402 ⇄ MPP が実決済で動いた直後に 4 本目を足すより、
   既存の穴（同一レール行列の未検証、§P5）を埋める方が実証価値が高い

### 6.3 ただし今やる価値がある 1 件

**§4.1 の脱ハードコード**は Lightning とは独立に直すべきである。
`fundsMoveBeforePurchase` が `"tempo/charge"` だけを見ている現状は、
**レールを足すたびに人間への警告が静かに壊れる**構造になっている。
Lightning はその脆さを可視化した。

## 7. 本メモで決めていないこと

実装の着手、スキーム名・network 表記の確定、Lightning ノード運用の方針。
いずれも §5 が埋まってからでないと、推測で作ることになる。
