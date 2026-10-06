# 要件: Arc と Solana を支払いレールに足す（第 1 版、2026-10-06）

> owner の依頼（2026-10-06）: 「arc での支払いだったり、Solana での支払いを追加してみたい」。本書は CLAUDE.md の段階（要件 → 設計 → タスク化 → 実装）の**要件**で、
> 調査の事実（§2）、選べる範囲（§3）、要件（§4〜§6）、owner に決めてもらうこと（§8）を置く。設計は別紙。**mainnet は対象外**（§3.4）。

## 1. 今の Router が持つもの（ソースで確認）

| 項目 | 事実 |
|---|---|
| レールの抽象 | core は `InboundRail`／`OutboundRail` の port 越しにだけ触り、レール名で分岐しない（`src/ports/{inbound,outbound}.ts`）。設定の語彙は `sourceRail: "subetha" \| "x402" \| "mpp"`、`rail: "x402" \| "mpp"`、`network` は CAIP-2（`src/config.ts:416-449`） |
| x402 の adapter | **EVM 専用**: 受信は EIP-3009 `exact` を facilitator で verify/settle（`src/adapters/inbound/x402.ts`）、送信は `@x402/evm` の signer で EIP-712 に署名（`src/adapters/outbound/x402.ts:231-438`、動的は `x402-dynamic.ts:68-220`）。network は `eip155:<chainId>` だけを受ける |
| MPP の adapter | **Tempo 専用**（`mppx` の `tempo.charge`、viem の Tempo chain、`src/adapters/{inbound,outbound}/mpp*.ts`） |
| 能力の注入 | `RouterCapabilities`: `evmSigning`（**1 つ**、network 固定 `eip155:84532`、`tools/remote-router-process.ts:49`）、`mppTempo`（1 つ）。受信 x402 の facilitator は **1 つ**（`ROUTER_X402_INBOUND_FACILITATOR_URL`、`src/main.ts:386`） |
| 本番の構成 | Base Sepolia USDC（x402）と Tempo Moderato pathUSD（MPP）の 2 チェーン、静的 route 2 本、動的プロファイル 2 本（`tools/remote-mcp-config.ts`） |
| 呼び出し側の道具 | `npm run sign`（`tools/sign-payment.ts`）は x402/EVM の EIP-3009 と MPP/Tempo の送金だけを組める |

つまり「チェーンを足す」は、同じプロトコル（x402）の**別の EVM チェーン**なら設定と能力の複数化で済み、**EVM でないチェーン**（Solana）は adapter と署名の境界を新しく作る話になる。

## 2. 調査の事実（2026-10-06。公開文書とパッケージ。実機は未確認）

### 2.1 Arc（Circle の L1）

| 項目 | 事実 | 出所 |
|---|---|---|
| 性質 | EVM 互換の L1。**USDC がネイティブのガス**（ネイティブは 18 桁、ERC-20 の USDC は 6 桁）。testnet の chainId **5042002**、RPC `rpc.testnet.arc.io`、faucet `faucet.circle.com` | docs.arc.io、chainstack、skills.sh/circlefin/use-arc |
| 支払いプロトコル | **x402 `exact`（EIP-3009）**。Circle の **Facilitator Service**（`api.circle.com/v1/facilitator/x402/`、`/verify`・`/settle`・`/status`）が Arc・Base・Polygon の USDC を settle する。testnet は**鍵なしの trial**、本番は API key（Bearer）。売り手の**署名つき証明ヘッダ**（`Facilitator-Seller-Proof`、EIP-712 domain "Circle Facilitator Seller Request"/"1"）を要求する——これは他の facilitator に無い拡張 | developers.circle.com/facilitator-service/quickstart |
| USDC | testnet の USDC `0x3600000000000000000000000000000000000000`、EIP-712 domain **name "USDC" / version "2"**（Base Sepolia と同じ形） | 同上 |
| 他の facilitator | **x402.org の facilitator（本番の受信で使っているもの）は Arc を列挙していない**（`/supported` を読んだ: eip155:84532、solana devnet、algorand、aptos、stellar、hedera、xrpl）。CDP（Coinbase）の一覧にも Arc は無い | `https://www.x402.org/facilitator/supported`、docs.cdp.coinbase.com/x402/network-support |
| MPP | Arc は MPP の対象外（MPP の network は Tempo と、Stripe 側の "Solana USDC"） | docs.stripe.com/payments/machine/mpp |

### 2.2 Solana

| 項目 | 事実 | 出所 |
|---|---|---|
| 支払いプロトコル | **x402 `exact` の SVM 版**: 呼び出し側が「ComputeBudget ＋ SPL `TransferChecked` ＋ Memo」の transaction を**部分署名**して渡し、facilitator が fee payer として署名・送信する。`payTo` は受取先の **ATA**（owner と mint から導く PDA）、`extra.feePayer` は facilitator の公開鍵、`extra.memo` は売り手の照合用 | x402 spec `scheme_exact_svm.md` |
| facilitator | **x402.org の facilitator が Solana devnet を支える**（`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`、feePayer `CKPK…WYp5`）。CDP は devnet／mainnet とも（API key 要）。mainnet は `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `/supported` の実読、CDP の一覧 |
| SDK | `@x402/svm` 2.28.0（`@x402/core` と同系列。**peer に `@solana/kit` ≥ 5.1**、`@solana-program/*` に依存）。Router は今 `@x402/{core,evm,fetch}` 2.27.0 | npm |
| MPP | **`mppx` 0.11.0（導入済み）にも 0.13.1（最新）にも Solana の client method は無い**（dist に `solana` は Stripe server 側の記述だけ）。MPP で Solana に払う経路は SDK が無い | `node_modules/mppx/dist`、npm |
| 鍵 | ed25519（EVM の secp256k1 と別系統）。Router の送信に使うなら新しい鍵と残高（devnet USDC・SOL は facilitator が肩代わりするので SOL は不要） | spec |

### 2.3 まとめ

| | Arc | Solana |
|---|---|---|
| プロトコル | x402（EVM、EIP-3009）。**今の adapter の形のまま** | x402（SVM）。**新しい adapter と署名の境界** |
| 受信（Router が payee） | facilitator を **network ごと**に持てれば設定で足せる。ただし Circle の売り手証明ヘッダの実装が要る | ATA の受取先・feePayer の扱い・SVM の credential の検証。facilitator は x402.org（鍵なし、devnet）で足りる |
| 送信（Router が payer） | `evmSigning` を **network ごと**に持てれば既存の署名の境界で済む | ed25519 の鍵、SVM の transaction を**確かめた値だけで組み直す**境界（今の EVM/Tempo と同じ思想を SVM で作る） |
| 上流（Provider） | Arc で x402 を受ける Provider が要る（A・B は Base Sepolia／Tempo） | Solana で x402 を受ける Provider が要る |
| 呼び出し側の道具 | `npm run sign` は EVM なのでそのまま（chainId・domain を offer から読む） | Solana の tx を組む署名の道具が新規（`@x402/svm`） |

## 3. スコープ（選べる形）

### 3.1 方向の候補

| # | 内容 | 主張（デモ） | 新しく作るもの | 大きさ |
|---|---|---|---|---|
| S-1 | **Arc で払って**、既存の上流（Tempo の MPP／Base の x402）に届く（受信 = Arc） | 「Arc の USDC しか持たない agent が MPP／Base の Provider を使える」 | facilitator の network ごとの構成、Circle の売り手証明、Arc の鍵・受取先、静的 route と動的プロファイルの追加 | 小〜中 |
| S-2 | **Solana で払って**、既存の上流に届く（受信 = Solana） | 「Solana の USDC しか持たない agent が…」 | SVM の受信 adapter（ATA・feePayer・credential の検証と facilitator）、呼び出し側の署名の道具、`@x402/svm`・`@solana/kit` の導入 | 中 |
| S-3 | 既存のレールで払って、**Arc の Provider**に届く（送信 = Arc） | 「Arc でしか払えない Provider を使える」 | `evmSigning` の複数化、Arc の送信鍵と残高、**Arc で x402 を受ける Provider**（A を Arc にも置く） | 小（Router）＋ Provider 側 |
| S-4 | 既存のレールで払って、**Solana の Provider**に届く（送信 = Solana） | 「Solana でしか払えない Provider を使える」 | SVM の送信 adapter と**署名の境界**（組み直し・raw の再検査・1 回だけ）、ed25519 の鍵、Solana の Provider | 大 |

### 3.2 推奨する順

**S-1 → S-2 → S-3 → S-4**。理由:

- S-1・S-2 は「払う側の選択肢を増やす」話で、Router の主張（Pick the one you can pay with what you hold）にそのまま乗る。上流は既存の A・B で足りる
- S-1 は既存の x402 adapter の形のままで、変更は「facilitator と署名能力を network ごとに持つ」一般化と Circle の拡張ヘッダ。S-2 は新 adapter だが受信側なので**運用者の鍵は増えない**
- S-3 は Router 側は小さいが Provider を Arc に置く必要がある（A・B の持ち主の作業）。S-4 は新しい署名の境界（SVM の transaction の組み直しと再検査）で、T9 と同じ重さのレビューが要る

### 3.3 やらないこと（本書の範囲外）

- MPP で Solana に払う（SDK に client method が無い。将来 `mppx` が足したら別紙）
- 資産の交換・ブリッジ（レールごとの支払いは独立。既存と同じ）
- 同一レール内の別チェーンどうし（Arc → Base など）を一般化した「任意の EVM チェーン」対応。足すのは **Arc testnet だけ**（network を列挙で許す）
- x402 の `upto`・`batch-settlement`

### 3.4 mainnet は対象外

Arc mainnet・Solana mainnet・Base mainnet への配備は本書に含まない（既存の方針と同じ。D-2 の資産ペアと返金の設計が前提）。

## 4. 機能要件

### 4.1 共通（レールの複数化）

- **FR-1**: x402 の受信 facilitator は **network ごと**に設定できる（例: `eip155:84532` → x402.org、`eip155:5042002` → Circle、`solana:…` → x402.org）。facilitator の URL は今までどおり env（本番の入口）で、**拒否ホスト**に自動で入る
- **FR-2**: x402 の送信署名能力（`evmSigning`）は **network ごと**に注入できる。承認済み offer の `network` と一致する能力だけを使う（無ければ fail closed）
- **FR-3**: 設定の `network` は列挙で許す（`eip155:84532`・`eip155:5042002`・`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`・`eip155:42431`）。知らない network は起動時に拒否
- **FR-4**: レール名は増やさない（`x402`・`mpp`・`subetha`）。x402 の中で EVM と SVM を **network の族**（`eip155:` か `solana:`）で振り分けるのは合成側（`src/main.ts`）で、core は変えない
- **FR-5**: 既存の route・プロファイル・MCP の tool と引数・journal の形は**変えない**（互換）。足すのは設定・能力・adapter

### 4.2 Arc の受信（S-1）

- **FR-6**: Router は Arc testnet の USDC（6 桁の ERC-20、EIP-712 domain "USDC"/"2"）を x402 `exact`（EIP-3009）で受ける。受取先は Arc 上の Router のアドレス（Base Sepolia と同じ鍵でよい——EVM の鍵は chain に依らない）
- **FR-7**: Circle Facilitator Service の `/verify`・`/settle` を、**既存の adapter と同じ順序**（preflight → verify → 昇格 → settle）で使う。売り手の証明ヘッダ（`Facilitator-Seller-Proof`）は Router の受取鍵で署名する（設計で: 署名するのは facilitator への要求の証明だけで、資金は動かない）
- **FR-8**: Circle の facilitator が返す `invalidReason`／内部文字列を転送しない（既存の方針）
- **FR-9**: 静的 route（Arc USDC 固定額 → 既存の上流）と、動的プロファイル（Arc USDC → Tempo pathUSD・Base USDC、par 1:1）を足せる。手数料は既存の規則

### 4.3 Solana の受信（S-2）

- **FR-10**: Router は Solana devnet の USDC（SPL、mint は設定で）を x402 `exact`（SVM）で受ける。受取先は Router の鍵の ATA（**起動時に導いて存在を確かめる**。無ければ起動しない——作るのは運用者）
- **FR-11**: 発行する requirements の `extra.feePayer` は facilitator の `/supported` から**起動時に読んで固定**する（quote ごとに読まない。変われば再起動）
- **FR-12**: credential（部分署名の transaction）の preflight は、**facilitator に渡す前に** Router 自身が形を確かめる: 命令は ComputeBudget・`TransferChecked`・Memo だけ、宛先 = Router の ATA、mint・額が offer と一致、memo = Router の challengeNonce、fee payer = facilitator の公開鍵、署名者 ≠ fee payer。確かめられない形は有料ライフサイクルを始めない（fail closed。EVM の preflight と同じ位置）
- **FR-13**: 呼び出し側の道具（`npm run sign`）は Solana の offer を見分けて SVM の transaction を組み、部分署名する。ed25519 の鍵は env（既存と同じ扱い）。**署名だけで資金は動かない**（facilitator が送信する）——x402/EVM と同じ開示
- **FR-14**: facilitator への接続は SSRF 防御 A の transport を通す（既存と同じ）。`@x402/svm` の内部の RPC 呼び出し（simulate 等）は**Router の受信では使わない**（facilitator に任せる）か、使うなら同じ transport に乗せる

### 4.4 Arc の送信（S-3）

- **FR-15**: Arc の Provider の x402 offer（EIP-3009、USDC/2）に、Arc 用の `evmSigning` で署名する。署名の境界（組み直し・domain の固定・raw の再検査）は既存のまま
- **FR-16**: 動的プロファイルの `tokenDomain` と `network` の組を Arc で許す
- **FR-17**: Provider A を Arc にも置く（A の持ち主の作業。Router の範囲外だが受け入れの前提）

### 4.5 Solana の送信（S-4）

- **FR-18**: Router が Solana の Provider に払う transaction は、SDK の提案を写さず、**承認済みの値だけで組み直す**（宛先 ATA・mint・額・memo・compute budget の上限・fee payer = Provider 側の facilitator）。署名は 1 回、送信は facilitator が行うので Router は送らない
- **FR-19**: Router の Solana 鍵は ed25519 で、x402 の送信にだけ使う。残高（USDC）の事前確認と予算は既存の仕組み（network・asset の区分）に乗る
- **FR-20**: 動的プロファイルで `rail: "x402"` ＋ `destination.network: "solana:…"` を許す。`tokenDomain` は無く、代わりに `mint`・`decimals`

## 5. 安全・運用の要件

- **SR-1**: 新しい依存（`@x402/svm`・`@solana/kit`・`@solana-program/*`）は、導入前に**何を読み何に接続するか**を記録し、`tests/unit/no-direct-fetch` と同じ規則（直接の fetch／RPC を `src/` から出さない）に乗せる
- **SR-2**: SVM の署名の境界は EVM・Tempo と同じ強さ（組み直し・raw の再検査・1 回だけ・期限）。レビューは T9 と同じく独立レビュー 2 回以上
- **SR-3**: facilitator が増える分、拒否ホストと `dependencyUrls` に自動で入れる。Circle の API key は URL に含めず、ログに出さない
- **SR-4**: 既存の 2 チェーンの経路は**回帰なし**（試験の数・内容を減らさない）
- **SR-5**: 鍵は従来どおり `tools/` だけが env から読み、`src/` は持たない。Solana の鍵も同じ
- **SR-6**: testnet の資産だけ。本番（公開 Router）に足すのも testnet のチェーン

## 6. 受け入れ条件（S-1・S-2 について。S-3・S-4 は設計で定める）

- **AC-1**: 本番と同じ構成で、Arc testnet の USDC を x402 で払って MPP（Tempo）の上流が `delivered` になる実決済 1 件（使い捨て口座）。Circle の facilitator の `/settle` の tx が Arc の explorer で `success`
- **AC-2**: 同じく Solana devnet の USDC を x402 で払って x402（Base）または MPP（Tempo）の上流が `delivered`。facilitator が送った tx が Solana devnet で confirmed、Router の ATA に入金
- **AC-3**: 偽の credential（別の宛先・別の額・別の mint・fee payer を Router に向けた tx）は preflight で止まり、facilitator に届かない（外部接続 0）
- **AC-4**: 既存の全試験が通る（Linux）。新しい adapter は fixture（loopback の facilitator と RPC）で試験し、実チェーンに依らない
- **AC-5**: 公開 MCP の一覧に新しい route／プロファイルが出て、`subetha_router_quote` の `subject` に network・asset・decimals が正しく出る。CLAUDE.md の手順（`npm run sign`）が Arc・Solana でも通る
- **AC-6**: sabotage: 署名の境界・preflight・facilitator の選択（network の取り違え）を外した変異が試験で落ちる

## 7. 受容するリスク（明記する）

| リスク | 扱い |
|---|---|
| Circle の facilitator は testnet が鍵なし trial。制限・変更があり得る | 受信が止まるだけ（資金は動かない）。本番の API key は別途 |
| x402.org の facilitator が Solana devnet の fee payer を変える | 起動時に読む（FR-11）。変われば再起動。quote の中で変われば verify で落ちる |
| Solana の facilitator が送信するので、Router は「署名した」と「送られた」を直接は結べない | settle の応答と tx signature で照合（EVM の facilitator と同じ） |
| 新しい依存の供給鎖 | SR-1。固定版、`npm ci`、読取の範囲を記録 |
| Arc のネイティブ USDC（18 桁）と ERC-20 USDC（6 桁）の取り違え | 設定は ERC-20 のアドレスと 6 桁だけ。ネイティブは扱わない（起動時に検査） |

## 8. owner に決めてもらうこと

| # | 問い | 推奨 |
|---|---|---|
| D-1 | **範囲と順**: S-1〜S-4 のどれを、どの順で | S-1 → S-2 を先に（受信だけ。上流は既存の A・B）。S-3・S-4 は Provider の準備が揃ってから |
| D-2 | **facilitator**: Arc は Circle（trial）、Solana は x402.org（鍵なし）か CDP（API key） | Arc = Circle の trial、Solana = x402.org（本番の受信と同じ事業者） |
| D-3 | **Provider**: S-3・S-4 のとき、A を Arc に、B（または A）を Solana に置けるか | owner の判断（別リポジトリ） |
| D-4 | **資産ペア**: Arc USDC ↔ Tempo pathUSD／Base USDC、Solana USDC ↔ Base USDC／Tempo pathUSD を **par（1:1）** と宣言してよいか | testnet では par（既存と同じ宣言） |
| D-5 | **鍵**: Arc は Base Sepolia と同じ EVM 鍵を使う／別にする。Solana は新しい ed25519 鍵（受信は受取先の ATA だけ、送信は S-4 で） | Arc は同じ鍵（受取先は chain ごとの同じアドレス）、Solana は新しい鍵 |
| D-6 | **静的 route か動的プロファイルか**: 新レールは動的プロファイル（par ペア）だけにするか、静的 route（固定額）も足すか | 両方（静的は審査員の 1 コマンドの経路、動的は主張の本体） |

## 9. 本書で決めていないこと

adapter の内部構成、facilitator の抽象（network → facilitator の表の持ち方）、Circle の売り手証明の署名鍵の扱い、Solana の ATA の作成手順、試験 fixture（loopback の SVM facilitator）の形——設計で決める。

## 10. 独立レビューの記録

| # | 日付 | レビュア | 結果 | 反映 |
|---|---|---|---|---|
