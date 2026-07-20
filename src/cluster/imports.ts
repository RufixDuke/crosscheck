/**
 * Regex-based import detection — §5.4 layer 2 fallback. Works on any text
 * file with no AST: scans the raw lines present in each file's diff hunks
 * (added, removed and context lines — a removed import is still evidence the
 * two files are related) for static import shapes across languages:
 *
 *   - JS/TS: `import … from "<spec>"`, `import "<spec>"`, `export … from`,
 *     multi-line `} from "<spec>"`, `require("<spec>")`, `import("<spec>")`
 *   - Python: `from .mod import …`, `from ..pkg.mod import …` (relative only)
 *   - C/C++: `#include "<spec>"` (quote includes are file-relative)
 *
 * Only RELATIVE specifiers (`./`, `../`, Python dot form) are resolved —
 * bare specifiers (`express`, `os`, `<vector>`) never resolve. Resolution
 * probes the exact path first, then common source extensions, then `/index`
 * variants. An edge [importer, imported] is emitted only when BOTH endpoints
 * are in the changed-file set.
 */
import type { DiffFile } from "../types.js";

/** Extensions probed, in order, when a specifier has no (matching) filename. */
const PROBE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
];

interface ImportPattern {
  readonly re: RegExp;
  /** Quote-style C includes resolve relative to the including file. */
  readonly assumeRelative: boolean;
}

const IMPORT_PATTERNS: readonly ImportPattern[] = [
  // JS/TS `import … from "x"`, `export … from "x"`, multi-line `} from "x"`.
  { re: /\bfrom\s+["']([^"']+)["']/g, assumeRelative: false },
  // JS/TS side-effect import `import "x"` (also CSS `@import "x"`).
  { re: /\bimport\s+["']([^"']+)["']/g, assumeRelative: false },
  // CommonJS `require("x")`.
  { re: /\brequire\(\s*["']([^"']+)["']\s*\)/g, assumeRelative: false },
  // Dynamic `import("x")`.
  { re: /\bimport\(\s*["']([^"']+)["']\s*\)/g, assumeRelative: false },
  // Python relative import: `from .mod import x`, `from ..pkg.mod import x`.
  { re: /^\s*from\s+(\.{1,2}[^\s"']*)\s+import\b/gm, assumeRelative: false },
  // C/C++ file-relative include: `#include "util/helper.h"`.
  { re: /^\s*#\s*include\s+"([^"]+)"/gm, assumeRelative: true },
];

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Convert a raw specifier to a repo-relative candidate path, or null when
 * the specifier is not relative. Python dot form: `.mod` → `./mod`,
 * `..pkg.mod` → `../pkg/mod` (inner dots become separators).
 */
function resolveCandidate(spec: string, assumeRelative: boolean, importerDir: string): string | null {
  let rel: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    rel = spec;
  } else if (assumeRelative) {
    rel = `./${spec}`;
  } else {
    const py = /^(\.{1,2})([A-Za-z0-9_][\w.]*)?$/.exec(spec);
    if (py !== null) {
      const dots = (py[1] ?? ".").length;
      const rest = (py[2] ?? "").replace(/\./g, "/");
      rel = (dots === 2 ? "../" : "./") + rest;
    }
  }
  if (rel === null) return null;

  const parts = importerDir === "" ? [] : importerDir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop(); // clamp at repo root
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** First probe that lands on a changed file, or null. */
function probe(candidate: string, changed: ReadonlySet<string>): string | null {
  if (changed.has(candidate)) return candidate;
  for (const ext of PROBE_EXTENSIONS) {
    if (changed.has(candidate + ext)) return candidate + ext;
  }
  const indexBase = candidate === "" ? "index" : `${candidate}/index`;
  for (const ext of PROBE_EXTENSIONS) {
    if (changed.has(indexBase + ext)) return indexBase + ext;
  }
  return null;
}

/**
 * Import edges among the changed files, derived purely from diff text.
 * Each edge is [importerPath, importedPath]; duplicates and self-edges are
 * removed. Deterministic: files, hunks, lines and patterns are scanned in
 * input order and probes have a fixed extension order.
 */
export function regexImportEdges(files: DiffFile[]): Array<readonly [string, string]> {
  const changed = new Set(files.map((f) => f.path));
  const edges: Array<readonly [string, string]> = [];
  const seen = new Set<string>();

  for (const file of files) {
    const importerDir = dirOf(file.path);
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        for (const { re, assumeRelative } of IMPORT_PATTERNS) {
          for (const match of line.content.matchAll(re)) {
            const spec = match[1];
            if (spec === undefined) continue;
            const candidate = resolveCandidate(spec, assumeRelative, importerDir);
            if (candidate === null) continue;
            const target = probe(candidate, changed);
            if (target === null || target === file.path) continue;
            const key = `${file.path}\n${target}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push([file.path, target] as const);
          }
        }
      }
    }
  }
  return edges;
}
