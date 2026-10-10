import { expect, test } from "vitest";
import { render as renderRecord, recordHash } from "../../src/daemon/record.js";
import { renderConfirmation } from "../../src/ui/render.js";
import { uiRecord } from "../harness/ui-record.js";
test("phrase first, immutable deterministic record renderer, complete static amounts and meanings", () => {
  const r = uiRecord(), hash = recordHash(r);
  const text = renderConfirmation(r, 'my\\"phrase');
  expect(text).toBe('my\\"phrase\n' + renderRecord(r));
  for (const value of [r.source.amount, r.source.asset, r.source.network, r.source.payTo, r.destination.quoted, r.destination.asset, r.destination.network, r.destination.payTo, new Date(r.approvalDeadlineMs).toISOString()]) expect(text).toContain(value);
  expect(text).toContain("decimals 6"); expect(text).toContain("operator fixed");
  expect(text).toContain("Signing creates a credential only. The Router may move funds on purchase.");
  expect(recordHash(r)).toBe(hash); expect(Object.isFrozen(r)).toBe(true);
});
test("sanitize phrase/values; ignore upstream bodies, labels and free text; missing decimals honest", () => {
  const r = uiRecord(); const { decimals: _, ...destination } = r.destination;
  const hostile = { ...r, destination, body: "UPSTREAM_BODY", instructions: "AGENT_TEXT", label: "URL_LABEL", routerUrl: "https://fixture.invalid/\u202e\u001b\t" };
  const text = renderConfirmation(hostile, "ph\t\u001b\u200b\u202e\u00a0 rase");
  expect(text.split("\n")[0]).toBe("phrase"); expect(text).toContain("decimals not supplied");
  expect(text).not.toMatch(/UPSTREAM_BODY|AGENT_TEXT|URL_LABEL|[\u202e\u001b\t\u200b]/);
});
// FR-F3 / AC-F3: the Resource line shows the fixed path, never the Router-internal host; the Router line stays the real URL.
test("hosted Resource line shows the route path and the Router-internal note, not the loopback host", () => {
  const r = { ...uiRecord(), routerUrl: "https://router.subethalabs.com/mcp", resource: { url: "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" as const } };
  const lines = renderRecord(r).split("\n");
  const resource = lines.find(line => line.startsWith("Resource:"))!;
  expect(resource).toBe("Resource: GET /v1/routes/md-mpp-eth-snapshot/resource (Router-internal, fixed by this payer)");
  expect(resource).not.toContain("127.0.0.1");
  expect(lines.find(line => line.startsWith("Router:"))).toBe("Router: https://router.subethalabs.com/mcp");
});
test("a configured local Router is still shown on the Router line", () => {
  const r = { ...uiRecord(), routerUrl: "http://127.0.0.1:8787/mcp", resource: { url: "http://127.0.0.1:8787/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" as const } };
  const lines = renderRecord(r).split("\n");
  expect(lines.find(line => line.startsWith("Router:"))).toBe("Router: http://127.0.0.1:8787/mcp");
  expect(lines.find(line => line.startsWith("Resource:"))).not.toContain("127.0.0.1");
});
