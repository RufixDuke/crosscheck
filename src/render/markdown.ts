/**
 * Markdown renderer — PRD §9.9 (worked example is ground truth), F10 (§8).
 * Self-contained markdown: real table, real GitHub task-list items, no
 * ANSI, no terminal-width assumptions — safe to paste into a PR body.
 */
import type { ReviewReport } from "../types.js";
import { SEVERITY_SYMBOL, SEVERITY_WORD_SHORT, formatLines, formatUtc, pluralize } from "./format.js";

export function renderMarkdown(report: ReviewReport): string {
  const lines: string[] = [];
  const { stats, range } = report;

  lines.push(`## CrossCheck review — ${range.desc} (${pluralize(stats.filesChanged, "file")}, ${formatLines(stats.linesAdded, stats.linesRemoved)})`);
  lines.push("");

  // F10 AC3: generation timestamp, tool version, and range — provenance for
  // the diligence-artifact use case.
  const modeLabel = report.mode.llm
    ? `llm (${[report.mode.provider, report.mode.model].filter((v): v is string => Boolean(v)).join("/")})`
    : "heuristic (offline)";
  lines.push(`_Generated ${formatUtc(report.createdAt)} · CrossCheck v${report.toolVersion} · ${modeLabel} mode_`);
  lines.push("");

  lines.push("### Risk map");
  lines.push("");
  if (report.findings.length === 0) {
    lines.push(`_all ${pluralize(report.clusters.length, "cluster")} are low-risk by current rules — still read the diff_`);
  } else {
    lines.push("| Severity | Cluster | Files | Lines |");
    lines.push("|---|---|---|---|");
    for (const cluster of report.clusters) {
      const sev = `${SEVERITY_SYMBOL[cluster.severity]} ${SEVERITY_WORD_SHORT[cluster.severity]}`;
      lines.push(`| ${sev} | ${cluster.label} | ${cluster.files.length} | ${formatLines(cluster.added, cluster.removed)} |`);
    }
  }
  lines.push("");

  if (report.stats.ignored.count > 0) {
    const reasons = Object.keys(report.stats.ignored.byReason).join("/");
    lines.push(`_Ignored: ${report.stats.ignored.examples.join(", ")}${reasons ? ` (${reasons})` : ""}_`);
    lines.push("");
  }

  lines.push("### Review checklist");
  lines.push("");
  if (report.checklist.length === 0) {
    lines.push("_Nothing to verify — no active findings._");
  } else {
    for (const item of report.checklist) {
      const box = item.acknowledged ? "[x]" : "[ ]";
      const label = item.ruleId === undefined ? "GENERAL" : SEVERITY_WORD_SHORT[item.severity];
      const location = item.file !== undefined ? ` — \`${item.file}${item.line !== undefined ? `:${item.line}` : ""}\`` : "";
      lines.push(`- ${box} **(${label})** ${item.text}${location}`);
    }
  }
  lines.push("");

  lines.push("### Manual tests performed");
  lines.push("");
  if (report.manualTests.length === 0) {
    lines.push("_No manual tests suggested by the rules that fired._");
  } else {
    for (const test of report.manualTests) {
      lines.push(`- [ ] ${test.text}`);
    }
    if (report.manualTestsCapped > 0) {
      lines.push(`- _+${report.manualTestsCapped} more suggestions omitted (cap reached; see \`--verbose\`)_`);
    }
  }
  lines.push("");

  if (report.previouslyReviewed.hunkCount > 0) {
    lines.push(`_Previously reviewed: ${pluralize(report.previouslyReviewed.hunkCount, "hunk")} ✓ (hidden — pass \`--all\` to include)_`);
    lines.push("");
  }

  lines.push("> Heuristics catch patterns, not logic. This report records that a human");
  lines.push("> reviewed the change; it is not a guarantee of correctness.");

  return lines.join("\n");
}
