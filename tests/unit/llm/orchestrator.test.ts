/**
 * `summarizeClusters()` / `buildDryRunPrompts()` end-to-end tests.
 *
 * The centerpiece is §15.4.1's canary test: a mock provider that RECORDS the
 * exact request it receives (the redacted prompt), run through the full
 * `summarizeClusters()` path. Asserts zero canary substrings ever reached
 * the "provider" — this is the guarantee that gates CI (§10.3, §15.4).
 */
import { describe, expect, it } from "vitest";
import { buildDryRunPrompts, summarizeClusters } from "../../../src/llm/index.js";
import type { LLMProvider, SummaryRequest, SummaryResult } from "../../../src/llm/types.js";
import { add, cluster, config, file, hunk } from "./factories.js";

function recordingProvider(): { provider: LLMProvider; requests: SummaryRequest[] } {
  const requests: SummaryRequest[] = [];
  const provider: LLMProvider = {
    name: "anthropic",
    summarize: async (input: SummaryRequest): Promise<SummaryResult> => {
      requests.push(input);
      return { status: "ok", summary: "Did a thing.", doubleCheck: ["check x"], tokensIn: 10, tokensOut: 5 };
    },
  };
  return { provider, requests };
}

describe("summarizeClusters — canary suite gates CI (§15.4.1)", () => {
  it("never lets a canary secret reach the (mock) provider's request body", async () => {
    const canarySecret = "AKIAABCDEFGHIJKLMNOP";
    const canaryJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";

    const h = hunk("src/lib/paystack.ts", [
      add(`const awsKey = "${canarySecret}";`),
      add(`const sessionJwt = "${canaryJwt}";`),
    ]);
    const c = cluster([file("src/lib/paystack.ts", [h])], { severity: "high", label: "paystack integration" });

    const { provider, requests } = recordingProvider();
    const cfg = config({ llm: { provider: "anthropic", model: "claude-sonnet-4-5" } });

    const result = await summarizeClusters({ clusters: [c], findings: [], config: cfg, provider });

    expect(requests).toHaveLength(1);
    const sentText = requests[0]!.redacted.text;
    expect(sentText).not.toContain(canarySecret);
    expect(sentText).not.toContain(canaryJwt);
    expect(sentText).toContain("<SECRET:aws-access-key>");
    expect(sentText).toContain("<SECRET:jwt>");
    expect(result.redactions).toBeGreaterThanOrEqual(2);
    expect(result.summaries[0]?.status).toBe("ok");
  });

  it("buildDryRunPrompts (--show-prompt) exposes the identical redacted text with zero network calls", () => {
    const canarySecret = "sk_live_FAKEKEYNOTREAL12";
    const h = hunk("src/lib/paystack.ts", [add(`const secretKey = "${canarySecret}";`)]);
    const c = cluster([file("src/lib/paystack.ts", [h])], { severity: "high", label: "paystack integration" });
    const cfg = config({ llm: { provider: "anthropic", model: "claude-sonnet-4-5" } });

    const dryRun = buildDryRunPrompts({ clusters: [c], findings: [], config: cfg });

    expect(dryRun.prompts).toHaveLength(1);
    expect(dryRun.prompts[0]!.prompt.user).not.toContain(canarySecret);
    expect(dryRun.prompts[0]!.prompt.user).toContain("<SECRET:paystack-live-key>");
  });
});

describe("summarizeClusters — graceful degradation (§11.6)", () => {
  it("marks a failing cluster unavailable without affecting other clusters' summaries", async () => {
    const highHunk = hunk("high.ts", [add("const x = 1;")]);
    const mediumHunk = hunk("med.ts", [add("const y = 2;")]);
    const high = cluster([file("high.ts", [highHunk])], { severity: "high", label: "high risk" });
    const medium = cluster([file("med.ts", [mediumHunk])], { severity: "medium", label: "medium risk" });

    let call = 0;
    const provider: LLMProvider = {
      name: "anthropic",
      summarize: async (): Promise<SummaryResult> => {
        call += 1;
        if (call === 1) return { status: "ok", summary: "Did a thing.", doubleCheck: [], tokensIn: 5, tokensOut: 2 };
        return { status: "unavailable", reason: "http 500" };
      },
    };

    const cfg = config({ llm: { provider: "anthropic", model: "claude-sonnet-4-5" } });
    const result = await summarizeClusters({ clusters: [high, medium], findings: [], config: cfg, provider });

    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]?.status).toBe("ok"); // high risk went first
    expect(result.summaries[1]?.status).toBe("unavailable");
    expect(result.summaries[1]?.reason).toBe("http 500");
  });

  it("lists budget-skipped clusters with a reason rather than dropping them silently (§11.1)", async () => {
    const bigHunk = hunk("big.ts", [add("z".repeat(80))]);
    const big = cluster([file("big.ts", [bigHunk])], { severity: "high", label: "big" });
    const smallHunk = hunk("small.ts", [add("y".repeat(200))]);
    const small = cluster([file("small.ts", [smallHunk])], { severity: "low", label: "small" });

    const { provider } = recordingProvider();
    const cfg = config({
      llm: { provider: "anthropic", model: "claude-sonnet-4-5", maxTokensPerReview: 45 },
    });

    const result = await summarizeClusters({ clusters: [big, small], findings: [], config: cfg, provider });

    expect(result.summaries).toHaveLength(1);
    expect(result.notSummarized).toEqual([{ clusterLabel: "small", reason: "not summarized (token budget)" }]);
  });
});

describe("summarizeClusters — no-op when no provider is configured (§10.1)", () => {
  it("returns an empty result without invoking any provider", async () => {
    const c = cluster([file("a.ts", [hunk("a.ts", [add("x")])])], { severity: "high" });
    const { provider, requests } = recordingProvider();
    const result = await summarizeClusters({ clusters: [c], findings: [], config: config(), provider });
    expect(result).toEqual({ summaries: [], notSummarized: [], tokensIn: 0, tokensOut: 0, redactions: 0 });
    expect(requests).toHaveLength(0);
  });
});

describe("summarizeClusters — cost reporting (§13.3)", () => {
  it("computes an estimated cost for a known model", async () => {
    const c = cluster([file("a.ts", [hunk("a.ts", [add("const x = 1;")])])], { severity: "high" });
    const { provider } = recordingProvider();
    const cfg = config({ llm: { provider: "anthropic", model: "claude-sonnet-4-5" } });
    const result = await summarizeClusters({ clusters: [c], findings: [], config: cfg, provider });
    expect(result.costUsd).toBeDefined();
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("leaves cost undefined (not zero) for an unpriced model", async () => {
    const c = cluster([file("a.ts", [hunk("a.ts", [add("const x = 1;")])])], { severity: "high" });
    const { provider } = recordingProvider();
    const cfg = config({ llm: { provider: "openrouter", model: "some/unpriced-model" } });
    const result = await summarizeClusters({ clusters: [c], findings: [], config: cfg, provider });
    expect(result.costUsd).toBeUndefined();
  });
});
