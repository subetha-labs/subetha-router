# 証跡: zERC20 公式 testnet v1 の公開面（2026-10-16）

`docs/subetha-hosted-inbound-requirements.md` §1 の外部観測の記録。すべて認証なしの GET（資金・鍵に触れない）。

## 1. API ホスト `https://beta-v1.api.zerc20.io`（2026-10-16T05:34:22Z）

| GET | HTTP |
|---|---|
| `/indexer/zeth/status` | 200 |
| `/indexer/zusdc/status` | 200 |
| `/indexer/zeth/healthz` | 200 |
| `/decider/healthz` | 200（本文なし） |
| `/facilitator` | 404 |
| `/facilitator/supported` | 404 |
| `/x402/supported` | 404 |
| `/supported` | 404 |

`/indexer/zeth/status` の Sepolia 行（抜粋、値はそのまま）:

```json
{"label":"sepolia","chain_id":11155111,
 "token_address":"0xADAb5CaB352fb1eBF24CD951de224f9e952C82Ed",
 "verifier_address":"0xD19b79cE0C2821158aDBDEf9cC8c8D858c9ef0Cc",
 "onchain_reserved_index":480,"onchain_proved_index":480,
 "events_synced_index":479,"tree_synced_index":480,"ivc_generated_index":null}
```

`/indexer/zusdc/status` の Sepolia 行: `token_address` `0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF`、
`verifier_address` `0xb199A85463Bc5c0009c058E80b8A0d3D5e0025D6`、`onchain_proved_index` 320。

## 2. 公式文書（2026-10-16 閲覧）

| 文書 | 内容 |
|---|---|
| `https://zerc20.gitbook.io/zerc20/llms.txt` | 全 30 ページの目次。x402・facilitator の項は無い |
| `https://zerc20.gitbook.io/zerc20/for-developers/indexer-api.md` | testnet（Stage）indexer の base URL は `https://beta-v1.api.zerc20.io/indexer/<token>`。Relayer・Decider は「別サービスで本ページの対象外」。x402・facilitator の記載なし |
| `https://zerc20.gitbook.io/zerc20/reference/addresses.md` | testnet zETH: Sepolia token `0xADAb5CaB352fb1eBF24CD951de224f9e952C82Ed`、verifier `0xD19b79cE0C2821158aDBDEf9cC8c8D858c9ef0Cc`、Hub（Base Sepolia）`0xD18b503B335656C05dC516366C0C8FD6e3b13856` |
| `https://zerc20.gitbook.io/zerc20/reference/links.md` | facilitator・x402 のリンクは無い |
| GitHub `kbizikav/zERC20` | コード検索 `x402` は 0 件（`gh api search/code`） |

## 3. 過去の testnet 決済で使った facilitator

Router の記録（`docs/u01r-requirements.md` §23–27）と、作業セッションの記録に出る facilitator URL を検索した。
外部の facilitator URL は無く、testnet 決済は**SubEtha 自身の facilitator をローカルで起動**して行っていた（`127.0.0.1` の待ち受け）。

## 4. zUSDC（要件 v4、2026-10-16 の追加の観測）

公式文書 `https://zerc20.gitbook.io/zerc20/reference/addresses.md` の Testnet / zUSDC の節: Hub（Base Sepolia）`0xF64Bd0a90120611b0c941e3eF546f2F82F1eaB44`、
Sepolia の zERC20 `0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF`、Verifier `0xb199A85463Bc5c0009c058E80b8A0d3D5e0025D6`、
LiquidityManager `0xB9f41F93882c2ddC212a4EcC776BBd9D97D2F3C6`、Adaptor `0xC14A0a1381e455f89a31eDB00F562F5a6F8780Ad`。

Sepolia の `eth_call`（公開 RPC `ethereum-sepolia-rpc.publicnode.com`、latest。読取と模擬だけで transaction は送っていない）:

| 呼び出し | 結果 |
|---|---|
| zUSDC `decimals()` | 6 |
| zUSDC `symbol()` | `zUSDC` |
| Verifier `redeemFeeBps()` | 10 |
| Verifier `token()` | `0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF` |
| LiquidityManager `zerc20()` | `0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF` |
| LiquidityManager `underlyingToken()` | `0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590` |
| 元の token の `symbol()`・`decimals()` | `USDC`・6 |
| 元の token の `mint(0x…dEaD, 1000000)`（from `0x1111…1111`、模擬） | 成功（戻り値なし）。`faucet()`・`drip(address)`・`faucet(address)` は revert |

SubEtha facilitator（`1aeac60`）の token 依存の検索: `zerc20-backend` と `apps/facilitator` に zETH・18 桁の決め打ちは無い（`redeem.ts:74` の 18 は chain の native ETH の定義）。
