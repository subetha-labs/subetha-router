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

Router は **2 つの route** を公開している。**どちらで払うかは手持ちの資産で選ぶ**:

| routeId | 払う側（あなた） | 届く先 |
|---|---|---|
| `md-mpp-eth-snapshot` | **Base Sepolia の USDC**（x402） | MPP しか受けない Provider |
| `md-x402-eth-snapshot` | **Tempo の pathUSD**（MPP） | x402 しか受けない Provider |

手順:

1. `subetha_router_list_routes` で route を確認し、**手持ちの資産で払えるほうを選ぶ**
2. `subetha_router_quote` を呼ぶ。**`requestId` は購入ごとに新しい値**にする
   （例: 用途 + タイムスタンプ）。**同じ購入の中では quote と purchase で同じ値を使う**
3. **人間に承認を求める。** 返ってきた `subject`（額・`decimals`・宛先・期限）を提示する。
   **MPP で払う場合は「実行した瞬間に送金され、取り消せない」ことも伝える**（下記）
4. 承認されたら、`quote` フィールドをそのまま渡す:

   ```sh
   npm run sign -- '<quote 応答の quote フィールドの JSON>'
   ```

   標準出力の base64 が `credential`。**レールは offer から自動判定される**ので指定不要。
   **鍵は送信されない。**

5. `subetha_router_purchase` を呼ぶ。渡すのは
   `quoteId` / `requestId`（手順2と同じ）/ `approval`（承認された `quoteId`）/
   `quote`（応答の `quote` をそのまま）/ `credential`（手順4の出力）

### レールによって手順4の意味が違う

| 受信レール | `npm run sign` が何をするか |
|---|---|
| **x402**（`md-mpp-eth-snapshot`） | **署名するだけ。** この時点では資金は動かない。送信と gas は facilitator 負担 |
| **MPP**（`md-x402-eth-snapshot`） | **その場でチェーンに送金する。** 手数料も自分持ち。**失敗しても戻らない** |

**MPP の場合、手順4の実行前に必ず人間の承認を得ること。** 承認前に走らせると、
本人が同意していない送金が起きる。手順5が失敗しても送金は取り消せないので、
その場合は**勝手に再試行せず、送金済みである旨を報告して止まる**。

**やってはいけないこと**:
- `credential` を推測で組み立てる（署名できないなら**止まって報告する**）
- 期限切れの quote を使い回す（取り直して**改めて承認を得る**）
- `requestId` を quote と purchase で変える（別の購入になる）
- **前の購入の `requestId` を使い回す。** quote は `requestId` ごとに**冪等**なので、
  使い回すと**前回の quote がそのまま返る**（期限も当時のまま）。
  取り直したつもりで**発行済みの期限切れ quote を受け取る**ことになる。
  「期限切れが返ってきた」ときは時計のずれではなく、**`requestId` の使い回しを疑う**

鍵が無いときは `npm run wallet:new`、Base Sepolia USDC の残高は `npm run wallet:balance`。

### 実行許可について

`.claude/settings.json` で `npm run sign` / `wallet:new` / `wallet:balance` を許可済み。
これが無いと `npm run sign` が実行時に止まる（資金を扱うコマンドとして分類されるため）。

**許可しているのは署名の作成だけで、承認の判断ではない。**
`sign` を実行してよいのは**人間が quote を承認した後**で、その判断は
このファイルの手順3が定めている。x402 経路では `sign` は署名するだけで資金は動かず、
動くのは `purchase` のとき。MPP 経路では `sign` の時点で送金が起きる
（`subject.fundsMoveOnCredential` が true なら後者）。
**pathUSD（MPP で払う場合）の残高はこのコマンドでは見られない。**
