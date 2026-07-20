/**
 * Rule context (§6.2 step 4/5, §7.9, §7.10): everything the rule engine needs
 * beyond the diff itself.
 *
 * - `readFileAtHead` — `git show HEAD:<path>` for guard verification (§7.9);
 *   null on any failure (verification only ever reduces noise, §6.4).
 * - `readWorkingFile` — working-tree read for new/untracked files (§7.9).
 * - `dependencies` — package.json dependencies + devDependencies keys, read
 *   once per run; null when missing/unparseable → signals skipped silently.
 * - `dependencySignalsEnabled` — the `rules.dependencySignals` config switch.
 *
 * Tests inject fakes for all of these; the factory defaults to real fs/git
 * readers when a `cwd` is given.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface RuleContext {
  /** `git show HEAD:<path>`; null on failure (§7.9, §6.4). */
  readFileAtHead(path: string): Promise<string | null>;
  /** Working-tree read; used for new/untracked files (§7.9). */
  readWorkingFile(path: string): Promise<string | null>;
  /** package.json deps+devDeps keys, once per run; null when unreadable. */
  dependencies: Set<string> | null;
  dependencySignalsEnabled: boolean;
}

const execFileAsync = promisify(execFile);

function defaultReadFileAtHead(cwd: string): (path: string) => Promise<string | null> {
  return async (path: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", ["show", `HEAD:${path}`], {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  };
}

function defaultReadWorkingFile(cwd: string): (path: string) => Promise<string | null> {
  return async (path: string): Promise<string | null> => {
    try {
      return await readFileAsync(join(cwd, path), "utf8");
    } catch {
      return null;
    }
  };
}

/** Parse dependency + devDependency keys; null on any parse problem (§6.4). */
function parseDependencies(packageJsonText: string): Set<string> | null {
  try {
    const json: unknown = JSON.parse(packageJsonText);
    if (typeof json !== "object" || json === null) return null;
    const deps = new Set<string>();
    for (const section of ["dependencies", "devDependencies"] as const) {
      const value = (json as Record<string, unknown>)[section];
      if (typeof value === "object" && value !== null) {
        for (const name of Object.keys(value)) deps.add(name);
      }
    }
    return deps;
  } catch {
    return null;
  }
}

const NO_READ = async (): Promise<string | null> => null;

export function createRuleContext(opts?: {
  cwd?: string;
  readFileAtHead?: (path: string) => Promise<string | null>;
  readWorkingFile?: (path: string) => Promise<string | null>;
  packageJsonText?: string | null;
  dependencySignalsEnabled?: boolean;
}): RuleContext {
  const cwd = opts?.cwd;

  const readFileAtHead = opts?.readFileAtHead ?? (cwd !== undefined ? defaultReadFileAtHead(cwd) : NO_READ);
  const readWorkingFile = opts?.readWorkingFile ?? (cwd !== undefined ? defaultReadWorkingFile(cwd) : NO_READ);

  let dependencies: Set<string> | null;
  if (opts?.packageJsonText !== undefined) {
    dependencies = opts.packageJsonText === null ? null : parseDependencies(opts.packageJsonText);
  } else if (cwd !== undefined) {
    // Read once per run, silently (§6.4): missing/unreadable → null.
    let text: string | null = null;
    try {
      text = readFileSync(join(cwd, "package.json"), "utf8");
    } catch {
      text = null;
    }
    dependencies = text === null ? null : parseDependencies(text);
  } else {
    dependencies = null;
  }

  return {
    readFileAtHead,
    readWorkingFile,
    dependencies,
    dependencySignalsEnabled: opts?.dependencySignalsEnabled ?? true,
  };
}
