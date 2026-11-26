# 上流が 402 で断った支払いが使われていないことを確かめる 要件・設計 v1

オーナーの選択（2026-11-26、残りの課題 ②(a) の案 1）：再送はまだ作らない。Provider A が自前の facilitator（E-FAC-H、2026-11-26 01:37Z の G-B4 から）でも同じ失敗をするかを見る。今は、断られた支払いが**上流で使われていない**ことを、運用者が後から確かめられるようにする。

## 1. 背景

- 静的な x402 の上流（`src/adapters/outbound/x402.ts`）は、署名を送った後に 402 を受けると `rejected`（`destination_rejected`）で終わる。再署名も再送もしない。買い手は `paid_data_unavailable` になる。
- 本番の 2 件（`722fb5c5`、2026-11-24 13:36Z。`a6adafb2`、2026-11-25 16:05Z）がこの形だった。どちらも Provider A が x402.org の facilitator を使っていた時期。
- 2 件の `authorization` の nonce は journal に無い（診断には hash だけ）。そこで、Router の送信鍵の `AuthorizationUsed` と `Transfer` を、どちらも 10 分の窓で調べた（§5）。
- EIP-3009 の `authorization` は `block.timestamp < validBefore` の間だけ使える。時刻が `validBefore` 以上の**確定した**（`finalized`）ブロックで `authorizationState(from, nonce)` が `false` なら、その支払いは上流に届いておらず、今後も届かない。
- `validBefore` は x402 の SDK（`@x402/evm` の `createEIP3009Payload`）が「署名した時刻（Router の時計）+ offer の `maxTimeoutSeconds`」で決める。Provider A の `maxTimeoutSeconds` は 60 秒（遅い設定で 120 秒）。

## 2. 要件

- **U-1（記録）** 静的な x402 の上流に署名を送り、402（と、5xx 以外の 200・502 でない応答で `rejected` になるもの）を受けた時、`dest_failed` の行に `authorization: { network, asset, from, nonce, validBefore }` を足す。
  `validBefore` は 10 進の秒の文字列。値は送った `authorization` の値（承認値から作り直さない）。読めなければ欄を足さない（結果は変えない）。
- **U-2（範囲）** `not_sent`・`unknown`・`paid`・`paid_no_data` の行は変えない。動的な上流（`x402-dynamic.ts`）、SVM、MPP は範囲外。状態（`store` の射影）、買い手への応答、一覧は変えない。
- **U-3（秘密）** nonce・`from`・`validBefore` はチェーンに出る公開の値で、`validBefore` の後は使えない。署名（`signature`）は記録しない。
- **U-4（確かめる道具）** 運用者の CLI `npm run outbound:unused -- --journal <path> --payment <paymentId> --rpc <https URL>`。読むだけで、journal にも chain にも書かない。
  1. journal の `dest_failed` の行の `authorization` を読む。無ければ `no_authorization_recorded`。
  2. RPC の `eth_chainId` が `network` の chain id と違えば `chain_mismatch`。
  3. `eth_getBlockByNumber("finalized")` の時刻が `validBefore` より小さければ `too_early`（確定したブロックがまだ期限に届いていない）。
  4. その確定したブロックの hash を指定して（EIP-1898 の `{ blockHash, requireCanonical: true }`）、`asset` のコントラクトに `authorizationState(from, nonce)` を `eth_call` する。
     `false` なら **`unused_after_expiry`**（上流は受け取っておらず、今後も受け取れない）。`true` なら **`used_or_canceled`**（使われたか、`cancelAuthorization` で取り消された。支払いの有無は `Transfer` で別に確かめる）。
  5. RPC の失敗・形の違いは `rpc_error`（固定文。URL の query は出さない）。
  出力は 1 行の JSON（`paymentId`、`result`、`blockNumber`、`blockHash`、`blockTimestamp`、`validBefore`）。終了コードは `unused_after_expiry` と `used_or_canceled` で 0、それ以外は 1。
- **U-4b（前提）** この確かめが成り立つのは、送った支払いが `exact` の EIP-3009 で、EIP-712 の `verifyingContract` が `asset` の時だけ。今の静的な x402 の上流は、`ExactEvmScheme` だけを登録し、署名器の検査で `verifyingContract == asset` の EIP-3009 以外を署名しない（Permit2・`upto` は署名しない）。この検査は変えない。記録の欄は、この検査を通って送った `authorization` だけから作る。
- **U-5（RPC）** https だけ（`--allow-loopback` の時だけ loopback の http）。redirect は拒否、応答は 64 KiB まで、1 回 10 秒。
- **U-6（文書）** `docs/DEPLOY.md` §2i に使い方と、2 件の確かめの記録（§5）。

## 3. 設計

- `src/ports/outbound.ts`：`rejected` に任意の `authorization?: SentAuthorization`（`network`、`asset`、`from`、`nonce`、`validBefore`）。
- `src/adapters/outbound/x402.ts`：送った `payload.payload.authorization` から `SentAuthorization` を作る（`evmCidInputOf` と同じ読み方。`validBefore` は文字列か数）。`baseOutcomeOf` の `rejected` の 2 か所で付ける。
- `src/core/orchestrator.ts`：`rejected` で `authorization` が形どおり（アドレス 2 つ、nonce は 0x と 64 桁、`validBefore` は 10 進）なら `dest_failed` の行に写す。違えば写さない。
- `tools/outbound-unused.ts`（新規）と `package.json` の script。chain id は `eip155:<n>` から取る。`authorizationState(address,bytes32)` の selector は `0xe94a0102`。
- journal の行の検査は、その `paymentId` の最後の `dest_failed` の行だけを見る。

## 4. 受け入れ

- **AC-1** 402 で `rejected` の時、`dest_failed` の行の `authorization` が送ったヘッダの値と一致する（試験の上流がヘッダを解いて比べる）。署名は行に無い。
- **AC-2** `not_sent`（送る前の拒否）・`unknown`（5xx、transport の失敗）・`paid` の行には欄が無い。既存の journal の golden は変わらない。
- **AC-3** CLI：`unused_after_expiry`、`used_or_canceled`、`too_early`、`no_authorization_recorded`、`chain_mismatch`、`rpc_error` をそれぞれ偽の RPC で。確定したブロックの時刻が `validBefore` − 1・ちょうど・+ 1 の境目。`eth_call` の宛先が `asset`、引数が記録の `from` と nonce、ブロックの指定が確定したブロックの hash（`requireCanonical: true`）であること。
- **AC-3b** 取り違えの反例：偽の RPC が、記録の `from`・nonce・`asset` の組だけに `true`、それ以外に `false` を返す時、結果は `used_or_canceled`（別の nonce・別のコントラクト・別の `from` に問い合わせると `false` になり、試験が落ちる）。取り消し（`cancelAuthorization` の後）は `true` なので `used_or_canceled`。
- **AC-2b** 欄のある行と無い行（変更前の journal）の両方を、再起動の後も読める（状態は今と同じ）。
- **AC-4** 壊して落ちることを確かめる（欄を付けない、`validBefore` の待ちを外す、`true`/`false` を入れ替える）。全体の試験は Linux。

## 5. 過去の 2 件の確かめ（2026-11-26、読むだけ）

公開の RPC `https://sepolia.base.org`。Base Sepolia の USDC `0x036C…CF7e` の、Router の送信鍵 `0x5d78…2274` を authorizer にした `AuthorizationUsed` と、送信鍵からの `Transfer`。

照会：`eth_getLogs`、`address` = USDC、`topics` = [`AuthorizationUsed(address,bytes32)` の topic、送信鍵]、と [`Transfer` の topic、送信鍵（from）]。200 ブロックずつ。窓の端はブロックの時刻の二分探索で決めた（Base Sepolia は約 0.2 秒に 1 ブロック）。

| 購入 | journal（Router の時計） | 窓（ブロックの時刻） | `AuthorizationUsed` | `Transfer` |
|---|---|---|---|---|
| `722fb5c5` | `created` 13:36:24.3Z、`destination_pending` 13:36:29.9Z、`dest_failed` 13:36:31.3Z（2026-11-24） | 13:35:24Z〜13:46:31Z（63,027,276〜63,030,611） | 0 | 0 |
| `a6adafb2` | `created` 16:05:43.6Z、`destination_pending` 16:05:48.9Z、`dest_failed` 16:05:50.6Z（2026-11-25） | 16:04:43Z〜16:15:50Z（63,504,071〜63,507,406） | 0 | 0 |

- 窓の始まり：`created` の 60 秒前。署名は `destination_pending` より後。
- Router の時計とチェーンの時刻：同じ購入の受信の settle の tx（`0xa39db8b0…` はブロック 63,027,597、時刻 13:36:28Z。`0xff3095bd…` はブロック 63,504,388、時刻 16:05:46Z）を、Router は 1.3〜1.8 秒後（13:36:29.3Z、16:05:47.8Z）に `source_settled` と記録した。ずれは受領の遅れの範囲で、窓の始まりの 60 秒より十分小さい。
- 窓の終わり：`validBefore` は署名の時刻 + 選んだ要求の `maxTimeoutSeconds`。2 件とも、`created` の行の承認した上流の offer（`destination.selectedOffer`）は `maxTimeoutSeconds: 60`。承認した offer にこの欄がある時、Router は同じ値の要求にしか署名しない（`sameOfferFields`）。よって `validBefore` は署名の 60 秒後で、窓は `dest_failed` の 600 秒後まで続く。
- 確定：照会した時（2026-11-26）の `finalized` はブロック 63,765,819（hash `0x9044201e…596f5a`、06:37:12Z）。どちらの窓もそれより前。
- 陽性対照：同じ照会で、2026-11-26 の G-B4 の購入の窓（63,676,200〜63,676,399）では、どちらも 1 件（tx `0x319f9ab2…`）見つかる（照会の形が正しいことの確認。窓の広さの確認ではない）。

結論：この窓で、送信鍵の `authorization` は使われず、送信鍵から USDC は動いていない。期限を越えた後も使われていないので、**上流への支払いは起きていない**。買い手（testnet の zUSDC。自分たちの鍵）への返金はしない。
