import { describe, expect, it } from "vitest";
import { sanitizeJsonc } from "../../../src/config/jsonc.js";

function parse(text: string): unknown {
  return JSON.parse(sanitizeJsonc(text));
}

describe("sanitizeJsonc", () => {
  it("passes plain JSON through unchanged", () => {
    const text = `{"a": 1, "b": [1, 2, 3]}`;
    expect(sanitizeJsonc(text)).toBe(text);
    expect(parse(text)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it("strips // line comments", () => {
    const text = `{
  // this is a comment
  "a": 1, // trailing comment
  "b": 2
}`;
    expect(parse(text)).toEqual({ a: 1, b: 2 });
  });

  it("strips /* */ block comments, including multiline", () => {
    const text = `{
  /* block
     spanning
     lines */
  "a": /* inline */ 1
}`;
    expect(parse(text)).toEqual({ a: 1 });
  });

  it("keeps https:// URLs inside string literals", () => {
    const text = `{
  "$schema": "https://raw.githubusercontent.com/org/crosscheck/main/schema.json",
  "url": "https://example.com/docs?q=1"
}`;
    expect(parse(text)).toEqual({
      $schema: "https://raw.githubusercontent.com/org/crosscheck/main/schema.json",
      url: "https://example.com/docs?q=1",
    });
  });

  it("keeps comment-like text inside strings", () => {
    const text = `{
  "pattern": "// not a comment",
  "other": "a /* b */ c"
}`;
    expect(parse(text)).toEqual({ pattern: "// not a comment", other: "a /* b */ c" });
  });

  it("ignores quotes inside comments", () => {
    const text = `{
  "a": 1
} // trailing "quoted" comment
/* and a "quoted" block */`;
    expect(parse(text)).toEqual({ a: 1 });
  });

  it("handles escaped quotes before comment-like text", () => {
    const text = `{"a": "say \\"hi\\" // not a comment", "b": 2}`;
    expect(parse(text)).toEqual({ a: 'say "hi" // not a comment', b: 2 });
  });

  it("removes trailing commas in objects and arrays", () => {
    const text = `{
  "a": 1,
  "list": [
    "x",
    "y",
  ],
}`;
    expect(parse(text)).toEqual({ a: 1, list: ["x", "y"] });
  });

  it("does not touch commas or braces inside strings", () => {
    const text = `{"a": ",}", "b": ",]",}`;
    expect(parse(text)).toEqual({ a: ",}", b: ",]" });
  });

  it("handles a commented §12.2-style config document", () => {
    const text = `// crosscheck.config.json
{
  "$schema": "https://raw.githubusercontent.com/<org>/crosscheck/main/schema/crosscheck.config.schema.json",
  "version": 1,
  "rules": {
    "disable": ["crypto/weak-hash"], // built-in rule ids to turn off
    "custom": [],
  },
  "strict": { "failOn": "high" }, /* threshold for --strict */
}`;
    expect(parse(text)).toEqual({
      $schema: "https://raw.githubusercontent.com/<org>/crosscheck/main/schema/crosscheck.config.schema.json",
      version: 1,
      rules: { disable: ["crypto/weak-hash"], custom: [] },
      strict: { failOn: "high" },
    });
  });
});
