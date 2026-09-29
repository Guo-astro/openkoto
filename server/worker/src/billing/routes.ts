import { Hono } from "hono";
import type { AppBindings, Env } from "../env";
import { principalOf, requireAuth, requireSession } from "../auth/middleware";
import { hmacSha256Hex, newId, randomFrom32, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { ApiError, badRequest, forbidden, notFound } from "../lib/http";
import { PRO_MONTHLY_CREDITS, productForSku, SKUS, skuById, skuForProduct, type Sku } from "./catalog";
import { addCredits, addCreditsOnce } from "./credits";
import { extendByDays, grantPeriodCredits, setAutoRenew, setSubscriptionStatus, upsertSubscription } from "./subscriptions";

const DAY_MS = 24 * 60 * 60 * 1000;

function creemBase(env: Env): string {
  return env.CREEM_API_BASE ?? "https://api.creem.io";
}

// ---- activation codes ------------------------------------------------------

/** Codes look like OK-XXXX-XXXX-XXXX; normalised to upper case without separators before hashing. */
export function normalizeActivationCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

async function hashActivationCode(code: string): Promise<string> {
  return sha256Hex(`activation:${normalizeActivationCode(code)}`);
}

export async function generateActivationCodes(
  env: Env,
  opts: { batch: string; plan: "plus" | "pro" | null; durationDays: number; credits: number; count: number },
): Promise<string[]> {
  const codes: string[] = [];
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < opts.count; i++) {
    const raw = randomFrom32(12);
    const code = `OK-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    codes.push(code);
    statements.push(
      env.DB.prepare(
        "insert into activation_codes (code_hash, batch, plan, duration_days, credits, created_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(await hashActivationCode(code), opts.batch, opts.plan, opts.durationDays, opts.credits, now),
    );
  }
  await env.DB.batch(statements);
  return codes;
}

async function redeemActivationCode(env: Env, userId: string, code: string) {
  const hash = await hashActivationCode(code);
  const claimed = await env.DB.prepare(
    "update activation_codes set redeemed_by = ?, redeemed_at = ? where code_hash = ? and redeemed_at is null returning plan, duration_days, credits",
  )
    .bind(userId, Date.now(), hash)
    .first<{ plan: "plus" | "pro" | null; duration_days: number; credits: number }>();
  if (!claimed) throw notFound("code is invalid or already used");
  let periodEnd: number | null = null;
  if (claimed.plan && claimed.duration_days > 0) periodEnd = await extendByDays(env, userId, claimed.plan, claimed.duration_days, `code:${hash}`);
  if (claimed.credits > 0) await addCredits(env, userId, claimed.credits, "redeem", `code:${hash}`);
  return { plan: claimed.plan, credits: claimed.credits, periodEnd: periodEnd ? new Date(periodEnd).toISOString() : null };
}

// ---- Creem -----------------------------------------------------------------

interface CreemEvent {
  id: string;
  eventType: string;
  object: Record<string, unknown>;
}

function pick<T>(obj: unknown, path: string): T | undefined {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur as T;
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return pick<string>(value, "id");
}

function periodEndFromData(subscription: unknown): number | null {
  const raw = pick<string>(subscription, "current_period_end_date");
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function periodEndOf(subscription: unknown, sku: Sku): number {
  return periodEndFromData(subscription) ?? Date.now() + (sku.durationDays ?? 31) * DAY_MS;
}

async function userIdForEvent(env: Env, obj: Record<string, unknown>): Promise<string | null> {
  const fromMeta = pick<string>(obj, "metadata.userId") ?? pick<string>(obj, "subscription.metadata.userId");
  if (fromMeta) return fromMeta;
  const email = pick<string>(obj, "customer.email");
  if (!email) return null;
  const row = await env.DB.prepare('select id from "user" where lower(email) = lower(?)').bind(email).first<{ id: string }>();
  return row?.id ?? null;
}

export async function handleCreemEvent(env: Env, event: CreemEvent): Promise<"processed" | "duplicate" | "ignored"> {
  // Marked as processed only after success, so a failed attempt is retried by Creem.
  // Every grant below is idempotent on its own, so a concurrent duplicate is harmless.
  const seen = await env.DB.prepare("select 1 from payment_events where channel = 'creem' and external_event_id = ?").bind(event.id).first();
  if (seen) return "duplicate";
  const result = await processCreemEvent(env, event);
  await env.DB.prepare("insert or ignore into payment_events (channel, external_event_id, received_at) values ('creem', ?, ?)")
    .bind(event.id, Date.now())
    .run();
  return result;
}

async function processCreemEvent(env: Env, event: CreemEvent): Promise<"processed" | "ignored"> {

  const obj = event.object;
  const productId = idOf(obj.product) ?? idOf(pick(obj, "subscription.product"));
  const sku = productId ? skuForProduct(env.CREEM_PRODUCTS, productId) : undefined;
  const userId = await userIdForEvent(env, obj);
  if (!sku || !userId) {
    console.warn("creem event ignored", event.eventType, { productId, hasUser: !!userId });
    return "ignored";
  }

  switch (event.eventType) {
    case "checkout.completed": {
      if (sku.kind === "credits") {
        await addCreditsOnce(env, userId, sku.credits ?? 0, "purchase", `creem:${idOf(obj.order) ?? event.id}`);
        return "processed";
      }
      // Activate right away; period credits are granted by subscription.paid only, so the
      // two events can't both grant for the same period.
      const subscription = obj.subscription;
      const subId = idOf(subscription) ?? `order:${idOf(obj.order) ?? event.id}`;
      await upsertSubscription(env, { userId, plan: sku.plan!, channel: "creem", externalId: subId, periodEnd: periodEndOf(subscription, sku) });
      return "processed";
    }
    case "subscription.active":
    case "subscription.paid":
    case "subscription.update": {
      if (sku.kind !== "subscription") return "ignored";
      const subId = idOf(obj) ?? event.id;
      const dataPeriodEnd = periodEndFromData(obj);
      await upsertSubscription(env, { userId, plan: sku.plan!, channel: "creem", externalId: subId, periodEnd: dataPeriodEnd ?? periodEndOf(obj, sku) });
      if (sku.credits && event.eventType === "subscription.paid") {
        // One grant per billing period; fall back to the event id so retries stay idempotent.
        await grantPeriodCredits(env, userId, sku.credits, `creem:${subId}:${dataPeriodEnd ?? event.id}`);
      }
      return "processed";
    }
    case "subscription.canceled":
      // Access continues until the paid period ends; only renewal stops (refunds stay refunded).
      await setAutoRenew(env, "creem", idOf(obj) ?? "", false);
      return "processed";
    case "subscription.expired":
      await setSubscriptionStatus(env, "creem", idOf(obj) ?? "", "expired", false);
      return "processed";
    case "refund.created": {
      const subId = idOf(obj.subscription);
      if (subId) await setSubscriptionStatus(env, "creem", subId, "refunded", false);
      return "processed";
    }
    default:
      return "ignored";
  }
}

export const billingApi = new Hono<AppBindings>()
  .get("/plans", (c) =>
    c.json({
      skus: SKUS.map((s) => ({ ...s, web: s.channels.includes("creem") && !!productForSku(c.env.CREEM_PRODUCTS, s.id) })),
    }),
  )

  .post("/checkout", requireSession(), async (c) => {
    const p = principalOf(c);
    const { sku: skuId } = (await c.req.json()) as { sku?: string };
    const sku = skuId ? skuById(skuId) : undefined;
    const productId = sku ? productForSku(c.env.CREEM_PRODUCTS, sku.id) : undefined;
    if (!sku || !productId || !sku.channels.includes("creem")) throw badRequest("this plan is not sold on the web");
    if (!c.env.CREEM_API_KEY) throw new ApiError(503, "BILLING_UNAVAILABLE", "payments are not configured");
    const res = await fetch(`${creemBase(c.env)}/v1/checkouts`, {
      method: "POST",
      headers: { "x-api-key": c.env.CREEM_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        request_id: newId(),
        success_url: `${c.env.APP_ORIGIN}/account?paid=1`,
        customer: { email: p.email },
        metadata: { userId: p.userId, sku: sku.id },
      }),
    });
    if (!res.ok) {
      console.error("creem checkout failed", res.status, await res.text());
      throw new ApiError(502, "BILLING_ERROR", "could not start checkout");
    }
    const body = (await res.json()) as { checkout_url?: string };
    if (!body.checkout_url) throw new ApiError(502, "BILLING_ERROR", "could not start checkout");
    return c.json({ url: body.checkout_url });
  })

  .post("/redeem", requireAuth("account"), async (c) => {
    const { code } = (await c.req.json()) as { code?: string };
    if (!code || normalizeActivationCode(code).length < 10) throw badRequest("invalid code");
    return c.json({ ok: true, ...(await redeemActivationCode(c.env, principalOf(c).userId, code)) });
  });

export const webhooksApi = new Hono<AppBindings>().post("/creem", async (c) => {
  if (!c.env.CREEM_WEBHOOK_SECRET) throw new ApiError(503, "BILLING_UNAVAILABLE", "webhook secret not configured");
  const raw = new TextDecoder().decode(await c.req.arrayBuffer());
  const signature = c.req.header("creem-signature") ?? "";
  const expected = await hmacSha256Hex(c.env.CREEM_WEBHOOK_SECRET, raw);
  if (!timingSafeEqual(signature, expected)) throw forbidden("invalid signature");
  const result = await handleCreemEvent(c.env, JSON.parse(raw) as CreemEvent);
  return c.json({ ok: true, result });
});

function isAdmin(env: Env, email: string): boolean {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

export const adminApi = new Hono<AppBindings>()
  .use(requireSession())
  .use(async (c, next) => {
    if (!isAdmin(c.env, principalOf(c).email)) throw forbidden("admin only");
    await next();
  })
  .post("/codes", async (c) => {
    const body = (await c.req.json()) as { batch?: string; plan?: "plus" | "pro" | null; durationDays?: number; credits?: number; count?: number };
    const count = Math.min(Math.max(Number(body.count ?? 1), 1), 500);
    const plan = body.plan === "plus" || body.plan === "pro" ? body.plan : null;
    const durationDays = Math.max(0, Number(body.durationDays ?? 0));
    // Pro includes AI credits: unless given, a Pro code carries the monthly allotment for each 30 days.
    const credits = Math.max(0, Number(body.credits ?? (plan === "pro" ? PRO_MONTHLY_CREDITS * Math.max(1, Math.round(durationDays / 30)) : 0)));
    if (!plan && !credits) throw badRequest("a code must grant a plan or credits");
    if (plan && !durationDays) throw badRequest("durationDays is required with a plan");
    const batch = String(body.batch ?? new Date().toISOString().slice(0, 10)).slice(0, 60);
    const codes = await generateActivationCodes(c.env, { batch, plan, durationDays, credits, count });
    return c.json({ batch, codes });
  })
  .get("/codes", async (c) => {
    const { results } = await c.env.DB.prepare(
      "select batch, plan, duration_days, credits, count(*) as total, count(redeemed_at) as redeemed from activation_codes group by batch, plan, duration_days, credits order by max(created_at) desc limit 100",
    ).all();
    return c.json({ batches: results });
  });
