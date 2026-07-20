/**
 * commander v12 entry point (§9 — Commands & CLI Interface).
 *
 * A thin shell around `runReview` (src/pipeline.ts): parse argv into
 * `ReviewFlags`/`RangeSpec`, discover + load config, wire a real y/N consent
 * prompt, call the pipeline, and render/exit. `crosscheck` and
 * `crosscheck review` are the same handler — `review` is marked as
 * commander's default command (§9.1: "no hidden behavior differences").
 */
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { Command } from "commander";
import { isGitRepo, repoRoot } from "./ingest/git.js";
import { applyFlags, ConfigError, loadConfig, writeProjectConfig } from "./config/load.js";
import { createHistoryStore } from "./history/store.js";
import { resolveHistoryDbPath } from "./history/paths.js";
import { resolveRules } from "./rules/resolve.js";
import { render } from "./render/index.js";
import { DIVIDER, SEVERITY_SYMBOL } from "./render/format.js";
import { readToolVersion, ReviewOperationalError, runReview, type RunReviewOutcome } from "./pipeline.js";
import type {
  ChecklistItem,
  CrossCheckConfig,
  RangeSpec,
  ReviewFlags,
  ReviewRecord,
  ReviewReport,
  Severity,
} from "./types.js";

const VALID_FORMATS = new Set(["terminal", "markdown", "json"]);
const VALID_SEVERITIES = new Set(["high", "medium", "low"]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Best-effort repo root — never throws (used for config discovery + history). */
async function bestEffortRepoRoot(cwd: string): Promise<string | null> {
  try {
    if (await isGitRepo(cwd)) return await repoRoot(cwd);
  } catch {
    // best effort only
  }
  return null;
}

/** Loads config, printing+exiting(2) on `ConfigError` instead of throwing. Returns null when it already handled the error. */
async function loadEffectiveConfig(
  cwd: string,
  repoRootPath: string | null,
  opts?: { scope?: string; configPath?: string },
): Promise<{ config: CrossCheckConfig; projectConfigPath: string | null } | null> {
  try {
    const loaded = await loadConfig({
      cwd,
      repoRoot: repoRootPath,
      scope: opts?.scope,
      configPath: opts?.configPath,
    });
    return { config: loaded.config, projectConfigPath: loaded.projectConfigPath };
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return null;
    }
    throw err;
  }
}

/**
 * y/N prompt over stderr (consent block goes to stderr per §10.4). Resolves
 * `false` with no TTY, so nothing ever hangs waiting for input in CI
 * (§10.4, §11.8) — this is also what's wired in as `runReview`'s
 * `confirmConsent` and as the `--clear`/`init` prompts below.
 */
async function promptYesNo(promptText: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${promptText} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Reads all of stdin into a string (`--stdin`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function quietSummary(report: ReviewReport, exitCode: number): string {
  const high = report.findings.filter((f) => f.severity === "high").length;
  if (report.strict !== undefined) {
    const word = report.strict.passed ? "pass" : "fail";
    return `strict: ${word} (${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}, ${report.strict.unacknowledgedAtOrAbove} unacknowledged >= ${report.strict.failOn})`;
  }
  return `${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} (${high} high) — exit ${exitCode}`;
}

// ---------------------------------------------------------------------------
// `review` (and the two default aliases: bare `crosscheck`, `crosscheck <range>`)
// ---------------------------------------------------------------------------

interface CliReviewOptions {
  staged?: boolean;
  worktree?: boolean;
  stdin?: boolean;
  llm?: boolean;
  requireLlm?: boolean;
  showPrompt?: boolean;
  dryRunLlm?: boolean;
  offline?: boolean;
  strict?: boolean;
  failOn?: string;
  format?: string;
  json?: boolean;
  all?: boolean;
  ack?: boolean;
  scope?: string;
  maxFiles?: string;
  maxTests?: string;
  yes?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  config?: string;
}

function buildFlags(options: CliReviewOptions): ReviewFlags {
  const flags: ReviewFlags = {};
  if (options.staged === true) flags.staged = true;
  if (options.worktree === true) flags.worktree = true;
  if (options.stdin === true) flags.stdin = true;
  if (options.llm === true) flags.llm = true;
  if (options.requireLlm === true) flags.requireLlm = true;
  if (options.showPrompt === true || options.dryRunLlm === true) flags.showPrompt = true;
  if (options.offline === true) flags.offline = true;
  if (options.strict === true) flags.strict = true;
  if (options.failOn !== undefined) flags.failOn = options.failOn as Severity;
  if (options.json === true) flags.format = "json";
  else if (options.format !== undefined) flags.format = options.format as ReviewFlags["format"];
  if (options.all === true) flags.all = true;
  if (options.ack === true) flags.ack = true;
  if (options.scope !== undefined) flags.scope = options.scope;
  if (options.maxFiles !== undefined) flags.maxFiles = Number.parseInt(options.maxFiles, 10);
  if (options.maxTests !== undefined) flags.maxTests = Number.parseInt(options.maxTests, 10);
  if (options.yes === true) flags.yes = true;
  if (options.verbose === true) flags.verbose = true;
  if (options.quiet === true) flags.quiet = true;
  if (options.color !== undefined) flags.color = options.color;
  if (options.config !== undefined) flags.configPath = options.config;
  // §12.3: any non-empty CROSSCHECK_OFFLINE forces offline. Env is layer 4,
  // flags layer 5 — but no flag turns offline OFF, so this never contradicts
  // an explicit flag (the --offline + --llm guard below vets the result).
  const offlineEnv = process.env.CROSSCHECK_OFFLINE;
  if (offlineEnv !== undefined && offlineEnv !== "") flags.offline = true;
  return flags;
}

async function handleReview(rangeArg: string | undefined, options: CliReviewOptions): Promise<void> {
  const flags = buildFlags(options);

  // Arg validation before any async work (§9.8 exit-2 contract). Checked on
  // the BUILT flags so a CROSSCHECK_OFFLINE-forced offline (§12.3) also
  // contradicts --llm.
  if (flags.offline === true && flags.llm === true) {
    process.stderr.write("--offline contradicts --llm\n");
    process.exitCode = 2;
    return;
  }

  if (flags.format !== undefined && !VALID_FORMATS.has(flags.format)) {
    process.stderr.write(`invalid --format "${flags.format}" — expected terminal|markdown|json\n`);
    process.exitCode = 2;
    return;
  }
  if (flags.failOn !== undefined && !VALID_SEVERITIES.has(flags.failOn)) {
    process.stderr.write(`invalid --fail-on "${flags.failOn}" — expected high|medium|low\n`);
    process.exitCode = 2;
    return;
  }

  let range: RangeSpec;
  if (options.stdin === true) {
    range = { kind: "stdin", text: await readStdin() };
  } else if (rangeArg !== undefined) {
    range = { kind: "range", range: rangeArg };
  } else if (options.worktree === true) {
    range = { kind: "worktree" };
  } else {
    range = { kind: "staged" };
  }

  const cwd = process.cwd();
  const repoRootPath = await bestEffortRepoRoot(cwd);
  const loaded = await loadEffectiveConfig(cwd, repoRootPath, { scope: flags.scope, configPath: flags.configPath });
  if (loaded === null) return; // already printed + exitCode set

  const config = applyFlags(loaded.config, flags);
  const colorEnabled = config.output.color && process.stdout.isTTY === true;

  let outcome: RunReviewOutcome;
  try {
    outcome = await runReview({
      cwd,
      range,
      flags,
      config,
      projectConfigPath: loaded.projectConfigPath,
      confirmConsent: promptYesNo,
    });
  } catch (err) {
    if (err instanceof ReviewOperationalError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (outcome.kind === "dry-run-llm") {
    process.stdout.write(`${outcome.output}\n`);
    process.exitCode = outcome.exitCode;
    return;
  }

  const { report, exitCode } = outcome;
  if (flags.quiet === true) {
    process.stdout.write(`${quietSummary(report, exitCode)}\n`);
  } else {
    process.stdout.write(`${render(report, config.output.format, { color: colorEnabled, verbose: flags.verbose === true })}\n`);
  }
  process.exitCode = exitCode;
}

function addReviewFlags(cmd: Command): Command {
  return cmd
    .argument("[range]", "commit range or ref to review (e.g. HEAD~3)")
    .option("--staged", "review git diff --cached (default)")
    .option("--worktree", "review unstaged working-tree diff")
    .option("--stdin", "read a unified diff from stdin (no repo needed)")
    .option("--llm", "add BYOK LLM cluster summaries")
    .option("--require-llm", "exit 2 if the LLM pass cannot complete")
    .option("--show-prompt", "print the exact redacted prompt(s), then exit — no network call")
    .option("--dry-run-llm", "alias for --show-prompt")
    .option("--offline", "forbid all network use (errors if combined with --llm)")
    .option("--strict", "exit 1 on unacknowledged findings >= strict.failOn")
    .option("--fail-on <severity>", "override strict threshold: high|medium|low")
    .option("--format <format>", "terminal|markdown|json")
    .option("--json", "shorthand for --format json")
    .option("--all", "include previously-acknowledged findings")
    .option("--ack", "acknowledge all current findings after rendering")
    .option("--scope <path>", "restrict analysis to a subtree (monorepos)")
    .option("--max-files <n>", "refuse-and-advise above n changed files (default 400)")
    .option("--max-tests <n>", "cap on suggested manual tests (default 12)")
    .option("--yes", "pre-answer yes to consent prompts")
    .option("--verbose", "rule ids, timing, skipped files, budget details")
    .option("--quiet", "summary line only (for scripts)")
    .option("--no-color", "disable ANSI (auto when piped; NO_COLOR honored)")
    .option("--config <path>", "explicit config file path")
    .action(handleReview);
}

// ---------------------------------------------------------------------------
// `history`
// ---------------------------------------------------------------------------

function formatHistoryDate(createdAt: string): string {
  // sql.js `datetime('now')` → "YYYY-MM-DD HH:MM:SS" (UTC); trim to minutes.
  return createdAt.length >= 16 ? createdAt.slice(0, 16) : createdAt;
}

function formatSeverityCounts(r: ReviewRecord): string {
  const parts: string[] = [];
  if (r.highCount > 0) parts.push(`${SEVERITY_SYMBOL.high}${r.highCount}`);
  if (r.mediumCount > 0) parts.push(`${SEVERITY_SYMBOL.medium}${r.mediumCount}`);
  if (r.lowCount > 0) parts.push(`${SEVERITY_SYMBOL.low}${r.lowCount}`);
  return parts.join(" ");
}

function formatHistoryRow(r: ReviewRecord): string {
  const id = `#${r.id}`.padStart(4);
  const date = formatHistoryDate(r.createdAt).padEnd(16);
  const range = r.rangeDesc.padEnd(18);
  const files = `${r.filesChanged}f`.padStart(5);
  const lines = `+${r.linesAdded}/−${r.linesRemoved}`.padEnd(13);
  const sev = formatSeverityCounts(r).padEnd(10);
  const llmTag = r.llmUsed ? `  (llm:${r.llmProvider ?? "?"})` : "";
  return ` ${id}  ${date}  ${range}${files}  ${lines} ${sev}${r.verdict}${llmTag}`;
}

async function handleHistoryList(): Promise<void> {
  const cwd = process.cwd();
  const repoRootPath = await bestEffortRepoRoot(cwd);
  const loaded = await loadEffectiveConfig(cwd, repoRootPath);
  if (loaded === null) return;
  const { config } = loaded;

  if (!config.history.enabled) {
    process.stdout.write("history is disabled (history.enabled = false in config)\n");
    return;
  }

  const store = await createHistoryStore({ repoRoot: repoRootPath, configuredPath: config.history.dbPath });
  try {
    if (!store.available) {
      process.stdout.write("history unavailable — sql.js failed to load or the database is unusable\n");
      return;
    }
    const dbPath = resolveHistoryDbPath({ repoRoot: repoRootPath, configuredPath: config.history.dbPath });
    const label = repoRootPath !== null ? path.basename(repoRootPath) : "no repo";
    process.stdout.write(`CrossCheck — review history (${label}, ${path.relative(cwd, dbPath)})\n`);
    process.stdout.write(`${DIVIDER}\n`);
    const reviews = store.listReviews(repoRootPath, 20);
    if (reviews.length === 0) {
      process.stdout.write(" no reviews recorded yet\n");
    } else {
      for (const r of reviews) process.stdout.write(`${formatHistoryRow(r)}\n`);
    }
    process.stdout.write(`${DIVIDER}\n`);
    const stats = store.hunkStats(repoRootPath);
    process.stdout.write(` hunk dedup: ${stats.tracked} hunks tracked · ${stats.acknowledged} acknowledged\n`);
  } finally {
    store.close();
  }
}

/**
 * `history show <id>` / `export <id>` can only ever reconstruct a reduced
 * view: `checklist_items` (§6.3 schema) persists rule_id/severity/text/
 * file/line only — no cluster, hunk-hash, manual-test, or LLM-summary data
 * survives a reload (see `HistoryStoreImpl.getReview`'s doc comment in
 * src/history/store.ts). This is a known MVP limitation, not a bug: a full
 * "reprint review #N's report" would need a schema change to persist the
 * full `ReviewReport` (or at least clusters+manualTests+llm) verbatim.
 */
function formatHistoricalReview(review: ReviewRecord, items: ChecklistItem[], format: string): string {
  if (format === "json") {
    return JSON.stringify({ review, checklist: items }, null, 2);
  }
  const lines: string[] = [];
  lines.push(
    `## CrossCheck review #${review.id} — ${review.rangeDesc} (${review.filesChanged} files, +${review.linesAdded} / −${review.linesRemoved})`,
  );
  lines.push("");
  const llmNote = review.llmUsed ? ` · llm: ${review.llmProvider ?? "?"}` : "";
  lines.push(`_Recorded ${review.createdAt} · verdict: ${review.verdict}${llmNote}_`);
  lines.push("");
  lines.push("### Risk summary");
  lines.push("");
  lines.push(
    `${SEVERITY_SYMBOL.high} ${review.highCount} high · ${SEVERITY_SYMBOL.medium} ${review.mediumCount} medium · ${SEVERITY_SYMBOL.low} ${review.lowCount} low · ${review.clusterCount} clusters`,
  );
  lines.push("");
  lines.push("### Checklist (as recorded)");
  lines.push("");
  if (items.length === 0) {
    lines.push("_no checklist items recorded_");
  } else {
    for (const item of items) {
      const box = item.acknowledged ? "[x]" : "[ ]";
      const loc = item.file !== undefined ? ` — \`${item.file}${item.line !== undefined ? `:${item.line}` : ""}\`` : "";
      lines.push(`- ${box} **(${item.severity.toUpperCase()})** ${item.text}${loc}`);
    }
  }
  return lines.join("\n");
}

async function handleHistoryShow(idArg: string): Promise<void> {
  const id = Number.parseInt(idArg, 10);
  if (!Number.isFinite(id)) {
    process.stderr.write(`invalid review id "${idArg}"\n`);
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const repoRootPath = await bestEffortRepoRoot(cwd);
  const loaded = await loadEffectiveConfig(cwd, repoRootPath);
  if (loaded === null) return;

  const store = await createHistoryStore({ repoRoot: repoRootPath, configuredPath: loaded.config.history.dbPath });
  try {
    if (!store.available) {
      process.stderr.write("history unavailable\n");
      process.exitCode = 1;
      return;
    }
    const found = store.getReview(id);
    if (found === null) {
      process.stderr.write(`no review #${id} found\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${formatHistoricalReview(found.review, found.items, "markdown")}\n`);
  } finally {
    store.close();
  }
}

async function handleHistoryClear(): Promise<void> {
  const cwd = process.cwd();
  const repoRootPath = await bestEffortRepoRoot(cwd);
  const loaded = await loadEffectiveConfig(cwd, repoRootPath);
  if (loaded === null) return;

  const store = await createHistoryStore({ repoRoot: repoRootPath, configuredPath: loaded.config.history.dbPath });
  try {
    if (!store.available) {
      process.stdout.write("history unavailable — nothing to clear\n");
      return;
    }
    const stats = store.hunkStats(repoRootPath);
    const reviewCount = store.listReviews(repoRootPath).length;
    const dbPath = resolveHistoryDbPath({ repoRoot: repoRootPath, configuredPath: loaded.config.history.dbPath });
    const confirmed = await promptYesNo(
      `Delete ${path.relative(cwd, dbPath)} (${stats.tracked} hunks, ${reviewCount} reviews)? [y/N]`,
    );
    if (!confirmed) {
      process.stdout.write("aborted.\n");
      return;
    }
    store.clear();
    process.stdout.write("history cleared.\n");
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// `rules`
// ---------------------------------------------------------------------------

async function handleRules(id: string | undefined): Promise<void> {
  const cwd = process.cwd();
  const repoRootPath = await bestEffortRepoRoot(cwd);
  const loaded = await loadEffectiveConfig(cwd, repoRootPath);
  if (loaded === null) return;

  const { rules } = resolveRules(loaded.config);

  if (id !== undefined) {
    const rule = rules.find((r) => r.id === id);
    if (rule === undefined) {
      process.stderr.write(`no such rule: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    const archetype = rule.archetype !== undefined ? `, archetype: ${rule.archetype}` : "";
    const enabledLabel = rule.enabledByDefault ? "enabled by default" : "OPT-IN — off by default";
    process.stdout.write(
      `${rule.id}  (${rule.provenance === "config" ? "config" : "built-in"}, ${enabledLabel}, severity: ${rule.severity}${archetype})\n`,
    );
    process.stdout.write(`  "${rule.description}"\n`);
    process.stdout.write("  triggers:\n");
    if ((rule.when.fileGlobs?.length ?? 0) > 0) process.stdout.write(`    globs:  ${rule.when.fileGlobs!.join(", ")}\n`);
    if ((rule.when.addedLines?.length ?? 0) > 0) process.stdout.write(`    added:  ${rule.when.addedLines!.join(", ")}\n`);
    if ((rule.when.removedLines?.length ?? 0) > 0) process.stdout.write(`    removed:  ${rule.when.removedLines!.join(", ")}\n`);
    if ((rule.when.notAddedWith?.length ?? 0) > 0) {
      process.stdout.write(`    guard (must be absent):  ${rule.when.notAddedWith!.join(", ")}\n`);
    }
    if ((rule.when.ast?.length ?? 0) > 0) process.stdout.write(`    ast matchers:  ${rule.when.ast!.length}\n`);
    if (rule.when.verifyInFile === true) {
      process.stdout.write("    verify-in-file: on — a guard found elsewhere in the full file downgrades the finding to an info note\n");
    }
    process.stdout.write(
      `  emits ${rule.then.checklist.length} checklist item${rule.then.checklist.length === 1 ? "" : "s"}, ${rule.then.manualTests?.length ?? 0} manual tests\n`,
    );
    if (!rule.enabled) {
      process.stdout.write(
        rule.enabledByDefault
          ? "  currently disabled in this project's config (rules.disable)\n"
          : "  currently off — add its id to rules.enable in crosscheck.config.json to turn it on\n",
      );
    }
    return;
  }

  const nonCustom = rules.filter((r) => r.provenance !== "config");
  const onByDefault = nonCustom.filter((r) => r.enabledByDefault);
  const optIn = nonCustom.filter((r) => !r.enabledByDefault);
  const custom = rules.filter((r) => r.provenance === "config");
  const overridden = rules.filter((r) => r.provenance === "overridden");

  process.stdout.write(
    `CrossCheck — effective rules (${nonCustom.length} built-in: ${onByDefault.length} on by default, ${optIn.length} opt-in · ${custom.length} custom, ${overridden.length} overridden)\n`,
  );
  process.stdout.write(`${DIVIDER}\n`);

  const printRow = (rule: (typeof rules)[number]): void => {
    const symbol = SEVERITY_SYMBOL[rule.severity];
    const idCol = rule.id.padEnd(37);
    const categoryCol = rule.category.padEnd(19);
    const source = rule.provenance === "config" ? "config" : "built-in";
    let annotation = "";
    if (rule.provenance === "overridden") annotation = " [overridden in config]";
    else if (rule.enabledByDefault && !rule.enabled) annotation = " (disabled in config)";
    else if (!rule.enabledByDefault && !rule.enabled) annotation = " (opt-in: off)";
    process.stdout.write(` ${symbol}  ${idCol} ${categoryCol} ${source}${annotation}\n`);
  };

  if (onByDefault.length > 0) {
    process.stdout.write(" ON BY DEFAULT — high-confidence, unambiguous patterns\n");
    for (const rule of onByDefault) printRow(rule);
  }
  if (optIn.length > 0) {
    process.stdout.write("\n OPT-IN — noisier heuristics; off until you turn them on\n");
    for (const rule of optIn) printRow(rule);
  }
  if (custom.length > 0) {
    process.stdout.write("\n");
    for (const rule of custom) printRow(rule);
  }
  process.stdout.write(" …  (use --verbose for trigger patterns; `rules <id>` for detail)\n");
}

// ---------------------------------------------------------------------------
// `init`
// ---------------------------------------------------------------------------

interface InitOptions {
  yes?: boolean;
  force?: boolean;
}

async function handleInit(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const repoRootPath = await bestEffortRepoRoot(cwd);

  process.stdout.write("CrossCheck — project setup\n");
  if (repoRootPath !== null) {
    process.stdout.write(`  ✓ git repo found: ${repoRootPath}\n`);
  } else {
    process.stdout.write("  no git repo found here — config will still be written to the current directory\n");
  }

  // Interactive prompts (non-interactive/--yes skips straight to writing).
  // NOTE (MVP limitation): `writeProjectConfig` always writes the same
  // canonical minimal template (see src/config/load.ts) — these answers are
  // UX-only for now and don't yet branch into a different written template.
  if (options.yes !== true) {
    await promptYesNo("Enable LLM summaries? (optional — everything works offline) [y/N]");
    await promptYesNo("Strict mode default for this repo? [y/N]");
  }

  try {
    const written = await writeProjectConfig(repoRootPath ?? cwd, { force: options.force === true });
    process.stdout.write(`\n  ✓ wrote ${written}  (commit it — rules are per-repo)\n`);
    process.stdout.write("\nDone. Try: git add -A && crosscheck\n");
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `export`
// ---------------------------------------------------------------------------

interface ExportOptions {
  format?: string;
}

async function handleExport(idArg: string | undefined, options: ExportOptions): Promise<void> {
  const format = options.format ?? "markdown";
  if (!VALID_FORMATS.has(format)) {
    process.stderr.write(`invalid --format "${format}" — expected terminal|markdown|json\n`);
    process.exitCode = 2;
    return;
  }

  const cwd = process.cwd();

  if (idArg === undefined) {
    // Current diff, through the exact same pipeline as `review` (§9.9).
    const repoRootPath = await bestEffortRepoRoot(cwd);
    const loaded = await loadEffectiveConfig(cwd, repoRootPath);
    if (loaded === null) return;
    const flags: ReviewFlags = { format: format as ReviewFlags["format"] };
    const config = applyFlags(loaded.config, flags);
    try {
      const outcome = await runReview({
        cwd,
        range: { kind: "staged" },
        flags,
        config,
        projectConfigPath: loaded.projectConfigPath,
        confirmConsent: async () => false,
      });
      if (outcome.kind === "report") {
        process.stdout.write(`${render(outcome.report, config.output.format)}\n`);
        process.exitCode = outcome.exitCode;
      }
    } catch (err) {
      if (err instanceof ReviewOperationalError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
    return;
  }

  const id = Number.parseInt(idArg, 10);
  if (!Number.isFinite(id)) {
    process.stderr.write(`invalid review id "${idArg}"\n`);
    process.exitCode = 2;
    return;
  }
  const repoRootPath = await bestEffortRepoRoot(cwd);
  const loaded = await loadEffectiveConfig(cwd, repoRootPath);
  if (loaded === null) return;

  const store = await createHistoryStore({ repoRoot: repoRootPath, configuredPath: loaded.config.history.dbPath });
  try {
    if (!store.available) {
      process.stderr.write("history unavailable\n");
      process.exitCode = 1;
      return;
    }
    const found = store.getReview(id);
    if (found === null) {
      process.stderr.write(`no review #${id} found\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${formatHistoricalReview(found.review, found.items, format)}\n`);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Program assembly
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("crosscheck")
  .description("Local-first, pre-push AI self-review CLI — review what your AI coding agent wrote before you push.")
  .version(readToolVersion(), "--version", "print version");

addReviewFlags(program.command("review", { isDefault: true }).description("Full review with all flags"));

const historyCmd = program.command("history").description("List, show, or clear past reviews");
historyCmd.option("--clear", "delete the history database");
historyCmd.action(async (options: { clear?: boolean }) => {
  if (options.clear === true) return handleHistoryClear();
  return handleHistoryList();
});
historyCmd.command("show <id>").description("reprint a stored review (reduced view — see code comment)").action(handleHistoryShow);

program
  .command("rules")
  .argument("[id]", "print full detail for one rule id")
  .description("List effective rules (on-by-default vs opt-in tiers); explain one in detail")
  .action(handleRules);

program
  .command("init")
  .description("Create crosscheck.config.json interactively")
  .option("--yes", "non-interactive; write defaults without prompting")
  .option("--offline-default", "non-interactive shorthand (kept for scripting parity with the PRD)")
  .option("--force", "overwrite an existing crosscheck.config.json")
  .action(handleInit);

program
  .command("export")
  .argument("[id]", "review id from history; omit for the current diff")
  .option("--format <format>", "terminal|markdown|json", "markdown")
  .description("Re-render a review as markdown/json")
  .action(handleExport);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`crosscheck: unexpected error — ${message}\n`);
  process.exitCode = 2;
});
