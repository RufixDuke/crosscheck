export function Privacy() {
  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">Privacy &amp; security</p>
        <h1>Everything stays on your machine</h1>
        <p className="lede">No account, no server, no telemetry. Here is exactly what each command does with your data.</p>
      </section>

      <h2>No network calls</h2>
      <p>
        <code>crosscheck</code>, <code>crosscheck review</code>, <code>crosscheck rules</code>, and{" "}
        <code>crosscheck init</code> never open a network connection. There is no telemetry, no analytics, and no
        crash reporting. The only thing that ever contacts a server is npm itself, checking for a new version, the
        normal way any npm package does.
      </p>

      <h2>Review history stays local</h2>
      <p>
        <code>crosscheck history</code> reads from a small database that lives at <code>.git/crosscheck/history.db</code>,
        inside your repository's <code>.git</code> folder. It never leaves your machine and can never be committed
        by accident, since anything inside <code>.git</code> is excluded from your repo's own history. It stores
        diff statistics, hunk hashes, finding text, and timestamps, nothing else. Run{" "}
        <code>crosscheck history --clear</code> at any time to delete it.
      </p>

      <h2>Config stays local too</h2>
      <p>
        <code>crosscheck init</code> writes a plain <code>crosscheck.config.json</code> file to your project. It is
        meant to be committed, so your team shares the same rules, and it contains no secrets or keys, just settings.
      </p>

      <div className="callout warn">
        <p>
          A fully clean CrossCheck run is <strong>not</strong> evidence the code is correct or secure. It is evidence
          you looked, in an ordered way, at the riskiest parts. It is one safety check among many, alongside tests,
          staging, and actually reading the diff.
        </p>
      </div>
    </>
  );
}
