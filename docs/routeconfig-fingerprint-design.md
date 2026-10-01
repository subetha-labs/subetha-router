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
