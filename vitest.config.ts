import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/rules/**", "src/cluster/**", "src/llm/redact.ts", "src/ingest/parse.ts"],
    },
  },
});
