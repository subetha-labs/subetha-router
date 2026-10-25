# 秘匿購入の proxy 型 TLS（増分 v1.5）設計 v2.1

要件: `docs/zktls-router-proxy-requirements.md` v3.2（以下「要件」）。基礎の設計 `docs/zktls-router-design.md` v5.1（以下「基礎設計」）の上に足す。
対象 worktree `subetha-router/zktls-proxy-20261026`（branch `task/zktls-proxy`）。設計フェーズの成果物で、実装は含まない。
v1 は Codex の独立レビュー（`.claude_workflow/local/proxy-design-review1.md`、REJECT、blocking 2・should 5・minor 2）を受けて v2 に、v2 の再レビュー（`proxy-design-review2.md`、APPROVE WITH CHANGES、should 2・minor 1）を受けて v2.1 に改めた（§15 に対応表）。
lab の `delivery` の proxy 対応（要件 §5 の LX-1〜LX-7）は依頼済みで回答待ち（2026-10-26）。本書は LX の名前と意味をそのまま前提にし、lab が形を変えた場合は §12 の手順で追従する。

## 1. 役割とシーケンス（proxy 型。MPC 型は基礎設計 §1 のまま）

```
Payer (executor = Proxy-TLS prover)       Router (inbound + issuer + Verifier)                        Provider
1〜3 は基礎設計と同じ（quote の private 欄に tls.mode = "proxy" と開示 3 つ）
4 POST /v1/private/purchases
                                          ─ 型の照合（記録の型 = 設定の型。§8.1）→ 容量の予約・残高・宛先ホストの枠（既存）
                                          ─ ★ pin: host を解決 → 宛先の方針で全回答を検査 → 1 つ固定 → 宛先アドレスの枠を 1 つ取る（§4。受信 verify の前）
                                          ─ 探りの再照合（固定した宛先へ。枠は pin のものを使う）→ 受信 verify → settle（既存）
                                          ─ 再照合（2 回目、固定した宛先へ）・承認期限・受信の識別子（既存）
                                          ─ 発行予約（journal。proxy は固定した宛先を同じ行に書く）
                                          ─ issueCredential → ヘッダ検査 → 寿命 → release → 作業ディレクトリ
                                          ─ verifier-serve --tls-mode proxy --provider-addr <固定した宛先> --max-relay-*（§5）
                                          ◀─ handover（既存の形。verifier.address など）
5 payer-finalize-order（既存）
6 executor-session --tls-mode proxy ──▶ Verifier ── サーバー名を照合 → TCP 接続（固定した宛先だけ）──▶ Provider
                 ◀════ TLS（鍵は Payer だけ。暗号文は Verifier が中継・記録）════════════════════▶
                                          ─ record.json（tls_mode: "proxy"、provider_addr）または failure.json（§6）
7〜10 は基礎設計と同じ（executor-prove → attest → record → payer-decrypt）
```

Router が新たに得るのは TLS の暗号文（復号できない）・方向ごとの長さと時刻・Provider の IP。暗号文はどこにも書かない（§10）。

## 2. 設定（`src/config.ts`）

- `PrivateConfig` に `readonly mpcProfiles: readonly string[]` を足す。`parsePrivate` は `raw.mpcProfiles` を読み、省略時は `[]`。配列で、各要素が `profiles` に含まれる
  空でない文字列で、重複が無いこと（違えば `ConfigError`: `private.mpcProfiles must be a subset of private.profiles without repeats`）。
  **既定値の表 `DEFAULT_PRIVATE_CONFIG` には足さない**（省略の正規化は `parsePrivate` の中で行う。要件 FR-X00 の「既定値の表の検査を弱めない」）。
- `export function tlsModeOf(config: PrivateConfig, profileId: string): "mpc" | "proxy"` = `config.mpcProfiles.includes(profileId) ? "mpc" : "proxy"`。
- `privateAuthoritativeTermsOf(config, profileId, rail, trust)` は、proxy 型のときだけ末尾に
  `tlsMode: "proxy", proxyRelay: { maxSentBytes: PROXY_RELAY_LIMITS.maxSentBytes, maxRecvBytes: PROXY_RELAY_LIMITS.maxRecvBytes }` を足す（要件 FR-X03 の名前）。
  MPC 型のときは今と同じオブジェクトを返す（キーも順序も同じ。`mpcProfiles` の欄は入れない）。これで MPC 型の指紋は今と同じ、型の変更は両方向で指紋が変わる。
- `PROXY_RELAY_LIMITS`（`src/private/proxy.ts` の定数、§5）: 中継の上限は設定ではなく定数（変えるときは指紋が変わる）。

## 3. 能力の門（要件 FR-X14、`src/private/verifier.ts` と `src/main.ts`）

- `export async function readCapabilities(deliveryBin: string): Promise<{ tlsModes: readonly ("mpc" | "proxy")[] } | undefined>`:
  `spawn(deliveryBin, ["capabilities"], { stdio: ["ignore", "pipe", "ignore"], env: { PATH } })`（**stderr は捨てる**。読まないので大きさを問わない）。stdout を
  256 B まで読み、257 B 目が来たら子を SIGKILL して `undefined`。5 s で SIGKILL して `undefined`。終了コード 0 で、stdout が JSON で**ちょうど** `{"tls_modes": [...]}`
  （他のキー無し、要素は `"mpc"`/`"proxy"` だけ、重複無し）のときだけ値を返す。それ以外（非 0・signal・タイムアウト・256 B 超・形違い・JSON でない）は `undefined`。
- `main.ts` の秘匿購入の配線で、sha256 の照合の**後**に: `privateConfig.profiles.some((id) => tlsModeOf(privateConfig, id) === "proxy")` なら `readCapabilities` を呼び、
  `undefined` か `proxy` を含まなければ `ConfigError("private.deliveryBin does not support proxy mode; list every private profile in private.mpcProfiles to run MPC only")`。
  全プロファイルが MPC 型なら呼ばない（今と同じ起動）。`main.ts` の門は `RouterCapabilities.readCapabilitiesForTest?`（試験だけが渡す。呼ばれた回数を数える）で差し替えられる。
- 試験の偽物: `readCapabilities` の単体試験は、試験が一時ディレクトリに**1 つずつ書く小さな実行ファイル**（`#!/bin/sh` で固定の出力・非 0・sleep・大きな出力・stderr の大量出力）
  を使う（Router は子に最小の env しか渡さないので、env での切り替えはしない。`fake-delivery.mjs` の作業ディレクトリの制御ファイルの方針と同じ理由）。
  `fake-delivery.mjs` には `capabilities` の分岐を足し、固定で `{"tls_modes":["mpc","proxy"]}` を出す（wire の偽物の構成と core の試験用）。

## 4. 宛先の固定（要件 FR-X05・X06、`src/net/guarded-fetch.ts`・`src/core/dynamic.ts`・`src/core/private.ts`）

### 4.1 transport の口（追加のみ。既存の呼び出しは不変）
- `TransportContext` に任意の欄 `pin?: TransportPin` を足す。`TransportPin = { host: string; address: ParsedAddress; dial?: { host: string; port: number } }`（`ParsedAddress` は
  `destination-policy.ts` の正規化済みの値。`dial` は pin を作ったときの `dialForTest` の答え。本番は無い）。`TransportPin` は `pinDestination` だけが作る内部の値で、
  要求・journal・復元した JSON から組まない（core は `pins` の Map の値をそのまま渡すだけ）。
  **`pin` の無い呼び出しの挙動は 1 つも変えない。**
- `GuardedTransport` に任意の能力 `pinDestination?(host: string, context: TransportContext): Promise<PinnedDestination>` を足す（`options.dns` があるとき = 動的 transport だけ）:
  1. 既存の `vet(host, context)` をそのまま呼ぶ（名前なら `resolveBounded`（期限 3 s・同時数 16）で**全回答**、1 つでも `classifyAddress` で禁止なら `destination_blocked`、
     0 件・失敗は `dns_failed`）。方針は動的 transport の `allowLoopback: false` と `interfaces`（Router 自身のアドレス `own_address`）。**URL・ホスト名の deny list
     （`parseUpstreamUrl`）は pin の前に購入の既存の段（`dynamic.ts` の upstream の検査）で済んでいる**（pin は名前の deny list を見ない。§12 の試験も購入の経路で行う）。
  2. 選び方: 検査済みの回答のうち、**解決の順で最初の IPv4**、無ければ最初の IPv6（決定的。IPv4-mapped IPv6 は `parseAddress` が IPv4 に正規化する）。
  3. 枠: `options.admit?.([chosen.text], context)`。`undefined` なら `TransportError("admission_refused")`。**これがこの購入の宛先アドレスの枠の全部**（§4.3）。
  4. 接続先: `dialForTest` があれば `dialForTest({hostname: host, port: 443})`。`undefined` を返したら `{host: chosen.text, port: 443}`、値を返したらその host と port
     （試験の loopback の fixture の任意のポート）。`dialForTest` が例外を投げたら、3 の枠を返してから `TransportError("connect_failed")`。
  5. 戻り値 `PinnedDestination = { pin: TransportPin; vettedAddress: string; dialAddr: string; release(): void }`。`dialAddr` は `host:port`（IPv6 は `[x::y]:port`）。
     `release` は冪等。例外は `TransportError` だけ（宛先を含まない固定文）。4・5 のどこで失敗しても 3 の枠は返す。
- `fetch`（`run`）は `context.pin` があり、かつ `context.pin.host === url.hostname` のときだけ: `vet` を呼ばず `vetted = [context.pin.address]` とし、**`admit` を呼ばない**
  （枠は pin が持っている）。試験の差し替えは **`dialForTest` を呼び直さず** `context.pin.dial` を使う（`dial` が無ければ差し替えない）。これで pin・2 回の探り・Verifier の
  接続先は同じ。それ以外の検査（scheme・userinfo・h2 無し・1 回の dispatch・redirect の拒否）は同じ。host が違う要求（RPC 等）は今と同じ。

### 4.2 段の位置（受信 verify の前）
- `dynamic.ts` の `purchaseWithHost` の**先頭**（宛先ホストの枠 `admitHost` の内側、最初の探り `readOffers` の前）で、秘匿購入のときだけ private の依存
  `pinBeforeSettle(intent, capacityLease): Promise<{ok: true} | {ok: false; code: "private_proxy_dial_refused"}>`（新、async）を呼ぶ。`admitHost` の後に置くので、
  ホストの枠と名前解決の順序（DNS の前にホストの枠）は既存のまま。
- `pinBeforeSettle` は `priv.tlsMode === "proxy"` のときだけ中身がある（MPC 型は即座に ok、何も呼ばない）: `options.pinDestination(priv.target.host, {operation: "private_proxy_pin", routeId})`
  （`main.ts` が動的 transport の `pinDestination` を渡す。proxy 型のプロファイルがあるのに渡されていなければ `createPrivateCore` が例外）。成功なら `pins.set(paymentId, pinned)`。
  失敗 → `awaiting("private_proxy_dial_refused")`（`awaiting_payment`。**受信 verify・settle を呼ばない**。容量は既存の `finally` が返す）。
  x402 受信では資金は動かない。burn-sale 受信は Payer の burn が purchase の前に済んでおり、基礎設計どおり settle の前の拒否は返金しない（既存の開示の範囲）。
- 探りの引き継ぎ: private の `outboundFor(intent).readChallenge` と、`deliverInner` の 2 回目の再照合は、`pins.get(paymentId)?.pin` を
  `rail.discover(profileId, target, { pin })` で渡す。`PrivateOutboundRail.discover` に任意の第 3 引数 `options?: { pin?: TransportPin }` を足し、x402 の
  `createX402ChallengeReader.getChallenge(target, ctx)` と MPP の `readCandidates` が `ctx` に `pin` を載せて `transport.fetch` に渡す（MPC 型・動的購入の呼び出しは引数が無いので不変）。
  これで pin の後の名前解決は 0 回、宛先アドレスの枠は購入につき 1 つ（探りは pin の枠の中）。
- 発行予約: `deliverInner` は `pins.get(paymentId)` を読み、proxy 型でこれが無ければ `undelivered("private_proxy_dial_refused")`（予約の前。通常は起きない）。あれば
  `store.reservePrivateIssuance(paymentId, intentSha256, inboundIdentity, { providerAddr: pinned.dialAddr, vettedAddress: pinned.vettedAddress })`。予約の行の patch に
  `proxy` 欄を足すのは proxy 型だけ。予約の成功の後に **`store.byPaymentId(paymentId)` を読み直し**、`reservation.proxy` が pin の値と一致することを確かめ、
  以後（serve の引数・束縛）はこの読み直した記録を使う（`deliverInner` の先頭で取った `priv` は予約の前の写しで `reservation` を持たない）。一致しなければ `unknown("private_verifier_unavailable")`。
- 再起動: settle の後・予約の前の購入は基礎要件 FR-Z25 (i) で `paid_undelivered` になり再開しないので、pin の復元は要らない。予約の後は journal の `proxy` 欄を使う。

### 4.3 宛先アドレスの枠の所有と返却（網の資源。成果物の容量とは別）
- **所有の受け渡し**: pin の枠は、容量の予約（`CapacityLease`）と同じく、まず dynamic core の購入が持ち、`dynamic.ts` で容量を private に渡す点（`privateLease.transfer()`、
  `deliver` を呼ぶ所）で一緒に private core に移る。`dynamic.ts` の段 2' の `finally` は、容量と同じ条件（`!transferred` = まだ dynamic core が持っている）のときだけ
  `options.private.releasePin(paymentId)` を呼ぶ（handover の後の `finally` では呼ばない）。
- `pins: Map<paymentId, PinnedDestination>` の項目は `releasePin(paymentId)`（冪等: `get` → `delete` → `release()`）で返す。成果物を残す出口（journal の追記の失敗で
  `persistenceLost()` する出口を含む）でも、**子が居なければ枠は返す**。private core が持った後に返す場所:
  1. `deliver()`（`deliverInner` の包み）: 結果が `awaiting_session`（子が起動して handover した）以外なら、すべての出口（`undelivered`・`unknown`・persistence の失敗・例外）で返す。
     `serve` の失敗と handover の前に子を止めた出口もここに含まれる。
  2. 子の終了: `superviseSession` の `child.exited` の解決の続き（**`withPayment` を待つ前に同期で**、§6 の latch の更新・timer の取り消しと同じ場所）で返す。lock を待つ間は持たない。
  3. `close()`（drain）: 既存の 2 段の子の停止（進行中の処理を待ってから子を止める）の**後**に、残った項目を全部返す。
- `scheduleAt` は取り消しの handle を返すように変え（timer の登録表から外す。刻んで待つ再登録も止める）、§6 の timer の取り消しはこれを使う。
- 試験（§12）: (a) handover の後、子が生きている間は宛先アドレスの使用数が 1、(b) 子の終了で payment の lock を握ったままでも 0 に戻る、(c) 下の `release` は購入につき
  ちょうど 1 回、(d) settle に至らない各出口・`deliver` の各出口・`close()` の後に 0。

## 5. Verifier の起動（`src/private/verifier.ts`、`ServeArgs`）
- `ServeArgs` に `proxy?: { providerAddr: string }` を足す。ある場合だけ引数に
  `--tls-mode proxy --provider-addr <providerAddr> --max-relay-sent <PROXY_RELAY_LIMITS.maxSentBytes> --max-relay-recv <PROXY_RELAY_LIMITS.maxRecvBytes>` を足す（LX-1・LX-4）。
  MPC 型の引数は今と同じ（`--tls-mode` を渡さない）。
- `PROXY_RELAY_LIMITS = { maxSentBytes: 16_384, maxRecvBytes: 65_536 }`（`src/private/proxy.ts`）。根拠: Payer→Provider は要求の上限 4,096 B + TLS 1.2 の
  ClientHello・ClientKeyExchange・ChangeCipherSpec・Finished（合わせて 2 KiB 未満が通常）と記録の付加（AES-GCM で 1 記録 29 B）。Provider→Payer は lab の受信 transcript の
  上限 16 KiB + 証明書の連鎖（実測の大きい連鎖で 10 KiB 前後）+ ServerHello 等。どちらも 2 倍以上の余裕。値は指紋に入る（§2）。
- core は予約の後に読み直した記録（§4.2）から `runner.serve({... , ...(reserved.private.tlsMode === "proxy" ? { proxy: { providerAddr: reserved.private.reservation.proxy.providerAddr } } : {})})`。
  **記録の型と記録の宛先**から組む（設定から引き直さない）。

## 6. 失敗通知と session の終了（要件 FR-X08、LX-7）
- `superviseSession(paymentId, child, sessionBy)` に購入ごとの状態 `{ timerFired: boolean; exitedFirst: boolean }` を持たせる:
  - timer の callback: 子がまだ終わっていなければ `timerFired = true` を立ててから `child.kill()`。終わっていれば何もしない。
  - `child.exited` の解決（**`withPayment` を待つ前に同期で**）: `timerFired` がまだ偽なら `exitedFirst = true`、そして timer を取り消す。その後 `withPayment` → `onSessionExit(paymentId, sessionBy, exitedFirst)`。
  これで「子が自分で終わった後、lock を待つ間に timer が鳴る」場合も `exitedFirst` は真のまま（timer は子の終了を見て何もしない）。
- `onSessionExit` は最初に作業ディレクトリの `record.json` と `failure.json` の**有無を両方**見る:
  1. 両方ある → record を保持せず `private_session_timeout`（LX-7 の排他が破られた。最も弱い結論）。
  2. record だけ → 今と同じ処理（束縛 → 期限 → `private_recorded`。束縛に §7 の型の条件が入る）。
  3. failure.json だけ: `exitedFirst` が偽（Router の timer で止めた）なら `private_session_timeout`。真で、購入が proxy 型なら `readBounded(failure.json, 256)` →
     `parseFailureNotice`（JSON で**ちょうど** `{"reason": "proxy_dial_failed" | "proxy_server_name_mismatch" | "proxy_limit"}`、他のキー無し）→
     `private_proxy_dial_failed` / `private_proxy_server_name_mismatch` / `private_proxy_limit`。形違い・大きすぎ・MPC 型 → `private_session_timeout`。
  4. どちらも無い → `private_session_timeout`（今と同じ）。
- 再起動の再構成（基礎設計 §3.6）は**意図して** failure.json を読まない（今の規則のまま。束縛される record があれば回収し、それ以外のファイルは消す）。failure.json は
  「未完成の成果物」として `deleteNonRecord` が消す。

## 7. record と attest（要件 FR-X09・X10、`src/private/attest.ts`、`src/core/private.ts`）
- `VerifierRecord` に `tls_mode?: "proxy"`、`provider_addr?: string` を足す。`parseVerifierRecord`: `tls_mode` があれば文字列 `"proxy"` でなければ `undefined`（形違い）、
  `provider_addr` があれば ≤ 64 B の文字列でなければ `undefined`。`tls_mode` が無い record の解析は今と同じ。
- `recordIsBound(record, intent)` に条件を 1 つ足す: `modeMatches(record, priv)` =
  proxy 型の購入なら `record.tls_mode === "proxy" && record.provider_addr === priv.reservation?.proxy?.providerAddr`、MPC 型なら `record.tls_mode === undefined && record.provider_addr === undefined`。
  束縛されない record は既存どおり保持せずに `private_session_timeout`（要件 FR-X09）。再起動の回収も同じ関数を通る（基礎設計 §3.6）。
- `AttestExpectation` に**任意の**欄 `proxy?: { providerAddr: string }` を足す（無い = MPC 型。既存の試験の `AttestExpectation` の値はそのまま型が通る）。`checkAttest` の先頭
  （trust の前）で: `proxy` があれば `record.tls_mode === "proxy" && record.provider_addr === proxy.providerAddr`、無ければ `record.tls_mode === undefined && record.provider_addr === undefined`。
  外れたら `no("tls_mode")`（attest の結果は既存の写像で `private_attest_invalid`）。新しい `AttestRejection` は `"tls_mode"` の 1 語。
- 他の検査（trust・target・server_name・prefix・hash・証明・200・領収・期待 tx）は 1 つも変えない。

## 8. quote・記録・射影（要件 FR-X02・X03・X13）
- `IntentPrivate` に `readonly tlsMode?: "proxy"`（MPC 型は欄が無い）。`created` 行の `private` 欄に proxy 型のときだけ `tlsMode: "proxy"` を書き、`store.ts` の
  `privateBindingOf` 相当の復元で `"proxy"` 以外の値は journal の読み込みを拒む。欄が無ければ MPC 型（本増分の前の行と MPC 型の行）。
- **予約の行の型の整合**（store の reduce）: `private_issuance_reserved` の行の `proxy` 欄は、`tlsMode === "proxy"` の記録では**必須**（`providerAddr`・`vettedAddress` が
  ≤ 64 B の空でない文字列、他のキー無し）、MPC 型の記録では**禁止**。外れれば journal の読み込みを拒む（既存の厳格さと同じ扱い）。

### 8.1 記録の型と承認の型の照合（要件 FR-X00 の「欠落を MPC 型と読み替えない」）
- 指紋は**設定から**計算されるので（`dynamic.ts` の purchase の前の照合）、記録から `tlsMode` だけを消しても指紋は一致してしまう。そこで、秘匿購入の purchase の前の照合
  （`dynamic.ts` の指紋の照合の直後・受信 verify の前）に private の依存 `modeMatches(intent, profile)` を足す:
  `(intent.private.tlsMode === "proxy") === (tlsModeOf(privateConfig, profile.profileId) === "proxy")`。違えば `quote_changed`（受信 verify・settle は 0 回）。
  - 正しい旧い MPC 型の行: 設定で MPC 型（`mpcProfiles` に載る）なら一致、proxy 型になっていれば指紋がすでに違う（どちらでも `quote_changed` かそのまま購入）。
  - proxy 型の quote の記録から型を消した: 設定は proxy 型なので不一致 → `quote_changed`。
  - MPC 型の quote の記録に型を足した: 設定は MPC 型なので不一致 → `quote_changed`。
- 発行の後（予約の後の journal）は §8 の予約の行の整合が型を守る。
- quote の文書の `private` 欄（`privateFieldsOf`）: proxy 型のときだけ `tls: { mode: "proxy", relay: {maxSentBytes, maxRecvBytes} }` を足し、`disclosures` に
  `routerConnectsToProvider: true, providerSeesRouterAddress: true, trustsRouterProviderPath: true` を足す。MPC 型の文書は今と同じ。
- quote の時点の指紋（§2）と、purchase の前の指紋の照合（基礎設計 §3.2、`dynamic.ts` の既存の照合）は変えない（中身が型を含むだけ）。
- 射影（`orchestrator.ts` の `projectionOf` の `private` 欄、基礎設計 §7.3）: proxy 型の購入だけ `tls: { mode: "proxy", providerAddr }`（`providerAddr` は予約の行の値。予約の前は
  `providerAddr` の欄**だけ**を省き、`tls.mode` と開示 3 つは常に出す）と開示 3 つ。MPC 型の射影は今と同じ。
- client の型（`src/client/types.ts`）: `private.tls?` と開示の 3 欄を任意の欄として足す。MCP の道具の説明文は「quote の `private.tls.mode` が `proxy` なら Router が Provider に
  接続し、Provider は Router の IP を見る」を 1 文足す（入出力の形は変えない）。

## 9. 理由コード（要件 FR-X13）
- 新しい 4 語: `private_proxy_dial_refused`（受信 verify の前・`awaiting_payment`）、`private_proxy_dial_failed`・`private_proxy_server_name_mismatch`・`private_proxy_limit`（発行後・`unknown`）。
- 足す場所: `src/core/orchestrator.ts` の `SAFE_REASONS`、`src/shared/diagnostics.ts` の秘匿購入の表（§245 付近）、`tools/private-payer.ts` の表示の表（あれば）。

## 10. 秘匿（要件 FR-X11）
- Router のプロセスは暗号文に触れない（中継は lab の子プロセスの中）。Router が読む子の出力は既存の `maxChildOutputBytes` の上限つきの保存だけ。
- canary の試験（§11）で、偽バイナリが「中継した」ことにする固定の暗号文の canary を stdout・stderr・作業ディレクトリに**出さない**ことを lab に求め（LX-3）、
  Router 側は射影・journal・診断・保存した子の出力・作業ディレクトリ（record の保持の後）を走査する。偽バイナリでは canary を record に入れた負の試験で、
  Router が record を journal に写さないこと（既存の規則）も確かめる。

## 11. payer 道具（要件 FR-X12、`tools/private-payer.ts`）
- quote の `private.tls?.mode` を読む。`"proxy"` なら `executor-session` に `--tls-mode proxy` を足し、`--connect` を付けない。`--connect` の指定があれば、
  **quote を読んだ直後（受信 credential を作る前・purchase の前）に** `fail("prerequisites", "--connect is not used in proxy mode (the Router connects to the Provider)")`。値が無い・`"proxy"` 以外の値は MPC 型（今の引数のまま）。
  ただし `tls` 欄があって `mode` が `"proxy"` 以外なら `fail("prerequisites", "unknown tls mode")`。
- 承認の前の表示（stdout と log）に `tls mode: proxy` と開示 3 つを 1 行ずつ。

## 12. 試験（要件 TR-X1〜X4 との対応）
| 要件 | 置き場所 | 中身 |
|---|---|---|
| TR-X1 設定 | `tests/unit/private-config.test.ts` | `mpcProfiles` の検査、`tlsModeOf`、既定値の表の検査は不変、MPC 型の指紋の golden が `mpcProfiles` の追加だけで不変 |
| TR-X1 能力の門 | `tests/unit/private-capabilities.test.ts`（新） | `readCapabilities` の各形（偽バイナリ）、`main.ts` の門（proxy 型あり + 宣言なし → `ConfigError`、全部 MPC 型 → 呼ばない: 呼び出しを数える） |
| TR-X1 宛先 | `tests/unit/guarded-pin.test.ts`（新） | `pinDestination` の DENY4/6・自アドレス・IPv4-mapped・1 つだけ禁止・0 件・期限・同時数・門の拒否・選び方・`dialForTest`（値・`undefined`・例外で枠を返す）・`fetch` の `pin` 文脈（vet 0 回・admit 0 回・`dialForTest` 0 回で `pin.dial` へ、答えが呼ぶたびに変わる `dialForTest` でも接続先は同じ・別 host は従来）。名前の deny list は購入の経路の試験（core） |
| TR-X1 core | `tests/unit/private-core.test.ts`（追加） | 型の照合（§8.1 の 3 通り → `quote_changed`、受信 verify 0 回）；移行（quote の 3 通り、進行中の購入）；枠の返却（§4.3 の各出口の後に使用数 0、`perAddressConcurrent: 1` で pin と探りが両立）；予約の後の読み直し；pin の失敗で受信 verify・settle 0 回・予約 0 行・`issueCredential` 0 回・`awaiting_payment`（`private_proxy_dial_refused`）；名前の deny list は pin の前に止まる；固定の維持（pin の後に lookup の答えを変えても serve の引数は同じ、lookup の回数は pin の 1 回だけ）；失敗通知の写像と順序（timer の後の通知は読まない、子が先に終わって lock を待つ間に timer が鳴っても通知を読む、record と通知の両方）；record の型の束縛；移行（旧 journal を proxy 既定の設定で開く） |
| TR-X1 attest | `tests/unit/private-attest.test.ts`（追加） | `tls_mode`・`provider_addr` のすり替え・欠落、MPC 型の購入への proxy の record → `tls_mode` |
| TR-X1 store | `tests/unit/private-store.test.ts`（追加） | 予約の行の `proxy` 欄の復元・形違い・proxy 型で欠落・MPC 型で存在の拒否、`created` の `tlsMode` の復元と形違いの拒否、旧 journal は MPC 型 |
| TR-X1 payer | `tests/unit/private-payer-*.test.ts`（追加） | 型への追従、`--connect` の拒否、表示 |
| TR-X1 秘匿 | 上の core・wire の canary | §10 |
| TR-X2 wire | `tests/wire/private-proxy.test.ts`（新） | lab の proxy 対応バイナリ（既存の lab の skip 条件 + `readCapabilities` が proxy を返すこと。skip は未検証として記録）で x402→x402 の POST と GET、V2 burn-sale 受信→x402 を proxy 型の全経路。fixture の接続を**探り（支払いヘッダ無しの 402）と Verifier 経由の有料要求（支払いヘッダ付き）に分けて**数える（有料要求は 1 回）と Router の発行の数。実バイナリの成功・失敗の両方で、**掃除の前**（停止点で止めて）と保持の後の作業ディレクトリ・保存した子の出力・journal・射影に、Payer の本文の canary と、fixture が記録した TLS の暗号文の先頭 32 B が無いこと。否定 5 つ（サーバー名不一致・上限・接続失敗・型のすり替え・期限切れ 2 通り）。再起動。既存の MPC の wire は設定に `mpcProfiles` を足すだけ |
| TR-X3 受入 | `tests/acceptance/private-live.test.ts` の proxy 版の手順（`docs/zktls-router-acceptance.md` に追記） | Provider C・F を proxy 型で 1 件ずつ |
| TR-X4 | `npm test` と `npm run types` | 既存の MPC の試験の設定に `mpcProfiles` を足す以外の変更なし（`AttestExpectation` の追加は任意の欄なので既存の型は通る） |

## 13. 既存コードの接続点（最小）
| ファイル | 変更 |
|---|---|
| `src/config.ts` | `mpcProfiles`、`tlsModeOf`、指紋の proxy 欄 |
| `src/net/guarded-fetch.ts` | `TransportContext.pin`、`pinDestination`（`vet` の共有）、`fetch` の `pin` 文脈の分岐（`pin` の無い呼び出しは不変） |
| `src/adapters/outbound/private-x402.ts`・`private-mpp.ts`・`x402-dynamic.ts`（reader）・`src/ports/private-outbound.ts` | `discover` の任意の第 3 引数 `{pin}` を `ctx` に載せる |
| `src/private/proxy.ts`（新） | `PROXY_RELAY_LIMITS`、`parseFailureNotice`、`FAILURE_FILE` |
| `src/private/verifier.ts` | `readCapabilities`、`ServeArgs.proxy` |
| `src/private/attest.ts` | record の 2 欄、`checkAttest` の `tls_mode` |
| `src/core/intent.ts`・`store.ts` | `IntentPrivate.tlsMode`・`reservation.proxy` の型と復元、`reservePrivateIssuance` の任意の引数 |
| `src/core/private.ts` | quote の欄、`pinBeforeSettle`、serve の引数、失敗通知、束縛 |
| `src/core/dynamic.ts` | 指紋の照合の後に `modeMatches`、`purchaseWithHost` の先頭に `pinBeforeSettle`、段 2' の `finally` に `releasePin`（どれも秘匿購入だけ） |
| `src/core/orchestrator.ts`・`src/shared/diagnostics.ts` | 射影の `tls`、理由コード 4 語 |
| `src/main.ts` | 能力の門、`pinDestination` の配線（`PrivateWiring` に `pinDestination` を足す） |
| `src/core/orchestrator.ts`（配線） | `RouterCoreOptions.private` の型と `createPrivateCore` の呼び出しで `pinDestination` を渡す（実合成から `pinBeforeSettle` まで届くことを試験で確かめる） |
| `src/client/types.ts`・`src/mcp/*` | 任意の欄と説明文 |
| `tools/private-payer.ts` | 型の追従 |
| `tests/fixtures/private/fake-delivery.mjs` | `capabilities`、proxy の引数の記録、`failure.json` の各形、record の `tls_mode` |

## 14. 未解決・リスク
- lab の回答で LX の名前・形が変われば、§3・§5・§6・§7 の該当の名前だけを差し替える（意味が変わる場合は要件から直す）。lab の回答が来るまで wire（TR-X2）は skip。
- 中継の上限の値（§5）は lab の実測で見直す（証明書の連鎖が 64 KiB に近い Provider があれば上げる。値は指紋に入るので変更は `quote_changed` を起こす）。
- proxy 型の選び方で IPv4 を優先する（§4.1）のは決定性のため。IPv6 だけの Provider は IPv6 で接続する。Router の IPv6 の到達性は環境による（接続できなければ `private_proxy_dial_failed`）。

## 15. v1 → v2 の対応（Codex 設計レビュー 1 回目）
| 指摘 | 対応 |
|---|---|
| blocking 1: 型の欄を消すと MPC 型になる | §8.1（purchase の前の `modeMatches`、3 通りの帰結）、§8（予約の行の `proxy` 欄は proxy 型で必須・MPC 型で禁止） |
| blocking 2: pin と探り・門の衝突 | §4.1（`TransportContext.pin` で vet と admit を省く）、§4.2（`admitHost` の内側・最初の探りの前に pin、2 回の探りは pin を引き継ぐ。枠は購入につき 1 つ） |
| should 3: 予約の前の写し | §4.2（予約の後に記録を読み直して照合し、serve と束縛はそれを使う）、§5 |
| should 4: 枠の返却の漏れ | §4.3（網の枠は成果物の容量と別に、子が居なければ必ず返す。5 つの場所。`dialForTest` の例外でも返す） |
| should 5: timer と終了の順序 | §6（終了の解決で同期に `exitedFirst`、timer の取り消し、record と通知の両方の扱いを先に、再起動は意図して読まない） |
| should 6: 能力の試験の制御 | §3（stderr を捨てる spawn、stdout 256 B・5 s、試験は一時の実行ファイル、`main.ts` は `readCapabilitiesForTest`） |
| should 7: `AttestExpectation` の必須欄 | §7（任意の `proxy` 欄、無ければ MPC 型）、§12（`npm run types`） |
| minor 8: 指紋の欄名・版 | §2（`tlsMode`・`proxyRelay`）、冒頭（要件 v3.2） |
| minor 9: 試験の境界・接続先の表記 | §4.1（名前の deny list は購入の既存の段、`dialForTest` の `undefined`・任意のポートの扱い）、§12 |
| その他（表の注記） | §11（`--connect` の拒否は credential の前）、§12（探りと有料要求の接続を分けて数える、実バイナリで掃除の前後の canary、skip は未検証） |
| 再 should 1: 枠の所有の受け渡し | §4.3（容量と同じ受け渡し、`!transferred` のときだけ外側で返す、子の終了は lock の前に返す、`close()` は子の停止の後、`scheduleAt` の取り消し、試験 (a)〜(d)） |
| 再 should 2: 探りの試験の接続先 | §4.1（`TransportPin.dial` を pin の時に固定し、pin の文脈の fetch は `dialForTest` を呼び直さない。`TransportPin` は内部の値） |
| 再 minor 3: 配線の経路 | §13（`PrivateWiring`・`RouterCoreOptions.private`・`createPrivateCore` の呼び出し） |
