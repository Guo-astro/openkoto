//! Card replay from ReviewEvents (sync-protocol-spec §6).
//! Port of `replayCard` / `effectiveReviewEvents` (packages/core/src/fsrs.ts) and
//! `replayEvents` (packages/client/src/sync/replay.ts).
//! Contract fixture: `docs/specs/fixtures/sync/replay-cases.json`.

use super::protocol::JsonObject;
use crate::fsrs;
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;

/// Which calendar is used for events lacking `dateLocal` and for `lastReviewedAt` → date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayTimeZone {
    Utc,
    Local,
}

#[derive(Debug, Clone)]
pub struct ReplayOptions {
    /// Fallback for legacy events without `desiredRetention`.
    pub desired_retention: f64,
    pub time_zone: ReplayTimeZone,
}

impl Default for ReplayOptions {
    fn default() -> Self {
        Self {
            desired_retention: fsrs::DEFAULT_DESIRED_RETENTION,
            time_zone: ReplayTimeZone::Local,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayEvent {
    pub id: String,
    pub reviewed_at: String,
    /// Raw grade; only integers 1..=4 count.
    pub grade: f64,
    pub voids_event_id: Option<String>,
    /// Record HLC, second sort key.
    pub hlc: Option<String>,
    pub date_local: Option<String>,
    pub desired_retention: Option<f64>,
}

/// Start state: a brand-new card (None) or an SM-2 seeded one.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReplayInitial {
    pub stability: f64,
    pub difficulty: f64,
    pub srs_state: Option<String>,
    pub due_date: Option<String>,
    pub last_reviewed_at: Option<String>,
    pub review_count: Option<i64>,
    /// Desktop extension: local day of the last review before the first event (SM-2 seeds whose
    /// exact last-review instant is unknown). Takes precedence over `last_reviewed_at`.
    pub last_date_local: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayResult {
    pub srs_state: String,
    pub stability: f64,
    pub difficulty: f64,
    pub due_date: String,
    pub last_reviewed_at: Option<String>,
    pub review_count: i64,
    pub scheduler_version: String,
}

/// A ReviewEvent record → replay input (record HLC is the second sort key).
pub fn replay_event_from_payload(
    id: &str,
    hlc: Option<&str>,
    payload: &JsonObject,
) -> Option<ReplayEvent> {
    let reviewed_at = payload.get("reviewedAt")?.as_str()?.to_string();
    let grade = match payload.get("grade") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    Some(ReplayEvent {
        id: id.to_lowercase(),
        reviewed_at,
        grade,
        voids_event_id: payload
            .get("voidsEventId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase),
        hlc: hlc.map(str::to_string),
        date_local: payload
            .get("dateLocal")
            .and_then(Value::as_str)
            .map(str::to_string),
        desired_retention: payload.get("desiredRetention").and_then(Value::as_f64),
    })
}

fn time_of(iso: &str) -> i64 {
    DateTime::parse_from_rfc3339(iso)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// `toISOString()`: millisecond precision, `Z`.
pub fn to_iso_millis(iso: &str) -> String {
    match DateTime::parse_from_rfc3339(iso) {
        Ok(d) => d
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        Err(_) => iso.to_string(),
    }
}

fn parse_local_date(value: &str) -> Option<NaiveDate> {
    if value.len() != 10 {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn local_date_string(iso: &str, tz: ReplayTimeZone) -> Option<String> {
    let dt = DateTime::parse_from_rfc3339(iso).ok()?;
    let date = match tz {
        ReplayTimeZone::Utc => dt.with_timezone(&Utc).date_naive(),
        ReplayTimeZone::Local => dt.with_timezone(&chrono::Local).date_naive(),
    };
    Some(date.format("%Y-%m-%d").to_string())
}

fn is_grade(g: f64) -> bool {
    g.fract() == 0.0 && (1.0..=4.0).contains(&g)
}

/// Deterministic replay order: (reviewedAt, hlc, lowercased id).
pub fn compare_replay_events(a: &ReplayEvent, b: &ReplayEvent) -> Ordering {
    time_of(&a.reviewed_at)
        .cmp(&time_of(&b.reviewed_at))
        .then_with(|| {
            a.hlc
                .as_deref()
                .unwrap_or("")
                .cmp(b.hlc.as_deref().unwrap_or(""))
        })
        .then_with(|| a.id.to_lowercase().cmp(&b.id.to_lowercase()))
}

/// Events that count: not a void marker, not voided, valid grade.
pub fn effective_review_events(events: &[ReplayEvent]) -> Vec<ReplayEvent> {
    let voided: HashSet<String> = events
        .iter()
        .filter_map(|e| e.voids_event_id.as_ref().map(|v| v.to_lowercase()))
        .collect();
    events
        .iter()
        .filter(|e| {
            e.voids_event_id.is_none()
                && !voided.contains(&e.id.to_lowercase())
                && is_grade(e.grade)
        })
        .cloned()
        .collect()
}

fn elapsed_days(
    stability: f64,
    difficulty: f64,
    last_reviewed_at: Option<&str>,
    last_date_local: Option<&str>,
    date_local: NaiveDate,
    tz: ReplayTimeZone,
) -> i64 {
    if stability == 0.0 && difficulty == 0.0 {
        return 0;
    }
    if let Some(last) = last_date_local.and_then(parse_local_date) {
        return (date_local - last).num_days().max(0);
    }
    if let Some(last) = last_reviewed_at
        .and_then(|s| local_date_string(s, tz))
        .and_then(|s| parse_local_date(&s))
    {
        return (date_local - last).num_days().max(0);
    }
    0
}

/// Rebuild a card's SRS state from its full event history.
pub fn replay_card(
    initial: Option<&ReplayInitial>,
    events: &[ReplayEvent],
    opts: &ReplayOptions,
) -> ReplayResult {
    let start = initial.cloned().unwrap_or_default();
    let mut ordered = effective_review_events(events);
    ordered.sort_by(compare_replay_events);

    let mut stability = start.stability;
    let mut difficulty = start.difficulty;
    let mut srs_state = start.srs_state.clone().unwrap_or_else(|| {
        if stability == 0.0 && difficulty == 0.0 {
            "new".to_string()
        } else {
            "review".to_string()
        }
    });
    let mut due_date = start.due_date.clone().unwrap_or_default();
    let mut last_reviewed_at = start.last_reviewed_at.clone();
    let mut review_count = start.review_count.unwrap_or(0);
    let mut last_date_local: Option<String> = start.last_date_local.clone();

    for event in &ordered {
        let grade = event.grade as u8;
        let date_local_str = event
            .date_local
            .as_deref()
            .filter(|d| parse_local_date(d).is_some())
            .map(str::to_string)
            .or_else(|| local_date_string(&event.reviewed_at, opts.time_zone))
            .unwrap_or_default();
        let Some(date_local) = parse_local_date(&date_local_str) else {
            continue;
        };
        let retention = event
            .desired_retention
            .filter(|r| *r > 0.0 && *r <= 1.0)
            .unwrap_or(opts.desired_retention);
        let elapsed = elapsed_days(
            stability,
            difficulty,
            last_reviewed_at.as_deref(),
            last_date_local.as_deref(),
            date_local,
            opts.time_zone,
        );
        let Ok(update) = fsrs::next_review(stability, difficulty, elapsed, grade, retention) else {
            continue;
        };
        stability = update.stability;
        difficulty = update.difficulty;
        srs_state = update.srs_state.clone();
        due_date = due_date_for(grade, update.interval_days, date_local);
        last_reviewed_at = Some(to_iso_millis(&event.reviewed_at));
        last_date_local = Some(date_local_str);
        review_count += 1;
    }

    ReplayResult {
        srs_state,
        stability,
        difficulty,
        due_date,
        last_reviewed_at,
        review_count,
        scheduler_version: fsrs::SCHEDULER_VERSION.to_string(),
    }
}

/// Next due date with same-day learning steps (SRS spec §2.8): only a pass (Good/Easy) pushes
/// the card into the future.
pub fn due_date_for(grade: u8, interval_days: i32, date_local: NaiveDate) -> String {
    let date = if grade >= 3 {
        date_local + chrono::Duration::days(interval_days as i64)
    } else {
        date_local
    };
    date.format("%Y-%m-%d").to_string()
}

/// De-duplicate by (lowercased) id — the same event delivered twice counts once — then replay.
pub fn replay_events(
    initial: Option<&ReplayInitial>,
    events: &[ReplayEvent],
    opts: &ReplayOptions,
) -> ReplayResult {
    let mut seen = HashSet::new();
    let mut unique = Vec::with_capacity(events.len());
    for e in events {
        let id = e.id.to_lowercase();
        if seen.insert(id.clone()) {
            unique.push(ReplayEvent {
                id,
                voids_event_id: e.voids_event_id.as_ref().map(|v| v.to_lowercase()),
                ..e.clone()
            });
        }
    }
    replay_card(initial, &unique, opts)
}

fn number(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Overwrite the replay-owned fields of a Vocabulary payload; None if nothing changed.
pub fn apply_replay_to_payload(payload: &JsonObject, result: &ReplayResult) -> Option<JsonObject> {
    let mut next = payload.clone();
    let mut changed = false;
    let mut set = |key: &str, value: Value| {
        let same = match (next.get(key), &value) {
            (Some(Value::Number(a)), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Some(a), b) => a == b,
            (None, _) => false,
        };
        if !same {
            next.insert(key.to_string(), value);
            changed = true;
        }
    };
    set("srsState", Value::String(result.srs_state.clone()));
    set("stability", number(result.stability));
    set("difficulty", number(result.difficulty));
    set("dueDate", Value::String(result.due_date.clone()));
    set(
        "lastReviewedAt",
        result
            .last_reviewed_at
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    set("reviewCount", Value::from(result.review_count));
    set(
        "schedulerVersion",
        Value::String(result.scheduler_version.clone()),
    );
    changed.then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const FIXTURE: &str = include_str!("../../../../docs/specs/fixtures/sync/replay-cases.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Defaults {
        time_zone: String,
        desired_retention: f64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Initial {
        stability: f64,
        difficulty: f64,
        srs_state: Option<String>,
        due_date: Option<String>,
        last_reviewed_at: Option<String>,
        review_count: Option<i64>,
    }

    #[derive(Deserialize)]
    struct Event {
        id: String,
        hlc: String,
        payload: JsonObject,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        srs_state: String,
        stability: f64,
        difficulty: f64,
        due_date: String,
        last_reviewed_at: Option<String>,
        review_count: i64,
        scheduler_version: String,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        initial: Option<Initial>,
        events: Vec<Event>,
        expected: Expected,
    }

    #[derive(Deserialize)]
    struct Fixture {
        defaults: Defaults,
        cases: Vec<Case>,
    }

    fn run(case: &Case, opts: &ReplayOptions, reversed: bool) -> ReplayResult {
        let initial = case.initial.as_ref().map(|i| ReplayInitial {
            stability: i.stability,
            difficulty: i.difficulty,
            srs_state: i.srs_state.clone(),
            due_date: i.due_date.clone(),
            last_reviewed_at: i.last_reviewed_at.clone(),
            review_count: i.review_count,
            last_date_local: None,
        });
        let mut events: Vec<ReplayEvent> = case
            .events
            .iter()
            .map(|e| replay_event_from_payload(&e.id, Some(&e.hlc), &e.payload).unwrap())
            .collect();
        if reversed {
            events.reverse();
        }
        replay_events(initial.as_ref(), &events, opts)
    }

    #[test]
    fn passes_replay_contract_fixture() {
        let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(fixture.defaults.time_zone, "UTC");
        let opts = ReplayOptions {
            desired_retention: fixture.defaults.desired_retention,
            time_zone: ReplayTimeZone::Utc,
        };
        assert!(fixture.cases.len() >= 9);
        for case in &fixture.cases {
            let got = run(case, &opts, false);
            let e = &case.expected;
            assert_eq!(got.srs_state, e.srs_state, "{} state", case.name);
            assert!(
                (got.stability - e.stability).abs() <= 1e-6,
                "{} stability {} vs {}",
                case.name,
                got.stability,
                e.stability
            );
            assert!(
                (got.difficulty - e.difficulty).abs() <= 1e-6,
                "{} difficulty {} vs {}",
                case.name,
                got.difficulty,
                e.difficulty
            );
            assert_eq!(got.due_date, e.due_date, "{} due", case.name);
            assert_eq!(
                got.last_reviewed_at, e.last_reviewed_at,
                "{} last",
                case.name
            );
            assert_eq!(got.review_count, e.review_count, "{} count", case.name);
            assert_eq!(got.scheduler_version, e.scheduler_version, "{}", case.name);
            // Order of delivery never matters.
            assert_eq!(run(case, &opts, true), got, "{} reversed", case.name);
        }
    }

    #[test]
    fn void_markers_and_voided_events_are_skipped() {
        let mk = |id: &str, at: &str, grade: f64, voids: Option<&str>| ReplayEvent {
            id: id.into(),
            reviewed_at: at.into(),
            grade,
            voids_event_id: voids.map(str::to_string),
            hlc: None,
            date_local: Some(at[..10].to_string()),
            desired_retention: Some(0.9),
        };
        let events = vec![
            mk("A", "2026-09-01T10:00:00Z", 3.0, None),
            mk("b", "2026-09-02T10:00:00Z", 1.0, None),
            mk("c", "2026-09-02T10:05:00Z", 0.0, Some("B")),
        ];
        let eff = effective_review_events(&events);
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].id, "A");
        let r = replay_events(None, &events, &ReplayOptions::default());
        assert_eq!(r.review_count, 1);
        assert_eq!(r.srs_state, "review");
    }

    #[test]
    fn apply_replay_reports_no_ops() {
        let result = ReplayResult {
            srs_state: "review".into(),
            stability: 2.3065,
            difficulty: 2.11810397,
            due_date: "2026-09-04".into(),
            last_reviewed_at: Some("2026-09-01T10:00:00.000Z".into()),
            review_count: 1,
            scheduler_version: "fsrs6".into(),
        };
        let mut payload = JsonObject::new();
        payload.insert("word".into(), Value::String("x".into()));
        let next = apply_replay_to_payload(&payload, &result).unwrap();
        assert_eq!(next["word"], "x");
        assert_eq!(next["reviewCount"], 1);
        assert!(apply_replay_to_payload(&next, &result).is_none());
    }
}
