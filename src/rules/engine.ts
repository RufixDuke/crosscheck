/**
 * The risk rule engine (§7) — deterministic, offline, ordered evaluation per
 * §7.1 steps 1–9:
 *
 *   1. glob gate per rule per file (picomatch, compiled once at engine init)
 *   2. addedLines/removedLines regexes over hunk lines of matching files
 *   3. AST matchers (TS/JS only, only for files loaded in the project)
 *   4. requireAll — every declared trigger KIND must fire at least once
 *   5. notAddedWith guard veto (guard in the cluster's added lines ⇒ discard)
 *   6. verifyInFile — re-check guards against the full current file (§7.9)
 *   7. dependencySignals — downgrade / note / swap remediation (§7.10)
 *   8. dedupe by (ruleId, file, line)
 *   9. cluster severity = max of its active findings; re-sort + re-id clusters
 *
 * Regex hygiene (§13.2): all patterns compile once at engine init; per-rule
 * evaluation time is measured and any rule exceeding 100 ms is reported in
 * `slowRules`. (True interruption of a pathological regex would require
 * worker isolation; the MVP measures and reports instead.)
 */
import { performance } from "node:perf_hooks";
import picomatch from "picomatch";
import { evaluateAstMatchers } from "../ast/matchers.js";
import type { AstProjectHandle } from "../ast/types.js";
import type {
  AstMatcher,
  Cluster,
  DiffFile,
  Finding,
  Hunk,
  RiskRule,
  Severity,
} from "../types.js";
import type { RuleContext } from "./context.js";
import { clipEvidence, compileRegex } from "./regex.js";

export interface EffectiveRule extends RiskRule {
  provenance: "built-in" | "config" | "overridden";
  enabled: boolean;
}

export interface EngineResult {
  findings: Finding[]; // active findings (excludes info)
  infoFindings: Finding[]; // §7.9 downgraded-to-info
  slowRules: { ruleId: string; ms: number }[]; // patterns > 100ms (§13.2 hygiene)
}

export interface EvaluateRulesOptions {
  clusters: Cluster[];
  rules: EffectiveRule[];
  context: RuleContext;
  ast?: AstProjectHandle | null;
  /** Project built from HEAD contents, for removed-code AST matchers. */
  oldFileAst?: AstProjectHandle | null;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
const SLOW_RULE_THRESHOLD_MS = 100;
const TS_JS_RE = /\.(ts|tsx|js|jsx|mts|cts)$/i;

/**
 * Built-in rules may tag an AST matcher with the side of the diff it targets
 * (e.g. auth/session-rewrite matches calls *removed* by the rewrite). The
 * §7.3 AstMatcher schema has no direction field, so this is an internal
 * extension carried only by built-in rules; default is "added".
 */
type MatcherTarget = "added" | "removed";

function matcherTarget(matcher: AstMatcher): MatcherTarget {
  const target = (matcher as AstMatcher & { target?: MatcherTarget }).target;
  return target === "removed" ? "removed" : "added";
}

interface CompiledRule {
  rule: EffectiveRule;
  globMatchers: Array<(path: string) => boolean>;
  addedLineRegexes: RegExp[];
  removedLineRegexes: RegExp[];
  guardRegexes: RegExp[];
  addedAstMatchers: AstMatcher[];
  removedAstMatchers: AstMatcher[];
}

function compileRule(rule: EffectiveRule): CompiledRule {
  const when = rule.when;
  const ast = when.ast ?? [];
  return {
    rule,
    globMatchers: (when.fileGlobs ?? []).map((glob) => picomatch(glob, { dot: true })),
    addedLineRegexes: (when.addedLines ?? []).map(compileRegex),
    removedLineRegexes: (when.removedLines ?? []).map(compileRegex),
    guardRegexes: (when.notAddedWith ?? []).map(compileRegex),
    addedAstMatchers: ast.filter((m) => matcherTarget(m) === "added"),
    removedAstMatchers: ast.filter((m) => matcherTarget(m) === "removed"),
  };
}

/** Merge sorted 1-based line numbers into consecutive [start, end] ranges. */
function buildLineRanges(lineNumbers: number[]): Array<readonly [number, number]> {
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  const ranges: Array<readonly [number, number]> = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const n of sorted) {
    if (start === undefined || prev === undefined) {
      start = n;
      prev = n;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push([start, prev] as const);
    start = n;
    prev = n;
  }
  if (start !== undefined && prev !== undefined) ranges.push([start, prev] as const);
  return ranges;
}

function addedLineRanges(file: DiffFile): Array<readonly [number, number]> {
  const lines: number[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add" && line.newLine !== undefined) lines.push(line.newLine);
    }
  }
  return buildLineRanges(lines);
}

function removedLineRanges(file: DiffFile): Array<readonly [number, number]> {
  const lines: number[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "del" && line.oldLine !== undefined) lines.push(line.oldLine);
    }
  }
  return buildLineRanges(lines);
}

function hunkForLine(file: DiffFile, line: number, target: MatcherTarget): Hunk | undefined {
  return file.hunks.find((hunk) =>
    target === "added"
      ? line >= hunk.newStart && line < hunk.newStart + hunk.newLines
      : line >= hunk.oldStart && line < hunk.oldStart + hunk.oldLines,
  );
}

type TriggerKind = "added" | "removed" | "ast" | "glob";

interface TriggerMatch {
  kind: TriggerKind;
  file: DiffFile;
  line: number;
  evidence: string;
  hunkHash: string;
}

/** Step 2: regex triggers over the hunk lines of one file. */
function collectRegexMatches(compiled: CompiledRule, file: DiffFile): TriggerMatch[] {
  const matches: TriggerMatch[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") {
        for (const regex of compiled.addedLineRegexes) {
          if (!regex.test(line.content)) continue;
          matches.push({
            kind: "added",
            file,
            line: line.newLine ?? hunk.newStart,
            evidence: clipEvidence(line.content),
            hunkHash: hunk.hash,
          });
        }
      } else if (line.type === "del") {
        for (const regex of compiled.removedLineRegexes) {
          if (!regex.test(line.content)) continue;
          matches.push({
            kind: "removed",
            file,
            line: line.oldLine ?? hunk.oldStart,
            evidence: clipEvidence(line.content),
            hunkHash: hunk.hash,
          });
        }
      }
    }
  }
  return matches;
}

/** Step 3: AST triggers for one file (added side and/or removed side). */
function collectAstMatches(
  compiled: CompiledRule,
  file: DiffFile,
  ast: AstProjectHandle | null,
  oldFileAst: AstProjectHandle | null,
): TriggerMatch[] {
  if (!TS_JS_RE.test(file.path)) return [];
  const matches: TriggerMatch[] = [];

  if (compiled.addedAstMatchers.length > 0 && ast !== null) {
    const ranges = addedLineRanges(file);
    const result = evaluateAstMatchers(ast, file.path, compiled.addedAstMatchers, "added", ranges);
    if (result.matched && result.line !== undefined) {
      matches.push({
        kind: "ast",
        file,
        line: result.line,
        evidence: result.evidence ?? "",
        hunkHash: hunkForLine(file, result.line, "added")?.hash ?? file.hunks[0]?.hash ?? "",
      });
    }
  }

  if (compiled.removedAstMatchers.length > 0 && oldFileAst !== null) {
    const ranges = removedLineRanges(file);
    // HEAD content is keyed by the OLD path for renames (§5.2).
    const oldPath = file.renamedFrom ?? file.path;
    const result = evaluateAstMatchers(oldFileAst, oldPath, compiled.removedAstMatchers, "removed", ranges);
    if (result.matched && result.line !== undefined) {
      matches.push({
        kind: "ast",
        file,
        line: result.line,
        evidence: result.evidence ?? "",
        hunkHash: hunkForLine(file, result.line, "removed")?.hash ?? file.hunks[0]?.hash ?? "",
      });
    }
  }

  return matches;
}

/** A rule with globs but no line/AST triggers fires once per matching file. */
function globOnlyMatches(compiled: CompiledRule, files: DiffFile[]): TriggerMatch[] {
  const { when } = compiled.rule;
  const hasTriggers =
    (when.addedLines?.length ?? 0) > 0 ||
    (when.removedLines?.length ?? 0) > 0 ||
    (when.ast?.length ?? 0) > 0;
  if (hasTriggers) return [];
  return files.map((file) => {
    const firstHunk = file.hunks[0];
    const firstChanged = firstHunk?.lines.find((line) => line.type !== "context");
    return {
      kind: "glob" as const,
      file,
      line: firstChanged?.newLine ?? firstChanged?.oldLine ?? 1,
      evidence: file.path,
      hunkHash: firstHunk?.hash ?? "",
    };
  });
}

interface FindingBuild {
  cluster: Cluster;
  finding: Finding;
}

export async function evaluateRules(opts: EvaluateRulesOptions): Promise<EngineResult> {
  const { clusters, context } = opts;
  const ast = opts.ast ?? null;
  const oldFileAst = opts.oldFileAst ?? null;

  // Engine init: compile every enabled rule's patterns exactly once (§13.2).
  const compiledRules = compileAllRules(opts.rules);

  const slowMap = new Map<string, number>();
  const built: FindingBuild[] = [];

  // Guard-verification reads: at most one read per file per run (§7.9).
  const fileReadCache = new Map<string, Promise<string | null>>();
  const readCurrentFile = (file: DiffFile): Promise<string | null> => {
    const key = `${file.isNew ? "work" : "head"}:${file.path}`;
    let pending = fileReadCache.get(key);
    if (pending === undefined) {
      pending = file.isNew ? context.readWorkingFile(file.path) : context.readFileAtHead(file.path);
      fileReadCache.set(key, pending);
    }
    return pending;
  };

  for (const cluster of clusters) {
    for (const compiled of compiledRules) {
      const started = performance.now();
      try {
        const matches = evaluateRuleOnCluster(compiled, cluster, ast, oldFileAst);
        if (matches.length === 0) continue;
        const findings = await buildFindings(compiled, cluster, matches, context, readCurrentFile);
        built.push(...findings);
      } finally {
        // Regex hygiene (§13.2): accumulate per-rule evaluation time. Note:
        // this measures and reports; true interruption of a pathological
        // pattern would need worker isolation, which is post-MVP.
        const elapsed = performance.now() - started;
        slowMap.set(compiled.rule.id, (slowMap.get(compiled.rule.id) ?? 0) + elapsed);
      }
    }
  }

  // Step 8: dedupe by (ruleId, file, line), first occurrence wins.
  const seen = new Set<string>();
  const deduped: FindingBuild[] = [];
  for (const entry of built) {
    const { finding } = entry;
    const key = `${finding.ruleId} ${finding.file} ${finding.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  const findings: Finding[] = [];
  const infoFindings: Finding[] = [];
  for (const entry of deduped) {
    (entry.finding.info === true ? infoFindings : findings).push(entry.finding);
  }

  // Step 9: cluster severity = max of its ACTIVE findings ("low" when none);
  // sort severity desc, then size (added+removed) desc; re-assign ids c1..cn.
  const activeByCluster = new Map<Cluster, Severity[]>();
  for (const entry of deduped) {
    if (entry.finding.info === true) continue;
    const list = activeByCluster.get(entry.cluster) ?? [];
    list.push(entry.finding.severity);
    activeByCluster.set(entry.cluster, list);
  }
  for (const cluster of clusters) {
    const severities = activeByCluster.get(cluster) ?? [];
    let max: Severity = "low";
    for (const severity of severities) {
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[max]) max = severity;
    }
    cluster.severity = max;
  }
  const sorted = [...clusters].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.added + b.removed - (a.added + a.removed);
  });
  sorted.forEach((cluster, index) => {
    cluster.id = `c${index + 1}`;
  });
  clusters.length = 0;
  clusters.push(...sorted);

  const slowRules: { ruleId: string; ms: number }[] = [];
  for (const [ruleId, ms] of slowMap) {
    if (ms > SLOW_RULE_THRESHOLD_MS) {
      slowRules.push({ ruleId, ms: Math.round(ms * 100) / 100 });
    }
  }

  return { findings, infoFindings, slowRules };
}

function compileAllRules(rules: EffectiveRule[]): CompiledRule[] {
  return rules.filter((rule) => rule.enabled).map(compileRule);
}

/** Steps 1–5: glob gate → regex → AST → requireAll → notAddedWith veto. */
function evaluateRuleOnCluster(
  compiled: CompiledRule,
  cluster: Cluster,
  ast: AstProjectHandle | null,
  oldFileAst: AstProjectHandle | null,
): TriggerMatch[] {
  const { rule } = compiled;
  const { when } = rule;

  // Step 1: glob gate — ANY fileGlob match gates the rule for this cluster.
  const matchingFiles =
    compiled.globMatchers.length > 0
      ? cluster.files.filter((file) => compiled.globMatchers.some((isMatch) => isMatch(file.path)))
      : cluster.files;
  if (matchingFiles.length === 0) return [];

  // Steps 2–3: collect trigger matches.
  const matches: TriggerMatch[] = [];
  for (const file of matchingFiles) {
    matches.push(...collectRegexMatches(compiled, file));
    matches.push(...collectAstMatches(compiled, file, ast, oldFileAst));
  }
  matches.push(...globOnlyMatches(compiled, matchingFiles));

  // Step 4: requireAll — every declared trigger KIND must fire at least once.
  if (when.requireAll === true) {
    const firedKinds = new Set<TriggerKind>(matches.map((match) => match.kind));
    const declaredKinds: TriggerKind[] = [];
    if (compiled.addedLineRegexes.length > 0) declaredKinds.push("added");
    if (compiled.removedLineRegexes.length > 0) declaredKinds.push("removed");
    if ((when.ast?.length ?? 0) > 0) declaredKinds.push("ast");
    if (declaredKinds.some((kind) => !firedKinds.has(kind))) return [];
  }

  if (matches.length === 0) return [];

  // Step 5: notAddedWith — a guard in the cluster's added lines vetoes the
  // finding outright ("added X *with* its guard" is not a finding, §7.8).
  if (compiled.guardRegexes.length > 0) {
    const guardMatched = cluster.files.some((file) =>
      file.hunks.some((hunk) =>
        hunk.lines.some(
          (line) => line.type === "add" && compiled.guardRegexes.some((regex) => regex.test(line.content)),
        ),
      ),
    );
    if (guardMatched) return [];
  }

  return matches;
}

/** Steps 6–7: verifyInFile guard reads, then dependency-signal adjustment. */
async function buildFindings(
  compiled: CompiledRule,
  cluster: Cluster,
  matches: TriggerMatch[],
  context: RuleContext,
  readCurrentFile: (file: DiffFile) => Promise<string | null>,
): Promise<FindingBuild[]> {
  const { rule } = compiled;
  const results: FindingBuild[] = [];

  // Step 6 (§7.9): high-severity verifyInFile rules re-check the guard
  // patterns against the full current file when no guard matched the diff.
  const shouldVerify =
    rule.when.verifyInFile === true && compiled.guardRegexes.length > 0 && rule.severity === "high";

  for (const match of matches) {
    let info: boolean | undefined;
    let infoReason: string | undefined;
    let verificationNote: string | undefined;

    if (shouldVerify) {
      const content = await readCurrentFile(match.file);
      if (content === null) {
        // Read failure: keep the finding at full severity — verification can
        // only ever reduce noise, never hide a finding (§6.4).
        verificationNote = "guard verification read failed";
      } else {
        const guardLine = findGuardLine(content, compiled.guardRegexes);
        if (guardLine !== undefined) {
          info = true;
          infoReason = `guard found at line ${guardLine} — downgraded to info`;
        }
      }
    }

    const finding: Finding = {
      ruleId: rule.id,
      baseSeverity: rule.severity,
      severity: rule.severity,
      file: match.file.path,
      line: match.line,
      evidence: match.evidence,
      message: rule.then.message,
      checklist: [...rule.then.checklist],
      manualTests: [...(rule.then.manualTests ?? [])],
      hunkHash: match.hunkHash,
    };
    if (info !== undefined) finding.info = info;
    if (infoReason !== undefined) finding.infoReason = infoReason;
    if (verificationNote !== undefined) finding.note = verificationNote;

    // Step 7 (§7.10): dependency signals adjust each surviving (non-info)
    // finding — they never clear one, and downgrades only ever lower severity.
    if (finding.info !== true) {
      applyDependencySignals(rule, finding, context);
    }

    results.push({ cluster, finding });
  }

  return results;
}

/** First 1-based line of `content` matching any guard regex, if any. */
function findGuardLine(content: string, guardRegexes: RegExp[]): number | undefined {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && guardRegexes.some((regex) => regex.test(line))) {
      return index + 1;
    }
  }
  return undefined;
}

function applyDependencySignals(rule: EffectiveRule, finding: Finding, context: RuleContext): void {
  if (!context.dependencySignalsEnabled) return;
  const signals = rule.dependencySignals;
  if (signals === undefined) return;
  const dependencies = context.dependencies;
  if (dependencies === null) return; // unreadable package.json → skipped silently (§6.4)

  for (const [packageName, signal] of Object.entries(signals)) {
    if (!dependencies.has(packageName)) continue;
    if (signal.downgradeTo !== undefined && SEVERITY_RANK[signal.downgradeTo] < SEVERITY_RANK[finding.severity]) {
      finding.severity = signal.downgradeTo;
    }
    if (signal.note !== undefined) {
      finding.note = finding.note === undefined ? signal.note : `${finding.note}; ${signal.note}`;
    }
    if (signal.swapRemediation !== undefined && finding.checklist.length > 0) {
      finding.checklist[0] = signal.swapRemediation;
    }
  }
}
