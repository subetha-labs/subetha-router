# T8 設計 — x402 受信レグ（P4: x402 受信 → MPP Provider B）

- 対象要件: `docs/t8-requirements.md`（T8-01〜T8-16、独立レビュー1回反映済み）。ラベル `T8-x402-inbound`。
- 前提: T1–T7 受け入れ済み（HEAD `ebe32fb`）。送信レグ B は実決済到達済み。

## 1. 構成

```
payer(client) ──x402/Base Sepolia USDC──> Router ──MPP/Tempo pathUSD──> provider-mpp
  0xfCea8a89...                    受取 0xF88b0f34...            0x901404CC...
```

- 受信レグは**新規**。送信レグ（MPP → Provider B）は T7 のまま使う。
- 2 レグは独立した支払い。FX 変換もブリッジもしない。

## 2. 受信レールの選択（T8-01 / B-2 への回答）

core の `RouterCoreOptions.inbound` は**単一の `InboundRail`**（`src/core/orchestrator.ts:105`）。
**core の契約は変えず**、送信側 `railByRoute`（`src/main.ts:61-84`）と同形の
**合成側ラッパ**を `src/main.ts` に置いて route ごとに振り分ける。

`InboundRail` の 4 メソッドのうち `routeId` を直接受け取るのは `createOffer` だけだが、
残り 3 つは `offer.extra.routeBinding` を持つ。`routeBindingOf`（`src/config.ts:72-74`）は
`[routeId, "GET", canonicalPath]` を `encodeURIComponent` して `|` 連結するので、
**先頭要素を decode すれば `routeId` を復元できる**。これでラッパは 4 メソッドとも振り分けられる。

**実装上の必須注記（レビュー指摘）**:
- **`preflight` は同期関数**（`src/ports/inbound.ts:48`。core は `await` しない＝`orchestrator.ts:413`）。
  ラッパも**同期で返す**こと。`async` にすると `preflight.ok` が `undefined` になり
  **全購入が preflight 失敗で落ちる**。
- routeId の解決は **`routeBindingOf(route)` の逆引き Map を全 route から事前構築**し、
  binding をキーに引く（decode より堅牢）。**未知 binding は例外で fail closed**。

- 構成キー: `RouteConfig` に **`sourceRail`** を追加（既存 `rail` は送信専用。`src/config.ts:24-26`）。
  既定は `"subetha"` で、**未指定なら従来どおり**（既存構成・既存テストを壊さない）。
- `sourceRail: "x402"` の route だけ x402 受信 adapter を使う。

## 3. x402 受信 adapter（`src/adapters/inbound/x402.ts` 新規）

`InboundRail` を実装する。SubEtha 版（245 行）の派生で、違いは以下。

### 3.1 `createOffer` — Router が自分で requirements を発行する
SubEtha は facilitator から challenge を取得していたが、**x402 では Router が payee** なので自分で作る。

- **`scheme` = `"exact"`**（x402 の EIP-3009 経路。定数として adapter に持つ）。
- **`network` / `asset` / `amount` = 構成の `source.network` / `source.asset` / `source.amount`。**
  core は `amount`/`asset`/`network`/`routeBinding` を照合するが（`orchestrator.ts:329-335`）、
  **`scheme` と `payTo` は照合しない**ので adapter 側の責任。
- `payTo` = 構成の `source.payTo`（T8-02 で追加）。adapter は**自分の options として受け取る**
  （`CreateOfferRequest` を変えないので `src/ports/inbound.ts` は**変更不要**）。
  なお「構成の `source.payTo` と発行 offer の `payTo` の一致検査」は**同じ値の比較でトートロジー**なので
  検査としては弱い（レビュー指摘）。意味があるのは**運用者が Router の受取鍵に対応する
  アドレスを構成に入れること**であり、それは構成の責任として README に書く。
- `challengeNonce` = **CSPRNG 32 バイト**（`randomBytes(32)` → `0x` + hex）。
  既存 `NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/`（`subetha.ts:61`）に適合させる（T8-03）。
- `expiresAt` = `now + maxTimeoutSeconds`。`maxTimeoutSeconds` は**構成可能**にし、
  デモの操作時間を賄える値にする（T8-16）。
- `routeBinding` = `routeBindingOf(route)`（既存と同じ）。

**nonce の一意性の担保源は adapter ではなく core**（要件 T8-03 の訂正どおり）。
`quoteId = challengeNonce`（`orchestrator.ts:337`）として journal に載り、
再利用は store の識別子衝突検査で **fail closed** になる。adapter は台帳を持たない。

### 3.2 `preflight` — 束縛検査（T8-07 の決定を実装）
SubEtha 版は `stableJson(accepted) !== stableJson(offer)` の**完全一致**で、
標準 x402 クライアントが付ける `resource` / `extensions` があると必ず落ちる。

**x402 版は「Router 発行分の完全一致 + `extra` は未知キー禁止」に変える**:
- `credential.payload.challengeNonce === offer.extra.challengeNonce`（不一致は `nonce_mismatch`）
- 期限切れは `offer_expired`
- **`accepted.scheme !== "exact"` は `credential_mismatch`**（固定値検査。
  SubEtha 版の `accepted.scheme !== SUBETHA_SCHEME`（`subetha.ts:184-187`）に相当。
  `scheme` は core が照合しないので adapter で必ず見る）
- `scheme` / `network` / `asset` / `amount` / `payTo` / `maxTimeoutSeconds` が**すべて一致**
- `extra` の **Router 発行キー**（`challengeNonce` / `expiresAt` / `routeBinding`）が**すべて一致**
- **`accepted.extra` に Router 発行 3 キー以外が含まれていたら拒否**（`offer_mismatch`）。
  **【レビュー指摘による変更】** `extra` 内まで未知キーを許すと、
  EIP-712 domain を決める `name` / `version` 等を payer が差し込める余地が生まれる。
  T8-07 の動機（標準クライアントが付ける `resource` / `extensions`）は
  **`accepted` トップレベル**の話なので、**無視対象はトップレベルに限定**する。
- **`accepted` トップレベルの未知キー（`resource` / `extensions` 等）は束縛対象外**（無視する）。

**「未知キーがあれば通す」ではなく「Router 発行分が一つでも欠ける／違えば拒否、
`extra` に未知キーがあれば拒否」**。

### 3.3 `verify` / `settle` — 実 facilitator
SubEtha 版と同じ封筒（`{x402Version:2, paymentPayload, paymentRequirements}`）を
`POST {facilitator}/verify` `/settle` に送る。

- **【最重要】`paymentRequirements` は必ず Router 発行の `offer` から組む。
  `credential.accepted` は絶対に facilitator へ送らない。**
  既存 `requirementsOf(offer)`（`subetha.ts:129-139`）が正しい形で、`offer.extra`（Router 発行分）を送る。
  `accepted` 側を送る実装にすると **payer が requirements を丸ごと差し替えられる**（レビュー指摘）。
- **送信形**: `paymentPayload` は `{x402Version, scheme, network, accepted, payload}`。
  `scheme`/`network` を欠くと facilitator が 500 + 内部例外を返す（親が実測）。
- **`isValid` だけを読む**（T8-04/T8-05）。`invalidMessage` / `error` は**読まない・転送しない**
  （実 facilitator が内部例外を漏らすことを親が実測済み）。
- `status !== 200` → `verify` は `isValid:false`、`settle` は **5xx → `unknown`**（T8-06）。
- **自動再 settle しない**（D-01 を解除しない）。
- **着金額の独自検証はしない**（T8-13。金額検証は facilitator の verify に委ねると明記）。

## 4. 公開射影の訂正（T8-12 / B-1）

`src/http/projection.ts:48` の `rail: "subetha"` ハードコードを
**`route.sourceRail ?? "subetha"`** から導く（`destination.rail` が `route.rail ?? ...` と同形）。

**【最重要】既定値 `?? "subetha"` を必ず付ける。** chat 側の契約
（`router-contract.mjs:82` の `check(s.rail === 'subetha')`）が厳格で、
既存 harness（`tests/fixtures/chat-crossimpl-harness.ts` / `router-harness.ts`）は
**`sourceRail` を設定していない**（親が grep で確認、ヒット 0）。
既定値を落とすと `undefined` が出て **T5 の相互実装テストが即座に落ちる**。

**境界（README に書く）**: chat 契約は `offer.scheme === 'subetha-zerc20'` と
`extra` の exact キー集合も要求するため、**x402 受信 route は chat からは構造的に使えない**。
chat 互換 route（SubEtha）と x402 route は別物として並存させる。
これは**製品コードの変更**なので allowed file set に明記する。

## 5. 構成の変更（T8-02 / B-4）

- `SourceTerms` に **`payTo?: string`**（**optional**）を追加。
  `sourceRail: "x402"` の route でのみ必須とし、**SubEtha route では省略可**。
  → `parseRoute` が既存構成を弾かないので、既存 6 サイト・既存 182 テストを壊さない。
- 受信 facilitator URL は **`ROUTER_X402_INBOUND_FACILITATOR_URL`**（新キー）。
  既存の `ROUTER_SUBETHA_FACILITATOR_URL` とは**別**にする（SubEtha 専用名を流用しない）。
- budget に **Base Sepolia USDC の受信 bucket** を追加する（無いと `bucket_not_allowed`。N-5）。

## 6. 理由コード（N-4）

新しい拒否理由を足す場合は **`SAFE_PREFLIGHT_REASONS`**（`src/core/orchestrator.ts:223-229`）に
追加しないと `safeReason()` が fallback に潰す。既存コード（`nonce_mismatch` / `offer_expired` /
`offer_mismatch` / `route_binding_mismatch` / `credential_mismatch`）で足りる設計にし、
**新コードを増やさない**。

## 7. テスト（T8-10）

新規 `tests/wire/x402-inbound.test.ts`。合成 facilitator 相手の**無課金**。

| 検証 | 内容 |
|---|---|
| 正常系 | 発行 → preflight 通過 → verify → settle |
| **余剰キー許容** | `accepted` に `resource` / `extensions` があっても**通る**（T8-07 の要）|
| Router 発行分の改竄 | `amount` / `payTo` / `asset` / `network` / `challengeNonce` の各改竄で**拒否** |
| 期限切れ | `offer_expired` |
| 束縛不一致 | `route_binding_mismatch` |
| 発行していない nonce | core の `unknown_quote` に落ちる（購入経路で確認） |
| **例外を漏らさない** | facilitator が 500 + 内部例外を返しても応答に出ない |
| 射影 | `sourceRail: "x402"` の route で R2 の `source.rail` が `"x402"` |
| **既定値** | `sourceRail` 未指定の route は `source.rail` が **`"subetha"`**（T5 を壊さない） |
| **`extra` 未知キー** | `accepted.extra` に Router 発行 3 キー以外があれば **拒否** |
| **受信 txRef** | 送信失敗の各終端でも `source.txRef` が journal と射影に残る（T8-14） |

既存 182 テストを壊さない。**実決済テストは `npm run test` に含めない**（`tools/` から明示実行）。

## 8. 実決済（T8-11）

`tools/t8-crossrail-e2e.ts`（新規）: payer が x402 で Router に払い、Router が MPP で
provider-mpp に払う縦貫を**実チェーンで 1 回**通す。

- payer は既存の使い捨て鍵（USDC 19.98 保有）。Router の受取先は `0xF88b0f34...`（別アドレス）。
- **境界: Router の受取アドレスから送金は一切しない**（T8-13）。受け取るだけで、鍵は保管のみ。
- スコープをコードで強制（受信: Base Sepolia / USDC / 10000 / payTo は Router 受取先）。
- **3 秒以上空ける**（受信レグの連続実行制約）。
- 受信 tx と送信 tx の**両方**を証拠として保存。

## 9. 変更対象ファイル（allowed file set）

1. `src/adapters/inbound/x402.ts`（新規）
2. `src/config.ts`（`sourceRail` / `source.payTo?` / 新 env キー）
3. `src/main.ts`（受信ラッパと adapter 選択）
4. `src/http/projection.ts`（`rail` ハードコード訂正）
5. `tests/wire/x402-inbound.test.ts`（新規）
6. `tests/fixtures/x402-inbound-facilitator.ts`（新規。合成 facilitator）
7. `tools/t8-crossrail-e2e.ts`（新規）
8. `README.md` / `docs/tasks.md`
9. `runtime/` 配下の Router 構成 JSON（x402 route を実際に起動するために必要）

**`src/ports/inbound.ts` は変更しない**（`payTo` は adapter の options で持つ）。
`NONCE_PATTERN` / `ADDRESS_PATTERN` は **x402 adapter 側で重複定義**する
（既存 `subetha.ts` を変更しないため）。

**変更しない**: `src/core/**`（core の契約は変えない）、既存 adapter、既存 fixture、既存テスト、
`tsconfig.json`、`vitest.config.ts`、chat worktree。
上記以外が必要になれば**停止して報告**する。

## 9b. デモ運用（T8-15）

- 審査員が使う **x402 クライアントを README に固定**する。
  T8-07（`resource` / `extensions`）はここで顕在化するので、
  **実際に使う想定のクライアントで実決済を通してから README に書く**。
- 審査員のウォレットに **Base Sepolia USDC とガス**が要る。
  用意できない場合の **fallback（既存の使い捨て鍵で払う）を残す**。
- **累計上限 50000 base units = 5 回分**。上限到達時は `bucket_limit` で止まるので、
  その見せ方（「上限で止まる」こと自体が安全機構である説明）を用意する。
- **`unknown` が出たときの説明**を用意する（D-01 で自動解決しないため人手の説明が要る）。

## 10. 未解決・リスク

- **【解決済み・親が実測】実 facilitator は Router 発行の requirements を受理する。**
  設計中に無課金 verify（settle は呼んでいない）で確認した:
  - `paymentPayload` に **`scheme` / `network` をトップレベルに含めないと HTTP 500**
    （facilitator 内部の `reading 'scheme'` 例外）。
  - **含めれば HTTP 200** で機械可読な拒否が返る:
    `{"isValid":false,"invalidReason":"invalid_exact_evm_signature","payer":"0xfCea8a89..."}`
    （署名が偽物なので拒否は正しい。`payer` も正しく復元されている）。
  - **`extra` に Router 独自キー（`challengeNonce` 等）を載せても 200 が返る**ことも確認。
  → **requirements の「形」は受理されることを確認した**（200 が返る）。
    ただし**正しい署名で `isValid:true` が返るかは未検証**
    （`invalid_exact_evm_signature` は「署名が偽物」以外の理由でも出得る）。
    実決済の最初の 1 回で確かめる。`paymentPayload` は
    `{x402Version, scheme, network, accepted, payload}` の形で送る必要がある。
    現 `PaymentCredential` 型は `{x402Version, accepted, payload}` なので、
    **adapter が verify/settle へ送る直前に `scheme`/`network` を補う**（型は変えない）。
- 受信 settle の成功・失敗形、再呼び出し挙動は**未測定**（U-T8-2）。
- **AC-4 は達成しない**（文言上 SubEtha 受信を要求）。
