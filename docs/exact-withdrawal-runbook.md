# zUSDC の売り上げの引き出し — 要件と手順書（testnet、v2）

状態：**草案。実測は未実施、`router-hosted` の wallet は開いていない**。オーナーの確認は「この順番で進める」（2026-11-25。手順書を書くところまで）。
wallet を開く操作（§5 の 2 から）は、1 回ごとにオーナーの go が要る。`status` も含む：読み取りではなく、未完了の operation を進める（F-12）。
対象：hosted の Provider `router-hosted` の wallet（Base Sepolia の zUSDC `0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f`）。
元の依頼：SubEtha 側の `ROUTER-BRIEF-DRAFT.md` §3.3（まとめて引き出す、`unwrap: true`、件数・USDC の下限・待ち時間で起動）。
含まない：自動化（鍵を host に置かない決まり。オーナーの別の決定）、mainnet、価格の値の変更、ツールの改修。
testnet の 1 回は**仕組みの確認**で、上流の残高の補充にはならない（F-9）。

## 1. 分かっていること（根拠つき）

`P:` は SubEtha protocol `71deb50`、`S:` は `@zerc20/wallet-sdk` 0.4.0 の `dist/`、`R:` は手元の記録（公開しない）。

| # | 事実 | 根拠 |
|---|---|---|
| F-1 | 売り上げは 1 件ごとに別の coin（`deposit`）。引き出しは 1 回ごとに relayer の費用を払う。先に `consolidate` でまとめ、1 回だけ `withdraw` する | `P:docs/PUBLIC-TESTNET-QUICKSTART.md` |
| F-2 | 1 回の merge は最大 100 coin、大きい順。一番大きい note も入る | `S:spend.js`（`MAX_MERGE_INPUTS`） |
| F-3 | `consolidate` は既定で計画だけ。**pending の operation があれば sync の前に断る**。`--execute --max-fee` は、もう一度 sync・選択・見積もりをする（**計画と coin も費用も変わり得る**）。spendable でない coin、1 回で済まない merge、上限を越える費用、何も残らない merge は断る | `P:packages/zerc20-v2-adapter/src/provider-tools.ts`（`consolidatePlan`・`consolidateOnce`） |
| F-4 | 2 つの命令は `<state-dir>/withdraw-journal.jsonl` に開始を先に書く。結果の無い開始が残ると、**両方とも断る** | 同（`openAttempts`） |
| F-5 | `withdraw` は、見積もりと上限の検査を開始の行より**前**に行う。開始の後の例外では、pending の withdraw が見当たらなければ `withdraw-failed-before-create` を**自動で書いて閉じる**。`consolidate` は、SDK が `read-only` で断り新しい operation も無い時だけ閉じ、ほかは開いたまま | 同（`withdrawOnce`・`consolidateOnce`） |
| F-6 | 実測 A（2026-11-21、router-local、1 回）：coin 7（12,000 の売り上げ 5、probe の 1、note 592）計 60,593、費用 8,931（relayer 8,900・protocol 31）、note 51,662。命令の開始 10:41:15Z、spendable を見たのは 10:49:03Z（上限。約 8 分）。引き出し 42,613、費用 9,049。開始 10:49:32Z、tx の block の時刻 10:49:51Z。残り 0 | `R:consolidate-run/` |
| F-7 | 実測 B（2026-11-24、SubEtha の session の報告。`hosted-b/RESULT.md` と `out/d16-*.json` を読んで照合）：coin 18、計 32,002、費用 9,232。引き出し 13,000、費用 9,245。売り上げの coin が spendable になるまで約 11 分（`RESULT.md`）。merge の完了を見たのは開始から約 7 分以内（**相手の報告だけ。時刻の証跡は見ていない**。証明の時間ではない）。引き出しの所要は記録なし | `hosted-b/RESULT.md`、`out/d16-*.json`、相手の報告 |
| F-8 | **ツールの `withdraw` に `unwrap` の指定が無い**（zUSDC のまま出る）。SDK には `unwrap?: boolean` がある | `P:apps/provider-x402-ext-sample/scripts/provider-wallet.mjs`、`S:wallet.d.ts` |
| F-9 | **testnet の zUSDC の裏付けは `0xD9D3a44745a5d04197024a20fD5BeD9b8B56C60D`「Dummy USD Coin」**で、Router が上流に払う Circle の USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` とは**別の token** | chain の読み取り（block 63379868、`R:withdraw-runbook/underlying.txt`）、`P:docs/PUBLIC-TESTNET-QUICKSTART.md` |
| F-10 | ツールに、引き出せる最大額・見積もりだけの命令が無い。返事に tx hash は無い。`status` は coin の一覧を出さない（`consolidate` の計画は出す） | `P:` 同 CLI、`providerStatus` |
| F-11 | 配布版は `@subetha/provider-tools` 0.2.0（bin は `subetha-provider-wallet`・`subetha-provider-audit`）。npm の integrity は release の表と一致。Node 22.12 以上 | `P:docs/PROVIDER-KIT-RELEASE.md`、`R:withdraw-runbook/npm-view.txt` |
| F-12 | `status`・`--execute`・`withdraw` の sync は、pending の operation を**進める**。記録（storage）も書き得る | `S:wallet.js`（`sync`・`#catchUp`） |
| F-13 | CLI は結果を出力した**後**に `close()` を待ち、その中で lock を消す。結果の後に process が終わらない観測が 2 回（2026-11-21 は出力の後。2026-11-24 は出力の有無が不明で約 2 時間） | `P:` 同 CLI、`openProviderWallet`、`R:`、SubEtha 側の記録 |
| F-14 | lock（`facilitator-v2.lock`）は **state の directory ごと**。同じ wallet を別の directory・別の端末で開くことは止められない。開くと互いの state を上書きし、同じ note を使い得る | `P:packages/zerc20-v2-adapter/src/durable-fs.ts`、`S:wallet.js`・`wallet.d.ts`（`lockWallet`） |
| F-15 | 引き出しは「額 + 費用」を満たす**合計が最小**の coin 1 つ（または coin + note）を選ぶ。まとめた note が必ず使われるわけではない | `S:spend.js`（`pick`） |

**費用の式**（SDK）：引き出しの費用 = relayer + (gross − A)。gross は、chain の `withdrawFee(gross)` を引いた後に受取人が A 以上になる最小の値。merge の費用 = relayer + (relayer を gross にした差)。0.35% の率は chain の設定で、
この文書では実測との一致を見ただけ（A：8,900 → 31、42,613 → 149。B：9,200 と置くと merge 32、引き出し 45 で、**relayer 9,200 は逆算**）。
A と B は 8,900・9,200 で、件数（7・18）によらず日で動くように見えるが、**2 点なので断定しない**。

**未確認**：19 coin 以上の merge、relayer の費用が動く幅、`unwrap: true`、配布版 0.2.0 で今の `router-hosted` の state を開くこと、今の `router-hosted` の coin の数。
以前の相手とのやり取りにあった「40 件の証明の上限」は誤り（実証の購入の上限 40 件の取り違え）。

## 2. 要件

- **W-1（1 回だけ）** 1 回の窓で、merge は最大 1 回、引き出しは最大 1 回。結果が分からない時も、開始が閉じた時も、**同じ窓で繰り返さない**。
- **W-2（鍵）** wallet の鍵・view key・POS key・token・RPC の URL は、値を画面・argv・log・chat に出さない。渡すのは path だけ。host に置かない。file は 0600、directory は 0700。
- **W-3（費用の上限）** `--max-fee` を必ず付ける。越えたら止める（上げて繰り返さない）。
- **W-4（宛先）** 宛先はオーナーが承認した 1 つ。命令を出す直前に全桁を見比べる。
- **W-5（正本は 1 つ）** 対象の wallet を開く directory は 1 つだけ。窓の間、ほかの directory・端末・SDK の script で開かない。空の directory を作り直して代わりにしない。
- **W-6（照合）** 前後の監査が合格。宛先の残高の増分 = A。wallet の全体の残高（spendable と pending）の変化 = 窓の間の入金 − A − 費用の合計（merge と引き出し）。
- **W-7（販売は止めない）** 受付は止めない。ただし `--execute` は新しい入金も取り込み得る（F-3）。「次の回に回す」ことは今の CLI では保証できない。
- **W-8（記録）** §6 の表。秘密は残さない。finality を読んだかも書く。
- **W-9（開示）** 引き出しは公開の送金（額・宛先・時刻が chain に見える）。

## 3. いつ引き出すか

**件数は 2 つに分けて数える**（merge の coin の数とは別に記録する）。どちらも note と、確認用 address の 1 最小単位を除く：
- **未処理の売り上げ N** = `plan.coins` の `kind` が `deposit` のもの全部（審査中も含む）。
- **今回の採算の件数 n** = そのうち `mergeable.ids` に入っているもの（spendable だけ。F-3）。**起動の件数と採算の判断は n で行う**。

**処理済みの境目**：merge が `done` と確かめられ、かつ **N = n（未処理の売り上げが全部その merge に入った）**、かつ**下の N + m の照合が合った**時だけ、その時点の最後の売り上げまで進める。境目は注文の作成でなく**支払いの成立の時刻**で引く。
審査中のものが残った窓（N > n）、断られた・不明・失敗の窓では**進めない**（merge の選択は時刻順でなく金額順なので、境目を進めると古い売り上げを飛ばす）。進めなかった窓で merge に入った件数は m として足していき、境目を進めた時に 0 に戻す。
最も古い売り上げの時刻は、境目より後で Router の注文の記録（`subetha-exact:inspect`）が支払い済みとする最初の注文とする（m > 0 の間は実際より古い側に出る）。
境目より後の支払い済みの注文の数が **N + m** と一致しない時は「不明」と書き、待ち時間を理由に実行せず、**境目も進めず、m も 0 に戻さない**（食い違いを先に調べる）。
60 秒を越えて成立した支払いは Router の記録で `unknown` のままなので、ここで食い違う（`inspect --remote` の `accepted` で探す）。拒否された deposit は監査が不合格になり、引き出し自体を止める（解消の手順はこの文書に無い。別の判断）。

| きっかけ | 【案】 | 理由 |
|---|---|---|
| 件数 | n が **10 以上** | 固定の 12,000（差 2,000）で、分担は実測 B（9,232 + 9,200 = 18,432）÷ 10 = 1,844、0.35% 分が約 42。9 件では約 2,090 で差を越える |
| 待ち時間 | 最も古い売り上げから **30 日** | 件数が届かない時。費用倒れなら実行しないことも選ぶ |
| USDC の下限 | **testnet では使わない** | F-9。mainnet では別に決める |
| 上限 | coin が **80** に達したら検討 | merge の上限 100（F-2）に余裕を残す。実証の総数は 40 件なので今は起きない |

**式の価格（今は無効）への影響**：`withdrawCost` 18,000 は実測 B の 18,432（0.35% 分を除く。含めると 18,477）より低い。`withdrawBatch` 8 なら 1 件 2,250 に対して 2,304 で、1 件あたり 54 足りない。
値の変更は別の承認（§9）。これらは 2 回の実測による概算で、黒字の保証ではない。

## 4. オーナーの判断が要る点

| # | 問い | おすすめ | ほかの案 |
|---|---|---|---|
| D-1 | unwrap するか | testnet では**しない**（F-8・F-9）。mainnet の前に `--unwrap` を SubEtha 側に頼む（§8） | 私的な script で SDK を直接呼ぶ。journal の守りの外に出るので勧めない |
| D-2 | 起動の条件（§3） | 10 件・30 日 | 8 件・7 日（固定の価格では費用倒れになる） |
| D-3 | 宛先 | 実証の買い手 `0x50D99a29166E5ee0e0f931C8D7e67b498F86572F`（次の確認の購入に回せる。買い手と Provider が同じ運用者だと chain で分かる。前回と同じ開示） | 運用者の別の新しい address |
| D-4 | 実測 | 売り上げが 8 件以上 spendable の時に 1 回。購入は足さない | 購入を足して 20 件・40 件でも測る |

## 5. 手順

**path**（どれも手元。値ではない）：
`W` = 0.2.0 の bin `<KIT>/node_modules/.bin/subetha-provider-wallet`、`AU` = 同 `subetha-provider-audit`、`KEY` = router-hosted の EOA の鍵、`ST` = 正本の state（1 つだけ）、`RPC` = **archive** の Base Sepolia RPC の URL の file（0600。過去の読み取りに archive が要る）、`TOK` = router-hosted の Provider token、`VK` = view key の file、`AST` = 監査専用の state（`ST` と別）、`REC` = 記録。
wallet の命令：`W <命令> --key-file KEY --allow-plaintext-key --state-dir ST --rpc-url-file RPC`（`--allow-plaintext-key` は testnet だけ）。

**go の範囲**：G-a = 手順 1〜3（読み取りと計画。`status` と `export-view-key` を含む）、G-b = 手順 4〜5（merge）、G-c = 手順 6〜7（引き出し）。go は 1 回ごと、その窓だけ。

**0. 用意（1 回だけ、wallet は開かない）** 新しい空の directory `KIT` に `npm install --ignore-scripts @subetha/provider-tools@0.2.0`。tarball の integrity を `P:docs/PROVIDER-KIT-RELEASE.md` の表と照合する。`W help` に `consolidate --execute`、`AU --help` があることを確かめ、版と integrity を記録する。

**1. 守りの確認（wallet は開かない）**
- `ST` を開く process が無く、ほかの directory・端末で同じ wallet を開いていない（W-5）。確かめた方法と時刻を記録する。
- `ST` に `facilitator-v2.lock` が無い。**あれば消さない**。書かれた pid が動いているかを見て報告し、判断を待つ。
- `withdraw-journal.jsonl` に結果の無い開始が無い。
- `ST` の写しを、process が無い間に 0700 のまま取る。**写しを戻して使わない**（古い state は使った note を知らない）。写しは調査のため。

**2. 読み取り（G-a）**
- まず `consolidate`（計画だけ）。pending があれば sync の前に断られる（F-3）。断られたら `status` に進まず、§7 へ。pending は前の窓の operation の可能性があるので、`status` で進めるのは別の go。
- pending が無ければ、計画の出力（`plan.coins`・`mergeable`・`quote`・`left`・`openAttempts`）と、`status` の出力（残高、payments の件数・rejected・screening、operations）を `REC` に残す。
- view key が無ければ `export-view-key --out VK`（新しい 0600 の file。秘密の file を作る）。初回の監査には `status` の `birthday` が要る。
- 監査：`AU --facilitator-url https://facilitator-testnet.subethalabs.com/p/router-hosted --token-file TOK --view-key-file VK --state-dir AST --birthday <birthday> --probe <確認用 address（全世代を繰り返す）> --rpc-url-file RPC`。exit 0 で `ok: true`、unmatched・missing・rejected が空。**不合格なら引き出さない**。
- 宛先の zUSDC の残高と block を読む。

**3. 計画の判断（G-a の終わり）** `mergeable` が null なら merge しない（まとめた note が前の窓から残っている場合は下の「再開」）。`steps` が 1 でなければ止める。売り上げの件数（§3）、merge の coin の数、費用、`left`、引き出しの見込みを書いて**オーナーに見せ、G-b を待つ**。

**4. まとめる（G-b。資金が動く）** `consolidate --execute --max-fee <計画の fee × 1.1 を切り上げ>`。
返事の `id`・`merged`・`total`・`fee` を記録する。**note の額の見込みは `total − fee`**（計画の `left` ではない）。返事が無い・error なら §7。同じ命令を繰り返さない。

**5. 待つ** `status` を 1 分以上の間隔で、**1 つずつ**（前の process が終わってから）。対象の id が `done` になったら、`consolidate`（計画だけ）で `plan.coins` を読み、**spendable の note のうち `total − fee` と一致するもの**を確かめる。
- これがまとめた note L。一致する note が無い・2 つ以上・`failed`・30 分を越えた場合は止めて §7。
- `status` の出力が出ても終わらない場合の止め方は §7 の「process が終わらない」。

**6. 引き出す（G-c。資金が動く）**
- R = G-b の計画の `quote.relayer`。M = `ceil(R × 1.1) + ceil(L × 0.36%) + 1`。**L > M でなければ引き出さない**。A = L − M。
- 成り立つ条件：実際の費用 ≤ M なら A + 費用 ≤ L なので、L の note 1 つで払える（別の coin が選ばれることはある：F-15。A と費用は変わらない。残りは M − 費用とは限らない）。M の 0.36% は率 0.35% の仮定による余裕。
- 宛先を D-3 と全桁見比べ、`withdraw <宛先> <A> --max-fee <M>`。
- 費用が M を越えて断られたら、開始の行は無い（F-5）。**値を上げて続けず**、G-c を終える。

**再開（merge は前の窓で済み、引き出しが未作成の時だけ）** 新しい窓として手順 1〜2 を行い（G-a）、次を全部確かめる：journal に結果の無い開始が無い、前の merge が `done`、前の窓の後に withdraw の開始が無いか `withdraw-failed-before-create` で閉じている、`plan.coins` に前の `total − fee` と一致する spendable の note がちょうど 1 つ。1 つでも欠ければ止める。
- `mergeable` が null だと見積もりは出ない（lone note）。R は**オーナーが go の時に上限として決める**（前の観測 8,900・9,200 は参考だけ）。L は今読んだ note。M・A は手順 6 の式で計算し直し、数字を見せて G-c を待つ。実際の費用が M を越えればツールが断る（F-5）。
- `mergeable` が null でない（新しい売り上げがある）時は、通常の手順 3 から（note も一緒に merge され得る：F-2）。

**7. 確かめる** `status` が `done`（手順 5 と同じ待ち方）。
- **tx**：ツールは返さないので、公開 RPC で zUSDC の `Transfer`（to = 宛先、value = A、手順 6 の開始の block から）を読む。**ちょうど 1 件**でなければ「未確認」で止める。receipt の status が 1。
- **残高**：宛先の増分 = A。同じ address に別の入金があれば分けて書く。
- **費用の内訳**：journal には費用の合計だけが残る。relayer と protocol の別は書かず、合計と、計画の `quote`（merge）だけを書く。
- **監査**をもう一度（同じ `AST`）。その後、`finalized` の block が tx の block 以上になったことを読む（読まなければ「未確認」）。
- 1 つでも合わなければ「検証不一致」として止める（§7）。再試行はしない。

## 6. 記録の表（1 回ごと）

| 項目 | 値 |
|---|---|
| 日時（UTC）、ツールの版、go の時刻（G-a・G-b・G-c） | |
| 売り上げの件数（§3 の数え方）、merge の coin の数、合計 | |
| merge の費用（relayer・protocol）、開始から spendable まで（上限） | |
| L、A、M、引き出しの費用の合計、着金まで | |
| 費用の合計 ÷ 売り上げの件数（0.35% 分を含む・除くの 2 通り） | |
| 窓の間の入金、残り、宛先の残高の前後、tx、finality を読んだか | |
| 監査の前後 | |
| 想定と違った点 | |

## 7. うまくいかない時（どの状態でも、勝手に再実行しない）

| 状態 | 見分け方 | すること | しないこと |
|---|---|---|---|
| **開始前に断られた** | journal に新しい開始の行が無い | 数字を記録して終える。次の窓で計画から | 上限を上げて続ける |
| **withdraw が閉じた失敗** | `withdraw-failed-before-create` | 閉じているが、**この窓では終わり**。`consolidate`（計画）で状態を読み、報告 | 同じ窓での再実行 |
| **開始だけで結果なし** | 開始の行があり、閉じる行が無い（consolidate の error の多くはこれ） | operation の id を `status`（別の go）と chain で探す。見つかれば追跡だけ。見つからなければ「不明」 | 再実行、journal の行の手書き、journal を消す |
| **created だが pending** | `created` の行、`status` が `pending` | 待つ。30 分を越えたら報告。**入力は使用中で、後から成立し得る** | 取り消し、別の引き出し |
| **`failed`・検証不一致** | `status` の `failed`、tx が 1 件でない、残高が合わない、監査が不合格 | 止めて、分かった事実だけ報告 | 合わせるための追加の送金 |
| **process が終わらない** | 出力が完全で、**その process が使う directory**（wallet の命令は `ST`、監査は `AST`）に lock が無い | lock が消えていれば `close()` は済んでいる。`SIGTERM` で止め、**process が消えたこと**と両方の directory の lock・journal を確かめるまで、次の操作をしない | 出力だけを理由に止める。別の directory の lock で判断する |
| | 出力の有無によらず、その directory に lock がある | 240 秒で警告、以後は報告してオーナーの判断を待つ。止める前に pid・出力・journal を記録する。止めた後は lock を消す前に確認と判断 | 自動の kill、lock の自動削除 |
| **lock が残った** | 前の process が無いのに lock がある | pid を確かめて報告 | 自動で消す |
| **`funds-settling`・spendable でない** | 審査（実測 B で約 11 分。2026-11-21 の約 25 分は手元の覚え書きだけ）か root 待ち | 日を改める | 無理に coin を選ぶ |
| **merge は済み、引き出しは未作成** | journal に withdraw の開始が無いことを確かめた | 資金は note のまま wallet にある。日を改めて §5 の「再開」 | この確認なしに「note のまま」と書く。前の窓の L・R・M を使い回す。不要な merge を足す |

どの状態でも「wallet の資金がどこにあるか」を、確かめた事実と未確認に分けて書く。rage exit は含まない。

## 8. SubEtha 側に頼むこと（依頼だけ。mainnet の前。相手の記録に入った）

1. `withdraw` に `--unwrap`（journal に残すこと）。
2. 引き出しの見積もり・最大額だけを出す命令（operation を作らない）。
3. `status` が結果の後に終わらない件。

## 9. 終わりの条件

独立レビューの指摘を反映し、D-1〜D-4 をオーナーが決めたら手順書として使える。実測（§6 の 1 回）は別の go。表を埋めてから `withdrawCost`・`withdrawBatch` の見直しを提案する（実測 B だけでも 18,000 は低い。式は本番で無効なので、今の影響は無い）。
