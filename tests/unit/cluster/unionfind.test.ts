import { describe, expect, it } from "vitest";
import { UnionFind } from "../../../src/cluster/unionfind.js";

describe("UnionFind", () => {
  it("registers unknown keys as singletons on find", () => {
    const uf = new UnionFind();
    expect(uf.find("a")).toBe("a");
    expect(uf.size).toBe(1);
    expect(uf.groups().get("a")).toEqual(["a"]);
  });

  it("unions two keys into one set", () => {
    const uf = new UnionFind();
    uf.union("a", "b");
    expect(uf.find("a")).toBe(uf.find("b"));
    const groups = [...uf.groups().values()];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(["a", "b"]);
  });

  it("merges transitively", () => {
    const uf = new UnionFind();
    uf.union("a", "b");
    uf.union("b", "c");
    uf.union("d", "e");
    expect(uf.find("a")).toBe(uf.find("c"));
    expect(uf.find("a")).not.toBe(uf.find("d"));
    const sets = [...uf.groups().values()].map((g) => g.slice().sort());
    expect(sets).toHaveLength(2);
    expect(sets).toContainEqual(["a", "b", "c"]);
    expect(sets).toContainEqual(["d", "e"]);
  });

  it("keeps disjoint sets separate", () => {
    const uf = new UnionFind();
    for (const k of ["a", "b", "c", "d"]) uf.find(k);
    uf.union("a", "c");
    expect(uf.find("b")).toBe("b");
    expect(uf.find("d")).toBe("d");
    expect([...uf.groups().keys()]).toHaveLength(3);
  });

  it("union is idempotent and symmetric", () => {
    const uf = new UnionFind();
    uf.union("a", "b");
    uf.union("a", "b");
    uf.union("b", "a");
    expect([...uf.groups().values()]).toHaveLength(1);
  });

  it("group keys are members of their own set and cover every key once", () => {
    const uf = new UnionFind();
    const keys = ["a", "b", "c", "d", "e", "f"];
    uf.union("a", "b");
    uf.union("c", "d");
    uf.union("d", "e");
    uf.find("f");
    const groups = uf.groups();
    const allMembers = [...groups.values()].flat();
    expect(allMembers.slice().sort()).toEqual(keys);
    for (const [root, members] of groups) {
      expect(members).toContain(root);
      for (const member of members) expect(uf.find(member)).toBe(root);
    }
  });

  it("handles larger chains without deep recursion issues (union by rank)", () => {
    const uf = new UnionFind();
    const n = 500;
    for (let i = 1; i < n; i++) uf.union(`k${i - 1}`, `k${i}`);
    expect([...uf.groups().values()]).toHaveLength(1);
    expect(uf.find("k0")).toBe(uf.find(`k${n - 1}`));
  });
});
