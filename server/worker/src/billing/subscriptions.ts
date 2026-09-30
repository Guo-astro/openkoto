import type { Plan } from "@openkoto/core";
import type { Env } from "../env";
import { newId } from "../lib/crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrantInput {
  userId: string;
  plan: Plan;
  /** appstore_sandbox: TestFlight/App Review purchases honoured on production (never earn credits). */
  channel: "creem" | "appstore" | "appstore_sandbox" | "code";
  externalId: string;
  periodEnd: number;
  autoRenew?: boolean;
  status?: "active" | "canceled" | "expired" | "refunded";
}

/** Inserts or updates a subscription keyed by (channel, externalId). */
export async function upsertSubscription(env: Env, g: GrantInput): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `insert into subscriptions (id, user_id, plan, channel, external_id, status, period_end, auto_renew, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (channel, external_id) do update set plan = excluded.plan,
       status = case when subscriptions.status = 'refunded' then 'refunded' else excluded.status end,
       period_end = max(subscriptions.period_end, excluded.period_end), auto_renew = excluded.auto_renew, updated_at = excluded.updated_at`,
  )
    .bind(newId(), g.userId, g.plan, g.channel, g.externalId, g.status ?? "active", g.periodEnd, g.autoRenew === false ? 0 : 1, now, now)
    .run();
}

/** Renewal toggles only change auto_renew; they never alter status (refunds stay refunded). */
export async function setAutoRenew(env: Env, channel: string, externalId: string, autoRenew: boolean): Promise<void> {
  await env.DB.prepare("update subscriptions set auto_renew = ?, updated_at = ? where channel = ? and external_id = ?")
    .bind(autoRenew ? 1 : 0, Date.now(), channel, externalId)
    .run();
}

export async function setSubscriptionStatus(env: Env, channel: string, externalId: string, status: string, autoRenew?: boolean): Promise<void> {
  await env.DB.prepare(
    "update subscriptions set status = case when status = 'refunded' then 'refunded' else ? end, auto_renew = coalesce(?, auto_renew), updated_at = ? where channel = ? and external_id = ?",
  )
    .bind(status, autoRenew === undefined ? null : autoRenew ? 1 : 0, Date.now(), channel, externalId)
    .run();
}

/**
 * Activation codes stack onto the user's existing access: the new period starts when their
 * current period of the same (or higher) plan ends.
 */
export async function extendByDays(env: Env, userId: string, plan: Plan, days: number, externalId: string): Promise<number> {
  const row = await env.DB.prepare(
    "select max(period_end) as end from subscriptions where user_id = ? and status = 'active' and (plan = ? or plan = 'pro')",
  )
    .bind(userId, plan)
    .first<{ end: number | null }>();
  const start = Math.max(Date.now(), row?.end ?? 0);
  const periodEnd = start + days * DAY_MS;
  await upsertSubscription(env, { userId, plan, channel: "code", externalId, periodEnd, autoRenew: false });
  return periodEnd;
}

