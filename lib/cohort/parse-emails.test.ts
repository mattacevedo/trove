import { expect, test } from "vitest";
import { parseEmails } from "./parse-emails";

test("splits on comma, newline, and whitespace and trims", () => {
  const { valid, invalid } = parseEmails("a@x.com, b@x.com\nc@x.com d@x.com");
  expect(valid).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  expect(invalid).toEqual([]);
});

test("lowercases and dedupes, preserving first-seen order", () => {
  const { valid } = parseEmails("Foo@X.com, foo@x.com\nBar@X.com");
  expect(valid).toEqual(["foo@x.com", "bar@x.com"]);
});

test("separates invalid tokens, keeping their original text", () => {
  const { valid, invalid } = parseEmails("good@x.com, not-an-email, also bad@, ok@y.io");
  expect(valid).toEqual(["good@x.com", "ok@y.io"]);
  expect(invalid).toEqual(["not-an-email", "bad@"]);
});

test("ignores empty fragments and returns empty arrays for blank input", () => {
  expect(parseEmails("   \n , ,")).toEqual({ valid: [], invalid: [] });
  expect(parseEmails("")).toEqual({ valid: [], invalid: [] });
});
