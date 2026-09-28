import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createOpenKotoMcpServer as createServer, reviewStats, type LibraryApi } from "../src/index";

function mockLibrary(): { [K in keyof LibraryApi]: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn(async () => ({ items: [{ kind: "lyrics", id: "l1", title: "Song" }], total: 1 })),
    listVocab: vi.fn(async () => ({ items: [{ id: "v1", word: "猫" }], total: 1 })),
    addVocab: vi.fn(async (input: { word: string }) => ({ vocab: { id: "v2", word: input.word }, created: true, deduped: false })),
    reviewVocab: vi.fn(async (id: string) => ({ vocab: { id, dueDate: "2026-10-01" }, event: { grade: 3 } })),
    getLyrics: vi.fn(async () => ({
      article: { id: "l1", title: "Song", content: "a\nb", createdAt: "" },
      meta: { articleId: "l1", artist: "Artist" },
      segments: [
        { id: "s1", articleId: "l1", order: 0, text: "a", isNewParagraph: true, createdAt: "", startTime: 1, endTime: 2 },
        { id: "s2", articleId: "l1", order: 1, text: "b", translation: "B", isNewParagraph: true, createdAt: "" },
      ],
    })),
    saveLyricsTranslations: vi.fn(async () => ({ ok: true, updated: 1, total: 2 })),
    createLyrics: vi.fn(async (input: { title?: string }) => ({ article: { id: "l2", title: input.title ?? "t" }, meta: {}, segments: [{}, {}] })),
    listBooks: vi.fn(async () => ({ items: [{ id: "b1", title: "Novel" }], total: 1 })),
    listChapters: vi.fn(async () => ({ book: { id: "b1", title: "Novel" }, items: [], total: 0 })),
    updateVocab: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ vocab: { id, word: "猫", ...patch } })),
    translateLyricsHosted: vi.fn(async (input: { lines: string[] }) => ({ translations: input.lines.map((l) => l.toUpperCase()), aligned: true, credits: 4 })),
    getArticle: vi.fn(async (id: string) => ({
      article: { id, title: "Chapter 1", content: "First para.\nSecond para.", createdAt: "" },
      segments: id === "raw" ? [] : [{ id: "s1", articleId: id, order: 0, text: "First para.", translation: "第一段。", isNewParagraph: true, createdAt: "" }],
    })),
    createPack: vi.fn(async (input: { name: string }) => ({ pack: { id: "p1", name: input.name }, created: true })),
    extractVocabHosted: vi.fn(async () => ({ items: [{ word: "懐かしい", meaning: "怀念", reading: "なつかしい" }, { word: "猫", meaning: "猫" }], credits: 2, cached: false })),
  };
}

async function connect(library: ReturnType<typeof mockLibrary>, guard?: () => Promise<void>) {
  const server = createServer(library as unknown as LibraryApi, { guard });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

const WRITE_TOOLS = ["add_vocab", "update_vocab", "review_vocab", "save_lyrics_translation", "create_lyrics", "translate_lyrics", "create_word_pack_from_text"];

describe("mcp tools", () => {
  it("registers the expected tools and flags writes", async () => {
    const client = await connect(mockLibrary());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_vocab",
        "create_lyrics",
        "create_word_pack_from_text",
        "get_lyrics",
        "get_review_stats",
        "list_books",
        "list_due_vocab",
        "read_chapter",
        "review_vocab",
        "save_lyrics_translation",
        "search_library",
        "translate_lyrics",
        "update_vocab",
      ].sort(),
    );
    for (const tool of tools) {
      const isWrite = WRITE_TOOLS.includes(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(!isWrite);
      expect(tool.description!.includes("MODIFIES the user's OpenKoto data")).toBe(isWrite);
    }
    expect(tools.some((t) => /delete/i.test(t.name))).toBe(false);
    for (const name of ["translate_lyrics", "create_word_pack_from_text"]) {
      expect(tools.find((t) => t.name === name)!.description).toContain("AI credits");
    }
  });

  it("calls the library with the tool arguments", async () => {
    const lib = mockLibrary();
    const client = await connect(lib);

    expect(payload(await client.callTool({ name: "search_library", arguments: { query: "song", types: ["lyrics"] } }))).toMatchObject({ total: 1 });
    expect(lib.search).toHaveBeenCalledWith("song", { types: ["lyrics"], limit: 20 });

    await client.callTool({ name: "list_due_vocab", arguments: { pack: "N3" } });
    expect(lib.listVocab).toHaveBeenCalledWith({ due: true, limit: 50, pack: "N3" });

    const added = payload(await client.callTool({ name: "add_vocab", arguments: { word: "懐かしい", meaning: "nostalgic" } }));
    expect(added).toMatchObject({ created: true, vocab: { word: "懐かしい" } });

    await client.callTool({ name: "review_vocab", arguments: { id: "v1", grade: 3 } });
    expect(lib.reviewVocab).toHaveBeenCalledWith("v1", 3);

    const lyrics = payload(await client.callTool({ name: "get_lyrics", arguments: { id: "l1" } }));
    expect(lyrics).toEqual({
      id: "l1",
      title: "Song",
      artist: "Artist",
      language: null,
      lines: [
        { order: 0, text: "a", translation: null, startTime: 1, endTime: 2 },
        { order: 1, text: "b", translation: "B", startTime: null, endTime: null },
      ],
    });

    await client.callTool({ name: "save_lyrics_translation", arguments: { id: "l1", translations: [{ order: 0, translation: "A" }] } });
    expect(lib.saveLyricsTranslations).toHaveBeenCalledWith("l1", [{ order: 0, translation: "A" }]);

    expect(payload(await client.callTool({ name: "create_lyrics", arguments: { raw: "x\ny", title: "New" } }))).toEqual({ id: "l2", title: "New", lines: 2 });

    await client.callTool({ name: "list_books", arguments: {} });
    expect(lib.listBooks).toHaveBeenCalled();
    await client.callTool({ name: "list_books", arguments: { bookId: "b1" } });
    expect(lib.listChapters).toHaveBeenCalledWith("b1");
  });

  it("rejects invalid arguments", async () => {
    const lib = mockLibrary();
    const client = await connect(lib);
    const result = await client.callTool({ name: "review_vocab", arguments: { id: "v1", grade: 9 } });
    expect(result.isError).toBe(true);
    expect(lib.reviewVocab).not.toHaveBeenCalled();
  });

  it("returns API errors as tool errors", async () => {
    const lib = mockLibrary();
    lib.addVocab.mockRejectedValueOnce(Object.assign(new Error("vocabulary limit reached"), { status: 402, code: "QUOTA_EXCEEDED" }));
    const client = await connect(lib);
    const result = await client.callTool({ name: "add_vocab", arguments: { word: "x" } });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatchObject({ code: "QUOTA_EXCEEDED", message: expect.stringContaining("Plus") });
  });
});

describe("new tools", () => {
  it("translate_lyrics translates missing lines and saves them", async () => {
    const lib = mockLibrary();
    const client = await connect(lib);
    const out = payload(await client.callTool({ name: "translate_lyrics", arguments: { id: "l1", targetLanguage: "en" } }));
    expect(lib.translateLyricsHosted).toHaveBeenCalledWith({ lines: ["a", "b"], targetLanguage: "en", title: "Song", artist: "Artist" });
    // Line 1 already had "B", so only line 0 is written.
    expect(lib.saveLyricsTranslations).toHaveBeenCalledWith("l1", [{ order: 0, translation: "A" }]);
    expect(out).toMatchObject({ id: "l1", credits: 4, lines: [{ translation: "A" }, { translation: "B" }] });

    await client.callTool({ name: "translate_lyrics", arguments: { id: "l1", targetLanguage: "en", overwrite: true } });
    expect(lib.saveLyricsTranslations).toHaveBeenLastCalledWith("l1", [
      { order: 0, translation: "A" },
      { order: 1, translation: "B" },
    ]);
  });

  it("update_vocab passes only the given fields", async () => {
    const lib = mockLibrary();
    const client = await connect(lib);
    await client.callTool({ name: "update_vocab", arguments: { id: "v1", meaning: "cat", suspended: true } });
    expect(lib.updateVocab).toHaveBeenCalledWith("v1", { meaning: "cat", suspended: true });
  });

  it("read_chapter pages segments and falls back to paragraphs", async () => {
    const lib = mockLibrary();
    const client = await connect(lib);
    expect(payload(await client.callTool({ name: "read_chapter", arguments: { id: "c1" } }))).toMatchObject({
      segmented: true,
      total: 1,
      sentences: [{ order: 0, text: "First para.", translation: "第一段。" }],
    });
    expect(payload(await client.callTool({ name: "read_chapter", arguments: { id: "raw", offset: 1 } }))).toMatchObject({
      segmented: false,
      total: 2,
      sentences: [{ order: 1, text: "Second para.", translation: null }],
    });
  });

  it("create_word_pack_from_text extracts, creates the pack and adds cards", async () => {
    const lib = mockLibrary();
    lib.addVocab.mockImplementation(async (input: { word: string }) => ({ vocab: { id: `v-${input.word}`, word: input.word, meaning: "m" }, created: input.word !== "猫", deduped: input.word === "猫" }));
    const client = await connect(lib);
    const out = payload(
      await client.callTool({ name: "create_word_pack_from_text", arguments: { text: "懐かしい猫", name: "Song words", targetLanguage: "zh", level: "N3", sourceArticleId: "l1" } }),
    );
    expect(lib.extractVocabHosted).toHaveBeenCalledWith({ text: "懐かしい猫", targetLanguage: "zh", max: undefined, level: "N3" });
    expect(lib.createPack).toHaveBeenCalledWith({ name: "Song words", languageTo: "zh" });
    expect(lib.addVocab).toHaveBeenCalledWith({ word: "懐かしい", meaning: "怀念", reading: "なつかしい", pack: "p1", sourceArticleId: "l1" });
    expect(out).toMatchObject({ pack: { id: "p1", name: "Song words" }, added: 1, merged: 1, credits: 2 });
  });

  it("get_review_stats summarises cards", async () => {
    const lib = mockLibrary();
    const today = "2026-09-28";
    lib.listVocab.mockImplementation(async (opts: { due?: boolean }) =>
      opts.due
        ? { items: [], total: 2, date: today }
        : {
            items: [
              { id: "1", word: "a", srsState: "new", stability: 0, difficulty: 0, dueDate: today, reviewCount: 0 },
              { id: "2", word: "b", srsState: "review", stability: 30, difficulty: 5, dueDate: "2026-10-02", reviewCount: 3, lastReviewedAt: `${today}T01:00:00Z` },
              { id: "3", word: "c", srsState: "learning", stability: 1, difficulty: 6, dueDate: today, reviewCount: 1, lastReviewedAt: "2026-09-20T01:00:00Z" },
              { id: "4", word: "d", srsState: "review", stability: 9, difficulty: 5, dueDate: "2026-12-01", reviewCount: 2, suspendedAt: "2026-09-01T00:00:00Z" },
            ],
            total: 4,
          },
    );
    const client = await connect(lib);
    const stats = payload(await client.callTool({ name: "get_review_stats", arguments: {} }));
    expect(stats).toMatchObject({
      date: today,
      total: 4,
      byState: { new: 1, learning: 1, review: 1 },
      suspended: 1,
      dueToday: 2,
      totalReviews: 6,
      dueQueue: 2,
      upcoming7d: { "2026-10-02": 1 },
      truncated: false,
    });
    expect(stats.retention.new).toBe(1);
  });

  it("reviewStats is pure", () => {
    expect(reviewStats([], "2026-09-28", new Date("2026-09-28T12:00:00Z"))).toMatchObject({ total: 0, dueToday: 0 });
  });
});
