import { describe, expect, it } from "vitest";
import { openAiCompatibleChat, translateChapterItems, translateLyricsLines, UsageMeter, type ChatFn } from "../src/ai-tasks";

describe("translateLyricsLines", () => {
  it("retries once when the reply is misaligned", async () => {
    const replies = [
      '[{"i":1,"translation":"一"}]',
      '```json\n[{"i":1,"translation":"一"},{"i":2,"translation":"二"}]\n```',
    ];
    const calls: number[] = [];
    const chat: ChatFn = async (messages) => {
      calls.push(messages.length);
      return { content: replies.shift()!, usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const meter = new UsageMeter();
    const out = await translateLyricsLines(meter.wrap(chat), { lines: ["one", "two"], targetLanguage: "zh" });
    expect(out).toEqual({ translations: ["一", "二"], aligned: true });
    expect(calls).toEqual([2, 4]);
    expect(meter).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 10 });
  });
});

describe("translateChapterItems", () => {
  it("batches and ignores unknown ids", async () => {
    const items = Array.from({ length: 35 }, (_, i) => ({ id: `s${i}`, text: `t${i}` }));
    const chat: ChatFn = async (messages) => {
      const ids = [...messages[1]!.content.matchAll(/\[(s\d+)\]/g)].map((m) => m[1]);
      return { content: JSON.stringify([...ids.map((id) => ({ id, translation: `T-${id}` })), { id: "bogus", translation: "x" }]) };
    };
    const progress: number[] = [];
    const out = await translateChapterItems(chat, items, { targetLanguage: "zh", onProgress: (d) => progress.push(d) });
    expect(out.size).toBe(35);
    expect(out.get("s34")).toBe("T-s34");
    expect(out.has("bogus")).toBe(false);
    expect(progress).toEqual([30, 35]);
  });
});

describe("openAiCompatibleChat", () => {
  it("posts to /chat/completions and reads usage", async () => {
    let seen: { url: string; body: string } | null = null;
    const chat = openAiCompatibleChat({
      baseUrl: "https://api.example.com/v1/",
      apiKey: "k",
      model: "m",
      fetch: async (url, init) => {
        seen = { url, body: init.body };
        return { ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) };
      },
    });
    const res = await chat([{ role: "user", content: "x" }]);
    expect(res).toEqual({ content: "hi", usage: { inputTokens: 3, outputTokens: 1 } });
    expect(seen!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(JSON.parse(seen!.body)).toMatchObject({ model: "m", stream: false });
  });
});
