/**
 * **実決済できる MCP サーバ**の起動エントリ。**製品コードではない**（鍵を扱う側）。
 *
 * `src/mcp/server.ts` は鍵を持たず env からも読まない。ここが `T9_MCP_PAYER_PRIVATE_KEY` を
 * 受け取り、受信レグ（x402 / Base Sepolia USDC）の支払い能力として**コードから注入**する。
 *
 * 審査員向けの登録（1 行）:
 *   claude mcp add subetha-router -- npm run --silent mcp:real
 *
 * 必要な env は README（MCP の節）に列挙。稼働中の Router に接続するだけで、Router は起動しない。
 */

import { evmChainIdOf } from "../src/config.js";
import { main } from "../src/mcp/server.js";
import { createX402Payer } from "./x402-payer.js";

/** 受信レグのチェーン（Base Sepolia）。offer の network と一致しなければ署名は失敗する。 */

const key = process.env["T9_MCP_PAYER_PRIVATE_KEY"];
if (key === undefined || key === "") {
  process.stderr.write(
    "T9_MCP_PAYER_PRIVATE_KEY is required (the inbound leg is paid by this key)\n",
  );
  process.exit(2);
}

/** この payer が署名する chain（既定 Base Sepolia）。offer の network がこれと違えば署名しない（能力側の chain の方針）。 */
const INBOUND_CHAIN_ID = Number(process.env["T9_INBOUND_CHAIN_ID"] ?? "84532");
if (!Number.isSafeInteger(INBOUND_CHAIN_ID) || INBOUND_CHAIN_ID <= 0) {
  process.stderr.write("T9_INBOUND_CHAIN_ID must be a positive integer\n");
  process.exit(2);
}

const payer = createX402Payer(key);

void main({
  payer: {
    address: payer.address,
    credentialFor: (offer, network) => {
      const chainId = evmChainIdOf(network);
      if (chainId === undefined || chainId !== INBOUND_CHAIN_ID) throw new Error("offer is not on the configured inbound chain");
      return payer.credentialFor(offer as never, chainId);
    },
  },
}).catch((error: unknown) => {
  process.stderr.write(
    `subetha-router MCP (real) failed: ${error instanceof Error ? error.message : "unknown"}\n`,
  );
  process.exit(1);
});
