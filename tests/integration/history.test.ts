/**
 * History failure-model tests (§15.5, §6.4): WASM load failure, write-through
 * persist surviving a reload, corrupted DB fallback, and persist-failure
 * injection — none of these may ever throw out of the `HistoryStore` API.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHistoryStore, type HistoryStoreImpl } from "../../src/history/store.js";
import { cluster, finding, hunk, report } from "../unit/history/helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crosscheck-history-e2e-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WASM module load failure", () => {
  it("degrades to a fully functional no-history store", async () => {
    const store = await createHistoryStore({
      explicitPath: path.join(dir, "history.db"),
      loadSqlJs: async () => {
        throw new Error("simulated WASM load failure");
      },
    });

    expect(store.available).toBe(false);
    expect(store.lookupHunks(["x"]).size).toBe(0);
    expect(store.recordReview(report(), "/repo")).toBeNull();
    expect(store.listReviews(null)).toEqual([]);
    expect(store.getReview(1)).toBeNull();
    expect(store.hunkStats(null)).toEqual({ tracked: 0, acknowledged: 0 });
    expect(() => store.acknowledge(["x"])).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(() => store.persist()).not.toThrow();
    expect(() => store.close()).not.toThrow();
    expect(existsSync(path.join(dir, "history.db"))).toBe(false);
  });
});

describe("write-through persist survives a fresh reload", () => {
  it("reopening the same file after close() sees the same hunks and reviews", async () => {
    const dbPath = path.join(dir, ".git", "crosscheck", "history.db");
    const storeA = await createHistoryStore({ explicitPath: dbPath });

    const h1 = hunk("src/webhook.ts", { hash: "reload-hash" });
    const id = storeA.recordReview(
      report({
        clusters: [cluster([h1])],
        findings: [finding({ hunkHash: "reload-hash", ruleId: "payments/webhook-verify" })],
      }),
      "/repo",
    );
    storeA.acknowledge(["reload-hash"]);
    storeA.persist();
    storeA.close();

    expect(existsSync(dbPath)).toBe(true);

    // Simulates a fresh process: a brand-new store instance over the same file.
    const storeB = await createHistoryStore({ explicitPath: dbPath });
    expect(storeB.available).toBe(true);

    const record = storeB.lookupHunks(["reload-hash"]).get("reload-hash");
    expect(record).toBeDefined();
    expect(record!.acknowledged).toBe(true);
    expect(record!.filePath).toBe("src/webhook.ts");

    const reviews = storeB.listReviews("/repo");
    expect(reviews.map((r) => r.id)).toContain(id);
    storeB.close();
  });
});

describe("corrupted DB file on disk", () => {
  it("falls back to a fresh, usable DB instead of crashing", async () => {
    const dbPath = path.join(dir, "history.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, Buffer.from("this is not a sqlite file, just garbage bytes"));

    const store = (await createHistoryStore({ explicitPath: dbPath })) as HistoryStoreImpl;

    expect(store.available).toBe(true);
    expect(store.corruptedOnLoad).toBe(true);
    expect(store.listReviews(null)).toEqual([]);

    // Still fully usable after the fallback.
    const id = store.recordReview(report(), "/repo");
    expect(id).not.toBeNull();
    store.close();
  });

  it("does not flag a missing file as corrupted", async () => {
    const dbPath = path.join(dir, "does-not-exist", "history.db");
    const store = (await createHistoryStore({ explicitPath: dbPath })) as HistoryStoreImpl;
    expect(store.available).toBe(true);
    expect(store.corruptedOnLoad).toBe(false);
    store.close();
  });
});

describe("persist-failure injection", () => {
  it("flips to no-history mode without throwing when the write destination is unwritable", async () => {
    // A regular file where persist() needs a directory forces mkdir/write to
    // fail deterministically, regardless of OS user/permission quirks.
    const blockerPath = path.join(dir, "blocker");
    writeFileSync(blockerPath, "not a directory");
    const dbPath = path.join(blockerPath, "history.db");

    const store = await createHistoryStore({ explicitPath: dbPath });
    // Construction succeeds: the missing/unreadable file path is treated as
    // "start fresh in memory" — the failure only surfaces on persist().
    expect(store.available).toBe(true);

    store.recordReview(report(), "/repo");
    expect(() => store.persist()).not.toThrow();

    expect(store.available).toBe(false);
    // Once disabled, every method is a safe no-op.
    expect(store.lookupHunks(["x"]).size).toBe(0);
    expect(store.recordReview(report(), "/repo")).toBeNull();
    expect(() => store.close()).not.toThrow();
  });
});
