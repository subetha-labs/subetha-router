/**
 * 設計の実測（`docs/dynamic-upstream-design.md` §支払い操作の範囲）。**製品コードではない。**
 *
 * 問い: MPP 送信（push・local account）で SDK が `eth_sendRawTransactionSync` に渡す raw transaction を、
 * 送る前に復号して「call は 1 つ・宛先は設定した token・`transferWithMemo(受取先, 額, memo)`・fee token・
 * 手数料上限・有効期限」を検査できるか。
 *
 * 鍵は毎回ランダムに作る。ネットワークには出ない。
 *
 * usage: npx tsx tools/dyn-mpp-tx-decode-probe.ts
 */
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TxEnvelopeTempo } from "ox/tempo";
import { Secp256k1 } from "ox";

const TOKEN = "0x20c0000000000000000000000000000000000000";
const RECIPIENT = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const abi = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
]);

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
const memo = `0x${"ab".repeat(32)}` as const;
const envelope = TxEnvelopeTempo.from({
  chainId: 42431,
  calls: [{ to: TOKEN, data: encodeFunctionData({ abi, functionName: "transferWithMemo", args: [RECIPIENT, 10000n, memo] }) }],
  gas: 100000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  nonceKey: 1n,
  nonce: 0n,
  validBefore: Math.floor(Date.now() / 1000) + 25,
  feeToken: TOKEN,
});
const signature = Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(envelope), privateKey });
const raw = TxEnvelopeTempo.serialize(envelope, { signature });

const decoded = TxEnvelopeTempo.deserialize(raw);
const call = decoded.calls?.[0];
const fn = decodeFunctionData({ abi, data: call?.data ?? "0x" });
console.log(JSON.stringify({
  rawPrefix: raw.slice(0, 4),
  signer: account.address.length === 42,
  chainId: decoded.chainId,
  calls: decoded.calls?.length,
  to: call?.to,
  value: String(call?.value ?? 0n),
  functionName: fn.functionName,
  args: fn.args?.map(String),
  feeToken: decoded.feeToken,
  gas: String(decoded.gas),
  maxFeePerGas: String(decoded.maxFeePerGas),
  maxFeeBound: String((decoded.gas ?? 0n) * (decoded.maxFeePerGas ?? 0n)),
  validBefore: decoded.validBefore,
  hasFeePayerSignature: decoded.feePayerSignature !== undefined,
}, null, 1));
