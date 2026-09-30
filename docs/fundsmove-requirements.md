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
