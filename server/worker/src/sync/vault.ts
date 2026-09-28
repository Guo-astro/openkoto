import { DurableObject } from "cloudflare:workers";
import {
  canonicalId,
  compareHlc,
  decodeCursor,
  encodeCursor,
  HybridClock,
  IMMUTABLE_TYPES,
  INLINE_PAYLOAD_LIMIT,
  isRecordType,
  isValidHlc,
  MAX_CLOCK_SKEW_MS,
  parseHlc,
  PLAN_LIMITS,
  TOMBSTONE_RETENTION_DAYS,
  type JsonObject,
  type OpErrorCode,
  type Plan,
  type PushOp,
  type PushResult,
  type RecordType,
  type SyncRecord,
  type SyncStats,
} from "@openkoto/core";
import type { Env } from "../env";

const DAY_MS = 24 * 60 * 60 * 1000;
const APPLIED_OP_RETENTION_MS = 30 * DAY_MS;
const PULL_BYTE_BUDGET = 4 * 1024 * 1024;
const SERVER_NODE = "ffffffff";
const FREE_CHAPTERS_PER_BOOK = 600;

interface RecordRow {
  type: string;
  id: string;
  rev: number;
  hlc: string;
  device_id: string;
  deleted: number;
  payload: string | null;
  blob_key: string | null;
  size: number;
  cls: string | null;
  file_bytes: number;
  [key: string]: SqlStorageValue;
}

export interface VaultRecord extends SyncRecord {
  blobKey?: string;
}

export interface PullArgs {
  cursor: string | null;
  limit: number;
  types?: RecordType[];
}

export interface PullResult {
  records: VaultRecord[];
  cursor: string;
  hasMore: boolean;
}

export class CursorExpiredError extends Error {
  constructor() {
    super("CURSOR_EXPIRED");
  }
}

export interface ServerWrite {
  type: RecordType;
  id: string;
  deleted?: boolean;
  payload?: JsonObject | null;
}

/** Quota class of a record, derived from its payload. */
function classify(type: string, payload: JsonObject | null): string | null {
  if (!payload) return null;
  if (type === "Article") return payload.sourceType === "lyrics" ? "lyrics" : payload.sourceType === "book" ? "chapter" : "article";
  return null;
}

function fileBytes(type: string, payload: JsonObject | null): number {
  if (type !== "Book" || !payload) return 0;
  const size = Number(payload.fileSize ?? 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function rowToRecord(row: RecordRow): VaultRecord {
  const record: VaultRecord = {
    type: row.type as RecordType,
    id: row.id,
    rev: row.rev,
    hlc: row.hlc,
    deviceId: row.device_id,
    deleted: row.deleted === 1,
    payload: row.payload ? (JSON.parse(row.payload) as JsonObject) : null,
  };
  if (row.blob_key) record.blobKey = row.blob_key;
  return record;
}

export class UserVault extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private clock: HybridClock;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      create table if not exists record (
        type text not null,
        id text not null,
        rev integer not null,
        hlc text not null,
        device_id text not null,
        deleted integer not null default 0,
        payload text,
        blob_key text,
        size integer not null default 0,
        cls text,
        file_bytes integer not null default 0,
        deleted_at integer,
        primary key (type, id)
      );
      create index if not exists record_rev on record (rev);
      create index if not exists record_type_cls on record (type, cls, deleted);
      create table if not exists applied_op (op_id text primary key, result text not null, applied_at integer not null);
      create table if not exists meta (k text primary key, v text not null);
    `);
    this.clock = new HybridClock(SERVER_NODE, this.meta("server_hlc"));
  }

  private meta(key: string): string | null {
    const row = this.sql.exec<{ v: string }>("select v from meta where k = ?", key).toArray()[0];
    return row?.v ?? null;
  }

  private setMeta(key: string, value: string | number): void {
    this.sql.exec("insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v", key, String(value));
  }

  private seq(): number {
    return Number(this.meta("seq") ?? 0);
  }

  private nextRev(): number {
    const rev = this.seq() + 1;
    this.setMeta("seq", rev);
    return rev;
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }

  // ---- pull -------------------------------------------------------------

  async pull(args: PullArgs): Promise<PullResult> {
    const after = decodeCursor(args.cursor);
    const floor = Number(this.meta("tombstone_floor") ?? 0);
    if (after > 0 && after < floor) throw new CursorExpiredError();

    const limit = Math.max(1, Math.min(args.limit, 1000));
    const types = args.types?.length ? args.types : null;
    const placeholders = types ? ` and type in (${types.map(() => "?").join(",")})` : "";
    const rows = this.sql
      .exec<RecordRow>(`select * from record where rev > ?${placeholders} order by rev limit ?`, after, ...(types ?? []), limit + 1)
      .toArray();

    const records: VaultRecord[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      if (records.length > 0 && bytes + row.size > PULL_BYTE_BUDGET) break;
      bytes += row.size;
      records.push(rowToRecord(row));
    }
    const hasMore = records.length < rows.length;
    const last = records.at(-1);
    const cursor = hasMore ? last!.rev : Math.max(after, this.seq());
    return { records, cursor: encodeCursor(cursor), hasMore };
  }

  // ---- push -------------------------------------------------------------

  async push(deviceId: string, ops: PushOp[], plan: Plan, now = Date.now()): Promise<{ results: PushResult[]; cursor: string }> {
    const results: PushResult[] = [];
    const before = this.seq();
    this.ctx.storage.transactionSync(() => {
      for (const op of ops) results.push(this.applyOp(deviceId, op, plan, now));
    });
    this.setMeta("server_hlc", this.clock.current());
    await this.ensureAlarm();
    if (this.seq() > before) this.notify(deviceId);
    return { results, cursor: encodeCursor(this.seq()) };
  }

  // ---- realtime change notifications (hibernatable WebSockets) ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const deviceId = request.headers.get("X-OpenKoto-Device") ?? "unknown";
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [deviceId]);
    pair[1].send(JSON.stringify({ type: "hello", rev: this.seq() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Tells every other connected device that new revisions exist; they respond by pulling. */
  private notify(sourceDeviceId: string): void {
    const message = JSON.stringify({ type: "changed", rev: this.seq() });
    for (const ws of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(ws).includes(sourceDeviceId)) continue;
      try {
        ws.send(message);
      } catch {
        // Socket already closing; the client re-syncs on reconnect.
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code === 1005 ? 1000 : code, "closing");
  }

  private rejected(op: PushOp, code: OpErrorCode, message?: string): PushResult {
    return { opId: op.opId, status: "rejected", code, ...(message ? { message } : {}) };
  }

  private applyOp(deviceId: string, op: PushOp, plan: Plan, now: number): PushResult {
    const previous = this.sql.exec<{ result: string }>("select result from applied_op where op_id = ?", op.opId).toArray()[0];
    if (previous) return JSON.parse(previous.result) as PushResult;
    const result = this.evaluateOp(deviceId, op, plan, now);
    this.sql.exec("insert into applied_op (op_id, result, applied_at) values (?, ?, ?)", op.opId, JSON.stringify(result), now);
    return result;
  }

  private evaluateOp(deviceId: string, op: PushOp, plan: Plan, now: number): PushResult {
    if (typeof op.opId !== "string" || !op.opId) return this.rejected(op, "INVALID_PAYLOAD", "opId is required");
    if (!isRecordType(op.type)) return this.rejected(op, "UNKNOWN_TYPE");
    if (typeof op.id !== "string" || !op.id || op.id.length > 200) return this.rejected(op, "INVALID_PAYLOAD", "invalid id");
    if (!isValidHlc(op.hlc)) return this.rejected(op, "INVALID_PAYLOAD", "invalid hlc");
    if (parseHlc(op.hlc).wall > now + MAX_CLOCK_SKEW_MS) return this.rejected(op, "CLOCK_SKEW");

    const deleted = op.deleted === true;
    let payloadText: string | null = null;
    let payloadBytes = 0;
    let payload: JsonObject | null = null;
    if (!deleted) {
      if (op.blobKey) {
        const size = (op as PushOp & { blobSize?: number }).blobSize;
        if (!/^[A-Za-z]+\/[A-Za-z0-9_.:-]{1,200}\/[0-9a-f]{64}$/.test(op.blobKey) || !op.blobKey.startsWith(`${op.type}/`) || typeof size !== "number") {
          return this.rejected(op, "INVALID_PAYLOAD", "invalid blobKey");
        }
        payloadBytes = size;
      } else {
        if (!op.payload || typeof op.payload !== "object" || Array.isArray(op.payload)) {
          return this.rejected(op, "INVALID_PAYLOAD", "payload must be an object");
        }
        payloadText = JSON.stringify(op.payload);
        payloadBytes = utf8Length(payloadText);
        if (payloadBytes > INLINE_PAYLOAD_LIMIT) return this.rejected(op, "PAYLOAD_TOO_LARGE");
        payload = op.payload;
      }
    }

    const id = canonicalId(op.id);
    const existing = this.sql.exec<RecordRow>("select * from record where type = ? and id = ?", op.type, id).toArray()[0];

    if (IMMUTABLE_TYPES.has(op.type)) {
      if (deleted) return this.rejected(op, "IMMUTABLE");
      if (existing) return { opId: op.opId, status: "applied", rev: existing.rev };
    }

    const wins = !existing || existing.rev === op.baseRev || compareHlc(op.hlc, existing.hlc) > 0;
    if (!wins) return { opId: op.opId, status: "conflict", rev: existing.rev, current: rowToRecord(existing) };

    // Changing an article's class (e.g. chapter → lyrics) is checked like a new record.
    const creating = !deleted && (!existing || existing.deleted === 1 || (op.type === "Article" && existing.cls !== classify(op.type, payload)));
    const cls = classify(op.type, payload);
    const bytes = fileBytes(op.type, payload);
    if (!deleted) {
      const quota = this.checkQuota(op.type, cls, bytes, existing, creating, plan);
      if (quota) return this.rejected(op, "QUOTA_EXCEEDED", quota);
    }

    this.clock.receive(op.hlc);
    const rev = this.nextRev();
    this.sql.exec(
      `insert into record (type, id, rev, hlc, device_id, deleted, payload, blob_key, size, cls, file_bytes, deleted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (type, id) do update set rev = excluded.rev, hlc = excluded.hlc, device_id = excluded.device_id,
         deleted = excluded.deleted, payload = excluded.payload, blob_key = excluded.blob_key, size = excluded.size,
         cls = excluded.cls, file_bytes = excluded.file_bytes, deleted_at = excluded.deleted_at`,
      op.type,
      id,
      rev,
      op.hlc,
      deviceId,
      deleted ? 1 : 0,
      payloadText,
      deleted ? null : (op.blobKey ?? null),
      payloadBytes,
      cls,
      bytes,
      deleted ? now : null,
    );
    return { opId: op.opId, status: "applied", rev };
  }

  private count(sql: string, ...bindings: SqlStorageValue[]): number {
    return Number(this.sql.exec<{ n: number }>(sql, ...bindings).toArray()[0]?.n ?? 0);
  }

  private usage() {
    return {
      vocabulary: this.count("select count(*) as n from record where type = 'Vocabulary' and deleted = 0"),
      books: this.count("select count(*) as n from record where type = 'Book' and deleted = 0"),
      lyrics: this.count("select count(*) as n from record where type = 'Article' and cls = 'lyrics' and deleted = 0"),
      articles: this.count("select count(*) as n from record where type = 'Article' and cls = 'article' and deleted = 0"),
      chapters: this.count("select count(*) as n from record where type = 'Article' and cls = 'chapter' and deleted = 0"),
      fileBytes: this.count("select coalesce(sum(file_bytes), 0) as n from record where type = 'Book' and deleted = 0"),
    };
  }

  private checkQuota(type: RecordType, cls: string | null, bytes: number, existing: RecordRow | undefined, creating: boolean, plan: Plan): string | null {
    const limits = PLAN_LIMITS[plan];
    if (type === "Book") {
      if (bytes > limits.bookFileBytes) return "book file too large for plan";
      const previousBytes = existing && existing.deleted === 0 ? existing.file_bytes : 0;
      if (this.usage().fileBytes - previousBytes + bytes > limits.fileBytesTotal) return "storage quota exceeded";
    }
    if (!creating) return null;
    if (limits.vocabulary === null && limits.books === null && limits.lyrics === null && limits.articles === null) return null;
    const usage = this.usage();
    if (type === "Vocabulary" && limits.vocabulary !== null && usage.vocabulary >= limits.vocabulary) return "vocabulary limit reached";
    if (type === "Book" && limits.books !== null && usage.books >= limits.books) return "book limit reached";
    if (type === "Article" && cls === "lyrics" && limits.lyrics !== null && usage.lyrics >= limits.lyrics) return "lyrics limit reached";
    if (type === "Article" && cls === "article" && limits.articles !== null && usage.articles >= limits.articles) return "article limit reached";
    // Book chapters aren't counted as articles, but can't be an unlimited side door either.
    if (type === "Article" && cls === "chapter" && limits.books !== null && usage.chapters >= limits.books * FREE_CHAPTERS_PER_BOOK) return "chapter limit reached";
    return null;
  }

  // ---- server-side writes (CLI / MCP / AI jobs) -------------------------

  async writeAsServer(writes: ServerWrite[], plan: Plan): Promise<PushResult[]> {
    const ops: PushOp[] = writes.map((w) => {
      const id = canonicalId(w.id);
      const existing = this.sql.exec<{ rev: number }>("select rev from record where type = ? and id = ?", w.type, id).toArray()[0];
      return {
        opId: crypto.randomUUID(),
        type: w.type,
        id,
        baseRev: existing?.rev ?? 0,
        hlc: this.clock.tick(),
        deleted: w.deleted === true,
        payload: w.payload ?? null,
      };
    });
    return (await this.push("server", ops, plan)).results;
  }

  async get(type: RecordType, id: string): Promise<VaultRecord | null> {
    const row = this.sql.exec<RecordRow>("select * from record where type = ? and id = ?", type, canonicalId(id)).toArray()[0];
    return row ? rowToRecord(row) : null;
  }

  async list(type: RecordType, opts: { limit?: number; offset?: number; includeDeleted?: boolean; cls?: string } = {}): Promise<VaultRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const where = ["type = ?"];
    const bindings: SqlStorageValue[] = [type];
    if (!opts.includeDeleted) where.push("deleted = 0");
    if (opts.cls) {
      where.push("cls = ?");
      bindings.push(opts.cls);
    }
    return this.sql
      .exec<RecordRow>(`select * from record where ${where.join(" and ")} order by rev desc limit ? offset ?`, ...bindings, limit, opts.offset ?? 0)
      .toArray()
      .map(rowToRecord);
  }

  /** Records whose payload field equals a value, e.g. segments of an article. */
  async listByField(type: RecordType, field: string, value: string, limit = 5000): Promise<VaultRecord[]> {
    if (!/^[A-Za-z0-9_]+$/.test(field)) throw new Error("invalid field");
    return this.sql
      .exec<RecordRow>(
        `select * from record where type = ? and deleted = 0 and lower(json_extract(payload, '$.${field}')) = lower(?) limit ?`,
        type,
        value,
        limit,
      )
      .toArray()
      .map(rowToRecord);
  }

  // ---- stats / maintenance ----------------------------------------------

  async stats(plan: Plan): Promise<SyncStats> {
    const counts: SyncStats["counts"] = {};
    for (const row of this.sql.exec<{ type: string; n: number }>("select type, count(*) as n from record where deleted = 0 group by type")) {
      counts[row.type as RecordType] = Number(row.n);
    }
    const bytes = this.count("select coalesce(sum(size), 0) as n from record");
    return { counts, bytes, blobBytes: 0, plan, limits: PLAN_LIMITS[plan], usage: this.usage() };
  }

  async blobKeys(): Promise<string[]> {
    return this.sql
      .exec<{ blob_key: string }>("select blob_key from record where blob_key is not null")
      .toArray()
      .map((r) => r.blob_key);
  }

  async purge(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const cutoff = now - TOMBSTONE_RETENTION_DAYS * DAY_MS;
    const expired = this.sql
      .exec<{ rev: number }>("select coalesce(max(rev), 0) as rev from record where deleted = 1 and deleted_at < ?", cutoff)
      .toArray()[0];
    if (expired && expired.rev > 0) {
      this.sql.exec("delete from record where deleted = 1 and deleted_at < ?", cutoff);
      const floor = Math.max(Number(this.meta("tombstone_floor") ?? 0), expired.rev);
      this.setMeta("tombstone_floor", floor);
    }
    this.sql.exec("delete from applied_op where applied_at < ?", now - APPLIED_OP_RETENTION_MS);
    await this.ctx.storage.setAlarm(now + DAY_MS);
  }
}
