/**
 * Benchmark gate (§13.1/§13.2, §15.5): the full pipeline must complete in
 * under 3s (warm) end to end — git invocation, parse, cluster, rules,
 * render — on a ~2,000-line diff. This is the headline number from §13.1's
 * targets table; the CI benchmark referenced by §15.5 ("benchmark gate...
 * >20% regression fails") runs this fixture on every PR.
 *
 * No baseline file exists yet, so per the task brief this hardcodes the
 * absolute §13.1 ceiling (simpler, matches the Week-3-roadmap "<3s/2k-line
 * gate in CI" language) rather than storing/comparing a relative-regression
 * baseline — MVP simplicity, §15.5.
 *
 * "Warm" (§13.1) means the process has already paid ts-morph's one-time
 * dynamic-import cost — a throwaway small-diff run pays that cost first, and
 * only the big-diff run afterward is timed against the 3s ceiling.
 *
 * The fixture: ~25 TS files, each importing the previous module and adding
 * ~90 lines of small functions (so clustering's import-graph edges and the
 * AST matchers do real, non-trivial work) — >2,000 changed lines total.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { runReview } from "../../src/pipeline.js";
import type { CrossCheckConfig } from "../../src/types.js";

const WARM_CEILING_MS = 3_000; // §13.1: "Heuristic review, 2,000-line diff, warm | < 3 s end-to-end"

const FILE_COUNT = 25;
const FUNCS_PER_FILE = 30; // 3 lines each => ~90 added lines/file => ~2,250 lines total

function baselineModule(i: number): string {
  const importLine = i === 0 ? "" : `import { base_${i - 1} } from "./module${i - 1}.js";\n`;
  const body = i === 0 ? `return ${i};` : `return base_${i - 1}() + ${i};`;
  return `${importLine}export function base_${i}(): number {\n  ${body}\n}\n`;
}

function changedModule(i: number): string {
  const importLine = i === 0 ? "" : `import { base_${i - 1} } from "./module${i - 1}.js";\n`;
  // Change the base function's return expression (churns one line) plus a
  // block of small helper functions (bulk of the line count).
  const body = i === 0 ? `return ${i} + 1;` : `return base_${i - 1}() + ${i} + 1;`;
  const lines = [`${importLine}export function base_${i}(): number {\n  ${body}\n}\n`];
  for (let f = 0; f < FUNCS_PER_FILE; f += 1) {
    lines.push(`export function helper_${i}_${f}(x: number): number {\n  return x * ${f + 1} + ${i};\n}\n`);
  }
  return lines.join("\n");
}

async function initRepo(dir: string): Promise<SimpleGit> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "CrossCheck Test");
  await git.addConfig("user.email", "test@crosscheck.dev");
  await git.addConfig("commit.gpgsign", "false");
  return git;
}

function freshConfig(): CrossCheckConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  base.history.enabled = false; // benchmark the review itself, not sql.js WASM init
  return base;
}

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crosscheck-bench-"));
  dirs.push(dir);
  return dir;
}

/** A real temp repo with a big, realistic, import-linked diff staged. */
async function buildLargeDiffRepo(): Promise<string> {
  const dir = await tempDir();
  const git = await initRepo(dir);

  for (let i = 0; i < FILE_COUNT; i += 1) {
    await mkdir(path.join(dir, "src/modules"), { recursive: true });
    await writeFile(path.join(dir, `src/modules/module${i}.ts`), baselineModule(i));
  }
  await git.add(".");
  await git.commit("initial baseline");

  for (let i = 0; i < FILE_COUNT; i += 1) {
    await writeFile(path.join(dir, `src/modules/module${i}.ts`), changedModule(i));
  }
  await git.add(".");

  return dir;
}

let bigRepoDir: string;
let warmupRepoDir: string;

beforeAll(async () => {
  dirs = [];
  bigRepoDir = await buildLargeDiffRepo();

  // Tiny separate repo to pay ts-morph's one-time dynamic-import cost before
  // the timed run — this is what "warm" means in §13.1.
  warmupRepoDir = await tempDir();
  const git = await initRepo(warmupRepoDir);
  await writeFile(path.join(warmupRepoDir, "warm.ts"), "export const warm = 1;\n");
  await git.add(".");
  await git.commit("warmup base");
  await writeFile(path.join(warmupRepoDir, "warm.ts"), "export const warm = 2;\n");
  await git.add(".");
  await runReview({ cwd: warmupRepoDir, range: { kind: "staged" }, flags: {}, config: freshConfig() });
}, 60_000);

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("benchmark gate (§13.1, §15.5) — 2,000+ line diff, warm", () => {
  it("has staged >= 2,000 changed lines across a realistic file set", async () => {
    const outcome = await runReview({
      cwd: bigRepoDir,
      range: { kind: "staged" },
      flags: {},
      config: freshConfig(),
    });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    const { stats } = outcome.report;
    expect(stats.filesChanged).toBe(FILE_COUNT);
    expect(stats.linesAdded + stats.linesRemoved).toBeGreaterThanOrEqual(2_000);
  });

  it(`completes the full pipeline (git → parse → cluster → rules → render) in < ${WARM_CEILING_MS}ms warm`, async () => {
    const started = performance.now();
    const outcome = await runReview({
      cwd: bigRepoDir,
      range: { kind: "staged" },
      flags: {},
      config: freshConfig(),
    });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    // §13.1's number includes render; the CLI does this outside runReview, so
    // fold it into the measured window here to match the target's scope.
    const { render } = await import("../../src/render/index.js");
    render(outcome.report, "terminal", { color: false });
    const elapsedMs = performance.now() - started;

    // eslint-disable-next-line no-console
    console.log(`[benchmark] 2,000+ line diff, warm: ${elapsedMs.toFixed(1)}ms (ceiling ${WARM_CEILING_MS}ms)`);
    expect(outcome.report.clusters.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(WARM_CEILING_MS);
  });
});
