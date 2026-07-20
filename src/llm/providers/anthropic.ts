/**
 * Anthropic Messages API adapter (§5.9). Raw `fetch`, no vendor SDK. Reads
 * `ANTHROPIC_API_KEY` from the environment at call time; the key is never
 * stored, logged, or written to history (§10.1).
 */
import { fetchJsonWithRetry } from "../http.js";
import { parseModelJson } from "../parse.js";
import { buildClusterPrompt } from "../prompt.js";
import type { LLMProvider, SummaryRequest, SummaryResult } from "../types.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function summarize(input: SummaryRequest): Promise<SummaryResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    return { status: "unavailable", reason: "missing ANTHROPIC_API_KEY" };
  }

  const prompt = buildClusterPrompt(input.clusterLabel, input.redacted);
  const body = {
    model: input.model,
    max_tokens: input.maxOutputTokens,
    temperature: input.temperature,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  };

  const attempt = await fetchJsonWithRetry(
    ANTHROPIC_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    },
    input.timeoutMs,
  );

  if (!attempt.ok) {
    return { status: "unavailable", reason: attempt.reason ?? "request failed" };
  }

  const data = attempt.body as AnthropicResponse;
  const text = data.content?.find((block) => block.type === "text")?.text ?? "";
  const parsed = parseModelJson(text);
  if (parsed === null) {
    return { status: "unavailable", reason: "unparseable model response — ignored" };
  }

  const result: SummaryResult = {
    status: "ok",
    summary: parsed.summary,
    doubleCheck: parsed.doubleCheck,
  };
  if (data.usage?.input_tokens !== undefined) result.tokensIn = data.usage.input_tokens;
  if (data.usage?.output_tokens !== undefined) result.tokensOut = data.usage.output_tokens;
  return result;
}

export const anthropicProvider: LLMProvider = { name: "anthropic", summarize };
