/**
 * T6: 実機の確認（multirail 設計 §10 U-2、タスク T6）。**testnet だけ、`/verify` だけ。`/settle` は呼ばない（この道具に settle の経路は無い）。**
 * **製品コードではない**（鍵を扱う起動側の補助）。
 *
 *   npx tsx tools/rails-verify-probe.ts svm prepare   … devnet の SOL を payer に airdrop し、受取 owner の ATA を作る（rent は payer）
 *   npx tsx tools/rails-verify-probe.ts svm verify    … 起動時の検査（/supported・ATA）→ adapter の offer → svm-payer で署名 → x402.org の /verify
 *   npx tsx tools/rails-verify-probe.ts arc verify    … Circle の facilitator: adapter（kind circle、証明専用の受取鍵の能力）の offer → x402-payer で EIP-3009 に署名 → /verify
 *
 * env（`.claude_workflow/local/t6-arc.env`）: T6_ARC_RECEIVER_KEY（証明専用。0x hex）。payer は `.claude_workflow/local/t7-disposable-key.env` の T7_PAYER_PRIVATE_KEY。
 *
 * env（`.claude_workflow/local/t6-solana.env`。ignored）: T6_SOLANA_PAYER_KEY, T6_SOLANA_RECEIVER_KEY（base58 の 32 バイトの seed）。
 * 宛先は**固定**（devnet の公開 RPC、x402.org、Circle の testnet の facilitator）。上書きの env は持たない（別の宛先に支払いの署名を送らない）。
 * 終了コード: verify が `isValid: true` のときだけ 0。
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
if (!((rail === "svm" && (command === "prepare" || command === "verify")) || (rail === "arc" && command === "verify"))) {
  process.stderr.write("usage: rails-verify-probe.ts svm prepare|verify | arc verify\n");
  process.exit(2);
}

if (rail === "arc") {
  // ---- Arc testnet（Circle の Facilitator Service）。/verify だけ。
  const ARC = "eip155:5042002";
  const arcEntry = KNOWN_NETWORKS.find((n) => n.network === ARC)!;
  const arcAsset = arcEntry.assets[0]!;
  const readEnv = (file: string, name: string): string => {
    const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
    if (line === undefined) { process.stderr.write(`${name} is required in ${file}\n`); process.exit(2); }
    return line.slice(name.length + 1).trim();
  };
  const receiverKey = readEnv(".claude_workflow/local/t6-arc.env", "T6_ARC_RECEIVER_KEY");
  const payerKey = readEnv(".claude_workflow/local/t7-disposable-key.env", "T7_PAYER_PRIVATE_KEY");
  const { createRealSellerProofCapability } = await import("./real-seller-proof-capability.js");
  const { createX402Inbound } = await import("../src/adapters/inbound/x402.js");
  const { createX402Payer } = await import("./x402-payer.js");
  const sellerProof = createRealSellerProofCapability(ARC, { SUBETHA_ARC_RECEIVER_KEY: receiverKey });
  const facilitatorUrl = "https://api.circle.com/v1/facilitator/x402";
  const arcRecord: Record<string, unknown> = { at: new Date().toISOString(), rail, command, network: ARC, asset: arcAsset.id, receiver: sellerProof.address, facilitatorUrl };
  const transport = createGuardedTransport({ allowLoopback: false, report: (event) => { (arcRecord["transportEvents"] as unknown[] | undefined)?.push(event) ?? (arcRecord["transportEvents"] = [event]); }, dns: { timeoutMs: 3_000, maxInFlight: 4 } });
  const diagnostics: string[] = [];
  const arcRail = createX402Inbound({ kind: "circle", sellerProof, facilitatorUrl, payTo: sellerProof.address, transport, assetDomain: arcAsset.domain!, onDiagnostic: (code) => diagnostics.push(code) });
  const offer = await arcRail.createOffer({ routeId: "t6-probe", amount: "10000", asset: arcAsset.id, network: ARC, routeBinding: "t6-probe|GET|%2Ft6", nowMs: Date.now() });
  const payer = createX402Payer(payerKey);
  arcRecord["payer"] = payer.address;
  const credential = JSON.parse(Buffer.from(await payer.credentialFor(offer as never, 5042002), "base64").toString("utf8")) as { x402Version: number; accepted: never; payload: Record<string, unknown> & { challengeNonce: string } };
  const preflight = arcRail.preflight(offer, credential as never, Date.now());
  arcRecord["preflight"] = preflight;
  if (!preflight.ok) {
    writeFileSync(".claude_workflow/local/t6-arc-verify.json", `${JSON.stringify(arcRecord, null, 2)}\n`);
    process.stderr.write(`preflight refused: ${JSON.stringify(preflight)}\n`);
    process.exit(1);
  }
  const verified = await arcRail.verify(offer, credential as never, { routeId: "t6-probe" });
  arcRecord["verify"] = verified;
  arcRecord["diagnostics"] = diagnostics;
  writeFileSync(".claude_workflow/local/t6-arc-verify.json", `${JSON.stringify(arcRecord, null, 2)}\n`);
  process.stdout.write(`verify: ${JSON.stringify(verified)} (receiver ${sellerProof.address}; no settle was sent)\n`);
  process.exit(verified.isValid ? 0 : 1);
}
const rpcUrl = "https://api.devnet.solana.com";
const facilitatorUrl = "https://www.x402.org/facilitator";
const signerOrExit = async (name: string) => {
  try {
    return await svmSignerFromKey(env(name));
  } catch {
    // 鍵の値を文言に出さない。
    process.stderr.write(`${name} is not a usable Solana key (base58 32/64 bytes or 32-byte hex seed)\n`);
    process.exit(2);
  }
};
const payer = await signerOrExit("T6_SOLANA_PAYER_KEY");
const receiver = await signerOrExit("T6_SOLANA_RECEIVER_KEY");
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
  let svmPayer;
  try {
    svmPayer = await createSvmPayer(env("T6_SOLANA_PAYER_KEY"), { rpcUrl });
  } catch {
    process.stderr.write("T6_SOLANA_PAYER_KEY is not a usable Solana key\n");
    process.exit(2);
  }
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
  process.exit(verified.isValid ? 0 : 1);
}
