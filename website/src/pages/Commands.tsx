import { Link } from "react-router-dom";
import { Terminal } from "../components/Terminal";
import { CodeBlock } from "../components/CodeBlock";

export function Commands() {
  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">Reference</p>
        <h1>Commands</h1>
        <p className="lede">Every command CrossCheck has, with real output from the built CLI.</p>
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
        The two default shortcuts, bare <code>crosscheck</code> and <code>crosscheck &lt;range&gt;</code>, are exactly{" "}
        <code>review</code> with the range filled in. There is no hidden behavior difference.
      </p>

      <h2 id="review"><code>crosscheck</code>: staged review (default)</h2>
      <p>
        With no arguments, CrossCheck analyzes <code>git diff --cached</code> (staged changes). If nothing is staged,
        it prints a hint and exits.
      </p>

      <h2 id="range">Commit-range review</h2>
      <p>
        A positional ref or range, such as <code>HEAD~3</code> or <code>main..feature</code>, is shorthand for{" "}
        <code>crosscheck review &lt;range&gt;</code>. Ranges use git's own revision syntax.
      </p>

      <h2 id="history"><code>crosscheck history</code>: review log</h2>
      <p>Every past review is stored locally, so you can list, reopen, or clear it later.</p>
      <Terminal name="history-list" />
      <p>
        <code>crosscheck history show &lt;id&gt;</code> reprints a stored review. <code>crosscheck history --clear</code>{" "}
        deletes the database after confirmation.
      </p>

      <h2 id="rules-cmd"><code>crosscheck rules</code>: effective rule set</h2>
      <p>Lists every rule in play for this project, split into on-by-default and opt-in tiers.</p>
      <Terminal name="rules-list" />
      <p>Pass a rule id to see its full detail:</p>
      <Terminal name="rules-show-webhook" />
      <p>
        See the <Link to="/rules">full rule catalog</Link> for every built-in rule with real trigger examples.
      </p>

      <h2 id="init"><code>crosscheck init</code>: interactive setup</h2>
      <p>Writes a committed <code>crosscheck.config.json</code> with sensible defaults, so your rules stay the same across machines.</p>
      <Terminal name="init-yes" />

      <h2 id="export"><code>crosscheck export</code>: markdown for PR bodies</h2>
      <p>Re-renders a review as a self-contained markdown document, safe to paste into a PR body.</p>
      <Terminal name="export-markdown" />

      <div className="callout">
        <p>
          <strong>Try it:</strong> <Link to="/quickstart">Quickstart</Link> · <Link to="/rules">Rule catalog</Link>
        </p>
      </div>
    </>
  );
}
