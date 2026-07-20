import { describe, expect, it } from "vitest";
import type { DiffLine, Hunk } from "../../../src/types.js";
import { hunkHash, normalizeDiffLine } from "../../../src/ingest/hash.js";

function makeHunk(lines: Array<[DiffLine["type"], string]>): Hunk {
  return {
    filePath: "unused",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: lines.map(([type, content]) => ({ type, content })),
    hash: "",
  };
}

describe("normalizeDiffLine", () => {
  it("strips leading/trailing whitespace and collapses internal runs", () => {
    expect(normalizeDiffLine("  const   x = 1;  ")).toBe("const x = 1;");
    expect(normalizeDiffLine("\tfoo\t\tbar\t")).toBe("foo bar");
    expect(normalizeDiffLine("no-whitespace")).toBe("no-whitespace");
    expect(normalizeDiffLine("   ")).toBe("");
  });
});

describe("hunkHash", () => {
  it("is a stable 40-char sha1 hex", () => {
    const h = makeHunk([
      ["add", "const x = 1;"],
      ["del", "const x = 0;"],
    ]);
    const hash = hunkHash("src/a.ts", h);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(hunkHash("src/a.ts", h)).toBe(hash);
  });

  it("is stable under reindentation (§6.2 step 3)", () => {
    const spaces = makeHunk([["add", "    const x = 1;"]]);
    const tabs = makeHunk([["add", "\tconst x = 1;"]]);
    expect(hunkHash("src/a.ts", spaces)).toBe(hunkHash("src/a.ts", tabs));
  });

  it("is stable under internal whitespace-run changes", () => {
    const a = makeHunk([["add", "import   {   x }   from 'y';"]]);
    const b = makeHunk([["add", "import { x } from 'y';"]]);
    expect(hunkHash("src/a.ts", a)).toBe(hunkHash("src/a.ts", b));
  });

  it("ignores context lines", () => {
    const withCtx = makeHunk([
      ["context", "surrounding line"],
      ["add", "const x = 1;"],
    ]);
    const withoutCtx = makeHunk([["add", "const x = 1;"]]);
    expect(hunkHash("src/a.ts", withCtx)).toBe(hunkHash("src/a.ts", withoutCtx));
  });

  it("changes when added/removed content changes", () => {
    const a = makeHunk([["add", "const x = 1;"]]);
    const b = makeHunk([["add", "const x = 2;"]]);
    expect(hunkHash("src/a.ts", a)).not.toBe(hunkHash("src/a.ts", b));
  });

  it("changes with the file path (same hunk, different file)", () => {
    const h = makeHunk([["add", "const x = 1;"]]);
    expect(hunkHash("src/a.ts", h)).not.toBe(hunkHash("src/b.ts", h));
  });

  it("distinguishes added from removed lines", () => {
    const added = makeHunk([["add", "secret = true"]]);
    const removed = makeHunk([["del", "secret = true"]]);
    expect(hunkHash("src/a.ts", added)).not.toBe(hunkHash("src/a.ts", removed));
  });

  it("handles empty hunks and stray \\r without throwing", () => {
    const empty = makeHunk([]);
    expect(hunkHash("src/a.ts", empty)).toMatch(/^[0-9a-f]{40}$/);
    const crlf = makeHunk([["add", "const x = 1;\r"]]);
    const lf = makeHunk([["add", "const x = 1;"]]);
    expect(hunkHash("src/a.ts", crlf)).toBe(hunkHash("src/a.ts", lf));
  });
});
