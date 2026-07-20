/**
 * LLM orchestration (§5.9, §9.4, §11.1, §11.6, F6 in §8).
 *
 * Two entry points into the cluster-planning + prompt-construction path,
 * and only one of them ever touches the network:
 *
 *   - `summarizeClusters()` — the real `--llm` pass. Budgets, redacts, and
 *     calls the chosen provider adapter once per included cluster
 *     (high-risk first), degrading unavailable clusters gracefully.
 *   - `buildDryRunPrompts()` — `--show-prompt`/`--dry-run-llm` (§10.3
 *     "prove it"). Runs the exact same planning + redaction + prompt-build
 *     path, with zero network calls, so the preview can never lie about
 *     what a real run would send.
 *
 * Everything in this module except the provider adapters' `summarize()` is
 * pure and network-free (see `tests/unit/llm/no-network.test.ts`).
 */
import type { Cluster, CrossCheckConfig, Finding, LLMProviderName, LLMSummary, Severity } from "../types.js";
import { planClusters } from "./budget.js";
import { estimateCostUsd } from "./prices.js";
import { buildClusterPrompt, type ClusterPrompt } from "./prompt.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { openaiProvider } from "./providers/openai.js";
import { openrouterProvider } from "./providers/openrouter.js";
import type { LLMProvider, SummaryRequest } from "./types.js";

export type { LLMProvider, SummaryRequest, SummaryResult } from "./types.js";
export { buildConsentPrompt, needsConsent, recordConsent, type ConsentPromptParams } from "./consent.js";
export { estimateTokens } from "./estimate.js";
export { estimateCostUsd, MODEL_PRICES_USD } from "./prices.js";
export { buildClusterPrompt, buildSystemPrompt, buildUserPrompt, PROMPT_VERSION, type ClusterPrompt } from "./prompt.js";
export { planClusters, type ClusterPlan, type ClusterPlanEntry, type ClusterPlanSkip } from "./budget.js";
export { buildClusterRawText, findingsForCluster } from "./context.js";

/** Default model per provider when `config.llm.model` is null (§5.9). OpenRouter
 * has no sensible default — any slug is valid, so config must set one. */
export const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5-mini",
  openrouter: "",
};

/** Output-token budget per cluster summary — not user-configurable (the
 * §12.2 config only ceilings *input* tokens); a fixed small cap keeps
 * summaries within the "≤2 sentences + ≤3 bullets" contract (§9.4). */
const MAX_OUTPUT_TOKENS = 400;

const BUILTIN_PROVIDERS: Record<LLMProviderName, LLMProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  openrouter: openrouterProvider,
};

export function getProvider(name: LLMProviderName): LLMProvider {
  return BUILTIN_PROVIDERS[name];
}

export interface NotSummarizedEntry {
  clusterLabel: string;
  reason: string;
}

export interface SummarizeClustersParams {
  clusters: Cluster[];
  findings: Finding[];
  config: CrossCheckConfig;
  /** Injectable for tests; defaults to the adapter for `config.llm.provider`. */
  provider?: LLMProvider;
}

export interface SummarizeClustersResult {
  summaries: LLMSummary[];
  notSummarized: NotSummarizedEntry[];
  tokensIn: number;
  tokensOut: number;
  /** `undefined` when the model isn't in the built-in price table (§13.3). */
  costUsd?: number;
  redactions: number;
}

function planFor(params: {
  clusters: Cluster[];
  findings: Finding[];
  config: CrossCheckConfig;
}) {
  return planClusters({
    clusters: params.clusters,
    findings: params.findings,
    maxTokensPerReview: params.config.llm.maxTokensPerReview,
    maxTokensPerCluster: params.config.llm.maxTokensPerCluster,
    redactOptions: { anonymizePaths: params.config.llm.anonymizePaths },
  });
}

/**
 * The real `--llm` pass (§9.4, §11.6). Requests are per-cluster, high-risk
 * first (§11.1 chunking rule) — never "the whole diff in one prompt".
 * Provider/network failures degrade that one cluster to
 * `status: "unavailable"`; the rest of the pass, and the heuristic report,
 * are unaffected.
 *
 * If `config.llm.provider` is null, this returns an empty, no-op result
 * without ever constructing a provider or touching `fetch` — the
 * heuristic-only path never has an LLM section to begin with.
 */
export async function summarizeClusters(params: SummarizeClustersParams): Promise<SummarizeClustersResult> {
  const { config } = params;
  const providerName = config.llm.provider;
  if (providerName === null) {
    return { summaries: [], notSummarized: [], tokensIn: 0, tokensOut: 0, redactions: 0 };
  }

  const provider = params.provider ?? getProvider(providerName);
  const model = config.llm.model ?? DEFAULT_MODELS[providerName];
  const plan = planFor(params);

  const summaries: LLMSummary[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let redactions = 0;

  for (const entry of plan.included) {
    redactions += entry.redacted.redactionCount;
    const request: SummaryRequest = {
      clusterLabel: entry.cluster.label,
      redacted: entry.redacted,
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
    };

    const result = await provider.summarize(request);

    if (result.status === "ok") {
      const inTokens = result.tokensIn ?? entry.estimatedTokens;
      const outTokens = result.tokensOut ?? 0;
      tokensIn += inTokens;
      tokensOut += outTokens;
      summaries.push({
        clusterId: entry.cluster.id,
        clusterLabel: entry.cluster.label,
        severity: entry.cluster.severity,
        status: "ok",
        summary: result.summary,
        doubleCheck: result.doubleCheck,
        tokensIn: inTokens,
        tokensOut: outTokens,
      });
    } else {
      // Graceful degradation (§11.6): heuristic checklist is unaffected;
      // this cluster just has no AI summary.
      summaries.push({
        clusterId: entry.cluster.id,
        clusterLabel: entry.cluster.label,
        severity: entry.cluster.severity,
        status: "unavailable",
        reason: result.reason ?? "unavailable",
      });
    }
  }

  const costUsd = estimateCostUsd(model, tokensIn, tokensOut);
  const output: SummarizeClustersResult = {
    summaries,
    notSummarized: plan.skipped,
    tokensIn,
    tokensOut,
    redactions,
  };
  if (costUsd !== null) output.costUsd = costUsd;
  return output;
}

export interface DryRunPromptEntry {
  clusterId: string;
  clusterLabel: string;
  severity: Severity;
  prompt: ClusterPrompt;
  redactionCount: number;
  redactionTypes: string[];
  estimatedTokens: number;
}

export interface DryRunResult {
  prompts: DryRunPromptEntry[];
  notSummarized: NotSummarizedEntry[];
  totalEstimatedTokens: number;
}

/**
 * `--show-prompt` / `--dry-run-llm` (§9, §10.3): builds the exact redacted
 * per-cluster prompts a real run would send, with ZERO network calls. Reuses
 * `planFor()` — the identical planning/redaction path `summarizeClusters()`
 * uses — so this can never diverge from reality (§10.3's "verification"
 * guarantee would be meaningless with a separate code path).
 */
export function buildDryRunPrompts(params: {
  clusters: Cluster[];
  findings: Finding[];
  config: CrossCheckConfig;
}): DryRunResult {
  const plan = planFor(params);

  const prompts: DryRunPromptEntry[] = plan.included.map((entry) => ({
    clusterId: entry.cluster.id,
    clusterLabel: entry.cluster.label,
    severity: entry.cluster.severity,
    prompt: buildClusterPrompt(entry.cluster.label, entry.redacted),
    redactionCount: entry.redacted.redactionCount,
    redactionTypes: entry.redacted.redactionTypes,
    estimatedTokens: entry.estimatedTokens,
  }));

  return { prompts, notSummarized: plan.skipped, totalEstimatedTokens: plan.totalEstimatedTokens };
}
