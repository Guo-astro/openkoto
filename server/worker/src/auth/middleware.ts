import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings, Env, Principal } from "../env";
import { forbidden, unauthenticated } from "../lib/http";
import { getAuth } from "./better-auth";
import { FIRST_PARTY_SCOPES, onDeviceRevoked, resolveApiKey, verifyAccessToken } from "./tokens";
import { currentPlan, planAtLeast } from "../billing/entitlements";

interface DeviceState {
  platform: string;
  revoked: boolean;
  at: number;
}

// Short per-isolate cache: revocation takes effect within DEVICE_CACHE_MS instead of the
// 15-minute access-token lifetime, without a D1 read on every request.
const DEVICE_CACHE_MS = 30_000;
const deviceCache = new Map<string, DeviceState>();

export async function deviceState(env: Env, deviceId: string): Promise<DeviceState | null> {
  const cached = deviceCache.get(deviceId);
  if (cached && Date.now() - cached.at < DEVICE_CACHE_MS) return cached;
  const row = await env.DB.prepare("select platform, revoked_at from devices where id = ?").bind(deviceId).first<{ platform: string; revoked_at: number | null }>();
  if (!row) return null;
  const state = { platform: row.platform, revoked: row.revoked_at !== null, at: Date.now() };
  if (deviceCache.size > 5000) deviceCache.clear();
  deviceCache.set(deviceId, state);
  return state;
}

export function forgetDevice(deviceId: string): void {
  deviceCache.delete(deviceId);
}
onDeviceRevoked(forgetDevice);

/** Tokens held by agents and scripts: API keys, CLI and MCP devices. These need Plus. */
export async function isAgentPrincipal(env: Env, p: Principal): Promise<boolean> {
  if (p.via === "api_key") return true;
  if (p.via !== "jwt" || !p.deviceId || p.deviceId === "agent") return false;
  const device = await deviceState(env, p.deviceId);
  return device?.platform === "cli" || device?.platform === "mcp";
}

export async function resolvePrincipal(env: Env, req: Request): Promise<Principal | null> {
  const header = req.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token.startsWith("ok_live_")) {
      const key = await resolveApiKey(env, token);
      if (!key) throw unauthenticated("invalid api key");
      return { userId: key.userId, email: key.email, deviceId: null, scopes: key.scopes, via: "api_key", keyId: key.keyId };
    }
    const claims = await verifyAccessToken(env, token);
    if (claims.did !== "agent") {
      const device = await deviceState(env, claims.did);
      if (!device || device.revoked) throw unauthenticated("device signed out", "TOKEN_EXPIRED");
    }
    return { userId: claims.sub, email: claims.email, deviceId: claims.did, scopes: claims.scp, via: "jwt" };
  }

  const session = await getAuth(env).api.getSession({ headers: req.headers });
  if (!session) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Cookie auth: writes must come from our own origin (auth-spec §3.5). Browsers always
    // send Origin on cross-site POSTs; fall back to Sec-Fetch-Site when it is absent.
    const origin = req.headers.get("Origin");
    const sameSite = origin ? origin === new URL(env.APP_ORIGIN).origin : req.headers.get("Sec-Fetch-Site") === "same-origin";
    if (!sameSite) throw forbidden("cross-origin request rejected");
  }
  return { userId: session.user.id, email: session.user.email, deviceId: null, scopes: FIRST_PARTY_SCOPES, via: "session" };
}

/** Library/agent API: agent tokens (API keys, CLI, MCP) need a Plus or Pro plan server-side. */
export function requirePlusForAgents(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c.env, c.req.raw);
    if (principal && (await isAgentPrincipal(c.env, principal)) && !planAtLeast(await currentPlan(c.env, principal.userId), "plus")) {
      throw forbidden("CLI, MCP and API-key access are part of OpenKoto Plus", "PLAN_REQUIRED");
    }
    await next();
  };
}

export function requireAuth(...scopes: string[]): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c.env, c.req.raw);
    if (!principal) throw unauthenticated();
    const missing = scopes.filter((s) => !principal.scopes.includes(s));
    if (missing.length) throw forbidden(`missing scope: ${missing.join(", ")}`);
    c.set("principal", principal);
    await next();
  };
}

/** Only cookie sessions (the website) — used for approving devices, deleting accounts, etc. */
export function requireSession(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const principal = await resolvePrincipal(c.env, c.req.raw);
    if (!principal) throw unauthenticated();
    if (principal.via !== "session") throw forbidden("this action requires a browser session");
    c.set("principal", principal);
    await next();
  };
}

export function principalOf(c: Context<AppBindings>): Principal {
  return c.get("principal");
}
