/**
 * store が使う file system の口（設計 `docs/agent-payer-design.md` §3.4・§3.7）。本番は `node:fs` の同期 API、試験は失敗（`EIO`・`EROFS`）を注入する。
 * daemon は 1 process で台帳を書くので同期 API でよい（fsync の順序が読みやすい）。
 */

import * as fs from "node:fs";

export interface StoreFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => Buffer;
  readonly writeFileSync: (path: string, data: Buffer | string, options: { readonly mode: number; readonly flag: string }) => void;
  readonly openSync: (path: string, flags: string, mode?: number) => number;
  readonly writeSync: (fd: number, data: Buffer) => number;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly ftruncateSync: (fd: number, length: number) => void;
  readonly fstatSync: (fd: number) => { readonly ino: number | bigint; readonly size: number };
  readonly lstatSync: (path: string) => fs.Stats;
  readonly statSync: (path: string) => fs.Stats;
  readonly realpathSync: (path: string) => string;
  readonly mkdirSync: (path: string, options: { readonly recursive: boolean; readonly mode: number }) => void;
  readonly linkSync: (existing: string, target: string) => void;
  readonly unlinkSync: (path: string) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly readdirSync: (path: string) => string[];
}

export const realFs: StoreFs = {
  existsSync: fs.existsSync,
  readFileSync: (path) => fs.readFileSync(path),
  writeFileSync: (path, data, options) => fs.writeFileSync(path, data, options),
  openSync: fs.openSync,
  writeSync: (fd, data) => fs.writeSync(fd, data),
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  ftruncateSync: fs.ftruncateSync,
  fstatSync: (fd) => fs.fstatSync(fd),
  lstatSync: (path) => fs.lstatSync(path),
  statSync: (path) => fs.statSync(path),
  realpathSync: (path) => fs.realpathSync(path),
  mkdirSync: (path, options) => { fs.mkdirSync(path, options); },
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
  renameSync: fs.renameSync,
  readdirSync: (path) => fs.readdirSync(path),
};

/** store の失敗は固定のコードで表す（文言に path や中身を入れない）。 */
export class StoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StoreError";
  }
}
