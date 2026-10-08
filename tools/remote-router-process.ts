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
import { ProcessEntryError, routerProcessCapabilitiesOf } from "./rails-entry.js";

/**
 * 能力の組み立ては純粋関数 `routerProcessCapabilitiesOf`（`tools/rails-entry.ts`）。ここは env を渡して結果を注入するだけ。
 * - 送信の鍵（`SUBETHA_OUTBOUND_X402_KEY`・`SUBETHA_OUTBOUND_MPP_KEY`）。片方だけでも起動できる（その route を設定しなければよい）
 * - Tempo の RPC（`SUBETHA_TEMPO_RPC_URL`）。**認証付きを強く推奨**（公開エンドポイントは共有 egress IP からレート制限を受けやすい）。
 *   URL 自体が資格情報を含むことがあるのでログに出さない
 * - 多レール（Arc・Solana の受信。multirail 設計 §3・§8）: ホストが渡す内部の env `SUBETHA_RAILS_ACTIVATION` から有効化を復元し、
 *   **設定生成と同じ値**で能力を作る（Arc: 売り手証明の能力。Solana: 起動時の検査の RPC を依存先に）。無効なら該当の env は読まない
 * 失敗は固定文だけ（鍵・URL の値は出さない）。
 */
let capabilities: RouterCapabilities;
try {
  capabilities = routerProcessCapabilitiesOf(process.env);
} catch (error) {
  // 固定文だけ（理由の code で選ぶ。例外の文字列は出さない）。
  const code = error instanceof ProcessEntryError ? error.code : undefined;
  process.stderr.write(
    code === "outbound_keys"
      ? "at least one of SUBETHA_OUTBOUND_X402_KEY / SUBETHA_OUTBOUND_MPP_KEY is required\n"
      : code === "rails"
        ? "rails capabilities could not be created (check SUBETHA_RAILS_ACTIVATION / SUBETHA_ARC_RECEIVER_KEY)\n"
        : code === "solana_key"
          ? "SUBETHA_OUTBOUND_SOLANA_KEY is required and must be a base58 seed when the solana outbound rail is activated\n"
          : "router process capabilities could not be created\n",
  );
  process.exit(2);
}

// どちらの RPC を使っているかだけ示す。**URL は出さない**（キーを含み得る）。
const mppRpcUrl = process.env["SUBETHA_TEMPO_RPC_URL"];
if (capabilities.mppTempo !== undefined) {
  process.stderr.write(
    `tempo rpc: ${mppRpcUrl === undefined || mppRpcUrl === "" ? "public (rate-limited from shared egress IPs)" : "configured"}\n`,
  );
}

startRouter(capabilities).catch(reportStartupFailure);
