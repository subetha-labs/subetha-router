# 調査: 宛先認可のモデル選択（(a) 運用者委譲 vs (b) 購入ごと承認）

> 2026-09-30。`docs/destination-authz-requirements.md` §8.4 が「受取先の認可方式を明示的に選べ」と
> 要求したことへの回答。外部調査（一次資料）＋リポジトリ内の実測。

## 1. 結論

**(b) を既定とする。ただし「表示」ではなく「束縛」として実装する。**

判断基準は次の 1 点に集約される:

> **運用者が、その Provider の正しい `payTo` を**事前に・帯域外で**知っているか。**

| 条件 | 採るべき形 | 実行時の人間承認 |
|---|---|---|
| **知っている** | 設定で `payTo` を固定（**現状の実装**） | **不要** |
| **知らない**（AI が新規 Provider を指名） | **quote された受取先を人間が 1 回承認**し、暗号的に束縛 | 初回のみ |

**オリジン allowlist は、どちらの代替にもならない。**

## 2. これは confused deputy 問題である（名前の付いた脅威）

Hardy, *The Confused Deputy*, ACM SIGOPS OSR 22(4), Oct 1988:

> The fundamental problem is that the compiler runs with authority stemming from **two sources**.

Miller, Yee & Shapiro, *Capability Myths Demolished* (2003) が
**Property A: No Designation Without Authority** として定式化:

> an authorization given by one party is used to access a resource designated by a **different party**...
> In a system where designation and authority are inseparable, this common type of confused deputy
> problem... **simply cannot occur**.

Router の構造がこれに一致する:

| 要素 | 出所 |
|---|---|
| **何を払うか**（designation） | AI が指定した URL → 上流の 402 |
| **払う権限**（authority） | 人間の承認 |

**2 つが別経路であることが問題**であり、人間の有無は本質ではない。
同論文の判定: **"Confused Deputy (hopeless without D, best if A)"**。
**オリジン allowlist はどちらの性質も与えず、権限を曖昧に広げるだけ**である。

## 3. x402 自身には payee 認可の規範が無い（重要な negative）

| 観測 | 所在 |
|---|---|
| 仕様 §10 Security Considerations は **replay 対策と認証統合の 2 項目のみ** | `specs/x402-specification-v2.md`（v2.0, 2025-12-09） |
| 参照クライアントの `SpendControls` は `maxAmountPerPayment` と `allowedAssets` **のみ**。`payTo` は **0 回** | `typescript/packages/core/src/client/x402Client.ts` |
| 対話的承認は「**大きな金額**」の用途として提示（新規 payee ではない） | `docs/advanced-concepts/lifecycle-hooks.mdx:228` |
| MCP チャットボット例のプロンプトは `Pay ${amount}?` — **payee を見せない** | 同 |
| **`dynamicPayTo` は正式機能**（「マーケットプレイスで売り手ごとに別アドレス」） | `examples/go/servers/advanced/dynamic-pay-to.go` |
| Bazaar 探索に**審査が無い**。`payTo` は検索フィルタであって信頼signal ではない | `specs/extensions/bazaar.md:429`, §8.1 |

**§8.4 で私が「パスによって別テナント」を懸念したのは、エッジケースではなく x402 の設計機能だった。**

**暗号は受取先を固定している**（EIP-3009 の `TransferWithAuthorization(from, to, ...)` が `to` を署名対象に含む）。
**問題は「誰がその住所を payer に教えたか」**である。
なお **EIP-2612 `permit` は受取先を固定しない**（allowance を与え、宛先は後から spender が決める）。
**permit 形の権限をここに持ち込んではならない。**

## 4. 規制は payee の新規性で摩擦を課す（金額ではない）

**EU 2018/389（SCA 委任規則）**:

| 条 | 内容 |
|---|---|
| **Art. 5**（dynamic linking） | 認証コードは「金額**および payee**」に固有。**payee の変更は認証コードを無効化する** |
| **Art. 13**（信頼済み受取人） | リストの**作成または変更**時に SCA **必須**。以降は免除可 |
| **Art. 14**（継続支払い） | **金額と payee の両方**を固定 |
| **Art. 16**（少額） | 金額のみ制限、**payee は無制約** |

**Art. 13 と Art. 16 が設計空間の両極**であり、同一規則に共存する。
**(a) はどちらでもない**——金額を制限しつつ**第三者に payee を選ばせる**。

**UK PSR SD17 ¶3.4**: Confirmation of Payee は顧客が「**新しい payee** の情報を提供したとき」に必須。
**トリガーに金額は登場しない。**

**Art. 13 は本プロジェクトの hybrid（TOFU）案の法的前例**である。ただし 2 つの規則を継承する:
1. **「creates *or amends*」** — 変更も作成と同じ権限。**AI が信頼エントリを追加・変更できてはならない**
2. リストは**payer 自身が**自分の銀行を通じて作る。**仲介者が自分の allowlist を埋めてはならない**

## 5. 同じ Coinbase が正解を実装している

| 実装 | 構造 |
|---|---|
| `coinbase/spend-permissions` | `SpendPermission` に **recipient が無い**（= (a) の弱点そのもの）。対策が `SpendRouter.sol` で、`extraData` から `(executor, recipient)` を復号し、**`keccak256(extraData)` が署名 typehash に入る** |
| **`base/commerce-payments`** | `PaymentInfo` が **`operator`（フロー駆動）と `receiver`（受取先）を別の署名対象フィールド**として持つ |

**後者が求めていた構造**: **Router はフローを駆動しつつ、payee を選べない。**

**RFC 9396**（Rich Authorization Requests, 2023-05）の動機付け例が文字どおりこの問題:
「please let me transfer an amount of 45 Euros to **Merchant A**」、`creditorAccount`/`iban` を含む。

## 6. 既存実装の調査（(a) が業界標準という前回の私の報告は不正確だった）

| システム | 受取先の固定 | 実行時の人間承認 |
|---|---|---|
| **Stripe/OpenAI ACP** | **必須**（`Allowance.merchant_id`、`reason` は `one_time` のみ） | **あり** |
| **`base/commerce-payments`** | **あり**（`receiver` が署名対象） | 支払いごとの事前承認 |
| Coinbase spend-permissions | **無し**（spender を固定） | 事前に 1 回 |
| Coinbase AgentKit | **無し**（上限も allowlist も無い） | **無し** |
| x402 | 暗号的には固定だが**サーバが選ぶ** | 不要 |
| Skyfire | mint 時に束縛（`aud`/`ssi`）だが**参照実装は audience 検査をコメントアウト** | 無し |
| Nevermined | **fail open**（"Omit for no recipient restriction"） | 無し |

**訂正**: 私は先に「(a) は業界標準」と報告したが、**調査対象が依頼と異なる 3 社に偏っていた**。
受取先を固定する実装（Stripe ACP、base/commerce-payments）も存在し、
**規制と学術文献は (b) を支持する。**

**UK Open Banking VRP は直感と逆**: `MaximumIndividualAmount` は必須かつ銀行が強制するが、
`Initiation.CreditorAccount` は**任意**で TPP の自己申告。
→ **受取先をサーバ側で固定すれば、英国の本番標準より強くなる。**

## 7. MPP の非対称性が決定的

`subject.fundsMoveOnCredential` が true のレール（MPP / SubEtha self-transfer）では
**`sign` の時点で資金が動き、取り消せない**。

→ **(a) を MPP レールに適用すると、allowlist に載ったオリジンが
「人間が宛先を一度も見ないまま」不可逆に資金を取れる。**
CSA の confused-deputy 指針（2026-03）は、不可逆な行為に明示的な人間確認を推奨している。
**MPP レールでの (a) は除外する。**

## 8. リポジトリは既に正しい形を持っていた（実測）

既存ツールは**事前宣言した scope と一致しなければ支払いを拒否**する:

```ts
// tools/t7-settle-provider-a.ts:64
if (offer.payTo.toLowerCase() !== SCOPE.payTo.toLowerCase()) fail(`payTo out of scope`);
// tools/mpp-payer.ts:85
if (offer.payTo.toLowerCase() !== scope.payTo.toLowerCase()) throw new Error(`refusing to pay ${offer.payTo}`);
```

`src/config.ts:21-25` の型名も **`DestinationAllow`** で `payTo` を含む。
**オリジン allowlist への置換は「認可の追加」ではなく「既存の受取先制約の除去」**である。
→ **一般化すべきであり、除去すべきではない。**

## 9. 主張を過大にしない（重要な限界）

**UK Finance Annual Fraud Report 2026**（2025 年データ）の分類:

| 種別 | 定義 | 2025 年 |
|---|---|---|
| **Malicious Redirection** | 正当な payee に払う意図が、詐欺により第三者へ | 損失の 1/4 未満に低下（2020 は半分超） |
| **Malicious Payee** | **正しく識別された payee** が、財・サービスを提供せず持ち逃げ | **+35%、£437m**（記録的高水準） |

APP 詐欺の総損失 **£576.4m（+19%）**。

**受取先の固定は redirection を防ぐが、payee の誠実性はほぼ防がない。**
「allowlist に載った正当なオリジンが無価値なデータを返す」は **malicious payee** であり、
**escrow / 紛争処理 / レピュテーションが必要**——本スライスの範囲外。
**受容するリスクとして明記する。**

## 10. 前例が存在しない領域（新規性を主張できる箇所）

> **受取先の信頼を失効・撤回する標準が存在しない。**
> Art. 13 は期限・再検証・侵害時の扱いに**沈黙**しており、SSH `known_hosts` にも撤回が無い。

TOFU を実装するなら**ここは設計する必要があり、かつ主張できる新規性**である。
RFC 4251 §4.1 が TOFU の既知の失敗を記録している:

> Implementations **SHOULD NOT** normally allow such connections by default.

加えて **USENIX Security 2025「Blockchain Address Poisoning」**（270M 試行、17M 対象、**≥$83.8M 損失**）は
「利用者は最近の取引履歴からアドレスを選ぶ」ことを根本原因とし、
**人間に 40 桁の hex を目視させるのは弱い対策**だと示す。
→ **承認画面には Provider の識別情報とオリジンを出す。hex だけを出さない。**

## 10.1 追加で確定した設計制約（最終報告より）

1. **`transferWithAuthorization` を使い、`permit` を使わない。**
   EIP-3009 は `to` を署名対象に含むが、EIP-2612 `permit` は **allowance を与えるだけ**で
   宛先は後から spender が決める。**permit 形は ambient authority を再導入する。**
2. **`base/commerce-payments` に倣い、`operator` と `receiver` を分離する。**
   両方を署名対象にすれば、**Router はフローを駆動しつつ payee を選べない**。
   これが Property A を満たし、confused deputy を構造的に解消する。
3. **FR-9 の不変記述子は `(payTo, resource, amount, rail)` をハッシュし、
   それだけが実行可能**であること。既存の `tools/mpp-payer.ts:85` の scope 検査が既にこの形。

### 出典の訂正

- 論文は Miller / Yee / **Shapiro**（Close / Miller / Wagner ではない）
- AP2 の現行語彙は **Checkout / Payment Mandate**（Intent / Cart Mandate は v0.1 の旧称）

## 11. 要件への反映（次フェーズ）

1. **FR-3 を (b) に確定**: 承認 subject に**オリジンと `payTo`**を含め、
   **実際に実行される不変記述子に束縛**する（表示だけでは OBIE VRP の弱点と同じ）
2. **オリジン allowlist は SSRF とブラスト半径の制御に限定**し、**受取先の認可には使わない**
3. **TOFU は Art. 13 を前例として正当**だが、「creates **or amends**」を境界とし、
   **AI が信頼エントリを変更できない**こと。**失効・再検証は自前設計**
4. **MPP レールでの (a) は除外**（§7）
5. **malicious payee リスクを受容として明記**（§9）
