# hosted の `subetha-exact` の有効化（上限付きの実証） タスク v1

入力: 要件 v3（R）、設計 v3（D）。各タスクは「実装 → その試験 → sabotage」で閉じる。code の PR は 1 つ（G-3 の前に merge。merge はオーナーの指示）。

| # | 内容 | 触るファイル | 完了の条件 |
|---|---|---|---|
| T-1 | adapter: `requester.sourceTag`、ledger の `requested` に tag、送信元ごとの未解決（`discovered` の帰属の規則、結果の分からない attempt を持つ送信元は止める）・毎分、`limit_source_*`、`unansweredVerifyIsUnknown`。設定の検査（新しい 3 欄） | `src/ports/inbound.ts`、`src/adapters/inbound/subetha-exact{,-ledger}.ts`、`src/config.ts`、`src/main.ts` | D §9 T-b |
| T-2 | core: `offerCap`（数え方、同期の予約、`offer_cap_reached`）、`source_failed` の `settleStarted: false`、source の受け渡し（quote の入口・標準入口）、sourceTag | `src/config.ts`、`src/core/{orchestrator,store,intent}.ts`、`src/http/{app,x402-entry}.ts` | D §9 T-a |
| T-3 | HTTP の写像（429 `rate_limited`）、公開の URL の基点（`ROUTER_X402_ENTRY_BASE_URL`）、一覧の `demonstration` | `src/http/{app,x402-entry,projection}.ts`、`src/config.ts` | D §3、§4、§7.1 |
| T-4 | ingress の proxy | `src/mcp/x402-proxy.ts`、`src/mcp/ingress.ts` | D §9 T-c |
| T-5 | hosted の生成とスイッチ、入口の配線、MCP の案内 | `tools/remote-mcp-config.ts`、`tools/rails-entry.ts`、`tools/remote-mcp.ts`、`src/mcp/{server,tools}.ts` | D §9 T-d、T-e |
| T-6 | 全体: 全試験、Codex の実装レビュー、文書（`docs/DEPLOY.md` の手順の節） | — | R AC-8 |
| G-0 | hosted 用の Provider の登録（`router-hosted`）: 新しい EOA・POS key、招待（オーナーの AWS login）、ETH、probe、activate | 手元（`.claude_workflow/local/provider-wallet-hosted/`） | acceptance の記録 |
| G-2 | 手元の hosted の入口で受け入れ | — | R AC-5 |
| G-3 | (i) の image を本番に入れ替え | host | R AC-6 |
| G-4 | token と env を置き、(ii) の image に入れ替え（**オーナーの go**）。G-4b: (iii) に入れ替えて戻す | host | R AC-7、AC-7b |

やらないこと: 採算、mainnet、他の rail の標準入口、payer の対応（R S-6）。
