/**
 * Hand-built ParsedDiff fixtures for cluster tests. The ingest module is
 * being built in parallel — these tests construct DiffFile/Hunk literals
 * directly against the shared contract in src/types.ts.
 */
import type { DiffFile, DiffLine, Hunk, ParsedDiff } from "../../../src/types.js";

export const add = (content: string): DiffLine => ({ type: "add", content });
export const del = (content: string): DiffLine => ({ type: "del", content });
export const ctx = (content: string): DiffLine => ({ type: "context", content });

export function hunk(
  filePath: string,
  lines: DiffLine[],
  opts?: { newStart?: number; newLines?: number },
): Hunk {
  const newLines = opts?.newLines ?? lines.filter((l) => l.type !== "del").length;
  // Deterministic stand-in hash: content-derived, stable across identical builds.
  const hash = `test-hunk-${filePath}-${opts?.newStart ?? 1}-${lines.length}-${lines
    .map((l) => l.content.length)
    .join(",")}`;
  return {
    filePath,
    oldStart: 1,
    oldLines: lines.filter((l) => l.type !== "add").length,
    newStart: opts?.newStart ?? 1,
    newLines,
    lines,
    hash,
  };
}

export function file(
  path: string,
  lines: DiffLine[] | Hunk[],
  opts?: { added?: number; removed?: number; isNew?: boolean; isDeleted?: boolean },
): DiffFile {
  let hunks: Hunk[];
  if (lines.length === 0) {
    hunks = [];
  } else if ("lines" in (lines[0] as Hunk | DiffLine)) {
    hunks = lines as Hunk[];
  } else {
    hunks = [hunk(path, lines as DiffLine[])];
  }
  const allLines = hunks.flatMap((h) => h.lines);
  const added = opts?.added ?? allLines.filter((l) => l.type === "add").length;
  const removed = opts?.removed ?? allLines.filter((l) => l.type === "del").length;
  const out: DiffFile = { path, hunks, added, removed };
  if (opts?.isNew !== undefined) out.isNew = opts.isNew;
  if (opts?.isDeleted !== undefined) out.isDeleted = opts.isDeleted;
  return out;
}

export function diff(...files: DiffFile[]): ParsedDiff {
  return {
    files,
    ignored: [],
    stats: {
      filesChanged: files.length,
      linesAdded: files.reduce((n, f) => n + f.added, 0),
      linesRemoved: files.reduce((n, f) => n + f.removed, 0),
    },
  };
}
