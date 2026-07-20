import { describe, expect, it } from "vitest";
import { resolveRules } from "../../../src/rules/resolve.js";
import { BUILTIN_RULES } from "../../../src/rules/builtin/index.js";
import { config, customRule } from "./factories.js";

describe("resolveRules — defaults (§7.2)", () => {
  it("returns the 12 built-ins: 9 enabled by default, 3 opt-in, all provenance built-in", () => {
    const { rules, warnings } = resolveRules(config());
    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(12);
    expect(new Set(rules.map((r) => r.id))).toEqual(new Set(BUILTIN_RULES.map((r) => r.id)));
    expect(rules.every((r) => r.provenance === "built-in")).toBe(true);

    const enabled = rules.filter((r) => r.enabled).map((r) => r.id);
    const disabled = rules.filter((r) => !r.enabled).map((r) => r.id);
    expect(enabled).toHaveLength(9);
    expect(disabled.sort()).toEqual(
      ["crypto/insecure-random", "db/raw-sql-injection", "payments/amount-math"].sort(),
    );
  });

  it("does not mutate the BUILTIN_RULES constants", () => {
    resolveRules(config({ severityOverrides: { "db/destructive-migration": "low" } }));
    const original = BUILTIN_RULES.find((r) => r.id === "db/destructive-migration");
    expect(original!.severity).toBe("high");
  });
});

describe("resolveRules — severityOverrides / disable / enable (§12.2)", () => {
  it("applies severity overrides while keeping provenance built-in", () => {
    const { rules, warnings } = resolveRules(
      config({ severityOverrides: { "db/destructive-migration": "medium" } }),
    );
    expect(warnings).toEqual([]);
    const rule = rules.find((r) => r.id === "db/destructive-migration")!;
    expect(rule.severity).toBe("medium");
    expect(rule.provenance).toBe("built-in");
  });

  it("disable turns a rule off; enable turns an opt-in built-in on", () => {
    const { rules, warnings } = resolveRules(
      config({ disable: ["crypto/weak-hash"], enable: ["payments/amount-math", "db/raw-sql-injection", "crypto/insecure-random"] }),
    );
    expect(warnings).toEqual([]);
    expect(rules.find((r) => r.id === "crypto/weak-hash")!.enabled).toBe(false);
    expect(rules.find((r) => r.id === "payments/amount-math")!.enabled).toBe(true);
    expect(rules.find((r) => r.id === "db/raw-sql-injection")!.enabled).toBe(true);
    expect(rules.find((r) => r.id === "crypto/insecure-random")!.enabled).toBe(true);
    expect(rules.filter((r) => r.enabled)).toHaveLength(11);
  });

  it("unknown ids produce warnings and change nothing", () => {
    const { rules, warnings } = resolveRules(
      config({
        disable: ["nope/not-a-rule"],
        enable: ["ghost/rule"],
        severityOverrides: { "missing/rule": "low" },
      }),
    );
    expect(warnings).toEqual([
      'unknown rule id "nope/not-a-rule" in rules.disable',
      'unknown rule id "ghost/rule" in rules.enable',
      'unknown rule id "missing/rule" in rules.severityOverrides',
    ]);
    expect(rules.filter((r) => r.enabled)).toHaveLength(9);
  });
});

describe("resolveRules — custom rules (§7.5)", () => {
  it("appends custom rules with provenance config and their own enabledByDefault", () => {
    const custom = customRule({
      id: "client/no-console-in-prod",
      enabledByDefault: false,
      when: { fileGlobs: ["src/**/*.{ts,tsx}"], addedLines: ["\\bconsole\\.(log|debug|warn)\\s*\\("] },
    });
    const { rules, warnings } = resolveRules(config({ custom: [custom] }));
    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(13);
    const resolved = rules.find((r) => r.id === "client/no-console-in-prod")!;
    expect(resolved.provenance).toBe("config");
    expect(resolved.enabled).toBe(false);
  });

  it("a custom rule reusing a built-in id REPLACES it (provenance overridden)", () => {
    const replacement = customRule({
      id: "db/destructive-migration",
      severity: "medium",
      enabledByDefault: true,
      when: { fileGlobs: ["**/migrations/**"], addedLines: ["DROP TABLE"] },
      then: { message: "team-specific message", checklist: ["team-specific step"], manualTests: [] },
    });
    const { rules, warnings } = resolveRules(config({ custom: [replacement] }));
    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(12); // replaced, not appended
    const resolved = rules.find((r) => r.id === "db/destructive-migration")!;
    expect(resolved.provenance).toBe("overridden");
    expect(resolved.severity).toBe("medium");
    expect(resolved.then.checklist).toEqual(["team-specific step"]);
    expect(resolved.when.addedLines).toEqual(["DROP TABLE"]);
  });

  it("disable/enable still apply to an overridden built-in id", () => {
    const replacement = customRule({ id: "db/destructive-migration", enabledByDefault: true });
    const { rules } = resolveRules(
      config({ custom: [replacement], disable: ["db/destructive-migration"] }),
    );
    const resolved = rules.find((r) => r.id === "db/destructive-migration")!;
    expect(resolved.provenance).toBe("overridden");
    expect(resolved.enabled).toBe(false);
  });

  it("custom rules never carry ast matchers — stripped with a warning (§5.5)", () => {
    const sneaky = customRule({
      id: "client/sneaky",
      when: {
        addedLines: ["danger"],
        ast: [{ kind: "CallExpression", callee: "danger" }],
      },
    });
    const { rules, warnings } = resolveRules(config({ custom: [sneaky] }));
    expect(warnings).toEqual([
      'custom rule "client/sneaky" declares ast matchers — ast matchers are built-in only; stripping',
    ]);
    const resolved = rules.find((r) => r.id === "client/sneaky")!;
    expect(resolved.when.ast).toBeUndefined();
    expect(resolved.when.addedLines).toEqual(["danger"]);
  });
});
