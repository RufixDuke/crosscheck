/**
 * Shared LLM-layer types (§5.9, §9.4). Kept in their own module so both
 * `src/llm/index.ts` (the orchestrator) and `src/llm/providers/*.ts` (the
 * adapters) can import them without a circular dependency.
 */
import type { RedactedContext } from "../redact/index.js";
import type { LLMProviderName } from "../types.js";

/**
 * What one cluster's summarization request needs. `redacted` can only ever
 * be produced by `redact()` (§10.2) — there is no field here, or anywhere in
 * this interface, through which raw hunk text could reach a provider.
 */
export interface SummaryRequest {
  clusterLabel: string;
  redacted: RedactedContext;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface SummaryResult {
  status: "ok" | "unavailable";
  summary?: string;
  doubleCheck?: string[];
  tokensIn?: number;
  tokensOut?: number;
  /** Present when status !== "ok" (§11.6). */
  reason?: string;
}

/** One adapter per provider (§5.9) — raw `fetch`, no vendor SDKs. */
export interface LLMProvider {
  name: LLMProviderName;
  summarize(input: SummaryRequest): Promise<SummaryResult>;
}
