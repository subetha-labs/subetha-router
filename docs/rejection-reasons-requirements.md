# 要件: 拒否・不明の理由の分類を記録に残す（第 1 版、2026-10-15）

> owner の依頼（2026-10-15）: hosted の EVM testnet の検証（`docs/DEPLOY.md` §2g）で、受信の facilitator の拒否・Provider の拒否・宛先の `unknown` が間欠的に起き、どれも原因を確定できなかった（Router が理由を残していない）。「その形で進めましょう」= 拒否の理由の **分類** を journal に残し、次に起きたときに一度で判別できるようにする。
> 進め方は前例どおり: 要件 → 設計 → タスク → 実装 PR。各段で Codex（`gpt-6-astra`）の独立レビューと owner の確認。本番の入れ替えは owner の確認つき。

## 1. 背景（確かめた事実、`origin/main`）

| 事実 | 場所 |
|---|---|
| x402 受信の verify は 200 以外・形の違う応答を `isValid: false` にし、`invalidReason`・`error` は「facilitator の内部実装を転送しない」ために読まない | `src/adapters/inbound/x402.ts:340-346` |
| x402 受信の settle は 4xx・`success !== true` をすべて `source_rejected`、5xx・形の違いを `source_settle_unknown` にまとめる。HTTP のステータス・`errorReason` は残らない | `src/adapters/inbound/x402.ts:350-380` |
| x402 送信（動的 EVM・静的 Arc・SVM 共有）は Provider の応答のステータスで `rejected`・`unknown`・`paid_no_data` を分ける。ステータスの数字・x402 の理由は残らない | `src/adapters/outbound/x402-dynamic.ts:118-149` |
| 通信の失敗は固定の 7 分類（`TransportCode`: `destination_blocked`・`dns_failed`・`connect_failed`・`upstream_timeout`・`aborted`・`admission_refused`・`transport_failed`）で `report()` されるが、出力先は Router の子の stderr。本番の入口（`tools/remote-mcp.ts`）は子の stderr を転送しないので、本番では見えない | `src/net/guarded-fetch.ts:24-32`、`src/main.ts:540-567`、記憶: DEPLOY §2c |
| journal には `source_rejected`・`destination_pay_unknown` などの区分と時刻だけが残る（G-3・G-4 の調査で確認） | `src/core/orchestrator.ts:759-911`、`docs/DEPLOY.md` §2g |
| 自前の EVM facilitator（`tools/evm-facilitator.ts`）は settle の段（`submit_intent`・`submitted`・`settled` など）だけを log に出し、verify の失敗・RPC の失敗の分類を出さない | `tools/evm-facilitator.ts`（H-1 の確認） |

観測された原因不明の例: x402.org の受信の拒否（G-3 `dyn-x402-to-hyperevm`）、Provider A の拒否（G-3・G-4 `dyn-rh-to-x402`、G-5 `dyn-arc-to-x402`）、HyperEVM の Provider への支払いの 3.4 秒の `unknown`（G-4 `dyn-sol-to-hyperevm`）、Arc の Provider への 20 秒の `unknown`（G-4 `dyn-hyperevm-to-arc`）。

## 2. 機能要件（FR-R）

- **FR-R1 受信の理由の分類**: x402 受信（kind `x402`・`circle`、EVM・SVM）の verify と settle が `isValid: false`・`rejected`・`unknown` を返すとき、journal のその支払いの記録に **理由の分類** を残す: (a) facilitator の HTTP のステータス（数字）か、応答が無ければ通信の失敗の分類（`TransportCode`）、(b) 応答の JSON の `invalidReason`・`errorReason`（x402 v2 の規定の値の集合にあるときだけ、その値。集合に無い・形が違えば `other`）、(c) その段の経過時間（ms）。
- **FR-R2 宛先の理由の分類**: x402 送信（動的 EVM・静的・SVM）が `rejected`・`unknown`・`paid_no_data`・`not_sent` を返すとき、同じく (a) Provider の HTTP のステータスか通信の失敗の分類、(b) 応答の x402 の理由（`PAYMENT-RESPONSE` などの規定のヘッダ・本文の規定の欄で、規定の値の集合にあるときだけ）、(c) 経過時間、(d) どの段か（challenge の読み直し・支払いつきの要求・領収の検査）を残す。
- **FR-R3 MPP の経路**: Tempo・Solana の MPP の受信・送信も、上と同じ形で分類できるものを残す（RPC・facilitator の HTTP のステータス、通信の失敗の分類、規定の理由）。範囲は設計で決める（観測された失敗は x402 の経路が中心）。
- **FR-R4 本番で見える**: 通信の失敗の分類（`TransportEvent`）が本番でも残ること。Router の子の stderr の行（固定の欄の形）を入口が転送するか、journal に入れるかを設計で決める。
- **FR-R5 自前の facilitator**: verify の失敗（SDK の `invalidReason` を規定の値の集合で分類）と、RPC の失敗の分類（時間切れ・頻度制限（HTTP 429・JSON-RPC の limit のエラーコード）・その他）を log に出す。
- **FR-R6 読み方**: 運用者が paymentId から理由の分類を引ける手段（journal の該当行を読む道具か、既存の status の運用者向けの読み出し）を用意する。呼び出し側（MCP の `subetha_router_status`）に出すかは設計で決める（出すなら規定の値と数字だけ）。

## 3. 安全要件（SR-R）

- **SR-R1 外の文字列を残さない**: 相手（facilitator・Provider・RPC）が返した自由な文字列・本文・ヘッダの値・URL・エラーの message は記録・log に入れない。残すのは数字（ステータス・経過時間）と、こちらが定めた値の集合（規定の理由・`TransportCode`・段の名前）に当てはめた値だけ。集合に無いものは `other`。
- **SR-R2 秘密を残さない**: 鍵・署名・credential・`ownerKey`・facilitator の token・authorization の中身を残さない（既存の規則と同じ）。
- **SR-R3 結果を変えない**: 分類を足すだけで、`rejected`・`unknown`・`paid_no_data` などの結果の決め方、再試行しない規則、`unknown` の永続は変えない。分類に失敗しても結果は今と同じ。
- **SR-R4 journal の互換**: 分類の欄は追加の任意の欄。既存の journal（欄の無い行）はそのまま読める。journal の行の大きさに上限を置く。
- **SR-R5 本番の公開面**: 呼び出し側に出す場合も、上流の自由な文字列は出さない（動的上流の本文は「信頼しない第三者のデータ」という既存の扱いを崩さない）。

## 4. 受け入れ（AC-R）

- **AC-R1（unit）** 各 adapter の失敗の形（4xx・5xx・形の違う JSON・規定の理由・規定外の理由・時間切れ・接続の失敗）ごとに、journal に残る分類が期待どおりで、自由な文字列が入らないこと（規定外の理由は `other`）。結果（`outcome`・`reason`）は変更前と同じ。
- **AC-R2（unit）** journal の互換: 分類の欄の無い既存の行・有る行のどちらも読め、再起動で同じ状態に戻る。
- **AC-R3（wire）** 本番と同じ入口で、通信の失敗の分類が運用者の見える場所に出る（FR-R4）。
- **AC-R4（facilitator）** verify の失敗・RPC の頻度制限・時間切れが log に分類つきで出る。鍵・token は出ない。
- **AC-R5（本番、資金は動かない or 小額）** 配備の後、意図的に拒否される要求（例: 期限切れの quote・残高の足りない支払い手）で、journal に分類が残ることを確かめる。testnet の小額の支払いは owner の承認の範囲（2026-10-13）。

## 5. 範囲外

- 失敗の自動の再試行・迂回（x402.org の頻度制限を避ける待ちなど）。分類を見てから別の作業で決める。
- Provider A（他の持ち主のサービス）の側の記録。
- payer（`@subetha/payer`）の表示。

## 6. owner に決めてもらうこと

- **Q-1** 理由の分類を呼び出し側（MCP の status）にも出すか。既定案: **出さない**（運用者だけ。上流の情報を呼び出し側に流す範囲を広げない）。
- **Q-2** 本番の入れ替えの時刻（従来どおり、進行中の購入が無いときに数秒の停止）。
