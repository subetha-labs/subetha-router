# T8 要件 — x402 受信レグ（P4: x402 受信 → MPP Provider B）

- 起案: 2026-09-26 JST。**オーナーが P4 の DEFER を解除**（「受信レグを x402 で受け付けられるように」）。
- 前提: T1–T7 受け入れ済み（HEAD `84b78f0`）。送信レグは A/B とも実決済到達済み。
- ラベル: `T8-x402-inbound`

## 1. 何を実現するか

**「x402 しか持っていない人が、MPP でしか払えない Provider B を使える」**を実演可能にする。

```
クライアント ──①x402 で支払い──> Router ──②MPP で支払い──> Provider B
                                                    （`provider-mpp.subethalabs.com`）
              受信レグ(Base Sepolia USDC)   送信レグ(Tempo pathUSD)  ← 実決済済み
```

- 2 レグは**交換でもブリッジでもなく独立した支払い**。FX 変換もしない（要件 §1 を維持）。
- 障壁は本物: x402 の credential では MPP の Provider には払えない。
- 審査員は x402 と MPP の**両方を知っている**ので、越えた障壁が伝わる。

**現状との差分は受信レグだけ。** 送信レグ（B への MPP 実決済）は T7 で到達済み
（tx `0x84157b93...ea69`）。

## 2. 調査で判明している事実（親が実測）

- **core は受信レールの scheme 名で分岐していない。** `src/core/**` に
  `subetha-zerc20` / `SUBETHA_SCHEME` のヒットは 0。core は `InboundRail`（4 メソッド）越しにのみ触る。
- **【訂正・独立レビュー指摘】ただし「core 改修は不要」は誤りだった。**
  - `src/http/projection.ts:48` が **`rail: "subetha"` をハードコード**している。
    x402 受信で quote を出すと **R2 の公開射影が実レールを偽る**。ここは必ず直す（T8-12）。
  - SubEtha への結合は 2 箇所ではなく、`src/main.ts:16`（import）/`:96`/`:142` の **3 箇所**に加え、
    `src/config.ts:111-112, 342-344, 359-361`（`ROUTER_SUBETHA_FACILITATOR_URL` 等、
    **受信 facilitator URL の構成キーが SubEtha 専用名**）。
  - core の `RouterCoreOptions.inbound` は**単一の `InboundRail`**（`src/core/orchestrator.ts:105`）。
    route ごとの受信レール切り替えは、送信側 `railByRoute`（`src/main.ts:61-84`）と同じ
    **合成側のラッパで実現する**（core の契約は変えない）。
- **受信ポートの形は x402 に近いが同一ではない。** `PaymentCredential` は
  `{x402Version, accepted, payload}` だが `payload` に **Router 独自の `challengeNonce` が必須**、
  `InboundOffer.extra` も `challengeNonce`/`expiresAt`/`routeBinding` が必須。
  「既に x402 形」は言い過ぎで、**封筒形が同じ**というのが正確。
- **受信ポートは既に x402 形。** `PaymentCredential` は `{x402Version, accepted, payload}`、
  `InboundOffer` は `{scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra}`。
- **SubEtha adapter は x402 と同じ封筒で POST している。** `subetha.ts:198-217` が
  `{x402Version:2, paymentPayload, paymentRequirements}` を `/verify` `/settle` に送る。
  ただし `paymentPayload` の中身は Router 独自形なので、**実 facilitator が受理するかは未確認**。
  → 「新規プロトコル実装ではない」とまでは言えるが、**そのまま通る保証はない**。
- **実 facilitator は稼働中**（親が実測）: `/supported` 200、`/verify` `/settle` 実在。
- **`unexpected_error` で facilitator が内部例外を漏らす**（親が再現。1 ケース限定ではない）。
  ただし既存 verify は `isValid` しか読まず `invalidMessage`/`error` を参照しないため
  Router の応答には出ない。

## 3. 満たすべき要件

- **T8-01** x402 受信 adapter（`InboundRail` 実装）を追加する。**core を変更しない。**
  `src/main.ts` は route の受信レール指定で adapter を選ぶ（未指定は従来どおり SubEtha）。
- **T8-02 （新規・重要）Router 自身の受取アドレスを構成に持つ。**
  SubEtha は facilitator から challenge を取得して `payTo` を得ていたが、
  **x402 受信では Router が payee として自分の requirements を発行する**ため、
  `source.payTo`（受取先）と受信 facilitator URL が構成に要る。
  現在の `source` 構成には `payTo` が**無い**（`src/config.ts:209-214` の `SourceTerms`）ので追加する。
  **影響範囲（独立レビューが実測）**: 必須追加にすると `parseRoute` が**既存の全 route 設定を
  `ConfigError` で弾く**。`source: {...}` を組む既存サイトは最低 6 箇所
  （`tests/fixtures/router-harness.ts:36`, `tests/fixtures/chat-crossimpl-harness.ts:67`,
  `tests/unit/lifecycle.test.ts:35`, `tests/wire/mpp-cli.test.ts:94`,
  `tests/wire/x402-cli.test.ts:93`, `tools/t7-router-e2e.ts:49`）。
  → **`source.payTo` は optional とし、x402 受信レールを選んだ route でのみ必須**にする
  （SubEtha 経路は従来どおり facilitator から取得）。T8-10 の「既存テストを壊さない」と両立させる。
  受信 facilitator URL も **SubEtha 専用キーとは別のキー**を用意する。
- **T8-03 nonce と束縛。** 発行した requirements に `challengeNonce` / `expiresAt` /
  `routeBinding` を持たせ、**strict preflight が journal 生成前に検査する**。
  **【訂正】「発行していない nonce の拒否」を担保しているのは adapter ではない。**
  独立レビューの指摘を親が確認: SubEtha adapter に nonce 台帳は**存在しない**（grep ヒット 0）。
  担保源は core 側で、`quoteId = challengeNonce`（`src/core/orchestrator.ts:337`）として journal に載り、
  購入時に `store.byQuoteId` で引けなければ `unknown_quote` になる（`src/core/store.ts`）。
  → x402 自己発行でも**同じ `quoteId = challengeNonce` 経路に乗せれば強度は維持できる**。
  そのうえで以下を要件とする:
  - nonce は **CSPRNG 生成**（`NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/`、`subetha.ts:61` に適合）
  - **再起動をまたいでも一意**であること（journal の識別子衝突検査に委ねるだけにしない）
  - 衝突時（`IntentCollisionError` 相当）は **fail closed**。既存購入を上書きしない
- **T8-04 verify-before-settle を維持。** `verify` が `isValid:true` を返すまで settle しない。
  **HTTP ステータスで成否を判断しない**（拒否でも 200 が返る）。`isValid` のみを読む。
- **T8-05 例外を漏らさない。** facilitator の `invalidMessage` / `error` を
  **読まない・転送しない**。理由コードは既存の安全な固定集合に限る。
- **T8-06 `unexpected_error` の扱い。** verify 段（課金前）は `isValid:false` で進まない。
  **settle 段で 5xx / `unexpected_error` なら `unknown`**（課金有無を断定できない）。
  **自動再 settle しない**（D-01 を解除しない）。
- **T8-07 余剰フィールド（決定事項。先送りしない）。**
  現行 preflight は `stableJson(accepted) !== stableJson(offer)` の**完全一致**（`subetha.ts:192`）。
  **標準の x402 クライアントは `resource` / `extensions` を付けるのが普通なので、
  このままだと実デモで必ず `offer_mismatch` になる**（独立レビュー指摘。親が該当行を確認）。
  → **決定**: 完全一致の対象は **Router が発行したフィールドに限定**する。
  `accepted` の中で Router 発行分（`scheme`/`network`/`asset`/`amount`/`payTo`/
  `maxTimeoutSeconds`/`extra` の Router 発行キー）を**一つでも欠くか値が違えば拒否**し、
  **それ以外の追加キー（`resource`/`extensions` 等）は束縛対象外として無視する**。
  「未知キーがあれば通す」ではなく「**Router 発行分は全部一致していなければ通さない**」。
- **T8-08 両レグの独立性。** 受信レグの資産・額・ネットワークと送信レグのそれは**別枠**。
  FX 変換・ブリッジをしない。budget bucket も両レグ別々に強制する。
- **T8-09 at-most-once。** 受信 settle 済みで送信が `unknown` の場合、**自動再送しない**。
  受信・送信の順序（source-before-destination）を維持する。
- **T8-10 テスト。** 合成 facilitator 相手の無課金テストで
  受信 adapter の拒否面（nonce 不一致・期限切れ・束縛不一致・requirements 改竄）を検証する。
  既存 182 テストを壊さない。実決済テストは既定の `npm run test` に含めない。
- **T8-11 実決済の到達。** x402 受信 → MPP 送信（Provider B）を**実チェーンで 1 回通す**。
  受信 tx と送信 tx の両方を証拠として残す。
  **AC-4 との関係を誤らない**: `docs/requirements.md` の AC-4 は
  **「SubEtha 受信レグが実ランタイムで settle」**と明記されている。
  x402 受信で実決済を達成しても **AC-4 は文言上は未達のまま**であり、
  「AC-4 達成」と主張しない（README にもそう書く）。

- **T8-12 公開射影が実レールを偽らない。** `src/http/projection.ts:48` の `rail: "subetha"`
  ハードコードを実レールに一致させる（R1 の `destination.rail` と同様に route 構成から導く）。
  README の到達範囲表記も実態に合わせる。
- **T8-13 Router が payee になることで生じるリスク**（新規）:
  - **受取アドレスの鍵から送金しない。** 鍵ファイルが存在する以上「Router が受取資金を動かせる」
    状態なので、**T8 の範囲では受取アドレスからの送金を一切行わない**ことを境界として固定する。
  - **`payTo` が Router のものであることを起動時に検査する。** 送信側は `selectOffer` が
    `route.destination.payTo` を照合している（`src/core/orchestrator.ts:186-189`）が、
    **受信側に対応物が無い**。構成の `source.payTo` と発行 offer の `payTo` の一致を検査する。
  - **着金額の扱いを明示する。** facilitator が `isValid:true` を返しても、実際の着金額が
    `offer.amount` と一致する保証は Router 側にない。**「金額検証は facilitator の verify に委ねる」**
    と明記し、Router が独自に着金額を主張しない。
- **T8-14 受信課金後の各終端状態で証跡を残す**（新規）。受信が実課金になった以上、
  送信側の失敗 5 通り（`orchestrator.ts` 実測: `paid_data_unavailable` /
  `paid_no_data` / 例外 → `unknown` / 再照合失敗 → `paid_undelivered` /
  `contentType` 欠落 → `unknown`）の**いずれでも「クライアントの金が動いた」状態**になる。
  **各終端で受信 `txRef` が journal と公開射影に残る**こと（`projection.ts:102` が `source.txRef` を出す）。
- **T8-15 デモ当日の運用要件**（新規）:
  - 審査員が使う**クライアント手順**（どの x402 クライアント／SDK／ウォレット）を README に固定する。
    T8-07 の余剰フィールド問題はここで顕在化するため、**実際に使う想定のクライアントで検証する**。
  - 審査員のウォレットに **Base Sepolia USDC とガス**が要る。用意できない場合の
    **fallback（既存の使い捨て鍵で払う経路）を残すか**を決める。
  - **累計上限 50000 base units = 5 回分**。審査員が複数人試すと即 `bucket_limit`。
    デモ枠として何回想定かを決め、上限に達したときの見せ方を用意する。
  - **`unknown` が出たときに何を見せるか**（D-01 で自動解決しない以上、人手の説明が要る）。
- **T8-16 受信 offer の有効期限がデモの操作時間を賄う。**
  `maxTimeoutSeconds` 既定 120 秒、承認期限は `min(now+approvalTtlMs, offerExpiry)`
  （`orchestrator.ts:330-332`）。**審査員が手で払う時間**を賄う値にする。

## 4. 決済スコープ（T7 §2 を受信レグ分に拡張）

| 項目 | 受信レグ（新規） | 送信レグ（T7 既存） |
|---|---|---|
| ネットワーク | Base Sepolia `eip155:84532` | Tempo Moderato `eip155:42431` |
| 資産 | USDC `0x036CbD53...CF7e` | pathUSD `0x20c0...0000` |
| 1 回あたり上限 | **10000 base units（$0.01）** | 10000 base units |
| 累計上限 | **50000 base units** | 既存 50000 |
| 実行回数 | 検証で最大 5 回 | 既存のまま |
| 間隔 | **3 秒以上**（nonce 衝突回避） | 同左 |

**【訂正】「受信・送信で同一 facilitator」は T8 の構成では成立しない。**
T8 の送信レグは **MPP / Tempo**（x402 facilitator を使わない）。衝突が起こり得るのは
**受信レグ（x402 facilitator `www.x402.org`）を短時間に連続実行した場合**である。
peer 実測（0ms で 2/20 失敗、3 秒で 0/15）は**payer 側として同一 facilitator に連続決済した条件**での値。
受信レグは同じ facilitator を使うため**同種の制約を受けると想定**し、
**検証・デモとも 3 秒以上空ける**。ただしこれは推定であり、受信側としての実測は未取得（U-T8-2）。

## 5. 未確定（着手前に決める）

- **U-T8-1 受信レグの payer と受取先 → 解決（オーナー承認 2026-09-26）**
  - **payer 役（クライアント）**: 既存の使い捨て鍵 `0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1`
    （Base Sepolia USDC 19.98 保有）。デモ本番では**審査員が payer** になる。
  - **Router の受取先**: 新規の使い捨てアドレス
    **`0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405`**（鍵は
    `.claude_workflow/local/t8-router-receiver-key.env`、mode 600・gitignore 済み）。
    payer と別アドレスなので「自分から自分へ払う」偽の検証にならない。
    **受け取る側なので資金供給は不要。**
  - Provider A/B の payTo（`0x901404CC...`）とも**別**にする。
    同一にすると「誰が受け取ったか」がデモ上曖昧になるため。
- **U-T8-2 受信 facilitator の settle 挙動。** 成功・失敗形、**再呼び出し時の挙動**、
  受信 settle と送信 pay を同一 facilitator で連続させたときの挙動が未測定。
  peer が測定を申し出ている（実際に資金が動くので承認が要る）。

## 6. 境界（T8 で解除しないもの）

- P3（MPP 受信→A）/ P5（同一レール）は引き続き DEFER。
  **D-03 は「P3/P4/P5 と同一レールマトリクス」を一括で DEFER しているが、
  今回オーナーが解除したのは P4 のみ**。D-03 全体が解除されたと拡大解釈しない。
- finality（D-05）、AC-7（chat UI 上の因果）。
- push・公開・デプロイ（B-04）、chat worktree の編集。
- mainnet への送金（**一切行わない**）。

## 7. 受け入れ条件

- 受信 adapter の**拒否面**が無課金テストで確認できる（発行していない nonce・期限切れ・束縛不一致）。
- x402 受信 → MPP 送信の**実決済が 1 回通り**、両レグの tx が証拠として残る。
- 親のフルチェック（既存 182 + 新規）と独立レビュー LGTM。
- README に到達範囲と未達（P3/P5・finality・AC-7・受信 SubEtha）を明記する。
