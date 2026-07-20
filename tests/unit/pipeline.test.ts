/**
 * `runReview` integration tests (Phase 3 — §6.2 data flow end to end).
 *
 * These exercise the real pipeline against real temp git repos (no mocks for
 * ingest/cluster/rules/checklist/history) so the wiring itself — not just
 * each module in isolation — is under test. CLI-level (spawned-process)
 * coverage lives in tests/integration/cli.test.ts.
 *
 * Safety note: `history.enabled` defaults to `false` in `freshConfig()` here
 * so a stdin/no-repo run never falls back to writing the real developer's
 * `~/.crosscheck/history.db` — tests that specifically exercise history
 * dedup opt back in explicitly, always against an isolated temp repo.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { ReviewOperationalError, runReview } from "../../src/pipeline.js";
import type { CrossCheckConfig } from "../../src/types.js";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crosscheck-pipeline-"));
  dirs.push(dir);
  return dir;
}

async function initRepo(dir: string): Promise<SimpleGit> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "CrossCheck Test");
  await git.addConfig("user.email", "test@crosscheck.dev");
  await git.addConfig("commit.gpgsign", "false");
  return git;
}

async function commitFile(git: SimpleGit, dir: string, name: string, content: string, msg: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
  await writeFile(path.join(dir, name), content);
  await git.add(".");
  await git.commit(msg);
}

function freshConfig(patch?: {
  history?: Partial<CrossCheckConfig["history"]>;
  llm?: Partial<CrossCheckConfig["llm"]>;
  strict?: Partial<CrossCheckConfig["strict"]>;
}): CrossCheckConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  base.history.enabled = false; // opt-in per test — see file header
  if (patch?.history !== undefined) Object.assign(base.history, patch.history);
  if (patch?.llm !== undefined) Object.assign(base.llm, patch.llm);
  if (patch?.strict !== undefined) Object.assign(base.strict, patch.strict);
  return base;
}

const SECRET_LINE = 'export const apiKey = "sk-live-1234567890abcdef";\n';

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("runReview — staged happy path", () => {
  it("produces a full ReviewReport with findings, checklist, and footer", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() });

    expect(outcome.kind).toBe("report");
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    const { report } = outcome;

    expect(outcome.exitCode).toBe(0);
    expect(report.range.desc).toBe("staged");
    expect(report.mode.llm).toBe(false);
    expect(report.mode.offline).toBe(true);
    expect(report.repo?.root).toBeTruthy();
    expect(report.findings.some((f) => f.ruleId === "secrets/hardcoded-secret")).toBe(true);
    expect(report.checklist.length).toBeGreaterThan(0);
    expect(report.footer.historyAvailable).toBe(false);
    expect(report.stats.filesChanged).toBe(1);
  });
});

describe("runReview — guards (§11)", () => {
  it("throws a friendly error for an empty staged diff (§11.8)", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "a.txt", "hello\n", "initial");

    await expect(
      runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() }),
    ).rejects.toThrow("nothing staged — run 'git add' first, or use --worktree to review unstaged changes");
  });

  it("throws a distinct message for an empty worktree diff", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "a.txt", "hello\n", "initial");

    await expect(
      runReview({ cwd: dir, range: { kind: "worktree" }, flags: {}, config: freshConfig() }),
    ).rejects.toThrow("nothing to review — the diff is empty");
  });

  it("rejects --offline + --llm before touching git (§9.8 exit-2)", async () => {
    const dir = await tempDir(); // not even a repo — proves this check runs first
    await expect(
      runReview({
        cwd: dir,
        range: { kind: "staged" },
        flags: { offline: true, llm: true },
        config: freshConfig(),
      }),
    ).rejects.toThrow("--offline contradicts --llm");
  });

  it("refuses a diff over --max-files with actionable advice (§11.1)", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "a.txt", "1\n", "initial");
    await writeFile(path.join(dir, "a.txt"), "2\n");
    await git.add(".");

    await expect(
      runReview({ cwd: dir, range: { kind: "staged" }, flags: { maxFiles: 0 }, config: freshConfig() }),
    ).rejects.toThrow(/files changed — split this into smaller reviews \(--scope\), or raise --max-files/);
  });

  it("wraps a not-a-git-repo GitError as ReviewOperationalError", async () => {
    const dir = await tempDir();
    await expect(
      runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() }),
    ).rejects.toThrow(ReviewOperationalError);
  });
});

describe("runReview — history dedup via --ack (§8 F8)", () => {
  it("acknowledged findings drop out of the next run's active findings, and --all re-expands them", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const config = freshConfig({ history: { enabled: true } });

    const first = await runReview({ cwd: dir, range: { kind: "staged" }, flags: { ack: true }, config });
    if (first.kind !== "report") throw new Error("expected a report outcome");
    expect(first.report.findings.length).toBeGreaterThan(0);

    const second = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config });
    if (second.kind !== "report") throw new Error("expected a report outcome");
    expect(second.report.findings).toHaveLength(0);
    expect(second.report.previouslyReviewed.findingCount).toBeGreaterThan(0);
    expect(second.report.checklist.some((item) => item.ruleId === "secrets/hardcoded-secret")).toBe(false);

    const third = await runReview({ cwd: dir, range: { kind: "staged" }, flags: { all: true }, config });
    if (third.kind !== "report") throw new Error("expected a report outcome");
    expect(third.report.checklist.some((item) => item.acknowledged)).toBe(true);
  });
});

describe("runReview — --strict (§9.8)", () => {
  it("fails (exit 1) when unacknowledged findings meet the fail-on threshold", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const outcome = await runReview({
      cwd: dir,
      range: { kind: "staged" },
      flags: { strict: true },
      config: freshConfig(),
    });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.strict?.passed).toBe(false);
    expect(outcome.report.strict?.failOn).toBe("high");
    expect(outcome.exitCode).toBe(1);
  });

  it("passes (exit 0) once the offending finding is acknowledged", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const config = freshConfig({ history: { enabled: true } });
    await runReview({ cwd: dir, range: { kind: "staged" }, flags: { ack: true }, config });

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: { strict: true }, config });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.strict?.passed).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });
});

describe("runReview — --show-prompt / --dry-run-llm (§10.3)", () => {
  it("returns a dry-run-llm outcome with the redacted prompt text and no report/persist", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const outcome = await runReview({
      cwd: dir,
      range: { kind: "staged" },
      flags: { showPrompt: true },
      config: freshConfig(),
    });
    expect(outcome.kind).toBe("dry-run-llm");
    if (outcome.kind !== "dry-run-llm") throw new Error("expected a dry-run-llm outcome");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("[system]");
    expect(outcome.output).toContain("[user]");
    expect(outcome.output).not.toMatch(/sk-live-1234567890abcdef/); // redacted, never raw
  });
});

describe("runReview — AST content sourcing (staged: new=index blob, old=HEAD blob)", () => {
  it("fires auth/session-rewrite (removed-code AST matcher) using real HEAD content", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(
      git,
      dir,
      "src/auth/session.ts",
      'import bcrypt from "bcrypt";\nexport function verify(a: string, b: string) {\n  return bcrypt.compareSync(a, b);\n}\n',
      "initial",
    );
    await writeFile(
      path.join(dir, "src/auth/session.ts"),
      "export function verify(a: string, b: string) {\n  return a === b;\n}\n",
    );
    await git.add(".");

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.findings.some((f) => f.ruleId === "auth/session-rewrite")).toBe(true);
    expect(outcome.report.footer.astAnalyzed).toBeGreaterThan(0);
  });
});

describe("runReview — stdin mode (§11.5)", () => {
  it("runs repo-free, skips AST, and never touches history", async () => {
    const dir = await tempDir(); // deliberately not a git repo
    const text = await readFile(new URL("../fixtures/diffs/simple-multifile.diff", import.meta.url), "utf8");

    const outcome = await runReview({ cwd: dir, range: { kind: "stdin", text }, flags: {}, config: freshConfig() });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.range.desc).toBe("stdin");
    expect(outcome.report.repo).toBeNull();
    expect(outcome.report.footer.historyAvailable).toBe(false);
    expect(outcome.report.footer.astAnalyzed).toBe(0);
  });
});

describe("runReview — range mode (§9.3, HEAD~N convention)", () => {
  it("resolves 'HEAD~1' the same as 'HEAD~1..HEAD' (§9 F2)", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "r.ts", "export const r = 1;\n", "c1");
    await commitFile(git, dir, "r.ts", "export const r = 2;\n", "c2");

    const outcome = await runReview({
      cwd: dir,
      range: { kind: "range", range: "HEAD~1" },
      flags: {},
      config: freshConfig(),
    });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.range.desc).toBe("HEAD~1..HEAD");
    expect(outcome.report.range.commitCount).toBe(1);
  });
});
