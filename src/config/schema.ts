/**
 * Zod validation for `crosscheck.config.json` (§5.8, §12.1) and custom rule
 * definitions (§7.5).
 *
 * - Invalid values are fatal: `parseConfig` returns errors with precise
 *   pointers (`llm.maxTokensPerReview: expected number, got string`),
 *   prefixed with the source file path.
 * - Unknown keys never fail (forward compatibility); they produce did-you-
 *   mean warnings instead. `$schema` is always allowed, never warned.
 */

import { z } from "zod";
import type { CrossCheckConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Shared atoms
// ---------------------------------------------------------------------------

export const severitySchema = z.enum(["high", "medium", "low"]);
export const llmProviderSchema = z.enum(["anthropic", "openai", "openrouter"]);
export const outputFormatSchema = z.enum(["terminal", "markdown", "json"]);

/** A string that must compile as a JS regular expression (§7.5). */
const regexSource = z.string().superRefine((value, ctx) => {
  try {
    new RegExp(value);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invalid regular expression ${JSON.stringify(value)}: ${(err as Error).message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// Rules (§7.1, §7.5)
// ---------------------------------------------------------------------------

const astMatcherSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CallExpression"),
    callee: z.string(),
    argsRegex: z.array(regexSource).optional(),
  }),
  z.object({ kind: z.literal("NewExpression"), callee: z.string() }),
  z.object({
    kind: z.literal("StringAssignment"),
    nameRegex: regexSource,
    valueRegex: regexSource,
  }),
  z.object({ kind: z.literal("ImportFrom"), moduleRegex: regexSource }),
]);

const dependencySignalSchema = z.object({
  downgradeTo: severitySchema.optional(),
  note: z.string().optional(),
  swapRemediation: z.string().optional(),
});

/**
 * Validates a `RiskRule` as written in `rules.custom`. Custom rules are
 * glob+regex only in MVP — but `requireAll` / `notAddedWith` /
 * `verifyInFile` / `dependencySignals` ARE allowed (§7.5). Declaring
 * `when.ast` is rejected: AST matchers are built-in-rule only.
 */
export const riskRuleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.string().min(1),
    severity: severitySchema,
    enabledByDefault: z.boolean(),
    archetype: z.enum(["A1", "A2", "A3", "A4"]).optional(),
    description: z.string(),
    when: z.object({
      fileGlobs: z.array(z.string()).optional(),
      addedLines: z.array(regexSource).optional(),
      removedLines: z.array(regexSource).optional(),
      ast: z.array(astMatcherSchema).optional(),
      requireAll: z.boolean().optional(),
      notAddedWith: z.array(regexSource).optional(),
      verifyInFile: z.boolean().optional(),
    }),
    dependencySignals: z.record(z.string(), dependencySignalSchema).optional(),
    then: z.object({
      message: z.string().min(1),
      checklist: z.array(z.string()),
      manualTests: z.array(z.string()).optional(),
      references: z.array(z.string()).optional(),
    }),
  })
  .superRefine((rule, ctx) => {
    if (rule.when.ast !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["when", "ast"],
        message: "AST matchers are built-in-rule only in MVP (§7.5)",
      });
    }
  });

// ---------------------------------------------------------------------------
// Full config (§12.2) — everything optional at input; defaults fill in
// ---------------------------------------------------------------------------

export const configSchema = z.object({
  version: z
    .literal(1, {
      errorMap: (issue) => ({
        message:
          issue.code === z.ZodIssueCode.invalid_literal
            ? `unsupported config version ${JSON.stringify(issue.received)} — this version of crosscheck supports "version": 1`
            : (issue.message ?? "invalid version"),
      }),
    })
    .optional(),
  rules: z
    .object({
      disable: z.array(z.string()).optional(),
      enable: z.array(z.string()).optional(),
      dependencySignals: z.boolean().optional(),
      severityOverrides: z.record(z.string(), severitySchema).optional(),
      custom: z.array(riskRuleSchema).optional(),
    })
    .optional(),
  ignore: z.array(z.string()).optional(),
  llm: z
    .object({
      provider: llmProviderSchema.nullable().optional(),
      model: z.string().nullable().optional(),
      apiKeyEnv: z.string().nullable().optional(),
      maxTokensPerReview: z.number().optional(),
      maxTokensPerCluster: z.number().optional(),
      maxCostUsdPerReview: z.number().optional(),
      temperature: z.number().optional(),
      timeoutMs: z.number().optional(),
      anonymizePaths: z.boolean().optional(),
      consentGiven: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
  strict: z
    .object({
      failOn: severitySchema.optional(),
    })
    .optional(),
  output: z
    .object({
      format: outputFormatSchema.optional(),
      color: z.boolean().optional(),
      maxTests: z.number().optional(),
      maxClusters: z.number().optional(),
    })
    .optional(),
  history: z
    .object({
      enabled: z.boolean().optional(),
      dbPath: z.string().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Issue formatting (§5.8 pointers)
// ---------------------------------------------------------------------------

function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return "(root)";
  let out = "";
  for (const seg of path) {
    out += typeof seg === "number" ? `[${seg}]` : out === "" ? seg : `.${seg}`;
  }
  return out;
}

function formatIssue(issue: z.ZodIssue): string {
  const path = formatPath(issue.path);
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return `${path}: expected ${issue.expected}, got ${issue.received}`;
    case z.ZodIssueCode.invalid_enum_value:
      return `${path}: invalid value ${JSON.stringify(issue.received)} — expected ${issue.options
        .map((o) => JSON.stringify(o))
        .join(" | ")}`;
    default:
      return `${path}: ${issue.message}`;
  }
}

// ---------------------------------------------------------------------------
// Unknown-key detection with did-you-mean suggestions (§12.1)
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = ["version", "rules", "ignore", "llm", "strict", "output", "history"];
const SECTION_KEYS: Record<string, string[]> = {
  rules: ["disable", "enable", "dependencySignals", "severityOverrides", "custom"],
  llm: [
    "provider",
    "model",
    "apiKeyEnv",
    "maxTokensPerReview",
    "maxTokensPerCluster",
    "maxCostUsdPerReview",
    "temperature",
    "timeoutMs",
    "anonymizePaths",
    "consentGiven",
  ],
  strict: ["failOn"],
  output: ["format", "color", "maxTests", "maxClusters"],
  history: ["enabled", "dbPath"],
};
const RULE_KEYS = [
  "id",
  "name",
  "category",
  "severity",
  "enabledByDefault",
  "archetype",
  "description",
  "when",
  "dependencySignals",
  "then",
];
// `ast` is a *known* key here — it is rejected by riskRuleSchema as fatal,
// not warned about as unknown.
const RULE_WHEN_KEYS = ["fileGlobs", "addedLines", "removedLines", "ast", "requireAll", "notAddedWith", "verifyInFile"];
const RULE_THEN_KEYS = ["message", "checklist", "manualTests", "references"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function levenshtein(a: string, b: string): number {
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j += 1) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n]!;
}

/**
 * Best did-you-mean candidate among `known` for `key`, or null. Levenshtein
 * distance ≤ 3 qualifies; a pure prefix relationship (e.g. `maxToken` vs
 * `maxTokensPerReview`) counts as distance 2. The distance must also be
 * smaller than the shorter of the two strings, so that a total rewrite of a
 * short key (e.g. `zzz` → `llm`) never earns a suggestion.
 */
function suggestKey(key: string, known: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    let distance = levenshtein(key, candidate);
    if (candidate.startsWith(key) || key.startsWith(candidate)) {
      distance = Math.min(distance, 2);
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== null && bestDistance <= 3 && bestDistance < Math.min(key.length, best.length) ? best : null;
}

function checkKeys(obj: Record<string, unknown>, path: string, known: string[], warnings: string[]): void {
  for (const key of Object.keys(obj)) {
    if (path === "" && key === "$schema") continue; // always allowed, never warned
    if (known.includes(key)) continue;
    const fullPath = path === "" ? key : `${path}.${key}`;
    const suggestion = suggestKey(key, known);
    warnings.push(
      suggestion === null
        ? `unknown config key "${fullPath}"`
        : `unknown config key "${fullPath}" — did you mean "${path === "" ? suggestion : `${path}.${suggestion}`}"?`,
    );
  }
}

/**
 * Walks `raw` against the known key tree and returns one warning per unknown
 * key. Open records (`rules.severityOverrides`, `llm.consentGiven`,
 * `dependencySignals`) have arbitrary keys and are never descended into.
 */
export function collectUnknownKeyWarnings(raw: unknown): string[] {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return warnings;

  checkKeys(raw, "", TOP_LEVEL_KEYS, warnings);
  for (const [section, keys] of Object.entries(SECTION_KEYS)) {
    const value = raw[section];
    if (isPlainObject(value)) checkKeys(value, section, keys, warnings);
  }

  const rules = raw.rules;
  if (isPlainObject(rules) && Array.isArray(rules.custom)) {
    rules.custom.forEach((item, index) => {
      if (!isPlainObject(item)) return;
      const base = `rules.custom[${index}]`;
      checkKeys(item, base, RULE_KEYS, warnings);
      if (isPlainObject(item.when)) checkKeys(item.when, `${base}.when`, RULE_WHEN_KEYS, warnings);
      if (isPlainObject(item.then)) checkKeys(item.then, `${base}.then`, RULE_THEN_KEYS, warnings);
    });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// parseConfig (§12.1)
// ---------------------------------------------------------------------------

export type ParseConfigResult =
  | { ok: true; config: Partial<CrossCheckConfig>; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Validates one config layer. On success returns the parsed partial (defaults
 * are applied later, by merging over DEFAULT_CONFIG) plus unknown-key
 * warnings. On failure returns fatal errors formatted as
 * `<source>: <pointer>: <message>`.
 */
export function parseConfig(raw: unknown, source: string): ParseConfigResult {
  const warnings = collectUnknownKeyWarnings(raw);
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((issue) => `${source}: ${formatIssue(issue)}`) };
  }
  return { ok: true, config: result.data as Partial<CrossCheckConfig>, warnings };
}
