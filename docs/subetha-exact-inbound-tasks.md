# 受信レール `subetha-exact` タスク v3.4

要件 `docs/subetha-exact-inbound-requirements.md` v4.4、設計 `docs/subetha-exact-inbound-design.md` v5（設計のレビューの 5 回目の処置が前提: 設計が変われば本書を直す）。1 タスク = 1 つの検証可能な増分。各タスクの完了条件は
**そのタスクの試験の追加と `npm test`・`npm run types` の全通過**（既存の試験への変更は「既存の試験に触れるもの」に限る）。
v1 は Codex のレビュー（`.claude_workflow/local/tasks-review1.md`、REVISE、must-fix 4・should-fix 2・note 1）を受けて v2 に改めた（末尾に対応表）。

## 実装の前提
- **設計のレビューの処置**: 実装は**設計の現在の版（v5）**の独立レビューが APPROVE（WITH CHANGES を含む）になり、その変更を設計と本書に写してから始める（レビューが REVISE なら設計を改め、本書を直してからもう 1 回）。
- **FR-4.5（閉じた quote の再 quote、全 rail の公開の契約の変更）のオーナーの承認**: T-2b の前に報告して承認を得る。承認が得られなければ T-2b のその部分は**止める**（要件 FR-4.5 と設計 §4.1 の改訂 = 要件・設計の修正とそのレビューが要る。別の形に勝手に差し替えない）。T-2a・T-1 はそれに依存しない。

## 有効化の境界（中間の状態の安全）
- T-1 の後、`sourceRail: "subetha-exact"` は設定で**通る**が:
  - **real モード**: 合成（`composeRails`）に adapter が無いので `inboundByRoute` が `ConfigError`（`routes.<id>.sourceRail has no configured inbound rail`。`src/main.ts:585-598`）で起動を止める。T-1 の試験で**合成の経路**（`composeRails` を呼ぶ）でこれを固定する（設定の試験だけでは足りない）。
    **この断言は一時のもの**: T-5 で adapter を登録すると偽になるので、T-5 はこの断言を「設定どおりに合成できる」に**置き換え**、別に「`inboundRails` に登録が無ければ `inboundByRoute` が `ConfigError`」（wrapper の規則そのものの試験。rail の名前は合成の値ではなく偽の名前で）を残す。synthetic モードの拒否の断言は T-5 の後も変わらない。この置き換えは本書が明示して許す唯一の試験の変更（T-1 で足した試験ファイルの中）。
  - **synthetic モード**: 表の照合も `inboundByRoute` も通らない（`src/config.ts:1467`、`src/main.ts:675-690`）ので、T-1 で `parseSynthetic` に `subetha-exact` の明示の拒否（`ConfigError`）を足し、試験で固定する（設計 §5.2）。
  T-5 までこの状態を保ち、どの中間の状態でも zUSDC を x402 の rail で受ける経路は無い（表の資産単位の制限は T-1 で入る）。
- T-2 の core の変更は、`release`／`complete`／`settleWindowOf` を持たない既存の rail では**行が 1 つも変わらない**ことを、既存の試験の不変で確かめる（wrapper は常に定義し、持たなければ `none`／`undefined` を返す。設計 §2）。

## タスク

| # | 内容（設計の節） | 主なファイル | 試験（前に落ち、後に通るもの） |
|---|---|---|---|
| T-1 | **表・設定・分類器・一覧・payer**（§5.1・§5.2・§5.5）: `KnownAsset.rails`、`inboundRailsOf`／`outboundRailsOf`、zUSDC@84532 の行、`InboundRailName`；`validateTermsAgainstTable` の順（network → 資産 → rail）；`parseRoute` の `subetha-exact`（`payTo` 禁止、額 ≤ 20 000）、profile の拒否、`parseSynthetic` の拒否、`RealRailsConfig.subethaExact`（env 3 つ・`subethaExact.limits`）、URL の host／path の検査；`sourceRailListingOf`（`rail`・`scheme`・`fundsMoveOnCredential: false`）；`checkExactCommon`；payer `staticSourceRailOf`（`rail` が**無い**ときだけ fallback）、`npm run vendor` | `src/shared/networks.ts`、`src/config.ts`、`src/http/projection.ts`、`tools/sign-classify-evm.ts`、`packages/payer/src/daemon/handler.ts`、`packages/payer/src/vendor/*` | `tests/unit/subetha-exact-table.test.ts`（新）: 表の上書き、USDC 不変、`x402` + zUSDC → `ConfigError`、他 network → `ConfigError`、**額 20 001 → `ConfigError`**、route／profile／synthetic／env／limits の解析、URL の拒否、既存 golden 不変、一覧の **`rail`・`scheme`・`fundsMoveOnCredential: false`**、rail と資産の両方が無い設定の文言の確認、**real の合成で `inboundByRoute` の `ConfigError`**（`composeRails` を呼ぶ）；`tests/unit/sign-subetha-exact.test.ts`（新。分類器の部分: zUSDC の `exact` を通し、domain 違い・network 違い・20 000 超・`fundsMoveOnCredential: true` を拒む）；`packages/payer/test/unit/hosted-contract.test.ts` に **`rail: "subetha-exact"`・`rail: null`・`rail: 1` の行が落ち、`rail` 無し・`rail: "x402"` は不変**（既存の mock の `quoteUrl` 欠落の型エラー 2 件も直す: 基点で `npm run types` が既に落ちている）；`vendor.test.ts` 不変で通る |
| T-2a | **port と core の機構**（§2・§4.3〜§4.6）: `CreateOfferRequest.requester`、`created` の行の `source.settleWindow` と `intentFromCreated` の復元、`InboundVerifyResult`、`settleWindowOf`／`ownsOffer`／`release`／`complete`（結果 `none`）、`InboundOfferError`、`COMPLETE_TRANSIENT_REASONS`；`inboundByRoute` の転送（常に定義、無ければ `none`／`undefined`、束縛が無い offer は **`complete` だけ** `ownsOffer` で fallback。verify・settle・release は fallback しない）；core は method が無ければ持たないと読み、契約外の結果だけ `unknown`；journal の行 `source_released`／`source_completed`／`source_complete_unreported` と intent の欄；`deliver()` の release、終端の後の `reportComplete`、起動時の掃き出し（core が所有、`close()` が待つ）；`SAFE_REASONS`；停止点 `hooksForTest.stop`（4 点）；`createOffer` 3 箇所への `requester`；`quoteLocked` の `InboundOfferError` → `QuoteOutcome`（`retryAfterMs`） | `src/ports/inbound.ts`、`src/core/{orchestrator,store,intent,dynamic,private}.ts`、`src/main.ts`（wrapper） | `tests/unit/lifecycle-release.test.ts`（新。**ライフサイクルと復旧だけ**）: 行の順序、`none`・method 無しで既存どおり、契約外の値で `unknown`、refused／unknown → `paid_undelivered` と上流 0、complete の行と恒久／一時、`unknown` で complete 無し、**同じ quote の並行・連続の purchase で settle／release／complete が各 1 回（AC-2 (h)）**、route を消した後の起動時の complete（`ownsOffer`）、再起動の表（§6 の全行。`destination_submitted` は行を直接書く）、掃き出しと `close()` の待ち、行なしなら掃き出し無し、停止点、**報告の行の append の失敗の注入（2 つの event）で応答が変わらない**、`release` の無い rail の不変；`lifecycle.test.ts` 不変 |
| T-2b | **開示と閉じた quote**（§4.1・§4.2・§5.5 の MCP）: `mayStillSettleUntil` + `awaitingPaymentDoesNotMeanUnpaid` の表（(i)(i′)(ii)、`quote_changed`・`source_verify_unavailable`、初回・再提出・status）の行・射影・HTTP の本文・MCP の文；閉じた quote（core の文書に `closed`・`status`、**公開の面で offer を落とす**）と `quoteBody`／MCP `nextStep`／`sign-run` の拒否；**MCP の quote 時の rail の補足（`railHintOf`）**；`source_offer_*` の HTTP status・`Retry-After`・`order_reused_*` の案内 | `src/core/orchestrator.ts`、`src/core/dynamic.ts`、`src/http/{app,projection}.ts`、`src/mcp/tools.ts`、`tools/sign-run.ts` | `tests/unit/lifecycle-release.test.ts` に開示の表の全行と閉じた quote の core の欄；`tests/unit/sign-run.test.ts` に `closed`／offer 無しの拒否；`tests/unit/mcp-rail-hint.test.ts` に zUSDC の文と閉じた quote の `nextStep`；`tests/wire/http-contract.test.ts` に閉じた quote の形（offer 無し）と `source_offer_unavailable` の 503＋`Retry-After`（既存の断言は変えない）；`mcp-server.test.ts` に文の断言 |
| T-3 | **合成 facilitator**（§7）: tenant の面と全モード、`/_fixture/*`（`mode`・`allocate`（`createdAt`・`expiresAt` を受ける）・`paid-external`・`calls`・`orders`） | `tests/fixtures/subetha-exact-facilitator.ts`（新） | `tests/unit/subetha-exact-fixture.test.ts`（新）: fixture 自身が facilitator の契約の表どおりか（status・固定本文・`existing`・release の 1 回性と 425・complete の冪等と 409・署名を先に・`binding`・`status.release`・`busy-then-create` + `allocate`・`lose-response`（全部）と `-once`・`corrupt`（7 欄）・`preset`） |
| T-4 | **adapter**（§3）: ledger（`Journal` 再利用、attempt の鍵、`byPair`・`byOrderId[]`、操作の行の持ち主、`created.tenant`、salt の fsync）、digest、`createOffer`（上限・全件の照会・**`discovered` の集計（attempt に帰属させない）**・検査）、ledger の append の失敗の扱い（`requested` は fail closed）、preflight、`settleWindowOf`・`ownsOffer`、verify（手元 + 公開。transport の失敗も `isValid: false`）、settle、release（予算・GET の試行の分離・復元 D／D′）、complete（tenant の照合）、分類の純粋関数（表 A〜E の互いに素な行と既定）、予算の計算、停止点、`startup()` の失敗時の片付け、診断の op | `src/adapters/inbound/subetha-exact.ts`、`src/adapters/inbound/subetha-exact-ledger.ts`、`src/adapters/inbound/subetha-exact-classify.ts`（新 3 つ）、`src/shared/diagnostics.ts`（`DIAG_OPS` 5 語） | `tests/unit/subetha-exact-classify.test.ts`（表 A〜E・D′・digest・復元の条件・予算）、`tests/unit/subetha-exact-adapter.test.ts`（設計 §10 の行の全部: transport の境界・秘密の不在・時計を合わせた遅れた割当を含む）；`diagnostics.test.ts` の op の集合 |
| T-5 | **合成と wire**（§5.3・§5.4・§4.6）: token ファイルの読取（0600 厳密）、adapter の生成の条件（route **または** env + ledger）・transport・`denyHosts`・`startup`／`shutdown` の順と**起動の途中の失敗の片付け**（`startRouter` の `try` を広げる）、`parseReal` の env の読み方（route 無しでも両方あれば）、`RouterCapabilities.subethaExactHooksForTest`／core の `hooksForTest`、`router-subetha-exact-process.ts`（`SUBETHA_EXACT_STOP_AT`） | `src/main.ts`、`tests/fixtures/router-subetha-exact-process.ts`（新） | `tests/wire/subetha-exact-cli.test.ts`（新）: AC-1 の通し（実 EIP-712 署名 = `createX402Payer`。journal の行の順序と fixture の `release.state: "delivered"`）、R1 の一覧、AC-2 (a)(b)(i)(m)、閉じた quote、**(l′) の Router 側の開示**（外部支払いの後の status の欄）、`npm run sign` 相当の封筒がそのまま通ること、応答・起動ログに token の canary が無いこと；`tests/wire/subetha-exact-restart.test.ts`（新）: §6 の境界を停止点・upstream の stall・fixture の `lose-response` で決定的に作り SIGKILL → 再起動 → 状態・complete と上流の呼び出し数、**最後の route を消した再起動**（env あり: 掃き出しが報告する／env なし: 報告されず `note`）；`tests/unit/subetha-exact-table.test.ts` に token ファイルの検査（mode 0600 厳密・symlink・形）と**合成の断言の置き換え**（上の「有効化の境界」）；**起動の途中の失敗の片付け**（`tests/unit/compose-rails.test.ts` か新しい `subetha-exact-startup.test.ts`）: adapter の `startup()` の後で失敗させる（例: 動的の `verify` の失敗、listen の失敗）と ledger の lock が解放されて次の起動が通ること、core を作った後の失敗で `core.close()` が `rails.shutdown()` より先に呼ばれること（順序を記録する偽の rail） |
| T-6 | **運用者の確認と文書**（§8）: `tools/subetha-exact-inspect.ts`（`--remote`・`--abandon <attemptId> --reason <token>`、閉じた集合の写し）、`package.json` の script、README の節（登録は段 3 の手順へのリンクだけ）、`docs/subetha-exact-inbound-acceptance.md`（段 3・4 の手順の雛形: 登録、wallet、AC-7 の上限と期間と停止の条件、計測の表 = 紙の案 §6 と下の分母）、要件 v4.2 の註の反映 | `tools/subetha-exact-inspect.ts`（新）、`package.json`、`README.md`、`docs/` | `tests/unit/subetha-exact-inspect.test.ts`（新）: 一覧の形と閉じた集合、`--remote` の GET と requester の照会だけ（POST 0）、`mismatch` の 3 条件、`--abandon` の行・理由の token・Router 稼働中の拒否（lock）・前後の byte 比較；`tests/wire/subetha-exact-cli.test.ts` に **AC-5**（inspect の読み取りで fixture の呼び出し数と journal・ledger の byte 一致）と **(l′) の inspect の `mismatch`** を**足す**（T-5 の試験の追加）；**外に出る出力の敵対的な sentinel の試験**（設計 §10 の最後の行。fixture が返す任意の欄・自由な文が journal・診断・HTTP の応答・MCP の応答・inspect の出力に現れず、閉じた集合の `other` に写る。T-4・T-5 の adapter・token の canary の試験を支えにして、ここで完了） |

## 要件・受け入れ条件の持ち主（完了の持ち主 1 つ。括弧は支える側）

| 要件／AC | 完了の持ち主（支える側） |
|---|---|
| FR-1 | T-6（外に出る出力の sentinel で完了。T-1: URL・env・rail の設定、T-5: token ファイルの検査、T-4: adapter の秘密の不在） |
| FR-1.1, FR-1.2, NFR-1, FR-10, FR-10.2 の一覧・payer | T-1 |
| FR-2, FR-2.2, FR-3, FR-3.1, FR-4, FR-4.1, FR-4.2, FR-4.3, FR-5, FR-5.1, FR-5.3, FR-9, FR-9.2 (a)〜(c)(e), NFR-2（ledger の記録と診断の op） | T-4（T-3: fixture、T-2a: core の受け口） |
| FR-2.1 | T-4（adapter の分類の表 A で完了。T-2a: `QuoteOutcome` への写し、T-2b: HTTP／MCP の code・status・`Retry-After`・案内） |
| FR-4.4, FR-4.5, FR-10.2 の MCP の文 | T-2b |
| FR-5.2, FR-7, FR-8（既存の principal 認証）, FR-10.1 | T-2a |
| FR-7.1 | T-4（自動の照会の範囲と、作成の再呼び出しをしないことで完了。T-2a: core の復旧の制限） |
| FR-6, FR-6.1 | T-4（complete の予算・恒久／一時の分類で完了。T-2a: core の報告・掃き出し・append の失敗の封じ込め） |
| NFR-3 | T-6（inspect の閉じた集合と外に出る出力の sentinel で完了。T-2a: `SAFE_REASONS`、T-4: 分類の token） |
| FR-9.1, FR-9.2 (d), FR-11, AC-5, AC-7（acceptance 文書。T-1: 設定の既定値） | T-6 |
| NFR-4 | T-3 |
| AC-1, AC-2 (a)(b)(i)(m), (l′) の Router の開示 | T-5 |
| AC-2 (g) | T-5（wire の境界で完了。T-2a: 再起動の表の単体試験と `destination_submitted` の行の直接書き込み = 受け入れの逸脱の証拠） |
| AC-2 (c)(c′)(d)(e)(f)(f′)(j) | T-4 |
| AC-2 (n) | T-6（`--abandon` だけが外す断言で完了。T-4: 枠の保持・照会・遅れた割当） |
| AC-2 (h) | T-2a |
| AC-2 (l) | T-4（settle の表 B の全行で完了。T-2a: `unknown` の状態、T-2b: 開示の欄） |
| AC-2 (k1)(k2)(k3) | T-2b（開示の断言で完了。T-2a: 期限の経路の行） |
| AC-2 (l′) の inspect の `mismatch`、外に出る出力の sentinel | T-6 |
| AC-3 | 各タスクの完了条件（回帰）。**最終の受け入れの持ち主は T-6**（最終の Codex レビューの前に全試験を 1 回通す） |
| AC-4 | T-2b（`sign-run` の `closed` で完了。T-1: 分類器） |
| AC-6 | 本書の「順序と依存」のレビューの点 |
| 設計 §0・§1（要約・流れ）、§11（事実の確認）、§13（要件への註 → 要件 v4.2・v4.3 に写した）、§14・§15・§16・§17（レビューの対応表）、§12（残す危険） | 実装のタスクは無い（要約・証拠・履歴。§12 は段 4 の計測で見る）。§9 は T-4、§10 は各試験のタスクに分かれる |
| S-6〜S-8 | 実装しない（S-6 は段 3・4 でオーナーの go、S-7・S-8 は対象外） |

## 既存の試験に触れるもの
- `packages/payer/test/unit/hosted-contract.test.ts`: 行の追加と、mock の `quoteUrl` の欠落（型エラー）の修正。
- `tests/wire/http-contract.test.ts`・`tests/unit/sign-run.test.ts`・`tests/unit/mcp-rail-hint.test.ts`・`tests/wire/mcp-server.test.ts`・`tests/unit/diagnostics.test.ts`: 断言の**追加**だけ。
- それ以外の既存の試験は変えない（変えずに通ることが AC-3）。core の `QuoteDocument` の型は変えないので、`lifecycle.test.ts` などの `quote.source.offer` の参照はそのまま。

## 順序と依存
- T-1 → T-2a → T-2b → T-3 → T-4 → T-5 → T-6（T-3 は T-2 と独立に進められる）。
- Codex の実装レビュー（`gpt-6-astra`、CLI、差分と試験の実行結果を渡す）: **T-1〜T-2b の後に 1 回**（core の変更が既存 rail を変えないこと、閉じた quote の契約）、**T-3〜T-5 の後に 1 回**（adapter の安全条件、fixture の忠実さ、wire）、**T-6 の後に最終 1 回**（全体の差分）。
  小さな修正のたびに全体を再レビューしない（CLAUDE.md「No repeated whole-plan reviews for a small correction」）。
- コミットはレビュー済みの区切りごと（task branch。push と PR はオーナーの常設の許可の範囲。**merge はしない。hosted への配備はしない**）。
- 段 3（テストネットの登録・wallet・実購入）は T-6 の後に**止まってオーナーに聞く**（brief: 「When the implementation is ready for step 3, stop and ask the owner」）。

## 計測の準備（紙の案 §6、NFR-2）
段 4 で出す数字と、その分母を先に決める（T-6 の acceptance 文書に写す）:
- **試行**（adapter の `requested` 行の数。作成の再試行・応答の喪失を含む）、**発行した quote**（journal の `created` 行の数）、**settle を呼んだ購入**（`source_pending` の後に `settle` 行のある attempt）、**Router が settled を観測した購入**（`settle.outcome: "settled"`）、**結果が分からない購入**（`unknown` の終端）、**facilitator が `accepted` と言う注文**（FR-11 の `--remote`）。
- 「払われなかった」とは言わない。**発行した quote を orderId で注文に結び付け**（journal の `created` の `quoteId` = orderId）、FR-11 の `--remote` を**1 回の観測の時刻**で行い、quote ごとに 3 つに分ける（互いに素で全部を覆う）: **remote で `accepted`／`settled` を観測**、**それ以外の状態を観測**（`open`・`expired`・`closed-unpaid`・`uncertain`・`settled-unknown`・`late-paid` など `ORDER_STATES` の残り全部。観測した state をそのまま別の欄に残す）、**観測できない・結び付かない**（照会の失敗、remote に無い注文）。journal に無い注文（remote だけにある）は分母の外に別に数える。観測の時刻の後に実行可能な authorization が使われ得ることは分母の註に書く（`mayStillSettleUntil` を過ぎた quote だけを「期限を過ぎた」と言う）。
- 作成の所要時間 = `created.elapsedMs`（作成の POST の応答まで。照会の所要時間は別の `lookup.elapsedMs`）、quote → `delivered` = journal の `created` と `delivered` の `at` の差、失敗と未解決の内訳 = 終端の `terminalReason`・`release`・`complete` の欄。
- relay の拒否は Router からは確定できない（`unknown` + remote の `exact.state` は手掛かりであって分類ではない）。段 4 では remote の `exact.state`／`origin` をそのまま並べて記録する。
- withdraw の手数料と監査の所要時間は Router の外（Provider 用 wallet の道具）で測る。

## v1 → v2 の対応（Codex `tasks-review1.md`）
| 指摘 | 対応 |
|---|---|
| must 1: T-5 が T-6 の inspect に依存 | AC-5 と (l′) の inspect を T-6 に移し、T-5 は Router 側の開示だけ |
| must 2: synthetic モードで fail closed でない | T-1 に `parseSynthetic` の拒否と、real の合成の経路の試験を足した（設計 §5.2 に写した） |
| must 3: `source.offer` を optional にすると既存の試験の型が壊れる | 設計 §4.1 を「core の型は変えず、公開の面（HTTP・MCP）で落とす」に改めた。既存の試験は触らない |
| must 4: 持ち主が 1 つでない | 持ち主の表を足した。MCP の quote の補足は T-2b、AC-2 (h) は T-2a、AC-7 は要件 v4.2 の註で解いた |
| should 5: 反証可能な断言 | T-1 に額の cap・一覧の `fundsMoveOnCredential`・payer の null／数値、T-4 に transport の境界と秘密の不在、T-5 に token の canary |
| note 6: レビューの前提と承認の扱い | 「実装の前提」の節（設計のレビューの処置、FR-4.5 の承認が無ければ止める） |
| should 7: 計測の分母 | 「計測の準備」を分母つきに書き直した |

## v2.1 → v3 の対応（Codex `tasks-review2.md`）
| 指摘 | 対応 |
|---|---|
| must 1: 持ち主の表の穴（FR-9.1 無し、NFR-2 の診断、AC-4 の 2 人、AC-3、FR-1・AC-2 (k)(n) の早すぎる完了、FR-2.1 の二重、(g) の支え、設計の非実装の節） | 持ち主の表を書き直した（完了の持ち主 1 つ + 支える側。設計 §0・§1・§11〜§15 の扱い） |
| must 2: T-1 の合成の拒否の断言が T-5 で偽になる | 「有効化の境界」に置き換えの規則（一時の断言 → 設定どおりの合成 + 登録無しの `ConfigError` + synthetic の拒否は不変）。T-5 の試験に明記 |
| should 3: 外に出る出力の sentinel と起動の片付けの断言 | T-6 に外に出る出力の sentinel、T-5 に失敗の注入（lock の解放、`core.close()` → `rails.shutdown()` の順） |
| should 4: 「払われなかった」の式 | orderId で結び付け、観測の時刻、3 区分。`via: "create"` の絞り込み |
| should 5: 前提が設計 v2 のまま | 「実装の前提」を設計の現在の版に |

v3 → v3.1（設計 v4）: T-2a に `source.settleWindow` と report の append の失敗の注入、T-4 に 1 注文 = 1 attempt の規則と `created.tenant`、T-5 に adapter の生成の条件（route または env + ledger）と最後の route を消した再起動の wire 試験。

v3.1 → v3.2（Codex `tasks-review3.md`）: must 1 → FR-2.1・AC-2 (l)・FR-6／6.1 の完了を T-4 に、FR-1・NFR-3 の完了を T-6 に（支える側を明記）；should 2 → 計測の 3 区分を互いに素で全部を覆う形に（`ORDER_STATES` の残りは「それ以外の状態」、remote だけの注文は分母の外）；should 3 → 設計 §16 の扱い、`ownsOffer` の fallback は `complete` だけ。

v3.2 → v3.3（設計 v5）: T-4 は `discovered` の集計と ledger の append の失敗、T-2a は `intentFromCreated` の `settleWindow` の復元。要件 v4.4（FR-9.2 (c)）。

v3.3 → v3.4（Codex `tasks-review4.md`、APPROVE WITH CHANGES）: 作成の所要時間の `via` の絞り込みを削除（`created` に `via` は無い）、設計 §17 を履歴に、FR-7.1 の完了を T-4 に。
