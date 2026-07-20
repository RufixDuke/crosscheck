/**
 * Pattern battery + content heuristics behind the redaction pipeline (§10.2
 * stage 2–3, §10.3 rules 1–2). Kept separate from index.ts so the ordered
 * stages in index.ts read as a short, auditable list.
 *
 * Every regex here is compiled once at module load (§13.2 regex hygiene) —
 * there is no per-call compilation.
 */

export interface SecretPattern {
  /** `<SECRET:TYPE>` — the TYPE that appears in the placeholder and in
   * `RedactedContext.redactionTypes` (§10.2 stage 2 / §10.3 rule 1). */
  type: string;
  regex: RegExp;
}

// Ordered most-specific-first: Anthropic's `sk-ant-` must be tried before the
// looser OpenAI `sk-` pattern, and the Paystack/Stripe `sk_live_`/`sk_test_`
// (underscore) shapes never collide with either (hyphen vs underscore).
export const SECRET_PATTERNS: SecretPattern[] = [
  { type: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    type: "github-token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}\b|\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  },
  { type: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g },
  { type: "openai-key", regex: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g },
  { type: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "paystack-live-key", regex: /\bsk_live_[A-Za-z0-9]{10,}\b/g },
  { type: "payment-test-key", regex: /\bsk_test_[A-Za-z0-9]{10,}\b/g },
  { type: "jwt", regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g },
];

/** PEM private-key blocks (§10.2 stage 2) — matched and replaced whole. */
export const PEM_BLOCK_RE = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

/**
 * Generic assignment secrets (§10.2 stage 2 / §10.3 rule 1): the key NAME
 * stays, only the value is replaced. The keyword is allowed to sit inside a
 * larger camelCase identifier (`secretKey`, `dbPassword`, `authToken`) since
 * that is the overwhelmingly common real-world shape — a stricter literal
 * match of the PRD's `(password|secret|api[_-]?key|token)\s*[:=]` would miss
 * `secretKey = "..."` entirely (judgment call, documented in the PR).
 */
export const GENERIC_SECRET_RE =
  /\b([A-Za-z_]*(?:password|passwd|secret|api[_-]?key|token|private[_-]?key)[A-Za-z_]*)(\s*[:=]\s*)(["'`])(?!<)([^"'`\s]{8,})\3/gi;

/** Env-style `KEY=value` lines (§10.2 stage 4) — whole-line match. */
export const ENV_LINE_RE = /^([ \t]*[+\-]?[ \t]*)([A-Z][A-Z0-9_]*)=([^\n;]*)$/gm;

/** Large numeric literals that look like IDs/keys/card numbers (§10.3 rule 5). */
export const LARGE_NUMBER_RE = /\b\d{6,}\b/g;

/** Quoted string literal (single/double/backtick), non-greedy, no escape handling. */
export const QUOTED_STRING_RE = /(["'`])((?:(?!\1)[\s\S])*?)\1/g;

/** Matches any placeholder this pipeline emits — used to avoid re-redacting
 * (or over-collapsing) text a prior stage already replaced. */
const PLACEHOLDER_RE = /<(?:SECRET|STRING|NUM|REDACTED)(?::[^>]*)?>/;

export function containsPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value);
}

const URL_LIKE_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)/i;

/** Space-separated CSS/Tailwind-class-list shaped strings survive rule 2. */
export function isClassListLike(value: string): boolean {
  if (!value.includes(" ")) return false;
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const classToken = /^[A-Za-z0-9_\-:./[\]%#]+$/;
  return tokens.every((t) => t.length > 0 && t.length <= 40 && classToken.test(t));
}

/** Plain prose sentences survive rule 2. */
export function isProseLike(value: string): boolean {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const wordRe = /^[A-Za-z][A-Za-z'’-]*[.,!?;:]?$/;
  const matching = words.filter((w) => wordRe.test(w)).length;
  return matching / words.length >= 0.8;
}

/** URL/endpoint strings survive rule 2 — rule 1 already stripped embedded secrets. */
export function isUrlLike(value: string): boolean {
  return URL_LIKE_RE.test(value.trim());
}

/**
 * Base64/hex-looking blobs are ALWAYS treated as secrets regardless of
 * length (§10.2 stage 3 / task spec) — routed to `<SECRET:generic>`, not the
 * length-annotated `<STRING:len=N>` placeholder. Thresholds and the
 * upper/lower/digit-mix requirement are a deliberate judgment call to avoid
 * flagging long single-token camelCase identifiers that happen to fit the
 * base64 alphabet (documented in the PR).
 */
export function isBase64Like(value: string): boolean {
  if (/\s/.test(value) || value.length < 20) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return /\d/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value);
}

export function isHexBlobLike(value: string): boolean {
  if (/\s/.test(value) || value.length < 24 || value.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(value) && /\d/.test(value);
}

export function isEncodedBlobLike(value: string): boolean {
  return isBase64Like(value) || isHexBlobLike(value);
}
