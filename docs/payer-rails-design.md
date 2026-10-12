# 設計: payer の全レール対応と動的 URL（`@subetha/payer` 0.2.0。第 2 版、2026-10-12）

> 要件と設計を 1 本にまとめる（owner 2026-10-12「payer のレール拡張いけると思いますよ。どんどん進めて」。締切のため、要件・設計・タスクの 3 書を 1 書に圧縮し、独立レビューは本書に 1 回＋readback、実装の最終に 1 回）。
> 既存の設計 `docs/agent-payer-design.md`（第 1 slice）と `docs/agent-payer-followups-design.md` の決定は変えない。本書は **加算** だけ。
> 第 1 版は独立レビューで REJECT（6 件。§5 D-1）。第 2 版で反映: 旧台帳の回復（§2.4a）、offer 全体の digest による束縛（§2.4）、動的の `signed` の初回送信の回復（§2.5）、hosted の包まれた結果と `txRef` の正規化（§2.5）、Tempo の RPC も Router と同じ guarded transport（§2.1・§2.3）、MPP の秘密（challenge の全文・内側の credential・署名済み transaction）の結果フィルタ（§2.5）、`exact` の EVM/SVM の分岐と mppx id の `quoteId`（§2.4）、`undici` の依存（§2.1）。

## 0. 一枚で

- 今の payer（0.1.2）が払えるのは **Base Sepolia USDC → 静的 `md-mpp-eth-snapshot` の 1 本**。hosted Router は 10 静的 route・20 動的プロファイル（全 5 受信レール）を出しており、testnet での全レールの支払い検証は Router 側で済んでいる（`npm run sign` の経路。multirail / MPP Solana の各 G）。
- 0.2.0 で payer を **「Router の全機能を払える唯一の入口」** にする:
  1. **受信レール 5 種**: x402 EVM（Base Sepolia・Arc testnet）、x402 SVM（Solana devnet）、MPP Tempo（`tempo/charge`。**daemon の中で送金**）、MPP Solana（`solana/charge`。全署名、送出は Router）。
  2. **静的 10 route すべて**（`quote({routeId})`）と **動的 20 プロファイル**（`quote({profileId, url})` = hosted の `subetha_router_quote_url`）。
  3. **鍵 2 本**（EVM secp256k1 と Solana ed25519）を同じ store・同じ passphrase に。`wallet new` は両方を作る。0.1.x の store には `wallet add solana`。
  4. **testnet だけ**（表の mainnet の行は payer では使わない）。
- 変えないもの: 承認は daemon のネイティブ dialog だけ、tool 引数・elicitation は同意ではない、1 購入 1 承認、`unknown` は未払いの証明ではない、retry しない、鍵はこの Mac を出ない、Summary の strict schema と固定文、台帳の hash 連鎖と封印、**0.1.x の台帳がそのまま読めること**。
- **資金の動く時点が増える**: Tempo の MPP は **daemon が dialog の直後に送金する**（`sign_intent` → 送金 → `signed`）。dialog にその旨を固定文で出す。Solana の MPP は署名だけだが、Router が送出し **手数料（devnet SOL）はこの鍵**。

## 1. 要件（FR-R / SR-R / AC-R）

### 1.1 機能

- **FR-R1** `find_routes` は hosted の一覧の **静的 route 全部と動的プロファイル全部** を `RouteSummary` に写す（`kind: static|dynamic`、`pays`（rail・network・asset・decimals、静的は amount）、`reaches`、`fundsMoveOnCredential`、`needsSol`）。payer が払えない network（表の testnet 4 つ以外）の行は落とす。`hold` の絞り込みは両方に効く。
- **FR-R2** `quote` は `{routeId}`（静的）か `{profileId, url}`（動的）を取る。動的は hosted の `subetha_router_quote_url` を呼ぶ。`requestId` は daemon が UUID を作る（今と同じ）。
- **FR-R3** 承認の記録（`ApprovalRecord`）は **受信 offer の scheme に応じた形** を 1 つの strict schema で検証し、動的なら `upstream.url`・`destination.payTo`・`pricing`・`disclosures` も記録する。`subject`（hosted の応答）と記録から組み直した期待値の **canonical JSON の一致** は今のまま（動的の欄も含める）。記録は **offer 全体の digest**（`offerSha256`）も持つ（§2.4）。
- **FR-R4** dialog（`render`）は今の行に加えて: 受信レール名と「いつ資金が動くか」の固定文（§2.6）、動的なら上流 URL・宛先・手数料の内訳（上流額 + 手数料 = 合計、`maxFee` があれば cap）、開示（運営は宛先を確かめていない・返金なし・JSON 以外は「払って無データ」）。文字は `sanitize` を通し、URL は https の形だけ。
- **FR-R5** `Signer.sign(offer)` は offer の scheme と network から **自動で振り分ける**（呼び出し側はレールを指定しない。`npm run sign` の `classifyOffer` と同じ判定を vendor）。表に無い network・資産・domain、失効、形の違い、上限超え（`SIGN_MAX_AMOUNT` = 20,000 base units）は **鍵に触れる前に** `rail_not_enabled` で拒む。
- **FR-R6** MPP Tempo: `sign` が **送金** し、`txRef`（tx hash）を `signed` の行の封印に credential と一緒に残す（封印の形 `{ credential, txRef? }`）。`PurchaseSummary` に `txRef`（任意、`0x`+64 hex）を出す（証拠。秘密ではない）。回復・再開・`inspect` でも同じ `txRef` が読める。
- **FR-R7** MPP Solana: `sign` は blockhash を 1 回読んで **全署名** し、送出しない。署名の直後に purchase を呼ぶ（今の順序どおり）。`needsSol: true`。
- **FR-R8** 動的の `status` は hosted に `ownerKey` を渡す。`ownerKey` は **quote 文書の封印（`quoted` 行の `sealedPlain`）にだけ** 存在し、`ApprovalRecord`・台帳の平文・Summary・CLI の表示・log に出ない。結果本文に `ownerKey` が含まれていれば `response_unreadable`（`resultSecrets` に既に入っている）。
- **FR-R9** 動的の結果は hosted の `proof.upstreamReceipt: "claimed"` をそのまま写す（静的は `none`）。hosted の `status` の射影で動的の `result` が `{untrusted, source, contentType, body}` に包まれている形は **読んだ時点で剥いて正規化** し、台帳に保存する射影も正規化後の形にする（§2.5）。
- **FR-R10** `wallet new` は EVM と Solana の鍵を作り、両アドレスと faucet の案内を出す。`wallet add solana` は 0.1.x の store（`eip155` だけ）に Solana の鍵を足す（passphrase を TTY で 1 回）。`wallet address` は両方、`wallet balance` は 4 network（Base USDC・Arc USDC・Tempo pathUSD・Solana devnet USDC と SOL）を公開 RPC で読む。
- **FR-R11** `wallet`（daemon）は払える (rail, network) ごとに 1 行（x402/Base・x402/Arc・mpp/Tempo は EVM のアドレス、x402/Solana・mpp/Solana は Solana のアドレス）。Solana の鍵が無い store では Solana の行を出さず、Solana の offer は `rail_not_enabled`。
- **FR-R12** `config.json` の `rpc` は `eip155:42431`（Tempo）と `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`（devnet）も取る（`validRpc`: 公開 https だけ。loopback 不可）。既定は `https://rpc.moderato.tempo.xyz`・`https://api.devnet.solana.com`。
- **FR-R13** hosted Router の `list_routes` の静的 route に `source.rail` と `source.scheme` を足す（加算。payer が Solana の x402 と MPP を区別するため。配備は owner）。payer は欄が無い一覧では表から一意に決まる network はそれで、Solana は routeId の末尾 `-solmpp` を MPP とみなす（quote の offer.scheme が権威。一覧の推定は表示だけ）。
- **FR-R14** README・llms.txt・CLAUDE.md を 0.2.0 に合わせる（全レール・動的 URL・資金の動く時点・faucet 4 つ・`install accept`・`wallet add solana`）。
- **FR-R15** **0.1.x の台帳と store はそのまま読める**（§2.4a）。0.1.x の記録（`kind` 無し）は旧の組み立てで再構成し、hash は変わらない。保留中の購入（`quoted`・`approved`・`signed`）も 0.2.0 で続きができる。

### 1.2 安全

- **SR-R1** 承認の前に鍵に触れない（今と同じ）。MPP Tempo の送金は `approved` と `sign_intent` の **後** でだけ起きる。dialog の拒否・timeout・passphrase 違いでは何も送らない。
- **SR-R2** `sign` に渡す offer は記録と `assertApproval` で一致を確かめたものだけ: 個別の欄（scheme・network・asset・amount・payTo・expiresAt・challengeNonce・routeBinding・fundsMoveOnCredential）に加えて **offer 全体の canonical JSON の sha256 が記録の `offerSha256` と一致**（feePayer・memo・name/version・challenge・externalId・decimals・tokenProgram など transaction に効く欄を漏れなく束縛）。承認の後に `subject`/offer のどの欄を変えても `approval_mismatch`。
- **SR-R3** 動的 URL は **記録に書いた URL** を dialog に出し、purchase では quote 文書をそのまま渡す（Router は保存した記録で実行する。文書の URL は実行に使われない。`dynamic-upstream-design.md` §2.4）。
- **SR-R4** `ownerKey`・credential（封筒と **内側の mppx の wire**・**署名済みの Solana transaction**）・**challenge の全文**・鍵・passphrase・合言葉は Summary を通らない（strict）し、結果本文に含まれていれば `response_unreadable`（§2.5 の `resultSecrets`）。`secrecy-scan` の既知値に `ownerKey`・challenge・内側の credential・Solana の seed を足す。
- **SR-R5** daemon の外向き接続は Router の URL と、設定の RPC（Tempo の送金・Solana の blockhash）だけ。**どちらも Router と同じ guarded transport**（vendor。名前解決の pinning、private/loopback の拒否、redirect の拒否、期限、64 KiB）を通す。
- **SR-R6** mainnet の行（`eip155:8453`・Tempo mainnet）は payer の表から外す（`PAYER_NETWORKS` = 表の testnet 4 つ）。offer がそれを名乗れば `rail_not_enabled`。
- **SR-R7** Tempo の MPP で `sign` の後に purchase が失敗・`unknown` でも **再送金しない**（状態機械: `signed` から `submit_intent` → `unknown`。`expired_after_sign` は `fundsMoved: maybe`）。`signed` のまま再起動したときの **初回送信** は 1 回だけ、`submit_intent` の行が無いこと（= 状態が `signed`）を根拠に行う（§2.5）。`awaiting_payment` も `not_found` も「未払い」とは読まない。

### 1.3 受け入れ

- **AC-R1（unit）** `classifyOffer` の vendor が Router の `tests/unit/sign-dispatch.test.ts` と同じ判定を返す（同じ fixture を payer の試験に写す）。mainnet の offer は拒む。
- **AC-R2（unit）** 5 レール × 静的/動的 の quote fixture（2026-10-12 の hosted の実応答の形）で `buildRecord` が通り、1 欄でも変えると `quote_inconsistent`。承認の後に `extra.feePayer`・`memo`・`challenge`・`name` を変えると `approval_mismatch`（hash は変わらないが digest で落ちる）。`render` に URL・内訳・開示・資金の時点の行が出て、制御文字が落ちる。
- **AC-R3（unit）** Summary: `ownerKey`・challenge・内側の credential を持つ余計な欄を注入しても出ない。`txRef` の形の検証。`RouteSummary` の `kind: dynamic`。
- **AC-R4（wire、fake Router）** 各レールで quote → purchase → status が通る（Signer は fixture）。動的: fake の `quote_url` と `status(ownerKey)`（`ownerKey` が違えば `not_found`）、`status` が包んだ `result` を返す。MPP Tempo の fixture signer は `txRef` を返し、`signed` の封印に入り、`status`・`inspect`・再起動後も読める。crash 行列（既存）に **動的 + Tempo** の列を足す: `signed` で落ちて再起動 → fake が `awaiting_payment` を返す → **1 回だけ** 送信 → `result`。`submit_intent` の後で落ちた場合は送信しない（`unknown`）。
- **AC-R4b（wire）** 結果本文に `extra.challenge` の全文、内側の `Payment …`、署名済み transaction（base64）、`ownerKey` を（そのまま・base64・hex・key の位置で）含む fake の応答は `response_unreadable`。即時の配信・`status` の照合・再開のそれぞれで。
- **AC-R4c（wire）** 0.1.x の台帳の回復: 旧の組み立て（`buildRecordV1`）で `quoted`→`approved`→`signed` を書いた台帳を 0.2.0 の daemon が開き、`store_corrupt` にならず、`signed` の記録を送信して `result` に至る。`result` 済みの旧記録も読める。
- **AC-R5（wire）** `wallet new` が 2 アドレスを出し、`keys.json` の `wallets` に `eip155` と `solana`。`wallet add solana` が 0.1.x の店を更新し、hash 連鎖・seal は壊れない。
- **AC-R6（pack）** `npm pack --dry-run` に `test/` が無い。新しい依存（mppx・@solana/kit・@solana-program/*・undici）が shrinkwrap に固定され、`.node` が無い。
- **AC-R6b（unit、transport）** vendor した guarded transport の試験を payer にも置く: private/loopback に解決する名前の拒否、redirect の拒否、64 KiB 超の応答の拒否、期限。Tempo の送金で transport が落ちたとき（送金したか不明）は `unknown` に落ち、再送しない。
- **AC-R7（hosted、読取だけ）** 実 Router の `list_routes` と `quote`/`quote_url` の応答が payer の schema を通る（各レール 1 回。rate limit に注意: 60 秒に 2 回）。
- **AC-R8（owner gate、資金が動く）** owner の Mac で、payer から **Tempo の MPP（`md-x402-eth-snapshot`）**・**Arc の x402**・**Solana の x402**・**Solana の MPP**・**動的 1 本（x402.org の demo endpoint を `dyn-sol-to-x402`）** を各 1 回購入し、`delivered`。dialog は owner だけが承認できるので、親は手順と結果の記録を担う。

## 2. 設計

### 2.1 vendor（`packages/payer/scripts/vendor.ts`）

今の 3 本に足す（Router の **同じ commit** の source を byte-identical に写し、import だけ書き換える。各書き換えは **ちょうど 1 回** 一致しなければ失敗）:

| Router | payer の `src/vendor/` | 用途 | import の書き換え |
|---|---|---|---|
| `tools/sign-dispatch.ts` | `sign-dispatch.ts` | 全レールの振り分け | networks |
| `tools/sign-check-tempo.ts` | `sign-check-tempo.ts` | Tempo challenge の中身の照合 | — |
| `tools/mpp-payer.ts` | `mpp-payer.ts` | Tempo の送金（mppx push）。**`options.fetchFn` を足した**（R-0。viem の `http(url, { fetchFn })`） | — |
| `tools/svm-payer.ts` | `svm-payer.ts` | Solana x402 の部分署名 | x402-svm → svm-message |
| `tools/svm-mpp-payer.ts` | `svm-mpp-payer.ts` | Solana MPP の全署名 | 同上 |
| `tools/svm-rpc.ts` | `svm-rpc.ts` | blockhash の 1 回読み（guarded） | net/bounded-body・net/guarded-fetch |
| `tools/svm-key.ts` | `svm-key.ts` | Solana の seed の形 | — |
| `src/shared/svm-message.ts` | `svm-message.ts` | Router と同じ transaction builder | — |
| `src/net/guarded-fetch.ts` | `guarded-fetch.ts` | **Router と同じ guarded transport**（undici、DNS pinning、private/loopback 拒否、redirect 拒否） | — |
| `src/net/destination-policy.ts` | `destination-policy.ts` | 宛先アドレスの方針 | — |
| `src/net/bounded-body.ts` | `bounded-body.ts` | 上限つきの本文読み | — |

`vendor.test.ts` は 14 本の byte 一致（書き換え込み）を見る。`sign/index.ts` の import graph の試験は 14 本と外部（`viem`・`viem/accounts`・`viem/tempo/chains`・`mppx`・`mppx/client`・`@solana/kit`・`@solana-program/token`・`@solana-program/compute-budget`・`undici`・node 組込み）に更新。

依存（root と同じ版に固定）: `mppx` 0.11.0、`@solana/kit` 8.4.0、`@solana-program/token` 0.17.0、`@solana-program/compute-budget` 0.19.0、`undici` 8.11.2。`viem` は 2.54.2 のまま。`deps.test.ts` の「root の lock と同じ版・同じ integrity」はそのまま成り立つ（root にある依存）。`vendor.test.ts` の「mppx・@solana を禁じる」行は第 1 slice の境界だったので外す（本書で許す）。

### 2.2 鍵と session

- `keys.json` の `wallets` は既に `rail → { address, sealed }` の map。新しい鍵は `wallets.solana = { address: <base58>, ...seal(kek, seed32, "wallet:solana:<address>") }`。store の version は 1 のまま（0.1.x の文書もそのまま読める）。
- `wallet new`: EVM の鍵と Solana の seed（32 バイト）を作って 1 つの文書に。stdout は 2 行（`eip155 <address>` / `solana <address>`）と faucet の案内（stderr）。
- `wallet add solana`（新）: `withLock` の中で passphrase を TTY で読み、`unlockKeys` → `kek` で seed を封印 → 文書に `solana` を足して書き直す（`eip155` の封は触らない。`solana` が既にあれば `wallet_exists`）。
- `Session` は **鍵の map**（`eip155` → 32 バイト、`solana` → 32 バイトの seed、どちらも無ければその行は無い）を持ち、`close()` で全部 zero fill。`Signer.sign` は振り分けの結果で鍵を選ぶ: `x402-evm`・`mpp` → `eip155`、`x402-svm`・`mpp-svm` → `solana`（無ければ `rail_not_enabled`）。

### 2.3 署名（`src/sign/index.ts`）

```
sign(offer, keys, deps) :
  snapshot = structuredClone(offer)
  dispatch = classifyOffer(snapshot, now, PAYER_NETWORKS)   // 鍵に触れない
  refuse → rail_not_enabled
  x402-evm : createX402Payer(hex(eip155)).credentialFor(snapshot, chainId)
  x402-svm : createSvmPayer(base58(solana), {rpcUrl: deps.solanaRpc}).credentialFor(snapshot, scope)        // blockhash 1 回（guarded）
  mpp      : createMppPayer(hex(eip155), scope, {rpcUrl: deps.tempoRpc, fetchFn: deps.guardedFetch}).payAndCredential(snapshot)   // **送金**（guarded）
             → 封筒 { x402Version: 2, accepted: snapshot, payload: { challengeNonce, credential } }、txRef
  mpp-svm  : createSvmMppPayer(base58(solana), {rpcUrl: deps.solanaRpc}).credentialFor(snapshot, scope)    // blockhash 1 回、全署名
             → 同じ封筒
```

- 戻り値は `{ credential, txRef? }`。`Signer` の interface をこれに広げる（fixture は `txRef` を返せる）。
- `PAYER_NETWORKS = KNOWN_NETWORKS.filter(testnet 4 つ)`。`classifyOffer` の `networks` 引数に渡す。
- `deps.guardedFetch` は vendor の `createGuardedTransport({ allowLoopback: false, report, dns })` の `fetch` を `typeof fetch` の形に包んだもの（`routeId: "tempo"`, `operation: "rpc"`）。**包む側で応答本文を 64 KiB に制限する**（vendor の `bounded-body` で読み、超えれば捨てて失敗にする。guarded transport 自体は本文の上限を持たない。D-2 nonblocking）。`svm-rpc` は同じ transport を自前で作る（vendor のまま。`allowLoopback` は false 固定で、試験は `createSvmRpc` を注入で差し替える）。
- Tempo の RPC・Solana の RPC は `config.rpc` から（既定は §1 FR-R12）。
- 依存の例外は文言を捨てて `sign_failed`（今と同じ）。**MPP Tempo で `payAndCredential` が例外を投げた場合、送金が起きたかは分からない** → purchase core は `sign_intent` のまま `unknown` に落とす（既存の経路。`fundsMoved: maybe`。再送金しない）。

### 2.4 承認の記録（`src/daemon/record.ts`）

`quoteSchema` を **1 つの strict schema** に広げる。`source.offer` は `z.union` で 4 分岐（`exact`/EVM と `exact`/SVM は同じ `scheme` なので `discriminatedUnion` は使えない。network の形で分ける）:

| 欄 | 共通 | `exact`/EVM | `exact`/SVM | `tempo/charge` | `solana/charge` |
|---|---|---|---|---|---|
| `extra.challengeNonce` | | `0x`+64 hex | `0x`+64 hex | mppx id（base64url 43） | mppx id |
| `extra.expiresAt`・`routeBinding`・`fundsMoveOnCredential` | 必須 | `false` | `false` | `true` | `true` |
| 固有 | | `name`・`version`（表の domain と一致） | `feePayer`（base58）・`memo` = nonce | `challenge`（文字列 ≤ 8 KiB） | `challenge`・`externalId`・任意の `decimals`・`tokenProgram` |

- `quoteId`・`approval.boundTo` は **hex か mppx id**（Tempo の実応答の `quoteId` は mppx id。2026-10-12 に確認）。`quoteId === offer.extra.challengeNonce` は今のまま。
- `source.rail`: `x402 | mpp`。`network`・`asset`・`decimals` は **表（PAYER_NETWORKS）に一致**。`source.payTo` は network の形。
- `destination`: `rail`・`scheme?`・`network`・`asset`・`quoted`・`decimals?`・`payTo`・`quoteFingerprint`。
- `routeId`: `^(md|dyn)-[a-z0-9-]{1,60}$`。`resource.url` は **routeId から導く**（`<base>/v1/routes/<routeId>/resource`。hosted は `http://127.0.0.1:8500`）。`routerIdentity` は `canonicalResourceFor(routeId)` に（固定の `RESOURCE_PATH`/`ROUTE_BINDING` は **旧の組み立て（§2.4a）にだけ** 残す）。
- `routeBinding` の期待値: 静的 `<routeId>|GET|<encoded path>`、動的 `dynamic|<profileId>|GET|<encodeURIComponent(url)>`（2026-10-12 の実応答で確認）。
- 動的の追加欄（全部必須）: `upstream: { url: https ≤ 2048, method: "GET" }`、`pricing: { upstreamAmount, converted, fee, total, maxFee?, estimate?: { gas, maxFeePerGas, bound, atMs }, sourceDecimals, destinationDecimals }`、`disclosures`（固定の bool と配列。hosted の形）、`ownerKey`（base64url 43）。`total === source.amount`、`upstreamAmount === destination.quoted` を照合。
- `subject` の期待値: 静的は今の形。動的は hosted の `approvalSubject` と同じく `upstream`・`destinationPayTo`・`destinationDecimals`・`pricing`・`disclosures` を足す（実応答で確認済み）。
- `ApprovalRecord`（v2）の追加: `kind: "static" | "dynamic"`、`wallet: { rail, network, address }`（offer の network に対応する鍵のアドレス）、`source.scheme`、**`source.offerSha256`**（`sha256(canonicalJson(source.offer))`。transaction に効く全欄の束縛）、動的は `upstream`・`pricing`・`disclosures`。`ownerKey` は **入れない**（§1 FR-R8）。
- `assertApproval`（v2）: 既存の個別の欄の照合 ＋ `sha256(canonicalJson(offer)) === r.source.offerSha256`。MPP の `challenge` の全文は記録に入れず、digest で束縛する。

#### 2.4a 0.1.x の記録（FR-R15）

- 既存の `buildRecord` を **`buildRecordV1`** として凍結（schema も `quoteSchemaV1` として残す。固定の `RESOURCE_PATH`・`ROUTE_BINDING`・`STATIC_ROUTE` はここだけが使う）。
- 台帳の `quoted` 行の `data` に `kind` が **無ければ v1**、あれば v2。`rehydrate` は行ごとに版を決めて組み立て、`same(r, row.data)` と hash の照合は **その版の記録** で行う（hash は変わらない）。`guard()`（purchase.ts）も entry の版で組み立てる（`e.version`）。
- v1 の entry は `assertApproval` も v1（`offerSha256` が無いので個別の欄だけ。0.1.x と同じ強さ）。`subjectOf`・`render` は v1 の形も描ける（`kind` 省略 = static、x402/Base Sepolia）。
- 新しい quote は常に v2 で書く。移行・書き換えはしない。

### 2.5 Router client・handler・protocol・回復

- `RouterClient.quote(routeId, requestId)` は routeId の形だけ見る。`quoteUrl(profileId, url, requestId)` を追加（`subetha_router_quote_url`）。`status(paymentId, ownerKey?)`。
- `inputs.quote = z.union([{routeId}, {profileId, url}])`（strict）。`url` は https・≤ 2048・userinfo/fragment なし。
- `handler.find_routes`: 静的は §1 FR-R13 の規則で `pays.rail` を決め、`dynamic.profiles` は `source.rail` をそのまま。`fundsMoveOnCredential` = `pays.rail === "mpp"`。`needsSol` = Solana の MPP。表外の network は落とす。
- `handler.wallet`: §1 FR-R11。
- **purchase core**:
  - `quote(params)` が静的/動的で client を分ける以外は同じ。`submit` は `quote` 文書を **封印から** そのまま渡す（`ownerKey` 込み）。
  - `reconcile` の `status` は動的なら `ownerKey`（封印の raw から）を渡す。
  - **射影の正規化 `normalizeProjection(p)`**: hosted の `status` が動的の `result` を `{untrusted, source, contentType, body}` で包んで返すので、読んだ直後に `result` を `body` に剥き、`matchingProjection`・`projectResult`・台帳の `projection` の保存・`rehydrate` の比較（`projection.result` と `result.result.body`）は **全部この正規化後の形** で行う。静的（包まれていない）はそのまま。
  - **初回送信の回復（SR-R7）**: `state === "signed"` のとき、Router の `status` が `not_found` **または** `found` で `projection.status === "awaiting_payment"`（記録と一致する射影）なら、`approvalDeadlineMs`/`expiresAt` の内側で **1 回だけ** `submit`（`submit_intent` を先に書く。既存の `submit` の経路）。`signed` という状態そのものが「`submit_intent` の行が無い」の根拠（遷移表で `signed` → `submit_intent`）。`inspect`（`allowSubmit: false`）は送信せず `unknown` を返す（今と同じ）。`submit_intent` 以降で落ちたものは送信しない（`unknown`）。
  - `projectResult` は `proof.upstreamReceipt` を `kind` で決め（static `none`、dynamic `claimed`）、`rehydrate` の `upstreamReceipt` の検査も `kind` で。
  - **`signed` の封印** は `{ credential, txRef? }`（strict）。`rehydrate` は `e.txRef` を復元し、`current()` は `signed` 以降で `txRef` を出す。`inspect` の行にも出す。
  - **`resultSecrets`**（SR-R4）: 既存（credential の封筒、合言葉、challengeNonce、offer の JSON 全文、`ownerKey`）に足す: `offer.extra.challenge`（全文）、封筒を JSON として decode できれば `payload` の **全部の文字列の葉**（内側の `Payment …` wire、`transaction`（base64）、`signature`）、さらに **内側の mppx の wire（`Payment …`）を `Credential.deserialize` で開いて、その `payload` の文字列の葉（Solana MPP の `transaction`、Tempo の `hash`）も足す**（D-2 #6）、`txRef`。`containsResultSecret` は今のまま（そのまま・base64・hex・key の位置）。
- `PurchaseSummary` に `txRef?`（`0x`+64 hex）。`SubjectSummary` に `routeId`・`kind`・`scheme`・`disclosures?`。`RouteSummary` の `pays.amount` は動的で省略（既に optional）。
- `KNOWN_CODES` に足す: `wallet_missing`。

### 2.6 dialog（`render`）

今の行の後に、レール別の固定文（例）:

```
Rail: mpp (tempo/charge) on eip155:42431
Funds: the daemon SENDS this transfer right after you approve; it cannot be undone and nothing is refunded if the Router later refuses.
```
```
Rail: mpp (solana/charge) on solana:EtWT…
Funds: signing only; the Router broadcasts at purchase. Your Solana key pays the network fee (devnet SOL).
```
```
Rail: x402 (exact) on eip155:84532
Funds: signing only; the facilitator broadcasts and pays gas at purchase.
```

動的なら:

```
Upstream (NOT verified by the operator): GET https://x402.vercel.app/protected
Upstream recipient: <destination.payTo>
Price: upstream 10000 + Router fee 1000 = total 11000 base units (decimals 6); chain-fee cap 158 (estimated 2026-10-12T10:27:38Z)
Disclosures: no refund if the upstream takes the payment and returns no usable data; only an application/json object <= 256 KiB is delivered.
```

URL は `sanitize` の後に `^https://[\x21-\x7e]{1,2040}$` の形だけ許す（それ以外は `quote_inconsistent` で quote の段で落とす）。

### 2.7 CLI

- `wallet new|add solana|address|balance`（§1 FR-R10）。`balance` は 4 行（network・asset・amount）＋ Solana は `SOL <lamports>`。RPC: Base `https://sepolia.base.org/`、Arc `https://rpc.testnet.arc.io`（`docs/multirail-requirements.md`）、Tempo `https://rpc.moderato.tempo.xyz`、Solana `https://api.devnet.solana.com`（`getTokenAccountBalance` の ATA と `getBalance`）。失敗は `rpc_failed`。
- faucet の案内（`wallet new`・README）: Base Sepolia / Arc testnet / Solana devnet の USDC は `https://faucet.circle.com`、devnet SOL は `https://faucet.solana.com`、Tempo の pathUSD は Tempo の faucet（`https://docs.tempo.xyz/docs/quickstart/faucet`。RPC `tempo_fundAddress` でも取れる）。
- 既存の `inspect` に `txRef` の行（あれば）。

### 2.8 Router 側（別 PR、加算）

- `src/http/projection.ts` `routeListBody`: 静的 route の `source` に `rail: route.sourceRail`・`scheme`（x402 → `exact`、mpp → network の family で `tempo/charge` / `solana/charge`。`subetha` 受信は欄なし）。試験 `tests/unit/projection-solana.test.ts` を更新（実施済み、3 ファイル 7 件 pass）。
- `tools/mpp-payer.ts`: `options.fetchFn`（任意）を viem の `http` に渡す（実施済み。既定は変わらない）。
- 配備は owner（`deploy/swap-image.sh`）。payer は `source.rail` の有無どちらでも動く（§1 FR-R13）。

### 2.9 版・配布・docs

- `@subetha/payer` 0.2.0（`package.json`・shim/daemon/client の `version` 文字列・`PingSummary`）。shrinkwrap を再生成（実施済み: 新依存 5 本が root と同じ版で固定）。`pack.test.ts`・`deps.test.ts`・`vendor.test.ts` の期待を更新。
- README: 「Create and fund」を 4 network に、「First quote」を全 route・`quote_url` に、「Upgrading」に 0.1.x → 0.2.0（`install accept`、`wallet add solana`）。`limits` の節から「1 route だけ」を外す。
- `CLAUDE.md`（payer の節）と LP の `router/llms.txt`（別 repo、owner が merge）: tool の引数の形、資金の時点、faucet。

## 3. タスクと PR

| ID | 内容 | PR | 試験 |
|---|---|---|---|
| R-0 | Router: `routeListBody` に `source.rail`/`scheme`、`tools/mpp-payer.ts` の `fetchFn` | Router PR | `npm test`（root） |
| R-1 | payer: vendor 14 本、依存、`sign/index.ts` の振り分けと guarded fetch、`Session` の鍵 map、`keys`（`wallet new` 2 鍵・`wallet add solana`） | payer PR 1 | unit: vendor・sign・keys・transport、wire: cli |
| R-2 | payer: `record.ts` の v2 schema と v1 の凍結、`routerIdentity` の routeId 化、`summary`/`socket`/`client`/`handler`/`purchase`/`recover`/`secrets`、dialog、初回送信の回復、射影の正規化 | payer PR 2 | unit: record・render・summary・handler・secrets、wire: purchase（5 レール）・crash 行列（動的＋Tempo）・secrecy・v1 台帳 |
| R-3 | payer: CLI `balance` 4 network、README・CLAUDE.md、0.2.0、pack | payer PR 3 | pack・deps・readme-commands・clean-install |
| R-4 | 親: hosted 読取 smoke（AC-R7）、Codex 最終レビュー、kit の記録 | — | — |
| G-R1 | owner: `npm publish` 0.2.0、hosted Router の配備（R-0） | — | — |
| G-R2 | owner: 資金の動く受け入れ（AC-R8）。親は手順書と記録 | — | — |

PR はこの順。R-1 と R-2 は同じ worktree（`task/payer-rails`）で続けて作業し、PR は分けて出す。各 PR は Codex の読取レビュー（`codex exec --sandbox read-only`）と実行した試験の結果を本文に。

## 4. 未確認（実装で確かめる）

1. hosted の静的 Solana route の `source` に `rail` が無い間、payer の推定（`-solmpp`）が 2 route とも正しいこと（一覧の実応答で確認: `md-x402-eth-snapshot-solmpp`・`md-mpp-eth-snapshot-solmpp` が MPP、`md-x402-eth-snapshot-sol` が x402）。
2. mppx 0.11.0 の `createCredential` が daemon の process で `globalThis.fetch` を置き換えないこと（`polyfill: false`。tools と同じ）。viem の `http` が `fetchFn` を全要求に使うこと（送金の `eth_sendRawTransaction` も）。
3. `@solana/kit`・`mppx`・`undici` の import が `dist/` の ESM で動くこと（tools は tsx 経由）。`deps.test.ts` の「`.node` なし」が新依存でも成り立つこと。
4. hosted の `quote_url` の rate limit（60 秒に 2 回/送信元）が AC-R7 の smoke に効く → レール別に 60 秒空ける。
5. 静的 quote の `status` が purchase の前に `not_found` を返すこと（0.1.x の前提）と、動的が `awaiting_payment` を返すこと（`orchestrator.ts:990`）の両方を fake に写す。

## 4a. 実装で決めたこと（設計との差分。2026-10-12、R-0〜R-3）

- `tools/svm-rpc.ts` は Router の `src/net/guarded-fetch.ts`・`destination-policy.ts`・`bounded-body.ts` ごと vendor（14 本）。Tempo の RPC は `tools/mpp-payer.ts` に足した `options.fetchFn` に、payer の `src/sign/transport.ts`（guarded transport ＋ 64 KiB の本文上限）を渡す。
- `config.json` の `rpc` は Arc（`eip155:5042002`）も取る（`wallet balance` の読取のため。FR-R12 の 3 つ＋1）。既定の URL は末尾 `/` 付き（`validRpc` が WHATWG 正規形だけを通す）。
- `quote` の入力は 1 つの object schema `{routeId?} | {profileId?, url?}`（MCP の tool の入力は object でなければならない。どちらか一方だけを `refine` で強制）。
- 記録の identity: `DaemonContext.address`（EVM）が `wallets.eip155` に対して権威（0.1.x の「設定した wallet が変わった」検知を保つ）。`wallets` を持たない旧形式の identity は `{ eip155: address }` と読む。
- `assertApproval` は v1 の記録（`kind` 無し）には 0.1.x の個別の欄の照合、v2 には加えて `offerSha256`。`destination` が payer の表の資産を名乗るときは rail（表の outbound）と decimals も表と一致を要求（0.1.x と同じ強さ）。
- hosted の静的 route の一覧に `source.rail`・`scheme` が無い間の推定は `handler.ts` `staticSourceRailOf`（表で一意、Solana は `-solmpp`）。試験は両方の一覧で同じ結果を見る。
- `wallet balance` の SOL は `WalletSummary` の行（`rail: mpp`、`decimals: 9`）として出す（新しい欄は足さない）。
- 署名の例外は `rail_not_enabled`・`invalid_signing_key` 以外 `sign_failed` に落とす（0.1.x と同じ）。Tempo の `txRef` は `0x`+64 hex のときだけ記録。

## 6. owner gate の記録（2026-10-12）

- **G-R1（publish）** 12:0xZ: owner が `npm publish ./subetha-payer-0.2.0.tgz --access public`（main `53ab05a` から親がビルド）。registry: `dist.integrity` `sha512-VKwkGznTBdrxrGb+OwZnZ3eQP5w0xI3hWJVhV7URlbsAQNCmeyTiqd9ae8F7J5/BW0v6FdthlrEUb+4ndykbJw==`、`dist.shasum` `bf5e3ec3b5b358668577dcee421edac3569f9b89`、`_hasShrinkwrap: true`、60 files。隔離 prefix への registry install: 163 locked packages 一致、`.node` なし、`daemon --check` exit 0。
- **R-0 の配備** 12:14:58Z: hosted を `subetha-router:b-53ab05a` に（`swap-image.sh` exit 0、入口の閉鎖約 7 秒、rollback `subetha-router-prev-20261012T121458Z` = b-a89a979）。`list_routes` の固定 10 route に `source.rail/scheme`。
- **G-R2（資金の動く受け入れ。owner の Mac、payer 0.2.0、ネイティブダイアログで承認。親は MCP stdio client から production の shim `subetha-payer mcp` を呼んだ）**:

| # | レール | route / profile | ref | paymentId | 結果 |
|---|---|---|---|---|---|
| 1 | Tempo pathUSD（MPP、承認で送金） | `md-x402-eth-snapshot` | `p_74tzq2vwhhg6k` | `eaafea10-6478-4938-9992-fd684a5e08d2` | `delivered`、`txRef 0x3b035bbffaa308bce500d10f3e441d5198ac083b30d9a24b1e6afd4c2674613f` |
| 2 | Arc testnet USDC（x402） | `md-mpp-eth-snapshot-arc` | `p_72c6tqrcptlsa` | `8bc61a3d-9cad-444d-bbd4-c050bb35d56d` | `delivered`（先行の `p_4c2zelbmcvzsm` は owner の誤 Cancel で `approval_rejected`、資金は動かず） |
| 3 | Solana devnet USDC（x402） | `md-x402-eth-snapshot-sol` | `p_l7wgonj4kjx7e` | `fa58bb6e-463c-47b4-a6d5-040137a89e03` | `delivered`（先行の `p_zlgcesojz23vo` は Enter = Cancel で `approval_rejected`） |
| 4 | Solana devnet USDC（MPP、鍵が fee payer） | `md-mpp-eth-snapshot-solmpp` | `p_yrbgqvfhjocsa` | `e6471b21-29e1-496c-a36f-44d681a205c2` | `delivered` |
| 5a | 動的: Solana devnet USDC → x402.org demo | `dyn-sol-to-x402` + `https://x402.vercel.app/protected` | `p_mhkjrovck5s7y` | `3af1113e-4c36-47dd-b4db-b34b761774d7` | **`paid_data_unavailable`**（Router journal: `source_settled` Solana tx `5cZvVFdk…r1bs`、`paid_undelivered` reason `unsupported_response`: 上流が JSON object を返さない。開示どおり。payer は `fundsMoved: yes`、再試行なし） |
| 5b | 動的: Solana devnet USDC → 当方 Provider A | `dyn-sol-to-x402` + `https://provider-x402.subethalabs.com/v1/eth/snapshot` | `p_og22qppqsncfa` | `a20ff6e2-d790-412c-842f-297b19fc629b` | `delivered`、`upstreamReceipt: claimed` |

- **他の agent CLI からの購入（2026-10-12 13:10–13:15Z、同じ payer 0.2.0 と daemon、owner がダイアログで承認。両 CLI の設定に `tool_timeout_sec = 200` を足した上で）**:

| CLI | route | ref | paymentId | 結果 |
|---|---|---|---|---|
| OpenAI Codex CLI 0.157.1（`codex exec`、payer の MCP tools だけ） | `md-mpp-eth-snapshot` | `p_5iwp7yapkb5ym` | `75586c40-9ab9-4c8d-b060-ca7c5fda6615` | `delivered` |
| Grok Build 1.0.50（`grok -p`、payer の MCP tools だけ）1 回目 | `md-x402-eth-snapshot-sol` | `p_24mnczg6g4s3s` | `158a635c-c76e-46c4-a6ae-87761ab5992b` | `paid_data_unavailable`: Router journal `source_settled`（Solana tx `X5WEgaPf…DSUL`）→ `dest_failed` reason `destination_rejected`（送信レグの Provider A 側が拒否。同 route は 12:30Z に `delivered`。同種の拒否は 10/5・10/8 ×2 にも各 1 回） |
| Grok Build 2 回目 | `md-mpp-eth-snapshot` | `p_unsv3ivasfx5o` | — | `delivered` |

Grok は shim の表示専用 elicitation を閉じて tool call を「中断」と報告したが、daemon は完了し `status` で結果が読めた（llms.txt に明記）。payer の `KNOWN_CODES` に `destination_rejected` が無く `unknown_code` と出た → 次版で追加。

学び: (1) 一度 Cancel した ref は記憶され、同じ ref への再要求は即座に同じ答え（設計どおり。新しい quote が要る）→ README に明記。(2) ダイアログの既定ボタンは Cancel なので Enter は Cancel → README に「Approve はクリック」。(3) Router の `paid_undelivered` の reason（`unsupported_response` など）が payer の `KNOWN_CODES` に無く `unknown_code` に写っていた → 追加。(4) x402.org の demo endpoint は購入すると「払って無データ」になる（quote のデモには使えるが購入には当方の Provider を使う）。

## 5. 独立レビューの記録

| # | 日付 | reviewer | 結果 |
|---|---|---|---|
| D-1 | 2026-10-12 | `gpt-6-astra`（read-only、第 1 版） | **REJECT**（6 件: 旧台帳の回復、feePayer の束縛、動的 `signed` の初回送信、包まれた結果と `txRef` の回復、Tempo の transport、MPP の秘密のフィルタ。nonblocking: `discriminatedUnion`、`quoteId` の形、`undici`）。**第 2 版で反映**（冒頭の注） |
| I-1 | 2026-10-12 | `gpt-6-astra`（read-only、実装の staged diff） | **REJECT**（P1 ×2: Arc の offer の `extra.assetTransferMethod: "eip3009"` を strict な鍵の集合が拒んでいた（AC-R8 の Arc が落ちる）; 秘密フィルタが payload の全文字列と key（`"0"`・`"to"`・`"value"`）を秘密にしていて通常の結果を `unknown` にし、再開で `store_corrupt` になり得た。nonblocking: AC の wire 化、Tempo の transport 失敗 → unknown の試験）。**同日に修正**: EVM の extra に `assetTransferMethod`（値は `eip3009` だけ）を許容、`dyn-arc-to-x402` の fixture と試験; 秘密は payload の `signature`/`credential`/`transaction`/`hash`（32 文字以上）と内側の mppx の payload に限定し、実物の EIP-3009 credential と現実的な本文の positive test、Tempo の signer 失敗 → durable unknown の試験を追加 |
| I-2 | 2026-10-12 | `gpt-6-astra`（readback、修正後） | **APPROVE**（P1 ×2 とも resolved。秘密の網羅: EIP-3009 の signature・Solana の transaction・内側の mppx の wire/transaction/hash・Tempo の txRef・challenge・ownerKey・合言葉・challengeNonce・offer の JSON。nonblocking: 長い公開値（アドレス・無関係の hash）が通る回帰試験を足す → 同日に追加）。payer 864 passed / 4 skipped、Router unit 997 passed |
| D-2 | 2026-10-12 | `gpt-6-astra`（readback、第 2 版） | **REJECT → 同版で反映**: #1〜#5 resolved、#6 は「内側の mppx の wire の中の transaction も秘密に」（§2.5 の `resultSecrets` に追記）。nonblocking: Tempo の fetch の本文上限（§2.3 に追記）。新しい blocking なし。実装の最終レビューで確認する |
