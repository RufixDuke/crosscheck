/**
 * AST infrastructure contract (§5.4, §7.3).
 * Implemented in src/ast/project.ts (owned by the rules module); consumed by
 * both the cluster module (import edges, changed symbols for labels) and the
 * rule engine (AST matchers). ts-morph is loaded lazily — callers must handle
 * `null` (AST unavailable → degraded-but-useful path/regex fallbacks, §6.4).
 */
import type { SourceFile } from "ts-morph";

export interface AstProjectHandle {
  /** Repo-relative paths successfully loaded into the in-memory project. */
  readonly analyzed: string[];
  /** Paths that failed to parse (still served by regex rules, §6.4). */
  readonly skipped: string[];
  getSourceFile(path: string): SourceFile | undefined;
  /**
   * Static relative-import edges among the loaded (changed) files only.
   * Each tuple is [importerPath, importedPath], both repo-relative.
   */
  importEdges(): Array<readonly [string, string]>;
  /**
   * Names of functions/classes/methods whose declarations overlap the given
   * 1-based line ranges in `path` (used for cluster labels like
   * "auth/session rewrite"). Empty when unknown.
   */
  changedSymbols(path: string, lineRanges: Array<readonly [number, number]>): string[];
}

/**
 * Build an in-memory, no-emit ts-morph project from the given file contents
 * (only changed TS/JS files + their relative imports, capped — §13.2).
 * Returns null when ts-morph cannot be loaded at all.
 */
export declare function loadAstProject(
  files: Array<{ path: string; content: string }>,
  opts?: { cap?: number },
): Promise<AstProjectHandle | null>;
