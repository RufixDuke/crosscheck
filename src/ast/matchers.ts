/**
 * AST matcher evaluation (§7.3) — the four matcher kinds, evaluated against a
 * source file already loaded in an AstProjectHandle.
 *
 * A matcher fires when the matched node's 1-based start line falls within one
 * of the given line ranges. For `target: "added"` the ranges are new-file
 * line ranges of the added hunks evaluated against the current project; for
 * `target: "removed"` the caller passes ranges in the OLD file and a handle
 * built from HEAD contents (§7.1 step 3) — matching logic itself is identical,
 * so `target` is documentary here.
 *
 * ts-morph is intentionally NOT imported at runtime in this module: it is
 * heavy (~9 MB) and must stay lazy (§13.2). Nodes are discriminated via
 * `getKindName()`, which needs no runtime import; node types are type-only
 * imports, erased at compile time. Matcher regexes are compiled once per
 * matcher object (WeakMap cache) — built-in matchers are module constants, so
 * they compile once per process.
 */
import type {
  BinaryExpression,
  CallExpression,
  NewExpression,
  SourceFile,
  StringLiteral,
  VariableDeclaration,
} from "ts-morph";
import type { AstProjectHandle } from "./types.js";
import type { AstMatcher } from "../types.js";
import { clipEvidence, compileRegex } from "../rules/regex.js";

export interface AstMatchResult {
  matched: boolean;
  line?: number;
  evidence?: string;
}

type CompiledAstMatcher =
  | { kind: "CallExpression"; callee: RegExp; argsRegex: RegExp[] }
  | { kind: "NewExpression"; callee: RegExp }
  | { kind: "StringAssignment"; nameRegex: RegExp; valueRegex: RegExp }
  | { kind: "ImportFrom"; moduleRegex: RegExp };

const compiledCache = new WeakMap<AstMatcher, CompiledAstMatcher>();

function compileMatcher(matcher: AstMatcher): CompiledAstMatcher {
  const cached = compiledCache.get(matcher);
  if (cached !== undefined) return cached;
  let compiled: CompiledAstMatcher;
  switch (matcher.kind) {
    case "CallExpression":
      compiled = {
        kind: "CallExpression",
        callee: compileRegex(matcher.callee),
        argsRegex: (matcher.argsRegex ?? []).map(compileRegex),
      };
      break;
    case "NewExpression":
      compiled = { kind: "NewExpression", callee: compileRegex(matcher.callee) };
      break;
    case "StringAssignment":
      compiled = {
        kind: "StringAssignment",
        nameRegex: compileRegex(matcher.nameRegex),
        valueRegex: compileRegex(matcher.valueRegex),
      };
      break;
    case "ImportFrom":
      compiled = { kind: "ImportFrom", moduleRegex: compileRegex(matcher.moduleRegex) };
      break;
  }
  compiledCache.set(matcher, compiled);
  return compiled;
}

function inRanges(line: number, lineRanges: Array<readonly [number, number]>): boolean {
  return lineRanges.some(([start, end]) => line >= start && line <= end);
}

interface NodeHit {
  line: number;
  text: string;
}

/** All CallExpression/NewExpression-style hits for callee+args matchers. */
function callLikeHits(
  sf: SourceFile,
  kindName: "CallExpression" | "NewExpression",
  callee: RegExp,
  argsRegex: RegExp[],
): NodeHit[] {
  const hits: NodeHit[] = [];
  for (const descendant of sf.getDescendants()) {
    if (descendant.getKindName() !== kindName) continue;
    const node = descendant as CallExpression | NewExpression;
    const calleeText = node.getExpression().getText();
    if (!callee.test(calleeText)) continue;
    if (argsRegex.length > 0) {
      const argTexts = node.getArguments().map((arg) => arg.getText());
      const anyArgMatches = argsRegex.some((re) => argTexts.some((text) => re.test(text)));
      if (!anyArgMatches) continue;
    }
    hits.push({ line: node.getStartLineNumber(), text: node.getText() });
  }
  return hits;
}

/** `const name = "literal"` and `name = "literal"` hits (§7.3 StringAssignment). */
function stringAssignmentHits(sf: SourceFile, nameRegex: RegExp, valueRegex: RegExp): NodeHit[] {
  const hits: NodeHit[] = [];
  const consider = (nameText: string, valueText: string, literalValue: string, line: number): void => {
    if (!nameRegex.test(nameText)) return;
    // The value regex is tested against both the raw literal (quotes included)
    // and its cooked value, so authors can anchor against either form.
    if (!valueRegex.test(valueText) && !valueRegex.test(literalValue)) return;
    hits.push({ line, text: `${nameText} = ${valueText}` });
  };

  for (const descendant of sf.getDescendants()) {
    const kindName = descendant.getKindName();
    if (kindName === "VariableDeclaration") {
      const decl = descendant as VariableDeclaration;
      const init = decl.getInitializer();
      if (init === undefined) continue;
      const initKind = init.getKindName();
      if (initKind !== "StringLiteral" && initKind !== "NoSubstitutionTemplateLiteral") continue;
      consider(
        decl.getName(),
        init.getText(),
        (init as StringLiteral).getLiteralValue(),
        decl.getStartLineNumber(),
      );
    } else if (kindName === "BinaryExpression") {
      const expr = descendant as BinaryExpression;
      if (expr.getOperatorToken().getText() !== "=") continue;
      const right = expr.getRight();
      const rightKind = right.getKindName();
      if (rightKind !== "StringLiteral" && rightKind !== "NoSubstitutionTemplateLiteral") continue;
      consider(
        expr.getLeft().getText(),
        right.getText(),
        (right as StringLiteral).getLiteralValue(),
        expr.getStartLineNumber(),
      );
    }
  }
  return hits;
}

/** `import ... from "module"` hits (§7.3 ImportFrom). */
function importFromHits(sf: SourceFile, moduleRegex: RegExp): NodeHit[] {
  const hits: NodeHit[] = [];
  for (const decl of sf.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    if (!moduleRegex.test(specifier)) continue;
    hits.push({ line: decl.getStartLineNumber(), text: decl.getText() });
  }
  return hits;
}

function hitsForMatcher(sf: SourceFile, matcher: AstMatcher): NodeHit[] {
  const compiled = compileMatcher(matcher);
  switch (compiled.kind) {
    case "CallExpression":
      return callLikeHits(sf, "CallExpression", compiled.callee, compiled.argsRegex);
    case "NewExpression":
      return callLikeHits(sf, "NewExpression", compiled.callee, []);
    case "StringAssignment":
      return stringAssignmentHits(sf, compiled.nameRegex, compiled.valueRegex);
    case "ImportFrom":
      return importFromHits(sf, compiled.moduleRegex);
  }
}

/**
 * Evaluate AST matchers against one loaded file. Returns the first match
 * (matchers in declaration order, nodes in source order) with its 1-based
 * line and trimmed evidence text; `{ matched: false }` when the file is not
 * in the project or nothing matches inside the ranges.
 */
export function evaluateAstMatchers(
  handle: AstProjectHandle,
  filePath: string,
  matchers: AstMatcher[],
  target: "added" | "removed",
  lineRanges: Array<readonly [number, number]>,
): AstMatchResult {
  // `target` selects which side of the diff the caller is inspecting; the
  // caller encodes it in the choice of handle + ranges (see module doc).
  void target;
  if (matchers.length === 0 || lineRanges.length === 0) return { matched: false };
  const sf = handle.getSourceFile(filePath);
  if (sf === undefined) return { matched: false };

  for (const matcher of matchers) {
    for (const hit of hitsForMatcher(sf, matcher)) {
      if (!inRanges(hit.line, lineRanges)) continue;
      return { matched: true, line: hit.line, evidence: clipEvidence(hit.text) };
    }
  }
  return { matched: false };
}
