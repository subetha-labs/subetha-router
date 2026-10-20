/**
 * 秘匿購入の wire 用の Router 子プロセス（試験基盤。製品コードではない）: **実 `startRouter`**（`src/main.ts`、`ROUTER_ADAPTER_MODE=real`）に、試験専用の能力だけを注入する。
 * - EVM 署名能力: 起動ごとの乱数鍵（実鍵・資金なし。送信レグの Provider fixture は EIP-3009 の署名を検証するだけで、チェーンには出ない）
 * - 動的/静的 transport: 名前解決は公開アドレスを返し（判定は本番と同じ）、TCP の行き先だけを loopback の fixture へ（`--dial host=port`）。CA は `--ca <pem>`（lab の fixture CA と試験 CA）
 * - `privateTrustForTest: "lab-fixture-ca"`（証跡は synthetic）
 * - 停止点（設計 §11）: `<control>/stops.json` `{"points":[...]}` に載る点で `<control>/arrive.<point>.<paymentId>` を書き、`<control>/release.<point>` が現れるまで待つ（その間に試験が SIGKILL する）
 * - wrapper の段: `<control>/launch.json` `{"stages":{"<stage>":{"arrive","release"}}}`（起動時に 1 回読む。無ければ段なし）
 *
 * usage: node --import tsx tests/fixtures/private/router-private-process.ts --control <dir> --dial host=port[,host=port...] --ca <pem> [--ca <pem>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { generatePrivateKey } from "viem/accounts";

import { reportStartupFailure, startRouter, type DynamicTransportHooks, type RouterCapabilities } from "../../../src/main.js";
import type { LaunchHooksForTest } from "../../../src/private/verifier.js";
import { createRealEvmCapability } from "../../../tools/real-evm-capability.js";
import { FIXTURE_PUBLIC_ADDRESS, UnmappedFixtureHostError } from "../dynamic/dial.js";

function argAll(name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1] !== undefined) out.push(process.argv[index + 1]!);
  }
  return out;
}
const control = argAll("control")[0];
if (control === undefined) {
  process.stderr.write("--control <dir> is required\n");
  process.exit(2);
}
const dial = new Map<string, number>();
for (const entry of argAll("dial").flatMap((value) => value.split(","))) {
  const [host, port] = entry.split("=");
  if (host === undefined || port === undefined || !/^[1-9][0-9]*$/.test(port)) {
    process.stderr.write("--dial expects host=port\n");
    process.exit(2);
  }
  dial.set(host, Number(port));
}
const cas = argAll("ca").map((file) => readFileSync(file, "utf8"));

const hooks: DynamicTransportHooks = {
  interfaces: () => [],
  tls: { ca: cas },
  lookup: (_hostname, _options, callback) => {
    callback(null, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]);
  },
  dialForTest: (target) => {
    const port = dial.get(target.hostname);
    if (port === undefined) throw new UnmappedFixtureHostError();
    return { host: "127.0.0.1", port };
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function stop(point: string, paymentId: string): Promise<void> {
  let points: unknown;
  try {
    points = (JSON.parse(readFileSync(path.join(control!, "stops.json"), "utf8")) as { points?: unknown }).points;
  } catch {
    return;
  }
  if (!Array.isArray(points) || !points.includes(point)) return;
  writeFileSync(path.join(control!, `arrive.${point}.${paymentId}`), String(Date.now()));
  const release = path.join(control!, `release.${point}`);
  while (!existsSync(release)) await sleep(25);
}
let launch: LaunchHooksForTest | undefined;
try {
  launch = JSON.parse(readFileSync(path.join(control, "launch.json"), "utf8")) as LaunchHooksForTest;
} catch {
  launch = undefined;
}

const evm = createRealEvmCapability(generatePrivateKey());
const capabilities: RouterCapabilities = {
  evmSigning: evm.capability("eip155:84532"),
  dynamicTransportHooksForTest: hooks,
  transportHooksForTest: hooks,
  privateTrustForTest: "lab-fixture-ca",
  privateHooksForTest: { stop },
  ...(launch === undefined ? {} : { launchHooksForTest: launch }),
};
// 運用者（Router）の送信レグの署名者アドレス（公開情報。Provider fixture が領収の payer に書く）。
process.stdout.write(`${JSON.stringify({ event: "operator", address: evm.address })}\n`);
startRouter(capabilities).catch(reportStartupFailure);
