# 要件: agent 用の payer（鍵を持つ側）と hosted MCP の整備（第 3 版、2026-10-08）

> `docs/agent-usability-study.md`（検討。独立レビュー U-1 反映済み）を、owner の決定「推奨の通り進めてください」（2026-10-08。D-U1〜D-U7 をすべて推奨のとおり採用）のもとで要件に起こしたもの。設計・タスクは別紙。
> 番号: 機能要件 `FR-A`、安全要件 `SR-A`、受け入れ条件 `AC-A`、owner の決定 `D-A`、gate `G-A`、未確認 `U-A`。
> 既存の Router（`src/**`）の購入の規則（quote の冪等性、`approval` の束縛、`fundsMoveOnCredential`、`unknown` の扱い、SR-1〜SR-7・SR-M1〜）はそのまま前提で、本書は **Router の外側（caller 側）** と **hosted MCP の見せ方** を決める。
>
> **第 2 版（独立レビュー #1、§12 = REJECT の反映）**: 第 1 版は「passphrase で暗号化した鍵 + native dialog」を承認の境界としたが、§1 の脅威モデル（agent は利用者と同じ権限の shell を持つ）では **agent が起動する process にはコードを差し込める**（Node の preload、依存の差し替え、偽の dialog）ので境界にならない、と指摘された。
> 第 3 版（readback #1、§11 R-1r）: 保証を「起動時と実行時の依存（install・Node・UI helper）が改変されていない」ことに**条件づけ**、env の検査が人間の起動を証明するという記述を削除（T4′）、合言葉を引数で渡さない（FR-A12）、回復の表に優先順位・identity の検査・`signed` と `unknown` からの扱いを明記（FR-A22）、AC-A2 の dialog の数え方・AC-A9 の challenge・AC-A10 の finality を具体化。
> 第 2 版は (1) 信頼の根を「**人間が自分の端末で起動した payer daemon**」に置き、agent が起動する MCP は daemon に話しかける**薄い shim** にする（§1.2・§4.2）、(2) 同じ利用者権限で残る危険（daemon の起動前に install されたファイルを書き換える）を**明記して受容**し、強い境界（別の OS user、OS の user presence、hardware wallet）を第 2 slice の決定 D-A3 にする、(3) 二重払いの状態機械と回復の表を定義する（§4.5・§4.6）、(4) envelope を委任として定義し直す（FR-A17）、(5) 受け入れ条件の観測点と sabotage を具体化する（§6）。

## 0. 背景

5 レールの受信・送信は公開 Router で揃った（`docs/public-brief-2026-10-08.md`）。しかし AI agent が使うには、このリポジトリを clone し、その中で Claude Code を起動し、`npm run sign` を shell で叩く必要がある（検討 §2）。鍵は平文の `.env.local`、承認は agent の自制、回復の案内は矛盾、失敗の理由は途中で落ちる（検討 §3 の F-1〜F-14）。
本書の目的は 2 つ: (1) **clone なしで**、鍵を手元に置いたまま、別のプロジェクトの Claude Code や Agent SDK から購入まで通す、(2) **「agent は代理で承認しない」を機構にする**: 鍵への排他的アクセスを、agent が操作できない承認の境界の後ろに置き、同意は不変の支払い内容に束縛し、1 回で消費する。

## 1. 脅威モデル（本書の全要件の前提。設計で緩めない）

### 1.1 agent にできること

- **agent** = LLM で、利用者の machine 上で**利用者と同じ権限の shell** を持つ（Claude Code の既定）。利用者が読めるファイルはすべて読め、任意のコマンドを実行でき、**自分が起動する process の環境変数・引数・preload・依存を好きにでき**、自分で MCP client を立てて payer に接続でき、パイプ・擬似端末（PTY）・偽の dialog を用意できる。上流（Provider）の本文や Router の応答に含まれる文を**指示として読んでしまい得る**（prompt injection）。

### 1.2 agent にできないこと（信頼の根。設計はこれを前提にし、実機で確かめる）

- **T1 人間が起動した process の内側**: 人間が**自分の端末 session**で起動した payer daemon（§4.2）の環境・引数・preload・メモリを、agent は制御できない。同じ利用者権限からの debugger / ptrace の接続は OS が止める（macOS: taskport の認可で管理者の認証が要る、Linux: Yama `ptrace_scope ≥ 1`。U-A1 で確かめ、満たさない環境は対応外と明記する）。
- **T2 GUI の操作**: agent は dialog のボタンを押せず、人間の入力を見られない（accessibility による自動操作は範囲外）。
- **T3 passphrase と security phrase**: 利用者の頭の中にあり、daemon のメモリにしかない（§4.3）。
- **T4′ 起動時と実行時の依存の無改変（条件。同じ利用者権限では保証できない）**: 本書の承認の保証は、**daemon のコード・Node の実行系・UI helper（`osascript` / `zenity` / `kdialog`）・依存パッケージが、daemon の起動時にも実行中にも改変されていない**ことを条件とする。同じ利用者権限の agent はこれらを書き換えられる（起動前の差し替え、preload は application の検査より先に走る、検査コード自体の改変、実行中の helper の差し替え）ので、**この条件は機構では強制できない**。第 1 slice（testnet の PoC）はこれを**残る危険として明示して受容**する。§5 SR-A9 の tripwire は「事故と雑な改変に気づくため」のもので、境界ではない。Claude Code の既定の permission で Bash の実行が利用者に見えることは**緩和であって強制ではない**。強い境界（agent の user が書けない場所で動く daemon、OS の user presence、hardware wallet）は D-A3（第 2 slice）。

### 1.3 守るもの・範囲外

- 守るもの: 利用者の鍵と資金。**agent の「はい」や、不確かな結果の後の再試行で、利用者が承認していない支払いが起きないこと。**
- 範囲外: T1〜T3 を破る攻撃者（root、malware、GUI 自動操作、ptrace が許される OS 設定）、T4′ の条件を破る改変（第 1 slice の残る危険。**本書の保証は T4′ に条件づけられる**）、Router 自体の侵害。
- **第 1 slice で機構として保証すること**（T1〜T3 と T4′ の下で）: **protocol の経路**（tool 引数・elicitation の応答・stdin・パイプ・PTY・env・store の読取・shim の差し替え）からは署名も送金も起きない。保証**しない**こと: daemon の起動と実行の環境が改変されていないことの証明。

## 2. 外部の事実（2026-10-08。設計で実機で再確認する）

| # | 事実 | 出所 |
|---|---|---|
| 1 | Claude Code は MCP の elicitation（form / URL）に対応する | Claude Code の文書（検討 §9） |
| 2 | MCP tool の `_meta["anthropic/requiresUserInteraction"]` を付けると、bypass permissions でも tool 呼び出しの確認が出る（対応 client の挙動が変わる） | 同上（v2.1.199 以降と記載） |
| 3 | `PreToolUse` hook の deny は bypass でも効く | 同上 |
| 4 | Agent SDK（TS / Python）は elicitation を hook で受ける（= **application が応答を合成できる**） | 同上 |
| 5 | plugin は `.mcp.json` と skill を同梱できる | 同上 |
| 6 | server の `instructions`・tool の `outputSchema` が model にどう見えるかは文書に明記が無い | 同上 |
| 7 | MCP SDK 1.32.1（本 repo）は `instructions`・`outputSchema`・`structuredContent`・elicitation を持つ | `node_modules/@modelcontextprotocol/sdk` |
| 8 | hosted MCP は `reason` を client（`src/client/index.ts`）で、HTTP status を tools（`src/mcp/tools.ts`）で落とす | 検討 F-3 |
| 9 | 既存の署名の道具は shell 引数で quote を受け、鍵を cwd 相対の `.env.local` から読む。Tempo MPP は `sign-run.ts` の `payer.payAndCredential` の**内側で送金**する（`tools/mpp-payer.ts` の `mppx.createCredential`） | `tools/sign-run.ts`、`tools/mpp-payer.ts` |
| 10 | README の `npm install` は native の rebuild（`fs-ext`）と peer-dependency の回避策を要する | README「Try it now」 |
| 11 | hosted MCP の `railHintOf` は Solana の source を x402 と決め打ちし（`src/mcp/tools.ts`）、動的の `nextStep` は `fundsMoveOnCredential` が真なら「credential を作った時点で支払い済み」と書く（Solana MPP の `npm run sign` は署名だけ） | `src/mcp/tools.ts` |
| 12 | hosted MCP の `purchase` は `outcome` を、`status` は `found` / `projection` を返す（形が違う） | `src/mcp/tools.ts` |

## 3. 範囲

### 3.1 満たすこと（本書）

- **S-A1 payer**: npm パッケージ `@subetha/payer`（D-U1。公開は owner）。1 つの実装に **CLI**（人間の設定・点検・回復・daemon の起動）と **stdio MCP shim**（agent 用。daemon に話す）の 2 つの口。鍵の暗号化保管、保護された承認、耐久的な記録。
- **S-A2 hosted MCP の改善**: `instructions`、失敗の `reason` / HTTP status / `retryAfterMs`、`outputSchema`、`requiresUserInteraction` の注釈、回復と Solana の案内の修正。
- **S-A3 第 1 slice**（D-U7）: **標準モード**（§4.2）で、**Base Sepolia USDC の x402 で払う静的 route 1 本**（`md-mpp-eth-snapshot`: Base USDC → Provider B/MPP）を、このリポジトリの外のディレクトリの Claude Code から購入まで。session（FR-A9）は第 1 slice に含む。
- **S-A4 第 2 slice 以降**（要件は書くが gate は別。§8）: 強いモード（D-A3）、envelope（FR-A17）、Tempo MPP（crash-safe な `unknown` と一緒に）、Solana MPP（2 つの期限と一緒に）、Arc・Solana の x402、動的プロファイル、wallet 道具の拡張、Claude Code plugin。

### 3.2 満たさないこと（理由）

| 対象 | 理由 |
|---|---|
| hosted の paymaster（運用者が払って後で請求） | 「鍵を手元に置く」要求に反し、本人確認・濫用対策・課金が要る（検討 E） |
| principal / API key、利用者ごとの予算、レート制限の緩和 | 別の要件（D-U5。本書は `retryAfterMs` を返すまで） |
| quote の opaque な handle（検討 A-4） | payer のローカル保持で足りる |
| `llms.txt` / OpenAPI | 署名・承認・回復を解決しない（検討 D） |
| Windows | 第 1 slice は macOS と Linux。確認 UI と ptrace の前提が OS 依存 |
| passphrase の変更、レールごとに複数の wallet | 第 1 slice では**1 store に 1 wallet（レールごとに 1 鍵）**。passphrase の変更は store の作り直し（export は無いので新しい鍵）。将来の要件 |
| 電源断の耐久性 | `SIGKILL` の行列（AC-A4）が示すのは process の終了に対する耐久性。fsync は行うが電源断は試験しない |
| mainnet | 範囲外 |

## 4. 機能要件

### 4.1 配布と起動（検討 F-1・F-8・F-14）

- FR-A1 **パッケージ**: `@subetha/payer` は Node 22 以上、macOS / Linux で動く。**native の build・rebuild・peer-dependency の回避策を要しない**（`fs-ext` に依存しない）。依存は pin し最小にする（lockfile 同梱、`npm ci` で再現）。
- FR-A2 **2 つの口、1 つの実装**: `subetha-payer <cmd>`（CLI）と `subetha-payer mcp`（stdio MCP shim）。支払いの論理は **daemon** にだけあり（§4.2）、CLI と shim は daemon の client。
- FR-A3 **設定の置き場**: 利用者所有の固定の場所（`$XDG_CONFIG_HOME/subetha-payer/` 既定 `~/.config/subetha-payer/`、`0700`）。**project の cwd から設定・鍵・環境変数を読まない**。Router の URL は既定で hosted。agent から渡す引数で鍵の path・RPC・Router の URL・store の場所を変えられない。設定は人間が CLI で変え、変更は daemon の次の起動から効く。
- FR-A4 **登録**: 人間が (1) `npm i -g @subetha/payer`（global install。`npx` の cache は改変の検知がしにくいので推奨しない）、(2) `subetha-payer wallet new`、(3) 自分の端末で `subetha-payer daemon`（§4.2）、(4) `claude mcp add subetha-payer -- subetha-payer mcp`（user scope）。README に install → 鍵 → faucet → daemon → 登録 → 最初の購入 → 回復、を 1 ページで書く。
- FR-A5 **wallet（CLI）**: `wallet new`（鍵を作り暗号化して保存。**秘密を stdout に出さない**。address だけ）、`wallet address`、`wallet balance`（第 1 slice は Base Sepolia USDC。第 2 以降で 5 レール + SOL）、faucet の URL の案内。

### 4.2 daemon と shim（第 2 版で追加。T1 の根）

- FR-A6 **daemon**: 支払いの論理（quote・承認・署名・送出・記録）は `subetha-payer daemon` の process にだけある。daemon は**人間が自分の端末 session で起動**し、起動時に passphrase を**その端末の TTY**から受け取り、鍵を復号して**メモリにだけ**置く（FR-A9 の寿命まで）。daemon は unix domain socket（設定ディレクトリの中、`0600`）で待ち受ける。
- FR-A7 **shim**: `subetha-payer mcp`（agent の client が起動する stdio MCP）は socket 経由で daemon に要求を渡すだけで、**鍵・passphrase・credential・`ownerKey` を扱わず、確認 UI を出さない**。shim が改変・差し替えされても、daemon の承認（§4.3）を迂回できないこと。shim は daemon が無ければ `daemon_unavailable` で止まる（起動しない）。
- FR-A8 **起動の自己検査（T4′ の tripwire。境界ではない）**: daemon は起動時に (a) `NODE_OPTIONS`・`--require`・`--import`・`--inspect*` が付いていれば起動を拒む（事故と雑な改変への tripwire。preload は検査より先に走り得るので、**これは人間の起動の証明にも改変の不在の証明にもならない**）、(b) 自分の install されたファイルの hash の一覧を初回起動時に passphrase 由来の鍵で封をして store に保存し、次回以降は一致しなければ起動を拒む（検査コード自体の改変は検知できない）、(c) 設定ディレクトリ・socket・UI helper の path（絶対 path、system の場所）の owner・mode・symlink を検査する。README は「これらは改変に気づく助けであって、改変を防がない」と書く。
- FR-A9 **unlock の寿命（session）**: 復号した鍵の保持は daemon の起動から **最大 1 時間**（設定で短くできる。既定 1 時間）。期限で鍵を zero fill して `locked` になり、人間が端末で再入力するまで購入は `locked` で止まる。**session 中でも購入ごとの承認（FR-A12）は省略しない。**

### 4.3 鍵と承認（D-U2・D-U4。検討 B-3）

- FR-A10 **暗号化保管**: 鍵は **passphrase から導いた鍵（scrypt、パラメータは設計で決め store に記録）で AES-256-GCM** により暗号化して保存する。passphrase は**どこにも保存しない**。復号した鍵は daemon のメモリにだけ置き、使い終えたら zero fill。credential・`ownerKey`・challenge の全文など**再利用できる秘密の記録も同じ鍵で封をする**（FR-A21）。
- FR-A11 **passphrase の入口**: daemon 起動時の TTY と、FR-A12 の確認 UI の中だけ。**MCP の tool 引数・環境変数・stdin（MCP の経路）・ファイル・コマンドライン引数からは受け取らない**（口を作らない）。shim は passphrase を求めない。**daemon は、自分が人間に起動されたか agent に起動されたかを区別できない**（TTY も env も証明にならない）。したがって残る危険 = 人間が agent の用意した process / 端末に passphrase を打つこと。緩和は README の「daemon は自分で開いた端末で、自分で打ったコマンドで起動する」の案内と、FR-A13 の合言葉（偽の確認 UI を見分ける）だけで、これは T4′ の受容の一部。
- FR-A12 **購入ごとの保護された確認**: 署名の前に、**daemon が自分で**確認 UI を出す。macOS は `osascript`（script は **stdin** で渡す）、Linux は表示文を **stdin で受け取れる** helper（例: `zenity --text-info --filename=/dev/stdin`、または設計で選ぶ同等のもの）。**引数にも、ファイル（`0600` でも同じ利用者が読める）にも、合言葉と subject を置かない**。引数でしか表示文を受け取れない helper は使わない。helper は起動時に解決した絶対 path で呼ぶ（T4′ の条件のもとで）。経路の秘匿（同じ利用者の別 process から読めないこと）は設計で検証する（U-A8）。UI は FR-A14 の内容と FR-A13 の security phrase を表示し、「承認」の操作（MPP レール、または設定の閾値を超える額では**passphrase の再入力**）を求める。UI を出せない環境では **fail closed**（`approval_unavailable`。署名も送金も起きない）。elicitation・tool 引数・hook・env・パイプ・PTY は承認にならない。
- FR-A13 **security phrase（偽 UI 対策）**: daemon 起動時に人間が TTY で**自分の短い合言葉**を入れる（メモリにだけ置く）。確認 UI はこの合言葉を表示する。合言葉が無い UI は偽物なので、README は「合言葉の無い dialog には何も入れない」と案内する。agent は合言葉を知らない（T3）。
- FR-A14 **同意は内容に束縛し 1 回で消費**: 承認は `{ Router の URL, payer の address（wallet）, requestId, quoteId, routeId / profileId + upstream URL, 両レグの network・asset・amount・decimals・recipient, fee と内訳, deadline, challengeNonce / challenge の hash }` の**不変の写し**に束縛する。daemon は **表示した subject・保存した承認の写し・実際に署名する offer の 3 つが等しい**（nonce・challenge・手数料まで）ことを署名の直前に検査し、違えば `approval_mismatch` で止まる。写しが変わる（quote の取り直し、期限切れ、確認中の期限切れ）と承認は無効。承認済みの写しは 1 回の purchase で消費し、再利用できない。agent が作った quote を「承認済み」として受け取る口は無い。
- FR-A15 **表示する内容**: 確認 UI は daemon が **Router の応答から**組んだ `subject`（額・桁・資産・network・受取先・期限・`fundsMoveOnCredential`・動的なら上流 URL と `destinationPayTo` と価格の内訳と開示）と security phrase だけを表示する。**上流の本文・URL のラベル・agent の自由文は表示しない**。制御文字は除去する。
- FR-A16 **client の elicitation と tool 注釈は補助**: shim の `purchase` tool に `_meta["anthropic/requiresUserInteraction"]` を付け、Claude Code の elicitation で**内容の表示**を行ってもよいが、承認の根拠は FR-A12 の UI だけ。
- FR-A17 **envelope 承認（第 2 slice。D-A1）= 購入ごとの UI を省く明示の委任**: 人間が daemon の端末で `envelope grant --ttl ≤1h --max-per-purchase --max-total --routes --rails` を passphrase と合言葉で実行したときだけ有効。**保護された表示**（その TTY に envelope の全条件: wallet、Router、network・asset・単位、route / profile、1 件と通算の上限、期限）を人間が確認して成立する。daemon は購入ごとに **署名の前に通算の予約を durable に取り**（FR-A20 の状態機械の `approved` に相当）、`unknown` の予約は返さない、`envelope revoke` で即時に失効、daemon の再起動で失効、同時の購入は予約で直列化、上限超過・期限切れ・route 外・rail 外は fail closed。envelope と予約は hash 連鎖の台帳（FR-A21）に記録する。

### 4.4 購入の流れ（検討 F-2・F-7、B-2）

- FR-A18 **MCP tool**（shim。名前は設計で確定。接頭辞 `subetha_payer_*`）: `find_routes`（持っている資産で絞った一覧。適合だけ。SOL の要否は属性）、`quote`（静的 route / 動的 profile + URL）、`purchase`（承認 → 署名 → 送出 → status を daemon の 1 操作で）、`status`、`wallet`（address と残高。秘密なし）。
- FR-A19 **短い参照と requestId**: `quote` は agent に**短い購入参照**（例 `p_<12 文字>`）と `subject` の要約だけを返す。quote 全体・`ownerKey`・credential・challenge は daemon が保持し、tool の応答・ログ・エラーに出さない。`requestId` は daemon が UUID で作り記録し、agent からは受け取らない。同じ参照への `purchase` の繰り返しは**同じ操作（同じ結果か進行中）を返し**、新しい承認・署名・送金を作らない。

### 4.5 二重払いの禁止: 状態機械と耐久的な記録（検討 F-13、B-4。第 2 版で具体化）

- FR-A20 **状態機械**: 購入は次の状態を**この順で**通り、各遷移は台帳（FR-A21）に 1 行を **fsync して**書いてから次へ進む。副作用（署名、送金、Router への purchase）は、その直前の「意図」の行が durable になってから起こす。

  | 状態 | 行を書くのは | 副作用 |
  |---|---|---|
  | `quoted` | Router の quote を受けた後 | なし |
  | `approved` | 確認 UI（または envelope の予約）の後。承認の写しの hash を含む | なし |
  | `sign_intent` | 署名（Tempo は = 送金）の**前** | — |
  | `signed` | credential を得た後。credential（封印）・txRef（Tempo の送金 hash、Solana の署名と blockhash の有効期限）を含む | 署名／送金が起きた |
  | `submit_intent` | Router の `purchase` を呼ぶ**前** | — |
  | `submitted` | Router の応答を得た後 | purchase が起きた |
  | `result` / `unknown` | 終端 | — |

  - Tempo MPP: `sign_intent` は `payAndCredential` / `createCredential` を**呼ぶ前**に書く（送金はその内側で起きる）。
  - Solana MPP: `approved` の後に blockhash を取り、`sign_intent` → 署名 → `submit_intent` → purchase を **1 操作で LLM の往復なし**に行う。
  - **不確かさの後に差し替えを作らない**: `sign_intent` 以降で process が終わった／応答が不確かな購入は、**新しい署名（credential・blockhash・quote）を自動では作らない**。**例外は FR-A22 の「`signed` からの同じ credential の提出 1 回」だけ**（署名ではなく提出で、同じ写しに束縛される）。再起動時は FR-A22 の表に従う。
  - lock は **store ごとに 1 つ**（`O_EXCL` + pid と起動時刻で stale を検知）。同じ store の**複製**（別の場所にコピーした台帳）は直列化できない = 残る危険として明記し、FR-A21 の head の検査で daemon の session 中の巻き戻しだけ検知する。
  - disk full・書けない: `*_intent` を書けなければ副作用を起こさない（fail closed）。途切れた行は最後の完全な行まで読む。
- FR-A21 **台帳**: append-only の ndjson（`0600`）、各行に前の行の hash（hash 連鎖）、秘密（credential・`ownerKey`・challenge の全文）は FR-A10 の鍵で封をした欄に置く。daemon は session 中に head の hash をメモリに持ち、store の head が巻き戻っていれば（別 process の書き込み・複製の差し戻し）`store_rollback` で止まる。store には version があり、未対応の version は拒む。migration は「読んで新しい store に書き、旧を残す」の形で crash-safe にする。
- FR-A22 **回復の表**: daemon は再起動時と `status` / `inspect` の要求時に、台帳の最後の状態と Router の `status`（動的は封印した `ownerKey` で）を突き合わせ、次の規則と表で扱う。**どの場合も台帳の「支払ったかもしれない」証拠を消さない。** 不確かさを解くのは**読取だけ**（Router の `status`、chain の txRef・署名の読取）。
  - **優先順位**: (1) **identity の検査**が先: Router の応答の `paymentId`・`requestId`・`quoteId`（`challengeNonce`）・`source.txRef` が台帳の写しと一致しなければ、その応答は**無いものとして**扱う（`unknown` 側）。(2) 一致した `status` の Router の状態を**終端**（`delivered`・`paid_data_unavailable`・`rejected`・Router 側の `unknown`）と**非終端**（`awaiting_payment`・進行中）に分け、終端はそのまま台帳の終端に、非終端は台帳を `unknown` にして次の読取まで待つ（`awaiting_payment` は「未払い」の意味ではない）。(3) Router が `not found` のときだけ、台帳の状態ごとの行（表）を適用する。
  - **自動で「未払い」に解決しない**: 台帳の `unknown` は、一致する Router の終端か chain の証拠が**支払いを示した**ときに `paid_*` 側へ進むだけで、「払っていない」へは自動で進まない。人間が CLI `inspect` で証拠（Router の `not found` と chain の不在）を見て手で閉じる（`closed_by_operator`。台帳に理由を残す）。

  | 台帳の最後 | Router が `not found` のとき | 備考 |
  |---|---|---|
  | `quoted` / `approved`（副作用なし） | 期限内なら同じ quote で続行（**承認は取り直す**）。期限切れは `expired` | 署名は起きていない |
  | `sign_intent`（署名／送金の結果が不明） | **`unknown`**。Tempo は chain で txRef（台帳の nonce から導ける範囲）を探し、見つかれば `paid_unsubmitted`。x402 / Solana MPP は credential が作られたか不明なので**再署名せず** `unknown` | 差し替えを作らない |
  | `signed`（credential あり、`submit_intent` 無し） | **同じ credential で** purchase を **1 回だけ**（`submit_intent` を書いてから）。期限（quote の deadline。Solana MPP は加えて blockhash の `lastValidBlockHeight` を読取で確認）内のみ。期限切れ: Tempo は `expired_after_sign`（資金は動いている）、x402 は `expired_after_sign`（署名だけ。資金は動いていない）、Solana MPP は `expired_after_sign`（Router が送出していなければ動いていないが、それは Router の `status` でしか分からない = `unknown` 寄りに表示） | 署名は作らない |
  | `submit_intent` / `submitted`（応答不明） | **`unknown`** のまま。再送しない。人間の `inspect` に委ねる | Router の `status` が取得不能・形が違う・identity 不一致も同じ |
  | `unknown`（永続） | 読取ごとに上の優先順位を再適用。証拠が出れば `paid_*` / Router の終端へ。出なければ `unknown` のまま | 自動で未払いにしない |

### 4.6 結果の扱い

- FR-A23 **結果の大きさ**: 上流の本文（最大 256 KiB）は台帳に保存し、tool の応答には要約（状態、`proof`、本文の先頭 N バイトと長さ）を返す。本文全体は `status` の明示の引数か MCP resource で取る。`untrusted: true` は保つ。

### 4.7 hosted MCP の改善（S-A2。caller 側の install なし。既存 client と互換）

- FR-A24 **`instructions`**: server の初期化で、手順、レールごとに資金が動く時点、never の 4 つ（CLAUDE.md）、回復の規則（`unknown` / `paid_data_unavailable` / `awaiting_payment` は未払いの証明ではない、再購入は**新しい quote と新しい承認**）を返す。
- FR-A25 **失敗の情報（加算だけ）**: `{ ok: false, error, reason?, httpStatus?, retryAfterMs? }` を client → tools → server の全経路で保つ。`reason` は `^[a-z_]{1,64}$` に合うものだけ通す（それ以外は落とす）。例外は `internal_error` のまま。`retryAfterMs` は **quote の再試行の目安であって purchase の再試行を許可しない**（説明に書く）。
- FR-A26 **`outputSchema`**: 各 tool に付け、`structuredContent` と一致させる。**既存の出力の形は変えない**（`purchase` は `outcome`、`status` は `found` / `projection`、失敗は `ok: false` + `error`、`internal_error` も schema に含める）。schema の説明に結果の契約（client の受領・保存した `status`・両レグの tx・finality は別物）を書く。
- FR-A27 **注釈**: `subetha_router_purchase` に `_meta["anthropic/requiresUserInteraction"]`。対応 client では**挙動が変わる**（確認が出る）ので、互換は「tool 名・引数・出力の形」について保つと定義する。
- FR-A28 **`approval` の意味**: hosted の `approval = quoteId` は**束縛の主張であって人間の同意の証明ではない**（既存の意味を保つ）。payer は自分の承認（FR-A12）を通した後にだけこの値を渡す。
- FR-A29 **案内の修正**: README の「`paid_data_unavailable` は再試行で通る」→「資金は動いている。再購入は新しい quote と新しい承認」。MCP の `purchase` の説明「再起動後は quote を取り直す」→ stateless の実態。`railHintOf` は Solana の **MPP**（`solana/charge`）を x402 と区別する。動的の `nextStep` の「credential を作った時点で支払い済み」は **Tempo だけ**（Solana MPP は署名だけで、Router が purchase で送出）に直す。CLAUDE.md と一致させる。

### 4.8 文書

- FR-A30 パッケージの README（FR-A4 の 1 ページ）と本 repo の README「Try it now」を payer 経由に置き換える（clone の手順は「開発者向け」に残す）。回復の節（`unknown` のときに見るもの、`inspect` の読み方、二重払いを避ける規則、合言葉の規則）。
- FR-A31 Agent SDK（TypeScript）の例（第 2 slice、FR-A17 の envelope）。

## 5. 安全要件

- SR-A1 **鍵の境界**: 鍵は暗号化保管（FR-A10）と daemon のメモリにしか存在せず、passphrase は人間の TTY と確認 UI からしか入らない（FR-A11）。agent が store を読んでも署名できない。shim は鍵に触れない（FR-A7）。
- SR-A2 **承認の境界**: 署名・送金は FR-A12 の UI（または FR-A17 の envelope の予約）を通った承認の写しにだけ束縛され、1 回で消費される（FR-A14）。tool 引数・elicitation の応答・hook・env・パイプ・PTY は承認にならない（FR-A16）。
- SR-A3 **多重支払いの禁止**: FR-A20 の状態機械と FR-A22 の表に従い、同じ参照は同じ操作、不確かさの後に差し替えを作らない。SDK の支払いリトライ（mppx `maxPaymentRetries: 0`）と fetch polyfill の無効は維持する。
- SR-A4 **prompt injection**: 上流の本文・Router のエラー文・URL は**データ**として扱い、権限・承認・設定の変更に使わない。確認 UI には Router 由来の `subject` と合言葉だけを出す（FR-A15）。
- SR-A5 **秘密の非露出**: tool の応答・ログ・エラー・CLI の stdout・台帳の平文の欄に、鍵・passphrase・合言葉・credential・`ownerKey`・challenge の全文を、平文でも base64 / hex でも出さない（FR-A19・FR-A21）。メモリの秘密は使用後に zero fill。
- SR-A6 **path と環境**: 設定と store は固定の場所（FR-A3）、`0700` / `0600`、symlink を辿らない（`realpath` が設定ディレクトリの中）。agent 由来の path・URL・RPC・鍵・store の指定を受けない。shell でコマンドを組み立てない。
- SR-A7 **署名の方針**: 既存の `sign-dispatch` の検査（offer と Router の表の一致、EIP-712 domain、Tempo の challenge の内容、Solana の mint・recipient・Memo・fee payer）を daemon に**そのまま移し**、加えて FR-A14 の 3 者の等価検査を行う。Router の URL は設定の 1 つだけ。
- SR-A8 **fail closed**: UI が出せない・lock が取れない・store が壊れている／巻き戻っている・passphrase が違う・承認の写しが一致しない・`*_intent` が書けない、のどれでも署名も送金も起きない。
- SR-A9 **起動の tripwire（T4 の緩和）**: FR-A8 の検査（env、install の hash、owner / mode / symlink）。検知は起動の拒否と人間への表示であって、初回の改変は防げないことを README に書く。

## 6. 受け入れ条件（AC-A1〜AC-A9 は資金が動かない。資金が動くのは §8 の gate だけ）

観測点の共通規則: 署名・送金・purchase の有無は **fake の signer と transport の呼び出し回数**（wire 試験）と台帳の行の両方で見る（台帳だけでは副作用の不在を証明できない）。確認 UI は spy に差し替え、**shim を起点とする UI の呼び出しが 0**（shim は UI を持たない）であること、daemon を起点とする UI の回数が各行の期待どおりであることを数える（agent の正規の purchase 要求は daemon の UI を 1 回出す）。

- AC-A1 **clean install**: この repo の外の空のディレクトリで、`npm i -g @subetha/payer` → `wallet new`（stdout に秘密が無い。grep と base64 / hex の検査）→ 人間の端末で `daemon` → `claude mcp add` 1 行 → Claude Code から tool 一覧が見える。native build 無し。対応 OS / Node を README に明記。
- AC-A2 **承認の sabotage（SR-A1・SR-A2）**: 観測は「fake signer の呼び出し 0・台帳に `sign_intent` 無し」を共通にし、**確認 UI の表示回数は daemon の経路と shim の経路を分けて数える**（shim は UI を持たないので shim 経路は常に 0。daemon の UI は正規の purchase の要求では 1 回出る。(k) の確認中の期限切れと人間の取消は UI 1 回・署名 0）。次のどれでも署名 0: (a) `purchase` の引数で「承認済み」を主張、(b) stdin / パイプに「yes」や passphrase を流す、(c) PTY を作って応答を流す、(d) 自前の MCP client で elicitation に応答、(e) env / 引数で passphrase を渡す（daemon は起動を拒む）、(f) 暗号化された store を読んで既存の署名の道具に渡す（復号できない）、(g) UI を出せない環境（DISPLAY 無し、`osascript` 無し）、(h) shim を差し替えて daemon に「承認済み」を送る、(i) daemon を agent の env（`NODE_OPTIONS` 等）で起動する（拒否）、(j) session の期限後に purchase（`locked`）、(k) 確認中に quote が期限切れ（承認は無効）、(l) 表示した subject と署名する offer が違う（`approval_mismatch`）。拒否・取消・UI 無し・承認の期限切れでも同じ。
- AC-A3 **同意の束縛**: 承認の後に quote を取り直す／期限が切れると、古い承認では purchase が走らない。承認済みの参照に 2 回 `purchase` を呼んでも、fake signer の呼び出しは 1。
- AC-A4 **crash と同時実行（SR-A3）**: FR-A20 の各遷移の**直前と直後**、および SDK の呼び出しの内側（fake transport が送金の応答を返す前・後）で daemon を `SIGKILL` し、再起動後に: fake signer の呼び出し ≤ 1、fake transport への purchase ≤ 1、台帳の終端が表（FR-A22）どおり、`sign_intent` 以降は差し替えの credential / blockhash / quote が作られていない。2 つの process から同じ参照に `purchase` → fake signer の呼び出し 1。stale lock（pid が死んでいる）は回収され、生きている lock は待つ。disk full（書けない fs）では `sign_intent` の前で止まり呼び出し 0。途切れた行は最後の完全な行まで読む。
- AC-A5 **再起動の継続と回復**: `quoted` / `approved` で再起動 → 期限内なら同じ quote で続行（承認は取り直し）。`sign_intent` 以降で再起動 → 自動の再署名が無い（fake signer 0）。transport の呼び出しは **FR-A22 の例外（`signed` からの同じ credential の提出 1 回）を除いて 0**: `sign_intent` / `submit_intent` / `submitted` で再起動 → transport 0、`unknown`。`signed` で Router が `not found` → 期限内なら**同じ credential**で 1 回だけ purchase（fake signer 0、transport 1）。Router の `status` が取得不能・形が違う・paymentId 不一致 → `unknown` のまま。`rejected` → 終端、Tempo は `fundsMoved` の表示。`awaiting_payment` → `unknown`。動的の結果は封印した `ownerKey` で読める（第 2 slice）。
- AC-A6 **model に見えるバイト数**: 固定の fixture（静的 route 1 件、結果の本文 2 KiB）で、`find_routes` → `quote` → `purchase` → `status` の tool 応答の `content[].text` と `structuredContent` の JSON を**両方** UTF-8 で数えた合計が、結果の本文を除いて **4 KB 以下**（現行の hosted は quote だけで 4〜6 KB）。
- AC-A7 **hosted MCP（S-A2）**: `instructions` が初期化で返る。失敗の行列（`rate_limited` → `retryAfterMs` あり、`quote_failed` → `reason` あり、`internal_error` → `reason` 無し、`reason` が形式外 → 落とす）。`outputSchema` と `structuredContent` が成功・失敗・`internal_error` のすべてで一致する。`requiresUserInteraction` が `tools/list` に出る。既存の tool 名・引数・出力の形（`outcome`、`found` / `projection`、動的の `untrusted` の包み）が変わらない（既存の `tests/wire/mcp-*.test.ts` が通る）。
- AC-A8 **署名の方針の移植（SR-A7）**: `tests/unit/sign-dispatch.test.ts`・`tests/unit/mpp-solana-challenge-check.test.ts`・`tests/unit/svm-payer.test.ts`・`tests/unit/sign-run.test.ts` の検査行を daemon の実装に対して走らせ、同じ結果（拒否する offer は拒否）。加えて FR-A14 の 3 者の等価検査の行。
- AC-A9 **秘密の非露出（SR-A5）**: 実値を既知にした wire 試験で、tool の応答・ログ・CLI の出力・台帳の平文の欄・エラー文・UI helper の**引数**を、平文・base64・hex の 3 形で grep して鍵・passphrase・合言葉・credential・`ownerKey`・**challenge の全文**が出ない。
- AC-A10 **testnet の購入（gate G-A2）**: 別のディレクトリの Claude Code から `md-mpp-eth-snapshot`（Base USDC → Provider B）が `delivered`。証拠を**別々に**: (1) client の受領（tool の応答）、(2) `status` の読み直し（daemon の再起動後も同じ）、(3) 受信レグの finality（Base Sepolia: receipt `status: 1` **かつ** その block が `finalized` tag の block 以下、または 32 block 以上の確認）、(4) 送信レグの finality（Tempo: receipt `status: 1` かつ block が `finalized` tag の block 以下。取れなければ 32 block 以上の確認）、(5) 確認 UI を通った記録（台帳の `approved` の行の写しの hash と、UI の表示の記録）。

## 7. 非機能

- NF-A1 Node 22 以上、macOS 14 以上と主要な Linux（zenity または kdialog があり、Yama `ptrace_scope ≥ 1`）。
- NF-A2 購入 1 件の所要（承認の待ちを除く）は hosted 直叩きと同程度（+1 秒以内）。
- NF-A3 依存は pin。`npm audit` の high 以上は 0 で公開。

## 8. gate（owner。資金が動くのはここだけ）

- G-A1 パッケージの公開（owner が `npm publish`。scope `@subetha`）。
- G-A2 第 1 slice の testnet の購入（AC-A10。標準モード、session あり、envelope なし）。testnet なので購入ごとの確認は不要（2026-10-08 の決定）が、**確認 UI の承認は owner 本人が行う**（それが試験の対象）。
- G-A3 第 2 slice（別の gate）: 強いモード（D-A3）、envelope + Agent SDK の script、Tempo MPP、Solana MPP、動的プロファイル。それぞれ別の受け入れ。

## 9. owner の決定

| # | 論点 | 決定 |
|---|---|---|
| D-U1〜D-U7 | 検討 §6 | 2026-10-08「推奨の通り進めてください」= すべて推奨のとおり |
| D-A1 | envelope 承認（FR-A17）を第 2 slice に入れる | **決定（推奨どおり）**: 入れる。第 1 slice には入れない |
| D-A2 | 確認 UI の既定（macOS `osascript`、Linux `zenity` / `kdialog`。無ければ fail closed） | **決定（推奨どおり）** |
| D-A3 | **強い境界**（T4 を受容しない形）を第 2 slice でどう作るか: (i) daemon を別の OS user で動かす（install・store を agent の user が書けない。UI は別 user からは出せないので承認は TTY か socket 経由の署名つき確認になる）、(ii) OS の keychain / Secure Enclave の **per-operation の user presence**（macOS の LocalAuthentication。secp256k1 は Enclave 外なので native helper が要る）、(iii) hardware wallet | **推奨: 設計で (i) と (ii) を比較し、第 2 slice で 1 つ**。owner の判断（本書は推奨のまま進め、設計で比較結果を示す） |

## 10. 未確認（設計で確かめる）

- U-A1 同じ利用者権限からの debugger / ptrace の接続が OS で止まるか（macOS の taskport、Linux の Yama）。止まらない環境の扱い。
- U-A2 人間が起動した daemon から `osascript` の dialog が利用者の GUI session に出るか（SSH / tmux / GUI 無しの場合）。
- U-A3 `requiresUserInteraction` と elicitation の実機の挙動（事実 1・2）、`instructions` が model にどう見えるか（事実 6）。
- U-A4 lock の実装（`O_EXCL` + pid + 起動時刻）と stale の判定、socket の権限。
- U-A5 既存の `tools/sign-*.ts`・`svm-*.ts`・`mpp-payer.ts`・`x402-payer.ts` をパッケージに移す境界（本 repo の `src/client` を依存にするか、HTTP API を直接叩くか）。
- U-A6 scrypt のパラメータと復号の所要、install の hash の封印の形。
- U-A7 Claude Code が複数 session で同じ shim を起動したときの daemon 側の挙動（socket の多重接続と購入の直列化）。
- U-A8 確認 UI の helper への表示文の経路（stdin）が、同じ利用者の別 process から読めないこと（macOS / Linux で確認。読める helper は使わない）。

## 11. 独立レビューの記録

| # | 日付 | reviewer | 要旨 |
|---|---|---|---|
| R-2r | 2026-10-08 | `gpt-6-astra`（readback。第 3 版） | **REJECT**（残り 3 点: `0600` の一時ファイルは同じ利用者が読めるので合言葉の経路にならない、AC-A5 の「`sign_intent` 以降は transport 0」が `signed` の例外と矛盾、§6 の共通規則の「agent の経路の UI = 0」は shim 起点に限定する）。**同版で反映**: FR-A12（stdin だけ。U-A8）、AC-A5、§6 の共通規則 |
| R-1r | 2026-10-08 | `gpt-6-astra`（readback。第 2 版） | **REJECT**（3・6・7 は解消。残り: (1)(2) env の検査は人間の起動を証明せず、preload は検査より先に走り、検査コードも改変され得る。合言葉を helper の引数で渡すと process の引数から読める。実行中の helper・依存も保護の対象。T4 は候補として誠実だが緩和を言い過ぎ（Bash が見えることは強制ではない）。(4)(5) `sign_intent` 以降は再送しない、と `signed` の継続が矛盾。永続 `unknown`・`signed` の各結果・Solana の継続・`found` の非終端（`awaiting_payment`）の優先順位と identity の検査が無い。(8) AC-A2 は取消・期限切れでも dialog 0 を求めていて矛盾（shim と daemon の UI を分ける）、AC-A9 に challenge、AC-A10 は receipt であって finality でない）。**第 3 版で反映**: T4′（保証を起動時・実行時の依存の無改変に条件づけ、強制できないと明記）、FR-A8・A11（証明ではない）、FR-A12（合言葉・subject は stdin / 0600 ファイル）、FR-A20 の例外、FR-A22（優先順位・identity・`signed`・`unknown`・自動で未払いにしない）、AC-A2・A9・A10 |
| R-1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版） | **REJECT**。(1) 暗号化 + dialog は、agent が起動する process にコードを差し込める脅威モデルでは承認の境界にならない（preload・依存の差し替え・偽 dialog・unlock 後の鍵の保持）。「起動と入力の信頼できる境界」か、明示的に狭い脅威モデルが要る。(2) native dialog は自動では境界にならない（script が入力を受け取る。偽物を出せる）。TTY も「人間が実行した」証明にならない。FR-A8 と FR-A10 の矛盾。(3) envelope は委任。保護された表示、署名前の durable な予約、`unknown` の予約の保持、失効、同時実行、再起動、巻き戻し対策が要る。(4) 二重払いの順序が試験できる形でない（Tempo は `payAndCredential` の前に intent、credential と送信の intent を Router 送信の前に、fsync・途切れ・disk full・lock の寿命、不確かさの後に差し替えを作らない、SDK の内側の窓で SIGKILL、fake transport で回数を数える、複製の store）。(5) 回復の状態表が無い（`unknown` / timeout / 不一致 / `rejected` / `awaiting_payment` / 取得不能）。AC-A5 の「続行」が FR-A19 と矛盾。(6) FR-A17/A19 と AC-A9 の矛盾（秘密の記録は封印）、3 者の等価検査、store の version と migration、passphrase の変更と複数 wallet の扱い、gate の分離、D-A1/A2 の位置づけ。(7) hosted は別に出せるが、出力の形（`outcome` / `found`・`projection`）を保ち、schema は失敗も含め、`reason` を検査し、`retryAfterMs` は purchase の再試行を許可しない、`approval` は束縛の主張、`requiresUserInteraction` は対応 client の挙動を変える、Solana の案内（`railHintOf`・`nextStep`）の修正。(8) AC の観測点と sabotage の追加。**第 2 版で反映**: §1（T1〜T4 と受容する危険）、§4.2（daemon + shim、tripwire）、FR-A9〜A17、FR-A20〜A22（状態機械・台帳・回復の表）、FR-A25〜A29、§6 の観測点と sabotage (h)〜(l)、D-A3、§3.2 の除外 |
