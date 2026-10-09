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
export interface Signer { sign(offer: unknown): Promise<string> }
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
}
export interface FaultPoints { hit(point: "after:lock" | "before:seal" | "after:seal" | "before:key-decrypt" | `before:${string}` | `after:${string}` | "transport:before-response" | "transport:after-response"): Promise<void> }
export interface DaemonContext {
  readonly session: Session;
  readonly purchase?: PurchaseContext;
  readonly ledger: Ledger;
  readonly router: Router;
  readonly address: string;
  readonly phrase: string;
  assertHeld(): void;
}
/** Implementation dependencies, never CLI/env switches. Test implementations belong under test/. */
export interface DaemonHooks {
  readonly ui: ConfirmUi;
  readonly tty: SecretTty;
  readonly faults?: FaultPoints;
  readonly configurePurchase?: (purchase: PurchaseContext) => PurchaseContext;
  readonly recover: (context: DaemonContext) => Promise<void>;
  readonly handler: (context: DaemonContext) => Handler;
  readonly listen: (path: string, handler: Handler) => Promise<Listener>;
}
