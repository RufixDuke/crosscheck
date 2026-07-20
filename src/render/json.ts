/**
 * JSON renderer — machine/CI format (§9.8 `--json`), F9/F10 (§8).
 *
 * Serializes the full `ReviewReport` (stable key order, matching the field
 * order declared on the type in src/types.ts) plus a `summary` object
 * mirroring the PRD §9.8 `--json | jq '.summary'` example:
 * `range, files, added, removed, clusters, findings{high,medium,low,
 * acknowledged}, failOn, durationMs`.
 *
 * `summary.exitCode` is part of the documented shape (F9 AC4) but exit-code
 * computation is a CLI-layer concern (§9.8's threshold-vs-highest-severity
 * logic) that is out of scope for this module — it is emitted as `null`
 * here and is expected to be patched in by the CLI layer before the process
 * actually exits.
 */
import type { ReviewReport, Severity } from "../types.js";

interface JsonSummary {
  range: string;
  files: number;
  added: number;
  removed: number;
  clusters: number;
  findings: { high: number; medium: number; low: number; acknowledged: number };
  failOn: Severity | null;
  /** Patched in by the CLI layer (§9.8) — not computed by the renderer. */
  exitCode: number | null;
  durationMs: number;
}

function countBySeverity(report: ReviewReport): { high: number; medium: number; low: number } {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const finding of report.findings) {
    if (finding.severity === "high") high += 1;
    else if (finding.severity === "medium") medium += 1;
    else low += 1;
  }
  return { high, medium, low };
}

function buildSummary(report: ReviewReport): JsonSummary {
  const { high, medium, low } = countBySeverity(report);
  return {
    range: report.range.desc,
    files: report.stats.filesChanged,
    added: report.stats.linesAdded,
    removed: report.stats.linesRemoved,
    clusters: report.clusters.length,
    findings: { high, medium, low, acknowledged: report.previouslyReviewed.findingCount },
    failOn: report.strict?.failOn ?? null,
    exitCode: null,
    durationMs: report.stats.durationMs,
  };
}

export function renderJson(report: ReviewReport): string {
  // Explicit field order mirrors the ReviewReport declaration in
  // src/types.ts — stable across runs/machines for snapshot testing (§15).
  const payload = {
    toolVersion: report.toolVersion,
    createdAt: report.createdAt,
    repo: report.repo,
    range: report.range,
    mode: report.mode,
    stats: report.stats,
    clusters: report.clusters,
    findings: report.findings,
    checklist: report.checklist,
    manualTests: report.manualTests,
    manualTestsCapped: report.manualTestsCapped,
    previouslyReviewed: report.previouslyReviewed,
    infoFindings: report.infoFindings,
    llm: report.llm,
    footer: report.footer,
    strict: report.strict,
    summary: buildSummary(report),
  };

  return JSON.stringify(payload, null, 2);
}
