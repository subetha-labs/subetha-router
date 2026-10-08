/**
 * pay-kit の server の組み立て（`docs/provider-mpp-solana-workers.md` §3.1・§3.2）。isolate ごとに 1 回。
 * 鍵（`FEE_PAYER_KEY`）は env から 1 度だけ読み、kit の signer（closure）にだけ渡す。`MPP_SECRET` も同じ。config にも Runtime にも値を入れない。
 *
 * 任せるもの: challenge の発行と HMAC、credential の検証、simulate、共同署名、送出、確定待ち（30 秒）、chain の読み直し、領収。
 * 任せないもの: データの取得（支払いの前。`index.ts`）、応答の本文の固定化、env の検査。
 */
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { Gate, Signer, createPayKit, usd } from "@solana/pay-kit";

import { DESCRIPTION, EXPIRES_IN_SECONDS, GATE_NAME, MIN_SECRET_BYTES, REALM, USD_AMOUNT, seedFromKey, type ProviderConfig, type ProviderEnv } from "./config.js";

export interface PayKitRuntime {
  /** fee payer の公開鍵（= `FEE_PAYER_PUBKEY`。起動時に seed から導いた値と照合済み）。 */
  readonly feePayer: string;
  /** 未払いの要求（`Authorization` を外したもの）に対する pay-kit の 402。 */
  challenge(request: Request): Promise<Response>;
  /** 支払いつきの要求: pay-kit が検証・送出・確定・照合し、成功なら `body` を 200 + `Payment-Receipt` で返す。 */
  paid(request: Request, body: string): Promise<Response>;
}

const ENCODER = new TextEncoder();

export async function createPayKitRuntime(env: ProviderEnv, config: ProviderConfig): Promise<PayKitRuntime> {
  const key = env.FEE_PAYER_KEY;
  if (typeof key !== "string" || key === "") throw new Error("FEE_PAYER_KEY is required");
  const seed = seedFromKey(key);
  const kitSigner = await createKeyPairSignerFromPrivateKeyBytes(seed);
  seed.fill(0);
  if (String(kitSigner.address) !== config.feePayerPubkey) throw new Error("FEE_PAYER_PUBKEY does not match the public key of FEE_PAYER_KEY");
  const secret = env.MPP_SECRET;
  if (typeof secret !== "string" || ENCODER.encode(secret).byteLength < MIN_SECRET_BYTES) throw new Error("MPP_SECRET must be at least 32 bytes");
  const signer = Signer.from(kitSigner as never, { feePayer: true });
  const pay = await createPayKit({
    network: "devnet",
    rpcUrl: config.rpcUrl,
    accept: ["mpp"],
    operator: { signer, feePayer: true, recipient: config.payTo },
    mpp: { challengeBindingSecret: secret, realm: REALM, expiresIn: EXPIRES_IN_SECONDS, html: false },
    // isolate ごとに RPC を叩かない（配備の手順で確かめる）。`simulateTransaction` は preflight と無関係に送出の前に呼ばれる。
    preflight: false,
  } as never);
  const gate = Gate.create({ amount: usd(USD_AMOUNT), name: GATE_NAME, description: DESCRIPTION }, { accept: ["mpp"], payTo: config.payTo } as never);
  return {
    feePayer: String(kitSigner.address),
    challenge(request) {
      // handler は呼ばれないはず（Authorization 無し）。呼ばれたら本文を出さない。
      return pay.fetch(gate, async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }))(request);
    },
    paid(request, body) {
      return pay.fetch(gate, async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }))(request);
    },
  };
}
