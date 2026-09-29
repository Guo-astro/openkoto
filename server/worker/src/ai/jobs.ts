import { Hono } from "hono";
import { segmentText, translateChapterItems, type ArticleSegment, type BookChapter } from "@openkoto/core";
import type { AppBindings, Env } from "../env";
import { principalOf, requireAuth } from "../auth/middleware";
import { currentPlan } from "../billing/entitlements";
import { ApiError, badRequest, notFound } from "../lib/http";
import { newId } from "../lib/crypto";
import { vaultFor } from "../sync/routes";
import { estimateTokens, metered } from "./service";

interface TranslateBookParams {
  bookId: string;
  targetLanguage: string;
  /** Chapter article ids still to translate, in order. */
  remaining: string[];
  bookTitle?: string;
}

async function updateJob(env: Env, id: string, fields: { status?: string; progress?: number; error?: string | null; params?: TranslateBookParams }) {
  const sets: string[] = ["updated_at = ?"];
  const values: unknown[] = [Date.now()];
  if (fields.status !== undefined) (sets.push("status = ?"), values.push(fields.status));
  if (fields.progress !== undefined) (sets.push("progress = ?"), values.push(fields.progress));
  if (fields.error !== undefined) (sets.push("error = ?"), values.push(fields.error));
  if (fields.params !== undefined) (sets.push("params = ?"), values.push(JSON.stringify(fields.params)));
  await env.DB.prepare(`update jobs set ${sets.join(", ")} where id = ?`).bind(...values, id).run();
}

/**
 * Translates one chapter per queue message, then re-enqueues itself for the next one.
 * Chapters that were never opened are segmented here first (segmentation revision 0).
 */
export async function runTranslateBookStep(env: Env, jobId: string, userId: string): Promise<void> {
  const job = await env.DB.prepare("select status, progress, total, params from jobs where id = ? and user_id = ?")
    .bind(jobId, userId)
    .first<{ status: string; progress: number; total: number; params: string }>();
  if (!job || job.status === "canceled" || job.status === "done" || job.status === "failed") return;
  const params = JSON.parse(job.params) as TranslateBookParams;
  const articleId = params.remaining[0];
  if (!articleId) {
    await updateJob(env, jobId, { status: "done" });
    return;
  }
  await updateJob(env, jobId, { status: "running" });

  const vault = vaultFor(env, userId);
  const plan = await currentPlan(env, userId);
  const article = await vault.get("Article", articleId);
  const chapter = await vault.get("BookChapter", articleId);
  let segments = (await vault.listByField("Segment", "articleId", articleId)).map((r) => ({ id: r.id, payload: r.payload as unknown as ArticleSegment }));

  if (!segments.length && article?.payload) {
    const drafts = segmentText(String(article.payload.content ?? ""));
    const now = new Date().toISOString();
    const created = drafts.map((d, order) => ({
      id: newId(),
      payload: { articleId, order, text: d.text, isNewParagraph: d.isNewParagraph, segmentationRevision: 0, createdAt: now } as unknown as ArticleSegment,
    }));
    await vault.writeAsServer(created.map((s) => ({ type: "Segment" as const, id: s.id, payload: s.payload as never })), plan);
    if (chapter?.payload) {
      await vault.writeAsServer([{ type: "BookChapter", id: articleId, payload: { ...(chapter.payload as unknown as BookChapter), isSegmented: true } as never }], plan);
    }
    segments = created;
  }

  const pending = segments.filter((s) => !s.payload.translation && s.payload.text.trim());
  if (pending.length) {
    const est = estimateTokens(pending.map((s) => s.payload.text).join("\n"));
    try {
      const { result } = await metered(
        env,
        { userId, feature: "translate_book", estimateInput: est + Math.ceil(pending.length / 30) * 400 + pending.length * 8, estimateOutput: est * 3 + pending.length * 15 },
        (chat) =>
          translateChapterItems(
            chat,
            pending.map((s) => ({ id: s.id, text: s.payload.text })),
            { targetLanguage: params.targetLanguage, bookTitle: params.bookTitle, chapterTitle: String(article?.payload?.title ?? "") },
          ),
      );
      await vault.writeAsServer(
        pending
          .filter((s) => result.has(s.id))
          .map((s) => ({ type: "Segment" as const, id: s.id, payload: { ...s.payload, translation: result.get(s.id) } as never })),
        plan,
      );
    } catch (err) {
      const insufficient = err instanceof ApiError && err.code === "INSUFFICIENT_CREDITS";
      await updateJob(env, jobId, { status: insufficient ? "paused" : "failed", error: insufficient ? "INSUFFICIENT_CREDITS" : "AI_ERROR" });
      return;
    }
  }

  const next = { ...params, remaining: params.remaining.slice(1) };
  await updateJob(env, jobId, { progress: job.progress + 1, params: next, status: next.remaining.length ? "running" : "done" });
  if (next.remaining.length) await env.JOBS.send({ kind: "translate_book", jobId, userId });
}

function jobView(row: { id: string; kind: string; status: string; progress: number; total: number; error: string | null; created_at: number; updated_at: number }) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    total: row.total,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export const jobsApi = new Hono<AppBindings>()
  .use(requireAuth("ai:use"))

  .post("/", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as { kind?: string; bookId?: string; targetLanguage?: string; chapters?: string[] };
    if (body.kind !== "translate_book" || !body.bookId || !body.targetLanguage) throw badRequest("kind=translate_book, bookId and targetLanguage are required");
    const vault = vaultFor(c.env, p.userId);
    const book = await vault.get("Book", body.bookId);
    if (!book?.payload) throw notFound("book not found");
    const chapters = (await vault.listByField("BookChapter", "bookId", body.bookId))
      .map((r) => r.payload as unknown as BookChapter)
      .sort((a, b) => a.index - b.index)
      .map((ch) => ch.articleId.toLowerCase());
    const wanted = body.chapters?.length ? chapters.filter((id) => body.chapters!.map((x) => x.toLowerCase()).includes(id)) : chapters;
    if (!wanted.length) throw badRequest("no chapters to translate");
    const id = newId();
    const params: TranslateBookParams = { bookId: body.bookId, targetLanguage: body.targetLanguage, remaining: wanted, bookTitle: String(book.payload.title ?? "") };
    const now = Date.now();
    await c.env.DB.prepare(
      "insert into jobs (id, user_id, kind, status, progress, total, params, created_at, updated_at) values (?, ?, 'translate_book', 'queued', 0, ?, ?, ?, ?)",
    )
      .bind(id, p.userId, wanted.length, JSON.stringify(params), now, now)
      .run();
    await c.env.JOBS.send({ kind: "translate_book", jobId: id, userId: p.userId });
    return c.json({ id, status: "queued", total: wanted.length }, 202);
  })

  .get("/", async (c) => {
    const { results } = await c.env.DB.prepare("select * from jobs where user_id = ? order by created_at desc limit 50")
      .bind(principalOf(c).userId)
      .all<Parameters<typeof jobView>[0]>();
    return c.json({ jobs: results.map(jobView) });
  })

  .get("/:id", async (c) => {
    const row = await c.env.DB.prepare("select * from jobs where id = ? and user_id = ?")
      .bind(c.req.param("id"), principalOf(c).userId)
      .first<Parameters<typeof jobView>[0]>();
    if (!row) throw notFound("job not found");
    return c.json(jobView(row));
  })

  .post("/:id/cancel", async (c) => {
    await c.env.DB.prepare("update jobs set status = 'canceled', updated_at = ? where id = ? and user_id = ? and status in ('queued','running','paused')")
      .bind(Date.now(), c.req.param("id"), principalOf(c).userId)
      .run();
    return c.json({ ok: true });
  })

  .post("/:id/resume", async (c) => {
    const p = principalOf(c);
    const res = await c.env.DB.prepare("update jobs set status = 'queued', error = null, updated_at = ? where id = ? and user_id = ? and status in ('paused','failed')")
      .bind(Date.now(), c.req.param("id"), p.userId)
      .run();
    if (res.meta.changes) await c.env.JOBS.send({ kind: "translate_book", jobId: c.req.param("id"), userId: p.userId });
    return c.json({ ok: true });
  });
