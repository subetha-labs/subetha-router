/** Parent-only PTY observer. Real command/TTY/liveness and real filesystem operations.
 * Records successful unlink order without altering any lock decision or identity.
 * No entry in dist/package; no production argv/env injection seam.
 */
import path from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { runLock } from "../../src/cli/lock.js";
import { realFs } from "../../src/store/fs.js";
import { durableEvent } from "./durable.js";

const home = process.env.HOME!;
const dir = path.join(home, ".config/subetha-payer");
const lock = path.join(dir, "daemon.lock"), socket = path.join(dir, "daemon.sock");
process.exitCode = await runLock(process.argv.slice(2), { fs: { ...realFs,
  unlinkSync(file) {
    if (file !== socket && file !== lock) { realFs.unlinkSync(file); return; }
    const stat = lstatSync(file), lockStat = lstatSync(lock);
    const owner: unknown = JSON.parse(readFileSync(lock, "utf8"));
    realFs.unlinkSync(file);
    durableEvent(path.join(home, "cli-reclaim-unlinks.ndjson"), {
      name: path.basename(file), dev: stat.dev, ino: stat.ino,
      lockDev: lockStat.dev, lockIno: lockStat.ino, owner,
    });
  },
} });
