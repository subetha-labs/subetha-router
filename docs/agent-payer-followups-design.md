# agent payer の後続修正 — 設計（第 2 版、2026-10-10）

> **第 2 版**: 独立レビュー D-1（`gpt-6-astra`、CHANGES_REQUIRED 4 点）を反映: crash 後の stale lock は人間の `lock reclaim`（§2.2 の 10）、新しい code と `SAFE_CODES`・控えの検査は `ensureStoreDir` の `path_invalid` に統一（§2.2）、README の合言葉と human-only の記述（§2.4）、一時 file は既存の `"wx"` の排他作成（§2.2。U-F4・U-F5 は解決）。

> 要件: `docs/agent-payer-followups-requirements.md`（第 4 版、R-4 APPROVE、PR #147）。対象は `packages/payer`（0.1.2）と Router の `src/config.ts`（宛先の桁）。親の設計 `docs/agent-payer-design.md` の順序・守りは変えない。

## 1. FR-F1 合言葉と passphrase の分離（`src/daemon/startup.ts`）

現状: passphrase の検証の `finally` で `pass = ""` にし、その後に合言葉を 1 回読み、空白だけ・256 文字超・制御文字を拒む（`phrase_invalid` で終了）。その後に seal → `openWallet`。

変更:

1. passphrase の文字列は、検証に成功した後も**合言葉の受理まで**保持し（U-F3 の答え）、合言葉の検査が終わった時点（受理・拒否・取消・例外のどれでも）の `finally` で `""` にする。失敗した試行の passphrase は従来どおりその試行の `finally` で消す。
2. 合言葉を読む前に stderr に固定の説明を出す（`PHRASE_NOTICE`。秘密を含まない）:
   `The security phrase is shown at the top of every approval dialog so you can tell the dialog comes from this daemon. Anyone who can see your screen can read it. It must NOT be your passphrase and must not contain it.`
3. 合言葉の読み取りを最大 3 回の loop にする。各回:
   - 既存の検査（`!trim()`・`length > 256`・制御文字）。
   - 分離の検査: `norm(x) = x.normalize("NFKC").trim()`。`np = norm(pass)`、`nf = norm(phrase)`。`np !== "" && nf.includes(np)` なら拒否（等しい場合を含む）。`np === ""` は wallet の passphrase の規則（`isValidPassphrase`）で起き得ないが、起きた場合は分離の検査を拒否側に倒す（`phrase_invalid`）。
   - 拒否なら stderr に固定文 `Security phrase rejected: it must differ from the passphrase and not contain it.`（既存の検査で拒否した場合は `Security phrase rejected: empty, too long or contains control characters.`）を出して次の回へ。値・長さは出さない。
   - 3 回とも拒否なら `StoreError("phrase_invalid")`。`tty_cancelled` はそのまま伝える。
4. 終了の経路は既存の `close()`（`zero(keys.kek, keys.lek)`、lock の解放）。この時点では seal・`openWallet`・session・ledger・listener・UI はまだ作られていない（既存の順序を保つ）。
5. wallet の認証（`unlockKeys`）は従来どおり正規化しない passphrase。

試験（`test/unit/startup-*.test.ts` に追加。既存の fake の TTY と fault hook を使う）: AC-F1 の各行。`openWallet` 0 は `before:key-decrypt` の fault point に到達しないこと、session・listener・UI 0 は既存の観測（socket が無い、UI の spy 0）で、buffer の 0 埋めは既存の `zero` の spy で、lock の解放は lock file の不在で測る。説明文が合言葉の prompt より前に stderr に出ること（fake TTY の記録の順序）。

## 2. FR-F2 正規の更新の受け入れ（`subetha-payer install accept`）

### 2.1 入口

- `src/bin.ts` に `install` を足し、`src/cli/install.ts` の `runInstall(["accept"])` だけを受ける。MCP の tool・daemon の socket の method には足さない（AC-F2 で tool 一覧と method の一覧を検査）。
- 最初に `requireTty`（`inspect --close` と同じ。ディスク・client の操作より前）。PTY は拒まない（要件 FR-F2 (a)）。

### 2.2 手順（`withLock` の中。daemon が動いていれば `daemon_already_running`）

1. `keys.json` を読み、passphrase を TTY で読み（1 回。誤りは `bad_passphrase` で終了）、`unlockKeys` → `zero(kek)`。wallet は復号しない。
2. `install.seal` が無ければ `install_seal_missing`（新しい code。`src/cli/common.ts` の `SAFE_CODES` に足す。daemon の初回起動が作る）。開けなければ `install_seal_corrupt`。
3. 現在の `installHashes(installRoot)` と比べ、`added`・`removed`・`changed` の file 名を作る。差が無ければ `{ ok: true, changed: 0 }` を出して何も書かない。
4. 表示（stdout は JSON の 1 行、案内は stderr）: 3 つの一覧、`installRoot/package.json` の `version`、固定の案内（README の「Upgrading」の手順を済ませたか。想定外なら中止）。
5. 確認語: TTY で `Type ACCEPT to seal this installation` → 入力が厳密に `ACCEPT` でなければ `operator_cancelled`（何も書かない）。
6. 控え: `install.seal.prev`（`STORE_FILES.installSealPrev` に追加。`ensureStoreDir` の検査対象になる）。
   - 既にある控えの検査は `withLock` の前段の `ensureStoreDir` が行う（`STORE_FILES` に入るので、symlink・別 owner・mode 違い・通常の file でないものは既存の `path_invalid` で、手順に入る前に何も変えずに拒否）。独自の code は作らない。
   - 旧 seal の bytes を一時 file（`install.seal.prev.<16 hex>.new`）に書いて fsync → `renameSync` で `install.seal.prev` に置き換え → directory を fsync。一時 file は既存の seal と同じ `fs.openSync(temp, "wx", 0o600)`（`O_CREAT|O_EXCL`。既にある名前は symlink でも `EEXIST` で失敗し、辿らない）。`StoreFs` の型は変えない。
7. 新 seal: `sealManifest(lek, manifest)` を一時 file（`install.seal.<16 hex>.new`、同じ `"wx"`）に書いて fsync → `rename` で `install.seal` に置き換え → directory を fsync。`rename` は原子的なので、どの時点の crash でも `install.seal` は旧か新のどちらか。
8. 各書き込みの前に `held()`（lock の喪失で `lock_lost`、以後書かない）。一時 file は失敗時に `unlink`（`finally`）。crash で残った一時 file は `STORE_FILES` に無いので `ensureStoreDir` も daemon も見ない（既存の seal の一時 file と同じ扱い）。
9. 出力 `{ ok: true, changed: <件数>, version }`。passphrase は `finally` で `""`、`lek` は `zero`。
10. crash の後: `SIGKILL` では `withLock` の `finally` が動かず `daemon.lock` が残る。次の daemon の起動・受け入れの再実行は既存の `daemon_lock_stale` で拒否される。人間が既存の `subetha-payer lock reclaim` で回収してから再実行する（自動回収はしない。既存の安全要件どおり）。README の Upgrading にこの手順を書く。

### 2.3 共有の変更（`src/daemon/seal.ts`）

- `sealManifest(lek, manifest): string`（暗号化した JSON）と `diffManifest(previous, current)`、`readSealManifest(file, lek)` を切り出す。`checkInstallSeal` はこれらを使う形に直すだけで、初回の作成（排他の hard link）と比較の挙動は変えない。
- daemon の `install_changed` の stderr に 2 行目を足す（`src/daemon/run.ts`）: `If you just upgraded @subetha/payer, verify it (README: Upgrading) and run: subetha-payer install accept. If you did not upgrade, do not run it; stop and assess.`

### 2.4 README（Upgrading）と CLAUDE.md

- README に「Upgrading」節: daemon を止める → `npm uninstall -g @subetha/payer` → package の directory が無いことを確かめる → `npm i -g @subetha/payer@<version>` → `npm view @subetha/payer@<version> dist.integrity _hasShrinkwrap`（真であること）→ `npm pack @subetha/payer@<version>` の integrity が一致し、展開した `dist`・`bin`・`package.json`・`npm-shrinkwrap.json` が install 済みと同一（`diff -r` の例）→ `subetha-payer install accept`。T4′ の限界（clean install の後の同じ user の書き換えは防がない）を書く。
- README の起動手順（daemon）に合言葉の説明: 毎回の承認 dialog の 1 行目に表示される、画面を見られる人には読める、passphrase と同じにしない・含めない（daemon が拒否する）。
- README と CLAUDE.md の payer の節: agent は `install accept` を実行しない・勧めない（human-only）。端末（TTY）からの実行は人間の操作の証明にならず、守りは passphrase の検証であること。

試験（`test/unit/install-accept.test.ts`、`test/wire/install-accept.test.ts`）: AC-F2 の各行。crash は既存の harness の fault point を `before:prev`・`after:prev`・`before:seal-write`・`after:seal-write`・`before:seal-rename`・`after:seal-rename` に足して子 process を `SIGKILL` し、再起動後に `checkInstallSeal` が旧または新の manifest で `install_seal_corrupt` にならず、再実行で完了することを測る。crash の行は、再起動で `daemon_lock_stale` → 人間の `lock reclaim`（試験では同じ CLI）→ 受け入れの再実行の順。控えに symlink・mode 違いの行は `path_invalid` で何も変わらない（`install.seal` と控えの bytes が不変）。`install_seal_missing` が `internal_error` にならず stderr に出る。

## 3. FR-F3 Resource 行（`src/daemon/record.ts` の `render`）

- `Resource:` 行を `Resource: ${method} ${RESOURCE_PATH} (Router-internal, fixed by this payer)` にする。host を出さない（hosted でもローカルでも）。`RESOURCE_PATH` は `routerIdentity` が全設定で強制している path なので、表示が記録と食い違わない。
- `Router:` 行は従来どおり `r.routerUrl`（ローカルの Router ならその URL が出る）。
- 承認の記録（`r.resource.url`）・offer との照合・`ROUTE_BINDING` は変えない。

試験: `render` の hosted の行で `Resource:` 行に `127.0.0.1` が無く path と注記がある。ローカルの Router（`http://127.0.0.1:8787/mcp` と canonical resource）の行で `Router:` 行にその URL。既存の `approval_mismatch` の試験はそのまま。

## 4. FR-F4 宛先の桁（両方を直す）

### 4.1 payer（0.1.2。単独で表示が直る）

- `record.ts` の `destinationSchema.decimals` は `z.literal(6).optional()` のまま（6 以外は従来どおり schema で拒否 = `quote_inconsistent`）。
- 承認の記録を作るとき、宛先の `decimals` が欠落なら固定の値 `6` を入れる（payer の宛先は schema で `eip155:42431` の pathUSD に固定されている。`PATHUSD_DECIMALS = 6` を `record.ts` に定数で持ち、根拠のコメントを付ける）。Router が 6 を返したらそのまま。記録は不変で、記録の宛先の桁を変えれば既存の hash の照合で `approval_mismatch`。
- 0.1.0/0.1.1 で書かれた記録（桁なし）を回復で読むときは従来の表示（`not supplied`）のまま。記録は書き換えない。

### 4.2 Router（別 PR。配備は owner）

- `src/config.ts` の `loadConfig`（real モード）で、`validateRouterConfigAgainstTable(router, networks)` の後に `withDestinationDecimals(router, networks)` を通した `router` を以後に使う。エラーの文言と順序は変えない。
- 試験: 本番の起動経路（`loadConfig` + `KNOWN_NETWORKS` + 本番の構成ファイル）で `md-mpp-eth-snapshot` の宛先に `decimals: 6` が入り、公開の quote の射影に出る。配備後に公開の `subetha_router_quote` で読む（読取だけ。購入しない）。
- payer 0.1.2 はこの配備の前後どちらでも同じ表示になる。

## 5. 版とリリース

- 0.1.2: `package.json`・`npm-shrinkwrap.json` の root・コード中の version の 3 箇所（0.1.1 と同じ手順）。
- 公開は owner（`npm publish <tarball> --access public`）。親は registry の integrity と手元の pack の一致、`_hasShrinkwrap` を記録。
- AC-F6 の owner の手動確認: README の Upgrading の手順で 0.1.1 → 0.1.2（この手順自体の初回の実行になる）→ daemon の `install_changed` と案内 → `install accept` → daemon の起動で説明が出て、passphrase と同じ合言葉が拒否される → 実際の quote の dialog で `Resource:` 行と宛先の桁を見て Cancel。

## 6. PR の分割

1. **F-a**（payer）: FR-F1 + FR-F3 + FR-F4 の payer 側（小さく、安全に効く）。
2. **F-b**（payer）: FR-F2（install accept、seal の共有の切り出し、README・CLAUDE.md）と 0.1.2 の版。
3. **F-c**（Router）: FR-F4 の Router 側。配備は owner の確認。

各 PR: 全試験・types・sabotage・Codex の差分レビュー。F-b の後に clean install と、0.1.2 の pack を作って owner に渡す。

## 7. 未確認

- U-F4（解決、D-1）: `O_NOFOLLOW` は使わない。`"wx"` の排他作成で足りる。
- U-F5（解決、D-1）: `StoreFs` に `renameSync` は既にある（interface と `realFs`）。

## 8. 独立レビューの記録

| # | 日付 | reviewer | 結果 |
|---|---|---|---|
| D-2 | 2026-10-10 | `gpt-6-astra`（readback。第 2 版） | **APPROVE**（指摘なし） |
| D-1 | 2026-10-10 | `gpt-6-astra`（read-only。第 1 版） | **CHANGES_REQUIRED**（4 点: crash 後の stale lock の回収、新 code と `SAFE_CODES`・`ensureStoreDir` の先行、README の欠落、`StoreFs` の flag の型）。**第 2 版で反映** |
