// Human-readable mirror of src/rules/builtin/*.ts (§7.2 of the PRD). Kept as
// data — not generated — because it is documentation prose (descriptions,
// checklists) alongside the exact ids/triggers the engine ships. Every rule
// id here must match a rule id in src/rules/builtin/*.ts; the CI coverage
// script (website/scripts/check-coverage.mjs) enforces that nothing drifts.

export type Severity = "high" | "medium" | "low";
export type Archetype = "A1" | "A2" | "A3" | "A4";

export interface RuleDoc {
  id: string;
  name: string;
  category: string;
  severity: Severity;
  enabledByDefault: boolean;
  archetype: Archetype;
  rationale: string;
  description: string;
  triggers: string[];
  checklist: string[];
  manualTests: string[];
}

export const CATEGORIES = ["auth/session", "payments", "db-migrations/schema", "crypto/secrets"] as const;

export const RULES: RuleDoc[] = [
  {
    id: "auth/middleware-touched",
    name: "Auth middleware touched",
    category: "auth/session",
    severity: "high",
    enabledByDefault: true,
    archetype: "A2",
    rationale: "pure path-glob on auth plumbing; any edit there merits review",
    description:
      "Auth plumbing is where guards disappear during agent refactors; any edit there merits a human re-verification of the whole flow.",
    triggers: ["globs: **/auth/**, **/middleware.*"],
    checklist: [
      "Auth plumbing changed — re-verify the auth flow end to end",
      "Confirm every route that was protected before is still protected now",
      "Check that session creation, rotation, and invalidation paths are unchanged in behavior",
      "Confirm middleware ordering: auth still runs before any handler logic",
    ],
    manualTests: [
      "Log in, exercise the changed flow, and log out — expect no behavior change",
      "Hit a protected route without a session — expect a redirect/401, never the payload",
      "Hit a protected route with an expired session — expect rejection and a fresh login prompt",
    ],
  },
  {
    id: "auth/permission-check-removed",
    name: "Permission check removed",
    category: "auth/session",
    severity: "high",
    enabledByDefault: true,
    archetype: "A2",
    rationale: "removed-guard regex; near-zero noise floor",
    description:
      "A removed requireAuth/authorize/checkPermission call is the classic agent refactor casualty — near-zero noise floor, always worth flagging.",
    triggers: ["removed: \\b(requireAuth|authorize|checkPermission)\\b"],
    checklist: [
      "Confirm every route that lost a requireAuth/authorize call is intentionally public",
      "Diff the route table against the previous version and account for every lost guard",
      "If the check moved into shared middleware, confirm the middleware actually covers these routes",
      "Check for privilege-escalation paths: can a lower role now reach this handler?",
    ],
    manualTests: [
      "Call each affected endpoint with no session — expect 401/redirect",
      "Call each affected endpoint as a non-privileged user — expect 403",
    ],
  },
  {
    id: "auth/session-rewrite",
    name: "Session/password verification rewritten",
    category: "auth/session",
    severity: "high",
    enabledByDefault: true,
    archetype: "A2",
    rationale: "AST-precise; fires only when a compare/session call disappears",
    description:
      "When a compare/session call disappears from the code, logins either broke or silently stopped verifying — both are ship-blockers.",
    triggers: ["ast: compareSync|bcrypt.compare call removed"],
    checklist: [
      "Verify session invalidation and the password-verify path survived the rewrite",
      "Confirm the replacement still compares hashes with a timing-safe function (bcrypt.compare / compareSync)",
      "Confirm failed comparisons reject — no code path where an unmatched password still logs in",
      "Confirm existing sessions are invalidated or migrated deliberately, not silently orphaned",
    ],
    manualTests: [
      "Log in with a correct password — expect success",
      "Log in with a wrong password — expect rejection, and no session created",
      "Log out, then reuse the old session token — expect rejection",
    ],
  },
  {
    id: "payments/provider-code",
    name: "Payment provider code changed",
    category: "payments",
    severity: "high",
    enabledByDefault: true,
    archetype: "A4",
    rationale: "path-glob on money-moving files; always review-worthy",
    description: "Money-moving files are a trust boundary: agent edits there are always worth a slow, line-by-line re-read.",
    triggers: ["globs: **/{paystack,stripe,payment,billing,checkout}*/**"],
    checklist: [
      "Re-read every money-moving path that changed; confirm amounts flow server-side",
      "Confirm no amount, currency, or price is trusted from the client payload",
      "Confirm idempotency keys survive the change — a retried charge must not double-charge",
      "Confirm provider errors are mapped deliberately (no silent swallow, no raw leak to the client)",
    ],
    manualTests: [
      "Run a full test-mode purchase end to end against the provider sandbox",
      "Retry the same payment request twice — expect exactly one charge",
      "Force a provider failure (bad key / sandbox decline) — expect a clean error path",
    ],
  },
  {
    id: "payments/webhook-endpoint",
    name: "Webhook/payment handler added without signature verification",
    category: "payments",
    severity: "high",
    enabledByDefault: true,
    archetype: "A1",
    rationale: "compound absence matcher + full-file guard verification keeps false positives rare",
    description:
      "Payment webhooks are the canonical ‘almost right’ agent output: plausible handler, missing signature verification, no idempotency.",
    triggers: [
      "globs: **/*{webhook,payment,billing,checkout,paystack,stripe}*.{ts,js}, **/routes/**",
      "added: a POST/GET/USE route with webhook|payment|charge|payout in the path, plus a fulfill/grant/activate/upgrade/credit call",
      "guard (must be absent): createHmac|timingSafeEqual|verifyWebhookSignature|verifySignature, or an x-paystack/x-stripe-signature header read",
      "verify-in-file: on — a guard found elsewhere in the full file downgrades this to an info note",
    ],
    checklist: [
      "Verify the provider signature/HMAC is checked BEFORE any business logic runs",
      "Confirm verification uses the raw request body (not the re-serialized JSON)",
      "Confirm the handler is idempotent: replay the same event twice, expect one fulfillment",
      "Confirm amounts/references are re-fetched or recomputed server-side, never trusted from the payload",
    ],
    manualTests: [
      "Send a forged webhook (no/invalid signature) — expect 4xx and zero side effects",
      "Replay the provider's test webhook twice — expect exactly one fulfillment",
      "Send a payload with a tampered amount — expect rejection or recomputation",
    ],
  },
  {
    id: "payments/amount-math",
    name: "Amount math from request payload",
    category: "payments",
    severity: "medium",
    enabledByDefault: false,
    archetype: "A1",
    rationale: "amount near req.body also fires on benign math; enable on payment-heavy codebases",
    description: "Amounts computed from req.body are trusted-client-input bugs.",
    triggers: ["added: req.body...amount[:=] or amount[:=]...req.body"],
    checklist: [
      "Recompute amounts server-side; never trust totals from the payload",
      "Re-fetch prices/amounts from your own datastore by id — ignore client-sent values",
      "Confirm currency and unit (kobo/cents vs naira/dollars) are fixed server-side",
    ],
    manualTests: [
      "Send a request with a tampered (lower) amount — expect the server to bill the real price",
      "Send a negative or zero amount — expect validation rejection",
    ],
  },
  {
    id: "db/migration-added",
    name: "Database migration added/changed",
    category: "db-migrations/schema",
    severity: "medium",
    enabledByDefault: true,
    archetype: "A3",
    rationale: "a new migration file is unambiguous; migrations are read-line-by-line artifacts",
    description: "A migration is a data-contract change; migrations are read-line-by-line artifacts and a new one is unambiguous signal.",
    triggers: ["globs: **/migrations/**, schema.prisma, **/schema.*"],
    checklist: [
      "Run the migration against a production-shaped dump locally; confirm backfill + rollback path",
      "Confirm the migration is reversible — a DOWN path exists and actually runs",
      "Check lock impact: table rewrites and index builds on large tables need a plan",
      "Confirm app code and schema land together (no deploy order that strands either side)",
    ],
    manualTests: [
      "Apply the migration to a copy of production-shaped data and boot the app against it",
      "Run the down migration and confirm the app still boots",
    ],
  },
  {
    id: "db/destructive-migration",
    name: "Destructive database migration",
    category: "db-migrations/schema",
    severity: "high",
    enabledByDefault: true,
    archetype: "A3",
    rationale: "DROP TABLE in a migration file is never noise",
    description:
      "Agents generate migrations that are syntactically valid and operationally catastrophic (DROP, non-null column without default, missing backfill).",
    triggers: [
      "globs: **/migrations/**, **/db/**, **/prisma/**, schema.prisma",
      "added: DROP TABLE|COLUMN|INDEX|DATABASE, TRUNCATE, ADD COLUMN ... NOT NULL without DEFAULT, DELETE FROM without WHERE",
    ],
    checklist: [
      "Read the migration line by line — do not skim migrations, ever",
      "Confirm every DROP/TRUNCATE targets something truly disposable (not renamed-away production data)",
      "For NOT NULL columns without DEFAULT: confirm the backfill strategy and table-lock impact",
      "Write or verify the DOWN/rollback migration before pushing",
    ],
    manualTests: [
      "Restore a production-shaped dump locally and run the migration against it",
      "Run the down migration and confirm the app still boots",
      "Run the app against the migrated schema and exercise the affected feature end to end",
    ],
  },
  {
    id: "db/raw-sql-injection",
    name: "Raw SQL with interpolated input",
    category: "db-migrations/schema",
    severity: "high",
    enabledByDefault: false,
    archetype: "A1",
    rationale: "interpolation regex also matches safe internal constants; enable when writing raw SQL by hand",
    description: "Template-literal or concatenated SQL after query( is injection-shaped.",
    triggers: ["added: query(`...${ or query(\"...\" +"],
    checklist: [
      "Parameterize interpolated queries; confirm no request input reaches SQL unescaped",
      "Convert every ${...} in a query string to a bound parameter ($1, ?, or the driver's equivalent)",
      "If an identifier (table/column name) must be dynamic, gate it behind a strict allow-list",
    ],
    manualTests: [
      "Send a payload containing a quote or SQL metacharacters — expect safe handling, not a 500 or data leak",
      "Run the endpoint with sqlmap-style probe input in staging — expect zero injectable params",
    ],
  },
  {
    id: "secrets/hardcoded-secret",
    name: "Hardcoded secret or credential",
    category: "crypto/secrets",
    severity: "high",
    enabledByDefault: true,
    archetype: "A1",
    rationale: "secret-shaped patterns (sk_live_…, AKIA…) are high-precision",
    description:
      "AI agents frequently inline plausible-looking keys while wiring integrations; GitGuardian's 2026 report found Claude-Code-assisted commits leak secrets at 2× the baseline rate.",
    triggers: [
      "globs: **/*.{ts,tsx,js,jsx,mjs,cjs,json,env}, .env*",
      "added: api_key|secret|password|token = \"...\" (8+ chars), or a known key shape (sk-live-, sk-ant-, ghp_, AKIA, xox…)",
    ],
    checklist: [
      "Confirm the flagged value is not a real credential (test fixtures and public keys are OK)",
      "If real: revoke/rotate it NOW — assume anything committed is compromised",
      "Move the value to an environment variable and add it to .env.example with a placeholder",
      "If it was already committed, scrub history or rotate; check git log -p before pushing",
    ],
    manualTests: ["Run the app with the credential removed from code to prove env-based loading works"],
  },
  {
    id: "crypto/weak-hash",
    name: "Weak hash algorithm (md5/sha1)",
    category: "crypto/secrets",
    severity: "high",
    enabledByDefault: true,
    archetype: "A1",
    rationale: 'createHash("md5"/"sha1") is unambiguous',
    description: "Collision-broken hashes have no business in security code paths.",
    triggers: ['ast: crypto.createHash("md5" | "sha1")'],
    checklist: [
      "Replace md5/sha1 with a modern hash for security uses (sha-256+, or argon2/bcrypt for passwords)",
      "Confirm the hashed value's role: password storage needs a password KDF, not a bare fast hash",
      "Check every consumer of the old digest — migration means both sides change together",
    ],
    manualTests: [
      "Exercise the flow that produces the digest and verify the new algorithm end to end",
      "Verify old stored digests still validate or are deliberately migrated",
    ],
  },
  {
    id: "crypto/insecure-random",
    name: "Math.random in security-adjacent code",
    category: "crypto/secrets",
    severity: "medium",
    enabledByDefault: false,
    archetype: "A1",
    rationale: "Math.random is often benign even near auth code; enable for token/session-heavy code",
    description: "Math.random is not a CSPRNG — tokens, session ids, and secrets from it are guessable.",
    triggers: [
      "globs: **/*{auth,session,token,secret,password,crypto,security}*.{ts,tsx,js,jsx,mts,cts}, **/{auth,session,security,crypto}/**",
      "ast: Math.random()",
    ],
    checklist: [
      "Use crypto.randomBytes/randomUUID for tokens, ids, and secrets",
      "Trace each Math.random() value: if it ever gates access or identifies a resource, replace it",
      "Confirm no reset/invite/verification token derives from Math.random()",
    ],
    manualTests: ["Generate several tokens/ids and confirm they come from a CSPRNG (length, charset, unpredictability)"],
  },
];
