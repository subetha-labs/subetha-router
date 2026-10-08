/**
 * log の伏せ字（`docs/provider-mpp-solana-workers.md` §2.4・§3.3）: mppx の server は検証の例外の文言を `console.error` に書き、
 * RPC の URL（鍵を含み得る）が入り得る。isolate の起動時に 1 度、`console.error`／`console.warn`／`console.log` を包んで、
 * 文字列の引数に含まれる RPC の URL を `<rpc>` に置き換える。Worker 自身の log は固定文だけ（値を書かない）。
 */
let original: { error: typeof console.error; warn: typeof console.warn; log: typeof console.log } | undefined;
let installedFor: string | undefined;

export function redact(value: unknown, secret: string): unknown {
  if (secret === "") return value;
  if (typeof value === "string") return value.split(secret).join("<rpc>");
  if (value instanceof Error) {
    const copy = new Error(String(value.message).split(secret).join("<rpc>"));
    copy.name = value.name;
    return copy;
  }
  return value;
}

/** 同じ URL で 2 度呼んでも 1 度だけ包む。別の URL なら包み直す（試験）。 */
export function installLogRedaction(rpcUrl: string): void {
  if (installedFor === rpcUrl) return;
  if (original !== undefined) uninstallLogRedaction();
  // 包むのは**今の** console の method（isolate の起動時のもの。試験の spy もその 1 つ）。
  original = { error: console.error, warn: console.warn, log: console.log };
  installedFor = rpcUrl;
  const captured = original;
  const wrap = (inner: (...args: unknown[]) => void) => (...args: unknown[]): void => {
    // global の console の method は `this` を付けずに呼ばない（Illegal invocation）: 元の関数を console に bind して呼ぶ。
    inner.apply(console, args.map((arg) => redact(arg, rpcUrl)));
  };
  console.error = wrap(captured.error);
  console.warn = wrap(captured.warn);
  console.log = wrap(captured.log);
}

/** 試験だけ: 元に戻す。 */
export function uninstallLogRedaction(): void {
  installedFor = undefined;
  if (original === undefined) return;
  console.error = original.error;
  console.warn = original.warn;
  console.log = original.log;
  original = undefined;
}
