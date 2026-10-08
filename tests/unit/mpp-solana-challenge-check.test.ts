/**
 * MPP Solana 送信の純粋関数（`docs/mpp-solana-design.md` §4.2、要件 FR-50・SR-M4。タスク M4-a）: 402 の challenge の view、候補の検査の 9 行、
 * `terms`・offer の形（`id`・`expires` を含まない）、client 側の method。**無課金・RPC 無し**。
 *
 * challenge は本物の `mppx` 0.11.0 の server で発行する（許容の広い schema で、Provider が出し得る欄をそのまま載せる）。wire（`Challenge.serialize`）を
 * 通してから view にするので、`_mppx_scope` は `opaque` から公式の decoder で読む（Tempo と同じ）。
 */
import { describe, expect, test } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address } from "@solana/kit";
import { Challenge, Method, PaymentRequest, z } from "mppx";
import { Mppx as ClientMppx } from "mppx/client";
import { Mppx } from "mppx/server";

import {
  checkMppSolanaChallenge,
  checkMppSolanaChallengeAtas,
  mppSolanaClientMethodOf,
  mppSolanaOfferOf,
  mppSolanaOfferTermsOf,
  mppSolanaReservedAddressesOf,
  mppSolanaViewOf,
  MPP_SOLANA_SCHEME,
  type MppSolanaChallengeRejection,
  type MppSolanaOutboundPolicy,
} from "../../src/adapters/outbound/mpp-solana.js";
import { SYSTEM_PROGRAM_ADDRESS } from "../../src/adapters/outbound/x402-svm.js";
import { MEMO_PROGRAM_ADDRESS } from "../../src/adapters/inbound/x402-svm.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const SECRET = "provider-secret-0123456789abcdef0123456789abcdef";
const URL_A = "https://provider.test/v1/x";
const SCOPE = `GET ${URL_A}`;

let policy: MppSolanaOutboundPolicy;
let recipient: string;
let feePayerKey: string;
let operator: string;
let server: ReturnType<typeof providerServer>;

async function ataOf(owner: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

/**
 * Provider 側（pay-kit の形を模す）: 許容の広い schema で、渡した request（未知の鍵も）をそのまま challenge に載せる。
 * mppx の server は `expires` を request の残りと一緒に schema に通す（strict な schema なら落ちる）ので、loose な schema では transform で除く。
 */
function providerServer() {
  const loose = z.pipe(z.looseObject({}), z.transform((raw: Record<string, unknown>) => { const { expires: _expires, ...rest } = raw; return rest; }));
  const schema = { request: loose, credential: { payload: z.looseObject({}) } };
  const hooks = { validate: async ({ credential }: { credential: { challenge: { request: unknown } } }) => ({ challenge: credential.challenge, credential, details: {}, intent: "charge" as const, method: "solana" as const, request: credential.challenge.request }), broadcast: async () => { throw new Error("x"); } };
  const charge = Method.from({ name: "solana", intent: "charge", schema });
  // `method` の検査用に別の intent も持つ。
  const other = Method.from({ name: "solana", intent: "other", schema });
  return Mppx.create({ secretKey: SECRET, realm: "provider-test", methods: [Method.toServer(charge, hooks as never), Method.toServer(other, hooks as never)] });
}

type Patch = { request?: Record<string, unknown>; details?: Record<string, unknown>; dropDetails?: string[]; dropRequest?: string[]; expiresInMs?: number | null; scope?: string | null; intent?: string };

/** 基準の challenge（pull: `feePayer: true` + `feePayerKey`）に patch を当てて発行し、wire を通した challenge を返す。 */
async function issue(patch: Patch = {}): Promise<Record<string, unknown>> {
  const details: Record<string, unknown> = { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: true, feePayerKey, ...(patch.details ?? {}) };
  for (const key of patch.dropDetails ?? []) delete details[key];
  const request: Record<string, unknown> = { amount: "10000", currency: MINT, recipient, methodDetails: details, ...(patch.request ?? {}) };
  for (const key of patch.dropRequest ?? []) delete request[key];
  const expires = patch.expiresInMs === null ? {} : { expires: new Date(Date.now() + (patch.expiresInMs ?? 60_000)).toISOString() };
  const intents = (server.challenge as unknown as Record<string, Record<string, (args: unknown) => Promise<unknown>>>)["solana"]!;
  const challenge = await intents[patch.intent ?? "charge"]!({ ...request, ...expires, ...(patch.scope === null ? {} : { scope: patch.scope ?? SCOPE }) });
  return Challenge.deserialize(Challenge.serialize(challenge as never)) as unknown as Record<string, unknown>;
}

async function rejectionOf(patch: Patch = {}, override: Partial<MppSolanaOutboundPolicy> = {}, operators: readonly string[] = [operator]): Promise<MppSolanaChallengeRejection | "unreadable" | undefined> {
  const view = mppSolanaViewOf(await issue(patch));
  if (view === undefined) return "unreadable";
  return checkMppSolanaChallenge(view, SCOPE, { ...policy, ...override }, operators, Date.now());
}

describe("MPP Solana 送信: challenge の view と候補の検査（§4.2 の 9 行）", () => {
  test("準備", async () => {
    const router = await generateKeyPairSigner();
    recipient = String((await generateKeyPairSigner()).address);
    feePayerKey = String((await generateKeyPairSigner()).address);
    operator = String((await generateKeyPairSigner()).address);
    policy = { network: SOL, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM, routerAddress: String(router.address), routerAta: await ataOf(String(router.address)) };
    server = providerServer();
  });

  test("基準の challenge（pull）は通る。view は id・realm・scope・額・通貨・受取人・期限を持ち、terms は id と expires を含まない", async () => {
    const challenge = await issue();
    const view = mppSolanaViewOf(challenge)!;
    expect(view).toMatchObject({ id: challenge["id"], realm: "provider-test", method: "solana", intent: "charge", scope: SCOPE, amount: "10000", currency: MINT, recipient });
    expect(view.expiresAt).toBeGreaterThan(Date.now());
    expect(view.terms).not.toContain(String(challenge["id"]));
    expect(view.terms).not.toContain(String(challenge["expires"]));
    expect(view.terms).toContain(feePayerKey);
    expect(checkMppSolanaChallenge(view, SCOPE, policy, [operator], Date.now())).toBeUndefined();
    // 任意の欄を全部持つ形（externalId・description・recentBlockhash）も通る。
    expect(await rejectionOf({ request: { externalId: "order-1", description: "x" }, details: { recentBlockhash: recipient } })).toBeUndefined();
    // `expires` の無い challenge も通る（9 行目は「あれば」）。
    expect(await rejectionOf({ expiresInMs: null })).toBeUndefined();
  });

  test("1: method・intent・scope（scope は無ければ通す = pay-kit の server の形。あれば一致）", async () => {
    expect(await rejectionOf({ intent: "other" })).toBe("method");
    const noScope = mppSolanaViewOf(await issue({ scope: null }))!;
    expect(noScope.scope).toBeUndefined();
    expect(checkMppSolanaChallenge(noScope, SCOPE, policy, [operator], Date.now())).toBeUndefined();
    expect(mppSolanaOfferOf(noScope, policy).extra).not.toHaveProperty("scope");
    expect(await rejectionOf({ scope: "GET https://provider.test/v1/other" })).toBe("scope");
    expect(await rejectionOf({ scope: `POST ${URL_A}` })).toBe("scope");
    const view = mppSolanaViewOf(await issue())!;
    expect(checkMppSolanaChallenge({ ...view, method: "tempo" }, SCOPE, policy, [], Date.now())).toBe("method");
  });

  test("2: request と methodDetails の未知の鍵（splits・confidential・その他）、methodDetails が無い", async () => {
    expect(await rejectionOf({ request: { splits: [{ recipient, amount: "1" }] } })).toBe("unknown_field");
    expect(await rejectionOf({ request: { confidential: true } })).toBe("unknown_field");
    expect(await rejectionOf({ request: { memo: "x" } })).toBe("unknown_field");
    expect(await rejectionOf({ details: { lastValidBlockHeight: 1 } })).toBe("unknown_field");
    expect(await rejectionOf({ details: { chainId: 1 } })).toBe("unknown_field");
    expect(await rejectionOf({ dropRequest: ["methodDetails"] })).toBe("unknown_field");
    expect(await rejectionOf({ request: { methodDetails: "x" } })).toBe("unknown_field");
  });

  test("3: 通貨（大文字小文字）・network の label・decimals・tokenProgram", async () => {
    expect(await rejectionOf({ request: { currency: MINT.toLowerCase() } })).toBe("asset");
    expect(await rejectionOf({ request: { currency: "So11111111111111111111111111111111111111112" } })).toBe("asset");
    expect(await rejectionOf({ details: { network: "mainnet" } })).toBe("network");
    expect(await rejectionOf({ details: { network: SOL } })).toBe("network");
    expect(await rejectionOf({ dropDetails: ["network"] })).toBe("network");
    expect(await rejectionOf({ details: { decimals: 9 } })).toBe("decimals");
    expect(await rejectionOf({ details: { decimals: "6" } })).toBe("decimals");
    expect(await rejectionOf({ dropDetails: ["decimals"] })).toBe("decimals");
    expect(await rejectionOf({ details: { tokenProgram: String(ASSOCIATED_TOKEN_PROGRAM_ADDRESS) } })).toBe("token_program");
    // tokenProgram は任意（無ければ表の値）。
    expect(await rejectionOf({ dropDetails: ["tokenProgram"] })).toBeUndefined();
  });

  test("4: amount の形・0・動的の上限", async () => {
    for (const amount of ["0", "01", "1.5", "-1", "", "1e3", " 1"]) expect(await rejectionOf({ request: { amount } }), amount).toBe("amount");
    expect(await rejectionOf({ request: { amount: 1 } })).toBe("unreadable");
    expect(await rejectionOf({ request: { amount: "10001" } }, { maxUpstreamAmount: "10000" })).toBe("amount_over_limit");
    expect(await rejectionOf({ request: { amount: "10000" } }, { maxUpstreamAmount: "10000" })).toBeUndefined();
    expect(await rejectionOf({ request: { amount: "99999999999999999999999999" } })).toBeUndefined();
  });

  test("5: recipient の形、運用者の集合、mint・tokenProgram・Router の鍵・Router の ATA・program", async () => {
    expect(await rejectionOf({ request: { recipient: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" } })).toBe("pay_to");
    expect(await rejectionOf({ request: { recipient: operator } })).toBe("pay_to");
    expect(await rejectionOf({ request: { recipient }, }, {}, [operator, recipient])).toBe("pay_to");
    for (const bad of mppSolanaReservedAddressesOf(policy)) expect(await rejectionOf({ request: { recipient: bad } }), bad).toBe("pay_to");
    // 宛先 ATA ≠ Router の ATA（ATA の検査）。
    const view = mppSolanaViewOf(await issue())!;
    expect(checkMppSolanaChallengeAtas(view, policy, policy.routerAta)).toBe("pay_to");
    expect(checkMppSolanaChallengeAtas(view, policy, await ataOf(recipient))).toBeUndefined();
  });

  test("6: pull だけ: feePayer 無し・false → mode。feePayerKey の形・除外集合（運用者、Router の鍵・ATA、recipient、宛先 ATA、mint、Token・System・ComputeBudget・Memo・ATA program）", async () => {
    expect(await rejectionOf({ dropDetails: ["feePayer"] })).toBe("mode");
    expect(await rejectionOf({ details: { feePayer: false } })).toBe("mode");
    expect(await rejectionOf({ details: { feePayer: false }, dropDetails: ["feePayerKey"] })).toBe("mode");
    expect(await rejectionOf({ details: { feePayer: "true" } })).toBe("mode");
    expect(await rejectionOf({ dropDetails: ["feePayerKey"] })).toBe("fee_payer");
    expect(await rejectionOf({ details: { feePayerKey: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" } })).toBe("fee_payer");
    expect(await rejectionOf({ details: { feePayerKey: operator } })).toBe("fee_payer");
    expect(await rejectionOf({ details: { feePayerKey: recipient } })).toBe("fee_payer");
    const reserved = mppSolanaReservedAddressesOf(policy);
    expect(reserved).toEqual([policy.routerAddress, policy.routerAta, MINT, TOKEN_PROGRAM, SYSTEM_PROGRAM_ADDRESS, "ComputeBudget111111111111111111111111111111", String(MEMO_PROGRAM_ADDRESS), String(ASSOCIATED_TOKEN_PROGRAM_ADDRESS)]);
    for (const bad of reserved) expect(await rejectionOf({ details: { feePayerKey: bad } }), bad).toBe("fee_payer");
    const view = mppSolanaViewOf(await issue({ details: { feePayerKey: await ataOf(recipient) } }))!;
    expect(checkMppSolanaChallenge(view, SCOPE, policy, [operator], Date.now())).toBeUndefined();
    expect(checkMppSolanaChallengeAtas(view, policy, await ataOf(recipient))).toBe("fee_payer");
  });

  test("7: externalId は 1..256 バイト・制御文字無し、description は string", async () => {
    expect(await rejectionOf({ request: { externalId: "" } })).toBe("memo");
    expect(await rejectionOf({ request: { externalId: "a".repeat(257) } })).toBe("memo");
    expect(await rejectionOf({ request: { externalId: "a".repeat(256) } })).toBeUndefined();
    expect(await rejectionOf({ request: { externalId: "あ".repeat(86) } })).toBe("memo"); // 258 バイト
    expect(await rejectionOf({ request: { externalId: "a\nb" } })).toBe("memo");
    expect(await rejectionOf({ request: { externalId: 1 } })).toBe("memo");
    // `description` は mppx の server が string に限るので、view の request を直接変えて検査する（Provider の wire がそうである場合）。
    const challenge = await issue();
    const withBadDescription = mppSolanaViewOf({ ...challenge, request: { ...(challenge["request"] as Record<string, unknown>), description: 1 } })!;
    expect(checkMppSolanaChallenge(withBadDescription, SCOPE, policy, [operator], Date.now())).toBe("field_type");
    expect(await rejectionOf({ request: { description: "a service" } })).toBeUndefined();
  });

  test("8: recentBlockhash があれば base58 32 バイト（読むが使わない）", async () => {
    expect(await rejectionOf({ details: { recentBlockhash: "not-base58-0OIl" } })).toBe("blockhash");
    expect(await rejectionOf({ details: { recentBlockhash: 1 } })).toBe("blockhash");
    expect(await rejectionOf({ details: { recentBlockhash: recipient } })).toBeUndefined();
  });

  test("9: expires が過去・読めない → expired。境界は「未来」だけ通す", async () => {
    expect(await rejectionOf({ expiresInMs: -1_000 })).toBe("expired");
    const view = mppSolanaViewOf(await issue())!;
    expect(checkMppSolanaChallenge(view, SCOPE, policy, [], view.expiresAt!)).toBe("expired");
    expect(checkMppSolanaChallenge(view, SCOPE, policy, [], view.expiresAt! - 1)).toBeUndefined();
    const unparsable = mppSolanaViewOf({ ...(await issue()), expires: "yesterday" })!;
    expect(Number.isNaN(unparsable.expiresAt)).toBe(true);
    expect(checkMppSolanaChallenge(unparsable, SCOPE, policy, [], Date.now())).toBe("expired");
    expect(Number.isNaN(mppSolanaViewOf({ ...(await issue()), expires: 5 })!.expiresAt)).toBe(true);
  });

  test("view が読めない形: object でない、id・realm・request が無い、scope の meta が無い、amount が string でない", async () => {
    const challenge = await issue();
    expect(mppSolanaViewOf("x")).toBeUndefined();
    expect(mppSolanaViewOf({ ...challenge, id: "" })).toBeUndefined();
    expect(mppSolanaViewOf({ ...challenge, realm: 1 })).toBeUndefined();
    expect(mppSolanaViewOf({ ...challenge, request: "x" })).toBeUndefined();
    // opaque が無い・空（scope 無し）は**読める**（pay-kit の形）: view はあり、scope だけ undefined。
    const emptyOpaque = mppSolanaViewOf({ ...challenge, opaque: "" });
    expect(emptyOpaque).toBeDefined();
    expect(emptyOpaque!.scope).toBeUndefined();
    const { opaque: _opaque, ...withoutOpaque } = challenge;
    const noOpaque = mppSolanaViewOf(withoutOpaque);
    expect(noOpaque).toBeDefined();
    expect(noOpaque!.scope).toBeUndefined();
    expect(noOpaque!.amount).toBe("10000");
    // opaque が**あって読めない**（復号できない・文字列でない）、meta の `_mppx_scope` が文字列でない（数値・null）→ 読めない（無いものとして通さない）。
    expect(mppSolanaViewOf({ ...challenge, opaque: "!!!not-a-payment-request" })).toBeUndefined();
    expect(mppSolanaViewOf({ ...challenge, opaque: 5 })).toBeUndefined();
    expect(mppSolanaViewOf({ ...challenge, opaque: PaymentRequest.serialize({ _mppx_scope: 5 } as never) })).toBeUndefined();
    expect(mppSolanaViewOf({ ...challenge, opaque: PaymentRequest.serialize({ _mppx_scope: null } as never) })).toBeUndefined();
    // meta はあるが scope の鍵が無い → scope 無しとして**読める**（meta は terms に入る）。
    const metaWithoutScope = mppSolanaViewOf({ ...challenge, opaque: PaymentRequest.serialize({ other: "x" } as never) });
    expect(metaWithoutScope).toBeDefined();
    expect(metaWithoutScope!.scope).toBeUndefined();
    expect(metaWithoutScope!.terms).toContain("\"other\":\"x\"");
    // wire を通した形でも同じ（`Challenge.serialize` → `deserialize` は opaque をそのまま運ぶ）: 数値・null の scope、復号できない opaque は読めない。
    const roundTripped = (value: unknown): Record<string, unknown> => Challenge.deserialize(Challenge.serialize(value as never)) as unknown as Record<string, unknown>;
    expect(mppSolanaViewOf(roundTripped({ ...challenge, opaque: PaymentRequest.serialize({ _mppx_scope: 5 } as never) }))).toBeUndefined();
    expect(mppSolanaViewOf(roundTripped({ ...challenge, opaque: PaymentRequest.serialize({ _mppx_scope: null } as never) }))).toBeUndefined();
    expect(mppSolanaViewOf(roundTripped({ ...challenge, opaque: "!!!not-a-payment-request" }))).toBeUndefined();
    // 同じ wire で、正しい scope ならもちろん読める（round trip 自体が view を壊していない証拠）。
    expect(mppSolanaViewOf(roundTripped(challenge))!.scope).toBe(SCOPE);
    expect(mppSolanaViewOf({ ...challenge, request: { ...(challenge["request"] as object), amount: 1 } })).toBeUndefined();
  });
});

describe("MPP Solana 送信: terms・offer・client 側の method", () => {
  test("同じ request で id・expires が違う 2 つの challenge は terms も offerOf も一致。offer は solana/charge・表の network・feePayerKey・decimals・tokenProgram・externalId（あれば）", async () => {
    const a = mppSolanaViewOf(await issue({ request: { externalId: "order-7" } }))!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = mppSolanaViewOf(await issue({ request: { externalId: "order-7" }, expiresInMs: 90_000 }))!;
    expect(a.id).not.toBe(b.id);
    expect(a.expiresAt).not.toBe(b.expiresAt);
    expect(a.terms).toBe(b.terms);
    const offer = mppSolanaOfferOf(a, policy);
    expect(mppSolanaOfferOf(b, policy)).toEqual(offer);
    expect(offer).toEqual({ scheme: MPP_SOLANA_SCHEME, network: SOL, asset: MINT, amount: "10000", payTo: recipient, extra: { realm: "provider-test", scope: SCOPE, terms: a.terms, feePayerKey, decimals: 6, tokenProgram: TOKEN_PROGRAM, externalId: "order-7" } });
    expect(mppSolanaOfferTermsOf(offer)).toBe(a.terms);
    expect(mppSolanaOfferTermsOf({ ...offer, extra: {} })).toBeUndefined();
    // externalId の無い challenge の offer には externalId が無い。
    expect(mppSolanaOfferOf(mppSolanaViewOf(await issue())!, policy).extra).not.toHaveProperty("externalId");
    // 1 欄だけ変えた challenge（他は a と同じ）の terms は違う: 額、受取人、feePayerKey、externalId。
    const otherKey = String((await generateKeyPairSigner()).address);
    expect(mppSolanaViewOf(await issue({ request: { externalId: "order-7", amount: "10001" } }))!.terms).not.toBe(a.terms);
    expect(mppSolanaViewOf(await issue({ request: { externalId: "order-7", recipient: otherKey } }))!.terms).not.toBe(a.terms);
    expect(mppSolanaViewOf(await issue({ request: { externalId: "order-7" }, details: { feePayerKey: otherKey } }))!.terms).not.toBe(a.terms);
    expect(mppSolanaViewOf(await issue({ request: { externalId: "order-8" } }))!.terms).not.toBe(a.terms);
    // scope は terms に入る（meta 経由）: 同じ request で scope だけ違う・無い challenge の terms は違う。
    const sameRequest = mppSolanaViewOf(await issue({ request: { externalId: "order-7" }, scope: "GET https://provider.test/v1/other" }))!;
    expect(sameRequest.terms).not.toBe(a.terms);
    expect(mppSolanaViewOf(await issue({ request: { externalId: "order-7" }, scope: null }))!.terms).not.toBe(a.terms);
  });

  test("client 側の method: 0.11.0 の client の preparePayment が選んだ challenge は wire と同じ（未知の鍵も残る = 検査が見える）。hook は選んだ challenge を受け取り、返した文字列がそのまま credential", async () => {
    const challenge = await issue({ request: { splits: [{ recipient, amount: "1" }] } });
    const seen: unknown[] = [];
    const client = ClientMppx.create({ methods: [mppSolanaClientMethodOf(async ({ challenge: picked }) => { seen.push(picked); return "the-credential"; })], polyfill: false, maxPaymentRetries: 0 } as never) as unknown as { preparePayment: (response: Response, options: { request: RequestInit }) => Promise<{ challenge: unknown; createCredential: () => Promise<string> }> };
    const response = new Response("{}", { status: 402, headers: { "www-authenticate": Challenge.serialize(challenge as never) } });
    const prepared = await client.preparePayment(response, { request: { method: "GET" } });
    const view = mppSolanaViewOf(prepared.challenge)!;
    expect(view.id).toBe(challenge["id"]);
    expect(view.terms).toBe(mppSolanaViewOf(challenge)!.terms);
    expect(checkMppSolanaChallenge(view, SCOPE, policy, [operator], Date.now())).toBe("unknown_field");
    expect(await prepared.createCredential()).toBe("the-credential");
    expect(seen).toHaveLength(1);
    expect(mppSolanaViewOf(seen[0])!.id).toBe(challenge["id"]);
  });
});
