import { describe, expect, it } from "vitest";
import golden from "../../../docs/specs/fixtures/fsrs_golden_v1.json";
import {
  FSRS_PARAMS,
  addDays,
  aheadQueue,
  dueQueue,
  isGrade,
  localDateString,
  nextReview,
  replayCard,
  retentionBand,
  retrievability,
  reviewCard,
  seedFromSM2,
  type Grade,
  type QueueCard,
  type ReplayEvent,
  type SrsCardState,
} from "../src/fsrs";

const GRADE: Record<string, Grade> = { again: 1, hard: 2, good: 3, easy: 4 };
const tol = golden.tolerance;
const BASE = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

describe("FSRS golden fixture", () => {
  it("uses the pinned parameters", () => {
    expect([...FSRS_PARAMS]).toEqual(golden.params);
  });

  for (const c of golden.cases) {
    it(`engine: ${c.name}`, () => {
      let s = 0;
      let d = 0;
      let last = 0;
      c.reviews.forEach((review, step) => {
        const exp = c.expected[step]!;
        const u = nextReview(s, d, review.day_offset - last, GRADE[review.grade]!, c.desired_retention);
        expect(Math.abs(u.stability - exp.stability)).toBeLessThanOrEqual(tol.stability);
        expect(Math.abs(u.difficulty - exp.difficulty)).toBeLessThanOrEqual(tol.difficulty);
        expect(u.intervalDays).toBe(exp.interval_days);
        expect(u.state).toBe(exp.state);
        s = u.stability;
        d = u.difficulty;
        last = review.day_offset;
      });
      for (const check of c.retrievability_checks ?? []) {
        const r = retrievability(c.expected[check.after_step]!.stability, check.elapsed_days);
        expect(Math.abs(r - check.expected)).toBeLessThanOrEqual(tol.retrievability);
      }
    });

    it(`reviewCard + replay: ${c.name}`, () => {
      const opts = { desiredRetention: c.desired_retention, timeZone: "Asia/Tokyo" };
      let card: SrsCardState & { id: string } = {
        id: "card-1",
        srsState: "new",
        stability: 0,
        difficulty: 0,
        dueDate: "",
        reviewCount: 0,
      };
      const events: ReplayEvent[] = [];
      c.reviews.forEach((review, step) => {
        // 10:00 JST on the offset day.
        const now = new Date(BASE + review.day_offset * DAY + 3_600_000 + step * 1000);
        const grade = GRADE[review.grade]!;
        const out = reviewCard(card, grade, now, opts);
        const exp = c.expected[step]!;
        expect(out.event.resultIntervalDays).toBe(exp.interval_days);
        expect(Math.abs(out.card.stability - exp.stability)).toBeLessThanOrEqual(tol.stability);
        expect(out.event.previousState).toBe(card.srsState);
        expect(out.card.dueDate).toBe(
          grade >= 3 ? addDays(out.event.dateLocal, exp.interval_days) : out.event.dateLocal,
        );
        events.push({ id: `e${step}`, reviewedAt: out.event.reviewedAt, grade });
        card = out.card;
      });
      // Replay (shuffled input) reproduces the live state.
      const replayed = replayCard(null, [...events].reverse(), opts);
      expect(replayed).toMatchObject({
        srsState: card.srsState,
        stability: card.stability,
        difficulty: card.difficulty,
        dueDate: card.dueDate,
        lastReviewedAt: card.lastReviewedAt,
        reviewCount: card.reviewCount,
      });
    });
  }

  for (const seed of golden.sm2_seed_cases) {
    it(`SM-2 seed ${seed.interval_days}d/${seed.ease_factor}`, () => {
      const out = seedFromSM2(seed.interval_days, seed.ease_factor);
      expect(Math.abs(out.stability - seed.expected_stability)).toBeLessThanOrEqual(tol.stability);
      expect(Math.abs(out.difficulty - seed.expected_difficulty)).toBeLessThanOrEqual(tol.difficulty);
    });
  }
});

describe("scheduling rules", () => {
  const fresh = (): SrsCardState & { id: string } => ({
    id: "c",
    srsState: "new",
    stability: 0,
    difficulty: 0,
    dueDate: "2026-01-01",
    reviewCount: 0,
  });

  it("keeps failed cards due today (same-day learning steps)", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    for (const grade of [1, 2] as Grade[]) {
      const { card, event } = reviewCard(fresh(), grade, now, { timeZone: "UTC" });
      expect(card.dueDate).toBe("2026-03-01");
      expect(event.resultIntervalDays).toBeGreaterThanOrEqual(1);
    }
    expect(reviewCard(fresh(), 3, now, { timeZone: "UTC" }).card.dueDate).toBe("2026-03-04");
  });

  it("computes elapsed days on local dates", () => {
    const first = reviewCard(fresh(), 3, new Date("2026-03-01T14:30:00Z"), { timeZone: "Asia/Shanghai" });
    expect(first.event.dateLocal).toBe("2026-03-01");
    // 16:30Z on 03-01 is already 03-02 in Shanghai.
    const second = reviewCard(first.card, 3, new Date("2026-03-01T16:30:00Z"), { timeZone: "Asia/Shanghai" });
    expect(second.event.dateLocal).toBe("2026-03-02");
    expect(second.event.elapsedDays).toBe(1);
    expect(second.card.reviewCount).toBe(2);
    expect(second.event.previousState).toBe("review");
  });

  it("falls back to dueDate - legacy interval for seeded cards", () => {
    const seed = seedFromSM2(10, 2.5);
    const card = { ...fresh(), ...seed, srsState: "review" as const, dueDate: "2026-03-11", reviewCount: 4 };
    const { event } = reviewCard(card, 3, new Date("2026-03-11T12:00:00Z"), {
      timeZone: "UTC",
      legacyIntervalDays: 10,
    });
    expect(event.elapsedDays).toBe(10);
    expect(reviewCard(card, 3, new Date("2026-03-11T12:00:00Z"), { timeZone: "UTC" }).event.elapsedDays).toBe(0);
  });

  it("formats local dates", () => {
    expect(localDateString("2026-12-31T23:30:00Z", "UTC")).toBe("2026-12-31");
    expect(localDateString("2026-12-31T23:30:00Z", "Asia/Tokyo")).toBe("2027-01-01");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
  });

  it("validates grades", () => {
    expect(isGrade(0)).toBe(false);
    expect(() => nextReview(0, 0, 0, 5 as Grade)).toThrow();
    expect(() => nextReview(0, 0, -1, 3)).toThrow();
  });

  it("bands retention", () => {
    const now = new Date("2026-03-10T00:00:00Z");
    expect(retentionBand({ srsState: "new", stability: 0 }, now)).toBe("new");
    expect(retentionBand({ srsState: "review", stability: 10, lastReviewedAt: "2026-03-09T00:00:00Z" }, now)).toBe("strong");
    expect(retentionBand({ srsState: "review", stability: 2.3, lastReviewedAt: "2026-03-02T00:00:00Z" }, now)).toBe("fading");
    expect(retentionBand({ srsState: "review", stability: 0.2, lastReviewedAt: "2026-02-01T00:00:00Z" }, now)).toBe("weak");
  });
});

describe("replayCard", () => {
  const ev = (id: string, reviewedAt: string, grade: number, extra: Partial<ReplayEvent> = {}): ReplayEvent => ({
    id,
    reviewedAt,
    grade,
    ...extra,
  });

  it("returns the initial state with no events", () => {
    expect(replayCard(null, [])).toMatchObject({ srsState: "new", stability: 0, difficulty: 0, reviewCount: 0, lastReviewedAt: null });
  });

  it("skips voided events and void markers", () => {
    const events = [
      ev("a", "2026-01-01T10:00:00Z", 3),
      ev("b", "2026-01-04T10:00:00Z", 1),
      ev("v", "2026-01-04T10:05:00Z", 0, { voidsEventId: "B" }),
    ];
    const replayed = replayCard(null, events, { timeZone: "UTC" });
    const only = replayCard(null, [events[0]!], { timeZone: "UTC" });
    expect(replayed).toEqual(only);
    expect(replayed.reviewCount).toBe(1);
  });

  it("orders by reviewedAt, then hlc, then id", () => {
    const t = "2026-01-01T10:00:00.000Z";
    const a = [ev("b", t, 1, { hlc: "0000000000001-0000-aaaaaaaa" }), ev("a", t, 3, { hlc: "0000000000002-0000-aaaaaaaa" })];
    // hlc puts "b"(again) first then "a"(good) → final state review.
    expect(replayCard(null, a).srsState).toBe("review");
    const byId = [ev("B", t, 3), ev("a", t, 1)];
    // no hlc: id "a" < "b" case-insensitively → good last.
    expect(replayCard(null, byId).srsState).toBe("review");
  });

  it("merges two offline devices' reviews", () => {
    const fromA = ev("x1", "2026-01-01T09:00:00Z", 3);
    const fromB = ev("x2", "2026-01-05T09:00:00Z", 3);
    const state = replayCard(null, [fromB, fromA], { timeZone: "UTC" });
    const s1 = nextReview(0, 0, 0, 3);
    const s2 = nextReview(s1.stability, s1.difficulty, 4, 3);
    expect(state.stability).toBe(s2.stability);
    expect(state.dueDate).toBe(addDays("2026-01-05", s2.intervalDays));
    expect(state.reviewCount).toBe(2);
  });

  it("starts from an SM-2 seed", () => {
    const seed = { ...seedFromSM2(20, 2.5), srsState: "review" as const, lastReviewedAt: "2026-01-01T00:00:00Z", reviewCount: 5 };
    const state = replayCard(seed, [ev("s", "2026-01-21T00:00:00Z", 3)], { timeZone: "UTC" });
    const expected = nextReview(seed.stability, seed.difficulty, 20, 3);
    expect(state.stability).toBe(expected.stability);
    expect(state.reviewCount).toBe(6);
  });
});

describe("queues", () => {
  const card = (id: string, over: Partial<QueueCard>): QueueCard & { id: string } => ({
    id,
    srsState: "review",
    dueDate: "2026-03-01",
    ...over,
  });

  it("filters, orders and caps only new cards", () => {
    const cards = [
      card("r2", { dueDate: "2026-03-01", lastReviewedAt: "2026-02-20T00:00:00Z" }),
      card("r1", { dueDate: "2026-02-28" }),
      card("future", { dueDate: "2026-03-02" }),
      card("bad", { dueDate: "garbage" }),
      card("susp", { suspendedAt: "2026-01-01T00:00:00Z" }),
      card("n1", { srsState: "new", dueDate: "2026-02-01" }),
      card("n2", { srsState: "new", dueDate: "2026-02-02" }),
      card("l1", { srsState: "learning", dueDate: "2026-03-01", lastReviewedAt: "2026-03-01T08:00:00Z" }),
      card("other", { packIds: ["p2"] }),
    ];
    const q = dueQueue(cards, "2026-03-01", { newLimit: 1, reviewLimit: 10 });
    expect(q.map((c) => c.id)).toEqual(["n1", "l1", "r1", "other", "r2", "bad"]);
    expect(dueQueue(cards, "2026-03-01", { packId: "p2" }).map((c) => c.id)).toEqual(["other"]);
    expect(dueQueue(cards, "2026-03-01", { newLimit: 0, reviewLimit: 1 }).map((c) => c.id)).toEqual(["l1", "r1"]);
    expect(aheadQueue(cards, "2026-03-01").map((c) => c.id)).toEqual(["future"]);
  });
});

describe("replay determinism across devices", () => {
  it("uses each event's recorded local date and retention", () => {
    const events = [
      { id: "e1", reviewedAt: "2026-09-01T23:30:00Z", dateLocal: "2026-09-02", grade: 3, desiredRetention: 0.9 },
      { id: "e2", reviewedAt: "2026-09-05T01:00:00Z", dateLocal: "2026-09-05", grade: 3, desiredRetention: 0.8 },
    ];
    const tokyo = replayCard(null, events, { timeZone: "Asia/Tokyo", desiredRetention: 0.95 });
    const newYork = replayCard(null, events, { timeZone: "America/New_York", desiredRetention: 0.7 });
    expect(newYork).toEqual(tokyo);
    expect(tokyo.reviewCount).toBe(2);
  });
});
