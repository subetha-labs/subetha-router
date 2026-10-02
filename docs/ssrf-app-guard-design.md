# SSRF 防御 A（アプリ側: namespace 内の宛先の拒否と接続固定）— 設計 v1

要件は `ssrf-requirements.md` §7.3（FR-A1〜A6）、§7.4（FR-C1/C2）、§8.3（FR-A7）、§8.4（FR-C1'/C2'）、§9（INV-1'' の分担）で確定済み。
B（host 側 egress 制御、`ssrf-egress-design.md`）は実装フェーズをレビュア承認済み（§26.21）。本書は A の設計。

## 1. 範囲

| | 内容 |
|---|---|
| 守る宛先 | **namespace を出ない宛先**: `127.0.0.0/8`、`::1`、コンテナ自身のアドレス、`127.0.0.11`（要件 §9）。加えて B と同じ IANA special-purpose 表（深層防御。要件 §9 は任意としているが、FR-A1 の最低限リストを満たすために入れる） |
| 守る経路 | Router から**外へ出る HTTP 要求のすべて**（FR-A6/A7 の 10 経路: MPP 送信 3、実 x402 送信 3、合成 x402 送信 2、受信 facilitator 2） |
| 守り方 | **fetch 前の分類**（解決した全アドレスの 1 つでも禁止なら拒否 = FR-A2）と、**検査済みアドレスへの接続固定**（FR-A3/A7。transport が自前で名前解決しない） |
| 守らないもの | 公開アドレス上の proxy の先（要件 §9）。namespace を出るパケットの最終的な遮断は B（A の表は B と同じだが、B が正） |
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

### 3.2 解決と「いずれか」規則（FR-A2、FR-A3）

`resolveAndVet(hostname)`: リテラルなら解決せず分類。名前なら `dns.lookup(name, { all: true, verbatim: true })` で **A/AAAA 両方**を取る。
空・エラーは `dns_failed`。返った**全アドレスを分類し、1 つでも denied なら `destination_blocked`**（混在 DNS の Provider は意図的に失敗 = FR-A2）。
全部 allowed なら、そのリストが **vetted**（固定先）。解決は要求ごとに 1 回（キャッシュしない）。

### 3.3 接続固定の transport（FR-A3、FR-A7）

`src/net/guarded-fetch.ts`: `createGuardedFetch(options): GuardedFetch`（`(url, init) => Promise<Response>`）。要求ごとに:

1. URL を解析。`http:` / `https:` 以外、userinfo 付き、は `destination_blocked`。
2. §3.2 で vetted を得る（ここで止まれば**接続は 1 本も作らない** = FR-A4）。
3. `new undici.Agent({ connect: { lookup: vettedLookup } })` を作る。`vettedLookup` はホスト名に関わらず **vetted だけ**を返す
   （`all: true` 形式と単一形式の両方に対応）。TLS の servername と `Host` は URL のホスト名のまま（事実 A-5）。
4. `undici.fetch(url, { ...init, redirect: "error", dispatcher })`。呼び出し側が `redirect` を変えても **`"error"` で上書き**する。
5. `finally` で `agent.close()`（要求ごとに Agent を作り捨てる。接続の再利用で古い宛先に繋がることが無い。要求量は小さい）。

全接続・全 fallback が vetted の中に閉じる根拠は事実 A-3/A-4。mppx 経由（`rawFetch`）も同じ関数を受け取る（事実 A-1）ので、SDK が内部で
`globalThis.fetch` に逃げない限り到達する。到達の証明は §4 の sabotage テスト（各 adapter で拒否が効き、fixture に要求が 0）。

### 3.4 fixture 例外（FR-C2、FR-C2'）

`createGuardedFetch({ allowLoopback })`。**`true` にできるのは組み立て側（`composeRails`）だけ**で、次の 2 つに限る:

- `ROUTER_ADAPTER_MODE=synthetic`（合成レール。`assertLoopbackUrl` が既に loopback 以外を拒む）
- 署名しない試験用能力（`capability.kind === "non-signing-fixture"` 等、fixture であることを**能力が明示**するもの）

`allowLoopback` が許すのは **loopback だけ**（`127.0.0.0/8`、`::1`）。他の禁止範囲と自アドレスは fixture でも拒否。env / 設定ファイルからは
変えられない（本番の強制は常に有効）。実能力で組み立てた adapter は常に `false`。

### 3.5 10 経路への配線（FR-A6、FR-A7）

| 経路 | 配線 |
|---|---|
| MPP 送信（`rawFetch` 3） | `createMppOutbound({ transport })` → `Mppx.create({ fetch: transport, polyfill: false, ... })` |
| 実 x402 送信（`getChallenge` + 2） | `createX402Outbound({ transport })` → `fetch` を `transport` に置換 |
| 合成 x402 送信（2） | `createSyntheticX402Outbound({ transport })` → 同上 |
| 受信 subetha / x402（`post` 各 1） | `createSubethaInbound({ transport })` / `createX402Inbound({ transport })` |

`transport` は**必須**オプション（省略で `globalThis.fetch` に落ちない）。`composeRails` が `allowLoopback` を決めて 1 つ作り、全 adapter に渡す。
`warnIfInternalUpstream`（起動時の警告）は残す（起動時の文字列検査であって強制ではない旨を注記）。

### 3.6 診断（FR-C1、FR-C1'）

transport は `TransportError` を投げ、`code` は固定集合 `destination_blocked` / `dns_failed` / `connect_failed` / `upstream_timeout` / `transport_failed`。
A は接続前に拒否するので `destination_blocked` を**確定**として出せる（B の「タイムアウトからの推定禁止」とは別）。
運用者向けログ（adapter の `note`）: `outbound transport <code> route=<routeId> policy=<POLICY_VERSION>`。**アドレス・ホスト名・URL は出さない**。
公開応答と journal は**現状のまま**（`pay` の例外は `destination_pay_unknown`、quote 時の例外は既存の失敗経路）。新しい公開コードは足さない。

### 3.7 依存

`undici@8.11.2` を **exact** で追加（この repo の慣行。Node 22 対応）。型は undici の `Response` を境界で `globalThis.Response` に写す
（本体は `status` / `headers` / `text` / `json` しか使わない）。

## 4. 受け入れ（実装フェーズの product test。vitest、実 TCP）

| ID | 試験 | 合格条件 |
|---|---|---|
| T-A1 | ポリシー表の単体: B の `DENY4`/`DENY6` を `deploy/egress/subetha-egress` から読み、A の表と**集合として一致** | 差分 0 |
| T-A2 | 分類の単体: 各範囲の代表値、境界値、`::ffff:127.0.0.1` / `::ffff:8.8.8.8`、NAT64、`0.0.0.0` / `::`、不正文字列、注入した自アドレス（公開 IP でも `own_address`） | 期待どおりの reason |
| T-A3 | 固定の証明: 注入した lookup が `provider.test` → `127.0.0.1`（fixture）。`allowLoopback: true` で `200`、fixture が見た `Host` は `provider.test:<port>`、lookup 呼び出しは 1 回 | FR-A3 |
| T-A4 | DNS に落ちない証明: lookup が誰も聞いていないアドレスを返す → 失敗（`connect_failed` / `upstream_timeout`）、fixture の要求 0 | FR-A3 |
| T-A5 | 混在: lookup が `[公開 IP, 127.0.0.1]` を返し `allowLoopback: false` → `destination_blocked`、要求 0 | FR-A2 |
| T-A6 | リテラル loopback / 自アドレス / 各禁止範囲の URL を `allowLoopback: false` で → `destination_blocked`、要求 0 | FR-A1 |
| T-A7 | `redirect: "follow"` を渡しても 302 で失敗し 2 本目が出ない | §3.3 |
| T-A8 | **到達の sabotage**（FR-A7）: 5 つの adapter それぞれを `allowLoopback: false` の transport で組み立て、loopback の fixture へ → 全経路が `destination_blocked`、fixture の要求 0。同じ fixture で `true` なら成功（既存テストが通る） | 各 adapter |
| T-A9 | 運用者ログの形: `outbound transport destination_blocked route=... policy=...` にアドレスが含まれない | FR-C1 |
| T-A10 | `composeRails`: real は `allowLoopback: false`、synthetic と non-signing fixture は `true`（env で変えられない） | FR-C2' |

既存の wire テスト（`tests/wire/*`）は fixture が loopback なので、transport を `allowLoopback: true` で渡すように更新する。

## 5. 残す判断・注意

- 自アドレスは判定のたびに読む（起動後に足されたアドレスも拒否）。読めなければ fail closed（`transport_failed`）。
- 解決結果はキャッシュしない。同じ名前が要求ごとに別アドレスに解決されても、**その要求の接続はその要求で検査した集合に閉じる**（rebinding の
  利得は「検査と接続の間」に限られ、それは無い）。
- `undici` の `Agent` を要求ごとに作る設計は性能より単純さを取った。要求量が増えたら vetted 集合をキーにした再利用を検討する。
- B と表を二重に持つ。表の更新は B（`subetha-egress`）側を正とし、T-A1 が差分を検出する。
