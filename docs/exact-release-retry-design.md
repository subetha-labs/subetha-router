# subetha-exact の release の再試行 — 設計 v1

要件: `docs/exact-release-retry-requirements.md` v3（owner が §5 の値を確認: 2026-11-26「おすすめで」）。
変更するのは `src/adapters/inbound/subetha-exact.ts` の `release()` と `SUBETHA_EXACT_DEFAULT_TIMEOUTS`、試験、`docs/subetha-exact-inbound-design.md` §3.7 の表だけ。port・core・分類の関数の戻り値の形は変えない。

## 1. 値（`SubethaExactTimeouts` に足す）

| 名前 | 既定 | 意味 |
|---|---|---|
| `releaseBudgetMs` | 60 000（今と同じ） | 予算の上限。予算 = `min(承認期限 − 5 秒, 開始 + releaseBudgetMs)`（今と同じ式） |
| `releaseRetryWaitMs` | 2 000（今と同じ名前） | 数列の初項 |
| `releaseWaitCapMs` | **10 000**（新） | 1 回の待ちの上限 |
| `releaseMaxPosts` | **8**（新。今は 3 の固定） | POST の回数の上限 |
| `releaseMaxClaimedProbes` | **6**（新。今は 2 の固定） | `claimed` の経路の GET の回数の上限 |

試験は今と同じく、`timeouts` を短い値で上書きする。

## 2. 待ち（FR-2）

release の 1 回の呼び出しの中に、数列の位置 `k`（0 から）を 1 つ持つ。待つたびに:

```
base  = releaseRetryWaitMs × 2^k
wait  = 直前の試行が HTTP 応答で、その Retry-After が読めるなら retryAfterMsOf(その値) 、そうでなければ base
wait  = min(wait, releaseWaitCapMs)
k     = k + 1
waitFits(wait, 予算の終わり, 今) が偽なら、その場で unknown（今と同じ判定: 待った後に 1 秒以上残らないなら試さない）
```

- 「直前の試行」は直前に送った要求（POST の後に GET をしたなら GET）。例外（timeout・transport）なら `Retry-After` は無い。
- 既定で 2・4・8・10・10 … 秒。
- `retryAfterMsOf(header, fallback)` は今の関数をそのまま使い、fallback に `base` を渡す（秒の整数だけを読む。日付の形・負・非数は fallback）。

## 3. 流れ

```
attempts = 0（POST）, probes = 0（GET）
loop:
  attempts ≥ releaseMaxPosts → unknown
  （425・transport の GET の後も、次の POST が許されない（attempts ≥ releaseMaxPosts）なら待たずに unknown）
  試行の期限（tryDeadlineOf）が無い → unknown
  attempts += 1（送る直前。今と同じ）
  POST → classifyReleasePost
    released → released
    refused → refused
    unknown（401 を含む） → unknown
    retry（425） → wait（POST の応答） → loop
    reconstruct（409 already-claimed） → claimed の GET（下）
    probe（例外・429・5xx） → transport の GET（下）

transport の GET（1 試行、FR-3）:
  試行の期限が無い → unknown
  GET; probes += 1
  一時的な失敗（例外・429・5xx） → wait（GET の応答） → loop（POST へ）
  classifyReconstruct(…, "transport")
    released → released（reconstructed）
    retry（state none。照合より先、今と同じ） → wait（GET の応答） → loop（POST へ）
    それ以外 → unknown（今と同じ。refused にしない）

claimed の GET（繰り返し、最大 releaseMaxClaimedProbes 回。この経路の GET の回数で数える）:
  試行の期限が無い → unknown
  GET; probes += 1
  一時的な失敗 → 回数が上限なら unknown、そうでなければ wait（GET の応答） → もう一度 GET
  classifyReconstruct(…, "claimed")
    released → released（reconstructed）
    refused → refused
    それ以外 → unknown
```

- 「一時的な失敗」の判定は GET の生の結果で行う: `kind === "threw"`、または `status === 429 || status >= 500`。`classifyReconstruct` はこのとき今も `unknown` を返すので、**その前に**判定する。401・2xx 以外の決まった応答・読めない本文は一時的な失敗ではない → 今までどおり `classifyReconstruct` の結果で終わる。
- POST の 401 は今までどおり `unknown`（`note` を出す）。
- 今の transport の GET の 2 試行目の「1 秒待ち」は無くなる（GET は 1 試行。待ちは数列）。

## 4. 記録（FR-7）

`release` の行（`finish` が書く）:

| 欄 | 中身 |
|---|---|
| `outcome`・`attempts`・`reconstructed` | 今と同じ |
| `probes` | GET の回数（新） |
| `httpStatus` | 最後に受けた HTTP 応答の状態。例外の試行では上書きしない（今は消える） |
| `lastFailure` | 最後の試行が例外なら `"transport"`（新） |
| `elapsedMs` | 今と同じ（通信の時間の合計。待ちを含まない） |
| `wallMs` | release の開始から `finish` まで（待ちを含む。新） |

ledger の読み取り（`subetha-exact-ledger.ts`）は `outcome`・`reconstructed`・`elapsedMs` だけを使うので、変えない。足した欄は古い image でも無視される。

## 5. 試験

**時計**: 今の adapter の試験は `now: () => clockMs` が固定で、待ちは本当の `setTimeout`。待っても予算が減らない。そこで options に試験用の `sleepForTest?: (ms) => Promise<void>`（既定は今の `setTimeout` の `sleep`。release・complete・照会の待ちがこれを使う）を足し、release の試験では **`clockMs += ms` して待ちの長さを記録する** sleep を渡す。これで既定の値（2 秒・10 秒・60 秒）のまま、時系列（POST の時刻・待ちの列）と予算の境界（残り 1 秒）・`wallMs` を確かめられる。遅い試行は、偽の facilitator の `timeout` のモードと本当の時計で別に確かめる（短い `releaseMs`）。
偽の facilitator の停止は**時刻**で表す: `down-until:<秒>`（その時刻（Unix 秒）まで release と status の両方が 502）、`busy-until:<秒>`（同じく 503 + `Retry-After: 30`）。fixture の今の時計 `now`（Unix 秒、`Math.floor(clockMs / 1000)`）と同じ単位で比べる（`now() < 期限` の間は停止）。停止の長さは秒の単位で表すので、試験の時刻は秒に揃えて選ぶ。
- 単体の試験: adapter と fixture が同じ `clockMs` を共有し（fixture の `now` は今も `clockMs` を読む）、上の sleep が `clockMs` を進めるので、「20 秒間 502」は `down-until:<開始の秒 + 20>` で正確に表せる。
- wire の試験（AC-8）: fixture は本当の時計。停止は短く（例: 開始から 3 秒）、release の値も短くした設定で、本当の時間で確かめる。
- 回数のモード（`error-n:<N>`: 最初の N 回は 502）は、`claimed` の経路の GET の回復（AC-5）など、時間に意味の無い試験に使う。

- `tests/unit/subetha-exact-adapter.test.ts` の release の試験を新しい回数に直す（425 が続く → POST 8 回、`claimed` の後の GET の 5xx → GET 6 回、`Retry-After: 30` は上限で切られて続く）。
- 新しい試験（要件の AC-1〜AC-7。短い値で）: 502 が一定時間続いた後に回復（POST・GET とも）、503 + `Retry-After` 長い値 → 上限で切って回復、予算・回数の上限、承認期限で短い予算、遅い試行、応答を失った後の再 POST → 409 → 復元、`claimed` の経路の一時的な失敗からの回復、決まった答えで続けない（両経路）、`none` の規則、待ちの数え方（POST timeout + GET 503、その逆、経路の移り変わり）、記録の欄。
- 偽の facilitator（`tests/fixtures/subetha-exact-facilitator.ts`）に上の `down-until`・`busy-until`・`error-n` を足す。
- AC-4・AC-6 の「settle・上流への支払いの回数」: core を通る wire の試験（既存の `tests/wire/subetha-exact-*.test.ts` の合成）で、偽の facilitator の settle の回数と偽の上流の支払いの回数を数える（AC-4 は各 1、AC-6 は上流 0）。
- AC-8: wire の試験で、公開の x402 入口（proxy を通る経路）から買い、release が `down-until` の停止（本当の時計で数秒）から回復して、買い手が delivered の応答を proxy の期限の内に受け取ること。
- AC-9: Linux（`node:22-bookworm`）の全体の試験。
- 変更の前のコードで AC-1 の試験が落ちることを確かめる（壊して確かめる）。
