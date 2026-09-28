import { describe, expect, it } from "vitest";
import type { SyncRecord } from "@openkoto/core";
import fixture from "../../../docs/specs/fixtures/sync/merge-cases.json";
import { fillSegmentFields, mergeRemote, type LocalRecord, type MergeContext } from "../src/index";

interface MergeCase {
  name: string;
  local: LocalRecord | null;
  remote: SyncRecord;
  context?: MergeContext;
  expected: { outcome: string; record: LocalRecord | null; retick: boolean; purgeSegmentsBelow?: { articleId: string; revision: number } };
}

describe("merge-cases.json contract", () => {
  const cases = fixture.cases as unknown as MergeCase[];

  it("covers the required scenarios", () => {
    const names = cases.map((c) => c.name);
    for (const required of [
      "lww-remote-newer",
      "lww-local-newer",
      "tombstone-newer-deletes",
      "edit-newer-than-local-tombstone-resurrects",
      "equal-hlc-acknowledge",
      "review-event-immutable",
      "segment-revision-greater",
      "segment-equal-fill-remote-wins",
      "segment-revision-lower",
    ]) {
      expect(names).toContain(required);
    }
  });

  for (const c of cases) {
    it(c.name, () => {
      const decision = mergeRemote(c.local, c.remote, c.context);
      const actual: Record<string, unknown> = { outcome: decision.outcome, record: decision.record, retick: decision.retick };
      if (decision.purgeSegmentsBelow) actual.purgeSegmentsBelow = decision.purgeSegmentsBelow;
      expect(actual).toEqual(c.expected);
    });
  }

  it("does not mutate its inputs", () => {
    for (const c of cases) {
      const before = JSON.stringify([c.local, c.remote]);
      mergeRemote(c.local, c.remote, c.context);
      expect(JSON.stringify([c.local, c.remote])).toBe(before);
    }
  });
});

describe("fillSegmentFields", () => {
  it("only fills missing/null/empty fields", () => {
    const { payload, changed } = fillSegmentFields({ translation: "", readingText: "keep", other: 1 }, { translation: "t", readingText: "r", explanation: null });
    expect(changed).toBe(true);
    expect(payload).toEqual({ translation: "t", readingText: "keep", other: 1 });
    expect(fillSegmentFields({ translation: "x" }, { translation: "y" }).changed).toBe(false);
  });
});
