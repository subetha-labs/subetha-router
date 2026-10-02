# SSRF 防御 A（アプリ側: namespace 内の宛先の拒否と接続固定）— 設計 v1

要件は `ssrf-requirements.md` §7.3（FR-A1〜A6）、§7.4（FR-C1/C2）、§8.3（FR-A7）、§8.4（FR-C1'/C2'）、§9（INV-1'' の分担）で確定済み。
B（host 側 egress 制御、`ssrf-egress-design.md`）は実装フェーズをレビュア承認済み（§26.21）。本書は A の設計。

## 1. 範囲

| | 内容 |
|---|---|
| 守る宛先 | **namespace を出ない宛先**: `127.0.0.0/8`、`::1`、コンテナ自身のアドレス、`127.0.0.11`（要件 §9）。加えて B と同じ IANA special-purpose 表（深層防御。要件 §9 は任意としているが、FR-A1 の最低限リストを満たすために入れる） |
| 守る経路 | Router から**外へ出る HTTP 要求のすべて**（FR-A6/A7 の 10 経路: MPP 送信 3、実 x402 送信 3、合成 x402 送信 2、受信 facilitator 2） |
| 守り方 | **fetch 前の分類**（解決した全アドレスの 1 つでも禁止なら拒否 = FR-A2）と、**検査済みアドレスへの接続固定**（FR-A3/A7。transport が自前で名前解決しない） |
| 守らないもの | 公開アドレス上の proxy の先（要件 §9）。namespace を出るパケットの最終的な遮断は B（A の表は B と同じだが、B が正）。**展開固有の保護対象**（VPC の CIDR、グローバル IP を持つ内部サービス、`EXTRA_DENY*`）は A では知り得ないので **B に委ねる**（要件 §9「範囲一覧の網羅は B」） |
| 入れない | 「AI が上流 URL を指定する」機能そのもの。**release gate は B + A の両方の受け入れ**（要件 §9） |

## 2. 事実（2026-10-02 に測った）

| # | 事実 | 根拠 |
|---|---|---|
| A-1 | `mppx` の `Mppx.create({ fetch })` は注入した fetch を `rawFetch` として使う（`Fetch.unwrapFetch(config.fetch ?? globalThis.fetch)`）。現状は `polyfill: false` で `globalThis.fetch` を置き換えていない | `node_modules/mppx/dist/client/Mppx.js:34`、`src/adapters/outbound/mpp.ts:297` |
| A-2 | 実 x402 送信は `@x402/fetch` を**解析にだけ**使い、HTTP は `fetch` を直接呼ぶ（2 箇所 + `getChallenge` 1 箇所を 2 つの呼び出し元が使う）。合成 x402 送信は `fetch` 2 箇所。受信 2 adapter は `post()` 1 本ずつ | `src/adapters/outbound/x402.ts:282,462`、`src/adapters/inbound/{subetha,x402}.ts` |
| A-3 | `undici` 8.11.2 の `Agent({ connect: { lookup } })` は、名前解決を**注入した関数に置き換える**: 存在しない名前 `provider.test` を `127.0.0.1` に固定して `200`、`Host` ヘッダは `provider.test:<port>` のまま。lookup は `all: true` で 1 回だけ呼ばれる | scratchpad `aguard/pin.mjs` (a) |
| A-4 | 固定先に誰も聞いていなければ**失敗する**（システム DNS に落ちない。要求は届かない）。複数を渡すと fallback は**そのリストの中だけ** | 同 (b)(c) |
| A-5 | `undici.fetch` は `redirect: "error"` を守る（302 で例外、2 本目の要求は出ない）。TLS では固定 IP に接続しても **SNI は元のホスト名**（`SNICallback` で `provider.test` を観測） | 同 (d)(e) |
| A-6 | Node 22 の `dns.lookup(name, { all: true, verbatim: true })` は A/AAAA を両方返す（`localhost` → `::1`, `127.0.0.1`）。リテラルは解決せずそのまま返る（`::ffff:127.0.0.1` も文字列のまま） | ローカル実行 |
| A-7 | `undici` は依存に無い（`npm ls undici` 空）。Node 22 の global fetch の `dispatcher` に別コピーの Agent を渡す互換は保証されないので、**`undici` の `fetch` と `Agent` を同じコピーで**使う | `package.json` |
| A-8 | `undici@8.11.2` の `engines.node` は `>=22.19.0`。この repo は `>=22.12.0`。手元は v22.23.1、コンテナの base image `node:22-bookworm-slim` は v22.23.3 | `node_modules/undici/package.json`、`Dockerfile` |
| A-9 | 実 adapter モードの fixture 実行（`tests/wire/x402-cli.test.ts` 等）は `tests/fixtures/router-x402-process.ts` が `startRouter({ evmSigning: spy })` で**能力を注入**して起動し、facilitator は loopback の fixture。本番の入口 `tools/remote-router-process.ts` は実能力だけを注入する | 同ファイル |
| A-10 | 送信 adapter は transport の例外を**握り潰して固定の結果に変える**（MPP の challenge 再読は `not_sent` / `destination_challenge_unreadable`、x402 の有料要求は `unknown` / `destination_pay_unknown`）。core には例外が届かない | `mpp.ts:366-377`、`x402.ts:458-468` |
| A-11 | `::1` と `127.0.0.1` は**同じ port に別々に listen できる**。システム解決（`dns.lookup`）の `localhost` は手元では `[::1, 127.0.0.1]`（A-6）だが、順序も構成も環境依存なので試験は**実行時に読む**。「検査済みの loopback アドレスでは誰も聞いておらず、システム解決が返す**別の**アドレスに囮を置く」配置なら、transport が自前の解決に落ちた接続は **Happy Eyeballs がどの順で試しても囮に届く**（検査済み側は refused で終わるため）。観測できるのは失敗経路。成功経路の固定は lookup の spy と `Host` で示す | ローカル実行 |
| A-13 | **Linux**（Colima VM 内の `node:22-bookworm-slim` コンテナ、v22.23.3）: `127.0.0.2:9` への接続は **1 ms で `ECONNREFUSED`**、`127.0.0.2` に bind できる、`localhost` → `[::1, 127.0.0.1]`。**macOS**（手元）: `127.0.0.2` への接続は **timeout**、bind は `EADDRNOTAVAIL`（`sudo ifconfig lo0 alias 127.0.0.2 up` で足せる）。`127.0.0.1:9` は両方で即 refused | ローカル実行 |
| A-14 | mppx の MPP challenge（402）は **headers から**読み、body は読まない（`client/internal/protocols/Mpp.js`。MCP 経路の body 読みは 402 を飛ばす）。`preparePayment` の後に body は未消費のまま残る | レビュア #3 の指摘、`node_modules/mppx` |
| A-12 | 受信 adapter の `verify` / `settle` は `offer` を受け取り、offer は `createOffer({ routeId, ... })` で route に束縛されている（`preflight` の「route 束縛一致」）。受信の運用者ログの route はここから取れる | `src/ports/inbound.ts` |

## 3. 設計

### 3.1 宛先ポリシー（transport 非依存。FR-A1、FR-A5）

`src/net/destination-policy.ts`。純関数 + 自アドレスの供給元。

- 入力: アドレス文字列（IPv4 / IPv6 / IPv4-mapped）。出力: `allowed` か `denied(reason)`。reason は固定語
  `loopback` / `own_address` / `special_purpose` / `unspecified` / `invalid`。
- バイナリに正規化してから判定する。`::ffff:a.b.c.d` は**埋め込みの IPv4 を分類**し（FR-A1）、`64:ff9b::/96`・`64:ff9b:1::/48`（NAT64）は
  翻訳先を考慮しないので**拒否側**（B と同じ）。
- 表は B の `DENY4` / `DENY6` と**同一**（IANA レジストリ 2025-10-09 版、`100.64.0.0/10`・`198.18.0.0/15`・`192.0.0.0/24`・`fec0::/10` は
  B と同じく拒否のポリシー選択、`2001::/23` 全体を保守的に拒否）。表の出所と版を定数 `POLICY_VERSION = "a1/iana-2025-10-09"` に持ち、
  B の表と diff で照合するテストを置く（`deploy/egress/subetha-egress` から読む）。
- **自アドレス**: `os.networkInterfaces()` の全アドレス（IPv4/IPv6、scope id を落とす）を**判定のたびに**取る（コンテナの bridge アドレス、
  後から足されたアドレスを含む）。テストでは供給元を注入する。
- リテラル IP も同じ表を通す（FR-A3）。`0.0.0.0` / `::` は `unspecified`。
- **判定の順序**（固定）: (1) 構文 → `invalid`。(2) IPv4-mapped なら**埋め込み IPv4 に置き換えて**以下を続ける（B の `::ffff:0:0/96` 一括拒否とは
  **意味が違う**: A は埋め込みを分類する。T-A1 の表の一致は字面の一致であり、この 1 行だけ意味が異なることを明記する）。
  (3) unspecified。(4) **loopback**（`127.0.0.0/8`、`::1`）→ `loopback`。(5) **自アドレス**（`networkInterfaces()` のうち loopback で**ない**もの）→
  `own_address`。(6) 表 → `special_purpose`。(7) allowed。
  loopback を自アドレスより先に判定するので、fixture 例外（§3.4）が loopback を許しても**自分の bridge アドレス等は拒否のまま**。

### 3.2 解決と「いずれか」規則（FR-A2、FR-A3）

`resolveAndVet(hostname)`: リテラルなら解決せず分類。名前なら `dns.lookup(name, { all: true, verbatim: true })` で **A/AAAA 両方**を取る。
空・エラーは `dns_failed`。返った**全アドレスを分類し、1 つでも denied なら `destination_blocked`**（混在 DNS の Provider は意図的に失敗 = FR-A2）。
全部 allowed なら、そのリストが **vetted**（固定先）。解決は要求ごとに 1 回（キャッシュしない）。

### 3.3 接続固定の transport（FR-A3、FR-A7）

`src/net/guarded-fetch.ts`: `createGuardedFetch(options): GuardedFetch`。

```ts
type GuardedFetch = (url: string | URL, init: RequestInit, context: { routeId?: string; operation: string }) => Promise<Response>;
interface GuardedFetchOptions {
  allowLoopback: boolean;                       // §3.4。組み立て側だけが true にできる
  report: (event: TransportEvent) => void;      // 運用者向けログ（§3.6）。**投げる前に**呼ぶ
  lookup?: Lookup;                              // 既定 dns.lookup（試験で注入）
  interfaces?: () => string[];                  // 既定 os.networkInterfaces（試験で注入）
  tls?: { ca?: string[] };                      // 試験の CA だけ。本番は未指定（システムの信頼ストア）
}
```

要求ごとに:

1. URL を解析。`http:` / `https:` 以外、userinfo 付き、空のホストは `destination_blocked`（接続しない）。
2. §3.2 で vetted を得る（ここで止まれば**接続は 1 本も作らない** = FR-A4）。
3. `new undici.Agent({ connect: { lookup: vettedLookup, ...tls } })`。`vettedLookup` はホスト名に関わらず **vetted だけ**を返す
   （Node の `all: true` 形式と単一形式の**両方**に対応。単一形式は vetted の先頭）。TLS の servername と `Host` は URL のホスト名のまま
   （事実 A-5）。証明書検証は**既定のまま**（`rejectUnauthorized` を触らない。試験は `tls.ca` で試験用 CA を足すだけ）。
4. `undici.fetch(url, { ...init, redirect: "error", dispatcher })`。呼び出し側が `redirect` を変えても **`"error"` で上書き**する。
5. **Agent の寿命**: fetch が例外で終わった、または signal が abort されたら `agent.destroy()`（即時）。headers が返ったら `agent.close()` を
   **待たずに**発行する（undici の `close()` は進行中の要求（body の読み取り）を終えてから閉じるので、呼び出し側が body を後から読んでも
   止まらない。読み捨てた body は要求の `signal` の timeout で abort され、その時点で閉じる）。`close()` の promise は捕捉して無視する。
6. 返す `Response` は **undici の `Response` そのもの**（ラッパを被せない。`mppx.preparePayment` が Response を受け取るので、形を変えない）。
   型は境界で `globalThis.Response` に写す（キャスト）。
7. **診断の所有**（失敗 1 つにつき事象ちょうど 1 回。重複の規則は次の 3 分割で、互いに排他）:
   - headers が返る**前**の失敗: transport が分類して `report()` してから投げる。
   - headers の**後**、adapter（または SDK）が **body を読む**途中の失敗（停滞で要求の timeout、切断）: **adapter が同じ分類関数
     `classifyTransportError(error)` で分類して `report()`**（既存の catch の中。公開結果は変えない）。
   - headers の後、adapter が **body を読まない**応答（MPP の 402 challenge: SDK は headers から読む。事実 A-14）: adapter が headers の処理を終えた
     直後に **`response.body?.cancel().catch(() => {})` で明示的に捨てる**（null 安全。既にエラーになった stream の `cancel()` は reject するので、
     その reject は**その場で消費**し、challenge の結果にも診断にも影響させない。早期 return の経路でも必ず捨てる）。接続は即時に解放され、
     その body の停滞や切断は**操作の失敗ではない**ので事象を出さない（出すものが無い）。実装で `preparePayment` が body を保持しないことを確認し、
     T-A17 で「停滞した body が挟まっても challenge 再読が遅れず失敗せず、接続が解放される」「cancel の前に既にエラーになった body でも同じ」を見る。

全接続・全 fallback が vetted の中に閉じる根拠は事実 A-3/A-4。mppx 経由（`rawFetch`）も同じ関数を受け取る（事実 A-1）ので、SDK が内部で
`globalThis.fetch` に逃げない限り到達する。到達の証明は §4（経路ごとの sabotage と、配線を外すと落ちることの確認）。

### 3.4 fixture 例外（FR-C2、FR-C2'）

transport は **adapter ごとに 1 つ**作る（共有しない）。`allowLoopback` は**その adapter の能力**から決める:

| adapter | `allowLoopback: true` になる条件 |
|---|---|
| 実 x402 送信 | `capabilities.evmSigning.kind === "non-signing-fixture"` |
| MPP 送信 | `capabilities.mppTempo.kind === "non-signing-fixture"` |
| 合成 x402 送信 | `ROUTER_ADAPTER_MODE=synthetic`（`assertLoopbackUrl` が loopback 以外を既に拒む） |
| 受信 subetha / x402 | synthetic モード、または `capabilities.fixtureFacilitators === true`（**新設の明示的な能力**。`tests/fixtures/router-x402-process.ts` 等の fixture 起動だけが渡す。`tools/remote-router-process.ts` は渡さない） |

能力が混在する組み立て（x402 が実鍵で MPP が fixture、またはその逆）では、**実能力の adapter は `false`、fixture の adapter だけ `true`**。
`true` が許すのは **loopback だけ**（`127.0.0.0/8`、`::1`）。自アドレス・他の禁止範囲は fixture でも拒否（§3.1 の順序）。
env / 設定ファイルからは変えられない。

### 3.5 10 経路への配線（FR-A6、FR-A7）

| # | 経路 | 呼び出し | `operation` | 拒否時の既存の公開結果（変えない） |
|---|---|---|---|---|
| 1 | MPP `readChallenge` | `mppx.rawFetch` | `challenge` | quote の失敗（既存） |
| 2 | MPP `pay` の challenge 再読 | `mppx.rawFetch` | `pay_challenge` | `not_sent` / `destination_challenge_unreadable` |
| 3 | MPP `pay` の有料要求 | `mppx.rawFetch`（credential 付き） | `pay` | `unknown` / `destination_pay_unknown` |
| 4 | 実 x402 `readChallenge` → `getChallenge` | `fetch` | `challenge` | quote の失敗 |
| 5 | 実 x402 `pay` の challenge 再読 → `getChallenge` | `fetch` | `pay_challenge` | `not_sent`（既存の分類） |
| 6 | 実 x402 `pay` の有料要求 | `fetch` | `pay` | `unknown` / `destination_pay_unknown` |
| 7 | 合成 x402 `readChallenge` | `fetch` | `challenge` | quote の失敗 |
| 8 | 合成 x402 `pay` | `fetch` | `pay` | 既存の分類 |
| 9 | 受信 subetha `post`（verify / settle / challenge） | `fetch` | `facilitator_<path>` | `source_verify_unavailable` 等（既存） |
| 10 | 受信 x402 `post`（verify / settle） | `fetch` | `facilitator_<path>` | 同上 |

配線: 各 adapter のオプションに **`transport: GuardedFetch`（必須）** を足す。省略で `globalThis.fetch` に落ちる経路は作らない
（`fetch` という識別子を adapter から消し、lint で `globalThis.fetch` の直接使用を禁止する）。MPP は `Mppx.create({ fetch, polyfill: false })` に
`(url, init) => transport(url, init, ctx)` を渡す。**`ctx` は `pay` の 1 回の呼び出しに属する request-local なオブジェクト**（`createClient` は pay ごとに
作られ、同じ client が challenge 再読と有料要求に使われる）: `ctx.operation` を `pay_challenge` → `pay` と**その呼び出しの中で**進める。adapter 全体で
共有する可変状態は持たない。`readChallenge` の ctx は不変。受信は `offer` の route 束縛から `routeId` を取る（事実 A-12）。
`composeRails` が adapter ごとに transport を作る。`warnIfInternalUpstream`（起動時の文字列警告）は残し、強制ではない旨を注記する。
`tools/t7-*`、`tools/u01r-*` の手元スクリプトも同じ必須オプションを通す（実能力なら `allowLoopback: false`）。

### 3.6 診断（FR-C1、FR-C1'）

transport は `TransportError`（`code`、`operation`、`routeId?`）を投げる。**投げる前に `report()` を呼ぶ**ので、adapter が例外を握り潰して
固定の結果に変えても（事実 A-10）、運用者向けの 1 行は残る。`code` と根拠:

| `code` | 根拠（実際の error / cause） |
|---|---|
| `destination_blocked` | §3.1/§3.2 の**ポリシー拒否**だけ（URL の形、解決結果の分類）。接続は作っていない |
| `dns_failed` | `dns.lookup` の例外（`ENOTFOUND`、`EAI_AGAIN` 等）、空の結果 |
| `connect_failed` | undici の `cause.code` が `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` / `UND_ERR_CONNECT_TIMEOUT`、TLS の検証失敗（`ERR_TLS_CERT_ALTNAME_INVALID`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`SELF_SIGNED_CERT_IN_CHAIN` 等）。**`ECONNRESET` は接続前か後かの証拠が無いので `transport_failed`** |
| `upstream_timeout` | 要求の `AbortSignal.timeout` が切れた（`TimeoutError`） |
| `aborted` | 呼び出し側の signal による abort（timeout 以外の `AbortError`） |
| `transport_failed` | 上記のどれにも当たらない（`ECONNRESET`、headers 後の切断、不確定。経過時間から推定しない） |

headers 後（adapter が報告）: body の停滞で要求の timeout が切れた → `upstream_timeout`、切断 → `transport_failed`。報告の 1 行は同じ形。

運用者向けログ 1 行: `outbound transport <code> operation=<operation> route=<routeId|-> policy=<POLICY_VERSION>`。**アドレス・ホスト名・URL・
例外文字列は出さない**。`report` は `composeRails` が `process.stderr` に束ねる（core の `note` と同じ出口）。
公開応答と journal は**現状のまま**（§3.5 の表）。新しい公開コードは足さない。

### 3.7 依存

`undici@8.11.2` を **exact** で追加し、`engines.node` を **`>=22.19.0`** に上げる（事実 A-8。手元とコンテナは 22.23）。型は undici の
`Response` を境界で `globalThis.Response` に写す（キャスト。§3.3-6）。

## 4. 受け入れ（実装フェーズの product test。vitest、実 TCP）

観測手段: 試験用の fixture は **TCP の接続数**（`server.on("connection")`）と `Host` を記録する。**囮**: 検査済みが `127.0.0.1` のとき `[::1]` の同じ port に
囮を置く（事実 A-11）。transport が自前で名前解決に落ちれば `localhost` → `::1` で囮に届き、試験が落ちる。

| ID | 試験 | 合格条件 |
|---|---|---|
| T-A1 | 表の単体: B の `DENY4`/`DENY6` を `deploy/egress/subetha-egress` から読み、A の表と集合として一致（`::ffff:0:0/96` は意味が違う旨を試験のコメントに） | 差分 0 |
| T-A2 | 分類の単体: 各範囲の代表値と境界、`::ffff:127.0.0.1`（→ loopback）、`::ffff:8.8.8.8`（→ allowed）、`::ffff:10.0.0.1`（→ special）、NAT64、`0.0.0.0` / `::`、不正文字列、注入した自アドレス（公開 IP でも `own_address`）、**loopback は自アドレスより先**（`127.0.0.1` を interfaces に入れても `loopback`） | 期待どおりの reason |
| T-A3 | 固定の証明（IPv4、成功経路）: URL は `http://localhost:<P>/`。試験は実行時に `S = dns.lookup("localhost", {all:true})` を読んで記録する。fixture は `127.0.0.1:P`、囮は `S` に含まれる他の loopback（通常 `[::1]:P`）、注入 lookup は `[127.0.0.1]`、`allowLoopback: true` → `200`、fixture の `Host` は `localhost:P`、注入 lookup の呼び出し 1 回、囮の接続 0 | FR-A3（成功経路は lookup の spy と `Host` が根拠） |
| T-A4 | 固定の証明（IPv6）: 同じ配置で fixture を `[::1]:P`、囮を `127.0.0.1:P`、注入 lookup `[::1]` → `200`、囮 0 | FR-A3 |
| T-A5 | **DNS に落ちない証明（失敗経路）**: URL `http://localhost:P/`。`V` は **`S` に含まれない loopback アドレス**（Linux は `127.0.0.2`。事実 A-13）。**前提の検査**（満たさなければ**失敗**にする。skip しない）: (i) `V ∉ S`、(ii) `V` に一時サーバを bind して自分で接続できる（経路がある）、(iii) それを閉じた後の `V:P` への接続が 1 秒以内に `ECONNREFUSED`、(iv) 囮を `S` の**全アドレス**の `P` で listen できた。本番: 注入 lookup `[V]` → `connect_failed`、**囮の接続 0**。`V:P` は refused で即終わるので、transport が自前の解決に落ちれば Happy Eyeballs の順序に関わらず囮に届く。**陽性対照**: 固定しない素の `undici.fetch` で同じ URL → 囮の接続 ≥ 1。**変異**: 「検査済みの接続に失敗したらシステム解決で再試行する」transport（試験内の wrapper）→ 囮の接続 ≥ 1 で**この試験が落ちる**ことを確認。macOS では `127.0.0.2` の alias を足して走らせる。**受け入れは Linux で行う**（§4 末尾） | FR-A3 |
| T-A6 | fallback は vetted の中だけ: 注入 lookup `[V, 127.0.0.1]`（`V:P` は誰もいない）、fixture `127.0.0.1:P`、囮は `[::1]:P` → `200`、fixture の接続 1、囮 0。注入 lookup `[V]` だけなら T-A5 と同じく失敗・囮 0 | FR-A3 |
| T-A7 | lookup の両形式: `all: true` で配列、単一形式で先頭、を単体で。undici 経由では `all: true` で呼ばれることを spy で確認 | §3.3-3 |
| T-A8 | rebinding: 注入 lookup を「1 回目は `[127.0.0.1]`、2 回目以降は `[V]`」にして 1 要求 → 接続は 1 回目の集合に閉じる（fixture 1、囮 0）。2 要求目は再解決され `[V]` → `connect_failed`（要求単位で閉じていることの確認） | §5 |
| T-A9 | 混在の拒否: lookup が `[公開 IP, 127.0.0.1]`、`allowLoopback: false` → `destination_blocked`、接続 0、lookup 1 回 | FR-A2 |
| T-A10 | リテラル: loopback / 注入した自アドレス / 各禁止範囲 / userinfo 付き / `ftp:` → `destination_blocked`、接続 0 | FR-A1 |
| T-A11 | `redirect: "follow"` を渡しても 302 で `transport_failed`、2 本目の接続 0 | §3.3-4 |
| T-A12 | TLS（試験用 CA を `tls.ca` に注入。`rejectUnauthorized` は触らない）: (a) `provider.test` の SAN を持つ証明書 → `200`、サーバが見た SNI は `provider.test`、`Host` も `provider.test`（別々に確認）。(b) SAN が `other.test` の証明書 → `connect_failed`（`ERR_TLS_CERT_ALTNAME_INVALID`）、HTTP 要求 0。(c) 試験用 CA に無い証明書 → `connect_failed`、要求 0 | FR-A3 の TLS 検証 |
| T-A13 | **経路ごとの到達**（10 経路）: 各経路について、前提となる要求（challenge 等）は通し、**その経路の要求だけ**を `destination_blocked` にする（transport の `report` を spy し、`operation` で特定）。確認: (1) `report` がその `operation` で `destination_blocked` を 1 回、(2) fixture の接続数が前提分だけ増え、対象の要求で増えない、(3) 公開結果は §3.5 の表のとおり | FR-A7 |
| T-A14 | 配線の検証（実装フェーズの測定）: 10 経路それぞれについて、adapter の `transport` を `globalThis.fetch` に差し替えた一時的な変異で T-A13 の該当試験が**落ちる**ことを記録する（表にして設計書に残す。変異は戻す） | 空でない証明 |
| T-A15 | 能力の混在（`composeRails` の単体）: (x402 実鍵, MPP fixture) → x402 の transport は `false`、MPP は `true`。逆も。synthetic は全部 `true`。`fixtureFacilitators` 無しの real は受信も `false`。env で変えられない | FR-C2' |
| T-A16 | 寿命: 5 MB の body を headers 後にゆっくり読み切れる（`close()` を待たない契約）。読まずに捨てた body は要求の timeout で閉じる。例外時は `destroy()` | §3.3-5 |
| T-A17 | 診断: 各 `code` を 1 回ずつ起こす（headers 前）。headers 後は fixture に `--after-headers stall\|reset` を足して 4 例: (a) **消費する body の停滞**（x402 `getChallenge` の `text()`、受信 `post` の `text()`）→ 要求の timeout → `upstream_timeout` を adapter が 1 行、(b) **消費する body の切断** → `transport_failed` 1 行、(c) **消費しない body の停滞**（MPP `pay_challenge`。fixture は**正しい MPP challenge の headers** を返してから body を止める）→ challenge 再読は遅れず成功し、事象 0、Agent が閉じる（接続解放を fixture 側の切断で観測）、(d) 消費しない body の切断（cancel の前に既にエラーになった stream）→ 同じく事象 0 で成功、unhandled rejection 無し。さらに **有料応答の body を消費する 3 経路**（MPP `pay` の receipt、実 x402 `pay`、合成 x402 `pay`。fixture は**正しい receipt** を返してから body を止める/切る）で (e) 停滞 → `upstream_timeout` 1 行、(f) 切断 → `transport_failed` 1 行、公開結果は既存のまま。確認: `report` は失敗 1 つにつき**ちょうど 1 行**、形は §3.6、**行・公開応答・journal にアドレス・ホスト名・URL・例外文字列が含まれない**（正規表現）、公開結果は §3.5 の表のまま | FR-C1、FR-C1' |
| T-A18 | 文脈の帰属: 異なる route の `pay` を 2 本同時に走らせ、各 `report` 行の `route` と `operation`（`pay_challenge` → `pay`）がそれぞれの呼び出しに正しく付く。受信の `verify` / `settle` の行に offer の route が付く | §3.5 |

既存の wire テスト（`tests/wire/*`）は fixture が loopback なので、transport を `allowLoopback: true` で渡すように更新する。

**受け入れの実行環境**: A の受け入れ（全テスト緑）は **Linux** で行う（T-A5/T-A6/T-A8 の `V` が macOS の既定では作れない。事実 A-13）。手順:
Colima VM 内で `node:22-bookworm-slim` のコンテナにソースを入れ、`npm ci && npm test`。結果（件数・失敗 0）を設計書に記録する。
macOS の手元実行は `sudo ifconfig lo0 alias 127.0.0.2 up` を足したうえで同じテストを走らせる（alias が無ければ T-A5 等は**失敗**する。skip ではない）。

## 5. 残す判断・注意

- 自アドレスは判定のたびに読む（起動後に足されたアドレスも拒否）。読めなければ fail closed（`transport_failed`）。
- 解決結果はキャッシュしない。同じ名前が要求ごとに別アドレスに解決されても、**その要求の接続はその要求で検査した集合に閉じる**（rebinding の
  利得は「検査と接続の間」に限られ、それは無い）。
- `undici` の `Agent` を要求ごとに作る設計は性能より単純さを取った。要求量が増えたら vetted 集合をキーにした再利用を検討する。
- B と表を二重に持つ。表の更新は B（`subetha-egress`）側を正とし、T-A1 が差分を検出する。
- 試験用 CA と証明書は `tests/fixtures/tls/` に**コミット**する（自己署名、SAN `provider.test` と `other.test`、有効期間 10 年、鍵は試験専用）。
  生成コマンドを同ディレクトリの README に残す。本番コードはこれらを読まない。

## 6. 設計レビュー #1（v1、`316849d`）: **REJECT** → v2

レビュー実施: 2026-10-02、`gpt-6-astra`。中核（lookup 置換による固定、mppx への注入、必須の transport、「いずれか」拒否、redirect の拒否）は妥当と確認。

| # | 指摘（要約） | 判定 | v2 での変更 |
|---|---|---|---|
| 1 | 1 本の transport では能力の混在（x402 実鍵 + MPP fixture 等）を表せない。受信 facilitator に独立した fixture 許可が無い。loopback は `networkInterfaces()` にも出るので「loopback は許すが自アドレスは拒む」が矛盾する | **正しい**（blocking） | adapter ごとに transport を作り、その能力で `allowLoopback` を決める（§3.4）。受信は新設の明示的能力 `fixtureFacilitators`。判定順序で loopback を自アドレスより先に（§3.1） |
| 2 | 5 つの adapter を塞ぐ試験では、前提の要求（challenge）で止まり、有料要求の経路が守られていなくても検出できない。10 経路を個別に到達させ、配線を外すと落ちることも示すこと。公開結果は変えないこと | **正しい**（blocking） | T-A13（経路ごとに前提を通し、その要求だけを拒否、`report` の `operation` で特定、接続数で確認）、T-A14（配線の変異で落ちることの記録）、§3.5 に既存の公開結果の対応表 |
| 3 | fallback・rebinding・IPv6・両方の lookup 形式・証明書検証の試験が無い。「要求 0」は禁止接続が無いことの証明にならず、システム DNS に落ちた失敗も通る。scratch の TLS 試験は `rejectUnauthorized: false` | **正しい**（blocking） | 囮（`::1` / `127.0.0.1` の同 port）で DNS への fallback を**観測可能**に（事実 A-11、T-A3〜T-A8）。TLS は試験用 CA で検証を**有効のまま**（T-A12 の 3 通り）。SNI と Host を別々に確認 |
| 4 | 診断は名前だけで根拠と報告経路が無い。adapter に `note` は無く、`(url, init)` では route が分からず、例外は adapter の catch で消える | **正しい**（blocking） | `TransportError` と `code` の根拠表（§3.6）、`report` を**投げる前に**呼ぶ、`context { routeId, operation }` を transport の引数に、`composeRails` が stderr に束ねる。T-A17 で各 code と秘匿を確認 |
| 5 | Agent の `close()` を待つかどうか、body の寿命、Response の変換が未定義 | 正しい（non-blocking） | §3.3-5/6: `close()` は待たずに発行（body 完了後に閉じる）、例外と abort は `destroy()`、Response はラッパ無しのキャスト。T-A16 |
| 6 | B の `::ffff:0:0/96` 一括拒否と A の埋め込み分類は意味が違う。順序と、B に委ねる分類を明記すること | 正しい（non-blocking） | §3.1 の判定順序（mapped の正規化を表より前に）、§1 の委任（展開固有の prefix は B） |
| 7 | `undici@8.11.2` は Node `>=22.19.0`、repo は `>=22.12.0` | 正しい（non-blocking） | `engines.node` を `>=22.19.0` に（事実 A-8） |

## 7. 設計レビュー #2（v2、`27b1640`）: **REJECT** → v3

レビュー実施: 2026-10-02、`gpt-6-astra`。#1 の 7 件のうち 1・2・5・6・7 は**解決**、3・4 は「狭まった」。FR-A1/A2/A4/A5/A6/A7/C2' は満たすと確認
（`unwrapFetch` は SDK 印付きの wrapper だけを剥がすので、注入した closure は残る）。

| # | 指摘（要約） | 判定 | v3 での変更 |
|---|---|---|---|
| 1 | fallback 試験の URL が `provider.test` では、システム解決は失敗するだけで囮に届かず、「囮 0」が証拠にならない。URL と解決の振る舞いを試験ごとに指定し、固定しない接続が囮に届く陽性対照と、「失敗後にシステム解決へ落ちる」transport の変異で試験が落ちることを要求。`localhost` の順序を仮定しない | **正しい**（blocking） | T-A3〜T-A8 を `localhost` と実行時に読んだ `S` で定義し直した。失敗経路（T-A5）で囮を `S` の全アドレスに置き、検査済み側は refused にして順序非依存に。陽性対照と変異を T-A5 に明記。成功経路の根拠は lookup の spy と `Host` と明記（事実 A-11 を改訂） |
| 2 | 診断が headers で止まる: headers 後に body が停滞・切断した失敗は報告されない。`ECONNRESET` の「接続前」は根拠が無い | **正しい**（blocking） | §3.3-7: headers 前は transport、後は adapter が同じ分類関数で報告（失敗 1 つにつき 1 回）。`ECONNRESET` は `transport_failed`。T-A17 に停滞・切断の 2 例を追加 |
| 3 | MPP の 1 client が `pay_challenge` と `pay` の両方に使われるので、不変の ctx では両方に正しく付かない。受信の route、同時要求の帰属 | 正しい（non-blocking） | §3.5: `pay` 呼び出しごとの request-local な ctx を進める（adapter 全体の可変状態は持たない）。受信は offer の route 束縛から（事実 A-12）。T-A18 |

## 8. 設計レビュー #3（v3、`638c693`）: **REJECT** → v4

レビュー実施: 2026-10-02、`gpt-6-astra`。#2 の 3 件のうち文脈の帰属は**解決**、fallback の観測と診断は「狭まった」。FR-A1/A2/A4/A5/A6/A7/C2' は
実装の基盤として十分と確認。

| # | 指摘（要約） | 判定 | v4 での変更 |
|---|---|---|---|
| 1 | T-A5 の「`S` と別の family の loopback」は dual-stack（`localhost` → `::1`, `127.0.0.1`）では作れない。family ではなく**別のアドレス** `V ∉ S` を要求し、`V:P` が refused であること、`S` の全アドレスで囮が聞くこと、陽性対照と変異が実行できることを要求。作れない環境を受け入れにしない | **正しい**（blocking） | `V` を「`S` に含まれない loopback アドレス」（Linux は `127.0.0.2`。事実 A-13）に定義し直し、前提 4 点を**失敗条件**として明記（skip しない）。受け入れの実行環境を Linux に固定し、手順を §4 末尾に |
| 2 | MPP の `pay_challenge` は SDK が headers から challenge を読み body を消費しないので、headers 後に body が停滞しても adapter の catch に入らず、報告されない。未消費 body の観測者を定義するか、扱いを明示的に改めること。重複の規則、正しい challenge headers の使用、消費する body の例も | **正しい**（blocking） | 未消費 body は headers の処理後に **`body.cancel()`** で捨てる（接続解放、操作の失敗ではないので事象無し）と明示（§3.3-7 の 3 分割、事実 A-14）。T-A17 を 4 例（消費/未消費 × 停滞/切断）に改め、MPP 側は正しい challenge headers を使う |

## 9. 設計レビュー #4（v4、`bc877f3`）: **APPROVE WITH CHANGES** → 設計確定

レビュー実施: 2026-10-02、`gpt-6-astra`。#3 の 2 件は**解決**。新規の接続固定の迂回は無し。FR-A1〜A7、FR-C1'、FR-C2'、§9 を満たすと評価。

| # | 指摘 | 判定 | 反映 |
|---|---|---|---|
| 1 | `body.cancel()` の失敗の扱いが未定義（既にエラーの stream では reject する。既存の catch で待つと `destination_challenge_unreadable` に化け、放置すると unhandled rejection） | 正しい（non-blocking） | §3.3-7: null 安全、reject をその場で消費、早期 return でも捨てる。T-A17 (d) に「cancel 前に既にエラー」を追加 |
| 2 | T-A17 の消費 body の例が challenge と受信 `post` だけで、有料応答の body 消費側（MPP receipt、実/合成 x402 の有料応答）の報告漏れを検出できない | 正しい（non-blocking） | T-A17 に (e)(f) を追加（正しい receipt を返してから停滞/切断） |

## 10. 実装タスク（実装フェーズの単位。順に、各単位で `npm test`）

| # | 単位 | 成果物 |
|---|---|---|
| I-1 | 依存: `undici@8.11.2`（exact）、`engines.node >=22.19.0` | `package.json`、lock |
| I-2 | ポリシー: `src/net/destination-policy.ts`（分類、表、`POLICY_VERSION`、自アドレス供給元の注入） | T-A1、T-A2 |
| I-3 | transport: `src/net/guarded-fetch.ts`（`createGuardedFetch`、`TransportError`、`classifyTransportError`、lookup の両形式、要求ごとの Agent、redirect の上書き、寿命） | T-A3〜T-A12、T-A16 |
| I-4 | fixture: `tests/fixtures/tls/`（CA、`provider.test`、`other.test`、信頼されない証明書、README）、fixture サーバに `--after-headers stall\|reset`、接続数と `Host` の記録、囮サーバ | — |
| I-5 | 配線: 5 adapter に `transport` 必須、MPP の request-local ctx と body の cancel、adapter 側の報告、受信の route、`composeRails` の adapter ごとの transport と `fixtureFacilitators`、fixture 起動と tools の更新、`warnIfInternalUpstream` の注記 | T-A13、T-A15、T-A17、T-A18 |
| I-6 | 直接 `fetch` の禁止: `src/` で `globalThis.fetch` / 裸の `fetch(` を `src/net/` 以外で使っていないことの試験 | 補助 |
| I-7 | 既存 wire テストの更新（`allowLoopback: true` の transport） | 緑 |
| I-8 | 配線の変異の記録（T-A14）と Linux での受け入れ実行（§4 末尾）。結果を §11 に記録 | §11 |
| I-9 | Codex の実装レビュー → 指摘の反映 | §12 |
