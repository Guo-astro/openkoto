// Sync protocol v1 wire types. Source of truth: docs/specs/sync-protocol-spec.md

export const PROTOCOL_VERSION = 1;

export const RECORD_TYPES = [
  "Book",
  "Media",
  "Article",
  "LyricsMeta",
  "BookChapter",
  "MediaPart",
  "Segment",
  "WordPack",
  "Vocabulary",
  "WordPackMembership",
  "BookMark",
  "BookProgress",
  "ReviewEvent",
  "WordGloss",
  "ReadingSession",
  "Setting",
  "MediaProgress",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

const MERGE_ORDER: Partial<Record<RecordType, number>> = {
  Book: 0,
  Media: 1,
  Article: 2,
  LyricsMeta: 3,
  BookChapter: 4,
  MediaPart: 5,
  Segment: 6,
  WordPack: 7,
  Vocabulary: 8,
  WordPackMembership: 9,
  BookMark: 10,
  BookProgress: 11,
  ReviewEvent: 12,
};

export function mergeOrder(type: RecordType): number {
  return MERGE_ORDER[type] ?? 99;
}

export function isRecordType(value: string): value is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(value);
}

/** Append-only types: existing ids are never overwritten or deleted. */
export const IMMUTABLE_TYPES: ReadonlySet<RecordType> = new Set(["ReviewEvent", "ReadingSession"]);

/** Payloads larger than this (serialized) must go through the blob endpoint. */
export const INLINE_PAYLOAD_LIMIT = 512 * 1024;
export const MAX_PUSH_OPS = 500;
export const MAX_PULL_LIMIT = 1000;
export const DEFAULT_PULL_LIMIT = 500;
export const TOMBSTONE_RETENTION_DAYS = 180;
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export type JsonObject = { [key: string]: unknown };

export interface SyncRecord {
  type: RecordType;
  id: string;
  rev: number;
  hlc: string;
  deviceId: string;
  deleted: boolean;
  payload: JsonObject | null;
  blobUrl?: string;
}

export interface PullResponse {
  records: SyncRecord[];
  cursor: string;
  hasMore: boolean;
  serverTime: string;
}

export interface PushOp {
  opId: string;
  type: RecordType;
  id: string;
  baseRev: number;
  hlc: string;
  deleted: boolean;
  payload?: JsonObject | null;
  blobKey?: string;
}

export interface PushRequest {
  deviceId: string;
  ops: PushOp[];
}

export type OpErrorCode =
  | "UNKNOWN_TYPE"
  | "INVALID_PAYLOAD"
  | "PAYLOAD_TOO_LARGE"
  | "QUOTA_EXCEEDED"
  | "CLOCK_SKEW"
  | "IMMUTABLE";

export type PushResult =
  | { opId: string; status: "applied"; rev: number }
  | { opId: string; status: "conflict"; rev: number; current: SyncRecord }
  | { opId: string; status: "rejected"; code: OpErrorCode; message?: string };

export interface PushResponse {
  results: PushResult[];
  cursor: string;
}

export type Plan = "free" | "plus" | "pro";

export interface PlanLimits {
  vocabulary: number | null;
  books: number | null;
  bookFileBytes: number;
  fileBytesTotal: number;
  lyrics: number | null;
  articles: number | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Every plan has finite caps (no "unlimited" tier); nulls are only accepted for older clients.
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { vocabulary: 200, books: 5, bookFileBytes: 10 * MB, fileBytesTotal: 50 * MB, lyrics: 10, articles: 10 },
  plus: { vocabulary: 20_000, books: 500, bookFileBytes: 50 * MB, fileBytesTotal: 2 * GB, lyrics: 2_000, articles: 2_000 },
  pro: { vocabulary: 50_000, books: 2_000, bookFileBytes: 50 * MB, fileBytesTotal: 10 * GB, lyrics: 5_000, articles: 5_000 },
};

export interface SyncStats {
  counts: Partial<Record<RecordType, number>>;
  bytes: number;
  blobBytes: number;
  plan: Plan;
  limits: PlanLimits;
  usage: { vocabulary: number; books: number; lyrics: number; articles: number; fileBytes: number };
}

export function encodeCursor(rev: number): string {
  return `c_${rev}`;
}

export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^c_(\d+)$/.exec(cursor);
  if (!match) throw new Error(`invalid cursor: ${cursor}`);
  return Number(match[1]);
}

/** Canonical record id: lowercase (iOS encodes UUIDs uppercase). */
export function canonicalId(id: string): string {
  return id.toLowerCase();
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
