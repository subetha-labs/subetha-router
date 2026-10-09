import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { RouterClient, STATIC_ROUTE } from "../../src/router/client.js";
import { fixtureDaemon, FIXTURE_REF, socketClient } from "../harness/daemon.js";
import { fakeRouter } from "../harness/router.js";

// Bounded P-3a transport measurement only. Full NF-A2 quote + successful purchase cannot run
// while P-3b purchase is fail-closed. This is not evidence for that later gate.
test("five-sample median socket/SDK overhead <=1000ms: 300ms quote + locally refused purchase", async () => {
  const fake = await fakeRouter();
  fake.state.delayMs = 300;
  const daemon = await fixtureDaemon(fake.url).catch(async (error: unknown) => {
    await fake.close().catch(() => undefined);
    throw error;
  });
  const socket = socketClient(daemon.store.dir);
  const direct = new RouterClient(fake.url);
  const deltas: number[] = [];
  try {
    for (let sample = 0; sample < 5; sample++) {
      let start = performance.now();
      expect(await direct.quote(STATIC_ROUTE, randomUUID())).toMatchObject({ ok: true });
      const baseline = performance.now() - start;
      start = performance.now();
      expect(await socket.send("quote", { routeId: STATIC_ROUTE })).toMatchObject({ ok: true });
      expect(await socket.send("purchase", { ref: FIXTURE_REF })).toMatchObject({ error: { code: "approval_unavailable" } });
      deltas.push(performance.now() - start - baseline);
    }
    expect(deltas.sort((a, b) => a - b)[2]).toBeLessThanOrEqual(1000);
    expect(fake.state.calls.quote).toBe(10);
    expect(fake.state.calls.purchase).toBe(0);
  } finally { socket.close(); await daemon.cleanup(); await fake.close(); }
});
