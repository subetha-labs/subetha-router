/**
 * Tempo **testnet**（Moderato）の MPP Provider に、設計どおりの「署名の境界」を通して実際に 1 回払ってみる試行。
 * **製品コードではない。** 動的上流 URL の MPP 送信（設計 `docs/dynamic-upstream-design.md` §3.3）の事前確認。
 *
 * 確かめたいこと: challenge が `methodDetails.feePayer`（上流が手数料を肩代わりする申し出）を持つ Provider が、
 * Router の方式——**push**（こちらで送金して hash を渡す）・手数料は自分で払う——の credential を受け付けるか。
 *
 * 範囲はコードで強制する:
 *   - chain は Tempo Moderato（42431）、通貨は testnet の pathUSD だけ、額は `CAP` 以下、支払いは 1 回
 *   - 署名するのは「token への call 1 つ・`transferWithMemo`／`transfer`・受取先と額が challenge と一致・
 *     手数料の資産は pathUSD・手数料の上限は `MAX_FEE` 以下」の transaction だけ。**設計の facade の検査の一部**であり、
 *     nonce・有効期限・優先手数料の範囲、渡された `type`、`accessList` と未知の欄の拒否は見ていない（製品では必須）
 *   - 「1 回だけ」はこのプロセスの中での制限（実行し直せばもう 1 回払う）
 *   - `--pay` が無ければ 402 を読むだけ
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x… npx tsx tools/dyn-testnet-mpp-trial.ts [--pay] https://…
 */
import { Challenge, Credential } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { createClient, decodeFunctionData, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Transaction as TempoTransaction } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";

const CHAIN_ID = 42431;
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const CAP = 100_000n;
const MAX_FEE = 5_000n;
const abi = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function balanceOf(address owner) view returns (uint256)",
]);

async function main(): Promise<void> {
  const pay = process.argv.includes("--pay");
  const url = process.argv.slice(2).find((arg) => /^https:\/\//.test(arg));
  const key = process.env["T7_PAYER_PRIVATE_KEY"];
  if (url === undefined || key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    process.stderr.write("usage: T7_PAYER_PRIVATE_KEY=0x… tsx tools/dyn-testnet-mpp-trial.ts [--pay] https://…\n");
    process.exit(2);
  }
  const out: Record<string, unknown> = { at: new Date().toISOString(), host: new URL(url).host, pay };
  const inner = privateKeyToAccount(key as Hex);
  out["payer"] = inner.address;

  // 1) 402 を読む（未払い）。
  const first = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const header = first.headers.get("www-authenticate");
  await first.arrayBuffer();
  out["status"] = first.status;
  if (first.status !== 402 || header === null) throw new Error("no MPP challenge");
  const challenge = Challenge.deserialize(header) as unknown as {
    id: string;
    method: string;
    intent: string;
    request: { amount: string; currency: string; recipient: string; methodDetails?: Record<string, unknown> };
  };
  const details = challenge.request.methodDetails ?? {};
  out["challenge"] = {
    kind: `${challenge.method}/${challenge.intent}`,
    amount: challenge.request.amount,
    chainId: details["chainId"],
    feePayerOffered: details["feePayer"] === true,
    supportedModes: details["supportedModes"] ?? null,
    methodDetailsKeys: Object.keys(details).sort(),
  };
  // 2) 範囲。
  if (challenge.method !== "tempo" || challenge.intent !== "charge") throw new Error("not tempo/charge");
  if (details["chainId"] !== CHAIN_ID) throw new Error("not Tempo Moderato");
  if (challenge.request.currency.toLowerCase() !== PATHUSD) throw new Error("currency is not testnet pathUSD");
  if (!/^[1-9][0-9]*$/.test(challenge.request.amount) || BigInt(challenge.request.amount) > CAP) throw new Error("amount over the trial cap");
  if (Array.isArray(details["supportedModes"]) && !details["supportedModes"].includes("push")) throw new Error("push not supported");
  for (const forbidden of ["splits", "machineTokenEnabled"]) {
    if (forbidden in details) throw new Error(`challenge uses ${forbidden}`);
  }
  if (!pay) {
    out["result"] = "dry-run (402 read only)";
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
    return;
  }

  // 3) 署名の境界（設計 §3.3 (ii) と同じ検査）。SDK に見せるのはこの facade だけ。
  let signs = 0;
  const signed: Record<string, unknown> = {};
  const facade = {
    address: inner.address,
    type: "local" as const,
    async signTransaction(tx: Record<string, unknown>): Promise<Hex> {
      if (signs > 0) throw new Error("second signature refused");
      const calls = tx["calls"] as { to?: string; data?: Hex; value?: bigint }[] | undefined;
      if (!Array.isArray(calls) || calls.length !== 1) throw new Error("not exactly one call");
      const call = calls[0]!;
      if (call.to?.toLowerCase() !== PATHUSD || (call.value ?? 0n) !== 0n || call.data === undefined) throw new Error("call target or value out of scope");
      const fn = decodeFunctionData({ abi, data: call.data });
      if (fn.functionName !== "transferWithMemo" && fn.functionName !== "transfer") throw new Error("not a transfer");
      if ((fn.args[0] as string).toLowerCase() !== challenge.request.recipient.toLowerCase()) throw new Error("recipient differs from the challenge");
      if (fn.args[1] !== BigInt(challenge.request.amount)) throw new Error("amount differs from the challenge");
      if (tx["chainId"] !== CHAIN_ID) throw new Error("wrong chain");
      if (typeof tx["feeToken"] !== "string" || tx["feeToken"].toLowerCase() !== PATHUSD) throw new Error("fee token missing or different");
      const gas = tx["gas"] as bigint;
      const maxFeePerGas = tx["maxFeePerGas"] as bigint;
      if (typeof gas !== "bigint" || typeof maxFeePerGas !== "bigint" || gas <= 0n || maxFeePerGas <= 0n) throw new Error("gas fields missing");
      const feeBound = (gas * maxFeePerGas + 10n ** 12n - 1n) / 10n ** 12n;
      if (feeBound > MAX_FEE) throw new Error("fee bound over the cap");
      for (const key of ["feePayerSignature", "keyAuthorization", "feePayer"]) {
        if (tx[key] !== undefined && tx[key] !== false) throw new Error(`unsupported field ${key}`);
      }
      if (Array.isArray(tx["authorizationList"]) && tx["authorizationList"].length > 0) throw new Error("authorization list present");
      signs += 1;
      Object.assign(signed, { functionName: fn.functionName, feeBound: feeBound.toString(), gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), validBeforeInSeconds: typeof tx["validBefore"] === "number" ? tx["validBefore"] - Math.floor(Date.now() / 1000) : null });
      // 組み直したものだけに署名する（渡された serializer は使わない）。
      return (await inner.signTransaction(
        { chainId: CHAIN_ID, calls: [{ to: call.to as Hex, data: call.data, value: 0n }], gas, maxFeePerGas, maxPriorityFeePerGas: tx["maxPriorityFeePerGas"], nonce: tx["nonce"], nonceKey: tx["nonceKey"], validBefore: tx["validBefore"], feeToken: PATHUSD, type: "tempo" } as never,
        { serializer: TempoTransaction.serialize as never },
      )) as Hex;
    },
  };
  const client = createClient({ account: facade as never, chain: { ...tempoModerato, feeToken: PATHUSD } as never, transport: http(tempoModerato.rpcUrls.default.http[0], { retryCount: 0 }) });
  const mppx = Mppx.create({
    methods: [tempo.charge({ account: facade, mode: "push", getClient: () => client, autoSwap: false, allowedChainIds: [CHAIN_ID], expectedRecipients: [challenge.request.recipient as Hex] } as never)],
  });
  const wire = await mppx.createCredential(new Response(null, { status: 402, headers: { "www-authenticate": header } }));
  const hash = (Credential.deserialize(wire).payload as { hash?: unknown; type?: unknown });
  out["signed"] = { signs, ...signed };
  out["credential"] = { type: hash.type, txHash: typeof hash.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash.hash) ? hash.hash : "not a hash" };

  // 4) credential を付けて同じ URL を 1 回。
  const started = Date.now();
  const second = await fetch(url, { method: "GET", redirect: "manual", headers: { authorization: wire }, signal: AbortSignal.timeout(30_000) });
  const body = await second.text();
  let top = "not JSON";
  try {
    const parsed: unknown = JSON.parse(body);
    top = Array.isArray(parsed) ? `array(${parsed.length})` : parsed !== null && typeof parsed === "object" ? `object(${Object.keys(parsed).length} fields)` : typeof parsed;
  } catch {
    // そのまま
  }
  out["paidRequest"] = { status: second.status, ms: Date.now() - started, hasReceiptHeader: second.headers.get("payment-receipt") !== null, body: top, bodyBytes: body.length };
  out["result"] = second.status === 200 ? "accepted" : "not accepted";
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

/** この tool が自分で投げる停止理由（固定文）。これ以外の例外の文字列は出さない。 */
const STOP_REASONS = new Set([
  "no MPP challenge",
  "not tempo/charge",
  "not Tempo Moderato",
  "currency is not testnet pathUSD",
  "amount over the trial cap",
  "push not supported",
  "challenge uses splits",
  "challenge uses machineTokenEnabled",
]);

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  process.stderr.write(`trial stopped: ${STOP_REASONS.has(message) ? message : "error"}\n`);
  process.exit(1);
});
