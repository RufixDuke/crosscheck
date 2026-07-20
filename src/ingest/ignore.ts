/**
 * Exclusion categorization for the ignore pipeline (PRD §11.2).
 *
 * Precedence: binary → lockfile → generated → user globs. Ignored files are
 * always counted and reported, never silently dropped (§6.2 step 2).
 */

import picomatch from "picomatch";
import type { IgnoreReason } from "../types.js";

/** Lockfiles excluded from hunk analysis, matched by basename (§11.2). */
const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
]);

/** First-line generated markers (§11.2). */
const GENERATED_FIRST_LINE_RE = /Code generated .* DO NOT EDIT/;
const GENERATED_FIRST_LINE_MARKERS = ["@generated", "auto-generated"];

/** Conventional generated paths (§11.2), matched with picomatch. */
const GENERATED_PATH_GLOBS = [
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.pb.go",
  "**/*.snap",
  "**/__snapshots__/**",
];
const isGeneratedPath = picomatch(GENERATED_PATH_GLOBS, { dot: true });

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Decide whether a parsed file should be excluded from analysis.
 *
 * @param path      normalized new path (renames → new path)
 * @param firstLine first added/context line seen in the diff, when available
 * @param isBinary  binary verdict from numstat or NUL-byte sniffing
 * @param userGlobs user-configured `ignore` globs (§12.2)
 * @returns the IgnoreReason, or null when the file stays in the analysis
 */
export function categorizeFile(
  path: string,
  firstLine: string | undefined,
  isBinary: boolean,
  userGlobs: string[],
): IgnoreReason | null {
  if (isBinary) {
    return "binary";
  }
  if (LOCKFILE_BASENAMES.has(basename(path))) {
    return "lockfile";
  }
  if (firstLine !== undefined) {
    if (GENERATED_FIRST_LINE_RE.test(firstLine)) {
      return "generated";
    }
    for (const marker of GENERATED_FIRST_LINE_MARKERS) {
      if (firstLine.includes(marker)) {
        return "generated";
      }
    }
  }
  if (isGeneratedPath(path)) {
    return "generated";
  }
  if (userGlobs.length > 0 && picomatch(userGlobs, { dot: true })(path)) {
    return "user-ignore";
  }
  return null;
}
