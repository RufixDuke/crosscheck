/**
 * CLI end-to-end tests (§15.5): spawn the BUILT `dist/cli.js` against real
 * temp git repos, exactly the way a user's shell would invoke it. This is
 * what proves the argv → config → pipeline → render wiring in src/cli.ts
 * actually works, on top of the faster in-process coverage in
 * tests/unit/pipeline.test.ts.
 *
 * Safety note: the no-repo `--stdin` test writes a `crosscheck.config.json`
 * with `history.enabled: false` into its temp dir — without it, config
 * discovery would fall back to the real `~/.crosscheck/history.db` (no repo
 * root to scope the DB to), which must never happen from a test run.
 */
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli.js");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], opts: { cwd: string; input?: string; env?: Record<string, string> }): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [DIST_CLI, ...args],
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", ...opts.env } },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : 1;
        resolve({ stdout, stderr, code });
      },
    );
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crosscheck-cli-e2e-"));
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

const SECRET_LINE = 'export const apiKey = "sk-live-1234567890abcdef";\n';

beforeAll(async () => {
  try {
    await access(DIST_CLI);
  } catch {
    await execFileAsync("npx", ["tsup"], { cwd: REPO_ROOT, shell: true });
  }
}, 120_000);

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("crosscheck — staged review (default invocation)", () => {
  it("reviews staged changes and exits 0 for a finding-bearing, non-strict run", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const result = await runCli([], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CrossCheck v");
    expect(result.stdout).toContain("RISK MAP");
    expect(result.stdout).toContain("Confirm the flagged value is not a real credential");
  });

  it("`crosscheck review` behaves identically to bare `crosscheck`", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const bare = await runCli(["--quiet"], { cwd: dir });
    const explicit = await runCli(["review", "--quiet"], { cwd: dir });
    expect(explicit.stdout).toBe(bare.stdout);
    expect(explicit.code).toBe(bare.code);
  });
});

describe("crosscheck <range> — commit-range review", () => {
  it("`crosscheck HEAD~1` reviews the same as an explicit HEAD~1..HEAD range", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "r.ts", "export const r = 1;\n", "c1");
    await commitFile(git, dir, "r.ts", "export const r = 2;\n", "c2");

    const result = await runCli(["HEAD~1"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("range:   HEAD~1..HEAD");
  });
});

describe("crosscheck --strict — exit-code matrix (§9.8)", () => {
  it("exit 0 when there is nothing to flag", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "README.md", "hello\n", "initial");
    await writeFile(path.join(dir, "README.md"), "hello world\n");
    await git.add(".");

    const result = await runCli(["--strict", "--quiet"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("strict: pass");
  });

  it("exit 1 on an unacknowledged high-severity finding", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const result = await runCli(["--strict", "--quiet"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("strict: fail");
  });

  it("exit 2 on an operational error (unknown revision)", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "a.txt", "1\n", "initial");

    const result = await runCli(["HEAD~99", "--strict"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown revision");
  });
});

describe("crosscheck --ack — dedup across runs (§8 F8)", () => {
  it("acknowledging a finding removes it from the next run's active findings", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const before = await runCli(["--quiet"], { cwd: dir });
    expect(before.stdout).toMatch(/^1 finding/);

    const ackRun = await runCli(["--ack", "--quiet"], { cwd: dir });
    expect(ackRun.code).toBe(0);

    const after = await runCli(["--quiet"], { cwd: dir });
    expect(after.stdout).toMatch(/^0 findings/);

    const strictAfterAck = await runCli(["--strict", "--quiet"], { cwd: dir });
    expect(strictAfterAck.code).toBe(0);
    expect(strictAfterAck.stdout).toContain("strict: pass");
  });
});

describe("crosscheck --stdin (§11.5 — no repo needed)", () => {
  it("reviews a piped unified diff without any git repo", async () => {
    const dir = await tempDir(); // deliberately not a git repo
    // history.enabled: false — a no-repo run would otherwise fall back to
    // the real ~/.crosscheck/history.db, which a test must never touch.
    await writeFile(
      path.join(dir, "crosscheck.config.json"),
      JSON.stringify({ version: 1, history: { enabled: false } }),
    );
    const diffText = await readFile(
      new URL("../fixtures/diffs/simple-multifile.diff", import.meta.url),
      "utf8",
    );

    const result = await runCli(["--stdin", "--quiet"], { cwd: dir, input: diffText });
    expect(result.code).toBe(0);
  });
});

describe("crosscheck — edge cases that must never produce a stack trace (§11)", () => {
  it("exit 2 with an actionable message on an empty staged diff", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "a.txt", "hello\n", "initial");

    const result = await runCli([], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nothing staged");
    expect(result.stderr).not.toContain("at ");
  });

  it("exit 2 outside a git repository", async () => {
    const dir = await tempDir(); // no git init

    const result = await runCli([], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not a git repository");
  });

  it("exit 2 when a merge is in progress", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "f.txt", "base\n", "base");
    const mainBranch = (await git.raw(["branch", "--show-current"])).trim();

    await git.raw(["checkout", "-b", "other"]);
    await commitFile(git, dir, "f.txt", "other\n", "other change");
    await git.raw(["checkout", mainBranch]);
    await commitFile(git, dir, "f.txt", "main\n", "main change");
    await git.raw(["merge", "other"]).catch(() => {}); // conflict expected

    const result = await runCli([], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("merge in progress");
  });

  it("exit 2 above --max-files with actionable advice", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "a.txt", "1\n", "initial");
    await writeFile(path.join(dir, "a.txt"), "2\n");
    await git.add(".");

    const result = await runCli(["--max-files", "0"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("split this into smaller reviews");
  });

  it("exit 2 when --offline and --llm are combined", async () => {
    const dir = await tempDir();
    await initRepo(dir);

    const result = await runCli(["--offline", "--llm"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--offline contradicts --llm");
  });

  it("CROSSCHECK_OFFLINE forces offline and contradicts --llm (§12.3)", async () => {
    const dir = await tempDir();
    await initRepo(dir);

    const result = await runCli(["--llm"], { cwd: dir, env: { CROSSCHECK_OFFLINE: "1" } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--offline contradicts --llm");
  });
});

describe("crosscheck --show-prompt (§10.3 — zero network calls)", () => {
  it("prints the redacted prompt and exits 0 without persisting to history", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const result = await runCli(["--show-prompt"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[system]");
    expect(result.stdout).not.toContain("sk-live-1234567890abcdef");

    const history = await runCli(["history"], { cwd: dir });
    expect(history.stdout).toContain("no reviews recorded yet");
  });
});

describe("crosscheck rules / init / export — auxiliary commands", () => {
  it("`rules` lists effective rules; `rules <id>` details one", async () => {
    const dir = await tempDir();
    await initRepo(dir);

    const list = await runCli(["rules"], { cwd: dir });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("ON BY DEFAULT");
    expect(list.stdout).toContain("OPT-IN");

    const detail = await runCli(["rules", "secrets/hardcoded-secret"], { cwd: dir });
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain("secrets/hardcoded-secret");
    expect(detail.stdout).toContain("triggers:");
  });

  it("`init --yes` writes crosscheck.config.json non-interactively", async () => {
    const dir = await tempDir();
    await initRepo(dir);

    const result = await runCli(["init", "--yes"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote");
    const written = await readFile(path.join(dir, "crosscheck.config.json"), "utf8");
    expect(JSON.parse(written).version).toBe(1);
  });

  it("`export` (no id) renders the current diff as markdown", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src/index.ts", "export const x = 1;\n", "initial");
    await writeFile(path.join(dir, "src/index.ts"), SECRET_LINE);
    await git.add(".");

    const result = await runCli(["export", "--format", "markdown"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("## CrossCheck review — staged");
  });
});
