/**
 * T6: 実機の確認（multirail 設計 §10 U-2、タスク T6）。**testnet だけ、`/verify` だけ。`/settle` は呼ばない（この道具に settle の経路は無い）。**
 * **製品コードではない**（鍵を扱う起動側の補助）。
 *
 *   npx tsx tools/rails-verify-probe.ts svm prepare   … devnet の SOL を payer に airdrop し、受取 owner の ATA を作る（rent は payer）
 *   npx tsx tools/rails-verify-probe.ts svm verify    … 起動時の検査（/supported・ATA）→ adapter の offer → svm-payer で署名 → x402.org の /verify
 *
 * env（`.claude_workflow/local/t6-solana.env`。ignored）: T6_SOLANA_PAYER_KEY, T6_SOLANA_RECEIVER_KEY（base58 の 32 バイトの seed）、
 * 任意 T6_SOLANA_RPC_URL（既定 devnet の公開 RPC）、T6_SVM_FACILITATOR_URL（既定 https://www.x402.org/facilitator）。
 * 記録は `.claude_workflow/local/t6-svm-<cmd>.json`（鍵・本文は書かない）。
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { createX402SvmInbound } from "../src/adapters/inbound/x402-svm.js";
import { resolveSvmInboundPolicy } from "../src/adapters/inbound/x402-svm-startup.js";
import { KNOWN_NETWORKS } from "../src/config.js";
import { createGuardedTransport } from "../src/net/guarded-fetch.js";
import { createSvmPayer, svmSignerFromKey } from "./svm-payer.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const entry = KNOWN_NETWORKS.find((n) => n.network === SOL)!;
const MINT = entry.assets[0]!.id;
const TOKEN_PROGRAM = entry.assets[0]!.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;

function env(name: string, fallback?: string): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const line = readFileSync(".claude_workflow/local/t6-solana.env", "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
    if (line !== undefined) return line.slice(name.length + 1).trim();
  } catch {
    /* 無ければ fallback */
  }
  if (fallback !== undefined) return fallback;
  process.stderr.write(`${name} is required\n`);
  process.exit(2);
}

const rail = process.argv[2];
const command = process.argv[3];
if (rail !== "svm" || (command !== "prepare" && command !== "verify")) {
  process.stderr.write("usage: rails-verify-probe.ts svm prepare|verify\n");
  process.exit(2);
}
const rpcUrl = env("T6_SOLANA_RPC_URL", "https://api.devnet.solana.com");
const facilitatorUrl = env("T6_SVM_FACILITATOR_URL", "https://www.x402.org/facilitator");
const payer = await svmSignerFromKey(env("T6_SOLANA_PAYER_KEY"));
const receiver = await svmSignerFromKey(env("T6_SOLANA_RECEIVER_KEY"));
const [receiverAta] = await findAssociatedTokenPda({ mint: address(MINT), owner: receiver.address, tokenProgram: address(TOKEN_PROGRAM) });
const record: Record<string, unknown> = { at: new Date().toISOString(), rail, command, network: SOL, mint: MINT, payer: String(payer.address), receiverOwner: String(receiver.address), receiverAta: String(receiverAta) };
const write = (): void => writeFileSync(`.claude_workflow/local/t6-svm-${command}.json`, `${JSON.stringify(record, null, 2)}\n`);

if (command === "prepare") {
  // devnet の SOL を payer に（rent と手数料のため。USDC は faucet.circle.com で人が入れる）。
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws"));
  const balance = await rpc.getBalance(payer.address).send();
  record["payerLamportsBefore"] = balance.value.toString();
  if (balance.value < 5_000_000n) {
    const airdrop = airdropFactory({ rpc, rpcSubscriptions });
    const sig = await airdrop({ commitment: "confirmed", lamports: lamports(100_000_000n), recipientAddress: payer.address });
    record["airdropSignature"] = String(sig);
  }
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getCreateAssociatedTokenIdempotentInstruction({ payer, ata: receiverAta, owner: receiver.address, mint: address(MINT), tokenProgram: address(TOKEN_PROGRAM) })], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(signed, { commitment: "confirmed" });
  record["createAtaSignature"] = String(getSignatureFromTransaction(signed));
  record["payerLamportsAfter"] = (await rpc.getBalance(payer.address).send()).value.toString();
  write();
  process.stdout.write(`prepared: receiver ATA ${String(receiverAta)} (owner ${String(receiver.address)}). Fund the payer ${String(payer.address)} with devnet USDC at https://faucet.circle.com\n`);
} else {
  // 本番と同じ方針の transport（loopback 不可・DNS の期限）。宛先は本物の x402.org と devnet の RPC。
  const transport = createGuardedTransport({ allowLoopback: false, report: (event) => { (record["transportEvents"] as unknown[] | undefined)?.push(event) ?? (record["transportEvents"] = [event]); }, dns: { timeoutMs: 3_000, maxInFlight: 4 } });
  const policy = await resolveSvmInboundPolicy({ network: SOL, facilitatorUrl, rpcUrl, payTo: String(receiver.address), mint: MINT, decimals: entry.assets[0]!.decimals, tokenProgram: TOKEN_PROGRAM, transport, routeId: "t6-probe" });
  record["feePayer"] = policy.feePayer;
  const rail2 = createX402SvmInbound({ facilitatorUrl, transport, policy });
  const offer = await rail2.createOffer({ routeId: "t6-probe", amount: "10000", asset: MINT, network: SOL, routeBinding: "t6-probe|GET|%2Ft6", nowMs: Date.now() });
  const svmPayer = await createSvmPayer(env("T6_SOLANA_PAYER_KEY"), { rpcUrl });
  const credentialText = await svmPayer.credentialFor(offer as never, { mint: MINT, decimals: entry.assets[0]!.decimals, tokenProgram: TOKEN_PROGRAM });
  const credential = JSON.parse(Buffer.from(credentialText, "base64").toString("utf8")) as { x402Version: number; accepted: never; payload: { challengeNonce: string; transaction: string } };
  const preflight = rail2.preflight(offer, credential as never, Date.now());
  record["preflight"] = preflight;
  if (!preflight.ok) {
    write();
    process.stderr.write(`preflight refused: ${JSON.stringify(preflight)}\n`);
    process.exit(1);
  }
  const verified = await rail2.verify(offer, credential as never, { routeId: "t6-probe" });
  record["verify"] = verified;
  write();
  process.stdout.write(`verify: ${JSON.stringify(verified)} (feePayer ${policy.feePayer}; no settle was sent)\n`);
}
