/**
 * SVM 送信の wire 試験の harness（タスク U7）: fixture の facilitator（本物の `@x402/svm` の verify）・Solana RPC・Provider（`svm-upstream`）と、
 * 乱数の seed の署名器で `createX402SvmOutbound` を組む。`tests/wire/x402-svm-outbound.test.ts` と builder を差し替える試験が共有する。
 * 呼び出し側が `TLS` と `closers` を渡す（test file の beforeAll/afterEach が持つ）。
 */
import { createHash } from "node:crypto";

import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { checkSvmTransaction } from "../../src/adapters/inbound/x402-svm.js";
import { createX402SvmOutbound, type X402SvmOutbound, type X402SvmOutboundOptions } from "../../src/adapters/outbound/x402-svm.js";
import type { DynamicProfile } from "../../src/config.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, MessageReservation, PayRequest } from "../../src/ports/outbound.js";
import type { DiagnosticsSink } from "../../src/shared/diagnostics.js";
import { dialTo, publicLookup } from "./dynamic/dial.js";
import { startSolanaRpc, type SolanaRpcFixture } from "./solana-rpc.js";
import { startSvmFacilitator, type SvmFacilitator } from "./svm-facilitator.js";
import { createSvmSignerFixture, type SvmSignerFixture } from "./svm-signer-fixture.js";
import { startSvmUpstream, SVM_FIXTURE_MINT, SVM_FIXTURE_NETWORK, type SvmUpstream } from "./svm-upstream.js";
import type { TlsMaterial } from "./tls/generate.js";

export const SOL = SVM_FIXTURE_NETWORK;
export const MINT = SVM_FIXTURE_MINT;
export const FAC_HOST = "facilitator.provider.test";
export const RPC_HOST = "rpc.provider.test";
export const PROVIDER_HOST = "provider.test";
export const ROUTE = "md-sol-eth-snapshot";
export const PROFILE_ID = "dyn-x402-to-sol";
export const UPSTREAM = `https://${PROVIDER_HOST}/v1/eth/snapshot`;
export const URL_A = `https://${PROVIDER_HOST}/v1/price?symbol=ETH`;
export const OPERATOR_BASE = "0x00000000000000000000000000000000000000b0";
export const OPERATOR_SOL_OWNER = "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1";
export const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, payTo: OPERATOR_BASE },
  rail: "x402",
  destination: { scheme: "exact", network: SOL, asset: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};

export interface Harness {
  readonly rail: X402SvmOutbound;
  readonly signer: SvmSignerFixture;
  readonly router: string;
  readonly routerAta: string;
  readonly provider: string;
  readonly providerAta: string;
  readonly fac: SvmFacilitator;
  readonly rpc: SolanaRpcFixture;
  readonly upstream: SvmUpstream;
  readonly dialed: string[];
  readonly clock: { now: number };
  readonly hooks: NonNullable<X402SvmOutboundOptions["hooksForTest"]>;
  readonly reservations: Set<string>;
  readonly operators: Set<string>;
  readonly rpcTransport: GuardedTransport;
  /** transport の要求と report の記録（`trace.on` が真の間だけ。方法・path・ヘッダの名前・ヘッダの値と本文の hash）。 */
  readonly trace: { on: boolean; readonly lines: string[] };
}

/** 要求の記録の 1 行（値は hash だけ）。 */
function traceLineOf(label: string, input: string | URL, init: RequestInit | undefined, operation: string): string {
  const url = new URL(String(input));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const headerHash = createHash("sha256").update(JSON.stringify(names.map((name) => [name, headers[Object.keys(headers).find((k) => k.toLowerCase() === name)!]]))).digest("hex").slice(0, 16);
  const body = typeof init?.body === "string" ? init.body : "";
  const bodyHash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return `${label} ${operation} ${init?.method ?? "GET"} ${url.host}${url.pathname}${url.search} [${names.join(",")}] h=${headerHash} b=${bodyHash}`;
}

function tracing(label: string, transport: GuardedTransport, trace: { on: boolean; lines: string[] }): GuardedTransport {
  return {
    ...transport,
    fetch: async (input, init, context) => {
      if (trace.on) trace.lines.push(traceLineOf(label, input, init, context.operation));
      try {
        const response = await transport.fetch(input, init, context);
        if (trace.on) trace.lines.push(`${label} ${context.operation} -> ${response.status}`);
        return response;
      } catch (error) {
        if (trace.on) trace.lines.push(`${label} ${context.operation} -> throw ${(error as { code?: unknown }).code ?? (error as Error).name}`);
        throw error;
      }
    },
    report: (error, context) => {
      if (trace.on) trace.lines.push(`${label} report ${context.operation} ${(error as { code?: unknown }).code ?? (error as Error).name}`);
      transport.report(error, context);
    },
  };
}

export async function ataOf(owner: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

export async function harness(env: { TLS: TlsMaterial; closers: Array<() => Promise<void>> }, options: { startup?: boolean; staticRoute?: boolean; providerAtaExists?: boolean; routerBalance?: string; rpcTransport?: (real: GuardedTransport) => GuardedTransport; rpcUrl?: (rpc: SolanaRpcFixture) => string; diagnostics?: DiagnosticsSink; seeds?: { readonly router: Uint8Array; readonly provider: Uint8Array; readonly feePayer: Uint8Array } } = {}): Promise<Harness> {
  // `seeds`: Router・Provider・facilitator の fee payer の鍵を決める（§8.2 の 3 通りの比較を決定的にする試験だけ。タスク R-4）。
  const signer = createSvmSignerFixture(SOL, options.seeds?.router);
  const trace = { on: false, lines: [] as string[] };
  const router = signer.address;
  const routerAta = await ataOf(router);
  const provider = createSvmSignerFixture(SOL, options.seeds?.provider).address;
  const providerAta = await ataOf(provider);
  const { TLS, closers } = env;
  const fac = await startSvmFacilitator(TLS, SOL, undefined, FAC_HOST, options.seeds?.feePayer);
  closers.push(fac.close);
  const rpc = await startSolanaRpc({
    mint: MINT,
    decimals: 6,
    tls: TLS,
    atas: [{ address: routerAta, owner: router, amount: options.routerBalance ?? "1000000" }, ...(options.providerAtaExists === false ? [] : [{ address: providerAta, owner: provider }])],
  });
  closers.push(rpc.close);
  const upstream = await startSvmUpstream(TLS, { port: fac.port, host: FAC_HOST, feePayer: fac.feePayer }, { payTo: provider }, PROVIDER_HOST);
  closers.push(upstream.close);
  const dialed: string[] = [];
  const dial = dialTo({ [PROVIDER_HOST]: upstream.port, [RPC_HOST]: rpc.port, [FAC_HOST]: fac.port });
  const base = {
    allowLoopback: false,
    report: () => {},
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: publicLookup(),
    dialForTest: (target: Parameters<typeof dial>[0]) => { dialed.push(target.hostname); return dial(target); },
  };
  const transport = tracing("upstream", createGuardedTransport(base), trace);
  const dynamicTransport = tracing("dynamic", createGuardedTransport({ ...base, maxHeaderSize: DYNAMIC_RESPONSE_LIMITS.maxHeaderBytes, dns: { timeoutMs: 2_000, maxInFlight: 16 } }), trace);
  const realRpcTransport = createGuardedTransport({ ...base, dns: { timeoutMs: 3_000, maxInFlight: 4 } });
  const rpcTransport = tracing("rpc", options.rpcTransport === undefined ? realRpcTransport : options.rpcTransport(realRpcTransport), trace);
  const clock = { now: Date.now() };
  const hooks: NonNullable<X402SvmOutboundOptions["hooksForTest"]> = {};
  const operators = new Set<string>([OPERATOR_BASE, OPERATOR_SOL_OWNER, router]);
  const staticRoute = options.staticRoute ?? true;
  const railOptions = (diagnostics: DiagnosticsSink | undefined): X402SvmOutboundOptions => ({
    network: SOL,
    upstreams: staticRoute ? { [ROUTE]: UPSTREAM } : {},
    destinations: staticRoute ? { [ROUTE]: { payTo: provider, asset: MINT, scheme: "exact" } } : {},
    capability: signer.capability,
    transport,
    rpc: { url: options.rpcUrl === undefined ? `https://${RPC_HOST}` : options.rpcUrl(rpc), transport: rpcTransport },
    operatorAddresses: operators,
    mint: MINT,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport: dynamicTransport, denyHosts: [] },
    now: () => clock.now,
    hooksForTest: hooks,
    // 診断の記録（タスク R-4 の試験だけが渡す）。
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
  const rail = createX402SvmOutbound(railOptions(options.diagnostics));
  if (options.startup !== false) await rail.startup();

  return { rail, signer, router, routerAta, provider, providerAta, fac, rpc, upstream, dialed, clock, hooks, reservations: new Set(), operators, rpcTransport, trace };
}

let paymentSeq = 0;
export function requestOf(h: Harness, offer: DestinationOffer, overrides: Partial<PayRequest> & { noReserve?: boolean } = {}): PayRequest {
  paymentSeq += 1;
  const { noReserve, ...rest } = overrides;
  const reserveMessage = async (hash: string): Promise<MessageReservation> => {
    if (h.reservations.has(hash)) return "collision";
    h.reservations.add(hash);
    return "reserved";
  };
  return { routeId: ROUTE, offer, paymentId: `11111111-2222-4333-8444-${String(paymentSeq).padStart(12, "0")}`, attempt: 1, deadlineMs: h.clock.now + 600_000, ...(noReserve ? {} : { reserveMessage }), ...rest };
}

/** `seen.paid` の transaction を受信の検査（第 2 層と同じ関数）に掛ける。 */
export function paidTransactionOk(h: Harness, index: number, amount: string, memo: string): boolean {
  const paid = h.upstream.seen.paid[index];
  if (paid?.transactionBase64 === undefined) return false;
  return checkSvmTransaction(paid.transactionBase64, { feePayer: h.fac.feePayer, payTo: h.provider, destinationAta: h.providerAta, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS }, amount, memo).ok;
}

export function rpcMethods(h: Harness): string[] {
  return h.rpc.calls.map((c) => c.method);
}
