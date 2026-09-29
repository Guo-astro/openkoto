import type { Env } from "../env";
import { PRO_MONTHLY_CREDITS } from "./catalog";
import { addCreditsOnce } from "./credits";

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pro gets PRO_MONTHLY_CREDITS every 30 days while it is active, whatever the channel
 * (Creem, App Store, activation code) or billing period. Yearly Pro is paid out in 12
 * monthly grants, not up front. Safe to call any time: at most one grant per period.
 */
export async function grantDueProCredits(env: Env, userId: string, now = Date.now()): Promise<boolean> {
  // Sandbox purchases honoured on production (App Review, TestFlight) never earn credits.
  const pro = await env.DB.prepare(
    "select 1 as ok from subscriptions where user_id = ? and plan = 'pro' and status = 'active' and period_end > ? and channel <> 'appstore_sandbox' limit 1",
  )
    .bind(userId, now)
    .first<{ ok: number }>();
  if (!pro) return false;
  // Claim the period atomically; only the caller that moves next_grant_at forward grants.
  const claimed = await env.DB.prepare(
    `insert into pro_credit_schedule (user_id, next_grant_at) values (?, ?)
     on conflict (user_id) do update set next_grant_at = excluded.next_grant_at
     where pro_credit_schedule.next_grant_at <= ?
     returning next_grant_at`,
  )
    .bind(userId, now + PERIOD_MS, now)
    .first<{ next_grant_at: number }>();
  if (!claimed) return false;
  await addCreditsOnce(env, userId, PRO_MONTHLY_CREDITS, "grant", `pro:${userId}:${claimed.next_grant_at}`);
  return true;
}

/** Daily cron: pays out whatever monthly Pro credits have come due. */
export async function grantAllDueProCredits(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `select distinct s.user_id from subscriptions s
     left join pro_credit_schedule p on p.user_id = s.user_id
     where s.plan = 'pro' and s.status = 'active' and s.period_end > ? and s.channel <> 'appstore_sandbox' and (p.next_grant_at is null or p.next_grant_at <= ?)`,
  )
    .bind(now, now)
    .all<{ user_id: string }>();
  let granted = 0;
  for (const { user_id } of results) if (await grantDueProCredits(env, user_id, now)) granted++;
  return granted;
}
