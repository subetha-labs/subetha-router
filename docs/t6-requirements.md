# T6 要件 — Router の MCP ラッパ（フロントエンドなし）

- 起案: 2026-09-26 JST。**オーナー承認済み**（「MCP 前提・フロントエンドなしで進めてよい」）。
- 前提: T1–T5 受け入れ済み（HEAD `108629f`）。既存の要件・設計をやり直さない。
- ラベル: `T6-mcp-nopay`（実決済は含まない。下記 §5）

## 1. なぜ MCP か（デモ主張との関係）

主体験は「**本来支払いができず使えなかった API Provider を、Router に支払わせることで使える**」。
この主張は「**呼ぶ側（クライアント）の支払い手段**」の橋渡しなので、ブラウザのフロントエンドを挟むと
支払う主体がブラウザ側サーバーになり主張とデモがずれる。MCP なら**審査員自身のクライアントが主体**の
まま、「自分の手持ちでは使えなかった Provider が使える」が審査員の環境で起きる。

**現 README は「手動起動手順は用意しておらず、手動起動は検証していない」と明記している。**
MCP 経由の起動を**検証済みの再現手順**にすることが、そのまま審査員向けの手順になる。ここが T6 の価値。

## 2. 設計上の重要な区別（調査で判明）

- mppx は `./mcp/server` 等を export するが、その MCP transport は
  **「MCP サーバが自分の呼び出し元に課金する」**（payment-required な MCP tool）ための仕組みで、
  `_meta["org.paymentauth/credential"]` から資格情報を読み、結果にレシートを付ける形。
  **本 Router は payer 側**であり、MCP ラッパの役割は「Router の能力を Claude Code に公開する」こと。
  **役割が逆なので、mppx の MCP transport をそのまま使う話ではない。**（将来 Router 自身が
  MCP で課金する構成はあり得るが T6 の範囲外。）
- mppx の MCP 系は **peerDependencies**（`@modelcontextprotocol/sdk >=1.25.0`、`@x402/mcp >=2.22.0`）を
  要求し、**どちらも現在インストールされていない**。T4/T5 は「新規依存を追加しない」で通してきたため、
  **依存追加の可否は要件レベルの決定事項**（§4 U-T6-1）。
- **MPP は MCP を第一級トランスポートとして規定しており、`org.paymentauth/*` は公開仕様**
  （paymentauth.org の IETF ドラフト）である。親が `node_modules/mppx` で実測確認した定数:
  `paymentRequiredCode = -32042`、`credentialMetaKey = "org.paymentauth/credential"`、
  `receiptMetaKey = "org.paymentauth/receipt"`（`dist/Mcp.d.ts:7,19,23`）。
  → **支払い付き MCP のワイヤ形式を自前発明する必要はない。**既存仕様に沿わせる。
- **承認フックが公式に存在する**: `dist/mcp/client/McpClient.d.ts:15` に
  `OnPaymentRequired = (challenge) => boolean | Promise<boolean>`（親が実測確認）。
  ただしこれは**クライアント側**＝「自分が有料 MCP tool を呼ぶとき」の差し込み口である。
  本 Router は payer なので、T6-03（明示承認）の実現手段として**そのまま流用できるとは限らない**。
  設計フェーズで、Router の R2→承認→R3 の束縛をこのフックの形と対応付けられるか検討する（U-T6-2）。
- **MCP クライアント SDK は既定で最大 3 回まで支払いを自動再試行する**（親が実測確認）:
  `dist/mcp/client/McpClient.js:8` に `const maxPaymentAttempts = 3`、
  `:137` と `:143` が `attemptsRemaining - 1` で再帰する。
  起点は 2 つ（tool 結果の `_meta` に payment-required、または payment-required エラー）で、
  **再試行のたびに `createCredential`（`:122`）が呼ばれ新しい資格情報が作られる**。
  → **「MCP クライアントは 1 回だけ払う」という前提は置けない。**
  仕様（mpp.dev）は「1 tool call = 1 payment」と書くが、**冪等性・リプレイ防御・at-most-once は
  仕様に明記がない**。本 Router が R3 の並行要求でも両レグ 1 回・同一要求の再送でも再送しないという
  **サーバ側の担保**を既に持っていること（T1–T3 実装、T5 で相互検証）が、この前提では必須になる。
- **承認は資格情報生成より前に呼ばれる**（`:118` の承認 → `:122` の `createCredential`。親が実測確認）。
  これは良い性質で、拒否すれば資格情報が作られる前に止まる。
  ただし**フックが受け取るのは `selected.challenge` のみ**で、tool 名・引数・`quoteId` 相当は渡らない。
  さらに**再試行のたびに呼ばれる**ため、1 回の `callTool` で最大 3 回承認を求められ得る。
  → T6-03 を満たすには、承認対象が何かを challenge 側で表現できる必要がある（U-T6-2）。
- **`mcp-sdk` は `mcp` の純粋なエイリアス**（親が実測確認）: package.json の exports で
  `./mcp/client` と `./mcp-sdk/client` が同一ファイルを指し、`dist/mcp-sdk/` は存在しない。
  調査・実装は片方だけ見ればよい。

## 3. 満たすべき要件

- **T6-01** MCP サーバとして起動でき、Claude Code から `claude mcp add` 相当の**1 行で登録**できる。
  登録に必要な env は README に列挙する。
  成功の判定: `tools/list` に期待する tool 名がすべて現れること（README に名前を固定して記載）。
- **T6-02** 公開する tool は既存 R1–R4 の公開契約の上に載せるだけで、**新しい権限や新しい支払い経路を作らない**。
  想定: 経路一覧（R1）/ 見積り（R2）/ 実行（R3）/ 状態・再取得（R4）。
  **構造的に検証可能な形で固定する**: MCP サーバは **R1–R4 の HTTP 公開契約経由でのみ**
  Router に触り、`src/core/*` を直接呼ばない（import 境界で確認できる）。
- **T6-03 （最重要）明示承認を飛ばさない。** R3 は承認に束縛された支払いを行うため、
  MCP 経由でも**人間の明示承認が必要**であることを維持する。
  「エージェントが自律的に払う」形にはしない（AGENTS.md の「明示承認・正確な束縛」を壊さない）。
  承認の提示・取得方法は設計フェーズで確定する。ただし以下は要件として固定する:
  - **成立判定は Router 側で行う。** 既存の拒否面（`approval !== quoteId` なら `approval_required`、
    `src/core/orchestrator.ts:392`）に依存し、**MCP クライアントの承認フックの有無・戻り値に
    依存しない**。フックは UX であって権限境界ではない。
  - **人間に提示する内容は HMAC 束縛された値（`opaque` 由来）のみ**を根拠にする（U-T6-3b 参照）。
- **T6-04** tool の応答に**秘密を出さない**。principal トークン・資格情報・上流 URL を出さない
  （R1 が上流 URL を返さない既存方針を維持）。MCP 固有の露出面として以下を含める:
  - **stdout を汚さない。** MCP stdio transport は stdout が JSON-RPC 専用。
    既存 `src/main.ts` は起動ラベルを stdout に書く（`:205`）ので、
    **MCP モードでは全ログを stderr へ出す**。さもないとプロトコルが壊れる。
  - **例外メッセージ・スタックトレースをそのまま返さない。** 既存方針（安全な理由コードの白リスト、
    `src/core/orchestrator.ts:223` の `SAFE_PREFLIGHT_REASONS`）を MCP の error 応答でも維持する。
  - **principal トークンは env で受け取り、tool の引数として受け取らない／応答にエコーしない。**
- **T6-05** `unknown` を自動解決しない。自動再送・自動再購入・自動再承認をしない（D-01 を解除しない）。
- **T6-05b（搬送非依存の言い方に修正）** **同一の tool 呼び出しを N 回（N≥3）反復しても、
  両レグが動くのは 1 回だけであること。** MCP クライアント SDK は最大 3 回まで自動再試行し
  そのたびに新しい資格情報を作るが、**再試行が起きるかどうかは搬送・設計に依存する**ため、
  要件は「反復に対して at-most-once」という形で置く（Router が payment-required を返さない設計でも
  検証が空振りにならないようにする）。T5-03e と同形の検証を MCP 経路で行う。
- **T6-05c（T6-05b の前提。これが無いと静かに破れる）**
  **`requestId` は MCP tool の入力から決定論的に導かれること。**
  tool 実装が呼び出しごとに新しい `requestId` を生成してはならない。
  根拠: quote の冪等性キーは `(principalId, requestId)`（`src/core/orchestrator.ts:692`、
  `:289` の `store.quoteIdFor`）で、購入の直列化キーは `quoteId`（`:698`）。
  したがって**再試行のたびに `requestId` が変わると新しい `quoteId` が生まれ、
  直列化キーが別になって購入が 2 回成立し得る**。
  検証: 同一引数で 2 回呼んで**同一 `paymentId`** が返ること、両レグが 1 回であること。
- **T6-06** 支払い能力が無い構成では、MCP 経由でも**合成レールに落ちない**
  （`signer_not_authorized` で fail closed。`ROUTER_ADAPTER_MODE=synthetic` は明示時のみ）。
- **T6-07** 実行証拠を偽らない。合成 fixture 上で動かした場合、tool の応答または起動情報で
  **合成であることを隠さない**。証拠ラベルは**tool の応答に必ず含める**
  （起動ログだけに出すのでは審査員に見えないため）。既存の証拠ラベル方針を維持する。
- **T6-08** MCP 経路のテストを持つ（無課金）。tool の登録・呼び出し・承認束縛・拒否面・`unknown` 保持を
  実プロセスで確認する。既存 13+1 ファイルのテストを壊さない。
- **T6-09** README に**審査員が自分の環境で再現できる手順**を書く。到達している範囲と
  未達（実決済・実 Provider 到達・finality）の区別を明記する。

- **T6-10（プロセス構成。これが未決だと T6-02 / T6-05b が判定不能）**
  MCP サーバは **既存 Router の R1–R4 の HTTP 公開契約に接続する**形とし、
  **MCP プロセス内に Router を内蔵起動しない。**
  根拠: 購入の直列化（`withKey`）は**プロセス内の Map**（`src/core/orchestrator.ts:265`）なので、
  Router が 2 プロセスに増えると直列化が効かない。journal 側は `flock(2)` の `LOCK_EX|LOCK_NB`
  （`src/core/journal.ts:123`）で**2 個目のプロセスは journal を開けず fail closed** するため
  二重購入にはならないが、**MCP 起動のたびに Router を内蔵起動する設計は起動失敗を招く**。
  → 審査員が複数の MCP クライアントから登録しても、接続先の Router は 1 つに保つ。
  Router の起動方法（別途起動 / MCP サーバが無ければ起動を促す）は設計フェーズで決める。
- **T6-11（tool 名の衝突回避）** 審査員の環境には他の MCP サーバが同居する。
  tool 名には**安定した prefix**（例 `subetha_router_*`）を付け、**README に名前を固定して記載**する。
- **T6-12（stdio のライフサイクル）** クライアント切断・stdin EOF・`SIGTERM` で
  **進行中の R3 を中断しない**（`unknown` を無用に量産しないため。D-01 に抵触する）。
  終了時は journal を明示的に閉じる（既存の `core.close()` 経路を使う）。
- **T6-13（プロトコルバージョンの記録）** 検証に使った MCP protocol version と
  `@modelcontextprotocol/sdk` のバージョンを README に記録する（T6-09 の「到達している範囲」の一部）。
- **T6-14（依存の固定）** `@modelcontextprotocol/sdk` は既存の直接依存と同様に
  **完全一致版で固定**する（`^` / `>=` を使わない）。既存 `package.json` は全直接依存を
  完全一致で固定しており、この規律を崩さない。インストール手順
  （`npm install --legacy-peer-deps --ignore-scripts`）が変わらないことも README で確認する。

## 4. 未確定（設計フェーズ前に決める必要がある）

- **U-T6-1 依存追加の可否 → 解決（オーナー承認 2026-09-26）**: **`@modelcontextprotocol/sdk` を採用する。**
  T4/T5 の「新規依存を追加しない」方針は T6 に限り解除される。
  理由: 審査員が自分の環境から `claude mcp add` で呼ぶのが主体験であり、
  プロトコル準拠のズレが致命的になり得るため公式 SDK に従う。
  制約: **追加するのは MCP サーバ実装に必要なものだけ**。`@x402/mcp` は現時点では追加しない
  （mppx の MCP transport は「サーバが呼び出し元に課金する」側の仕組みで T6 の範囲外。§2 参照）。
  インストール前に実在とバージョンを確認する（親が `npm view` で **1.30.1** を確認。
  mppx の peerDep `>=1.25.0` を満たす。peerDep はすべて `optional: true` なので
  これ 1 つを足しても他の peer 警告は増えない）。固定方法は T6-14。
  **実行面の注記**: stdio のみを使う構成なら express / hono / jose / ajv 等の重い推移的依存は
  **実行時にロードされない**（peer セッション実測）。インストール面（supply chain）と
  実行面（攻撃面）は別問題として扱う。
- **U-T6-2 承認の提示方法**: MCP tool 呼び出しの中で人間の明示承認をどう取るか
  （tool を 2 段に分ける / MCP の elicitation を使う / 承認済みトークンを引数で要求する /
  `OnPaymentRequired` 相当の形に合わせる等）。T6-03 を満たす形を設計フェーズで選ぶ。
  **注意**: Router の承認は `quoteId` に束縛され、canonical URL 全体と条件の一致を要求する
  （T4 で実装・T5 で相互検証済み）。`boolean` を返すだけのフック形状では
  **何に対する承認かが落ちる**（フックは challenge しか受け取らない、実測確認済み）。
  加えて**再試行のたびに承認が呼ばれる**ため、「1 回承認したら 1 回だけ実行」を
  クライアント側の作法に依存させてはならない。束縛を保ったまま載せられるかを設計で確認する。
- **U-T6-3b challenge スキーマの自由度 → 解決済み（親が実測確認）。**
  Router の束縛情報を challenge に載せられ、しかも**内容に暗号束縛される**。
  - 自由欄: `request`（任意構造）/ `meta`（`Record<string,string>`）/ `opaque`（base64url）/ `description`。
    `meta` と `opaque` は型定義に "Clients MUST NOT modify" と明記。
  - **challenge の id は HMAC-SHA256** で `realm|method|intent|request|expires|digest|opaque` を入力に計算される
    （`dist/Challenge.d.ts:58-60,130-131`）。`opaque`（= `meta` の載る先）が入力に含まれる。
  - 親が `Challenge.from` / `Challenge.verify` を実際に実行して確認した改竄検知:
    無改竄 → `true`、`opaque` の `quoteId` 差し替え → `false`、`request.amount` 改竄 → `false`、
    `realm` 改竄 → `false`。`quoteId` を変えると **id 自体が変わる**。
  → **`OnPaymentRequired` が `boolean` しか返さなくても、challenge が束縛を運べる。**
    フック内で `meta` / `opaque` / `description` を読めば「何に対する承認か」を人間に提示でき、
    承認した challenge と実際に払う challenge の同一性は id の HMAC で検証できる。
    設計は「tool を 2 段に分ける」方式に限定されない（どちらを採るかは設計フェーズで決める）。
  - **束縛されるのは `opaque` だけ（親が実行して確認。重要）**:
    `description` を差し替えても `verify` は **`true`**、`opaque` を触らず `meta` だけ改竄しても **`true`**。
    `opaque` を改竄したときだけ `false`。さらに `serialize` → `deserialize` の往復で
    **`meta` フィールド自体が消える**（受け手に届くのは `opaque` のみ。`deserialize` は
    `opaque` を展開して `meta` に戻さない）。
    → **人間に提示する承認内容は `opaque` から復号した値のみを根拠にする。
      `description` と `challenge.meta` は提示にも判断にも使わない**（HMAC 非対象のため、
      「人間に見せた文面」と「暗号束縛された内容」が乖離し得る）。
  - **サイズと欠損（親が実行して確認）**: `meta` を 1/8/32/64KB にしても
    `serialize` → `deserialize` の往復で **id・`opaque` が完全一致**し、`verify` も `true`。
    **黙って切り詰められることはない。** 膨張率は `meta` 実バイト × 約 1.33 ≒ `opaque`
    （実測: 8KB → 約 10.9KB）。
  - id の束縛スロットは `header` が非既定のとき 1 つ増える（`dist/Challenge.js:523-525`）。
    **Router は `header` を使わない**方針とし、既定のまま扱う。
    唯一のスキーマ上限は `request` の 16KB（`dist/Challenge.js:6` の `maxRequestParameterLength`）で、
    **`opaque` / `meta` には適用されない**。
    **重要な訂正**: この上限が効くのは `deserialize`（`:229`、ヘッダ解析側）であって
    `from`（作成側）ではない。親の実測では `from` は 17KB の `request` を**受け付け**、
    `deserialize` で初めて `Request parameter too large.` を throw した。
    → 作成時に気づけないため、**Router 側で送出前に自前チェックする**。失敗は常に明示。
  - **搬送経路による許容量の差（peer 実測、親は未再現）**: challenge が HTTP ヘッダを通る場合、
    opaque 4KB/15KB は成功、20KB/40KB は `UND_ERR_HEADERS_OVERFLOW` で fetch 失敗
    （Node 既定 `http.maxHeaderSize` = 16KB）。**壊れたヘッダは返らず明示エラー**。
    MCP の `_meta` は JSON-RPC 本体に入るためヘッダ上限とは無関係で、
    `@modelcontextprotocol/sdk` の stdio に明示的なサイズ定数は見当たらない。
    ただし **MCP 経由で大きな `_meta` を実際に通した確認は誰もしていない**（OS のパイプバッファや
    相手クライアント側の制約は別途あり得る）。
  - **未検証**: 実際に束縛を載せた challenge を MCP 経由で通すこと（T6 の実装範囲）。
  - **設計への含意**: `quoteId` だけ載せて Router 側で引く案なら**サイズは論点にならない**（数十バイト）。
    束縛を全部載せる案でも MCP のみなら余裕があるが、HTTP ヘッダを通す設計なら 16KB を意識する。
    どちらを採るかは設計フェーズ。
- **U-T6-3c challenge は必ず `expires` を持たせること**（親が実測確認）。
  `dist/mcp/client/McpClient.js:115` は `if (selected.challenge.expires)` でガードしているため、
  **`expires` を省略した challenge は期限検査がスキップされ、期限なしとして通る**。
  `Expires.assert` は「無し → InvalidChallengeError / 不正 → InvalidChallengeError / 過去 → PaymentExpiredError」で、
  比較は `new Date(expires) < new Date()`＝**clock skew の猶予なし**（`dist/Expires.js:10-20`）。
  → Router は `expires` を**必ず**設定する。承認 TTL と offer 失効の**早い方**を `expires` に入れ、
    もう一方は `meta` に入れて Router 側で自前検査する（SDK は `expires` しか見ない）。
- **U-T6-3d 再試行時の challenge id は Router が決められる**（親が実測確認）。
  クライアントは challenge を作らず、`McpClient.js:74` で受け取った `paymentRequired.challenges` を
  `Challenge.Schema` で検証して選ぶだけ。再帰再試行（`:135-137`）は
  **その応答でサーバが返した新しい `nextPaymentRequired`** を次に渡す。
  → 再試行で同じ id を再利用するか新規発行するかは**サーバ（Router）の裁量**で、SDK は強制しない。
    at-most-once をサーバ側で担保する既存設計と矛盾しない。
- **U-T6-4 デモで実決済を使うか**: 使うなら B-01 解除（下記 §5）が前提。

## 5. 境界（T6 で解除しないもの）

- **実決済・実鍵・署名・ブロードキャスト・faucet（B-01）は T6 の範囲外。**
  現状 `src/main.ts` が受理する支払い能力は `kind: "non-signing-fixture"` のみで、
  **実署名能力の実装が存在しない**。設計上、署名能力は起動時にコードから注入するものだけを使い
  env・構成ファイルからは読まない（`docs/design.md:183`）。
  実決済デモを行うなら **別タスク（実署名能力 + guarded signer）とオーナーの決済スコープ承認**が必要。
- push・リモート作成・公開・デプロイ（B-04）。
- **chat worktree の編集**（AGENTS.md）。T5 の相互実装テストは保持する（オーナー・peer とも (a) 保持で合意）。
- Provider A/B の実 API 到達（B-05 / U-06）。peer から実測値を受領したが、
  **それは 127.0.0.1 のローカル起動値で恒久的な本番値ではない**と明記されている。
- finality（D-05）、P3/P4/P5（DEFER）。
- フロントエンド（playground・登録申請 UI）は作らない（オーナー決定）。

## 6. 受け入れ条件

- `T6-mcp-nopay` ラベルで、MCP 経路のテストが green。既存テストに回帰なし。
- T6-01〜T6-09 がテスト本文または README の実行可能な手順で確認できる。
- 親のフルチェック（test/types/build）と独立レビュー LGTM。
- README に再現手順と未達の区別。**AC-7・実決済を達成したと書かない。**

## 7. 受領した外部情報（T6 では未使用、実決済タスクで使う）

peer（chat-demo セッション）から U-05 / U-06 の実測値を受領。親が独立に検証できた範囲:

- Tempo RPC `https://rpc.moderato.tempo.xyz` → `eth_chainId` = `0xa5bf` = 42431 **一致を確認**
- Base Sepolia `https://sepolia.base.org` → `0x14a34` = 84532 **一致を確認**
- x402 facilitator `/supported` → HTTP 200、`exact` + `eip155:84532` を含む **確認**。
  `facilitatorAddress` `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf` も確認。
  **訂正**: このアドレスは `upto` kind の `extra` に現れる（peer は一般的な記述だった）。同一アドレス。
- **親が未検証**: Provider A/B の canonical URL・価格・payTo/recipient・challenge TTL。
  これらは peer 側のローカル起動値で、peer 自身が「恒久的な本番値ではない」と明記している。

決済スコープ実績（peer 実測、B-01 解除時の記録用）: 1 回あたり A = 10000 base units + ガス、
B = 10000 base units + pathUSD 建て手数料（実測 175）。連打耐性は 0ms で 2/20 失敗、3000ms で 0/15。
失敗時は 402 + 空 body で**資金は動かない**（payer 残高 delta 0）。A は `maxTimeoutSeconds` 60、
B は challenge 300 秒で失効し延長してはいけない。
