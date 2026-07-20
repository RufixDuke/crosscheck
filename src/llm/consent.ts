/**
 * Consent gate (§10.4, §9.4). This module only builds pure data/text — the
 * interactive stdin prompt, TTY detection, and persisting consent into
 * `crosscheck.config.json` / `.git/crosscheck/consent.json` are CLI-layer
 * concerns (out of scope here, §10.4). What lives here:
 *
 *   - `needsConsent()`      — pure check against the effective config
 *   - `buildConsentPrompt()` — the exact text block from §9.4
 *   - `recordConsent()`      — returns a NEW config with consent marked,
 *                              for the CLI layer to persist
 *
 * "Changing `llm.model` does not re-trigger consent; changing provider
 * does" (§10.4) — consent is keyed by provider only, never by model.
 */
import type { CrossCheckConfig, LLMProviderName } from "../types.js";

export function needsConsent(config: CrossCheckConfig, provider: LLMProviderName): boolean {
  return config.llm.consentGiven[provider] !== true;
}

/** Pure — returns a new config with consent recorded; does not touch disk. */
export function recordConsent(config: CrossCheckConfig, provider: LLMProviderName): CrossCheckConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      consentGiven: { ...config.llm.consentGiven, [provider]: true },
    },
  };
}

export interface ConsentPromptParams {
  provider: LLMProviderName;
  model: string;
  /** Cluster labels that will be sent, in send order (§9.4: "high-risk clusters only"). */
  clusterLabels: string[];
  estimatedTokens: number;
  /** `null` when the model isn't in the built-in price table (§13.3). */
  estimatedCostUsd: number | null;
  maxTokensPerReview: number;
  redactionCountPreview: number;
}

/** The exact consent block text from §9.4, minus the `y`/`N` the CLI reads interactively. */
export function buildConsentPrompt(params: ConsentPromptParams): string {
  const costText =
    params.estimatedCostUsd === null
      ? "cost: unknown model"
      : `est. $${params.estimatedCostUsd.toFixed(2)}`;
  const clusterCount = params.clusterLabels.length;
  const clusterWord = clusterCount === 1 ? "cluster" : "clusters";

  return [
    `CrossCheck LLM summary — consent required (first run for ${params.provider})`,
    "",
    `  Provider:  ${params.provider}   Model: ${params.model}`,
    `  Sends:     redacted hunks from ${clusterCount} ${clusterWord} only`,
    "             (secrets, env values, long string literals are replaced",
    "              before anything leaves this machine)",
    `  Size:      ~${params.estimatedTokens} input tokens (${costText}) · budget cap ${params.maxTokensPerReview}`,
    `  Redacts:   ${params.redactionCountPreview} value(s) in this preview`,
    "  Never:     .env files, ignored files, or unredacted secrets — by design.",
    "  Inspect:   re-run with --show-prompt to see the exact redacted prompt",
    "             (no network call, nothing sent)",
    "",
    `Send redacted diff context to ${params.provider}? [y/N]`,
  ].join("\n");
}
