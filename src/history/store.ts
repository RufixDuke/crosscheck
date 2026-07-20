/**
 * HistoryStore (§5.6/§6.3): sql.js (SQLite-to-WASM) backing store for review
 * history and hunk dedup. The analysis pipeline only ever sees the
 * `HistoryStore` interface (src/types.ts) — this module is the one place
 * that knows sql.js exists.
 *
 * Degradation (§6.4): the WASM module failing to load, a corrupt on-disk
 * file, or a failed persist all degrade to a fully functional no-op store
 * (`available = false`) rather than throwing — implemented here as the same
 * class with `db === null` as its internal disabled flag, so every code
 * path (construction-time failure and later persist-time failure) collapses
 * to one behavior.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import initSqlJsDefault from "sql.js";
import type { Database, ParamsObject, SqlJsStatic } from "sql.js";
import type {
  ChecklistItem,
  Finding,
  HistoryStore,
  Hunk,
  HunkRecord,
  ReviewRecord,
  ReviewReport,
  Severity,
} from "../types.js";
import { type ResolveHistoryDbPathOptions, resolveHistoryDbPath } from "./paths.js";
import { runMigrations } from "./schema.js";

export { resolveHistoryDbPath } from "./paths.js";
export type { ResolveHistoryDbPathOptions } from "./paths.js";

export interface CreateHistoryStoreOptions extends ResolveHistoryDbPathOptions {
  /** Injectable for tests — simulate a WASM module load failure. Defaults to sql.js's `initSqlJs`. */
  loadSqlJs?: () => Promise<SqlJsStatic>;
}

function parseRuleIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function textOrUndefined(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function rowToHunkRecord(row: ParamsObject): HunkRecord {
  const record: HunkRecord = {
    hash: String(row.hash),
    filePath: String(row.file_path),
    ruleIds: parseRuleIds(row.rule_ids),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    timesSeen: Number(row.times_seen),
    acknowledged: Number(row.acknowledged) === 1,
  };
  const ackedAt = textOrUndefined(row.acked_at);
  if (ackedAt !== undefined) record.ackedAt = ackedAt;
  return record;
}

function rowToReviewRecord(row: ParamsObject): ReviewRecord {
  const record: ReviewRecord = {
    id: Number(row.id),
    rangeDesc: String(row.range_desc),
    createdAt: String(row.created_at),
    filesChanged: Number(row.files_changed),
    linesAdded: Number(row.lines_added),
    linesRemoved: Number(row.lines_removed),
    clusterCount: Number(row.cluster_count),
    highCount: Number(row.high_count),
    mediumCount: Number(row.medium_count),
    lowCount: Number(row.low_count),
    llmUsed: Number(row.llm_used) === 1,
    durationMs: Number(row.duration_ms),
    verdict: String(row.verdict) as ReviewRecord["verdict"],
  };
  const provider = textOrUndefined(row.llm_provider);
  if (provider !== undefined) record.llmProvider = provider;
  const model = textOrUndefined(row.llm_model);
  if (model !== undefined) record.llmModel = model;
  return record;
}

/**
 * checklist_items (§6.3) persists rule_id/severity/text/file/line/checked
 * only — it has no cluster or hunk-hash columns, so `clusterId`/`clusterLabel`
 * can't be reconstructed on reload and `acknowledged` (hunk-dedup state) is
 * not derivable from this row. These are filled with neutral defaults; a
 * future schema version would need new columns to round-trip them.
 */
function rowToChecklistItem(row: ParamsObject): ChecklistItem {
  const item: ChecklistItem = {
    severity: String(row.severity) as Severity,
    text: String(row.text),
    clusterId: "",
    clusterLabel: "",
    acknowledged: false,
  };
  const ruleId = textOrUndefined(row.rule_id);
  if (ruleId !== undefined) item.ruleId = ruleId;
  const file = textOrUndefined(row.file_path);
  if (file !== undefined) item.file = file;
  if (row.line !== null && row.line !== undefined) item.line = Number(row.line);
  return item;
}

function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function deriveVerdict(report: ReviewReport): ReviewRecord["verdict"] {
  if (report.strict !== undefined && !report.strict.passed) return "strict-fail";
  return report.findings.length === 0 ? "clean" : "findings";
}

/** Opens (or creates) the on-disk DB. Never throws — corruption/missing files fall back to fresh. */
function openDatabase(SQL: SqlJsStatic, dbPath: string): { db: Database; corruptedOnLoad: boolean } {
  let existing: Buffer | null = null;
  try {
    existing = readFileSync(dbPath);
  } catch {
    existing = null; // missing file, or unreadable — treated the same as "nothing to load"
  }

  if (existing !== null) {
    try {
      const db = new SQL.Database(existing);
      runMigrations(db);
      return { db, corruptedOnLoad: false };
    } catch {
      // Corrupt file (§6.3): fall through to a fresh DB below.
    }
  }

  const fresh = new SQL.Database();
  runMigrations(fresh);
  return { db: fresh, corruptedOnLoad: existing !== null };
}

/**
 * Exported only so tests can observe implementation-only signals (e.g.
 * `corruptedOnLoad`) that have no place on the shared `HistoryStore`
 * interface. The pipeline should keep depending on `HistoryStore`.
 */
export class HistoryStoreImpl implements HistoryStore {
  private db: Database | null;
  private readonly SQL: SqlJsStatic | null;
  private readonly dbPath: string;
  /** Set when construction found an on-disk file that wasn't a valid SQLite DB (§6.3 "notice"). */
  readonly corruptedOnLoad: boolean;

  constructor(SQL: SqlJsStatic | null, db: Database | null, dbPath: string, corruptedOnLoad = false) {
    this.SQL = SQL;
    this.db = db;
    this.dbPath = dbPath;
    this.corruptedOnLoad = corruptedOnLoad;
  }

  get available(): boolean {
    return this.db !== null;
  }

  private disable(): void {
    const db = this.db;
    this.db = null;
    if (db !== null) {
      try {
        db.close();
      } catch {
        // already unusable — nothing left to release
      }
    }
  }

  lookupHunks(hashes: string[]): Map<string, HunkRecord> {
    const result = new Map<string, HunkRecord>();
    if (this.db === null || hashes.length === 0) return result;
    try {
      const placeholders = hashes.map(() => "?").join(",");
      const stmt = this.db.prepare(`SELECT * FROM hunks WHERE hash IN (${placeholders})`);
      try {
        stmt.bind(hashes);
        while (stmt.step()) {
          const record = rowToHunkRecord(stmt.getAsObject());
          result.set(record.hash, record);
        }
      } finally {
        stmt.free();
      }
      return result;
    } catch {
      this.disable();
      return new Map();
    }
  }

  private existingRuleIds(db: Database, hashes: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (hashes.length === 0) return map;
    const placeholders = hashes.map(() => "?").join(",");
    const stmt = db.prepare(`SELECT hash, rule_ids FROM hunks WHERE hash IN (${placeholders})`);
    try {
      stmt.bind(hashes);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        map.set(String(row.hash), parseRuleIds(row.rule_ids));
      }
    } finally {
      stmt.free();
    }
    return map;
  }

  /** Insert-new / bump-times_seen upsert for every hunk touched by this review (§6.3 design notes). */
  private upsertHunks(db: Database, report: ReviewReport, repoRoot: string): void {
    const byHash = new Map<string, Hunk>();
    for (const cluster of report.clusters) {
      for (const hunk of cluster.hunks) {
        if (!byHash.has(hunk.hash)) byHash.set(hunk.hash, hunk);
      }
    }
    if (byHash.size === 0) return;

    const ruleIdsByHash = new Map<string, Set<string>>();
    const allFindings = [...report.findings, ...report.infoFindings, ...report.previouslyReviewed.findings];
    for (const finding of allFindings) {
      const set = ruleIdsByHash.get(finding.hunkHash) ?? new Set<string>();
      set.add(finding.ruleId);
      ruleIdsByHash.set(finding.hunkHash, set);
    }

    const existing = this.existingRuleIds(db, [...byHash.keys()]);

    for (const [hash, hunk] of byHash) {
      const merged = new Set([...(existing.get(hash) ?? []), ...(ruleIdsByHash.get(hash) ?? [])]);
      db.run(
        `INSERT INTO hunks (hash, repo_root, file_path, rule_ids, times_seen, acknowledged)
         VALUES (?, ?, ?, ?, 1, 0)
         ON CONFLICT(hash) DO UPDATE SET
           last_seen_at = datetime('now'),
           times_seen = times_seen + 1,
           rule_ids = excluded.rule_ids`,
        [hash, repoRoot, hunk.filePath, JSON.stringify([...merged])],
      );
    }
  }

  private insertChecklistItems(db: Database, reviewId: number, items: ChecklistItem[]): void {
    for (const item of items) {
      db.run(
        `INSERT INTO checklist_items (review_id, rule_id, severity, text, file_path, line, checked)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [reviewId, item.ruleId ?? null, item.severity, item.text, item.file ?? null, item.line ?? null],
      );
    }
  }

  recordReview(report: ReviewReport, repoRoot: string): number | null {
    if (this.db === null) return null;
    const db = this.db;
    try {
      db.run("BEGIN");
      try {
        const counts = severityCounts(report.findings);
        db.run(
          `INSERT INTO reviews (
             repo_root, range_desc, base_ref, head_ref, files_changed, lines_added,
             lines_removed, cluster_count, high_count, medium_count, low_count,
             llm_used, llm_provider, llm_model, llm_tokens_in, llm_tokens_out,
             duration_ms, verdict
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            repoRoot,
            report.range.desc,
            report.range.baseRef ?? null,
            report.range.headRef ?? null,
            report.stats.filesChanged,
            report.stats.linesAdded,
            report.stats.linesRemoved,
            report.clusters.length,
            counts.high,
            counts.medium,
            counts.low,
            report.mode.llm ? 1 : 0,
            report.mode.provider ?? null,
            report.mode.model ?? null,
            report.llm?.tokensIn ?? null,
            report.llm?.tokensOut ?? null,
            report.stats.durationMs,
            deriveVerdict(report),
          ],
        );
        const idRows = db.exec("SELECT last_insert_rowid()");
        const reviewId = Number(idRows[0]?.values[0]?.[0] ?? 0);

        this.upsertHunks(db, report, repoRoot);
        this.insertChecklistItems(db, reviewId, report.checklist);

        db.run("COMMIT");
        return reviewId;
      } catch (err) {
        try {
          db.run("ROLLBACK");
        } catch {
          // best effort
        }
        throw err;
      }
    } catch {
      this.disable();
      return null;
    }
  }

  acknowledge(hashes: string[]): void {
    if (this.db === null || hashes.length === 0) return;
    try {
      const placeholders = hashes.map(() => "?").join(",");
      this.db.run(
        `UPDATE hunks SET acknowledged = 1, acked_at = datetime('now') WHERE hash IN (${placeholders})`,
        hashes,
      );
    } catch {
      this.disable();
    }
  }

  listReviews(repoRoot: string | null, limit?: number): ReviewRecord[] {
    if (this.db === null) return [];
    try {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (repoRoot !== null) {
        clauses.push("repo_root = ?");
        params.push(repoRoot);
      }
      let sql = "SELECT * FROM reviews";
      if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
      sql += " ORDER BY created_at DESC, id DESC";
      if (limit !== undefined) {
        sql += " LIMIT ?";
        params.push(limit);
      }
      const stmt = this.db.prepare(sql);
      try {
        stmt.bind(params);
        const out: ReviewRecord[] = [];
        while (stmt.step()) out.push(rowToReviewRecord(stmt.getAsObject()));
        return out;
      } finally {
        stmt.free();
      }
    } catch {
      this.disable();
      return [];
    }
  }

  getReview(id: number): { review: ReviewRecord; items: ChecklistItem[] } | null {
    if (this.db === null) return null;
    try {
      const reviewStmt = this.db.prepare("SELECT * FROM reviews WHERE id = ?");
      let review: ReviewRecord | null = null;
      try {
        reviewStmt.bind([id]);
        if (reviewStmt.step()) review = rowToReviewRecord(reviewStmt.getAsObject());
      } finally {
        reviewStmt.free();
      }
      if (review === null) return null;

      const items: ChecklistItem[] = [];
      const itemsStmt = this.db.prepare("SELECT * FROM checklist_items WHERE review_id = ? ORDER BY id ASC");
      try {
        itemsStmt.bind([id]);
        while (itemsStmt.step()) items.push(rowToChecklistItem(itemsStmt.getAsObject()));
      } finally {
        itemsStmt.free();
      }
      return { review, items };
    } catch {
      this.disable();
      return null;
    }
  }

  hunkStats(repoRoot: string | null): { tracked: number; acknowledged: number } {
    if (this.db === null) return { tracked: 0, acknowledged: 0 };
    try {
      const sql =
        repoRoot !== null
          ? "SELECT COUNT(*) AS tracked, COALESCE(SUM(acknowledged), 0) AS acknowledged FROM hunks WHERE repo_root = ?"
          : "SELECT COUNT(*) AS tracked, COALESCE(SUM(acknowledged), 0) AS acknowledged FROM hunks";
      const rows = this.db.exec(sql, repoRoot !== null ? [repoRoot] : []);
      const values = rows[0]?.values[0];
      return {
        tracked: Number(values?.[0] ?? 0),
        acknowledged: Number(values?.[1] ?? 0),
      };
    } catch {
      this.disable();
      return { tracked: 0, acknowledged: 0 };
    }
  }

  clear(): void {
    if (this.db === null || this.SQL === null) return; // disabled store: no-op (§6.4)
    try {
      rmSync(this.dbPath, { force: true });
    } catch {
      // best effort — proceed to reset in-memory state regardless
    }
    try {
      this.db.close();
    } catch {
      // ignore
    }
    try {
      const fresh = new this.SQL.Database();
      runMigrations(fresh);
      this.db = fresh;
    } catch {
      // Extremely unlikely (fresh in-memory DB failing schema creation) — degrade rather than throw.
      this.db = null;
    }
  }

  persist(): void {
    if (this.db === null) return;
    try {
      const bytes = this.db.export();
      mkdirSync(path.dirname(this.dbPath), { recursive: true });
      writeFileSync(this.dbPath, Buffer.from(bytes));
    } catch {
      this.disable();
    }
  }

  close(): void {
    if (this.db !== null) {
      try {
        this.db.close();
      } catch {
        // ignore — nothing left to release
      }
    }
    this.db = null;
  }
}

/**
 * Builds a `HistoryStore` (§5.6): resolves the DB path (explicit path, or
 * repo-root-relative, or the global `~/.crosscheck` fallback), loads the
 * sql.js WASM module, and opens (or creates) the DB file. Never rejects —
 * any failure along the way yields a store with `available = false` that
 * satisfies the full interface as a no-op (§6.4).
 */
export async function createHistoryStore(opts: CreateHistoryStoreOptions = {}): Promise<HistoryStore> {
  const dbPath = resolveHistoryDbPath(opts);
  const load = opts.loadSqlJs ?? (() => initSqlJsDefault());

  let SQL: SqlJsStatic | null;
  try {
    SQL = await load();
  } catch {
    SQL = null;
  }
  if (SQL === null) return new HistoryStoreImpl(null, null, dbPath);

  try {
    const { db, corruptedOnLoad } = openDatabase(SQL, dbPath);
    return new HistoryStoreImpl(SQL, db, dbPath, corruptedOnLoad);
  } catch {
    // Opening/migrating even a fresh in-memory DB failed — degrade fully.
    return new HistoryStoreImpl(null, null, dbPath);
  }
}
