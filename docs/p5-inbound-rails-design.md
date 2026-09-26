# P5 設計: 受信レグに SubEtha と MPP を追加する

> **改訂 2**。初版の主張のうち 3 点が**事実として誤り**だったため独立レビュー後に訂正した
> （scope の過小申告 / `validateCredential` の検証範囲の誇張 / 「payer が broadcast する」の無条件断定）。
> 訂正箇所は本文に明示する。

## 1. 目的

Router が受け付けられる**受信レール**を増やす。現在デモで動いているのは
`sourceRail: "x402"` だけで、受信が x402 に固定されている。

到達目標は「**呼び出し側が持っている手段で払える**」を受信側でも成立させること:

| 受信 | 送信 | 現状 |
|---|---|---|
| x402 | MPP | **稼働中**（`router.subethalabs.com`、実決済確認済み） |
| SubEtha | MPP / x402 | adapter は存在。**実 facilitator 未接続** |
| MPP | MPP / x402 | **adapter 自体が無い（本設計の主対象）** |
| x402 | x402 | **未検証**（同一レールの経路を通した証拠が無い） |

**訂正（初版の誤り）**: 初版は x402→x402 を「配線済み」と書いたが、
これを通した end-to-end は存在しない（`tools/t8-crossrail-e2e.ts` は x402 受信 → **MPP** 送信）。
同一レール行列は未検証として扱う。

## 2. 現状の構造

- `src/ports/inbound.ts` の `InboundRail` は**レール非依存**。
  `createOffer` / `preflight` / `verify` / `settle` の 4 つだけ。
- core は rail 名で分岐しない。adapter 選択は `src/main.ts` の `inboundByRoute()` が行う。
- `route.sourceRail` 未指定は `"subetha"` にフォールバックする。

### 変更範囲（**訂正: 初版は過小申告していた**）

初版は「adapter 1 本と `main.ts` の分岐追加で閉じる」と書いたが**誤り**。
`src/config.ts:231-232` に**許可リスト**がある:

```ts
if (sourceRailRaw !== undefined && sourceRailRaw !== "subetha" && sourceRailRaw !== "x402") {
  throw new ConfigError(`${at}.sourceRail must be "subetha" or "x402" when present`);
}
```

`sourceRail: "mpp"` は**起動時の構成検証で弾かれる**。実際の変更範囲は:

1. `src/adapters/inbound/mpp.ts`（新規）
2. `src/main.ts` の分岐追加
3. **`src/config.ts`**: 許可リストに `"mpp"` を追加、`source.payTo` の必須条件を
   `"x402"` だけでなく `"mpp"` にも拡張（`config.ts:241-242`）、新 env 2 本の読み取り

core・ports・`src/http/projection.ts` は触らない。

### `rail` 既定 `subetha` は外さない

`src/http/projection.ts:49` と `src/main.ts:109` がともに `?? "subetha"`。
既存 chat の `router-contract.mjs:82` が `check(s.rail === 'subetha')` を要求するため
（README.md:317・docs/t8-design.md:108 に記録、`tests/wire/chat-crossimpl.test.ts:452` が SHA-256 を固定）。

**付記**: chat は `scheme === 'subetha-zerc20'` も要求するので、
**MPP 受信 route は chat からは構造的に使えない**。これは既定の問題ではなく
chat 側の契約であり、本スライスで解消しない。

## 3. SubEtha 受信（`sourceRail: "subetha"`）

### 判断: adapter は既にある。作業は「**実 composition を通る無課金テスト**」

`src/adapters/inbound/subetha.ts` は実装済みで、preflight も
nonce・失効・route 束縛・offer 完全一致まで実装済み。単体テストもある
（`tests/wire/subetha-inbound.test.ts`）。

**本当の穴は別のところにある**: `sourceRail` を解決する経路（`src/main.ts` の
`inboundByRoute`）を通るテストが**1 本も無い**。`grep -rn sourceRail tests/` は 0 件で、
この経路は実決済ツール（`tools/*.ts`）でしか踏まれていない。
つまり**お金を動かさないと受信レール周りの回帰が検出できない**。

### やること
1. `sourceRail: "subetha"` を明示した route が SubEtha adapter に解決されることを、
   実 `composeRails` 経由・無課金で固定する
2. 省略時の既定も同じ解決になることを固定する
3. 未知の `sourceRail` で**起動が止まる**（合成に落ちない）ことを固定する

### やらないこと
- 実 facilitator の URL を**推測して設定に入れる**。未確定は未確定として残す（設計 §12 U-01r）

## 4. MPP 受信（`sourceRail: "mpp"`）— 本設計の主対象

### SDK のサーバ側 API（`mppx@0.11.0` の実物で確認）

| 用途 | API | 所在 |
|---|---|---|
| challenge 発行 | `mppx.challenge.tempo.charge({ amount, expires })` | `server/Mppx.d.ts` |
| 非破壊の事前検査 | `mppx.validateCredential(credential, options)` | `server/Mppx.d.ts:216` |
| 実際の受領 | `mppx.broadcastCredential(credential, options)` | `server/Mppx.d.ts:228` |
| 再実行防止 | `Store.memory()` / `Store.tryClaim` | `Store.d.ts:75,103` |

**訂正（初版の誤り）**: 初版は `Challenge.from({ secretKey })` と書いたが、
`secretKey` は**第 2 引数（options）**。また `Challenge` は `mppx/server` から
**re-export されていない**（ルート `mppx` から取る）。初版の表のままではコンパイルしない。

### ポートへの対応

| `InboundRail` | MPP 実装 |
|---|---|
| `createOffer` | `mppx.challenge.tempo.charge({ amount, expires })`。`challengeNonce ← challenge.id`、`expiresAt ← expires` を**ISO→unix 秒に変換** |
| `preflight` | **同期**。nonce 一致・失効・route 束縛・offer 完全一致だけをローカル判定（SDK 呼び出しを含めない） |
| `verify` | `mppx.validateCredential`（`tempo.charge` では非破壊。下記の限界に注意） |
| `settle` | `mppx.broadcastCredential` → `Receipt.reference` を `txRef` に |

#### `preflight` は同期でなければならない（確認済み）

`src/core/orchestrator.ts:413` は `await` せずに呼び、次行で `.ok` を読む。
async にすると `.ok` が `undefined` になり**全購入が `preflight_failed` で落ちる**。

拒否理由は**固定集合**から選ぶ（`orchestrator.ts:223-229`）:
`nonce_mismatch` / `offer_expired` / `offer_mismatch` / `route_binding_mismatch` /
`credential_mismatch`。それ以外は `preflight_failed` に潰れる。

#### `verify` の限界（**訂正: 初版は誇張していた**）

初版は「`validateCredential` が amount/currency/recipient/memo/tx success/replay を見る」と
書いたが**誤り**。その記述は SDK の `validateSender` オプションの doc comment にある
「**core verification**」の説明で、これは **broadcast 経路**を指す。

実装を読むと（`tempo/server/Charge.js`）:
- `validate()` は `validateCredential()` を呼ぶだけで**返る**（`:344-355`）
- `tryClaimHash` / `tryClaimProof` は**すべて `broadcast()` の中**（`:372, 380, 396, 472`）

したがって **`verify` は replay 防止をしない**。
**Router は `verify` に再実行防止を期待してはならない。**

#### push / pull（**訂正: 初版は「payer が broadcast する」と無条件に書いた**）

`tempo.charge` の credential は 3 種類あり、**誰が broadcast するかが違う**:

| credential | mode | broadcast するのは |
|---|---|---|
| `hash` | push | **payer**（送信済みの tx を Router が確認する） |
| `transaction` | pull | **Router（サーバ）**。署名済み・未送信の tx を受け取って送る（`Charge.js:392-500`） |
| `proof` | — | 0 円用 |

**本スライスは `supportedModes: ["push"]` に固定する。** 理由:

1. 受信側に**署名鍵も gas 負担も持たせない**（`recipient` は `Address` で足りる:
   `tempo/internal/account.d.ts:35`）
2. pull は Router が broadcast 主体になり、fee payer の露出と予算設計が要る
3. push なら送信レグで既に扱っている「payer が broadcast する」非対称性を再利用できる

pull を将来有効にする場合は**受信レグに鍵と gas 予算が入る**ので、要件定義からやり直す。

### `settle` の失敗は `rejected` にしない（**訂正: 結論は正しいが理由が違った**）

初版は「core は `unknown` をそのまま確定させずに扱う」と書いたが**誤り**。
`unknown` は `src/core/intent.ts:45-52` の `TERMINAL` に入っており、**確定した終了状態**である。
再照合の仕組みは無い。

正しい理由は**公開される状態が違う**こと（`src/core/orchestrator.ts:529-556`）:

| adapter の返り値 | journal | 公開 status |
|---|---|---|
| `rejected` | `source_failed` | **`awaiting_payment`**（= まだ払われていない） |
| `unknown` / 証跡のない `settled` | `unknown` | `unknown`（= **分からない**） |

push mode では payer が既に送金している可能性があるため、
`rejected` を返すと**送金済みの支払いを「未払い」と公言する**ことになる。

なお `intent.status !== "created"` の門（`orchestrator.ts:388`）があるので
`source_failed` でも**同じ quote の買い直しは起きない**。
つまり害は二重支払いそのものではなく**誤った状態表明**である。初版の「二重支払いを誘発する」は言い過ぎ。

`rejected` を返してよいのは「**課金が起きていないと断定できる**」場合だけ。
既存 `subetha.ts` も同方針（HTTP 4xx のみ `rejected`、5xx と解析不能は `unknown`）。

### nonce の一意性は**こちらが保証する**

`challenge.id` は `realm|method|intent|request|expires|digest|opaque` の HMAC
（`Challenge.d.ts:58-62`）。**同じ額・宛先・期限・scope なら同じ id になる。**
`challengeNonce` の一意性を SDK に期待できないので、
**`paymentId` を `meta` に入れて HMAC 入力に混ぜる**ことで per-quote 一意性を持たせる。
これを怠ると、別の intent の credential が `preflight` の nonce 検査を通り得る。

### replay 防止の限界

`Store.memory()` は**プロセス内**。Router を再起動すると消えるため、
再起動をまたいだ MPP credential の replay は防げない
（Router 自身の at-most-once は `paymentId`/`quoteId` 基準で、**credential を鍵にしていない**）。
単一インスタンス前提（`docs/DEPLOY.md` の flock 注記）でも**これは残る制約**であり、
実決済を有効にする前に解消が要る。

### 鍵の扱い

受信レグで Router は**受取側**なので署名鍵は不要。必要なのは
`secretKey`（challenge の HMAC 束縛）と `recipient` アドレスだけ。
`secretKey` は署名鍵ではないが秘密なので、`src/**` が env から読まない既存方針に揃え、
`tools/` 側から注入する。

`feePayer` は**渡さなければ既定で無効**（`tempo/internal/account.js:25-34` で確認）。
本スライスでは渡さない。`sponsorBudget` は有効化スイッチではなく**露出の上限**なので、
「有効にしない対象」ではない（初版の記述を訂正）。

## 5. 構成の追加

```
routes.<id>.sourceRail = "mpp"        # config.ts の許可リストに追加が必要
routes.<id>.source.payTo              # "mpp" でも必須にする
ROUTER_MPP_INBOUND_SECRET             # challenge HMAC
ROUTER_MPP_INBOUND_OFFER_SECONDS      # 既定 600。createOffer の expires に渡す
```

`ROUTER_MPP_INBOUND_OFFER_SECONDS` は `expires` を**明示的に渡す**ために要る。
`Challenge.expires` は**任意（optional）**で、渡さないと `expiresAt` が埋まらず
`preflight` の失効検査（`offer.extra.expiresAt * 1000 <= nowMs`）が**一度も発火しない**。

## 6. 範囲外（明示）

- 実 SubEtha facilitator への接続（URL 未確定）
- MPP 受信の**実決済**。SDK 配線と無課金検証までを本スライスとする
- pull mode / fee sponsor / machine token / subscription
- 再起動をまたぐ replay 防止（上記の既知の制約）
- x402 → x402 の同一レール経路
- MPP 受信 route の chat からの利用（chat が `subetha-zerc20` を要求するため構造的に不可）

## 7. 検証

1. `sourceRail: "subetha"` が実 composition で SubEtha adapter に解決されること（無課金）
2. `sourceRail` 省略時も同じ解決になること（既定の固定）
3. 未知の `sourceRail` で起動が止まること
4. MPP 受信 adapter の preflight 拒否面（nonce 不一致 / 失効 / route 束縛違い / offer 改変）
   が**固定集合の理由**で返ること
5. `settle` の不確定が `unknown` に落ちること（`rejected` にしない）
6. `expires` 未指定で `expiresAt` が欠落しないこと（失効検査が実際に発火すること）

## 8. 実装結果（2026-09-26）

### 到達点

| 項目 | 状態 |
|---|---|
| `sourceRail` 解決の無課金テスト | **追加**（従来は実決済ツールでしか踏めなかった） |
| SubEtha 受信の composition 経由検証 | **通過** |
| MPP 受信 adapter（`src/adapters/inbound/mpp.ts`） | **実装・配線済み** |
| MPP 受信の**実決済** | **未実施**（範囲外のまま） |
| 実 SubEtha facilitator 接続 | **未実施**（URL 未確定のまま） |
| 回帰 | テスト 211 件 pass、x402 受信・chat 相互運用とも影響なし |

### 実物を叩いて分かったこと（型だけでは分からなかった）

1. **`Challenge.expires` は ISO 文字列で optional。** 変換しないと `expiresAt` が
   埋まらず、`preflight` の失効検査が**一度も発火しない**。明示変換し、
   失敗時は 0 に落とさず例外にした。
2. **`challenge.id` は内容の HMAC なので同一ミリ秒に衝突する。** 実測で確認
   （`same-instant nonces equal? true`）。`meta` に UUID を混ぜて解消し、テストで固定。
3. **`validateCredential` は replay 防止をしない。** `tryClaim` はすべて
   `broadcast` 側にある。`verify` の通過を受領の根拠にしない。

### テストの検証（sabotage）

緑が「正しい理由で緑か」を確かめるため、意図的に壊して落ちることを確認した:

| 壊した箇所 | 落ちたテスト |
|---|---|
| `rail: route.sourceRail ?? "subetha"` の既定を除去 | 射影テスト |
| 受信 adapter 解決を x402 固定に | 5 件中 4 件 |
| `stableJson` の完全一致検査を除去 | offer 改変テスト |
| `expiresAt` を 0 固定 | 5 件 |

また、fail-closed テスト 3 件が**無関係な理由（budget 空）で緑になっていた**のを
実測で発見し、理由文字列を固定するよう修正した。

### 残る制約（実決済の前に解消が要る）

- **replay 状態がプロセス内**。再起動で消える。Router 自身の at-most-once は
  `quoteId` 基準で credential を鍵にしていない
- MPP 受信は**実チェーンに対して一度も実行していない**。
  `broadcastCredential` の実挙動・手数料・確定待ちは未確認

## 9. 実装レビューで見つかった致命的な 2 件（訂正 3）

実装後の独立レビューで、**値が壊れる**バグが 2 件見つかった。どちらも実 SDK で実測確認した。

| # | 症状 | 原因 |
|---|---|---|
| 1 | offer は `eip155:42431`（testnet）と名乗るのに、**HMAC には 4217（mainnet）が焼き付く** | `chainId` を `tempo.charge()` の **factory 引数**に渡すと**黙って無視される**。challenge 呼び出し側に渡す必要がある |
| 2 | 人間に `10000` と見せて、**束縛は `10000000000`（10^6 倍）** | SDK が `parseUnits(amount, decimals)` を掛ける。`decimals` の既定は 6。Router の `amount` は既に base units なので `decimals: 0` が要る |

```
configured chainId : 42431     bound chainId : 4217
requested amount   : 1000      bound amount  : 1000000000
```

**どちらもテストで捕まらなかった。** `amount` と `network` を 1 行も assert していなかったため。

### 取った対策（呼び出し方の修正だけで終わらせない）

呼び出し方を直すだけだと、SDK 側の仕様が変わったときに**また黙って壊れる**。
そこで `offerOf` に「**SDK が実際に束縛した値**（`challenge.request`）と、
**これから payer に見せる値**が一致するか」の照合を入れ、
食い違ったら **offer を発行せず例外**にした。実測で両方の不一致がここで止まることを確認:

```
Error: mppx bound a different amount than offered (offered 10000, bound 10000000000)
Error: mppx bound a different chain than offered (offered 42431, bound 4217)
```

### settle テストが「見せかけ」だった件

`receiptOutcome` という**adapter のロジックを写したローカル関数**を比較していただけで、
`rail.settle` を呼んでいなかった。レビュアーが post-broadcast の分岐を**全部 `rejected` に
反転しても 14/14 緑のまま**であることを実証した。

adapter に `broadcastForTest`（注入可能な継ぎ目）を足し、テストは `rail.settle` を
実際に通すようにした。同じ反転で**落ちる**ことを確認済み。

### 教訓

「実物を叩いて確認した」と書いたが、**叩いた object の中身を最後まで見ていなかった**。
`amount` を 1 回 assert していれば 2 件とも防げた。
**出力を print するだけでなく、期待値と突き合わせる。**
