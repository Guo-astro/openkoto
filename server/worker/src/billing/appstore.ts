import { Hono } from "hono";
import { decodeJwt, decodeProtectedHeader, importPKCS8, SignJWT } from "jose";
import type { AppBindings, Env } from "../env";
import { principalOf, requireAuth } from "../auth/middleware";
import { ApiError, badRequest, forbidden } from "../lib/http";
import { skuById, type Sku } from "./catalog";
import { addCreditsOnce } from "./credits";
import { grantDueProCredits } from "./pro-credits";
import { setAutoRenew, setSubscriptionStatus, upsertSubscription } from "./subscriptions";

// Trust model: payloads sent by the app (or in notifications) are only used to learn the
// transactionId. The authoritative transaction is then fetched from the App Store Server
// API over TLS with our own API key, so no client-supplied JWS is ever trusted.

const PRODUCTION = "https://api.storekit.itunes.apple.com";
const SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";

const DEFAULT_PRODUCTS: Record<string, string> = {
  "com.openkoto.plus.month": "plus_month",
  "com.openkoto.plus.year": "plus_year",
  "com.openkoto.pro.month": "pro_month",
  "com.openkoto.pro.year": "pro_year",
  "com.openkoto.credits.3000": "credits_3000",
};

export interface AppStoreTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  appAccountToken?: string;
  expiresDate?: number;
  revocationDate?: number;
  environment: string;
  type: string;
}

function skuForAppStoreProduct(env: Env, productId: string): Sku | undefined {
  const mapping = { ...DEFAULT_PRODUCTS, ...(env.APPSTORE_PRODUCTS ? (JSON.parse(env.APPSTORE_PRODUCTS) as Record<string, string>) : {}) };
  const skuId = mapping[productId];
  return skuId ? skuById(skuId) : undefined;
}

async function apiToken(env: Env): Promise<string> {
  if (!env.APPSTORE_ISSUER_ID || !env.APPSTORE_KEY_ID || !env.APPSTORE_PRIVATE_KEY) {
    throw new ApiError(503, "BILLING_UNAVAILABLE", "App Store API is not configured");
  }
  const key = await importPKCS8(env.APPSTORE_PRIVATE_KEY, "ES256");
  return new SignJWT({ bid: env.APPLE_APP_BUNDLE_ID })
    .setProtectedHeader({ alg: "ES256", kid: env.APPSTORE_KEY_ID, typ: "JWT" })
    .setIssuer(env.APPSTORE_ISSUER_ID)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt()
    .setExpirationTime("20m")
    .sign(key);
}

/** Fetches a transaction from Apple (production first, then sandbox). */
export async function fetchTransaction(env: Env, transactionId: string, doFetch: typeof fetch = fetch): Promise<AppStoreTransaction> {
  if (!/^\d+$/.test(transactionId)) throw badRequest("invalid transaction id");
  const token = await apiToken(env);
  const bases = env.APPSTORE_ENVIRONMENT === "Sandbox" ? [SANDBOX] : [PRODUCTION, SANDBOX];
  for (const base of bases) {
    const res = await doFetch(`${base}/inApps/v1/transactions/${transactionId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) continue;
    if (!res.ok) throw new ApiError(502, "BILLING_ERROR", `App Store API error ${res.status}`);
    const body = (await res.json()) as { signedTransactionInfo: string };
    // Received directly from Apple over TLS; decoding (not verifying) the JWS is sufficient.
    return decodeJwt(body.signedTransactionInfo) as unknown as AppStoreTransaction;
  }
  throw new ApiError(404, "NOT_FOUND", "transaction not found");
}

function transactionIdFromJws(jws: string): string {
  try {
    decodeProtectedHeader(jws);
    const payload = decodeJwt(jws) as { transactionId?: string };
    if (payload.transactionId) return String(payload.transactionId);
  } catch {
    // fall through
  }
  throw badRequest("invalid signed transaction");
}

const SANDBOX_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Applies an Apple-confirmed transaction to the user's entitlements. Idempotent.
 * Sandbox purchases (TestFlight, App Review) are honoured on production so reviewers see a
 * working purchase, but only as a short plan and never as credits (which cost real money).
 */
export async function applyTransaction(env: Env, userId: string, tx: AppStoreTransaction): Promise<{ sku: string; plan: string | null }> {
  if (tx.bundleId !== env.APPLE_APP_BUNDLE_ID) throw forbidden("bundle id mismatch");
  const sku = skuForAppStoreProduct(env, tx.productId);
  if (!sku) throw badRequest(`unknown product ${tx.productId}`);
  const sandboxOnProduction = tx.environment !== "Production" && env.APPSTORE_ENVIRONMENT !== "Sandbox";

  if (sku.kind === "credits") {
    if (tx.revocationDate || sandboxOnProduction) return { sku: sku.id, plan: null };
    await addCreditsOnce(env, userId, sku.credits ?? 0, "purchase", `appstore:${tx.transactionId}`);
    return { sku: sku.id, plan: null };
  }

  const externalId = tx.originalTransactionId;
  if (tx.revocationDate) {
    await setSubscriptionStatus(env, "appstore", externalId, "refunded", false);
    return { sku: sku.id, plan: sku.plan ?? null };
  }
  let periodEnd = tx.expiresDate ?? Date.now();
  if (sandboxOnProduction) periodEnd = Math.min(periodEnd, Date.now() + SANDBOX_GRACE_MS);
  const channel = sandboxOnProduction ? "appstore_sandbox" : "appstore";
  await upsertSubscription(env, { userId, plan: sku.plan!, channel, externalId, periodEnd, status: periodEnd > Date.now() ? "active" : "expired" });
  // Pro's included credits come from the monthly schedule (sandbox subscriptions are excluded there).
  if (periodEnd > Date.now() && !sandboxOnProduction) await grantDueProCredits(env, userId);
  return { sku: sku.id, plan: sku.plan ?? null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The appAccountToken iOS attaches to purchases (OKCommerce AppAccountToken.forUser):
 * the user id itself when it is a UUID, otherwise a v5-style UUID from
 * sha256("openkoto.appAccountToken:" + id)[0..<16].
 */
export async function appAccountTokenFor(userId: string): Promise<string> {
  if (UUID_RE.test(userId)) return userId.toLowerCase();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`openkoto.appAccountToken:${userId}`)));
  const b = digest.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function belongsTo(token: string | undefined, userId: string): Promise<boolean> {
  return !!token && token.toLowerCase() === (await appAccountTokenFor(userId));
}

export const appStoreApi = new Hono<AppBindings>().post("/verify", requireAuth("account"), async (c) => {
  const p = principalOf(c);
  const { signedTransaction } = (await c.req.json()) as { signedTransaction?: string };
  if (!signedTransaction) throw badRequest("signedTransaction is required");
  const tx = await fetchTransaction(c.env, transactionIdFromJws(signedTransaction));
  // Purchases are bound to accounts via appAccountToken = user id.
  if (!(await belongsTo(tx.appAccountToken, p.userId))) throw forbidden("transaction belongs to a different account");
  return c.json({ ok: true, ...(await applyTransaction(c.env, p.userId, tx)) });
});

/** App Store Server Notifications V2. */
export async function handleAppStoreNotification(env: Env, signedPayload: string): Promise<string> {
  const payload = decodeJwt(signedPayload) as { notificationUUID?: string; notificationType?: string; data?: { signedTransactionInfo?: string } };
  if (!payload.notificationUUID) throw badRequest("invalid notification");
  // The notification body is unverified; only its transactionId is used, and the transaction
  // itself is re-fetched from Apple. Mark it processed only after success so retries work.
  const seen = await env.DB.prepare("select 1 from payment_events where channel = 'appstore' and external_event_id = ?").bind(payload.notificationUUID).first();
  if (seen) return "duplicate";
  const info = payload.data?.signedTransactionInfo;
  if (!info) return "ignored";
  const tx = await fetchTransaction(env, transactionIdFromJws(info));
  const userId = tx.appAccountToken?.toLowerCase();
  if (!userId) return "ignored";
  const user = await env.DB.prepare('select id from "user" where lower(id) = ?').bind(userId).first<{ id: string }>();
  if (!user) return "ignored";
  await applyTransaction(env, user.id, tx);
  if (payload.notificationType === "DID_CHANGE_RENEWAL_STATUS") {
    const sub = (payload as { subtype?: string }).subtype;
    await setAutoRenew(env, "appstore", tx.originalTransactionId, sub === "AUTO_RENEW_ENABLED");
  }
  await env.DB.prepare("insert or ignore into payment_events (channel, external_event_id, received_at) values ('appstore', ?, ?)")
    .bind(payload.notificationUUID, Date.now())
    .run();
  return "processed";
}

export const appStoreWebhook = new Hono<AppBindings>().post("/appstore", async (c) => {
  const { signedPayload } = (await c.req.json()) as { signedPayload?: string };
  if (!signedPayload) throw badRequest("signedPayload is required");
  return c.json({ ok: true, result: await handleAppStoreNotification(c.env, signedPayload) });
});
