/**
 * §13.3: "Cost per model lives in a small built-in price table... unknown
 * model → cost shows as `unknown` and `maxCostUsdPerReview` check is skipped
 * with a warning." This is that table.
 *
 * Prices are USD per 1,000 tokens and are necessarily a snapshot — they will
 * drift as providers change pricing. Treat them as "rough estimate" (as the
 * §9.4 UI copy itself says), never as a billing source of truth. Update at
 * release time; an unknown model is handled gracefully, never fatally.
 */

export interface ModelPrice {
  inputPer1k: number;
  outputPer1k: number;
}

export const MODEL_PRICES_USD: Record<string, ModelPrice> = {
  // Anthropic
  "claude-sonnet-4-5": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-haiku-4-5": { inputPer1k: 0.0008, outputPer1k: 0.004 },
  "claude-opus-4-5": { inputPer1k: 0.015, outputPer1k: 0.075 },
  // OpenAI
  "gpt-5-mini": { inputPer1k: 0.00025, outputPer1k: 0.002 },
  "gpt-5.1": { inputPer1k: 0.002, outputPer1k: 0.008 },
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  // OpenRouter — the budget-friendly path (§5.9); slugs as OpenRouter names them
  "deepseek/deepseek-chat": { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  "qwen/qwen-2.5-72b-instruct": { inputPer1k: 0.00035, outputPer1k: 0.0004 },
};

/** `null` means "unknown model" (§13.3) — callers must show `unknown`, not `$0`. */
export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number | null {
  const price = MODEL_PRICES_USD[model];
  if (price === undefined) return null;
  return (tokensIn / 1000) * price.inputPer1k + (tokensOut / 1000) * price.outputPer1k;
}
