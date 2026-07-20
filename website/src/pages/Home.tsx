import { Link } from "react-router-dom";
import { CodeBlock } from "../components/CodeBlock";
import { TypingTerminal } from "../components/Terminal";

export function Home() {
  return (
    <>
      <section className="landing-hero">
        <div className="grid-texture" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="accent-dot">▲</span> local-first · pre-push · offline-first · BYOK
          </p>
          <h1>
            Review what your AI agent wrote — before you <span className="accent">push</span>.
          </h1>
          <p className="lede">
            CrossCheck is a terminal CLI that runs on your staged diff before you push. It clusters what changed,
            scores what's risky — auth, payments, migrations, secrets — and hands you a prioritized checklist and
            concrete manual tests. No account, no server, no telemetry. It works fully offline.
          </p>
          <div className="button-row">
            <Link className="btn btn-primary" to="/quickstart">
              Quickstart →
            </Link>
            <a className="btn btn-secondary btn-star" href="https://github.com/RufixDuke/crosscheck">
              <span className="star-glyph" aria-hidden="true">
                ★
              </span>
              Star on GitHub
            </a>
          </div>
          <CodeBlock>npm i -g crosscheck</CodeBlock>
        </div>
        <div className="hero-term">
          <TypingTerminal name="hero-demo" command="git add -A && crosscheck" maxLines={20} />
          <p className="hero-term-caption">
            Full checklist &amp; manual tests → <Link to="/quickstart">Quickstart</Link>
          </p>
        </div>
      </section>

      <section className="landing-band">
        <div className="landing-section">
          <div className="section-head">
            <h2>What you get, in one run</h2>
            <p className="small-print">
              Every cluster sorted by severity, a checklist tied to file:line evidence, and the manual tests that
              actually matter — no wall of nitpick comments.
            </p>
          </div>
          <div className="card-grid">
            <div className="card">
              <h3>▲ Risk map</h3>
              <p>Every cluster of changed files, sorted by severity — 24 terminal rows or fewer, no matter the diff size.</p>
            </div>
            <div className="card">
              <h3>☐ Prioritized checklist</h3>
              <p>Concrete, checkable items tied to file:line evidence — not a wall of inline nitpick comments.</p>
            </div>
            <div className="card">
              <h3>Suggested manual tests</h3>
              <p>Runnable actions like "send a forged webhook — expect 4xx and zero side effects," tied to what changed.</p>
            </div>
            <div className="card">
              <h3>Zero network calls, by default</h3>
              <p>The heuristic rule engine is the primary product. It works on a flaky connection with no API keys.</p>
            </div>
            <div className="card">
              <h3>BYOK LLM summaries (optional)</h3>
              <p>Bring your own Anthropic, OpenAI, or OpenRouter key for two-sentence cluster summaries — redacted before anything leaves your machine.</p>
            </div>
            <div className="card">
              <h3>Review history &amp; dedup</h3>
              <p>Local SQLite remembers hunks you've already reviewed — content-hashed, so it survives rebases and amended commits.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-band">
        <div className="landing-section">
          <div className="section-head">
            <h2>The moment it works at</h2>
            <p className="small-print">
              Every serious AI-review product reviews code after it is already in GitHub. CrossCheck runs at the last
              moment the author fully controls.
            </p>
          </div>
          <p>
            There's no PR queue for a solo dev, no second pair of eyes, no branch protection — just a terminal, a
            staged diff, and hope. CrossCheck runs before <code>git push</code> and replaces the hope with an ordered
            checklist.
          </p>
        </div>
      </section>

      <section className="landing-band">
        <div className="landing-section">
          <h2>Honest about what it is</h2>
          <div className="callout">
            <p>
              CrossCheck is a structured self-review checklist with a risk radar. It is <strong>not</strong> a proof
              of correctness, not a security audit, and not a replacement for reading the diff. A fully green run is
              evidence you looked, in an ordered way, at the riskiest parts — not evidence the code is correct. Rules
              catch patterns, not logic. You are still the reviewer.
            </p>
          </div>
        </div>
      </section>

      <section className="landing-band">
        <div className="landing-section">
          <h2>How it compares</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>CodeRabbit / Greptile / Cubic / Qodo / Bugbot</th>
                  <th>CrossCheck</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Where it runs</td>
                  <td>GitHub/GitLab PRs (SaaS)</td>
                  <td>Local terminal, pre-push</td>
                </tr>
                <tr>
                  <td>Offline mode</td>
                  <td>No</td>
                  <td>Yes — first-class heuristic mode</td>
                </tr>
                <tr>
                  <td>Code leaves your machine</td>
                  <td>Yes, to the vendor</td>
                  <td>Only with explicit consent, redacted, to your own provider</td>
                </tr>
                <tr>
                  <td>Pricing</td>
                  <td>Per-seat SaaS (~$15–30/dev/mo class)</td>
                  <td>Free, MIT-licensed, forever</td>
                </tr>
                <tr>
                  <td>Output style</td>
                  <td>Inline PR comments (many)</td>
                  <td>Risk map + prioritized checklist + manual tests</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small-print">
            These are good products solving a different moment in the workflow — most teams reviewing each other's
            PRs are well served by them. CrossCheck is for the moment before that: the solo push nobody else will
            see.
          </p>
        </div>
      </section>

      <section className="landing-band">
        <div className="landing-section">
          <div className="callout tip">
            <p>
              <strong>Ready to try it?</strong> Installation to your first review takes under two minutes.
            </p>
            <div className="button-row" style={{ margin: "0.5rem 0 0" }}>
              <Link className="btn btn-primary" to="/quickstart">
                Get started →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
