# 設計: 動的上流 URL

> 2026-10-05。要件は `docs/dynamic-upstream-requirements.md`（以下「要件」）。FR・AC・U の番号はその文書のもの。
> 本書は U-1〜U-9 に結論を出し、変更箇所と試験を定める。**実装の着手とタスク分割は次のフェーズ**。
> 先行して出した修正: 予算の予約を verify の後へ移した（PR #6、本番反映済み。要件 FR-23 の主要部分）。

## 0. 一枚で

```
呼び出し側 ─ quote(profileId, url) ─> Router ─ GET url（未払い・A の transport）─> 上流
            <─ subject（url・payTo・上流額・手数料・受信額・ownerKey）
人間が承認
呼び出し側 ─ purchase(credential, ownerKey) ─> Router
                                               1. preflight（署名に効く束縛）
                                               2. 上流を読み直して保存済み offer と照合
                                               3. 受信 verify
                                               4. ここで初めて journal に書く → 予算予約 → 受信 settle
                                               5. 範囲内の支払い操作だけを署名／送金 → 応答（上限つき）
```

設計の柱は 4 つ。

1. **動的プロファイル = 運用者が設定で宣言する「宛先だけが空いた route」**。起動時の Map は既存のまま、プロファイル 1 つが 1 エントリになる（U-1）
2. **未払いの quote は journal に書かない**。別の「quote 控え」に置き、受信 verify が通った時点で journal に昇格する（FR-21・FR-33）
3. **運用者の鍵が行う操作は、上流の offer ではなく設定で決めた範囲と照合する**（FR-18）
4. **持ち主の証明は quote 時に発行する `ownerKey`**。共有 principal・`requestId`・`paymentId` は証明に使わない（FR-32）

## 1. 設定（U-1・U-3・FR-2・FR-13）

`RouterConfig` に `dynamic` を足す。**省略時は無効**。env からは有効にできない（本番の入口 `tools/remote-mcp.ts` がコードで組む設定に書く）。

```ts
interface DynamicConfig {
  readonly enabled: boolean;
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  readonly budget: BudgetLimits;              // 静的 route とは別の通算（§6）
  readonly limits: DynamicLimits;             // §8 の数値
  readonly denyHosts: readonly string[];      // §7.3
}
interface DynamicProfile {
  readonly profileId: string;                 // routeId と同じ文字種・同じ名前空間。route と重複したら起動失敗
  readonly sourceRail: "x402" | "mpp";        // SubEtha 受信は対象外（本番の構成に無い）
  readonly source: { network; asset; decimals; payTo };          // 額は持たない
  readonly rail: "x402" | "mpp";
  readonly destination: {
    scheme; network; asset; decimals;
    tokenDomain?: { name; version };          // x402 送信: EIP-712 domain の権威
    feeAsset?: string; maxFee?: string;       // mpp 送信: 手数料資産と 1 件の上限（base units）
  };
  readonly par: true;                          // 1:1 とみなす宣言。true 以外は起動失敗
  readonly maxUpstreamAmount: string;          // 送信資産の base units
  readonly fee: { flat: string; bps: number; min: string };      // 受信資産の base units
}
```

- プロファイルは **route と同じ経路で起動時 Map に載る**: `railByRoute`（`src/main.ts:75-98`）、`inboundByRoute`（`:109-154`）、
  route 単位の受信 adapter 生成（`:252-305`）は、route の列にプロファイルを連結して回す。
  プロファイルの `routeBinding` は `routeBindingOf` と同じ形（`profileId|GET|/v1/routes/<profileId>/resource`）で、**プロファイル単位**。
  quote 単位の束縛は §4 で別に作る
- `Intent.routeId` にはプロファイル ID が入る。**購入口のパス・client・MCP の purchase は変更なし**
  （`/v1/routes/<profileId>/resource`、`src/client/index.ts:295`、`src/http/app.ts:221-233`）
- 指紋（`authoritativeTermsOf` 相当）にはプロファイルの全欄と `dynamic.enabled` を含める。
  **手数料・上限・ペア・有効／無効のどれを変えても、変更前の quote は purchase で `quote_changed`**（FR-16・FR-34）。
  既存の判定（`orchestrator.ts` の `routeMismatch`）をそのまま使う: 無効化するとプロファイルが解決できず `currentRoute === undefined` になる
- 一覧（R1）の `routes` は変えない。`dynamic.enabled` のとき、同じ応答に `dynamic: { profiles: [...] }` を**追加**する
  （profileId、両側の rail／network／asset／decimals、手数料規則、上限）。上流 URL は元々持たない

### 1.1 旧要件が挙げた静的前提への答え（旧 §12.2・§15.1 の全箇所）

| 箇所 | 対応 |
|---|---|
| `main.ts` の送信 dispatch・受信 Map 2 本 | プロファイルを route と同列に登録。変更は列挙元だけ |
| `orchestrator.ts` の `unknown_route` | `resolveRoute` に加えて `resolveProfile` を引く。どちらにも無ければ従来どおり拒否 |
| `app.ts` の quote／purchase の route 要求 | 同上。quote 本文に `upstream.url` があるときだけ動的として扱う |
| `projection.ts` の `RouteConfig` 要求 | 動的用の `dynamicQuoteBody` を別に持つ（静的の関数は触らない） |
| adapter 内の upstream Map（`x402.ts:255`、`mpp.ts:203`） | **Map はそのまま**。動的は port に渡された URL を使う別経路（§3） |
| `client` の固定パス、MCP の `routeId` | 変更なし（profileId が `routeId` の位置に入る） |
| `Intent` に上流 URL が無い | `upstream`・`dynamic` を追加（§2.3）。旧実装は未知の欄を無視する（`store.ts:51-82`） |

## 2. 入口と記録（U-1・FR-1・FR-3〜5・FR-7）

### 2.1 入口

- HTTP: `POST /v1/quotes` の本文に `upstream: { url }` を足せる。`routeId` にはプロファイル ID を入れる。
  `upstream` が無ければ**現行と完全に同じ処理**
- MCP: **新しい tool `subetha_router_quote_url`**（`profileId`・`url`・`requestId`）。既存の `subetha_router_quote` の
  schema と説明は変えない。purchase／status は既存 tool に**省略可能な引数を足すだけ**（§5）
- 呼び出し側は**自分が払えるレールのプロファイルを選ぶ**。上流がそのプロファイルの送信レールの offer を出さなければ
  `no_matching_offer`。Router がプロファイルを推測して選ぶことはしない

### 2.2 URL（FR-3・FR-4・U-8）

`parseUpstreamUrl(raw)` は純粋関数で、**ネットワークに出る前に**次を拒否する。通ったら `new URL(raw).href` を唯一の表現として返す。

| 規則 | 値 |
|---|---|
| 長さ | 2048 文字以下 |
| scheme | `https:` のみ |
| userinfo・fragment | 拒否 |
| ポート | 既定（443）のみ。明示的な `:443` 以外のポート指定は拒否 |
| ホスト | **IP リテラルは拒否**（v4・v6 とも）。末尾ドット付きは拒否 |
| `raw !== href` | **拒否**（`new URL()` が書き換える入力＝大文字ホスト・dot segment・空白・既定ポートの明示などは、呼び出し側に直して出し直させる） |
| クエリ | 文字列の一部として許す。並べ替えない |
| `denyHosts` | §7.3 |

「正規化で変わる入力を拒否する」ことで、**呼び出し側が渡した文字列・表示・保存・fetch・上流の申告との比較がすべて同一のバイト列**になる。
独自の同値規則は持たない。

### 2.3 quote の記録

動的 quote の記録（控え、昇格後は journal の `created`）は既存の欄に加えて次を持つ。

```
upstream: { url, method: "GET" }
dynamic:  { profileId, upstreamAmount, fee, ownerKeyHash }
destination.selectedOffer   // payTo を含む。既存欄
routeFingerprint            // プロファイルの指紋。既存欄
```

**purchase はこの記録だけを実行する。** MCP が持ち回る quote 文書から読むのは `quoteId` と `ownerKey` だけで、
URL・`payTo`・額は読まない（既存の `purchaseLocked` が `store` の intent しか使わないのと同じ）。

### 2.4 `requestId` の衝突（FR-7）

`(principal, requestId)` が既にあるとき:
- 既存が静的で要求も同じ静的 route → 従来どおり既存 quote を返す
- **それ以外（どちらかが動的、または route／URL が違う）→ `request_id_conflict`**。
  動的 quote は**冪等な再取得をしない**（返すには持ち主の証明が要るが、再取得する側はまだ `ownerKey` を受け取っていない）。
  応答を取り損ねた呼び出し側は新しい `requestId` で取り直す。未払いの quote は何も消費しない（§6）

他人の `requestId` を先に使って衝突させる嫌がらせは可能だが、相手は別の ID で取り直せる（§10 に記録）。

## 3. 送信レール（port の拡張、FR-8・FR-18・FR-24・FR-27・FR-28）

```ts
interface UpstreamTarget { readonly url: string }          // parseUpstreamUrl を通った href
interface OutboundRail {
  readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]>;
  pay(request: PayRequest /* + target?: UpstreamTarget */): Promise<PayResult>;
}
```

- `target` が**無い**呼び出しは現行と同じ（起動時 Map の URL、クエリ拒否、fixture の loopback 規則）
- `target` が**ある**呼び出しは、adapter 生成時に渡した **`dynamic` オプション**（プロファイル、動的用 transport、上限）を使う。
  `dynamic` を持たない adapter に `target` を渡したら例外（fail closed）
- core は、動的 intent については**常に** `intent.upstream.url` を `target` に渡す。静的 intent には渡さない

### 3.1 動的用 transport（FR-24・AC-12）

`composeRails` は動的用に**別の transport インスタンス**を作る: `transportFor(false, report)`。
署名能力が `non-signing-fixture` でも、`fixtureFacilitators` があっても、**動的用は loopback を許さない**。

**要件との差分（明示）**: 無課金の成立試験（AC-2）には loopback の上流 fixture が要る。そのため
**コードからしか渡せない能力 `capabilities.fixtureDynamicUpstreams: true`** を 1 つ足し、これがあるときだけ動的用 transport が
loopback を許す。渡すのは `tests/fixtures/*` の起動スクリプトだけで、`tools/remote-mcp.ts` を含む本番の入口は渡さない
（env・設定・呼び出し側の入力からは作れない。既存の `fixtureFacilitators` と同じ型の扱い。`src/main.ts:59-69`）。
AC-12 の「fixture 能力の Router でも loopback に届かない」は「**この専用能力を持たない限り**届かない」と読み替え、
静的検査（本番の入口がこの能力名を参照しない）を試験に加える。

### 3.2 一致の定義（FR-8・AC-6）

purchase 時の読み直しで比較するのは**保存した `DestinationOffer` の全体**（既存の `stableJson` 一致）。その中身は:

| レール | 含む | 含まない（毎回変わってよい） |
|---|---|---|
| x402 | `scheme`・`network`・`asset`・`amount`・`payTo`・`maxTimeoutSeconds`・`extra`（`name`・`version`） | 402 の本文、`resource` の記述、`error` |
| mpp | `scheme`（`tempo/charge`）・`network`・`asset`・`amount`・`payTo`・`extra.realm`・`extra.terms`（`request` と `meta` の全文） | challenge の `id`・`expires`（`src/adapters/outbound/mpp.ts:120-145` の既存の射影のとおり） |

### 3.3 支払い操作の範囲（FR-18・U-3・AC-16）

**判断の基準は設定（プロファイル）で、上流の offer ではない。** 範囲外の offer は quote の時点で候補から外し（`no_matching_offer`）、
purchase 時には署名・送金の直前にもう一度、**実際に署名／送信しようとしているもの**を検査する。

**x402 送信（EIP-3009 `exact`）**

| 段 | 検査 |
|---|---|
| offer（quote 時・読み直し時） | トップレベルのキーは `scheme・network・asset・amount・payTo・maxTimeoutSeconds・extra` のみ。`extra` のキーは `name・version` のみで**プロファイルの `tokenDomain` と一致**。`scheme === "exact"`。`network`・`asset` はプロファイルと一致。`amount` は 10 進正整数で `maxUpstreamAmount` 以下。`payTo` は EVM アドレスで、ゼロ・運用者自身・token コントラクトでない。`maxTimeoutSeconds` は 1〜600 |
| 署名直前（既存の `guardedSigner` に追加。`x402.ts:399-424`） | 既存: `primaryType`・`chainId`・`verifyingContract`・`to`・`from`・`value`。**追加**: `domain.name`／`version` がプロファイルと一致、`domain` に余分なキーが無い、`types.TransferWithAuthorization` が EIP-3009 の 6 欄と**完全一致**、`validAfter <= now`、`validBefore <= now + 600 + 60`、`nonce` が 32 バイト |

**MPP 送信（Tempo charge・push）**

| 段 | 検査 |
|---|---|
| challenge（quote 時・読み直し時） | `method === "tempo"`・`intent === "charge"`。`request` のキーは `amount・currency・recipient・methodDetails`（＋ SDK が必ず付ける既知の欄。実装時に実 challenge から列挙して固定し、**未知のキーは拒否**）。`methodDetails` のキーは `chainId・supportedModes・memo` のみ（**`splits`・`feePayer`・`machineTokenEnabled` は拒否**）。`amount > 0`（0 は送金ではなく proof 署名になる。`mppx/dist/tempo/client/Charge.js:80-97`）。`supportedModes` が無いか `push` を含む。`currency`・`chainId` はプロファイルと一致 |
| 能力 | 動的プロファイルが使う MPP 能力は `mode: "push"` を明示していること。無ければ**起動失敗**（`pull` が SDK に選ばれる余地を残さない。要件 §4 の未検証経路） |
| 送信直前（既存の送金 RPC guard に追加。`mpp.ts:307-321`） | 通すメソッドは **`eth_sendRawTransactionSync`／`eth_sendRawTransaction` のみ**（他の送金系は拒否）。raw を `ox/tempo` の `TxEnvelopeTempo.deserialize` で復号し: 型 `0x76`、`chainId` 一致、**call はちょうど 1 つ**、`to === プロファイルの asset`、`value === 0`、`data` は `transferWithMemo(recipient, amount, memo)` か `transfer(recipient, amount)` で **`recipient`・`amount` が保存した offer と一致**、`feeToken` は未指定か `feeAsset`、`feePayerSignature`・`authorizationList`・`keyAuthorization` が無い、`validBefore <= now + 60`、**`gas × maxFeePerGas` から求めた手数料の上限が `maxFee` 以下** |

**実測（`tools/dyn-mpp-tx-decode-probe.ts`、本書と同じ commit）**: `ox/tempo` で署名済みの Tempo transaction を組み、
復号して上の全欄（`calls`・`to`・関数名と引数・`feeToken`・`gas`・`maxFeePerGas`・`validBefore`・`feePayerSignature`）を
取り出せることを確認した。**まだ示していないこと**: (a) SDK が実際に guard へ渡す raw がこの形であること
(b) `gas × maxFeePerGas` を `feeAsset` の base units に直す換算。どちらも実装の最初のタスクで fixture と testnet の実 tx から確かめ、
換算が決まるまで `maxFee` の検査は「上限を満たさなければ拒否」ではなく**機能自体を有効にしない**（M-1・M-2、§11）。

### 3.4 上流から受け取るものの上限（FR-27・FR-28・U-8）

| 対象 | 上限 | 超過時 |
|---|---|---|
| 応答ヘッダ全体 | undici の既定（16 KiB）を明示して固定 | transport の失敗（未払い） |
| 402 の本文 | 64 KiB | 読み切らずに中断、quote 不成立／`destination_challenge_unreadable` |
| `accepts`／challenge の個数 | 16 | 同上 |
| 有料応答の本文 | 256 KiB | receipt が整合していれば `paid_no_data`（理由 `response_too_large`）、していなければ `unknown` |

- 実装は **body を上限つきの stream に差し替えた `Response`** を SDK に渡す（SDK の `processResponse` はそのまま使う）。
  receipt はヘッダにあるので、本文を読む前に判定できる
- **対応する応答**: `content-type` が `application/json`（パラメータ可）で、最上位が object か array の JSON。
  それ以外は `paid_no_data`（理由 `unsupported_response`）。x402・MPP で同じ規則にする
  （現状は MPP が object のみ。`mpp.ts:542-558`。**動的経路だけ**揃え、静的は変えない）
- journal に保存する本文は上の 256 KiB が上限（FR-24 相当）

## 4. 受信の束縛（U-2・FR-6・AC-5）

プロファイルの受信 adapter は route のものと同じクラスを使い、**動的プロファイル用の生成時オプション**で次を有効にする。

**x402 受信**: preflight に追加（`src/adapters/inbound/x402.ts:175-218`）。
`payload.authorization` について `nonce === offer.extra.challengeNonce`、`to === offer.payTo`、`value === offer.amount`、
`validBefore <= offer.extra.expiresAt` を要求する。
EIP-3009 の署名は `nonce` を含むので、**ある quote のために作った署名は、`challengeNonce` の違う別の quote では preflight を通らない**。
`challengeNonce` は quote ごとの乱数 32 バイト（`:146`）。同じ署名の二重使用は token コントラクトの nonce が止める。
呼び出し側の署名ツールは既にこの形で署名している（`tools/x402-payer.ts:56-57`）ので、手順は変わらない。
**静的 route の preflight は変えない**（標準クライアントの乱数 nonce を受け付ける現状を保つ）。

**MPP 受信**: 変更なし。challenge の `id` は額・受取先・期限・quote ごとの乱数（`meta`）を含む HMAC で
（`src/adapters/inbound/mpp.ts:232-256`）、支払い側の送金は memo でその `id` に束縛される。
別の quote の challenge には使えないことを、**実 SDK の検証経路**で試験する（AC-5。常に成功する stub は使わない）。
SDK の replay ストアがプロセス内である点（`:109-114`）は、Router 側の at-most-once（quote の直列化と intent の状態）で補う現状のまま。

**額**: 受信額は `upstreamAmount`（decimals 換算）＋手数料で、quote ごとに違う。受信 adapter の `createOffer` は元々
`request.amount` を使う（`x402.ts:153`、`mpp.ts:243`）ので、core が計算した額を渡すだけでよい。
core の照合（`orchestrator.ts:329-339`）は「設定の額」ではなく「**計算した額**」と比べる分岐を動的用に足す。

## 5. 持ち主の分離（U-7・FR-32・AC-20）

- 動的 quote の発行時に `ownerKey`（乱数 32 バイト、base64url）を作り、**`sha256(ownerKey)` だけ**を記録に保存する
- `ownerKey` は quote の応答に 1 度だけ載る（quote 文書の一部）。以後 Router はどの応答にも載せない
- 動的 intent に対する `purchase`・`status`・`offerFor` は、渡された `ownerKey` のハッシュが一致するときだけ応じる
  （`timingSafeEqual`）。一致しないときは**存在しない場合と同じ応答**（`unknown_quote`／404）
- 運び方: HTTP はヘッダ `x-router-owner-key`。MCP の purchase は、**既に持ち回っている quote 文書**の中の `ownerKey` を読んでヘッダに載せる
  （呼び出し側の手順は増えない）。MCP の status に省略可能な引数 `ownerKey` を足す
- 再起動後も記録から検証できる。静的 intent は従来どおり principal の一致だけ（FR-1）

## 6. quote の控えと予算（FR-21・FR-22・FR-33・U-5）

### 6.1 quote 控え

未払いの動的 quote は journal に書かず、**quote 控え**（`<journal の directory>/dynamic-quotes/<UTC 日付>.ndjson`）に append＋fsync する。

- 書き手は Router プロセスだけ（journal と同じ単一プロセス）。メモリには**期限内の quote だけ**を持つ
- 起動時は当日と前日のファイルから期限内のものだけを読む。**2 日より古いファイルは起動時と日付の切り替わりに削除**する
- 期限内の未払い quote の数に上限（§8）。超えたら**上流に接続する前に** `dynamic_capacity` で拒否する
- 控えは「まだ何も起きていない quote」だけを持つので、失っても資金は動かない。**MPP 受信で、呼び出し側が支払った後に quote が
  期限切れになる**と資金は戻らないが、これは控えの有無と無関係で、静的 route でも同じ（要件 §7）

### 6.2 昇格

動的 purchase の順序（静的との違いは 4 の位置だけ）:

```
1. ownerKey・requestId・approval・指紋・期限・preflight     … 何も書かない
2. 上流を読み直して保存済み offer と照合                     … 何も書かない
3. 受信 verify                                              … 何も書かない
4. journal に created（控えの記録の写し）と source_pending を書く
5. 期限の再検査 → 予算予約 → 受信 settle → 以降は静的と同じ
```

- 3 までで終わる試行（無効な署名、上流の変更、verify 不能）は **journal にも予算にも何も残さない**。同じ quote で再試行できる
  （x402 では資金は動いていない。MPP では呼び出し側の送金は済んでいるので、再試行できることが呼び出し側の利益になる）
- 4 の後は静的と同じ規則: 中断は再起動で `unknown`、取った予約は解放しない
- quote ごとの直列化（`withKey`）は控えの段階から効かせる。昇格済みの quote は控えから引かず、journal の intent を使う

### 6.3 予算の 4 分類（FR-21・U-5）

| 分類 | 何が残るか | 予算 |
|---|---|---|
| (1) 発行しただけの quote | 控えのみ | 消費しない |
| (2) 受信が成立しなかったと確定した試行 | 何も残らない（昇格前） | 消費しない |
| (3) 結果が不明な試行 | journal（`unknown`） | 予約を保持 |
| (4) 受信が成立した購入 | journal | 予約を保持 |

**「確定」の定義**: **受信 verify が成立しなかった**こと（署名無効・残高不足・形の誤り）。x402・MPP とも verify は資金を動かさず、
replay の記録も取らない（1 回目の修正のレビューで SDK を確認済み）。
**verify が通った後に settle が拒否された場合は「確定」に含めない**: x402 の facilitator が `success: false` を返しても、
送信済みの transaction が後で成立する可能性を Router は否定できない（`src/adapters/inbound/x402.ts:242-253`）。
この場合の予約は保持する（(3) と同じ扱い）。攻撃に使うには、資金のある口座の有効な署名を用意したうえで settle だけを失敗させる必要があり、
1 回につき動的側の 1 件分の枠しか減らない。**解放の仕組み（EIP-3009 の `authorizationState` を期限後に読む等）は本スライスに入れない**（§10）。

### 6.4 動的側の予算（FR-19・FR-22）

- `dynamic.budget` を**別の `Budget` インスタンス**で数える。journal のイベント名は `dyn_budget_reserved`
  （`Budget.load` にイベント名を渡す。静的側は `budget_reserved` だけを数えるので互いに干渉しない。旧実装は未知のイベントを無視する）
- 1 件の予約 = 受信額 ＋ 送信元本 ＋ **そのプロファイルの `maxFee`（`feeAsset` のバケット）**。
  MPP 送信では §3.3 の送信直前の検査が実際の手数料上限を `maxFee` 以下に強制し、送金は 1 支払い 1 回なので、
  **動的購入による送信側の支出は `dynamic.budget` の通算上限を超えない**。x402 送信は facilitator がガスを払うので `maxFee` は 0
- 動的側が尽きると動的 quote／purchase は `bucket_limit` 等で明示的に失敗し、静的 route は影響を受けない
- 運用: 動的用の送信ウォレットを分けるかは運用者の選択とし、**分けない場合の最大損失は `dynamic.budget` の通算上限**と `DEPLOY.md` に書く

### 6.5 受信額と手数料（FR-15・FR-17・U-3・U-4）

```
converted = upstreamAmount × 10^(source.decimals − destination.decimals)   // 割り切れなければ拒否
fee       = max(fee.min, fee.flat + ceil(converted × fee.bps / 10000))
total     = converted + fee                                                // 受信資産の base units。BigInt
```

- `upstreamAmount > maxUpstreamAmount`、`total` が受信側の 1 件上限を超える、のいずれも quote 不成立
- **手数料の値は owner が決める。** 決める前に MPP 送信の実手数料を測る（M-1）。testnet の初期値の案は測定後に提示する

### 6.6 残高の事前確認（FR-20・U-7）

送信能力に省略可能な `balanceOf(asset)` を足す（MPP は既存の client で読める。x402 は Base Sepolia の RPC を設定した場合だけ）。
あるときは、動的 purchase の手順 2 で「元本＋`maxFee`」に足りなければ `operator_funds_unavailable` で止める（何も書かない）。
無いときは検査しない。**検査と送信の間に残高が変わる競合は残る**（予算の通算上限が実質の歯止め）。

## 7. 匿名利用への対策（FR-25・FR-26・FR-30・FR-31・U-6）

### 7.1 入口（`tools/remote-mcp.ts`）

- 要求本文は **64 KiB**、受信の期限は **10 秒**。超過は MCP の処理に入る前に切る（現状は全部読む。`:271-275`）
- **送信元ごと**の上限: 60 要求／分。送信元は Caddy が付ける `X-Forwarded-For` の**最後の値**
  （Router は `127.0.0.1` にしか公開していないので、届く要求は必ず Caddy 経由。`DEPLOY.md` §6）。
  ヘッダが無い要求は 1 つの送信元として数える
- これは静的 route の呼び出しにも効く（静的の入出力は変えないが、**過剰な呼び出しは 429 になる**。FR-35 の例外として明記）

### 7.2 動的の門（core 内、`DynamicGate`）

quote と purchase 試行の両方が通る。**外部接続の前**に判定する。

| 対象 | 上限（初期値） |
|---|---|
| 動的 quote の全体頻度 | 30／分 |
| 動的 purchase 試行の全体頻度 | 30／分 |
| 同時に進行中の動的な上流接続 | 8 |
| 期限内の未払い quote | 500 |
| 宛先ホスト名ごと | 10／分 |
| 宛先アドレスごと（解決後） | 60／分 |

- **アドレス単位**の判定のため、guarded transport に「検査済みアドレスが決まった後・接続の前」に呼ばれる `admit` フックを足す
  （`src/net/guarded-fetch.ts` の `vet` の直後）。別名を増やしても同じアドレスなら同じ枠を使う。
  CDN の共有アドレスで別の Provider が同じ枠に入るので、ホスト名単位より緩くしてある
- 状態はプロセス内で、再起動で消える（再起動は呼び出し側が起こせない）
- facilitator・RPC への通信は要求ごとに別の接続で、門の同時実行数の外にある（動的の負荷で待たされない）

### 7.3 自分自身と依存先（FR-25・AC-13）

`parseUpstreamUrl` はホスト名が次に**一致するかそのサブドメイン**なら拒否する: `canonicalBaseUrl` のホスト、`dynamic.denyHosts`
（本番は `router.subethalabs.com` を入れる）、設定済みの facilitator と RPC の URL のホスト（起動時に設定から集める）。
別名で同じサーバを指しても、`https` のみ・証明書検証ありなので TLS で失敗する。Router 自身の公開アドレスへの直接接続は B が落とす。
**運用者の静的 Provider は拒否しない**（動的に指定してよい。7.2 の宛先単位の上限が容量を守る）。

## 8. 表示と結果（FR-9〜12・FR-29・U-9）

**quote の応答（動的）**: 既存の欄に加えて

```
upstream:    { url, method: "GET" }
destination: { ..., payTo }
pricing:     { upstreamAmount, fee, total, sourceDecimals, destinationDecimals }
disclosures: { destinationVerifiedByOperator: false, refundOnFailure: false,
               fundsMayMoveBeforeRouterAccepts: <offer の fundsMoveOnCredential>,
               unsupportedResponseIsPaidWithoutData: true }
ownerKey
```

すべて §2.3 の記録から組む（FR-11）。MCP の `subject` はこれらを**そのまま**含め、`nextStep` に同じ内容を文でも書く。

**結果（動的）**: MCP は上流の本文を
`{ untrusted: true, source: "upstream", contentType, body }` に包み、`delivered` の意味を
`proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" }` として添える。静的 route の結果の形は変えない。

**ログ**: 運用者向けの stderr には、動的 quote／purchase ごとに `profileId`・**ホスト名のみ**・結果コードを出す
（パスとクエリは出さない。乱用の調査はホスト名と時刻で控え／journal を引く）。transport の診断は従来どおり URL を出さない。

## 9. 回帰と旧実装（FR-35）

- `dynamic.enabled: false` の Router（**同じ実装**）: 動的 quote は外部接続なしに拒否。journal の動的 intent は読めるが purchase は
  `quote_changed`、status は `ownerKey` が要る。`dyn_budget_reserved` は数え続ける
- **この機能より前のイメージに戻した場合**: 動的 intent は「設定に無い route」として purchase できない。予算は静的側だけ数える。
  ただし **`ownerKey` の検査は無い**ので、`paymentId`（UUID）を知る相手は動的購入の結果を読める。
  FR-35 が求めるのは「無効にした Router」での分離であり、旧イメージへの巻き戻しは対象外として §10 に記録する

## 10. 受容する制約（要件 §7 への追加）

| 制約 | 理由 |
|---|---|
| verify 成立後に settle が拒否された試行は動的側の予約を保持する | 「未成立の確定」を facilitator の応答だけでは言えない（§6.3） |
| 動的 quote は冪等に再取得できない。他人の `requestId` を先取りする嫌がらせが可能 | 持ち主の証明なしに既存 quote を返さないため（§2.4） |
| 上流が `resource` を fetch URL と 1 バイトでも違う形で申告すると使えない。標準外の欄を足す Provider も使えない | 束縛と署名範囲を緩めないため。**実在の第三者 Provider でどの程度通るかは未計測**（M-4） |
| MPP の第三者 Provider は、既存の Provider B が使う scope（`_mppx_scope`）を持たない | 動的経路では scope を**あれば照合・無ければ不問**にする。challenge はその URL への TLS 接続の応答として得たものなので、Router にとっての束縛は接続先。**静的は従来どおり必須** |
| 旧イメージへの巻き戻しで動的購入の結果が `paymentId` で読める | §9 |
| 静的 route の無効な purchase 試行は従来どおり journal に行を残す | 本スライスは静的の記録順を変えない。入口の頻度制限（§7.1）で抑える |

## 11. 実装の前に測るもの

| ID | 内容 | 使い道 |
|---|---|---|
| M-1 | MPP 送信の実手数料（既存の送信 tx の receipt）と、`gas × maxFeePerGas` から `feeAsset` の額への換算 | `maxFee`・手数料規則の値、§3.3 の検査 |
| M-2 | SDK が push・local account で送金 RPC に渡す実際の raw（fixture と testnet） | §3.3 の復号が実物に効くこと |
| M-3 | 実 challenge（Provider B と、公開されている第三者の MPP／x402 エンドポイント数件）の欄の一覧 | §3.3 の許可キー、M-4 |
| M-4 | 第三者 Provider での quote 成立率（未払いの読取のみ） | §10 の互換性の制約が実用に耐えるか |

M-1〜M-3 は無課金（読取のみ）。結果で §3.3 の表が変わる場合は本書を改訂してから実装する。

## 12. 試験計画（AC との対応）

| AC | 層 | 要点 |
|---|---|---|
| 1・11・13 | unit | `parseUpstreamUrl` と無効時の拒否。**接続数 0** を fixture の接続カウンタで確かめる |
| 2 | wire | `fixtureDynamicUpstreams` を持つ Router＋上流 fixture（x402・MPP）で両方向 |
| 3・24 | unit／wire | 応答の全欄を記録と突き合わせる |
| 4・7・10・22 | unit | 改竄した quote 文書、`requestId` 衝突、設定変更、無効化後の再生 |
| 5 | unit＋wire | **実際の検証経路**: オフライン署名した EIP-3009（facilitator fixture が署名と nonce を検証）と、実 mppx の検証＋RPC fixture。同額・静的↔動的・並行・再起動後 |
| 6 | wire | 表 §3.2 の各欄を 1 つずつ変える。`id`／`expires` だけの変化では成立 |
| 8・9 | unit | offer の選択、換算、手数料の丸め |
| 12 | wire | 既存の T-A 系 fixture（公開名が内部に解決する DNS）を動的の 3 接続点＋SDK の RPC に当てる。専用能力なしでは loopback に届かない。本番の入口が `fixtureDynamicUpstreams` を参照しない静的検査 |
| 14・15 | wire | リダイレクト、期限、各上限、text／array／偽 receipt |
| 16 | unit＋wire | 範囲外の offer／challenge と、**範囲内に見える offer から範囲外の署名／transaction を作らせる fixture SDK 差し替え**。署名器・送金 RPC の呼び出しが 0 |
| 17 | unit＋wire | 門と入口の各上限。別名 2 つ→同じアドレスで枠を共有 |
| 18・19 | unit | 無効な credential の反復で両方の予算が減らない。動的側を使い切っても静的が成立 |
| 20 | unit＋wire | `quoteId`・`requestId`・`paymentId` を知っていても `ownerKey` 無しでは取得・購入・参照できない。再起動後も |
| 21 | unit | 控えの上限、期限切れの除去、古いファイルの削除、起動時の読込量 |
| 23 | 全体 | 既存テスト（skip と失敗を区別） |

各 fixture の試験は**守っているコードを外して落ちること**を確かめる。

## 13. 変更するファイル（見込み）

`src/config.ts`（dynamic の型と検証・指紋）、`src/net/upstream-url.ts`（新規）、`src/net/guarded-fetch.ts`（`admit` フック）、
`src/ports/outbound.ts`、`src/adapters/outbound/{x402,mpp}.ts`（動的経路・範囲の検査・上限つき応答）、
`src/adapters/inbound/x402.ts`（nonce 束縛のオプション）、`src/core/{orchestrator,store,intent,budget}.ts`、
`src/core/quote-ledger.ts`（新規・控え）、`src/core/dynamic-gate.ts`（新規）、`src/http/{app,projection}.ts`、
`src/client/*`、`src/mcp/{server,tools}.ts`、`src/main.ts`、`tools/remote-mcp.ts`（入口の上限・プロファイル設定）、
`tools/sign-payment.ts`（変更不要の見込み。確認する）、`docs/DEPLOY.md`・`CLAUDE.md`・`README.md`（手順）。

## 14. 本書で決めていないこと

手数料・各上限の最終値（owner）、M-1〜M-4 の結果、タスク分割、testnet の実決済 gate の範囲。
