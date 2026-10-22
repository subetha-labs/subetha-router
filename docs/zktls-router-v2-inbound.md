# zkTLS 秘匿購入: 受信レグを SubEtha V2（burn-sale）に載せる増分（v1.3、設計 v2）

**位置づけ**: `docs/zktls-router-requirements.md` v3.3（FR-Z13 は受信を x402 Base Sepolia USDC に限っていた）・`docs/zktls-router-design.md` v5.1 の上に載せる増分。V2 担当との協議の結果（`docs/zktls-router-open-items.md` §B-5〜§B-8）に基づく。要件・設計・タスクを 1 つにまとめる（小さな増分）。
設計 v1 の Codex レビュー（`.claude_workflow/local/zktls-v2in-design-review1.md`、REJECT、blocking 4・should 4）を v2 に反映した（§6）。
owner の判断（2026-10-22）: **発行時点は accepted**（V1 と同じ。facilitator の `/settle` が receipt mined で成功を返した時点で Router は送信 credential を発行。設定の `policy: receipt` を運用者が明示）。token（zUSDC / zETH）は未決: 本増分は受信の network・資産を設定値として扱う。
V2 担当との合意: burn-sale（注文別 burn address）経路、routeBinding は Router 側で保持、identity は `/settle` 応答の `extra.eventId`（`<chainId>:<txHash>:<logIndex>`）、settle の失敗は FR-V3 の結果の表のとおり（発行後の取消は Router は観測しない）、返金無し、通知は不要（同期の settle）。

## 0. 既にあるもの（変更しない前提）
- `src/adapters/inbound/subetha.ts`: SubEtha facilitator の HTTP 面（`/challenge → /verify → /settle`）に載る `InboundRail`。scheme `subetha-zerc20`、offer に `extra.{challengeNonce, expiresAt, routeBinding, fundsMoveOnCredential: true}`、`preflight` は credential の `accepted` が offer と全欄一致、`settle` は `success + transaction` で `settled`、`pending`/429/5xx/未確定の `errorReason` は `unknown`、4xx と `success:false` は `rejected`。hosted の静的 route（zUSDC）で受入済み。
- V2 facilitator は同じ HTTP 面で動く（V2 担当の T22 live）。`/challenge` の応答に `extra.{settlementKind: "zerc20-v2-burn-sale", policy: "receipt"}`、`/settle` の成功応答に `extra.{phase: "accepted", settlementKind, policy, deliveryKey, receiptLevel, txRef, eventId, logIndex}`（`eventId` は V2 側で実装・テスト済み。ローカル起動でも返る）。
- `src/core/private.ts` の発行予約: `inboundIdentity = ${sourceRail}|${network}|${txRef}|${eventId}`。x402 では `eventId` が無ければ `paid_undelivered/private_inbound_identity_missing`（FR-Z06 (b)）。
- 静的 route の `sourceRail` は省略で `subetha`（`src/main.ts` 579）。動的プロファイルの `sourceRail` は `x402 | mpp` のみ（`src/config.ts` 708、`DynamicProfile`）。`inboundRails["subetha"]` は env `ROUTER_SUBETHA_FACILITATOR_URL` の 1 つ。

## 1. 要件（増分）
- FR-V1 動的プロファイルの `sourceRail` に **`subetha`** を許す。受信 rail は既存の `inboundRails["subetha"]`（facilitator は env の 1 つ。プロファイルごとの URL は本増分では持たない）。`source.network`・`source.asset` は facilitator が `/challenge` で返す `chainId`・`token` と一致しなければ quote で `source_terms_mismatch`（既存の照合）。`source.payTo` は使わない（burn address は注文ごとに facilitator が決める）: 既存の型のため EVM アドレスを置くが、**運用者アドレスの集合には入れない**（`main.ts` と私的 x402/MPP adapter の 3 箇所）。表との照合（`validateRouterConfigAgainstTable`）は subetha 受信を `SUBETHA_ZERC20_ASSETS`（network・token・桁）で見る。
- FR-V2 `private.profiles` の受信検査（`parsePrivate`）を「x402 Base Sepolia USDC」**または**「`subetha` で `source.network`・`source.asset` が `SUBETHA_ZERC20_ASSETS`（`src/shared/networks.ts`。今は Sepolia の zUSDC だけ）の行」に広げる。他は `ConfigError`。**zETH は表に無いので本増分では受けない**（受けるには資産表と価格規則の増分が要る。§4）。quote は `/challenge` の `extra.settlementKind === "zerc20-v2-burn-sale"` を要求し、違えば（V1 facilitator など）`source_terms_mismatch/settlement_kind`（V1 は `eventId` を返さないので発行できない）。
- FR-V3 `subetha` adapter の `settle`: (a) credential の `payload.burnTxHash` があれば（64 hex でなければ、または）`transaction` と同じ tx でなければ **`unknown`**（別の tx の決済をこの credential の決済と確定しない）; (b) 成功応答の `extra.eventId` を検査して `SettleResult.eventId` に写す。実装の契約: `^([1-9][0-9]{0,15}):(0x[0-9a-fA-F]{64}):(0|[1-9][0-9]{0,9})$`（先頭 0 無し）、chainId 部が offer の network（`eip155:<chainId>`）と一致、txHash 部が `transaction` と大小文字を無視して一致。写す値は hash を**小文字に正準化**したもの。`txRef` も hex なら小文字に正準化する（同じ tx の表記違いで受信 identity が割れない）。申告の `burnTxHash` が **無い**（legacy の permit 経路）ときは `settled` だが `eventId` は出さない（秘匿購入は credential と tx の束縛を要求する: 発行しない）。`burnTxHash` が空文字・非文字列・形違いなら `unknown`。形が違う `eventId`・無い `eventId` → `settled` だが `eventId` 無し（静的 route の挙動は不変）。`/challenge` の `extra.settlementKind` は offer の `extra` に写す（V1 は無い）。**信頼の境界**: `eventId` の安定性（同じ nonce → 同じ logIndex、1 つの tx は 1 つの challenge にだけ割り当て）は facilitator の契約（V2 担当の回答）に依存する。異なる intent が同じ burn tx を使う重複は Router の受信 identity（FR-V4）で止まるが、facilitator が同じ tx に別の logIndex を返せば別の identity になる（この前提は V2 側の台帳に置く。Router 側で検出しない）。
- 結果の表（`subetha` 受信の秘匿購入。settle 以降）:

| facilitator の応答 | adapter | core（秘匿購入） |
|---|---|---|
| 200 `success: true` + `transaction` = 申告 burn + `extra.eventId` 正 | `settled` + `eventId` | 発行予約 → 発行 → 引き渡し |
| 同上だが `eventId` 無し・形違い（V1 facilitator など） | `settled`（`eventId` 無し） | `paid_undelivered/private_inbound_identity_missing`（受信は成立、未発行。既存の x402 と同じ） |
| `transaction` ≠ 申告 burn | `unknown/source_settle_unknown` | 耐久の `unknown`（既存。`rejected` にしない） |
| `extra.phase: pending` / `success:false` + `pending_burn` / 429 / 5xx | `unknown` | 耐久の `unknown` |
| 4xx / `success:false` + 確定的な理由 | `rejected` | **耐久の `unknown`**（動的購入は昇格後の settle 失敗をすべて `unknown` にする。`paid_undelivered` ではない） |
| 発行後の取消（reorg / screening-rejected） | （通知は無い） | **Router は観測しない**。journal には何も増えない。送信レグの状態は発行時のまま（`unknown` ではなく、通常は `delivered_private` か attest 待ち）。取消の把握は V2 側の `/admin/payments/:nonce` か両チェーンの読取による（§4） |
- FR-V4 秘匿購入の発行予約: `sourceRail` が `subetha` のときも **`eventId` 必須**（無ければ `paid_undelivered/private_inbound_identity_missing`。未発行）。identity は `subetha|eip155:11155111|<burnTxHash>|<chainId>:<txHash>:<logIndex>`。同じ burn tx を別の intent の credential に載せても `private_issuance_duplicate`（`unknown`、未発行）。
- FR-V5 quote の承認対象 `private.inbound`: `fundsMoveAt` を rail で分ける。x402 は従来の `router_purchase_settle_before_issuance`、subetha は **`payer_burn_before_credential`**（payer が burn を送ってから credential を作る = `fundsMoveOnCredential: true`。Router の settle は受領の確認）。`private.inbound.payTo` は**注文ごとの burn address**（受信 offer の `payTo`）。quote の `disclosures.fundsMoveOnCredential`、status の射影 `dynamic.fundsMoveOnCredential`（`orchestrator.ts`）も subetha で `true`（容量不足で `awaiting_payment` に戻っても「payer は既に burn 済みかもしれない」と読める。**FR-Z27 の「資金を動かさない」は Router の settle についてであり、burn-sale では容量の判定より前に payer の burn が済んでいる**）。MCP の説明文に同じ趣旨を足す。承認は burn の前（外部の harness で transfer する場合も同じ）。
- FR-V6 取消: 発行後に Router が知り得る取消は無い（通知は要らない。上の表のとおり**観測しない**）。発行前の失敗は上の表。本増分で新しい状態は作らない。
- FR-V7 Payer 側: 受信 credential は `{challengeNonce, burnTxHash}`（payer が z token を `payTo` へ transfer した tx）。**本 worktree には subetha の burn を送る payer 道具が無い**（`tools/subetha-payer.ts` と `source_claimed` は `task/subetha-hosted-inbound` の T2 以降。本 worktree の基点 f4eb0ca には T1 まで）。wire は試験の credential（`{challengeNonce, burnTxHash: 64 hex}`。fixture は tx を検証しない = synthetic）で行い、live の結合は V2 側の harness `pos-pay`（open-items §B-9）か `tools/u01r-s3-inbound.ts` と同じ最小の burn 道具を前提に別途段取りする（§4）。
- SR-V1 既存の x402 受信の秘匿購入・静的 route・journal の形は不変（golden）。`subetha` 受信は秘匿購入の口にだけ開く。3 段で止める: (i) 設定: `sourceRail: subetha` のプロファイルは `private.profiles` に含まれていなければ `ConfigError`; (ii) **通常の動的 quote の入口**（`dynamicCore.quote`、I/O の前）で `sourceRail === "subetha"` を `private_only_profile`（HTTP 404）で拒む; (iii) 防御として purchase でも、秘匿の記録でない intent が subetha プロファイルを指せば I/O の前に `rejected/private_only_profile`。

## 2. 設計（変更点。最小）
| ファイル | 変更 |
|---|---|
| `src/config.ts` | `DynamicProfile.sourceRail: "x402" \| "mpp" \| "subetha"`、parse で `subetha` を許す（`source.payTo` は EVM アドレス必須のまま）。`parsePrivate`: FR-V2 の検査。`dynamic` 全体の検査: `sourceRail: subetha` のプロファイルは `private.profiles` に含まれること（SR-V1） |
| `src/main.ts` | `rails[\`${profile.sourceRail}:${profile.profileId}\`]` の解決（571）で `subetha` は `inboundRails["subetha"]` を返す。運用者アドレスの集合（494）に subetha プロファイルの `source.payTo` は**足さない**（burn address は注文ごとで、payTo は飾り）。`profileIdOfBinding` は不変 |
| `src/adapters/inbound/subetha.ts` | FR-V3（`eventId` の抽出と検査。他は不変） |
| `src/core/private.ts` | FR-V4（`eventId` 必須の条件を `sourceRail === "x402" \|\| "subetha"` に）、FR-V5（`fundsMoveAt`） |
| `src/core/dynamic.ts` | `sourceRail` の型。`fundsMoveOnCredential: "mpp" \|\| "subetha"`。通常の quote の入口と purchase で `private_only_profile`（SR-V1 (ii)(iii)） |
| `src/core/orchestrator.ts`、`src/http/projection.ts`、`src/mcp/server.ts` | 射影・quote の `fundsMoveOnCredential` を subetha で `true`、固定コード `private_only_profile`（`SAFE_REASONS`、`DYNAMIC_QUOTE_STATUS` 404、診断の code）、MCP の説明文 |
| `src/adapters/outbound/private-{x402,mpp}.ts` | 運用者の集合に subetha プロファイルの `source.payTo` を入れない |
| `src/mcp/*`、`src/client/types.ts` | `private.inbound.fundsMoveAt` の列挙に `payer_burn_before_credential`、説明文 |
| `tests/fixtures/facilitator-server.ts` | `--v2 on`: challenge の `extra.{settlementKind, policy}`、注文ごとの burn address（nonce から決定的に）、settle は credential の `burnTxHash`（64 hex）が無ければ 400、あれば `transaction = burnTxHash` と `extra.{phase, settlementKind, policy, deliveryKey, receiptLevel, txRef, eventId, logIndex}`（同じ nonce は同じ logIndex）。`--v2-event none\|bad-chain\|bad-tx\|changed`、`--v2-tx mismatch` |
| `tests/wire/private-x402.test.ts` | lab 実バイナリで、受信 subetha（fixture facilitator `--v2 on`、plain HTTP を dial で loopback へ）→ 発行 → MPC-TLS → attest → record → decrypt の全経路（HTTP）: 承認対象の `inbound.payTo` が注文ごとの burn address、`fundsMoveAt`、`disclosures.fundsMoveOnCredential`、journal の `source_settled` に `eventId`、発行予約の identity、status の `dynamic.fundsMoveOnCredential`、canary。否定: 通常の動的 quote は 404 `private_only_profile`、同じ burn tx の 2 つ目の intent は `unknown/private_issuance_duplicate`（bearer を返さない）、`eventId` を返さない facilitator（別 world）は `paid_data_unavailable/private_inbound_identity_missing`（未発行、作業ディレクトリ無し） |
| `tests/unit/private-config.test.ts`、`tests/unit/dynamic-core.test.ts`、`tests/unit/private-core.test.ts`、`tests/wire/subetha-inbound.test.ts` | config: subetha + zUSDC は通る、別資産・allowlist 外・`private` 無しは `ConfigError`; dynamic-core: subetha プロファイルの通常 quote は接続 0 で `private_only_profile`; private-core: `settlementKind` 無し → `source_terms_mismatch/settlement_kind`、承認対象と射影、通常 quote の拒否、`pay_to_conflict`、`eventId` 無しは未発行（発行 0 回）、identity の形; adapter（fixture の V2 モード）: `settlementKind`・注文ごとの payTo・`eventId`（再 settle でも同値）、`none/bad-chain/bad-tx` は `eventId` 無し、`transaction` 不一致は `unknown`、burnTxHash 無し/形違いは `rejected`、V1 の形は不変。golden 不変 |

承認対象（quote）の `private.inbound` は `{rail: "subetha", network, asset, payTo: <burn address = offer.payTo>, total, fee, fundsMoveAt: "payer_burn_before_credential"}`。burn address は quote ごとに違う（Payer は承認対象として読む）。

## 3. タスク
| # | 変更 | 受入 |
|---|---|---|
| T-V1 | `src/config.ts`、`src/main.ts`、`src/core/{private,dynamic}.ts`、`src/adapters/inbound/subetha.ts`、MCP/client の列挙 | 単体: config の各 `ConfigError`（subetha で network/資産違い、`private.profiles` に無い subetha プロファイル）、adapter の `eventId` 抽出（正・形違い・chainId 不一致・tx 不一致）、`private-core` の `eventId` 必須、`config-golden` 不変、既存 `subetha-inbound` wire 不変 |
| T-V2 | fixture の V2 モード、lab wire 1 ファイル | 上の全経路と否定 5 件（lab 無しは skip = 未検証） |
| T-V3 | 文書: 本書の実装記録、`docs/zktls-router-acceptance.md` に「受信 V2（burn-sale）」の節、`open-items` §B-9、Codex レビュー、commit | `npm test` の private 群、`npm run types`、golden |

## 4. 結合（B-3 の 3。本増分の後、owner と V2 担当と段取り）
- （**履歴**。下の owner の判断で (a) に確定）V2 facilitator をローカル起動（`run-v2-local.mjs`、port 4132、merchant は使い捨て鍵）。**前提**: Router の実合成（`src/main.ts`）は subetha 受信の transport で loopback を拒む（`capabilities.fixtureFacilitators` は試験専用の能力で、hosted の origin 固定の allowlist ではない）。同一ホストでの結合は (a) 試験基盤の Router 子（`tests/fixtures/private/router-private-process.ts` と同じ能力注入。transport は試験の差し替え = **synthetic transport**、Router の build と facilitator は実物）で行うか、(b) V2 facilitator を loopback 以外のホスト名・アドレス（別ホストやトンネル）で公開して実合成で行う。(a) の結果は「transport が synthetic」と明記する。**owner の判断**。
- （**履歴**。下の owner の判断で (a) に確定、§9 で実装済み）Payer 側の burn: 本 worktree に道具が無い（FR-V7）。選択肢: (a) V2 側の harness `pos-pay`（open-items §B-9）で transfer し tx hash を受け取る → `tools/private-payer.ts` に `--burn-tx-hash`（subetha 受信の quote だけ。credential を `{challengeNonce, burnTxHash}` で組む）を足す、(b) `task/subetha-hosted-inbound` の `tools/subetha-payer.ts` を merge。**owner の判断**。
- （**履歴**。下の owner の判断で zUSDC に確定。ただし V2 の zUSDC は表に無い: 次の箇条）token: owner 未決。**zUSDC**なら本増分の設定で載る（V2 側で burn-sale の live を先に 1 件）。**zETH は本増分では載らない**（`SUBETHA_ZERC20_ASSETS` に無い。Router の `par: true` と `priceOf` の 1:1 換算は zETH の額を表せない）: 資産表と価格規則の別の増分が要る。
- 支払い範囲の記録・両レグの確認・合計の上限は受入 §9 と同じ。
- **owner の判断（2026-10-22、「その形で進めて良い」）**: 発行時点は accepted（V2 担当は owner 本人から直接確認済み）、token は **zUSDC**、payer の burn は **(a) V2 harness `pos-pay-token` + 本 worktree の `--burn-tx-hash`**（§9）、transport は **(a) 試験基盤の Router 子（synthetic transport）** で最初の 1 件（Router の実合成は loopback に加えて private range（10/8・172.16/12・192.168/16）と自ホストのアドレスも拒むので、同一マシンでの「非 loopback 公開」は公開到達可能なトンネルが要る。実 transport は後の増分）。
- **V2 の zUSDC は V1 と別 deployment**（V2 担当の live 2026-10-22: `/challenge` の `token` = `0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f`、V1 の表の行は `0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF`）。`SUBETHA_ZERC20_ASSETS` に無い token は設定の検査で起動時に拒まれる（FR-V2）ので、結合の前に **その行を表に足す増分**（decimals・上限は V1 と同じ 6 / 20,000 atomic。V2 担当の確認待ち）が要る。

## 5. 未解決
- receive code 宛 private send の注文 binding（zERC20 回答待ち）。
- settled 待ちの発行（(b)）は本増分に無い。
- 返金請求者の認証（Router 側の責任。対象外）。

## 6. 設計 v1 → v2（Codex レビュー 1 回目、REJECT）
| 指摘 | 対応 |
|---|---|
| 1 設定だけでは通常の動的購入を排除できない | SR-V1 を 3 段に: 設定 + 通常 quote の入口で I/O 前に `private_only_profile` + purchase の防御。試験（dynamic-core・private-core・wire） |
| 2 status 側の開示（`orchestrator.ts` の `fundsMoveOnCredential`）、FR-Z27 の文言 | FR-V5: 射影・quote の disclosures・MCP の説明。burn-sale では容量判定より前に payer の burn が済んでいることを明記 |
| 3 identity と申告 burn の束縛、logIndex の安定性 | FR-V3 (a): `transaction` ≠ 申告 burn → `unknown`。安定性は facilitator の契約（信頼の境界）として明記。同一 burn の別 intent は FR-V4 で拒否（試験） |
| 4 loopback facilitator の前提 | §4: `fixtureFacilitators` は試験能力。結合は試験基盤の子（synthetic transport）か非 loopback の公開 |
| 5 zETH は設定で表せない | FR-V2・§4: zETH は本増分では受けない（資産表と価格規則の別増分） |
| 6 運用者集合の除外が不完全、burn address = Provider payTo | `main.ts` と私的 x402/MPP adapter の 3 箇所で除外。quote で同じ network・資産の `payTo` 一致は `quote_failed/pay_to_conflict` |
| 7 取消と phase の意味 | FR-V3 の結果の表（`rejected` は耐久の `unknown`、発行後の取消は観測しない、`phase: pending` だけが特別） |
| 8 fixture と試験 | V2 モード（burnTxHash 必須、決定的な tx・eventId、注文ごとの burn address）、§2 の試験一覧 |

## 7. 実装の記録（2026-10-22。作者の実行結果。独立レビューは静的）
実装は §2 のとおり（`src/client/types.ts` の `fundsMoveAt` は構造化されていない値のままなので列挙の変更は無い）。型チェック通過。作者の実行: lab wire（受信 V2 fixture → 発行 → MPC-TLS → attest → record → 復号、二重 burn の拒否、`eventId` 無しの未発行、通常 quote の拒否）pass、回帰（unit 全部 + inbound/dynamic/private の wire）2,393 pass / 既知の macOS flake 2 件。これは **synthetic の受信証跡**（fixture facilitator は burn を検証しない）であり、live の burn・決済の確定・実合成 transport の証跡ではない。Router の `src/private/*`・Verifier・attest の検査は変更していない。

## 8. 設計 v2 + 実装 → レビュー 2 回目（REJECT、High 2・Medium 1・Low 1）への対応
| 指摘 | 対応 |
|---|---|
| 1 `txRef` の大小文字で受信 identity が割れる | adapter で hex の `transaction` を小文字に正準化（`eventId` の hash も）。fixture `--v2-tx upper` で試験 |
| 2 申告の burn 無しでも eventId が出て発行に至る | 申告が無ければ `eventId` を出さない（legacy は `settled` のまま、秘匿購入は未発行）。空文字・非文字列・形違いは `unknown`。fixture `--v2-claim lenient` で adapter の境界を試験 |
| 3 試験の不足 | 通常の記録が subetha プロファイルを指す purchase の防御（dynamic-core、接続 0）、再起動後の同じ burn tx の別 intent（private-core）、`changed` logIndex の信頼の境界（adapter）、上の 1・2 |
| 4 文書の矛盾・過剰 | 冒頭の取消の文、FR-V3 の実装どおりの契約、§7 の限定（client の列挙は無し、作者の実行結果、synthetic の証跡） |
| レビュー 3 回目（APPROVE WITH CHANGES、残り = 試験の網羅）: 別 intent の大文字 hex 申告、同時の二重、再起動後の開示 | wire の 2 つ目の intent は同じ burn を大文字で申告（同じ identity で `private_issuance_duplicate`）、private-core に同時 purchase（発行は 1 回、片方は duplicate）と再起動後の `fundsMoveOnCredential` の保持。intent は呼ぶたびに別（order_id）にして受信 identity の一意性と区別 |

## 9. 増分 v1.3.1（2026-10-22）: payer 道具 `--burn-tx-hash`（FR-V7 の (a)）
Router には何も足さない。`tools/private-payer.ts` だけ。

- **FR-P1 受信の指定**: `--inbound-network <net> --inbound-asset <token> --inbound-max-total <atomic>`（3 つ組。既定は Base Sepolia USDC、x402）。封筒の `inbound` に写す（Router 側は FR-Z 系の intent 検査でプロファイルと照合）。
- **FR-P2 鍵の要否**: x402 受信（既定）は従来どおり `SUBETHA_PAYER_PRIVATE_KEY` 必須。subetha 受信（`--inbound-network/--inbound-asset` が Base Sepolia USDC 以外）は鍵を要求しない（credential に署名は無い）。
- **FR-P3 quote の出力**: 受信が `private.inbound.fundsMoveAt = payer_burn_before_credential` なら、stdout の `quoted` に `payFirst = { payTo（注文別 burn address）, amount（atomic）, network, asset }` を出す（人がこれを V2 側の支払い道具に渡す）。`quote.json` は従来どおり承認対象の全体。
- **FR-P4 承認**: 同じ `--out` に `--approve --burn-tx-hash 0x<64 hex>`。**latch の前**に、再開点の quote の `source.offer.scheme` を権威として: subetha（`subetha-zerc20`）で `--burn-tx-hash` が無い → 拒否（払う先を案内）、x402（`exact`）に `--burn-tx-hash` → 拒否、x402 で鍵無し → 拒否。いずれも何も書かない（refusals.json だけ）。
- **FR-P5 credential**: subetha は `{x402Version: 2, accepted: <offer そのもの>, payload: {challengeNonce: offer.extra.challengeNonce, burnTxHash: <小文字>}}` の base64（adapter の preflight と同じ形）。再開点 `progress.burnTxHash`（小文字）と証跡 `gates.inbound_settlement.claimedTxRef` に残す（`payerAddress` は書かない）。コンソールの射影は `claimedTxRef` も出さない。
- **FR-P6 回復**: `--recover` は再開点の `burnTxHash` を `claimedTxRef` に写す。`--recover --chain` は subetha の受信を `skipped.inbound = protocol` で読まない（EIP-3009 ではない。burn の確認は V2 側の台帳と Sepolia の receipt）。送信（x402 Base Sepolia）は従来どおり header から読む。
- **FR-P7 変えないもの**: x402 受信の経路（鍵・EIP-3009・`payerAddress`・chain 読取）、latch の意味（応答を失ったら `--recover`、二度と送らない）、証跡の単調併合。

| 試験 | 内容 |
|---|---|
| `tests/unit/private-payer-burn-sale.test.ts`（lab 不要） | credential の形・`payFirstOf`、前提の段の 3 拒否（x402 鍵無し・x402 に burn・壊れた hash）と subetha の鍵無し通過、承認の段の 3 拒否（latch 無し）、subetha の latch → `burnTxHash`/`claimedTxRef`、`chainLegInputsOf` の `protocol`、CLI の exit 2 × 4 と subetha の鍵無し通過 |
| `tests/wire/private-x402.test.ts`「v1.3 payer 道具 --burn-tx-hash」（lab） | V2 fixture で quote（鍵無し、`payFirst`）→ burn 無しの承認拒否（settle 0）→ 大文字混じりの hash で delivered（journal の `source_settled` は小文字 txRef と eventId、証跡の `claimedTxRef` = `txRef`）→ `--recover --chain` で受信 `protocol`・送信 header |

結合（§4）の手順: Router 子を起動 → `private-payer.ts`（`--inbound-network eip155:11155111 --inbound-asset <V2 zUSDC> --inbound-max-total 11000`、鍵無し）で quote → `payFirst` を V2 担当へ → V2 側 `pos-pay-token A <payTo> zUSDC <amount decimal>` → transfer の tx hash を受け取る → `--approve --burn-tx-hash <hash>`（challenge の TTL 1800 s 内）→ delivered。結果は「transport synthetic」と明記し、受信の burn は V2 の台帳（`/admin/payments` は V2 側が読む）と Sepolia の receipt で、送信は `--recover --chain` で確かめる。

### 9.1 レビュー（Codex `gpt-6-astra`、2026-10-22、REJECT → 反映）
| 指摘 | 対応 |
|---|---|
| 1 High: `subetha-zerc20` 以外は全部 x402 として署名に進む。`offer.extra` 無しで例外 | scheme の allowlist（`exact` / `subetha-zerc20`。ほかは latch の前に拒否）、offer/extra/network の形を安全に検査。単体: 知らない scheme、extra 無し → 再開点不変・header 無し |
| 2 High: burn を渡した承認の期限切れが「新しい --out で quote し直せ」と言う（払い直しの誘導） | burn 付きの拒否（期限切れ・引数違い・quote.json 改変・形違い）は「transfer は戻らない。照合してから」。単体: 期限切れ（burn 付き / 無し）と引数違い |
| 3 Medium: CLI の stdout が `run.evidence` をそのまま出す（`claimedTxRef`・`txRef`） | 承認の結果も `consoleProjectionOf` で出す。単体: 実際の stdout に hash が無く、evidence.json にある |
| 4 Medium: 応答喪失・unknown で受信 gate を置き換え、`claimedTxRef` が消える | `markBothUncertain`（既存の欄を保つ）。単体: 応答喪失（閉じた port）で `{settled:false, uncertain:true, claimedTxRef}` |
| 5 Low: §4 に判断前の箇条が残る | 履歴と明記。受入 §11 に表の前提 |
| 再レビュー（REJECT、残り 1）: 引数違い・quote.json 改変の拒否が burn 付きでも「quote し直せ」を含む | burn 付きは「quote し直せ」を外し照合だけ。単体: 引数違い・改変・削除の 3 件（再開点・証跡のバイト列不変、`quote again` 無し）、burn 無しは従来の文 |
