/**
 * Token estimator + cost estimator tests (§5.9, §13.3, §15.4.7).
 */
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/llm/estimate.js";
import { estimateCostUsd } from "../../../src/llm/prices.js";

describe("estimateTokens — chars/4 heuristic (§5.9)", () => {
  it("estimates 1 token per 4 characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("estimateCostUsd — built-in price table (§13.3)", () => {
  it("computes cost from input/output token counts for a known model", () => {
    const cost = estimateCostUsd("claude-sonnet-4-5", 1000, 1000);
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.003 + 0.015, 6);
  });

  it("returns null (not zero) for an unknown model — §13.3: 'cost shows as unknown'", () => {
    expect(estimateCostUsd("totally-made-up-model-slug", 1000, 1000)).toBeNull();
  });

  it("scales linearly with token counts", () => {
    const small = estimateCostUsd("gpt-5-mini", 1000, 0)!;
    const large = estimateCostUsd("gpt-5-mini", 2000, 0)!;
    expect(large).toBeCloseTo(small * 2, 6);
  });
});
