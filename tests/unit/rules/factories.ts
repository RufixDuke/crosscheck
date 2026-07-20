/**
 * Literal constructors for the shared diff/cluster types (src/types.ts).
 * Tests must NOT import src/ingest or src/cluster (built in parallel) — every
 * Cluster/DiffFile/Hunk object used by the rule tests is built here by hand.
 */
import type {
  Cluster,
  CrossCheckConfig,
  DiffFile,
  DiffLine,
  Hunk,
  RiskRule,
} from "../../../src/types.js";
import type { RuleContext } from "../../../src/rules/context.js";
import type { EffectiveRule } from "../../../src/rules/engine.js";

export function add(content: string, newLine?: number): DiffLine {
  return newLine === undefined
    ? { type: "add", content }
    : { type: "add", content, newLine };
}

export function del(content: string, oldLine?: number): DiffLine {
  return oldLine === undefined
    ? { type: "del", content }
    : { type: "del", content, oldLine };
}

export function ctx(content: string, oldLine?: number, newLine?: number): DiffLine {
  return {
    type: "context",
    content,
    ...(oldLine === undefined ? {} : { oldLine }),
    ...(newLine === undefined ? {} : { newLine }),
  };
}

let hunkSeq = 0;

/**
 * Build a hunk, auto-assigning 1-based line numbers where the caller left
 * them out (old/new counters advance independently over del/add lines).
 */
export function hunk(
  filePath: string,
  lines: DiffLine[],
  opts?: { oldStart?: number; newStart?: number; hash?: string; section?: string },
): Hunk {
  let oldN = opts?.oldStart ?? 1;
  let newN = opts?.newStart ?? 1;
  const assigned = lines.map((line): DiffLine => {
    if (line.type === "add") {
      const newLine = line.newLine ?? newN;
      newN = newLine + 1;
      return { ...line, newLine };
    }
    if (line.type === "del") {
      const oldLine = line.oldLine ?? oldN;
      oldN = oldLine + 1;
      return { ...line, oldLine };
    }
    const oldLine = line.oldLine ?? oldN;
    const newLine = line.newLine ?? newN;
    oldN = oldLine + 1;
    newN = newLine + 1;
    return { ...line, oldLine, newLine };
  });

  const firstOld = assigned.find((line) => line.oldLine !== undefined)?.oldLine ?? opts?.oldStart ?? 1;
  const firstNew = assigned.find((line) => line.newLine !== undefined)?.newLine ?? opts?.newStart ?? 1;
  const oldLines = assigned.filter((line) => line.type !== "add").length;
  const newLines = assigned.filter((line) => line.type !== "del").length;

  hunkSeq += 1;
  return {
    filePath,
    oldStart: firstOld,
    oldLines,
    newStart: firstNew,
    newLines,
    ...(opts?.section === undefined ? {} : { section: opts.section }),
    lines: assigned,
    hash: opts?.hash ?? `hunk-${hunkSeq}`,
  };
}

export function file(
  path: string,
  hunks: Hunk[],
  opts?: { isNew?: boolean; isDeleted?: boolean; renamedFrom?: string },
): DiffFile {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.type === "add") added += 1;
      if (line.type === "del") removed += 1;
    }
  }
  return {
    path,
    ...(opts?.renamedFrom === undefined ? {} : { renamedFrom: opts.renamedFrom }),
    hunks,
    added,
    removed,
    ...(opts?.isNew === undefined ? {} : { isNew: opts.isNew }),
    ...(opts?.isDeleted === undefined ? {} : { isDeleted: opts.isDeleted }),
  };
}

let clusterSeq = 0;

export function cluster(files: DiffFile[], opts?: { id?: string; label?: string }): Cluster {
  clusterSeq += 1;
  return {
    id: opts?.id ?? `c-test-${clusterSeq}`,
    label: opts?.label ?? files[0]?.path ?? "cluster",
    files,
    hunks: files.flatMap((f) => f.hunks),
    symbols: [],
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0),
    severity: "low",
  };
}

export function context(overrides?: Partial<RuleContext>): RuleContext {
  return {
    readFileAtHead: overrides?.readFileAtHead ?? (async () => null),
    readWorkingFile: overrides?.readWorkingFile ?? (async () => null),
    dependencies: overrides?.dependencies !== undefined ? overrides.dependencies : null,
    dependencySignalsEnabled: overrides?.dependencySignalsEnabled ?? true,
  };
}

export function effective(rule: RiskRule, over?: Partial<EffectiveRule>): EffectiveRule {
  return { ...rule, provenance: "built-in", enabled: true, ...over };
}

/** Minimal valid rule; override any field per test. */
export function customRule(partial: Partial<RiskRule> & { id: string }): RiskRule {
  const { id } = partial;
  return {
    name: id,
    category: "custom",
    severity: "medium",
    enabledByDefault: true,
    description: `${id} test rule`,
    when: {},
    then: { message: id, checklist: [`checklist for ${id}`], manualTests: [] },
    ...partial,
  };
}

export function config(rules?: Partial<CrossCheckConfig["rules"]>): CrossCheckConfig {
  return {
    version: 1,
    rules: {
      disable: [],
      enable: [],
      dependencySignals: true,
      severityOverrides: {},
      custom: [],
      ...rules,
    },
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
    },
    strict: { failOn: "high" },
    output: { format: "terminal", color: true, maxTests: 12, maxClusters: 8 },
    history: { enabled: true, dbPath: ".git/crosscheck/history.db" },
  };
}
