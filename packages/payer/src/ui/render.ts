import { render, sanitize, type ApprovalRecord } from "../daemon/record.js";
/** The same deterministic record text used by inspection; no upstream prose. */
export function renderConfirmation(record: ApprovalRecord, phrase: string): string {
  return `${sanitize(phrase)}\n${render(record)}`;
}
