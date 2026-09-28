import Dexie, { type Table } from "dexie";
import type { LocalRecord, LocalStore, PendingRemoteQueue } from "@openkoto/client";
import type { RecordType, SyncRecord } from "@openkoto/core";

interface RecordRow extends LocalRecord {
  /** Dexie can't index booleans; 1 = dirty. */
  dirtyFlag: 0 | 1;
  /** Lowercased parent id (segment → article, chapter → book) for indexed child lookups. */
  parent?: string;
}

interface MetaRow {
  key: string;
  value: string;
}

interface PendingRow {
  seq?: number;
  record: SyncRecord;
}

class LibraryDb extends Dexie {
  records!: Table<RecordRow, [string, string]>;
  meta!: Table<MetaRow, string>;
  pending!: Table<PendingRow, number>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records: "[type+id], type, dirtyFlag",
      meta: "key",
      pending: "++seq",
    });
    this.version(2)
      .stores({ records: "[type+id], type, dirtyFlag, [type+parent]" })
      .upgrade((tx) =>
        tx
          .table<RecordRow>("records")
          .toCollection()
          .modify((row) => {
            const parent = parentOf(row);
            if (parent) row.parent = parent;
          }),
      );
  }
}

function parentOf(record: LocalRecord): string | undefined {
  const p = record.payload;
  const id = p?.articleId ?? p?.bookId;
  return typeof id === "string" && (record.type === "Segment" || record.type === "BookChapter" || record.type === "BookMark") ? id.toLowerCase() : undefined;
}

function toRow(record: LocalRecord): RecordRow {
  const parent = parentOf(record);
  return { ...record, dirtyFlag: record.dirty ? 1 : 0, ...(parent ? { parent } : {}) };
}

function fromRow(row: RecordRow): LocalRecord {
  const { dirtyFlag: _flag, parent: _parent, ...record } = row;
  return record;
}

/** IndexedDB-backed LocalStore; one database per signed-in user so accounts never mix. */
export class IndexedDbStore implements LocalStore {
  readonly db: LibraryDb;
  readonly pendingRemote: PendingRemoteQueue;

  constructor(userId: string) {
    this.db = new LibraryDb(`openkoto-${userId}`);
    const db = this.db;
    this.pendingRemote = {
      async add(records) {
        await db.pending.bulkAdd(records.map((record) => ({ record })));
      },
      async takeAll() {
        return db.transaction("rw", db.pending, async () => {
          const rows = await db.pending.toArray();
          await db.pending.clear();
          return rows.map((r) => r.record);
        });
      },
    };
  }

  async getMeta(key: string): Promise<string | null> {
    return (await this.db.meta.get(key))?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.meta.delete(key);
    else await this.db.meta.put({ key, value });
  }

  async getRecord(type: RecordType, id: string): Promise<LocalRecord | null> {
    const row = await this.db.records.get([type, id]);
    return row ? fromRow(row) : null;
  }

  async putRecord(record: LocalRecord): Promise<void> {
    await this.db.records.put(toRow(record));
  }

  async dirtyRecords(limit?: number): Promise<LocalRecord[]> {
    let query = this.db.records.where("dirtyFlag").equals(1);
    if (limit !== undefined) query = query.limit(limit);
    return (await query.toArray()).map(fromRow);
  }

  async listByType(type: RecordType): Promise<LocalRecord[]> {
    return (await this.db.records.where("type").equals(type).toArray()).map(fromRow);
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction("rw", [this.db.records, this.db.meta, this.db.pending], fn);
  }

  /** Live children of a parent (segments of an article, chapters of a book), via the index. */
  async children(type: RecordType, parentId: string): Promise<LocalRecord[]> {
    const rows = await this.db.records.where("[type+parent]").equals([type, parentId.toLowerCase()]).toArray();
    return rows.map(fromRow).filter((r) => !r.deleted && r.payload);
  }

  /** Live records of a type (tombstones excluded), for UI queries. */
  async live(type: RecordType): Promise<LocalRecord[]> {
    return (await this.listByType(type)).filter((r) => !r.deleted && r.payload);
  }
}
