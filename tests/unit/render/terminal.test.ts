import { describe, expect, it } from "vitest";
import { renderTerminal } from "../../../src/render/terminal.js";
import { cluster, file, finding, report } from "../checklist/factories.js";

describe("renderTerminal — section structure (§9.2)", () => {
  it("renders header, RISK MAP, REVIEW CHECKLIST, SUGGESTED MANUAL TESTS and the honesty footer in order", () => {
    const r = report();
    const out = renderTerminal(r, { color: false });
    const header = out.indexOf("CrossCheck v0.1.0");
    const riskMap = out.indexOf("RISK MAP");
    const checklist = out.indexOf("REVIEW CHECKLIST");
    const manualTests = out.indexOf("SUGGESTED MANUAL TESTS");
    const footer = out.indexOf("Next:");
    const honesty = out.indexOf("rules catch patterns, not logic");
    expect([header, riskMap, checklist, manualTests, footer, honesty].every((i) => i >= 0)).toBe(true);
    expect(header).toBeLessThan(riskMap);
    expect(riskMap).toBeLessThan(checklist);
    expect(checklist).toBeLessThan(manualTests);
    expect(manualTests).toBeLessThan(footer);
    expect(footer).toBeLessThan(honesty);
  });

  it("header states repo, range+stats, and heuristic/offline mode + duration (F3 behavior)", () => {
    const r = report({
      range: { desc: "staged" },
      stats: {
        filesChanged: 23,
        linesAdded: 1204,
        linesRemoved: 318,
        durationMs: 1900,
        ignored: { count: 0, byReason: {}, examples: [] },
      },
    });
    const out = renderTerminal(r, { color: false });
    expect(out).toContain("range:   staged (23 files, +1204 / −318)");
    expect(out).toContain("mode:    heuristic (offline) · 1.9s");
  });

  it("renders '(stdin)' for repo when repo is null", () => {
    const out = renderTerminal(report({ repo: null }), { color: false });
    expect(out).toContain("repo:    (stdin)");
  });
});

describe("renderTerminal — RISK MAP (F3)", () => {
  it("every cluster appears exactly once with its severity symbol, label, file count and lines (F3 AC1)", () => {
    const c = cluster({
      id: "c1",
      label: "auth/session rewrite",
      severity: "high",
      files: [file("a.ts"), file("b.ts")],
      added: 212,
      removed: 87,
    });
    const r = report({ clusters: [c], findings: [finding({ severity: "high", file: "a.ts" })] });
    const out = renderTerminal(r, { color: false });
    expect(out).toContain("▲");
    expect(out).toContain("auth/session rewrite");
    expect(out).toContain("2 files");
    expect(out).toContain("+212 / −87");
    expect(out).toContain("HIGH");
  });

  it("renders a single reassuring line instead of a table when there are no findings (F3 AC2)", () => {
    const clusters = [cluster({ id: "c1" }), cluster({ id: "c2" }), cluster({ id: "c3" })];
    const r = report({ clusters, findings: [] });
    const out = renderTerminal(r, { color: false });
    expect(out).toContain("all 3 clusters are low-risk by current rules — still read the diff");
  });

  it("shows the ignored-files line only when files were ignored", () => {
    const withIgnored = report({
      stats: {
        filesChanged: 1,
        linesAdded: 1,
        linesRemoved: 0,
        durationMs: 1,
        ignored: { count: 2, byReason: { lockfile: 1, generated: 1 }, examples: ["package-lock.json", "dist/bundle.js"] },
      },
    });
    const out = renderTerminal(withIgnored, { color: false });
    expect(out).toContain("ignored: package-lock.json, dist/bundle.js (lockfile/generated)");

    const withoutIgnored = report();
    expect(renderTerminal(withoutIgnored, { color: false })).not.toContain("ignored:");
  });

  it("is deterministic: identical input renders byte-identical output (F3 AC3)", () => {
    const r = report({ clusters: [cluster({ severity: "high" })], findings: [finding({ severity: "high" })] });
    expect(renderTerminal(r, { color: false })).toBe(renderTerminal(r, { color: false }));
  });
});

describe("renderTerminal — REVIEW CHECKLIST (F4)", () => {
  it("groups items under a cluster header line and numbers them with a ☐ checkbox", () => {
    const r = report({
      clusters: [cluster({ id: "c1", label: "auth/session rewrite", severity: "high" })],
      checklist: [
        {
          severity: "high",
          text: "Verify session tokens are invalidated on password change",
          file: "src/auth/session.ts",
          line: 88,
          ruleId: "auth/session-rewrite",
          clusterId: "c1",
          clusterLabel: "auth/session rewrite",
          acknowledged: false,
        },
      ],
    });
    const out = renderTerminal(r, { color: false });
    expect(out).toContain("▲ auth/session rewrite");
    expect(out).toContain("☐ 1. Verify session tokens are invalidated on password change");
    expect(out).toContain("(src/auth/session.ts:88)");
  });

  it("marks items with no ruleId as (general) (F4 AC2)", () => {
    const r = report({
      checklist: [
        {
          severity: "low",
          text: "Read the full diff of every ▲ cluster top to bottom",
          clusterId: "general",
          clusterLabel: "general",
          acknowledged: false,
        },
      ],
    });
    const out = renderTerminal(r, { color: false });
    expect(out).toContain("(general)");
  });

  it("always shows the rule id suffix, verbose or not (F4 AC2)", () => {
    const r = report({
      checklist: [
        {
          severity: "high",
          text: "some item",
          file: "a.ts",
          line: 1,
          ruleId: "some/rule",
          clusterId: "c1",
          clusterLabel: "cluster",
          acknowledged: false,
        },
      ],
    });
    const quiet = renderTerminal(r, { color: false });
    const verbose = renderTerminal(r, { color: false, verbose: true });
    expect(quiet).toContain("[some/rule]");
    expect(verbose).toContain("[some/rule]");
  });

  it("renders acknowledged items as ✓ with a relative-time annotation (F4 AC3)", () => {
    const r = report({
      createdAt: "2026-07-19T14:02:00.000Z",
      checklist: [
        {
          severity: "high",
          text: "already checked",
          clusterId: "c1",
          clusterLabel: "cluster",
          acknowledged: true,
          ackedAt: "2026-07-17T14:02:00.000Z",
        },
      ],
    });
    const out = renderTerminal(r, { color: false });
    expect(out).toContain("✓ 1. already checked (reviewed 2 days ago)");
  });

  it("truncates long checklists with a '… N more items' note when not verbose, and expands under --verbose", () => {
    const items = Array.from({ length: 14 }, (_, i) => ({
      severity: "high" as const,
      text: `item ${i}`,
      clusterId: "c1",
      clusterLabel: "cluster",
      acknowledged: false,
    }));
    const r = report({ checklist: items });
    const quiet = renderTerminal(r, { color: false });
    expect(quiet).toContain("more items (use --verbose to expand)");
    expect(quiet).not.toContain("item 13");

    const verbose = renderTerminal(r, { color: false, verbose: true });
    expect(verbose).toContain("item 13");
    expect(verbose).not.toContain("more items");
  });
});

describe("renderTerminal — SUGGESTED MANUAL TESTS (F5)", () => {
  it("renders each manual test with its severity symbol", () => {
    const r = report({
      manualTests: [
        { severity: "high", text: "Send a forged webhook", clusterId: "c1", clusterLabel: "webhook" },
        { severity: "medium", text: "Restore a prod-shaped dump", clusterId: "c2", clusterLabel: "migration" },
      ],
    });
    const out = renderTerminal(r, { color: false });
    expect(out).toContain("▲ Send a forged webhook");
    expect(out).toContain("● Restore a prod-shaped dump");
  });

  it("reports the cap when manual tests were capped, only outside --verbose", () => {
    const r = report({ manualTests: [{ severity: "high", text: "t", clusterId: "c1", clusterLabel: "c" }], manualTestsCapped: 4 });
    expect(renderTerminal(r, { color: false })).toContain("+4 more in --verbose");
    expect(renderTerminal(r, { color: false, verbose: true })).not.toContain("+4 more");
  });
});

describe("renderTerminal — previously reviewed (F8)", () => {
  it("shows the previously-reviewed summary line only when hunkCount > 0", () => {
    const withHistory = report({
      previouslyReviewed: { hunkCount: 3, findingCount: 3, lastAckedAt: "2026-07-19T12:00:00.000Z", findings: [] },
    });
    const out = renderTerminal(withHistory, { color: false });
    expect(out).toContain("Previously reviewed: 3 hunks ✓");
    expect(out).toContain("hidden; --all to show");

    const withoutHistory = report();
    expect(renderTerminal(withoutHistory, { color: false })).not.toContain("Previously reviewed");
  });
});

describe("renderTerminal — color option (§5.7)", () => {
  it("emits no ANSI escape codes when color is false", () => {
    const r = report({ clusters: [cluster({ severity: "high" })], findings: [finding({ severity: "high" })] });
    const out = renderTerminal(r, { color: false });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  it("emits ANSI escape codes when color is true", () => {
    const r = report({ clusters: [cluster({ severity: "high" })], findings: [finding({ severity: "high" })] });
    const out = renderTerminal(r, { color: true });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(true);
  });
});
