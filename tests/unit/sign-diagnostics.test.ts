/**
 * 署名の道具の診断の部品（`docs/rejection-reasons-design.md` §6・§12.3・§12.4。タスク R-6）:
 * - `runSign` の `onStage`: 閉じた集合（記録の `signerStage` と同じ）、レールごとの順、投げる・無い callback で結果・stderr・payer の呼び出しが同じ
 * - `observedRpcFetch`: 要求は同じ値のまま渡す、返す応答は同じ object で本文に触れない（pull 0）、送金の method だけを送る前に `attempted`
 *   （`localTxRefOf` の hash）、後は HTTP の status か例外の分類だけ、例外はそのまま投げ直す
 * - `createSignTracker` の畳み方
 */
import { Challenge } from "mppx";
import { keccak256 } from "viem";
import { describe, expect, test } from "vitest";

import { DIAG_SIGNER_STAGES, localTxRefOf, type LocalTxRef } from "../../src/shared/diagnostics.js";
import { createSignTracker, observedRpcFetch, rpcFailureClassOf, sentRawTxOf, type SignRpcObserver } from "../../tools/sign-diagnostics.js";
import { runSign, type SignDeps, type SignStage } from "../../tools/sign-run.js";

const NOW = 1_800_000_000_000;
const EXPIRES = 1_800_000_000 + 600;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const NONCE = `0x${"ab".repeat(32)}`;
const RAW = `0x76${"5a".repeat(120)}` as const;

const quoteOf = (offer: Record<string, unknown>): unknown => ({ quoteId: NONCE, source: { offer } });
const evm = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2", challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: false, ...extra } });
const svm = (): Record<string, unknown> => ({ scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: OWNER, maxTimeoutSeconds: 40, extra: { feePayer: OWNER, memo: NONCE, challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: false } });
const TEMPO_CHALLENGE = Challenge.serialize(Challenge.from({ id: NONCE, realm: "r", method: "tempo", intent: "charge", expires: new Date((EXPIRES - 1) * 1000).toISOString(), request: { amount: "10000", currency: PATHUSD, recipient: RECEIVER, methodDetails: { chainId: 42431 } } } as never) as never);
const mpp = (): Record<string, unknown> => ({ scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { challengeNonce: NONCE, challenge: TEMPO_CHALLENGE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true } });

interface Trace {
  calls: string[];
  stderr: string[];
}
function depsOf(trace: Trace, extra: Partial<SignDeps> = {}, mppFails = false): SignDeps {
  return {
    nowMs: () => NOW,
    readEvmKey: () => {
      trace.calls.push("key:evm");
      return "0x" + "11".repeat(32);
    },
    readSolanaKey: () => {
      trace.calls.push("key:sol");
      return "seed";
    },
    mppPayer: () => ({
      address: "0xMPP",
      async payAndCredential() {
        trace.calls.push("mpp:pay");
        if (mppFails) throw new Error("receipt wait failed");
        return { credential: "wire", txRef: "0xtx" };
      },
    }),
    evmPayer: () => ({
      address: "0xEVM",
      async credentialFor() {
        trace.calls.push("evm:sign");
        return "evm-credential";
      },
    }),
    svmPayer: async () => ({
      address: "SVM",
      async credentialFor() {
        trace.calls.push("svm:sign");
        return "svm-credential";
      },
    }),
    svmMppPayer: async () => ({
      address: "SVMMPP",
      async credentialFor() {
        trace.calls.push("svm-mpp:sign");
        return "Payment svm-mpp-wire";
      },
    }),
    stderr: (text) => trace.stderr.push(text),
    ...extra,
  };
}

describe("runSign の onStage（§6）", () => {
  test.each([
    ["x402 EVM", evm(), ["dispatch", "key_read", "payer_create", "credential_for", "done"]],
    ["x402 SVM", svm(), ["dispatch", "key_read", "payer_create", "credential_for", "done"]],
    ["Tempo MPP", mpp(), ["dispatch", "key_read", "payer_create", "disclosure_written", "pay_and_credential", "envelope", "done"]],
    ["拒否（失効）", evm({ expiresAt: 1 }), ["dispatch", "refused"]],
  ] as const)("%s: 段の順は閉じた集合の中で、callback が無い・投げるときも結果・stderr・payer の呼び出しが同じ", async (_name, offer, expected) => {
    const stages: SignStage[] = [];
    const observed: Trace = { calls: [], stderr: [] };
    const plain: Trace = { calls: [], stderr: [] };
    const throwing: Trace = { calls: [], stderr: [] };
    const a = await runSign(quoteOf(offer), depsOf(observed, { onStage: (e) => stages.push(e.stage) }));
    const b = await runSign(quoteOf(offer), depsOf(plain));
    const c = await runSign(quoteOf(offer), depsOf(throwing, { onStage: () => { throw new Error("observer failure"); } }));
    expect(stages).toEqual(expected);
    for (const stage of stages) expect(DIAG_SIGNER_STAGES).toContain(stage);
    expect(a).toEqual(b);
    expect(c).toEqual(b);
    expect(observed).toEqual(plain);
    expect(throwing).toEqual(plain);
  });

  test("Tempo MPP の送金が投げる: 最後の段は pay_and_credential（開示の後）、例外はそのまま", async () => {
    const stages: SignStage[] = [];
    const trace: Trace = { calls: [], stderr: [] };
    await expect(runSign(quoteOf(mpp()), depsOf(trace, { onStage: (e) => stages.push(e.stage) }, true))).rejects.toThrow("receipt wait failed");
    expect(stages.at(-1)).toBe("pay_and_credential");
    expect(trace.stderr.join("")).toMatch(/^MPP: about to send/);
  });

  test("onStage の段の集合は記録の signerStage の集合と同じ", () => {
    // 型: SignStage = DiagSignerStage。実行時: どのレールでも集合の外の段を出さない（上）。ここでは集合そのものを固定する。
    expect([...DIAG_SIGNER_STAGES]).toEqual(["dispatch", "refused", "key_read", "payer_create", "disclosure_written", "pay_and_credential", "credential_for", "envelope", "done"]);
  });
});

/** pull を数える本文の応答（本文に触れたら pull が起きる）。 */
function countingResponse(status: number): { response: Response; pulls: () => number } {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":"0xcafe"}'));
      controller.close();
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status, headers: { "content-type": "application/json", "content-length": "9999999" } }), pulls: () => pulls };
}

function recordingObserver(): SignRpcObserver & { events: string[]; refs: LocalTxRef[] } {
  const events: string[] = [];
  const refs: LocalTxRef[] = [];
  return {
    events,
    refs,
    sendAttempted: (ref) => {
      refs.push(ref);
      events.push(`attempted:${ref.hash}`);
    },
    sendAnswered: (status) => events.push(`answered:${status}`),
    sendThrew: (error) => events.push(`threw:${error}`),
  };
}

const sendInit = (method = "eth_sendRawTransactionSync"): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: [RAW] }) });

describe("observedRpcFetch（§12.3: 応答の本文を読まない）", () => {
  test.each(["eth_sendRawTransaction", "eth_sendRawTransactionSync"])("%s: 送る前に attempted（手元の hash）、要求は同じ値、応答は同じ object で本文に触れない", async (method) => {
    const observer = recordingObserver();
    const init = sendInit(method);
    const { response, pulls } = countingResponse(200);
    const seen: { input: unknown; init: unknown; eventsAtCall: string[] }[] = [];
    const base = (async (input: unknown, given?: RequestInit) => {
      seen.push({ input, init: given, eventsAtCall: [...observer.events] });
      return response;
    }) as typeof fetch;
    const returned = await observedRpcFetch(observer, base)("https://rpc.example/", init);
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(pulls()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.input).toBe("https://rpc.example/");
    expect(seen[0]!.init).toBe(init);
    // 送る前に attempted が済んでいる。
    expect(seen[0]!.eventsAtCall).toEqual([`attempted:${keccak256(RAW).toLowerCase()}`]);
    expect(observer.events).toEqual([`attempted:${keccak256(RAW).toLowerCase()}`, "answered:200"]);
    // 値は localTxRefOf と同じ形（記録に入れられる唯一の値）。
    expect(observer.refs[0]!.hash).toBe(localTxRefOf(RAW).hash);
  });

  test("送金でない method・読めない本文は観測しない（要求はそのまま通る）", async () => {
    const observer = recordingObserver();
    const base = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const wrapped = observedRpcFetch(observer, base);
    await wrapped("https://rpc.example/", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    await wrapped("https://rpc.example/", { method: "POST", body: "{not json" });
    await wrapped("https://rpc.example/", { method: "POST", body: JSON.stringify({ method: "eth_sendRawTransaction", params: ["not-hex"] }) });
    await wrapped("https://rpc.example/");
    expect(observer.events).toEqual([]);
  });

  test("例外: AbortError → timeout、ほか → other。同じ例外を投げ直す。observer が投げても要求・結果は同じ", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const other = new TypeError("fetch failed");
    for (const [error, cls] of [[abort, "timeout"], [other, "other"]] as const) {
      const observer = recordingObserver();
      const base = (async () => {
        throw error;
      }) as typeof fetch;
      await expect(observedRpcFetch(observer, base)("https://rpc.example/", sendInit())).rejects.toBe(error);
      expect(observer.events.at(-1)).toBe(`threw:${cls}`);
    }
    const throwingObserver: SignRpcObserver = {
      sendAttempted: () => {
        throw new Error("x");
      },
      sendAnswered: () => {
        throw new Error("y");
      },
      sendThrew: () => {
        throw new Error("z");
      },
    };
    const { response } = countingResponse(429);
    await expect(observedRpcFetch(throwingObserver, (async () => response) as typeof fetch)("https://rpc.example/", sendInit())).resolves.toBe(response);
    expect(rpcFailureClassOf({ name: "TimeoutError" })).toBe("timeout");
    expect(rpcFailureClassOf(null)).toBe("other");
  });

  test("sentRawTxOf: 配列（batch）の中の送金も読む", () => {
    expect(sentRawTxOf({ body: JSON.stringify([{ method: "eth_chainId", params: [] }, { method: "eth_sendRawTransaction", params: [RAW] }]) })).toBe(RAW);
    expect(sentRawTxOf({ body: JSON.stringify({ method: "eth_call", params: [RAW] }) })).toBeUndefined();
  });
});

describe("createSignTracker", () => {
  test("not_observed → attempted → accepted / http_error（429 は rate_limited）/ timeout / other", () => {
    const states: string[] = [];
    const tracker = createSignTracker((s) => states.push(`${s.signerStage ?? "-"}:${s.broadcast}:${s.rpc ?? "-"}:${s.rpcHttpStatus ?? "-"}`));
    expect(tracker.snapshot()).toEqual({ broadcast: "not_observed" });
    tracker.onStage({ stage: "pay_and_credential" });
    const ref = localTxRefOf(RAW);
    tracker.observer.sendAttempted(ref);
    tracker.observer.sendAnswered(429);
    expect(tracker.snapshot()).toMatchObject({ signerStage: "pay_and_credential", broadcast: "http_error", rpc: "rate_limited", rpcHttpStatus: 429, txRef: ref });
    tracker.observer.sendAttempted(ref);
    tracker.observer.sendAnswered(200);
    tracker.observer.sendAttempted(ref);
    tracker.observer.sendThrew("timeout");
    tracker.observer.sendAttempted(ref);
    tracker.observer.sendThrew("other");
    tracker.observer.sendAttempted(ref);
    tracker.observer.sendAnswered(503);
    expect(states).toEqual([
      "pay_and_credential:not_observed:-:-",
      "pay_and_credential:attempted:-:-",
      "pay_and_credential:http_error:rate_limited:429",
      "pay_and_credential:attempted:-:-",
      "pay_and_credential:accepted:-:200",
      "pay_and_credential:attempted:-:-",
      "pay_and_credential:timeout:timeout:-",
      "pay_and_credential:attempted:-:-",
      "pay_and_credential:attempted:other:-",
      "pay_and_credential:attempted:-:-",
      "pay_and_credential:http_error:other:503",
    ]);
  });
});
