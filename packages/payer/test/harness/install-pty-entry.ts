/** Parent-owned PTY entry for `install accept` (not packaged): real TerminalSecrets, fixture install root under HOME. */
import path from "node:path";
import { runInstall } from "../../src/cli/install.js";
process.exitCode = await runInstall(process.argv.slice(2), { installRoot: path.join(process.env.HOME!, "install") });
