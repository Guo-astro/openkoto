// Storage-agnostic sync engine, sync-protocol-spec §8.

import {
  HybridClock,
  MAX_CLOCK_SKEW_MS,
  MAX_PUSH_OPS,
  DEFAULT_PULL_LIMIT,
  RECORD_TYPES,
  canonicalId,
  isRecordType,
  isValidHlc,
  mergeOrder,
  nodeIdFromDevice,
  parseHlc,
  type JsonObject,
  type OpErrorCode,
  type PushOp,
  type RecordType,
  type ReplayInitial,
  type ScheduleOptions,
  type SyncRecord,
} from "@openkoto/core";
import { ApiError, type SyncTransport } from "../api";
import { mergeRemote, segmentRevisionOf, type MergeDecision } from "./merge";
import { applyReplayToPayload, replayEventFromRecord, replayEvents } from "./replay";
import { META_CURSOR, META_DEVICE_ID, META_HLC, type LocalRecord, type LocalStore } from "./store";

export type LocalChange = { payload: JsonObject; deleted?: false } | { deleted: true; payload?: null };

export interface SyncDiagnostic {
  kind: "unknown-type" | "clock-skew" | "invalid-hlc" | "deferred" | "rejected";
  type: string;
  id: string;
  message: string;
}

export interface RejectedOp {
  type: RecordType;
  id: string;
  code: OpErrorCode;
  message?: string;
}

export interface SyncReport {
  /** Records received (pull pages + conflict `current`s). */
  pulled: number;
  /** Local writes caused by remote records. */
  applied: number;
  /** Ops acknowledged as applied by the server. */
  pushed: number;
  conflicts: number;
  /** Push rounds beyond the first (≤ maxRepushRounds). */
  repushRounds: number;
  rejected: RejectedOp[];
  /** A 410 CURSOR_EXPIRED triggered a full rebuild. */
  rebuilt: boolean;
  /** Cards whose ReviewEvents or Vocabulary changed remotely (passed to onEventsApplied). */
  replayedCards: string[];
}

export interface SyncEngineOptions {
  transport: SyncTransport;
  store: LocalStore;
  /** Server-issued device id (token response); otherwise read from / generated into meta. */
  deviceId?: string;
  now?: () => number;
  newId?: () => string;
  pullLimit?: number;
  pushBatchSize?: number;
  /** Spec §5.2: at most 2 re-push rounds per cycle. */
  maxRepushRounds?: number;
  /**
   * Called with every card whose history may have changed. Default: `engine.replayCards(cardIds)`,
   * which recomputes SRS fields from ReviewEvents and stores them without marking the card dirty.
   */
  onEventsApplied?: (cardIds: string[], engine: SyncEngine) => Promise<void>;
  /** Replay start state for a card (SM-2 seed). Default: brand-new card. */
  replayInitial?: (vocabulary: LocalRecord) => ReplayInitial | null;
  /** Fallbacks for legacy events without dateLocal / desiredRetention. */
  replayOptions?: ScheduleOptions;
  /** FK readiness (spec §2.3). false → queued in `store.pendingRemote` and retried next sync. */
  isReady?: (record: SyncRecord, store: LocalStore) => Promise<boolean>;
  /** Tombstone an Article's Segments / LyricsMeta / BookChapter with it (spec §4.2). Default true. */
  cascadeArticleDeletes?: boolean;
  onDiagnostic?: (d: SyncDiagnostic) => void;
}

const key = (type: string, id: string) => `${type}\u0000${id}`;

function byMergeOrder<T extends { type: RecordType }>(items: T[]): T[] {
  // Array.prototype.sort is stable: rev order within a type is kept.
  return [...items].sort((a, b) => mergeOrder(a.type) - mergeOrder(b.type));
}

function hexNode(deviceId: string): string {
  const node = nodeIdFromDevice(deviceId);
  if (/^[0-9a-f]{8}$/.test(node)) return node;
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function lowerString(value: unknown): string | null {
  return typeof value === "string" && value ? canonicalId(value) : null;
}

export class SyncEngine {
  private readonly transport: SyncTransport;
  readonly store: LocalStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly pullLimit: number;
  private readonly pushBatchSize: number;
  private readonly maxRepushRounds: number;
  private readonly opts: SyncEngineOptions;
  private clock: HybridClock | null = null;
  private deviceIdValue: string | null;
  private running: Promise<SyncReport> | null = null;

  constructor(opts: SyncEngineOptions) {
    this.opts = opts;
    this.transport = opts.transport;
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.pullLimit = opts.pullLimit ?? DEFAULT_PULL_LIMIT;
    this.pushBatchSize = Math.min(opts.pushBatchSize ?? MAX_PUSH_OPS, MAX_PUSH_OPS);
    this.maxRepushRounds = opts.maxRepushRounds ?? 2;
    this.deviceIdValue = opts.deviceId ?? null;
  }

  // ---- setup --------------------------------------------------------------

  private async ready(): Promise<HybridClock> {
    if (this.clock) return this.clock;
    let deviceId = this.deviceIdValue ?? (await this.store.getMeta(META_DEVICE_ID));
    if (!deviceId) deviceId = this.newId();
    deviceId = canonicalId(deviceId);
    if ((await this.store.getMeta(META_DEVICE_ID)) !== deviceId) await this.store.setMeta(META_DEVICE_ID, deviceId);
    this.deviceIdValue = deviceId;
    const saved = await this.store.getMeta(META_HLC);
    this.clock = new HybridClock(hexNode(deviceId), saved && isValidHlc(saved) ? saved : null, this.now);
    return this.clock;
  }

  async deviceId(): Promise<string> {
    await this.ready();
    return this.deviceIdValue!;
  }

  private async saveClock(): Promise<void> {
    if (this.clock) await this.store.setMeta(META_HLC, this.clock.current());
  }

  private tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.store.transaction ? this.store.transaction(fn) : fn();
  }

  // ---- local writes -------------------------------------------------------

  /** Record a local create/update/delete: ticks the HLC and marks the record dirty. */
  async recordLocalChange(type: RecordType, id: string, change: LocalChange): Promise<LocalRecord> {
    const clock = await this.ready();
    if (!isRecordType(type)) throw new Error(`unknown record type: ${String(type)}`);
    const rid = canonicalId(id);
    const deleted = change.deleted === true;
    const existing = await this.store.getRecord(type, rid);
    if (type === "ReviewEvent" && (deleted || (existing && !existing.deleted))) {
      throw new Error("IMMUTABLE: ReviewEvents are append-only; void one with a new event (voidsEventId)");
    }
    if (!deleted && (!change.payload || typeof change.payload !== "object")) throw new Error("payload required");

    const record: LocalRecord = {
      type,
      id: rid,
      rev: existing?.rev ?? 0,
      hlc: clock.tick(),
      deleted,
      payload: deleted ? null : change.payload!,
      dirty: true,
      opId: this.newId(),
    };
    await this.tx(async () => {
      await this.store.putRecord(record);
      if (deleted && type === "Article" && this.opts.cascadeArticleDeletes !== false) await this.cascadeArticleDelete(rid);
      await this.saveClock();
    });
    return record;
  }

  private async cascadeArticleDelete(articleId: string): Promise<void> {
    const clock = this.clock!;
    const tombstone = (r: LocalRecord): LocalRecord => ({ ...r, deleted: true, payload: null, hlc: clock.tick(), dirty: true, opId: this.newId() });
    for (const seg of await this.store.listByType("Segment")) {
      if (!seg.deleted && lowerString(seg.payload?.articleId) === articleId) await this.store.putRecord(tombstone(seg));
    }
    for (const type of ["LyricsMeta", "BookChapter"] as const) {
      const r = await this.store.getRecord(type, articleId);
      if (r && !r.deleted) await this.store.putRecord(tombstone(r));
    }
  }

  // ---- sync ---------------------------------------------------------------

  /** One sync cycle (single-flight: concurrent callers share the running cycle). */
  sync(): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.runCycle(false).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** Spec §8 fullRebuild(), then a normal push. */
  async fullRebuild(): Promise<SyncReport> {
    while (this.running) await this.running.catch(() => undefined);
    this.running = this.runCycle(true).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runCycle(rebuild: boolean): Promise<SyncReport> {
    await this.ready();
    const report: SyncReport = { pulled: 0, applied: 0, pushed: 0, conflicts: 0, repushRounds: 0, rejected: [], rebuilt: false, replayedCards: [] };
    const cards = new Set<string>();

    if (rebuild) {
      await this.rebuild(report, cards);
    } else {
      try {
        await this.pullAll(report, cards);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 410)) throw err;
        await this.rebuild(report, cards);
      }
    }
    await this.pushAll(report, cards);
    await this.saveClock();

    report.replayedCards = [...cards].sort();
    if (cards.size) {
      if (this.opts.onEventsApplied) await this.opts.onEventsApplied(report.replayedCards, this);
      else await this.replayCards(report.replayedCards);
    }
    return report;
  }

  private async rebuild(report: SyncReport, cards: Set<string>): Promise<void> {
    report.rebuilt = true;
    await this.store.setMeta(META_CURSOR, null);
    const seen = new Set<string>();
    await this.pullAll(report, cards, seen);
    // Local live records the server no longer knows → treat as new.
    for (const type of RECORD_TYPES) {
      for (const r of await this.store.listByType(type)) {
        if (seen.has(key(r.type, r.id)) || r.deleted) continue;
        if (type === "WordPack" && r.payload?.isSystem === true) continue;
        await this.store.putRecord({ ...r, rev: 0, dirty: true, opId: this.newId() });
      }
    }
  }

  private async pullAll(report: SyncReport, cards: Set<string>, seen?: Set<string>): Promise<void> {
    const pending = this.store.pendingRemote ? await this.store.pendingRemote.takeAll() : [];
    if (pending.length) await this.tx(() => this.applyBatch(pending, report, cards));

    let cursor = await this.store.getMeta(META_CURSOR);
    for (;;) {
      const page = await this.transport.pull(cursor, { limit: this.pullLimit });
      report.pulled += page.records.length;
      await this.tx(async () => {
        await this.applyBatch(page.records, report, cards, seen);
        await this.store.setMeta(META_CURSOR, page.cursor);
        await this.saveClock();
      });
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
  }

  /** Apply remote records in mergeOrder (spec §2.3). */
  private async applyBatch(records: SyncRecord[], report: SyncReport, cards: Set<string>, seen?: Set<string>): Promise<void> {
    const known: SyncRecord[] = [];
    for (const r of records) {
      if (!isRecordType(r.type)) {
        this.diag("unknown-type", r, "skipped record of unknown type");
        continue;
      }
      known.push(r);
    }
    const segmentRevisions = new SegmentRevisionCache(this.store);
    const deferred: SyncRecord[] = [];
    for (const remote of byMergeOrder(known)) {
      seen?.add(key(remote.type, canonicalId(remote.id)));
      if (!(await this.acceptClock(remote))) continue;
      if (this.opts.isReady && !(await this.opts.isReady(remote, this.store))) {
        if (this.store.pendingRemote) {
          deferred.push(remote);
          this.diag("deferred", remote, "foreign key not ready; queued");
          continue;
        }
      }
      await this.applyRemote(remote, report, cards, segmentRevisions);
    }
    if (deferred.length) await this.store.pendingRemote!.add(deferred);
  }

  /** HLC receive + 24 h skew guard (spec §3). */
  private async acceptClock(remote: SyncRecord): Promise<boolean> {
    if (!isValidHlc(remote.hlc)) {
      this.diag("invalid-hlc", remote, `invalid hlc ${remote.hlc}`);
      return false;
    }
    if (parseHlc(remote.hlc).wall > this.now() + MAX_CLOCK_SKEW_MS) {
      this.diag("clock-skew", remote, `remote hlc ${remote.hlc} is more than 24h ahead`);
      return false;
    }
    this.clock!.receive(remote.hlc);
    return true;
  }

  private async applyRemote(remote: SyncRecord, report: SyncReport, cards: Set<string>, segments?: SegmentRevisionCache): Promise<MergeDecision> {
    const id = canonicalId(remote.id);
    const local = await this.store.getRecord(remote.type, id);
    const ctx: { localSegmentRevision?: number } = {};
    if (remote.type === "Segment" && !remote.deleted) {
      const articleId = lowerString(remote.payload?.articleId);
      if (articleId) ctx.localSegmentRevision = await (segments ?? new SegmentRevisionCache(this.store)).get(articleId);
    }
    const decision = mergeRemote(local, remote, ctx);
    if (!decision.record) return decision;

    let record = decision.record;
    if (decision.retick) record = { ...record, hlc: this.clock!.tick() };
    if (record.dirty) record = { ...record, opId: this.newId() };
    await this.store.putRecord(record);
    report.applied += 1;

    if (decision.purgeSegmentsBelow) await this.purgeSegments(decision.purgeSegmentsBelow.articleId, decision.purgeSegmentsBelow.revision, id);
    if (segments && record.type === "Segment") segments.update(record, !!decision.purgeSegmentsBelow);

    if (decision.outcome === "remote" || decision.outcome === "merged") {
      if (record.type === "ReviewEvent") {
        const cardId = lowerString(record.payload?.vocabularyId);
        if (cardId) cards.add(cardId);
      } else if (record.type === "Vocabulary" && !record.deleted) {
        // Remote payload SRS fields never override the local replay (spec §6).
        cards.add(record.id);
      }
    }
    return decision;
  }

  /** §4.3: remote re-segmentation replaces all local segments of that article. */
  private async purgeSegments(articleId: string, revision: number, keepId: string): Promise<void> {
    for (const seg of await this.store.listByType("Segment")) {
      if (seg.deleted || seg.id === keepId || lowerString(seg.payload?.articleId) !== articleId) continue;
      if (segmentRevisionOf(seg.payload) >= revision) continue;
      // Local-only removal: the re-segmenting device pushes the tombstones.
      await this.store.putRecord({ ...seg, deleted: true, payload: null, dirty: false, opId: null });
    }
  }

  private async pushAll(report: SyncReport, cards: Set<string>): Promise<void> {
    const deviceId = this.deviceIdValue!;
    const skip = new Set<string>();
    for (let round = 0; ; round++) {
      const dirty = (await this.store.dirtyRecords()).filter((r) => !skip.has(key(r.type, r.id)));
      if (!dirty.length) break;
      if (round > 0) report.repushRounds += 1;
      let conflicts = 0;
      const batch: LocalRecord[] = [];
      for (const r of byMergeOrder(dirty)) {
        if (r.type === "WordPack" && r.payload?.isSystem === true) {
          // System packs are never uploaded (spec §2.2).
          await this.store.putRecord({ ...r, dirty: false, opId: null });
          continue;
        }
        if (!r.opId) {
          r.opId = this.newId();
          await this.store.putRecord(r);
        }
        batch.push(r);
      }

      for (let i = 0; i < batch.length; i += this.pushBatchSize) {
        const chunk = batch.slice(i, i + this.pushBatchSize);
        const ops: PushOp[] = chunk.map((r) => ({
          opId: r.opId!,
          type: r.type,
          id: r.id,
          baseRev: r.rev,
          hlc: r.hlc,
          deleted: r.deleted,
          ...(r.deleted ? {} : { payload: r.payload }),
        }));
        const res = await this.transport.push({ deviceId, ops });
        const byOpId = new Map(res.results.map((x) => [x.opId, x]));
        for (const op of ops) {
          const result = byOpId.get(op.opId);
          if (!result) continue;
          if (result.status === "applied") {
            report.pushed += 1;
            const cur = await this.store.getRecord(op.type, op.id);
            if (!cur) continue;
            // A newer local edit made during the push stays dirty, rebased on the new rev.
            await this.store.putRecord(cur.hlc === op.hlc ? { ...cur, rev: result.rev, dirty: false, opId: null } : { ...cur, rev: result.rev });
          } else if (result.status === "conflict") {
            conflicts += 1;
            report.conflicts += 1;
            report.pulled += 1;
            if (await this.acceptClock(result.current)) await this.applyRemote(result.current, report, cards);
            const cur = await this.store.getRecord(op.type, op.id);
            if (cur?.dirty) {
              // Still ours to push: rebase on the server's rev with a fresh opId (the old one is cached as a conflict).
              await this.store.putRecord({ ...cur, rev: Math.max(cur.rev, result.current.rev), opId: this.newId() });
            }
          } else {
            skip.add(key(op.type, op.id));
            report.rejected.push({ type: op.type, id: op.id, code: result.code, ...(result.message ? { message: result.message } : {}) });
            this.diag("rejected", op, `${result.code}${result.message ? `: ${result.message}` : ""}`);
            // Keep the data dirty for a later cycle; a fresh opId so the retry is evaluated again.
            const cur = await this.store.getRecord(op.type, op.id);
            if (cur?.dirty && cur.opId === op.opId) await this.store.putRecord({ ...cur, opId: this.newId() });
          }
        }
      }
      if (conflicts === 0 || round >= this.maxRepushRounds) break;
    }
  }

  // ---- replay -------------------------------------------------------------

  /** Recompute SRS fields of these cards from their ReviewEvents (spec §6). Not marked dirty. */
  async replayCards(cardIds: readonly string[]): Promise<string[]> {
    const wanted = new Set(cardIds.map(canonicalId));
    if (!wanted.size) return [];
    const eventsByCard = new Map<string, NonNullable<ReturnType<typeof replayEventFromRecord>>[]>();
    for (const r of await this.store.listByType("ReviewEvent")) {
      if (r.deleted) continue;
      const cardId = lowerString(r.payload?.vocabularyId);
      if (!cardId || !wanted.has(cardId)) continue;
      const ev = replayEventFromRecord(r);
      if (!ev) continue;
      const list = eventsByCard.get(cardId) ?? [];
      list.push(ev);
      eventsByCard.set(cardId, list);
    }
    const updated: string[] = [];
    for (const cardId of wanted) {
      const events = eventsByCard.get(cardId);
      if (!events?.length) continue;
      const card = await this.store.getRecord("Vocabulary", cardId);
      if (!card || card.deleted || !card.payload) continue;
      const result = replayEvents(this.opts.replayInitial?.(card) ?? null, events, this.opts.replayOptions);
      const payload = applyReplayToPayload(card.payload, result);
      if (!payload) continue;
      await this.store.putRecord({ ...card, payload });
      updated.push(cardId);
    }
    return updated;
  }

  private diag(kind: SyncDiagnostic["kind"], r: { type: string; id: string }, message: string): void {
    this.opts.onDiagnostic?.({ kind, type: r.type, id: r.id, message });
  }
}

/** Max live segmentationRevision per article, computed once per batch. */
class SegmentRevisionCache {
  private map: Map<string, number> | null = null;
  constructor(private readonly store: LocalStore) {}

  private async load(): Promise<Map<string, number>> {
    if (this.map) return this.map;
    const map = new Map<string, number>();
    for (const seg of await this.store.listByType("Segment")) this.add(map, seg);
    this.map = map;
    return map;
  }

  private add(map: Map<string, number>, seg: LocalRecord): void {
    if (seg.deleted) return;
    const articleId = lowerString(seg.payload?.articleId);
    if (!articleId) return;
    map.set(articleId, Math.max(map.get(articleId) ?? -Infinity, segmentRevisionOf(seg.payload)));
  }

  async get(articleId: string): Promise<number | undefined> {
    return (await this.load()).get(articleId);
  }

  /** Track a write; deletions / purges may lower the max, so those force a reload. */
  update(seg: LocalRecord, purged = false): void {
    if (!this.map) return;
    if (purged || seg.deleted) this.map = null;
    else this.add(this.map, seg);
  }
}
