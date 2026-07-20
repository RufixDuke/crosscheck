import { describe, expect, it } from "vitest";
import { evaluateRules, type EffectiveRule } from "../../../src/rules/engine.js";
import { loadAstProject } from "../../../src/ast/project.js";
import type { AstMatcher, RiskRule } from "../../../src/types.js";
import { add, cluster, context, customRule, del, effective, file, hunk } from "./factories.js";
import {
  BROKEN_TS,
  SESSION_SERVICE_HEAD,
  SESSION_SERVICE_REWRITTEN,
  WEAK_HASH_MD5,
} from "../../fixtures/rules/snippets.js";

function asEffective(...rules: RiskRule[]): EffectiveRule[] {
  return rules.map((rule) => effective(rule));
}

describe("evaluateRules — regex triggers & glob gate (§7.1 steps 1–2)", () => {
  it("fires on added lines with file/line/evidence/hunkHash", async () => {
    const rule = customRule({
      id: "t/added",
      severity: "high",
      when: { addedLines: ["danger\\(\\)"] },
    });
    const f = file("src/a.ts", [hunk("src/a.ts", [add("const x = danger();", 10)])]);
    const c = cluster([f]);
    const result = await evaluateRules({ clusters: [c], rules: asEffective(rule), context: context() });
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.ruleId).toBe("t/added");
    expect(finding.file).toBe("src/a.ts");
    expect(finding.line).toBe(10);
    expect(finding.evidence).toBe("const x = danger();");
    expect(finding.hunkHash).toBe(f.hunks[0]!.hash);
    expect(finding.severity).toBe("high");
    expect(finding.baseSeverity).toBe("high");
  });

  it("removedLines fire only on del lines, addedLines only on add lines", async () => {
    const rule = customRule({
      id: "t/removed",
      when: { removedLines: ["\\b(requireAuth|authorize|checkPermission)\\b"] },
    });
    const addedOnly = file("src/a.ts", [hunk("src/a.ts", [add("router.use(requireAuth);", 3)])]);
    const removedLine = file("src/b.ts", [hunk("src/b.ts", [del("router.use(requireAuth);", 7)])]);

    const none = await evaluateRules({
      clusters: [cluster([addedOnly])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(none.findings).toHaveLength(0);

    const some = await evaluateRules({
      clusters: [cluster([removedLine])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(some.findings).toHaveLength(1);
    expect(some.findings[0]!.line).toBe(7);
  });

  it("glob gate: rule is skipped when no file in the cluster matches (ANY-match)", async () => {
    const rule = customRule({
      id: "t/glob",
      when: { fileGlobs: ["**/auth/**"], addedLines: ["danger"] },
    });
    const noMatch = file("src/components/btn.ts", [hunk("src/components/btn.ts", [add("danger();", 1)])]);
    const match = file("src/auth/login.ts", [hunk("src/auth/login.ts", [add("danger();", 2)])]);

    const gated = await evaluateRules({
      clusters: [cluster([noMatch])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(gated.findings).toHaveLength(0);

    const fired = await evaluateRules({
      clusters: [cluster([match])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(fired.findings).toHaveLength(1);
    expect(fired.findings[0]!.file).toBe("src/auth/login.ts");
  });

  it("disabled rules are never evaluated", async () => {
    const rule = customRule({ id: "t/off", when: { addedLines: ["danger"] } });
    const f = file("src/a.ts", [hunk("src/a.ts", [add("danger();", 1)])]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: [effective(rule, { enabled: false })],
      context: context(),
    });
    expect(result.findings).toHaveLength(0);
  });
});

describe("evaluateRules — requireAll (§7.1 step 4)", () => {
  const rule = customRule({
    id: "t/compound",
    when: {
      addedLines: ["router\\.(get|post)\\("],
      removedLines: ["requireAuth"],
      requireAll: true,
    },
  });

  it("fires only when EVERY declared trigger kind fires", async () => {
    const both = file("src/routes/a.ts", [
      hunk("src/routes/a.ts", [del("  requireAuth,", 4), add('  router.get("/admin", handler);', 4)]),
    ]);
    const result = await evaluateRules({
      clusters: [cluster([both])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("does not fire when only one trigger kind fires", async () => {
    const addedOnly = file("src/routes/a.ts", [hunk("src/routes/a.ts", [add('  router.get("/admin", handler);', 4)])]);
    const removedOnly = file("src/routes/b.ts", [hunk("src/routes/b.ts", [del("  requireAuth,", 4)])]);

    for (const f of [addedOnly, removedOnly]) {
      const result = await evaluateRules({
        clusters: [cluster([f])],
        rules: asEffective(rule),
        context: context(),
      });
      expect(result.findings).toHaveLength(0);
    }
  });

  it("without requireAll (default), ANY trigger firing is enough", async () => {
    const anyRule = customRule({
      id: "t/any",
      when: { addedLines: ["router\\.(get|post)\\("], removedLines: ["requireAuth"] },
    });
    const f = file("src/routes/a.ts", [hunk("src/routes/a.ts", [add('  router.get("/x", handler);', 4)])]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(anyRule),
      context: context(),
    });
    expect(result.findings).toHaveLength(1);
  });
});

describe("evaluateRules — notAddedWith veto (§7.1 step 5, §7.8)", () => {
  const rule = customRule({
    id: "t/guarded",
    severity: "high",
    when: {
      fileGlobs: ["**/routes/**"],
      addedLines: ["\\bpost\\s*\\(\\s*[\"'][^\"']*webhook"],
      notAddedWith: ["\\b(createHmac|verifySignature)\\b"],
    },
  });

  it("vetoes the finding when the guard appears anywhere in the cluster's added lines", async () => {
    const f = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [
        add('  router.post("/webhooks/paystack", handler);', 5),
        add("  const hmac = createHmac('sha512', secret);", 6),
      ]),
    ]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.infoFindings).toHaveLength(0);
  });

  it("fires when no guard is added and verifyInFile is off", async () => {
    const f = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [add('  router.post("/webhooks/paystack", handler);', 5)]),
    ]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(result.findings).toHaveLength(1);
  });
});

describe("evaluateRules — verifyInFile (§7.1 step 6, §7.9)", () => {
  const rule = customRule({
    id: "t/verify",
    severity: "high",
    when: {
      fileGlobs: ["**/routes/**"],
      addedLines: ["\\bpost\\s*\\(\\s*[\"'][^\"']*webhook"],
      notAddedWith: ["\\b(createHmac|verifySignature)\\b"],
      verifyInFile: true,
    },
  });
  const triggerFile = () =>
    file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [add('  router.post("/webhooks/paystack", handler);', 5)]),
    ]);

  it("downgrades to an info finding when the guard exists elsewhere in the HEAD file", async () => {
    const head = [
      "import express from 'express';",
      "",
      "export function verify(raw: Buffer, sig: string) {",
      "  const hmac = createHmac('sha512', secret);",
      "  return hmac.update(raw).digest('hex') === sig;",
      "}",
    ].join("\n");
    const c = cluster([triggerFile()]);
    const result = await evaluateRules({
      clusters: [c],
      rules: asEffective(rule),
      context: context({ readFileAtHead: async () => head }),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.infoFindings).toHaveLength(1);
    const info = result.infoFindings[0]!;
    expect(info.info).toBe(true);
    expect(info.infoReason).toBe("guard found at line 4 — downgraded to info");
    // Info findings never enter the severity rollup.
    expect(c.severity).toBe("low");
  });

  it("keeps full severity when the guard is absent from the file", async () => {
    const c = cluster([triggerFile()]);
    const result = await evaluateRules({
      clusters: [c],
      rules: asEffective(rule),
      context: context({ readFileAtHead: async () => "import express from 'express';\n" }),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("high");
    expect(result.infoFindings).toHaveLength(0);
    expect(c.severity).toBe("high");
  });

  it("keeps the finding and adds a note when the read FAILS (null)", async () => {
    const result = await evaluateRules({
      clusters: [cluster([triggerFile()])],
      rules: asEffective(rule),
      context: context({ readFileAtHead: async () => null }),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("high");
    expect(result.findings[0]!.note).toBe("guard verification read failed");
  });

  it("reads the WORKING file for new/untracked files", async () => {
    const newFile = file(
      "src/routes/webhooks.ts",
      [hunk("src/routes/webhooks.ts", [add('  router.post("/webhooks/paystack", handler);', 5)])],
      { isNew: true },
    );
    const calls: string[] = [];
    const result = await evaluateRules({
      clusters: [cluster([newFile])],
      rules: asEffective(rule),
      context: context({
        readFileAtHead: async () => {
          throw new Error("must not be called for new files");
        },
        readWorkingFile: async (path: string) => {
          calls.push(path);
          return "const g = verifySignature(a, b);\n";
        },
      }),
    });
    expect(calls).toEqual(["src/routes/webhooks.ts"]);
    expect(result.findings).toHaveLength(0);
    expect(result.infoFindings).toHaveLength(1);
    expect(result.infoFindings[0]!.infoReason).toBe("guard found at line 1 — downgraded to info");
  });

  it("reads the file at most once per candidate finding set (cached per file)", async () => {
    let reads = 0;
    const twoTriggers = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [
        add('  router.post("/webhooks/paystack", handler);', 5),
        add('  router.post("/webhooks/stripe", handler);', 6),
      ]),
    ]);
    await evaluateRules({
      clusters: [cluster([twoTriggers])],
      rules: asEffective(rule),
      context: context({
        readFileAtHead: async () => {
          reads += 1;
          return "no guards here\n";
        },
      }),
    });
    expect(reads).toBe(1);
  });
});

describe("evaluateRules — dependencySignals (§7.1 step 7, §7.10)", () => {
  const rule = customRule({
    id: "t/deps",
    severity: "high",
    when: { addedLines: ["dangerousCall\\("] },
    dependencySignals: {
      "safe-lib": {
        downgradeTo: "low",
        note: "safe-lib is installed — verify its config covers this path",
        swapRemediation: "Use safe-lib's built-in guard instead of hand-rolling",
      },
    },
    then: { message: "dangerous", checklist: ["original lead item", "second item"], manualTests: [] },
  });
  const triggerFile = () => file("src/a.ts", [hunk("src/a.ts", [add("dangerousCall();", 3)])]);

  it("downgrades severity, appends the note, and swaps the lead remediation when the dep is present", async () => {
    const result = await evaluateRules({
      clusters: [cluster([triggerFile()])],
      rules: asEffective(rule),
      context: context({ dependencies: new Set(["safe-lib", "express"]) }),
    });
    const finding = result.findings[0]!;
    expect(finding.severity).toBe("low");
    expect(finding.baseSeverity).toBe("high");
    expect(finding.note).toContain("safe-lib is installed");
    expect(finding.checklist[0]).toBe("Use safe-lib's built-in guard instead of hand-rolling");
    expect(finding.checklist[1]).toBe("second item");
  });

  it("leaves the finding untouched when the dep is absent from package.json", async () => {
    const result = await evaluateRules({
      clusters: [cluster([triggerFile()])],
      rules: asEffective(rule),
      context: context({ dependencies: new Set(["express"]) }),
    });
    const finding = result.findings[0]!;
    expect(finding.severity).toBe("high");
    expect(finding.note).toBeUndefined();
    expect(finding.checklist[0]).toBe("original lead item");
  });

  it("leaves the finding untouched when package.json is unreadable (dependencies null)", async () => {
    const result = await evaluateRules({
      clusters: [cluster([triggerFile()])],
      rules: asEffective(rule),
      context: context({ dependencies: null }),
    });
    expect(result.findings[0]!.severity).toBe("high");
    expect(result.findings[0]!.note).toBeUndefined();
  });

  it("leaves the finding untouched when signals are disabled by config", async () => {
    const result = await evaluateRules({
      clusters: [cluster([triggerFile()])],
      rules: asEffective(rule),
      context: context({ dependencies: new Set(["safe-lib"]), dependencySignalsEnabled: false }),
    });
    expect(result.findings[0]!.severity).toBe("high");
  });

  it("downgradeTo only ever LOWERS severity", async () => {
    const raising = customRule({
      id: "t/raise",
      severity: "medium",
      when: { addedLines: ["dangerousCall\\("] },
      dependencySignals: { "safe-lib": { downgradeTo: "high" } },
    });
    const result = await evaluateRules({
      clusters: [cluster([triggerFile()])],
      rules: asEffective(raising),
      context: context({ dependencies: new Set(["safe-lib"]) }),
    });
    expect(result.findings[0]!.severity).toBe("medium");
  });
});

describe("evaluateRules — dedup (§7.1 step 8)", () => {
  it("deduplicates findings by (ruleId, file, line)", async () => {
    const rule = customRule({
      id: "t/dup",
      when: { addedLines: ["danger", "dan.*ger"] }, // two patterns, same line
    });
    const f = file("src/a.ts", [hunk("src/a.ts", [add("danger();", 3), add("danger();", 4)])]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(rule),
      context: context(),
    });
    // Two distinct lines survive; the same-line double-match collapses.
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((x) => x.line).sort()).toEqual([3, 4]);
  });
});

describe("evaluateRules — cluster severity & ordering (§7.1 step 9)", () => {
  it("severity = max of ACTIVE findings; clusters re-sorted and re-id'd c1..cn", async () => {
    const mediumRule = customRule({ id: "t/medium", severity: "medium", when: { addedLines: ["mediumRisk"] } });
    const highRule = customRule({ id: "t/high", severity: "high", when: { addedLines: ["highRisk"] } });

    const big = file("src/big.ts", [
      hunk("src/big.ts", [add("mediumRisk();", 1), add("const a = 1;", 2), add("const b = 2;", 3)]),
    ]);
    const mediumCluster = cluster([big], { id: "orig-a" });

    const small = file("src/small.ts", [hunk("src/small.ts", [add("highRisk();", 1)])]);
    const highCluster = cluster([small], { id: "orig-b" });

    const quiet = file("src/quiet.ts", [hunk("src/quiet.ts", [add("const z = 0;", 1), add("const y = 1;", 2), add("const x = 2;", 3), add("const w = 3;", 4)])]);
    const quietCluster = cluster([quiet], { id: "orig-c" });

    const clusters = [mediumCluster, highCluster, quietCluster];
    const result = await evaluateRules({
      clusters,
      rules: asEffective(mediumRule, highRule),
      context: context(),
    });

    expect(clusters.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(clusters[0]).toBe(highCluster);
    expect(clusters[0]!.severity).toBe("high");
    expect(clusters[1]).toBe(mediumCluster);
    expect(clusters[1]!.severity).toBe("medium");
    // No findings → "low", sorted last even though it is the biggest.
    expect(clusters[2]).toBe(quietCluster);
    expect(clusters[2]!.severity).toBe("low");
    expect(result.findings).toHaveLength(2);
  });

  it("breaks severity ties by cluster size (added+removed) desc", async () => {
    const rule = customRule({ id: "t/m", severity: "medium", when: { addedLines: ["risk"] } });
    const small = cluster([file("src/s.ts", [hunk("src/s.ts", [add("risk();", 1)])])]);
    const large = cluster([
      file("src/l.ts", [hunk("src/l.ts", [add("risk();", 1), add("risk2();", 2), add("risk3();", 3)])]),
    ]);
    const clusters = [small, large];
    await evaluateRules({ clusters, rules: asEffective(rule), context: context() });
    expect(clusters[0]).toBe(large);
    expect(clusters[1]).toBe(small);
    expect(clusters.map((c) => c.severity)).toEqual(["medium", "medium"]);
  });
});

describe("evaluateRules — AST matchers (§7.1 step 3)", () => {
  const weakHash = customRule({
    id: "crypto/weak-hash",
    severity: "high",
    when: { ast: [{ kind: "CallExpression", callee: "crypto\\.createHash", argsRegex: ["md5", "sha1"] }] },
  });

  it("fires an added-code AST matcher via the current project", async () => {
    const ast = await loadAstProject([{ path: "src/tokens.ts", content: WEAK_HASH_MD5 }]);
    const f = file("src/tokens.ts", [
      hunk("src/tokens.ts", [add('  return crypto.createHash("md5").update(token).digest("hex");', 4)]),
    ]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(weakHash),
      context: context(),
      ast,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.line).toBe(4);
    expect(result.findings[0]!.evidence).toContain("createHash");
  });

  it("fires a removed-code AST matcher via oldFileAst (HEAD contents)", async () => {
    const sessionRewrite = customRule({
      id: "auth/session-rewrite",
      severity: "high",
      when: {
        ast: [
          { kind: "CallExpression", callee: "compareSync|bcrypt\\.compare", target: "removed" } as AstMatcher,
        ],
      },
    });
    const ast = await loadAstProject([{ path: "src/session.ts", content: SESSION_SERVICE_REWRITTEN }]);
    const oldFileAst = await loadAstProject([{ path: "src/session.ts", content: SESSION_SERVICE_HEAD }]);
    const f = file("src/session.ts", [
      hunk(
        "src/session.ts",
        [
          del("  return bcrypt.compareSync(password, hash);", 5),
          add("  return hashPassword(password) === hash;", 5),
        ],
        { oldStart: 3, newStart: 3 },
      ),
    ]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(sessionRewrite),
      context: context(),
      ast,
      oldFileAst,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.ruleId).toBe("auth/session-rewrite");
    expect(result.findings[0]!.line).toBe(5);
    expect(result.findings[0]!.evidence).toContain("compareSync");
  });

  it("skips removed-code matchers gracefully when oldFileAst is null", async () => {
    const sessionRewrite = customRule({
      id: "auth/session-rewrite",
      severity: "high",
      when: {
        ast: [
          { kind: "CallExpression", callee: "compareSync|bcrypt\\.compare", target: "removed" } as AstMatcher,
        ],
      },
    });
    const f = file("src/session.ts", [
      hunk("src/session.ts", [del("  return bcrypt.compareSync(password, hash);", 5)]),
    ]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(sessionRewrite),
      context: context(),
      ast: null,
      oldFileAst: null,
    });
    expect(result.findings).toHaveLength(0);
  });

  it("regex rules still apply to parse-broken files that AST skipped (§7.3)", async () => {
    const ast = await loadAstProject([{ path: "src/broken.ts", content: BROKEN_TS }]);
    expect(ast!.skipped).toEqual(["src/broken.ts"]);

    const regexRule = customRule({ id: "t/regex", when: { addedLines: ["const x ="] } });
    const f = file("src/broken.ts", [hunk("src/broken.ts", [add("  const x = ;", 2)])]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(weakHash, regexRule),
      context: context(),
      ast,
    });
    // The AST rule cannot see the broken file; the regex rule still fires.
    expect(result.findings.map((x) => x.ruleId)).toEqual(["t/regex"]);
  });
});

describe("evaluateRules — regex hygiene (§13.2)", () => {
  it("reports slowRules only for rules exceeding 100ms (fast rules: none)", async () => {
    const rule = customRule({ id: "t/fast", when: { addedLines: ["risk"] } });
    const f = file("src/a.ts", [hunk("src/a.ts", [add("risk();", 1)])]);
    const result = await evaluateRules({
      clusters: [cluster([f])],
      rules: asEffective(rule),
      context: context(),
    });
    expect(result.slowRules).toEqual([]);
  });
});
