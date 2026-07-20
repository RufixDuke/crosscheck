/**
 * Cluster labeling — §5.4 layer 3. Produces short (≤ ~30 chars) human labels
 * in the style of the §9.2 sample risk map: dominant directory + a qualifier
 * derived from changed symbols when known, else the dominant filename stem,
 * with special shapes for migration clusters (`db: family_plans migration`)
 * and pure-style clusters (`UI polish`).
 *
 * Fully deterministic: given the same files (in the same order) and symbols,
 * the label is always identical.
 */
import type { DiffFile } from "../types.js";
import { pathStem } from "./affinity.js";

/** Labels are capped at this length (§9.2 renders them in a fixed-width row). */
export const MAX_LABEL_LENGTH = 30;

const STYLE_EXTENSIONS = new Set(["css", "scss", "sass", "less", "styl", "pcss"]);

/** Stems too generic to carry meaning in a label. */
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

/** CRUD verb buckets; ≥ 3 distinct buckets among symbols ⇒ "… CRUD". */
const CRUD_BUCKETS: readonly RegExp[] = [
  /creat|insert/,
  /(^|[^a-z])(get|read|list|fetch|find)/,
  /updat|edit|patch/,
  /delet|remov|destroy/,
];

function splitPath(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".");
}

function dirSegments(path: string): string[] {
  return splitPath(path).slice(0, -1);
}

function extOf(path: string): string {
  const base = splitPath(path).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1);
}

function commonPrefix(segmentLists: string[][]): string[] {
  const first = segmentLists[0];
  if (first === undefined) return [];
  let i = 0;
  for (; i < first.length; i++) {
    const seg = first[i];
    if (!segmentLists.every((list) => list[i] === seg)) break;
  }
  return first.slice(0, i);
}

/** Most frequent stem (ties → first seen in file order). Never generic-checked. */
function dominantStem(stems: string[]): string {
  let best = "";
  let bestCount = 0;
  const counts = new Map<string, number>();
  for (const stem of stems) {
    const count = (counts.get(stem) ?? 0) + 1;
    counts.set(stem, count);
    if (count > bestCount) {
      best = stem;
      bestCount = count;
    }
  }
  return best;
}

/** Mode of the first path segment among nested files; "" when all are root-level. */
function mostCommonFirstSegment(paths: string[]): string {
  let best = "";
  let bestCount = 0;
  const counts = new Map<string, number>();
  for (const path of paths) {
    const segments = splitPath(path);
    if (segments.length < 2) continue;
    const first = segments[0] ?? "";
    const count = (counts.get(first) ?? 0) + 1;
    counts.set(first, count);
    if (count > bestCount) {
      best = first;
      bestCount = count;
    }
  }
  return best;
}

function isMigrationCluster(paths: string[], commonDir: string[]): boolean {
  if (commonDir.includes("migrations") || commonDir.includes("migration")) return true;
  return (
    paths.length > 0 && paths.every((p) => /(^|\/)\d+[_-][^/]*\.sql$/i.test(p))
  );
}

/** `0017_family_plans` → `family_plans`; leaves non-versioned stems alone. */
function migrationStem(stem: string): string {
  return stem.replace(/^\d+[_-]+/, "");
}

/**
 * Compact name for a symbol: the filename stem it contains (de-pluralized
 * match allowed, so `createProfile` matches stem `profiles`), else its first
 * camelCase/snake_case word. `sessionStore` → `session`, `verifyWebhook` →
 * `verify` (or a matching stem when one exists).
 */
function compactSymbolName(symbol: string, stems: string[]): string {
  const lower = symbol.toLowerCase();
  const candidates = stems
    .filter((s) => s !== "" && !GENERIC_STEMS.has(s))
    .sort((a, b) => b.length - a.length);
  for (const stem of candidates) {
    if (lower.includes(stem)) return stem;
    if (stem.endsWith("s") && stem.length > 1 && lower.includes(stem.slice(0, -1))) {
      return stem;
    }
  }
  const words = symbol
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter((w) => w !== "");
  return (words[0] ?? symbol).toLowerCase();
}

function isCrudCluster(symbols: string[]): boolean {
  let hits = 0;
  for (const bucket of CRUD_BUCKETS) {
    if (symbols.some((s) => bucket.test(s.toLowerCase()))) hits++;
  }
  return hits >= 3;
}

/** Hard cap, trimmed back to a clean boundary. */
function fit(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return label.slice(0, MAX_LABEL_LENGTH).replace(/[/:_\-\s.]+$/, "");
}

/**
 * Short human label for one cluster's files. `symbols` are the changed
 * function/class names when ts-morph supplied them (empty otherwise).
 */
export function labelCluster(files: DiffFile[], symbols: string[]): string {
  const paths = files.map((f) => f.path);
  const commonDir = commonPrefix(paths.map(dirSegments));

  // Pure stylesheet cluster.
  if (paths.length > 0 && paths.every((p) => STYLE_EXTENSIONS.has(extOf(p)))) {
    return "UI polish";
  }

  const stems = paths.map(pathStem);

  // Migration cluster: `db: <stem> migration`.
  if (isMigrationCluster(paths, commonDir)) {
    return fit(`db: ${migrationStem(dominantStem(stems))} migration`);
  }

  const base =
    commonDir.length > 0
      ? (commonDir[commonDir.length - 1] ?? "")
      : mostCommonFirstSegment(paths);

  // Symbols known: dominant dir + compact symbol name (or "… CRUD").
  if (symbols.length > 0) {
    const first = symbols[0];
    if (first !== undefined) {
      const compact = compactSymbolName(first, stems);
      if (isCrudCluster(symbols)) return fit(`${compact} CRUD`);
      return fit(base !== "" && base !== compact ? `${base}/${compact}` : compact);
    }
  }

  const stem = dominantStem(stems);
  if (base !== "" && stem !== "" && base !== stem && !GENERIC_STEMS.has(stem)) {
    return fit(`${base}/${stem}`);
  }
  if (base !== "") return fit(base);
  if (stem !== "") return fit(stem);
  return "misc changes";
}
