/**
 * OpenAI Chat Completions adapter (§5.9). Raw `fetch`, no vendor SDK. Reads
 * `OPENAI_API_KEY` from the environment at call time; never stored/logged.
 */
import { fetchJsonWithRetry } from "../http.js";
import { parseModelJson } from "../parse.js";
import { buildClusterPrompt } from "../prompt.js";
import type { LLMProvider, SummaryRequest, SummaryResult } from "../types.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function summarize(input: SummaryRequest): Promise<SummaryResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    return { status: "unavailable", reason: "missing OPENAI_API_KEY" };
  }

  const prompt = buildClusterPrompt(input.clusterLabel, input.redacted);
  const body = {
    model: input.model,
    temperature: input.temperature,
    max_tokens: input.maxOutputTokens,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  };

  const attempt = await fetchJsonWithRetry(
    OPENAI_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    input.timeoutMs,
  );

  if (!attempt.ok) {
    return { status: "unavailable", reason: attempt.reason ?? "request failed" };
  }

  const data = attempt.body as OpenAiResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseModelJson(text);
  if (parsed === null) {
    return { status: "unavailable", reason: "unparseable model response — ignored" };
  }

  const result: SummaryResult = {
    status: "ok",
    summary: parsed.summary,
    doubleCheck: parsed.doubleCheck,
  };
  if (data.usage?.prompt_tokens !== undefined) result.tokensIn = data.usage.prompt_tokens;
  if (data.usage?.completion_tokens !== undefined) result.tokensOut = data.usage.completion_tokens;
  return result;
}

export const openaiProvider: LLMProvider = { name: "openai", summarize };
