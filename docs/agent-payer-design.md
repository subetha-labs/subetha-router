# 設計: agent 用の payer（`@subetha/payer`）と hosted MCP の整備（第 3 版、2026-10-08）

> 要件 `docs/agent-payer-requirements.md`（第 3 版、独立レビュー R-3r APPROVE）の設計。owner の決定「進めて良いです」（2026-10-08）で設計に入った。タスクは別紙（`agent-payer-tasks.md`）。
> §1 は要件の未確認事項 U-A1〜U-A8 をこの Mac で実機確認した結果で、設計の前提になる。要件の脅威モデル（T1〜T3、T4′）は変えない。
>
> **第 3 版（readback #1 = REJECT の 4 点、§12 D-1r）**: 親 process を無くす（bin は `exec` する shell script。§3.1）、lock の取得を `link` + inode の照合 + 保持者の自己検査にし、store への書き込みは lock の後（§3.7・§3.1）、第 1 slice の依存（`mppx`・Solana）を import 時に引き込まない分割（§3.8・P-0）、`osascript` の引数と出力の解析（§3.5）。
> **第 2 版（独立レビュー #1 = REJECT、§12 の反映）**: (1) 再実行の不変条件と親の扱い、`DYLD_*` と診断系の flag の拒否（§3.1）、(2) **Linux の第 1 slice からの除外**（`/proc/<pid>/fd` は Yama では止まらない。D-A4、§1 U-A8）と macOS の残る経路（core dump・swap・crash report。§3.1 末尾）、(3) 承認の記録を「quote の応答から作る不変の記録」として定義し、署名 payload の該当欄だけを直前に比べる（§3.4）。静的 quote に宛先の `payTo`・`decimals` を**加算で**出す（§6）、(4) 回復の identity を hosted が実際に返す欄（`paymentId`・`routeId`・`quoteFingerprint`・`source`・`txRef`）で定義し、`not found` と transport・形・認可の失敗を分ける（§3.4）、(5) `ref` ごとの mutex を回復にも掛け、途切れた末尾の切り詰め、fsync 失敗、lock の取得と stale の回収を具体化（§3.4・§3.7）、(6) 確認 UI の契約（毎回 passphrase、検証、escape、応答の解析、拒否の条件、helper の env の allowlist）（§3.5）、(7) 出力の実行時検証（zod `strict`）、鍵の寿命の正直な限界、store 全体の検査、seal の検査の順序（§3.3・§3.6・§3.1）、(8) requestId・短い参照・store の version・preview の上限・`Retry-After`・schema の説明・`quote_url` の説明（§3.4・§4・§6）、(9) 試験: 本番の状態機械を共有し、test-only の wrapper を production の interface の周りに、counter はファイルに永続、公開物に test entry が無いことの検査、行の追加（§8）、(10) 署名コードの共有化（`src/shared/` に抽出し payer は vendor）、Base Sepolia だけの gate、§7 の修正、§9 の順序。

## 0. 範囲と置き場

- 第 1 slice（要件 S-A3）: 標準モードの payer で、Base Sepolia USDC（x402）の静的 route `md-mpp-eth-snapshot` を、この repo の外の Claude Code から購入まで。session（≤1 時間）あり、envelope なし。**対応 OS は macOS だけ**（D-A4。Linux は第 2 slice で別の OS user の daemon と一緒に）。hosted MCP の改善（S-A2）は独立して先に出せる。
- 置き場: payer はこの repo の **`packages/payer/`**（独立した `package.json`、名前 `@subetha/payer`、ESM、`tsc` で `dist/`）。公開（`npm publish`）は owner。Router 本体は hosted MCP の改善（§6）と、署名コードの共有化のための `src/shared/` への抽出（§3.8）だけ変える。
- 第 2 slice 以降（要件 S-A4）の設計は、本書では**境界だけ**決めておく（§3.9、§7）。

## 1. 実機確認の結果（2026-10-08、macOS / Node 22.23.1）

| # | 確認したこと | 結果 | 設計への反映 |
|---|---|---|---|
| U-A1 | 同じ利用者の別 process から、稼働中の Node（daemon）に debugger を付けられるか | **付けられる**: `process._debugProcess(pid)`（= `SIGUSR1`）で inspector が `127.0.0.1:9229` に開き、websocket からメモリ（鍵）が読める。`node --disable-sigusr1` で起動すると開かない（確認済み）。lldb の attach は SIP 有効・Developer mode 無効の既定では認可が要る | daemon は必ず `--disable-sigusr1` で動く（§3.1）。`--inspect*` は拒否 |
| U-A1′ | 同じ利用者から別 process の **env と argv** が読めるか（macOS） | **読める**（`ps eww -p` で env、`ps -o args` で argv） | 秘密を env / argv に置かない。daemon 自身の env にも置かない |
| U-A2 | 端末から起動した process が `osascript` の dialog を stdin の script で出せるか | **出せる**（`osascript -` に stdin、`giving up after` で自動終了も可。GUI session のある端末から） | §3.5 |
| U-A3 | Claude Code での `instructions`・`requiresUserInteraction`・elicitation の実挙動（非対話 `claude -p`） | **`instructions` は model に届く**。`_meta["anthropic/requiresUserInteraction"]` の tool は `--allowedTools` で許可しても **`MCPTool requires permission` で拒否**（非対話では確認を出せない）。elicitation は **`{"action":"cancel"}`** | §4: `purchase` に注釈（非対話の Claude からの購入は client 側で止まる = 補助）。elicitation は表示の補助で**承認ではない**。§6: hosted に `instructions` |
| U-A4 | lock | 設計で決めた（§3.7） | — |
| U-A5 | 既存コードの移植の境界 | hosted の入口は **MCP だけ**（Router の HTTP API はコンテナの loopback）。daemon は hosted MCP の **client**（Streamable HTTP。session id なしで接続できることを確認。`list_routes` の text は約 30 KB）。署名の道具は `src/config`（表）・`src/adapters/inbound/x402-svm`（tx の組み立て）・`src/net/*`（guarded transport、bounded body）を import している | §3.8: `src/shared/` に抽出して payer は vendor |
| U-A6 | scrypt | N=2^17, r=8, p=1 で 208 ms、N=2^18 で 379 ms | N=2^17（store に記録） |
| U-A7 | 複数 session | 設計で決めた（§3.6） | — |
| U-A8 | stdin の秘匿 | macOS: 別 process の pipe の中身を読む手段は無い（`/proc` 無し）。**Linux: `/proc/<pid>/fd/0` の open は `PTRACE_MODE_READ` の検査で、Yama の `ptrace_scope` は attach だけを制限する。同じ uid の dumpable な helper の pipe は読め得る**（第 1 版の結論は誤り） | **Linux は第 1 slice から外す**（D-A4）。第 2 slice の別 user の daemon なら uid が違うので読めない |
| U-A9 | Node の unix socket で peer の uid | 取れない（`net.Socket` に API が無い） | 同じ利用者権限の境界なので区別は要らない。socket `0600` とディレクトリ `0700` で他の user を除く |
| U-A12 | Streamable HTTP の client | SDK 1.32.1 の `StreamableHTTPClientTransport` で接続・`listTools`・`callTool` を確認（約 1.7 秒。`structuredContent` あり） | §3.8 |

## 2. 構成

```
agent（Claude Code 等）
   │ stdio (MCP)
   ▼
shim  `subetha-payer mcp`           鍵なし・UI なし・状態なし。tool → socket の要求に写すだけ
   │ unix domain socket (JSON lines)  ~/.config/subetha-payer/daemon.sock (0600)
   ▼
daemon  `subetha-payer daemon`      人間が端末で起動。鍵はメモリ、承認 UI、台帳、Router との通信、署名
   │ MCP client (Streamable HTTP)
   ▼
hosted Router MCP  https://router.subethalabs.com/mcp
```

CLI（`subetha-payer wallet|status|inspect|config|envelope`）は、daemon が動いていれば socket 経由で頼み、動いていなければ**同じ lock を取ってから** store を読み書きする（§3.7）。

### 2.1 パッケージ

- `packages/payer/package.json`: `name: @subetha/payer`、`bin: { "subetha-payer": "bin/subetha-payer" }`（`#!/bin/sh` の script。§3.1。`files` に `bin` を含める）、`type: module`、`engines: { node: ">=22" }`、`files: ["bin", "dist", "README.md"]`（test entry と fixture は含めない。§8 で `npm pack` の一覧を検査）、依存は pin（`viem`、`@modelcontextprotocol/sdk`、`zod`、`@noble/hashes`。`@solana/kit`・`@solana-program/token`・`mppx` は第 2 slice で追加）。native 依存なし。lockfile 同梱。
- `src/bin.ts`、`src/daemon/`、`src/shim/`、`src/cli/`、`src/sign/`（§3.8）、`src/vendor/`（§3.8。生成物。手で編集しない）、`src/store/`、`src/ui/`、`src/router/`、`src/protocol/`。

## 3. daemon

### 3.1 起動（FR-A6・FR-A8、U-A1）

1. **親 process を作らない**: `bin` の `subetha-payer` は Node の script ではなく **`#!/bin/sh` の script** で、`exec node --disable-sigusr1 "<dist>/bin.js" "$@"` を実行する（`exec` なので shell は node に置き換わり、inspector を開かれ得る別の process が TTY を共有することは無い）。npm の bin は shell script を許す（macOS / Linux。Windows は対象外）。`node` は `PATH` から解決する（README に「daemon を起動する shell の `PATH` の `node` が本物であること」= T4′ の条件の一部、と書く）。
2. `bin.js` は**無条件に** `process.execArgv` に `--disable-sigusr1` が含まれることを要求し、無ければ `startup_refused: sigusr1_enabled`（shell script を経由しない起動 = `node dist/bin.js` は拒む）。`--no-disable-sigusr1` は肯定形との順序に関係なく同じ理由で拒む。Node と同様に **option 名だけ**の `_` を `-` と同一視して必須・禁止を判定する（混在表記も含む。値・path・caller の argv は変更しない）。続いて禁止の一覧を検査（下）。
   - 禁止の env: `NODE_OPTIONS`、`NODE_EXTRA_CA_CERTS`、`DYLD_INSERT_LIBRARIES`・`DYLD_*` 全般、`LD_PRELOAD`・`LD_LIBRARY_PATH`（Linux 用に一覧は残す）。
   - 禁止の `execArgv`: `--require`、`--import`、`--inspect*`、`--report-*`、`--heapsnapshot-*`、`--cpu-prof*`、`--heap-prof*`、`--diagnostic-dir`、`--expose-gc` 以外の `--expose-*`、`--experimental-*`。
   - 検知は tripwire（証明ではない）。README に書く。
3. `process.env` から禁止の変数を削除し、helper（§3.5）には allowlist の env だけ渡す。検査の順序は **passphrase の入力より前**（TTY に触る前に禁止の flag で止まる）。
4. 設定ディレクトリ（`$XDG_CONFIG_HOME/subetha-payer` 既定 `~/.config/subetha-payer`）: `realpath` が `$HOME` の中、owner が自分、mode `0700`、symlink でない。**中の各ファイル**（`keys.json`・`ledger.ndjson`・`install.seal`・`config.json`・`daemon.lock`・`daemon.sock`）も owner・mode（`0600`。socket は `0600`）・symlink でないことを検査し、違えば `startup_refused`。
5. GUI の有無: `osascript -`（stdin に `tell application "System Events" to return 1`）が成功するか。失敗（SSH・GUI 無し）なら `startup_refused: no_confirmation_ui`（第 1 slice は envelope が無いので起動しない）。
6. **lock（§3.7）を取る**（store に何も書く前）。取れなければ §3.7 のとおり `daemon_already_running`（pid が生きている）か `daemon_lock_stale`（死んでいる。人間の `lock reclaim` を案内）で終了。
7. TTY（`stdin.isTTY`）で passphrase と**合言葉**（FR-A13）を非 echo で読む。passphrase から `master` を導き（§3.3）、`verifier` と照合（違えば `bad_passphrase`。3 回で終了）。**この後**に install の tripwire（FR-A8 (b)）: `dist/` と `node_modules/` の全ファイルの sha256 の一覧を計算し、`install.seal`（`lek` で AES-GCM）と比べる。初回は保存（lock を持っているので書ける）。違えば `startup_refused: install_changed` と差分の**ファイル名だけ**を表示（鍵は復号しない）。
8. 鍵ファイルを復号して秘密鍵を `Buffer` に置く。**正直な限界**: viem の `privateKeyToAccount` は 16 進の**文字列**を要求し、その文字列は V8 の heap に残る（zero fill できない）。daemon は署名ごとに `privateKeyToAccount` を呼んで閉包を使い捨て、`Buffer` の方は session の終わりに `fill(0)` する。文字列の残骸は「session 中は鍵がメモリにある」という要件の範囲内で、GC 後も物理メモリに残り得る（§3.1 末尾の残る経路）。
9. socket（§3.6）を開き、台帳の末尾の整合（§3.4）と回復を 1 回実行し、`listening` を端末に表示。

**macOS で残る経路（README に書く）**: core dump（既定で無効: `ulimit -c 0`、`/cores` は書けない）、swap（既定で暗号化）、crash report（stack と register。heap 全体ではない）、Node の診断（`--report-*`・`--heapsnapshot-*` は上で拒否。signal 起動の report は既定で無効）。これらは OS の既定に依存し、daemon は変えない。

### 3.2 session（FR-A9）

- 復号した鍵の保持は起動から `session.ttlMs`（既定 3,600,000。設定で短くできる。長くはできない）。期限で `fill(0)` して `locked` に。`locked` の daemon は `quote` と `status` には答え、`purchase` は `locked`（署名しない）。**確認 UI の表示中に期限が来た場合**は、UI の応答を捨てて `locked`（承認は無効。FR-A14）。再 unlock は端末で daemon を起動し直す。

### 3.3 鍵の store（FR-A10）

- `keys.json`（`0600`）: `{ version: 1, kdf: { name: "scrypt", N: 131072, r: 8, p: 1, salt }, verifier, wallets: { "eip155": { address, cipher: "aes-256-gcm", iv, tag, ciphertext } } }`。
- 導出: `master = scrypt(passphrase, salt, 32)`。`kek = HKDF-SHA256(master, info="subetha-payer/kek/v1")`、`lek = HKDF(master, "subetha-payer/ledger/v1")`、`verifier = HKDF(master, "subetha-payer/verify/v1")` の先頭 16 バイト（照合用。store に保存。鍵ファイルの AES-GCM の tag でも検証できるが、鍵を復号せずに照合するため）。
- `wallet new`: lock を取ってから（§3.7）、TTY で passphrase を 2 回読んで作る。address だけを表示。
- store の version: `keys.json`・`ledger.ndjson`（各行に `v`）・`config.json` に `version`。未対応は `store_unsupported_version` で起動しない。migration は「読んで `*.new` に書き、fsync、`rename`、旧を `*.bak-<version>` に残す」。

### 3.4 購入の状態機械・台帳・回復（FR-A19〜A22）

**参照と requestId**: `ref = "p_" + lowercase_unpadded_base32(randomBytes(8))`（RFC 4648、suffix 13 文字・全長 15 文字、64 bit 全てを保持）。canonical schema は `^p_[a-z2-7]{12}[acegikmoqsuwy246]$`（末尾の未使用 1 bit はゼロ、全長も検査）。台帳・同時処理中の予約に同じ `ref` があれば作り直す。旧全長 13 文字・大文字・padding・非 canonical 末尾は拒否し、永続 ID の補完・切詰め・正規化はしない。既存の未公開 fixture 台帳・receipt は元の bytes を保持する。P-3c までは非空 store の production 回復拒否を維持する。`requestId = randomUUID()`。両方を `quoted` の行に記録。agent からは受け取らない。

**承認の記録（FR-A14。不変）**: `quote` の応答（hosted の `quote` tool の `quote` と `subject`）から、daemon が次を作る。

```
ApprovalRecord = {
  routerUrl, resource: { url, method }, wallet: { rail, network, address },
  ref, requestId, paymentId, quoteId, routeId, upstreamUrl?,
  source:      { rail, scheme, network, asset, amount, decimals, payTo, expiresAt, challengeNonce, routeBinding, fundsMoveOnCredential },
  destination: { rail, network, asset, quoted, decimals?, payTo?, quoteFingerprint },
  pricing?:    { upstreamAmount, fee, total, maxFee?, estimateAtMs? },
  disclosures?, approvalDeadlineMs,
}
```

- **接続先と canonical resource の区別（tasks §0 による controller 指示の P-3b 補正）**: `routerUrl` は MCP transport、`resource` は承認対象の静的 resource。既存 hosted pair は `https://router.subethalabs.com/mcp` と `GET http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource`。同 origin を要求しない。daemon 起動時の信頼された `router.canonicalResource: { url, method: "GET" }` を固定し、既定 hosted URL のみ省略時にこの pair を使う。custom/local transport は明示設定が必須。応答・caller・env から推測／上書きしない。resource の URL・method・固定 path・routeBinding を完全一致で照合し、credentials・query・fragment・別名を拒む。期待 resource を不変 record/hash と await 後の guard に含める。hosted backend の canonical base は変えない。ローカル fixture は別 origin のまま信頼設定を移行する。
- `subject`（hosted が返す人間向けの射影）は **記録と照合する**（欄が一致しなければ `quote_inconsistent` で quote を捨てる）。UI に出す文は**記録から**決定的に描画する（`render(record)`。別の経路で作らない）。
- 静的 quote の `destination` には今 `payTo` と `decimals` が無い（`src/http/projection.ts`）。§6 の H-1 で**加算**して出す（Router の route 設定にある）。それまでは `payTo?` が無い記録として描画し、UI に「宛先は運用者が固定（route の表）」と出す。
- **署名の直前の照合**: 署名に渡す `offer`（quote 文書の `source.offer`）の欄 `{ scheme, network, asset, amount, payTo, extra.expiresAt, extra.challengeNonce, extra.routeBinding, extra.fundsMoveOnCredential }` が記録の `source` と等しいこと、`approvalDeadlineMs > now`、session が `unlocked`、UI の承認が**この記録の hash**に対して得られたこと、を確かめる。違えば `approval_mismatch`。**Router の URL・wallet・requestId・宛先・手数料は offer から復元できないので、記録の方が正**で、offer はその中の「署名する部分」と比べる（レビュー #1 の指摘のとおり）。

**台帳** `ledger.ndjson`（`0600`、append-only）: 1 行 = `{ v: 1, seq, prev, ts, ref, state, data, sealed?, hash }`。`hash = sha256(prev ‖ canonical({ v, seq, ts, ref, state, data, sealed }))`、`prev` は前の行の `hash`（先頭は 64 個の 0）。`sealed` は `lek` で AES-GCM した JSON（credential、`ownerKey`、challenge の全文、上流の本文）。

- 書き込み: 1 行を `appendFileSync(fd)` → `fsyncSync(fd)`。**fsync が失敗したら**その行は「書けなかった」として扱い、daemon は `store_write_failed` で**以後の副作用を止める**（`purchase` は失敗、`quote` と `status` は答える。再起動で再検査）。
- 読み込み（起動時）: 先頭から hash を検証し、**最後の完全な行**（JSON として閉じ、hash が合う）までを採用。末尾に途切れた行があれば、採用した末尾の位置で**ファイルを切り詰めて**（`ftruncate` → fsync）から append を始める。途中の行で hash が合わなければ `store_corrupt`（起動しない）。
- head の検査: daemon は head の `hash` をメモリに持ち、書く前にファイルの最後の完全な行の hash と比べる（違えば `store_rollback`）。これは **session 中の巻き戻しと通常の破損**の検知であって、再起動をまたぐ書き換えや同じ利用者による歴史の書き換えは検知できない（T4′ の残る危険。README）。

**状態機械**（要件 FR-A20）と `purchase(ref)` の実装:

```
quoted        ← quote の応答（record は data に、quote 文書と subject は sealed に）
approved      ← UI の承認（data: { recordHash, shownAt, uiKind }）
sign_intent   ← 署名の直前（x402: 署名だけ）
signed        ← credential（sealed）・（第 2 slice: txRef / signature / lastValidBlockHeight）
submit_intent ← hosted の purchase tool を呼ぶ直前
submitted     ← 応答（paymentId、outcome、result は sealed、proof）
result | unknown
```

各遷移は「行を書いて fsync してから次の処理」。例外は FR-A22 の「`signed` からの同じ credential の提出 1 回」だけ（`submit_intent` を書いてから。その後に落ちたら**再送しない**）。

**mutex**: `ref` ごとの mutex を `purchase`・`status`・`inspect`・起動時の回復の**すべて**に掛ける（回復も台帳を書く）。

**回復の identity（FR-A22）**: hosted の `status` は `{ paymentId, routeId, status, updatedAt, quoteFingerprint, source: { amount, asset, network, txRef? }, destination: { quoted, asset, network, attempt, outcome, txRef? }, result? }` を返す（`src/http/projection.ts`。`requestId` と `quoteId` は**返らない**）。identity は **`paymentId`（quote の応答にある）+ `routeId` + `quoteFingerprint`（quote の応答の `destination.quoteFingerprint`）+ `source.{amount, asset, network}`** の一致。`source.txRef` は返っていれば記録し、x402 の場合は**settle の後に Router が付ける**値なので署名時には無い（一致の条件にしない）。一致しない応答は「無いもの」として扱う。
`status` の呼び出しの結果を 4 つに分ける: `found`（identity 一致）、`not_found`（hosted が `found: false` かつ reason が `not_found`。§6 で `reason` を出す）、`unreadable`（transport の失敗、形が違う、identity 不一致、認可の失敗 = `ownerKey` 不一致）、`unavailable`（hosted が答えない）。**FR-A22 の「`not found`」の行を適用するのは `not_found` だけ**。`unreadable` と `unavailable` は `unknown` のまま次の読取へ（`signed` からの提出の例外も `not_found` のときだけ）。

### 3.5 確認 UI（FR-A12・A13・A15。第 1 slice は macOS）

- 契約: `confirm(record): Promise<{ approved: true } | { approved: false, reason }>`。**毎回 passphrase を求める**（第 1 slice は閾値を置かない。MPP も同じ）。流れ: (1) `render(record)` で表示文（合言葉を先頭行に、制御文字・非印字文字・改行以外の空白を除去、`"` と `\` と改行を AppleScript の文字列リテラルとして escape: `\` → `\\`、`"` → `\"`、改行は `\n` ではなく `return` の連結）、(2) `/usr/bin/osascript` を `spawn(absPath, ["-"], { env: ALLOW, stdio: pipe })` で起動し（`-` = script を stdin から読む）、script を stdin に書いて閉じる、(3) script は `display dialog <text> with title "subetha-payer" buttons {"Cancel","Approve"} default button "Cancel" default answer "" with hidden answer giving up after 120` を実行し、結果を `return (button returned of r) & linefeed & (gave up of r) & linefeed & (text returned of r)` で返す（`osascript` は末尾に改行を 1 つ付ける）、(4) daemon は stdout を UTF-8 で読み、**末尾の改行を 1 つだけ**除いてから `\n` で分割し、**ちょうど 3 要素**で 1 番目が `Approve`、2 番目が `false` であることを要求（それ以外の形はすべて拒否。passphrase に改行は含められない = `wallet new` で禁じる）し、3 行目の passphrase から `master` を導いて `verifier` と照合（200 ms）。**拒否の条件**: Cancel、`gave up`、helper の exit code ≠ 0、stdout の形が違う、passphrase 不一致、UI の表示中に session が `locked`・記録の期限切れ。すべて `approved: false`。
- helper の env の allowlist: `PATH=/usr/bin:/bin`、`HOME`、`LANG`、`TMPDIR`。それ以外は渡さない。
- 表示文に含めるもの: 合言葉、何を払うか（額と桁、資産、network、受取先）、何が届くか（宛先 rail・network・資産・額。静的は「運用者が固定」）、手数料の内訳（動的）、期限、`fundsMoveOnCredential` の意味、動的は上流 URL と開示。含めないもの: 上流の本文・URL のラベル・agent の文。
- elicitation（shim 側）は表示の補助で、応答は daemon に渡さない。U-A3 のとおり非対話では `cancel` になるだけで、承認の根拠は daemon の dialog（README に明記）。

### 3.6 socket の protocol（FR-A7・A18・A19）

- unix domain socket `daemon.sock`（`0600`、ディレクトリ `0700`）。peer の uid は取れない（U-A9）ので、他の user は file mode で除き、同じ利用者権限の中では区別しない（脅威モデルどおり）。
- JSON lines。要求 `{ id, method, params }`、応答 `{ id, ok: true, result } | { id, ok: false, error: { code, reason?, retryAfterMs? } }`。method: `find_routes`、`quote`、`purchase`、`status`、`wallet`、`ping`。
- **出力の実行時検証**: 応答は zod の `strict()` schema（`Summary` 群）で**組み立ててから**検証し、通らなければ `internal_error`（余計な欄・例外のメッセージを出さない）。例外は code に写すだけでメッセージを出さない。
- 多重接続: 接続ごとに直列。`purchase` は `ref` ごとの mutex（§3.4）。

### 3.7 lock（U-A4）

- 取得（`link` 方式）: 自分だけの一時ファイル `daemon.lock.<pid>.<random>` に `{ pid, startedAt, hostname, token }` を書いて fsync し、`link(temp, daemon.lock)` を試みる（原子的。既にあれば `EEXIST`）。成功したら temp を `unlink` し、**自分の lock の inode**（`fstat` した `ino`）を保持する。
- **自動の回収はしない**（readback #2 の指摘: 検査と副作用は原子的にできず、回収の rename は 3 者以上の交錯で他人の lock を上書きし得る）。`EEXIST` なら `daemon.lock` を読んで `{ pid, startedAt }` を表示し、pid が生きていて起動時刻が一致（`ps -o lstart= -p`）なら `daemon_already_running`、死んでいれば `daemon_lock_stale`（「`subetha-payer lock reclaim` を、他に daemon が動いていないことを確かめてから実行する」と案内）で**起動しない**。**`daemon.lock` を `unlink` するのは、保持者自身（解放）と、人間が TTY で実行する `lock reclaim` だけ**。`lock reclaim` は pid が生きていれば拒み、死んでいれば確認（y/N）の後に `unlink` する。daemon は人間が起動するので、競合する contender は人間だけで、agent は（passphrase が無いので）意味のある daemon を起動できない。
- **保持者の自己検査（補助）**: 保持者は台帳に書く前・UI を出す前・署名の前・purchase を送る前に `stat(daemon.lock).ino === 自分の inode` を確かめ、違えば `lock_lost` で以後の副作用を止める。これは「人間が誤って `lock reclaim` を実行した」事故への補助で、相互排除の根拠は上の「他人が `unlink` しない」こと。**進行中の提出（`submit_intent` の後）は中断せず**、終わってから止まる（`unknown` を増やさない）。
- 解放: 自分の inode のときだけ `unlink`。
- `wallet new`・`config set`・`inspect`（書く操作）は**同じ `link` 方式で lock を取ってから**行い、回収はしない。
- §8 の行: (a) 2 contender の同時取得で 1 つだけ `link` が成功、(b) stale のときに両方が `daemon_lock_stale` で起動せず `unlink` も rename も起きない、(c) `lock reclaim` は生きた pid を拒む、(d) 保持者の lock が外から `unlink` されたら次の副作用の前で `lock_lost`。

### 3.8 Router との通信と署名（U-A5・U-A12）

- `src/router/client.ts`: `@modelcontextprotocol/sdk` の `Client` + `StreamableHTTPClientTransport`。hosted の URL は設定の 1 つ。接続は要求ごと（session なし）。timeout 30 秒、再試行なし。`structuredContent` を使い、無ければ `content[0].text` を JSON として読む。
- **署名コードの共有化**（P-0 で実施。PR #129）: `src/config.ts` の network・asset の表と helper を **`src/shared/networks.ts`** に、`src/adapters/inbound/x402-svm.ts` の tx の組み立てを **`src/shared/svm-message.ts`** に抽出し、元の場所は re-export で残した（Router と既存の tools は変わらない）。`networks.ts` の base58 の検査は `@solana/kit` を使わない自前の復号に置き換え（結果は同じ。等価性の試験）、**`src/shared/networks.ts` は外部パッケージに依存しない**。`tools/sign-dispatch.ts` は **`sign-classify-evm.ts`**（共通の検査 + x402 EVM の分岐。`mppx`・`@solana/*` を import しない）、**`sign-check-tempo.ts`**（`mppx`）、全レールの dispatcher（`classifyOffer`。結果は分離前と同じ）に分けた。
  - **設計からの逸脱（P-0 の実装で決めた）**: (a) 全レールの dispatcher は **静的 import のまま**（`classifyOffer` は同期で、呼び出し側と試験がそれに依存する。payer の隔離は分離だけで達成できる）。(b) **transport（`src/net/`）は抽出しない**: `guarded-fetch.ts` は `undici`・Node と `./destination-policy.ts`（`node:os` だけ）にしか依存せず、そのまま vendor できる。ただし**第 1 slice の payer は transport を使わない**（hosted への接続は MCP SDK の client で、RPC の読取は第 2 slice）。
  - **第 1 slice の vendor の一覧（P-2。これ以外はコピーしない）**: `src/shared/networks.ts`、`tools/sign-classify-evm.ts`、`tools/x402-payer.ts`（依存は `viem` だけ）。**`src/shared/svm-message.ts` は含めない**（`@solana/*` に依存する。第 2 slice）。第 2 slice で `tools/sign-dispatch.ts`・`sign-check-tempo.ts`・`svm-*.ts`・`mpp-payer.ts`・`src/shared/svm-message.ts`・`src/net/{guarded-fetch,destination-policy,bounded-body}.ts` と依存（`mppx`・`@solana/*`・`undici`）を足す。payer は `scripts/vendor.ts` でコピーし（import path を書き換え）、CI の試験が「vendor が source と一致する」ことと「`packages/payer` の依存に `mppx`・`@solana/*` が無い」ことを検査する。既存の `npm run sign` は残す。
- `src/sign/index.ts`: `sign(record, offer, key)`。第 1 slice は vendor した **`classifyEvmOffer`** で検査し、**許す rail は `x402-evm` かつ `chainId === 84532`（Base Sepolia）だけ**（`x402-evm` は Arc も含むので chainId で gate。EVM 以外の offer は `classifyEvmOffer` が `refuse` を返す）。他は `rail_not_enabled`。第 2 slice で全レールの dispatcher に置き換える。

### 3.9 第 2 slice の境界

- rail の設定 `rails: ["eip155:84532"]`（CAIP-2 の一覧）。Tempo は `sign_intent` を `payAndCredential` の前に書く流れがそのまま使える。Solana MPP は `approved` → blockhash → `sign_intent` → 署名 → `submit_intent` → purchase を 1 関数で。
- envelope（FR-A17）は `envelope.json`（sealed）+ 台帳の `reservation` 行。daemon の起動ごとに失効。
- Linux と強い境界は §7。

## 4. shim（`subetha-payer mcp`。FR-A7・A16・A18）

- stdio の MCP server。起動時に socket に `ping`。無ければ tool 一覧は出し、各 tool は `daemon_unavailable` と起動の案内を返す。
- `instructions`: 手順、承認は tool 引数でできないこと（daemon の dialog が出る）、非対話の Claude からは `purchase` が client 側で止まること、`unknown` の読み方。
- tools（`outputSchema` 付き。出力は zod `strict` で検証してから返す）:

  | tool | 入力 | 出力 |
  |---|---|---|
  | `subetha_payer_find_routes` | `{ hold?: [{ network, asset }] }` | `{ routes: [{ routeId, pays: {network, asset, amount, decimals}, reaches: {rail, network, asset}, fundsMoveOnCredential, needsSol }], profiles: [...] }`（hosted の `list_routes` 約 30 KB を daemon が絞る） |
  | `subetha_payer_quote` | `{ routeId } \| { profileId, url }` | `{ ref, subject, nextStep }`（`subject` は record から。quote 文書は返さない） |
  | `subetha_payer_purchase` | `{ ref }` | `{ ref, state, outcome?, paymentId?, result?: { untrusted: true, source, contentType, preview, bytes }, proof? }`。`_meta: { "anthropic/requiresUserInteraction": true }`。`preview` は本文の先頭 **512 バイト** |
  | `subetha_payer_status` | `{ ref, includeBody? }` | 同上（`includeBody` で本文全体。256 KiB まで） |
  | `subetha_payer_wallet` | `{}` | `{ wallets: [{ rail, network, address, balance? }] }` |

- 失敗の形: `{ ok: false, error, reason?, retryAfterMs? }`。例外は `internal_error`。

## 5. CLI

- `wallet new|address|balance`（§3.3。balance は Base Sepolia USDC を公開 RPC で。RPC は `config set` で変えられるが agent からは変えられない）。
- `daemon`（§3.1）、`status [ref]`、`inspect <ref>`（台帳の全行と hosted の `status` の突き合わせ。`closed_by_operator` は TTY で理由を読んで記録。lock を取る）、`config get|set`（Router の URL、session.ttlMs、rails、RPC）。`envelope` は第 2 slice。
- 出力は `Summary` の schema を通したものだけ（§3.6 と同じ）。

## 6. hosted MCP の改善（要件 FR-A24〜A29。`src/mcp/`、`src/client/`、`src/http/projection.ts`、README、CLAUDE.md。すべて加算）

- `src/client/index.ts`: 失敗の応答で `reason`（`^[a-z_]{1,64}$`）と HTTP status と **`Retry-After`（秒 or HTTP-date → ms）** を保持。`status` の失敗を `not_found`（404）/ `unauthorized`（401・403 = `ownerKey` 不一致）/ `malformed` / `transport` に分ける。
- `src/http/projection.ts`: 静的 quote の `destination` に **`payTo` と `decimals` を加える**（route 設定から。動的は既にある）。既存の欄は変えない。
- `src/mcp/tools.ts`: 失敗の応答に `reason` / `httpStatus` / `retryAfterMs`（quote の再試行の目安。**purchase の再試行の許可ではない**、と `nextStep` と schema の説明に書く）を**加える**。`status` の `found: false` に `reason`（上の 4 つ）を加える。`railHintOf` は `source.offer.scheme` を見て `solana/charge` を MPP として案内。動的 `nextStep` の「credential を作った時点で支払い済み」は `scheme === "tempo/charge"` のときだけ。
- `src/mcp/server.ts`: `instructions`（CLAUDE.md の要点を 30 行以内）。各 tool に `outputSchema`（成功・失敗・`internal_error` を union で。説明に「`delivered` は本文が届いたこと。client の受領・保存した `status`・両レグの tx・finality は別物」を書く）。`purchase` に `_meta: { "anthropic/requiresUserInteraction": true }`。`purchase` の説明の「再起動後は quote を取り直す」を stateless の実態に、`quote_url` の説明の「credential を作った時点で支払い済み」を Tempo だけに、`approval` の説明を「束縛の主張であって人間の同意の証明ではない」に直す。
- README「Try it now」: payer 経由（macOS）の手順に置き換え、clone は開発者向けに残す。`paid_data_unavailable` の案内を修正。CLAUDE.md と一致。
- 互換: 既存の `tests/wire/mcp-*.test.ts` を変えずに通す + 追加の欄・`instructions`・`outputSchema`・`_meta`・`Retry-After`・静的 quote の `destination.payTo` の試験。

## 7. 第 2 slice の決定の材料（D-A3 と Linux）

| 案 | 仕組み | 守れるもの | 問題 |
|---|---|---|---|
| (i) 別の OS user の daemon | `subetha-payer` user を作り、install・store をその user の所有に。agent の user は socket（group 可）にだけ触れる | T4′ の改変（install・store・実行中の process・procfs）を**機構で**防げる。**Linux の U-A8 も解ける** | GUI の dialog は別 user からは利用者の session に出せない。承認は TTY（別 user の端末）か、利用者 user 側の**表示専用 helper**（改変されれば表示が偽られる = 表示の信頼の問題は残る）。user の作成は管理者権限 |
| (ii) macOS の Keychain + LocalAuthentication | 秘密鍵を Keychain の項目に ACL 付きで置き、取り出しに Touch ID / password を毎回要求 | 鍵の**取り出し**に人間の操作が要る | 取り出した鍵は daemon のメモリに乗り、取り出した後は改変されたコードが何度でも署名できる（**操作ごとの認可にはならない**）。表示の信頼も解けない。native helper（Swift）が要る。Linux に無い |
| (iii) hardware wallet | 署名を device で行い、device の画面で内容を確認 | 鍵も表示も host から独立（**操作に束縛した署名と信頼できる表示**の両方） | x402 の EIP-3009 は Ledger で可、Solana も可、Tempo の MPP は SDK 側の対応が要る。device の購入と設定 |

評価の軸は「操作に束縛した署名」と「信頼できる表示の経路」の 2 つ。(ii) はどちらも満たさない（鍵の取り出しの認可だけ）。(i) は前者を満たし後者は TTY なら満たす。(iii) は両方。第 2 slice の決定（owner）では、(i) を Linux と macOS の共通の土台にし、(iii) を対応できる rail に重ねる案を比較の起点にする。本書は推奨を出さない（材料だけ）。

## 8. 試験（要件 §6 の観測点）

- 原則: **本番と同じ状態機械・台帳・socket・shim のコード**を使う。差し替えるのは production の **interface**（`Signer`、`RouterTransport`、`ConfirmUi`、`Clock`、`FaultPoints`）の実装だけで、test-only の wrapper は `packages/payer/test/` にあり、`files` に含まれない。`npm pack --dry-run` の一覧に `test/`・`*-test-entry*`・fixture が無いことを検査する行を置く。本番の `bin.ts` は test entry を import しない（`grep` の検査行）。
- fake の counter は**ファイル**（harness が指定する一時ディレクトリ）に書く（daemon が `SIGKILL` されても残る）。
- 単体: 鍵の導出と封（既知ベクトル）、`verifier`、台帳（hash 連鎖、途切れた末尾の切り詰め、途中の破損、巻き戻り、sealed、fsync 失敗の扱い）、状態機械（遷移の順序、例外の 1 回、`locked`）、承認の記録（`subject` との照合、描画の決定性、offer との照合で違う欄ごとに `approval_mismatch`）、表示文の sanitize と AppleScript の escape（`\`→`\\` を `"` より先に、改行、制御文字）、helper の応答の解析（3 行の形、Cancel、gave up、exit ≠ 0、壊れた出力）、`find_routes` の絞り込み、失敗の形、`Summary` の strict 検証（余計な欄・例外のメッセージが落ちる）。
- wire（子 process の daemon。test entry に fake と fault point を渡す）:
  - AC-A2 (a)〜(l) を 1 行ずつ。(d) は SDK の `Client` で shim に接続し elicitation に `accept` を返す。(f) は `keys.json` を読んで復号を試みて失敗。(i) は `NODE_OPTIONS=--require x`・`DYLD_INSERT_LIBRARIES`・`--inspect` の各 1 行で `startup_refused`（DYLD の platform 別 oracle は次項）。追加: `node dist/bin.js daemon`（shell script を経由しない起動）は `startup_refused: sigusr1_enabled`、daemon に `SIGUSR1` を送っても 9229 が開かない、passphrase 誤り 3 回で終了、session の期限が UI の表示中に来る → 拒否、helper の timeout（`giving up`）、escape（`"` と `\` を含む表示文で helper が壊れない）。
  - **P-3a の限定改訂（2026-10-09、tasks §0 の停止・改訂規則による controller 決定、独立 review1 の最小案を採用）**: compiled `dist/bin.js` の独立した試験行で、Darwin の `DYLD_INSERT_LIBRARIES=/nonexistent.dylib` は **code `null`、signal `SIGABRT`、既知の dyld 診断・指定の不存在 library・`no such file`** を要求する。これは pre-main の loader 拒否であり application guard の証拠ではない。別行の空値 `DYLD_INSERT_LIBRARIES=""` は Darwin / Linux とも **code `2`、signal `null`、正確な `startup_refused: forbidden_env`** を要求する。Linux の不存在 library 行も同じ application 拒否を要求する。各行で prompt・stdout が 0、store 全体（全 entry・内容・権限等の metadata。読取による atime を除く）が不変。空値が Darwin の application に届く実証は親が行う。親の元 round2 証拠（macOS payer 153 件 = 152 pass / 1 fail、types/build PASS、不存在 DYLD library は code `null` / `SIGABRT` と dyld / `no such file`、Linux/root 未実行）は不変。要件・脅威モデル・製品範囲・owner gate は変更しない。
  - この改訂の sabotage は親が checkpoint commit の後に **実際の `DYLD_*` 検出条件を無効化**し、空値行の正確な `forbidden_env` assertion が落ちることを要求する（loader-only の結果では合格しない）。SIGUSR1 の否定形は両順序・underscore 表記で拒否し、`--heapsnapshot_signal`・`--report_on_signal`・所有する inert fixture を使う `--experimental_loader` の compiled-bin 行も保持する。行を独立させ、先行の loader 失敗で後続 guard が未検査にならないようにする。unsupported flag の成功扱い・skip・任意 signal の許容・production bypass・helper 直接呼出への置換はしない。
  - AC-A4 の行列: fault point × { 直前, 直後 } × { RouterTransport の fake が応答を返す前・後 }、再起動して台帳の終端と counter を検査。lock（§3.7 の (a)〜(d)）、`install.seal` の初回保存が lock の後であること、同じ ref の 2 process、`EROFS` の fixture、fsync 失敗（fake の fs で `EIO`）→ 以後の副作用 0、途切れた行。
  - AC-A5 の回復の表の各行（fake Router の `status` を script: `found` 一致、identity 不一致、`not_found`、`unauthorized`、malformed、transport 失敗）と、**回復と `purchase` の同時実行**（mutex）。
  - AC-A6 のバイト数（固定 fixture）。
  - AC-A9（既知の実値を平文・base64・hex で grep。helper の argv は spy で記録し、stdin に出た表示文は spy の中だけ）。
- hosted（§6）: 既存の `tests/wire/mcp-*.test.ts` + 追加。
- Linux: 第 1 slice の対象外（D-A4）。Docker では単体と wire（UI は spy）を回すが、**AC-A1 と U-A8 の Linux の成立を主張しない**。

## 9. 実装の順序（タスク書の下書き）

1. **H-1** hosted MCP の改善（§6。独立。`src/http/projection.ts` の静的 quote の `destination.payTo`・`decimals` を含む。Codex レビュー → merge → 配備は owner の確認）。
2. **P-0** `src/shared/` の抽出と re-export、`sign-dispatch` の EVM 分類の分離と MPP・Solana の遅延 import（Router と既存の tools の挙動は変わらない。既存の試験がそのまま通る）。
3. **P-1** `packages/payer/` の骨格: package.json、`files`、store（鍵・台帳・lock・version）、`Summary` の schema、単体試験。
4. **P-2** vendor の script と `src/sign/`（Base Sepolia だけの gate）、AC-A8 の行の移植。
5. **P-3** daemon: 起動（再実行・tripwire・TTY・verifier・seal の順序）、session、socket、Router client、承認の記録、状態機械、回復。wire の harness と AC-A4 / A5。
6. **P-4** 確認 UI（macOS）と shim、AC-A2 / A3 / A6 / A9。
7. **P-5** CLI（wallet・status・inspect・config）、README（payer と本 repo）、AC-A1、`npm pack` の検査。
8. **G-A1** owner の `npm publish` → **G-A2** 別ディレクトリから testnet の購入（AC-A10。macOS）。

## 10. 運用と README に書くこと

- daemon は「自分で開いた端末で、自分で打ったコマンドで」起動する。合言葉の無い dialog には何も入れない。passphrase は購入のたびに dialog で求める。
- 保証は T4′ の条件つき（install・Node・`osascript` の無改変）。tripwire は気づく助け。台帳の hash 連鎖は session 中の巻き戻しと破損の検知で、同じ利用者による歴史の書き換えは検知しない。macOS の残る経路（§3.1 末尾）。
- `unknown` は未払いの証明ではない。`inspect` で Router と chain を読んでから判断する。再購入は新しい quote と新しい承認。
- 非対話の Claude Code（`-p`）からは `purchase` が client 側で止まる（注釈のため）。elicitation は表示の補助。
- 第 1 slice は macOS と testnet だけ。

## 11. 未確認（実装で確かめる）

- U-A10 Claude Code の対話 session で `requiresUserInteraction` の prompt がどう見えるか、elicitation の form の表示。
- U-A13 `osascript` を allowlist の env だけで起動して dialog が出るか（`HOME`・`LANG` 以外が要るか）。
- U-A14 `ps -o lstart=` の形式と pid の再利用の判定。
- U-A15 viem の閉包以外に鍵の文字列を保持する場所（署名の関数の引数の寿命）。

## 12. 独立レビューの記録

| # | 日付 | reviewer | 要旨 |
|---|---|---|---|
| D-3r | 2026-10-08 | `gpt-6-astra`（readback。第 3 版の修正後） | **APPROVE WITH CHANGES**（D-2r の 3 点は解消。残り 1 点: §3.1 の lock 失敗の文言を §3.7 の `daemon_lock_stale` と揃える。反映済み）。「人間だけが回収する」前提の中で第 1 slice の実装に進める |
| D-2r | 2026-10-08 | `gpt-6-astra`（readback。第 3 版） | **REJECT**（残り: lock の自動回収は 3 者の交錯で他人の lock を上書きし得る・inode の検査は副作用と原子的でない、§2.1 の `bin` が `dist/bin.js` のまま、`src/sign` が全レールの `classifyOffer` を呼ぶ）。**同版で反映**: 自動回収を廃止（stale は起動せず、人間の `lock reclaim` だけが `unlink`）、`bin` を shell script に、`classifyEvmOffer` に |
| D-1r | 2026-10-08 | `gpt-6-astra`（readback。第 2 版） | **REJECT**（残り 4 点: inspector を開かれ得る親が TTY を共有する、stale lock の回収が原子的でない（A の新しい lock を B が rename し得る）・`install.seal` が lock の前、第 1 slice の vendor が `mppx`・Solana を import 時に引き込む、`osascript` の引数 `[]` と 3 行の解析の改行）。**第 3 版で反映**: bin を `exec` する shell script にして親を無くす、`link` + inode の照合 + 保持者の自己検査、lock → passphrase → seal の順序、EVM 分類の分離と遅延 import、`["-"]` と末尾の改行の扱い |
| D-1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版） | **REJECT**（10 点: 再実行の不変条件と親、`DYLD_*`・診断の flag、Linux の `/proc/<pid>/fd` は Yama で止まらない（第 1 版の U-A8 は誤り）、macOS の残る経路、承認の記録が offer から復元できない欄を含む・静的 quote に宛先が無い、回復の identity が hosted に無い欄を使っている、mutex を回復に掛ける・途切れた末尾・fsync 失敗・lock の競合、UI の契約（閾値・passphrase の検証・Linux の 2 段目・escape・応答の解析・env）、`Summary` の型は実行時の保証にならない・鍵の文字列の寿命・seal の検査の順序、requestId・短い参照・version・preview・`Retry-After`・schema の説明・`quote_url` の説明、試験は本番の状態機械と外部の観測で・counter の永続・公開物の検査、`src/**` の import を無視した「そのまま移す」・`x402-evm` は Arc を含む・§7 の Keychain の評価）。**第 2 版で反映**（冒頭の一覧） |
