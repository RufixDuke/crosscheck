/**
 * `planClusters()` tests (§11.1, §13.3, §15.4.7): skip order ▲ → ● → ■,
 * per-review ceiling enforcement, and per-cluster truncation that keeps
 * hunk heads + rule-evidence lines.
 */
import { describe, expect, it } from "vitest";
import { planClusters } from "../../../src/llm/budget.js";
import { add, cluster, file, finding, hunk } from "./factories.js";

function padLine(n: number): string {
  return `line ${n} filler text long enough to matter for the head cutoff`;
}

describe("planClusters — inclusion order (§11.1: ▲ then ● then ■)", () => {
  it("includes high severity first, then medium, then low, when budget allows all", () => {
    const low = cluster([file("low.ts", [hunk("low.ts", [add("x")])])], { severity: "low", label: "low" });
    const high = cluster([file("high.ts", [hunk("high.ts", [add("y")])])], { severity: "high", label: "high" });
    const medium = cluster([file("med.ts", [hunk("med.ts", [add("z")])])], {
      severity: "medium",
      label: "medium",
    });

    const plan = planClusters({
      clusters: [low, high, medium], // deliberately out of order going in
      findings: [],
      maxTokensPerReview: 48000,
      maxTokensPerCluster: 6000,
    });

    expect(plan.included.map((e) => e.cluster.label)).toEqual(["high", "medium", "low"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips lower-severity clusters first when the per-review ceiling is exceeded, never silently", () => {
    // Sized so `high` alone fits the review ceiling but leaves too little
    // room for either `medium` or `low` (each larger than the remainder).
    const high = cluster([file("high.ts", [hunk("high.ts", [add("h".repeat(150))])])], {
      severity: "high",
      label: "high",
    });
    const medium = cluster([file("med.ts", [hunk("med.ts", [add("m".repeat(150))])])], {
      severity: "medium",
      label: "medium",
    });
    const low = cluster([file("low.ts", [hunk("low.ts", [add("l".repeat(150))])])], {
      severity: "low",
      label: "low",
    });

    const plan = planClusters({
      clusters: [high, medium, low],
      findings: [],
      maxTokensPerReview: 45, // fits ~1 cluster's worth (~150 chars => ~38-40 tokens)
      maxTokensPerCluster: 6000,
    });

    expect(plan.included).toHaveLength(1);
    expect(plan.included[0]?.cluster.label).toBe("high");
    // Whatever didn't fit is reported with a reason, never dropped silently —
    // and skip order still follows severity (medium before low).
    expect(plan.skipped.map((s) => s.clusterLabel)).toEqual(["medium", "low"]);
    for (const skip of plan.skipped) {
      expect(skip.reason).toBe("not summarized (token budget)");
    }
    expect(plan.included.length + plan.skipped.length).toBe(3);
  });
});

describe("planClusters — per-cluster truncation keeps hunk heads + rule-evidence lines (§11.1)", () => {
  it("keeps the first N changed lines of a hunk and drops the rest when over cap", () => {
    const lines = Array.from({ length: 20 }, (_, i) => add(padLine(i)));
    const bigCluster = cluster([file("big.ts", [hunk("big.ts", lines)])], { severity: "high", label: "big" });

    const plan = planClusters({
      clusters: [bigCluster],
      findings: [],
      maxTokensPerReview: 48000,
      maxTokensPerCluster: 6000,
    });

    const entry = plan.included[0];
    expect(entry).toBeDefined();
    // Head lines (0..11) survive; a line well past the head cutoff with no
    // matching finding evidence does not.
    expect(entry!.redacted.text).toContain(padLine(0));
    expect(entry!.redacted.text).toContain(padLine(11));
    expect(entry!.redacted.text).not.toContain(padLine(18));
  });

  it("keeps a rule-evidence line even when it falls past the head cutoff", () => {
    const lines = Array.from({ length: 20 }, (_, i) => add(padLine(i)));
    const h = hunk("big.ts", lines);
    const bigCluster = cluster([file("big.ts", [h])], { severity: "high", label: "big" });
    const evidenceFinding = finding({
      ruleId: "secrets/hardcoded-secret",
      hunkHash: h.hash,
      evidence: padLine(18),
    });

    const plan = planClusters({
      clusters: [bigCluster],
      findings: [evidenceFinding],
      maxTokensPerReview: 48000,
      maxTokensPerCluster: 6000,
    });

    const entry = plan.included[0];
    expect(entry).toBeDefined();
    expect(entry!.redacted.text).toContain(padLine(18)); // kept because it's rule evidence
    expect(entry!.redacted.text).not.toContain(padLine(15)); // still dropped — no evidence, past head
  });

  it("hard-truncates a cluster whose kept content still exceeds its per-cluster char cap", () => {
    const lines = Array.from({ length: 5 }, (_, i) => add(padLine(i).repeat(50)));
    const hugeCluster = cluster([file("huge.ts", [hunk("huge.ts", lines)])], {
      severity: "high",
      label: "huge",
    });

    const plan = planClusters({
      clusters: [hugeCluster],
      findings: [],
      maxTokensPerReview: 48000,
      maxTokensPerCluster: 10, // 40 chars — far smaller than the content
    });

    const entry = plan.included[0];
    expect(entry).toBeDefined();
    expect(entry!.truncated).toBe(true);
  });
});
