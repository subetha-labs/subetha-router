# SubEtha Router

ETHGlobal Tokyo submission implementation: connect an AI agent's supported payment method to an API provider's required payment method.

**Status: requirements phase. No runnable Router or fresh payment E2E is claimed in this repository yet.**

First target: SubEtha payment → Router → x402 Provider A. Next: the same SubEtha entry → MPP Provider B. Existing chat and self-hosted market-data providers are separate projects.

- Provider A: Hyperliquid ETH market snapshot, x402 exact on Base Sepolia.
- Provider B: Uniswap v3 pool reference price, MPP Tempo charge on Moderato.
- Market data is read from mainnet; demo payment is testnet-only. These are self-hosted providers, not claims that Hyperliquid or Uniswap accept these methods directly.

## Provenance and scope

Earlier `subetha-payment-router` PoC explored technical feasibility. This repository is distinct. Prior findings inform design; any code reuse must identify origin and license. PoC results are historical, not verification of this submission. No official zERC20 SDK or BUSL implementation is vendored.

Local milestones are committed after scoped review and verification. Raw model logs, credentials, wallets and runtime state are not submission artifacts. A GitHub remote/public release has not yet been configured.
