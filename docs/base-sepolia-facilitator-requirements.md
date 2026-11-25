# 要件: Base Sepolia の決済を自前の facilitator に移す（第 2 版、2026-11-26）

> owner の依頼（2026-11-26「おすすめで」）: 案 A（自前の facilitator）の要件と設計を文書まで。Provider A の Base Sepolia 版は `providers/x402-workers` に足す案で設計する。
> **この文書の範囲は要件と設計だけ。** 実装・鍵・資金・Worker の配備・本番の変更は、それぞれ owner の go が要る（§6）。
> 下敷き: `docs/evm-testnets-hosted-requirements.md`・`-design.md`（新 3 チェーンの自前 facilitator。本番で稼働中）。その決定と不変条件は変えず、Base Sepolia に広げる差分だけを書く。

## 1. なぜ

**事実（2026-11-25〜26、読み取りだけで確認）**

- hosted の Router の Base Sepolia USDC の受信（`INBOUND.facilitator`）と Provider A（`provider-x402.subethalabs.com`）の決済は、どちらも x402.org の facilitator を使う。
  Provider A の側は、成功した支払いの tx が x402.org の署名者から送られていることから分かる（Provider A のコードは手元に無い）。
- x402.org の `/supported` が示す EVM の署名者は 1 つ（`0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`）。
- 2026-11-25 16:04:52Z〜17:08:19Z、この署名者は送信していない（残高 約 0.0000023 ETH）。その間の 16:05:49Z に、Router の `md-zusdc-eth-snapshot` の購入が
  Provider A に断られた（402、`invalid_exact_evm_transaction_failed`）。買い手の支払いは成立し、データは届かなかった（`paid_data_unavailable`）。Provider A 宛ての tx は、その時刻の前後に無い。
- 2026-11-25 19:30:36Z にも、残高 約 0.000000094 ETH、直近 9,000 block（約 30 分）で送信なし。今の Base Sepolia の USDC の settle 1 回の費用（実測 約 0.00000065〜0.00000087 ETH）より少ない。19:37:24Z も同じ（残高・nonce とも変化なし）。**同様の低残高・送信なしを再び観測した**（この時間の決済の失敗は確かめていない）。
- 2026-11-24 の失敗（`722fb5c5`）では署名者の残高が十分で、前後の送信も続いていた。**原因は別で、分かっていない。** 2026-10 にも、条件の決まらない Provider A の拒否がある（`docs/DEPLOY.md` §2g）。

**推測**: gas 切れが 11-25 の失敗の原因で、低残高の間は x402.org の Base Sepolia の決済が失敗する（x402.org のエラーの本文は見られないので断定できない）。

**直したいこと**: 他者の facilitator の gas 切れで、買い手が払った後に商品が届かないこと。Router の送り直しでは直らない（停止は 1 時間続いた）。

## 2. 範囲

- **入る**: (P) Provider A と同じ契約の Base Sepolia 版の Provider を自前の facilitator で運用し、hosted の静的 route の上流をそれに替える。(I) hosted の Router の Base Sepolia USDC の受信（静的・動的）の facilitator を自前に替える。**P と I は別々に有効化できる。**
- **入らない**: Solana devnet の x402 受信・Solana の Provider（x402.org の Solana 側。署名者は別）、Arc（Circle）、zUSDC の settle（SubEtha の settle facilitator）、mainnet、既存の Provider A の Worker の変更・停止、x402.org への自動の切り替え（failover）、断られた支払いの送り直し。
- 2026-11-24 の失敗の原因は、この変更では**直るとは言えない**（x402.org が関わる部分は無くなる）。

## 3. 機能要件（FR-B）

- **FR-B1 facilitator**: 稼働中の自前 facilitator（1 process・1 鍵・1 journal・`flock`）に `eip155:84532` の Base Sepolia USDC（`0x036CbD53842c5426634e7929541eC2318f3dCF7e`、domain `USDC`/`2`）を足す。
  新 3 チェーンの性質（journal-first、使用済みの照合、payTo の allowlist、network ごとの直列、未解決の保留、token、gas の累計と上限）はすべて同じ。**新 3 チェーンの振る舞い（許す受取先・費用の数え方・保留・起動）は変えない。** Base の RPC の不達・照合の遅れ・保留は Base だけを止め、新 3 チェーンと Router の入口を止めない。 同じ表にある zUSDC（`subetha-exact` 専用）は受けない。
- **FR-B2 L1 の手数料**: Base は OP Stack で、送信者は L2 の gas のほかに L1 の data fee を払う（実測 1 件 約 0.000000011 ETH、L2 の 1〜2%）。gas の累計・予約・上限は L1 の手数料を含めて数える。L1 の手数料は送出の前に確定せず、tx で上限を付けられないので、予約は**保守的な見積り**であって最悪値の保証ではない（§8）。
- **FR-B3 残高の検査**: 送出の前に、署名者のネイティブ残高が費用の予約（L2 の最悪値 + L1 の見積り）を下回れば**送出せず**断る（保留しない）。残高を読めないときも送出しない。
- **FR-B4 準備の表示**: facilitator は network ごとに「今 settle できるか」（保留でない・見積りの手数料が `maxFeePerGas` の上限以下・累計が上限まで余裕・残高に余裕）を答える。読み取りだけで、token が要る。
- **FR-B5 売る前に止まる**: Base Sepolia 版の Provider は、facilitator が準備できていないとき、**未払いの 402 を出さず 503 を返す**。Router は受信の settle の前に上流の 402 を読み直すので、
  停止中は **Router が受信の settle を始めない**。買い手の署名・送金そのものを取り消す保証ではない（§8）。確認の後に停止する競争も残る。
- **FR-B6 保留からの復帰**: 送出の結果が分からずに保留した Base を、再起動なしで復帰できるようにする。復帰の根拠は起動時の照合と同じ（chain の receipt と `Transfer` の一致）だけ。新しい tx は送らない。根拠が無ければ保留のまま。
- **FR-B7 Provider**: `providers/x402-workers` に Base Sepolia の行と env を足す。402 の offer（network・資産・金額 10,000・payTo・`maxTimeoutSeconds` 60・`extra` `{name, version}`）は今の Provider A と**同じ値**、本文は記録済みの契約（`docs/provider-x402-workers.md` §2.3）で `payment.network` は `eip155:84532`。
  公開の名前は新しいもの（`provider-x402-base.subethalabs.com`）。既存の `provider-x402.subethalabs.com` は触らない。
- **FR-B8 有効化**: `RAILS_ACTIVATION` の新しい任意の欄で、P と I を別々に切り替える。欄が無い・`false` なら、公開の設定・一覧・golden・子の env は byte 一致。
- **FR-B9 戻し方**: P・I とも、有効化を `false` に戻した image への入れ替えだけで x402.org に戻る。**戻す先の image は、Base の行を含む journal で起動できること。**
- **FR-B10 診断と運用**: facilitator の残高・累計・上限・保留を運用者が読める手順と、補充の手順を `docs/DEPLOY.md` に書く。token・鍵を出さない。

## 4. 安全要件（SR-B）

- **SR-B1 二重払いなし**: 1 つの authorization は EIP-3009 の nonce で高々 1 回。facilitator を x402.org から替えても、切り替えをまたぐ**同じ authorization の送り直しはしない**。自動の failover は作らない。
- **SR-B2 未払いの断定**: 400（Router の `rejected`）は、その時点で authorization が未使用で、この facilitator が送出していないと確かめたときだけ。それ以外の失敗は 5xx（`unknown`）。今と同じ。
- **SR-B3 使い道の限定**: payTo の allowlist は network ごと。Base は Router の EVM の受取先と Base の Provider の受取先だけ、新 3 チェーンは今のまま（Base の Provider の受取先を許さない）。1 件の金額の上限 20,000、gas の累計の上限。
- **SR-B4 SSRF・egress**: 動的上流の transport と egress の deny-list は変えない。loopback の例外は facilitator の origin の完全一致で、**受信の transport だけ**（今と同じ）。Base を足しても、送信と動的上流には広げない。
- **SR-B5 秘密**: 新しい鍵は作らない（gas 鍵 E-FAC-H を Base でも使う。nonce は chain ごとに別）。token は Worker の secret と本番の env だけ。Worker に鍵を置かない。
- **SR-B6 資金**: facilitator が動かせるのは自分の gas だけ。買い手の署名の宛先・金額は変えられない。
- **SR-B7 drain**: 購入の最長時間は `DRAIN_TIMEOUT_MS` の内に収まる（試験で固定）。

## 5. 受け入れ（AC-B）

- **AC-B1** 「欄なし」と「両方 `false`」のそれぞれで、今の hosted の設定・子の env・一覧・golden と完全に一致。新 3 チェーンの facilitator の既存の試験が変更なしで通る。
- **AC-B2** P だけ・I だけ・両方の 3 通りで、変わるのは FR-B7・FR-B8 の値だけ（一覧の route・プロファイル・価格・受取先・指紋は同じ）。
- **AC-B3** facilitator: L1 の手数料を数える（live と再起動の値が一致）、L1 の実費が予約を超える、L1 の欄の無い receipt（live と再起動で同じ値）、残高不足・残高を読めない、手数料が上限を超える間の `/ready`・`/verify`、Base の Provider の受取先を新 3 で拒否、Base の RPC が不達・応答しないときに新 3 が起動して settle できる、Base に未解決が多数あっても listen が遅れない、zUSDC の拒否、L1 の手数料のない 3 チェーンは今と同じ値。
- **AC-B4** 保留の復帰: receipt が後から見えれば復帰、`Transfer` の不一致・receipt 無し・RPC の失敗では保留のまま、送出の回数は 1 のまま。遅れた `submitted`・遅れた fsync と交差しても終端の記録と hash が変わらない。終端の追記が期限の後に成功した鍵は、次の回で RPC なしに復帰する。chain id が未確認・不一致の間は照合の RPC・終端の追記・復帰が 0 回。drain の後は新しい回を始めず、始まった回は journal の close と lock の解放より前に終わる（drain の数に入る）。
- **AC-B5** Worker: 準備ができていない・不明のとき未払いの GET は 503 で 402 を出さない、Base 以外の env は今と同じ要求の数。
  Router と合わせた wire 試験で、quote の後に準備ができなくなったとき（保留・残高不足・手数料の上限超過の各 1 回）、**受信の settle が 0 回**で、結果は経路ごとに次のとおり（状態・HTTP・永続の記録を固定）:
  静的 MCP = `awaiting_payment`／`offer_unavailable`、`source_failed`（`not_sent`）。標準の x402 入口（`subetha-exact`）= 409 `payment_not_completed`（未払いの証明ではない。`mayStillSettleUntil` の開示を残す）。動的 = `awaiting_payment`／`offer_unavailable`（決済の終端の行を書かない）。
- **AC-B6** 戻し: Base の行（`gas_cap_init`・settled・未解決）を含む journal で、Base 無効の同じ image が起動し、新 3 チェーンが動く。変更前の code では起動しないことも試験の説明に記録する。
- **AC-B7** loopback の例外が Base の送信・動的上流に広がらない（拒否の試験）。allowlist に無い loopback の facilitator では起動しない。
- **AC-B8（本番、owner の go の後）** P と I それぞれで testnet の購入が `delivered`、両レグの tx を chain で照合（I の受信と P の上流の送信者が E-FAC-H）。既存の route の回帰を各レール 1 回。facilitator の journal の未解決 0。Router の再起動の後に結果を読み直して同じ、両レグの finality を確認。

## 6. owner の gate

- **G-B0** 要件・設計の承認。
- **G-B1** 実装（PR まで）。
- **G-B2** 鍵と資金: E-FAC-H に Base Sepolia の ETH（今は 0）、gas の上限の値、Provider の受取先。
- **G-B3** 無効のままの配備（この image が戻す先になる）。
- **G-B4** Worker の配備と P の有効化、受け入れの購入。
- **G-B5** I の有効化、受け入れの購入。

## 7. owner に決めてほしいこと（推奨）

- **Q-1 範囲**: P → I の順に両方（推奨）／P だけ。I をしないと、Base Sepolia USDC で払う購入は x402.org の停止中に失敗する（受信の段階で失敗する。`rejected` は応答の分類で、未払いの確定には chain の照合が要る）。
- **Q-2 Provider の名前**: 新しい名前（推奨。今の Provider A に触らず、戻すのは Router だけ）／今の名前を付け替える（他の利用者も直るが、Provider A の Worker の持ち主の作業が要り、戻すのも domain の付け替え）。
- **Q-3 受取先**: 今の Provider A と同じ `0x9014…6fE1`（推奨。route の指紋が変わらない）／E-PROV（指紋が変わり、進行中の quote が無効になる）。**`0x9014…6fE1` の鍵を今も管理しているかは、この文書では確かめていない。**
- **Q-4 資金**: Base Sepolia の ETH 0.02 を入金し、上限 0.01 ETH（推奨。1 件の実費 約 0.0000009 ETH で、上限までに約 1 万件）。
- **Q-5 RPC**: 既定は `https://base-sepolia-rpc.publicnode.com`（推奨。`eth_getLogs` の幅 10,000 block まで実測で可）。`https://sepolia.base.org` は幅 200 block まで。

## 8. 分かっている限界

- **互換**: 自前 facilitator は 65 バイトの ECDSA だけを受ける。x402.org は契約ウォレット（EIP-1271・EIP-6492）や Permit2 も受け得るので、そうした買い手は I・P の有効化の後は使えない。
- **単一点**: 自前の facilitator の停止・gas 切れ・保留が、Base Sepolia の受信と Provider の両方を止める（今の x402.org と同じ形だが、残高と保留を自分で見て直せる）。Router の入れ替え中（約 12 秒）は Provider も settle できない。
- 動的プロファイルは URL を呼び出し側が選ぶ。古い Provider A の URL を選べば、x402.org の停止の影響は残る。
- **先に送金する買い手**: Tempo の MPP は署名の時点で送金する。FR-B5 で購入が止まっても、その送金は戻らない。標準の x402 の署名は、Router が settle しなくても期限まで外部で行使され得る（今と同じ開示）。
- **費用の見積り**: L1 の手数料が予約を超えると、残高の検査を通っても送出に失敗し（保留になり得る）、実費が累計の上限を超え得る（超過の大きさに上限は無い。次の送出は止まる）。L1 の欄が無い receipt・hash の分からない照合では、予約より多い実費を数え落とす。
- Base 以外の起動の失敗（env の欠け・journal の破損・新 3 の RPC の不達）は、今と同じく入口全体を止める。
- hash の無い保留（送出の RPC が応答しなかった）で、authorization が未使用のままなら、自動では復帰しない（運用者の判断）。
