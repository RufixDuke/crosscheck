/**
 * AST infrastructure (§5.4, §7.3, §13.2): in-memory, syntax-only ts-morph
 * project over the changed files. ts-morph (~9 MB) is loaded lazily — when it
 * cannot be loaded at all this returns null and callers take the
 * degraded-but-useful regex/path fallback path (§6.4).
 *
 * The project is deliberately bounded (§13.2): in-memory file system, no lib
 * loading, no module resolution, no type-checking, capped file count.
 */
import { posix } from "node:path";
import type { Project, SourceFile, SyntaxKind } from "ts-morph";
import type { AstProjectHandle } from "./types.js";

/** File extensions loaded into the AST project (§5.4 layer 2). */
const LOADABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

/** Probe order when resolving relative import specifiers (extensionless + /index). */
const PROBE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"] as const;

/** Hard cap on files in the in-memory project (§13.2). */
const DEFAULT_CAP = 200;

function extname(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

/** Normalize a repo-relative path to forward slashes, resolving `.`/`..`. */
function normalizeRepoPath(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/"));
}

export async function loadAstProject(
  files: Array<{ path: string; content: string }>,
  opts?: { cap?: number },
): Promise<AstProjectHandle | null> {
  let ProjectCtor: typeof Project;
  let syntaxKind: typeof SyntaxKind;
  try {
    const morph = await import("ts-morph");
    ProjectCtor = morph.Project;
    syntaxKind = morph.SyntaxKind;
  } catch {
    // ts-morph unavailable (broken install, OOM, …) → degraded mode (§6.4).
    return null;
  }

  const cap = opts?.cap ?? DEFAULT_CAP;

  let project: Project;
  try {
    project = new ProjectCtor({
      useInMemoryFileSystem: true,
      compilerOptions: {
        allowJs: true,
        skipLibCheck: true,
        noLib: true,
        noResolve: true,
      },
    });
  } catch {
    return null;
  }

  const sourceFiles = new Map<string, SourceFile>();
  const analyzed: string[] = [];
  const skipped: string[] = [];

  let loaded = 0;
  for (const file of files) {
    const path = normalizeRepoPath(file.path);
    if (!LOADABLE_EXTENSIONS.has(extname(path))) {
      // Non-TS/JS files are never AST-analyzed (§11.4) — counted as skipped
      // so the report footer can say "AST analysis skipped for N files".
      skipped.push(path);
      continue;
    }
    if (loaded >= cap) {
      // Beyond the cap (§13.2): AST matchers degrade to regex; footer counts.
      skipped.push(path);
      continue;
    }
    loaded += 1;
    try {
      const sf = project.createSourceFile(path, file.content, { overwrite: true });
      // ts-morph's parser is error-tolerant — a syntactically broken file
      // still produces a SourceFile. Treat files with syntax (parse-level)
      // diagnostics as skipped (§7.3): regex rules still apply to them, AST
      // matchers don't. Syntactic-only on purpose: with noLib/noResolve the
      // semantic pass would report nothing but missing-global noise.
      if (project.getProgram().getSyntacticDiagnostics(sf).length > 0) {
        project.removeSourceFile(sf);
        skipped.push(path);
        continue;
      }
      sourceFiles.set(path, sf);
      analyzed.push(path);
    } catch {
      skipped.push(path);
    }
  }

  /** Resolve a relative import specifier to a loaded repo-relative path. */
  function resolveRelativeImport(fromPath: string, specifier: string): string | undefined {
    const fromDir = posix.dirname(fromPath);
    const base = normalizeRepoPath(posix.join(fromDir, specifier));
    const candidates: string[] = [];
    if (LOADABLE_EXTENSIONS.has(extname(base))) {
      candidates.push(base);
    }
    for (const ext of PROBE_EXTENSIONS) {
      candidates.push(base + ext);
    }
    for (const ext of PROBE_EXTENSIONS) {
      candidates.push(`${base}/index${ext}`);
    }
    // ESM-style specifiers ("./x.js" that really means "./x.ts" — the TS
    // source of a compiled import): swap the JS extension for TS probes.
    const ext = extname(base);
    if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
      const stem = base.slice(0, base.length - ext.length);
      for (const probe of PROBE_EXTENSIONS) {
        candidates.push(stem + probe);
      }
    }
    for (const candidate of candidates) {
      if (sourceFiles.has(candidate)) return candidate;
    }
    return undefined;
  }

  const handle: AstProjectHandle = {
    analyzed,
    skipped,

    getSourceFile(path: string): SourceFile | undefined {
      return sourceFiles.get(normalizeRepoPath(path));
    },

    importEdges(): Array<readonly [string, string]> {
      const edges: Array<readonly [string, string]> = [];
      for (const [path, sf] of sourceFiles) {
        for (const decl of sf.getImportDeclarations()) {
          const specifier = decl.getModuleSpecifierValue();
          if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
          const target = resolveRelativeImport(path, specifier);
          if (target !== undefined) edges.push([path, target] as const);
        }
      }
      return edges;
    },

    changedSymbols(path: string, lineRanges: Array<readonly [number, number]>): string[] {
      const sf = sourceFiles.get(normalizeRepoPath(path));
      if (sf === undefined || lineRanges.length === 0) return [];

      const overlaps = (nodeStart: number, nodeEnd: number): boolean =>
        lineRanges.some(([rangeStart, rangeEnd]) => nodeStart <= rangeEnd && nodeEnd >= rangeStart);

      const names: string[] = [];
      const seen = new Set<string>();
      const push = (name: string | undefined): void => {
        if (name !== undefined && name !== "" && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      };

      // Top-level function declarations (getFunctions, §5.4).
      for (const fn of sf.getFunctions()) {
        if (overlaps(fn.getStartLineNumber(), fn.getEndLineNumber())) push(fn.getName());
      }
      // Classes and their methods (getClasses / getMethods).
      for (const cls of sf.getClasses()) {
        const classOverlaps = overlaps(cls.getStartLineNumber(), cls.getEndLineNumber());
        if (classOverlaps) push(cls.getName());
        for (const method of cls.getMethods()) {
          if (overlaps(method.getStartLineNumber(), method.getEndLineNumber())) push(method.getName());
        }
      }
      // Arrow functions / function expressions assigned to variables.
      for (const decl of sf.getVariableDeclarations()) {
        const init = decl.getInitializer();
        if (init === undefined) continue;
        const kind = init.getKind();
        if (kind !== syntaxKind.ArrowFunction && kind !== syntaxKind.FunctionExpression) continue;
        if (overlaps(decl.getStartLineNumber(), decl.getEndLineNumber())) push(decl.getName());
      }
      return names;
    },
  };

  return handle;
}
