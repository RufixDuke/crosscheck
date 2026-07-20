/**
 * Token budgeting & cluster inclusion order (§11.1, §13.3):
 *
 *   "Order of inclusion: ▲ clusters first, then ●, then ■, each truncated to
 *    its per-cluster cap (6,000 est. tokens) by keeping hunk heads and
 *    rule-evidence lines. Clusters that don't fit are listed... Never
 *    silently drop."
 *
 * This is the single planning function both `summarizeClusters()` (network)
 * and `buildDryRunPrompts()` (`--show-prompt`, no network) call, so the
 * dry-run preview can never diverge from what a real run would send.
 */
import { redact, type RedactedContext, type RedactOptions } from "../redact/index.js";
import type { Cluster, Finding, Severity } from "../types.js";
import { buildClusterRawText, findingsForCluster } from "./context.js";
import { estimateTokens } from "./estimate.js";

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const CHARS_PER_TOKEN = 4;

export interface ClusterPlanEntry {
  cluster: Cluster;
  redacted: RedactedContext;
  estimatedTokens: number;
  truncated: boolean;
}

export interface ClusterPlanSkip {
  clusterLabel: string;
  reason: string;
}

export interface ClusterPlan {
  included: ClusterPlanEntry[];
  skipped: ClusterPlanSkip[];
  totalEstimatedTokens: number;
}

export interface PlanClustersOptions {
  clusters: Cluster[];
  findings: Finding[];
  maxTokensPerReview: number;
  maxTokensPerCluster: number;
  redactOptions?: RedactOptions;
}

/** Stable ▲ → ● → ■ ordering, then largest cluster first within a tier
 * (mirrors the rule engine's own cluster ordering, §7.1 step 9). */
function byRiskOrder(clusters: Cluster[]): Cluster[] {
  return [...clusters].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.added + b.removed - (a.added + a.removed);
  });
}

export function planClusters(opts: PlanClustersOptions): ClusterPlan {
  const ordered = byRiskOrder(opts.clusters);
  const included: ClusterPlanEntry[] = [];
  const skipped: ClusterPlanSkip[] = [];
  let remaining = opts.maxTokensPerReview;

  for (const cluster of ordered) {
    const findings = findingsForCluster(cluster, opts.findings);
    const maxChars = opts.maxTokensPerCluster * CHARS_PER_TOKEN;
    const raw = buildClusterRawText(cluster, { maxChars, findings });
    const redacted = redact(raw.text, opts.redactOptions);
    const estimatedTokens = estimateTokens(redacted.text);

    if (estimatedTokens > remaining) {
      skipped.push({ clusterLabel: cluster.label, reason: "not summarized (token budget)" });
      continue;
    }

    included.push({ cluster, redacted, estimatedTokens, truncated: raw.truncated });
    remaining -= estimatedTokens;
  }

  const totalEstimatedTokens = included.reduce((sum, entry) => sum + entry.estimatedTokens, 0);
  return { included, skipped, totalEstimatedTokens };
}
