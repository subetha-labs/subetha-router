/**
 * 試験用の Router の**子 process**（送信の設計 §7.2 の「中断」、タスク U8-b）。**製品コードではない。**
 *
 * `startRouter` を、SVM の送信の能力と停止の hook を注入して起動する。親（wire 試験）が fixture（facilitator・Solana RPC・Provider）を持ち、
 * この子は env で受けた対応表（ホスト名 → loopback の port）と試験用 CA で guarded transport を組む（`dialForTest`。方針は本番と同じ）。
 *
 * env（親が明示して渡す。鍵は毎回の乱数）:
 * - `ROUTER_*`: 通常の設定（`loadRuntimeConfig`）
 * - `SUBETHA_TEST_DIAL_MAP`: JSON `{ "<host>": <port> }`
 * - `SUBETHA_TEST_CA_PATH`: 試験用 CA の PEM
 * - `SUBETHA_TEST_SVM_SEED`: base58 の 32 バイト seed（SVM の送信の鍵。試験の使い捨て）
 * - `SUBETHA_TEST_SIGN_LOG`: 署名のたびに 1 行（`{"at":<ms>,"bytes":<len>}`）を**同期で追記**する file（親が「停止前の回数」を数える）
 * - `SUBETHA_TEST_SVM_STOP_AT`: `afterReserve`／`afterSign`／`beforeSend` のどれかなら、その停止点で **自分に SIGKILL**（core の catch も終端の追記も通さない）
 */
import { appendFileSync, readFileSync } from "node:fs";

import { createRealSvmCapability } from "../../tools/real-svm-capability.js";
import { reportStartupFailure, startRouter, type RouterCapabilities } from "../../src/main.js";
import { TEST_NETWORKS } from "./known-networks.js";
import { dialTo, publicLookup } from "./dynamic/dial.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    process.stderr.write(`${name} is required\n`);
    process.exit(2);
  }
  return value;
}

const dialMap = JSON.parse(required("SUBETHA_TEST_DIAL_MAP")) as Record<string, number>;
const ca = readFileSync(required("SUBETHA_TEST_CA_PATH"), "utf8");
const signLog = required("SUBETHA_TEST_SIGN_LOG");
const stopAt = process.env["SUBETHA_TEST_SVM_STOP_AT"];
const real = createRealSvmCapability(required("SUBETHA_TEST_SVM_SEED"));

const hooks = {
  interfaces: () => [],
  tls: { ca: [ca] },
  lookup: publicLookup(),
  dialForTest: dialTo(dialMap),
};

/** 停止点: 同期で SIGKILL（この行の後は実行されない）。 */
const stop = (point: string): void => {
  if (stopAt === point) {
    appendFileSync(signLog, `${JSON.stringify({ at: Date.now(), stop: point })}\n`);
    process.kill(process.pid, "SIGKILL");
  }
};

const svm = real.capability(SOL);
const capabilities: RouterCapabilities = {
  svmSigning: {
    [SOL]: {
      ...svm,
      sign: (bytes) => {
        const signature = svm.sign(bytes);
        appendFileSync(signLog, `${JSON.stringify({ at: Date.now(), bytes: bytes.length })}\n`);
        return signature;
      },
    },
  },
  knownNetworksForTest: TEST_NETWORKS,
  dynamicTransportHooksForTest: hooks,
  transportHooksForTest: hooks,
  svmOutboundHooksForTest: {
    afterReserve: () => stop("afterReserve"),
    afterSign: () => stop("afterSign"),
    beforeSend: () => stop("beforeSend"),
  },
};

process.stderr.write(`svm signer: ${real.address}\n`);
startRouter(capabilities).catch(reportStartupFailure);
