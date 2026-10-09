/** Owned subprocess only. No IPC/socket, real UI, TTY, or production CLI/env override. */
import { runDaemon } from "../../src/daemon/run.js";
import { fakeSystemFilesystem } from "./ui-helper.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const fixture: { home: string; installRoot: string; executable: string } = JSON.parse(input);
input = "";
process.exitCode = await runDaemon(["--check"], ["--disable-sigusr1"], {
  env: { HOME: fixture.home }, installRoot: fixture.installRoot,
  ui: { platform: "darwin", executable: fixture.executable, filesystem: fakeSystemFilesystem(fixture.executable) },
  tty: { available: true, read: async () => { throw new Error("fixture_no_prompt_allowed"); } },
});
