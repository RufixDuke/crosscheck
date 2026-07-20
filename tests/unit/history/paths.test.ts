import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHistoryDbPath } from "../../../src/history/paths.js";

describe("resolveHistoryDbPath", () => {
  it("uses an explicit path verbatim (resolved to absolute)", () => {
    const resolved = resolveHistoryDbPath({ explicitPath: "/tmp/custom/history.db" });
    expect(resolved).toBe(path.resolve("/tmp/custom/history.db"));
  });

  it("expands a leading ~ in an explicit path against homeDir", () => {
    const resolved = resolveHistoryDbPath({ explicitPath: "~/custom/history.db", homeDir: "/home/u" });
    expect(resolved).toBe(path.resolve("/home/u/custom/history.db"));
  });

  it("resolves the default configured path against repoRoot", () => {
    const resolved = resolveHistoryDbPath({ repoRoot: "/repo" });
    expect(resolved).toBe(path.join("/repo", ".git", "crosscheck", "history.db"));
  });

  it("resolves a custom configuredPath against repoRoot", () => {
    const resolved = resolveHistoryDbPath({ repoRoot: "/repo", configuredPath: "custom/history.db" });
    expect(resolved).toBe(path.join("/repo", "custom", "history.db"));
  });

  it("falls back to ~/.crosscheck/history.db with no repoRoot", () => {
    const resolved = resolveHistoryDbPath({ repoRoot: null, homeDir: "/home/u" });
    expect(resolved).toBe(path.join("/home/u", ".crosscheck", "history.db"));
  });

  it("honors an absolute configuredPath even without a repoRoot", () => {
    const resolved = resolveHistoryDbPath({ repoRoot: null, configuredPath: "/abs/history.db" });
    expect(resolved).toBe("/abs/history.db");
  });

  it("expands ~ in a configuredPath", () => {
    const resolved = resolveHistoryDbPath({ repoRoot: "/repo", configuredPath: "~/global/history.db", homeDir: "/home/u" });
    expect(resolved).toBe(path.join("/home/u", "global", "history.db"));
  });
});
