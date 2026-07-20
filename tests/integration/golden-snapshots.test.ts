/**
 * Golden-output snapshot tests (§15.3): run the FULL pipeline (`runReview`,
 * §6.2) against real temp git repos, then render the resulting `ReviewReport`
 * through all three renderers and snapshot the output.
 *
 * Four representative fixtures, five runs (the webhook pair is two runs of
 * one scenario): `hardcoded-secret`, `no-verify-webhook` + `verified-webhook`,
 * `destructive-migration`, and `clean-refactor` (the "all clean" case).
 *
 * `createdAt`, `stats.durationMs`, `toolVersion`, and `repo` (temp-dir path +
 * randomized mkdtemp suffix name) are non-deterministic across runs/machines
 * — `sanitizeReport` overwrites them with fixed placeholders on the report
 * object itself, BEFORE rendering, so every renderer's output (including the
 * JSON renderer, which serializes these fields verbatim) is fully
 * deterministic. `range: { kind: "staged" }` is used throughout so `range.desc`
 * stays the literal string "staged" (a range-mode run would embed a real
 * commit SHA in `baseRef`/`headRef`).
 *
 * Snapshot review is a deliberate human step in PRs (§15.3) — the committed
 * `.snap` file is expected and correct, not a stray artifact to clean up.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { runReview } from "../../src/pipeline.js";
import { render } from "../../src/render/index.js";
import type { CrossCheckConfig, ReviewReport } from "../../src/types.js";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crosscheck-golden-"));
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

async function stageFile(git: SimpleGit, dir: string, name: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
  await writeFile(path.join(dir, name), content);
  await git.add(".");
}

function freshConfig(): CrossCheckConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  base.history.enabled = false; // deterministic — no sql.js WASM in a snapshot fixture
  return base;
}

/** Overwrite every non-deterministic field with a fixed placeholder (§15.3). */
function sanitizeReport(report: ReviewReport): ReviewReport {
  const sanitized = structuredClone(report);
  sanitized.toolVersion = "0.0.0-test";
  sanitized.createdAt = "1970-01-01T00:00:00.000Z";
  sanitized.stats.durationMs = 0;
  if (sanitized.repo !== null) {
    sanitized.repo = { root: "/repo", name: "repo" };
  }
  return sanitized;
}

interface RenderedTriple {
  terminal: string;
  markdown: string;
  json: string;
}

function renderAll(report: ReviewReport): RenderedTriple {
  const sanitized = sanitizeReport(report);
  return {
    terminal: render(sanitized, "terminal", { color: false }),
    markdown: render(sanitized, "markdown"),
    json: render(sanitized, "json"),
  };
}

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("golden snapshots (§15.3) — hardcoded-secret", () => {
  it("renders terminal/markdown/json for an inline Paystack secret key", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(
      git,
      dir,
      "src/integrations/paystack.ts",
      'import axios from "axios";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
      "initial",
    );
    await stageFile(
      git,
      dir,
      "src/integrations/paystack.ts",
      'import axios from "axios";\nconst apiKey = "sk-live-51NqXyzAbCdEfGhIjKlMnOpQr";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
    );

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    const rendered = renderAll(outcome.report);

    expect(rendered.terminal).toMatchSnapshot("hardcoded-secret.terminal");
    expect(rendered.markdown).toMatchSnapshot("hardcoded-secret.markdown");
    expect(rendered.json).toMatchSnapshot("hardcoded-secret.json");
  });
});

describe("golden snapshots (§15.3) — no-verify-webhook / verified-webhook pair", () => {
  it("no-verify-webhook: fires at full severity — HEAD has no guard anywhere", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(
      git,
      dir,
      "src/routes/webhooks.ts",
      'import { Router } from "express";\nconst router = Router();\nexport default router;\n',
      "initial",
    );
    await stageFile(
      git,
      dir,
      "src/routes/webhooks.ts",
      'import { Router } from "express";\nconst router = Router();\nrouter.post("/webhooks/paystack", handler);\nexport default router;\n',
    );

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.findings.some((f) => f.ruleId === "payments/webhook-endpoint")).toBe(true);
    const rendered = renderAll(outcome.report);

    expect(rendered.terminal).toMatchSnapshot("no-verify-webhook.terminal");
    expect(rendered.markdown).toMatchSnapshot("no-verify-webhook.markdown");
    expect(rendered.json).toMatchSnapshot("no-verify-webhook.json");
  });

  it("verified-webhook: downgraded to an info note — HEAD already has the signature guard", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(
      git,
      dir,
      "src/routes/webhooks.ts",
      'import { createHmac } from "crypto";\nimport { Router } from "express";\nconst router = Router();\nfunction verifySignature(rawBody: string, signature: string, secret: string): boolean {\n  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");\n  return digest === signature;\n}\nexport default router;\n',
      "initial",
    );
    await stageFile(
      git,
      dir,
      "src/routes/webhooks.ts",
      'import { createHmac } from "crypto";\nimport { Router } from "express";\nconst router = Router();\nfunction verifySignature(rawBody: string, signature: string, secret: string): boolean {\n  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");\n  return digest === signature;\n}\nrouter.post("/webhooks/paystack", handler);\nexport default router;\n',
    );

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.findings.some((f) => f.ruleId === "payments/webhook-endpoint")).toBe(false);
    expect(outcome.report.infoFindings.some((f) => f.ruleId === "payments/webhook-endpoint")).toBe(true);
    const rendered = renderAll(outcome.report);

    expect(rendered.terminal).toMatchSnapshot("verified-webhook.terminal");
    expect(rendered.markdown).toMatchSnapshot("verified-webhook.markdown");
    expect(rendered.json).toMatchSnapshot("verified-webhook.json");
  });
});

describe("golden snapshots (§15.3) — destructive-migration", () => {
  it("renders terminal/markdown/json for a DROP TABLE + non-nullable-column-without-default migration", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(git, dir, "README.md", "placeholder\n", "initial");
    await stageFile(
      git,
      dir,
      "migrations/0007_drop_sessions.sql",
      "DROP TABLE sessions;\nALTER TABLE users ADD COLUMN email_verified boolean NOT NULL;\n-- no backfill or rollback provided\n",
    );

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    const rendered = renderAll(outcome.report);

    expect(rendered.terminal).toMatchSnapshot("destructive-migration.terminal");
    expect(rendered.markdown).toMatchSnapshot("destructive-migration.markdown");
    expect(rendered.json).toMatchSnapshot("destructive-migration.json");
  });
});

describe("golden snapshots (§15.3) — clean-refactor (all-clean case)", () => {
  it("renders terminal/markdown/json for a benign refactor with zero findings", async () => {
    const dir = await tempDir();
    const git = await initRepo(dir);
    await commitFile(
      git,
      dir,
      "src/components/user-label.ts",
      'export function renderLabel(user: { name: string; title: string }): string {\n  const n = user.name.trim();\n  const t = user.title.trim();\n  return `<span class="text-sm text-gray-500">${n} - ${t}</span>`;\n}\n',
      "initial",
    );
    await stageFile(
      git,
      dir,
      "src/components/user-label.ts",
      'export function renderLabel(user: { name: string; title: string }): string {\n  const name = formatPart(user.name);\n  const title = formatPart(user.title);\n  return `<span class="text-sm text-gray-600 font-medium">${name} — ${title}</span>`;\n}\n\nfunction formatPart(value: string): string {\n  return value.trim();\n}\n',
    );

    const outcome = await runReview({ cwd: dir, range: { kind: "staged" }, flags: {}, config: freshConfig() });
    if (outcome.kind !== "report") throw new Error("expected a report outcome");
    expect(outcome.report.findings).toEqual([]);
    const rendered = renderAll(outcome.report);

    expect(rendered.terminal).toMatchSnapshot("clean-refactor.terminal");
    expect(rendered.markdown).toMatchSnapshot("clean-refactor.markdown");
    expect(rendered.json).toMatchSnapshot("clean-refactor.json");
  });
});
