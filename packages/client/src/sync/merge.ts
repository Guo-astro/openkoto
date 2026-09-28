// Pure merge rules, sync-protocol-spec §4 (+ §6 ReviewEvent immutability).
// Contract fixture: docs/specs/fixtures/sync/merge-cases.json.

import { canonicalId, compareHlc, type JsonObject, type SyncRecord } from "@openkoto/core";
import type { LocalRecord } from "./store";

/**
 * - `remote`      remote version replaces local (dirty=false)
 * - `local`       local version wins; stays/becomes dirty with baseRev = remote.rev so it is (re)pushed
 * - `merged`      remote won LWW but local contributed fields (Segment fill); dirty, needs a fresh HLC
 * - `acknowledge` same write (equal HLC) or an existing immutable record: keep local payload, adopt rev, clear dirty
 * - `ignore`      drop the remote record, no local write
 */
export type MergeOutcome = "remote" | "local" | "merged" | "acknowledge" | "ignore";

export interface MergeContext {
  /**
   * Segment only: max `segmentationRevision` among the *live* local segments of the remote
   * segment's article (undefined = none locally). Defaults to the same-id local record's revision.
   */
  localSegmentRevision?: number;
}

export interface MergeDecision {
  outcome: MergeOutcome;
  /** New local state to write; null for `ignore`. Never carries an opId. */
  record: LocalRecord | null;
  /** `merged`: the engine must assign a new local HLC before pushing. */
  retick: boolean;
  /** Segment revision increased: drop local live segments of this article with a lower revision. */
  purgeSegmentsBelow?: { articleId: string; revision: number };
  reason?: string;
}

const SEGMENT_FILL_FIELDS = ["translation", "readingText", "explanation"] as const;

export function segmentRevisionOf(payload: JsonObject | null | undefined): number {
  const value = payload?.segmentationRevision;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Fill `target`'s empty translation/readingText/explanation from `source`. */
export function fillSegmentFields(target: JsonObject, source: JsonObject | null): { payload: JsonObject; changed: boolean } {
  if (!source) return { payload: target, changed: false };
  let changed = false;
  const out: JsonObject = { ...target };
  for (const key of SEGMENT_FILL_FIELDS) {
    if (isEmpty(out[key]) && !isEmpty(source[key])) {
      out[key] = source[key];
      changed = true;
    }
  }
  return { payload: out, changed };
}

function fromRemote(remote: SyncRecord): LocalRecord {
  return {
    type: remote.type,
    id: canonicalId(remote.id),
    rev: remote.rev,
    hlc: remote.hlc,
    deleted: remote.deleted,
    payload: remote.deleted ? null : (remote.payload ?? null),
    dirty: false,
  };
}

function strip(local: LocalRecord): LocalRecord {
  const { opId: _opId, ...rest } = local;
  return rest;
}

const decision = (outcome: MergeOutcome, record: LocalRecord | null, extra: Partial<MergeDecision> = {}): MergeDecision => ({
  outcome,
  record,
  retick: false,
  ...extra,
});

/** Decide how a pulled (or conflict `current`) record combines with the local copy. */
export function mergeRemote(local: LocalRecord | null, remote: SyncRecord, ctx: MergeContext = {}): MergeDecision {
  const incoming = fromRemote(remote);

  // §6: ReviewEvent is append-only. An existing id is never modified or deleted.
  if (remote.type === "ReviewEvent") {
    if (remote.deleted) return decision("ignore", null, { reason: "review-event-immutable" });
    if (local && !local.deleted) {
      return decision("acknowledge", { ...strip(local), rev: Math.max(local.rev, remote.rev), dirty: false }, { reason: "review-event-immutable" });
    }
    return decision("remote", incoming);
  }

  // A server record only ever moves forward; a lower rev than we already know is stale.
  if (local && remote.rev < local.rev) return decision("ignore", null, { reason: "stale-rev" });

  // §4.3 Segment revision gate (live remote segments only; tombstones use plain LWW).
  let fillSegment = false;
  if (remote.type === "Segment" && !remote.deleted) {
    const remoteRevision = segmentRevisionOf(remote.payload);
    const localRevision =
      ctx.localSegmentRevision ?? (local && !local.deleted ? segmentRevisionOf(local.payload) : undefined);
    if (localRevision !== undefined) {
      if (remoteRevision < localRevision) return decision("ignore", null, { reason: "segment-revision-lower" });
      if (remoteRevision > localRevision) {
        const articleId = typeof remote.payload?.articleId === "string" ? canonicalId(remote.payload.articleId) : null;
        return decision("remote", incoming, {
          reason: "segment-revision-greater",
          ...(articleId ? { purgeSegmentsBelow: { articleId, revision: remoteRevision } } : {}),
        });
      }
      fillSegment = !!local && !local.deleted;
    }
  }

  if (!local) return decision("remote", incoming);

  const cmp = compareHlc(remote.hlc, local.hlc);
  if (cmp === 0) {
    // Same write (HLC embeds the node id): our own push echoed back, or already applied.
    return decision("acknowledge", { ...strip(local), rev: Math.max(local.rev, remote.rev), dirty: false }, { reason: "equal-hlc" });
  }

  if (cmp > 0) {
    if (fillSegment) {
      const { payload, changed } = fillSegmentFields(incoming.payload!, local.payload);
      if (changed) return decision("merged", { ...incoming, payload, dirty: true }, { retick: true, reason: "segment-fill" });
    }
    return decision("remote", incoming);
  }

  // Local is newer by HLC: keep it and (re)push on top of the server's current rev.
  let payload = local.payload;
  if (fillSegment && local.payload) payload = fillSegmentFields(local.payload, incoming.payload).payload;
  return decision("local", { ...strip(local), payload, rev: remote.rev, dirty: true });
}
