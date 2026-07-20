/**
 * §15.4.4: "heuristic-mode runs execute with fetch/net mocked to throw; any
 * attempted connection fails the test." `summarize()` (inside each provider
 * adapter) is the ONLY thing in `src/llm` allowed to call `fetch` — this
 * test stubs global fetch to throw and proves that redaction, prompt
 * building, budgeting, and consent all work fine without ever touching it,
 * and that `summarizeClusters()` with no provider configured is a true
 * no-op (backs F7's "zero network calls in default mode" claim, §10.1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redact } from "../../../src/redact/index.js";
import {
  buildConsentPrompt,
  buildDryRunPrompts,
  needsConsent,
  planClusters,
  recordConsent,
  summarizeClusters,
} from "../../../src/llm/index.js";
import { buildClusterPrompt, buildSystemPrompt, buildUserPrompt } from "../../../src/llm/prompt.js";
import { estimateTokens } from "../../../src/llm/estimate.js";
import { estimateCostUsd } from "../../../src/llm/prices.js";
import { add, cluster, config, file, finding, hunk } from "./factories.js";

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(() => {
    throw new Error("network access attempted in a test that must be network-free");
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sampleCluster() {
  return cluster([file("src/a.ts", [hunk("src/a.ts", [add('const secretKey = "sk_live_FAKEKEYNOTREAL12";')])])], {
    severity: "high",
  });
}

describe("no-network guarantee (§15.4.4, F7)", () => {
  it("redact() never touches fetch", () => {
    const result = redact('const k = "sk_live_FAKEKEYNOTREAL12";');
    expect(result.text).toContain("<SECRET:paystack-live-key>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prompt building never touches fetch", () => {
    const redacted = redact("const x = 1;");
    const prompt = buildClusterPrompt("cluster label", redacted);
    expect(prompt.system).toEqual(buildSystemPrompt());
    expect(prompt.user).toEqual(buildUserPrompt("cluster label", redacted.text));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token estimation and cost estimation never touch fetch", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateCostUsd("claude-sonnet-4-5", 1000, 200)).not.toBeNull();
    expect(estimateCostUsd("some-unknown-model", 1000, 200)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consent functions never touch fetch", () => {
    const cfg = config();
    expect(needsConsent(cfg, "anthropic")).toBe(true);
    const consented = recordConsent(cfg, "anthropic");
    expect(needsConsent(consented, "anthropic")).toBe(false);
    const prompt = buildConsentPrompt({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      clusterLabels: ["auth/session rewrite"],
      estimatedTokens: 1850,
      estimatedCostUsd: 0.01,
      maxTokensPerReview: 48000,
      redactionCountPreview: 2,
    });
    expect(prompt).toContain("anthropic");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("planClusters() (budgeting + redaction) never touches fetch", () => {
    const c = sampleCluster();
    const f = finding({ ruleId: "secrets/hardcoded-secret", hunkHash: c.hunks[0]!.hash });
    const plan = planClusters({
      clusters: [c],
      findings: [f],
      maxTokensPerReview: 48000,
      maxTokensPerCluster: 6000,
    });
    expect(plan.included).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buildDryRunPrompts() (--show-prompt) never touches fetch", () => {
    const c = sampleCluster();
    const result = buildDryRunPrompts({ clusters: [c], findings: [], config: config() });
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.redactionCount).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("summarizeClusters() with no provider configured is a true no-op — never touches fetch", async () => {
    const c = sampleCluster();
    const result = await summarizeClusters({ clusters: [c], findings: [], config: config() });
    expect(result).toEqual({ summaries: [], notSummarized: [], tokensIn: 0, tokensOut: 0, redactions: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
