import { expect, test } from "vitest";
import { fixtureDaemon, FIXTURE_REF, socketClient } from "../harness/daemon.js";
import { fakeRouter } from "../harness/router.js";
import { STATIC_ROUTE } from "../../src/router/client.js";

test("actual daemon socket stays available after session TTL; quote/status work and purchase remains locked", async () => {
  const fake = await fakeRouter();
  const daemon = await fixtureDaemon(fake.url, 3000).catch(async (error: unknown) => {
    await fake.close().catch(() => undefined);
    throw error;
  });
  const socket = socketClient(daemon.store.dir);
  try {
    expect(await socket.send("ping")).toMatchObject({ ok: true, result: { state: "unlocked" } });
    expect(await socket.send("quote", { routeId: STATIC_ROUTE })).toMatchObject({ ok: true, result: { ref: FIXTURE_REF } });
    expect(await socket.send("purchase", { ref: FIXTURE_REF })).toMatchObject({ ok: false, error: { code: "approval_unavailable" } });
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(await socket.send("ping")).toMatchObject({ result: { state: "locked" } });
    expect(await socket.send("purchase", { ref: FIXTURE_REF })).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(await socket.send("quote", { routeId: STATIC_ROUTE })).toMatchObject({ ok: true, result: { ref: FIXTURE_REF } });
    expect(await socket.send("status", { ref: FIXTURE_REF })).toMatchObject({ ok: true, result: { state: "quoted", fundsMoved: "no" } });
    expect(fake.state.calls.quote).toBe(2);
    expect(fake.state.calls.purchase).toBe(0);
  } finally { socket.close(); await daemon.cleanup(); await fake.close(); }
});
