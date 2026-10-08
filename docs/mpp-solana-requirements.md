# 要件: Solana の MPP（`method="solana"`、`intent="charge"`）を受信・送信の両方で（S-5・S-6。第 1 版、2026-10-08）

> `multirail-requirements.md`（受信 S-1・S-2）・`multirail-outbound-requirements.md`（送信 S-3・S-4）の別紙。Arc・Solana の **x402** は受信（G-4、2026-10-07）も送信（G-4′、2026-10-08）も公開済み。
> 本書は owner の指示「**Solana の MPP にも Router で inbound・outbound どちらも対応したい**」（2026-10-08）を要件に起こしたもの。設計・タスクは別紙。
> 第 1 版は独立レビュー前。§9 の問いに owner が答えてから設計に進む。

## 0. 背景: なぜ今 Solana の MPP か

2026-10-08 の第三者 Provider の検証（`docs/DEPLOY.md` §2c の記録の後）で分かったこと:

- Solana devnet で **x402 v2** を出す第三者 Provider は、価格が動的の上限内のものが 1 件だけで、それも非標準の `extra.paymentFlow` を持ち候補外だった。
- **pay.sh**（75 の API provider を束ねる gateway）は x402 ではなく **MPP の `method="solana"`** で払わせる（challenge: `realm="payment-debugger-…solana-foundation.vercel.app"`、`method="solana"`、`intent="charge"`、`request` に `amount`・`currency`（USDC の mint）・`methodDetails{decimals, feePayer, feePayerKey, network, recentBlockhash, tokenProgram}`・`recipient`）。
  本番は Solana mainnet、sandbox は "localnet"（Solana Foundation の Surfnet）。
- つまり Solana 上の「払う側」の実需は MPP に寄りつつあり、Router が **MPP で Solana を受け取る**（S-5）・**MPP で Solana の Provider に払う**（S-6）の両方を持たないと、Solana の Provider の大半（pay.sh 経由を含む）に届かない。

## 1. 外部の事実（2026-10-08 に確認）

| 事実 | 出所 |
|---|---|
| MPP の Solana charge の仕様（IETF draft `draft-solana-charge-00`）: challenge の `request` は `amount`（base units の 10 進文字列）・`currency`（SOL は `"sol"`、SPL は mint の base58）・`recipient`（base58 の公開鍵）、`methodDetails` に `network`（**文字列 `"mainnet"` / `"devnet"` / `"localnet"`**。既定 mainnet。**client は自分の cluster と違う challenge を拒まなければならない**）・`decimals`（SPL では必須）・`tokenProgram`・`feePayer`（bool。true なら `feePayerKey` 必須 = サーバが手数料を払う）・`recentBlockhash`（サーバが先に取って client の RPC 往復を省く）・`splits`（最大 8）。credential の `payload` は 3 形: **pull `type="transaction"`**（base64 の署名済み tx、復号後 1232 バイト以下。**サーバが broadcast** し、`feePayer: true` なら fee payer として共同署名）、**push `type="signature"`**（base58 の署名。payer が broadcast 済み）、confidential `type="bundle"`（Token-2022。範囲外）。サーバの検証は規範: challenge の id で保存した challenge を引き、`credential.challenge` の全欄が一致、SPL は **`transferChecked`** を**導出した宛先 ATA**・額・mint で照合、**消費した署名の集合を保持して replay を拒む**。領収は `Payment-Receipt`（`method: "solana"`、`challengeId`、`reference` = 署名、`status: "success"`、`timestamp`） | https://paymentauth.org/draft-solana-charge-00.html、https://mpp.dev/payment-methods/solana/charge |
| TypeScript の実装: `mppx` の最新 0.13.2（Router は **0.11.0 を固定**）に Solana の method は**無い**（export は `./tempo`・`./evm`・`./stripe`・`./x402` など）。`mppx` は `Method.from({ name, intent, schema })` で**独自の method を定義できる**（challenge の request と credential の payload の zod schema を与える）。Solana の method は Solana Foundation の **`@solana/pay-kit` 0.13.1**（`@solana/mpp` 0.7.0 は deprecated でこれに統合）が client・server の両方を実装: `charge/pull`・`charge/push`・`session`・`subscription`。server は pull なら署名済み tx を復号して recipient・額・mint・splits・ATA・memo・compute budget を検査し、fee payer として共同署名して broadcast、confirmed/finalized まで待ち `payment-receipt` を出す。push なら署名から tx を取り、同じ構造検査と replay store。client は `PayKitClient`（`signer`・`rpcUrl`・`network('mainnet')`・permissions）。依存: `mppx >= 0.8.15`（通常依存。Router の 0.11.0 と二重になり得る）、`@solana/kit >= 6.5`、`@solana-program/token` 0.13、Solana Keychain。web 標準の `Request`/`Response` の dispatcher（Workers でも動く設計） | `npm view @solana/pay-kit`、README |
| Solana の公開の MPP Provider: mainnet は pay.sh（gateway）など。**devnet で公開されている第三者の MPP Provider は見つかっていない**（Bazaar・PayAI・x402-list・pay.sh の走査）。Solana Foundation の playground `402.surfnet.dev` は localnet（Surfnet） | §0、`docs/DEPLOY.md` §2c の第三者検証 |
| Solana devnet の USDC は mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`（6 桁、Token program `Tokenkeg…`）。Router の表の値と同じ | `tools/remote-mcp-config.ts` `OUTBOUND_SOL`・`INBOUND_SOL` |

## 2. 今の Router が持つもの（本書の基準 `ed60794`、2026-10-08）

- **受信の MPP は Tempo 専用**: `src/adapters/inbound/mpp.ts` は `mppx/server` の `Mppx.create` + `tempo.charge`、**push 固定**（`supportedModes: ["push"]`。pull はサーバが broadcast して gas を払うので持ち込まない）、challenge の HMAC 束縛鍵 `SUBETHA_MPP_INBOUND_SECRET`、受取先は EVM address。検証は SDK（Tempo の RPC で tx を読む）。
- **送信の MPP も Tempo 専用**: `src/adapters/outbound/mpp.ts`（静的）・`mpp-dynamic.ts`（動的）は `mppx/client` の `tempo.charge`、push 固定（こちらで送金して hash を渡す。`feePayer` は読まない）、動的は許可した欄だけの challenge と組み直しの署名 facade、RPC の送信境界は raw の 2 メソッドだけ。
- **Solana は x402 だけ**: 受信は x402.org の facilitator に verify/settle を委ね（`src/adapters/inbound/x402-svm.ts`、`checkSvmTransaction` で transaction の構造を自前で検査）、送信は **Router が transaction を自分で組み・検査し・署名し**、facilitator の fee payer に送らせる（`src/adapters/outbound/x402-svm.ts`: compute budget + `TransferChecked` + Memo の固定形、builder に依存しない message の検査、署名前の message hash の予約、署名の検証、送出前の wire の再検査）。鍵は専用の ed25519 `SUBETHA_OUTBOUND_SOLANA_KEY`（devnet USDC の ATA あり。**SOL は持たない**: 手数料は facilitator）。受取は `SUBETHA_SOLANA_RECEIVER`（owner の公開鍵、ATA あり）。RPC は guarded transport（`SUBETHA_SOLANA_RPC_URL`、既定は公開 devnet）。
- **レールは名前で 2 本**（`"x402"` / `"mpp"`）に network を組み合わせて合成する（S-3・S-4 で x402 は network 別の能力を持つようになった。`evmSigningByNetwork`・`svmSigning`）。MPP の能力は `mppTempo` の 1 つだけ（`src/ports/outbound.ts` `MppTempoCapability`）。
- 公開の有効化は 1 つの定数 `RAILS_ACTIVATION = { arc: {inbound, outbound}, solana: {inbound, outbound} }`（方向別）。journal・予算（`(network, asset)` の区分）・開示・`npm run sign`（rail を offer から判定）は既存。
- `.claude/settings.json` が許す鍵の操作は `npm run sign` / `wallet:new` / `wallet:balance` / `wallet:new:solana` だけ。

## 3. 範囲

- **S-5 受信 = Solana の MPP**: 呼び出し側が **Solana devnet の USDC を MPP（`method="solana"`、`intent="charge"`）で Router に払い**、Router が既存の送信レール（x402 Base、MPP Tempo、x402 Arc、x402 Solana）の Provider から買って届ける。
- **S-6 送信 = Solana の MPP**: **MPP の `method="solana"` でしか受け取らない Provider**（pay.sh 型）に Router が Solana devnet の USDC で払い、既存の受信レール（x402 Base、MPP Tempo、x402 Arc、x402 Solana、S-5 の MPP Solana）で受けた購入を届ける。
- 範囲外: mainnet（全部 testnet/devnet）、`session`・`subscription`・confidential（`type="bundle"`）・`splits`、Token-2022、SOL（native）での支払い、自動 swap/bridge、同レール同チェーン（MPP Solana → MPP Solana）は D-16 と同じく範囲外、pay.sh の **mainnet** 利用。

## 4. 機能要件

### 4.1 共通

- FR-40 **レールの表現**: MPP を network 別の能力にする（x402 の S-3 と同じ形）。受信は `mppInbound` を `{ tempo, solana }` の組に、送信は `MppTempoCapability` に加えて **`MppSolanaCapability`**（S-4 の `SvmSigningCapability` と同じ「message の bytes にだけ署名する同期の能力」。鍵は `SUBETHA_OUTBOUND_SOLANA_KEY` を**そのまま束ねる**か専用にするかは D-19）。route／プロファイルは `rail` と `network` の組で引く。
- FR-41 **有効化**: `RAILS_ACTIVATION` に **方向別の `solanaMpp: { inbound, outbound }`** を足す（既存の `solana` = x402 とは独立）。既定 `false`。env からは変えられない。
- FR-42 **network の束縛**: challenge の `methodDetails.network` は **`"devnet"` だけ**を受ける／出す（mainnet・localnet は候補外・発行しない）。`currency` は表の devnet USDC の mint、`tokenProgram` は表の Token program、`decimals` は 6。表に無い値は拒む（受信: 発行しない。送信: 候補外）。
- FR-43 **ID と開示**: route／プロファイル ID は既存の名前空間（例: 受信 `md-x402-eth-snapshot-solmpp`、送信 `md-solmpp-eth-snapshot`、動的 `dyn-solmpp-to-x402` / `dyn-solmpp-to-mpp` / `dyn-x402-to-solmpp` / `dyn-mpp-to-solmpp`。確定は設計）。`subject` の `fundsMoveOnCredential` は **受信 MPP Solana は `true`**（push: credential を作る時点で payer が送金する。Tempo と同じ開示）。
- FR-44 **予算**: Solana devnet USDC の区分は既存（受信 x402 Solana・送信 x402 Solana と **同じ `(network, asset)` に合算**。D-14 と同じ）。

### 4.2 受信（S-5）

- FR-45 **mode は push 固定**（Tempo と同じ理由: pull はサーバが broadcast して手数料を払う = Router に SOL と送信主体を持ち込む）。challenge は `feePayer: false`、`recentBlockhash` は**出さない**（push では不要。出すと期限の管理が要る）。D-18 で pull を足すかは別途。
- FR-46 **challenge の発行**: `mppx` の `Method.from` で Solana の charge を定義し、既存の Tempo 受信と同じく `Mppx.create` + HMAC 束縛（`SUBETHA_MPP_INBOUND_SECRET`）で発行する。`recipient` は `SUBETHA_SOLANA_RECEIVER`（owner の公開鍵。ATA は配備済み）。`amount` は quote の額、`currency` は表の mint、`network: "devnet"`、`decimals: 6`、`tokenProgram` は表の値。**Router は SDK の server 実装（pay-kit）を本番コードに入れない**（D-20。理由: pay-kit は `mppx` を別 version で抱え込み、検証の挙動が Router の規則（固定の失敗、RPC の上限、journal の replay）と別になる。参照実装として fixture と試験にだけ使う）。
- FR-47 **検証は Router 自身が RPC で**（x402 受信では facilitator がしていた部分）: `type="signature"` の credential から署名を取り、設定の Solana RPC（guarded transport、**1 購入あたりの RPC 呼び出しは上限つき・方法は列挙**）で transaction を `getTransaction`（`confirmed` 以上。`finalized` を待つかは D-21）し、`checkSvmTransaction` と同じ観点で**構造を検査**する: 命令は compute budget（任意）・**`TransferChecked`（mint・decimals・額・宛先 = `recipient` の導出 ATA）**・Memo（challenge の id を含む。D-22）だけ、署名者は payer 1 人（fee payer = payer）、`err` が無い、`blockTime` が challenge の期限内。**replay**: 消費した署名を journal に**永続化**して拒む（process 再起動でも効く。FR-37 の予約と同じ流儀）。
- FR-48 **結果の表**: 検証に通らない → `rejected`（`source_rejected`。資金は payer が既に動かしている = Tempo の開示と同じ「返金なし」）。RPC が答えない・形が違う → `unknown`（`source_settle_unknown`、再 settle しない）。通った → `source_settled`（txRef = 署名）→ 送信へ。
- FR-49 **payer 側の道具**: `npm run sign` が MPP Solana の challenge（`method="solana"`）を offer から判定し、**手元で transfer を組み・署名し・broadcast して署名を credential に入れる**（`type="signature"`）。鍵は `SUBETHA_PAYER_SOLANA_PRIVATE_KEY`（`wallet:new:solana` の seed。受信 x402 Solana と同じ）。**payer は SOL（手数料）を持つ必要がある**（push では fee payer = payer）。CLAUDE.md に「MPP なので credential の時点で資金が動く」と「devnet SOL が要る」を明記。

### 4.3 送信（S-6）

- FR-50 **challenge の検査**（動的は許可した欄だけ）: `method="solana"`・`intent="charge"`、`request.currency` = 表の mint、`methodDetails.network = "devnet"`、`decimals = 6`、`tokenProgram` = 表、`recipient` が base58 32 バイトで**運用者の集合に無い**、`amount` が承認値（静的）／上限（動的）の内、`splits` 無し、`confidential` 無し、未知の欄は候補外（x402 Solana の候補検査と同じ厳しさ）。`feePayer`・`feePayerKey`・`recentBlockhash` は読む（下の mode の選択に使う）。
- FR-51 **mode**: Provider の challenge が **`feePayer: true`** なら **pull**（Router は payer として署名し、fee payer は Provider の `feePayerKey`。Router の SOL は要らない。x402 Solana 送信と同じ「部分署名して相手に送らせる」形）。`feePayer: false` なら **push**（Router が自分で broadcast し手数料を払う = **Router の送信鍵に devnet SOL が要る**）。push を持つかは D-23。
- FR-52 **transaction は Router が組む**（x402 Solana 送信の builder と検査をそのまま使う: 固定の形 compute budget + `TransferChecked` + Memo、builder に依存しない message の検査、**署名前の message hash の予約**、署名の検証、送出前の wire の再検査）。pull では `recentBlockhash` は **challenge のものを使わず**自分の RPC で取る（期限を自分で管理する。challenge の値は照合に使わない。D-24）。fee payer（`feePayerKey`）は**運用者の集合に無い**こと。Memo は challenge の `id`（Provider が照合する。仕様の server は memo を検査する）。
- FR-53 **credential と送出**: pull は `type="transaction"`（署名済み tx の base64、1232 バイト以下）、push は `type="signature"`。`Authorization: Payment <base64url>` の credential は mppx の `Credential.serialize` で作る。1 回だけ送る。領収 `Payment-Receipt` の `reference`（署名）・`challengeId`・`status` を読み、共有の表（`paidOutcomeOf` と同じ分類: 領収なしの 5xx = `unknown`、4xx = `rejected`、整合した領収つきの非 200 = `paid_no_data`）に写す。pull では **送出した時点で資金が動き得る**（相手が broadcast する）: 4xx でも `unknown` 側に倒すかは設計（x402 Solana の pull 相当の扱いに揃える）。
- FR-54 **残高の事前確認**: 既存の D-15（purchase ごとに `getTokenAccountBalance` 1 回）を MPP Solana 送信にも。push なら **SOL の残高も**見る。

### 4.4 文書・道具

- FR-55 CLAUDE.md（agent 向け）・README・DEPLOY §2c を更新: 新しい route／プロファイル、`npm run sign` の挙動（MPP Solana は credential の時点で送金、devnet SOL が要る）、有効化の gate。
- FR-56 `tools/remote-mcp-config.ts` の表に MPP Solana の受信・送信の項目、`tools/rails-entry.ts` に env の読み方（増やす env は最小。D-19）。

## 5. 非機能・安全

- NFR-10 **鍵の境界は今のまま**: 受信に署名鍵は無い（HMAC 鍵だけ）。送信の署名は `SvmSigningCapability` の形（message の bytes の写しにだけ署名、鍵の文字列を保持しない）。`src/` は env から秘密を読まない。
- NFR-11 **RPC の上限**: 受信の検証も送信の blockhash・残高も、1 購入あたりの呼び出し回数と方法を列挙して固定し（x402 Solana 送信の §4.3 と同じ）、guarded transport（設定の RPC だけ。loopback 拒否）を通す。
- NFR-12 **二重払いと replay**: 送信は message hash の予約（FR-37）、受信は消費済み署名の永続化（FR-47）。process の中断（SIGKILL）の試験を両方向に。
- NFR-13 **固定の失敗**: Provider／RPC／payer の文言を転送しない（既存の規則）。
- NFR-14 **依存の向き**: `@solana/pay-kit` は `src/`・`tools/` から import しない（SR-1 の `@x402/svm` と同じ。fixture と試験だけ）。`mppx` の version は Router 側で 1 つ（0.11.0 のまま、または計画的に上げる。D-25）。

## 6. 受け入れ条件

- AC-15（受信、fixture）: pay-kit の **client**（参照実装）で組んだ credential を Router が受け、`source_settled` → 既存の送信（x402 Base／MPP Tempo／x402 Arc／x402 Solana）で `delivered`。構造違反（宛先 ATA 違い・額違い・mint 違い・余分な命令・署名者 2 人・Memo 無し）・replay・期限切れ・RPC 不達の各行が表どおり。
- AC-16（送信、fixture）: pay-kit の **server**（参照実装。pull と push）を fixture の Provider にし、Router の送信が `delivered`。相手の領収なし 5xx／4xx／形違い、pull で相手が broadcast しない、fee payer が運用者、`recentBlockhash` の期限、の各行が表どおり。fixture の server が受けた tx が仕様の検証（transferChecked・ATA・memo）を通ること。
- AC-17（結合、手元）: pay-kit の server を **devnet** で動かす Provider（owner が配備。Provider D。D-26）に対し、受け入れ用の起動で S-5 → 既存送信、既存受信 → S-6、S-5 → S-6 以外の組を各 1 件 `delivered`。
- AC-18（公開、G-4″）: 公開 MCP の一覧に新しい route／プロファイルが出て、各組 1 回の quote（支払わない）。
- AC-19（agent の手順）: `npm run sign` が MPP Solana の offer で手元の鍵から credential を作れる（devnet SOL あり）。鍵を出さない。

## 7. 行列（追加分）

| 受信 | 送信 | 種別 |
|---|---|---|
| MPP Solana（S-5） | x402 Base（Provider A） | 静的 + 動的 |
| MPP Solana（S-5） | MPP Tempo（Provider B） | 静的 + 動的 |
| MPP Solana（S-5） | x402 Arc / x402 Solana | 動的（静的は D-27） |
| x402 Base | MPP Solana（S-6） | 静的 + 動的 |
| MPP Tempo | MPP Solana（S-6） | 静的 + 動的 |
| x402 Arc / x402 Solana / MPP Solana | MPP Solana（S-6） | 動的（同チェーンの MPP Solana → MPP Solana は範囲外） |

## 8. gate（owner）

- G-1″ 鍵と資金: 受信は既存の `SUBETHA_SOLANA_RECEIVER`（ATA あり）。送信は D-19 の鍵（既存の `SUBETHA_OUTBOUND_SOLANA_KEY` を束ねるなら追加なし）、push を持つなら **devnet SOL**（faucet）。payer の試験用鍵（`wallet:new:solana`）にも devnet SOL と USDC。
- G-2″ 無効のまま配備 → G-3″ 受け入れの購入（公開を止めて単独起動。資金が動く。owner の承認）→ G-4″ 方向別に `true`。
- Provider D（devnet の MPP Solana の Provider。pay-kit の server。Workers か Node かは設計）: owner が配備（鍵は Provider 側の受取 owner と fee payer。fee payer は pull を試すなら SOL が要る）。

## 9. owner に決めてもらうこと（推奨つき）

| # | 問い | 推奨 |
|---|---|---|
| D-18 | 受信で pull（Router が broadcast し手数料を払う）も持つか | **持たない**（Tempo と同じ push 固定。Router に SOL と送信主体を持ち込まない） |
| D-19 | 送信の Solana の鍵: 既存の `SUBETHA_OUTBOUND_SOLANA_KEY` を MPP にも束ねるか、専用の鍵か | **束ねる**（env を増やさない。x402 Solana と同じ ATA・残高を使う。予算は同じ区分に合算） |
| D-20 | 本番コードに `@solana/pay-kit` を入れるか、`mppx` の `Method.from` + Router 既存の SVM の builder／検査で自前にするか | **自前**（検証の規則・RPC の上限・journal の replay を Router の流儀に揃える。pay-kit は fixture と試験の参照実装に） |
| D-21 | 受信の確定度: `confirmed` で受けるか `finalized` を待つか | **`confirmed` で受け、`finalized` は待たない**（x402.org の facilitator と同じ。`unknown` の規則は既存） |
| D-22 | 受信の Memo: challenge の id を Memo に要求するか | **要求する**（仕様の server と同じ。payer の道具が付ける。無ければ `rejected`） |
| D-23 | 送信で push（Router が broadcast、SOL を払う）を持つか、pull（相手が fee payer）だけか | **両方**（pay.sh 型は `feePayer: true` が多いが、保証はない。push は SOL の残高の事前確認つき） |
| D-24 | pull で challenge の `recentBlockhash` を使うか | **使わない**（自分の RPC で取り、取得〜署名の上限 FR-34 を守る。相手の値は信頼しない） |
| D-25 | `mppx` を 0.11.0 のまま使うか、0.13.x に上げるか | **まず据え置き**（`Method.from` は 0.11.0 にある）。上げるなら Tempo の受信・送信の wire 試験を全部通してから別 PR |
| D-26 | Provider D を誰がどこに | **owner が pay-kit の server を devnet で**（Workers の fetch handler か Node。Router 側は fixture で先に進める） |
| D-27 | MPP Solana 受信 → x402 Arc / x402 Solana の静的 route を置くか | **置かない**（動的で届く。静的の表は増やさない） |

## 10. 独立レビューの記録

| 回 | 日付 | モデル | 判定 |
|---|---|---|---|
| （未） | | | |
