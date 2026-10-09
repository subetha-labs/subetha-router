import { chmodSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { OsascriptDependencies, UiFilesystem } from "../../src/ui/osascript.js";

export function fakeSystemFilesystem(executable: string): UiFilesystem {
  return {
    realpathSync: value => value,
    lstatSync: value => ({ uid: 0, mode: 0o755, isSymbolicLink: () => false, isDirectory: () => value !== executable, isFile: () => value === executable }),
  };
}

// Owned executable, synthetic stdin/stdout only. No shell, socket, GUI, process inventory or host config.
export function fakeUiHelper(body = 'process.stdout.write("Approve\\nfalse\\nsynthetic-passphrase\\n");', probe = 'process.stdout.write("1\\n");') {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "p4a-ui-")));
  const executable = path.join(dir, "fake-osascript");
  const capture = path.join(dir, "capture.ndjson");
  const script = path.join(dir, "helper.mjs"), environment = path.join(dir, "exec-env");
  // Capture exec's environment before Node/CoreFoundation can add its own macOS variable.
  // This keeps the exact allowlist assertion at the real executable boundary on both OSes.
  const source = `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\nextern char **environ;\nint main(int argc, char **argv) { FILE *f = fopen(${JSON.stringify(environment)}, "wb"); if (!f) return 90; for (char **e = environ; *e; e++) fwrite(*e, 1, strlen(*e)+1, f); fclose(f); char **a = calloc(argc+2, sizeof(char*)); a[0] = ${JSON.stringify(process.execPath)}; a[1] = ${JSON.stringify(script)}; for (int i=1; i<argc; i++) a[i+1] = argv[i]; execv(a[0], a); return 91; }\n`;
  if (process.platform === "darwin") {
    const compiled = spawnSync("/usr/bin/cc", ["-x", "c", "-", "-o", executable], { input: source, env: { PATH: "/usr/bin:/bin", TMPDIR: dir }, encoding: "utf8", timeout: 15_000 });
    if (compiled.error || compiled.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error("fixture_helper_compile_failed"); }
    chmodSync(executable, 0o700);
  }
  const environmentExpression = process.platform === "darwin" ? `Object.fromEntries(readFileSync(${JSON.stringify(environment)}, "utf8").split("\\0").filter(Boolean).map(e => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i+1)]; }))` : "process.env";
  writeFileSync(process.platform === "darwin" ? script : executable, `#!${process.execPath}\nimport { appendFileSync, readFileSync } from "node:fs";\nlet input = "";\nfor await (const chunk of process.stdin) input += chunk;\nconst env = ${environmentExpression};\nappendFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), env, input }) + "\\n");\nif (input === 'tell application "System Events" to return 1\\n') { ${probe} } else { ${body} }\n`, { mode: process.platform === "darwin" ? 0o600 : 0o700 });
  // Simulate system ownership without changing the host. Safety tests vary each attribute separately.
  const filesystem = fakeSystemFilesystem(executable);
  const deps: OsascriptDependencies = { executable, platform: "darwin", filesystem, env: { HOME: dir, LANG: "en_US.UTF-8", TMPDIR: dir, PATH: "/hostile", NODE_OPTIONS: "hostile-preload", DYLD_INSERT_LIBRARIES: "hostile", EXTRA_SECRET: "env-sentinel" } };
  return { dir, executable, deps, captures: (): { argv: string[]; env: Record<string, string>; input: string }[] => readFileSync(capture, "utf8").trimEnd().split("\n").map(line => JSON.parse(line)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
