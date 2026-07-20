import { describe, expect, it } from "vitest";
import { AFFINITY_THRESHOLD, pathAffinity, pathStem } from "../../../src/cluster/affinity.js";

describe("pathAffinity — must cluster (≥ threshold)", () => {
  it("identical paths score 1", () => {
    expect(pathAffinity("src/a.ts", "src/a.ts")).toBe(1);
  });

  it("same directory, unrelated stems", () => {
    expect(pathAffinity("src/auth/a.ts", "src/auth/b.ts")).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
  });

  it("same directory, test/impl stem pair", () => {
    expect(
      pathAffinity("src/auth/session.ts", "src/auth/session.test.ts"),
    ).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
  });

  it("test-mirror across roots (shared layer + stem)", () => {
    expect(
      pathAffinity("src/auth/session.ts", "tests/auth/session.test.ts"),
    ).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
  });

  it("root-level files share the root directory", () => {
    expect(pathAffinity("README.md", "package.json")).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
  });

  it("deep shared directory prefix", () => {
    expect(
      pathAffinity("a/b/c/d/x.ts", "a/b/c/e/y.ts"),
    ).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
  });

  it("same monorepo package clusters normally", () => {
    expect(
      pathAffinity("packages/web/src/auth/x.ts", "packages/web/src/auth/y.ts"),
    ).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
  });
});

describe("pathAffinity — must NOT cluster (< threshold)", () => {
  it("sibling layer dirs under src/", () => {
    expect(
      pathAffinity("src/auth/x.ts", "src/components/y.tsx"),
    ).toBeLessThan(AFFINITY_THRESHOLD);
  });

  it("unrelated trees", () => {
    expect(pathAffinity("docs/guide.md", "src/auth/x.ts")).toBeLessThan(AFFINITY_THRESHOLD);
  });

  it("generic stems (index.ts) in sibling dirs do not cluster", () => {
    expect(
      pathAffinity("src/auth/index.ts", "src/routes/index.ts"),
    ).toBeLessThan(AFFINITY_THRESHOLD);
  });

  it("different monorepo packages are kept apart (§11.7)", () => {
    expect(
      pathAffinity("packages/web/src/auth/session.ts", "packages/api/src/auth/session.ts"),
    ).toBeLessThan(AFFINITY_THRESHOLD);
  });

  it("top-level layer dirs without other signal", () => {
    expect(pathAffinity("auth/x.ts", "db/y.ts")).toBeLessThan(AFFINITY_THRESHOLD);
  });
});

describe("pathAffinity — properties", () => {
  it("is deterministic and symmetric", () => {
    const pairs: Array<[string, string]> = [
      ["src/auth/session.ts", "src/auth/session.test.ts"],
      ["packages/web/a.ts", "packages/api/b.ts"],
      ["a/b/c.ts", "a/d/e.ts"],
    ];
    for (const [a, b] of pairs) {
      expect(pathAffinity(a, b)).toBe(pathAffinity(a, b));
      expect(pathAffinity(a, b)).toBe(pathAffinity(b, a));
    }
  });

  it("stays within [0, 1]", () => {
    const paths = [
      "src/auth/session.ts",
      "tests/auth/session.test.ts",
      "README.md",
      "packages/web/src/index.ts",
      "db/migrations/0017_family.sql",
    ];
    for (const a of paths) {
      for (const b of paths) {
        const score = pathAffinity(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("pathStem", () => {
  it("strips secondary suffixes", () => {
    expect(pathStem("src/auth/session.test.ts")).toBe("session");
    expect(pathStem("src/auth/session.types.ts")).toBe("session");
    expect(pathStem("src/ui/card.module.css")).toBe("card");
    expect(pathStem("src/api/client.d.ts")).toBe("client");
    expect(pathStem("db/migrations/0017_family.sql")).toBe("0017_family");
  });
});
