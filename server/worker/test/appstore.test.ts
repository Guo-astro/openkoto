import { SELF } from "cloudflare:test";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, json, nativeLogin, url } from "./helpers";

const realFetch = globalThis.fetch;
const secret = new TextEncoder().encode("not-apple");

function jws(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).sign(secret);
}

function mockApple(transactions: Record<string, Record<string, unknown>>) {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /\/inApps\/v1\/transactions\/(\d+)$/.exec(href);
    if (!match) return realFetch(input as RequestInfo, init);
    seen.push(href);
    expect(String(new Headers(init?.headers).get("Authorization"))).toMatch(/^Bearer ey/);
    const tx = transactions[match[1]!];
    if (!tx) return new Response("{}", { status: 404 });
    return Response.json({ signedTransactionInfo: await jws(tx) });
  });
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe("App Store purchases", () => {
  it("verifies with Apple, binds to the account and grants Pro with credits once", async () => {
    const t = await nativeLogin("ios-buyer@example.com");
    const expires = Date.now() + 30 * 86400000;
    mockApple({
      "2000000001": {
        transactionId: "2000000001",
        originalTransactionId: "2000000001",
        bundleId: "com.openkoto.ios",
        productId: "com.openkoto.pro.month",
        appAccountToken: t.user.id.toUpperCase(),
        expiresDate: expires,
        environment: "Sandbox",
        type: "Auto-Renewable Subscription",
      },
    });
    // The client-provided JWS is only used for its transactionId (a forged payload can't grant anything).
    const signedTransaction = await jws({ transactionId: "2000000001", productId: "com.openkoto.pro.year" });
    const verify = () => api(t.accessToken, "/api/v1/billing/appstore/verify", { method: "POST", body: JSON.stringify({ signedTransaction }) });
    expect(await json(await verify())).toMatchObject({ ok: true, sku: "pro_month", plan: "pro" });
    await verify();
    const me = await json<{ plan: string; credits: number }>(await api(t.accessToken, "/api/v1/me"));
    expect(me).toMatchObject({ plan: "pro", credits: 1500 });
  });

  it("rejects transactions bought by another account", async () => {
    const t = await nativeLogin("ios-thief@example.com");
    mockApple({
      "2000000002": {
        transactionId: "2000000002",
        originalTransactionId: "2000000002",
        bundleId: "com.openkoto.ios",
        productId: "com.openkoto.credits.3000",
        appAccountToken: crypto.randomUUID(),
        environment: "Sandbox",
        type: "Consumable",
      },
    });
    const res = await api(t.accessToken, "/api/v1/billing/appstore/verify", { method: "POST", body: JSON.stringify({ signedTransaction: await jws({ transactionId: "2000000002" }) }) });
    expect(res.status).toBe(403);
  });

  it("processes server notifications idempotently", async () => {
    const t = await nativeLogin("ios-renew@example.com");
    mockApple({
      "2000000003": {
        transactionId: "2000000003",
        originalTransactionId: "1000000003",
        bundleId: "com.openkoto.ios",
        productId: "com.openkoto.plus.year",
        appAccountToken: t.user.id,
        expiresDate: Date.now() + 365 * 86400000,
        environment: "Sandbox",
        type: "Auto-Renewable Subscription",
      },
    });
    const signedPayload = await jws({ notificationUUID: "n-1", notificationType: "SUBSCRIBED", data: { signedTransactionInfo: await jws({ transactionId: "2000000003" }) } });
    const send = () => SELF.fetch(url("/api/webhooks/appstore"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedPayload }) });
    expect(await json(await send())).toMatchObject({ result: "processed" });
    expect(await json(await send())).toMatchObject({ result: "duplicate" });
    expect((await json<{ plan: string }>(await api(t.accessToken, "/api/v1/me"))).plan).toBe("plus");
  });
});
