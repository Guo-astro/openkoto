// High-level library REST API used by the koto CLI, the MCP server and agents
// (design doc §10). Everything is stored as ordinary sync records in the user's
// UserVault, written with a server HLC so every client picks the changes up on pull.

import { Hono, type Context } from "hono";
import {
  isGrade,
  isValidLocalDate,
  localDateString,
  membershipId,
  parseLyrics,
  reviewCard,
  dueQueue,
  segmentText,
  type Article,
  type ArticleSegment,
  type FavoriteVocabulary,
  type JsonObject,
  type LyricsMeta,
  type LyricsSourceFormat,
  type Plan,
  type PushResult,
  type RecordType,
  type ReviewEvent,
  type WordPack,
} from "@openkoto/core";
import type { AppBindings } from "../env";
import { principalOf, requireAuth } from "../auth/middleware";
import { currentPlan } from "../billing/entitlements";
import { ApiError, badRequest, notFound } from "../lib/http";
import { vaultFor, type VaultApi } from "../sync/routes";
import type { ServerWrite, VaultRecord } from "../sync/vault";

type Ctx = Context<AppBindings>;

const PAGE = 1000;
const MAX_SCAN = 20_000;
const WRITE_BATCH = 400;
const MAX_TEXT = 400_000;

// ---- helpers ------------------------------------------------------------

export function isoNow(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Dedupe key (vocabulary-srs-spec §1.4): NFKC + trim + lowercase. */
export function normalizeWord(word: string): string {
  return word.normalize("NFKC").trim().toLowerCase();
}

function vault(c: Ctx): VaultApi {
  return vaultFor(c.env, principalOf(c).userId);
}

async function plan(c: Ctx): Promise<Plan> {
  return currentPlan(c.env, principalOf(c).userId);
}

async function body<T>(c: Ctx): Promise<T> {
  try {
    const value = (await c.req.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw badRequest("invalid JSON body");
  }
}

function str(value: unknown, field: string, { required = false, max = 10_000 } = {}): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw badRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  if (value.length > max) throw badRequest(`${field} is too long`);
  if (required && !value.trim()) throw badRequest(`${field} is required`);
  return value;
}

function intQuery(c: Ctx, name: string, fallback: number, max: number): number {
  const raw = c.req.query(name);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${name} must be a non-negative number`);
  return Math.min(Math.floor(n), max);
}

function timeZoneOf(c: Ctx, explicit?: unknown): string | undefined {
  const tz = (typeof explicit === "string" && explicit) || c.req.query("tz") || c.req.header("X-Timezone");
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw badRequest("invalid time zone");
  }
}

/** Writes and maps op rejections to HTTP errors (quota → 402). */
async function write(c: Ctx, writes: ServerWrite[], userPlan?: Plan): Promise<PushResult[]> {
  if (!writes.length) return [];
  const p = userPlan ?? (await plan(c));
  const results: PushResult[] = [];
  for (let i = 0; i < writes.length; i += WRITE_BATCH) {
    results.push(...(await vault(c).writeAsServer(writes.slice(i, i + WRITE_BATCH), p)));
  }
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected && rejected.status === "rejected") {
    if (rejected.code === "QUOTA_EXCEEDED") {
      throw new ApiError(402, "QUOTA_EXCEEDED", rejected.message ?? "plan quota exceeded — upgrade to OpenKoto Plus");
    }
    if (rejected.code === "PAYLOAD_TOO_LARGE") throw new ApiError(413, "PAYLOAD_TOO_LARGE", "content too large");
    throw badRequest(rejected.message ?? rejected.code, rejected.code);
  }
  return results;
}

async function listAll(v: VaultApi, type: RecordType, cls?: string): Promise<VaultRecord[]> {
  const out: VaultRecord[] = [];
  for (let offset = 0; offset < MAX_SCAN; offset += PAGE) {
    const page = await v.list(type, { limit: PAGE, offset, ...(cls ? { cls } : {}) });
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

function payloadOf<T>(record: VaultRecord | null): T | null {
  return record && !record.deleted && record.payload ? (record.payload as unknown as T) : null;
}

async function membershipsByVocab(v: VaultApi): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const r of await listAll(v, "WordPackMembership")) {
    const m = r.payload as { vocabularyId?: string; packId?: string } | null;
    if (!m?.vocabularyId || !m.packId) continue;
    const key = m.vocabularyId.toLowerCase();
    const list = map.get(key) ?? [];
    list.push(m.packId.toLowerCase());
    map.set(key, list);
  }
  return map;
}

function withPacks(vocab: FavoriteVocabulary, packs: Map<string, string[]>): FavoriteVocabulary {
  return { ...vocab, packIds: packs.get(vocab.id.toLowerCase()) ?? vocab.packIds ?? [] };
}

async function requireVocab(c: Ctx, id: string): Promise<FavoriteVocabulary> {
  const vocab = payloadOf<FavoriteVocabulary>(await vault(c).get("Vocabulary", id));
  if (!vocab) throw notFound("vocabulary not found");
  return { ...vocab, id: vocab.id ?? id };
}

async function findPack(v: VaultApi, ref: string): Promise<WordPack | null> {
  const byId = payloadOf<WordPack>(await v.get("WordPack", ref));
  if (byId) return byId;
  const needle = ref.trim().toLowerCase();
  const all = await listAll(v, "WordPack");
  return (all.map((r) => r.payload as unknown as WordPack).find((p) => p?.name?.trim().toLowerCase() === needle) ?? null);
}

function newPack(name: string, extra: Partial<WordPack> = {}): WordPack {
  const now = isoNow();
  return { tags: [], isSystem: false, ...extra, id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
}

/** Resolve pack references (id or name), creating missing named packs. */
async function resolvePacks(c: Ctx, refs: string[], userPlan: Plan): Promise<string[]> {
  const ids: string[] = [];
  const created: ServerWrite[] = [];
  for (const ref of refs.map((r) => r.trim()).filter(Boolean)) {
    const pack = await findPack(vault(c), ref);
    if (pack) {
      ids.push(pack.id.toLowerCase());
    } else {
      const p = newPack(ref);
      created.push({ type: "WordPack", id: p.id, payload: p as unknown as JsonObject });
      ids.push(p.id);
    }
  }
  await write(c, created, userPlan);
  return [...new Set(ids)];
}

function membershipWrites(vocabularyId: string, packIds: string[]): ServerWrite[] {
  const createdAt = isoNow();
  return packIds.map((packId) => ({
    type: "WordPackMembership" as const,
    id: membershipId(vocabularyId, packId),
    payload: { vocabularyId: vocabularyId.toLowerCase(), packId: packId.toLowerCase(), createdAt },
  }));
}

function stripContent(article: Article, extra: Record<string, unknown> = {}) {
  const { content, ...rest } = article;
  return { ...rest, preview: (content ?? "").slice(0, 160), length: (content ?? "").length, ...extra };
}

async function segmentsOf(v: VaultApi, articleId: string): Promise<ArticleSegment[]> {
  return (await v.listByField("Segment", "articleId", articleId))
    .map((r) => r.payload as unknown as ArticleSegment)
    .sort((a, b) => a.order - b.order);
}

async function chapterArticleIds(v: VaultApi): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const r of await listAll(v, "BookChapter")) {
    const id = (r.payload as { articleId?: string } | null)?.articleId ?? r.id;
    ids.add(id.toLowerCase());
  }
  return ids;
}

function segmentWrites(articleId: string, drafts: { text: string; isNewParagraph: boolean; startTime?: number | null; endTime?: number | null; translation?: string | null }[]): ServerWrite[] {
  const createdAt = isoNow();
  return drafts.map((d, order) => {
    const seg: ArticleSegment = { id: crypto.randomUUID(), articleId, order, text: d.text, isNewParagraph: d.isNewParagraph, createdAt };
    if (d.startTime !== undefined && d.startTime !== null) seg.startTime = d.startTime;
    if (d.endTime !== undefined && d.endTime !== null) seg.endTime = d.endTime;
    if (d.translation) seg.translation = d.translation;
    return { type: "Segment" as const, id: seg.id, payload: seg as unknown as JsonObject };
  });
}

/** Creates an Article first (so a quota rejection leaves no orphans), then the rest. */
async function createArticle(c: Ctx, article: Article, rest: ServerWrite[]): Promise<void> {
  const userPlan = await plan(c);
  await write(c, [{ type: "Article", id: article.id, payload: article as unknown as JsonObject }], userPlan);
  await write(c, rest, userPlan);
}

const VOCAB_TEXT_FIELDS = ["meaning", "usage", "explanation", "example", "reading", "sourceArticleId", "sourceArticleTitle", "sourceSegmentId"] as const;
type VocabInput = Partial<Record<(typeof VOCAB_TEXT_FIELDS)[number] | "word", unknown>> & { pack?: unknown; packs?: unknown; packIds?: unknown };

function packRefs(input: VocabInput): string[] {
  const refs: string[] = [];
  for (const v of [input.pack, input.packs, input.packIds]) {
    if (typeof v === "string") refs.push(v);
    else if (Array.isArray(v)) refs.push(...v.filter((x): x is string => typeof x === "string"));
  }
  return refs;
}

// ---- routes -------------------------------------------------------------

const LYRICS_FORMATS = new Set<LyricsSourceFormat>(["lrc", "txt", "srt"]);

export const libraryApi = new Hono<AppBindings>()
  // ---- vocabulary ----
  .get("/vocab", requireAuth("vocab:read"), async (c) => {
    const v = vault(c);
    const limit = intQuery(c, "limit", 100, 1000);
    const packRef = c.req.query("pack");
    const q = c.req.query("q");
    const packs = await membershipsByVocab(v);
    let cards = (await listAll(v, "Vocabulary")).map((r) => withPacks({ ...(r.payload as unknown as FavoriteVocabulary), id: (r.payload?.id as string) ?? r.id }, packs));
    let packId: string | null = null;
    if (packRef) {
      const pack = await findPack(v, packRef);
      if (!pack) throw notFound("word pack not found");
      packId = pack.id.toLowerCase();
    }
    if (q) {
      const needle = normalizeWord(q);
      cards = cards.filter((x) => normalizeWord(x.word ?? "").includes(needle) || (x.meaning ?? "").toLowerCase().includes(needle));
    }
    const due = c.req.query("due");
    if (due === "1" || due === "true") {
      const date = c.req.query("date");
      if (date && !isValidLocalDate(date)) throw badRequest("date must be YYYY-MM-DD");
      const today = date ?? localDateString(new Date(), timeZoneOf(c));
      const queue = dueQueue(cards, today, {
        packId,
        newLimit: intQuery(c, "newLimit", 20, 1000),
        reviewLimit: intQuery(c, "reviewLimit", 100, 1000),
      });
      return c.json({ items: queue.slice(0, limit), total: queue.length, date: today });
    }
    if (packId) cards = cards.filter((x) => x.packIds?.includes(packId!));
    cards.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const offset = intQuery(c, "offset", 0, MAX_SCAN);
    return c.json({ items: cards.slice(offset, offset + limit), total: cards.length });
  })

  .get("/vocab/:id", requireAuth("vocab:read"), async (c) => {
    const vocab = await requireVocab(c, c.req.param("id"));
    return c.json({ vocab: withPacks(vocab, await membershipsByVocab(vault(c))) });
  })

  .post("/vocab", requireAuth("vocab:write"), async (c) => {
    const input = await body<VocabInput & { tz?: unknown }>(c);
    const word = str(input.word, "word", { required: true, max: 500 })!.trim();
    const fields: Partial<FavoriteVocabulary> = {};
    for (const f of VOCAB_TEXT_FIELDS) {
      const value = str(input[f], f);
      if (value !== undefined) (fields as Record<string, string>)[f] = value;
    }
    const userPlan = await plan(c);
    const v = vault(c);
    const key = normalizeWord(word);
    const existing = (await listAll(v, "Vocabulary"))
      .map((r) => ({ ...(r.payload as unknown as FavoriteVocabulary), id: (r.payload?.id as string) ?? r.id }))
      .find((x) => normalizeWord(x.word ?? "") === key);
    const packIds = await resolvePacks(c, packRefs(input), userPlan);

    if (existing) {
      // Desktop semantics: merge packs, backfill empty fields.
      const merged: FavoriteVocabulary = { ...existing };
      let changed = false;
      for (const [f, value] of Object.entries(fields)) {
        const current = (merged as unknown as Record<string, unknown>)[f];
        if (current === undefined || current === null || current === "") {
          (merged as unknown as Record<string, unknown>)[f] = value;
          changed = true;
        }
      }
      const writes = membershipWrites(existing.id, packIds);
      if (changed) {
        merged.updatedAt = isoNow();
        writes.unshift({ type: "Vocabulary", id: existing.id, payload: merged as unknown as JsonObject });
      }
      await write(c, writes, userPlan);
      return c.json({ vocab: withPacks(merged, await membershipsByVocab(v)), created: false, deduped: true });
    }

    const now = isoNow();
    const vocab: FavoriteVocabulary = {
      id: crypto.randomUUID(),
      word,
      meaning: fields.meaning ?? "",
      ...fields,
      srsState: "new",
      stability: 0,
      difficulty: 0,
      schedulerVersion: "fsrs6",
      dueDate: localDateString(new Date(), timeZoneOf(c, input.tz)),
      reviewCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await write(c, [{ type: "Vocabulary", id: vocab.id, payload: vocab as unknown as JsonObject }], userPlan);
    await write(c, membershipWrites(vocab.id, packIds), userPlan);
    return c.json({ vocab: { ...vocab, packIds }, created: true, deduped: false }, 201);
  })

  .patch("/vocab/:id", requireAuth("vocab:write"), async (c) => {
    const vocab = await requireVocab(c, c.req.param("id"));
    const input = await body<Record<string, unknown>>(c);
    const next: FavoriteVocabulary = { ...vocab };
    const rec = next as unknown as Record<string, unknown>;
    if (input.word !== undefined) next.word = str(input.word, "word", { required: true, max: 500 })!.trim();
    for (const f of VOCAB_TEXT_FIELDS) {
      if (f in input) rec[f] = input[f] === null ? null : (str(input[f], f) ?? "");
    }
    if ("suspended" in input) next.suspendedAt = input.suspended ? (vocab.suspendedAt ?? isoNow()) : null;
    if ("suspendedAt" in input) next.suspendedAt = input.suspendedAt === null ? null : str(input.suspendedAt, "suspendedAt") ?? null;
    next.updatedAt = isoNow();
    const userPlan = await plan(c);
    await write(c, [{ type: "Vocabulary", id: vocab.id, payload: next as unknown as JsonObject }], userPlan);
    const refs = packRefs(input as VocabInput);
    if (refs.length) await write(c, membershipWrites(vocab.id, await resolvePacks(c, refs, userPlan)), userPlan);
    return c.json({ vocab: withPacks(next, await membershipsByVocab(vault(c))) });
  })

  .delete("/vocab/:id", requireAuth("vocab:write"), async (c) => {
    const vocab = await requireVocab(c, c.req.param("id"));
    const members = await vault(c).listByField("WordPackMembership", "vocabularyId", vocab.id);
    await write(c, [
      { type: "Vocabulary", id: vocab.id, deleted: true },
      ...members.map((m) => ({ type: "WordPackMembership" as const, id: m.id, deleted: true })),
    ]);
    return c.json({ ok: true, id: vocab.id.toLowerCase() });
  })

  .post("/vocab/:id/review", requireAuth("vocab:write"), async (c) => {
    const vocab = await requireVocab(c, c.req.param("id"));
    const input = await body<{ grade?: unknown; tz?: unknown; desiredRetention?: unknown }>(c);
    const grade = typeof input.grade === "string" ? Number(input.grade) : input.grade;
    if (!isGrade(grade)) throw badRequest("grade must be 1 (again), 2 (hard), 3 (good) or 4 (easy)");
    const retention = typeof input.desiredRetention === "number" ? input.desiredRetention : undefined;
    if (retention !== undefined && !(retention >= 0.7 && retention <= 0.97)) throw badRequest("desiredRetention must be within [0.70, 0.97]");
    const { card, event } = reviewCard(vocab, grade, new Date(), { timeZone: timeZoneOf(c, input.tz), desiredRetention: retention });
    const reviewed: FavoriteVocabulary = { ...card, updatedAt: isoNow() };
    const ev: ReviewEvent = { id: crypto.randomUUID(), ...event, vocabularyId: vocab.id.toLowerCase() };
    await write(c, [
      { type: "Vocabulary", id: vocab.id, payload: reviewed as unknown as JsonObject },
      { type: "ReviewEvent", id: ev.id, payload: ev as unknown as JsonObject },
    ]);
    return c.json({ vocab: reviewed, event: ev });
  })

  // ---- word packs ----
  .get("/packs", requireAuth("vocab:read"), async (c) => {
    const v = vault(c);
    const counts = new Map<string, number>();
    for (const packIds of (await membershipsByVocab(v)).values()) for (const id of packIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const packs = (await listAll(v, "WordPack")).map((r) => {
      const p = r.payload as unknown as WordPack;
      return { ...p, id: p.id ?? r.id, vocabCount: counts.get((p.id ?? r.id).toLowerCase()) ?? 0 };
    });
    return c.json({ items: packs, total: packs.length });
  })

  .post("/packs", requireAuth("vocab:write"), async (c) => {
    const input = await body<Record<string, unknown>>(c);
    const name = str(input.name, "name", { required: true, max: 200 })!.trim();
    const existing = await findPack(vault(c), name);
    if (existing && existing.name.trim().toLowerCase() === name.toLowerCase()) return c.json({ pack: existing, created: false });
    const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : [];
    const pack = newPack(name, {
      tags,
      packDescription: str(input.description ?? input.packDescription, "description") ?? null,
      languageFrom: str(input.languageFrom, "languageFrom") ?? null,
      languageTo: str(input.languageTo, "languageTo") ?? null,
    });
    await write(c, [{ type: "WordPack", id: pack.id, payload: pack as unknown as JsonObject }]);
    return c.json({ pack, created: true }, 201);
  })

  .post("/packs/:id/members", requireAuth("vocab:write"), async (c) => {
    const pack = await findPack(vault(c), c.req.param("id"));
    if (!pack) throw notFound("word pack not found");
    const input = await body<{ vocabularyIds?: unknown }>(c);
    if (!Array.isArray(input.vocabularyIds) || !input.vocabularyIds.every((x) => typeof x === "string")) {
      throw badRequest("vocabularyIds must be an array of ids");
    }
    const ids = input.vocabularyIds as string[];
    for (const id of ids) await requireVocab(c, id);
    await write(c, ids.flatMap((id) => membershipWrites(id, [pack.id])));
    return c.json({ ok: true, packId: pack.id.toLowerCase(), added: ids.length });
  })

  // ---- lyrics ----
  .get("/lyrics", requireAuth("library:read"), async (c) => {
    const v = vault(c);
    const metas = new Map<string, LyricsMeta>();
    for (const r of await listAll(v, "LyricsMeta")) metas.set(r.id.toLowerCase(), r.payload as unknown as LyricsMeta);
    const limit = intQuery(c, "limit", 100, 1000);
    const offset = intQuery(c, "offset", 0, MAX_SCAN);
    const all = await listAll(v, "Article", "lyrics");
    const items = all.slice(offset, offset + limit).map((r) => {
      const a = { ...(r.payload as unknown as Article), id: (r.payload?.id as string) ?? r.id };
      const meta = metas.get(r.id.toLowerCase());
      return stripContent(a, { artist: meta?.artist ?? null, language: meta?.language ?? null });
    });
    return c.json({ items, total: all.length });
  })

  .get("/lyrics/:id", requireAuth("library:read"), async (c) => {
    const v = vault(c);
    const article = payloadOf<Article>(await v.get("Article", c.req.param("id")));
    if (!article || article.sourceType !== "lyrics") throw notFound("lyrics not found");
    const [segments, meta] = await Promise.all([segmentsOf(v, article.id), v.get("LyricsMeta", article.id)]);
    return c.json({ article, segments, meta: payloadOf<LyricsMeta>(meta) });
  })

  .post("/lyrics", requireAuth("library:write"), async (c) => {
    const input = await body<Record<string, unknown>>(c);
    const raw = str(input.raw, "raw", { required: true, max: MAX_TEXT })!;
    const format = str(input.format, "format") as LyricsSourceFormat | undefined;
    if (format && !LYRICS_FORMATS.has(format)) throw badRequest("format must be lrc, txt or srt");
    const parsed = parseLyrics(raw, format);
    if (!parsed.lines.length) throw badRequest("no lyric lines found");
    const title = (str(input.title, "title", { max: 500 }) ?? parsed.meta.title ?? "").trim();
    if (!title) throw badRequest("title is required");
    const translations = Array.isArray(input.translations) ? input.translations : [];

    const article: Article = {
      id: crypto.randomUUID(),
      title,
      content: parsed.lines.map((l) => l.text).join("\n"),
      sourceType: "lyrics",
      createdAt: isoNow(),
    };
    const meta: LyricsMeta = { articleId: article.id, sourceFormat: parsed.format };
    const artist = str(input.artist, "artist", { max: 500 }) ?? parsed.meta.artist;
    const album = str(input.album, "album", { max: 500 }) ?? parsed.meta.album;
    const language = str(input.language, "language", { max: 20 });
    if (artist) meta.artist = artist;
    if (album) meta.album = album;
    if (language) meta.language = language;
    if (parsed.meta.offsetMs) meta.lrcOffsetMs = parsed.meta.offsetMs;

    const segments = segmentWrites(
      article.id,
      parsed.lines.map((l, i) => ({
        text: l.text,
        isNewParagraph: true,
        startTime: l.startTime,
        endTime: l.endTime,
        translation: typeof translations[i] === "string" ? (translations[i] as string) : null,
      })),
    );
    await createArticle(c, article, [{ type: "LyricsMeta", id: article.id, payload: meta as unknown as JsonObject }, ...segments]);
    return c.json({ article, meta, segments: segments.map((s) => s.payload) }, 201);
  })

  .put("/lyrics/:id/translations", requireAuth("library:write"), async (c) => {
    const v = vault(c);
    const article = payloadOf<Article>(await v.get("Article", c.req.param("id")));
    if (!article || article.sourceType !== "lyrics") throw notFound("lyrics not found");
    const input = await body<{ translations?: unknown }>(c);
    if (!Array.isArray(input.translations)) throw badRequest("translations must be an array of {order, translation}");
    const byOrder = new Map<number, string>();
    input.translations.forEach((t, i) => {
      if (typeof t === "string") return byOrder.set(i, t);
      const o = t as { order?: unknown; translation?: unknown } | null;
      if (!o || typeof o.order !== "number" || typeof o.translation !== "string") throw badRequest("each translation needs order and translation");
      byOrder.set(o.order, o.translation);
    });
    const segments = await segmentsOf(v, article.id);
    const writes: ServerWrite[] = [];
    for (const seg of segments) {
      const translation = byOrder.get(seg.order);
      if (translation === undefined || translation === seg.translation) continue;
      writes.push({ type: "Segment", id: seg.id, payload: { ...seg, translation } as unknown as JsonObject });
    }
    await write(c, writes);
    return c.json({ ok: true, updated: writes.length, total: segments.length });
  })

  // ---- articles ----
  .get("/articles", requireAuth("library:read"), async (c) => {
    const v = vault(c);
    const chapters = await chapterArticleIds(v);
    const limit = intQuery(c, "limit", 100, 1000);
    const offset = intQuery(c, "offset", 0, MAX_SCAN);
    const all = (await listAll(v, "Article", "article")).filter((r) => !chapters.has(r.id.toLowerCase()));
    const items = all.slice(offset, offset + limit).map((r) => stripContent({ ...(r.payload as unknown as Article), id: (r.payload?.id as string) ?? r.id }));
    return c.json({ items, total: all.length });
  })

  .get("/articles/:id", requireAuth("library:read"), async (c) => {
    const v = vault(c);
    const article = payloadOf<Article>(await v.get("Article", c.req.param("id")));
    if (!article) throw notFound("article not found");
    return c.json({ article, segments: await segmentsOf(v, article.id) });
  })

  .post("/articles", requireAuth("library:write"), async (c) => {
    const input = await body<Record<string, unknown>>(c);
    const title = str(input.title, "title", { required: true, max: 500 })!.trim();
    const content = str(input.content, "content", { required: true, max: MAX_TEXT })!;
    const sourceURL = str(input.sourceURL ?? input.url, "sourceURL", { max: 2000 });
    const drafts = segmentText(content);
    if (!drafts.length) throw badRequest("content has no text");
    const article: Article = { id: crypto.randomUUID(), title, content, sourceType: sourceURL ? "web" : "article", createdAt: isoNow() };
    if (sourceURL) article.sourceURL = sourceURL;
    const segments = segmentWrites(article.id, drafts);
    await createArticle(c, article, segments);
    return c.json({ article, segments: segments.map((s) => s.payload) }, 201);
  })

  // ---- books ----
  .get("/books", requireAuth("library:read"), async (c) => {
    const books = (await listAll(vault(c), "Book")).map((r) => ({ ...(r.payload as JsonObject), id: (r.payload?.id as string) ?? r.id }));
    return c.json({ items: books, total: books.length });
  })

  .get("/books/:id/chapters", requireAuth("library:read"), async (c) => {
    const v = vault(c);
    const book = payloadOf<JsonObject>(await v.get("Book", c.req.param("id")));
    if (!book) throw notFound("book not found");
    const chapters = (await v.listByField("BookChapter", "bookId", c.req.param("id")))
      .map((r) => r.payload as unknown as { articleId: string; index: number })
      .sort((a, b) => a.index - b.index);
    const titles = await Promise.all(chapters.map(async (ch) => payloadOf<Article>(await v.get("Article", ch.articleId))?.title ?? null));
    return c.json({ book, items: chapters.map((ch, i) => ({ ...ch, title: titles[i] })), total: chapters.length });
  })

  // ---- search ----
  .get("/search", requireAuth("library:read"), async (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const kinds = new Set((c.req.query("types") ?? "book,article,lyrics,vocab").split(",").map((s) => s.trim()));
    const limit = intQuery(c, "limit", 20, 200);
    const v = vault(c);
    const hits: { kind: string; id: string; title: string; subtitle?: string | null }[] = [];
    const match = (...texts: (string | null | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q));
    if (kinds.has("book")) {
      for (const r of await listAll(v, "Book")) {
        const b = r.payload as { title?: string; author?: string | null };
        if (match(b.title, b.author)) hits.push({ kind: "book", id: r.id, title: b.title ?? "", subtitle: b.author ?? null });
      }
    }
    if (kinds.has("lyrics")) {
      const metas = new Map((await listAll(v, "LyricsMeta")).map((r) => [r.id.toLowerCase(), r.payload as unknown as LyricsMeta]));
      for (const r of await listAll(v, "Article", "lyrics")) {
        const a = r.payload as unknown as Article;
        const artist = metas.get(r.id.toLowerCase())?.artist ?? null;
        if (match(a.title, artist, a.content)) hits.push({ kind: "lyrics", id: r.id, title: a.title, subtitle: artist });
      }
    }
    if (kinds.has("article")) {
      const chapters = await chapterArticleIds(v);
      for (const r of await listAll(v, "Article", "article")) {
        if (chapters.has(r.id.toLowerCase())) continue;
        const a = r.payload as unknown as Article;
        if (match(a.title, a.content)) hits.push({ kind: "article", id: r.id, title: a.title, subtitle: a.sourceURL ?? null });
      }
    }
    if (kinds.has("vocab") && principalOf(c).scopes.includes("vocab:read")) {
      for (const r of await listAll(v, "Vocabulary")) {
        const x = r.payload as unknown as FavoriteVocabulary;
        if (match(x.word, x.meaning, x.reading)) hits.push({ kind: "vocab", id: r.id, title: x.word, subtitle: x.meaning });
      }
    }
    return c.json({ items: hits.slice(0, limit), total: hits.length });
  });
