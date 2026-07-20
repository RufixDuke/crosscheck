/**
 * Hunk content hashing (PRD §6.2 step 3).
 *
 * hunkHash = sha1(filePath + "\n" + normalizedAddedLines + "\n" + normalizedRemovedLines)
 *
 * Normalization strips leading/trailing whitespace per line and collapses
 * internal whitespace runs to a single space, so reindented blocks and
 * reordered-import churn still dedup against previously-reviewed hunks
 * across rebases and amended commits (§6.3, §11.3).
 */

import { createHash } from "node:crypto";
import type { Hunk } from "../types.js";

/** Trim and collapse whitespace runs in a single diff line. */
export function normalizeDiffLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

export function hunkHash(filePath: string, hunk: Hunk): string {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of hunk.lines) {
    if (line.type === "add") {
      added.push(normalizeDiffLine(line.content));
    } else if (line.type === "del") {
      removed.push(normalizeDiffLine(line.content));
    }
  }
  return createHash("sha1")
    .update(`${filePath}\n${added.join("\n")}\n${removed.join("\n")}`)
    .digest("hex");
}
