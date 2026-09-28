// Minimal OAuth 2.1 authorization server for remote MCP clients (MCP authorization spec
// 2025-06-18): protected-resource + authorization-server metadata, dynamic client
// registration (RFC 7591), authorization code + PKCE (S256 only) and refresh tokens.
//
// better-auth 1.7 ships no OAuth-provider/MCP plugin, so this reuses our own machinery:
// codes live in `auth_codes`, tokens are ordinary device tokens (devices.platform = "mcp",
// which narrows the access-token scopes to MCP_SCOPES, see auth/tokens.ts).
//
//   GET  /.well-known/oauth-protected-resource[/mcp]
//   GET  /.well-known/oauth-authorization-server
//   POST /auth/mcp/register            (public clients only, token_endpoint_auth_method "none")
//   GET  /auth/mcp/authorize           → /login (no session) → /oauth/consent (apps/web)
//   GET  /api/v1/oauth/client          consent page: who is asking
//   POST /api/v1/oauth/decision        consent page: approve / deny → { redirectTo }
//   POST /auth/mcp/token               authorization_code | refresh_token

import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "../env";
import { principalOf, requireSession, resolvePrincipal } from "../auth/middleware";
import { issueForNewDevice, MCP_SCOPES, rotateRefreshToken, type TokenResponse } from "../auth/tokens";
import { randomBase62, randomToken, sha256Base64url, sha256Hex } from "../lib/crypto";
import { ApiError, badRequest } from "../lib/http";

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;

export function issuer(env: Env): string {
  return new URL(env.APP_ORIGIN).origin;
}

export function mcpResourceUrl(env: Env): string {
  return `${issuer(env)}/mcp`;
}

export function resourceMetadataUrl(env: Env): string {
  return `${issuer(env)}/.well-known/oauth-protected-resource/mcp`;
}

// ---- helpers ------------------------------------------------------------------

/** RFC 6749 §5.2 error body (MCP clients expect this shape, not our { error: { code } }). */
function oauthError(c: Context<AppBindings>, error: string, description: string, status: 400 | 401 = 400) {
  c.header("Cache-Control", "no-store");
  return c.json({ error, error_description: description }, status);
}

async function readForm(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("Content-Type") ?? "";
  const text = new TextDecoder().decode(await req.arrayBuffer());
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

/** https anywhere, http only on loopback, or a private-use app scheme (e.g. cursor://). */
export function isAcceptableRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
}

async function loadClient(env: Env, clientId: string): Promise<{ clientId: string; clientName: string; redirectUris: string[] } | null> {
  if (!clientId.startsWith("mcp_")) return null;
  const row = await env.DB.prepare("select client_id, client_name, redirect_uris from oauth_clients where client_id = ?").bind(clientId).first<ClientRow>();
  return row ? { clientId: row.client_id, clientName: row.client_name, redirectUris: JSON.parse(row.redirect_uris) as string[] } : null;
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string | null;
}

/** Validates an authorization request. Errors that must not be redirected throw ApiError. */
async function validateAuthorize(env: Env, q: Record<string, string | undefined>) {
  const client = await loadClient(env, q.client_id ?? "");
  if (!client) throw badRequest("unknown client_id", "invalid_client");
  const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
  if (!client.redirectUris.includes(redirectUri)) throw badRequest("redirect_uri is not registered for this client", "invalid_redirect_uri");
  // From here on errors go back to the client via the redirect.
  let error: string | null = null;
  if ((q.response_type ?? "code") !== "code") error = "unsupported_response_type";
  else if (q.code_challenge_method !== "S256" || !q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) error = "invalid_request";
  else if (q.resource && q.resource.replace(/\/+$/, "") !== mcpResourceUrl(env) && q.resource.replace(/\/+$/, "") !== issuer(env)) error = "invalid_target";
  const params: AuthorizeParams = { clientId: client.clientId, redirectUri, codeChallenge: q.code_challenge ?? "", state: q.state ?? null, scope: q.scope ?? null };
  return { client, params, error };
}

function redirectWith(redirectUri: string, values: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(values)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

function toOAuthTokens(res: TokenResponse) {
  return {
    access_token: res.accessToken,
    token_type: "Bearer",
    expires_in: res.expiresIn,
    refresh_token: res.refreshToken,
    scope: res.scopes.join(" "),
  };
}

// ---- routes -------------------------------------------------------------------

export const mcpOAuth = new Hono<AppBindings>()
  .get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource(c.env)))
  .get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource(c.env)))
  .get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServer(c.env)))
  .get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(authorizationServer(c.env)))

  .post("/auth/mcp/register", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return oauthError(c, "invalid_client_metadata", "body must be JSON");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS || !uris.every((u) => typeof u === "string" && isAcceptableRedirect(u))) {
      return oauthError(c, "invalid_redirect_uri", "redirect_uris must list https, loopback http or app-scheme URIs");
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") return oauthError(c, "invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported");
    const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "MCP client").slice(0, 80);
    const clientId = `mcp_${randomBase62(24)}`;
    const now = Date.now();
    await c.env.DB.prepare("insert into oauth_clients (client_id, client_name, redirect_uris, created_at) values (?, ?, ?, ?)")
      .bind(clientId, name, JSON.stringify(uris), now)
      .run();
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: MCP_SCOPES.join(" "),
      },
      201,
    );
  })

  .get("/auth/mcp/authorize", async (c) => {
    const q = c.req.query();
    const { params, error } = await validateAuthorize(c.env, q);
    if (error) return c.redirect(redirectWith(params.redirectUri, { error, state: params.state }));
    const principal = await resolvePrincipal(c.env, c.req.raw).catch(() => null);
    const here = new URL(c.req.url);
    if (!principal || principal.via !== "session") return c.redirect(`/login?next=${encodeURIComponent(here.pathname + here.search)}`);
    return c.redirect(`/oauth/consent${here.search}`);
  })

  .get("/api/v1/oauth/client", requireSession(), async (c) => {
    const { client, params, error } = await validateAuthorize(c.env, c.req.query());
    if (error) throw badRequest(error, error);
    return c.json({
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri: params.redirectUri,
      redirectHost: (() => {
        const u = new URL(params.redirectUri);
        return u.host || u.protocol;
      })(),
      scopes: MCP_SCOPES,
    });
  })

  .post("/api/v1/oauth/decision", requireSession(), async (c) => {
    const body = (await c.req.json()) as Record<string, string | boolean | undefined>;
    const q = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const { params, error } = await validateAuthorize(c.env, q);
    if (error) return c.json({ redirectTo: redirectWith(params.redirectUri, { error, state: params.state }) });
    if (body.approve !== true) return c.json({ redirectTo: redirectWith(params.redirectUri, { error: "access_denied", state: params.state }) });
    const code = randomToken(32);
    await c.env.DB.prepare(
      "insert into auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at) values (?, ?, ?, ?, ?, ?)",
    )
      .bind(await sha256Hex(code), principalOf(c).userId, params.clientId, params.redirectUri, params.codeChallenge, Date.now() + AUTH_CODE_TTL_MS)
      .run();
    return c.json({ redirectTo: redirectWith(params.redirectUri, { code, state: params.state, iss: issuer(c.env) }) });
  })

  .post("/auth/mcp/token", async (c) => {
    const body = await readForm(c.req.raw);
    c.header("Cache-Control", "no-store");
    try {
      if (body.grant_type === "authorization_code") {
        const client = await loadClient(c.env, body.client_id ?? "");
        if (!client) return oauthError(c, "invalid_client", "unknown client_id", 401);
        if (!body.code || !body.code_verifier) return oauthError(c, "invalid_request", "code and code_verifier are required");
        const hash = await sha256Hex(body.code);
        const row = await c.env.DB.prepare("select user_id, client_id, redirect_uri, code_challenge, expires_at, used_at from auth_codes where code_hash = ?")
          .bind(hash)
          .first<{ user_id: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null }>();
        if (!row || row.used_at || row.expires_at < Date.now() || row.client_id !== client.clientId) {
          return oauthError(c, "invalid_grant", "authorization code is invalid or expired");
        }
        if (body.redirect_uri && body.redirect_uri !== row.redirect_uri) return oauthError(c, "invalid_grant", "redirect_uri mismatch");
        if ((await sha256Base64url(body.code_verifier)) !== row.code_challenge) return oauthError(c, "invalid_grant", "PKCE verification failed");
        const claimed = await c.env.DB.prepare("update auth_codes set used_at = ? where code_hash = ? and used_at is null").bind(Date.now(), hash).run();
        if (!claimed.meta.changes) return oauthError(c, "invalid_grant", "authorization code already used");
        return c.json(toOAuthTokens(await issueForNewDevice(c.env, row.user_id, { platform: "mcp", name: client.clientName })));
      }
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) return oauthError(c, "invalid_request", "refresh_token is required");
        return c.json(toOAuthTokens(await rotateRefreshToken(c.env, body.refresh_token)));
      }
      return oauthError(c, "unsupported_grant_type", `unsupported grant_type: ${body.grant_type ?? ""}`);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return oauthError(c, "invalid_grant", err.message);
      throw err;
    }
  });

function protectedResource(env: Env) {
  return {
    resource: mcpResourceUrl(env),
    authorization_servers: [issuer(env)],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "OpenKoto",
    resource_documentation: `${issuer(env)}/pricing`,
  };
}

function authorizationServer(env: Env) {
  const base = issuer(env);
  return {
    issuer: base,
    authorization_endpoint: `${base}/auth/mcp/authorize`,
    token_endpoint: `${base}/auth/mcp/token`,
    registration_endpoint: `${base}/auth/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
}

