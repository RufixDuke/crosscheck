import { Link } from "react-router-dom";
import { CodeBlock } from "../components/CodeBlock";

const ENV_VARS: { name: string; overrides: string; notes: string }[] = [
  { name: "ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY", overrides: "—", notes: "Read at request time only; never written to disk, logs, or history" },
  { name: "CROSSCHECK_LLM_PROVIDER", overrides: "llm.provider", notes: "Useful for trying OpenRouter without editing config" },
  { name: "CROSSCHECK_LLM_MODEL", overrides: "llm.model", notes: "" },
  { name: "CROSSCHECK_OFFLINE", overrides: "--offline", notes: "Any non-empty value forces offline" },
  { name: "NO_COLOR", overrides: "output.color", notes: "Standard convention, honored" },
  { name: "CROSSCHECK_CONFIG", overrides: "--config", notes: "Explicit config path" },
];

const CONFIG_SAMPLE = `// crosscheck.config.json — every key shown with its default
{
  "$schema": "https://raw.githubusercontent.com/RufixDuke/crosscheck/main/schema/crosscheck.config.schema.json",
  "version": 1,

  "rules": {
    "disable": [],                // built-in rule ids to turn off
    "enable": [],                 // opt-in built-in rule ids to turn ON:
                                   // payments/amount-math, db/raw-sql-injection,
                                   // crypto/insecure-random
    "dependencySignals": true,    // read package.json once per run to tailor findings
    "severityOverrides": {},      // retune built-ins per project, e.g. { "db/destructive-migration": "medium" }
    "custom": []                  // user rules; glob+regex only in MVP
  },

  "ignore": [],                   // extra globs excluded at ingest
                                   // (built-ins — lockfiles, dist, binaries — always apply)

  "llm": {
    "provider": null,             // "anthropic" | "openai" | "openrouter" | null
    "model": null,                // any model slug valid for the provider
    "apiKeyEnv": null,            // NAME of the env var; the key itself is never stored
    "maxTokensPerReview": 48000,  // input-token ceiling per review
    "maxTokensPerCluster": 6000,  // per-cluster summary cap
    "maxCostUsdPerReview": 0.25,  // aborts the LLM pass (heuristics still render) if estimate exceeds
    "temperature": 0.2,
    "timeoutMs": 30000,
    "anonymizePaths": false,      // rewrite file paths to src/file-1.ts style
    "consentGiven": {}            // per-provider consent map; written by the consent flow
  },

  "strict": {
    "failOn": "high"              // "high" | "medium" | "low" — threshold for --strict exit 1
  },

  "output": {
    "format": "terminal",         // "terminal" | "markdown" | "json"
    "color": true,                // auto-disabled when piped regardless
    "maxTests": 12,                // cap on suggested manual tests
    "maxClusters": 8
  },

  "history": {
    "enabled": true,              // false = run stateless (no SQLite reads/writes)
    "dbPath": ".git/crosscheck/history.db"
  }
}`;

const CUSTOM_RULE_SAMPLE = `{
  "id": "client/no-console-in-prod",
  "name": "console.log left in src",
  "category": "custom",
  "severity": "low",
  "enabledByDefault": true,
  "description": "Agent scaffolding leaves debug logs behind.",
  "when": {
    "fileGlobs": ["src/**/*.{ts,tsx}"],
    "addedLines": ["\\\\bconsole\\\\.(log|debug|warn)\\\\s*\\\\("]
  },
  "then": {
    "message": "console.* added in source",
    "checklist": ["Remove or gate debug logging before pushing"],
    "manualTests": []
  }
}`;

export function Config() {
  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">Reference</p>
        <h1>Configuration system</h1>
        <p className="lede">
          Every key in <code>crosscheck.config.json</code>, shown with its default value.
        </p>
      </section>

      <h2>Discovery &amp; precedence</h2>
      <p>Later layers win:</p>
      <ol>
        <li>Defaults (built into the CLI)</li>
        <li>
          Global <code>~/.crosscheck/config.json</code> (optional)
        </li>
        <li>
          Project <code>crosscheck.config.json</code> (repo root, or nearest to <code>--scope</code>)
        </li>
        <li>
          Environment variables (<code>CROSSCHECK_*</code>)
        </li>
        <li>CLI flags</li>
      </ol>
      <p>
        Project config is <strong>meant to be committed</strong> — rules are team/project artifacts even for a team
        of one across machines. The file carries <code>$schema</code> for editor completion. Validation is via zod:
        unknown keys warn with a did-you-mean suggestion (e.g.{" "}
        <code>unknown config key "llm.maxToken" — did you mean "llm.maxTokensPerReview"</code>), invalid values are
        fatal with a precise pointer. <code>--config &lt;path&gt;</code> bypasses discovery entirely.
      </p>

      <h2>Full spec with defaults</h2>
      <CodeBlock>{CONFIG_SAMPLE}</CodeBlock>

      <h2>Custom rules (<code>rules.custom</code>)</h2>
      <p>
        User rules are glob+regex only in MVP — <code>requireAll</code>, <code>notAddedWith</code>, and{" "}
        <code>verifyInFile</code> are allowed, but declaring <code>when.ast</code> is rejected: AST matchers are a
        built-in-rule privilege until the matcher API stabilizes. Same two-tier <code>enabledByDefault</code>{" "}
        semantics as built-ins apply. See the <Link to="/rules">rule catalog</Link> for the shape rules take.
      </p>
      <CodeBlock>{CUSTOM_RULE_SAMPLE}</CodeBlock>

      <h2>Environment variables</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Overrides</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {ENV_VARS.map((row) => (
              <tr key={row.name}>
                <td><code>{row.name}</code></td>
                <td>{row.overrides === "—" ? row.overrides : <code>{row.overrides}</code>}</td>
                <td>{row.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Config philosophy</h2>
      <p>
        Every flag must have a config equivalent and vice versa (no behavior reachable only via one surface) — with
        three deliberate exceptions: <code>--ack</code>, <code>--yes</code>, and <code>--show-prompt</code> are
        one-shot actions, meaningless as persistent config. The config file is the customization ceiling for MVP: no
        plugins, no JS-config files, no remote rule packs. See the full{" "}
        <Link to="/commands">command &amp; flag reference</Link>.
      </p>
    </>
  );
}
