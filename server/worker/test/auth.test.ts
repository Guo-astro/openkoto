import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, json, nativeLogin, pkce, signInWithEmail, url } from "./helpers";

describe("health", () => {
  it("responds", async () => {
    const res = await SELF.fetch(url("/api/health"));
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("publishes a JWKS", async () => {
    const body = await json<{ keys: { kty: string; crv: string; d?: string }[] }>(await SELF.fetch(url("/.well-known/jwks.json")));
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(body.keys[0]!.d).toBeUndefined();
  });
});

describe("native login", () => {
  it("issues tokens through PKCE and returns the account", async () => {
    const tokens = await nativeLogin("alice@example.com");
    expect(tokens.user.email).toBe("alice@example.com");
    expect(tokens.user.plan).toBe("free");
    const me = await json<{ user: { email: string }; plan: string }>(await api(tokens.accessToken, "/api/v1/me"));
    expect(me.user.email).toBe("alice@example.com");
    expect(me.plan).toBe("free");
  });

  it("redirects anonymous users to the login page", async () => {
    const { challenge } = await pkce();
    const res = await SELF.fetch(
      url(`/auth/native/authorize?client_id=ios&redirect_uri=${encodeURIComponent("openkoto://auth/callback")}&code_challenge=${challenge}&code_challenge_method=S256`),
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login\?next=/);
  });

  it("rejects redirect URIs outside the allow-list", async () => {
    const cookie = await signInWithEmail("mallory@example.com");
    const { challenge } = await pkce();
    const res = await SELF.fetch(
      url(`/auth/native/authorize?client_id=ios&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${challenge}&code_challenge_method=S256`),
      { headers: { Cookie: cookie }, redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const tokens = await nativeLogin("bob@example.com");
    const refresh = (token: string) =>
      SELF.fetch(url("/api/v1/auth/token"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: token }),
      });

    const first = await refresh(tokens.refreshToken);
    expect(first.status).toBe(200);
    const rotated = await json<{ refreshToken: string }>(first);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

    // Replaying the old token is treated as theft…
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
    // …and kills the new one too.
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
  });

  it("rejects tampered access tokens", async () => {
    const tokens = await nativeLogin("carol@example.com");
    const res = await api(`${tokens.accessToken.slice(0, -4)}AAAA`, "/api/v1/me");
    expect(res.status).toBe(401);
  });
});

describe("device code flow", () => {
  it("lets the CLI sign in after browser approval", async () => {
    const start = await json<{ deviceCode: string; userCode: string; interval: number }>(
      await SELF.fetch(url("/api/v1/auth/device/code"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: { platform: "cli", name: "laptop" } }),
      }),
    );
    expect(start.userCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const poll = () =>
      SELF.fetch(url("/api/v1/auth/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.deviceCode }).toString(),
      });

    const pending = await json<{ error: { code: string } }>(await poll());
    expect(pending.error.code).toBe("authorization_pending");

    const cookie = await signInWithEmail("dave@example.com");
    const approve = await SELF.fetch(url("/api/v1/auth/device/approve"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost:8787" },
      body: JSON.stringify({ userCode: start.userCode.toLowerCase().replace("-", "") }),
    });
    expect(approve.status).toBe(200);

    const done = await poll();
    expect(done.status).toBe(200);
    const tokens = await json<{ user: { email: string } }>(done);
    expect(tokens.user.email).toBe("dave@example.com");

    // A device code can only be redeemed once.
    expect((await poll()).status).toBe(400);
  });
});

describe("devices", () => {
  it("lists and revokes devices", async () => {
    const phone = await nativeLogin("erin@example.com");
    const list = await json<{ devices: { id: string; current: boolean }[] }>(await api(phone.accessToken, "/api/v1/devices"));
    expect(list.devices.some((d) => d.id === phone.deviceId && d.current)).toBe(true);

    expect((await api(phone.accessToken, `/api/v1/devices/${phone.deviceId}`, { method: "DELETE" })).status).toBe(200);
    const refresh = await SELF.fetch(url("/api/v1/auth/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: phone.refreshToken }),
    });
    expect(refresh.status).toBe(401);
  });
});
