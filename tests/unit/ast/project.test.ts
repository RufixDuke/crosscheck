import { describe, expect, it } from "vitest";
import { loadAstProject } from "../../../src/ast/project.js";
import { BROKEN_TS } from "../../fixtures/rules/snippets.js";

describe("loadAstProject", () => {
  it("loads TS/JS files into an in-memory project and reports analyzed paths", async () => {
    const handle = await loadAstProject([
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { path: "src/b.tsx", content: "export const B = () => <div />;\n" },
      { path: "src/c.mts", content: "export const c = 3;\n" },
    ]);
    expect(handle).not.toBeNull();
    expect(handle!.analyzed.sort()).toEqual(["src/a.ts", "src/b.tsx", "src/c.mts"]);
    expect(handle!.skipped).toEqual([]);
    expect(handle!.getSourceFile("src/a.ts")).toBeDefined();
    expect(handle!.getSourceFile("src/nope.ts")).toBeUndefined();
  });

  it("counts non-TS/JS files as skipped without loading them", async () => {
    const handle = await loadAstProject([
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { path: "styles/main.css", content: "body { color: red; }" },
      { path: "README.md", content: "# hi" },
    ]);
    expect(handle!.analyzed).toEqual(["src/a.ts"]);
    expect(handle!.skipped.sort()).toEqual(["README.md", "styles/main.css"]);
  });

  it("skips files that fail to parse but keeps the rest", async () => {
    const handle = await loadAstProject([
      { path: "src/good.ts", content: "export const ok = true;\n" },
      { path: "src/broken.ts", content: BROKEN_TS },
    ]);
    expect(handle!.analyzed).toEqual(["src/good.ts"]);
    expect(handle!.skipped).toEqual(["src/broken.ts"]);
    expect(handle!.getSourceFile("src/broken.ts")).toBeUndefined();
  });

  it("caps the project at opts.cap files; extras count as skipped", async () => {
    const files = [
      { path: "src/1.ts", content: "export const n = 1;" },
      { path: "src/2.ts", content: "export const n = 2;" },
      { path: "src/3.ts", content: "export const n = 3;" },
      { path: "src/4.ts", content: "export const n = 4;" },
    ];
    const handle = await loadAstProject(files, { cap: 2 });
    expect(handle!.analyzed).toEqual(["src/1.ts", "src/2.ts"]);
    expect(handle!.skipped.sort()).toEqual(["src/3.ts", "src/4.ts"]);
  });

  it("resolves relative import edges only among loaded files", async () => {
    const handle = await loadAstProject([
      {
        path: "src/a.ts",
        content: [
          `import { b } from "./b";`,
          `import { c } from "./c/index.js";`,
          `import { d } from "../lib/d";`,
          `import express from "express";`,
          `import { missing } from "./missing";`,
          "export const a = b + c + d;",
        ].join("\n"),
      },
      { path: "src/b.ts", content: "export const b = 1;" },
      { path: "src/c/index.ts", content: "export const c = 2;" },
      { path: "lib/d.ts", content: "export const d = 3;" },
    ]);
    const edges = handle!.importEdges();
    expect(edges).toContainEqual(["src/a.ts", "src/b.ts"]);
    expect(edges).toContainEqual(["src/a.ts", "src/c/index.ts"]);
    expect(edges).toContainEqual(["src/a.ts", "lib/d.ts"]);
    // Bare specifiers and unresolvable relatives produce no edges.
    expect(edges).toHaveLength(3);
    expect(edges.every(([from]) => from === "src/a.ts")).toBe(true);
  });

  it("changedSymbols returns functions/classes/methods/arrow-vars overlapping the ranges", async () => {
    const content = [
      "export function alpha() {", // 1
      "  return 1;", // 2
      "}", // 3
      "export class Beta {", // 4
      "  gamma() {", // 5
      "    return 2;", // 6
      "  }", // 7
      "}", // 8
      "export const delta = () => {", // 9
      "  return 3;", // 10
      "};", // 11
      "export function untouched() {", // 12
      "  return 4;", // 13
      "}", // 14
    ].join("\n");
    const handle = await loadAstProject([{ path: "src/syms.ts", content }]);

    expect(handle!.changedSymbols("src/syms.ts", [[2, 2]])).toEqual(["alpha"]);
    expect(handle!.changedSymbols("src/syms.ts", [[6, 6]])).toEqual(["Beta", "gamma"]);
    expect(handle!.changedSymbols("src/syms.ts", [[10, 10]])).toEqual(["delta"]);
    // A range spanning two declarations reports both.
    expect(handle!.changedSymbols("src/syms.ts", [[1, 6]])).toEqual(["alpha", "Beta", "gamma"]);
    // Untouched declaration outside any range; unknown file / empty ranges.
    expect(handle!.changedSymbols("src/syms.ts", [[12, 14]])).toEqual(["untouched"]);
    expect(handle!.changedSymbols("src/syms.ts", [])).toEqual([]);
    expect(handle!.changedSymbols("src/unknown.ts", [[1, 5]])).toEqual([]);
  });
});
