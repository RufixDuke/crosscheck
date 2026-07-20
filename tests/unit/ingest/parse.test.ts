import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../../src/ingest/parse.js";

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../../fixtures/diffs/${name}`, import.meta.url), "utf8");

describe("parseUnifiedDiff — simple multifile fixture", () => {
  it("parses all files with correct paths", async () => {
    const diff = parseUnifiedDiff(await fixture("simple-multifile.diff"));
    expect(diff.files.map((f) => f.path)).toEqual([
      "src/auth/session.ts",
      "src/db/migrate.ts",
      "README.md",
    ]);
    expect(diff.ignored).toEqual([]);
  });

  it("parses hunk headers with correct ranges and section headings", async () => {
    const diff = parseUnifiedDiff(await fixture("simple-multifile.diff"));
    const session = diff.files[0];
    expect(session).toBeDefined();
    expect(session?.hunks).toHaveLength(2);

    const [h1, h2] = session!.hunks;
    expect(h1?.oldStart).toBe(10);
    expect(h1?.oldLines).toBe(6);
    expect(h1?.newStart).toBe(10);
    expect(h1?.newLines).toBe(7);
    expect(h1?.section).toBe("export function createSession() {");
    expect(h2?.oldStart).toBe(40);
    expect(h2?.oldLines).toBe(6);
    expect(h2?.newStart).toBe(41);
    expect(h2?.newLines).toBe(7);
    expect(h2?.section).toBe("export function destroySession() {");
  });

  it("tracks 1-based old/new line numbers on every diff line", async () => {
    const diff = parseUnifiedDiff(await fixture("simple-multifile.diff"));
    const h1 = diff.files[0]?.hunks[0];
    expect(h1).toBeDefined();
    const lines = h1!.lines;

    // context a(10/10), context b(11/11), del c(12), add c(12), add d(13),
    // context e(13/14), f(14/15), g(15/16)
    expect(lines[0]).toMatchObject({ type: "context", oldLine: 10, newLine: 10 });
    expect(lines[2]).toMatchObject({ type: "del", content: "const c = 3;", oldLine: 12 });
    expect(lines[2]?.newLine).toBeUndefined();
    expect(lines[3]).toMatchObject({ type: "add", content: "const c = 4;", newLine: 12 });
    expect(lines[3]?.oldLine).toBeUndefined();
    expect(lines[4]).toMatchObject({ type: "add", content: "const d = 5;", newLine: 13 });
    expect(lines[5]).toMatchObject({ type: "context", oldLine: 13, newLine: 14 });
    expect(lines).toHaveLength(8);
  });

  it("keeps added/removed counts consistent with +/- tallies (numstat-consistency)", async () => {
    const diff = parseUnifiedDiff(await fixture("simple-multifile.diff"));
    for (const file of diff.files) {
      const adds = file.hunks.flatMap((h) => h.lines).filter((l) => l.type === "add").length;
      const dels = file.hunks.flatMap((h) => h.lines).filter((l) => l.type === "del").length;
      expect(file.added).toBe(adds);
      expect(file.removed).toBe(dels);
    }
    expect(diff.stats).toEqual({ filesChanged: 3, linesAdded: 7, linesRemoved: 4 });
  });

  it("leaves hunk hashes empty (computed later by the orchestrator)", async () => {
    const diff = parseUnifiedDiff(await fixture("simple-multifile.diff"));
    for (const file of diff.files) {
      for (const h of file.hunks) {
        expect(h.hash).toBe("");
      }
    }
  });
});

describe("parseUnifiedDiff — renames", () => {
  it("normalizes to the new path and records renamedFrom", async () => {
    const diff = parseUnifiedDiff(await fixture("rename.diff"));
    const renamed = diff.files[0];
    expect(renamed?.path).toBe("src/new-name.ts");
    expect(renamed?.renamedFrom).toBe("src/old-name.ts");
    expect(renamed?.hunks).toHaveLength(1);
    expect(renamed?.hunks[0]?.filePath).toBe("src/new-name.ts");
    expect(renamed?.added).toBe(1);
    expect(renamed?.removed).toBe(1);
  });

  it("keeps rename-only files (no hunks) in the analysis (§11.8)", async () => {
    const diff = parseUnifiedDiff(await fixture("rename.diff"));
    const renameOnly = diff.files[1];
    expect(renameOnly?.path).toBe("docs/handbook.md");
    expect(renameOnly?.renamedFrom).toBe("docs/guide.md");
    expect(renameOnly?.hunks).toEqual([]);
    expect(renameOnly?.added).toBe(0);
    expect(renameOnly?.removed).toBe(0);
  });
});

describe("parseUnifiedDiff — new and deleted files", () => {
  it("handles /dev/null headers and file-mode flags", async () => {
    const diff = parseUnifiedDiff(await fixture("new-and-deleted.diff"));
    expect(diff.files).toHaveLength(2);

    const created = diff.files[0];
    expect(created?.path).toBe("src/new-file.ts");
    expect(created?.isNew).toBe(true);
    expect(created?.isDeleted).toBeUndefined();
    expect(created?.added).toBe(3);
    expect(created?.removed).toBe(0);
    expect(created?.hunks[0]?.oldStart).toBe(0);
    expect(created?.hunks[0]?.oldLines).toBe(0);

    const deleted = diff.files[1];
    expect(deleted?.path).toBe("src/old-file.ts");
    expect(deleted?.isDeleted).toBe(true);
    expect(deleted?.added).toBe(0);
    expect(deleted?.removed).toBe(2);
  });

  it("ignores the \\ No newline at end of file marker", async () => {
    const diff = parseUnifiedDiff(await fixture("new-and-deleted.diff"));
    for (const file of diff.files) {
      for (const h of file.hunks) {
        for (const l of h.lines) {
          expect(l.content).not.toContain("No newline at end of file");
        }
      }
    }
  });
});

describe("parseUnifiedDiff — binary files", () => {
  it("moves 'Binary files … differ' files into ignored, keeps text files", async () => {
    const diff = parseUnifiedDiff(await fixture("binary.diff"));
    expect(diff.ignored).toEqual([{ path: "assets/logo.png", reason: "binary" }]);
    expect(diff.files.map((f) => f.path)).toEqual(["src/code.ts"]);
    expect(diff.stats).toEqual({ filesChanged: 1, linesAdded: 1, linesRemoved: 1 });
  });
});

describe("parseUnifiedDiff — hunk header variants", () => {
  it("defaults omitted counts to 1 (@@ -1 +1 @@)", async () => {
    const diff = parseUnifiedDiff(await fixture("lockfile-and-generated.diff"));
    const dist = diff.files.find((f) => f.path === "dist/bundle.js");
    expect(dist?.hunks[0]?.oldLines).toBe(1);
    expect(dist?.hunks[0]?.newLines).toBe(1);
    expect(dist?.hunks[0]?.oldStart).toBe(1);
    expect(dist?.hunks[0]?.newStart).toBe(1);
  });
});

describe("parseUnifiedDiff — robustness", () => {
  it("normalizes CRLF line endings (§11.8)", async () => {
    const diff = parseUnifiedDiff(await fixture("crlf.diff"));
    expect(diff.files).toHaveLength(1);
    const file = diff.files[0];
    expect(file?.path).toBe("src/win.ts");
    expect(file?.added).toBe(1);
    expect(file?.removed).toBe(1);
    for (const h of file?.hunks ?? []) {
      for (const l of h.lines) {
        expect(l.content).not.toContain("\r");
      }
    }
    expect(diff.files[0]?.hunks[0]?.lines[1]).toMatchObject({
      type: "del",
      content: "const two = 2;",
      oldLine: 2,
    });
  });

  it("returns an empty parse for empty input", async () => {
    const diff = parseUnifiedDiff(await fixture("empty.diff"));
    expect(diff.files).toEqual([]);
    expect(diff.ignored).toEqual([]);
    expect(diff.stats).toEqual({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
  });

  it("never throws on garbage input and salvages the valid hunk (§15.1)", async () => {
    const text = await fixture("garbage.diff");
    expect(() => parseUnifiedDiff(text)).not.toThrow();
    const diff = parseUnifiedDiff(text);
    expect(diff.files).toHaveLength(2);
    const salvaged = diff.files[1];
    expect(salvaged?.path).toBe("src/b.ts");
    expect(salvaged?.hunks).toHaveLength(1);
    expect(salvaged?.hunks[0]?.lines).toHaveLength(3);
    expect(salvaged?.added).toBe(1);
    expect(salvaged?.removed).toBe(1);
  });

  it("never throws on assorted malformed strings", () => {
    const junk = [
      "@@",
      "diff --git",
      "--- ",
      "+++ /dev/null",
      "diff --git a/x b/y\n@@ -1 +1 @@\n",
      "\0\0\0",
      "diff --git a/x b/y\nBinary files a/x and b/y differ",
    ];
    for (const s of junk) {
      expect(() => parseUnifiedDiff(s)).not.toThrow();
    }
  });
});
