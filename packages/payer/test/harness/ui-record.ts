import { randomUUID } from "node:crypto";
import { buildRecord } from "../../src/daemon/record.js";
import { h1Quote } from "./router.js";
export function uiRecord() {
  return buildRecord(h1Quote(), { routerUrl: "https://fixture.invalid/mcp", canonicalResource: { url: "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" }, address: `0x${"33".repeat(20)}`, ref: "p_aaaaaaaaaaaaa", requestId: randomUUID() });
}
