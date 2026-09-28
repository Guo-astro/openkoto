// Library entry (used by @openkoto/mcp): config/credentials, typed library client, BYOK helpers.
// Deliberately does not export the commander program (src/cli.ts) so consumers stay light.
export * from "./config";
export * from "./library";
export * from "./byok";
export * from "./lyrics";
export * from "./errors";
