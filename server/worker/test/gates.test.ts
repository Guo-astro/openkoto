import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FREE_AGENT_DAILY_LIMIT } from "../src/billing/agent-quota";
import { generateActivationCodes } from "../src/billing/routes";
import { api, json, nativeLogin } from "./helpers";

async function makePlus(token: string) {
  const [code] = await generateActivationCodes(env, { batch: "gates", plan: "plus", durationDays: 30, credits: 0, count: 1 });
  await api(token, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
}

describe("server-side plan gates", () => {
  it("gives free CLI devices a daily allowance and Plus unlimited access", async () => {
    const cli = await nativeLogin("gate-cli@example.com", "cli");
    expect((await api(cli.accessToken, "/api/v1/library/vocab")).status).toBe(200);
    // Use up today's allowance (one call above).
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("update agent_usage set count = ? where user_id = ? and day = ?").bind(FREE_AGENT_DAILY_LIMIT, cli.user.id, day).run();
    const over = await api(cli.accessToken, "/api/v1/library/vocab");
    expect(over.status).toBe(429);
    expect((await json<{ error: { code: string } }>(over)).error.code).toBe("FREE_LIMIT_REACHED");
    // The phone app is not an agent and is never counted.
    const phone = await nativeLogin("gate-cli@example.com", "ios");
    expect((await api(phone.accessToken, "/api/v1/library/vocab")).status).toBe(200);
    const me = await json<{ entitlements: { cli: boolean; cliDailyLimit: number | null } }>(await api(phone.accessToken, "/api/v1/me"));
    expect(me.entitlements).toMatchObject({ cli: true, cliDailyLimit: FREE_AGENT_DAILY_LIMIT });
    await makePlus(phone.accessToken);
    expect((await api(cli.accessToken, "/api/v1/library/vocab")).status).toBe(200);
  });

  it("meters access tokens by plan after a downgrade", async () => {
    const t = await nativeLogin("gate-key@example.com");
    await makePlus(t.accessToken);
    const created = await json<{ key: string }>(
      await api(t.accessToken, "/api/v1/keys", { method: "POST", body: JSON.stringify({ name: "k", scopes: ["vocab:read"] }) }),
    );
    expect((await api(created.key, "/api/v1/library/vocab")).status).toBe(200);
    await env.DB.prepare("update subscriptions set period_end = ? where user_id = ?").bind(Date.now() - 1000, t.user.id).run();
    // Still works on the free plan, within the free daily allowance.
    expect((await api(created.key, "/api/v1/library/vocab")).status).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("update agent_usage set count = ? where user_id = ? and day = ?").bind(FREE_AGENT_DAILY_LIMIT, t.user.id, day).run();
    expect((await api(created.key, "/api/v1/library/vocab")).status).toBe(429);
  });

  it("rejects access tokens of revoked devices immediately", async () => {
    const t = await nativeLogin("gate-revoke@example.com");
    expect((await api(t.accessToken, "/api/v1/me")).status).toBe(200);
    await api(t.accessToken, `/api/v1/devices/${t.deviceId}`, { method: "DELETE" });
    expect((await api(t.accessToken, "/api/v1/me")).status).toBe(401);
  });
});
