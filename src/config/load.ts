/**
 * Config discovery, precedence, and flag mapping (§12.1, §12.3, §12.4).
 *
 * Precedence (later layers win): defaults → global `~/.crosscheck/config.json`
 * → project `crosscheck.config.json` (nearest found walking up from the scope
 * or cwd) → environment variables → CLI flags (applied via `applyFlags`).
 *
 * Merge semantics: plain objects merge key-by-key (so `llm.consentGiven` and
 * `rules.severityOverrides` merge per key); arrays REPLACE wholesale — a
 * project `rules.disable` fully overrides the global one rather than
 * concatenating, which keeps each layer's intent unambiguous.
 */

import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CrossCheckConfig, LLMProviderName, ReviewFlags } from "../types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { sanitizeJsonc } from "./jsonc.js";
import { parseConfig } from "./schema.js";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface LoadedConfig {
  config: CrossCheckConfig;
  warnings: string[];
  /** Paths actually loaded, in precedence order (global before project). */
  sources: string[];
  /**
   * Where a project config lives, or where `crosscheck init` would write one
   * when none was found. Null when discovery was bypassed via `--config` /
   * `CROSSCHECK_CONFIG`.
   */
  projectConfigPath: string | null;
}

export const PROJECT_CONFIG_FILENAME = "crosscheck.config.json";

const LLM_PROVIDERS: readonly LLMProviderName[] = ["anthropic", "openai", "openrouter"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

/**
 * Merges one validated config layer over `target`, in place. Objects merge
 * recursively; arrays and scalars replace. `undefined` leaves keys untouched.
 */
function mergeLayer(target: Record<string, unknown>, layer: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      mergeLayer(existing, value);
    } else {
      target[key] = value;
    }
  }
}

/** Nearest `crosscheck.config.json` walking up from `startDir` to the fs root. */
async function findProjectConfig(startDir: string): Promise<string | null> {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, PROJECT_CONFIG_FILENAME);
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadConfig(opts: {
  cwd: string;
  repoRoot?: string | null;
  scope?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const cwd = path.resolve(opts.cwd);
  const repoRoot = opts.repoRoot != null ? path.resolve(opts.repoRoot) : null;

  const config = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  const warnings: string[] = [];
  const sources: string[] = [];
  let projectConfigPath: string | null = null;

  const loadLayer = async (filePath: string): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(sanitizeJsonc(await readFile(filePath, "utf8")));
    } catch (err) {
      throw new ConfigError(`invalid config at ${filePath}: ${(err as Error).message}`);
    }
    const parsed = parseConfig(raw, filePath);
    if (!parsed.ok) {
      const details = parsed.errors.map((e) =>
        e.startsWith(`${filePath}: `) ? e.slice(filePath.length + 2) : e,
      );
      throw new ConfigError(`invalid config at ${filePath}: ${details.join("; ")}`);
    }
    warnings.push(...parsed.warnings);
    mergeLayer(config, parsed.config as Record<string, unknown>);
    sources.push(filePath);
  };

  const explicitPath = opts.configPath ?? nonEmpty(env.CROSSCHECK_CONFIG);
  if (explicitPath !== undefined) {
    // --config / CROSSCHECK_CONFIG bypasses discovery (§12.1).
    const filePath = path.resolve(cwd, explicitPath);
    if (!(await fileExists(filePath))) {
      throw new ConfigError(`config file not found: ${filePath}`);
    }
    await loadLayer(filePath);
  } else {
    const globalPath = path.join(home, ".crosscheck", "config.json");
    if (await fileExists(globalPath)) await loadLayer(globalPath);

    const startDir = opts.scope !== undefined ? path.resolve(repoRoot ?? cwd, opts.scope) : (repoRoot ?? cwd);
    const found = await findProjectConfig(startDir);
    if (found !== null) {
      await loadLayer(found);
      projectConfigPath = found;
    } else {
      projectConfigPath = path.join(repoRoot ?? cwd, PROJECT_CONFIG_FILENAME);
    }
  }

  // Environment overrides (§12.3). CROSSCHECK_OFFLINE is consumed by the CLI
  // as a flag, not folded into config.
  const provider = nonEmpty(env.CROSSCHECK_LLM_PROVIDER);
  if (provider !== undefined) {
    if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ConfigError(
        `invalid CROSSCHECK_LLM_PROVIDER ${JSON.stringify(provider)} — expected "anthropic" | "openai" | "openrouter"`,
      );
    }
    (config.llm as Record<string, unknown>).provider = provider;
  }
  const model = nonEmpty(env.CROSSCHECK_LLM_MODEL);
  if (model !== undefined) {
    (config.llm as Record<string, unknown>).model = model;
  }
  if (nonEmpty(env.NO_COLOR) !== undefined) {
    (config.output as Record<string, unknown>).color = false;
  }

  return { config: config as unknown as CrossCheckConfig, warnings, sources, projectConfigPath };
}

/**
 * Maps CLI flags onto their config equivalents (§12.4: every flag has one).
 * LLM model/provider live in ReviewFlags' domain sibling — they are the LLM
 * module's concern and are deliberately not handled here; `scope`/`maxFiles`
 * are pipeline concerns, not config. NO_COLOR always wins over `--color`.
 * Returns a new config; the input is not mutated.
 */
export function applyFlags(
  config: CrossCheckConfig,
  flags: ReviewFlags,
  env: NodeJS.ProcessEnv = process.env,
): CrossCheckConfig {
  const next = structuredClone(config);
  if (flags.format !== undefined) next.output.format = flags.format;
  if (flags.maxTests !== undefined) next.output.maxTests = flags.maxTests;
  if (flags.failOn !== undefined) next.strict.failOn = flags.failOn;
  if (flags.color !== undefined) next.output.color = flags.color;
  if (nonEmpty(env.NO_COLOR) !== undefined) next.output.color = false;
  return next;
}

// ---------------------------------------------------------------------------
// `crosscheck init` (§12.1 — the project config is meant to be committed)
// ---------------------------------------------------------------------------

/** Canonical minimal project config written by `crosscheck init`. */
export const DEFAULT_PROJECT_CONFIG_TEXT = `{
  "$schema": "https://raw.githubusercontent.com/<org>/crosscheck/main/schema/crosscheck.config.schema.json",
  "version": 1,
  "rules": {
    "enable": []
  },
  "ignore": [],
  "strict": {
    "failOn": "high"
  },
  "llm": {
    "provider": null
  }
}
`;

/**
 * Writes `crosscheck.config.json` into `dir` and returns its path. Refuses
 * to overwrite an existing file unless `opts.force` is set.
 */
export async function writeProjectConfig(dir: string, opts: { force?: boolean } = {}): Promise<string> {
  const filePath = path.join(dir, PROJECT_CONFIG_FILENAME);
  if (!opts.force && (await fileExists(filePath))) {
    throw new ConfigError(`config already exists at ${filePath} — use --force to overwrite`);
  }
  await writeFile(filePath, DEFAULT_PROJECT_CONFIG_TEXT, "utf8");
  return filePath;
}
