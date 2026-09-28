# Sync contract fixtures

Language-neutral test vectors for `docs/specs/sync-protocol-spec.md`. Every client (TypeScript
`packages/client`, Swift, Rust) must load these files in its test suite and pass all cases.
The TypeScript reference tests are `packages/client/test/merge.test.ts` and `replay.test.ts`.

All ids are lowercase UUID strings, dates are ISO-8601 UTC, and HLCs use the
`<13-digit wall ms>-<4-digit counter>-<8-hex node>` format. HLCs compare as plain strings.

## `merge-cases.json` (spec §4, §6)

```jsonc
{
  "version": 1,
  "cases": [{
    "name": "lww-local-newer",
    "description": "…",
    "local":  LocalRecord | null,   // the client's copy before the merge
    "remote": SyncRecord,           // wire record from pull (or a push conflict's `current`)
    "context": { "localSegmentRevision": 1 },   // optional, Segment only (see below)
    "expected": {
      "outcome": "remote" | "local" | "merged" | "acknowledge" | "ignore",
      "record": LocalRecord | null, // exact local state to write; null = no write
      "retick": false,              // true = give the record a fresh local HLC before pushing
      "purgeSegmentsBelow": { "articleId": "…", "revision": 1 }   // optional
    }
  }]
}
```

`LocalRecord` = `{ type, id, rev, hlc, deleted, payload, dirty }`. `rev` is the last server rev
seen (sent as `baseRev`; 0 = never pushed). `dirty` = has an unacknowledged local change.
`SyncRecord` is the wire format of spec §2.1.

Outcomes:

| outcome | meaning |
|---|---|
| `remote` | Replace local with the remote record, `dirty = false`. |
| `local` | Local wins. Keep its payload (possibly with Segment fields filled), set `rev = remote.rev`, `dirty = true` so it is re-pushed with the right `baseRev`. |
| `merged` | Remote won LWW but local contributed fields (Segment fill). `dirty = true`, and the client must tick a new HLC (`retick`). |
| `acknowledge` | Same write already known (equal HLC — e.g. our own push echoed back by pull) or an existing immutable ReviewEvent: keep the local payload, adopt `max(rev)`, `dirty = false`. |
| `ignore` | Drop the remote record (stale rev, lower segment revision, ReviewEvent tombstone). |

Rules, in evaluation order:

1. `ReviewEvent`: remote tombstone → `ignore`; existing live local → `acknowledge`; else `remote`.
2. `remote.rev < local.rev` → `ignore` (stale).
3. Live remote `Segment`: compare `segmentationRevision` (missing = 0) with the article's local
   revision — `context.localSegmentRevision` (max over live local segments of the same
   `articleId`) or, if absent, the same-id live local record. Lower → `ignore`; higher →
   `remote` + `purgeSegmentsBelow` (the client locally deletes that article's live segments with a
   lower revision, without marking them dirty); equal → continue with LWW + fill.
   Remote Segment tombstones skip this step.
4. No local → `remote`.
5. HLC LWW, tombstones included: equal → `acknowledge`; remote larger → `remote` (or `merged` if
   the Segment fill changed something); local larger → `local`.
   Segment fill = copy `translation`, `readingText`, `explanation` from the loser into the winner
   where the winner's value is missing, `null` or `""`.

Unknown payload fields must round-trip untouched.

## `replay-cases.json` (spec §6)

```jsonc
{
  "version": 1,
  "defaults": { "timeZone": "UTC", "desiredRetention": 0.9 },  // only for legacy events lacking the fields
  "cases": [{
    "name": "unordered",
    "initial": null | { "stability", "difficulty", "srsState", "dueDate", "lastReviewedAt", "reviewCount" },
    "events": [{ "id", "hlc", "payload": { "vocabularyId", "reviewedAt", "dateLocal"?, "grade",
                                           "desiredRetention"?, "voidsEventId"? } }],
    "expected": { "srsState", "stability", "difficulty", "dueDate", "lastReviewedAt",
                  "reviewCount", "schedulerVersion" }
  }]
}
```

Replay procedure the expectations were frozen from (`@openkoto/core` `replayCard`, ts-fsrs 5.4.1):

1. De-duplicate events by lowercased `id` (first occurrence wins).
2. Drop void markers (events with `voidsEventId`) and every event a marker voids (ids compared
   lowercase), and events whose grade is not 1–4.
3. Sort by `(reviewedAt instant, hlc string, lowercased id)`.
4. Starting from `initial` (null = new card: S = D = 0, state `new`, reviewCount 0), apply FSRS-6
   per event using the event's own `dateLocal` and `desiredRetention` (fallback: `defaults`).
   Elapsed days = calendar-day difference between consecutive `dateLocal`s.
5. `lastReviewedAt` is re-serialised as `toISOString()` (millisecond precision, `Z`).

Compare `stability` / `difficulty` with a tolerance of 1e-6 (the values are rounded to 8 decimals by
ts-fsrs); every other field must match exactly.

Regenerate only when the scheduler version changes; never edit expectations by hand.
