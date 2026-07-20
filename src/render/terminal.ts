/**
 * Terminal renderer — PRD §9.2 (worked example is the ground truth for
 * section order and content), F3/F4/F5/F10 (§8), §5.7 (rendering decision).
 *
 * Takes an explicit `{ color }` (and optional `verbose`) option rather than
 * reading `process.stdout`/`NO_COLOR` itself, so it is unit-testable without
 * a real TTY — the CLI layer (built elsewhere) resolves `isTTY`/`--no-color`
 * /`NO_COLOR` down to this one boolean.
 */
import pc from "picocolors";
import type { ChecklistItem, Cluster, ReviewReport, Severity } from "../types.js";
import { DIVIDER, SEVERITY_SYMBOL, SEVERITY_WORD, formatLines, pluralize, relativeTime } from "./format.js";

export interface TerminalRenderOptions {
  color: boolean;
  /** Expands truncated checklist/manual-test sections and shows rule ids. */
  verbose?: boolean;
}

/**
 * Non-verbose checklist item budget (F4: "… N more items (use --verbose to
 * expand)"). The PRD's §9.2 worked example truncates at 7 of 14 items but
 * does not name the constant explicitly — this mirrors that example. A
 * judgment call pending real UX tuning; not a value derived from config
 * because no `output.maxChecklistItems` field exists on `CrossCheckConfig`.
 */
const NON_VERBOSE_CHECKLIST_LIMIT = 7;

/** The object returned by `pc.createColors(enabled)` — not exported by name from picocolors. */
type PicoColors = ReturnType<typeof pc.createColors>;

function severityColor(colors: PicoColors, severity: Severity): (s: string) => string {
  if (severity === "high") return colors.red;
  if (severity === "medium") return colors.yellow;
  return colors.cyan;
}

function clusterSeverity(clusters: Cluster[], clusterId: string): Severity {
  return clusters.find((c) => c.id === clusterId)?.severity ?? "low";
}

export function renderTerminal(report: ReviewReport, opts: TerminalRenderOptions): string {
  const colors = pc.createColors(opts.color);
  const verbose = opts.verbose ?? false;
  const lines: string[] = [];

  renderHeader(lines, report, colors);
  lines.push("");
  renderRiskMap(lines, report, colors);
  lines.push("");
  renderChecklist(lines, report, colors, verbose);
  lines.push("");
  renderManualTests(lines, report, colors, verbose);

  if (report.previouslyReviewed.hunkCount > 0) {
    lines.push("");
    renderPreviouslyReviewed(lines, report);
  }

  lines.push("");
  renderFooter(lines, report, colors);

  return lines.join("\n");
}

function renderHeader(lines: string[], report: ReviewReport, colors: PicoColors): void {
  const { stats, range, mode, repo } = report;
  lines.push(colors.bold(`CrossCheck v${report.toolVersion} — pre-push self-review`));
  lines.push(`repo:    ${repo === null ? "(stdin)" : repo.name}`);
  lines.push(`range:   ${range.desc} (${pluralize(stats.filesChanged, "file")}, ${formatLines(stats.linesAdded, stats.linesRemoved)})`);
  const modeLabel = mode.llm
    ? `llm (${[mode.provider, mode.model].filter((v): v is string => Boolean(v)).join("/")})`
    : "heuristic";
  const durationS = (stats.durationMs / 1000).toFixed(1);
  lines.push(`mode:    ${modeLabel} (${mode.offline ? "offline" : "online"}) · ${durationS}s`);
}

function renderRiskMap(lines: string[], report: ReviewReport, colors: PicoColors): void {
  const { clusters, stats } = report;
  const highCount = clusters.filter((c) => c.severity === "high").length;
  const title = highCount > 0 ? `RISK MAP — ${pluralize(highCount, "high-risk cluster")} in ${pluralize(stats.filesChanged, "file")}` : "RISK MAP";
  lines.push(colors.bold(title));
  lines.push(DIVIDER);

  // F3 AC2: no findings ⇒ one reassuring line instead of an empty table.
  if (report.findings.length === 0) {
    lines.push(` all ${pluralize(clusters.length, "cluster")} are low-risk by current rules — still read the diff`);
    lines.push(DIVIDER);
    renderIgnored(lines, report);
    return;
  }

  for (const cluster of clusters) {
    const symbol = SEVERITY_SYMBOL[cluster.severity];
    const color = severityColor(colors, cluster.severity);
    const label = cluster.label.padEnd(30);
    const filesCol = pluralize(cluster.files.length, "file").padStart(8);
    const linesCol = formatLines(cluster.added, cluster.removed).padEnd(14);
    lines.push(color(` ${symbol}  ${label} ${filesCol}   ${linesCol}${SEVERITY_WORD[cluster.severity]}`));
  }
  lines.push(DIVIDER);
  renderIgnored(lines, report);
}

function renderIgnored(lines: string[], report: ReviewReport): void {
  const { ignored } = report.stats;
  if (ignored.count === 0) return;
  const reasons = Object.keys(ignored.byReason).join("/");
  const shown = ignored.examples.join(", ");
  const extra = ignored.count > ignored.examples.length ? ` +${ignored.count - ignored.examples.length} more` : "";
  lines.push(` ignored: ${shown}${extra}${reasons ? ` (${reasons})` : ""}`);
}

function renderChecklist(lines: string[], report: ReviewReport, colors: PicoColors, verbose: boolean): void {
  const { checklist } = report;
  const highCount = checklist.filter((item) => item.severity === "high").length;
  lines.push(colors.bold(`REVIEW CHECKLIST — ${pluralize(checklist.length, "item")} (${pluralize(highCount, "high-risk")} first)`));
  lines.push(DIVIDER);

  const limit = verbose ? checklist.length : Math.min(checklist.length, NON_VERBOSE_CHECKLIST_LIMIT);
  const visible = checklist.slice(0, limit);

  let lastClusterId: string | undefined;
  visible.forEach((item, index) => {
    if (item.clusterId !== lastClusterId) {
      lastClusterId = item.clusterId;
      const sev = clusterSeverity(report.clusters, item.clusterId);
      lines.push(colors.bold(`${SEVERITY_SYMBOL[sev]} ${item.clusterLabel}`));
    }
    lines.push(`  ${renderChecklistLine(item, index + 1, report.createdAt, colors)}`);
  });

  const hidden = checklist.length - visible.length;
  if (hidden > 0) {
    lines.push(`  … ${pluralize(hidden, "more item")} (use --verbose to expand)`);
  }
}

function renderChecklistLine(item: ChecklistItem, index: number, createdAt: string, colors: PicoColors): string {
  if (item.acknowledged) {
    const since = item.ackedAt !== undefined ? ` (reviewed ${relativeTime(item.ackedAt, createdAt)})` : "";
    return colors.dim(`✓ ${index}. ${item.text}${since}`);
  }

  const parts = [`☐ ${index}. ${item.text}`];
  if (item.file !== undefined) {
    parts.push(`(${item.file}${item.line !== undefined ? `:${item.line}` : ""})`);
  }
  if (item.ruleId !== undefined) {
    parts.push(`[${item.ruleId}]`);
  } else {
    parts.push("(general)");
  }
  return parts.join(" ");
}

function renderManualTests(lines: string[], report: ReviewReport, colors: PicoColors, verbose: boolean): void {
  lines.push(colors.bold("SUGGESTED MANUAL TESTS"));
  lines.push(DIVIDER);
  if (report.manualTests.length === 0) {
    lines.push("  (none suggested by the rules that fired)");
  }
  for (const test of report.manualTests) {
    lines.push(`  ${SEVERITY_SYMBOL[test.severity]} ${test.text}`);
  }
  if (report.manualTestsCapped > 0 && !verbose) {
    lines.push(`  +${report.manualTestsCapped} more in --verbose`);
  }
}

function renderPreviouslyReviewed(lines: string[], report: ReviewReport): void {
  const { hunkCount, lastAckedAt } = report.previouslyReviewed;
  const since = lastAckedAt !== undefined ? ` (from review ${relativeTime(lastAckedAt, report.createdAt)})` : "";
  lines.push(`Previously reviewed: ${pluralize(hunkCount, "hunk")} ✓${since} — hidden; --all to show`);
}

function renderFooter(lines: string[], report: ReviewReport, colors: PicoColors): void {
  const hints = ["--ack to mark all verified", "--strict to gate", "export --format markdown"];
  lines.push(`Next: ${hints.join(" · ")}`);
  lines.push(colors.dim("Note: rules catch patterns, not logic. You are still the reviewer."));
  if (report.footer.notices.length > 0) {
    for (const notice of report.footer.notices) lines.push(colors.dim(`Note: ${notice}`));
  }
}
