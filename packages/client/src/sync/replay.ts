// Card replay from ReviewEvents (sync-protocol-spec §6).
// Contract fixture: docs/specs/fixtures/sync/replay-cases.json.

import {
  canonicalId,
  replayCard,
  type JsonObject,
  type ReplayEvent,
  type ReplayInitial,
  type ReplayResult,
  type ScheduleOptions,
} from "@openkoto/core";
import type { LocalRecord } from "./store";

/** Fields replay owns in a Vocabulary payload. */
export const REPLAYED_FIELDS = ["srsState", "stability", "difficulty", "dueDate", "lastReviewedAt", "reviewCount", "schedulerVersion"] as const;

/** A ReviewEvent record → replay input (record HLC is the second sort key). */
export function replayEventFromRecord(record: Pick<LocalRecord, "id" | "hlc" | "payload">): ReplayEvent | null {
  const p = record.payload;
  if (!p || typeof p.reviewedAt !== "string") return null;
  return {
    id: canonicalId(record.id),
    reviewedAt: p.reviewedAt,
    grade: Number(p.grade),
    voidsEventId: typeof p.voidsEventId === "string" ? p.voidsEventId : null,
    hlc: record.hlc,
    dateLocal: typeof p.dateLocal === "string" ? p.dateLocal : null,
    desiredRetention: typeof p.desiredRetention === "number" ? p.desiredRetention : null,
  };
}

/** De-duplicate by (lowercased) id — the same event delivered twice counts once — then replay. */
export function replayEvents(initial: ReplayInitial | null | undefined, events: readonly ReplayEvent[], opts: ScheduleOptions = {}): ReplayResult {
  const byId = new Map<string, ReplayEvent>();
  for (const e of events) {
    const id = canonicalId(e.id);
    if (!byId.has(id)) byId.set(id, { ...e, id, voidsEventId: e.voidsEventId ? canonicalId(e.voidsEventId) : e.voidsEventId });
  }
  return replayCard(initial, [...byId.values()], opts);
}

/** Overwrite the replay-owned fields of a Vocabulary payload; returns null if nothing changed. */
export function applyReplayToPayload(payload: JsonObject, result: ReplayResult): JsonObject | null {
  let changed = false;
  const next: JsonObject = { ...payload };
  for (const key of REPLAYED_FIELDS) {
    if (next[key] !== result[key]) {
      next[key] = result[key];
      changed = true;
    }
  }
  return changed ? next : null;
}
