import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryStore } from "../../../src/types.js";
import { createHistoryStore } from "../../../src/history/store.js";
import { checklistItem, cluster, finding, hunk, report } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crosscheck-history-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function dbPathIn(d: string): string {
  return path.join(d, ".git", "crosscheck", "history.db");
}

describe("createHistoryStore — schema & availability", () => {
  it("is available and starts with an empty, freshly-migrated DB when no file exists", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    expect(store.available).toBe(true);
    expect(store.listReviews(null)).toEqual([]);
    expect(store.hunkStats(null)).toEqual({ tracked: 0, acknowledged: 0 });
    store.close();
  });
});

describe("recordReview + lookupHunks round-trip", () => {
  it("persists a review's stats and returns an id", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const h1 = hunk("src/a.ts", { hash: "h1" });
    const c1 = cluster([h1], { severity: "high" });
    const f1 = finding({ hunkHash: "h1", ruleId: "auth/session-rewrite", severity: "high", baseSeverity: "high" });
    const r = report({
      clusters: [c1],
      findings: [f1],
      checklist: [checklistItem({ ruleId: "auth/session-rewrite", severity: "high", text: "check auth" })],
    });

    const id = store.recordReview(r, "/repo");
    expect(id).not.toBeNull();
    expect(typeof id).toBe("number");

    const reviews = store.listReviews("/repo");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      id,
      rangeDesc: "staged",
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 0,
      clusterCount: 1,
      highCount: 1,
      mediumCount: 0,
      lowCount: 0,
      llmUsed: false,
      durationMs: 10,
      verdict: "findings",
    });
    store.close();
  });

  it("upserts hunks so a repeat sighting bumps times_seen instead of duplicating", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const h1 = hunk("src/a.ts", { hash: "dup-hash" });
    const f1 = finding({ hunkHash: "dup-hash", ruleId: "auth/session-rewrite" });
    const r1 = report({ clusters: [cluster([h1])], findings: [f1] });
    store.recordReview(r1, "/repo");

    const r2 = report({ clusters: [cluster([h1])], findings: [f1] });
    store.recordReview(r2, "/repo");

    const looked = store.lookupHunks(["dup-hash"]);
    expect(looked.size).toBe(1);
    const record = looked.get("dup-hash")!;
    expect(record.timesSeen).toBe(2);
    expect(record.filePath).toBe("src/a.ts");
    expect(record.ruleIds).toContain("auth/session-rewrite");
    expect(record.acknowledged).toBe(false);
    store.close();
  });

  it("merges rule ids across sightings of the same hunk", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const h1 = hunk("src/a.ts", { hash: "merge-hash" });
    store.recordReview(
      report({ clusters: [cluster([h1])], findings: [finding({ hunkHash: "merge-hash", ruleId: "rule/one" })] }),
      "/repo",
    );
    store.recordReview(
      report({ clusters: [cluster([h1])], findings: [finding({ hunkHash: "merge-hash", ruleId: "rule/two" })] }),
      "/repo",
    );

    const record = store.lookupHunks(["merge-hash"]).get("merge-hash")!;
    expect(record.ruleIds.sort()).toEqual(["rule/one", "rule/two"]);
    store.close();
  });

  it("lookupHunks returns an empty map for unknown hashes and empty input", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    expect(store.lookupHunks([]).size).toBe(0);
    expect(store.lookupHunks(["nope"]).size).toBe(0);
    store.close();
  });

  it("derives verdict clean when there are no active findings, strict-fail when strict failed", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const cleanId = store.recordReview(report({ findings: [] }), "/repo");
    const failId = store.recordReview(
      report({ strict: { failOn: "high", unacknowledgedAtOrAbove: 1, passed: false } }),
      "/repo",
    );
    const reviews = store.listReviews("/repo");
    expect(reviews.find((r) => r.id === cleanId)?.verdict).toBe("clean");
    expect(reviews.find((r) => r.id === failId)?.verdict).toBe("strict-fail");
    store.close();
  });
});

describe("acknowledge", () => {
  it("marks hunks acknowledged with a timestamp", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const h1 = hunk("src/a.ts", { hash: "ack-hash" });
    store.recordReview(report({ clusters: [cluster([h1])], findings: [finding({ hunkHash: "ack-hash", ruleId: "r" })] }), "/repo");

    store.acknowledge(["ack-hash"]);

    const record = store.lookupHunks(["ack-hash"]).get("ack-hash")!;
    expect(record.acknowledged).toBe(true);
    expect(record.ackedAt).toBeDefined();
    store.close();
  });

  it("is a no-op for an empty hash list", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    expect(() => store.acknowledge([])).not.toThrow();
    store.close();
  });
});

describe("listReviews ordering & scoping", () => {
  it("orders most-recent first and respects the repoRoot filter", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const idA = store.recordReview(report({ range: { desc: "staged" } }), "/repo-a");
    const idB = store.recordReview(report({ range: { desc: "HEAD~1..HEAD" } }), "/repo-b");
    const idC = store.recordReview(report({ range: { desc: "worktree" } }), "/repo-a");

    const all = store.listReviews(null);
    expect(all.map((r) => r.id)).toEqual([idC, idB, idA]);

    const scoped = store.listReviews("/repo-a");
    expect(scoped.map((r) => r.id)).toEqual([idC, idA]);
    store.close();
  });

  it("respects an explicit limit", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    store.recordReview(report(), "/repo");
    store.recordReview(report(), "/repo");
    store.recordReview(report(), "/repo");
    expect(store.listReviews("/repo", 2)).toHaveLength(2);
    store.close();
  });
});

describe("getReview", () => {
  it("returns the review and its checklist items", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const id = store.recordReview(
      report({
        checklist: [
          checklistItem({ text: "first", severity: "high", ruleId: "r1", file: "a.ts", line: 3 }),
          checklistItem({ text: "second", severity: "low" }),
        ],
      }),
      "/repo",
    )!;

    const got = store.getReview(id);
    expect(got).not.toBeNull();
    expect(got!.review.id).toBe(id);
    expect(got!.items).toHaveLength(2);
    expect(got!.items[0]).toMatchObject({ text: "first", severity: "high", ruleId: "r1", file: "a.ts", line: 3 });
    store.close();
  });

  it("returns null for an unknown id", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    expect(store.getReview(999)).toBeNull();
    store.close();
  });
});

describe("hunkStats", () => {
  it("counts tracked and acknowledged hunks, scoped by repoRoot", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    const h1 = hunk("a.ts", { hash: "s1" });
    const h2 = hunk("b.ts", { hash: "s2" });
    store.recordReview(report({ clusters: [cluster([h1, h2])] }), "/repo");
    store.acknowledge(["s1"]);

    expect(store.hunkStats("/repo")).toEqual({ tracked: 2, acknowledged: 1 });
    expect(store.hunkStats(null)).toEqual({ tracked: 2, acknowledged: 1 });
    expect(store.hunkStats("/other-repo")).toEqual({ tracked: 0, acknowledged: 0 });
    store.close();
  });
});

describe("clear", () => {
  it("deletes the file and resets in-memory state so the store keeps working", async () => {
    const dbPath = dbPathIn(dir);
    const store = await createHistoryStore({ explicitPath: dbPath });
    store.recordReview(report(), "/repo");
    store.persist();

    const { existsSync } = await import("node:fs");
    expect(existsSync(dbPath)).toBe(true);

    store.clear();
    expect(existsSync(dbPath)).toBe(false);
    expect(store.available).toBe(true);
    expect(store.listReviews(null)).toEqual([]);

    // still usable after clearing
    const id = store.recordReview(report(), "/repo");
    expect(id).not.toBeNull();
    store.close();
  });
});

describe("close", () => {
  it("releases resources and subsequent calls stay safe no-ops", async () => {
    const store = await createHistoryStore({ explicitPath: dbPathIn(dir) });
    store.close();
    expect(store.available).toBe(false);
    expect(() => store.recordReview(report(), "/repo")).not.toThrow();
    expect(store.listReviews(null)).toEqual([]);
  });
});

describe("global fallback path resolution", () => {
  it("resolves to ~/.crosscheck/history.db when there is no repo context", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "crosscheck-home-"));
    try {
      const store: HistoryStore = await createHistoryStore({ repoRoot: null, homeDir: home });
      store.recordReview(report(), "");
      store.persist();
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(home, ".crosscheck", "history.db"))).toBe(true);
      store.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("resolves relative to repoRoot when repo context is present", async () => {
    const store = await createHistoryStore({ repoRoot: dir });
    store.recordReview(report(), dir);
    store.persist();
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(dir, ".git", "crosscheck", "history.db"))).toBe(true);
    store.close();
  });
});
