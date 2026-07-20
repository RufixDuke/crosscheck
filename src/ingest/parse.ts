/**
 * Pure, line-oriented unified-diff parser (PRD §5.2, §6.2 step 2).
 *
 * Design contract:
 * - Never throws on malformed input — parse what you can, skip what you
 *   can't (§15.1 property-test requirement).
 * - CRLF is normalized to LF at input so downstream hashing is stable on
 *   Windows-authored diffs (§11.8).
 * - Binary files (`Binary files … differ` / `GIT binary patch`) are moved
 *   straight into `ignored` with reason "binary"; they carry no hunks.
 * - Hunk hashes are NOT computed here — that is hash.ts's job, applied by
 *   the orchestrator (index.ts) after the ignore pipeline runs.
 */

import type { DiffFile, Hunk, IgnoredFile, ParsedDiff } from "../types.js";

/** `@@ -oldStart[,oldLines] +newStart[,newLines] @@ optional section` */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Strip the `a/` / `b/` prefix git puts on diff paths. */
function stripGitPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/** Undo git's C-style quoting of paths with special characters. */
function unquoteMaybe(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(.)/g, (_m, ch: string) => {
      switch (ch) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case '"':
          return '"';
        case "\\":
          return "\\";
        default:
          return ch;
      }
    });
  }
  return p;
}

/** Parse the `diff --git a/X b/Y` header, tolerating quoted paths. */
function parseDiffGitHeader(line: string): { oldPath?: string; newPath?: string } {
  const rest = line.slice("diff --git ".length).trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted && quoted[1] !== undefined && quoted[2] !== undefined) {
    return {
      oldPath: stripGitPrefix(unquoteMaybe(`"${quoted[1]}"`)),
      newPath: stripGitPrefix(unquoteMaybe(`"${quoted[2]}"`)),
    };
  }
  const sep = rest.indexOf(" b/");
  if (sep > 0) {
    return {
      oldPath: stripGitPrefix(rest.slice(0, sep)),
      newPath: stripGitPrefix(rest.slice(sep + 3)),
    };
  }
  return {};
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const files: DiffFile[] = [];
  const ignored: IgnoredFile[] = [];

  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let fileBinary = false;
  let oldPathSeen: string | undefined;

  // 1-based line cursors + per-hunk tallies used to detect hunk completion.
  let oldLine = 0;
  let newLine = 0;
  let oldSeen = 0;
  let newSeen = 0;

  const flushFile = (): void => {
    if (file !== null) {
      if (file.path.length === 0 && oldPathSeen !== undefined) {
        file.path = oldPathSeen;
      }
      for (const h of file.hunks) {
        h.filePath = file.path;
      }
      if (file.path.length > 0) {
        if (fileBinary) {
          ignored.push({ path: file.path, reason: "binary" });
        } else {
          files.push(file);
        }
      }
    }
    file = null;
    hunk = null;
    fileBinary = false;
    oldPathSeen = undefined;
  };

  for (const line of lines) {
    // A new file header always terminates whatever came before, even if the
    // previous file's hunks were truncated or miscounted.
    if (line.startsWith("diff --git ")) {
      flushFile();
      const { oldPath, newPath } = parseDiffGitHeader(line);
      file = {
        path: newPath ?? oldPath ?? "",
        hunks: [],
        added: 0,
        removed: 0,
      };
      oldPathSeen = oldPath;
      continue;
    }
    if (file === null) {
      continue; // preamble junk before the first `diff --git`
    }

    // Inside an incomplete hunk every line is content (+/-/space), the
    // `\ No newline at end of file` marker, or leniently-treated junk.
    const hunkComplete =
      hunk !== null && oldSeen >= hunk.oldLines && newSeen >= hunk.newLines;
    if (hunk !== null && !hunkComplete) {
      if (line.startsWith("+")) {
        hunk.lines.push({ type: "add", content: line.slice(1), newLine });
        newLine += 1;
        newSeen += 1;
        file.added += 1;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ type: "del", content: line.slice(1), oldLine });
        oldLine += 1;
        oldSeen += 1;
        file.removed += 1;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" — metadata, not content.
      } else {
        // " "-prefixed context line. Truly empty or unprefixed lines are
        // tolerated as empty context (some tools strip trailing whitespace).
        const content = line.startsWith(" ") ? line.slice(1) : line;
        hunk.lines.push({ type: "context", content, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
        oldSeen += 1;
        newSeen += 1;
      }
      continue;
    }

    // File-level headers (outside hunks).
    if (line.startsWith("new file mode")) {
      file.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.renamedFrom = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = unquoteMaybe(line.slice(4).trim());
      if (p === "/dev/null") {
        file.isNew = true;
      } else {
        oldPathSeen = stripGitPrefix(p);
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = unquoteMaybe(line.slice(4).trim());
      if (p === "/dev/null") {
        file.isDeleted = true;
      } else {
        file.path = stripGitPrefix(p);
      }
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      fileBinary = true;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m !== null) {
      const oldStart = Number.parseInt(m[1] ?? "0", 10);
      const oldLines = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
      const newStart = Number.parseInt(m[3] ?? "0", 10);
      const newLines = m[4] === undefined ? 1 : Number.parseInt(m[4], 10);
      const section = (m[5] ?? "").trim();
      hunk = {
        filePath: file.path,
        oldStart: Number.isNaN(oldStart) ? 0 : oldStart,
        oldLines: Number.isNaN(oldLines) ? 0 : oldLines,
        newStart: Number.isNaN(newStart) ? 0 : newStart,
        newLines: Number.isNaN(newLines) ? 0 : newLines,
        lines: [],
        hash: "", // computed later by index.ts via hunkHash
      };
      if (section.length > 0) {
        hunk.section = section;
      }
      file.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      oldSeen = 0;
      newSeen = 0;
      continue;
    }

    // Everything else — `index …`, `old mode`/`new mode`, `similarity index`,
    // `dissimilarity index`, `copy from/to`, malformed hunk headers, junk —
    // is skipped by design.
  }
  flushFile();

  const stats = {
    filesChanged: files.length,
    linesAdded: files.reduce((n, f) => n + f.added, 0),
    linesRemoved: files.reduce((n, f) => n + f.removed, 0),
  };
  return { files, ignored, stats };
}
