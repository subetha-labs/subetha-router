# 受信レール `subetha-exact` の受け入れ（段 3・段 4 の手順と記録の雛形）

> 入力: `docs/subetha-exact-inbound-requirements.md` v4.4（AC-1〜AC-7）、`docs/subetha-exact-inbound-design.md` v5.2、`docs/subetha-exact-inbound-tasks.md` v3.4。
> 段の番号は `~/Projects/research/mainnet-readiness-20261118/ROUTER-V2-PROVIDER-PLAN.md` §7（段 2 = 本 repo の実装、段 3 = 登録、段 4 = ローカルの Router での実購入と計測、段 5 = hosted の判断）。
> **段 3 と段 4 はオーナーの go が要る**（テストネットの facilitator への登録、wallet の作成と資金、チェーンの取引）。本書は手順の雛形と記録の表で、実行の記録は空欄。

## 1. 段 2 の受け入れ（合成 facilitator。2026-11-20、ローカル）

| AC | 証拠 | 結果 |
|---|---|---|
| AC-1 通し（実 CLI・実 TCP・実 EIP-712） | `tests/wire/subetha-exact-cli.test.ts` 「AC-1」: journal `created → source_pending → budget_reserved → source_settled → source_released → destination_pending → delivered → source_completed`、fixture の注文は `release.completed.outcome: "delivered"`、上流 1 回 | 通過 |
| AC-2 (a)(b)(c)(c′)(d)(e)(f)(f′)(h)(i)(j)(k)(l)(l′)(n) | `tests/unit/subetha-exact-adapter.test.ts`（29）、`tests/unit/subetha-exact-classify.test.ts`（55）、`tests/unit/lifecycle-release.test.ts`（40）、`tests/wire/subetha-exact-cli.test.ts`（7） | 通過 |
| AC-2 (g) 再起動の表 | `tests/wire/subetha-exact-restart.test.ts`（7。`destination_submitted` だけは `lifecycle-release.test.ts` で行を直接書く: 設計 §6 の逸脱の記録） | 通過 |
| AC-2 (m) 閉じた quote（FR-4.5、**全 rail**。オーナーの承認 2026-11-20「1で進めて良いです」） | `tests/unit/lifecycle-release.test.ts`「閉じた quote の再 quote」（core: `closed`・`status`、rail を呼ばない、既存 rail・再起動の後も）、`tests/unit/http-subetha-exact.test.ts`（HTTP の本文に offer・payTo・expiresAt 無し、client、MCP の `nextStep` と `quote_closed`）、`tests/unit/sign-run.test.ts`（`npm run sign` の拒否）、`tests/wire/subetha-exact-cli.test.ts`（実 process） | 通過 |
| AC-3 既存の試験 | `npm test`（§1.1） | 既知のフレーク以外は通過 |
| AC-4 `npm run sign` | `tests/unit/sign-subetha-exact.test.ts`（6）、`tests/unit/subetha-exact-table.test.ts`、`tests/unit/sign-run.test.ts`（`closed: true` の拒否）、payer `hosted-contract.test.ts` | 通過 |
| AC-5 運用者の確認 | `tests/unit/subetha-exact-inspect.test.ts`（3）、`tests/wire/subetha-exact-cli.test.ts` 「AC-5」 | 通過 |
| AC-6 Codex のレビュー | `.claude_workflow/local/`（要件 4 回、設計 5 回、タスク 4 回、実装 3 回） | 記録あり |
| AC-7 上限の既定値 | `SUBETHA_EXACT_DEFAULT_LIMITS = { maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 6 }`（`src/shared/subetha-exact.ts`）。期間と停止の条件は §3 | 入っている |

### 1.1 `npm test` の記録

| 日時（JST） | 結果 | 失敗の内訳 | 備考 |
|---|---|---|---|
| 2026-11-20 20:30（T-5 の後） | 3925 通過 / 5 失敗 / 33 skip（174 ファイル） | `guarded-transport` T-A5/T-A6/T-A8（既知: macOS で `127.0.0.2` の alias が要る）、`subetha-exact-restart` の 2 件（全体の負荷で vitest の既定 5 秒を超えた。単独では通過。以後 wire の 2 ファイルは `testTimeout` 90 秒） | 実装レビュー 3 の前 |
| 2026-11-20 21:35（実装レビュー 3 の反映の後） | 3944 通過 / 6 失敗 / 33 skip（176 ファイル） | `guarded-transport` T-A5/T-A6/T-A8（既知の alias）、`diagnostics-sink` の p99 の 2 件（既知の時間）、`sign-diagnostics-entry` の viem の期限 1 件（負荷。単独では通過） | 本スライスの新しい試験は全部通過 |
| 2026-11-20 22:40（FR-4.5 の実装の後） | 3949 通過 / 6 失敗 / 33 skip（176 ファイル） | `guarded-transport` T-A5/T-A6/T-A8、`diagnostics-sink` の p99 の 2 件（既知）、`subetha-exact-restart` の 1 件（**本物の影響**: 使用済みの requestId を再 quote して署名し直す試験が、閉じた文書を受けて落ちた。FR-4.5 の意図どおりなので試験を「再 quote は closed、元の文書と credential の再提出は現在の状態」に直し、単独で 9 件通過） | 実装レビュー 5（REVISE → 反映） |

既知のフレークの一覧: `guarded-transport` T-A5/6/8（alias）、`diagnostics-sink` の p99 の時間（負荷）、負荷で落ちる wire（`private-x402` の proxy、`sign-diagnostics-entry`）。失敗がこの一覧の外なら、単独で再実行して記録する。

## 2. 段 3: 登録（オーナーの go が要る）

やること（protocol の `docs/PUBLIC-TESTNET-QUICKSTART.md` §4 の手順に従う。本 repo には登録の道具は無い）:

1. **Router 用の Provider 専用の wallet** を作る（既存の Router の鍵は使わない。EOA は登録の署名と probe に使い、POS key は facilitator に渡す）。Base Sepolia ETH と zUSDC（quickstart §1）。
2. facilitator への登録（quickstart §4.1 の self-service = 招待コードが要る、または §4.2 の運用者の経路）。登録の結果の **Provider token** を 0600 のファイルに保存する。**token は秘密**: journal・ledger・応答・文書・レビューの prompt に書かない（NFR-3）。
3. Router の設定:
   - route: `sourceRail: "subetha-exact"`、`source: { network: "eip155:84532", asset: "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f", decimals: 6, amount: "<= 20000" }`（`payTo` は書かない）、`destination` は既存の上流（例: x402 の Provider A）。
   - env: `ROUTER_SUBETHA_EXACT_FACILITATOR_URL=https://facilitator-testnet.subethalabs.com/p/<provider-id>`、`ROUTER_SUBETHA_EXACT_TOKEN_FILE=<0600 のファイル>`、任意で `ROUTER_SUBETHA_EXACT_OFFER_SECONDS`。
   - 設定の `subethaExact.limits` は既定のまま（§3）。
4. 起動の確認: 起動ログに token・URL が無いこと。`npm run subetha-exact:inspect` が空の一覧を出すこと。

記録（2026-11-21。秘密・招待コード・RPC の URL は書かない）:

| 項目 | 値 |
|---|---|
| 日時（UTC） | 2026-11-21 01:24（register、`pending`）→ 01:25（activate、`active`、`opSeq` 1） |
| Provider id（公開の値） | `router-local`（`regId` `reg-9-4306db18`） |
| 登録の経路（§4.1 / §4.2） | §4.1 self-service（招待コード）。招待は運用者の道具（研究 repo の `selfreg_invite.py`、台帳 `app-20261121-01`）で発行。発行の前の枠は 2/6、登録の後は 3/6 |
| wallet の公開 address（EOA / POS） | EOA `0xD48f9CC27F012493A6544cbd55aC950C0cF0c066`。POS key の sha256 `e28223d9…4b86`（値は 0600 のファイルだけ） |
| probe | 宛先 `0xb77265bf2f36662b04f1282823fbd565a606da92`、1 最小単位、tx `0x38b75472e78e59e5ad909fa1d1d69963967fcbbe820cbf49a46b27a214861c07`（1 回だけ） |
| 資金 | ETH 0.00003（運用の wallet から。tx `0xf4e1dfe2102a2865132ffbd4cf6b8fc3ecb4e0f3b79a963155ad0a65df6677ce`）。zUSDC は quickstart §1 の mint → approve → wrap（100,000 最小単位） |
| 起動の確認 | 起動ログは `listening` の 1 行と終了時の `router drain: complete` だけ。token は起動ログ・journal・inspect の出力に無い（grep 0 件）。登録直後の `GET /p/router-local/exact/orders?limit=1` は 200・注文 0 件 |
| 配備の id（`registration.meta.json`） | 記録していない（登録の要求の digest は `9b276cfc…0c94`） |

## 3. 段 4: ローカルの Router で通す（AC-7 の上限・期間・停止の条件）

- **期間**: 段 4 の実行は **1 回の計画で 7 日以内**。延長は新しい計画（オーナーの判断）。
- **上限**（設定の既定値。上げるのは運用者の判断で、設定の変更として記録する）: `maxRequestsTotal: 100`（累積の**試行** = adapter の `requested` の行。作成の再試行・応答の喪失を含み、発行した quote（journal の `created`）より多い。再起動で戻らない）、`maxUnresolved: 3`（結果の分からない試行 + 結び付かない `discovered` の注文）、`requestsPerMinute: 6`。
- **停止の条件**:
  1. 累積が 100 に達したら quote は `source_offer_unavailable limit_total` で断られる。**止める**（上げない）。
  2. 未解決が 3 に達したら quote は `limit_unresolved`。**止めて `npm run subetha-exact:inspect -- --remote` で確かめる**。注文が見えて期限で閉じるものは待つ。結果の分からない attempt は、facilitator の側で注文が無いと確かめた上で `--abandon <attemptId> --reason <token>`（Router を止めてから）。
  3. `mismatch: true` が出たら（Router が払われていないと言い、facilitator が `accepted`；release の行が無いのに `authorized`；注文の分からない attempt に注文がある）**止めて記録する**。返金・再実行は運用者の判断（テストネットでは無視できる）。
  4. facilitator の 401／404（token・tenant）: 起動ログの固定文と `source_offer_refused unauthorized|unknown_tenant`。**止めて登録を確かめる**。
- 買い手の手順は既存と同じ（`README.md` の「Developer-only clone and signing path」）: `subetha_router_list_routes` → `subetha_router_quote` → 人の承認 → `npm run sign -- '<quote>'` → `subetha_router_purchase`。`subject.fundsMoveOnCredential` は `false`（署名では資金は動かず purchase で動く）。**Router が断っても署名は `validBefore` まで有効**（応答の `mayStillSettleUntil`）。

### 3.1 計測の表（計画 §6 の数字。分母を明記する）

数え方（タスク v3.4「計測の準備」のとおり。**「払われなかった」とは言わない**）:
- **試行** = adapter の `requested` の行（作成の再試行・応答の喪失を含む）。**発行した quote** = journal の `created` の行。**settle を呼んだ購入** = `settle` の行のある attempt。**Router が settled を観測した購入** = `settle.outcome: "settled"`。**結果の分からない購入** = `unknown` の終端。
- 発行した quote を **orderId で注文に結び付け**（`created.quoteId` = orderId）、`npm run subetha-exact:inspect -- --remote` を **1 回の観測の時刻**で行い、quote ごとに 3 つに分ける（互いに素で全部を覆う）: (1) remote で `accepted`／`settled` を観測、(2) それ以外の状態を観測（`ORDER_STATES` の残り。観測した state をそのまま欄に残す）、(3) 観測できない・結び付かない（照会の失敗、remote に無い注文）。journal に無い注文（remote だけにある、`discovered`・`foundByLookup`）は分母の外に別に数える。**観測の時刻の後に実行可能な authorization が使われ得る**（`mayStillSettleUntil` を過ぎた quote だけを「期限を過ぎた」と言う）。
- facilitator の割り当て = **orderId の種類の数**（`created` の `existing: false` と `discovered` を orderId で重複なく数える。`existing: true` で返った注文は新しい割り当てではない）。

| 数字 | 出どころ | 分母 | 値 |
|---|---|---|---|
| 見積りの所要時間（注文の作成を含む） | ledger `created.elapsedMs`（作成の POST の往復。inspect の `createMs`）。quote 全体は HTTP の計測 | 発行した quote（`created` の行） | 7 件。`createMs` 710〜1058（中央 744）。quote 全体（HTTP、quote の入口 3 件）1050／1212／1594 ms。標準入口の払わない 402 は 1008 ms |
| 見積りから `delivered` までの時間 | journal の `created.at` → `delivered.at` | `delivered` の購入 | 6 件。3766／4985／5460／5764／6395／7674 ms（中央 5.6 秒）。quote の入口の値は署名の道具の起動時間を含む |
| quote の 3 分類（(1) accepted／settled、(2) ほかの観測した state、(3) 観測できない）と割り当ての消費 | inspect `--remote` の 1 回の観測（`remote.state`）を orderId で結び付ける；割り当ては orderId の種類の数 | 発行した quote（(1)+(2)+(3) = 分母。remote だけの注文は別の行） | 7 件 = (1) `accepted` 6（release は全て `delivered`）+ (2) `open` 1（標準入口で払わなかった 402。観測の時点で期限前）+ (3) 0。割り当ては 7（全て `existing: false`）。remote だけの注文 0 |
| 失敗と未解決の率と内訳 | journal の終端（`source_failed` の reason、`unknown` の reason、`paid_undelivered` の reason）と、ledger の `create_failed`／`refused` の detail（こちらの分母は試行） | 発行した quote／試行 | 失敗 0／7、`unknown` 0／7。試行 7 のうち `create_failed`・`refused` 0。未解決は観測の時点で 1（払わなかった 402 の注文。期限で外れる） |
| settle の中継の手掛かり | ledger `settle`（`outcome`・`httpStatus`・`settleMs`）、`--remote` の `exact.state`／`origin`（`facilitator-relay`）をそのまま並べる（relay の拒否は Router からは確定できない） | settle を呼んだ回数 | 6 回、全て `settled`。`settleMs` 546／1538／1640／1927／2016／2303。remote は全て `exact.state: paid`、`origin: facilitator-relay` |
| release の復元の回数 | ledger `release.reconstructed` | release を呼んだ回数 | 0／6（`releaseMs` 239〜624、`completeMs` 223〜612） |
| withdraw の手数料 | 本 repo の外（Provider wallet の操作）。quickstart §4.3 | — | 1 回（2026-11-21 01:57Z）: 2,500 最小単位の withdraw に手数料 **8,908**（0.008908 zUSDC。道具の見積りは 8,908〜9,110 の間で動いた）。受付まで約 3 秒、宛先の公開残高への着金を確認。受け取った支払いは注文ごとに別の note（12,000）で、**1 回の withdraw は 1 つの note からしか払えない**（まとめるには consolidate が要るが、Provider 用の道具には無い）。したがって 12,000 の支払い 1 件から引き出せるのは約 3,000 で、手数料が受取額の約 74% になる。受け取りは支払いの約 25 分後まで `screening` で使えなかった |
| 監査の所要時間と不一致 | `npm run subetha-exact:inspect -- --remote` の実行時間と `summary.mismatches` | 実行 | 1 回、約 3.1 秒（7 件）、`mismatches: 0`、`discovered: 0`、`foundByLookup: 0` |
| 詰まった箇所 | 自由記述（facilitator の Provider 向け文書・kit の改善点） | — | (a) Base Sepolia の ETH: 公開の faucet は新しい EOA に出さず、記録にある使い捨ての wallet は全て 0 だった。(b) archive RPC: 公開の endpoint は `eth_getProof` が直近 10,000 block まで。(c) 標準の x402 クライアント（`@x402/core` 2.28.0）は既定で zUSDC に払わない（`spendControls.allowedAssets` が要る）。(d) hosted の `maxTimeoutSeconds` は 150（注文の TTL 300） |

計測の分け方（タスク v3.4 の分母の註）: (1) accepted／settled、(2) それ以外の観測できた状態（`pending`・`late-paid`・`rejected`・期限）、(3) 読めなかった／結び付かないもの、で尽くす。remote にだけある注文は「発行した quote」の分母の外に別の行で数える。

### 3.2 実行の記録（2026-11-21）

| 項目 | 値 |
|---|---|
| 期間（開始・終了、UTC） | 2026-11-21 01:28〜01:31（1 回の実行。Router は終了時に `router drain: complete`） |
| 設定（route・limits） | route `md-zusdc-eth-snapshot`: 受信 `subetha-exact`・zUSDC 12,000 最小単位、送信 x402・Base Sepolia USDC（上流 `https://provider-x402.subethalabs.com/v1/eth/snapshot`、10,000）。limits は既定（100／3／6）。Router は main `f68f10f`、`ROUTER_ADAPTER_MODE=real`、送信の署名は使い捨ての鍵 |
| 発行した quote / delivered / 失敗 / 未解決 | 7 / 6 / 0 / 1（未解決の 1 は意図して払わなかった標準入口の 402） |
| 入口の内訳 | quote の入口（`POST /v1/quotes` → `npm run sign` → R3）3 件、標準入口（§3.3）3 件 + 払わない 402 が 1 件 |
| 買い手 | 使い捨ての EOA `0x50D99a29166E5ee0e0f931C8D7e67b498F86572F`（ETH なし。zUSDC 150,000 → 78,000 = 12,000 × 6） |
| `--abandon` の回数と理由 | 0 |
| 停止の条件に当たった回数 | 0 |
| `npm test` の記録（§1.1） | 3982 pass / 4 fail（既知の macOS の flake。PR #204 の記録） |

この実行が示すのは、hosted の testnet facilitator（tenant `router-local`）とローカルの Router の間で 6 件が settle・release・配達・complete まで通ったことであり、chain の finality の確認ではない。

**finality の確認（2026-11-21 01:57Z、公開の Base Sepolia RPC の `finalized` の block と照合）**: probe 1 件、受信の settle 6 件、上流への支払い 6 件の計 13 件が、全て status 成功・canonical（receipt の block hash がその高さの block と一致）・`finalized` 以下の block に入っていた。確定までの遅れは約 20 分だった（01:31Z の最後の tx が 01:57Z の照合で確定済み、01:47Z の照合では未確定）。

### 3.3 標準の x402 クライアントからの購入（`docs/x402-standard-entry-requirements.md` S-5）

段 4 の枠（総数・未解決・毎分、期間、停止の条件）の中で、標準入口 `GET /x402/v1/routes/{routeId}/resource` から 1 回以上買う。
クライアントは `@x402/fetch` + `@x402/evm`（2.28.0）で、`spendControls.allowedAssets` に zUSDC を足す以外の設定をしない。記録するもの（秘密・署名は書かない）:

| 項目 | 値 |
|---|---|
| 402 の requirements の `maxTimeoutSeconds`（hosted の実際の値） | 150 |
| 402 → 200 の所要時間 | 3 件: 7536／5043／6288 ms（クライアントの呼び出し全体。402 → 署名 1 回 → 再送 → 200） |
| `paymentId`、`source.txRef`、公開の状態 | `b51d68d0-310f-4066-8290-97866373e449`（`source.txRef` `0x9ba6bf6fc7491d3f407dd5069cc5159beba30949c2b2741d844eed0c1a8374f0`）、`2395a033-e9f6-419d-b356-ce788f180b31`、`ac6338ea-4721-4bfc-ab1b-3852c68a3aea`。3 件とも `delivered`、journal は `created → source_credential_bound → source_pending → … → delivered → source_completed` |
| 払われない 402 が使った枠（数） | 1（注文 1 つ、未解決の枠 1 つ、総数の枠 1 つ。facilitator の側は `open`） |

実購入（2026-11-21）: クライアントは `@x402/fetch` + `@x402/evm` 2.28.0、設定は signer・network・`spendControls.allowedAssets`（zUSDC、上限 20,000）だけ。各回とも署名は 1 回、応答は `[402, 200]`。

合成 facilitator での受け入れ（2026-11-21）: `tests/wire/x402-entry-client.test.ts`（6 件）、`tests/wire/x402-entry-restart.test.ts`（4 件）。

## 4. 段 5 に持ち越すもの

- hosted に載せる条件（quote の入口の認証、買い手ごとの制限、全体の割り当ての予算、復旧の呼び出しが quote の負荷で妨げられないこと）は計画 §7 段 5 のまま、本スライスでは扱わない。
- FR-4.5（閉じた quote）は 2026-11-20 にオーナーが承認し実装済み（全 rail）。hosted への反映は次の deploy のとき: 公開の契約の変更（使用済みの quote の再取得に `source.offer` が無い）として `docs/DEPLOY.md` の記録に書く。
- 受信の取り消し（reorg）の検知は既存どおり無い（`afterRelease` は FR-11 で見えるだけ）。
