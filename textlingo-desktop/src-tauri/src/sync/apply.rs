//! Projection of merged sync records into the desktop domain tables (no change tracking —
//! these writes came from the server).

use super::payload;
use super::protocol::{JsonObject, LocalRecord};
use super::replay::{self, ReplayInitial, ReplayOptions};
use super::store;
use crate::db::repo::{self, Track, VocabularyWrite};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::BTreeSet;

fn get_str(p: &JsonObject, key: &str) -> Option<String> {
    p.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Apply `record` (already stored in `sync_record`) to the domain tables. `previous` is the
/// payload the record had before (used to find a deleted segment's article). Articles whose
/// JSON file must be rewritten are added to `touched_articles`.
pub fn project(
    conn: &Connection,
    record: &LocalRecord,
    previous: Option<&JsonObject>,
    touched_articles: &mut BTreeSet<String>,
) -> Result<(), String> {
    let id = record.id.as_str();
    let live = if record.deleted {
        None
    } else {
        record.payload.as_ref()
    };
    match record.record_type.as_str() {
        "Vocabulary" => match live {
            None => {
                repo::delete_vocabulary(conn, id, Track::Skip)?;
            }
            Some(p) => {
                let existing = repo::load_vocabulary(conn, id)?;
                let fav = payload::vocabulary_from_payload(id, p, existing.as_ref());
                let updated_at = get_str(p, "updatedAt");
                repo::save_vocabulary(
                    conn,
                    VocabularyWrite {
                        fav: &fav,
                        updated_at: updated_at.as_deref(),
                        memberships: false,
                        track: Track::Skip,
                    },
                )?;
            }
        },
        "WordPack" => {
            let pack_id = payload::desktop_pack_id(id);
            match live {
                None => {
                    if pack_id != payload::DESKTOP_SYSTEM_PACK_ID {
                        repo::delete_pack(conn, &pack_id, Track::Skip)?;
                    }
                }
                Some(p) => {
                    let pack = payload::pack_from_payload(id, p);
                    if !pack.is_system && pack.id != payload::DESKTOP_SYSTEM_PACK_ID {
                        repo::save_pack(conn, &pack, Track::Skip)?;
                    }
                }
            }
        }
        "WordPackMembership" => {
            let (vocabulary_id, pack_id) = match live {
                Some(p) => (
                    get_str(p, "vocabularyId").map(|s| s.to_lowercase()),
                    get_str(p, "packId").map(|s| payload::desktop_pack_id(&s)),
                ),
                None => (None, None),
            };
            let (vocabulary_id, pack_id) = match (vocabulary_id, pack_id) {
                (Some(v), Some(p)) => (v, p),
                _ => match payload::parse_membership_id(id) {
                    Some((v, p)) => (v, payload::desktop_pack_id(&p)),
                    None => return Ok(()),
                },
            };
            let created_at = live
                .and_then(|p| get_str(p, "createdAt"))
                .unwrap_or_else(payload::now_iso);
            repo::set_membership(conn, &vocabulary_id, &pack_id, live.is_some(), &created_at)?;
        }
        "ReviewEvent" => {
            if let Some(p) = live {
                if let Some((event, voids)) = payload::review_event_from_payload(id, p) {
                    repo::insert_review_event(conn, &event, voids.as_deref(), Track::Skip)?;
                }
            }
        }
        "Article" => {
            match live {
                None => {
                    repo::delete_article(conn, id, Track::Skip)?;
                }
                Some(p) => {
                    let fields = payload::article_fields_from_payload(p);
                    let updated_at =
                        get_str(p, "updatedAt").unwrap_or_else(|| fields.created_at.clone());
                    repo::upsert_article_row(conn, id, &fields, &updated_at)?;
                }
            }
            touched_articles.insert(id.to_string());
        }
        "Segment" => match live {
            None => {
                let article_id = previous
                    .and_then(|p| get_str(p, "articleId"))
                    .map(|s| s.to_lowercase())
                    .or_else(|| segment_article(conn, id));
                repo::delete_segment(conn, id)?;
                if let Some(a) = article_id {
                    touched_articles.insert(a);
                }
            }
            Some(p) => {
                if let Some((segment, revision)) = payload::segment_from_payload(id, p) {
                    let updated_at = payload::now_iso();
                    repo::upsert_segment(conn, &segment, revision, &updated_at)?;
                    touched_articles.insert(segment.article_id.clone());
                }
            }
        },
        "BookMark" => match live {
            None => {
                repo::delete_bookmark(conn, id, Track::Skip)?;
            }
            Some(p) => {
                if let Some(bookmark) = payload::bookmark_from_payload(id, p) {
                    let updated_at = get_str(p, "updatedAt");
                    repo::save_bookmark(conn, &bookmark, updated_at.as_deref(), Track::Skip)?;
                }
            }
        },
        // Book / BookChapter / BookProgress / LyricsMeta / … are kept in sync_record only (the
        // desktop has no UI for them yet) so they round-trip and are available later.
        _ => {}
    }
    Ok(())
}

fn segment_article(conn: &Connection, segment_id: &str) -> Option<String> {
    conn.query_row(
        "select article_id from segment where id = ?1",
        [segment_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn seed_from_json(json: &str) -> Option<ReplayInitial> {
    let v: Value = serde_json::from_str(json).ok()?;
    let p = v.as_object()?;
    Some(ReplayInitial {
        stability: p.get("stability").and_then(Value::as_f64).unwrap_or(0.0),
        difficulty: p.get("difficulty").and_then(Value::as_f64).unwrap_or(0.0),
        srs_state: get_str(p, "srsState"),
        due_date: get_str(p, "dueDate"),
        last_reviewed_at: get_str(p, "lastReviewedAt"),
        review_count: p.get("reviewCount").and_then(Value::as_i64),
        last_date_local: get_str(p, "lastDateLocal"),
    })
}

/// Recompute SRS fields of `card_id` from its ReviewEvents (sync spec §6). Updates the domain
/// row and the replay-owned payload fields of the Vocabulary record without marking it dirty.
/// Returns true when anything changed.
pub fn replay_card(conn: &Connection, card_id: &str, opts: &ReplayOptions) -> Result<bool, String> {
    let events: Vec<replay::ReplayEvent> =
        store::list_by_payload_field(conn, "ReviewEvent", "vocabularyId", card_id)?
            .into_iter()
            .filter_map(|r| {
                r.payload
                    .as_ref()
                    .and_then(|p| replay::replay_event_from_payload(&r.id, Some(&r.hlc), p))
            })
            .collect();
    if events.is_empty() {
        return Ok(false);
    }
    let Some(mut fav) = repo::load_vocabulary(conn, card_id)? else {
        return Ok(false);
    };
    let initial = repo::vocabulary_replay_seed(conn, card_id)?
        .as_deref()
        .and_then(seed_from_json);
    let result = replay::replay_events(initial.as_ref(), &events, opts);

    let mut changed = false;
    if let Some((mut rec, _)) = store::get_record_with_hash(conn, "Vocabulary", card_id)? {
        if !rec.deleted {
            if let Some(p) = rec.payload.as_ref() {
                if let Some(next) = replay::apply_replay_to_payload(p, &result) {
                    rec.payload = Some(next);
                    store::put_record(conn, &rec)?;
                    changed = true;
                }
            }
        }
    }

    let same = fav.srs_state == result.srs_state
        && (fav.stability - result.stability).abs() < 1e-12
        && (fav.difficulty - result.difficulty).abs() < 1e-12
        && fav.due_date == result.due_date
        && fav.review_count as i64 == result.review_count
        && fav.scheduler_version.as_deref() == Some(result.scheduler_version.as_str())
        && fav.last_reviewed_at.as_deref().and_then(payload::iso)
            == result.last_reviewed_at.as_deref().and_then(payload::iso);
    if !same {
        fav.srs_state = result.srs_state;
        fav.stability = result.stability;
        fav.difficulty = result.difficulty;
        fav.due_date = result.due_date;
        fav.review_count = result.review_count as i32;
        fav.scheduler_version = Some(result.scheduler_version);
        fav.last_reviewed_at = result.last_reviewed_at;
        repo::save_vocabulary(
            conn,
            VocabularyWrite {
                fav: &fav,
                updated_at: None,
                memberships: false,
                track: Track::Skip,
            },
        )?;
        changed = true;
    }
    Ok(changed)
}
