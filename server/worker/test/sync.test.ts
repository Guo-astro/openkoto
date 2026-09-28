import { describe, expect, it } from "vitest";
import { api, hlc, json, nativeLogin } from "./helpers";

interface PushResponse {
  results: ({ opId: string; status: string; rev: number; code?: string; current?: { payload: Record<string, unknown> } })[];
  cursor: string;
}
interface PullResponse {
  records: { type: string; id: string; rev: number; deleted: boolean; payload: Record<string, unknown> | null }[];
  cursor: string;
  hasMore: boolean;
}

function vocab(id: string, word: string) {
  return { word, meaning: "m", srsState: "new", stability: 0, difficulty: 0, dueDate: "2026-09-28", reviewCount: 0, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", id };
}

async function push(token: string, ops: unknown[]): Promise<PushResponse> {
  const res = await api(token, "/api/v1/sync/push", { method: "POST", body: JSON.stringify({ deviceId: "d", ops }) });
  expect(res.status).toBe(200);
  return json<PushResponse>(res);
}

async function pull(token: string, cursor?: string, extra = ""): Promise<PullResponse> {
  const res = await api(token, `/api/v1/sync/pull?limit=500${cursor ? `&cursor=${cursor}` : ""}${extra}`);
  expect(res.status).toBe(200);
  return json<PullResponse>(res);
}

describe("sync", () => {
  it("round-trips records between two devices", async () => {
    const phone = await nativeLogin("sync1@example.com", "ios");
    const id = "3F0C2A4E-1D2B-4C5D-9E8F-0A1B2C3D4E5F";
    const pushed = await push(phone.accessToken, [{ opId: "op-1", type: "Vocabulary", id, baseRev: 0, hlc: hlc(), deleted: false, payload: vocab(id, "懐かしい") }]);
    expect(pushed.results[0]).toMatchObject({ status: "applied", rev: 1 });

    const laptop = await nativeLogin("sync1@example.com", "windows");
    const pulled = await pull(laptop.accessToken);
    expect(pulled.records).toHaveLength(1);
    expect(pulled.records[0]).toMatchObject({ type: "Vocabulary", id: id.toLowerCase(), rev: 1, deleted: false });
    expect(pulled.cursor).toBe("c_1");
    expect((await pull(laptop.accessToken, pulled.cursor)).records).toHaveLength(0);
  });

  it("keeps users isolated", async () => {
    const a = await nativeLogin("iso-a@example.com");
    const b = await nativeLogin("iso-b@example.com");
    await push(a.accessToken, [{ opId: "iso-1", type: "WordPack", id: "p1", baseRev: 0, hlc: hlc(), deleted: false, payload: { name: "N3" } }]);
    expect((await pull(b.accessToken)).records).toHaveLength(0);
  });

  it("is idempotent per opId", async () => {
    const t = await nativeLogin("sync2@example.com");
    const op = { opId: "same-op", type: "WordPack", id: "p1", baseRev: 0, hlc: hlc(), deleted: false, payload: { name: "A" } };
    const first = await push(t.accessToken, [op]);
    const second = await push(t.accessToken, [op]);
    expect(second.results[0]).toEqual(first.results[0]);
    expect((await pull(t.accessToken)).records).toHaveLength(1);
  });

  it("resolves concurrent edits by HLC and reports conflicts", async () => {
    const t = await nativeLogin("sync3@example.com");
    const now = Date.now();
    await push(t.accessToken, [{ opId: "c-0", type: "WordPack", id: "p", baseRev: 0, hlc: hlc(now), deleted: false, payload: { name: "base" } }]);
    // Device A edits from rev 1.
    const a = await push(t.accessToken, [{ opId: "c-a", type: "WordPack", id: "p", baseRev: 1, hlc: hlc(now + 2000), deleted: false, payload: { name: "A" } }]);
    expect(a.results[0]!.status).toBe("applied");
    // Device B edited earlier (older HLC) also from rev 1 → conflict carrying A's value.
    const b = await push(t.accessToken, [{ opId: "c-b", type: "WordPack", id: "p", baseRev: 1, hlc: hlc(now + 1000), deleted: false, payload: { name: "B" } }]);
    expect(b.results[0]).toMatchObject({ status: "conflict", rev: 2 });
    expect(b.results[0]!.current!.payload).toMatchObject({ name: "A" });
    // A newer edit from a stale base still wins.
    const c = await push(t.accessToken, [{ opId: "c-c", type: "WordPack", id: "p", baseRev: 1, hlc: hlc(now + 3000), deleted: false, payload: { name: "C" } }]);
    expect(c.results[0]!.status).toBe("applied");
  });

  it("propagates tombstones and keeps review events immutable", async () => {
    const t = await nativeLogin("sync4@example.com");
    await push(t.accessToken, [
      { opId: "t-1", type: "BookMark", id: "bm", baseRev: 0, hlc: hlc(), deleted: false, payload: { bookId: "b", chapterIndex: 0, kind: "bookmark" } },
      { opId: "t-2", type: "ReviewEvent", id: "ev", baseRev: 0, hlc: hlc(), deleted: false, payload: { vocabularyId: "v", grade: 3 } },
    ]);
    const del = await push(t.accessToken, [{ opId: "t-3", type: "BookMark", id: "bm", baseRev: 1, hlc: hlc(Date.now() + 10), deleted: true }]);
    expect(del.results[0]!.status).toBe("applied");
    const again = await push(t.accessToken, [
      { opId: "t-4", type: "ReviewEvent", id: "ev", baseRev: 0, hlc: hlc(Date.now() + 20), deleted: false, payload: { vocabularyId: "v", grade: 1 } },
      { opId: "t-5", type: "ReviewEvent", id: "ev", baseRev: 2, hlc: hlc(Date.now() + 30), deleted: true },
    ]);
    expect(again.results[0]).toMatchObject({ status: "applied", rev: 2 });
    expect(again.results[1]).toMatchObject({ status: "rejected", code: "IMMUTABLE" });

    const pulled = await pull(t.accessToken);
    const bm = pulled.records.find((r) => r.id === "bm")!;
    expect(bm.deleted).toBe(true);
    expect(bm.payload).toBeNull();
    expect(pulled.records.find((r) => r.id === "ev")!.payload).toMatchObject({ grade: 3 });
  });

  it("validates ops", async () => {
    const t = await nativeLogin("sync5@example.com");
    const res = await push(t.accessToken, [
      { opId: "v-1", type: "Nope", id: "x", baseRev: 0, hlc: hlc(), deleted: false, payload: {} },
      { opId: "v-2", type: "WordPack", id: "x", baseRev: 0, hlc: "bad", deleted: false, payload: {} },
      { opId: "v-3", type: "WordPack", id: "x", baseRev: 0, hlc: hlc(Date.now() + 3 * 24 * 3600 * 1000), deleted: false, payload: {} },
      { opId: "v-4", type: "WordPack", id: "x", baseRev: 0, hlc: hlc(), deleted: false, payload: [] },
    ]);
    expect(res.results.map((r) => r.code)).toEqual(["UNKNOWN_TYPE", "INVALID_PAYLOAD", "CLOCK_SKEW", "INVALID_PAYLOAD"]);
  });

  it("paginates and filters by type", async () => {
    const t = await nativeLogin("sync6@example.com");
    const ops = Array.from({ length: 30 }, (_, i) => ({
      opId: `p-${i}`,
      type: i % 2 ? "WordPack" : "BookMark",
      id: `r${i}`,
      baseRev: 0,
      hlc: hlc(),
      deleted: false,
      payload: { n: i },
    }));
    await push(t.accessToken, ops);
    const page1 = await json<PullResponse>(await api(t.accessToken, "/api/v1/sync/pull?limit=10"));
    expect(page1.records).toHaveLength(10);
    expect(page1.hasMore).toBe(true);
    const page2 = await json<PullResponse>(await api(t.accessToken, `/api/v1/sync/pull?limit=100&cursor=${page1.cursor}`));
    expect(page2.records).toHaveLength(20);
    expect(page2.hasMore).toBe(false);
    const packs = await pull(t.accessToken, undefined, "&types=WordPack");
    expect(packs.records.every((r) => r.type === "WordPack")).toBe(true);
    expect(packs.records).toHaveLength(15);
  });

  it("enforces the free vocabulary quota on new records only", async () => {
    const t = await nativeLogin("quota@example.com");
    const ops = Array.from({ length: 200 }, (_, i) => ({ opId: `q-${i}`, type: "Vocabulary", id: `v${i}`, baseRev: 0, hlc: hlc(), deleted: false, payload: vocab(`v${i}`, `w${i}`) }));
    const first = await push(t.accessToken, ops);
    expect(first.results.every((r) => r.status === "applied")).toBe(true);

    const over = await push(t.accessToken, [{ opId: "q-over", type: "Vocabulary", id: "v200", baseRev: 0, hlc: hlc(), deleted: false, payload: vocab("v200", "x") }]);
    expect(over.results[0]).toMatchObject({ status: "rejected", code: "QUOTA_EXCEEDED" });

    // Editing an existing card is still allowed.
    const edit = await push(t.accessToken, [{ opId: "q-edit", type: "Vocabulary", id: "v0", baseRev: 1, hlc: hlc(Date.now() + 5), deleted: false, payload: vocab("v0", "edited") }]);
    expect(edit.results[0]!.status).toBe("applied");

    // Deleting one frees a slot.
    await push(t.accessToken, [{ opId: "q-del", type: "Vocabulary", id: "v1", baseRev: 2, hlc: hlc(Date.now() + 6), deleted: true }]);
    const retry = await push(t.accessToken, [{ opId: "q-retry", type: "Vocabulary", id: "v200", baseRev: 0, hlc: hlc(Date.now() + 7), deleted: false, payload: vocab("v200", "x") }]);
    expect(retry.results[0]!.status).toBe("applied");

    const stats = await json<{ usage: { vocabulary: number }; limits: { vocabulary: number } }>(await api(t.accessToken, "/api/v1/sync/stats"));
    expect(stats.usage.vocabulary).toBe(200);
    expect(stats.limits.vocabulary).toBe(200);
  });

  it("counts lyrics separately from articles", async () => {
    const t = await nativeLogin("lyrics@example.com");
    const ops = Array.from({ length: 31 }, (_, i) => ({
      opId: `l-${i}`,
      type: "Article",
      id: `a${i}`,
      baseRev: 0,
      hlc: hlc(),
      deleted: false,
      payload: { title: `song ${i}`, content: "…", sourceType: "lyrics", createdAt: "2026-09-28T00:00:00Z" },
    }));
    const res = await push(t.accessToken, ops);
    expect(res.results.filter((r) => r.status === "applied")).toHaveLength(30);
    expect(res.results[30]).toMatchObject({ code: "QUOTA_EXCEEDED" });
    const article = await push(t.accessToken, [
      { opId: "l-art", type: "Article", id: "plain", baseRev: 0, hlc: hlc(), deleted: false, payload: { title: "t", content: "c", sourceType: "article" } },
    ]);
    expect(article.results[0]!.status).toBe("applied");
  });

  it("requires authentication", async () => {
    const res = await api("nope", "/api/v1/sync/pull");
    expect(res.status).toBe(401);
  });
});

describe("export", () => {
  it("streams the account and live records as NDJSON", async () => {
    const t = await nativeLogin("export@example.com");
    await push(t.accessToken, [
      { opId: "e1", type: "WordPack", id: "p1", baseRev: 0, hlc: hlc(), deleted: false, payload: { name: "keep" } },
      { opId: "e2", type: "WordPack", id: "p2", baseRev: 0, hlc: hlc(), deleted: false, payload: { name: "gone" } },
    ]);
    await push(t.accessToken, [{ opId: "e3", type: "WordPack", id: "p2", baseRev: 2, hlc: hlc(Date.now() + 5), deleted: true }]);
    const res = await api(t.accessToken, "/api/v1/account/export");
    expect(res.headers.get("Content-Type")).toContain("ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { kind: string; id?: string });
    expect(lines[0]!.kind).toBe("account");
    expect(lines.filter((l) => l.kind === "record").map((l) => l.id)).toEqual(["p1"]);
  });
});
