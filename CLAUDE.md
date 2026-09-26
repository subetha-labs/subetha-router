# Router development workflow

Follow AGENTS.md. Create only bounded approved artifacts in this worktree.

First milestone: SubEtha inbound → Router → x402 Provider A, then SubEtha → MPP Provider B. Later MPP → A and x402 → B; same-rail coverage is a separate matrix entry. Existing chat owns conversation/approval/display/history; A/B own their services. Do not recreate them.

Public phase artifacts live in `docs/`; private prompts, model logs, process details and local absolute paths live only in ignored `.claude_workflow/local/`.

Parent controller owns state, locking and commits. Writer must not launch workers, update controller state, commit or push. Reviewer only reads and returns an explicit scoped verdict. Run product tests after implementation under the exact task permissions; docs validation is not a runtime test.

Each phase: minimal artifact, independent review, parent readback. No repeated whole-plan reviews for a small correction. Retain author/test/review evidence. Defer nonblocking polish. Stop for wrong/duplicate payments, secret exposure, ownership conflicts, unsupported permissions, real quota or an actual unresolved prerequisite.

## このリポジトリから Router を使うとき（エージェント向け）

リモート Router（`https://router.subethalabs.com/mcp`）の `subetha_router_purchase` は
**`credential`（呼び出し側が自分の鍵で署名した `X-Payment`）を必須**とする。
**Router は呼び出し側の鍵を持たない**設計なので、署名は**この環境で**作る。

手順:

1. `subetha_router_quote` を呼ぶ（`requestId` を決める。**purchase でも同じ値を使う**）
2. **人間に承認を求める。** 返ってきた `subject`（額・`decimals`・宛先・期限）を提示する
3. 承認されたら、`quote` フィールドをそのまま渡して署名を作る:

   ```sh
   npm run sign -- '<quote 応答の quote フィールドの JSON>'
   ```

   標準出力の base64 が `credential`。**鍵は送信されない**（署名だけがネットワークに出る）。

4. `subetha_router_purchase` を呼ぶ。渡すのは
   `quoteId` / `requestId`（手順1と同じ）/ `approval`（承認された `quoteId`）/
   `quote`（応答の `quote` をそのまま）/ `credential`（手順3の出力）

**やってはいけないこと**:
- `credential` を推測で組み立てる（署名できないなら**止まって報告する**）
- 期限切れの quote を使い回す（取り直して**改めて承認を得る**）
- `requestId` を quote と purchase で変える（別の購入になる）

鍵が無いときは `npm run wallet:new`、残高は `npm run wallet:balance`。
