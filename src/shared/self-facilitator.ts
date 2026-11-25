/**
 * 自前の facilitator（`tools/evm-facilitator.ts`）が扱う network（`docs/base-sepolia-facilitator-design.md` §2.1）。
 * `EVM_TESTNET_NETWORKS`（Router の受信の domain・期限・送信の束ねに効く）とは別の集合で、使うのは facilitator と、Router の**受信**の
 * loopback の例外（`src/main.ts` の `localCounterpartyPlanOf`）だけ。
 */
import { EVM_TESTNET_NETWORKS } from "./networks.js";

export const BASE_SEPOLIA_NETWORK = "eip155:84532";

export const SELF_FACILITATOR_NETWORKS: ReadonlySet<string> = Object.freeze(new Set([...EVM_TESTNET_NETWORKS, BASE_SEPOLIA_NETWORK]));

/** Router の受信の facilitator の HTTP 期限（Base Sepolia を自前の facilitator で受けるとき。hosted の新 3 と同じ。facilitator の締め切り 10 秒の外側）。 */
export const BASE_SELF_FACILITATOR_TIMEOUT_MS = 20_000;
