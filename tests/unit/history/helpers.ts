/**
 * Literal constructors for building minimal but valid `ReviewReport` fixtures
 * (src/types.ts) for the history-store tests, without depending on the
 * ingest/cluster/rules modules (built in parallel).
 */
import type { ChecklistItem, Cluster, Finding, Hunk, ReviewReport, Severity } from "../../../src/types.js";

let hunkSeq = 0;

export function hunk(filePath: string, opts?: { hash?: string }): Hunk {
  hunkSeq += 1;
  return {
    filePath,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [],
    hash: opts?.hash ?? `hunk-${hunkSeq}`,
  };
}

let clusterSeq = 0;

export function cluster(hunks: Hunk[], opts?: { id?: string; label?: string; severity?: Severity }): Cluster {
  clusterSeq += 1;
  return {
    id: opts?.id ?? `c${clusterSeq}`,
    label: opts?.label ?? "test cluster",
    files: [],
    hunks,
    symbols: [],
    added: hunks.length,
    removed: 0,
    severity: opts?.severity ?? "low",
  };
}

export function finding(overrides: Partial<Finding> & { hunkHash: string; ruleId: string }): Finding {
  return {
    severity: "medium",
    baseSeverity: "medium",
    file: "src/a.ts",
    line: 1,
    evidence: "evidence",
    message: "message",
    checklist: ["check it"],
    manualTests: [],
    ...overrides,
  };
}

export function checklistItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    severity: "medium",
    text: "check something",
    clusterId: "c1",
    clusterLabel: "test cluster",
    acknowledged: false,
    ...overrides,
  };
}

/** A minimal, fully-valid `ReviewReport` — override whatever the test cares about. */
export function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    toolVersion: "0.1.0-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    repo: { root: "/repo", name: "repo" },
    range: { desc: "staged" },
    mode: { llm: false, offline: true },
    stats: {
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 0,
      durationMs: 10,
      ignored: { count: 0, byReason: {}, examples: [] },
    },
    clusters: [],
    findings: [],
    checklist: [],
    manualTests: [],
    manualTestsCapped: 0,
    previouslyReviewed: { hunkCount: 0, findingCount: 0, findings: [] },
    infoFindings: [],
    footer: { astAnalyzed: 0, astSkipped: 0, historyAvailable: true, notices: [] },
    ...overrides,
  };
}
