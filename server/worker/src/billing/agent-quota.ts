import type { Plan } from "@openkoto/core";
import type { Env } from "../env";
import { ApiError } from "../lib/http";

/** CLI/MCP/access-token calls per UTC day. Every plan is capped; free is a taster. */
export const AGENT_DAILY_LIMITS: Record<Plan, number> = { free: 50, plus: 2_000, pro: 5_000 };
export const FREE_AGENT_DAILY_LIMIT = AGENT_DAILY_LIMITS.free;

/** Active access tokens (OpenKoto API keys) per account. */
export const API_KEY_LIMITS: Record<Plan, number> = { free: 1, plus: 10, pro: 20 };

/** Requests the remote MCP server dispatches to the API in-process; the tool call was already counted. */
export const internalRequests = new WeakSet<Request>();

export function agentLimitMessage(plan: Plan): string {
  const limit = AGENT_DAILY_LIMITS[plan];
  return plan === "free"
    ? `The free plan includes ${limit} CLI/MCP calls per day and today's are used up. They reset at 00:00 UTC; OpenKoto Plus raises the limit to ${AGENT_DAILY_LIMITS.plus}: https://openkoto.com/pricing`
    : `Today's ${limit} CLI/MCP calls are used up. They reset at 00:00 UTC.`;
}

/** Counts one call and reports whether it is still within today's allowance for the plan. */
export async function consumeAgentCall(env: Env, userId: string, plan: Plan, now = Date.now()): Promise<{ used: number; limit: number; allowed: boolean }> {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "insert into agent_usage (user_id, day, count) values (?, ?, 1) on conflict (user_id, day) do update set count = count + 1 returning count",
  )
    .bind(userId, day)
    .first<{ count: number }>();
  const used = row?.count ?? 1;
  const limit = AGENT_DAILY_LIMITS[plan];
  return { used, limit, allowed: used <= limit };
}

export async function requireAgentAllowance(env: Env, userId: string, plan: Plan): Promise<void> {
  const { allowed } = await consumeAgentCall(env, userId, plan);
  if (!allowed) throw new ApiError(429, plan === "free" ? "FREE_LIMIT_REACHED" : "DAILY_LIMIT_REACHED", agentLimitMessage(plan));
}
