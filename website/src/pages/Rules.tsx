import { CATEGORIES, RULES, type RuleDoc } from "../data/rules";

const CATEGORY_LABEL: Record<string, string> = {
  "auth/session": "Auth / session",
  payments: "Payments",
  "db-migrations/schema": "Database migrations / schema",
  "crypto/secrets": "Crypto / secrets",
};

function RuleCard({ rule }: { rule: RuleDoc }) {
  return (
    <article className="rule-card" id={rule.id}>
      <h3>{rule.id}</h3>
      <div className="rule-meta">
        <span className={`badge ${rule.severity}`}>{rule.severity.toUpperCase()}</span>
        <span className="badge tier">{rule.enabledByDefault ? "on by default" : "opt-in"}</span>
        <span className="badge tier">archetype {rule.archetype}</span>
      </div>
      <p>{rule.description}</p>
      <p className="small-print">
        <strong>{rule.enabledByDefault ? "Why on by default: " : "Why opt-in: "}</strong>
        {rule.rationale}
      </p>
      <dl>
        <dt>Triggers</dt>
        <dd>
          <ul>
            {rule.triggers.map((t) => (
              <li key={t}><code>{t}</code></li>
            ))}
          </ul>
        </dd>
        <dt>Checklist emitted</dt>
        <dd>
          <ul>
            {rule.checklist.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </dd>
        {rule.manualTests.length > 0 && (
          <>
            <dt>Manual tests suggested</dt>
            <dd>
              <ul>
                {rule.manualTests.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </article>
  );
}

export function Rules() {
  const onCount = RULES.filter((r) => r.enabledByDefault).length;
  const optCount = RULES.length - onCount;

  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">Reference</p>
        <h1>The rule catalog</h1>
        <p className="lede">
          CrossCheck ships {RULES.length} built-in rules across {CATEGORIES.length} categories: {onCount} on by default,{" "}
          {optCount} opt-in. Every default-on rule is held to one bar: would a tired developer at midnight think{" "}
          <em>"yes, I needed to see this"</em>? Rules that can't clear that bar yet ship opt-in instead of noisy.
        </p>
      </section>

      <div className="callout">
        <p>
          Opt-in rules can be turned on per project, and any rule's severity can be adjusted, in the{" "}
          <code>crosscheck.config.json</code> written by <code>crosscheck init</code>. Run{" "}
          <code>crosscheck rules &lt;id&gt;</code> to see a rule's exact trigger patterns for your installed version.
        </p>
      </div>

      {CATEGORIES.map((category) => (
        <section key={category}>
          <h2 id={`cat-${category}`}>{CATEGORY_LABEL[category]}</h2>
          {RULES.filter((r) => r.category === category).map((rule) => (
            <RuleCard key={rule.id} rule={rule} />
          ))}
        </section>
      ))}

      <h2>Failure-archetype taxonomy</h2>
      <p>
        Categories say <em>where</em> risk lives; archetypes say <em>how</em> AI-generated code tends to fail. It is
        a cross-cutting tag used to audit coverage, not a second organization scheme.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Archetype</th>
              <th>Definition</th>
              <th>Examples</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>A1</code> added-without-guard</td>
              <td>A capability added without the guard that makes it safe</td>
              <td>webhook without signature verification; credential without env management; hashing without a modern algorithm</td>
            </tr>
            <tr>
              <td><code>A2</code> removed-guard</td>
              <td>A safety mechanism deleted or weakened</td>
              <td>deleted permission check; rewritten session/password verification</td>
            </tr>
            <tr>
              <td><code>A3</code> contract-drift</td>
              <td>A contract changed without updating its companions/consumers</td>
              <td>schema change without migration plan; destructive op strands consumers</td>
            </tr>
            <tr>
              <td><code>A4</code> trust-boundary</td>
              <td>A new trust boundary introduced</td>
              <td>new endpoint; new external service call touching money</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Known limitations</h2>
      <p>
        Heuristics match patterns, not intent, so both false positives and false negatives exist. TypeScript and
        JavaScript get deeper, AST-level analysis; other languages get glob and regex-tier rules. A finding you
        dismiss as noise is a rule-tuning bug report, not user error, so please open one.
      </p>
    </>
  );
}
