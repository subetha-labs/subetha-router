# 設計: EVM testnet 4 つの x402 受信・送信（Robinhood・Arbitrum Sepolia・HyperEVM・Ethereum Sepolia。第 3 版、2026-10-13）

> 要件・設計・タスクを 1 本にまとめる（`docs/payer-rails-design.md`・`docs/mainnet-first-route.md` と同じ形）。owner の依頼（2026-10-13）:
> 4 つの testnet・通貨で x402 の inbound と outbound を足す。まず既存の検証済み経路を相手側に使い、各チェーンの両方向を成立させる。
> 総当たり・ブリッジ・DEX・自動補充は対象外。testnet 限定。完了は **チェーン × 方向ごとの実プロセス・実 HTTP・実 testnet 決済の E2E**。
> 第 1 版は独立レビュー（Codex `gpt-6-astra`）で REJECT（10 件。§6）。第 2 版で反映: Provider の EVM 化の範囲（§3.4）、チェーン別の期限の表（§3.6）、facilitator の settle を自前にし「使用済み」を未払いと読まない（§3.3）、子 process の能力の注入（§3.5）、origin の完全一致の強制（§3.5）、facilitator の呼び出し元の認証と gas の上限（§3.3）、予算の総額（§3.7）、再起動後の再読と finality（§2.3・§3.9）、domain の修正を 4 network に限定（§3.2）。
> 第 2 版の readback（D-2）も REJECT（未解決 3・新規 2）。第 3 版で反映: settle の順序（使用済みの照合を時間・束縛の検査より先に。verify の失敗の後にも照合。§3.3）、送出の意図の永続と再起動時の保留（§3.3）、allowlist 外の loopback は起動時に拒む（§3.5）、期限を「残り時間」で組み直す（§3.6）。
> 既存の設計の決定は変えない。本書は **加算** だけ。公開の設定生成（`routerConfigOf`・golden）と hosted Router は **変えない**（§3.5）。

## 0. 一枚で

- 4 つの network を表（`KNOWN_NETWORKS`）に足す。資産・domain は公式の一覧と読み取り専用 RPC で確かめた値（§1）。どれも **EIP-3009（`transferWithAuthorization`）を実装している**。
- **facilitator が無い**: Robinhood testnet（46630）に対応する公開 facilitator は無い。x402.org は 4 つとも非対応。PayAI は Arbitrum Sepolia だけ、x402.rs は Arbitrum Sepolia・Ethereum Sepolia・HyperEVM を `/supported` に載せるが EVM の signer を公開しておらず settle の実績が確かめられない（§1.3）。
  → **自前の EVM facilitator**（`tools/evm-facilitator.ts`。x402 v2 の `/supported`・`/verify`・`/settle`。中身は依存済みの `@x402/evm` の `ExactEvmScheme`（facilitator 側）で、新しい暗号コードは書かない）を別 process で立てる。Router は既存の kind `x402` の facilitator 接続をそのまま使う（**受信 adapter は変えない**）。
- 経路（各チェーン C について 2 本、静的 route。動的プロファイルは今回は作らない §5）:
  - **受信** `md-x402-eth-snapshot-<c>`: クライアントが C の通貨で Router に x402 で払う → Router が **Provider A**（hosted、Base Sepolia USDC の x402。検証済み）を買う → 結果を返す。
  - **送信** `md-<c>-eth-snapshot`: クライアントが **Base Sepolia USDC**（x402。x402.org facilitator。検証済み）で Router に払う → Router が **C の通貨で C の Provider** を x402 で買う → 結果を返す。
- C の Provider は既存の `providers/x402-workers`（Arc・Solana の Provider と同じ Worker のソース）に 4 つの env を足し、**手元で `wrangler dev`** で動かす（配備しない）。facilitator は上の自前のもの。
- 起動は mainnet の 1 経路と同じく **専用の入口**（`tools/evm-testnets-run.ts` → `startHost` の分岐 → 専用の設定生成 `evmTestnetsConfigOf` → **専用の子 process** `tools/evm-testnets-router-process.ts`）。loopback の facilitator・Provider に届くよう、この子 process だけが能力 `localCounterparties`（loopback の literal origin の完全一致）を渡す（§3.5）。
- Router 本体（`src/`）の変更は 2 つ: (a) kind `x402` の EVM 受信が表の EIP-712 domain を offer に渡していない（既定 `USDC`/`2` 固定。`src/main.ts:742-748`）。Arbitrum Sepolia（`USD Coin`）と Robinhood（`Global Dollar`/`1`）で誤った domain になる。**新しい 4 network に限って** 表の domain と期限を渡す（Base mainnet でも潜在しているが、別の修正として owner に挙げるだけで今回は触れない。§3.2）。(b) 専用の入口だけが渡す能力 `localCounterparties`（§3.5）。

## 1. 確かめた事実（2026-10-13、証跡 `docs/evidence/evm-testnets/`）

### 1.1 チェーンと資産（公式の一覧 + 読み取り専用 RPC。`token-probe.mjs` の出力 `token-probe-2026-10-13.txt`）

| 名前（短縮） | CAIP-2 | RPC（公開、既定） | 資産 | `name()` / domain | decimals | 実装 |
|---|---|---|---|---|---|---|
| Robinhood Chain testnet（`rh`） | `eip155:46630` | `https://rpc.testnet.chain.robinhood.com` | USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F` | `Global Dollar` / **`1`**（`version()` は無い。`DOMAIN_SEPARATOR()` を name・`1`・chainId・address から再計算して一致） | 6 | ERC-1967 proxy → `0xf0863d7a…`。EIP-3009 は facet 経由 |
| Arbitrum Sepolia（`arbsep`） | `eip155:421614` | `https://sepolia-rollup.arbitrum.io/rpc` | USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | **`USD Coin`** / `2` | 6 | Circle FiatToken（proxy → `0xfbb8ee01…`） |
| HyperEVM testnet（`hyperevm`） | `eip155:998` | `https://rpc.hyperliquid-testnet.xyz/evm` | USDC `0x2B3370eE501B4a559b57D449569354196457D8Ab`（Circle の ERC-20。HyperCore の取引用 USDC ではない） | `USDC` / `2` | 6 | Circle FiatToken（→ `0x667454c8…`） |
| Ethereum Sepolia（`sepolia`） | `eip155:11155111` | `https://ethereum-sepolia-rpc.publicnode.com` | USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `USDC` / `2` | 6 | Circle FiatToken（→ `0xda317c1d…`） |

- 4 つとも `eth_chainId` が依頼の値と一致。資産のアドレスは Paxos（USDG testnet）と Circle（USDC contract addresses）の公式ページの値と一致。
- EIP-3009 の確認（4 つとも）: `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` = `0x7c7c6cdb…2267`（EIP-3009 の型）、`RECEIVE_WITH_AUTHORIZATION_TYPEHASH()`・`authorizationState(address,bytes32)` が読める。でたらめの (v,r,s) で `transferWithAuthorization` を simulate すると **署名の検査で** revert（Circle: `FiatTokenV2: invalid signature`、USDG: custom error `0x8baa579f` = `InvalidSignature()`）。関数が無い revert（selector 不一致）ではない。USDG は proxy の主実装の ABI には無く facet が受ける（依頼の注意どおり）。
- `paused()` は 4 つとも false。gas: Robinhood 0.01 gwei、Arbitrum Sepolia 0.02 gwei、HyperEVM 0.1 gwei（block の gas 上限 3,000,000。transferWithAuthorization は ~90k で収まる）、Ethereum Sepolia ~0.001 gwei。
- **名前で識別しない**: 表は `network` + 資産アドレスで引く（`knownAssetOf`。既存）。Arbitrum Sepolia の `USD Coin` と他の `USDC` の違い、USDG の `Global Dollar`/`1` は domain の値として表に入れ、offer の `extra.name/version` と署名の組み直しはこの値だけを使う。

### 1.2 SDK

- `@x402/evm` 2.28.0 の client（`ExactEvmScheme`）は chainId を `eip155:<id>` の正規表現で読み、domain を `requirements.extra` から読む。network の allowlist は無い。`DEFAULT_ASSETS` は Arbitrum Sepolia だけ持つ（`USD Coin`/`2`。§1.1 と一致）。Router は自前の allowlist（`allowedAssets`）を渡しているので既定の資産表には依らない。
- `@x402/evm/exact/facilitator` の `ExactEvmScheme(signer)`（facilitator 側）は `caipFamily = "eip155:*"`、chainId は network 文字列から。verify は EIP-712 の検証 + 資産が contract であることの確認 + `transferWithAuthorization` の simulate。**hard-coded の chain 表は無い**（受け入れで実測して確かめる。AC-E6）。
- **settle は SDK に任せない**: 固定版 2.28.0 の `settleEIP3009` は receipt の待ちに失敗すると `success: false`・`errorReason: "settlement_pending"` を返す（`dist/cjs/exact/facilitator/index.js` `waitAndReturnSettleResponse`・`settlementPendingResponse`）。Router の kind `x402` は `success !== true` を `rejected`（= 未払い扱い）に写す（`src/adapters/inbound/x402.ts:374-376`）ので、送出後の不明を未払いと誤る。facilitator は SDK の **verify だけ** を使い、送出・receipt・結果の写像は自前で書く（§3.3）。
- `AuthorizationUsed(authorizer, nonce)` の event: Robinhood USDG・Arbitrum Sepolia・Ethereum Sepolia で実在を確認（直近の block 範囲の `getLogs`。HyperEVM の公開 RPC は広い範囲の `getLogs` を拒んだので E-2 で狭い範囲で確かめる）。使用済みの authorization から tx を辿る根拠に使う（§3.3）。
- block 時間（直近 100 block の平均）: Robinhood 0.18 秒、Arbitrum Sepolia 0.26 秒、HyperEVM 0.99 秒、Ethereum Sepolia 12 秒。`finalized` の遅れ: Robinhood 1,010 秒、Arbitrum Sepolia 916 秒、Ethereum Sepolia 864 秒、HyperEVM 0（単一 slot の確定）。

### 1.3 facilitator の対応（各 `/supported` の取得結果 `supported-*.json`）

| facilitator | 46630 | 421614 | 998 | 11155111 |
|---|---|---|---|---|
| x402.org | × | × | × | × |
| PayAI | × | v2 exact | × | × |
| x402.rs | × | v2 exact | v2 exact | v2 exact |

x402.rs は `signers["eip155:*"]` が空（settle する鍵を公開していない）。3 者とも運営の検証はしていない。**Robinhood は自前でしか成り立たない**ので、4 つを 1 つの自前 facilitator にそろえる（実装 1 つ、試験 1 つ、資金の流れが追える）。第三者 facilitator との相互運用（PayAI の Arbitrum Sepolia など）は本書の完了条件に含めず、別の検証として扱う（§5）。

### 1.4 既存のテスト用ウォレット（鍵の値は出さない。`.claude_workflow/local/*.env`）

| 名前 | アドレス | 4 チェーンの残高 | Base Sepolia USDC |
|---|---|---|---|
| T7（使い捨ての payer） | `0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1` | native 0 / token 0 | 19.557 |
| T8（Router の受取鍵） | `0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405` | native 0 / token 0 | 0.082 |

→ 4 チェーンの資金はまだ無い。faucet の請求は owner の手（§3.8）。


## 2. 要件

### 2.1 機能（FR-E）

- **FR-E1** 表に 4 行を足す: `inbound: ["x402"]`、`outbound: ["x402"]`、`x402Facilitator: "x402"`、資産 1 つ（§1.1 の id・decimals 6・domain）。payer の vendor の写し（`packages/payer/src/vendor/networks.ts`）も byte 一致で更新する。payer の対応 network（`PAYER_NETWORK_IDS`）は **変えない**（payer は今回の対象外。表に足しても payer は `rail_not_enabled` で拒む）。
- **FR-E2** 新しい 4 network の kind `x402` 受信は、表の資産の domain を offer の `extra.name/version` に出し、facilitator の HTTP 期限を §3.6 のチェーン別の値にする（§3.2）。それ以外の network（Base Sepolia・Base mainnet など）の呼び出しは変えない。
- **FR-E3** 自前の EVM facilitator（§3.3）: x402 v2 の `GET /supported`・`POST /verify`・`POST /settle`。4 network × `exact` × EIP-3009 × 表の資産だけ。呼び出し元の認証、受取先の allowlist、金額と gas の上限、network ごとの直列、送出の前後を区別した結果の写像、使用済みの authorization の chain からの照合。
- **FR-E4** Provider: `providers/x402-workers` を EVM の 4 network でも動くようにする（network の受け入れ・アドレスの検査・payer の取り出し・receipt の検査・期限・`maxTimeoutSeconds` を EVM の行で一般化。§3.4）。手元の `wrangler dev` で動かし、配備しない。
- **FR-E5** 専用の設定生成 `evmTestnetsConfigOf(env, receiver, chains)`、専用の入口 `tools/evm-testnets-run.ts`、専用の子 process `tools/evm-testnets-router-process.ts`（§3.5）。各 C について受信 route `md-x402-eth-snapshot-<c>`（C の通貨 10,000 → Provider A に Base Sepolia USDC 10,000）と送信 route `md-<c>-eth-snapshot`（Base Sepolia USDC 10,000 → C の Provider に C の通貨 10,000）。testnet なので USDG・USDC・Base USDC を 1:1 とみなす（D-17 と同じ扱い）。予算は §3.7。
- **FR-E6** 公開の入口（`tools/remote-mcp.ts` の既定の plan・`routerConfigOf`・`RAILS_ACTIVATION`・`tools/remote-router-process.ts`・`routerProcessCapabilitiesOf`）、hosted Router、既存の route・プロファイル・既定値は変えない。`tests/unit/config-golden.test.ts` の golden は **byte 一致のまま**。
- **FR-E7** 受け入れの driver `tools/evm-testnets-e2e.ts`（§3.9）: `plan`（資金の表を出すだけ。何も署名しない）と `run --plan-sha256 <owner が承認した plan の hash>`。run は 1 購入ずつ quote → subject を plan と照合（network・資産・金額・受取先・上流）→ 署名（`npm run sign` と同じ `runSign`）→ purchase → status。plan から外れた subject・想定外の結果では止まる。自動の再試行はしない。
- **FR-E8** `finality` と `reopen` の段（§3.9）: 後から chain の確定を読み、Router を同じ journal で再起動して全 paymentId の status を読み直す。

### 2.2 安全（SR-E）

- **SR-E1** 既存の不変条件をそのまま保つ: 明示的な承認、offer・route・金額・network の束縛、verify してから settle、2 レグの同一性、高々 1 回、`unknown` の永続、再試行しない。受信・送信の adapter のコードは変えない（呼び出し側が渡す option だけ）。
- **SR-E2** loopback を許すのは専用の子 process が渡す `localCounterparties` の origin に限る。origin は `http://127.0.0.1:<port>` の literal だけ（名前は不可）。その能力で作る transport は **要求ごとに origin の完全一致を確かめ**（不一致は送出前に拒否）、redirect の拒否・既存の address の pinning はそのまま。起動時に、該当の adapter の URL が全部 allowlist にあることを確かめる（1 つでも外れれば起動しない）。公開の入口・hosted・動的上流の transport・Base Sepolia の transport には効かない（試験で固定）。
- **SR-E3** facilitator の gas 鍵は facilitator の process だけが読む。bind は 127.0.0.1。呼び出しは path の秘密の接頭辞（`/<token>/…`。32 バイトの乱数。URL の path は Router の設定で許される）で認証し、`Origin` ヘッダのある要求・`Host` が `127.0.0.1:<port>` でない要求は拒む。受け入れの前に §3.3 の前段の検査。network ごとの待ち行列は 2 件まで、process の寿命での gas の累計に network ごとの上限（§3.8 の owner 承認値）。
- **SR-E4** 「使用済み」を未払いと読まない: 送出前に `authorizationState` が使用済みなら、chain の `AuthorizationUsed` と `Transfer` から tx を辿り、要求と完全に一致（資産・from・to・value・nonce）する確定済みの tx があればそれを `success: true` で返す。辿れない・一致しない・未確定なら 5xx（Router は `unknown`）。4xx（= Router の `rejected`）は **その authorization が chain で未使用で、この facilitator が送出していないと確かめたとき** だけ（§3.3 の原則と手順）。送出の意図は永続の journal に書いてから送出し、未解決の送出がある network は再起動後も保留にする。
- **SR-E5** 鍵・秘密（facilitator の token を含む）は log・commit・証跡に出さない。新しい鍵は `.claude_workflow/local/evm-testnets.env`（ignored、`0600`。生成済み）。アドレスは証跡に出してよい（testnet の使い捨て）。
- **SR-E6** mainnet の資金・実資産・有料サービスは使わない。表の 4 行はどれも testnet。

### 2.3 受け入れ（AC-E）

- **AC-E1（unit）** 表: 4 行の値が §1.1 と一致。`knownAssetOf` が大文字小文字によらず引け、名前では引けない。`tests/unit/shared-extraction.test.ts` の一覧の更新。payer の vendor 一致。
- **AC-E2（unit/wire）** 受信の domain と期限: 4 network の受信 offer の `extra.name/version` が表の値。Base Sepolia・Base mainnet の adapter の option は修正前と同じ（option の値で断言する。offer は乱数と時刻を含むので byte 比較はしない）。`npm run sign`（`classifyExactEvm`）が 4 network の offer を受け、domain を 1 字変えた offer を拒む。
- **AC-E3（unit、facilitator）** 前段の検査のそれぞれの拒否が SDK・RPC を呼ばない。認証の無い要求・`Origin` つき・別の `Host` を拒む。同じ authorization の同時の 2 要求は 1 回の送出に合流し、指紋の違う同じ nonce は拒む。network ごとの直列（同時の settle の送出が重ならない）、待ち行列の上限、gas の上限。結果の写像の表（§3.3）の各行: 送出前の失敗 → 4xx、送出後の receipt の期限切れ → 5xx、revert → 5xx（verify は通っていたので不明として扱う）、`Transfer` 不一致 → 5xx、成功 → 200。使用済みの authorization: 一致する確定 tx → 200 でその tx、無い・不一致 → 5xx。期限切れの使用済みの authorization は 400 にならず照合（200 か 5xx）。verify の失敗と同時に他で使われた場合も 5xx か照合。送出の直前の残り時間の不足は送出せず 400（fsync を遅らせた試験で、fsync の後の再検査により `writeContract` が呼ばれないこと）。永続の journal: `submit_intent` の後に process を落として再起動すると、その network は保留（settle は 5xx、2 回目の送出が無い）、chain の照合で解けたものだけ解かれる。
- **AC-E4（unit、Provider）** 4 network の env の受け入れ、EVM の payer の取り出しと receipt の検査が **実際の Worker の handler** を通って 200 を返す（fixture の facilitator）。既存の `arc`・`solana` の挙動（`FACILITATOR_URL` の上書きを含む）は変わらない。期限の表（§3.6）。
- **AC-E5（wire、資金は動かない）** 専用の入口で **実際に子 process を spawn** し（fixture の facilitator・fixture の Provider を loopback に、TEST の鍵）、4 × 2 route が一覧に出て quote が通る。allowlist に無い loopback の URL を含む設定は起動しない。許された origin の adapter から別の loopback origin への要求・redirect は送出前に拒む。公開の入口の plan・子 env・能力に `localCounterparties` が無い（golden と断言）。遅延つきの fixture facilitator で、§3.6 の期限の内に答える settle が `settled`、送出後に期限を越えた settle が `unknown` になり、Router を同じ journal で再起動しても `unknown` のまま、facilitator への 2 回目の settle が無いこと。
- **AC-E6（回帰）** `npm test`（Router）、`packages/payer` の試験、`providers/x402-workers` の試験が通る。既知の macOS の flake は記録のとおり扱い、Linux（Colima）の結果を受け入れとする（前例どおり）。
- **AC-E7（live、資金が動く。各 C で 2 本 = 計 8 本）** 実 process（facilitator・C の Provider・専用の入口の Router）・実 HTTP・実 testnet で:
  1. 受信 `md-x402-eth-snapshot-<c>`: T7 が C の通貨で払い（自前 facilitator が settle、C の tx）、Router が Provider A に Base Sepolia USDC で払い（x402.org が settle、Base Sepolia の tx）、Provider A のデータがクライアントに `delivered`。
  2. 送信 `md-<c>-eth-snapshot`: T7 が Base Sepolia USDC で払い（x402.org、Base Sepolia の tx）、Router が C の Provider に C の通貨で払い（自前 facilitator、C の tx）、C の Provider のデータが `delivered`。
  各購入で §3.9 の証跡が 2 レグともそろうこと: token の contract・from・to・value が quote と一致する `Transfer`、receipt の成功、チェーン別の確定（§3.9）、クライアントが受け取った body の sha256 と Router の記録の一致、journal の該当行、残高の差。8 本の後に Router を同じ journal で再起動し、全 paymentId の status が同じ結果を返すこと。mock・片方向・送信受付・確定前の状態は完了に数えない。

## 3. 設計

### 3.1 表（`src/shared/networks.ts`）

§1.1 の 4 行を末尾に足す（注釈に facilitator が自前であること・USDG の domain が `version()` を持たず `DOMAIN_SEPARATOR` で確かめたことを書く）。`tests/fixtures/known-networks.ts` は表の **全** EVM 行に合成の資産を足し、さらに `eip155:11155111` の合成の行を追加している（`:34-35`）。本物の Ethereum Sepolia の行が入ると `knownNetworkOf` は本物の行を返す（`find` は先頭）が、合成の資産も同じ fixture の処理で本物の行に足されるので、合成の資産を使う試験はそのまま通る見込み。全試験で確かめ、壊れたら fixture を直す（本物の行の値は変えない）。

### 3.2 受信の domain と期限（`src/main.ts` `evmRail`、kind `x402` の枝）

`EVM_TESTNET_NETWORKS`（新しい 4 つの CAIP-2 の集合。`src/shared/networks.ts` に表と並べて置く）に入る network のときだけ、`assetDomain: known.domain` と `timeoutMs: inboundFacilitatorTimeoutMs(network)`（§3.6）を渡す。ほかの network は今の呼び出しのまま。adapter（`createX402Inbound`）は既に `assetDomain`・`timeoutMs` を受ける（`src/adapters/inbound/x402.ts:136-138,241-242`）ので adapter は変えない。Base mainnet の同じ欠落は §5 に owner への申し送りとして書く。

### 3.3 自前の EVM facilitator（`tools/evm-facilitator.ts`。製品の Router の外の運用道具）

- 起動: `tsx tools/evm-facilitator.ts`。env: `EVM_FACILITATOR_KEY`（gas 鍵）、`EVM_FACILITATOR_TOKEN`（path の接頭辞。無ければ起動しない）、`EVM_FACILITATOR_PORT`（既定 8611）、`EVM_FACILITATOR_NETWORKS`（表の 4 つの部分集合）、`EVM_FACILITATOR_PAYTO_ALLOWLIST`、`EVM_FACILITATOR_RPC_<chainId>`（既定は §1.1 の公開 RPC）、`EVM_FACILITATOR_GAS_CAP_<chainId>`（wei。§3.8）、`EVM_FACILITATOR_LOG`（ndjson のパス）。bind は 127.0.0.1 固定。
- 前段の検査（SDK・RPC の前。どれかで 400）: `x402Version: 2`、`requirements.scheme === "exact"`、network が有効、`requirements.asset` が表の資産（`assetKeyOf`）、`extra.name/version` が表の domain、`extra` の鍵は Router・Provider が出すもの（`name`・`version`・`challengeNonce`・`expiresAt`・`routeBinding`・`fundsMoveOnCredential`・`assetTransferMethod`）だけ、`assetTransferMethod` は無いか `eip3009`、payload は `{ authorization: {from,to,value,validAfter,validBefore,nonce}, signature }` の形だけ（65 バイトの ECDSA。EIP-6492 の包み・Permit2・`extensions` は拒む）、`amount` は正の 10 進の正規形で ≤ 20,000、`authorization.value === requirements.amount`、`authorization.to === requirements.payTo`（小文字化で比較）が allowlist、`payload.accepted` と `requirements` の全欄の一致（`stableJson`）、`validBefore` が今から §3.6 の確定の見込み以上先。
- verify: SDK の `ExactEvmScheme.verify`（facilitator 側、`simulate` あり）に渡し、`isValid` をそのまま返す（失敗は 200 + `isValid: false`。資金は動かない）。
- settle（自前。SDK の settle は使わない。§1.2）。**原則: 400（= Router の `rejected`）を返すのは「この authorization が chain で未使用で、この facilitator が一度も送出していない」と確かめたときだけ。** それ以外の失敗は 5xx（Router の `unknown`）。
  1. 形の検査だけ（JSON・認証・`Host`/`Origin`・payload が EIP-3009 の形で `from`・`nonce`・`to`・`value` が読める）。読めなければ 400（どの authorization か特定できない要求で、何も送出しない）。
  2. 送出の記録（下の永続の journal）に同じ `(network, asset, from, nonce)` があれば: 確定した成功ならその結果を返す（指紋が違えば 5xx）。未解決なら 5xx（再送しない）。
  3. 同じ `(network, asset, from, nonce)` が process 内で処理中なら、指紋が同じなら合流、違えば 5xx。
  4. `authorizationState(from, nonce)` が使用済みなら照合（`AuthorizationUsed` の `nonce` の topic で `validAfter`〜`validBefore` の時刻に当たる block を狭く引き、receipt の `Transfer`(asset, from, to, value) が要求と一致し確認数を満たせば 200 でその tx、それ以外は 5xx）。**時間・束縛の検査より前**に行う（期限の切れた使用済みの authorization を 400 にしない）。RPC が読めなければ 5xx。
  5. 束縛・時間の検査（前段の検査の残り: network・資産・domain・`extra` の鍵・`assetTransferMethod`・金額・allowlist・`accepted` と `requirements` の一致・`validBefore`）。失敗は 400（4 で未使用を確かめ、送出していない）。
  6. network の待ち行列（直列、2 件まで。満杯は 503。送出していないが Router は `unknown` に写す。log に「送出なし」を残す）。順番が来たら 2 と 4 をもう一度（待っている間に他で使われた場合）。
  7. SDK の verify（simulate あり）。失敗したら `authorizationState` を読み直し、使用済みなら 4 の照合、未使用なら 400（verify と state の読み取りの間の競合で未払いと誤らない）。
  8. gas の累計の上限。超えるなら 400（未使用・送出していない）。
  9. **送出の直前** に残り時間（§3.6 の「送出に要る残り」）と `validBefore` を見直す。足りなければ 400。
  10. journal に `submit_intent`（指紋・network・asset・from・to・value・nonce）を書いて fsync する。**fsync の後、送出の直前に** 手順 9 の検査（残り時間・`validBefore`・要求の取り消し）をもう一度行い、足りなければ送出せず、journal に `aborted_before_send` を fsync して 400（fsync できなければ 5xx で network を保留）。通れば同期的に続けて `writeContract`（`transferWithAuthorization`、gas 上限 200,000、`maxFeePerGas` に network ごとの上限）。ここから先の失敗は全部 5xx。hash が返れば journal に `submitted`（hash）を fsync。
  11. receipt を締め切りまで待つ。`status: success` かつ `Transfer` が 1 つ一致 → journal に `settled` → 200 `{ success: true, transaction, network, payer }`。revert は journal に `reverted`（hash）で 5xx（verify は通っていたので不明として扱う。chain の状態で後から確かめられる）。不一致・期限切れは journal に何も足さず（未解決のまま）5xx。
- 永続の journal（`EVM_FACILITATOR_JOURNAL`、ndjson、追記と fsync。`.claude_workflow/local/evm-testnets/run-*/facilitator-journal.ndjson`）: 起動時に読み、`submit_intent` に `settled`/`reverted` の無いもの（未解決）を network ごとに数える。未解決が 1 つでもある network は **保留**（その network の settle は全部 5xx、verify は動く）。起動時に未解決のものを照合し（hash があれば receipt、無ければ `authorizationState` と `AuthorizationUsed`）、確定した成功・revert が分かったものは journal に追記して解く。分からないもの（pending のまま・hash も event も無い）は保留のまま運用者の判断に回す（自動で解かない。解くのは運用者が journal に `resolved_by_operator` を理由つきで追記したときだけ）。処理中の要求の receipt の待ちが期限で切れた場合も、その network は未解決 1 件として保留になる（次の settle を止める。同じ gas 鍵の nonce の詰まりも避ける）。
- `/supported`: 有効な network の `{x402Version:2, scheme:"exact", network}` と `signers`（gas 鍵のアドレス）。
- log: 1 行の JSON。鍵・署名・token は出さない。

### 3.3a 実装での補足・逸脱（E-2、2026-10-13。親が読み合わせ）

1. `/settle` の手順 5 の拒否の前に手順 4 の `authorizationState` の読み取りが 1 回入る（順序の帰結。SDK・送出には届かない）。`/verify` の拒否と手順 1 の拒否は RPC を呼ばない。
2. `paymentPayload.payload` は `{ authorization, signature }` に加えて `challengeNonce` を許す（`requirements.extra.challengeNonce` と一致するときだけ）。Router の受信の封筒（`tools/x402-payer.ts`）が入れるため。
3. `paymentPayload` の最上位の鍵は `x402Version, scheme, network, accepted, payload, resource, extensions` に限り、`extensions` は空の object だけ。
4. 手順 1 に「network が有効」「資産が表にある」を含める（`(network, asset, from, nonce)` が決まらないため）。
5. 手順 2 は処理中の鍵を手順 3 の合流に回す（同時の同一要求を 5xx にしない）。
6. 使用済みの照合の `getLogs` は `validBefore` から最大 3,600 秒さかのぼる（payer は `validAfter = 0` で署名する）。範囲外は見つからず 5xx（安全側）。
7. 新しい env `EVM_FACILITATOR_MAX_FEE_PER_GAS_<chainId>`（既定 46630・421614: 1 gwei、998: 10 gwei、11155111: 20 gwei）。超えれば 400 `fee_too_high`。gas の上限は「累計 + 200,000 × 見積もりの maxFeePerGas」で判定し、確定後は実費、不明は最悪値を足す。
8. 新しい env `EVM_FACILITATOR_LOG_RANGE_<chainId>`（既定 5,000 / 5,000 / 500 / 1,000 block）。HyperEVM の公開 RPC は範囲より **IP ごとの rate limit**（`-32005`）が効く。
9. 状態コード: 保留・待ち行列満杯・待ち行列での期限切れは 503（送出なし）、receipt の期限切れ 504、revert・`Transfer` 不一致・RPC 不可 502、送出の呼び出しの例外 500、送出前の手数料見積もりの失敗 400（直前に未使用を再確認済み）、認証 404、`Origin`/`Host` 403。
10. `aborted_before_send` が最後の行の鍵は再処理してよい（送出していない）。
11. 起動時の照合で revert が分かったものは `reverted` を追記して保留を解く。
- 残る危険: HyperEVM の公開 RPC の rate limit（照合・起動時の検査が 5xx = `unknown` に倒れる。必要なら `EVM_FACILITATOR_RPC_998` に別の RPC）。HyperEVM の USDC の `AuthorizationUsed` は公開 RPC の 5.4 時間分の走査で **未観測**（他の 3 つは観測）。E-7 の最初の HyperEVM の settle で確かめる。viem の `writeContract` は再検査の後に nonce・chainId を読むので送出までの間はゼロではない。journal の排他は無い（同じ journal に 2 process を向けない運用）。`resolved_by_operator` は再起動で効く。

### 3.4 Provider（`providers/x402-workers`）

- `ProviderNetwork` に `rh`・`arbsep`・`hyperevm`・`sepolia` を足し、`TABLE` に 4 行（network・資産・decimals・`amount: "10000"`・`extra: { name, version, assetTransferMethod: "eip3009" }`・`facilitatorKind: "x402"`・`chainId`・`family: "evm"`・`facilitatorUrl: ""`）。既存の行に `family`（`arc`: evm、`solana`: svm）を足す。
- 一般化（network 名の `=== "arc"` を `family === "evm"` に）: `configOf` の受け入れとアドレスの検査（`config.ts:103-106`）、`payerOfPayload`・`checkReceipt`（`receipt.ts:39,66,71`）、`registerExactEvmScheme`（`requirements.ts:61`）。seller proof は **facilitator が Circle のとき**（今は `arc`）だけ: 新しい 4 行は `SELLER_PROOF_KEY` を要求せず、設定されていれば拒む。
- `FACILITATOR_URL`: 既存の上書きの規則（`config.ts:113-114`。https か loopback の http）はそのまま。新しい 4 行は既定が空なので **必須**。
- 期限と窓: `deadline.ts` の定数を network の行の値にする（既存の 2 行は今の値。新しい 4 行は §3.6）。`MAX_TIMEOUT_SECONDS`（30）も行の値に（新しい 4 行は §3.6）。
- `wrangler.toml` に `[env.rh]` など（`PROVIDER_NETWORK`・`PAY_TO` は var、secret 無し）。手元の `wrangler dev --env rh --port 8621 --var FACILITATOR_URL:http://127.0.0.1:8611/<token>` で動かす（workerd の loopback への fetch は E-3 で実測）。**配備しない**。`PAY_TO` は 4 つとも E-PROV。

### 3.5 入口・子 process・設定（mainnet の 1 経路と同じ形 + 専用の子）

- `tools/remote-mcp-config.ts`: `EVM_TESTNETS`（4 つの定数: 短縮名・network・資産・decimals・domain）と `evmTestnetsConfigOf(env, receiver, chains)`。route は FR-E5。受信の facilitator は `x402.inboundFacilitators[network] = { kind: "x402", url: env.SUBETHA_EVM_FACILITATOR_URL }`、Base Sepolia の受信は env `ROUTER_X402_INBOUND_FACILITATOR_URL`（x402.org。既存）。上流: 受信 route は `UPSTREAM_X402`（Provider A）、送信 route は env `SUBETHA_EVM_PROVIDER_URL_<C>`。Provider の受取先は env `SUBETHA_EVM_PROVIDER_PAYTO`。予算は §3.7。`routerConfigOf`・`RAILS_ACTIVATION` には触れない。
- `tools/remote-mcp.ts`: `HostOptions.evmTestnets?: { chains }`。`hostPlanOf` は mainnet と同じ形で分岐し、子の script を `tools/evm-testnets-router-process.ts` にする（`startHost` の `startListening` の script 名を plan から取る。既定の plan は今の `tools/remote-router-process.ts` のまま）。bind は loopback、journal は専用のパス（公開の journal と同じパスは拒む。既存の検査）。子の env（allowlist）に facilitator の URL・Provider の URL・選んだ chain を渡す。real mode が要求する SubEtha の facilitator URL（`src/config.ts:1025`）は今の既定を渡す（SubEtha の route は無いが設定の検査が要る）。
- `tools/evm-testnets-router-process.ts`（新。公開の子とは別のファイル）: `routerProcessCapabilitiesOf(env)` の結果に、`evmSigningByNetwork` を選んだ chain の network ぶん（同じ送信鍵。D-11 と同じ）と `localCounterparties`（env の facilitator の URL と Provider の URL の origin）を足して `startRouter` に渡す。公開の子（`tools/remote-router-process.ts`）と `routerProcessCapabilitiesOf` は変えない。
- `src/main.ts` の能力 `localCounterparties?: { readonly origins: readonly string[] }`:
  - 起動時: 各 origin が `http://127.0.0.1:<port>` の literal であること。
  - 起動時の拒否: 新しい 4 network の静的 route の facilitator の URL と upstream の URL のうち、host が loopback の literal（`127.0.0.0/8`・`::1`・`localhost`）のものは、origin が allowlist に無ければ **起動しない**（fetch 時の destination policy に任せない）。
  - 静的の受信（route の network が `EVM_TESTNET_NETWORKS`）: facilitator の URL の origin が allowlist にあれば、その adapter の transport を `allowLoopback: true` かつ **要求ごとに origin の完全一致を確かめる包み** で作る。loopback でない URL は今の transport。
  - 静的の送信（`(x402, network)` の組で network が `EVM_TESTNET_NETWORKS`）: その組の upstream の URL が **全部** allowlist にあるときだけ同じ包みの transport。一部だけなら起動しない。`paidTimeoutMs` は §3.6。
  - 動的上流の transport・Base Sepolia の transport・ほかの network には一切効かない。facilitator の URL は今どおり動的の拒否ホストに入る（`src/main.ts:479-490`）。
  - 代替として検討した案: facilitator と Provider を Cloudflare Worker に配備する／一時的なトンネルで公開する。外への公開・配備で owner の gate になり、gas 鍵を Worker の secret に置くことになる。手元の受け入れには過剰なので採らない（hosted への展開は §5）。
- `tools/evm-testnets-run.ts`: `rails-acceptance-run.ts` と同じ骨格（`--chains rh,arbsep,hyperevm,sepolia`、port・journal は env、stdout に listening の 1 行）。

### 3.6 期限（チェーン別。既存の network の値は変えない）

期限は **残り時間** で組む。各段の期限は「段の上限」と「呼び出し元の残り」の小さい方（Provider は既に `min`。`providers/x402-workers/src/deadline.ts:54-55`）。facilitator は呼び出し元の残りを知らないので、facilitator の締め切り（要求の受付から、待ち行列を含む）は **呼び出し元が settle に入るときに必ず残っている時間** より短くする。

| 値 | 既存（参考） | 速いチェーン（rh・arbsep・hyperevm） | sepolia |
|---|---|---|---|
| Provider: 要求全体 / init・data・verify の段 / settle に入るのに要る残り / settle の段の上限 | 26 / 5・2・4 / 12 / 20 秒 | 26 / 5・2・4 / 12 / 20 秒（既存と同じ） | 60 / 5・2・4 / 44 / 50 秒 |
| → Provider が settle に入るとき必ず残る時間 | — | ≥ 12 秒 | ≥ 44 秒 |
| facilitator の締め切り（受付から。待ち行列を含む） | — | 10 秒 | 40 秒 |
| facilitator が送出の直前に要る残り（§3.3 手順 9） | — | 6 秒 | 28 秒（2 block + 余裕） |
| Router 受信: facilitator の HTTP 期限（`timeoutMs`。settle の要求を出した時点から） | 10 秒 | 20 秒 | 50 秒 |
| Router 送信: 有料要求の期限（`paidTimeoutMs`。Provider の要求全体の外側） | 30 秒 | 30 秒 | 75 秒 |
| Provider の `maxTimeoutSeconds`（authorization の窓） | 30 | 60 | 120 |
| Router の実行・MCP の入口 / driver の MCP 呼び出し | 180 秒 / — | 180 / 195 秒 | 180 / 195 秒 |
| 承認の期限 / 受信 offer の有効期間 | 600 秒（入口の env） | 同じ | 同じ |

- 順序の根拠（同じ起点で比べる）: Router 受信は facilitator に settle を送った時点から 20/50 秒待ち、facilitator は受付から 10/40 秒で必ず答える（受付は送信の直後）。Provider は settle に入る時点で ≥ 12/44 秒残っており、facilitator は 10/40 秒で答える（差 2/4 秒が transport の余裕）。Router 送信は Provider の要求の開始と同時に 30/75 秒の時計を始め、Provider は開始から 26/60 秒で必ず答える。
- 送出は facilitator の受付から 4 秒（速い）/ 12 秒（sepolia）以内に限られ（手順 9）、それを越えたら送出せず 400。送出後に締め切りが来れば 5xx（`unknown`）で、network は保留になる（§3.3）。
- 承認の期限は core が settle の前（`src/core/orchestrator.ts:678,732`）と送信の署名の前（`src/adapters/outbound/x402.ts:357,390`）に見る。受信が settle した後に承認が切れると送信は `not_sent`（`destination_deadline`）で、受信の資金は Router に残る（既存の挙動。返金なし）。driver は quote の直後に購入するので所要は 1 分以内の見込み。
- Provider への支払いの結果（D-2 で確認）: facilitator の 400 も 5xx も Provider の facilitator client で例外（`facilitator-client.ts:174`）→ Provider 502（`index.ts:81-87`）→ Router `unknown`（`destination_pay_unknown`。`x402.ts:397-401`、`x402-dynamic.ts:144-145`）。送信側では facilitator の 400 も「不明」に倒れる（安全側）。
- 値は E-4・E-5 で遅延つきの fixture で確かめ、live の前に Ethereum Sepolia の最初の購入の実測で見直す（変えるなら本書を直してから）。

### 3.7 予算（`evmTestnetsConfigOf`）

core の予算は 2 レグとも (network, asset の文字列) の区分に累計で数え、journal から復元する（`src/core/budget.ts:233,257,280,309`）。入金では戻らない。設定:
- `maxPurchases`: 32（8 本の成功 + 失敗の予約の余裕）。
- 区分: Base Sepolia USDC は `maxPerPurchase` 10,000・`maxTotal` 200,000（受信 route の送信レグ 4 回 + 送信 route の受信レグ 4 回 = 80,000 + 失敗の予約の余裕）。各 C の資産は `maxPerPurchase` 10,000・`maxTotal` 50,000（2 回 = 20,000 + 余裕）。資産の文字列は表の id と同じ表記（checksum の大文字小文字のまま）。
- 実験の途中で区分が尽きたら止まる（`budget_exhausted`）。値を上げるのは owner の承認の後。

### 3.8 鍵・資金・nonce

| 役割 | 鍵 | 要る資金 | 出どころ |
|---|---|---|---|
| クライアント（payer） | T7（既存） | 各 C の通貨 ≥ 0.05。Base Sepolia USDC は 19.557 で足りる | Circle faucet（USDC: Arbitrum Sepolia・HyperEVM・Ethereum Sepolia）、Paxos faucet（USDG: Robinhood）。**owner** |
| Router の受取先 = 送信鍵 | T8（既存） | 各 C の通貨 0.01（送信 1 回）は受信の試験の入金（確定を確かめてから）で賄う。Base Sepolia USDC 0.082 ≥ Provider A への 4 回 0.04 | 受信の試験の入金 |
| facilitator の gas | E-FAC `0x54633d372d7316435891EEBBaAB90861F8c1Dadc`（生成済み） | Robinhood ETH ≥ 0.002、Arbitrum Sepolia ETH ≥ 0.002、HyperEVM HYPE ≥ 0.05、Ethereum Sepolia ETH ≥ 0.01 | 各ガス faucet（**owner**） |
| C の Provider の受取先 | E-PROV `0xf8243d93F339807CA9846Aa31155A2B2262D08db`（生成済み） | 無し | — |

- 入金の実績（2026-10-12T20:58Z、読み取り専用 RPC）: T7 は Robinhood USDG 100・Arbitrum Sepolia / HyperEVM / Ethereum Sepolia USDC 各 20。E-FAC は Robinhood ETH 0.01・Arbitrum Sepolia ETH 0.05・HyperEVM HYPE 0.008・Ethereum Sepolia ETH 0.01。
- gas の上限（facilitator の `GAS_CAP`）: 各 network で入金額の半分（Robinhood 0.005 ETH、Arbitrum Sepolia 0.025 ETH、HyperEVM 0.004 HYPE、Ethereum Sepolia 0.005 ETH）。1 回の settle の gas 上限 200,000（HyperEVM 0.1 gwei で 0.00002 HYPE）。
- T8 が受取と送信の両方を担うのは既存の検査と両立する（運用者のアドレスの検査は送信の **宛先** を拒むもので、役割の兼任は拒まない: `src/main.ts:253`、`src/adapters/outbound/x402.ts:301,340`）。E-PROV と Provider A の受取先は運用者の集合の外。
- 受信で入った資金を送信に使うのは、受信の tx の確定を確かめ、その購入が `delivered` で終わったときだけ。`unknown` の購入の資金は数えない。
- chain に tx を送るのは各 C で E-FAC だけ（facilitator の 1 process、network ごとに直列）。Base Sepolia の tx は x402.org の鍵。E-FAC を他の作業と共有しない。
- 実送金の前に driver の `plan`（送信元・受取先・金額・資産・network・gas の上限の表）を owner に示し、承認された plan の hash でだけ `run` が動く。

### 3.9 driver と証跡

- 1 購入の証跡 `run-<UTC>/purchases/<routeId>.json`（私的）: quote の subject（`ownerKey`・credential は除く）、paymentId、purchase と status の結果、受け取った body の sha256 と先頭、journal の該当行、2 レグの tx（network・hash・block・receipt の status・token の contract・`Transfer` の from/to/value）、facilitator の log の行、残高の前後（T7・T8・E-PROV・E-FAC の native）。driver は `Transfer` の値と宛先が quote と違えば止まる。
- 確定（`finality` の段。購入の後に実行）: Ethereum Sepolia・Arbitrum Sepolia・Robinhood は tx の block ≤ `finalized` の block、HyperEVM は receipt（単一 slot の確定）。Base Sepolia は `finalized`。確定まで待つので 8 本の後にまとめて行う（~15 分）。
- 再起動（`reopen` の段）: Router を止め、同じ journal で起動し、全 paymentId の status が保存した結果と同じであること。
- 公開の要約 `docs/evidence/evm-testnets/e2e-<date>.json`（秘密・body を除く）と本書 §7 の表。

### 3.10 分離

- worktree `~/.worktrees/subetha-router/evm-testnets`、branch `task/evm-testnets-x402`（`origin/main` bf85544 から）。tokyo の worktree（`task/kit-ja-translation`、Colosseum の作業）と payer-rails の worktree には触れない。
- port: 入口 8610（MCP）／Router は使い捨て、facilitator 8611、Provider 8621（rh）・8622（arbsep）・8623（hyperevm）・8624（sepolia）。journal・log は `.claude_workflow/local/evm-testnets/run-<UTC>/`（ignored）。公開の journal とは別。
- hosted Router・本番ホスト・Cloudflare には触れない。

### 3.11 実装の記録（E-3・E-4a、2026-10-13）

- E-3（`e3db4ca`）: Provider を family（evm/svm）と facilitator の種類で一般化。新しい 4 env は `workers_dev = false`（手元の `wrangler dev` 専用）。`wrangler dev --env rh` が自前 facilitator（loopback、token の path）に届き 402 を返すことを実測（token 違いは 503）。arc・solana の受け入れ（AC-P2）7/7 で不変。
- E-4a: §3.5 のとおり。逸脱: (1) 起動時の拒否は能力があるときだけ（能力が無ければ何も変えない、を保つため。evm の子は必ず渡す）、(2) `startHost` に試験専用の第 2 引数（子の script と追加 env。本番の入口は渡さない。静的な検査で固定）、(3) 公開 journal の拒否は `evmTestnetsOptionsOf` で（受け入れの入口と同じ場所）、(4) 子は `http://127.0.0.1:<port>` の origin だけを allowlist に入れる（`localhost` の URL は起動しない）。
- 既存の試験の不安定さ（E-4a の範囲外、申し送り）: `tests/wire/multirail-compose.test.ts` の「confirm の timeout の後…」は、追跡が 3 秒（名前解決の期限）+ 2 秒（間隔）を 3 回くり返すと完了の期限 15 秒にちょうど達し、タイマーの誤差で 4 回目が始まると、止まったままの名前解決が枠（4）を使い切って後半の settle が `unknown` になる。E-4a は Solana の追跡・名前解決の code に触れていない（`src/net`・`src/adapters` の差分なし）。E-4a の前のコミットでは全体 3 回とも通り、後では 3 回中 2 回落ちた（試験の数が増えて時間の並びが変わったと判断）。CPU の負荷だけでは単独で再現しなかった。修正（試験の間隔を期限の境界から外す）は別の小さな変更として owner に挙げる。

## 4. タスク

| # | 内容 | 担当 | 依存 |
|---|---|---|---|
| E-0 | 本書の独立レビュー → 修正 → readback → **owner の確認** | 親 | — |
| E-1 | 表 4 行 + `EVM_TESTNET_NETWORKS` + payer vendor + §3.2 + AC-E1・AC-E2 | writer（subagent） | E-0 |
| E-2 | facilitator（§3.3）+ AC-E3（RPC は fixture、HyperEVM の `getLogs` の範囲は読み取り専用で実測） | writer | E-1 |
| E-3 | Provider の一般化と 4 env（§3.4）+ AC-E4 + `wrangler dev` の loopback の実測 | writer | E-0 |
| E-4 | 設定・入口・子 process・`localCounterparties`（§3.5）+ AC-E5 + driver（§3.9） | writer | E-1・E-2・E-3 |
| E-5 | 回帰（AC-E6）、実装の独立レビュー → 修正 → 再試験 | 親 | E-4 |
| E-6 | 資金の表 → **owner が faucet**（鍵は生成済み） | owner | — |
| E-7 | 実決済 E2E（AC-E7）。チェーンごとに受信 → 送信。資金の揃ったチェーンから。止まったチェーンは他を止めない。最後に finality・reopen | 親 | E-5・E-6・plan の承認 |
| E-8 | 記録（§7）、最終レビュー、PR | 親 | E-7 |

- writer は 1 度に 1 つ、この worktree だけを編集する（同じ worktree を複数の writer で同時に編集しない）。commit・push・状態の更新は親だけ。
- 依頼の「現在の作業」（Colosseum の提出、tokyo の worktree）に依存する部分は無い。

## 5. 範囲外・後続・申し送り

- 動的プロファイル（`dyn-*-to-<c>`・`dyn-<c>-to-*`）: 動的上流の transport は loopback を許さず、受信の facilitator も公開の到達先が要る。hosted に出すなら facilitator を公開の場所で動かす設計が要る（別の gate）。
- hosted Router への展開・公開の一覧への追加（golden の変更、`RAILS_ACTIVATION`、配備）。
- payer（`@subetha/payer`）の対応。
- 第三者 facilitator（PayAI の Arbitrum Sepolia、x402.rs）との相互運用の検証。
- 4 チェーンの総当たり、MPP との組、ブリッジ・DEX・自動補充。
- **申し送り（owner の判断）**: Base mainnet（`eip155:8453`）の kind `x402` 受信も表の domain（`USD Coin`）を offer に出さない同じ欠落を持つ。今の mainnet の 1 経路は Tempo からの受信なので影響しないが、Base mainnet の受信を使う前に直す必要がある。

## 6. 独立レビューの記録

- **D-1（第 1 版、Codex `gpt-6-astra`、CLI read-only、2026-10-13）: REJECT、10 件**（全文は私的な `.claude_workflow/local/evm-testnets/review-d1.md`）。親が各指摘をコードで確かめた結果と反映:
  1. Provider は `arc`/`solana` 前提（`config.ts:103-106`、`receipt.ts:39,66,71`）— 確認、§3.4 で一般化。`FACILITATOR_URL` の上書きの既存の挙動を保つ — 第 1 版の記述の誤り、訂正。
  2. 期限が両方向で不足（Provider 20/26 秒、Router 送信の有料要求 30 秒、待ち行列・simulate・送出が receipt の待ちの前にある）— 確認（`deadline.ts:6-11`、`x402.ts:204,396`）、§3.6 の表。
  3. 「使用済み」を 4xx（= Router の `rejected`）で返すと支払い済みを未払いと誤り得る — 正しい、SR-E4・§3.3 の手順 4。
  4. SDK の settle は receipt の失敗を `success: false`（`settlement_pending`）で返し Router が `rejected` に写す — 固定版 2.28.0 で確認、settle を自前に（§1.2・§3.3）。in-flight の合流、指紋の束縛、再起動は chain からの照合で。
  5. 能力は子 process（`tools/remote-router-process.ts:31` → `routerProcessCapabilitiesOf`）で作られ、入口の option からは渡らない — 確認、専用の子 process（§3.5）。
  6. `allowLoopback` は origin を制限しない、送信は (rail, network) で transport を共有 — 確認、要求ごとの origin の照合と起動時の全 URL の検査（SR-E2・§3.5）。
  7. facilitator の呼び出し元の認証・待ち行列・gas の上限が無い — 反映（SR-E3・§3.3・§3.8）。
  8. 予算は 2 レグの累計で入金では戻らない — 確認、§3.7。T8 の兼任は両立（指摘どおり）。
  9. 再起動後の再読と確定の基準が無い — 反映（AC-E5・AC-E7・§3.9）。driver の承認は plan の hash（§3.8・FR-E7）。
  10. domain の修正は 4 network に限る、byte 比較は乱数・時刻で成り立たない、fixture の説明の誤り — 反映（§3.2・AC-E2・§3.1・§5）。
- **D-3（第 3 版の readback、同じモデル、2026-10-13）: REJECT、残り 1 件**（`review-d3.md`）。D-1 #3・#4・#6、D-2 N2 は解決。残り: 手順 9 の検査の後に journal の fsync を待つので、遅い fsync で締め切りを越えても送出し得る — 確認、§3.3 手順 10 に fsync の後・送出の直前の再検査と `aborted_before_send` を追加（AC-E3 に遅延 fsync の試験）。小さな修正なので全体の再レビューはせず、親の readback と実装レビューで確かめる（CLAUDE.md）。
- **D-2（第 2 版の readback、同じモデル、2026-10-13）: REJECT**（`review-d2.md`）。1・5・7・8・9・10 は解決。未解決と新規:
  - 3・N2（blocking）: 時間・束縛の検査が使用済みの照合より先にあり、期限切れの使用済みの authorization を 400 にし得る。verify と state の読み取りの競合も — 確認、§3.3 の順序を組み直し（手順 2・4・7）。
  - 4: 状態を持たない再起動で pending の tx を二重に送出し得る — 確認、永続の journal と network の保留（§3.3）。
  - 6: allowlist 外の loopback の受信 facilitator が普通の transport に落ち、起動時に拒まれない — 確認、§3.5 に起動時の拒否。
  - 2・N1: 期限の表が起点の違う長さを比べている。送出の直前の再確認が無い — 確認、§3.6 を残り時間で組み直し、§3.3 手順 9。
  - Provider の結果の写像（facilitator の 400/5xx → Provider 502 → Router `unknown`）は正しいと確認された（§3.6 に記録）。

### 6.1 実装の独立レビュー（Codex `gpt-6-astra`、CLI read-only）

- **I-1（`git diff bf85544..1780824`、2026-10-13）: REJECT、6 件**（`review-i1.md`）。親がコードで確認し全件を修正:
  1. （blocking）facilitator: verify の成功の後の手数料・gas 上限・期限の 400 が直前の `authorizationState` を読み直さない → 全ての手順 4 以後の 400 の前に読み直し（使用済みは照合、読めなければ 5xx）。`000fb6d`。
  2. （blocking）driver: 照合した `subject.source.offer` と署名する `quote.source.offer` が別 → 照合した凍結済みの quote 文書そのものを署名と購入に渡し、2 つの offer の正準一致を必須に。`b8e3df6`。
  3. driver: 証跡の上書きでクラッシュ時に試みの印が消え得る → O_EXCL の不変の印を quote の前に、証跡は原子的な書き込み、読めない印・証跡は保留。`b8e3df6`。
  4. facilitator: journal の書き込みに期限が無い → facilitator の締め切りで打ち切り、network を保留、遅れて終わっても送出しない。`000fb6d`。
  5. facilitator: journal の新規作成でディレクトリを fsync しない → 修正。`000fb6d`。
  6. facilitator: 起動の失敗で RPC の URL（鍵を含み得る）を出す → 固定の code だけ。`000fb6d`。
- **I-2（readback、2026-10-13）: REJECT、残り 2 件**（`review-i2.md`）。1・2・4・6 は解決。残り: #3 印・証跡の新しい祖先（`attempts` を持つ証跡のディレクトリ）を fsync しない、#5 前回の起動がディレクトリの fsync で失敗した後の再起動では「既にある」として fsync を省く。どちらも親が確認し、**ファイルの親から root までの全ディレクトリを毎回 fsync** に変更（それぞれ失敗→再起動・新しい祖先の試験を追加し、元に戻すと落ちることを確認）。小さな修正なので全体の再レビューはせず親の readback（CLAUDE.md）。

## 7. 実決済の記録（E-7）

- plan `099d793345ceba4a1d93e55ee758acf5df1c69c0f50615d326972ea80137a997`（owner 承認 2026-10-13）。#1〜#6（Robinhood・Arbitrum Sepolia・HyperEVM の受信・送信）は `delivered`、両レグの `Transfer` を chain で照合済み。
- **#7 `md-x402-eth-snapshot-sepolia`: `unknown`（paymentId `3cae48f5-0e15-43db-9887-98df1380b531`）**。自前 facilitator の settle の tx `0xc0e16cc735c9e7d9808caaec998cfdc94d0991334e9a1b3d197653a8b8197b27` が gas 切れで revert（gasUsed 197,313 / 上限 200,000）。Ethereum Sepolia の USDC の `transferWithAuthorization` は約 288,251 gas を要した（直前の block での `estimateGas`）。**資金は動いていない**（authorization は未使用、T7 の Sepolia USDC 20・T8 0 のまま）。Router は `unknown` を記録し送信レグに進まず、driver は再試行せず停止した。設計の見落とし: 固定の 200,000（§3.3 手順 10）と、SDK の verify の simulate は gas 上限なしで不足を検出しない。
- 修正（`§3.3a` に追加）: 送出の直前に同じ呼び出しの gas を見積もり、見積もり × 1.25 を送る。network ごとの上限 `EVM_FACILITATOR_MAX_GAS_<chainId>`（既定 46630・421614・998: 200,000、11155111: 400,000）を超えれば送出せず 400（未使用を読み直してから）。driver の資金の表も上限で数える。#7・#8 は新しい plan と owner の新しい承認で行う。

## 8. 掛け合わせの検証（owner の依頼 2026-10-13: 新しい 3 チェーン × 既存のレール）

> owner: 「Ethereum は待つ時間が長すぎるから一旦無視」「追加した 3 つと、これまでのルートも含めて掛け合わせた inbound と outbound が全て問題なく利用できるか」→ 範囲の提案（30 件）に「進めて良いです」。当初の範囲外（総当たり）を owner が追加した。

### 8.1 行列

- 受信（クライアントが払う）: 既存 `base`（Base Sepolia USDC、x402、x402.org）・`tempo`（Tempo pathUSD、MPP `tempo/charge`）・`arc`（Arc USDC、x402、Circle）・`sol`（Solana devnet USDC、x402 SVM、x402.org）・`solmpp`（Solana devnet USDC、MPP `solana/charge`）、新 `rh`・`arbsep`・`hyperevm`（x402、自前 facilitator）。
- 送信（Router が払う上流）: 既存 Provider A（`base`、hosted）・Provider B（`tempo`、hosted）・Arc の Provider（hosted）・Solana の Provider（hosted）・Provider D（`solmpp`、hosted）、新 3 つ（手元の `wrangler dev`）。
- 対象: 受信か送信の少なくとも一方が新 3 つの組（同じ新チェーン同士は除く。同じレールは別項目: CLAUDE.md）。新 × 既存 15、既存 × 新 15、新 × 新 6 = 36。うち `base` ↔ 新 3 の 6 は §7 で済み → **30 件**。既存 × 既存 25 は以前の検証（multirail・MPP Solana・G-5）で済み、対象外。Ethereum Sepolia は外す。
- route id: `mx-<src>-to-<dst>`（静的 route。`evmTestnetsConfigOf` に `matrix: true` の選択肢を足して生成。公開の生成・golden は変えない）。金額は各レグ 10,000（0.01、6 桁。D-17 と同じく testnet では 1:1）。

### 8.2 鍵と資金（値は出さない）

| 役割 | 鍵 | 資金の出どころ |
|---|---|---|
| クライアント（EVM: base・tempo・arc・新 3） | T7 | 既存の残高（Base 19.5、Arc 19.9、Tempo 約 100 万、新 3 は §1.4 の faucet 分） |
| クライアント（Solana: sol・solmpp） | T6 Solana payer | devnet USDC 19.8・SOL 5.0 |
| Router の受取（EVM x402・MPP Tempo） | T8 | — |
| Router の受取（Arc、Circle の売り手証明） | T6 Arc receiver | — |
| Router の受取（Solana x402・MPP） | T6 Solana receiver（ATA あり） | — |
| Router の送信（x402 EVM: base・arc・新 3） | T8 | **事前に入れる**: 新 3 は T7 → T8 の EIP-3009 を自前 facilitator で settle（allowlist 内）、Base は既存 0.082 + 不足分、Arc は T7 → T8 の送金 |
| Router の送信（MPP Tempo） | T8 | T7 → T8 の pathUSD 送金 |
| Router の送信（Solana x402・MPP） | T6 Solana payer（クライアントと兼任。testnet、証跡では役割を区別） | 既存の残高 |
| 新 3 の Provider の受取先 | E-PROV | — |

- 受信の入金で送信を賄うのをやめ、事前に Router の送信鍵へ入れる（確定待ちを無くす）。driver は送信の前提（同じチェーンの受信の確定）を `--prefunded` で外す（残高は plan の検査で各段の不足を見る）。
- MPP Tempo の受信の秘密（`ROUTER_MPP_INBOUND_SECRET`）は手元の実行ごとの乱数。

### 8.3 変更

1. `evmTestnetsConfigOf(env, receiver, chains, { matrix })`: 上の 30 の静的 route、既存レールの受信の facilitator（Base は env、Arc は Circle、Solana は x402.org）、MPP 受信、上流（hosted の Provider は既存の定数、新 3 は手元）、予算の区分（各資産 maxPerPurchase 10,000、maxTotal 十分）。
2. 専用の子 process: 既存レールの能力（Arc の売り手証明、Solana の送信鍵・RPC、MPP Tempo の送信）を `routerProcessCapabilitiesOf` と同じ env で組み、`SUBETHA_RAILS_ACTIVATION` 相当を子の env に渡す。`localCounterparties` は今のまま（新 3 の静的の相手だけ）。
3. driver: クライアントの署名を `runSign` の全レール（x402 EVM・x402 SVM・MPP Tempo・MPP Solana）に広げる（Tempo MPP は署名で送金するので subject の照合の後でだけ）。`--prefunded`。資金の表は送信鍵を役割ごとに。
4. 試験: 設定生成（30 本、値は表と一致）、子の能力、driver の各レールの照合・停止。既存の試験と golden は不変。

### 8.4 進め方

設計の独立レビュー（Codex）と実装は並行（設計の指摘は実装に反映）。実装の後に回帰・Codex の実装レビュー → 事前の資金移動 → plan → 30 件を 1 件ずつ（`delivered` 以外で止まる。testnet は owner の常設の許可で都度の承認なし）→ 確定・reopen → 記録。
