import { Hono } from "hono";
import type { AppBindings, Env } from "../env";
import { normalizeUserCode, randomToken, randomUserCode, sha256Base64url, sha256Hex } from "../lib/crypto";
import { ApiError, badRequest, notFound, unauthenticated } from "../lib/http";
import { getAuth } from "./better-auth";
import { principalOf, requireAuth, requireSession, resolvePrincipal } from "./middleware";
import {
  issueForNewDevice,
  jwks,
  parseDeviceInfo,
  revokeByRefreshToken,
  revokeDevice,
  rotateRefreshToken,
  type DeviceInfo,
} from "./tokens";

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_INTERVAL_S = 5;
const NATIVE_CLIENTS = new Set(["ios", "desktop", "android"]);
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export function isAllowedRedirect(clientId: string, redirectUri: string): boolean {
  if (redirectUri === "openkoto://auth/callback") return true;
  if (clientId !== "desktop") return false;
  try {
    const url = new URL(redirectUri);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/callback" && !!url.port;
  } catch {
    return false;
  }
}

function validateNativeRequest(q: Record<string, string | undefined>) {
  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";
  if (!NATIVE_CLIENTS.has(clientId)) throw badRequest("unknown client_id");
  if (!isAllowedRedirect(clientId, redirectUri)) throw badRequest("redirect_uri not allowed");
  if (q.code_challenge_method !== "S256" || !q.code_challenge || q.code_challenge.length < 43 || q.code_challenge.length > 128) {
    throw badRequest("PKCE S256 code_challenge is required");
  }
  return { clientId, redirectUri, codeChallenge: q.code_challenge, state: q.state };
}

/**
 * Browser-facing entry for the apps' sign-in. It never issues a code by itself: a signed-in
 * user is sent to the consent page (/authorize-app), so a page or local app that merely opens
 * this URL can't mint tokens silently.
 */
export const nativeAuthorize = new Hono<AppBindings>().get("/auth/native/authorize", async (c) => {
  validateNativeRequest(c.req.query());
  const here = new URL(c.req.url);
  const principal = await resolvePrincipal(c.env, c.req.raw);
  if (!principal || principal.via !== "session") {
    return c.redirect(`/login?next=${encodeURIComponent(here.pathname + here.search)}`);
  }
  return c.redirect(`/authorize-app${here.search}`);
});

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("Content-Type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer())));
  }
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest("invalid JSON body");
  }
}

function oauthError(code: string, message: string, status: 400 | 401 = 400) {
  return new ApiError(status, code, message);
}

async function exchangeAuthCode(env: Env, body: Record<string, unknown>) {
  const code = String(body.code ?? "");
  const verifier = String(body.code_verifier ?? body.codeVerifier ?? "");
  const redirectUri = String(body.redirect_uri ?? body.redirectUri ?? "");
  if (!code || !verifier) throw oauthError("invalid_request", "code and code_verifier are required");

  const hash = await sha256Hex(code);
  const row = await env.DB.prepare("select * from auth_codes where code_hash = ?").bind(hash).first<{
    user_id: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    expires_at: number;
    used_at: number | null;
  }>();
  if (!row || row.used_at || row.expires_at < Date.now()) throw oauthError("invalid_grant", "authorization code is invalid or expired");
  // Codes issued to third-party MCP clients are only redeemable at the MCP token endpoint.
  if (row.client_id.startsWith("mcp_")) throw oauthError("invalid_grant", "authorization code was issued to another client");
  if (row.redirect_uri !== redirectUri) throw oauthError("invalid_grant", "redirect_uri mismatch");
  if ((await sha256Base64url(verifier)) !== row.code_challenge) throw oauthError("invalid_grant", "PKCE verification failed");

  const claimed = await env.DB.prepare("update auth_codes set used_at = ? where code_hash = ? and used_at is null").bind(Date.now(), hash).run();
  if (!claimed.meta.changes) throw oauthError("invalid_grant", "authorization code already used");

  const device = parseDeviceInfo(body.device ?? { platform: row.client_id === "desktop" ? "other" : row.client_id });
  return issueForNewDevice(env, row.user_id, device);
}

async function exchangeDeviceCode(env: Env, body: Record<string, unknown>) {
  const deviceCode = String(body.device_code ?? body.deviceCode ?? "");
  if (!deviceCode) throw oauthError("invalid_request", "device_code is required");
  const hash = await sha256Hex(deviceCode);
  const row = await env.DB.prepare("select * from device_codes where device_code_hash = ?").bind(hash).first<{
    status: string;
    user_id: string | null;
    device_json: string;
    poll_interval: number;
    last_poll_at: number | null;
    expires_at: number;
  }>();
  if (!row) throw oauthError("invalid_grant", "unknown device_code");
  const now = Date.now();
  if (row.expires_at < now) throw oauthError("expired_token", "device code expired");
  if (row.status === "denied") throw oauthError("access_denied", "the user denied the request");
  if (row.status === "consumed") throw oauthError("invalid_grant", "device code already used");

  if (row.status === "pending") {
    const tooFast = row.last_poll_at !== null && now - row.last_poll_at < row.poll_interval * 1000;
    await env.DB.prepare("update device_codes set last_poll_at = ?, poll_interval = ? where device_code_hash = ?")
      .bind(now, tooFast ? row.poll_interval + 5 : row.poll_interval, hash)
      .run();
    throw oauthError(tooFast ? "slow_down" : "authorization_pending", tooFast ? "polling too fast" : "waiting for user approval");
  }

  const claimed = await env.DB.prepare("update device_codes set status = 'consumed' where device_code_hash = ? and status = 'approved'")
    .bind(hash)
    .run();
  if (!claimed.meta.changes || !row.user_id) throw oauthError("invalid_grant", "device code already used");
  return issueForNewDevice(env, row.user_id, parseDeviceInfo(JSON.parse(row.device_json)));
}

export const authApi = new Hono<AppBindings>()
  // Called by the consent page with the user's explicit approval.
  .post("/native/approve", requireSession(), async (c) => {
    const body = (await readBody(c.req.raw)) as Record<string, string | undefined>;
    const req = validateNativeRequest(body);
    const target = new URL(req.redirectUri);
    if (body.approve === "false") {
      target.searchParams.set("error", "access_denied");
    } else {
      const code = randomToken(32);
      await c.env.DB.prepare(
        "insert into auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at) values (?, ?, ?, ?, ?, ?)",
      )
        .bind(await sha256Hex(code), principalOf(c).userId, req.clientId, req.redirectUri, req.codeChallenge, Date.now() + AUTH_CODE_TTL_MS)
        .run();
      target.searchParams.set("code", code);
    }
    if (req.state) target.searchParams.set("state", req.state);
    return c.json({ redirect: target.toString() });
  })
  .get("/providers", (c) => {
    const providers: string[] = [];
    if (c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) providers.push("google");
    if (c.env.APPLE_CLIENT_ID && c.env.APPLE_CLIENT_SECRET) providers.push("apple");
    if (c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET) providers.push("github");
    return c.json({ providers });
  })
  .post("/token", async (c) => {
    const body = await readBody(c.req.raw);
    const grant = String(body.grant_type ?? body.grantType ?? "");
    if (grant === "authorization_code") return c.json(await exchangeAuthCode(c.env, body));
    if (grant === "refresh_token") return c.json(await rotateRefreshToken(c.env, String(body.refresh_token ?? body.refreshToken ?? "")));
    if (grant === DEVICE_CODE_GRANT) return c.json(await exchangeDeviceCode(c.env, body));
    throw oauthError("unsupported_grant_type", `unsupported grant_type: ${grant}`);
  })

  .post("/apple", async (c) => {
    const body = await readBody(c.req.raw);
    const token = String(body.identityToken ?? "");
    const nonce = body.nonce ? String(body.nonce) : undefined;
    if (!token) throw badRequest("identityToken is required");
    const fullName = (body.fullName ?? null) as { givenName?: string; familyName?: string } | null;
    const auth = getAuth(c.env);
    let result: { user?: { id: string } } | undefined;
    try {
      result = (await auth.api.signInSocial({
        body: {
          provider: "apple",
          idToken: {
            token,
            nonce,
            user: fullName ? { name: { firstName: fullName.givenName ?? "", lastName: fullName.familyName ?? "" } } : undefined,
          },
        },
      })) as { user?: { id: string } };
    } catch (err) {
      throw unauthenticated(err instanceof Error ? err.message : "apple sign-in failed");
    }
    if (!result?.user?.id) throw unauthenticated("apple sign-in failed");
    return c.json(await issueForNewDevice(c.env, result.user.id, parseDeviceInfo(body.device ?? { platform: "ios" })));
  })

  .post("/device/code", async (c) => {
    const body = await readBody(c.req.raw);
    const device: DeviceInfo = parseDeviceInfo(body.device ?? { platform: "cli", name: "koto CLI" });
    const deviceCode = randomToken(32);
    const now = Date.now();
    let userCode = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      userCode = randomUserCode();
      const res = await c.env.DB.prepare(
        "insert or ignore into device_codes (device_code_hash, user_code, client_id, device_json, poll_interval, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(await sha256Hex(deviceCode), userCode, String(body.clientId ?? body.client_id ?? "cli"), JSON.stringify(device), DEVICE_POLL_INTERVAL_S, now + DEVICE_CODE_TTL_MS, now)
        .run();
      if (res.meta.changes) break;
      userCode = "";
    }
    if (!userCode) throw new ApiError(503, "INTERNAL", "could not allocate a user code");
    const verificationUri = `${c.env.APP_ORIGIN}/device`;
    return c.json({
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
      interval: DEVICE_POLL_INTERVAL_S,
      expiresIn: DEVICE_CODE_TTL_MS / 1000,
    });
  })

  .get("/device/lookup", requireSession(), async (c) => {
    const userCode = normalizeUserCode(c.req.query("userCode") ?? "");
    const row = await c.env.DB.prepare("select device_json, status, expires_at from device_codes where user_code = ?")
      .bind(userCode)
      .first<{ device_json: string; status: string; expires_at: number }>();
    if (!row || row.expires_at < Date.now() || row.status !== "pending") throw notFound("code not found or expired");
    return c.json({ userCode, device: JSON.parse(row.device_json) as DeviceInfo });
  })

  .post("/device/approve", requireSession(), async (c) => {
    const body = await readBody(c.req.raw);
    const userCode = normalizeUserCode(String(body.userCode ?? ""));
    const approve = body.approve !== false;
    const res = await c.env.DB.prepare(
      "update device_codes set status = ?, user_id = ? where user_code = ? and status = 'pending' and expires_at > ?",
    )
      .bind(approve ? "approved" : "denied", principalOf(c).userId, userCode, Date.now())
      .run();
    if (!res.meta.changes) throw notFound("code not found or expired");
    return c.json({ ok: true });
  })

  .post("/logout", async (c) => {
    const body = await readBody(c.req.raw);
    const token = String(body.refreshToken ?? body.refresh_token ?? "");
    if (token) await revokeByRefreshToken(c.env, token);
    return c.json({ ok: true });
  });

export const devicesApi = new Hono<AppBindings>()
  .use(requireAuth("account"))
  .get("/", async (c) => {
    const p = principalOf(c);
    const { results } = await c.env.DB.prepare(
      "select id, platform, name, app_version, created_at, last_seen_at from devices where user_id = ? and revoked_at is null order by last_seen_at desc",
    )
      .bind(p.userId)
      .all<{ id: string; platform: string; name: string; app_version: string | null; created_at: number; last_seen_at: number }>();
    return c.json({
      devices: results.map((d) => ({
        id: d.id,
        platform: d.platform,
        name: d.name,
        appVersion: d.app_version,
        createdAt: new Date(d.created_at).toISOString(),
        lastSeenAt: new Date(d.last_seen_at).toISOString(),
        current: d.id === p.deviceId,
      })),
    });
  })
  .delete("/:id", async (c) => {
    const ok = await revokeDevice(c.env, principalOf(c).userId, c.req.param("id"));
    if (!ok) throw notFound("device not found");
    return c.json({ ok: true });
  });

export const wellKnown = new Hono<AppBindings>().get("/.well-known/jwks.json", async (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(await jwks(c.env));
});

