import type { Env } from "../env";
import { newId } from "../lib/crypto";

// The ledger is append-only; the latest row's balance_after is the balance.
// Every write is a single INSERT … SELECT so the read-modify-write is atomic
// (D1 executes statements serially on the primary).

const LATEST_BALANCE =
  "coalesce((select balance_after from credit_ledger where user_id = ?1 order by created_at desc, rowid desc limit 1), 0)";

export async function creditBalance(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(`select ${LATEST_BALANCE} as balance`).bind(userId).first<{ balance: number }>();
  return row?.balance ?? 0;
}

export type CreditReason = "grant" | "purchase" | "reserve" | "settle" | "refund" | "expire" | "adjust" | "redeem";

/** Adds (or, with a negative delta, removes without a floor check) credits. Returns the new balance. */
export async function addCredits(env: Env, userId: string, delta: number, reason: CreditReason, refId: string | null, expiresAt: number | null = null): Promise<number> {
  const id = newId();
  await env.DB.prepare(
    `insert into credit_ledger (id, user_id, delta, reason, ref_id, balance_after, expires_at, created_at)
     select ?2, ?1, ?3, ?4, ?5, ${LATEST_BALANCE} + ?3, ?6, ?7`,
  )
    .bind(userId, id, delta, reason, refId, expiresAt, Date.now())
    .run();
  return creditBalance(env, userId);
}

/** Deducts `amount` only if the balance covers it. Returns false when it does not. */
export async function reserveCredits(env: Env, userId: string, amount: number, refId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `insert into credit_ledger (id, user_id, delta, reason, ref_id, balance_after, expires_at, created_at)
     select ?2, ?1, -?3, 'reserve', ?4, bal - ?3, null, ?5 from (select ${LATEST_BALANCE} as bal) where bal >= ?3`,
  )
    .bind(userId, newId(), amount, refId, Date.now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Settles a reservation: refunds the unused part (or charges the overrun, floored at zero balance). */
export async function settleCredits(env: Env, userId: string, reserved: number, actual: number, refId: string): Promise<void> {
  const diff = reserved - actual;
  if (diff === 0) return;
  if (diff > 0) {
    await addCredits(env, userId, diff, "settle", refId);
    return;
  }
  // Overrun: charge what the balance allows, never below zero.
  await env.DB.prepare(
    `insert into credit_ledger (id, user_id, delta, reason, ref_id, balance_after, expires_at, created_at)
     select ?2, ?1, -min(?3, bal), 'settle', ?4, bal - min(?3, bal), null, ?5 from (select ${LATEST_BALANCE} as bal) where bal > 0`,
  )
    .bind(userId, newId(), -diff, refId, Date.now())
    .run();
}
