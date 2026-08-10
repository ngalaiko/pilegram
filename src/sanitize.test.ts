import { expect, test } from "bun:test";
import { stripUnsafe } from "./sanitize.ts";

// Built from escapes so this test file contains no invisible characters itself.
const RLO = String.fromCharCode(0x202e); // right-to-left override
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const BOM = String.fromCharCode(0xfeff);

test("removes bidi overrides and zero-width characters", () => {
  expect(stripUnsafe(`a${RLO}b${ZWSP}c${BOM}`)).toBe("abc");
});

test("leaves ordinary and RTL letters intact", () => {
  const arabic = "مرحبا"; // مرحبا
  expect(stripUnsafe(`hello ${arabic}`)).toBe(`hello ${arabic}`);
});
