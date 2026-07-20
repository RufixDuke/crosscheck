/**
 * Fixture corpus (§15.2): a realistic unified-diff fixture per row of the
 * PRD's minimum corpus table, driven through the real ingest → cluster →
 * resolve → evaluate pipeline pieces rather than a hand-rolled harness —
 * `ingestDiff` (stdin mode, no repo needed for the static-diff fixtures),
 * `clusterDiff`, `resolveRules`, `createRuleContext`, `evaluateRules`.
 *
 * `weak-crypto` additionally builds a real ts-morph AST project from the
 * fixture's post-diff file content (sidecar `astNewFileContent`) so the
 * crypto/weak-hash AST matcher runs for real, not just a regex over hunk
 * text. `no-verify-webhook`/`verified-webhook` inject a fake
 * `RuleContext.readFileAtHead` (sidecar `readFileAtHead`) for the §7.9
 * `verifyInFile` guard re-check — the same faking pattern
 * tests/unit/rules/builtin.test.ts uses for the same rule.
 *
 * `lockfile-tamper`, `clean-refactor`, and `rebase-survival` don't fit the
 * generic "parse + expect findings" shape and get dedicated tests below —
 * `rebase-survival` in particular is driven through two real temp git repos
 * (§15.2 row 11 / §6.2 step 3 / F8 AC2), not a static `.diff` file.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAstProject } from "../../src/ast/project.js";
import type { AstProjectHandle } from "../../src/ast/types.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { clusterDiff } from "../../src/cluster/index.js";
import { ingestDiff } from "../../src/ingest/index.js";
import { createRuleContext } from "../../src/rules/context.js";
import { evaluateRules, type EngineResult } from "../../src/rules/engine.js";
import { resolveRules } from "../../src/rules/resolve.js";
import type { CrossCheckConfig } from "../../src/types.js";

const CORPUS_DIR = fileURLToPath(new URL("../fixtures/corpus/", import.meta.url));

interface FixtureExpectation {
  description: string;
  expectFindings: string[];
  expectNoFindings: string[];
  enableRules?: string[];
  readFileAtHead?: Record<string, string>;
  astNewFileContent?: Record<string, string>;
}

async function loadFixture(name: string): Promise<{ diffText: string; expected: FixtureExpectation }> {
  const diffText = await readFile(path.join(CORPUS_DIR, `${name}.diff`), "utf8");
  const expectedRaw = await readFile(path.join(CORPUS_DIR, `${name}.expected.json`), "utf8");
  return { diffText, expected: JSON.parse(expectedRaw) as FixtureExpectation };
}

function configWith(enableRules: string[] = []): CrossCheckConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.rules.enable = enableRules;
  return cfg;
}

/** Run one corpus fixture through the real (non-CLI) pipeline pieces. */
async function runFixture(name: string): Promise<{ result: EngineResult; expected: FixtureExpectation }> {
  const { diffText, expected } = await loadFixture(name);
  const { diff } = await ingestDiff({ cwd: CORPUS_DIR, range: { kind: "stdin", text: diffText } });
  const { clusters } = clusterDiff(diff);
  const { rules } = resolveRules(configWith(expected.enableRules));

  const readFileAtHead =
    expected.readFileAtHead !== undefined
      ? async (p: string): Promise<string | null> => expected.readFileAtHead?.[p] ?? null
      : undefined;
  const context = createRuleContext({ readFileAtHead });

  let ast: AstProjectHandle | null = null;
  if (expected.astNewFileContent !== undefined) {
    const files = Object.entries(expected.astNewFileContent).map(([p, content]) => ({ path: p, content }));
    ast = await loadAstProject(files);
  }

  const result = await evaluateRules({ clusters, rules, context, ast });
  return { result, expected };
}

describe("fixture corpus (§15.2) — built-in rule trigger fixtures", () => {
  const triggerCases = [
    "hardcoded-secret",
    "sql-concat",
    "missing-auth-check",
    "weak-crypto",
    "destructive-migration",
  ];

  for (const name of triggerCases) {
    it(`${name}: fires every expected rule id and none of the forbidden ones`, async () => {
      const { result, expected } = await runFixture(name);
      const activeIds = result.findings.map((f) => f.ruleId);
      for (const id of expected.expectFindings) {
        expect(activeIds).toContain(id);
      }
      for (const id of expected.expectNoFindings) {
        expect(activeIds).not.toContain(id);
      }
    });
  }

  it("clean-refactor: zero active findings and zero info findings (false-positive sentinel, §15.2 row 10)", async () => {
    const { result } = await runFixture("clean-refactor");
    expect(result.findings).toEqual([]);
    expect(result.infoFindings).toEqual([]);
  });

  it("no-verify-webhook: fires payments/webhook-endpoint at full severity — guard absent everywhere in the file", async () => {
    const { result } = await runFixture("no-verify-webhook");
    const finding = result.findings.find((f) => f.ruleId === "payments/webhook-endpoint");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("high");
    expect(finding?.info).toBeUndefined();
    expect(result.infoFindings.some((f) => f.ruleId === "payments/webhook-endpoint")).toBe(false);
  });

  it("verified-webhook: downgrades payments/webhook-endpoint to an info note — guard present elsewhere in the file (§7.9)", async () => {
    const { result } = await runFixture("verified-webhook");
    // Must not appear in active findings — stays out of the checklist and --strict.
    expect(result.findings.some((f) => f.ruleId === "payments/webhook-endpoint")).toBe(false);
    const info = result.infoFindings.find((f) => f.ruleId === "payments/webhook-endpoint");
    expect(info).toBeDefined();
    expect(info?.info).toBe(true);
    expect(info?.infoReason).toMatch(/guard found at line \d+/);
  });
});

describe("lockfile-tamper (§11.2, §15.2 row 9) — ignored at ingest, never reaches rule evaluation", () => {
  it("counts package-lock.json as ignored with reason 'lockfile', zero findings", async () => {
    const { diffText } = await loadFixture("lockfile-tamper");
    const { diff } = await ingestDiff({ cwd: CORPUS_DIR, range: { kind: "stdin", text: diffText } });

    expect(diff.files).toHaveLength(0);
    expect(diff.ignored).toHaveLength(1);
    expect(diff.ignored[0]?.reason).toBe("lockfile");
    expect(diff.ignored[0]?.path).toBe("package-lock.json");

    const { clusters } = clusterDiff(diff);
    expect(clusters).toHaveLength(0);

    const { rules } = resolveRules(configWith());
    const context = createRuleContext();
    const result = await evaluateRules({ clusters, rules, context, ast: null });
    expect(result.findings).toEqual([]);
  });
});

describe("rebase-survival (§6.2 step 3, §15.2 row 11, F8 AC2)", () => {
  let dirs: string[] = [];

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "crosscheck-corpus-rebase-"));
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

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("the same hunk content under two different commit histories/SHAs hashes identically", async () => {
    // Repo A: two commits, the second changing src/feature.ts.
    const dirA = await tempDir();
    const gitA = await initRepo(dirA);
    await commitFile(gitA, dirA, "src/feature.ts", "export const value = 1;\n", "initial commit A");
    await commitFile(
      gitA,
      dirA,
      "src/feature.ts",
      "export const value = 2;\nexport const extra = true;\n",
      "unrelated message A",
    );

    // Repo B: a different, longer history (extra preface commit, different
    // messages throughout) that arrives at the exact same hunk content —
    // simulating what an amend/rebase does to surrounding history/timestamps
    // while leaving the hunk itself untouched.
    const dirB = await tempDir();
    const gitB = await initRepo(dirB);
    await commitFile(gitB, dirB, "README.md", "placeholder\n", "unrelated preface commit");
    await commitFile(gitB, dirB, "src/feature.ts", "export const value = 1;\n", "initial commit B (reworded)");
    await commitFile(
      gitB,
      dirB,
      "src/feature.ts",
      "export const value = 2;\nexport const extra = true;\n",
      "totally different message B",
    );

    const { diff: diffA } = await ingestDiff({ cwd: dirA, range: { kind: "range", range: "HEAD~1..HEAD" } });
    const { diff: diffB } = await ingestDiff({ cwd: dirB, range: { kind: "range", range: "HEAD~1..HEAD" } });

    const hashA = diffA.files[0]?.hunks[0]?.hash;
    const hashB = diffB.files[0]?.hunks[0]?.hash;
    expect(hashA).toBeTruthy();
    expect(hashB).toBeTruthy();
    expect(hashA).toBe(hashB);

    // Prove the SHAs genuinely differ — the whole point is that dedup
    // survives despite different commits, not because they're secretly the same.
    const shaA = (await gitA.raw(["rev-parse", "HEAD"])).trim();
    const shaB = (await gitB.raw(["rev-parse", "HEAD"])).trim();
    expect(shaA).not.toBe(shaB);
  });
});
