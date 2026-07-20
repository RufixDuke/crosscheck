import { describe, expect, it } from "vitest";
import type { AstProjectHandle } from "../../../src/ast/types.js";
import {
  clusterDiff,
  hunkNewLineRanges,
  type ClusterResult,
} from "../../../src/cluster/index.js";
import { add, ctx, diff, file, hunk } from "./helpers.js";

/** Minimal AstProjectHandle double — no ts-morph involved. */
function mockAst(overrides?: Partial<AstProjectHandle>): AstProjectHandle {
  return {
    analyzed: [],
    skipped: [],
    getSourceFile: () => undefined,
    importEdges: () => [],
    changedSymbols: () => [],
    ...overrides,
  };
}

const paths = (result: ClusterResult) => result.clusters.map((c) => c.files.map((f) => f.path));

describe("clusterDiff — path affinity & import edges", () => {
  it("clusters same-directory files together", () => {
    const result = clusterDiff(
      diff(file("src/auth/session.ts", [add("x")]), file("src/auth/cookies.ts", [add("y")])),
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.files.map((f) => f.path).sort()).toEqual([
      "src/auth/cookies.ts",
      "src/auth/session.ts",
    ]);
    expect(result.ast).toEqual({ analyzed: 0, skipped: 0 });
  });

  it("clusters import-linked files across directories (regex fallback)", () => {
    const result = clusterDiff(
      diff(
        file("src/routes/pay.ts", [add(`import { record } from "../db/records";`)]),
        file("src/db/records.ts", [add("export const record = {};")]),
      ),
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.files).toHaveLength(2);
  });

  it("keeps unrelated files in separate clusters", () => {
    const result = clusterDiff(
      diff(file("src/auth/x.ts", [add("x")]), file("docs/guide.md", [add("y")])),
    );
    expect(result.clusters).toHaveLength(2);
  });

  it("sums added/removed and collects hunks per cluster", () => {
    const result = clusterDiff(
      diff(
        file("src/auth/a.ts", [add("l1"), add("l2")], { removed: 3 }),
        file("src/auth/b.ts", [add("l3")], { removed: 1 }),
      ),
    );
    const cluster = result.clusters[0];
    expect(cluster?.added).toBe(3);
    expect(cluster?.removed).toBe(4);
    expect(cluster?.hunks).toHaveLength(2);
    expect(cluster?.severity).toBe("low"); // placeholder — rule engine overwrites
  });

  it("handles an empty diff", () => {
    const result = clusterDiff(diff());
    expect(result.clusters).toEqual([]);
    expect(result.ast).toEqual({ analyzed: 0, skipped: 0 });
  });
});

describe("clusterDiff — AST path (mock AstProjectHandle)", () => {
  it("uses ast.importEdges() to link files across directories", () => {
    const ast = mockAst({
      analyzed: ["src/api/handler.ts", "src/lib/deep/util.ts"],
      skipped: ["README.md"],
      importEdges: () => [["src/api/handler.ts", "src/lib/deep/util.ts"]],
    });
    const result = clusterDiff(
      diff(
        file("src/api/handler.ts", [add("const x = run();")]),
        file("src/lib/deep/util.ts", [add("export function run() {}")]),
        file("README.md", [add("docs")]),
      ),
      { ast },
    );
    expect(result.ast).toEqual({ analyzed: 2, skipped: 1 });
    const pair = result.clusters.find((c) => c.files.length === 2);
    expect(pair?.files.map((f) => f.path).sort()).toEqual([
      "src/api/handler.ts",
      "src/lib/deep/util.ts",
    ]);
  });

  it("always unions regex edges even when AST is present (§5.4 fallback)", () => {
    // AST handle knows nothing; the regex edge must still cluster the pair.
    const ast = mockAst({ analyzed: ["src/routes/pay.ts"], importEdges: () => [] });
    const result = clusterDiff(
      diff(
        file("src/routes/pay.ts", [add(`import { record } from "../db/records";`)]),
        file("src/db/records.ts", [add("export const record = {};")]),
      ),
      { ast },
    );
    expect(result.clusters).toHaveLength(1);
  });

  it("gathers changed symbols for TS/JS files via the handle", () => {
    const ast = mockAst({
      analyzed: ["src/auth/session.ts", "src/auth/session.test.ts"],
      changedSymbols: (path) => (path === "src/auth/session.ts" ? ["sessionStore", "sessionStore"] : []),
    });
    const result = clusterDiff(
      diff(
        file("src/auth/session.ts", [add("// rewrote the store")]),
        file("src/auth/session.test.ts", [add("// updated tests")]),
        file("styles/main.py", [add("# unrelated")]),
      ),
      { ast },
    );
    const authCluster = result.clusters.find((c) => c.files.some((f) => f.path.includes("auth")));
    expect(authCluster?.symbols).toEqual(["sessionStore"]); // deduped
    expect(authCluster?.label).toContain("auth");
    expect(authCluster?.label).toContain("session");
    const pyCluster = result.clusters.find((c) => c.files.some((f) => f.path.endsWith(".py")));
    expect(pyCluster?.symbols).toEqual([]); // non-TS/JS → no symbols
  });

  it("passes hunk new-line ranges to changedSymbols", () => {
    const seen: Array<readonly [string, Array<readonly [number, number]>]> = [];
    const ast = mockAst({
      changedSymbols: (path, ranges) => {
        seen.push([path, ranges] as const);
        return [];
      },
    });
    clusterDiff(
      diff(file("src/a.ts", [hunk("src/a.ts", [add("x")], { newStart: 10, newLines: 5 })])),
      { ast },
    );
    expect(seen).toEqual([["src/a.ts", [[10, 14]]]]);
  });
});

describe("clusterDiff — capping (§5.4)", () => {
  function tenComponentDiff() {
    // 10 single-file components in unrelated top-level dirs; decreasing
    // changed-lines so the sort order is fully determined: pkg0 > … > pkg9.
    const files = [];
    for (let i = 0; i < 10; i++) {
      files.push(file(`pkg${i}/mod${i}.ts`, [add(`export const v${i} = 1;`)], { added: (10 - i) * 10 }));
    }
    return diff(...files);
  }

  it("caps at maxClusters with overflow labeled exactly `misc changes`", () => {
    const result = clusterDiff(tenComponentDiff(), { maxClusters: 8 });
    expect(result.clusters).toHaveLength(8);
    const misc = result.clusters[7];
    expect(misc?.label).toBe("misc changes");
    expect(misc?.files.map((f) => f.path)).toEqual(["pkg7/mod7.ts", "pkg8/mod8.ts", "pkg9/mod9.ts"]);
    expect(misc?.added).toBe(30 + 20 + 10);
  });

  it("assigns stable ids c1..cn in sorted order", () => {
    const result = clusterDiff(tenComponentDiff(), { maxClusters: 8 });
    expect(result.clusters.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
    expect(result.clusters[0]?.files[0]?.path).toBe("pkg0/mod0.ts");
  });

  it("does not create a misc cluster when components fit under the cap", () => {
    const result = clusterDiff(
      diff(file("a/x.ts", [add("1")]), file("b/y.ts", [add("2")])),
      { maxClusters: 8 },
    );
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.every((c) => c.label !== "misc changes")).toBe(true);
  });
});

describe("clusterDiff — labels & determinism", () => {
  it("labels the auth/session cluster with its directory", () => {
    const result = clusterDiff(
      diff(file("src/auth/session.ts", [add("x")]), file("src/auth/session.test.ts", [add("y")])),
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.label).toContain("auth");
  });

  it("produces identical output for identical input", () => {
    const build = () =>
      diff(
        file("src/auth/session.ts", [add(`import { db } from "../db/client";`), add("// logic")]),
        file("src/db/client.ts", [add("export const db = {};")]),
        file("src/components/Button.tsx", [add("export const Button = () => null;")]),
        file("docs/guide.md", [add("# guide")]),
        file("db/migrations/0017_family_plans.sql", [add("CREATE TABLE family_plans ();")]),
      );
    const first = clusterDiff(build());
    const second = clusterDiff(build());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("hunkNewLineRanges", () => {
  it("maps hunks to newStart..newStart+newLines-1", () => {
    const f = file("src/a.ts", [
      hunk("src/a.ts", [add("x")], { newStart: 10, newLines: 5 }),
      hunk("src/a.ts", [add("y")], { newStart: 40, newLines: 1 }),
    ]);
    expect(hunkNewLineRanges(f)).toEqual([
      [10, 14],
      [40, 40],
    ]);
  });

  it("clamps pure-deletion hunks (newLines 0) to the anchor line", () => {
    const f = file("src/a.ts", [hunk("src/a.ts", [add("x")], { newStart: 7, newLines: 0 })]);
    expect(hunkNewLineRanges(f)).toEqual([[7, 7]]);
  });
});
