import { describe, expect, it } from "vitest";
import { sanitizeJsonc } from "../../../src/config/jsonc.js";
import { parseConfig, riskRuleSchema } from "../../../src/config/schema.js";

const SRC = "test-config.json";

function validCustomRule(): Record<string, unknown> {
  return {
    id: "client/no-console-in-prod",
    name: "console.log left in src",
    category: "custom",
    severity: "low",
    enabledByDefault: true,
    description: "Agent scaffolding leaves debug logs behind.",
    when: {
      fileGlobs: ["src/**/*.{ts,tsx}"],
      addedLines: ["\\bconsole\\.(log|debug|warn)\\s*\\("],
    },
    then: {
      message: "console.* added in source",
      checklist: ["Remove or gate debug logging before pushing"],
      manualTests: [],
    },
  };
}

describe("parseConfig — acceptance", () => {
  it("accepts a full valid §12.2-style config (with comments and trailing commas)", () => {
    const text = `// crosscheck.config.json
{
  "$schema": "https://raw.githubusercontent.com/<org>/crosscheck/main/schema/crosscheck.config.schema.json",
  "version": 1,
  "rules": {
    "disable": ["crypto/weak-hash"],
    "enable": [],
    "dependencySignals": true,
    "severityOverrides": { "db/destructive-migration": "medium" },
    "custom": [${JSON.stringify(validCustomRule(), null, 2)}],
  },
  "ignore": ["fixtures/**", "**/*.generated.ts"],
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "maxTokensPerReview": 48000,
    "maxTokensPerCluster": 6000,
    "maxCostUsdPerReview": 0.25,
    "temperature": 0.2,
    "timeoutMs": 30000,
    "anonymizePaths": false,
    "consentGiven": {}
  },
  "strict": { "failOn": "high" },
  "output": { "format": "terminal", "color": true, "maxTests": 12, "maxClusters": 8 },
  "history": { "enabled": true, "dbPath": ".git/crosscheck/history.db" }
}`;
    const result = parseConfig(JSON.parse(sanitizeJsonc(text)), SRC);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
      expect(result.config.version).toBe(1);
      expect(result.config.rules?.severityOverrides).toEqual({ "db/destructive-migration": "medium" });
      expect(result.config.rules?.custom).toHaveLength(1);
      expect(result.config.llm?.provider).toBe("anthropic");
    }
  });

  it("accepts an empty object (defaults fill everything in)", () => {
    const result = parseConfig({}, SRC);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("accepts custom rules with requireAll / notAddedWith / verifyInFile / dependencySignals (§7.5)", () => {
    const rule = validCustomRule();
    (rule.when as Record<string, unknown>).requireAll = true;
    (rule.when as Record<string, unknown>).notAddedWith = ["\\bnoConsole\\b"];
    (rule.when as Record<string, unknown>).verifyInFile = true;
    rule.dependencySignals = { helmet: { downgradeTo: "low", note: "helmet installed" } };
    const result = parseConfig({ rules: { custom: [rule] } }, SRC);
    expect(result.ok).toBe(true);
  });
});

describe("parseConfig — rejection", () => {
  it("rejects an invalid provider with a pointer", () => {
    const result = parseConfig({ llm: { provider: "gemini" } }, SRC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(`${SRC}: llm.provider: invalid value "gemini"`);
    }
  });

  it("rejects wrong-typed values in §5.8 pointer style", () => {
    const result = parseConfig({ llm: { maxTokensPerReview: "lots" } }, SRC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe(`${SRC}: llm.maxTokensPerReview: expected number, got string`);
    }
  });

  it("rejects when.ast on custom rules with a precise message (§7.5)", () => {
    const rule = validCustomRule();
    (rule.when as Record<string, unknown>).ast = [{ kind: "CallExpression", callee: "crypto.createHash" }];
    const result = parseConfig({ rules: { custom: [rule] } }, SRC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe(
        `${SRC}: rules.custom[0].when.ast: AST matchers are built-in-rule only in MVP (§7.5)`,
      );
    }
  });

  it("rejects an unparseable regex and names the pattern", () => {
    const rule = validCustomRule();
    (rule.when as Record<string, unknown>).addedLines = ["valid", "(["];
    const result = parseConfig({ rules: { custom: [rule] } }, SRC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain(`${SRC}: rules.custom[0].when.addedLines[1]: invalid regular expression "(["`);
    }
  });

  it("rejects unsupported config versions with a clear error", () => {
    const result = parseConfig({ version: 2 }, SRC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain(`${SRC}: version: unsupported config version 2`);
      expect(result.errors[0]).toContain('"version": 1');
    }
  });

  it("rejects invalid severity values", () => {
    const result = parseConfig({ strict: { failOn: "critical" } }, SRC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain(`${SRC}: strict.failOn`);
  });
});

describe("riskRuleSchema", () => {
  it("validates a well-formed custom rule", () => {
    expect(riskRuleSchema.safeParse(validCustomRule()).success).toBe(true);
  });

  it("requires the mandatory fields", () => {
    const rule = validCustomRule();
    delete rule.id;
    expect(riskRuleSchema.safeParse(rule).success).toBe(false);
  });
});

describe("unknown-key warnings (§12.1)", () => {
  it("warns with a did-you-mean suggestion for near-miss keys", () => {
    const result = parseConfig({ llm: { maxToken: 48000 } }, SRC);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([
        'unknown config key "llm.maxToken" — did you mean "llm.maxTokensPerReview"?',
      ]);
    }
  });

  it("warns without a suggestion for unrelated keys", () => {
    const result = parseConfig({ zzz: true }, SRC);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual(['unknown config key "zzz"']);
    }
  });

  it("never warns about $schema", () => {
    const result = parseConfig({ $schema: "https://example.com/schema.json" }, SRC);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("warns for unknown keys inside custom rules", () => {
    const rule = validCustomRule();
    rule.whern = {};
    const result = parseConfig({ rules: { custom: [rule] } }, SRC);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual(['unknown config key "rules.custom[0].whern" — did you mean "rules.custom[0].when"?']);
    }
  });

  it("does not descend into open records (severityOverrides, consentGiven)", () => {
    const result = parseConfig(
      { rules: { severityOverrides: { "anything/goes": "low" } }, llm: { consentGiven: { anthropic: true } } },
      SRC,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });
});
