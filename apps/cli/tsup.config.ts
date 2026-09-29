import { defineConfig } from "tsup";

export default defineConfig({
  entry: { koto: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // Workspace packages ship TypeScript source and are private: bundle them (and ts-fsrs, via core).
  noExternal: [/^@openkoto\//, "ts-fsrs"],
  banner: { js: "#!/usr/bin/env node" },
  splitting: false,
  sourcemap: false,
});
