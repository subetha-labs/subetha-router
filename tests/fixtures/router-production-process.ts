/**
 * 試験用の Router の子 process（**本番の能力の組み立て**で起動する。タスク U9）。**製品コードではない。**
 *
 * `tools/remote-router-process.ts` と同じ `routerProcessCapabilitiesOf(process.env)`（鍵は env から、無効なレールの env は読まない）に、
 * env で受けた対応表（ホスト名 → loopback の port）と試験用 CA の transport hook だけを足して `startRouter` を呼ぶ。方針（loopback の拒否、DNS の期限）は本番のまま、
 * TCP の行き先だけを fixture に向ける。起動の失敗の文は本番の入口と同じ固定文。
 *
 * env: `SUBETHA_TEST_DIAL_MAP`（JSON `{ "<host>": <port> }`）、`SUBETHA_TEST_CA_PATH`（試験用 CA の PEM）。他は本番の入口と同じ。
 */
import { readFileSync } from "node:fs";

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../../src/main.js";
import { ProcessEntryError, routerProcessCapabilitiesOf } from "../../tools/rails-entry.js";
import { dialTo, publicLookup } from "./dynamic/dial.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    process.stderr.write(`${name} is required\n`);
    process.exit(2);
  }
  return value;
}

let production: RouterCapabilities;
try {
  production = routerProcessCapabilitiesOf(process.env);
} catch (error) {
  const code = error instanceof ProcessEntryError ? error.code : undefined;
  process.stderr.write(code === undefined ? "router process capabilities could not be created\n" : `${(error as Error).message}\n`);
  process.exit(2);
}

const hooks = {
  interfaces: () => [],
  tls: { ca: [readFileSync(required("SUBETHA_TEST_CA_PATH"), "utf8")] },
  lookup: publicLookup(),
  dialForTest: dialTo(JSON.parse(required("SUBETHA_TEST_DIAL_MAP")) as Record<string, number>),
};

startRouter({ ...production, transportHooksForTest: hooks, dynamicTransportHooksForTest: hooks }).catch(reportStartupFailure);
