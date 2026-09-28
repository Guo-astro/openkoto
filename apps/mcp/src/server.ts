// OpenKoto MCP server: coarse, task-shaped tools over the /api/v1/library API
// (design doc §10.2). Write tools say so in their description so MCP clients ask
// the user before running them; no delete tools are exposed.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { LibraryClient } from "@openkoto/cli";

export const SERVER_NAME = "openkoto";
export const SERVER_VERSION = "0.1.0";

/** The subset of LibraryClient the tools use (mockable in tests). */
export type LibraryApi = Pick<
  LibraryClient,
  "search" | "listVocab" | "addVocab" | "reviewVocab" | "getLyrics" | "saveLyricsTranslations" | "createLyrics" | "listBooks" | "listChapters"
>;

export interface ServerOptions {
  /** Called before every tool; throw to refuse (e.g. not logged in / plan gate). */
  guard?: () => Promise<void>;
}

const WRITE_NOTE = "This tool MODIFIES the user's OpenKoto data (synced to all their devices).";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const e = err as { code?: string; status?: number; message?: string };
  const code = e?.code ?? "ERROR";
  let message = e?.message ?? String(err);
  if (e?.status === 402 || code === "QUOTA_EXCEEDED") message += " (plan quota reached — the user can upgrade to OpenKoto Plus)";
  if (e?.status === 401) message += " (not signed in — run `koto login` or set KOTO_API_KEY)";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
}

function wrap<A>(guard: ServerOptions["guard"], fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      await guard?.();
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

const grade = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
  .describe("1 = again (forgot), 2 = hard, 3 = good, 4 = easy");

export function createServer(library: LibraryApi, opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "OpenKoto is a language-learning library (books, articles, song lyrics) with FSRS vocabulary review. " +
        "Use search_library / get_lyrics / list_books to read, list_due_vocab + review_vocab for review sessions " +
        "(show the word, let the user answer, then grade), and add_vocab to save new words. Ids are opaque strings.",
    },
  );
  const g = opts.guard;

  server.registerTool(
    "search_library",
    {
      title: "Search library",
      description: "Search the user's books, articles, song lyrics and vocabulary by keyword (title, artist, text, word or meaning).",
      inputSchema: {
        query: z.string().describe("keywords; empty string lists everything"),
        types: z.array(z.enum(["book", "article", "lyrics", "vocab"])).optional().describe("restrict to these kinds"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(g, (a: { query: string; types?: string[]; limit?: number }) => library.search(a.query, { types: a.types, limit: a.limit ?? 20 })),
  );

  server.registerTool(
    "list_due_vocab",
    {
      title: "List due vocabulary",
      description: "Vocabulary cards due for review today (FSRS queue: new/learning first, then reviews). Returns word, reading, meaning, example and card id.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        pack: z.string().optional().describe("word pack id or name"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(g, (a: { limit?: number; pack?: string }) => library.listVocab({ due: true, limit: a.limit ?? 50, pack: a.pack })),
  );

  server.registerTool(
    "add_vocab",
    {
      title: "Add vocabulary",
      description: `Save a word to the user's vocabulary (duplicates are merged, empty fields filled in). ${WRITE_NOTE}`,
      inputSchema: {
        word: z.string().min(1),
        meaning: z.string().optional(),
        reading: z.string().optional().describe("pronunciation, e.g. kana or pinyin"),
        example: z.string().optional().describe("example sentence"),
        pack: z.string().optional().describe("word pack id or name; created if it does not exist"),
        sourceArticleId: z.string().optional().describe("article/lyrics id the word came from"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(g, (a: { word: string; meaning?: string; reading?: string; example?: string; pack?: string; sourceArticleId?: string }) => library.addVocab(a)),
  );

  server.registerTool(
    "review_vocab",
    {
      title: "Grade a review",
      description: `Record the result of reviewing one vocabulary card and reschedule it with FSRS. ${WRITE_NOTE}`,
      inputSchema: { id: z.string().min(1).describe("vocabulary card id"), grade },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(g, (a: { id: string; grade: number }) => library.reviewVocab(a.id, a.grade)),
  );

  server.registerTool(
    "get_lyrics",
    {
      title: "Get lyrics",
      description: "Fetch saved song lyrics: title, artist and every line (order, text, timing, translation if any).",
      inputSchema: { id: z.string().min(1).describe("lyrics id (from search_library)") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(g, async (a: { id: string }) => {
      const res = await library.getLyrics(a.id);
      return {
        id: res.article.id,
        title: res.article.title,
        artist: res.meta?.artist ?? null,
        language: res.meta?.language ?? null,
        lines: res.segments.map((s) => ({ order: s.order, text: s.text, translation: s.translation ?? null, startTime: s.startTime ?? null, endTime: s.endTime ?? null })),
      };
    }),
  );

  server.registerTool(
    "save_lyrics_translation",
    {
      title: "Save lyrics translation",
      description: `Write line-by-line translations for saved lyrics (matched by line order from get_lyrics; existing translations of those lines are replaced). ${WRITE_NOTE}`,
      inputSchema: {
        id: z.string().min(1).describe("lyrics id"),
        translations: z.array(z.object({ order: z.number().int().min(0), translation: z.string() })).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(g, (a: { id: string; translations: { order: number; translation: string }[] }) => library.saveLyricsTranslations(a.id, a.translations)),
  );

  server.registerTool(
    "create_lyrics",
    {
      title: "Create lyrics",
      description: `Save new song lyrics to the library from LRC, SRT or plain text (one line per lyric line), optionally with aligned translations. ${WRITE_NOTE}`,
      inputSchema: {
        raw: z.string().min(1).describe("the lyrics text (LRC timestamps are kept)"),
        title: z.string().optional().describe("required unless the LRC has a [ti:] tag"),
        artist: z.string().optional(),
        format: z.enum(["lrc", "srt", "txt"]).optional().describe("auto-detected when omitted"),
        language: z.string().optional().describe("language code of the lyrics, e.g. ja"),
        translations: z.array(z.string()).optional().describe("one translation per lyric line, same order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(g, async (a: { raw: string; title?: string; artist?: string; format?: "lrc" | "srt" | "txt"; language?: string; translations?: string[] }) => {
      const res = await library.createLyrics(a);
      return { id: res.article.id, title: res.article.title, lines: res.segments.length };
    }),
  );

  server.registerTool(
    "list_books",
    {
      title: "List books",
      description: "List the user's books; pass bookId to list that book's chapters instead (chapter ids can be read like articles).",
      inputSchema: { bookId: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(g, (a: { bookId?: string }) => (a.bookId ? library.listChapters(a.bookId) : library.listBooks())),
  );

  return server;
}
