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

8. **HTTP/1.1 だけ**（実装レビュー #1 の指摘 1）: `Agent({ allowH2: false })`。undici 8 は既定で ALPN に h2 を提示し、`REFUSED_STREAM` /
   `GOAWAY` を受けた要求を**自動で再送**する（RFC 9113 §8.7 の「1 回だけ」の範囲でも、相手の申告に依存した再送）。credential を載せた
   有料要求を transport が 2 度送り得るのは「1 回だけ送る」契約（§3.5 の表の経路 3・6・8）に反するので、h2 を提示しない。
   Node 同梱の fetch（undici 6）は h2 を既定で使わないので、A 以前の挙動と同じ。T-A19 で ALPN の結果（`1.1`）と対照（`2.0`）を見る。
9. **判定自体の失敗**（同指摘 5）: 自アドレスの列挙など、ポリシー判定や Agent 生成が例外で終わったら、接続を作らずに
   `transport_failed` を**1 回報告して** `TransportError` で投げる（§5「読めなければ fail closed」の実装）。`TransportError` 以外の例外が
   transport から漏れる経路は無い。T-A20。

10. **1 回の fetch につき dispatch は 1 回**（実装レビュー #2 の指摘 1）: undici の `fetch` は **421** を受けると接続を捨てて**同じ要求を
    新しい接続で自動再送**する（Fetch 標準の 421 再試行。body が無いか再生可能な要求が対象で、credential 付き GET も JSON 文字列の POST も
    該当する。h2 とは無関係）。transport は Agent に interceptor を重ね（`agent.compose`）、2 回目の dispatch を拒んで fetch を失敗させる
    （`transport_failed`。最初の要求は送られているので adapter の公開結果は既存の `unknown` 側に落ちる）。T-A21 で、fixture が見た要求が
    1 回であること、対照の素の undici fetch が同じ credential を 2 度送ることを見る。undici の HTTP/1.1 client 自体は書き込んだ要求を再送しない
    （`client-h1.js` の `kRunning` の分岐は pipelining の制御。要求ごとの Agent なので pipeline の後続もない）。

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
| 11 | 受信 MPP の SDK の JSON-RPC（`validateCredential` / `broadcastCredential` が `getTransactionReceipt`・`eth_call` 等を出す。challenge 発行時の metadata 読取も含む） | viem `http` transport（`fetchFn`） | `rpc` | `isValid: false` / `unknown` / `source_settle_unknown`（既存） |
| 12 | 送信 MPP の能力の client の JSON-RPC（`createCredential` が nonce・fee・送金 RPC を出す） | viem `http` transport（`fetchFn`） | `rpc` | `unknown` / `destination_pay_unknown`（既存。能力に触れた後の失敗は保守的に unknown） |

配線: 各 adapter のオプションに **`transport: GuardedFetch`（必須）** を足す。省略で `globalThis.fetch` に落ちる経路は作らない
（`fetch` という識別子を adapter から消し、lint で `globalThis.fetch` の直接使用を禁止する）。MPP は `Mppx.create({ fetch, polyfill: false })` に
`(url, init) => transport(url, init, ctx)` を渡す。**`ctx` は `pay` の 1 回の呼び出しに属する request-local なオブジェクト**（`createClient` は pay ごとに
作られ、同じ client が challenge 再読と有料要求に使われる）: `ctx.operation` を `pay_challenge` → `pay` と**その呼び出しの中で**進める。adapter 全体で
共有する可変状態は持たない。`readChallenge` の ctx は不変。受信は `offer` の route 束縛から `routeId` を取る（事実 A-12）。
`composeRails` が adapter ごとに transport を作る。`warnIfInternalUpstream`（起動時の文字列警告）は残し、強制ではない旨を注記する。
`tools/t7-*`、`tools/u01r-*` の手元スクリプトも同じ必須オプションを通す（実能力なら `allowLoopback: false`）。

**JSON-RPC（経路 11・12。実装レビュー #1 の指摘 2 で追加）**: Router が出す HTTP は Provider / facilitator への要求だけではない。
受信 MPP の SDK は `tempo.charge` の `getClient` が返す viem client で RPC（receipt の照合、署名検証の `eth_call`）を出し、
既定（`getClient` 未指定）では SDK 内蔵の `http(url)` = 素の `globalThis.fetch` で、`redirect` の拒否も無い。送信 MPP は能力の client
（本番は `tools/real-mpp-capability.ts` の `http(rpcUrl)`）に委ねていた。宛先は運用者の設定だが、RPC 事業者の redirect や
namespace 内に解決される名前は A の範囲（要件 §9）であり、B は見られない。配線は `src/net/guarded-rpc.ts` の
`guardedRpcTransport(transport, url, context)`（viem `http(url, { fetchFn })`。`src/` で viem の `http()` を作ってよいのはここだけ。
試験 I-6 が検査する）:

- 受信 MPP: adapter が `tempo.charge({ getClient })` を渡す。client は guarded な http transport で作る。route は `verify` / `settle` /
  `createOffer` の呼び出し文脈を **AsyncLocalStorage** で `fetchFn` まで運ぶ（SDK は `getClient` を呼び出しの内側で呼ぶ）。
  RPC URL は `rpcUrl` オプション、省略時は viem の既知チェーン（4217 / 42431）の既定 URL（SDK の既定と同じ公開エンドポイント）。
- 送信 MPP: adapter が能力の client の transport を見て、viem `http`（`transport.type === "http"`、`url`）なら**その URL で guarded な
  http transport を作り直し**、SDK には guard した `request` だけを持つ最小 client を渡す（能力側の fetch は使わない。`retryCount` 等は
  能力の値を引き継ぐ）。試験用 spy（`non-signing-fixture`）の `custom` transport は HTTP を持たないのでそのまま。実鍵で http 以外の
  transport は fail closed（どこへ出るか保証できない）。route は pay の request-local ctx。

**RPC の body と期限（実装レビュー #2 の指摘 2・4）**: viem は `fetchFn` が返した応答の body を**自分で**読み、その読み取りは viem の
timeout（headers で解除）の外にあり、失敗は viem の例外に包まれて adapter の catch で固定の結果に変わる（報告 0、停滞は無期限）。そこで
`guardedRpcTransport` は **body をここで読み切り**（上限 10 MiB。viem の既定と同じ）、応答全体（headers + body）に 1 つの期限
（既定 10 s）を掛け、headers 後の失敗を
`transport.report` で 1 回報告してから投げる。viem には読み切った body を持つ新しい `Response` を渡す（viem はネットワークに触れない）。
**期限の所有は transport だけ**（実装レビュー #3 の指摘 1）: viem の timeout は **0（無効）**にする。viem のタイマーは `fetchFn` より前
（要求の直列化・`Request` 構築の前）に始まるので、「transport の期限 + 余白」では順序を保証できず、viem の AbortError が `aborted` に化ける。
0 なら viem はタイマーを置かず signal も渡さない（`withTimeout` は `timeout > 0` のときだけ）。呼び出し側が渡した signal は `AbortSignal.any`
で保つ。単体（`tests/unit/guarded-rpc.test.ts`）で viem 側の `timeout` が 0 であること、headers の停滞が `upstream_timeout` で終わることを見る。
送信側の作り直しは viem の**素の** `http` transport（`type` と `key` が `http`）だけを対象にし、URL・`fetchOptions`（認証ヘッダ等）・
`retryCount` / `retryDelay` / `timeout` を引き継ぐ。`onFetchRequest` 等の closure は引き継げないので対象外（文書化）。装飾された transport
（`withFeePayer` は `type: "feePayer"`）、`fallback`、`webSocket` は実鍵では fail closed。受信側は `rpcTimeoutMs`（既定 10 s）。

**読まずに終わる応答**（実装レビュー #3 の指摘 2）: adapter が headers だけ見て早期 return / throw する経路（MPP の receipt 不一致・502・
その他 status、合成 x402 の 402 以外の challenge と 200 以外の有料応答、実 x402 の 402 以外の challenge）でも `discardBody` で body を捨て、
接続を即時に解放する。公開結果は変えず、事象も出さない（読まない body の失敗は操作の失敗ではない。§3.3-7）。実 x402 の有料応答は
SDK の `processResponse` が全 status で body を読むので対象外。T-A17 (h)。

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
| T-A13 | **経路ごとの到達**（12 経路。実装レビュー #1 で JSON-RPC の経路 11・12 を追加）: 各経路について、前提となる要求（challenge 等）は通し、**その経路の要求だけ**を `destination_blocked` にする（transport の `report` を spy し、`operation` で特定）。確認: (1) `report` がその `operation` で `destination_blocked` を 1 回、(2) fixture の接続数が前提分だけ増え、対象の要求で増えない、(3) 公開結果は §3.5 の表のとおり | FR-A7 |
| T-A14 | 配線の検証（実装フェーズの測定）: 10 経路それぞれについて、adapter の `transport` を `globalThis.fetch` に差し替えた一時的な変異で T-A13 の該当試験が**落ちる**ことを記録する（表にして設計書に残す。変異は戻す） | 空でない証明 |
| T-A15 | 能力の混在（`composeRails` の単体）: (x402 実鍵, MPP fixture) → x402 の transport は `false`、MPP は `true`。逆も。synthetic は全部 `true`。`fixtureFacilitators` 無しの real は受信も `false`。env で変えられない | FR-C2' |
| T-A16 | 寿命: 5 MB の body を headers 後にゆっくり読み切れる（`close()` を待たない契約）。読まずに捨てた body は要求の timeout で閉じる。例外時は `destroy()` | §3.3-5 |
| T-A17 | 診断: 各 `code` を 1 回ずつ起こす（headers 前）。headers 後は fixture に `--after-headers stall\|reset` を足して 4 例: (a) **消費する body の停滞**（x402 `getChallenge` の `text()`、受信 `post` の `text()`）→ 要求の timeout → `upstream_timeout` を adapter が 1 行、(b) **消費する body の切断** → `transport_failed` 1 行、(c) **消費しない body の停滞**（MPP `pay_challenge`。fixture は**正しい MPP challenge の headers** を返してから body を止める）→ challenge 再読は遅れず成功し、事象 0、Agent が閉じる（接続解放を fixture 側の切断で観測）、(d) 消費しない body の切断（cancel の前に既にエラーになった stream）→ 同じく事象 0 で成功、unhandled rejection 無し。さらに **有料応答の body を消費する 3 経路**（MPP `pay` の receipt、実 x402 `pay`、合成 x402 `pay`。fixture は**正しい receipt** を返してから body を止める/切る）で (e) 停滞 → `upstream_timeout` 1 行、(f) 切断 → `transport_failed` 1 行、公開結果は既存のまま。確認: `report` は失敗 1 つにつき**ちょうど 1 行**、形は §3.6、**行・公開応答・journal にアドレス・ホスト名・URL・例外文字列が含まれない**（正規表現）、公開結果は §3.5 の表のまま | FR-C1、FR-C1' |
| T-A18 | 文脈の帰属: 異なる route の `pay` を 2 本同時に走らせ、各 `report` 行の `route` と `operation`（`pay_challenge` → `pay`）がそれぞれの呼び出しに正しく付く。受信の `verify` / `settle` の行に offer の route が付く（**`composeRails` の包み越し**に。実装レビュー #1 の指摘 3） | §3.5 |
| T-A19 | HTTP/1.1 だけ: `allowHTTP1` の HTTP/2 サーバ（試験用 CA）に対し、transport の要求は `httpVersion` `1.1`。対照として `allowH2: true` の Agent は `2.0`（サーバが h2 を提示している証明） | §3.3-8 |
| T-A20 | 判定の失敗: 自アドレスの供給元が例外を投げたら、公開アドレス宛でも接続せず `transport_failed` を 1 回、`TransportError` で投げる。adapter が同じ例外を `report` しても二重にならない | §3.3-9 |
| T-A21 | 1 回の fetch につき 1 dispatch: 421 を返す fixture に credential 付き GET と JSON の POST → fixture が見た要求は各 1 回、`transport_failed` 1 回ずつ。対照の素の undici fetch（同じ Agent 構成）は同じ credential を 2 度送り接続も 2 本 | §3.3-10 |

実装レビュー #1（§12）で強めた受け入れ条件: T-A5 の囮は `S` の全アドレスで listen できなければ**失敗**（catch で空にしない）。
T-A7 は `createVettedLookup` の**単体**（配列 / 単一形式）と、本物の undici `Agent` に spy を渡して `all: true` で呼ばれることの観測。
T-A16 の「読まずに捨てた body」は fixture 側の socket の close を観測する（読まない）。T-A17 は (c)(d) を **pay の `pay_challenge`** で行い、
捨てた body の接続が要求の timeout（5 s）を待たずに閉じること（= cancel が解放している）を fixture の `closed` で観測し、
`discardBody` の契約（既にエラーの stream / locked / null）を単体で見る。(e)(f) は実・合成 x402 とも停滞と切断、受信は **verify** の停滞と
切断（`--after-headers-on verify`）。headers 前の `dns_failed` / `aborted` を 1 回ずつ。T-A13 の公開結果に transport の語彙・アドレス・URL が
無いことを `expectSilent` で見る。
実装レビュー #2（§13）で追加: T-A17 (c)(d) の接続解放は**種類別**（402 を書いた socket だけ）に数え、観測用 `/calls` と有料応答の socket は
数えない（cancel を外すと落ちることを M-A8 で測る）。T-A17 (g) は RPC fixture の `--after-headers stall|reset` で、受信（verify）と送信（pay）の
RPC body の停滞・切断が `rpc` で 1 回報告され、停滞が transport の期限で終わること。T-A18 に受信 RPC の同時実行（同じ rail、別 route）の帰属。
`expectSilent` は pay の公開結果すべてに。
実装レビュー #3（§14）で追加: T-A17 (h) = 読まずに終わる応答の接続解放（MPP の receipt 不一致、合成 x402 の 500、実 x402 の 402 以外の
challenge。fixture の種類別 `closedByKind.other`）。(g) の送信側に切断を追加。`tests/unit/guarded-rpc.test.ts` で viem の timeout が 0 であること。

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

- HTTP/2 は使わない（§3.3-8）。将来 h2 を使うなら、credential 付き要求の再送方針を設計して試験してから。
- 1 回の fetch につき dispatch は 1 回（§3.3-10）。421 を返す Provider への要求は `transport_failed` になり、adapter は既存の `unknown` 側に写す。
- RPC の body は transport が読み切る（§3.5）。viem の `maxResponseBodySize` 相当の上限（10 MiB）は transport 側で掛ける。
- 「1 回だけ送る」は credential 付きの要求と送金系 RPC についての主張。読取系 RPC は能力の `retryCount`（本番の能力は 0）に従って viem が
  再送し得る（認証ヘッダ付きの読取も含む）。送金系は adapter の guard が 1 回に制限する。
- `tls.ca` は Node の既定の信頼ストアを**置き換える**（追加ではない）。試験専用で、本番は未指定（システムの信頼ストア）。
- 受信 MPP の RPC URL は省略時 SDK の既定と同じ公開エンドポイント。認証付き RPC を使うには adapter の `rpcUrl`（env からの設定は未実装。
  運用の follow-up）。送信 MPP は能力の `rpcUrl`（`SUBETHA_TEMPO_RPC_URL`）をそのまま guarded に作り直す。
- `src/client/`（Router 自身の公開 API を呼ぶ側）は A の対象外（§11 D-3）。実装レビュー #1 も妥当と判断（「支払い経路の RPC を除外する理由には
  ならない」の指摘は経路 11・12 で反映）。

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

## 11. 実装の記録（I-1〜I-8。実装 `456cc0b`、`eda0653`、`7a8cf84`、実装レビュー #1 の反映 `d569caa`、#2 の反映 `1487f8d`、#3 の反映 `af0d74d`）

### 11.1 設計からの逸脱（実装レビューで可否を問う）

| # | 設計 | 実装 | 理由 |
|---|---|---|---|
| D-1 | §3.3 `createGuardedFetch(options): GuardedFetch`（関数 1 つ） | `createGuardedTransport(options): GuardedTransport = { fetch, report, allowLoopback }`。adapter のオプションは `transport: GuardedTransport`（必須） | headers 後の body 失敗を adapter が**同じ出口・同じ `policy`** で報告するため、`report(error, ctx)` を fetch と一緒に渡す。`report` は `classifyTransportError` で分類し、`TransportError`（transport が投げる前に報告済み）は二重に報告しない（§3.3-7 の排他をここで実装） |
| D-2 | §3.5 受信は offer の route 束縛から `routeId` を取る | `verify` / `settle` に省略可能な第 3 引数 `InboundCallContext { routeId }` を追加し、core（orchestrator）が intent の `routeId` を渡す。`challenge` は `request.routeId` | offer が持つのは `routeBinding`（指紋）だけで `routeId` は復元できない（事実 A-12 の読み違い）。context 無しの呼び出しは `route=-` |
| D-3 | §3.5 lint で `globalThis.fetch` の直接使用を禁止 | 単体試験 `tests/unit/no-direct-fetch.test.ts` が `src/` を走査する。`src/net/` と `src/client/` を除外し、コメントと型参照 `typeof globalThis.fetch` は無視 | repo に lint 設定が無い。`src/client/` は Router の公開契約（R1–R4）の型付きクライアントで、MCP server と tools が **Router 自身の HTTP API** を呼ぶ側。宛先は運用者が設定した `baseUrl` の origin だけ（quote が返す URL へは出さない、と同ファイルの方針にある）。要求に由来する宛先ではないので 10 経路（要件 FR-A6「上流へ出る全要求経路」）の外と判断した |
| D-4 | §5 試験用 CA と証明書を `tests/fixtures/tls/` にコミット（有効期間 10 年） | `tests/fixtures/tls/generate.ts` が試験の開始時に `openssl` CLI で一時ディレクトリに生成する（有効期間 2 日）。README は生成物の表 | `.gitignore` が `*.pem` / `*.key` を除外している。鍵を force-add するより生成の方が安全。T-A12 は実行環境に `openssl` を要する（Linux コンテナでは `apt-get install openssl`。無ければ T-A12 は失敗する） |
| D-5 | §3.6 undici の `cause.code` で分類 | `cause` の連鎖と `AggregateError.errors` を深さ 5 まで辿り、最初に当たる分類を採る | undici は複数アドレスへの接続失敗を `AggregateError` に、TLS の検証失敗を `cause.cause` に包む（T-A12 で確認） |
| D-6 | §3.3-5 abort で `destroy()` | fetch が例外で終わったら `destroy()`（abort を含む）。headers 後は `close()` を待たずに発行し、abort された要求は undici 側で終わるので `close()` が完了する | 契約は同じ。T-A16 で 5 MB の遅い読み取りと読み捨て body の timeout（socket の close）を確認 |
| D-7 | §3.5 の経路は 10 | **12**（JSON-RPC の経路 11・12 を追加。§3.5）。受信 MPP は `tempo.charge({ getClient })` + AsyncLocalStorage、送信 MPP は能力の client の viem `http` transport を guarded に作り直す | 実装レビュー #1 の指摘 2。要件 FR-A6 は「10 経路と将来増えるもの」なので要件の改訂は不要。`operation` は `rpc`。送信側の公開結果は既存の写像（能力に触れた後の失敗は `unknown`）のまま |
| D-8 | §3.3 に h2 の記述なし | `Agent({ allowH2: false })`（§3.3-8） | 実装レビュー #1 の指摘 1。undici 8 の既定 h2 + REFUSED_STREAM 再送が「1 回だけ送る」契約に反する |
| D-9 | §3.3-7 の transport の分類は接続失敗を想定 | 判定自体の例外（自アドレスの列挙失敗等）を `transport_failed` に正規化して 1 回報告（§3.3-9） | 実装レビュー #1 の指摘 5。接続は作っていない。T-A20 |
| D-10 | §3.3 に 421 の記述なし | `agent.compose(oneDispatch())` で 2 回目の dispatch を拒む（§3.3-10） | 実装レビュー #2 の指摘 1。undici fetch の 421 再試行は h2 と無関係で、`allowH2: false` では防げない |
| D-11 | §3.5 の RPC は fetch だけを guard | `guardedRpcTransport` が body を読み切り、応答全体に期限（既定 10 s）と上限（10 MiB）を掛け、headers 後の失敗を 1 回報告（§3.5） | 実装レビュー #2 の指摘 2。viem は body を timeout の外で読み、失敗を包む |
| D-12 | §3.5 送信の作り直しは URL だけ | `fetchOptions`（認証ヘッダ等）・`retryCount` / `retryDelay` / `timeout` を引き継ぐ。対象は `type` と `key` が `http` の素の transport だけ | 実装レビュー #2 の指摘 4。装飾 transport の意味は URL から復元できないので fail closed |
| D-13 | §3.5 viem の timeout は期限 + 250 ms | viem の timeout は **0**（無効）。期限は transport だけ | 実装レビュー #3 の指摘 1（A-30）。余白では順序を保証できない |
| D-14 | §3.3-7 の cancel は MPP の 402 challenge だけ | 早期 return / throw する全経路で `discardBody`（§3.5「読まずに終わる応答」） | 実装レビュー #3 の指摘 2。接続が要求の timeout まで残っていた |

### 11.2 試験の実装で分かったこと（§2 の事実に追加）

| # | 事実 | 影響 |
|---|---|---|
| A-15 | undici は `:9` 等の "bad port" への要求を**接続前に** `TypeError` で拒む | 閉じた port の試験（T-A15）は実行時に bind → close した port を使う |
| A-16 | fixture の `--after-headers reset` で headers を書いた直後に socket を壊すと、undici が fetch 自体を失敗させる（`UND_ERR_SOCKET`）ので adapter は headers を受け取れない | fixture は 50 ms 後に壊す |
| A-17 | fixture の接続数は `server.on("connection")`。`/calls` の読み出しが keep-alive で接続を持つと数が揺れる | 読み出しは `http.get(..., { agent: false })` で、読み出し自身の接続を差し引く |
| A-18 | 素の undici fetch（既定 dispatcher）は keep-alive の接続を再利用する。T-A5 の陽性対照の後に変異を走らせると、変異の要求は囮に届いても**接続数が増えない** | T-A5 の陽性対照と変異は囮が見た**要求数**（`Host` の記録）で数える。Linux 受け入れ 1 回目（M-A2）で検出し `7a8cf84` で修正 |
| A-19 | Linux コンテナ（`node:22-bookworm-slim`）でも `localhost` は `[::1, 127.0.0.1]` の順 | T-A3 / T-A5 の囮は `::1` 側に立つ（macOS と同じ配置） |
| A-20 | macOS は `127.0.0.2` に alias 無しでは bind できない（`EADDRNOTAVAIL`） | T-A5 / T-A6 / T-A8 は前提検査で**失敗**する（skip ではない。§4 どおり）。受け入れは Linux |
| A-21 | undici 8.11.2 は `allowH2` の既定が `true`（`lib/core/connect.js`）。`client-h2.js` は `REFUSED_STREAM` を 1 回再送する | §3.3-8。T-A19 で、`allowH2: true` の対照は Node の `http2.createSecureServer({ allowHTTP1: true })` に対し `2.0` を話す |
| A-22 | mppx の `tempo.charge` は `getClient` 未指定だと SDK 内蔵の `http(url)`（`defaults.rpcUrl`: `https://rpc.tempo.xyz` / `https://rpc.moderato.tempo.xyz`）で client を作る。viem の既知チェーン（`viem/tempo/chains`）の既定 URL と同じ | 受信 MPP の `rpcUrl` 省略時の既定をこれに合わせた |
| A-23 | viem 2.54 の `http(url, { fetchFn })` は要求ごとに `fetchFn(url, { body, headers, method, signal })` を呼ぶ。`client.transport` は `{ type: "http", url, retryCount, retryDelay, timeout }` を公開する | 送信 MPP で能力の client から URL を取り、guarded に作り直す根拠 |
| A-24 | push 形式（`type: "hash"`）の credential は署名無しで作れる（`Credential.from({ challenge, payload })` → `serialize`）。SDK は HMAC（`opaque`）を検証した後に `eth_getTransactionReceipt` を RPC に出す | T-A13 の経路 11 を実 SDK で駆動する材料（RPC fixture は receipt 無し → 既存の fail-closed 結果） |
| A-25 | 送信 MPP で json-rpc account の能力は最初の RPC が `wallet_sendCalls`（送金系）。adapter の at-most-once guard はその試行を数えるので、RPC が `destination_blocked` でも公開結果は `unknown`（既存の写像） | 経路 12 の公開結果の期待値。運用者向けの `destination_blocked rpc` 行で「出ていない」ことは分かる |
| A-26 | ポリシーの `ParsedAddress.text` は IPv6 を長形式（`::1` → `0:0:0:0:0:0:0:1`）に正規化する。undici はこれを接続先に使える | T-A7 の単体の期待値 |
| A-27 | undici 8 の `fetch` は `response.status === 421 && !isNewConnectionFetch && (body 無し || body.source 有り)` で接続を捨てて `httpNetworkOrCacheFetch(..., true)` を**もう 1 回**走らせる（`lib/web/fetch/index.js`）。interceptor は `handler.onResponseError(null, err)` で dispatch を失敗させられる（`lib/interceptor/dns.js` と同じ） | §3.3-10 の実装。T-A21 の対照は同じ credential を 2 度送る（M-A9） |
| A-28 | viem 2.54 の http transport は `withTimeout(fetchFn)` の後に `readResponseBody` を呼ぶ（timeout は headers で解除）。transport の値は `{ key, type: "http", url, fetchOptions, retryCount, retryDelay, timeout }` | D-11 / D-12 の根拠 |
| A-29 | `withFeePayer` の transport は `type: "feePayer"`（viem/tempo `Transport.js`） | 実鍵では fail closed に当たる（受信・送信の現構成では未使用） |
| A-30 | viem の `withTimeout` は `fetchFn` を呼ぶ前にタイマーを始め、`timeout > 0` のときだけタイマーと signal を持つ。レビュアの probe: 直列化に 400 ms 掛かる状況で `timeout 50 + 250` の構成は viem の AbortError が先に出た | D-13。0 で viem 側を無効化 |
| A-31 | `@x402/core` の `processResponse` は全 status で body を読む（`response.json()` / `text()`） | 実 x402 の有料応答に未読の早期 return は無い |
| A-32 | buffering 後は viem の `withTimeout` が body の読み取りまで覆うので、「期限を外す」変異（C-4）の検出は**誤分類**（AbortError → `aborted`）だった（レビュー #3 の指摘 3）。viem の timeout を 0 にした後は、期限を外すと停滞が終わらない | M-A8 C-4 の記述を M-A13 で訂正 |

### 11.3 測定

| # | 測定 | 結果 |
|---|---|---|
| M-A1 | macOS 手元 `npm test`（`eda0653`、alias 無し） | 340 passed / 14 skipped / 3 failed（T-A5, T-A6, T-A8: `cannot bind 127.0.0.2: EADDRNOTAVAIL`。A-20） |
| M-A2 | Linux 受け入れ 1 回目（`eda0653`。Colima VM 内 `node:22-bookworm-slim`、Node 22.23.3、aarch64、`git archive HEAD` を展開して `npm ci && npm test`） | 342 passed / 14 skipped / **1 failed**: T-A5 の最後の判定（変異の要求が keep-alive の接続を再利用し、接続数が増えない）。試験側の誤り → A-18 |
| M-A3 | Linux 受け入れ 2 回目（`7a8cf84`。同じ手順） | **343 passed / 14 skipped / 0 failed**（T-A1〜T-A18 を含む全件緑。27 ファイル、43 s。14 skipped は env で gate された既存の試験で、A の試験に skip は無い） |
| M-A5 | macOS 手元 `npm test`（`d569caa`、実装レビュー #1 の反映後、alias 無し） | 354 passed / 14 skipped / 3 failed（T-A5, T-A6, T-A8。A-20。28 ファイル） |
| M-A6 | Linux 受け入れ 3 回目（`d569caa`。同じ手順） | **357 passed / 14 skipped / 0 failed**（T-A1〜T-A20 の全件緑。28 ファイル、45 s。14 skipped は env で gate された `tests/wire/chat-crossimpl.test.ts` の 14 件で、A の試験に skip は無い） |
| M-A7 | T-A14 配線の変異（macOS、`d569caa`。12 経路。手順は M-A4 と同じ。経路 11 は受信 MPP の `getClient` を素の viem `http(rpcUrl)` に、経路 12 は能力の `client.request` をそのまま返す変異） | **12 / 12 検出**（下表の 11・12 行。`-t "MPP 1"` は経路 11・12 の試験名にも一致するので、経路 1 の変異の要約は `2 failed \| 2 passed`。落ちた 2 件は MPP 1 と送信 MPP 12） |
| M-A8 | 契約の変異（macOS、`1487f8d`。各 1 件ずつ元に戻す）: C-1 `oneDispatch` を外す → T-A21、C-2 challenge body の cancel を外す → T-A17 (c)(d)、C-3 RPC body 失敗の報告を外す → T-A17 (g)、C-4 RPC の応答全体の期限を外す → T-A17 (g) | **4 / 4 検出**: C-1 → T-A21 `1 failed`、C-2 → T-A17 (c)(d) `1 failed`（402 を書いた socket が 2 本閉じない）、C-3 → T-A17 (g) `2 failed`（受信・送信）、C-4 → T-A17 (g) `2 failed`（当時は viem の timeout が残っていたので、落ちた理由は停滞ではなく **AbortError の誤分類**。A-32、M-A13 で訂正）。1 回目の試行は `-t` の regex に括弧を含めて C-2 が 0 件実行（`25 skipped`）になったので、試験名の部分文字列で再実行した |
| M-A9 | macOS 手元 `npm test`（`1487f8d`、alias 無し） | 358 passed / 14 skipped / 3 failed（T-A5, T-A6, T-A8。A-20。28 ファイル） |
| M-A10 | Linux 受け入れ 4 回目（`1487f8d`。同じ手順） | **361 passed / 14 skipped / 0 failed**（T-A1〜T-A21 の全件緑。28 ファイル、45 s。14 skipped は env で gate された `tests/wire/chat-crossimpl.test.ts`） |
| M-A11 | T-A14 配線の変異（macOS、`1487f8d`。12 経路。M-A7 と同じ手順） | **12 / 12 検出**（内訳は M-A7 と同じ。経路 1 の `-t "MPP 1"` は 11・12 の試験名にも一致し `2 failed \| 2 passed`） |
| M-A12 | macOS 手元 `npm test`（`af0d74d`、alias 無し） | 361 passed / 14 skipped / 3 failed（T-A5, T-A6, T-A8。A-20。29 ファイル） |
| M-A13 | 契約の変異（macOS、`af0d74d`）: C-1〜C-4 を再測、C-5a 合成/実 x402 の早期 return の `discardBody` を外す → T-A17 (h)、C-5b MPP の早期 return の `discardBody` を外す（challenge の cancel は残す）→ T-A17 (h)。**C-4 の訂正**: viem の timeout が 0 なので、期限を外すと停滞は終わらず（g）が test timeout で落ちる（M-A8 の「誤分類で落ちる」から変わった） | **6 / 6 検出**: C-1 → T-A21 `1 failed`、C-2 → (c)(d) `1 failed`、C-3 → (g) `2 failed`（受信・送信）、C-4 → (g) `2 failed`（期限が無く停滞が終わらない）、C-5a → (h) `1 failed`、C-5b → (h) `1 failed` |
| M-A14 | Linux 受け入れ 5 回目（`af0d74d`。同じ手順） | **364 passed / 14 skipped / 0 failed**（T-A1〜T-A21 と `tests/unit/guarded-rpc.test.ts` の全件緑。29 ファイル、51 s。14 skipped は env で gate された `tests/wire/chat-crossimpl.test.ts`） |
| M-A15 | T-A14 配線の変異（macOS、`af0d74d`。12 経路） | **12 / 12 検出**（内訳は M-A7 と同じ） |
| M-A4 | T-A14 配線の変異（macOS、`eda0653`）。各 adapter の `transport.fetch` を素の `globalThis.fetch` に戻し（MPP は `Mppx.create` の `fetch` オプションを外して SDK 既定に落とす）、該当の T-A13 を 1 件ずつ `vitest -t` で実行。変異は毎回元に戻し、最後に `git diff --quiet -- src` で空を確認 | **10 / 10 検出**（下表） |

T-A14 の表（「落ちる」= その試験が 1 failed）:

| 変異（素の fetch に戻した配線） | 経路 | T-A13 の試験 | 結果 |
|---|---|---|---|
| MPP `createClient` の `fetch` オプションを外す | 1, 2, 3 | MPP 1 / MPP 2 / MPP 3 | 3 件とも落ちる（例: MPP 1 は「promise resolved `[{ scheme: 'tempo/charge', … }]` instead of rejecting」= challenge が素の fetch で読めてしまう） |
| 実 x402 `getChallenge` | 4, 5 | 実 x402 4 / 実 x402 5 | 落ちる |
| 実 x402 有料要求 | 6 | 実 x402 6 | 落ちる |
| 合成 x402 `readChallenge` | 7 | 合成 x402 7 | 落ちる |
| 合成 x402 `pay` | 8 | 合成 x402 8 | 落ちる |
| 受信 subetha `post` | 9 | 受信 subetha 9 | 落ちる |
| 受信 x402 `post` | 10 | 受信 x402 10 | 落ちる |
| 受信 MPP `getClient` を素の viem `http(rpcUrl)` に（M-A7） | 11 | 受信 MPP 11 | 落ちる |
| 送信 MPP `guardedRpcRequestOf` が能力の `client.request` をそのまま返す（M-A7） | 12 | 送信 MPP 12 | 落ちる |

同じ手順の 1 回目は結果の読み取り（vitest の要約行の形: 単体の `-t` 実行では `N failed | M skipped` で `passed` が出ない）を誤って
「全件検出されず」と出た。読み取りを直して再実行した結果が上の表（手順の誤りであり、試験・実装の変更は無い）。

### 11.4 受け入れの判定

- §4 の T-A1〜T-A21: Linux で全件緑（M-A3 は実装レビュー #1 前の T-A1〜T-A18、M-A6 は #1 反映後、M-A10 は #2 反映後、M-A14 は #3 反映後の全件）。macOS は A-20 の 3 件が前提検査で失敗するのが正しい挙動。
- 公開結果（§3.5 の表）は既存の wire テストが変わらず通ることで確認（`tests/wire/*` は `allowLoopback: true` の transport を渡すだけの変更）。

## 12. 実装レビュー #1（`d41a610`、2026-10-03、`gpt-6-astra`）: **REJECT** → 反映 `d569caa`

レビューは read-only で実装・試験・設計 §11・SDK（mppx / @x402 / undici 8.11.2 / viem）を読み、Node の probe で表の一致・正規化・
未報告の診断・同梱 fetch の h2 既定を確かめた（vitest の実行は sandbox の `EPERM` で不可。Linux 受け入れと変異の記録は「未検証」扱い）。

| # | 指摘 | 判定 | 反映 |
|---|---|---|---|
| 1 | **High** undici 8 は既定で h2 を許し、`REFUSED_STREAM` / `GOAWAY` で要求を自動再送する。credential 付き要求の「1 回だけ送る」契約に反する | 正しい（A-21 で確認） | `allowH2: false`（§3.3-8、D-8）。T-A19 で ALPN の結果と対照を観測 |
| 2 | **High** 10 経路に Router 発の MPP JSON-RPC（受信 `tempo.charge` の既定 client、送信の能力の `http(rpcUrl)`）が無い。RPC の redirect や namespace 内への解決は A の範囲 | 正しい | 経路 11・12 を追加（§3.5、D-7、`src/net/guarded-rpc.ts`）。T-A13 に 11・12（実 SDK を push credential で駆動、HTTP の RPC fixture）、I-6 に viem `http` の import 禁止、T-A14 に 2 行 |
| 3 | **Medium** `composeRails` の受信の包みが `verify` / `settle` の第 3 引数を落とし、本番では `route=-` になる | 正しい | 包みが context を渡す。compose の単体に「包み越しの帰属」（T-A18） |
| 4 | **Medium** 受け入れの欠け: T-A5 の囮の `catch` で前提の失敗を飲む / T-A7 が vetting 側の spy で同語反復 / T-A17 (c)(d) が `readChallenge` で接続解放を見ない / 有料応答の切断が x402 に無い / 受信 verify の試験が実は challenge / `dns_failed`・abort・公開結果の秘匿が無い | 正しい | §4 の追記のとおり全て反映（T-A5 厳格化、T-A7 単体 + undici spy、T-A16 socket close、T-A17 pay_challenge + `closed` + `discardBody` 契約 + x402 切断 + 受信 verify、`dns_failed` / `aborted`、`expectSilent`） |
| 5 | **Medium** 自アドレスの列挙が失敗すると例外が transport から素通りし、報告 0 | 正しい | 判定の例外を `transport_failed` に正規化して 1 回報告（§3.3-9、D-9）。T-A20 |

付随の指摘: `tls.ca` は既定の信頼ストアを置き換える（§5 に明記）、`src/client/` の除外は妥当、no-direct-fetch の走査は補助的（lint ではない）、
T-A18 は「段階の異なる同時実行」までは見ていない（pay 2 本の同時実行で `pay_challenge` → `pay` の帰属は見ている。追加は見送り）。

## 13. 実装レビュー #2（`ec1465a`、2026-10-03、`gpt-6-astra`）: **REJECT** → 反映 `1487f8d`

#1 の 5 件は「3・4a・4b・4(T-A16)・4e/f・4(受信 verify)・4(dns/abort)・5 = fixed、1・2・4c/d・4(秘匿) = partially fixed」と評価された。
レビュアは MockAgent の probe で 421 の再送（同じ Authorization の GET が 2 回）、実際にビルドした `guardedRpcTransport` で RPC body の
切断（報告 0）と停滞（期限の 5 倍待っても未完）を再現した。

| # | 指摘 | 判定 | 反映 |
|---|---|---|---|
| 1 | **High** undici fetch の 421 再試行で credential 付き要求が 2 度送られる（h2 とは無関係。`redirect: "error"` では防げない） | 正しい（A-27） | 1 fetch 1 dispatch の interceptor（§3.3-10、D-10）。T-A21 と対照。M-A8 C-1 |
| 2 | **Medium** RPC の body の失敗が未報告、body の読み取りに期限が無い（viem は headers で timeout を解除） | 正しい（A-28） | transport が body を読み切り、応答全体の期限と上限、1 回の報告（§3.5、D-11）。T-A17 (g)、M-A8 C-3 / C-4。受信は `rpcTimeoutMs` |
| 3 | **Medium** T-A17 (c)(d) の `closed >= 2` は観測用 `/calls` と有料応答の socket でも満たせる | 正しい | fixture が応答の種類を socket に付けて種類別に数える。判定は 402 を書いた socket が 2 本閉じること。M-A8 C-2 で cancel を外すと落ちることを測る |
| 4 | **Medium** 送信の作り直しが `fetchOptions`（認証ヘッダ）と装飾 transport の意味を捨てる | 正しい | `fetchOptions` 等を引き継ぐ。対象は素の `http`（`type`・`key`）だけ、それ以外の実鍵は fail closed（§3.5、D-12） |

付随: (b) の試験名を「createOffer（challenge）」に直す、`expectSilent` を pay の公開結果すべてに、受信 RPC の同時実行の帰属（T-A18）。
レビュアの確認事項: JSON-RPC の目録は現構成で完全（remote fee payer / `withFeePayer` は未設定で到達不能）、x402 署名はローカル、
`src/client/` の除外は妥当、AsyncLocalStorage の帰属は追跡した経路で信頼できる、`useH2c` は明示 true のみ、h1 client は書き込んだ要求を再送しない。

## 14. 実装レビュー #3（`34dc48d`、2026-10-03、`gpt-6-astra`）: **REJECT** → 反映 `af0d74d`

#2 の 4 件は「421 = fixed、RPC body = partially fixed（分類）、socket 解放の判定 = fixed、fetchOptions = fixed（文書化した範囲で）」。
レビュアは MockAgent の probe で guarded 1 要求 / 対照 2 要求を再現し、viem の timeout と transport の期限の競合を実測した。

| # | 指摘 | 判定 | 反映 |
|---|---|---|---|
| 1 | **Medium** viem のタイマーは `fetchFn` より前に始まるので、「期限 + 250 ms」では順序を保証できず、`aborted` に化ける | 正しい（A-30） | viem の timeout を 0 に（D-13）。`tests/unit/guarded-rpc.test.ts` |
| 2 | **Medium** 読まずに終わる応答（MPP の receipt 不一致・502・その他、合成 x402 の 402 以外の challenge と 200 以外の有料応答、実 x402 の 402 以外の challenge）が body を捨てず、接続が要求の timeout まで残る | 正しい | 早期 return / throw の全経路で `discardBody`（D-14）。T-A17 (h)、M-A13 C-5 |
| 3 | **Low** 記述の過大: M-A8 C-4 の検出理由は誤分類、送信側 (g) は停滞のみ、(c)(d) と同時実行の pay に `expectSilent` が無い | 正しい | A-32 と M-A8 の訂正、(g) 送信側に切断、`expectSilent` を追加 |

付随: 読取系 RPC は能力の `retryCount` に従って再送し得る（§5 に明記）。JSON-RPC 目録・h1 client・`useH2c`・AsyncLocalStorage・`src/client/` の
評価は #2 と同じ。

## 15. 実装レビュー #4（`458efe3`、2026-10-03、`gpt-6-astra`）: **APPROVE** → A の実装受け入れ

#3 の 3 件は**すべて fixed**（viem の timeout 0 と期限の所有、早期 return の discard、記述と判定の訂正）。新規の指摘なし。
レビュアは実際の RPC wrapper と遅い直列化・停滞した応答の probe で `viemTimeout: 0`、fetch 1 回、`TimeoutError` の報告を再現し、
12 経路の応答の所有（読むか捨てるか）を経路ごとに確認した。読取系 RPC の再送（能力の `retryCount`、確認の polling）は支払いの再送とは別と整理。
viem の size 上限で buffered Response が未読のまま拒まれる場合があるが、上流の接続は既に終わっているので対象外。
`tsc` は通過、vitest は sandbox の `EPERM` で未実行（Linux 受け入れと変異の記録は著者報告のまま）。

### 15.1 A の受け入れの判定

- 実装: `456cc0b` → `eda0653` → `7a8cf84` → `d569caa` → `1487f8d` → `af0d74d`（コード・試験）。設計の最終は本 commit。
- Linux 受け入れ（§4）: `af0d74d` で **364 passed / 14 skipped / 0 failed**（M-A14）。macOS は A-20 の 3 件が前提で失敗するのが正しい。
- 配線の変異 12 / 12、契約の変異 6 / 6 が検出（M-A13、M-A15）。
- 実装レビュー: #1〜#3 REJECT（各回の指摘はすべて反映して記録）、#4 **APPROVE**。

### 15.2 release gate（要件 §9）の状態

- **A**: 受け入れ完了（本 commit）。namespace 内の宛先の拒否と解決済みアドレスへの接続固定、12 経路、HTTP/1.1 のみ・1 fetch 1 dispatch、
  RPC の body と期限の所有、診断の 1 回報告。
- **B**: 運用手順と成果物は `ssrf-egress-design.md` §26.21 でレビュア承認済み。**本番（AL2023）での受け入れ実行は未了**（運用者の作業。
  この機械には AWS の資格情報が無い）。
- したがって「AI が上流 URL を指定する」機能の release gate（B と A の**両方**の受け入れ）は、**B の本番受け入れが済むまで閉じたまま**。
  現在の Router（運用者が設定した固定 route）はこの gate の対象外で、A の配線は本番に入れられる（Node ≥ 22.19.0、`undici@8.11.2`）。

## 16. 本番への投入（2026-10-05）

A を含むイメージ（commit `42414d2`、Node 22.23.3、`undici` 8.11.2）を、B の受け入れを通した AL2023 host（`ssrf-egress-design.md` §27）で
`docker build --network host` によりビルドし、本番の Router を入れ替えた。

| 確認 | 結果 |
|---|---|
| 試し起動（別の空 journal、port 非公開） | `healthy`、mode / label は real |
| 入れ替え（入口を閉じ、旧コンテナは停止・別名で保持、同じ引数と journal） | `healthy`。開いている journal は `journal.ndjson`、入れ替え前の写しと先頭 46825 バイトが一致 |
| `subetha-egress-verify`（既定、入口を閉じたまま） | 68 passed / 0 failed |
| 外から | `/healthz`、MCP の route 一覧 |
| 両経路の quote（資金は動かない） | `md-mpp-eth-snapshot`（上流 MPP の challenge）、`md-x402-eth-snapshot`（上流 x402 の challenge）とも成功 = 経路 1・4 が本番の実上流に対して guarded transport 越しに通る |
| 運用者向けの `outbound transport` 行 | 起動から確認時点まで 0 件 |

実購入（2026-10-05、testnet、使い捨ての payer。owner 承認済み）: 両経路とも **delivered**、`outbound transport` 行は 0 件のまま。

| 経路 | 受信 | 送信 | 結果 |
|---|---|---|---|
| `md-mpp-eth-snapshot` | x402（Base Sepolia USDC 10000。facilitator の verify / settle = 経路 10） | MPP（Tempo pathUSD。challenge・有料要求・能力の RPC = 経路 1〜3、12） | delivered（paymentId `f801cb73-8251-49f4-867d-edc171b13b98`） |
| `md-x402-eth-snapshot` | MPP（Tempo pathUSD 10000、tx `0xa38ff75b8ba890138f109b0898fb79e83e014376e0c49be97991df2b08237bfc`。SDK の receipt 照合 RPC = 経路 11） | x402（Base Sepolia USDC。challenge・有料要求 = 経路 4〜6） | delivered（paymentId `beefbeff-8093-432a-b20b-5c6bf0772000`） |

本番で通っていないのは、この構成で使っていない経路（合成 x402 の 7・8、受信 subetha の 9）だけである。
これで要件 §9 の release gate（B と A の両方の受け入れ）は、本番の構成として満たされた。
