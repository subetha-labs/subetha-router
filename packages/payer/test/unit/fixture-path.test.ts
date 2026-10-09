import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { fixtureStore } from "../harness/store.js";

test("fixture socket path fits Darwin sun_path including NUL, without opening a listener", () => {
  const store = fixtureStore();
  try {
    expect(path.dirname(store.home)).toBe(realpathSync(tmpdir()));
    expect(realpathSync(store.home)).toBe(store.home);
    expect(path.basename(store.home)).toMatch(/^p3a-[a-zA-Z0-9]{6}$/);
    expect(lstatSync(store.dir).mode & 0o777).toBe(0o700);
    expect(Buffer.byteLength(path.join(store.dir, "daemon.sock")) + 1).toBeLessThanOrEqual(104);
  } finally { store.cleanup(); }
});
