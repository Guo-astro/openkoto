import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, Env, JobMessage } from "./env";
import { getAuth } from "./auth/better-auth";
import { authApi, devicesApi, nativeAuthorize, wellKnown } from "./auth/routes";
import { accountApi, purgeAccount } from "./account/routes";
import { syncApi } from "./sync/routes";
import { adminApi, billingApi, webhooksApi } from "./billing/routes";
import { ApiError, errorBody } from "./lib/http";

export { UserVault } from "./sync/vault";

const app = new Hono<AppBindings>();

app.onError((err, c) => {
  if (err instanceof ApiError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return c.json(errorBody(err.code, err.message), err.status);
  }
  if (err instanceof HTTPException) return c.json(errorBody("HTTP_ERROR", err.message), err.status);
  console.error("unhandled error", err);
  return c.json(errorBody("INTERNAL", "internal error"), 500);
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json(errorBody("NOT_FOUND", "not found"), 404);
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("not found", 404);
});

app.get("/api/health", (c) => c.json({ ok: true, service: "openkoto-api" }));
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth(c.env).handler(c.req.raw));
app.route("/", wellKnown);
app.route("/", nativeAuthorize);
app.route("/api/v1/auth", authApi);
app.route("/api/v1/devices", devicesApi);
app.route("/api/v1/sync", syncApi);
app.route("/api/v1/billing", billingApi);
app.route("/api/webhooks", webhooksApi);
app.route("/api/admin", adminApi);
app.route("/api/v1", accountApi);

async function runDailyMaintenance(env: Env): Promise<void> {
  const now = Date.now();
  const { results } = await env.DB.prepare("select user_id from account_deletions where execute_after < ? limit 50").bind(now).all<{ user_id: string }>();
  for (const row of results) await env.JOBS.send({ kind: "delete_account", userId: row.user_id });
  await env.DB.batch([
    env.DB.prepare("delete from auth_codes where expires_at < ?").bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare("delete from device_codes where expires_at < ?").bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare("delete from refresh_tokens where expires_at < ?").bind(now),
  ]);
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyMaintenance(env));
  },
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "delete_account") await purgeAccount(env, message.body.userId);
        message.ack();
      } catch (err) {
        console.error("job failed", message.body, err);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

export { app };
