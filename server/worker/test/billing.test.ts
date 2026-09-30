import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grantAllDueProCredits, grantDueProCredits } from "../src/billing/pro-credits";
import { generateActivationCodes } from "../src/billing/routes";
import { api, json, nativeLogin, url } from "./helpers";

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deliver(event: unknown, signature?: string): Promise<Response> {
  const body = JSON.stringify(event);
  return SELF.fetch(url("/api/webhooks/creem"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "creem-signature": signature ?? (await sign(body)) },
    body,
  });
}

interface Me {
  plan: string;
  credits: number;
  subscriptions: { plan: string; channel: string; autoRenew: boolean }[];
}

describe("creem webhooks", () => {
  it("rejects bad signatures", async () => {
    const res = await deliver({ id: "evt_bad", eventType: "checkout.completed", object: {} }, "deadbeef");
    expect(res.status).toBe(403);
  });

  it("activates Pro with its monthly credits exactly once", async () => {
    const t = await nativeLogin("buyer@example.com");
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const event = {
      id: "evt_1",
      eventType: "checkout.completed",
      object: {
        order: { id: "ord_1" },
        product: { id: "prod_pro_month" },
        customer: { email: "buyer@example.com" },
        subscription: { id: "sub_1", current_period_end_date: periodEnd },
        metadata: { userId: t.user.id },
      },
    };
    expect((await deliver(event)).status).toBe(200);
    expect(await json<{ result: string }>(await deliver(event))).toMatchObject({ result: "duplicate" });
    // subscription.paid for the same period must not grant credits twice.
    await deliver({ id: "evt_2", eventType: "subscription.paid", object: { id: "sub_1", product: "prod_pro_month", current_period_end_date: periodEnd, metadata: { userId: t.user.id } } });

    const me = await json<Me>(await api(t.accessToken, "/api/v1/me"));
    expect(me.plan).toBe("pro");
    expect(me.credits).toBe(1500);

    await deliver({ id: "evt_3", eventType: "subscription.canceled", object: { id: "sub_1", product: "prod_pro_month", metadata: { userId: t.user.id } } });
    const after = await json<Me>(await api(t.accessToken, "/api/v1/me"));
    expect(after.plan).toBe("pro");
    expect(after.subscriptions[0]!.autoRenew).toBe(false);

    await deliver({ id: "evt_4", eventType: "subscription.expired", object: { id: "sub_1", product: "prod_pro_month", metadata: { userId: t.user.id } } });
    expect((await json<Me>(await api(t.accessToken, "/api/v1/me"))).plan).toBe("free");
  });

  it("adds purchased credits and matches users by email", async () => {
    const t = await nativeLogin("credits@example.com");
    await deliver({
      id: "evt_c1",
      eventType: "checkout.completed",
      object: { order: { id: "ord_c1" }, product: { id: "prod_credits_3000" }, customer: { email: "Credits@Example.com" } },
    });
    expect((await json<Me>(await api(t.accessToken, "/api/v1/me"))).credits).toBe(3000);
  });
});

describe("activation codes", () => {
  it("redeems a code once and stacks periods", async () => {
    const [code1, code2] = await generateActivationCodes(env, { batch: "xhs-test", plan: "plus", durationDays: 30, credits: 100, count: 2 });
    const t = await nativeLogin("redeem@example.com");
    const redeem = (code: string) => api(t.accessToken, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });

    const first = await json<{ plan: string; periodEnd: string }>(await redeem(code1!.toLowerCase().replace(/-/g, " ")));
    expect(first.plan).toBe("plus");
    expect((await redeem(code1!)).status).toBe(404);

    const second = await json<{ periodEnd: string }>(await redeem(code2!));
    const gapDays = (Date.parse(second.periodEnd) - Date.parse(first.periodEnd)) / 86400000;
    expect(Math.round(gapDays)).toBe(30);

    const me = await json<Me>(await api(t.accessToken, "/api/v1/me"));
    expect(me.plan).toBe("plus");
    expect(me.credits).toBe(200);
  });

  it("gives free accounts one access token and Plus more", async () => {
    const t = await nativeLogin("keys@example.com");
    const create = () => api(t.accessToken, "/api/v1/keys", { method: "POST", body: JSON.stringify({ name: "cli", scopes: ["vocab:read"] }) });
    const created = await json<{ key: string }>(await create());
    expect(created.key).toMatch(/^ok_live_/);
    const second = await create();
    expect(second.status).toBe(403);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("QUOTA_EXCEEDED");
    const [code] = await generateActivationCodes(env, { batch: "t", plan: "plus", durationDays: 30, credits: 0, count: 1 });
    await api(t.accessToken, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
    expect((await create()).status).toBe(201);
    const viaKey = await api(created.key, "/api/v1/me");
    expect(viaKey.status).toBe(200);
    // Key scopes are enforced.
    expect((await api(created.key, "/api/v1/sync/pull")).status).toBe(403);
  });

  it("pays Pro credits monthly, not up front, and only once per 30 days", async () => {
    const t = await nativeLogin("pro-monthly@example.com");
    const [code] = await generateActivationCodes(env, { batch: "t", plan: "pro", durationDays: 365, credits: 0, count: 1 });
    await api(t.accessToken, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
    const balance = async () => (await json<{ credits: number }>(await api(t.accessToken, "/api/v1/me"))).credits;
    expect(await balance()).toBe(1500);
    expect(await grantDueProCredits(env, t.user.id)).toBe(false); // same period: nothing more
    expect(await balance()).toBe(1500);
    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    expect(await grantAllDueProCredits(env, later)).toBe(1);
    expect(await balance()).toBe(3000);
  });
});

describe("catalog", () => {
  it("lists SKUs and marks those sold on the web", async () => {
    const body = await json<{ skus: { id: string; web: boolean; priceCny: number }[] }>(await SELF.fetch(url("/api/v1/billing/plans")));
    expect(body.skus.find((s) => s.id === "plus_year")).toMatchObject({ web: true, priceCny: 68 });
    expect(body.skus.find((s) => s.id === "plus_month")).toMatchObject({ web: false, priceCny: 8 });
  });
});
