import { Hono } from "hono";
import type { AppBindings, Env } from "../env";
import { principalOf, requireAuth, requireSession } from "../auth/middleware";
import { getAuth } from "../auth/better-auth";
import { API_KEY_SCOPES, createApiKey } from "../auth/tokens";
import { AGENT_DAILY_LIMITS, API_KEY_LIMITS } from "../billing/agent-quota";
import { grantDueProCredits } from "../billing/pro-credits";
import { activeSubscriptions, currentPlan } from "../billing/entitlements";
import { creditBalance } from "../billing/credits";
import { vaultFor } from "../sync/routes";
import { forbidden, notFound } from "../lib/http";

const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_AUTH_MS = 5 * 60 * 1000;

export async function accountSummary(env: Env, userId: string) {
  const user = await env.DB.prepare('select id, email, name, image, "createdAt" as created_at from "user" where id = ?')
    .bind(userId)
    .first<{ id: string; email: string; name: string; image: string | null; created_at: string }>();
  if (!user) throw notFound("user not found");
  // Pay out any monthly Pro credits that came due since the last cron run.
  await grantDueProCredits(env, userId);
  const [plan, subscriptions, credits, deletion] = await Promise.all([
    currentPlan(env, userId),
    activeSubscriptions(env, userId),
    creditBalance(env, userId),
    env.DB.prepare("select execute_after from account_deletions where user_id = ?").bind(userId).first<{ execute_after: number }>(),
  ]);
  return {
    user: { id: user.id, email: user.email, name: user.name, image: user.image, createdAt: user.created_at },
    plan,
    entitlements: {
      sync: true,
      cli: true,
      /** CLI/MCP/access-token calls per UTC day. */
      cliDailyLimit: AGENT_DAILY_LIMITS[plan],
      apiKeys: true,
      /** Active access tokens (OpenKoto API keys) allowed. */
      apiKeyLimit: API_KEY_LIMITS[plan],
      hostedAi: credits > 0 || plan === "pro",
    },
    subscriptions: subscriptions.map((s) => ({ ...s, periodEnd: new Date(s.periodEnd).toISOString() })),
    credits,
    pendingDeletion: deletion ? new Date(deletion.execute_after).toISOString() : null,
  };
}

export const accountApi = new Hono<AppBindings>()
  .get("/me", requireAuth(), async (c) => c.json(await accountSummary(c.env, principalOf(c).userId)))

  .get("/keys", requireAuth("account"), async (c) => {
    const { results } = await c.env.DB.prepare(
      "select id, name, prefix, scopes, created_at, last_used_at, expires_at from api_keys where user_id = ? and revoked_at is null order by created_at desc",
    )
      .bind(principalOf(c).userId)
      .all<{ id: string; name: string; prefix: string; scopes: string; created_at: number; last_used_at: number | null; expires_at: number | null }>();
    return c.json({
      keys: results.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: JSON.parse(k.scopes) as string[],
        createdAt: new Date(k.created_at).toISOString(),
        lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
        expiresAt: k.expires_at ? new Date(k.expires_at).toISOString() : null,
      })),
      availableScopes: API_KEY_SCOPES,
    });
  })

  .post("/keys", requireAuth("account"), async (c) => {
    const p = principalOf(c);
    const plan = await currentPlan(c.env, p.userId);
    const active = await c.env.DB.prepare(
      "select count(*) as n from api_keys where user_id = ? and revoked_at is null and (expires_at is null or expires_at > ?)",
    )
      .bind(p.userId, Date.now())
      .first<{ n: number }>();
    if ((active?.n ?? 0) >= API_KEY_LIMITS[plan]) {
      throw forbidden(`your plan allows ${API_KEY_LIMITS[plan]} active access token(s); revoke one or upgrade`, "QUOTA_EXCEEDED");
    }
    const body = (await c.req.json()) as { name?: string; scopes?: string[]; expiresInDays?: number };
    const expiresAt = body.expiresInDays ? Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000 : null;
    const key = await createApiKey(c.env, p.userId, body.name ?? "API key", body.scopes ?? ["vocab:read", "library:read"], expiresAt);
    return c.json({ ...key, expiresAt: key.expiresAt ? new Date(key.expiresAt).toISOString() : null }, 201);
  })

  .delete("/keys/:id", requireAuth("account"), async (c) => {
    const res = await c.env.DB.prepare("update api_keys set revoked_at = ? where id = ? and user_id = ? and revoked_at is null")
      .bind(Date.now(), c.req.param("id"), principalOf(c).userId)
      .run();
    if (!res.meta.changes) throw notFound("key not found");
    return c.json({ ok: true });
  })

  .get("/account/export", requireAuth("account"), async (c) => {
    // NDJSON of every live record (the user's full synced library), streamed page by page.
    const p = principalOf(c);
    const vault = vaultFor(c.env, p.userId);
    const summary = await accountSummary(c.env, p.userId);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "account", ...summary })}\n`));
        let cursor: string | null = null;
        for (;;) {
          const page = await vault.pull({ cursor, limit: 1000 });
          for (const r of page.records) if (!r.deleted) controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "record", ...r })}\n`));
          cursor = page.cursor;
          if (!page.hasMore) break;
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="openkoto-export-${new Date().toISOString().slice(0, 10)}.ndjson"`,
      },
    });
  })

  .post("/account/delete", requireSession(), async (c) => {
    const p = principalOf(c);
    const now = Date.now();
    // auth-spec §5: deletion needs a sign-in within the last 5 minutes.
    const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    const signedInAt = session ? new Date(session.session.createdAt).getTime() : 0;
    if (now - signedInAt > RECENT_AUTH_MS) throw forbidden("please sign in again to delete your account", "REAUTH_REQUIRED");
    await c.env.DB.prepare(
      "insert into account_deletions (user_id, requested_at, execute_after) values (?, ?, ?) on conflict (user_id) do nothing",
    )
      .bind(p.userId, now, now + DELETION_GRACE_MS)
      .run();
    return c.json({ ok: true, executeAfter: new Date(now + DELETION_GRACE_MS).toISOString() });
  })

  .post("/account/delete/cancel", requireAuth("account"), async (c) => {
    await c.env.DB.prepare("delete from account_deletions where user_id = ?").bind(principalOf(c).userId).run();
    return c.json({ ok: true });
  });

/** Irreversibly removes every trace of a user. Called from the daily cron after the grace period. */
export async function purgeAccount(env: Env, userId: string): Promise<void> {
  await vaultFor(env, userId).purge();
  for (const prefix of [`books/${userId}/`, `blobs/${userId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  await env.DB.batch([
    env.DB.prepare('delete from "user" where id = ?').bind(userId),
    env.DB.prepare("delete from account_deletions where user_id = ?").bind(userId),
    env.DB.prepare("insert into audit_events (id, actor, action, target, created_at) values (?, 'system', 'account.purged', ?, ?)").bind(
      crypto.randomUUID(),
      userId,
      Date.now(),
    ),
  ]);
}
