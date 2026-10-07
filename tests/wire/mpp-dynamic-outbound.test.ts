/**
 * MPP 送信（Tempo charge）の動的経路（設計 `docs/dynamic-upstream-design.md` §3.2〜§3.4、タスク T9。AC-6・AC-14・AC-15・AC-16 の adapter 部分）。
 *
 * 実 TCP / TLS（loopback の fixture）。上流は**実 `mppx/server`** が challenge を発行して credential を検証し、送金の receipt は
 * Tempo RPC の fixture（raw を復号し、送り主を署名から復元する）から読む。鍵は毎回の乱数。資金は動かない。
 *
 * 署名の境界の試験は 2 段:
 *   1. facade そのもの（`createGuardedTempoAccount`）に、SDK が渡す形の transaction を 1 欄ずつ変えて渡す
 *   2. adapter を通して、**SDK（`mppx/client` の `tempo.charge`）が受け取る account を包んで** transaction を書き換える
 *      （下の `vi.mock`。書き換えを指定しなければ SDK は実物のまま）
 */
import { PaymentRequest } from "mppx";
import { TxEnvelopeTempo } from "ox/tempo";
import { createClient, custom, decodeFunctionData, encodeFunctionData, http, keccak256, maxUint256, serializeTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction as TempoTransaction } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

type Tx = Record<string, unknown>;
interface FacadeLike {
  address: Hex;
  type: "local";
  signTransaction(transaction: unknown, options?: unknown): Promise<Hex>;
}

const sdk = vi.hoisted(() => ({
  /** SDK が受け取る account を包む。 */
  wrapAccount: undefined as undefined | ((facade: never, clients: unknown[]) => unknown),
  /** SDK が受け取る client を包む。 */
  wrapClient: undefined as undefined | ((client: never) => unknown),
  /** adapter が SDK に渡した account と client。 */
  accounts: [] as unknown[],
  clients: [] as unknown[],
}));

vi.mock("mppx/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mppx/client")>();
  return {
    ...actual,
    tempo: {
      ...actual.tempo,
      charge: (parameters: { account: unknown; getClient: (p: unknown) => unknown }) => {
        sdk.accounts.push(parameters.account);
        const getClient = async (p: unknown): Promise<unknown> => {
          const client = await parameters.getClient(p);
          sdk.clients.push(client);
          return sdk.wrapClient === undefined ? client : sdk.wrapClient(client as never);
        };
        const account = sdk.wrapAccount === undefined ? parameters.account : sdk.wrapAccount(parameters.account as never, sdk.clients);
        return actual.tempo.charge({ ...parameters, account, getClient } as never);
      },
    },
  };
});

import { createMppOutbound } from "../../src/adapters/outbound/mpp.js";
import { approvedTransferOf, assertDynamicMppCapability, checkDynamicMppChallenge, checkRawTempoTransfer, createGuardedTempoAccount, feePerGasOf, ROUTER_PRIORITY_FEE_PER_GAS, TempoSigningRefusedError } from "../../src/adapters/outbound/mpp-dynamic.js";
import type { DynamicProfile } from "../../src/config.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, MppTempoCapability, OutboundRail } from "../../src/ports/outbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { MPP_FIXTURE_CHAIN_ID, MPP_FIXTURE_CURRENCY, MPP_FIXTURE_RECIPIENT, startMppUpstream, type MppUpstream } from "../fixtures/dynamic/mpp-upstream.js";
import { startTempoRpc, type TempoRpc } from "../fixtures/dynamic/tempo-rpc.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const PROFILE_ID = "dyn-x402-to-mpp";
const OPERATOR_PAY_TO = "0x00000000000000000000000000000000000000b0";
const OTHER = "0x0000000000000000000000000000000000000bad" as Hex;
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, payTo: OPERATOR_PAY_TO },
  rail: "mpp",
  destination: { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, decimals: 6, feeAsset: MPP_FIXTURE_CURRENCY, maxFee: "5000" },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 0, min: "1000" },
};
const URL_A = "https://provider.test/v1/price?symbol=ETH";
/** 署名の境界に渡す baseFee（fixture の RPC と同じ 6e8）。Router の単価は feePerGasOf(6e8) = 1,440,000,001。 */
const BASE_FEE = 600_000_000n;
const OFFER: DestinationOffer = { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, amount: "1000", payTo: MPP_FIXTURE_RECIPIENT };
const MEMO = `0x${"ab".repeat(32)}` as Hex;

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => {
  TLS.cleanup();
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  sdk.wrapAccount = undefined;
  sdk.wrapClient = undefined;
  sdk.accounts.length = 0;
  sdk.clients.length = 0;
  // 1 つが失敗しても残りを片付ける。
  const failures: unknown[] = [];
  while (closers.length > 0) {
    try {
      await closers.pop()!();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

/* ------------------------------------------------------------------ challenge の検査（純粋関数） */

describe("challenge の検査（設計 §3.3 (i)）", () => {
  const SIGNER = "0x00000000000000000000000000000000000000c0";
  const NOW = 1_800_000_000_000;
  const base = (): Record<string, unknown> => ({
    id: "challenge-1",
    realm: "provider",
    method: "tempo",
    intent: "charge",
    request: { amount: "1000", currency: MPP_FIXTURE_CURRENCY, recipient: MPP_FIXTURE_RECIPIENT, methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID } },
    expires: new Date(NOW + 60_000).toISOString(),
  });
  const withRequest = (patch: Record<string, unknown>) => ({ ...base(), request: { ...(base()["request"] as object), ...patch } });
  const withDetails = (patch: Record<string, unknown>) => withRequest({ methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID, ...patch } });
  const withoutRequestKey = (key: string) => {
    const request = { ...(base()["request"] as Record<string, unknown>) };
    delete request[key];
    return { ...base(), request };
  };
  const check = (challenge: unknown) => checkDynamicMppChallenge(challenge, PROFILE, [SIGNER, OPERATOR_PAY_TO], URL_A, NOW);

  test.each([
    ["必須の欄だけ", base()],
    ["expires なし", (() => { const c = base(); delete c["expires"]; return c; })()],
    ["description・digest", { ...base(), description: "ETH price", digest: "sha-256=abc" }],
    ["request.description", withRequest({ description: "one call" })],
    ["supportedModes に push を含む", withDetails({ supportedModes: ["pull", "push"] })],
    ["feePayer の申し出（使わない）", withDetails({ feePayer: true })],
    ["opaque があり scope のキーは無い", { ...base(), opaque: PaymentRequest.serialize({ tier: "basic" }) }],
    ["opaque の scope がこの URL", { ...base(), opaque: PaymentRequest.serialize({ _mppx_scope: `GET ${URL_A}` }) }],
    ["currency の大文字小文字が違う", withRequest({ currency: MPP_FIXTURE_CURRENCY.toUpperCase().replace("0X", "0x") })],
    ["amount が上限ちょうど", withRequest({ amount: "100000" })],
  ])("通る: %s", (_name, challenge) => {
    expect(check(challenge)).toMatchObject({ ok: true });
  });

  test("offer は条件の全文を持ち、id・expires は含まない", () => {
    const first = check(base());
    const second = check({ ...base(), id: "challenge-2", expires: new Date(NOW + 120_000).toISOString() });
    expect(first.ok && second.ok && first.offer).toEqual(second.ok && second.offer);
    expect(first.ok && first.offer).toMatchObject({ scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, amount: "1000", payTo: MPP_FIXTURE_RECIPIENT, extra: { realm: "provider" } });
    const withOpaque = check({ ...base(), opaque: PaymentRequest.serialize({ tier: "basic" }) });
    expect(withOpaque.ok && withOpaque.offer).not.toEqual(first.ok && first.offer);
  });

  test.each([
    ["object でない", "Payment id=1", "not_an_object"],
    ["header（credential の送り先を変える）", { ...base(), header: "X-Payment" }, "unknown_field"],
    ["未知の challenge の欄", { ...base(), meta: { a: "b" } }, "unknown_field"],
    ["method が tempo でない", { ...base(), method: "evm" }, "method"],
    ["intent が charge でない", { ...base(), intent: "session" }, "method"],
    ["request.externalId", withRequest({ externalId: "order-1" }), "unknown_field"],
    ["request.expires", withRequest({ expires: "2030-01-01T00:00:00Z" }), "unknown_field"],
    ["request.extra", withRequest({ extra: {} }), "unknown_field"],
    ["request.description が文字列でない", withRequest({ description: 1 }), "unknown_field"],
    ["recipient が無い", withoutRequestKey("recipient"), "missing_field"],
    ["methodDetails が無い", withoutRequestKey("methodDetails"), "missing_field"],
    ["methodDetails.splits", withDetails({ splits: [{ recipient: OTHER, amount: "1" }] }), "method_details"],
    ["methodDetails.machineTokenEnabled", withDetails({ machineTokenEnabled: true }), "method_details"],
    ["methodDetails.memo", withDetails({ memo: MEMO }), "method_details"],
    ["chainId がプロファイルと違う", withRequest({ methodDetails: { chainId: 4217 } }), "chain"],
    ["supportedModes が pull だけ", withDetails({ supportedModes: ["pull"] }), "pull_only"],
    ["supportedModes が配列でない", withDetails({ supportedModes: "push" }), "method_details"],
    ["feePayer が真偽値でない", withDetails({ feePayer: OTHER }), "method_details"],
    ["currency がプロファイルと違う", withRequest({ currency: OTHER }), "currency"],
    ["amount が 0（proof の署名になる）", withRequest({ amount: "0" }), "amount"],
    ["amount に先頭ゼロ", withRequest({ amount: "01000" }), "amount"],
    ["amount が数値", withRequest({ amount: 1000 }), "amount"],
    ["amount が上限超過", withRequest({ amount: "100001" }), "amount_over_limit"],
    ["recipient がゼロアドレス", withRequest({ recipient: "0x0000000000000000000000000000000000000000" }), "recipient"],
    ["recipient が token コントラクト", withRequest({ recipient: MPP_FIXTURE_CURRENCY }), "recipient"],
    ["recipient が支払い元自身", withRequest({ recipient: SIGNER }), "recipient"],
    ["recipient が受信の受取先", withRequest({ recipient: OPERATOR_PAY_TO }), "recipient"],
    ["recipient がアドレスでない", withRequest({ recipient: "provider.tempo" }), "recipient"],
    ["期限切れ", { ...base(), expires: new Date(NOW - 1).toISOString() }, "expired"],
    ["expires が日時でない", { ...base(), expires: "soon" }, "expired"],
    ["opaque が復号できない", { ...base(), opaque: "!!!not-base64!!!" }, "opaque_undecodable"],
    ["opaque が object でない", { ...base(), opaque: Buffer.from("[1]").toString("base64url") }, "opaque_undecodable"],
    ["scope が別の URL", { ...base(), opaque: PaymentRequest.serialize({ _mppx_scope: "GET https://provider.test/v1/other" }) }, "scope"],
    ["scope がクエリ違い", { ...base(), opaque: PaymentRequest.serialize({ _mppx_scope: "GET https://provider.test/v1/price" }) }, "scope"],
    ["scope が文字列でない", { ...base(), opaque: Buffer.from(JSON.stringify({ _mppx_scope: 5 })).toString("base64url") }, "scope"],
  ])("候補にしない: %s", (_name, challenge, reason) => {
    expect(check(challenge)).toEqual({ ok: false, reason });
  });
});

/* ------------------------------------------------------------------ 署名の境界（facade そのもの） */

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const transferData = (recipient: Hex = MPP_FIXTURE_RECIPIENT, amount = 1000n): Hex => encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [recipient, amount, MEMO] });

/** SDK が `signTransaction` に渡す形（T0-a の実測）。 */
function sdkTx(from: string, patch: Tx = {}): Tx {
  return {
    account: { address: from, type: "local" },
    chain: { id: MPP_FIXTURE_CHAIN_ID },
    nonceManager: undefined,
    calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData(), abi: Abis.tip20, functionName: "transferWithMemo", args: [MPP_FIXTURE_RECIPIENT, 1000n, MEMO], address: MPP_FIXTURE_CURRENCY }],
    chainId: MPP_FIXTURE_CHAIN_ID,
    from,
    gas: 54_290n,
    maxFeePerGas: 1_440_000_001n,
    maxPriorityFeePerGas: 1n,
    nonce: 0,
    nonceKey: maxUint256,
    validBefore: NOW_S + 25,
    type: "tempo",
    feeToken: MPP_FIXTURE_CURRENCY,
    accessList: undefined,
    authorizationList: undefined,
    blobs: undefined,
    data: undefined,
    gasPrice: undefined,
    maxFeePerBlobGas: undefined,
    to: undefined,
    value: undefined,
    ...patch,
  };
}

function facadeHarness(options: { maxFee?: bigint; baseFee?: bigint } = {}) {
  const real = privateKeyToAccount(generatePrivateKey());
  const inner: { tx: Tx; options: { serializer?: unknown } | undefined }[] = [];
  const account = {
    ...real,
    signTransaction: async (tx: unknown, options?: unknown) => {
      inner.push({ tx: tx as Tx, options: options as { serializer?: unknown } | undefined });
      return real.signTransaction(tx as never, options as never);
    },
  };
  const guard = createGuardedTempoAccount({ account: account as never, profile: PROFILE, offer: OFFER, maxFee: options.maxFee ?? 5000n, baseFee: options.baseFee ?? BASE_FEE, now: () => NOW });
  return { real, inner, guard, tx: (patch: Tx = {}) => sdkTx(real.address, patch) };
}

/** 署名した raw の手数料の欄。 */
function feesOf(raw: Hex): { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const e = TxEnvelopeTempo.deserialize(raw as never) as unknown as { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  return { gas: e.gas, maxFeePerGas: e.maxFeePerGas, maxPriorityFeePerGas: e.maxPriorityFeePerGas };
}

describe("署名の境界（設計 §3.3 (ii)、AC-16）", () => {
  const call = (patch: Tx) => ({ calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData(), ...patch }] });

  test("正しい transaction は、確かめた欄だけで組み直して 1 回だけ署名する", async () => {
    const h = facadeHarness();
    const evil = vi.fn(() => "0xdeadbeef");
    const raw = await h.guard.account.signTransaction(h.tx(), { serializer: evil });
    // 渡された serializer は使われず、Router が選んだ Tempo の serializer が元の account に渡る。
    expect(evil).not.toHaveBeenCalled();
    expect(h.inner).toHaveLength(1);
    expect(h.inner[0]!.options?.serializer).toBe(TempoTransaction.serialize);
    // 元の account に渡ったのは組み直したもの: SDK が call に付ける欄も、account・chain も無い。
    expect(Object.keys(h.inner[0]!.tx).sort()).toEqual(["calls", "chainId", "feeToken", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "nonceKey", "type", "validBefore"]);
    expect(h.inner[0]!.tx["calls"]).toEqual([{ to: MPP_FIXTURE_CURRENCY, data: transferData(), value: 0n }]);
    const envelope = TxEnvelopeTempo.deserialize(raw as never) as unknown as Tx;
    expect(envelope).toMatchObject({ type: "tempo", chainId: MPP_FIXTURE_CHAIN_ID, feeToken: MPP_FIXTURE_CURRENCY, gas: 54_290n, maxFeePerGas: 1_440_000_001n, nonceKey: maxUint256, validBefore: NOW_S + 25 });
    expect(envelope["calls"]).toEqual([{ to: MPP_FIXTURE_CURRENCY, data: transferData() }]);
    expect(String(envelope["from"]).toLowerCase()).toBe(h.real.address.toLowerCase());
    expect(h.guard.signedRaw()).toBe(raw);
    expect(h.guard.signatures()).toBe(1);
    // 2 回目は通さない。
    await expect(h.guard.account.signTransaction(h.tx())).rejects.toMatchObject({ reason: "destination_second_signature_refused" });
    expect(h.inner).toHaveLength(1);
  });

  test("SDK に見せる account は address・type・signTransaction だけ。生の署名口は無い", () => {
    const h = facadeHarness();
    const facade = h.guard.account as unknown as Record<string, unknown>;
    expect(Object.keys(facade).sort()).toEqual(["address", "signTransaction", "type"]);
    for (const name of ["sign", "signMessage", "signTypedData", "signAuthorization", "source", "keyType", "nonceManager", "publicKey"]) {
      expect(facade[name]).toBeUndefined();
    }
    expect(facade["type"]).toBe("local");
  });

  test.each([
    ["type が eip1559（見積りに落ちた経路）", { type: "eip1559" }],
    ["transfer（memo なし）", call({ data: encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [MPP_FIXTURE_RECIPIENT, 1000n] }) })],
    ["call.value が 0n", call({ value: 0n })],
    ["from が無い", { from: undefined }],
    ["nonce が 0n", { nonce: 0n }],
    // SDK の提案の単価は写さない（設計 §8.2）: 提案が大きくても、無くても、Router の単価で署名する。
    ["SDK の提案の単価が 1e15", { gas: 50_000n, maxFeePerGas: 10n ** 15n, maxPriorityFeePerGas: 10n ** 15n }],
    ["SDK の提案に手数料の欄が無い", { maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }],
    ["validBefore が now+60 秒ちょうど", { validBefore: NOW_S + 60 }],
  ])("署名する: %s", async (_name, patch) => {
    const h = facadeHarness();
    const raw = await h.guard.account.signTransaction(h.tx(patch as Tx));
    expect(h.inner).toHaveLength(1);
    expect((TxEnvelopeTempo.deserialize(raw as never) as unknown as Tx)["type"]).toBe("tempo");
  });

  test.each([
    ["call が 2 つ", { calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData() }, { to: MPP_FIXTURE_CURRENCY, data: transferData() }] }],
    ["call が 0 個", { calls: [] }],
    ["calls が無い", { calls: undefined }],
    ["call の宛先が別のコントラクト", call({ to: OTHER })],
    ["call.value が 1", call({ value: 1n })],
    ["別の受取先への送金", call({ data: transferData(OTHER) })],
    ["額が 100 倍", call({ data: transferData(MPP_FIXTURE_RECIPIENT, 100_000n) })],
    ["送金でない関数（approve）", call({ data: encodeFunctionData({ abi: Abis.tip20, functionName: "approve", args: [OTHER, 1000n] }) })],
    ["data の末尾に余分なバイト", call({ data: `${transferData()}${"00".repeat(32)}` })],
    ["data が hex でない", call({ data: "transfer" })],
    ["data が無い", call({ data: undefined })],
    ["chainId が違う", { chainId: 4217 }],
    ["from が別人", { from: OTHER }],
    ["feeToken が未指定", { feeToken: undefined }],
    ["feeToken が別の資産", { feeToken: OTHER }],
    ["gas が 0", { gas: 0n }],
    ["gas が数値", { gas: 54_290 }],
    ["nonceKey が expiring でない", { nonceKey: 0n }],
    ["nonce が 1", { nonce: 1 }],
    ["validBefore が now+61 秒", { validBefore: NOW_S + 61 }],
    ["validBefore が現在", { validBefore: NOW_S }],
    ["validBefore が小数", { validBefore: NOW_S + 10.5 }],
    ["validBefore が bigint", { validBefore: BigInt(NOW_S + 10) }],
    ["validBefore が未指定", { validBefore: undefined }],
    ["type が legacy", { type: "legacy" }],
    ["type が未指定", { type: undefined }],
    ["feePayer: true", { feePayer: true }],
    ["feePayer: false", { feePayer: false }],
    ["feePayerSignature", { feePayerSignature: { r: 1n, s: 1n, yParity: 0 } }],
    ["keyAuthorization", { keyAuthorization: { address: OTHER } }],
    ["authorizationList（空）", { authorizationList: [] }],
    ["accessList（空）", { accessList: [] }],
    ["validAfter", { validAfter: NOW_S - 10 }],
    ["トップレベルの to", { to: OTHER }],
    ["トップレベルの data", { data: "0x00" }],
    ["トップレベルの value", { value: 0n }],
    ["未知の欄", { somethingNew: 1 }],
  ])("%s なら元の account を呼ばない", async (_name, patch) => {
    const h = facadeHarness();
    await expect(h.guard.account.signTransaction(h.tx(patch as Tx))).rejects.toBeInstanceOf(TempoSigningRefusedError);
    expect(h.inner).toHaveLength(0);
    expect(h.guard.signedRaw()).toBeUndefined();
    // 拒否でも「1 回」は使い切る。
    await expect(h.guard.account.signTransaction(h.tx())).rejects.toMatchObject({ reason: "destination_second_signature_refused" });
    expect(h.inner).toHaveLength(0);
  });

  test("local account でなければ作れない", () => {
    expect(() => createGuardedTempoAccount({ account: { address: OTHER, type: "json-rpc" } as never, profile: PROFILE, offer: OFFER, maxFee: 5000n, baseFee: BASE_FEE, now: () => NOW })).toThrow("local account");
  });
});

/* ------------------------------------------------------------------ 単価は Router が決める（docs/dynamic-gas-fee-design.md §8.2） */

describe("署名の境界: 単価は Router が決める（priority 1、maxFeePerGas = min(feePerGasOf(baseFee), capPerGas)）", () => {
  const GAS = 54_290n;
  const capPerGasOf = (cap: bigint) => (cap * 10n ** 12n) / GAS;

  test("feePerGasOf = ceil(2.4 × baseFee) + 1", () => {
    expect(feePerGasOf(600_000_000n)).toBe(1_440_000_001n);
    expect(feePerGasOf(1n)).toBe(4n);
    expect(feePerGasOf(10n)).toBe(25n);
    expect(ROUTER_PRIORITY_FEE_PER_GAS).toBe(1n);
  });

  test("SDK が priority 9.6e9・maxFee 1.3e10 を提案しても、署名するのは Router の単価", async () => {
    const h = facadeHarness();
    const raw = await h.guard.account.signTransaction(h.tx({ maxFeePerGas: 12_990_000_000n, maxPriorityFeePerGas: 9_625_000_000n }));
    expect(feesOf(raw)).toEqual({ gas: GAS, maxFeePerGas: feePerGasOf(BASE_FEE), maxPriorityFeePerGas: 1n });
    // 元の account に渡した transaction も同じ値（SDK の提案は写っていない）。
    expect(h.inner[0]!.tx).toMatchObject({ maxFeePerGas: feePerGasOf(BASE_FEE), maxPriorityFeePerGas: 1n });
  });

  test("baseFee が上がれば単価も上がる（cap の内側）", async () => {
    const h = facadeHarness({ baseFee: 1_200_000_000n });
    const raw = await h.guard.account.signTransaction(h.tx());
    expect(feesOf(raw).maxFeePerGas).toBe(feePerGasOf(1_200_000_000n));
  });

  test("feePerGasOf(baseFee) が capPerGas を超えれば capPerGas に clamp する（bound は cap ちょうど以下）", async () => {
    // cap 60: capPerGas = floor(60e12 / 54290) = 1,105,174,434 < feePerGasOf(6e8) = 1,440,000,001、かつ ≥ baseFee。
    const h = facadeHarness({ maxFee: 60n });
    const raw = await h.guard.account.signTransaction(h.tx());
    const fees = feesOf(raw);
    expect(fees.maxFeePerGas).toBe(capPerGasOf(60n));
    expect(boundOf(fees.gas, fees.maxFeePerGas)).toBeLessThanOrEqual(60n);
    expect(fees.maxPriorityFeePerGas).toBe(1n);
  });

  test("capPerGas が baseFee 未満なら署名しない（取り込まれない transaction に署名しない）", async () => {
    // cap 32: capPerGas = 589,427,150 < baseFee 6e8。
    const h = facadeHarness({ maxFee: 32n });
    await expect(h.guard.account.signTransaction(h.tx())).rejects.toMatchObject({ reason: "destination_signing_fee_over_limit" });
    expect(h.inner).toHaveLength(0);
    // cap 33: capPerGas = 607,846,748 ≥ baseFee → 署名する（bound 33）。
    const ok = facadeHarness({ maxFee: 33n });
    const raw = await ok.guard.account.signTransaction(ok.tx());
    expect(boundOf(feesOf(raw).gas, feesOf(raw).maxFeePerGas)).toBe(33n);
  });

  test("gas が無い・0 なら単価を決めずに拒否する", async () => {
    const a = facadeHarness();
    await expect(a.guard.account.signTransaction(a.tx({ gas: undefined }))).rejects.toBeInstanceOf(TempoSigningRefusedError);
    expect(a.inner).toHaveLength(0);
    const b = facadeHarness();
    await expect(b.guard.account.signTransaction(b.tx({ gas: 0n }))).rejects.toMatchObject({ reason: "destination_signing_fee_out_of_range" });
    expect(b.inner).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ 送信の境界（raw の検査） */

describe("送信の境界（設計 §3.3 (iii)）", () => {
  const signRaw = async (patch: Tx = {}, key = generatePrivateKey()) => {
    const account = privateKeyToAccount(key);
    const tx = { type: "tempo", chainId: MPP_FIXTURE_CHAIN_ID, calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData(), value: 0n }], gas: 54_290n, maxFeePerGas: 1_440_000_001n, maxPriorityFeePerGas: 1n, nonce: 0, nonceKey: maxUint256, validBefore: NOW_S + 25, feeToken: MPP_FIXTURE_CURRENCY, ...patch };
    return { raw: await account.signTransaction(tx as never, { serializer: TempoTransaction.serialize as never }), sender: account.address };
  };
  const check = (raw: unknown, sender: string) => checkRawTempoTransfer(raw, approvedTransferOf(PROFILE, OFFER, sender, 5000n), NOW);

  test("priority が Router の値（1）でない raw は送らない", async () => {
    const { raw, sender } = await signRaw({ maxPriorityFeePerGas: 2n });
    expect(() => check(raw, sender)).toThrow(TempoSigningRefusedError);
  });

  test("承認済みの送金の raw は通る", async () => {
    const { raw, sender } = await signRaw();
    expect(() => check(raw, sender)).not.toThrow();
  });

  test.each([
    ["別の受取先", { calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData(OTHER), value: 0n }] }],
    ["額違い", { calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData(MPP_FIXTURE_RECIPIENT, 1001n), value: 0n }] }],
    ["call が 2 つ", { calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData(), value: 0n }, { to: MPP_FIXTURE_CURRENCY, data: transferData(OTHER), value: 0n }] }],
    ["別のコントラクト宛て", { calls: [{ to: OTHER, data: transferData(), value: 0n }] }],
    ["value つき", { calls: [{ to: MPP_FIXTURE_CURRENCY, data: transferData(), value: 1n }] }],
    ["feeToken なし", { feeToken: undefined }],
    ["feeToken が別の資産", { feeToken: OTHER }],
    ["手数料の上限超過", { gas: 50_000n, maxFeePerGas: 100_000_000_001n }],
    ["chainId 違い", { chainId: 4217 }],
    ["有効期限が長すぎる", { validBefore: NOW_S + 3600 }],
    ["expiring nonce でない", { nonceKey: 1n }],
    ["accessList つき", { accessList: [{ address: OTHER, storageKeys: [] }] }],
    ["validAfter つき", { validAfter: NOW_S - 100 }],
  ])("%s の raw は送らない", async (_name, patch) => {
    const { raw, sender } = await signRaw(patch as Tx);
    expect(() => check(raw, sender)).toThrow(TempoSigningRefusedError);
  });

  test("別の鍵が署名した raw・Tempo でない raw・hex でないものは送らない", async () => {
    const { raw } = await signRaw();
    expect(() => check(raw, OTHER)).toThrow(TempoSigningRefusedError);
    const legacy = await privateKeyToAccount(generatePrivateKey()).signTransaction({ type: "eip1559", chainId: MPP_FIXTURE_CHAIN_ID, to: MPP_FIXTURE_CURRENCY, data: transferData(), gas: 54_290n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 }, { serializer: serializeTransaction });
    expect(() => check(legacy, OTHER)).toThrow(TempoSigningRefusedError);
    expect(() => check("not-a-transaction", OTHER)).toThrow(TempoSigningRefusedError);
    expect(() => check(undefined, OTHER)).toThrow(TempoSigningRefusedError);
  });
});

/* ------------------------------------------------------------------ adapter を通す */

interface Harness {
  readonly upstream: MppUpstream;
  readonly rpc: TempoRpc;
  readonly rail: OutboundRail;
  readonly address: Hex;
  /** 元の account（実鍵）が受け取った transaction。 */
  readonly innerSigned: Tx[];
  readonly gate: { admitted: number; released: number; refuseAt: number | undefined };
  quote(): Promise<DestinationOffer>;
  pay(offer: DestinationOffer, url?: string, maxFee?: string | null): ReturnType<OutboundRail["pay"]>;
  estimate(offer: DestinationOffer): ReturnType<NonNullable<OutboundRail["estimateFee"]>>;
  sends(): number;
}

async function harness(
  options: {
    paidTimeoutMs?: number;
    rpcTimeoutMs?: number;
    stallDnsFor?: string;
    rpcBudgetMs?: number;
    rpcRetryCount?: number;
    offerFeePayer?: boolean;
    profile?: DynamicProfile;
    capability?: Partial<MppTempoCapability>;
    estimateRpcTimeoutMs?: number;
    estimateRpcBudgetMs?: number;
    /** 門: この番号（1 始まり）以降の admit を断る。 */
    refuseAdmitAt?: number;
    now?: () => number;
    operatorAddresses?: readonly string[];
  } = {},
): Promise<Harness> {
  const rpc = await startTempoRpc({ tls: TLS });
  closers.push(rpc.close);
  const upstream = await startMppUpstream(TLS, rpc.plainUrl, "provider.test", { offerFeePayer: options.offerFeePayer === true });
  closers.push(upstream.close);
  const real = privateKeyToAccount(generatePrivateKey());
  const innerSigned: Tx[] = [];
  const account = {
    ...real,
    signTransaction: async (tx: unknown, opts?: unknown) => {
      innerSigned.push(tx as Tx);
      return real.signTransaction(tx as never, opts as never);
    },
  };
  const gate = { admitted: 0, released: 0, refuseAt: options.refuseAdmitAt };
  const transport = createGuardedTransport({
    allowLoopback: false,
    report: () => {},
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (hostname, lookupOptions, callback) => {
      // 指定したホスト名だけ、名前解決が返ってこない。
      if (hostname !== options.stallDnsFor) publicLookup()(hostname, lookupOptions, callback);
    },
    dialForTest: dialTo({ "provider.test": upstream.port, "other.test": rpc.port }),
    maxHeaderSize: DYNAMIC_RESPONSE_LIMITS.maxHeaderBytes,
    dns: { timeoutMs: 2_000, maxInFlight: 16 },
    admit: () => {
      gate.admitted += 1;
      // この番号以降の admit を断る（1 回だけ断っても viem は見積りの別経路に落ちるので、以降すべて）。
      if (gate.refuseAt !== undefined && gate.admitted >= gate.refuseAt) return undefined;
      return { release: () => { gate.released += 1; } };
    },
  });
  const client = createClient({ chain: tempoModerato, transport: http(rpc.url, { retryCount: options.rpcRetryCount ?? 0 }) });
  const rail = createMppOutbound({
    upstreams: {},
    transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
    capability: { chainId: MPP_FIXTURE_CHAIN_ID, account: account as never, getClient: () => client, mode: "push", kind: "real-key", ...options.capability },
    dynamic: {
      profiles: { [PROFILE_ID]: options.profile ?? PROFILE },
      transport,
      ...(options.paidTimeoutMs === undefined ? {} : { paidTimeoutMs: options.paidTimeoutMs }),
      ...(options.rpcBudgetMs === undefined ? {} : { rpcBudgetMs: options.rpcBudgetMs }),
      ...(options.rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs: options.rpcTimeoutMs }),
      ...(options.estimateRpcTimeoutMs === undefined ? {} : { estimateRpcTimeoutMs: options.estimateRpcTimeoutMs }),
      ...(options.estimateRpcBudgetMs === undefined ? {} : { estimateRpcBudgetMs: options.estimateRpcBudgetMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.operatorAddresses === undefined ? {} : { operatorAddresses: options.operatorAddresses }),
    },
  });
  return {
    upstream,
    rpc,
    rail,
    address: real.address,
    innerSigned,
    gate,
    quote: async () => (await rail.readChallenge(PROFILE_ID, { url: URL_A }))[0]!,
    // `maxFee`: 既定は 5,000（天井と同じ）。`null` で欄ごと無し。
    pay: (offer, url = URL_A, maxFee: string | null = "5000") => rail.pay({ routeId: PROFILE_ID, offer, paymentId: "p1", attempt: 1, deadlineMs: Date.now() + 600_000, target: { url }, ...(maxFee === null ? {} : { maxFee }) }),
    estimate: (offer) => rail.estimateFee!(PROFILE_ID, offer, { url: URL_A }),
    sends: () => rpc.methods.filter((method) => method.startsWith("eth_send")).length,
  };
}

/** `ceil(gas × maxFeePerGas / 10^12)`。 */
const boundOf = (gas: bigint, maxFeePerGas: bigint): bigint => (gas * maxFeePerGas + 10n ** 12n - 1n) / 10n ** 12n;
/** viem の見積りの係数（1.2 倍）。 */
const times12 = (value: bigint): bigint => (value * 12n) / 10n;

/** SDK が受け取る account を包み、`signTransaction` に渡る transaction を書き換える。 */
function tamperWith(change: (tx: Tx) => Tx): void {
  sdk.wrapAccount = ((facade: FacadeLike) => ({
    address: facade.address,
    type: "local",
    signTransaction: (tx: unknown, options?: unknown) => facade.signTransaction(change({ ...(tx as Tx) }), options),
  })) as never;
}

function recode(tx: Tx, recipient: Hex | undefined, amount: bigint | undefined): Tx {
  const original = (tx["calls"] as { to: Hex; data: Hex }[])[0]!;
  const decoded = decodeFunctionData({ abi: Abis.tip20, data: original.data });
  const args = decoded.args as [Hex, bigint, Hex];
  return { ...tx, calls: [{ to: original.to, data: encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [recipient ?? args[0], amount ?? args[1], args[2]] }) }] };
}

describe("未払いの読取", () => {
  test("challenge を offer にして返す。RPC には触れず、credential も作らない", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, amount: "1000", payTo: MPP_FIXTURE_RECIPIENT, extra: { realm: h.upstream.realm } });
    expect(h.rpc.methods).toEqual([]);
    expect(h.innerSigned).toHaveLength(0);
    expect(h.upstream.seen).toMatchObject({ challenges: 1, credentials: 0, urls: [URL_A] });
    // 同じ条件なら、読むたびに id・expires が変わっても offer は同じ。
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual(offers);
  });

  test("1 つのヘッダに challenge が複数: 検査を通るものだけを上流の順で返す（通るものが 3 つ目でも選べる）", async () => {
    const h = await harness();
    h.upstream.state.prependChallenges = () => [
      { id: "evm-1", realm: "provider", method: "evm", intent: "charge", request: { amount: "1000", currency: OTHER, recipient: OTHER, methodDetails: { chainId: 8453 } } },
      { id: "main-1", realm: "provider", method: "tempo", intent: "charge", request: { amount: "1000", currency: MPP_FIXTURE_CURRENCY, recipient: MPP_FIXTURE_RECIPIENT, methodDetails: { chainId: 4217 } } },
    ];
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(offers).toHaveLength(1);
    expect((await h.pay(offers[0]!)).outcome).toBe("paid");
    expect(h.upstream.seen.verified).toBe(1);
  });

  test("challenge は 16 個まで。17 個は不成立", async () => {
    const h = await harness();
    const filler = (count: number) => () => Array.from({ length: count }, (_, index) => ({ id: `f-${index}`, realm: "provider", method: "evm", intent: "charge", request: { amount: "1" } }));
    h.upstream.state.prependChallenges = filler(15);
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toHaveLength(1);
    h.upstream.state.prependChallenges = filler(16);
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toThrow("too_many_offers");
  });

  test.each([
    ["splits", (c: Tx) => ({ ...c, request: { ...(c["request"] as Tx), methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID, splits: [{ recipient: OTHER, amount: "1" }] } } })],
    ["pull のみ", (c: Tx) => ({ ...c, request: { ...(c["request"] as Tx), methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID, supportedModes: ["pull"] } } })],
    ["額 0", (c: Tx) => ({ ...c, request: { ...(c["request"] as Tx), amount: "0" } })],
    ["header", (c: Tx) => ({ ...c, header: "X-Payment" })],
  ])("範囲外の challenge（%s）は候補にならない", async (_name, mutate) => {
    const h = await harness();
    h.upstream.state.mutateChallenge = mutate as never;
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
  });

  test("feePayer を申し出る challenge は候補になる（使わない）", async () => {
    const h = await harness();
    h.upstream.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Tx), methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID, feePayer: true } } });
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toHaveLength(1);
  });

  test("scope: 無ければ不問、あればこの URL のものだけ", async () => {
    const h = await harness();
    h.upstream.state.scope = "match";
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(offers).toHaveLength(1);
    expect((await h.pay(offers[0]!)).outcome).toBe("paid");
    h.upstream.state.scope = "GET https://provider.test/v1/other";
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
  });

  test.each([
    ["https でない", "http://provider.test/v1/price"],
    ["ポートつき", "https://provider.test:8443/v1/price"],
    ["IP リテラル", "https://93.184.216.34/v1/price"],
  ])("URL の規則を通らないものには接続しない: %s", async (_name, url) => {
    const h = await harness();
    await expect(h.rail.readChallenge(PROFILE_ID, { url })).rejects.toThrow("url");
    expect(h.gate.admitted).toBe(0);
  });

  test("プロファイルが無い id・mpp 送信でないプロファイルは使えない", async () => {
    const h = await harness({ profile: { ...PROFILE, rail: "x402" } });
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toThrow("no dynamic mpp profile");
  });
});

describe("支払い", () => {
  test.each([
    // `eth_fillTransaction` 対応ノード（本番の RPC。T0-a）: Router の baseFee の読取 1 回＋fill 1 回＋送金 1 回（設計 §8.2）。
    ["eth_fillTransaction 対応", true, ["eth_getBlockByNumber", "eth_fillTransaction", "eth_sendRawTransactionSync"]],
    // 非対応ノード: baseFee ＋ fill の失敗を含めて SDK の読取 4 回＋送金 1 回。
    ["eth_fillTransaction 非対応", false, ["eth_getBlockByNumber", "eth_fillTransaction", "eth_getBlockByNumber", "eth_maxPriorityFeePerGas", "eth_estimateGas", "eth_sendRawTransactionSync"]],
  ])("push で 1 回だけ送金し、上流の実 SDK の検証を通る。RPC は送金 1 回・全体 6 回以下（%s）", async (_label, fill, expectedCalls) => {
    const h = await harness();
    h.rpc.fillTransaction = fill;
    const offer = await h.quote();
    const result = await h.pay(offer);
    expect(result).toMatchObject({ outcome: "paid", body: { ok: true }, contentType: "application/json" });
    expect(h.innerSigned).toHaveLength(1);
    expect(h.sends()).toBe(1);
    // Router が出す RPC は送金まで（その後ろは、上流の fixture が検証のために読む receipt）。
    const routerCalls = h.rpc.methods.slice(0, h.rpc.methods.indexOf("eth_sendRawTransactionSync") + 1);
    expect(routerCalls).toEqual(expectedCalls);
    expect(h.rpc.methods.slice(routerCalls.length).every((method) => method === "eth_getTransactionReceipt")).toBe(true);
    // 送った raw: 承認済みの送金 1 つ、fee token は明示、送り主は元の account。
    const raw = h.rpc.sentRaw[0]!;
    const envelope = TxEnvelopeTempo.deserialize(raw as never) as unknown as Tx;
    expect(envelope).toMatchObject({ type: "tempo", chainId: MPP_FIXTURE_CHAIN_ID, feeToken: MPP_FIXTURE_CURRENCY, nonceKey: maxUint256, maxPriorityFeePerGas: 1n, maxFeePerGas: feePerGasOf(h.rpc.quote.baseFeePerGas) });
    expect(envelope["calls"]).toHaveLength(1);
    expect(h.rpc.lastSender?.toLowerCase()).toBe(h.address.toLowerCase());
    expect((result as { txRef: string }).txRef).toBe(keccak256(raw));
    expect(h.upstream.seen).toMatchObject({ challenges: 2, credentials: 1, verified: 1, rejected: 0, urls: [URL_A, URL_A, URL_A] });
    await settled();
    expect(h.gate.released).toBe(h.gate.admitted);
  });

  test("元の account は SDK に渡らない: tempo.charge の account にも、SDK に返す client にも載っているのは facade", async () => {
    const h = await harness();
    const offer = await h.quote();
    await h.pay(offer);
    expect(sdk.accounts).toHaveLength(1);
    expect(sdk.clients.length).toBeGreaterThan(0);
    const seen = [...sdk.accounts, ...sdk.clients.map((client) => (client as { account?: unknown }).account)];
    for (const account of seen) {
      expect(Object.keys(account as object).sort()).toEqual(["address", "signTransaction", "type"]);
      for (const name of ["sign", "signMessage", "signTypedData", "signAuthorization"]) {
        expect((account as Tx)[name]).toBeUndefined();
      }
    }
    // fee token は client の chain で固定されている。
    expect((sdk.clients[0] as { chain: { feeToken?: string } }).chain.feeToken).toBe(MPP_FIXTURE_CURRENCY);
  });

  /* ---------------------------------------------------------------- 一致の定義（設計 §3.2・AC-6） */

  test.each([
    ["額", (u: MppUpstream) => { u.state.amount = "1001"; }],
    ["受取先", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Tx), recipient: OTHER } }); }],
    ["realm", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, realm: "another" }); }],
    ["methodDetails（feePayer の申し出が増えた）", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Tx), methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID, feePayer: true } } }); }],
    ["request.description", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Tx), description: "new" } }); }],
    ["opaque の中身（scope が付いた）", (u: MppUpstream) => { u.state.scope = "match"; }],
  ])("読み直しで %s が変わっていたら署名も送金もしない", async (_name, change) => {
    const h = await harness();
    const offer = await h.quote();
    change(h.upstream);
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(h.innerSigned).toHaveLength(0);
    expect(h.rpc.methods).toEqual([]);
    expect(h.upstream.seen.credentials).toBe(0);
  });

  test("読み直しが成立しない・検査を通らなくなった場合も署名しない", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Tx), methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID, splits: [{ recipient: OTHER, amount: "1" }] } } });
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(await h.pay(offer, "http://provider.test/v1/price")).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    expect(h.innerSigned).toHaveLength(0);
    expect(h.rpc.methods).toEqual([]);
  });

  /* ---------------------------------------------------------------- 署名の境界を adapter 越しに */

  test.each([
    ["call を 2 つにする", (tx: Tx) => ({ ...tx, calls: [...(tx["calls"] as unknown[]), ...(tx["calls"] as unknown[])] })],
    ["受取先を変える", (tx: Tx) => recode(tx, OTHER, undefined)],
    ["額を 100 倍にする", (tx: Tx) => recode(tx, undefined, 100_000n)],
    ["feeToken を外す", (tx: Tx) => ({ ...tx, feeToken: undefined })],
    ["feeToken を別の資産にする", (tx: Tx) => ({ ...tx, feeToken: OTHER })],
    ["keyAuthorization を足す", (tx: Tx) => ({ ...tx, keyAuthorization: { address: OTHER } })],
    ["feePayer を立てる", (tx: Tx) => ({ ...tx, feePayer: true })],
    ["有効期限を延ばす", (tx: Tx) => ({ ...tx, validBefore: Math.floor(Date.now() / 1000) + 3600 })],
  ])("SDK が %s と、元の account は呼ばれず、送金も上流への credential も無い", async (_name, change) => {
    const h = await harness();
    const offer = await h.quote();
    tamperWith(change);
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    expect(h.innerSigned).toHaveLength(0);
    expect(h.sends()).toBe(0);
    expect(h.upstream.seen.credentials).toBe(0);
  });

  test("SDK（ノードの提案）が単価を上げても、Router の単価で署名して払う（設計 §8.2）", async () => {
    const h = await harness();
    const offer = await h.quote();
    // ノードの提案を跳ねさせる（fill の maxFee・priority と eth_maxPriorityFeePerGas）。
    h.rpc.quote.priority = 9_625_000_000n;
    tamperWith((tx) => ({ ...tx, maxFeePerGas: 10n ** 15n, maxPriorityFeePerGas: 10n ** 15n }));
    expect((await h.pay(offer)).outcome).toBe("paid");
    expect(feesOf(h.rpc.sentRaw[0]!)).toMatchObject({ maxFeePerGas: feePerGasOf(h.rpc.quote.baseFeePerGas), maxPriorityFeePerGas: 1n });
  });

  test("SDK が渡す serializer を差し替えても、署名されるのは検査した transaction", async () => {
    const h = await harness();
    const offer = await h.quote();
    const evil = vi.fn(() => "0xdeadbeef");
    sdk.wrapAccount = ((facade: FacadeLike) => ({ address: facade.address, type: "local", signTransaction: (tx: unknown) => facade.signTransaction(tx, { serializer: evil }) })) as never;
    expect((await h.pay(offer)).outcome).toBe("paid");
    expect(evil).not.toHaveBeenCalled();
    expect(h.upstream.seen.verified).toBe(1);
  });

  test("送信の境界: 署名の境界を通っていない raw（別の鍵・別の受取先）は RPC に出さない", async () => {
    const h = await harness();
    const offer = await h.quote();
    const rogue = privateKeyToAccount(generatePrivateKey());
    // facade を呼ばずに、自前の raw を返す。
    sdk.wrapAccount = ((facade: FacadeLike) => ({
      address: facade.address,
      type: "local",
      signTransaction: (tx: unknown) => rogue.signTransaction({ ...recode(tx as Tx, OTHER, undefined), type: "tempo", account: undefined, chain: undefined, nonceManager: undefined } as never, { serializer: TempoTransaction.serialize as never }),
    })) as never;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    expect(h.rpc.sentRaw).toHaveLength(0);
    expect(h.innerSigned).toHaveLength(0);
  });

  test("送信の境界: 正しく署名させた後で別の raw に差し替えても RPC に出さない（署名済みなので unknown）", async () => {
    const h = await harness();
    const offer = await h.quote();
    const rogue = privateKeyToAccount(generatePrivateKey());
    sdk.wrapAccount = ((facade: FacadeLike) => ({
      address: facade.address,
      type: "local",
      signTransaction: async (tx: unknown, options?: unknown) => {
        await facade.signTransaction(tx, options);
        return rogue.signTransaction({ ...recode(tx as Tx, OTHER, undefined), type: "tempo", account: undefined, chain: undefined, nonceManager: undefined } as never, { serializer: TempoTransaction.serialize as never });
      },
    })) as never;
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(h.innerSigned).toHaveLength(1);
    expect(h.rpc.sentRaw).toHaveLength(0);
    expect(h.upstream.seen.credentials).toBe(0);
  });

  test("送金系の RPC は raw の送信だけ: eth_sendTransaction・wallet_sendCalls・eth_sign などは RPC に出ない", async () => {
    const h = await harness();
    const offer = await h.quote();
    const refused: string[] = [];
    sdk.wrapAccount = ((facade: FacadeLike, clients: { request(args: unknown): Promise<unknown> }[]) => ({
      address: facade.address,
      type: "local",
      signTransaction: async (tx: unknown, options?: unknown) => {
        for (const method of ["eth_sendTransaction", "wallet_sendCalls", "wallet_sendCallsSync", "eth_signTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4"]) {
          await clients[0]!.request({ method, params: [{ from: facade.address, to: OTHER, value: "0x1" }] }).catch(() => refused.push(method));
        }
        return facade.signTransaction(tx, options);
      },
    })) as never;
    expect((await h.pay(offer)).outcome).toBe("paid");
    expect(refused).toHaveLength(7);
    expect(h.rpc.methods.filter((method) => method.startsWith("wallet_") || method.startsWith("eth_sign") || method.startsWith("personal_") || method === "eth_sendTransaction")).toEqual([]);
    expect(h.sends()).toBe(1);
  });

  test("1 支払い 1 回: 同じ raw の 2 回目の送信は RPC に出ない", async () => {
    const h = await harness();
    const offer = await h.quote();
    const second: unknown[] = [];
    sdk.wrapClient = ((client: { request(args: { method: string }, options?: unknown): Promise<unknown> }) =>
      createClient({
        chain: (client as unknown as { chain: never }).chain,
        account: (client as unknown as { account: never }).account,
        transport: custom({
          request: async (args: { method: string }) => {
            const result = await client.request(args);
            if (args.method.startsWith("eth_sendRaw")) await client.request(args).catch((error: unknown) => second.push(error));
            return result;
          },
        }, { retryCount: 0 }),
      })) as never;
    expect((await h.pay(offer)).outcome).toBe("paid");
    expect(second).toHaveLength(1);
    expect(h.sends()).toBe(1);
  });

  test("feePayer: true を申し出る上流にも push で払う: 署名と送金は 1 回、肩代わりの欄は transaction に現れない", async () => {
    const h = await harness({ offerFeePayer: true });
    const offer = await h.quote();
    expect(JSON.parse(String(offer.extra?.["terms"])).request.methodDetails.feePayer).toBe(true);
    expect(await h.pay(offer)).toMatchObject({ outcome: "paid" });
    expect(h.upstream.seen).toMatchObject({ credentials: 1, verified: 1, rejected: 0 });
    expect(h.innerSigned).toHaveLength(1);
    expect(h.sends()).toBe(1);
    // 元の account が署名した transaction にも、送った raw にも、肩代わりの欄は無い。fee token は自分で明示している。
    expect(Object.keys(h.innerSigned[0]!).filter((key) => key.startsWith("feePayer"))).toEqual([]);
    const envelope = TxEnvelopeTempo.deserialize(h.rpc.sentRaw[0] as never) as unknown as Tx;
    expect(envelope["feePayerSignature"]).toBeUndefined();
    expect(envelope["feeToken"]).toBe(MPP_FIXTURE_CURRENCY);
    expect(h.rpc.lastSender?.toLowerCase()).toBe(h.address.toLowerCase());
  });

  test("送信の境界: 以前の支払いで署名した、まだ有効な raw を次の支払いで送らせない", async () => {
    const h = await harness();
    const captured: Hex[] = [];
    sdk.wrapAccount = ((facade: FacadeLike) => ({
      address: facade.address,
      type: "local",
      signTransaction: async (tx: unknown, options?: unknown) => {
        const fresh = await facade.signTransaction(tx, options);
        captured.push(fresh);
        // 2 件目では、1 件目の raw（同じ送り主・同じ受取先・同じ額・期限内）にすり替える。
        return captured.length === 1 ? fresh : captured[0]!;
      },
    })) as never;
    expect((await h.pay(await h.quote())).outcome).toBe("paid");
    expect(await h.pay(await h.quote())).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(captured).toHaveLength(2);
    expect(h.rpc.sentRaw).toEqual([captured[0]]);
  });

  test("RPC の要求は検査した値そのものを送る: 検査の後で中身が変わる params・method は通らない", async () => {
    const h = await harness();
    const offer = await h.quote();
    const rogue = privateKeyToAccount(generatePrivateKey());
    const outcomes: string[] = [];
    sdk.wrapAccount = ((facade: FacadeLike, clients: { request(args: unknown): Promise<unknown> }[]) => ({
      address: facade.address,
      type: "local",
      signTransaction: async (tx: unknown, options?: unknown) => {
        const good = await facade.signTransaction(tx, options);
        const evil = await rogue.signTransaction({ ...recode(tx as Tx, OTHER, undefined), type: "tempo", account: undefined, chain: undefined, nonceManager: undefined } as never, { serializer: TempoTransaction.serialize as never });
        const attempt = (label: string, args: unknown) => clients[0]!.request(args).then(() => outcomes.push(`${label}:sent`), () => outcomes.push(`${label}:refused`));
        // (1) 検査では正しい raw に見え、直列化すると別の raw になる配列
        const shifty = Object.assign([good], { toJSON: () => [evil] });
        await attempt("toJSON-params", { method: "eth_sendRawTransactionSync", params: shifty });
        // (2) 読取に見えて、直列化すると送金のメソッド名になる method
        await attempt("toJSON-method", { method: { startsWith: () => false, toJSON: () => "eth_sendRawTransaction" }, params: [evil] });
        // (3) 読むたびに値が変わる method
        let reads = 0;
        await attempt("getter-method", { get method() { reads += 1; return reads === 1 ? "eth_chainId" : "eth_sendRawTransaction"; }, params: [evil] });
        // (4) String オブジェクトの raw
        await attempt("boxed-raw", { method: "eth_sendRawTransactionSync", params: [new String(good)] });
        return good;
      },
    })) as never;
    const result = await h.pay(offer);
    // (1) は「検査した raw そのもの」が送られる（正しい送金として 1 回）。その後の SDK 自身の送信は 2 回目なので通らない。
    // (3) は、手前の viem が method を何度読むかで「読取として通る」か「送金として拒否される」かが変わる。どちらでも別の raw は出ない。
    expect(outcomes.filter((entry) => !entry.startsWith("getter-method"))).toEqual(["toJSON-params:sent", "toJSON-method:refused", "boxed-raw:refused"]);
    expect(h.rpc.sentRaw).toHaveLength(1);
    expect(h.rpc.lastSender?.toLowerCase()).toBe(h.address.toLowerCase());
    // 送金のメソッドが RPC に出たのは、検査した raw の 1 回だけ。
    expect(h.rpc.methods.filter((method) => method.startsWith("eth_send"))).toEqual(["eth_sendRawTransactionSync"]);
    expect(result.outcome).toBe("unknown");
  });

  test("RPC は再試行しない（能力側が再試行を設定していても）。失敗したら署名しない", async () => {
    const h = await harness({ rpcRetryCount: 3 });
    const offer = await h.quote();
    h.rpc.http.status = 503;
    const started = Date.now();
    // 最初の RPC（baseFee の読取）が失敗する → 署名しない。
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_rejected" });
    expect(Date.now() - started).toBeLessThan(3000);
    // 見積りの各段が 1 回ずつ失敗するだけ（`Retry-After` も待たない）。
    expect(h.rpc.http.requests).toBeLessThanOrEqual(4);
    expect(h.innerSigned).toHaveLength(0);
  });

  test("RPC に使える時間の合計を過ぎたら、次の RPC を出さない（署名もしない）", async () => {
    const h = await harness({ rpcBudgetMs: 250 });
    // 非対応ノードの経路（読取が 4 回）で、2 回目以降が予算を超える。
    h.rpc.fillTransaction = false;
    const offer = await h.quote();
    h.rpc.http.delayMs = 200;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    // baseFee の読取（200 ms。予算の中）＋ fill の失敗（200 ms）で予算 250 ms を超え、3 回目は出ない。
    expect(h.rpc.http.requests).toBeLessThanOrEqual(2);
    expect(h.innerSigned).toHaveLength(0);
    expect(h.sends()).toBe(0);
  });

  /* ---------------------------------------------------------------- 手数料・RPC の失敗 */

  test("ノードの見積りで手数料の上限が maxFee を超えたら署名しない", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.rpc.quote.baseFeePerGas = 10n ** 12n;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    expect(h.innerSigned).toHaveLength(0);
    expect(h.sends()).toBe(0);
    expect(h.upstream.seen.credentials).toBe(0);
  });

  test("送金の RPC が失敗したら unknown。再送しない・上流に credential を送らない", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.rpc.failSend = true;
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(h.innerSigned).toHaveLength(1);
    expect(h.sends()).toBe(1);
    expect(h.upstream.seen.credentials).toBe(0);
  });

  /* ---------------------------------------------------------------- 応答（AC-14・AC-15） */

  const withReceipt = (status: number, body: string, contentType = "application/json") => (receipt: unknown) => ({ status, headers: { "content-type": contentType, "payment-receipt": serializedReceipt(receipt) }, body });

  test.each([
    ["text（公式の試験用 endpoint の形）", (u: MppUpstream) => { u.state.body = "tm! thanks for paying"; u.state.contentType = "text/plain"; }, { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["JSON の配列", (u: MppUpstream) => { u.state.body = "[1,2]"; }, { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["JSON として読めない", (u: MppUpstream) => { u.state.body = "{"; }, { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["content-type にパラメータ", (u: MppUpstream) => { u.state.contentType = "application/json; charset=utf-8"; }, { outcome: "paid" }],
    ["本文が上限超過", (u: MppUpstream) => { u.state.body = JSON.stringify({ pad: "x".repeat(DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes) }); }, { outcome: "paid_no_data", reason: "response_too_large" }],
    ["200 で receipt なし", (u: MppUpstream) => { u.state.afterVerify = () => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }); }, { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt が別の取引のもの", (u: MppUpstream) => { u.state.afterVerify = (r) => withReceipt(200, "{}")({ ...(r as object), reference: `0x${"12".repeat(32)}` }); }, { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt が失敗を示す", (u: MppUpstream) => { u.state.afterVerify = () => ({ status: 200, headers: { "content-type": "application/json", "payment-receipt": "bm90LWEtcmVjZWlwdA" }, body: "{}" }); }, { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["500＋整合した receipt", (u: MppUpstream) => { u.state.afterVerify = withReceipt(500, "{}"); }, { outcome: "paid_no_data", reason: "paid_data_unavailable" }],
    ["500 で receipt なし", (u: MppUpstream) => { u.state.afterVerify = () => ({ status: 500, headers: {}, body: "" }); }, { outcome: "unknown", reason: "destination_pay_unknown" }],
    ["リダイレクト", (u: MppUpstream) => { u.state.afterVerify = () => ({ status: 302, headers: { location: "https://provider.test/v1/elsewhere" }, body: "" }); }, { outcome: "unknown", reason: "destination_pay_unknown" }],
    ["ヘッダが上限超過", (u: MppUpstream) => { u.state.afterVerify = withReceipt(200, "{}", `application/json; pad=${"a".repeat(40_000)}`); }, { outcome: "unknown", reason: "destination_pay_unknown" }],
  ])("応答が %s", async (_name, arrange, expected) => {
    const h = await harness();
    const offer = await h.quote();
    arrange(h.upstream);
    expect(await h.pay(offer)).toMatchObject(expected);
    expect(h.innerSigned).toHaveLength(1);
    expect(h.sends()).toBe(1);
    expect(h.upstream.seen.credentials).toBe(1);
    expect(h.upstream.seen.urls).toEqual([URL_A, URL_A, URL_A]);
    await settled();
    expect(h.gate.released).toBe(h.gate.admitted);
  });

  test("上流が credential を受け付けなかった（402）: 送金は済んでいるので unknown。再作成・再送しない", async () => {
    const h = await harness();
    const offer = await h.quote();
    // id は offer に含まれない。発行後に id を書き換えると、offer は一致するが上流の検証（HMAC）は通らない。
    h.upstream.state.mutateChallenge = (c) => ({ ...c, id: "forged-id" });
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(h.sends()).toBe(1);
    expect(h.upstream.seen).toMatchObject({ credentials: 1, verified: 0, rejected: 1 });
  });

  test("credential を付けた要求の期限で打ち切ると unknown。枠は返る", async () => {
    const h = await harness({ paidTimeoutMs: 300 });
    const offer = await h.quote();
    h.upstream.state.delayMs = 2000;
    const started = Date.now();
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(Date.now() - started).toBeLessThan(1800);
    await settled();
    expect(h.gate.released).toBe(h.gate.admitted);
    expect(h.sends()).toBe(1);
    expect(h.upstream.seen.credentials).toBe(1);
  });
});

function serializedReceipt(receipt: unknown): string {
  return Buffer.from(JSON.stringify(receipt)).toString("base64url");
}

/* ------------------------------------------------------------------ 能力と組み立て */

test("能力が client を返さないまま止まっても、期限で打ち切って署名しない", async () => {
  const h = await harness({ rpcTimeoutMs: 200, capability: { getClient: () => new Promise<never>(() => {}) } });
  const offer = await h.quote();
  const started = Date.now();
  expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_capability_unsupported" });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(h.innerSigned).toHaveLength(0);
});

test("RPC の名前解決が止まっても、期限で打ち切って署名しない（上流は解決でき、RPC のホストだけ止まる）", async () => {
  const h = await harness({ rpcTimeoutMs: 200, stallDnsFor: "other.test" });
  const offer = await h.quote();
  const started = Date.now();
  expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_rejected" });
  expect(Date.now() - started).toBeLessThan(4000);
  expect(h.innerSigned).toHaveLength(0);
  expect(h.rpc.http.requests).toBe(0);
});

describe("能力の条件（設計 §3.3 の「能力」）", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const plain = createClient({ chain: tempoModerato, transport: http("https://other.test", { retryCount: 0 }) });
  const capability = (patch: Partial<MppTempoCapability> = {}): MppTempoCapability => ({ chainId: MPP_FIXTURE_CHAIN_ID, account, getClient: () => plain, mode: "push", kind: "real-key", ...patch });
  const build = (cap: MppTempoCapability, allowLoopback = false, profile: DynamicProfile = PROFILE, dns = true) =>
    createMppOutbound({
      upstreams: {},
      transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
      capability: cap,
      dynamic: { profiles: { [PROFILE_ID]: profile }, transport: createGuardedTransport({ allowLoopback, report: () => {}, ...(dns ? { dns: { timeoutMs: 2_000, maxInFlight: 16 } } : {}) }) },
    });

  test("push 明示・local account・実鍵・loopback を許さない transport でなければ起動失敗", () => {
    expect(() => build(capability())).not.toThrow();
    const { mode: _mode, ...noMode } = capability();
    expect(() => build(noMode as MppTempoCapability)).toThrow("push");
    expect(() => build(capability({ mode: "pull" }))).toThrow("push");
    expect(() => build(capability({ account: { address: account.address, type: "json-rpc" } as never }))).toThrow("local account");
    expect(() => build(capability({ kind: "non-signing-fixture" }))).toThrow("non-signing fixture");
    expect(() => build(capability(), true)).toThrow("loopback");
    expect(() => build(capability(), false, PROFILE, false)).toThrow("DNS deadline");
    expect(() => build(capability({ chainId: 4217 }))).toThrow("another chain");
    const { feeAsset: _fee, ...noFeeAsset } = PROFILE.destination;
    expect(() => build(capability(), false, { ...PROFILE, destination: noFeeAsset })).toThrow("feeAsset");
  });

  test("起動時の確認: client が viem の素の http transport でなければ失敗", async () => {
    await expect(assertDynamicMppCapability(capability(), { [PROFILE_ID]: PROFILE })).resolves.toBeUndefined();
    const customClient = createClient({ chain: tempoModerato, transport: custom({ request: async () => null }) });
    await expect(assertDynamicMppCapability(capability({ getClient: () => customClient }), { [PROFILE_ID]: PROFILE })).rejects.toThrow("plain http transport");
    const wrongChain = createClient({ chain: { ...tempoModerato, id: 4217 } as never, transport: http("https://other.test") });
    await expect(assertDynamicMppCapability(capability({ getClient: () => wrongChain }), { [PROFILE_ID]: PROFILE })).rejects.toThrow("plain http transport");
  });

  test("支払い時にも確かめる: 素の http でない client では署名しない", async () => {
    const customClient = createClient({ chain: tempoModerato, transport: custom({ request: async () => null }) });
    const h = await harness({ capability: { getClient: () => customClient } });
    const offer = await h.quote();
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_capability_unsupported" });
    expect(h.innerSigned).toHaveLength(0);
    expect(h.rpc.methods).toEqual([]);
  });
});

/* ------------------------------------------------------------------ 見積り（docs/dynamic-gas-fee-design.md §1） */

describe("見積り（quote 時のガス代。署名も送金もしない）", () => {
  test("eth_fillTransaction 対応ノード: RPC は baseFee ＋ fill の 2 回、単価は Router の feePerGasOf(baseFee)、bound = ceil(gas × maxFeePerGas / 10^12)、署名器は呼ばれない", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.rpc.methods.length = 0;
    const estimate = await h.estimate(offer);
    expect(h.rpc.methods).toEqual(["eth_getBlockByNumber", "eth_fillTransaction"]);
    const maxFeePerGas = feePerGasOf(h.rpc.quote.baseFeePerGas);
    expect(estimate).toEqual({ gas: h.rpc.quote.gas.toString(), maxFeePerGas: maxFeePerGas.toString(), bound: boundOf(h.rpc.quote.gas, maxFeePerGas).toString(), viaFillTransaction: true });
    // ノードの提案（priority）が跳ねても見積りは変わらない（設計 §8.2）。
    h.rpc.quote.priority = 24_400_000_000n;
    expect(await h.estimate(offer)).toEqual(estimate);
    // fill に渡した手数料は Router の値。
    expect(h.rpc.filled.at(-1)).toMatchObject({ maxFeePerGas: `0x${maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: "0x1" });
    expect(h.innerSigned).toHaveLength(0);
    expect(h.rpc.sentRaw).toHaveLength(0);
    // 見積もった transaction は署名するものと同じ形: transferWithMemo(payTo, amount, 32 バイトの memo)、feeToken、expiring nonce。
    const filled = h.rpc.filled[0]!;
    expect(filled).toMatchObject({ type: "0x76", feeToken: MPP_FIXTURE_CURRENCY, nonceKey: `0x${"f".repeat(64)}`, nonce: "0x0", from: h.address });
    const calls = filled["calls"] as { to: string; data?: string; input?: string }[];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.toLowerCase()).toBe(MPP_FIXTURE_CURRENCY.toLowerCase());
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: (calls[0]!.data ?? calls[0]!.input) as Hex });
    expect(decoded.functionName).toBe("transferWithMemo");
    expect((decoded.args as readonly unknown[])[0]).toBe(MPP_FIXTURE_RECIPIENT);
    expect((decoded.args as readonly unknown[])[1]).toBe(1000n);
    expect(((decoded.args as readonly unknown[])[2] as string).length).toBe(66);
  });

  test("非対応ノード: baseFee ＋ fill の失敗 ＋ eth_estimateGas の 3 回（手数料は Router が渡すので viem の手数料の見積りは走らない）。次の見積りでも同じ。eth_maxPriorityFeePerGas が無くても同じ", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.rpc.fillTransaction = false;
    h.rpc.methods.length = 0;
    const first = await h.estimate(offer);
    expect(h.rpc.methods).toEqual(["eth_getBlockByNumber", "eth_fillTransaction", "eth_estimateGas"]);
    const maxFeePerGas = feePerGasOf(h.rpc.quote.baseFeePerGas);
    expect(first).toEqual({ gas: h.rpc.quote.gas.toString(), maxFeePerGas: maxFeePerGas.toString(), bound: boundOf(h.rpc.quote.gas, maxFeePerGas).toString(), viaFillTransaction: false });
    h.rpc.methods.length = 0;
    await h.estimate(offer);
    expect(h.rpc.methods).toEqual(["eth_getBlockByNumber", "eth_fillTransaction", "eth_estimateGas"]);
    h.rpc.priorityFee = false;
    h.rpc.methods.length = 0;
    const third = await h.estimate(offer);
    expect(h.rpc.methods).toEqual(["eth_getBlockByNumber", "eth_fillTransaction", "eth_estimateGas"]);
    expect(third.viaFillTransaction).toBe(false);
    expect(h.innerSigned).toHaveLength(0);
    expect(h.sends()).toBe(0);
  });

  test("単価が変わると bound が変わる（ノードの応答から決まる）", async () => {
    const h = await harness();
    const offer = await h.quote();
    const low = await h.estimate(offer);
    h.rpc.quote.baseFeePerGas *= 10n;
    const high = await h.estimate(offer);
    expect(BigInt(high.bound)).toBeGreaterThan(BigInt(low.bound) * 9n);
  });

  test("pay: baseFee の読取も RPC の予算の中（予算が尽きていれば読まずに not_sent）", async () => {
    const h = await harness({ rpcBudgetMs: 150, rpcTimeoutMs: 1_000 });
    const offer = await h.quote();
    h.rpc.http.delayMs = 400; // 予算 150 ms < 1 回の上限 1,000 ms: 残りの予算で打ち切る。
    const started = Date.now();
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_rejected" });
    expect(Date.now() - started).toBeLessThan(900);
    expect(h.rpc.http.requests).toBe(1);
    expect(h.innerSigned).toHaveLength(0);
  });

  test("RPC が応答しない: 1 回の期限 = min(1 回の上限, 残りの予算)。合計の予算を超えて待たず、期限後は次の RPC を出さない", async () => {
    const h = await harness({ estimateRpcTimeoutMs: 1_000, estimateRpcBudgetMs: 1_200 });
    const offer = await h.quote();
    h.rpc.fillTransaction = false;
    h.rpc.http.delayMs = 800;
    const started = Date.now();
    await expect(h.estimate(offer)).rejects.toMatchObject({ name: "FeeEstimateError", reason: "fee_estimate_unavailable" });
    // fill（800 ms）→ 2 回目の期限は残り 400 ms（1 回の上限 1,000 ms ではなく）→ 合計 1,200 ms で終わる。1 回の上限で待つと 1,600 ms。
    expect(Date.now() - started).toBeLessThan(1_400);
    // 3 回目は出ない。
    expect(h.rpc.http.requests).toBeLessThanOrEqual(2);
    expect(h.innerSigned).toHaveLength(0);
  });

  test("RPC が HTTP の失敗を返す・門が断る: 見積りは失敗（再試行なし）", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.rpc.http.status = 503;
    await expect(h.estimate(offer)).rejects.toMatchObject({ reason: "fee_estimate_unavailable" });
    // fill が HTTP で失敗すると viem は見積りの RPC に落ちる（そこも失敗）。再試行は無い。
    expect(h.rpc.http.requests).toBeLessThanOrEqual(2);
    const refused = await harness();
    const offer2 = await refused.quote();
    refused.gate.refuseAt = refused.gate.admitted + 1;
    await expect(refused.estimate(offer2)).rejects.toMatchObject({ reason: "fee_estimate_unavailable" });
    expect(refused.rpc.http.requests).toBe(0);
  });

  test("能力の client が返らない・素の http でない: 見積りは失敗（予算の中で打ち切る）", async () => {
    const stalled = await harness({ estimateRpcBudgetMs: 300, capability: { getClient: () => new Promise(() => {}) } });
    const offer = await stalled.quote();
    const started = Date.now();
    await expect(stalled.estimate(offer)).rejects.toMatchObject({ reason: "fee_estimate_capability_unsupported" });
    expect(Date.now() - started).toBeLessThan(1_000);
    const customClient = createClient({ chain: tempoModerato, transport: custom({ request: async () => null }) });
    const unsupported = await harness({ capability: { getClient: () => customClient } });
    await expect(unsupported.estimate(await unsupported.quote())).rejects.toMatchObject({ reason: "fee_estimate_capability_unsupported" });
  });

  test("見積りの経路は送金・署名系の RPC を例外なく拒否する（chain の prepare フックが送ろうとしても RPC に出ない）", async () => {
    const h0 = await harness();
    const offer = await h0.quote();
    // chain の prepareTransactionRequest フック（[fn, options] の組）を、送金の RPC を出すものに包む（敵対的な chain 設定の模倣）。
    const [original, hookOptions] = (tempoModerato as unknown as { prepareTransactionRequest: [(r: unknown, c: unknown) => Promise<unknown>, unknown] }).prepareTransactionRequest;
    const malicious = {
      ...tempoModerato,
      prepareTransactionRequest: [
        async (request: unknown, context: { client: { request: (args: unknown) => Promise<unknown> } }) => {
          // 見積りに渡る account は署名口を持たない facade。持っていれば、ここで署名できてしまう。
          const account = (request as { account?: { signTransaction?: unknown } }).account;
          if (typeof account?.signTransaction === "function") {
            await (account.signTransaction as (tx: unknown) => Promise<unknown>)({ ...(request as object), type: "tempo" }).catch(() => undefined);
          }
          await context.client.request({ method: "eth_sendRawTransaction", params: ["0x76deadbeef"] });
          return original(request, context);
        },
        hookOptions,
      ],
    };
    const client = createClient({ chain: malicious as never, transport: http(h0.rpc.url, { retryCount: 0 }) });
    const h = await harness({ capability: { getClient: () => client } });
    h.rpc.methods.length = 0;
    await expect(h.estimate(offer)).rejects.toMatchObject({ reason: "fee_estimate_unavailable" });
    expect(h.rpc.methods.filter((method) => method.startsWith("eth_send"))).toEqual([]);
    expect(h.rpc.sentRaw).toHaveLength(0);
    expect(h.innerSigned).toHaveLength(0);
  });

  test("chain の prepare フックが止まっても、見積り全体は予算で終わる（余裕を足さない）", async () => {
    const h0 = await harness();
    const offer = await h0.quote();
    const [, hookOptions] = (tempoModerato as unknown as { prepareTransactionRequest: [unknown, unknown] }).prepareTransactionRequest;
    const stalled = { ...tempoModerato, prepareTransactionRequest: [() => new Promise(() => {}), hookOptions] };
    const client = createClient({ chain: stalled as never, transport: http(h0.rpc.url, { retryCount: 0 }) });
    const h = await harness({ estimateRpcBudgetMs: 500, capability: { getClient: () => client } });
    const started = Date.now();
    await expect(h.estimate(offer)).rejects.toMatchObject({ reason: "fee_estimate_unavailable" });
    expect(Date.now() - started).toBeLessThan(900);
    expect(h.innerSigned).toHaveLength(0);
  });

  test("prepare の結果の手数料の欄が Router の値と違えば（chain のフックが書き換える等）見積りは失敗する", async () => {
    const h0 = await harness();
    const offer = await h0.quote();
    const [original, hookOptions] = (tempoModerato as unknown as { prepareTransactionRequest: [(r: unknown, c: unknown) => Promise<unknown>, unknown] }).prepareTransactionRequest;
    const tampering = {
      ...tempoModerato,
      prepareTransactionRequest: [
        async (request: unknown, context: { phase: string }) => {
          const out = (await original(request, context)) as Record<string, unknown>;
          // fill の後に単価を書き換える（ノードの提案に戻す、など）。
          if (context.phase === "afterFillParameters") out["maxFeePerGas"] = 12_990_000_000n;
          return out;
        },
        hookOptions,
      ],
    };
    const client = createClient({ chain: tampering as never, transport: http(h0.rpc.url, { retryCount: 0 }) });
    const h = await harness({ capability: { getClient: () => client } });
    await expect(h.estimate(offer)).rejects.toMatchObject({ reason: "fee_estimate_unavailable" });
    expect(h.innerSigned).toHaveLength(0);
  });

  test("offer の形が違えば RPC に出ない", async () => {
    const h = await harness();
    const offer = await h.quote();
    await expect(h.estimate({ ...offer, amount: "-1" })).rejects.toMatchObject({ reason: "fee_estimate_offer_invalid" });
    await expect(h.estimate({ ...offer, payTo: "nope" })).rejects.toMatchObject({ reason: "fee_estimate_offer_invalid" });
    await expect(h.estimate({ ...offer, asset: MPP_FIXTURE_RECIPIENT })).rejects.toMatchObject({ reason: "fee_estimate_offer_invalid" });
    expect(h.rpc.http.requests).toBe(0);
  });
});

/* ------------------------------------------------------------------ 署名時の上限 = quote の cap（§3.4） */

describe("pay: 署名時の上限は request.maxFee（quote の cap）", () => {
  test("maxFee が無い・形が違う・天井を超える: 読み直しの後、署名も RPC もせずに not_sent / destination_fee_cap_invalid", async () => {
    const h = await harness();
    const offer = await h.quote();
    for (const maxFee of [null, "", "-1", "5001", "1e3"]) {
      h.rpc.methods.length = 0;
      expect(await h.pay(offer, URL_A, maxFee)).toEqual({ outcome: "not_sent", reason: "destination_fee_cap_invalid" });
      expect(h.rpc.methods).toEqual([]);
    }
    expect(h.innerSigned).toHaveLength(0);
    expect(h.upstream.seen.credentials).toBe(0);
  });

  test("cap が quote の bound より小さくても、capPerGas ≥ baseFee なら clamp して払う（bound ≤ cap）。capPerGas < baseFee なら署名しない", async () => {
    const h = await harness();
    const offer = await h.quote();
    const estimate = await h.estimate(offer); // bound 71（baseFee 6e8、gas 54,290）
    const lower = (BigInt(estimate.bound) - 1n).toString();
    expect((await h.pay(offer, URL_A, lower)).outcome).toBe("paid");
    const fees = feesOf(h.rpc.sentRaw[0]!);
    expect(boundOf(fees.gas, fees.maxFeePerGas)).toBeLessThanOrEqual(BigInt(lower));
    expect(fees.maxFeePerGas).toBeGreaterThanOrEqual(h.rpc.quote.baseFeePerGas);
    // ceil(54290 × 6e8 / 1e12) = 33 が取り込まれる最小の cap。32 では署名しない。
    expect(await h.pay(offer, URL_A, "32")).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    expect(h.innerSigned).toHaveLength(1);
  });

  test("送金の RPC が接続の前に門で断られたら、署名はしたが not_sent（raw は出ていない。再署名・再送なし）", async () => {
    // fill 対応: 読み直し（+1）→ baseFee（+2）→ fill（+3）→ 送金（+4）。送金の admit を断る。
    const h = await harness();
    const offer = await h.quote();
    h.gate.refuseAt = h.gate.admitted + 4;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_send_refused_before_dispatch" });
    expect(h.innerSigned).toHaveLength(1);
    expect(h.rpc.sentRaw).toHaveLength(0);
    expect(h.sends()).toBe(0);
    expect(h.upstream.seen.credentials).toBe(0);
  });

  test("送金の RPC の予算が署名後に尽きていても、出していなければ not_sent", async () => {
    const h = await harness({ rpcBudgetMs: 450 });
    const offer = await h.quote();
    // 応答を遅らせ、baseFee（300 ms）＋ fill（300 ms）の後、署名の後の送金の RPC の時点で予算切れにする。
    h.rpc.http.delayMs = 300;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_send_refused_before_dispatch" });
    expect(h.innerSigned).toHaveLength(1);
    expect(h.rpc.sentRaw).toHaveLength(0);
  });

  test("送金の RPC が接続した後に失敗したら unknown のまま（接続前の拒否とは区別する）", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.rpc.failSend = true;
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(h.rpc.sentRaw).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ 期限と運用者の集合（送信の設計 §2.3・§2.4、FR-36・FR-38。タスク U3） */

describe("動的 MPP: 承認の期限と運用者の集合", () => {
  const FAR = 10_000_000;

  test("(A) 期限が実署名の委譲の直前に切れていれば not_sent（署名 0・送金 0）", async () => {
    let offset = 0;
    const h = await harness({ now: () => Date.now() + offset });
    const offer = await h.quote();
    // SDK が facade の署名口を呼ぶ直前で時計を進める（facade の内側の検査が期限で止める）。
    sdk.wrapAccount = ((facade: FacadeLike) => ({
      address: facade.address,
      type: "local",
      signTransaction: async (tx: unknown, opts?: unknown) => { offset = FAR; return facade.signTransaction(tx, opts); },
    })) as never;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(h.innerSigned).toHaveLength(0);
    expect(h.sends()).toBe(0);
  });

  test("(B) 署名の後・送金 RPC の委譲の前に切れれば not_sent（署名 1・送金 0）", async () => {
    let offset = 0;
    const h = await harness({ now: () => Date.now() + offset });
    const offer = await h.quote();
    sdk.wrapAccount = ((facade: FacadeLike) => ({
      address: facade.address,
      type: "local",
      signTransaction: async (tx: unknown, opts?: unknown) => { const raw = await facade.signTransaction(tx, opts); offset = FAR; return raw; },
    })) as never;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(h.innerSigned).toHaveLength(1);
    expect(h.sends()).toBe(0);
  });

  test("運用者の集合にある受取先の challenge は候補に出ず、保存した offer でも pay で送らない", async () => {
    const plain = await harness();
    const offer = await plain.quote();
    const h = await harness({ operatorAddresses: [MPP_FIXTURE_RECIPIENT] });
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
    const result = await h.pay(offer);
    expect(result.outcome).toBe("not_sent");
    expect(h.innerSigned).toHaveLength(0);
    expect(h.sends()).toBe(0);
  });
});
