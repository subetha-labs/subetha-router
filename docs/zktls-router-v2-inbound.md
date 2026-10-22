# zkTLS 秘匿購入: 受信レグを SubEtha V2（burn-sale）に載せる増分（v1.3、設計 v1）

**位置づけ**: `docs/zktls-router-requirements.md` v3.3（FR-Z13 は受信を x402 Base Sepolia USDC に限っていた）・`docs/zktls-router-design.md` v5.1 の上に載せる増分。V2 担当との協議の結果（`docs/zktls-router-open-items.md` §B-5〜§B-8）に基づく。要件・設計・タスクを 1 つにまとめる（小さな増分）。
owner の判断（2026-10-22）: **発行時点は accepted**（V1 と同じ。facilitator の `/settle` が receipt mined で成功を返した時点で Router は送信 credential を発行。設定の `policy: receipt` を運用者が明示）。token（zUSDC / zETH）は未決: 本増分は受信の network・資産を設定値として扱う。
V2 担当との合意: burn-sale（注文別 burn address）経路、routeBinding は Router 側で保持、identity は `/settle` 応答の `extra.eventId`（`<chainId>:<txHash>:<logIndex>`）、取消は発行前 `paid_undelivered` / 発行後 `unknown`、返金無し、通知は不要（同期の settle）。

## 0. 既にあるもの（変更しない前提）
- `src/adapters/inbound/subetha.ts`: SubEtha facilitator の HTTP 面（`/challenge → /verify → /settle`）に載る `InboundRail`。scheme `subetha-zerc20`、offer に `extra.{challengeNonce, expiresAt, routeBinding, fundsMoveOnCredential: true}`、`preflight` は credential の `accepted` が offer と全欄一致、`settle` は `success + transaction` で `settled`、`pending`/429/5xx/未確定の `errorReason` は `unknown`、4xx と `success:false` は `rejected`。hosted の静的 route（zUSDC）で受入済み。
- V2 facilitator は同じ HTTP 面で動く（V2 担当の T22 live）。`/challenge` の応答に `extra.{settlementKind: "zerc20-v2-burn-sale", policy: "receipt"}`、`/settle` の成功応答に `extra.{phase: "accepted", settlementKind, policy, deliveryKey, receiptLevel, txRef, eventId, logIndex}`（`eventId` は V2 側で実装・テスト済み。ローカル起動でも返る）。
- `src/core/private.ts` の発行予約: `inboundIdentity = ${sourceRail}|${network}|${txRef}|${eventId}`。x402 では `eventId` が無ければ `paid_undelivered/private_inbound_identity_missing`（FR-Z06 (b)）。
- 静的 route の `sourceRail` は省略で `subetha`（`src/main.ts` 579）。動的プロファイルの `sourceRail` は `x402 | mpp` のみ（`src/config.ts` 708、`DynamicProfile`）。`inboundRails["subetha"]` は env `ROUTER_SUBETHA_FACILITATOR_URL` の 1 つ。

## 1. 要件（増分）
- FR-V1 動的プロファイルの `sourceRail` に **`subetha`** を許す。受信 rail は既存の `inboundRails["subetha"]`（facilitator は env の 1 つ。プロファイルごとの URL は本増分では持たない）。`source.network`・`source.asset` は facilitator が `/challenge` で返す `chainId`・`token` と一致しなければ quote で `source_offer_mismatch`（既存の照合）。`source.payTo` は使わない（burn address は注文ごとに facilitator が決める）が、既存の型のため `0x0…0` 以外の EVM アドレスを置く（運用者アドレスの除外に使うだけ）。
- FR-V2 `private.profiles` の受信検査（`parsePrivate`）を「x402 Base Sepolia USDC」**または**「`subetha` で `source.network` が `eip155:11155111`、`source.asset` が `SUBETHA_ZERC20_ASSETS`（`src/shared/networks.ts`）の token」に広げる。他は `ConfigError`。
- FR-V3 `subetha` adapter の `settle`: 成功応答の `extra.eventId` を検査（`^\d+:0x[0-9a-f]{64}:\d+$`、chainId 部が offer の network、txHash 部が `transaction` と一致）して `SettleResult.eventId` に写す。形が違う・無い → `settled` だが `eventId` 無し（既存の静的 route の挙動は不変）。`extra.phase` が `accepted` 以外（`pending`）は既存どおり `unknown`。
- FR-V4 秘匿購入の発行予約: `sourceRail` が `subetha` のときも **`eventId` 必須**（無ければ `paid_undelivered/private_inbound_identity_missing`。未発行）。identity は `subetha|eip155:11155111|<burnTxHash>|<chainId>:<txHash>:<logIndex>`。
- FR-V5 quote の承認対象 `private.inbound`: `fundsMoveAt` を rail で分ける。x402 は従来の `router_purchase_settle_before_issuance`、subetha は **`payer_burn_before_credential`**（payer が burn を送ってから credential を作る = `fundsMoveOnCredential: true`。Router の settle は受領の確認）。MCP の説明文に「SubEtha 受信は credential を作る時点で資金が動く（burn）。承認は sign の前」を足す（既存の `npm run sign` の subetha 分岐の文言と同じ）。
- FR-V6 取消の記録: 発行後に Router が知り得る取消は無い（通知は要らない）。発行前の取消（settle が `rejected`/`unknown`）は既存どおり。本増分で新しい状態は作らない。
- FR-V7 Payer 側: 受信 credential は `{challengeNonce, burnTxHash}`（payer が z token を `payTo` へ transfer した tx）。**本 worktree には subetha の burn を送る payer 道具が無い**（`tools/subetha-payer.ts` と `source_claimed` は `task/subetha-hosted-inbound` の T2 以降。本 worktree の基点 f4eb0ca には T1 まで）。wire は試験の credential 生成（`tests/wire/subetha-inbound.test.ts` の `credentialFor` と同じ形）で行い、live の結合は **その branch の merge か、`tools/u01r-s3-inbound.ts` と同じ最小の burn 道具**を前提に別途段取りする（§5）。
- SR-V1 既存の x402 受信の秘匿購入・静的 route・journal の形は不変（golden）。`subetha` 受信は本増分では秘匿購入の**動的プロファイル**にだけ開く（通常の動的購入は対象外: `dynamic.ts` の受信レグは共有だが、`sourceRail: subetha` のプロファイルを `private.profiles` に挙げないと quote は `private_disabled`… ではなく通常の動的 quote として通ってしまうので、**`sourceRail: subetha` のプロファイルは `private.profiles` に含まれていなければ `ConfigError`**）。

## 2. 設計（変更点。最小）
| ファイル | 変更 |
|---|---|
| `src/config.ts` | `DynamicProfile.sourceRail: "x402" \| "mpp" \| "subetha"`、parse で `subetha` を許す（`source.payTo` は EVM アドレス必須のまま）。`parsePrivate`: FR-V2 の検査。`dynamic` 全体の検査: `sourceRail: subetha` のプロファイルは `private.profiles` に含まれること（SR-V1） |
| `src/main.ts` | `rails[\`${profile.sourceRail}:${profile.profileId}\`]` の解決（571）で `subetha` は `inboundRails["subetha"]` を返す。運用者アドレスの集合（494）に subetha プロファイルの `source.payTo` は**足さない**（burn address は注文ごとで、payTo は飾り）。`profileIdOfBinding` は不変 |
| `src/adapters/inbound/subetha.ts` | FR-V3（`eventId` の抽出と検査。他は不変） |
| `src/core/private.ts` | FR-V4（`eventId` 必須の条件を `sourceRail === "x402" \|\| "subetha"` に）、FR-V5（`fundsMoveAt`） |
| `src/core/dynamic.ts` | `sourceRail` の型。`fundsMoveOnCredential: profile.sourceRail === "mpp"` → `"mpp" \|\| "subetha"`（受信 offer の `extra.fundsMoveOnCredential` は adapter が `true` を返すので core 側の既定も合わせる） |
| `src/mcp/*`、`src/client/types.ts` | `private.inbound.fundsMoveAt` の列挙に `payer_burn_before_credential`、説明文 |
| `tests/fixtures/facilitator-server.ts` | V2 の形を返すモード（`challengeExtras` に `settlementKind`/`policy`、`/settle` の `extra` に `phase/eventId/logIndex/txRef`、`eventId` 欠落・形違いのモード） |
| `tests/wire/private-x402.test.ts`（または新規 `tests/wire/private-subetha.test.ts`） | lab 実バイナリで、受信 subetha（fixture facilitator）→ 発行 → MPC-TLS → attest → record → decrypt の全経路（HTTP）。否定: `eventId` 無し → `paid_undelivered/private_inbound_identity_missing`（未発行・容量解放）、`pending` → `unknown`、`rejected`、別 network の `eventId` → 未発行、同じ burn tx で 2 つ目の intent → 発行予約の衝突（FR-Z06 (b)）。journal の受信行に `eventId` |
| `tests/unit/private-config.test.ts`、`tests/unit/subetha-inbound*.test.ts` | FR-V2 の各 `ConfigError`、FR-V3 の抽出と拒否、`sourceRail: subetha` が `private.profiles` に無ければ `ConfigError`、golden 不変 |

承認対象（quote）の `private.inbound` は `{rail: "subetha", network, asset, payTo: <burn address = offer.payTo>, total, fee, fundsMoveAt: "payer_burn_before_credential"}`。burn address は quote ごとに違う（Payer は承認対象として読む）。

## 3. タスク
| # | 変更 | 受入 |
|---|---|---|
| T-V1 | `src/config.ts`、`src/main.ts`、`src/core/{private,dynamic}.ts`、`src/adapters/inbound/subetha.ts`、MCP/client の列挙 | 単体: config の各 `ConfigError`（subetha で network/資産違い、`private.profiles` に無い subetha プロファイル）、adapter の `eventId` 抽出（正・形違い・chainId 不一致・tx 不一致）、`private-core` の `eventId` 必須、`config-golden` 不変、既存 `subetha-inbound` wire 不変 |
| T-V2 | fixture の V2 モード、lab wire 1 ファイル | 上の全経路と否定 5 件（lab 無しは skip = 未検証） |
| T-V3 | 文書: 本書の実装記録、`docs/zktls-router-acceptance.md` に「受信 V2（burn-sale）」の節、`open-items` §B-9、Codex レビュー、commit | `npm test` の private 群、`npm run types`、golden |

## 4. 結合（B-3 の 3。本増分の後、owner と V2 担当と段取り）
- V2 facilitator をローカル起動（`run-v2-local.mjs`、port 4132、merchant は使い捨て鍵）。Router は `ROUTER_SUBETHA_FACILITATOR_URL=http://127.0.0.1:4132`（loopback の facilitator は hosted 設計の allowlist の扱い。`inboundLoopback` の能力で開く）。
- Payer 側の burn: 本 worktree に道具が無い（FR-V7）。選択肢: (a) `task/subetha-hosted-inbound` の `tools/subetha-payer.ts`（`npm run sign` の subetha 分岐）を merge、(b) `tools/u01r-s3-inbound.ts` と同じ最小の道具を秘匿購入の payer（`tools/private-payer.ts`）に足す。**owner の判断**（merge の順序）。
- token: owner 未決。zUSDC なら V2 側で burn-sale の live を先に 1 件。zETH なら Router の `par: true` が成り立たないので、受信額を「送信 1,000 atomic USDC に対する zETH の固定額」として運用者が決めるだけなら本増分の設定で足りる（換算は Router がしない。承認対象に両レグの額が出る）— これで十分かは **owner の判断**。
- 支払い範囲の記録・両レグの確認・合計の上限は受入 §9 と同じ。

## 5. 未解決
- receive code 宛 private send の注文 binding（zERC20 回答待ち）。
- settled 待ちの発行（(b)）は本増分に無い。
- 返金請求者の認証（Router 側の責任。対象外）。
