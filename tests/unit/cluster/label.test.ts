import { describe, expect, it } from "vitest";
import { labelCluster, MAX_LABEL_LENGTH } from "../../../src/cluster/label.js";
import { add, file } from "./helpers.js";

const f = (path: string) => file(path, [add("// change")]);

describe("labelCluster", () => {
  it("labels by dominant directory + shared stem", () => {
    const label = labelCluster([f("src/auth/session.ts"), f("src/auth/session.test.ts")], []);
    expect(label).toContain("auth");
    expect(label).toBe("auth/session");
  });

  it("uses changed symbols when known (sessionStore → session)", () => {
    const label = labelCluster([f("src/auth/session.ts")], ["sessionStore"]);
    expect(label).toContain("auth");
    expect(label).toContain("session");
  });

  it("labels migration clusters as `db: <stem> migration`", () => {
    const label = labelCluster(
      [f("db/migrations/0017_family_plans.sql"), f("db/migrations/0018_add_index.sql")],
      [],
    );
    expect(label).toContain("migration");
    expect(label).toMatch(/^db: /);
    expect(label).toContain("family_plans"); // dominant stem, version prefix stripped
  });

  it("labels pure-stylesheet clusters as UI polish", () => {
    expect(
      labelCluster([f("src/ui/card.module.css"), f("src/ui/page.css")], []),
    ).toBe("UI polish");
  });

  it("detects CRUD clusters from symbols (de-pluralized stem match)", () => {
    const label = labelCluster(
      [f("src/routes/profiles.ts")],
      ["createProfile", "listProfiles", "updateProfile", "deleteProfile"],
    );
    expect(label).toBe("profiles CRUD");
  });

  it("falls back to directory + dominant stem when no symbols are known", () => {
    const label = labelCluster([f("api/users.ts"), f("api/teams.ts")], []);
    expect(label).toBe("api/users");
  });

  it("handles root-level files without crashing", () => {
    const label = labelCluster([f("package.json"), f("README.md")], []);
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
  });

  it("never exceeds the length cap", () => {
    const label = labelCluster(
      [f("src/someverylongdirectoryname/averylongfilenamestem.ts")],
      ["anextremelylongsymbolnamethatkeepsgoing"],
    );
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
  });

  it("is deterministic", () => {
    const files = [f("src/auth/session.ts"), f("src/auth/session.test.ts")];
    expect(labelCluster(files, ["sessionStore"])).toBe(labelCluster(files, ["sessionStore"]));
  });
});
