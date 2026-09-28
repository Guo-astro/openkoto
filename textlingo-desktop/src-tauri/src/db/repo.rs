//! Domain reads/writes on the SQLite tables, with sync change tracking.
//!
//! Every local mutation goes through here with [`Track::Record`], which marks the matching
//! sync record dirty with a fresh HLC (sync-protocol-spec §8). The sync engine applies remote
//! records with [`Track::Skip`] so they are not echoed back.

use super::sql_err;
use crate::sync::hlc::legacy_hlc;
use crate::sync::payload::{self, DESKTOP_SYSTEM_PACK_ID};
use crate::sync::protocol::JsonObject;
use crate::sync::store::{self, RecordChange};
use crate::types::{Article, ArticleSegment, Bookmark, FavoriteVocabulary, ReviewEvent, WordPack};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Track {
    /// Local user change: record it for sync with a fresh HLC.
    Record,
    /// One-time legacy import: record it with a legacy HLC synthesised from the timestamps.
    Legacy,
    /// Remote change applied by the sync engine: do not record.
    Skip,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn record(
    conn: &Connection,
    track: Track,
    record_type: &str,
    id: &str,
    payload: Option<JsonObject>,
    legacy_time: &str,
) -> Result<RecordChange, String> {
    match track {
        Track::Skip => Ok(RecordChange::Unchanged),
        Track::Record => store::record_local_change(conn, record_type, id, payload, None),
        Track::Legacy => store::record_local_change(
            conn,
            record_type,
            id,
            payload,
            Some(legacy_hlc(legacy_time)),
        ),
    }
}

fn mark_deleted(conn: &Connection, table: &str, id: &str) -> Result<(), String> {
    conn.execute(
        "insert into deleted_record (table_name, record_id, deleted_at) values (?1, ?2, ?3)
         on conflict(table_name, record_id) do update set deleted_at = excluded.deleted_at",
        params![table, id, now()],
    )
    .map(|_| ())
    .map_err(sql_err)
}

fn unmark_deleted(conn: &Connection, table: &str, id: &str) -> Result<(), String> {
    conn.execute(
        "delete from deleted_record where table_name = ?1 and record_id = ?2",
        params![table, id],
    )
    .map(|_| ())
    .map_err(sql_err)
}

// ============================================================================
// Vocabulary + memberships
// ============================================================================

fn row_to_vocabulary(r: &Row) -> rusqlite::Result<FavoriteVocabulary> {
    Ok(FavoriteVocabulary {
        id: r.get("id")?,
        word: r.get("word")?,
        meaning: r.get("meaning")?,
        usage: r.get::<_, Option<String>>("usage")?.unwrap_or_default(),
        explanation: r.get("explanation")?,
        example: r.get("example")?,
        reading: r.get("reading")?,
        source_article_id: r.get("source_article_id")?,
        source_article_title: r.get("source_article_title")?,
        pack_ids: Vec::new(),
        srs_state: r.get("srs_state")?,
        ease_factor: r.get("ease_factor")?,
        repetitions: r.get("repetitions")?,
        interval_days: r.get("interval_days")?,
        stability: r.get("stability")?,
        difficulty: r.get("difficulty")?,
        scheduler_version: r.get("scheduler_version")?,
        suspended_at: r.get("suspended_at")?,
        due_date: r.get("due_date")?,
        last_reviewed_at: r.get("last_reviewed_at")?,
        review_count: r.get("review_count")?,
        created_at: r.get("created_at")?,
    })
}

fn membership_rows(
    conn: &Connection,
    vocabulary_id: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "select pack_id, created_at from word_pack_membership where vocabulary_id = ?1 order by position, rowid",
        )
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([vocabulary_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

fn all_memberships(conn: &Connection) -> Result<HashMap<String, Vec<String>>, String> {
    let mut stmt = conn
        .prepare("select vocabulary_id, pack_id from word_pack_membership order by position, rowid")
        .map_err(sql_err)?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(sql_err)?;
    for row in rows {
        let (v, p) = row.map_err(sql_err)?;
        map.entry(v).or_default().push(p);
    }
    Ok(map)
}

/// A card always belongs to at least one pack (SRS spec §1.2): no membership rows = ungrouped.
fn with_default_pack(pack_ids: Vec<String>) -> Vec<String> {
    if pack_ids.is_empty() {
        vec![DESKTOP_SYSTEM_PACK_ID.to_string()]
    } else {
        pack_ids
    }
}

pub fn load_vocabulary(conn: &Connection, id: &str) -> Result<Option<FavoriteVocabulary>, String> {
    let fav = conn
        .query_row(
            "select * from favorite_vocabulary where id = ?1",
            [id],
            row_to_vocabulary,
        )
        .optional()
        .map_err(sql_err)?;
    match fav {
        Some(mut fav) => {
            fav.pack_ids = with_default_pack(
                membership_rows(conn, &fav.id)?
                    .into_iter()
                    .map(|(p, _)| p)
                    .collect(),
            );
            Ok(Some(fav))
        }
        None => Ok(None),
    }
}

pub fn list_vocabularies(conn: &Connection) -> Result<Vec<FavoriteVocabulary>, String> {
    let mut memberships = all_memberships(conn)?;
    let mut stmt = conn
        .prepare("select * from favorite_vocabulary order by created_at, rowid")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], row_to_vocabulary)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows
        .into_iter()
        .map(|mut fav| {
            fav.pack_ids = with_default_pack(memberships.remove(&fav.id).unwrap_or_default());
            fav
        })
        .collect())
}

pub fn list_vocabulary_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("select id from favorite_vocabulary order by created_at, rowid")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

pub fn vocabulary_updated_at(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select updated_at from favorite_vocabulary where id = ?1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql_err)
}

pub fn vocabulary_replay_seed(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select replay_seed_json from favorite_vocabulary where id = ?1",
        [id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|o| o.flatten())
    .map_err(sql_err)
}

pub fn set_vocabulary_replay_seed(
    conn: &Connection,
    id: &str,
    seed: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "update favorite_vocabulary set replay_seed_json = ?2 where id = ?1",
        params![id, seed],
    )
    .map(|_| ())
    .map_err(sql_err)
}

/// Seed of an SM-2 card at the moment it was converted to FSRS (sync spec §6 replay start).
fn sm2_seed_json(fav: &FavoriteVocabulary) -> Option<String> {
    if fav.review_count <= 0 || fav.srs_state == "new" {
        return None;
    }
    serde_json::to_string(&serde_json::json!({
        "stability": fav.stability,
        "difficulty": fav.difficulty,
        "srsState": fav.srs_state,
        "dueDate": fav.due_date,
        "lastReviewedAt": fav.last_reviewed_at,
        "reviewCount": fav.review_count,
    }))
    .ok()
}

fn sanitize_pack_ids(pack_ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    pack_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect()
}

pub struct VocabularyWrite<'a> {
    pub fav: &'a FavoriteVocabulary,
    /// Explicit `updated_at` (legacy import / remote apply); None = now when changed.
    pub updated_at: Option<&'a str>,
    /// Replace the card's memberships with `fav.pack_ids`.
    pub memberships: bool,
    pub track: Track,
}

/// Upsert a card (and its memberships). Returns true when anything changed.
pub fn save_vocabulary(conn: &Connection, w: VocabularyWrite) -> Result<bool, String> {
    let fav = w.fav;
    let existing = load_vocabulary(conn, &fav.id)?;
    let existing_row_version: Option<Option<String>> = if existing.is_some() {
        Some(
            conn.query_row(
                "select scheduler_version from favorite_vocabulary where id = ?1",
                [&fav.id],
                |r| r.get(0),
            )
            .map_err(sql_err)?,
        )
    } else {
        None
    };

    let mut compare_new = fav.clone();
    let mut compare_old = existing.clone();
    compare_new.pack_ids.clear();
    if let Some(old) = compare_old.as_mut() {
        old.pack_ids.clear();
    }
    let fields_changed = match &compare_old {
        Some(old) => serde_json::to_value(old).ok() != serde_json::to_value(&compare_new).ok(),
        None => true,
    };

    if fields_changed {
        let updated_at = w.updated_at.map(str::to_string).unwrap_or_else(now);
        conn.execute(
            "insert into favorite_vocabulary (id, word, normalized_word, meaning, usage, explanation, example, reading,
               source_article_id, source_article_title, srs_state, stability, difficulty, scheduler_version,
               suspended_at, due_date, last_reviewed_at, review_count, ease_factor, repetitions, interval_days,
               created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
             on conflict(id) do update set word = excluded.word, normalized_word = excluded.normalized_word,
               meaning = excluded.meaning, usage = excluded.usage, explanation = excluded.explanation,
               example = excluded.example, reading = excluded.reading, source_article_id = excluded.source_article_id,
               source_article_title = excluded.source_article_title, srs_state = excluded.srs_state,
               stability = excluded.stability, difficulty = excluded.difficulty,
               scheduler_version = excluded.scheduler_version, suspended_at = excluded.suspended_at,
               due_date = excluded.due_date, last_reviewed_at = excluded.last_reviewed_at,
               review_count = excluded.review_count, ease_factor = excluded.ease_factor,
               repetitions = excluded.repetitions, interval_days = excluded.interval_days,
               created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                fav.id,
                fav.word,
                fav.word.trim().to_lowercase(),
                fav.meaning,
                fav.usage,
                fav.explanation,
                fav.example,
                fav.reading,
                fav.source_article_id,
                fav.source_article_title,
                fav.srs_state,
                fav.stability,
                fav.difficulty,
                fav.scheduler_version,
                fav.suspended_at,
                fav.due_date,
                fav.last_reviewed_at,
                fav.review_count,
                fav.ease_factor,
                fav.repetitions,
                fav.interval_days,
                fav.created_at,
                updated_at,
            ],
        )
        .map_err(sql_err)?;
        unmark_deleted(conn, "favorite_vocabulary", &fav.id)?;
        // SM-2 → FSRS conversion happening now: remember the seed for later replays.
        if matches!(existing_row_version, Some(None)) && fav.scheduler_version.is_some() {
            set_vocabulary_replay_seed(conn, &fav.id, sm2_seed_json(fav).as_deref())?;
        }
    }

    let mut memberships_changed = false;
    if w.memberships {
        let wanted = sanitize_pack_ids(&fav.pack_ids);
        let current: Vec<(String, String)> = membership_rows(conn, &fav.id)?;
        let current_ids: Vec<String> = current.iter().map(|(p, _)| p.clone()).collect();
        if current_ids != wanted {
            memberships_changed = true;
            let wanted_set: HashSet<&String> = wanted.iter().collect();
            for (pack_id, _) in &current {
                if !wanted_set.contains(pack_id) {
                    conn.execute(
                        "delete from word_pack_membership where vocabulary_id = ?1 and pack_id = ?2",
                        params![fav.id, pack_id],
                    )
                    .map_err(sql_err)?;
                    if payload::membership_payload(&fav.id, pack_id, &now()).is_some() {
                        record(
                            conn,
                            w.track,
                            "WordPackMembership",
                            &payload::membership_id(&fav.id, pack_id),
                            None,
                            &fav.created_at,
                        )?;
                    }
                }
            }
            let created_at = w.updated_at.map(str::to_string).unwrap_or_else(now);
            for (position, pack_id) in wanted.iter().enumerate() {
                let existed = current_ids.contains(pack_id);
                conn.execute(
                    "insert into word_pack_membership (vocabulary_id, pack_id, position, created_at)
                     values (?1, ?2, ?3, ?4)
                     on conflict(vocabulary_id, pack_id) do update set position = excluded.position",
                    params![fav.id, pack_id, position as i64, created_at],
                )
                .map_err(sql_err)?;
                if !existed {
                    if let Some(p) = payload::membership_payload(&fav.id, pack_id, &created_at) {
                        record(
                            conn,
                            w.track,
                            "WordPackMembership",
                            &payload::membership_id(&fav.id, pack_id),
                            Some(p),
                            &fav.created_at,
                        )?;
                    }
                }
            }
        }
    }

    if fields_changed || memberships_changed || w.track == Track::Legacy {
        record_vocabulary(conn, &fav.id, w.track)?;
    }
    Ok(fields_changed || memberships_changed)
}

/// (Re)build the Vocabulary payload from the row and record it.
pub fn record_vocabulary(conn: &Connection, id: &str, track: Track) -> Result<(), String> {
    if track == Track::Skip {
        return Ok(());
    }
    let Some(fav) = load_vocabulary(conn, id)? else {
        return Ok(());
    };
    let updated_at = vocabulary_updated_at(conn, id)?.unwrap_or_else(now);
    if let Some(p) = payload::vocabulary_payload(&fav, &updated_at) {
        record(conn, track, "Vocabulary", id, Some(p), &updated_at)?;
    }
    Ok(())
}

pub fn delete_vocabulary(conn: &Connection, id: &str, track: Track) -> Result<bool, String> {
    let memberships = membership_rows(conn, id)?;
    let n = conn
        .execute("delete from favorite_vocabulary where id = ?1", [id])
        .map_err(sql_err)?;
    conn.execute(
        "delete from word_pack_membership where vocabulary_id = ?1",
        [id],
    )
    .map_err(sql_err)?;
    if n > 0 {
        mark_deleted(conn, "favorite_vocabulary", id)?;
    }
    for (pack_id, _) in memberships {
        if payload::membership_payload(id, &pack_id, &now()).is_some() {
            record(
                conn,
                track,
                "WordPackMembership",
                &payload::membership_id(id, &pack_id),
                None,
                "",
            )?;
        }
    }
    if payload::is_uuid(id) {
        record(conn, track, "Vocabulary", id, None, "")?;
    }
    Ok(n > 0)
}

/// Remote membership apply (no tracking).
pub fn set_membership(
    conn: &Connection,
    vocabulary_id: &str,
    pack_id: &str,
    present: bool,
    created_at: &str,
) -> Result<(), String> {
    if present {
        conn.execute(
            "insert into word_pack_membership (vocabulary_id, pack_id, position, created_at)
             values (?1, ?2, (select coalesce(max(position), -1) + 1 from word_pack_membership where vocabulary_id = ?1), ?3)
             on conflict(vocabulary_id, pack_id) do nothing",
            params![vocabulary_id, pack_id, created_at],
        )
        .map_err(sql_err)?;
    } else {
        conn.execute(
            "delete from word_pack_membership where vocabulary_id = ?1 and pack_id = ?2",
            params![vocabulary_id, pack_id],
        )
        .map_err(sql_err)?;
    }
    Ok(())
}

// ============================================================================
// Word packs
// ============================================================================

fn row_to_pack(r: &Row) -> rusqlite::Result<WordPack> {
    let tags: String = r.get("tags_json")?;
    Ok(WordPack {
        id: r.get("id")?,
        name: r.get("name")?,
        description: r.get("description")?,
        cover_url: r.get("cover_url")?,
        author: r.get("author")?,
        language_from: r.get("language_from")?,
        language_to: r.get("language_to")?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        version: r.get("version")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        is_system: r.get::<_, i64>("is_system")? != 0,
    })
}

pub fn load_pack(conn: &Connection, id: &str) -> Result<Option<WordPack>, String> {
    conn.query_row("select * from word_pack where id = ?1", [id], row_to_pack)
        .optional()
        .map_err(sql_err)
}

pub fn list_packs(conn: &Connection) -> Result<Vec<WordPack>, String> {
    let mut stmt = conn
        .prepare("select * from word_pack order by created_at, rowid")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], row_to_pack)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

pub fn save_pack(conn: &Connection, pack: &WordPack, track: Track) -> Result<bool, String> {
    let existing = load_pack(conn, &pack.id)?;
    let changed = match &existing {
        Some(old) => serde_json::to_value(old).ok() != serde_json::to_value(pack).ok(),
        None => true,
    };
    if changed {
        conn.execute(
            "insert into word_pack (id, name, description, cover_url, author, language_from, language_to, tags_json,
               version, is_system, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             on conflict(id) do update set name = excluded.name, description = excluded.description,
               cover_url = excluded.cover_url, author = excluded.author, language_from = excluded.language_from,
               language_to = excluded.language_to, tags_json = excluded.tags_json, version = excluded.version,
               is_system = excluded.is_system, created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                pack.id,
                pack.name,
                pack.description,
                pack.cover_url,
                pack.author,
                pack.language_from,
                pack.language_to,
                serde_json::to_string(&pack.tags).unwrap_or_else(|_| "[]".into()),
                pack.version,
                pack.is_system as i64,
                pack.created_at,
                pack.updated_at,
            ],
        )
        .map_err(sql_err)?;
        unmark_deleted(conn, "word_pack", &pack.id)?;
    }
    if changed || track == Track::Legacy {
        if let Some(p) = payload::pack_payload(pack) {
            record(conn, track, "WordPack", &pack.id, Some(p), &pack.updated_at)?;
        }
    }
    Ok(changed)
}

pub fn delete_pack(conn: &Connection, id: &str, track: Track) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("select vocabulary_id from word_pack_membership where pack_id = ?1")
        .map_err(sql_err)?;
    let members = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    conn.execute("delete from word_pack_membership where pack_id = ?1", [id])
        .map_err(sql_err)?;
    for vocabulary_id in &members {
        if payload::membership_payload(vocabulary_id, id, &now()).is_some() {
            record(
                conn,
                track,
                "WordPackMembership",
                &payload::membership_id(vocabulary_id, id),
                None,
                "",
            )?;
        }
    }
    let n = conn
        .execute("delete from word_pack where id = ?1", [id])
        .map_err(sql_err)?;
    if n > 0 {
        mark_deleted(conn, "word_pack", id)?;
    }
    if payload::is_syncable_pack_id(id) {
        record(conn, track, "WordPack", id, None, "")?;
    }
    Ok(n > 0)
}

// ============================================================================
// Review log (append-only)
// ============================================================================

fn row_to_event(r: &Row) -> rusqlite::Result<(ReviewEvent, Option<String>)> {
    Ok((
        ReviewEvent {
            id: r.get("id")?,
            card_id: r.get("vocabulary_id")?,
            reviewed_at: r.get("reviewed_at")?,
            date_local: r.get("date_local")?,
            grade: r.get::<_, i64>("grade")?.clamp(0, 255) as u8,
            elapsed_days: r.get("elapsed_days")?,
            previous_state: r.get("previous_state")?,
            scheduler_version: r.get("scheduler_version")?,
            desired_retention: r.get("desired_retention")?,
            result_stability: r.get("result_stability")?,
            result_difficulty: r.get("result_difficulty")?,
            result_interval_days: r.get("result_interval_days")?,
            result_state: r.get("result_state")?,
        },
        r.get("voids_event_id")?,
    ))
}

/// Append an event (idempotent by id: an existing id is never modified).
pub fn insert_review_event(
    conn: &Connection,
    event: &ReviewEvent,
    voids_event_id: Option<&str>,
    track: Track,
) -> Result<bool, String> {
    let n = conn
        .execute(
            "insert or ignore into review_log (id, vocabulary_id, reviewed_at, date_local, grade, elapsed_days,
               previous_state, scheduler_version, desired_retention, result_stability, result_difficulty,
               result_interval_days, result_state, voids_event_id)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                event.id,
                event.card_id,
                event.reviewed_at,
                event.date_local,
                event.grade as i64,
                event.elapsed_days,
                event.previous_state,
                event.scheduler_version,
                event.desired_retention,
                event.result_stability,
                event.result_difficulty,
                event.result_interval_days,
                event.result_state,
                voids_event_id,
            ],
        )
        .map_err(sql_err)?;
    if let Some(p) = payload::review_event_payload(event, voids_event_id) {
        record(
            conn,
            track,
            "ReviewEvent",
            &event.id,
            Some(p),
            &event.reviewed_at,
        )?;
    }
    Ok(n > 0)
}

/// All events including void markers, ordered by reviewed_at.
pub fn list_review_events_raw(
    conn: &Connection,
) -> Result<Vec<(ReviewEvent, Option<String>)>, String> {
    let mut stmt = conn
        .prepare("select * from review_log order by reviewed_at, rowid")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], row_to_event)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

/// Effective events for statistics: void markers and the events they void are dropped
/// (sync spec §6).
pub fn list_review_events(conn: &Connection) -> Result<Vec<ReviewEvent>, String> {
    let raw = list_review_events_raw(conn)?;
    let voided: HashSet<String> = raw
        .iter()
        .filter_map(|(_, v)| v.as_ref().map(|s| s.to_lowercase()))
        .collect();
    Ok(raw
        .into_iter()
        .filter(|(e, v)| {
            v.is_none() && !voided.contains(&e.id.to_lowercase()) && (1..=4).contains(&e.grade)
        })
        .map(|(e, _)| e)
        .collect())
}

pub fn count_events_for_card(conn: &Connection, card_id: &str) -> Result<i64, String> {
    conn.query_row(
        "select count(*) from review_log where lower(vocabulary_id) = lower(?1) and voids_event_id is null",
        [card_id],
        |r| r.get(0),
    )
    .map_err(sql_err)
}

// ============================================================================
// Bookmarks
// ============================================================================

fn row_to_bookmark(r: &Row) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: r.get("id")?,
        book_path: r.get("book_path")?,
        book_type: r.get("book_type")?,
        title: r.get("title")?,
        note: r.get("note")?,
        selected_text: r.get("selected_text")?,
        page_number: r.get("page_number")?,
        epub_cfi: r.get("locator")?,
        created_at: r.get("created_at")?,
        color: r.get("color")?,
    })
}

pub fn load_bookmark(conn: &Connection, id: &str) -> Result<Option<Bookmark>, String> {
    conn.query_row(
        "select * from book_mark where id = ?1",
        [id],
        row_to_bookmark,
    )
    .optional()
    .map_err(sql_err)
}

pub fn list_bookmarks(conn: &Connection) -> Result<Vec<Bookmark>, String> {
    let mut stmt = conn
        .prepare("select * from book_mark order by created_at, rowid")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], row_to_bookmark)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

fn book_id_for_path(conn: &Connection, book_path: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select id from article where book_path = ?1 order by created_at limit 1",
        [book_path],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql_err)
}

pub fn save_bookmark(
    conn: &Connection,
    b: &Bookmark,
    updated_at: Option<&str>,
    track: Track,
) -> Result<bool, String> {
    let existing = load_bookmark(conn, &b.id)?;
    let changed = match &existing {
        Some(old) => serde_json::to_value(old).ok() != serde_json::to_value(b).ok(),
        None => true,
    };
    if changed {
        let book_id = book_id_for_path(conn, &b.book_path)?;
        let kind = if b
            .selected_text
            .as_deref()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
        {
            "highlight"
        } else {
            "bookmark"
        };
        conn.execute(
            "insert into book_mark (id, book_id, chapter_index, kind, locator, selected_text, note, color,
               book_path, book_type, title, page_number, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             on conflict(id) do update set book_id = excluded.book_id, chapter_index = excluded.chapter_index,
               kind = excluded.kind, locator = excluded.locator, selected_text = excluded.selected_text,
               note = excluded.note, color = excluded.color, book_path = excluded.book_path,
               book_type = excluded.book_type, title = excluded.title, page_number = excluded.page_number,
               created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                b.id,
                book_id,
                b.page_number.map(|p| (p - 1).max(0)).unwrap_or(0),
                kind,
                b.epub_cfi,
                b.selected_text,
                b.note,
                b.color,
                b.book_path,
                b.book_type,
                b.title,
                b.page_number,
                b.created_at,
                updated_at.map(str::to_string).unwrap_or_else(now),
            ],
        )
        .map_err(sql_err)?;
        unmark_deleted(conn, "book_mark", &b.id)?;
    }
    if (changed || track == Track::Legacy) && track != Track::Skip {
        let (book_id, row_updated): (Option<String>, String) = conn
            .query_row(
                "select book_id, updated_at from book_mark where id = ?1",
                [&b.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql_err)?;
        if let Some(p) = payload::bookmark_payload(b, book_id.as_deref(), &row_updated) {
            record(conn, track, "BookMark", &b.id, Some(p), &row_updated)?;
        }
    }
    Ok(changed)
}

pub fn delete_bookmark(conn: &Connection, id: &str, track: Track) -> Result<bool, String> {
    let n = conn
        .execute("delete from book_mark where id = ?1", [id])
        .map_err(sql_err)?;
    if n > 0 {
        mark_deleted(conn, "book_mark", id)?;
    }
    if payload::is_uuid(id) {
        record(conn, track, "BookMark", id, None, "")?;
    }
    Ok(n > 0)
}

// ============================================================================
// Articles + segments (SQLite mirror of the per-article JSON files)
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
struct ArticleRow {
    title: String,
    content: String,
    source_type: Option<String>,
    source_url: Option<String>,
    media_path: Option<String>,
    book_path: Option<String>,
    book_type: Option<String>,
    translated: bool,
    created_at: String,
}

impl ArticleRow {
    fn from_article(a: &Article) -> Self {
        Self {
            title: a.title.clone(),
            content: a.content.clone(),
            source_type: a.source_type.clone(),
            source_url: a.source_url.clone(),
            media_path: a.media_path.clone(),
            book_path: a.book_path.clone(),
            book_type: a.book_type.clone(),
            translated: a.translated,
            created_at: a.created_at.clone(),
        }
    }
}

fn load_article_row(conn: &Connection, id: &str) -> Result<Option<(ArticleRow, String)>, String> {
    conn.query_row("select * from article where id = ?1", [id], |r| {
        Ok((
            ArticleRow {
                title: r.get("title")?,
                content: r.get("content")?,
                source_type: r.get("source_type")?,
                source_url: r.get("source_url")?,
                media_path: r.get("media_path")?,
                book_path: r.get("book_path")?,
                book_type: r.get("book_type")?,
                translated: r.get::<_, i64>("translated")? != 0,
                created_at: r.get("created_at")?,
            },
            r.get("updated_at")?,
        ))
    })
    .optional()
    .map_err(sql_err)
}

fn row_to_segment(r: &Row) -> rusqlite::Result<(ArticleSegment, i64, String)> {
    let explanation: Option<String> = r.get("explanation_json")?;
    Ok((
        ArticleSegment {
            id: r.get("id")?,
            article_id: r.get("article_id")?,
            order: r.get("order_index")?,
            text: r.get("text")?,
            reading_text: r.get("reading_text")?,
            translation: r.get("translation")?,
            explanation: explanation.and_then(|e| serde_json::from_str(&e).ok()),
            start_time: r.get("start_time")?,
            end_time: r.get("end_time")?,
            created_at: r.get("created_at")?,
            is_new_paragraph: r.get::<_, i64>("is_new_paragraph")? != 0,
        },
        r.get("segmentation_revision")?,
        r.get("updated_at")?,
    ))
}

/// Segments of an article with (revision, updated_at), ordered for display.
pub fn load_segments(
    conn: &Connection,
    article_id: &str,
) -> Result<Vec<(ArticleSegment, i64, String)>, String> {
    let mut stmt = conn
        .prepare("select * from segment where article_id = ?1 order by order_index, rowid")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([article_id], row_to_segment)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

pub fn upsert_segment(
    conn: &Connection,
    s: &ArticleSegment,
    revision: i64,
    updated_at: &str,
) -> Result<(), String> {
    conn.execute(
        "insert into segment (id, article_id, order_index, text, reading_text, translation, explanation_json,
           is_new_paragraph, start_time, end_time, segmentation_revision, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         on conflict(id) do update set article_id = excluded.article_id, order_index = excluded.order_index,
           text = excluded.text, reading_text = excluded.reading_text, translation = excluded.translation,
           explanation_json = excluded.explanation_json, is_new_paragraph = excluded.is_new_paragraph,
           start_time = excluded.start_time, end_time = excluded.end_time,
           segmentation_revision = excluded.segmentation_revision, created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![
            s.id,
            s.article_id,
            s.order,
            s.text,
            s.reading_text,
            s.translation,
            s.explanation
                .as_ref()
                .and_then(|e| serde_json::to_string(e).ok()),
            s.is_new_paragraph as i64,
            s.start_time,
            s.end_time,
            revision,
            s.created_at,
            updated_at,
        ],
    )
    .map(|_| ())
    .map_err(sql_err)
}

pub fn delete_segment(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("delete from segment where id = ?1", [id])
        .map(|_| ())
        .map_err(sql_err)
}

pub fn upsert_article_row(
    conn: &Connection,
    id: &str,
    fields: &payload::ArticleFields,
    updated_at: &str,
) -> Result<(), String> {
    conn.execute(
        "insert into article (id, title, content, source_type, source_url, translated, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)
         on conflict(id) do update set title = excluded.title, content = excluded.content,
           source_type = excluded.source_type, source_url = excluded.source_url,
           created_at = excluded.created_at, updated_at = excluded.updated_at",
        params![
            id,
            fields.title,
            fields.content,
            fields.source_type,
            fields.source_url,
            fields.created_at,
            updated_at,
        ],
    )
    .map(|_| ())
    .map_err(sql_err)
}

pub fn article_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row("select count(*) from article where id = ?1", [id], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n > 0)
    .map_err(sql_err)
}

/// Article as stored in SQLite (segments included); desktop-only fields that live only in the
/// JSON file (e.g. `active_mind_map_artifact_id`) are left at their defaults.
pub fn load_article(conn: &Connection, id: &str) -> Result<Option<Article>, String> {
    let Some((row, _)) = load_article_row(conn, id)? else {
        return Ok(None);
    };
    Ok(Some(Article {
        id: id.to_string(),
        title: row.title,
        content: row.content,
        source_type: row.source_type,
        source_url: row.source_url,
        media_path: row.media_path,
        book_path: row.book_path,
        book_type: row.book_type,
        created_at: row.created_at,
        translated: row.translated,
        active_mind_map_artifact_id: None,
        segments: load_segments(conn, id)?
            .into_iter()
            .map(|(s, _, _)| s)
            .collect(),
    }))
}

/// Mirror an article (and its segments) into SQLite and record the changes.
///
/// Re-segmentation (existing segments replaced by new ids) bumps `segmentation_revision`
/// (sync spec §4.3); removed segments get tombstones.
pub fn mirror_article(conn: &Connection, article: &Article, track: Track) -> Result<bool, String> {
    let now = now();
    let new_row = ArticleRow::from_article(article);
    let existing = load_article_row(conn, &article.id)?;
    let article_changed = existing
        .as_ref()
        .map(|(r, _)| r != &new_row)
        .unwrap_or(true);
    let article_updated_at = if article_changed {
        conn.execute(
            "insert into article (id, title, content, source_type, source_url, media_path, book_path, book_type,
               translated, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             on conflict(id) do update set title = excluded.title, content = excluded.content,
               source_type = excluded.source_type, source_url = excluded.source_url,
               media_path = excluded.media_path, book_path = excluded.book_path, book_type = excluded.book_type,
               translated = excluded.translated, created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                article.id,
                new_row.title,
                new_row.content,
                new_row.source_type,
                new_row.source_url,
                new_row.media_path,
                new_row.book_path,
                new_row.book_type,
                new_row.translated as i64,
                new_row.created_at,
                if track == Track::Legacy { &article.created_at } else { &now },
            ],
        )
        .map_err(sql_err)?;
        unmark_deleted(conn, "article", &article.id)?;
        if track == Track::Legacy {
            article.created_at.clone()
        } else {
            now.clone()
        }
    } else {
        existing
            .as_ref()
            .map(|(_, u)| u.clone())
            .unwrap_or_else(|| now.clone())
    };

    let syncable = payload::is_syncable_article(&article.id, article.source_type.as_deref());
    if syncable && (article_changed || track == Track::Legacy) {
        if let Some(p) = payload::article_payload(article, &article_updated_at) {
            record(
                conn,
                track,
                "Article",
                &article.id,
                Some(p),
                &article_updated_at,
            )?;
        }
    }

    // Segments
    let old = load_segments(conn, &article.id)?;
    let old_by_id: HashMap<&str, (&ArticleSegment, i64)> = old
        .iter()
        .map(|(s, rev, _)| (s.id.as_str(), (s, *rev)))
        .collect();
    let new_ids: HashSet<&str> = article.segments.iter().map(|s| s.id.as_str()).collect();
    let current_revision = old.iter().map(|(_, r, _)| *r).max().unwrap_or(0);
    let removed: Vec<&ArticleSegment> = old
        .iter()
        .filter(|(s, _, _)| !new_ids.contains(s.id.as_str()))
        .map(|(s, _, _)| s)
        .collect();
    let resegmented = !removed.is_empty()
        && !article.segments.is_empty()
        && article
            .segments
            .iter()
            .any(|s| !old_by_id.contains_key(s.id.as_str()));
    let revision = if resegmented {
        current_revision + 1
    } else {
        current_revision
    };

    let mut segments_changed = false;
    for s in removed {
        delete_segment(conn, &s.id)?;
        segments_changed = true;
        if syncable && payload::is_uuid(&s.id) {
            record(conn, track, "Segment", &s.id, None, "")?;
        }
    }
    for s in &article.segments {
        let (changed, seg_revision) = match old_by_id.get(s.id.as_str()) {
            Some((old_s, old_rev)) => {
                let rev = if resegmented { revision } else { *old_rev };
                (
                    serde_json::to_value(old_s).ok() != serde_json::to_value(s).ok()
                        || rev != *old_rev,
                    rev,
                )
            }
            None => (true, revision),
        };
        if changed {
            upsert_segment(conn, s, seg_revision, &now)?;
            segments_changed = true;
        }
        if syncable && (changed || track == Track::Legacy) {
            if let Some(p) = payload::segment_payload(s, seg_revision) {
                record(conn, track, "Segment", &s.id, Some(p), &s.created_at)?;
            }
        }
    }
    Ok(article_changed || segments_changed)
}

/// Delete an article and its segments; tombstones the Article, its Segments and the
/// LyricsMeta / BookChapter keyed by the article id (spec §4.2 client-side cascade).
pub fn delete_article(conn: &Connection, id: &str, track: Track) -> Result<bool, String> {
    let segments = load_segments(conn, id)?;
    conn.execute("delete from segment where article_id = ?1", [id])
        .map_err(sql_err)?;
    let n = conn
        .execute("delete from article where id = ?1", [id])
        .map_err(sql_err)?;
    if n > 0 {
        mark_deleted(conn, "article", id)?;
    }
    if track != Track::Skip && payload::is_uuid(id) {
        for (s, _, _) in segments {
            record(conn, track, "Segment", &s.id, None, "")?;
        }
        // Remote segments of this article that never made it into the segment table.
        for r in store::list_by_payload_field(conn, "Segment", "articleId", id)? {
            record(conn, track, "Segment", &r.id, None, "")?;
        }
        for t in ["LyricsMeta", "BookChapter"] {
            record(conn, track, t, id, None, "")?;
        }
        record(conn, track, "Article", id, None, "")?;
    }
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn fav(id: &str, word: &str, packs: &[&str]) -> FavoriteVocabulary {
        let mut f: FavoriteVocabulary = serde_json::from_value(serde_json::json!({
            "id": id, "word": word, "meaning": "m", "usage": "u",
            "example": null, "reading": null,
            "source_article_id": null, "source_article_title": null,
            "created_at": "2026-09-01T00:00:00Z", "scheduler_version": "fsrs6"
        }))
        .unwrap();
        f.pack_ids = packs.iter().map(|s| s.to_string()).collect();
        f
    }

    const V1: &str = "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f";
    const P1: &str = "5a5b5c5d-0000-4000-8000-00000000abcd";

    #[test]
    fn vocabulary_memberships_and_tracking() {
        let dir = db::test_util::temp_dir("repo-vocab");
        let database = db::open(&dir).unwrap();
        database
            .write(|tx| {
                let f = fav(V1, "apple", &["system-ungrouped", P1]);
                assert!(save_vocabulary(
                    tx,
                    VocabularyWrite {
                        fav: &f,
                        updated_at: None,
                        memberships: true,
                        track: Track::Record
                    }
                )?);
                let loaded = load_vocabulary(tx, V1)?.unwrap();
                assert_eq!(
                    loaded.pack_ids,
                    vec!["system-ungrouped".to_string(), P1.to_string()]
                );
                // Vocabulary + one membership recorded (system pack is local-only).
                assert!(store::get_record(tx, "Vocabulary", V1)?.unwrap().dirty);
                let mid = payload::membership_id(V1, P1);
                assert!(store::get_record(tx, "WordPackMembership", &mid)?.is_some());
                assert!(store::get_record(
                    tx,
                    "WordPackMembership",
                    &payload::membership_id(V1, "system-ungrouped")
                )?
                .is_none());

                // No-op save does not re-dirty.
                let before = store::get_record(tx, "Vocabulary", V1)?.unwrap();
                assert!(!save_vocabulary(
                    tx,
                    VocabularyWrite {
                        fav: &loaded,
                        updated_at: None,
                        memberships: true,
                        track: Track::Record
                    }
                )?);
                assert_eq!(
                    store::get_record(tx, "Vocabulary", V1)?.unwrap().hlc,
                    before.hlc
                );

                // Removing the pack tombstones the membership.
                let mut f2 = loaded.clone();
                f2.pack_ids = vec!["system-ungrouped".into()];
                save_vocabulary(
                    tx,
                    VocabularyWrite {
                        fav: &f2,
                        updated_at: None,
                        memberships: true,
                        track: Track::Record,
                    },
                )?;
                assert!(
                    store::get_record(tx, "WordPackMembership", &mid)?
                        .unwrap()
                        .deleted
                );

                // Delete → Vocabulary tombstone; empty memberships default to ungrouped.
                assert!(delete_vocabulary(tx, V1, Track::Record)?);
                assert!(store::get_record(tx, "Vocabulary", V1)?.unwrap().deleted);
                assert!(load_vocabulary(tx, V1)?.is_none());

                let lonely = fav("7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f", "pear", &[]);
                save_vocabulary(
                    tx,
                    VocabularyWrite {
                        fav: &lonely,
                        updated_at: None,
                        memberships: true,
                        track: Track::Record,
                    },
                )?;
                assert_eq!(
                    load_vocabulary(tx, &lonely.id)?.unwrap().pack_ids,
                    vec!["system-ungrouped".to_string()]
                );
                Ok(())
            })
            .unwrap();
        db::close(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resegmentation_bumps_revision_and_tombstones_old_segments() {
        let dir = db::test_util::temp_dir("repo-article");
        let database = db::open(&dir).unwrap();
        let article_id = "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b6c";
        let seg = |id: &str, order: i32, text: &str| ArticleSegment {
            id: id.into(),
            article_id: article_id.into(),
            order,
            text: text.into(),
            reading_text: None,
            translation: None,
            explanation: None,
            start_time: None,
            end_time: None,
            created_at: "2026-09-28T00:00:00Z".into(),
            is_new_paragraph: order == 0,
        };
        let mut article = Article {
            id: article_id.into(),
            title: "t".into(),
            content: "a. b.".into(),
            source_type: Some("article".into()),
            source_url: None,
            media_path: None,
            book_path: None,
            book_type: None,
            created_at: "2026-09-28T00:00:00Z".into(),
            translated: false,
            active_mind_map_artifact_id: None,
            segments: vec![
                seg("11111111-0000-4000-8000-000000000001", 0, "a."),
                seg("11111111-0000-4000-8000-000000000002", 1, "b."),
            ],
        };
        database
            .write(|tx| {
                mirror_article(tx, &article, Track::Record)?;
                assert!(store::get_record(tx, "Article", article_id)?.unwrap().dirty);
                assert_eq!(store::max_segment_revision(tx, article_id)?, Some(0));

                // Translating one segment keeps the revision.
                article.segments[0].translation = Some("A".into());
                mirror_article(tx, &article, Track::Record)?;
                let rec = store::get_record(tx, "Segment", "11111111-0000-4000-8000-000000000001")?
                    .unwrap();
                assert_eq!(rec.payload.as_ref().unwrap()["translation"], "A");

                // Re-segmentation.
                article.segments = vec![seg("22222222-0000-4000-8000-000000000001", 0, "a. b.")];
                mirror_article(tx, &article, Track::Record)?;
                assert!(
                    store::get_record(tx, "Segment", "11111111-0000-4000-8000-000000000002")?
                        .unwrap()
                        .deleted
                );
                assert_eq!(store::max_segment_revision(tx, article_id)?, Some(1));
                assert_eq!(load_article(tx, article_id)?.unwrap().segments.len(), 1);

                // Delete cascades tombstones.
                delete_article(tx, article_id, Track::Record)?;
                assert!(
                    store::get_record(tx, "Article", article_id)?
                        .unwrap()
                        .deleted
                );
                assert!(
                    store::get_record(tx, "Segment", "22222222-0000-4000-8000-000000000001")?
                        .unwrap()
                        .deleted
                );
                Ok(())
            })
            .unwrap();
        db::close(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn media_articles_are_mirrored_but_not_synced() {
        let dir = db::test_util::temp_dir("repo-media");
        let database = db::open(&dir).unwrap();
        let article = Article {
            id: "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b6d".into(),
            title: "video".into(),
            content: "".into(),
            source_type: Some("youtube".into()),
            source_url: None,
            media_path: Some("/tmp/x.mp4".into()),
            book_path: None,
            book_type: None,
            created_at: "2026-09-28T00:00:00Z".into(),
            translated: false,
            active_mind_map_artifact_id: None,
            segments: vec![],
        };
        database
            .write(|tx| {
                mirror_article(tx, &article, Track::Record)?;
                assert!(article_exists(tx, &article.id)?);
                assert!(store::get_record(tx, "Article", &article.id)?.is_none());
                Ok(())
            })
            .unwrap();
        db::close(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }
}
