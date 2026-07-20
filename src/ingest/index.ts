/**
 * Diff ingest orchestration (PRD §6.2 steps 2–3).
 *
 * Flow: acquire diff text (git or stdin) → parse → ignore pipeline
 * (binary/lockfile/generated/user globs, §11.2) → recompute stats over the
 * surviving files → hash every remaining hunk for dedup (§6.2 step 3).
 *
 * Failure model (§6.4/§11.5): not a repo, zero commits, and mid-merge repos
 * throw GitError with one-line actionable messages; stdin mode never fails
 * on repo detection — it only picks up repo context opportunistically.
 */

import path from "node:path";
import type { DiffFile, Hunk, ParsedDiff, RangeSpec } from "../types.js";
import { parseUnifiedDiff } from "./parse.js";
import { categorizeFile } from "./ignore.js";
import { hunkHash } from "./hash.js";
import {
  GitError,
  getDiffText,
  getNumstat,
  gitDir,
  hasCommits,
  isGitRepo,
  isMergeInProgress,
  repoRoot,
  resolveRange,
} from "./git.js";
import type { NumstatEntry } from "./git.js";

export { GitError, isGitRepo, readWorkingFile, repoRoot, showBlobAtRef, showFileAtHead } from "./git.js";
export type { NumstatEntry, ResolvedRange } from "./git.js";
export { parseUnifiedDiff } from "./parse.js";
export { categorizeFile } from "./ignore.js";
export { hunkHash, normalizeDiffLine } from "./hash.js";

/** Run metadata attached to every ingest; feeds report header + history. */
export interface IngestMeta {
  repoRoot: string | null;
  repoName: string | null;
  gitDir: string | null;
  baseRef?: string;
  headRef?: string;
  commitCount?: number;
  mergeCount?: number;
  scope?: string;
}

export interface IngestResult {
  diff: ParsedDiff;
  meta: IngestMeta;
}

export async function ingestDiff(opts: {
  cwd: string;
  range: RangeSpec;
  scope?: string;
  ignoreGlobs?: string[];
}): Promise<IngestResult> {
  const { cwd, range, scope } = opts;
  const ignoreGlobs = opts.ignoreGlobs ?? [];

  if (range.kind === "stdin") {
    const diff = parseUnifiedDiff(range.text);
    const meta: IngestMeta = { repoRoot: null, repoName: null, gitDir: null };
    if (scope !== undefined) {
      meta.scope = scope;
    }
    // Opportunistic repo context (§11.5): history uses the global fallback
    // when this fails, and stdin mode must never fail because of it.
    try {
      if (await isGitRepo(cwd)) {
        const root = await repoRoot(cwd);
        meta.repoRoot = root;
        meta.repoName = path.basename(root);
        meta.gitDir = await gitDir(cwd);
      }
    } catch {
      // best-effort only
    }
    applyIgnorePipeline(diff, undefined, ignoreGlobs);
    applyHunkHashes(diff);
    return { diff, meta };
  }

  if (!(await isGitRepo(cwd))) {
    throw new GitError(
      "not a git repository — run inside a repo, or pipe a diff: git diff | crosscheck --stdin",
    );
  }
  if (!(await hasCommits(cwd))) {
    throw new GitError("no commits yet — commit something first, or use --stdin");
  }
  if (await isMergeInProgress(cwd)) {
    throw new GitError("merge in progress — resolve conflicts first");
  }

  const [root, gdir] = await Promise.all([repoRoot(cwd), gitDir(cwd)]);
  const meta: IngestMeta = {
    repoRoot: root,
    repoName: path.basename(root),
    gitDir: gdir,
  };
  if (scope !== undefined) {
    meta.scope = scope;
  }
  if (range.kind === "range") {
    // Validate + resolve before diffing so unknown revisions produce the
    // friendly F2 message instead of a raw `git diff` failure.
    const resolved = await resolveRange(cwd, range.range);
    meta.baseRef = resolved.baseRef;
    meta.headRef = resolved.headRef;
    meta.commitCount = resolved.commitCount;
    meta.mergeCount = resolved.mergeCount;
  }

  const [text, numstat] = await Promise.all([
    getDiffText(cwd, range, scope),
    getNumstat(cwd, range, scope),
  ]);
  const diff = parseUnifiedDiff(text);

  applyIgnorePipeline(diff, numstat, ignoreGlobs);
  applyHunkHashes(diff);
  return { diff, meta };
}

/**
 * Best-effort "first line of the file" from its hunks — first added line,
 * else first context line. Used for generated-marker detection (§11.2).
 */
function firstLineOf(file: DiffFile): string | undefined {
  for (const h of file.hunks) {
    const add = h.lines.find((l) => l.type === "add");
    if (add !== undefined) {
      return add.content;
    }
  }
  for (const h of file.hunks) {
    const ctx = h.lines.find((l) => l.type === "context");
    if (ctx !== undefined) {
      return ctx.content;
    }
  }
  return undefined;
}

/**
 * Binary verdict: numstat `-`/`-` counts in git mode (§11.2), falling back
 * to NUL-byte sniffing of the raw hunk text (stdin mode, or numstat miss).
 */
function isBinaryFile(
  file: DiffFile,
  numstat: Map<string, NumstatEntry> | undefined,
): boolean {
  if (numstat !== undefined) {
    const entry =
      numstat.get(file.path) ??
      (file.renamedFrom !== undefined ? numstat.get(file.renamedFrom) : undefined);
    if (entry !== undefined) {
      return entry.added === null && entry.removed === null;
    }
  }
  for (const h of file.hunks) {
    for (const line of h.lines) {
      if (line.content.includes("\0")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Move ignored files out of `diff.files` into `diff.ignored` with reasons,
 * then recompute stats over the survivors (§6.2 step 2). Rename-only files
 * with no hunks stay in the analysis (§11.8).
 */
function applyIgnorePipeline(
  diff: ParsedDiff,
  numstat: Map<string, NumstatEntry> | undefined,
  userGlobs: string[],
): void {
  const kept: DiffFile[] = [];
  for (const file of diff.files) {
    const reason = categorizeFile(
      file.path,
      firstLineOf(file),
      isBinaryFile(file, numstat),
      userGlobs,
    );
    if (reason !== null) {
      diff.ignored.push({ path: file.path, reason });
    } else {
      kept.push(file);
    }
  }
  diff.files = kept;
  diff.stats = {
    filesChanged: kept.length,
    linesAdded: kept.reduce((n, f) => n + f.added, 0),
    linesRemoved: kept.reduce((n, f) => n + f.removed, 0),
  };
}

/** Compute hunk hashes for dedup (§6.2 step 3) on surviving files. */
function applyHunkHashes(diff: ParsedDiff): void {
  for (const file of diff.files) {
    for (const h of file.hunks) {
      h.hash = hunkHash(file.path, h);
    }
  }
}

/** All hunks across analyzed files — the rule engine's working set. */
export function hunksOf(diff: ParsedDiff): Hunk[] {
  return diff.files.flatMap((f) => f.hunks);
}

/** Every path seen in the diff — analyzed files plus ignored ones. */
export function allFilesOf(diff: ParsedDiff): string[] {
  return [...diff.files.map((f) => f.path), ...diff.ignored.map((i) => i.path)];
}
