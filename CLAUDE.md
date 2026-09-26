# Router development workflow

Follow AGENTS.md. Create only bounded approved artifacts in this worktree.

First milestone: SubEtha inbound → Router → x402 Provider A, then SubEtha → MPP Provider B. Later MPP → A and x402 → B; same-rail coverage is a separate matrix entry. Existing chat owns conversation/approval/display/history; A/B own their services. Do not recreate them.

Public phase artifacts live in `docs/`; private prompts, model logs, process details and local absolute paths live only in ignored `.claude_workflow/local/`.

Parent controller owns state, locking and commits. Writer must not launch workers, update controller state, commit or push. Reviewer only reads and returns an explicit scoped verdict. Run product tests after implementation under the exact task permissions; docs validation is not a runtime test.

Each phase: minimal artifact, independent review, parent readback. No repeated whole-plan reviews for a small correction. Retain author/test/review evidence. Defer nonblocking polish. Stop for wrong/duplicate payments, secret exposure, ownership conflicts, unsupported permissions, real quota or an actual unresolved prerequisite.

## Using the Router from this repository (for agents)

**Answer the user in the language they write in.**

`subetha_router_purchase` on the hosted Router (`https://router.subethalabs.com/mcp`)
**requires `credential`** — an `X-Payment` value signed with the caller's own key.
**The Router never holds your key**, so the signature is produced here.

The Router exposes **two routes**. **Pick the one you can pay with what you hold**:

| routeId | you pay with | reaches |
|---|---|---|
| `md-mpp-eth-snapshot` | **Base Sepolia USDC** (x402) | a provider that only accepts MPP |
| `md-x402-eth-snapshot` | **Tempo pathUSD** (MPP) | a provider that only accepts x402 |

Steps:

1. Call `subetha_router_list_routes` and **choose the route you can actually pay for**
2. Call `subetha_router_quote`. **Use a fresh `requestId` for each purchase**
   (e.g. purpose + timestamp). **Within one purchase, use the same value for quote and purchase**
3. **Ask the human to approve.** Show the returned `subject`: amount, `decimals`,
   recipient, deadline. **If paying over MPP, also say that running the next step sends
   the funds immediately and cannot be undone** (see below)
4. Once approved, pass the `quote` field through unchanged:

   ```sh
   npm run sign -- '<the quote field from the quote response, as JSON>'
   ```

   The base64 on stdout is the `credential`. **The rail is detected from the offer**, so
   you do not specify it. **Your key is never sent.**

5. Call `subetha_router_purchase` with
   `quoteId` / `requestId` (same as step 2) / `approval` (the approved `quoteId`) /
   `quote` (the response's `quote`, unchanged) / `credential` (step 4's output)

### Step 4 means different things on different rails

| inbound rail | what `npm run sign` does |
|---|---|
| **x402** (`md-mpp-eth-snapshot`) | **Only signs.** No funds move yet; the facilitator broadcasts and pays gas |
| **MPP** (`md-x402-eth-snapshot`) | **Sends the transfer right now.** You pay the fee, and **it cannot be undone** |

**On MPP, get human approval before running step 4.** Running it first would move money
the person never agreed to. If step 5 then fails, **do not retry on your own** — report
that the payment was already sent, and stop.

**Never**:
- Build a `credential` by guessing (**stop and report** if you cannot sign)
- Reuse an expired quote (take a new one and **ask for approval again**)
- Change `requestId` between quote and purchase (that becomes a different purchase)
- **Reuse a previous purchase's `requestId`.** Quotes are **idempotent per `requestId`**,
  so reusing one **returns the earlier quote**, original deadline and all. You would
  receive an already-expired quote while believing you took a fresh one.
  If a quote comes back expired, suspect **a reused `requestId`**, not clock skew

No key yet? `npm run wallet:new`. Base Sepolia USDC balance: `npm run wallet:balance`.
**That command does not show pathUSD** (needed only when paying over MPP).

### Execution permission

`.claude/settings.json` already allows `npm run sign` / `wallet:new` / `wallet:balance`.
Without it, `npm run sign` is blocked at runtime as a funds-handling command.

**What is allowed is producing a signature, not deciding to pay.** `sign` may be run only
**after a human approves the quote**, which step 3 defines. On the x402 rail `sign` moves
nothing — funds move at `purchase`. On the MPP rail funds move at `sign`
(true when `subject.fundsMoveOnCredential` is true).
