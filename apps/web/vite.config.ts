import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In development the API runs under `wrangler dev` on :8787; proxy keeps cookies same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: false, ws: true },
      "/auth": { target: "http://localhost:8787", changeOrigin: false },
      "/.well-known": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
