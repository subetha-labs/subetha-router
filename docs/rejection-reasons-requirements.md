# 要件: 拒否・不明の理由の分類を診断の記録に残す（第 2.1 版、2026-10-15）

> owner の依頼（2026-10-15）: hosted の EVM testnet の検証（`docs/DEPLOY.md` §2g）で、受信の facilitator の拒否・Provider の拒否・宛先の `unknown`・Tempo の署名の後の失敗が起き、どれも原因を確定できなかった（理由が残っていない）。「その形で進めましょう」= 拒否・不明の理由の **分類** を残し、次に起きたときに判別できるようにする。
> 進め方は前例どおり: 要件 → 設計 → タスク → 実装 PR。各段で Codex（`gpt-6-astra`）の独立レビューと owner の確認。本番の入れ替えは owner の確認つき。
> 第 1 版（`f221238`）は Codex R1 で APPROVE WITH CHANGES（8 件。§8）。第 2 版の主な変更: 分類は **支払いの journal に入れず、別の診断の記録** に残す（journal の互換・結果の確定に一切触れない）、理由の値の集合は Router が持つ版つきの完全一致の表、受信の verify の失敗（promotion の前）・領収の検査・送出しなかった失敗・署名の道具と driver の側を範囲に入れる、出来事ごとに「何が分かるか・分からないか」の表を受け入れにする。

## 1. 背景（確かめた事実、`origin/main`）

| 事実 | 場所 |
|---|---|
| x402 受信の verify（kind `x402`）は 200 以外・形の違う応答を `isValid: false` にし、応答の `isValid` 以外を読まない（コメントは `invalidMessage`・`error` を読まないと書く） | `src/adapters/inbound/x402.ts:336-346` |
| x402 受信の settle（kind `x402`）は送出の後の 4xx・`success !== true` を `source_rejected`、5xx・形の違い・network の違いを `source_settle_unknown` にまとめる。kind `circle` は送出の後の失敗を 4xx も含めて `unknown`（`source_settle_unknown`）にする。`403 registration_required` も結果は同じ `unknown` で、診断（報告）として `facilitator_trial_exhausted` を出すだけ | `src/adapters/inbound/x402.ts:350-404` |
| 動的プロファイルの受信の verify の失敗は promotion の前で、支払いの journal に行を書かずに `awaiting_payment` を返す | `src/core/dynamic.ts:624-640` |
| x402 送信は **領収を先に** 見る（`PAYMENT-RESPONSE`・`X-PAYMENT-RESPONSE`）: 整合した領収 ∧ 200 → 本文、整合 ∧ 200 以外 → `paid_no_data`、領収の `payer` 違い → `unknown`、領収なしで 2xx・5xx → `unknown`、4xx → `rejected`。領収なし・壊れた領収・失敗の領収・network 違いは区別されない。拒否の応答の本文は読まずに捨てる。送出しなかった失敗（`not_sent`）は手元の理由 | `src/adapters/outbound/x402-dynamic.ts:54-149,610-680` |
| 支払いの journal は区分（`source_rejected`・`destination_pay_unknown` など）・時刻のほか、識別子・結果・tx の参照・領収の参照・届いた本文を持つ。status の公開の射影は `terminalReason`・tx の参照・`receiptRef` を出す | `src/core/orchestrator.ts:176-203,759-911`、`src/core/journal.ts:278-285` |
| 通信の失敗は固定の 7 分類（`TransportCode`）で `report()` されるが、出力先は Router の子の stderr で、本番の入口は子の stderr を転送しない。`TransportEvent` に支払いの識別子は無い | `src/net/guarded-fetch.ts:24-43`、`src/main.ts:540-567`、`tools/remote-mcp.ts:522`、`tests/fixtures/loopback.ts:129` |
| 自前の EVM facilitator は settle の段・待ち行列・gas の上限・照合の分類を log に出すが、verify の失敗の理由と RPC の失敗の分類は出さない。本番は `SUBETHA_EVM_FACILITATOR_LOG` でボリュームのファイルに出す（それが無いと子の stderr で見えない） | `tools/evm-facilitator.ts:818-852,919-933,1747-1759`、`docs/DEPLOY.md` §2g |
| `@x402/core` 2.28.0 の型では `invalidReason`・`errorReason` は任意の **文字列**（規定の値の型は無い） | `node_modules/@x402/core/dist/esm/x402Client-*.d.mts`（Codex R1 #1） |
| Tempo の MPP の署名で送金した後の失敗（G-3）は Router の外: 署名の道具が `payAndCredential` を待ち、driver は stderr を捨て、想定外の例外を `"signing failed"` にまとめる | `tools/sign-run.ts:47`、`tools/evm-testnets-matrix.ts:682-690` |

## 2. 方針

- **診断の記録は支払いの journal と別**: 追記だけの診断の記録（行ごとの JSON。Router の子・自前の facilitator・署名の道具/driver がそれぞれ持つ）に残す。支払いの journal・status の射影・結果の決め方・再試行しない規則・`unknown` の永続には **触れない**。診断の記録が書けない・壊れていても、支払いは今どおりに進む（best effort、失敗は数えるだけ）。
- **残すのは分類だけ**: 数字（HTTP のステータス・経過時間・バイト数）と、Router が持つ版つきの値の集合に **完全一致** した値（前方一致・部分一致は使わない）。集合に無い値は `unrecognized`、欄が無ければ `absent`、形が違えば `malformed`。相手の自由な文字列・本文・ヘッダの値・URL・例外の message は残さない。

## 3. 機能要件（FR-R）

- **FR-R1 理由の値の集合**: Router が持つ版つきの表（x402 の `invalidReason`・`errorReason` の値、Circle の facilitator の既知の値、自前の facilitator の値）。出どころ（`@x402/core`・`@x402/evm`・`@x402/svm` の固定版の実装・Circle の文書）を表に書く。版を上げたら表を見直す。
- **FR-R2 受信**: x402 受信（kind `x402`・`circle`、EVM・SVM）の verify と settle が `isValid: false`・`rejected`・`unknown` になるとき、(a) facilitator の HTTP のステータスか通信の失敗の分類（`TransportCode`）、(b) 応答の理由の分類（FR-R1）、(c) 段（verify・settle）、(d) 経過時間、(e) 結びつけの鍵（paymentId があればそれ、promotion の前の動的の verify なら quoteId・requestId と段）を残す。promotion の前の失敗も残すが、購入を promotion しない・予算を予約しない。
- **FR-R3 宛先**: x402 送信（動的 EVM・静的・SVM）が `rejected`・`unknown`・`paid_no_data`・`not_sent` になるとき、(a) 段（challenge の読み直し・支払いつきの要求・領収の検査・本文の読み取り）、(b) HTTP のステータス **と** 本文の読み取りの通信の失敗の分類（両方あり得る）、(c) 領収の分類（`absent`・`malformed`・`failed`・`network_mismatch`・`payer_mismatch`・`ok`。どちらのヘッダを使ったか。読む順と大きさの上限は設計で決める）、(d) 拒否の応答の本文の x402 の理由（規定の欄だけを、大きさと時間の上限つきで。**結果が決まった後に** 読み、結果を遅らせない・変えない）、(e) `not_sent` は手元の理由の分類、(f) 経過時間、(g) paymentId と attempt。
- **FR-R4 MPP の経路**: Tempo・Solana の MPP の受信・送信も、同じ形で分類できるもの（RPC・facilitator の HTTP のステータス、通信の失敗の分類、規定の理由）を残す。範囲は設計で決める。
- **FR-R5 本番で見える場所**: Router の子の診断の記録はボリュームのファイル（本番の journal と同じボリューム）。通信の失敗の分類（`TransportEvent`）は、どの支払い・どの段の要求かを結びつけて診断の記録に入れる（stderr の転送だけでは支払いと結びつかない）。
- **FR-R6 自前の facilitator**: verify の失敗の理由（SDK の `invalidReason` を FR-R1 で分類）と、RPC の失敗の分類（時間切れ・頻度制限（HTTP 429・JSON-RPC の限度のエラー）・その他）を log に出す。結びつけの鍵は、診断用に別に作る hash の識別子（network・資産・from・nonce から作る。既存の `key` は nonce をそのまま含むので診断には出さない。SR-R2）。Router の側の宛先の診断にも同じ識別子を出し、両方を結びつける。
- **FR-R7 署名の道具と driver**: 署名の道具（`npm run sign` の本体）と行列の driver が、署名の段の失敗を分類して残す（どの段で失敗したか、送金が送出されたか分かるか、tx の参照があればそれ）。資金が動き得る段の後の失敗は今どおり「再署名しない」を保ち、送金の tx が分かればそれを証跡に残す。
- **FR-R8 読み方**: 運用者が paymentId（promotion の前は quoteId）から、Router・facilitator・driver の診断を並べて引ける道具（読むだけ）。呼び出し側（MCP の status）には出さない（§7 Q-1 の既定）。

## 4. 安全要件（SR-R）

- **SR-R1 新しい診断に外の文字列を入れない**（§2）。既存の公開の欄（`terminalReason`・tx の参照・`receiptRef`）は今のまま（この件では変えない。既存の例外として明記）。
- **SR-R2 秘密を残さない**: 鍵・署名・credential・`ownerKey`・facilitator の token・authorization の中身・支払いのヘッダの値を残さない。
- **SR-R3 結果と通信を変えない**: 分類は既に決まった結果の後に作る。外への要求の数・順序・期限は変えない（本文の理由を読む場合も、結果が決まった後、上限つき、失敗は無視）。
- **SR-R4 上限**: 診断の 1 行の大きさ・1 支払いあたりの行数・ファイルの大きさに上限（超えたら捨てて数える）。診断の記録の失敗・上限の超過は支払いの記録を妨げない。
- **SR-R5 公開しない**: 診断の記録は運用者だけが読む（ボリュームのファイル、公開の MCP・HTTP からは読めない）。

## 5. 受け入れ（AC-R）

- **AC-R1（unit）** 各 adapter・段・失敗の形（4xx・5xx・形の違う JSON・規定の理由・規定外の理由・欄なし・時間切れ・接続の失敗・本文の読み取りの失敗・領収の各分類・`not_sent`）ごとに、診断の行が期待どおりで、自由な文字列が入らない。**結果（`outcome`・`reason`）と外への要求の数は変更前と同じ**（同じ入力で前後を比べる）。
- **AC-R2（unit）** 診断の記録の失敗（書けない・上限超え・壊れた行）で支払いの結果・journal が変わらない。再起動で journal から同じ状態に戻る（診断の記録は読まない）。
- **AC-R3（unit）** promotion の前の動的の verify の失敗が、予算を予約せず、promotion もせず、quoteId で引ける診断を残す。
- **AC-R4（wire）** 本番と同じ入口で、診断の記録がボリュームのファイルに出る。公開の MCP の status・reopen の結果に診断が出ない。
- **AC-R5（facilitator・署名の道具・driver）** facilitator の verify の失敗・RPC の頻度制限・時間切れ、署名の道具の段の失敗が分類つきで残る。鍵・token は出ない。
- **AC-R6（出来事の表）** §1 の 5 つの出来事それぞれについて、「次に起きたら診断に何が残るか」と「それでも分からないこと（上流の内部の原因など）」を表にし、試験の fixture でその行が出ることを確かめる:

  | 出来事 | 残るもの | それでも分からないこと |
  |---|---|---|
  | x402.org の受信の拒否 | settle の HTTP のステータス、`errorReason` の分類、経過時間 | x402.org の内部の理由（集合に無ければ `unrecognized`） |
  | Provider A の拒否 | 支払いつきの要求のステータス、領収の分類、本文の x402 の理由（あれば） | Provider A の内部（理由を返さなければ `absent`） |
  | HyperEVM の Provider への 3.4 秒の `unknown` | ステータス・領収の分類。要求が自前の facilitator に届いて記録された場合だけ、その verify の失敗の理由・RPC の分類（診断用の識別子で結びつく） | Provider の Worker の内部、Worker が facilitator を呼ぶ前に失敗した場合の理由 |
  | Arc の Provider への 20 秒の `unknown` | 実際に観測した通信の失敗の分類（経過時間から推定しない）またはステータス、経過時間 | Circle の facilitator の内部の段 |
  | Tempo の署名の後の失敗 | 署名の道具の段の分類、送金の tx（分かれば） | RPC の内部の理由 |

- **AC-R7（本番）** 配備の後、制御した失敗（例: 拒否を返す試験用の上流の URL への動的の購入、残高の足りない支払い手）で、診断の行が出ることを確かめる。期限切れの quote だけでは facilitator の診断を通らないので、それだけにしない。testnet の小額の支払いは owner の承認の範囲（2026-10-13）。

## 6. 範囲外

- 失敗の自動の再試行・迂回（x402.org の頻度制限を避ける待ちなど）。診断を見てから別の作業で決める。
- Provider A（他の持ち主のサービス）の側の記録。
- payer（`@subetha/payer`）の表示。
- 既存の公開の欄（`receiptRef` の生の値など）の見直し。

## 7. owner に決めてもらうこと

- **Q-1** 理由の分類を呼び出し側（MCP の status）にも出すか。既定案: **出さない**（運用者だけ）。
- **Q-2** 本番の入れ替えの時刻（従来どおり、進行中の購入が無いときに数秒の停止）。

## 8. 独立レビューの記録

- **R1（Codex `gpt-6-astra`、CLI read-only、第 1 版 `f221238`）: APPROVE WITH CHANGES**（8 件）と反映:
  1. high — 「x402 v2 の規定の値」は実装できる参照ではない（SDK では文字列）→ FR-R1 の版つきの表、完全一致、`absent`・`malformed`・`unrecognized`。
  2. medium — §1 の事実の誤り・言い過ぎ（verify のコメント、Circle の写像、領収が先、journal の中身、facilitator の既存の log）→ §1 を訂正。
  3. high — promotion の前の動的の verify の失敗は journal に書く場所が無い → FR-R2(e)、AC-R3、診断の記録を journal と別に（§2）。
  4. high — 領収・本文の診断の安全と優先の規則 → FR-R3(b)〜(e)、SR-R3。
  5. high — Tempo の署名の後の失敗は Router の外 → FR-R7、AC-R5。
  6. medium — 「次は判別できる」は言い過ぎ → AC-R6 の出来事の表（分からないことを含む）、facilitator の log を本番のファイルに、結びつけの鍵。
  7. high — journal の上限と互換・結果の確定の衝突 → 診断を journal と別にし（§2）、SR-R4・AC-R2。
  8. medium — 既存の公開の欄 → SR-R1 で既存の例外として明記、AC-R4 で status・reopen に出ないこと。AC-R7 に制御した上流の失敗。
- **R2（readback、第 2 版）: APPROVE WITH CHANGES**。R1 の 8 件のうち 6 件は解決。残りと新しい点を第 2.1 版で反映: Circle の `403` の結果は `unknown` のまま（診断の値だけ）、facilitator の結びつけは既存の `key`（nonce をそのまま含む）ではなく診断用の hash の識別子、出来事の表は「facilitator に届いて記録された場合だけ」「観測した分類で、経過時間から推定しない」。
