# U-01r 要件: SubEtha 受信レグを実 facilitator に接続する

> 対象は設計 §12 の U-01r（「SubEtha facilitator の実 URL・実資産/チェーン、settle 再呼び出しが
> 安全な条件」）。adapter とその配線は既に存在する。本書は**未接続を接続に変える**ための要件だけを扱う。

## 1. 現状（実装済みとして確認した範囲）

| 要素 | 所在 | 状態 |
|---|---|---|
| adapter | `src/adapters/inbound/subetha.ts` | 4 メソッド実装済み。preflight は nonce・失効・route 束縛・`stableJson` 完全一致を journal 生成前に検査 |
| real 配線 | `src/main.ts:206` | `createSubethaInbound({ facilitatorUrl: real.subethaFacilitatorUrl })` |
| 既定レール | `src/main.ts:110`, `src/http/projection.ts:49` | `sourceRail` 未指定は `"subetha"` |
| 設定検証 | `src/config.ts:419-421` | `ROUTER_SUBETHA_FACILITATOR_URL` は `ROUTER_ADAPTER_MODE=real` で必須 |
| テスト | `tests/wire/subetha-inbound.test.ts`, `tests/wire/subetha-inbound-e2e.test.ts` | 相手は**リポジトリ内の合成 fixture のみ** |

つまり**コードの穴ではなく、実行時の値と権限の穴**である。adapter の docstring 自身が
「相手はリポジトリ内の合成 facilitator fixture（loopback）だけ」と明記している。

## 2. U-01r を 3 つに分解する

U-01r は 1 個の未解決事項として書かれているが、**解決の主体が違う 3 要素**が混ざっている。
混ぜたまま進めると、owner 判断待ちの要素が設計可能な要素を人質に取る。

| # | 要素 | 解決の主体 | 支払い権限 |
|---|---|---|---|
| U-01r-a | settle 再呼び出しが安全な条件 | 設計（本リポジトリ内で決定可能） | 不要 |
| U-01r-b | 実 facilitator の URL | owner（実行時の値） | 不要（接続のみ） |
| U-01r-c | 実資産・実チェーン、および実決済の範囲 | owner（AGENTS.md が留保） | **必要** |

本スライスは **U-01r-a を完結させ、U-01r-b/c は owner 入力欄として空けたまま残す**。
AGENTS.md の「No ... signing or transaction broadcasting is authorized by local development/commit
permission. Record concrete testnet payment scope before live payment.」により、
U-01r-c は本書の承認だけでは解除されない。

## 3. U-01r-a の要件（本スライスの実装対象）

### 3.1 何が問題か

現状 `unknown` は**終端**である。`src/core/orchestrator.ts:547-557` は例外・タイムアウト・
`phase:"pending"`・証跡のない `settled` を一律 `unknown` にし、送信レグを開始せず自動再 settle もしない。

これは**正しい既定**である（盲目的な再試行が二重支払いの原因）。しかし実 facilitator では
`unknown` の一部は「まだ確定していない」であり、永久に未確定のまま放置する設計にはなっていない。
必要なのは自動リトライではなく、**人間の判断で 1 回だけ再照会できる経路**である。

### 3.2 要件

- **FR-a1 再照会は状態を読むだけ**: 再呼び出しは `settle` ではなく**照会**でなければならない。
  同一 `challengeNonce` に対する結果の読み出しであり、新たな課金を起こさない。
- **FR-a2 `unknown` からの遷移は単調**: `unknown` → `source_settled` または
  `unknown` → `source_failed` のみ。確定済みの終端から `unknown` に戻らない。
- **FR-a3 自動実行しない**: 再照会は明示的な操作でのみ起きる。タイマー・起動時スキャン・
  purchase 経路からの自動発火はいずれも作らない。
- **FR-a4 二重支払いを作らない**: 再照会で `settled` が判明した場合、送信レグは
  **既存の write-ahead 予約と at-most-once 判定を経由**する。journal を迂回した送出をしない。
- **FR-a5 判明しないことを許容する**: 照会が不確定を返した場合、`unknown` のまま留まる。
  「たぶん成功」を `settled` に丸めない。
- **FR-a6 facilitator 側の保証が前提**: 上記が成り立つのは facilitator が
  `challengeNonce` 単位で結果を冪等に読み出せる場合のみ。**その API の実在は未確認**であり、
  無いなら再照会は実装せず `unknown` 終端を維持する（推測した endpoint を叩かない）。

### 3.3 やらないこと

- 自動リトライ、指数バックオフ、起動時の未確定スキャン
- `settle` の再 POST（FR-a1 に反する。課金の可能性がある）
- facilitator の照会 API を**推測して**実装すること（FR-a6）

## 4. U-01r-b/c の要件（owner 入力待ち）

以下は本書では埋めない。埋めるのは owner である。

| 欄 | 必要な値 | 現状 |
|---|---|---|
| facilitator base URL | `ROUTER_SUBETHA_FACILITATOR_URL` に入れる絶対 URL | **未確定** |
| 結果照会 API | 上記 facilitator が `challengeNonce` で結果を引けるか、その path と応答形 | **未確認**（FR-a6 の前提） |
| 実資産 | `token`（ERC-20 アドレス）と decimals | **未確定** |
| 実チェーン | `chainId` | **未確定** |
| 支払い範囲 | testnet か、上限額、回数 | **未記録**（AGENTS.md が要求） |

**推測して設定に入れない。** 未確定は未確定として残す（P5 設計 §3「やらないこと」と同じ方針）。

## 5. 受け入れ条件

| ID | 条件 | ゲート |
|---|---|---|
| AC-a1 | facilitator の結果照会 API の実在が**ソースまたは owner の回答で確定**している | FR-a6 の前提。未確定なら以降を実装しない |
| AC-a2 | `unknown` から明示操作で照会し、`settled` 判明時に送信レグが at-most-once 経由で 1 回だけ走る | wire テスト（合成 facilitator、無課金） |
| AC-a3 | 照会が不確定なら `unknown` のまま。再照会を何回繰り返しても送出は増えない | wire テスト（無課金） |
| AC-a4 | 確定済み終端に対する照会が状態を変えない | wire テスト（無課金） |
| AC-a5 | 実 facilitator への接続が成立し、challenge を 1 件取得できる | **U-01r-b 解決後**。無課金 |
| AC-a6 | 実決済 1 件が `delivered` に到達 | **U-01r-c 解決後**。owner の支払い権限が必要 |

AC-a5 / AC-a6 は本スライスの完了条件に**含めない**。含めると owner 待ちで完了しなくなる。

## 6. 検証方法

- 合成 facilitator fixture を**不確定応答を返せるよう**拡張し、AC-a2/a3/a4 を無課金で固定する
- CLAUDE.md の「product tests after implementation under the exact task permissions」に従い、
  `npm test` を実際に実行する。docs の整合確認はテストではない
- MEMORY.md の「Verify green tests by sabotage」に従い、**新規テストが本当に守っているかを
  意図的な破壊で確認**する（照会経路を壊してテストが落ちることを見る）

## 7. 本書で解除していないゲート

実決済（AC-a6）、鍵・署名・broadcast（AGENTS.md B-01）、remote/push（B-04）はいずれも未解除。
U-01r-b/c は pending であり、U-01r-a の進行を止めない。

## 8. 本書の検証状況

### 自己検証（実施済み）

§1 の表に挙げた file:line は全て実際の内容と照合した:
`src/main.ts:110`（`?? "subetha"`）、`src/main.ts:206`（`createSubethaInbound`）、
`src/http/projection.ts:49`（`rail: route.sourceRail ?? "subetha"`）、
`src/config.ts:419-421`（`ROUTER_SUBETHA_FACILITATOR_URL` 必須）はいずれも記述どおり。

FR-a6 の前提を **Router リポジトリ内**で確認した時点の結果:
- `src/adapters/inbound/subetha.ts` が叩く path は `/challenge`・`/verify`・`/settle` の **3 本のみ**
- 合成 fixture `tests/fixtures/facilitator-server.ts` が serve する path も **同じ 3 本のみ**
- 設計 §4.1（`docs/design.md:110-125`）が既読ソースから確定させた wire 契約も **同じ 3 本**

**訂正（owner の指摘により実 facilitator 実装を確認）**: 上記は Router リポジトリ内の話であり、
「照会 API が存在しない」という結論は**誤りだった**。実 facilitator の実装を読んだ結果を §9 に記す。

### 独立レビュー（**この節は §10 / §12 により解消済み**）

> **追記 2026-09-29**: 以下は §9 執筆時点の状況である。その後 Codex が利用可能になり、
> **要件レビュー（§10）と実装レビュー（§12）の 2 本を実施した**。本書は独立レビュー済みである。
> 経緯を残すため当時の記録は削除しない。

当時の制約: `codex-cli 0.157.1` + 当該 ChatGPT アカウントで以下が全て拒否された
（`gpt-5.2-codex` / `gpt-5.1-codex` / `gpt-5.6` / `gpt-5.6-codex` / `gpt-5-codex` /
`gpt-5.3-codex` → `"not supported when using Codex with a ChatGPT account"`）。
`~/.codex/config.toml` の既定 `gpt-6-astra` も一時的に
`"requires a newer version of Codex"` を返していた。

**レビュー基準モデルの確定**: GPT-5.6 は当該アカウントで利用できないため、
owner 判断で **`gpt-6-astra`** を本プロジェクトのレビュー基準モデルとする（2026-09-29 承認）。
**MCP 経由では拒否されるため、CLI（`codex exec --sandbox read-only`）で実行する。**

## 9. 実 facilitator 実装からの確定（owner 指摘に基づく調査）

出典: `~/.worktrees/subetha/live-testnet-e2e`（branch `subetha/live-testnet-e2e`）。
**読み取りのみ。コードは複製せず、当該ワークツリーは編集していない**（AGENTS.md の PoC 保護）。

### 9.1 実チェーン・実資産（U-01r-c の値が実在した）

`config/testnet.env.example`（秘密を含まない例ファイル）より:

| 項目 | 値 |
|---|---|
| 支払いチェーン | Sepolia（`ZERC20_CHAIN_ID=11155111`） |
| zERC20 token | `0xADAb5CaB352fb1eBF24CD951de224f9e952C82Ed` |
| Verifier | `0xD19b79cE0C2821158aDBDEf9cC8c8D858c9ef0Cc` |
| Hub | `0xD18b503B335656C05dC516366C0C8FD6e3b13856` |
| Hub チェーン | **Base Sepolia**（`ZERC20_HUB_CHAIN_ID=84532`） |

**重要な差異**: owner の記憶は「Base Sepolia で zETH 決済」だったが、実際の構成は
**支払いが Sepolia、Hub が Base Sepolia** の 2 チェーン構成である。Router の
`InboundOffer.network` は 1 つしか持たないため、**どちらを名乗るかは設計判断**として残る
（`/challenge` 応答の `chainId` が権威。§9.2 の通り facilitator が返す）。

### 9.2 実 facilitator の wire 面（`apps/facilitator/src/server.ts`）

Router が知る 3 本に加えて 4 本ある:

| endpoint | 種別 | Router から見た意味 |
|---|---|---|
| `POST /challenge` | 既知 | 変更なし |
| `POST /verify` | 既知 | 変更なし |
| `POST /settle` | 既知 | **二相の第 1 相のみ**（§9.3） |
| `GET /healthz` | 新 | 死活 |
| `GET /supported` | 新 | 対応 scheme の申告 |
| `POST /admin/finalize` | 新 | pending → finalized を駆動（**管理面**） |
| `GET /admin/pending` | 新 | **件数のみ**（`pending` / `finalized` / `failed` / `fees`） |

### 9.3 FR-a6 の判定: **照会 API は無いが、再 settle は安全**（結論が変わる）

**AC-a1 は「照会 API の実在」を条件にしていたが、この条件設定自体が不適切だった。**

- `GET /admin/pending` は `backend.pendingCount()` 等の**集計値**しか返さない
  （`server.ts:235-243`）。`SettlementBackend`（`packages/facilitator/src/backend.ts:135-151`）に
  **nonce 単位の参照メソッドは存在しない**。よって「`challengeNonce` で結果を引く」API は**無い**。
- しかし `/settle` 自体が**再 POST しても新たな課金を起こさない**。理由は
  `CollectInput`（`backend.ts:45-50`）が `{challengeNonce, burnTxHash}` だけを取り、
  **payer が既に broadcast した burn tx の確認**しか行わないからである
  （`backend.ts:140-141`「The payer already broadcast the burn transfer itself」）。
  同じ `burnTxHash` の再確認は同じ結論に収束する。
- `CollectResult`（`backend.ts:85-88`）は 3 値で、意味が明示されている:
  `accepted` / `pending`（**"retryable"** と明記）/ `rejected`（**"not a terminal state"** と明記）。
- finalize 側にも冪等 reconcile がある: `FinalizeResult.mints[].txHash` は
  「burn was found already teleported on-chain」で `null`（`backend.ts:94-96`）、
  `FinalizeStage` に `"reconciled"` がある（`backend.ts:119`）。
  fee sweep も未確定時は**同一 raw tx を再 broadcast**し、新 nonce を作らない（`backend.ts:102-104`）。

**したがって U-01r-a の答えは「照会 API を待つ」ではなく次の通り**:

> gasless permit 経路（`collectPermit`）**ではない** self-transfer 経路
> （`CollectInput = {challengeNonce, burnTxHash}`）において、**同一 `burnTxHash` での `/settle` 再送は
> 追加課金を生じない**。よって `unknown` からの回復は、同一 payload の `/settle` 再送で行える。

### 9.4 ただし permit 経路は別（ここが危険側）

`collectPermit`（`backend.ts:145`, `PermitCollectInput` は `backend.ts:60-74`）では
**facilitator が burn を broadcast する**（`backend.ts:56-58`「the FACILITATOR broadcasts the burn」）。
この経路の再送は、facilitator 側の permit nonce 検証
（`token.nonces(payer)` を broadcast 直前に検証、`backend.ts:68-70`）に依存する。
**self-transfer 経路と同じ安全性を仮定してはならない。**

Router の `InboundOffer.extra` は `helper` / `deadline` を**任意ペア**として運んでおり
（`src/adapters/inbound/subetha.ts:66-88`）、これは permit 経路の存在を示す。
したがって再送の可否は**offer に `helper` があるか否かで分岐する**必要がある。

### 9.5 要件の改訂

§3.2 を以下に差し替える（FR 番号は維持し、変更点を明示する）:

- **FR-a1 改訂**: 再照会は「照会 API」ではなく**同一 payload の `/settle` 再送**とする。
  ただし **`offer.extra.helper` が無い（self-transfer）場合に限る**。
- **FR-a6 改訂**: 前提は「照会 API の実在」ではなく
  「**self-transfer 経路であること**」。`helper` を伴う offer では再送しない（`unknown` 終端を維持）。
- FR-a2 / FR-a3 / FR-a4 / FR-a5 は**変更なし**（単調遷移・自動実行しない・at-most-once 経由・
  不確定を丸めない）。
- **AC-a1 改訂**: 「照会 API の実在確認」→「**self-transfer と permit を offer から判別できること**」。
  これは `src/adapters/inbound/subetha.ts` の既存フィールドで満たされる（判別可能）。

### 9.6 未確定として残るもの

| 項目 | 状態 |
|---|---|
| facilitator の実 URL | **未確定**（例ファイルは `127.0.0.1:8080/8081` のローカル指定のみ。公開 URL は無い） |
| `InboundOffer.network` に Sepolia / Base Sepolia どちらを名乗るか | **設計判断が必要**（§9.1） |
| 実決済の範囲（上限額・回数） | **未記録**（AGENTS.md が要求） |
| PoC の E2E 記録が本提出物の証拠になるか | **ならない**（AGENTS.md「a feasibility record is not fresh E2E evidence」） |

### 9.7 §5 受け入れ条件への影響

AC-a2 / AC-a3 / AC-a4 は**そのまま有効**（合成 fixture で無課金検証可能）。
これに 1 本追加する:

| ID | 条件 | ゲート |
|---|---|---|
| AC-a7 | `helper` を伴う offer では再送経路に入らず `unknown` を維持する | wire テスト（無課金） |

## 10. 独立レビュー結果: **REJECT**（§9 の中核主張は誤り）

レビュー実施: 2026-09-29、Codex CLI 0.157.1、モデル **`gpt-6-astra`**（自己申告 "GPT-6"）、
`--sandbox read-only`。GPT-5.6 は当該 ChatGPT アカウントで利用できないため
（`"not supported when using Codex with a ChatGPT account"`）、
**owner 判断により `gpt-6-astra` を本プロジェクトのレビュー基準モデルとする**（2026-09-29 承認）。
なお MCP 経由ではこのモデルが拒否されるため、**CLI（`codex exec`）で実行する**。

### 10.1 却下された主張と、その検証

§9.3 は「self-transfer なら同一 payload の `/settle` 再送で `unknown` から回復できる」と結論したが、
**これは誤り**。レビューの指摘を実ソースで確認した:

`packages/zerc20-backend/src/index.ts:1310-1313`（本メモが §9 執筆時に**読んでいなかった**ファイル）:

```ts
const rec = this.challenges.get(input.challengeNonce);
if (!rec) return { status: "rejected", reason: "unknown or already-used challenge" };
if (rec.state !== "open") {
  return { status: "rejected", reason: `challenge not open (state=${rec.state})` };
}
```

成功時は `index.ts:1838` で `rec.state = "accepted"` になる。したがって:

1. 1 回目の `/settle` が**成功**する（burn は確定、課金は済んでいる）
2. 応答が失われ、Router は `unknown` を記録する
3. 同一 payload で再送すると `rec.state === "accepted"` なので
   **`rejected`（"challenge not open (state=accepted)"）が返る**

**「新たな課金が起きない」ことと「元の結果を回復できる」ことを同一視したのが誤りだった。**
再送は課金を増やさないが、**成功した支払いを失敗と誤認させる**。

### 10.2 なぜこれが危険か（Router 側の実コードで確認）

`src/adapters/inbound/subetha.ts:239-240` は `success:false` を `rejected` に落とし、
`src/core/orchestrator.ts:530-538` はそれを**終端 `source_failed`** として journal に書き、
呼び出し側には `awaiting_payment` を返す。

つまり §9 の設計を実装すると、**支払い済みの購入が「未払い」として提示され、
利用者に 2 回目の支払いを促す**。これは本プロジェクトが最も避けるべき二重支払いの経路であり、
`unknown` 終端を維持する現状より**明確に悪い**。

加えて `pending` も危険側に落ちる: `apps/facilitator/src/server.ts:121` は
pending を `success:false` + `errorReason:"pending_burn"` で返し、
**adapter が `unknown` と判定する `extra.phase:"pending"` を含まない**。
現状の adapter はこれを `rejected` と誤読する（これは §9 とは独立した**既存の欠陥**）。

### 10.3 その他の確定した誤り

| # | §9 の記述 | 実際 |
|---|---|---|
| 1 | permit 経路は facilitator が broadcast するので二重課金しうる | **根拠不足**。`index.ts:1367-1378` が `permitBurnTxHash` を再利用し、`1440-1474` が喪失応答を `usedBurnAuth` で reconcile、`contracts/src/PermitBurner.sol:112-126` に on-chain replay guard がある。permit を除外するのは保守的方針として妥当だが、「replay 保護が無いから」ではない |
| 2 | `offer.extra.helper` の有無で経路を判別できる | **不可**。`index.ts:733-740` は helper が**設定されていれば常に** offer に載せ、`server.ts:197-216` は**credential payload** で経路を分岐する。helper 付き offer でも payer は self-transfer を選べる。判別は payload 側で行う必要がある |
| 3 | `network` に Sepolia / Base Sepolia のどちらを名乗るかは設計判断 | **選択の余地は無い**。`index.ts:724` の `createChallenge` が `this.env.chainId` を返し、adapter は応答から `eip155:${chainId}` を導出する（`subetha.ts:152-161`）。owner 決定の Sepolia は **`eip155:11155111`** を意味し、ローカルで言い換えるものではなく**facilitator 応答が一致していること**が条件 |
| 4 | 例ファイルの `8080/8081` が facilitator のローカル URL | **誤り**。`testnet.env.example:4-5` の当該 2 本は **indexer / decider** の URL。facilitator URL は依然として**未確認** |

### 10.4 未解決として残った設計上の穴（レビュー指摘）

- **回復の payload 束縛が無い**: `orchestrator.ts:470` は `source_pending` を `{}` で journal に書き、
  `core/intent.ts:73-80` は offer と結果 `txRef` を持つが**元の burnTxHash / credential を保存しない**。
  再起動後に「supplied burn hash が元の試行と同一」であることを証明する手段が無い。
- **§3.3 が §9 と矛盾したまま**: line 65 が settle 再 POST を明示的に禁じている。
  §9 は §3.2 を差し替えたが §3.3 を放置した。
- **FR-a2 が失敗の証拠要件を定義していない**: `unknown → source_failed` を許すが、
  何をもって失敗と確定するかが無い。上記 10.1 の通り `rejected` は証拠にならない。

### 10.5 結論: 本スライスでは再送回復を実装しない

`unknown` 終端の維持が正しい。ただし**§9 執筆前の理由（「照会 API が無いから」）とは別の理由**である:

> facilitator は challenge を状態機械として持ち、`accepted` 後の再送に `rejected` を返す。
> よって再送は**結果照会として機能せず、成功を失敗と誤認させる**。
> 安全な回復には facilitator 側に nonce 単位の結果参照が必要で、それは**存在しない**。

§8 line 123 の記述も不正確だった。「照会 API が無い」という観測は正しく、
**誤っていたのは「だから再送で代替できる」という推論**である。

### 10.6 本スライスで実装すべきもの（回復とは独立した実在の欠陥）

§10.2 後段で判明した `pending_burn` の誤読は、U-01r とは独立に**今の実装に存在するバグ**である:

| ID | 内容 |
|---|---|
| AC-b1 | facilitator が `success:false, errorReason:"pending_burn"` を返したとき、adapter は `rejected` ではなく **`unknown`** を返す |
| AC-b2 | HTTP 429（rate limit、`apps/facilitator/src/http.ts:41-44`）は `rejected` ではなく `unknown` |
| AC-b3 | 上記いずれでも送信レグを開始せず、journal は `unknown` 終端 |

これは無課金の wire テストで固定できる。実 facilitator の URL も支払い権限も不要。

## 11. 実装記録（AC-b1〜b3、無課金）

§10.6 の欠陥を修正した。**U-01r-a（再送回復）は実装していない**——§10.5 の通り
`unknown` 終端の維持が正しい結論であり、本節は**それとは独立した既存バグ**の修正である。

### 11.1 変更点

| ファイル | 変更 |
|---|---|
| `src/adapters/inbound/subetha.ts` | `errorReason:"pending_burn"` を `unknown` に分類（従来は `rejected`）。HTTP 429 を `unknown` に分類（従来は `rejected`） |
| `tests/fixtures/facilitator-server.ts` | `--settle pending-burn`（実 facilitator の 200 + `success:false` + `errorReason`）と `--settle rate-limited`（429）を追加 |
| `tests/wire/subetha-inbound.test.ts` | 上記 2 応答が `unknown` になり、settle を 1 回しか呼ばないことを固定 |

既存の `--settle pending`（`extra.phase:"pending"`）モードは**残した**。実 facilitator の
`/settle` はこの形を返さないが、adapter の既存分岐を守るテストなので削らない。

### 11.2 検証（実行済み）

- `npx vitest run tests/wire/subetha-inbound.test.ts` → **16 passed**
- `npm run types`（`tsc --noEmit`）→ エラーなし
- `npm test`（全体）→ **Test Files 19 passed | 1 skipped、Tests 220 passed | 14 skipped**
  - skip は `tests/wire/chat-crossimpl.test.ts` の `describe.skipIf(!chatAppAvailable())`。
    chat 実装が本ワークツリーに無いための**既存の条件付き skip**であり、本変更とは無関係

### 11.3 sabotage 検証（MEMORY.md の方針）

green を信用せず、守っている対象を壊して**テストが落ちること**を確認した:

| 壊した箇所 | 結果 |
|---|---|
| `pending_burn` 分岐を削除 | `settle の success:false + errorReason:pending_burn は unknown` が **1 件だけ失敗**（`rejected` を返す） |
| `status === 429` 分岐を削除 | `settle の 429 は unknown` が **1 件だけ失敗** |

いずれも他のテストは通ったままで、**各テストが自分の対象だけを守っている**ことも確認できた。
確認後、`src/adapters/inbound/subetha.ts` は変更前の状態に復元してから全体テストを実行した。

### 11.4 本節で解除していないもの

実 facilitator への接続（U-01r-b、URL 未確認）、実決済（U-01r-c、AGENTS.md が権限を留保）、
および再送回復（§10.5 により**実装しない**方針）。

## 12. 実装レビュー結果と追加修正

レビュー実施: 2026-09-29、Codex CLI 0.157.1、モデル **`gpt-6-astra`**、`--sandbox read-only`。
判定は **APPROVE WITH CHANGES**（§11 の 2 分類は正しく、いずれも dead code ではない）。
指摘 2 件を実ソースで確認のうえ修正した。

### 12.1 指摘 1（高）: `state=accepted` が「失敗」になっていた

§11 の修正後も、**支払いが成立している応答が `rejected` に落ちていた**。
`packages/zerc20-backend/src/index.ts:1311-1313` は `rec.state !== "open"` のとき
`challenge not open (state=accepted)` を返すが、`accepted` は `index.ts:1838` で
**settle 成功時に設定される状態**である。つまり「成功したので再 settle を断った」応答を
Router が「支払い失敗」と解釈していた。

到達可能性も確認した: `verifyOnly`（`index.ts:2304-2306`）は challenge の**状態を検査しない**
（見るのは存在と期限のみ）。よって受領済み challenge は verify を通過し、
`/settle` の状態検査で初めて弾かれる。Router 内部の再試行を仮定しなくても到達する。

さらに facilitator 自身のコメント（`index.ts:2430-2433`）が
「`accepted` は猶予期間後に削除され、再照会は **"unknown" を返す**——UX 劣化であって資金喪失ではない」
と明言している。**記録の不在は未払いの証拠にならない**。

修正: `errorReason` を単一値比較から**未確定マーカーの部分一致判定**（`undetermined()`）に変更し、
`pending_burn` / `state=accepted` / `state=accepting` / challenge 不在系を `unknown` に分類。
部分一致にしたのは `challenge not open (state=accepted)` のように状態名が文中に埋め込まれるため。

### 12.2 指摘 2（中）: 対照テストが無く、過度に広い実装を通していた

§11 のテストは各 guard の**削除**は捉えるが、「200 の `success:false` を**一律** `unknown` にする」
という**過度に広い**実装を通してしまう。既存の拒否 fixture は HTTP 400 を返すため、
JSON 側の拒否分岐を踏んでいなかった。

修正: `--settle rejected-200`（200 + `success:false` + `errorReason:"burn tx reverted"`）を追加し、
**`rejected` のままであること**を固定する対照テストを追加。

### 12.3 指摘 3（軽微）: 429 コメントの不正確さ

「要求が届かなかった」は誤り。limiter は `/settle` の**手前**にあり
（`apps/facilitator/src/http.ts:41-44`）、429 は「この呼び出しが決済処理に到達しなかった」ことしか
意味せず、先行呼び出しや payer の burn を否定しない。コメントを修正した。

### 12.4 レビューで確認された（修正不要）

- `unknown` は送信レグを開始せず終端 journal を書く（`orchestrator.ts:549`）。
  誤った `awaiting_payment` 提示が消えることが今回の改善であり、新たな replay ロックではない
- 予算台帳（`budget.ts:61`）は `rejected` も `unknown` も解放しない。429 後も予約が残るのは
  **既存の保守的な挙動**であり、本変更が持ち込んだ漏れではない
- 敵対的な facilitator が偽の `pending_burn` を返しても `unknown` にしかならず、配信は起きない。
  `success:true` + 実 transaction が先に評価される順序も維持されている

### 12.5 検証（再実行）

- sabotage 4 種、いずれも**対応する 1 件だけ**が失敗:
  `pending_burn` 削除 / `429` 削除 / **判定を全 `success:false` に拡大**（指摘 2 の対照が捕捉）/
  `state=accepted` マーカー削除
- `npm run types` → エラーなし
- `npm test` → **Test Files 19 passed | 1 skipped、Tests 222 passed | 14 skipped**
  （skip は既存の `chat-crossimpl.test.ts` 条件付き skip）

## 13. 実決済スコープの記録（AGENTS.md「Record concrete testnet payment scope before live payment」）

owner 承認: 2026-09-29。「テストネットなので無制限に実行して良い」との回答を得た。
ただし AGENTS.md は**額ではなく範囲の記録**を要求しているため、実行前に以下を確定する。
上限を設けるのは権限の縮小ではなく、**1 件ずつ結果を確認して報告するため**である。

### 13.1 対象ネットワーク・資産（実測で確認済み）

| 項目 | 値 | 確認方法 |
|---|---|---|
| 支払いチェーン | **Sepolia** `chain_id: 11155111` | owner 決定。`.env.testnet.local` と `config/deployed/testnet/tokens.zeth.testnet.json` が一致 |
| 資産 | **zETH** `0xADAb5CaB352fb1eBF24CD951de224f9e952C82Ed` | 同上。過去 tx `0xec90bc35…` の送信先と一致 |
| Verifier | `0xD19b79cE0C2821158aDBDEf9cC8c8D858c9ef0Cc` | 同上。過去 tx `0x1892c477…` の送信先と一致 |
| Hub | `0xD18b503B335656C05dC516366C0C8FD6e3b13856`（Base Sepolia `84532`） | `.env.testnet.local` |
| `InboundOffer.network` | **`eip155:11155111`** | facilitator 応答の `chainId` が権威（§12 指摘 6） |

### 13.2 オンチェーン前提条件（実測で確認済み）

- `Verifier.latestProvedIndex()` = **433**（`cast call` で実測）。
  `>= 1` なので finalize は完了し得る（`apps/facilitator/src/check.ts:85-92` の要件を満たす）。

### 13.3 スタックの実在（確認済み）

| 要素 | 状態 |
|---|---|
| `zerc20-tree-indexer` / `zerc20-decider-prover` | **ビルド済みバイナリが存在**（`$ZERC20_WORK/target/release/`） |
| Nova artifacts | **存在**（11G） |
| `config/{indexer,decider}.env` / `tokens.json` | 存在 |
| Docker | 稼働中（pg コンテナは**未作成**。起動が必要） |
| keystore（payer / treasury / relayer） | **3 つとも存在**（`~/.foundry/keystores/testnet`、暗号化済み） |

**ローカル URL は例ファイルと異なる**: `.env.testnet.local` は indexer を **`:8082`**
（例ファイルの `:8080` ではない）、decider を `:8081` に置く。

### 13.4 実行段階と、各段の課金

| 段 | 内容 | 課金 |
|---|---|---|
| S1 | pg × 2 起動、decider・indexer 起動、facilitator 起動、`check` 通過 | **なし** |
| S2 | Router を実 facilitator に向け、`/challenge` を 1 件取得（AC-a5） | **なし** |
| S3 | zETH の burn → `/settle` → finalize を **1 件**通す | **あり**（zETH + ガス） |
| S4 | 結果を報告し、追加実行の要否を owner が判断 | — |

**S3 は 1 件ずつ実行し、都度報告する。** 成功しても自動で次を始めない。

### 13.5 停止条件

- 同一 `requestId` / `challengeNonce` の重複課金の疑い
- `unknown` 終端に到達したとき（§10.5 の通り**再送しない**）
- keystore の復号に失敗したとき（**推測による復号を試みない**）
- `latestProvedIndex` が停滞し finalize が完了しないとき

## 14. S1 調査結果: 実 Sepolia スタックは**残っていない**

owner の示唆（「Docker に残っていないか」「過去の E2E を参考に」）に沿って調査した結果を記録する。
**資金は動かしていない。**

### 14.1 Docker には無い

`docker ps -a` の全コンテナは Tempo / chat 系のみで、**zERC20 の pg は 1 つも無い**
（`zerc20-pg-indexer` / `zerc20-pg-decider` は未作成）。volume も同様。
唯一稼働中の `tempo-mpp-e2e` は MPP レール用で本件と無関係。

### 14.2 プロセスは生きているが、**実体が死んでいる**

`:8080` に `zerc20-tree-indexer`（pid 52831）、`:8081` に `zerc20-decider-prover`（pid 59432）が
**2026-08-30 13:45 から起動したまま**残っている。しかし:

| 観測 | 結果 |
|---|---|
| 作業ディレクトリ | `/private/tmp/zerc20-stack` → **既に削除されている**（`tokens.json` も消失） |
| pg (:5432) | **CLOSED**（接続不可） |
| indexer の TCP | LISTEN と CLOSE_WAIT のみ。**pg への接続を 1 本も持たない** |
| `/status` | **空応答**（HTTP 000） |

つまり**設定ファイルと DB を失ったまま listen だけ続けているゾンビ**である。
`/events` は生きているが `chain_id` + `token_address` + `to` を要求する参照 API で、
設定を読み出せない（どのチェーン向けだったかは応答から判定できない）。

**ポートも食い違う**: 稼働中の indexer は `:8080`。`.env.testnet.local` は **`:8082`** を指す。
過去 E2E がこのプロセス群を使っていた可能性は低い。

### 14.3 過去 E2E から判明した要件（`apps/demo-official/src/live-testnet-e2e.ts`）

読んだ結果、**ローカル indexer / decider は必須**である（外部サービス直叩きではない）。
さらに起動前検査があり、`verifyIndexerDeployment()`（同 :36-68）は
indexer の `/status` に **Sepolia zETH のエントリ（`chain_id=11155111` かつ当該 token）が
含まれること**を要求し、無ければ
`indexer is not configured for Sepolia zETH` で停止する。

**したがって §13 で挙げた `tokens.json` の問題は本物である**:
`$ZERC20_WORK/config/tokens.json` は `label:"localnet"` / `chain_id:31337` /
`rpc_urls:["http://127.0.0.1:8545"]` のみを持ち、Sepolia のエントリを持たない。
Sepolia の定義は `config/deployed/testnet/tokens.zeth.testnet.json` に**別ファイルとして存在**する。

### 14.4 未解決（owner 判断が必要）

| # | 内容 |
|---|---|
| 1 | `tokens.json` を Sepolia 版に切り替える正規手順（差し替え / symlink / 環境変数のどれか） |
| 2 | `ROOT_SUBMITTER_PRIVATE_KEY` が **anvil 公開鍵 `0xac0974…`**。Sepolia でルート提出するなら資金のある別鍵が必要 |
| 3 | 残存ゾンビプロセス（52831 / 59432）を停止して良いか。**他セッションの所有物である可能性があるため停止しない** |

### 14.5 有効な前提（再掲）

`Verifier.latestProvedIndex()` = **433** は Sepolia 上の実測値であり、
**ルートは過去に提出されている**（＝ 14.4 #2 は過去に解決されていた）。
ただしその提出を行った主体は本ホストのゾンビプロセスではない可能性が高い（14.2）。

## 15. 使い捨てアカウントの用意（owner 承認: 毎回の支払い許可は不要）

owner 承認 2026-09-29: 「テストネットのアセットなので毎回実行のために許可を取らなくて良い」。
以降、**テストネット上の支払いは個別承認を取らずに実行する**（§13.4 の S3 も都度報告を待たない）。
実チェーン・実資産・本番鍵への拡張は**この承認に含まれない**。

### 15.1 作成したアカウント

| 項目 | 値 |
|---|---|
| アドレス | **`0xEd5F079F5332879B9F1e35Ba36fE487360db06C4`** |
| 用途 | Sepolia（`11155111`）での SubEtha 受信レグ検証のみ |
| 鍵の保管 | `.env.sepolia-disposable.local`（mode 600、`.gitignore:5` の `.env.*` で無視。`git check-ignore` で確認済み） |
| 既存 keystore | **一切触っていない**（`~/.foundry/keystores/testnet` は未読・未復号） |

新規生成なので、**owner の既存ウォレットとは無関係**であり、失っても影響がない。

### 15.2 残高（実測）と、資金供給の問題

| 資産 | 残高 |
|---|---|
| Sepolia ETH（ガス） | **0** |
| zETH | **0** |

**私は資金を供給できない。** `docs/TUTORIAL.md:57-58` が明言している:

> The payer account must be pre-funded with zERC20
> (**there is no faucet / `mintForDemo`**)

つまり zETH は faucet で入手できない。ローカル deploy では初期 mint で配るが、
**Sepolia にはその経路が無い**。

一方 `LiquidityManager`（`0x5a09Cc328fA6bB32f3d6fC54906106ddD49a2D7c`）は
**Sepolia 上にコードが存在する**（`cast code` で確認）。`docs/TUTORIAL.md:228` は
「ローカルには未デプロイなので pre-minted を使う」と書いており、**Sepolia では `wrap` 経路が
使える可能性がある**。ただし wrap にも **Sepolia ETH（ガス）が必要**で、
使い捨てアカウントはそれも 0 である。

### 15.3 したがって必要なもの（どちらか）

1. **使い捨てアドレスへの送金**: Sepolia ETH（ガス分、0.01 程度）と zETH（支払い額分）。
   zETH は owner の既存 payer から送るか、`LiquidityManager.wrap` で作る
2. **既存 payer をそのまま使う**: `PAYER_KEYSTORE_ID` の鍵で実行する。
   その場合 keystore のパスワードが必要で、**使い捨てアカウントは不要になる**

### 15.4 なお §14 のスタック問題は未解決のまま

使い捨てアカウントは**支払い承認の摩擦**を解消するが、§14 の 3 点
（`tokens.json` が localnet 向け / ルート提出鍵が anvil 公開鍵 / ゾンビプロセス）は
そのまま残る。資金が入っても、indexer が Sepolia zETH を serve しなければ
過去 E2E の起動前検査が `indexer is not configured for Sepolia zETH` で止まる。

## 16. 資金供給は解決した — `wrap` で zETH を入手できる

> **§15.2 の訂正**: 「zETH は faucet が無いので私は供給できない」と書いたが、**不正確だった**。
> faucet が無いのは事実だが、**Sepolia には `LiquidityManager` があり `wrap` で入手できる**。
> ローカルスタックに LiquidityManager が無いという記述（`docs/TUTORIAL.md:228`）を
> Sepolia にも当てはめてしまったのが誤りだった。

### 16.1 判明した経路

`LiquidityManager` `0x5a09Cc328fA6bB32f3d6fC54906106ddD49a2D7c`（Sepolia）の
`underlyingToken()` は **`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`** を返す。
これは SDK の `NATIVE_TOKEN` センチネル（`sdk/src/operations/liquidityManager.ts:72-73`）であり、
**underlying が native ETH** であることを意味する。

SDK の実装（同 :73-96）では native の場合:
- ERC-20 approve を**行わない**（`if (!isNative)` で分岐）
- `wrap(amount, receiver)` を **`value: amount` 付き**で呼ぶ

つまり **Sepolia ETH さえあれば zETH を作れる**。

### 16.2 実行結果（実課金・成功）

owner が使い捨てアカウントへ **0.005 Sepolia ETH** を送金（実測確認済み）。
そのうち 0.001 ETH を wrap した。

| 項目 | 値 |
|---|---|
| tx | **`0xc4d18909159b746f1ef49603ae3fe8f7fb47e4e5820cdecc1dabf00ef5622ba5`** |
| status | **1 (success)** |
| block | 11806842 |
| gasUsed | 95,758 |
| 受領 | zETH **1e15**（`0x0` からの Transfer イベントを確認） |

実行前に `cast call`（eth_call）で**シミュレーションして成功を確認してから** `cast send` した。

### 16.3 現在の残高（実測）

| 資産 | 残高 |
|---|---|
| zETH | **1,000,000,000,000,000**（1e15） |
| Sepolia ETH | **0.003903142302296428**（ガス用） |

`config/testnet.env.example` の `PRICE=1234` を基準にすると、1e15 は**十分すぎる**額である。
追加の wrap が必要になれば残 ETH から作れる。

### 16.4 残る壁は §14 のスタック問題のみ

資金（§15.3）は解決した。**未解決は §14 の 3 点だけ**:

1. `$ZERC20_WORK/config/tokens.json` が **localnet（31337）向け**で Sepolia エントリを持たない
2. `indexer.env` の `ROOT_SUBMITTER_PRIVATE_KEY` が **anvil 公開鍵**
3. ゾンビプロセス 2 本（52831 / 59432）の停止判断

ただし §14.5 の通り `Verifier.latestProvedIndex()` = 433 は**実測値**であり、
ルート提出は誰かが実施できている。1 が最優先。
