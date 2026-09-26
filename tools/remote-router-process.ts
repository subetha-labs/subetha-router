/**
 * ホスト版 Router の起動プロセス。**製品コードではない**（実鍵を扱う起動側）。
 *
 * `tools/t7-router-process.ts` は**片方のレールだけ**（`--rail a|b`）を注入する。
 * ホスト版は**両方のレールで送信できる**必要があるので、ここで両方を注入する:
 *
 * - `evmSigning`  → x402 送信（Provider A / Base Sepolia USDC）
 * - `mppTempo`    → MPP 送信（Provider B / Tempo pathUSD）
 *
 * 鍵は env から**このツールが**受け取り、能力としてコードから注入する
 * （`src/**` は env から鍵を読まない方針を維持）。
 *
 * 片方の鍵しか無い構成でも起動できるようにする（その route を設定しなければよい）。
 * 能力が無いまま該当レールの route があると `src/main.ts` が fail closed で止める。
 */

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../src/main.js";
import { createRealEvmCapability } from "./real-evm-capability.js";
import { createRealMppCapability } from "./real-mpp-capability.js";

/** x402 送信用の鍵。無ければ x402 送信 route を設定してはいけない。 */
const evmKey = process.env["SUBETHA_OUTBOUND_X402_KEY"];
/** MPP 送信用の鍵。無ければ MPP 送信 route を設定してはいけない。 */
const mppKey = process.env["SUBETHA_OUTBOUND_MPP_KEY"];
/**
 * Tempo の RPC。**認証付きを強く推奨**。
 *
 * 既定は公開エンドポイント（`rpc.moderato.tempo.xyz`）だが、Cloudflare のような
 * 共有 egress IP から叩くと**レート制限を受けやすい**。Router は送金の前に
 * chainId / nonce / 見積りを読むので、ここで詰まると送信レグが不安定になる。
 * 認証付き RPC の URL を渡せば、その経路を避けられる。
 *
 * **URL 自体が資格情報を含むことがある**（API キー入りのパス）。ログに出さない。
 */
const mppRpcUrl = process.env["SUBETHA_TEMPO_RPC_URL"];

if ((evmKey === undefined || evmKey === "") && (mppKey === undefined || mppKey === "")) {
  process.stderr.write(
    "at least one of SUBETHA_OUTBOUND_X402_KEY / SUBETHA_OUTBOUND_MPP_KEY is required\n",
  );
  process.exit(2);
}

const capabilities: RouterCapabilities = {
  ...(evmKey === undefined || evmKey === ""
    ? {}
    : { evmSigning: createRealEvmCapability(evmKey).capability("eip155:84532") }),
  ...(mppKey === undefined || mppKey === ""
    ? {}
    : {
        mppTempo: createRealMppCapability(mppKey, {
          ...(mppRpcUrl === undefined || mppRpcUrl === "" ? {} : { rpcUrl: mppRpcUrl }),
        }).capability(),
      }),
};

// どちらの RPC を使っているかだけ示す。**URL は出さない**（キーを含み得る）。
if (mppKey !== undefined && mppKey !== "") {
  process.stderr.write(
    `tempo rpc: ${mppRpcUrl === undefined || mppRpcUrl === "" ? "public (rate-limited from shared egress IPs)" : "configured"}\n`,
  );
}

startRouter(capabilities).catch(reportStartupFailure);
