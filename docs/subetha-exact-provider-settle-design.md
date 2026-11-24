# `subetha-exact`：Router が自分の x402 facilitator で settle する（要件・設計・タスク）

2026-11-22。対象は受信レール `subetha-exact`（Router = SubEtha v2 facilitator の Provider）の `settle` だけです。
2026-11-24 の追加：送り先を SubEtha 自前の settle facilitator に向ける場合（token あり）の R6・R7・§3.4・§3.7・§3.12 の違いは [exact-settle-facilitator-design.md](exact-settle-facilitator-design.md)。token の無い構成は、この文書のまま。
もとの設計は [subetha-exact-inbound-design.md](subetha-exact-inbound-design.md) §3.8（表 B）で、この文書はその表 B を置き換えます。

## 1. 背景

SubEtha の複数 Provider 向け facilitator は、2026-11-22 から支払いをどこにも送りません（relay の廃止）。
`POST /p/<id>/exact/orders/:orderId/settle` は残りますが、chain を照合するだけです。未払いの正しい payload には
`success: false`、`errorReason: "broadcast-not-permitted"`、`outcome: "pending"` が返ります。

Router の `settle` は今この route だけを呼ぶので、hosted の SubEtha が入れ替わると zUSDC の経路は 1 件も売れなくなります。
ほかの経路には影響しません。hosted の SubEtha は、Router の対応が済んでから入れ替わります（オーナーの決定）。

## 2. 要件

- **R1（順番）** `settle` は、bind → 外部の facilitator へ送る → reconcile の順に進む。SubEtha の `…/settle` はもう呼ばない。
- **R2（送ってよい条件）** 外部へ送ってよいのは、bind が `ack: "bound"` で、その `identity`（`from`、`nonce`、`sigSha256`）が
  手元の authorization と一致するときだけ。それ以外の答え、答えが無い場合、読めない場合は送らない。
- **R3（最大 1 回）** 1 つの注文について、外部へ送るのは一生に 1 回まで。送る前に耐久の印を ledger に書く。印が書けなければ送らない。
  印は消さない。再起動のあとも、印のある注文には送らない。
- **R4（結果の出どころ）** `settled` と答える根拠は SubEtha の reconcile の `accepted` だけ。外部の facilitator の「成功」は証拠にしない。
- **R5（分類）** `accepted` 以外はすべて `unknown`（`source_settle_unknown`、`mayStillSettleUntil` 付き）。`rejected` には分類しない。
  今と同じく、ledger に attempt の無い注文だけは、要求を出す前に `rejected` を返す。
- **R6（facilitator）** 使う facilitator は `https://www.x402.org/facilitator`（オーナーの決定、2026-11-22。第三者の無料のサービス、認証情報なし）。
  env で差し替えられるが、host は allowlist の中だけ。
- **R7（秘密）** token、署名、credential、URL、外部の facilitator の自由な文を、ledger、note、診断、例外に写さない（今の規則のまま）。
- **R8（変えないもの）** `createOffer`、`preflight`、`verify`、`release`、`complete`、core、HTTP の入口、買い手に見える状態と code。
- **R9（費用）** 外部の facilitator の料金と gas は Router の運用者の負担になる。x402.org は今のところ無料。README と DEPLOY に書く。

## 3. 設計

### 3.1 SubEtha の応答（protocol の main `f30e4bb` の code から）

**bind**：`POST {tenant}/exact/orders/:orderId/bind`、Bearer、本文 `{ paymentPayload, requesterDigest, resourceDigest }`（今の settle と同じ）。

| 応答 | 意味 | Router の動き |
|---|---|---|
| 200 `{ ack: "bound", identity }` | ledger に書き終えた。同じ authorization の繰り返しにも同じ答え | identity が一致すれば 3.3 へ。一致しなければ送らず `unknown` |
| 200 `{ ack: "already-used", recorded, outcome, txHash?, identity? }` | chain がすでに使用を示している | 送らない。reconcile へ |
| 409 `{ error: <code> }` | 拒否（`conflicting-authorization`、`order-on-other-path`、`order-not-open`、`order-expired` など） | 送らない。reconcile を 1 回 |
| 403、404、425、429、5xx、ほかの status、読めない本文、例外、時間切れ | bind されていない、または分からない | 送らない。reconcile も呼ばず `unknown` |

409 のあとに reconcile を 1 回呼ぶのは、「先に誰かが払っていて注文が閉じている」場合に `accepted` を拾うためです。送信はしません。

**reconcile**：`POST {tenant}/exact/orders/:orderId/reconcile`、Bearer、本文 `{}`。
応答は 200 `{ outcome, txHash?, reason?, order }`。`outcome` は `accepted`、`pending`、`late-paid`、`rejected`。
`order.status.exact` に、注文に結び付いた authorization の `from`、`nonce`、`sigSha256` が入る。

`sigSha256` は、署名の文字列を小文字にしたものの SHA-256（hex、小文字）です。

### 3.2 `settled` と答える条件（すべて満たすとき）

1. reconcile が 200 で、本文が object、`outcome === "accepted"`。
2. `txHash` が 32 バイトの hex。
3. `order.status.exact` の `from` と `nonce` が手元の authorization と一致する。`sigSha256` があれば、それも一致する。

答えは `{ outcome: "settled", txRef: txHash（小文字）, eventId: nonce（小文字） }`。`release` は今までどおり、この `txRef` を SubEtha の release の応答と照合します。

それ以外（`pending`、`late-paid`、`rejected`、知らない値、200 以外、読めない、例外）は `unknown` です。

### 3.3 送信（最大 1 回）

**印は注文に付けます（attempt ではなく）。** 同じ注文を `created` に持つ attempt が複数あり得るので（`existing: true` の再利用）、
ledger は「`submit` の行を持つ注文 id（小文字）」の集合を耐久の索引として持ちます。行の鍵は今までどおり最新の attempt です。

順番（bind が `bound` で identity が一致したあと）：

1. **await を挟まずに**、注文ごとの in-flight の集合を見る。すでに入っていれば送らず reconcile へ。入っていなければ入れる（`settle` の終わりに外す）。
2. ledger の索引にその注文の `submit` があれば、送らず reconcile へ。
3. `submit`（`phase: "started"`）を書く。**書けなければ送らず `unknown`**（この行だけは、失敗を握りつぶさない）。
4. `POST {facilitator}/settle` に `{ x402Version: 2, paymentPayload, paymentRequirements }` を 1 回送る。再試行しない。redirect は拒否。
   `paymentPayload` は bind に渡したものと同じ。`paymentRequirements` は Router が発行した offer から組む（verify と同じ関数）。
   **この要求に Provider token は付けない**（`Authorization` の header なし。SubEtha 向けの `call` とは別の関数にする）。
5. 答えを `submit`（`phase: "answered"`）に残す：`httpStatus`、`success`（boolean のときだけ）、`transaction`（32 バイトの hex のときだけ）、経過時間。
   本文のほかの欄は残さない。この行が書けなくても先へ進む。

落ちる場所ごとの結果：印を書いたあと・送る前に落ちると、再起動のあとも送らないので、送信は合計 0 回です（買い手の authorization は期限で失効します）。
送ったあと・答えを書く前に落ちても、再起動のあとは送りません（合計 1 回）。どちらも結果は reconcile が決めます。

### 3.4 reconcile の待ち方

外部の facilitator は receipt を待ってから答えますが、SubEtha が `accepted` と言うまでに少し遅れることがあります。

- 外部の答えが「成功」（200 で `success === true`）か、答えと読めないとき（例外、時間切れ、5xx、読めない本文、`success` が boolean でない 200）：
  `pending` の間、2 秒おきに reconcile を繰り返す。上限は `settle` 全体の予算。
- 外部がはっきり断ったとき（200 で `success === false`、または 4xx）と、送らなかったとき：reconcile は 1 回だけ。

外部の答えは、**待つ長さを決めるだけ**で、結果は決めません。

### 3.5 時間の予算

`settle` 全体は今と同じ 60 秒（`settleMs`）。その中で、bind 1 回は 10 秒まで、送信は 30 秒まで、reconcile 1 回は 10 秒まで。
どれも残りの予算で切ります。残りが無ければ、その先は呼ばずに `unknown`。

ledger の書き込み（fsync）そのものには期限を付けません。書き込みのあとに残りを測り直し、尽きていれば次の要求を出しません
（送信の印を書いたあとに尽きていた場合、印は残り、その注文はもう送りません）。

### 3.6 ledger

新しい event は `bind` と `submit` の 2 つ。`settle` の行は今までどおり最後に 1 行書きます（未解決の数え方は変わりません）。

| event | patch |
|---|---|
| `bind` | `orderId`、`ack`（`bound`／`already-used`／`refused`／`unknown`）、`identity`（`match`／`mismatch`、bound のときだけ）、`code`（409 のとき。下の固定の一覧にある値だけ。無ければ `other`）、`httpStatus`、`elapsedMs` |
| `submit` | `orderId`、`phase`（`started`／`answered`）、answered では `httpStatus`、`success`、`transaction`、`reason`（断った答えのときだけ。§3.12）、`elapsedMs` |
| `settle` | 今の欄に加えて `path: "provider"`、`reconcile`（`accepted`／`pending`／`late-paid`／`rejected`／`mismatch`／`other`／`unanswered`／`none`）、`reconcileAttempts` |

bind の code の一覧：`conflicting-authorization`、`order-on-other-path`、`order-not-open`、`order-expired`、`valid-before-after-order-expiry`、
`authorization-consumed-before-order`、`invalid-signature`、`too-many-unresolved-bindings`、`payload pays another order`。
相手の文字列をそのまま残すことはしません（token が error に写っていても ledger に入らないように）。

古い版の Router がこの ledger を読むと、知らない event は無視します（replay の `default`）。形は壊れません。
ただし古い版は送信の印を見ません。古い版は SubEtha の settle を呼ぶだけで、自分では送りません。relay を持つ版の SubEtha に戻した場合に二重の送信にならないのは、
SubEtha が bind 済みの注文を relay に回さないからです（SubEtha 側の性質）。

### 3.7 設定

- 新しい env `ROUTER_SUBETHA_EXACT_SETTLE_FACILITATOR_URL`（任意）。無ければ `https://www.x402.org/facilitator`。
- 検査：https、host は `www.x402.org` か `x402.org`、query・userinfo・fragment・port なし。loopback は fixture の能力があるときだけ（http も可）。
- この URL は動的 URL の拒否ホスト（`denyHosts`）に入れる。
- hosted は env を足さない（既定を使う）。hosted の egress は、すでに x402.org を許しています（既存の x402 の受信）。
- 認証情報の要る facilitator は対象外（R6）。必要になったら別の変更にします。

### 3.8 診断

`source_settle` の往復の記録は、今は SubEtha の settle の 1 回分です。これを reconcile の最後の 1 回分にします（`facilitator: "x402"` のまま）。
bind と外部の送信は、診断には出さず ledger にだけ残します。

### 3.9 入れ替えの順番

新しい Router は bind を呼びます。SubEtha が bind の route を出していなければ、bind は 404 で、新しい Router は何も送らず `unknown` を返します（売れない）。
bind の route は protocol の `b02b249` で入りました。今の hosted の SubEtha はそれより前の版の見込みです（SubEtha の担当の回答、2026-11-22。確定には Provider token での読み取りが要ります）。

入れ替えには 2 つの形があり、どちらにするかはオーナーが決めます（手順は `docs/DEPLOY.md` §2i）。

1. Router と SubEtha を同じ作業の窓で入れ替える（先に実証の受付を止める）。
2. SubEtha を先に、relay と bind の両方を持つ版（`b02b249`）に上げ、新しい Router を入れて確かめ、最後に relay の無い版（`f30e4bb`）に上げる。停止の窓はありません。

古い settle への fallback は Router に入れません：1 つの注文が 2 つの経路に入るのを避けるためです。

### 3.10 fixture の SubEtha と本物の facilitator を混ぜない

SubEtha の facilitator が loopback（fixture）なのに、送る先が loopback でなければ、起動を止めます。
試験が設定を忘れて、第三者のサービスへ authorization を送るのを防ぐためです。

### 3.11 hosted の入口

host の env `SUBETHA_EXACT_SETTLE_FACILITATOR_URL`（任意）を、子の Router の `ROUTER_SUBETHA_EXACT_SETTLE_FACILITATOR_URL` に渡します。
本番では設定しません（既定を使う）。試験の fixture が loopback の facilitator を渡すための口です。

### 3.12 外部の facilitator が断った理由の記録（2026-11-23 の追加）

きっかけ：本番への入れ替えの直後、x402.org が 1 件の送信を `200`・`success: false` で断りました（`docs/DEPLOY.md` §2i の記録）。
支払いは動いていませんでしたが、理由の欄を記録していなかったので、原因が分かりませんでした。

- **残すもの**：`submit` の `answered` の行に `reason` を 1 つ。外部の答えが「はっきり断った」もの（200 で `success === false`、または 4xx）で、本文が JSON の object のときだけ付けます。
- **値**：本文の `errorReason` を、既存の理由の表（`src/shared/payment-reasons.ts`、`r1/x402-2.28.0`）で分類した固定の語です。表に完全一致すればその token、
  欄が無い・値が `null` なら `absent`、それ以外で文字列でない・空なら `malformed`、表に無い文字列なら `unrecognized`。前方一致や読み替えはしません（`docs/rejection-reasons-design.md` と同じ規則）。
- **残さないもの**：相手の生の文字列。表に無い理由は `unrecognized` としか分かりません。そのときは、表を足すか、verify で再現して調べます。
- **変えないもの**：結果の決め方（§3.2）と待ち方（§3.4）。`reason` は記録のためだけで、どの判断にも使いません。買い手への答えにも出しません。
  200 で成功と言った答え、答えと読めないもの（5xx・JSON でない・例外）には付けません。4xx は本文が何を言っていても断った答えとして扱うので、本文が object なら付きます（`success: true` と書いてあっても）。
- **診断の記録（§3.8）は変えません**。`source_settle` の行は今までどおり reconcile の最後の 1 回分です。
- **受け入れ**：表の語・表に無い語・文字列でない値・欄なし・4xx の各場合に、行の `reason` が上の値になること。生の文字列が ledger の file に出ないこと。
  成功と言った答えと 5xx の行に `reason` が無いこと。どの場合も `settle` の結果が変わらないこと（`tests/unit/subetha-exact-classify.test.ts`・`tests/unit/subetha-exact-adapter.test.ts`）。

## 4. 受け入れ

- **AC-1** 正しい購入：bind 1、外部の送信 1、reconcile ≥ 1、SubEtha の `…/settle` は 0。結果は `settled`、`txRef` は chain の支払いの hash。
- **AC-2** bind が `bound` 以外（`already-used`、409 の各 code、403、404、503、500、読めない、時間切れ、identity の不一致）：外部の送信は 0。
- **AC-3** 送信の印が書けない：外部の送信は 0、結果は `unknown`。
- **AC-4** 同じ注文の 2 回目の `settle`（同時、別の attempt から、再起動のあとを含む）：外部の送信は合計で最大 1。印のあと・送る前に落ちた場合は合計 0。
- **AC-5** 外部が「成功」と答えても chain に支払いが無い：結果は `unknown`（`settled` にしない）。
- **AC-6** 外部が断った、または答えない：reconcile が一致する `accepted` を返さない限り `unknown`、`mayStillSettleUntil` は authorization の `validBefore`。
- **AC-7** 外部は断ったが、**同じ authorization** を別の送信者が chain に載せていた：reconcile が `accepted` なら `settled`。外部の hash と chain の hash が違えば chain の hash を使う。409 のあとと `already-used`（`recorded` の両方）でも同じ。
- **AC-8** reconcile の `accepted` で、identity か `txHash` が合わない：`unknown`。
- **AC-9** ledger、note、診断に token、署名、外部の facilitator の URL と自由な文が無い。外部の facilitator への要求に `Authorization` が無い。SubEtha への要求にはある。
- **AC-10** env の検査：allowlist の外の host、query 付き、fixture の能力の無い loopback は起動を拒否。env が無ければ既定の URL。その host が `denyHosts` に入る。
- **AC-12** `settle` 全体が予算（本文の読み取りと待ちを含む）を越えない。新しい行を含む ledger を、event を知らない読み手が読める。
- **AC-11** Router の process を通した wire の試験（quote の入口と標準の x402 の入口）が、新しい fixture で通る。
- 緑の試験は、守っている code を壊して落ちることを確かめる（bind の検査、送信の印、identity の照合、`accepted` の条件）。

実際の testnet の購入（手元の SubEtha の daemon、`router-local` の tenant、x402.org）は、実装のあとに 1 件行い、
注文の一覧に `settlePath: "provider"` と `settleRoute: "external"` が出ることを見ます。本番の入れ替えは別の作業です（オーナーの判断）。

## 5. タスク

1. `src/shared/subetha-exact.ts`：settle 用の facilitator の URL の定数、env の名前、検査。`src/config.ts`・`src/main.ts`：読み取り、能力の検査、`denyHosts`、adapter への受け渡し。
2. `subetha-exact-classify.ts`：`classifyBind`、`classifyReconcile`、`classifySubmit`、`sigSha256Of`。`classifySettle` は消す。
3. `subetha-exact-ledger.ts`：event `bind`・`submit`、注文ごとの「送った」の索引。
4. `subetha-exact.ts`：新しい `settle`。
5. fixture：SubEtha の fixture に `bind`・`reconcile`、settle は送らない形に。外部の facilitator の fixture（同じ「chain」を共有）。
6. 試験：unit（分類、adapter、ledger、設定）、wire（process、再起動）、壊して落ちる確認。
7. 文書：もとの設計の表 B に置き換えの注記、README、DEPLOY（順番と費用）、`CLAUDE.md` は変更なし。
8. testnet の購入 1 件と記録。
