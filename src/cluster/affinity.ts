/**
 * File-path affinity — §5.4 layer 1. Always available, language-agnostic,
 * deterministic. Produces a score in [0, 1] from three weighted signals:
 *
 *   - shared directory-prefix depth (dominant, weight 0.65)
 *   - filename-stem relationship after stripping test/style/type suffixes
 *     (`foo.ts` ↔ `foo.test.ts` ↔ `foo.module.css`), weight 0.25
 *   - a shared conventional layer segment anywhere in the directory path
 *     (`auth`, `routes`, `db`, …), weight 0.10
 *
 * …plus one heavy penalty: files rooted under DIFFERENT monorepo package
 * directories (`packages/web/…` vs `packages/api/…`, §11.7) are scaled to a
 * fifth of their score so they cluster separately without `--scope`.
 *
 * Threshold calibration (AFFINITY_THRESHOLD = 0.34) sits deliberately between
 * two canonical scores:
 *   - `src/auth/x.ts` ↔ `src/components/y.tsx` scores 0.65 × (1 shared dir
 *     segment / depth 2) = 0.325 → must NOT cluster → below threshold.
 *   - `src/auth/session.ts` ↔ `tests/auth/session.test.ts` scores 0.25 (stem)
 *     + 0.10 (shared `auth` layer) = 0.35 → SHOULD cluster → above threshold.
 * Everything stronger (same directory: ≥ 0.65; same stem in same dir: 1.0)
 * clears the threshold with room to spare.
 */

/** Pairwise affinity at or above this score produces a union-find edge. */
export const AFFINITY_THRESHOLD = 0.34;

const W_DIR = 0.65;
const W_STEM = 0.25;
const W_LAYER = 0.1;

/** Directory segments that identify a conventional architectural layer. */
const LAYER_SEGMENTS = new Set([
  "routes",
  "db",
  "auth",
  "components",
  "migrations",
  "server",
  "api",
  "pages",
  "services",
  "models",
  "controllers",
  "middleware",
  "hooks",
  "store",
  "views",
  "utils",
]);

/**
 * Top-level directories that mark a monorepo package root: files under
 * `<root>/<pkg>/…` belong to package `<root>/<pkg>`.
 */
const MONOREPO_ROOTS = new Set(["packages", "apps", "services", "libs", "modules"]);

/**
 * Secondary filename suffixes stripped before stem comparison, so
 * `foo.test.ts`, `foo.spec.ts`, `foo.types.ts`, `foo.d.ts`, `foo.module.css`,
 * `foo.styles.css` all reduce to stem `foo`.
 */
const SECONDARY_SUFFIXES = [
  ".test",
  ".spec",
  ".types",
  ".d",
  ".styles",
  ".module",
  ".stories",
  ".story",
  ".e2e",
  ".integration",
];

/** Stems too generic to establish identity (`index.ts` everywhere, …). */
const GENERIC_STEMS = new Set([
  "index",
  "main",
  "mod",
  "utils",
  "util",
  "helpers",
  "helper",
  "types",
  "constants",
  "config",
  "styles",
  "style",
  "common",
  "shared",
]);

/** Lowercased, posix-normalized path segments (empty and `.` dropped). */
function splitPath(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".");
}

/**
 * Filename stem for comparison: basename minus its final extension, minus one
 * known secondary suffix. `foo.module.css` → `foo`, `foo.d.ts` → `foo`,
 * `0017_family.sql` → `0017_family`. Exported for label generation.
 */
export function pathStem(path: string): string {
  const segments = splitPath(path);
  const base = segments[segments.length - 1] ?? "";
  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  for (const suffix of SECONDARY_SUFFIXES) {
    if (stem.endsWith(suffix) && stem.length > suffix.length) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  return stem;
}

function commonPrefixLength(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Monorepo package root (`packages/web`) or null for ordinary layouts. */
function packageRoot(segments: string[]): string | null {
  const first = segments[0];
  const second = segments[1];
  if (segments.length >= 3 && first !== undefined && second !== undefined && MONOREPO_ROOTS.has(first)) {
    return `${first}/${second}`;
  }
  return null;
}

function sharesLayerSegment(dirA: string[], dirB: string[]): boolean {
  const layers = new Set(dirA.filter((seg) => LAYER_SEGMENTS.has(seg)));
  return dirB.some((seg) => layers.has(seg));
}

/**
 * Deterministic affinity between two repo-relative paths, in [0, 1].
 * Identical paths score 1.
 */
export function pathAffinity(a: string, b: string): number {
  if (a === b) return 1;
  const segA = splitPath(a);
  const segB = splitPath(b);
  if (segA.length === 0 || segB.length === 0) return a === b ? 1 : 0;

  const dirA = segA.slice(0, -1);
  const dirB = segB.slice(0, -1);

  // Shared directory-prefix depth, normalized by the deeper of the two.
  // Two root-level files share the (empty) root directory → score 1.
  const maxDepth = Math.max(dirA.length, dirB.length);
  const dirScore = maxDepth === 0 ? 1 : commonPrefixLength(dirA, dirB) / maxDepth;

  const stemA = pathStem(a);
  const stemB = pathStem(b);
  const stemScore =
    stemA !== "" && stemA === stemB && !GENERIC_STEMS.has(stemA) ? 1 : 0;

  const layerScore = sharesLayerSegment(dirA, dirB) ? 1 : 0;

  let score = W_DIR * dirScore + W_STEM * stemScore + W_LAYER * layerScore;

  // §11.7: different monorepo packages cluster separately without --scope.
  const pkgA = packageRoot(segA);
  const pkgB = packageRoot(segB);
  if (pkgA !== null && pkgB !== null && pkgA !== pkgB) {
    score *= 0.2;
  }

  return Math.min(1, Math.max(0, score));
}
