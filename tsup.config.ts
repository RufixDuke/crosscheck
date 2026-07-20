import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  minify: false,
  // sql.js ships a WASM file loaded at runtime; keep it external so the bundle
  // stays a single file and the wasm resolves from node_modules.
  external: ["sql.js"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
