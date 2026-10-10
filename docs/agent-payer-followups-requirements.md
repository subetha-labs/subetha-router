# agent payer の後続修正 — 要件（第 2 版、2026-10-10）

> **第 4 版**: readback R-3（1 点）を反映: 上書きの再 install は既存の依存の内容を検証しないので、受け入れの前は uninstall してからの clean install とする（FR-F2 (d)）。
>
> **第 3 版**: readback R-2（CHANGES_REQUIRED 3 点）を反映: 依存の内容の確認を registry からの直前の再 install に置く（FR-F2 (d)）、控えの既知の名前と crash 後の再実行の両立・一時 file の守り（FR-F2 (e)）、合言葉の拒否で wallet の復号 0 を要求（FR-F1 (d)）。
>
> **第 2 版**: 独立レビュー R-1（`gpt-6-astra`、CHANGES_REQUIRED 6 点）を反映。TTY は人間の実行の証明にならないこと（FR-F2）、更新の確認の比較対象（FR-F2）、seal の差し替えと控えの失敗条件（FR-F2）、比較の境界と観測できる後始末（FR-F1）、宛先の桁の正しい値と両案での不一致の拒否（FR-F4）、Resource の試験を Resource 行に限定（FR-F3）。U-F1 は解決（下の §0 の 4）。

> 対象: `@subetha/payer` 0.1.1 の G-A2（`docs/agent-payer-tasks.md` の G-A2 の記録）で見つかった 4 件。親の要件 `docs/agent-payer-requirements.md` の脅威モデル（T1〜T3、受容した T4′）と安全要件はそのまま前提とし、緩めない。リリースは 0.1.2（owner の `npm publish`）。

## 0. 背景（G-A2 で観測した事実）

1. owner が daemon の起動時の「Security phrase:」に wallet の passphrase と同じ文字列を入れた。合言葉は仕様どおり毎回の dialog の 1 行目に表示されるので、passphrase が画面と記録された session に出た。prompt は 1 語だけで、合言葉が表示されることも passphrase と別にすべきことも説明していない。daemon は同一の文字列を拒まない。
2. 0.1.0 → 0.1.1 の正規の更新で、daemon が `startup_refused: install_changed`（変わった 3 file）を出して起動しなかった。tripwire としては正しいが、正規の更新を受け入れる手段が無い。owner は親の照合の後に `install.seal` を手で store の外へ移して回避した。README は「想定外の警告で seal を消すな」としか書いていない。
3. dialog の `Resource:` 行が `GET http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource` を表示する。これは hosted Router が x402 の offer に載せる内部の resource で、payer は `routerIdentity` に固定値として持ち、承認の記録と照合している。値は正しいが、人間には「ローカルの何かに払う」ように見え、判断の材料にならない。
4. dialog の `Destination amount:` 行が `decimals not supplied` を表示する。hosted の静的 quote の `destination` に `decimals` が無い。原因: Router の `loadConfig` は real モードで表との照合（`validateRouterConfigAgainstTable`）はするが、宛先の桁を埋める `withDestinationDecimals` を通さない（`src/config.ts` の起動経路。H-1 の加算が本番の起動経路に届いていない）。payer の schema は宛先の `decimals` を `6` か欠落だけ許す。

## 1. 範囲

- 含む: 下の FR-F1〜FR-F4、README と CLAUDE.md の該当箇所、0.1.2 の公開と owner の手動確認。
- 含まない: 第 2 slice（他のレール・動的 route）、Linux、passphrase の変更コマンド、鍵の移行・送金の機能、合言葉の強度の判定（長さ・辞書）。

## 2. 機能要件

### FR-F1 合言葉と passphrase の分離（最優先）

- (a) daemon は合言葉を読む**前に**、端末に説明を出す: 合言葉は毎回の承認 dialog に表示されること、dialog が本物の daemon から出たことの確認に使うこと、passphrase と同じにしてはいけないこと、画面を見られる人には見えること。説明は固定文（秘密を含まない）。
- (b) 合言葉が passphrase と**同じ**なら拒否する。比較だけのために、両方を Unicode NFKC で正規化し前後の空白を除いた値（以下「正規化値」）を作る（全角・半角・前後の空白で回避されないように）。合言葉の正規化値が passphrase の正規化値を**含む**場合も拒否する（含む判定も正規化値どうし）。wallet の認証は従来どおり**正規化しない** passphrase で行う。passphrase の正規化値が空になる場合は分離の検査を省かず、合言葉の既存の検査（空白だけ・制御文字・256 文字超）を先に適用する。
- (c) 拒否したら合言葉だけを読み直す（最大 3 回。passphrase は読み直さない）。3 回とも拒否、または入力の取消なら `startup_refused: phrase_invalid` 相当で終了する。拒否の表示に passphrase・合言葉の値や長さを出さない。
- (d) 観測できる後始末: 拒否・取消での終了では、socket の listen・session の作成・承認 UI の作成が起きない。wallet の復号（`openWallet`）も起きない（既存の startup は passphrase の検証 → 合言葉の検査 → seal → `openWallet` の順。この順序を保つ）。導いた鍵の buffer は `fill(0)` され、lock は解放される。JavaScript の文字列は確実に消せないので、消去を主張しない（親の要件の限界の記述と同じ）。合言葉の値は記録・保存しない。
- (e) README の起動手順に同じ説明を書く。

### FR-F2 正規の更新の受け入れ

- (a) 人間が端末で実行する新しいサブコマンド（名前は設計で決める）で、現在の install を新しい seal として受け入れられる。MCP の tool・daemon の socket の method には**入口を作らない**。秘密の入力は既存の TTY の仕組み（非 echo）だけで受け、passphrase の検証を必須とする。**TTY は人間の実行の証明にならない**（agent も PTY を作れる。親の要件 §1.1・FR-A11 と同じ限界）。守りは「passphrase を知る者だけが受け入れられる」であり、README と CLAUDE.md で agent に実行させないと書く。
- (b) 実行の条件: daemon が動いていない（lock を取れる）、TTY、passphrase の検証に成功。wallet の鍵は復号しない（seal の鍵だけを使う）。
- (c) 受け入れの前に表示する: 変わった file 名の一覧（追加・削除・変更の区別）、install されている `@subetha/payer` の version。人間が固定の確認語を入力したときだけ進む。
- (d) 確認の手順（README に書く。比較の対象を明示する）: 受け入れの**直前に** clean に入れ直す: `npm uninstall -g @subetha/payer` で package の directory（global install では依存も package の `node_modules` の中にある）を消し、消えたことを確かめてから registry から `npm i -g @subetha/payer@<version>`。既存の依存を再利用する上書きの install では、書き換えられた依存が残り得るので不可（npm は版と integrity の metadata で既存の package を残すことがあり、install 済みの file の内容は比べない）。npm は新しい install で、同梱の `npm-shrinkwrap.json` の各依存の `integrity` で取得した tarball を検証する（registry の版は `_hasShrinkwrap` が真であることを確かめる）。あわせて registry の該当 version の tarball を取得し、その integrity が `npm view @subetha/payer@<version> dist.integrity` と一致すること、展開した `dist`・`bin`・`package.json`・`npm-shrinkwrap.json` が install 済みのものと同一であることを確かめる。clean install の**後**に同じ user が file を書き換えることは T4′ で、この手順も seal も防がない（SR-F2）。version の表示や registry の metadata を読むだけでは install の内容を証明しない。手順をまとめる補助コマンドを作るかは設計で決める（作る場合も、比較の結果を表示するだけで受け入れはしない）。
- (e) seal の差し替え: 旧 seal を store の中の**既知の名前**の控え（1 つ。直前の seal だけを残す）に保存し、控えも store の検査（owner・mode `0600`・symlink でない・通常の file）の対象にする。既にある控えが検査に通るなら置き換えてよい（crash 後の再実行で、旧 seal のままの状態から控えを作り直すため）。検査に通らない控え（symlink・別 owner・mode 違い・通常の file でない）があれば何も変えずに拒否する。一時 file は store の中に排他の作成（既存の名前・symlink を辿らない）・mode `0600` で作り、失敗・crash で残った一時 file は daemon の起動を妨げない。控えの作成に失敗したら旧 seal を残して何も変えない。新 seal は一時 file に書いて fsync してから置き換える（既存の writer は排他の hard link で既存の seal を置き換えられないので、置き換えの手順は設計で定める）。どの時点で落ちても、再起動後に「旧 seal のまま」か「新 seal」のどちらかで、`install_seal_corrupt` にならない。lock を失ったら書かない。
- (f) 変わった file が無ければ何もしない。seal が壊れている（`install_seal_corrupt`）場合は受け入れない（別の問題として止める）。seal が無い場合は、従来どおり daemon の初回起動が作る（このサブコマンドは作らない）。
- (g) daemon の `install_changed` の表示に、このサブコマンドと「想定外なら実行しない」の案内を足す。README の更新手順に書く。

### FR-F3 dialog の Resource 行

- (a) dialog の `Resource:` 行は、Router の内部の resource URL（hosted では loopback）を、人間が判断に使う値として出さない。`Router:` 行は従来どおり**実際の Router の URL**を出す（ローカルの Router を設定した場合はその loopback の URL が出る。隠さない）。route の識別（`md-mpp-eth-snapshot` と method）と「Router の内部の固定値」であることが分かる表示にする。
- (b) 承認の記録・offer との照合・`ROUTE_BINDING` は変えない（表示だけの変更）。照合の対象から resource を外さない。hosted の `ROUTER_CANONICAL_BASE_URL` を公開の origin に変える案は、0.1.x の payer の固定値と食い違うので採らない。

### FR-F4 宛先の decimals

- (a) dialog の `Destination amount:` は、固定の宛先（`eip155:42431` の pathUSD）の**正しい桁 6** を表示する。値の出所（Router の起動経路を直して quote に載せる、payer の固定の資産表の値を使う、または両方）は設計で決める。表示する桁は承認の記録（不変）に入り、記録を後から変えると `approval_mismatch` になる。
- (b) どの案でも、Router が 6 以外の `decimals` を返したら `quote_inconsistent`（既存の schema の不変条件を保つ）。Router が `decimals` を返さない場合の扱い（payer の表の値で表示するか、従来どおり「not supplied」か）は選んだ案で定め、試験する。
- (c) Router を変える場合は、既存の tool 名・引数・出力の形を壊さない加算だけとし、Router の config・projection の試験を足す。配備は owner の確認による。

## 3. 安全要件

- SR-F1: どの変更も、承認の唯一の関門（daemon の native dialog と passphrase）を迂回する経路を作らない。
- SR-F2: FR-F2 は same-user の改ざん（T4′）を検出・防止すると主張しない。正規の更新の手順を与えるだけで、人間が確認せずに受け入れれば改ざんも受け入れる。README にそう書く。
- SR-F3: 秘密（passphrase・合言葉・鍵）を引数・env・ファイル・ログ・出力に出さない（既存の SR と同じ）。

## 4. 受け入れ条件

- AC-F1: 拒否・取消の各行で `openWallet` の呼び出し 0。合言葉 = passphrase、NFKC で同じ（全角）、前後の空白違い、passphrase を含む（正規化後に含む行も）、の各行で拒否と合言葉だけの再入力。既存の拒否（空白だけ・制御文字・256 文字超）も維持。3 回の拒否・取消で終了し、socket の listen・session・UI の作成が 0、導いた鍵の buffer が 0 で埋まり、lock が解放される。別の合言葉なら起動する。wallet の認証は正規化しない passphrase で行う（全角の passphrase の wallet が従来どおり開く）。説明文が合言葉の入力の前に出る。出力に値・長さが無い。
- AC-F2: 版を変えた install で daemon が `install_changed` と案内を出す → 新サブコマンドが変わった file 名と version を表示 → 確認語の不一致で何も書かない → 一致で新 seal と旧 seal の控え → daemon が起動する。拒否の行: daemon の動作中、非 TTY、PTY だが誤った passphrase（PTY 自体は拒まない）、壊れた seal、seal が無い、変更なし（何も書かない）、控えの名前に検査に通らない file（symlink・mode 違い）がある、検査に通る既存の控え（置き換えて成功）、書き込みの失敗、lock の喪失。crash の行: 控えの作成の前後・新 seal の書き込みの前後・置き換えの前後で `SIGKILL` し、再起動後に旧 seal か新 seal のどちらかで daemon の検査が `install_seal_corrupt` にならず、受け入れの再実行で完了する。MCP・socket に入口が無いこと（tool 一覧と method の一覧）。
- AC-F3: hosted の設定で、`render` の `Resource:` 行に内部の resource URL（`127.0.0.1:8500`）が無く、route・method と「Router の内部の固定値」の表示がある。`Router:` 行は実際の Router の URL。ローカルの Router（loopback）を設定した行では `Router:` 行にその URL が出る。承認の記録の照合の試験（resource の 1 欄の違いで `approval_mismatch`）は変わらず通る。
- AC-F4: dialog の宛先の行に `decimals 6` が出る。Router の `decimals` が 6 以外なら `quote_inconsistent`（どの案でも）。欠落の場合は選んだ案の表示。記録の宛先の桁を変えると `approval_mismatch`。Router を変えた場合は、本番の起動経路（`loadConfig` の real モード）で静的 route の宛先に `decimals` が入ることを Router の試験で確かめ、hosted の配備後に公開の quote で読む。
- AC-F5: payer の全試験、types、clean install、sabotage（各 AC の守りを外すと落ちる）。Router を変えた場合は Router の全試験。Codex の独立レビュー。
- AC-F6（owner の手動）: 0.1.2 を公開して `npm i -g` → `install_changed` → 新サブコマンドで受け入れ → daemon の起動時に説明が出て、passphrase と同じ合言葉が拒否される → `ui-check` 相当でなく実際の quote の dialog で Resource と宛先の桁を確認（Cancel でよい。資金は動かない）。

## 5. 未確認（設計で確かめる）

- U-F1（解決、R-1）: `loadConfig` が `withDestinationDecimals` を通さないため（§0 の 4）。
- U-F2: 旧 seal の控えの既知の名前を `STORE_FILES` に足すときの、既存の store（控えが無い）との互換。
- U-F3: 合言葉の比較のために passphrase の文字列を合言葉の入力まで保持する期間（既存の startup では passphrase の検証の後に合言葉を読む）。

## 6. 独立レビューの記録

| # | 日付 | reviewer | 結果 |
|---|---|---|---|
| R-4 | 2026-10-10 | `gpt-6-astra`（readback。第 4 版） | **APPROVE**（指摘なし） |
| R-3 | 2026-10-10 | `gpt-6-astra`（readback。第 3 版） | **CHANGES_REQUIRED**（1 点: 上書きの再 install は既存の依存の内容を検証しない）。**第 4 版で反映** |
| R-2 | 2026-10-10 | `gpt-6-astra`（readback。第 2 版） | **CHANGES_REQUIRED**（3 点: 依存の確認が版だけ、控えの衝突の拒否と crash 後の再実行の矛盾・一時 file、wallet の復号 0 が条件付き）。**第 3 版で反映** |
| R-1 | 2026-10-10 | `gpt-6-astra`（read-only。第 1 版） | **CHANGES_REQUIRED**（6 点: TTY は人間の証明にならない、更新の確認に比較の対象が無い、seal の差し替え・控えの失敗条件、比較の境界と観測できる後始末、宛先の桁の正しい値と両案の不一致、Resource の試験の範囲）。**第 2 版で反映** |
