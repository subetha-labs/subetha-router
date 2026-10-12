import type { Ledger } from "../store/ledger.js";
import type { Session } from "./session.js";
import type { Handler, Listener } from "./server.js";
import type { Router } from "../router/client.js";

import type { ResourceIdentity } from "../router/identity.js";
import type { ApprovalRecord } from "./record.js";
export interface ConfirmUi {
  available(): Promise<boolean>;
  confirm?(record: ApprovalRecord, phrase: string): Promise<{ approved: true; recordHash: string; uiKind: "native" } | { approved: false }>;
}
/** Rail of the key that signs or pays: `eip155` (secp256k1: Base Sepolia, Arc, Tempo) or `solana` (ed25519 seed: Solana devnet). */
export type WalletRail = "eip155" | "solana";
/** Public addresses of the unlocked wallets (one per key rail present in the store). Never a secret. */
export type WalletAddresses = Readonly<Partial<Record<WalletRail, string>>>;
/**
 * Builds the inbound credential for an approved offer; the rail is decided from the offer (docs/payer-rails-design.md §2.3).
 * On MPP Tempo this call SENDS the transfer and returns its hash as `txRef`; on every other rail it only signs.
 * Any throw after a Tempo transfer may have moved funds: the caller records `unknown`, never retries.
 */
export interface SignResult { readonly credential: string; readonly txRef?: string }
export interface Signer { sign(offer: unknown): Promise<SignResult> }
export interface PurchaseContext {
  readonly routerUrl: string;
  readonly canonicalResource?: ResourceIdentity;
  readonly ui: ConfirmUi;
  readonly signer: Signer;
  /** Internal test seam; default is cryptographic 64-bit canonical base32. */
  readonly generateRef?: () => string;
  readonly faults?: FaultPoints;
}
export interface SecretTty {
  readonly available: boolean;
  read(label: "Passphrase" | "Security phrase"): Promise<string>;
  /** Fixed, secret-free guidance written to the terminal (stderr). */
  notice?(text: string): void;
}
export interface FaultPoints { hit(point: "after:lock" | "before:seal" | "after:seal" | "before:key-decrypt" | `before:${string}` | `after:${string}` | `during:${string}` | "transport:before-response" | "transport:after-response"): Promise<void> }
export interface DaemonContext {
  readonly session: Session;
  readonly purchase?: PurchaseContext;
  readonly ledger: Ledger;
  readonly router: Router;
  /** Public address of the EVM wallet (0.1.x field; equals `wallets.eip155`). */
  readonly address: string;
  /** Public addresses per key rail (docs/payer-rails-design.md §2.2). */
  readonly wallets: WalletAddresses;
  readonly phrase: string;
  assertHeld(): void;
}
/** Implementation dependencies, never CLI/env switches. Test implementations belong under test/. */
export interface DaemonHooks {
  readonly ui: ConfirmUi;
  /** Trusted composition hook: verifier is bound to this startup's validated keys document. */
  readonly createConfirmUi?: (verify: (passphrase: string) => boolean) => ConfirmUi;
  readonly tty: SecretTty;
  readonly faults?: FaultPoints;
  readonly configurePurchase?: (purchase: PurchaseContext) => PurchaseContext;
  readonly recover: (context: DaemonContext) => Promise<void>;
  readonly handler: (context: DaemonContext) => Handler;
  readonly listen: (path: string, handler: Handler) => Promise<Listener>;
}
