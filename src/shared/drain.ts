/**
 * drain の上限（`docs/rejection-reasons-design.md` §15.2、タスク R-0）。SIGTERM・SIGINT の後、入口（`tools/remote-mcp.ts`）は進行中の MCP の要求と
 * Router の子の drain を、合わせてここまで待つ。Router の子（`src/main.ts`）も自分の drain をここまでで切る（入口は残りの時間で子を待ち、過ぎたら殺す）。
 * 値は 300 秒から始め、`tests/unit/drain-deadline.test.ts` が「経路ごとの期限の定数の和 ＋ 余裕 30 秒」のどれよりも長いことを固定する。
 * **時間切れは失敗**（`drain: timeout`。入れ替えはやめる）。`deploy/swap-image.sh` の `docker stop -t 315`・外側の上限 345 秒はこの値から決めている。
 */
export const DRAIN_TIMEOUT_MS = 300_000;

/**
 * graceful drain の数え方（`docs/rejection-reasons-design.md` §13.3・§15.2、タスク R-0）。MCP の入口（`src/mcp/ingress.ts`）と
 * Router の子の HTTP（`src/http/app.ts`）が使う。
 * - 受け付けた要求を数える。1 件は **処理が終わり、かつ応答が閉じた** ときに数から外す
 *   （相手が切って応答だけが閉じても、処理（Router の子なら購入・settle・宛先への支払い）が続く間は数に残す）
 * - `close()` の後に届いた要求（keep-alive の既存の接続の上の新しい要求）は数えずに 503 `draining` で断り、接続を閉じる
 * - `idle(ms)`: 数が 0 になれば true、上限に達すれば false（時間切れは呼び出し側が失敗として扱う）
 */
export interface DrainGate {
  /** 受け付けるなら true（呼び出し側は終わりに `finished` を 1 回呼ぶ）。drain の後は false。 */
  admit(): boolean;
  finished(): void;
  close(): void;
  inFlight(): number;
  idle(timeoutMs: number): Promise<boolean>;
}

export function createDrainGate(): DrainGate {
  let count = 0;
  let closed = false;
  const waiters = new Set<() => void>();
  const wake = (): void => {
    if (count !== 0) return;
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  return {
    admit(): boolean {
      if (closed) return false;
      count += 1;
      return true;
    },
    finished(): void {
      if (count > 0) count -= 1;
      wake();
    },
    close(): void {
      closed = true;
    },
    inFlight: () => count,
    idle(timeoutMs: number): Promise<boolean> {
      if (count === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        // 上限の時計は process を生かし続けてよい（drain の間は入口が終われない）。
        const timer = setTimeout(() => {
          waiters.delete(done);
          resolve(count === 0);
        }, timeoutMs);
        waiters.add(done);
      });
    },
  };
}
