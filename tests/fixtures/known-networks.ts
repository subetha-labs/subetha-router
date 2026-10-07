/**
 * 試験の network の表（multirail 設計 §1）。本番の `KNOWN_NETWORKS` に、fixture が使う合成の資産・network を足したもの。
 * real モードで `src/main.ts` を起動する fixture（`router-*-process.ts`）が `knownNetworksForTest` で渡す。
 * 本番の入口は渡せない（`RouterCapabilities` はコードからだけ注入される）。
 */
import { KNOWN_NETWORKS, type KnownNetwork } from "../../src/config.js";

/** 合成の資産（`router-harness.ts`・wire の試験が使う架空のアドレス）。 */
const SYNTHETIC_EVM_ASSETS = [
  "0x0000000000000000000000000000000000005ce7",
  "0x000000000000000000000000000000000000de57",
  "0x0000000000000000000000000000000000000abc",
  "0x00000000000000000000000000000000000000b0",
  "0x00000000000000000000000000000000000000b1",
  "0x0000000000000000000000000000000000000501",
  "0x0000000000000000000000000000000000000502",
  "0x0000000000000000000000000000000000000a0e",
  "0x0000000000000000000000000000000000000a11",
  "0x0000000000000000000000000000000000000a12",
  "0x0000000000000000000000000000000000000b23",
  "0x000000000000000000000000000000000000beef",
].map((id) => ({ id, decimals: 6, domain: { name: "USDC", version: "2" } }));

/** 合成の EVM network（本番の表に無い）。向きとレールは両方許す（fixture の都合。本番の向きの制限は本番の表の項目で保つ）。 */
function syntheticEvm(network: string): KnownNetwork {
  return { network, family: "evm", inbound: ["x402", "mpp"], outbound: ["x402", "mpp"], x402Facilitator: "x402", assets: SYNTHETIC_EVM_ASSETS };
}

/**
 * 本番の項目は **向き・レール・facilitator の種類をそのまま**保ち、合成の資産だけを足す（本番が拒む向きを fixture が受け入れないため）。
 * 本番に無い network は合成の項目。
 */
export const TEST_NETWORKS: readonly KnownNetwork[] = [
  ...KNOWN_NETWORKS.map((entry) => (entry.family === "evm" ? { ...entry, assets: [...entry.assets, ...SYNTHETIC_EVM_ASSETS] } : entry)),
  syntheticEvm("eip155:11155111"),
  syntheticEvm("eip155:8453"),
  syntheticEvm("eip155:1"),
  syntheticEvm("eip155:4217"),
];
