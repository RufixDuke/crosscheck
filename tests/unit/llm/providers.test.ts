/**
 * Provider adapter tests (§11.6, §15.4.6, §15.5): mocked fetch responses for
 * success, 5xx, timeout/network error, and malformed JSON, for all three
 * adapters. Each adapter must degrade gracefully — never throw — per §11.6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redact } from "../../../src/redact/index.js";
import { anthropicProvider } from "../../../src/llm/providers/anthropic.js";
import { openaiProvider } from "../../../src/llm/providers/openai.js";
import { openrouterProvider } from "../../../src/llm/providers/openrouter.js";
import type { LLMProvider, SummaryRequest } from "../../../src/llm/types.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.unstubAllGlobals();
});

function baseRequest(): SummaryRequest {
  return {
    clusterLabel: "auth/session rewrite",
    redacted: redact("const x = 1;"),
    model: "test-model",
    maxOutputTokens: 400,
    temperature: 0.2,
    timeoutMs: 1000,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

const providers: Array<{
  name: string;
  provider: LLMProvider;
  successBody: unknown;
  malformedBody: unknown;
}> = [
  {
    name: "anthropic",
    provider: anthropicProvider,
    successBody: {
      content: [{ type: "text", text: '{"summary":"Did a thing.","doubleCheck":["check a","check b"]}' }],
      usage: { input_tokens: 120, output_tokens: 40 },
    },
    malformedBody: { content: [{ type: "text", text: "not json at all" }] },
  },
  {
    name: "openai",
    provider: openaiProvider,
    successBody: {
      choices: [{ message: { content: '{"summary":"Did a thing.","doubleCheck":["check a","check b"]}' } }],
      usage: { prompt_tokens: 90, completion_tokens: 30 },
    },
    malformedBody: { choices: [{ message: { content: "not json at all" } }] },
  },
  {
    name: "openrouter",
    provider: openrouterProvider,
    successBody: {
      choices: [{ message: { content: '{"summary":"Did a thing.","doubleCheck":["check a","check b"]}' } }],
      usage: { prompt_tokens: 60, completion_tokens: 20 },
    },
    malformedBody: { choices: [{ message: { content: "not json at all" } }] },
  },
];

for (const { name, provider, successBody, malformedBody } of providers) {
  describe(`${name} provider adapter`, () => {
    it("returns status ok with parsed summary + doubleCheck + token counts on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(200, successBody)),
      );
      const result = await provider.summarize(baseRequest());
      expect(result.status).toBe("ok");
      expect(result.summary).toBe("Did a thing.");
      expect(result.doubleCheck).toEqual(["check a", "check b"]);
      expect(result.tokensIn).toBeGreaterThan(0);
      expect(result.tokensOut).toBeGreaterThan(0);
    });

    it("degrades to unavailable on a 500 response (after the one retry, §11.6)", async () => {
      const fetchMock = vi.fn(async () => textResponse(500, "internal error"));
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.summarize(baseRequest());
      expect(result.status).toBe("unavailable");
      expect(result.reason).toMatch(/http 500/);
      expect(fetchMock).toHaveBeenCalledTimes(2); // one retry on 5xx
    });

    it("does not retry a 4xx (auth/config error) — not transient", async () => {
      const fetchMock = vi.fn(async () => textResponse(401, "unauthorized"));
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.summarize(baseRequest());
      expect(result.status).toBe("unavailable");
      expect(result.reason).toMatch(/http 401/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("degrades to unavailable on a network error, after one retry", async () => {
      const fetchMock = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.summarize(baseRequest());
      expect(result.status).toBe("unavailable");
      expect(result.reason).toMatch(/network error/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("degrades to unavailable on timeout, after one retry (§11.6)", async () => {
      const fetchMock = vi.fn(async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.summarize(baseRequest());
      expect(result.status).toBe("unavailable");
      expect(result.reason).toBe("timeout");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("degrades to unavailable on malformed/unparseable model output", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(200, malformedBody)),
      );
      const result = await provider.summarize(baseRequest());
      expect(result.status).toBe("unavailable");
      expect(result.reason).toBe("unparseable model response — ignored");
    });

    it("reports unavailable (never throws) when the API key env var is missing", async () => {
      for (const key of ENV_KEYS) delete process.env[key];
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.summarize(baseRequest());
      expect(result.status).toBe("unavailable");
      expect(result.reason).toMatch(/missing .+_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
}
