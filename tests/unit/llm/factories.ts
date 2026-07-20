/**
 * Minimal literal constructors for Cluster/DiffFile/Hunk/Finding/Config,
 * built by hand for the LLM-layer tests (mirrors the pattern used in
 * tests/unit/rules/factories.ts, built independently here since src/llm is
 * developed in isolation from src/rules).
 */
import type { Cluster, CrossCheckConfig, DiffFile, DiffLine, Finding, Hunk, Severity } from "../../../src/types.js";

export function add(content: string, newLine?: number): DiffLine {
  return newLine === undefined ? { type: "add", content } : { type: "add", content, newLine };
}

let hunkSeq = 0;

export function hunk(filePath: string, lines: DiffLine[], opts?: { hash?: string }): Hunk {
  let newN = 1;
  const assigned = lines.map((line): DiffLine => {
    if (line.type === "add") {
      const newLine = line.newLine ?? newN;
      newN = newLine + 1;
      return { ...line, newLine };
    }
    return line;
  });
  hunkSeq += 1;
  return {
    filePath,
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: assigned.length,
    lines: assigned,
    hash: opts?.hash ?? `hunk-${hunkSeq}`,
  };
}

export function file(path: string, hunks: Hunk[]): DiffFile {
  let added = 0;
  for (const h of hunks) for (const l of h.lines) if (l.type === "add") added += 1;
  return { path, hunks, added, removed: 0 };
}

let clusterSeq = 0;

export function cluster(
  files: DiffFile[],
  opts?: { id?: string; label?: string; severity?: Severity },
): Cluster {
  clusterSeq += 1;
  return {
    id: opts?.id ?? `c-test-${clusterSeq}`,
    label: opts?.label ?? files[0]?.path ?? "cluster",
    files,
    hunks: files.flatMap((f) => f.hunks),
    symbols: [],
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0),
    severity: opts?.severity ?? "low",
  };
}

export function finding(partial: Partial<Finding> & { ruleId: string; hunkHash: string }): Finding {
  return {
    severity: "high",
    baseSeverity: "high",
    file: "src/x.ts",
    line: 1,
    evidence: "evidence",
    message: "message",
    checklist: [],
    manualTests: [],
    ...partial,
  };
}

export function config(overrides?: {
  llm?: Partial<CrossCheckConfig["llm"]>;
}): CrossCheckConfig {
  return {
    version: 1,
    rules: { disable: [], enable: [], dependencySignals: true, severityOverrides: {}, custom: [] },
    ignore: [],
    llm: {
      provider: null,
      model: null,
      apiKeyEnv: null,
      maxTokensPerReview: 48000,
      maxTokensPerCluster: 6000,
      maxCostUsdPerReview: 0.25,
      temperature: 0.2,
      timeoutMs: 30000,
      anonymizePaths: false,
      consentGiven: {},
      ...overrides?.llm,
    },
    strict: { failOn: "high" },
    output: { format: "terminal", color: true, maxTests: 12, maxClusters: 8 },
    history: { enabled: true, dbPath: ".git/crosscheck/history.db" },
  };
}
