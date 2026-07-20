import { describe, expect, it } from "vitest";
import { loadAstProject } from "../../../src/ast/project.js";
import { evaluateAstMatchers } from "../../../src/ast/matchers.js";
import type { AstMatcher } from "../../../src/types.js";
import { WEAK_HASH_MD5, WEAK_HASH_SHA256 } from "../../fixtures/rules/snippets.js";

async function handleFor(path: string, content: string) {
  const handle = await loadAstProject([{ path, content }]);
  if (handle === null) throw new Error("ts-morph failed to load in test");
  return handle;
}

describe("evaluateAstMatchers — CallExpression", () => {
  const weakHash: AstMatcher = {
    kind: "CallExpression",
    callee: "crypto\\.createHash",
    argsRegex: ["md5", "sha1"],
  };

  it("fires on crypto.createHash(\"md5\") inside an added range", async () => {
    const handle = await handleFor("src/tokens.ts", WEAK_HASH_MD5);
    const result = evaluateAstMatchers(handle, "src/tokens.ts", [weakHash], "added", [[1, 5]]);
    expect(result.matched).toBe(true);
    expect(result.line).toBe(4);
    expect(result.evidence).toContain('crypto.createHash("md5")');
  });

  it("does not fire on crypto.createHash(\"sha256\") (argsRegex gate)", async () => {
    const handle = await handleFor("src/tokens.ts", WEAK_HASH_SHA256);
    const result = evaluateAstMatchers(handle, "src/tokens.ts", [weakHash], "added", [[1, 5]]);
    expect(result.matched).toBe(false);
  });

  it("does not fire when the matched node lies outside every range", async () => {
    const handle = await handleFor("src/tokens.ts", WEAK_HASH_MD5);
    const result = evaluateAstMatchers(handle, "src/tokens.ts", [weakHash], "added", [[1, 2]]);
    expect(result.matched).toBe(false);
  });

  it("matches the full callee text (bcrypt.compareSync) without argsRegex", async () => {
    const source = `import bcrypt from "bcrypt";\nexport const ok = bcrypt.compareSync(a, b);\n`;
    const handle = await handleFor("src/session.ts", source);
    const matcher: AstMatcher = { kind: "CallExpression", callee: "compareSync|bcrypt\\.compare" };
    const result = evaluateAstMatchers(handle, "src/session.ts", [matcher], "removed", [[2, 2]]);
    expect(result.matched).toBe(true);
    expect(result.line).toBe(2);
    expect(result.evidence).toContain("bcrypt.compareSync");
  });

  it("does not fire when only the args match but the callee does not", async () => {
    const source = `export const h = hash.update("md5");\n`;
    const handle = await handleFor("src/h.ts", source);
    const result = evaluateAstMatchers(handle, "src/h.ts", [
      { kind: "CallExpression", callee: "crypto\\.createHash", argsRegex: ["md5"] },
    ], "added", [[1, 1]]);
    expect(result.matched).toBe(false);
  });
});

describe("evaluateAstMatchers — NewExpression", () => {
  it("fires on new RegExp(userInput)", async () => {
    const source = `export function toRegex(input: string) {\n  return new RegExp(input);\n}\n`;
    const handle = await handleFor("src/re.ts", source);
    const result = evaluateAstMatchers(handle, "src/re.ts", [
      { kind: "NewExpression", callee: "^RegExp$" },
    ], "added", [[1, 3]]);
    expect(result.matched).toBe(true);
    expect(result.line).toBe(2);
    expect(result.evidence).toContain("new RegExp(input)");
  });

  it("does not fire for other constructors", async () => {
    const source = `export const d = new Date();\n`;
    const handle = await handleFor("src/d.ts", source);
    const result = evaluateAstMatchers(handle, "src/d.ts", [
      { kind: "NewExpression", callee: "^RegExp$" },
    ], "added", [[1, 1]]);
    expect(result.matched).toBe(false);
  });
});

describe("evaluateAstMatchers — StringAssignment", () => {
  const matcher: AstMatcher = {
    kind: "StringAssignment",
    nameRegex: "(?i)(api[_-]?key|secret|password)",
    valueRegex: "[A-Za-z0-9-]{8,}",
  };

  it("fires on const apiKey = \"...\" declarations", async () => {
    const source = `const apiKey = "sk-live-abcdef123";\nexport const x = 1;\n`;
    const handle = await handleFor("src/keys.ts", source);
    const result = evaluateAstMatchers(handle, "src/keys.ts", [matcher], "added", [[1, 2]]);
    expect(result.matched).toBe(true);
    expect(result.line).toBe(1);
    expect(result.evidence).toContain("apiKey");
  });

  it("fires on assignment expressions (config.password = \"...\")", async () => {
    const source = `export function wire(config: Record<string, string>) {\n  config.password = "hunter2-hunter2";\n}\n`;
    const handle = await handleFor("src/wire.ts", source);
    const result = evaluateAstMatchers(handle, "src/wire.ts", [matcher], "added", [[1, 3]]);
    expect(result.matched).toBe(true);
    expect(result.line).toBe(2);
  });

  it("does not fire when the name matches but the value is not a matching literal", async () => {
    const source = `const apiKey = process.env.API_KEY ?? "";\n`;
    const handle = await handleFor("src/keys.ts", source);
    const result = evaluateAstMatchers(handle, "src/keys.ts", [matcher], "added", [[1, 1]]);
    expect(result.matched).toBe(false);
  });
});

describe("evaluateAstMatchers — ImportFrom", () => {
  it("fires on import ... from \"child_process\"", async () => {
    const source = `import { exec } from "child_process";\nimport path from "node:path";\nexport const e = exec;\n`;
    const handle = await handleFor("src/proc.ts", source);
    const result = evaluateAstMatchers(handle, "src/proc.ts", [
      { kind: "ImportFrom", moduleRegex: "^child_process$" },
    ], "added", [[1, 3]]);
    expect(result.matched).toBe(true);
    expect(result.line).toBe(1);
    expect(result.evidence).toContain("child_process");
  });

  it("does not fire for other modules", async () => {
    const source = `import path from "node:path";\nexport const p = path;\n`;
    const handle = await handleFor("src/p.ts", source);
    const result = evaluateAstMatchers(handle, "src/p.ts", [
      { kind: "ImportFrom", moduleRegex: "^child_process$" },
    ], "added", [[1, 2]]);
    expect(result.matched).toBe(false);
  });
});

describe("evaluateAstMatchers — general", () => {
  it("returns { matched: false } for files not loaded in the project", async () => {
    const handle = await handleFor("src/a.ts", "export const a = 1;\n");
    const result = evaluateAstMatchers(handle, "src/other.ts", [
      { kind: "CallExpression", callee: ".*" },
    ], "added", [[1, 100]]);
    expect(result.matched).toBe(false);
  });

  it("returns { matched: false } for empty matchers or empty ranges", async () => {
    const handle = await handleFor("src/a.ts", "foo();\n");
    expect(evaluateAstMatchers(handle, "src/a.ts", [], "added", [[1, 1]]).matched).toBe(false);
    expect(
      evaluateAstMatchers(handle, "src/a.ts", [{ kind: "CallExpression", callee: "foo" }], "added", [])
        .matched,
    ).toBe(false);
  });

  it("matches against an old-file (HEAD) handle with old-file ranges for removed code", async () => {
    const oldSource = `import bcrypt from "bcrypt";\nexport function verify(p: string, h: string) {\n  return bcrypt.compareSync(p, h);\n}\n`;
    const oldHandle = await handleFor("src/session.ts", oldSource);
    const result = evaluateAstMatchers(
      oldHandle,
      "src/session.ts",
      [{ kind: "CallExpression", callee: "compareSync|bcrypt\\.compare" }],
      "removed",
      [[3, 3]],
    );
    expect(result.matched).toBe(true);
    expect(result.line).toBe(3);
  });
});
