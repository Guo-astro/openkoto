import { Hono } from "hono";
import { PLAN_LIMITS } from "@openkoto/core";
import type { AppBindings, Env } from "../env";
import { principalOf, requireAuth } from "../auth/middleware";
import { currentPlan } from "../billing/entitlements";
import { filesWerePurged } from "../billing/lapsed-cleanup";
import { ApiError, badRequest, notFound } from "../lib/http";

const EXTENSIONS = new Set(["epub", "txt"]);
const CONTENT_TYPES: Record<string, string> = { epub: "application/epub+zip", txt: "text/plain; charset=utf-8" };

function bookPrefix(userId: string, bookId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(bookId)) throw badRequest("invalid book id");
  return `books/${userId}/${bookId.toLowerCase()}/`;
}

export async function storedBookBytes(env: Env, userId: string, exceptPrefix?: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `books/${userId}/`, cursor, limit: 1000 });
    for (const obj of page.objects) if (!exceptPrefix || !obj.key.startsWith(exceptPrefix)) total += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

/** Original book files (EPUB/TXT). Chapter text itself syncs as records; files are for re-parsing and download. */
export const booksApi = new Hono<AppBindings>()
  .use(requireAuth("library:write"))

  .put("/:bookId/file", async (c) => {
    const p = principalOf(c);
    const prefix = bookPrefix(p.userId, c.req.param("bookId"));
    const ext = (c.req.query("ext") ?? "").toLowerCase();
    const sha = (c.req.query("sha256") ?? "").toLowerCase();
    if (!EXTENSIONS.has(ext)) throw badRequest("ext must be epub or txt");
    if (!/^[0-9a-f]{64}$/.test(sha)) throw badRequest("sha256 is required");
    const size = Number(c.req.header("Content-Length") ?? NaN);
    if (!Number.isFinite(size) || size <= 0) throw badRequest("Content-Length is required");

    const limits = PLAN_LIMITS[await currentPlan(c.env, p.userId)];
    if (size > limits.bookFileBytes) throw new ApiError(402, "QUOTA_EXCEEDED", "book file too large for your plan");
    if ((await storedBookBytes(c.env, p.userId, prefix)) + size > limits.fileBytesTotal) {
      throw new ApiError(402, "QUOTA_EXCEEDED", "storage quota exceeded");
    }

    // One file per book: write the new version first, then drop older ones, so a failed
    // upload never loses the existing file. R2 verifies the body against sha256.
    const key = `${prefix}${sha}.${ext}`;
    await c.env.BUCKET.put(key, c.req.raw.body, { httpMetadata: { contentType: CONTENT_TYPES[ext] }, sha256: sha });
    const old = await c.env.BUCKET.list({ prefix });
    const stale = old.objects.map((o) => o.key).filter((k) => k !== key);
    if (stale.length) await c.env.BUCKET.delete(stale);
    return c.json({ ok: true, key: `${sha}.${ext}`, size });
  })

  .get("/:bookId/file", async (c) => {
    const p = principalOf(c);
    const list = await c.env.BUCKET.list({ prefix: bookPrefix(p.userId, c.req.param("bookId")), limit: 1 });
    const key = list.objects[0]?.key;
    const obj = key ? await c.env.BUCKET.get(key) : null;
    if (!obj) {
      if (await filesWerePurged(c.env, p.userId)) throw new ApiError(410, "FILE_EXPIRED", "this book's cloud file was removed after the membership ended; re-upload it from a device that has it");
      throw notFound("book file not found");
    }
    const headers = new Headers({ "Cache-Control": "private, max-age=3600" });
    obj.writeHttpMetadata(headers);
    return new Response(obj.body, { headers });
  })

  .delete("/:bookId/file", async (c) => {
    const p = principalOf(c);
    const list = await c.env.BUCKET.list({ prefix: bookPrefix(p.userId, c.req.param("bookId")) });
    if (list.objects.length) await c.env.BUCKET.delete(list.objects.map((o) => o.key));
    return c.json({ ok: true });
  });
