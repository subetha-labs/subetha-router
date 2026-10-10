# P-3a fixture verification

These tests were retained by the implementation worker but **wire tests were not executed there**. Hermes owns Unix/TCP/process/inspector execution under its existing checks. No hosted smoke is part of this harness.

From `packages/payer`, build before parent wire execution:

```sh
npm run types
npm run build
../../node_modules/.bin/vitest run test/wire/startup.test.ts test/wire/session.test.ts test/wire/socket.test.ts test/wire/router-client.test.ts test/wire/latency.test.ts
```

Each fixture creates an isolated temporary HOME, encrypted throwaway key store and install tree. Children use `process.execPath` with the installed tsx loader, never the tsx CLI. The production-bin startup tests use compiled `dist/bin.js` with its real flags. The test entry supplies a simulated guarded argv solely because its own TypeScript loader is forbidden in production. It does not prove the native launch path; the compiled-bin rejection rows cover that path.

The fixture uses a short `p3a-` prefix within the existing OS tmpdir, retaining mkdtemp randomness and realpath resolution. A filesystem-only unit test checks the full socket path plus terminating NUL against Darwin's 104-byte budget without opening a listener. Production socket discovery is unchanged; an overly long HOME may still fail closed and needs a later user-facing documentation note.

Compiled-bin tripwire assertions still require exit code 2 and the exact expected startup refusal. Their diagnostic includes the fixed row ID, exit code/signal, redacted fixture argv and an allowlisted projection of stderr (unknown text and paths are omitted). The fixture child also emits only a known socket errno on listener failure, so an early exit can distinguish path errors from EPERM. No assertion accepts an arbitrary signal. These diagnostics do not establish the cause of the parent's original `expected 2 / got null` failure; a parent rerun must identify the row first.

The child helper records the original process start identity, checks it before signals and bounds shutdown. SIGKILL tests leave the stable daemon lock in the isolated store and verify refusal on restart; they never reclaim it. Only after all owned children exit is the fixture directory removed. Event files record fixed event names, never secret values.

`fixtureReads` supplies a fixed ref and a read-model projection through the actual socket/SDK path. This is not P-3b's durable ApprovalRecord/ref generator. Purchase always runs the production fail-closed handler: unknown refs fail, known refs are `approval_unavailable`, and expired sessions are `locked`. The P-3a read-model fixture sends no Router purchase and signs nothing. Production uses the same startup/listener/client, with native UI unavailable until P-4a. P-3b adds durable quote records and the default cryptographic generator. Successful fixture startup is **not owner-native readiness**.

P-3b controller correction:

- Refs now preserve all 64 bits: `p_` plus RFC 4648 lowercase unpadded base32 of `randomBytes(8)`, 13 suffix characters / 15 total, with canonical zero pad bit. Source fixtures were migrated; existing unpublished ledger/receipt artifacts are untouched. Legacy 13-total refs are refused without conversion; disposable legacy data tests verify byte preservation and the unchanged production nonempty-store recovery refusal.
- MCP transport and resource identity are distinct. Fixture config explicitly pins `GET http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource`; the local MCP listener uses its own ephemeral port. The fixture no longer rewrites canonical resource to the listening origin. Default hosted config pins the existing HTTPS MCP / loopback canonical pair; custom config requires `router.canonicalResource`.
- `test/unit/hosted-contract.test.ts` calls actual root hostPlan/config, HTTP projection, client and MCP subject creation in process. Root TypeScript checks it (payer TypeScript excludes only this cross-package test); both test collectors can run it. No production payer import crosses the package boundary. The actual static host config omits destination decimals, which the accepted design allows; render says `not supplied` instead of inventing a value.
- `test/wire/purchase.test.ts` retains actual daemon/socket/local MCP success, cancellation, concurrent purchase counters and successful NF-A2 timing. It uses fake UI/signing. P-3a `latency.test.ts` remains the refusal-only transport measurement. These wire paths require fresh parent execution after the correction; earlier 270-test receipts do not verify this source.

Source review, macOS/Docker actual wire execution, packaging/process regressions, sabotage, and any commit remain parent follow-ups. The full suite must not be reported green from pure unit results.

P-3c retained execution (author did not run sockets, children, TCP, Docker or packaging):

```sh
npm run types
npm run build
npm test -- test/wire/crash-matrix.test.ts test/wire/recovery.test.ts test/wire/secrecy.test.ts
```

The P-3c purchase fixture configures UI/signing before startup creates its single production core. Startup, production handler, recovery, purchase and status reuse that core. Native UI remains unavailable in the shipped run entry. Pure file tests are not process-crash evidence.

`crash-matrix.test.ts` retains the ten required stopping points, a separate `before:submitted` row, and before/after result. Counters are fsynced outside the crashing daemon before their observations. The before-response barrier waits for the Router's actual received-request counter and the Router withholds its response. Credential equality is asserted by digest without printing its value. Each SIGKILL targets only the owned daemon after PID/start verification, awaits exact SIGKILL exit/stdio closure, and invokes existing reclaim only in that positively exited child's isolated disposable store. The install tree and seal stay unchanged between boots. The older P-3a stale-lock tests continue to refuse without reclaim.

`recovery.test.ts` retains status failure classifications, valid-different identities with positive controls, terminal/progress states, expiry, durable unknown across another real restart, saved-body reopen with Router failure, and socket requests racing startup readiness. The internal operator-close API has file/unit coverage only; no production socket or environment option authorizes closing. EROFS/EIO are injected into real file ledger operations in unit coverage and retained separate-daemon wire rows; these are not actual read-only-filesystem evidence.

`secrecy.test.ts` keeps each random throwaway key in test memory for boolean-only absence assertions, plus passphrase, phrase, credential and complete challenge, including plaintext/base64/hex. It inspects replies, errors, both processes' output and plaintext ledger projection excluding sealed blobs. These fixtures do not exercise owner consent, native UI, real wire signatures, settlement or finality. Parent macOS/Docker execution, packaging regression, checkpoint/sabotage and NEW independent cumulative review remain required.

P-4a confirmation UI implementation (supersedes the historical unavailable-entry notes above):

`runDaemon` now composes the macOS adapter for both the pre-secret availability probe and purchases. Startup binds its verifier callback to the already parsed/unlocked keys document, re-derives and wipes temporary keys for each confirmation, and preserves `configurePurchase` for owned fixtures. The production bin has no helper/platform/auth override. Existing purchase-core guards still run before and after both UI awaits; rejection cannot append `approved` or call the signer. Native stdout is bounded to 4 KiB, stderr is discarded, and process failure/timeout is resolved at child close. Mutable I/O and derived-key buffers are wiped; V8 strings and OS/runtime copies cannot be promised erased.

File/process-only checks (no real osascript, System Events, GUI, socket, TCP, process inventory or live signing):

```sh
../../node_modules/.bin/vitest run test/unit/osascript-script.test.ts test/unit/parse.test.ts test/unit/render.test.ts test/unit/ui-wiring.test.ts test/wire/ui-spawn.test.ts
```

`ui-spawn` executes an owned fake helper and records synthetic argv/env/stdin. macOS's Node runtime adds `__CF_USER_TEXT_ENCODING` after exec, so a tiny test-owned C launcher records the exact environment before Node starts; it uses the already installed `/usr/bin/cc`, writes only under its temporary fixture directory, and has no product/runtime role. Non-macOS fixtures use Node directly without a compiler. The environment assertion stays an exact allowlist comparison. System path owner/mode/symlink/type checks use an injected filesystem, not changes to system files. All helper responses/passphrases/keys are synthetic.

`ui-check-entry.ts` runs the production composition root in an owned `node --import import.meta.resolve("tsx")` subprocess, supplying only trusted in-process dependencies. The former stub-dependent `check-ui` row moved from `startup.test.ts` here: unavailable remains exact exit 2 / `no_confirmation_ui`, available returns exit 0, neither reads secrets/prompts nor mutates the store. Every other compiled-bin SECURITY row is unchanged and still belongs to parent execution. This is **fake-helper composition-root evidence**, not installed native-bin evidence. `ui-wiring` also executes real startup/core/ledger with fake UI executable, fake signing and in-process Router responses; it covers wrong passphrase, cancellation, session/expiry after await, and verifier binding despite replacement of the persisted keys document.

Native/manual acceptance remains **UNRUN** for all five cases: correct passphrase approval, wrong passphrase rejection, Cancel, 120-second timeout, and quote/backslash/newline display. Owner passphrase/dialog interaction is still a separate gate; `ui-check` CLI is assigned to P-5a. Fake helper tests do not establish macOS dialog appearance, owner consent, real signature wiring, settlement/finality, Linux product support, or publish readiness. Whole socket/TCP/crash suites, Docker, NEW separate read-only review, checkpoint-first sabotage and commits remain parent follow-ups; no sabotage or commit was performed in this author run.

Author validation on this P-4a source:

- RED with behavior stubs: `vitest run test/unit/osascript-script.test.ts test/unit/parse.test.ts test/unit/render.test.ts`: 9 failed / 20 total, exit 1. `vitest run test/wire/ui-spawn.test.ts`: 11 failed / 15 total, exit 1. `vitest run test/unit/ui-wiring.test.ts`: 1 failed / 1 total, exit 1. Each used `../../node_modules/.bin/vitest` from this package.
- After implementation the first four focused files passed 35/35; with production wiring, five files passed 45/45. The exact-environment test first detected Node's macOS-added variable; the owned C launcher fixes the observation point without loosening its assertion.
- Final expanded command below: 15 files, 278 passed, zero failed/skipped, exit 0. This includes the additional UTF-8/BOM and default-path cases (48 final P-4a tests plus 230 existing regressions).
- `../../node_modules/.bin/tsc --noEmit -p tsconfig.json` and `../../node_modules/.bin/tsc -p tsconfig.build.json`: exit 0. `git diff --check`: exit 0. Offline pack was not needed/run; its isolated build fixture and all remaining compiled-bin tripwire rows are unchanged.

```sh
../../node_modules/.bin/vitest run test/unit/osascript-script.test.ts test/unit/parse.test.ts test/unit/render.test.ts test/unit/ui-wiring.test.ts test/wire/ui-spawn.test.ts test/unit/record.test.ts test/unit/purchase.test.ts test/unit/recovery.test.ts test/unit/startup-order.test.ts test/unit/startup-purchase.test.ts test/unit/summary.test.ts test/unit/keys.test.ts test/unit/result-secrets.test.ts test/unit/daemon.test.ts test/unit/secrecy-scan.test.ts
```
# P-4b retained shim gate

Author execution is pure/in-memory/file/process only. Parent runs the following after
source readback and a fresh build on macOS and Docker (Linux is not product support):

```sh
npm run types
npm run build
npm test -- --run test/wire/shim.test.ts test/wire/approval-sabotage.test.ts test/wire/bytes.test.ts test/wire/startup.test.ts
```

`shim-wire.ts` connects the installed SDK Client to compiled `bin.js mcp`, a separate
`daemon-test-entry.ts` child, the production Unix protocol and the existing local TCP
Router fixture. Approval rows use `shim-observe-entry.ts`: it traps subprocess/UI
attempts, then calls the real bin dispatch and production stdio shim. Its loader-only
argv substitution is confined to `test/`; the compiled entry has no override.
All keys/HOMEs are newly generated fixtures. UI and signer remain fake.

Counters are durable files from the separate daemon and the instrumented shim;
socket records contain actual validated requests. Rejection assertions require zero
signer calls, no `sign_intent`, and independently counted daemon/shim UI calls.
Wrong-display binding changes the displayed record amount and hashes it; it is not
an unrelated schema failure. Raw `yes` and owned PTY rows run the same observed shim.
The PTY fixture requires Python 3, opens only its child PTY, and never drives a GUI.
AC-A2(e)/(i) reuse the exact P-3a compiled-bin/preload rows in `startup.test.ts`, including
the distinct Darwin pre-main loader oracle; these rows must run with the new suite.

Author measurement through actual SDK Client/InMemoryTransport + production handler/core
and a real synthetic file ledger: **2691 UTF-8 bytes** (routes388 + quote521 + purchase891
+ status891), static route1/hold1 and serialized body2048. Count includes every text
content entry and JSON structuredContent. `bytes.test.ts` measures the separate wire
path independently; author has **not executed any wire test**.

Timeout chain: optional SDK display5s → shim socket185s, daemon active request180s
(UI120s + Router30s + margin), daemon idle35s only outside an active request.
Fixture Client allows195s. Other clients must configure their own timeout; a shorter
client timeout neither cancels daemon payment nor proves unpaid. Router timeout/retry,
approval expiry, session/lock guards and durable unknown recovery remain unchanged.

The four checkpoint-first production mutation gates remain parent-owned: forward an
elicitation response, remove metadata, expose a full quote, loosen purchase input.
Strict subject validation and actual byte measurement are separate assertions.
No native consent, live signature, settlement/finality or owner acceptance is claimed.

### P-5a CLI (bounded author / parent handoff)

`src/bin.ts` now dispatches `wallet new|address|balance`, `status [ref]`,
`inspect <ref> [--close]`, `config get|set`, `lock reclaim`, and `ui-check`.
Wallet creation requires two protected TTY passphrase entries; stdout is the
address only. Balance stdout is Base Sepolia USDC base units (6 decimals).
Offline inspection asks for the passphrase to authenticate/decrypt the ledger
and check the install seal, without opening the wallet secret. Online inspection
uses the daemon's strict read-only `inspect` socket Summary. This socket method
has no close/approval input and does not add an MCP tool (the five remain fixed).
Inspection may append reconciliation evidence but never signs or submits a
saved credential. `inspect --close` requires the daemon to be stopped, takes the
same store lock, shows safe evidence, reads a reason and requires literal `y`
from the protected TTY. The reason is sealed; it is not echoed in the Summary.

Human configuration syntax:

- `config get`
- `config set session.ttlMs 60000` (positive integer, maximum 3600000)
- `config set rails '["x402"]'` (the only enabled rail)
- `config set rpc.eip155:84532 https://sepolia.base.org/` (public HTTPS endpoint;
  production checks `eth_chainId` before the fixed USDC `balanceOf` call)
- `config set router.canonicalResource.url <canonical-resource-url>` followed by
  `config set router.url <transport-url>` when configuring another Router.
  The canonical path and GET method remain pinned; a nondefault transport
  cannot be saved without an explicit canonical resource. No response supplies it.

Every set requires a TTY, refuses live/stale/uncertain daemon locks, and applies
at the next daemon startup. `lock reclaim` asks for TTY confirmation and then
uses the production dead-owner/socket-before-lock checks. A leftover reclaim
guard is never automatically removed: stop **ALL contenders**, then human
**offline recovery** is required. Never touch the controller's worker.lock.
`ui-check` uses a temporary TTY passphrase and an in-memory synthetic verifier,
with fixed quote/backslash/newline text; only classification is printed. It has
no purchase/signature path. The five real native manual cases remain owner gates.

Author verification (owned files/in-memory only): initial `test/unit/cli.test.ts`
ran against the skeleton and genuinely failed all six fixed-code assertions;
the first shell setup attempt used a wrong relative path and is not counted as
RED. The added CLI tests inject process identity, TTY, RPC, daemon and helper
ports. No process inventory, sockets, GUI or external queries are used by them.
The only obsolete assertion migration is in `test/unit/pack.test.ts`: the two
launcher checks formerly expected `not implemented`; they now expect
`cli_refused: home_unavailable` under the same deliberately HOME-less environment.
The flag refusal, pack exclusions and signer dependency checks remain intact.
The pack test itself is retained for the parent, not run by this author.

Parent-only retained gate: after fresh build, run
`../../node_modules/.bin/vitest run test/wire/cli.test.ts` from `packages/payer`.
It contains real compiled-bin non-TTY checks, known-random encrypted wallet
subprocesses, an owned real PTY wallet creation, loopback RPC protocol and the
actual daemon/client socket path. `cli-entry.ts` and `cli-pty.py` are test-only;
the subprocess uses `process.execPath --import <resolved tsx>`, never the tsx CLI.
They are excluded by existing pack files/tsconfig rules. This wire gate and all
native GUI/manual, clean-install, macOS/Docker and owner-funded gates are **UNRUN**
by the bounded author. No acceptance is implied by the unit results.

Future checkpoint-first causal mutation oracles (do not mutate without the
controller's checkpoint/restore procedure):

- `cli-owned.test.ts`, `wallet exact address-only secrecy oracle`: successful
  creation must print exactly the computed address and no plaintext/base64/hex
  secret. Changing the address output to the key reaches this assertion.
- `cli-owned.test.ts`, `reclaim live-owner causal oracle`: synthetic same-start
  live owner, no socket, valid TTY `y`; requires `daemon_already_running` and
  byte-identical lock. Removing reclaimLock's `state.state === "held"` refusal
  reaches this protection oracle (the stale/reused-PID check is a separate case).
- `cli-owned.test.ts`, `inspect-close non-TTY causal oracle`: valid saved unknown
  evidence, valid ref, injected passphrase/reason/`y` reader with available=false;
  asserts no TTY read, Router read, closure or file mutation. Removing the
  runInspect `requireTty(tty)` guard reaches these assertions; no secondary
  synthetic-TTY check or invalid parser input masks it.

Next: parent source/diff/caller review, fresh macOS/Docker fixtures, NEW independent
read-only review and corrections, checkpoint-before-three-mutations with exact
restore, then P-5b. The earlier controller milestone/checkpoint evidence is not
relabelled as this author's test execution.

Lock API note: the production CLI calls `reclaimLock(dir, deps, true)` to require
positive dead-owner identity even without a leftover socket. This trusted module
argument is not accepted from argv/env/socket. Existing low-level reclamation
fixtures retain their historical default; socket reclamation keeps its existing
mandatory checks. CLI writes and daemon startup independently refuse a leftover
reclaim guard before acquiring a new owner lock. The existing two-contender
interleaving tests remain unchanged.

Recorded author command results (all from `packages/payer`; exit 0 unless RED):

- Initial RED: `../../node_modules/.bin/vitest run test/unit/cli.test.ts`:
  6/6 failed on the skeleton response, exit 1. Later added guard-diagnostic
  test also genuinely failed with `internal_error` before its implementation.
- CLI: `../../node_modules/.bin/vitest run test/unit/cli.test.ts test/unit/cli-owned.test.ts`:
  final sources contain 50 tests, all included in the final 96-test GREEN below.
- Focused regression: `../../node_modules/.bin/vitest run test/unit/recovery.test.ts test/unit/purchase.test.ts test/unit/summary.test.ts test/unit/handler.test.ts test/unit/shim.test.ts test/unit/reclaim-socket.test.ts test/unit/startup-order.test.ts test/unit/parse.test.ts test/unit/osascript-script.test.ts`:
  9 files / 213 PASS.
- Pure lock selection: `../../node_modules/.bin/vitest run test/unit/lock.test.ts -t '^(?!.*two processes racing)(?!.*psStartedAtOf).*'`:
  18 PASS; the actual process race and ps tests are deliberately UNRUN, not new skips.
- Final affected regression: `../../node_modules/.bin/vitest run test/unit/cli.test.ts test/unit/cli-owned.test.ts test/unit/startup-order.test.ts test/unit/reclaim-socket.test.ts`:
  4 files / 96 PASS (includes CLI 50). `npm run types`, `npm run build`, and
  root `git diff --check`: PASS. These runs overlap; do not add their counts.

No new tool/provider/sandbox refusal occurred. An initial relative-path setup
error and one TypeScript ProcessEnv/PathsEnv mismatch were corrected. No existing
wallet, auth file, paid API, remote service, real GUI, process inventory or
controller-owned state was used. No commit or acceptance claim was made.

P-5a FIX1 (test-only): `cli-pty.py` now tracks PTY EOF/drain separately from
owned-child reap, with the original monotonic 20-second deadline. EOF/EIO waits
for that child; observed exit still drains final output. Cleanup never signals
a reaped/lost child and closes the descriptor once. Helper failures emit fixed
codes; `cli-pty-result.ts` adds only fixed classification/code/signal to the
wire assertion, retaining exit 0, two prompts, one address and secret exclusion.

New test-only snapshot sources: `test/fixtures/cli-pty-lifecycle.py`,
`test/harness/cli-pty-result.ts`, `test/unit/cli-pty.test.ts`. The Python harness
injects fork/exec/select/read/write/waitpid/kill/close/clock; it opens no actual
PTY and forks no child. Vitest runs that pure harness in an owned Python process.
From the repository root, `python3 packages/payer/test/fixtures/cli-pty-lifecycle.py`
genuinely failed 3/3 against the unchanged original helper (exit 1): premature
EOF/EIO deadline and lost final address after exit. After correction, those
three passed; expanded lifecycle/cleanup/secrecy coverage passed 7/7 (exit 0).
From `packages/payer`, `../../node_modules/.bin/vitest run test/unit/cli-pty.test.ts`
passed 2/2 (exit 0), including the same seven Python cases; counts overlap.
Payer `npm run types` and `npm run build`, and root `git diff --check`, all
exited 0. Comparing all 449 round1 source hashes found only the helper, wire
test and this README changed; production sources remain byte-identical.

This is pure causal evidence, not wire evidence. Parent source readback, fresh
immutable round2 macOS/Docker execution, a NEW separate independent read-only
review and substantive corrections remain required before the checkpoint,
three mutations/exact restore and P-5b. Real PTY/wire, live/dead reclaim and
durable inspect-close controls, native/manual and owner gates remain UNRUN by
this author; no acceptance is claimed.

P-5a FIX2 retained rows (author wire execution **UNRUN**):

- Saved authenticated `unknown` → compiled `status`/`inspect` child → real Unix
  socket → production handler/core → fakeRouter TCP, for matching terminal,
  valid-but-different fingerprint, unreadable and true `not_found`. Startup
  reconciliation remains enabled and must account for exactly one status read;
  each CLI then adds one read with the saved paymentId and zero purchases.
- A separate OFFLINE compiled CLI/PTY opens seeded `signed` evidence, observes
  true `not_found`, saves `unknown`, then a NEW CLI reopens it. No daemon boot or
  signature is used. The legitimately absent seal is created by the actual CLI
  using its installation hashes and must remain unchanged on reopen.
- Compiled CLI/PTY rejects live-owner `y` and stale-owner `n`, preserving file
  bytes/inodes and socket. Only the fixture-owned daemon is killed, with its
  original PID/start identity, and actual exit/stdio close is awaited. Confirmed
  stale reclaim uses `cli-lock-entry.ts`: it imports real `runLock`, real TTY,
  production liveness and realFs, observing successful socket-before-lock
  unlinks with the matched owner/inodes. Other store files and a disposable
  worker.lock sentinel survive; the actual workflow lock is never accessed.
- Compiled CLI/PTY `config set router.url` (explicit canonical resource, valid
  alternate loopback URL) and retained `session.ttlMs` both require exact active
  daemon refusal, unchanged config/lock and continued ping. After that daemon
  closes, the same URL succeeds offline without any Router request.
- OFFLINE compiled `inspect --close` with synthetic PTY answers checks cancel,
  confirmed sealed reason, durable closure and a NEW CLI reopening. Purchase
  count stays zero. This is fixture consent, not owner consent or native UI.

`cli-evidence.ts` seeds only disposable authenticated ledger evidence using the
existing owned store/ledger/record helpers. The CLI outputs/errors and validated
plaintext ledger projections use the existing plaintext/base64/hex AC-A9 scan,
including known key/passphrase/phrase/credential/ownerKey/full challenge; the
ownerKey is synthetic metadata, not a claim of dynamic-route support. The
existing encrypted-envelope authentication exemption is unchanged. All test
entries remain outside published files/build output.

`cli-pty.py` retains independent EOF/drain/reap and monotonic deadlines, now
accepting fixed prompt/answer scripts and returning only parsed, secret-scanned
JSON/fixed refusals. Output is bounded; cleanup preserves the primary failure
and never signals after reap/ECHILD. `children.ts` attaches observers before
start-identity lookup and bounds output/messages. These shared harness changes
require the parent's fresh full process gate, not just CLI wire execution.

FIX2 author checks: the allowed three CLI unit files passed 52/52 (including
the expanded 10-case pure Python lifecycle harness); owned-file-only
`npm test -- test/harness/cli-evidence.test.ts` passed 2/2. The latter validates
fixture rehydration and causal secret scanning only, not CLI acceptance.
An initial type check found a fixture GET literal typing error, corrected only
in the test helper. Final payer `npm run types`, `npm run build` and root
`git diff --check` exited 0. After the final cleanup change,
`npm test -- test/unit/cli-pty.test.ts` again passed 2/2 (overlapping count).
No production source changed; no real PTY/socket/TCP/process inventory, Docker,
GUI, mutation, commit or publication was executed by this author. Parent fresh
round3 macOS/Docker, NEW independent review, checkpoint, three mutations/exact
restoration and P-5b remain required. No P-5a acceptance is claimed.

### P-5b onboarding and clean-install gates

This is the controller-directed permission reconciliation for P-5b, not a new
owner approval or a claim that P-5b is accepted. P-5a prerequisite evidence belongs
to the parent: review2 APPROVE; source-bound macOS/Docker focused115/fullpayer691/
root-focused50/types/build, then exact455source checkpoint before the three guard
mutations, exact restoration and macOS full GREEN. Those are not author results.

The public-facing payer README describes only macOS 14+, Node 22, Base Sepolia
USDC and static `md-mpp-eth-snapshot`. The package was published as 0.1.0 on 2026-10-10 (G-A1).
Native manual5 passed on 2026-10-10 (after the give-up fix in PR #142) and G-A1/npm
publication is done. Real-signature wiring and G-A2 funded owner-dialog acceptance
remain **UNRUN**. A Linux refusal is not Linux product support.

Author-safe focused command, from `packages/payer` (explicit files only):

```sh
../../node_modules/.bin/vitest run test/wire/readme-commands.test.ts test/unit/deps.test.ts test/unit/cli-pty.test.ts test/unit/install-harness.test.ts test/unit/pack.test.ts
npm run types
npm run build
```

`readme-commands` reads fenced commands and the real dispatcher AST; it never
executes Claude or the payer. The installed `claude mcp add --help` was read only
to confirm `--scope user`; no registration/auth/model command was executed.
`pack` retains its AST exclusions, signer transitive import boundary (with the
existing `vendor.test.ts`), exact file allowlist and isolated-build/shared-dist
metadata invariants. Test helpers stay outside the tarball. Dependency pins are
compared with the payer shrinkwrap and matching root-lock entries. The audit
case is gated and a skip is not a zero-vulnerability result.

After source readback, the controller's registry/PTY/SDK installation gate is:

```sh
PAYER_CLEAN_INSTALL=1 ../../node_modules/.bin/vitest run test/wire/clean-install.test.ts -t '^clean install:'
PAYER_AUDIT=1 ../../node_modules/.bin/vitest run test/unit/deps.test.ts
```

Clean install builds a **copy of current source**, never shared `dist`, then
packs it and installs the tarball into the global layout with registry dependencies.
**Install method (owner decision 2026-10-10):** `npm install --global <tarball>`
ignores the tarball's npm-shrinkwrap.json (arborist only honours a shrinkwrap when the
manifest carries `_hasShrinkwrap`, which the registry sets on publication), so it
resolved express 5.3.0 instead of the locked 5.2.1 once 5.3.0 was published.
`installLocked` therefore extracts the tarball into `<prefix>/lib/node_modules/@subetha/payer`,
runs `npm ci --omit=dev` there (the shrinkwrap is the lockfile) and links
`<prefix>/bin/subetha-payer` relatively, as npm does. The registry path is checked
against the shrinkwrap at G-A2 after publication. Each run
has a fresh HOME, cache, prefix, temporary directory and empty user/global npm
config, an explicit environment, no inherited npm auth/config, no host HOME
mount, no retries and bounded owned subprocesses. The install uses normal scripts
and fails on `node-gyp`, `prebuild`, `binding.gyp` or any installed `.node` file.
It compares the installed shrinkwrap, every transitive package identity and the
packed runtime bytes. Its SDK Client communicates with the **installed
prefix/bin/subetha-payer mcp** over SDK stdio framing and checks exactly five
schemas, purchase metadata and daemon_unavailable for all five tools. No daemon
or external Router is started. There are no product mocks, spies, hooks, source
entry substitutes or environment approval bypasses.

`cli-pty.py` reuses its owned PTY lifecycle but executes the installed shell
launcher directly. Only synthetic random passphrases pass through the fixture's
private stdin; the product receives them via its owned TTY. stdout is captured
separately in an owned 0600 file and must contain exactly one address. The terminal
must contain only two prompts. The fresh encrypted keys document is independently
authenticated in the test; known secret bytes/base64/hex are excluded from output
and disk plaintext. No secret is emitted in assertion diagnostics. The synthetic
HOME and stdout file are removed; private tarball path/hash, phase results,
source copy, prefix and cache remain under ignored `.claude_workflow/local/p5b-install/`
for controller readback and checkpoint-first mutations. Do not publish these raw
receipts. Subprocess cleanup awaits exit and stdio close and preserves the primary
failure. The pure Python lifecycle cases do not execute a real PTY.

The audit command contacts the registry using a separate fresh isolated config
and cache, auditing **the payer's own production shrinkwrap** with
`--package-lock-only --omit=dev --audit-level=high --json`. Only an actual complete
result with high + critical = 0 can pass; unavailable/malformed/failed audit is
reported as failure, never zero. It never audits the host/root project tree.

**Native measurement split:** On macOS, clean install runs wallet/MCP/pack but
**does not run `daemon --check`**, because even its availability probe calls
osascript/System Events. On Linux the unmodified installed artifact may run that
command and must return exactly exit2 / `startup_refused: no_confirmation_ui`,
because the platform gate precedes helper execution. This is non-native refusal
evidence only. After separate explicit owner permission, the retained native row
can target a baseline installed bin:

```sh
PAYER_OWNER_NATIVE_CHECK=1 PAYER_INSTALLED_BIN="$payer_installed_bin" ../../node_modules/.bin/vitest run test/wire/clean-install.test.ts -t '^OWNER ONLY:'
```

Set `PAYER_OWNER_NATIVE_EXPECT=no_confirmation_ui` only when that is the declared
expected environment; default expects real availability success. A gate switch
is not permission. This row is **UNRUN/owner-only** and does not replace the five
P-4a manual dialog cases or funded G-A2 approval.

After NEW cumulative independent read-only review, fixes/retests and a local
checkpoint **before any mutation**, the controller can copy the retained
`package/` into a separate candidate directory. Change just the copied launcher
exec line (remove `--disable-sigusr1`) or just the copied manifest (remove `dist`
from `files`). Do not change the baseline or shared source. Then run:

```sh
PAYER_MUTATION_EXPECT=sigusr1_enabled PAYER_MUTATION_SOURCE="$payer_candidate" PAYER_BASELINE_RECEIPT="$payer_baseline_receipt" ../../node_modules/.bin/vitest run test/wire/clean-install.test.ts -t '^checkpoint-only'
PAYER_MUTATION_EXPECT=missing_dist PAYER_MUTATION_SOURCE="$payer_candidate" PAYER_BASELINE_RECEIPT="$payer_baseline_receipt" ../../node_modules/.bin/vitest run test/wire/clean-install.test.ts -t '^checkpoint-only'
```

Use a separate fresh candidate for each row. The harness checks that all other
runtime bytes match the baseline, repacks and installs to a fresh prefix **offline
using only that baseline's clean cache**, then executes the installed launcher.
The first oracle requires exact exit2/sigusr1_enabled before native helper access;
the second requires an actually absent installed dist and the launcher's real
exit1/MODULE_NOT_FOUND. Normal baseline checks must fail for these changes; these
negative rows establish the cause without starting a macOS native probe. For the
third mutation, change the README registration bin and run `readme-commands`:
its parsed bin/argv assertion must fail. Restore exact checkpoint bytes and rerun
the appropriate baseline checks. No mutation was executed by this author.

Parent follow-up order remains source/diff readback → actual isolated clean
install + macOS/Docker gates → NEW cumulative review of P-4a/b, P-5a/b and retained
safety callers → corrections/retests → local checkpoint → three mutations →
exact restore. No publication, payment or final native acceptance is claimed.

P-5b author execution record (counts overlap; do not add them):

- Genuine initial RED: `../../node_modules/.bin/vitest run test/wire/readme-commands.test.ts`
  failed **2/2**, exit 1, because the required payer README did not exist.
- First GREEN selection: README/deps/CLI-PTY, **5 pass / 1 audit skip**, exit 0.
  Adding the existing offline pack rows gave **12 pass / 1 audit skip**, exit 0.
- After npm-environment/allowlist hardening and owned-process helper tests:
  **15 pass / 1 audit skip**, exit 0.
- Final expanded argv:
  `../../node_modules/.bin/vitest run test/wire/readme-commands.test.ts test/unit/deps.test.ts test/unit/cli-pty.test.ts test/unit/install-harness.test.ts test/unit/pack.test.ts test/unit/vendor.test.ts`:
  **6 files / 20 pass / 0 fail / 1 skip (audit gate)**, exit 0. Includes the
  13-case pure Python lifecycle harness (no actual PTY), new isolated build/pack,
  owned-process closure/deadline checks and existing transitive signer graph.
- `../../node_modules/.bin/vitest run test/wire/clean-install.test.ts` with all
  execution gates unset: **3 skipped**, exit 0. Collection only; clean install,
  native and mutation runtime checks remain UNRUN, not successful wire results.
- Payer `npm run types`, `npm run build`, root `git diff --check`: exit 0.
  Shared build ran only after the isolated pack tests finished.
- Three shell file-writing setup attempts used a package-relative cwd with a
  repository-relative filename and failed before writing; all were corrected.
  They are not RED behavior tests. No network install/audit or native probe ran.
  The first existing offline pack execution preceded the npm-environment
  tightening; the final pack execution used fresh HOME and empty npm configs.

Production sources, package version/private flag and dependency versions were
unchanged. No new provider/tool refusal, quota retry, worker, commit, publication,
funding, signing, broadcast, external Router/RPC or controller lock mutation was
performed. Historical held refusals remain held. Actual clean-install/audit,
macOS/Docker wire and owner native/funded evidence are still parent/owner work.

### P-5b FIX1: ws dependency correction (author-only, acceptance pending)

The following parent evidence applies to the original P-5b inputs, before FIX1;
it is not this author's execution or evidence for the corrected tarball. Parent
macOS types/build and focused checks passed (20 PASS / 1 audit SKIP). The fresh
registry install in `.claude_workflow/local/p5b-install/clean-fNobGi/receipt.json`
passed with 107 physical transitive identities and unchanged installed wallet/SDK
MCP checks. Its tarball SHA-256 was
`84970921575d81cfd00c7361d310d27efc0d381af9e082bb80d2dab54836b31a`.
Native and mutation rows were skipped; no owner UI or payment was tested.

The parent's real audit **FAILED**, exit 1, high 2 / critical 0, recorded in
`.claude_workflow/local/p5b-install/audit-Yw9UER/receipt.json` and
`.claude_workflow/local/p5b-parent-round1/macos-audit.log`. Fail-fast stopped the
full payer/root/Docker gates. The separate retained diagnostic in
`.claude_workflow/local/p5b-audit-diagnostic1/{audit.json,receipt.json}` identified
`GHSA-96hv-2xvq-fx4p`: ws memory-exhaustion DoS, affected `>=8.0.0 <8.21.0`.
The locked ws 8.20.1 and its dependent viem 2.54.0 account for high 2: one advisory
plus dependent impact, not two independent advisories. Historical receipts/logs
remain unchanged. P-5b was not accepted.

FIX1 adds only payer `overrides.ws: "8.22.0"` and replaces its shrinkwrap
`packages["node_modules/ws"]` with the **entire existing root package-lock entry**.
The version, resolved URL (`https://registry.npmjs.org/ws/-/ws-8.22.0.tgz`),
integrity and remaining metadata come from that local root entry, whose policy
is already `overrides.ws: "8.22.0"`. No integrity was invented and these are
**copied bytes/metadata, not an npm-generated or registry-normalized lock**.
The copied integrity is
`sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==`.
Root manifest/lock, every other payer lock entry, viem 2.54.0 (including its
upstream `dependencies.ws: "8.20.1"` declaration), private/version and production
source remain unchanged. The new file-only test requires the exact root policy,
full ws metadata identity and no additional nested ws node. All original audit
assertions and the zero-high/critical gate remain unchanged.

FIX1 author results (cwd `packages/payer`; overlapping counts):

```sh
../../node_modules/.bin/vitest run test/unit/deps.test.ts -t '^payer ws safety pin'
env -u PAYER_AUDIT ../../node_modules/.bin/vitest run test/wire/readme-commands.test.ts test/unit/deps.test.ts test/unit/cli-pty.test.ts test/unit/install-harness.test.ts test/unit/pack.test.ts test/unit/vendor.test.ts
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
../../node_modules/.bin/tsc -p tsconfig.build.json
```

- Genuine RED, before manifest/lock correction: first command **1 failed / 2
  skipped, exit 1**, detecting the absent override, old ws version and old
  metadata. The identical command after correction: **1 passed / 2 skipped,
  exit 0**. The name filter excludes the existing direct-pin and audit rows.
- Expanded second command: **6 files / 21 passed / 1 audit skipped, exit 0**.
  Only allowed file/offline-pack/owned-process checks ran; CLI-PTY uses the pure
  injected Python lifecycle harness, not a real PTY.
- Both TypeScript commands: **exit 0**, after offline pack checks completed.
  No registry request, install, audit, lock generation, native probe, wire gate,
  payment, mutation, additional worker, commit or publication ran in FIX1.

**Parent normalization and actual verification remain mandatory.** After source
readback, copy the corrected manifest/shrinkwrap into a fresh isolated directory
with fresh HOME/cache/prefix and empty user/global npm config, without inherited
auth or existing node_modules. Resolve through the registry using
`npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund`
there, preserving the original copy for a full comparison. Record npm version,
exit and any normalized differences; verify the resolved ws metadata, unchanged
viem declaration and all other package entries before accepting the lock. Do not
silently copy unexpected resolution changes back into the shared source.

An override in a dependent package is not equivalent to an install-root override.
Therefore normalization alone is insufficient: repack the corrected source,
actually install the unchanged tarball using the retained clean-install gate,
and verify its shrinkwrap bytes and **entire installed physical tree**, including
ws 8.22.0 and absence of a nested vulnerable copy. Then run the real isolated
payer audit with the original zero-high/critical assertions. FIX1 does not claim
high 0 or corrected-install success. Fresh corrected-source macOS/full payer/root
and Docker evidence remains pending as well.

Required order: parent readback → isolated corrected lock normalization/install/
audit/macOS/Docker verification → **NEW separate cumulative read-only P-4/P-5
review** → substantive fixes/retests → checkpoint **before** the three mutations
→ exact restore and baseline checks. P-4a manual five, P-5b native check, G-A1/npm
and G-A2 remain owner gates; no release or native/funded acceptance is claimed.

## P-5b FIX2 — consumer-compatible upstream patch (2026-10-09)

The FIX1 section above is historical, not the current dependency contract.
Parent npm 10.9.8 COPY normalization was byte-identical (exit 0;
`.claude_workflow/local/p5b-normalization1/receipt.json`), but round2 global
installation exposed physical ws **8.20.1** while the packed lock said 8.22.0.
Install itself exited 0; the unchanged physical identity oracle failed at
`install.ts:118` (`p5b-parent-round2/results.json` and
`p5b-install/clean-szKipt/receipt.json`, under the same local directory).
Installed wallet/MCP were not reached; full payer/audit/root/Docker stopped
fail-fast. A dependent package's override did not enforce the consumer tree.

Parent candidate1 retained top ws 8.22.0 plus nested viem/ws 8.21.0; candidate2
installed as a single top ws 8.21.0 and failed exact tree equality. Candidate3
instead started from the original pre-FIX1 `clean-fNobGi/package` manifest/lock,
changed only viem 2.54.0 → **2.54.2**, and used isolated npm lock generation.
Saved registry metadata establishes that 2.54.1 still declares ws 8.20.1;
2.54.2 declares **8.21.0**, with all other viem dependencies unchanged.

Parent candidate3 normalization/pack/global install/107-package physical identity,
installed shrinkwrap byte equality and registry audit passed (all severities 0,
each command exit 0; `p5b-viem-candidate3/receipt.json`, Unix
1791547854.4738219–1791547859.5990021). This is candidate evidence only: no
wallet, SDK, UI, real signature or current new-source full-suite acceptance.

FIX2 adopts exactly candidate3's `package/package.json` and
`package/npm-shrinkwrap.json`, with no override and one ws 8.21.0 node. Author
readback SHA-256 matches the parent:

- manifest: `26d167b36bf00f6ea6ccd932ae40e02df4ecae5054e8085198794deb4eff30f6`
- shrinkwrap: `25c2ea34778685d3239a4877bd18b17edec038befbe2be3d0f7ae2e578ca74dc`

The actual lock delta matches `lock-delta.json`: root entry, viem and ws only
versus pre-FIX1; all other nodes and top-level lock metadata are unchanged.
Root manifest/lock, payer production/vendor bytes and private/version remain
unchanged. Retained tests embed the authentic published version/URL/integrity,
require manifest/lock consistency and preserve root version/integrity equality
for every other shared direct dependency. Only viem has the explicit 2.54.2
exception. Vendor byte/import-graph exclusions, physical-tree identity and
high + critical = 0 audit assertions are unchanged. No ignored receipt is needed
by the retained tests in a fresh checkout or Docker.

FIX2 author results (cwd `packages/payer`; counts overlap):

```sh
env -u PAYER_AUDIT ../../node_modules/.bin/vitest run test/unit/deps.test.ts test/unit/vendor.test.ts -t 'payer direct dependencies|payer consumer-compatible|package stays private'
env -u PAYER_AUDIT ../../node_modules/.bin/vitest run test/wire/readme-commands.test.ts test/unit/deps.test.ts test/unit/cli-pty.test.ts test/unit/install-harness.test.ts test/unit/pack.test.ts test/unit/vendor.test.ts
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
../../node_modules/.bin/tsc -p tsconfig.build.json
```

- First command, genuine file-only RED before adopting candidate3: **3 failed /
  4 skipped, exit 1** (old viem pin/integrity/declaration and override/ws policy).
  Identical command after adoption: **3 passed / 4 skipped, exit 0**; the filter
  excludes three unrelated vendor rows and the registry audit.
- Second command: **6 files / 21 passed / 1 audit skipped, exit 0**. Pack uses
  fresh copied source and offline isolated npm; CLI-PTY uses injected Python OS
  operations, not an actual PTY. Both TypeScript commands exited **0**.
- Author node_modules still contains **viem 2.54.0** and was not updated.
  Build/import checks therefore do **not** prove 2.54.2 runtime compatibility.
  No registry install/audit, native/socket/PTY test, additional worker, mutation,
  commit or publication ran in FIX2.

After author exit, Hermes must provision payer dependencies using isolated npm
config/cache, verify actual viem resolution, then run fresh current-source round3
macOS clean-install/audit/full payer/root and Docker gates. Correction acceptance
still requires a **NEW separate Codex cumulative read-only P-4/P-5 review**,
substantive fixes/retests and a checkpoint **before all three mutations**, followed
by exact restore and baseline checks. Native manual5, P-5b macOS native check,
G-A1/npm and G-A2 funded dialog remain owner-only. No release, native acceptance,
real-signature wire or settlement claim follows from these author results.
