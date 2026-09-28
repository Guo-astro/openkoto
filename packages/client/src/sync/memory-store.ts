import type { RecordType, SyncRecord } from "@openkoto/core";
import type { LocalRecord, LocalStore, PendingRemoteQueue } from "./store";

const clone = <T>(value: T): T => (value === null || value === undefined ? value : structuredClone(value));

/** In-memory LocalStore (tests, CLI dry runs). Records are deep-copied in and out. */
export class MemoryStore implements LocalStore {
  private readonly records = new Map<string, LocalRecord>();
  private readonly meta = new Map<string, string>();
  private pending: SyncRecord[] = [];

  readonly pendingRemote: PendingRemoteQueue = {
    add: async (records) => {
      this.pending.push(...clone(records));
    },
    takeAll: async () => {
      const out = this.pending;
      this.pending = [];
      return out;
    },
  };

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }

  async getRecord(type: RecordType, id: string): Promise<LocalRecord | null> {
    return clone(this.records.get(`${type}/${id}`) ?? null);
  }

  async putRecord(record: LocalRecord): Promise<void> {
    this.records.set(`${record.type}/${record.id}`, clone(record));
  }

  async dirtyRecords(limit?: number): Promise<LocalRecord[]> {
    const out = [...this.records.values()].filter((r) => r.dirty);
    return clone(limit === undefined ? out : out.slice(0, limit));
  }

  async listByType(type: RecordType): Promise<LocalRecord[]> {
    return clone([...this.records.values()].filter((r) => r.type === type));
  }

  /** All records sorted by (type, id). */
  all(): LocalRecord[] {
    return clone([...this.records.values()].sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : 1) : a.type < b.type ? -1 : 1)));
  }

  /** Sync-relevant view for comparing stores across devices (drops dirty/opId bookkeeping). */
  snapshot(): Array<Pick<LocalRecord, "type" | "id" | "rev" | "hlc" | "deleted" | "payload">> {
    return this.all().map(({ type, id, rev, hlc, deleted, payload }) => ({ type, id, rev, hlc, deleted, payload }));
  }
}
