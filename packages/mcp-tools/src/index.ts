// OpenKoto MCP tools: coarse, task-shaped tools over the high-level REST API
// (design doc §10.2). Shared by the stdio server (@openkoto/mcp) and the Worker's
// remote /mcp endpoint. Write tools say so in their description so MCP clients ask the
// user before running them; tools that spend AI credits say that too. No delete tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions as SdkServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { localDateString, retentionBand, type SrsState } from "@openkoto/core";
import type { LibraryClient, Vocab } from "@openkoto/client";
import { z } from "zod";

export const SERVER_NAME = "openkoto";
export const SERVER_VERSION = "0.2.0";

/** The subset of LibraryClient the tools use (mockable in tests). */
export type LibraryApi = Pick<
  LibraryClient,
  | "search"
  | "listVocab"
  | "addVocab"
  | "updateVocab"
  | "reviewVocab"
  | "getLyrics"
  | "saveLyricsTranslations"
  | "createLyrics"
  | "translateLyricsHosted"
  | "getArticle"
  | "listBooks"
  | "listChapters"
  | "createPack"
  | "extractVocabHosted"
>;

export interface ToolServerOptions {
  /** Called before every tool; throw to refuse (e.g. not logged in / plan gate). */
  guard?: () => Promise<void>;
  /** Passed through to the SDK server (e.g. a Workers-safe `jsonSchemaValidator`). */
  sdk?: SdkServerOptions;
  /** For deterministic stats in tests. */
  now?: () => Date;
}

export const WRITE_NOTE = "This tool MODIFIES the user's OpenKoto data (synced to all their devices).";
export const CREDITS_NOTE = "It uses hosted AI and spends the user's OpenKoto AI credits.";

const INSTRUCTIONS =
  "OpenKoto is a language-learning library (books, articles, song lyrics) with FSRS vocabulary review. " +
  "Use search_library / get_lyrics / list_books / read_chapter to read, list_due_vocab + review_vocab for review sessions " +
  "(show the word, let the user answer, then grade), get_review_stats for progress, and add_vocab / update_vocab / " +
  "create_word_pack_from_text to save words. Ids are opaque strings; take them from earlier results.";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const e = err as { code?: string; status?: number; message?: string };
  const code = e?.code ?? "ERROR";
  let message = e?.message ?? String(err);
  if (code === "INSUFFICIENT_CREDITS") message += " (the user needs more OpenKoto AI credits or Pro)";
  else if (e?.status === 402 || code === "QUOTA_EXCEEDED") message += " (plan quota reached — the user can upgrade to OpenKoto Plus)";
  if (e?.status === 401) message += " (not signed in — run `koto login`, set KOTO_API_KEY, or reconnect the MCP server)";
  if (e?.status === 403 && /scope/.test(message)) message += " (the API key lacks this permission)";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
}

function wrap<A>(guard: ToolServerOptions["guard"], fn: (args: A) => Promise<unknown>) {
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
const lang = z.string().regex(/^[A-Za-z-]{2,12}$/).describe("target language code, e.g. zh, en, ja");

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = (idempotent: boolean) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false }) as const;

/** Stats over the user's cards (spec §5 retention bands). */
export function reviewStats(cards: readonly Vocab[], today: string, now: Date) {
  const byState: Record<SrsState, number> = { new: 0, learning: 0, review: 0 };
  const retention = { new: 0, strong: 0, fading: 0, weak: 0 };
  const upcoming: Record<string, number> = {};
  const in7 = new Date(`${today}T00:00:00Z`);
  in7.setUTCDate(in7.getUTCDate() + 7);
  const horizon = in7.toISOString().slice(0, 10);
  let suspended = 0;
  let dueToday = 0;
  let reviewedToday = 0;
  let totalReviews = 0;
  for (const c of cards) {
    totalReviews += c.reviewCount ?? 0;
    if (c.suspendedAt) {
      suspended++;
      continue;
    }
    byState[c.srsState] = (byState[c.srsState] ?? 0) + 1;
    retention[retentionBand(c, now)]++;
    if (!c.dueDate || c.dueDate <= today) dueToday++;
    else if (c.dueDate <= horizon) upcoming[c.dueDate] = (upcoming[c.dueDate] ?? 0) + 1;
    if (c.lastReviewedAt && localDateString(c.lastReviewedAt) === today) reviewedToday++;
  }
  return { total: cards.length, byState, suspended, dueToday, reviewedToday, totalReviews, retention, upcoming7d: upcoming };
}

export function createOpenKotoMcpServer(library: LibraryApi, opts: ToolServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { ...(opts.sdk ?? {}), instructions: INSTRUCTIONS });
  const g = opts.guard;
  const now = opts.now ?? (() => new Date());

  // ---- read ---------------------------------------------------------------

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
      annotations: READ,
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
      annotations: READ,
    },
    wrap(g, (a: { limit?: number; pack?: string }) => library.listVocab({ due: true, limit: a.limit ?? 50, pack: a.pack })),
  );

  server.registerTool(
    "get_review_stats",
    {
      title: "Review statistics",
      description: "Learning progress: card counts by state, due today, reviewed today, retention bands (strong/fading/weak) and the next 7 days of due cards.",
      inputSchema: { pack: z.string().optional().describe("word pack id or name") },
      annotations: READ,
    },
    wrap(g, async (a: { pack?: string }) => {
      const [all, due] = await Promise.all([library.listVocab({ limit: 1000, pack: a.pack }), library.listVocab({ due: true, limit: 1, pack: a.pack })]);
      const today = due.date ?? localDateString(now());
      return { date: today, ...reviewStats(all.items, today, now()), dueQueue: due.total, truncated: all.total > all.items.length };
    }),
  );

  server.registerTool(
    "get_lyrics",
    {
      title: "Get lyrics",
      description: "Fetch saved song lyrics: title, artist and every line (order, text, timing, translation if any).",
      inputSchema: { id: z.string().min(1).describe("lyrics id (from search_library)") },
      annotations: READ,
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
    "list_books",
    {
      title: "List books",
      description: "List the user's books; pass bookId to list that book's chapters instead (read one with read_chapter).",
      inputSchema: { bookId: z.string().optional() },
      annotations: READ,
    },
    wrap(g, (a: { bookId?: string }) => (a.bookId ? library.listChapters(a.bookId) : library.listBooks())),
  );

  server.registerTool(
    "read_chapter",
    {
      title: "Read chapter or article",
      description:
        "Read a book chapter (articleId from list_books with bookId) or any article: its sentences in order with the user's saved translations. Use offset/limit to page through long chapters.",
      inputSchema: {
        id: z.string().min(1).describe("chapter article id or article id"),
        offset: z.number().int().min(0).optional().describe("first sentence (0-based)"),
        limit: z.number().int().min(1).max(1000).optional().describe("sentences to return (default 200)"),
      },
      annotations: READ,
    },
    wrap(g, async (a: { id: string; offset?: number; limit?: number }) => {
      const { article, segments } = await library.getArticle(a.id);
      const offset = a.offset ?? 0;
      const limit = a.limit ?? 200;
      if (!segments.length) {
        // Chapters that were never opened are not segmented yet: return paragraphs.
        const paragraphs = article.content.split("\n").map((t) => t.trim()).filter(Boolean);
        return {
          id: article.id,
          title: article.title,
          segmented: false,
          total: paragraphs.length,
          offset,
          sentences: paragraphs.slice(offset, offset + limit).map((text, i) => ({ order: offset + i, text, translation: null })),
        };
      }
      return {
        id: article.id,
        title: article.title,
        segmented: true,
        total: segments.length,
        offset,
        sentences: segments.slice(offset, offset + limit).map((s) => ({ order: s.order, text: s.text, translation: s.translation ?? null, newParagraph: s.isNewParagraph })),
      };
    }),
  );

  // ---- write --------------------------------------------------------------

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
      annotations: WRITE(true),
    },
    wrap(g, (a: { word: string; meaning?: string; reading?: string; example?: string; pack?: string; sourceArticleId?: string }) => library.addVocab(a)),
  );

  server.registerTool(
    "update_vocab",
    {
      title: "Update vocabulary",
      description: `Edit a vocabulary card (meaning, reading, example, usage), add it to a pack, or suspend/unsuspend it. Only the given fields change. ${WRITE_NOTE}`,
      inputSchema: {
        id: z.string().min(1),
        word: z.string().min(1).optional(),
        meaning: z.string().optional(),
        reading: z.string().optional(),
        example: z.string().optional(),
        usage: z.string().optional(),
        pack: z.string().optional().describe("also add the card to this pack (id or name)"),
        suspended: z.boolean().optional().describe("true = mastered/paused, excluded from review"),
      },
      annotations: WRITE(true),
    },
    wrap(g, ({ id, ...patch }: { id: string; word?: string; meaning?: string; reading?: string; example?: string; usage?: string; pack?: string; suspended?: boolean }) =>
      library.updateVocab(id, patch),
    ),
  );

  server.registerTool(
    "review_vocab",
    {
      title: "Grade a review",
      description: `Record the result of reviewing one vocabulary card and reschedule it with FSRS. Only grade answers the user actually gave. ${WRITE_NOTE}`,
      inputSchema: { id: z.string().min(1).describe("vocabulary card id"), grade },
      annotations: WRITE(false),
    },
    wrap(g, (a: { id: string; grade: number }) => library.reviewVocab(a.id, a.grade)),
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
      annotations: WRITE(true),
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
      annotations: WRITE(false),
    },
    wrap(g, async (a: { raw: string; title?: string; artist?: string; format?: "lrc" | "srt" | "txt"; language?: string; translations?: string[] }) => {
      const res = await library.createLyrics(a);
      return { id: res.article.id, title: res.article.title, lines: res.segments.length };
    }),
  );

  server.registerTool(
    "translate_lyrics",
    {
      title: "Translate lyrics",
      description: `Translate saved lyrics line by line with hosted AI and save the result. Lines that already have a translation are kept unless overwrite is true. You can also translate yourself and call save_lyrics_translation instead. ${CREDITS_NOTE} ${WRITE_NOTE}`,
      inputSchema: {
        id: z.string().min(1).describe("lyrics id"),
        targetLanguage: lang,
        overwrite: z.boolean().optional(),
      },
      annotations: WRITE(true),
    },
    wrap(g, async (a: { id: string; targetLanguage: string; overwrite?: boolean }) => {
      const { article, meta, segments } = await library.getLyrics(a.id);
      if (!segments.length) return { id: article.id, updated: 0, aligned: true, credits: 0, lines: [] };
      const res = await library.translateLyricsHosted({
        lines: segments.map((s) => s.text),
        targetLanguage: a.targetLanguage,
        title: article.title,
        ...(meta?.artist ? { artist: meta.artist } : {}),
      });
      const updates = segments.flatMap((s, i) => {
        const t = res.translations[i];
        if (!t || (s.translation && !a.overwrite)) return [];
        return [{ order: s.order, translation: t }];
      });
      const saved = updates.length ? await library.saveLyricsTranslations(article.id, updates) : { updated: 0 };
      return {
        id: article.id,
        title: article.title,
        updated: saved.updated,
        aligned: res.aligned ?? true,
        credits: res.credits ?? 0,
        lines: segments.map((s, i) => ({ order: s.order, text: s.text, translation: (s.translation && !a.overwrite ? s.translation : res.translations[i]) || null })),
      };
    }),
  );

  server.registerTool(
    "create_word_pack_from_text",
    {
      title: "Word pack from text",
      description: `Pick study-worthy words from a passage (lyrics, a chapter, an article…) with hosted AI, create a word pack and add the words to it (existing cards are merged into the pack). ${CREDITS_NOTE} ${WRITE_NOTE}`,
      inputSchema: {
        text: z.string().min(1).max(12_000),
        name: z.string().min(1).max(200).describe("word pack name"),
        targetLanguage: lang.describe("language to write meanings in, e.g. zh"),
        max: z.number().int().min(1).max(50).optional().describe("maximum words (default 15)"),
        level: z.string().max(40).optional().describe('learner level hint, e.g. "JLPT N3", "B1"'),
        sourceArticleId: z.string().optional().describe("article/lyrics/chapter id the text came from"),
      },
      annotations: WRITE(false),
    },
    wrap(g, async (a: { text: string; name: string; targetLanguage: string; max?: number; level?: string; sourceArticleId?: string }) => {
      const extracted = await library.extractVocabHosted({ text: a.text, targetLanguage: a.targetLanguage, max: a.max, level: a.level });
      const { pack } = await library.createPack({ name: a.name, languageTo: a.targetLanguage });
      const words: { id: string; word: string; meaning: string; created: boolean }[] = [];
      for (const item of extracted.items) {
        const res = await library.addVocab({ ...item, pack: pack.id, ...(a.sourceArticleId ? { sourceArticleId: a.sourceArticleId } : {}) });
        words.push({ id: res.vocab.id, word: res.vocab.word, meaning: res.vocab.meaning, created: res.created });
      }
      return {
        pack: { id: pack.id, name: pack.name },
        added: words.filter((w) => w.created).length,
        merged: words.filter((w) => !w.created).length,
        credits: extracted.credits,
        words,
      };
    }),
  );

  return server;
}
