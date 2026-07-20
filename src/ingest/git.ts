/**
 * Thin async wrappers over simple-git (PRD §5.2).
 *
 * Every failure path either returns a benign value (false/null) or throws a
 * GitError carrying a one-line, actionable `userMessage` (§6.4, §9 F2) —
 * git's stderr is summarized, never dumped raw.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { simpleGit } from "simple-git";
import type { RangeSpec } from "../types.js";

/** Error with a user-facing one-line message (exit-2 style, §6.4). */
export class GitError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.name = "GitError";
    this.userMessage = userMessage;
  }
}

/** Range kinds that are read from git (stdin diffs never touch git). */
export type GitRangeSpec = Exclude<RangeSpec, { kind: "stdin" }>;

/** Per-file line tallies from `git diff --numstat`; null = binary ("-"). */
export interface NumstatEntry {
  added: number | null;
  removed: number | null;
}

/** Resolved range metadata for report headers and merge notices (§11.3). */
export interface ResolvedRange {
  baseRef: string;
  headRef: string;
  commitCount: number;
  mergeCount: number;
}

function toGitError(err: unknown, prefix: string): GitError {
  const detail =
    err instanceof Error
      ? err.message.split("\n").find((l) => l.trim().length > 0)?.trim()
      : undefined;
  return new GitError(detail ? `${prefix} — ${detail}` : prefix, { cause: err });
}

/** Shared `git diff` argv: staged / worktree / range, plus `-- <scope>` (§11.7). */
function diffArgs(range: GitRangeSpec, scope?: string): string[] {
  const args = ["diff", "--no-color", "--no-ext-diff", "-U3"];
  if (range.kind === "staged") {
    args.push("--cached");
  } else if (range.kind === "range") {
    args.push(range.range);
  }
  if (scope !== undefined) {
    args.push("--", scope);
  }
  return args;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return await simpleGit(cwd).checkIsRepo();
  } catch {
    return false; // e.g. cwd does not exist
  }
}

/** Absolute path of the repository top level. */
export async function repoRoot(cwd: string): Promise<string> {
  const out = await simpleGit(cwd).raw(["rev-parse", "--show-toplevel"]);
  return out.trim();
}

/**
 * Absolute path of the git dir. Resolved against cwd because
 * `rev-parse --git-dir` may print a relative path; worktree-safe (§11.8).
 */
export async function gitDir(cwd: string): Promise<string> {
  const out = await simpleGit(cwd).raw(["rev-parse", "--git-dir"]);
  return path.resolve(cwd, out.trim());
}

/**
 * True once HEAD resolves to a commit (§11.5: zero-commit repo → friendly
 * error). Note: no `-q` — simple-git resolves silently-failing commands, so
 * the probe must produce stderr on failure for the rejection to fire.
 */
export async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await simpleGit(cwd).raw(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** True while a merge is unresolved — MERGE_HEAD exists in the git dir (§11.3). */
export async function isMergeInProgress(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(await gitDir(cwd), "MERGE_HEAD"));
    return true;
  } catch {
    return false;
  }
}

/** Raw unified diff text for staged / worktree / range kinds. */
export async function getDiffText(
  cwd: string,
  range: GitRangeSpec,
  scope?: string,
): Promise<string> {
  try {
    return await simpleGit(cwd).raw(diffArgs(range, scope));
  } catch (err) {
    throw toGitError(err, "git diff failed");
  }
}

/**
 * Map of path → {added, removed} from `git diff --numstat`.
 * Binary files show `-` for both counts (§11.2) → null.
 * Rename paths (`old => new`, `dir/{old => new}/f`) normalize to the new path.
 */
export async function getNumstat(
  cwd: string,
  range: GitRangeSpec,
  scope?: string,
): Promise<Map<string, NumstatEntry>> {
  const args = diffArgs(range, scope);
  args.splice(1, 0, "--numstat"); // git diff --numstat --no-color …
  let out: string;
  try {
    out = await simpleGit(cwd).raw(args);
  } catch (err) {
    throw toGitError(err, "git diff --numstat failed");
  }
  const map = new Map<string, NumstatEntry>();
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const [a, r, ...rest] = line.split("\t");
    if (a === undefined || r === undefined || rest.length === 0) {
      continue;
    }
    const parseCount = (raw: string): number | null => {
      if (raw === "-") {
        return null;
      }
      const n = Number.parseInt(raw, 10);
      return Number.isNaN(n) ? null : n;
    };
    map.set(normalizeNumstatPath(rest.join("\t")), {
      added: parseCount(a),
      removed: parseCount(r),
    });
  }
  return map;
}

/** `src/{old.ts => new.ts}` → `src/new.ts`; `old => new` → `new`. */
function normalizeNumstatPath(p: string): string {
  const braced = /^(.*)\{.+=>(.+)\}(.*)$/.exec(p);
  if (braced !== null && braced[1] !== undefined && braced[2] !== undefined) {
    return `${braced[1]}${braced[2].trim()}${braced[3] ?? ""}`;
  }
  const arrow = p.indexOf(" => ");
  if (arrow >= 0) {
    return p.slice(arrow + 4).trim();
  }
  return p;
}

/**
 * Validate a range spec and resolve it to refs + commit tallies (§9 F2).
 *
 * - `A..B`   → base A, head B (empty side defaults to HEAD)
 * - `A...B`  → base = merge-base(A, B), head = B (matches `git diff A...B`)
 * - `A`      → base A, head HEAD (F2: `crosscheck HEAD~3` == `HEAD~3..HEAD`)
 *
 * Unknown revisions throw a GitError with a friendly one-line message.
 */
export async function resolveRange(cwd: string, range: string): Promise<ResolvedRange> {
  const git = simpleGit(cwd);

  const triple = range.indexOf("...");
  const double = range.indexOf("..");
  let baseSpec: string;
  let headSpec: string;
  if (triple >= 0) {
    baseSpec = range.slice(0, triple) || "HEAD";
    headSpec = range.slice(triple + 3) || "HEAD";
  } else if (double >= 0) {
    baseSpec = range.slice(0, double) || "HEAD";
    headSpec = range.slice(double + 2) || "HEAD";
  } else {
    baseSpec = range;
    headSpec = "HEAD";
  }

  const verify = async (ref: string): Promise<string> => {
    try {
      const out = await git.raw(["rev-parse", "--verify", `${ref}^{commit}`]);
      return out.trim();
    } catch (err) {
      throw new GitError(`unknown revision '${range}' — check the range`, { cause: err });
    }
  };

  let baseSha = await verify(baseSpec);
  const headSha = await verify(headSpec);

  if (triple >= 0) {
    try {
      const out = await git.raw(["merge-base", baseSha, headSha]);
      baseSha = out.trim();
    } catch (err) {
      throw new GitError(`no merge base for '${range}' — check the range`, { cause: err });
    }
  }

  const short = async (sha: string): Promise<string> =>
    (await git.raw(["rev-parse", "--short", sha])).trim();

  const [baseRef, headRef, countOut, mergesOut] = await Promise.all([
    short(baseSha),
    short(headSha),
    git.raw(["rev-list", "--count", `${baseSha}..${headSha}`]),
    git.raw(["rev-list", "--merges", "--count", `${baseSha}..${headSha}`]),
  ]);

  return {
    baseRef,
    headRef,
    commitCount: Number.parseInt(countOut.trim(), 10) || 0,
    mergeCount: Number.parseInt(mergesOut.trim(), 10) || 0,
  };
}

/**
 * File contents at HEAD (`git show HEAD:<path>`), or null on any failure —
 * used by guard verification (§7.9), where a failed read only ever keeps the
 * finding at its original severity.
 */
export async function showFileAtHead(cwd: string, filePath: string): Promise<string | null> {
  try {
    return await simpleGit(cwd).raw(["show", `HEAD:${filePath}`]);
  } catch {
    return null;
  }
}

/** Working-tree file contents (guard verification for new/untracked files, §7.9). */
export async function readWorkingFile(cwd: string, filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.resolve(cwd, filePath), "utf8");
  } catch {
    return null;
  }
}

/**
 * Generic blob reader: `git show <ref>:<path>`, or null on any failure
 * (unknown path at that ref, ref doesn't exist, …). `ref === ""` reads the
 * git INDEX/staged blob (`git show :<path>`) — standard git syntax used for
 * AST content sourcing in `staged`/`worktree` range modes (§6.2 step 4).
 */
export async function showBlobAtRef(cwd: string, ref: string, filePath: string): Promise<string | null> {
  try {
    return await simpleGit(cwd).raw(["show", `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}
