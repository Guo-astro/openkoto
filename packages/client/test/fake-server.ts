// In-memory stand-in for server/worker/src/sync/vault.ts (same push/pull semantics, no quota/blob).

import {
  IMMUTABLE_TYPES,
  MAX_CLOCK_SKEW_MS,
  canonicalId,
  compareHlc,
  decodeCursor,
  encodeCursor,
  isRecordType,
  isValidHlc,
  parseHlc,
  type OpErrorCode,
  type PullResponse,
  type PushOp,
  type PushRequest,
  type PushResponse,
  type PushResult,
  type SyncRecord,
} from "@openkoto/core";
import { ApiError, type PullOptions, type SyncTransport } from "../src/api";

const clone = <T>(v: T): T => structuredClone(v);

export class FakeServer {
  private readonly records = new Map<string, SyncRecord>();
  private readonly appliedOps = new Map<string, PushResult>();
  private seq = 0;
  private tombstoneFloor = 0;
  readonly log: { pulls: number; pushes: number; ops: number } = { pulls: 0, pushes: 0, ops: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  /** Transport bound to one device (the JWT `did`). */
  transport(deviceId: string): SyncTransport {
    return {
      pull: async (cursor, opts) => clone(this.pull(cursor, opts)),
      push: async (req) => clone(this.push(deviceId, clone(req))),
    };
  }

  pull(cursor: string | null, opts: PullOptions = {}): PullResponse {
    this.log.pulls += 1;
    const after = decodeCursor(cursor);
    if (after > 0 && after < this.tombstoneFloor) throw new ApiError(410, "CURSOR_EXPIRED", "cursor expired, full resync required");
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 1000));
    const rows = [...this.records.values()]
      .filter((r) => r.rev > after && (!opts.types?.length || opts.types.includes(r.type)))
      .sort((a, b) => a.rev - b.rev);
    const records = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const next = hasMore ? records.at(-1)!.rev : Math.max(after, this.seq);
    return { records, cursor: encodeCursor(next), hasMore, serverTime: new Date(this.now()).toISOString() };
  }

  push(deviceId: string, req: PushRequest): PushResponse {
    this.log.pushes += 1;
    const results = req.ops.map((op) => {
      this.log.ops += 1;
      const previous = this.appliedOps.get(op.opId);
      if (previous) return previous;
      const result = this.evaluate(deviceId, op);
      this.appliedOps.set(op.opId, result);
      return result;
    });
    return { results, cursor: encodeCursor(this.seq) };
  }

  private rejected(op: PushOp, code: OpErrorCode, message?: string): PushResult {
    return { opId: op.opId, status: "rejected", code, ...(message ? { message } : {}) };
  }

  private evaluate(deviceId: string, op: PushOp): PushResult {
    if (!isRecordType(op.type)) return this.rejected(op, "UNKNOWN_TYPE");
    if (!isValidHlc(op.hlc)) return this.rejected(op, "INVALID_PAYLOAD", "invalid hlc");
    if (parseHlc(op.hlc).wall > this.now() + MAX_CLOCK_SKEW_MS) return this.rejected(op, "CLOCK_SKEW");
    const deleted = op.deleted === true;
    if (!deleted && (!op.payload || typeof op.payload !== "object")) return this.rejected(op, "INVALID_PAYLOAD");

    const id = canonicalId(op.id);
    const k = `${op.type}/${id}`;
    const existing = this.records.get(k);
    if (IMMUTABLE_TYPES.has(op.type)) {
      if (deleted) return this.rejected(op, "IMMUTABLE");
      if (existing) return { opId: op.opId, status: "applied", rev: existing.rev };
    }
    const wins = !existing || existing.rev === op.baseRev || compareHlc(op.hlc, existing.hlc) > 0;
    if (!wins) return { opId: op.opId, status: "conflict", rev: existing.rev, current: clone(existing) };

    const rev = ++this.seq;
    this.records.set(k, { type: op.type, id, rev, hlc: op.hlc, deviceId, deleted, payload: deleted ? null : clone(op.payload!) });
    return { opId: op.opId, status: "applied", rev };
  }

  get(type: string, id: string): SyncRecord | undefined {
    return this.records.get(`${type}/${canonicalId(id)}`);
  }

  all(): SyncRecord[] {
    return [...this.records.values()].sort((a, b) => a.rev - b.rev);
  }

  /** Simulate the 180-day tombstone purge: drop tombstones and expire older cursors. */
  purgeTombstones(): void {
    let floor = this.tombstoneFloor;
    for (const [k, r] of this.records) {
      if (r.deleted) {
        floor = Math.max(floor, r.rev);
        this.records.delete(k);
      }
    }
    this.tombstoneFloor = floor;
  }

  /** Server-side write (CLI / MCP) using a server clock HLC. */
  writeAsServer(type: SyncRecord["type"], id: string, payload: SyncRecord["payload"], hlc: string): PushResult {
    const existing = this.get(type, id);
    return this.push("server", { deviceId: "server", ops: [{ opId: crypto.randomUUID(), type, id, baseRev: existing?.rev ?? 0, hlc, deleted: payload === null, payload }] }).results[0]!;
  }
}
