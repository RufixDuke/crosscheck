import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, allFilesOf, hunksOf, ingestDiff } from "../../../src/ingest/index.js";
import {
  getNumstat,
  hasCommits,
  isGitRepo,
  isMergeInProgress,
  resolveRange,
  showBlobAtRef,
} from "../../../src/ingest/git.js";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crosscheck-ingest-"));
  dirs.push(dir);
  return dir;
}

/** git init with a local identity so commits work in CI sandboxes. */
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

describe("ingestDiff — staged", () => {
  it("parses a real staged diff with hashes and repo metadata", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "src.ts", "export const v = 1;\n", "initial");

    await writeFile(path.join(dir, "src.ts"), "export const v = 2;\nexport const w = 3;\n");
    await writeFile(path.join(dir, "added.ts"), "export const fresh = true;\n");
    await git.add(".");

    const { diff, meta } = await ingestDiff({ cwd: dir, range: { kind: "staged" } });

    expect(diff.files.map((f) => f.path).sort()).toEqual(["added.ts", "src.ts"]);
    const src = diff.files.find((f) => f.path === "src.ts");
    expect(src?.added).toBe(2);
    expect(src?.removed).toBe(1);
    const added = diff.files.find((f) => f.path === "added.ts");
    expect(added?.isNew).toBe(true);

    for (const h of hunksOf(diff)) {
      expect(h.hash).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(meta.repoRoot).toBeTruthy();
    expect(meta.repoName).toBe(path.basename(meta.repoRoot!));
    // macOS temp dirs are symlinked (/var → /private/var); compare realpaths
    expect(await realpath(meta.gitDir!)).toBe(
      await realpath(path.join(meta.repoRoot!, ".git")),
    );
    expect(meta.baseRef).toBeUndefined();
    expect(diff.stats.filesChanged).toBe(2);
  });

  it("restricts ingestion to --scope subtrees (§11.7)", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "sub/a.ts", "export const a = 1;\n", "initial a");
    await commitFile(git, dir, "other/b.ts", "export const b = 1;\n", "initial b");

    await writeFile(path.join(dir, "sub/a.ts"), "export const a = 2;\n");
    await writeFile(path.join(dir, "other/b.ts"), "export const b = 2;\n");
    await git.add(".");

    const { diff, meta } = await ingestDiff({
      cwd: dir,
      range: { kind: "staged" },
      scope: "sub",
    });
    expect(diff.files.map((f) => f.path)).toEqual(["sub/a.ts"]);
    expect(meta.scope).toBe("sub");
  });

  it("ignores a staged binary file via numstat (§11.2)", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "keep.ts", "export const k = 1;\n", "initial");

    await writeFile(path.join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]));
    await writeFile(path.join(dir, "keep.ts"), "export const k = 2;\n");
    await git.add(".");

    const { diff } = await ingestDiff({ cwd: dir, range: { kind: "staged" } });
    expect(diff.files.map((f) => f.path)).toEqual(["keep.ts"]);
    expect(diff.ignored).toEqual([{ path: "blob.bin", reason: "binary" }]);
    expect(allFilesOf(diff).sort()).toEqual(["blob.bin", "keep.ts"]);
  });
});

describe("ingestDiff — worktree", () => {
  it("sees unstaged modifications", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "w.ts", "export const w = 1;\n", "initial");
    await writeFile(path.join(dir, "w.ts"), "export const w = 2;\n"); // not staged

    const { diff } = await ingestDiff({ cwd: dir, range: { kind: "worktree" } });
    expect(diff.files.map((f) => f.path)).toEqual(["w.ts"]);
    expect(diff.files[0]?.added).toBe(1);
    expect(diff.files[0]?.removed).toBe(1);
  });
});

describe("ingestDiff — range", () => {
  it("resolves refs and counts commits for HEAD~N", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "r.ts", "export const r = 1;\n", "c1");
    await commitFile(git, dir, "r.ts", "export const r = 2;\n", "c2");
    await commitFile(git, dir, "r.ts", "export const r = 3;\n", "c3");

    const { diff, meta } = await ingestDiff({
      cwd: dir,
      range: { kind: "range", range: "HEAD~2" },
    });

    expect(meta.baseRef).toMatch(/^[0-9a-f]{7,}$/);
    expect(meta.headRef).toMatch(/^[0-9a-f]{7,}$/);
    expect(meta.commitCount).toBe(2);
    expect(meta.mergeCount).toBe(0);
    expect(diff.files.map((f) => f.path)).toEqual(["r.ts"]);
    expect(diff.files[0]?.removed).toBe(1); // r = 1 → r = 3 across the range
    expect(diff.files[0]?.added).toBe(1);
  });

  it("throws a friendly GitError for unknown revisions (§9 F2)", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "r.ts", "export const r = 1;\n", "c1");

    await expect(
      ingestDiff({ cwd: dir, range: { kind: "range", range: "HEAD~7" } }),
    ).rejects.toThrow(GitError);
    await expect(
      ingestDiff({ cwd: dir, range: { kind: "range", range: "HEAD~7" } }),
    ).rejects.toThrow("unknown revision 'HEAD~7' — check the range");
  });
});

describe("ingestDiff — repo state guards (§11.5, §11.3)", () => {
  it("throws 'not a git repository' outside a repo", async () => {
    const dir = await tempDir(); // no git init
    await expect(ingestDiff({ cwd: dir, range: { kind: "staged" } })).rejects.toThrow(
      "not a git repository — run inside a repo, or pipe a diff: git diff | crosscheck --stdin",
    );
  });

  it("throws on a repo with zero commits", async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await expect(ingestDiff({ cwd: dir, range: { kind: "staged" } })).rejects.toThrow(
      "no commits yet — commit something first, or use --stdin",
    );
  });

  it("detects a merge in progress and refuses to run", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "f.txt", "base\n", "base");
    const mainBranch = (await git.raw(["branch", "--show-current"])).trim();

    await git.raw(["checkout", "-b", "other"]);
    await commitFile(git, dir, "f.txt", "other\n", "other change");
    await git.raw(["checkout", mainBranch]);
    await commitFile(git, dir, "f.txt", "main\n", "main change");

    // Conflict expected; simple-git resolves even when git merge exits 1
    // with conflict output on stdout, so don't assert rejection here.
    await git.raw(["merge", "other"]).catch(() => {});
    expect(await isMergeInProgress(dir)).toBe(true);

    await expect(ingestDiff({ cwd: dir, range: { kind: "staged" } })).rejects.toThrow(
      "merge in progress — resolve conflicts first",
    );

    await git.raw(["merge", "--abort"]);
    expect(await isMergeInProgress(dir)).toBe(false);
  });
});

describe("ingestDiff — stdin mode", () => {
  it("runs repo-free with null metadata (§11.5)", async () => {
    const dir = await tempDir(); // not a repo
    const text = await readFile(
      new URL("../../fixtures/diffs/simple-multifile.diff", import.meta.url),
      "utf8",
    );
    const { diff, meta } = await ingestDiff({
      cwd: dir,
      range: { kind: "stdin", text },
    });
    expect(meta.repoRoot).toBeNull();
    expect(meta.repoName).toBeNull();
    expect(meta.gitDir).toBeNull();
    expect(diff.files).toHaveLength(3);
    for (const h of hunksOf(diff)) {
      expect(h.hash).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("picks up repo context opportunistically when inside a repo", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "r.ts", "export const r = 1;\n", "c1");
    const text = await readFile(
      new URL("../../fixtures/diffs/simple-multifile.diff", import.meta.url),
      "utf8",
    );
    const { meta } = await ingestDiff({ cwd: dir, range: { kind: "stdin", text } });
    expect(meta.repoRoot).toBeTruthy();
    expect(meta.gitDir).toBeTruthy();
  });

  it("runs the ignore pipeline (lockfile + generated) and recomputes stats", async () => {
    const dir = await tempDir();
    const text = await readFile(
      new URL("../../fixtures/diffs/lockfile-and-generated.diff", import.meta.url),
      "utf8",
    );
    const { diff } = await ingestDiff({
      cwd: dir,
      range: { kind: "stdin", text },
      ignoreGlobs: [],
    });
    expect(diff.files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(diff.ignored).toEqual([
      { path: "package-lock.json", reason: "lockfile" },
      { path: "dist/bundle.js", reason: "generated" },
    ]);
    // stats recomputed over survivors only
    expect(diff.stats).toEqual({ filesChanged: 1, linesAdded: 1, linesRemoved: 0 });
    // surviving hunks are hashed
    expect(hunksOf(diff)[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("applies user ignore globs", async () => {
    const dir = await tempDir();
    const text = await readFile(
      new URL("../../fixtures/diffs/simple-multifile.diff", import.meta.url),
      "utf8",
    );
    const { diff } = await ingestDiff({
      cwd: dir,
      range: { kind: "stdin", text },
      ignoreGlobs: ["src/auth/**"],
    });
    expect(diff.files.map((f) => f.path)).toEqual(["src/db/migrate.ts", "README.md"]);
    expect(diff.ignored).toEqual([{ path: "src/auth/session.ts", reason: "user-ignore" }]);
  });
});

describe("git.ts primitives", () => {
  it("isGitRepo / hasCommits reflect repo state", async () => {
    const plain = await tempDir();
    expect(await isGitRepo(plain)).toBe(false);

    const dir = await tempDir();
    const git = await initRepo(dir);
    expect(await isGitRepo(dir)).toBe(true);
    expect(await hasCommits(dir)).toBe(false);
    await commitFile(git, dir, "a.txt", "a\n", "first");
    expect(await hasCommits(dir)).toBe(true);
  });

  it("getNumstat reports added/removed and null for binary", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "t.ts", "line1\nline2\n", "initial");
    await writeFile(path.join(dir, "t.ts"), "line1\nline2 changed\nline3\n");
    await writeFile(path.join(dir, "b.bin"), Buffer.from([0x00, 0x01, 0x00]));
    await git.add(".");

    const numstat = await getNumstat(dir, { kind: "staged" });
    expect(numstat.get("t.ts")).toEqual({ added: 2, removed: 1 });
    expect(numstat.get("b.bin")).toEqual({ added: null, removed: null });
  });

  it("resolveRange resolves two-dot ranges and short SHAs", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "a.txt", "1\n", "c1");
    await commitFile(git, dir, "a.txt", "2\n", "c2");
    await commitFile(git, dir, "a.txt", "3\n", "c3");

    const resolved = await resolveRange(dir, "HEAD~2..HEAD");
    expect(resolved.commitCount).toBe(2);
    expect(resolved.mergeCount).toBe(0);
    expect(resolved.baseRef).toMatch(/^[0-9a-f]{7,}$/);
    expect(resolved.headRef).toMatch(/^[0-9a-f]{7,}$/);
    expect(resolved.baseRef).not.toBe(resolved.headRef);
  });

  it("showBlobAtRef reads the HEAD blob, the index blob, and null for unknown paths", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "s.ts", "export const s = 1;\n", "initial");

    // HEAD blob.
    expect(await showBlobAtRef(dir, "HEAD", "s.ts")).toBe("export const s = 1;\n");

    // Stage a change: index blob (ref === "") differs from HEAD and from
    // the (untouched) working tree until written.
    await writeFile(path.join(dir, "s.ts"), "export const s = 2;\n");
    await git.add(".");
    expect(await showBlobAtRef(dir, "", "s.ts")).toBe("export const s = 2;\n");
    expect(await showBlobAtRef(dir, "HEAD", "s.ts")).toBe("export const s = 1;\n");

    // Unknown path at any ref → null, never throws.
    expect(await showBlobAtRef(dir, "HEAD", "nope.ts")).toBeNull();
    expect(await showBlobAtRef(dir, "", "nope.ts")).toBeNull();
  });
});
