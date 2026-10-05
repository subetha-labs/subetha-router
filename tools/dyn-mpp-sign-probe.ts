/**
 * 設計の実測 M-2（`docs/dynamic-upstream-design.md` §3.3・§10、タスク T0-a）。**製品コードではない。**
 *
 * 問い: MPP 送信（Tempo charge・push・local account）で、
 *   1. SDK は包んだ account の `signTransaction` に**何を**渡すか（欄の一覧、`serializer` 引数の有無）
 *   2. client の chain に `feeToken` を設定すると、署名に渡る transaction に入るか
 *   3. `sign({hash})`・`signMessage`・`signTypedData`・`signAuthorization` を持たない facade で支払いが通るか
 *   4. 渡された `serializer` を無視して Router が選んだ serializer で署名しても、送る raw は正しいか
 *   5. 1 件の支払いで RPC に何が何回出るか。送金の RPC に渡る raw は署名した transaction と同じか
 *
 * 鍵は毎回の乱数。RPC はプロセス内の stub（ネットワークには出ない）。challenge は実 `mppx/server` が発行する。
 *
 * `--real-rpc-reads` を付けると、**読取の RPC だけ**を Tempo testnet の公開 RPC に転送する（送金の RPC は常に stub で、
 * 何も送らない）。実ノードが `eth_fillTransaction` に応えるときの経路と、ノードが決める gas・手数料の欄を見るため。
 *
 * `--from <address>` は、残高のある公開アドレスを**送信者として名乗るだけ**にする（鍵は持たない）。
 * `signTransaction` に渡ったものを記録したところで止め、**署名も送金もしない**。ノードが埋めた欄を見るために使う。
 *
 * usage: npx tsx tools/dyn-mpp-sign-probe.ts [--real-rpc-reads] [--from 0x...]
 */
import { Mppx as ServerMppx, tempo as serverTempo } from "mppx/server";
import { Challenge, Credential } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { createClient, custom, decodeFunctionData, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/tempo/chains";
import { Transaction as TempoTransaction } from "viem/tempo";
import { TxEnvelopeTempo } from "ox/tempo";

const TOKEN = "0x20c0000000000000000000000000000000000000" as const;
const RECIPIENT = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1" as const;
const AMOUNT = "10000";
const CHAIN_ID = tempoModerato.id;
const abi = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
]);

const jsonSafe = (value: unknown): unknown =>
  // `abi` は SDK が call に付けてくる巨大な定義（署名には使われない）。出力からは落とす。
  JSON.parse(JSON.stringify(value, (k, v) => (k === "abi" ? "<omitted>" : typeof v === "bigint" ? `${v}n` : v)));

const REAL_RPC_READS = process.argv.includes("--real-rpc-reads");
const FROM = process.argv.includes("--from") ? (process.argv[process.argv.indexOf("--from") + 1] as `0x${string}`) : undefined;
const PUBLIC_RPC = tempoModerato.rpcUrls.default.http[0];

/** 読取の RPC を公開ノードに転送する（`--real-rpc-reads` のときだけ）。エラーはノードの code を保つ。 */
async function forward(method: string, params: unknown): Promise<unknown> {
  const response = await fetch(PUBLIC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (json.error !== undefined) throw Object.assign(new Error(json.error.message), { code: json.error.code });
  return json.result;
}

async function run(options: { chainFeeToken: boolean }): Promise<Record<string, unknown>> {
  const inner = privateKeyToAccount(generatePrivateKey());
  const signCalls: Record<string, unknown>[] = [];
  let signedRaw: string | undefined;

  /**
   * SDK に見せる最小の account。**自分のプロパティは address・type・signTransaction の 3 つだけ**。
   * Proxy で包み、SDK が読もうとしたプロパティ名をすべて記録する（無いものは `undefined` が返る）。
   */
  const propertyReads = new Set<string>();
  const target = {
    address: FROM ?? inner.address,
    type: "local" as const,
    async signTransaction(transaction: Record<string, unknown>, args?: { serializer?: unknown }): Promise<Hex> {
      signCalls.push({
        keys: Object.keys(transaction).sort(),
        definedKeys: Object.keys(transaction).filter((key) => transaction[key] !== undefined).sort(),
        transaction: jsonSafe(transaction),
        serializerPassed: typeof args?.serializer === "function",
      });
      if (FROM !== undefined) {
        // 鍵を持たないアドレスを名乗っている。ここで止める（署名も送金もしない）。
        throw new Error("probe stops before signing (--from)");
      }
      // 渡された serializer は使わない。Router が選んだ Tempo の serializer で署名する。
      signedRaw = await inner.signTransaction(transaction as never, { serializer: TempoTransaction.serialize as never });
      return signedRaw as Hex;
    },
  };
  const facade = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string") propertyReads.add(property);
      return Reflect.get(object, property, receiver);
    },
  });

  const rpc: { method: string; params: unknown }[] = [];
  const txHash = `0x${"b0".repeat(32)}`;
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    rpc.push({ method, params });
    if (REAL_RPC_READS && !method.startsWith("eth_send") && !method.startsWith("wallet_")) {
      return forward(method, params);
    }
    switch (method) {
      case "eth_chainId":
        return `0x${CHAIN_ID.toString(16)}`;
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_estimateGas":
        return "0x186a0";
      case "eth_maxPriorityFeePerGas":
        return "0x3b9aca00";
      case "eth_gasPrice":
        return "0x77359400";
      case "eth_getBlockByNumber":
        return { number: "0x1", baseFeePerGas: "0x3b9aca00", timestamp: "0x1", gasLimit: "0x1c9c380", transactions: [] };
      case "eth_fillTransaction":
        throw Object.assign(new Error("method not found"), { code: -32601 });
      case "eth_sendRawTransactionSync":
        return {
          status: "0x1",
          blockHash: `0x${"11".repeat(32)}`,
          blockNumber: "0x1",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          cumulativeGasUsed: "0x5208",
          from: inner.address,
          to: TOKEN,
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          transactionHash: txHash,
          transactionIndex: "0x0",
          type: "0x76",
        };
      default:
        throw new Error(`probe rpc has no stub for ${method}`);
    }
  };
  const chain = options.chainFeeToken ? { ...tempoModerato, feeToken: TOKEN } : tempoModerato;
  const client = createClient({ account: facade as never, chain: chain as never, transport: custom({ request }, { retryCount: 0 }) });

  // 実 SDK（server）が発行する challenge。Router の受信 adapter と同じ作り方。
  const server = ServerMppx.create({
    secretKey: "0123456789abcdef0123456789abcdef0123456789abcdef",
    realm: "probe",
    methods: [serverTempo.charge({ recipient: RECIPIENT, currency: TOKEN, decimals: 0, supportedModes: ["push"], getClient: () => client as never } as never)],
  });
  const challenge = (await (server as never as { challenge: { tempo: { charge(a: unknown): Promise<unknown> } } }).challenge.tempo.charge({
    amount: AMOUNT,
    chainId: CHAIN_ID,
    expires: new Date(Date.now() + 600_000).toISOString(),
  })) as Parameters<typeof Challenge.serialize>[0];

  const mppx = Mppx.create({
    methods: [tempo.charge({ account: facade, mode: "push", getClient: () => client, autoSwap: false, allowedChainIds: [CHAIN_ID], expectedRecipients: [RECIPIENT] } as never)],
  });
  let error: string | undefined;
  let credentialHash: unknown;
  try {
    const wire = await mppx.createCredential(new Response(null, { status: 402, headers: { "www-authenticate": Challenge.serialize(challenge) } }));
    credentialHash = (Credential.deserialize(wire).payload as { hash?: unknown }).hash;
  } catch (cause) {
    error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
  }

  const sent = rpc.filter((c) => c.method.startsWith("eth_sendRaw"));
  const raw = (sent[0]?.params as string[] | undefined)?.[0];
  let decoded: Record<string, unknown> | undefined;
  if (raw !== undefined) {
    const envelope = TxEnvelopeTempo.deserialize(raw as never);
    const call = envelope.calls?.[0];
    const fn = call?.data === undefined ? undefined : decodeFunctionData({ abi, data: call.data });
    decoded = jsonSafe({
      prefix: raw.slice(0, 4),
      chainId: envelope.chainId,
      calls: envelope.calls?.length,
      to: call?.to,
      value: call?.value ?? 0n,
      functionName: fn?.functionName,
      recipient: fn?.args?.[0],
      amount: fn?.args?.[1],
      memoPresent: fn?.args?.[2] !== undefined,
      feeToken: envelope.feeToken,
      gas: envelope.gas,
      maxFeePerGas: envelope.maxFeePerGas,
      maxPriorityFeePerGas: envelope.maxPriorityFeePerGas,
      nonceKey: envelope.nonceKey,
      nonce: envelope.nonce,
      validBefore: envelope.validBefore === undefined ? undefined : `now+${envelope.validBefore - Math.floor(Date.now() / 1000)}s`,
      validAfter: envelope.validAfter,
      feePayerSignature: envelope.feePayerSignature !== undefined,
      keyAuthorization: (envelope as { keyAuthorization?: unknown }).keyAuthorization !== undefined,
      authorizationList: (envelope as { authorizationList?: unknown[] }).authorizationList?.length ?? 0,
      accessList: envelope.accessList?.length ?? 0,
    }) as Record<string, unknown>;
  }

  return {
    chainFeeTokenConfigured: options.chainFeeToken,
    error,
    credentialCarriesTheSentHash: credentialHash === txHash,
    signTransactionCalls: signCalls.length,
    signTransactionInput: signCalls[0],
    // facade に無いプロパティのうち、SDK が読みに来たもの（`undefined` を受け取って先へ進めた）。
    propertiesReadByTheSdk: [...propertyReads].sort(),
    ownPropertiesOfTheFacade: Object.keys(target).sort(),
    rpcMethods: rpc.map((c) => c.method),
    sendCalls: sent.length,
    sentRawEqualsSignedRaw: raw !== undefined && raw === signedRaw,
    sentTransaction: decoded,
  };
}

/**
 * 迂回の試み（オフライン）。SDK ではなく「範囲外の署名をさせようとする呼び出し側」を直接演じる。
 * 1. 生の署名（`sign({hash})`）とその他の署名口は、facade に**存在しない**
 * 2. `signTransaction` に別の transaction を出力する serializer を渡しても、署名されるのは検査した transaction
 */
async function bypassAttempts(): Promise<Record<string, unknown>> {
  const inner = privateKeyToAccount(generatePrivateKey());
  const facade = {
    address: inner.address,
    type: "local" as const,
    async signTransaction(transaction: Record<string, unknown>): Promise<Hex> {
      // 2 番目の引数（serializer）は受け取らない。
      return (await inner.signTransaction(transaction as never, { serializer: TempoTransaction.serialize as never })) as Hex;
    },
  };
  const { encodeFunctionData } = await import("viem");
  const transfer = (recipient: `0x${string}`, amount: bigint) => ({
    to: TOKEN,
    data: encodeFunctionData({ abi, functionName: "transfer", args: [recipient, amount] }),
  });
  const approved = {
    chainId: CHAIN_ID,
    calls: [transfer(RECIPIENT, 10000n)],
    gas: 100000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1n,
    nonceKey: 2n ** 256n - 1n,
    nonce: 0,
    validBefore: Math.floor(Date.now() / 1000) + 25,
    feeToken: TOKEN,
    type: "tempo",
  };
  const attacker = "0x000000000000000000000000000000000000dEaD" as const;
  // 検査をすり抜けた後で中身を差し替える serializer（別の受取先・100 倍の額）。
  const maliciousSerializer = (_tx: unknown, signature?: unknown): Hex =>
    TempoTransaction.serialize({ ...approved, calls: [transfer(attacker, 1_000_000n)] } as never, signature as never) as Hex;
  const raw = await (facade.signTransaction as (tx: unknown, args: unknown) => Promise<Hex>)(approved, { serializer: maliciousSerializer });
  const decoded = TxEnvelopeTempo.deserialize(raw as never);
  const fn = decodeFunctionData({ abi, data: decoded.calls?.[0]?.data ?? "0x" });
  // 比較: 渡された serializer をそのまま使う account なら、差し替えた中身に署名してしまう。
  const naive = await inner.signTransaction(approved as never, { serializer: maliciousSerializer as never });
  const naiveFn = decodeFunctionData({ abi, data: TxEnvelopeTempo.deserialize(naive as never).calls?.[0]?.data ?? "0x" });
  return {
    signingEntrypointsOnTheFacade: ["sign", "signMessage", "signTypedData", "signAuthorization"].map((name) => `${name}: ${typeof (facade as Record<string, unknown>)[name]}`),
    withSubstitutedSerializer: { recipient: fn.args?.[0], amount: String(fn.args?.[1]), signedTheApprovedTransaction: fn.args?.[0] === RECIPIENT && fn.args?.[1] === 10000n },
    positiveControl_accountThatHonoursTheSerializer: { recipient: naiveFn.args?.[0], amount: String(naiveFn.args?.[1]) },
  };
}

console.log(JSON.stringify({ realRpcReads: REAL_RPC_READS, bypassAttempts: REAL_RPC_READS ? "skipped (offline only)" : await bypassAttempts(), withChainFeeToken: await run({ chainFeeToken: true }), withoutChainFeeToken: await run({ chainFeeToken: false }) }, null, 1));
