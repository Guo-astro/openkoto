// FSRS-6 scheduling, long-term mode, day granularity.
// Contract: docs/specs/vocabulary-srs-spec.md §2–§5; replay: docs/specs/sync-protocol-spec.md §6.
// Port of iOS OKSRS (FSRS.swift + ReviewReplay.swift); the math itself is delegated to
// ts-fsrs 5.4.1 (the reference implementation the golden fixture is generated from).

import { FSRSAlgorithm, default_w, forgetting_curve, generatorParameters } from "ts-fsrs";
import type { ReviewEvent, SrsState } from "./models";

export const FSRS_PARAMS: readonly number[] = [...default_w];
export const SCHEDULER_VERSION = "fsrs6";
export const DEFAULT_DESIRED_RETENTION = 0.9;
export const MAX_INTERVAL_DAYS = 36500;
export const DEFAULT_DAILY_NEW_LIMIT = 20;
export const DEFAULT_DAILY_REVIEW_LIMIT = 100;
const SM2_RETENTION = 0.9;
const DAY_MS = 86_400_000;

/** Again=1 / Hard=2 / Good=3 / Easy=4. UI: 不认识→1, 模糊→2, 认识→3. */
export type Grade = 1 | 2 | 3 | 4;
export const Grades = { again: 1, hard: 2, good: 3, easy: 4 } as const;
const ALL_GRADES: readonly Grade[] = [1, 2, 3, 4];

export function isGrade(value: unknown): value is Grade {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

export interface ScheduleUpdate {
  stability: number;
  difficulty: number;
  intervalDays: number;
  state: SrsState;
}

// MARK: - engine (spec §2.3–§2.5)

const engines = new Map<number, FSRSAlgorithm>();

function engineFor(desiredRetention: number): FSRSAlgorithm {
  if (!(desiredRetention > 0 && desiredRetention <= 1)) {
    throw new RangeError(`invalid desired retention: ${desiredRetention}`);
  }
  let engine = engines.get(desiredRetention);
  if (!engine) {
    engine = new FSRSAlgorithm(
      generatorParameters({
        w: [...FSRS_PARAMS],
        request_retention: desiredRetention,
        maximum_interval: MAX_INTERVAL_DAYS,
        enable_fuzz: false,
        enable_short_term: false,
      }),
    );
    engines.set(desiredRetention, engine);
  }
  return engine;
}

/**
 * One review: computes all four grades, applies the cross-grade interval ordering fix,
 * then returns the chosen grade (spec §2.5).
 */
export function nextReview(
  stability: number,
  difficulty: number,
  elapsedDays: number,
  grade: Grade,
  desiredRetention: number = DEFAULT_DESIRED_RETENTION,
): ScheduleUpdate {
  if (!Number.isInteger(elapsedDays) || elapsedDays < 0) {
    throw new RangeError(`invalid elapsed days: ${elapsedDays}`);
  }
  if (!isGrade(grade)) throw new RangeError(`invalid grade: ${String(grade)}`);
  const engine = engineFor(desiredRetention);
  const isNew = stability === 0 && difficulty === 0;
  const memory = isNew ? null : { stability, difficulty };
  const r = isNew ? undefined : retrievability(stability, elapsedDays);

  const states = ALL_GRADES.map((g) => engine.next_state(memory, elapsedDays, g, r));
  const [s1, s2, s3, s4] = states.map((s) => engine.next_interval(s.stability, elapsedDays) as number);
  const again = Math.min(s1!, s2!);
  const hard = Math.max(s2!, again + 1);
  const good = Math.max(s3!, hard + 1);
  const easy = Math.max(s4!, good + 1);
  const ivl = [again, hard, good, easy];

  const chosen = states[grade - 1]!;
  return {
    stability: chosen.stability,
    difficulty: chosen.difficulty,
    intervalDays: ivl[grade - 1]!,
    state: grade === 1 ? "learning" : "review",
  };
}

/** R(t, S); t in days (fractional allowed). Uninitialised cards (S ≤ 0) → 0. */
export function retrievability(stability: number, elapsedDays: number): number {
  if (!(stability > 0)) return 0;
  return forgetting_curve([...FSRS_PARAMS], Math.max(elapsedDays, 0), stability);
}

/** SM-2 → FSRS seed (spec §4, fsrs-rs `memory_state_from_sm2`). No round8, by design. */
export function seedFromSM2(intervalDays: number, easeFactor: number): { stability: number; difficulty: number } {
  const w = FSRS_PARAMS;
  const stability = Math.max(intervalDays, 0.1) / (9 * (1 / SM2_RETENTION - 1));
  const denominator = Math.exp(w[8]!) * Math.pow(stability, -w[9]!) * (Math.exp((1 - SM2_RETENTION) * w[10]!) - 1);
  const difficulty = Math.min(Math.max(11 - (easeFactor - 1) / denominator, 1), 10);
  return { stability, difficulty };
}

// MARK: - local dates ("YYYY-MM-DD")

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date of an instant. `timeZone` is an IANA name; omitted = runtime default. */
export function localDateString(date: Date | string | number, timeZone?: string): string {
  const key = timeZone ?? "";
  let fmt = dateFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(key, fmt);
  }
  const parts = fmt.formatToParts(new Date(date));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function localDateToUtcMs(value: string): number | null {
  const m = LOCAL_DATE_RE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms;
}

export function isValidLocalDate(value: string | null | undefined): boolean {
  return typeof value === "string" && localDateToUtcMs(value) !== null;
}

export function addDays(dateLocal: string, days: number): string {
  const ms = localDateToUtcMs(dateLocal);
  if (ms === null) throw new RangeError(`invalid local date: ${dateLocal}`);
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar-day difference `to - from` (may be negative). */
export function diffDays(from: string, to: string): number {
  const a = localDateToUtcMs(from);
  const b = localDateToUtcMs(to);
  if (a === null || b === null) throw new RangeError(`invalid local date: ${from} / ${to}`);
  return Math.round((b - a) / DAY_MS);
}

/**
 * Next due date. Same-day learning steps (spec §2.8): a card that was not answered
 * Good/Easy stays due today; only a pass pushes it into the future.
 */
export function dueDateFor(grade: Grade, intervalDays: number, dateLocal: string): string {
  return grade >= 3 ? addDays(dateLocal, intervalDays) : dateLocal;
}

// MARK: - reviewing a card

/** The SRS slice of a Vocabulary payload that the scheduler reads and writes. */
export interface SrsCardState {
  srsState: SrsState;
  stability: number;
  difficulty: number;
  dueDate: string;
  lastReviewedAt?: string | null;
  reviewCount: number;
  schedulerVersion?: string | null;
  suspendedAt?: string | null;
}

export interface ScheduleOptions {
  desiredRetention?: number;
  /** IANA zone used for local dates; omitted = runtime default. */
  timeZone?: string;
  /** Frozen SM-2 interval for seeded cards without `lastReviewedAt` (spec §2.7 fallback). */
  legacyIntervalDays?: number;
}

/** ReviewEvent payload minus the record id. */
export type ReviewEventFields = Omit<ReviewEvent, "id" | "voidsEventId">;

/** Local-day distance since the last review (spec §2.7). New cards → 0. */
export function elapsedDaysForReview(
  card: Pick<SrsCardState, "stability" | "difficulty" | "lastReviewedAt" | "dueDate">,
  dateLocal: string,
  opts: Pick<ScheduleOptions, "timeZone" | "legacyIntervalDays"> & { lastReviewedDateLocal?: string | null } = {},
): number {
  if (card.stability === 0 && card.difficulty === 0) return 0;
  if (opts.lastReviewedDateLocal && isValidLocalDate(opts.lastReviewedDateLocal)) {
    return Math.max(diffDays(opts.lastReviewedDateLocal, dateLocal), 0);
  }
  if (card.lastReviewedAt) {
    const last = new Date(card.lastReviewedAt);
    if (!Number.isNaN(last.getTime())) {
      return Math.max(diffDays(localDateString(last, opts.timeZone), dateLocal), 0);
    }
  }
  if (opts.legacyIntervalDays !== undefined && isValidLocalDate(card.dueDate)) {
    const impliedLast = addDays(card.dueDate, -Math.max(opts.legacyIntervalDays, 0));
    return Math.max(diffDays(impliedLast, dateLocal), 0);
  }
  return 0;
}

/**
 * Review a card now: FSRS update + due date + the ReviewEvent payload to append.
 * `card.id` becomes the event's `vocabularyId`.
 */
export function reviewCard<C extends SrsCardState & { id: string }>(
  card: C,
  grade: Grade,
  now: Date = new Date(),
  opts: ScheduleOptions = {},
): { card: C; event: ReviewEventFields } {
  const desiredRetention = opts.desiredRetention ?? DEFAULT_DESIRED_RETENTION;
  const dateLocal = localDateString(now, opts.timeZone);
  const elapsedDays = elapsedDaysForReview(card, dateLocal, opts);
  const update = nextReview(card.stability, card.difficulty, elapsedDays, grade, desiredRetention);
  const reviewedAt = now.toISOString();

  const next: C = {
    ...card,
    srsState: update.state,
    stability: update.stability,
    difficulty: update.difficulty,
    schedulerVersion: SCHEDULER_VERSION,
    dueDate: dueDateFor(grade, update.intervalDays, dateLocal),
    lastReviewedAt: reviewedAt,
    reviewCount: card.reviewCount + 1,
  };
  const event: ReviewEventFields = {
    vocabularyId: card.id,
    reviewedAt,
    dateLocal,
    grade,
    elapsedDays,
    previousState: card.srsState,
    schedulerVersion: SCHEDULER_VERSION,
    desiredRetention,
    resultStability: update.stability,
    resultDifficulty: update.difficulty,
    resultIntervalDays: update.intervalDays,
    resultState: update.state,
  };
  return { card: next, event };
}

// MARK: - replay (sync-protocol-spec §6)

export interface ReplayResult {
  srsState: SrsState;
  stability: number;
  difficulty: number;
  dueDate: string;
  lastReviewedAt: string | null;
  reviewCount: number;
  schedulerVersion: string;
}

export type ReplayEvent = Pick<ReviewEvent, "id" | "reviewedAt" | "grade"> & {
  voidsEventId?: string | null;
  /** Record HLC, used as the second sort key. */
  hlc?: string | null;
  /** Local calendar day recorded on the reviewing device; preferred over re-deriving from reviewedAt. */
  dateLocal?: string | null;
  /** Retention the reviewing device used; replay honours it so every client gets the same result. */
  desiredRetention?: number | null;
};

/** Starting point: a brand-new card, or an SM-2 seeded one. */
export interface ReplayInitial {
  stability: number;
  difficulty: number;
  srsState?: SrsState;
  dueDate?: string;
  lastReviewedAt?: string | null;
  reviewCount?: number;
}

export const NEW_CARD_STATE: ReplayInitial = { stability: 0, difficulty: 0, srsState: "new", reviewCount: 0 };

function timeOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Deterministic replay order: (reviewedAt, hlc, id). */
export function compareReplayEvents(a: ReplayEvent, b: ReplayEvent): number {
  const dt = timeOf(a.reviewedAt) - timeOf(b.reviewedAt);
  if (dt !== 0) return dt;
  const ha = a.hlc ?? "";
  const hb = b.hlc ?? "";
  if (ha !== hb) return ha < hb ? -1 : 1;
  const ia = a.id.toLowerCase();
  const ib = b.id.toLowerCase();
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Events that count: not a void marker, not voided, valid grade. */
export function effectiveReviewEvents<E extends ReplayEvent>(events: readonly E[]): E[] {
  const voided = new Set<string>();
  for (const e of events) if (e.voidsEventId) voided.add(e.voidsEventId.toLowerCase());
  return events.filter((e) => !e.voidsEventId && !voided.has(e.id.toLowerCase()) && isGrade(e.grade));
}

/**
 * Rebuild a card's SRS state from its full event history (sync spec §6). Elapsed days are
 * recomputed from consecutive local review dates (never taken from the event). Each event's
 * recorded `dateLocal` and `desiredRetention` are used when present, so replay is deterministic
 * across devices and time zones; `opts` only fills in for legacy events that lack them.
 */
export function replayCard(
  initial: ReplayInitial | null | undefined,
  events: readonly ReplayEvent[],
  opts: ScheduleOptions = {},
): ReplayResult {
  const start = initial ?? NEW_CARD_STATE;
  const desiredRetention = opts.desiredRetention ?? DEFAULT_DESIRED_RETENTION;
  const ordered = effectiveReviewEvents(events).sort(compareReplayEvents);

  let stability = start.stability;
  let difficulty = start.difficulty;
  let srsState: SrsState = start.srsState ?? (stability === 0 && difficulty === 0 ? "new" : "review");
  let dueDate = start.dueDate ?? "";
  let lastReviewedAt = start.lastReviewedAt ?? null;
  let reviewCount = start.reviewCount ?? 0;
  let lastDateLocal: string | null = null;

  for (const event of ordered) {
    const grade = event.grade as Grade;
    const dateLocal =
      event.dateLocal && isValidLocalDate(event.dateLocal) ? event.dateLocal : localDateString(event.reviewedAt, opts.timeZone);
    const retention =
      typeof event.desiredRetention === "number" && event.desiredRetention > 0 && event.desiredRetention <= 1
        ? event.desiredRetention
        : desiredRetention;
    const elapsed = elapsedDaysForReview({ stability, difficulty, lastReviewedAt, dueDate }, dateLocal, { ...opts, lastReviewedDateLocal: lastDateLocal });
    const update = nextReview(stability, difficulty, elapsed, grade, retention);
    stability = update.stability;
    difficulty = update.difficulty;
    srsState = update.state;
    dueDate = dueDateFor(grade, update.intervalDays, dateLocal);
    lastReviewedAt = new Date(event.reviewedAt).toISOString();
    lastDateLocal = dateLocal;
    reviewCount += 1;
  }

  return { srsState, stability, difficulty, dueDate, lastReviewedAt, reviewCount, schedulerVersion: SCHEDULER_VERSION };
}

// MARK: - retention band (spec §5)

export type RetentionBand = "new" | "strong" | "fading" | "weak";

export function cardRetrievability(
  card: Pick<SrsCardState, "stability" | "lastReviewedAt">,
  now: Date = new Date(),
): number {
  if (!card.lastReviewedAt) return card.stability > 0 ? 1 : 0;
  const days = (now.getTime() - timeOf(card.lastReviewedAt)) / DAY_MS;
  return retrievability(card.stability, Math.max(days, 0));
}

export function retentionBand(
  card: Pick<SrsCardState, "srsState" | "stability" | "lastReviewedAt">,
  now: Date = new Date(),
): RetentionBand {
  if (card.srsState === "new") return "new";
  const r = cardRetrievability(card, now);
  if (r >= 0.9) return "strong";
  if (r >= 0.7) return "fading";
  return "weak";
}

// MARK: - queues (spec §3)

export type QueueCard = Pick<SrsCardState, "srsState" | "dueDate" | "lastReviewedAt" | "suspendedAt"> & {
  packIds?: readonly string[];
};

export interface QueueOptions {
  /** Filter to one pack; omitted or "all" = no filter. */
  packId?: string | null;
  newLimit?: number;
  reviewLimit?: number;
}

/** Unparseable due dates count as due. */
export function isDueOnOrBefore(dueDate: string, dateLocal: string): boolean {
  return !isValidLocalDate(dueDate) || dueDate <= dateLocal;
}

/** (dueDate, lastReviewedAt) ascending; never-reviewed first. */
export function compareDueThenLastReview(a: QueueCard, b: QueueCard): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  const la = a.lastReviewedAt ? timeOf(a.lastReviewedAt) : null;
  const lb = b.lastReviewedAt ? timeOf(b.lastReviewedAt) : null;
  if (la === lb) return 0;
  if (la === null) return -1;
  if (lb === null) return 1;
  return la - lb;
}

function activeInPack<C extends QueueCard>(cards: readonly C[], packId: string | null | undefined): C[] {
  return cards.filter(
    (c) => !c.suspendedAt && (!packId || packId === "all" || (c.packIds ?? []).includes(packId)),
  );
}

/**
 * Today's queue: new+learning first, then review. `newLimit` caps only cards still in
 * state "new" — learning cards (same-day steps, §2.8) always stay in.
 */
export function dueQueue<C extends QueueCard>(cards: readonly C[], dateLocal: string, opts: QueueOptions = {}): C[] {
  const newLimit = Math.max(opts.newLimit ?? DEFAULT_DAILY_NEW_LIMIT, 0);
  const reviewLimit = Math.max(opts.reviewLimit ?? DEFAULT_DAILY_REVIEW_LIMIT, 0);
  const due = activeInPack(cards, opts.packId).filter((c) => isDueOnOrBefore(c.dueDate, dateLocal));

  const newLearning = due.filter((c) => c.srsState !== "review").sort(compareDueThenLastReview);
  const review = due.filter((c) => c.srsState === "review").sort(compareDueThenLastReview);

  let taken = 0;
  const firstGroup = newLearning.filter((c) => c.srsState !== "new" || ++taken <= newLimit);
  return [...firstGroup, ...review.slice(0, reviewLimit)];
}

/** "Review ahead": cards due strictly after today; never overlaps `dueQueue`. */
export function aheadQueue<C extends QueueCard>(
  cards: readonly C[],
  dateLocal: string,
  opts: { packId?: string | null; limit?: number } = {},
): C[] {
  return activeInPack(cards, opts.packId)
    .filter((c) => !isDueOnOrBefore(c.dueDate, dateLocal))
    .sort(compareDueThenLastReview)
    .slice(0, Math.max(opts.limit ?? 20, 0));
}
