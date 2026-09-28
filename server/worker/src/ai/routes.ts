import { Hono } from "hono";
import {
  explainSentence,
  extractVocabulary,
  glossWord,
  PROMPT_VERSION,
  translateChapterItems,
  translateLyricsLines,
  translateText,
} from "@openkoto/core";
import type { AppBindings } from "../env";
import { principalOf, requireAuth } from "../auth/middleware";
import { badRequest } from "../lib/http";
import { cached, cacheKey, estimateTokens, metered, store } from "./service";

const MAX_TEXT = 4000;
const MAX_LYRIC_LINES = 400;
const MAX_CHAPTER_ITEMS = 300;

function str(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required`);
  if (value.length > max) throw badRequest(`${field} is too long`);
  return value;
}

function lang(value: unknown): string {
  const v = typeof value === "string" && /^[A-Za-z-]{2,12}$/.test(value) ? value : null;
  if (!v) throw badRequest("targetLanguage is required");
  return v;
}

export const aiApi = new Hono<AppBindings>()
  .use(requireAuth("ai:use"))

  .post("/translate", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as Record<string, unknown>;
    const text = str(body.text, "text");
    const target = lang(body.targetLanguage);
    const key = await cacheKey([PROMPT_VERSION.translate, c.env.AI_MODEL, target, text]);
    const hit = await cached<{ translation: string }>(key);
    if (hit) return c.json({ ...hit, credits: 0, cached: true });
    const est = estimateTokens(text);
    const { result, credits } = await metered(c.env, { userId: p.userId, feature: "translate", keyId: p.keyId, estimateInput: est + 200, estimateOutput: est * 2 + 50 }, (chat) =>
      translateText(chat, text, target),
    );
    await store(key, { translation: result });
    return c.json({ translation: result, credits, cached: false });
  })

  .post("/explain", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as Record<string, unknown>;
    const text = str(body.text, "text", 1000);
    const target = lang(body.targetLanguage);
    const key = await cacheKey([PROMPT_VERSION.explain, c.env.AI_MODEL, target, text]);
    const hit = await cached<{ explanation: unknown }>(key);
    if (hit) return c.json({ ...hit, credits: 0, cached: true });
    const est = estimateTokens(text);
    const { result, credits } = await metered(c.env, { userId: p.userId, feature: "explain", keyId: p.keyId, estimateInput: est + 900, estimateOutput: 1200 }, (chat) =>
      explainSentence(chat, text, target),
    );
    await store(key, { explanation: result });
    return c.json({ explanation: result, credits, cached: false });
  })

  .post("/gloss", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as Record<string, unknown>;
    const word = str(body.word, "word", 100);
    const sentence = typeof body.sentence === "string" ? body.sentence.slice(0, 1000) : "";
    const target = lang(body.targetLanguage);
    const { result, credits } = await metered(
      c.env,
      { userId: p.userId, feature: "gloss", keyId: p.keyId, estimateInput: estimateTokens(sentence) + 400, estimateOutput: 400 },
      (chat) => glossWord(chat, word, sentence, target),
    );
    return c.json({ gloss: result, credits });
  })

  .post("/translate-lyrics", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as { lines?: unknown; targetLanguage?: unknown; title?: string; artist?: string };
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > MAX_LYRIC_LINES) throw badRequest("lines must be a non-empty array");
    const lines = body.lines.map((l) => String(l).slice(0, 500));
    const target = lang(body.targetLanguage);
    const key = await cacheKey([PROMPT_VERSION.translateLyrics, c.env.AI_MODEL, target, body.title ?? "", body.artist ?? "", lines]);
    const hit = await cached<{ translations: string[]; aligned: boolean }>(key);
    if (hit) return c.json({ ...hit, credits: 0, cached: true });
    const est = estimateTokens(lines.join("\n"));
    const { result, credits } = await metered(
      c.env,
      { userId: p.userId, feature: "translate_lyrics", keyId: p.keyId, estimateInput: (est + 400) * 2, estimateOutput: est * 4 + lines.length * 12 },
      (chat) => translateLyricsLines(chat, { lines, targetLanguage: target, title: body.title?.slice(0, 200), artist: body.artist?.slice(0, 200) }),
    );
    if (result.aligned) await store(key, result);
    return c.json({ ...result, credits, cached: false });
  })

  .post("/extract-vocab", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as { text?: unknown; targetLanguage?: unknown; max?: unknown; level?: unknown };
    const text = str(body.text, "text", 12_000);
    const target = lang(body.targetLanguage);
    const max = typeof body.max === "number" && Number.isFinite(body.max) ? Math.max(1, Math.min(Math.floor(body.max), 50)) : 15;
    const level = typeof body.level === "string" ? body.level.slice(0, 40) : undefined;
    const key = await cacheKey([PROMPT_VERSION.extractVocab, c.env.AI_MODEL, target, max, level ?? "", text]);
    const hit = await cached<{ items: unknown[] }>(key);
    if (hit) return c.json({ ...hit, credits: 0, cached: true });
    const est = estimateTokens(text);
    const { result, credits } = await metered(
      c.env,
      { userId: p.userId, feature: "extract_vocab", keyId: p.keyId, estimateInput: est + 400, estimateOutput: max * 80 },
      (chat) => extractVocabulary(chat, { text, targetLanguage: target, max, level }),
    );
    await store(key, { items: result });
    return c.json({ items: result, credits, cached: false });
  })

  .post("/translate-chapter", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as { items?: unknown; targetLanguage?: unknown; bookTitle?: string; chapterTitle?: string };
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_CHAPTER_ITEMS) throw badRequest(`items must hold 1–${MAX_CHAPTER_ITEMS} entries`);
    const items = body.items.map((i) => {
      const item = i as { id?: unknown; text?: unknown };
      return { id: String(item.id ?? "").slice(0, 64), text: String(item.text ?? "").slice(0, 2000) };
    });
    const target = lang(body.targetLanguage);
    const est = estimateTokens(items.map((i) => i.text).join("\n"));
    const { result, credits } = await metered(
      c.env,
      { userId: p.userId, feature: "translate_chapter", keyId: p.keyId, estimateInput: est + Math.ceil(items.length / 30) * 400 + items.length * 8, estimateOutput: est * 3 + items.length * 15 },
      (chat) => translateChapterItems(chat, items, { targetLanguage: target, bookTitle: body.bookTitle?.slice(0, 200), chapterTitle: body.chapterTitle?.slice(0, 200) }),
    );
    return c.json({ translations: Object.fromEntries(result), credits });
  });
