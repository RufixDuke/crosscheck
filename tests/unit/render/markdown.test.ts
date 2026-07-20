import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../../src/render/markdown.js";
import { cluster, report } from "../checklist/factories.js";

describe("renderMarkdown — self-contained PR-ready doc (§9.9, F10)", () => {
  it("includes a title with range + stats, a provenance line, and the honesty footer (F10 AC3)", () => {
    const r = report({
      toolVersion: "0.1.0",
      createdAt: "2026-07-19T14:02:00.000Z",
      range: { desc: "staged" },
      stats: {
        filesChanged: 23,
        linesAdded: 1204,
        linesRemoved: 318,
        durationMs: 1900,
        ignored: { count: 0, byReason: {}, examples: [] },
      },
    });
    const out = renderMarkdown(r);
    expect(out).toContain("## CrossCheck review — staged (23 files, +1204 / −318)");
    expect(out).toContain("_Generated 2026-07-19 14:02 UTC · CrossCheck v0.1.0 · heuristic (offline) mode_");
    expect(out).toContain("> Heuristics catch patterns, not logic.");
  });

  it("renders the risk map as a real markdown table with abbreviated severity words", () => {
    const c = cluster({ id: "c1", label: "auth/session rewrite", severity: "high", added: 212, removed: 87 });
    const r = report({
      clusters: [c],
      findings: [{ ruleId: "r", severity: "high", baseSeverity: "high", file: "a.ts", line: 1, evidence: "e", message: "m", checklist: [], manualTests: [], hunkHash: "h" }],
    });
    const out = renderMarkdown(r);
    expect(out).toContain("| Severity | Cluster | Files | Lines |");
    expect(out).toContain("| ▲ HIGH | auth/session rewrite | 1 | +212 / −87 |");
  });

  it("renders the reassuring line instead of a table when there are no findings", () => {
    const r = report({ clusters: [cluster({ id: "c1" }), cluster({ id: "c2" })], findings: [] });
    const out = renderMarkdown(r);
    expect(out).toContain("_all 2 clusters are low-risk by current rules — still read the diff_");
    expect(out).not.toContain("| Severity |");
  });

  it("renders checklist items as GitHub task-list items, checked when acknowledged (F10 behavior)", () => {
    const r = report({
      checklist: [
        {
          severity: "high",
          text: "Verify session tokens",
          file: "src/auth/session.ts",
          line: 88,
          ruleId: "auth/session-rewrite",
          clusterId: "c1",
          clusterLabel: "auth",
          acknowledged: false,
        },
        {
          severity: "medium",
          text: "already handled",
          ruleId: "auth/other-rule",
          clusterId: "c1",
          clusterLabel: "auth",
          acknowledged: true,
        },
      ],
    });
    const out = renderMarkdown(r);
    expect(out).toContain("- [ ] **(HIGH)** Verify session tokens — `src/auth/session.ts:88`");
    expect(out).toContain("- [x] **(MED)** already handled");
  });

  it("marks items with no ruleId as GENERAL", () => {
    const r = report({
      checklist: [
        { severity: "low", text: "hygiene item", clusterId: "general", clusterLabel: "general", acknowledged: false },
      ],
    });
    expect(renderMarkdown(r)).toContain("- [ ] **(GENERAL)** hygiene item");
  });

  it("renders manual tests as a plain task list and reports the cap when hit", () => {
    const r = report({
      manualTests: [{ severity: "high", text: "Forged webhook → expect 4xx", clusterId: "c1", clusterLabel: "webhook" }],
      manualTestsCapped: 4,
    });
    const out = renderMarkdown(r);
    expect(out).toContain("- [ ] Forged webhook → expect 4xx");
    expect(out).toContain("+4 more suggestions omitted");
  });

  it("is deterministic across repeated renders of the same report (no Math.random/locale dependence)", () => {
    const r = report();
    expect(renderMarkdown(r)).toBe(renderMarkdown(r));
  });
});
