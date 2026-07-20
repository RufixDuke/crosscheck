import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface FaqItem {
  q: string;
  a: ReactNode;
}

const ITEMS: FaqItem[] = [
  {
    q: "Does CrossCheck actually work offline?",
    a: (
      <p>
        Yes — offline is the default, not a fallback tier. With no <code>--llm</code> flag, the process opens zero
        sockets: the risk map, checklist, manual test suggestions, review history, and <code>--strict</code> gate
        all work without a network connection or any API key configured. See{" "}
        <Link to="/privacy">privacy &amp; security</Link>.
      </p>
    ),
  },
  {
    q: "Do I need an API key to use CrossCheck?",
    a: (
      <p>
        No. The heuristic rule engine is the primary product, not a fallback. An LLM key (Anthropic, OpenAI, or
        OpenRouter — bring your own) is only needed for the optional <code>--llm</code> two-sentence cluster
        summaries layered on top.
      </p>
    ),
  },
  {
    q: "What happens when a rule fires on something that's actually fine?",
    a: (
      <p>
        Dismiss it — <code>--ack</code> marks current findings as reviewed so they collapse on the next run (content
        hashed, so it survives rebases and amended commits). If a rule is noisy on your codebase generally, disable
        it or override its severity in <code>crosscheck.config.json</code> — see{" "}
        <Link to="/config">rules.disable / rules.severityOverrides</Link>. False-positive fatigue is treated as a
        rule-tuning bug, not user error; please open one.
      </p>
    ),
  },
  {
    q: "How much does --llm cost per review?",
    a: (
      <p>
        Every LLM run prints the estimated cost <em>before</em> sending anything, and a hard{" "}
        <code>maxCostUsdPerReview</code> ceiling (default $0.25) aborts the LLM pass — the heuristic report still
        renders — if the estimate exceeds it. OpenRouter models like DeepSeek/Qwen cost a fraction of frontier
        models if budget matters to you.
      </p>
    ),
  },
  {
    q: "How does 'you reviewed this hunk before' survive a rebase?",
    a: (
      <p>
        Hunks are keyed by a content hash (added/removed lines, whitespace-normalized) — not by commit SHA. Amending
        a commit or rebasing changes the SHA but not the hunk content, so dedup survives both.
      </p>
    ),
  },
  {
    q: "What do the exit codes mean?",
    a: (
      <p>
        <code>0</code> = review ran, nothing unacknowledged above the threshold. <code>1</code> = a{" "}
        <code>--strict</code> gate failure (only possible with <code>--strict</code>). <code>2</code> = an
        operational error — the review didn't complete (bad range, invalid config, not a git repo). Full contract on
        the <Link to="/commands">commands page</Link>.
      </p>
    ),
  },
  {
    q: "Does it work in a monorepo?",
    a: (
      <p>
        Yes — use <code>--scope &lt;path&gt;</code> to restrict analysis to a subtree, and config discovery walks up
        to the nearest <code>crosscheck.config.json</code> relative to that scope.
      </p>
    ),
  },
  {
    q: "Does it support languages other than TypeScript/JavaScript?",
    a: (
      <p>
        Glob and regex rules apply to all text files — migrations, YAML, Dockerfiles, Python, Go, SQL, shell scripts
        are all first-class rule targets. AST-level matchers (the deepest analysis) are TS/JS-only in MVP via
        ts-morph; other languages get glob+regex-tier coverage, an honest, stated limitation.
      </p>
    ),
  },
  {
    q: "How is this different from CodeRabbit / Greptile / Bugbot?",
    a: (
      <p>
        Those are SaaS bots that review PRs after they're already open on GitHub/GitLab, priced per seat, aimed at
        teams reviewing each other's code. CrossCheck runs locally, before the push, for the moment a solo developer
        has no reviewer at all — free, offline-capable, and BYOK. See the comparison table on the{" "}
        <Link to="/">home page</Link>.
      </p>
    ),
  },
  {
    q: "What if sql.js (the history database) fails to load?",
    a: (
      <p>
        CrossCheck degrades to a no-history mode with a one-line notice — dedup and <code>crosscheck history</code>{" "}
        are unavailable, but the review itself is unaffected. History is a convenience, never a gate on the
        analysis.
      </p>
    ),
  },
  {
    q: "What if the LLM call fails or times out?",
    a: (
      <p>
        The heuristic report still renders in full; the summary section is marked <code>unavailable (reason)</code>,
        and the exit code is unaffected unless you passed <code>--require-llm</code>.
      </p>
    ),
  },
  {
    q: "\"Not a git repo\" or a merge-in-progress error — what now?",
    a: (
      <p>
        CrossCheck refuses to guess: exit 2 with a one-line actionable message rather than a stack trace. Resolve
        conflicts first if mid-merge, or run inside an actual git repository — <code>--stdin</code> is the one mode
        that works without a repo at all, reading a unified diff directly.
      </p>
    ),
  },
  {
    q: "Is CrossCheck free? Is there a paid tier coming?",
    a: (
      <p>
        Free and MIT-licensed, forever — no paid tier, no per-seat pricing, no monetization pivot, by design. This is
        a credibility and community play, not a SaaS launch.
      </p>
    ),
  },
];

export function Faq() {
  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">FAQ &amp; troubleshooting</p>
        <h1>Frequently asked questions</h1>
        <p className="lede">
          Didn't find your answer here? Open a discussion on{" "}
          <a href="https://github.com/RufixDuke/crosscheck">GitHub</a>.
        </p>
      </section>

      {ITEMS.map((item) => (
        <details className="faq" key={item.q}>
          <summary>{item.q}</summary>
          <div className="faq-answer">{item.a}</div>
        </details>
      ))}
    </>
  );
}
