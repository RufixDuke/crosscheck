/**
 * Shared, pure formatting helpers for the three renderers (§5.7, §9.2/§9.8/§9.9).
 * No ANSI here — color is applied by terminal.ts only, via picocolors.
 */
import type { Severity } from "../types.js";

/** ▲ ● ■ — §7.1 / F3. */
export const SEVERITY_SYMBOL: Record<Severity, string> = {
  high: "▲",
  medium: "●",
  low: "■",
};

/** Full severity word, as used in the terminal risk map (§9.2). */
export const SEVERITY_WORD: Record<Severity, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

/** Abbreviated severity word, as used in the markdown risk map table (§9.9). */
export const SEVERITY_WORD_SHORT: Record<Severity, string> = {
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};

/** `+A / −B` using the PRD's exact minus-sign glyph (U+2212), not a hyphen. */
export function formatLines(added: number, removed: number): string {
  return `+${added} / −${removed}`;
}

/** `N file` / `N files`. */
export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Coarse, deterministic relative-time phrase between two ISO timestamps
 * (e.g. "2 hours ago", "3 days ago"). Deliberately hand-rolled (no
 * `Intl.RelativeTimeFormat`) so output never depends on the host's ICU
 * data or locale — determinism matters for golden/snapshot tests (§15).
 */
export function relativeTime(fromIso: string, toIso: string): string {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return "recently";
  const diffMs = Math.max(0, to - from);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "just now";
  if (diffMs < hour) {
    const n = Math.floor(diffMs / minute);
    return `${n} minute${n === 1 ? "" : "s"} ago`;
  }
  if (diffMs < day) {
    const n = Math.floor(diffMs / hour);
    return `${n} hour${n === 1 ? "" : "s"} ago`;
  }
  const n = Math.floor(diffMs / day);
  return `${n} day${n === 1 ? "" : "s"} ago`;
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:MM UTC` using UTC field
 * accessors only — never `toLocaleString`, which would make markdown/JSON
 * output vary by host locale/timezone and break determinism (§15).
 */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** Horizontal rule used to delimit terminal sections (§9.2). */
export const DIVIDER = "─".repeat(68);
