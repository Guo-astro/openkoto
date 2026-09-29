import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCredits } from "../src/billing/credits";
import { creditsFor } from "../src/ai/service";
import { api, json, nativeLogin } from "./helpers";

const realFetch = globalThis.fetch;

function mockProvider(reply: (body: { messages: { role: string; content: string }[] }) => string, usage = { prompt_tokens: 1000, completion_tokens: 500 }) {
  const calls: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://ai.test/")) return realFetch(input as RequestInfo, init);
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply(body) } }], usage }), { headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

interface Me {
  credits: number;
}

describe("hosted AI", () => {
  it("refuses without credits", async () => {
    const t = await nativeLogin("ai-poor@example.com");
    mockProvider(() => "你好");
    const res = await api(t.accessToken, "/api/v1/ai/translate", { method: "POST", body: JSON.stringify({ text: "hello", targetLanguage: "zh" }) });
    expect(res.status).toBe(402);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("charges actual usage, refunds the rest, and serves repeats from cache", async () => {
    const t = await nativeLogin("ai-rich@example.com");
    await addCredits(env, t.user.id, 1000, "adjust", "test");
    const calls = mockProvider(() => "你好世界");
    const body = JSON.stringify({ text: "hello world unique-1", targetLanguage: "zh" });
    const first = await json<{ translation: string; credits: number; cached: boolean }>(
      await api(t.accessToken, "/api/v1/ai/translate", { method: "POST", body }),
    );
    expect(first).toMatchObject({ translation: "你好世界", cached: false, credits: creditsFor(1000, 500) });
    const me = await json<Me>(await api(t.accessToken, "/api/v1/me"));
    expect(me.credits).toBe(1000 - creditsFor(1000, 500));

    const second = await json<{ cached: boolean; credits: number }>(await api(t.accessToken, "/api/v1/ai/translate", { method: "POST", body }));
    expect(second).toMatchObject({ cached: true, credits: 0 });
    expect(calls).toHaveLength(1);
  });

  it("translates lyrics line by line", async () => {
    const t = await nativeLogin("ai-lyrics@example.com");
    await addCredits(env, t.user.id, 1000, "adjust", "test");
    mockProvider(() => JSON.stringify([{ i: 1, translation: "一" }, { i: 2, translation: "二" }]));
    const res = await json<{ translations: string[]; aligned: boolean }>(
      await api(t.accessToken, "/api/v1/ai/translate-lyrics", { method: "POST", body: JSON.stringify({ lines: ["one", "two"], targetLanguage: "zh", title: "t" }) }),
    );
    expect(res).toMatchObject({ translations: ["一", "二"], aligned: true });
  });

  it("refunds everything when the provider fails", async () => {
    const t = await nativeLogin("ai-fail@example.com");
    await addCredits(env, t.user.id, 500, "adjust", "test");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://ai.test/")) return new Response("boom", { status: 500 });
      return realFetch(input as RequestInfo, init);
    });
    const res = await api(t.accessToken, "/api/v1/ai/translate", { method: "POST", body: JSON.stringify({ text: "fail me", targetLanguage: "zh" }) });
    expect(res.status).toBe(502);
    expect((await json<Me>(await api(t.accessToken, "/api/v1/me"))).credits).toBe(500);
  });
});

describe("book jobs", () => {
  it("segments and translates each chapter via the queue", async () => {
    const t = await nativeLogin("ai-book@example.com");
    await addCredits(env, t.user.id, 5000, "adjust", "test");
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();
    const hlc = `${String(Date.now()).padStart(13, "0")}-0001-a1b2c3d4`;
    await api(t.accessToken, "/api/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({
        deviceId: "d",
        ops: [
          { opId: "b1", type: "Book", id: bookId, baseRev: 0, hlc, deleted: false, payload: { title: "Book", format: "txt", totalChars: 20, defaultMode: "native", originalOnly: false, createdAt: "2026-09-28T00:00:00Z" } },
          { opId: "b2", type: "Article", id: chapterId, baseRev: 0, hlc, deleted: false, payload: { title: "Ch1", content: "Hello there. How are you?", sourceType: "book", createdAt: "2026-09-28T00:00:00Z" } },
          { opId: "b3", type: "BookChapter", id: chapterId, baseRev: 0, hlc, deleted: false, payload: { articleId: chapterId, bookId, index: 0, isSegmented: false, charCount: 25 } },
        ],
      }),
    });
    mockProvider((body) => {
      const ids = [...body.messages[1]!.content.matchAll(/\[([0-9a-f-]{36})\]/g)].map((m) => m[1]);
      return JSON.stringify(ids.map((id) => ({ id, translation: `译-${id!.slice(0, 4)}` })));
    });
    const created = await json<{ id: string; total: number }>(
      await api(t.accessToken, "/api/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "translate_book", bookId, targetLanguage: "zh" }) }),
    );
    expect(created.total).toBe(1);
    // Run the queue step directly (the test runtime doesn't deliver queue messages).
    const { runTranslateBookStep } = await import("../src/ai/jobs");
    await runTranslateBookStep(env, created.id, t.user.id);
    const job = await json<{ status: string; progress: number }>(await api(t.accessToken, `/api/v1/jobs/${created.id}`));
    expect(job).toMatchObject({ status: "done", progress: 1 });

    const pulled = await json<{ records: { type: string; payload: { translation?: string; text?: string } | null }[] }>(
      await api(t.accessToken, "/api/v1/sync/pull?limit=500"),
    );
    const segments = pulled.records.filter((r) => r.type === "Segment");
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.payload?.translation?.startsWith("译-"))).toBe(true);
  });
});
