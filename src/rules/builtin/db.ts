/**
 * Built-in rules — db-migrations/schema category (§7.2): migration-added and
 * destructive-migration on by default; raw-sql-injection opt-in (the
 * interpolation regex also matches safe internal constants).
 *
 * db/destructive-migration is verbatim §7.4 example 3.
 */
import type { RiskRule } from "../../types.js";

export const DB_RULES: RiskRule[] = [
  {
    id: "db/migration-added",
    name: "Database migration added/changed",
    category: "db-migrations/schema",
    severity: "medium",
    enabledByDefault: true,
    archetype: "A3",
    description:
      "A migration is a data-contract change; migrations are read-line-by-line artifacts and a new one is unambiguous signal.",
    when: {
      fileGlobs: ["**/migrations/**", "schema.prisma", "**/schema.*"],
    },
    then: {
      message: "Database migration/schema file changed",
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
  },
  // Verbatim §7.4 example 3.
  {
    id: "db/destructive-migration",
    name: "Destructive database migration",
    category: "db-migrations/schema",
    severity: "high",
    enabledByDefault: true,
    archetype: "A3",
    description:
      "Agents generate migrations that are syntactically valid and operationally catastrophic (DROP, non-null column without default, missing backfill).",
    when: {
      fileGlobs: ["**/migrations/**", "**/db/**", "**/prisma/**", "schema.prisma"],
      addedLines: [
        "(?i)\\bDROP\\s+(TABLE|COLUMN|INDEX|DATABASE)\\b",
        "(?i)\\bTRUNCATE\\b",
        "(?i)ALTER\\s+TABLE\\s+\\S+\\s+ADD\\s+COLUMN\\s+\\S+\\s+\\S+\\s+NOT\\s+NULL\\b(?!.*DEFAULT)",
        "(?i)\\bDELETE\\s+FROM\\b(?!.*\\bWHERE\\b)",
      ],
    },
    then: {
      message: "Migration contains potentially destructive operations",
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
  },
  {
    id: "db/raw-sql-injection",
    name: "Raw SQL with interpolated input",
    category: "db-migrations/schema",
    severity: "high",
    enabledByDefault: false,
    archetype: "A1",
    description:
      "Template-literal or concatenated SQL after query( is injection-shaped — opt-in because it also matches safe internal constants; enable when writing raw SQL by hand.",
    when: {
      addedLines: [
        "\\b(query|execute)\\s*\\(\\s*`[^`]*\\$\\{",
        "\\b(query|execute)\\s*\\(\\s*[\"'][^\"']*[\"']\\s*\\+",
      ],
    },
    then: {
      message: "Raw SQL query interpolates values directly",
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
  },
];
