/**
 * MPP Solana の送信 adapter（`docs/mpp-solana-design.md` §4.3〜§4.6、要件 FR-51〜FR-54、SR-M3・SR-M4。タスク M4-b）。**無課金・Linux で受け入れ**。
 *
 * - 上流は **本物の pay-kit の server**（fixture `mpp-solana-upstream.ts`。feePayer: true = pull。共同署名して fixture の RPC に送出し、確定を待って領収を返す）
 * - Router の署名は毎回の乱数の seed で本当に行う。資金は動かない（RPC は fixture）
 * - transport は本番の方針（loopback 不可・名前解決の fixture・`dialForTest`。上流・RPC は平文 http）
 * - 観測点: 署名器の回数・bytes、上流の `seen`（支払い要求・credential・領収）、RPC の `sent`・`transactions`、結果の `outcome`／`reason`
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { getBase58Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Credential } from "mppx";

import { createCredentialHookOf, createMppSolanaOutbound, MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS, MPP_SOLANA_OUTBOUND_SEND_WITHIN_MS, MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS, type MppSolanaOutbound, type MppSolanaOutboundOptions } from "../../src/adapters/outbound/mpp-solana.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import type { DynamicProfile } from "../../src/config.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, MessageReservation, PayRequest, PayResult } from "../../src/ports/outbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startMppSolanaUpstream, type MppSolanaUpstream, type MppSolanaUpstreamOptions } from "../fixtures/mpp-solana-upstream.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { createSvmSignerFixture, type SvmSignerFixture } from "../fixtures/svm-signer-fixture.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const RPC_HOST = "rpc.provider.test";
const PROVIDER_HOST = "provider.test";
const ROUTE = "md-sol-mpp";
const PROFILE_ID = "dyn-x402-to-solmpp";
const UPSTREAM = `https://${PROVIDER_HOST}/v1/eth/snapshot`;
const URL_A = `https://${PROVIDER_HOST}/v1/price?symbol=ETH`;
const OPERATOR_BASE = "0x00000000000000000000000000000000000000b0";
const OPERATOR_SOL_OWNER = "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1";
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, payTo: OPERATOR_BASE },
  rail: "mpp",
  destination: { scheme: "solana/charge", network: SOL, asset: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};

async function ataOf(owner: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

interface Harness {
  rail: MppSolanaOutbound;
  signer: SvmSignerFixture;
  router: string;
  routerAta: string;
  recipient: string;
  recipientAta: string;
  rpc: SolanaRpcFixture;
  /** pay-kit の server が使う RPC の口（chain の state は `rpc` と共有）。 */
  payKitRpc: SolanaRpcFixture;
  upstream: MppSolanaUpstream;
  routes: Record<string, number>;
  dialed: string[];
  clock: { now: number };
  hooks: NonNullable<MppSolanaOutboundOptions["hooksForTest"]>;
  reservations: Set<string>;
  operators: Set<string>;
  mark: () => number;
  since: (mark: number) => string[];
}

async function harness(options: { startup?: boolean; staticRoute?: boolean; recipientAtaExists?: boolean; routerBalance?: string; upstream?: Partial<MppSolanaUpstreamOptions>; adapter?: Partial<MppSolanaOutboundOptions> } = {}): Promise<Harness> {
  const signer = createSvmSignerFixture(SOL);
  const router = signer.address;
  const routerAta = await ataOf(router);
  const recipient = createSvmSignerFixture(SOL).address;
  const recipientAta = await ataOf(recipient);
  // Router の RPC（要求を数える口）と pay-kit の server の RPC（別の口。state = chain は共有）。
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, atas: [{ address: routerAta, owner: router, amount: options.routerBalance ?? "1000000" }, ...(options.recipientAtaExists === false ? [] : [{ address: recipientAta, owner: recipient }])] });
  closers.push(rpc.close);
  const payKitRpc = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: rpc });
  closers.push(payKitRpc.close);
  // pay-kit の server の確定待ち: fixture の status の列（既定は 1 回目で confirmed）。
  rpc.state.signatureStatuses = ["confirmed"];
  const upstream = await startMppSolanaUpstream({ rpcUrl: payKitRpc.url, feePayer: true, recipient, tls: TLS, ...(options.upstream ?? {}) });
  closers.push(upstream.close);
  const routes: Record<string, number> = { [PROVIDER_HOST]: upstream.port, [RPC_HOST]: rpc.port };
  const dialed: string[] = [];
  const dial = dialTo(routes);
  const base = { allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: (target: Parameters<typeof dial>[0]) => { dialed.push(target.hostname); return dial(target); } };
  const transport = createGuardedTransport(base);
  const dynamicTransport = createGuardedTransport({ ...base, maxHeaderSize: DYNAMIC_RESPONSE_LIMITS.maxHeaderBytes, dns: { timeoutMs: 2_000, maxInFlight: 16 } });
  const rpcTransport = createGuardedTransport({ ...base, dns: { timeoutMs: 3_000, maxInFlight: 4 } });
  const clock = { now: Date.now() };
  const hooks: NonNullable<MppSolanaOutboundOptions["hooksForTest"]> = {};
  const operators = new Set<string>([OPERATOR_BASE, OPERATOR_SOL_OWNER, router]);
  const staticRoute = options.staticRoute ?? true;
  const rail = createMppSolanaOutbound({
    network: SOL,
    upstreams: staticRoute ? { [ROUTE]: UPSTREAM } : {},
    destinations: staticRoute ? { [ROUTE]: { payTo: recipient, asset: MINT, scheme: "solana/charge" } } : {},
    capability: signer.capability,
    transport,
    rpc: { url: `http://${RPC_HOST}`, transport: rpcTransport },
    operatorAddresses: operators,
    mint: MINT,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM,
    dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport: dynamicTransport, denyHosts: [] },
    now: () => clock.now,
    hooksForTest: hooks,
    ...(options.adapter ?? {}),
  });
  if (options.startup !== false) await rail.startup();
  const h: Harness = { rail, signer, router, routerAta, recipient, recipientAta, rpc, payKitRpc, upstream, routes, dialed, clock, hooks, reservations: new Set(), operators, mark: () => rpc.calls.length, since: (mark) => rpc.calls.slice(mark).map((c) => c.method) };
  return h;
}

let paymentSeq = 0;
function requestOf(h: Harness, offer: DestinationOffer, overrides: Partial<PayRequest> & { noReserve?: boolean } = {}): PayRequest {
  paymentSeq += 1;
  const { noReserve, ...rest } = overrides;
  const reserveMessage = async (hash: string): Promise<MessageReservation> => {
    if (h.reservations.has(hash)) return "collision";
    h.reservations.add(hash);
    return "reserved";
  };
  return { routeId: ROUTE, offer, paymentId: `11111111-2222-4333-8444-${String(paymentSeq).padStart(12, "0")}`, attempt: 1, deadlineMs: h.clock.now + 600_000, ...(noReserve ? {} : { reserveMessage }), ...rest };
}

/** 上流が受けた credential（`Authorization: Payment <wire>`）の transaction。 */
function sentWireOf(h: Harness, index = 0): Uint8Array {
  const header = h.upstream.seen.credentials[index]!;
  const decoded = Credential.deserialize(header) as unknown as { payload: { type: string; transaction: string } };
  expect(decoded.payload.type).toBe("transaction");
  return new Uint8Array(Buffer.from(decoded.payload.transaction, "base64"));
}

function instructionsOf(wire: Uint8Array): { count: number; memo: string | undefined } {
  const tx = getTransactionDecoder().decode(wire);
  const message = getCompiledTransactionMessageDecoder().decode(new Uint8Array(tx.messageBytes)) as unknown as { instructions: ReadonlyArray<{ data?: Uint8Array }> };
  const last = message.instructions[message.instructions.length - 1]!;
  const memo = message.instructions.length === 4 ? Buffer.from(last.data ?? new Uint8Array()).toString("utf8") : undefined;
  return { count: message.instructions.length, memo };
}

async function quoteAndPay(h: Harness, overrides: Partial<PayRequest> & { noReserve?: boolean } = {}): Promise<{ offer: DestinationOffer; request: PayRequest; result: PayResult }> {
  const offers = await h.rail.readChallenge(ROUTE);
  expect(offers).toHaveLength(1);
  const request = requestOf(h, offers[0]!, overrides);
  const result = await h.rail.pay(request);
  return { offer: offers[0]!, request, result };
}

describe("startup・balanceOf", () => {
  test("startup の前は readChallenge・pay・balanceOf が throw。startup で Router の ATA が運用者の集合に入り、静的の宛先 ATA を RPC で検査する", async () => {
    const h = await harness({ startup: false });
    await expect(h.rail.readChallenge(ROUTE)).rejects.toThrow(/startup\(\) has not completed/);
    await expect(h.rail.pay(requestOf(h, { scheme: "solana/charge", network: SOL, asset: MINT, amount: "1", payTo: h.recipient }))).rejects.toThrow(/startup\(\) has not completed/);
    await expect(h.rail.balanceOf(ROUTE, MINT)).rejects.toThrow(/startup\(\) has not completed/);
    expect(h.rpc.calls).toHaveLength(0);
    await h.rail.startup();
    expect(h.operators.has(h.routerAta)).toBe(true);
    expect(h.since(0)).toEqual(["getAccountInfo"]);
    expect((h.rpc.calls[0]!.params as unknown[])[0]).toBe(h.recipientAta);
    expect(h.dialed).toContain(RPC_HOST);
  });

  test("静的 route の宛先 ATA が無ければ startup が throw。balanceOf は Router の ATA の残高（getTokenAccountBalance 1 回）", async () => {
    const missing = await harness({ startup: false, recipientAtaExists: false });
    await expect(missing.rail.startup()).rejects.toThrow(/does not exist/);
    const h = await harness({ routerBalance: "123456789" });
    expect(await h.rail.balanceOf(ROUTE, MINT)).toBe(123456789n);
    await expect(h.rail.balanceOf(ROUTE, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).rejects.toThrow(/different asset/);
  });

  test("組み立ての検査と既定値: 能力の network・鍵の形、静的 route の scheme・mint、動的プロファイルの scheme、期限の定数", async () => {
    const h = await harness();
    const base: MppSolanaOutboundOptions = { network: SOL, upstreams: {}, destinations: {}, capability: h.signer.capability, transport: createGuardedTransport({ allowLoopback: false, report: () => {} }), rpc: { url: `http://${RPC_HOST}`, transport: createGuardedTransport({ allowLoopback: false, report: () => {} }) }, operatorAddresses: new Set(), mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM };
    expect(() => createMppSolanaOutbound({ ...base, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })).toThrow(/different network/);
    expect(() => createMppSolanaOutbound({ ...base, upstreams: { r: UPSTREAM }, destinations: { r: { payTo: h.recipient, asset: MINT, scheme: "exact" } } })).toThrow(/solana\/charge/);
    expect(() => createMppSolanaOutbound({ ...base, upstreams: { r: `${UPSTREAM}?x=1` }, destinations: { r: { payTo: h.recipient, asset: MINT, scheme: "solana/charge" } } })).toThrow(/query/);
    expect(() => createMppSolanaOutbound({ ...base, dynamic: { profiles: { p: { ...PROFILE, destination: { ...PROFILE.destination, scheme: "exact" } } }, transport: createGuardedTransport({ allowLoopback: false, report: () => {}, dns: { timeoutMs: 1_000, maxInFlight: 1 } }), denyHosts: [] } })).toThrow(/solana\/charge profile/);
    expect(MPP_SOLANA_OUTBOUND_UNPAID_TIMEOUT_MS).toBe(10_000);
    expect(MPP_SOLANA_OUTBOUND_PAID_TIMEOUT_MS).toBe(45_000);
    expect(MPP_SOLANA_OUTBOUND_SEND_WITHIN_MS).toBe(10_000);
  });
});

describe("成功: 静的と動的が delivered（pull。pay-kit の server が共同署名して送出し、Router が領収を chain の取引と照合する）", () => {
  test("静的: 署名 1 回・支払い要求 1 件・pay-kit の本物の検証を通る・領収の reference = 共同署名された取引の [0]・message は予約した snapshot。Memo は無い（externalId 無し）", async () => {
    const h = await harness();
    const after = h.mark();
    const offers = await h.rail.readChallenge(ROUTE);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ scheme: "solana/charge", network: SOL, asset: MINT, amount: "10000", payTo: h.recipient });
    expect(offers[0]!.extra).toMatchObject({ feePayerKey: h.upstream.operator, decimals: 6, tokenProgram: TOKEN_PROGRAM });
    expect(offers[0]!.extra).not.toHaveProperty("scope");
    expect(offers[0]!.extra).not.toHaveProperty("externalId");
    expect(h.since(after)).toEqual([]); // 静的の quote は RPC を呼ばない
    const request = requestOf(h, offers[0]!);
    const result = await h.rail.pay(request);
    expect(result).toMatchObject({ outcome: "paid", body: { ok: true, source: "mpp-solana-provider" }, contentType: "application/json" });
    const txRef = (result as { txRef: string }).txRef;
    expect(getBase58Encoder().encode(txRef).length).toBe(64);
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.payCalls).toBe(1);
    expect(h.upstream.seen.challengeCalls).toBe(2); // quote と pay の読み直し
    // Router が送った wire: [0] 空（fee payer）、[1] Router の署名、命令 3 つ（Memo 無し）。
    const wire = sentWireOf(h);
    expect(wire[0]).toBe(2);
    expect(wire.subarray(1, 65).every((b) => b === 0)).toBe(true);
    // 署名器に渡った bytes は、送った transaction の message と一致。
    expect(Buffer.from(h.signer.signed[0]!)).toEqual(Buffer.from(getTransactionDecoder().decode(wire).messageBytes));
    expect(instructionsOf(wire)).toEqual({ count: 3, memo: undefined });
    // chain（fixture）上の取引: pay-kit の server が共同署名して送出した 1 件。[0] = reference、message は Router が署名した snapshot。
    expect(h.rpc.state.sent).toHaveLength(1);
    const onChain = new Uint8Array(Buffer.from(h.rpc.state.transactions.get(txRef)!.base64, "base64"));
    expect(Buffer.from(getTransactionDecoder().decode(onChain).messageBytes)).toEqual(Buffer.from(getTransactionDecoder().decode(wire).messageBytes));
    expect(onChain.subarray(1, 65).some((b) => b !== 0)).toBe(true);
    expect(Buffer.from(onChain.subarray(65, 129))).toEqual(Buffer.from(wire.subarray(65, 129)));
    // 領収は pay-kit が出したもの（challengeId 付き）。
    const receipt = JSON.parse(Buffer.from(h.upstream.seen.receipts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({ method: "solana", status: "success", reference: txRef });
    expect(typeof receipt["challengeId"]).toBe("string");
    // Router の RPC: pay の getAccountInfo（ATA の再確認）・getLatestBlockhash・getTransaction（領収）。pay-kit の server の RPC も同じ fixture に来る。
    // Router の RPC（pay-kit の server の RPC は別の口）: pay の getAccountInfo（ATA の再確認）・getLatestBlockhash・getTransaction（領収）の 3 回だけ。method は 4 つの中（SR-M1）。
    expect(h.since(after)).toEqual(["getAccountInfo", "getLatestBlockhash", "getTransaction"]);
    expect(h.payKitRpc.calls.map((c) => c.method)).toEqual(expect.arrayContaining(["simulateTransaction", "sendTransaction", "getSignatureStatuses", "getTransaction"]));
    expect(h.dialed.every((host) => [PROVIDER_HOST, RPC_HOST].includes(host))).toBe(true);
  });

  test("externalId のある challenge: offer に externalId、送った transaction は Memo 付きの 4 命令で Memo = externalId。領収の externalId も一致", async () => {
    const h = await harness({ upstream: { externalId: "order-77" } });
    const { offer, result } = await quoteAndPay(h);
    expect(offer.extra?.["externalId"]).toBe("order-77");
    expect(result.outcome).toBe("paid");
    expect(instructionsOf(sentWireOf(h))).toEqual({ count: 4, memo: "order-77" });
    const receipt = JSON.parse(Buffer.from(h.upstream.seen.receipts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(receipt["externalId"]).toBe("order-77");
  });

  test("動的: プロファイル経由で delivered。quote は候補の宛先 ATA の存在を getAccountInfo 1 回で見る。URL の規則（拒否ホスト）は readChallenge で DynamicChallengeError(url)", async () => {
    const h = await harness();
    const after = h.mark();
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(offers).toHaveLength(1);
    expect(h.since(after)).toEqual(["getAccountInfo"]);
    const request = requestOf(h, offers[0]!, { routeId: PROFILE_ID, target: { url: URL_A } });
    const result = await h.rail.pay(request);
    expect(result).toMatchObject({ outcome: "paid", body: { ok: true, source: "mpp-solana-provider" } });
    expect(h.upstream.seen.paths).toEqual(["/v1/price?symbol=ETH"]);
    expect(h.signer.signCount()).toBe(1);
    // 動的経路を持たない route id・静的 route に target を付けた要求は候補外。
    await expect(h.rail.readChallenge("other", { url: URL_A })).rejects.toThrow(/no dynamic mpp solana profile/);
    const denied = await harness({ adapter: { dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport: createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], lookup: publicLookup(), dialForTest: dialTo(h.routes), dns: { timeoutMs: 2_000, maxInFlight: 16 } }), denyHosts: [PROVIDER_HOST] } } });
    await expect(denied.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toThrow(/rejected: url/);
  });

  test("動的の宛先 ATA の存在は quote で 1 回読み、その quote の寿命（challenge の期限 + 猶予）の中の 402 の読み直しでは読まない。送る直前の再確認は必ず読む（SR-M1: purchase ごとに getAccountInfo は quote 1 + 送る直前 1）", async () => {
    const h = await harness();
    const after = h.mark();
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(h.since(after)).toEqual(["getAccountInfo"]);
    // purchase の中の読み直し（core は settle の前と後に 402 を読み直す）: 時計が 45 秒進んでも（challenge の期限の内側 = quote の寿命の内側）読まない。
    h.clock.now += 45_000;
    await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(h.since(after)).toEqual(["getAccountInfo"]);
    // 送る直前は必ず読む。
    const result = await h.rail.pay(requestOf(h, offers[0]!, { routeId: PROFILE_ID, target: { url: URL_A } }));
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "paid" });
    expect(h.since(after).filter((m) => m === "getAccountInfo")).toHaveLength(2);
    // 別の宛先（別の Provider D = 別の受取 ATA）の quote は読む（証拠は ATA ごと）。
    const other = await startMppSolanaUpstream({ rpcUrl: h.payKitRpc.url, feePayer: true, tls: TLS });
    closers.push(other.close);
    h.rpc.state.atas = [...h.rpc.state.atas, { address: await ataOf(other.recipient), owner: other.recipient }];
    h.routes[PROVIDER_HOST] = other.port;
    await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(h.since(after).filter((m) => m === "getAccountInfo")).toHaveLength(3);
  });

  test("feePayer: false の上流（push）は候補外（pull だけ。D-23）: readChallenge は空、pay は destination_offer_not_allowed", async () => {
    const h = await harness({ upstream: { feePayer: false } });
    expect(await h.rail.readChallenge(ROUTE)).toEqual([]);
    const pull = await harness();
    const offers = await pull.rail.readChallenge(ROUTE);
    // pull の offer を push の上流に払おうとしても、読み直しで変わっているので払わない。
    const result = await h.rail.pay(requestOf(h, { ...offers[0]!, payTo: h.recipient }));
    expect(result).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(h.signer.signCount()).toBe(0);
  });
});

describe("送出前の失敗（§4.3 の各段。署名も送出もしない、または署名はしたが送出しない）", () => {
  test("期限（1 と 9 と 12）・予約の口・候補外・読み直しの失敗", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(ROUTE);
    const offer = offers[0]!;
    expect(await h.rail.pay(requestOf(h, offer, { deadlineMs: h.clock.now }))).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(await h.rail.pay(requestOf(h, offer, { noReserve: true }))).toEqual({ outcome: "not_sent", reason: "destination_reservation_unsupported" });
    expect(await h.rail.pay(requestOf(h, { ...offer, payTo: h.router }))).toEqual({ outcome: "not_sent", reason: "destination_offer_not_allowed" });
    expect(await h.rail.pay(requestOf(h, { ...offer, extra: { ...offer.extra, feePayerKey: h.router } }))).toEqual({ outcome: "not_sent", reason: "destination_offer_not_allowed" });
    expect(await h.rail.pay(requestOf(h, { ...offer, network: "eip155:84532" }))).toEqual({ outcome: "not_sent", reason: "destination_signer_network_mismatch" });
    expect(await h.rail.pay(requestOf(h, { ...offer, amount: "10001" }))).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    h.upstream.state.noChallenge = true;
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    h.upstream.state.noChallenge = false;
    // 期限が署名の直前に来る（afterReserve の後）。
    h.hooks.afterReserve = () => { h.clock.now += 600_001; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    delete h.hooks.afterReserve;
    h.clock.now = Date.now();
    h.reservations.clear(); // fixture の blockhash は固定なので同じ offer の message は同じ（FR-37 の衝突は別の段で見る）
    // 期限が送出の直前に来る（afterSign の後）: 署名はしたが送出しない。
    h.hooks.afterSign = () => { h.clock.now += 600_001; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.payCalls).toBe(0);
  });

  test("ATA 不在・blockhash 不達・blockhash の鮮度（署名の前 5 秒、送出の前 10 秒）・予約の衝突・署名の検証・wire の改変・hook の出力の改変", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    h.rpc.state.atas = h.rpc.state.atas.filter((a) => a.address !== h.recipientAta);
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_ata_missing" });
    h.rpc.state.atas = [...h.rpc.state.atas, { address: h.recipientAta, owner: h.recipient }];
    // Router の口だけ blockhash を返さない（pay-kit の server の口は健在 = challenge は出る）。
    h.rpc.localFailMethods.push("getLatestBlockhash");
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_blockhash_unavailable" });
    h.rpc.localFailMethods.length = 0;
    h.hooks.afterReserve = () => { h.clock.now += 5_001; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_blockhash_stale" });
    delete h.hooks.afterReserve;
    h.clock.now = Date.now();
    h.reservations.clear();
    expect(h.signer.signCount()).toBe(0);
    h.hooks.afterSign = () => { h.clock.now += 10_001; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_blockhash_stale" });
    delete h.hooks.afterSign;
    h.clock.now = Date.now();
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.payCalls).toBe(0);
    // 予約の衝突: 同じ message（同じ blockhash・同じ offer）を 2 回目に予約しようとすると collision。
    h.reservations.clear();
    h.hooks.afterReserve = () => { throw new Error("stop after reserve"); };
    await expect(h.rail.pay(requestOf(h, offer))).rejects.toThrow(/stop after reserve/);
    delete h.hooks.afterReserve;
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_message_collision" });
    h.reservations.clear();
    // 署名の検証。
    h.signer.mode = "broken";
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    h.signer.mode = "ok";
    h.reservations.clear();
    // wire の改変（§4.6 (a) の wire 側）。
    h.hooks.wire = (bytes) => { const copy = Uint8Array.from(bytes); copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0x01; return copy; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_payload_mismatch" });
    delete h.hooks.wire;
    h.reservations.clear();
    // hook の出力の改変（§4.6 (a)）: 別の bytes、別の challenge id → 返った credential の再検査で止まる（送出しない）。
    h.hooks.credential = (wire) => { const d = Credential.deserialize(wire) as unknown as { challenge: unknown; payload: { type: string; transaction: string } }; const bytes = Buffer.from(d.payload.transaction, "base64"); bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01; return Credential.serialize({ ...d, payload: { type: "transaction", transaction: bytes.toString("base64") } } as never); };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_payload_mismatch" });
    h.reservations.clear();
    h.hooks.credential = (wire) => { const d = Credential.deserialize(wire) as unknown as { challenge: { id: string }; payload: unknown }; return Credential.serialize({ ...d, challenge: { ...d.challenge, id: "0".repeat(43) } } as never); };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_payload_mismatch" });
    delete h.hooks.credential;
    expect(h.upstream.seen.payCalls).toBe(0);
  });

  test("並行 2 件（同じ offer・同じ blockhash = 同じ message）: 予約は署名の前なので、署名は 1 回・支払い要求は 1 件・もう 1 件は destination_message_collision", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    const results = await Promise.all([h.rail.pay(requestOf(h, offer)), h.rail.pay(requestOf(h, offer))]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["not_sent", "paid"]);
    expect(results.find((r) => r.outcome === "not_sent")).toEqual({ outcome: "not_sent", reason: "destination_message_collision" });
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.payCalls).toBe(1);
  });

  test("challenge の期限は署名の直前と送出の直前にも見る（FR-53）: 承認の期限の内側でも challenge が切れていれば destination_offer_expired（署名の前なら署名 0、送出の前なら署名 1・送出 0）。予約の記録が失敗すれば destination_message_record_unavailable", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    // pay-kit の challenge は 5 分で切れる。承認の期限は 10 分先。
    h.hooks.afterReserve = () => { h.clock.now += 5 * 60_000 + 1; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_offer_expired" });
    delete h.hooks.afterReserve;
    h.clock.now = Date.now();
    h.reservations.clear();
    expect(h.signer.signCount()).toBe(0);
    h.hooks.afterSign = () => { h.clock.now += 5 * 60_000 + 1; };
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_offer_expired" });
    delete h.hooks.afterSign;
    h.clock.now = Date.now();
    h.reservations.clear();
    expect(h.signer.signCount()).toBe(1);
    expect(h.upstream.seen.payCalls).toBe(0);
    expect(await h.rail.pay(requestOf(h, offer, { reserveMessage: async () => { throw new Error("journal down"); } }))).toEqual({ outcome: "not_sent", reason: "destination_message_record_unavailable" });
    expect(h.signer.signCount()).toBe(1);
  });

  test("hook（createCredential）は検査済みの wire を、選んだ challenge にだけ、1 回だけ返す（§4.6。直接呼ぶ）", async () => {
    const chosen = { used: false } as Parameters<typeof createCredentialHookOf>[0];
    const hook = createCredentialHookOf(chosen);
    const challenge = { id: "abc", realm: "r", method: "solana", intent: "charge", request: { amount: "1" } };
    // id は選んであるが wire がまだ無い（= 検査の前に SDK が hook を呼んだ形）。
    chosen.id = "abc";
    await expect(hook({ challenge })).rejects.toThrow(/before the wire exists/);
    chosen.wire = new Uint8Array([2, 0, 1]);
    await expect(hook({ challenge: { ...challenge, id: "other" } })).rejects.toThrow(/different challenge/);
    await expect(hook({ challenge: "x" })).rejects.toThrow(/different challenge/);
    const credential = await hook({ challenge });
    const decoded = Credential.deserialize(credential) as unknown as { challenge: { id: string }; payload: { type: string; transaction: string } };
    expect(decoded.challenge.id).toBe("abc");
    expect(decoded.payload).toEqual({ type: "transaction", transaction: Buffer.from([2, 0, 1]).toString("base64") });
    await expect(hook({ challenge })).rejects.toThrow(/twice/);
  });

  test("複数の challenge を返す server: 候補は両方 offer になるが、pay は SDK が選んだ challenge と承認値を照合する（選び直さない）→ 承認が 2 つ目なら destination_offer_changed", async () => {
    const h = await harness();
    h.upstream.state.extraChallenge = "first";
    const offers = await h.rail.readChallenge(ROUTE);
    expect(offers.map((o) => o.amount).sort()).toEqual(["10000", "20000"]);
    const real = offers.find((o) => o.amount === "10000")!;
    // SDK は先頭（額 2 倍の写し）を選ぶ → 承認した 10000 の offer とは違う。
    expect(await h.rail.pay(requestOf(h, real))).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(h.signer.signCount()).toBe(0);
    // 写しが末尾なら SDK は本物を選び、本物の承認は通る（写しの承認は changed）。
    h.upstream.state.extraChallenge = "last";
    const copy = offers.find((o) => o.amount === "20000")!;
    expect(await h.rail.pay(requestOf(h, copy))).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect((await h.rail.pay(requestOf(h, real))).outcome).toBe("paid");
  });

  test("読み直しで challenge が変わっていれば destination_offer_changed（同じ host の別の上流 = 額が違う）。期限切れの challenge は destination_offer_expired", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    const other = await startMppSolanaUpstream({ rpcUrl: h.payKitRpc.url, feePayer: true, recipient: h.recipient, usdAmount: "0.02", tls: TLS });
    closers.push(other.close);
    h.routes[PROVIDER_HOST] = other.port;
    expect(await h.rail.pay(requestOf(h, offer))).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    h.routes[PROVIDER_HOST] = h.upstream.port;
    // 期限切れ: adapter の時計を challenge の期限の先に（承認の期限はその先に置く）。
    h.clock.now += 10 * 60_000;
    expect(await h.rail.pay(requestOf(h, offer, { deadlineMs: h.clock.now + 60_000 }))).toEqual({ outcome: "not_sent", reason: "destination_offer_expired" });
    expect(h.signer.signCount()).toBe(0);
  });
});

describe("送出後の結果（要件 FR-53 の表。pull の列）", () => {
  const cases: Array<[MppSolanaUpstream["state"]["pay"], PayResult]> = [
    ["no-receipt", { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt-wrong-challenge", { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt-no-challenge-id", { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt-wrong-reference", { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt-bad-reference", { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt-method-tempo", { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt-payer-mismatch", { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["status-no-receipt", { outcome: "unknown", reason: "destination_pay_unknown" }],
    ["reject", { outcome: "unknown", reason: "destination_pay_unknown" }],
  ];
  for (const [mode, expected] of cases) {
    test(`${mode} → ${expected.outcome} ${"reason" in expected ? expected.reason : ""}`, async () => {
      const h = await harness();
      h.upstream.state.pay = mode;
      const { result } = await quoteAndPay(h);
      expect(result).toEqual(expected);
      expect(h.upstream.seen.payCalls).toBe(1);
      expect(h.signer.signCount()).toBe(1);
    });
  }

  test("整合した領収の非 200 → paid_no_data（受領の参照つき）。整合した 200 で本文が JSON でない／256 KiB 超／途中で切れる → paid_no_data", async () => {
    for (const [mode, reason] of [["status-with-receipt", "paid_data_unavailable"], ["non-json", "unsupported_response"], ["too-large", "response_too_large"], ["truncated", "paid_data_unavailable"]] as const) {
      const h = await harness();
      h.upstream.state.pay = mode;
      const { result } = await quoteAndPay(h);
      expect(result, mode).toMatchObject({ outcome: "paid_no_data", reason });
      // 受領の参照は pay-kit が出した領収そのもの。
      expect((result as { receiptRef?: string }).receiptRef, mode).toBe(h.upstream.seen.receipts[0]);
    }
  });

  test("領収は chain の取引と照合する: getTransaction が null／err／slot 無し／別の取引／message・[0]・[1] のどれか 1 バイト違い → destination_receipt_unverified（領収は正しい形でも）", async () => {
    for (const reply of ["null", "err", "no-slot", "other", "tamper-message", "tamper-sig0", "tamper-sig1"] as const) {
      const h = await harness();
      if (reply === "other") {
        // chain に別の取引（別の Router・別の受取人の購入）を置いておく。
        const foreign = await harness();
        const first = await quoteAndPay(foreign);
        expect(first.result.outcome).toBe("paid");
        for (const [sig, tx] of foreign.rpc.state.transactions) h.rpc.state.transactions.set(sig, tx);
      }
      h.rpc.state.transactionBase64Reply = reply;
      const { result } = await quoteAndPay(h);
      expect(result, reply).toEqual({ outcome: "unknown", reason: "destination_receipt_unverified" });
    }
  });

  test("送出の例外・期限（相手が共同署名して送出したかもしれない）→ unknown destination_pay_unknown: headers の後で止まる上流は有料要求の期限で切れる", async () => {
    const h = await harness({ adapter: { paidTimeoutMs: 1_500 } });
    h.upstream.state.pay = "stall-after-headers";
    const { result } = await quoteAndPay(h);
    // headers は届いた（200 + 領収）ので本文の読取が期限で切れる → paid_no_data（支払いは領収で確かめてある）。
    expect(result).toMatchObject({ outcome: "paid_no_data", reason: "paid_data_unavailable" });
    // 確定待ちが長い（pay-kit の server の polling）: 有料要求の期限の中なら paid、超えれば unknown。
    const slow = await harness();
    slow.rpc.state.signatureStatuses = ["null", "null", "confirmed"]; // pay-kit は 2 秒ごとに読む → 約 4 秒
    const ok = await quoteAndPay(slow);
    expect(ok.result.outcome).toBe("paid");
    const tooSlow = await harness({ adapter: { paidTimeoutMs: 1_000 } });
    tooSlow.rpc.state.signatureStatuses = ["null", "null", "confirmed"];
    const late = await quoteAndPay(tooSlow);
    expect(late.result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(tooSlow.signer.signCount()).toBe(1);
  }, 30_000);
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 合成（`composeRails` → `createRouterCore`。設計 §2.2 の送信側、FR-54: 残高の事前確認）
 * ────────────────────────────────────────────────────────────────────────────── */
import { mkdtemp } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRuntimeConfig } from "../../src/config.js";
import { createRouterCore, type RouterCore } from "../../src/core/orchestrator.js";
import { stableJson } from "../../src/core/intent.js";
import { composeRails, type DynamicTransportHooks } from "../../src/main.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import { FIXTURE_PUBLIC_ADDRESS, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";

/** 受信の stub（受信は本題でない: `source_settled` まで進めるだけ。呼ばれた順を記録する）。 */
class StubInbound implements InboundRail {
  constructor(private readonly log: string[]) {}
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.#issued += 1;
    return { scheme: "exact", network: request.network, asset: request.asset, amount: request.amount, payTo: "0x0000000000000000000000000000000000000b1", maxTimeoutSeconds: 120, extra: { challengeNonce: `0xnonce${this.#issued}`, expiresAt: Math.floor(request.nowMs / 1000) + 60, routeBinding: request.routeBinding } };
  }
  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
    if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
    if (stableJson(credential.accepted) !== stableJson(offer)) return { ok: false, reason: "offer_mismatch" };
    return { ok: true };
  }
  async verify(): Promise<{ isValid: boolean }> {
    this.log.push("verify");
    return { isValid: true };
  }
  async settle(): Promise<SettleResult> {
    this.log.push("settle");
    return { outcome: "settled", txRef: `src-tx-${this.#issued}` };
  }
  credentialFor(offer: InboundOffer): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce } };
  }
}

const opened: RouterCore[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});

async function composed(h: Harness): Promise<{ core: RouterCore; inbound: StubInbound; log: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "mpp-solana-outbound-compose-"));
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: { [ROUTE]: { routeId: ROUTE, canonicalPath: `/v1/routes/${ROUTE}/resource`, rail: "mpp", source: { amount: "20000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, network: "eip155:84532", payTo: "0x00000000000000000000000000000000000000b1" }, destination: { scheme: "solana/charge", network: SOL, asset: MINT, payTo: h.recipient } } },
      budget: { maxPurchases: 10, buckets: [{ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", maxTotal: "100000", maxPerPurchase: "20000" }, { network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "20000" }] },
      dynamic: {
        enabled: true,
        profiles: { [PROFILE_ID]: { profileId: PROFILE_ID, sourceRail: "x402", source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, payTo: "0x00000000000000000000000000000000000000b1" }, rail: "mpp", destination: { scheme: "solana/charge", network: SOL, asset: MINT, decimals: 6 }, par: true, maxUpstreamAmount: "20000", fee: { flat: "1000", bps: 0, min: "1000" } } },
        budget: { maxPurchases: 10, buckets: [{ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", maxTotal: "100000", maxPerPurchase: "40000" }, { network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "40000" }] },
        denyHosts: [],
      },
    },
    x402: { upstreams: { [ROUTE]: UPSTREAM } },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
    ROUTER_X402_INBOUND_FACILITATOR_URL: "https://legacy.facilitator.test",
    ROUTER_SOLANA_RPC_URL: `http://${RPC_HOST}`,
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
  };
  const config = loadRuntimeConfig(env, (file) => readFileSync(file, "utf8"), { networks: TEST_NETWORKS });
  const hooks: DynamicTransportHooks = {
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (_hostname, _options, callback) => callback(null, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]),
    dialForTest: (target) => { const port = h.routes[target.hostname]; if (port === undefined) throw new UnmappedFixtureHostError(); return { host: "127.0.0.1", port }; },
  };
  const rails = composeRails(config, { svmSigning: { [SOL]: h.signer.capability }, knownNetworksForTest: TEST_NETWORKS, transportHooksForTest: hooks, dynamicTransportHooksForTest: hooks }, () => {}, () => {});
  await rails.startup!();
  const log: string[] = [];
  const inbound = new StubInbound(log);
  const core = await createRouterCore({ journalPath: config.journalPath, config: config.router, inbound, outbound: rails.outbound, note: () => {}, balanceOf: async (id, asset) => { log.push("balance"); return rails.balanceOf!(id, asset); }, dynamic: { ledgerDir: path.join(dir, "dynamic-quotes") } });
  opened.push(core);
  return { core, inbound, log };
}

describe("合成: Solana 宛の MPP 送信（設計 §2.2、FR-54）", () => {
  test("静的 route が core を通して delivered（受信は stub）。残高の事前確認（getTokenAccountBalance）は受信の verify の前に 1 回。不足 → operator_funds_unavailable、RPC の失敗 → 同じ。どちらも署名しない", async () => {
    const h = await harness({ routerBalance: "1000000" });
    const { core, inbound, log } = await composed(h);
    const quote = await core.quote({ principalId: "judge", requestId: "req-1", routeId: ROUTE });
    expect(quote.ok, JSON.stringify(quote)).toBe(true);
    const q = quote as Extract<typeof quote, { ok: true }>;
    expect(q.destination).toMatchObject({ asset: MINT, network: SOL, quoted: "10000" });
    const before = h.mark();
    const purchase = await core.purchase({ principalId: "judge", requestId: "req-1", quoteId: q.quoteId, approval: q.quoteId, credential: inbound.credentialFor(q.source.offer) });
    expect(purchase.status, JSON.stringify(purchase)).toBe("delivered");
    expect(log).toEqual(["balance", "verify", "settle"]);
    expect(h.since(before)[0]).toBe("getTokenAccountBalance");
    expect(h.since(before).filter((m) => m === "getTokenAccountBalance")).toHaveLength(1);
    expect(h.signer.signCount()).toBe(1);
    expect(core.status(q.paymentId, "judge")?.destination.txRef).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    // 不足: 残高 1 base unit。
    h.rpc.state.atas = h.rpc.state.atas.map((a) => (a.address === h.routerAta ? { ...a, amount: "1" } : a));
    const q2 = (await core.quote({ principalId: "judge", requestId: "req-2", routeId: ROUTE })) as Extract<typeof quote, { ok: true }>;
    expect(await core.purchase({ principalId: "judge", requestId: "req-2", quoteId: q2.quoteId, approval: q2.quoteId, credential: inbound.credentialFor(q2.source.offer) })).toMatchObject({ status: "awaiting_payment", code: "operator_funds_unavailable" });
    // RPC の失敗（Router の口だけ）。
    h.rpc.state.atas = h.rpc.state.atas.map((a) => (a.address === h.routerAta ? { ...a, amount: "1000000" } : a));
    h.rpc.localFailMethods.push("getTokenAccountBalance");
    const q3 = (await core.quote({ principalId: "judge", requestId: "req-3", routeId: ROUTE })) as Extract<typeof quote, { ok: true }>;
    expect(await core.purchase({ principalId: "judge", requestId: "req-3", quoteId: q3.quoteId, approval: q3.quoteId, credential: inbound.credentialFor(q3.source.offer) })).toMatchObject({ status: "awaiting_payment", code: "operator_funds_unavailable" });
    expect(h.signer.signCount()).toBe(1);
    expect(log.filter((e) => e === "verify")).toHaveLength(1);
  });

  test("動的プロファイルが core を通して delivered（quote_url → purchase）。動的の core でも残高の事前確認は受信の verify の前、不足 → operator_funds_unavailable", async () => {
    const h = await harness({ routerBalance: "1000000" });
    const { core, inbound, log } = await composed(h);
    const quote = await core.quote({ principalId: "judge", requestId: "req-d1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "judge" });
    expect(quote.ok, JSON.stringify(quote)).toBe(true);
    const q = quote as Extract<typeof quote, { ok: true }>;
    const before = h.mark();
    const purchase = await core.purchase({ principalId: "judge", requestId: "req-d1", quoteId: q.quoteId, approval: q.quoteId, credential: inbound.credentialFor(q.source.offer), ownerKey: q.ownerKey!, source: "judge" });
    expect(purchase.status, JSON.stringify(purchase)).toBe("delivered");
    expect(log).toEqual(["balance", "verify", "settle"]);
    expect(h.since(before)[0]).toBe("getTokenAccountBalance");
    expect(h.upstream.seen.paths).toEqual(["/v1/price?symbol=ETH"]);
    h.rpc.state.atas = h.rpc.state.atas.map((a) => (a.address === h.routerAta ? { ...a, amount: "1" } : a));
    const q2 = (await core.quote({ principalId: "judge", requestId: "req-d2", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "judge" })) as Extract<typeof quote, { ok: true }>;
    expect(await core.purchase({ principalId: "judge", requestId: "req-d2", quoteId: q2.quoteId, approval: q2.quoteId, credential: inbound.credentialFor(q2.source.offer), ownerKey: q2.ownerKey!, source: "judge" })).toMatchObject({ status: "awaiting_payment", code: "operator_funds_unavailable" });
    expect(h.signer.signCount()).toBe(1);
  });
});
