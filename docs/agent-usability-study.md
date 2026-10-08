# 検討: AI（Claude Code・Agent SDK・他の MCP client）から Router を使いやすくする

> 2026-10-08。5 レールの受信・送信が公開 Router で揃った（`docs/DEPLOY.md` §2d、`docs/public-brief-2026-10-08.md`）ので、次は「AI が実際に使う」側の整備。
> 本書は要件の前段（現状・摩擦・選択肢・推奨・owner の判断点）。独立レビュー（Codex）の結果は §9 で、§3〜§7 はその指摘を反映した後の版。実装は owner の判断の後、要件 → 設計 → タスクの順。

## 1. 目的

AI agent が **このリポジトリを clone せずに**、自分の鍵を手元に置いたまま、公開 Router で購入まで通せるようにする。対象の環境は 3 つ:

| 利用者像 | 今日の状態 |
|---|---|
| (a) Claude Code の利用者が**別のプロジェクト**から使う | 実質不可。署名の道具と手順（CLAUDE.md）と権限（`.claude/settings.json`）がこの repo の中にある |
| (b) Claude Agent SDK や他社の agent framework から**自動で**使う | 実質不可。鍵を注入するローカル MCP（`tools/t9-mcp-real.ts`）は実験用で Base x402 だけ、承認の機構も無い |
| (c) 審査員のデモ（README「Try it now」） | 可。ただし clone・`npm install` の回避策・repo の中で Claude Code を起動、が前提 |

## 2. 現状の流れ（何が repo に依存しているか）

1. clone → `npm install --legacy-peer-deps --ignore-scripts` → `npm rebuild fs-ext`（README）
2. `npm run wallet:new` → 鍵を `.env.local` に保存 → faucet（Base Sepolia USDC のみ案内）
3. `claude mcp add --transport http subetha-router https://router.subethalabs.com/mcp`
4. **repo の中で** Claude Code を起動（CLAUDE.md の手順と `.claude/settings.json` の `npm run sign` 許可が効く）
5. tool: `list_routes` → `quote` / `quote_url` → 人間の承認 → `npm run sign -- '<quote JSON>'` → `purchase`（5 引数） → `status`

repo に依存しているもの: 署名（`tools/sign-*.ts`、「製品コードではない」）、鍵の置き場（`.env.local`、作業ディレクトリ相対）、権限、手順（CLAUDE.md 191 行）、wallet 道具。hosted の MCP server 自体は鍵を持たず（`src/mcp/server.ts`: `inboundPayer=none`）、`instructions` も付けていない。

## 3. agent として使って見つかった摩擦（2026-10-08 の AC-18 と G-3″ の実測。F-11〜F-14 は Codex の指摘）

| # | 摩擦 | 証拠 | 影響 |
|---|---|---|---|
| F-1 | 署名と鍵が repo の外に出ていない（配布の問題） | `npm run sign` は `tools/` と `.env.local` 前提。`t9-mcp-real.ts` は実験用 | 利用者像 (a)(b) が成立しない |
| F-2 | quote の応答が重複する（offer が `quote` と `subject` の両方、`text` と `structuredContent` の両方）。purchase には `quote` 全体を渡す | 1 件 4〜6 KB（本書の実測。client がどこまで model に見せるかで実際のトークンは変わる） | トークン消費、転記ミス（1 文字違えば `quote_required` / fingerprint 不一致） |
| F-3 | 失敗の理由が途中で落ちる | HTTP は `reason` を返すが、型付き client（`src/client/index.ts`）で `reason` が、MCP（`src/mcp/tools.ts`）で status が落ちる。`rate_limited` に待ち時間が無い | AC-18 の 2 組の原因特定に手元の再現が要った（`docs/DEPLOY.md` §2d） |
| F-4 | 「持っている資産で払える経路」を agent が推論する | 10 route + 18 profile、CAIP-2 の network と mint の照合。**適合**は分かっても**払えるか**（残高・手数料・署名の対応）は別 | 誤選択、長い思考 |
| F-5 | 多レールの wallet 道具が無い | `wallet:balance` は Base だけ。Arc・Solana・Tempo の残高と faucet は CLAUDE.md に散在。Solana MPP は SOL も要る | 資金不足での失敗 |
| F-6 | 承認が agent の自制に依存する | `purchase` の `approval` は agent が渡す quoteId（束縛の証明であって人間の同意の証明ではない）。Tempo MPP は `sign` の時点で送金 | 設計原則「agent は代理で承認しない」を**機構で**担保していない |
| F-7 | `requestId`・`ownerKey`・`quote` の持ち回りが agent 任せ | 再利用で期限切れの quote、`ownerKey` 紛失で `status` が読めない。MCP session の切断・payer process の再起動・ローカル保存の喪失は別の事象 | session をまたぐと結果が読めない |
| F-8 | `npm run sign -- '<JSON>'` は shell 引数 | 4 KB の JSON の quoting、command log に quote と `ownerKey` が残る、shell injection の余地、鍵は cwd 相対 | 失敗しやすく、秘密が漏れる口 |
| F-9 | server の `instructions` が無い | `new McpServer({ name, version })`。tool description は充実している | 発見性の問題（承認の機構ではない） |
| F-10 | 動的 quote は caller ごとに 3 件/分 | `quotesPerMinutePerSource`。caller は X-Forwarded-For 由来で、無関係な利用者が同じ枠になり得る | agent の試行錯誤には厳しい。緩和の前に枠と回復の案内を返す |
| F-11 | 回復の案内が矛盾する | README「`paid_data_unavailable` は再試行で通る」は承認の取り直しを求めていない。MCP の `purchase` の説明「再起動後は quote を取り直す」は stateless の quote 持ち回りと食い違う | 承認なしの再購入を誘う |
| F-12 | 期限が 2 つある | quote の期限と、Solana の blockhash（約 1 分）。承認 → 直前に blockhash → 署名 → 送出を LLM の往復なしで行う必要がある。送出が不確かなまま期限が来ても未払いの証明にはならない | 失効と二重払いの境界が agent に見えない |
| F-13 | Tempo の crash window | `sign` で送金してから credential を返す／保存するまでに落ちると、signer の再実行で**2 回目の送金**が起きる。Router の冪等性では防げない | 二重払い |
| F-14 | 初回の install と結果の大きさ | native の rebuild・peer-dependency の回避策、鍵を stdout に出す wallet、project ローカルの設定、登録の scope が不明。配送される JSON は最大 256 KiB | 初回で詰まる、結果で context が溢れる |

## 4. 選択肢

### A. hosted MCP の改善（caller 側の install ゼロ）

- A-1 `instructions`（MCP の初期化で返る server の説明）に CLAUDE.md の要点（手順、レールごとの資金が動く時点、never の 4 つ、回復の規則）を載せる。F-11 の矛盾も同時に直す。
- A-2 失敗に `reason`・HTTP status・`retryAfterMs` を付ける（client → tools → server の経路全体。例外の sanitization は残す）。
- A-3 `list_routes` の**絞り込み**（持っている network + asset を渡す）。適合だけを返し、払えるかは quote と残高で判断する（SOL の要否は profile の属性として返す）。
- A-4 quote の opaque な handle（Router は状態を持たないまま HMAC で検証）。**後回し**: 認証はできるが小さくも秘密にもならず、B-2 のローカル保持で用が足りる。
- A-5 `outputSchema` と、結果の契約（`delivered` と client の受領・保存・両レグ・finality の区別を `structuredContent` で明示）。
- A-6 tool の注釈 `_meta["anthropic/requiresUserInteraction"]`（Claude Code の文書: bypass モードでも確認が出る。実機で検証する）。

### B. ローカルの payer（鍵を持つ側）を製品にする

- B-1 **1 つの payer 実装**に CLI と stdio MCP の 2 つの口。CLI は人間の設定・点検・回復用、MCP は agent 用。支払いの論理を 2 系統にしない。pin した最小の依存、native rebuild 無し。
- B-2 ローカル MCP `subetha-payer`: 内側で hosted Router を呼び、agent には `find_route`（A-3 相当）・`quote`・`purchase`（承認 → 署名 → 送出 → status を 1 つに）・`status` を見せる。agent に返すのは**短いローカルの購入参照**で、quote 全体・`ownerKey`・credential は payer が**耐久的に**保持する（F-2・F-7）。`requestId` は payer が生成・保存し、同じ id の別内容は拒む。process をまたぐ lock。
- B-3 **承認の機構**（本書の中心。Codex の定義）: 「鍵への排他的なアクセスを、agent が操作できない承認の境界の後ろに置き、同意は不変の支払い内容に束縛し、1 回で消費する」。
  - agent が渡す `approval` は束縛の証明であって同意ではない（現行方式は hosted 直叩きの後方互換として残す）。
  - TTY の確認は、agent がその端末と鍵に触れないときだけ有効。shell を持つ agent は PTY で応答を偽造できる（`isatty()` では足りない）。stdio MCP は自分の stdin を確認に使えない。
  - OS 通知だけでは不十分。**支払いの内容を表示した上での明示の保護された操作**が要る。
  - elicitation は「人間に確認を回す信頼できる client」でだけ有効（Claude Code は form / URL に対応、Agent SDK は hook で受ける。文書上の情報で、実機で検証する）。対応しない client や script が応答を合成できる構成では**fail closed**。
  - 鍵が平文の `.env.local` にあると、agent が payer を迂回して自分で署名できる。**鍵の保管と承認は一体**（§6 D-U4）: 保護された wallet / broker（per-payment の user presence）を優先し、keychain だけでは agent が取り出せるなら不十分。
  - Tempo MPP は `sign` で送金するので確認は署名の前。Solana MPP は承認 → blockhash → 署名 → 送出を 1 つの操作で。
- B-4 **耐久的な回復**: 副作用の前に意図を書き、送出中の crash は hash が無くても `unknown` で残す。自動の再署名・再 quote・再送はしない。SDK の支払いリトライと fetch polyfill は無効のまま。

### C. Claude Code の skill / plugin

- plugin に `.mcp.json`（B-2 の登録）と skill（手順）を同梱して配布できる（Claude Code の文書）。発見性と登録の便宜であって、安全の境界ではない。他の client の前提にもしない。

### D. 文書

- 短い設定と回復の案内（install、鍵、faucet、`unknown` のときの読み方）を**先に**。`llms.txt` / OpenAPI は後（署名・承認・回復を解決しない。手で保守する契約を増やさない）。Agent SDK の例（TypeScript）。

### E. 運用

- レート制限: 先に A-2 で枠と回復を返す。caller の識別（principal / API key）は別の要件。hosted の paymaster（運用者が払って後で請求）は「鍵を手元に置く」要求を満たさず、本人確認・濫用対策・課金が要るので対象外。
- 既存の wallet / hardware-backed の承認（rail の対応があれば）を、自前の OS 確認を作る前に評価する。

## 5. 推奨（Codex の指摘を反映した順序）

1. **A-1・A-2 と F-11 の案内の修正**（server と文書だけ。caller の install なし）。
2. **最小の payer（B-1 + B-2 + B-3 + B-4）**: 設定と回復の CLI、耐久的な保存、保護された確認、薄い stdio MCP。**最初の slice は Base x402 の静的 route 1 本**を別プロジェクトから: 絞り込み → quote 参照 → 保護された承認 → 署名と送出 → status と結果。動的 URL と hosted の handle は要らない。
3. Tempo MPP は crash-safe な `unknown` の扱いと一緒に、次に Solana MPP を期限の扱いと一緒に。wallet 道具の拡張と skill の同梱はその後。
4. A-3 は最初は listing の絞り込みとして、A-5 は結果の契約と一緒に。A-4・API principal・`llms.txt` は後回し。

## 6. owner の判断が要る点

| # | 論点 | 推奨 |
|---|---|---|
| D-U1 | パッケージ名と npm への公開（公開は owner の作業） | `@subetha/payer`（scope は owner の org） |
| D-U2 | 承認の方式（§4 B-3） | 既定は「鍵の保護された保管 + 支払い内容を表示した明示の確認」。Claude Code では tool 注釈 `requiresUserInteraction` + elicitation（実機で検証）、それが無い client は fail closed。現行の `approval` 引数は hosted 直叩きの後方互換 |
| D-U3 | agent から見える MCP は 1 つ（payer が hosted を内包）か 2 つか | 1 つ。hosted は「鍵を持たない client」向けにそのまま残す |
| D-U4 | 鍵の保管 | **平文の `.env.local` を既定にしない**。user 所有の固定の場所（project の外）に restrictive permission で置くのを最低線、保護された wallet / broker（per-payment の user presence）を本命として設計で比較する |
| D-U5 | レート制限の緩和（F-10） | まず `retryAfterMs` を返す。緩和は別の要件 |
| D-U6 | Agent SDK の例の言語 | TypeScript を先、Python は後 |
| D-U7 | 最初の slice の範囲 | Base x402 の静的 route 1 本（§5 の 2） |

## 7. 受け入れ条件の案（要件で確定する。後半は Codex の追加）

- AC-U1: repo の外の空のディレクトリで、payer の install → 鍵の作成（stdout に秘密を出さない）→ faucet → `claude mcp add` 1 行 → Claude Code が絞り込み → `quote` → 人間の確認 → `purchase` → `delivered`（最初の slice は Base x402 の静的 1 件、testnet）。repo の設定・native rebuild を使わない。対応 OS / runtime を明記。
- AC-U2: 人間の確認なしでは署名も送金も起きない。tool 引数・パイプ入力・PTY・鍵への直接アクセスによる自動承認は、宣言した脅威モデルの中で支払いを許可できない（sabotage で確認）。拒否・取消・UI 無し・承認の期限切れは、署名も支払いも起こさない。
- AC-U3: Agent SDK の script で AC-U1 と同じ購入（確認は人間に回る）。
- AC-U4: model に見える総バイト数を、purchase の引数だけでなく、workflow 全体と結果の取得まで含めて測る。
- AC-U5: quote / 承認 / 署名 / 送出 / 結果の間で process を再起動しても同じ購入のまま。動的の結果は payer が保持する `ownerKey` で読み直せる。
- AC-U6: 同時・重複の呼び出しと、各副作用の前後での process の終了で、支払いの試みは最大 1 回。不確かな結果は再起動後も `unknown` のまま残る。
- AC-U7: Tempo の送出後の timeout は「未払い」にならない。Solana の期限切れは、送出が不確かなら自動の差し替えを起こさない。
- AC-U8: 証拠は client の受領・保存して開き直した結果・両レグの tx・finality を別々に見る（`delivered` だけでは不十分）。
- AC-U9: hosted MCP の `instructions`・`reason`・`retryAfterMs`・`outputSchema` が既存の client の互換を壊さずに返る。

## 8. 本書で決めていないこと

- principal の発行（API key）と課金・利用者ごとの予算（一般公開の論点）。
- mainnet。

## 9. 独立レビュー（相談）の記録

| # | 日付 | reviewer | 要旨 |
|---|---|---|---|
| U-1 | 2026-10-08 | `gpt-6-astra`（read-only。初版の本書と CLAUDE.md・README・`src/mcp/*`・`tools/sign-*`） | 位置づけ: 「ローカルの payer は支持するが、**保護された承認と耐久的な回復を定義する要件**にする。『ローカル』だけでは何も守らない」。摩擦 F-1〜F-10 は概ね実在（F-1 は『不可』が言い過ぎ、F-9 は発見性の問題）、欠けていた F-11〜F-14 を追加。B-3 を「鍵への排他的アクセス + agent が操作できない承認の境界 + 内容に束縛した 1 回限りの同意」と定義し直し、平文 `.env.local` ではその境界が成り立たない（D-U4 を変更）。A-4 より B-2 のローカル保持を先に。順序は A-1/A-2 と案内の修正 → 最小 payer（Base x402 静的 1 本）→ Tempo → Solana MPP。§3・§4・§5・§6・§7 に反映済み |

Claude Code / Agent SDK 側の事実（文書の確認、2026-10-08。実機で検証する前提）: Claude Code は MCP の elicitation（form / URL）に対応、tool の `_meta["anthropic/requiresUserInteraction"]` で bypass モードでも確認が出る、`PreToolUse` hook は bypass でも deny できる、Agent SDK は `Elicitation` / `ElicitationResult` hook で受ける、plugin は `.mcp.json` と skill を同梱できる。server の `instructions` と `outputSchema` が model にどう見えるかは文書に明記が無い。
