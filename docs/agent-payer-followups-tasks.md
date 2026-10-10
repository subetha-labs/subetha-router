# agent payer の後続修正 — タスク（第 2 版、2026-10-10）

> **第 2 版**: 独立レビュー T-1（CHANGES_REQUIRED 4 点）を反映: 直接の書き込みを確実に落とす部分書き込みの試験（F-b）、成功の経路と PTY の行を明示（F-b）、`hosted-contract.test.ts` の更新を F-a に（F-a）、resource の binding の `approval_mismatch` を明示（F-a）。

> 要件 `docs/agent-payer-followups-requirements.md`（第 4 版）、設計 `docs/agent-payer-followups-design.md`（第 2 版）。3 つの PR に分ける。各 PR の共通の完了条件: payer の全試験と types（Router を変える F-c は Router の全試験）、各 AC の守りを外すと落ちる sabotage（記録を PR に書く）、Codex `gpt-6-astra` の差分レビュー APPROVE、親の readback。

## F-a — 合言葉の分離・Resource 行・宛先の桁（payer）

- **範囲**: `src/daemon/startup.ts`（設計 §1）、`src/daemon/record.ts`（§3 の `render`、§4.1 の `PATHUSD_DECIMALS` と記録の作成）、README の daemon の起動手順の合言葉の説明（§2.4 の 1 行目）。
- **試験**:
  - `test/unit/startup-order.test.ts` か新しい `test/unit/startup-phrase.test.ts`: AC-F1 の全行（同一・全角・前後の空白・含む・正規化後に含む、既存の 3 つの拒否、合言葉だけの再入力、3 回と取消での終了、`before:key-decrypt` に到達しない、listener・session・UI 0、`zero` の spy、lock の解放、全角の passphrase の wallet が開く、説明文が prompt より前、出力に値・長さが無い）。
  - `test/unit/render.test.ts`: AC-F3（hosted で `Resource:` 行に `127.0.0.1` が無く path と注記、ローカルの Router の行で `Router:` 行にその URL）。
  - `test/unit/record.test.ts`: AC-F3 の binding（承認した記録の `resource` だけを変え、元の承認の hash で照合すると `approval_mismatch`）。
  - `test/unit/hosted-contract.test.ts`（Router の code を import し、両方の collector で走る。F-a が持つ）: 62 行目の「桁を省いた quote から作った記録が `decimals not supplied`」を「producer の quote は桁を省いたまま（Router が直るまで）、payer の記録は `decimals 6`」に更新し、0.1.x の桁なしの記録（legacy）の表示 `not supplied` を別の行で残す。F-b の 0.1.2 は F-a を含む（F-a を先に merge）。
  - `test/unit/record.test.ts`: AC-F4（欠落で記録に 6、6 はそのまま、6 以外は `quote_inconsistent`、記録の宛先の桁を変えると `approval_mismatch`、0.1.x の桁なしの記録の表示は `not supplied` のまま）。
- **sabotage**: 分離の検査を外す／NFKC を外す／含む判定を等価に変える／passphrase を先に消す（比較が空になる）／`Resource:` 行を URL に戻す／欠落時の 6 を外す。

## F-b — `install accept` と 0.1.2（payer）

- **範囲**: `src/cli/install.ts`（新規。設計 §2.1〜§2.2）、`src/bin.ts`（`install` の振り分けと USAGE）、`src/daemon/seal.ts`（§2.3 の切り出し。`checkInstallSeal` の挙動は不変）、`src/daemon/run.ts`（`install_changed` の案内）、`src/store/paths.ts`（`STORE_FILES.installSealPrev`）、`src/cli/common.ts`（`SAFE_CODES` に `install_seal_missing`）、README の Upgrading と human-only の記述、CLAUDE.md の payer の節、版 0.1.2（`package.json`・`npm-shrinkwrap.json` の root 2 箇所・コード中の 3 箇所）。
- **試験**:
  - `test/unit/install-accept.test.ts`: 成功の経路（`added`・`removed`・`changed` の各一覧の中身、`installRoot/package.json` の version、stdout の 1 行の JSON `{ ok, changed, version }`、案内は stderr）、差なしで何も書かない、確認語の不一致で何も書かない、`ACCEPT` で新 seal と控え（控えの bytes = 旧 seal、新 seal で `checkInstallSeal` が通る）、既存の控え（検査に通る）の置き換え、控えが symlink・mode 違いで `path_invalid` かつ両 file の bytes 不変、seal 無しで `install_seal_missing`（`internal_error` にならない）、壊れた seal で `install_seal_corrupt`、誤った passphrase、非 TTY、daemon の動作中（`daemon_already_running`）、書き込みの失敗（fake の fs で `EIO`）、lock の喪失（`lock_lost`、以後書かない）、`openWallet` 0。
  - `test/wire/install-accept.test.ts`: **PTY**（既存の PTY の harness）で正しい passphrase → 成功、PTY で誤った passphrase → `bad_passphrase`（PTY 自体を拒まないことの確認）。版を変えた install（fixture の `dist` の 1 file を書き換え・1 file を足す）で daemon が `install_changed` と案内の 2 行目を stderr に出す → `install accept` → daemon が起動して `listening`。
  - 部分書き込み（直接の書き込みを確実に落とす）: fake の fs で新 seal の書き込みを途中の byte 数で `EIO` にする行と、一時 file への書き込みの途中で `SIGKILL` する fault point（`during:seal-write`。半分を書いて fsync した後）を足す。どちらも `install.seal` は旧 seal のまま開ける（rename 方式）。直接の上書きに変えると `install.seal` が壊れて `install_seal_corrupt` になる。
  - 子 process で fault point（`before:prev`・`after:prev`・`before:seal-write`・`after:seal-write`・`before:seal-rename`・`after:seal-rename`）に `SIGKILL` → `daemon_lock_stale` → `lock reclaim` → 旧 seal か新 seal で `install_seal_corrupt` にならない → 再実行で完了。MCP の tool 一覧と daemon の socket の method に入口が無い。
  - 既存の `readme-commands.test.ts`: README の `subetha-payer install accept` が実在のサブコマンド。
  - `test/wire/clean-install.test.ts`（gate `PAYER_CLEAN_INSTALL=1`）を 0.1.2 で通す。
- **sabotage**: 確認語の検査を外す／控えを作らずに置き換える／rename を直接書き込みに変える（部分書き込みの 2 行が落ちる）／PTY を拒む（PTY の成功の行が落ちる）／`requireTty` を外す／`STORE_FILES` から控えを外す（symlink の行が落ちる）。
- **終わりに**: main から build・pack した 0.1.2 の tarball と integrity を記録し、owner に公開を依頼する。

## F-c — Router の宛先の桁（Router）

- **範囲**: `src/config.ts` の `loadConfig`（設計 §4.2）。
- **試験**: 本番の起動経路（`loadConfig` の real モード + `KNOWN_NETWORKS` + 本番の構成ファイル）で `md-mpp-eth-snapshot` の宛先に `decimals: 6`、公開の quote の射影に出る。既存のエラーの文言と順序が変わらない（既存の試験）。
- **sabotage**: `withDestinationDecimals` の呼び出しを外す。
- **配備**: owner の確認で image の入れ替え（`docs/DEPLOY.md` の手順）。配備後に公開の `subetha_router_quote` で読む（読取だけ）。payer 0.1.2 の表示は配備の前後で同じ。
- **記録（2026-10-10）**: PR #152 を merge、`b-a89a979` を 05:20Z に配備（`docs/DEPLOY.md` §2f）。公開の quote の `destination.decimals` が `6`。

## G-F — owner の受け入れ（AC-F6）

- owner が 0.1.2 を `npm publish <tarball> --access public`。親は registry の integrity と `_hasShrinkwrap` を記録。
- owner が README の Upgrading の手順で 0.1.1 → 0.1.2 → daemon の `install_changed` と案内 → `install accept` → daemon の起動で説明が出て、passphrase と同じ合言葉が拒否される → 実際の quote の dialog で `Resource:` 行と宛先の桁を見て Cancel（資金は動かない）。
- 記録: 本書と `docs/DEPLOY.md` §2f。秘密は書かない。
- **記録（2026-10-10、owner の Mac）**: owner が 0.1.2 を公開（registry の `dist.integrity`・`dist.shasum` が main `a89a979` の pack と一致、`_hasShrinkwrap: true`、47 files）。README の Upgrading の手順で 0.1.1 → 0.1.2（uninstall → clean install → 照合）→ daemon が `install_changed` で停止 → `install accept` → `install.seal` と `install.seal.prev` が作られ（14:33）、daemon が起動。試験の session（repo の外の Claude Code）で quote → 実際の dialog で `Resource: GET /v1/routes/md-mpp-eth-snapshot/resource (Router-internal, fixed by this payer)` と `Destination amount: 10000 base units (decimals 6)` を確認（AC-F3・AC-F4）→ Cancel → agent が `approval_rejected`・`fundsMoved: no` を報告、残高不変。F-c の配備（`b-a89a979`）後の hosted の quote でも宛先の桁は 6。**未確認**: 実機の daemon の起動で合言葉の説明文と、passphrase と同じ合言葉の拒否（AC-F6 の該当部分。unit と wire の試験では確認済み）。owner の報告を待つ。

## 独立レビューの記録

| # | 日付 | reviewer | 結果 |
|---|---|---|---|
| T-2 | 2026-10-10 | `gpt-6-astra`（readback。第 2 版） | **APPROVE**（指摘なし） |
| T-1 | 2026-10-10 | `gpt-6-astra`（read-only。第 1 版） | **CHANGES_REQUIRED**（4 点: 直接の書き込みが crash の行で落ちない、成功の経路と PTY の行、`hosted-contract.test.ts` の更新、resource の binding の試験）。**第 2 版で反映** |
