/**
 * Effective-rule resolution (§7.5, §12.2): merge the 12 built-in rules with
 * the user's config — severity overrides, disable/enable lists, and custom
 * rules (glob+regex only; a custom rule reusing a built-in id replaces it).
 *
 * Provenance tracking powers `crosscheck rules` (§9.6):
 *   "built-in"   — shipped rule, possibly severity-overridden
 *   "config"     — user-defined custom rule
 *   "overridden" — custom rule that replaced a built-in id
 */
import type { CrossCheckConfig, RiskRule } from "../types.js";
import { BUILTIN_RULES } from "./builtin/index.js";
import type { EffectiveRule } from "./engine.js";

export function resolveRules(config: CrossCheckConfig): { rules: EffectiveRule[]; warnings: string[] } {
  const warnings: string[] = [];
  const rulesConfig = config.rules;

  const byId = new Map<string, EffectiveRule>();
  for (const rule of BUILTIN_RULES) {
    byId.set(rule.id, { ...rule, provenance: "built-in", enabled: rule.enabledByDefault });
  }

  // Custom rules first, so disable/enable/severityOverrides apply to the
  // final effective set and id existence is judged against it.
  for (const custom of rulesConfig.custom ?? []) {
    let rule: RiskRule = custom;
    if ((custom.when?.ast?.length ?? 0) > 0) {
      // Config schema rejects ast matchers on custom rules (§7.5) — guard
      // here too: strip them and warn rather than failing the run.
      warnings.push(
        `custom rule "${custom.id}" declares ast matchers — ast matchers are built-in only; stripping`,
      );
      const { ast: _stripped, ...whenWithoutAst } = custom.when;
      rule = { ...custom, when: whenWithoutAst };
    }
    const replaces = byId.has(rule.id);
    byId.set(rule.id, {
      ...rule,
      provenance: replaces ? "overridden" : "config",
      enabled: rule.enabledByDefault,
    });
  }

  for (const id of rulesConfig.disable ?? []) {
    const rule = byId.get(id);
    if (rule === undefined) {
      warnings.push(`unknown rule id "${id}" in rules.disable`);
      continue;
    }
    rule.enabled = false;
  }
  for (const id of rulesConfig.enable ?? []) {
    const rule = byId.get(id);
    if (rule === undefined) {
      warnings.push(`unknown rule id "${id}" in rules.enable`);
      continue;
    }
    rule.enabled = true;
  }
  for (const [id, severity] of Object.entries(rulesConfig.severityOverrides ?? {})) {
    const rule = byId.get(id);
    if (rule === undefined) {
      warnings.push(`unknown rule id "${id}" in rules.severityOverrides`);
      continue;
    }
    rule.severity = severity;
  }

  return { rules: [...byId.values()], warnings };
}
