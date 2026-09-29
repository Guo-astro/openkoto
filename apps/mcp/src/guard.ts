import type { AccountSummary } from "@openkoto/client";

export class GuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Login + plan check run before each tool. Agent access (CLI/MCP) is an OpenKoto Plus
 * feature; a positive answer is cached for the life of the process, a negative one is
 * re-checked after a minute so upgrading takes effect without a restart.
 */
export function createGuard(source: "api_key" | "credentials" | "none", me: () => Promise<AccountSummary>, now: () => number = Date.now) {
  let entitled = false;
  let deniedAt = 0;
  return async () => {
    if (source === "none") throw new GuardError("NOT_LOGGED_IN", "Not signed in to OpenKoto. Ask the user to run `koto login` (or set KOTO_API_KEY) and restart the MCP server.");
    if (entitled) return;
    if (deniedAt && now() - deniedAt < 60_000) throw planError();
    const summary = await me();
    if (!summary.entitlements.cli) {
      deniedAt = now();
      throw planError();
    }
    entitled = true;
  };
}

function planError() {
  return new GuardError("PLAN_REQUIRED", "Agent access (CLI/MCP) is part of OpenKoto Plus. The user can upgrade at https://openkoto.com/pricing.");
}
