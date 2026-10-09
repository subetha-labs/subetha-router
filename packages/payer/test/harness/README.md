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

`fixtureReads` supplies a fixed ref and a read-model projection through the actual socket/SDK path. This is not P-3b's durable ApprovalRecord/ref generator. Purchase always runs the production fail-closed handler: unknown refs fail, known refs are `approval_unavailable`, and expired sessions are `locked`. No fixture sends a Router purchase or signs anything. Production uses the same startup/listener/client, with native UI unavailable until P-4a and quote-record creation unavailable until P-3b. Successful fixture startup is **not owner-native readiness**.

Two portions remain held:

- Design §3.4 says both `p_ + base32(randomBytes(8))` and 13 total characters. Eight bytes normally encode to 13 base32 characters before the two-character prefix (15 total); the existing `PurchaseRef` requires 13 total. Ref generation remains P-3b work; no format change is made here.
- Tasks NF-A2 measures quote + purchase through the daemon versus directly. This slice is explicitly required to refuse purchases. The retained latency test measures five samples of 300ms quote + local purchase refusal with median delta ≤1000ms, and positive quote/zero-purchase counters. It is a transport overhead test, **not the complete NF-A2 acceptance gate**.

Source review, macOS/Docker actual wire execution, packaging/process regressions, sabotage, and any commit remain parent follow-ups. The full suite must not be reported green from pure unit results.
