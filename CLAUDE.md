# Router development workflow

Follow AGENTS.md. Create only bounded approved artifacts in this worktree.

First milestone: SubEtha inbound → Router → x402 Provider A, then SubEtha → MPP Provider B. Later MPP → A and x402 → B; same-rail coverage is a separate matrix entry. Existing chat owns conversation/approval/display/history; A/B own their services. Do not recreate them.

Public phase artifacts live in `docs/`; private prompts, model logs, process details and local absolute paths live only in ignored `.claude_workflow/local/`.

Parent controller owns state, locking and commits. Writer must not launch workers, update controller state, commit or push. Reviewer only reads and returns an explicit scoped verdict. Run product tests after implementation under the exact task permissions; docs validation is not a runtime test.

Each phase: minimal artifact, independent review, parent readback. No repeated whole-plan reviews for a small correction. Retain author/test/review evidence. Defer nonblocking polish. Stop for wrong/duplicate payments, secret exposure, ownership conflicts, unsupported permissions, real quota or an actual unresolved prerequisite.
