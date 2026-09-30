# 要件: 資金移動タイミングの申告を脱ハードコードする

> 2026-09-30。対象は `src/mcp/tools.ts:95-99` の `fundsMoveBeforePurchase`。
> Lightning 調査（`docs/lightning-feasibility.md` §4.1）で可視化された既存の欠陥であり、
> **Lightning を実装するかどうかとは独立に直す**。

## 1. 現状と欠陥

Router は quote 応答に `subject.fundsMoveOnCredential` を載せ、
エージェントに**人間の承認をいつ取るか**を機械可読に伝えている（`src/mcp/tools.ts:132`）。
説明文ではなく構造化データにしたのは、ツール説明が読み飛ばされるため。

その値を決めているのは:

```ts
function fundsMoveBeforePurchase(quote: QuoteView): boolean {
  const offer = (quote.source as Record<string, unknown>)["offer"];
  return isRecord(offer) && offer["scheme"] === "tempo/charge";   // ← 単一スキーム名の直書き
}
```

**欠陥**: 判定が**スキーム名の文字列一致**である。したがって

- 新しい受信レールが「credential 生成＝支出」型であっても、
  この関数を**編集し忘れると `false` を返す**
- `false` は「まだ払っていない」を意味するので、
  エージェントは**承認を後回しにしてよい**と判断する
- 実際には credential 生成の瞬間に支出しているため、
  **人間が承認する前に不可逆に資金が出る**

エラーも警告も出ない。**静かに壊れる安全機構**である。

`src/mcp/server.ts:167-169` のツール説明文にも `"(the MPP rail)"` が直書きされており、
同じ問題を持つ（レールが増えると説明が事実と食い違う）。

### 1.1 設計原則との不整合

本プロジェクトは「**core はレール名で分岐しない**」を原則とし、
`grep -rE '"x402"|"mpp"|"subetha"' src/core/*.ts` は **0 件**である。
しかし `src/mcp/tools.ts` は分岐している。**原則が守られていない箇所が安全機構に残っていた。**

## 2. 各レールの真の値（ソースで確認）

| 受信レール | scheme | 資金移動 | 根拠 |
|---|---|---|---|
| x402 | `exact` | **settle 時**（credential は署名のみ） | `src/adapters/inbound/x402.ts:1-3`（EIP-3009、facilitator が settle） |
| SubEtha | `subetha-zerc20` | **settle 時**（payer が burn を broadcast 済みだが、Router から見た課金確定は settle） | `docs/u01r-requirements.md` §25.3 |
| MPP | `tempo/charge` | **credential 生成時**（不可逆） | `src/adapters/inbound/mpp.ts`、既存の `true` 判定 |
| （将来）Lightning | `exact` / `lnbtc` | **credential 生成時**（不可逆） | `scheme_exact_lnbtc.md:602` |

**注意**: SubEtha は payer が自分で burn を broadcast するため、
「payer の資金は credential 生成前に動いている」とも言える。
しかし `fundsMoveOnCredential` の目的は
**「Router に credential を渡す操作が不可逆な支出を引き起こすか」**であり、
SubEtha では burn は**それより前に payer 自身の判断で**行われている。
現状の実装が SubEtha を `false` としている扱いは**変えない**（互換性）。

## 3. 要件

- **FR-1 申告は offer 側が持つ**: 資金移動タイミングは adapter が
  `InboundOffer.extra.fundsMoveOnCredential`（boolean）として申告する。
  MCP 層はそれを**読むだけ**で、スキーム名を判定しない。
- **FR-2 fail safe**: 申告が**欠落**している offer は
  **`true`（危険側＝先に承認が必要）として扱う**。
  「申告を忘れたら安全側に倒れる」のではなく、**危険側に倒す**。
  理由: 誤って `false` を報告する被害（承認前の不可逆支出）は、
  誤って `true` を報告する被害（余分に早く承認を求める）より**はるかに大きい**。
- **FR-3 既存 3 レールの値を変えない**: x402 / SubEtha は `false`、MPP は `true`。
  既に稼働している chat 契約・MCP 利用側の挙動を変えない。
- **FR-4 core を触らない**: 変更は adapter（`extra` に 1 フィールド追加）と
  MCP 層（判定の置換）に限る。`src/core/*` と `src/ports/inbound.ts` の
  既存フィールドは変更しない。
- **FR-5 説明文もレール名を持たない**: `src/mcp/server.ts` のツール説明から
  `"(the MPP rail)"` のような特定レール名を除き、
  **フラグの意味だけ**を説明する。
- **FR-6 型で強制しない**: `extra` は `Record<string, unknown>` の交差型であり、
  `fundsMoveOnCredential` を**必須フィールドにはしない**。
  必須にすると `ports/inbound.ts` の変更＝全 adapter の同時変更になり、FR-4 に反する。
  代わりに FR-2 の fail safe で守る。

## 4. やらないこと

- Lightning adapter の実装（`docs/lightning-feasibility.md` §6.2 で「今はしない」と判断）
- `InboundOffer` の必須フィールド追加（FR-6）
- 送信側（`OutboundRail`）の照合委譲（`lightning-feasibility.md` §4.2。**別スライス**）
- SubEtha の `false` 判定の再検討（§2 の注意。互換性のため現状維持）

## 5. 受け入れ条件

| ID | 条件 | 検証 |
|---|---|---|
| AC-1 | MPP route の quote が `fundsMoveOnCredential: true` を返す | wire テスト（既存の挙動維持） |
| AC-2 | x402 / SubEtha route の quote が `false` を返す | wire テスト（既存の挙動維持） |
| AC-3 | **`extra.fundsMoveOnCredential` を持たない offer は `true` になる** | unit テスト（FR-2 の fail safe） |
| AC-4 | **`src/mcp/tools.ts` にレール名の文字列が残っていない** | grep による検査をテストに含める |
| AC-5 | ツール説明文に特定レール名が含まれない | 同上 |
| AC-6 | 全既存テストが通る | `npm test` |

AC-4 / AC-5 を**テストとして**書くのは、将来レールを足す人が
再びハードコードを持ち込むのを防ぐため（回帰検出）。

## 6. 検証方法

- `npm test` を実際に実行する（docs の整合確認はテストではない）
- **sabotage 検証**: fail safe（FR-2）を壊して AC-3 が落ちることを確認する。
  具体的には既定値を `false` に変えて、テストが失敗することを見る

## 7. 自己検証で見つかった FR-2 の問題（未解決・レビュー対象）

要件を書いた後にテストを読んで判明した。**FR-2 をそのまま実装すると既存テストが落ちる。**

`tests/unit/approval-funds-timing.test.ts` は offer を
**`extra: { challengeNonce: "n1" }` だけ**で組み立てる（同 :34）。
`fundsMoveOnCredential` は入っていない。

したがって FR-2（申告が無ければ `true`）を実装すると:

- `:64` の「x402 は `false`」を期待するテストが **`true` を受け取って失敗する**
- 同テストは `nextStep` 文面に "cannot be undone" が**出ないこと**も検証している（`:67`）。
  フラグは文面も切り替える（`src/mcp/tools.ts:199`）ので、こちらも壊れる

### 選択肢

1. **テストの fixture を更新する**（offer に明示的な申告を足す）。
   FR-2 の fail safe は保つ。ただし「既存テストを修正して通す」形になるため、
   **本当に安全側かを吟味する必要がある**（テストを実装に合わせるのは危険な癖）
2. **FR-2 を撤回し、既定を `false` にする**。既存の挙動と完全互換。
   ただし「申告を忘れたレールが静かに `false` になる」という
   **元の欠陥をそのまま残す**——今回の修正の目的に反する
3. **申告の欠落を起動時に拒否する**（fail closed）。
   adapter が申告しなければ Router が起動しない。
   最も強いが、`extra` は `Record<string, unknown>` なので
   **quote 時点まで検出できない**（起動時に offer は存在しない）

**現時点の見解は 1 だが、確信がない。** テストを書き換えて通すのは、
守っている性質を弱めていないかの吟味が必要であり、独立レビューに判断を仰ぐ。

## 8. 独立レビュー結果: **REJECT** — 要件を改訂する

レビュー実施: 2026-09-30、Codex CLI 0.157.1、`gpt-6-astra`、`--sandbox read-only`。
**§2 の SubEtha=`false` 判断が誤りだった。** 指摘 7 件のうち 2 件を実ソースで再確認した。

> **初回の実行は失敗していた**（ヒアドキュメントが stdin に吸われ、Codex が
> プロンプトを受け取らずに終了）。`< /dev/null` を付けて再実行した。
> 「レビューを通した」と言うには**実際に出力が返ったことの確認**が必要だった。

### 8.1 指摘 1（critical）: SubEtha は `true` でなければならない

**私の誤り。** フラグの意味を「credential を**渡す**操作が支出を引き起こすか」と解釈したが、
本来は「**credential を得るために支出が必要か**」である。

**自分が今セッションで書いたコードが反証になっていた**（`tools/u01r-s3-both.ts:38-51`）:

```
38-44: burn を broadcast し、receipt を待つ    ← ここで不可逆に支出
47-51: credential = { ..., burnTxHash: burnTx }  ← burn tx hash を含むので、
                                                   burn 後でしか組めない
```

**credential が `burnTxHash` を内包する**ため、**支出が論理的に先行する**。
「渡す時点では既に払っている」のではなく、「**払わないと credential を作れない**」。

レビューの指摘通り、私の解釈では **MPP push も `false` になってしまう**
（MPP も broadcast 後に credential を組む）。解釈自体が破綻していた。

→ **FR-3 を改訂**: SubEtha（self-transfer 経路）は **`true`**。
互換性は「誤った安全表示を保つ理由」にはならない。

### 8.2 指摘 2（high）: 不正な申告も危険側に倒す

FR-2 は「欠落」しか規定していなかった。`extra` は `Record<string, unknown>` で、
client も検証しない（`src/client/index.ts:114`）。

→ **FR-2 を改訂**: **リテラルの boolean `false` のみ**が「後で承認」を許す。
`null` / `0` / `""` / `"false"` / 欠落 / `extra` 自体の欠落は**すべて `true`**。
**truthy 変換を使わない**（`"false"` は truthy なので `Boolean()` では危険側に倒れない）。

### 8.3 指摘 3（medium）: `true` は「払った」ではなく「払う可能性がある」

現在の `true` 分岐の文面は「credential を作った時点で送金が**完了する**」と断定する
（`src/mcp/tools.ts:198`、`src/mcp/server.ts:168,187`）。
申告が無いだけの x402 offer に `true` が付くと、**この断定が嘘になる**。

→ **FR-5 を改訂**: 文面は「**支出が確定している場合**」と「**タイミングが不明な場合**」の
両方を含む保守的な表現にする。フラグ単体で支払いの成否を主張しない。
対象は `nextStep` と**ツール説明文 2 箇所**。

### 8.4 指摘 4（high）: credential 生成が承認検査より前にある

`src/mcp/tools.ts:232` は `deps.payer.credentialFor()` を呼ぶが、
承認の検査は `client.execute()` の中（`src/client/index.ts:277-287`）で**後**に行われる。
さらに catch の文面は "No payment was started" と**断定**している（`tools.ts:238`）。

現在注入されている x402 payer は**署名のみ**なので実害は出ていない。
しかし `payer` インタフェースは汎用であり、**支出する payer を注入できる**。

→ **新規 FR-7**: 支出可能な payer では**承認検査を credential 生成より前**に行う。
または `payer` インタフェースを**非支出実装に限定**すると明記し、制約を記録する。
「承認が無ければ payer を呼ばない」受け入れ条件を追加する。

### 8.5 指摘 5（medium）: grep テストは脆い

`subetha_router_*` のような正当な識別子を誤検出し、
定数経由の間接的なハードコードは**見逃す**。

→ **AC-4 / AC-5 を改訂**: **振る舞いのテスト**に置き換える。
「**未知のスキーム名**でも申告どおりの結果になる」「**同じ申告・異なるスキーム名**で同じ結果」を固定する。
静的検査は補助に留める。

### 8.6 指摘 6（medium）: FR-6 は scope と禁止を混同していた

`extra` に rail 非依存の boolean を必須化しても、**core がレール名で分岐することにはならない**。
P5 の「core を触らない」はあのスライスの scope であり、恒久的な禁止ではない。
そもそも 3 adapter すべてを変更する。

→ **FR-6 を改訂**: 型で必須にする案を**排除しない**。
`extra` 自由形＋実行時の厳格処理でも目的は達成できるが、
**typo と不正値がコンパイラに見えない**というトレードオフを明記する。

### 8.7 指摘 7（medium）: 互換性の根拠が誤り

`tests/wire/chat-crossimpl.test.ts:234-246` は「誤った quote の承認で payer に到達しない」ことを
検証しており、**申告欠落を `false` に固定していない**。
また CLAUDE.md:89-92 は **x402 でも署名前の承認を要求**している。

→ §2 の「互換性のため現状維持」という論拠を**撤回**。
fixture を実際のタイミングを申告する形に更新し、
**申告欠落の回帰テストを別に**用意するのが正しい。

### 8.8 レビューが確認した（修正不要）

- x402 = `false` は正しい（payer は `TransferWithAuthorization` を署名するだけ、
  `tools/x402-payer.ts:59-76`）。MPP = `true` も正しい
- `extra` は MCP 層に届く（`src/http/projection.ts:56`）。
  ただし**facilitator 要求にも乗り、厳格な offer 比較の対象にもなる**ため、
  wire テストでその境界を踏むべき
- **送信側に同種の分類器は無い**
- 「core のレール名規則違反」は**言い過ぎ**。`src/mcp/` は core の外。
  「MCP 層の不健全な結合」と表現すべき

### 8.9 §7 の 3 択への回答

レビューは選択肢 **1（fixture を更新）＋ 申告欠落の回帰テストを別途追加**を支持した。
ただし前提が変わった: SubEtha が `true` になるため、
**fixture の更新は「実際のタイミングを書く」ことになり、実装に合わせた改変ではない。**

## 9. 限定レビュー結果: APPROVE WITH CHANGES → 確定要件

レビュー実施: 2026-09-30、`gpt-6-astra`、`--sandbox read-only`、**§8 のみを対象**。
判定 **APPROVE WITH CHANGES**（実装の土台として承認、境界付き修正 5 件）。

### 9.1 FR-3 最終版: SubEtha は**常に** `true`

§8.1 は self-transfer だけを根拠にしていたが**不十分**だった。

- `helper` / `deadline` は**能力の広告**であり、payer が選ぶ経路ではない。
  helper 付き offer でも payer は self-transfer を選べる（`docs/u01r-requirements.md:298`）
- `createOffer()` は**どちらで払うか知り得ない**（`src/adapters/inbound/subetha.ts:175`）

→ **SubEtha は常に `true` を申告する。**
permit 経路では「署名が支出する」という主張ではなく**保守的な既定**である。
「credential を作るには払うしかない」という説明は **self-transfer に限定**して書く。
将来「非支出の経路に束縛された offer」が定義されたときに限り `false` を検討する。

### 9.2 FR-7 最終版: payer を**非支出に制約する**（承認順序の変更はしない）

`client.execute()` は**既に作られた credential** を受け取り、承認・quote 束縛の検査は
その**後**で行う（`src/client/index.ts:266-335`）。支出する payer を安全に扱うには
検査の前倒しか credential 生成の遅延が必要で、**本スライスの範囲を超える**。
`purchase()` が呼び出し側の quote を受け取る（`src/mcp/tools.ts:211`）ため、
「承認文字列の存在確認」だけでは不十分。

→ **`InboundPayer` を「署名のみ・非支出」に明示的に制約する**。
これを契約として文書化し、テストで固定する。**承認検査の前倒しはしない。**

→ さらに: `"No payment was started"`（`src/mcp/tools.ts:238`）は
**この非支出契約の下でのみ**許される。支出する payer は broadcast 後に throw し得るため、
承認の前倒しだけでは этот 文面を正当化できない。契約を破る payer を注入した場合は
**文面ごと成立しない**ことを記録する。

### 9.3 x402 の `ISSUED_EXTRA_KEYS` に追加が必須（**見落としていた罠**）

`src/adapters/inbound/x402.ts:44` の allowlist に無いキーが `extra` にあると、
preflight が `offer_mismatch` で**拒否する**（同 `:183-186`）。

したがって x402 offer に `fundsMoveOnCredential` を載せるなら、
**`ISSUED_EXTRA_KEYS` にも追加しなければ、正直な payer の支払いが全部落ちる**
（`tests/wire/x402-inbound.test.ts:100,119` の成功アサーションが失敗する）。

→ **allowlist と完全一致検査の両方に追加する。厳格比較を緩めて解決してはならない。**

### 9.4 データ経路は boolean を保つ（確認済み・懸念は解消）

adapter → `projection.ts:56` → `JSON.stringify`（`app.ts:32`）→ `JSON.parse`
→ `structuredClone`/freeze（`client/index.ts:47,114,208,261`）→ MCP。
**boolean が文字列化されたり `false` が落ちたりしない。** リテラル比較で十分。

**payer による偽造も不可能**: MCP は `quote.source.offer`（Router 発行）を読み、
payer 提供の `credential.accepted` は読まない。
`accepted` の改変は `stableJson` の型保存比較で弾かれる。
→ **この境界を保つ改ざんテストを追加する。**

### 9.5 テスト移行の確定仕様

`tests/unit/approval-funds-timing.test.ts` に **SubEtha ケースは存在しない**
（＝ SubEtha の反転だけでは既存テストは落ちない。§8.9 の前提は不正確だった）。

| 対象 | 変更 |
|---|---|
| MPP / x402 fixture | 明示的な `true` / `false` 申告を足す。`:54` `:64` の boolean 検査は**保持** |
| `:57` の `/Funds leave before/` | 条件付きの「purchase 前に支出し得る」表現に置換。**不可逆の警告は保持** |
| `:66` の警告不在検査 | **明示申告された** signing-only x402 に限って保持。**未申告 x402 は保守的警告を受ける** |
| 新規 | SubEtha（helper 有り／無し）、**未知スキーム**、不正・欠落申告 |
| `:72-73` | `approvalRequired === true` と人間承認の検査を**弱めない**。SubEtha にも拡張 |

### 9.6 指摘 5（私の説明の誤り）

§8.2 で「`"false"` は truthy なので危険側に倒れない」と書いたが**逆**だった。
`Boolean("false") === true` は**保守的な側**である。危険なのは
`null` / `0` / `""` / `undefined` が `false` になる方向。
**厳格比較の要件は正しいが、理由の説明が間違っていた。**

### 9.7 実装対象（確定）

1. 3 adapter が `extra.fundsMoveOnCredential` を申告（x402 `false` / SubEtha `true` / MPP `true`）
2. x402 の `ISSUED_EXTRA_KEYS` に追加（§9.3）
3. `fundsMoveBeforePurchase` を厳格リテラル判定に置換（`=== false` のみ許可）
4. `nextStep` とツール説明文 2 箇所を保守的表現に（`src/mcp/tools.ts:91,130,193`、`server.ts:167,187`）
5. `InboundPayer` の非支出契約を文書化（§9.2）
6. テスト（§9.5）＋ 改ざんテスト（§9.4）

## 10. 実装記録

### 10.1 変更点

| ファイル | 変更 |
|---|---|
| `src/adapters/inbound/x402.ts` | `fundsMoveOnCredential: false` を申告。**`ISSUED_EXTRA_KEYS` にも追加**（§9.3） |
| `src/adapters/inbound/subetha.ts` | `true` を申告（**常に**。helper の有無に依らない） |
| `src/adapters/inbound/mpp.ts` | `true` を申告 |
| `src/mcp/tools.ts` | 判定をレール名 → **offer の申告の厳格リテラル比較**に置換。`nextStep` を保守的表現に |
| `src/mcp/server.ts` | ツール説明 2 箇所からレール名を除去し、「支出し得る」表現に |
| `tests/unit/approval-funds-timing.test.ts` | 全面改訂（§9.5）。**未知スキーム**・不正申告・SubEtha を追加 |
| `tests/wire/x402-inbound.test.ts` | 申告の改竄テスト 4 種 + allowlist の正常系 |
| `tests/wire/subetha-inbound.test.ts` | **申告値を固定**（helper 有無の両方） |
| `tests/wire/mpp-inbound.test.ts` | **申告値を固定** |

### 10.2 検証

- `npm run types` → エラーなし
- `npm test` → **235 passed / 14 skipped**（変更前 222 → **+13**）
  skip は既存の `chat-crossimpl.test.ts` 条件付き skip

### 10.3 sabotage 検証（4 種すべて対応するテストが落ちた）

| 壊した箇所 | 結果 |
|---|---|
| fail safe を `=== true` に（欠落時 `false`） | 「欠落・不正は危険側」「完了と断定しない」の **2 件が失敗** |
| **x402 の allowlist から申告キーを削除** | **正常系を含む 4 件が失敗**（§9.3 の罠を実証） |
| SubEtha の申告を `false` に | 申告値固定テストが失敗 |
| MPP の申告を `false` に | 同 |

**2 件目が最も価値がある**: レビュー指摘 3 を反映していなければ、
**正直な payer の x402 支払いが全部落ちていた**。

### 10.4 sabotage で見つかった穴（その場で修正）

初回の sabotage で **SubEtha / MPP の申告値を `false` に変えてもテストが落ちなかった**。
unit テストは手書き fixture を使うため、**adapter の実際の申告値を誰も固定していなかった**——
つまり「本スライスが直そうとしている欠陥そのもの」を検出できない状態だった。

→ `tests/wire/{subetha,mpp}-inbound.test.ts` に申告値を固定するテストを追加した。
**green を信じず壊して確かめたから見つかった穴**である。
