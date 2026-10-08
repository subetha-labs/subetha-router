# 要件: Solana の MPP（`method="solana"`、`intent="charge"`）を受信・送信の両方で（S-5・S-6。第 2 版、2026-10-08）

> `multirail-requirements.md`（受信 S-1・S-2）・`multirail-outbound-requirements.md`（送信 S-3・S-4）の別紙。Arc・Solana の **x402** は受信（G-4、2026-10-07）も送信（G-4′、2026-10-08）も公開済み。
> 本書は owner の指示「**Solana の MPP にも Router で inbound・outbound どちらも対応したい**」（2026-10-08）を要件に起こしたもの。設計・タスクは別紙。
>
> **先行文書の読み替え**: `multirail-requirements.md` §1 の表「MPP の adapter は Tempo 専用。これは変えない（MPP を Solana に広げない）」と §3.3「MPP で Solana に払う（SDK に client method が無い）」、
> `multirail-outbound-requirements.md` §3 の「MPP で Arc・Solana に払う（MPP は Tempo 専用のまま）」は、**本書で範囲に入れる**ので superseded。FR-37〜FR-38 の規則（message hash の予約、運用者の集合）は引き継ぐ。
> 番号は続きから: FR-39〜、SR-6〜（安全要件は先行文書の `SR` の慣例に戻す）、AC-15〜、D-18〜。
>
> 第 2 版（独立レビュー #1、§11）: SOL の手数料の方針と予算（FR-44・FR-51・FR-54）、既存の SVM 検査は「そのまま」ではなく primitives の再利用と mode 別の検査（FR-47・FR-52）、mode 別の完全な結果の表（FR-48・FR-53）、
> 承認値への束縛と永続の replay（FR-46・FR-47・FR-50・FR-52、SR-7）、pull の領収の対応づけ（FR-53）、blockhash・RPC・ATA・fee payer の規則（FR-45・FR-47・FR-52・FR-54、SR-6）、payer の鍵の名前は既存の `SOLANA_PAYER_PRIVATE_KEY`（FR-49）、
> 行列と gate の明示（§7・§8）、外部の事実は「設計で再確認する前提」に（§1）。

## 0. 背景: なぜ今 Solana の MPP か

2026-10-08 の第三者 Provider の検証（`docs/DEPLOY.md` §2c の記録の後）で分かったこと:

- Solana devnet で **x402 v2** を出す第三者 Provider は、価格が動的の上限内のものが 1 件だけで、それも非標準の `extra.paymentFlow` を持ち候補外だった。
- **pay.sh**（API provider を束ねる gateway）は x402 ではなく **MPP の `method="solana"`** で払わせる（未払いの GET で見た challenge: `method="solana"`、`intent="charge"`、`request` に `amount`・`currency`（USDC の mint）・`methodDetails{decimals, feePayer, feePayerKey, network, recentBlockhash, tokenProgram}`・`recipient`。
  本番は Solana mainnet、sandbox は "localnet"）。
- Router が **MPP で Solana を受け取る**（S-5）・**MPP で Solana の Provider に払う**（S-6）の両方を持たないと、この形の Provider に届かない。「Solana の Provider の大半が MPP」とは**言えない**（走査は discovery の一覧だけ）。本書の動機は owner の指示と、観測した 1 件の gateway の形。

## 1. 外部の事実（2026-10-08 に確認。**設計で再確認する前提**）

本節は web と npm の記述から取った**主張**で、リポジトリの中では確かめられない。設計の最初の作業として、実物（pay-kit の server・client を fixture として動かす、draft の本文）で再確認し、違えば本書を改める。

| 主張 | 出所 |
|---|---|
| MPP の Solana charge（IETF draft `draft-solana-charge-00`）: challenge の `request` は `amount`（base units の 10 進文字列）・`currency`（SOL は `"sol"`、SPL は mint の base58）・`recipient`（base58）、`methodDetails` に `network`（文字列 `"mainnet"` / `"devnet"` / `"localnet"`。既定 mainnet。client は自分の cluster と違う challenge を拒む）・`decimals`（SPL は必須）・`tokenProgram`・`feePayer`（true なら `feePayerKey` 必須 = サーバが手数料を払う）・`recentBlockhash`（任意。サーバが先に取る）・`splits`。credential の `payload` は **pull `type="transaction"`**（base64 の署名済み tx、復号後 1232 バイト以下。サーバが broadcast。`feePayer: true` なら fee payer として共同署名）・**push `type="signature"`**（base58 の署名。payer が broadcast 済み）・confidential `type="bundle"`。サーバの検証（規範）: challenge の id で保存した challenge を引き `credential.challenge` の全欄が一致、SPL は **`transferChecked`** を**導出した宛先 ATA**・額・mint で照合、**消費した署名の集合で replay を拒む**。領収は `Payment-Receipt`（`method: "solana"`、`challengeId`、`reference` = 署名、`status: "success"`、`timestamp`） | https://paymentauth.org/draft-solana-charge-00.html、https://mpp.dev/payment-methods/solana/charge |
| TypeScript: `mppx` の最新 0.13.2（Router は **0.11.0** を固定）に Solana の method は無い（export は `./tempo`・`./evm`・`./stripe`・`./x402` …）。`mppx` の `Method.from({ name, intent, schema })` は **challenge の request と credential の payload の schema を与えるだけ**で、検証・replay・RPC は含まない（server/client の hook で組む）。Solana の method は **`@solana/pay-kit` 0.13.1**（`@solana/mpp` 0.7.0 は deprecated でこれに統合）が client・server を実装: `charge/pull`・`charge/push`・`session`・`subscription`。server は pull なら署名済み tx を復号して recipient・額・mint・splits・ATA・memo・compute budget を検査し、fee payer として共同署名して broadcast、confirmed/finalized まで待ち `payment-receipt`。push なら署名から tx を取り、同じ構造検査と replay store。依存: `mppx >= 0.8.15`（**通常依存**。Router の 0.11.0 と二重になり得るが、必ず二重になるとは限らない）、`@solana/kit >= 6.5`、`@solana-program/token` 0.13、Solana Keychain。web 標準の dispatcher | `npm view mppx@0.13.2`、`npm view @solana/pay-kit@0.13.1`、`node_modules/mppx/dist/Method.d.ts` |
| Solana の公開の MPP Provider: mainnet は pay.sh。**devnet で公開されている第三者の MPP Provider は見つかっていない**。Solana Foundation の playground `402.surfnet.dev` は localnet | §0、`docs/DEPLOY.md` §2c の第三者検証 |
| devnet USDC は mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`（6 桁、Token program `Tokenkeg…`） | `tools/remote-mcp-config.ts` `OUTBOUND_SOL`・`INBOUND_SOL`（リポジトリの事実） |

## 2. 今の Router が持つもの（本書の基準 `ed60794`、2026-10-08。リポジトリの事実）

- **受信の MPP は Tempo 専用**: `src/adapters/inbound/mpp.ts` は `mppx/server` の `Mppx.create` + `tempo.charge`、**push 固定**（`supportedModes: ["push"]`）、challenge の HMAC 束縛鍵は注入（`SUBETHA_MPP_INBOUND_SECRET`。`src/config.ts` が注入値を**解析**するが、`src/` が process の env を直接読むことはない）。**credential は preflight で発行 offer に束縛**: `payload.challengeNonce` = offer の nonce、`accepted` = 保存した offer と完全一致、route binding、期限、wire の中の challenge id = nonce（`:286-310`）。verify は SDK、settle は `rejected`（`source_rejected`）／`unknown`（`source_settle_unknown`）／`settled`（`txRef`）。
- **送信の MPP も Tempo 専用**: `src/adapters/outbound/mpp.ts`（静的）・`mpp-dynamic.ts`（動的）は `mppx/client` の `tempo.charge`、push 固定（こちらで送金して hash を渡す）、動的は許可した欄だけの challenge と組み直しの署名 facade。**結果の表**: 送出前の失敗は `not_sent`（理由は列挙）、送金 RPC の委譲の後の失敗は `unknown`（`destination_pay_unknown`）、**領収なしの応答は 4xx でも `unknown`**（送金済みのため）、領収が照合できなければ `unknown`（`destination_receipt_unverified`）、整合した領収つきの非 200 は `paid_no_data`、200 は `paid`（`:558-667`、`mpp-dynamic.ts:1059-1117`）。動的の手数料は `FeeEstimate`（EVM の gas の欄）と `feeAsset`（= 宛先の資産。`src/config.ts:273-275`、`:808`）で、Tempo 前提。
- **Solana は x402 だけ**: 受信は facilitator に verify/settle を委ね、`checkSvmTransaction`（`src/adapters/inbound/x402-svm.ts`）が **Router が受け取る唯一の形**（version 0、lookup table 無し、命令はちょうど 4 つ = SetComputeUnitLimit・SetComputeUnitPrice・TransferChecked・Memo、署名 2 つで fee payer の署名は空）を byte 一致で検査する。送信は Router が同じ形の message を組み、builder に依存しない検査、署名前の hash の予約、署名の検証、送出前の wire の再検査（`src/adapters/outbound/x402-svm.ts`）。鍵は専用の ed25519 `SUBETHA_OUTBOUND_SOLANA_KEY`（devnet USDC の ATA あり。**SOL は無い**）。受取は `SUBETHA_SOLANA_RECEIVER`（ATA あり）。RPC は guarded transport（設定の URL だけ。loopback 拒否）、受信の起動時の検査と送信の blockhash・残高で使い、方法と回数は列挙して固定。
- **payer の道具**: `npm run sign`（`tools/sign-payment.ts`）は offer から rail を判定し、Solana の鍵は **`SOLANA_PAYER_PRIVATE_KEY`**（`wallet:new:solana` が出す。案内は「**SOL は要らない**」= x402 の facilitator が手数料を払う前提）。
- **レール**は `"x402"` / `"mpp"` と network の組で合成。MPP の能力は `mppTempo` の 1 つ。有効化は公開の定数 `RAILS_ACTIVATION`（方向別）で、入口はその値を**内部の env**（`SUBETHA_RAILS_ACTIVATION`）で子に渡す（親の env からは変えられない）。journal・予算（`(network, asset)` の区分）・開示・SIGKILL の中断試験は既存。

## 3. 範囲

- **S-5 受信 = Solana の MPP**: 呼び出し側が Solana devnet の USDC を MPP（`method="solana"`、`intent="charge"`、**push**）で Router に払い、Router が既存の送信レールの Provider から買って届ける。
- **S-6 送信 = Solana の MPP**: MPP の `method="solana"` でしか受け取らない Provider に Router が Solana devnet の USDC で払う（**pull = 相手が fee payer** を主、**push = Router が手数料を払う** は D-23）。
- 範囲外: mainnet、`session`・`subscription`・confidential・`splits`、Token-2022、native SOL での支払い、自動 swap/bridge、同レール同チェーン（MPP Solana → MPP Solana。D-16）、pay.sh の mainnet 利用、受信の pull（D-18）。

## 4. 機能要件

### 4.1 共通

- FR-39 **レールの表現**: MPP を network 別の能力にする（x402 の S-3 と同じ形）。受信は `mppInbound` を `{ tempo, solana }` に、送信は `MppTempoCapability` に加えて **`MppSolanaCapability`** = `SvmSigningCapability` と同じ「message の bytes の写しにだけ同期で署名する能力」（鍵は D-19）。route／プロファイルは `rail` と `network` の組で引く。既存の Tempo の経路は 1 つも変えない（AC-15 の回帰）。
- FR-40 **有効化**: `RAILS_ACTIVATION` に方向別の **`solanaMpp: { inbound, outbound }`** を足す（既存の `solana` = x402 と独立）。既定 `false`。公開の定数で決まり、親の env からは変えられない（内部 env の transport は既存のまま）。
- FR-41 **network の束縛**: challenge の `methodDetails.network` は **`"devnet"`** だけを受ける／出す。`currency` は表の devnet USDC の mint、`tokenProgram` は表の Token program、`decimals` は 6。表に無い値は受信では発行せず、送信では候補外。識別子の比較は**大文字小文字を区別**する（base58）。
- FR-42 **ID と開示**: route／プロファイル ID は既存の名前空間（例: 受信の静的 `md-x402-eth-snapshot-solmpp`・`md-mpp-eth-snapshot-solmpp`、送信の静的 `md-solmpp-eth-snapshot`、動的 `dyn-solmpp-to-x402` / `dyn-solmpp-to-mpp` / `dyn-x402-to-solmpp` / `dyn-mpp-to-solmpp`。確定は設計）。`subject` の `fundsMoveOnCredential` は受信 MPP Solana で `true`（Tempo と同じ開示: credential を作る時点で payer が送金し、Router が後で拒んでも返金されない）。
- FR-43 **予算**: Solana devnet USDC の区分は既存の `(network, asset)` に**合算**（受信 x402 Solana・送信 x402 Solana・本書の受信・送信の 4 つが同じ区分。D-14）。**x402 Solana ↔ MPP Solana の組は両レグが同じ区分を使う**ので、1 件の上限と通算の両方が両レグ分で効くことを試験する（AC-15）。
- FR-44 **SOL の手数料の方針**（D-23 で push を持つ場合にだけ効く。pull だけなら Router は SOL を一切持たない）:
  - 手数料の資産は SOL（lamports）で、USDC の予算とは**別の勘定**。lamports と USDC の base units を比べない・合算しない。
  - 1 購入の手数料の上限は**定数**（base fee 5,000 lamports × 署名数 + priority fee の上限。priority fee の `SetComputeUnitPrice` は固定値で、quote の時点でも署名の時点でも同じ）。上限を超える見積りは署名しない（`not_sent`）。
  - Router の送信鍵の SOL 残高を purchase ごとに 1 回読み（`getBalance`）、「上限 × 1」未満なら送信の前（受信の verify の前）に `operator_funds_unavailable`。
  - 手数料は運用者が負担し、quote の額に**転嫁しない**（Tempo の gas と同じ扱い。動的の `pricing.maxFee` は MPP Solana では出さない: `feeAsset` = 宛先の資産 の規則に SOL は入らない）。
  - 動的の `FeeEstimate`（EVM の gas の欄）は MPP Solana の経路では**使わない**（`undefined` を返し、core の gas-indexed の手数料方針を付けない）。

### 4.2 受信（S-5）

- FR-45 **mode は push 固定**（Tempo と同じ: pull はサーバが broadcast して手数料を払う = Router に SOL と送信主体を持ち込む。D-18）。challenge は `feePayer: false`、`recentBlockhash` は**出さない**（push では payer が自分で取る。出すと期限の管理と「相手の値を信じる」問題が生じる）。
- FR-46 **challenge の発行と承認値への束縛**: `mppx` の `Method.from` で Solana の charge の schema を定義し、既存の Tempo 受信と同じ `Mppx.create` + HMAC 束縛（注入した秘密）で発行する。`recipient` は `SUBETHA_SOLANA_RECEIVER`（owner の公開鍵。ATA は配備済み。起動時に ATA の存在・owner・mint を確かめる = 既存の受信 x402 Solana と同じ検査）。`amount` は quote の額、`currency`・`network`・`decimals`・`tokenProgram` は FR-41。**preflight は Tempo 受信と同じ 5 点**（`payload.challengeNonce` = 発行 offer の nonce、`accepted` = 保存した offer と完全一致、route binding、期限、wire の中の challenge id = nonce）に加えて `payload.type === "signature"` と署名の形（base58 64 バイト）。HMAC は challenge の改竄を防ぐだけで、**購入への束縛は preflight の一致検査**が担う。**Router は SDK の server 実装（pay-kit）を本番コードに入れない**（D-20）。
- FR-47 **検証は Router 自身が RPC で**（層を分ける: preflight → verify → settle）:
  - **verify**（`isValid` の判定。RPC が答えなければ既存の `source_verify_unavailable`）: 設定の Solana RPC（guarded transport）で `getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "base64" })` を **1 回**（`null` = 見つからない → `isValid: false`。`finalized` は待たない。D-21）。transaction と meta を読み、**MPP Solana 受信の形**として検査する（`checkSvmTransaction` の **primitives**（命令の復号、`TransferChecked` の欄、Memo の欄、口座の役割）を再利用し、形は別に定義する。x402 の検査は変えない）: version 0、lookup table 無し、**署名はちょうど 1 つ**（fee payer = payer = 転送の authority）、命令は compute budget（0〜2 つ）・**`TransferChecked`**（program = 表、mint = `currency`、decimals = 6、額 = challenge の `amount`、宛先 = `recipient` の**導出 ATA**、source の owner = 署名者）・**Memo がちょうど 1 つで中身が challenge の `id` と byte 一致**（D-22）の順で、それ以外の命令は無い。`meta.err` が `null`、`blockTime` が challenge の発行〜期限の内（`null` なら不正）、`slot` が有る。読んだ transaction の署名が credential の署名と一致。応答の大きさ・時間は既存の RPC の上限（64 KiB・10 秒）。
  - **settle**（RPC は呼ばない）: **消費済み署名の原子的な記録**（SR-7）に成功したら `settled`（`txRef` = 署名）。既に消費済みなら `rejected`（`source_rejected`）。記録に失敗したら `unknown`（`source_settle_unknown`）。
- FR-48 **受信の結果の表**（payer は credential の時点で送金済み。`rejected` は「Router は受けない」であって「送金が無かった」ではない）:

  | 段 | 事象 | 結果 |
  |---|---|---|
  | preflight | nonce・accepted・route binding・期限・wire の id・`type`・署名の形のどれかが違う | `rejected`（既存の理由 `nonce_mismatch` 等。資金は動いていることがある = 開示どおり返金なし） |
  | verify | RPC 不達・形違い・上限超え | `unknown`（`source_verify_unavailable`。再試行しない） |
  | verify | transaction が無い（`null`）、`err` あり、構造が形と違う、Memo が違う、額・mint・宛先が違う、期限外 | `rejected`（`source_rejected`） |
  | settle | 署名が既に消費済み（replay。別の購入か同じ購入の再送） | `rejected`（`source_rejected`） |
  | settle | 消費済みの記録（journal）に失敗 | `unknown`（`source_settle_unknown`） |
  | settle | 記録できた | `settled`（`txRef` = 署名）→ 送信へ |

- FR-49 **payer 側の道具**: `npm run sign` が MPP Solana の challenge（`method="solana"`）を offer から判定し、**手元で FR-47 の形の transfer を組み・署名し・broadcast して、署名を `type="signature"` の credential に入れる**（Router の封筒は既存の MPP と同じ）。鍵は既存の **`SOLANA_PAYER_PRIVATE_KEY`**（名前は変えない）。**署名の前に拒む**: network が `"devnet"` でない、`currency`・`tokenProgram`・`decimals` が表と違う、期限切れ、`amount` が `SIGN_MAX_AMOUNT` を超える、`recipient` が base58 32 バイトでない、`feePayer: true`（push の payer は自分が fee payer）。blockhash は payer の RPC（`SOLANA_RPC_URL`、既定は公開 devnet）で取り、取得〜署名〜送出を 1 つの流れで行う。**送出の応答を失ったら再送しない**: 署名を `.env.local` と同じ場所の記録ファイルに先に書いてから送り、再実行時に同じ challenge id の記録があれば送らずにその署名で credential を作る（二重払いを作らない）。`wallet:new:solana` の案内「SOL は要らない」は「**MPP で払うときは devnet SOL（手数料）が要る**」に改める。CLAUDE.md に「MPP なので credential の時点で資金が動く」「devnet SOL が要る」を明記。

### 4.3 送信（S-6）

- FR-50 **challenge の検査と承認値への束縛**（動的は許可した欄だけ。x402 Solana の候補検査と同じ厳しさ）: `method="solana"`・`intent="charge"`、`request.currency` = 表の mint、`methodDetails.network = "devnet"`、`decimals = 6`、`tokenProgram` = 表、`recipient` が base58 32 バイトで**運用者の集合に無い**、`amount` が**承認値と一致**（静的: 承認 offer と完全一致。動的: 保存した offer の額・recipient と完全一致。上限の内側でも**変わっていれば `destination_offer_changed`**）、`splits`・`confidential` 無し、未知の欄は候補外。`feePayer`（bool）・`feePayerKey`（`feePayer: true` のときだけ必須、base58 32 バイト、運用者の集合に無く、`recipient` とも Router の鍵とも違う）・`recentBlockhash`（任意。読むが FR-52 のとおり使わない）。`feePayer: true` で `feePayerKey` が無い・形違い、`feePayer: false` で `feePayerKey` がある → 候補外。purchase の時点で challenge を読み直し、保存した offer と一致しなければ `not_sent`（`destination_offer_changed`）。期限は署名の直前と送出の直前に再検査。
- FR-51 **mode**: `feePayer: true` なら **pull**（Router は payer として部分署名し、fee payer は `feePayerKey`。相手が broadcast する。Router に SOL は要らない。x402 Solana 送信と同じ「部分署名して相手に送らせる」形）。`feePayer: false` なら **push**（Router が自分で broadcast し手数料を払う。FR-44）。push を持たない構成（D-23 で見送る場合）では `feePayer: false` の challenge は候補外（`destination_unsupported_mode`）。
- FR-52 **transaction は Router が組む**: x402 Solana 送信の **primitives**（message の組み立て、builder に依存しない検査、署名前の message hash の予約 FR-37、署名の検証、送出前の wire の再検査）を再利用し、**mode 別の形**を定義する。pull: 署名 2 つ（[0] fee payer = `feePayerKey` は空、[1] = Router）、命令は compute budget 2 つ + `TransferChecked`（source = Router の ATA、宛先 = `recipient` の導出 ATA、mint・decimals・額）+ Memo（challenge の `id` と byte 一致）。push: 署名 1 つ（Router = fee payer = authority）、命令は同じ。`recentBlockhash` は **challenge の値を使わず Router の RPC で取る**（D-24。取得〜署名の上限 FR-34 と、送出直前の期限の再検査。pull では相手が broadcast するまでの遅れがあるので、送出の直前に残りの slot を見積もって短ければ `not_sent`。保証ではないので pull の遅延は `unknown` 側に倒す）。**送出に失敗・不明でも組み直さない・再送しない**（同じ message は hash の予約で 2 度署名しない）。宛先 ATA は存在・owner・mint を RPC で確かめる（静的は起動時、動的は purchase ごと）。ATA の作成は Provider の責任（rent は Router が払わない）。
- FR-53 **credential・送出・領収**: pull は `type="transaction"`（署名済み tx の base64、1232 バイト以下）、push は `type="signature"`。credential は mppx の `Credential.serialize`（`Authorization: Payment <base64url>`）。1 回だけ送る。領収 `Payment-Receipt` は `method === "solana"`、`challengeId` = challenge の id、`status === "success"`、`reference` が base58 64 バイトの署名であること。**pull の対応づけ**: Router は部分署名の時点では最終の署名（fee payer の署名が [0]）を知らないので、領収の `reference` を **RPC で 1 回 `getTransaction`** し、読めた transaction の message が**署名前に予約した message と byte 一致**すること（= Router が署名した正にその transaction）で照合する。読めない・一致しない → `unknown`（`destination_receipt_unverified`）。push: `reference` が自分の署名と一致すること（RPC は呼ばない）。
  **送信の結果の表（mode 別。既存の MPP の規則に揃える: 送金が動き得る時点の後の失敗は `unknown`）**:

  | 段 | 事象 | pull | push |
  |---|---|---|---|
  | 送出前 | 候補外・承認値の不一致・期限・deadline・署名前の予約の衝突・署名の検証の失敗・残高不足・fee payer の規則違反 | `not_sent`（理由は列挙） | `not_sent` |
  | push の RPC 送出 | `sendTransaction` の委譲の後に失敗・不明 | — | `unknown`（`destination_pay_unknown`） |
  | 有料要求 | 送出の例外・期限（相手が broadcast したかもしれない） | `unknown`（`destination_pay_unknown`） | `unknown` |
  | 有料要求 | 領収なしの 4xx／5xx | `unknown`（`destination_pay_unknown`。4xx でも**送金済みの可能性**を否定できない） | `unknown` |
  | 有料要求 | 領収の形違い・`reference` の照合失敗（pull: RPC で読めない／message 不一致。push: 署名違い） | `unknown`（`destination_receipt_unverified`） | 同左 |
  | 有料要求 | 整合した領収つきの非 200・JSON でない・256 KiB 超 | `paid_no_data` | 同左 |
  | 有料要求 | 整合した領収つきの 200 の JSON | `paid` | `paid` |

- FR-54 **残高の事前確認**: 既存の D-15（purchase ごとに `getTokenAccountBalance` 1 回。静的・動的の両方、受信の verify の前）を MPP Solana 送信にも。push を持つなら **SOL の残高（`getBalance` 1 回）も**（FR-44）。RPC 失敗は不足扱い（`operator_funds_unavailable`）。

### 4.4 文書・道具

- FR-55 CLAUDE.md（agent 向け）・README・DEPLOY §2c を更新: 新しい route／プロファイル、`npm run sign` の挙動（MPP Solana は credential の時点で送金、devnet SOL が要る、再実行で二重払いしない）、有効化の gate。
- FR-56 `tools/remote-mcp-config.ts` の表に MPP Solana の受信・送信、`tools/rails-entry.ts` の env の読み方（増やす env は最小。D-19）。

## 5. 安全要件（先行文書の SR-1〜SR-5 を引き継ぐ）

- SR-6 **RPC の上限**: 受信の verify は `getTransaction` 1 回、送信は `getLatestBlockhash` 1 回・`getTokenAccountBalance` 1 回・（push）`getBalance` 1 回・`sendTransaction` 1 回・（pull の領収）`getTransaction` 1 回、起動時／purchase ごとの宛先 ATA の `getAccountInfo` 1 回。方法はこれだけ。応答は 64 KiB・10 秒。すべて guarded transport（設定の RPC だけ、loopback 拒否）。`npm run sign` も同じ方法の集合（`getLatestBlockhash`・`sendTransaction`、任意で `getSignatureStatuses`）。
- SR-7 **二重払いと replay の永続化**: 送信は message hash の予約（FR-37。静的・動的で**同じ台帳**、署名の前に原子的に永続化、並行の 2 件は後の方が `collision`、process の中断後の再起動で予約が残り `unknown` として確定、再送信 0）。受信は **消費済み署名の集合を journal に永続化**（settle で原子的に追加。同じ署名の並行 2 件は後の方が `rejected`、再起動後も拒む、保持期間は journal と同じ = 削除しない）。発行済みの challenge は既存の quote の台帳（journal）から復元する。
- SR-8 **鍵の境界**: 受信に署名鍵は無い（HMAC の秘密だけ。既存の注入）。送信の署名は `SvmSigningCapability` の形（bytes の写しにだけ署名、鍵の文字列を保持しない）。`src/` は process の env から秘密を読まない（注入値の解析は既存のまま）。
- SR-9 **fee payer の隔離**（pull）: `feePayerKey` は運用者の集合に無く、Router の鍵・ATA と違い、`recipient` と違う。Router の署名は [1] だけで、[0]（fee payer）は空のまま送る。wire の再検査で [0] が空・[1] が自分の署名・message が予約と一致。
- SR-10 **固定の失敗**: Provider／RPC／payer の文言を転送しない（既存の規則）。
- SR-11 **依存の向き**: `@solana/pay-kit` は `src/`・`tools/` から import しない（`@x402/svm` と同じ。fixture と試験だけ）。`mppx` の version は Router 側で 1 つ（D-25）。

## 6. 受け入れ条件（どれも**配備・faucet・署名・送金を許可するものではない**。資金が動くのは §8 の gate だけ）

- AC-15（受信、fixture。Linux）: pay-kit の **client**（参照実装）で組んだ credential を Router が受け、`source_settled` → 既存の送信 4 本で `delivered`（行列 §7 の I-1〜I-4 を静的・動的で）。FR-48 の各行（preflight の 5 点 + `type`・署名の形、RPC 不達、`null`、`err`、構造違反（宛先 ATA・額・mint・余分な命令・署名 2 つ・Memo 無し／違い・lookup table・version 1）、期限外、replay（並行 2 件・再起動後）、journal の失敗）が表どおり。**同じ USDC の区分**: x402 Solana 受信との通算、MPP Solana 受信 → x402 Solana 送信で 1 件の上限が両レグ分で効くこと。既存の Tempo 受信の wire 試験が 1 つも変わらない。
- AC-16（送信、fixture。Linux）: pay-kit の **server**（参照実装。pull と push、`feePayer` の両値）を fixture の Provider にし、Router の送信が `delivered`（O-7〜O-9 を静的・動的で）。FR-53 の各行（送出前の各理由、push の送出不明、領収なしの 4xx／5xx、領収の形違い、pull で `reference` の transaction が読めない／message 不一致、整合した領収の非 200）が表どおり。fixture の server が受けた tx が仕様の検証（`transferChecked`・ATA・memo・fee payer）を通ること。fee payer が運用者・`recipient`・Router の鍵と同じ → `not_sent`。`feePayer: true` で `feePayerKey` 無し → 候補外。`recentBlockhash` の期限（取得〜署名の上限、送出直前の再検査）。SOL 不足（push）→ `operator_funds_unavailable`。能力と network の不一致・無効なレールへの要求 → 起動時の拒否／`not_sent`。
- AC-17（結合、手元。資金が動く。§8 の承認の後）: pay-kit の server を **devnet** で動かす Provider（Provider D。owner が配備。D-26）に対し、受け入れ用の起動で I-1〜I-4 と O-7〜O-9 から**少なくとも各レールの静的 1 件・動的 1 件**を `delivered`。証拠は先行の G-3 と同じ: 受信・送信の両方の transaction（署名・slot・`confirmed`/`finalized`・転送の内容）、宛先 ATA の増分、Provider の応答の本文、client の結果、`status` の再読取（再起動の後も）。
- AC-18（公開、G-4″）: 公開 MCP の一覧に新しい route／プロファイルが出て、各組 1 回の quote（支払わない）。
- AC-19（agent の手順）: `npm run sign` が MPP Solana の offer で `SOLANA_PAYER_PRIVATE_KEY` から credential を作れる（devnet SOL あり）、署名前の拒否（network・資産・期限・額・`feePayer: true`）、送出の応答を失った後の再実行で**送らずに同じ署名**を出す、鍵を出さない。
- AC-20（中断）: 受信は settle の記録の前後、送信は予約の後・署名の後・送出の前で SIGKILL → 再起動で表どおり（受信: 記録前なら `unknown`、記録後なら `settled` から送信へ。送信: `unknown`、再送信 0、同じ message は `collision`）。
- AC-21（sabotage と独立レビュー）: 先行文書と同じく、各 PR に変異の表と Codex のレビュー。SR-3 と同じ署名の境界の独立レビューを送信の adapter に 1 回。

## 7. 行列（追加分。同レール同チェーン MPP Solana → MPP Solana は範囲外）

| ID | 受信 | 送信 | 静的 | 動的 | 送信の mode |
|---|---|---|---|---|---|
| I-1 | MPP Solana（S-5） | x402 Base（Provider A） | ✓ `md-x402-eth-snapshot-solmpp` | ✓ `dyn-solmpp-to-x402` | — |
| I-2 | MPP Solana（S-5） | MPP Tempo（Provider B） | ✓ `md-mpp-eth-snapshot-solmpp` | ✓ `dyn-solmpp-to-mpp` | — |
| I-3 | MPP Solana（S-5） | x402 Arc | —（D-27） | ✓ `dyn-solmpp-to-arc` | — |
| I-4 | MPP Solana（S-5） | x402 Solana | —（D-27） | ✓ `dyn-solmpp-to-sol`（同じ USDC の区分を両レグで使う） | — |
| O-7 | x402 Base | MPP Solana（S-6） | ✓ `md-solmpp-eth-snapshot` | ✓ `dyn-x402-to-solmpp` | pull・push |
| O-8 | MPP Tempo | MPP Solana（S-6） | ✓ `md-solmpp-eth-snapshot-mpp` | ✓ `dyn-mpp-to-solmpp` | pull・push |
| O-9 | x402 Arc / x402 Solana | MPP Solana（S-6） | — | ✓ `dyn-arc-to-solmpp` / `dyn-sol-to-solmpp`（後者は同じ USDC の区分を両レグで） | pull・push |

## 8. gate（owner。資金が動くのはここだけ）

- G-1″ 鍵と資金: 受信は既存の `SUBETHA_SOLANA_RECEIVER`（ATA あり）。送信は D-19（既存の `SUBETHA_OUTBOUND_SOLANA_KEY` を束ねるなら env の追加なし）。push を持つなら Router の送信鍵に **devnet SOL**（faucet。FR-44 の上限 × 余裕）。payer の試験用鍵（`SOLANA_PAYER_PRIVATE_KEY`）に devnet SOL と USDC。Provider D の受取 owner と（pull を試すなら）fee payer の鍵と SOL は owner。
- G-2″ 無効のまま配備 → G-3″ 受け入れの購入（公開を止めて単独起動。owner の承認。AC-17）→ G-4″ 方向別に `true`（AC-18）。
- Provider D（devnet の MPP Solana の Provider。pay-kit の server。Workers の fetch handler か Node かは設計で決め、owner が配備）。

## 9. owner に決めてもらうこと（推奨つき）

| # | 問い | 推奨 |
|---|---|---|
| D-18 | 受信で pull（Router が broadcast し手数料を払う）も持つか | **持たない**（Tempo と同じ push 固定。Router に SOL と送信主体を持ち込まない） |
| D-19 | 送信の Solana の鍵: 既存の `SUBETHA_OUTBOUND_SOLANA_KEY` を MPP にも束ねるか、専用の鍵か | **束ねる**（env を増やさない。x402 Solana と同じ ATA・残高。予算は同じ区分に合算） |
| D-20 | 本番コードに `@solana/pay-kit` を入れるか、`mppx` の `Method.from`（schema）+ Router の server/client の hook + 既存の SVM の primitives で自前にするか | **自前**（検証の規則・RPC の上限・journal の replay を Router の流儀に揃える。pay-kit は fixture と試験の参照実装に。**`Method.from` は検証も replay も含まない**ので、hook の実装は設計の範囲） |
| D-21 | 受信の確定度: `confirmed` で受けるか `finalized` を待つか | **`confirmed` で受け、`finalized` は待たない**（Router の SVM 追跡と同じ閾値。finality の保証ではない。`unknown` の規則は既存） |
| D-22 | 受信の Memo: challenge の id と byte 一致する Memo をちょうど 1 つ要求するか | **要求する**（仕様の server と同じ契約。payer の道具が付ける。無い・違う → `rejected`。pay-kit の client がどう付けるかは設計で確認） |
| D-23 | 送信で push（Router が broadcast し SOL を払う）を持つか、pull（相手が fee payer）だけか | **まず pull だけ**（SOL の勘定・上限・残高を持ち込まない。pay.sh 型は `feePayer: true`）。push は FR-44 の方針つきで**第 2 段**（`feePayer: false` の Provider が実際に要るときに） |
| D-24 | pull で challenge の `recentBlockhash` を使うか | **使わない**（自分の RPC で取る。相手の値は信頼しない。相手が別の blockhash を要求する実装なら設計で再検討 = 相互運用の確認が前提） |
| D-25 | `mppx` を 0.11.0 のまま使うか、0.13.x に上げるか | **据え置き**（`Method.from`・`Credential.serialize`・HMAC の challenge は 0.11.0 にある）。pay-kit との相互運用は fixture で固定して確かめる。上げるなら Tempo の受信・送信の wire 試験を全部通してから別 PR |
| D-26 | Provider D を誰がどこに | **owner が pay-kit の server を devnet で**（Router 側は fixture で先に進める） |
| D-27 | MPP Solana 受信 → x402 Arc / x402 Solana の静的 route を置くか | **置かない**（動的で届く。静的の表は増やさない） |

## 10. 未確認（設計で確かめる）

- draft の欄・既定値・credential の形、Memo・replay・challenge の保存の規範、pay-kit 0.13.1 の挙動（client が付ける Memo、pull で fee payer が共同署名する順、`recentBlockhash` の扱い、push の replay store）、mppx 0.13.x の export、pay.sh の mainnet/localnet の挙動。
- Provider D を Workers で動かせるか（pay-kit の web 標準 dispatcher の主張）。

## 11. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| 1 | 2026-10-08 | `gpt-6-astra`（read-only。第 1 版 `ce01a28`） | **REJECT**（8 項目: SOL の手数料の方針と予算、SVM 検査の再利用の範囲、mode 別の結果の表と層の分離、承認値への束縛と永続の replay、pull の領収の対応づけ、blockhash・RPC・ATA・fee payer の規則、payer の鍵名と道具の要件、行列と gate の明示。加えて先行文書の読み替え・番号・`SR` の慣例・env の表現の訂正、外部の事実は未確認と明示）。第 2 版で反映 |
