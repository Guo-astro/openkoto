import { describe, expect, it, vi } from "vitest";
import { ApiError, MemoryTokenStore, OpenKotoClient, createPkcePair, pkceChallenge, type Tokens } from "../src/index";

const BASE = "https://openkoto.test";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const err = (status: number, code: string, headers: Record<string, string> = {}) => jsonResponse(status, { error: { code, message: code } }, headers);

function tokenResponse(n: number) {
  return { accessToken: `at${n}`, refreshToken: `okr_rt${n}`, tokenType: "Bearer", expiresIn: 900, deviceId: "dev-1", user: { id: "u1", email: "a@b.c" } };
}

function harness(handler: (call: Call) => Response | Promise<Response>, tokens: Tokens | null = { accessToken: "at0", refreshToken: "okr_rt0" }) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init?.credentials,
    };
    calls.push(call);
    return handler(call);
  });
  const store = new MemoryTokenStore(tokens);
  const sleeps: number[] = [];
  const client = new OpenKotoClient({
    baseUrl: `${BASE}/`,
    clientName: "ios/1.5.0",
    tokenStore: store,
    fetch,
    now: () => 1_000_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, store, sleeps };
}

describe("OpenKotoClient", () => {
  it("sends protocol, client and bearer headers and builds pull queries", async () => {
    const { client, calls } = harness(() => jsonResponse(200, { records: [], cursor: "c_5", hasMore: false, serverTime: "" }));
    const res = await client.sync.pull("c_1", { limit: 100, types: ["Vocabulary", "ReviewEvent"] });
    expect(res.cursor).toBe("c_5");
    const call = calls[0]!;
    expect(call.headers).toMatchObject({ Authorization: "Bearer at0", "X-OpenKoto-Protocol": "1", "X-OpenKoto-Client": "ios/1.5.0" });
    const url = new URL(call.url);
    expect(url.pathname).toBe("/api/v1/sync/pull");
    expect(Object.fromEntries(url.searchParams)).toEqual({ cursor: "c_1", limit: "100", types: "Vocabulary,ReviewEvent" });
    await client.sync.pull(null);
    expect(new URL(calls[1]!.url).search).toBe("");
  });

  it("refreshes once for concurrent TOKEN_EXPIRED responses and retries each request", async () => {
    let refreshes = 0;
    const { client, calls, store } = harness(async (call) => {
      if (call.url.endsWith("/api/v1/auth/token")) {
        refreshes += 1;
        expect(call.body).toEqual({ grant_type: "refresh_token", refresh_token: "okr_rt0" });
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse(200, tokenResponse(1));
      }
      if (call.headers.Authorization === "Bearer at0") return err(401, "TOKEN_EXPIRED");
      return jsonResponse(200, { devices: [{ id: "d" }] });
    });
    const results = await Promise.all([client.devices(), client.devices(), client.sync.stats(), client.me()]);
    expect(results[0]).toEqual([{ id: "d" }]);
    expect(refreshes).toBe(1);
    expect((await store.get())!).toMatchObject({ accessToken: "at1", refreshToken: "okr_rt1", deviceId: "dev-1", expiresAt: 1_000_000 + 900_000 });
    expect(calls.filter((c) => c.headers.Authorization === "Bearer at1")).toHaveLength(4);
  });

  it("clears tokens and reports session expiry when the refresh token is rejected", async () => {
    const onSessionExpired = vi.fn();
    const store = new MemoryTokenStore({ accessToken: "at0", refreshToken: "okr_rt0" });
    const client = new OpenKotoClient({
      baseUrl: BASE,
      clientName: "cli/0.1.0",
      tokenStore: store,
      onSessionExpired,
      fetch: async (url) => (url.endsWith("/auth/token") ? err(401, "invalid_grant") : err(401, "TOKEN_EXPIRED")),
    });
    await expect(client.me()).rejects.toMatchObject({ status: 401, code: "TOKEN_EXPIRED" });
    expect(await store.get()).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it("refreshes proactively when the stored access token is past expiry", async () => {
    const { client, calls } = harness(
      (call) => (call.url.endsWith("/auth/token") ? jsonResponse(200, tokenResponse(2)) : jsonResponse(200, { ok: true })),
      { accessToken: "at0", refreshToken: "okr_rt0", expiresAt: 1_000_000 + 10_000 },
    );
    await client.me();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/auth/token", "/api/v1/me"]);
    expect(calls[1]!.headers.Authorization).toBe("Bearer at2");
  });

  it("parses error bodies into ApiError with Retry-After", async () => {
    const { client } = harness(() => err(429, "RATE_LIMITED", { "Retry-After": "7" }));
    const e = await client.sync.push({ deviceId: "d", ops: [] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfter: 7 });
  });

  it("cookie mode sends credentials and never a bearer", async () => {
    const calls: Call[] = [];
    const client = new OpenKotoClient({
      baseUrl: BASE,
      clientName: "web/1.0.0",
      credentials: "include",
      tokenStore: new MemoryTokenStore({ accessToken: "should-not-be-sent" }),
      fetch: async (url, init) => {
        calls.push({ url, method: init!.method!, headers: init!.headers as Record<string, string>, body: undefined, credentials: init!.credentials });
        return jsonResponse(200, { keys: [], availableScopes: [] });
      },
    });
    await client.apiKeys.list();
    expect(calls[0]!.credentials).toBe("include");
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("covers devices, api keys and logout endpoints", async () => {
    const { client, calls, store } = harness(() => jsonResponse(200, { ok: true, id: "k1", key: "ok_live_x" }));
    await client.revokeDevice("dev 2");
    await client.apiKeys.create({ name: "agent", scopes: ["vocab:read"] });
    await client.apiKeys.revoke("k1");
    await client.logout();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "DELETE /api/v1/devices/dev%202",
      "POST /api/v1/keys",
      "DELETE /api/v1/keys/k1",
      "POST /api/v1/auth/logout",
    ]);
    expect(calls[3]!.body).toEqual({ refreshToken: "okr_rt0" });
    expect(calls[3]!.headers.Authorization).toBeUndefined();
    expect(await store.get()).toBeNull();
  });

  it("polls the device code grant with RFC 8628 slow_down backoff", async () => {
    const answers = [err(400, "authorization_pending"), err(400, "slow_down"), err(400, "authorization_pending"), jsonResponse(200, tokenResponse(3))];
    const { client, calls, sleeps, store } = harness((call) => {
      if (call.url.endsWith("/device/code")) {
        return jsonResponse(200, { deviceCode: "dc", userCode: "WDJB-MJHT", verificationUri: "", verificationUriComplete: "", interval: 5, expiresIn: 600 });
      }
      return answers.shift()!;
    }, null);
    const start = await client.startDeviceLogin();
    expect(calls[0]!.body).toEqual({ clientId: "cli", device: { platform: "cli", name: "koto CLI" } });
    const tokens = await client.pollDeviceLogin(start.deviceCode, start.interval);
    expect(tokens.accessToken).toBe("at3");
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
    expect(calls[1]!.body).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dc" });
    expect((await store.get())!.refreshToken).toBe("okr_rt3");
  });

  it("stops polling on expired_token / access_denied and on abort", async () => {
    const { client } = harness(() => err(400, "expired_token"), null);
    await expect(client.pollDeviceLogin("dc", 5)).rejects.toMatchObject({ code: "expired_token" });

    const real = new OpenKotoClient({ baseUrl: BASE, clientName: "cli/0.1.0", fetch: async () => err(400, "authorization_pending") });
    const ctrl = new AbortController();
    const p = real.pollDeviceLogin("dc", 1, ctrl.signal);
    ctrl.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });

  it("builds the native authorize URL and exchanges the code with PKCE", async () => {
    const { client, calls, store } = harness(() => jsonResponse(200, tokenResponse(4)), null);
    const { codeVerifier, codeChallenge } = await createPkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toBe(await pkceChallenge(codeVerifier));
    // RFC 7636 appendix B test vector.
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

    const url = new URL(client.buildNativeAuthorizeUrl({ clientId: "ios", redirectUri: "openkoto://auth/callback", state: "s1", codeChallenge }));
    expect(url.origin + url.pathname).toBe(`${BASE}/auth/native/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "ios",
      redirect_uri: "openkoto://auth/callback",
      state: "s1",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    await client.exchangeCode({ code: "c", codeVerifier, redirectUri: "openkoto://auth/callback", device: { platform: "ios", name: "iPhone" } });
    expect(calls[0]!.body).toEqual({ grant_type: "authorization_code", code: "c", code_verifier: codeVerifier, redirect_uri: "openkoto://auth/callback", device: { platform: "ios", name: "iPhone" } });
    expect((await store.get())!.accessToken).toBe("at4");
  });
});
