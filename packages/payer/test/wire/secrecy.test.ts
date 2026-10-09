import { expect, test } from "vitest";
import { recoveryFixture, statusProjection } from "../harness/recovery.js";
import { STATIC_ROUTE } from "../../src/router/client.js";
import { containsSecret, encodeSecret, encodings, secretBody } from "../harness/secret-cases.js";

test("AC-A9 real daemon secrets absent from replies/errors/stderr/plain ledger in plaintext/base64/hex", async () => {
  let key = Buffer.alloc(0);
  const f = await recoveryFixture(undefined, value => { key = Buffer.from(value); });
  try {
    const challenge = JSON.stringify((f.router.state.quote as any).quote.source.offer);
    // Unknown metadata really crosses TCP and is sealed, never projected to the caller.
    f.router.state.quote["secretFixture"] = { key: key.toString("hex"), passphrase: f.store.passphrase, phrase: f.store.phrase, challenge, credential: "fixture-credential" };
    const replies: unknown[] = [];
    const q = await f.socket.send("quote", { routeId: STATIC_ROUTE }); replies.push(q); expect(q.ok).toBe(true);
    replies.push(await f.socket.send("purchase", { ref: q.result.ref }));
    replies.push(await f.socket.send("status", { ref: q.result.ref, includeBody: true }));
    replies.push(await f.socket.send("purchase", { ref: q.result.ref, approved: true }));
    const firstOutput = f.child.stdout + f.child.stderr;
    const secrets = [key.toString("hex"), key.toString("base64"), f.store.passphrase, f.store.phrase, "fixture-credential", challenge];
    const scan = () => {
      const plain = f.plainRows();
      const exposed = [replies, plain, JSON.stringify(replies), JSON.stringify(plain), firstOutput, f.child.stdout, f.child.stderr];
      for (const secret of secrets) expect(containsSecret(exposed, secret)).toBe(false);
    };
    // Causal sabotage observation: do not let failed rehydrate hide plaintext sealed content.
    scan(); await f.crash(); scan(); await f.restart();
    replies.push(await f.socket.send("status", { ref: q.result.ref, includeBody: true })); scan();
  } finally { key.fill(0); await f.close(); }
}, 30_000);

for (const source of ["challenge", "escaped-phrase"] as const)
for (const encoding of encodings)
for (const path of ["purchase", "status"] as const) test(`real body/projection refuses ${source}/${encoding}/${path} and survives same-store restart`, async () => {
  const phrase = 'synthetic"phrase\\tail';
  const f = await recoveryFixture(path === "status" ? "transport:after-response" : undefined, undefined, undefined, phrase);
  try {
    const quote = (f.router.state.quote as any).quote;
    const secret = source === "challenge" ? JSON.stringify(quote.source.offer) : phrase;
    const encoded = encodeSecret(secret, encoding);
    if (source === "challenge" && encoding === "base64") expect(encoded.includes(Buffer.from(quote.source.offer.extra.challengeNonce).toString("base64"))).toBe(false);
    const body = { ...secretBody(encoded, "value"), keys: secretBody(encoded, "key") };
    if (path === "purchase") f.router.state.body = body;
    const q = await f.socket.send("quote", { routeId: STATIC_ROUTE }); expect(q.ok).toBe(true);
    const replies = [q]; const outputs: string[] = [];
    const scan = () => {
      const plain = f.plainRows();
      expect(containsSecret([replies, plain, JSON.stringify(plain), outputs, f.child.stdout, f.child.stderr], secret)).toBe(false);
    };
    const pending = f.socket.send("purchase", { ref: q.result.ref }); void pending.catch(() => undefined);
    if (path === "status") {
      await f.child.waitFor("transport:after-response"); expect(f.counts().purchase).toBe(1);
      scan(); outputs.push(f.child.stdout + f.child.stderr); await f.crash(); await pending.catch(() => undefined);
      const projection = statusProjection(quote); projection.projection.result = body as any; f.router.state.status = projection;
      scan(); await f.restart();
    } else replies.push(await pending);
    const reply = await f.socket.send("status", { ref: q.result.ref, includeBody: true }); replies.push(reply);
    expect(containsSecret(reply, secret)).toBe(false); expect(reply.result.state).toBe("unknown");
    scan(); outputs.push(f.child.stdout + f.child.stderr); await f.crash(); scan(); await f.restart();
    const replay = await f.socket.send("status", { ref: q.result.ref, includeBody: true }); replies.push(replay);
    expect(containsSecret(replay, secret)).toBe(false); expect(replay.result.state).toBe("unknown");
    replies.push(await f.socket.send("purchase", { ref: q.result.ref })); scan();
    expect(f.counts()).toMatchObject({ sign: 1, purchase: 1 });
  } finally { await f.close(); }
}, 30_000);

test("real static quote refuses actual quote.ownerKey location without projecting or signing", async () => {
  const f = await recoveryFixture(); const key = "synthetic-owner-only-key-0123456789";
  try {
    (f.router.state.quote as any).quote.ownerKey = key;
    f.router.state.body = secretBody(key, "value");
    const reply = await f.socket.send("quote", { routeId: STATIC_ROUTE });
    expect(containsSecret([reply, f.plainRows(), f.child.stdout, f.child.stderr], key)).toBe(false);
    expect(reply.ok).toBe(false); expect(f.counts()).toMatchObject({ sign: 0, purchase: 0 });
  } finally { await f.close(); }
}, 30_000);

test("real ordinary escaped nested body survives saved offline replay", async () => {
  const f = await recoveryFixture(undefined, undefined, undefined, 'synthetic"phrase\\tail');
  try {
    const body = { ...secretBody('ordinary"text\\path', "value"), keys: secretBody('ordinary"key\\path', "key") };
    f.router.state.body = body;
    const q = await f.socket.send("quote", { routeId: STATIC_ROUTE }); expect(q.ok).toBe(true);
    expect((await f.socket.send("purchase", { ref: q.result.ref })).result.outcome).toBe("delivered");
    expect((await f.socket.send("status", { ref: q.result.ref, includeBody: true })).result.result.body).toEqual(body);
    await f.crash(); f.router.state.hang = true; await f.restart();
    expect((await f.socket.send("status", { ref: q.result.ref, includeBody: true })).result.result.body).toEqual(body);
    await f.socket.send("purchase", { ref: q.result.ref }); expect(f.counts()).toMatchObject({ sign: 1, purchase: 1 });
  } finally { await f.close(); }
}, 30_000);
