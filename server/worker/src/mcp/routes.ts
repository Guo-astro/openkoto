// Remote MCP endpoint: POST https://openkoto.app/mcp (Streamable HTTP, stateless, JSON responses).
// Same tools as the stdio server (@openkoto/mcp-tools). Tool calls go through the regular REST
// routes in-process (the caller's bearer token is replayed), so scopes, plan quotas, credits and
// validation are enforced exactly as for the CLI.

import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { LibraryClient, OpenKotoClient } from "@openkoto/client";
import { createOpenKotoMcpServer, SERVER_VERSION } from "@openkoto/mcp-tools";
import type { AppBindings, Env, Principal } from "../env";
import { resolvePrincipal } from "../auth/middleware";
import { currentPlan, planAtLeast } from "../billing/entitlements";
import { ApiError } from "../lib/http";
import { resourceMetadataUrl } from "./oauth";

/** How the MCP handler reaches the REST API without a network hop. */
export type Dispatch = (req: Request, env: Env, ctx: unknown) => Response | Promise<Response>;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function unauthorized(env: Env, error: "invalid_request" | "invalid_token", description: string): Response {
  return withCors(
    new Response(JSON.stringify({ error, error_description: description }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="OpenKoto", error="${error}", error_description="${description}", resource_metadata="${resourceMetadataUrl(env)}"`,
      },
    }),
  );
}

class GuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function mcpRoutes(dispatch: Dispatch) {
  return new Hono<AppBindings>()
    .options("/mcp", () => new Response(null, { status: 204, headers: CORS }))
    .all("/mcp", async (c) => {
      const header = c.req.header("Authorization") ?? "";
      if (!/^Bearer\s+\S+/i.test(header)) return unauthorized(c.env, "invalid_request", "authorization required");
      const token = header.replace(/^Bearer\s+/i, "").trim();

      // Bearer only (API key or access JWT) — never the website cookie, so no CSRF surface.
      let principal: Principal | null;
      try {
        principal = await resolvePrincipal(c.env, new Request(c.req.url, { headers: { Authorization: `Bearer ${token}` } }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return unauthorized(c.env, "invalid_token", err.message);
        throw err;
      }
      if (!principal) return unauthorized(c.env, "invalid_token", "invalid token");
      const p = principal;

      const client = new OpenKotoClient({
        baseUrl: new URL(c.env.APP_ORIGIN).origin,
        clientName: `mcp-remote/${SERVER_VERSION}`,
        tokenStore: { get: async () => ({ accessToken: token }), set: async () => {} },
        fetch: async (url, init) => dispatch(new Request(url, init), c.env, c.executionCtx),
      });

      let entitled: boolean | null = null;
      const guard = async () => {
        entitled ??= planAtLeast(await currentPlan(c.env, p.userId), "plus");
        if (!entitled) throw new GuardError("PLAN_REQUIRED", "Agent access (MCP/CLI) is part of OpenKoto Plus. The user can upgrade at https://openkoto.app/pricing.");
      };

      const server = createOpenKotoMcpServer(new LibraryClient(client, c.req.header("X-Timezone") || undefined), {
        guard,
        sdk: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return withCors(await transport.handleRequest(c.req.raw));
      } finally {
        c.executionCtx.waitUntil(server.close().catch(() => {}));
      }
    });
}
