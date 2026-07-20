/**
 * Literal constructors for src/types.ts objects, scoped to the
 * checklist/render test suites. Mirrors tests/unit/rules/factories.ts but
 * lives separately since checklist/render must not import across the
 * in-parallel-development module boundary either.
 */
import type { Cluster, DiffFile, Finding, Hunk, ReviewReport, Severity } from "../../../src/types.js";

let hunkSeq = 0;

export function hunk(filePath: string, overrides?: Partial<Hunk>): Hunk {
  hunkSeq += 1;
  return {
    filePath,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [],
    hash: `hunk-${hunkSeq}`,
    ...overrides,
  };
}

export function file(path: string, overrides?: Partial<DiffFile>): DiffFile {
  return {
    path,
    hunks: [hunk(path)],
    added: 1,
    removed: 0,
    ...overrides,
  };
}

export function cluster(overrides?: Partial<Cluster> & { files?: DiffFile[] }): Cluster {
  const files = overrides?.files ?? [file(`${overrides?.id ?? "c"}/file.ts`)];
  return {
    id: "c1",
    label: "test cluster",
    files,
    hunks: files.flatMap((f) => f.hunks),
    symbols: [],
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    severity: "low",
    ...overrides,
  };
}

let findingSeq = 0;

export function finding(overrides?: Partial<Finding>): Finding {
  findingSeq += 1;
  return {
    ruleId: `rule-${findingSeq}`,
    severity: "medium",
    baseSeverity: "medium",
    file: "src/file.ts",
    line: 10,
    evidence: "evidence",
    message: `finding ${findingSeq}`,
    checklist: [`checklist item ${findingSeq}`],
    manualTests: [],
    hunkHash: `hunk-${findingSeq}`,
    ...overrides,
  };
}

/** Minimal valid ReviewReport; override any field per test. */
export function report(overrides?: Partial<ReviewReport>): ReviewReport {
  const clusters = overrides?.clusters ?? [cluster()];
  return {
    toolVersion: "0.1.0",
    createdAt: "2026-07-19T14:02:00.000Z",
    repo: { root: "/repo", name: "test-repo" },
    range: { desc: "staged" },
    mode: { llm: false, offline: true },
    stats: {
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 0,
      durationMs: 1000,
      ignored: { count: 0, byReason: {}, examples: [] },
    },
    clusters,
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

export function severities(): Severity[] {
  return ["high", "medium", "low"];
}
