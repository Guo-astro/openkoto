import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { filesOverFreeQuota, MIN_NOTICE_MS, PURGE_AFTER_MS, runLapsedCleanup } from "../src/billing/lapsed-cleanup";
import { generateActivationCodes } from "../src/billing/routes";
import { api, nativeLogin } from "./helpers";

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

describe("lapsed membership cleanup", () => {
  it("keeps the newest files within the free storage", () => {
    const files = [
      { key: "old", size: 30 * MB, uploaded: 1 },
      { key: "mid", size: 30 * MB, uploaded: 2 },
      { key: "new", size: 30 * MB, uploaded: 3 },
    ];
    expect(filesOverFreeQuota(files, 50 * MB).map((f) => f.key)).toEqual(["mid", "old"]);
    expect(filesOverFreeQuota(files, 100 * MB)).toEqual([]);
  });

  it("reminds at 60 days, removes only book files above 50 MB at 90, and gives 30 days' notice", async () => {
    const t = await nativeLogin("lapsed@example.com");
    const [code] = await generateActivationCodes(env, { batch: "lapsed", plan: "plus", durationDays: 30, credits: 0, count: 1 });
    await api(t.accessToken, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
    const bookA = "11111111-1111-4111-8111-111111111111";
    const bookB = "22222222-2222-4222-8222-222222222222";
    await env.BUCKET.put(`books/${t.user.id}/${bookA}/a.epub`, new Uint8Array(40 * MB));
    await env.BUCKET.put(`blobs/${t.user.id}/Book/${bookB}/${"b".repeat(64)}`, new Uint8Array(40 * MB));
    await env.BUCKET.put(`blobs/${t.user.id}/Vocabulary/x/${"c".repeat(64)}`, new Uint8Array(1 * MB));

    const lapsedAt = Date.now() - 61 * DAY;
    await env.DB.prepare("update subscriptions set period_end = ? where user_id = ?").bind(lapsedAt, t.user.id).run();

    const log = vi.spyOn(console, "log");
    expect(await runLapsedCleanup(env)).toMatchObject({ reminded: 1, purged: 0 });
    expect(log.mock.calls.some((c) => String(c.join(" ")).includes("to=lapsed@example.com"))).toBe(true);
    log.mockRestore();

    // Day 91 but only one day after the reminder: still waiting out the notice period.
    const day91 = lapsedAt + PURGE_AFTER_MS + DAY;
    expect(await runLapsedCleanup(env, day91 - 29 * DAY)).toMatchObject({ purged: 0 });

    const later = Date.now() + MIN_NOTICE_MS + DAY;
    expect(await runLapsedCleanup(env, later)).toMatchObject({ purged: 1 });
    const left = (await env.BUCKET.list({ prefix: `books/${t.user.id}/` })).objects.length + (await env.BUCKET.list({ prefix: `blobs/${t.user.id}/Book/` })).objects.length;
    expect(left).toBe(1); // one 40 MB book kept (the newest), the other removed
    expect((await env.BUCKET.list({ prefix: `blobs/${t.user.id}/Vocabulary/` })).objects).toHaveLength(1); // non-book files untouched

    const missing = await api(t.accessToken, `/api/v1/books/${bookA}/file`);
    const missingB = await api(t.accessToken, `/api/v1/sync/blob/${encodeURIComponent(`Book/${bookB}/${"b".repeat(64)}`)}`);
    expect([missing.status, missingB.status]).toContain(410);
  });

  it("leaves members who renewed alone", async () => {
    const t = await nativeLogin("renewed@example.com");
    const [code] = await generateActivationCodes(env, { batch: "lapsed", plan: "plus", durationDays: 400, credits: 0, count: 1 });
    await api(t.accessToken, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
    await env.BUCKET.put(`books/${t.user.id}/33333333-3333-4333-8333-333333333333/a.epub`, new Uint8Array(60 * MB));
    expect(await runLapsedCleanup(env)).toMatchObject({ reminded: 0, purged: 0 });
  });
});
