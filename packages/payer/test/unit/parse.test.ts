import { expect, test, vi } from "vitest";
import { parseConfirmation } from "../../src/ui/osascript.js";
const pass = "synthetic-passphrase";
test.each(["", "\n"])("exact three fields, optional single terminal LF: %j", suffix => {
  const verify = vi.fn(value => value === pass);
  expect(parseConfirmation(`Approve\nfalse\n${pass}${suffix}`, verify)).toEqual({ approved: true });
  expect(verify).toHaveBeenCalledExactlyOnceWith(pass);
});
test.each([
  "", "Approve\nfalse", `Approve\nfalse\n${pass}\n\n`, `Approve\nfalse\n${pass}\nextra`,
  `Approve\nfalse\n${pass}\nextra\n`, `Approve\r\nfalse\r\n${pass}`, "Approve\nfalse\n", "Approve\nfalse\nshort",
  `Approve\nfalse\n${pass}\r`, `Approve\nFALSE\n${pass}`, `Other\nfalse\n${pass}`, `\nfalse\n${pass}`, `Other\ntrue\n`,
])("malformed shape rejects without consulting verifier: %j", text => {
  const verify = vi.fn(() => true);
  expect(parseConfirmation(text, verify)).toEqual({ approved: false, reason: "malformed_response" });
  expect(verify).not.toHaveBeenCalled();
});
test.each([[`Cancel\nfalse\n${pass}`, "cancelled"], [`Approve\ntrue\n${pass}`, "timeout"], ["\ntrue\n\n", "timeout"], [`\ntrue\n${pass}`, "timeout"]])("cancel/gave-up rejects", (text, reason) => {
  const verify = vi.fn(() => true);
  expect(parseConfirmation(text!, verify)).toEqual({ approved: false, reason }); expect(verify).not.toHaveBeenCalled();
});
test("valid different passphrase reaches verifier but rejects; errors stay static", () => {
  expect(parseConfirmation("Approve\nfalse\nanother-valid-pass", value => value === pass)).toEqual({ approved: false, reason: "bad_passphrase" });
  expect(parseConfirmation(`Approve\nfalse\n${pass}`, () => { throw new Error(pass); })).toEqual({ approved: false, reason: "bad_passphrase" });
});
