# 秘匿購入の proxy 型 TLS（増分 v1.5）タスク v2

要件 `docs/zktls-router-proxy-requirements.md` v3.2、設計 `docs/zktls-router-proxy-design.md` v2.1。1 タスク = 1 つの検証可能な増分。各タスクの完了条件は
**そのタスクの試験の追加と `npm test`・`npm run types` の全通過**（既存の試験の変更は、秘匿購入の MPC 型の試験の設定に `mpcProfiles` を足すことだけ）。
v1 は Codex のレビュー（`.claude_workflow/local/proxy-tasks-review1.md`、REJECT、blocking 1・should 4・minor 1）を受けて v2 に改めた（末尾に対応表）。

## 有効化の境界（blocking 1 への対応）
- T-X1〜T-X7 は**足すだけ**で、実合成の既定は MPC 型のまま（proxy 型はどの設定でも選ばれない）。各タスクの中間の状態で、proxy 型の指紋で MPC 型として買える経路は無い。
- 中間の proxy 型の試験は、`PrivateConfig` の**解析では作れない**内部の欄 `proxyActivatedForTest?: true`（試験が設定の値を直接組むときだけ付ける）で有効にする。
  `tlsModeOf(config, id)` は「`proxyActivatedForTest` が無ければ常に `"mpc"`、あれば `mpcProfiles` に載らないものが `"proxy"`」。
- **T-X8（有効化）**で、`proxyActivatedForTest` を消し、`tlsModeOf` を設計 §2 の形（既定 proxy 型）にし、既存の秘匿購入の試験の設定に `mpcProfiles` を足す。
  能力の門・pin・型の照合・payer 道具はすべて T-X7 までに入っているので、有効化は 1 つのコミットで安全策と同時に効く。

## タスク
| # | 内容（設計の節） | 主なファイル | 試験 |
|---|---|---|---|
| T-X1 | 設定: `mpcProfiles` の解析（既定値の表には足さない）、`tlsModeOf`（上の有効化前の形）、`src/private/proxy.ts`（新）に `PROXY_RELAY_LIMITS`、指紋の proxy 欄（§2） | `src/config.ts`、`src/private/proxy.ts` | `private-config.test.ts`: 部分集合・重複；`proxyActivatedForTest` 無しでは常に MPC 型；ありで型の決まり方；MPC 型の指紋が今と同じ（既存の値との一致）；proxy 型で `tlsMode`・`proxyRelay` |
| T-X2 | 能力の門: `readCapabilities`（§3）。`main.ts` は**同期の合成を変えず**、既存の非同期の起動の検査（`startup` の `startupChecks`）に門を足す（proxy 型のプロファイルがあるときだけ）。`readCapabilitiesForTest`、`fake-delivery.mjs` の `capabilities` | `src/private/verifier.ts`、`src/main.ts`、`tests/fixtures/private/fake-delivery.mjs` | `private-capabilities.test.ts`（新）: 一時の実行ファイルで正常・非 0・sleep・257 B・stderr 大量・形違い・未知の型・重複；門が失敗すると起動の検査が失敗し、core が受付を始めない（HTTP の口が開かない）こと；全部 MPC 型なら呼ばれない |
| T-X3 | 宛先の固定: `createDestinationPinner` と固定の宛先の transport（§4.1。設計 v2.2: `guarded-fetch.ts` は payer の vendor の写しなので変えない） | `src/net/pinned-destination.ts`（新） | `pinned-destination.test.ts`（新）: 設計 §12 の宛先の行の全部、payer の vendor 試験が不変に通ること |
| T-X4 | rail の探りに固定の宛先の transport を通す: `discover` の任意の第 3 引数 `{transport}`（§4.2） | `src/ports/private-outbound.ts`、`src/adapters/outbound/private-x402.ts`・`private-mpp.ts` | 既存の rail の試験 + `private-rail-pin.test.ts`（新）: 渡せばそれで送り rail の transport を使わない、渡さなければ今と同じ |
| T-X5 | 記録の型: `IntentPrivate.tlsMode`・`reservation.proxy` の型と store の厳格な復元（§8）、`reservePrivateIssuance` の任意の引数 | `src/core/intent.ts`、`src/core/store.ts` | `private-store.test.ts`: 設計 §12 の store の行の全部、旧 journal は MPC 型 |
| T-X6 | core: quote の欄と開示（§8）、`modeMatches`（§8.1）、`pinBeforeSettle`・`releasePin` と所有の受け渡し（§4.2・§4.3）、予約の後の読み直し、serve の引数（§5）、exit latch・`scheduleAt` の取り消し・失敗通知（§6、`parseFailureNotice` は `src/private/proxy.ts`）、record の束縛（§7）、射影と理由コード（§8・§9）、配線（§13）、**秘匿（§10）** | `src/core/private.ts`、`src/core/dynamic.ts`、`src/core/orchestrator.ts`、`src/shared/diagnostics.ts`、`src/private/proxy.ts`、`src/private/attest.ts`、`src/private/verifier.ts`（`ServeArgs.proxy`）、`src/main.ts` | `private-core.test.ts`・`private-attest.test.ts`: 設計 §12 の core・attest の行の全部（偽バイナリ: proxy の引数の記録、`failure.json` の各形、record の `tls_mode`）。実合成から `pinBeforeSettle` に届くこと。**§12 の「TR-X1 秘匿」の行と §10**: proxy 型の成功・失敗の両方で射影・journal・診断・保存した子の出力・作業ディレクトリに本文と（偽バイナリが出す）暗号文の canary が無いこと、canary を record に入れても journal に写さないこと |
| T-X7 | client の型・MCP の説明文・payer 道具（§8・§11） | `src/client/types.ts`、`src/mcp/*`、`tools/private-payer.ts` | `private-payer-*.test.ts`: 型への追従・`--connect` の拒否は credential の前・表示；MCP の説明文の試験があれば更新 |
| T-X8 | **有効化**: `proxyActivatedForTest` を消し既定を proxy 型に、既存の秘匿購入の試験の設定に `mpcProfiles`（全プロファイル）を足す。T-X1〜T-X7 の proxy 型の試験は `proxyActivatedForTest` を外して同じく通ること | `src/config.ts`、既存の試験の設定 | 全試験。MPC 型の golden が `mpcProfiles` の追加だけで不変、移行の試験（設計 §12 の core の行の「移行」）。**実プロセスの起動の境界**（T-X2 の残り。実装レビュー 1 回目の指摘 4）: proxy を宣言しないバイナリで Router のプロセスを起動すると、能力の門で終わり、HTTP の口を開かない（listen しない・journal を作らない） |
| T-X9 | 文書: README の秘匿購入の節に型と開示と `mpcProfiles`（lab の対応の前に入れるなら全プロファイルを書き出す）、`docs/zktls-router-acceptance.md` に proxy 型の受入手順（TR-X3: 実行の前に Provider・額・回数を記録、受信決済・送信決済・秘匿配送・Payer 受領・finality を別のゲートとして記録、所要時間を MPC 型と並べる） | `README.md`、`docs/zktls-router-acceptance.md` | 文書のみ |
| T-X10 | **lab との突き合わせ**（設計 §14）: lab の回答と実バイナリで LX の名前・形・`deliveryBinSha256` を確かめ、違えば §3・§5・§6・§7 の名前を差し替える（意味が違えば要件から）。中継の上限（§5）を実測で見直す | 該当ファイル | 差し替えた箇所の試験 |
| T-X11 | wire（§12 TR-X2）: `tests/wire/private-proxy.test.ts`（新）、`tests/fixtures/private/zktls-provider.ts` の接続の数え分け。実バイナリの成功・失敗で、**掃除の前**（停止点）と保持の後の canary の走査 | `tests/wire/*`、`tests/fixtures/private/*` | 設計 §12 の wire の行。lab の対応が無ければ skip（未検証として記録し、合格と書かない） |
| T-X12 | 受入（TR-X3、testnet、owner の包括承認の範囲）: Provider C・F を proxy 型で 1 件ずつ。T-X9 の手順のとおり | — | 受入記録 |

## 順序と依存
- lab に依存しない: T-X1 → T-X2 → T-X3 → T-X4 → T-X5 → T-X6 → T-X7 → T-X8 → T-X9。
- T-X10 は lab の LX-1〜LX-7 の回答と実バイナリの後。T-X11 は T-X8 と T-X10 の後。T-X12 は T-X11 の成功と T-X9 の後。
- Codex の実装レビュー: T-X1〜T-X5 の後に 1 回、T-X6〜T-X8 の後に 1 回、T-X10〜T-X11 の後に 1 回（区切りごとに差分と試験の実行結果を見てもらう。小さな修正のたびに全体を
  再レビューしない: CLAUDE.md「No repeated whole-plan reviews for a small correction」）。
- コミットはレビュー済みの区切りごと（ローカル。push は別の承認）。

## v1 → v2 の対応
| 指摘 | 対応 |
|---|---|
| blocking 1: 有効化が安全策より先 | 有効化の境界の節（T-X1〜T-X7 は足すだけ、`proxyActivatedForTest`、有効化は T-X8 で 1 コミット） |
| should 2: 定数の置き場 | T-X1 で `src/private/proxy.ts` を作り `PROXY_RELAY_LIMITS` を置く。`parseFailureNotice` は T-X6 |
| should 3: 門の非同期 | T-X2（同期の合成を変えず、既存の `startupChecks` に足す。失敗で受付が始まらない試験） |
| should 4: 秘匿の試験の持ち主 | T-X6 に §10 と「TR-X1 秘匿」の行、T-X11 に実バイナリの掃除の前後の走査 |
| should 5: lab 依存の準備 | T-X10（突き合わせ・上限の見直し）を新設、T-X11 は T-X8・T-X10 の後、T-X12 は T-X11・T-X9 の後、受入の記録の要件を T-X9 に明記 |
| minor 6: 規則の出典 | CLAUDE.md の原文に直した |
