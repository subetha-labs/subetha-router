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
使い捨てウォレットを作りました。

  address : ${account.address}
  key     : ${key}

次の 2 つをやってください。

1) 鍵を保存する（このリポジトリの .env.local は gitignore 済み）

   echo 'SUBETHA_PAYER_PRIVATE_KEY=${key}' >> .env.local

2) 上の address に **Base Sepolia の USDC** を入れる（1 回 0.01 USDC・数回分で足ります）

   https://faucet.circle.com

   ネットワークは **Base Sepolia**、トークンは **USDC** を選びます。
   **ETH（ガス）は不要**です。x402 の EIP-3009 経路では facilitator が送信して gas を負担します。

残高の確認:

   npm run wallet:balance

`);
