/**
 * `npm run sign` の本体（`tools/sign-run.ts`）を、鍵の読取と payer を差し替えて試験する（タスク T5 の完了条件）:
 * 拒む offer では鍵を読まず payer を呼ばない／Base Sepolia 10,000・11,000 と Arc は EVM の signer に表の chainId で届く／
 * MPP は開示を書いてから送金し、封筒を保つ／Solana は svm payer に表の値で届く。
 */
import { describe, expect, test } from "vitest";

import { runSign, type SignDeps } from "../../tools/sign-run.js";

const NOW = 1_800_000_000_000;
const EXPIRES = 1_800_000_000 + 600;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const NONCE = `0x${"ab".repeat(32)}`;

function quoteOf(offer: Record<string, unknown>): unknown {
  return { quoteId: NONCE, source: { offer } };
}
function evm(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2", challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: false, ...extra }, ...overrides };
}
function svm(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: OWNER, maxTimeoutSeconds: 40, extra: { feePayer: OWNER, memo: NONCE, challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: false, ...extra } };
}
function mpp(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { challengeNonce: NONCE, challenge: 'Payment id="x", realm="r"', expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true, ...extra } };
}

interface Trace {
  keyReads: string[];
  calls: string[];
  stderr: string[];
}

function depsOf(trace: Trace): SignDeps {
  return {
    nowMs: () => NOW,
    readEvmKey: () => { trace.keyReads.push("evm"); return "0x" + "11".repeat(32); },
    readSolanaKey: () => { trace.keyReads.push("solana"); return "seed"; },
    mppPayer: (key, scope) => ({
      address: "0xMPP",
      async payAndCredential() {
        trace.calls.push(`mpp:pay:${scope.chainId}:${scope.asset}:${scope.payTo}:${scope.maxAmount}:${key.length}`);
        return { credential: "wire-credential", txRef: "0xtx" };
      },
    }),
    evmPayer: () => ({
      address: "0xEVM",
      async credentialFor(_offer, chainId) {
        trace.calls.push(`evm:sign:${chainId}`);
        return "evm-credential";
      },
    }),
    svmPayer: async (_key, options) => ({
      address: "SVM",
      async credentialFor(_offer, scope) {
        trace.calls.push(`svm:sign:${scope.mint}:${scope.decimals}:${scope.tokenProgram}:${options.rpcUrl ?? "default"}`);
        return "svm-credential";
      },
    }),
    stderr: (text) => trace.stderr.push(text),
  };
}

describe("runSign", () => {
  test("Base Sepolia 10,000 と 11,000（動的 quote の額）は EVM の signer に chainId 84532 で届く。Arc は 5042002", async () => {
    for (const [offer, chainId] of [[evm(), 84532], [evm({ amount: "11000" }), 84532], [evm({ network: "eip155:5042002", asset: ARC_USDC }, { assetTransferMethod: "eip3009" }), 5042002]] as const) {
      const trace: Trace = { keyReads: [], calls: [], stderr: [] };
      const outcome = await runSign(quoteOf(offer), depsOf(trace));
      expect(outcome).toMatchObject({ ok: true, stdout: "evm-credential\n" });
      expect(trace.keyReads).toEqual(["evm"]);
      expect(trace.calls).toEqual([`evm:sign:${chainId}`]);
    }
  });

  test("MPP: 開示を書いてから送金し、封筒（x402Version・accepted・payload.challengeNonce・credential）を保つ。上限 20,000 を payer の scope に", async () => {
    const trace: Trace = { keyReads: [], calls: [], stderr: [] };
    const offer = mpp();
    const outcome = await runSign(quoteOf(offer), depsOf(trace));
    expect(outcome.ok).toBe(true);
    expect(trace.keyReads).toEqual(["evm"]);
    expect(trace.calls).toEqual([`mpp:pay:42431:${PATHUSD}:${RECEIVER}:20000:66`]);
    expect(trace.stderr[0]).toContain("**This transfer cannot be undone.** Only run this after a human has approved.");
    expect(trace.stderr[0]).toContain(`MPP: about to send 10000 to ${RECEIVER} on eip155:42431.`);
    const envelope = JSON.parse(Buffer.from((outcome as { stdout: string }).stdout.trim(), "base64").toString("utf8")) as Record<string, unknown>;
    expect(envelope).toEqual({ x402Version: 2, accepted: offer, payload: { challengeNonce: NONCE, credential: "wire-credential" } });
  });

  test("Solana: svm payer に表の mint・桁・token program と RPC の URL で届く", async () => {
    const trace: Trace = { keyReads: [], calls: [], stderr: [] };
    const outcome = await runSign(quoteOf(svm()), { ...depsOf(trace), solanaRpcUrl: "http://127.0.0.1:1" });
    expect(outcome).toMatchObject({ ok: true, stdout: "svm-credential\n" });
    expect(trace.keyReads).toEqual(["solana"]);
    expect(trace.calls).toEqual([`svm:sign:${MINT}:6:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA:http://127.0.0.1:1`]);
  });

  test("拒む offer では鍵を読まず、payer を呼ばない（MPP の challenge 無し・nonce 無し・失効・上限超・表に無い network・SVM の桁の矛盾）", async () => {
    const refused: [string, Record<string, unknown>, RegExp][] = [
      ["MPP の challenge 無し", mpp({ challenge: undefined }), /does not carry the mppx challenge/],
      ["MPP の nonce 無し", mpp({ challengeNonce: undefined }), /challengeNonce/],
      ["EVM の失効", evm({}, { expiresAt: 1 }), /expired/],
      ["上限超", evm({ amount: "20001" }), /exceeds the cap/],
      ["表に無い network", evm({ network: "eip155:1" }), /not in the table/],
      ["SVM の桁の矛盾", svm({ decimals: 18 }), /decimals conflict/],
      ["SVM の token program の矛盾", svm({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }), /token program conflicts/],
      ["offer 無し", {}, /no source.offer/],
    ];
    for (const [name, offer, pattern] of refused) {
      const trace: Trace = { keyReads: [], calls: [], stderr: [] };
      const outcome = await runSign(name === "offer 無し" ? { source: {} } : quoteOf(offer), depsOf(trace));
      expect(outcome.ok, name).toBe(false);
      expect((outcome as { reason: string }).reason, name).toMatch(pattern);
      expect(trace.keyReads, name).toEqual([]);
      expect(trace.calls, name).toEqual([]);
    }
  });
});
