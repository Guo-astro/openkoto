import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCredits } from "../src/billing/credits";
import { generateActivationCodes } from "../src/billing/routes";
import { api, json, nativeLogin, pkce, signInWithEmail, url, ORIGIN } from "./helpers";

async function makePlus(token: string) {
  const [code] = await generateActivationCodes(env, { batch: "mcp", plan: "plus", durationDays: 30, credits: 0, count: 1 });
  await api(token, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params: unknown = {}) {
  const res = await SELF.fetch(url("/mcp"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res;
}

async function call(token: string, method: string, params: unknown = {}) {
  const res = await rpc(token, method, params);
  expect(res.status).toBe(200);
  const body = await json<{ result?: any; error?: { message: string } }>(res);
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const result = await call(token, "tools/call", { name, arguments: args });
  return { isError: !!result.isError, data: JSON.parse(result.content[0].text) };
}

async function plusApiKey(email: string) {
  const t = await nativeLogin(email);
  await makePlus(t.accessToken);
  const res = await api(t.accessToken, "/api/v1/keys", { method: "POST", body: JSON.stringify({ name: "mcp", scopes: ["vocab:read", "vocab:write", "library:read", "library:write"] }) });
  const { key } = await json<{ key: string }>(res);
  return { key, tokens: t };
}

describe("remote MCP over streamable HTTP", () => {
  it("requires a bearer token and advertises the resource metadata", async () => {
    const res = await rpc(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await rpc("ok_live_nope", "tools/list");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("initializes, lists and calls tools with an API key", async () => {
    const { key } = await plusApiKey("mcp-key@example.com");
    const init = await call(key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.serverInfo.name).toBe("openkoto");

    const { tools } = await call(key, "tools/list");
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_library", "add_vocab", "review_vocab", "translate_lyrics", "read_chapter", "get_review_stats", "create_word_pack_from_text"]));

    const added = await tool(key, "add_vocab", { word: "懐かしい", meaning: "nostalgic", pack: "Songs" });
    expect(added).toMatchObject({ isError: false, data: { created: true, vocab: { word: "懐かしい" } } });

    const due = await tool(key, "list_due_vocab");
    expect(due.data.items.map((v: { word: string }) => v.word)).toContain("懐かしい");

    const reviewed = await tool(key, "review_vocab", { id: added.data.vocab.id, grade: 3 });
    expect(reviewed.data.vocab.reviewCount).toBe(1);

    const stats = await tool(key, "get_review_stats");
    expect(stats.data).toMatchObject({ total: 1, totalReviews: 1, byState: { review: 1 } });

    const lyrics = await tool(key, "create_lyrics", { raw: "[00:01.00]一\n[00:02.00]二\n", title: "Song" });
    await tool(key, "save_lyrics_translation", { id: lyrics.data.id, translations: [{ order: 1, translation: "two" }] });
    const got = await tool(key, "get_lyrics", { id: lyrics.data.id });
    expect(got.data.lines.map((l: { translation: string | null }) => l.translation)).toEqual([null, "two"]);

    // Missing scope (ai:use) surfaces as a tool error, not a transport error.
    const ai = await tool(key, "translate_lyrics", { id: lyrics.data.id, targetLanguage: "zh" });
    expect(ai.isError).toBe(true);
    expect(ai.data.error.message).toContain("scope");
  });

  it("refuses tools for accounts without Plus", async () => {
    const t = await nativeLogin("mcp-free@example.com");
    const res = await tool(t.accessToken, "list_books");
    expect(res).toMatchObject({ isError: true, data: { error: { code: "PLAN_REQUIRED" } } });
  });
});

describe("MCP OAuth", () => {
  it("serves discovery metadata", async () => {
    const pr = await json<{ resource: string; authorization_servers: string[] }>(await SELF.fetch(url("/.well-known/oauth-protected-resource/mcp")));
    expect(pr).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const as = await json<Record<string, unknown>>(await SELF.fetch(url("/.well-known/oauth-authorization-server")));
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/auth/mcp/authorize`,
      token_endpoint: `${ORIGIN}/auth/mcp/token`,
      registration_endpoint: `${ORIGIN}/auth/mcp/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("rejects unsafe redirect URIs at registration", async () => {
    for (const uri of ["http://evil.example/cb", "javascript:alert(1)", "https://x.test/cb#frag"]) {
      const res = await SELF.fetch(url("/auth/mcp/register"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) });
      expect(res.status).toBe(400);
      expect((await json<{ error: string }>(res)).error).toBe("invalid_redirect_uri");
    }
  });

  it("runs registration → consent → code → tokens → /mcp → refresh", async () => {
    const t = await nativeLogin("mcp-oauth@example.com");
    await makePlus(t.accessToken);
    const cookie = await signInWithEmail("mcp-oauth@example.com");
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";

    const reg = await SELF.fetch(url("/auth/mcp/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await json<{ client_id: string }>(reg);
    expect(client_id).toMatch(/^mcp_/);

    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "st1", resource: `${ORIGIN}/mcp` });

    const anon = await SELF.fetch(url(`/auth/mcp/authorize?${query}`), { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toMatch(/^\/login\?next=%2Fauth%2Fmcp%2Fauthorize/);

    const authed = await SELF.fetch(url(`/auth/mcp/authorize?${query}`), { headers: { Cookie: cookie }, redirect: "manual" });
    expect(authed.headers.get("Location")).toBe(`/oauth/consent?${query}`);

    const info = await json<{ clientName: string; redirectHost: string }>(await SELF.fetch(url(`/api/v1/oauth/client?${query}`), { headers: { Cookie: cookie } }));
    expect(info).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai" });

    const decision = await SELF.fetch(url("/api/v1/oauth/decision"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ ...Object.fromEntries(query), approve: true }),
    });
    const { redirectTo } = await json<{ redirectTo: string }>(decision);
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("st1");
    const code = back.searchParams.get("code")!;

    // The first-party token endpoint must not redeem codes issued to MCP clients.
    const wrong = await SELF.fetch(url("/api/v1/auth/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, device: { platform: "ios" } }),
    });
    expect(wrong.status).toBe(400);

    const badPkce = await SELF.fetch(url("/auth/mcp/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id, redirect_uri: redirectUri }),
    });
    expect(await json(badPkce)).toMatchObject({ error: "invalid_grant" });

    const tokenRes = await SELF.fetch(url("/auth/mcp/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: redirectUri }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await json<{ access_token: string; refresh_token: string; token_type: string; scope: string }>(tokenRes);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope.split(" ")).not.toContain("account");
    expect(tokens.scope.split(" ")).not.toContain("sync");

    // Codes are single-use.
    const replay = await SELF.fetch(url("/auth/mcp/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: redirectUri }),
    });
    expect(replay.status).toBe(400);

    const { tools } = await call(tokens.access_token, "tools/list");
    expect(tools.length).toBeGreaterThan(10);
    expect((await tool(tokens.access_token, "search_library", { query: "" })).isError).toBe(false);
    // Narrow scopes: no raw sync, no key management.
    expect((await api(tokens.access_token, "/api/v1/sync/pull")).status).toBe(403);
    expect((await api(tokens.access_token, "/api/v1/keys")).status).toBe(403);

    const refreshed = await SELF.fetch(url("/auth/mcp/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }),
    });
    const next = await json<{ access_token: string; scope: string }>(refreshed);
    expect(next.scope).toBe(tokens.scope);
    expect((await call(next.access_token, "tools/list")).tools.length).toBeGreaterThan(10);

    // The MCP client shows up as a revocable device.
    const devices = await json<{ devices: { platform: string; name: string }[] }>(await api(t.accessToken, "/api/v1/devices"));
    expect(devices.devices).toEqual(expect.arrayContaining([expect.objectContaining({ platform: "mcp", name: "Claude" })]));
  });

  it("redirects denials back to the client", async () => {
    const cookie = await signInWithEmail("mcp-deny@example.com");
    const reg = await json<{ client_id: string }>(
      await SELF.fetch(url("/auth/mcp/register"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:3334/cb"] }) }),
    );
    const { challenge } = await pkce();
    const res = await SELF.fetch(url("/api/v1/oauth/decision"), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:3334/cb", code_challenge: challenge, code_challenge_method: "S256", state: "s", approve: false }),
    });
    expect((await json<{ redirectTo: string }>(res)).redirectTo).toBe("http://127.0.0.1:3334/cb?error=access_denied&state=s");
    // Unregistered redirect URIs are rejected outright (never redirected to).
    const bad = await SELF.fetch(url(`/api/v1/oauth/client?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`), { headers: { Cookie: cookie } });
    expect(bad.status).toBe(400);
  });
});

describe("hosted-AI tools", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => vi.restoreAllMocks());

  function mockProvider(reply: string) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!u.startsWith("https://ai.test/")) return realFetch(input as RequestInfo, init);
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { headers: { "Content-Type": "application/json" } });
    });
  }

  it("POST /ai/extract-vocab returns parsed candidates", async () => {
    const t = await nativeLogin("extract@example.com");
    await addCredits(env, t.user.id, 500, "adjust", "test");
    mockProvider(JSON.stringify([{ word: "懐かしい", reading: "なつかしい", meaning: "怀念", example: "懐かしい歌" }, { word: "", meaning: "x" }]));
    const res = await api(t.accessToken, "/api/v1/ai/extract-vocab", { method: "POST", body: JSON.stringify({ text: "懐かしい歌が流れる unique-extract", targetLanguage: "zh", max: 5 }) });
    expect(res.status).toBe(200);
    const body = await json<{ items: unknown[]; credits: number; cached: boolean }>(res);
    expect(body).toMatchObject({ items: [{ word: "懐かしい", reading: "なつかしい", meaning: "怀念", example: "懐かしい歌" }], cached: false });
    expect(body.credits).toBeGreaterThan(0);
  });

  it("create_word_pack_from_text builds a pack over MCP", async () => {
    const { key, tokens } = await plusApiKeyWithAi("mcp-pack@example.com");
    await addCredits(env, tokens.user.id, 500, "adjust", "test");
    mockProvider(JSON.stringify([{ word: "走る", meaning: "跑", reading: "はしる" }, { word: "空", meaning: "天空", reading: "そら" }]));
    const res = await tool(key, "create_word_pack_from_text", { text: "空を走る unique-pack", name: "Sky", targetLanguage: "zh" });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ pack: { name: "Sky" }, added: 2, merged: 0 });
    const inPack = await json<{ items: { word: string }[] }>(await api(key, "/api/v1/library/vocab?pack=Sky"));
    expect(inPack.items.map((v) => v.word).sort()).toEqual(["走る", "空"].sort());
  });
});

async function plusApiKeyWithAi(email: string) {
  const t = await nativeLogin(email);
  await makePlus(t.accessToken);
  const res = await api(t.accessToken, "/api/v1/keys", { method: "POST", body: JSON.stringify({ name: "mcp", scopes: ["vocab:read", "vocab:write", "library:read", "library:write", "ai:use"] }) });
  return { key: (await json<{ key: string }>(res)).key, tokens: t };
}
