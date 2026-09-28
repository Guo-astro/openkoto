import type { JsonObject, RecordType, SyncRecord } from "@openkoto/core";

/** A record as held by a client (sync-protocol-spec §2, §8). */
export interface LocalRecord {
  type: RecordType;
  /** Canonical (lowercase) id. */
  id: string;
  /** Last server rev seen for this record; 0 = never on the server. Sent as `baseRev`. */
  rev: number;
  hlc: string;
  deleted: boolean;
  /** null for tombstones. */
  payload: JsonObject | null;
  /** Has a local change the server has not acknowledged. */
  dirty: boolean;
  /** opId of the pending push; reused on network retries so the server can dedupe. */
  opId?: string | null;
}

export const META_CURSOR = "cursor";
export const META_HLC = "hlc";
export const META_DEVICE_ID = "deviceId";

/** Optional FK-deferral queue (spec §2.3; iOS `pending_cloud_payload`). */
export interface PendingRemoteQueue {
  add(records: SyncRecord[]): Promise<void>;
  /** Remove and return everything queued. */
  takeAll(): Promise<SyncRecord[]>;
}

/**
 * Storage the SyncEngine runs on. Implementations: MemoryStore (here), SQLite/GRDB on iOS,
 * IndexedDB on web, rusqlite on desktop. All methods may be async.
 */
export interface LocalStore {
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
  getRecord(type: RecordType, id: string): Promise<LocalRecord | null>;
  putRecord(record: LocalRecord): Promise<void>;
  /** Dirty records, any order; `limit` omitted = all. */
  dirtyRecords(limit?: number): Promise<LocalRecord[]>;
  /** All records of a type, tombstones included. */
  listByType(type: RecordType): Promise<LocalRecord[]>;
  pendingRemote?: PendingRemoteQueue;
  /** Run `fn` atomically (e.g. one pull page + its cursor). Optional. */
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
}
