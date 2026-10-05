/**
 * **MPP 受信レグを払う側**の能力。**製品コードではない**（実鍵を扱う起動側）。
 *
 * これまで `tools/` にあったのは「Router が Provider に払う」側だけで、
 * **Router に MPP で払う client** は無かった。P5 の MPP 受信を実際に通すために要る。
 *
 * x402 受信（`tools/x402-payer.ts`）との決定的な違い:
 *
 * | | x402 受信 | MPP 受信 |
 * |---|---|---|
 * | 資格情報 | EIP-3009 の**署名** | **送金済み tx の hash** |
 * | 送信と gas | facilitator が負担 | **payer 自身が broadcast し、手数料も払う** |
 * | 作る前に | 何も起きない | **チェーンに送金が起きる** |
 *
 * したがってここは「credential を作る」ではなく「**実際に送金してから hash を渡す**」。
 * 失敗しても送金が戻らないので、**scope を外れたら送金前に止める**。
 *
 * 公式 `mppx/client` の `Mppx.create` + `tempo.charge({ mode: "push" })` を使い、
 * memo の challenge 束縛・額・宛先の組み立ては**SDK に任せる**（自前で memo を作らない）。
 */

import { Challenge, Credential } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/tempo/chains";

export const TEMPO_MODERATO_CHAIN_ID = 42_431;
export const TEMPO_MODERATO_RPC = "https://rpc.moderato.tempo.xyz";

/** Router が発行した MPP offer のうち、payer が読む部分。 */
export interface MppOfferView {
  readonly amount: string;
  readonly payTo: string;
  readonly asset: string;
  readonly network: string;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface MppPayerScope {
  /** 払ってよいチェーン。 */
  readonly chainId: number;
  /** 払ってよい資産。 */
  readonly asset: string;
  /** 払ってよい宛先（Router の受取先）。 */
  readonly payTo: string;
  /** 1 回に払ってよい上限（base units）。 */
  readonly maxAmount: bigint;
}

export interface MppPayer {
  readonly address: `0x${string}`;
  /**
   * offer に対して**実際に送金し**、Router に渡す credential を返す。
   * scope 外なら送金せずに throw する。
   */
  payAndCredential(offer: MppOfferView): Promise<{ credential: string; txRef: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMppPayer(
  privateKey: string,
  scope: MppPayerScope,
  options: { readonly rpcUrl?: string } = {},
): MppPayer {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("payer private key must be a 0x-prefixed 32-byte hex string");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const rpcUrl = options.rpcUrl ?? TEMPO_MODERATO_RPC;

  return {
    address: account.address,

    async payAndCredential(offer: MppOfferView): Promise<{ credential: string; txRef: string }> {
      // ---- 送金**前**の scope 検査。ここを抜けたら金が動く。 ----
      if (offer.network !== `eip155:${scope.chainId}`) {
        throw new Error(`refusing to pay on ${offer.network} (scope is eip155:${scope.chainId})`);
      }
      if (offer.asset.toLowerCase() !== scope.asset.toLowerCase()) {
        throw new Error(`refusing to pay asset ${offer.asset}`);
      }
      if (offer.payTo.toLowerCase() !== scope.payTo.toLowerCase()) {
        throw new Error(`refusing to pay ${offer.payTo}`);
      }
      if (BigInt(offer.amount) > scope.maxAmount) {
        throw new Error(`refusing to pay ${offer.amount} (over ${scope.maxAmount})`);
      }
      if (account.address.toLowerCase() === offer.payTo.toLowerCase()) {
        throw new Error("payer and recipient are the same address (self-payment)");
      }

      // Router は offer に challenge 本体（WWW-Authenticate 形式）を載せて返す。
      // id だけでは memo を challenge に束縛できないため。
      const serialized = offer.extra["challenge"];
      if (typeof serialized !== "string" || serialized === "") {
        throw new Error("offer does not carry the mppx challenge; cannot pay it");
      }
      const challenge = Challenge.deserialize(serialized);

      const client = createWalletClient({
        account,
        // chain を持たせる（SDK は client の chain と challenge の chain を突き合わせる）。
        chain: { ...tempoModerato, id: scope.chainId },
        transport: http(rpcUrl, { retryCount: 0 }),
      }).extend(publicActions);

      const mppx = Mppx.create({
        methods: [
          tempo.charge({
            account,
            // **push 固定**: 自分で broadcast して hash を渡す。
            // 既定は local account だと `pull` なので、明示しないと未検証の経路に落ちる。
            mode: "push",
            /**
             * SDK が読むのは `getClient`（`client` という欄は無く、渡しても**黙って無視され**、SDK の既定の RPC が使われる）。
             * 以前は `client` で渡していたため、`rpcUrl` の指定が効いていなかった（既定の RPC が同じ testnet なので動いてはいた）。
             */
            getClient: () => client as never,
            // 送金先とチェーンを SDK 側にも伝え、challenge と食い違ったら SDK に止めさせる。
            allowedChainIds: [scope.chainId],
            expectedRecipients: [scope.payTo as `0x${string}`],
          } as never),
        ],
      });

      // 402 応答を復元して公式経路に載せる（Router は JSON で返すので wire を組み直す）。
      const response = new Response(null, {
        status: 402,
        headers: { "www-authenticate": serialized },
      });
      const credential = await mppx.createCredential(response);

      /**
       * 送金 hash を取り出す（レシート照合に使う）。
       * **credential は base64 ではなく `Payment <base64>` の wire 文字列**なので、
       * 自前で base64 デコードしても読めない。公式 `Credential.deserialize` を使う。
       */
      let txRef = "";
      try {
        const parsed: unknown = Credential.deserialize(credential);
        const payload = isRecord(parsed) ? parsed["payload"] : undefined;
        const hash = isRecord(payload) ? payload["hash"] : undefined;
        if (typeof hash === "string") txRef = hash;
      } catch {
        // hash を読めなくても credential 自体は有効。照合を諦めるだけ。
      }
      void challenge;
      return { credential, txRef };
    },
  };
}
