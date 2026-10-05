# タスク分解: 動的上流 URL

> 2026-10-05、第 2 版。入力は `docs/dynamic-upstream-requirements.md`（要件、§10.1 の改訂を含め owner 承認済み）と
> `docs/dynamic-upstream-design.md`（設計 第 2 版）。以下「設計 §x」はその文書を指す。
> 本書はタスクフェーズの成果物で、コード・実行結果・合格の主張は含まない。記載のコマンドは**計画であり未実行**。
> 第 1 版は独立レビューで REJECT（高 4・中 5）。指摘と反映先は §4。

## 0. 全タスク共通

- **担当**: 親（controller）が状態・commit を持ち、実装後に実ソースを読み戻してテストを実際に実行する。レビューは `gpt-6-astra`・read-only で差分を見る
- **順序**: まず落ちるテストを書き、赤を確かめてから実装する。完了条件の試験は**守っているコードを外して落ちること**を確かめ、結果を PR に書く
- **完了コマンド**: focused（当該テスト）→ `npm run types` → `npm test`。skip と失敗を区別して報告する。
  macOS では `guarded-transport` の T-A5・T-A6・T-A8 が既知の失敗なので、**「Linux」と書いた完了条件は Linux（Colima の VM か本番と同じ AL2023）で実行した結果を要する**
- **無課金**: T15 までのどのタスクも、署名済みの送金・faucet・有料 API を使わない。外部への接続があるのは T0-b・T0-c の**未払いの読取**だけ。実決済は T16 の gate
- **既定で無効**: T15 まで、動的 URL は**本番の入口の設定で有効にしない**。T13 がそれを試験で固定する
- **静的 route を壊さない**: 各タスクで既存テスト全通過（AC-23）。静的の経路に条件分岐を足さず、動的は別関数・別インスタンスに分ける。
  意図して静的に影響するのは T12（入口の資源上限、要件 FR-35 の例外）だけ
- **依存**: 新しい npm 依存を足さない。足す必要が出たらそのタスクを止めて確認する
- **commit**: タスク単位（1 タスク 1 PR）。レビューの指摘は同じタスクの中で直す。小さな訂正に全体の再レビューをしない
- **停止条件**: 誤支払い・二重支払いの可能性、秘密の露出、設計と実測の食い違い（設計を改訂してから続ける）、未許可の権限

## 1. 依存

```
T0-a → T0-b → T0-c           （承認済みの計測順。設計 §10）
T1 設定
T2 URL            ← T1
T3 transport
T4 門
T5 控え・動的予算  ← T1
T6 port と fixture ← T3
T7 受信の束縛      ← T6
T8 x402 送信       ← T0-c, T2, T3, T6
T9 MPP 送信        ← T0-a, T0-b, T0-c, T2, T3, T6
T10 core           ← T1, T2, T4, T5, T6
T11 HTTP・client・MCP ← T10
T12 入口の資源上限  （独立）
T13 配線と本番入口  ← T3, T7, T8, T9, T10, T11, T12
T14 統合試験        ← T13
T15 文書            ← T14
T16 gate            ← T15
```

T1・T3・T4・T12 は前提が無く、T0 と並行できる。

## 2. タスク

### T0 — 実装の前に測る（設計 §10）

| ID | 内容 | 成果物 | 完了条件 |
|---|---|---|---|
| **T0-a**（M-2） | SDK（`mppx` の tempo charge・push）→ 包んだ local account → 固定の Tempo serializer → guarded RPC を**オフライン**で通す probe | `tools/dyn-mpp-sign-probe.ts`、設計 §3.3 に結果の表 | `signTransaction` に渡る実物の欄、`chain.feeToken` が入ること、`sign({hash})` と serializer の差し替えが効かないこと、**1 件の支払いで出る RPC の方法と回数**を記録。鍵は毎回の乱数、ネットワークは loopback の RPC fixture のみ。**設計 §3.3 の表と食い違ったら設計を改訂してから T9 に進む** |
| **T0-b**（M-1） | MPP 送信の実手数料と、`gas × maxFeePerGas` から `feeAsset` の base units への換算・丸め | 設計 §3.3・§6.4 に換算式・実測値・`maxFee` と手数料規則の案 | **既存の**送信 tx の receipt（本番 journal の txRef）を公開 RPC で読む。換算式が実額を上から抑えることを読んだ全件で示し、Tempo の手数料の仕様と照らす。**新しい支払いはしない**。式が決まらなければ MPP 送信のプロファイルは T16 で有効にしない |
| **T0-c**（M-3） | 実 challenge の欄の一覧: Provider A・B と、公開されている第三者の x402／MPP エンドポイント数件 | 設計 §3.3 (i) の許可キーの確定、§11 の互換性の記述 | **未払いの読取のみ**、1 エンドポイントにつき数回まで。読んだ URL・日時・欄の一覧を設計書に残す（本文は残さない） |

### T1 — 設定と指紋（設計 §1）

- **範囲**: `src/config.ts`（`DynamicConfig`・`DynamicProfile`、起動時検証、`resolveProfile`、指紋）。挙動は変えない
- **完了条件（unit）**: 省略時は無効／`par !== true`・route と同名・`mpp` 送信で `feeAsset` 無し・不正な額や decimals は起動失敗／
  どの欄・`enabled` を変えても指紋が変わる／静的 route の指紋は変わらない

### T2 — 上流 URL の検査（設計 §2.2・§7.4）

- **範囲**: `src/net/upstream-url.ts`（新規、純粋関数）
- **完了条件（unit、AC-11・AC-13 の判定）**: 設計 §2.2 の各規則を 1 つずつ／クエリは保たれる／`denyHosts`・canonical・facilitator・RPC のホストとサブドメインを拒否し、接尾辞が同じだけの別ホストは通す

### T3 — transport の拡張（設計 §3.1・§3.4・§7.3）

- **範囲**: `src/net/guarded-fetch.ts`。**すべて生成時のオプションで、未指定なら現行と同じ挙動**
- **完了条件（wire）**:
  - **静的の不変**: オプション未指定の transport は、DNS の期限・解決数の上限・ヘッダ上限・`admit` のどれも持たない（未指定時の Agent 設定と挙動を固定する試験。既存の T-A 系も通る・**Linux**）
  - `dialForTest`: つけても loopback・内部に解決する名前は判定で拒否。通った接続は fixture に届き、SNI・証明書検証・`Host` は元のホスト名
  - `maxHeaderSize`: 超過が失敗になる
  - DNS: 期限（3 秒）と**要求の中断**のどちらでも待ちを打ち切る／打ち切った後も、実際の lookup が終わるまで「進行中の解決」の枠を使い続け、終わったら返す／枠が埋まっていれば解決を始めずに拒否
  - `admit`／`release`: 重複を除いた**全アドレスに対して不可分**に取り、1 つでも枠が無ければ**何も取らずに**拒否（途中まで取った分を巻き戻す）／接続の前に呼ばれる／`release` は本文の読了・中断・失敗で 1 回だけ
  - **静的検査**: `src/main.ts` の本番経路と `tools/` が `dialForTest` を参照しない

### T4 — 動的の門（設計 §7.3）

- **範囲**: `src/core/dynamic-gate.ts`（新規、時計を注入できる状態機械）
- **完了条件（unit）**: 設計 §7.3 の表の各上限（頻度・同時実行 × 全体・送信元・ホスト名・アドレス、未払い quote 数）／窓の経過で回復／
  **purchase の枠は 1 回の取得で手順全体を覆い、終了（成功・失敗・例外）で 1 回だけ返る**／キー数の上限を超えたら新しいキーは拒否（緩い枠に落とさない）／返し忘れ・二重返却で数が狂わない

### T5 — 控えと動的予算（設計 §6.1・§6.2・§6.4）

- **範囲**: `src/core/quote-ledger.ts`（新規）、`src/core/budget.ts`（動的の再生と昇格）、`src/core/intent.ts`・`src/core/store.ts`（`upstream`・`dynamic` の欄）
- **完了条件（unit）**:
  - 控え: append＋fsync、1 行 8 KiB 以下（超える記録は拒否）、`attempt` は 1 quote に最初の 1 行だけ・512 バイト以下、期限切れの除去、7 日より古いファイルの削除
  - **容量（AC-21）**: 未払い quote を上限（200）まで発行した状態で、メモリ上の件数・起動時に読む行数・journal の増分（0）を数えて上限内であることを示す
  - **MPP の証拠（設計 §6.3）**: `attempt` 行が再起動後も読め、期限内の quote はメモリに戻る
  - 昇格: 「残枠の検査 → `created` 1 行」を同じ mutex で。通らなければ 1 バイトも書かない。並行する 2 件で枠が 1 つなら片方だけが書く
  - 動的予算は `created` 行の `dynamic.reservation` だけを数え、静的予算は `budget_reserved` だけを数える（互いに不変）。手数料の額が `feeAsset` のバケットに入る
  - 旧形式の journal と、動的の行を含む journal を**動的無効の設定で**再生できる。`created` の復元で `upstream`・`dynamic` が消えない

### T6 — port と fixture（設計 §3・§3.1・§4）

- **範囲**: `src/ports/outbound.ts`（`UpstreamTarget`、`readChallenge`／`pay` の省略可能な `target`、省略可能な `balanceOf`）。既存 adapter は `target` を受け取ったら例外にするだけ（動的経路は T8・T9）。
  `tests/fixtures/`: TLS の上流 fixture（x402・MPP、試験用 CA。既存の MPP fixture は HTTP の loopback URL なので動的の URL 規則を通らない）、
  **EIP-3009 の署名と nonce を実際に検証する** facilitator fixture、**実形の Tempo receipt を返す** RPC fixture、`dialForTest` を使う起動ヘルパ
- **完了条件**: 既存 adapter に `target` を渡すと例外・渡さなければ現行と同じ（unit）／各 fixture が単体で動くことの最小の試験（TLS で 402 を返す、正しい署名は通し誤った署名・使用済み nonce は拒否する、receipt の欄が実 SDK の検証を通る）

### T7 — 受信の束縛（設計 §4）

- **範囲**: `src/adapters/inbound/x402.ts`（生成時オプションで nonce 束縛）
- **完了条件（wire、AC-5 の adapter 部分）**: 正しい credential が通る（正の対照）／x402: 別 quote の署名をそのまま → preflight で拒否、nonce 欄だけ書き換え → **verify で拒否**／
  MPP: B の id に A の欄・B の challenge に A の送金 → verify と settle の両方で拒否（実 SDK＋T6 の RPC fixture）／同額・異額／オプション無しの adapter は従来どおり乱数 nonce を受け付ける。
  AC-5 の「送信は高々 1 回」（静的↔動的・並行・再オープン）は T14

### T8 — x402 送信の動的経路（設計 §3.2〜§3.4）

- **範囲**: `src/adapters/outbound/x402.ts`
- **完了条件（wire、T6 の TLS fixture と `dialForTest`）**:
  - offer の検査（設計 §3.3 (i)、キーは T0-c で確定したもの）を 1 項目ずつ。個数の上限 16
  - **署名の境界（AC-16）**: SDK を差し替えて `EIP712Domain` 型・domain の値・`types`・`primaryType`・`to`・`value`・有効期間を変えさせ、**元の署名器の呼び出しが 0**。正しい場合は Router が組み直した typed data に 1 回だけ署名
  - 一致の定義（設計 §3.2）を 1 欄ずつ変え、**署名器の呼び出しが 0**（adapter の範囲。受信 settle が 0 であることは T14）
  - **有料要求の期限は既定 30 秒・設定可能**（暫定の方針。testnet の第三者への試行で、5 秒で打ち切った支払いがチェーン上は決済されていた。設計 §3.3）。未払いの読取は 5 秒のまま。期限で打ち切ったとき、門の枠が返ることと終端が `unknown` になることを確かめる
  - **offer の選択の fixture**: 検査を通る offer が 2 つ目以降にある場合／ヘッダと本文の両方に `accepts` があり中身が食い違う場合（**ヘッダが権威**、本文は読まない）
  - **応答（AC-14・AC-15）**: リダイレクトに従わない／期限超過で打ち切る／402 本文・ヘッダ・有料本文の各上限で**読み切らずに中断**したこと（fixture が送った量と読まれた量）／receipt を本文より先に判定／text・配列・偽 receipt がそれぞれ定義した終端／未払いの要求と支払い後の要求でヘッダ超過の終端が違う
  - 静的の x402 送信の既存テストが通る

### T9 — MPP 送信の動的経路（設計 §3.3）

- **範囲**: `src/adapters/outbound/mpp.ts`
- **完了条件（wire）**:
  - challenge の許可リスト（T0-c）と `splits`・`machineTokenEnabled`・額 0・`pull` のみの拒否。**`methodDetails.feePayer`（真偽値）は許すが使わない**: `feePayer: true` の challenge でも push で払い、transaction に `feePayer`・`feePayerSignature` が現れたら署名しない（設計 §3.3 の「Tempo 側の Provider」）
  - 能力が `push` 明示・`account.type === "local"`・素の `http` transport でなければ**起動失敗**
  - **署名の facade（AC-16）**: `sign({hash})`・`signMessage`・`signTypedData`・`signAuthorization`・渡された serializer・call 2 つ・別の `to`・額違い・`feeToken` 未指定／別資産・手数料上限超過・`keyAuthorization` で**元の account の呼び出しが 0**。元の account が `tempo.charge` の `account` からも SDK に返す client からも到達できない。nonce と有効期限の欄は範囲を確かめて引き継ぐ
  - 送信の境界が同じ欄をもう一度見る／送金系は 2 メソッドだけ／読取はそのまま通る／1 支払い 1 回
  - **1 件の支払いで出る RPC の要求数が T0-a の実測と一致することを試験に固定**（増えたら落ちる）
  - 一致の定義・応答の上限と形は T8 と同じ観測（AC-6・AC-14・AC-15）／scope は「あれば照合・無ければ不問」、静的は従来どおり必須

### T10 — core の動的 quote／purchase（設計 §2・§5・§6）

- **範囲**: `src/core/orchestrator.ts`（動的は別関数）
- **完了条件（unit、合成レールと接続カウンタ）**:
  - quote: 無効・URL 不正・門の拒否は**外部接続 0**（AC-1・AC-11・AC-17）／選択順・換算・手数料の丸め・桁あふれ・上限（AC-8・AC-9）／記録に設計 §2.4 の全欄、`ownerKey` は応答だけ・保存はハッシュ／`requestId` の衝突（AC-7）
  - purchase の順序（設計 §6.2）: 各段で書かれる行と呼ばれる外部を数える。**門の purchase 超過は、上流・facilitator・RPC のどれにも接続 0**。枠は手順 1〜6 の間ずっと保持
  - **残高の事前確認**: `balanceOf` があるとき、元本の資産と手数料の資産を別々に（同じ資産なら合算で）確かめ、不足なら `operator_funds_unavailable`・**settle 0・何も書かない**。無いときは検査しない
  - 無効な credential・予算切れ・verify 後の期限切れの反復で **journal が 1 行も増えず、どちらの予算も減らない**（AC-18）／結果不明は枠を保持／動的を使い切っても静的が成立（AC-19）
  - **予約済み `created` の再試行は手順 1〜4 をすべてやり直す**。期限切れ・無効化・上流の変更・無効な credential なら settle 0。予約は二重に取らない
  - 上流が offer を変えたら**受信 settle 0・送信の呼び出し 0**（AC-6 の core 部分）／設定変更・無効化で `quote_changed`（AC-10）／改竄した quote 文書でも保存した記録が実行される（AC-4）
  - **MPP の昇格前（設計 §6.3）**: verify が RPC の失敗で `false` → `attempt`（最初の credential の要約）が残り、quote は潰れず、**同じ credential で期限内に再試行して成立**する。再起動を挟んでも同じ。期限後は再試行できない
  - クラッシュ点（昇格の前・後・settle の途中）ごとの再起動後の状態（AC-21）
  - 持ち主: `quoteId`・`requestId`・`paymentId` を知っていても `ownerKey` 無しでは purchase・status・`offerFor`・終端状態の読取ができない。再起動後も（AC-20）

### T11 — HTTP・client・MCP（設計 §1.1・§2.1・§5・§8）

- **範囲**: `src/http/{app,projection}.ts`、`src/client/*`、`src/mcp/{server,tools}.ts`
- **完了条件（wire）**: R2 に `upstream` が無ければ応答が現行と同じ（既存テスト）／動的 quote の応答・`subject`・`nextStep` が FR-9・FR-10 の全項目を含み記録と一致（AC-3）／
  **昇格前の動的 quote の status が `awaiting_payment` と併せて「未払いを意味しない」印を返す**（`fundsMoveOnCredential` のとき）／結果が `untrusted` の印と `proof` を伴う（AC-24）／
  新 tool `subetha_router_quote_url`／purchase が quote 文書の `ownerKey` を運ぶ／
  **既存 tool の変更は「status に省略可能な `ownerKey`」「purchase の内部で `ownerKey` を運ぶ」だけ**で、既存の引数だけの呼び出しが従来どおり動く（互換の試験）／
  `ownerKey` と要求ヘッダが journal・控え・ログ・エラー本文に出ない／`x-router-source` は MCP が必ず上書きする／HTTP の `headersTimeout`・`requestTimeout`

### T12 — 入口の資源上限（設計 §7.1、要件 FR-31・FR-35 の例外）

- **範囲**: `tools/remote-mcp.ts`（本文 64 KiB・受信 10 秒・同時接続数、例外メッセージの固定文化）。**動的 URL とは独立に出せる**
- **完了条件（wire）**: 上限超の本文は読み切らずに 413／遅い本文は 10 秒で切る／同時接続数の上限／**静的 route の正当な要求（quote・purchase・status）の大きさを実測して記録**し、上限に十分収まること／既存の MCP の試験が通る／エラー本文とログに例外の文字列が出ない

### T13 — 配線と本番の入口（設計 §1.1・§3.1）

- **範囲**: `src/main.ts`（プロファイルの登録、`target` の転送、動的用 transport、MPP 能力の起動時検査）、`tools/remote-mcp.ts`（プロファイルの設定を書く。**`enabled: false`**）
- **完了条件**:
  - `railByRoute`／`inboundByRoute` がプロファイルを引け、`target` が adapter まで届く。動的経路の transport は**すべて** `allowLoopback: false`（fixture 能力があっても）。`custom` transport の MPP 能力で動的プロファイルは起動失敗（unit）
  - **本番の入口が作る設定そのもの**を試験する: `tools/remote-mcp.ts` の設定生成を、鍵と子プロセスの起動から切り離した関数にし、**どの env を与えても `dynamic.enabled === false`** であること、その設定で動的 quote が**外部接続 0**で拒否されることを、実鍵なしで確かめる。T16 の G-4 で値を変えるのはこの関数の 1 箇所
  - 静的 route の既存テストが通る（AC-23）

### T14 — 統合試験（要件 §6 の AC のうち、複数の部品をまたぐもの）

- **範囲**: `tests/wire/`（`dialForTest` つきの Router＋T6 の fixture）。製品コードは変えない（欠陥が見つかれば該当タスクに戻る）
- **完了条件（wire）**:
  - **AC-2**: x402→MPP・MPP→x402 の quote → purchase → delivered
  - **AC-5 の全体**: 1 回の受信支払いで**送信の呼び出しが高々 1 回**。同額・異額の quote 間、静的↔動的の間、A/A・A/B の並行、journal の再オープン後。実際の検証経路（T6 の fixture）で、正の対照つき
  - **AC-6**: 設計 §3.2 の各欄を上流が変えたとき、受信 settle・送信の署名・broadcast がすべて 0。`id`／`expires` だけの変化では成立
  - **AC-12（Linux）**: quote 読取・再読取・有料要求・MPP 送信の RPC・受信の facilitator／RPC の各接続点に、loopback・内部に解決する公開名を当てて拒否
  - **AC-15 の journal の増分**: 上限内の成功応答、上限超の応答、対応外の形の応答のそれぞれで、購入 1 件が journal に足すバイト数を測り、上限（本文 256 KiB＋固定の行）内であること
  - **受信が成立した後に送信が上流に拒否された場合**: 終端が耐久的に記録され、自動の再試行が起きない（送信の呼び出しは 1 回）
  - **AC-17**: 別名 2 つが同じアドレスの枠を共有。送信元・全体・宛先の各上限で超過分が外部接続 0
  - **AC-20・AC-22**: 再起動をまたぐ持ち主の分離。動的購入を含む journal を動的無効の Router が再生し、予算が保たれ、動的 quote は実行されない
  - **AC-23**: 全テスト（macOS と Linux の両方の結果）

### T15 — 文書

- **範囲**: `docs/DEPLOY.md`（有効化の条件: B の受け入れ、port を Caddy 以外に公開しない、Router の HTTP に届くローカルのプロセスは信頼、最大損失 = `dynamic.budget`、控えの directory）、`CLAUDE.md`（動的 URL の手順: 承認時に示すもの、`ownerKey` の扱い、応答は信頼しないデータ）、`README.md`、`docs/ENGINEERING.md`
- **完了条件**: 手順どおりに fixture の Router で動的購入が通る（T14 の試験が手順と同じ呼び出しを使う）。絶対パス・鍵・RPC の URL を含まない

### T16 — gate（owner の判断。コードの変更は T13 の設定関数の値だけ）

| gate | 内容 | 前提 |
|---|---|---|
| G-1 値 | `fee`・`maxUpstreamAmount`・`maxFee`・`dynamic.budget`・設計 §7.3 の数値 | T0-b |
| G-2 testnet の実決済 | 本番と同じ構成で、まず運用者の Provider A・B を動的に指定して両方向を各 1〜2 件。**件数・額・口座をその場で示してから行う**。確かめるのは、成立、手数料が送信費用を賄うこと、`delivered` の示す範囲 | T15、G-1 |
| G-3 第三者 Provider の互換性（M-4） | 未払いの読取で成立率を測る。低ければ設計 §11 の制約（`resource` の完全一致・未知の欄の拒否）を設計に戻して見直す | T0-c、T15 |
| G-4 本番で有効にする | `enabled: true` で再デプロイ。B の受け入れの記録を確認。**x402 送信のプロファイルだけ先に有効にできる**（MPP 送信は T0-a・T0-b が揃ってから） | G-1・G-2 |

## 3. AC との対応

| AC | タスク | AC | タスク |
|---|---|---|---|
| 1 | T10・T13 | 13 | T2・T10 |
| 2 | T14 | 14 | T8・T9 |
| 3 | T11 | 15 | T8・T9・**T14（journal の増分）** |
| 4 | T10 | 16 | T8・T9 |
| 5 | T7（adapter）・**T14（全体）** | 17 | T3・T4・T10・T12・T14 |
| 6 | T8・T9（署名 0）・T10（core）・**T14（全体）** | 18 | T5・T10 |
| 7 | T10 | 19 | T5・T10 |
| 8 | T10 | 20 | T10・T11・T14 |
| 9 | T10 | 21 | T5・T10 |
| 10 | T1・T10 | 22 | T5・T14 |
| 11 | T2・T10 | 23 | 全タスク・T14 |
| 12 | T3・T13・**T14** | 24 | T11 |

設計レビュー 2 回目で追加された条件の置き場: 予約済み `created` の再試行 → T10／署名の facade（生の署名・serializer）→ T0-a・T9／
資源の会計（DNS・不可分な `admit`・purchase 全体の枠・RPC 要求数の固定）→ T3・T4・T9・T10／MPP の昇格前の証拠と回復 → T5・T10・T11。

## 4. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-05 | `gpt-6-astra`（read-only） | **REJECT**（高 4・中 5） |
| 2 | 2026-10-05 | `gpt-6-astra`（read-only・範囲限定） | **APPROVE WITH CHANGES**（9 件中 8 件解消。残り 1 点 = AC-15 の journal の増分を T14 に追加して反映済み。T0・T1 は着手可） |

| # | 指摘（第 1 版） | 反映 |
|---|---|---|
| 1 | AC-5 を adapter の試験だけでは証明できない | 全体は T14 に分離 |
| 2 | 資源会計の条件が完了条件に無い | T3・T4・T9・T10 に明記 |
| 3 | MPP の昇格前の証拠・回復が試験になっていない | T5・T10・T11 |
| 4 | 依存図どおりに完了できない（T0-c→T7、TLS fixture、`target`、計測順） | §1 を作り直し、port と fixture を T6 に前出し |
| 5 | T3 が静的の transport まで変え得る | 生成時オプション・未指定は現行のまま、を試験 |
| 6 | 「無効のまま」の検証対象が本番の入口ではない | T13 で入口の設定生成そのものを試験 |
| 7 | AC-6・14・15 の対応が完了条件より広い | 観測値を明記、AC-6 は T10・T14 にも |
| 8 | 残高の事前確認と AC-21 の容量に条件が無い | T6（型）・T10、T5 |
| 9 | T10 の条件が両立しない。T11 が大きすぎる | 既存 tool の変更を限定して明記。旧 T11 を T12〜T15 に分割 |

## 5. 本書で決めていないこと

G-1 の値、G-2 の件数と額、G-3 の結果を受けた見直しの要否。関数名やファイル内の構成は実装時に決める。
