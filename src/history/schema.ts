/**
 * History DB schema + migration runner (§6.3).
 *
 * `schema_meta` tracks the applied version; each migration is an ordered
 * `{ version, up }` step. v1 ships the full DDL below; a future v2 would only
 * need to append another `{ version: 2, up: "..." }` entry — `runMigrations`
 * already applies whatever is newer than the DB's current version.
 */
import type { Database } from "sql.js";

export const SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS reviews (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_root      TEXT NOT NULL,
        range_desc     TEXT NOT NULL,
        base_ref       TEXT,
        head_ref       TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        files_changed  INTEGER NOT NULL,
        lines_added    INTEGER NOT NULL,
        lines_removed  INTEGER NOT NULL,
        cluster_count  INTEGER NOT NULL,
        high_count     INTEGER NOT NULL,
        medium_count   INTEGER NOT NULL,
        low_count      INTEGER NOT NULL,
        llm_used       INTEGER NOT NULL DEFAULT 0,
        llm_provider   TEXT,
        llm_model      TEXT,
        llm_tokens_in  INTEGER,
        llm_tokens_out INTEGER,
        duration_ms    INTEGER NOT NULL,
        verdict        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hunks (
        hash          TEXT PRIMARY KEY,
        repo_root     TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        rule_ids      TEXT NOT NULL DEFAULT '[]',
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
        times_seen    INTEGER NOT NULL DEFAULT 1,
        acknowledged  INTEGER NOT NULL DEFAULT 0,
        acked_at      TEXT
      );

      CREATE TABLE IF NOT EXISTS checklist_items (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id INTEGER NOT NULL REFERENCES reviews(id),
        rule_id   TEXT,
        severity  TEXT NOT NULL,
        text      TEXT NOT NULL,
        file_path TEXT,
        line      INTEGER,
        checked   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_reviews_repo_created ON reviews(repo_root, created_at);
      CREATE INDEX IF NOT EXISTS idx_hunks_ack ON hunks(acknowledged);
      CREATE INDEX IF NOT EXISTS idx_items_review ON checklist_items(review_id);
    `,
  },
];

function readSchemaVersion(db: Database): number {
  const rows = db.exec("SELECT value FROM schema_meta WHERE key = 'schema_version'");
  const value = rows[0]?.values[0]?.[0];
  return typeof value === "string" ? Number.parseInt(value, 10) || 0 : 0;
}

function writeSchemaVersion(db: Database, version: number): void {
  db.run(
    `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(version)],
  );
}

/**
 * Applies every migration newer than the DB's current `schema_version`, in
 * order. Safe to call on a brand-new (empty) database or a fully-migrated
 * one — both are no-ops beyond the initial `CREATE TABLE IF NOT EXISTS`.
 * Throws if `db` is not a readable SQLite database (caller treats that as
 * "corrupt file", per §6.3).
 */
export function runMigrations(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const current = readSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.run(migration.up);
    writeSchemaVersion(db, migration.version);
  }
}
