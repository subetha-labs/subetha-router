/**
 * release 文書（要件 FR-Z21、設計 §5.2）: Router が「この intent にこのヘッダを発行した」ことを記録する JSON。暗号署名は付けない（付けると主張しない）。
 * 真正性は Router の認証済みチャネルと journal（権威の保管）による。
 *
 * lab の `intent.rs` は **release のバイト列そのもの**の sha256 を record に固定する（`intent_binding.release_sha256`）ので、Router はこの関数が返した
 * バイト列だけを使う: Verifier の `--release`、journal の `releaseB64`、Payer への `releaseB64`、record の取得。再直列化しない。
 */

import { sha256Hex } from "./intent.js";

export const RELEASE_VERSION = "phase5-release-v1";

export interface ReleaseInput {
  readonly intentSha256: string;
  readonly orderId: string;
  readonly headerName: string;
  readonly headerValue: string;
  /** 受信 settle の `txRef`（空は不可。Rust は空を拒否する）。 */
  readonly inboundTx: string;
}

export interface ReleaseDocument {
  readonly version: typeof RELEASE_VERSION;
  readonly intent_sha256: string;
  readonly order_id: string;
  readonly header_name: string;
  readonly header_sha256: string;
  readonly inbound: { readonly tx: string };
}

export function releaseDocumentOf(input: ReleaseInput): ReleaseDocument {
  if (input.inboundTx === "") throw new Error("release requires the inbound transaction reference");
  return {
    version: RELEASE_VERSION,
    intent_sha256: input.intentSha256,
    order_id: input.orderId,
    header_name: input.headerName,
    header_sha256: sha256Hex(input.headerValue),
    inbound: { tx: input.inboundTx },
  };
}

/** release のバイト列（compact JSON、この鍵順）。以後はこのバイト列だけを使う。 */
export function releaseBytesOf(input: ReleaseInput): Buffer {
  return Buffer.from(JSON.stringify(releaseDocumentOf(input)), "utf8");
}

/** 配布した release のバイト列を読み戻す（record の取得・再起動後の照合）。形が違えば `undefined`。 */
export function parseReleaseBytes(bytes: Uint8Array): ReleaseDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const inbound = record["inbound"];
  if (
    record["version"] !== RELEASE_VERSION ||
    typeof record["intent_sha256"] !== "string" ||
    typeof record["order_id"] !== "string" ||
    typeof record["header_name"] !== "string" ||
    typeof record["header_sha256"] !== "string" ||
    typeof inbound !== "object" ||
    inbound === null ||
    typeof (inbound as Record<string, unknown>)["tx"] !== "string"
  ) {
    return undefined;
  }
  return {
    version: RELEASE_VERSION,
    intent_sha256: record["intent_sha256"],
    order_id: record["order_id"],
    header_name: record["header_name"],
    header_sha256: record["header_sha256"],
    inbound: { tx: (inbound as Record<string, string>)["tx"]! },
  };
}
