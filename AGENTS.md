# SubEtha Router — ETHGlobal Tokyo

- This submission implementation is distinct from the earlier technical feasibility PoC.
- One controller, one dedicated worktree/branch, one writer. Before working: `git status --short --branch` and `git worktree list`. Never edit the PoC, chat, Provider, or video worktrees.
- Requirements → independent review → design → independent review → tasks → independent review → implementation. Claude Code authors; Codex independently reviews read-only. Parent verifies artifacts and real execution.
- Work locally on `subetha/tokyo-20260925`. Worktree-local `.claude_workflow/state.json` records current task, next action, actual worker and evidence; raw logs/prompts are ignored under `.claude_workflow/local/`.
- Controller holds `.claude_workflow/worker.lock` for each bounded author/reviewer run. Do not overlap workers or mutate their inputs. Never remove stable lock files. Max turns/timeouts mean incomplete, not success or quota.
- Owner approved the proposed Router flow and regular local commits on 2026-09-25. Commit small reviewed/verified milestones; no empty periodic commits, no squashing/re-dating old work, no secrets/raw logs. Product scope changes and external effects remain separate gates.
- No push, remote creation, publication, deployment, paid API, existing wallet/key access, faucet, signing or transaction broadcasting is authorized by local development/commit permission. Record concrete testnet payment scope before live payment.
- Never copy/vendor/redistribute official `@zerc20/sdk` or BUSL source. Record origin and license for reused PoC code; a feasibility record is not fresh E2E evidence.
- Preserve explicit approval, exact offer/route/amount/network binding, verify-before-settle, two-leg identity, at-most-once semantics and durable unknown outcomes. No blind payment retries.
- Prefer one useful path over a generic framework. Unit tests, TCP wiring, source settlement, destination settlement, API delivery, client receipt, saved/reopened result and finality are separate gates.
- No automatic quota retry or executor/model substitution. Keep actual provider/tool refusals held; do not reroute them.
