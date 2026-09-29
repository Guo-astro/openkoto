import { describe, expect, it } from "vitest";
import { reviewCard, type Grade, type JsonObject, type PullResponse, type SrsCardState, type SyncRecord } from "@openkoto/core";
import { ApiError, MemoryStore, SyncEngine, replayEventFromRecord, replayEvents, type SyncDiagnostic, type SyncTransport } from "../src/index";
import { FakeServer } from "./fake-server";

const T0 = Date.UTC(2026, 8, 28, 9, 0, 0); // 2026-09-28T09:00Z
const MIN = 60_000;
const DEVICE_A = "aaaaaaaa-1111-4111-8111-111111111111";
const DEVICE_B = "bbbbbbbb-2222-4222-8222-222222222222";

const V1 = "3F0C2A4E-1D2B-4C5D-9E8F-0A1B2C3D4E5F"; // uppercase like iOS UUID.uuidString
const V2 = "11111111-1d2b-4c5d-9e8f-0a1b2c3d4e5f";
const PACK = "22222222-1d2b-4c5d-9e8f-0a1b2c3d4e5f";
const ARTICLE = "33333333-1d2b-4c5d-9e8f-0a1b2c3d4e5f";

function vocab(id: string, word: string, meaning: string): JsonObject {
  return { id, word, meaning, srsState: "new", stability: 0, difficulty: 0, dueDate: "2026-09-28", reviewCount: 0, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
}

function segment(id: string, order: number, text: string, revision: number, extra: JsonObject = {}): JsonObject {
  return { id, articleId: ARTICLE, order, text, isNewParagraph: order === 0, createdAt: "2026-09-28T00:00:00Z", segmentationRevision: revision, ...extra };
}

interface Device {
  engine: SyncEngine;
  store: MemoryStore;
  clock: { now: number };
  diagnostics: SyncDiagnostic[];
}

function device(server: FakeServer, deviceId: string, opts: { pullLimit?: number; transport?: SyncTransport; start?: number } = {}): Device {
  const store = new MemoryStore();
  const clock = { now: opts.start ?? T0 };
  const diagnostics: SyncDiagnostic[] = [];
  const engine = new SyncEngine({
    transport: opts.transport ?? server.transport(deviceId),
    store,
    deviceId,
    now: () => clock.now,
    pullLimit: opts.pullLimit ?? 3,
    onDiagnostic: (d) => diagnostics.push(d),
  });
  return { engine, store, clock, diagnostics };
}

async function review(d: Device, cardId: string, grade: Grade, at: string): Promise<void> {
  d.clock.now = Date.parse(at);
  const id = cardId.toLowerCase();
  const card = (await d.store.getRecord("Vocabulary", id))!.payload as unknown as SrsCardState & { id: string };
  const { card: next, event } = reviewCard({ ...card, id }, grade, new Date(at), { timeZone: "UTC" });
  const eventId = crypto.randomUUID();
  await d.engine.recordLocalChange("ReviewEvent", eventId, { payload: { id: eventId, ...event } as unknown as JsonObject });
  await d.engine.recordLocalChange("Vocabulary", id, { payload: next as unknown as JsonObject });
}

/** Sync devices round-robin until nothing is dirty and all stores agree. */
async function converge(...devices: Device[]): Promise<number> {
  for (let pass = 1; pass <= 6; pass++) {
    for (const d of devices) await d.engine.sync();
    const dirty = (await Promise.all(devices.map((d) => d.store.dirtyRecords()))).flat();
    const snapshots = devices.map((d) => JSON.stringify(d.store.snapshot()));
    if (dirty.length === 0 && snapshots.every((x) => x === snapshots[0])) return pass;
  }
  throw new Error("did not converge");
}

describe("SyncEngine end-to-end (two devices, fake server)", () => {
  it("converges after concurrent edits, deletes, re-segmentation and same-day reviews", async () => {
    const server = new FakeServer(() => T0 + 24 * 60 * MIN);
    const a = device(server, DEVICE_A);
    const b = device(server, DEVICE_B);

    // Initial content on A.
    await a.engine.recordLocalChange("Vocabulary", V1, { payload: vocab(V1, "懐かしい", "nostalgic") });
    await a.engine.recordLocalChange("Vocabulary", V2, { payload: vocab(V2, "猫", "cat") });
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "N3", tags: [], isSystem: false, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" } });
    await a.engine.recordLocalChange("WordPackMembership", `${V1}_${PACK}`, { payload: { vocabularyId: V1.toLowerCase(), packId: PACK } });
    await a.engine.recordLocalChange("Article", ARTICLE, { payload: { id: ARTICLE, title: "猫", content: "猫が好きです。犬も好きです。鳥は？", sourceType: "article", createdAt: "2026-09-28T00:00:00Z" } });
    const oldSegs = ["44444444-0000-4000-8000-000000000001", "44444444-0000-4000-8000-000000000002", "44444444-0000-4000-8000-000000000003"];
    for (const [i, s] of oldSegs.entries()) await a.engine.recordLocalChange("Segment", s, { payload: segment(s, i, `s${i}`, 0) });

    const first = await a.engine.sync();
    expect(first.pushed).toBe(8);
    expect(server.get("Vocabulary", V1)?.id).toBe(V1.toLowerCase());
    await b.engine.sync();
    expect(b.store.snapshot()).toEqual(a.store.snapshot());
    expect(server.log.pulls).toBeGreaterThan(3); // pagination with limit 3

    // ---- offline on both devices ----
    a.clock.now = T0 + 1000;
    await a.engine.recordLocalChange("Vocabulary", V1, { payload: vocab(V1, "懐かしい", "A: nostalgic") });
    b.clock.now = T0 + 2000;
    await b.engine.recordLocalChange("Vocabulary", V1, { payload: vocab(V1, "懐かしい", "B: dear old") });

    b.clock.now = T0 + 20 * MIN;
    await b.engine.recordLocalChange("Vocabulary", V2, { payload: vocab(V2, "猫", "B edited before A deleted") });
    a.clock.now = T0 + 30 * MIN;
    await a.engine.recordLocalChange("Vocabulary", V2, { deleted: true });

    a.clock.now = T0 + 30 * MIN;
    await a.engine.recordLocalChange("WordPack", PACK, { deleted: true });
    b.clock.now = T0 + 45 * MIN;
    await b.engine.recordLocalChange("WordPack", PACK, { payload: { name: "N3 (renamed after the delete)", tags: [], isSystem: false, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T09:45:00Z" } });

    // B adds a translation to an old segment; later A re-segments the article (revision 1).
    b.clock.now = T0 + 75 * MIN;
    const s0 = (await b.store.getRecord("Segment", oldSegs[0]!))!;
    await b.engine.recordLocalChange("Segment", s0.id, { payload: { ...s0.payload!, translation: "I like cats." } });
    a.clock.now = T0 + 90 * MIN;
    for (const s of oldSegs) await a.engine.recordLocalChange("Segment", s, { deleted: true });
    const newSegs = ["55555555-0000-4000-8000-000000000001", "55555555-0000-4000-8000-000000000002"];
    for (const [i, s] of newSegs.entries()) await a.engine.recordLocalChange("Segment", s, { payload: segment(s, i, `n${i}`, 1) });

    // Same-day reviews of V1 on both devices.
    await review(a, V1, 3, "2026-09-28T10:00:00.000Z");
    await review(b, V1, 1, "2026-09-28T11:00:00.000Z");

    a.clock.now = b.clock.now = Date.parse("2026-09-28T12:00:00Z");
    const passes = await converge(a, b, a, b);
    expect(passes).toBeLessThanOrEqual(3);

    // ---- both stores identical and clean ----
    expect(a.store.snapshot()).toEqual(b.store.snapshot());
    expect(await a.store.dirtyRecords()).toHaveLength(0);
    expect(await b.store.dirtyRecords()).toHaveLength(0);

    const v1 = (await a.store.getRecord("Vocabulary", V1.toLowerCase()))!;
    expect(v1.payload!.meaning).toBe("B: dear old");
    const events = (await a.store.listByType("ReviewEvent")).map((r) => replayEventFromRecord(r)!);
    expect(events).toHaveLength(2);
    const expected = replayEvents(null, events);
    expect(v1.payload).toMatchObject({
      srsState: expected.srsState,
      stability: expected.stability,
      difficulty: expected.difficulty,
      dueDate: expected.dueDate,
      lastReviewedAt: "2026-09-28T11:00:00.000Z",
      reviewCount: 2,
    });
    expect(expected.srsState).toBe("learning");

    expect((await a.store.getRecord("Vocabulary", V2))!.deleted).toBe(true);
    expect((await b.store.getRecord("WordPack", PACK))!.payload!.name).toBe("N3 (renamed after the delete)");
    const liveSegs = (await b.store.listByType("Segment")).filter((s) => !s.deleted).map((s) => s.id).sort();
    expect(liveSegs).toEqual(newSegs);

    // The server agrees with the devices on every LWW field.
    for (const r of a.store.all()) {
      const s = server.get(r.type, r.id)!;
      expect({ rev: s.rev, hlc: s.hlc, deleted: s.deleted }).toEqual({ rev: r.rev, hlc: r.hlc, deleted: r.deleted });
    }
  });

  it("re-segmentation from another device purges the old local segments", async () => {
    const server = new FakeServer(() => T0);
    const a = device(server, DEVICE_A);
    const b = device(server, DEVICE_B);
    const oldId = "66666666-0000-4000-8000-000000000001";
    await a.engine.recordLocalChange("Segment", oldId, { payload: segment(oldId, 0, "old", 0) });
    await a.engine.sync();
    await b.engine.sync();
    // A re-segments but (buggy client) forgets the tombstone: B still drops the stale revision.
    a.clock.now = T0 + MIN;
    const newId = "66666666-0000-4000-8000-000000000002";
    await a.engine.recordLocalChange("Segment", newId, { payload: segment(newId, 0, "new", 1) });
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.store.getRecord("Segment", oldId))!.deleted).toBe(true);
    expect((await b.store.getRecord("Segment", newId))!.deleted).toBe(false);
  });

  it("retries a push whose response was lost without duplicating the write", async () => {
    const server = new FakeServer(() => T0);
    const inner = server.transport(DEVICE_A);
    let dropNext = true;
    const flaky: SyncTransport = {
      pull: inner.pull,
      push: async (req) => {
        const res = await inner.push(req);
        if (dropNext) {
          dropNext = false;
          throw new Error("network down");
        }
        return res;
      },
    };
    const a = device(server, DEVICE_A, { transport: flaky });
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "N3", tags: [], isSystem: false } });
    await expect(a.engine.sync()).rejects.toThrow("network down");
    expect(await a.store.dirtyRecords()).toHaveLength(1);

    const report = await a.engine.sync();
    expect(report.pushed).toBe(0); // the echo acknowledged it during pull
    expect(await a.store.dirtyRecords()).toHaveLength(0);
    expect(server.all()).toHaveLength(1);
    expect((await a.store.getRecord("WordPack", PACK))!.rev).toBe(1);
  });

  it("re-pushes after a conflict at most twice per cycle", async () => {
    const server = new FakeServer(() => T0);
    let pushes = 0;
    const inner = server.transport(DEVICE_A);
    // Pathological server: always reports a conflict whose `current` is older than our write.
    const hostile: SyncTransport = {
      pull: inner.pull,
      push: async (req) => {
        pushes += 1;
        return {
          cursor: "c_0",
          results: req.ops.map((op) => ({
            opId: op.opId,
            status: "conflict" as const,
            rev: 5 + pushes,
            current: { type: op.type, id: op.id, rev: 5 + pushes, hlc: "0000000000001-0000-cccccccc", deviceId: "x", deleted: false, payload: { name: "server" } },
          })),
        };
      },
    };
    const a = device(server, DEVICE_A, { transport: hostile });
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "mine", tags: [], isSystem: false } });
    const report = await a.engine.sync();
    expect(pushes).toBe(3);
    expect(report.repushRounds).toBe(2);
    expect(report.conflicts).toBe(3);
    const local = (await a.store.getRecord("WordPack", PACK))!;
    expect(local).toMatchObject({ dirty: true, rev: 8, payload: { name: "mine" } });
  });

  it("an older concurrent edit loses to a newer one pulled first", async () => {
    const server = new FakeServer(() => T0 + 60 * MIN);
    const a = device(server, DEVICE_A);
    const b = device(server, DEVICE_B);
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "base", tags: [], isSystem: false } });
    await a.engine.sync();
    await b.engine.sync();
    b.clock.now = T0 + 10 * MIN;
    await b.engine.recordLocalChange("WordPack", PACK, { payload: { name: "B newer", tags: [], isSystem: false } });
    a.clock.now = T0 + 5 * MIN;
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "A older", tags: [], isSystem: false } });
    await b.engine.sync();
    const r = await a.engine.sync();
    expect(r.conflicts).toBe(0);
    expect((await a.store.getRecord("WordPack", PACK))!.payload!.name).toBe("B newer");
    expect(server.get("WordPack", PACK)!.payload!.name).toBe("B newer");
  });

  it("applies a push conflict's current record (B pushed between A's pull and push)", async () => {
    const server = new FakeServer(() => T0 + 60 * MIN);
    let b: Device | null = null;
    const inner = server.transport(DEVICE_A);
    let raced = false;
    const racing: SyncTransport = {
      pull: inner.pull,
      push: async (req) => {
        if (!raced && b) {
          raced = true;
          await b.engine.sync();
        }
        return inner.push(req);
      },
    };
    const a = device(server, DEVICE_A, { transport: racing });
    b = device(server, DEVICE_B);
    await b.engine.recordLocalChange("WordPack", PACK, { payload: { name: "base", tags: [], isSystem: false } });
    await b.engine.sync();
    raced = false;
    await a.engine.sync();
    raced = false;
    a.clock.now = T0 + 5 * MIN;
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "A older", tags: [], isSystem: false } });
    b.clock.now = T0 + 10 * MIN;
    await b.engine.recordLocalChange("WordPack", PACK, { payload: { name: "B newer", tags: [], isSystem: false } });
    const r = await a.engine.sync();
    expect(r.conflicts).toBe(1);
    expect(r.repushRounds).toBe(0);
    const local = (await a.store.getRecord("WordPack", PACK))!;
    expect(local).toMatchObject({ dirty: false, payload: { name: "B newer" }, rev: server.get("WordPack", PACK)!.rev });
  });

  it("does a full rebuild on 410 CURSOR_EXPIRED and re-uploads records the server lost", async () => {
    const server = new FakeServer(() => T0);
    const a = device(server, DEVICE_A);
    const b = device(server, DEVICE_B);
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "keep", tags: [], isSystem: false } });
    await a.engine.recordLocalChange("Vocabulary", V2, { payload: vocab(V2, "猫", "cat") });
    await a.engine.sync();
    await b.engine.sync();
    a.clock.now = T0 + MIN;
    await a.engine.recordLocalChange("Vocabulary", V2, { deleted: true });
    await a.engine.recordLocalChange("WordPack", "77777777-0000-4000-8000-000000000000", { payload: { name: "later", tags: [], isSystem: false } });
    await a.engine.sync();
    server.purgeTombstones(); // B's cursor is now older than the tombstone floor

    const report = await b.engine.sync();
    expect(report.rebuilt).toBe(true);
    expect((await b.store.getRecord("WordPack", "77777777-0000-4000-8000-000000000000"))?.payload?.name).toBe("later");
    // Spec §8: a live local record missing on the server is treated as new (its tombstone expired).
    expect(server.get("Vocabulary", V2)?.deleted).toBe(false);
    expect(await b.store.dirtyRecords()).toHaveLength(0);
  });

  it("skips unknown types and records >24h ahead, and still advances the cursor", async () => {
    const future = "9999999999999-0000-dddddddd";
    const page: PullResponse = {
      records: [
        { type: "Hologram" as SyncRecord["type"], id: "x", rev: 1, hlc: "0000000000001-0000-dddddddd", deviceId: "d", deleted: false, payload: {} },
        { type: "WordPack", id: "p-future", rev: 2, hlc: future, deviceId: "d", deleted: false, payload: { name: "skewed" } },
        { type: "WordPack", id: "p-ok", rev: 3, hlc: "0000000000002-0000-dddddddd", deviceId: "d", deleted: false, payload: { name: "ok" } },
      ],
      cursor: "c_3",
      hasMore: false,
      serverTime: new Date(T0).toISOString(),
    };
    const transport: SyncTransport = { pull: async () => page, push: async () => ({ results: [], cursor: "c_3" }) };
    const a = device(new FakeServer(), DEVICE_A, { transport });
    await a.engine.sync();
    expect(await a.store.getMeta("cursor")).toBe("c_3");
    expect(await a.store.getRecord("WordPack", "p-future")).toBeNull();
    expect(await a.store.getRecord("WordPack", "p-ok")).not.toBeNull();
    expect(a.diagnostics.map((d) => d.kind).sort()).toEqual(["clock-skew", "unknown-type"]);
  });

  it("defers records whose foreign keys are missing and retries them next sync", async () => {
    const server = new FakeServer(() => T0);
    const writer = device(server, DEVICE_A);
    await writer.engine.recordLocalChange("WordPackMembership", `${V2}_${PACK}`, { payload: { vocabularyId: V2, packId: PACK } });
    await writer.engine.sync();
    await writer.engine.recordLocalChange("Vocabulary", V2, { payload: vocab(V2, "猫", "cat") });
    await writer.engine.sync();

    const store = new MemoryStore();
    const engine = new SyncEngine({
      transport: server.transport(DEVICE_B),
      store,
      deviceId: DEVICE_B,
      now: () => T0,
      pullLimit: 1,
      isReady: async (r, s) => r.type !== "WordPackMembership" || !!(await s.getRecord("Vocabulary", String(r.payload?.vocabularyId).toLowerCase())),
    });
    await engine.sync();
    expect(await store.getRecord("WordPackMembership", `${V2}_${PACK}`)).toBeNull();
    await engine.sync();
    expect(await store.getRecord("WordPackMembership", `${V2}_${PACK}`)).not.toBeNull();
  });

  it("never uploads system packs, refuses to edit ReviewEvents, and cascades Article deletes", async () => {
    const server = new FakeServer(() => T0);
    const a = device(server, DEVICE_A);
    await a.engine.recordLocalChange("WordPack", "sys", { payload: { name: "JLPT N5", tags: [], isSystem: true } });
    const evId = "88888888-0000-4000-8000-000000000000";
    await a.engine.recordLocalChange("ReviewEvent", evId, { payload: { vocabularyId: V2, reviewedAt: "2026-09-28T09:00:00Z", grade: 3 } });
    await expect(a.engine.recordLocalChange("ReviewEvent", evId, { payload: { grade: 1 } })).rejects.toThrow("IMMUTABLE");
    await expect(a.engine.recordLocalChange("ReviewEvent", "other", { deleted: true })).rejects.toThrow("IMMUTABLE");

    await a.engine.recordLocalChange("Article", ARTICLE, { payload: { title: "t", content: "c", createdAt: "2026-09-28T00:00:00Z" } });
    await a.engine.recordLocalChange("Segment", "s1", { payload: segment("s1", 0, "x", 0) });
    await a.engine.recordLocalChange("LyricsMeta", ARTICLE, { payload: { articleId: ARTICLE } });
    await a.engine.recordLocalChange("Article", ARTICLE, { deleted: true });
    expect((await a.store.getRecord("Segment", "s1"))!.deleted).toBe(true);
    expect((await a.store.getRecord("LyricsMeta", ARTICLE))!.deleted).toBe(true);

    await a.engine.sync();
    expect(server.get("WordPack", "sys")).toBeUndefined();
    expect((await a.store.getRecord("WordPack", "sys"))!.dirty).toBe(false);
    expect(server.get("Segment", "s1")!.deleted).toBe(true);
  });

  it("surfaces 410 only as a rebuild, other API errors propagate", async () => {
    const transport: SyncTransport = {
      pull: async () => {
        throw new ApiError(503, "INTERNAL", "down");
      },
      push: async () => ({ results: [], cursor: "c_0" }),
    };
    const a = device(new FakeServer(), DEVICE_A, { transport });
    await expect(a.engine.sync()).rejects.toMatchObject({ status: 503, code: "INTERNAL" });
  });

  it("shares one in-flight cycle between concurrent sync() calls", async () => {
    const server = new FakeServer(() => T0);
    const a = device(server, DEVICE_A);
    await a.engine.recordLocalChange("WordPack", PACK, { payload: { name: "x", tags: [], isSystem: false } });
    const [r1, r2] = await Promise.all([a.engine.sync(), a.engine.sync()]);
    expect(r1).toBe(r2);
    expect(server.log.pushes).toBe(1);
  });
});
