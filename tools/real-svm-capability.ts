/**
 * 実鍵による SVM（Solana）署名能力（`kind: "real-key"`。送信の設計 §6.4、FR-25、SR-2。タスク U6-b）。**製品コードではない。**
 *
 * **同期**（`routerProcessCapabilitiesOf` と `remote-router-process.ts` は同期で呼ぶ）。署名は `@noble/curves/ed25519`（受信の検証と同じ library）。
 * **鍵の文字列も seed も object に持たない**: seed は closure の中だけ（EVM の `privateKeyToAccount` と同じ扱い）。列挙・JSON 化しても出ない。
 * 署名は adapter が §4.5 の検査を通した message にだけ呼ぶ（この道具はチェーンにも RPC にも触れない）。
 */
import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder } from "@solana/kit";

import type { SvmSigningCapability } from "../src/ports/outbound.js";
import { svmSeedFromKey } from "./svm-key.js";

export interface RealSvmCapability {
  /** base58 の公開鍵。 */
  readonly address: string;
  /** 署名が呼ばれた回数（承認 1 件につき 1 回であることの確認用）。 */
  readonly signCount: () => number;
  capability(network: string): SvmSigningCapability;
}

export function createRealSvmCapability(key: string): RealSvmCapability {
  const seed = svmSeedFromKey(key);
  const address = getAddressDecoder().decode(ed25519.getPublicKey(seed));
  let signs = 0;
  const sign = (messageBytes: Uint8Array): Uint8Array => {
    signs += 1;
    // 写しに署名し、写しを返す（呼び出し側と領域を共有しない）。
    return Uint8Array.from(ed25519.sign(Uint8Array.from(messageBytes), seed));
  };
  return {
    address,
    signCount: () => signs,
    capability(network: string): SvmSigningCapability {
      return { network, address, sign, kind: "real-key" };
    },
  };
}
