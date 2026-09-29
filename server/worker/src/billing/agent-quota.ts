import type { Env } from "../env";
import { ApiError } from "../lib/http";

/** Free accounts may make this many CLI/MCP calls per UTC day; Plus and Pro are unlimited. */
export const FREE_AGENT_DAILY_LIMIT = 50;

/** Requests the remote MCP server dispatches to the API in-process; the tool call was already counted. */
export const internalRequests = new WeakSet<Request>();

export function freeLimitMessage(): string {
  return `The free plan includes ${FREE_AGENT_DAILY_LIMIT} CLI/MCP calls per day and today's are used up. They reset at 00:00 UTC; OpenKoto Plus removes the limit: https://openkoto.com/pricing`;
}

/** Counts one call and reports whether it is still within today's free allowance. */
export async function consumeFreeAgentCall(env: Env, userId: string, now = Date.now()): Promise<{ used: number; limit: number; allowed: boolean }> {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "insert into agent_usage (user_id, day, count) values (?, ?, 1) on conflict (user_id, day) do update set count = count + 1 returning count",
  )
    .bind(userId, day)
    .first<{ count: number }>();
  const used = row?.count ?? 1;
  return { used, limit: FREE_AGENT_DAILY_LIMIT, allowed: used <= FREE_AGENT_DAILY_LIMIT };
}

export async function requireFreeAgentAllowance(env: Env, userId: string): Promise<void> {
  const { allowed } = await consumeFreeAgentCall(env, userId);
  if (!allowed) throw new ApiError(429, "FREE_LIMIT_REACHED", freeLimitMessage());
}
