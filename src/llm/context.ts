/**
 * Builds the raw (pre-redaction) per-cluster text that becomes the LLM
 * prompt body (§9.4, §11.1). This is the ONLY place that shape gets built —
 * both the real summarize path and `--show-prompt` call it, then both call
 * `redact()` on the result, so there is no divergent path (§10.3).
 *
 * Truncation policy (§11.1): "each truncated to its per-cluster cap...by
 * keeping hunk heads and rule-evidence lines." A hunk's "head" is its first
 * `headLinesPerHunk` changed (add/del) lines; any changed line whose content
 * matches a Finding's evidence for this cluster is kept regardless of
 * position, since that line is the reason the cluster is risky at all.
 */
import type { Cluster, DiffLine, Finding, Hunk } from "../types.js";

const DEFAULT_HEAD_LINES_PER_HUNK = 12;

export interface ClusterRawText {
  text: string;
  truncated: boolean;
}

export interface BuildClusterRawTextOptions {
  /** Character budget for this cluster (already-redacted text is always
   * shorter or equal in length to the raw text, so this is a safe over-cap). */
  maxChars: number;
  findings?: Finding[];
  headLinesPerHunk?: number;
}

/** Findings whose hunk belongs to this cluster (Finding has no clusterId —
 * matched via hunkHash membership, §7.1). */
export function findingsForCluster(cluster: Cluster, findings: Finding[]): Finding[] {
  const hashes = new Set(cluster.hunks.map((h) => h.hash));
  return findings.filter((f) => hashes.has(f.hunkHash));
}

function renderLine(line: DiffLine): string {
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return `${marker} ${line.content}`;
}

function renderHunk(hunk: Hunk, evidenceLines: Set<string>, headLinesPerHunk: number): string[] {
  const changed = hunk.lines.filter((l) => l.type !== "context");
  const kept: DiffLine[] = [];
  changed.forEach((line, index) => {
    if (index < headLinesPerHunk || evidenceLines.has(line.content.trim())) {
      kept.push(line);
    }
  });
  return kept.map(renderLine);
}

/** Build the raw (unredacted) prompt text for one cluster, hard-truncated to
 * `maxChars` if the kept content still exceeds it. */
export function buildClusterRawText(cluster: Cluster, opts: BuildClusterRawTextOptions): ClusterRawText {
  const headLinesPerHunk = opts.headLinesPerHunk ?? DEFAULT_HEAD_LINES_PER_HUNK;
  const evidenceLines = new Set((opts.findings ?? []).map((f) => f.evidence.trim()));

  const blocks: string[] = [];
  for (const file of cluster.files) {
    for (const hunk of file.hunks) {
      const rendered = renderHunk(hunk, evidenceLines, headLinesPerHunk);
      if (rendered.length === 0) continue;
      blocks.push([`// ${file.path}`, ...rendered].join("\n"));
    }
  }

  let text = blocks.join("\n\n");
  let truncated = false;
  if (text.length > opts.maxChars) {
    text = `${text.slice(0, Math.max(0, opts.maxChars))}\n… (truncated — token budget)`;
    truncated = true;
  }
  return { text, truncated };
}
