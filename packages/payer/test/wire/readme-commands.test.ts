/** File-only documentation contract. Never invokes Claude, a wallet or a native helper. */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const readme = () => readFileSync(path.join(root, "README.md"), "utf8");
function shellLines(text: string): string[] {
  return [...text.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap(match => match[1]!.split("\n"))
    .map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}
function entryCommands(): Set<string> {
  const file = ts.createSourceFile("bin.ts", readFileSync(path.join(root, "src/bin.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const commands = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) commands.add(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(file); return commands;
}

test("README install and user-scope registration parse to the actual package bin and MCP entry", () => {
  const text = readme(), lines = shellLines(text);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  // The first install, and the Upgrading section's explicit version (follow-up FR-F2).
  expect(lines.filter(line => line.startsWith("npm i -g "))).toEqual([`npm i -g ${pkg.name}`, `npm i -g ${pkg.name}@<version>`]);
  const registrations = lines.filter(line => line.startsWith("claude mcp add "));
  expect(registrations).toHaveLength(1);
  const argv = registrations[0]!.split(/\s+/);
  expect(argv).toEqual(["claude", "mcp", "add", "--scope", "user", "subetha-payer", "--", "subetha-payer", "mcp"]);
  expect(pkg.bin[argv[7]!]).toBe("bin/subetha-payer");
  expect(entryCommands().has(argv[8]!)).toBe(true);
  const commands = lines.filter(line => line.startsWith("subetha-"));
  expect(commands.length).toBeGreaterThanOrEqual(7);
  for (const line of commands) {
    const [bin, command] = line.split(/\s+/);
    expect(Object.hasOwn(pkg.bin, bin!)).toBe(true);
    expect(entryCommands().has(command!)).toBe(true);
  }
  expect(commands).toContain("subetha-payer wallet new");
  expect(commands).toContain("subetha-payer install accept");
  expect(commands).toContain("subetha-payer daemon");
  expect(commands).toContain("subetha-payer inspect p_aaaaaaaaaaaaa --close");
  expect(pkg.private).toBeUndefined();
  expect(pkg.publishConfig).toEqual({ access: "public" });
  expect(text).toMatch(/published \(G-A1/);
  expect(text).not.toMatch(/unpublished|AFTER owner publication/);
});

test("README names exactly the five production tools with the 0.2.0 inputs (static route and dynamic profile + URL)", () => {
  const text = readme();
  const tools = [...new Set(text.match(/subetha_payer_[a-z_]+/g))].sort();
  expect(tools).toEqual(["subetha_payer_find_routes", "subetha_payer_purchase", "subetha_payer_quote", "subetha_payer_status", "subetha_payer_wallet"]);
  expect(text).toContain('"routeId":"md-x402-eth-snapshot"');
  expect(text).toContain('"profileId":"dyn-mpp-to-x402","url":"https://x402.vercel.app/protected"');
  expect(text).toContain("subetha-payer wallet add solana");
  expect(text).toContain('"ref":"p_aaaaaaaaaaaaa"');
  expect(text).toMatch(/stop ALL contenders/i);
  expect(text).toMatch(/inspect.*never resubmits/i);
});
