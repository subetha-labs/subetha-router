# 秘匿購入（zkTLS）の受入手順（TR-3、owner 実行）

**版**: v1.1（2026-10-22、§9 を追加）。対象: `docs/zktls-router-requirements.md` v3.3 の TR-3、`docs/zktls-router-design.md` v5.1 §11、`docs/zktls-router-tasks.md` v1.1 の T-Z8。

本書は、Router の**実合成**（`src/main.ts`、`ROUTER_ADAPTER_MODE=real`）で、lab の testnet Provider に対して秘匿購入（Router が要求本文・応答本文を見ないまま、指定の Provider に指定の内容が実行されたことを検証して配送する）を**実送金つきで**確かめる手順である。実行は **owner**（AGENTS.md: ローカル開発の権限では支払い・署名・放送を行わない）。ここで言う「ローカルで実装が完了した」と「owner が受入を実行して成立した」は別のことで、報告でも区別する。

## 0. 証跡の意味と、ここで示せないこと

- wire（`tests/wire/private-x402.test.ts`）の証跡は lab の fixture CA（`lab-fixture-ca`）で得た **synthetic** なもの。公開 PKI（`mozilla`）での受入の代わりにならない。
- 受入の証跡は **5 つのゲートを別々に**記録する（TR-3）: ① 受信決済（Base Sepolia USDC の実 x402 決済）、② 送信決済（Provider の領収の tx / reference）、③ 秘匿配送（Router の attest = `delivered_private` と proof）、④ Payer 受領（手元で bundle を検証してから復号できた）、⑤ finality。**⑤ は本 v1 では Router もツールも確認しない**（`onChainFinality: "not_checked"`）。両チェーンの読み取りは owner が別途行い、証跡に添える。
- `unknown` は「払ったかもしれない」。再試行・再購入・返金の推定をしない（FR-Z09・FR-Z15）。record が取得できれば Payer は手元で `payer-decrypt` できる（配送の救済）。

## 1. 前提

| 項目 | 値・確認 |
|---|---|
| lab | `SUBETHA_ZKTLS_LAB_DIR`（既定 `~/.worktrees/subetha-zktls-router/private-payment-binding-20261017`）。バイナリ `phase5/runner/target/release/delivery`（sha256 `1b3180c8…f18f`）、SRS `SUBETHA_ZKTLS_SRS_DAT`（既定 `~/.hermes/research/subetha-zktls-delivery-spike/tools/srs/bn254_g1.dat`、sha256 `7eaff854…fb25`）。Router は起動時に両方の sha256 を設定値と照合し、違えば起動しない |
| Router と Payer | **同一ホスト**（Verifier は loopback にしか listen しない。設計 §12） |
| 受信レグ | Base Sepolia USDC（`eip155:84532`、`0x036C…CF7e`）。facilitator は公式 `https://www.x402.org/facilitator`（`ROUTER_X402_INBOUND_FACILITATOR_URL`） |
| 送信レグの鍵 | Router の運用者鍵: x402 は `SUBETHA_OUTBOUND_X402_KEY`、Tempo は `SUBETHA_OUTBOUND_MPP_KEY`（+ `SUBETHA_TEMPO_RPC_URL`、認証付きを推奨）。`tools/remote-router-process.ts` が env から読んで能力として注入する（`src/**` は env から鍵を読まない） |
| Payer の鍵 | `SUBETHA_PAYER_PRIVATE_KEY`（Router リポジトリの標準の Base Sepolia test payer。owner が 2026-10-17 に再利用を承認）。env だけ。ファイル・ログ・証跡に書かない |
| Provider（lab の公開プロファイル、2026-10-18/20） | C: `POST https://provider-x402-post.subethalabs.com/select`（x402、10000 USDC atomic、payTo `0x9014…6fE1`）。F: `POST https://provider-mpp-post.subethalabs.com/select`（Tempo pull、10000 pathUSD、同じ payTo）。A: `GET https://provider-x402.subethalabs.com/v1/eth/snapshot`（x402）。B: `GET https://provider-mpp.subethalabs.com/v1/eth/snapshot`（Tempo pull） |

## 2. 支払い範囲の記録（AGENTS.md「Record concrete testnet payment scope before live payment」）

実送金の**前に** JSON を 1 つ書き、`tools/private-payer.ts --scope-file` / `PRIVATE_LIVE_SCOPE_FILE` で渡す。無ければツールも受入テストも**何も払わずに**止まる。sha256 が証跡（`evidence.json`・`scope.sha256`）に入る。置き場所は `runtime/private-live/<run>/scope.json`（git 管理外）。

```json
{
  "approvedBy": "<owner>",
  "approvedAt": "2026-10-2xT00:00:00Z",
  "networks": ["eip155:84532 (Base Sepolia, test USDC)", "eip155:42431 (Tempo Moderato, pathUSD)"],
  "providers": ["C provider-x402-post.subethalabs.com", "F provider-mpp-post.subethalabs.com", "A provider-x402.subethalabs.com", "B provider-mpp.subethalabs.com"],
  "maxPurchases": 8,
  "maxTotalInbound": "88000 (USDC atomic = 0.088 USDC incl. Router fee 1000/purchase)",
  "maxTotalOutbound": "40000 USDC atomic + 40000 pathUSD atomic (+ Tempo fee cap 200000 atomic/purchase)",
  "note": "testnet only; valueless test assets; one purchase per Provider first, then repeat only after reading the evidence"
}
```

## 3. Router の設定（実合成）

`ROUTER_CONFIG_PATH` の `router` に、既存の静的 route・`dynamic` に加えて `private` を置く。allowlist（`profiles`）に挙げたプロファイルだけが秘匿購入できる。受信は x402 の `eip155:84532` USDC に限る（`parsePrivate` が検査する）。

```json
{
  "router": {
    "approvalTtlMs": 120000,
    "routes": { "...既存の静的 route（1 つ以上要る）..." : {} },
    "budget": { "maxPurchases": 50, "buckets": [{ "network": "eip155:84532", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "maxTotal": "100000000", "maxPerPurchase": "200000" }] },
    "dynamic": {
      "enabled": true,
      "profiles": {
        "priv-c-x402-post": { "profileId": "priv-c-x402-post", "sourceRail": "x402", "source": { "network": "eip155:84532", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "decimals": 6, "payTo": "<Router の受取先>" }, "rail": "x402", "destination": { "scheme": "exact", "network": "eip155:84532", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "decimals": 6, "tokenDomain": { "name": "USDC", "version": "2" } }, "par": true, "maxUpstreamAmount": "10000", "fee": { "flat": "1000", "bps": 0, "min": "1000" } },
        "priv-f-tempo-post": { "profileId": "priv-f-tempo-post", "sourceRail": "x402", "source": { "network": "eip155:84532", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "decimals": 6, "payTo": "<Router の受取先>" }, "rail": "mpp", "destination": { "scheme": "tempo/charge", "network": "eip155:42431", "asset": "0x20c0000000000000000000000000000000000000", "decimals": 6, "feeAsset": "0x20c0000000000000000000000000000000000000", "maxFee": "200000" }, "par": true, "maxUpstreamAmount": "10000", "fee": { "flat": "1000", "bps": 0, "min": "1000" } },
        "priv-a-x402-get": { "...": "priv-c と同じ（GET でも同じプロファイル形）" },
        "priv-b-tempo-get": { "...": "priv-f と同じ" }
      },
      "budget": { "maxPurchases": 50, "buckets": [{ "network": "eip155:84532", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "maxTotal": "100000000", "maxPerPurchase": "200000" }, { "network": "eip155:42431", "asset": "0x20c0000000000000000000000000000000000000", "maxTotal": "100000000", "maxPerPurchase": "200000" }] },
      "denyHosts": []
    },
    "private": {
      "deliveryBin": "/abs/path/phase5/runner/target/release/delivery",
      "deliveryBinSha256": "<sha256 hex>",
      "srsPath": "/abs/path/tools/srs/bn254_g1.dat",
      "srsSha256": "<sha256 hex>",
      "profiles": ["priv-c-x402-post", "priv-f-tempo-post", "priv-a-x402-get", "priv-b-tempo-get"],
      "workDir": "runtime/private",
      "sessionTimeoutMs": 180000,
      "attestTimeoutMs": 600000,
      "verifyTimeoutMs": 60000,
      "retentionMs": 3600000
    }
  },
  "x402": { "upstreams": { "...静的 route の上流..." : "" } }
}
```

注意: `retentionMs ≥ attestTimeoutMs + verifyTimeoutMs`（record は attest と検証が終わるまで取得できる）。trust は設定に無く `mozilla` 固定（fixture CA は試験の能力注入だけ）。Tempo pull の credential の有効期限は短い（+25 s 程度。設計 §12）ので、purchase の応答を受けたら**すぐ** finalize → session に進む（ツールは連続して実行する）。

起動（owner）:

```sh
ROUTER_ADAPTER_MODE=real ROUTER_CONFIG_PATH=<config> ROUTER_JOURNAL_PATH=runtime/private-live/journal.ndjson \
ROUTER_PRINCIPAL_TOKENS='owner:<token>' ROUTER_CANONICAL_BASE_URL=http://127.0.0.1:8500 ROUTER_HTTP_HOST=127.0.0.1 ROUTER_HTTP_PORT=8500 \
ROUTER_SUBETHA_FACILITATOR_URL=<既存の値> ROUTER_X402_INBOUND_FACILITATOR_URL=https://www.x402.org/facilitator \
SUBETHA_OUTBOUND_X402_KEY=0x… SUBETHA_OUTBOUND_MPP_KEY=0x… SUBETHA_TEMPO_RPC_URL=https://… \
npx tsx tools/remote-router-process.ts
```

## 4. Payer 側の手順（`tools/private-payer.ts`）

1 回の購入 = 封筒 → quote → **承認** → 受信 credential（EIP-3009、Payer の鍵）→ purchase（引き渡し）→ `payer-finalize-order` → `executor-session`（実 MPC-TLS、Verifier は Router が起動した loopback）→ `executor-prove` → attest → record（2 回取得して同一）→ `payer-decrypt`。

まず `--approve` なしで quote だけ取り、`<out>/quote.json`（承認対象: 両レグの額・資産・網・受取先、target の host/path/method、本文の長さと commitment、Payer 鍵、各期限、開示）を読む。
ツールは同じ `<out>` に再開点 `checkpoint.json`（0600。quote 文書・ownerKey・requestId・注文）を書く。**承認は同じ `--out` に `--approve` を足して再実行する**: ツールは keygen も quote もやり直さず、
読んだ quote そのものを購入する。`quote.json` が書き換えられていた・quote の期限（`approval.deadlineMs`）が過ぎた・引数が違う・別の `--out` のときは拒む（新しい `--out` で quote からやり直す）。

```sh
# C（x402 POST）。本文は Payer が決める（≤ 512 B の JSON object、`lab.select.v1`）。Router には渡らない。
printf '%s' '{"schema":"lab.select.v1","model":"lab-echo","prompt":"acceptance-C-1"}' > runtime/private-live/c1/body.json
SUBETHA_PAYER_PRIVATE_KEY=0x… PRIVATE_PAYER_TOKEN=<token> npx tsx tools/private-payer.ts \
  --router http://127.0.0.1:8500 --principal owner --profile priv-c-x402-post \
  --method POST --host provider-x402-post.subethalabs.com --path /select --body-file runtime/private-live/c1/body.json \
  --outbound-protocol x402 --outbound-network eip155:84532 --outbound-asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  --outbound-pay-to 0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1 --outbound-max-amount 10000 --inbound-max-total 11000 \
  --trust mozilla --scope-file runtime/private-live/scope.json --out runtime/private-live/c1
# 読んで納得したら同じコマンド（同じ --out）に --approve を足す（ここで初めて受信 credential を作り、Router が決済する）。
# 応答を失った・途中で止まったときは、同じ --out に --recover（status と record を読み直し、手元に bundle があれば復号。何も払わない）。
```

F は `--profile priv-f-tempo-post --host provider-mpp-post.subethalabs.com --outbound-protocol mpp --outbound-network eip155:42431 --outbound-asset 0x20c0000000000000000000000000000000000000`。A/B は `--method GET --path /v1/eth/snapshot`（`--body-file` なし）と各 host。

出力（`<out>/`、dir 0700、ファイル 0600）: `quote.json`（承認対象）、`checkpoint.json`（再開点。**ownerKey を含む**）、`intent.json`、`payment_header.json`（**bearer**）、`order_final.json`（**bearer**）、`release.json`、`record.json`、`bundle.json`、`keys/`（Payer 鍵・salt・`decrypt-*.bin`・`decrypt-*_result.json`）、`executor/`、`evidence.json`（`--recover` も同じファイルに単調に併合する。承認の拒否は `refusals.json`、回復・再復号の失敗は `recovery-log.json`）。再開点と証跡は一時ファイル → fsync → rename で書く（途中で止まっても前の内容が残る）。bearer・ownerKey・鍵のファイルは受入が終わったら消す。`evidence.json` には bearer・本文・鍵・復号結果の本文は入らない。
証跡はゲートが分かった時点で書く: 引き渡しの直後に受信決済の tx（status から）と「送信 credential 発行済み」、attest の後に秘匿配送、復号の後に Payer 受領。引き渡しの後で失敗しても分かっている分は残り、`stage` に止まった段が入る。purchase の応答を失った・`unknown` のときは両決済に `uncertain: true`（払ったかもしれない）。

## 5. 受入テスト（`tests/acceptance/private-live.test.ts`）

同じ手順をテストとして走らせ、ゲートごとに別の `test` で判定する。**1 回の起動で 1 つの操作**（`PRIVATE_LIVE_MODE`）: `quote`（承認対象と再開点を書いて止まる。何も払わない）→ owner が `<dir>/quote.json` を読む → `approve`（**同じ** `PRIVATE_LIVE_EVIDENCE_DIR` を指す。再開点の quote そのものを買い、新しい quote も本文も作らない）→ 必要なら `recover`。env:

| env | 意味 |
|---|---|
| `PRIVATE_LIVE_AC=1` | gate。無ければ skip（= 未検証。合格ではない） |
| `PRIVATE_LIVE_PROVIDER` | `C` / `F` / `A` / `B`（既定 C） |
| `PRIVATE_LIVE_ROUTER_URL`, `PRIVATE_LIVE_PRINCIPAL`, `PRIVATE_LIVE_TOKEN`, `PRIVATE_LIVE_PROFILE` | 実合成の Router と allowlist のプロファイル |
| `PRIVATE_LIVE_SCOPE_FILE` | §2 の記録（必須。欠けていれば何も払わない） |
| `SUBETHA_PAYER_PRIVATE_KEY` | Payer の鍵（env だけ） |
| `PRIVATE_LIVE_MODE` | `quote`（既定）/ `approve` / `recover`。approve と recover は `PRIVATE_LIVE_EVIDENCE_DIR`（quote が書いた `checkpoint.json` のあるディレクトリ）が必須 |
| `PRIVATE_LIVE_EVIDENCE_DIR` | quote では任意（既定 `runtime/private-live/<provider>-<時刻>`）、approve / recover では必須 |
| `PRIVATE_LIVE_INBOUND_MAX_TOTAL`, `PRIVATE_LIVE_BODY` | 任意（quote のときだけ効く） |

```sh
# 1) quote: 承認対象と再開点を書いて止まる（何も払わない）
PRIVATE_LIVE_AC=1 PRIVATE_LIVE_MODE=quote PRIVATE_LIVE_PROVIDER=C PRIVATE_LIVE_EVIDENCE_DIR=runtime/private-live/c1 PRIVATE_LIVE_ROUTER_URL=http://127.0.0.1:8500 \
PRIVATE_LIVE_PRINCIPAL=owner PRIVATE_LIVE_TOKEN=<token> PRIVATE_LIVE_PROFILE=priv-c-x402-post PRIVATE_LIVE_SCOPE_FILE=runtime/private-live/scope.json SUBETHA_PAYER_PRIVATE_KEY=0x… \
npx vitest run tests/acceptance/private-live.test.ts
# 2) runtime/private-live/c1/quote.json を読む
# 3) approve: 同じディレクトリの再開点を買う（ここで実送金）
PRIVATE_LIVE_AC=1 PRIVATE_LIVE_MODE=approve PRIVATE_LIVE_PROVIDER=C PRIVATE_LIVE_EVIDENCE_DIR=runtime/private-live/c1 …同じ env… npx vitest run tests/acceptance/private-live.test.ts
# 応答を失ったら: PRIVATE_LIVE_MODE=recover（何も払わない）
```

## 6. ゲートと証跡（`evidence.json`）

| ゲート | 証跡の欄 | 成立の条件 | 出所 |
|---|---|---|---|
| ① 受信決済 | `gates.inbound_settlement.{settled,txRef,eventId}` | `settled: true`、`txRef` は 32 バイト hex（Base Sepolia の tx） | Router の射影 `source.txRef`（journal `source_settled`） |
| ② 送信決済 | `gates.outbound_settlement.{issued,receipt,txRef}` | `issued: true`、`receipt: true`、`txRef` = Provider の領収（x402: `PAYMENT-RESPONSE` の transaction、Tempo: `Payment-Receipt` の reference）。Router は領収の **digest** だけを journal・射影に残す（`private.outbound.receiptSha256`）。原本は record | Router の射影 `destination.txRef` |
| ③ 秘匿配送 | `gates.private_delivery.{status,proof,recordSha256,recordRepeatable}` | `status: "delivered_private"`、`proof.delivery: true`、POST では `proof.requestBinding: true`、`recordRepeatable: true` | attest の応答、record ×2 |
| ④ Payer 受領 | `gates.payer_receipt.{ok,verifiedBundleBeforeDecrypt,decryptedSha256,payloadLen}` | `ok: true`、`verifiedBundleBeforeDecrypt: true`、平文が Provider の応答契約（C: `select-post-c`/`lab.select.v1`、F: `select-post-f`、A: `market-data-a`、B: `market-data-b`）に合う | `payer-decrypt` |
| ⑤ finality | `gates.finality.{checked:false,note}` | 本 v1 では**未確認**と明記。owner が両チェーンを読んで別途添える（受信 tx の confirmations、送信 tx と期待 tx の一致） | 手作業 |

加えて `.claude_workflow/`（git 管理外）に実行ログを残し、`docs/zktls-router-design.md` §13 の対応表に受入の結果（成立 / 未検証 / 不成立と理由）を日付つきで書く。

## 7. 失敗したときの扱い

- `purchase` が `unknown`（例: `private_issuance_unknown`・`private_session_timeout`・`private_verifier_unavailable`）、または応答を失った: **払ったかもしれない**（証跡の両決済は `uncertain`）。同じ quote で再提出しても再発行はされない。`--recover` で status を読み、journal と両チェーンを読む。record があれば `--recover` が `payer-decrypt` まで行う。
- `attest` が `unknown/private_attest_invalid`: 検証が通らなかった（bundle・record・領収のどれかが合わない）。record は保持期限まで取得でき、Payer は手元で検証・復号できる。
- Router の再起動後は attest できない（取得専用。設計 §3.6）。record を取得して手元で復号する。
- Tempo pull の credential 期限切れ（`validBefore`）: Provider が 402 を返し、record の状態行が `non_200` → attest は通らない。送信レグは動いていない可能性が高いが、**unknown として扱う**（Provider 側の claim の有無はチェーンで読む）。

## 8. 実行記録（2026-10-20/21）
C・A・B・F の 4 Provider すべてで 5 ゲート成立（設計 §14.6）。F は最初の 2 回が Provider F の一時的な HTTP 500（mppx `internal-payment-error`、公開 Tempo RPC のレート制限が濃厚）で未成立となり、3 回目で成立。Tempo の 402 は probe ごとに `_mppx_nonce` が変わるため、Router 側の offer 比較から除外した（修正済み）。


## 9. 第三者 Provider（公開 GET）の受入（`docs/zktls-router-thirdparty.md`、2026-10-22）

対象は **x402 v2 の公開 GET** だけ（秘匿 POST は lab の Provider 契約 C/F に限る）。自社 Provider での成立は第三者対応の証明ではないので、次の順で**別の承認**を得てから払う。

1. **事前互換検査**（払わない・署名しない。未払いの GET を 1 回）: `npx tsx tools/private-provider-precheck.ts --url https://<host><path> --max-amount <atomic> --out runtime/private-live/<run>/`。
   通ると `provider.json`（封筒の値: host・path・payTo・額）と観測（TLS 1.2 の suite、402 の framing、ヘッダの大きさ）が書かれる。**通っても B3（有料応答が `HTTP/1.1 200 OK`・`Content-Length`・≤ 704 B）と B4（領収の `payer`）は払うまで分からない**（`notVerified`）。`--ca`/`--connect` は試験専用で、その `provider.json` は synthetic（`--trust mozilla` の Payer は拒む）。
2. **支払い範囲の記録**（§2 と同じ形）に Provider の URL・`payTo`・額・`maxPurchases`、受信と送信の合計上限（例: 2 件なら受信 4,000・送信 2,000 atomic）を書く。
3. Router の設定に受信 x402 Base Sepolia USDC → 送信 x402 Base Sepolia USDC のプロファイル（`maxUpstreamAmount` = 事前検査の額、fee flat 1,000）と `private.profiles` の追加、予算 bucket を同じ上限で。
4. `tools/private-payer.ts --provider-file runtime/private-live/<run>/provider.json`（`--method/--host/--path/--outbound-*` と**排他**。転記しない）で quote → `quote.json` を読む（`private.target`・`private.outbound.payTo`・額が `provider.json` と一致すること）→ 同じ `--out` に `--approve`。受入テストなら `PRIVATE_LIVE_PROVIDER=X PRIVATE_LIVE_PROVIDER_FILE=<provider.json>`（§5 の `quote` → `approve` と同じ）。
5. 証跡（§6）に `providerFileSha256`（封筒の値の出所）が入る。ゲート 4 は第三者では **bundle 検証 → 1..=704 B → sha256 一致** だけ（応答の内容の契約は検証しない）。
6. **失敗したときの損失**: 有料応答が 704 B を超える・chunked・領収が無い（B3/B4）と、executor か attest が失敗する。**受信レグ（2,000 atomic）は決済済み**、送信レグ（1,000 atomic）は Provider が決済済みのこともある `unknown`。自動の返金は無い。framing で落ちた場合は record も bundle も残らない（復号の救済も無い）。再試行は owner が証跡と両チェーンを読んでから、新しい quote と新しい承認で。

**第三者 Provider X の実行記録（2026-10-22）**: §9 の手順で `GET https://tollbooth-hello-testnet.sjwilliams8.workers.dev/hello`（1,000 atomic）を 1 回。`delivered_private`、5 ゲート成立（受信 tx `0x74cc1d6f…266f`、送信 tx `0xafc13f15…5045`、平文 326 B、両チェーン読取 300 conf 超）。詳細は設計 §14.7。

**同日の続き**: 控え候補 3 件 + tollbooth 2 件目。fx（214 B）・shelf（91 B）・tollbooth(2)（326 B）は `delivered_private`、joke は有料応答 938 B で B3 不成立（両レグ決済済み・返金無し）。facilitator の settle 失敗 2 回は無送金で、新しい quote で再実行。設計 §14.7。

## 10. 回復時のチェーン読取と運用の注記（thirdparty §10、2026-10-22）

- `--recover --chain [--rpc-url …] [--payer-address 0x…]`: 読取だけ（何も払わない・署名しない・鍵は要らない）。EIP-3009 `authorizationState` を最新 block の hash で固定して読み、`true` なら `AuthorizationUsed` の直後の `Transfer(authorizer → payTo, 額)` を receipt で確かめたときだけ `settled`（`chainTxRef`）。`false` + 期限後 + Router が終端（`unknown`/`paid_data_unavailable`/`delivered`/`delivered_private`）なら `unused_expired`（その block 時点の観測。finality ではない。ゲート ⑤ は未確認のまま）。それ以外は不確実（回復のたびに今回の読取だけが決める）。遡れるのは最新から 1,000,000 block（公開 RPC の制約）。`--payer-address`（古い再開点用）の観測は診断だけでゲートを変えない。コンソールには結論と block だけ、証跡ファイルに nonce・tx hash。
- `dynamic.budget.maxPurchases` は**昇格した購入**（settle に進んだもの。後で `unknown` になった分を含む）を数える。再実行は新しい quote で、昇格数の上限に余裕のある journal で（§14.7 の x2 → x3）。
- quote は同一 principal から 1 分に 3 件まで（4 件目で `rate_limited`。設定で変わる）。quote の間隔は 20 秒以上。
- 新しい quote や journal は承認ではない。再実行にも §9 の承認（scope の記録、両レグの確認、合計の上限）が要る。

## 11. 受信 SubEtha V2（burn-sale）の payer 手順（`docs/zktls-router-v2-inbound.md` §9、2026-10-22）
受信が subetha のプロファイル（`sourceRail: "subetha"`、`private.profiles` に列挙）では、受信の credential は署名ではなく **人が先に払った burn の tx hash**。鍵は要らない。
**前提**: プロファイルの `source.asset` は `SUBETHA_ZERC20_ASSETS`（`src/shared/networks.ts`）にある token でなければ Router が起動時に拒む。V2 の zUSDC（`0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f`）は 2026-10-22 時点で表に無い（V1 の `0x132C…` だけ）: 結合の前に表の行を足す増分が要る（設計 §4）。

```sh
# 1. quote（鍵無し）。stdout の payFirst（注文別 burn address と atomic の額）を V2 側の支払い道具に渡す。
PRIVATE_PAYER_TOKEN=<token> npx tsx tools/private-payer.ts \
  --router http://127.0.0.1:<port> --principal owner --profile <priv-subetha-…> \
  --method GET --host <provider host> --path <path> \
  --outbound-protocol x402 --outbound-network eip155:84532 --outbound-asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  --outbound-pay-to <provider payTo> --outbound-max-amount 10000 \
  --inbound-network eip155:11155111 --inbound-asset <V2 zUSDC> --inbound-max-total 11000 \
  --trust mozilla --scope-file runtime/private-live/scope.json --out runtime/private-live/<run>
# 2. quote.json を読む（private.inbound.payTo = burn address、total、fundsMoveAt = payer_burn_before_credential、両レグの額）。承認してから払う。
# 3. V2 側: pos-pay-token A <payTo> zUSDC <total を 6 桁の decimal に>（例 11000 → 0.011）。transfer の tx hash を受け取る。
# 4. 同じ --out に --approve --burn-tx-hash <tx hash>（challenge の期限内。鍵無し）。
# 応答を失った・途中で止まった: 同じ --out に --recover（--chain は送信レグだけ読む。受信の burn は V2 の台帳と Sepolia の receipt で確かめる）。
```

受信レールの取り違えは latch の前で拒む（x402 の quote に `--burn-tx-hash`、subetha の quote に無し）。`--burn-tx-hash` は再開点と `evidence.json`（`claimedTxRef`）に小文字で残り、facilitator が確定した `txRef` と並ぶ。**burn は Router の拒否で戻らない**（quote の期限切れ・facilitator の rejected・容量拒否: `awaiting_payment` は未払いの証明ではない）。

実行記録（2026-10-22）: 結合 1 件目 `060fd61f…` delivered_private（受信 burn `0x8ec7…a831` eventId `…:151`、送信 `0x12be…cf17` chain settled、transport synthetic）。詳細は `docs/zktls-router-v2-inbound.md` §11。
実行記録（2026-10-22、2 件目・実 transport）: `56c85a2c…` delivered_private（実合成の Router、V2 facilitator は公開 https トンネル越し、受信 burn `0x50a0…c197` eventId `…:253`、送信 `0x6956…b8c1` chain settled）。詳細は `docs/zktls-router-v2-inbound.md` §12。
