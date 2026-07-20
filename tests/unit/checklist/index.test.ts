import { describe, expect, it } from "vitest";
import { buildChecklist } from "../../../src/checklist/index.js";
import { cluster, file, finding } from "./factories.js";

describe("buildChecklist — item construction (§6.2 step 6, §7.1)", () => {
  it("emits one checklist item per checklist string on a finding (§7.1: N strings ⇒ N items)", () => {
    const c = cluster({ id: "c1", label: "auth", files: [file("src/auth/session.ts")] });
    const f = finding({
      file: "src/auth/session.ts",
      line: 88,
      severity: "high",
      ruleId: "auth/session-rewrite",
      checklist: ["Verify session tokens are invalidated on password change", "Confirm cookie flags unchanged"],
    });
    const result = buildChecklist({
      clusters: [c],
      findings: [f],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    // +1 for the unconditional generic hygiene item appended at the end.
    expect(result.checklist).toHaveLength(3);
    const [first, second] = result.checklist;
    expect(first?.text).toBe("Verify session tokens are invalidated on password change");
    expect(first?.file).toBe("src/auth/session.ts");
    expect(first?.line).toBe(88);
    expect(first?.ruleId).toBe("auth/session-rewrite");
    expect(first?.clusterId).toBe("c1");
    expect(first?.clusterLabel).toBe("auth");
    expect(second?.text).toBe("Confirm cookie flags unchanged");
  });

  it("looks up clusterId/clusterLabel from the cluster containing the finding's file", () => {
    const authCluster = cluster({ id: "c1", label: "auth stuff", files: [file("src/auth/x.ts")] });
    const dbCluster = cluster({ id: "c2", label: "db stuff", files: [file("src/db/y.ts")] });
    const f = finding({ file: "src/db/y.ts", checklist: ["check db thing"] });
    const result = buildChecklist({
      clusters: [authCluster, dbCluster],
      findings: [f],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    const item = result.checklist.find((i) => i.text === "check db thing");
    expect(item?.clusterId).toBe("c2");
    expect(item?.clusterLabel).toBe("db stuff");
  });

  it("appends the generic hygiene item unconditionally, with no ruleId (F4 behavior/AC2)", () => {
    const result = buildChecklist({
      clusters: [cluster()],
      findings: [],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.checklist).toHaveLength(1);
    expect(result.checklist[0]?.ruleId).toBeUndefined();
    expect(result.checklist[0]?.text).toMatch(/rules catch patterns, not logic/);
  });
});

describe("buildChecklist — dedup (§7.1 step 8: checklist items dedupe by text across rules)", () => {
  it("collapses identical checklist text from two different rules/findings into one item", () => {
    const c = cluster({ files: [file("src/a.ts"), file("src/b.ts")] });
    const f1 = finding({ ruleId: "rule-a", file: "src/a.ts", line: 1, checklist: ["Same text"] });
    const f2 = finding({ ruleId: "rule-b", file: "src/b.ts", line: 2, checklist: ["Same text"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [f1, f2],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    const matches = result.checklist.filter((i) => i.text === "Same text");
    expect(matches).toHaveLength(1);
  });

  it("keeps the higher-severity occurrence's metadata when the same text appears at two severities", () => {
    const c = cluster({ files: [file("src/a.ts"), file("src/b.ts")] });
    const low = finding({ ruleId: "rule-low", severity: "low", file: "src/b.ts", line: 9, checklist: ["Same text"] });
    const high = finding({ ruleId: "rule-high", severity: "high", file: "src/a.ts", line: 1, checklist: ["Same text"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [low, high],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    const item = result.checklist.find((i) => i.text === "Same text");
    expect(item?.ruleId).toBe("rule-high");
    expect(item?.severity).toBe("high");
  });
});

describe("buildChecklist — ordering (F4 AC1: ▲ before ● before ■, then cluster, then file:line)", () => {
  it("sorts high before medium before low regardless of input order", () => {
    const c = cluster({ files: [file("src/a.ts")] });
    const lowF = finding({ severity: "low", file: "src/a.ts", line: 1, checklist: ["low item"] });
    const highF = finding({ severity: "high", file: "src/a.ts", line: 2, checklist: ["high item"] });
    const medF = finding({ severity: "medium", file: "src/a.ts", line: 3, checklist: ["medium item"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [lowF, highF, medF],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    const severityOrder = result.checklist.filter((i) => i.ruleId !== undefined).map((i) => i.severity);
    expect(severityOrder).toEqual(["high", "medium", "low"]);
  });

  it("orders by cluster position (clusters pre-sorted severity desc, size desc) within the same severity", () => {
    const c1 = cluster({ id: "c1", label: "first", severity: "high", files: [file("src/a.ts")] });
    const c2 = cluster({ id: "c2", label: "second", severity: "high", files: [file("src/b.ts")] });
    const inSecond = finding({ severity: "high", file: "src/b.ts", checklist: ["from second cluster"] });
    const inFirst = finding({ severity: "high", file: "src/a.ts", checklist: ["from first cluster"] });
    const result = buildChecklist({
      clusters: [c1, c2],
      findings: [inSecond, inFirst],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    const texts = result.checklist.filter((i) => i.ruleId !== undefined).map((i) => i.text);
    expect(texts).toEqual(["from first cluster", "from second cluster"]);
  });

  it("orders by file:line within the same cluster and severity", () => {
    const c = cluster({ files: [file("src/a.ts"), file("src/b.ts")] });
    const second = finding({ severity: "high", file: "src/b.ts", line: 5, checklist: ["z item"] });
    const first = finding({ severity: "high", file: "src/a.ts", line: 50, checklist: ["a item"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [second, first],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    const texts = result.checklist.filter((i) => i.ruleId !== undefined).map((i) => i.text);
    expect(texts).toEqual(["a item", "z item"]);
  });

  it("appends hygiene items after all finding-derived items, even though their nominal severity is low", () => {
    const c = cluster({ files: [file("src/a.ts")] });
    const highF = finding({ severity: "high", file: "src/a.ts", checklist: ["high item"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [highF],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.checklist.at(-1)?.ruleId).toBeUndefined();
  });
});

describe("buildChecklist — exclusions (§7.9: info findings never enter the checklist/manual tests)", () => {
  it("excludes findings passed only in previouslyReviewed.findings, even if also present in findings", () => {
    const c = cluster({ files: [file("src/a.ts")] });
    const acked = finding({ file: "src/a.ts", checklist: ["acked item"], acknowledged: true });
    const result = buildChecklist({
      clusters: [c],
      findings: [acked],
      infoFindings: [],
      previouslyReviewed: { findings: [acked] },
      maxTests: 12,
    });
    expect(result.checklist.some((i) => i.text === "acked item")).toBe(false);
  });

  it("excludes findings marked info:true even if present in the active findings array", () => {
    const c = cluster({ files: [file("src/a.ts")] });
    const infoF = finding({ file: "src/a.ts", checklist: ["info item"], info: true });
    const result = buildChecklist({
      clusters: [c],
      findings: [infoF],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.checklist.some((i) => i.text === "info item")).toBe(false);
  });
});

describe("buildChecklist — no findings (F3 AC2 adjacent: empty input still yields hygiene-only checklist)", () => {
  it("returns only the hygiene item(s) and no manual tests when there are no active findings", () => {
    const result = buildChecklist({
      clusters: [cluster({ severity: "low" })],
      findings: [],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.checklist.every((i) => i.ruleId === undefined)).toBe(true);
    expect(result.manualTests).toEqual([]);
    expect(result.manualTestsCapped).toBe(0);
  });
});

describe("buildChecklist — manual tests (F5)", () => {
  it("gathers manualTests off active findings, tagging cluster/severity", () => {
    const c = cluster({ id: "c1", label: "webhook", severity: "high", files: [file("src/webhooks.ts")] });
    const f = finding({
      severity: "high",
      file: "src/webhooks.ts",
      manualTests: ["Send a forged webhook — expect 4xx, zero side effects"],
    });
    const result = buildChecklist({
      clusters: [c],
      findings: [f],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.manualTests).toEqual([
      {
        severity: "high",
        text: "Send a forged webhook — expect 4xx, zero side effects",
        clusterId: "c1",
        clusterLabel: "webhook",
      },
    ]);
  });

  it("dedupes manual test suggestions by exact text", () => {
    const c = cluster({ files: [file("src/a.ts"), file("src/b.ts")] });
    const f1 = finding({ file: "src/a.ts", manualTests: ["Same test"] });
    const f2 = finding({ file: "src/b.ts", manualTests: ["Same test"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [f1, f2],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.manualTests).toHaveLength(1);
  });

  it("orders manual tests severity desc, matching §9.2's suggested-tests section", () => {
    const c = cluster({ files: [file("src/a.ts")] });
    const lowF = finding({ severity: "low", file: "src/a.ts", manualTests: ["low test"] });
    const highF = finding({ severity: "high", file: "src/a.ts", manualTests: ["high test"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [lowF, highF],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.manualTests.map((t) => t.text)).toEqual(["high test", "low test"]);
  });

  it("caps at maxTests and reports how many were cut (F5: cap at 12 default, configurable)", () => {
    const c = cluster({ files: [file("src/a.ts")] });
    const f = finding({
      file: "src/a.ts",
      manualTests: Array.from({ length: 5 }, (_, i) => `test ${i}`),
    });
    const result = buildChecklist({
      clusters: [c],
      findings: [f],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 3,
    });
    expect(result.manualTests).toHaveLength(3);
    expect(result.manualTestsCapped).toBe(2);
  });

  it("reports zero capped when nothing was cut", () => {
    const c = cluster({ files: [file("src/a.ts")] });
    const f = finding({ file: "src/a.ts", manualTests: ["only test"] });
    const result = buildChecklist({
      clusters: [c],
      findings: [f],
      infoFindings: [],
      previouslyReviewed: { findings: [] },
      maxTests: 12,
    });
    expect(result.manualTestsCapped).toBe(0);
  });
});
