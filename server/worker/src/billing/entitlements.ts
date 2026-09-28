import type { Plan } from "@openkoto/core";
import type { Env } from "../env";

const RANK: Record<Plan, number> = { free: 0, plus: 1, pro: 2 };

export function higherPlan(a: Plan, b: Plan): Plan {
  return RANK[a] >= RANK[b] ? a : b;
}

export function planAtLeast(plan: Plan, required: Plan): boolean {
  return RANK[plan] >= RANK[required];
}

export interface ActiveSubscription {
  plan: Plan;
  channel: string;
  periodEnd: number;
  autoRenew: boolean;
}

export async function activeSubscriptions(env: Env, userId: string, now = Date.now()): Promise<ActiveSubscription[]> {
  const { results } = await env.DB.prepare(
    "select plan, channel, period_end, auto_renew from subscriptions where user_id = ? and status = 'active' and period_end > ? order by period_end desc",
  )
    .bind(userId, now)
    .all<{ plan: Plan; channel: string; period_end: number; auto_renew: number }>();
  return results.map((r) => ({ plan: r.plan, channel: r.channel, periodEnd: r.period_end, autoRenew: r.auto_renew === 1 }));
}

export async function currentPlan(env: Env, userId: string, now = Date.now()): Promise<Plan> {
  let plan: Plan = "free";
  for (const sub of await activeSubscriptions(env, userId, now)) plan = higherPlan(plan, sub.plan);
  return plan;
}
