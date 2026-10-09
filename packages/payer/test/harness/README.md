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
