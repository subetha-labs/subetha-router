import { expect, test } from "vitest";
import { appleScriptString, confirmationScript } from "../../src/ui/osascript.js";

test("escape backslash before quote, including adjacent slash/quote; LF uses return", () => {
  expect(appleScriptString('plain')).toBe('"plain"');
  expect(appleScriptString('a\\"b\nc')).toBe('"a\\\\\\"b" & return & "c"');
  expect(appleScriptString('a"b')).toBe('"a\\"b"');
  expect(appleScriptString('a\\b')).toBe('"a\\\\b"');
  expect(appleScriptString('a\nb')).not.toContain('\\n');
});
test("dialog has fixed safe options and exactly three returned fields", () => {
  const script = confirmationScript('phrase\nrecord');
  expect(script).toContain('display dialog "phrase" & return & "record"');
  expect(script).toContain('with title "subetha-payer"');
  expect(script).toContain('buttons {"Cancel", "Approve"} default button "Cancel"');
  expect(script).toContain('default answer "" with hidden answer giving up after 120');
  expect(script).toContain('return (button returned of r) & linefeed & (gave up of r) & linefeed & (text returned of r)');
});
