# タスク分解: agent 用の payer（`@subetha/payer`）と hosted MCP の整備（第 1 slice）

> 2026-10-08、第 2 版。入力は `docs/agent-payer-requirements.md`（第 3 版、R-3r APPROVE。D-U1〜D-U7・D-A1・D-A2 は owner 採用）と `docs/agent-payer-design.md`（第 3 版、D-3r APPROVE WITH CHANGES 反映済み。owner「進めて良いです」2026-10-08、PR #122・#123）。
> 以下「設計 §x」「要件 FR-x」はそれらを指す。本書はタスクフェーズの成果物で、コード・実行結果・合格の主張は含まない。記載のコマンドは**計画であり未実行**。
> 先行の `docs/mpp-solana-tasks.md` と同じ形（§0 の規則、1 タスク 1 PR、変異の表、独立レビュー）。
> **範囲（第 1 slice）**: macOS のみ（D-A4）、Base Sepolia USDC の x402 で静的 route `md-mpp-eth-snapshot` を、この repo の外の Claude Code から購入まで。session あり、envelope なし。
> 第 1 版は独立レビューで REJECT（7 項目。§4 T-1）。第 2 版で反映: §3 を「実装の主担当」と「最終の受け入れの主担当」に分けて 1 項目 1 主担当に、P-3 の crash と回復の行列を停止点ごとの表に（§2 P-3c）、観測点を実行できる形に（AC-A9 は秘密を持つ余計な欄の注入、FR-A8 は実在する preload、AC-A2 は daemon と shim の UI の回数、`instructions` は initialize、osascript の手動確認の手順）、P-5 の clean install の手順（tarball・隔離した prefix と cache と HOME・registry への接続の許可・install した bin の実行・spy を使わない smoke）、依存（P-3 は H-1 の契約だけ。配備は G-A2 の前提）、§0 の追加（skip と失敗の区別・停止の規則・G-A2 の両レグと接続・既存の鍵に触らない・最終レビューの範囲・`FaultPoints` の interface）、PR の分割（P-1a/b、P-3a/b/c、P-4a/b、P-5a/b）。

## 0. 全タスク共通

- **担当**: 親（controller）が状態・commit を持ち、実装後に実ソースを読み戻してテストを実際に実行する。レビューは `gpt-6-astra`・read-only。writer は 1 つ。
- **順序**: まず落ちるテストを書き、赤を確かめてから実装する。完了条件の試験は**守っているコードを外して落ちること**（sabotage）を確かめ、結果を PR に書く。**変異の前に commit する**（復元は commit から）。
- **完了コマンド**: Router 側（H-1・P-0）は focused → `npx tsc --noEmit -p .` → `npm test`（Linux `node:22-bookworm` で実行した結果を要する。既知の flake は単独で再実行）。payer 側（P-1〜P-5）は `packages/payer` で focused → `npm run types` → `npm test`（macOS で実行。Docker の Linux では単体と wire（UI は spy）を回すが、Linux の成立は主張しない。設計 §8）。**skip と失敗を区別して報告する**（skip は gate 付きの行だけ。理由を書く）。
- **停止の規則**: 実装中に設計と食い違う事実（実機の挙動、SDK の制約）や、完了条件の測定が設計の数値と合わない（AC-A6 の 4 KB、NF-A2 の +1 秒）ことが出たら、**実装を続けずに**親が設計の改訂か owner の判断に戻す。
- **資金**: 親の操作で資金が動くのは **G-A2 だけ**。両レグが動く: 受信は payer の使い捨て鍵の Base Sepolia USDC（10,000 base unit × 1〜2 件。入金は owner の操作）、送信は **Router の鍵の Tempo pathUSD**（Provider B へ。運用者の資金）。
- **外部への接続**: P-1〜P-5 は fake の Router（in-process の MCP server）で閉じる。例外は (a) P-3a の**読取だけ**の smoke（hosted の `list_routes` を 1 回。gate `PAYER_HOSTED_READ=1`。日時を記録。完了条件には含めない）、(b) P-5b の clean install での **npm registry からの依存の取得**（`npm install` の通常の接続。tarball 自体は手元）。H-1 は Router の試験だけで、配備は owner の確認。G-A2 で hosted MCP・Provider B（Router 経由）・x402.org の facilitator（Router 経由）・Base Sepolia と Tempo の RPC（finality の読取。公開 RPC）に接続。gate の対象は固定した commit と公開した version（記録）。
- **鍵**: `packages/payer` の試験の鍵は毎回の乱数。実鍵は `wallet new` が作る暗号化 store だけ。**既存の使い捨て鍵（`.env.local`・`.claude_workflow/local/*.env`）には触らない**（G-A2 の入金は owner）。**鍵・passphrase・合言葉・RPC の URL・ローカルの絶対パスを docs・PR・ログに書かない**。
- **test-only の境界**: fake・fault point の実装・test entry は `packages/payer/test/` にだけ置き、`files` に含めない。**production には `FaultPoints`・`Signer`・`RouterTransport`・`ConfirmUi`・`Clock` の interface と呼び出し点を置いてよい**（既定の実装は no-op / 本物）。P-1a で「`npm pack --dry-run` の一覧に `test/` が無い」「`bin/`・`dist/` が `test/` を import しない」の試験を置き、以後の全タスクで走る。
- **既存の挙動で意図して変えるもの**（各タスクに明記）: (a) hosted MCP: 失敗の応答・`status` の `found: false` に欄を**加える**、`instructions`・`outputSchema`・`_meta` を**加える**、`railHintOf`・`nextStep`・`quote_url`・`purchase`・`approval` の説明文を直す（H-1）、(b) HTTP の射影: 静的 quote の `destination` に `payTo`・`decimals` を**加える**（H-1）、(c) client: 失敗の `reason`・HTTP status・`Retry-After` を保持（H-1）、(d) `tools/sign-dispatch.ts`: EVM の分類を分離し、MPP・Solana の import を遅延（挙動は同じ。P-0）、(e) `src/shared/` への抽出と re-export（挙動は同じ。P-0）、(f) README「Try it now」を payer 経由に（P-5b）。
- **独立レビュー**: 各 PR は差分のレビュー。加えて **実ソース全体のレビュー**を 2 回: **P-3c の PR で P-1a/b・P-2・P-3a/b/c**（store・lock・signer・daemon。SR-A1・A3・A5〜A9）、**P-5b の PR で P-4a/b・P-5a/b と、それまでの変更の累積**（UI・shim・CLI。SR-A2・A4・A5）。
- **最終の受け入れ**: 各タスクの完了条件は fake の中の受け入れ。**AC-A1 と AC-A10 の最終の受け入れは G-A2**（Claude Code の実機と testnet）。

## 1. 依存

```
H-1   hosted MCP の改善（Router 側。独立）
P-0   src/shared の抽出・sign-dispatch の分離（Router 側）             ← なし
P-1a  packages/payer の骨格・Summary・pack の検査                      ← なし
P-1b  store（鍵・台帳・lock・paths）                                   ← P-1a
P-2   vendor と src/sign（EVM）                                        ← P-0、P-1a
P-3a  daemon: 起動・session・socket・Router client                      ← P-1b、P-2。H-1 は**契約**（応答の形）だけ。配備は不要（fake）
P-3b  daemon: 承認の記録・状態機械                                      ← P-3a
P-3c  daemon: 回復と crash の行列（harness）                            ← P-3b
P-4a  確認 UI（macOS）                                                  ← P-3b
P-4b  shim                                                              ← P-4a
P-5a  CLI                                                               ← P-4b
P-5b  README・packaging・clean install                                 ← P-5a
G-A1  owner の npm publish                                              ← P-5b
G-A2  testnet の購入（AC-A1・AC-A10 の最終）                            ← G-A1、**H-1 の配備**（owner）
```

## 2. タスク

### H-1 — hosted MCP の改善（設計 §6、FR-A24〜A29、AC-A7）

- **範囲**: `src/client/index.ts`（失敗の `reason`・`httpStatus`・`retryAfterMs`（`Retry-After` の秒と HTTP-date）、`status` の失敗の分類 `not_found` / `unauthorized` / `malformed` / `transport`）、`src/http/projection.ts`（静的 quote の `destination.payTo`・`decimals`。route 設定から）、`src/mcp/tools.ts`（失敗に欄を加える、`status` の `found: false` に `reason`、`railHintOf` の `solana/charge`、`nextStep` の Tempo 限定）、`src/mcp/server.ts`（`instructions`、`outputSchema`、`purchase` の `_meta`、`purchase`・`quote_url`・`approval` の説明）、README の `paid_data_unavailable` の案内、CLAUDE.md の一致。
- **成果物**: 上の変更、`tests/wire/mcp-hosted-improvements.test.ts`（新）、既存の `tests/wire/mcp-*.test.ts`・`tests/unit/client*.test.ts`・`tests/unit/projection*.test.ts` への追加。
- **完了条件（wire・unit。Linux）**: **initialize の応答**（SDK の `Client.getInstructions()`）に `instructions` がある。失敗の行列: `rate_limited` → `retryAfterMs`（`Retry-After: 30` → 30,000、HTTP-date → 差分、無し → 60,000）、`quote_failed` → `reason`、`internal_error` → `reason` 無し、`reason` が `^[a-z_]{1,64}$` に合わなければ落ちる。`status` の `found: false` に 4 種の `reason`。`outputSchema` が全 tool にあり、成功・失敗・`internal_error` の `structuredContent` が schema に合う（SDK の検証を通す）。`tools/list` の `purchase` に `_meta["anthropic/requiresUserInteraction"] === true`。静的 quote の `destination.payTo` が route 設定の値、`decimals` が表の値（動的は変わらない）。**既存の `tests/wire/mcp-*.test.ts` を変えずに通す**（出力の形 `outcome` / `found`・`projection` / 動的の `untrusted` の包み）。`railHintOf` が `solana/charge` の offer で「MPP。署名だけ。Router が送出」の文、`nextStep` の「credential を作った時点で支払い済み」が `tempo/charge` だけ。
- **focused**: `npx vitest run tests/wire/mcp-hosted-improvements.test.ts tests/wire/mcp-*.test.ts tests/unit/client*.test.ts tests/unit/projection*.test.ts`（全 pass、skip 0）。
- **sabotage**: `reason` の filter を外す → 形式外の `reason` が通って試験が落ちる／`Retry-After` の解析を外す → 30,000 の試験が落ちる／`_meta` を外す → `tools/list` の試験が落ちる／`destination.payTo` を外す → 射影の試験が落ちる／`railHintOf` の分岐を戻す → MPP の文の試験が落ちる。
- **配備**: merge 後、owner の確認でイメージの入れ替え（`docs/DEPLOY.md` §2c の手順。rollback の控えを残す）。公開の initialize で `instructions`、`tools/list` で `_meta` を確認し、**配備した commit と image を記録**（G-A2 の前提）。

### P-0 — `src/shared/` の抽出と `sign-dispatch` の分離（設計 §3.8、U-A5）

- **記録（2026-10-09、PR #129）**: 実装で設計から 2 点逸脱した（設計 §3.8 に反映済み）: 全レールの dispatcher は静的 import のまま（同期の `classifyOffer` を変えない）、`src/net/` は抽出しない（既に Router に依存せず、第 1 slice の payer は使わない）。`src/shared/networks.ts` は base58 の検査を自前の復号にして外部依存を無くした。

- **範囲**: `src/config.ts` の network・asset の表と `evmChainIdOf`・`knownNetworkOf`・`knownAssetOf`・`assetKeyOf`・`networkFamilyOf`・`isWellFormedPayTo` を `src/shared/networks.ts` に、`src/net/guarded-fetch.ts`・`bounded-body.ts` の純粋な部分を `src/shared/net/` に、`src/adapters/inbound/x402-svm.ts` の `buildSvmTransactionMessage`・定数を `src/shared/svm-message.ts` に抽出し、元の module は re-export。`tools/sign-dispatch.ts` を `tools/sign-classify-evm.ts`（`classifyEvmOffer`。`mppx`・Solana・`mpp-payer` を import しない）と `tools/sign-dispatch.ts`（`classifyOffer`。MPP・Solana の module は `await import`）に分ける。`mpp-payer.ts` の `checkTempoChallenge` は `tools/sign-check-tempo.ts` に移し、両方から import。
- **成果物**: 上の変更、`tests/unit/sign-classify-evm.test.ts`（新。`sign-dispatch.test.ts` の EVM の行を写す + module graph の行）、既存の試験は**変えない**。
- **完了条件（unit・wire。Linux）**: 既存の全試験が変更なしで通る。`classifyEvmOffer` が `sign-dispatch.test.ts` の EVM の行と同じ結果、Solana / MPP の offer に `refuse`。子 process で `node --import tsx tools/sign-classify-evm.ts` 相当を読み込んだ後の module graph（`process.moduleLoadList` と `import.meta.resolve` の記録）に `mppx`・`@solana/` が無い。`classifyOffer` の結果が分離前と同じ（全行）。
- **focused**: `npx vitest run tests/unit/sign-classify-evm.test.ts tests/unit/sign-dispatch.test.ts tests/unit/sign-run.test.ts tests/unit/mpp-solana-challenge-check.test.ts tests/unit/svm-payer.test.ts`。
- **sabotage**: `classifyEvmOffer` に `mppx` の静的 import を足す → graph の試験が落ちる／re-export を 1 つ外す → 既存の試験が import で落ちる。

### P-1a — `packages/payer/` の骨格・`Summary`・pack の検査（設計 §2.1・§3.6）

- **範囲**: `package.json`（`name`、`bin: bin/subetha-payer`、`files: ["bin","dist"]`（README は npm が常に含める）、`engines`、pin した依存、`type: module`）、`bin/subetha-payer`（`#!/bin/sh` の `exec node --disable-sigusr1 …`）、`src/bin.ts`（サブコマンドの振り分けだけ）、`src/protocol/summary.ts`（zod `strict` の `Summary` 群と失敗の形）、`test/` の置き場と `vitest` の設定（macOS と Docker）。
- **成果物**: 上の変更、`test/unit/{summary,pack}.test.ts`。
- **完了条件（unit。macOS・Docker）**: summary: 余計な欄が落ちる、例外の `message` を持つ object が `internal_error` になる、**秘密を持つ余計な欄（`{ privateKey: "<既知の値>" }`）を注入すると検証が落として応答に出ない**。pack: `npm pack --dry-run --json` の一覧に `test/` のファイルが無く `bin/subetha-payer` と `dist/bin.js` がある、`dist/**` の import に `test/` が無い（`grep`）。
- **focused**: `cd packages/payer && npx vitest run test/unit/summary.test.ts test/unit/pack.test.ts`。
- **sabotage**: `strict()` を外す → 注入の試験が落ちる／`files` から `bin` を外す → pack の試験が落ちる／`dist/bin.js` に `test/` の import を足す → grep の試験が落ちる。

### P-1b — store（鍵・台帳・lock・paths）（設計 §3.3・§3.4 の台帳・§3.7、FR-A10・A21、SR-A6）

- **範囲**: `src/store/keys.ts`（scrypt N=2^17・HKDF・AES-256-GCM・`verifier`・version）、`src/store/ledger.ts`（hash 連鎖・sealed・fsync・途切れた末尾の切り詰め・head の検査・version）、`src/store/lock.ts`（`link` 方式・stale の判定・人間の reclaim の関数・保持者の inode 検査）、`src/store/paths.ts`（設定ディレクトリと全ファイルの検査）。fs は interface（`StoreFs`）経由で、試験は `EROFS`・`EIO`（fsync）を注入できる。
- **成果物**: 上の変更、`test/unit/{keys,ledger,lock,paths}.test.ts`。
- **完了条件（unit。macOS・Docker）**: 鍵: 既知の passphrase と salt で `master`・`kek`・`lek`・`verifier` が固定の値（ベクトルを test に置く）、誤った passphrase で `verifier` 不一致、鍵ファイルの復号が tag で失敗する、version 違いで `store_unsupported_version`、passphrase に改行は拒否。台帳: 書いた行の hash 連鎖が検証を通る、途中の 1 バイトの改変で `store_corrupt`、末尾の途切れた行が切り詰められて次の append が続く、sealed の欄が `lek` で復号でき平文に秘密が無い、head の巻き戻りで `store_rollback`、fsync の `EIO` で「書けなかった」と返り以後の append を拒む。lock: 同時の 2 contender（2 process）で `link` の成功は 1 つ、stale（死んだ pid）では取得せず `daemon_lock_stale`、生きた pid で `daemon_already_running`、reclaim の関数は生きた pid を拒む、外から `unlink` されると保持者の検査が `lock_lost`。paths: symlink・mode・owner の違いで拒否、`realpath` が `$HOME` の外で拒否。
- **focused**: `npx vitest run test/unit/keys.test.ts test/unit/ledger.test.ts test/unit/lock.test.ts test/unit/paths.test.ts`。
- **sabotage**: hash の検証を外す → 改変の試験が落ちる／切り詰めを外す → 続きの append の試験が落ちる／`link` を `writeFile` に → 同時取得の試験が落ちる／`verifier` の照合を外す → 誤 passphrase の試験が落ちる／symlink の検査を外す → paths の試験が落ちる。

### P-2 — vendor と `src/sign`（EVM だけ）（設計 §3.8、SR-A7 の署名の検査、AC-A8 の移植の行）

- **範囲**: `packages/payer/scripts/vendor.ts`（**`src/shared/networks.ts`・`tools/sign-classify-evm.ts`・`tools/x402-payer.ts` の 3 つだけ**を `src/vendor/` にコピーし import path を書き換える。`src/shared/svm-message.ts` と `src/net/*` は第 1 slice では含めない = 設計 §3.8 の一覧）、`src/sign/index.ts`（`sign(offer, key)`: `classifyEvmOffer` → `chainId === 84532` の gate → `createX402Payer(key).credentialFor`。他は `rail_not_enabled`。**FR-A14 の 3 者の照合は P-3b**）、CI の検査（vendor と source の一致、`packages/payer` の依存に `mppx`・`@solana/*` が無い）。
- **成果物**: 上の変更、`test/unit/sign.test.ts`（`tests/unit/sign-dispatch.test.ts` の EVM の行の移植 + gate + `rail_not_enabled`）、`test/unit/vendor.test.ts`。
- **完了条件（unit。macOS・Docker）**: 移植した行が同じ結果（拒否する offer は拒否）。Arc（`eip155:5042002`）の offer は `classifyEvmOffer` では `x402-evm` だが `sign` では `rail_not_enabled`。Solana / Tempo の offer は `rail_not_enabled`（`refuse` 経由）。vendor が source と byte 一致（path の書き換え以外）。`package.json` と lockfile に `mppx`・`@solana/` が無い。
- **focused**: `npx vitest run test/unit/sign.test.ts test/unit/vendor.test.ts`。
- **sabotage**: `chainId` の gate を外す → Arc の試験が落ちる／vendor のコピーを 1 文字変える → 一致の試験が落ちる／依存に `mppx` を足す → 依存の試験が落ちる。

### P-3a — daemon: 起動・session・socket・Router client（設計 §3.1・§3.2・§3.6・§3.8、FR-A6〜A9・A11、SR-A1・A5・A6・A9）

- **範囲**: `src/daemon/startup.ts`（`--disable-sigusr1` の要求、禁止の env・flag の一覧、env の scrub、paths、GUI の検査（interface `ConfirmUi.available()`。P-4a で実装）、lock、TTY の passphrase と合言葉、`verifier`、install の seal、復号、socket、回復の呼び出し（P-3c））、`src/daemon/session.ts`、`src/daemon/server.ts`（socket の JSON lines、`Summary` の検証、接続ごとの直列、`ref` の mutex の枠）、`src/router/client.ts`（Streamable HTTP の MCP client。H-1 の契約: `reason`・`retryAfterMs`・`status` の `reason`・静的 quote の `destination.payTo`）、`src/daemon/interfaces.ts`、`test/harness/`（fake Router = in-process MCP server、`daemon-test-entry.ts`、子 process の起動と `SIGKILL`、counter のファイル）。
- **成果物**: 上の変更、`test/wire/{startup,session,socket,router-client,latency}.test.ts`、`test/wire/hosted-list-routes.test.ts`（gate `PAYER_HOSTED_READ=1`。smoke。完了条件外）。
- **完了条件（wire。macOS。Docker は同じ）**: startup: `node dist/bin.js daemon`（flag なし）は `startup_refused: sigusr1_enabled`（exit 2、固定の文）、`NODE_OPTIONS="--require <test/fixtures/inert-preload.cjs>"`・`DYLD_INSERT_LIBRARIES=/nonexistent.dylib`・`node --disable-sigusr1 --inspect=0 dist/bin.js daemon` の各 1 行で `startup_refused: forbidden_env|forbidden_flag`（**passphrase の prompt が出る前**。prompt の spy が 0）、起動後の `process.env` に禁止の変数が無い（test entry が dump）、paths の違いで `startup_refused`、lock が stale なら `daemon_lock_stale` で終了、passphrase 誤り 3 回で `bad_passphrase` 終了、install の seal の初回保存が lock の後（fault point `after:lock`・`before:seal` で `SIGKILL` → seal 無し／lock の残骸）、改変で `install_changed`、daemon に `SIGUSR1` を送って 2 秒待っても `127.0.0.1:9229` が閉じている。session: TTL 経過で `locked`、`purchase` が `locked`、`quote`・`status` は答える。socket: `Summary` 外の欄・例外の message が応答に出ない（注入の fixture）、多重接続で直列（2 接続の `ping` の順序）、`ref` が無い `purchase` は `unknown_ref`。router-client: fake Router の応答の形（成功・`rate_limited` + `retryAfterMs`・`quote_failed` + `reason`・`status` の 4 種）を正しく写す、timeout 30 秒で `router_unavailable`、再試行 0（fake の counter）。
- **focused**: `npx vitest run test/wire/startup.test.ts test/wire/session.test.ts test/wire/socket.test.ts test/wire/router-client.test.ts test/wire/latency.test.ts`（latency: NF-A2 の差 ≤ 1,000 ms。超えたら §0 の停止の規則）。
- **sabotage**: `--disable-sigusr1` の要求を外す → `sigusr1_enabled` の試験が落ちる／禁止の一覧から `DYLD_INSERT_LIBRARIES` を外す → その行が落ちる／seal を lock の前に書く → fault point の試験が落ちる／`Summary` の検証を外す → 注入の試験が落ちる／timeout を外す → `router_unavailable` の試験が止まる（test の timeout で落ちる）。

### P-3b — daemon: 承認の記録・状態機械（設計 §3.4、FR-A14・A18〜A20、SR-A2 の記録側・SR-A3・SR-A8、AC-A3）

- **範囲**: `src/daemon/record.ts`（`ApprovalRecord` の構築・`subject` との照合・`render`・署名の直前の offer との照合・期限と `locked` の検査）、`src/daemon/purchase.ts`（状態機械: `quoted` → `approved` → `sign_intent` → `signed` → `submit_intent` → `submitted` → `result`。各遷移の fsync。`ref` の mutex。`ConfirmUi` の呼び出し（P-3b は spy）。`Signer`（P-2 の `sign`）。`requestId` と `ref` の生成）。
- **成果物**: 上の変更、`test/unit/record.test.ts`、`test/wire/purchase.test.ts`。
- **完了条件（unit・wire。macOS・Docker）**: record: fake Router の quote から記録が全欄埋まる、`subject` の 1 欄の不一致で `quote_inconsistent`、`render` が同じ記録で同じ文字列（制御文字・改行以外の空白の除去）、offer の各欄（`scheme`・`network`・`asset`・`amount`・`payTo`・`extra.expiresAt`・`extra.challengeNonce`・`extra.routeBinding`・`extra.fundsMoveOnCredential`）の 1 つを変えると `approval_mismatch`、期限切れ・`locked` で無効、承認が別の記録の hash なら無効。purchase: 正常系で台帳が 7 行の順（`quoted`〜`result`）、各行の hash 連鎖、`signed` の credential が sealed、`approved` が UI spy の承認の後にだけ書かれる、UI の拒否で `approved` 無し・署名 0、同じ `ref` の 2 回目が同じ結果で署名 1（AC-A3）、承認後に quote を取り直すと古い承認が無効、`ref` は 13 文字で台帳と衝突しない、`requestId` は UUID、**fake Signer と fake Router の counter が正常系で 1 ずつ**（進まない実装を除く）。
- **focused**: `npx vitest run test/unit/record.test.ts test/wire/purchase.test.ts`。
- **sabotage**: offer の照合から `payTo` を外す → mismatch の試験が落ちる／`approved` の行を UI の前に書く → 順序の試験が落ちる／mutex を外す → 2 回目の試験で署名 2 になり落ちる／`render` の sanitize を外す → 制御文字の試験が落ちる。

### P-3c — daemon: 回復と crash の行列（設計 §3.4 の回復・§8、FR-A20〜A22、SR-A3・SR-A8、AC-A4・A5・A9）

- **範囲**: `src/daemon/recover.ts`（identity の検査、`status` の 4 分類、回復の表、`unknown` の読み直し、`closed_by_operator` の記録）、harness の fault point（`before:<state>` / `after:<state>` / `transport:before-response` / `transport:after-response`）と `SIGKILL`、counter の永続（fake Signer・fake Router は呼び出しをファイルに追記）。
- **成果物**: 上の変更、`test/wire/{crash-matrix,recovery}.test.ts`、`test/wire/secrecy.test.ts`（AC-A9。daemon の経路）。
- **完了条件（wire。macOS・Docker）**: **crash の行列**（各行: 停止点で `SIGKILL` → 人間の reclaim を模して lock を `unlink`（harness が `lock reclaim` の関数を呼ぶ）→ 再起動 → 検査）:

  停止点は fault point の名前で、`after:<row>` = その行を fsync した直後、`before:<row>` = その行を書く直前（= 直前の処理が終わった後）。counter は「crash の時点」と「回復が終わった後」を分ける。

  | 停止点 | 台帳の終端（再起動後） | signer（crash 時） | purchase（crash 時） | 回復の後の状態 | signer（回復後） | purchase（回復後） |
  |---|---|---|---|---|---|---|
  | `before:quoted` | 行なし | 0 | 0 | `ref` 無し | 0 | 0 |
  | `after:quoted` | `quoted` | 0 | 0 | 続行可。**明示の再承認**（spy）の後に正常系へ | 1 | 1 |
  | `after:approved` | `approved` | 0 | 0 | 続行可。承認は取り直し（古い承認は無効）→ 正常系へ | 1 | 1 |
  | `after:sign_intent`（署名を呼ぶ前） | `sign_intent` | 0 | 0 | `unknown`。再署名しない | 0 | 0 |
  | `before:signed`（署名が返った後、行を書く前） | `sign_intent` | 1 | 0 | `unknown`。再署名しない | 1 | 0 |
  | `after:signed` | `signed` | 1 | 0 | fake の `status` が `not_found` → 同じ credential で提出 1（credential の byte 一致）→ `submitted` → `result` | 1 | 1 |
  | `after:submit_intent`（送る前） | `submit_intent` | 1 | 0 | `unknown`。再送しない（fake の `status` が `not_found` でも） | 1 | 0 |
  | `transport:before-response`（送った後、応答の前） | `submit_intent` | 1 | 1 | `unknown`。再送しない | 1 | 1 |
  | `transport:after-response` / `before:submitted` | `submit_intent` | 1 | 1 | `unknown`。再送しない。fake の `status` が `found`（一致）なら Router の終端に | 1 | 1 |
  | `after:submitted` | `submitted` | 1 | 1 | `status` の `found` で終端 | 1 | 1 |

  **「増えない」の範囲**: 回復が終わった後に `purchase(ref)` を再び呼んでも、signer と purchase の counter は「回復後」の列から増えない（`quoted`・`approved` からの続行は**明示の再承認**を伴う 1 回の正常系で、その 1 ずつが上限）。**回復の表**（台帳の終端 × fake の `status`）: `signed` × `unauthorized`／`malformed`／`transport`／identity 不一致 → `unknown`・提出 0、`signed` × 期限切れ → `expired_after_sign`・提出 0、`submitted` × `found`（一致）→ Router の終端（`delivered`・`paid_data_unavailable`・`rejected`）、`submitted` × `awaiting_payment` → `unknown`、`unknown` × 後の `found`（一致、`delivered`）→ `delivered` に進む、`unknown` × `not_found` → `unknown` のまま（自動で未払いにしない）、`closed_by_operator` は理由付きで終端。回復と `purchase` の同時実行で署名 1。`EROFS`：`sign_intent` の前で止まり署名 0。fsync `EIO`: 以後の副作用 0。AC-A9（daemon の経路）: 既知の実値（鍵・passphrase・合言葉・credential・challenge の全文）を平文・base64・hex で、応答・stderr・台帳の平文の欄・エラー文から grep して 0（sealed の欄は除く）。
- **focused**: `npx vitest run test/wire/crash-matrix.test.ts test/wire/recovery.test.ts test/wire/secrecy.test.ts`。
- **sabotage**: `sign_intent` の fsync を署名の後に移す → `after:sign_intent` の行が signer 1・台帳 `approved` で落ちる／提出の例外の「`not_found` だけ」を外す → `unauthorized` の行が落ちる／identity の検査を外す → 不一致の行が落ちる／`submit_intent` の後の再送禁止を外す → `transport:after-response` の行で purchase 2 になり落ちる／台帳の `sealed` を平文に → AC-A9 が拾う。
- **独立レビュー**: P-1a/b・P-2・P-3a/b/c の実ソース全体。

### P-4a — 確認 UI（macOS）（設計 §3.5、FR-A12・A13・A15、SR-A2・A4）

- **範囲**: `src/ui/osascript.ts`（spawn `["-"]`、env の allowlist、script の生成と escape、`giving up after 120`、hidden answer、3 行の解析、passphrase の照合、拒否の条件、`available()`）、`src/ui/render.ts`（sanitize）。
- **成果物**: 上の変更、`test/unit/{osascript-script,parse,render}.test.ts`、`test/wire/ui-spawn.test.ts`（`osascript` を **fake の実行ファイル**（test/fixtures の shell script）に差し替えて spawn の引数・env・stdin を記録）。
- **完了条件（unit・wire。macOS）**: script: escape（`\` → `\\` が `"` → `\"` より先、改行は `return` の連結、制御文字の除去）、合言葉が先頭行、表示文に上流の本文が無い。parse: 3 行・`Approve`・`false`・末尾の改行 1 つで `approved`、Cancel・`gave up: true`・2 行・4 行・exit ≠ 0・空で拒否。spawn: 引数が `["-"]`、env が allowlist だけ、表示文は stdin にだけ（argv に無い）。passphrase の照合（`verifier`）、不一致で拒否、`locked`・期限切れで拒否。
- **手動の確認（1 回。記録に日時と結果）**: 使い捨ての store（`wallet new` を一時ディレクトリで）で、`subetha-payer ui-check`（production のサブコマンド。固定の試験文で dialog を出し、結果の分類だけを表示する）を実行: (1) Approve + 正しい passphrase → `approved`、(2) Approve + 誤った passphrase → `rejected: bad_passphrase`、(3) Cancel → `rejected: cancelled`、(4) 120 秒放置 → `rejected: timeout`、(5) 表示文に `"` と `\` と改行を含む fixture → dialog が崩れず `approved`。
- **focused**: `npx vitest run test/unit/osascript-script.test.ts test/unit/parse.test.ts test/unit/render.test.ts test/wire/ui-spawn.test.ts`。
- **sabotage**: escape の順序を入れ替える → `\"` の試験が落ちる／3 行の要求を緩める → 4 行の試験が落ちる／allowlist を外す → env の試験が落ちる／表示文を argv に乗せる → spawn の試験が落ちる。

### P-4b — shim（設計 §4、FR-A16・A18・A19・A23、SR-A2、AC-A2・A6）

- **範囲**: `src/shim/`（stdio MCP server、5 tool、`outputSchema`、`purchase` の `_meta`、`instructions`、elicitation の表示、`daemon_unavailable`、`preview` 512 バイト）。
- **成果物**: 上の変更、`test/wire/{shim,approval-sabotage,bytes}.test.ts`。
- **完了条件（wire。macOS・Docker）**: shim: 5 tool の `outputSchema` と `structuredContent` の一致、`purchase` の `_meta`、`instructions`、`daemon_unavailable` の案内、elicitation の応答（`accept` / `cancel` / 非対応）が daemon への要求に含まれない（socket の記録）、`preview` が 512 バイトで `bytes` が全長。**AC-A2**（UI は spy。各行で fake Signer 0・台帳に `sign_intent` 無し・**daemon の UI の回数**と **shim 起点の UI の回数 = 0** を別に記録）: (a) `purchase` の引数に `approved: true` 等 → 無視（schema で拒否）、UI 0、(b) shim の stdin に `yes` → 無視、(c) PTY 経由の shim → 同じ、(d) SDK の `Client` で shim に接続し elicitation に `accept` → daemon の UI は 1 回出るが spy が拒否 → 署名 0、(e) `SUBETHA_PAYER_PASSPHRASE=x` 等の env → daemon は起動を拒む（P-3a）、(f) `keys.json` を読んで復号を試みる → 失敗、(g) `available()` が false → `purchase` は `approval_unavailable`、UI 0、(h) 偽の shim（socket に `{ method: "purchase", params: { ref, approved: true } }`）→ 無視、UI は 1 回（spy が拒否）、署名 0、(i) 起動の禁止（P-3a の行の参照）、(j) `locked` → UI 0、(k) UI の表示中に期限切れ（spy が 130 秒を模す）→ UI 1・署名 0、(l) 表示した記録と offer の不一致（fixture）→ `approval_mismatch`、署名 0。人間の取消（spy が Cancel）→ UI 1・署名 0。**AC-A6**: 固定 fixture（静的 route 1 件、本文 2 KiB）で `find_routes`（`hold` 1 件）→ `quote` → `purchase` → `status` の `content[].text` と `structuredContent` の JSON の UTF-8 合計 ≤ 4,096 バイト（本文の `preview` を含む、`includeBody` は使わない）。測った値を PR に書く。
- **focused**: `npx vitest run test/wire/shim.test.ts test/wire/approval-sabotage.test.ts test/wire/bytes.test.ts`。
- **sabotage**: elicitation の応答を daemon に渡す → (d) の記録が落ちる／`_meta` を外す → shim の試験が落ちる／`subject` の要約に quote 文書を含める → AC-A6 が落ちる／`purchase` の schema を緩める → (a) が落ちる。

### P-5a — CLI（設計 §5、FR-A4 の `claude mcp add`・FR-A5、AC-A9 の CLI の経路）

- **範囲**: `src/cli/{wallet,status,inspect,config,lock,ui-check}.ts`。`wallet balance` は Base Sepolia USDC（公開 RPC。設定で変えられる）。
- **成果物**: 上の変更、`test/wire/cli.test.ts`。
- **完了条件（wire。macOS・Docker）**: `wallet new` の stdout と stderr に鍵・passphrase が無い（平文・base64・hex。既知の乱数を test から注入）、address だけが出る。`wallet address`。`wallet balance` は fake の RPC で base unit を表示。`status`・`inspect` が台帳と fake Router の `status` を突き合わせて表示（`Summary` 経由）、`inspect --close` は TTY の確認が要る（非 TTY で拒否）。`lock reclaim` は生きた pid を拒み、死んだ pid で TTY の確認の後に `unlink`。`config set router.url` は daemon が動いていると拒む（lock）。
- **focused**: `npx vitest run test/wire/cli.test.ts`。
- **sabotage**: `wallet new` で address の代わりに鍵を出す → grep の試験が落ちる／`lock reclaim` の pid の検査を外す → 試験が落ちる／`inspect --close` の TTY の要求を外す → 試験が落ちる。

### P-5b — README・packaging・clean install（設計 §5・§10、FR-A1・A2・A4・A30、AC-A1 の fake の中の受け入れ）

- **範囲**: `packages/payer/README.md`（install → `wallet new` → faucet → `daemon` → `claude mcp add` → 最初の購入 → 回復 → 残る危険 → macOS のみ・testnet のみ）、本 repo の README「Try it now」の置き換え（clone は開発者向け）、CLAUDE.md の一致、`npm pack` の最終の検査。
- **成果物**: 上の変更、`test/wire/clean-install.test.ts`、`test/wire/readme-commands.test.ts`、`test/unit/deps.test.ts`（NF-A3）。
- **完了条件（wire。macOS。registry への接続あり）**: clean-install: `npm pack` → tarball の path を記録 → 隔離（`HOME`・`npm_config_cache`・`npm_config_prefix` を一時ディレクトリに、`PATH` は `<prefix>/bin` を先頭に）→ `npm install -g <tarball>`（依存は registry から）→ install の log に `node-gyp`・`prebuild`・`binding.gyp` が無く、`<prefix>/lib/node_modules/@subetha/payer` に `.node` ファイルが無い（`find`）→ **install した bin** で `subetha-payer wallet new`（一時 HOME の store。stdout に秘密なし）→ `subetha-payer daemon --check`（production のサブコマンド: 起動の検査を passphrase の手前まで行って結果を表示し終了。GUI 無しの CI では `no_confirmation_ui` を期待）→ `subetha-payer mcp` を SDK の `Client` で起動して `tools/list` に 5 tool、`purchase` の `_meta`、daemon 無しで `daemon_unavailable`。**spy は使わない**（install した artifact をそのまま動かす）。readme-commands: README から `claude mcp add` の 1 行と install の行を抜き出し、bin 名とサブコマンドが実在する。
- **focused**: `npx vitest run test/wire/clean-install.test.ts test/wire/readme-commands.test.ts`（clean-install は gate `PAYER_CLEAN_INSTALL=1`。PR に実行の記録）。
- **sabotage**: `bin/subetha-payer` の `exec` 行から `--disable-sigusr1` を外す → `daemon --check` が `sigusr1_enabled` で落ちる／`files` から `dist` を外す → install した bin が動かず落ちる／README の bin 名を変える → readme-commands が落ちる。
- **独立レビュー**: P-4a/b・P-5a/b と累積の実ソース。

### G-A1 — owner の `npm publish`（要件 §8）

- owner が `packages/payer` から `npm publish --access public`（scope `@subetha`）。親は `npm view @subetha/payer version dist.integrity` と手元の `npm pack` の integrity の一致、公開した commit を記録。

### G-A2 — testnet の購入（要件 AC-A1・AC-A10、§8）

- 前提: G-A1、**H-1 の配備済み**（記録した image）。
- 親の作業: repo の外の一時ディレクトリで `npm i -g @subetha/payer`（公開版）→ `wallet new`（新しい使い捨て鍵。address を owner に伝え、owner が Base Sepolia USDC を入金）→ owner が自分の端末で `daemon`（passphrase と合言葉は owner）→ `claude mcp add subetha-payer -- subetha-payer mcp` → **Claude Code（対話）**で `find_routes` → `quote` → **owner が dialog で Approve + passphrase** → `purchase` → `status`。daemon の再起動後の `status`。
- 証拠（AC-A10 の 5 点を別々に）: (1) client の受領（tool の応答）、(2) `status` の読み直し（再起動後も同じ）、(3) 受信 Base の finality（receipt `status: 1` と block ≤ `finalized` の block。公開 RPC の読取）、(4) 送信 Tempo（Router の `status` の `destination.txRef` と receipt。finality は `finalized` の block か 32 block）、(5) 台帳の `approved` の行と dialog の記録。あわせて AC-A1 の最終（Claude Code の対話 session で `requiresUserInteraction` の prompt の見え方 = U-A10 を記録）。
- 2 件目（owner の判断。資金 1 件分）: `quote` 後に Cancel → 台帳に `sign_intent` 無し（AC-A2 の実機の 1 行）。
- 記録: `docs/DEPLOY.md` §2e（新設: payer の G-A1・G-A2）と本書 §4。鍵・passphrase・合言葉は書かない。

## 3. 要件・設計との対応（**1 項目 1 主担当**。「実装」と「最終の受け入れ」を分ける）

| 対象 | 実装の主担当 | 最終の受け入れ | 補助 |
|---|---|---|---|
| FR-A24〜A29、AC-A7、設計 §6 | H-1 | H-1（配備の確認は G-A2 の前提） | P-3a（契約） |
| 設計 §3.8 の抽出・分離、U-A5 | P-0 | P-0 | P-2 |
| FR-A1（native 無し）、FR-A2（bin）、`Summary`、設計 §2.1・§3.6 の検証 | P-1a | P-5b（clean install） | — |
| FR-A3、FR-A10、FR-A21、SR-A6、設計 §3.3・§3.4 の台帳・§3.7 | P-1b | P-3c（crash の中で） | P-3a（paths の呼び出し） |
| SR-A7 の署名の検査、AC-A8 の移植の行、設計 §3.8 の gate | P-2 | P-2 | P-3b（照合） |
| FR-A6〜A9、FR-A11、SR-A1・A9、設計 §3.1・§3.2・§3.6・§3.8 の client | P-3a | P-3a | — |
| FR-A14、FR-A18〜A20、SR-A2 の記録側、AC-A3、設計 §3.4 の記録と状態機械 | P-3b | P-3b | P-4a（UI） |
| FR-A22、SR-A3、SR-A8、AC-A4・A5、設計 §3.4 の回復・§8 の行列 | P-3c | P-3c | — |
| SR-A5、AC-A9 | P-3c（daemon の経路） | P-5a（CLI の経路を足して完了） | P-4a（argv） |
| FR-A12・A13・A15、SR-A4、設計 §3.5 | P-4a | P-4a（手動の 5 例） | G-A2（実機の 1 例を記録） |
| FR-A16・A23、SR-A2 の shim 側、AC-A2・A6、設計 §4 | P-4b | P-4b | — |
| FR-A5、CLI、設計 §5 | P-5a | P-5a | — |
| FR-A4、FR-A30、AC-A1、設計 §10 | P-5b | **G-A2** | — |
| NF-A1（macOS 14 以上、Node 22） | P-5b（README の明記と `engines`） | P-5b | — |
| NF-A3（pin と audit） | P-5b（`test/unit/deps.test.ts`: `package.json` の依存に `^`・`~`・範囲が無く lockfile と一致、`npm audit --audit-level=high --json` の `vulnerabilities.high + critical === 0`。gate `PAYER_AUDIT=1`、PR に記録） | P-5b | — |
| NF-A2（+1 秒以内） | P-3a（`test/wire/latency.test.ts`: fake Router に 300 ms の遅延を入れ、daemon 経由の `quote` + `purchase` の所要と fake 直叩きの所要の差 ≤ 1,000 ms を 5 回の中央値で） | G-A2（実測を記録） | — |
| AC-A10、要件 §8 | — | **G-A2** | G-A1（公開） |
| 設計 §11 U-A10（対話 session の prompt） | — | G-A2 | — |
| 設計 §11 U-A13（`osascript` の env の allowlist） | P-4a | P-4a（手動の例 1） | — |
| 設計 §11 U-A14（`ps -o lstart=` と pid の再利用） | P-1b | P-1b | — |
| 設計 §11 U-A15（鍵の文字列の寿命） | P-2（`sign` が閉包を使い捨てる行） | P-2 | — |
| 設計 §1（確認済み）、§7（材料）、§9（順序） | 文脈（タスク無し） | — | — |
| FR-A17・A31、D-A3、Linux（D-A4）、他の rail | 第 2 slice（本書の範囲外） | — | — |

## 4. 独立レビューの記録

| # | 日付 | reviewer | 要旨 |
|---|---|---|---|
| T-2r | 2026-10-08 | `gpt-6-astra`（readback。第 2 版の修正後） | **APPROVE**（T-1r の点は解消。H-1 / P-0 を始めてよい） |
| T-1r | 2026-10-08 | `gpt-6-astra`（readback。第 2 版） | **REJECT**（残り: crash の表で `after:sign_intent` と `before:signed`、`after:submit_intent` と transport の停止点が同じ counter になっている、`signed` の行の purchase が 0 のまま、「増えない」の範囲、§3 の P-4a の二重、§11 の複数の主担当、NF-A2 の計測の行が無い、NF-A3 の検査が無い）。**同版で反映**: 表を停止点ごとに分け crash 時と回復後の列に、§3 の訂正、`latency.test.ts`（NF-A2）と `deps.test.ts`（NF-A3） |
| T-1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版） | **REJECT**（7 点: §3 の二重の主担当（FR-A21・AC-A10）と抜け（NF-A2・A3、設計 §3.8 の client、§11）、P-3 の crash の行列が実行できる形でない、観測点（AC-A9 の注入、FR-A8 の preload、AC-A2 の回数、`instructions` は initialize、osascript の手動の手順、focused のコマンド）、P-5 の clean install（tarball・隔離・依存の取得・install した bin・spy の切り分け・README は `files` で外せない）、依存（P-3 は H-1 の契約だけ、配備は G-A2 の前提）、§0 の抜け（skip と失敗、停止の規則、両レグと接続、既存の鍵、最終レビューの範囲、`FaultPoints` の interface）、PR の分割）。**第 2 版で反映** |

## 5. 本書で決めていないこと

- 第 2 slice のタスク（envelope、Tempo、Solana MPP、Linux + 別 user の daemon、D-A3、plugin）。
- G-A2 の 2 件目を行うか（owner の判断。資金は 1 件分増える）。
