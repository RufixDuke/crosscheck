import { Link } from "react-router-dom";
import { Terminal } from "../components/Terminal";
import { CodeBlock } from "../components/CodeBlock";

const FLAGS: { flag: string; default: string; meaning: string }[] = [
  { flag: "--staged", default: "(default when no range)", meaning: "Review git diff --cached" },
  { flag: "--worktree", default: "off", meaning: "Review unstaged working-tree diff" },
  { flag: "--stdin", default: "off", meaning: "Read a unified diff from stdin (no repo needed)" },
  { flag: "--llm", default: "off", meaning: "Add BYOK LLM cluster summaries" },
  { flag: "--require-llm", default: "off", meaning: "Exit 2 if the LLM pass cannot complete" },
  {
    flag: "--show-prompt",
    default: "off",
    meaning: "Print the exact redacted prompt(s) the LLM pass would send, then exit — no network call (alias --dry-run-llm)",
  },
  { flag: "--offline", default: "off", meaning: "Forbid all network use (errors if combined with --llm)" },
  { flag: "--strict", default: "off", meaning: "Exit 1 on unacknowledged findings ≥ strict.failOn" },
  { flag: "--fail-on <sev>", default: "high", meaning: "Override strict threshold: high | medium | low" },
  { flag: "--format <fmt>", default: "terminal", meaning: "terminal | markdown | json" },
  { flag: "--json", default: "off", meaning: "Shorthand for --format json" },
  { flag: "--all", default: "off", meaning: "Include previously-acknowledged findings" },
  { flag: "--ack", default: "off", meaning: "Acknowledge all current findings after rendering" },
  { flag: "--scope <path>", default: "repo root", meaning: "Restrict analysis to a subtree (monorepos)" },
  { flag: "--max-files <n>", default: "400", meaning: "Refuse-and-advise above n changed files" },
  { flag: "--max-tests <n>", default: "12", meaning: "Cap on suggested manual tests" },
  { flag: "--yes", default: "off", meaning: "Pre-answer yes to consent prompts" },
  { flag: "--verbose", default: "off", meaning: "Rule ids, timing, skipped files, budget details" },
  { flag: "--quiet", default: "off", meaning: "Summary line only (for scripts)" },
  { flag: "--no-color", default: "auto", meaning: "Disable ANSI (auto when piped; NO_COLOR honored)" },
  { flag: "--config <path>", default: "auto-discovered", meaning: "Explicit config file path" },
];

const EXIT_CODES: { code: string; meaning: string; triggers: string }[] = [
  { code: "0", meaning: "Review ran; no unacknowledged findings ≥ threshold", triggers: "Clean review; strict pass; acknowledged-only" },
  { code: "1", meaning: "Gate failure (only possible with --strict)", triggers: "Unacknowledged ▲ findings (or ≥ --fail-on)" },
  {
    code: "2",
    meaning: "Operational error — the review did not complete",
    triggers: "Not a git repo; bad range; invalid config; --require-llm unmet; --offline + --llm; diff > --max-files without override",
  },
];

export function Commands() {
  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">Reference</p>
        <h1>Commands &amp; CLI interface</h1>
        <p className="lede">Every command, every flag, with real output from the built CLI.</p>
      </section>

      <h2 id="command-map">Command map</h2>
      <CodeBlock>{`crosscheck                    Analyze staged changes (alias for: review --staged)
crosscheck <range>            Analyze a commit range (alias for: review <range>)
crosscheck review [range]     Full review with all flags
crosscheck history            List, show, or clear past reviews
crosscheck rules              List effective rules (on-by-default vs opt-in tiers); explain one in detail
crosscheck init                Create crosscheck.config.json interactively
crosscheck export [id]        Re-render a review as markdown/json
crosscheck --version          Print version
crosscheck --help             Help (also: <command> --help)`}</CodeBlock>
      <p>
        The two default aliases (bare <code>crosscheck</code> and <code>crosscheck &lt;range&gt;</code>) are exactly{" "}
        <code>review</code> with flags filled in — there are no hidden behavior differences.
      </p>

      <h2 id="flags">Global flags</h2>
      <p>Valid on <code>review</code> and the two default aliases unless noted.</p>
      <div className="ref-rows">
        {FLAGS.map((row) => (
          <div className="ref-row" key={row.flag}>
            <div className="sig">
              <code>{row.flag}</code>
              <span className="default">default: {row.default}</span>
            </div>
            <div className="desc">{row.meaning}</div>
          </div>
        ))}
      </div>
      <p className="small-print">
        Every flag has a config equivalent and vice versa (no behavior reachable only via one surface) — with three
        deliberate exceptions: <code>--ack</code>, <code>--yes</code>, and <code>--show-prompt</code> are one-shot
        actions, meaningless as persistent config. See the <Link to="/config">configuration reference</Link>.
      </p>

      <h2 id="review"><code>crosscheck</code> — staged review (default)</h2>
      <p>
        With no arguments, CrossCheck analyzes <code>git diff --cached</code> (staged changes). If nothing is staged
        but the working tree is dirty, it prints a hint and exits 2; <code>--worktree</code> analyzes the unstaged
        diff instead.
      </p>

      <h2 id="range">Commit-range review</h2>
      <p>
        A positional ref/range (<code>HEAD~3</code>, <code>main..feature</code>, <code>abc123..def456</code>) is
        shorthand for <code>crosscheck review &lt;range&gt;</code>. Ranges use git's own revision syntax. Combined
        with review history, hunks already acknowledged from earlier staged reviews show as previously reviewed.
      </p>

      <h2 id="llm"><code>--llm</code> — BYOK summary mode</h2>
      <p>
        Runs the heuristic pipeline first, then a summarizer: consent gate → redaction → budget check → per-cluster
        summaries (high-risk first, until budget). <code>--show-prompt</code> (alias <code>--dry-run-llm</code>)
        prints the exact redacted prompt(s) with zero network calls — the standing "prove it" hatch.
      </p>
      <Terminal name="show-prompt" />
      <p>
        Details on exactly what gets redacted and why live on the <Link to="/privacy">privacy &amp; security</Link>{" "}
        page.
      </p>

      <h2 id="history"><code>crosscheck history</code> — review log &amp; dedup inspection</h2>
      <p>
        Every hunk's content hash is looked up against history; findings on already-acknowledged hunks collapse into
        a summary line. Amending a commit does not defeat dedup — the hash is content-based, not SHA-based.
      </p>
      <Terminal name="history-list" />
      <p>
        <code>crosscheck history show &lt;id&gt;</code> reprints a stored review. <code>crosscheck history --clear</code>{" "}
        deletes the database after confirmation.
      </p>

      <h2 id="rules-cmd"><code>crosscheck rules</code> — effective rule set</h2>
      <p>Lists every rule in play for this project, split into on-by-default and opt-in tiers.</p>
      <Terminal name="rules-list" />
      <p>Pass a rule id to see its full trigger patterns and remediation detail:</p>
      <Terminal name="rules-show-webhook" />
      <p>
        See the <Link to="/rules">full rule catalog</Link> for every built-in rule with real trigger examples.
      </p>

      <h2 id="init"><code>crosscheck init</code> — interactive setup</h2>
      <p>
        Writes a committed <code>crosscheck.config.json</code> with sensible defaults. Non-interactive with{" "}
        <code>--yes</code>; <code>--force</code> overwrites an existing config.
      </p>
      <Terminal name="init-yes" />

      <h2 id="strict"><code>--strict</code> — CI/pre-push gate mode</h2>
      <p>
        <code>--strict</code> changes only the exit code: after rendering, exit 1 if any unacknowledged finding has
        severity ≥ <code>strict.failOn</code> (default <code>high</code>), else 0. Acknowledged findings never fail
        the gate. Operational errors always exit 2, distinct from gate failures, so scripts can tell "review found
        risk" from "review couldn't run."
      </p>
      <Terminal name="strict-json" />
      <p>After acknowledging the findings, the same gate passes:</p>
      <Terminal name="strict-pass" />

      <h3>Exit-code contract (stable, semver-protected)</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Meaning</th>
              <th>Example triggers</th>
            </tr>
          </thead>
          <tbody>
            {EXIT_CODES.map((row) => (
              <tr key={row.code}>
                <td><code>{row.code}</code></td>
                <td>{row.meaning}</td>
                <td>{row.triggers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="export"><code>crosscheck export</code> — markdown for PR bodies</h2>
      <p>
        <code>--format markdown</code> (or <code>crosscheck export</code> re-rendering a past review from history)
        emits a self-contained markdown document — safe to paste into a PR body or send a client as evidence the
        change was human-verified.
      </p>
      <Terminal name="export-markdown" />

      <div className="callout">
        <p>
          <strong>Try it:</strong> <Link to="/quickstart">Quickstart</Link> · <Link to="/rules">Rule catalog</Link> ·{" "}
          <Link to="/config">Configuration reference</Link>
        </p>
      </div>
    </>
  );
}
