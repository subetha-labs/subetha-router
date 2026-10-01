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
