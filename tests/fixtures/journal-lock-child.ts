/**
 * 実プロセスのロック競合テスト用の子プロセス。テスト基盤であり製品コードではない。
 *
 * usage: <tsx> journal-lock-child.ts <try-lock|hold-and-exit> <journalPath>
 *  - try-lock:      ロック取得を試み、拒否されたら `LOCKED <code>` を出して exit 3。
 *  - hold-and-exit: ロックを保持して 1 行追記し、close せずに終了する。
 */

import { openJournal } from "../../src/core/journal.js";

const mode = process.argv[2];
const journalPath = process.argv[3];

if (mode === undefined || journalPath === undefined) {
  process.stderr.write("usage: journal-lock-child <try-lock|hold-and-exit> <journalPath>\n");
  process.exitCode = 2;
} else if (mode === "try-lock") {
  try {
    const journal = await openJournal({ journalPath });
    process.stdout.write("ACQUIRED\n");
    await journal.close();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stdout.write(`LOCKED ${typeof code === "string" ? code : "unknown"}\n`);
    process.exitCode = 3;
  }
} else if (mode === "hold-and-exit") {
  const journal = await openJournal({ journalPath });
  await journal.append({ paymentId: "pay-child", event: "created", patch: { by: "child" } });
  process.stdout.write("HELD\n");
  // close しない。プロセス終了だけでロックが解放されることを親側が確かめる。
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exitCode = 2;
}
