# 設計: 設定変更時の未処理 quote 無効化（FR-17）+ 付随する小改善

> 2026-10-01。要件は `generalization-requirements.md` §17.6（3 回目レビューで APPROVE）。
> **core を変更する**ため、独立レビューを経てから実装する。

## 1. 解く問題

`orchestrator.ts:668-672` の送金直前の照合対象は
**`intent.destination.selectedOffer`（journal 保存済み）**であり、
**現在の設定 `DestinationAllow` ではない**。

→ 運用者が設定の `payTo` を変更しても、**変更前に発行された未失効 quote は旧 `payTo` に支払える**。
journal された quote は**再起動も越える**。

FR-0（設定が信頼の権威）の**唯一の実質的な抜け**。

## 2. 設計

### 2.1 route 設定の指紋を quote に焼き込む

既存の `fingerprintOf`（`intent.ts:132`）をそのまま使う。**新しい暗号処理を書かない。**

```
quote 時:  routeFingerprint = fingerprintOf(<route 設定の権威部分>)
           → journal の `created` に記録（既存の `quoteFingerprint` と並べる）

purchase 時: 現在の設定から同じ指紋を再計算し、journal の値と比較
             不一致 → 拒否（支払わない）
```

### 2.2 指紋の対象（権威部分の定義）

**`destination` 全体と `source` の金銭的条件**を含める:

| 欄 | 含める理由 |
|---|---|
| `destination.scheme` / `network` / `asset` / **`payTo`** | **受取先と資産の権威**。FR-17 の主目的 |
| `source.amount` / `asset` / `network` | 受信条件の権威（`orchestrator.ts:317` が既に照合） |
| `source.payTo`（存在する場合） | x402/MPP 受信の受取先 |
| `rail` / `sourceRail` | レール変更は別の経路になる |

**含めないもの**（変更が支払いの安全性に影響しない）:

- `canonicalPath` — `routeId` から導出される（`config.ts:79`）
- `decimals` — 表示用。金額の権威は `amount`
- `upstreams[routeId]`（上流 URL）— **含めない**。
  理由: 上流 URL が変わっても `selectedOffer` の完全一致照合（`orchestrator.ts:671`）が
  **別の offer を弾く**ため、二重に守る必要がない。
  また URL は秘匿対象（`projection.ts:14`）なので、指紋に入れると漏洩面が増える

### 2.3 実装箇所（最小）

| ファイル | 変更 |
|---|---|
`src/config.ts` | `routeFingerprintOf(route)` を追加（`fingerprintOf` を使う） |
`src/core/intent.ts` | `Intent` に `routeFingerprint?: string` を追加（**任意欄**） |
`src/core/orchestrator.ts` | quote 時に記録、purchase 時に照合 |

**`src/core/store.ts` と `budget.ts` は変更しない**（イベント種別を増やさない）。

### 2.4 旧 journal の互換性（**重要**）

既存の `created` レコードに `routeFingerprint` は無い。

**方針: 欄が無い intent は照合を飛ばす（grandfather する）。**

| 選択肢 | 判断 |
|---|---|
| 欄が無ければ**拒否** | **却下**。再起動後に既存の未処理 quote が全部死ぬ。運用上の破壊 |
| 欄が無ければ**飛ばす** | **採用**。旧 quote は従来の挙動（`selectedOffer` 完全一致）で守られる |

**根拠**: 旧 quote も `selectedOffer` の完全一致照合は受ける。
FR-17 が追加するのは「**設定変更の検出**」であり、
旧 quote には**そもそも比較対象の指紋が無い**。
拒否は「安全側」ではなく**可用性の破壊**であり、守る対象が増えない。

**ただし記録する**: 旧 journal の未処理 quote は FR-17 の保護を受けない。
運用上は「設定変更後は未処理 quote の失効（最大 60 秒）を待つ」ことで塞がる
（`approvalTtlMs` 既定 60000）。

### 2.5 拒否時の挙動

既存の理由コードを使う。**新しいコードを増やさない。**

```
不一致 → status: "awaiting_payment", code: "quote_changed"
```

`quote_changed` は既に `SAFE_REASONS` にあり（`orchestrator.ts:202`）、
「上流の提示が変わった」の意味で使われている。
**「設定が変わった」も呼び出し側から見れば同じ**（この quote では払えない）。

→ **情報を増やさない**のは意図的。
どちらの理由で拒否されたかを外に出すと、設定内容の推測material になる。

### 2.6 照合のタイミング

**purchase の入口で、credential を触る前**（`orchestrator.ts:392` の承認検査の直後）。

理由:
- **資金が動く前**に止める（FR-7'' の既存不変条件と同じ位置）
- `readAndMatchDestination`（`:668`）より**前**。
  上流へのネットワーク要求すら発生させない

## 3. 付随する小改善（要件 §17.6 の 2〜5）

### 3.1 `userinfo` / `fragment` の拒否（AC-C）

`assertAbsoluteHttpUrl`（`config.ts:376`）に 2 行足す:

```
url.username !== "" || url.password !== ""  → ConfigError
url.hash !== ""                              → ConfigError
```

**dot-segment は `new URL()` の正規化に委ねる**（§17.4 の方針。独自の等価性を発明しない）。

### 3.2 `real` モードの内部アドレス警告（AC-D / AC-E）

**起動を止めない。警告のみ**（fixture が loopback を要するため）。

- 対象は **`real` モードの上流 URL のみ**
- `synthetic` は**対象外**（`config.ts:99` が loopback 限定を明記）
- 判定は**ホスト名の文字列**で足りる（DNS 解決しない。§17.3 で接続時強制は範囲外と確定）
- 出力先は stderr。**URL 自体は出さない**（`DEPLOY.md:77` の既存方針に合わせる）

### 3.3 回帰テストとして固定するもの（AC-F / AC-G）

- 静的異資産 route（`zETH → USDC`）が動く
- 予約が settle 前に行われ、unknown で復活しない

**どちらも既存の挙動**。新規実装は無い（§17.2 の判断）。

## 4. やらないこと

- 接続時の SSRF 強制（§17.3。FR-0 を外す判断とセット）
- 信頼ストア / TOFU / 期限 / ドリフト永続化（§15.2 で破棄）
- 上流 URL を指紋に含める（§2.2 の理由）
- 新しいイベント種別・新しい理由コード

## 5. テスト計画

| ID | 内容 | 種別 |
|---|---|---|
| AC-A | 設定の `payTo` 変更後、変更前 quote の purchase が `quote_changed` で拒否 | unit |
| AC-A2 | **`source.amount` 変更でも拒否**（指紋の対象範囲の確認） | unit |
| AC-A3 | **`decimals` 変更では拒否しない**（対象外欄の確認） | unit |
| AC-B | 設定変更が無ければ従来どおり成立 | unit |
| AC-B2 | **`routeFingerprint` 欄が無い旧 intent は飛ばす**（互換性） | unit |
| AC-C | `userinfo` / `fragment` を含む URL を設定検証で拒否 | unit |
| AC-D | `real` で loopback 上流 → 警告が出て**起動は成功** | wire |
| AC-E | `synthetic` は loopback で従来どおり | 既存テスト |
| AC-F | 静的異資産 route が動く | 既存テスト |
| AC-G | 予約が settle 前・unknown で復活しない | 既存テスト |
| AC-H | 全テスト通過（**skip と実行を区別して報告**） | `npm test` |

**sabotage 検証**（MEMORY.md の方針）:
1. 照合を常に true にする → AC-A が落ちること
2. 指紋から `payTo` を除く → AC-A が落ちること
3. 旧 intent の飛ばしを「拒否」に変える → AC-B2 が落ちること

## 6. 未解決

**U-A**: `source.payTo` は SubEtha では設定に無い（facilitator が返す）。
指紋では**存在する場合のみ含める**。SubEtha route では欄が無いので影響しない
（指摘6 の「受取先が config 権威とは言えない」への対応）。

## 7. 自己検証（設計レビュー待機中）

### 7.1 検査位置: バイパス経路は無い（確認済み）

`purchase()` の入口（`orchestrator.ts:371-392`）を辿った:

```
:372 unknown_quote        → 支払わない
:377 not_owner            → 支払わない
:382 route_mismatch       → 支払わない
:386 request_id_conflict  → 支払わない
:390 status !== "created" → currentOutcome（既存状態を返すだけ。新規支払い無し）
:392 approval !== quoteId → 支払わない
     ↑ FR-17 の検査をここに挿入する
```

`status !== "created"` の分岐は `currentOutcome`（`:675`）で**既存の状態を返すだけ**であり、
支払いを再開しない。`source_settled` は public status `"paid"`（`intent.ts:36`）。
→ **再開経路から支払いに到達するパスは無い。**

### 7.2 設計の限界（記録する）

**受信が成立した後（`source_settled`）に設定を変更しても、送信レグは止められない。**

FR-17 が守るのは「**まだ受信していない quote**」だけである。
受信済みで送信前の intent は、journal の `selectedOffer` に従って送信される。

これは FR-17 の欠陥ではなく、**at-most-once と two-leg の設計そのもの**から来る:
受信した資金に対して上流への支払い義務が既に発生しているため、
設定変更で一方的に取り消すと**支払人の資金を預かったまま配信しない**ことになる。

→ **意図的に守らない。** 運用上は「設定変更前に未処理 intent の終端を待つ」で塞ぐ。

### 7.3 `userinfo` 拒否は既存運用と衝突しない（確認済み）

`assertAbsoluteHttpUrl` の呼び出し元は 3 箇所（`config.ts:433,442,447`）で、
いずれも設定値の検証。

**懸念**: facilitator URL に認証情報を入れる運用があるか。
→ `DEPLOY.md:76` は「**URL 自体が資格情報（パスに API キーを含む）**」と明記している。
つまり**資格情報はパスに入る**運用であり、`userinfo`（`user:pass@host`）形式ではない。

→ **`userinfo` 拒否は既存運用を壊さない。**
ただし **`fragment` 拒否も同様に安全**だが、
**クエリは既に拒否されている**（`allowQuery=false`）ので、
API キーがクエリに入る運用は**そもそも現在も不可**。

**警告出力の注意**: `DEPLOY.md:77` が「起動ログに URL を出さない」方針を定めている。
→ §3.2 の警告は**ホスト名も出さない**。「上流 URL が内部アドレスを指している」という
事実のみを出力する（どの route かは `routeId` で示す）。

## 8. 設計レビュー: **REJECT** — 設計を修正する

レビュー実施: 2026-10-01、`gpt-6-astra`。**致命的 2 件**。両方とも実ソースで確認した。

### 8.1 指摘1（blocking）: **設計が機能しない** — `store.ts` の変更が必須

`intentFromCreated`（`store.ts:30-50`）は**フィールドを明示列挙**し、`patch` を spread しない。

→ **`routeFingerprint` を journal に書いても Intent に復元されない。**
さらに `store.ts:236` が **append 直後にこの再構築を呼ぶ**ので、
**再起動を待たず作成直後に消える**。
→ **全 intent が grandfather 経路に落ち、検査が一切機能しない。**

§2.3 の「`store.ts` は変更しない」は**誤り**。

**修正**:
- `intentFromCreated` に `routeFingerprint` の**明示的な復元**を追加する
- **欠落（legacy）と「存在するが不正」を区別する**。
  不正値を silently legacy に落とさない（`journal.ts:188` は `patch` がオブジェクトかしか見ない）
- **指紋は認証ではない**: 鍵無しハッシュなので journal を改変できる者には無意味。
  journal 改変は**本機能の保証範囲外**（flock と単一 writer が別に守る）と明記する

### 8.2 指摘2（high）: **grandfather は FR-17 の目的を壊す**

**要件 §17.1 は「grandfather しない」と明記していた**のに、設計 §2.4 で勝手に覆していた。

レビューが示した具体的な失敗:

```
quote(payTo=A) → 設定を payTo=B に変更 → 再起動 → 旧 quote で purchase
  照合1 readAndMatchDestination: journal の A と上流の accepts を比較 → 上流がまだ A を出していれば一致
  照合2 adapter 側の offer 比較: A 同士 → 一致
→ 設定が B なのに A に払える
```

**私の「拒否しても保護は増えない」という主張は誤り**だった。
既存の照合は**どちらも journal の A を基準にする**ので、設定変更を検出できない。

**修正**: legacy intent（指紋欄が無い）に対しては、
**復元可能な条件を現在の設定と照合する**:

```
legacy intent の purchase 時:
  intent.destination.{scheme, network, asset} と selectedOffer.payTo を
  現在の route.destination と比較する
  → 不一致なら拒否
```

`Intent` には `destination.{quoted, asset, network, selectedOffer}` が復元されており
（`store.ts:46-50`）、`selectedOffer.payTo` も含まれる。
**指紋が無くても、設定との照合は可能**である。

→ **「指紋があれば指紋で照合、無ければ復元可能な欄で照合」**とする。
**無条件に通すことはしない。**

### 8.3 指摘3: 「最大 60 秒」は誤り

`approvalTtlMs` は**設定可能**（`config.ts:317`）で、
offer の有効期間も 60 秒を超え得る（**MPP の既定は 600 秒**、`main.ts:265`）。
再起動は**元の絶対期限を保持する**。

→ §2.4 の「最大 60 秒待てば塞がる」を**撤回**。
「設定変更後に未処理 quote を待つ」を緩和策とするなら、
**その間 purchase を無効化する**必要がある（単に待つだけでは窓が開いたまま）。

### 8.4 指摘4: 上流 URL 除外の論拠が不正確

x402 の offer は `accepts[]` 由来で、**`resource.url` は offer に含まれない**
（`x402.ts:309,316` は**現在の設定 URL** と照合する）。
→ **完全に同一の `accepts` を出す別 Provider なら `stableJson` も一致する。**

**ただし**: 同一 offer なら**受取先も金額も同じ**なので、
**資金の宛先は変わらない**。
→ **destination 条件に限定した FR-17 としては URL 除外は妥当**だが、
**「Provider 差し替えを検出する」保護ではない**。この境界を明記する。

「公開 URL の秘匿」は**非公開の指紋から除外する理由にならない**（論拠として不適切だった）。

### 8.5 指摘6: 運用診断を潰す必要は無い

既存の `quote_changed` は**受信成立後**に `terminalReason` として使われ（`orchestrator.ts:586`）、
受信前のドリフトは `offer_changed`（`:445`）。
→ `awaiting_payment` + `code: quote_changed` は**status と欄で区別可能**なので再利用は妥当。

**ただし**: 値や URL を含まない固定文（例: `route configuration mismatch`）を
**ログに出す**のは運用上有益で、設定を公開しない。
→ **公開応答は `quote_changed`、ログは固定診断文**とする。

### 8.6 レビューが確認した（修正不要）

- **検査位置は正しい**（preflight は `:413`、上流読取 `:428`、verify `:474`、settle `:515`）。
  代替の支払い入口は無い。
  ただし「資金が動く前」は **Router 側の話**と限定すべき
  （SubEtha の credential は**外部で既に broadcast された支払い**を表し得る、`subetha.ts:203`）
- `canonicalPath` / `decimals` の除外は**妥当**
- URL 検証は 3 呼び出し元と**互換**。**SubEtha の `allowQuery=true` は維持**すること
- ホスト名のみの警告は**助言的検出として妥当**。DNS による false negative を明記する

### 8.7 テスト計画の追加（指摘5）

| 追加 | 内容 |
|---|---|
| T-1 | quote → **journal を閉じて再開** → `payTo` 変更 → 上流は旧 offer を出す → **拒否**。かつ **preflight / 上流読取 / verify / settle / pay の呼び出しが 0** |
| T-2 | 同じ再起動で**設定不変**なら成立。**指紋が再構築を生き残る**ことを確認 |
| T-3 | **legacy（指紋なし）× 設定変更** → 拒否 / **legacy × 設定不変** → 成立 |
| T-4 | **指紋が不正値**（文字列でない等）→ legacy に落とさず拒否 |
| T-5 | 指紋対象の**各欄**を個別に変更して拒否を確認（両レール） |
| T-6 | **U-A**: `source.payTo` 不在（SubEtha）で**シリアライズ往復後も安定**。かつ destination 変更は拒否。x402/MPP の `source.payTo` 変更も個別に試験 |
| T-7 | **同一 offer の Provider 差し替え** → 期待挙動（§8.4 の境界）を明示的に固定 |

**sabotage 修正**:
- 2 は **destination の `payTo`** を指定する
- **3 を差し替え**: 「legacy を無条件に通す」改変を入れて T-3 が落ちることを確認
- **4 を追加**: `intentFromCreated` から指紋の復元を削除して T-2 が落ちることを確認

### 8.8 未検出の限界（明記する）

**SubEtha は facilitator が `payTo` を発行する**ため（`subetha.ts:197`）、
**設定由来の指紋では受取先の変化を検出できない**。
FR-17 が守るのは**設定で宛先を固定しているレール**（x402 / MPP 送信）である。

## 9. 修正版設計（確定）

### 9.1 構成

```
quote 時:
  routeFingerprint = fingerprintOf(authoritativeTermsOf(route))
  → journal の `created` patch に記録

store 復元時（store.ts:30 intentFromCreated）:
  patch["routeFingerprint"] を **明示的に復元**
  - 文字列で `sha256:` 始まり → 採用
  - 欠落            → undefined（legacy）
  - **それ以外（型違い・空文字）→ 不正値として記録**（legacy に落とさない）

purchase 時（orchestrator.ts:392 の直後）:
  現在の設定から同じ指紋を再計算
  - intent に指紋あり  → 一致しなければ拒否
  - 指紋が不正値       → **拒否**
  - 指紋なし（legacy） → **復元可能な destination 欄を現在の設定と照合**し、
                          不一致なら拒否
```

### 9.2 指紋の対象（`authoritativeTermsOf`）

```
{
  destination: { scheme, network, asset, payTo },
  source:      { amount, asset, network, payTo?（存在する場合のみ） },
  rail, sourceRail
}
```

**除外**: `canonicalPath`（`routeId` 由来）、`decimals`（表示用）、
上流 URL（§8.4 の通り、destination 条件の保護としては不要。
**ただし「Provider 差し替えの検出」ではないことを明記**）。

### 9.3 legacy の照合（指摘2 の修正）

指紋が無い intent では、**`Intent` に復元済みの欄**で照合する:

| 比較対象 | 復元元 |
|---|---|
| `intent.destination.network` / `asset` | `store.ts:48,49` |
| **`intent.destination.selectedOffer.payTo`** | `store.ts:50` |
| `intent.destination.selectedOffer.scheme` | 同上 |
| `intent.source.amount` / `asset` / `network` | `store.ts:42-44` |

→ **設定の `DestinationAllow` と `source` と比較**し、不一致なら拒否。
**無条件に通さない。**

### 9.4 拒否時の挙動

| 面 | 内容 |
|---|---|
| 公開応答 | `status: "awaiting_payment"`, `code: "quote_changed"`（既存コード） |
| **ログ** | 固定文 `route configuration mismatch` と `routeId`。**値・URL・ホスト名は出さない** |

### 9.5 変更ファイル（確定）

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `authoritativeTermsOf(route)` と `routeFingerprintOf(route)` を追加。`assertAbsoluteHttpUrl` に `userinfo` / `fragment` 拒否（**`allowQuery` の既存挙動は変えない**） |
| `src/core/intent.ts` | `Intent` に `routeFingerprint?: string` / `routeFingerprintInvalid?: boolean` |
| **`src/core/store.ts`** | **`intentFromCreated` に明示的な復元を追加**（指摘1） |
| `src/core/orchestrator.ts` | quote 時に記録、purchase 時に照合（指紋 / legacy / 不正値の 3 分岐） |
| `src/main.ts` | `real` モードの上流が内部アドレスなら**警告**（起動は継続） |

`budget.ts` は**変更しない**。

### 9.6 やらないこと（確定）

- grandfather（§8.2 で撤回）
- 接続時 SSRF 強制（要件 §17.3）
- 上流 URL の指紋への組み込み（§8.4）
- SubEtha の facilitator 発行 `payTo` の変化検出（**§8.8 の限界として受容**）
- 新しいイベント種別・新しい公開理由コード

## 10. 自己検証（§9 のレビュー待機中）

### 10.1 `stableJson` の undefined 扱いは**安全**（最大の懸念が解消）

`intent.ts:125` が `.filter(([, nested]) => nested !== undefined)` で
**undefined の欄を除外**している。

→ `{a:1}` と `{a:1, payTo: undefined}` は**同一文字列**になる。
**SubEtha（`source.payTo` 不在）でも指紋は安定し、全購入が拒否される事故は起きない。**

私が最も危険視していたバグは、**既存実装が既に防いでいた**。
`§9.2` の「存在する場合のみ含める」は、実装上は
**単に `payTo: route.source.payTo` と書けばよい**（undefined なら自動的に除外される）。

### 10.2 `route` は purchase 時に参照できる（確認済み）

`orchestrator.ts:246` が `const config: RouterConfig = structuredClone(options.config)`
としてクロージャに保持している。**不変コピー**なので purchase 時にも同じ値が見える。

→ **指紋の再計算は可能。** 追加の配線は不要。

### 10.3 **設計の抜け: route が削除された場合**（自己発見）

`quote` 時は `resolveRoute` が `undefined` を返せば `unknown_route` で拒否する（`:283-286`）。
しかし **purchase 時に route が設定から消えていた場合**の扱いを §9 は定義していない。

これは**「設定変更」の一形態**であり、FR-17 が扱うべきケース。

→ **§9.1 に 4 つ目の分岐を追加する**:

```
purchase 時:
  route = resolveRoute(config, intent.routeId)
  route === undefined → **拒否**（設定から消えた route では払わない）
```

公開応答は同じ `quote_changed`（削除されたことを外に出さない）。
ログは `route configuration mismatch` + `routeId`（§9.4 と同じ）。

**根拠**: route を削除する行為は「この経路での支払いをやめる」という運用判断であり、
**未処理 quote を通すのは意図に反する**。
また削除後は指紋の再計算もできないので、**legacy 照合も不可能**。

### 10.4 §9.5 の補足: SubEtha facilitator の `allowQuery`

`config.ts:447` の SubEtha facilitator は `allowQuery=true` で呼ばれている（レビュー指摘）。
→ **`userinfo` / `fragment` 拒否は `allowQuery` と独立**に実装する。
`allowQuery` の既存挙動は変えない。

## 11. 設計レビュー（APPROVE WITH CHANGES）→ **最終設計**

レビュー実施: 2026-10-01、`gpt-6-astra`。**判定: APPROVE WITH CHANGES**。
「§9 は元の payTo A→B 脆弱性を閉じており、懸念した `stableJson` のバグは存在しない」。
修正 2 件（1 件は §10.3 で自力発見済み）。

### 11.1 指摘1: legacy の照合は**指紋と同等にできない** → 方針を変える

レビューの指摘を検証した:

| 欄 | legacy で復元できるか |
|---|---|
| `destination.{scheme, network, asset, payTo}` | **できる**（`selectedOffer` 経由） |
| `source.{amount, asset, network}` | **できる** |
| `source.payTo`（x402/MPP） | **できる**（`intent.source.offer.payTo`。§9.3 は漏らしていた） |
| **`rail` / `sourceRail`** | **できない**。**journal に保存されていない**（自分で確認: `grep` で 0 件） |

→ **`rail` の変更は legacy intent では検出できない。**
「省略された既定値か明示指定か」も復元できない。

**したがって「legacy を照合して通す」は、指紋と同等の保護を与えられない。**
§9.3 の表は**同等性を主張していたが誤り**だった。

**修正: legacy intent は照合せず、一律で拒否する。**

```
purchase 時:
  指紋あり        → 現在の設定と照合。不一致なら拒否
  指紋が不正値    → 拒否
  **指紋なし（legacy）→ 拒否**（「再 quote してください」）
```

**根拠**:
1. **部分的な照合は、守れない欄があることを隠す**。
   `rail` を変えても通る照合は、運用者に誤った安心を与える
2. legacy intent は**この変更をデプロイする前に発行されたもの**であり、
   **存在するのはデプロイ直後の最大 `approvalTtlMs`（既定 60 秒、MPP は offer 600 秒）だけ**
3. **拒否のコストは「再 quote」**であり、資金の損失ではない
4. §8.2 で「拒否は可用性の破壊」と書いたが、**あれは「恒久的に旧 quote が死ぬ」と誤解していた**。
   実際は**デプロイ直後の短い窓だけ**であり、しかも**再 quote で回復する**

**デプロイ手順に記載する**: 本変更のデプロイ直後、
**未処理 quote は再 quote が必要**（最大で offer 有効期間ぶん）。

### 11.2 指摘2: route 解決と削除時の扱い（§10.3 と同一）

**確定**:

```
purchaseLocked:
  :372 unknown_quote
  :377 not_owner
  :382 route_mismatch
  :386 request_id_conflict
  :390 status !== "created" → currentOutcome
  :392 approval !== quoteId
  ↓ ここに追加
  route = resolveRoute(config, intent.routeId)   ← config.ts:66
  route === undefined → 拒否（quote_changed）
  指紋の照合                                      ← §11.1
  ↓ 以降は既存（preflight :413 / 上流読取 :428 / verify :474 / settle :515）
```

**`resolveRoute` は既存関数**（`config.ts:66`）。新規実装は不要。

### 11.3 不正値の判定（レビューの補足を反映）

`asString`（`store.ts:13`）は**非文字列に fallback を返す**（coerce も throw もしない）。

→ **`asString` を使う前に、生のプロパティの有無と型を見る**:

```
raw = patch["routeFingerprint"]
raw === undefined                                → legacy
typeof raw === "string" && raw.startsWith("sha256:")  → 採用
それ以外                                          → 不正値
```

**両方のフィールド（`routeFingerprint` / `routeFingerprintInvalid`）を
この生の値だけから導出する。**

なお「`sha256:` で始まるゴミ」は採用されるが、
**purchase 時の digest 比較で落ちる**（レビューの指摘通り）。

### 11.4 最終的な変更ファイル

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `authoritativeTermsOf` / `routeFingerprintOf` を追加。`assertAbsoluteHttpUrl` に `userinfo` / `fragment` 拒否（`allowQuery` は不変） |
| `src/core/intent.ts` | `Intent` に `routeFingerprint?: string` / `routeFingerprintInvalid?: boolean` |
| `src/core/store.ts` | `intentFromCreated` に**生の値からの明示的な復元**（§11.3） |
| `src/core/orchestrator.ts` | quote 時に記録。purchase 時に **route 解決 → 指紋照合**（§11.2） |
| `src/main.ts` | `real` モードの上流が内部アドレスなら**警告** |

### 11.5 テスト（最終）

§8.7 の T-1〜T-7 に加えて:

| ID | 内容 |
|---|---|
| **T-3'（差し替え）** | **legacy（指紋なし）は設定不変でも拒否される**（§11.1 の方針） |
| T-8 | **route 削除後の purchase が拒否される** |
| T-9 | `sha256:` で始まるが内容が違う指紋 → **digest 比較で拒否** |
| T-10 | `routeFingerprint` が数値・null・空文字 → **不正値として拒否**（legacy に落ちない） |

**sabotage（最終）**:
1. 指紋の照合を常に true → T-1 が落ちる
2. 指紋から **destination の `payTo`** を除く → T-1 が落ちる
3. legacy を**通す**ように変更 → T-3' が落ちる
4. `intentFromCreated` の復元を削除 → T-2 が落ちる
5. route 解決の分岐を削除 → T-8 が落ちる

## 12. 実装記録

### 12.1 変更点

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `authoritativeTermsOf` 追加。`assertAbsoluteHttpUrl` に `userinfo` / `fragment` 拒否（`allowQuery` は不変） |
| `src/core/intent.ts` | `Intent` に `routeFingerprint?` / `routeFingerprintInvalid?` |
| `src/core/store.ts` | `routeFingerprintOf(patch)` を追加し、**`intentFromCreated` で明示的に復元** |
| `src/core/orchestrator.ts` | `RouterCoreOptions.note` 追加。quote 時に指紋記録、purchase 時に route 解決＋指紋照合 |
| `src/main.ts` | `warnIfInternalUpstream` 追加（`real` モードのみ）。`note` を stderr に配線 |
| `tests/unit/lifecycle.test.ts` | FR-17 の 8 ケース |
| `tests/unit/upstream-url-rules.test.ts`（新規） | URL 規則 9 ケース |
| `tests/unit/internal-upstream-warning.test.ts`（新規） | 警告 13 ケース |

### 12.2 検証

- `npm run types` → エラーなし
- `npm test` → **274 passed / 14 skipped**（着手前 244 → **+30**）
  - skip は既存の `chat-crossimpl.test.ts` 条件付き skip（chat 実装が本ワークツリーに無い）

### 12.3 sabotage 検証（7 種、すべて検出）

| 壊した箇所 | 失敗数 |
|---|---|
| 指紋比較を無効化 | **5** |
| **`store.ts` の復元を削除** | **29**（レビュー指摘1 の致命性を実証） |
| 指紋から `destination.payTo` を除く | 2 |
| `route` 解決の分岐を削除 | 1 |
| 診断の区別を潰す | 1 |
| 内部アドレス警告を出さなくする | 10 |
| `userinfo` 拒否を外す | 2 |

**2 件目が最も重要**: レビューが指摘した通り、復元を忘れると
**既存テスト 29 件が落ちる**。指紋が append 直後に消え、全購入が失敗する。

### 12.4 sabotage で見つけて直したこと（2 件）

**(a) 冗長な分岐があった。** 当初 `intent.routeFingerprint === undefined` を
明示的に書いていたが、**これを消してもテストが落ちなかった**。
原因は後続の不等号比較（`undefined !== "sha256:…"`）が同じケースを捕まえていたこと。

→ **判定を 1 本の不等号に統合した。**
二重に書くと「片方を消してもテストが落ちない」= **何が性質を守っているのか追えなくなる**。

**(b) 診断の区別を守るテストが無かった。**
`routeFingerprintInvalid` を判定から外した結果、**診断専用**になった
（`route removed` / `unreadable quote fingerprint` / `quote predates this check` /
`route configuration changed` を区別してログに出す）。
当初はこれを守るテストが無く、区別を潰しても落ちなかったので追加した。

### 12.5 設計との差分

設計 §11.3 は不正値を `routeFingerprintInvalid` で**判定**する想定だったが、
実装では**判定は不等号 1 本**に集約し、フラグは**診断のみ**に使う形にした。
拒否の結果は同じ（不正値も `undefined` 扱いで比較に落ちる）。
**理由**: 判定経路を 1 本にすると、sabotage で「何が守っているか」が一意に分かる。

## 13. 実装レビュー（APPROVE WITH CHANGES）→ 反映完了

レビュー実施: 2026-10-01、`gpt-6-astra`、対象 `8d24aa9`。
**「FR-17 の支払いガードは正しく、迂回する支払い経路は見つからなかった」**。指摘 4 件を全件反映。

| # | 指摘 | 対応 |
|---|---|---|
| 1 | 指紋の**各欄**に回帰試験が無い（`destination.payTo` と `source.amount` だけ） | **8 欄を個別に試験**（scheme/network/asset ×2、`source.payTo`、`rail`、`sourceRail`） |
| 2 | **公開ホスト名を誤検知**（`fd-cdn.example.com`、**`10.example.com`**） | **アドレス prefix 判定を IP リテラルに限定**。DNS 名は suffix 規則で別扱い |
| 3 | malformed の試験が数値 1 件のみ。**legacy と区別できていない** | `null` / 空文字 / 接頭辞違い / `sha256:` のみ を追加。**診断の区別も固定** |
| 4 | **空の fragment（末尾 `#`）が通る**（`url.hash` が空文字） | **生の文字列に `#` があるか**で判定 |

### 13.1 指摘2 は自己検証でも一部発見していた

IPv6 の `fc`/`fd` 誤検知は自分で見つけて修正したが、
**レビューが `10.example.com`（IPv4 prefix をホスト名に当てる誤り）を追加で指摘**した。
→ **prefix 判定そのものを IP リテラルに限定**する形に書き直した。

### 13.2 sabotage 検証（最終・11 種すべて検出）

| 壊した箇所 | 失敗数 |
|---|---|
| 指紋比較を無効化 | 5 |
| **`store.ts` の復元を削除** | **29** |
| 指紋から `destination.payTo` を除く | 2 |
| `route` 解決の分岐を削除 | 1 |
| 診断の区別を潰す | 1 |
| 内部アドレス警告を出さなくする | 10 |
| `userinfo` 拒否を外す | 2 |
| IPv6 判定をホスト名に当てる（誤検知の再現） | 2 |
| **`source.payTo` を指紋から外す**（レビュー推奨の 8 番目） | **1** |
| `rail` を外す | 1 |
| `sourceRail` を外す | 1 |
| **malformed を legacy に落とす** | **4** |

**最後の 4 件は、レビュー指摘を反映する前は 0 件だった**（＝守られていなかった）。

### 13.3 検証（最終）

- `npm run types` → エラーなし
- `npm test` → **293 passed / 14 skipped**（着手前 244 → **+49**）

### 13.4 レビューが明示した限界（記録）

- **指紋は完全性署名ではない**。journal を改変できる者は現在の指紋に差し替えられる。
  本変更が守るのは**設定ドリフト**であり、journal 改変は flock と単一 writer が別に守る
- `source_settled` 済みの intent は照合を**通らない**が、
  `currentOutcome` を返すだけで**再決済も再送金もしない**
- legacy quote の回復には**新しい `requestId`** が必要
  （同一 `requestId` の再 quote は旧 quote を返す）
- **テスト結果と sabetage は著者の報告**であり、レビュー側は再現していない

## 14. 追加レビュー前の自己検証（`2465c9a` 対象）

### 14.1 `%23` の誤拒否は無い（確認済み）

`raw.includes("#")` が**パーセントエンコードされた `%23`** を誤って拒否しないか検証した:

| URL | 結果 |
|---|---|
| `https://e.com/p%23k` | **受理**（エンコード済みなので生の文字列に `#` が無い） |
| `https://e.com/v2/key%23abc` | **受理**（資格情報をパスに持つ運用と両立） |
| `https://e.com/p#` | 拒否（空 fragment） |
| `https://e.com/p#f` | 拒否 |
| `https://e.com/v2/abc123key` | **受理**（`DEPLOY.md:76` の運用パターン） |

→ **正当な設定を壊さない。**

### 14.2 各欄のテストは FR-17 を試験できている（確認済み）

レビュー指摘3 の懸念（「テストが誤った理由で通っていないか」）を検証した。

**最初の probe は誤読だった**: 変更後の設定で**新規 quote** を取ると
`destination.*` の 3 件は成立しない（`quotable=false`）。
これを「拒否が FR-17 由来でない証拠」と解釈したが、**誤り**。
新規 quote が取れないことと、**既存 quote の purchase が FR-17 で拒否される**ことは別。

**正しい検証**: 指紋から `destination` を丸ごと外すと、**5 件が落ちる**
（`destination.{scheme,network,asset}` の 3 件＋既存の 2 件）。
→ **3 件とも FR-17 を実際に試験できている。**

**教訓**: 「テストが誤った理由で通っているか」は、
**probe を足して観察するより、守っている対象を壊して落ちるか見る**ほうが確実だった。
