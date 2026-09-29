import { describe, expect, it } from "vitest";
import type { ReplayInitial, ReplayResult } from "@openkoto/core";
import fixture from "../../../docs/specs/fixtures/sync/replay-cases.json";
import { applyReplayToPayload, replayEventFromRecord, replayEvents, type LocalRecord } from "../src/index";

interface ReplayCase {
  name: string;
  initial: ReplayInitial | null;
  events: Pick<LocalRecord, "id" | "hlc" | "payload">[];
  expected: ReplayResult;
}

describe("replay-cases.json contract", () => {
  const cases = fixture.cases as unknown as ReplayCase[];
  for (const c of cases) {
    it(c.name, () => {
      const events = c.events.map((e) => replayEventFromRecord(e)!);
      const result = replayEvents(c.initial, events, fixture.defaults);
      const { stability, difficulty, ...rest } = result;
      const { stability: es, difficulty: ed, ...expectedRest } = c.expected;
      expect(rest).toEqual(expectedRest);
      expect(stability).toBeCloseTo(es, 6);
      expect(difficulty).toBeCloseTo(ed, 6);
    });

    it(`${c.name}: order-independent`, () => {
      const events = [...c.events].reverse().map((e) => replayEventFromRecord(e)!);
      expect(replayEvents(c.initial, events, fixture.defaults)).toEqual(replayEvents(c.initial, c.events.map((e) => replayEventFromRecord(e)!), fixture.defaults));
    });
  }
});

describe("applyReplayToPayload", () => {
  it("overwrites only replay-owned fields and reports no-ops", () => {
    const result: ReplayResult = { srsState: "review", stability: 2, difficulty: 3, dueDate: "2026-10-01", lastReviewedAt: "2026-09-28T00:00:00.000Z", reviewCount: 1, schedulerVersion: "fsrs6" };
    const next = applyReplayToPayload({ word: "猫", srsState: "new", stability: 0 }, result)!;
    expect(next).toMatchObject({ word: "猫", ...result });
    expect(applyReplayToPayload(next, result)).toBeNull();
  });
});
