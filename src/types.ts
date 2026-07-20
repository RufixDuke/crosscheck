/**
 * Shared types for CrossCheck — the single contract every module builds against.
 * Spec: CROSSCHECK_PRD.md §6 (architecture), §7 (rule engine), §9 (CLI), §12 (config).
 */

// ---------------------------------------------------------------------------
// Rules (§7.1)
// ---------------------------------------------------------------------------

export type Severity = "high" | "medium" | "low"; // rendered ▲ ● ■

export type FailureArchetype = "A1" | "A2" | "A3" | "A4";

export type RuleCategory =
  | "auth/session"
  | "payments"
  | "db-migrations/schema"
  | "crypto/secrets"
  | "custom";

export type AstMatcher =
  | { kind: "CallExpression"; callee: string; argsRegex?: string[] }
  | { kind: "NewExpression"; callee: string }
  | { kind: "StringAssignment"; nameRegex: string; valueRegex: string }
  | { kind: "ImportFrom"; moduleRegex: string };

export interface DependencySignal {
  downgradeTo?: Severity;
  note?: string;
  swapRemediation?: string;
}

export interface RiskRule {
  id: string; // stable, kebab-case, namespaced: "auth/session-rewrite"
  name: string;
  category: RuleCategory | (string & {});
  severity: Severity;
  enabledByDefault: boolean;
  archetype?: FailureArchetype;
  description: string;
  when: {
    fileGlobs?: string[];
    addedLines?: string[];
    removedLines?: string[];
    ast?: AstMatcher[];
    requireAll?: boolean;
    notAddedWith?: string[];
    verifyInFile?: boolean;
  };
  dependencySignals?: Record<string, DependencySignal>;
  then: {
    message: string;
    checklist: string[];
    manualTests?: string[];
    references?: string[];
  };
}

// ---------------------------------------------------------------------------
// Diff ingest (§6.2 steps 2–3)
// ---------------------------------------------------------------------------

export interface DiffLine {
  type: "add" | "del" | "context";
  content: string; // line content without the leading +/-/space marker
  oldLine?: number; // 1-based line number in old file (del/context only)
  newLine?: number; // 1-based line number in new file (add/context only)
}

export interface Hunk {
  filePath: string; // normalized new path (renames → new path)
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string; // @@ ... @@ trailing section heading, if any
  lines: DiffLine[];
  hash: string; // hunkHash, §6.2 step 3
}

export interface DiffFile {
  path: string;
  renamedFrom?: string;
  hunks: Hunk[];
  added: number; // added line count
  removed: number; // removed line count
  isNew?: boolean; // new file mode
  isDeleted?: boolean;
}

export type IgnoreReason = "binary" | "lockfile" | "generated" | "user-ignore";

export interface IgnoredFile {
  path: string;
  reason: IgnoreReason;
}

export interface ParsedDiff {
  files: DiffFile[];
  ignored: IgnoredFile[];
  stats: { filesChanged: number; linesAdded: number; linesRemoved: number };
}

/** Where the diff came from. */
export type RangeSpec =
  | { kind: "staged" }
  | { kind: "worktree" }
  | { kind: "range"; range: string }
  | { kind: "stdin"; text: string };

// ---------------------------------------------------------------------------
// Clustering (§5.4)
// ---------------------------------------------------------------------------

export interface Cluster {
  id: string; // stable within a run: "c1", "c2", … ordered by severity then size
  label: string; // e.g. "auth/session rewrite"
  files: DiffFile[];
  hunks: Hunk[];
  symbols: string[]; // changed function/class names when known (ts-morph)
  added: number;
  removed: number;
  severity: Severity; // max of its findings, "low" when none
}

// ---------------------------------------------------------------------------
// Findings (§7.1 evaluation semantics)
// ---------------------------------------------------------------------------

export interface Finding {
  ruleId: string;
  severity: Severity; // post dependency-signal adjustment
  baseSeverity: Severity; // as declared on the rule
  file: string;
  line: number;
  evidence: string; // matched text, trimmed
  message: string;
  checklist: string[];
  manualTests: string[];
  note?: string; // dependency-signal note or downgrade note
  info?: boolean; // §7.9: guard found elsewhere in file → informational only
  infoReason?: string; // e.g. "guard found at line 40 — downgraded to info"
  hunkHash: string;
  acknowledged?: boolean; // seen-and-acked in HistoryStore
  ackedAt?: string;
}

// ---------------------------------------------------------------------------
// Checklist & report (§6.2 steps 6–8)
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  severity: Severity;
  text: string;
  file?: string;
  line?: number;
  ruleId?: string; // undefined for generic hygiene items
  clusterId: string;
  clusterLabel: string;
  acknowledged: boolean;
  ackedAt?: string;
}

export interface ManualTestSuggestion {
  severity: Severity;
  text: string;
  clusterId: string;
  clusterLabel: string;
}

export interface LLMSummary {
  clusterId: string;
  clusterLabel: string;
  severity: Severity;
  status: "ok" | "unavailable" | "skipped";
  summary?: string; // ≤2 sentences, what changed
  doubleCheck?: string[]; // ≤3 bullets
  tokensIn?: number;
  tokensOut?: number;
  reason?: string; // when status != ok
}

export interface IgnoredSummary {
  count: number;
  byReason: Partial<Record<IgnoreReason, number>>;
  examples: string[]; // up to a few names for the footer
}

export interface ReviewReport {
  toolVersion: string;
  createdAt: string; // ISO
  repo: { root: string; name: string } | null; // null in --stdin mode
  range: {
    desc: string; // "staged" | "worktree" | "HEAD~3..HEAD" | "stdin"
    baseRef?: string;
    headRef?: string;
    commitCount?: number;
    mergeCount?: number;
    scope?: string;
  };
  mode: {
    llm: boolean;
    provider?: string;
    model?: string;
    offline: boolean;
  };
  stats: {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    durationMs: number;
    ignored: IgnoredSummary;
  };
  clusters: Cluster[];
  findings: Finding[]; // active findings (unacknowledged, non-info)
  checklist: ChecklistItem[]; // active items only
  manualTests: ManualTestSuggestion[];
  manualTestsCapped: number; // how many were cut by the cap (0 = none)
  previouslyReviewed: {
    hunkCount: number;
    findingCount: number;
    lastAckedAt?: string;
    findings: Finding[]; // the collapsed ones (for --all)
  };
  infoFindings: Finding[]; // §7.9 downgraded-to-info (for --verbose/--all)
  llm?: {
    summaries: LLMSummary[];
    notSummarized: { clusterLabel: string; reason: string }[];
    tokensIn: number;
    tokensOut: number;
    costUsd?: number; // undefined = unknown
    redactions: number;
  };
  footer: {
    astAnalyzed: number; // files analyzed by ts-morph
    astSkipped: number; // non-TS/JS or unparseable
    historyAvailable: boolean;
    notices: string[]; // one-line notices (merge commits, no-history, …)
  };
  strict?: {
    failOn: Severity;
    unacknowledgedAtOrAbove: number;
    passed: boolean;
  };
}

// ---------------------------------------------------------------------------
// Configuration (§12)
// ---------------------------------------------------------------------------

export type LLMProviderName = "anthropic" | "openai" | "openrouter";

export interface CrossCheckConfig {
  version: 1;
  rules: {
    disable: string[];
    enable: string[]; // opt-in built-ins to turn ON (§7.2)
    dependencySignals: boolean;
    severityOverrides: Record<string, Severity>;
    custom: RiskRule[];
  };
  ignore: string[];
  llm: {
    provider: LLMProviderName | null;
    model: string | null;
    apiKeyEnv: string | null;
    maxTokensPerReview: number;
    maxTokensPerCluster: number;
    maxCostUsdPerReview: number;
    temperature: number;
    timeoutMs: number;
    anonymizePaths: boolean;
    consentGiven: Record<string, boolean>;
  };
  strict: { failOn: Severity };
  output: {
    format: "terminal" | "markdown" | "json";
    color: boolean;
    maxTests: number;
    maxClusters: number;
  };
  history: { enabled: boolean; dbPath: string };
}

export interface ReviewFlags {
  staged?: boolean;
  worktree?: boolean;
  stdin?: boolean;
  llm?: boolean;
  requireLlm?: boolean;
  showPrompt?: boolean;
  offline?: boolean;
  strict?: boolean;
  failOn?: Severity;
  format?: "terminal" | "markdown" | "json";
  all?: boolean;
  ack?: boolean;
  scope?: string;
  maxFiles?: number;
  maxTests?: number;
  yes?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  configPath?: string;
}

// ---------------------------------------------------------------------------
// History (§6.3)
// ---------------------------------------------------------------------------

export interface HunkRecord {
  hash: string;
  filePath: string;
  ruleIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  timesSeen: number;
  acknowledged: boolean;
  ackedAt?: string;
}

export interface ReviewRecord {
  id: number;
  rangeDesc: string;
  createdAt: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  clusterCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  llmUsed: boolean;
  llmProvider?: string;
  llmModel?: string;
  durationMs: number;
  verdict: "clean" | "findings" | "strict-fail" | "error";
}

/**
 * The storage abstraction (§5.6/§6.3). The analysis pipeline only ever sees
 * this interface; a failed sql.js load swaps in a no-op implementation.
 */
export interface HistoryStore {
  readonly available: boolean;
  /** Batch lookup of hunk hashes → records (for dedup). */
  lookupHunks(hashes: string[]): Map<string, HunkRecord>;
  /** Persist one finished review + its hunks + checklist items. Returns review id or null. */
  recordReview(report: ReviewReport, repoRoot: string): number | null;
  /** Mark hunk hashes acknowledged (--ack). */
  acknowledge(hashes: string[]): void;
  listReviews(repoRoot: string | null, limit?: number): ReviewRecord[];
  getReview(id: number): { review: ReviewRecord; items: ChecklistItem[] } | null;
  hunkStats(repoRoot: string | null): { tracked: number; acknowledged: number };
  clear(): void;
  /** Write-through persist (§5.6). Never throws; flips to unavailable on failure. */
  persist(): void;
  close(): void;
}
