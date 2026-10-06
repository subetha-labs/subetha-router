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
  - **実装で決めた細部**は設計 §3.4 の「T8 で決めたこと」に記録した（402 の本文は読まない・receipt の `transaction` の形・receipt があるときの 200 以外の扱い など）

### T9 — MPP 送信の動的経路（設計 §3.3）

- **範囲**: `src/adapters/outbound/mpp.ts`
- **完了条件（wire）**:
  - challenge の許可リスト（T0-c）と `splits`・`machineTokenEnabled`・額 0・`pull` のみの拒否。**`methodDetails.feePayer`（真偽値）は許すが使わない**: `feePayer: true` の challenge でも push で払い、transaction に `feePayer`・`feePayerSignature` が現れたら署名しない（設計 §3.3 の「Tempo 側の Provider」）
  - 能力が `push` 明示・`account.type === "local"`・素の `http` transport でなければ**起動失敗**
  - **署名の facade（AC-16）**: `sign({hash})`・`signMessage`・`signTypedData`・`signAuthorization`・渡された serializer・call 2 つ・別の `to`・額違い・`feeToken` 未指定／別資産・手数料上限超過・`keyAuthorization` で**元の account の呼び出しが 0**。元の account が `tempo.charge` の `account` からも SDK に返す client からも到達できない。nonce と有効期限の欄は範囲を確かめて引き継ぐ
  - 送信の境界が同じ欄をもう一度見る／送金系は 2 メソッドだけ／読取はそのまま通る／1 支払い 1 回
  - **1 件の支払いで出る RPC の要求数が T0-a の実測と一致することを試験に固定**（増えたら落ちる）
  - 一致の定義・応答の上限と形は T8 と同じ観測（AC-6・AC-14・AC-15）／scope は「あれば照合・無ければ不問」、静的は従来どおり必須
  - **実装で決めた細部**は設計 §3.4 の「T9 で決めたこと」に記録した（SDK に HTTP をさせない・未知のトップレベルのパラメータの扱い・RPC の期限は T13 の条件 など）

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
  - **実装で決めた細部**: core の動的の流れは `src/core/dynamic.ts`（`createDynamicCore`）。入口は既存の `quote`／`purchase`／`status`／`offerFor` に
    省略可能な引数（`upstream`・`source`・`ownerKey`）を足した形で、`upstream` が無ければ静的の処理のまま。持ち主の証明が合わない要求と別 principal の要求は
    どちらも `unknown_quote`。門の拒否は `rate_limited`（理由は `terminalReason`／`reason`）、控えの上限は `dynamic_capacity`、控え・動的予算が使えない状態は
    `dynamic_unavailable`。受信 offer の束縛は `dynamic|<profileId>|GET|<url>`。残高の事前確認は `RouterCoreOptions.dynamic.balanceOf`（T13 で能力から配線）
    レビューで直した点: 1 件あたりの上限（`maxPerPurchase`）は quote の時点で見る（受信 offer を発行してから昇格で拒否しない）／受信の桁で正確に表せない額は拒否／
    **昇格後の settle の拒否は `unknown`**（§6.5。未払いと確定しない）／宛先ホストの枠は settle の前に取り、送信の終わりまで持つ（settle 後の読み直し・送信も枠の中）

### T11 — HTTP・client・MCP（設計 §1.1・§2.1・§5・§8）

- **範囲**: `src/http/{app,projection}.ts`、`src/client/*`、`src/mcp/{server,tools}.ts`
- **完了条件（wire）**: R2 に `upstream` が無ければ応答が現行と同じ（既存テスト）／動的 quote の応答・`subject`・`nextStep` が FR-9・FR-10 の全項目を含み記録と一致（AC-3）／
  **昇格前の動的 quote の status が `awaiting_payment` と併せて「未払いを意味しない」印を返す**（`fundsMoveOnCredential` のとき）／結果が `untrusted` の印と `proof` を伴う（AC-24）／
  新 tool `subetha_router_quote_url`／purchase が quote 文書の `ownerKey` を運ぶ／
  **既存 tool の変更は「status に省略可能な `ownerKey`」「purchase の内部で `ownerKey` を運ぶ」だけ**で、既存の引数だけの呼び出しが従来どおり動く（互換の試験）／
  `ownerKey` と要求ヘッダが journal・控え・ログ・エラー本文に出ない／`x-router-source` は MCP が必ず上書きする／HTTP の `headersTimeout`・`requestTimeout`
  - **実装で決めた細部**: HTTP は R2 の本文 `upstream.url`、R3・R4 のヘッダ `x-router-owner-key`・`x-router-source`。動的プロファイルの購入口（`/v1/routes/<profileId>/resource`）は
    機能が有効なときだけ存在する。動的 quote の失敗は `dynamic_disabled`／`unknown_route` 404・`invalid_upstream_url` 400・`request_id_conflict` 409・`rate_limited`／`dynamic_capacity` 429・
    `dynamic_unavailable` 503・それ以外 502。client は `quoteUrl` を足し、応答に `upstream`・`ownerKey` が無い・頼んだ URL と違う quote は受け入れない。
    MCP の送信元は入口が `X-Forwarded-For` の最後の値（無ければ接続元）から導いて client に渡し、client が `x-router-source` を付ける（外から来た同名のヘッダは読まない）。
    動的購入の結果は `result: { untrusted, source, contentType, body }` と `proof` で返し、静的の結果の形は変えない
    レビューで直した点: status の再読取でも動的の結果は untrusted で包む／client の**動的**購入（R3）の期限は 120 秒（Router 側の最悪 96 秒に余裕。既定の 10 秒では Router が支払いを続けているのに `unknown` になる。静的の購入は従来どおり `timeoutMs`）／
    R1 に `dynamic`（`enabled` とプロファイルの一覧: レール・資産・桁・上限・手数料・開示。`payTo`・`tokenDomain` は出さない）を足し、client・MCP が落とさず返す

### T12 — 入口の資源上限（設計 §7.1、要件 FR-31・FR-35 の例外）

- **範囲**: `tools/remote-mcp.ts`（本文 64 KiB・受信 10 秒・同時接続数、例外メッセージの固定文化）。**動的 URL とは独立に出せる**
- **完了条件（wire）**: 上限超の本文は読み切らずに 413／遅い本文は 10 秒で切る／同時接続数の上限／**静的 route の正当な要求（quote・purchase・status）の大きさを実測して記録**し、上限に十分収まること／既存の MCP の試験が通る／エラー本文とログに例外の文字列が出ない

### T13 — 配線と本番の入口（設計 §1.1・§3.1）

- **範囲**: `src/main.ts`（プロファイルの登録、`target` の転送、動的用 transport、MPP 能力の起動時検査）、`tools/remote-mcp.ts`（プロファイルの設定を書く。**`enabled: false`**）
- **完了条件**:
  - `railByRoute`／`inboundByRoute` がプロファイルを引け、`target` が adapter まで届く。動的経路の transport は**すべて** `allowLoopback: false`（fixture 能力があっても）。`custom` transport の MPP 能力で動的プロファイルは起動失敗（unit）
  - **本番の入口が作る設定そのもの**を試験する: `tools/remote-mcp.ts` の設定生成を、鍵と子プロセスの起動から切り離した関数にし、**どの env を与えても `dynamic.enabled === false`** であること、その設定で動的 quote が**外部接続 0**で拒否されることを、実鍵なしで確かめる。T16 の G-4 で値を変えるのはこの関数の 1 箇所
  - 静的 route の既存テストが通る（AC-23）
  - **実装で決めた細部**: 動的用 transport は `composeRails` が本番の選択肢（loopback 不可・DNS 期限 3 秒／同時 16・ヘッダ 32 KiB・門の `admit`）で組む。
    試験は `RouterCapabilities.dynamicTransportForTest`（同じ選択肢を受け取り、宛先の差し替えを足して返す）で差し替え、返った transport が loopback を許す・DNS に期限が無いなら起動失敗。
    拒否ホストには設定の値に加えて facilitator・自分の canonical のホストを足す（T13 では静的 route の上流も足していたが、owner の決定 2026-10-06 で外した。設計 §7.4）。プロファイルの受信 adapter は動的用 transport で作り、x402 受信は署名を quote に束縛する。
    受信 offer の束縛 `dynamic|<profileId>|GET|<url>` からプロファイルを引く。残高の検査は全プロファイルの能力が `balanceOf` を持つときだけ core に渡す（今の本番の能力は持たない）。
    合成レールに動的の設定は組めない（起動失敗）。本番の入口の設定生成は `tools/remote-mcp-config.ts` の `routerConfigOf`（SDK に依存しない純粋関数。`enabled: false` 固定、
    プロファイル 2 つ、手数料・上限は G-1 の案の値）
    レビューで直した点: 拒否ホストに受信 MPP の RPC（設定 `ROUTER_MPP_INBOUND_RPC_URL`、無ければ chain の既知の公開 RPC）と能力の依存先
    （`RouterCapabilities.dependencyUrls`。起動時の確認で MPP 能力の RPC ホストがここに無ければ起動しない）を足す／本番の入口は公開ホスト名
    `router.subethalabs.com` と `SUBETHA_DENY_HOSTS` を拒否ホストに入れる（canonical は内部の URL）／試験の差し替えは `dynamicTransportHooksForTest`
    （名前解決・接続先・CA・インタフェースだけ。方針の欄は配線が上から重ねる）

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
  - **実施の記録（2026-10-06）**: `tests/wire/dynamic-integration.test.ts`（46 件）。製品の配線（`composeRails`）をプロセス内で起動し、実鍵（乱数）・実 SDK・
    SSRF 防御 A の transport に名前解決と接続先の差し替えだけを足して、T6 の fixture（TLS の上流 2 つ・署名を検証する facilitator・実形の receipt を返す RPC）を相手にした。
    呼び出し側は製品の client と `tools/x402-payer.ts`・`tools/mpp-payer.ts`。macOS と Linux（`node:22-bookworm`。全体 1060 件通過）の両方で実行。
    AC-12 は名前解決の fixture に内部アドレス（127.0.0.1・10/8・169.254/16・::1・172.16/12）を返させ、quote の読取・再読取・MPP 送信の RPC・受信の facilitator・受信の RPC の
    各接続点で接続 0（`destination_blocked`）を確かめた。AC-15 の増分は上限（256 KiB＋固定 16 KiB）内。
    **見つけた欠陥（tool）**: `tools/mpp-payer.ts` は SDK の既定（`polyfill: true`）で**プロセスの `globalThis.fetch` を「402 を受けたら自動で払う fetch」に置き換えていた**。
    同じプロセスの Router の client が 402 を受けるたびに支払いを試みて失敗していた。`polyfill: false`・`maxPaymentRetries: 0` に直した（`tools/dyn-testnet-mpp-trial.ts` も）。
    レビューで直した点: AC-5 は A の署名／送金を B の封筒に**入れ替えて**（同額・異額・静的 route・nonce の欄まで書き換え、並行、再起動後）確かめ、
    送信の署名は運用者の鍵の署名回数（x402・MPP）で数える／AC-12 は有料要求の時点での拒否も含め、接続点ごとの `destination_blocked` と接続回数を見る／
    AC-6 は §3.2 の全欄（scheme・network・asset・extra.version、MPP の `request`・`meta` の全文）／AC-17 は purchase の上限も／AC-20 は別の持ち主の証明での purchase・status も／
    静的 route も同じ fixture の網に閉じ込め（`RouterCapabilities.transportHooksForTest`）、動的が無効でも静的の購入が成立することを確かめた／
    x402 送信の署名は、上流が受け取った typed data の署名を運用者の鍵で検証した／TLS の鍵と証明書は `runtime/` の下に作り、試験の終わりに消す
  - **AC-23**: 全テスト（macOS と Linux の両方の結果）

### T15 — 文書

- **範囲**: `docs/DEPLOY.md`（有効化の条件: B の受け入れ、port を Caddy 以外に公開しない、Router の HTTP に届くローカルのプロセスは信頼、最大損失 = `dynamic.budget`、控えの directory）、`CLAUDE.md`（動的 URL の手順: 承認時に示すもの、`ownerKey` の扱い、応答は信頼しないデータ）、`README.md`、`docs/ENGINEERING.md`
- **完了条件**: 手順どおりに fixture の Router で動的購入が通る（T14 の試験が手順と同じ呼び出しを使う）。絶対パス・鍵・RPC の URL を含まない
- **実施の記録（2026-10-06）**: `docs/DEPLOY.md` §2b（有効化の条件 6 つ・手順・戻し方・見るもの・env 4 本）、`docs/ENGINEERING.md`（HTTP の追加の表・エラーコード・
  設定の `dynamic` 節・MCP の tool・動的の購入ライフサイクル）、`CLAUDE.md`（エージェント向けの手順: 承認時に示すもの、`ownerKey` の扱い、結果は信頼しないデータ）、
  `README.md`（機能の節と「未検証」の項目）。**見つけた欠陥（tool）**: `tools/remote-mcp.ts` は `SUBETHA_TEMPO_RPC_URL` を Router の子プロセスに渡していなかった
  （子の env は allowlist 方式）。設定していても MPP 送信は公開 RPC を使っていた。送信・受信の両方に渡すよう直した（次のデプロイで有効になる）。手順の呼び出し（`quote_url` → `purchase` に quote 文書 → `status` に `ownerKey`）は T11 の MCP handlers の試験と
  T14 の統合試験（client の `quoteUrl` → `execute` → `status`）が同じ順で使う。絶対パス・鍵・RPC の URL は含めていない（grep で確認）

### T16 — gate（owner の判断。コードの変更は T13 の設定関数の値だけ）

| gate | 内容 | 前提 |
|---|---|---|
| G-1 値 | `fee`・`maxUpstreamAmount`・`maxFee`・`dynamic.budget`・設計 §7.3 の数値 | T0-b |
| G-2 testnet の実決済 | 本番と同じ構成で、まず運用者の Provider A・B を動的に指定して両方向を各 1〜2 件。**件数・額・口座をその場で示してから行う**。確かめるのは、成立、手数料が送信費用を賄うこと、`delivered` の示す範囲 | T15、G-1 |
| G-3 第三者 Provider の互換性（M-4） | 未払いの読取で成立率を測る。低ければ設計 §11 の制約（`resource` の完全一致・未知の欄の拒否）を設計に戻して見直す | T0-c、T15 |
| G-4 本番で有効にする | `enabled: true` で再デプロイ。B の受け入れの記録を確認。**x402 送信のプロファイルだけ先に有効にできる**（MPP 送信は T0-a・T0-b が揃ってから） | G-1・G-2 |

**実施の記録（2026-10-06、G-2・G-3。G-1・G-4 は owner の判断待ち）**

- **G-2（testnet の実決済）**: 本番の入口の設定生成（`routerConfigOf`。同じプロファイル・同じ手数料と上限の案）を**ローカルで** `enabled: true` にし、
  実鍵（使い捨て口座。呼び出し側 `0xfCea…0bF1`、Router の送信 `0xEd5F…06C4`、受取先 `0xF88b…6405`）で、運用者の Provider A・B を動的に指定して両方向を各 1 件。
  **本番の設定との違い（当時）**: T13 の配線は静的 route の上流（A・B のホスト）を動的の拒否ホストに入れていたので、この試行では静的 route の上流を
  到達しないプレースホルダのホストに置き換えた（それ以外は同じ）。**その後、owner の決定（2026-10-06）で静的 route の上流は拒否しないことにした**ので、
  今の本番の設定では A・B を動的に指定できる（設計 §7.4）

  | 方向 | 受信（呼び出し側 → Router） | 送信（Router → 上流） | 結果 | 所要 |
  |---|---|---|---|---|
  | x402 → MPP（`dyn-x402-to-mpp`、上流 B） | Base Sepolia USDC 11,000（上流 10,000＋手数料 1,000）。tx `0x40c42b34…c4f`（block 47739312） | Tempo pathUSD 10,000。tx `0x4b117218…1a2`（手数料 **29** base units、`feeToken` pathUSD） | **delivered**（JSON object） | 7.4 秒 |
  | MPP → x402（`dyn-mpp-to-x402`、上流 A） | Tempo pathUSD 11,000。tx `0xff82c44f…d8b`（呼び出し側の手数料 31） | Base Sepolia USDC 10,000。tx `0x64f7acde…a88`（block 47739319） | **delivered**（JSON object） | 3.6 秒 |

  確かめたこと: 両方向が成立し、受信・送信の 4 件すべてがチェーン上で `success`（公開 RPC で読取）。MPP 送信の手数料の実額 29 は署名前の上限（`maxFee` 5000）以下で、
  手数料規則の案（`flat 1000`）が送信費用を賄った（この 1 件について）。`delivered` の示す範囲: 上流の本文（JSON object）が届いたこと。receipt は上流の申告で、
  最終性は確かめていない。journal・控えに鍵・`ownerKey` は無い（grep）
- **G-3（第三者 Provider の互換性、M-4）**: 同じローカルの Router で、T0-c の testnet 探索で見つけた Base Sepolia の 21 ホストに**未払いの読取だけ**（`quote_url`、支払い無し）。
  **11 件で quote が成立**（上流額 1,000〜10,000）。成立しなかった 10 件は `quote_failed`（402 を返さない・`resource.url` の不一致・別の network・`maxTimeoutSeconds` 範囲外・Permit2 など、
  T0-c の probe と同じ理由）。成立した 11 件は probe が「選べる」と判定した 11 件と**完全に一致**した（probe の判定が製品の判定と同じであることの確認）。
  §11 の制約（`resource` の完全一致・未知の欄の拒否）を緩める必要は、この標本では見つからなかった
- **G-1（2026-10-06、owner の決定）**: `maxUpstreamAmount` 10,000、`maxFee` 5,000、動的予算（件数 1,000・額 100,000,000・1 件 20,000）は案のまま。
  手数料は**プロファイルごと**に分け、x402 送信（`dyn-mpp-to-x402`。Router にチェーン手数料がかからない）は定額 1,000、
  MPP 送信（`dyn-x402-to-mpp`。Router が Tempo の手数料を払う。実測 29〜478）は、owner の「運営がガス代を負担するリスクは構造として排除する」という方針で
  **定額 5,000 = `maxFee`** とし、被覆の条件 `fee.min >= maxFee`（`feeAsset` は送信資産そのもの・受信と送信の桁が同じ、を前提に）を `src/config.ts` に入れた
  （起動時に確かめる。設計 §6.6）。これは「チェーンが請求する額が署名時の上限以下」という Tempo 側の前提の下での保証で、その前提が仕様で確立するまで
  MPP 送信のプロファイルは本番で有効にしない（従来どおり）。
  次のスライス（MPP 送信を本番で有効にする前提）として「quote の時点でその送金のガス代（ガス量×単価）を RPC で見積もり、`maxFee` と手数料を決める
  （平時は安く、高騰時は断る）」を設計 §11 に記録した（owner の確認 2026-10-06）
- **G-4（2026-10-06、owner の決定）**: `docs/DEPLOY.md` §2b の条件 7 つを満たして、**x402 送信のプロファイル（`dyn-mpp-to-x402`）だけ本番で有効**にした。
  MPP 送信（`dyn-x402-to-mpp`）は Tempo の手数料の仕様で上限が確立するまで登録しない。受け入れの記録（B・G-2 の日付と場所）は `tools/remote-mcp-config.ts` のコメント。
  有効化の前に本番を `b-56265da`（動的は無効）に更新して静的 route と MCP の一覧を確認し、有効化のイメージ `b-960ddc3`（2026-10-06 01:57Z）で入れ替えた後、公開 MCP から:
  一覧に `enabled: true`・プロファイル 1 つ／Provider A への動的 quote が成立（上流 10,000＋手数料 1,000）／未登録のプロファイルは `unknown_route`、自分のホストは `invalid_upstream_url`／
  **本番で動的購入 1 件が delivered**（testnet。受信 pathUSD 11,000: tx `0x5cf20960…8096`、送信 USDC 10,000: tx `0x0a5492b9…5f3a`、3.5 秒）。`ownerKey` 無しの status は読めない

### T17 — MPP 送信の手数料を quote 時のガス代で決める（`docs/dynamic-gas-fee-design.md`。owner の依頼 2026-10-06）

**内容**: quote の時点でその送金のガス代（bound = `ceil(gas × maxFeePerGas / 10^12)`）を署名も送金もせずに見積もり、cap = `ceil(bound × feeMargin / 10000)`、
手数料 = `max(規則の手数料, cap)`。cap が天井 `destination.maxFee` を超える quote は出さない。cap と見積りの証跡を記録に固定し、予約・残高・1 件の上限・署名の境界は cap を使う。
purchase では受信 verify の前に再見積りし、bound が cap を超えていれば `fee_too_high`（`awaiting_payment`）。復元・昇格済みの再開・adapter の境界が cap を独立に確かめる。
送金の RPC が接続の前に断られた場合は署名後でも `not_sent`。設定の検査 `fee.min >= maxFee` は外し、`feeMargin`（10,000〜1,000,000 bps、既定 20,000）と
`pricingPolicy` を MPP 送信の権威の欄に足す（x402 送信の直列化は不変）。起動時の `verify` は RPC の `eth_fillTransaction` 対応を読取で確かめる。

**変更**: `src/config.ts`・`src/ports/outbound.ts`・`src/net/guarded-rpc.ts`（`timeout` を関数でも）・`src/adapters/outbound/mpp-dynamic.ts`（`estimateFee`・cap・接続前の拒否）・
`mpp.ts`・`src/main.ts`・`src/core/{dynamic,store,intent,orchestrator}.ts`・`src/http/projection.ts`・`src/mcp/tools.ts`・`src/client/{index,types}.ts`（`quoteTimeoutMs` 30 秒）・
`tools/remote-mcp-config.ts`（MPP 送信: `feeMargin 20000`・天井 50,000・定額 1,000。登録は引き続き無効）・`tools/dyn-mpp-estimate-probe.ts`（読取だけの memo の probe）。

**試験**: unit（config 53・core 55・wiring 15）、wire（adapter 192: 見積りの 3 経路（対応・非対応・`eth_gasPrice`）と値・quote をまたいで憶えない・残り予算の期限・送金系メソッドの拒否と署名口の無い facade・`maxFee` 無し／天井超え・
cap が bound 未満なら署名しない・接続前の拒否は `not_sent`、接続後は `unknown`）、統合（51: 単価で cap と手数料が動く、天井超えで断る、purchase の再見積りで `fee_too_high`、
署名前の検査が cap を使う、quote 飽和後の purchase、起動の probe）、HTTP／MCP（25: `quoteTimeoutMs`、nextStep の cap・時刻・期限、開示、一覧の `feePolicy`）。
Linux（Colima の `node:22-bookworm`）で全体 1,098 件通過、macOS では T-A5/A6/A8 の 3 件が既知の環境差で失敗。**sabotage**: 30 の変異（cap を無視・予約が天井・天井の検査なし・再見積りなし・再開の検査なし
（復元と両方）・`capCoversFee` の各条件・`offerFor`・`SAFE_REASONS`・見積りの guard が送金系を通す・adapter が天井を使う・天井超えを丸める・接続前の拒否を `unknown`／
すべて `not_sent`・予算切れの印・`viaFillTransaction`・期限が残りでない・署名口のある facade・`feeMargin` の下限・権威の欄・`pricingPolicy` の無条件・起動の検査・
transport の `timeout` 関数・開示・client の期限、実装レビュー後に足した 5 つ: 受信 offer の額との結び付き・`total` の整合・昇格済みの予約必須・見積りの期限の余裕・client の優先順位）
がすべて試験で落ちた（2 つは最初すり抜け、試験を締めて再確認）。core の再開の検査は復元と同じ関数を使う多重の防御で、単独の変異は復元に隠れる（両方を外す変異で落ちる。設計 §3.3）。

**実測（読取だけ、Tempo testnet、2026-10-06）**: prepared gas は memo の非ゼロのバイト数と宛先の残高の有無で変わる（48,558〜54,182。設計 §1.1）。
「memo に依らない」は誤りだったので設計を直した。全バイト非ゼロのダミーは 32 バイトの memo の中で最大。

**本番への配備（2026-10-06 03:54Z、owner の承認「デプロイ進めましょうか」）**: イメージ `b-ff3c496`（`main` の T17 マージ後）に入れ替え。手順は従来どおり
（アーカイブ転送 → ホスト上でビルド → Caddy 停止 → 旧コンテナを `subetha-router-prev-20261006T035438Z`（`b-960ddc3`）にリネーム → 起動 → healthy →
journal 87,192 バイトが不変の prefix → `subetha-egress check` rc 0 → Caddy 再開）。構成は不変: 動的は `dyn-mpp-to-x402` だけ有効、MPP 送信のプロファイルは未登録。
確認（公開 MCP）: 一覧 `enabled: true`・プロファイル 1 つ／Provider A への未払いの動的 quote 成立（上流 10,000＋手数料 1,000）／`dyn-x402-to-mpp` は `unknown_route`。
巻き戻し用に `-prev-` は直近 1 つだけ残した（`b-56265da` のものは削除）。

**Tempo の手数料の仕様の確認（2026-10-06、owner の依頼。`DEPLOY.md` §2b 条件 6 の前提 1）**: 公開仕様・TIP-0001・ノードのソース tag `v1.16.0`（testnet のノードと同じ版）を読み、
請求額 = `ceil(max(gas_used − reservoir, 0) × effective_gas_price / 10^12)` ≤ `ceil(gas × maxFeePerGas / 10^12)`、Fee AMM の 0.3% は validator 側、前払いの段の不足は invalid（手数料なし）、
実行後の失敗はブロックに載らない、を確かめた（`docs/dynamic-gas-fee-design.md` §7）。配備されたノード `v1.16.0-023f1d0` の tree は tag の commit `74b6915` と全 blob が一致（直接比較）。レビュー 2 回（REJECT → APPROVE WITH CHANGES、反映済み。設計 §6 の 8・9 行目）。
読取だけ。条件 6 の残り: quote 時と purchase 時の bound の観測記録（testnet の RPC）、版名・hardfork の変化時の読み直し。

**レビュー**: 設計 3 回・実装 1 回目は REJECT（高 1: 復元の検査が払う額と結び付いていない。`docs/dynamic-gas-fee-design.md` §6 の 4 行目）→ 修正。2 回目も REJECT
（`converted` と写しの `source.amount` の 2 つの抜け道。§6 の 5 行目）→ 修正（sabotage 2 つ追加: `converted` の束縛・写しへの束縛は復元と再開の両方を外す変異で落ちる）。3 回目（範囲限定）も REJECT（予約の区分を記録の写しで引いていた。§6 の 6 行目）
→ 再開は設定のプロファイルの宛先で引くように修正（sabotage 1 つ追加）。4 回目（範囲限定）**APPROVE**（§6 の 7 行目）。

### T18 — Router が MPP 送信の手数料の単価を決める（`docs/dynamic-gas-fee-design.md` §8。owner の決定 2026-10-06「a で進めましょう」）

**内容**: 観測（§8.1: baseFee は 72 時間で最大 1.24 倍、動くのはノードが提案する priority fee）を受け、Router はノードの提案を写さず、priority 1 wei 固定・
`maxFeePerGas = ceil(2.4 × baseFee) + 1`（最新ブロックの baseFee）で見積り・署名する。署名時は `min(feePerGasOf(baseFee), capPerGas)` に clamp し、`baseFee` を下回れば署名しない。
送信の境界は priority = 1 を照合。`pricingPolicy` は `gas-indexed-v2`、`limits.perAddressPerMinute` の既定は 100。見積りの RPC は block ＋ fill の 2 回（非対応ノード 3 回）、
支払いは block ＋ fill ＋ 送金の 3 回（非対応 6 回）。`viaFillTransaction` は fill の成功で立てる。

**変更**: `src/adapters/outbound/mpp-dynamic.ts`・`src/config.ts`・`tests/fixtures/dynamic/tempo-rpc.ts`（ノードの提案 `quote.priority`）・`tools/dyn-mpp-bound-observe.ts`（観測。`observe`／`history`／`report`）・
docs（設計 §8、`dynamic-upstream-design.md` §7.3）。

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
