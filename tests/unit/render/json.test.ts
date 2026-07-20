import { describe, expect, it } from "vitest";
import { renderJson } from "../../../src/render/json.js";
import { cluster, finding, report } from "../checklist/factories.js";

describe("renderJson — machine/CI format (§9.8, F9)", () => {
  it("round-trips the full ReviewReport plus a summary block", () => {
    const r = report({
      range: { desc: "staged" },
      stats: {
        filesChanged: 23,
        linesAdded: 1204,
        linesRemoved: 318,
        durationMs: 1873,
        ignored: { count: 0, byReason: {}, examples: [] },
      },
      strict: { failOn: "high", unacknowledgedAtOrAbove: 2, passed: false },
    });
    const parsed = JSON.parse(renderJson(r));
    expect(parsed.toolVersion).toBe(r.toolVersion);
    expect(parsed.range).toEqual(r.range);
    expect(parsed.stats).toEqual(r.stats);
    expect(parsed.summary).toEqual({
      range: "staged",
      files: 23,
      added: 1204,
      removed: 318,
      clusters: r.clusters.length,
      findings: { high: 0, medium: 0, low: 0, acknowledged: 0 },
      failOn: "high",
      exitCode: null,
      durationMs: 1873,
    });
  });

  it("summary.findings tallies active findings by severity (matches PRD §9.8 example shape)", () => {
    const r = report({
      findings: [
        finding({ severity: "high" }),
        finding({ severity: "high" }),
        finding({ severity: "medium" }),
        finding({ severity: "low" }),
      ],
      previouslyReviewed: { hunkCount: 3, findingCount: 3, findings: [] },
    });
    const parsed = JSON.parse(renderJson(r));
    expect(parsed.summary.findings).toEqual({ high: 2, medium: 1, low: 1, acknowledged: 3 });
  });

  it("summary.failOn is null when the report has no strict block (not run with --strict)", () => {
    const r = report();
    expect(r.strict).toBeUndefined();
    const parsed = JSON.parse(renderJson(r));
    expect(parsed.summary.failOn).toBeNull();
  });

  it("leaves summary.exitCode as null — exit-code computation is a CLI-layer concern, out of scope here", () => {
    const parsed = JSON.parse(renderJson(report()));
    expect(parsed.summary.exitCode).toBeNull();
  });

  it("is valid, deterministic JSON for the same report (stable key order, no Math.random)", () => {
    const r = report({ clusters: [cluster()] });
    const a = renderJson(r);
    const b = renderJson(r);
    expect(a).toBe(b);
    expect(() => JSON.parse(a)).not.toThrow();
  });

  it("emits pretty-printed (indented) JSON", () => {
    const out = renderJson(report());
    expect(out).toContain("\n  \"toolVersion\"");
  });
});
