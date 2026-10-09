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
