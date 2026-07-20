/**
 * Disjoint-set (union-find) over string keys — §5.4 layer 3.
 *
 * Classic implementation with path compression and union by rank, giving
 * near-constant amortized `find`/`union`. Keys self-register as singleton
 * sets on first sight, so callers never need an explicit `add` step.
 * Iteration order of `groups()` follows first-insertion order, which keeps
 * downstream output deterministic for a deterministic input sequence.
 */
export class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  /**
   * Root representative of the set containing `key`.
   * Registers `key` as a singleton set when seen for the first time.
   */
  find(key: string): string {
    let root = this.parent.get(key);
    if (root === undefined) {
      this.parent.set(key, key);
      this.rank.set(key, 0);
      return key;
    }
    if (root !== key) {
      root = this.find(root);
      this.parent.set(key, root); // path compression
    }
    return root;
  }

  /** Merge the sets containing `a` and `b` (no-op when already merged). */
  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }

  /** All sets, as root → member keys. Singletons included. */
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const members = out.get(root);
      if (members) {
        members.push(key);
      } else {
        out.set(root, [key]);
      }
    }
    return out;
  }

  /** Number of registered keys (not the number of sets). */
  get size(): number {
    return this.parent.size;
  }
}
