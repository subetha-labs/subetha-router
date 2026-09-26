/**
 * 使い捨てウォレットを 1 つ作る。**製品コードではない**（審査員向けの補助）。
 *
 *   npm run wallet:new
 *
 * 出力した秘密鍵は **`.env.local`（gitignore 済み）に自分で保存**する。
 * このツールはファイルを書かない（既存の鍵を黙って上書きしないため）。
 *
 * 作ったアドレスに Base Sepolia の USDC を入れる（ガスは不要）:
 *   https://faucet.circle.com  → Base Sepolia / USDC を選び、このアドレスを貼る
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

process.stdout.write(`
Created a disposable wallet.

  address : ${account.address}
  key     : ${key}

Two things to do next.

1) Save the key (.env.local in this repo is already gitignored)

   echo 'SUBETHA_PAYER_PRIVATE_KEY=${key}' >> .env.local

2) Fund that address with **Base Sepolia USDC** (0.01 USDC per call; a few is plenty)

   https://faucet.circle.com

   Pick network **Base Sepolia** and token **USDC**.
   **You do not need ETH for gas.** On the x402 EIP-3009 route the facilitator
   broadcasts and pays the gas.

Check the balance:

   npm run wallet:balance

`);
