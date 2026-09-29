# 調査: x402 + Lightning Network への Router 対応可能性

> **状態: 調査メモ（設計判断ではない）。** 2026-09-30 作成。
> Block 社が x402 に Lightning 支払いを用意するという話について、
> 「Router 側で何が必要になるか」をコードから確定させた部分と、
> 外部情報に依存する部分を分けて記録する。

## 1. 結論（先に）

**アーキテクチャ上は適合する。ただし無条件ではない。**

- **受信（inbound）**: `InboundRail` の 4 メソッドは Lightning に**そのまま対応づけられる**。
  ただし**資金移動のタイミングの申告**に既存のハードコードがあり、そこは直す必要がある（§4.1）。
- **送信（outbound）**: `src/core/orchestrator.ts` の**送金直前ガードが Lightning を構造的に拒否する**（§4.2）。
  これは adapter の追加では解決せず、**core の変更が必要**。P5 設計の「core は触らない」方針と衝突する。

したがって「adapter を 1 本書けば済む」話ではない。**受信のみなら現実的、送信は core の設計変更を伴う。**

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

## 5. 未確認（外部情報に依存）

以下は本メモでは**確定させない**。Block 社の仕様が出るまで推測で設計しない
（U-01r で「未確定は未確定として残す」とした方針と同じ）。

- Block / Spiral / Proto の x402 Lightning 対応が**実在するか**、仕様・SDK の有無
- 402 応答に載るのが BOLT-11 / BOLT-12 / LNURL / Lightning Address のどれか
- **credential が何になるか**（preimage か、署名か、out-of-band 決済後の証明か）
- facilitator 相当の概念があるか（＝ Router が Lightning ノードを持つ必要があるか）
- **hold invoice が使えるか**——使えるなら「検証してから確定」が可能になり、
  x402 の EIP-3009 に近い「署名では動かない」モデルに寄せられる。
  使えないなら MPP と同じ「払った瞬間に不可逆」になる
- invoice の失効時間（一般に**分単位**で、オンチェーンの承認窓より短い）。
  `maxTimeoutSeconds` や `approvalTtlMs`（既定 60s）との整合を確認する必要がある
- 失敗・スタックした HTLC の扱い、返金可能性
- payment hash で**後から結果を照会できるか**——できるなら
  U-01r-a（§10）で「SubEtha には無い」と結論した**結果照会 API が Lightning には存在する**ことになり、
  `unknown` からの回復が**Lightning では安全に実装できる**可能性がある。これは重要な差

## 6. 見積り（暫定）

| 作業 | 規模 | 備考 |
|---|---|---|
| `src/adapters/inbound/lightning.ts` | 中 | 既存 3 本の adapter と同形 |
| 資金移動タイミングの脱ハードコード（§4.1） | **小** | Lightning 抜きでも直す価値がある |
| `source.payTo` の書式制約緩和（`config.ts:253`） | 小 | rail ごとに条件を分ける |
| 送信側の照合委譲（§4.2） | **大** | **core の interface 変更**。独立レビュー必須 |
| 合成 fixture + wire テスト | 中 | ノード不要の形にする |

**受信のみ**なら既存パターンの延長で収まる。**送信を含める**なら core の設計変更になる。

## 7. 本メモで決めていないこと

実装の着手、スキーム名・network 表記の確定、Lightning ノード運用の方針。
いずれも §5 が埋まってからでないと、推測で作ることになる。
