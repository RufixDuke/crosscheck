/**
 * Hunk clustering — §5.4, §6.2 step 4. Main entry point.
 *
 * Three layers, each independently fallback-able:
 *   1. path affinity (always available, all languages) — pairwise
 *      `pathAffinity` ≥ AFFINITY_THRESHOLD produces an edge;
 *   2. import-graph edges — the AST handle's `importEdges()` when the caller
 *      built one (TS/JS diffs), ALWAYS unioned with the regex fallback
 *      (`regexImportEdges`), which works even when AST is unavailable;
 *   3. union-find → connected components → labeled clusters, sorted by size
 *      and capped at `maxClusters` (overflow merges into `misc changes`).
 *
 * Pure: no git, no fs — the caller hands over a ParsedDiff and an optional
 * AstProjectHandle.
 */
import type { AstProjectHandle } from "../ast/types.js";
import type { Cluster, DiffFile, ParsedDiff } from "../types.js";
import { AFFINITY_THRESHOLD, pathAffinity } from "./affinity.js";
import { regexImportEdges } from "./imports.js";
import { labelCluster } from "./label.js";
import { UnionFind } from "./unionfind.js";

export { AFFINITY_THRESHOLD } from "./affinity.js";

export interface ClusterResult {
  clusters: Cluster[];
  ast: { analyzed: number; skipped: number };
}

export interface ClusterOptions {
  /** Cap on emitted clusters (§5.4); overflow merges into `misc changes`. */
  maxClusters?: number; // default 8
  /** Pass when the caller built an AST project (TS/JS diffs), else null/omit. */
  ast?: AstProjectHandle | null;
}

const DEFAULT_MAX_CLUSTERS = 8;

/** Files ts-morph can analyze; others get path/regex treatment only. */
const TS_JS_RE = /\.(?:[cm]?[tj]s|[tj]sx)$/i;

/**
 * 1-based new-side line ranges covered by a file's hunks
 * (`newStart .. newStart + newLines - 1`). Pure-deletion hunks (newLines 0)
 * clamp to the single anchor line so enclosing symbols still surface.
 */
export function hunkNewLineRanges(file: DiffFile): Array<readonly [number, number]> {
  return file.hunks.map((hunk) => {
    const span = Math.max(hunk.newLines, 1);
    return [hunk.newStart, hunk.newStart + span - 1] as const;
  });
}

interface Component {
  files: DiffFile[];
  changedLines: number;
}

/**
 * Cluster a parsed diff into labeled, size-capped clusters (§5.4).
 * Deterministic: identical inputs always produce identical output.
 */
export function clusterDiff(diff: ParsedDiff, opts: ClusterOptions = {}): ClusterResult {
  const maxClusters = Math.max(1, opts.maxClusters ?? DEFAULT_MAX_CLUSTERS);
  const ast = opts.ast ?? null;
  const astStats = {
    analyzed: ast?.analyzed.length ?? 0,
    skipped: ast?.skipped.length ?? 0,
  };

  const files = diff.files;
  if (files.length === 0) return { clusters: [], ast: astStats };

  const paths = files.map((f) => f.path);
  const uf = new UnionFind();
  for (const path of paths) uf.find(path); // register every node

  // Layer 1: path-affinity edges (O(n²) over changed files — bounded diffs).
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i];
      const b = paths[j];
      if (a !== undefined && b !== undefined && pathAffinity(a, b) >= AFFINITY_THRESHOLD) {
        uf.union(a, b);
      }
    }
  }

  // Layer 2: import edges — AST preferred, always unioned with regex fallback.
  const inDiff = new Set(paths);
  const edges: Array<readonly [string, string]> = [];
  if (ast !== null) edges.push(...ast.importEdges());
  edges.push(...regexImportEdges(files));
  for (const [a, b] of edges) {
    if (inDiff.has(a) && inDiff.has(b)) uf.union(a, b);
  }

  // Layer 3: connected components → sorted clusters.
  const indexByPath = new Map(paths.map((p, i) => [p, i] as const));
  const components: Component[] = [...uf.groups().values()].map((group) => {
    const memberFiles = group
      .slice()
      .sort((a, b) => (indexByPath.get(a) ?? 0) - (indexByPath.get(b) ?? 0))
      .map((p) => files[indexByPath.get(p) ?? 0])
      .filter((f): f is DiffFile => f !== undefined);
    return {
      files: memberFiles,
      changedLines: memberFiles.reduce((n, f) => n + f.added + f.removed, 0),
    };
  });
  components.sort(
    (a, b) =>
      b.files.length - a.files.length ||
      b.changedLines - a.changedLines ||
      (a.files[0]?.path ?? "").localeCompare(b.files[0]?.path ?? ""),
  );

  // Cap: the (maxClusters − 1) largest stay; the rest merge into one
  // overflow cluster labeled exactly `misc changes` (§5.4).
  const capped: Array<{ files: DiffFile[]; label: string | null }> = [];
  if (components.length > maxClusters) {
    for (const kept of components.slice(0, maxClusters - 1)) {
      capped.push({ files: kept.files, label: null });
    }
    capped.push({
      files: components.slice(maxClusters - 1).flatMap((c) => c.files),
      label: "misc changes",
    });
  } else {
    for (const component of components) {
      capped.push({ files: component.files, label: null });
    }
  }

  const clusters: Cluster[] = capped.map((component, i) => {
    const symbols: string[] = [];
    if (ast !== null) {
      const seen = new Set<string>();
      for (const file of component.files) {
        if (!TS_JS_RE.test(file.path)) continue;
        for (const symbol of ast.changedSymbols(file.path, hunkNewLineRanges(file))) {
          if (!seen.has(symbol)) {
            seen.add(symbol);
            symbols.push(symbol);
          }
        }
      }
    }
    return {
      id: `c${i + 1}`,
      label: component.label ?? labelCluster(component.files, symbols),
      files: component.files,
      hunks: component.files.flatMap((f) => f.hunks),
      symbols,
      added: component.files.reduce((n, f) => n + f.added, 0),
      removed: component.files.reduce((n, f) => n + f.removed, 0),
      severity: "low", // placeholder — the rule engine overwrites this (§7)
    };
  });

  return { clusters, ast: astStats };
}
