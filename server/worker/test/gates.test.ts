import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateActivationCodes } from "../src/billing/routes";
import { api, json, nativeLogin } from "./helpers";

async function makePlus(token: string) {
  const [code] = await generateActivationCodes(env, { batch: "gates", plan: "plus", durationDays: 30, credits: 0, count: 1 });
  await api(token, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
}

describe("server-side plan gates", () => {
  it("blocks free CLI devices from the library API but not the phone app", async () => {
    const cli = await nativeLogin("gate-cli@example.com", "cli");
    expect((await api(cli.accessToken, "/api/v1/library/vocab")).status).toBe(403);
    const phone = await nativeLogin("gate-cli@example.com", "ios");
    expect((await api(phone.accessToken, "/api/v1/library/vocab")).status).toBe(200);
    await makePlus(phone.accessToken);
    expect((await api(cli.accessToken, "/api/v1/library/vocab")).status).toBe(200);
  });

  it("stops API keys after a downgrade", async () => {
    const t = await nativeLogin("gate-key@example.com");
    await makePlus(t.accessToken);
    const created = await json<{ key: string }>(
      await api(t.accessToken, "/api/v1/keys", { method: "POST", body: JSON.stringify({ name: "k", scopes: ["vocab:read"] }) }),
    );
    expect((await api(created.key, "/api/v1/library/vocab")).status).toBe(200);
    await env.DB.prepare("update subscriptions set period_end = ? where user_id = ?").bind(Date.now() - 1000, t.user.id).run();
    expect((await api(created.key, "/api/v1/library/vocab")).status).toBe(403);
  });

  it("rejects access tokens of revoked devices immediately", async () => {
    const t = await nativeLogin("gate-revoke@example.com");
    expect((await api(t.accessToken, "/api/v1/me")).status).toBe(200);
    await api(t.accessToken, `/api/v1/devices/${t.deviceId}`, { method: "DELETE" });
    expect((await api(t.accessToken, "/api/v1/me")).status).toBe(401);
  });
});
