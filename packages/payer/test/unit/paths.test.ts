/**
 * P-1b（設計 §3.1 の 4、要件 FR-A3・SR-A6）: 置き場は env と home だけから決まり、symlink・mode・owner・home の外は拒む。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { realFs } from "../../src/store/fs.js";
import { ensureStoreDir, STORE_FILES, storeDirOf } from "../../src/store/paths.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "payer-home-"));
  temps.push(dir);
  return dir;
}
const uid = process.getuid?.() ?? 0;

describe("paths", () => {
  test("storeDirOf: XDG_CONFIG_HOME wins when absolute, else ~/.config; no HOME → home_unavailable; nothing from cwd", () => {
    expect(storeDirOf({ HOME: "/Users/x" })).toBe("/Users/x/.config/subetha-payer");
    expect(storeDirOf({ HOME: "/Users/x", XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/subetha-payer");
    expect(storeDirOf({ HOME: "/Users/x", XDG_CONFIG_HOME: "relative/xdg" })).toBe("/Users/x/.config/subetha-payer");
    expect(() => storeDirOf({})).toThrow(/home_unavailable/);
    expect(() => storeDirOf({ HOME: "relative" })).toThrow(/home_unavailable/);
  });

  test("ensureStoreDir refuses an absent HOME and does not create anything outside home", () => {
    const h = home();
    expect(() => ensureStoreDir(path.join(h, "nope", "store"), path.join(h, "missing-home"), uid, realFs)).toThrow(/home_unavailable/);
    const outside = mkdtempSync(path.join(tmpdir(), "payer-outside-"));
    temps.push(outside);
    const target = path.join(outside, "not-yet", "store");
    expect(ensureStoreDir(target, h, uid, realFs)).toEqual([{ path: target, code: "outside_home" }]);
    expect(realFs.existsSync(target), "nothing is created outside home").toBe(false);
  });

  test("ensureStoreDir creates the directory with 0700 and reports no issue; files with 0600 are fine", () => {
    const h = home();
    const dir = path.join(h, ".config", "subetha-payer");
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([]);
    expect((realFs.statSync(dir).mode & 0o777)).toBe(0o700);
    writeFileSync(path.join(dir, STORE_FILES.keys), "{}", { mode: 0o600 });
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([]);
  });

  test("issues: directory mode too open, file mode too open, symlinked file, symlinked directory, outside home, wrong owner", () => {
    const h = home();
    const dir = path.join(h, ".config", "subetha-payer");
    ensureStoreDir(dir, h, uid, realFs);
    chmodSync(dir, 0o755);
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([{ path: dir, code: "mode" }]);
    chmodSync(dir, 0o700);
    writeFileSync(path.join(dir, STORE_FILES.ledger), "", { mode: 0o644 });
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([{ path: path.join(dir, STORE_FILES.ledger), code: "mode" }]);
    chmodSync(path.join(dir, STORE_FILES.ledger), 0o600);
    const elsewhere = path.join(h, "elsewhere.json");
    writeFileSync(elsewhere, "{}", { mode: 0o600 });
    symlinkSync(elsewhere, path.join(dir, STORE_FILES.keys));
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([{ path: path.join(dir, STORE_FILES.keys), code: "symlink" }]);
    rmSync(path.join(dir, STORE_FILES.keys));
    // dangling な symlink（existsSync では見えない）も symlink として拒む。
    symlinkSync(path.join(h, "does-not-exist.json"), path.join(dir, STORE_FILES.config));
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([{ path: path.join(dir, STORE_FILES.config), code: "symlink" }]);
    rmSync(path.join(dir, STORE_FILES.config));
    // socket の名前の普通のファイルは not_socket。mode は「ちょうど」0600 / 0700（0400 や 0500 も拒む）。
    writeFileSync(path.join(dir, STORE_FILES.socket), "", { mode: 0o600 });
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([{ path: path.join(dir, STORE_FILES.socket), code: "not_socket" }]);
    rmSync(path.join(dir, STORE_FILES.socket));
    chmodSync(path.join(dir, STORE_FILES.ledger), 0o400);
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([{ path: path.join(dir, STORE_FILES.ledger), code: "mode" }]);
    chmodSync(path.join(dir, STORE_FILES.ledger), 0o600);
    chmodSync(dir, 0o500);
    expect(ensureStoreDir(dir, h, uid, realFs)).toEqual([{ path: dir, code: "mode" }]);
    chmodSync(dir, 0o700);
    // ディレクトリ自体が symlink（home の中を指していても拒む）。
    const real = path.join(h, "real-store");
    mkdirSync(real, { mode: 0o700 });
    const link = path.join(h, ".config", "linked");
    symlinkSync(real, link);
    expect(ensureStoreDir(link, h, uid, realFs)).toContainEqual({ path: link, code: "symlink" });
    // home の外。
    const outside = mkdtempSync(path.join(tmpdir(), "payer-outside-"));
    temps.push(outside);
    expect(ensureStoreDir(path.join(outside, "store"), h, uid, realFs)).toContainEqual({ path: path.join(outside, "store"), code: "outside_home" });
    // owner（uid を変えて観測する: 実際に別 user のファイルは作れないので期待値の uid を変える）。
    expect(ensureStoreDir(dir, h, uid + 1, realFs)).toContainEqual({ path: dir, code: "owner" });
  });
});
