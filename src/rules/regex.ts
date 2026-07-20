/**
 * Regex compilation shared by the rule engine and the AST matchers (§13.2
 * regex hygiene: every pattern is compiled exactly once, at engine init).
 */

/**
 * Compile a rule pattern source to a RegExp.
 *
 * Rule JSON is authored PCRE-style (§7.4), where a leading `(?i)` makes the
 * whole pattern case-insensitive. JavaScript RegExp has no inline global-flag
 * syntax (the ES2025 modifier form is group-scoped `(?i:...)`), so a leading
 * `(?i)` is translated to the `i` flag here. The pattern text in the rule
 * definitions stays verbatim from the PRD.
 */
export function compileRegex(source: string): RegExp {
  let flags = "";
  let body = source;
  if (body.startsWith("(?i)")) {
    flags = "i";
    body = body.slice(4);
  }
  return new RegExp(body, flags);
}

/** Trim and cap evidence text so findings stay one-line printable. */
export function clipEvidence(text: string, max = 240): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
