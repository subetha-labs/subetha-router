import type { Ledger } from "../store/ledger.js";
import type { Session } from "./session.js";
import type { Handler, Listener } from "./server.js";
import type { Router } from "../router/client.js";

export interface ConfirmUi { available(): Promise<boolean> }
export interface SecretTty {
  readonly available: boolean;
  read(label: "Passphrase" | "Security phrase"): Promise<string>;
}
export interface FaultPoints { hit(point: "after:lock" | "before:seal" | "after:seal" | "before:key-decrypt"): Promise<void> }
export interface DaemonContext {
  readonly session: Session;
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
  readonly recover: (context: DaemonContext) => Promise<void>;
  readonly handler: (context: DaemonContext) => Handler;
  readonly listen: (path: string, handler: Handler) => Promise<Listener>;
}
