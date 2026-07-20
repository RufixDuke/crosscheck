/**
 * Core review orchestration (§6.2 data flow, Phase 3 integration layer).
 *
 * `runReview()` is the single place that wires ingest → AST → cluster →
 * rules → checklist → (optional LLM) → history into a `ReviewReport`. The
 * CLI layer (`src/cli.ts`) is a thin shell around this function: it parses
 * argv into `ReviewFlags`/`RangeSpec`, loads config, wires a real consent
 * prompt, calls `runReview`, and renders/exits based on the result.
 *
 * Every exit-2 ("operational error", §6.4/§9.8/§11) condition is surfaced as
 * a thrown `ReviewOperationalError` whose `.message` is the exact one-line,
 * actionable text to print to stderr — never a stack trace.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstProjectHandle } from "./ast/types.js";
import { loadAstProject } from "./ast/project.js";
import { sanitizeJsonc } from "./config/jsonc.js";
import { clusterDiff } from "./cluster/index.js";
import { GitError, ingestDiff } from "./ingest/index.js";
import { readWorkingFile, showBlobAtRef } from "./ingest/git.js";
import type { IngestMeta } from "./ingest/index.js";
import {
  buildChecklist,
} from "./checklist/index.js";
import { createHistoryStore } from "./history/store.js";
import { createRuleContext } from "./rules/context.js";
import { evaluateRules } from "./rules/engine.js";
import { resolveRules } from "./rules/resolve.js";
import {
  DEFAULT_MODELS,
  buildConsentPrompt,
  buildDryRunPrompts,
  estimateCostUsd,
  needsConsent,
  recordConsent,
  summarizeClusters,
  type DryRunResult,
} from "./llm/index.js";
import type {
  CrossCheckConfig,
  DiffFile,
  Finding,
  HistoryStore,
  IgnoredFile,
  IgnoreReason,
  IgnoredSummary,
  LLMProviderName,
  ParsedDiff,
  RangeSpec,
  ReviewFlags,
  ReviewReport,
  Severity,
} from "./types.js";

/**
 * Every exit-2 condition (not-a-repo, bad range, empty diff, file-count
 * guard, `--require-llm` unmet, `--offline`+`--llm` conflict, …) throws this.
 * The CLI catches it, prints `.message` to stderr, and exits 2 — see §6.4.
 */
export class ReviewOperationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOperationalError";
  }
}

export interface RunReviewOptions {
  cwd: string;
  range: RangeSpec;
  flags: ReviewFlags;
  /** Already loaded + `applyFlags`'d by the caller (§12.1/§12.4). */
  config: CrossCheckConfig;
  /**
   * Where the project's `crosscheck.config.json` lives, if discovery found
   * (or would write) one — passed through so a granted LLM consent can be
   * persisted back to disk (§10.4). Only ever written to when the file
   * already exists (see `persistConsentToFile`) — a consent grant never
   * silently creates a config file the user hasn't asked for.
   */
  projectConfigPath?: string | null;
  /**
   * Injected for testability (§10.4): the CLI wires a real y/N stdin prompt;
   * tests stub it. Never called when `--yes` is set, and the CLI layer
   * should short-circuit to a function that resolves `false` when there's no
   * TTY and no `--yes` (no hanging prompts in CI).
   */
  confirmConsent?: (promptText: string) => Promise<boolean>;
}

/**
 * `runReview` either produces a normal report, or — for `--show-prompt`/
 * `--dry-run-llm` (§9.1, §10.3) — a plain-text prompt preview with zero
 * network calls and no report/render/history side effects at all. This
 * discriminated union is the chosen plumbing for that branch (documented
 * judgment call, see task brief): the CLI checks `outcome.kind` and either
 * prints `output` directly or calls `render(outcome.report, …)`.
 */
export type RunReviewOutcome =
  | { kind: "report"; report: ReviewReport; exitCode: number }
  | { kind: "dry-run-llm"; output: string; exitCode: 0 };

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/** `.ts/.tsx/.js/.jsx/.mts/.cts` — files ts-morph can ever load (§5.4). */
const AST_LOADABLE_RE = /\.(?:mts|cts|tsx?|jsx?)$/i;

/** "HEAD~3" → "HEAD~3..HEAD" (§9 F2: `crosscheck HEAD~3` == `HEAD~3..HEAD`). */
function rangeDesc(range: RangeSpec): string {
  switch (range.kind) {
    case "staged":
      return "staged";
    case "worktree":
      return "worktree";
    case "stdin":
      return "stdin";
    case "range":
      return range.range.includes("..") ? range.range : `${range.range}..HEAD`;
    default: {
      const exhaustive: never = range;
      throw new Error(`unknown range kind: ${String(exhaustive)}`);
    }
  }
}

/** Reads `version` from the installed package.json (works from src/ or dist/ — both sit one level under the package root). */
export function readToolVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildIgnoredSummary(ignored: IgnoredFile[]): IgnoredSummary {
  const byReason: Partial<Record<IgnoreReason, number>> = {};
  for (const file of ignored) {
    byReason[file.reason] = (byReason[file.reason] ?? 0) + 1;
  }
  return { count: ignored.length, byReason, examples: ignored.slice(0, 3).map((f) => f.path) };
}

interface AstSourceFile {
  path: string;
  content: string;
}

/**
 * Content sourcing for one AST project side, per range kind (§6.2 step 4):
 *   - staged:   new = index blob, old = HEAD blob
 *   - worktree: new = working-tree file, old = index blob
 *   - range:    new = headRef blob, old = baseRef blob
 * Non-loadable extensions get an empty placeholder (path only) so they still
 * land in `AstProjectHandle.skipped` for honest footer accounting (§11.4).
 * New-file entries are skipped on the old side (no pre-image); deleted-file
 * entries are skipped on the new side (no post-image) — per the brief.
 */
async function gatherAstSources(opts: {
  cwd: string;
  range: RangeSpec;
  files: DiffFile[];
  meta: IngestMeta;
  side: "new" | "old";
}): Promise<AstSourceFile[]> {
  const { cwd, range, files, meta, side } = opts;
  if (range.kind === "stdin") return [];
  const out: AstSourceFile[] = [];

  for (const file of files) {
    if (side === "new" && file.isDeleted === true) continue;
    if (side === "old" && file.isNew === true) continue;
    const filePath = side === "new" ? file.path : (file.renamedFrom ?? file.path);

    if (!AST_LOADABLE_RE.test(filePath)) {
      out.push({ path: filePath, content: "" });
      continue;
    }

    let content: string | null;
    if (range.kind === "staged") {
      content = side === "new" ? await showBlobAtRef(cwd, "", filePath) : await showBlobAtRef(cwd, "HEAD", filePath);
    } else if (range.kind === "worktree") {
      content = side === "new" ? await readWorkingFile(cwd, filePath) : await showBlobAtRef(cwd, "", filePath);
    } else {
      content =
        side === "new"
          ? await showBlobAtRef(cwd, meta.headRef ?? "HEAD", filePath)
          : await showBlobAtRef(cwd, meta.baseRef ?? "HEAD", filePath);
    }
    if (content !== null) out.push({ path: filePath, content });
  }
  return out;
}

/** Plain, readable rendering of `--show-prompt`/`--dry-run-llm` output (§9.1, §10.3). No fixed format is specified by the PRD beyond "prints the exact redacted prompt(s)". */
function formatDryRunOutput(result: DryRunResult): string {
  const lines: string[] = [];
  lines.push("CrossCheck — LLM prompt preview (--show-prompt) · zero network calls, nothing sent");
  lines.push(`estimated total tokens: ${result.totalEstimatedTokens}`);
  lines.push("");

  for (const entry of result.prompts) {
    const types = entry.redactionTypes.length > 0 ? entry.redactionTypes.join(", ") : "none";
    lines.push(
      `── ${entry.clusterLabel} [${entry.clusterId}, ${entry.severity}] — ~${entry.estimatedTokens} tokens · ${entry.redactionCount} redaction(s) (${types})`,
    );
    lines.push("");
    lines.push("[system]");
    lines.push(entry.prompt.system);
    lines.push("");
    lines.push("[user]");
    lines.push(entry.prompt.user);
    lines.push("");
  }

  if (result.notSummarized.length > 0) {
    lines.push(
      `not included: ${result.notSummarized.map((n) => `${n.clusterLabel} (${n.reason})`).join(", ")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Best-effort consent persistence (§10.4: "Consent is persisted in config").
 * Only ever writes when `filePath` already exists — a consent grant must
 * never silently create a project config file the user hasn't asked for
 * (matching the brief's "if a project config file exists"). JSONC comments
 * in the existing file are not preserved (re-serialized as plain JSON) —
 * a documented limitation of this minimal round-trip.
 */
async function persistConsentToFile(filePath: string, provider: LLMProviderName): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return; // no existing project config — never create one as a side effect
  }
  try {
    const parsed = JSON.parse(sanitizeJsonc(raw)) as Record<string, unknown>;
    const llmSection = (parsed.llm as Record<string, unknown> | undefined) ?? {};
    const consentGiven = (llmSection.consentGiven as Record<string, unknown> | undefined) ?? {};
    const updated = {
      ...parsed,
      llm: { ...llmSection, consentGiven: { ...consentGiven, [provider]: true } },
    };
    await writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  } catch {
    // best-effort — a failed consent-persist write must never fail the review
  }
}

export async function runReview(opts: RunReviewOptions): Promise<RunReviewOutcome> {
  const startedAt = Date.now();
  const { cwd, range, flags, config } = opts;

  if (flags.offline === true && flags.llm === true) {
    throw new ReviewOperationalError("--offline contradicts --llm");
  }

  let store: HistoryStore | null = null;
  try {
    // ---- 1. Ingest ---------------------------------------------------------
    let diff: ParsedDiff;
    let meta: IngestMeta;
    try {
      const result = await ingestDiff({ cwd, range, scope: flags.scope, ignoreGlobs: config.ignore });
      diff = result.diff;
      meta = result.meta;
    } catch (err) {
      if (err instanceof GitError) throw new ReviewOperationalError(err.userMessage);
      throw err;
    }

    // ---- 2. Empty-diff guard (§11.8) ---------------------------------------
    if (diff.files.length === 0) {
      if (range.kind === "staged") {
        throw new ReviewOperationalError(
          "nothing staged — run 'git add' first, or use --worktree to review unstaged changes",
        );
      }
      throw new ReviewOperationalError("nothing to review — the diff is empty");
    }

    // ---- 3. File-count guard (§11.1, F9 exit-2 trigger) --------------------
    const maxFiles = flags.maxFiles ?? 400;
    if (diff.files.length > maxFiles) {
      throw new ReviewOperationalError(
        `${diff.files.length} files changed — split this into smaller reviews (--scope), or raise --max-files`,
      );
    }

    const notices: string[] = [];
    if (meta.mergeCount !== undefined && meta.mergeCount > 0) {
      notices.push(
        `range contains ${meta.mergeCount} merge commit${meta.mergeCount === 1 ? "" : "s"} — diff is against first parent`,
      );
    }

    // ---- 4. AST projects (new-side + old-side) -----------------------------
    const hasAstCandidate = diff.files.some(
      (f) => AST_LOADABLE_RE.test(f.path) || (f.renamedFrom !== undefined && AST_LOADABLE_RE.test(f.renamedFrom)),
    );
    let newSideAst: AstProjectHandle | null = null;
    let oldFileAst: AstProjectHandle | null = null;
    if (range.kind === "stdin") {
      if (hasAstCandidate) {
        notices.push(
          "AST analysis unavailable in --stdin mode — no filesystem context; import-graph edges use regex fallback only",
        );
      }
    } else if (hasAstCandidate) {
      const [newFiles, oldFiles] = await Promise.all([
        gatherAstSources({ cwd, range, files: diff.files, meta, side: "new" }),
        gatherAstSources({ cwd, range, files: diff.files, meta, side: "old" }),
      ]);
      [newSideAst, oldFileAst] = await Promise.all([loadAstProject(newFiles), loadAstProject(oldFiles)]);
    }

    // ---- 5. Cluster ---------------------------------------------------------
    const { clusters } = clusterDiff(diff, { maxClusters: config.output.maxClusters, ast: newSideAst });

    // ---- 6. Resolve rules ----------------------------------------------------
    const { rules, warnings: ruleWarnings } = resolveRules(config);
    for (const warning of ruleWarnings) notices.push(`config: ${warning}`);

    // ---- 7. Rule context ------------------------------------------------------
    const context = createRuleContext({ cwd, dependencySignalsEnabled: config.rules.dependencySignals });

    // ---- 8. Evaluate rules (mutates `clusters` in place) -----------------------
    const { findings, infoFindings } = await evaluateRules({ clusters, rules, context, ast: newSideAst, oldFileAst });

    // ---- 9. History: dedup lookups ---------------------------------------------
    if (config.history.enabled) {
      store = await createHistoryStore({ repoRoot: meta.repoRoot, configuredPath: config.history.dbPath });
      if (!store.available) {
        notices.push("history unavailable this run — dedup and persistence are disabled");
      }
    }

    let previouslyReviewedFindings: Finding[] = [];
    let lastAckedAt: string | undefined;
    if (store !== null && store.available) {
      const allHashes = [...new Set([...findings, ...infoFindings].map((f) => f.hunkHash))];
      const records = store.lookupHunks(allHashes);
      for (const finding of [...findings, ...infoFindings]) {
        const record = records.get(finding.hunkHash);
        if (record !== undefined && record.acknowledged) {
          finding.acknowledged = true;
          if (record.ackedAt !== undefined) {
            finding.ackedAt = record.ackedAt;
            if (lastAckedAt === undefined || record.ackedAt > lastAckedAt) lastAckedAt = record.ackedAt;
          }
        }
      }
      previouslyReviewedFindings = findings.filter((f) => f.acknowledged === true);
    }

    // ---- 10. Checklist ------------------------------------------------------
    const { checklist, manualTests, manualTestsCapped } = buildChecklist({
      clusters,
      findings,
      infoFindings,
      previouslyReviewed: { findings: flags.all === true ? [] : previouslyReviewedFindings },
      maxTests: flags.maxTests ?? config.output.maxTests,
    });

    // ---- 11. --show-prompt / --dry-run-llm (zero network, early exit) -------
    if (flags.showPrompt === true) {
      const dryRun = buildDryRunPrompts({ clusters, findings, config });
      return { kind: "dry-run-llm", output: formatDryRunOutput(dryRun), exitCode: 0 };
    }

    // ---- 12. Optional LLM pass ------------------------------------------------
    let modeLlm = false;
    let modeProvider: string | undefined;
    let modeModel: string | undefined;
    let llmSection: ReviewReport["llm"] | undefined;

    if (flags.llm === true) {
      const provider = config.llm.provider;
      if (provider === null) {
        notices.push(
          "--llm requested but no provider configured — set llm.provider in crosscheck.config.json or CROSSCHECK_LLM_PROVIDER",
        );
        if (flags.requireLlm === true) {
          throw new ReviewOperationalError("LLM summary required but no provider configured");
        }
      } else {
        let proceed = true;
        let shouldPersistConsent = false;

        if (needsConsent(config, provider)) {
          const model = config.llm.model ?? DEFAULT_MODELS[provider];
          const preview = buildDryRunPrompts({ clusters, findings, config });
          const promptText = buildConsentPrompt({
            provider,
            model,
            clusterLabels: preview.prompts.map((p) => p.clusterLabel),
            estimatedTokens: preview.totalEstimatedTokens,
            estimatedCostUsd: estimateCostUsd(model, preview.totalEstimatedTokens, 0),
            maxTokensPerReview: config.llm.maxTokensPerReview,
            redactionCountPreview: preview.prompts.reduce((n, p) => n + p.redactionCount, 0),
          });

          if (flags.yes === true) {
            // §10.4: "--yes pre-answers for scripts; the consent block is
            // still printed (to stderr) so CI logs show what happened." This
            // is a per-invocation bypass, not a saved consent.
            process.stderr.write(`${promptText}\n`);
            proceed = true;
          } else {
            const confirm = opts.confirmConsent ?? (async () => false);
            proceed = await confirm(promptText);
            shouldPersistConsent = proceed;
          }
        }

        if (!proceed) {
          notices.push("LLM summary skipped — consent declined");
          if (flags.requireLlm === true) {
            throw new ReviewOperationalError("LLM summary required but unavailable (consent declined)");
          }
        } else {
          if (shouldPersistConsent) {
            recordConsent(config, provider); // pure — the CLI-visible effect is the file write below
            if (opts.projectConfigPath !== undefined && opts.projectConfigPath !== null) {
              await persistConsentToFile(opts.projectConfigPath, provider);
            }
          }

          const activeForLlm = findings.filter((f) => f.acknowledged !== true);
          const result = await summarizeClusters({ clusters, findings: activeForLlm, config });
          modeLlm = true;
          modeProvider = provider;
          modeModel = config.llm.model ?? DEFAULT_MODELS[provider];
          llmSection = {
            summaries: result.summaries,
            notSummarized: result.notSummarized,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
            redactions: result.redactions,
          };

          if (flags.requireLlm === true) {
            const hadClustersToSummarize = clusters.length > 0;
            const anyOk = result.summaries.some((s) => s.status === "ok");
            if (hadClustersToSummarize && !anyOk) {
              throw new ReviewOperationalError("LLM summary required but unavailable");
            }
          }
        }
      }
    }

    // ---- 14. Build the final report ---------------------------------------------
    const activeFindings = findings.filter((f) => f.acknowledged !== true);

    let strict: ReviewReport["strict"] | undefined;
    if (flags.strict === true) {
      const failOn = config.strict.failOn;
      const rank = SEVERITY_RANK[failOn];
      const unacknowledgedAtOrAbove = activeFindings.filter((f) => SEVERITY_RANK[f.severity] >= rank).length;
      strict = { failOn, unacknowledgedAtOrAbove, passed: unacknowledgedAtOrAbove === 0 };
    }

    const report: ReviewReport = {
      toolVersion: readToolVersion(),
      createdAt: new Date().toISOString(),
      repo: meta.repoRoot !== null ? { root: meta.repoRoot, name: meta.repoName ?? path.basename(meta.repoRoot) } : null,
      range: {
        desc: rangeDesc(range),
        ...(meta.baseRef !== undefined ? { baseRef: meta.baseRef } : {}),
        ...(meta.headRef !== undefined ? { headRef: meta.headRef } : {}),
        ...(meta.commitCount !== undefined ? { commitCount: meta.commitCount } : {}),
        ...(meta.mergeCount !== undefined ? { mergeCount: meta.mergeCount } : {}),
        ...(meta.scope !== undefined ? { scope: meta.scope } : {}),
      },
      mode: {
        llm: modeLlm,
        offline: !modeLlm,
        ...(modeProvider !== undefined ? { provider: modeProvider } : {}),
        ...(modeModel !== undefined ? { model: modeModel } : {}),
      },
      stats: {
        filesChanged: diff.stats.filesChanged,
        linesAdded: diff.stats.linesAdded,
        linesRemoved: diff.stats.linesRemoved,
        durationMs: Date.now() - startedAt,
        ignored: buildIgnoredSummary(diff.ignored),
      },
      clusters,
      findings: activeFindings,
      checklist,
      manualTests,
      manualTestsCapped,
      previouslyReviewed: {
        hunkCount: new Set(previouslyReviewedFindings.map((f) => f.hunkHash)).size,
        findingCount: previouslyReviewedFindings.length,
        ...(lastAckedAt !== undefined ? { lastAckedAt } : {}),
        findings: previouslyReviewedFindings,
      },
      infoFindings,
      ...(llmSection !== undefined ? { llm: llmSection } : {}),
      footer: {
        astAnalyzed: newSideAst?.analyzed.length ?? 0,
        astSkipped: newSideAst?.skipped.length ?? 0,
        historyAvailable: store !== null && store.available,
        notices,
      },
      ...(strict !== undefined ? { strict } : {}),
    };

    // ---- 15. Persist, then --ack ------------------------------------------------
    // `recordReview` upserts this run's hunks into the `hunks` table (rows
    // are created here for the first time); `--ack` must run AFTER that
    // upsert, or the UPDATE it issues touches zero rows (§8 F8, §6.3).
    if (store !== null && store.available) {
      store.recordReview(report, meta.repoRoot ?? "");
      if (flags.ack === true) {
        const allHashes = [...new Set([...findings, ...infoFindings].map((f) => f.hunkHash))];
        store.acknowledge(allHashes);
      }
      store.persist();
    }

    // ---- 16. Exit code ----------------------------------------------------------
    const exitCode = flags.strict === true && report.strict?.passed === false ? 1 : 0;
    return { kind: "report", report, exitCode };
  } finally {
    store?.close();
  }
}
