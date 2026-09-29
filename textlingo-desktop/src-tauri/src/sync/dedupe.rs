//! First-sync same-word merge (sync-protocol-spec §9, SRS spec §1.4).
//!
//! When local and cloud each have a card for the same word (different ids), keep the card with
//! the older `createdAt`, move the other card's review history onto it (a copy of every
//! effective event for the kept card + a void marker for each original, since events are
//! immutable), merge its packs / empty fields, then tombstone the other card.

use super::replay::ReplayOptions;
use crate::db::repo::{self, Track, VocabularyWrite};
use crate::sync::payload::DESKTOP_SYSTEM_PACK_ID;
use crate::types::{FavoriteVocabulary, ReviewEvent};
use rusqlite::Connection;
use std::collections::{BTreeMap, HashSet};

fn created_ms(f: &FavoriteVocabulary) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&f.created_at)
        .map(|d| d.timestamp_millis())
        .unwrap_or(i64::MAX)
}

fn fill(target: &mut Option<String>, source: &Option<String>) {
    if target.as_deref().map(str::trim).unwrap_or("").is_empty() && source.is_some() {
        *target = source.clone();
    }
}

/// Merge duplicate cards; returns the number of cards removed.
pub fn dedupe_vocabulary(conn: &Connection, replay: &ReplayOptions) -> Result<usize, String> {
    let mut groups: BTreeMap<String, Vec<FavoriteVocabulary>> = BTreeMap::new();
    for card in repo::list_vocabularies(conn)? {
        let key = card.word.trim().to_lowercase();
        if !key.is_empty() {
            groups.entry(key).or_default().push(card);
        }
    }
    let now = chrono::Utc::now();
    let now_iso = now.to_rfc3339();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut removed = 0;

    for (_, mut cards) in groups.into_iter().filter(|(_, c)| c.len() > 1) {
        cards.sort_by(|a, b| {
            created_ms(a)
                .cmp(&created_ms(b))
                .then_with(|| a.id.cmp(&b.id))
        });
        let mut winner = cards.remove(0);
        let raw_events = repo::list_review_events_raw(conn)?;
        let voided: HashSet<String> = raw_events
            .iter()
            .filter_map(|(_, v)| v.as_ref().map(|s| s.to_lowercase()))
            .collect();

        for loser in cards {
            // Packs: union (the ungrouped placeholder only if nothing else remains).
            let mut packs: Vec<String> = winner
                .pack_ids
                .iter()
                .chain(loser.pack_ids.iter())
                .filter(|p| p.as_str() != DESKTOP_SYSTEM_PACK_ID)
                .cloned()
                .collect();
            let mut seen = HashSet::new();
            packs.retain(|p| seen.insert(p.clone()));
            winner.pack_ids = if packs.is_empty() {
                vec![DESKTOP_SYSTEM_PACK_ID.to_string()]
            } else {
                packs
            };
            if winner.meaning.trim().is_empty() {
                winner.meaning = loser.meaning.clone();
            }
            if winner.usage.trim().is_empty() {
                winner.usage = loser.usage.clone();
            }
            fill(&mut winner.explanation, &loser.explanation);
            fill(&mut winner.example, &loser.example);
            fill(&mut winner.reading, &loser.reading);
            fill(&mut winner.source_article_id, &loser.source_article_id);
            fill(
                &mut winner.source_article_title,
                &loser.source_article_title,
            );

            // Re-point history: copy + void (events are append-only).
            for (event, voids) in raw_events.iter() {
                if !event.card_id.eq_ignore_ascii_case(&loser.id)
                    || voids.is_some()
                    || voided.contains(&event.id.to_lowercase())
                    || !(1..=4).contains(&event.grade)
                {
                    continue;
                }
                let copy = ReviewEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    card_id: winner.id.clone(),
                    ..event.clone()
                };
                repo::insert_review_event(conn, &copy, None, Track::Record)?;
                let marker = ReviewEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    card_id: loser.id.clone(),
                    reviewed_at: now_iso.clone(),
                    date_local: today.clone(),
                    grade: 0,
                    elapsed_days: 0,
                    previous_state: event.result_state.clone(),
                    scheduler_version: event.scheduler_version.clone(),
                    desired_retention: event.desired_retention,
                    result_stability: 0.0,
                    result_difficulty: 0.0,
                    result_interval_days: 0,
                    result_state: event.result_state.clone(),
                };
                repo::insert_review_event(conn, &marker, Some(&event.id), Track::Record)?;
            }
            repo::delete_vocabulary(conn, &loser.id, Track::Record)?;
            removed += 1;
        }

        repo::save_vocabulary(
            conn,
            VocabularyWrite {
                fav: &winner,
                updated_at: None,
                memberships: true,
                track: Track::Record,
            },
        )?;
        super::apply::replay_card(conn, &winner.id, replay)?;
        // Replay writes the kept card's SRS fields without dirtying; make sure the merged
        // card (and its replayed state) is pushed.
        repo::record_vocabulary(conn, &winner.id, Track::Record)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::sync::store;

    fn card(id: &str, word: &str, created: &str, packs: &[&str]) -> FavoriteVocabulary {
        let mut f: FavoriteVocabulary = serde_json::from_value(serde_json::json!({
            "id": id, "word": word, "meaning": "", "usage": "",
            "example": null, "reading": null, "source_article_id": null, "source_article_title": null,
            "created_at": created, "scheduler_version": "fsrs6", "due_date": "2026-09-01"
        }))
        .unwrap();
        f.pack_ids = packs.iter().map(|s| s.to_string()).collect();
        f
    }

    const OLD: &str = "10000000-0000-4000-8000-000000000001";
    const NEW: &str = "20000000-0000-4000-8000-000000000002";
    const P1: &str = "5a5b5c5d-0000-4000-8000-00000000abcd";

    #[test]
    fn keeps_older_card_moves_events_and_tombstones_the_other() {
        let dir = db::test_util::temp_dir("dedupe");
        let database = db::open(&dir).unwrap();
        let opts = ReplayOptions {
            desired_retention: 0.9,
            time_zone: crate::sync::replay::ReplayTimeZone::Utc,
        };
        database
            .write(|tx| {
                let mut old = card(OLD, "猫", "2026-01-01T00:00:00Z", &["system-ungrouped"]);
                old.reading = Some("ねこ".into());
                let mut newer = card(NEW, " 猫 ", "2026-05-01T00:00:00Z", &[P1]);
                newer.meaning = "cat".into();
                for c in [&old, &newer] {
                    repo::save_vocabulary(
                        tx,
                        VocabularyWrite {
                            fav: c,
                            updated_at: None,
                            memberships: true,
                            track: Track::Record,
                        },
                    )?;
                }
                let event = ReviewEvent {
                    id: "e1000000-0000-4000-8000-000000000001".into(),
                    card_id: NEW.into(),
                    reviewed_at: "2026-09-01T10:00:00Z".into(),
                    date_local: "2026-09-01".into(),
                    grade: 3,
                    elapsed_days: 0,
                    previous_state: "new".into(),
                    scheduler_version: "fsrs6".into(),
                    desired_retention: 0.9,
                    result_stability: 2.3065,
                    result_difficulty: 2.11810397,
                    result_interval_days: 3,
                    result_state: "review".into(),
                };
                repo::insert_review_event(tx, &event, None, Track::Record)?;

                assert_eq!(dedupe_vocabulary(tx, &opts)?, 1);

                assert!(repo::load_vocabulary(tx, NEW)?.is_none());
                assert!(store::get_record(tx, "Vocabulary", NEW)?.unwrap().deleted);
                let kept = repo::load_vocabulary(tx, OLD)?.unwrap();
                assert_eq!(kept.meaning, "cat");
                assert_eq!(kept.reading.as_deref(), Some("ねこ"));
                assert_eq!(kept.pack_ids, vec![P1.to_string()]);
                // History moved: replayed onto the kept card; original voided.
                assert_eq!(kept.review_count, 1);
                assert_eq!(kept.srs_state, "review");
                let effective = repo::list_review_events(tx)?;
                assert_eq!(effective.len(), 1);
                assert_eq!(effective[0].card_id, OLD);
                let kept_rec = store::get_record(tx, "Vocabulary", OLD)?.unwrap();
                assert!(kept_rec.dirty);
                assert_eq!(kept_rec.payload.as_ref().unwrap()["reviewCount"], 1);
                // Idempotent.
                assert_eq!(dedupe_vocabulary(tx, &opts)?, 0);
                Ok(())
            })
            .unwrap();
        db::close(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }
}
