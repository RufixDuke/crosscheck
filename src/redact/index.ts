/**
 * Redaction pipeline (§10.2, §10.3) — the security-critical module every
 * LLM adapter must route through before anything leaves the machine.
 *
 * `redact()` is a pure function. Its return type, `RedactedContext`, is
 * *nominal*: the interface carries a property keyed by a module-private
 * `unique symbol` that is never exported. No object literal written outside
 * this file can structurally satisfy `RedactedContext` — TypeScript will
 * reject it — so a provider adapter whose `summarize()` signature accepts
 * only `RedactedContext` cannot be handed a raw string or a hand-built
 * object. Bypassing redaction is a compile error, not a runtime policy
 * decision (§10.2, §10.3 "verification" section, §15.4).
 *
 * Ordered stages (each runs over the output of the previous one, §10.2/§10.3):
 *   1. PEM private-key blocks → `<SECRET:private-key>`
 *   2. Known secret patterns  → `<SECRET:TYPE>` (+ base64/hex blobs → generic)
 *   3. Long string literals   → `<STRING:len=N>` (with URL/class-list/prose
 *      exemptions)
 *   4. Env-style `KEY=value` lines → `KEY=<REDACTED>`
 *   5. File paths → repo-relative (always) / opaque (opt-in `anonymizePaths`)
 *   6. Large numeric literals → `<NUM>`
 *
 * Comments are never stripped — stages 1–3 simply run over their text like
 * any other text, so a secret pasted in a comment is still caught (§10.3
 * rule 6). Identifiers, import paths, control flow, type signatures, and
 * short string literals are never touched (§10.3 "never redacted").
 */
import {
  containsPlaceholder,
  ENV_LINE_RE,
  GENERIC_SECRET_RE,
  isClassListLike,
  isEncodedBlobLike,
  isProseLike,
  isUrlLike,
  LARGE_NUMBER_RE,
  PEM_BLOCK_RE,
  QUOTED_STRING_RE,
  SECRET_PATTERNS,
} from "./patterns.js";

declare const REDACTED_BRAND: unique symbol;

/**
 * The only value `redact()` can produce. See the module doc above — the
 * brand property is keyed by a symbol private to this module, so nothing
 * outside `src/redact/index.ts` can construct a value of this type.
 */
export interface RedactedContext {
  readonly [REDACTED_BRAND]: true;
  readonly text: string;
  readonly redactionCount: number;
  readonly redactionTypes: string[];
}

export interface RedactOptions {
  /** §10.2 stage 5 — off by default; rewrites paths to `src/file-1.ts` style. */
  anonymizePaths?: boolean;
  /**
   * Absolute repo root, if the caller has it (the LLM layer does, via git).
   * When given, an exact prefix strip is used instead of the best-effort
   * home-directory heuristic below.
   */
  repoRoot?: string;
}

/** Home-directory-shaped absolute path prefixes (posix + Windows), best effort
 * when the caller doesn't supply an exact `repoRoot` (§10.3 rule 4). */
const HOME_PREFIX_RE = /(?:\/(?:Users|home)\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)([\\/][^\s"'`]*)/g;

function record(counts: Map<string, number>, type: string): void {
  counts.set(type, (counts.get(type) ?? 0) + 1);
}

function redactPemBlocks(text: string, counts: Map<string, number>): string {
  return text.replace(PEM_BLOCK_RE, () => {
    record(counts, "private-key");
    return "<SECRET:private-key>";
  });
}

function redactKnownSecrets(text: string, counts: Map<string, number>): string {
  let out = text;
  for (const { type, regex } of SECRET_PATTERNS) {
    out = out.replace(regex, () => {
      record(counts, type);
      return `<SECRET:${type}>`;
    });
  }
  // Generic assignment secrets: key name preserved, value replaced.
  out = out.replace(GENERIC_SECRET_RE, (_match, name: string, sep: string, quote: string) => {
    record(counts, "generic");
    return `${name}${sep}${quote}<SECRET:generic>${quote}`;
  });
  // Base64/hex blobs inside quotes, regardless of length — routed to the
  // generic secret placeholder rather than the length-annotated one.
  out = out.replace(QUOTED_STRING_RE, (match, quote: string, content: string) => {
    if (containsPlaceholder(content)) return match;
    if (!isEncodedBlobLike(content)) return match;
    record(counts, "generic");
    return `${quote}<SECRET:generic>${quote}`;
  });
  return out;
}

function redactLongStrings(text: string, counts: Map<string, number>): string {
  return text.replace(QUOTED_STRING_RE, (match, quote: string, content: string) => {
    // Already (partially or fully) redacted by an earlier stage — a prior
    // typed placeholder embedded in otherwise-short surrounding text must
    // not be collapsed into a coarser <STRING:len=N>, or the "kind" signal
    // stage 2 worked to preserve would be lost.
    if (containsPlaceholder(content)) return match;
    if (content.length <= 24) return match; // short literals always survive
    if (isEncodedBlobLike(content)) {
      record(counts, "generic");
      return `${quote}<SECRET:generic>${quote}`;
    }
    if (isUrlLike(content) || isClassListLike(content) || isProseLike(content)) return match;
    record(counts, "string");
    return `${quote}<STRING:len=${content.length}>${quote}`;
  });
}

function redactEnvLines(text: string, counts: Map<string, number>): string {
  return text.replace(ENV_LINE_RE, (match, prefix: string, key: string, value: string) => {
    if (value.trim().length === 0) return match; // `KEY=` with nothing to hide
    if (containsPlaceholder(value)) return match;
    record(counts, "env-value");
    return `${prefix}${key}=<REDACTED>`;
  });
}

function stripAbsolutePathPrefixes(text: string, counts: Map<string, number>, repoRoot?: string): string {
  let out = text;
  if (repoRoot !== undefined && repoRoot.length > 0) {
    const normalizedRoot = repoRoot.replace(/[/\\]+$/, "");
    if (out.includes(normalizedRoot)) {
      out = out.split(`${normalizedRoot}/`).join("");
      out = out.split(`${normalizedRoot}\\`).join("");
      out = out.split(normalizedRoot).join("");
      record(counts, "path");
    }
    return out;
  }
  // Best-effort fallback: strip `/home/<user>/` or `/Users/<user>/` (or the
  // Windows equivalent) and the very next path segment, which is almost
  // always the repo directory name itself — leaving a repo-relative path.
  out = out.replace(HOME_PREFIX_RE, (_match, rest: string) => {
    record(counts, "path");
    const segments = rest.split(/[\\/]/).filter(Boolean);
    return segments.slice(1).join("/");
  });
  return out;
}

let anonSeq = 0;
const PATH_TOKEN_RE = /(^|[\s"'`(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)\b/g;

function anonymizePaths(text: string, counts: Map<string, number>): string {
  const seen = new Map<string, string>();
  return text.replace(PATH_TOKEN_RE, (match, lead: string, pathToken: string) => {
    let anon = seen.get(pathToken);
    if (anon === undefined) {
      const extMatch = /\.([A-Za-z0-9]+)$/.exec(pathToken);
      const ext = extMatch?.[1] ?? "txt";
      anonSeq += 1;
      anon = `src/file-${anonSeq}.${ext}`;
      seen.set(pathToken, anon);
      record(counts, "path");
    }
    return `${lead}${anon}`;
  });
}

function redactLargeNumbers(text: string, counts: Map<string, number>): string {
  return text.replace(LARGE_NUMBER_RE, () => {
    record(counts, "number");
    return "<NUM>";
  });
}

function brand(value: Omit<RedactedContext, typeof REDACTED_BRAND>): RedactedContext {
  return value as RedactedContext;
}

/**
 * Redact `text` per §10.2/§10.3. This is the ONLY way to produce a
 * `RedactedContext` — see the module doc for why that makes bypassing
 * redaction a type error rather than a runtime check.
 */
export function redact(text: string, opts: RedactOptions = {}): RedactedContext {
  const counts = new Map<string, number>();

  let out = text;
  out = redactPemBlocks(out, counts);
  out = redactKnownSecrets(out, counts);
  out = redactLongStrings(out, counts);
  out = redactEnvLines(out, counts);
  out = stripAbsolutePathPrefixes(out, counts, opts.repoRoot);
  if (opts.anonymizePaths === true) out = anonymizePaths(out, counts);
  out = redactLargeNumbers(out, counts);

  return brand({
    text: out,
    redactionCount: [...counts.values()].reduce((sum, n) => sum + n, 0),
    redactionTypes: [...counts.keys()].sort(),
  });
}
