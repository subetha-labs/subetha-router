/**
 * 理由の表（設計 `docs/rejection-reasons-design.md` §7、§12.5 が優先。要件 FR-R1）。
 *
 * - 相手（facilitator・上流・SDK）が返す `invalidReason`・`errorReason`・`error` の **生の値** を、Router が持つ版つきの token に
 *   **完全一致だけ** で写す。前方一致・部分一致・大文字小文字の読み替えはしない。表に無い値は `unrecognized`、欄が無ければ `absent`、
 *   文字列でない・空なら `malformed`。生の値そのものは診断に残さない（SR-R1）。
 * - 表は人が確かめた一覧（manifest）。各値に出どころ（節・ファイル・行）を付ける。SDK の節は `SDK_VERSION` の dist（`dist/esm/…`）、
 *   ほかの節はこのリポジトリのファイル（リポジトリの根からの相対パス）。照合の試験（`tests/unit/payment-reasons-pin.test.ts`）が
 *   (1) SDK の版と、manifest・除外の一覧が引く dist のファイルの sha256、(2) 各値が出どころのファイルに文字列の literal として現れること、
 *   (3) dist から抜き出した値のうち manifest に無いものが `REASON_EXCLUSIONS` に載っていること、を確かめる。版を上げたら表を見直す。
 * - SVM の節の出どころは「x402 の SVM の実装 2.28.0」の dist（package 名はこのディレクトリに書かない: 依存の向きの試験）。
 * - 文の形の SDK の値（`"No matching payment requirements"` など）だけ `sdk_…` の token に写す。ほかは生の値と同じ token。
 * - 式で組み立てられる値（例: SVM の batch-settlement の `${PREFIX}…`、`${ErrTransactionFailed}: <例外の文>`）は literal でないので
 *   manifest に入れない。届けば `unrecognized`（完全一致だけの方針どおり。理由の文は自由な文字列を含み得る）。
 *
 * 純粋（I/O なし）。
 */

/** 表の版。`reason` を残す行に `table` として付ける。 */
export const REASON_TABLE_VERSION = "r1/x402-2.28.0";

/** manifest が引く SDK（`@x402/core`・`@x402/evm`・SVM の実装）の版。 */
export const SDK_VERSION = "2.28.0";

export type ReasonSection = "x402_core" | "x402_evm" | "x402_svm" | "circle" | "self_facilitator" | "provider_worker";

/** 出どころ。SDK の節は package の根からの相対パス、ほかの節はリポジトリの根からの相対パス。行は 1 始まり（最初に現れる行）。 */
export interface ReasonSource {
  readonly file: string;
  readonly line: number;
}

export interface ReasonEntry {
  readonly section: ReasonSection;
  readonly raw: string;
  readonly token: string;
  readonly source: ReasonSource;
}

/** 除外の理由（dist から抜き出せるが、相手の応答の理由ではない値）。 */
export type ExclusionWhy =
  /** hook の文脈の値（`ctx.reason` の比較・取り消しの通知）。応答の理由にならない */
  | "hook"
  /** client 側の状態の名前（`paymentStatus`） */
  | "status_label"
  /** 経路の設定の検査の結果（起動時。応答に載らない） */
  | "route_config"
  /** 比較の相手としてだけ現れる（値の持ち主は別の節） */
  | "comparison"
  /** 内部の状態（batch-settlement の server の `status`） */
  | "internal_status"
  /** client 側の例外の文の材料（応答の理由ではない） */
  | "client_message"
  /** 部分一致の検査の文字列 */
  | "substring"
  /** program の操作の名前 */
  | "program_action"
  /** PDA の seed */
  | "pda_seed"
  /** 型の検査・欄の名前など（facilitator・Worker のコードの literal） */
  | "not_a_reason";

export interface ReasonExclusion {
  readonly section: ReasonSection;
  readonly raw: string;
  readonly why: ExclusionWhy;
  readonly source: ReasonSource;
}

/**
 * manifest（人が確かめた一覧）。数: x402_core 6・x402_evm 118・x402_svm 83・circle 2・self_facilitator 54・provider_worker 14。
 * 同じ生の値が複数の節に現れてよい（token は必ず同じ。試験で固定）。
 */
export const REASON_MANIFEST = [
  // ── x402_core（@x402/core 2.28.0）。snake_case の値と、SDK の文 4 つ。
  { section: "x402_core", raw: "settlement_pending", token: "settlement_pending", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 673 } },
  { section: "x402_core", raw: "extension_echo_mismatch", token: "extension_echo_mismatch", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 1627 } },
  { section: "x402_core", raw: "Settlement failed", token: "sdk_settlement_failed", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 2043 } },
  { section: "x402_core", raw: "Payment required", token: "sdk_payment_required", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 2534 } },
  { section: "x402_core", raw: "No matching payment requirements", token: "sdk_no_matching_requirements", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 2560 } },
  { section: "x402_core", raw: "Payment verification failed", token: "sdk_payment_verification_failed", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 2665 } },
  // ── x402_evm（@x402/evm 2.28.0）。`var Err… = "…"` の全部と、upto の facilitator の `errorReason` の既定値。
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_channel_not_found", token: "invalid_batch_settlement_evm_channel_not_found", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 83 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_token_mismatch", token: "invalid_batch_settlement_evm_token_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 84 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_voucher_signature", token: "invalid_batch_settlement_evm_voucher_signature", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 85 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_cumulative_exceeds_balance", token: "invalid_batch_settlement_evm_cumulative_exceeds_balance", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 86 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_cumulative_below_claimed", token: "invalid_batch_settlement_evm_cumulative_below_claimed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 87 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_insufficient_balance", token: "invalid_batch_settlement_evm_insufficient_balance", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 88 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_deposit_transaction_failed", token: "invalid_batch_settlement_evm_deposit_transaction_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 89 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_claim_transaction_failed", token: "invalid_batch_settlement_evm_claim_transaction_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 90 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_settle_transaction_failed", token: "invalid_batch_settlement_evm_settle_transaction_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 91 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_scheme", token: "invalid_batch_settlement_evm_scheme", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 92 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_network_mismatch", token: "invalid_batch_settlement_evm_network_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 93 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_missing_eip712_domain", token: "invalid_batch_settlement_evm_missing_eip712_domain", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 94 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_payload_authorization_valid_before", token: "invalid_batch_settlement_evm_payload_authorization_valid_before", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 95 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_payload_authorization_valid_after", token: "invalid_batch_settlement_evm_payload_authorization_valid_after", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 96 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_receive_authorization_signature", token: "invalid_batch_settlement_evm_receive_authorization_signature", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 97 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_erc3009_authorization_required", token: "invalid_batch_settlement_evm_erc3009_authorization_required", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 98 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_refund_transaction_failed", token: "invalid_batch_settlement_evm_refund_transaction_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 99 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_payload_type", token: "invalid_batch_settlement_evm_payload_type", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 100 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_withdraw_delay_out_of_range", token: "invalid_batch_settlement_evm_withdraw_delay_out_of_range", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 101 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_channel_id_mismatch", token: "invalid_batch_settlement_evm_channel_id_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 102 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_channel_id_invalid", token: "invalid_batch_settlement_evm_channel_id_invalid", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 103 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_receiver_mismatch", token: "invalid_batch_settlement_evm_receiver_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 104 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_receiver_authorizer_mismatch", token: "invalid_batch_settlement_evm_receiver_authorizer_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 105 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_withdraw_delay_mismatch", token: "invalid_batch_settlement_evm_withdraw_delay_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 106 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_authorizer_address_mismatch", token: "invalid_batch_settlement_evm_authorizer_address_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 107 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_authorizer_not_configured", token: "invalid_batch_settlement_evm_authorizer_not_configured", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 108 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_deposit_simulation_failed", token: "invalid_batch_settlement_evm_deposit_simulation_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 109 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_deposit_below_min_deposit", token: "invalid_batch_settlement_evm_deposit_below_min_deposit", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 110 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_eip6492_factory_not_allowed", token: "invalid_batch_settlement_evm_eip6492_factory_not_allowed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 111 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_smart_wallet_deployment_failed", token: "invalid_batch_settlement_evm_smart_wallet_deployment_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 112 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_claim_simulation_failed", token: "invalid_batch_settlement_evm_claim_simulation_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 113 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_settle_simulation_failed", token: "invalid_batch_settlement_evm_settle_simulation_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 114 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_nothing_to_settle", token: "invalid_batch_settlement_evm_nothing_to_settle", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 115 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_refund_payload", token: "invalid_batch_settlement_evm_refund_payload", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 116 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_refund_simulation_failed", token: "invalid_batch_settlement_evm_refund_simulation_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 117 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_rpc_read_failed", token: "invalid_batch_settlement_evm_rpc_read_failed", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 118 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_permit2_authorization_required", token: "invalid_batch_settlement_evm_permit2_authorization_required", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 119 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_permit2_invalid_spender", token: "invalid_batch_settlement_evm_permit2_invalid_spender", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 120 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_permit2_amount_mismatch", token: "invalid_batch_settlement_evm_permit2_amount_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 121 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_permit2_deadline_expired", token: "invalid_batch_settlement_evm_permit2_deadline_expired", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 122 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_permit2_invalid_signature", token: "invalid_batch_settlement_evm_permit2_invalid_signature", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 123 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_permit2_allowance_required", token: "invalid_batch_settlement_evm_permit2_allowance_required", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 124 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_eip2612_amount_mismatch", token: "invalid_batch_settlement_evm_eip2612_amount_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 125 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_erc20_approval_unavailable", token: "invalid_batch_settlement_evm_erc20_approval_unavailable", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 126 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_cumulative_amount_mismatch", token: "invalid_batch_settlement_evm_cumulative_amount_mismatch", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 127 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_channel_busy", token: "invalid_batch_settlement_evm_channel_busy", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 128 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_verification_state_unavailable", token: "invalid_batch_settlement_evm_verification_state_unavailable", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 129 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_charge_exceeds_signed_cumulative", token: "invalid_batch_settlement_evm_charge_exceeds_signed_cumulative", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 130 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_missing_channel", token: "invalid_batch_settlement_evm_missing_channel", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 131 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_refund_no_balance", token: "invalid_batch_settlement_evm_refund_no_balance", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 132 } },
  { section: "x402_evm", raw: "invalid_batch_settlement_evm_refund_amount_invalid", token: "invalid_batch_settlement_evm_refund_amount_invalid", source: { file: "dist/esm/chunk-5XX3PMSD.mjs", line: 133 } },
  { section: "x402_evm", raw: "asset_not_deployed_contract", token: "asset_not_deployed_contract", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 2 } },
  { section: "x402_evm", raw: "invalid_exact_evm_scheme", token: "invalid_exact_evm_scheme", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 3 } },
  { section: "x402_evm", raw: "invalid_exact_evm_network_mismatch", token: "invalid_exact_evm_network_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 4 } },
  { section: "x402_evm", raw: "invalid_exact_evm_missing_eip712_domain", token: "invalid_exact_evm_missing_eip712_domain", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 5 } },
  { section: "x402_evm", raw: "invalid_exact_evm_recipient_mismatch", token: "invalid_exact_evm_recipient_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 6 } },
  { section: "x402_evm", raw: "invalid_exact_evm_signature", token: "invalid_exact_evm_signature", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 7 } },
  { section: "x402_evm", raw: "invalid_exact_evm_payload_authorization_valid_before", token: "invalid_exact_evm_payload_authorization_valid_before", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 8 } },
  { section: "x402_evm", raw: "invalid_exact_evm_payload_authorization_valid_after", token: "invalid_exact_evm_payload_authorization_valid_after", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 9 } },
  { section: "x402_evm", raw: "invalid_exact_evm_authorization_value", token: "invalid_exact_evm_authorization_value", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 10 } },
  { section: "x402_evm", raw: "invalid_exact_evm_payload_authorization_value_mismatch", token: "invalid_exact_evm_payload_authorization_value_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 11 } },
  { section: "x402_evm", raw: "invalid_exact_evm_transaction_failed", token: "invalid_exact_evm_transaction_failed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 12 } },
  { section: "x402_evm", raw: "invalid_exact_evm_transfer_event_mismatch", token: "invalid_exact_evm_transfer_event_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 13 } },
  { section: "x402_evm", raw: "invalid_exact_evm_token_name_mismatch", token: "invalid_exact_evm_token_name_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 14 } },
  { section: "x402_evm", raw: "invalid_exact_evm_token_version_mismatch", token: "invalid_exact_evm_token_version_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 15 } },
  { section: "x402_evm", raw: "invalid_exact_evm_eip3009_not_supported", token: "invalid_exact_evm_eip3009_not_supported", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 16 } },
  { section: "x402_evm", raw: "invalid_exact_evm_nonce_already_used", token: "invalid_exact_evm_nonce_already_used", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 17 } },
  { section: "x402_evm", raw: "invalid_exact_evm_insufficient_balance", token: "invalid_exact_evm_insufficient_balance", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 18 } },
  { section: "x402_evm", raw: "invalid_exact_evm_transaction_simulation_failed", token: "invalid_exact_evm_transaction_simulation_failed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 19 } },
  { section: "x402_evm", raw: "invalid_permit2_spender", token: "invalid_permit2_spender", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 20 } },
  { section: "x402_evm", raw: "invalid_permit2_recipient_mismatch", token: "invalid_permit2_recipient_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 21 } },
  { section: "x402_evm", raw: "permit2_deadline_expired", token: "permit2_deadline_expired", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 22 } },
  { section: "x402_evm", raw: "permit2_not_yet_valid", token: "permit2_not_yet_valid", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 23 } },
  { section: "x402_evm", raw: "permit2_amount_mismatch", token: "permit2_amount_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 24 } },
  { section: "x402_evm", raw: "permit2_token_mismatch", token: "permit2_token_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 25 } },
  { section: "x402_evm", raw: "invalid_permit2_signature", token: "invalid_permit2_signature", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 26 } },
  { section: "x402_evm", raw: "permit2_allowance_required", token: "permit2_allowance_required", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 27 } },
  { section: "x402_evm", raw: "permit2_simulation_failed", token: "permit2_simulation_failed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 28 } },
  { section: "x402_evm", raw: "permit2_insufficient_balance", token: "permit2_insufficient_balance", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 29 } },
  { section: "x402_evm", raw: "permit2_proxy_not_deployed", token: "permit2_proxy_not_deployed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 30 } },
  { section: "x402_evm", raw: "permit2_invalid_amount", token: "permit2_invalid_amount", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 31 } },
  { section: "x402_evm", raw: "permit2_invalid_destination", token: "permit2_invalid_destination", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 32 } },
  { section: "x402_evm", raw: "permit2_invalid_owner", token: "permit2_invalid_owner", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 33 } },
  { section: "x402_evm", raw: "permit2_payment_too_early", token: "permit2_payment_too_early", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 34 } },
  { section: "x402_evm", raw: "permit2_invalid_nonce", token: "permit2_invalid_nonce", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 35 } },
  { section: "x402_evm", raw: "permit2_2612_amount_mismatch", token: "permit2_2612_amount_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 36 } },
  { section: "x402_evm", raw: "invalid_erc20_approval_extension_format", token: "invalid_erc20_approval_extension_format", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 37 } },
  { section: "x402_evm", raw: "erc20_approval_from_mismatch", token: "erc20_approval_from_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 38 } },
  { section: "x402_evm", raw: "erc20_approval_asset_mismatch", token: "erc20_approval_asset_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 39 } },
  { section: "x402_evm", raw: "erc20_approval_spender_not_permit2", token: "erc20_approval_spender_not_permit2", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 40 } },
  { section: "x402_evm", raw: "erc20_approval_tx_wrong_target", token: "erc20_approval_tx_wrong_target", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 41 } },
  { section: "x402_evm", raw: "erc20_approval_tx_wrong_selector", token: "erc20_approval_tx_wrong_selector", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 42 } },
  { section: "x402_evm", raw: "erc20_approval_tx_wrong_spender", token: "erc20_approval_tx_wrong_spender", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 43 } },
  { section: "x402_evm", raw: "erc20_approval_tx_invalid_calldata", token: "erc20_approval_tx_invalid_calldata", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 44 } },
  { section: "x402_evm", raw: "erc20_approval_tx_signer_mismatch", token: "erc20_approval_tx_signer_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 45 } },
  { section: "x402_evm", raw: "erc20_approval_tx_invalid_signature", token: "erc20_approval_tx_invalid_signature", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 46 } },
  { section: "x402_evm", raw: "erc20_approval_tx_parse_failed", token: "erc20_approval_tx_parse_failed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 47 } },
  { section: "x402_evm", raw: "erc20_approval_tx_failed", token: "erc20_approval_tx_failed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 48 } },
  { section: "x402_evm", raw: "erc20_approval_broadcast_failed", token: "erc20_approval_broadcast_failed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 49 } },
  { section: "x402_evm", raw: "invalid_eip2612_extension_format", token: "invalid_eip2612_extension_format", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 50 } },
  { section: "x402_evm", raw: "eip2612_from_mismatch", token: "eip2612_from_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 51 } },
  { section: "x402_evm", raw: "eip2612_asset_mismatch", token: "eip2612_asset_mismatch", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 52 } },
  { section: "x402_evm", raw: "eip2612_spender_not_permit2", token: "eip2612_spender_not_permit2", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 53 } },
  { section: "x402_evm", raw: "eip2612_deadline_expired", token: "eip2612_deadline_expired", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 54 } },
  { section: "x402_evm", raw: "invalid_exact_evm_failed_to_parse_signature", token: "invalid_exact_evm_failed_to_parse_signature", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 55 } },
  { section: "x402_evm", raw: "unsupported_payload_type", token: "unsupported_payload_type", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 56 } },
  { section: "x402_evm", raw: "invalid_transaction_state", token: "invalid_transaction_state", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 57 } },
  { section: "x402_evm", raw: "eip6492_factory_not_allowed", token: "eip6492_factory_not_allowed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 58 } },
  { section: "x402_evm", raw: "smart_wallet_deployment_failed", token: "smart_wallet_deployment_failed", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 59 } },
  { section: "x402_evm", raw: "settlement_pending", token: "settlement_pending", source: { file: "dist/esm/chunk-VEDHRFNU.mjs", line: 60 } },
  { section: "x402_evm", raw: "invalid_upto_evm_transaction_failed", token: "invalid_upto_evm_transaction_failed", source: { file: "dist/esm/chunk-XP6HEYCL.mjs", line: 160 } },
  { section: "x402_evm", raw: "invalid_upto_evm_scheme", token: "invalid_upto_evm_scheme", source: { file: "dist/esm/chunk-XP6HEYCL.mjs", line: 161 } },
  { section: "x402_evm", raw: "invalid_upto_evm_network_mismatch", token: "invalid_upto_evm_network_mismatch", source: { file: "dist/esm/chunk-XP6HEYCL.mjs", line: 162 } },
  { section: "x402_evm", raw: "invalid_upto_evm_payload_settlement_exceeds_amount", token: "invalid_upto_evm_payload_settlement_exceeds_amount", source: { file: "dist/esm/chunk-XP6HEYCL.mjs", line: 163 } },
  { section: "x402_evm", raw: "upto_amount_exceeds_permitted", token: "upto_amount_exceeds_permitted", source: { file: "dist/esm/chunk-XP6HEYCL.mjs", line: 164 } },
  { section: "x402_evm", raw: "upto_unauthorized_facilitator", token: "upto_unauthorized_facilitator", source: { file: "dist/esm/chunk-XP6HEYCL.mjs", line: 165 } },
  { section: "x402_evm", raw: "upto_facilitator_mismatch", token: "upto_facilitator_mismatch", source: { file: "dist/esm/chunk-XP6HEYCL.mjs", line: 166 } },
  { section: "x402_evm", raw: "invalid_scheme", token: "invalid_scheme", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 308 } },
  // ── x402_svm（x402 の SVM の実装 2.28.0）。`var Err…`・`var ERR_…` の全部、`invalidReason`・`errorReason` の literal、`settleFailure`・`verifyFailure`・`failure.reason` の literal、例外の文として投げてから理由になる literal。
  { section: "x402_svm", raw: "duplicate_settlement", token: "duplicate_settlement", source: { file: "dist/esm/batch-settlement/facilitator/index.mjs", line: 186 } },
  { section: "x402_svm", raw: "transaction_failed", token: "transaction_failed", source: { file: "dist/esm/batch-settlement/facilitator/index.mjs", line: 306 } },
  { section: "x402_svm", raw: "unsupported_scheme", token: "unsupported_scheme", source: { file: "dist/esm/batch-settlement/facilitator/index.mjs", line: 812 } },
  { section: "x402_svm", raw: "network_mismatch", token: "network_mismatch", source: { file: "dist/esm/batch-settlement/facilitator/index.mjs", line: 815 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_missing_fee_payer", token: "invalid_exact_svm_payload_missing_fee_payer", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 144 } },
  { section: "x402_svm", raw: "fee_payer_not_managed_by_facilitator", token: "fee_payer_not_managed_by_facilitator", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 152 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction_could_not_be_decoded", token: "invalid_exact_svm_payload_transaction_could_not_be_decoded", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 162 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction_instructions_length", token: "invalid_exact_svm_payload_transaction_instructions_length", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 202 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_no_transfer_instruction", token: "invalid_exact_svm_payload_no_transfer_instruction", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 221 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds", token: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 260 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_mint_mismatch", token: "invalid_exact_svm_payload_mint_mismatch", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 268 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_recipient_mismatch", token: "invalid_exact_svm_payload_recipient_mismatch", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 282 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_amount_mismatch", token: "invalid_exact_svm_payload_amount_mismatch", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 297 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_unknown_fourth_instruction", token: "invalid_exact_svm_payload_unknown_fourth_instruction", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 303 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_unknown_fifth_instruction", token: "invalid_exact_svm_payload_unknown_fifth_instruction", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 304 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_unknown_sixth_instruction", token: "invalid_exact_svm_payload_unknown_sixth_instruction", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 305 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_unknown_optional_instruction", token: "invalid_exact_svm_payload_unknown_optional_instruction", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 314 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_memo_count", token: "invalid_exact_svm_payload_memo_count", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 326 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_memo_mismatch", token: "invalid_exact_svm_payload_memo_mismatch", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 335 } },
  { section: "x402_svm", raw: "transaction_simulation_failed", token: "transaction_simulation_failed", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 346 } },
  { section: "x402_svm", raw: "verification_failed", token: "verification_failed", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 400 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction", token: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 446 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction", token: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 468 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high", token: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 475 } },
  { section: "x402_svm", raw: "invalid_exact_svm_unsupported_scheme", token: "invalid_exact_svm_unsupported_scheme", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 43 } },
  { section: "x402_svm", raw: "invalid_exact_svm_network_mismatch", token: "invalid_exact_svm_network_mismatch", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 44 } },
  { section: "x402_svm", raw: "invalid_exact_svm_fee_payer_not_managed_by_facilitator", token: "invalid_exact_svm_fee_payer_not_managed_by_facilitator", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 46 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction", token: "invalid_exact_svm_payload_transaction", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 47 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_signature_invalid", token: "invalid_exact_svm_payload_signature_invalid", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 49 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_excessive_signers", token: "invalid_exact_svm_payload_excessive_signers", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 50 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high", token: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 52 } },
  { section: "x402_svm", raw: "invalid_exact_svm_payload_unknown_seventh_instruction", token: "invalid_exact_svm_payload_unknown_seventh_instruction", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 56 } },
  { section: "x402_svm", raw: "invalid_exact_svm_transaction_simulation_failed", token: "invalid_exact_svm_transaction_simulation_failed", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 66 } },
  { section: "x402_svm", raw: "invalid_exact_svm_verification_failed", token: "invalid_exact_svm_verification_failed", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 69 } },
  { section: "x402_svm", raw: "invalid_exact_svm_fee_payer_mismatch", token: "invalid_exact_svm_fee_payer_mismatch", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 70 } },
  { section: "x402_svm", raw: "invalid_exact_svm_transaction_failed", token: "invalid_exact_svm_transaction_failed", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 71 } },
  { section: "x402_svm", raw: "post_settlement_transfer_not_confirmed", token: "post_settlement_transfer_not_confirmed", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 73 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_fee_payer_not_isolated", token: "invalid_exact_svm_smart_wallet_fee_payer_not_isolated", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 74 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_malformed_compute_budget", token: "invalid_exact_svm_smart_wallet_malformed_compute_budget", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 75 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_malformed_compute_limit", token: "invalid_exact_svm_smart_wallet_malformed_compute_limit", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 76 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_malformed_compute_price", token: "invalid_exact_svm_smart_wallet_malformed_compute_price", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 77 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_compute_units_too_high", token: "invalid_exact_svm_smart_wallet_compute_units_too_high", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 78 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_priority_fee_too_high", token: "invalid_exact_svm_smart_wallet_priority_fee_too_high", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 79 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_unsupported_compute_budget_instruction", token: "invalid_exact_svm_smart_wallet_unsupported_compute_budget_instruction", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 80 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_alt_resolution_not_available", token: "invalid_exact_svm_smart_wallet_alt_resolution_not_available", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 81 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_alt_resolution_failed", token: "invalid_exact_svm_smart_wallet_alt_resolution_failed", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 82 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_compute_budget_violation", token: "invalid_exact_svm_smart_wallet_compute_budget_violation", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 83 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_simulation_failed", token: "invalid_exact_svm_smart_wallet_simulation_failed", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 84 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_cannot_derive_destination_ata", token: "invalid_exact_svm_smart_wallet_cannot_derive_destination_ata", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 85 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_no_transfer_in_simulation", token: "invalid_exact_svm_smart_wallet_no_transfer_in_simulation", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 86 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_transfer_mismatch", token: "invalid_exact_svm_smart_wallet_transfer_mismatch", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 87 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_multiple_matching_transfers", token: "invalid_exact_svm_smart_wallet_multiple_matching_transfers", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 88 } },
  { section: "x402_svm", raw: "invalid_exact_svm_smart_wallet_program_not_allowed", token: "invalid_exact_svm_smart_wallet_program_not_allowed", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 89 } },
  { section: "x402_svm", raw: "settlement_pending", token: "settlement_pending", source: { file: "dist/esm/chunk-RXPBSPMZ.mjs", line: 90 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_settlement_exceeds_amount", token: "invalid_upto_svm_payload_settlement_exceeds_amount", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 85 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_unexpected_voucher", token: "invalid_upto_svm_payload_unexpected_voucher", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 86 } },
  { section: "x402_svm", raw: "invalid_upto_svm_channel_already_open", token: "invalid_upto_svm_channel_already_open", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 87 } },
  { section: "x402_svm", raw: "invalid_upto_svm_channel_broadcast", token: "invalid_upto_svm_channel_broadcast", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 88 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_channel_lifetime_exceeded", token: "invalid_upto_svm_payload_channel_lifetime_exceeded", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 89 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_expires_at_mismatch", token: "invalid_upto_svm_payload_expires_at_mismatch", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 90 } },
  { section: "x402_svm", raw: "invalid_upto_svm_authorizer_not_configured", token: "invalid_upto_svm_authorizer_not_configured", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 91 } },
  { section: "x402_svm", raw: "invalid_upto_svm_authorizer_address_mismatch", token: "invalid_upto_svm_authorizer_address_mismatch", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 92 } },
  { section: "x402_svm", raw: "invalid_upto_svm_delegated_settle_unauthenticated", token: "invalid_upto_svm_delegated_settle_unauthenticated", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 93 } },
  { section: "x402_svm", raw: "invalid_upto_svm_delegated_auth_store", token: "invalid_upto_svm_delegated_auth_store", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 94 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_type", token: "invalid_upto_svm_payload_type", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 95 } },
  { section: "x402_svm", raw: "unsupported_payload_type", token: "unsupported_payload_type", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 236 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_amount", token: "invalid_upto_svm_payload_amount", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 251 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_missing_voucher", token: "invalid_upto_svm_payload_missing_voucher", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 276 } },
  { section: "x402_svm", raw: "invalid_upto_svm_settlement_simulation", token: "invalid_upto_svm_settlement_simulation", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 455 } },
  { section: "x402_svm", raw: "invalid_upto_svm_channel_state", token: "invalid_upto_svm_channel_state", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 538 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payment_requirements", token: "invalid_upto_svm_payment_requirements", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 628 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_receiver_authorizer", token: "invalid_upto_svm_payload_receiver_authorizer", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 634 } },
  { section: "x402_svm", raw: "facilitator_mismatch", token: "facilitator_mismatch", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 638 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_not_yet_active", token: "invalid_upto_svm_payload_not_yet_active", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 642 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_expired", token: "invalid_upto_svm_payload_expired", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 645 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_voucher_signature", token: "invalid_upto_svm_payload_voucher_signature", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 663 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_amount_mismatch", token: "invalid_upto_svm_payload_amount_mismatch", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 872 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_deposit_not_ceiling", token: "invalid_upto_svm_payload_deposit_not_ceiling", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 878 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_channel_seed", token: "invalid_upto_svm_payload_channel_seed", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 899 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_payer_mismatch", token: "invalid_upto_svm_payload_payer_mismatch", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 961 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_channel_id", token: "invalid_upto_svm_payload_channel_id", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 1027 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_nonce", token: "invalid_upto_svm_payload_nonce", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 1037 } },
  { section: "x402_svm", raw: "invalid_upto_svm_payload_open_transaction", token: "invalid_upto_svm_payload_open_transaction", source: { file: "dist/esm/upto/facilitator/index.mjs", line: 1057 } },
  // ── circle（Circle の facilitator。このリポジトリが読む値・観測の記録）。
  { section: "circle", raw: "registration_required", token: "registration_required", source: { file: "src/adapters/inbound/x402.ts", line: 427 } },
  { section: "circle", raw: "settlement_pending", token: "settlement_pending", source: { file: "docs/multirail-design.md", line: 218 } },
  // ── self_facilitator（tools/evm-facilitator.ts の `fail`・`failure`・`refuseIfStillUnused`・`invalidReason`・`error` と送出の前の時間の検査）。
  { section: "self_facilitator", raw: "malformed_request", token: "malformed_request", source: { file: "tools/evm-facilitator.ts", line: 358 } },
  { section: "self_facilitator", raw: "unsupported_x402_version", token: "unsupported_x402_version", source: { file: "tools/evm-facilitator.ts", line: 359 } },
  { section: "self_facilitator", raw: "network_not_enabled", token: "network_not_enabled", source: { file: "tools/evm-facilitator.ts", line: 365 } },
  { section: "self_facilitator", raw: "asset_not_in_table", token: "asset_not_in_table", source: { file: "tools/evm-facilitator.ts", line: 368 } },
  { section: "self_facilitator", raw: "malformed_payload", token: "malformed_payload", source: { file: "tools/evm-facilitator.ts", line: 370 } },
  { section: "self_facilitator", raw: "malformed_authorization", token: "malformed_authorization", source: { file: "tools/evm-facilitator.ts", line: 375 } },
  { section: "self_facilitator", raw: "unsupported_scheme", token: "unsupported_scheme", source: { file: "tools/evm-facilitator.ts", line: 399 } },
  { section: "self_facilitator", raw: "missing_eip712_domain", token: "missing_eip712_domain", source: { file: "tools/evm-facilitator.ts", line: 404 } },
  { section: "self_facilitator", raw: "eip712_domain_mismatch", token: "eip712_domain_mismatch", source: { file: "tools/evm-facilitator.ts", line: 405 } },
  { section: "self_facilitator", raw: "unexpected_extra_key", token: "unexpected_extra_key", source: { file: "tools/evm-facilitator.ts", line: 406 } },
  { section: "self_facilitator", raw: "unsupported_transfer_method", token: "unsupported_transfer_method", source: { file: "tools/evm-facilitator.ts", line: 407 } },
  { section: "self_facilitator", raw: "unexpected_payload_key", token: "unexpected_payload_key", source: { file: "tools/evm-facilitator.ts", line: 409 } },
  { section: "self_facilitator", raw: "extensions_not_supported", token: "extensions_not_supported", source: { file: "tools/evm-facilitator.ts", line: 411 } },
  { section: "self_facilitator", raw: "network_mismatch", token: "network_mismatch", source: { file: "tools/evm-facilitator.ts", line: 413 } },
  { section: "self_facilitator", raw: "challenge_nonce_mismatch", token: "challenge_nonce_mismatch", source: { file: "tools/evm-facilitator.ts", line: 416 } },
  { section: "self_facilitator", raw: "unsupported_signature", token: "unsupported_signature", source: { file: "tools/evm-facilitator.ts", line: 417 } },
  { section: "self_facilitator", raw: "amount_out_of_range", token: "amount_out_of_range", source: { file: "tools/evm-facilitator.ts", line: 419 } },
  { section: "self_facilitator", raw: "value_mismatch", token: "value_mismatch", source: { file: "tools/evm-facilitator.ts", line: 420 } },
  { section: "self_facilitator", raw: "recipient_mismatch", token: "recipient_mismatch", source: { file: "tools/evm-facilitator.ts", line: 422 } },
  { section: "self_facilitator", raw: "recipient_not_allowed", token: "recipient_not_allowed", source: { file: "tools/evm-facilitator.ts", line: 423 } },
  { section: "self_facilitator", raw: "accepted_mismatch", token: "accepted_mismatch", source: { file: "tools/evm-facilitator.ts", line: 424 } },
  { section: "self_facilitator", raw: "valid_before_too_soon", token: "valid_before_too_soon", source: { file: "tools/evm-facilitator.ts", line: 425 } },
  { section: "self_facilitator", raw: "rpc_unavailable", token: "rpc_unavailable", source: { file: "tools/evm-facilitator.ts", line: 788 } },
  { section: "self_facilitator", raw: "authorization_used_unmatched", token: "authorization_used_unmatched", source: { file: "tools/evm-facilitator.ts", line: 802 } },
  { section: "self_facilitator", raw: "queue_full", token: "queue_full", source: { file: "tools/evm-facilitator.ts", line: 827 } },
  { section: "self_facilitator", raw: "queue_timeout", token: "queue_timeout", source: { file: "tools/evm-facilitator.ts", line: 832 } },
  { section: "self_facilitator", raw: "network_held", token: "network_held", source: { file: "tools/evm-facilitator.ts", line: 614 } },
  { section: "self_facilitator", raw: "verify_unavailable", token: "verify_unavailable", source: { file: "tools/evm-facilitator.ts", line: 878 } },
  // R-0: 停止の drain の間の新しい要求への 503（`tools/evm-facilitator.ts` の drain）。
  { section: "self_facilitator", raw: "draining", token: "draining", source: { file: "tools/evm-facilitator.ts", line: 1228 } },
  { section: "self_facilitator", raw: "invalid_payment", token: "invalid_payment", source: { file: "tools/evm-facilitator.ts", line: 878 } },
  { section: "self_facilitator", raw: "gas_estimate_unavailable", token: "gas_estimate_unavailable", source: { file: "tools/evm-facilitator.ts", line: 895 } },
  { section: "self_facilitator", raw: "gas_limit_too_high", token: "gas_limit_too_high", source: { file: "tools/evm-facilitator.ts", line: 899 } },
  { section: "self_facilitator", raw: "fee_estimate_unavailable", token: "fee_estimate_unavailable", source: { file: "tools/evm-facilitator.ts", line: 906 } },
  { section: "self_facilitator", raw: "fee_too_high", token: "fee_too_high", source: { file: "tools/evm-facilitator.ts", line: 908 } },
  { section: "self_facilitator", raw: "gas_cap_reached", token: "gas_cap_reached", source: { file: "tools/evm-facilitator.ts", line: 913 } },
  { section: "self_facilitator", raw: "request_cancelled", token: "request_cancelled", source: { file: "tools/evm-facilitator.ts", line: 920 } },
  { section: "self_facilitator", raw: "insufficient_time_before_broadcast", token: "insufficient_time_before_broadcast", source: { file: "tools/evm-facilitator.ts", line: 921 } },
  { section: "self_facilitator", raw: "journal_timeout", token: "journal_timeout", source: { file: "tools/evm-facilitator.ts", line: 955 } },
  { section: "self_facilitator", raw: "journal_unavailable", token: "journal_unavailable", source: { file: "tools/evm-facilitator.ts", line: 955 } },
  { section: "self_facilitator", raw: "send_outcome_unknown", token: "send_outcome_unknown", source: { file: "tools/evm-facilitator.ts", line: 981 } },
  { section: "self_facilitator", raw: "receipt_timeout", token: "receipt_timeout", source: { file: "tools/evm-facilitator.ts", line: 1010 } },
  { section: "self_facilitator", raw: "transaction_reverted", token: "transaction_reverted", source: { file: "tools/evm-facilitator.ts", line: 1023 } },
  { section: "self_facilitator", raw: "transfer_mismatch", token: "transfer_mismatch", source: { file: "tools/evm-facilitator.ts", line: 1026 } },
  { section: "self_facilitator", raw: "fingerprint_conflict", token: "fingerprint_conflict", source: { file: "tools/evm-facilitator.ts", line: 1052 } },
  { section: "self_facilitator", raw: "submission_unresolved", token: "submission_unresolved", source: { file: "tools/evm-facilitator.ts", line: 1058 } },
  { section: "self_facilitator", raw: "submission_reverted", token: "submission_reverted", source: { file: "tools/evm-facilitator.ts", line: 1060 } },
  { section: "self_facilitator", raw: "resolved_by_operator", token: "resolved_by_operator", source: { file: "tools/evm-facilitator.ts", line: 258 } },
  { section: "self_facilitator", raw: "internal_error", token: "internal_error", source: { file: "tools/evm-facilitator.ts", line: 1082 } },
  { section: "self_facilitator", raw: "starting", token: "starting", source: { file: "tools/evm-facilitator.ts", line: 1196 } },
  { section: "self_facilitator", raw: "forbidden", token: "forbidden", source: { file: "tools/evm-facilitator.ts", line: 1197 } },
  { section: "self_facilitator", raw: "not_found", token: "not_found", source: { file: "tools/evm-facilitator.ts", line: 1201 } },
  { section: "self_facilitator", raw: "method_not_allowed", token: "method_not_allowed", source: { file: "tools/evm-facilitator.ts", line: 1205 } },
  { section: "self_facilitator", raw: "unsupported_media_type", token: "unsupported_media_type", source: { file: "tools/evm-facilitator.ts", line: 1211 } },
  { section: "self_facilitator", raw: "payload_too_large", token: "payload_too_large", source: { file: "tools/evm-facilitator.ts", line: 1212 } },
  // ── provider_worker（providers/x402-workers/src。402 の `error`・PAYMENT-REQUIRED の `error`・502/503/500 の固定の token）。
  { section: "provider_worker", raw: "payment_invalid", token: "payment_invalid", source: { file: "providers/x402-workers/src/index.ts", line: 78 } },
  { section: "provider_worker", raw: "no_matching_requirements", token: "no_matching_requirements", source: { file: "providers/x402-workers/src/index.ts", line: 149 } },
  { section: "provider_worker", raw: "internal", token: "internal", source: { file: "providers/x402-workers/src/index.ts", line: 82 } },
  { section: "provider_worker", raw: "data_unavailable", token: "data_unavailable", source: { file: "providers/x402-workers/src/index.ts", line: 159 } },
  { section: "provider_worker", raw: "provider_busy", token: "provider_busy", source: { file: "providers/x402-workers/src/index.ts", line: 175 } },
  { section: "provider_worker", raw: "not_found", token: "not_found", source: { file: "providers/x402-workers/src/index.ts", line: 96 } },
  { section: "provider_worker", raw: "method_not_allowed", token: "method_not_allowed", source: { file: "providers/x402-workers/src/index.ts", line: 97 } },
  { section: "provider_worker", raw: "facilitator_unavailable", token: "facilitator_unavailable", source: { file: "providers/x402-workers/src/index.ts", line: 83 } },
  { section: "provider_worker", raw: "misconfigured", token: "misconfigured", source: { file: "providers/x402-workers/src/index.ts", line: 201 } },
  { section: "provider_worker", raw: "facilitator_registration_required", token: "facilitator_registration_required", source: { file: "providers/x402-workers/src/facilitator-client.ts", line: 16 } },
  { section: "provider_worker", raw: "receipt_malformed", token: "receipt_malformed", source: { file: "providers/x402-workers/src/receipt.ts", line: 13 } },
  { section: "provider_worker", raw: "settlement_pending", token: "settlement_pending", source: { file: "providers/x402-workers/src/receipt.ts", line: 13 } },
  { section: "provider_worker", raw: "settle_failed", token: "settle_failed", source: { file: "providers/x402-workers/src/receipt.ts", line: 13 } },
  { section: "provider_worker", raw: "Payment required", token: "sdk_payment_required", source: { file: "providers/x402-workers/src/requirements.ts", line: 113 } },
] as const satisfies readonly ReasonEntry[];

/** 表の token（manifest の token の literal の union）。 */
export type ReasonToken = (typeof REASON_MANIFEST)[number]["token"];

/** 分類の結果: 表の token か、`absent`（欄が無い）・`malformed`（文字列でない・空）・`unrecognized`（表に無い）。 */
export type ReasonClass = ReasonToken | "absent" | "malformed" | "unrecognized";

/**
 * 明示の除外の一覧: 抜き出しの規則（照合の試験）で見つかるが、相手の応答の理由ではない値。
 * これに載る値は `classifyReason` で `unrecognized` になる（manifest に同じ値があればそちら）。
 */
export const REASON_EXCLUSIONS: readonly ReasonExclusion[] = Object.freeze([
  { section: "x402_core", raw: "after_verify_aborted", why: "hook", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 1796 } },
  { section: "x402_core", raw: "payment_required", why: "status_label", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 2261 } },
  { section: "x402_core", raw: "settle_failed", why: "status_label", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 2264 } },
  { section: "x402_core", raw: "missing_scheme", why: "route_config", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 2998 } },
  { section: "x402_core", raw: "unsupported_asset_transfer_method", why: "route_config", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 3010 } },
  { section: "x402_core", raw: "unsupported_payment_flow", why: "route_config", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 3030 } },
  { section: "x402_core", raw: "missing_facilitator", why: "route_config", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 3047 } },
  { section: "x402_core", raw: "permit2_allowance_required", why: "comparison", source: { file: "dist/esm/chunk-FV2JN4FK.mjs", line: 3120 } },
  { section: "x402_evm", raw: "handler_threw", why: "hook", source: { file: "dist/esm/batch-settlement/server/index.mjs", line: 1018 } },
  { section: "x402_evm", raw: "handler_failed", why: "hook", source: { file: "dist/esm/batch-settlement/server/index.mjs", line: 1018 } },
  { section: "x402_evm", raw: "after_verify_aborted", why: "hook", source: { file: "dist/esm/batch-settlement/server/index.mjs", line: 1018 } },
  { section: "x402_evm", raw: "pending_mismatch", why: "internal_status", source: { file: "dist/esm/batch-settlement/server/index.mjs", line: 1144 } },
  { section: "x402_evm", raw: "cap_exceeded", why: "internal_status", source: { file: "dist/esm/batch-settlement/server/index.mjs", line: 1149 } },
  { section: "x402_evm", raw: "unknown_settlement_error", why: "client_message", source: { file: "dist/esm/chunk-QJHO4KEV.mjs", line: 625 } },
  { section: "x402_svm", raw: "too_high", why: "substring", source: { file: "dist/esm/chunk-3F2QC6NG.mjs", line: 479 } },
  { section: "x402_svm", raw: "abandon_close", why: "program_action", source: { file: "dist/esm/chunk-UMK65UDR.mjs", line: 880 } },
  { section: "x402_svm", raw: "forced_close", why: "program_action", source: { file: "dist/esm/chunk-UMK65UDR.mjs", line: 880 } },
  { section: "x402_svm", raw: "event_authority", why: "pda_seed", source: { file: "dist/esm/chunk-XUXHO7LW.mjs", line: 131 } },
  { section: "x402_svm", raw: "top_up", why: "program_action", source: { file: "dist/esm/chunk-XUXHO7LW.mjs", line: 1180 } },
  { section: "x402_svm", raw: "handler_failed", why: "hook", source: { file: "dist/esm/upto/server/index.mjs", line: 70 } },
  { section: "x402_svm", raw: "handler_threw", why: "hook", source: { file: "dist/esm/upto/server/index.mjs", line: 70 } },
  { section: "x402_svm", raw: "after_verify_aborted", why: "hook", source: { file: "dist/esm/upto/server/index.mjs", line: 70 } },
  { section: "self_facilitator", raw: "accepted", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 450 } },
  { section: "self_facilitator", raw: "eip3009", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 433 } },
  { section: "self_facilitator", raw: "exact", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 425 } },
  { section: "self_facilitator", raw: "host", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 1471 } },
  { section: "self_facilitator", raw: "name", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 431 } },
  { section: "self_facilitator", raw: "network", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 439 } },
  { section: "self_facilitator", raw: "origin", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 1470 } },
  { section: "self_facilitator", raw: "scheme", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 425 } },
  { section: "self_facilitator", raw: "settle", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 1481 } },
  { section: "self_facilitator", raw: "string", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 391 } },
  { section: "self_facilitator", raw: "utf8", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 1498 } },
  { section: "self_facilitator", raw: "verify", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 1481 } },
  { section: "self_facilitator", raw: "version", why: "not_a_reason", source: { file: "tools/evm-facilitator.ts", line: 431 } },
  { section: "provider_worker", raw: "settle", why: "not_a_reason", source: { file: "providers/x402-workers/src/index.ts", line: 81 } },
  { section: "provider_worker", raw: "verify", why: "not_a_reason", source: { file: "providers/x402-workers/src/index.ts", line: 81 } },
  { section: "provider_worker", raw: "boolean", why: "not_a_reason", source: { file: "providers/x402-workers/src/facilitator-client.ts", line: 163 } },
  { section: "provider_worker", raw: "kinds", why: "not_a_reason", source: { file: "providers/x402-workers/src/facilitator-client.ts", line: 191 } },
  { section: "provider_worker", raw: "success", why: "not_a_reason", source: { file: "providers/x402-workers/src/facilitator-client.ts", line: 174 } },
  { section: "provider_worker", raw: "registration_required", why: "comparison", source: { file: "providers/x402-workers/src/facilitator-client.ts", line: 162 } },
  { section: "provider_worker", raw: "string", why: "not_a_reason", source: { file: "providers/x402-workers/src/receipt.ts", line: 66 } },
]);

/** 生の値 → token（完全一致）。同じ生の値の重複は同じ token（試験で固定）。 */
export const REASON_TABLE: ReadonlyMap<string, ReasonToken> = new Map(REASON_MANIFEST.map((entry) => [entry.raw, entry.token] as const));

/** 表の token の集合（`validateDiagRecord` が `reason` の値を縛る）。 */
export const REASON_TOKENS: ReadonlySet<string> = new Set<string>(REASON_MANIFEST.map((entry) => entry.token));

/**
 * 生の値を分類する。欄が無い・`undefined`・`null` → `absent`。文字列でない・空 → `malformed`。表にあれば token、無ければ `unrecognized`。
 * 前方一致・部分一致・大文字小文字の読み替え・前後の空白の除去はしない。
 */
export function classifyReason(raw: unknown): ReasonClass {
  if (raw === undefined || raw === null) return "absent";
  if (typeof raw !== "string" || raw === "") return "malformed";
  return REASON_TABLE.get(raw) ?? "unrecognized";
}
