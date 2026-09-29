import { Hono, type Context, type Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, Env, JobMessage } from "./env";
import { getAuth } from "./auth/better-auth";
import { authApi, devicesApi, nativeAuthorize, wellKnown } from "./auth/routes";
import { accountApi, purgeAccount } from "./account/routes";
import { syncApi } from "./sync/routes";
import { libraryApi } from "./library/routes";
import { mcpOAuth } from "./mcp/oauth";
import { mcpRoutes } from "./mcp/routes";
import { agentRoutes } from "./agent/routes";
import { adminApi, billingApi, webhooksApi } from "./billing/routes";
import { aiApi } from "./ai/routes";
import { jobsApi, runTranslateBookStep } from "./ai/jobs";
import { booksApi } from "./books/routes";
import { appStoreApi, appStoreWebhook } from "./billing/appstore";
import { ApiError, errorBody } from "./lib/http";

export { UserVault } from "./sync/vault";

async function authRateLimit(c: Context<AppBindings>, next: Next) {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const limiter = c.req.path.includes("send-verification-otp") ? c.env.OTP_LIMITER : c.env.AUTH_LIMITER;
  if (limiter && c.req.method !== "GET" && c.env.DISABLE_RATE_LIMIT !== "1") {
    const { success } = await limiter.limit({ key: `${c.req.path.includes("send-verification-otp") ? "otp" : "auth"}:${ip}` });
    if (!success) return c.json(errorBody("RATE_LIMITED", "too many requests, please wait a minute"), 429, { "Retry-After": "60" });
  }
  await next();
}

const app = new Hono<AppBindings>();

/** Old openkoto.com (Vercel) paths that shipped app builds and store listings still link to. */
export function legacyRedirect(path: string): string | null {
  const p = path.replace(/\/+$/, "") || "/";
  const m = /^\/(?:en|zh|ja)(\/.*)?$/.exec(p);
  const rest = m ? (m[1] ?? "/") : p;
  if (rest === "/privacy-policy") return "/privacy";
  if (rest === "/terms-of-service") return "/terms";
  if (m) return rest;
  return null;
}

// www.openkoto.com → openkoto.com, and 301s for the old marketing-site paths.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const target = legacyRedirect(url.pathname);
  if (url.hostname.startsWith("www.") || (target !== null && c.req.method === "GET")) {
    url.hostname = url.hostname.replace(/^www\./, "");
    if (target !== null) url.pathname = target;
    return c.redirect(url.toString(), 301);
  }
  await next();
});

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

// Brute-force protection for sign-in: per client IP, stricter for sending email codes.
app.use("/api/auth/*", authRateLimit);
app.use("/api/v1/auth/*", authRateLimit);
app.use("/auth/*", authRateLimit);
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth(c.env).handler(c.req.raw));
app.route("/", wellKnown);
app.route("/", nativeAuthorize);
app.route("/", mcpOAuth);
app.route("/", mcpRoutes((req, env, ctx) => app.fetch(req, env, ctx as ExecutionContext)));
app.route("/api/v1/agent", agentRoutes((req, env, ctx) => app.fetch(req, env, ctx as ExecutionContext)));
app.route("/api/v1/auth", authApi);
app.route("/api/v1/devices", devicesApi);
app.route("/api/v1/sync", syncApi);
app.route("/api/v1/library", libraryApi);
app.route("/api/v1/billing/appstore", appStoreApi);
app.route("/api/v1/billing", billingApi);
app.route("/api/webhooks", appStoreWebhook);
app.route("/api/v1/ai", aiApi);
app.route("/api/v1/jobs", jobsApi);
app.route("/api/v1/books", booksApi);
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
    env.DB.prepare("delete from agent_usage where day < ?").bind(new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)),
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
        else if (message.body.kind === "translate_book") await runTranslateBookStep(env, message.body.jobId, message.body.userId);
        message.ack();
      } catch (err) {
        console.error("job failed", message.body, err);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

export { app };
