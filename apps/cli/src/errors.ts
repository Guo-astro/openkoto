import { ApiError } from "@openkoto/client";
import { ByokError } from "./byok";

/** Exit codes (design doc §10.1). */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_LOGGED_IN: 3,
  PLAN: 4,
} as const;

export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usageError = (message: string) => new CliError(EXIT.USAGE, "USAGE", message);
export const notLoggedIn = (message = "Not logged in. Run `koto login` (or set KOTO_API_KEY).") => new CliError(EXIT.NOT_LOGGED_IN, "NOT_LOGGED_IN", message);

export const UPGRADE_URL = "https://openkoto.com/pricing";

export function planRequired(message = `The koto CLI is part of OpenKoto Plus. Upgrade at ${UPGRADE_URL} — \`koto login\`, \`koto whoami\` and \`koto config\` keep working on the free plan.`) {
  return new CliError(EXIT.PLAN, "PLAN_REQUIRED", message);
}

const PLAN_CODES = new Set(["QUOTA_EXCEEDED", "PLAN_REQUIRED", "FREE_LIMIT_REACHED", "DAILY_LIMIT_REACHED", "INSUFFICIENT_CREDITS", "PAYMENT_REQUIRED"]);

/** Normalizes anything thrown by a command into a CliError. */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return new CliError(EXIT.NOT_LOGGED_IN, err.code, `${err.message}. Run \`koto login\` again (or check KOTO_API_KEY).`);
    }
    if (err.status === 402 || PLAN_CODES.has(err.code)) {
      const hint = err.code === "QUOTA_EXCEEDED" ? ` Upgrade to Plus for unlimited storage: ${UPGRADE_URL}` : "";
      return new CliError(EXIT.PLAN, err.code, `${err.message}.${hint}`);
    }
    return new CliError(EXIT.ERROR, err.code, `${err.message} (HTTP ${err.status})`);
  }
  if (err instanceof ByokError) return new CliError(EXIT.ERROR, "BYOK_ERROR", err.message);
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new CliError(EXIT.USAGE, "FILE_NOT_FOUND", err.message);
    if (err.name === "TypeError" && /fetch failed/i.test(err.message)) return new CliError(EXIT.ERROR, "NETWORK", `network error: ${err.message}`);
    return new CliError(EXIT.ERROR, "ERROR", err.message);
  }
  return new CliError(EXIT.ERROR, "ERROR", String(err));
}
