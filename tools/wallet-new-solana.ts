/**
 * 使い捨ての Solana ウォレット（ed25519）を 1 つ作る。**製品コードではない**（審査員・呼び出し側向けの補助）。
 *
 *   npm run wallet:new:solana
 *
 * 出力した秘密鍵は **`.env.local`（gitignore 済み）に自分で保存**する。このツールはファイルを書かない。
 * devnet の USDC を入れる: https://faucet.circle.com → Solana Devnet / USDC。x402 で払うなら SOL は要らない（送信は facilitator の fee payer）。
 * **MPP（`solana/charge`）で払うなら devnet SOL も要る**（Router が送出する transaction の fee payer はこの鍵。`docs/mpp-solana-design.md` §7）。
 */
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from "@solana/kit";

// kit の鍵は抽出できないので、seed（32 バイト）を自分で作って signer にする（保存するのはこの seed）。
const seed = new Uint8Array(32);
crypto.getRandomValues(seed);
const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
const secret = getBase58Decoder().decode(seed);

process.stdout.write(`
Created a disposable Solana wallet (devnet only).

  address : ${signer.address}
  key     : ${secret}   (base58 seed, 32 bytes)

1) Save the key (.env.local in this repo is already gitignored)

   echo 'SOLANA_PAYER_PRIVATE_KEY=${secret}' >> .env.local

2) Fund that address with **Solana Devnet USDC**

   https://faucet.circle.com  → pick network **Solana Devnet** and token **USDC**.
   Paying over **x402** (routes whose offer scheme is \`exact\`): **you do not need SOL.**
   The facilitator's fee payer broadcasts and pays the fee; \`npm run sign\` only signs.

3) Paying over **MPP** (routes whose offer scheme is \`solana/charge\`): **you also need devnet SOL**
   on this address for the transaction fee. \`npm run sign\` still only signs; the Router broadcasts
   the transaction at purchase and **this key is the fee payer**. SOL faucet: https://faucet.solana.com

`);
