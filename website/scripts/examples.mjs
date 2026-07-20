/**
 * Docs example generator (F11 AC4 — "no stale or invented output, ever").
 *
 * Every `<Terminal name="NAME" />` in the docs site is produced HERE by
 * spawning the real built `dist/cli.js` against real temp git repos — never
 * typed by hand. `generate-examples.mjs` writes the outputs into
 * website/src/generated/examples.ts, and tests/integration/docs-examples.test.ts
 * regenerates them and fails if the committed file has drifted from what the
 * CLI really prints.
 *
 * Determinism follows the §15.3 golden-snapshot convention: fields that vary
 * per run/machine (durations, timestamps, temp-dir paths) are replaced with
 * fixed placeholders by `sanitize()`. Everything else is verbatim CLI output.
 * Repos are created with FIXED directory names under a random parent so the
 * `repo:` line and history header are stable without sanitizing basenames.
 */
import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli.js");

/** Fixed placeholder values for non-deterministic fields (§15.3 convention). */
const FIXED_DURATION_S = "0.8";
const FIXED_DURATION_MS = "800";
const FIXED_STAMP_MINUTE = "2026-07-19 14:02";
const FIXED_STAMP_ISO = "2026-07-19T14:02:00.000Z";

// ---------------------------------------------------------------------------
// CLI runner + temp-repo helpers
// ---------------------------------------------------------------------------

async function ensureBuilt() {
  try {
    await access(DIST_CLI);
  } catch {
    await execFileAsync("npx", ["tsup"], { cwd: REPO_ROOT });
  }
}

/** Spawn the real CLI; resolves with stdout regardless of exit code.
 * HOME is pointed at an empty dir so a developer's/global ~/.crosscheck
 * config can never leak into a fixture run (determinism, §15.3). */
function runCli(args, cwd, { home }) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [DIST_CLI, ...args],
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", HOME: home, USERPROFILE: home },
      },
      (error, stdout) => {
        // Non-zero exits (e.g. --strict gate failures) still carry the report
        // on stdout — that output is exactly what the docs need to show.
        if (error !== null && typeof stdout !== "string") return reject(error);
        resolve(stdout.replace(/\n$/, ""));
      },
    );
  });
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

/**
 * Creates <random-tmp>/<fixedName> as a git repo. The fixed basename keeps
 * `repo:` lines and the history header stable; the random parent is the only
 * path that needs sanitizing. Names must be unique per generation run —
 * `mkdir` without recursive throws on a collision, which is a guard against
 * two fixtures silently sharing one repo directory.
 */
async function makeRepo(parent, fixedName) {
  const dir = path.join(parent, fixedName);
  await mkdir(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "CrossCheck Docs");
  git(dir, "config", "user.email", "docs@crosscheck.dev");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function write(repo, name, content) {
  await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
  await writeFile(path.join(repo, name), content);
}

async function commitAll(repo, msg) {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", msg);
}

const HISTORY_OFF_CONFIG = '{\n  "version": 1,\n  "history": { "enabled": false }\n}\n';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Landing-page demo repo: one commit of clean baselines, then a staged
 * agent-style change set that trips four high-signal rules at once. */
async function buildHeroRepo(parent) {
  const repo = await makeRepo(parent, "proteintrail-api");
  await write(repo, "crosscheck.config.json", HISTORY_OFF_CONFIG);
  await write(
    repo,
    "src/routes/webhooks.ts",
    'import { Router } from "express";\nconst router = Router();\nexport default router;\n',
  );
  await write(
    repo,
    "src/lib/paystack.ts",
    'import axios from "axios";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
  );
  await write(
    repo,
    "src/auth/middleware.ts",
    'import { requireAuth } from "./require-auth.js";\nexport function registerRoutes(app: any) {\n  app.get("/profile", requireAuth, (req: any, res: any) => res.json(req.user));\n  app.get("/admin/export", requireAuth, (req: any, res: any) => res.json({ ok: true }));\n}\n',
  );
  await commitAll(repo, "initial");

  await write(
    repo,
    "src/routes/webhooks.ts",
    'import { Router } from "express";\nconst router = Router();\nrouter.post("/webhooks/paystack", async (req, res) => {\n  if (req.body.event === "charge.success") {\n    await fulfillOrder(req.body.data.reference);\n  }\n  res.sendStatus(200);\n});\nexport default router;\n',
  );
  await write(
    repo,
    "src/lib/paystack.ts",
    'import axios from "axios";\nconst apiKey = "sk-live-51NqXyzAbCdEfGhIjKlMnOpQr";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
  );
  await write(
    repo,
    "src/auth/middleware.ts",
    'import { requireAuth } from "./require-auth.js";\nexport function registerRoutes(app: any) {\n  app.get("/profile", requireAuth, (req: any, res: any) => res.json(req.user));\n  app.get("/admin/export", (req: any, res: any) => res.json({ ok: true }));\n}\n',
  );
  await write(
    repo,
    "migrations/0017_family_plans.sql",
    "ALTER TABLE plans ADD COLUMN seat_limit integer NOT NULL;\nDROP TABLE legacy_sessions;\n",
  );
  git(repo, "add", "-A");
  return repo;
}

/** Tiny single-finding repo — quickstart's first review and the strict/json demos. */
async function buildSecretRepo(parent, name, { llm = false } = {}) {
  const repo = await makeRepo(parent, name);
  const llmBlock = llm
    ? ',\n  "llm": { "provider": "anthropic", "model": "claude-sonnet-4-5" }'
    : "";
  await write(repo, "crosscheck.config.json", `{\n  "version": 1,\n  "history": { "enabled": false }${llmBlock}\n}\n`);
  await write(
    repo,
    "src/lib/paystack.ts",
    'import axios from "axios";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
  );
  await commitAll(repo, "initial");

  await write(
    repo,
    "src/lib/paystack.ts",
    'import axios from "axios";\nconst apiKey = "sk-live-51NqXyzAbCdEfGhIjKlMnOpQr";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
  );
  git(repo, "add", "-A");
  return repo;
}

/** History demo: two recorded reviews (history enabled by default), then the list. */
async function buildHistoryRepo(parent, { home }) {
  const repo = await makeRepo(parent, "history-demo");
  await write(
    repo,
    "src/lib/paystack.ts",
    'import axios from "axios";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
  );
  await commitAll(repo, "initial");

  // Review #1: a hardcoded secret, acknowledged.
  await write(
    repo,
    "src/lib/paystack.ts",
    'import axios from "axios";\nconst apiKey = "sk-live-51NqXyzAbCdEfGhIjKlMnOpQr";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
  );
  git(repo, "add", "-A");
  await runCli(["review", "--ack", "--quiet"], repo, { home });
  await commitAll(repo, "wire paystack client");

  // Review #2: a destructive migration, left unacknowledged.
  await write(
    repo,
    "migrations/0018_drop_legacy_sessions.sql",
    "DROP TABLE legacy_sessions;\n",
  );
  git(repo, "add", "-A");
  await runCli(["review", "--quiet"], repo, { home });
  return repo;
}

// ---------------------------------------------------------------------------
// Sanitization — replace per-run/per-machine fields with fixed placeholders.
// Everything not matched here is verbatim CLI output.
// ---------------------------------------------------------------------------

function sanitize(text, tmpPaths) {
  let out = text;
  for (const p of tmpPaths) out = out.split(p).join("/home/you"); // temp-dir prefix (init, JSON repo root)
  return out
    .replace(/· \d+\.\d+s(?=\n|$)/g, `· ${FIXED_DURATION_S}s`) // mode: line duration
    .replace(/"durationMs": \d+/g, `"durationMs": ${FIXED_DURATION_MS}`)
    .replace(/"createdAt": "[^"]+"/g, `"createdAt": "${FIXED_STAMP_ISO}"`)
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, FIXED_STAMP_MINUTE); // history rows + markdown header
}

// ---------------------------------------------------------------------------
// Recipes — one entry per `<Terminal name="NAME" />` in the docs site.
// `command` is the shell line shown as the prompt (terminal style); it is the
// exact argv the recipe ran. `style: "code"` blocks show raw output only
// (e.g. a redirected markdown file) with no prompt line.
// ---------------------------------------------------------------------------

/** @typedef {{ command: string, output: string, style: "terminal" | "code" }} GeneratedExample */

/** @returns {Promise<Map<string, GeneratedExample>>} */
export async function generateExamples() {
  await ensureBuilt();
  const tmpParent = await mkdtemp(path.join(tmpdir(), "crosscheck-docs-"));
  // macOS: git reports repo roots with /var resolved to /private/var, so both
  // spellings of the temp path must be sanitized (real path first).
  const realParent = await realpath(tmpParent);
  const home = path.join(tmpParent, "home");
  await mkdir(home, { recursive: true });
  /** @type {Map<string, GeneratedExample>} */
  const examples = new Map();
  const put = (name, command, output, style = "terminal") =>
    examples.set(name, { command, output: sanitize(output, [realParent, tmpParent]), style });

  try {
    const hero = await buildHeroRepo(tmpParent);
    put("hero-demo", "git add -A && crosscheck", await runCli([], hero, { home }));

    const secret = await buildSecretRepo(tmpParent, "my-app");
    put("quickstart-review", "git add -A && crosscheck", await runCli([], secret, { home }));
    put("export-markdown", "", await runCli(["export", "--format", "markdown"], secret, { home }), "code");
    put("strict-json", "crosscheck review --strict --json", await runCli(["review", "--strict", "--json"], secret, { home }));

    // strict-pass: a history-enabled repo whose findings were acknowledged in
    // a prior run (the §9.8 "--ack, then the gate passes" flow).
    const ackRepo = await makeRepo(tmpParent, "ack-demo");
    await write(
      ackRepo,
      "src/lib/paystack.ts",
      'import axios from "axios";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
    );
    await commitAll(ackRepo, "initial");
    await write(
      ackRepo,
      "src/lib/paystack.ts",
      'import axios from "axios";\nconst apiKey = "sk-live-51NqXyzAbCdEfGhIjKlMnOpQr";\nexport const client = axios.create({ baseURL: "https://api.paystack.co" });\n',
    );
    git(ackRepo, "add", "-A");
    await runCli(["review", "--ack", "--quiet"], ackRepo, { home });
    put("strict-pass", "crosscheck review --strict --quiet", await runCli(["review", "--strict", "--quiet"], ackRepo, { home }));

    const llmSecret = await buildSecretRepo(tmpParent, "llm-demo", { llm: true });
    put("show-prompt", "crosscheck review --show-prompt", await runCli(["review", "--show-prompt"], llmSecret, { home }));

    const historyRepo = await buildHistoryRepo(tmpParent, { home });
    put("history-list", "crosscheck history", await runCli(["history"], historyRepo, { home }));

    put("rules-list", "crosscheck rules", await runCli(["rules"], hero, { home }));
    put("rules-show-webhook", "crosscheck rules payments/webhook-endpoint", await runCli(["rules", "payments/webhook-endpoint"], hero, { home }));

    const initDir = await makeRepo(tmpParent, "init-demo");
    put("init-yes", "crosscheck init --yes", await runCli(["init", "--yes"], initDir, { home }));
  } finally {
    await rm(tmpParent, { recursive: true, force: true });
  }

  return examples;
}

/** Convenience for the type declarations of consumers. */
export const EXAMPLE_NAMES = Object.freeze([
  "hero-demo",
  "quickstart-review",
  "export-markdown",
  "strict-json",
  "strict-pass",
  "show-prompt",
  "history-list",
  "rules-list",
  "rules-show-webhook",
  "init-yes",
]);
