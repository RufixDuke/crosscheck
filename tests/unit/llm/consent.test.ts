/**
 * Consent gate tests (§10.4, §15.4.5). `needsConsent`/`recordConsent` are
 * pure — the interactive stdin prompt and disk persistence are CLI-layer
 * concerns out of scope here.
 */
import { describe, expect, it } from "vitest";
import { buildConsentPrompt, needsConsent, recordConsent } from "../../../src/llm/consent.js";
import { config } from "./factories.js";

describe("needsConsent (§10.4)", () => {
  it("is true before consent is recorded", () => {
    expect(needsConsent(config(), "anthropic")).toBe(true);
  });

  it("is false after recordConsent for that provider", () => {
    const consented = recordConsent(config(), "anthropic");
    expect(needsConsent(consented, "anthropic")).toBe(false);
  });

  it("is per-provider — consenting to anthropic does not consent openai", () => {
    const consented = recordConsent(config(), "anthropic");
    expect(needsConsent(consented, "openai")).toBe(true);
  });

  it("does not mutate the input config (pure function)", () => {
    const original = config();
    const snapshot = JSON.stringify(original);
    recordConsent(original, "anthropic");
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("model changes alone never require re-consent — consent is keyed by provider only", () => {
    const consented = recordConsent(config({ llm: { model: "claude-sonnet-4-5" } }), "anthropic");
    const afterModelChange = { ...consented, llm: { ...consented.llm, model: "claude-haiku-4-5" } };
    expect(needsConsent(afterModelChange, "anthropic")).toBe(false);
  });
});

describe("buildConsentPrompt (§9.4)", () => {
  it("renders the provider, model, cluster count, size estimate, and verification hatch", () => {
    const text = buildConsentPrompt({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      clusterLabels: ["auth/session rewrite", "paystack webhook handler"],
      estimatedTokens: 3900,
      estimatedCostUsd: 0.01,
      maxTokensPerReview: 48000,
      redactionCountPreview: 2,
    });
    expect(text).toContain("consent required (first run for anthropic)");
    expect(text).toContain("Provider:  anthropic");
    expect(text).toContain("Model: claude-sonnet-4-5");
    expect(text).toContain("2 clusters only");
    expect(text).toContain("~3900 input tokens");
    expect(text).toContain("$0.01");
    expect(text).toContain("budget cap 48000");
    expect(text).toContain(".env files, ignored files, or unredacted secrets");
    expect(text).toContain("--show-prompt");
    expect(text).toContain("Send redacted diff context to anthropic?");
  });

  it("shows 'unknown model' cost text instead of a dollar figure when cost is null", () => {
    const text = buildConsentPrompt({
      provider: "openrouter",
      model: "some/unpriced-model",
      clusterLabels: ["misc changes"],
      estimatedTokens: 500,
      estimatedCostUsd: null,
      maxTokensPerReview: 48000,
      redactionCountPreview: 0,
    });
    expect(text).toContain("unknown model");
    expect(text).not.toMatch(/\$\d/);
  });

  it("singularizes 'cluster' when only one is sent", () => {
    const text = buildConsentPrompt({
      provider: "openai",
      model: "gpt-5-mini",
      clusterLabels: ["only one"],
      estimatedTokens: 100,
      estimatedCostUsd: 0.001,
      maxTokensPerReview: 48000,
      redactionCountPreview: 0,
    });
    expect(text).toContain("1 cluster only");
    expect(text).not.toContain("1 clusters");
  });
});
