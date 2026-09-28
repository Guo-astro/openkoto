import { describe, expect, it } from "vitest";
import { api, json, nativeLogin } from "./helpers";

const V = "/api/v1/library";

function post(token: string, path: string, body: unknown, method = "POST") {
  return api(token, `${V}${path}`, { method, body: JSON.stringify(body) });
}

interface Vocab {
  id: string;
  word: string;
  meaning: string;
  srsState: string;
  stability: number;
  difficulty: number;
  dueDate: string;
  reviewCount: number;
  packIds?: string[];
  suspendedAt?: string | null;
}

describe("library: vocabulary", () => {
  it("creates cards with SRS defaults and dedupes by normalized word", async () => {
    const t = await nativeLogin("lib-vocab@example.com");
    const res = await post(t.accessToken, "/vocab", { word: " 懐かしい ", meaning: "nostalgic", pack: "N3", tz: "Asia/Tokyo" });
    expect(res.status).toBe(201);
    const created = await json<{ vocab: Vocab; created: boolean }>(res);
    expect(created.created).toBe(true);
    expect(created.vocab).toMatchObject({ word: "懐かしい", meaning: "nostalgic", srsState: "new", stability: 0, difficulty: 0, reviewCount: 0 });
    expect(created.vocab.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(created.vocab.packIds).toHaveLength(1);

    // Same word, different case/width → merged, empty fields backfilled.
    const dup = await json<{ vocab: Vocab; created: boolean; deduped: boolean }>(
      await post(t.accessToken, "/vocab", { word: "懐かしい", reading: "なつかしい", meaning: "other" }),
    );
    expect(dup).toMatchObject({ created: false, deduped: true });
    expect(dup.vocab).toMatchObject({ id: created.vocab.id, meaning: "nostalgic", reading: "なつかしい" });

    const latin = await json<{ vocab: Vocab }>(await post(t.accessToken, "/vocab", { word: "Ｈｅｌｌｏ" }));
    const again = await json<{ created: boolean; vocab: Vocab }>(await post(t.accessToken, "/vocab", { word: "hello " }));
    expect(again.created).toBe(false);
    expect(again.vocab.id).toBe(latin.vocab.id);

    const list = await json<{ items: Vocab[]; total: number }>(await api(t.accessToken, `${V}/vocab`));
    expect(list.total).toBe(2);

    // The records are visible through sync too.
    const pulled = await json<{ records: { type: string }[] }>(await api(t.accessToken, "/api/v1/sync/pull?types=Vocabulary,WordPack,WordPackMembership"));
    expect(pulled.records.map((r) => r.type).sort()).toEqual(["Vocabulary", "Vocabulary", "WordPack", "WordPackMembership"]);
  });

  it("lists due cards, reviews them and writes a ReviewEvent", async () => {
    const t = await nativeLogin("lib-review@example.com");
    const { vocab } = await json<{ vocab: Vocab }>(await post(t.accessToken, "/vocab", { word: "走る", meaning: "run" }));
    const due = await json<{ items: Vocab[]; total: number }>(await api(t.accessToken, `${V}/vocab?due=1&limit=10`));
    expect(due.items.map((v) => v.id)).toContain(vocab.id);

    expect((await post(t.accessToken, `/vocab/${vocab.id}/review`, { grade: 7 })).status).toBe(400);
    const res = await post(t.accessToken, `/vocab/${vocab.id}/review`, { grade: 3 });
    expect(res.status).toBe(200);
    const reviewed = await json<{ vocab: Vocab; event: { grade: number; vocabularyId: string; resultState: string } }>(res);
    expect(reviewed.vocab).toMatchObject({ srsState: "review", reviewCount: 1 });
    expect(reviewed.vocab.stability).toBeGreaterThan(0);
    expect(reviewed.event).toMatchObject({ grade: 3, vocabularyId: vocab.id, resultState: "review" });

    const after = await json<{ items: Vocab[] }>(await api(t.accessToken, `${V}/vocab?due=1`));
    expect(after.items.map((v) => v.id)).not.toContain(vocab.id);

    const events = await json<{ records: { type: string; payload: { grade: number } }[] }>(await api(t.accessToken, "/api/v1/sync/pull?types=ReviewEvent"));
    expect(events.records).toHaveLength(1);
    expect(events.records[0]!.payload.grade).toBe(3);
  });

  it("patches, suspends and deletes cards", async () => {
    const t = await nativeLogin("lib-patch@example.com");
    const { vocab } = await json<{ vocab: Vocab }>(await post(t.accessToken, "/vocab", { word: "猫", pack: "Animals" }));
    const patched = await json<{ vocab: Vocab }>(await post(t.accessToken, `/vocab/${vocab.id}`, { meaning: "cat", suspended: true }, "PATCH"));
    expect(patched.vocab.meaning).toBe("cat");
    expect(patched.vocab.suspendedAt).toBeTruthy();
    expect((await json<{ total: number }>(await api(t.accessToken, `${V}/vocab?due=1`))).total).toBe(0);

    const del = await api(t.accessToken, `${V}/vocab/${vocab.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await api(t.accessToken, `${V}/vocab/${vocab.id}`)).status).toBe(404);
    const packs = await json<{ items: { name: string; vocabCount: number }[] }>(await api(t.accessToken, `${V}/packs`));
    expect(packs.items.find((p) => p.name === "Animals")!.vocabCount).toBe(0);
  });

  it("manages word packs and members", async () => {
    const t = await nativeLogin("lib-packs@example.com");
    const created = await post(t.accessToken, "/packs", { name: "JLPT N2" });
    expect(created.status).toBe(201);
    const { pack } = await json<{ pack: { id: string } }>(created);
    expect((await json<{ created: boolean }>(await post(t.accessToken, "/packs", { name: "jlpt n2" }))).created).toBe(false);

    const { vocab } = await json<{ vocab: Vocab }>(await post(t.accessToken, "/vocab", { word: "概念" }));
    const add = await post(t.accessToken, `/packs/${pack.id}/members`, { vocabularyIds: [vocab.id] });
    expect(add.status).toBe(200);
    const inPack = await json<{ items: Vocab[] }>(await api(t.accessToken, `${V}/vocab?pack=${encodeURIComponent("JLPT N2")}`));
    expect(inPack.items.map((v) => v.id)).toEqual([vocab.id]);
    expect((await post(t.accessToken, `/packs/${pack.id}/members`, { vocabularyIds: ["missing"] })).status).toBe(404);
  });

  it("returns 402 QUOTA_EXCEEDED past the free vocabulary limit", async () => {
    const t = await nativeLogin("lib-quota@example.com");
    const ops = Array.from({ length: 200 }, (_, i) => ({
      opId: `lq-${i}`,
      type: "Vocabulary",
      id: `lq${i}`,
      baseRev: 0,
      hlc: `${String(Date.now()).padStart(13, "0")}-${String(i).padStart(4, "0")}-a1b2c3d4`,
      deleted: false,
      payload: { id: `lq${i}`, word: `w${i}`, meaning: "", srsState: "new", stability: 0, difficulty: 0, dueDate: "2026-09-28", reviewCount: 0, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" },
    }));
    const push = await api(t.accessToken, "/api/v1/sync/push", { method: "POST", body: JSON.stringify({ deviceId: "d", ops }) });
    expect(push.status).toBe(200);
    const res = await post(t.accessToken, "/vocab", { word: "one-too-many" });
    expect(res.status).toBe(402);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("QUOTA_EXCEEDED");
  });

  it("requires authentication", async () => {
    const res = await api("nope", `${V}/vocab`);
    expect(res.status).toBe(401);
  });
});

describe("library: lyrics, articles, books", () => {
  const LRC = "[ti:Test Song]\n[ar:Someone]\n[00:01.00]一行目\n[00:04.50]二行目\n[00:08.00]三行目\n";

  it("imports LRC lyrics and saves translations", async () => {
    const t = await nativeLogin("lib-lyrics@example.com");
    const res = await post(t.accessToken, "/lyrics", { raw: LRC });
    expect(res.status).toBe(201);
    const created = await json<{ article: { id: string; title: string; sourceType: string }; meta: { artist: string; sourceFormat: string } }>(res);
    expect(created.article).toMatchObject({ title: "Test Song", sourceType: "lyrics" });
    expect(created.meta).toMatchObject({ artist: "Someone", sourceFormat: "lrc" });

    const put = await post(t.accessToken, `/lyrics/${created.article.id}/translations`, {
      translations: [
        { order: 0, translation: "first line" },
        { order: 2, translation: "third line" },
      ],
    }, "PUT");
    expect(await json(put)).toMatchObject({ updated: 2, total: 3 });

    const show = await json<{ segments: { order: number; text: string; startTime: number; endTime: number; translation?: string }[]; meta: { artist: string } }>(
      await api(t.accessToken, `${V}/lyrics/${created.article.id}`),
    );
    expect(show.segments.map((s) => s.text)).toEqual(["一行目", "二行目", "三行目"]);
    expect(show.segments[0]).toMatchObject({ startTime: 1, endTime: 4.5, translation: "first line" });
    expect(show.segments[1]!.translation).toBeUndefined();
    expect(show.meta.artist).toBe("Someone");

    const list = await json<{ items: { id: string; title: string; artist: string }[] }>(await api(t.accessToken, `${V}/lyrics`));
    expect(list.items).toEqual([expect.objectContaining({ id: created.article.id, title: "Test Song", artist: "Someone" })]);

    const search = await json<{ items: { kind: string; id: string }[] }>(await api(t.accessToken, `${V}/search?q=test`));
    expect(search.items).toEqual([expect.objectContaining({ kind: "lyrics", id: created.article.id })]);

    expect((await post(t.accessToken, "/lyrics", { raw: "   " })).status).toBe(400);
    expect((await post(t.accessToken, "/lyrics", { raw: "just text", format: "nope", title: "x" })).status).toBe(400);
  });

  it("creates plain-text lyrics with inline translations", async () => {
    const t = await nativeLogin("lib-lyrics2@example.com");
    const res = await post(t.accessToken, "/lyrics", { title: "Plain", raw: "a\nb", format: "txt", translations: ["A", "B"] });
    const { article } = await json<{ article: { id: string } }>(res);
    const show = await json<{ segments: { translation: string; startTime?: number }[] }>(await api(t.accessToken, `${V}/lyrics/${article.id}`));
    expect(show.segments.map((s) => s.translation)).toEqual(["A", "B"]);
    expect(show.segments[0]!.startTime).toBeUndefined();
  });

  it("creates and reads articles", async () => {
    const t = await nativeLogin("lib-articles@example.com");
    const res = await post(t.accessToken, "/articles", { title: "Hello", content: "First sentence. Second one!\nNew paragraph." });
    expect(res.status).toBe(201);
    const { article } = await json<{ article: { id: string } }>(res);
    const full = await json<{ segments: { text: string; isNewParagraph: boolean }[] }>(await api(t.accessToken, `${V}/articles/${article.id}`));
    expect(full.segments.map((s) => [s.text, s.isNewParagraph])).toEqual([
      ["First sentence.", true],
      ["Second one!", false],
      ["New paragraph.", true],
    ]);
    const list = await json<{ items: { id: string; preview: string }[] }>(await api(t.accessToken, `${V}/articles`));
    expect(list.items).toHaveLength(1);
    expect((await api(t.accessToken, `${V}/lyrics/${article.id}`)).status).toBe(404);
  });

  it("lists books and chapters", async () => {
    const t = await nativeLogin("lib-books@example.com");
    const h = (n: number) => `${String(Date.now()).padStart(13, "0")}-${String(n).padStart(4, "0")}-a1b2c3d4`;
    const ops = [
      { opId: "b1", type: "Book", id: "book1", baseRev: 0, hlc: h(1), deleted: false, payload: { id: "book1", title: "Novel", format: "txt", totalChars: 10, defaultMode: "native", originalOnly: false, createdAt: "2026-09-28T00:00:00Z" } },
      { opId: "b2", type: "Article", id: "ch2", baseRev: 0, hlc: h(2), deleted: false, payload: { id: "ch2", title: "Chapter 2", content: "b", sourceType: "article", createdAt: "2026-09-28T00:00:00Z" } },
      { opId: "b3", type: "Article", id: "ch1", baseRev: 0, hlc: h(3), deleted: false, payload: { id: "ch1", title: "Chapter 1", content: "a", sourceType: "article", createdAt: "2026-09-28T00:00:00Z" } },
      { opId: "b4", type: "BookChapter", id: "ch2", baseRev: 0, hlc: h(4), deleted: false, payload: { articleId: "ch2", bookId: "book1", index: 1, isSegmented: false, charCount: 1 } },
      { opId: "b5", type: "BookChapter", id: "ch1", baseRev: 0, hlc: h(5), deleted: false, payload: { articleId: "ch1", bookId: "book1", index: 0, isSegmented: false, charCount: 1 } },
    ];
    await api(t.accessToken, "/api/v1/sync/push", { method: "POST", body: JSON.stringify({ deviceId: "d", ops }) });
    const books = await json<{ items: { id: string; title: string }[] }>(await api(t.accessToken, `${V}/books`));
    expect(books.items).toEqual([expect.objectContaining({ id: "book1", title: "Novel" })]);
    const chapters = await json<{ items: { index: number; title: string }[] }>(await api(t.accessToken, `${V}/books/book1/chapters`));
    expect(chapters.items.map((c) => [c.index, c.title])).toEqual([
      [0, "Chapter 1"],
      [1, "Chapter 2"],
    ]);
    // Chapters are not listed as standalone articles.
    expect((await json<{ total: number }>(await api(t.accessToken, `${V}/articles`))).total).toBe(0);
    expect((await api(t.accessToken, `${V}/books/missing/chapters`)).status).toBe(404);
  });
});
