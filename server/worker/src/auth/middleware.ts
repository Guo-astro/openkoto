import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings, Env, Principal } from "../env";
import { forbidden, unauthenticated } from "../lib/http";
import { getAuth } from "./better-auth";
import { FIRST_PARTY_SCOPES, resolveApiKey, verifyAccessToken } from "./tokens";

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
    return { userId: claims.sub, email: claims.email, deviceId: claims.did, scopes: claims.scp, via: "jwt" };
  }

  const session = await getAuth(env).api.getSession({ headers: req.headers });
  if (!session) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Cookie auth: reject cross-site writes.
    const origin = req.headers.get("Origin");
    if (origin && origin !== new URL(env.APP_ORIGIN).origin) throw forbidden("cross-origin request rejected");
  }
  return { userId: session.user.id, email: session.user.email, deviceId: null, scopes: FIRST_PARTY_SCOPES, via: "session" };
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
