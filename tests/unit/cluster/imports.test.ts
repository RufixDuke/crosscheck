import { describe, expect, it } from "vitest";
import { regexImportEdges } from "../../../src/cluster/imports.js";
import { add, ctx, file } from "./helpers.js";

describe("regexImportEdges — JS/TS", () => {
  it("detects a relative ES import and resolves the extension", () => {
    const files = [
      file("src/a.ts", [add(`import { b } from "./b";`)]),
      file("src/b.ts", [add(`export const b = 1;`)]),
    ];
    expect(regexImportEdges(files)).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("detects import type and side-effect imports", () => {
    const files = [
      file("src/a.ts", [add(`import type { B } from "./b";`), add(`import "./polyfill";`)]),
      file("src/b.ts", [ctx(`export interface B {}`)]),
      file("src/polyfill.ts", [ctx(`// filler`)]),
    ];
    const edges = regexImportEdges(files);
    expect(edges).toContainEqual(["src/a.ts", "src/b.ts"]);
    expect(edges).toContainEqual(["src/a.ts", "src/polyfill.ts"]);
  });

  it("detects multi-line imports (the `} from \"./x\"` line)", () => {
    const files = [
      file("src/a.ts", [add(`import {`), add(`  alpha,`), add(`} from "./x";`)]),
      file("src/x.ts", [ctx(`export const alpha = 1;`)]),
    ];
    expect(regexImportEdges(files)).toContainEqual(["src/a.ts", "src/x.ts"]);
  });

  it("detects re-exports and require()", () => {
    const files = [
      file("src/a.ts", [add(`export { thing } from "./thing";`)]),
      file("src/b.js", [add(`const util = require("../lib/util");`)]),
      file("src/thing.ts", [ctx(`export const thing = 1;`)]),
      file("lib/util.js", [ctx(`module.exports = {};`)]),
    ];
    const edges = regexImportEdges(files);
    expect(edges).toContainEqual(["src/a.ts", "src/thing.ts"]);
    expect(edges).toContainEqual(["src/b.js", "lib/util.js"]);
  });

  it("detects dynamic import()", () => {
    const files = [
      file("src/a.ts", [add(`const page = await import("./pages/home");`)]),
      file("src/pages/home.tsx", [ctx(`export default function Home() {}`)]),
    ];
    expect(regexImportEdges(files)).toContainEqual(["src/a.ts", "src/pages/home.tsx"]);
  });

  it("resolves ../ against the importing file's directory", () => {
    const files = [
      file("src/routes/pay.ts", [add(`import { record } from "../db/records";`)]),
      file("src/db/records.ts", [ctx(`export const record = {};`)]),
    ];
    expect(regexImportEdges(files)).toEqual([["src/routes/pay.ts", "src/db/records.ts"]]);
  });

  it("resolves /index variants", () => {
    const files = [
      file("src/app.ts", [add(`import { store } from "./store";`)]),
      file("src/store/index.ts", [ctx(`export const store = {};`)]),
    ];
    expect(regexImportEdges(files)).toEqual([["src/app.ts", "src/store/index.ts"]]);
  });

  it("resolves exact specifiers with extensions (css, json)", () => {
    const files = [
      file("src/ui/card.tsx", [add(`import "./card.module.css";`)]),
      file("src/ui/card.module.css", [add(`.card { color: red; }`)]),
    ];
    expect(regexImportEdges(files)).toEqual([["src/ui/card.tsx", "src/ui/card.module.css"]]);
  });
});

describe("regexImportEdges — other languages", () => {
  it("detects python relative `from .mod import x`", () => {
    const files = [
      file("pkg/mod.py", [add(`from .utils import helpers`)]),
      file("pkg/utils.py", [ctx(`def helpers(): pass`)]),
    ];
    expect(regexImportEdges(files)).toEqual([["pkg/mod.py", "pkg/utils.py"]]);
  });

  it("detects python parent-relative `from ..pkg.mod import x`", () => {
    const files = [
      file("app/routes/view.py", [add(`from ..core.engine import run`)]),
      file("app/core/engine.py", [ctx(`def run(): pass`)]),
    ];
    expect(regexImportEdges(files)).toEqual([["app/routes/view.py", "app/core/engine.py"]]);
  });

  it("detects C quote-includes relative to the file", () => {
    const files = [
      file("src/main.c", [add(`#include "util/helper.h"`)]),
      file("src/util/helper.h", [ctx(`#pragma once`)]),
    ];
    expect(regexImportEdges(files)).toEqual([["src/main.c", "src/util/helper.h"]]);
  });
});

describe("regexImportEdges — filtering", () => {
  it("ignores non-relative specifiers", () => {
    const files = [
      file("src/a.ts", [
        add(`import express from "express";`),
        add(`import path from "node:path";`),
        add(`const _ = require("lodash");`),
      ]),
      file("pkg/mod.py", [add(`from os import path`), add(`import sys`)]),
      file("src/main.c", [add(`#include <vector>`)]),
    ];
    expect(regexImportEdges(files)).toEqual([]);
  });

  it("emits edges only when both endpoints are in the changed set", () => {
    const files = [
      file("src/a.ts", [add(`import { b } from "./b";`), add(`import { gone } from "./gone";`)]),
      file("src/b.ts", [ctx(`export const b = 1;`)]),
    ];
    // "./gone" resolves to src/gone.ts, which is not in the diff.
    expect(regexImportEdges(files)).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("skips self-edges and dedupes repeated imports", () => {
    const files = [
      file("pkg/mod.py", [add(`from .mod import itself`), add(`from .sibling import x`)]),
      file("pkg/sibling.py", [ctx(`x = 1`)]),
      file("src/a.ts", [add(`import { b } from "./b";`), add(`import { b as b2 } from "./b";`)]),
      file("src/b.ts", [ctx(`export const b = 1;`)]),
    ];
    const edges = regexImportEdges(files);
    expect(edges).toContainEqual(["pkg/mod.py", "pkg/sibling.py"]);
    expect(edges.filter(([a, b]) => a === b)).toEqual([]);
    expect(edges.filter(([a]) => a === "src/a.ts")).toHaveLength(1);
  });

  it("also reads context and deleted lines as relation evidence", () => {
    const files = [
      file("src/a.ts", [ctx(`import { b } from "./b";`)]),
      file("src/b.ts", [ctx(`export const b = 1;`)]),
      file("src/c.ts", [{ type: "del", content: `import { d } from "./d";` }]),
      file("src/d.ts", [ctx(`export const d = 1;`)]),
    ];
    const edges = regexImportEdges(files);
    expect(edges).toContainEqual(["src/a.ts", "src/b.ts"]);
    expect(edges).toContainEqual(["src/c.ts", "src/d.ts"]);
  });
});
