import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/guard";
import { createServer, type LibraryApi } from "../src/server";

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

const WRITE_TOOLS = ["add_vocab", "review_vocab", "save_lyrics_translation", "create_lyrics"];

describe("mcp tools", () => {
  it("registers the expected tools and flags writes", async () => {
    const client = await connect(mockLibrary());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["add_vocab", "create_lyrics", "get_lyrics", "list_books", "list_due_vocab", "review_vocab", "save_lyrics_translation", "search_library"].sort(),
    );
    for (const tool of tools) {
      const isWrite = WRITE_TOOLS.includes(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(!isWrite);
      expect(tool.description!.includes("MODIFIES the user's OpenKoto data")).toBe(isWrite);
    }
    expect(tools.some((t) => /delete/i.test(t.name))).toBe(false);
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

describe("guard", () => {
  const me = (cli: boolean) => vi.fn(async () => ({ entitlements: { cli } }) as any);

  it("refuses when not logged in", async () => {
    const client = await connect(mockLibrary(), createGuard("none", me(true)));
    const result = await client.callTool({ name: "list_books", arguments: {} });
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("NOT_LOGGED_IN");
  });

  it("enforces the Plus entitlement and caches a positive check", async () => {
    const denied = me(false);
    const deniedClient = await connect(mockLibrary(), createGuard("credentials", denied));
    expect(payload(await deniedClient.callTool({ name: "list_books", arguments: {} })).error.code).toBe("PLAN_REQUIRED");

    const allowed = me(true);
    const lib = mockLibrary();
    const client = await connect(lib, createGuard("api_key", allowed));
    await client.callTool({ name: "list_books", arguments: {} });
    await client.callTool({ name: "list_books", arguments: {} });
    expect(allowed).toHaveBeenCalledTimes(1);
    expect(lib.listBooks).toHaveBeenCalledTimes(2);
  });
});
