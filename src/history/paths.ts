/**
 * History DB location resolution (§5.6/§6.3): `<repoRoot>/.git/crosscheck/history.db`
 * normally, falling back to `~/.crosscheck/history.db` when there's no repo
 * context (e.g. `--stdin` with no discoverable `.git`, §11.5).
 */
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_RELATIVE_DB_PATH = ".git/crosscheck/history.db";
export const GLOBAL_DB_RELATIVE_TO_HOME = ".crosscheck/history.db";

export interface ResolveHistoryDbPathOptions {
  /** Explicit path — highest precedence, mainly for tests and `--config` overrides. */
  explicitPath?: string;
  /** Repo root to resolve a relative `configuredPath` against. Null/undefined → global fallback. */
  repoRoot?: string | null;
  /** `config.history.dbPath` (§12); defaults to `.git/crosscheck/history.db`. May start with `~`. */
  configuredPath?: string;
  /** Override for `os.homedir()` in tests. */
  homeDir?: string;
}

function expandHome(filePath: string, homeDir: string): string {
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homeDir, filePath.slice(2));
  }
  return filePath;
}

export function resolveHistoryDbPath(opts: ResolveHistoryDbPathOptions = {}): string {
  const home = opts.homeDir ?? homedir();

  if (opts.explicitPath !== undefined) {
    return path.resolve(expandHome(opts.explicitPath, home));
  }

  const configured = expandHome(opts.configuredPath ?? DEFAULT_RELATIVE_DB_PATH, home);
  if (path.isAbsolute(configured)) return configured;

  if (opts.repoRoot != null) return path.resolve(opts.repoRoot, configured);

  // No repo context: global fallback, independent of `configuredPath` being relative.
  return path.join(home, GLOBAL_DB_RELATIVE_TO_HOME);
}
