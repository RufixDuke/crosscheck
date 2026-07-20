import { Link } from "react-router-dom";
import { CodeBlock } from "../components/CodeBlock";
import { Terminal } from "../components/Terminal";

export function Quickstart() {
  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">Quickstart</p>
        <h1>Install to first review in under two minutes</h1>
        <p className="lede">
          No account, no signup, no config required to get useful output. Three commands.
        </p>
      </section>

      <h2>1. Install</h2>
      <p>
        Requires Node.js ≥ 18.18. CrossCheck is a single global binary — no daemon, no background service.
      </p>
      <CodeBlock>npm i -g @rufixduke/crosscheck</CodeBlock>

      <h2>2. Stage a change and run it</h2>
      <p>
        From inside any git repository, stage whatever you want reviewed and run <code>crosscheck</code> with no
        arguments — it reviews <code>git diff --cached</code> by default.
      </p>
      <Terminal name="quickstart-review" />
      <p>
        No arguments means no network calls either: the heuristic rule engine — the risk map, the checklist, the
        manual test suggestions — runs entirely offline. See <Link to="/privacy">privacy &amp; security</Link> for
        exactly what that guarantees.
      </p>

      <h2>3. Read the output</h2>
      <ul>
        <li>
          <strong>Risk map</strong> — one row per cluster of related changes, severity-sorted (▲ high, ● medium, ■
          low).
        </li>
        <li>
          <strong>Checklist</strong> — concrete items to verify, each tied to a <code>file:line</code> and the rule
          that flagged it.
        </li>
        <li>
          <strong>Suggested manual tests</strong> — runnable actions for the riskiest clusters.
        </li>
      </ul>
      <p>
        Full details on every section, flag, and exit code live on the <Link to="/commands">commands reference</Link>.
      </p>

      <h2>4. Make it a habit</h2>
      <p>
        Run <code>crosscheck init</code> to write a committed <code>crosscheck.config.json</code> so your team (even
        a team of one, across machines) shares the same rules:
      </p>
      <Terminal name="init-yes" />
      <p>
        When you're confident in the signal, add <code>--strict</code> to a pre-push git hook or CI job so an
        unacknowledged high-risk finding blocks the push. See <Link to="/config">configuration</Link> for the full
        options.
      </p>

      <div className="callout">
        <p>
          <strong>Next:</strong> <Link to="/commands">Full command reference</Link> ·{" "}
          <Link to="/rules">What each rule catches</Link> · <Link to="/config">Configuration reference</Link>
        </p>
      </div>
    </>
  );
}
