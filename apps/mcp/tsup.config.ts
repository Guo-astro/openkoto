import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "openkoto-mcp": "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // Private workspace packages (TypeScript source) are bundled; the MCP SDK and zod stay npm deps.
  noExternal: [/^@openkoto\//, "ts-fsrs"],
  banner: { js: "#!/usr/bin/env node" },
  splitting: false,
});
