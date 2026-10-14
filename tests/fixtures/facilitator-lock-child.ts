/**
 * 実プロセスの facilitator の lock の競合の試験用の子プロセス（`tools/evm-facilitator.ts` の `acquireFacilitatorLock`。hosted 設計 §2.3）。
 * 試験の基盤であり製品コードではない。
 *
 * usage: <tsx> facilitator-lock-child.ts <hold|try> <lockPath>
 *  - hold: lock を取り `ACQUIRED` を出して、殺されるまで持ち続ける（解放は process の終了だけ）。
 *  - try:  lock を取れれば `ACQUIRED` を出して解放し exit 0。
 *  - どちらも取れなければ `LOCKED <文言>` を出して exit 3。
 */
import { acquireFacilitatorLock } from "../../tools/evm-facilitator.js";

const mode = process.argv[2];
const lockPath = process.argv[3];

if ((mode !== "hold" && mode !== "try") || lockPath === undefined) {
  process.stderr.write("usage: facilitator-lock-child <hold|try> <lockPath>\n");
  process.exitCode = 2;
} else {
  try {
    const lock = acquireFacilitatorLock(lockPath);
    process.stdout.write("ACQUIRED\n");
    if (mode === "hold") {
      // 解放しない。event loop を生かしておく。
      setInterval(() => {}, 1 << 30);
    } else {
      lock.release();
    }
  } catch (error) {
    process.stdout.write(`LOCKED ${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = 3;
  }
}
