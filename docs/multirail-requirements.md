# 要件: Arc と Solana を支払いレールに足す（第 2 版、2026-10-06）

> owner の依頼（2026-10-06）: 「arc での支払いだったり、Solana での支払いを追加してみたい」。本書は CLAUDE.md の段階（要件 → 設計 → タスク化 → 実装）の**要件**で、
> 調査の事実（§1・§2）、選べる範囲（§3）、要件（§4〜§6）、owner に決めてもらうこと（§8）を置く。設計は別紙。**mainnet は対象外**（§3.4）。
> 第 1 版への独立レビュー（§10 の 1 行目、REJECT）を反映した。
> 本書は日本語の作業文書で、審査員に向く文書（README・CLAUDE.md の手順・MCP の `nextStep`）は英語で書く（CLAUDE.md の方針）。本書の受け入れ条件は「将来の証拠として
> 何が要るか」であって、実決済・鍵の使用・配備の**許可ではない**。それぞれは実行の時点で owner の確認を取る（AGENTS.md）。承認・表示・履歴は既存のチャットが持ち、Router は
> 承認に要る事実を偽りなく示して、示したものだけを実行する（CLAUDE.md）。

## 1. 今の Router が持つもの（ソースで確認。第 2 版で誤りを直し、EVM 前提の箇所を足した）

| 項目 | 事実 |
|---|---|
| レールの抽象 | core は `InboundRail`／`OutboundRail` の port 越しにだけ外へ出る（`src/ports/{inbound,outbound}.ts`）。**レール名で分岐しないわけではない**: 動的 core は `profile.rail === "mpp"` で手数料の見積り・cap の検査・残高の区分を分ける（`src/core/dynamic.ts:339,533,636`）。EVM 前提も 1 つある: 残高の事前確認が資産のアドレスを小文字にして能力に渡す（`:631`）。SVM の識別子（base58）は大文字小文字を保つ必要があるので、ここは直す |
| 設定の語彙 | `sourceRail` は `"subetha" \| "x402" \| "mpp"` に限る（`src/config.ts:420-427`）が、静的 route の `rail` は**空でない任意の文字列**（`:416`）、`network` は**空でない任意の文字列**で CAIP-2 の検証は無い（`:449`）。受取先 `payTo` は `0x` アドレスを要求（静的 `:431`、動的 `:533`）。動的 x402 の宛先は `tokenDomain` と `eip155:` が必須（`:541`、`src/adapters/outbound/x402-dynamic.ts:89,347`） |
| x402 の adapter | **EVM 専用**: 受信は EIP-3009 `exact` を facilitator で verify/settle（`src/adapters/inbound/x402.ts`。network は要求の値を写すだけで `eip155:` を自分で確かめない `:164`）。送信は `@x402/evm` の signer で EIP-712 に署名（静的 `src/adapters/outbound/x402.ts:403-438`: **検査した typed data をそのまま signer に渡す**。動的 `x402-dynamic.ts:68-220`: 型と domain を固定して組み直す）。動的の receipt は EVM の tx hash の形を要求（`x402-dynamic.ts:438`） |
| MPP の adapter | **Tempo 専用**。受信の RPC・chainId は `eip155:` から数値を取る（`src/main.ts:299-303,437,458`）。これは変えない（MPP を Solana に広げない。§3.3） |
| 能力の注入 | `RouterCapabilities`: `evmSigning` **1 つ**（network 固定 `eip155:84532`、`tools/remote-router-process.ts:49`）、`mppTempo` 1 つ。受信 x402 の facilitator は **1 つ**（`ROUTER_X402_INBOUND_FACILITATOR_URL`、`src/main.ts:386`） |
| 予算 | 予約は**両レグ**を `(network, asset)` の区分で数え、区分が無ければ `bucket_not_allowed`（`src/core/budget.ts:207`）。本番の区分は Base Sepolia USDC と Tempo pathUSD だけ（`tools/remote-mcp-config.ts:182,219`）。新しい `(network, asset)` ごとに静的・動的の区分が要る |
| 呼び出し側の道具 | `npm run sign`（`tools/sign-payment.ts`）は x402 では **chainId 84532 を固定**して署名し（`:30,126`）、domain の name/version だけを offer から読む（`tools/x402-payer.ts:43`）。受信の上限 `MAX_AMOUNT = 10_000`（`:32`）は動的 quote の「上流額＋手数料」より**小さい**ことがある（上流 10,000 に定額 1,000 で 11,000。MPP 送信の手数料はガス代で変わるのでさらに大きくなり得る）。MPP は Tempo の送金を組む。MCP の payer interface も数値の chainId（`src/mcp/tools.ts:53,63`） |
| 本番の構成 | Base Sepolia USDC（x402）と Tempo Moderato pathUSD（MPP）、静的 route 2 本、動的プロファイル 2 本 |

つまり「チェーンを足す」は、同じプロトコル（x402）の**別の EVM チェーン**なら「facilitator と署名能力を network ごとに持つ」一般化と設定で済み、**EVM でないチェーン**
（Solana）は adapter と検査の境界を新しく作る話になる。どちらも、上の EVM 前提（小文字化・`0x` 必須・`tokenDomain` 必須・数値 chainId・tx hash の形・`npm run sign` の固定値）を
network の族ごとに分ける必要がある。

## 2. 外部の事実（2026-10-06。公開文書と facilitator の `/supported` を読んだだけで、**実機では未確認**。§2.4 で確認の前提にする）

### 2.1 Arc（Circle の L1）

| 項目 | 読んだこと | 出所 |
|---|---|---|
| 性質 | EVM 互換の L1。**USDC がネイティブのガス**（ネイティブは 18 桁、ERC-20 の USDC は 6 桁）。testnet の chainId **5042002**、RPC `rpc.testnet.arc.io`、faucet `faucet.circle.com` | docs.arc.io、chainstack、skills.sh/circlefin/use-arc |
| 支払いプロトコル | x402 `exact`（EIP-3009）。Circle の **Facilitator Service**（`api.circle.com/v1/facilitator/x402/`、`/verify`・`/settle`・`/status`）が Arc・Base・Polygon の USDC を settle する。testnet は鍵なしの trial、本番は API key（Bearer）。売り手の**署名つき証明ヘッダ**（`Facilitator-Seller-Proof`、EIP-712 domain "Circle Facilitator Seller Request"/"1"、`purpose` 付き）を要求する——他の facilitator に無い拡張 | developers.circle.com/facilitator-service/quickstart |
| USDC | testnet の USDC `0x3600000000000000000000000000000000000000`、EIP-712 domain name "USDC" / version "2" | 同上 |
| 他の facilitator | x402.org の facilitator（本番の受信で使っているもの）の `/supported` は Arc を列挙していない。CDP の一覧にも無い | `https://www.x402.org/facilitator/supported`（実読）、docs.cdp.coinbase.com/x402/network-support |
| MPP | Arc は MPP の network にない | docs.stripe.com/payments/machine/mpp |

### 2.2 Solana

| 項目 | 読んだこと | 出所 |
|---|---|---|
| 支払いプロトコル | x402 `exact` の SVM 版: 呼び出し側が「ComputeBudget ＋ SPL `TransferChecked` ＋ Memo」の **versioned transaction を部分署名**して渡し、facilitator が fee payer として署名・送信する。`payTo` は受取先の **ATA**（owner と mint から導く PDA）、`extra.feePayer` は facilitator の公開鍵、`extra.memo` は売り手の照合用 | x402 spec `specs/schemes/exact/scheme_exact_svm.md`（main、2026-10-06） |
| facilitator | x402.org の `/supported` が Solana devnet（`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`、feePayer `CKPK…WYp5`）を**列挙する**。CDP は devnet／mainnet（API key）。mainnet は `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `/supported` の実読、CDP の一覧 |
| SDK | `@x402/svm` 2.28.0（peer `@solana/kit` ≥ 5.1、`@solana-program/*` に依存）。Router は `@x402/{core,evm,fetch}` **2.27.0**（版の整合は確認が要る） | npm |
| MPP | `mppx` 0.11.0（導入済み）にも 0.13.1（最新）にも Solana の client method は無い | `node_modules/mppx/dist`、npm |
| 鍵・口座 | ed25519。受取先は ATA で、**誰が作って rent を払うか**（Router の運用者）は決める必要がある。送信（S-4）では transaction の手数料は facilitator が肩代わりすると spec は言うが、**実機で確かめていない** | spec |

### 2.3 まとめ

| | Arc | Solana |
|---|---|---|
| プロトコル | x402（EVM、EIP-3009）。今の adapter の形 | x402（SVM）。新しい adapter と検査の境界 |
| 受信（Router が payee） | facilitator を network ごとに持つ。Circle の売り手証明の署名（§4.3） | ATA の受取先、feePayer、SVM の credential の**Router 自身の検査**（§4.4）、facilitator |
| 送信（Router が payer） | `evmSigning` を network ごとに。署名の境界は動的のもの（組み直し）を基準にし、静的の「typed data を渡す」形は Arc では使わない | ed25519 の鍵と SVM の署名の境界（§4.6） |
| 上流 | Arc で x402 を受ける Provider が要る | Solana で x402 を受ける Provider が要る |
| 呼び出し側の道具 | chainId・domain・資産を offer から読み、知らない組は拒否する形に直す | SVM の transaction を組む署名の道具が新規 |

### 2.4 設計に入る前に実機で確かめること（前提。確かめられなければ設計は進めない）

| # | 確認 | 方法（読取だけ、または testnet の少額） |
|---|---|---|
| V-1 | Circle Facilitator Service の trial: `/supported`・`/verify`・`/settle` の実際の要求と応答の形、売り手証明ヘッダの要求・`purpose`・鮮度の欄、エラーの形、制限 | 文書の版を記録し、鍵なし trial に対して `/supported` と `/verify`（署名は使い捨て口座）を実行 |
| V-2 | x402.org の SVM `exact`: 受け付ける transaction の形（version、命令の数と順、Memo の扱い、token program）、`payTo` が ATA であること、`/supported` の feePayer の安定性 | spec の revision を記録し、devnet で `/verify` を実行。**fee の肩代わりは `/verify` では分からない**ので、facilitator が `/supported` で名乗る feePayer を前提として置き、確証は AC-2 の settle（devnet、owner の確認の上）で取る |
| V-3 | `@x402/svm` 2.28 と導入済みの `@x402/core` 2.27 の整合（型・ペイロードの版） | パッケージの読取。必要なら core/evm/fetch を 2.28 に揃える（別 PR） |
| V-4 | Arc testnet の USDC（`0x3600…`）が EIP-3009 `transferWithAuthorization` を持ち、domain が "USDC"/"2" であること。ネイティブ USDC（18 桁）とは別であること | RPC の読取: `name()`・`version()`・`DOMAIN_SEPARATOR()`・`decimals()` と、contract の code に `transferWithAuthorization`・`authorizationState` の selector があること。**getter の読取は EIP-3009 の挙動の証明ではない**ので、確証は AC-1 の settle（testnet）で取る |
| V-5 | Solana devnet の USDC の mint・decimals・token program、ATA の作成と rent の負担 | RPC の読取、devnet での ATA 作成（運用者の鍵） |

## 3. スコープ（選べる形）

### 3.1 方向の候補

| # | 内容 | 主張（デモ） | 新しく作るもの | 大きさ |
|---|---|---|---|---|
| S-1 | **Arc で払って**、既存の上流（Tempo の MPP／Base の x402）に届く（受信 = Arc） | 「Arc の USDC しか持たない agent が MPP／Base の Provider を使える」 | facilitator の network ごとの構成、Circle の売り手証明の能力、Arc の受取先、静的 route と動的プロファイル、予算の区分、`npm run sign` の一般化 | 小〜中。Arc → Base は**同じプロトコル（x402）の中の別チェーン**の組で、行列の 1 項目として明示する |
| S-2 | **Solana で払って**、既存の上流に届く（受信 = Solana） | 「Solana の USDC しか持たない agent が…」 | SVM の受信 adapter（ATA・feePayer・credential の検査・facilitator）、呼び出し側の署名の道具、`@x402/svm`・`@solana/kit` の導入、予算の区分 | 中 |
| S-3 | 既存のレールで払って、**Arc の Provider**に届く（送信 = Arc） | 「Arc でしか払えない Provider を使える」 | `evmSigning` の複数化、Arc の送信鍵と残高、**Arc で x402 を受ける Provider**（A を Arc にも置く） | 小（Router）＋ Provider 側 |
| S-4 | 既存のレールで払って、**Solana の Provider**に届く（送信 = Solana） | 「Solana でしか払えない Provider を使える」 | SVM の送信 adapter と署名の境界、ed25519 の鍵、Solana の Provider | 大 |

### 3.2 推奨する順と、その条件

**S-1 → S-2 → S-3 → S-4**。理由と条件:

- S-1・S-2 は「払う側の選択肢を増やす」話で、Router の主張（Pick the one you can pay with what you hold）にそのまま乗る。上流は既存の A・B で足りる
- 受信だけなら**運用者が資金を動かす署名は増えない**。増えるのは、Solana の受取先の鍵（ATA の owner。実行時に署名しない）と、Arc で Circle を使うなら売り手証明の署名（§4.3。
  実行時に署名するが資金は動かさない——V-1 で確かめる）。ただし**検査の重さは軽くならない**: 受信の成立を偽れば、Router は
  既存の送信レグで**運用者の資金を払う**。したがって SVM の credential の検査（§4.4）と facilitator の信頼の境界（§4.5）は、送信の署名の境界と同じ重さで設計・レビューする
- この順は §2.4 の確認（V-1〜V-5）が通ることが条件。通らなければ順を変えるか範囲を狭める
- S-3 は Router 側は小さいが Provider を Arc に置く必要がある。S-4 は新しい署名の境界で、T9 と同じ重さ（独立レビュー 2 回以上）

### 3.3 やらないこと

- MPP で Solana に払う（SDK に client method が無い）。MPP の adapter は Tempo 専用のまま（EVM の chainId 前提も残す）
- 資産の交換・ブリッジ
- 「任意の EVM チェーン」対応。足す network は**列挙**（Arc testnet、Solana devnet）で、各 network に許す資産・桁・domain を**表で束ねる**（§4.1）
- x402 の `upto`・`batch-settlement`
- 静的 x402 送信の「typed data をそのまま signer に渡す」形を新しい network に広げること（Arc の送信は動的の組み直しの形で）

### 3.4 mainnet は対象外

Arc・Solana・Base の mainnet は含まない（既存の方針。資産ペア D-4 と返金の設計が前提）。本番（公開 Router）に足すのも testnet のチェーンだけ。

## 4. 機能要件

### 4.1 共通（レールの複数化と network の束縛）

- **FR-1**: x402 の受信 facilitator は **network ごと**に設定できる（例: `eip155:84532` → x402.org、`eip155:5042002` → Circle、`solana:Et…` → x402.org）。URL は env（本番の入口）で与え、
  **拒否ホスト**と `dependencyUrls` に自動で入る。API key は URL に含めず、ログに出さない
- **FR-2**: x402 の送信署名能力（`evmSigning`）は **network ごと**に注入できる。承認済み offer の `network` と一致する能力だけを使い、無ければ fail closed
- **FR-3**: 許す network は**列挙**し、network ごとに「レール・資産（アドレス／mint）・桁・EIP-712 domain（EVM）・token program（SVM）・受取先の形（`0x`／ATA）」を**設定の表で束ねる**。
  表に無い network、表と違う資産・桁・domain は起動時に拒否。network だけの許可では足りない
- **FR-4**: レール名は増やさない（`x402`・`mpp`・`subetha`）。x402 の中で EVM と SVM を network の族（`eip155:`／`solana:`）で振り分けるのは合成側（`src/main.ts`）。
  core の既存のレール分岐（MPP の手数料）は増やさず、**EVM 前提の実装は直す**（資産の小文字化 `dynamic.ts:631`、`0x` 必須の検査、数値 chainId の interface、tx hash の形）
- **FR-5**: 既存の route・プロファイル・MCP の tool と引数は**互換**。journal は**旧い記録を読めて**、レールの混在した記録の identity と予約を保ち、設定（権威の欄）が変わった
  quote は `quote_changed` で止まる（既存の指紋の規則）。未解決の支払いを自動で再開しない（既存どおり）
- **FR-6**: 新しい `(network, asset)` ごとに**静的・動的の予算の区分**を持ち、owner が上限を決める（§8 D-7）。換算は桁で正確に（既存の規則）、再起動で保つ
- **FR-7**: Arc のネイティブ USDC（18 桁）は扱わない。設定は ERC-20 のアドレスと 6 桁だけを許し、違えば起動しない（否定の試験を持つ）

### 4.2 Arc の受信（S-1）

- **FR-8**: Arc testnet の USDC（ERC-20、6 桁、domain "USDC"/"2"）を x402 `exact`（EIP-3009）で受ける。受取先は Arc 上の Router のアドレス（EVM の鍵は chain に依らないので、
  Base Sepolia と同じ鍵でよいか、別にするかは D-5）
- **FR-9**: Circle Facilitator Service の `/verify`・`/settle` を、既存の adapter と同じ順序（preflight → verify → 昇格 → settle）で使う。verify を通さずに settle しない
- **FR-10**: facilitator の内部文字列（`invalidReason` 等）を転送しない（既存の方針）
- **FR-11**: 静的 route（Arc USDC 固定額 → 既存の上流）と動的プロファイル（Arc USDC → Tempo pathUSD・Base USDC、par 1:1）を足せる。Arc → Base は x402 → x402 の
  **同一プロトコル・別チェーン**の組として行列に明示する（同一レールの被覆は今まで未検証だった）

### 4.3 Circle の売り手証明（S-1 の安全要件）

- **FR-12**: 売り手証明（`Facilitator-Seller-Proof`）の署名は、**目的を限った能力**として注入する（`src/` は鍵を持たない）。能力は Circle の要求の schema を**自分で組み直して**署名し
  （facilitator の要求本体・`purpose`・鮮度の欄を束縛）、任意の typed data や EIP-3009 の authorization には署名しない。受取鍵を再利用するなら、この境界の重さは送信の署名と同じ
- **FR-13**: 証明の署名で**資金は動かない**ことを、Circle の protocol の実物（V-1）で確かめてから依存する。確かめられなければ別の鍵（証明専用）を使う

### 4.4 Solana の受信（S-2）

- **FR-14**: Solana devnet の USDC（SPL。mint・decimals・token program は表で固定）を x402 `exact`（SVM）で受ける。受取先は Router の鍵の ATA。**起動時に ATA を読み、
  owner・mint・token program が表と一致することを確かめる**（存在だけでは足りない）。無ければ起動しない（作るのは運用者。rent の負担も運用者）
- **FR-15**: requirements の `extra.feePayer` は facilitator の `/supported` から**起動時に読んで固定**する。変われば再起動（発行済みの quote は verify で落ちる。自動で追随しない）
- **FR-16**（preflight。facilitator に渡す前に Router が**自分で**確かめる。確かめられない形は有料ライフサイクルを始めない）:
  - 既存の preflight と同じ検査を**すべて継ぐ**: nonce 既知・未失効・route 束縛・発行 offer との完全一致（`src/ports/inbound.ts:51`、`src/adapters/inbound/x402.ts:186`）
  - transaction の復号は**大きさを限って**行い（上限を決める）、対応する version だけを受ける。address lookup table の参照（解決できない口座）は拒否
  - 命令は**ちょうど**: ComputeBudget（上限の設定 2 つまで、単価の上限あり）・SPL `TransferChecked` **1 つ**・Memo **1 つ**。それ以外の program・追加の transfer・不明な命令は拒否
  - `TransferChecked` の宛先 = Router の ATA、mint = 表の mint、decimals = 表の桁、額 = offer の額（ちょうど）、authority（署名者）≠ fee payer
  - fee payer = 起動時に固定した facilitator の公開鍵。fee payer が命令の口座に現れない
  - Memo = Router の challengeNonce（offer ごとに 1 つ）。**memo を書き換えた transaction は署名が合わない**（署名は message 全体に掛かる）が、Router はそれに頼らず memo を照合する
  - 同じ transaction・同じ nonce の再提出は preflight で止める（quote・route・並行・再起動をまたいでも。既存の nonce の規則に乗せる）
- **FR-17**: 呼び出し側の道具（`npm run sign`）は Solana の offer を見分けて SVM の transaction を組み、部分署名する。ed25519 の鍵は env。**署名だけで資金は動かない**（facilitator が
  送信する）——x402/EVM と同じ開示（承認 → 署名の順は変えない）
- **FR-18**: 受信で Router が Solana の RPC に出るのは起動時の ATA の検査だけ（quote・purchase の中では facilitator だけ）。`@x402/svm` の simulate 等は受信では使わない

### 4.5 決済の不確かさと facilitator の信頼（S-1・S-2 共通）

- **FR-19**: settle の要求が**出た後**の失敗（timeout・応答の喪失・エラー）は `unknown` とし、予約を保ち、**自動で再 settle しない**（既存の設計 §6.5 と同じ）。「facilitator が止まれば
  資金は動かない」とは**言わない**（要求が届いた後に止まり得る）
- **FR-20**: settle の成功は、facilitator の応答が**形どおり**であることで判定する: 成功の印、`network` が発行 offer の network と**一致**、`transaction` が **その network の識別子の形**
  （EVM は 32 バイトの hash、SVM は base58 の signature）。形が違う・network が違う・識別子が無い応答は `unknown`（既存の MPP 受信の「証跡なしで settled にしない」と同じ）。
  発行 offer は transaction の識別子を持たないので、識別子の**値**を offer と照合することはできない。Solana の `confirmed` は最終性の主張ではなく、`proof.onChainFinality: "not_checked"` のまま
- **FR-21**: facilitator の応答を**信じる範囲**を明示する: Router が自分で確かめるのは credential の形（FR-16）と応答の形（FR-20）。**形の正しい偽の成功**（facilitator が嘘を言う）は、
  チェーンを独立に読まない限り見分けられず、本書では**受容するリスク**（§7）。独立したチェーンの照合（受取先の残高・transaction の存在）は範囲外（将来の別紙）

### 4.6 Arc の送信（S-3）・Solana の送信（S-4）

- **FR-22**（S-3）: Arc の Provider の x402 offer（EIP-3009、USDC/2）に Arc 用の `evmSigning` で署名する。署名の境界は**動的の形**（型と domain を固定して組み直す）。静的の「typed data を
  渡す」形は使わない
- **FR-23**（S-3）: 動的プロファイルの `tokenDomain` と `network` の組を表（FR-3）で許す。Provider A を Arc にも置く（A の持ち主の作業。受け入れの前提）
- **FR-24**（S-4）: Solana の Provider に払う transaction は、SDK の提案を写さず**承認済みの値だけで組み直す**（宛先 ATA・mint・額・memo・compute budget の上限・fee payer = Provider 側の
  facilitator）。署名は 1 回、送信は facilitator。raw（部分署名の transaction）は復号して同じ欄をもう一度確かめる。期限・予算は既存と同じ
- **FR-25**（S-4）: Router の Solana 鍵は ed25519 で x402 の送信にだけ使う。残高の事前確認と予算は `(network, asset)` の区分に乗る
- **FR-26**（S-4）: 動的プロファイルで `rail: "x402"` ＋ `destination.network: "solana:…"` を許す。`tokenDomain` の代わりに `mint`・`decimals`・token program

## 5. 安全・運用の要件

- **SR-1**: 新しい依存（`@x402/svm`・`@solana/kit`・`@solana-program/*`）は、導入前に**何を読み何に接続するか**を記録し、固定版で入れ、`tests/unit/no-direct-fetch` と同じ規則
  （`src/` から直接の fetch／RPC を出さない）に乗せる。`@x402/core` の版の整合（V-3）
- **SR-2**: 新しい**すべての接続**——facilitator（verify・settle・`/supported`）、起動時の ATA・残高・chain の読取、Arc の RPC——は SSRF 防御 A の transport（loopback 不可・DNS の期限・
  アドレスの門・redirect なし）を通し、ホストは拒否ホストと `dependencyUrls` に入る。試験の fixture は既存の `dialForTest` の seam を使い、transport の方針を緩めない。防御 B の
  受け入れ（配備の gate）は従来どおり
- **SR-3**: SVM の検査（FR-16）と署名の境界（FR-24）は EVM・Tempo と同じ強さで、独立レビュー 2 回以上
- **SR-4**: 既存の 2 チェーンの経路は回帰なし（試験の数・内容を減らさない）
- **SR-5**: 鍵は `tools/` だけが env から読み、`src/` は持たない。Solana の鍵・Circle の証明の鍵も同じ
- **SR-6**: testnet の資産だけ。本番（公開 Router）に足すのも testnet のチェーンだけ
- **SR-7**: `npm run sign` は、表（FR-3）に無い network・資産・桁・domain・mint、mainnet、形の違う offer・失効した offer、上限を超える額を**署名の前に拒否**する。chainId・domain は
  offer と表から読み、固定値を持たない。受信の上限（今の 10,000）は動的 quote（上流額＋手数料）を含めて owner が決める値に合わせる。承認 → 署名の順と MPP の「署名で資金が動く」開示は変えない

## 6. 受け入れ条件（S-1・S-2。S-3・S-4 は §6.2）

### 6.1 S-1・S-2

- **AC-1**: 本番と同じ構成で、Arc testnet の USDC を x402 で払って MPP（Tempo）の上流が `delivered` になる実決済 1 件（使い捨て口座。owner の確認の上で）。Circle の `/settle` が返した tx が
  Arc の RPC で `success`、受取先に入金。**静的 route と動的プロファイルの両方**で 1 件ずつ
- **AC-2**: 同じく Solana devnet の USDC を x402 で払って x402（Base）または MPP（Tempo）の上流が `delivered`。facilitator が返した signature の transaction が devnet で confirmed、
  Router の ATA に入金（`onChainFinality` は `not_checked` のまま）。静的・動的の両方
- **AC-3**: 偽の credential は preflight で止まり、facilitator に届かない（外部接続 0）: 別の宛先・別の額・別の mint・別の桁・fee payer を Router に向けた tx・transfer が 2 つ・
  不明な program・memo を書き換えた tx（元の署名のまま）・同じ transaction の再提出（別の quote・別の route・並行・再起動後）・address lookup table の参照
- **AC-4**: 決済の不確かさ: settle の応答の喪失・crash・**形の違う／network の違う／識別子の無い**成功応答（loopback の fixture）に対して、`unknown` が耐久的に残り、再起動後に
  二重の支払いが起きない。形の正しい偽の成功は検出の対象外（FR-21・§7）。facilitator の fee payer が変わった後、発行済みの quote は verify で落ちて止まる
- **AC-5**: 既存の全試験が通る（Linux）。新しい adapter は fixture（loopback の facilitator・RPC、`dialForTest`）で試験し、実チェーンに依らない
- **AC-6**: 公開 MCP の一覧に新しい route／プロファイルが出て、`subject` に network・asset・decimals・受取先が正しく出る。`ownerKey` の保護・結果の保存と再読取は既存どおり。
  CLAUDE.md の手順（`npm run sign`）が Arc・Solana でも通り、表に無い offer を拒否する（英語で書く）
- **AC-7**: sabotage: 検査（FR-16 の各項目）・facilitator の選択（network の取り違え）・予算の区分・証明の能力の束縛を外した変異が試験で落ちる

### 6.2 S-3・S-4（設計で詰めるが、要件として置く）

- **AC-8**（S-3）: 既存のレールで払って Arc の Provider A が `delivered`。署名した authorization の domain・chainId・額・宛先が承認済みの値（組み直し）。署名は **Arc 用に注入した能力**
  （network に束縛）で行い、Base 用の能力は Arc の offer を拒む。鍵の素材を共有するか（D-5）は能力の束縛とは別の話
- **AC-9**（S-4）: 既存のレールで払って Solana の Provider が `delivered`。署名した transaction の命令が承認済みの値だけ（FR-24）、署名 1 回、fee payer ≠ Router。SDK の提案を
  変えても（別の宛先・額・追加の命令）署名しない

## 7. 受容するリスク（明記する）

| リスク | 扱い |
|---|---|
| Circle の facilitator は testnet が鍵なし trial。制限・変更があり得る | 要求の前の失敗は受信が止まるだけ。要求の後の失敗は `unknown`（FR-19）。本番の API key は別途（D-8） |
| x402.org の facilitator が fee payer を変える | 起動時に固定（FR-15）。変われば再起動。発行済みの quote は verify で落ちる |
| facilitator が送信するので、Router は「署名した」と「送られた」を直接は結べない | settle の応答の識別子と network の照合（FR-20）。最終性は主張しない |
| 新しい依存の供給鎖 | SR-1 |
| Arc のネイティブ USDC（18 桁）と ERC-20（6 桁）の取り違え | FR-7（設定で拒否、否定の試験） |
| 受信の成立を偽られると運用者の送信資金が出る | FR-16・FR-20・AC-3。受信だからといって検査を軽くしない |
| **facilitator が形の正しい嘘の成功を返す** | 見分けられない（FR-21）。facilitator は x402.org・Circle・CDP のいずれも運用者が選ぶ依存先で、既存の Base Sepolia の受信も同じ信頼に立っている。独立したチェーンの照合は将来の別紙 |

## 8. owner に決めてもらうこと

| # | 問い | 推奨 |
|---|---|---|
| D-1 | **範囲と順**: S-1〜S-4 のどれを、どの順で | S-1 → S-2 を先に（受信だけ。上流は既存の A・B）。S-3・S-4 は Provider の準備が揃ってから。順は V-1〜V-5 の結果次第 |
| D-2 | **facilitator**: Arc は Circle（trial）か。Solana は x402.org（鍵なし）か CDP（API key） | Arc = Circle の trial、Solana = x402.org（本番の受信と同じ事業者）。trial の制限が公開デモに耐えるかは V-1 で見る |
| D-3 | **Provider**: S-3・S-4 のとき、A を Arc に、A か B を Solana に置けるか（別リポジトリ） | owner の判断 |
| D-4 | **資産ペア**: Arc USDC ↔ Tempo pathUSD／Base USDC、Solana USDC ↔ Base USDC／Tempo pathUSD を par（1:1）と宣言してよいか | testnet では par（既存と同じ宣言） |
| D-5 | **鍵**: Arc は Base Sepolia と同じ EVM 鍵（受取先は同じアドレス）か別か。Circle の証明の鍵は受取鍵か専用か。Solana は新しい ed25519 鍵（受信は ATA の owner、送信は S-4） | Arc は同じ鍵、証明は V-1 の結果で（資金が動かないと確かめられなければ専用）、Solana は新しい鍵 |
| D-6 | **静的 route と動的プロファイル**: 両方足すか | 両方（静的は審査員の 1 コマンドの経路、動的は主張の本体） |
| D-7 | **予算と損失の上限**: 新しい `(network, asset)` の静的・動的の区分の `maxTotal`・`maxPerPurchase`・件数、`npm run sign` の受信の上限 | 既存と同じ桁（動的 1 件 20,000、通算 100,000,000、件数 1,000）。sign の上限は 20,000 |
| D-8 | **信頼の形**: facilitator の応答を信じる範囲（FR-21）と、Circle の本番 API key を取るか | testnet は trial、応答の照合は FR-20 の範囲 |

## 9. 本書で決めていないこと

adapter の内部構成、network の表の持ち方（設定ファイルか env か）、Circle の証明の能力の interface、Solana の ATA の作成手順、SVM の transaction の復号の上限、試験 fixture（loopback の
SVM facilitator）の形——設計で決める。

## 10. 独立レビューの記録

| # | 日付 | レビュア | 結果 | 反映 |
|---|---|---|---|---|
| 1 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 1 版 `807793c`） | **REJECT**（高 4・中 5・低 1） | (1) SVM の preflight が緩い → FR-16 を命令・口座・program・桁・version・再提出まで明示、AC-3 を拡張。(2) 決済の不確かさと facilitator の信頼が未定義 → §4.5（FR-19〜21）、AC-4、§7 の誤り（「資金は動かない」）を直した。(3) Circle の証明の署名が設計送り → §4.3（FR-12・13）。(4) `npm run sign` が chainId 固定なのに「そのまま」と書いた → §1 を訂正、SR-7。(5) §1 の EVM 前提の漏れと FR-4 の「core 不変」の矛盾 → §1 に 7 点、FR-4 を「EVM 前提は直す」に。(6) 予算の区分が S-4 だけ → FR-6・FR-7、D-7。(7) SSRF の範囲が facilitator だけ → SR-2。(8) 外部の事実を保証に昇格 → §2.4 の確認（V-1〜V-5）を前提に。(9) 互換と受け入れが狭い → FR-5、AC-1〜7、§6.2。(10) 範囲・決定・手順の枠 → Arc → Base の明示、D-7・D-8、前文の許可と言語の扱い、S-1 の記述の訂正 |
| 2 | 2026-10-06 | Codex `gpt-6-astra`（読取のみ。第 2 版 `85465bf`） | **REJECT**（高 1・中 2・低 1） | (1) FR-20 が offer に無い transaction の識別子を照合すると書き、AC-4 が形の正しい嘘を検出すると読めた → 「応答の形・network・識別子の形」の判定に直し、形の正しい嘘は受容するリスク（FR-21・§7）。(2) §1 の「core はレールで分岐しない」と 11,000 の記述の誤り → 訂正。(3) V-2・V-4 の確認では fee の肩代わり・EIP-3009 の挙動は証明できない → selector の確認を足し、確証は AC-1・AC-2 の settle に。(4) 鍵の記述の矛盾 → 「資金を動かす署名は増えない」に限定、AC-8 は network 束縛の能力で |
